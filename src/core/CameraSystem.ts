/**
 * CameraSystem.ts — First-person camera: aim yaw/pitch, ADS blend (FOV +
 * sensitivity), recoil, per-shot view punch, head bob.
 * Owns: the scene's active camera. The camera sits AT the player's eye — it
 * never leaves the head, so there is no occlusion pick and no pull-in.
 * How far ADS zooms, how much it slows the look, and how fast it gets there
 * all belong to the LOADOUT (`setLoadout`), not to CONFIG.camera — the
 * camera's own numbers are the hip-fire ones. Zoom and sensitivity are the
 * optic's alone; only the blend RATE is shared with the weapon, because how
 * fast a sight comes up is a fact about the weight in your hands as well as
 * about the glass on top of it.
 * Invariants: recoil decay uses true Math.exp(-rate*dt) — NOT the frame-lerp
 * idiom — because burst climb must not vary with frame rate. Recoil only
 * partly springs back (CONFIG.recoil.recoverFraction); the rest is pushed into
 * the player's aim permanently — a deliberate product decision, not a bug.
 * The view punch (FOV spike / camera shove / jitter) and the head bob are pure
 * cosmetics: they are applied only to the rendered camera, never to
 * aimPitch/aimYaw, so bullets and bots never see them.
 * Must run before mats.updateCamera()/lighting.update()/sfx.setListener()
 * in Game's frame order.
 */
