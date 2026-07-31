/**
 * layout.ts — The map-data vocabulary: Placement, ScatterSpec, MapLayout.
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
  /** Base height — set when a structure stands on a terrace or embankment. */
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

export interface MapLayout {
  placements: Placement[];
  scatter: ScatterSpec[];
  controlPoints: ControlPointDef[];
  spawns: SpawnPointDef[];
  water?: WaterRect[];
  grass?: GrassRect[];
  /**
   * Seed for scatter placement. Fixed per map so the dressing — and therefore
   * the colliders blocking scatter emits, and therefore the nav graph — is
   * identical on every boot. Change it to reroll the whole scatter field.
   */
  seed?: number;
}
