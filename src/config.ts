/**
 * Central game configuration. No gameplay values should be hardcoded elsewhere —
 * tune everything from here.
 */
export const CONFIG = {
  run: {
    /** Total rooms per run; the final room is always a boss fight. */
    roomsPerRun: 5,
  },

  player: {
    maxHealth: 100,
    /** Slightly quicker than the original arenas — the rooms got much bigger. */
    moveSpeed: 8.0,
    /** Movement speed multiplier while aiming down sights. */
    adsMoveMult: 0.55,
    jumpVelocity: 8.5,
    gravity: 22.0,
    height: 1.8,
    radius: 0.45,
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

  room: {
    minSize: 64,
    maxSize: 86,
    bossSize: 106,
    wallHeight: 14,
    doorWidth: 5,
    /** Distance from the open door that triggers the next room. */
    doorTriggerDistance: 2.8,
    /**
     * Floor area a theme's `countRange` is written against. Actual rooms are
     * much bigger, so prop and spawn counts scale by area / this.
     */
    baselineArea: 1200,
    /** Upper bound on the area multiplier, so huge rooms stay performant. */
    maxAreaScale: 5,
  },

  enemies: {
    /** Enemies in room 1; each later room adds `perRoomExtra` more. */
    baseCount: 5,
    perRoomExtra: 2,
    maxCount: 12,
    /** Chance a dying enemy drops a health orb. */
    healthDropChance: 0.3,
  },

  loot: {
    healthOrbHeal: 25,
    pickupRadius: 1.7,
    damageBonus: 0.2,
    speedBonus: 0.12,
    maxHpBonus: 25,
    magBonus: 6,
  },

  effects: {
    tracerLife: 0.07,
    tracerPoolSize: 24,
    projectilePoolSize: 48,
    sparkPoolSize: 24,
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
    /** Boss AOE / shockwave flash. */
    shockIntensity: 3.2,
    shockLife: 0.4,
    /**
     * Shoulder lamp the player carries. Without it these arenas are too dark
     * to fight in between fixtures — and it gives the character a light of
     * their own to be silhouetted against.
     */
    lampColor: "#ffd9a8",
    lampRange: 18,
    lampIntensity: 1.6,
    lampHeight: 1.45,
    /** Bosses carry an aura in their eye color so they loom out of the fog. */
    bossAuraRange: 24,
    bossAuraIntensity: 1.3,
    bossAuraFlicker: 0.2,
  },
} as const;
