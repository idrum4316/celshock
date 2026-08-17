/**
 * coldharbour/layout.ts — THE MAP, as data: structure placements, scatter
 * regions, control points, spawns. No water and no grass — a downtown has
 * neither. The floor's shape is generated data and lives in heights.ts.
 * Consumed by MapBuilder; nothing here is code to special-case.
 * Gotchas that have already cost time: collider top faces within
 * CONFIG.nav.stepHeight of adjacent ground or bots treat decks as walls;
 * a control point's pos must NOT sit inside a collider (surfaceAt returns -1);
 * scatter clearance values must match prop collider extents. A second map is
 * one new file shaped like this plus an EnvironmentSpec.
 */
import { Vector3 } from "@babylonjs/core";
import type {
  ControlPointDef,
  MapLayout,
  Placement,
  ScatterSpec,
  SpawnPointDef,
} from "../layout";
import { ColdharbourHeights } from "./heights";

/**
 * COLDHARBOUR — the business district, mid-afternoon, with the fighting in the
 * streets.
 *
 * **320 x 320 m**, origin at the map centre, +Z is north. It is the first map
 * that is not 240: `MapLayout.size` states it and everything downstream takes
 * the extent as an argument, so nothing here is a special case. It is also the
 * first that stacks floors, which is what `surfaces: 5` at the bottom pays for
 * — see `MapLayout.surfaces` and the header of `world/kit/city.ts`.
 *
 * ## The plan
 *
 * Four avenues each way, 16 m wide, on centrelines at ±40 and ±120. That cuts
 * the map into a 5 x 5 of blocks: three bands of 64 m and, outside them, two of
 * 32 m against the boundary.
 *
 *      z=+160  +----+------+------+------+----+
 *              | 26 |  ##  |  ##  |  ##  | 26 |
 *      z=+120  ~~~~~~ avenue ~~~~~~~~~~~~~~~~~~
 *              | ## |  A   |  ##  |  D   | ## |     A  the Exchange (office)
 *      z= +40  ~~~~~~ avenue ~~~~~~~~~~~~~~~~~~     D  the Terminal forecourt
 *              | ## |  ##  |  C   |  ##  | ## |     C  the civic square
 *      z= -40  ~~~~~~ avenue ~~~~~~~~~~~~~~~~~~     B  the parkade
 *              | ## |  B   |  ##  |  E   | ## |     E  the tower plaza (office)
 *      z=-120  ~~~~~~ avenue ~~~~~~~~~~~~~~~~~~
 *              | 26 |  ##  |  ##  |  ##  | 26 |
 *      z=-160  +----+------+------+------+----+
 *             x=-160  -120   -40    +40   +120  +160
 *
 * The five flags are the centre block and the four blocks diagonally off it, so
 * every one is 113 m from C and 160 m from its neighbours, and the two home
 * yards are the far corner blocks — the NW and SE 32 m squares, left empty
 * because a spawn wants ground rather than a lobby.
 *
 * ## What each flag is, and why they are four different things
 *
 * - **C, the civic square.** A whole 64 m block of paving with the flag in the
 *   middle of it and a monument off to one side. It is the only objective on
 *   the map that is pure open ground, four streets feed it, and the towers
 *   round it overlook every metre — so it is the one you take last and lose
 *   first. What makes it crossable at all is the furniture: planters, a barrier
 *   run and two cars, laid on the diagonals a crossing actually uses.
 * - **A and E, the offices.** Three walked floors each, two entrances, a stair
 *   at one edge and a window band with chest-high cover round every upper
 *   storey. The flag stands on the GROUND floor, and the capture zone is a
 *   cylinder — so the storeys above it are inside the zone too, and holding one
 *   means holding a building rather than a circle.
 * - **B, the parkade.** The same trick with the roof off: three open decks, two
 *   ramps, and 0.95 m of upstand as the only cover. Every deck is inside the
 *   zone and every deck can shoot every other one, which no other objective in
 *   the game does.
 * - **D, the terminal forecourt.** Open ground under a long low hall, with
 *   planters and a tower for cover and no interior at all. It is the fast flag,
 *   and it is deliberately the one that plays like Hollowmere's square.
 *
 * ## The sightlines, which are the thing this map exists to have
 *
 * An avenue runs the full 320 m and nothing breaks it. That is not an oversight
 * — with the fog wall gone (see `environment.ts`) it is the first map where a
 * weapon's own `range` is the binding constraint rather than the weather, and
 * those numbers are 45 m for the pistol, 70 for the SMG, 120 for the rifle and
 * 180 for the DMR. So a street here is a place where the DMR is finally worth
 * its recoil and everything else has to close. What the parked traffic, the
 * barrier runs and the planters do is break the line at CHEST height at
 * intervals, so closing one is a series of covered bounds rather than a walk.
 *
 * Bots are the other half of it: `bots.perception.engageRange` is 55 m and did
 * not move with the fog, so a bot will not open up down an avenue it can see
 * the whole length of. That is deliberate and it is what keeps the streets
 * crossable at all — the fight happens at the junctions, in the buildings and
 * on the square, and the long lanes belong to the player.
 *
 * ## Layout hygiene (keep to these)
 *
 * - Structures are axis-aligned (`rotY` in multiples of pi/2). The parked cars
 *   are the exception the editor already makes for a cart.
 * - Nothing but kerb furniture stands in a carriageway. A building that reaches
 *   into one seals a route the whole plan depends on.
 * - Scatter regions stay clear of the flags by their own radius plus the prop's
 *   half-length; see the note above `scatter`.
 */

