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
 * The built valley, by district.
 *
 * **C — the manor.** Placed so flag C stands in the middle of its great hall:
 * the builder's origin is the core block's centre, and C is at (0, -4). Its own
 * geometry runs from x -14 to +17.5 (the service stair breaks out of the east
 * flank) and from z -16.6 to +7 in local terms, so at this placement it occupies
 * roughly x ±16, z -20 to +3 — well inside the capture ring, and clear of C's
 * own deploy point, which was moved south to make room.
 *
 * **A — the treeline hamlet.** Three stilt huts and two walks, set NORTH of the
 * flag so A's own centre stays open ground and the huts are what you fight
 * through to reach it rather than what you fight from on top of it. Two of them
 * stand inside the 14 m ring on purpose.
 *
 * **B — the west bank.** The most exposed flag on the map: flat, treeless, and
 * with the nearest cover 25 m away across the river. It gets a ruin for corners
 * and two huts on the bank, one of which is the stilt hut doing what it was
 * built for — see `buildStiltHut`, whose worked example is this placement.
 *
 * **D — the temple.** A stepped platform on 70 x 70 m of empty quadrant: the
 * only high ground east of the manor, visible from it, and the one flag you
 * have to climb for. Its control point carries the summit height for that
 * reason.
 *
 * **E — the canopy camp.** Inside a tree belt, so it is dark and close. Two huts
 * on a walk, and a ruin standing between the deploy point and the flag so the
 * approach is a fight rather than a stroll.
 *
 * **The trestle** crosses the east branch where the straight line from C to D
 * meets it — the manor's own approach, and far enough from both flags (25 m and
 * 46 m) to belong to neither. Its `y` is the one authored number the builder
 * cannot derive: see `buildTrestleBridge` on why local zero has to be BANK
 * grade when MapBuilder samples the ground at a placement's centre and that
 * centre is over a river bed.
 *
 * **The causeway** runs up the marsh bar in the confluence, north of the manor
 * and inside nobody's ring. Three segments rather than one 35 m walk, because a
 * placement height-samples once at its own centre and a long deck over
 * anything but level ground floats at one end.
 *
 * Everything is axis-aligned, per the hygiene note above.
 */
const placements: Placement[] = [
  { kind: "manor", x: 0, z: -4, params: { litWindows: true } },
  { kind: "stiltHut", x: -70, z: 84, y: TERRACE_H, rotY: Math.PI / 2 },
  { kind: "stiltHut", x: -56, z: 86, y: TERRACE_H, rotY: -Math.PI / 2 },
  { kind: "stiltHut", x: -66, z: 96, y: TERRACE_H },
  { kind: "boardwalk", x: -63, z: 84.5, y: TERRACE_H, rotY: Math.PI / 2, params: { length: 11, railSide: "none" } },
  { kind: "boardwalk", x: -63, z: 88.758, y: TERRACE_H, params: { length: 6, railSide: "none" } },
  { kind: "jungleRuin", x: -50, z: 70, rotY: Math.PI, params: { width: 11, depth: 8 } },
  { kind: "jungleRuin", x: -105, z: -40, rotY: Math.PI / 2, params: { width: 13, depth: 9 } },
  { kind: "stiltHut", x: -87, z: -24, rotY: Math.PI / 2 },
  { kind: "stiltHut", x: -76, z: -30 },
  { kind: "boardwalk", x: -84, z: -30, rotY: Math.PI / 2, params: { length: 10 } },
  { kind: "templeRuin", x: 80, z: 34 },
  { kind: "stiltHut", x: 30, z: -88, rotY: Math.PI / 2 },
  { kind: "stiltHut", x: 48, z: -90 },
  { kind: "boardwalk", x: 39, z: -88, rotY: Math.PI / 2, params: { length: 12, railSide: "none" } },
  { kind: "jungleRuin", x: 46, z: -76, rotY: Math.PI, params: { width: 12, depth: 9 } },
  { kind: "trestleBridge", x: 36, z: 15, y: 1.34, rotY: Math.PI / 2 },
  { kind: "boardwalk", x: 0, z: 25, params: { length: 12, railSide: "none" } },
  { kind: "boardwalk", x: 0, z: 37, params: { length: 12, railSide: "none" } },
  { kind: "boardwalk", x: 0, z: 48, params: { length: 11, railSide: "none" } },
  { kind: "stiltHut", x: 5.5, z: 31, rotY: Math.PI / 2 },
  { kind: "stiltHut", x: -5.5, z: 42, rotY: -Math.PI / 2 },
  { kind: "road", x: -102.37, z: 33.852, params: { surface: "dirt", length: 78 } },
  { kind: "road", x: -52.241, z: 60.715, rotY: Math.PI / 2, params: { surface: "dirt", length: 100 } },
];

