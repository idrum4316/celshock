/**
 * CombatSystem.ts — Hitscan for EVERYONE (player and bots share fire()), plus
 * pooled tracer/spark effects.
 * Invariants: fire() takes the shooter's target list — friendly fire is
 * excluded by the caller's list construction, never by a team check inside.
 * Wall ray filters metadata.solid === true and caps the shot; a target sphere
 * farther than the first solid hit does not count (a bot embedded in a prop is
 * unshootable — movement bugs become combat bugs). Tracers/sparks are
 * fixed-size pools: add new effects to a pool, NEVER allocate per shot.
 * A tracer is a short streak flown from muzzle to impact over several frames,
 * NOT a muzzle-to-impact beam — the hit is resolved instantly regardless, so
 * the flight is presentation only and must never gate damage. The impact spark
 * rides the streak and spawns on arrival: it is the one thing here that waits,
 * because an impact seen before its round lands is what makes a slowed tracer
 * read as fake.
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
  /** `from` is where the shot started, for whoever wants to face the shooter. */
  takeDamage(amount: number, from?: Vector3): boolean;
}

/** Outcome of one shot: who it hit, whether that killed them, and if it stopped on geometry. */
export interface ShotResult {
  target: Hittable | null;
  killed: boolean;
  hitWall: boolean;
}

interface Tracer {
  mesh: Mesh;
  /** Muzzle, and the unit direction to the impact point. */
  from: Vector3;
  dir: Vector3;
  /** Metres from muzzle to whatever the round stopped on. */
  dist: number;
  /** Metres the leading edge has flown. The tail trails it by `tracerLength`. */
  head: number;
  alive: boolean;
  /** Where the round stopped — `from + dir * dist`, kept for the spark. */
  impact: Vector3;
  /**
   * The impact spark this round owes, spawned when the streak's head arrives
   * and nulled so it fires once. Null for a round that stopped on nothing.
   */
  sparkColor: string | null;
}

interface Spark {
  mesh: Mesh;
  t: number;
}

/** Reused by the tracer update so a live streak costs no allocation. */
const SCRATCH = new Vector3();

/**
 * Hitscan shooting and the transient effects it throws off. Tracers and
 * sparks are object-pooled.
 *
 * Every combatant is hitscan — the player and both bot teams alike — so there
 * is no projectile pool to thrash in a 16-bot firefight.
 */
export class CombatSystem {
  private tracers: Tracer[] = [];
  private sparks: Spark[] = [];

  /**
   * Wired by Game: a round passed within `suppressRadius` of `near` without
   * hitting it. `from` is the shooter's origin.
   *
   * A callback rather than a direct call because this system must not know
   * about bots — it fires the player's rounds too, and the player is a
   * perfectly good thing to suppress later.
   */
  onNearMiss: (near: Hittable, from: Vector3) => void = () => {};

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
      this.tracers.push({
        mesh,
        from: Vector3.Zero(),
        dir: Vector3.Forward(),
        dist: 0,
        head: 0,
        alive: false,
        impact: Vector3.Zero(),
        sparkColor: null,
      });
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
   *
   * `range` comes from the shooter rather than from CONFIG: the player's two
   * weapons carry different distances, and this used to read the one rifle's
   * out of the config directly. It bounds the wall pick behind `hitWall` and
   * the near-miss sweep as well as the damage, so it is the whole reach of
   * the round, not just where the tracer stops.
   */
  fire(
    origin: Vector3,
    aimDir: Vector3,
    spread: number,
    damage: number,
    muzzle: Vector3,
    targets: Hittable[],
    range: number,
  ): ShotResult {
    const dir = jitterDirection(aimDir, spread);

    // Wall/prop/floor hit distance caps the shot.
    const ray = new Ray(origin, dir, range);
    const wallPick = this.scene.pickWithRay(
      ray,
      (m) => !!m.metadata && m.metadata.solid === true,
    );
    let hitDist = wallPick && wallPick.hit ? wallPick.distance : range;
    const hitWall = !!(wallPick && wallPick.hit);

    // Nearest target sphere along the ray, if closer than the wall. The same
    // pass also notes anyone the round merely went *past*: the sphere test is
    // already being paid for, so widening it by `suppressRadius` costs one
    // extra compare per target and gives the AI a suppression signal that would
    // otherwise need a system of its own.
    let hitTarget: Hittable | null = null;
    const graze = CONFIG.bots.perception.suppressRadius;
    for (const target of targets) {
      if (target.invulnerable) continue;
      const d = raySphere(origin, dir, target.center, target.hitRadius);
      if (d !== null && d < hitDist) {
        hitDist = d;
        hitTarget = target;
      } else if (d === null) {
        const near = raySphere(origin, dir, target.center, target.hitRadius + graze);
        // Only counts in front of the shooter and short of whatever stopped the
        // round — a bullet that buried itself in a wall did not crack past
        // someone standing beyond it.
        if (near !== null && near < hitDist) this.onNearMiss(target, origin);
      }
    }

    const hitPoint = origin.add(dir.scale(hitDist));
    let killed = false;
    if (hitTarget) killed = hitTarget.takeDamage(damage, origin);

    // The DAMAGE is instant — everyone is hitscan and nothing below may gate
    // it. The spark is not: it is handed to the tracer and spawned when the
    // streak's head arrives, so the impact is not seen before the round that
    // caused it gets there. At `tracerSpeed` that is up to ~0.4 s at the range
    // cap, which is exactly how long the tell was.
    const spark = hitTarget ? "#ffe680" : hitWall ? "#c8c8c8" : null;
    this.spawnTracer(muzzle, hitPoint, spark);
    return { target: hitTarget, killed, hitWall };
  }

