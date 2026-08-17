/**
 * kit/city.ts — The downtown builders: tower, office, parkade, and the street
 * furniture that makes a roadway read as one.
 * All follow the contract in kit/core.ts (origin-local geometry, no
 * solid/pickable/collisions metadata, colliders declared not created).
 *
 * ## What is different about a city block, and why it is a file of its own
 *
 * Everything else in the kit is ONE walked surface with a roof over it. A
 * downtown is the first thing here that stacks them — three floors and a stair
 * between each pair — and stacking is where the world layer's quiet limits
 * live. Four rules come out of it, and every builder below obeys all four:
 *
 * - **A walked surface costs a `NavGrid` slot in every cell of its footprint**,
 *   and the grid keeps `maxSurfaces` of them per cell with the overflow
 *   DROPPED rather than sorted in. So the order colliders are declared in is
 *   part of the design: floors and ramps first, cover and parapets next, roofs
 *   LAST. That is `kit/manor.ts`'s rule generalised — it emits its roofs last
 *   for exactly this reason — and it is what lets a three-storey block keep all
 *   three of its storeys in the graph while spending its last slot on a
 *   spandrel rather than on a roof nothing can reach. Measured on Coldharbour:
 *   with this order the default 3 already keeps every storey, and the map
 *   states 4 for a slot of margin rather than out of need — see
 *   `MapLayout.surfaces` there. Get the order wrong and the map loses a floor
 *   with the slab still drawn and the stair still climbable.
 * - **A flight is 3.6 m of rise at `MAX_WALKABLE_GRADE`, so it is ten metres
 *   long**, and the slab it climbs to may not cover it — the ceiling would
 *   blank the flight out of the graph and strand the storey. Rather than cut a
 *   void around each flight, every building here puts its flights in a LANE at
 *   one edge and leaves that whole lane out of the slab above: the void is then
 *   one rectangle, the slab is one box, and the lane ALTERNATES between the
 *   two edges storey by storey, so the two voids never stack. What you get for
 *   free is an offset atrium on each side — a hole to shoot up and down
 *   through, which is most of what makes a building worth entering.
 * - **A walked slab needs real depth behind its top face.** `renderOutline`
 *   draws its shell with a slope-scaled negative depth offset, and at the
 *   grazing angle a floor is seen from, a thin slab's shell wins the depth test
 *   and paints the whole floor in its own ink. `SLAB` is 0.5 m for the reason
 *   `WALK_DECK_T` is 0.64 and the manor's board deck was raised off 0.14.
 * - **Mullions and railings are `strut`s, not walls.** A 0.24 m fin is a shape
 *   `NavGrid` can only get wrong, and it is exactly the fence's problem: it has
 *   to stop a round where it is drawn and be no body at all. `MapBuilder`
 *   merges a placement's struts into one collider mesh, which is what makes a
 *   glazed elevation affordable.
 *
 * ## What is deliberately NOT here
 *
 * No fixture lights on the street. A daylit map has nothing for them to do and
 * a carried light always wins one of the sixteen shader slots, so a lamp column
 * that is off is a lamp column that costs nothing — see
 * `EnvironmentSpec.lighting.lampIntensity`, which is the same argument from the
 * player's shoulder. The one exception is `office`'s `litWindows`, which is a
 * single interior light for the buildings a round is actually fought inside.
 */
import { Scene } from "@babylonjs/core";
import { CONFIG } from "../../config";
import type { CelMaterialFactory } from "../../shaders/CelShader";
import {
  Build,
  type BuildParams,
  type Structure,
  ALLOY,
  ASPHALT,
  CITY_BRICK,
  CONCRETE,
  DARK_CONCRETE,
  ENAMEL,
  GLASS,
  ROAD_PAINT,
  WINDOW_LIGHT,
} from "./core";

/**
 * Floor-to-floor height, and the one number the rest of this file is derived
 * from. 3.6 m leaves 3.1 m clear under a `SLAB`, which is an office rather
 * than a crawlspace, and it is what a flight at `GRADE` can climb in 10.3 m —
 * short enough to fit inside a building with room to walk round it.
 */
const STOREY = 3.6;
/**
 * Floor slab thickness. Placed by its TOP face, so the walked surface is exact
 * however this moves. Deep for the outline-shell reason in the header, not
 * because a floor is thick.
 */
const SLAB = 0.5;
/** Wall thickness, all four elevations. */
const WALL = 0.4;
/**
 * Stair and ramp grade. `CONFIG.nav.stepHeight / cellSize` is 0.4 and severs
 * its own links at exactly that, so this is the same margin under it that
 * `buildStairs` keeps.
 */
