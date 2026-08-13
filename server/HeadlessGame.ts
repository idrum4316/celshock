/**
 * server/HeadlessGame.ts — The authoritative simulation: a NullEngine scene,
 * the three systems that decide a round, and the wiring between them.
 * Owns: the engine/scene lifetime, the map, and the per-tick order. It is the
 * server's answer to `core/Game.ts` and follows that file's rules — systems
 * never import each other, every cross-system behaviour is a callback installed
 * here, and `ConquestSystem.update` runs BEFORE `BattleSystem.update` so a
 * bot's think tick sees this frame's flag ownership.
 * Invariants: NOTHING here may render, and nothing may reach a canvas — see
 * `server/README.md`. No `GrenadeSystem` yet: its `BlastDust` builds a
 * `DynamicTexture` and a `GPUParticleSystem`, neither of which exists without
 * GL, so grenades wait for phase 7 and the split that lets the dust stay
 * behind.
 *
 * A slot index IS a bot index, by construction: `Roster` lays its slots out
 * team 0 then team 1, `BattleSystem` builds its pool the same way, and both are
 * sized from `CONFIG.bots.perTeam`. That is what makes benching a bot for a
 * human a single array index rather than a mapping that can disagree.
 */
import { Scene, Vector3 } from "@babylonjs/core";
// The `.js` is required and must stay: `@babylonjs/core` declares no `exports`
// map, and the null engine is not in the package barrel.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { CONFIG } from "../src/config";
import { Bot } from "../src/entities/Bot";
import type { Combatant, Team } from "../src/entities/Combatant";
import type { WeaponSetup } from "../src/entities/weapons";
import { BattleSystem } from "../src/systems/BattleSystem";
import { CombatSystem, type ShotResult } from "../src/systems/CombatSystem";
import { ConquestSystem } from "../src/systems/ConquestSystem";
import { GrenadeSystem } from "../src/systems/GrenadeSystem";
import { CelMaterialFactory } from "../src/shaders/CelShader";
import type { GameMap } from "../src/world/MapBuilder";
import type { MapDef } from "../src/world/maps";
import { LagComp } from "./lagComp";
import { NetPlayer } from "./NetPlayer";
import { buildServerWorld } from "./world";

export class HeadlessGame {
  readonly engine = new NullEngine();
  readonly scene: Scene;
  readonly combat: CombatSystem;
  readonly battle: BattleSystem;
  readonly conquest = new ConquestSystem();
  readonly grenades: GrenadeSystem;

  map: GameMap | null = null;

  /** Connected humans, by slot. Sparse — most slots are bots. */
  readonly players = new Map<number, NetPlayer>();

  /** Position history, so a shot resolves against what its shooter saw. */
  readonly lag = new LagComp();

  /** Server tick count since the round started. */
  tick = 0;

  private readonly mats: CelMaterialFactory;
  private readonly combatants: Combatant[] = [];

  constructor() {
    this.scene = new Scene(this.engine);
    this.mats = new CelMaterialFactory(this.scene);
    // Order matters on the client because `Game`'s GlowLayer scan runs at
    // construction; here it does not, but the pair is kept in the same order so
    // the two files read the same way.
    this.combat = new CombatSystem(this.scene, this.mats);
    this.battle = new BattleSystem(this.scene, this.mats, this.combat);
    // Ballistics without the picture. Where a grenade lands and who it hurts
    // is a rule and belongs here; the dust needs a canvas and WebGL2 and does
    // not exist on this side — see `GrenadeOptions`.
    this.grenades = new GrenadeSystem(this.scene, this.mats, { dust: false });
    this.wire();
  }

  /**
   * Builds a map and starts a round on it.
   *
   * The same sequence as `Game.buildRound`, minus everything about presentation:
   * skills are re-drawn for the tier, the world is rebuilt, the roster is reset
   * and conquest starts. The rig pool is never disposed, so this is the only
   * place the roster's difficulty can change — exactly as on the client.
   */
  async startRound(def: MapDef, difficulty: number): Promise<void> {
    this.battle.setDifficulty(difficulty);
    this.map?.dispose();
    this.map = await buildServerWorld(this.scene, def);
    this.battle.setMap(this.map);
    this.battle.reset();
    this.conquest.start(this.map);
    // The floor is the backstop under the collider proxies — without it a
    // grenade that misses every box falls forever.
    this.grenades.setTerrain(this.map.terrain);
    this.grenades.reset();
    for (const bot of this.battle.bots) this.lag.track(bot);
    this.tick = 0;
  }

