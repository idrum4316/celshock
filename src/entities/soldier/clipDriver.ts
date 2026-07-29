/**
 * soldier/clipDriver.ts — Locomotion clip playback for the GLB body: picks
 * Walking vs Running from ground speed (with a hysteresis band), crossfades
 * weights smoothly, and scales playback speed so feet don't slide.
 * Called once per render from GlbSoldier's overlay; exposes idleW, which the
 * overlay also uses for the stance blend and the grip-calibration capture.
 */
import { AnimationGroup } from "@babylonjs/core";
import {
  CLIP_FULL_SPEED,
  RUN_ENTER,
  RUN_REF_SPEED,
  WALK_ENTER,
  WALK_REF_SPEED,
} from "./tuning";

export class ClipDriver {
  private walkW = 0;
  private runW = 0;
  /** 1 when standing still, 0 at full speed — read by the overlay. */
  idleW = 0;
  private band: "walk" | "run" = "walk";

  constructor(
    private readonly walk: AnimationGroup | null,
    private readonly run: AnimationGroup | null,
  ) {}

  update(dt: number, groundSpeed: number, airBlend: number): void {
    const gs = groundSpeed;
    if (gs > RUN_ENTER) this.band = "run";
    else if (gs < WALK_ENTER) this.band = "walk";

    const clipW = Math.min(1, gs / CLIP_FULL_SPEED) * (1 - airBlend * 0.8);
    const walkTarget = this.band === "walk" ? clipW : 0;
    const runTarget = this.band === "run" ? clipW : 0;
    const ease = (cur: number, target: number, rate: number) =>
      cur + (target - cur) * Math.min(1, dt * rate);
    this.walkW = ease(this.walkW, walkTarget, 8);
    this.runW = ease(this.runW, runTarget, 8);
    this.idleW = ease(this.idleW, 1 - Math.min(1, gs / 1.2), 5);

    if (this.walk) {
      this.walk.setWeightForAllAnimatables(this.walkW);
      this.walk.speedRatio = Math.min(1.4, Math.max(0.5, gs / WALK_REF_SPEED));
    }
    if (this.run) {
      this.run.setWeightForAllAnimatables(this.runW);
      this.run.speedRatio = Math.min(1.8, Math.max(0.6, gs / RUN_REF_SPEED));
    }
  }
}