const GRADE = 0.35;
/** Riser aimed for; the tread count is rounded off it. `buildStairs`'s. */
const RISER = 0.18;
/**
 * Depth of the LANDING at the head of a flight, and the floor every flight in
 * this file arrives on.
 *
 * A lane is void at the level its flight climbs to (see `buildOffice`), so
 * without this the top tread is merely FLUSH with the slab beside it: the way
 * on is sideways, and walking off the stair in the direction you climbed it
 * drops you a storey. Nothing said so — the nav graph links the top tread to
 * the slab across the lane edge, so bots route through it and every reachability
 * probe passes while the player still runs off a cliff at the top of the stairs.
 *
 * 2.4 m is a landing rather than a lip: over `NavGrid`'s 1.5 m cell, so it is
 * never rounded out of the graph, and long enough to stop a sprint on. What is
 * left of the lane past it is still the atrium — 4.7 m on the shipped plate —
 * which is the hole the whole lane arrangement exists to leave.
 *
 * It is what a plate must be DEEP enough for, and the flight is the smaller
 * half of that: a flight overruns its own foot by 0.6 m and a landing stands
 * 2.4 m past its head, so `d` is what has to hold `run + 3.0`. Both builders
 * check it.
 */
const LANDING = 2.4;
/**
 * The ground floor's walked height, above the street outside.
 *
 * Inside `HEIGHT_EPS` (0.35), so `NavGrid.addSurface` MERGES it with the
 * terrain underneath instead of spending a second slot on it, and inside
 * `stepHeight` (0.6), so every doorway links to the pavement without a ramp.
 * It exists at all so the interior has a floor of its own colour and so the
 * slab is not coplanar with the ground — which is the tavern's flicker.
 */
const GROUND = 0.2;
/** Spandrel height above a floor: chest-high cover at every window. */
const SPANDREL = 1.0;
/** Head height of a window band above its floor. */
const HEAD = 2.5;
/** Metres between mullions. */
const MULLION_PITCH = 2.6;

/** Walked height of level `s`, 0 being the ground floor. */
const levelY = (s: number): number => (s === 0 ? GROUND : s * STOREY);

/**
 * A tower: the solid stock a downtown is mostly made of, and the thing that
 * turns a street into a canyon.
 *
 * **Not enterable, on purpose.** Sixteen bots and a player do not need sixty
 * rooms; what a skyline needs is silhouette and a wall to a sightline, and both
 * are three colliders. The enterable buildings are `office` and `parkade`, and
 * they are worth entering partly because their neighbours are not.
 *
 * Its skin is chosen by its own HEIGHT rather than by a parameter, so a layout
 * gets the two kinds of building a real block holds without stating which:
 * under `BRICK_CEILING` it is older low stock in brick with punched windows,
 * over it a banded curtain wall. One number, two silhouettes, and no way to ask
 * for a fifty-metre brick warehouse by accident.
 *
 * The floor bands are COLLARS — one box wrapping all four elevations per floor
 * line — rather than four boxes a side. A tower is twelve floor lines and the
 * saving is 36 meshes each before the merge; what it costs is that a band is
 * continuous round the corners, which is what a spandrel band actually does.
 */