  /**
   * One simulation step.
   *
   * The order is `Game.updateWorld`'s, and for the same reasons: conquest
   * first so bots see this frame's ownership, bots second, then the rounds
   * already in the air. Returns false on the tick the round ended.
   */
  step(dt: number): boolean {
    if (!this.map) return false;
    this.tick++;

    // Reinforcements for people. Bots have their own inside `BattleSystem`;
    // this is the human half, and it runs before conquest counts occupancy so a
    // player who came back this tick is standing on the flag this tick.
    //
    // This is the ONE place a person is put into the world — a fresh join
    // arrives here as `alive === false, respawnT === 0` and is deployed by the
    // same line that redeploys a corpse. Spawning from `Match.admit` as well
    // would be a second door onto the same act, which is how one of them comes
    // to disagree with the other.
    for (const player of this.players.values()) {
      if (player.alive) continue;
      if (player.respawnT > 0) {
        player.respawnT -= dt;
        continue;
      }
      const spawn = this.spawnPointFor(player.team);
      if (!spawn) continue;
      player.spawn(spawn.pos, spawn.yaw);
      this.onPlayerSpawned(player, spawn.pos, spawn.yaw);
    }

    // Both kinds of body, in one list. `ConquestSystem` counts occupancy off
    // this and cannot tell them apart, which is the point — a flag does not
    // care who is standing on it.
    this.combatants.length = 0;
    this.combatants.push(...this.battle.bots);
    for (const player of this.players.values()) this.combatants.push(player);
    this.conquest.update(dt, this.combatants);
    if (this.conquest.winner !== null) return false;

    // The camera position every LOD test keys off. There is no camera here, so
    // it is the map centre — which puts every bot inside `lodDisableDistance`
    // and keeps them all fully simulated. That is what the server wants: LOD is
    // a drawing budget, and skipping a bot's pose to save a draw call it was
    // never going to make would only make the authority disagree with the
    // clients about where that bot is.
    this.battle.update(dt, ORIGIN);
    this.combat.update(dt);
    // After the bots, so a grenade thrown on this frame's think tick flies on
    // this frame rather than sitting in the thrower's hand until the next —
    // the same order `Game.updateWorld` uses.
    this.grenades.update(dt);

    // AFTER everything has moved, so a frame records the end of a tick and not
    // the middle of one. Recording first would put every body's history half a
    // tick ahead of the positions the snapshot on that tick reports, and a
    // rewind would land between two states that never coexisted.
    this.lag.record(Date.now());
    return true;
  }

  dispose(): void {
    this.map?.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }

  /**
   * Everything the bots need from the rest of the game.
   *
   * The client's `Game.wireBattle` installs sounds and minimap reveals here
   * too; none of those exist on a server, so what is left is the three
   * callbacks that are actually about the fight. Their absence is the point —
   * a server that had to stub `Sfx` would be a server that had imported it.
   */
  private wire(): void {
    // A death costs the dying side a reinforcement. This is the whole of what
    // `Game.registerBotKill` does that is about RULES rather than about feel —
    // the ragdoll, the sound and the killfeed line are all presentation, and
    // the scores are the client's to display. Without this the only thing
    // draining tickets is the flag bleed, and a round runs several times too
    // long in a way that looks like mistuned config rather than a missing
    // callback.
    this.battle.onBotKilled = (bot, killer) => this.onKill(bot, killer);
    this.battle.spawnPointFor = (bot) => this.spawnPointFor(bot.team);
    this.battle.planSquads = (team, centroids, previous) =>
      this.conquest.planSquads(team, centroids, previous);
    this.battle.zoneFor = (bot) => {
      const p = this.conquest.pointAt(bot.position);
      if (!p || p.def.id !== bot.objective) return "none";
      return bot.defending && p.owner === bot.team ? "hold" : "contest";
    };
    // A bot asking for a grenade on a position. The arm has the last word: a
    // solve it cannot make returns false and the bot spends nothing.
    this.battle.throwGrenadeFor = (from, at, team) =>
      this.grenades.throwAt(from, at, team, false);
    // A blast resolves against the THROWER's target list, the same way a bullet
    // does, so friendly fire is excluded by construction here too and this
    // system never learns what a team is.
    this.grenades.hittablesFor = (team) => this.battle.hittablesAgainst(team);
    this.grenades.onExploded = (at) => this.onExplosion(at);
    this.grenades.onBlastHit = (victim, thrower, _byPlayer, killed) => {
      // A person's damage already left through `NetPlayer.onDamaged`, which
      // `takeDamage` raised before this callback ran — the same split the
      // client makes, where `onPlayerDamaged` has already handled the player by
      // the time this fires. Only bots are this handler's business.
      if (killed && victim instanceof Bot) this.onKill(victim, thrower);
    };
  }