const placements: Placement[] = [
  // The four avenues each way, one slab apiece. Visual only — nothing stands on
  // a road, and the slab is sunk so its top sits a centimetre proud of the
  // floor. They overlap at the sixteen junctions and must: roads merge into ONE
  // mesh per material, which is what stops a junction z-fighting between two of
  // them.
  //
  // **300 m, not 320, and the twenty metres are load-bearing.** A road whose
  // ground is not level is re-cut against the heightfield by `terrainSlab`, and
  // a re-cut road takes the contoured path — which carries no lane markings,
  // because a dash is a box laid on a plane and a contoured slab is not one.
  // Run one out to the boundary and it catches the 1.2 m skirt in the last
  // eight metres (see heights.ts), so every avenue on the map silently lost its
  // centre line to two vertices at its far end. Stopping at +/-150 keeps all
  // eight on flat ground and on the fast path.
  { kind: "road", x: -120, z: 0, params: { surface: "asphalt", width: 16, length: 300 } },
  { kind: "road", x: -40, z: 0, params: { surface: "asphalt", width: 16, length: 300 } },
  { kind: "road", x: 40, z: 0, params: { surface: "asphalt", width: 16, length: 300 } },
  { kind: "road", x: 120, z: 0, params: { surface: "asphalt", width: 16, length: 300 } },
  { kind: "road", x: 0, z: -120, rotY: Math.PI / 2, params: { surface: "asphalt", width: 16, length: 300 } },
  { kind: "road", x: 0, z: -40, rotY: Math.PI / 2, params: { surface: "asphalt", width: 16, length: 300 } },
  { kind: "road", x: 0, z: 40, rotY: Math.PI / 2, params: { surface: "asphalt", width: 16, length: 300 } },
  { kind: "road", x: 0, z: 120, rotY: Math.PI / 2, params: { surface: "asphalt", width: 16, length: 300 } },

  // **The square is deliberately NOT paved with anything.** It was laid as one
  // 64 m cobble slab first, and cobblestone is the kit's one warm texture: a
  // tan floor in the middle of a grey city read as a sandpit and nothing else
  // on the map agreed with it. The valley floor's own `gravel` surface already
  // reads as aggregate paving (see the environment's `floorSurface`), so what
  // makes the square a square is the block it stands in and the monument on it.
  { kind: "monument", x: -12, z: 12, params: { width: 11 } }, // the square's landmark

  // --- the built blocks -----------------------------------------------------
  // Towers are solid and carry three colliders each; the two offices and the
  // parkade are the enterable ones. Heights are deliberately uneven and the
  // brick/glass split is derived from height alone (see `buildTower`), so a
  // block reads as having been built over a century rather than at once.
  { kind: "tower", x: -15, z: -95, params: { width: 26, depth: 26, height: 37 } },
  { kind: "tower", x: 15, z: -95, params: { width: 26, depth: 26, height: 22 } },
  { kind: "tower", x: -15, z: -65, params: { width: 26, depth: 26, height: 46 } },
  { kind: "tower", x: 15, z: -65, params: { width: 26, depth: 26, height: 14 } },
  { kind: "tower", x: 0, z: 65, params: { width: 58, depth: 26, height: 41 } },
  { kind: "tower", x: 0, z: 95, params: { width: 58, depth: 26, height: 27 } },
  { kind: "tower", x: -92, z: 0, params: { width: 34, depth: 58, height: 50 } },
  { kind: "tower", x: -63, z: -15, params: { width: 22, depth: 26, height: 16 } },
  { kind: "tower", x: -63, z: 15, params: { width: 22, depth: 26, height: 29 } },
  { kind: "tower", x: 80, z: -22, params: { width: 58, depth: 12, height: 13 } },
  { kind: "tower", x: 80, z: 22, params: { width: 58, depth: 12, height: 15 } },
  { kind: "tower", x: 57, z: 0, params: { width: 12, depth: 30, height: 32 } },
  { kind: "tower", x: 103, z: 0, params: { width: 12, depth: 30, height: 25 } },
  { kind: "office", x: -80, z: 66, params: { width: 30, depth: 24, floors: 3, litWindows: true } }, // A
  { kind: "tower", x: -95, z: 96, params: { width: 34, depth: 26, height: 33 } },
  { kind: "tower", x: -62, z: 96, params: { width: 26, depth: 26, height: 20 } },
  { kind: "parkade", x: -80, z: -78, params: { width: 36, depth: 26, floors: 3 } }, // B
  { kind: "tower", x: -95, z: -100, params: { width: 34, depth: 14, height: 17 } },
  { kind: "tower", x: -62, z: -100, params: { width: 24, depth: 14, height: 12 } },
  { kind: "tower", x: 80, z: 96, params: { width: 58, depth: 26, height: 15 } },
  { kind: "tower", x: 97, z: 62, params: { width: 24, depth: 20, height: 26 } },
  { kind: "office", x: 78, z: -66, params: { width: 28, depth: 24, floors: 3, litWindows: true } }, // E
  { kind: "tower", x: 94, z: -98, params: { width: 34, depth: 26, height: 44 } },
  { kind: "tower", x: 62, z: -98, params: { width: 22, depth: 26, height: 23 } },
  { kind: "tower", x: -144, z: -144, params: { width: 26, depth: 26, height: 24 } },
  { kind: "tower", x: -95, z: -144, params: { width: 26, depth: 26, height: 31 } },
  { kind: "tower", x: -65, z: -144, params: { width: 26, depth: 26, height: 18 } },
  { kind: "tower", x: -15, z: -144, params: { width: 26, depth: 26, height: 36 } },
  { kind: "tower", x: 15, z: -144, params: { width: 26, depth: 26, height: 21 } },
  { kind: "tower", x: 65, z: -144, params: { width: 26, depth: 26, height: 28 } },
  { kind: "tower", x: 95, z: -144, params: { width: 26, depth: 26, height: 15 } },
  { kind: "tower", x: -144, z: -95, params: { width: 26, depth: 26, height: 33 } },
  { kind: "tower", x: -144, z: -65, params: { width: 26, depth: 26, height: 19 } },
  { kind: "tower", x: 144, z: -95, params: { width: 26, depth: 26, height: 26 } },
  { kind: "tower", x: 144, z: -65, params: { width: 26, depth: 26, height: 38 } },
  { kind: "tower", x: -144, z: -15, params: { width: 26, depth: 26, height: 17 } },
  { kind: "tower", x: -144, z: 15, params: { width: 26, depth: 26, height: 23 } },
  { kind: "tower", x: 144, z: -15, params: { width: 26, depth: 26, height: 30 } },
  { kind: "tower", x: 144, z: 15, params: { width: 26, depth: 26, height: 20 } },
  { kind: "tower", x: -144, z: 65, params: { width: 26, depth: 26, height: 34 } },
  { kind: "tower", x: -144, z: 95, params: { width: 26, depth: 26, height: 27 } },
  { kind: "tower", x: 144, z: 65, params: { width: 26, depth: 26, height: 16 } },
  { kind: "tower", x: 144, z: 95, params: { width: 26, depth: 26, height: 29 } },
  { kind: "tower", x: -95, z: 144, params: { width: 26, depth: 26, height: 22 } },
  { kind: "tower", x: -65, z: 144, params: { width: 26, depth: 26, height: 35 } },
  { kind: "tower", x: -15, z: 144, params: { width: 26, depth: 26, height: 18 } },
  { kind: "tower", x: 15, z: 144, params: { width: 26, depth: 26, height: 25 } },
  { kind: "tower", x: 65, z: 144, params: { width: 26, depth: 26, height: 32 } },
  { kind: "tower", x: 95, z: 144, params: { width: 26, depth: 26, height: 24 } },
  { kind: "tower", x: 144, z: 144, params: { width: 26, depth: 26, height: 31 } },

  // --- the street, as furnished ---------------------------------------------
  // All of this is one collider apiece and all of it is cover. The lamps carry
  // NO light: it is the middle of the afternoon, and a fixture would spend one
  // of the sixteen shader slots saying so (see kit/city.ts).
  { kind: "planter", x: -18, z: -8, params: { width: 2.6, depth: 1.4 } },
  { kind: "planter", x: 14, z: -16, params: { width: 2.6, depth: 1.4 } },
  { kind: "planter", x: 18, z: 10, params: { width: 2.6, depth: 1.4 } },
  { kind: "planter", x: -4, z: 22, params: { width: 2.6, depth: 1.4 } },
  { kind: "barrier", x: 6, z: -22, params: { length: 8 } },
  { kind: "barrier", x: -24, z: 4, rotY: Math.PI / 2, params: { length: 8 } },
  { kind: "car", x: 24, z: -24, params: { tint: "#5d4a3a" } },
  { kind: "car", x: -26, z: -22, rotY: Math.PI / 2, params: { tint: "#4a4f45" } },
  { kind: "streetLight", x: -129.6, z: -129.6, params: { height: 7.5 } },
  { kind: "streetLight", x: -129.6, z: -49.6, params: { height: 7.5 } },
  { kind: "streetLight", x: -129.6, z: 30.4, params: { height: 7.5 } },
  { kind: "streetLight", x: -129.6, z: 110.4, params: { height: 7.5 } },
  { kind: "streetLight", x: -49.6, z: -129.6, params: { height: 7.5 } },
  { kind: "streetLight", x: -49.6, z: -49.6, params: { height: 7.5 } },
  { kind: "streetLight", x: -49.6, z: 30.4, params: { height: 7.5 } },
  { kind: "streetLight", x: -49.6, z: 110.4, params: { height: 7.5 } },
  { kind: "streetLight", x: 30.4, z: -129.6, params: { height: 7.5 } },
  { kind: "streetLight", x: 30.4, z: -49.6, params: { height: 7.5 } },
  { kind: "streetLight", x: 30.4, z: 30.4, params: { height: 7.5 } },
  { kind: "streetLight", x: 30.4, z: 110.4, params: { height: 7.5 } },
  { kind: "streetLight", x: 110.4, z: -129.6, params: { height: 7.5 } },
  { kind: "streetLight", x: 110.4, z: -49.6, params: { height: 7.5 } },
  { kind: "streetLight", x: 110.4, z: 30.4, params: { height: 7.5 } },
  { kind: "streetLight", x: 110.4, z: 110.4, params: { height: 7.5 } },
  { kind: "streetLight", x: -34, z: 0, params: { height: 7.5 } },
  { kind: "streetLight", x: 34, z: 0, params: { height: 7.5 } },
  { kind: "streetLight", x: 0, z: -34, params: { height: 7.5 } },
  { kind: "streetLight", x: 0, z: 34, params: { height: 7.5 } },
  { kind: "car", x: -46, z: -136, rotY: Math.PI / 2, params: { tint: "#3f4b52" } },
  { kind: "car", x: -46, z: -104, rotY: Math.PI / 2, params: { tint: "#3f4b52" } },
  { kind: "car", x: -46, z: -70, rotY: Math.PI / 2, params: { tint: "#3f4b52" } },
  { kind: "car", x: -46, z: 70, rotY: Math.PI / 2, params: { tint: "#3f4b52" } },
  { kind: "car", x: -46, z: 104, rotY: Math.PI / 2, params: { tint: "#3f4b52" } },
  { kind: "car", x: -46, z: 136, rotY: Math.PI / 2, params: { tint: "#3f4b52" } },
  { kind: "car", x: 46, z: -118, rotY: Math.PI / 2, params: { tint: "#6b463a" } },
  { kind: "car", x: 46, z: -84, rotY: Math.PI / 2, params: { tint: "#6b463a" } },
  { kind: "car", x: 46, z: -56, rotY: Math.PI / 2, params: { tint: "#6b463a" } },
  { kind: "car", x: 46, z: 56, rotY: Math.PI / 2, params: { tint: "#6b463a" } },
  { kind: "car", x: 46, z: 84, rotY: Math.PI / 2, params: { tint: "#6b463a" } },
  { kind: "car", x: 46, z: 118, rotY: Math.PI / 2, params: { tint: "#6b463a" } },
  { kind: "car", x: -136, z: -46, params: { tint: "#4a4f45" } },
  { kind: "car", x: -104, z: -46, params: { tint: "#4a4f45" } },
  { kind: "car", x: -70, z: -46, params: { tint: "#4a4f45" } },
  { kind: "car", x: 70, z: -46, params: { tint: "#4a4f45" } },
  { kind: "car", x: 104, z: -46, params: { tint: "#4a4f45" } },
  { kind: "car", x: 136, z: -46, params: { tint: "#4a4f45" } },
  { kind: "car", x: -118, z: 46, params: { tint: "#2f3338" } },
  { kind: "car", x: -84, z: 46, params: { tint: "#2f3338" } },
  { kind: "car", x: -56, z: 46, params: { tint: "#2f3338" } },
  { kind: "car", x: 56, z: 46, params: { tint: "#2f3338" } },
  { kind: "car", x: 84, z: 46, params: { tint: "#2f3338" } },
  { kind: "car", x: 118, z: 46, params: { tint: "#2f3338" } },
  { kind: "barrier", x: -40, z: 90, params: { length: 12 } },
  { kind: "barrier", x: -40, z: -30, params: { length: 12 } },
  { kind: "barrier", x: 40, z: 30, params: { length: 12 } },
  { kind: "barrier", x: 40, z: -90, params: { length: 12 } },
  { kind: "barrier", x: -90, z: -40, rotY: Math.PI / 2, params: { length: 12 } },
  { kind: "barrier", x: 30, z: -40, rotY: Math.PI / 2, params: { length: 12 } },
  { kind: "barrier", x: -30, z: 40, rotY: Math.PI / 2, params: { length: 12 } },
  { kind: "barrier", x: 96, z: 40, rotY: Math.PI / 2, params: { length: 12 } },
  { kind: "planter", x: 58, z: 56, params: { width: 2.6, depth: 1.4 } },
  { kind: "planter", x: 72, z: 50, params: { width: 2.6, depth: 1.4 } },
  { kind: "planter", x: 52, z: 74, params: { width: 2.6, depth: 1.4 } },
  { kind: "planter", x: -98, z: 50, params: { width: 2.6, depth: 1.4 } },
  { kind: "planter", x: -62, z: 50, params: { width: 2.6, depth: 1.4 } },
  { kind: "planter", x: 60, z: -50, params: { width: 2.6, depth: 1.4 } },
  { kind: "planter", x: 92, z: -50, params: { width: 2.6, depth: 1.4 } },
];

