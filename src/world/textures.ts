/**
 * textures.ts — Runtime-generated canvas textures (the cobblestone albedo and
 * its matching bump height map, plus the valley floor's own surfaces), cached
 * per scene via WeakMap. Zero asset files.
 * Deterministic PRNG so every client renders identical ground, and so the
 * bump domes land exactly on the painted stones.
 * Invariants: texture SIZE must stay a power of two (mipmaps) and
 * anisotropicFilteringLevel = 8 (prevents shimmer at grazing angles).
 */
import { DynamicTexture, Scene, Texture } from "@babylonjs/core";

/**
 * Procedurally painted tiling textures, generated on a 2D canvas at boot so
 * the project keeps its zero-asset rule. Used with the cel shader's
 * CEL_GROUND_TEX variant, which samples them by world position — the pattern
 * therefore keeps a constant real-world size on every mesh and tiles
 * seamlessly across separately built structures.
 *
 * Style rules (what keeps these cel-shaded rather than gritty):
 * - flat posterized tones only — the texture supplies albedo *variation*,
 *   the shader's quantized light bands supply the shading;
 * - low contrast between tones, dark mortar/gaps for the graphic read;
 * - no gradients — one highlight band per stone at most.
 *
 * Textures are authored in display space and sampled raw, matching the
 * no-image-processing pipeline (same convention as the player skin).
 */

/**
 * Cobblestone world scale: one texture repeat spans this many metres. With
 * COLS stones per repeat, one cobble lands at ~0.35 m — right for a village
 * street read at eye height.
 */
export const COBBLE_METERS_PER_TILE = 1.5;
/** Value for the cel shader's `texScale` uniform (repeats per metre). */
export const COBBLE_TEX_SCALE = 1 / COBBLE_METERS_PER_TILE;

/**
 * Canvas size. Must stay a power of two for mipmapping.
 *
 * 512 over a 1.5 m tile is ~340 texels per metre, which is what a
 * first-person camera needs: the eye is 1.55 m above the street and the
 * ground directly underfoot is magnified about 1.3x at that height. At the
 * 256 this was authored at — fine for a camera 3.3 m back over the
 * shoulder — looking down at your own feet turned the setts into blobs.
 */
const SIZE = 512;
/** Layout jitter is authored in 256-space pixels; this keeps it proportional. */
const PX = SIZE / 256;
const COLS = 4;
const ROWS = 5;

// Palette, kept next to the village palette in BuildingKit: mortar sits just
// below the darkest timber, stones jitter around DIRT with a lean toward
// STONE so the streets read as setts rather than mud.
const MORTAR = "#2c2822";
const STONES = ["#4a4438", "#514b3e", "#4e4a40", "#55524a", "#463f36"];
const HIGHLIGHT = "#5d5747";

/** Deterministic PRNG — the streets should look identical on every boot. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Stone {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  tone: string;
  highlight: boolean;
}

/** One rounded-rect path. `arc` is the only curve ICanvasRenderingContext
 * guarantees, so corners are quarter arcs. */
