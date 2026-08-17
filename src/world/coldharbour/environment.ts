/**
 * coldharbour/environment.ts — Coldharbour's EnvironmentSpec: palette, the
 * long-range haze that stands in for fog, an afternoon sun, an overcast-free
 * sky, no water, no particles. Pure data — consumed by applyEnvironment/Sky/
 * WaterSystem/Atmosphere. Fixture light POSITIONS live in layout.ts.
 */
import type { EnvironmentSpec } from "../environment";

/**
 * Coldharbour: the business district of a city, on a clear afternoon, with the
 * fighting in the streets.
 *
 * ## The fog, which is the whole point of this map
 *
 * Both shipped valleys state `fogEnd: 78`, and Greyfen's file argues at length
 * that this is a design decision rather than an oversight: the fog wall was the
 * same number as the bot LOD, the ragdoll gate and the distance every other
 * budget was sized against, so "a daylight map that could see 200 m would need
 * every one of those moved together". This is that map, and they moved.
 *
 * What actually changed is that the distance is now the MAP's rather than the
 * config's: `Game.installMap` pushes `fogEnd` into `BattleSystem`, `NetRoster`
 * and `RagdollSystem`, which are the three that gated on `FOG_WALL`. So here a
 * body is drawn, posed and tumbled out to 340 m, and the fog wall as an idea is
 * gone — what is left is aerial perspective, which is a different thing doing a
 * different job. `fogStart` is past the far side of any single street, so the
 * whole city reads clear and only the rim beyond it goes pale.
 *
 * Three consequences worth knowing before tuning any of this:
 *
 * - **The 110 m shadow window is still 110 m** (`CONFIG.graphics.shadows`), and
 *   on a map you can see across, its far edge is now in shot. What hides it is
 *   the sun's ELEVATION: at ~62 deg a forty-metre tower throws twenty-one
 *   metres of shadow, so the window's edge falls in the middle of a block
 *   rather than across open ground, and the buildings occlude what is past it.
 *   Lowering this sun for longer shadows would put that edge on screen.
 * - **There is no disc and there are no shafts**, and the second follows from
 *   the first through the zero-`moonDir` contract `Sky.clear` documents.
 *   `CONFIG.godRays`' luminance threshold IS its whole occlusion test and is
 *   calibrated against a night street; under this sky it would fire on every
 *   pale slab on the map. Greyfen reached the same conclusion from an overcast
 *   dawn and for the same reason.
 * - **Sound and bot perception did NOT move with the fog.** `audio.maxDistance`
 *   is 70 m and `bots.perception.engageRange` 55, so you can see four times
 *   further than a bot will start shooting and five times further than you can
 *   hear one. That is deliberate here and the LAYOUT is what makes it play: the
 *   avenues are broken by parked traffic, barriers and setbacks so that a clear
 *   line down one is ~110 m rather than the 320 the map is wide.
 */
