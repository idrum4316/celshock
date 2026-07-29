/**
 * CombatSystem.ts — Hitscan for EVERYONE (player and bots share fire()), plus
 * pooled tracer/spark effects.
 * Invariants: fire() takes the shooter's target list — friendly fire is
 * excluded by the caller's list construction, never by a team check inside.
 * Wall ray filters metadata.solid === true and caps the shot; a target sphere
 * farther than the first solid hit does not count (a bot embedded in a prop is
 * unshootable — movement bugs become combat bugs). Tracers/sparks are
 * fixed-size pools: add new effects to a pool, NEVER allocate per shot.
 */
import {
  Mesh,
  MeshBuilder,
  Quaternion,
  Ray,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import type { CelMaterialFactory } from "../shaders/CelShader";

/** Anything a hitscan shot can damage. */
export interface Hittable {
  center: Vector3;
  hitRadius: number;
  invulnerable?: boolean;
  takeDamage(amount: number): boolean;
}

/** Outcome of one shot: who it hit, whether that killed them, and if it stopped on geometry. */
export interface ShotResult {
  target: Hittable | null;
  killed: boolean;
  hitWall: boolean;
}

interface Tracer {
  mesh: Mesh;
  life: number;
}

interface Spark {
  mesh: Mesh;
  t: number;
}

/**
 * Hitscan shooting and the transient effects it throws off. Tracers and
 * sparks are object-pooled.
 *
 * Every combatant is hitscan — the player and both bot teams alike — so there
 * is no projectile pool to thrash in a 32-bot firefight.
 */
export class CombatSystem {
  private tracers: Tracer[] = [];
  private sparks: Spark[] = [];

  constructor(
    private scene: Scene,
    private mats: CelMaterialFactory,
  ) {
    const fx = CONFIG.effects;
    for (let i = 0; i < fx.tracerPoolSize; i++) {
      const mesh = MeshBuilder.CreateCylinder(
        `tracer${i}`,
        { height: 1, diameter: 0.055, tessellation: 5 },
        scene,
      );
      mesh.material = mats.getEmissive("#ffe680");
      mesh.rotationQuaternion = Quaternion.Identity();
      mesh.isVisible = false;
      mesh.isPickable = false;
      this.tracers.push({ mesh, life: 0 });
    }
    for (let i = 0; i < fx.sparkPoolSize; i++) {
      const mesh = MeshBuilder.CreateSphere(
        `spark${i}`,
        { diameter: 0.3, segments: 4 },
        scene,
      );
      mesh.material = mats.getEmissive("#ffe680");
      mesh.isVisible = false;
      mesh.isPickable = false;
      this.sparks.push({ mesh, t: 0 });
    }
  }

  /**
   * A hitscan shot. Used by the player and by every bot — same ray, same
   * spread model, same tracer; only the target list and the origin differ.
   *
   * `targets` is whatever the shooter is allowed to hit, so friendly fire is
   * excluded by construction rather than by a team check in here.
   */
  fire(
    origin: Vector3,
    aimDir: Vector3,
    spread: number,
    damage: number,
    muzzle: Vector3,
    targets: Hittable[],
  ): ShotResult {
    const dir = jitterDirection(aimDir, spread);
    const range = CONFIG.weapon.range;

    // Wall/prop/floor hit distance caps the shot.
    const ray = new Ray(origin, dir, range);
    const wallPick = this.scene.pickWithRay(
      ray,
      (m) => !!m.metadata && m.metadata.solid === true,
    );
    let hitDist = wallPick && wallPick.hit ? wallPick.distance : range;
    const hitWall = !!(wallPick && wallPick.hit);

    // Nearest target sphere along the ray, if closer than the wall.
    let hitTarget: Hittable | null = null;
    for (const target of targets) {
      if (target.invulnerable) continue;
      const d = raySphere(origin, dir, target.center, target.hitRadius);
      if (d !== null && d < hitDist) {
        hitDist = d;
        hitTarget = target;
      }
    }

    const hitPoint = origin.add(dir.scale(hitDist));
    let killed = false;
    if (hitTarget) {
      killed = hitTarget.takeDamage(damage);
      this.spawnSpark(hitPoint, "#ffe680");
    } else if (hitWall) {
      this.spawnSpark(hitPoint, "#c8c8c8");
    }

    this.spawnTracer(muzzle, hitPoint);
    return { target: hitTarget, killed, hitWall };
  }

  update(dt: number): void {
    // Tracers: stretch briefly then vanish.
    for (const tr of this.tracers) {
      if (tr.life > 0) {
        tr.life -= dt;
        if (tr.life <= 0) tr.mesh.isVisible = false;
      }
    }

    // Sparks: quick scale-out pops.
    for (const s of this.sparks) {
      if (s.t > 0) {
        s.t -= dt;
        const k = Math.max(0, s.t / 0.18);
        s.mesh.scaling.setAll(0.4 + (1 - k) * 1.6);
        s.mesh.visibility = k;
        if (s.t <= 0) s.mesh.isVisible = false;
      }
    }

  }

  /** Clears transient effects between rounds. */
  clearTransient(): void {
    for (const tr of this.tracers) {
      tr.life = 0;
      tr.mesh.isVisible = false;
    }
    for (const s of this.sparks) {
      s.t = 0;
      s.mesh.isVisible = false;
    }
  }

  private spawnTracer(from: Vector3, to: Vector3): void {
    const tr =
      this.tracers.find((t) => t.life <= 0) ?? this.tracers[0];
    const delta = to.subtract(from);
    const len = Math.max(delta.length(), 0.01);
    tr.mesh.position.copyFrom(from.add(delta.scale(0.5)));
    tr.mesh.scaling.set(1, len, 1);
    Quaternion.FromUnitVectorsToRef(
      Vector3.Up(),
      delta.scale(1 / len),
      tr.mesh.rotationQuaternion!,
    );
    tr.mesh.isVisible = true;
    tr.life = CONFIG.effects.tracerLife;
  }

  private spawnSpark(pos: Vector3, colorHex: string): void {
    const s = this.sparks.find((x) => x.t <= 0) ?? this.sparks[0];
    s.mesh.position.copyFrom(pos);
    s.mesh.material = this.mats.getEmissive(colorHex);
    s.mesh.scaling.setAll(0.4);
    s.mesh.isVisible = true;
    s.t = 0.18;
  }
}

/** Ray vs sphere: returns entry distance along the ray, or null on miss. */
function raySphere(
  origin: Vector3,
  dir: Vector3,
  center: Vector3,
  radius: number,
): number | null {
  const oc = center.subtract(origin);
  const t = Vector3.Dot(oc, dir);
  if (t < 0) return null;
  const d2 = oc.lengthSquared() - t * t;
  if (d2 > radius * radius) return null;
  return t - Math.sqrt(Math.max(radius * radius - d2, 0));
}

/** Perturbs an aim direction inside a cone (uniform over the disc). */
function jitterDirection(dir: Vector3, halfAngle: number): Vector3 {
  if (halfAngle <= 0) return dir.normalizeToNew();
  let u = Vector3.Cross(dir, Vector3.Up());
  if (u.lengthSquared() < 0.001) u = Vector3.Cross(dir, Vector3.Right());
  u.normalize();
  const v = Vector3.Cross(dir, u).normalize();
  const angle = Math.random() * Math.PI * 2;
  const r = Math.tan(halfAngle) * Math.sqrt(Math.random());
  return dir
    .add(u.scale(Math.cos(angle) * r))
    .add(v.scale(Math.sin(angle) * r))
    .normalize();
}
