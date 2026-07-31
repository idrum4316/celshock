/**
 * editor/validate.ts — Checks a built map for the failure modes that are
 * invisible while you are building and ruinous once bots are walking.
 * Owns: the check list and its findings. Changes nothing.
 *
 * Every check here corresponds to a bug this project has actually shipped and
 * had to hunt down — the list in CLAUDE.md's layout gotchas is the
 * specification:
 *
 * - Flag C once sat on the well, so its centre was inside a collider and
 *   `surfaceAt` returned -1 there.
 * - The boathouse and jetty decks stood 0.62–0.73 m above the ground beside
 *   them, just over the 0.6 m step height, so the flood fill never reached
 *   them and bots read them as walls.
 * - An unbroken fence or dry-stone wall genuinely seals a plot, because the
 *   nav graph honours thin walls.
 *
 * None of these look wrong in the viewport. They only show up as "the bots
 * never go there", half an hour later.
 */
import { Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import type { MapLayout } from "../world/layout";
import type { GameMap } from "../world/MapBuilder";
import type { SelectionRef } from "./selection";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  /** Short label for the panel list. */
  text: string;
  /** Where to fly the camera to look at it. */
  at?: Vector3;
  /** What to select when the finding is clicked, when it maps to one item. */
  ref?: SelectionRef;
  /** Ranking hint — how big the problem is. Bigger sorts first. */
  weight?: number;
}

/** Minimum island size worth reporting — smaller ones are geometry noise. */
const MIN_ISLAND = 6;
/**
 * How far above neighbouring walkable ground an unreached surface has to sit
 * before it counts as a roof rather than a mistake.
 *
 * This threshold is the whole check. Unreached standable ground is NOT by
 * itself a bug — rooftops are unreached on purpose, and that is precisely what
 * keeps bots off them. Hollowmere has ~3,100 such cells and every one is a
 * roof. What matters is unreached ground that is *nearly* connected: a
 * courtyard sealed by a thin wall reads as a 0 m step to the ground beside it,
 * and the boathouse/jetty bug was a deck 0.62–0.73 m up against a 0.6 m step
 * height. Both sit far below any roofline.
 */
const ROOF_HEIGHT = 1.5;
/**
 * How much height variation an unreached region may have and still count as a
 * surface someone was meant to walk on.
 *
 * The other big source of unreached-but-low surfaces is the TOP OF A PROP.
 * Blocking scatter emits a collider, and a collider's top face is standable as
 * far as the grid is concerned — a boulder (1.4 m), a gravestone (1.7 m) and a
 * fire drum (2.1 m) all land inside ROOF_HEIGHT of the ground they stand on.
 * The grid cannot tell them from a deck, but they are scattered at random
 * scales, so a stand of them is lumpy, while a deck, a courtyard floor or an
 * embankment top is flat to within the grid's own height epsilon.
 */
const FLAT_TOLERANCE = 0.35;
/** How far apart two fixtures must be before they stop competing for a slot. */
const LIGHT_CLUSTER_RANGE = 30;
/** The shader's hard cap on simultaneous point lights. */
const LIGHT_SLOTS = 16;

export type NavSnapshot = ReturnType<GameMap["nav"]["debugSnapshot"]>;

/**
 * Builds a test for "is this unreached surface a mistake, or a roof?".
 *
 * Shared with the nav overlay so the red cells on screen are exactly the
 * findings in the list. Measures the smallest height difference to walkable
 * ground in an ADJACENT CELL — cell adjacency rather than graph links, because
 * the missing links are the symptom being diagnosed.
 */
