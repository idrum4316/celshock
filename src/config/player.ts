/**
 * config/player.ts — the player's own body, movement and vitals.
 * Owns: speeds, the crouch, the ground probe, health and regen.
 * Gotcha: `eyeHeight` is also the point bots test LOS against, and the crouch
 * must move `Player.center` the same half metre or crouching makes you
 * EASIER to kill. See the first-person section in CLAUDE.md.
 */

export const player = {
  maxHealth: 100,
  /**
   * Realistic infantry pace: a loaded combat jog is ~4 m/s. The original
   * 8 m/s read as a full sprint and made the village feel small.
   */
  moveSpeed: 4.6,
  /** Movement speed multiplier while aiming down sights. */
  adsMoveMult: 0.55,
  /**
   * Sprint multiplier: 6.9 m/s, an honest loaded sprint. Crossing the
   * 240 m map takes ~35 s at it (vs ~52 s jogging), so this stays
   * traversal necessity rather than a feature. Firing is blocked while
   * sprinting.
   */
  sprintMult: 1.5,
  jumpVelocity: 8.5,
  gravity: 22.0,
  height: 1.8,
  radius: 0.45,
  /**
   * Crouch — held on Ctrl, latched by `C` or the pad's B (see
   * `InputManager.crouch`). It costs speed for a lower profile and a
   * steadier gun. Two numbers do the real work and they must move together:
   *
   * `crouchEyeHeight` is where the camera goes, where `Player.eyePos`
   * reports, and therefore what bots test line of sight against and aim at —
   * the same one-number-for-all-three rule the standing `camera.eyeHeight`
   * follows. That is what makes crouching behind a waist-high wall actually
   * break contact instead of just looking like it does.
   *
   * `crouchCenterHeight` moves the hit sphere down with it. Skip it and
   * crouching makes you EASIER to kill, not harder: bots aim at `eyePos`, so
   * a dropped eye against an unmoved sphere puts every shot through the
   * middle of the target instead of grazing its top. Standing, the sphere's
   * top (0.9 + 0.7) sits 0.05 m above the eye; crouched, 0.4 + 0.7 keeps the
   * same relation, so the profile shrinks by the half-metre the eye dropped
   * and nothing is visible-but-unhittable (or the reverse).
   */
  crouchEyeHeight: 1.05,
  crouchCenterHeight: 0.4,
  /** Movement multiplier while crouched — a shuffle, not a walk. */
  crouchMoveMult: 0.5,
  /**
   * Spread multiplier while crouched. Applied to the whole spread, bloom
   * included, so a braced stance is worth taking in a firefight and not
   * only for the cover. Modest on purpose: crouch is not a second ADS.
   */
  crouchSpreadMult: 0.7,
  /** How fast the stance blend converges (per second). */
  crouchBlendSpeed: 12,
  /**
   * Health regeneration, Battlefield-style: none for `regenDelay` seconds
   * after taking a hit, then `regenRate` per second back to full.
   *
   * Not optional. With sixteen hostile bots and no medics, a 100 HP pool that
   * never refills means a player who wins a fight is left too weak to take
   * the next one, and the round becomes a respawn queue.
   */
  regenDelay: 5,
  regenRate: 18,
  /**
   * Downward ground probe. Replaces the old flat-plane clamp so the chapel
   * terrace, barn ramp, and footbridges are standable.
   */
  groundProbeLength: 3.0,
  /** Largest rise the probe will snap up onto without a jump. */
  stepHeight: 0.6,

  /**
   * The death cam: what happens between the round that killed you and the
   * deploy map.
   *
   * It is NOT extra time in the penalty box. `time` is subtracted from
   * `conquest.respawnDelay` when the deploy screen finally opens, so a life
   * still costs eight seconds end to end and the only thing that changed is
   * what fills the first four of them. Lengthening this without that subtract
   * turns a piece of feedback into a punishment.
   *
   * The round keeps running underneath — bots fight, tickets bleed, the
   * ragdoll falls — because a death cam over a frozen world is a screenshot.
   * That is also why it is its own game state rather than a lid: a pause
   * stops everything and this must not.
   */
  deathCam: {
    /** Seconds spent watching the body before the deploy map comes up. */
    time: 4,
    /**
     * Seconds to ease from the eye out to the orbit pose. The camera leaves
     * from exactly where the player was looking, so the cut reads as being
     * knocked out of your own head rather than as a jump to a second camera.
     */
    riseTime: 0.9,
    /**
     * Where the orbit sits, relative to the BODY — not to the ground.
     *
     * The camera looks at the corpse's own chest joint and frames itself off
     * that, which is what makes the shot work at both ends of the fall
     * without a second set of numbers: a standing body puts the chest at
     * ~1.1 m and a fallen one at ~0.3 m, and the camera comes down with it.
     */
    distance: 3.4,
    height: 1.6,
    /**
     * How fast the frame follows the body (per second). The chest of a
     * tumbling ragdoll is not a smooth path, and a camera welded to it
     * inherits every bounce; this is slow enough to read as a hand holding
     * the shot and fast enough not to lose a body that rolls down a bank.
     */
    followRate: 6,
    /**
     * Orbit rate, rad/s. Slow enough to read as drift: at 0.22 the whole
     * four seconds is a little over 50 degrees, which is a change of angle
     * rather than a lap.
     */
    orbitRate: 0.22,
    /**
     * The pull-in. Dying against a wall is the normal case, not the corner
     * case — a camera that fell back through the stonework would spend the
     * whole cam inside it, looking at the inside of the world.
     *
     * One ray per frame from the body outward, which is affordable precisely
     * because `Player.probeGround` (the frame's most expensive pick, at
     * ~2.5 ms) is NOT running while the player is dead. `wallMargin` keeps
     * the near plane out of the masonry; `minDistance` is the floor the
     * pull-in stops at, below which the camera is inside the body instead.
     */
    wallMargin: 0.3,
    minDistance: 0.9,
  },
} as const;
