/**
 * editor/terrainBrush.ts — Terrain mode: the hover highlight and the drag that
 * raises or lowers the ground.
 * Owns: the brush state, its overlay mesh, and the heightfield writes a stroke
 * makes. Owns nothing else — the rebuild that brings colliders, navigation and
 * everything standing on the ground back into agreement is the session's call,
 * because it disposes the map the session is holding.
 *
 * Why a mode rather than another selectable entity: the ground is *under*
 * everything, so a terrain proxy is a flat sheet competing for the same click
 * as the water rect, the grass rect and the jetty sitting on it. Whichever
 * annotation happens to be on top wins and the rest become unselectable. A mode
 * settles it by construction — in terrain mode only the ground answers, and in
 * object mode terrain is not in the pick at all.
 *
 * A stroke is ABSOLUTE, not incremental: the affected vertices' heights are
 * snapshotted when the drag starts and every mouse move re-derives them from
 * that snapshot. Accumulating deltas per frame would make the result depend on
 * frame rate and on how fast the mouse was moving.
 */
import {
  Color3,
  Mesh,
  StandardMaterial,
  VertexData,
  type GlowLayer,
  type Scene,
} from "@babylonjs/core";
import type { Heightfield } from "../world/layout";
import { BLOCK_SIZE, type GameMap } from "../world/MapBuilder";
import { MAX_WALKABLE_GRADE, terrainPatches } from "../world/TerrainField";
import { EDITOR } from "./tuning";

/** Lift the highlight clear of the ground it traces. */
const LIFT = 0.05;

/** How far a vertical mouse drag moves the ground, in metres per pixel. */
const SENSITIVITY = 0.02;

/** Hard stops, so a wild drag cannot put the floor somewhere absurd. */
const MIN_Y = -12;
const MAX_Y = 24;

interface Stroke {
  /** Vertex index -> its height when the drag began. */
  before: Map<number, number>;
  /** Vertex index -> falloff weight, 0..1. */
  weight: Map<number, number>;
  startPointerY: number;
  /** Blocks whose meshes this stroke has to keep re-applying. */
  blocks: Set<string>;
}

export class TerrainBrush {
  /** Radius in cells. */
  private radius = 2;
  private overlay: Mesh | null = null;
  private readonly material: StandardMaterial;
  private stroke: Stroke | null = null;
  /** Grid vertex the cursor is over, or null when it is off the ground. */
  private at: { i: number; j: number } | null = null;

  constructor(
    private scene: Scene,
    private glow: GlowLayer,
    private map: GameMap,
  ) {
    const m = new StandardMaterial("ed-brush", scene);
    m.emissiveColor = Color3.FromHexString(EDITOR.colors.terrain);
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.disableLighting = true;
    m.alpha = 0.3;
    m.disableDepthWrite = true;
    this.material = m;
  }

  /** Re-points the brush after a rebuild replaced the map. */
  setMap(map: GameMap): void {
    this.map = map;
    this.refreshOverlay();
  }

  get isDragging(): boolean {
    return this.stroke !== null;
  }

  get size(): number {
    return this.radius;
  }

  /** `[` and `]`. One cell at a time — the grid is the unit that matters. */
  resize(by: number): void {
    this.radius = Math.max(0, Math.min(12, this.radius + by));
    this.refreshOverlay();
  }

  /**
   * Moves the hover highlight to whatever the pointer is over. Picks against
   * `solid`, which is the terrain collider — the same geometry the player's
   * ground probe uses, so the brush lands where a body would stand.
   */
  hover(x: number, y: number): void {
    if (this.stroke) return;
    const hit = this.scene.pick(
      x,
      y,
      (m) => m.metadata?.solid === true && m.name.startsWith("terrain-"),
    );
    const p = hit?.hit ? hit.pickedPoint : null;
    this.at = p ? this.map.terrain.nearestVertex(p.x, p.z) : null;
    this.refreshOverlay();
  }

  /** Begins a stroke at the current hover position. Returns false if off-grid. */
  begin(pointerY: number): boolean {
    const f = this.map.terrain.field;
    if (!f || !this.at) return false;

    const before = new Map<number, number>();
    const weight = new Map<number, number>();
    const blocks = new Set<string>();
    const row = f.size + 1;
    // Full strength across the inner half, then linear to nothing at the rim.
    // A hard-edged brush would make a cliff on its first click, which the nav
    // graph then refuses to walk across.
    const inner = this.radius * 0.5;

    for (const { i, j, d } of this.footprint(f)) {
      const w = this.radius === 0 ? 1 : falloff(d, inner, this.radius);
      if (w <= 0) continue;
      const idx = j * row + i;
      before.set(idx, f.heights[idx]);
      weight.set(idx, w);
      for (const key of blocksTouching(f, i, j)) blocks.add(key);
    }
    if (before.size === 0) return false;

    this.stroke = { before, weight, startPointerY: pointerY, blocks };
    return true;
  }

  /** Continues a stroke. Dragging up raises, dragging down lowers. */
  drag(pointerY: number): void {
    const s = this.stroke;
    const f = this.map.terrain.field;
    if (!s || !f) return;
    const delta = (s.startPointerY - pointerY) * SENSITIVITY;
    for (const [idx, base] of s.before) {
      const w = s.weight.get(idx) ?? 0;
      f.heights[idx] = clamp(round2(base + delta * w), MIN_Y, MAX_Y);
    }
    this.reapply(s.blocks);
    this.refreshOverlay();
  }

