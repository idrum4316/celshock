/**
 * BattleSystem.ts — Bot roster: a fixed pool built once and NEVER disposed
 * (death hides a rig, respawn re-poses it — respawning is continuous), AI
 * scheduling, LOS, distance LOD.
 * Invariants: think ticks are staggered round-robin at CONFIG.bots.thinkRate,
 * and a dead bot must not consume a budget slot or the living think slower than
 * advertised. Target acquisition ray-tests candidates nearest-first, stops at
 * the first visible one, and is capped at CONFIG.bots.acquireRayBudget — the
 * view cone (Bot.facing) rejects most candidates before any ray is fired.
 * Hearing, damage direction and near-miss suppression are all RAY-FREE by
 * construction; keep them that way. LOS rays filter OPAQUE_ONLY, so a bot sees
 * through what it could shoot through (fence rails) and not through what it
 * could not.
 * Cover is a baked lookup (world/CoverMap), never a probe. Bot muzzle flashes are
 * NOT pulsed from here — this system only records flash positions and Game
 * spends CONFIG.lighting.muzzleBudgetPerFrame on the nearest few (16 shader
 * light slots are absolute). Runs AFTER ConquestSystem.update each frame.
 * Cross-system effects go out via onBotKill/onBotFired callbacks wired in
 * Game — never import other systems. A bot's grenade leaves the same way
 * (throwGrenadeFor): the ballistics and the pool are GrenadeSystem's, and this
 * file only forwards the bot's ask and its answer.
 * Non-bot combatants live in `humans` (one offline, up to sixteen on the
 * server) and must be visible to hittablesAgainst and acquire, or bots shoot
 * through people. Bots whose roster slot a human has taken are BENCHED: not
 * respawned, not thought for, not shootable, not drawn — and un-benching drops
 * them back into the ordinary respawn queue with skill and squad intact, which
 * is what makes a human joining and leaving symmetrical. Every loop over
 * `bots` must skip the bench; `Bot` itself knows nothing about any of it.
 */
