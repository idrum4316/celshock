/**
 * soldier/clipDriver.ts — Locomotion clip playback for the GLB body: picks
 * Walking vs Running from ground speed (with a hysteresis band), crossfades
 * weights smoothly, and scales playback speed so feet don't slide. Movement
 * DIRECTION matters too: a backward-dominant velocity plays the clip in
 * reverse (negative speedRatio), which reads as a backpedal instead of a
 * forward walk with the feet cycling the wrong way.
 * Called once per render from GlbSoldier's overlay; exposes idleW, which the
 * overlay also uses for the stance blend and the grip-calibration capture,
 * and stepDir, which the overlay uses to mirror the strafe hip-yaw while
 * backpedaling.
 */
import { AnimationGroup } from "@babylonjs/core";
import {
  BACKPEDAL_ENTER,
  CLIP_FULL_SPEED,
  RUN_ENTER,
  RUN_RATIO_MAX,
  RUN_RATIO_MIN,
  RUN_REF_SPEED,
  WALK_ENTER,
  WALK_RATIO_MAX,
  WALK_RATIO_MIN,
  WALK_REF_SPEED,
} from "./tuning";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export class ClipDriver {
  private walkW = 0;
  private runW = 0;
  /** 1 when standing still, 0 at full speed — read by the overlay. */
  idleW = 0;
  private band: "walk" | "run" = "walk";
  /**
   * Smoothed playback direction, +1 forward / -1 reversed. Eased rather than
   * snapped, so a forward/backpedal transition passes briefly through a slow
   * cycle (a stutter step) instead of popping the legs mid-stride.
   */
  private dir = 1;

  /**
   * Smoothed clip playback direction: +1 forward, -1 backpedal. Eased
   * between the two, so consumers (the strafe hip-yaw) also ease through
   * neutral during a forward/backpedal flip instead of snapping.
   */
  get stepDir(): number {
    return this.dir;
  }

  constructor(
    private readonly walk: AnimationGroup | null,
    private readonly run: AnimationGroup | null,
  ) {}

  /**
   * @param fwdSpeed velocity along the character's forward axis (m/s):
   *   negative and dominant means backpedal.
   */
  update(
    dt: number,
    groundSpeed: number,
    fwdSpeed: number,
    airBlend: number,
  ): void {
    const gs = groundSpeed;
    if (gs > RUN_ENTER) this.band = "run";
    else if (gs < WALK_ENTER) this.band = "walk";

    // Direction hysteresis: only a clear forward/backward signal flips the
    // playback sign, so pure strafing keeps whichever came last.
    const dirTarget =
      fwdSpeed < -BACKPEDAL_ENTER ? -1 : fwdSpeed > BACKPEDAL_ENTER ? 1 : this.dir > 0 ? 1 : -1;
    this.dir +=
      (dirTarget - this.dir) * Math.min(1, dt * (dirTarget === this.dir ? 4 : 10));

    const clipW = Math.min(1, gs / CLIP_FULL_SPEED) * (1 - airBlend * 0.8);
    const walkTarget = this.band === "walk" ? clipW : 0;
    const runTarget = this.band === "run" ? clipW : 0;
    const ease = (cur: number, target: number, rate: number) =>
      cur + (target - cur) * Math.min(1, dt * rate);
    this.walkW = ease(this.walkW, walkTarget, 8);
    this.runW = ease(this.runW, runTarget, 8);
    this.idleW = ease(this.idleW, 1 - Math.min(1, gs / 1.2), 5);

    // Airborne the clips are nearly weightless; keep the ratio positive so
    // the feet don't cycle backwards under the procedural air pose.
    const dir = airBlend > 0.6 ? 1 : this.dir;
    if (this.walk) {
      this.walk.setWeightForAllAnimatables(this.walkW);
      this.walk.speedRatio =
        dir * clamp(gs / WALK_REF_SPEED, WALK_RATIO_MIN, WALK_RATIO_MAX);
    }
    if (this.run) {
      this.run.setWeightForAllAnimatables(this.runW);
      this.run.speedRatio =
        dir * clamp(gs / RUN_REF_SPEED, RUN_RATIO_MIN, RUN_RATIO_MAX);
    }
  }
}
