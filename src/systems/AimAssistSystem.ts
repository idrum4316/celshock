import { Ray, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import type { InputManager } from "../core/InputManager";

/**
 * Structural subset of `Hittable` (CombatSystem), declared here so this
 * system doesn't import another system. Anything hitscan can target works.
 */
export interface AimTarget {
  readonly center: Vector3;
  readonly invulnerable?: boolean;
}

/** One frame of aim assist, consumed by `CameraSystem.update`. */
export interface AssistFrame {
  /** Multiplier applied to the stick look terms only — never the mouse. */
  stickMult: number;
  /** Camera rotation to add this frame (radians, already dt-scaled). */
  yaw: number;
  pitch: number;
}

/**
 * Gamepad aim assist: a slowdown bubble around enemies plus a gentle
 * rotational pull toward the acquired target. The pull is defeatable by
 * design — pushing the look stick against it cancels it in proportion to
 * deflection, so a committed push always breaks free of the target even
 * though the raw pull rate exceeds the slowed stick rate.
 *
 * Keyboard/mouse is unaffected by construction (see `CONFIG.aimAssist`):
 * the whole system returns null unless a gamepad is connected AND the pad
 * produced the most recent input activity, so a single mouse movement
 * disengages it the same frame — and even while engaged, the slowdown is
 * only ever multiplied into the stick terms of the camera update.
 *
 * Costs at most one ray pick per frame: candidates are filtered by angle
 * first, and only the winner is tested against `solid` colliders — the same
 * pick hitscan uses, so the assist never pulls through a wall.
 */
export class AimAssistSystem {
  /** The device that produced the most recent look input. */
  private lastDevice: "mouse" | "stick" = "mouse";

  constructor(private scene: Scene) {}

  /**
   * Computes this frame's assist, or null when inactive. Call immediately
   * before `CameraSystem.update`, with the camera's current pose.
   *
   * `targets` is the shooter's enemy list (the same one hitscan fires at);
   * it is read synchronously and never retained, so a reused scratch array
   * is safe to pass.
   */
  update(
    dt: number,
    input: InputManager,
    camPos: Vector3,
    forward: Vector3,
    aimYaw: number,
    aimPitch: number,
    targets: readonly AimTarget[],
  ): AssistFrame | null {
    // Device arbitration. Any mouse movement disengages instantly; any real
    // pad activity (stick past the deadzone, or any pad button — e.g. holding
    // LT to ADS) claims it back. An idle pad next to a mouse player engages
    // nothing, and with no pad connected there is no assist at all.
    if (input.mouseLookX !== 0 || input.mouseLookY !== 0) {
      this.lastDevice = "mouse";
    } else if (input.padActive) {
      this.lastDevice = "stick";
    }
    if (!input.gamepadConnected || this.lastDevice !== "stick") return null;

    const a = CONFIG.aimAssist;

    // --- acquire: the live enemy nearest the crosshair inside the cone ---
    const cosCone = Math.cos(a.acquireAngle);
    let best: AimTarget | null = null;
    let bestDot = cosCone; // a candidate must beat the cone threshold to win
    for (const t of targets) {
      if (t.invulnerable) continue;
      const to = t.center.subtract(camPos);
      const distSq = to.lengthSquared();
      if (distSq > a.maxDistance * a.maxDistance || distSq < 0.25) continue;
      const dot = Vector3.Dot(forward, to.scale(1 / Math.sqrt(distSq)));
      if (dot > bestDot) {
        best = t;
        bestDot = dot;
      }
    }
    if (!best) return null;

    // --- LOS: the same solid-collider pick hitscan uses, so walls win ---
    const toTarget = best.center.subtract(camPos);
    const dist = toTarget.length();
    const dir = toTarget.scale(1 / dist);
    const wall = this.scene.pickWithRay(
      new Ray(camPos, dir, dist),
      (m) => !!m.metadata && m.metadata.solid === true,
    );
    if (wall && wall.hit) return null;

    // --- rotation: full pull in ADS; at hip only while firing or steering
    // with the stick, so a resting hip camera never rotates on its own ---
    const stickActive = input.stickLookX !== 0 || input.stickLookY !== 0;
    const speed = input.ads
      ? a.rotateAdsSpeed
      : input.fire || stickActive
        ? a.rotateHipSpeed
        : 0;

    let yaw = 0;
    let pitch = 0;
    if (speed > 0) {
      // Solve the yaw/pitch that would put the crosshair on the target,
      // then approach it at the capped rate — a pull, never a snap.
      const wantYaw = Math.atan2(dir.x, dir.z);
      const wantPitch = Math.asin(clamp(dir.y, -1, 1));
      const cap = speed * dt;
      yaw = clamp(wrapPi(wantYaw - aimYaw), -cap, cap);
      pitch = clamp((wantPitch - aimPitch) * a.verticalMult, -cap, cap);

      // The pull must be defeatable: ADS pull speed deliberately exceeds the
      // slowed stick rate, so without this the target would be inescapable.
      // Stick deflection AGAINST the pull cancels it proportionally — full
      // stick away means no pull at all, so a committed push always walks
      // the crosshair out of the acquire cone and drops the target, while a
      // resting stick keeps the full sticky track. (Stick signs match
      // CameraSystem: +lookX turns +yaw, +lookY turns -pitch.)
      yaw *= 1 - clamp(-Math.sign(yaw) * input.stickLookX, 0, 1);
      pitch *= 1 - clamp(Math.sign(pitch) * input.stickLookY, 0, 1);
    }

    return { stickMult: a.slowdownMult, yaw, pitch };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Wraps an angle to [-PI, PI] so the pull takes the short way around. */
function wrapPi(v: number): number {
  return Math.atan2(Math.sin(v), Math.cos(v));
}
