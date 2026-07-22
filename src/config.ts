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
    moveSpeed: 7.0,
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

  input: {
    deadzone: 0.18,
    triggerThreshold: 0.35,
  },

  room: {
    minSize: 28,
    maxSize: 40,
    bossSize: 46,
    wallHeight: 6,
    doorWidth: 4,
    /** Distance from the open door that triggers the next room. */
    doorTriggerDistance: 2.4,
  },

  enemies: {
    /** Enemies in room 1; each later room adds `perRoomExtra` more. */
    baseCount: 3,
    perRoomExtra: 1,
    maxCount: 8,
    /** Chance a dying enemy drops a health orb. */
    healthDropChance: 0.25,
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
} as const;
