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

/** Anything the player's hitscan can damage (enemies and the boss). */
export interface Hittable {
  center: Vector3;
  hitRadius: number;
  invulnerable?: boolean;
  takeDamage(amount: number): boolean;
}

interface Tracer {
  mesh: Mesh;
  life: number;
}

interface Projectile {
  mesh: Mesh;
  dir: Vector3;
  speed: number;
  damage: number;
  life: number;
  active: boolean;
}

interface Spark {
  mesh: Mesh;
  t: number;
}

interface Shockwave {
  mesh: Mesh;
  t: number;
  maxRadius: number;
}

/**
 * Damage, hitscan shooting, and all transient combat effects.
 * Tracers, sparks, and enemy projectiles are object-pooled.
 */
export class CombatSystem {
  /** Current arena bounds; projectiles despawn against the walls. */
  bounds = { width: 40, depth: 40 };
  /** Wired by Game: applies damage to the player (respects game state). */
  onPlayerHit: (damage: number) => void = () => {};

  private tracers: Tracer[] = [];
  private projectiles: Projectile[] = [];
  private sparks: Spark[] = [];
  private shockwaves: Shockwave[] = [];

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
    for (let i = 0; i < fx.projectilePoolSize; i++) {
      const mesh = MeshBuilder.CreateSphere(
        `proj${i}`,
        { diameter: 0.38, segments: 6 },
        scene,
      );
      mesh.isVisible = false;
      mesh.isPickable = false;
      this.projectiles.push({
        mesh,
        dir: new Vector3(),
        speed: 0,
        damage: 0,
        life: 0,
        active: false,
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
   * Player hitscan shot from the camera through the crosshair.
   * Returns "enemy" on a hit (for the hitmarker), "wall"/"miss" otherwise.
   */
  playerFire(
    camPos: Vector3,
    aimDir: Vector3,
    spread: number,
    damage: number,
    muzzle: Vector3,
    targets: Hittable[],
  ): "enemy" | "wall" | "miss" {
    const dir = jitterDirection(aimDir, spread);
    const range = CONFIG.weapon.range;

    // Wall/prop/floor hit distance caps the shot.
    const ray = new Ray(camPos, dir, range);
    const wallPick = this.scene.pickWithRay(
      ray,
      (m) => !!m.metadata && m.metadata.solid === true,
    );
    let hitDist = wallPick && wallPick.hit ? wallPick.distance : range;
    let result: "enemy" | "wall" | "miss" =
      wallPick && wallPick.hit ? "wall" : "miss";

    // Nearest enemy sphere along the ray, if closer than the wall.
    let hitTarget: Hittable | null = null;
    for (const target of targets) {
      if (target.invulnerable) continue;
      const d = raySphere(camPos, dir, target.center, target.hitRadius);
      if (d !== null && d < hitDist) {
        hitDist = d;
        hitTarget = target;
      }
    }

    const hitPoint = camPos.add(dir.scale(hitDist));
    if (hitTarget) {
      hitTarget.takeDamage(damage);
      result = "enemy";
      this.spawnSpark(hitPoint, "#ffe680");
    } else if (result === "wall") {
      this.spawnSpark(hitPoint, "#c8c8c8");
    }

    this.spawnTracer(muzzle, hitPoint);
    return result;
  }

  /** Fires a themed enemy projectile (pooled). */
  fireEnemyProjectile(
    from: Vector3,
    dir: Vector3,
    speed: number,
    damage: number,
    colorHex: string,
  ): void {
    const p =
      this.projectiles.find((x) => !x.active) ?? this.projectiles[0];
    p.mesh.position.copyFrom(from);
    p.mesh.material = this.mats.getEmissive(colorHex);
    p.mesh.isVisible = true;
    p.dir.copyFrom(dir);
    p.speed = speed;
    p.damage = damage;
    p.life = 5;
    p.active = true;
  }

  /** Expanding ground ring used to telegraph boss AOE hits. */
  shockwave(center: Vector3, radius: number, colorHex: string): void {
    const mesh = MeshBuilder.CreateTorus(
      "shockwave",
      { diameter: 1, thickness: 0.25, tessellation: 28 },
      this.scene,
    );
    mesh.position.copyFrom(center);
    mesh.material = this.mats.getEmissive(colorHex);
    mesh.isPickable = false;
    this.shockwaves.push({ mesh, t: 0, maxRadius: radius });
  }

  update(dt: number, playerPos: Vector3): void {
    // Tracers: stretch briefly then vanish.
    for (const tr of this.tracers) {
      if (tr.life > 0) {
        tr.life -= dt;
        if (tr.life <= 0) tr.mesh.isVisible = false;
      }
    }

    // Enemy projectiles: move, hit the player, or despawn at walls.
    const mx = this.bounds.width / 2 - 0.6;
    const mz = this.bounds.depth / 2 - 0.6;
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.life -= dt;
      p.mesh.position.addInPlace(p.dir.scale(p.speed * dt));
      const pos = p.mesh.position;
      const toPlayer = playerPos.add(new Vector3(0, 0.9, 0)).subtract(pos);
      if (toPlayer.length() < 0.85) {
        this.onPlayerHit(p.damage);
        this.deactivate(p);
        continue;
      }
      if (
        p.life <= 0 ||
        pos.y < 0 ||
        Math.abs(pos.x) > mx ||
        Math.abs(pos.z) > mz
      ) {
        this.deactivate(p);
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

    // Shockwaves: ring expands to the AOE radius and fades.
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const w = this.shockwaves[i];
      w.t += dt;
      const k = Math.min(1, w.t / 0.45);
      const d = Math.max(0.5, k * w.maxRadius * 2);
      w.mesh.scaling.set(d, 1, d);
      w.mesh.visibility = 1 - k;
      if (k >= 1) {
        w.mesh.dispose();
        this.shockwaves.splice(i, 1);
      }
    }
  }

  /** Clears transient effects between rooms/runs. */
  clearTransient(): void {
    for (const p of this.projectiles) this.deactivate(p);
    for (const tr of this.tracers) {
      tr.life = 0;
      tr.mesh.isVisible = false;
    }
    for (const s of this.sparks) {
      s.t = 0;
      s.mesh.isVisible = false;
    }
    for (const w of this.shockwaves) w.mesh.dispose();
    this.shockwaves.length = 0;
  }

  private deactivate(p: Projectile): void {
    p.active = false;
    p.mesh.isVisible = false;
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
