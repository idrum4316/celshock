import { FreeCamera, Ray, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import type { InputManager } from "./InputManager";

/**
 * Third-person over-the-shoulder camera that blends seamlessly into a
 * first-person view while aiming down sights. The blend drives position,
 * FOV, and look sensitivity together so the transition reads as one motion.
 */
export class CameraSystem {
  readonly camera: FreeCamera;
  yaw = 0;
  pitch = 0.12;
  /** 0 = fully third-person, 1 = fully first-person (ADS). */
  adsBlend = 0;

  constructor(private scene: Scene) {
    this.camera = new FreeCamera("mainCamera", new Vector3(0, 3, -8), scene);
    this.camera.minZ = 0.05;
    this.camera.fov = CONFIG.camera.fovHip;
    this.camera.inputs.clear(); // fully driven by this system
    scene.activeCamera = this.camera;
  }

  /** World-space aim direction (through the crosshair). */
  get forward(): Vector3 {
    const cp = Math.cos(this.pitch);
    return new Vector3(
      cp * Math.sin(this.yaw),
      Math.sin(this.pitch),
      cp * Math.cos(this.yaw),
    );
  }

  /** Yaw-only forward, for movement on the ground plane. */
  get flatForward(): Vector3 {
    return new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  get flatRight(): Vector3 {
    return new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  /** True once the blend is close enough to hide the player body. */
  get isFirstPerson(): boolean {
    return this.adsBlend > 0.6;
  }

  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = 0.12;
    this.adsBlend = 0;
  }

  update(dt: number, input: InputManager, playerPos: Vector3): void {
    const c = CONFIG.camera;

    // --- look ---
    const nearFp = this.adsBlend > 0.5;
    const mouseMult = nearFp ? c.adsMouseMult : 1;
    const stickMult = nearFp ? c.adsStickMult : 1;
    this.yaw += input.mouseLookX * c.sensX * mouseMult;
    this.pitch -= input.mouseLookY * c.sensY * mouseMult;
    this.yaw += input.stickLookX * c.stickSensX * stickMult * dt;
    this.pitch -= input.stickLookY * c.stickSensY * stickMult * dt;
    this.pitch = Math.max(c.pitchMin, Math.min(c.pitchMax, this.pitch));

    // --- ADS blend (exponential ease toward target) ---
    const target = input.ads ? 1 : 0;
    this.adsBlend += (target - this.adsBlend) * Math.min(1, dt * c.adsBlendSpeed);
    const t = smoothstep(this.adsBlend);

    // --- positions ---
    const dir = this.forward;
    const pivot = playerPos.add(new Vector3(0, c.pivotHeight, 0));
    const desired = pivot
      .subtract(dir.scale(c.thirdPersonDistance))
      .add(this.flatRight.scale(c.shoulderOffset));

    // Pull the third-person camera in when a wall would occlude it.
    let thirdPos = desired;
    const toCam = desired.subtract(pivot);
    const len = toCam.length();
    if (len > 0.001) {
      const rayDir = toCam.scale(1 / len);
      const ray = new Ray(pivot, rayDir, len + 0.3);
      const hit = this.scene.pickWithRay(ray, (m) => !!m.metadata && m.metadata.solid === true);
      if (hit && hit.hit && hit.distance < len + 0.3) {
        thirdPos = pivot.add(rayDir.scale(Math.max(0.4, hit.distance - 0.35)));
      }
    }

    const fpPos = playerPos
      .add(new Vector3(0, c.fpHeight, 0))
      .add(dir.scale(0.15));

    const pos = Vector3.Lerp(thirdPos, fpPos, t);
    this.camera.position.copyFrom(pos);
    this.camera.setTarget(pos.add(dir));
    this.camera.fov = c.fovHip + (c.fovAds - c.fovHip) * t;
  }
}

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}