export function makeIslandTest(snap: NavSnapshot): (s: number) => boolean {
  const { dim, maxSurfaces, counts, walkable, heights, neighbours } = snap;
  return (s: number): boolean => {
    const cell = Math.floor(s / maxSurfaces);
    const cx = Math.floor(cell / dim);
    const cz = cell % dim;
    for (const [dx, dz] of neighbours) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= dim || nz >= dim) continue;
      const ncell = nx * dim + nz;
      for (let si = 0; si < counts[ncell] && si < maxSurfaces; si++) {
        const ns = ncell * maxSurfaces + si;
        if (!walkable[ns]) continue;
        if (Math.abs(heights[ns] - heights[s]) <= ROOF_HEIGHT) return true;
      }
    }
    return false;
  };
}

export function validate(
  map: GameMap,
  layout: MapLayout,
  fixtures: readonly { position: Vector3 }[],
): Finding[] {
  const out: Finding[] = [];
  const nav = map.nav;
  const snap = nav.debugSnapshot();

  // 1. A control point whose centre is inside a collider: nothing can stand
  //    there, so the flag can never be contested.
  for (const [i, cp] of layout.controlPoints.entries()) {
    if (nav.surfaceAt(cp.pos.x, cp.pos.y, cp.pos.z) < 0) {
      out.push({
        severity: "error",
        text: `flag ${cp.id} centre is not standable (inside a collider?)`,
        at: cp.pos.clone(),
        ref: { list: "controlPoints", index: i },
      });
    }
  }

  // 2. Anything a bot must reach has to be reachable from BOTH home spawns.
  for (const team of [0, 1] as const) {
    const field = nav.field(`home${team}`);
    if (!field) continue;
    for (const [i, cp] of layout.controlPoints.entries()) {
      if (!nav.reachable(field, cp.pos)) {
        out.push({
          severity: "error",
          text: `flag ${cp.id} is unreachable from team ${team}'s spawn`,
          at: cp.pos.clone(),
          ref: { list: "controlPoints", index: i },
        });
      }
    }
  }
  for (const [i, s] of layout.spawns.entries()) {
    if (nav.surfaceAt(s.pos.x, s.pos.y, s.pos.z) < 0) {
      out.push({
        severity: "error",
        text: `spawn #${i} is not standable`,
        at: s.pos.clone(),
        ref: { list: "spawns", index: i },
      });
    }
  }

  // 3. Standable ground the flood fill never reached — a sealed plot, or a
  //    deck lifted just out of step range. Grouped into connected components
  //    so one enclosure is one finding rather than four hundred.
  out.push(...islands(snap));

  // 4. Light fixtures competing for the 16 shader slots.
  out.push(...validateLights(fixtures));

  // 5. Spots where the sub-cell push-out has nowhere legal to put a body.
  out.push(...validateClearance(map));

  // 6. Cheap static hygiene that needs no navigation at all.
  out.push(...hygiene(layout, map.size));

  // 7. The bookkeeping that only breaks once entries can be added and deleted.
  out.push(...structure(layout));

  // Errors first: the ones that make part of the map unplayable.
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * Connected components of standable-but-unreached surfaces. Uses the same
 * 8-way neighbour table the graph itself links with, so an "island" here is
 * an island by the graph's own definition rather than a lookalike.
 */
function islands(snap: ReturnType<GameMap["nav"]["debugSnapshot"]>): Finding[] {
  const {
    dim,
    cellSize,
    origin,
    maxSurfaces,
    stepHeight,
    counts,
    walkable,
    blocked,
    heights,
    links,
    neighbours,
  } = snap;
  const total = dim * dim * maxSurfaces;
  const seen = new Uint8Array(total);
  const found: Finding[] = [];

  const standable = (s: number): boolean => {
    const cell = Math.floor(s / maxSurfaces);
    return (
      s % maxSurfaces < counts[cell] && !blocked[s] && !walkable[s] && heights[s] >= 0
    );
  };

  /**
   * Smallest height difference from this surface to walkable ground in an
   * ADJACENT CELL — cell adjacency, not graph links, because the links are
   * exactly what is missing when something is sealed off.
   */
  const gapToGround = (s: number): number => {
    const cell = Math.floor(s / maxSurfaces);
    const cx = Math.floor(cell / dim);
    const cz = cell % dim;
    let best = Infinity;
    for (const [dx, dz] of neighbours) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= dim || nz >= dim) continue;
      const ncell = nx * dim + nz;
      for (let si = 0; si < counts[ncell] && si < maxSurfaces; si++) {
        const ns = ncell * maxSurfaces + si;
        if (!walkable[ns]) continue;
        best = Math.min(best, Math.abs(heights[ns] - heights[s]));
      }
    }
    return best;
  };

  const stack: number[] = [];
  for (let s = 0; s < total; s++) {
    if (seen[s] || !standable(s)) continue;

    let size = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let gap = Infinity;
    let gapAt: [number, number, number] | null = null;
    let lo = Infinity;
    let hi = -Infinity;
    stack.length = 0;
    stack.push(s);
    seen[s] = 1;

    while (stack.length) {
      const cur = stack.pop()!;
      size++;
      const cell = Math.floor(cur / maxSurfaces);
      const x = origin + (Math.floor(cell / dim) + 0.5) * cellSize;
      const z = origin + ((cell % dim) + 0.5) * cellSize;
      sx += x;
      sz += z;
      sy += heights[cur];
      lo = Math.min(lo, heights[cur]);
      hi = Math.max(hi, heights[cur]);

      const g = gapToGround(cur);
      if (g < gap) {
        gap = g;
        gapAt = [x, heights[cur], z];
      }

      const base = cur * neighbours.length;
      for (let n = 0; n < neighbours.length; n++) {
        const next = links[base + n];
        if (next >= 0 && !seen[next] && standable(next)) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }

    // A roof: unreached on purpose, and the thing keeping bots off it.
    if (size < MIN_ISLAND || gap > ROOF_HEIGHT) continue;
    // A stand of props rather than a surface anyone was meant to stand on.
    if (hi - lo > FLAT_TOLERANCE) continue;

    const at = gapAt ?? [sx / size, sy / size, sz / size];
    const reason =
      gap <= stepHeight
        ? `walled off from ground at the same level`
        : `${gap.toFixed(2)} m up, step height is ${stepHeight}`;
    found.push({
      // A warning, not an error, and deliberately so. The filters above remove
      // roofs and prop stands, but the grid fundamentally cannot tell a
      // boathouse deck from the top of a big flat collider — both are
      // standable surfaces nothing can reach. Hollowmere reports a handful of
      // these while playing perfectly well, so calling them errors would train
      // you to ignore the list, and the list also holds the flag and spawn
      // checks, which have no false positives at all.
      //
      // Use it as a DELTA: note the count, make a change, look again. A number
      // that jumps after you move a wall is the signal.
      severity: "warning",
      text: `${size} cells unreachable — ${reason}`,
      at: new Vector3(at[0], at[1] + 1.5, at[2]),
      weight: size,
    });
  }

  return found.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, 8);
}