/**
 * What the city has instead of undergrowth: rubble where a facade has come
 * down, oil drums in the back lots, and the dead street trees the square was
 * planted with.
 *
 * It is deliberately thin. A downtown's cover is its ARCHITECTURE — the
 * furniture above is authored one piece at a time because each piece is a
 * decision about a sightline — and a scatter field is the wrong tool for that:
 * it is for dressing you fight around rather than terrain you fight from.
 * Every region here is in a street or a back lot, and every blocking one is
 * placed so its own radius plus the prop's half-length still clears the nearest
 * flag by a wide margin. That check is the Greyfen lesson: a log dropped 0.53 m
 * from flag A made it uncapturable, and nothing in the layout said it would.
 *
 * Note that ADDING A PLACEMENT REROLLS ALL OF THIS. `findSpot` draws from the
 * shared stream once per attempt, accepted or rejected, and placements build
 * before scatter — so a new building anywhere moves every region on the map.
 * Re-walk the flags after touching either array.
 */
const scatter: ScatterSpec[] = [
  { prop: "rubble", x: -120, z: -10, radius: 8, count: 5, scale: [0.8, 1.2], blocking: true, clearance: 1.1 },
  { prop: "rubble", x: 120, z: 10, radius: 8, count: 5, scale: [0.8, 1.2], blocking: true, clearance: 1.1 },
  { prop: "rubble", x: -10, z: 120, radius: 7, count: 4, scale: [0.8, 1.2], blocking: true, clearance: 1.1 },
  { prop: "rubble", x: 10, z: -120, radius: 7, count: 4, scale: [0.8, 1.2], blocking: true, clearance: 1.1 },
  { prop: "barrel", x: -46, z: -100, radius: 5, count: 4, blocking: true, clearance: 0.55 },
  { prop: "barrel", x: 46, z: 96, radius: 5, count: 4, blocking: true, clearance: 0.55 },
  // The square's planting, what is left of it. Well outside C's 16 m ring: the
  // nearest is 36.8 m from the flag against a radius plus clearance of 21.
  { prop: "deadTree", x: 20, z: 22, radius: 4, count: 3, scale: [0.8, 1.2], blocking: true, clearance: 0.55 },
  { prop: "deadTree", x: -22, z: -20, radius: 4, count: 3, scale: [0.8, 1.2], blocking: true, clearance: 0.55 },
];

