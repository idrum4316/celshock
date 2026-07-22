import { Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { addOutline, CelMaterialFactory } from "../shaders/CelShader";
import type { CameraSystem } from "../core/CameraSystem";
import type { InputManager } from "../core/InputManager";

/** Run-scoped stat modifiers granted by loot. */
export interface PlayerMods {
  damageMult: number;
  speedMult: number;
  maxHpBonus: number;
  magBonus: number;
}

/**
 * Player pawn: movement (walk/jump/gravity) with Babylon collision sliding,
 * weapon state (ammo/reload/fire cooldown), and the placeholder body mesh.
 */
export class Player {
  root: Mesh;
  private gun: Mesh;
  private bodyParts: Mesh[] = [];

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

    this.root = MeshBuilder.CreateCapsule(
      "player",
      { height: p.height, radius: p.radius },
      scene,
    );
    this.root.position = new Vector3(0, this.groundY, 0);
    this.root.material = mats.get("#3a6ea5");
    this.root.ellipsoid = new Vector3(p.radius, p.height / 2 - 0.05, p.radius);

    const visor = MeshBuilder.CreateBox(
      "playerVisor",
      { width: 0.42, height: 0.14, depth: 0.2 },
      scene,
    );
    visor.parent = this.root;
    visor.position = new Vector3(0, 0.62, 0.32);
    visor.material = mats.get("#ffd23f");

    this.gun = MeshBuilder.CreateBox(
      "playerGun",
      { width: 0.12, height: 0.16, depth: 0.85 },
      scene,
    );
    this.gun.parent = this.root;
    this.gun.position = new Vector3(0.34, 0.28, 0.5);
    this.gun.material = mats.get("#2b2b33");

    this.bodyParts = [this.root, visor, this.gun];
    addOutline(this.root, 0.05);
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

    return jumped;
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

  /** World position of the gun muzzle (tracer origin). */
  muzzleWorld(): Vector3 {
    this.gun.computeWorldMatrix(true);
    return Vector3.TransformCoordinates(
      new Vector3(0, 0, 0.45),
      this.gun.getWorldMatrix(),
    );
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
    for (const part of this.bodyParts) part.isVisible = !fp;
  }
}
