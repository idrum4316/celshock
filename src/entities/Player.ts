/**
 * Player.ts — Player controller: movement/sprint/crouch/jump physics,
 * health/regen, weapon state (fire/reload/spread), gunfeel dressing (muzzle
 * flash mesh, ejected brass), and the first-person viewmodel wiring.
 * Owns: the player Combatant, and the ViewModel hanging off the camera.
 * Invariants: probeGround and step-up ray tests filter metadata.solid === true.
 * Crouch moves `eyePos` AND `center` on one blend — the eye is the camera, the
 * LOS target and the bots' aim point at once, so lowering it without lowering
 * the hit sphere makes crouching a liability rather than cover.
 * Health regenerates after CONFIG.player.regenDelay — with 8 hostile bots and
 * no medics this is load-bearing, not decoration. The player has no world body
 * mesh at all: the camera is inside the head, so the only thing on screen is
 * the viewmodel (and the blob shadow ShadowSystem draws underfoot). The flash
 * mesh and casing pool are player-only visuals (bots get neither — see
 * CONFIG.gunfeel), and the flash must join VIEWMODEL_GROUP with the rifle it
 * hangs off. Damage flows out via the onDamaged callback wired in Game.
 */
import {
  Mesh,
  MeshBuilder,
  type Node,
  Ray,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import { CelMaterialFactory } from "../shaders/CelShader";
import type { CameraSystem } from "../core/CameraSystem";
import type { InputManager } from "../core/InputManager";
import { ViewModel, VIEWMODEL_GROUP } from "./ViewModel";
import { TerrainField } from "../world/TerrainField";
import type { Combatant, Team } from "./Combatant";

/** Run-scoped stat modifiers granted by loot. */
export interface PlayerMods {
  damageMult: number;
  speedMult: number;
  maxHpBonus: number;
  magBonus: number;
}

/** Ejection port, in rifle-local space (matches RifleModel's ejectPort box). */
const CASING_PORT = new Vector3(0.05, 0.04, 0.06);

/** One live brass case: world-space ballistic, despawned on `t` expiry. */
interface Casing {
  mesh: Mesh;
  vel: Vector3;
  spin: number;
  t: number;
}

/** Scratch for the eject direction — no allocation per shot. */
const _casingDir = new Vector3();

/**
 * Player pawn: movement (walk/jump/gravity) with Babylon collision sliding,
 * weapon state (ammo/reload/fire cooldown), and the smoothed signals that
 * drive the first-person weapon (movement, sprint, reload, turn rate, kick).
 *
 * The invisible root capsule stays the physics collider. In first person the
 * pawn has no visible body — the camera sits at its eye — so the only meshes
 * it owns are the viewmodel's, the muzzle flash and the brass.
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
  onDamaged: (amount: number, died: boolean, from?: Vector3) => void = () => {};
  /** The rifle and hands on screen; the only visible thing the player owns. */
  private view: ViewModel;
  /** Whether the viewmodel is hidden (menu, deploy screen, editor). */
  private bodyHidden = true;

  // Smoothed inputs for the viewmodel pose.
  private moveBlend = 0;
  private airBlend = 0;
  private reloadBlend = 0;
  private sprintBlend = 0;
  /** Smoothed camera yaw/pitch rates (rad/s): the weapon trails both. */
  private turnRate = 0;
  private pitchRate = 0;
  private prevYaw = 0;
  private prevPitch = 0;

  health: number = CONFIG.player.maxHealth;
  alive = true;
  grounded = true;

  ammo: number = CONFIG.weapon.magSize;
  reloading = false;
  /** True while the sprint key is held and the player is actually running. */
  sprinting = false;
  /** True while the crouch key is held and the player is not sprinting. */
  crouching = false;
  /**
   * Eased 0..1 stance blend. Drives the eye height, the hit sphere's centre,
   * the move speed, the spread and the bob together — one number, so the
   * transition reads as a single motion the way ADS does.
   */
  private crouchBlend = 0;
  /** Counts down from `regenDelay` after each hit; regen resumes at zero. */
  private regenLockT = 0;
  private reloadT = 0;
  private fireCooldown = 0;
  private velY = 0;
  /** Extra spread accumulated by sustained fire; bleeds off when not firing. */
  private spreadBloom = 0;
  /** Weapon punch, 1 at the shot and falling to 0 over `recoil.kickTime`. */
  private weaponKickT = 0;
  /** Muzzle flash star: shown for `gunfeel.flashTime` after each shot. */
  private flashRoot!: TransformNode;
  private flashT = 0;
  /** Ejected brass pool; a case is live while its `t > 0`. */
  private casings: Casing[] = [];
  /** Scratch for casing integration — no per-frame allocation. */
  private readonly casingStep = new Vector3();

  mods: PlayerMods = { damageMult: 1, speedMult: 1, maxHpBonus: 0, magBonus: 0 };

  private readonly groundY = CONFIG.player.height / 2;
  /** Reused so the per-frame ground probe allocates nothing. */
  private readonly probeRay = new Ray(new Vector3(), new Vector3(0, -1, 0), 1);
  private scene: Scene;
  /** The map's floor, for the probe's miss case. Flat until a map is built. */
  private terrain: TerrainField = new TerrainField();

  constructor(scene: Scene, mats: CelMaterialFactory, camera: Node) {
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

    // The weapon hangs off the camera, not off this capsule: in first person
    // the rifle you see is a viewmodel, posed in camera space.
    this.view = new ViewModel(scene, mats, camera);

    // --- gunfeel dressing: muzzle flash star + brass pool (player only) ---
    // The flash is three crossed emissive petals at the muzzle; per shot it
    // gets a random roll and scale so no two shots strobe identically.
    this.flashRoot = new TransformNode("player_muzzleFlash", scene);
    this.flashRoot.parent = this.view.rifle.muzzle;
    this.flashRoot.setEnabled(false);
    const flashMat = mats.getEmissive("#ffd9a0");
    for (let i = 0; i < 3; i++) {
      const petal = MeshBuilder.CreatePlane(
        `player_flashPetal${i}`,
        { width: 0.34, height: 0.15, sideOrientation: Mesh.DOUBLESIDE },
        scene,
      );
      petal.parent = this.flashRoot;
      petal.rotation.y = Math.PI / 2; // length runs along the barrel
      petal.rotation.z = (i * Math.PI) / 3;
      petal.position.z = 0.14;
      petal.material = flashMat;
      petal.metadata = { noOutline: true };
      petal.isPickable = false;
      // The flash lives on the viewmodel, so it has to be drawn in the same
      // depth-cleared pass — left in the world group it would be hidden
      // behind the very barrel it sits on.
      petal.renderingGroupId = VIEWMODEL_GROUP;
      petal.alwaysSelectAsActiveMesh = true;
    }

    const casingMat = mats.get("#b99b4e");
    for (let i = 0; i < CONFIG.gunfeel.casingPool; i++) {
      const m = MeshBuilder.CreateBox(
        `player_casing${i}`,
        { width: 0.016, height: 0.016, depth: 0.05 },
        scene,
      );
      m.material = casingMat;
      m.isPickable = false;
      m.isVisible = false;
      this.casings.push({ mesh: m, vel: new Vector3(), spin: 0, t: 0 });
    }
    // Brass is thrown into the WORLD, not onto the camera, so it stays in the
    // ordinary rendering group and is occluded by geometry like anything else.

    this.applyVisibility();
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
   *
   * Crouching scales the whole result, bloom included: it is a steadier
   * platform, not a second set of sights, so it helps most where the sights
   * help least (hip fire, deep into a burst).
   */
  spread(adsBlend: number): number {
    const w = CONFIG.weapon;
    const base = w.spreadHip + (w.spreadAds - w.spreadHip) * adsBlend;
    const bloomMult = 1 - (1 - CONFIG.recoil.adsMult) * adsBlend;
    const crouchMult =
      1 - (1 - CONFIG.player.crouchSpreadMult) * this.crouchBlend;
    return (base + this.spreadBloom * bloomMult) * crouchMult;
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
    this.flashT = 0;
    this.flashRoot.setEnabled(false);
    for (const c of this.casings) {
      c.t = 0;
      c.mesh.isVisible = false;
    }
    this.crouching = false;
    this.crouchBlend = 0;
    this.moveBlend = 0;
    this.airBlend = 0;
    this.reloadBlend = 0;
    this.sprintBlend = 0;
    this.turnRate = 0;
    this.pitchRate = 0;
    this.view.reset();
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
    if (hit?.hit && hit.pickedPoint) return hit.pickedPoint.y;
    // A miss means the probe outran the floor — off the map, or falling into
    // something deeper than it reaches. The terrain field is the floor's own
    // answer, and on a flat map it is the 0 this used to return outright.
    return this.terrain.heightAt(pos.x, pos.z);
  }

  /** Points the ground probe's miss case at the current map's floor. */
  setTerrain(terrain: TerrainField): void {
    this.terrain = terrain;
  }

  update(dt: number, input: InputManager, cam: CameraSystem): boolean {
    const p = CONFIG.player;
    let jumped = false;

    // --- stance ---
    // Sprinting is mutually exclusive with aiming, and blocks firing (see
    // `tryShot`) — otherwise it is strictly better than walking.
    //
    // Sprint outranks crouch, and is resolved first so the two can't argue:
    // asking to run stands the player up, and letting go of the sprint key
    // drops straight back down while the crouch key is still held. Crouch is
    // deliberately NOT gated on `grounded` — jumping out of it would pop the
    // camera half a metre at the worst possible moment, and the collider
    // capsule never changes size, so there is nothing underfoot to reconcile.
    this.sprinting =
      input.sprint && input.moveY > 0.1 && cam.adsBlend < 0.4 && !this.reloading;
    this.crouching = input.crouch && !this.sprinting;
    this.crouchBlend +=
      ((this.crouching ? 1 : 0) - this.crouchBlend) *
      Math.min(1, dt * p.crouchBlendSpeed);

    // --- horizontal movement (camera-relative), with collision sliding ---
    const speed =
      p.moveSpeed *
      this.mods.speedMult *
      (cam.adsBlend > 0.4 ? p.adsMoveMult : 1) *
      (this.sprinting ? p.sprintMult : 1) *
      (1 - (1 - p.crouchMoveMult) * this.crouchBlend);
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

    // --- the capsule still faces the camera yaw ---
    // Nothing renders off it any more, but the blob shadow underfoot is
    // oriented from it, and a capsule that never turned would drag an
    // unturning oval around with the player.
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
    this.updateGunfeel(dt);
    this.animate(dt, moveInput, cam);
    return jumped;
  }

  /**
   * Smooths this frame's movement/look into the signals the viewmodel poses
   * from, and pushes them. All the easing stays here so the weapon's response
   * is frame-rate independent, the same reason it lived here for the body.
   *
   * The bob phase comes back off the camera rather than being integrated
   * again here: two integrators on the same drive would drift apart and the
   * weapon would swim against the view. Player runs before the camera in
   * Game's frame order, so the phase read is one frame old — 16 ms of an
   * ~0.8 s cycle, against a visible desync if the weapon kept its own.
   */
  private animate(dt: number, moveInput: number, cam: CameraSystem): void {
    // Smoothed blend weights so poses ease in/out instead of snapping.
    const ease = (current: number, target: number, rate: number) =>
      current + (target - current) * Math.min(1, dt * rate);
    this.moveBlend = ease(this.moveBlend, moveInput, 10);
    this.airBlend = ease(this.airBlend, this.grounded ? 0 : 1, 9);
    this.reloadBlend = ease(this.reloadBlend, this.reloading ? 1 : 0, 12);
    this.sprintBlend = ease(this.sprintBlend, this.sprinting ? 1 : 0, 6);
    // Camera yaw/pitch rates, wrapped and smoothed: the weapon trails both.
    let dYaw = cam.yaw - this.prevYaw;
    this.prevYaw = cam.yaw;
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    else if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this.turnRate = ease(this.turnRate, dt > 0 ? dYaw / dt : 0, 8);
    const dPitch = cam.pitch - this.prevPitch;
    this.prevPitch = cam.pitch;
    this.pitchRate = ease(this.pitchRate, dt > 0 ? dPitch / dt : 0, 8);

    // Weapon punch: a hard hit that falls off fast (squared, so the spike is
    // at the shot rather than smeared across the recovery).
    this.weaponKickT = Math.max(0, this.weaponKickT - dt / CONFIG.recoil.kickTime);

    // The camera bobs on the same drive the weapon does; it owns the phase.
    // The drive is movement *intent*, not speed, so the crouch damping has to
    // be applied here — a half-speed shuffle covering ground at a full jog's
    // stride tempo is the tell.
    cam.setBobDrive(
      this.moveBlend *
        (1 - (1 - CONFIG.camera.bobCrouchMult) * this.crouchBlend),
      this.grounded,
    );
    this.view.update(dt, {
      adsBlend: cam.adsBlend,
      moveBlend: this.moveBlend * (1 - this.airBlend),
      sprintBlend: this.sprintBlend,
      reloadBlend: this.reloadBlend,
      reloadPhase: this.reloadProgress,
      kick: this.weaponKickT * this.weaponKickT,
      turnRate: this.turnRate,
      pitchRate: this.pitchRate,
      bobPhase: cam.bobPhase,
      velY: this.velY,
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
    // Muzzle flash: a single-frame-scale strobe with a random roll and scale,
    // so full-auto reads as flicker rather than one static sprite.
    const g = CONFIG.gunfeel;
    this.flashT = g.flashTime;
    this.flashRoot.setEnabled(true);
    this.flashRoot.rotation.z = Math.random() * Math.PI;
    this.flashRoot.scaling.setAll(0.85 + Math.random() * 0.4);
    this.ejectCasing();
    if (this.ammo === 0) this.startReload();
    return true;
  }

  /**
   * Pops one brass case out of the eject port: sideways off the rifle with a
   * random upward toss and tumble. Pool-starved shots just skip the case.
   */
  private ejectCasing(): void {
    const c = this.casings.find((c) => c.t <= 0);
    if (!c) return;
    const g = CONFIG.gunfeel;
    // The port is on the viewmodel, so this is a camera-space frame resolved
    // to world: the brass leaves the gun you can see and then falls in the
    // world, which is exactly where it should end up.
    const wm = this.view.rifle.root.getWorldMatrix();
    Vector3.TransformCoordinatesToRef(CASING_PORT, wm, c.mesh.position);
    Vector3.TransformNormalToRef(_casingDir.set(1, 0, -0.2), wm, c.vel);
    c.vel.normalize().scaleInPlace(g.casingEject * (0.8 + Math.random() * 0.4));
    c.vel.y += g.casingUp * (0.7 + Math.random() * 0.6);
    c.spin = (Math.random() * 2 - 1) * 25;
    c.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    c.t = g.casingLife;
    c.mesh.isVisible = !this.bodyHidden;
  }

  /**
   * Advances the flash strobe and the live brass. Cases fall ballistically
   * and come to rest on the ground plane under the player (an approximation
   * — they're never more than a toss away) until their lifetime expires.
   */
  private updateGunfeel(dt: number): void {
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) this.flashRoot.setEnabled(false);
    }
    const g = CONFIG.gunfeel;
    const restY = this.root.position.y - this.groundY + 0.02;
    for (const c of this.casings) {
      if (c.t <= 0) continue;
      c.t -= dt;
      if (c.t <= 0) {
        c.mesh.isVisible = false;
        continue;
      }
      if (c.vel.y !== 0 || c.mesh.position.y > restY) {
        c.vel.y -= g.casingGravity * dt;
        c.mesh.position.addInPlace(
          this.casingStep.copyFrom(c.vel).scaleInPlace(dt),
        );
        if (c.mesh.position.y <= restY && c.vel.y < 0) {
          c.mesh.position.y = restY;
          c.vel.setAll(0); // bounced to rest; tumble stops with it
          c.spin = 0;
        } else {
          c.mesh.rotation.x += c.spin * dt;
          c.mesh.rotation.z += c.spin * 0.7 * dt;
        }
      }
    }
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
    return this.view.muzzleWorld();
  }

  /** Returns true if this damage killed the player. */
  /**
   * Keeps `center`/`eyePos` current; called once per frame from `update`.
   *
   * Both ride the crouch blend, and they must ride it together. `eyePos` is
   * the camera, the line-of-sight target and the point bots aim at all at
   * once, so dropping it alone would leave the player harder to see and
   * *easier* to hit — every incoming round aimed at the middle of an unmoved
   * sphere instead of grazing its top. Moving `center` down by the same half
   * metre keeps the sphere's top the same 0.05 m above the eye it is when
   * standing, so the profile shrinks honestly.
   *
   * The collider capsule itself is untouched: `moveWithCollisions` is
   * horizontal-only and the ground probe places the feet, so a shorter body
   * would buy nothing and would need a stand-up clearance test to be safe.
   */
  private syncCombatant(): void {
    const c = CONFIG.player;
    const p = this.root.position;
    const feet = p.y - this.groundY;
    const centerH =
      this.groundY + (c.crouchCenterHeight - this.groundY) * this.crouchBlend;
    const eyeH =
      CONFIG.camera.eyeHeight +
      (c.crouchEyeHeight - CONFIG.camera.eyeHeight) * this.crouchBlend;
    this.center.set(p.x, feet + centerH, p.z);
    this.eyePos.set(p.x, feet + eyeH, p.z);
  }

  /**
   * `from` is the shooter's firing origin, forwarded straight back out through
   * `onDamaged` — the player controller has no use for it, but the HUD's
   * directional indicator does and this is the only path damage takes.
   */
  takeDamage(amount: number, from?: Vector3): boolean {
    if (!this.alive) return false;
    this.health = Math.max(0, this.health - amount);
    this.regenLockT = CONFIG.player.regenDelay;
    const died = this.health <= 0;
    if (died) this.alive = false;
    this.onDamaged(amount, died, from);
    return died;
  }

  heal(amount: number): void {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /**
   * Shows/hides everything the player renders — which in first person is the
   * viewmodel and its brass, nothing else. Hidden outside gameplay: the menu
   * and deploy screen sit over a live view of the world, and the editor flies
   * the same camera the weapon is parented to, so a visible rifle would ride
   * along in front of it.
   */
  setBodyHidden(hidden: boolean): void {
    this.bodyHidden = hidden;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    this.view.setVisible(!this.bodyHidden);
    // Live brass goes with it; the flash handles itself per shot via
    // flashRoot.setEnabled, and never fires while the weapon is hidden anyway.
    for (const c of this.casings) {
      c.mesh.isVisible = c.t > 0 && !this.bodyHidden;
    }
  }
}
