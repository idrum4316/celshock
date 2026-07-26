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
}

// Module-scope scratch vectors. AI runs 32 times a frame and allocating a
// handful of Vector3s per bot per frame was measurable churn in the old code.
const _dir = new Vector3();
const _sep = new Vector3();
const _to = new Vector3();

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
    this.syncTransform();
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
      if (animate) animateSoldier(this.rig, 0, 0, 0, Math.min(1, this.deadT / 0.7));
      if (this.deadT > 0.9) this.setEnabled(false);
      this.respawnT -= dt;
      return;
    }

    const b = CONFIG.bots;
    this.pressure = Math.max(0, this.pressure - dt * 0.5);
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
    const len = Math.hypot(_dir.x, _dir.z);
    if (len > 1e-4) {
      const step = (speed * dt) / len;
      const nx = this.position.x + _dir.x * step;
      const nz = this.position.z + _dir.z * step;
      // Bots move on the nav graph rather than through Babylon's collider:
      // 32 agents calling moveWithCollisions would walk the whole collidable
      // mesh list 32 times a frame. A cell being walkable *is* the collision
      // test, and it already accounts for headroom and step height.
      const surface = ctx.nav.surfaceAt(nx, this.position.y, nz);
      if (surface >= 0) {
        this.position.x = nx;
        this.position.z = nz;
        this.position.y = ctx.nav.heightOf(surface);
      }
      this.walkPhase += (speed * dt) / 0.9;
      this.moveBlend = Math.min(1, this.moveBlend + dt * 6);
    } else {
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
