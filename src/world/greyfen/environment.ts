/**
 * greyfen/environment.ts — Greyfen's EnvironmentSpec: palette, fog, sun light,
 * sky, water, no particles. Pure data — consumed by applyEnvironment/Sky/
 * WaterSystem/Atmosphere. Fixture light POSITIONS live in layout.ts, not here.
 */
import type { EnvironmentSpec } from "../environment";

/**
 * Greyfen: the same drowned valley at first light. Overcast, wet, and bright
 * enough to see what is shooting at you — the counterpoint to Hollowmere's
 * moon, and the map that proves the environment system carries more than one
 * hour of the day.
 *
 * **`fogEnd` stays at 78, and that is a design decision rather than an
 * oversight.** `FOG_WALL` in `config/fogWall.ts` is the same number as
 * `bots.lodDisableDistance` and `bots.death.maxDistance`, and it is also what
 * `bots.perception.engageRange` (55), `audio.maxDistance` (70) and the 110 m
 * shadow window were all sized against. A daylight map that could see 200 m
 * would need every one of those moved together; this one is a fog that happens
 * to be lit, so none of them move. It reads as dawn rather than as noon, which
 * is the honest version of what the engine can currently do.
 */
export const GreyfenEnvironment: EnvironmentSpec = {
  /**
   * Shaded leaf litter: a dark olive-brown, well down from the grey-green stone
   * this map started on and down again from the warm red-brown that replaced
   * it. The sky term lifts albedo, so a floor much brighter than this comes
   * back chalky on every up-facing surface once the ambient is raised too —
   * which is the ceiling a bright soil runs into, and why this one is dark for
   * a brown.
   *
   * **It was 0x4a3928, and what moved it was the grass rather than the soil.**
   * That value is authored in display space and then multiplied by the key, the
   * ambient and the sky fill all landing on one up-facing surface at once, so a
   * floor picked as loam in the swatch renders about 2.5x brighter and arrives
   * as bright tan — savannah earth, on a map whose whole argument is that it is
   * wet. It read as a floor with nothing on it, and every tuft the layout now
   * grows sat ON it as a bright green mark rather than IN it. What fixed the
   * undergrowth was not more undergrowth: at the density the layout can afford
   * (see its note — the field is already half of this map's triangles) the
   * tufts are always going to be discrete, so what decides whether they read as
   * ground cover or as scattered weeds is how far the gaps between them are
   * from the green. Dropping the floor closes that gap from both ends.
   *
   * It is also the only colour the surface below is painted in: every tone
   * `dirt` puts on the ground is derived from this, so re-tinting the valley
   * is this one line.
   */
  floorColor: "#352f20",
  /**
   * Clods and grit rather than the flat colour Hollowmere's floor is. A jungle
   * valley is soil underfoot, and at 4 m a tile the grain is still legible at
   * the eye height a first-person camera reads the ground from.
   */
  floorSurface: "dirt",
  ridgeColor: "#5c6360",
  // Moved with the floor: this band's whole job is melting the rim's foot into
  // `floorColor`, so it follows the soil rather than the rock above it.
  ridgeScreeColor: "#55503c",
  accentColor: "#7fe0a0",
  skyColor: "#b9c6cf",
  /**
   * The haze is the light here, the same way the fog was the moonlight on
   * Hollowmere — but it is a bright wall rather than a dark one, so a
   * silhouette at 60 m reads as a dark shape against pale air instead of a
   * pale shape against dark. `fogStart` is pushed out because a bright fog
   * that begins too near flattens the middle distance into nothing.
   */
  fogColor: "#c2ccd4",
  fogStart: 34,
  fogEnd: 78,
  mistColor: "#c8d2d8",
  mistHeight: 2.4,
  // Ground mist survives the sunrise — it is the one bit of Hollowmere's
  // weather that belongs to a wet dawn as much as to a night.
  mistStrength: 0.28,
  lighting: {
    color: "#fff2dc",
    intensity: 1.12,
    /**
     * The sun, low in the east and climbing: ~52 deg, against Hollowmere's
     * ~38. Higher is deliberate and buys two things — shorter shadows, which
     * a 110 m shadow window can hold without ending them in a line across
     * open ground, and a much weaker grazing sheen on the cobbles, which is
     * what `graphics.spec.cobble` is tuned against (see its note in
     * config/graphics.ts and the override below).
     */
    direction: [-0.5, -0.79, 0.35],
    /**
     * Lifted well clear of black, but NOT as far as the total light budget
     * wants to go. Ambient, sky fill and key all add, and the first pass at
     * this map put all three high: the result was correctly bright and
     * completely flat, because nothing was left for the key light to be
     * brighter THAN. This is the term that gives way, since it is the only
     * one of the three that carries no direction at all.
     */
    ambientColor: "#8d99a4",
    ambientIntensity: 0.7,
    /**
     * Desaturated on purpose. This term is applied by `n.y` and never gated
     * by the shadow map, so it lands on every roof, road and open surface at
     * once; a saturated tone here stacked on a lifted ambient tints the whole
     * palette the one colour you are least able to judge it against. Pale and
     * weak — the overcast dome is bright but it is not blue.
     */
    skyLightColor: "#c4cdd6",
    skyLightIntensity: 0.3,
    // Barely there. A rim light reads as rim light only when the surround is
    // dark; in daylight it just makes edges look wet.
    rimColor: "#e8f0ff",
    rimIntensity: 0.12,
    // No shoulder lamp: there is nothing here it could light, and it would
    // spend one of the sixteen point-light slots doing it.
    lampIntensity: 0,
  },
  /**
   * No particles. Hollowmere's falling ash is what tells you the place is
   * dead, and under a bright sky the same field reads as snow — a different
   * claim about the weather, made by accident. Omitted rather than re-tinted:
   * `Atmosphere.apply(undefined)` stops the emitter outright.
   */
  /**
   * An overcast dawn: no disc, no stars, and a low sun's warmth smeared
   * across a white lid of cloud. `discRadius: 0` is what suppresses the sun
   * itself — and, through the moon-direction contract `Sky` and `GodRays`
   * already share, the light shafts with it. See `SkySpec.discRadius`.
   */
  sky: {
    zenithColor: "#8ea6bd",
    horizonColor: "#d3d9d8",
    starColor: "#ffffff",
    starCount: 0,
    starBrightness: 0,
    // Still the sun's colour: it tints the halo that stands in for the disc.
    moonColor: "#fff4e2",
    moonGlowColor: "#e6ded0",
    // milkyWayColor omitted — a galactic band at dawn.
    cloudColor: "#c9d2d8",
    cloudOpacity: 0.92,
    cloudLitColor: "#fff6e6",
    cloudLitStrength: 0.5,
    discRadius: 0,
    // A broad overcast brightening toward the sun rather than a moon's tight
    // bloom. The halo is the only thing left standing in for the disc.
    haloStrength: 0.34,
  },
  /**
   * The grade the map is seen through, and all three terms come down.
   *
   * Hollowmere's heavy vignette is dread; on a bright frame the same number
   * reads as a lens fault. The aberration is the one that had to be MEASURED
   * rather than reasoned about: it was left at the shipped 0.55 on the
   * argument that it is the only term still doing anything at this
   * brightness, and the first screenshot showed why that was wrong — the
   * effect scales with local contrast, and a pale sky behind dark bots is
   * nothing but high-contrast edges, so every silhouette on screen picked up
   * a colour fringe. It is a night map's number.
   */
  grade: {
    vignette: 0.22,
    grain: 0.02,
    aberration: 0.16,
  },
  // Daylight on wet stone, not moonlight: warm, weak and much less directional
  // than the cold streak Hollowmere's cobbles catch. See CONFIG.graphics.spec.
  groundSpec: { color: "#8f9498", intensity: 0.08, shininess: 14 },
  water: {
    deepColor: "#3f5148",
    shallowColor: "#7d9b90",
    foamColor: "#dfe8e2",
    // Overcast: the source is the whole sky, not a moon, and the water is the
    // whole valley rather than a creek. At Hollowmere's strength the lobe
    // covers a quarter of the frame in flat white.
    glint: 0.3,
  },
  /**
   * Wet understory: dark at the root, fresh green at the tip. These were
   * Hollowmere's dead straw for as long as the layout carried no rect for them
   * to colour — a pale grey-olive stalk under a bone tip, which is a dead
   * valley's crop and not a jungle's.
   *
   * The root does NOT sit under `floorColor` the way Hollowmere's does. That
   * rule is for a field the valley floor continues into; this is undergrowth
   * standing ON soil, and matching the root to the soil is what would make it
   * read as more soil. What it matches instead is the shaded underside of the
   * canopy above it (`graphics.translucency.canopy`), so the two green layers
   * the eye has to stack are the same green seen at two depths.
   *
   * Both are darker and more saturated than they look like they should be, for
   * the reason the ambient note above gives: the key, the ambient and the sky
   * fill all land on an up-facing blade at once, and a tip authored at the
   * colour wanted on screen comes back chalky.
   */
  grass: {
    rootColor: "#2f4326",
    tipColor: "#7d9c42",
  },
};
