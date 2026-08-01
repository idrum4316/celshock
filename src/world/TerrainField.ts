/**
 * TerrainField.ts — The valley floor's height, and the one place that knows it.
 * Owns: sampling a layout's Heightfield at any (x, z), editing it, and
 * tessellating it into per-block VertexData for MapBuilder to hang meshes on —
 * plus `terrainSlab`, which bends a flat footprint (a road) onto that same
 * surface, so ground-hugging dressing is cut against the floor by the one file
 * that knows its shape.
 *
 * Before this file the floor was the literal number 0, asserted independently
 * in MapBuilder (a flat box), NavGrid (a free surface in every cell), the
 * player's ground probe, the shadow system and the grass system. Terrain is a
 * *field*, not a pile of colliders, precisely so those five can go back to
 * agreeing: everything that used to assume zero calls heightAt instead.
 *
 * Invariants: heightAt is pure and cheap enough to call per nav cell (25,600
 * of them at load) and per grass tuft. A field with no heightfield returns 0
 * everywhere and tessellates to the single quad the flat map always had, so a
 * level map costs exactly what it used to.
 *
 * This file must NOT create meshes, materials or colliders — it hands back
 * VertexData and lets MapBuilder own the scene.
 */
import { VertexData } from "@babylonjs/core";
import { CONFIG } from "../config";
import type { Heightfield, WaterRect } from "./layout";

/** One block's worth of ground, ready to become a mesh. */
export interface TerrainPatch {
  /** Map-block key, `${bx},${bz}` — the same convention BlockMerge uses. */
  key: string;
  data: VertexData;
}

/**
 * How finely `terrainSlab` steps a footprint it cannot align to the grid, as a
 * fraction of a terrain cell. An off-axis slab cuts across the floor's own
 * triangles however it is sampled, so the only lever is quad size: the
 * residual falls with the square of the step, and a quarter cell puts it under
 * the centimetre a road is lifted by. Nothing on Hollowmere takes this path —
 * `hygiene` already flags placements off the quarter turns.
 */
const SLAB_OFF_AXIS_STEP = 0.25;

/** A flat rectangular footprint about to be bent onto the ground under it. */
export interface SlabSpec {
  /** Footprint in the placement's local frame: width along X, length along Z. */
  w: number;
  len: number;
  /** Where MapBuilder is going to put it. */
  x: number;
  z: number;
  rotY: number;
  /** The origin Y MapBuilder will translate by; local Y is measured from it. */
  originY: number;
  /** How far the top face rides above the ground, and how far the skirt hangs. */
  top: number;
  thickness: number;
}

/** An empty, level heightfield at the given resolution. */
export function emptyHeightfield(cell: number): Heightfield {
  const size = Math.round(CONFIG.map.size / cell);
  return { size, cell, heights: new Array((size + 1) * (size + 1)).fill(0) };
}

export class TerrainField {
  /** Half the map, cached — every sample needs it. */
  private readonly half = CONFIG.map.size / 2;

  constructor(readonly field?: Heightfield) {}

  /** True when nothing reshapes the floor; lets callers keep their fast path. */
  get flat(): boolean {
    return this.field === undefined;
  }

  /**
   * Ground height at a world position, bilinearly interpolated between the
   * four grid vertices around it. Queries outside the grid clamp to its edge,
   * which is what keeps the ridge and the map border well-defined.
   */
  heightAt(x: number, z: number): number {
    const f = this.field;
    if (!f) return 0;
    const n = f.size;
    const gx = clamp((x + this.half) / f.cell, 0, n);
    const gz = clamp((z + this.half) / f.cell, 0, n);
    const i0 = Math.min(Math.floor(gx), n - 1);
    const j0 = Math.min(Math.floor(gz), n - 1);
    const fx = gx - i0;
    const fz = gz - j0;
    const row = n + 1;
    const h = f.heights;
    const a = h[j0 * row + i0];
    const b = h[j0 * row + i0 + 1];
    const c = h[(j0 + 1) * row + i0];
    const d = h[(j0 + 1) * row + i0 + 1];
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
  }

