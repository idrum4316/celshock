/**
 * GrenadeSystem.ts — Thrown grenades: the flight, the bounces, the fuse and the
 * blast, plus the fireball and embers it throws off.
 * Owns: the grenade pool, the blast pool and the ember pool. All three are
 * FIXED SIZE and allocated once — this is the same rule CombatSystem's tracers
 * follow, and for the same reason: a firefight must not allocate.
 *
 * This is the one thing in the game that is not hitscan, and everything here is
 * shaped by that:
 * - A grenade is integrated per frame and collides with ONE ray per grenade per
 *   frame, against `metadata.solid === true` — the same collider proxies
 *   bullets stop on, never the visuals. There are at most a handful in the air,
 *   so that ray is affordable where a per-bullet one would not be.
 * - The blast resolves at detonation against the target list the THROWER is
 *   handed (`hittablesFor`), so friendly fire is excluded by construction, the
 *   same way `CombatSystem.fire` excludes it. Nothing in here knows what a team
 *   is beyond passing one back out.
 * - Damage needs line of sight from the blast centre: one ray per victim inside
 *   the radius, which is bounded by how few things are ever that close.
 *
 * Everything cross-system leaves through callbacks wired in `Game` —
 * `onExploded` for the light, the sound and the camera, `onBlastHit` for the
 * scoreboard. This system imports no other system.
 */
