import { Vector3 } from "@babylonjs/core";
import type { BuildParams, BuilderKind } from "../BuildingKit";
import type { ControlPointDef, SpawnPointDef } from "../MapBuilder";

/**
 * HOLLOWMERE — the authored layout.
 *
 * 240 x 240 m, origin at the village square, +Z is north. Five flags in a rough
 * ring around the centre, with the two uncapturable home spawns diagonally
 * opposed so neither side starts next to C.
 *
 * ```
 *                             N
 *    +---------------------------------------------------+
 *    |  * WARDEN GATEHOUSE                                |
 *    |        (-100,+110)                                 |
 *    |                                                    |
 *    |     [A] CHAPEL              [D] FARMSTEAD          |
 *    |       (-60,+80)                (+80,+30)           |
 *    |       on a terrace             barn + hayloft      |
 *    |                                                    |
 *    |  [B] MILL          [C] SQUARE                      |
 *    |    (-85,-20)          (0,0)                        |
 *    |    sunken creek       the well                     |
 *    |                                                    |
 *    |                      [E] BOG DOCKS                 |
 *    |                          (+40,-85)                 |
 *    |                                    * BLIGHT CAMP   |
 *    |                                      (+105,-110)   |
 *    +---------------------------------------------------+
 * ```
 *
 * Design intent per flag:
 * - **A Chapel** — raised terrace, one ramp, enclosed nave. Easy to hold, slow
 *   to reach. The bell tower overlooks the north half.
 * - **B Mill** — sits *in* the creek, 1.5 m below the embankments on either
 *   side. Whoever holds the banks shoots down into it.
 * - **C Square** — four road approaches and no cover taller than a stall. The
 *   flag nobody keeps.
 * - **D Farmstead** — long sightlines over open paddocks; the barn hayloft is
 *   the map's best perch and the ramp to it is exposed.
 * - **E Bog Docks** — thick mist, tight boathouse, jetties with no cover. A
 *   short-range brawl by construction.
 */

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
  prop: "deadTree" | "gravestone" | "log" | "fungus" | "rubble" | "fireDrum";
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
}

const WARDEN = "#c9a15e";
const BLIGHT = "#ff3b3b";

/** Bank top height — the creek floor is the ground plane, 1.5 m below. */
const BANK_H = 1.5;
/** Chapel terrace height. */
const TERRACE_H = 2;

