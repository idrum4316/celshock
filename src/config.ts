/**
 * Central game configuration. No gameplay values should be hardcoded elsewhere —
 * tune everything from here.
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

  /** Bot roster, AI cadence, and the render LOD that makes 32 of them viable. */
  bots: {
    /** Per team. The rig pool is sized to exactly `perTeam * 2`. */
    perTeam: 16,
    squadSize: 4,
    maxHealth: 100,
    moveSpeed: 6.4,
    /** Sprint multiplier while advancing with no target. */
    advanceSprintMult: 1.35,
    /**
     * Full AI (target selection, LOS raycast, objective re-evaluation) runs at
     * this rate per bot, round-robin across frames. Movement still integrates
     * every frame. At 5 Hz with 32 bots that is ~2.7 ray picks per frame.
     */
    thinkRate: 5,
    /** Seconds between acquiring a target and the first shot. */
    reactionTime: 0.35,
    damage: 13,
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
    /** Distance past which the pose is frozen (still translates). */
    lodFreezeDistance: 35,
    /** Distance past which outlines are dropped. */
    lodOutlineDistance: 20,
  },

  /** Navigation grid covering the whole map. */
  nav: {
    /** Cell size in metres. 1.5 over a 240 m map gives a 160x160 grid. */
    cellSize: 1.5,
    /** Cells within this distance of a collider are marked unwalkable. */
    clearance: 0.5,
    /** Max step-up a bot can walk over without a ramp. */
    stepHeight: 0.6,
  },

  /** Map extents. The village is authored inside this square, centred on origin. */
  map: {
    size: 240,
  },

  player: {
    maxHealth: 100,
    /** Slightly quicker than the original arenas — the rooms got much bigger. */
    moveSpeed: 8.0,
    /** Movement speed multiplier while aiming down sights. */
    adsMoveMult: 0.55,
    /**
     * Sprint multiplier. A 240 m map takes 30 s to cross at base speed, so
     * this is traversal necessity rather than a feature. Firing is blocked
     * while sprinting.
     */
    sprintMult: 1.6,
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
    damage: 12,
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
    /** Third-person over-the-shoulder framing. */
    thirdPersonDistance: 4.0,
    shoulderOffset: 0.75,
    pivotHeight: 1.6,
    /** First-person eye height. */
    fpHeight: 1.55,
    fovHip: 0.95,
    fovAds: 0.62,
    /** How fast the third<->first person blend converges (per second). */
    adsBlendSpeed: 10,
    pitchMin: -0.95,
    pitchMax: 1.25,
  },

  /** First-person rifle shown while aiming down sights (camera-local units). */
  viewmodel: {
    /** Distance from the eye to the holo sight window when fully aimed. */
    adsSightDistance: 0.52,
    /** Lowered ready pose the rifle raises from during the ADS transition. */
    hipPos: [0.18, -0.3, 0.5],
    hipRot: [0.12, -0.14, 0.08],
    /** Recoil kick: recovery time (s), rearward slide (m), pitch (rad). */
    kickTime: 0.09,
    kickBack: 0.035,
    kickPitch: 0.05,
  },

  input: {
    deadzone: 0.18,
    triggerThreshold: 0.35,
  },

  audio: {
    /**
     * Concurrent one-shots. Thirty-two bots firing is ~160 shots a second; past
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
     * Sized for a 32-bot firefight: everyone is hitscan, so a tracer is drawn
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

  lighting: {
    /** Muzzle flash pulse: color, reach, brightness, and life in seconds. */
    muzzleColor: "#ffcf7a",
    muzzleRange: 14,
    muzzleIntensity: 2.6,
    muzzleLife: 0.07,
    /**
     * Transient pulses always win a shader light slot, so 32 bots firing at
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
