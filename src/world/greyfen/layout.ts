/**
 * greyfen/layout.ts — THE MAP, as data: structure placements, scatter
 * regions, control points, spawns, water rects, grass rects. The floor's shape
 * is generated data and lives in heights.ts. Consumed by MapBuilder; nothing
 * here is code to special-case.
 * Gotchas that have already cost time: collider top faces within
 * CONFIG.nav.stepHeight of adjacent ground or bots treat decks as walls;
 * a control point's pos must NOT sit inside a collider (surfaceAt returns -1);
 * scatter clearance values must match prop collider extents; terrain steeper
 * than a 0.4 gradient severs its own nav links. A second map is one new file
 * shaped like this plus an EnvironmentSpec.
 */
import { Vector3 } from "@babylonjs/core";
import type {
  ControlPointDef,
  GrassRect,
  MapLayout,
  Placement,
  ScatterSpec,
  SpawnPointDef,
  WaterRect,
} from "../layout";
import { GreyfenHeights } from "./heights";

/**
 * GREYFEN — a jungle valley, being built around its centrepiece.
 *
 * It was once a fork of Hollowmere's village, was cleared back to nothing, and
 * is now growing again as something else: a drowned tropical valley with a
 * colonial manor rotting in the middle of it. What is standing so far is the
 * skeleton a Conquest round cannot run without — five control points in a ring
 * around the centre and the spawns that serve them, with the two uncapturable
 * home spawns diagonally opposed so neither side starts next to C — plus the
 * manor itself on C.
 *
 * 240 x 240 m, origin at the map centre, +Z is north. The flags keep the
 * positions the village put them at, so the ring is still a playable spacing to
 * build around; move them as the map takes a shape of its own.
 *
 * Everything below is authored through the editor (F2) and patched back into
 * this file line by line, so keep to the shape it reads: one array entry per
 * line, and each array delimited by its own `const name: Type = [` and a `];`
 * at column 0. The empty arrays are written open for exactly that reason — the
 * editor's scanner anchors on those two lines, and `= []` on one line gives it
 * nowhere to add an entry.
 *
 * Layout hygiene (keep to these when building it back up):
 * - Structures are axis-aligned (`rotY` in multiples of π/2). Organic tilt
 *   belongs to scatter props, not buildings.
 * - Roads end at junctions, wall faces, or ramp feet — never under a building,
 *   an embankment, or a fence line.
 * - Lamps stand at road corners, and fences split with a gate wherever a road
 *   or ramp passes through them.
 * - Scatter regions stay clear of buildings, spawn points, and the valley
 *   ridge. `MapBuilder.findSpot` rejects any spot buried in a collider, but a
 *   region that blankets a structure just wastes its count on rejects.
 */

/**
 * The manor is placed so flag C stands in the middle of its great hall: the
 * builder's origin is the core block's centre, and C is at (0, -4).
 *
 * Its own geometry runs from x -14 to +17.5 (the service stair breaks out of
 * the east flank) and from z -16.6 to +7 in local terms, so at this placement
 * it occupies roughly x ±16, z -20 to +3 — well inside the capture ring, and
 * clear of C's own deploy point, which was moved south to make room.
 */
const placements: Placement[] = [
  { kind: "manor", x: 0, z: -4, params: { litWindows: true } },
  { kind: "tavern", x: -40.586, z: -54.804, rotY: Math.PI / 2 },
];

/**
 * The jungle: two belts of buttressed hardwoods closing the north and south
 * ends of the valley, where the rim would otherwise be the only thing saying
 * the map stops.
 *
 * The canopy starts nine metres up, so a belt is cover in the sense that
 * TRUNKS are cover — sight lines under it stay open and the ground beneath
 * reads as shaded rather than blocked. That is what lets a belt sit across a
 * home spawn's approach without walling a team in.
 *
 * Each belt runs most of the map's width, which is well past the 78 m fog
 * wall: a region is merged into one mesh and filed under the block its CENTRE
 * falls in, so both cull as a unit and neither can be frustum-rejected while
 * any of it is on screen. Splitting each into three rectangles is the fix if
 * they start costing anything — see CLAUDE.md on scatter regions.
 */