/**
 * Whether the layout still describes a playable round at all.
 *
 * None of these can happen by dragging something: they are the failure modes
 * that arrive with add and delete. A flag id is the key its flow field is
 * stored under and the key spawns refer to it by, so a duplicate silently
 * merges two flags' routing, and a spawn naming a flag that no longer exists
 * is skipped by ConquestSystem — quietly, for the rest of the round.
 */
function structure(layout: MapLayout): Finding[] {
  const out: Finding[] = [];
  const seen = new Map<string, number>();

  for (const [i, cp] of layout.controlPoints.entries()) {
    const first = seen.get(cp.id);
    if (first !== undefined) {
      out.push({
        severity: "error",
        text: `two flags share the id "${cp.id}" (#${first} and #${i})`,
        at: cp.pos.clone(),
        ref: { list: "controlPoints", index: i },
      });
    } else {
      seen.set(cp.id, i);
    }
  }

  if (!layout.controlPoints.length) {
    out.push({
      severity: "error",
      text: "no control points — the round can never end",
    });
  }

  for (const [i, s] of layout.spawns.entries()) {
    if (s.team === null && !seen.has(s.controlPoint ?? "")) {
      out.push({
        severity: "error",
        text: `spawn #${i} belongs to flag "${s.controlPoint ?? "?"}", which does not exist`,
        at: s.pos.clone(),
        ref: { list: "spawns", index: i },
      });
    }
  }

  for (const team of [0, 1] as const) {
    if (!layout.spawns.some((s) => s.team === team)) {
      out.push({
        severity: "error",
        text: `team ${team} has no home spawn — it deploys at the origin`,
      });
    }
  }

  return out;
}