const placements: Placement[] = [
  // ===== roads =================================================================
  // Visual only; they sit on the ground plane and carry no collider.
  { kind: "road", x: 0, z: 0, params: { length: 130, width: 9 } },
  { kind: "road", x: 0, z: 0, rotY: Math.PI / 2, params: { length: 130, width: 9 } },
  { kind: "road", x: -60, z: 72, params: { length: 66, width: 8 } },
  { kind: "road", x: -30, z: 40, rotY: Math.PI / 2, params: { length: 64, width: 7 } },
  { kind: "road", x: 55, z: 30, rotY: Math.PI / 2, params: { length: 72, width: 8 } },
  { kind: "road", x: 40, z: -62, params: { length: 68, width: 8 } },
  { kind: "road", x: 20, z: -30, rotY: Math.PI / 2, params: { length: 44, width: 7 } },
  { kind: "road", x: -32, z: -20, rotY: Math.PI / 2, params: { length: 68, width: 7 } },
  { kind: "road", x: -80, z: 104, rotY: Math.PI / 2, params: { length: 46, width: 8 } },
  { kind: "road", x: 74, z: -104, rotY: Math.PI / 2, params: { length: 68, width: 8 } },

  // ===== C — the square ========================================================
  { kind: "well", x: 0, z: 0 },
  { kind: "stall", x: -7, z: 6, rotY: 0.2 },
  { kind: "stall", x: 7.5, z: 5, rotY: -0.3 },
  { kind: "stall", x: -5.5, z: -8, rotY: 3.0 },
  { kind: "stall", x: 8, z: -7, rotY: 2.8 },
  { kind: "lamp", x: -11, z: 1 },
  { kind: "lamp", x: 11, z: -1 },
  { kind: "lamp", x: 0, z: 14 },
  // The ring of houses that makes the square a square.
  { kind: "cottage", x: -19, z: 15, rotY: 0.25, params: { litWindows: true } },
  { kind: "cottage", x: 17, z: 17, rotY: -0.35, params: { width: 8, litWindows: true } },
  { kind: "cottage", x: 21, z: -7, rotY: Math.PI / 2, params: { depth: 8 } },
  { kind: "cottage", x: -21, z: -9, rotY: -Math.PI / 2, params: { enterable: true } },
  { kind: "cottage", x: 7, z: -21, rotY: Math.PI, params: { ruined: true } },
  { kind: "cottage", x: -9, z: 23, rotY: Math.PI, params: { width: 9, enterable: true, litWindows: true } },

  // ===== A — the chapel ========================================================
  // Terrace first: the chapel and its graveyard stand on top of it.
  { kind: "terrace", x: -60, z: 80, params: { width: 40, depth: 38, height: TERRACE_H, rampSide: -1 } },
  { kind: "chapel", x: -60, z: 74, y: TERRACE_H },
  { kind: "fence", x: -60, z: 62.5, y: TERRACE_H, params: { length: 38 } },
  { kind: "fence", x: -79, z: 80, y: TERRACE_H, rotY: Math.PI / 2, params: { length: 34 } },
  { kind: "fence", x: -41, z: 80, y: TERRACE_H, rotY: Math.PI / 2, params: { length: 34 } },
  { kind: "lamp", x: -74, z: 65, y: TERRACE_H },
  { kind: "lamp", x: -46, z: 65, y: TERRACE_H },
  { kind: "cottage", x: -34, z: 96, rotY: -0.4, params: { ruined: true } },
  { kind: "cottage", x: -80, z: 108, rotY: 0.5, params: { width: 8, litWindows: true } },

  // ===== B — the mill and the creek ===========================================
  // Two embankments 1.5 m high with a 6 m sunken lane between them. The creek
  // floor is the ground plane; the flag sits down in it.
  { kind: "terrace", x: -97, z: -10, params: { width: 18, depth: 76, height: BANK_H, rampSide: -1 } },
  { kind: "terrace", x: -73, z: -10, params: { width: 18, depth: 76, height: BANK_H, rampSide: -1 } },
  { kind: "mill", x: -78, z: 12, y: BANK_H, rotY: Math.PI / 2 },
  { kind: "bridge", x: -85, z: 22, y: BANK_H + 0.15, rotY: Math.PI / 2, params: { length: 26 } },
  { kind: "bridge", x: -85, z: -44, y: BANK_H + 0.15, rotY: Math.PI / 2, params: { length: 26 } },
  // Ramps in and out of the lane. A 1.5 m trench is right at the edge of a
  // standing jump, so without these the creek is a one-way trap for bots.
  { kind: "ramp", x: -84, z: 0, rotY: Math.PI / 2, params: { length: 8, width: 5, height: BANK_H } },
  { kind: "ramp", x: -84, z: -30, rotY: Math.PI / 2, params: { length: 8, width: 5, height: BANK_H } },
  { kind: "ramp", x: -92, z: 6, rotY: -Math.PI / 2, params: { length: 8, width: 5, height: BANK_H } },
  { kind: "ramp", x: -92, z: -26, rotY: -Math.PI / 2, params: { length: 8, width: 5, height: BANK_H } },
  { kind: "lamp", x: -73, z: -22, y: BANK_H },
  { kind: "cottage", x: -66, z: -36, rotY: 0.3, params: { ruined: true } },
  { kind: "cottage", x: -64, z: 30, rotY: -0.2, params: { width: 8 } },

  // ===== filler: the open ground between flags ================================
  // Cover on the long approaches, so crossing C -> D and C -> E isn't a walk
  // across a car park.
  { kind: "cottage", x: 36, z: 12, rotY: -0.5, params: { width: 8, ruined: true } },
  { kind: "cottage", x: 44, z: 36, rotY: 0.7, params: { litWindows: true } },
  { kind: "haystack", x: 30, z: 24 },
  { kind: "fence", x: 34, z: 2, rotY: 0.3, params: { length: 22 } },
  { kind: "cottage", x: 16, z: -38, rotY: 0.4, params: { width: 8 } },
  { kind: "cottage", x: 34, z: -46, rotY: -0.6, params: { ruined: true } },
  { kind: "fence", x: 26, z: -50, rotY: Math.PI / 2, params: { length: 26 } },
  { kind: "cottage", x: -36, z: -12, rotY: 1.2, params: { enterable: true } },
  { kind: "cottage", x: -44, z: 20, rotY: -0.3, params: { width: 8, ruined: true } },
  { kind: "cottage", x: -30, z: 52, rotY: 0.5, params: { litWindows: true } },
  { kind: "lamp", x: -46, z: -18 },
  { kind: "lamp", x: 40, z: 20 },
  { kind: "haystack", x: -40, z: 44 },

  // ===== D — the farmstead ====================================================
  { kind: "barn", x: 80, z: 34, rotY: Math.PI },
  { kind: "silo", x: 98, z: 16 },
  { kind: "haystack", x: 64, z: 18 },
  { kind: "haystack", x: 70, z: 10 },
  { kind: "haystack", x: 92, z: 40 },
  { kind: "fence", x: 78, z: 6, params: { length: 40 } },
  { kind: "fence", x: 58, z: 26, rotY: Math.PI / 2, params: { length: 40 } },
  { kind: "fence", x: 104, z: 34, rotY: Math.PI / 2, params: { length: 36 } },
  { kind: "lamp", x: 62, z: 34 },
  { kind: "cottage", x: 60, z: 52, rotY: -0.3, params: { litWindows: true } },
  { kind: "cottage", x: 96, z: 54, rotY: 0.4, params: { width: 8, enterable: true } },

  // ===== E — the bog docks ====================================================
  { kind: "boathouse", x: 40, z: -80, rotY: Math.PI },
  // The deck stands 0.73 m over the mud — too tall to step onto, so the door
  // gets a ramp or the whole flag is unreachable.
  { kind: "ramp", x: 40, z: -71, rotY: Math.PI, params: { length: 5, width: 4, height: 0.73 } },
  { kind: "jetty", x: 26, z: -96, params: { length: 20 } },
  { kind: "jetty", x: 54, z: -96, params: { length: 20 } },
  { kind: "fence", x: 40, z: -70, params: { length: 24 } },
  { kind: "lamp", x: 30, z: -68 },
  { kind: "cottage", x: 22, z: -62, rotY: 0.6, params: { ruined: true } },
  { kind: "cottage", x: 56, z: -60, rotY: -0.5, params: { width: 8, litWindows: true } },

  // ===== home spawns ==========================================================
  { kind: "gatehouse", x: -100, z: 110, rotY: 0.2, params: { teamColor: WARDEN } },
  { kind: "gatehouse", x: 105, z: -110, rotY: Math.PI + 0.2, params: { teamColor: BLIGHT } },
];

