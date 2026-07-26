import { FreeCamera, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { addOutline } from "../shaders/CelShader";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { CameraSystem } from "../core/CameraSystem";
import type { InputManager } from "../core/InputManager";
import type { Player } from "./Player";
import { buildRifle, RifleParts } from "./RifleModel";

/**
 * First-person rifle rendered while aiming down sights. Parented to the
 * camera; as the camera blend approaches first-person the rifle raises from
 * a lowered ready pose into a sight picture where the holographic window is
 * centered exactly on the aim axis. Adds look sway, walk bob, a reload dip,
 * and a recoil kick.
 *
 * Rendered in group 1 (depth cleared between groups) so the rifle never
 * clips into nearby walls.
 */
export class Viewmodel {
  private parts: RifleParts;
  private visible = false;

  private readonly adsPos: Vector3;
  private readonly hipPos: Vector3;
  private readonly hipRot: Vector3;

  private kickT = 0;
  private reloadBlend = 0;
  private swayX = 0;
  private swayY = 0;
  private bobPhase = 0;

  constructor(scene: Scene, mats: CelMaterialFactory, camera: FreeCamera) {
    const v = CONFIG.viewmodel;
    this.parts = buildRifle(scene, mats, "vm");
    this.parts.root.parent = camera;
    for (const m of this.parts.meshes) {
      m.renderingGroupId = 1;
      m.isVisible = false;
      // Thin: at ADS range the sight hood's walls are only a few millimetres,
      // so a heavier outline doubles their apparent thickness.
      addOutline(m, 0.0012);
    }

    // Place the root so the sight window center lands on the camera axis
    // (camera-local (0, 0, adsSightDistance)) when fully aimed.
    const sc = this.parts.sightCenter.position;
    this.adsPos = new Vector3(-sc.x, -sc.y, v.adsSightDistance - sc.z);
    this.hipPos = new Vector3(...v.hipPos);
    this.hipRot = new Vector3(...v.hipRot);
  }

  setVisible(show: boolean): void {
    if (show === this.visible) return;
    this.visible = show;
    for (const m of this.parts.meshes) m.isVisible = show;
  }

  /** Recoil impulse — call on each shot fired while aiming. */
  kick(): void {
    this.kickT = 1;
  }

  muzzleWorld(): Vector3 {
    return this.parts.muzzle.getAbsolutePosition().clone();
  }

  update(dt: number, cam: CameraSystem, input: InputManager, player: Player): void {
    this.setVisible(cam.isFirstPerson);
    if (!this.visible) return;

    const v = CONFIG.viewmodel;
    const ease = (current: number, target: number, rate: number) =>
      current + (target - current) * Math.min(1, dt * rate);

    // Raise blend: 0 at the third->first person handoff, 1 fully sighted.
    const raw = Math.min(1, Math.max(0, (cam.adsBlend - 0.6) / 0.4));
    const t = raw * raw * (3 - 2 * raw);

    this.kickT = Math.max(0, this.kickT - dt / v.kickTime);
    this.reloadBlend = ease(this.reloadBlend, player.reloading ? 1 : 0, 12);

    // Look sway lags the aim; walk bob follows the stick/keys.
    this.swayX = ease(this.swayX, clamp(-input.mouseLookX * 0.0012, 0.015), 10);
    this.swayY = ease(this.swayY, clamp(input.mouseLookY * 0.0012, 0.015), 10);
    const moveAmt = Math.min(1, Math.hypot(input.moveX, input.moveY));
    this.bobPhase += dt * 8.5 * moveAmt;
    const bob = 0.004 * Math.sin(this.bobPhase * 2) * moveAmt * (1 - 0.6 * t);

    const kick = this.kickT * this.kickT;
    const pos = Vector3.Lerp(this.hipPos, this.adsPos, t);
    pos.x += this.swayX * (1 - 0.5 * t) + 0.03 * this.reloadBlend;
    pos.y += this.swayY * (1 - 0.5 * t) + bob - 0.14 * this.reloadBlend;
    pos.z -= v.kickBack * kick;

    // Reload drops and cants the rifle rather than pitching it — the stock
    // sits at the camera's near plane, so any pitch-up fills the screen.
    const rot = this.hipRot.scale(1 - t);
    rot.x += -v.kickPitch * kick + 0.12 * this.reloadBlend;
    rot.z += 0.4 * this.reloadBlend;

    this.parts.root.position.copyFrom(pos);
    this.parts.root.rotation.copyFrom(rot);
  }
}

function clamp(x: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, x));
}