/**
 * The jungle: five belts of buttressed hardwoods. Three close the north and
 * south ends of the valley, where the rim would otherwise be the only thing
 * saying the map stops; the other two thicken the southern half, which is
 * where the fighting between C and E happens.
 *
 * The canopy starts nine metres up, so a belt is cover in the sense that
 * TRUNKS are cover — sight lines under it stay open and the ground beneath
 * reads as shaded rather than blocked. That is what lets a belt sit across a
 * home spawn's approach without walling a team in, and it is why two belts
 * deliberately cover objectives: belt 2 contains flag E itself and belt 5
 * contains E's deploy point. Trunks make that ground a fight rather than a
 * clearing; a belt of anything with foliage at chest height would instead make
 * it unplayable.
 *
 * Each belt runs most of the map's width, which is well past the 78 m fog
 * wall: a region is merged into one mesh and filed under the block its CENTRE
 * falls in, so both cull as a unit and neither can be frustum-rejected while
 * any of it is on screen. Splitting each into three rectangles is the fix if
 * they start costing anything — see CLAUDE.md on scatter regions.
 *
 * The understory (ferns, fallen logs, stelae) is appended after the belts and
 * is deliberately in small regions near the flags rather than spread over the
 * valley: it is dressing you fight around rather than terrain.
 *
 * **A BLOCKING understory region must not be able to reach a flag's centre.**
 * Ferns are non-blocking and may sit anywhere, including straight over a
 * capture point; logs and stelae carry colliders, and a control point whose
 * centre is inside one makes `surfaceAt` return -1 there — the Flag-C-on-the-
 * well error, which `validate.ts` reports and which reads in play as a flag
 * that cannot be captured. Measured on the first pass here: a log region
 * centred 4.5 m off flag A dropped a 5.2 m trunk 0.53 m from the flag and did
 * exactly that. So each blocking region is now placed so that its own radius
 * plus the prop's half-length still clears the nearest flag — which is also
 * why they sit off to one side of a district rather than on top of it.
 *
 * The exception that proves it is the stele ring on D: it is centred ON the
 * flag, and it is safe by construction rather than by margin, because the
 * temple's colliders fill that whole footprint and `MapBuilder.findSpot`
 * rejects any spot buried in one. The steles can only land on the ground
 * around the platform, which is what they are for.
 *
 * Note that ADDING A PLACEMENT REROLLS ALL OF THIS. `findSpot` draws from the
 * shared stream once per attempt, accepted or rejected, and placements build
 * before scatter — so a new building anywhere moves every belt and every
 * understory region on the map. Re-walk the flags after touching either array.
 */