  /**
   * A player's round, resolved by the authority.
   *
   * The client already fired this locally and flashed a hitmarker at whatever
   * its own ray found. That marker is a GUESS. This is where it becomes true or
   * doesn't: the ray is re-run here, against every target rewound to the instant
   * the shooter was actually looking at, and only this result deals damage.
   *
   * `dir` is the direction the round actually flew, spread already applied by
   * the client — so this fires with a spread of zero. `CombatSystem.fire`
   * jitters internally, and jittering again here would resolve a different
   * bullet from the one the player saw leave the barrel. The cost of trusting
   * the direction is bounded by the cone check in `Match`, which is what stops
   * a client claiming a shot fired backwards.
   */
  resolveShot(
    shooter: NetPlayer,
    origin: Vector3,
    dir: Vector3,
    renderTime: number,
    weapon: WeaponSetup,
  ): ShotResult | null {
    if (!this.map || !shooter.alive) return null;
    const targets = this.battle.hittablesAgainst(shooter.team);

    return this.lag.resolve(renderTime, shooter, () =>
      this.combat.fire(
        origin,
        dir,
        // Zero: the client's direction already carries its own spread.
        0,
        weapon.damage,
        origin,
        targets,
        weapon.range,
        {
          damageFar: weapon.damageFar,
          falloffNear: weapon.falloffNear,
          falloffFar: weapon.falloffFar,
          // The head zone is the PLAYER's, by construction and not by a check
          // — see the header of `CombatSystem`. This method only ever resolves
          // a person's round, so passing it here keeps that true: bots fire
          // through `BOT_SHOT`, which omits the field, and their rounds never
          // test the sphere at all. Handing bots a head zone would make every
          // accurate bot shot a headshot, since they aim at `eyePos`.
          headMult: CONFIG.combat.headshotMult,
        },
      ),
    );
  }

  /**
   * Seats a human in a slot, and takes the bot that was there off the field.
   *
   * The bot is benched rather than killed: killing it would charge its team a
   * reinforcement for somebody joining the game, which is a ticket the round
   * should never lose. `BattleSystem.setBenched` owns what that means.
   */
  addPlayer(slot: number, team: Team): NetPlayer {
    const player = new NetPlayer(slot, team);
    // A hit taken by a person needs a ticket charged and an event sent, and
    // neither is `CombatSystem`'s business — it calls `takeDamage` and reads
    // only whether that killed. Routed here for the same reason every other
    // cross-system effect in this file is: the systems never reach each other.
    player.onDamaged = (amount, from, killed) => {
      if (killed) this.conquest.registerDeath(player.team);
      this.onPlayerDamaged(player, amount, from, killed);
    };
    this.players.set(slot, player);
    this.lag.track(player);
    this.battle.addHuman(player);
    this.battle.setBenched(this.battle.bots[slot], true);
    return player;
  }

  /**
   * A human left. The bot in that slot goes back into the fight.
   *
   * Also does not charge a ticket, for the mirror of the reason joining does
   * not: leaving is not dying. The bot rejoins through the ordinary respawn
   * queue with its skill and squad intact, because benching never tore any of
   * that down.
   */
  removePlayer(slot: number): void {
    const player = this.players.get(slot);
    if (!player) return;
    player.retire();
    this.players.delete(slot);
    this.lag.untrack(player);
    this.battle.removeHuman(player);
    this.battle.setBenched(this.battle.bots[slot], false);
  }

  /** Where a human of `team` should deploy — the same picker the bots use. */
  spawnFor(team: Team): { pos: Vector3; yaw: number } | null {
    return this.spawnPointFor(team);
  }

  /**
   * A bot went down. Charges the ticket and reports it upward.
   *
   * `Match` wires `onKill` to turn this into a killfeed event for the clients;
   * this class does not know what a client is.
   */
  private onKill(bot: Bot, killer: Team): void {
    this.conquest.registerDeath(bot.team);
    this.kills[killer] += 1;
    this.losses[bot.team] += 1;
    this.onKillEvent(bot, killer);
  }

  /** Wired by `Match`: a body went down, for the killfeed. */
  onKillEvent: (bot: Bot, killer: Team) => void = () => {};

  /** Wired by `Match`: a person has been placed in the world. */
  onPlayerSpawned: (player: NetPlayer, at: Vector3, yaw: number) => void = () => {};

  /** Wired by `Match`: a grenade went off here. */
  onExplosion: (at: Vector3) => void = () => {};

  /** Wired by `Match`: a person took a hit. */
  onPlayerDamaged: (
    player: NetPlayer,
    amount: number,
    from: Vector3 | undefined,
    killed: boolean,
  ) => void = () => {};

  /** Kills and losses per team, for the scoreboard. */
  readonly kills: [number, number] = [0, 0];
  readonly losses: [number, number] = [0, 0];

  /**
   * Where a combatant of `team` deploys.
   *
   * `Game.spawnPointFor`'s logic, including the scatter — a whole squad landing
   * on one point is as bad here as it is on the client. `Math.random()` is
   * correct on this side of the wire: the server decides where people appear
   * and tells them, so there is nothing for a client to reproduce.
   */
  private spawnPointFor(team: Team): { pos: Vector3; yaw: number } | null {
    const pick = this.conquest.spawnFor(team);
    if (!pick) return null;
    return {
      pos: pick.pos.add(
        new Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6),
      ),
      yaw: pick.yaw,
    };
  }
}

/** The LOD reference point — see `step`. */
const ORIGIN = new Vector3(0, 0, 0);