export function buildTower(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "tower");
  const w = p.width ?? 18;
  const d = p.depth ?? 16;
  const h = p.height ?? 34;
  /** Above this a building is a curtain wall; below it, brick. */
  const BRICK_CEILING = 17;
  const brick = h < BRICK_CEILING;
  const skin = brick ? CITY_BRICK : CONCRETE;

  // The plinth. 0.3 m so it MERGES with the ground in the nav grid rather than
  // spending a slot (see `GROUND`), and so a body steps onto it: a kerb around
  // a tower is cover you can back into, and a 0.4 m one would be a separate
  // surface nothing links to at the corners.
  b.box(w + 0.7, 0.3, d + 0.7, 0, 0.15, 0, DARK_CONCRETE);
  b.block({ w: w + 0.7, h: 0.3, d: d + 0.7, x: 0, y: 0.15, z: 0 });

  // The shaft, and the setback above it. Two masses rather than one is what
  // stops a row of these reading as a row of crates: the upper one is inset,
  // so the skyline steps.
  const setback = brick ? 0 : Math.round(h * 0.34);
  const lower = h - setback;
  const sw = w * 0.76;
  const sd = d * 0.76;
  b.box(w, lower, d, 0, lower / 2, 0, skin);
  b.block({ w, h: lower, d, x: 0, y: lower / 2, z: 0 });
  if (setback > 0) {
    b.box(sw, setback, sd, 0, lower + setback / 2, 0, skin);
    b.block({ w: sw, h: setback, d: sd, x: 0, y: lower + setback / 2, z: 0 });
  }

  /**
   * Glazing, standing PROUD of each elevation rather than recessed into it.
   *
   * This was inset first and the panels were invisible: a shaft is one solid
   * box from `-d/2` to `+d/2`, so a 0.12 m sheet set 0.14 m back is entirely
   * inside it and never drawn — forty towers of blank concrete, with nothing
   * wrong anywhere and no way to tell from the numbers. What makes the recess
   * read instead is the COLLARS below, which stand further out again: 0.04 m of
   * glass over the wall, 0.2 m of band over the glass, so the storeys are a
   * shadow line and the bands are the thing catching the sun.
   */
  const glaze = (mw: number, md: number, y0: number, y1: number): void => {
    const mid = (y0 + y1) / 2;
    const tall = y1 - y0 - 0.6;
    if (tall <= 0) return;
    const t = 0.14;
    for (const sx of [-1, 1]) {
      b.box(t, tall, md - 1.2, (sx * (mw + t)) / 2 - sx * 0.04, mid, 0, GLASS);
    }
    for (const sz of [-1, 1]) {
      b.box(mw - 1.2, tall, t, 0, mid, (sz * (md + t)) / 2 - sz * 0.04, GLASS);
    }
    // Vertical fins between the bays. A curtain wall reads as vertical and the
    // collars are all horizontal, so without these a tower is a stack of
    // stripes; they also stand the one shadow line a flat elevation can have.
    const fin = 0.26;
    const bays = (span: number) => Math.max(2, Math.round(span / 5.5));
    for (const sz of [-1, 1]) {
      const n = bays(mw);
      for (let i = 1; i < n; i++) {
        const x = -mw / 2 + (i / n) * mw;
        b.box(fin, tall, fin, x, mid, (sz * (md + fin)) / 2 - sz * 0.06, skin);
      }
    }
    for (const sx of [-1, 1]) {
      const n = bays(md);
      for (let i = 1; i < n; i++) {
        const z = -md / 2 + (i / n) * md;
        b.box(fin, tall, fin, (sx * (mw + fin)) / 2 - sx * 0.06, mid, z, skin);
      }
    }
  };
  if (brick) {
    // Punched openings rather than a wall of glass: a grid of small panes,
    // two elevations only. The other two are blank brick, which is what the
    // party walls of a terrace are and costs nothing to draw.
    const rows = Math.max(1, Math.floor((h - 1.6) / STOREY));
    const cols = Math.max(2, Math.round(w / 3.2));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = -w / 2 + ((c + 0.5) / cols) * w;
        const y = 1.5 + r * STOREY;
        for (const sz of [-1, 1]) {
          b.box(1.3, 1.5, 0.14, x, y, (sz * d) / 2, GLASS);
        }
      }
    }
  } else {
    glaze(w, d, 0.3, lower);
    if (setback > 0) glaze(sw, sd, lower, h - 0.4);
    // Floor-line collars. One box each, wrapping the whole mass — and standing
    // proud of the glazing above, which is what turns a flat elevation into a
    // storey rhythm. See `glaze` for the three depths this is one of.
    for (let y = STOREY; y < lower - 0.4; y += STOREY) {
      b.box(w + 0.4, 0.42, d + 0.4, 0, y, 0, skin);
    }
    for (let y = lower + STOREY; y < h - 0.6; y += STOREY) {
      b.box(sw + 0.4, 0.42, sd + 0.4, 0, y, 0, skin);
    }
  }

  // The cap: a parapet collar, the plant housing behind it, and a mast. Emitted
  // last for the header's first rule — a roof is a surface nothing can reach
  // and must never take a slot a floor needs. Visual only; the shaft's own
  // collider already stops everything at this height.
  const topW = setback > 0 ? sw : w;
  const topD = setback > 0 ? sd : d;
  b.box(topW + 0.5, 0.9, topD + 0.5, 0, h + 0.15, 0, DARK_CONCRETE);
  b.box(topW * 0.5, 1.8, topD * 0.5, topW * 0.12, h + 0.9, 0, ALLOY);
  if (!brick) {
    b.cyl(6, 0.16, 0.3, 5, -topW * 0.3, h + 3.6, topD * 0.24, ALLOY);
    // An obstruction light. Emissive, so it reads at any hour and at any
    // distance — on a map with no fog the far side of the skyline is a
    // silhouette, and this is the one thing on it that is not.
    b.glow(0.34, 0.34, 0.34, -topW * 0.3, h + 6.7, topD * 0.24, "#ff5a4a");
  }
  return b;
}

/**
 * The office block: three walked floors, two flights, and the building this
 * whole file exists for.
 *
 * ## The shape, and why it is this shape
 *
 * A rectangle with a stair LANE down each of two opposite edges. The flight to
 * level 1 climbs the -X lane, the flight to level 2 the +X lane, and so on
 * alternating; each slab is a single box that stops short of the lane the
 * flight to it came up. So the void over a flight is the lane itself, never a
 * hole cut round it, and because consecutive lanes alternate, the slab
 * immediately above a flight is never the one that would cover it. (The one two
 * floors up does cover it, and clears its top by `STOREY - SLAB`, which is
 * 3.1 m against `NavGrid`'s 1.7 m `HEADROOM`.) Standing on
 * level 1 you can see the street through the -X void and the roof through the
 * +X one, which is the atrium a real building of this size has and the
 * vertical sightline a fight in it needs.
 *
 * **What the lane keeps back from the void is the LANDING at the head of each
 * flight** — `LANDING` deep, the lane's full width, and part of the walked
 * group rather than an afterthought. A flight climbs into a lane that has no
 * floor in it, so without one the top tread ends level with the slab beside it
 * and over nothing at all in front. The slab two floors up covers a landing
 * exactly as it covers the flight, at the same 3.1 m.
 *
 * The ground floor is ENCLOSED — two doorways, no windows — and every floor
 * above it is a continuous window band over a chest-high spandrel. That is a
 * gameplay gradient rather than an architectural one: the way in is a fight
 * through a dark room with two entrances, and what you win is a firing gallery
 * on three bearings with cover the whole way round.
 *
 * ## What must not be moved without re-deriving it
 *
 * The lane width IS the flight width. A void wider than its flight leaves a
 * strip of cells between the treads and the slab edge with no surface in them,
 * and the nav graph cannot step across a gap it has nothing to stand on — the
 * storey then reads as reachable from the stair and is not.
 *
 * The plate has to be DEEP enough for a flight and its landing: the circulation
 * runs from `run / 2 + 0.6` short of the -Z elevation to `run / 2 + LANDING`
 * short of the +Z one, so `depth` is what has to hold it. DEV throws rather than
 * pushing a landing through a wall.
 */
