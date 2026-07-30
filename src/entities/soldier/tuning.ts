/**
 * soldier/tuning.ts — Art/tuning constants for the player's GLB body
 * (GlbSoldier) and the SoldierPoseParams contract Player feeds it.
 * Pure data, no logic. The CARRY / RIFLE_OFFSET / hand-frame numbers are
 * measured against ONE specific asset (models/*.glb) in the model viewer —
 * see CLAUDE.md. Changing the asset means re-measuring those, not guessing.
 * The locomotion/lean/air/reload-phase numbers are style tuning: measured
 * against the same clips, but safe to adjust by eye.
 */
import { Vector3 } from "@babylonjs/core";
import { CONFIG } from "../../config";

/** Per-frame inputs, mirrored from the values Player.animate already smooths. */
export interface SoldierPoseParams {
  /** Actual ground speed (m/s): config speed scaled by move input. */
  groundSpeed: number;
  /** Smoothed move-input magnitude 0..1. */
  moveBlend: number;
  /** Smoothed airborne weight 0..1. */
  airBlend: number;
  /** Smoothed reload weight 0..1. */
  reloadBlend: number;
  /** Camera aim pitch (rad, + up), recoil included. */
  aimPitch: number;
  /** Weapon punch 0..1 (weaponKickT squared). */
  kick: number;
  /** Free-running clock for the idle breath sway. */
  idleT: number;
  /** Smoothed velocity in character space (m/s), +x right: strafe/lean. */
  localVelX: number;
  /** Smoothed velocity in character space (m/s), +z forward: backpedal. */
  localVelZ: number;
  /** Vertical velocity (m/s, + up): jump tuck on the rise, reach on the fall. */
  velY: number;
  /** Reload cycle progress 0..1 (1 when not reloading). */
  reloadPhase: number;
  /** Smoothed sprint weight 0..1: forward lean and clip choice. */
  sprintBlend: number;
  /** Camera yaw rate (rad/s), smoothed: torso follow-through lag. */
  turnRate: number;
}

/** Bind-pose height in model units, measured from the GLB's bounds. */
export const MODEL_HEIGHT = 1.67;
/** Uniform scale that makes the asset fill the 1.8 m player capsule. */
export const MODEL_SCALE = CONFIG.player.height / MODEL_HEIGHT;
/** Extra yaw so the model's authored facing matches the capsule's +Z. */
export const FACE_YAW = 0;

/**
 * Ground speeds (m/s) that pick the clip, with a hysteresis band between.
 * The jog (4.6) sits in the run band — a combat jog is a run, and the walk
 * clip at 1.05 speed read as a scurrying power-walk.
 */
export const WALK_ENTER = 3.4;
export const RUN_ENTER = 4.2;
/**
 * Speeds at which each clip plays at speedRatio 1 (no foot-slide). The run
 * reference is deliberately ABOVE the jog: sprint then peaks at ratio ~1.2
 * instead of 1.5 — high cadence + short stride + upright torso was the
 * "toddler run". Slight foot slide at sprint is the acceptable price.
 */
export const WALK_REF_SPEED = 4.4;
export const RUN_REF_SPEED = 5.8;
/** Playback-speed clamps per clip (keeps reversals and slow walks sane). */
export const WALK_RATIO_MIN = 0.5;
export const WALK_RATIO_MAX = 1.4;
export const RUN_RATIO_MIN = 0.6;
export const RUN_RATIO_MAX = 1.35;

/** Clip weight ramps in over this ground speed (below it the stance wins). */
export const CLIP_FULL_SPEED = 2.5;

/**
 * Backpedal detection: forward speed (character space) must cross ±this to
 * flip the clip's playback direction — a hysteresis so strafing through
 * zero forward speed doesn't stutter the feet.
 */
export const BACKPEDAL_ENTER = 0.6;

/**
 * Lower/upper-body split for strafe: the hips yaw toward the velocity
 * direction (clamped, and mirrored by the clip's playback direction — a
 * backpedal steps backward in hip space) while the spine chain
 * counter-rotates onto the camera. Legs then walk "forward" in hip space,
 * which reads as a side-step; the arms are procedurally pinned so they
 * don't care.
 */
export const HIP_YAW_MAX = 1.05;
/** Share of the hips yaw each spine link gives back (must sum to 1). */
export const HIP_YAW_COUNTER = { spine: 0.4, spine1: 0.35, spine2: 0.25 };

/** Velocity-based torso lean: sprint tips forward, backpedal leans back. */
export const SPRINT_LEAN = 0.14;
export const BACKPEDAL_LEAN = 0.07;
/** Sideways roll into a strafe (rad at full jog speed). */
export const STRAFE_ROLL = 0.08;
/** Torso follow-through when the camera yaws (rad per rad/s, clamped). */
export const TURN_SWAY = 0.05;
export const TURN_SWAY_MAX = 0.12;

/**
 * Airborne pose (about the character's right axis; + swings a leg back, so
 * a knee raise is negative). Rise tucks the knees up, fall reaches the
 * legs down, and there's a small base crouch so the apex isn't a statue.
 */
export const AIR_TUCK_THIGH = 0.55;
export const AIR_TUCK_KNEE = 0.85;
export const AIR_REACH_THIGH = 0.22;
export const AIR_REACH_KNEE = 0.15;
export const AIR_BASE_THIGH = 0.06;
export const AIR_BASE_KNEE = 0.1;

/**
 * Two-handed rifle carry, as world-space direction targets in character
 * space (+z forward, +x right, +y up): which way each arm segment points.
 * Tuned in the model viewer (see CLAUDE.md) against the asset's skeleton.
 */
export const CARRY = {
  upperR: new Vector3(0.22, -0.72, 0.65),
  lowerR: new Vector3(-0.08, -0.2, 0.98),
  upperL: new Vector3(-0.15, -0.5, 0.85),
  lowerL: new Vector3(0.42, 0.08, 0.9),
};
/** How much of the aim pitch the arms inherit, so the rifle tracks the camera. */
export const ARM_PITCH_FOLLOW = 0.85;
/** Extra downward tip for the left arm while reloading (drops to the mag). */
export const RELOAD_ARM_DROP = 0.9;
/** Rifle tip-down while reloading, applied through the right arm. */
export const RELOAD_RIFLE_DROP = 0.5;

/**
 * Phased reload: the support hand leaves the handguard for the magazine
 * well inside this progress window (in / out are smoothstep edges), the
 * head glances down at it, and the mag seat gets a small wiggle.
 */
export const RELOAD_MAG_IN = [0.12, 0.32] as const;
export const RELOAD_MAG_OUT = [0.6, 0.85] as const;
export const RELOAD_SEAT = [0.42, 0.68] as const;
export const HEAD_GLANCE = 0.3;
/** Magazine well offset from the rifle origin, in rifle-frame metres. */
export const MAG_FORWARD = 0.04;
export const MAG_DOWN = 0.1;

/** Rifle offset in the right-hand joint's frame (position in metres). The
 * euler maps the hand's basis onto "barrel forward, top rail up"; measured
 * against the asset's carry pose in the model viewer. */
export const RIFLE_OFFSET = {
  pos: new Vector3(0, -0.02, 0.02),
  euler: new Vector3(-1.268, 2.987, 2.405),
  scale: 0.85,
};
/** Distance from the rifle origin to the handguard hold (left-hand target). */
export const HANDGUARD_FORWARD = 0.2;
