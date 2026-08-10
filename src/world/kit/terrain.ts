/**
 * kit/terrain.ts — Ground-shaping builders: terrace, ramp, road, jetty,
 * boardwalk.
 * All follow the contract in kit/core.ts (origin-local geometry, no
 * solid/pickable/collisions metadata).
 * Extra care here: these are walkable surfaces, so their collider top faces
 * must stay within CONFIG.nav.stepHeight of adjacent ground and ramps need
 * rotX on the COLLIDER, not just the visual.
 */
import { Scene } from "@babylonjs/core";
import type { CelMaterialFactory } from "../../shaders/CelShader";
import { terrainSlab } from "../TerrainField";
import {
  Build,
  type BuildCtx,
  type BuildParams,
  type Structure,
  CREEPER,
  DARK_STONE,
  DIRT,
  GUARD_THICKNESS,
  PLANK,
  TEAK,
  TIMBER,
} from "./core";

/**
 * A raised earth terrace with a ramp on one side. Used for the chapel's
 * graveyard platform; the top face and the ramp are both walkable colliders.
 */
export function buildTerrace(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "terrace");
  const w = p.width ?? 30;
  const d = p.depth ?? 26;
  const h = p.height ?? 2;
  const side = p.rampSide ?? -1;

  b.box(w, h, d, 0, h / 2, 0, DIRT);
  b.block({ w, h, d, x: 0, y: h / 2, z: 0 });
  // Retaining wall, so the terrace edge reads as built rather than extruded.
  for (const sx of [-1, 1]) {
    b.box(0.4, h + 0.3, d, (sx * w) / 2, (h + 0.3) / 2, 0, DARK_STONE);
  }
  b.box(w, h + 0.3, 0.4, 0, (h + 0.3) / 2, (-side * d) / 2, DARK_STONE);

  // Ramp up the chosen face.
  const rampLen = h * 5;
  const pitch = Math.atan2(h, rampLen);
  const rz = (side * (d + rampLen)) / 2;
  b.box(7, 0.3, rampLen, 0, h / 2, rz, DIRT, { x: side * pitch });
  b.block({ w: 7, h: 0.3, d: rampLen, x: 0, y: h / 2, z: rz, rotX: side * pitch });
  return b;
}

/**
 * A standalone earth ramp, rising from -Z to +Z over `length`. Used to get in
 * and out of the creek at more than one point — a sunken lane with a single
 * exit is a trap, and the nav grid needs somewhere to route bots through.
 */
export function buildRamp(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "ramp");
  const w = p.width ?? 5;
  const len = p.length ?? 8;
  const h = p.height ?? 1.5;
  const pitch = Math.atan2(h, len);
  b.box(w, 0.3, len, 0, h / 2, 0, DIRT, { x: -pitch });
  b.block({ w, h: 0.3, d: len, x: 0, y: h / 2, z: 0, rotX: -pitch });
  // Kerb stones, so the ramp reads as built rather than as a floating slab.
  for (const sx of [-1, 1]) {
    b.box(0.4, h + 0.3, len, (sx * w) / 2, h / 2 - 0.2, 0, DARK_STONE, {
      x: -pitch,
    });
  }
  return b;
}

/**
 * Road surface. Visual only — it sits on the ground, so nothing ever stands on
 * the slab itself: feet rest on the floor from the ground probe and the nav
 * grid. The slab is therefore sunk so its top sits only a centimetre proud —
 * enough to avoid z-fighting the floor, but not enough to swallow a
 * character's ankles. Cobblestone by default; `surface: "dirt"` gives the flat
 * track for farm lanes.
 *
 * It is the one builder whose shape depends on where it is going. MapBuilder
 * samples the floor once, at a placement's own centre, and translates the whole
 * structure by it — fine for a cottage, wrong for 130 m of street, which used
 * to float at one end and bury itself at the other over sculpted ground. So the
 * slab is re-cut against the heightfield by `terrainSlab`, which returns null
 * over level ground and leaves the single box the road has always been. That
 * fast path is why a flat map costs exactly what it used to.
 */
export function buildRoad(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
  ctx?: BuildCtx,
): Structure {
  const b = new Build(scene, mats, "road");
  const top = 0.01;
  const h = 0.08;
  const w = p.width ?? 8;
  const len = p.length ?? 40;
  const dirt = p.surface === "dirt";

  const contoured =
    ctx &&
    terrainSlab(ctx.terrain, {
      w,
      len,
      x: ctx.x,
      z: ctx.z,
      rotY: ctx.rotY,
      originY: ctx.y,
      top,
      thickness: h,
    });
  if (contoured) b.surface(contoured, dirt ? DIRT : undefined);
  else if (dirt) b.box(w, h, len, 0, top - h / 2, 0, DIRT);
  else b.groundBox(w, h, len, 0, top - h / 2, 0);
  return b;
}

// --- the boardwalk --------------------------------------------------------

/**
 * Walked height of a boardwalk deck. Inside CONFIG.nav.stepHeight (0.6), which
 * is the whole design: every cell of the deck links to the ground beside it, so
 * a walk has no ramps and you step on and off it anywhere along its length.
 */
