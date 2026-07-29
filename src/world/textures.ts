/**
 * textures.ts — Runtime-generated canvas textures (cobblestone), cached per
 * scene via WeakMap. Zero asset files. Deterministic PRNG so every client
 * renders identical ground.
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

/** Canvas size. Must stay a power of two for mipmapping. */
const SIZE = 256;
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

function drawCobblestones(ctx: ReturnType<DynamicTexture["getContext"]>): void {
  const rng = mulberry32(0xc0bb1e);
  const cw = SIZE / COLS;
  const ch = SIZE / ROWS;

  // Layout computed once, then stamped at all nine wrap offsets so the tile
  // repeats seamlessly — stones that run off one edge reappear on the other.
  const stones: Stone[] = [];
  for (let row = 0; row < ROWS; row++) {
    // Running bond: alternate rows shift half a stone sideways.
    const shift = row % 2 === 1 ? cw / 2 : 0;
    for (let col = -1; col < COLS; col++) {
      const w = cw * (0.86 + rng() * 0.1);
      const h = ch * (0.82 + rng() * 0.1);
      stones.push({
        x: col * cw + shift + (cw - w) / 2 + (rng() - 0.5) * 4,
        y: row * ch + (ch - h) / 2 + (rng() - 0.5) * 3,
        w,
        h,
        r: Math.min(w, h) * (0.22 + rng() * 0.12),
        tone: STONES[Math.floor(rng() * STONES.length)],
        highlight: rng() < 0.6,
      });
    }
  }

  ctx.fillStyle = MORTAR;
  ctx.fillRect(0, 0, SIZE, SIZE);

  for (const dy of [-SIZE, 0, SIZE]) {
    for (const dx of [-SIZE, 0, SIZE]) {
      ctx.save();
      ctx.translate(dx, dy);
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
      ctx.restore();
    }
  }
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