function stonePath(
  ctx: ReturnType<DynamicTexture["getContext"]>,
  s: Stone,
): void {
  const { x, y, w, h, r } = s;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

/**
 * The shared cobble layout, rebuilt from the one seed on demand. Both the
 * albedo and the height map draw from this exact list, so every dome in the
 * bump map sits precisely on a painted stone — a mismatch would light the
 * mortar and sink the stones.
 */
function cobbleLayout(): Stone[] {
  const rng = mulberry32(0xc0bb1e);
  const cw = SIZE / COLS;
  const ch = SIZE / ROWS;
  const stones: Stone[] = [];
  for (let row = 0; row < ROWS; row++) {
    // Running bond: alternate rows shift half a stone sideways.
    const shift = row % 2 === 1 ? cw / 2 : 0;
    for (let col = -1; col < COLS; col++) {
      const w = cw * (0.86 + rng() * 0.1);
      const h = ch * (0.82 + rng() * 0.1);
      stones.push({
        x: col * cw + shift + (cw - w) / 2 + (rng() - 0.5) * 4 * PX,
        y: row * ch + (ch - h) / 2 + (rng() - 0.5) * 3 * PX,
        w,
        h,
        r: Math.min(w, h) * (0.22 + rng() * 0.12),
        tone: STONES[Math.floor(rng() * STONES.length)],
        highlight: rng() < 0.6,
      });
    }
  }
  return stones;
}

/** Stamps `paint` at all nine wrap offsets so the tile repeats seamlessly —
 * stones that run off one edge reappear on the other. */
function stampWrapped(
  ctx: ReturnType<DynamicTexture["getContext"]>,
  paint: () => void,
): void {
  for (const dy of [-SIZE, 0, SIZE]) {
    for (const dx of [-SIZE, 0, SIZE]) {
      ctx.save();
      ctx.translate(dx, dy);
      paint();
      ctx.restore();
    }
  }
}

function drawCobblestones(ctx: ReturnType<DynamicTexture["getContext"]>): void {
  const stones = cobbleLayout();

  ctx.fillStyle = MORTAR;
  ctx.fillRect(0, 0, SIZE, SIZE);

  stampWrapped(ctx, () => {
    for (const s of stones) {
      ctx.fillStyle = s.tone;
      stonePath(ctx, s);
      ctx.fill();
      if (s.highlight) {
        // A single flat band across the top third — the posterized
        // "lit facet". The shader's light bands do the rest.
        ctx.fillStyle = HIGHLIGHT;
        stonePath(ctx, {
          ...s,
          y: s.y + s.h * 0.1,
          h: s.h * 0.28,
          w: s.w * 0.84,
          x: s.x + s.w * 0.08,
          r: s.r * 0.6,
        });
        ctx.fill();
      }
    }
  });
}

/** Grayscale string for a 0..1 height value. */
function gray(v: number): string {
  const c = Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${c},${c},${c})`;
}

/**
 * Height map matching the albedo stone-for-stone: black mortar grooves,
 * each stone a *worn pillow* — a flat crown with a rounded shoulder that
 * falls to black exactly at the stone's edges. An earlier version used a
 * plain linear radial gradient, which is a cone (constant slope) and reads
 * as a bump stuck on every sett; the plateau profile plus per-stone jitter
 * is what makes the street read as weathered masonry.
 *
 * The dome is drawn in unit space scaled to the stone's own aspect, so it
 * is elliptical like the sett, not circular. The cel shader's CEL_BUMP path
 * turns the per-pixel slope of this into a perturbed normal. Gradients are
 * fine here — the "flat tones only" rule governs albedo; it is the shader's
 * band quantization that keeps the lit result toon, not the height data.
 */
function drawCobblestoneHeights(
  ctx: ReturnType<DynamicTexture["getContext"]>,
): void {
  const stones = cobbleLayout();
  // A SECOND rng stream, consumed in the same deterministic draw order. It
  // must not touch cobbleLayout's seed — adding draws there would shift the
  // sequence and repaint the whole street's albedo.
  const rng = mulberry32(0xd0e5 ^ 0xc0bb1e);

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, SIZE, SIZE);

  stampWrapped(ctx, () => {
    for (const s of stones) {
      // Worn setts are never identical: peak height, dome centre drift,
      // and how much flat crown survives all vary per stone.
      const peak = 0.72 + rng() * 0.28;
      const ox = (rng() - 0.5) * s.w * 0.14;
      const oy = (rng() - 0.5) * s.h * 0.14;
      const plateau = 0.35 + rng() * 0.25; // flat-top fraction of the radius
      const shoulder = plateau + (0.95 - plateau) * 0.55;

      ctx.save();
      ctx.translate(s.x + s.w / 2 + ox, s.y + s.h / 2 + oy);
      ctx.scale(s.w / 2, s.h / 2);
      // Unit-space gradient: flat crown out to `plateau`, a quick rounded
      // shoulder, then black at the rim — so mortar between stones is a
      // true groove, and corners (past radius 1) clamp to black like the
      // albedo's rounded-rect cut.
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, gray(peak));
      g.addColorStop(plateau, gray(peak * 0.97));
      g.addColorStop(shoulder, gray(peak * 0.45));
      g.addColorStop(0.95, gray(0.02));
      g.addColorStop(1, "#000000");
      ctx.fillStyle = g;
      // Rounded-rect path in the same unit space; the corner radius scaled
      // by the smaller half-extent tracks the albedo's arcs closely enough
      // (height there is ~black either way).
      stonePath(ctx, {
        x: -1,
        y: -1,
        w: 2,
        h: 2,
        r: (2 * s.r) / Math.min(s.w, s.h),
        tone: "",
        highlight: false,
      });
      ctx.fill();
      ctx.restore();
    }
  });
}

/** Generated textures are per-scene and built once, on first use. */
const cache = new WeakMap<Scene, Map<string, DynamicTexture>>();

function getGenerated(
  scene: Scene,
  key: string,
  draw: (ctx: ReturnType<DynamicTexture["getContext"]>) => void,
): DynamicTexture {
  let byKey = cache.get(scene);
  if (!byKey) {
    byKey = new Map();
    cache.set(scene, byKey);
  }
  let tex = byKey.get(key);
  if (!tex) {
    tex = new DynamicTexture(key, { width: SIZE, height: SIZE }, scene, true);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    // Ground textures are viewed at grazing angles constantly; without
    // anisotropy the pattern shimmers and there is no post AA to hide it.
    tex.anisotropicFilteringLevel = 8;
    tex.hasAlpha = false;
    draw(tex.getContext());
    tex.update();
    byKey.set(key, tex);
  }
  return tex;
}

/** The village street cobblestone: grey-brown setts in dark mortar. */
export function getCobblestoneTexture(scene: Scene): DynamicTexture {
  return getGenerated(scene, "cobblestone", drawCobblestones);
}

/**
 * Matching height map for the cobblestone albedo (same layout, same seed):
 * domed setts over black mortar, consumed by the cel shader's CEL_BUMP path.
 */
export function getCobblestoneBumpTexture(scene: Scene): DynamicTexture {
  return getGenerated(scene, "cobblestone-bump", drawCobblestoneHeights);
}

/* ------------------------------------------------------------------------ *
 * The valley floor's surfaces
 *
 * The cobbles above are a place — a village street, painted in the village's
 * own colours. These are the opposite: a PATTERN with no colour of its own,
 * painted from whatever `EnvironmentSpec.floorColor` the map states. That
 * split is the whole reason a map can pick one.
 *
 * **The colour stays one fact.** `floorColor` is already what the untextured
 * floor is, what `ridgeScreeColor` is asked to melt into and what a grass
 * field's roots are matched against; a surface that carried its own palette
 * would be a second answer to the same question, and the two would drift the
 * first time a map was re-tinted. So every tone here is DERIVED from the base
 * — `shadeOf` lightens, darkens and warms it — and the tile's average is kept
 * near the base, so switching a map from `flat` to `dirt` changes the grain
 * without changing the colour of the ground.
 *
 * **Albedo and bump share one grain layout, and the bump is cached without
 * the colour.** The layouts are seeded per surface and read no colour at all,
 * so the height map for `dirt` is one texture however many maps ask for it in
 * however many tints — the same reasoning that gives the cobbles one bump map,
 * for the same reason: a dome that does not sit on the grain it belongs to
 * lights the gaps and sinks the lumps.
 * ------------------------------------------------------------------------ */

/** A base colour's channels, 0..255. */
function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * A tone derived from the map's floor colour: `mul` scales it toward white or
 * black, `warm` pushes it toward red-brown (positive) or blue-green
 * (negative), in fractions of full scale.
 *
 * Derivation rather than authored tones is what lets one pattern serve every
 * map — the same clods over Greyfen's loam and over a grey silt read as the
 * same ground in two different soils.
 */
export function shadeOf(hex: string, mul: number, warm = 0): string {
  const [r, g, b] = rgbOf(hex);
  const w = warm * 255;
  const c = (v: number, d: number) =>
    Math.round(Math.min(255, Math.max(0, v * mul + d)));
  return `rgb(${c(r, w)},${c(g, 0)},${c(b, -w)})`;
}

/** One painted grain: a squashed disc, plus the roll that picks its tone. */
interface Grain {
  x: number;
  y: number;
  /** Half-width, in texels. */
  r: number;
  /** Vertical squash — 1 is circular, lower is flatter. */
  ry: number;
  /** 0..1. The grain's own roll: its tone in the albedo, its height in the
   *  bump. Stored rather than re-drawn so the two passes agree. */
  t: number;
}

/**
 * A scatter of grains over the tile from one seed. Sizes are authored in
 * 256-space like the cobbles' jitter, so `SIZE` can move without re-tuning
 * every surface.
 */
function grainField(
  seed: number,
  count: number,
  rMin: number,
  rMax: number,
  squash: number,
): Grain[] {
  const rng = mulberry32(seed);
  const out: Grain[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: rng() * SIZE,
      y: rng() * SIZE,
      r: (rMin + rng() * (rMax - rMin)) * PX,
      ry: 1 - rng() * squash,
      t: rng(),
    });
  }
  return out;
}

/**
 * Every grain layout, by surface. Read by both the albedo and the bump, and
 * by neither with a colour in hand — see the header.
 */
const GRAINS = {
  /** Clods, with a fine litter of small stuff worked through them. */
  dirt: () => [
    ...grainField(0xd1d7, 520, 3, 13, 0.5),
    ...grainField(0xd1d8, 320, 1, 3.4, 0.3),
  ],
  /** Dense small stones, almost no gap left between them. */
  gravel: () => grainField(0x9a4e1, 1020, 2, 5.5, 0.35),
  /** Fine speckle. The ripples are drawn on top and are not grains. */
  sand: () => grainField(0x5a4d, 900, 0.8, 2.6, 0.55),
  /** Broad mottled patches — ground cover rather than soil. */
  turf: () => grainField(0x70f13, 480, 5, 22, 0.5),
} as const;

/**
 * Which floor patterns exist, derived from the layouts above so the id is
 * declared exactly once. `floorSurfaces.ts` keys its tuning table off this,
 * which is what makes a new pattern a compile error until it is tuned.
 */
export type FloorPatternId = keyof typeof GRAINS;

/**
 * Paints one grain, wrapped only where it actually crosses an edge. The
 * cobbles stamp the whole layout nine times because a sett is a tenth of the
 * tile wide; a thousand grains stamped nine times is nine thousand fills for
 * the sake of the few dozen on a border.
 */
function paintGrain(g: Grain, paint: (x: number, y: number) => void): void {
  const w = g.r + 1;
  const dxs = g.x < w ? [0, SIZE] : g.x > SIZE - w ? [0, -SIZE] : [0];
  const dys = g.y < w ? [0, SIZE] : g.y > SIZE - w ? [0, -SIZE] : [0];
  for (const dy of dys) for (const dx of dxs) paint(g.x + dx, g.y + dy);
}

/** Flat discs in a tone picked by each grain's own roll. */
function paintGrains(
  ctx: ReturnType<DynamicTexture["getContext"]>,
  grains: Grain[],
  tone: (t: number) => string,
): void {
  for (const g of grains) {
    ctx.fillStyle = tone(g.t);
    paintGrain(g, (x, y) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, g.ry);
      ctx.beginPath();
      ctx.arc(0, 0, g.r, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  }
}

/**
 * The same grains as height: a flat crown falling to black at the rim, the
 * cobbles' worn-pillow profile at a smaller scale. `peak` maps a grain's roll
 * onto 0..1 height and `plateau` is how much of the radius stays flat — a low
 * plateau is a lump, a high one is a pebble with a shoulder.
 */
function paintGrainHeights(
  ctx: ReturnType<DynamicTexture["getContext"]>,
  grains: Grain[],
  peak: (t: number) => number,
  plateau: number,
): void {
  for (const g of grains) {
    const h = Math.min(1, Math.max(0, peak(g.t)));
    paintGrain(g, (x, y) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(g.r, g.r * g.ry);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      grad.addColorStop(0, gray(h));
      grad.addColorStop(plateau, gray(h * 0.95));
      grad.addColorStop(plateau + (1 - plateau) * 0.55, gray(h * 0.4));
      grad.addColorStop(1, "#000000");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  }
}

/**
 * Wind ripples for sand: shallow bands crossing the tile, drawn as blocks
 * rather than as a curve because a hard-edged step is what the posterized
 * palette wants anyway — and because `arc` is the only curve the canvas
 * interface guarantees.
 *
 * The band count divides SIZE exactly and the phase is a whole number of
 * cycles across the tile, so both ends meet at the seam.
 */
const RIPPLE_BANDS = 16;
const RIPPLE_STEP = 8;

function paintRipples(
  ctx: ReturnType<DynamicTexture["getContext"]>,
  crest: string,
  trough: string,
): void {
  const band = SIZE / RIPPLE_BANDS;
  for (let b = 0; b < RIPPLE_BANDS; b++) {
    for (let x = 0; x < SIZE; x += RIPPLE_STEP) {
      // Two whole cycles across the tile, offset per band so the ripples are
      // not a stack of identical waves.
      const wave = Math.sin((x / SIZE) * Math.PI * 4 + b * 1.7) * band * 0.22;
      const y = b * band + band * 0.5 + wave;
      ctx.fillStyle = crest;
      ctx.fillRect(x, y, RIPPLE_STEP, band * 0.16);
      ctx.fillStyle = trough;
      ctx.fillRect(x, y + band * 0.16, RIPPLE_STEP, band * 0.1);
    }
  }
}

/**
 * The albedo painters. Each fills the tile with a base a little off the map's
 * own colour and then puts the grain back on top around it, so the tile
 * averages near `base` — a surface changes the grain, not the ground's colour.
 */
const ALBEDO: Record<
  FloorPatternId,
  (ctx: ReturnType<DynamicTexture["getContext"]>, base: string) => void
> = {
  dirt: (ctx, base) => {
    ctx.fillStyle = shadeOf(base, 0.88, 0.02);
    ctx.fillRect(0, 0, SIZE, SIZE);
    // Warmer where it is lighter: dry crumbs on top, damp soil underneath.
    paintGrains(ctx, GRAINS.dirt(), (t) =>
      shadeOf(base, 0.78 + t * 0.48, (t - 0.5) * 0.05),
    );
  },
  gravel: (ctx, base) => {
    // A deep gap colour, because gravel reads as stones-and-shadow. Most of
    // it is covered by the stones themselves.
    ctx.fillStyle = shadeOf(base, 0.52);
    ctx.fillRect(0, 0, SIZE, SIZE);
    const grains = GRAINS.gravel();
    paintGrains(ctx, grains, (t) => shadeOf(base, 0.84 + t * 0.5));
    // One flat lit facet on the upper stones — the cobbles' trick, at a
    // fifth of the size.
    for (const g of grains) {
      if (g.t < 0.62) continue;
      ctx.fillStyle = shadeOf(base, 1.38);
      paintGrain(g, (x, y) => {
        ctx.beginPath();
        ctx.arc(x - g.r * 0.22, y - g.r * g.ry * 0.28, g.r * 0.4, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fill();
      });
    }
  },
  sand: (ctx, base) => {
    ctx.fillStyle = shadeOf(base, 0.97, 0.01);
    ctx.fillRect(0, 0, SIZE, SIZE);
    paintRipples(ctx, shadeOf(base, 1.1, 0.02), shadeOf(base, 0.88));
    paintGrains(ctx, GRAINS.sand(), (t) => shadeOf(base, 0.9 + t * 0.26));
  },
  turf: (ctx, base) => {
    // Cooler and darker between the patches: the gaps are where the litter
    // and the shade are, not bare soil.
    ctx.fillStyle = shadeOf(base, 0.76, -0.03);
    ctx.fillRect(0, 0, SIZE, SIZE);
    paintGrains(ctx, GRAINS.turf(), (t) =>
      shadeOf(base, 0.84 + t * 0.44, (t - 0.5) * -0.07),
    );
  },
};

/** The matching height maps, off the same grains. */
const HEIGHTS: Record<
  FloorPatternId,
  (ctx: ReturnType<DynamicTexture["getContext"]>) => void
> = {
  dirt: (ctx) =>
    paintGrainHeights(ctx, GRAINS.dirt(), (t) => 0.34 + t * 0.5, 0.28),
  // Harder and rounder than soil: a high plateau is a stone, not a lump.
  gravel: (ctx) =>
    paintGrainHeights(ctx, GRAINS.gravel(), (t) => 0.5 + t * 0.5, 0.42),
  sand: (ctx) => {
    paintRipples(ctx, gray(0.5), gray(0.16));
    paintGrainHeights(ctx, GRAINS.sand(), (t) => 0.2 + t * 0.3, 0.3);
  },
  turf: (ctx) =>
    paintGrainHeights(ctx, GRAINS.turf(), (t) => 0.3 + t * 0.42, 0.35),
};

/**
 * A floor pattern's albedo in this map's own floor colour.
 *
 * The cache key carries the colour, so two maps on the same pattern in
 * different soils are two textures rather than whichever asked first — the
 * trap `CelMaterialFactory`'s spec registry documents from the other side.
 */
export function getFloorTexture(
  scene: Scene,
  id: FloorPatternId,
  baseHex: string,
): DynamicTexture {
  return getGenerated(scene, `floor-${id}-${baseHex}`, (ctx) =>
    ALBEDO[id](ctx, baseHex),
  );
}

/**
 * The height map matching that albedo. Keyed WITHOUT the colour: the grains
 * are seeded per surface and read none, so every tint of one pattern shares
 * one bump map.
 */
export function getFloorBumpTexture(
  scene: Scene,
  id: FloorPatternId,
): DynamicTexture {
  return getGenerated(scene, `floor-${id}-bump`, (ctx) => {
    // Explicitly black rather than the canvas's transparent start, exactly as
    // the cobbles' height map is: what the shader reads is the red channel,
    // and a height map that is transparent where nothing was painted leaves
    // the flat ground between grains at the mercy of how the upload treats
    // alpha.
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, SIZE, SIZE);
    HEIGHTS[id](ctx);
  });
}