const WALK_DECK = 0.5;
/**
 * The deck slab's thickness, placed by its TOP face so the walked surface is
 * WALK_DECK however this changes.
 *
 * It is deliberately deeper than the height it stands at. `OutlineRenderer`
 * draws the outline shell with a slope-scaled negative depth offset, and at the
 * grazing angle you see a walked surface from, the shell's underside wins the
 * depth test unless there is real depth behind the top face — which paints the
 * deck flat in its own ink. The manor's 0.14 m board deck is the worked failure
 * (see CLAUDE.md); `boardDeck` in kit/manor.ts is the worked fix. Everything
 * else the boardwalk draws hangs BELOW this box, because a batten laid on top
 * of the walked surface would be a thin slab again with nothing behind it.
 */
const WALK_DECK_T = 0.64;
/** Metres between pile bents. */
const WALK_BENT = 3.5;

/**
 * A plank causeway on piles: the connective tissue between stilt huts, and the
 * way across marsh that is too shallow to be worth a bridge.
 *
 * ## Why this is not the trestle bridge with a height spinner
 *
 * The two have opposite navigation contracts, and it is geometry rather than a
 * parameter. A boardwalk's deck is under `stepHeight` above its own ground, so
 * it links along its whole length and needs no ramps; its underside is a
 * handspan off the ground, so `severLinks` cuts every link that crosses it and
 * `clearBlocked` blanks the ground beneath. It is a CAUSEWAY — you walk on it,
 * never under it, and that is correct. A trestle's deck is 1.6 m up: it links
 * only at its two ramped ends, and its underside clears `HEADROOM`, so the bed
 * stays walkable and you wade underneath. One builder with a `height` spinner
 * would cross 0.6 somewhere in the middle of its range and silently disconnect
 * itself from the map, with nothing to see and nothing thrown.
 *
 * ## Author it as a chain
 *
 * `MapBuilder` samples the terrain ONCE, at a placement's own centre, so a long
 * walk over anything but level ground floats at one end and buries itself at
 * the other — the problem `terrainSlab` solves for roads, which is not
 * available here because a boardwalk is a collider and a road is not. The fix
 * is authoring: lay a run as two or three 9–16 m placements so each samples its
 * own ground. Adjacent decks whose heights differ by less than `HEIGHT_EPS`
 * merge into one nav surface, so the joints cost nothing.
 */
export function buildBoardwalk(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "boardwalk");
  const len = p.length ?? 14;
  const w = p.width ?? 2.4;
  const rails = p.railSide ?? "both";

  // The deck: visual and collider in one box, placed by its top face.
  b.wall(w, WALK_DECK_T, len, 0, WALK_DECK - WALK_DECK_T / 2, 0, PLANK);

  const under = WALK_DECK - WALK_DECK_T;
  const bents = Math.max(1, Math.round(len / WALK_BENT));
  for (let i = 0; i <= bents; i++) {
    const z = -len / 2 + (i / bents) * len;
    // Cross-bearer, tucked directly under the deck so the slab reads as boards
    // carried on timber rather than as one extruded block.
    b.box(w + 0.24, 0.18, 0.22, 0, under - 0.09, z, TEAK);
    for (const sx of [-1, 1]) {
      // Piles. Visual only, and they must stay that way: a collider here would
      // sever the links under the walk, spend a nav surface below the deck, and
      // give bots something to wedge on. buildJetty makes the same call.
      b.cyl(1.5, 0.2, 0.26, 5, (sx * w) / 2.6, under - 0.18 - 0.75, z, TEAK);
    }
    // Creeper down alternate outer piles — the jungle read, and the reason a
    // boardwalk over a channel does not look like decking.
    if (i % 2 === 1) {
      b.box(0.07, 0.9, 0.16, (-w) / 2.6 - 0.13, under - 0.55, z, CREEPER);
    }
  }

  // Rails. `guard` stands them OUTBOARD of the deck edge — a rail sitting on the
  // walked surface would steal whichever 1.5 m nav cell its sample lands in.
  for (const side of ["-x", "+x"] as const) {
    if (rails !== "both" && rails !== side) continue;
    const sx = side === "+x" ? 1 : -1;
    b.guard(side, (sx * w) / 2, 0, len, WALK_DECK, { color: TEAK });
    // Posts on the rail's own centreline, which is half a thickness outboard —
    // drawn at the deck edge they would be inside the guard box and invisible.
    const postX = (sx * (w + GUARD_THICKNESS)) / 2;
    for (let i = 0; i <= bents; i++) {
      const z = -len / 2 + (i / bents) * len;
      b.box(0.17, 1.1, 0.17, postX, WALK_DECK + 0.55, z, TIMBER);
    }
  }
  return b;
}

/** Rotting jetty over the bog, running along Z. */
export function buildJetty(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "jetty");
  const len = p.length ?? 18;
  const w = 3;
  // Deck top must stay under CONFIG.nav.stepHeight above the mud, or the
  // flood fill never reaches it and bots treat the jetty as a wall.
  b.box(w, 0.24, len, 0, 0.45, 0, PLANK);
  b.block({ w, h: 0.24, d: len, x: 0, y: 0.45, z: 0 });
  const posts = Math.round(len / 3);
  for (let i = 0; i <= posts; i++) {
    const z = -len / 2 + (i / posts) * len;
    for (const sx of [-1, 1]) {
      b.cyl(1.3, 0.26, 0.32, 5, (sx * w) / 2.5, 0.05, z, TIMBER);
    }
  }
  return b;
}