  /** Ends a stroke. True when the ground actually moved. */
  end(): boolean {
    const s = this.stroke;
    const f = this.map.terrain.field;
    this.stroke = null;
    if (!s || !f) return false;
    for (const [idx, base] of s.before) {
      if (f.heights[idx] !== base) return true;
    }
    return false;
  }

  /**
   * The steepest gradient anywhere under the brush, for the status line. The
   * nav graph will not link across anything past `MAX_WALKABLE_GRADE`, and the
   * whole point of a sculpting tool is that it is easy to cross that by
   * accident and impossible to see afterwards.
   */
  gradeUnderBrush(): number {
    const f = this.map.terrain.field;
    if (!f || !this.at) return 0;
    const row = f.size + 1;
    let worst = 0;
    for (const { i, j } of this.footprint(f)) {
      const h = f.heights[j * row + i];
      for (const [di, dj] of [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni > f.size || nj > f.size) continue;
        worst = Math.max(worst, Math.abs(f.heights[nj * row + ni] - h) / f.cell);
      }
    }
    return worst;
  }

  /** Height at the brush centre, for the status line. */
  heightUnderBrush(): number {
    const f = this.map.terrain.field;
    if (!f || !this.at) return 0;
    return f.heights[this.at.j * (f.size + 1) + this.at.i];
  }

  setVisible(on: boolean): void {
    if (!on) this.at = null;
    this.refreshOverlay();
  }

  dispose(): void {
    this.overlay?.dispose();
    this.overlay = null;
    this.material.dispose();
  }

  /** Grid vertices inside the brush, with their distance from its centre. */
  private *footprint(f: Heightfield): Generator<{ i: number; j: number; d: number }> {
    if (!this.at) return;
    const r = this.radius;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const i = this.at.i + di;
        const j = this.at.j + dj;
        if (i < 0 || j < 0 || i > f.size || j > f.size) continue;
        const d = Math.hypot(di, dj);
        if (d > r + 1e-6) continue;
        yield { i, j, d };
      }
    }
  }

  /**
   * Re-tessellates the blocks a stroke is touching and hands the result to the
   * meshes already in the scene.
   *
   * Only the visuals: the collider clones and the nav grid stay stale until the
   * session runs its rebuild on release. That is the right split — a stroke has
   * to look immediate, and nothing walks on the ground mid-drag.
   */
  private reapply(blocks: Set<string>): void {
    const patches = terrainPatches(this.map.terrain, this.map.size, BLOCK_SIZE);
    for (const patch of patches) {
      if (!blocks.has(patch.key)) continue;
      const mesh = this.scene.getMeshByName(`terrain-${patch.key}`);
      if (mesh) patch.data.applyToMesh(mesh as Mesh, true);
    }
  }

  /** Rebuilds the highlight over the cells the brush would move. */
  private refreshOverlay(): void {
    this.overlay?.dispose();
    this.overlay = null;
    const f = this.map.terrain.field;
    if (!f || !this.at) return;

    const row = f.size + 1;
    const positions: number[] = [];
    const indices: number[] = [];
    const inside = new Set<number>();
    for (const { i, j } of this.footprint(f)) inside.add(j * row + i);

    // One quad per cell all four of whose corners the brush covers, so the
    // highlight reads as whole grid squares rather than a ring of fragments.
    for (const idx of inside) {
      const i = idx % row;
      const j = (idx - i) / row;
      if (i >= f.size || j >= f.size) continue;
      const corners = [idx, idx + 1, idx + row + 1, idx + row];
      if (!corners.every((c) => inside.has(c))) continue;
      const base = positions.length / 3;
      for (const c of corners) {
        const ci = c % row;
        const cj = (c - ci) / row;
        const at = this.map.terrain.vertexAt(ci, cj);
        positions.push(at.x, f.heights[c] + LIFT, at.z);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    if (indices.length === 0) return;

    const mesh = new Mesh("ed-brush", this.scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    data.normals = normals;
    data.applyToMesh(mesh);
    mesh.material = this.material;
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.metadata = { noOutline: true, noGlow: true, noShadowCaster: true };
    this.glow.addExcludedMesh(mesh);
    this.overlay = mesh;
  }
}

/** Which block meshes hold a given grid vertex. Edges belong to both. */
function blocksTouching(f: Heightfield, i: number, j: number): string[] {
  const per = Math.round(BLOCK_SIZE / f.cell);
  const out = new Set<string>();
  for (const vi of [i - 1, i]) {
    for (const vj of [j - 1, j]) {
      if (vi < 0 || vj < 0 || vi >= f.size || vj >= f.size) continue;
      out.add(`${Math.floor(vi / per)},${Math.floor(vj / per)}`);
    }
  }
  return [...out];
}

function falloff(d: number, inner: number, outer: number): number {
  if (d <= inner) return 1;
  if (d >= outer) return 0;
  return 1 - (d - inner) / (outer - inner);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Centimetre precision — finer than that is noise in a generated file. */
function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

export { MAX_WALKABLE_GRADE };
