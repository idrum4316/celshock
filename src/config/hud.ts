/**
 * config/hud.ts — the gameplay chrome's own numbers.
 * Owns: the corner minimap and the directional damage arcs. Contract:
 * `docs/ui.md`.
 * Gotcha: the damage arcs are re-projected against the live view yaw every
 * frame — they are world-bearing, not screen-space.
 */

/**
 * The corner minimap: full-map and north-up (matching the deploy screen),
 * drawn from the same collider data so the two can never disagree.
 * Enemies are hidden unless their own gunfire gives them away.
 */
export const minimap = {
  /** Canvas size in pixels (square); the CSS box is set to match. */
  size: 220,
  /** Seconds an enemy stays on the minimap after one of their shots. */
  enemyRevealTime: 2.2,
  /** The final stretch of a reveal, spent fading out (seconds). */
  enemyFadeTime: 0.6,
  /** Blip radii in canvas pixels. */
  friendlyRadius: 2,
  enemyRadius: 2.5,
} as const;

/**
 * Battlefield-style directional damage arcs around the crosshair. A hit
 * records the *world* bearing to whoever fired it; the arc is re-projected
 * against the live view yaw every frame, so turning toward the shooter
 * swings their arc up to the top of the screen and off to the side again if
 * you turn past them. That is the whole point of the thing — an indicator
 * frozen in screen space tells you where you were looking, not where they
 * are.
 */
export const damageIndicator = {
  /** Seconds an arc lives, and the tail of that spent fading out. */
  life: 2.4,
  fadeTime: 1.4,
  /**
   * Two hits from within this many degrees of each other refresh one arc
   * instead of stacking two. A burst from one rifle is one threat; six
   * overlapping arcs would just read as a red ring.
   */
  mergeDegrees: 24,
  /** Most arcs alive at once; a new hit past this recycles the oldest. */
  maxArcs: 5,
  /** Damage that reads as a full-strength arc. One bot hit, by design. */
  fullDamage: 25,
  /** Opacity of the weakest and a full-strength arc. */
  minOpacity: 0.55,
  maxOpacity: 0.95,
} as const;