/**
 * The five objectives.
 *
 * A, B and E stand INSIDE a building at ground-floor height, which is new and
 * is the point of them: capture is horizontal only, so the cylinder reaches
 * every storey above the flag and holding one means holding the whole
 * structure. `pos.y` is what the flag marker and the deploy map draw at and
 * what the capture ring is laid against, so it is the walked height of the
 * floor the flag is on rather than zero.
 *
 * Each of the three was checked against the builder's own geometry: none sits
 * in a service core, a stair lane or a car-park column, because a control point
 * inside a collider makes `surfaceAt` return -1 there and the flag becomes
 * uncapturable with nothing to see.
 */
const controlPoints: ControlPointDef[] = [
  { id: "A", name: "Alpha", pos: new Vector3(-80, 0.2, 66), radius: 15 },
  { id: "B", name: "Bravo", pos: new Vector3(-80, 0.2, -78), radius: 14 },
  { id: "C", name: "Charlie", pos: new Vector3(0, 0, 0), radius: 16 },
  { id: "D", name: "Delta", pos: new Vector3(64, 0, 64), radius: 14 },
  { id: "E", name: "Echo", pos: new Vector3(78, 0.2, -66), radius: 15 },
];

/**
 * Home spawns are uncapturable and sit in the two far corner blocks, which are
 * left empty for them. Every control point also carries a spawn just outside
 * its capture zone — on the avenue that serves it, so deploying onto a flag you
 * hold puts you a bound away from it rather than on top of whoever is
 * contesting it.
 */