  /**
   * The floor's height as it is DRAWN: the plane of the triangle
   * `terrainPatches` emits under (x, z), rather than the smooth field
   * `heightAt` interpolates.
   *
   * The two are the same on a level or untwisted cell and differ by up to a
   * quarter of the cell's twist otherwise — bilinear is a curved surface and
   * the mesh is two flat triangles cut across it. That is nothing to a ground
   * probe and everything to a road lying a centimetre above the floor: sample
   * the smooth field and the road sinks under the mesh in every twisted cell,
   * which shows up as the ground eating holes in the cobbles. Gameplay wants
   * the field; anything laid ON the floor wants this.
   *
   * `ceil` returns the higher of the cell's two triangle planes instead of the
   * one actually under (x, z). That is the upper envelope of the pair, so it
   * is convex within the cell, so a triangle drawn between three samples of it
   * lies above it everywhere in between — which is exactly the guarantee a
   * slab laid on the floor needs at the samples it cannot place on a grid
   * vertex. It costs a few millimetres of float on a twisted cell and buys
   * "never below the ground" outright.
   */
  surfaceAt(x: number, z: number, ceil = false): number {
    const f = this.field;
    if (!f) return 0;
    const n = f.size;
    const gx = clamp((x + this.half) / f.cell, 0, n);
    const gz = clamp((z + this.half) / f.cell, 0, n);
    const i = Math.min(Math.floor(gx), n - 1);
    const j = Math.min(Math.floor(gz), n - 1);
    const u = gx - i;
    const v = gz - j;
    const row = n + 1;
    const h = f.heights;
    // Corners in Accum.quad's order: -X/-Z, +X/-Z, +X/+Z, -X/+Z. Its diagonal
    // runs a→c, so v <= u is the first triangle.
    const a = h[j * row + i];
    const b = h[j * row + i + 1];
    const c = h[(j + 1) * row + i + 1];
    const d = h[(j + 1) * row + i];
    const lo = a + (b - a) * u + (c - b) * v;
    const hi = a + (c - d) * u + (d - a) * v;
    if (ceil) return lo > hi ? lo : hi;
    return v <= u ? lo : hi;
  }

  /** World position of grid vertex (i, j). */
  vertexAt(i: number, j: number): { x: number; z: number } {
    const cell = this.field?.cell ?? 1;
    return { x: -this.half + i * cell, z: -this.half + j * cell };
  }

  /** Nearest grid vertex to a world position, clamped into the grid. */
  nearestVertex(x: number, z: number): { i: number; j: number } {
    const f = this.field;
    if (!f) return { i: 0, j: 0 };
    return {
      i: Math.round(clamp((x + this.half) / f.cell, 0, f.size)),
      j: Math.round(clamp((z + this.half) / f.cell, 0, f.size)),
    };
  }
}

/**
 * A pool's surface height: whatever the rect asks for, or ankle-deep over its
 * own bed. Lives here rather than in WaterSystem so the editor's proxy and the
 * real water cannot end up at different heights — they did, and a translucent
 * sheet hanging over a dug basin looks exactly like the ground disappearing.
 */
export function waterY(r: WaterRect, terrain: TerrainField): number {
  return r.y ?? terrain.heightAt(r.x, r.z) + CONFIG.water.surfaceY;
}

/**
 * The steepest gradient the nav graph will link across: `NavGrid.link` joins
 * neighbouring surfaces only within `stepHeight`, and its cells are
 * `nav.cellSize` apart. Terrain steeper than this severs its own links and
 * strands whatever is beyond it, which is why the editor validates against it
 * and the brush reports it.
 */
export const MAX_WALKABLE_GRADE = CONFIG.nav.stepHeight / CONFIG.nav.cellSize;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Tessellates the floor, one VertexData per map block.
 *
 * Two fast paths keep a mostly-level map cheap. With no heightfield at all the
 * whole floor is a single quad — the same two triangles the old flat ground box
 * drew. With one, a block whose vertices are all the same height collapses to a
 * quad too, so on Hollowmere only the handful of blocks holding the pools carry
 * real geometry.
 */
