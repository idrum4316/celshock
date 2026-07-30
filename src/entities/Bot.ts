/**
 * Bot.ts — AI combatant: FSM (advance/engage/reposition/capture/dead),
 * movement, aiming, firing. Rig visuals come from SoldierModel.
 * Invariants: NEVER uses moveWithCollisions and never runs its own pathfinding —
 * movement steers on NavGrid flow fields + ObstacleField push-out. Think ticks
 * (target acquisition, FSM transitions) are rate-limited and staggered by
 * BattleSystem; update() (movement/animation) runs every frame. Bots hold a
 * target until it dies/breaks LOS/leaves range — removing that hysteresis
 * makes bots never fire. Obstacle push-out is a preference, not a veto:
 * squeezeT drops it when wedged. Bots are pooled by BattleSystem — death hides
 * the rig, respawn re-poses it; never allocate a new Bot per respawn.
 * Animation is procedural; new behavior = new FSM state, never new clips.
 */
import { Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { FlowField, NavGrid } from "../world/NavGrid";
import { animateSoldier, buildSoldier, type SoldierRig } from "./SoldierModel";
import type { Combatant, Team } from "./Combatant";

/**
 * `advance` walks the flow field to the squad's objective; `engage` fights a
 * visible enemy; `reposition` breaks contact after taking hits; `capture` holds
 * still inside a zone; `dead` runs the collapse tween before the rig is hidden.
 */
export type BotState = "advance" | "engage" | "reposition" | "capture" | "dead";

/** What a bot is allowed to know about the world. */
export interface BattleCtx {
  nav: NavGrid;
  /** Nearest enemy with line of sight, or null. */
  acquire(bot: Bot): Combatant | null;
  /** Is `to` visible from `from`? Costs one ray pick — budgeted by the caller. */
  visible(from: Vector3, to: Vector3): boolean;
  /** Hitscan shot from a bot. */
  fire(bot: Bot, target: Combatant, spread: number): void;
  /** Flow field toward the bot's current objective, or null if it has none. */
  fieldFor(bot: Bot): FlowField | null;
  /** Push-apart from nearby friendlies, written into `out`. */
  separation(bot: Bot, out: Vector3): void;
  /**
   * Pushes a body at `(x, y, z)` out of any collider it overlaps, writing the
   * result into `out`. Returns false, leaving `out` set to the input, when the
   * spot was already clear.
   */
  clearObstacles(x: number, y: number, z: number, out: Vector3): boolean;
}

// Module-scope scratch vectors. AI runs 16 times a frame and allocating a
// handful of Vector3s per bot per frame was measurable churn in the old code.
const _dir = new Vector3();
const _sep = new Vector3();
const _to = new Vector3();
const _spot = new Vector3();

export class Bot implements Combatant {
  readonly team: Team;
  readonly rig: SoldierRig;

  /** Which squad this bot belongs to; squads share an objective. */
  squad = 0;
  /** Control-point id the squad is heading for. */
  objective = "";

  hp = 0;
  alive = false;
  state: BotState = "dead";
  /** Seconds until this corpse can be recycled into a fresh spawn. */
  respawnT = 0;

  readonly position = new Vector3();
  readonly eyePos = new Vector3();
  readonly center = new Vector3();
  hitRadius = 0.75;

  target: Combatant | null = null;
  /** Time since the current target was acquired; gates the first shot. */
  private aimT = 0;
  private fireCooldown = 0;
  private burstLeft = 0;
  private walkPhase = 0;
  private moveBlend = 0;
  private yaw = 0;
  private deadT = 0;
  private strafe = 1;
  private strafeT = 0;
  /** Set when the bot has recently been hit; drives `reposition`. */
  private pressure = 0;
  /** How long the bot has been trying to move without getting anywhere. */
  private stuckT = 0;
  /** Seconds left of the sidestep the watchdog triggered. */
  private detourT = 0;
  /** Which way round the obstruction that sidestep goes. */
  private detourSide = 1;
  /** Sidesteps taken since the bot last actually got somewhere. */
  private stuckStreak = 0;
  /** While positive, the bot may clip geometry to get out of a pinch. */
  private squeezeT = 0;

  constructor(
    scene: Scene,
    mats: CelMaterialFactory,
    team: Team,
    teamColor: string,
    eyeColor: string,
  ) {
    this.team = team;
    this.rig = buildSoldier(scene, mats, teamColor, eyeColor);
    this.setEnabled(false);
  }

  /** Brings a pooled bot back to life at a spawn point. */
  spawn(at: Vector3, yaw: number): void {
    this.hp = CONFIG.bots.maxHealth;
    this.alive = true;
    this.state = "advance";
    this.position.copyFrom(at);
    this.yaw = yaw;
    this.target = null;
    this.aimT = 0;
    this.deadT = 0;
    this.pressure = 0;
    this.burstLeft = CONFIG.bots.burstSize;
    this.fireCooldown = 0;
    this.stuckT = 0;
    this.detourT = 0;
    this.stuckStreak = 0;
    this.squeezeT = 0;
    this.syncTransform();
    // Re-pose to idle. The pooled rig may still hold the death collapse
    // (pitched forward, sunk 0.7 m), and animateSoldier only runs inside
    // CONFIG.bots.lodFreezeDistance — without this a bot respawning beyond
    // it walks around buried to the helmet until the player closes in and
    // the pose unfreezes (the "submarine" pop-up).
    animateSoldier(this.rig, 0, 0, 0, 0);
    this.setEnabled(true);
  }

  setEnabled(on: boolean): void {
    this.rig.root.setEnabled(on);
  }

  /** LOD hook: distant bots stop animating but keep moving. */
  setOutlines(on: boolean): void {
    for (const m of this.rig.meshes) {
      if (!m.metadata?.noOutline) m.renderOutline = on;
    }
  }

  takeDamage(amount: number): boolean {
    if (!this.alive) return false;
    this.hp -= amount;
    this.pressure = 1;
    if (this.hp <= 0) {
      this.alive = false;
      this.state = "dead";
      this.deadT = 0;
      this.target = null;
      // Reinforcements are not instant: the delay is what makes losing a
      // firefight cost the team ground as well as a ticket.
      this.respawnT = CONFIG.conquest.respawnDelay;
      return true;
    }
    return false;
  }

  /**
   * Cheap per-frame step: movement integration and animation only.
   *
   * The expensive half — target acquisition, line-of-sight rays, objective
   * re-evaluation — runs in `think()` at `CONFIG.bots.thinkRate`, staggered
   * across frames by `BattleSystem`.
   */
  update(dt: number, ctx: BattleCtx, animate: boolean): void {
    if (this.state === "dead") {
      this.deadT += dt;
      // The collapse tween ignores the pose-freeze LOD: it is five property
      // writes, and a corpse that holds its mid-stride pose past
      // lodFreezeDistance and then vanishes reads as a pop, not a death.
      animateSoldier(this.rig, 0, 0, 0, Math.min(1, this.deadT / 0.7));
      if (this.deadT > 0.9) this.setEnabled(false);
      this.respawnT -= dt;
      return;
    }

    const b = CONFIG.bots;
    this.pressure = Math.max(0, this.pressure - dt * 0.5);
    this.squeezeT = Math.max(0, this.squeezeT - dt);
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.strafeT = 0.8 + Math.random() * 1.6;
      this.strafe = Math.random() < 0.5 ? -1 : 1;
    }

    let speed = b.moveSpeed;
    _dir.setAll(0);

    switch (this.state) {
      case "advance": {
        const field = ctx.fieldFor(this);
        if (field) ctx.nav.steer(field, this.position, _dir);
        speed *= b.advanceSprintMult;
        break;
      }
      case "capture": {
        // Hold the flag, drifting slowly so the bot isn't a statue.
        _dir.set(Math.cos(this.walkPhase * 0.3), 0, Math.sin(this.walkPhase * 0.3));
        speed *= 0.25;
        break;
      }
      case "engage": {
        const t = this.target;
        if (t) {
          _to.copyFrom(t.position).subtractInPlace(this.position);
          _to.y = 0;
          const dist = _to.length();
          if (dist > 1e-3) _to.scaleInPlace(1 / dist);
          // Hold the sweet spot: close if far, back off if crowded, otherwise
          // strafe so the bot isn't a stationary target.
          if (dist > b.engageRange * 0.7) _dir.copyFrom(_to);
          else if (dist < b.minEngageRange) _dir.copyFrom(_to).scaleInPlace(-1);
          else _dir.set(-_to.z * this.strafe, 0, _to.x * this.strafe);
          speed *= 0.7;
        }
        break;
      }
      case "reposition": {
        // Break contact toward the objective; the flow field is already a
        // route through cover rather than across open ground.
        const field = ctx.fieldFor(this);
        if (field) ctx.nav.steer(field, this.position, _dir);
        break;
      }
    }

    ctx.separation(this, _sep);
    _dir.addInPlace(_sep);

    if (this.detourT > 0) {
      // Watchdog sidestep: swing the intent round to the detour side so the bot
      // walks *along* whatever it is grinding on. Keeping a third of the
      // original heading means it still drifts the right way while it does.
      this.detourT -= dt;
      const tx = -_dir.z * this.detourSide;
      const tz = _dir.x * this.detourSide;
      _dir.set(_dir.x * 0.3 + tx, 0, _dir.z * 0.3 + tz);
    }

    // De-penetrate before anything else: a bot that ended up inside a collider
    // — spawned on a prop, shoved there by separation — has to get out even
    // when it is standing still, or it is left unshootable.
    this.stepTo(ctx, 0, 0);

    const len = Math.hypot(_dir.x, _dir.z);
    if (len > 1e-4) {
      const step = (speed * dt) / len;
      const fromX = this.position.x;
      const fromZ = this.position.z;
      this.tryMove(ctx, _dir.x * step, _dir.z * step);

      // A bot that asked to move and barely did is grinding on something.
      const covered = Math.hypot(this.position.x - fromX, this.position.z - fromZ);
      if (covered < speed * dt * b.stuckFraction) {
        this.stuckT += dt;
        if (this.stuckT > b.stuckTime && this.detourT <= 0) {
          this.stuckT = 0;
          this.detourT = b.detourTime;
          this.detourSide = this.pickDetourSide(ctx, _dir.x / len, _dir.z / len);
          // Sidestepping twice with nothing to show for it means the bot is
          // wedged somewhere narrower than its own body — a gate post, a gap
          // between two props — where the push-out cancels every step it
          // takes. Let it clip through: overlapping geometry for a second is
          // the lesser evil against standing there for the rest of the round.
          if (++this.stuckStreak >= 2) this.squeezeT = b.detourTime;
        }
      } else {
        this.stuckT = 0;
        this.stuckStreak = 0;
      }

      this.walkPhase += (speed * dt) / 0.9;
      this.moveBlend = Math.min(1, this.moveBlend + dt * 6);
    } else {
      this.stuckT = 0;
      this.stuckStreak = 0;
      this.moveBlend = Math.max(0, this.moveBlend - dt * 6);
    }

    // Face the target while fighting, direction of travel otherwise.
    const faceX = this.target ? this.target.position.x - this.position.x : _dir.x;
    const faceZ = this.target ? this.target.position.z - this.position.z : _dir.z;
    if (Math.abs(faceX) + Math.abs(faceZ) > 1e-3) {
      const want = Math.atan2(faceX, faceZ);
      let delta = want - this.yaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.yaw += delta * Math.min(1, dt * 8);
    }

    this.shoot(dt, ctx);
    this.syncTransform();
    if (animate) {
      animateSoldier(this.rig, this.walkPhase, this.moveBlend, this.aimPitch(), 0);
    }
  }

  /**
   * Which way to sidestep round whatever the bot is grinding on: it probes a
   * body's length along each tangent and takes the more open one.
   *
   * Picking by probe rather than by coin flip is what stops the watchdog
   * oscillating. Each detour is short and re-triggers as soon as the bot faces
   * the obstruction again, so a side chosen at random alternates left/right
   * against a long wall and the bot stays exactly where it is. The probe scores
   * the same side every time, and consecutive detours add up into a walk around
   * the building.
   */
  private pickDetourSide(ctx: BattleCtx, dirX: number, dirZ: number): number {
    const probe = CONFIG.bots.detourProbe;
    let bestSide = this.detourSide;
    let bestScore = -Infinity;
    for (const side of [1, -1]) {
      const px = this.position.x - dirZ * side * probe;
      const pz = this.position.z + dirX * side * probe;
      const surface = ctx.nav.surfaceAt(px, this.position.y, pz);
      if (surface < 0) continue;
      if (Math.abs(ctx.nav.heightOf(surface) - this.position.y) > CONFIG.nav.stepHeight) {
        continue;
      }
      // How far the push-out has to shove the probe back is how blocked that
      // side is; an untouched probe scores zero, the best possible.
      ctx.clearObstacles(px, this.position.y, pz, _spot);
      const score = -Math.hypot(_spot.x - px, _spot.z - pz);
      // Ties keep the current side, so an ongoing detour doesn't reverse.
      if (score > bestScore + 1e-3 || (side === this.detourSide && score >= bestScore)) {
        bestScore = score;
        bestSide = side;
      }
    }
    return bestSide;
  }

  /**
   * A step with wall sliding. Head-on is tried first, then each axis alone, so
   * a bot pressed into a wall walks along it instead of standing there. The old
   * all-or-nothing test is what made bots visibly hang on corners: `engage` and
   * `capture` steer straight at a target rather than along the flow field, so
   * walking into geometry is the normal case, not the exception.
   */
  private tryMove(ctx: BattleCtx, dx: number, dz: number): boolean {
    if (this.stepTo(ctx, dx, dz)) return true;
    if (Math.abs(dx) > 1e-5 && this.stepTo(ctx, dx, 0)) return true;
    if (Math.abs(dz) > 1e-5 && this.stepTo(ctx, 0, dz)) return true;
    return false;
  }

  /**
   * Moves by `(dx, dz)` if the destination is somewhere a body can stand.
   *
   * Bots move on the nav graph rather than through Babylon's collider: 16
   * agents calling `moveWithCollisions` would walk the whole collidable mesh
   * list 16 times a frame. But the grid only samples cell centres, so the
   * destination is also pushed clear of any collider it overlaps — most of the
   * map's props are narrower than a cell and are otherwise invisible to
   * navigation entirely.
   *
   * The push-out is a preference, not a veto: where the clear spot is somewhere
   * the graph won't allow, the bot takes the overlapping one instead. Standing
   * half in a wall is bad, but being frozen where the old code could walk is
   * worse, and it is the failure the player reads as a broken bot.
   */
  private stepTo(ctx: BattleCtx, dx: number, dz: number): boolean {
    const tx = this.position.x + dx;
    const tz = this.position.z + dz;
    if (this.squeezeT > 0) return this.settle(ctx, tx, tz);
    if (
      ctx.clearObstacles(tx, this.position.y, tz, _spot) &&
      this.settle(ctx, _spot.x, _spot.z)
    ) {
      return true;
    }
    return this.settle(ctx, tx, tz);
  }

  /** Stands at `(x, z)` if the nav graph has a surface there within a step. */
  private settle(ctx: BattleCtx, x: number, z: number): boolean {
    const surface = ctx.nav.surfaceAt(x, this.position.y, z);
    if (surface < 0) return false;
    // The graph only links surfaces within a step of each other; hold the same
    // rule here or a bot can drop off the bridge into the creek in one frame.
    const height = ctx.nav.heightOf(surface);
    if (Math.abs(height - this.position.y) > CONFIG.nav.stepHeight) return false;
    this.position.set(x, height, z);
    return true;
  }

  /** Burst fire, gated by reaction time and a per-burst pause. */
  private shoot(dt: number, ctx: BattleCtx): void {
    const b = CONFIG.bots;
    this.fireCooldown -= dt;
    const t = this.target;
    if (!t || !t.alive || this.state !== "engage") return;

    this.aimT += dt;
    if (this.aimT < b.reactionTime) return;
    if (this.fireCooldown > 0) return;

    const dist = Vector3.Distance(this.eyePos, t.eyePos);
    if (dist > b.engageRange) return;

    // Accuracy falls off linearly with range, so a bot across the square is a
    // nuisance and one in the same building is lethal.
    const k = Math.min(1, dist / b.engageRange);
    ctx.fire(this, t, b.spreadNear + (b.spreadFar - b.spreadNear) * k);

    this.burstLeft -= 1;
    if (this.burstLeft <= 0) {
      this.burstLeft = b.burstSize;
      this.fireCooldown = b.burstPause;
    } else {
      this.fireCooldown = 1 / b.fireRate;
    }
  }

  /**
   * The expensive half of the AI, run at `CONFIG.bots.thinkRate` rather than
   * every frame. Everything here either fires a ray or walks a list.
   */
  think(ctx: BattleCtx, inCaptureZone: boolean): void {
    if (this.state === "dead") return;
    const b = CONFIG.bots;

    const previous = this.target;
    this.target = ctx.acquire(this);
    if (this.target !== previous) this.aimT = 0;

    if (this.target) {
      // Heavy fire with no kill in sight: fall back rather than trade.
      this.state = this.pressure > 0.75 && this.hp < b.maxHealth * 0.4
        ? "reposition"
        : "engage";
    } else if (inCaptureZone) {
      this.state = "capture";
    } else {
      this.state = "advance";
    }
  }

  private aimPitch(): number {
    const t = this.target;
    if (!t) return 0;
    const dy = t.eyePos.y - this.eyePos.y;
    const flat = Math.hypot(
      t.position.x - this.position.x,
      t.position.z - this.position.z,
    );
    return Math.atan2(dy, Math.max(flat, 0.1));
  }

  private syncTransform(): void {
    const c = this.rig.centerHeight;
    this.rig.root.position.set(this.position.x, this.position.y + c, this.position.z);
    this.rig.root.rotation.y = this.yaw;
    this.center.set(this.position.x, this.position.y + c, this.position.z);
    this.eyePos.set(this.position.x, this.position.y + 1.55, this.position.z);
  }

  muzzleWorld(): Vector3 {
    return this.rig.muzzle.getAbsolutePosition();
  }

  dispose(): void {
    this.rig.root.dispose(false, true);
  }
}
