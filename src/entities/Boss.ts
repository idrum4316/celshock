import { Material, Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { addOutline, CelMaterialFactory } from "../shaders/CelShader";
import { animateBossRig, buildBossRig, type BossRig } from "./BossModels";
import type { BossType } from "../themes/types";
import type { AICtx } from "./Enemy";

type BossState =
  | "chase"
  | "windup"
  | "burst"
  | "dashWindup"
  | "dash"
  | "surface"
  | "submerging"
  | "underground"
  | "emerging"
  | "dying";

/**
 * Theme boss. One class, three distinct fight patterns:
 * - `slam`   (Treant): slow pursuit + telegraphed ground-slam AOE; summons
 *             minions at half health. Jump to dodge the slam.
 * - `burst`  (Cybernetic Titan): keeps range, fires projectile bursts, and
 *             adds a dash-charge below 60% health.
 * - `burrow` (Sand Worm): surfaces to spit, then submerges (invulnerable),
 *             stalks the player underground, and erupts in an AOE.
 */
export class Boss {
  root: Mesh;
  type: BossType;
  hp: number;
  maxHp: number;
  dead = false;
  justDied = false;
  invulnerable = false;
  hitRadius: number;

  private state: BossState;
  private t = 0;
  private attackCd = 2;
  private dashCd = 4;
  private dashDir = new Vector3(0, 0, 1);
  private burstLeft = 0;
  private burstT = 0;
  private touchCd = 0;
  private minionsSpawned = false;
  private lifeT = 0;
  private flashT = 0;
  private parts: { mesh: Mesh; mat: Material }[] = [];
  private whiteMat: Material;
  private groundY: number;
  private marker: Mesh | null = null;
  private markerPos = new Vector3();
  private rig: BossRig;
  /** Smoothed travel speed (0..1 of top speed) driving the gait. */
  private moving = 0;
  private lastPos = new Vector3();

  constructor(
    scene: Scene,
    mats: CelMaterialFactory,
    type: BossType,
    pos: Vector3,
  ) {
    this.type = type;
    this.hp = type.health;
    this.maxHp = type.health;
    this.whiteMat = mats.get("#ffffff");
    const s = type.scale;

    this.rig = buildBossRig(scene, mats, type);
    this.root = this.rig.root;
    this.groundY = this.rig.groundY * s;
    this.hitRadius = this.rig.hitRadius * s;

    if (type.pattern === "burrow") {
      this.state = "surface";
      this.t = 4;

      // Dust marker that tracks the worm while it is underground.
      this.marker = MeshBuilder.CreateCylinder(
        "wormMarker",
        { height: 0.12, diameter: 3.2, tessellation: 20 },
        scene,
      );
      this.marker.material = mats.getEmissive(type.eyeColor);
      this.marker.visibility = 0.55;
      this.marker.isVisible = false;
      this.marker.metadata = { noOutline: true };
    } else {
      this.state = "chase";
    }

    this.root.scaling.setAll(s);
    this.root.position = new Vector3(pos.x, this.groundY, pos.z);
    this.lastPos.copyFrom(this.root.position);
    addOutline(this.root, 0.06);

    // Emissive parts (eyes, core, throat) keep glowing through hit flashes.
    for (const child of this.root.getChildMeshes()) {
      const isEmissive = child.metadata && child.metadata.noOutline === true;
      if (child instanceof Mesh && child.material && !isEmissive) {
        this.parts.push({ mesh: child, mat: child.material });
      }
    }
  }

  get center(): Vector3 {
    return this.root.position;
  }

  get hpFraction(): number {
    return Math.max(0, this.hp / this.maxHp);
  }

  update(dt: number, ctx: AICtx): void {
    this.lifeT += dt;
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.setFlash(this.flashT > 0);
    }

    if (this.state === "dying") {
      this.t -= dt;
      const k = Math.max(0, this.t / 1.2);
      // Buckles forward as its lights go out, then sinks into the floor.
      if (this.rig.body) this.rig.body.rotation.x = (1 - k) * 1.2;
      for (const glow of this.rig.glows) glow.scaling.setAll(Math.max(0.04, k));
      this.root.scaling.setAll(this.type.scale * (0.35 + 0.65 * k));
      this.root.position.y = this.groundY * k - (1 - k) * 1.2;
      if (this.t <= 0) this.dead = true;
      return;
    }

    // Summon minions once at half health (slam pattern only).
    if (
      this.type.pattern === "slam" &&
      !this.minionsSpawned &&
      this.hp < this.maxHp * 0.5
    ) {
      this.minionsSpawned = true;
      ctx.sfx.bossRoar();
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        ctx.spawnMinion(
          this.root.position.add(new Vector3(Math.cos(a) * 3.5, 0, Math.sin(a) * 3.5)),
        );
      }
    }

    switch (this.type.pattern) {
      case "slam":
        this.updateSlam(dt, ctx);
        break;
      case "burst":
        this.updateBurst(dt, ctx);
        break;
      case "burrow":
        this.updateBurrow(dt, ctx);
        break;
    }

    this.clampToBounds(ctx);

    // Pose the rig: gait from how far it actually moved, telegraph from the
    // pattern's current state.
    const travelled = Vector3.Distance(this.root.position, this.lastPos);
    this.lastPos.copyFrom(this.root.position);
    const target =
      dt > 0 ? Math.min(1, travelled / dt / Math.max(this.type.speed, 0.001)) : 0;
    this.moving += (target - this.moving) * Math.min(1, dt * 6);
    animateBossRig(
      this.rig,
      this.type.pattern,
      this.lifeT,
      this.moving,
      this.windupFraction(),
    );
  }

  /** 0..1 telegraph progress: arms rear back, cannons heat, maws unhinge. */
  private windupFraction(): number {
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    switch (this.state) {
      case "windup":
        return clamp01(1 - this.t / (this.type.pattern === "slam" ? 0.9 : 0.5));
      case "dashWindup":
        return clamp01(1 - this.t / 0.6);
      case "burst":
      case "dash":
        return 1;
      case "emerging":
        return clamp01(1 - this.t / 0.45);
      case "surface":
        // The worm's maw opens over the last half second before it spits.
        return clamp01(1 - this.attackCd / 0.5);
      default:
        return 0;
    }
  }

  // --- Treant ---
  private updateSlam(dt: number, ctx: AICtx): void {
    const dist = this.distToPlayer(ctx);
    this.attackCd -= dt;
    this.touchCd -= dt;

    if (this.state === "chase") {
      this.moveToward(ctx.playerPos, this.type.speed, dt);
      this.facePoint(ctx.playerPos);
      this.contactDamage(ctx, dist);
      const radius = this.type.aoeRadius ?? 6;
      if (this.attackCd <= 0 && dist < radius * 0.9) {
        this.state = "windup";
        this.t = 0.9;
      }
    } else if (this.state === "windup") {
      this.t -= dt;
      this.root.scaling.setAll(this.type.scale * (1 + 0.12 * Math.sin((0.9 - this.t) * 6)));
      if (this.t <= 0) {
        this.root.scaling.setAll(this.type.scale);
        const radius = this.type.aoeRadius ?? 6;
        ctx.shockwave(
          new Vector3(this.root.position.x, 0.2, this.root.position.z),
          radius,
          this.type.accentColor,
        );
        ctx.sfx.boom();
        // Grounded players in the ring take damage — jump to dodge.
        if (ctx.playerGrounded && this.distToPlayer(ctx) < radius) {
          ctx.damagePlayer(this.type.aoeDamage ?? 30);
        }
        this.attackCd = this.type.attackCooldown;
        this.state = "chase";
      }
    }
  }

  // --- Cybernetic Titan ---
  private updateBurst(dt: number, ctx: AICtx): void {
    const dist = this.distToPlayer(ctx);
    this.attackCd -= dt;
    this.touchCd -= dt;
    if (this.hp < this.maxHp * 0.6) this.dashCd -= dt;

    // Idle hover bob.
    if (this.state !== "dash") {
      this.root.position.y = this.groundY + Math.sin(this.lifeT * 1.8) * 0.25;
    }

    if (this.state === "chase") {
      // Hold a mid-range firing band.
      const toPlayer = ctx.playerPos.subtract(this.root.position);
      toPlayer.y = 0;
      const d = toPlayer.length();
      if (d > 15) this.moveToward(ctx.playerPos, this.type.speed, dt);
      else if (d < 8) this.moveToward(ctx.playerPos, -this.type.speed * 0.8, dt);
      else {
        const side = new Vector3(-toPlayer.z, 0, toPlayer.x).normalize();
        const strafe = Math.sin(this.lifeT * 0.9) > 0 ? 1 : -1;
        this.root.position.addInPlace(side.scale(strafe * this.type.speed * 0.6 * dt));
      }
      this.facePoint(ctx.playerPos);
      this.contactDamage(ctx, dist);

      if (this.dashCd <= 0 && this.hp < this.maxHp * 0.6) {
        this.state = "dashWindup";
        this.t = 0.6;
        ctx.sfx.bossRoar();
      } else if (this.attackCd <= 0) {
        this.state = "windup";
        this.t = 0.5;
      }
    } else if (this.state === "windup") {
      this.t -= dt;
      this.facePoint(ctx.playerPos);
      if (this.t <= 0) {
        this.state = "burst";
        this.burstLeft = 3;
        this.burstT = 0;
      }
    } else if (this.state === "burst") {
      this.burstT -= dt;
      this.facePoint(ctx.playerPos);
      if (this.burstT <= 0 && this.burstLeft > 0) {
        this.burstLeft -= 1;
        this.burstT = 0.16;
        const from = this.root.position.add(new Vector3(0, 0.3, 0));
        const target = ctx.playerPos.add(new Vector3(0, 1, 0));
        ctx.fireProjectile(
          from,
          target.subtract(from).normalize(),
          this.type.projectileSpeed ?? 20,
          this.type.contactDamage * 0.5,
          this.type.projectileColor ?? "#ff2e97",
        );
      }
      if (this.burstLeft <= 0 && this.burstT <= 0) {
        this.attackCd = this.type.attackCooldown;
        this.state = "chase";
      }
    } else if (this.state === "dashWindup") {
      this.t -= dt;
      this.facePoint(ctx.playerPos);
      if (this.t <= 0) {
        const d = ctx.playerPos.subtract(this.root.position);
        d.y = 0;
        this.dashDir = d.normalize();
        this.state = "dash";
        this.t = 0.8;
      }
    } else if (this.state === "dash") {
      this.t -= dt;
      this.root.position.addInPlace(this.dashDir.scale(this.type.speed * 4.5 * dt));
      if (this.distToPlayer(ctx) < 2.4) {
        ctx.damagePlayer(this.type.contactDamage);
        this.t = 0;
      }
      if (this.t <= 0) {
        this.dashCd = 6;
        this.state = "chase";
      }
    }
  }

  // --- Sand Worm ---
  private updateBurrow(dt: number, ctx: AICtx): void {
    this.attackCd -= dt;
    this.touchCd -= dt;

    if (this.state === "surface") {
      this.t -= dt;
      this.facePoint(ctx.playerPos);
      this.root.position.y = this.groundY + Math.sin(this.lifeT * 2.5) * 0.2;
      this.contactDamage(ctx, this.distToPlayer(ctx));
      if (this.attackCd <= 0) {
        const from = this.root.position.add(new Vector3(0, 1.2 * this.type.scale, 0));
        const target = ctx.playerPos.add(new Vector3(0, 0.8, 0));
        ctx.fireProjectile(
          from,
          target.subtract(from).normalize(),
          this.type.projectileSpeed ?? 15,
          this.type.contactDamage * 0.6,
          this.type.projectileColor ?? "#e0c37a",
        );
        this.attackCd = this.type.attackCooldown;
      }
      if (this.t <= 0) {
        this.state = "submerging";
        this.t = 0.5;
        this.invulnerable = true;
      }
    } else if (this.state === "submerging") {
      this.t -= dt;
      this.root.position.y = this.groundY - (1 - this.t / 0.5) * (this.groundY + 3);
      if (this.t <= 0) {
        this.state = "underground";
        this.t = 2.6;
        this.markerPos.copyFrom(this.root.position);
        if (this.marker) this.marker.isVisible = true;
      }
    } else if (this.state === "underground") {
      this.t -= dt;
      // Stalk the player from below — the dust ring gives their only warning.
      const to = ctx.playerPos.subtract(this.markerPos);
      to.y = 0;
      const d = to.length();
      if (d > 0.1) {
        this.markerPos.addInPlace(to.scale((this.type.speed * 1.7 * dt) / d));
      }
      if (this.marker) {
        this.marker.position.set(this.markerPos.x, 0.08, this.markerPos.z);
      }
      if (this.t <= 0 || d < 0.6) {
        this.state = "emerging";
        this.t = 0.45;
        this.root.position.set(this.markerPos.x, -3, this.markerPos.z);
        if (this.marker) this.marker.isVisible = false;
      }
    } else if (this.state === "emerging") {
      this.t -= dt;
      const k = 1 - Math.max(0, this.t) / 0.45;
      this.root.position.y = -3 + (this.groundY + 3) * k;
      if (this.t <= 0) {
        this.invulnerable = false;
        const radius = this.type.aoeRadius ?? 5;
        ctx.shockwave(
          new Vector3(this.root.position.x, 0.2, this.root.position.z),
          radius,
          this.type.accentColor,
        );
        ctx.sfx.boom();
        if (ctx.playerGrounded && this.distToPlayer(ctx) < radius) {
          ctx.damagePlayer(this.type.aoeDamage ?? 28);
        }
        this.state = "surface";
        this.t = 4;
        this.attackCd = 0.6;
      }
    }
  }

  // --- shared helpers ---

  private contactDamage(ctx: AICtx, dist: number): void {
    if (dist < this.hitRadius + 0.8 && this.touchCd <= 0) {
      ctx.damagePlayer(this.type.contactDamage * 0.5);
      this.touchCd = 1.0;
    }
  }

  private distToPlayer(ctx: AICtx): number {
    const d = ctx.playerPos.subtract(this.root.position);
    d.y = 0;
    return d.length();
  }

  private moveToward(target: Vector3, speed: number, dt: number): void {
    const to = target.subtract(this.root.position);
    to.y = 0;
    const d = to.length();
    if (d > 0.1) {
      this.root.position.addInPlace(to.scale((speed * dt) / d));
    }
  }

  private facePoint(p: Vector3): void {
    const dx = p.x - this.root.position.x;
    const dz = p.z - this.root.position.z;
    this.root.rotation.y = Math.atan2(dx, dz);
  }

  private clampToBounds(ctx: AICtx): void {
    const mx = ctx.bounds.width / 2 - 2;
    const mz = ctx.bounds.depth / 2 - 2;
    this.root.position.x = Math.max(-mx, Math.min(mx, this.root.position.x));
    this.root.position.z = Math.max(-mz, Math.min(mz, this.root.position.z));
  }

  /** Returns true if this damage killed the boss. */
  takeDamage(amount: number): boolean {
    if (this.state === "dying" || this.invulnerable) return false;
    this.hp -= amount;
    this.flashT = 0.08;
    this.setFlash(true);
    if (this.hp <= 0) {
      this.state = "dying";
      this.t = 1.2;
      this.justDied = true;
      this.invulnerable = true;
      this.setFlash(false);
      if (this.marker) this.marker.isVisible = false;
      return true;
    }
    return false;
  }

  private setFlash(on: boolean): void {
    for (const part of this.parts) {
      part.mesh.material = on ? this.whiteMat : part.mat;
    }
  }

  dispose(): void {
    this.marker?.dispose();
    this.root.dispose(false, false);
  }
}