/** Checks that need only the layout — no navigation, no geometry. */
function hygiene(layout: MapLayout, size: number): Finding[] {
  const out: Finding[] = [];
  const half = size / 2 - 4;
  const quarter = Math.PI / 2;

  for (const [i, p] of layout.placements.entries()) {
    if (Math.abs(p.x) > half || Math.abs(p.z) > half) {
      out.push({
        severity: "warning",
        text: `${p.kind} #${i} sits in or past the valley ridge`,
        at: new Vector3(p.x, p.y ?? 0, p.z),
        ref: { list: "placements", index: i },
      });
    }
    const rot = p.rotY ?? 0;
    if (rot !== 0 && Math.abs(rot / quarter - Math.round(rot / quarter)) > 1e-6) {
      out.push({
        severity: "info",
        text: `${p.kind} #${i} is off-axis (layouts keep rotY to quarter turns)`,
        at: new Vector3(p.x, p.y ?? 0, p.z),
        ref: { list: "placements", index: i },
      });
    }
  }
  return out;
}

/** Fixture-cluster check, split out so it can take the lighting system. */
export function validateLights(
  fixtures: readonly { position: Vector3 }[],
): Finding[] {
  const out: Finding[] = [];
  const r2 = LIGHT_CLUSTER_RANGE * LIGHT_CLUSTER_RANGE;
  let worst = 0;
  let worstAt: Vector3 | null = null;

  for (const a of fixtures) {
    let n = 0;
    for (const b of fixtures) {
      if (Vector3.DistanceSquared(a.position, b.position) < r2) n++;
    }
    if (n > worst) {
      worst = n;
      worstAt = a.position;
    }
  }

  if (worst > LIGHT_SLOTS && worstAt) {
    out.push({
      severity: "warning",
      text: `${worst} fixtures within ${LIGHT_CLUSTER_RANGE} m — only ${LIGHT_SLOTS} slots exist`,
      at: worstAt.clone(),
    });
  }
  return out;
}

/** Body-clearance probe: spots where a bot would be pushed somewhere illegal. */
export function validateClearance(map: GameMap): Finding[] {
  const nav = map.nav;
  const snap = nav.debugSnapshot();
  const { dim, cellSize, origin, maxSurfaces, walkable, heights } = snap;
  const out = new Vector3();
  const radius = CONFIG.nav.bodyRadius;
  let traps = 0;
  let first: Vector3 | null = null;

  for (let cell = 0; cell < dim * dim; cell++) {
    const x = origin + (Math.floor(cell / dim) + 0.5) * cellSize;
    const z = origin + ((cell % dim) + 0.5) * cellSize;
    for (let si = 0; si < maxSurfaces; si++) {
      const s = cell * maxSurfaces + si;
      if (!walkable[s]) continue;
      const y = heights[s];
      if (!map.obstacles.resolve(x, y, z, radius, out)) continue;
      // Pushed clear — but if where it lands is not itself walkable, a body
      // standing here has nowhere legal to go.
      if (nav.surfaceAt(out.x, y, out.z) < 0) {
        traps++;
        if (!first) first = new Vector3(x, y + 1, z);
      }
    }
  }

  return traps && first
    ? [
        {
          severity: "warning",
          text: `${traps} spots where a body is pushed somewhere unwalkable`,
          at: first,
        },
      ]
    : [];
}
