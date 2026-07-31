/**
 * layout.ts — The map-data vocabulary: Placement, ScatterSpec, TerrainRect,
 * MapLayout.
 * Owns: the shape a level file must take, and nothing about any level.
 *
 * These live here rather than beside Hollowmere's data so that "a second map is
 * one new layout file" stays literally true — a new map imports its types from
 * this file, not from its predecessor. MapBuilder consumes a MapLayout and an
 * EnvironmentSpec passed in as arguments; nothing in the world layer reaches for
 * a named map.
 *
 * The remaining pieces of the vocabulary (ControlPointDef, SpawnPointDef,
 * WaterRect, GrassRect) are declared in MapBuilder.ts next to the GameMap they
 * end up inside, and re-exported here so a layout file has one import.
 */
import type { BuildParams, BuilderKind } from "./BuildingKit";
import type {
  ControlPointDef,
  GrassRect,
  SpawnPointDef,
  WaterRect,
} from "./MapBuilder";

export type { ControlPointDef, GrassRect, SpawnPointDef, WaterRect };

/** One placed structure. Built at the origin, then rotated and moved here. */
export interface Placement {
  kind: BuilderKind;
  x: number;
  z: number;
  /**
   * Height above the ground beneath it — set when a structure stands on a
   * terrace or embankment. Terrain the placement sits in is added on top, so
   * this stays meaningful when the floor under it moves.
   */
  y?: number;
  rotY?: number;
  params?: BuildParams;
}

/** Loose dressing sprinkled inside a circular region by rejection sampling. */
export interface ScatterSpec {
  prop:
    | "deadTree"
    | "gravestone"
    | "log"
    | "fungus"
    | "rubble"
    | "fireDrum"
    | "boulder"
    | "bramble"
    | "barrel";
  x: number;
  z: number;
  /** Region radius. */
  radius: number;
  count: number;
  y?: number;
  scale?: [number, number];
  /** Blocking scatter gets a collider and punches a hole in the nav grid. */
  blocking?: boolean;
  /** Collider half-extent at scale 1. */
  clearance?: number;
}

/**
 * The shape of the valley floor: a regular grid of vertex heights.
 *
 * Unlike a `terrace` placement — a solid box standing ON the floor, which can
 * only ever go up — this *is* the floor, so it digs below zero as happily as it
 * rises. That is what lets a pool sit in the ground with a bank around it
 * instead of hovering over a flat plane.
 *
 * Authored by the editor's terrain mode and written to its own generated file,
 * NOT into the hand-written layout: a grid of several thousand numbers has no
 * business sitting next to the ASCII village map. The layout imports it.
 *
 * Placements, scatter and grass rects read their `y` as an offset ABOVE the
 * terrain, so dropping a building into a basin needs no bookkeeping. Control
 * points and spawns stay absolute: they are single authored points, and the
 * editor snaps their height to the nav surface, which the terrain feeds. Water
 * is absolute too — a pool's surface is level whatever its bed does — but a
 * rect with no `y` defaults to ankle-deep over its own bed.
 */
export interface Heightfield {
  /** Cells per side. There are `(size + 1) ^ 2` vertices. */
  size: number;
  /** Metres per cell. `size * cell` must equal `CONFIG.map.size`. */
  cell: number;
  /**
   * Vertex heights in metres, row-major from the -X/-Z corner: index
   * `j * (size + 1) + i` is the vertex at `(-half + i * cell, -half + j * cell)`.
   */
  heights: number[];
}

export interface MapLayout {
  placements: Placement[];
  scatter: ScatterSpec[];
  controlPoints: ControlPointDef[];
  spawns: SpawnPointDef[];
  water?: WaterRect[];
  grass?: GrassRect[];
  /** The floor's shape. Absent means a level valley floor. */
  terrain?: Heightfield;
  /**
   * Seed for scatter placement. Fixed per map so the dressing — and therefore
   * the colliders blocking scatter emits, and therefore the nav graph — is
   * identical on every boot. Change it to reroll the whole scatter field.
   */
  seed?: number;
}
