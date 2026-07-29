/**
 * Player.ts — Player controller: movement/sprint/jump physics, health/regen,
 * weapon state (fire/reload/spread), and the GLB body wiring.
 * Owns: the player Combatant. Body loads async (GlbSoldier) and starts hidden.
 * Invariants: probeGround and step-up ray tests filter metadata.solid === true.
 * Health regenerates after CONFIG.player.regenDelay — with 16 hostile bots and
 * no medics this is load-bearing, not decoration. muzzleWorld() assumes the
 * rifle is loaded. Damage flows out via the onDamaged callback wired in Game.
 */
import {
  Color3,
  Mesh,
  MeshBuilder,
  Ray,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import { CelMaterialFactory } from "../shaders/CelShader";
import type { CameraSystem } from "../core/CameraSystem";
import type { InputManager } from "../core/InputManager";
import { buildRifle, RifleParts } from "./RifleModel";
import { GlbSoldier } from "./GlbSoldier";
import type { Combatant, Team } from "./Combatant";

/** Run-scoped stat modifiers granted by loot. */
export interface PlayerMods {
  damageMult: number;
  speedMult: number;
  maxHpBonus: number;
  magBonus: number;
}

/** Where the rifle rides until the GLB body arrives and claims it. */
const RIFLE_REST = new Vector3(0.3, 0.14, 0.28);

/**
 * Player pawn: movement (walk/jump/gravity) with Babylon collision sliding,
 * weapon state (ammo/reload/fire cooldown), and a cel-shaded humanoid body
 * animated procedurally (walk cycle, jump tuck, aim pitch, reload tilt).
 *
 * The invisible root capsule stays the physics collider; all visible meshes
 * hang off `body`, a child TransformNode whose joints are posed every frame.
 */
export class Player implements Combatant {
  root: Mesh;
  /** Which side the player fights for. Set by Game when a round starts. */
  team: Team = 0;
  /** Body centre and eye line, kept in sync each frame for hitscan and LOS. */
  readonly center = new Vector3();
  readonly eyePos = new Vector3();
  readonly hitRadius = 0.7;
  /**
   * Wired by Game. Bots damage the player straight through `CombatSystem`, so
   * this is how the flash, the sound, and the death handling still happen.
   */
  onDamaged: (amount: number, died: boolean) => void = () => {};
  private rifle!: RifleParts;
  private meshes: Mesh[] = [];
  /** The imported rigged body; null until the async GLB load resolves. */
  private glb: GlbSoldier | null = null;
  /** Last visibility state, applied to the GLB meshes when they arrive. */
  private bodyHidden = true;

  // Animation state (smoothed inputs for the GLB pose overlay).
  private moveBlend = 0;
  private airBlend = 0;
  private reloadBlend = 0;
  private idleT = 0;

  health: number = CONFIG.player.maxHealth;
  alive = true;
  grounded = true;

  ammo: number = CONFIG.weapon.magSize;
  reloading = false;
  /** True while the sprint key is held and the player is actually running. */
  sprinting = false;
  /** Counts down from `regenDelay` after each hit; regen resumes at zero. */
  private regenLockT = 0;
  private reloadT = 0;
  private fireCooldown = 0;
  private velY = 0;
  /** Extra spread accumulated by sustained fire; bleeds off when not firing. */
  private spreadBloom = 0;
  /** Weapon punch, 1 at the shot and falling to 0 over `recoil.kickTime`. */
  private weaponKickT = 0;

  mods: PlayerMods = { damageMult: 1, speedMult: 1, maxHpBonus: 0, magBonus: 0 };

  private readonly groundY = CONFIG.player.height / 2;
  /** Reused so the per-frame ground probe allocates nothing. */
  private readonly probeRay = new Ray(new Vector3(), new Vector3(0, -1, 0), 1);
  private scene: Scene;

  constructor(scene: Scene, mats: CelMaterialFactory) {
    const p = CONFIG.player;
    this.scene = scene;

    // Invisible collider capsule — physics only, never rendered.
    this.root = MeshBuilder.CreateCapsule(
      "player",
      { height: p.height, radius: p.radius },
      scene,
    );
    this.root.position = new Vector3(0, this.groundY, 0);
    this.root.isVisible = false;
    this.root.ellipsoid = new Vector3(p.radius, p.height / 2 - 0.05, p.radius);

    // The rifle exists from frame one (the GLB claims it when it arrives).
    // Its parts are an order of magnitude smaller than the body's, so a
    // body-width outline would swallow the whole weapon in black.
    this.rifle = buildRifle(scene, mats, "player");
    this.rifle.root.parent = this.root;
    this.rifle.root.position.copyFrom(RIFLE_REST);
    this.rifle.root.scaling.setAll(0.85);
    for (const m of this.rifle.meshes) {
      m.renderOutline = true;
      m.outlineColor = Color3.Black();
      m.outlineWidth = 0.004;
    }
    this.meshes.push(...this.rifle.meshes);

    // The rigged, textured body loads async; the menu/deploy flow covers the
    // latency, and until it resolves the player is simply the hidden capsule
    // plus the rifle (never visible before the first deploy).
    void GlbSoldier.load(scene, mats)
      .then((rig) => {
        this.glb = rig;
        rig.root.parent = this.root;
        rig.attachRifle(this.rifle);
        this.meshes = [...rig.meshes, ...this.rifle.meshes];
        this.applyVisibility();
      })
      .catch((e: unknown) => {
        console.error("GlbSoldier failed to load — player body missing", e);
      });
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

  /**
   * Bullet spread half-angle for the next shot, including recoil bloom.
   * Bloom is damped in ADS by the same factor as the aim kick — a braced
   * stance would otherwise lose far more precision than it has to give.
   */
  spread(adsBlend: number): number {
    const w = CONFIG.weapon;
    const base = w.spreadHip + (w.spreadAds - w.spreadHip) * adsBlend;
    const bloomMult = 1 - (1 - CONFIG.recoil.adsMult) * adsBlend;
    return base + this.spreadBloom * bloomMult;
  }

  /** Full reset at the start of a run (permadeath — mods are cleared too). */
  fullReset(): void {
    this.regenLockT = 0;
    this.mods = { damageMult: 1, speedMult: 1, maxHpBonus: 0, magBonus: 0 };
    this.health = this.maxHealth;
    this.alive = true;
    this.ammo = this.magSize;
    this.reloading = false;
    this.fireCooldown = 0;
    this.velY = 0;
    this.spreadBloom = 0;
    this.weaponKickT = 0;
  }

  placeAt(spawn: Vector3): void {
    this.root.position.copyFrom(spawn);
    this.root.position.y = spawn.y + this.groundY;
    this.velY = 0;
    this.grounded = true;
    this.syncCombatant();
  }

  /**
   * Height of the surface underfoot, from a short downward ray against the
   * map's collider proxies.
   *
   * The probe starts a step-height above the feet so a rise reads as a step to
   * walk up rather than a wall to stop against, and falls back to the valley
   * floor when it finds nothing — the ground plane always exists, so a miss
   * means the player is off the map rather than in the void.
   */
  private probeGround(): number {
    const p = CONFIG.player;
    const pos = this.root.position;
    this.probeRay.origin.set(
      pos.x,
      pos.y - this.groundY + p.stepHeight + 0.05,
      pos.z,
    );
    this.probeRay.length = p.groundProbeLength;
    const hit = this.scene.pickWithRay(
      this.probeRay,
      (m) => !!m.metadata && m.metadata.solid === true,
    );
    return hit?.hit && hit.pickedPoint ? hit.pickedPoint.y : 0;
  }

  update(dt: number, input: InputManager, cam: CameraSystem): boolean {
    const p = CONFIG.player;
    let jumped = false;

    // --- horizontal movement (camera-relative), with collision sliding ---
    // Sprinting is mutually exclusive with aiming, and blocks firing (see
    // `tryShot`) — otherwise it is strictly better than walking.
    this.sprinting =
      input.sprint && input.moveY > 0.1 && cam.adsBlend < 0.4 && !this.reloading;
    const speed =
      p.moveSpeed *
      this.mods.speedMult *
      (cam.adsBlend > 0.4 ? p.adsMoveMult : 1) *
      (this.sprinting ? p.sprintMult : 1);
    const move = cam.flatForward
      .scale(input.moveY)
      .add(cam.flatRight.scale(input.moveX));
    const moveInput = Math.min(1, move.length());
    if (move.lengthSquared() > 1) move.normalize();
    if (move.lengthSquared() > 0.0001) {
      this.root.moveWithCollisions(move.scale(speed * dt));
    }

    // --- jump & gravity, against whatever surface is actually underfoot ---
    if (input.jumpPressed && this.grounded) {
      this.velY = p.jumpVelocity;
      this.grounded = false;
      jumped = true;
    }
    this.velY -= p.gravity * dt;
    this.root.position.y += this.velY * dt;

    // Hollowmere has terraces, embankments, ramps and a hayloft, so the floor
    // is wherever the probe finds it rather than a fixed plane. Rising ground
    // is snapped up to (a step, not a wall) only while falling or grounded, so
    // a jump still arcs over a low wall instead of sticking to it.
    const floorY = this.probeGround();
    const foot = this.root.position.y - this.groundY;
    if (foot <= floorY + (this.velY <= 0 ? p.stepHeight : 0)) {
      this.root.position.y = floorY + this.groundY;
      this.velY = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // --- always face the camera yaw (over-the-shoulder aiming) ---
    this.root.rotation.y = cam.yaw;

    // --- health regeneration ---
    // Stay hurt for a few seconds after the last hit, then heal back to full.
    // Without this, sixteen hostile bots and no medic turns the round into a
    // respawn queue for anyone who wins a fight at half health.
    this.regenLockT = Math.max(0, this.regenLockT - dt);
    if (this.regenLockT <= 0 && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + p.regenRate * dt);
    }

    // --- weapon timers ---
    this.fireCooldown -= dt;
    this.spreadBloom = Math.max(
      0,
      this.spreadBloom - CONFIG.recoil.bloomRecovery * dt,
    );
    if (this.reloading) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        this.reloading = false;
        this.ammo = this.magSize;
      }
    }

    this.syncCombatant();
    this.animate(dt, moveInput, speed, cam);
    return jumped;
  }

  /**
   * Feeds the smoothed pose inputs to the GLB body, which applies them on
   * the next rendered frame (clips + procedural bone overlay). All the
   * easing stays here so the body's response is frame-rate independent.
   */
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

    // Weapon punch: a hard hit that falls off fast (squared, so the spike is
    // at the shot rather than smeared across the recovery).
    this.weaponKickT = Math.max(0, this.weaponKickT - dt / CONFIG.recoil.kickTime);
    const kick = this.weaponKickT * this.weaponKickT;

    this.glb?.updatePose({
      groundSpeed: speed * this.moveBlend,
      moveBlend: this.moveBlend,
      airBlend: this.airBlend,
      reloadBlend: this.reloadBlend,
      aimPitch: cam.aimPitch,
      kick,
      idleT: this.idleT,
    });
  }

  /**
   * Consumes one shot if the weapon can fire right now.
   * Auto-reloads when the magazine empties.
   */
  tryShot(): boolean {
    if (
      !this.alive ||
      this.reloading ||
      this.sprinting ||
      this.fireCooldown > 0 ||
      this.ammo <= 0
    ) {
      return false;
    }
    const r = CONFIG.recoil;
    this.ammo -= 1;
    this.fireCooldown = 1 / CONFIG.weapon.fireRate;
    // Weapon-side recoil: the spread bloom the next shot inherits, and the
    // punch the body rides out. The aim kick itself belongs to the camera.
    this.spreadBloom = Math.min(r.maxBloom, this.spreadBloom + r.bloomPerShot);
    this.weaponKickT = 1;
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
  /** Keeps `center`/`eyePos` current; called once per frame from `update`. */
  private syncCombatant(): void {
    const p = this.root.position;
    this.center.set(p.x, p.y, p.z);
    this.eyePos.set(p.x, p.y + CONFIG.camera.eyeHeight - this.groundY, p.z);
  }

  takeDamage(amount: number): boolean {
    if (!this.alive) return false;
    this.health = Math.max(0, this.health - amount);
    this.regenLockT = CONFIG.player.regenDelay;
    const died = this.health <= 0;
    if (died) this.alive = false;
    this.onDamaged(amount, died);
    return died;
  }

  heal(amount: number): void {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /**
   * Shows/hides the body. Hidden only outside gameplay (menu backdrop);
   * during play the camera never goes first-person, so the body stays
   * visible the whole time.
   */
  setBodyHidden(hidden: boolean): void {
    this.bodyHidden = hidden;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    for (const part of this.meshes) part.isVisible = !this.bodyHidden;
  }
}
