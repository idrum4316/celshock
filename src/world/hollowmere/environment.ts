/**
 * hollowmere/environment.ts — Hollowmere's EnvironmentSpec: palette, fog,
 * ground mist, moon light, sky, water, ash particles. Pure data — consumed by
 * applyEnvironment/Sky/WaterSystem/Atmosphere. Fixture light POSITIONS live in
 * layout.ts/BuildingKit, not here.
 */
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
  skyColor: "#080d16",
  /**
   * Fog and mist are the moonlight the shader can't reach: a lit haze rather
   * than a black cut-off, so distance reads as air with the moon in it. They
   * stay dark enough that a silhouette at 60 m is still a silhouette.
   */
  fogColor: "#131c2a",
  fogStart: 22,
  fogEnd: 78,
  mistColor: "#1d2a38",
  mistHeight: 3.2,
  mistStrength: 0.45,
  lighting: {
    color: "#a8c4ff",
    intensity: 0.78,
    /**
     * The moon sits opposite this, ~38 deg up in the south-east. It used to be
     * ~59, and coming down bought two things: shadows long enough to read as
     * evening, and a moon low enough for rooflines and trees to stand in front
     * of — which is the whole precondition for the shafts. It also costs: the
     * cobble sheen (`graphics.spec.cobble`) fires far more broadly at a
     * grazing angle, so that intensity is tuned against this elevation.
     */
    direction: [-0.46, -0.62, 0.64],
    ambientColor: "#1a2331",
    ambientIntensity: 1.0,
    /** The dome's own light: cobbles, roofs and open ground catch it, walls
     *  and undersides don't. See EnvironmentSpec — this is not flat ambient. */
    skyLightColor: "#2f4a66",
    skyLightIntensity: 0.27,
    rimColor: "#8fb2ff",
    rimIntensity: 0.4,
  },
  particles: {
    color: "#8a9aa6",
    emissive: false,
    count: 140,
    size: 0.06,
    riseSpeed: -0.25,
  },
  /**
   * A cold moon low in the south-east (opposite the key light — see above)
   * burning a wide halo into a deep blue zenith, with a dead-green
   * band at the horizon that hands off to the fog. Broken cloud drifts across
   * it and silvers where the moon is behind it; the galactic band shows in
   * the clear stretch overhead.
   */
  sky: {
    zenithColor: "#050b17",
    horizonColor: "#1b2b2a",
    starColor: "#c8d8ef",
    starCount: 1300,
    starBrightness: 0.9,
    moonColor: "#e6efff",
    moonGlowColor: "#7ea0d8",
    milkyWayColor: "#5a6f96",
    cloudColor: "#1a2434",
    cloudOpacity: 0.72,
    cloudLitColor: "#86a8dc",
    cloudLitStrength: 0.34,
  },
  // The creek at B and the bog at E: black-green standing water that mostly
  // exists to catch the moon and the muzzle flashes.
  water: {
    deepColor: "#0e1a15",
    shallowColor: "#2a4a44",
    foamColor: "#5f7a6e",
  },
  // Dead grass: grey-olive stalks, pale straw tips. The root sits just under
  // the floor colour so the fields read as the valley floor continuing.
  grass: {
    rootColor: "#2e3128",
    tipColor: "#7d7f5c",
  },
};
