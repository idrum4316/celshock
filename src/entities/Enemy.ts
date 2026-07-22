import { Material, Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { addOutline, CelMaterialFactory } from "../shaders/CelShader";
import type { EnemyType } from "../themes/types";
import type { Sfx } from "../core/Sfx";

/** Everything enemy/boss AI needs from the outside world, rebuilt each frame. */
export interface AICtx {
  playerPos: Vector3;
  playerGrounded: boolean;
  damagePlayer(amount: number): void;
  fireProjectile(
    from: Vector3,
    dir: Vector3,
    speed: number,
    damage: number,
    colorHex: string,
  ): void;
  shockwave(center: Vector3, radius: number, colorHex: string): void;
  spawnMinion(pos: Vector3): void;
  bounds: { width: number; depth: number };
  obstacles: { x: number; z: number; r: number }[];
  sfx: Sfx;
}

type EnemyState = "spawning" | "chasing" | "attacking" | "dying";

/**
 * Themed enemy with a small FSM: spawn-in -> chase/strafe -> telegraphed
 * attack -> death. Meshes are built procedurally from the type's body
 * archetype so every theme gets distinct placeholder silhouettes.
 */
export class Enemy {
  root: Mesh;
  type: EnemyType;
  hp: number;
  hitRadius: number;
  state: EnemyState = "spawning";
  /** Fully finished dying — ready to be disposed by the EnemySystem. */
  dead = false;
  /** Set on the frame the enemy dies; consumed by the EnemySystem. */
  justDied = false;

  private t = 0.4; // current state timer
  private lifeT = Math.random() * Math.PI * 2; // desync idle wobble
  private attackCooldown = 1 + Math.random(); // grace period after spawn
  private strafeDir = Math.random() < 0.5 ? -1 : 1;
  private strafeT = 1;
  private flashT = 0;
  private parts: { mesh: Mesh; mat: Material }[] = [];
  private groundY: number;
  private whiteMat: Material;

  constructor(
    scene: Scene,
    mats: CelMaterialFactory,
    type: EnemyType,
    pos: Vector3,
  ) {
    this.type = type;
    this.hp = type.health;
    this.whiteMat = mats.get("#ffffff");

    const s = type.scale;
    this.hitRadius = 0.9 * s;

    switch (type.body) {
      case "quad": {
        // Low, elongated body (wolves, scorpions).
        this.root = MeshBuilder.CreateBox(
          `enemy-${type.name}`,
          { width: 0.7 * s, height: 0.6 * s, depth: 1.5 * s },
          scene,
        );
        const head = MeshBuilder.CreateBox(
          "head",
          { width: 0.45 * s, height: 0.4 * s, depth: 0.5 * s },
          scene,
        );
        head.parent = this.root;
        head.position = new Vector3(0, 0.25 * s, 0.85 * s);
        head.material = mats.get(type.accentColor);
        this.groundY = 0.45 * s;
        this.hitRadius = 0.85 * s;
        break;
      }
      case "sphere": {
        // Hovering drone body.
        this.root = MeshBuilder.CreateSphere(
          `enemy-${type.name}`,
          { diameter: 1.0 * s, segments: 12 },
          scene,
        );
        const eye = MeshBuilder.CreateBox(
          "eye",
          { width: 0.3 * s, height: 0.14 * s, depth: 0.12 * s },
          scene,
        );
        eye.parent = this.root;
        eye.position = new Vector3(0, 0.05 * s, 0.48 * s);
        eye.material = mats.get(type.accentColor);
        this.groundY = 2.3; // hover height
        this.hitRadius = 0.65 * s;
        break;
      }
      default: {
        // Humanoid (archers, hackers, bandits).
        this.root = MeshBuilder.CreateCapsule(
          `enemy-${type.name}`,
          { height: 1.7 * s, radius: 0.4 * s },
          scene,
        );
        const head = MeshBuilder.CreateSphere(
          "head",
          { diameter: 0.5 * s, segments: 10 },
          scene,
        );
        head.parent = this.root;
        head.position = new Vector3(0, 1.0 * s, 0);
        head.material = mats.get(type.accentColor);
        this.groundY = 0.85 * s;
        this.hitRadius = 0.95 * s;
        break;
      }
    }

    this.root.material = mats.get(type.color);
    this.root.position = new Vector3(pos.x, this.groundY, pos.z);
    addOutline(this.root, 0.045);

    // Remember original materials for the white damage flash.
    this.parts.push({ mesh: this.root, mat: this.root.material });
    for (const child of this.root.getChildMeshes()) {
      if (child instanceof Mesh && child.material) {
        this.parts.push({ mesh: child, mat: child.material });
      }
    }

    // Spawn-in: scale up from small.
    this.root.scaling.setAll(0.05);
  }

  /** Center used for hitscan ray-sphere tests. */
  get center(): Vector3 {
    return this.root.position;
  }

  update(dt: number, ctx: AICtx): void {
    this.lifeT += dt;
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.setFlash(this.flashT > 0);
    }

    switch (this.state) {
      case "spawning": {
        this.t -= dt;
        const k = 1 - Math.max(0, this.t) / 0.4;
        this.root.scaling.setAll(0.05 + 0.95 * k);
        if (this.t <= 0) {
          this.root.scaling.setAll(1);
          this.state = "chasing";
        }
        break;
      }
      case "chasing":
        this.updateChase(dt, ctx);
        break;
      case "attacking": {
        this.t -= dt;
        // Telegraph: lean/scale up during windup.
        const pulse = 1 + 0.15 * Math.sin((1 - this.t / this.windupTime()) * Math.PI);
        this.root.scaling.setAll(pulse);
        this.facePoint(ctx.playerPos);
        if (this.t <= 0) {
          this.root.scaling.setAll(1);
          this.executeAttack(ctx);
          this.state = "chasing";
        }
        break;
      }
      case "dying": {
        this.t -= dt;
        const k = Math.max(0, this.t / 0.5);
        this.root.scaling.setAll(k);
        this.root.position.y = this.groundY * k;
        if (this.t <= 0) this.dead = true;
        break;
      }
    }
  }

  private updateChase(dt: number, ctx: AICtx): void {
    const type = this.type;
    const pos = this.root.position;
    const toPlayer = ctx.playerPos.subtract(pos);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    const dir = dist > 0.001 ? toPlayer.scale(1 / dist) : Vector3.Forward();
    const side = new Vector3(-dir.z, 0, dir.x);

    this.attackCooldown -= dt;
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      // Dodge: flip strafe direction at random intervals.
      this.strafeDir = -this.strafeDir;
      this.strafeT = 0.8 + Math.random() * 1.4;
    }

    let desire: Vector3;
    if (type.kind === "melee") {
      // Zig-zag approach so melee enemies are harder to track.
      desire = dir.add(side.scale(Math.sin(this.lifeT * 3) * 0.45));
    } else {
      // Ranged/flyers hold a firing band and strafe inside it.
      const band = type.attackRange;
      if (dist > band * 0.9) desire = dir;
      else if (dist < band * 0.5) desire = dir.scale(-1).add(side.scale(this.strafeDir * 0.5));
      else desire = side.scale(this.strafeDir);
    }

    if (desire.lengthSquared() > 0.0001) desire.normalize();
    const vel = desire.scale(type.speed);
    pos.x += vel.x * dt;
    pos.z += vel.z * dt;

    // Steer out of blocking props.
    for (const ob of ctx.obstacles) {
      const dx = pos.x - ob.x;
      const dz = pos.z - ob.z;
      const rr = ob.r + 0.7;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        pos.x = ob.x + (dx / d) * rr;
        pos.z = ob.z + (dz / d) * rr;
      }
    }

    // Stay inside the arena.
    const mx = ctx.bounds.width / 2 - 1.5;
    const mz = ctx.bounds.depth / 2 - 1.5;
    pos.x = Math.max(-mx, Math.min(mx, pos.x));
    pos.z = Math.max(-mz, Math.min(mz, pos.z));

    // Vertical: flyers bob, ground units stay planted.
    if (type.kind === "flyer") {
      pos.y = this.groundY + Math.sin(this.lifeT * 2.2) * 0.35;
    } else {
      pos.y = this.groundY;
    }

    this.facePoint(ctx.playerPos);

    // Start an attack when in range and off cooldown.
    if (this.attackCooldown <= 0) {
      const inRange =
        type.kind === "melee" ? dist < type.attackRange * 1.1 : dist < type.attackRange && dist > 2;
      if (inRange) {
        this.state = "attacking";
        this.t = this.windupTime();
        this.attackCooldown = type.attackCooldown;
      }
    }
  }

  private windupTime(): number {
    return this.type.kind === "melee" ? 0.35 : 0.4;
  }

  private executeAttack(ctx: AICtx): void {
    const type = this.type;
    const toPlayer = ctx.playerPos.subtract(this.root.position);
    const dist = new Vector3(toPlayer.x, 0, toPlayer.z).length();

    if (type.kind === "melee") {
      // Strike lands only if the player is still close (they can back off).
      if (dist < type.attackRange * 1.5) {
        ctx.damagePlayer(type.damage);
      }
    } else {
      const from = this.root.position.add(new Vector3(0, 0.3, 0));
      const target = ctx.playerPos.add(new Vector3(0, 1.0, 0));
      const dir = target.subtract(from).normalize();
      ctx.fireProjectile(
        from,
        dir,
        type.projectileSpeed ?? 16,
        type.damage,
        type.projectileColor ?? "#ffffff",
      );
    }
  }

  private facePoint(p: Vector3): void {
    const dx = p.x - this.root.position.x;
    const dz = p.z - this.root.position.z;
    this.root.rotation.y = Math.atan2(dx, dz);
  }

  /** Returns true if this damage killed the enemy. */
  takeDamage(amount: number): boolean {
    if (this.state === "dying") return false;
    this.hp -= amount;
    this.flashT = 0.08;
    this.setFlash(true);
    if (this.hp <= 0) {
      this.state = "dying";
      this.t = 0.5;
      this.justDied = true;
      this.setFlash(false);
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
    this.root.dispose(false, false);
  }
}
