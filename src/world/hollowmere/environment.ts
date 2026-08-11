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
  /**
   * Soil rather than the flat colour this floor used to be. The whole valley
   * was one untextured hex across all 25 terrain blocks — and because 6,003 of
   * the heightfield's 6,561 vertices are exactly 0, most of those blocks are a
   * single quad, so there was no shading variation either. Looking at your own
   * feet returned a featureless wash.
   *
   * **`turf` is the surface this wants and it is not usable as authored.** It
   * is the one pattern no map had ever selected, so it had never been judged
   * from a camera 1.55 m up: its grains run to 22 units of radius against
   * `dirt`'s 13, which at any tile scale that keeps the repeat invisible puts
   * half-metre discs under the player, and its albedo spread (0.84–1.28 of
   * `floorColor`) lands that contrast on a base far less saturated than
   * Greyfen's brown. It reads as overlapping pale scales, which is worse than
   * the wash it replaces. Retuning it is a real change to a shared pattern and
   * belongs with whoever wants a grass valley, not here.
   *
   * So `dirt`, which Greyfen already ships and which is therefore the one
   * pattern tuned against this camera height. It costs the god-ray threshold
   * nothing: its brightest tone is `shadeOf(floorColor, 1.26)`, still under the
   * cobbled street the 0.78 in `config/sky.ts` is calibrated against.
   */
  floorSurface: "dirt",
  ridgeColor: "#2c2f2e",
  ridgeScreeColor: "#33352e",
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
    /**
     * Motes aloft, and how big one is. The pair is the ash, and **`size` is
     * the lever, not `count`** — which is the opposite of what the CPU-era
     * numbers (140 at 0.06) suggest.
     *
     * `count` was 140 while the field ran on the CPU, where the pool capped
     * at 1,200 and Hollowmere held ~650 motes across a 240 m valley: one per
     * 950 cubic metres. Transform feedback lifted that ceiling, and raising
     * the number turned out to buy almost nothing on its own. Measured over
     * the whole range from 140 to 16,000 — 654 live slots to 74,667 — the
     * picture barely changes, because the emit box is the entire map and a
     * 0.06 m mote is one to three pixels at street distance arriving at alpha
     * 0.5 and fading to nothing. It sits under the grain pass at any density.
     *
     * `size` moves it immediately: at 0.12 the flecks read against a dark
     * wall and against the hillside, and by 0.25 they are soft blobs that
     * read as snow rather than as ash. So the count is set where the field
     * covers the ground without the cost — it is judged inside the fog wall
     * and nowhere else, since past 78 m everything is `fogColor` and the far
     * half of the valley's share is paid for and never seen — and the size
     * is what was actually turned up.
     */
    count: 4000,
    size: 0.12,
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
