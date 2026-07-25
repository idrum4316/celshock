import {
  Mesh,
  MeshBuilder,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import { addOutline, CelMaterialFactory } from "../shaders/CelShader";
import type { CameraSystem } from "../core/CameraSystem";
import type { InputManager } from "../core/InputManager";
import { buildRifle, RifleParts } from "./RifleModel";

/** Run-scoped stat modifiers granted by loot. */
export interface PlayerMods {
  damageMult: number;
  speedMult: number;
  maxHpBonus: number;
  magBonus: number;
}

/**
 * Palette for the player character model — field-drab, so the character
 * reads as a silhouette lit by their own lamp rather than a bright block of
 * color in an otherwise black room.
 */
const ARMOR = "#3f4a43"; // helmet, chest, thighs
const SUIT = "#1f262c"; // under-suit: arms, shins, pelvis
const TRIM = "#2b2b33"; // gloves, boots, gun
const VISOR = "#ffb347"; // emissive: visor slit and shoulder lamp

/**
 * Player pawn: movement (walk/jump/gravity) with Babylon collision sliding,
 * weapon state (ammo/reload/fire cooldown), and a cel-shaded humanoid body
 * animated procedurally (walk cycle, jump tuck, aim pitch, reload tilt).
 *
 * The invisible root capsule stays the physics collider; all visible meshes
 * hang off `body`, a child TransformNode whose joints are posed every frame.
 */
export class Player {
  root: Mesh;
  private rifle!: RifleParts;
  private meshes: Mesh[] = [];

  // Visual rig (all joints are pivots; limb meshes hang below them).
  private body!: TransformNode;
  private torso!: TransformNode;
  private head!: TransformNode;
  private shoulderL!: TransformNode;
  private shoulderR!: TransformNode;
  private elbowL!: TransformNode;
  private elbowR!: TransformNode;
  private hipL!: TransformNode;
  private hipR!: TransformNode;
  private kneeL!: TransformNode;
  private kneeR!: TransformNode;

  // Animation state.
  private walkPhase = 0;
  private moveBlend = 0;
  private airBlend = 0;
  private reloadBlend = 0;
  private idleT = 0;

  health: number = CONFIG.player.maxHealth;
  alive = true;
  grounded = true;

  ammo: number = CONFIG.weapon.magSize;
  reloading = false;
  private reloadT = 0;
  private fireCooldown = 0;
  private velY = 0;

  mods: PlayerMods = { damageMult: 1, speedMult: 1, maxHpBonus: 0, magBonus: 0 };

  private readonly groundY = CONFIG.player.height / 2;

  constructor(scene: Scene, mats: CelMaterialFactory) {
    const p = CONFIG.player;

    // Invisible collider capsule — physics only, never rendered.
    this.root = MeshBuilder.CreateCapsule(
      "player",
      { height: p.height, radius: p.radius },
      scene,
    );
    this.root.position = new Vector3(0, this.groundY, 0);
    this.root.isVisible = false;
    this.root.ellipsoid = new Vector3(p.radius, p.height / 2 - 0.05, p.radius);

    this.buildBody(scene, mats);
    addOutline(this.root, 0.025);
  }

  /**
   * Builds the humanoid. Local Y is relative to the root center (0.9 above
   * the ground), so the ground plane is at local y = -0.9 and the top of the
   * helmet at +0.9.
   */
  private buildBody(scene: Scene, mats: CelMaterialFactory): void {
    const box = (
      name: string,
      w: number,
      h: number,
      d: number,
      color: string,
      parent: TransformNode,
      x = 0,
      y = 0,
      z = 0,
    ): Mesh => {
      const m = MeshBuilder.CreateBox(
        `player_${name}`,
        { width: w, height: h, depth: d },
        scene,
      );
      m.parent = parent;
      m.position.set(x, y, z);
      m.material = mats.get(color);
      this.meshes.push(m);
      return m;
    };
    const joint = (
      name: string,
      parent: TransformNode,
      x: number,
      y: number,
      z = 0,
    ): TransformNode => {
      const n = new TransformNode(`player_${name}`, scene);
      n.parent = parent;
      n.position.set(x, y, z);
      return n;
    };

    this.body = new TransformNode("player_body", scene);
    this.body.parent = this.root;

    // Pelvis + torso (torso pivots at the lower spine for aim pitch).
    box("pelvis", 0.4, 0.18, 0.26, SUIT, this.body, 0, 0.02, 0);
    this.torso = joint("spine", this.body, 0, 0.12);
    box("chest", 0.46, 0.5, 0.28, ARMOR, this.torso, 0, 0.24, 0);

    // Head: helmet + glowing visor slit.
    this.head = joint("neck", this.torso, 0, 0.52);
    box("helmet", 0.26, 0.26, 0.26, ARMOR, this.head, 0, 0.13, 0);
    const visor = box("visor", 0.2, 0.09, 0.03, ARMOR, this.head, 0, 0.15, 0.135);
    visor.material = mats.getEmissive(VISOR);
    visor.metadata = { noOutline: true };

    // Shoulder lamp: the physical source of the light the player carries
    // (the light itself is driven by the LightingSystem).
    box("lampHousing", 0.12, 0.12, 0.14, TRIM, this.torso, -0.26, 0.42, 0.08);
    const lens = box("lampLens", 0.09, 0.09, 0.04, ARMOR, this.torso, -0.26, 0.42, 0.17);
    lens.material = mats.getEmissive(VISOR);
    lens.metadata = { noOutline: true };

    // Arms: shoulder and elbow joints, limb meshes hanging below each pivot.
    for (const side of [-1, 1] as const) {
      const tag = side < 0 ? "L" : "R";
      const shoulder = joint(`shoulder${tag}`, this.torso, side * 0.3, 0.43);
      box(`upperArm${tag}`, 0.13, 0.3, 0.13, SUIT, shoulder, 0, -0.15, 0);
      const elbow = joint(`elbow${tag}`, shoulder, 0, -0.3);
      box(`forearm${tag}`, 0.11, 0.26, 0.11, SUIT, elbow, 0, -0.13, 0);
      box(`hand${tag}`, 0.11, 0.1, 0.12, TRIM, elbow, 0, -0.3, 0);
      if (side < 0) {
        this.shoulderL = shoulder;
        this.elbowL = elbow;
      } else {
        this.shoulderR = shoulder;
        this.elbowR = elbow;
      }
    }

    // Legs: hip and knee joints; boots reach the ground at local -0.9.
    for (const side of [-1, 1] as const) {
      const tag = side < 0 ? "L" : "R";
      const hip = joint(`hip${tag}`, this.body, side * 0.12, -0.02);
      box(`thigh${tag}`, 0.17, 0.42, 0.19, ARMOR, hip, 0, -0.21, 0);
      const knee = joint(`knee${tag}`, hip, 0, -0.42);
      box(`shin${tag}`, 0.14, 0.38, 0.16, SUIT, knee, 0, -0.19, 0);
      box(`boot${tag}`, 0.15, 0.1, 0.27, TRIM, knee, 0, -0.41, 0.04);
      if (side < 0) {
        this.hipL = hip;
        this.kneeL = knee;
      } else {
        this.hipR = hip;
        this.kneeR = knee;
      }
    }

    // Rifle rides the torso so it pitches with the aim; +z stays the barrel
    // axis. Slightly scaled down to fit the character's proportions.
    this.rifle = buildRifle(scene, mats, "player");
    this.rifle.root.parent = this.torso;
    this.rifle.root.position.set(0.3, 0.14, 0.28);
    this.rifle.root.scaling.setAll(0.85);
    this.meshes.push(...this.rifle.meshes);
  }

  get position(): Vector3 {
    return this.root.position;
  }

  get maxHealth(): number {
    return CONFIG.player.maxHealth + this.mods.maxHpBonus;
  }

  get magSize(): number {
    return CONFIG.weapon.magSize + this.mods.magBonus;
  }

  get damage(): number {
    return CONFIG.weapon.damage * this.mods.damageMult;
  }

  /** Full reset at the start of a run (permadeath — mods are cleared too). */
  fullReset(): void {
    this.mods = { damageMult: 1, speedMult: 1, maxHpBonus: 0, magBonus: 0 };
    this.health = this.maxHealth;
    this.alive = true;
    this.ammo = this.magSize;
    this.reloading = false;
    this.fireCooldown = 0;
    this.velY = 0;
  }

  placeAt(spawn: Vector3): void {
    this.root.position.copyFrom(spawn);
    this.root.position.y = this.groundY;
    this.velY = 0;
    this.grounded = true;
  }

  update(dt: number, input: InputManager, cam: CameraSystem): boolean {
    const p = CONFIG.player;
    let jumped = false;

    // --- horizontal movement (camera-relative), with collision sliding ---
    const speed =
      p.moveSpeed *
      this.mods.speedMult *
      (cam.adsBlend > 0.4 ? p.adsMoveMult : 1);
    const move = cam.flatForward
      .scale(input.moveY)
      .add(cam.flatRight.scale(input.moveX));
    const moveInput = Math.min(1, move.length());
    if (move.lengthSquared() > 1) move.normalize();
    if (move.lengthSquared() > 0.0001) {
      this.root.moveWithCollisions(move.scale(speed * dt));
    }

    // --- jump & gravity (flat arena floors, so a plane check suffices) ---
    if (input.jumpPressed && this.grounded) {
      this.velY = p.jumpVelocity;
      this.grounded = false;
      jumped = true;
    }
    this.velY -= p.gravity * dt;
    this.root.position.y += this.velY * dt;
    if (this.root.position.y <= this.groundY) {
      this.root.position.y = this.groundY;
      this.velY = 0;
      this.grounded = true;
    }

    // --- always face the camera yaw (over-the-shoulder aiming) ---
    this.root.rotation.y = cam.yaw;

    // --- weapon timers ---
    this.fireCooldown -= dt;
    if (this.reloading) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        this.reloading = false;
        this.ammo = this.magSize;
      }
    }

    this.animate(dt, moveInput, speed, cam);
    return jumped;
  }

  /** Procedural pose: walk cycle, jump tuck, aim pitch, reload, idle sway. */
  private animate(
    dt: number,
    moveInput: number,
    speed: number,
    cam: CameraSystem,
  ): void {
    this.idleT += dt;

    // Smoothed blend weights so poses ease in/out instead of snapping.
    const ease = (current: number, target: number, rate: number) =>
      current + (target - current) * Math.min(1, dt * rate);
    this.moveBlend = ease(this.moveBlend, moveInput, 10);
    this.airBlend = ease(this.airBlend, this.grounded ? 0 : 1, 9);
    this.reloadBlend = ease(this.reloadBlend, this.reloading ? 1 : 0, 12);

    // Stride phase advances with actual ground speed (~2.4 Hz at full run).
    this.walkPhase += speed * this.moveBlend * 2.2 * dt;
    const walk = this.moveBlend * (1 - this.airBlend);
    const swing = Math.sin(this.walkPhase);

    // Legs: hips counter-swing; the knee bends mid-swing and straightens
    // for the plant (max(0, cos) is the swing-through window).
    const jumpTuck = this.airBlend;
    this.hipL.rotation.x = -0.62 * swing * walk - 0.55 * jumpTuck;
    this.hipR.rotation.x = 0.62 * swing * walk + 0.25 * jumpTuck;
    this.kneeL.rotation.x =
      0.95 * Math.max(0, Math.cos(this.walkPhase)) * walk + 1.05 * jumpTuck;
    this.kneeR.rotation.x =
      0.95 * Math.max(0, -Math.cos(this.walkPhase)) * walk + 0.5 * jumpTuck;

    // Body bob (two per stride), a slight crouch while running, idle breath.
    const idle = (1 - this.moveBlend) * (1 - this.airBlend);
    this.body.position.y =
      0.05 * Math.abs(Math.cos(this.walkPhase)) * walk -
      0.04 * walk +
      0.012 * Math.sin(this.idleT * 2.1) * idle;

    // Torso: pitch with the camera aim, lean into the run, subtle sway.
    this.torso.rotation.x = -cam.pitch * 0.45 + 0.1 * walk;
    this.torso.rotation.y = 0.06 * swing * walk;
    this.torso.rotation.z = 0.04 * swing * walk;
    this.head.rotation.x = -cam.pitch * 0.3;

    // Arms: two-handed gun-ready pose. The right hand grips near the stock;
    // the left supports across the chest and drops during reloads.
    this.shoulderR.rotation.set(-0.95, 0, -0.06);
    this.elbowR.rotation.x = -0.55;
    this.shoulderL.rotation.set(
      -0.75 + 0.55 * this.reloadBlend,
      0.35,
      0.75 - 0.4 * this.reloadBlend,
    );
    this.elbowL.rotation.x = -1.0 + 0.45 * this.reloadBlend;

    // Reload: tip the rifle down while the magazine swaps.
    this.rifle.root.rotation.x = 0.5 * this.reloadBlend;
  }

  /**
   * Consumes one shot if the weapon can fire right now.
   * Auto-reloads when the magazine empties.
   */
  tryShot(): boolean {
    if (!this.alive || this.reloading || this.fireCooldown > 0 || this.ammo <= 0) {
      return false;
    }
    this.ammo -= 1;
    this.fireCooldown = 1 / CONFIG.weapon.fireRate;
    if (this.ammo === 0) this.startReload();
    return true;
  }

  startReload(): boolean {
    if (this.reloading || this.ammo >= this.magSize) return false;
    this.reloading = true;
    this.reloadT = CONFIG.weapon.reloadTime;
    return true;
  }

  get reloadProgress(): number {
    return this.reloading ? 1 - this.reloadT / CONFIG.weapon.reloadTime : 1;
  }

  /** World position of the rifle muzzle (tracer origin). */
  muzzleWorld(): Vector3 {
    return this.rifle.muzzle.getAbsolutePosition().clone();
  }

  /** Returns true if this damage killed the player. */
  takeDamage(amount: number): boolean {
    if (!this.alive) return false;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) {
      this.alive = false;
      return true;
    }
    return false;
  }

  heal(amount: number): void {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /** Hides the body while in first-person ADS. */
  setFirstPerson(fp: boolean): void {
    for (const part of this.meshes) part.isVisible = !fp;
  }
}