export function terrainPatches(
  terrain: TerrainField,
  size: number,
  blockSize: number,
): TerrainPatch[] {
  const f = terrain.field;
  const half = size / 2;
  if (!f) {
    const acc = new Accum();
    acc.flatQuad(-half, -half, half, half, 0);
    return [{ key: "0,0", data: acc.finish() }];
  }

  // Blocks are whole numbers of cells, so a block boundary always lands on a
  // grid line and no quad ever straddles two blocks.
  const perBlock = Math.round(blockSize / f.cell);
  const out: TerrainPatch[] = [];

  for (let bj = 0; bj * perBlock < f.size; bj++) {
    for (let bi = 0; bi * perBlock < f.size; bi++) {
      const i0 = bi * perBlock;
      const j0 = bj * perBlock;
      const i1 = Math.min(i0 + perBlock, f.size);
      const j1 = Math.min(j0 + perBlock, f.size);
      const acc = new Accum();

      const level = uniformHeight(f, i0, j0, i1, j1);
      if (level !== null) {
        const a = terrain.vertexAt(i0, j0);
        const b = terrain.vertexAt(i1, j1);
        acc.flatQuad(a.x, a.z, b.x, b.z, level);
      } else {
        acc.grid(terrain, f, i0, j0, i1, j1);
      }

      // Terrain blocks are cut on grid lines, so they do not line up with
      // BlockMerge's `floor(x / BLOCK_SIZE)` seams. That is fine — the key is
      // only a mesh name here, and the point of splitting is a tight bounding
      // box per mesh, not agreement with the structure blocks.
      out.push({ key: `${bi},${bj}`, data: acc.finish() });
    }
  }
  return out;
}

/** The block's common height, or null when it is not level. */
function uniformHeight(
  f: Heightfield,
  i0: number,
  j0: number,
  i1: number,
  j1: number,
): number | null {
  const row = f.size + 1;
  const first = f.heights[j0 * row + i0];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (f.heights[j * row + i] !== first) return null;
    }
  }
  return first;
}

/**
 * Re-tessellates a flat rectangular footprint so it follows the ground under
 * it, in the placement's LOCAL frame — MapBuilder still rotates and translates
 * the result, so the origin-local builder contract is untouched. The top face
 * rides `top` above the field and a perimeter skirt hangs `thickness` below it,
 * which is what keeps the slab silhouette `renderOutline` traces.
 *
 * Returns null when the ground under the footprint is level, so a road on flat
 * ground stays the single box it has always been.
 *
 * Three things are what let this work at a centimetre of lift, and each of them
 * is a bug that was there before it:
 *
 * - It samples `surfaceAt`, the floor as drawn, not `heightAt`, the smooth
 *   field the floor is cut from. Follow the field and the slab sinks under the
 *   mesh on every twisted cell.
 * - Its cuts are the terrain's own grid lines and nothing between them, so on a
 *   quarter turn a slab quad coincides with a terrain quad and the two surfaces
 *   cannot cross. The `ceil` sampling covers the samples that cannot land on a
 *   grid line — the footprint's own edges.
 * - An odd quarter turn maps the local diagonal onto the world anti-diagonal,
 *   so the quads are cut the other way round there.
 *
 * Off the quarter turns none of that alignment exists and the footprint is
 * simply stepped fine enough (SLAB_OFF_AXIS_STEP) that what is left is smaller
 * than the lift on any ground a falloff brush produces.
 */
