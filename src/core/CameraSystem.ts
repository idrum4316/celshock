/**
 * CameraSystem.ts — Third-person over-the-shoulder camera: aim yaw/pitch, ADS
 * blend (distance/offset/FOV/sensitivity), recoil, per-shot view punch,
 * wall-occlusion pull-in.
 * Owns: the scene's active camera. Never goes first-person.
 * Invariants: recoil decay uses true Math.exp(-rate*dt) — NOT the frame-lerp
 * idiom — because burst climb must not vary with frame rate. Recoil only
 * partly springs back (CONFIG.recoil.recoverFraction); the rest is pushed into
 * the player's aim permanently — a deliberate product decision, not a bug.
 * The view punch (FOV spike / camera shove / jitter) is pure cosmetics: it is
 * applied only to the rendered camera, never to aimPitch/aimYaw, so bullets
 * and bots never see it. Occlusion pick filters metadata.solid === true.
 * Must run before mats.updateCamera()/lighting.update()/sfx.setListener()
 * in Game's frame order.
 */
import { FreeCamera, Ray, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import type { InputManager } from "./InputManager";

/**
 * Third-person over-the-shoulder camera. Aiming down sights never goes
 * first-person: the shoulder framing tightens instead — the camera pulls in
 * closer, recentres over the shoulder, and the FOV zooms. One blend drives
 * distance, offset, FOV, and look sensitivity together so the transition
 * reads as a single motion.
 */
export class CameraSystem {
  readonly camera: FreeCamera;
  yaw = 0;
  pitch = 0.12;
  /** 0 = hip, 1 = fully aimed (ADS). */
  adsBlend = 0;

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

  constructor(private scene: Scene) {
    this.camera = new FreeCamera("mainCamera", new Vector3(0, 3, -8), scene);
    this.camera.minZ = 0.05;
    this.camera.fov = CONFIG.camera.fovHip;
    this.camera.inputs.clear(); // fully driven by this system
    scene.activeCamera = this.camera;
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
   * `assist` is the gamepad aim-assist frame from `AimAssistSystem` (null
   * when inactive). Its slowdown is multiplied into the stick terms ONLY —
   * the mouse look path is deliberately never scaled — and its rotation is
   * applied on top of the player's own input, then clamped like any other.
   */
  update(
    dt: number,
    input: InputManager,
    playerPos: Vector3,
    assist: { stickMult: number; yaw: number; pitch: number } | null = null,
  ): void {
    const c = CONFIG.camera;

    // --- look ---
    const aiming = this.adsBlend > 0.5;
    const mouseMult = aiming ? c.adsMouseMult : 1;
    const stickMult = aiming ? c.adsStickMult : 1;
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
    this.adsBlend += (target - this.adsBlend) * Math.min(1, dt * c.adsBlendSpeed);
    const t = smoothstep(this.adsBlend);

    // --- positions: ADS tightens the shoulder framing (closer, slightly
    // less offset) rather than jumping to the eye. ---
    const dir = this.forward;
    const pivot = playerPos.add(new Vector3(0, c.pivotHeight, 0));
    const dist =
      c.thirdPersonDistance + (c.adsDistance - c.thirdPersonDistance) * t;
    const shoulder =
      c.shoulderOffset + (c.adsShoulderOffset - c.shoulderOffset) * t;
    const desired = pivot
      .subtract(dir.scale(dist))
      .add(this.flatRight.scale(shoulder));

    // Pull the camera in when a wall would occlude it.
    let pos = desired;
    const toCam = desired.subtract(pivot);
    const len = toCam.length();
    if (len > 0.001) {
      const rayDir = toCam.scale(1 / len);
      const ray = new Ray(pivot, rayDir, len + 0.3);
      const hit = this.scene.pickWithRay(ray, (m) => !!m.metadata && m.metadata.solid === true);
      if (hit && hit.hit && hit.distance < len + 0.3) {
        pos = pivot.add(rayDir.scale(Math.max(0.4, hit.distance - 0.35)));
      }
    }

    // --- view punch: FOV spike, backward shove, and jitter on the rendered
    // camera only. aimPitch/aimYaw are untouched, so tracers, hitscan, and
    // the audio listener never see the shake. ---
    const r = CONFIG.recoil;
    const punch = this.punchT * this.punchT;
    if (punch > 0) {
      pos = pos.subtract(dir.scale(r.camPush * punch));
    }

    this.camera.position.copyFrom(pos);
    if (punch > 0) {
      const shPitch = (Math.random() * 2 - 1) * r.shakePitch * punch;
      const shYaw = (Math.random() * 2 - 1) * r.shakeYaw * punch;
      const sp = this.aimPitch + shPitch;
      const sy = this.aimYaw + shYaw;
      const cp = Math.cos(sp);
      this.camera.setTarget(
        pos.add(new Vector3(cp * Math.sin(sy), Math.sin(sp), cp * Math.cos(sy))),
      );
    } else {
      this.camera.setTarget(pos.add(dir));
    }
    this.camera.fov = c.fovHip + (c.fovAds - c.fovHip) * t + r.fovPunch * punch;
  }
}

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}