const scatter: ScatterSpec[] = [
  // Graveyard on the chapel terrace.
  { prop: "gravestone", x: -60, z: 88, radius: 15, count: 22, y: TERRACE_H, scale: [0.8, 1.3], blocking: true, clearance: 0.6 },
  { prop: "deadTree", x: -60, z: 82, radius: 18, count: 6, y: TERRACE_H, scale: [1.0, 1.6], blocking: true, clearance: 0.55 },
  // The dead woods filling the north-west and the map edges.
  { prop: "deadTree", x: -95, z: 60, radius: 26, count: 16, scale: [0.9, 1.7], blocking: true, clearance: 0.55 },
  { prop: "deadTree", x: -30, z: 100, radius: 24, count: 14, scale: [0.9, 1.7], blocking: true, clearance: 0.55 },
  { prop: "deadTree", x: 100, z: 90, radius: 26, count: 16, scale: [0.9, 1.7], blocking: true, clearance: 0.55 },
  { prop: "deadTree", x: -105, z: -70, radius: 26, count: 14, scale: [0.9, 1.7], blocking: true, clearance: 0.55 },
  // Creek bed: fallen logs and slick stones.
  { prop: "log", x: -85, z: -10, radius: 30, count: 9, scale: [0.8, 1.2], blocking: true, clearance: 1.4 },
  { prop: "fungus", x: -85, z: -20, radius: 26, count: 5, scale: [0.7, 1.2] },
  // The bog: corpse-fungus is the only light down there.
  { prop: "fungus", x: 40, z: -92, radius: 30, count: 7, scale: [0.8, 1.4] },
  { prop: "log", x: 34, z: -70, radius: 22, count: 6, scale: [0.8, 1.2], blocking: true, clearance: 1.4 },
  { prop: "deadTree", x: 62, z: -92, radius: 20, count: 10, scale: [0.8, 1.4], blocking: true, clearance: 0.55 },
  // Rubble where the village has already fallen in.
  { prop: "rubble", x: 7, z: -21, radius: 10, count: 5, scale: [0.8, 1.2], blocking: true, clearance: 1.1 },
  { prop: "rubble", x: -34, z: 96, radius: 10, count: 4, scale: [0.8, 1.2], blocking: true, clearance: 1.1 },
  { prop: "rubble", x: 22, z: -62, radius: 10, count: 4, scale: [0.8, 1.2], blocking: true, clearance: 1.1 },
  { prop: "rubble", x: -66, z: -36, radius: 10, count: 4, scale: [0.8, 1.2], blocking: true, clearance: 1.1 },
  // Braziers the defenders left burning. Sparse — each one costs a light slot.
  { prop: "fireDrum", x: 0, z: -14, radius: 4, count: 1, blocking: true, clearance: 0.6 },
  { prop: "fireDrum", x: 82, z: 22, radius: 4, count: 1, blocking: true, clearance: 0.6 },
  { prop: "fireDrum", x: -100, z: 104, radius: 5, count: 1, blocking: true, clearance: 0.6 },
  { prop: "fireDrum", x: 100, z: -104, radius: 5, count: 1, blocking: true, clearance: 0.6 },
];

