import type { EnvironmentSpec } from "../environment";

/**
 * Hollowmere: a fog-drowned village in a dead valley, lit by a thin moon and
 * whatever lanterns are still burning. Ash falls instead of drifting up — the
 * old themes' embers read as "alive", and this place isn't.
 *
 * Fog is deliberately tight (`fogEnd` 78 against a 240 m map). It sets the
 * horror mood, but it is also doing real culling work: bots and geometry past
 * that distance are already fog-colored, so the battle system hides them.
 */
export const HollowmereEnvironment: EnvironmentSpec = {
  floorColor: "#3a3a33",
  wallColor: "#2c2f2e",
  wallTrimColor: "#555c54",
  accentColor: "#7fe0a0",
  skyColor: "#06080c",
  fogColor: "#0a0d11",
  fogStart: 22,
  fogEnd: 78,
  mistColor: "#141c1e",
  mistHeight: 3.2,
  mistStrength: 0.45,
  lighting: {
    color: "#8fb4ff",
    intensity: 0.5,
    direction: [-0.3, -0.85, 0.42],
    ambientColor: "#18212e",
    ambientIntensity: 1.0,
    rimColor: "#7ea6ff",
    rimIntensity: 0.32,
  },
  particles: {
    color: "#8a9aa6",
    emissive: false,
    count: 140,
    size: 0.06,
    riseSpeed: -0.25,
  },
  /**
   * A cold, high moon (it sits opposite the key light, ~58 deg up in the
   * south-east) over a near-black zenith, with a faint dead-green band at
   * the horizon that hands off to the fog. Stars are dim and sparse — thin
   * cloud cover, not a clear night.
   */
  sky: {
    zenithColor: "#020305",
    horizonColor: "#14201d",
    starColor: "#aebfcf",
    starCount: 240,
    starBrightness: 0.6,
    moonColor: "#d4e4ff",
    cloudColor: "#3a4a58",
    cloudOpacity: 0.4,
  },
  // The creek at B and the bog at E: black-green standing water that mostly
  // exists to catch the moon and the muzzle flashes.
  water: {
    deepColor: "#0e1a15",
    shallowColor: "#2a4a44",
    foamColor: "#5f7a6e",
  },
};
