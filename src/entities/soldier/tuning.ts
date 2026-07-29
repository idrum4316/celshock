/**
 * soldier/tuning.ts — Art/tuning constants for the player's GLB body
 * (GlbSoldier) and the SoldierPoseParams contract Player feeds it.
 * Pure data, no logic. These are measured against ONE specific asset
 * (models/*.glb) in the model viewer — see CLAUDE.md. Changing the asset
 * means re-measuring CARRY / RIFLE_OFFSET, not guessing.
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
}

/** Bind-pose height in model units, measured from the GLB's bounds. */
export const MODEL_HEIGHT = 1.67;
/** Uniform scale that makes the asset fill the 1.8 m player capsule. */
export const MODEL_SCALE = CONFIG.player.height / MODEL_HEIGHT;
/** Extra yaw so the model's authored facing matches the capsule's +Z. */
export const FACE_YAW = 0;

/** Ground speeds (m/s) that pick the clip, with a hysteresis band between. */
export const WALK_ENTER = 4.8;
export const RUN_ENTER = 5.5;
/** Speeds at which each clip plays at speedRatio 1 (no foot-slide). */
export const WALK_REF_SPEED = 4.4;
export const RUN_REF_SPEED = CONFIG.player.moveSpeed;

/** Clip weight ramps in over this ground speed (below it the stance wins). */
export const CLIP_FULL_SPEED = 2.5;

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