export function terrainSlab(
  terrain: TerrainField,
  s: SlabSpec,
): VertexData | null {
  const f = terrain.field;
  if (!f) return null;
  const half = CONFIG.map.size / 2;

  // Which world axis each local axis maps onto, on a quarter turn. rotateY
  // sends local (lx, lz) to (lx*cos + lz*sin, -lx*sin + lz*cos), so at a
  // multiple of 90 deg each local axis drives exactly one world axis: `base` is
  // the world coordinate it runs from and `sign` its direction.
  const cos = Math.cos(s.rotY);
  const sin = Math.sin(s.rotY);
  const quarter = Math.PI / 2;
  const square =
    Math.abs(s.rotY - Math.round(s.rotY / quarter) * quarter) < 1e-6;
  const straight = Math.abs(cos) > 0.5; // local X on world X, else on world Z
  const xs = slabCuts(
    s.w / 2,
    square ? { base: straight ? s.x : s.z, sign: straight ? cos : -sin } : null,
    f.cell,
    half,
  );
  const zs = slabCuts(
    s.len / 2,
    square ? { base: straight ? s.z : s.x, sign: straight ? cos : sin } : null,
    f.cell,
    half,
  );

  // Local Y at every sample, row-major over (zs, xs), plus the world XZ the
  // ground shader would project the cobble from.
  const nx = xs.length;
  const ys: number[] = [];
  const wxs: number[] = [];
  const wzs: number[] = [];
  let level = true;
  for (const lz of zs) {
    for (const lx of xs) {
      const wx = s.x + lx * cos + lz * sin;
      const wz = s.z - lx * sin + lz * cos;
      const y = terrain.surfaceAt(wx, wz, true) + s.top - s.originY;
      if (ys.length > 0 && Math.abs(y - ys[0]) > 1e-6) level = false;
      ys.push(y);
      wxs.push(wx);
      wzs.push(wz);
    }
  }
  if (level) return null;

  const acc = new Accum();
  const top: number[] = [];
  for (let k = 0; k < ys.length; k++) {
    const i = k % nx;
    const j = (k - i) / nx;
    top.push(acc.vertex(xs[i], ys[k], zs[j], wxs[k], wzs[k]));
  }
  // Which way to cut each quad. The floor splits its own cells from -X/-Z to
  // +X/+Z in WORLD space, and an odd quarter turn maps the local diagonal onto
  // the world anti-diagonal — so the road would split every cell the other way
  // from the ground it is lying on and dive through it on each twist. Starting
  // the quad one corner along flips the diagonal back; the corner order stays
  // cyclic, so the winding is unaffected.
  const flip = square && !straight;
  for (let j = 0; j < zs.length - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const v = j * nx + i;
      const [a, b, c, d] = [top[v], top[v + 1], top[v + nx + 1], top[v + nx]];
      if (flip) acc.face(b, c, d, a);
      else acc.face(a, b, c, d);
    }
  }

  // Perimeter skirt, walked so that each side's outward face comes out front.
  // Its vertices are its own rather than the top face's, so the crease stays
  // sharp and the top keeps pointing straight up.
  const th = s.thickness;
  const w2 = s.w / 2;
  const l2 = s.len / 2;
  const last = zs.length - 1;
  for (let j = 0; j < last; j++) {
    const a = j * nx;
    const b = (j + 1) * nx;
    acc.skirt(-w2, ys[a], zs[j], -w2, ys[b], zs[j + 1], th);
    acc.skirt(w2, ys[b + nx - 1], zs[j + 1], w2, ys[a + nx - 1], zs[j], th);
  }
  for (let i = 0; i < nx - 1; i++) {
    const e = last * nx;
    acc.skirt(xs[i + 1], ys[i + 1], -l2, xs[i], ys[i], -l2, th);
    acc.skirt(xs[i], ys[e + i], l2, xs[i + 1], ys[e + i + 1], l2, th);
  }

  // The skirt's normals point sideways by design, so the floor's face-up
  // assertion does not apply to this shape.
  return acc.finish(false);
}

/**
 * Sample coordinates across one local axis of a slab footprint, from
 * `-extent` to `+extent`.
 *
 * With an `axis` the footprint is on a quarter turn, so the cuts are the grid
 * lines themselves and nothing else: a slab quad then coincides with a terrain
 * quad, corner for corner and diagonal for diagonal, and the two surfaces
 * cannot cross. Splitting a cell finer would be strictly worse — the extra
 * vertices sit on the floor's *plane* only where the two triangulations agree,
 * and a mid-cell sample lands on the wrong side of the terrain's diagonal.
 *
 * Without an axis there is nothing to align to and the footprint is simply
 * stepped, which is approximate by construction; `hygiene` already nudges
 * placements onto quarter turns.
 */
function slabCuts(
  extent: number,
  axis: { base: number; sign: number } | null,
  cell: number,
  mapHalf: number,
): number[] {
  const cuts = [-extent];
  if (axis) {
    // Grid lines sit at world `-mapHalf + k * cell`; a local t maps to world
    // `base + sign * t`, so the crossings are an arithmetic progression of
    // step `cell` through `sign * (-mapHalf - base)`.
    const u0 = axis.sign * (-mapHalf - axis.base);
    const first = u0 + Math.ceil((-extent - u0) / cell) * cell;
    for (let t = first; t < extent - 1e-6; t += cell) {
      if (t > -extent + 1e-6) cuts.push(t);
    }
    cuts.push(extent);
    return cuts;
  }

  const steps = Math.max(1, Math.ceil((2 * extent) / (cell * SLAB_OFF_AXIS_STEP)));
  for (let k = 1; k <= steps; k++) cuts.push(-extent + (2 * extent * k) / steps);
  return cuts;
}