const controlPoints: ControlPointDef[] = [
  { id: "A", name: "The Chapel", pos: new Vector3(-60, TERRACE_H, 76), radius: 14 },
  { id: "B", name: "The Mill", pos: new Vector3(-85, 0, -20), radius: 12 },
  // Just south of the well: standing the flag *on* the well would put its
  // centre inside a collider, where nothing can stand.
  { id: "C", name: "The Square", pos: new Vector3(0, 0, -4), radius: 14 },
  { id: "D", name: "The Farmstead", pos: new Vector3(80, 0, 34), radius: 13 },
  { id: "E", name: "The Bog Docks", pos: new Vector3(40, 0.73, -84), radius: 12 },
];

/**
 * Home spawns are uncapturable. Every control point also carries a spawn just
 * outside its capture zone, so deploying onto a flag you hold does not drop you
 * on top of whoever is contesting it.
 */
const spawns: SpawnPointDef[] = [
  { team: 0, pos: new Vector3(-100, 0, 104), yaw: Math.PI },
  { team: 0, pos: new Vector3(-94, 0, 104), yaw: Math.PI },
  { team: 0, pos: new Vector3(-106, 0, 104), yaw: Math.PI },
  { team: 1, pos: new Vector3(105, 0, -104), yaw: 0 },
  { team: 1, pos: new Vector3(99, 0, -104), yaw: 0 },
  { team: 1, pos: new Vector3(111, 0, -104), yaw: 0 },
  { team: null, controlPoint: "A", pos: new Vector3(-60, TERRACE_H, 62), yaw: Math.PI },
  { team: null, controlPoint: "B", pos: new Vector3(-85, 0, -36), yaw: Math.PI },
  { team: null, controlPoint: "C", pos: new Vector3(-2, 0, -18), yaw: Math.PI },
  { team: null, controlPoint: "D", pos: new Vector3(80, 0, 14), yaw: Math.PI },
  { team: null, controlPoint: "E", pos: new Vector3(40, 0, -66), yaw: 0 },
];

export const HollowmereLayout: MapLayout = {
  placements,
  scatter,
  controlPoints,
  spawns,
};