export function buildOffice(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "office");
  const w = p.width ?? 22;
  const d = p.depth ?? 18;
  const floors = Math.max(2, p.floors ?? 3);
  const top = floors * STOREY;
  /** Stair lane width, and the flight's width with it. See the header. */
  const lane = 3.4;
  /** Which edge level `s`'s flight climbs: -1 is the -X lane, +1 the +X. */
  const laneSide = (s: number): -1 | 1 => (s % 2 === 0 ? -1 : 1);
  /** Centre of that lane. */
  const laneX = (s: number): number => (laneSide(s) * (w - lane)) / 2;

  // --- walked surfaces first (header, first rule) --------------------------

  // The ground floor. Merges with the terrain in the nav grid; see GROUND.
  b.box(w, SLAB, d, 0, GROUND - SLAB / 2, 0, CONCRETE);
  b.block({ w, h: SLAB, d, x: 0, y: GROUND - SLAB / 2, z: 0 });

  // Upper slabs, each one box, each missing the lane its flight climbs.
  for (let s = 1; s < floors; s++) {
    const y = levelY(s);
    const sw = w - lane;
    // The slab sits on the side AWAY from the lane the flight to it used.
    const cx = (-laneSide(s - 1) * lane) / 2;
    b.box(sw, SLAB, d, cx, y - SLAB / 2, 0, CONCRETE);
    b.block({ w: sw, h: SLAB, d, x: cx, y: y - SLAB / 2, z: 0 });
  }

  // The flights and the landings they arrive on. One pair per storey, each in
  // its own lane, all climbing +Z so the building has a single circulation
  // direction and the landings line up.
  for (let s = 0; s + 1 < floors; s++) {
    const from = levelY(s);
    const to = levelY(s + 1);
    const rise = to - from;
    const run = rise / GRADE;
    if (import.meta.env.DEV && run / 2 + LANDING > d / 2 - WALL / 2) {
      throw new Error(
        `office: a ${d} m plate cannot hold a ${run.toFixed(1)} m flight and its ` +
          `${LANDING} m landing — the landing would stand in the +Z elevation. ` +
          "See buildOffice, and LANDING.",
      );
    }
    b.flight({
      x: laneX(s),
      w: lane,
      topZ: run / 2,
      topY: to,
      // Past its own foot, so the bottom tread is buried rather than floating:
      // `Build.flight` drops every tread under the local ground line, and the
      // overrun is what makes the joint at the floor look built.
      run: run + 0.6,
      rise: rise + 0.6 * GRADE,
      dir: 1,
      steps: Math.max(4, Math.round(rise / RISER)),
      color: DARK_CONCRETE,
    });
    // The landing, butted against the head of the flight it serves. Emitted
    // here rather than with the slabs so a flight and its floor stay one thing:
    // both are keyed to `run`, and a flight whose grade moved takes its landing
    // with it. See `LANDING`.
    const lz = run / 2 + LANDING / 2;
    b.box(lane, SLAB, LANDING, laneX(s), to - SLAB / 2, lz, CONCRETE);
    b.block({ w: lane, h: SLAB, d: LANDING, x: laneX(s), y: to - SLAB / 2, z: lz });
  }

  // --- enclosure ------------------------------------------------------------

  // Ground floor: solid, with a doorway on -Z and one on +X. Two ways in, for
  // `kit/manor.ts`'s reason — one entrance is a choke a squad can hold with a
  // single body, and what makes a building worth taking is that it cannot be.
  const g0 = GROUND;
  const gh = STOREY - SLAB - g0;
  b.doorWall(w, gh, WALL, 0, g0 + gh / 2, -d / 2, CONCRETE, 3.2, 2.6);
  b.wall(w, gh, WALL, 0, g0 + gh / 2, d / 2, CONCRETE);
  b.wall(WALL, gh, d, -w / 2, g0 + gh / 2, 0, CONCRETE);
  // The +X doorway is cut by hand: `doorWall` runs along X, and this wall runs
  // along Z. Two jambs and a lintel, the same three boxes it would emit.
  {
    const gap = 3.2;
    const jamb = (d - gap) / 2;
    for (const sz of [-1, 1]) {
      b.wall(WALL, gh, jamb, w / 2, g0 + gh / 2, (sz * (gap + jamb)) / 2, CONCRETE);
    }
    b.wall(WALL, gh - 2.6, gap, w / 2, g0 + 2.6 + (gh - 2.6) / 2, 0, CONCRETE);
  }

  // Upper floors: spandrel, window band, header. The spandrel is the cover the
  // gallery is for; the header is what stops the band reading as a missing
  // wall. Both are ordinary colliders — a body must not walk out of a window,
  // and the round that goes through the band is meant to.
  for (let s = 1; s < floors; s++) {
    const y = levelY(s);
    const ceil = (s + 1) * STOREY - SLAB;
    const headH = ceil - (y + HEAD);
    const sides: [number, number, number, number][] = [
      // [width along X, depth along Z, x, z]
      [w, WALL, 0, -d / 2],
      [w, WALL, 0, d / 2],
      [WALL, d, -w / 2, 0],
      [WALL, d, w / 2, 0],
    ];
    for (const [bw, bd, bx, bz] of sides) {
      b.wall(bw, SPANDREL, bd, bx, y + SPANDREL / 2, bz, CONCRETE);
      if (headH > 0.05) {
        b.wall(bw, headH, bd, bx, y + HEAD + headH / 2, bz, CONCRETE);
      }
    }
    // Mullions across the band. Struts: they stop a round where they are drawn
    // and are no body at all, and MapBuilder merges the lot into one collider
    // mesh — see the header's fourth rule.
    const bandH = HEAD - SPANDREL;
    const bandY = y + SPANDREL + bandH / 2;
    const along = (span: number, place: (t: number) => [number, number]) => {
      const n = Math.max(1, Math.round(span / MULLION_PITCH));
      for (let i = 1; i < n; i++) {
        const [mx, mz] = place(i / n);
        b.strut(0.24, bandH, 0.24, mx, bandY, mz, ALLOY);
      }
    };
    for (const sz of [-1, 1]) {
      along(w, (t) => [-w / 2 + t * w, (sz * d) / 2]);
    }
    for (const sx of [-1, 1]) {
      along(d, (t) => [(sx * w) / 2, -d / 2 + t * d]);
    }
  }

  // The service core: lifts and risers, one box from the ground to the roof.
  // ONE collider for the whole height rather than one per storey — it is solid
  // at every level, so the cells inside it are blocked at every level by the
  // same box, and a stack of three would be three surfaces nothing stands on.
  //
  // **It stands in the MIDDLE of the plate, clear of both lanes, and that is
  // the fix for a bug rather than a plan.** It was offset toward one edge
  // first, which put it inside the lane the SECOND flight climbs — so that
  // flight ran into a solid column at its own foot, the third storey was
  // unreachable by anything that could not already stand on it, and nothing
  // said so: the floor was there, the slab was there, the treads were drawn,
  // and the flood fill simply never arrived. Measured before and after with a
  // route probe from both home spawns, which is the only thing that shows it.
  const coreW = 4.6;
  const coreD = 4.2;
  const coreZ = -d * 0.26;
  b.box(coreW, top, coreD, 0, top / 2, coreZ, DARK_CONCRETE);
  b.block({ w: coreW, h: top, d: coreD, x: 0, y: top / 2, z: coreZ });

  // Loose cover on each gallery: a counter run and a pair of low partitions.
  // 1.1 m is under `CoverMap`'s 1.7 m hard-cover line, so bots read it as low
  // cover and crouch behind it, which is the same thing the player does.
  for (let s = 1; s < floors; s++) {
    const y = levelY(s);
    const cx = (-laneSide(s - 1) * lane) / 2;
    b.box(5.4, 1.1, 0.5, cx + 3.0, y + 0.55, d * 0.2, ENAMEL);
    b.block({ w: 5.4, h: 1.1, d: 0.5, x: cx + 3.0, y: y + 0.55, z: d * 0.2 });
    b.box(0.5, 1.1, 4.2, cx - 4.4, y + 0.55, -d * 0.05, ENAMEL);
    b.block({ w: 0.5, h: 1.1, d: 4.2, x: cx - 4.4, y: y + 0.55, z: -d * 0.05 });
  }

  // --- the roof, LAST -------------------------------------------------------
  // The header's first rule: a roof is a surface nothing reaches, so it must be
  // the candidate that gets dropped when a perimeter cell runs out of slots
  // rather than the third floor.
  b.box(w + 0.4, SLAB, d + 0.4, 0, top - SLAB / 2, 0, ASPHALT);
  b.block({ w: w + 0.4, h: SLAB, d: d + 0.4, x: 0, y: top - SLAB / 2, z: 0 });
  for (const sz of [-1, 1]) {
    b.box(w + 0.6, 0.8, 0.4, 0, top + 0.4, (sz * (d + 0.4)) / 2, CONCRETE);
  }
  for (const sx of [-1, 1]) {
    b.box(0.4, 0.8, d + 0.4, (sx * (w + 0.4)) / 2, top + 0.4, 0, CONCRETE);
  }
  b.box(coreW + 1.2, 2.2, coreD + 1.0, 0, top + 1.1, coreZ, DARK_CONCRETE);
  b.box(3.2, 1.4, 3.0, w * 0.22, top + 0.7, d * 0.26, ALLOY);

  if (p.litWindows) {
    // One light per GALLERY, not one per building.
    //
    // An interior on a daylit map is lit by ambient and the sky term, and the
    // sky term is applied by `n.y`: it lands in full on the floor and not at
    // all on the ceiling above it, which the AO bake then darkens again. So a
    // storey with nothing in it reads as a bright plate under a black lid, and
    // one light hung between the first two floors leaves the top one exactly
    // that. Two lights are affordable here because this map has no fixtures at
    // all outdoors (see the file header) — the sixteen shader slots are
    // otherwise entirely unspent.
    for (let s = 1; s < floors; s++) {
      b.light(WINDOW_LIGHT, 19, 0.8, 0.02, 0, levelY(s) + 2.1, d * 0.12);
    }
  }
  return b;
}