export const ColdharbourEnvironment: EnvironmentSpec = {
  /**
   * Weathered pavement. Everything not roadway is this, which is most of the
   * ground plane, so it is picked dark for a grey: the sky term is applied by
   * `n.y` and the ground is the largest up-facing surface there is, so a slab
   * chosen to look right in isolation comes back white the moment the sun is on
   * it. Greyfen's note on `floorColor` is the same lesson in soil.
   */
  floorColor: "#4c4a45",
  /**
   * Weathered paving, and the four surfaces were looked at from the middle of
   * the square before this was picked — which is the only place to judge one,
   * since the floor is what a first-person camera reads for the whole round.
   *
   * `dirt`'s field is fine crazing over a 4 m tile, and in grey it is cracked
   * concrete rather than soil. The other three are all wrong here and wrong in
   * different ways: `gravel` (2.5 m) reads as a loose stone yard, not a
   * pavement, and its finer tile aliases hardest at the distances a map with no
   * fog actually shows you; `sand` puts visible DUNE RIPPLES across the square,
   * which no tint can argue with; and `flat` returns the featureless wash
   * Hollowmere's own note describes, over a map with even fewer height changes
   * to break it up.
   */
  floorSurface: "dirt",
  /**
   * The bluffs the city sits under. Read only by the rim — and on this map you
   * can actually SEE the rim, from anywhere, which is new: on both valleys it
   * is `fogColor` past 78 m and this colour only at the two home spawns. So it
   * is picked as a landform at a distance rather than as rock up close, and it
   * is deliberately close in value to the haze it stands in.
   */
  ridgeColor: "#6a7078",
  // The rim's foot, melting into `floorColor`. Warmer and near it, per the
  // EnvironmentSpec note: a bright tone here comes back chalky on the ledges.
  ridgeScreeColor: "#6b675c",
  accentColor: "#7fd0ff",
  skyColor: "#9fb6cc",
  /**
   * Distance, not weather. `fogStart` is beyond the far side of any street on
   * the map, so nothing you are fighting in is hazed at all; what the term does
   * is put air between the near blocks and the far skyline, which is the only
   * thing that makes a city read as deep rather than as a flat elevation.
   *
   * `fogEnd` is the number the LOD and ragdoll gates now take (see above). It
   * is past the map's own diagonal corner-to-corner distance at street level
   * but not past the rim behind it, which is the intent: the city is clear and
   * the bluffs behind it are pale.
   */
  fogColor: "#b3c3d2",
  fogStart: 170,
  fogEnd: 480,
  /**
   * A thin haze at street level and nothing more. Hollowmere's 0.45 is the
   * mood of the place; here the same term at any strength reads as smoke, and
   * a city with smoke in it is making a claim about what has happened that the
   * rest of the map does not support.
   */
  mistColor: "#c2cedb",
  mistHeight: 3.0,
  mistStrength: 0.07,
  lighting: {
    color: "#fff4e0",
    intensity: 1.06,
    /**
     * Mid-afternoon, high in the south-west: ~62 deg, against Greyfen's 52 and
     * Hollowmere's 38. High is doing three jobs at once and none of them is
     * taste — it keeps shadows inside the 110 m window (see the header), it
     * keeps a forty-metre tower from laying its shadow across two whole blocks,
     * and it keeps the grazing sheen off the roadway, which is what
     * `graphics.spec.cobble` is tuned against.
     */
    direction: [0.42, -0.85, -0.32],
    /**
     * Lifted, but well under what the total light budget would take — Greyfen's
     * lesson exactly. Ambient, sky fill and key all add, and the first pass
     * here had all three high: correctly bright, and completely flat, because
     * nothing was left for the key to be brighter than. Ambient gives way
     * because it is the only one of the three carrying no direction, and it is
     * also the one that decides how legible an INTERIOR is — which on this map
     * matters more than on either valley, because there are interiors.
     */
    ambientColor: "#8b95a1",
    ambientIntensity: 0.45,
    /**
     * The sky's own light, and the term that does the most work here. It lands
     * by `n.y`, so it separates every horizontal surface in the city — roadway,
     * pavement, deck, roof — from the vertical ones beside them, which on a map
     * built almost entirely of grey boxes is the only thing keeping the boxes
     * apart. Cool and weak: a saturated tone here tints the whole palette.
     */
    skyLightColor: "#b8cfe4",
    skyLightIntensity: 0.28,
    // Barely there, for Greyfen's reason: a rim light reads as rim light only
    // against a dark surround, and in daylight it makes edges look wet.
    rimColor: "#eaf4ff",
    rimIntensity: 0.1,
    /**
     * No shoulder lamp. There is nothing outdoors it could light, and it would
     * spend one of the sixteen shader slots doing it — slots this map wants for
     * the handful of interior lights the offices carry, which are the only
     * fixtures on it.
     */
    lampIntensity: 0,
  },
  /**
   * No particles. Ash is what tells you Hollowmere is dead; under this sky the
   * same field reads as snow, and dust over a city reads as an event. Omitted
   * rather than re-tinted — `Atmosphere.apply(undefined)` stops the emitter.
   */
  /**
   * A clear afternoon: high cloud, a bright quarter of sky where the sun is,
   * and no disc. See the header on why there is no disc; what stands in for it
   * is the halo, which is the term deciding whether a sky reads as lit.
   */
  sky: {
    zenithColor: "#5d86b4",
    // Close to `fogColor`, so the dome melts into the hazed rim rather than
    // cutting against it — the one hard requirement `SkySpec` states.
    horizonColor: "#b7c6d4",
    starColor: "#ffffff",
    starCount: 0,
    starBrightness: 0,
    // The sun's own warmth, tinting the halo that stands in for the disc.
    moonColor: "#fff6e4",
    moonGlowColor: "#dfe8f2",
    // milkyWayColor omitted — it is the middle of the afternoon.
    cloudColor: "#c8d6e2",
    cloudOpacity: 0.4,
    cloudLitColor: "#fffaf0",
    cloudLitStrength: 0.55,
    discRadius: 0,
    haloStrength: 0.3,
  },
  /**
   * The grade, all three terms down — Greyfen's argument, one step further.
   * A vignette that reads as dread over a night village reads as a lens fault
   * over a bright one, and the aberration scales with local contrast, which is
   * all a city of dark windows against a pale sky is.
   */
  grade: {
    vignette: 0.18,
    grain: 0.015,
    aberration: 0.1,
  },
  /**
   * The roadway's sheen. Dry asphalt under a high sun, so this is weaker and
   * broader than either valley's wet stone: the spec is tuned against the key
   * light's ELEVATION and this one is 62 deg, where a grazing streak cannot
   * form at all. It is stated rather than omitted because omitting it takes
   * `CONFIG.graphics.spec.cobble`, which is Hollowmere's 38-deg moon.
   */
  groundSpec: { color: "#8d9298", intensity: 0.05, shininess: 20 },
  // No water and no grass: neither rect list has an entry, so both palettes
  // would be dead weight. See `WaterEnvSpec` / `GrassEnvSpec` — omitting them
  // is what leaves the map dry and bald, which is what a downtown is.
};
