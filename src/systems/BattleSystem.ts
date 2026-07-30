/**
 * BattleSystem.ts — Bot roster: a fixed pool built once and NEVER disposed
 * (death hides a rig, respawn re-poses it — respawning is continuous), AI
 * scheduling, LOS, distance LOD.
 * Invariants: think ticks are staggered round-robin at CONFIG.bots.thinkRate —
 * target acquisition ray-tests candidates nearest-first and stops at the first
 * visible one. LOS rays filter metadata.solid === true. Bot muzzle flashes are
 * NOT pulsed from here — this system only records flash positions and Game
 * spends CONFIG.lighting.muzzleBudgetPerFrame on the nearest few (16 shader
 * light slots are absolute). Runs AFTER ConquestSystem.update each frame.
 * Cross-system effects go out via onBotKilled/onBotFired callbacks wired in
 * Game — never import other systems.
 */
import { Ray, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { Bot, type BattleCtx } from "../entities/Bot";
import { OTHER_TEAM, type Combatant, type Team } from "../entities/Combatant";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { FlowField, NavGrid } from "../world/NavGrid";
import type { GameMap } from "../world/MapBuilder";
import type { ObstacleField } from "../world/ObstacleField";
import type { CombatSystem, Hittable } from "./CombatSystem";

/**
 * Owns both teams: a fixed pool of bot rigs, the AI schedule, and the render
 * LOD that makes thirty-two of them affordable.
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
 * Deliberately *not* here: a spatial hash. With 33 combatants the pairwise
 * separation pass is ~500 distance checks a frame, which is far cheaper than
 * maintaining buckets. Revisit it if the roster grows past ~64.
 */
export class BattleSystem {
  readonly bots: Bot[] = [];
  /** Muzzle positions from this frame, for `Game` to spend its light budget on. */
  readonly muzzleFlashes: Vector3[] = [];

  /** Wired by Game: a bot died. */
  onBotKilled: (bot: Bot, killer: Team) => void = () => {};
  /** Wired by Game: a bot pulled the trigger, at this world position. */
  onBotFired: (bot: Bot, at: Vector3) => void = () => {};
  /** Wired by Game: where should this bot deploy? */
  spawnPointFor: (bot: Bot) => { pos: Vector3; yaw: number } | null = () => null;
  /** Wired by Game: which flag is this bot's squad heading for? */
  objectiveFor: (bot: Bot) => string = () => "";
  /** Wired by Game: is this bot standing in a capture zone it should hold? */
  inCaptureZone: (bot: Bot) => boolean = () => false;

  private nav: NavGrid | null = null;
  private obstacles: ObstacleField | null = null;
  private player: Combatant | null = null;
  private thinkCursor = 0;
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
      fire: (bot, target, spread) => this.botFire(bot, target, spread),
      fieldFor: (bot) => this.fieldFor(bot),
      separation: (bot, out) => this.separation(bot, out),
      clearObstacles: (x, y, z, out) =>
        this.obstacles
          ? this.obstacles.resolve(x, y, z, CONFIG.nav.bodyRadius, out)
          : (out.set(x, y, z), false),
    };
  }

  setMap(map: GameMap): void {
    this.nav = map.nav;
    this.obstacles = map.obstacles;
  }

  setPlayer(player: Combatant): void {
    this.player = player;
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
      if (bot.alive && bot.team !== team) out.push(bot);
    }
    // The player must be hittable too — acquire() aims bots at them, so
    // leaving them out here makes enemy shots fly through the player. The
    // team check keeps the player out of their own shot's target list
    // (Game passes player.team for player fire and aim assist).
    if (this.player && this.player.alive && this.player.team !== team) {
      out.push(this.player);
    }
    return out;
  }

  update(dt: number, cameraPos: Vector3): void {
    if (!this.nav) return;
    this.muzzleFlashes.length = 0;
    const b = CONFIG.bots;

    // --- respawn ---
    for (const bot of this.bots) {
      if (bot.alive || bot.respawnT > 0) continue;
      const spawn = this.spawnPointFor(bot);
      if (spawn) {
        bot.objective = this.objectiveFor(bot);
        bot.spawn(spawn.pos, spawn.yaw);
      }
    }

    // --- staggered thinking ---
    // Budget = roster * rate * dt, so each bot thinks `thinkRate` times a
    // second regardless of frame rate.
    this.thinkDebt += this.bots.length * b.thinkRate * dt;
    let budget = Math.floor(this.thinkDebt);
    this.thinkDebt -= budget;
    budget = Math.min(budget, this.bots.length);
    for (let i = 0; i < budget; i++) {
      const bot = this.bots[this.thinkCursor];
      this.thinkCursor = (this.thinkCursor + 1) % this.bots.length;
      if (!bot.alive) continue;
      bot.objective = this.objectiveFor(bot);
      bot.think(this.ctx, this.inCaptureZone(bot));
    }

    // --- per-frame movement, with LOD ---
    const fogEnd = 78;
    for (const bot of this.bots) {
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
      if (d < range) candidates.push({ c, d });
    };
    for (const other of this.bots) consider(other);
    if (this.player) consider(this.player);
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.d - b.d);
    for (const { c } of candidates) {
      if (this.visible(bot.eyePos, c.eyePos)) return c;
    }
    return null;
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
    const hit = this.scene.pickWithRay(
      this.ray,
      (m) => !!m.metadata && m.metadata.solid === true,
    );
    return !hit?.hit;
  }

  private botFire(bot: Bot, target: Combatant, spread: number): void {
    const from = bot.eyePos;
    const dir = target.eyePos.subtract(from);
    const len = dir.length();
    if (len < 0.01) return;
    dir.scaleInPlace(1 / len);
    const muzzle = bot.muzzleWorld();
    const shot = this.combat.fire(
      from,
      dir,
      spread,
      CONFIG.bots.damage,
      muzzle,
      this.hittablesAgainst(bot.team),
    );
    const at = muzzle.clone();
    this.muzzleFlashes.push(at);
    this.onBotFired(bot, at);
    // The victim is whoever the ray actually found, which is often not the bot
    // that was being aimed at — a squadmate walks into the line all the time.
    if (shot.killed && shot.target instanceof Bot) {
      this.onBotKilled(shot.target, bot.team);
    }
  }

  private fieldFor(bot: Bot): FlowField | null {
    if (!this.nav || !bot.objective) return null;
    return this.nav.field(bot.objective) ?? null;
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
      if (other === bot || !other.alive) continue;
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