/**
 * The multi-storey car park: three open decks and the ramps between them.
 *
 * ## Why a downtown wants one of these more than another office
 *
 * It is the only building on the map you can see INTO from outside and shoot
 * out of from every bearing, because its elevations are a 0.95 m upstand and
 * then nothing until the deck above. So it plays as three stacked open
 * platforms rather than as rooms: cover is the columns and the upstand, the
 * ramps are the choke, and every level is contested from every other. The
 * office is a building you clear; this is a building you fight across.
 *
 * The top deck is OPEN SKY and reachable, which makes it the only roof on the
 * map anything can stand on. That is the whole reason the ramps are ramps and
 * not stairs — a ramp is a surface `NavGrid` rasterises without any special
 * case, so bots contest the roof the same way they contest the street.
 *
 * Lane alternation, the slab voids, the apron at the head of each ramp and the
 * emission order are `office`'s, for the reasons in this file's header and in
 * `LANDING`. What differs is that the columns run the
 * building's FULL height in one box each: a column is solid at every level, so
 * one box blocks all three, and its top face lands flush with the top deck
 * where `HEIGHT_EPS` merges it into a surface that is already there.
 */
export function buildParkade(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "parkade");
  const w = p.width ?? 32;
  const d = p.depth ?? 24;
  const decks = Math.max(2, p.floors ?? 3);
  /** Deck-to-deck. Lower than a storey — nothing here has a ceiling to clear. */
  const DECK = 3.2;
  const lane = 6.0;
  const laneSide = (s: number): -1 | 1 => (s % 2 === 0 ? -1 : 1);
  const laneX = (s: number): number => (laneSide(s) * (w - lane)) / 2;
  const deckY = (s: number): number => (s === 0 ? GROUND : s * DECK);
  const topY = deckY(decks - 1);

  // --- walked surfaces first ------------------------------------------------

  // The decks are CONCRETE rather than blacktop, and the reason is that a slab
  // is ONE BOX: its underside wears whatever its top does, and the underside of
  // a deck is the ceiling of the deck below — a downward normal, where the sky
  // term contributes nothing at all and the AO bake takes another 55% off the
  // ambient that is left. So the tone has to earn its keep on a surface getting
  // the least light on the map. Measured on the middle deck under a daylit sky:
  // the walked surface reads 44/255 in concrete against 17 in blacktop, which
  // is the difference between a shaded deck and a hole. It is also what a car
  // park deck is actually made of; the blacktop stays on the office ROOF, which
  // is bitumen and has nobody standing under it.
  b.box(w, SLAB, d, 0, GROUND - SLAB / 2, 0, CONCRETE);
  b.block({ w, h: SLAB, d, x: 0, y: GROUND - SLAB / 2, z: 0 });

  for (let s = 1; s < decks; s++) {
    const y = deckY(s);
    const sw = w - lane;
    const cx = (-laneSide(s - 1) * lane) / 2;
    b.box(sw, SLAB, d, cx, y - SLAB / 2, 0, CONCRETE);
    b.block({ w: sw, h: SLAB, d, x: cx, y: y - SLAB / 2, z: 0 });
    // A painted edge line along the void, so the drop reads before you take it.
    b.box(0.3, 0.06, d, cx + (laneSide(s - 1) * (sw - 0.3)) / 2, y + 0.03, 0, ROAD_PAINT);
  }

  // The ramps. A plain pitched slab rather than `Build.flight`: treads on a car
  // ramp would be wrong to look at, and the collider is the same one box with
  // `rotX` either way — which is the thing a ramp must not be missing (see
  // kit/core.ts, and `buildRamp` next door, which is this shape already).
  for (let s = 0; s + 1 < decks; s++) {
    const from = deckY(s);
    const to = deckY(s + 1);
    const rise = to - from;
    const run = rise / GRADE;
    const pitch = Math.atan(GRADE);
    const x = laneX(s);
    const mid = (from + to) / 2;
    const thick = 0.4;
    if (import.meta.env.DEV && run / 2 + LANDING > d / 2) {
      throw new Error(
        `parkade: a ${d} m plate cannot hold a ${run.toFixed(1)} m ramp and its ` +
          `${LANDING} m apron. See buildParkade, and LANDING.`,
      );
    }
    // Placed by its TOP face, whose half-thickness is measured VERTICALLY —
    // `h / 2 / cos`, the mistake `Build.flight`'s header names.
    const y = mid - thick / 2 / Math.cos(pitch);
    b.box(lane, thick, Math.hypot(run, rise), x, y, 0, CONCRETE, { x: -pitch });
    b.block({
      w: lane,
      h: thick,
      d: Math.hypot(run, rise),
      x,
      y,
      z: 0,
      rotX: -pitch,
    });
    // The apron at the head of the ramp, which is `office`'s landing and the
    // same constant: the deck the ramp climbs to omits this lane over its whole
    // depth, so the top of the ramp is otherwise the lip of a two-storey drop
    // with the deck reachable only sideways off it.
    const lz = run / 2 + LANDING / 2;
    b.box(lane, SLAB, LANDING, x, to - SLAB / 2, lz, CONCRETE);
    b.block({ w: lane, h: SLAB, d: LANDING, x, y: to - SLAB / 2, z: lz });
  }

  // --- cover and enclosure --------------------------------------------------

  // The upstand around every raised deck: the whole elevation of the building,
  // and the only cover on it. 0.95 m is crouch cover and under `CoverMap`'s
  // 1.7 m line, so bots use it as low cover the way the player does.
  for (let s = 1; s < decks; s++) {
    const y = deckY(s);
    for (const sz of [-1, 1]) {
      b.wall(w, 0.95, 0.35, 0, y + 0.475, (sz * d) / 2, CONCRETE);
    }
    for (const sx of [-1, 1]) {
      // Cut short on the side the ramp climbs, or the upstand walls the ramp in
      // at exactly the point a body has to leave it.
      const open = laneSide(s - 1) === sx;
      const len = open ? d - lane - 1.0 : d;
      const off = open ? (lane + 1.0) / 2 : 0;
      b.wall(0.35, 0.95, len, (sx * w) / 2, y + 0.475, off, CONCRETE);
    }
  }

  // Columns, full height, one box each. See the header.
  const cols = Math.max(2, Math.round(w / 7.5));
  const rows = Math.max(2, Math.round(d / 7.5));
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j <= rows; j++) {
      const x = -w / 2 + (i / cols) * w;
      const z = -d / 2 + (j / rows) * d;
      // Nothing in a ramp lane: a column in one is a pillar in the road. Both
      // lanes are at `±(w - lane) / 2` (see `laneX`), and the margin is half a
      // lane plus a column, so a column ON the lane edge goes too.
      if (Math.abs(Math.abs(x) - (w - lane) / 2) < lane / 2 + 0.4) continue;
      b.box(0.55, topY, 0.55, x, topY / 2, z, DARK_CONCRETE);
      b.block({ w: 0.55, h: topY, d: 0.55, x, y: topY / 2, z });
    }
  }

  // The top deck's own parapet, and the stair bulkhead beside it. Emitted after
  // the decks for the header's first rule, though nothing here is a surface:
  // the parapet's top is 1.05 m over a deck that already has a slot.
  for (const sz of [-1, 1]) {
    b.wall(w, 1.05, 0.35, 0, topY + 0.525, (sz * d) / 2, CONCRETE);
  }
  for (const sx of [-1, 1]) {
    const open = laneSide(decks - 2) === sx;
    const len = open ? d - lane - 1.0 : d;
    const off = open ? (lane + 1.0) / 2 : 0;
    b.wall(0.35, 1.05, len, (sx * w) / 2, topY + 0.525, off, CONCRETE);
  }
  b.box(4.0, 2.4, 3.4, w * 0.18, topY + 1.2, -d * 0.3, DARK_CONCRETE);
  return b;
}

