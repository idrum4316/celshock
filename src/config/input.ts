/**
 * config/input.ts — deadzones, curves and pad haptics.
 * Owns: stick shaping, the trigger threshold and the rumble pulses.
 * Gotcha: unsupported pads silently no-op on haptics; never gate gameplay on
 * a rumble having been delivered.
 */

export const input = {
  deadzone: 0.18,
  triggerThreshold: 0.35,
  /**
   * How much accumulated wheel travel counts as one notch, in the pixels a
   * `WheelEvent` reports (`InputManager` normalises the line and page delta
   * modes into the same unit first).
   *
   * A deadzone, not a scale: a mouse wheel arrives as one ~100 px event per
   * detent and would clear any threshold, but a trackpad's two-finger
   * scroll arrives as a stream of single-digit deltas and its inertial
   * fling goes on producing them for a second after the fingers lift. Left
   * ungated, that reads as the weapon swapping over and over on its own.
   * Well under one detent so a real notch is never missed.
   */
  wheelStep: 20,
  /**
   * How far the LEFT stick has to be pushed before a menu counts it as a
   * direction. Well above `deadzone`, and deliberately so: movement wants a
   * small deadzone because a half push is a real speed, while a menu step is
   * discrete and a stick resting a third of the way over must not scroll a
   * list on its own. It is also what makes a diagonal push resolve — past
   * this on both axes is two steps, which on a list of rows is what the
   * player asked for.
   */
  menuStickThreshold: 0.55,
  /**
   * Seconds a menu direction must be HELD before it starts repeating, and
   * the interval between repeats after that.
   *
   * A menu direction was a pure edge before this: one press, one step,
   * however long the key or the stick was held. That is fine on a four-item
   * list and wrong everywhere a player expects to scroll — and it is the
   * thing that makes a stick unusable for menus at all, since a stick has no
   * detent to tap and holding it is the natural gesture. The delay is long
   * enough that a deliberate single step never repeats by accident; the
   * interval is a shade over seven steps a second, which crosses any list
   * here without overshooting it.
   */
  menuRepeatDelay: 0.42,
  menuRepeatInterval: 0.14,
} as const;

/**
 * Gamepad haptics (GamepadHapticsActuator "dual-rumble"). Magnitudes are
 * 0..1, durations in ms. Unsupported pads/browsers silently no-op. Per-shot
 * pulses are kept light and short so full-auto reads as a buzz; each new
 * pulse preempts the previous one rather than queueing.
 */
export const rumble = {
  enabled: true,
  /** Per shot fired: light tick on the weak (high-frequency) motor. */
  shotWeak: 0.4,
  shotStrong: 0.3,
  shotMs: 70,
  /** Hitmarker confirmation. */
  hitWeak: 0.55,
  hitStrong: 0.2,
  hitMs: 70,
  /** Kill confirmation — replaces the hit pulse. */
  killWeak: 0.7,
  killStrong: 0.45,
  killMs: 140,
  /** Taking damage: heavy motor leads. */
  hurtWeak: 0.4,
  hurtStrong: 0.9,
  hurtMs: 220,
  /** Death: longest, heaviest pulse. */
  deathWeak: 0.7,
  deathStrong: 1,
  deathMs: 550,
} as const;