/** Accumulates quads into one block's buffers. */
class Accum {
  private readonly positions: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];

  /** One level quad spanning a whole region. */
  flatQuad(x0: number, z0: number, x1: number, z1: number, y: number): void {
    const base = this.positions.length / 3;
    for (const [x, z] of [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ]) {
      this.positions.push(x, y, z);
      this.uvs.push(x, z);
    }
    this.quad(base, base + 1, base + 2, base + 3);
  }

  /** The real thing: one quad per cell, vertices shared across the block. */
  grid(
    terrain: TerrainField,
    f: Heightfield,
    i0: number,
    j0: number,
    i1: number,
    j1: number,
  ): void {
    const row = f.size + 1;
    const w = i1 - i0 + 1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const at = terrain.vertexAt(i, j);
        this.positions.push(at.x, f.heights[j * row + i], at.z);
        this.uvs.push(at.x, at.z);
      }
    }
    for (let j = 0; j < j1 - j0; j++) {
      for (let i = 0; i < i1 - i0; i++) {
        const v = j * w + i;
        // -X/-Z, +X/-Z, +X/+Z, -X/+Z — the same corner order flatQuad uses.
        this.quad(v, v + 1, v + w + 1, v + w);
      }
    }
  }

  /** One vertex, returning its index — for shapes `grid` does not cover. */
  vertex(x: number, y: number, z: number, u: number, v: number): number {
    this.positions.push(x, y, z);
    this.uvs.push(u, v);
    return this.positions.length / 3 - 1;
  }

  /** `quad`, by index, for callers that placed their own vertices. */
  face(a: number, b: number, c: number, d: number): void {
    this.quad(a, b, c, d);
  }

  /**
   * One panel of a slab's skirt: a top edge from p0 to p1 and the two vertices
   * `th` below them. The resulting face points along the edge direction turned
   * a quarter turn to its right, so walking a perimeter anticlockwise seen
   * from above puts every panel's front face outward.
   */
  skirt(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    th: number,
  ): void {
    const a = this.vertex(x0, y0, z0, x0, z0);
    const b = this.vertex(x1, y1, z1, x1, z1);
    const c = this.vertex(x1, y1 - th, z1, x1, z1);
    const d = this.vertex(x0, y0 - th, z0, x0, z0);
    this.quad(a, b, c, d);
  }

  /**
   * Two triangles for one quad, given its corners in -X/-Z, +X/-Z, +X/+Z,
   * -X/+Z order. Wound for Babylon's LEFT-handed default
   * (`scene.useRightHandedSystem` is false), where a front face is clockwise
   * seen from the front.
   *
   * The right-handed order reads as correct if you work the cross product out
   * on paper and is silently wrong here — see `assertFacesUp`.
   */
  private quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  /**
   * `facesUp` is the floor's own invariant, not every caller's: a slab's skirt
   * points sideways by design, so only the ground asserts it.
   */
  finish(facesUp = true): VertexData {
    const data = new VertexData();
    data.positions = this.positions;
    data.uvs = this.uvs;
    data.indices = this.indices;
    const normals: number[] = [];
    VertexData.ComputeNormals(this.positions, this.indices, normals);
    data.normals = normals;
    if (facesUp) assertFacesUp(normals);
    return data;
  }
}

/**
 * A heightfield has no overhangs, so every normal must point up. If one does
 * not, the winding is inverted — and that failure is completely silent: the
 * meshes are built, the materials compile, nav and picking are unaffected
 * (Babylon's triangle picking is two-sided), and the only symptom is a floor
 * that is back-face culled and lit from below, i.e. an invisible world with a
 * clean console. Worth a dev-time assertion precisely because nothing else
 * catches it.
 */
function assertFacesUp(normals: readonly number[]): void {
  if (!import.meta.env.DEV) return;
  for (let i = 1; i < normals.length; i += 3) {
    if (normals[i] < 0) {
      throw new Error(
        "TerrainField: floor normals point down — triangle winding is " +
          "inverted. Babylon defaults to a LEFT-handed system, where a front " +
          "face is clockwise seen from the front.",
      );
    }
  }
}