/**
 * A concrete planter: the street's low cover, and the only green on the map.
 *
 * The shrub is drawn 0.3 m proud of the collider on purpose. A planter is cover
 * you crouch behind and a shrub is not, so the box stops at the rim and the
 * foliage above it is a silhouette a round goes through — the same call
 * `buildFernClump` makes, and the reason `PROP_BODIES` keeps a tree's collider
 * to its trunk.
 */
export function buildPlanter(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "planter");
  const w = p.width ?? 2.6;
  const d = p.depth ?? 1.4;
  const h = 0.95;
  b.box(w, h, d, 0, h / 2, 0, CONCRETE);
  b.block({ w, h, d, x: 0, y: h / 2, z: 0 });
  b.box(w - 0.34, 0.12, d - 0.34, 0, h, 0, "#3b3226");
  for (const sx of [-1, 1]) {
    b.box(w * 0.38, 0.9, d * 0.6, (sx * w) / 4.6, h + 0.42, 0, "#41552f");
  }
  return b;
}

/**
 * A run of jersey barrier: roadworks, a closed lane, a checkpoint that was.
 *
 * Chest-high cover you can put anywhere, and the one piece of city furniture
 * whose whole job is to break an avenue's sightline at the ground plane. The
 * taper is two boxes rather than a chamfered profile; at 0.9 m it is read as a
 * silhouette from eye height and never from the side.
 */
