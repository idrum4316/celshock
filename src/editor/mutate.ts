/**
 * editor/mutate.ts — Applies a moved/rotated selection to the layout and to
 * the geometry already in the scene.
 * Owns: the write path. Reading is inspect.ts's job.
 *
 * The layout is the source of truth and is edited in place; the scene is
 * brought back into agreement with it. Two tiers, because they cost three
 * orders of magnitude apart (measured, not guessed):
 *
 * - **Reposition** — visuals, colliders and WorldBoxes moved directly.
 *   Sub-millisecond, so it runs on every frame of a drag. A builder assembles
 *   at the origin and MapBuilder transforms the result, so a placement's
 *   transform is genuinely all that changes when it moves.
 * - **Navigation** — NavGrid plus all seven flow fields, and ObstacleField.
 *   ~45 ms, so it runs when a drag ends, not during it.
 *
 * What is deliberately NOT handled here: changing `params` or `kind` alters
 * the geometry itself and can change how many colliders an item emits, which
 * shifts every later index in `colliderBoxes`. That needs a full rebuild, and
 * a full rebuild is the caller's decision — it disposes the map the caller is
 * holding.
 */
import { Vector3 } from "@babylonjs/core";
import type { MapLayout } from "../world/layout";
import { repositionItem, type GameMap } from "../world/MapBuilder";
import { NavGrid } from "../world/NavGrid";
import { ObstacleField } from "../world/ObstacleField";
import type { SelectionRef } from "./selection";

/** Where a selected item currently sits, for the gizmo to attach to. */
export function originOf(layout: MapLayout, ref: SelectionRef): Vector3 | null {
  switch (ref.list) {
    case "placements": {
      const p = layout.placements[ref.index];
      return p ? new Vector3(p.x, p.y ?? 0, p.z) : null;
    }
    case "scatter": {
      const s = layout.scatter[ref.index];
      return s ? new Vector3(s.x, s.y ?? 0, s.z) : null;
    }
    case "controlPoints":
      return layout.controlPoints[ref.index]?.pos.clone() ?? null;
    case "spawns":
      return layout.spawns[ref.index]?.pos.clone() ?? null;
    case "water": {
      const r = layout.water?.[ref.index];
      return r ? new Vector3(r.x, r.y ?? 0, r.z) : null;
    }
    case "grass": {
      const r = layout.grass?.[ref.index];
      return r ? new Vector3(r.x, r.y ?? 0, r.z) : null;
    }
  }
}

/** The item's current Y rotation, or 0 for things that have no facing. */
export function rotationOf(layout: MapLayout, ref: SelectionRef): number {
  if (ref.list === "placements") return layout.placements[ref.index]?.rotY ?? 0;
  if (ref.list === "spawns") return layout.spawns[ref.index]?.yaw ?? 0;
  return 0;
}

/** Only placements and spawns carry a rotation worth showing a ring for. */
export function isRotatable(ref: SelectionRef): boolean {
  return ref.list === "placements" || ref.list === "spawns";
}

/**
 * Rounds a dragged value to the precision the serializer writes at.
 *
 * Gizmo drags do not produce exact numbers even with snapping on: a quarter
 * turn comes back as 1.5707963267948968, and a rotation taken back to zero
 * lands on something like 1e-17 rather than 0. Storing that raw caused a
 * cottage rotated and un-rotated to be written as `rotY: 0` — not `=== 0`, so
 * the field was never dropped, then rounded to "0" on the way out. Quantising
 * here keeps the layout data identical to what gets written to the file.
 */
