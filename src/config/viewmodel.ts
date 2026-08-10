/**
 * config/viewmodel.ts — where the weapon sits in front of the camera.
 * Owns: the pose stack — hip/aim offsets, bob, sway, the lower and the
 * holsters. Contract: `docs/weapons.md`.
 * Gotcha: all values are CAMERA-LOCAL and in rifle-model units. The aimed
 * pose is DERIVED from the fitted sight, never authored here.
 */

/**
 * The first-person weapon: where the rifle sits in front of the camera, and
 * everything that moves it there. All positions/rotations are CAMERA-LOCAL
 * (+x right, +y up, +z forward) and in rifle-model units — the viewmodel
 * node carries `scale`, so the rifle's own local coordinates and these
 * offsets are in the same frame.
 *
 * The aimed stand-off is NOT here — it is `sights[id].eyeRelief`, and it is
 * the one number that must not be treated as art direction: ViewModel
 * derives the aimed position from it so the fitted sight's own centre lands
 * exactly on the camera axis, which is where the bullets go. Move the sight
 * off that axis and the reticle stops being the point of impact.
 */
export const viewmodel = {
  /**
   * Scale and stand-off together decide how much of the frame the rifle
   * eats. At full size half a metre from the lens it is a wall: this is a
   * 54° vertical FOV against a real eye's ~130°, so a viewmodel framed the
   * way a rifle actually sits fills the screen. Shrunk and pushed out, it
   * reads at the size the eye expects.
   */
  scale: 0.62,
  /**
   * The magnification the weapon is FRAMED at. Aiming narrows the FOV, and
   * a narrower FOV magnifies the rifle along with the world — harmless at
   * the holo's 1.6x, and at 3.5x a receiver across the whole screen. Past
   * this reference the viewmodel is scaled down and drawn in proportionally
   * closer, which is a uniform scale about the camera's own origin: it
   * changes no ray direction, so the sight picture and the point of impact
   * are untouched and only the apparent size of the weapon is held still.
   * Set it to the largest magnification on offer to disable the whole
   * mechanism.
   */
  adsMagReference: 1.6,
  /** Hip-fire pose: sight ~30% right and ~22% down, muzzle turned inboard. */
  hipPos: { x: 0.184, y: -0.185, z: 0.66 },
  hipRot: { x: 0.03, y: -0.08, z: 0.06 },
  /**
   * Sprint: the rifle carried ACROSS the body, muzzle swung inboard and
   * canted, reading as a diagonal through the lower right of the frame.
   *
   * The yaw sign is the whole pose. Babylon is left-handed, so a positive
   * `rotY` takes the barrel (+z) toward +x — outboard, away from the
   * shooter. That is a rifle held out to one side at arm's length: it
   * reads as broken rather than as running, and it swings the weapon off
   * the edge of the screen so only the optic is left. Inboard is negative.
   *
   * The drop is small on purpose. `hipPos.y` is already -0.185, so an
   * offset much past this lands near -0.3 and sinks the whole weapon out
   * of frame — the same symptom, from the other axis.
   */
  sprintPos: { x: -0.01, y: -0.05, z: -0.03 },
  sprintRot: { x: 0.2, y: -0.4, z: 0.3 },
  /** Reload: tipped down and rolled toward the magwell. */
  reloadPos: { x: 0.02, y: -0.1, z: -0.05 },
  reloadRot: { x: 0.3, y: -0.2, z: 0.42 },
  /**
   * The weapon swap: one gun goes away below the frame and the other comes
   * up in its place, on a triangle that peaks halfway through
   * `weapons[id].drawTime`.
   *
   * The drop has to be enough to take the weapon fully OFF the screen, not
   * merely low, and that is what sizes it: at the hip stand-off of ~0.66 m a
   * 54° vertical FOV puts the bottom edge 0.336 m below the axis, and
   * `hipPos.y` has already spent 0.185 of that. The switch is hidden behind
   * the frame's edge or it is a model popping into another one — which is
   * exactly what a swap with a shallow dip looks like.
   *
   * The rotation is the half that sells it as a hand rather than a lift:
   * positive `rotX` is nose-down (see `recoil.kickPitch`, which is the same
   * axis in the other direction) and positive `rotY` is outboard, so the
   * weapon rolls off the shoulder rather than sinking straight down.
   */
  swap: {
    pos: { x: -0.02, y: -0.32, z: -0.08 },
    rot: { x: 0.62, y: 0.3, z: -0.28 },
    /**
     * Share of the draw spent putting the old weapon away — where the models
     * are exchanged. Under a half, because the up-stroke is what the player
     * is waiting on and the down-stroke is only the cover for it.
     */
    switchFrac: 0.42,
  },
  /**
   * The throw. A grenade goes with the OFF hand, so the weapon is not put
   * away for it: the support hand leaves the handguard, the weapon tips out
   * of the aim under the firing hand alone, and the other arm does the work
   * in front of the camera.
   *
   * The ARM is the animation, and it has to be. This was once a weapon dip
   * on its own with nothing thrown in view, and the grenade appeared on the
   * camera axis on the frame the button went down — which is exactly what a
   * muzzle does, so the whole thing read as a second trigger rather than as
   * a throw. What makes it a throw is a gesture with a release IN it: the
   * hand comes up holding the grenade, cocks back, whips forward, and the
   * grenade leaves it at full extension, from the hand's own position rather
   * than from the eye.
   *
   * The timeline, all seconds from the button:
   * - `[0, windup * cockFrac]` — the hand rises into frame and cocks back.
   * - `[windup * cockFrac, windup]` — the whip forward. Short, so it snaps.
   * - `windup` — RELEASE. The grenade leaves the hand and `GrenadeSystem`
   *   has it from there; `Player.throwReleaseDue` is the one edge that says
   *   so, and it is what the sound and the camera's follow-through key off.
   * - `[windup, windup + recover]` — the hand drops back out of frame and
   *   the weapon comes back up.
   *
   * `windup + recover` is deliberately shorter than `grenade.throwInterval`,
   * so the arm is out of frame and the weapon settled before a second throw
   * is allowed.
   */
  throw: {
    windup: 0.24,
    /** Share of the windup spent cocking; the rest is the whip. */
    cockFrac: 0.6,
    recover: 0.34,
    /**
     * The weapon's give, held from the cock through to the end of the
     * recovery — it is the support hand being somewhere else, so it lasts
     * exactly as long as the hand is away. Positive `rotY` is outboard (see
     * `sprintRot`), which with the drop reads as the weapon tipping down and
     * away under one hand.
     */
    weaponPos: { x: 0.02, y: -0.07, z: -0.06 },
    weaponRot: { x: 0.2, y: 0.18, z: -0.24 },
    /**
     * The throwing hand's three keys, CAMERA-LOCAL and in metres (the arm
     * node carries `scale`, so only its geometry is in model units). The
     * off hand is the LEFT one — the rifle's support hand — so every x here
     * is inboard of the weapon, which sits at `hipPos.x` on the right. That
     * separation is half of why the grenade no longer reads as leaving the
     * muzzle.
     *
     * `rest` is below the frame at both ends of the gesture. `cock` holds the
     * whole fist and the frag in frame and near the lens, because the one
     * thing the wind-up has to say is WHAT is about to be thrown — a hand
     * cocked off the left edge is a throw the player never sees loaded.
     * `release` is far out and low, so the whip reads as extension in DEPTH
     * rather than as a slide across the screen.
     *
     * Both live poses are also bounded by something that is not composition:
     * THE ELBOW MUST LEAVE THE FRAME. The forearm ends at a flat cut where
     * the arm would carry on into a shoulder there is no geometry for, and a
     * cut end standing in open screen reads as a floating log rather than as
     * an arm — which is exactly what the first pass at this looked like. A
     * hand placed high and central drags that cut into view however good the
     * rest of the gesture is; low and outboard keeps it off the bottom-left
     * corner, and `THROW_ELBOW`'s length is the other half of the same
     * guarantee.
     */
    handRest: { x: -0.28, y: -0.36, z: 0.6 },
    handRestRot: { x: 0.3, y: 0.3, z: 0 },
    handCock: { x: -0.24, y: 0.04, z: 0.5 },
    handCockRot: { x: -0.3, y: 0.25, z: -0.2 },
    handRelease: { x: -0.18, y: -0.1, z: 0.86 },
    handReleaseRot: { x: 0.35, y: -0.1, z: 0.1 },
  },
  /** Where the support hand travels to for the magazine swap. */
  magHandOffset: { x: -0.02, y: -0.09, z: -0.34 },
  /** Support-hand window over the reload: leaves the guard, swaps, returns. */
  magWindow: [0.15, 0.35, 0.6, 0.8],
  /**
   * Sway: the weapon lags the view. Position offsets oppose the turn,
   * rotation follows it, both clamped so a fast flick can't swing the
   * rifle out of frame, and both eased so the weapon settles after the
   * camera stops.
   */
  swayPos: 0.05,
  swayRot: 0.1,
  swayPitchPos: 0.035,
  /** One ceiling for all four terms — metres for the offsets, radians for
   *  the rotations. They happen to want the same number. */
  swayMax: 0.09,
  swaySmooth: 8,
  /** Weapon bob, on the camera's own bob phase (see camera.bobRate). */
  bobLateral: 0.022,
  bobVertical: 0.014,
  bobRoll: 0.05,
  /** Sway/bob multipliers while aimed — a braced weapon barely moves. */
  adsSwayMult: 0.3,
  adsBobMult: 0.12,
  /**
   * Vertical give while airborne, from the fall speed (m per m/s). The
   * pose blends themselves need no smoothing constant: Player hands over
   * adsBlend/sprintBlend/reloadBlend already eased.
   */
  airDrop: 0.006,
  airDropMax: 0.05,
  /**
   * How fast the give follows that fall speed (per second). It exists
   * because the speed it follows does not ease: it jumps to the launch
   * velocity on the push and to zero on the frame the feet touch. Take the
   * give straight from it and the weapon snaps 5 cm back to neutral in one
   * frame, which is the pop the landing absorb is there to replace. ~70 ms
   * of lag — enough that the return is a motion, short enough that the
   * weapon still reads as attached to the body.
   */
  airDropSmooth: 14,
  /**
   * The landing absorb's share of the camera's dip (see `camera.land`). The
   * weapon already rides the camera down; this is how much further the arms
   * let it go, and the nose-down pitch per metre of that dip. Both are the
   * part you can actually see, because the rest of the sink moves the eye
   * and the weapon together.
   */
  landFollow: 0.35,
  landPitch: 0.5,

  /**
   * The loadout screen's turntable: the weapon held up to be LOOKED at
   * rather than carried, parked at a fixed place on the screen and turned by
   * the player. Framing numbers, in the same spirit as `scale` and `hipPos`
   * above — how much of the frame the weapon eats and where it sits, not
   * anything the rounds can tell apart.
   */
  inspect: {
    /**
     * Metres from the lens at the hip-fire FOV. Nearer than the hip pose, so
     * the weapon fills its half of the screen; ViewModel scales this by the
     * live FOV so the stage frames identically whatever the camera was left
     * zoomed to (dying mid-ADS is enough to leave it narrow — nothing
     * re-writes `camera.fov` until the next round starts).
     */
    dist: 1.25,
    /**
     * The aspect ratio `dist` frames the weapon for. Narrower than this and
     * the weapon is pushed proportionally further back: its size follows the
     * vertical FOV, but the room it has to fit in is the stage's share of the
     * width, so a nearly square window would otherwise lay a rifle across
     * the panel column. Wider is free — the stage only gets roomier.
     */
    aspectReference: 1.7,
    /**
     * Where on the SCREEN the weapon is centred, in NDC (-1..1, +x right,
     * +y up). This is the loadout screen's stage: its panel column takes the
     * left 46% of the viewport (`--panel` in #loadout's CSS) and the stage
     * the rest, so the stage's centre sits `(1 + 0.46) / 2` across — which in
     * NDC is 0.46 again. Both sides are FRACTIONS of the viewport, which is
     * what keeps the DOM and the weapon together at any window size.
     */
    anchorX: 0.46,
    anchorY: 0.06,
    /**
     * The turntable spins about a point this far along the weapon's own
     * muzzle offset, so a shorter weapon centres itself instead of swinging
     * around a stock that is no longer there. Measured from the models'
     * spans — the rifle runs -0.52..0.75 and the SMG -0.32..0.50, whose
     * midpoints are 0.15 and 0.18 of their own muzzle landmark.
     */
    pivotFrac: 0.17,
    /**
     * Opening angles. A yaw just past a quarter turn brings the ejection-port
     * side toward the viewer with the muzzle across to the right, leaning a
     * few degrees TOWARD it — the other way round reads as foreshortened,
     * because the near end is then the stock and the whole weapon tapers off
     * to a muzzle in the distance. The slight negative pitch tips the top
     * plate into view, so the optic reads as fitted rather than as a lump on
     * the receiver.
     */
    baseYaw: 1.78,
    basePitch: -0.12,
    /** Radians per pixel of drag, and per second at full stick deflection. */
    dragRate: 0.009,
    stickRate: 2.6,
    /** Pitch is clamped short of straight up/down; yaw wraps freely. */
    pitchMax: 1.15,
  },
} as const;