export function buildBarrier(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "barrier");
  const len = p.length ?? 6;
  const h = 0.9;
  const units = Math.max(1, Math.round(len / 3));
  for (let i = 0; i < units; i++) {
    const z = -len / 2 + (i + 0.5) * (len / units);
    const unit = len / units - 0.1;
    b.box(0.62, 0.34, unit, 0, 0.17, z, CONCRETE);
    b.box(0.36, h - 0.34, unit, 0, 0.34 + (h - 0.34) / 2, z, CONCRETE);
  }
  b.block({ w: 0.62, h, d: len, x: 0, y: h / 2, z: 0 });
  return b;
}

/**
 * A parked car, along its own local X.
 *
 * Its collider is the BODY and not the greenhouse: 1.0 m of steel is cover you
 * crouch behind, and the cabin above it is glass a round goes through. That is
 * the gravestone's lesson — a box squared off to the silhouette stops rounds
 * through the parts of it that are not there — and it is why the roof, the
 * pillars and the wheels are all outside the box.
 */
export function buildCar(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "car");
  const paint = p.tint ?? ENAMEL;
  const len = 4.4;
  const wide = 1.86;
  b.box(len, 0.72, wide, 0, 0.74, 0, paint);
  b.box(len * 0.52, 0.62, wide - 0.2, -0.1, 1.4, 0, GLASS);
  b.box(len * 0.5, 0.1, wide - 0.16, -0.1, 1.72, 0, paint);
  b.box(len + 0.16, 0.22, wide * 0.7, 0, 0.62, 0, DARK_CONCRETE);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.cyl(0.24, 0.68, 0.68, 8, (sx * len) / 3.1, 0.34, (sz * wide) / 2.5, "#22242a", {
        x: Math.PI / 2,
      });
    }
  }
  // Lamps, unlit metal rather than a glow: sixteen parked cars with headlights
  // on would be sixteen emissive meshes in the bloom for nothing.
  for (const sz of [-1, 1]) {
    b.box(0.12, 0.22, 0.5, len / 2, 0.86, (sz * wide) / 3.4, ROAD_PAINT);
  }
  b.block({ w: len, h: 1.1, d: wide, x: 0, y: 0.55, z: 0 });
  return b;
}