function q(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Angles get their own treatment, and must NOT be rounded to three decimals
 * like positions are.
 *
 * `Math.PI / 2` is 1.5707963…; rounded to 1.571 it is no longer a quarter turn
 * to within the serializer's tolerance, so it would be written as the literal
 * `1.571` instead of `Math.PI / 2` and the file would drift away from the way
 * it is authored. So a value within a whisker of a quarter turn is snapped to
 * the exact quarter turn, and anything genuinely freehand keeps six decimals.
 */
function qAngle(v: number): number {
  const turns = v / Math.PI;
  const quarter = Math.round(turns * 4) / 4;
  if (Math.abs(turns - quarter) < 1e-6) {
    const exact = quarter * Math.PI;
    return Object.is(exact, -0) ? 0 : exact;
  }
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Cleans up a raw gizmo transform. Call this once per drag and hand the result
 * to both the layout write and the scene reposition, so what is stored and
 * what is drawn can never disagree.
 */
export function quantize(at: Vector3, rotY: number): { at: Vector3; rotY: number } {
  return { at: new Vector3(q(at.x), q(at.y), q(at.z)), rotY: qAngle(rotY) };
}

/**
 * Writes a new transform into the layout.
 *
 * Optional fields are dropped when they quantise to zero rather than written
 * as an explicit `0` — `y` and `rotY` are absent by default in the data and
 * should stay absent, so a drag that returns something to where it started
 * leaves no trace in the file.
 */
export function applyTransform(
  layout: MapLayout,
  ref: SelectionRef,
  position: Vector3,
  rotation: number,
): void {
  const at = new Vector3(q(position.x), q(position.y), q(position.z));
  const rotY = qAngle(rotation);
  switch (ref.list) {
    case "placements": {
      const p = layout.placements[ref.index];
      if (!p) return;
      p.x = at.x;
      p.z = at.z;
      // y is optional in the data and absent means "on the ground". Keep it
      // that way rather than writing a zero into every layout line.
      if (at.y === 0) delete p.y;
      else p.y = at.y;
      if (rotY === 0) delete p.rotY;
      else p.rotY = rotY;
      return;
    }
    case "scatter": {
      const s = layout.scatter[ref.index];
      if (!s) return;
      s.x = at.x;
      s.z = at.z;
      if (at.y === 0) delete s.y;
      else s.y = at.y;
      return;
    }
    case "controlPoints": {
      // The Vector3 is shared by reference into GameMap and ConquestSystem, so
      // it is mutated rather than replaced.
      layout.controlPoints[ref.index]?.pos.copyFrom(at);
      return;
    }
    case "spawns": {
      const s = layout.spawns[ref.index];
      if (!s) return;
      s.pos.copyFrom(at);
      s.yaw = rotY;
      return;
    }
    case "water":
    case "grass": {
      const r = (ref.list === "water" ? layout.water : layout.grass)?.[ref.index];
      if (!r) return;
      r.x = at.x;
      r.z = at.z;
      if (at.y === 0) delete r.y;
      else r.y = at.y;
      return;
    }
  }
}

/**
 * Brings the scene's geometry back in line with the layout for one item.
 * Cheap enough for every frame of a drag.
 */
export function repositionScene(
  map: GameMap,
  ref: SelectionRef,
  at: Vector3,
  rotY: number,
): void {
  const index = map.editor;
  if (!index) return;
  if (ref.list !== "placements" && ref.list !== "scatter") return;
  const item = index[ref.list][ref.index];
  if (!item) return;
  // Scatter props were baked into their merged field at their sampled offsets,
  // so a region moves as a unit and its own rotation is meaningless.
  repositionItem(item, map.colliderBoxes, at, ref.list === "scatter" ? 0 : rotY);
}

/**
 * Rebuilds navigation from the current collider boxes. ~45 ms — call it when a
 * drag ends, never inside one.
 *
 * Returns a fresh NavGrid and ObstacleField; the caller swaps them into the
 * map so anything holding the old pair keeps working until it does.
 */
export function rebuildNavigation(
  map: GameMap,
  layout: MapLayout,
): { nav: NavGrid; obstacles: ObstacleField } {
  const nav = new NavGrid(map.size, map.colliderBoxes);
  for (const cp of layout.controlPoints) {
    nav.buildField(cp.id, cp.pos, cp.radius * 0.6);
  }
  for (const team of [0, 1] as const) {
    const home = layout.spawns.find((s) => s.team === team);
    if (home) nav.buildField(`home${team}`, home.pos, 6);
  }
  return { nav, obstacles: new ObstacleField(map.size, map.colliderBoxes) };
}
