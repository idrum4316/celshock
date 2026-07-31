/**
 * TerrainField.ts — The valley floor's height, and the one place that knows it.
 * Owns: sampling a layout's Heightfield at any (x, z), editing it, and
 * tessellating it into per-block VertexData for MapBuilder to hang meshes on.
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

  finish(): VertexData {
    const data = new VertexData();
    data.positions = this.positions;
    data.uvs = this.uvs;
    data.indices = this.indices;
    const normals: number[] = [];
    VertexData.ComputeNormals(this.positions, this.indices, normals);
    data.normals = normals;
    assertFacesUp(normals);
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