const spawns: SpawnPointDef[] = [
  { team: 0, pos: new Vector3(-144, 0, 144), yaw: (Math.PI * 3) / 4 },
  { team: 0, pos: new Vector3(-152, 0, 136), yaw: (Math.PI * 3) / 4 },
  { team: 0, pos: new Vector3(-136, 0, 152), yaw: (Math.PI * 3) / 4 },
  { team: 1, pos: new Vector3(144, 0, -144), yaw: -Math.PI / 4 },
  { team: 1, pos: new Vector3(152, 0, -136), yaw: -Math.PI / 4 },
  { team: 1, pos: new Vector3(136, 0, -152), yaw: -Math.PI / 4 },
  { team: null, controlPoint: "A", pos: new Vector3(-80, 0, 46), yaw: 0 },
  { team: null, controlPoint: "B", pos: new Vector3(-80, 0, -46), yaw: Math.PI },
  // C's spawn is on the line x = z, and that is arithmetic rather than taste.
  // The two homes are at (-144, 144) and (144, -144), so the points equidistant
  // from both are exactly those with x = z — anywhere else and the flag every
  // round turns on hands one side a shorter walk back to it than the other.
  // 41 m out, which clears the 16 m ring with room, and inside the square's own
  // block so a squad deploys under cover of the buildings round it.
  { team: null, controlPoint: "C", pos: new Vector3(29, 0, 29), yaw: (-Math.PI * 3) / 4 },
  { team: null, controlPoint: "D", pos: new Vector3(52, 0, 44), yaw: 0.54 },
  { team: null, controlPoint: "E", pos: new Vector3(78, 0, -44), yaw: Math.PI },
];