import { Ray, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { Bot, type BattleCtx, type BotZone } from "../entities/Bot";
import { assignSkills } from "../entities/BotSkill";
import { OTHER_TEAM, type Combatant, type Team } from "../entities/Combatant";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { CoverMap } from "../world/CoverMap";
import type { FlowField, NavGrid } from "../world/NavGrid";
import type { GameMap } from "../world/MapBuilder";
import type { ObstacleField } from "../world/ObstacleField";
import { OPAQUE_ONLY } from "../world/solid";
import type { CombatSystem, Hittable, ShotOptions } from "./CombatSystem";
import type { SquadOrder } from "./ConquestSystem";

/**
 * Every bot's round, since bots carry no weapon from `CONFIG.weapons` — they
 * fire one flat round and this is its whole damage curve. A module constant
 * because it never varies: rebuilding it per shot would allocate sixteen
 * objects a second in a firefight for three numbers that cannot change.
 */
const BOT_SHOT: ShotOptions = {
  damageFar: CONFIG.bots.damageFar,
  falloffNear: CONFIG.bots.falloffNear,
  falloffFar: CONFIG.bots.falloffFar,
};

/**
 * Owns both teams: a fixed pool of bot rigs, the AI schedule, and the render
 * LOD that makes sixteen of them affordable.
 *
 * Three decisions carry the frame budget here:
 *
 * 1. **The pool is built once and never disposed.** `new Bot()` allocates a
 *    dozen Babylon meshes and their GL buffers; in a roguelike that cost landed
 *    twelve times per room load, but Conquest respawns continuously and it
 *    would be a permanent source of frame spikes. Death hides a rig, respawn
 *    re-poses and re-shows it.
 * 2. **AI is staggered.** Target acquisition and line-of-sight rays run at
 *    `CONFIG.bots.thinkRate` per bot, round-robin across frames — about three
 *    ray picks per frame for the whole roster. Movement still integrates every
 *    frame, so nothing looks choppy.
 * 3. **Distance LOD.** Past the fog the rig is disabled outright; past
 *    `lodFreezeDistance` the pose freezes but the bot keeps walking; past
 *    `lodOutlineDistance` the outline pass is skipped, halving its draw calls.
 *
 * Deliberately *not* here: a spatial hash. With 17 combatants the pairwise
 * separation pass is ~256 distance checks a frame, which is far cheaper than
 * maintaining buckets. Revisit it if the roster grows past ~64 — four times
 * what it is now, so this has room. (Both figures were written for a 16v16
 * roster and outlived it; `bots.perTeam` is 8.)
 */
export class BattleSystem {
  readonly bots: Bot[] = [];
  /** Muzzle positions from this frame, for `Game` to spend its light budget on. */
  readonly muzzleFlashes: Vector3[] = [];
  /**
   * Backing store for the above: grown on demand, never shrunk, and handed out
   * from the start again every frame. `muzzleFlashes` holds references into it,
   * which is safe only because both are reset together in `update`.
   */
  private readonly flashPool: Vector3[] = [];
  private flashCount = 0;

  /**
   * Wired by Game: a bot's round killed somebody.
   *
   * The VICTIM is whatever the ray found and may be anybody a bot is allowed to
   * shoot — another bot, the local player, a person on the server's roster — so
   * a consumer that only cares about one kind filters it here rather than being
   * filtered for. That is the shape `GrenadeSystem.onBlastHit` already has, and
   * making the rifle path match it is what lets a bot be credited for killing a
   * PERSON: the older signature named the bot that fell and dropped every other
   * victim on the floor, so a bot that spent a round shooting people scored
   * nothing at all.
   *
   * `by` is the bot that fired, and it is the only thing here that cannot be
   * derived: a victim's death is already counted at the victim's own door
   * (`registerBotKill` on the client, `onPlayerDamaged` for a person), and the
   * killer's team is `by.team`. What the scoreboard needs is who to credit,
   * which is why this carries an identity rather than a side.
   */
  onBotKill: (victim: Hittable, by: Bot) => void = () => {};
  /** Wired by Game: a bot pulled the trigger, at this world position. */
  onBotFired: (bot: Bot, at: Vector3) => void = () => {};
  /** Wired by Game: a bot ran its magazine dry and started reloading. */
  onBotReloaded: (bot: Bot) => void = () => {};
  /** Wired by Game: a bot put a foot down. Short-range sound only. */
  onBotStepped: (bot: Bot) => void = () => {};
  /** Wired by Game: where should this bot deploy? */
  spawnPointFor: (bot: Bot) => { pos: Vector3; yaw: number } | null = () => null;
  /**
   * Wired by Game: orders for one team's squads, given each squad's centroid
   * and what it is currently doing. Resolved as a group so squads can be spread
   * (or deliberately stacked) relative to each other.
   */
  planSquads: (team: Team, centroids: Vector3[], previous: string[]) => SquadOrder[] =
    () => [];
  /** Wired by Game: what is this bot standing on? */
  zoneFor: (bot: Bot) => BotZone = () => "none";
  /**
   * Wired by Game: lob a grenade from `from`, aimed to land at `at`. False when
   * the throw cannot be made, and the bot then spends nothing.
   *
   * A callback for the same reason `spawnPointFor` is one — the grenades are
   * another system's, and this one imports no systems.
   *
   * The BOT is passed rather than its team, for the reason `onBotKill` carries
   * one: a blast is a kill somebody has to be credited with, and the grenade
   * has to be told whose it is at the throw because the only other place that
   * knows is seconds and a bounce away.
   */
  throwGrenadeFor: (bot: Bot, from: Vector3, at: Vector3) => boolean = () =>
    false;

  private nav: NavGrid | null = null;
  private cover: CoverMap | null = null;
  private obstacles: ObstacleField | null = null;
  /**
   * Combatants in the fight that are not bots: the local player offline, and
   * every connected human on the multiplayer server.
   *
   * A list rather than the single `player` field it replaces, because the
   * server has up to sixteen of them and every place that used to special-case
   * one — the target list, acquisition — has to see them all or bots shoot
   * through people.
   */
  private readonly humans: Combatant[] = [];
  /**
   * Bots whose roster slot a human has taken.
   *
   * A bench rather than a flag on `Bot` on purpose: which slots are people is a
   * fact about the ROSTER, and `Bot` is an AI combatant that has no business
   * knowing a lobby exists. A benched bot is not respawned, not thought for,
   * not a target, and not drawn — it is simply not in the fight, and the moment
   * the human leaves it is back with the same skill and the same squad, because
   * nothing about it was ever torn down.
   *
   * Empty offline, so the single-player path pays one `Set.has` per bot per
   * frame and behaves exactly as it did.
   */
  private readonly benched = new Set<Bot>();
  private thinkCursor = 0;
  /**
   * Live orders per team, indexed by squad. Replanned on their own slow timer
   * rather than per bot per think — the old per-bot call re-sorted the whole
   * control-point list 80 times a second and threw the arrays away.
   */
  private readonly squadOrders: SquadOrder[][] = [[], []];
  private squadT = 0;
  /** Scratch for the centroid pass; never reallocated. */
  private readonly centroidScratch: Vector3[][] = [[], []];
  private readonly squadHeld: string[][] = [[], []];
  /** Carried across frames so a fractional think budget isn't lost. */
  private thinkDebt = 0;
  private ctx: BattleCtx;
  private readonly ray = new Ray(new Vector3(), new Vector3(), 1);
  private readonly hittableScratch: Hittable[][] = [[], []];
  private readonly candidateScratch: { c: Combatant; d: number }[] = [];

  constructor(
    private scene: Scene,
    mats: CelMaterialFactory,
    private combat: CombatSystem,
  ) {
    for (let team = 0; team < 2; team++) {
      const spec = CONFIG.teams[team];
      for (let i = 0; i < CONFIG.bots.perTeam; i++) {
        const bot = new Bot(
          scene,
          mats,
          team as Team,
          spec.color,
          spec.eyeColor,
        );
        bot.squad = Math.floor(i / CONFIG.bots.squadSize);
        // A stream per bot, seeded off the pool slot: movement personality
        // differs between bots but is identical between runs.
        bot.seedRandom(CONFIG.bots.skill.seed + team * 131 + i * 17);
        bot.onReload = () => this.onBotReloaded(bot);
        bot.onStep = () => this.onBotStepped(bot);
        this.bots.push(bot);
      }
    }

    // The context is built once and reads through to the system, so it never
    // needs rebuilding when the map changes — the same "mutate in place, don't
    // reallocate" discipline the retired AICtx used.
    const self = this;
    this.ctx = {
      get nav(): NavGrid {
        return self.nav!;
      },
      acquire: (bot) => this.acquire(bot),
      visible: (from, to) => this.visible(from, to),
      fire: (bot, aimAt, spread) => this.botFire(bot, aimAt, spread),
      fieldFor: (bot) => this.fieldFor(bot),
      homeFieldFor: (bot) => this.homeFieldFor(bot),
      hasCover: (bot, tx, tz) => {
        if (!this.cover || !this.nav) return false;
        const s = this.nav.surfaceAt(bot.position.x, bot.position.y, bot.position.z);
        return this.cover.coverAt(s, bot.position.x, bot.position.z, tx, tz);
      },
      findCover: (bot, tx, tz, into) =>
        this.cover ? this.cover.findCover(bot.position, tx, tz, into) : false,
      openness: (bot) => {
        if (!this.cover || !this.nav) return 1;
        const s = this.nav.surfaceAt(bot.position.x, bot.position.y, bot.position.z);
        return this.cover.opennessAt(s);
      },
      separation: (bot, out) => this.separation(bot, out),
      throwGrenade: (bot, at) => this.throwGrenadeFor(bot, bot.eyePos, at),
      clearObstacles: (x, y, z, out) =>
        this.obstacles
          ? this.obstacles.resolve(x, y, z, CONFIG.nav.bodyRadius, out)
          : (out.set(x, y, z), false),
    };
  }

  setMap(map: GameMap): void {
    this.nav = map.nav;
    this.cover = map.cover;
    this.obstacles = map.obstacles;
  }

  /**
   * The one non-bot combatant, offline. Replaces whatever was there, so calling
   * it twice does not put the player in the fight twice.
   */
  setPlayer(player: Combatant): void {
    this.humans.length = 0;
    this.humans.push(player);
  }

  /** Adds a human to the fight. The server's path; `setPlayer` is the game's. */
  addHuman(human: Combatant): void {
    if (!this.humans.includes(human)) this.humans.push(human);
  }

  removeHuman(human: Combatant): void {
    const i = this.humans.indexOf(human);
    if (i >= 0) this.humans.splice(i, 1);
  }

  /**
   * Takes a bot out of the fight because a human has its slot, or puts it back.
   *
   * Benching does NOT kill or dispose: the rig, the skill and the squad are all
   * still there, and un-benching drops the bot back into the ordinary respawn
   * queue. That is what makes a human joining and leaving symmetrical, and it
   * is why the roster is always exactly the same size.
   */
  setBenched(bot: Bot, benched: boolean): void {
    if (benched) {
      this.benched.add(bot);
      // Taken off the field immediately rather than left to die: a body that
      // stayed standing where the bot was would be shot at by its own side's
      // enemies while the human who replaced it spawns somewhere else.
      bot.alive = false;
      bot.state = "dead";
      bot.respawnT = 0;
      bot.setEnabled(false);
    } else {
      this.benched.delete(bot);
      // Left dead with a zero timer, which is precisely the state the respawn
      // pass in `update` picks up — so the bot comes back on the next tick
      // through the ordinary door rather than being placed by hand.
      bot.respawnT = 0;
    }
  }

  isBenched(bot: Bot): boolean {
    return this.benched.has(bot);
  }

  /**
   * A gun went off at `at`. Every bot near enough hears it.
   *
   * Push, not pull, and no rays: a squared-distance sweep over the roster, 16
   * compares against ~90 shots a second. The position is jittered, so bots
   * converge on the *sound* rather than snapping their attention onto the exact
   * shooter — hearing that resolves to a precise position is indistinguishable
   * from a wallhack.
   *
   * Called internally for bot fire and by `Game` for the player's.
   */
  hearGunshot(at: Vector3, shooter: Team): void {
    const p = CONFIG.bots.perception;
    const range2 = p.hearRange * p.hearRange;
    for (const bot of this.bots) {
      if (!bot.alive || this.benched.has(bot)) continue;
      const dx = bot.position.x - at.x;
      const dz = bot.position.z - at.z;
      if (dx * dx + dz * dz > range2) continue;
      // Deterministic-ish jitter from the position itself rather than
      // Math.random(), so the same shot is heard the same way by everyone and
      // a replay of a fight is reproducible.
      const j = p.hearJitter;
      bot.memory.heardShot(
        at,
        bot.team !== shooter,
        Math.sin(at.x * 12.9898 + at.z * 78.233) * j,
        Math.cos(at.x * 39.3468 + at.z * 11.135) * j,
      );
    }
  }

  /**
   * A round passed close to `near` without hitting it. Wired from `Game` off
   * `CombatSystem.onNearMiss`, which rides the target loop every shot already
   * walks — no new rays, no new iteration.
   */
  suppress(near: Hittable, from: Vector3): void {
    if (near instanceof Bot && near.alive) near.memory.nearMiss(from);
  }

  /**
   * Re-draws every bot's skill for the given difficulty tier. Called on round
   * start, so a difficulty picked in the menu applies without rebuilding the
   * (never-disposed) rig pool.
   */
  setDifficulty(tier: number): void {
    assignSkills(this.bots, tier);
  }

  /** Kills everyone and hides every rig, without disposing the pool. */
  reset(): void {
    for (const bot of this.bots) {
      bot.alive = false;
      bot.state = "dead";
      bot.respawnT = 0;
      bot.setEnabled(false);
    }
  }

  /** Living enemies of `team`, as hitscan targets. Reused, not reallocated. */
  hittablesAgainst(team: Team): Hittable[] {
    const out = this.hittableScratch[team];
    out.length = 0;
    for (const bot of this.bots) {
      // A benched bot is not in the fight and must not be shootable: its slot
      // belongs to a human who is somewhere else entirely.
      if (bot.alive && bot.team !== team && !this.benched.has(bot)) out.push(bot);
    }
    // Humans must be hittable too — acquire() aims bots at them, so leaving
    // them out here makes enemy shots fly through people. The team check keeps
    // a shooter out of their own shot's target list (Game passes player.team
    // for player fire and aim assist).
    for (const human of this.humans) {
      if (human.alive && human.team !== team) out.push(human);
    }
    return out;
  }

  update(dt: number, cameraPos: Vector3): void {
    if (!this.nav) return;
    // Both, together: the list holds references into the pool, so releasing one
    // without the other either leaks slots or hands out live vectors.
    this.muzzleFlashes.length = 0;
    this.flashCount = 0;
    const b = CONFIG.bots;

    // --- respawn ---
    for (const bot of this.bots) {
      if (this.benched.has(bot)) continue;
      if (bot.alive || bot.respawnT > 0) continue;
      const spawn = this.spawnPointFor(bot);
      if (spawn) {
        this.applyOrder(bot);
        bot.spawn(spawn.pos, spawn.yaw);
      }
    }

    this.updateSquads(dt);

    // --- staggered thinking ---
    // Budget = roster * rate * dt, so each bot thinks `thinkRate` times a
    // second regardless of frame rate.
    this.thinkDebt += this.bots.length * b.thinkRate * dt;
    let budget = Math.floor(this.thinkDebt);
    this.thinkDebt -= budget;
    budget = Math.min(budget, this.bots.length);
    // A dead bot used to consume a budget slot on its way past the cursor, so
    // with half the roster respawning the living half thought at half the rate.
    // Skipping without spending, bounded by one full pass so an all-dead roster
    // still terminates, keeps the advertised rate honest.
    let scanned = 0;
    for (let done = 0; done < budget && scanned < this.bots.length; scanned++) {
      const bot = this.bots[this.thinkCursor];
      this.thinkCursor = (this.thinkCursor + 1) % this.bots.length;
      // Benched skips for the same reason dead does: spending a think slot on a
      // bot that is not in the fight makes the living think slower than
      // `thinkRate` advertises.
      if (!bot.alive || this.benched.has(bot)) continue;
      this.applyOrder(bot);
      bot.think(this.ctx, this.zoneFor(bot));
      done++;
    }

    // --- per-frame movement, with LOD ---
    // The fog wall, from CONFIG rather than written out here: the ragdoll gate
    // is the same distance for the same reason (nothing to see past it), and
    // two copies is how that one came to be pinned to `lodFreezeDistance`.
    const fogEnd = b.lodDisableDistance;
    for (const bot of this.bots) {
      if (this.benched.has(bot)) continue;
      if (bot.state === "dead" && bot.respawnT <= 0 && !bot.rig.root.isEnabled()) {
        continue;
      }
      const d = Vector3.Distance(bot.position, cameraPos);
      if (d > fogEnd) {
        // Past the fog the bot is invisible anyway; skip drawing and posing,
        // but keep integrating so the battle line still moves.
        bot.setEnabled(false);
        bot.update(dt, this.ctx, false);
        continue;
      }
      if (bot.alive || bot.state === "dead") bot.setEnabled(true);
      bot.setOutlines(d < b.lodOutlineDistance);
      bot.update(dt, this.ctx, d < b.lodFreezeDistance);
    }
  }

  /**
   * Re-plans both teams' squad orders on their own slow timer.
   *
   * Its own budget rather than the per-bot think budget: this is four objects
   * at `CONFIG.bots.squad.updateRate`, and stealing think slots for it would
   * silently lengthen every bot's reaction time for no reason.
   */
  private updateSquads(dt: number): void {
    this.squadT -= dt;
    if (this.squadT > 0) return;
    this.squadT = 1 / CONFIG.bots.squad.updateRate;

    for (const team of [0, 1] as const) {
      const centroids = this.centroidScratch[team];
      const held = this.squadHeld[team];
      centroids.length = 0;
      held.length = 0;

      // Centroid of each squad's living members. A dead squad still needs an
      // entry so the order array stays indexed by squad number.
      const counts: number[] = [];
      for (const bot of this.bots) {
        if (bot.team !== team) continue;
        while (centroids.length <= bot.squad) {
          centroids.push(new Vector3());
          counts.push(0);
          held.push(this.squadOrders[team][held.length]?.pointId ?? "");
        }
        if (!bot.alive || this.benched.has(bot)) continue;
        centroids[bot.squad].addInPlace(bot.position);
        counts[bot.squad] += 1;
      }
      for (let i = 0; i < centroids.length; i++) {
        if (counts[i] > 0) centroids[i].scaleInPlace(1 / counts[i]);
        else {
          // Nobody left: plan from the home spawn, which is where they will
          // come back from anyway.
          const spawn = this.spawnPointFor(this.bots.find((b) => b.team === team)!);
          if (spawn) centroids[i].copyFrom(spawn.pos);
        }
      }
      this.squadOrders[team] = this.planSquads(team, centroids, held);
    }
  }

  /** Pushes the squad's current order onto one bot. */
  private applyOrder(bot: Bot): void {
    const order = this.squadOrders[bot.team][bot.squad];
    if (!order) return;
    bot.objective = order.pointId;
    bot.defending = order.defend;
  }

  // --- BattleCtx implementation -------------------------------------------

  /**
   * Nearest enemy in range with line of sight.
   *
   * Candidates are gathered by distance first and only then ray-tested, in
   * ascending order, returning the first one that is actually visible. Testing
   * every candidate instead would fire up to thirty rays per think — at 5 Hz
   * across 16 bots that is thousands of `pickWithRay` calls a second. This way
   * the common case is one ray.
   */
  private acquire(bot: Bot): Combatant | null {
    const range = CONFIG.bots.engageRange;
    const enemy = OTHER_TEAM[bot.team];
    const candidates = this.candidateScratch;
    candidates.length = 0;

    // Stick with the current target while it is still a valid one.
    //
    // Without this, "nearest visible" flips between enemies as a crowd shuffles
    // around, and every switch restarts the bot's reaction timer — bots that
    // are permanently 0.2 s into a 0.35 s wind-up never actually shoot. Keeping
    // the target until it dies, breaks line of sight, or leaves range is both
    // more lethal and more human.
    const held = bot.target;
    if (
      held &&
      held.alive &&
      held.team === enemy &&
      Vector3.Distance(bot.position, held.position) < range &&
      this.visible(bot.eyePos, held.eyePos)
    ) {
      return held;
    }

    const consider = (c: Combatant) => {
      if (!c.alive || c.team !== enemy) return;
      const d = Vector3.Distance(bot.position, c.position);
      if (d < range && this.inView(bot, c)) candidates.push({ c, d });
    };
    for (const other of this.bots) {
      if (!this.benched.has(other)) consider(other);
    }
    for (const human of this.humans) consider(human);
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.d - b.d);
    // Bounded, not exhaustive. A bot in a crowded fight can have nine
    // candidates in range, and testing them all is nine rays for a think tick
    // that usually wants one — the cost this method's own comment was written
    // to avoid. Stopping after the nearest few costs only that a bot may miss a
    // distant enemy while three nearer ones are behind cover, and it will pick
    // them up on the next tick 200 ms later.
    const budget = Math.min(candidates.length, CONFIG.bots.acquireRayBudget);
    for (let i = 0; i < budget; i++) {
      const c = candidates[i].c;
      if (this.visible(bot.eyePos, c.eyePos)) return c;
    }
    return null;
  }

  /**
   * Is `c` inside the bot's field of view?
   *
   * Bots used to see through a full 360 degrees, instantly, out to 55 m: one
   * with its back turned acquired you the moment you rounded a corner, and
   * there was no such thing as flanking. A cone fixes that, and it is *cheaper*
   * than what it replaces — four flops per candidate, run before the ray test,
   * so it shrinks the candidate list rather than adding to it.
   *
   * Two exemptions. Anything inside `peripheralRange` is noticed regardless of
   * facing, because nobody misses a soldier at arm's length. And a live threat
   * cue widens the cone: a bot that has just been shot at is looking harder.
   *
   * Note this gates *acquisition* only. Once a bot has a target it faces it, so
   * a tracked enemy never falls out of the cone — you can flank an unaware bot,
   * not one already fighting you. That asymmetry is the intended behaviour.
   */
  private inView(bot: Bot, c: Combatant): boolean {
    const dx = c.position.x - bot.position.x;
    const dz = c.position.z - bot.position.z;
    const d2 = dx * dx + dz * dz;
    const peripheral = bot.profile.peripheralRange;
    if (d2 <= peripheral * peripheral) return true;
    const d = Math.sqrt(d2);
    if (d < 1e-4) return true;
    // Bot yaw is atan2(x, z), so forward is (sin, cos) — see Bot's facing code.
    const dot = (dx * Math.sin(bot.facing) + dz * Math.cos(bot.facing)) / d;
    return dot >= (bot.alerted ? bot.profile.alertFovCos : bot.profile.fovCos);
  }

  /**
   * Line of sight against the map's collider proxies. This is the thing the
   * retired enemies never did — they fired straight at the player through
   * walls, which is invisible in an empty arena and absurd in a village.
   */
  private visible(from: Vector3, to: Vector3): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return true;
    this.ray.origin.copyFrom(from);
    this.ray.direction.set(dx / len, dy / len, dz / len);
    this.ray.length = len;
    const hit = this.scene.pickWithRay(this.ray, OPAQUE_ONLY);
    return !hit?.hit;
  }

  /**
   * A bot's shot, aimed at a world point rather than at a target.
   *
   * The point is the bot's own lagging aim point, which is what makes a
   * strafing enemy hard to hit. Returns true when the round was stopped by
   * geometry and found nobody — the caller reads that as a possible loss of
   * line of sight, for free, off a wall pick `CombatSystem` was already paying
   * for and discarding.
   */
  private botFire(bot: Bot, aimAt: Vector3, spread: number): boolean {
    const from = bot.eyePos;
    const dir = aimAt.subtract(from);
    const len = dir.length();
    if (len < 0.01) return false;
    dir.scaleInPlace(1 / len);
    const muzzle = bot.muzzleWorld();
    const shot = this.combat.fire(
      from,
      dir,
      spread,
      CONFIG.bots.damage,
      muzzle,
      this.hittablesAgainst(bot.team),
      CONFIG.bots.range,
      BOT_SHOT,
    );
    // Pooled, not cloned. The clone was needed — `muzzleWorld` hands back a
    // live node position that walks away with the bot — but it was also the
    // one allocation left on the bot firing path, in the file whose `BOT_SHOT`
    // constant exists two hundred lines above precisely to avoid one. The list
    // is emptied every frame, so a vector per slot is reused for the life of
    // the round and the high-water mark is the busiest frame's flash count.
    const at = this.flashPool[this.flashCount++] ??= new Vector3();
    at.copyFrom(muzzle);
    this.muzzleFlashes.push(at);
    this.onBotFired(bot, at);
    this.hearGunshot(at, bot.team);
    // The victim is whoever the ray actually found, which is often not the bot
    // that was being aimed at — a squadmate walks into the line all the time,
    // and on a server half the roster is people.
    if (shot.killed && shot.target) {
      this.onBotKill(shot.target, bot);
    }
    return shot.hitWall && !shot.target;
  }

  private fieldFor(bot: Bot): FlowField | null {
    if (!this.nav || !bot.objective) return null;
    return this.nav.field(bot.objective) ?? null;
  }

  /** The route home, for a bot breaking contact. Built by MapBuilder per team. */
  private homeFieldFor(bot: Bot): FlowField | null {
    if (!this.nav) return null;
    return this.nav.field(`home${bot.team}`) ?? null;
  }

  /**
   * Push-apart from nearby friendlies so a squad spreads out instead of walking
   * as one body. O(n^2) over the roster and cheap at this size.
   */
  private separation(bot: Bot, out: Vector3): void {
    out.setAll(0);
    const min = CONFIG.bots.separation;
    const min2 = min * min;
    for (const other of this.bots) {
      if (other === bot || !other.alive || this.benched.has(other)) continue;
      const dx = bot.position.x - other.position.x;
      const dz = bot.position.z - other.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > min2 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = (min - d) / min;
      out.x += (dx / d) * push;
      out.z += (dz / d) * push;
    }
  }

  disposeAll(): void {
    for (const bot of this.bots) bot.dispose();
    this.bots.length = 0;
  }
}
