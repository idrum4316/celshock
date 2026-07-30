/**
 * config.ts — Central game configuration (`CONFIG`, `as const`).
 * Owns: ALL gameplay/balance tunables. No gameplay magic numbers elsewhere;
 * art/geometry constants stay in their model file.
 * Gotcha: `as const` gives fields literal types — `let x = CONFIG.bots.x` then
 * reassigning fails to compile. Annotate `let x: number` instead.
 * Keep the per-value comments: they record why a number is what it is.
 */
export const CONFIG = {
  /** Conquest round rules. */
  conquest: {
    /**
     * Starting reinforcements per team. Sized against the drain below for a
     * round of roughly 12-15 minutes; deaths dominate the rate, so this is the
     * number most worth revisiting after real playtesting.
     */
    tickets: 400,
    /** Cost of one death. */
    ticketsPerDeath: 1,
    /** How often the flag-deficit bleed is applied (seconds). */
    bleedInterval: 3,
    /**
     * Tickets lost per interval, per flag the losing team is behind by: 20/min
     * when one flag down, 60/min when three down. Steep enough that ignoring
     * objectives loses the round, shallow enough that one bad push doesn't.
     */
    bleedPerFlagDeficit: 1,
    /** Radius of a control point's capture zone (metres). */
    captureRadius: 12,
    /**
     * Capture meter runs -1 (team 0 owns) .. +1 (team 1 owns) and moves at
     * this rate per second with one attacker present. Crossing 0 neutralizes,
     * so a flag must be swept through neutral before it flips.
     */
    captureRate: 0.07,
    /**
     * Extra capture rate per additional body, with diminishing returns — the
     * Nth attacker adds `captureRate * crowdFalloff^(N-1)`.
     */
    crowdFalloff: 0.55,
    /** Cap on the crowd bonus, so a whole squad can't instantly flip a flag. */
    maxCaptureMult: 2.6,
    /** Seconds between death and being allowed to redeploy. */
    respawnDelay: 8,
  },

  /** Bot roster, AI cadence, and the render LOD that makes 16 of them viable. */
  bots: {
    /** Per team. The rig pool is sized to exactly `perTeam * 2`. */
    perTeam: 8,
    squadSize: 4,
    maxHealth: 100,
    /** Roughly the player's jog; the advancing sprint stays under theirs. */
    moveSpeed: 4.4,
    /** Sprint multiplier while advancing with no target. */
    advanceSprintMult: 1.35,
    /**
     * Full AI (target selection, LOS raycast, objective re-evaluation) runs at
     * this rate per bot, round-robin across frames. Movement still integrates
     * every frame. At 5 Hz with 16 bots that is ~1.3 ray picks per frame.
     */
    thinkRate: 5,
    /** Seconds between acquiring a target and the first shot. */
    reactionTime: 0.35,
    /** 25 per hit against 100 HP = 4 shots to kill, matching the player. */
    damage: 25,
    fireRate: 5.5,
    /** Rounds per burst, and the pause between bursts. */
    burstSize: 5,
    burstPause: 0.9,
    /**
     * Aim error half-angle (radians), lerped by distance / `engageRange`.
     *
     * These read as very loose, but the miss radius is `angle * distance`
     * against a 0.75 m target sphere, so the hit rate falls off quadratically:
     * near-certain inside 20 m, about half at 30 m, roughly one in ten at 55 m.
     * Tightening them makes bots snipe across the square with no counterplay.
     */
    spreadNear: 0.02,
    spreadFar: 0.045,
    /** Bots will not open fire beyond this distance. */
    engageRange: 55,
    /** Below this, a bot backs off toward cover instead of closing. */
    minEngageRange: 6,
    /** Separation distance for the crowd-avoidance pass. */
    separation: 1.5,
    /**
     * Unstick watchdog. A bot that wants to move but covers less than
     * `stuckFraction` of its intended step for `stuckTime` seconds is grinding
     * on something its flow field cannot see — a scattered tree, a squadmate
     * pinning it to a wall — so it sidesteps for `detourTime` before trying the
     * direct line again. Without this a bot whose objective lies dead behind a
     * tree trunk pushes into the trunk forever: the push-out is exactly
     * opposite its steering, so there is no tangential motion to break the tie.
     */
    stuckTime: 0.5,
    stuckFraction: 0.35,
    detourTime: 1.0,
    /** How far to the side the watchdog looks when choosing a way round. */
    detourProbe: 1.6,
    /** Distance past which the pose is frozen (still translates). */
    lodFreezeDistance: 35,
    /** Distance past which outlines are dropped. */
    lodOutlineDistance: 20,
  },

  /** Navigation grid covering the whole map. */
  nav: {
    /** Cell size in metres. 1.5 over a 240 m map gives a 160x160 grid. */
    cellSize: 1.5,
    /**
     * Half-width of a bot's body, used by `ObstacleField` to hold it off
     * collider faces. The rig's shoulders span ~0.35 m either side, so this is
     * a body plus a little air. Raising it past ~0.7 makes the narrowest
     * authored doorway (1.6 m, the cottages) impassable.
     */
    bodyRadius: 0.4,
    /** Max step-up a bot can walk over without a ramp. */
    stepHeight: 0.6,
  },

  /** Map extents. The village is authored inside this square, centred on origin. */
  map: {
    size: 240,
  },

  player: {
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
  },

  weapon: {
    /** 30 per hit against 100 HP = 4 shots to kill. */
    damage: 30,
    /** Rounds per second (full auto). */
    fireRate: 8,
    magSize: 24,
    reloadTime: 1.4,
    /** Bullet spread half-angle (radians). */
    spreadHip: 0.045,
    spreadAds: 0.006,
    range: 120,
  },

  /**
   * Recoil. Every shot kicks the aim up and slightly sideways and blooms the
   * spread; both settle back on their own between bursts, so tapping stays
   * accurate while holding the trigger walks the shots off target.
   */
  recoil: {
    /** Aim kick per shot (radians): upward, and random left/right. */
    pitchPerShot: 0.026,
    yawPerShot: 0.011,
    /** Multiplier while fully aimed down sights — a braced stance kicks less. */
    adsMult: 0.55,
    /**
     * Fraction of each kick that springs back on its own. The remainder is
     * pushed into the player's own aim and stays there, so a magazine held
     * down walks the muzzle off target (~11 deg from the hip) and has to be
     * pulled back by hand. At 1.0 recoil is pure decoration.
     */
    recoverFraction: 0.7,
    /** How fast the springy part settles back (per second). */
    recovery: 6.5,
    /** Ceilings, so sustained fire can't walk the aim off the screen. */
    maxPitch: 0.17,
    maxYaw: 0.06,
    /**
     * Spread bloom: added per shot, its ceiling, and its bleed-off per second.
     * The bleed-off has to be well under `bloomPerShot * fireRate` (0.048/s
     * here) or holding the trigger never actually blooms.
     */
    bloomPerShot: 0.006,
    maxBloom: 0.03,
    bloomRecovery: 0.02,
    /** Third-person weapon punch: recovery time (s), slide (m), pitch (rad). */
    kickTime: 0.11,
    kickBack: 0.05,
    kickPitch: 0.12,
    /**
     * Cosmetic view punch per shot: an FOV spike, a backward camera shove,
     * and a fast random jitter, all decaying over punchTime. Deliberately NOT
     * part of aimPitch/aimYaw — bullets never see it; it only sells impact to
     * the eye. Kept small: at 8 rps the peaks overlap into a constant buzz.
     */
    punchTime: 0.09,
    fovPunch: 0.025,
    camPush: 0.035,
    shakePitch: 0.004,
    shakeYaw: 0.003,
  },

  /**
   * Gunfeel dressing: the visible muzzle flash mesh and ejected brass.
   * Player-only — bots get neither (their flashes are the budgeted light
   * pulses, and 16 bots' worth of casing meshes is draw-call noise nobody
   * can see anyway).
   */
  gunfeel: {
    /** Seconds the muzzle flash mesh stays visible per shot. */
    flashTime: 0.05,
    /** Ejected brass: pool size, lifetime (s), launch speeds (m/s), gravity. */
    casingPool: 12,
    casingLife: 0.9,
    casingGravity: 12,
    casingEject: 1.8,
    casingUp: 2.6,
  },

  camera: {
    /** Mouse sensitivity (radians per pixel). */
    sensX: 0.0022,
    sensY: 0.002,
    /** ADS mouse sensitivity multiplier. */
    adsMouseMult: 0.6,
    /** Gamepad look speed (radians per second at full deflection). */
    stickSensX: 2.8,
    stickSensY: 1.8,
    adsStickMult: 0.5,
    /**
     * Third-person over-the-shoulder framing (hip fire). Tuned so the
     * character fills roughly half the frame height: ~3.3 m back at chest
     * height puts head-to-feet at ~0.52 rad against fovHip 0.95.
     * NOTE: pivotHeight is relative to the player capsule CENTER (~0.9 m
     * above ground), so 0.55 puts the pivot at ~1.45 m — chest height.
     */
    thirdPersonDistance: 3.3,
    shoulderOffset: 0.65,
    pivotHeight: 0.55,
    /** ADS framing: the shoulder cam pulls in and recentres over the
     *  shoulder rather than going first-person. */
    adsDistance: 2.0,
    adsShoulderOffset: 0.45,
    /** Eye height — bot line-of-sight checks against the player use this. */
    eyeHeight: 1.55,
    fovHip: 0.95,
    fovAds: 0.62,
    /** How fast the hip<->ADS blend converges (per second). */
    adsBlendSpeed: 10,
    pitchMin: -0.95,
    pitchMax: 1.25,
  },

  /**
   * Controller aim assist: a slowdown bubble around enemies plus a gentle
   * rotational pull toward the acquired target.
   *
   * Gamepad only by construction — it engages solely while the pad is the
   * active look device (last stick movement or any pad button; any mouse
   * movement disengages it the same frame), and the slowdown multiplies the
   * stick terms in CameraSystem exclusively. The mouse look path is never
   * scaled, so keyboard/mouse aim is bit-for-bit unaffected, even with a
   * pad plugged in.
   */
  aimAssist: {
    /** No acquisition beyond this distance (metres). */
    maxDistance: 60,
    /**
     * Half-angle of the acquisition cone around the crosshair (radians).
     * The live enemy nearest the crosshair inside it wins. 0.08 ≈ 4.6° —
     * a bot's chest subtends ~0.025 rad at 30 m, so this is "on or very
     * near target", not "anywhere on screen".
     */
    acquireAngle: 0.08,
    /** Stick sensitivity multiplier while a target is acquired. */
    slowdownMult: 0.5,
    /**
     * Rotational pull toward the target, radians per second. ADS gets the
     * full pull; hip-fire gets the weaker pull and only while firing or
     * pushing the right stick, so a resting hip camera never drifts.
     * rotateAdsSpeed may safely exceed the slowed ADS stick rate
     * (stickSens * adsStickMult * slowdownMult) — AimAssistSystem cancels
     * the pull in proportion to opposing stick deflection, so the player
     * can always break free with a committed push.
     */
    rotateAdsSpeed: 1.1,
    rotateHipSpeed: 0.45,
    /** Vertical pull scales by this — gentler than horizontal tracking. */
    verticalMult: 0.7,
  },

  input: {
    deadzone: 0.18,
    triggerThreshold: 0.35,
  },

  /**
   * Gamepad haptics (GamepadHapticsActuator "dual-rumble"). Magnitudes are
   * 0..1, durations in ms. Unsupported pads/browsers silently no-op. Per-shot
   * pulses are kept light and short so full-auto reads as a buzz; each new
   * pulse preempts the previous one rather than queueing.
   */
  rumble: {
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
  },

  audio: {
    /**
     * Concurrent one-shots. Sixteen bots firing is ~80 shots a second; past
     * this many voices the ear can't separate them and the scheduler can't keep
     * up, so extras are dropped rather than queued.
     */
    maxVoices: 24,
    /** Distance at which a world sound plays at full volume. */
    refDistance: 8,
    /** Distance at which it falls silent. Matched roughly to the fog. */
    maxDistance: 70,
  },

  effects: {
    tracerLife: 0.07,
    /**
     * Sized for a 16-bot firefight: everyone is hitscan, so a tracer is drawn
     * per shot from every combatant that fires.
     */
    tracerPoolSize: 64,
    sparkPoolSize: 48,
  },

  graphics: {
    /** Emissive glow (neon, reticle, tracers) — GlowLayer settings. */
    glowIntensity: 1.15,
    glowKernel: 56,
    /** Horror grade post-process (vignette / grain / chromatic aberration). */
    vignette: 0.62,
    grain: 0.055,
    aberration: 0.55,
    /** Peak red edge flash when the player is hit, and how fast it decays. */
    damageFlash: 1.0,
    damageFlashDecay: 2.6,
  },

  /**
   * The corner minimap: full-map and north-up (matching the deploy screen),
   * drawn from the same collider data so the two can never disagree.
   * Enemies are hidden unless their own gunfire gives them away.
   */
  minimap: {
    /** Canvas size in pixels (square); the CSS box is set to match. */
    size: 220,
    /** Seconds an enemy stays on the minimap after one of their shots. */
    enemyRevealTime: 2.2,
    /** The final stretch of a reveal, spent fading out (seconds). */
    enemyFadeTime: 0.6,
    /** Blip radii in canvas pixels. */
    friendlyRadius: 2,
    enemyRadius: 2.5,
  },

  lighting: {
    /** Muzzle flash pulse: color, reach, brightness, and life in seconds. */
    muzzleColor: "#ffcf7a",
    muzzleRange: 14,
    muzzleIntensity: 2.6,
    muzzleLife: 0.07,
    /**
     * Transient pulses always win a shader light slot, so 16 bots firing at
     * once would saturate all 16 and black out the village's own lanterns.
     * Only the nearest few muzzle flashes get a light, and only up close.
     */
    muzzleBudgetPerFrame: 4,
    muzzleMaxDistance: 30,
    /**
     * Shoulder lamp the player carries. Without it these arenas are too dark
     * to fight in between fixtures — and it gives the character a light of
     * their own to be silhouetted against.
     */
    lampColor: "#ffd9a8",
    lampRange: 18,
    lampIntensity: 1.6,
    lampHeight: 1.45,
  },

  /**
   * Shallow surface water (the creek at B, the bog at E). Visual only — the
   * planes carry no collider, so wading is free and swimming never comes up.
   * Palette lives in the map's EnvironmentSpec; this is motion and shape.
   */
  water: {
    /** Default surface height above the ground plane: ankle-deep. */
    surfaceY: 0.32,
    /** Normal-map tiling (uv repeats per metre) for the two scrolled layers. */
    waveScale1: 0.14,
    waveScale2: 0.38,
    /** Scroll speeds (uv per second); the layers cross at an angle. */
    waveSpeed1: 0.045,
    waveSpeed2: 0.08,
    /** 0 = mirror flat, 1 = the normal map's full relief. */
    waveStrength: 0.6,
    /** Moon glint: Blinn exponent and brightness. */
    specPower: 90,
    specStrength: 0.9,
    /** How fast the view angle tips the body from deep to shallow colour. */
    fresnelPower: 2.2,
    /** Shoreline foam: band width (m), mask tiling, mask scroll speed. */
    foamWidth: 1.1,
    foamScale: 0.3,
    foamSpeed: 0.04,
  },

  /**
   * Grass fields (src/systems/GrassSystem.ts): thin-instanced tufts with a
   * vertex-shader wind sway plus a radial "pusher" bend around every nearby
   * combatant — the ripple as you run through it. Visual only: no collider,
   * no picking, no outline. Palette lives in the map's EnvironmentSpec.
   */
  grass: {
    /** Tufts per square metre when a rect doesn't override density. One tuft
     *  is `bladesPerTuft` blades, so this is ~5x that in blades. */
    density: 1.1,
    bladesPerTuft: 5,
    /**
     * Blade height range (metres). Knee-high at the top end — tall enough to
     * read as a field and to swallow boots, short enough that it never hides
     * a crawling firefight.
     */
    heightMin: 0.45,
    heightMax: 0.85,
    /** Ambient wind: XZ direction (normalized on use), tip travel (m), speed. */
    windDir: [0.78, 0.63],
    windStrength: 0.16,
    windSpeed: 1.7,
    /**
     * Character interaction: how far out a body bends blades (m) and how far
     * the tip travels at ground zero (m). The radius wants to be just past a
     * sprint stride so the grass reacts ahead of the feet, not under them.
     */
    pushRadius: 1.35,
    pushStrength: 0.6,
    /**
     * Shader array size for simultaneous pushers. The player plus the seven
     * nearest bots; beyond that the bend is outside reading distance anyway.
     */
    maxPushers: 8,
  },

  /**
   * The night sky (src/systems/Sky.ts): a gradient dome with baked stars and
   * moon halo, an emissive moon disc that feeds the GlowLayer, and drifting
   * cloud banks. Palette lives in the map's EnvironmentSpec (`sky`); this is
   * geometry and motion. Everything rides at `infiniteDistance`, so radii and
   * heights are angular conveniences, not reachable places.
   */
  sky: {
    /** Dome radius. Well under the camera's default 10000 far plane. */
    domeRadius: 600,
    /** Dome texture: width wraps the horizon, height runs pole to pole. */
    domeTextureWidth: 1024,
    domeTextureHeight: 512,
    /** Moon disc radius and its distance along the key-light source dir.
     *  Beyond the cloud shells (so they veil it) and just inside the dome. */
    moonRadius: 26,
    moonDistance: 595,
    /**
     * Emissive scale on the moon colour — above 1 so the GlowLayer blooms it
     * into a proper halo on top of the soft one baked into the dome texture.
     */
    moonEmissiveBoost: 1.7,
    /** Radius of the baked halo gradient around the moon, in texture px. */
    haloRadiusPx: 46,
    /** Largest star dot, in texture px; most stars are drawn far smaller. */
    starMaxSize: 1.7,
    /**
     * Cloud banks: sphere shells just inside the dome (a plane would show
     * its edges as a hard square hanging in the sky). Each scrolls a
     * wrapping blob texture azimuthally; `speedU` is uv per second (a full
     * circuit takes ~5-10 minutes — clouds should drift, not fly),
     * `uScale` is the texture repeat around the horizon, `radiusOffset` how
     * far inside the dome the shell floats, and `opacity` multiplies the
     * map spec's `cloudOpacity`.
     */
    cloudTextureSize: 256,
    cloudBlobs: 30,
    cloudLayers: [
      { radiusOffset: 12, uScale: 1, speedU: 0.0035, opacity: 1.0 },
      { radiusOffset: 26, uScale: 2, speedU: -0.0018, opacity: 0.55 },
    ],
  },

  /**
   * The two sides. Colors are the primary friend/foe read in a dark scene —
   * warm amber against cold crimson, both legible under blue moonlight.
   */
  teams: [
    {
      name: "Wardens",
      color: "#c9a15e",
      accentColor: "#e8d3a8",
      eyeColor: "#ffc46b",
    },
    {
      name: "The Blight",
      color: "#5a4550",
      accentColor: "#9a8390",
      eyeColor: "#ff3b3b",
    },
  ],
} as const;