  update(dt: number): void {
    // Tracers: a fixed-length streak flying from the muzzle to the impact
    // point. The head runs out to `dist` and stops there; the tail keeps going
    // until it catches up, so the streak emerges from the barrel and is eaten
    // by whatever the round hit rather than popping in and out whole.
    const fx = CONFIG.effects;
    for (const tr of this.tracers) {
      if (!tr.alive) continue;
      tr.head += fx.tracerSpeed * dt;
      if (tr.sparkColor !== null && tr.head >= tr.dist) {
        this.spawnSpark(tr.impact, tr.sparkColor);
        tr.sparkColor = null;
      }
      const tail = tr.head - fx.tracerLength;
      if (tail >= tr.dist) {
        tr.alive = false;
        tr.mesh.isVisible = false;
        continue;
      }
      const back = Math.max(tail, 0);
      const len = Math.max(Math.min(tr.head, tr.dist) - back, 0.01);
      // Pooled effect: no per-frame allocation.
      tr.dir.scaleToRef(back + len / 2, SCRATCH);
      tr.mesh.position.copyFrom(tr.from).addInPlace(SCRATCH);
      tr.mesh.scaling.set(1, len, 1);
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
      tr.alive = false;
      tr.sparkColor = null;
      tr.mesh.isVisible = false;
    }
    for (const s of this.sparks) {
      s.t = 0;
      s.mesh.isVisible = false;
    }
  }

  /**
   * `sparkColor` is the impact this round owes on arrival, or null if it
   * stopped on nothing. A stolen slot (exhausted pool) drops its pending spark
   * with the streak it belonged to, which is right: an impact whose tracer was
   * recycled would pop with nothing visibly arriving.
   */
  private spawnTracer(
    from: Vector3,
    to: Vector3,
    sparkColor: string | null,
  ): void {
    const tr = this.tracers.find((t) => !t.alive) ?? this.tracers[0];
    const delta = to.subtract(from);
    const dist = Math.max(delta.length(), 0.01);
    delta.scaleInPlace(1 / dist);
    tr.from.copyFrom(from);
    tr.dir.copyFrom(delta);
    tr.dist = dist;
    tr.head = 0;
    tr.alive = true;
    tr.impact.copyFrom(to);
    tr.sparkColor = sparkColor;
    // The direction is fixed for the whole flight, so this is set once here and
    // only `update` moves the streak along it.
    Quaternion.FromUnitVectorsToRef(
      Vector3.Up(),
      delta,
      tr.mesh.rotationQuaternion!,
    );
    tr.mesh.position.copyFrom(from);
    tr.mesh.scaling.set(1, 0.01, 1);
    tr.mesh.isVisible = true;
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