export const ColdharbourLayout: MapLayout = {
  placements,
  scatter,
  controlPoints,
  spawns,
  terrain: ColdharbourHeights,
  /**
   * The first map that is not `CONFIG.map.size`. Everything downstream takes
   * the extent as an argument and carries it on `GameMap.size`; what a larger
   * map owes is stated on `MapLayout.size`, and the one that bites is that
   * `terrain.size * terrain.cell` must equal this — 80 x 4.
   */
  size: 320,
  /**
   * Three floors, a roof, a spandrel at every window and a wall head under
   * every ceiling stack six or seven candidates into one perimeter cell, and
   * `NavGrid` DROPS the overflow rather than sorting it in.
   *
   * **Four is a MEASURED number and the measurement is the interesting part.**
   * Probing every walked level of both offices and all three parkade decks —
   * the six stair landings included — for
   * "is it a surface, did the flood fill reach it, can both home fields route
   * to it", the answer is identical at 3, 4 and 5: 32,529 walkable surfaces,
   * every level reachable. Three is enough — because the builders emit walked
   * surfaces FIRST (see `world/kit/city.ts`), so the floors fill the slots and
   * it is the spandrels and the roof that get dropped, which is exactly the
   * right thing to lose.
   *
   * So this is one slot of margin over a value that already works, and it is
   * bought for a reason rather than for comfort: the guarantee rests entirely
   * on emission order inside a builder, and the failure when that order slips
   * is a storey quietly missing from the graph with the floor still drawn and
   * the stair still climbable. At 4 a slip costs a spandrel. Five buys nothing
   * measurable and costs another 1.5 MB of link table and 1.3 MB of flow field
   * on a grid this size.
   */
  surfaces: 4,
  /**
   * The bluffs the city sits under. Shallower than the default 0.205, because
   * on this map you can SEE the rim from anywhere — the fog no longer hides it
   * at 78 m — and a valley wall pitched for a village stands taller than the
   * fifty-metre towers in front of it. 0.17 puts the crest at ~27 m on the
   * sides and higher at the corners, which reads as the far side of a river
   * bowl and still clears the 7.2 deg the sky needs (see Ridge.ts).
   *
   * The two passes are where the central avenues leave town.
   */
  ridge: {
    slope: 0.17,
    passes: [
      { x: -40, z: 160, width: 26, depth: 0.5 },
      { x: 120, z: -160, width: 26, depth: 0.5 },
    ],
    seed: 0x43484252,
  },
  // Fixed so the dressing — and the colliders blocking scatter emits, and so
  // the nav graph — is identical on every boot. Changing it rerolls the whole
  // scatter field, which is a visible change to the level: re-walk the flags.
  seed: 0x434f4c44,
};