/**
 * A street lamp: an alloy column with a cantilevered head over the roadway.
 *
 * It carries NO light, and that is the file header's argument rather than an
 * omission — under a daylit sky there is nothing for one to do, and a fixture
 * light always wins one of the sixteen shader slots whether or not it is
 * adding anything.
 *
 * **The lens is not emissive either, and that was a fix rather than a
 * simplification.** It was a `glow` at a tenth of a lantern's strength, on the
 * argument that the head should still read at distance — and the `GlowLayer`
 * does not scale with the sky: a pale emissive against a bright afternoon
 * blooms to a hard white disc, so every junction on the map had a lamp burning
 * in broad daylight. What reads at distance instead is the SILHOUETTE, which is
 * what a cantilevered arm against the sky already is.
 */
export function buildStreetLight(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "streetlight");
  const h = p.height ?? 7.5;
  const reach = 2.2;
  b.cyl(h, 0.16, 0.3, 8, 0, h / 2, 0, ALLOY);
  b.box(reach, 0.16, 0.16, reach / 2, h - 0.1, 0, ALLOY);
  b.box(0.9, 0.18, 0.42, reach, h - 0.24, 0, ALLOY);
  b.box(0.7, 0.06, 0.3, reach, h - 0.35, 0, ROAD_PAINT);
  b.block({ w: 0.4, h, d: 0.4, x: 0, y: h / 2, z: 0 });
  return b;
}

/**
 * The civic monument at the middle of a square: three steps and a shaft.
 *
 * The steps are 0.34 m, inside `CONFIG.nav.stepHeight`, so the whole thing
 * links to the pavement from every bearing and needs no ramp — a plinth a bot
 * cannot climb is a plinth that makes the flag on it uncapturable, which is a
 * failure with nothing to see. Each tier is its own collider for that reason
 * and not for the look.
 *
 * A control point may stand on the top tier, but its `pos` must NOT be inside
 * the shaft: `surfaceAt` returns -1 inside a collider, and a flag whose centre
 * is in one cannot be captured at all.
 */
export function buildMonument(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "monument");
  const w = p.width ?? 11;
  const step = 0.34;
  if (import.meta.env.DEV && step > CONFIG.nav.stepHeight) {
    throw new Error(
      `monument: a ${step} m tier is over stepHeight (${CONFIG.nav.stepHeight}) ` +
        "and would strand its own top — see buildMonument.",
    );
  }
  for (let i = 0; i < 3; i++) {
    const s = w - i * 2.2;
    const y = (i + 1) * step;
    b.box(s, step, s, 0, y - step / 2, 0, CONCRETE);
    b.block({ w: s, h: step, d: s, x: 0, y: y - step / 2, z: 0 });
  }
  const base = 3 * step;
  b.box(2.4, 1.0, 2.4, 0, base + 0.5, 0, DARK_CONCRETE);
  b.block({ w: 2.4, h: 1.0, d: 2.4, x: 0, y: base + 0.5, z: 0 });
  b.box(1.3, 8.0, 1.3, 0, base + 5.0, 0, CONCRETE);
  b.block({ w: 1.3, h: 8.0, d: 1.3, x: 0, y: base + 5.0, z: 0 });
  b.box(1.7, 0.3, 1.7, 0, base + 9.15, 0, DARK_CONCRETE);
  b.cyl(1.6, 0.1, 0.7, 6, 0, base + 10.1, 0, ALLOY);
  return b;
}