import { Mesh, MeshBuilder, Ray, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import type { Team } from "../entities/Combatant";
import { addOutline, type CelMaterialFactory } from "../shaders/CelShader";
import { TerrainField } from "../world/TerrainField";
import type { Hittable } from "./CombatSystem";

/** One grenade in flight (or resting with its fuse running). */
interface Grenade {
  mesh: Mesh;
  /** The fuse tell — blinks faster as the fuse runs out. */
  pip: Mesh;
  vel: Vector3;
  /** Seconds of fuse left; <= 0 while the slot is free. */
  fuse: number;
  live: boolean;
  team: Team;
  /** Whether the player threw it — the scoreboard needs to know. */
  byPlayer: boolean;
  /** Set once it has settled, so a resting grenade stops paying for a ray. */
  resting: boolean;
}

/** One expanding fireball. */
interface Blast {
  mesh: Mesh;
  t: number;
}

/** One ember flung out of a blast. */
interface Ember {
  mesh: Mesh;
  vel: Vector3;
  t: number;
}

/** Scratch — the flight integrates every frame and must not allocate. */
const _step = new Vector3();
const _normal = new Vector3();
const _tangent = new Vector3();
const _launch = new Vector3();

export class GrenadeSystem {
  private grenades: Grenade[] = [];
  private blasts: Blast[] = [];
  private embers: Ember[] = [];
  /** Reused by the flight and the line-of-sight tests alike. */
  private readonly ray = new Ray(new Vector3(), new Vector3(0, -1, 0), 1);
  /** The map's floor, as a backstop under the collider proxies. */
  private terrain: TerrainField = new TerrainField();

  /**
   * Wired by Game: who this thrower is allowed to hurt. The same list
   * `CombatSystem.fire` is handed for a bullet, resolved at DETONATION rather
   * than at the throw — a grenade is in the air for seconds, and the roster it
   * goes off among is not the one it left the hand among.
   */
  hittablesFor: (team: Team) => Hittable[] = () => [];

  /**
   * Wired by Game: a grenade went off here. The light, the sound and the
   * camera's concussion all hang off this — none of them are this system's
   * business, and two of them are owned by systems it must not import.
   */
  onExploded: (at: Vector3) => void = () => {};

  /**
   * Wired by Game: the blast hurt someone. `killed` is whether it finished
   * them, `thrower` is the team to credit, and `byPlayer` separates the
   * player's own kills from their team's.
   */
  onBlastHit: (
    victim: Hittable,
    thrower: Team,
    byPlayer: boolean,
    killed: boolean,
  ) => void = () => {};

  constructor(
    private scene: Scene,
    mats: CelMaterialFactory,
  ) {
    const g = CONFIG.grenade;
    const body = mats.get("#3f4a33");
    const pipMat = mats.getEmissive("#ff5a4f");
    const fireMat = mats.getEmissive("#ffb45a");
    const emberMat = mats.getEmissive("#ffd07a");

    for (let i = 0; i < g.poolSize; i++) {
      const mesh = MeshBuilder.CreateSphere(
        `grenade${i}`,
        { diameter: g.radius * 2, segments: 6 },
        scene,
      );
      mesh.material = body;
      mesh.isVisible = false;
      // A grenade is a thing in the world, not a collider: it carries no
      // `solid` flag and no WorldBox, so nothing shoots it, walks into it or
      // treats it as cover — it is dressing with a timer.
      mesh.isPickable = false;
      const pip = MeshBuilder.CreateSphere(
        `grenadePip${i}`,
        { diameter: g.radius * 0.62, segments: 4 },
        scene,
      );
      pip.parent = mesh;
      // The pip has to stand proud of the body's outline shell or the ink
      // swallows it — the same rule the player's visor slit follows. At this
      // size that is a fine line, hence the deliberately thin outline below.
      pip.position.y = g.radius;
      pip.material = pipMat;
      pip.metadata = { noOutline: true };
      pip.isPickable = false;
      // Ink, or a dark green sphere in a night game is invisible against the
      // ground it is rolling across — which for the one object the player has
      // to notice arriving is the whole ball game.
      addOutline(mesh, 0.02);
      this.grenades.push({
        mesh,
        pip,
        vel: new Vector3(),
        fuse: 0,
        live: false,
        team: 0,
        byPlayer: false,
        resting: false,
      });
    }

    // One fireball per grenade would be a pool nobody can exhaust; a handful is
    // what "two blasts close together" actually needs.
    for (let i = 0; i < 6; i++) {
      const mesh = MeshBuilder.CreateSphere(
        `blast${i}`,
        { diameter: 2, segments: 8 },
        scene,
      );
      mesh.material = fireMat;
      mesh.metadata = { noOutline: true };
      mesh.isVisible = false;
      mesh.isPickable = false;
      this.blasts.push({ mesh, t: 0 });
    }

    for (let i = 0; i < g.emberCount * 3; i++) {
      const mesh = MeshBuilder.CreateBox(
        `ember${i}`,
        { width: 0.09, height: 0.09, depth: 0.22 },
        scene,
      );
      mesh.material = emberMat;
      mesh.metadata = { noOutline: true };
      mesh.isVisible = false;
      mesh.isPickable = false;
      this.embers.push({ mesh, vel: new Vector3(), t: 0 });
    }
  }

  /** Points the flight's floor backstop at the current map. */
  setTerrain(terrain: TerrainField): void {
    this.terrain = terrain;
  }

  /**
   * A throw along a look direction, tilted up by `throwLift`. The player's
   * path: you throw where you are looking, and aiming up throws further.
   *
   * Returns false when the pool is exhausted, and a caller that gets a false
   * must NOT spend a grenade on it — a count spent on something that never
   * arrives is the most confusing bug a player can be handed.
   */
  throwAlong(
    from: Vector3,
    dir: Vector3,
    team: Team,
    byPlayer: boolean,
  ): boolean {
    // Tilting a unit direction up by an angle and renormalising: cheaper than
    // building a rotation, and the axis is always world up.
    _launch.copyFrom(dir).normalize();
    _launch.y += Math.tan(CONFIG.grenade.throwLift);
    _launch.normalize().scaleInPlace(CONFIG.grenade.throwSpeed);
    return this.throwFrom(from, _launch, team, byPlayer);
  }

  /**
   * A throw aimed to LAND at `to`. The bots' path, and the reason the
   * ballistics live in here rather than in whoever is throwing: an AI that
   * wants a grenade on a position should say so and be told whether the arm
   * can make it, not do trigonometry of its own.
   *
   * The low arc of the standard solve: with `d` the horizontal distance and
   * `h` the rise, the launch angle satisfies
   * `tan A = (v^2 - sqrt(v^4 - g(g d^2 + 2 h v^2))) / (g d)`. A negative
   * discriminant means the throw simply cannot be made at `throwSpeed`, which
   * is exactly what the caller needs to hear — the alternative is a bot lobbing
   * grenades that land at its own feet. Low rather than high on purpose: a lob
   * spends longer in the air, which is longer for the target to walk out of it,
   * and it is the one that catches the eaves on the way over.
   */
  throwAt(from: Vector3, to: Vector3, team: Team, byPlayer: boolean): boolean {
    const cfg = CONFIG.grenade;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return false;
    const h = to.y - from.y;
    const v2 = cfg.throwSpeed * cfg.throwSpeed;
    const g = cfg.gravity;
    const disc = v2 * v2 - g * (g * d * d + 2 * h * v2);
    if (disc < 0) return false;
    const angle = Math.atan2(v2 - Math.sqrt(disc), g * d);
    const horizontal = Math.cos(angle) * cfg.throwSpeed;
    _launch.set(
      (dx / d) * horizontal,
      Math.sin(angle) * cfg.throwSpeed,
      (dz / d) * horizontal,
    );
    return this.throwFrom(from, _launch, team, byPlayer);
  }

  /** Claims a pool slot and puts the grenade in the air. */
  private throwFrom(
    from: Vector3,
    velocity: Vector3,
    team: Team,
    byPlayer: boolean,
  ): boolean {
    const slot = this.grenades.find((n) => !n.live);
    if (!slot) return false;
    slot.mesh.position.copyFrom(from);
    slot.vel.copyFrom(velocity);
    slot.fuse = CONFIG.grenade.fuse;
    slot.live = true;
    slot.resting = false;
    slot.team = team;
    slot.byPlayer = byPlayer;
    slot.mesh.rotation.set(
      Math.random() * 3,
      Math.random() * 3,
      Math.random() * 3,
    );
    slot.mesh.isVisible = true;
    slot.pip.isVisible = true;
    return true;
  }

  update(dt: number): void {
    const g = CONFIG.grenade;
    for (const n of this.grenades) {
      if (!n.live) continue;
      n.fuse -= dt;
      if (n.fuse <= 0) {
        this.detonate(n);
        continue;
      }
      // The tell: a pip that blinks faster the closer the fuse gets to zero, so
      // a grenade at your feet is readable without a timer on the HUD. It is
      // the only warning there is, and it has to be visible from the side a
      // grenade is most likely to arrive from — hence a separate mesh rather
      // than a colour change on a body the ink already darkens.
      const left = n.fuse / g.fuse;
      n.pip.isVisible =
        Math.sin((1 - left) * (1 - left) * 90) > 0 || left > 0.75;
      if (n.resting) continue;

      n.vel.y -= g.gravity * dt;
      n.vel.scaleToRef(dt, _step);
      const travel = _step.length();
      if (travel > 1e-5) {
        // One ray per grenade per frame, along the step and a body's radius
        // past it, so a fast grenade cannot tunnel through a wall between two
        // frames. Same `solid` filter as every other ray in the game.
        this.ray.origin.copyFrom(n.mesh.position);
        this.ray.direction.copyFrom(_step).scaleInPlace(1 / travel);
        this.ray.length = travel + g.radius;
        const hit = this.scene.pickWithRay(
          this.ray,
          (m) => !!m.metadata && m.metadata.solid === true,
        );
        const normal = hit?.hit && hit.pickedPoint ? hit.getNormal(true) : null;
        if (hit?.pickedPoint && normal) {
          _normal.copyFrom(normal);
          // The reported normal may point AWAY from the grenade — a collider's
          // back face, which is exactly what a grenade thrown at a wall from
          // inside a doorway finds. Bouncing off one of those drives it
          // straight through the wall it just hit.
          if (Vector3.Dot(_normal, this.ray.direction) > 0) {
            _normal.scaleInPlace(-1);
          }
          n.mesh.position
            .copyFrom(hit.pickedPoint)
            .addInPlace(_normal.scale(g.radius));
          this.bounce(n, _normal);
        } else {
          n.mesh.position.addInPlace(_step);
        }
      }

      // The floor as a backstop under the collider proxies. The terrain blocks
      // are `solid` and the ray above normally finds them, but a grenade that
      // slipped past one (a seam, a step taken from inside a face) has to end
      // up on the ground rather than falling out of the world with a live fuse.
      const floor = this.terrain.heightAt(n.mesh.position.x, n.mesh.position.z);
      if (n.mesh.position.y < floor + g.radius) {
        n.mesh.position.y = floor + g.radius;
        this.bounce(n, _normal.set(0, 1, 0));
      }

      // Tumble at a rate that reads off the speed, so a rolling grenade rolls
      // and a resting one is still.
      const speed = n.vel.length();
      if (!n.resting) {
        n.mesh.rotation.x += speed * dt * 2.4;
        n.mesh.rotation.z += speed * dt * 1.7;
      }
    }

    this.updateEffects(dt);
  }

  /**
   * Reflects a grenade off a surface. Restitution takes the normal component,
   * friction takes the tangential one, and a slow grenade sitting on something
   * flat is parked outright — a body that keeps micro-bouncing on a floor
   * never settles, and a grenade that never settles never stops paying for its
   * collision ray.
   */
  private bounce(n: Grenade, normal: Vector3): void {
    const g = CONFIG.grenade;
    const vn = Vector3.Dot(n.vel, normal);
    if (vn > 0) return; // already leaving the surface
    _tangent.copyFrom(n.vel).subtractInPlace(normal.scale(vn));
    n.vel
      .copyFrom(_tangent)
      .scaleInPlace(g.friction)
      .addInPlace(normal.scale(-vn * g.restitution));
    if (n.vel.length() < g.restSpeed && normal.y > 0.6) {
      n.vel.setAll(0);
      n.resting = true;
    }
  }

  /**
   * The blast: radial damage with a line-of-sight test, then the effects.
   *
   * Damage falls linearly from full inside `innerRadius` to nothing at
   * `blastRadius`, measured to the victim's CENTRE — the same point bullets are
   * tested against, so a crouched target is genuinely harder to catch with a
   * grenade in the same way it is harder to shoot.
   */
  private detonate(n: Grenade): void {
    const g = CONFIG.grenade;
    const at = n.mesh.position;
    n.live = false;
    n.mesh.isVisible = false;
    n.pip.isVisible = false;

    for (const target of this.hittablesFor(n.team)) {
      if (target.invulnerable) continue;
      const dist = Vector3.Distance(at, target.center);
      if (dist > g.blastRadius) continue;
      if (!this.visible(at, target.center)) continue;
      const falloff =
        dist <= g.innerRadius
          ? 1
          : 1 - (dist - g.innerRadius) / (g.blastRadius - g.innerRadius);
      const killed = target.takeDamage(g.damage * falloff, at);
      this.onBlastHit(target, n.team, n.byPlayer, killed);
    }

    this.spawnBlast(at);
    // The light, the sound and the camera's concussion belong to systems this
    // one may not import, so they leave as one event with a position on it.
    this.onExploded(at.clone());
  }

  /** Fragments stop in walls. One ray per victim already inside the radius. */
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

  private spawnBlast(at: Vector3): void {
    const g = CONFIG.grenade;
    const blast = this.blasts.find((b) => b.t <= 0) ?? this.blasts[0];
    blast.mesh.position.copyFrom(at);
    blast.mesh.scaling.setAll(0.4);
    blast.mesh.isVisible = true;
    blast.t = g.blastVisualTime;

    // Embers, thrown out of the blast on an even-ish spread rather than a
    // random one — a handful of random directions clumps, and a clump reads as
    // one lump of debris instead of as a burst.
    let spawned = 0;
    for (const e of this.embers) {
      if (spawned >= g.emberCount) break;
      if (e.t > 0) continue;
      const yaw = ((spawned + Math.random()) / g.emberCount) * Math.PI * 2;
      const lift = 0.25 + Math.random() * 0.9;
      const speed = g.emberSpeed * (0.5 + Math.random() * 0.7);
      e.vel
        .set(Math.sin(yaw), lift, Math.cos(yaw))
        .normalize()
        .scaleInPlace(speed);
      e.mesh.position.copyFrom(at);
      e.mesh.isVisible = true;
      e.t = g.emberLife * (0.6 + Math.random() * 0.6);
      spawned++;
    }
  }

  private updateEffects(dt: number): void {
    const g = CONFIG.grenade;
    for (const b of this.blasts) {
      if (b.t <= 0) continue;
      b.t -= dt;
      if (b.t <= 0) {
        b.mesh.isVisible = false;
        continue;
      }
      // Expands fast and fades faster: the flash is the first two frames and
      // the rest is the ball of it going out.
      const age = 1 - b.t / g.blastVisualTime;
      b.mesh.scaling.setAll(0.4 + g.blastVisualRadius * Math.sqrt(age));
      b.mesh.visibility = Math.max(0, 1 - age * age);
    }
    for (const e of this.embers) {
      if (e.t <= 0) continue;
      e.t -= dt;
      if (e.t <= 0) {
        e.mesh.isVisible = false;
        continue;
      }
      e.vel.y -= g.emberGravity * dt;
      e.mesh.position.addInPlace(_step.copyFrom(e.vel).scaleInPlace(dt));
      e.mesh.rotation.x += dt * 9;
      e.mesh.visibility = Math.min(1, e.t / (g.emberLife * 0.4));
    }
  }

  /**
   * Drops everything in flight. Called wherever the map under it is thrown
   * away — a grenade whose fuse survives a round change would go off in the
   * next one, over terrain that no longer exists.
   */
  reset(): void {
    for (const n of this.grenades) {
      n.live = false;
      n.resting = false;
      n.mesh.isVisible = false;
      n.pip.isVisible = false;
    }
    for (const b of this.blasts) {
      b.t = 0;
      b.mesh.isVisible = false;
    }
    for (const e of this.embers) {
      e.t = 0;
      e.mesh.isVisible = false;
    }
  }
}