const scatter: ScatterSpec[] = [
  { prop: "jungleTree", x: -37.5, z: 96, width: 78, depth: 40, count: 30, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: 46.18, z: -97.112, width: 78, depth: 40, count: 30, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: -32, z: -96.5, width: 78, depth: 40, count: 30, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: -4.348, z: -43.465, width: 78, depth: 60, count: 34, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: 75.268, z: -60.696, width: 78, depth: 24, count: 20, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
];

const controlPoints: ControlPointDef[] = [
  { id: "A", name: "Alpha", pos: new Vector3(-60, 0, 76), radius: 14 },
  { id: "B", name: "Bravo", pos: new Vector3(-97, 0, -28), radius: 13 },
  { id: "C", name: "Charlie", pos: new Vector3(0, 0, -4), radius: 14 },
  { id: "D", name: "Delta", pos: new Vector3(80, 0, 34), radius: 13 },
  { id: "E", name: "Echo", pos: new Vector3(40, 0, -84), radius: 12 },
];

/**
 * Home spawns are uncapturable. Every control point also carries a spawn just
 * outside its capture zone, so deploying onto a flag you hold does not drop you
 * on top of whoever is contesting it.
 */
const spawns: SpawnPointDef[] = [
  { team: 0, pos: new Vector3(-100, 0, 96), yaw: Math.PI },
  { team: 0, pos: new Vector3(-94, 0, 96), yaw: Math.PI },
  { team: 0, pos: new Vector3(-106, 0, 96), yaw: Math.PI },
  { team: 1, pos: new Vector3(105, 0, -96), yaw: 0 },
  { team: 1, pos: new Vector3(99, 0, -96), yaw: 0 },
  { team: 1, pos: new Vector3(111, 0, -96), yaw: 0 },
  { team: null, controlPoint: "A", pos: new Vector3(-60, 0, 62), yaw: Math.PI },
  { team: null, controlPoint: "B", pos: new Vector3(-99, 0, -24.5), yaw: Math.PI },
  // Pushed out to -28 so it clears the manor's front steps (which reach
  // z = -21.1) rather than dropping a squad onto them.
  { team: null, controlPoint: "C", pos: new Vector3(-2, 0, -28), yaw: 0 },
  { team: null, controlPoint: "D", pos: new Vector3(80, 0, 14), yaw: Math.PI },
  { team: null, controlPoint: "E", pos: new Vector3(40, 0, -66), yaw: 0 },
];

/**
 * Dug ground lives in `heights.ts`, generated by the editor's terrain mode.
 * The field is currently level everywhere — the file is kept (rather than
 * dropping `terrain` from the layout) so the editor's terrain mode has a grid
 * to sculpt and somewhere to save it.
 */

/**
 * Standing water. Ankle-deep everywhere (CONFIG.water.surfaceY) over the bed
 * beneath it, so bots and the player wade across — no swimming, and the nav
 * grid never hears about it. A rect over a dug basin therefore sits below the
 * surrounding ground: -0.6 m of bed puts the surface at -0.28.
 */
const water: WaterRect[] = [
  { x: 1.693, z: -6.027, width: 250, depth: 250, y: -0.52 },
];

/**
 * Grass fields. Pale, dead, knee-high — the valley's one crop that still
 * grows. Placement rules: rects dodge roads (roads are visual-only, so no
 * collider rejects a blade poking through the cobbles — that check is on the
 * author), while structures, fences, and props are cleared automatically by
 * the GrassSystem's collider rejection.
 */
const grass: GrassRect[] = [
];

export const GreyfenLayout: MapLayout = {
  placements,
  scatter,
  controlPoints,
  spawns,
  water,
  grass,
  terrain: GreyfenHeights,
  // Fixed so the dressing — and the colliders blocking scatter emits, and so
  // the nav graph — is identical on every boot. Changing it rerolls the whole
  // scatter field, which is a visible change to the level: re-walk the flags.
  seed: 0x484c,
};