const scatter: ScatterSpec[] = [
  { prop: "jungleTree", x: -25.5, z: 96, width: 78, depth: 40, count: 30, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: 54.68, z: -97.112, width: 78, depth: 40, count: 30, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: -32, z: -96.5, width: 78, depth: 40, count: 30, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: -4.348, z: -43.465, width: 78, depth: 60, count: 34, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: 75.268, z: -60.696, width: 78, depth: 24, count: 20, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "fernClump", x: -62, z: 84, width: 34, depth: 30, count: 26, scale: [0.8, 1.4] },
  { prop: "buttressLog", x: -76, z: 92, radius: 12, count: 4, scale: [0.85, 1.2], blocking: true, clearance: 1.6 },
  { prop: "carvedStele", x: 80, z: 34, radius: 20, count: 6, scale: [0.85, 1.25], blocking: true, clearance: 0.7 },
  { prop: "fernClump", x: 80, z: 34, radius: 22, count: 22, scale: [0.8, 1.4] },
  { prop: "fernClump", x: 40, z: -84, width: 40, depth: 30, count: 28, scale: [0.8, 1.4] },
  { prop: "buttressLog", x: 22, z: -72, radius: 12, count: 5, scale: [0.85, 1.2], blocking: true, clearance: 1.6 },
  { prop: "fernClump", x: -95, z: -30, radius: 16, count: 20, scale: [0.8, 1.4] },
  { prop: "carvedStele", x: -104, z: -42, radius: 9, count: 3, scale: [0.85, 1.25], blocking: true, clearance: 0.7 },
  { prop: "jungleTree", x: -73.164, z: 30.772, radius: 24, count: 22, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "fernClump", x: -49.664, z: 40.272, radius: 15, count: 20, scale: [0.8, 1.4] },
  { prop: "fernClump", x: -29.664, z: 46.772, radius: 12, count: 14, scale: [0.8, 1.4] },
  { prop: "jungleTree", x: -31.044, z: -5.637, radius: 12.5, count: 7, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: 86.192, z: 82.522, width: 65, depth: 65, count: 35, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: 108.037, z: 16.596, width: 15, depth: 65, count: 22, y: 0.134, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: 84.037, z: -4.404, radius: 18, count: 15, y: 0.15, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: 46.937, z: 48.216, radius: 18, count: 15, y: 0.15, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: 44.262, z: 75.759, radius: 8, count: 6, y: -0.047, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: -56.772, z: -64.972, radius: 15, count: 10, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: -85.486, z: -98.394, radius: 18, count: 22, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
  { prop: "jungleTree", x: -82.817, z: 1.08, radius: 12, count: 10, scale: [0.85, 1.25], blocking: true, clearance: 2.2 },
];

const controlPoints: ControlPointDef[] = [
  { id: "A", name: "Alpha", pos: new Vector3(-60, 0, 76), radius: 14 },
  { id: "B", name: "Bravo", pos: new Vector3(-97, 0, -28), radius: 13 },
  { id: "C", name: "Charlie", pos: new Vector3(0, 0, -4), radius: 14 },
  // On the temple's summit. Capture is horizontal only, so the ring is
  // unaffected by the height — but `pos.y` is what the flag marker and the
  // deploy map draw at, and a beacon at ground level inside a solid platform
  // is a column growing out of the stone.
  { id: "D", name: "Delta", pos: new Vector3(80, 1.35, 34), radius: 13 },
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
 *
 * What is cut into it is a Y-shaped river. One channel enters the rim in the
 * north-east and runs south-south-west into a wide confluence basin above the
 * manor, where it splits: a west branch running down the left flank and out
 * through the south-west rim, and an east branch running south-east and then
 * out through the east rim. Beds bottom at -0.89 and -1.34; a shallow rise of
 * +0.15 blankets the north-east quadrant, which is relief rather than a
 * feature.
 *
 * THE RIVER IS NOT A BARRIER, and that is deliberate. Every bank on this map
 * is graded at about 0.66 m per 3 m terrain cell — a gradient of 0.22, well
 * inside the 0.4 at which `NavGrid.link` severs itself — so every crossing
 * already links, and both bots and the player wade the whole thing. The
 * crossings here are landmarks and raised firing lanes; nothing routes over
 * them because it has to. Deepening a channel past 0.4 would change that, and
 * would owe a re-walk of all five flags.
 *
 * One feature is worth knowing about before placing anything in the middle of
 * the map: a bar at -0.68 runs up the confluence from about z 21 to z 51,
 * twelve metres wide, under 0.16 m of standing water. It is the one stretch of
 * marsh on Greyfen, and it is what the causeway is laid along.
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