import { FreeCamera, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import {
  DEFAULT_SIGHT,
  sightSetup,
  type SightId,
  type SightSetup,
} from "../entities/sights";
import { DEFAULT_WEAPON, weaponSetup, type WeaponId } from "../entities/weapons";
import type { InputManager } from "./InputManager";

/**
 * First-person camera. Aiming down sights brings the weapon's sight onto the
 * camera axis (ViewModel's job) while this system zooms the FOV, slows the
 * look, and damps the bob — one blend drives all three so the transition
 * reads as a single motion.
 */
export class CameraSystem {
  readonly camera: FreeCamera;
  yaw = 0;
  pitch = 0.12;
  /** 0 = hip, 1 = fully aimed (ADS). */
  adsBlend = 0;

  /**
   * The fitted optic's resolved numbers: aimed FOV, look multipliers, and how
   * fast the blend converges. Everything ADS does about zoom comes from here
   * rather than from CONFIG.camera, so a loadout change is one assignment.
   */
  private sight: SightSetup = sightSetup(DEFAULT_SIGHT);
  /**
   * The carried weapon's share of the ADS blend rate. How fast a sight comes
   * up is the optic's `adsSpeedMult` times this — a scope is slow on either
   * weapon, and either weapon raises the same scope at its own pace. Nothing
   * else about the gun reaches the camera.
   */
  private weaponAdsMult = weaponSetup(DEFAULT_WEAPON).adsSpeedMult;

  /**
   * Head-bob phase, in radians, advanced by travel rather than by time.
   * Public because the viewmodel bobs on the SAME phase — two integrators fed
   * the same drive would drift apart and the weapon would swim against the
   * view. ViewModel reads it one frame late (Player updates before the
   * camera does), which is 16 ms of a 0.8 s cycle.
   */
  bobPhase = 0;
  /** Smoothed 0..1 movement drive for the bob, pushed by Player each frame. */
  private bobAmount = 0;
  private bobTarget = 0;

  /**
   * The springy part of the recoil, stacked on top of the player's own aim
   * and decaying back to zero. The rest of each kick goes straight into
   * `pitch`/`yaw` and stays there — see `addRecoil`.
   */
  private recoilPitch = 0;
  private recoilYaw = 0;
  /**
   * View punch, 1 at the shot and falling to 0 over `recoil.punchTime`.
   * Squared before use so the spike is at the impact frame.
   */
  private punchT = 0;

  /** Scratch for the rendered camera position — no per-frame allocation. */
  private readonly eye = new Vector3();

  constructor(scene: Scene) {
    this.camera = new FreeCamera("mainCamera", new Vector3(0, 3, -8), scene);
    this.camera.minZ = 0.05;
    this.camera.fov = CONFIG.camera.fovHip;
    this.camera.inputs.clear(); // fully driven by this system
    scene.activeCamera = this.camera;
  }

  /** Takes the whole loadout. Cheap enough to call on every change. */
  setLoadout(weapon: WeaponId, sight: SightId): void {
    this.sight = sightSetup(sight);
    this.weaponAdsMult = weaponSetup(weapon).adsSpeedMult;
  }

  /** Where the weapon is actually pointed: the player's aim plus recoil. */
  get aimPitch(): number {
    return this.pitch + this.recoilPitch;
  }

  get aimYaw(): number {
    return this.yaw + this.recoilYaw;
  }

  /** World-space aim direction (through the crosshair). */
  get forward(): Vector3 {
    const cp = Math.cos(this.aimPitch);
    return new Vector3(
      cp * Math.sin(this.aimYaw),
      Math.sin(this.aimPitch),
      cp * Math.cos(this.aimYaw),
    );
  }

  /** Yaw-only forward, for movement on the ground plane. Deliberately the
   * un-recoiled yaw: strafing must not swim while the gun is kicking. */
  get flatForward(): Vector3 {
    return new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  get flatRight(): Vector3 {
    return new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = 0.12;
    this.adsBlend = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.punchT = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.bobTarget = 0;
  }

  /**
   * This frame's bob drive: 0 standing, 1 at full ground speed. Pushed by
   * Player (which owns the movement) before the camera updates; airborne is
   * simply zero, because feet that aren't on the ground aren't striding.
   */
  setBobDrive(speed01: number, grounded: boolean): void {
    this.bobTarget = grounded ? Math.max(0, Math.min(1, speed01)) : 0;
  }

  /**
   * Fires the cosmetic view punch; called once per shot. Unlike `addRecoil`
   * this touches nothing the bullets read — it is FOV, a small backward
   * shove, and high-frequency jitter on the rendered camera only.
   */
  addPunch(): void {
    this.punchT = 1;
  }

  /**
   * Kicks the aim; called once per shot fired. Each kick is split: most of it
   * springs back on its own, but `1 - recoverFraction` of it is added to the
   * player's own aim and never comes back, which is what actually walks the
   * muzzle off target over a long burst. The permanent part moves `yaw` too,
   * so the character turns with it — the same as any other look input.
   */
  addRecoil(pitch: number, yaw: number): void {
    const r = CONFIG.recoil;
    const keep = 1 - r.recoverFraction;
    this.pitch += pitch * keep;
    this.yaw += yaw * keep;
    this.recoilPitch = Math.min(
      r.maxPitch,
      this.recoilPitch + pitch * r.recoverFraction,
    );
    this.recoilYaw = Math.max(
      -r.maxYaw,
      Math.min(r.maxYaw, this.recoilYaw + yaw * r.recoverFraction),
    );
  }

  /**
   * `eyePos` is the player's eye in world space — the camera goes there
   * outright, offset only by the cosmetic bob and punch.
   *
   * `assist` is the gamepad aim-assist frame from `AimAssistSystem` (null
   * when inactive). Its slowdown is multiplied into the stick terms ONLY —
   * the mouse look path is deliberately never scaled — and its rotation is
   * applied on top of the player's own input, then clamped like any other.
   */
  update(
    dt: number,
    input: InputManager,
    eyePos: Vector3,
    assist: { stickMult: number; yaw: number; pitch: number } | null = null,
  ): void {
    const c = CONFIG.camera;

    // --- look ---
    const aiming = this.adsBlend > 0.5;
    const mouseMult = aiming ? this.sight.mouseMult : 1;
    const stickMult = aiming ? this.sight.stickMult : 1;
    const assistMult = assist ? assist.stickMult : 1;
    this.yaw += input.mouseLookX * c.sensX * mouseMult;
    this.pitch -= input.mouseLookY * c.sensY * mouseMult;
    this.yaw += input.stickLookX * c.stickSensX * stickMult * assistMult * dt;
    this.pitch -= input.stickLookY * c.stickSensY * stickMult * assistMult * dt;
    if (assist) {
      this.yaw += assist.yaw;
      this.pitch += assist.pitch;
    }
    this.pitch = Math.max(c.pitchMin, Math.min(c.pitchMax, this.pitch));

    // --- recoil settles back toward the player's own aim ---
    // A true exponential, not the frame-lerp used for the cosmetic blends:
    // this one moves where the bullets go, so how high a burst climbs must
    // not depend on the frame rate.
    const settle = Math.exp(-CONFIG.recoil.recovery * dt);
    this.recoilPitch *= settle;
    this.recoilYaw *= settle;

    // --- view punch decays (cosmetic — safe to use a plain time decay) ---
    this.punchT = Math.max(0, this.punchT - dt / CONFIG.recoil.punchTime);

    // --- ADS blend (exponential ease toward target) ---
    const target = input.ads ? 1 : 0;
    this.adsBlend +=
      (target - this.adsBlend) *
      Math.min(1, dt * this.sight.blendSpeed * this.weaponAdsMult);
    const t = smoothstep(this.adsBlend);

    // --- head bob: phase advances with travel, amplitude eases with intent ---
    this.bobAmount +=
      (this.bobTarget - this.bobAmount) * Math.min(1, dt * c.bobSmooth);
    this.bobPhase = (this.bobPhase + dt * c.bobRate * this.bobAmount) % (Math.PI * 2);
    const bobW = this.bobAmount * (1 - (1 - c.bobAdsMult) * t);

    // --- position: the eye, plus the two cosmetic offsets ---
    const dir = this.forward;
    this.eye.copyFrom(eyePos);
    if (bobW > 0.001) {
      // Vertical at twice the lateral rate: one dip per footfall, one sway
      // per stride. The lateral term rides the flat right axis so it stays
      // level with the horizon when looking up or down.
      const right = this.flatRight;
      this.eye.y += Math.sin(this.bobPhase * 2) * c.bobVertical * bobW;
      this.eye.addInPlace(
        right.scale(Math.sin(this.bobPhase) * c.bobLateral * bobW),
      );
    }
    const r = CONFIG.recoil;
    const punch = this.punchT * this.punchT;
    if (punch > 0) {
      this.eye.subtractInPlace(dir.scale(r.camPush * punch));
    }

    this.camera.position.copyFrom(this.eye);
    if (punch > 0) {
      const shPitch = (Math.random() * 2 - 1) * r.shakePitch * punch;
      const shYaw = (Math.random() * 2 - 1) * r.shakeYaw * punch;
      const sp = this.aimPitch + shPitch;
      const sy = this.aimYaw + shYaw;
      const cp = Math.cos(sp);
      this.camera.setTarget(
        this.eye.add(
          new Vector3(cp * Math.sin(sy), Math.sin(sp), cp * Math.cos(sy)),
        ),
      );
    } else {
      this.camera.setTarget(this.eye.add(dir));
    }
    this.camera.fov =
      c.fovHip + (this.sight.fovAds - c.fovHip) * t + r.fovPunch * punch;
  }
}

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}
