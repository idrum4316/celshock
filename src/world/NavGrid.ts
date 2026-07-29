/**
 * NavGrid.ts — Walkable-surface graph + one precomputed flow field per
 * objective (5 flags + 2 home spawns). Built ONCE at map load from the final
 * collider set; runtime is read-only (bots call steer(), never pathfind).
 * Invariants: a graph node is a (cell, height) SURFACE — one cell can hold
 * creek floor + bridge deck (MAX_SURFACES=3). Surface heights come from the
 * collider's top-face PLANE at the cell centre, not its AABB: half-thickness
 * is h/2/cos(rotX), slope is tan(rotX) — the h/2*cos / -tan sign error makes
 * every ramp silently unwalkable. Reachability is a flood fill from open
 * ground, which is what keeps bots off rooftops. stepHeight must match
 * ObstacleField. Too coarse to be the only collision test — see ObstacleField.
 */
import { Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import type { WorldBox } from "./MapBuilder";

/**
 * Navigation for Hollowmere: a uniform grid of walkable surfaces plus one
 * precomputed flow field per objective.
 *
 * ## Why not steering
 *
 * The retired enemies steered straight at the player and pushed themselves out
 * of obstacle circles afterwards. That works in an empty box and fails
 * completely in a village — a bot would grind along a cottage wall forever
 * instead of walking round it. A grid gives real pathing, and precomputing a
 * field per goal means 32 bots share the same seven searches rather than each
 * running its own A*.
 *
 * ## Surfaces, not cells
 *
 * A cell can have more than one standable height: the creek floor and the
 * bridge deck above it, the barn floor and its hayloft. So the graph node is a
 * *surface* — a (cell, height) pair — discovered by rasterising every collider's
 * top face into the grid. Two surfaces are connected when they are
 * side-by-side and within `stepHeight` of each other, which is what makes ramps
 * traversable and walls not.
 *
 * The map never changes, so all of this is built once at load and then only
 * read.
 */

/**
 * Max standable surfaces tracked per cell. Three is enough for Hollowmere's
 * worst case — creek floor, bank top, bridge deck stacked in one column.
 */
const MAX_SURFACES = 3;
/** Heights closer than this are the same surface. */
const HEIGHT_EPS = 0.35;
/** Vertical clearance a combatant needs to stand somewhere. */
const HEADROOM = 1.7;

const NEIGHBOURS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** A precomputed route to one goal: per-surface step count, lower is closer. */
export class FlowField {
  constructor(
    readonly name: string,
    /** Indexed by surface id; `Infinity` where the goal is unreachable. */
    readonly dist: Float32Array,
  ) {}
}

export class NavGrid {
  readonly cellSize: number;
  /** Cells per side. */
  readonly dim: number;
  private readonly origin: number;

  /** Surface heights per cell, ascending. `-1` marks an unused slot. */
  private readonly heights: Float32Array;
  /** How many surfaces each cell actually has. */
  private readonly counts: Uint8Array;
  /** Whether each surface was reached by the connectivity flood fill. */
  private readonly walkable: Uint8Array;
  /** Neighbour surface ids per surface, `-1`-padded. */
  private readonly links: Int32Array;

  private readonly fields = new Map<string, FlowField>();

  constructor(size: number, boxes: WorldBox[]) {
    this.cellSize = CONFIG.nav.cellSize;
    this.dim = Math.ceil(size / this.cellSize);
    this.origin = -size / 2;

    const cells = this.dim * this.dim;
    this.heights = new Float32Array(cells * MAX_SURFACES).fill(-1);
    this.counts = new Uint8Array(cells);
    this.walkable = new Uint8Array(cells * MAX_SURFACES);
    this.links = new Int32Array(cells * MAX_SURFACES * NEIGHBOURS.length).fill(-1);

    this.rasterize(boxes);
    this.link(boxes);
  }

  get surfaceCount(): number {
    return this.dim * this.dim * MAX_SURFACES;
  }

  /** Number of surfaces the flood fill could actually stand on. */
  get walkableCount(): number {
    let n = 0;
    for (let i = 0; i < this.walkable.length; i++) if (this.walkable[i]) n++;
    return n;
  }

  // --- construction --------------------------------------------------------

  /**
   * Finds every standable height in every cell by evaluating each collider's
   * top face at the cell centre. Analytic rather than raycast: 25,600 cells
   * against 300 colliders is a handful of milliseconds, where 25,600
   * `pickWithRay` calls would be seconds.
   */
  private rasterize(boxes: WorldBox[]): void {
    // The valley floor is standable everywhere by default.
    for (let i = 0; i < this.dim * this.dim; i++) {
      this.heights[i * MAX_SURFACES] = 0;
      this.counts[i] = 1;
    }

    for (const box of boxes) {
      // Skip the ground plane and the ridge: the floor is already the default,
      // and the ridge is pure boundary.
      if (box.w > 200 || box.d > 200) continue;

      const reach = (Math.abs(box.w) + Math.abs(box.d)) / 2 + box.h;
      const minX = Math.max(0, this.toCell(box.cx - reach));
      const maxX = Math.min(this.dim - 1, this.toCell(box.cx + reach));
      const minZ = Math.max(0, this.toCell(box.cz - reach));
      const maxZ = Math.min(this.dim - 1, this.toCell(box.cz + reach));

      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const wx = this.toWorld(cx);
          const wz = this.toWorld(cz);
          const top = topFaceHeight(box, wx, wz);
          if (top === null) continue;
          this.addSurface(cz * this.dim + cx, top);
        }
      }
    }
  }

  /** Inserts a candidate height into a cell, keeping the list sorted and deduped. */
  private addSurface(cell: number, y: number): void {
    const base = cell * MAX_SURFACES;
    const n = this.counts[cell];
    for (let i = 0; i < n; i++) {
      if (Math.abs(this.heights[base + i] - y) < HEIGHT_EPS) {
        // Keep the higher of two near-identical surfaces — that's the one you
        // actually stand on where a deck overlaps its own support beam.
        if (y > this.heights[base + i]) this.heights[base + i] = y;
        return;
      }
    }
    if (n >= MAX_SURFACES) return;
    let i = n;
    while (i > 0 && this.heights[base + i - 1] > y) {
      this.heights[base + i] = this.heights[base + i - 1];
      i--;
    }
    this.heights[base + i] = y;
    this.counts[cell] = n + 1;
  }

  /**
   * Builds the surface graph, then flood-fills it from the valley floor to
   * decide what is actually reachable.
   *
   * The flood fill is what keeps bots off rooftops: a roof is a perfectly good
   * standable surface, but nothing adjacent to it is within a step, so it is
   * never reached and never becomes walkable.
   */
  private link(boxes: WorldBox[]): void {
    const step = CONFIG.nav.stepHeight;
    const linkStride = NEIGHBOURS.length;

    for (let cz = 0; cz < this.dim; cz++) {
      for (let cx = 0; cx < this.dim; cx++) {
        const cell = cz * this.dim + cx;
        for (let si = 0; si < this.counts[cell]; si++) {
          const surface = cell * MAX_SURFACES + si;
          const y = this.heights[surface];
          for (let n = 0; n < linkStride; n++) {
            const [dx, dz] = NEIGHBOURS[n];
            const nx = cx + dx;
            const nz = cz + dz;
            if (nx < 0 || nz < 0 || nx >= this.dim || nz >= this.dim) continue;
            const ncell = nz * this.dim + nx;
            // Nearest neighbouring surface within a step, if any.
            let best = -1;
            let bestDy = Infinity;
            for (let ni = 0; ni < this.counts[ncell]; ni++) {
              const ny = this.heights[ncell * MAX_SURFACES + ni];
              const dy = Math.abs(ny - y);
              if (dy <= step && dy < bestDy) {
                bestDy = dy;
                best = ncell * MAX_SURFACES + ni;
              }
            }
            this.links[surface * linkStride + n] = best;
          }
        }
      }
    }

    // Anything with a solid box sitting on top of it is not standable.
    this.clearBlocked(boxes);

    // Flood from the map's outer ring, which is guaranteed open ground.
    const queue: number[] = [];
    const push = (cell: number) => {
      if (this.counts[cell] === 0) return;
      const s = cell * MAX_SURFACES;
      if (this.blocked[s] || this.walkable[s]) return;
      this.walkable[s] = 1;
      queue.push(s);
    };
    for (let i = 2; i < this.dim - 2; i++) {
      push(2 * this.dim + i);
      push((this.dim - 3) * this.dim + i);
      push(i * this.dim + 2);
      push(i * this.dim + this.dim - 3);
    }

    for (let head = 0; head < queue.length; head++) {
      const surface = queue[head];
      for (let n = 0; n < linkStride; n++) {
        const next = this.links[surface * linkStride + n];
        if (next < 0 || this.walkable[next] || this.blocked[next]) continue;
        this.walkable[next] = 1;
        queue.push(next);
      }
    }
  }

  private blocked = new Uint8Array(0);

  /**
   * Marks surfaces with no headroom. A cottage's interior floor has a roof slab
   * well above it and stays clear; the cell *under* a wall does not.
   */
  private clearBlocked(boxes: WorldBox[]): void {
    this.blocked = new Uint8Array(this.dim * this.dim * MAX_SURFACES);
    for (const box of boxes) {
      if (box.w > 200 || box.d > 200) continue;
      const reach = (Math.abs(box.w) + Math.abs(box.d)) / 2 + box.h;
      const minX = Math.max(0, this.toCell(box.cx - reach));
      const maxX = Math.min(this.dim - 1, this.toCell(box.cx + reach));
      const minZ = Math.max(0, this.toCell(box.cz - reach));
      const maxZ = Math.min(this.dim - 1, this.toCell(box.cz + reach));
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const wx = this.toWorld(cx);
          const wz = this.toWorld(cz);
          const span = verticalSpan(box, wx, wz);
          if (!span) continue;
          const cell = cz * this.dim + cx;
          for (let si = 0; si < this.counts[cell]; si++) {
            const y = this.heights[cell * MAX_SURFACES + si];
            // Overlapping the space a body would occupy, but not merely being
            // the surface itself.
            if (span.top > y + 0.15 && span.bottom < y + HEADROOM) {
              this.blocked[cell * MAX_SURFACES + si] = 1;
            }
          }
        }
      }
    }
  }

  // --- queries -------------------------------------------------------------

  private toCell(world: number): number {
    return Math.floor((world - this.origin) / this.cellSize);
  }

  private toWorld(cell: number): number {
    return this.origin + (cell + 0.5) * this.cellSize;
  }

  /**
   * The walkable surface at a world position, or -1. Picks the standable height
   * nearest the given `y`, so a bot on a bridge resolves to the deck and one in
   * the creek resolves to the floor.
   */
  surfaceAt(x: number, y: number, z: number): number {
    const cx = this.toCell(x);
    const cz = this.toCell(z);
    if (cx < 0 || cz < 0 || cx >= this.dim || cz >= this.dim) return -1;
    const cell = cz * this.dim + cx;
    let best = -1;
    let bestDy = Infinity;
    for (let si = 0; si < this.counts[cell]; si++) {
      const s = cell * MAX_SURFACES + si;
      if (!this.walkable[s]) continue;
      const dy = Math.abs(this.heights[s] - y);
      if (dy < bestDy) {
        bestDy = dy;
        best = s;
      }
    }
    return best;
  }

  /** Standing height of a surface. */
  heightOf(surface: number): number {
    return this.heights[surface];
  }

  /** World centre of a surface's cell. */
  positionOf(surface: number, into: Vector3): Vector3 {
    const cell = Math.floor(surface / MAX_SURFACES);
    return into.set(
      this.toWorld(cell % this.dim),
      this.heights[surface],
      this.toWorld(Math.floor(cell / this.dim)),
    );
  }

  /**
   * Precomputes a flow field: a breadth-first sweep out from every surface
   * inside `radius` of the goal. Called once per objective at load.
   */
  buildField(name: string, goal: Vector3, radius: number): FlowField {
    const dist = new Float32Array(this.surfaceCount).fill(Infinity);
    const queue: number[] = [];
    const linkStride = NEIGHBOURS.length;

    const r = Math.ceil(radius / this.cellSize);
    const gx = this.toCell(goal.x);
    const gz = this.toCell(goal.z);
    for (let cx = gx - r; cx <= gx + r; cx++) {
      for (let cz = gz - r; cz <= gz + r; cz++) {
        if (cx < 0 || cz < 0 || cx >= this.dim || cz >= this.dim) continue;
        const s = this.surfaceAt(this.toWorld(cx), goal.y, this.toWorld(cz));
        if (s < 0 || dist[s] === 0) continue;
        dist[s] = 0;
        queue.push(s);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const s = queue[head];
      const next = dist[s] + 1;
      for (let n = 0; n < linkStride; n++) {
        const t = this.links[s * linkStride + n];
        if (t < 0 || !this.walkable[t] || dist[t] <= next) continue;
        dist[t] = next;
        queue.push(t);
      }
    }

    const field = new FlowField(name, dist);
    this.fields.set(name, field);
    return field;
  }

  field(name: string): FlowField | undefined {
    return this.fields.get(name);
  }

  /**
   * Direction to move from `pos` to get closer to a field's goal: the
   * neighbouring surface with the lowest remaining distance. Returns a zero
   * vector at the goal or when stranded.
   */
  steer(field: FlowField, pos: Vector3, into: Vector3): Vector3 {
    into.setAll(0);
    const here = this.surfaceAt(pos.x, pos.y, pos.z);
    if (here < 0) return into;
    const linkStride = NEIGHBOURS.length;
    let best = -1;
    let bestDist = field.dist[here];
    for (let n = 0; n < linkStride; n++) {
      const t = this.links[here * linkStride + n];
      if (t < 0 || !this.walkable[t]) continue;
      if (field.dist[t] < bestDist) {
        bestDist = field.dist[t];
        best = t;
      }
    }
    if (best < 0) return into;

    const cell = Math.floor(best / MAX_SURFACES);
    const dx = this.toWorld(cell % this.dim) - pos.x;
    const dz = this.toWorld(Math.floor(cell / this.dim)) - pos.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return into;
    return into.set(dx / len, 0, dz / len);
  }

  /** True when a field can reach the surface under `pos` at all. */
  reachable(field: FlowField, pos: Vector3): boolean {
    const s = this.surfaceAt(pos.x, pos.y, pos.z);
    return s >= 0 && field.dist[s] !== Infinity;
  }
}

/**
 * Height of a box's top face directly above `(x, z)`, or null when the point
 * is outside the box's footprint.
 *
 * Handles the pitched ramps: the top face is a plane, so the height varies
 * across the footprint instead of being a single number. That is the whole
 * reason this is analytic rather than an axis-aligned bounds lookup — a ramp's
 * bounding box would report its peak everywhere and read as a wall.
 */
function topFaceHeight(box: WorldBox, x: number, z: number): number | null {
  const local = toLocalXZ(box, x, z);
  if (!local) return null;
  const cx = Math.cos(box.rotX);
  if (Math.abs(cx) < 1e-4) return null;
  // The top face is a plane through local (0, h/2, 0) tilted by rotX. Writing
  // it against the *post*-rotation Z (which is what `toLocalXZ` returns) gives
  // a half-thickness of h/2/cos and a slope of tan — not h/2*cos and -tan,
  // which is the easy sign error here.
  return box.cy + box.h / 2 / cx - local.lz * (Math.sin(box.rotX) / cx);
}

/** The vertical slab a box occupies above `(x, z)`, or null outside it. */
function verticalSpan(
  box: WorldBox,
  x: number,
  z: number,
): { bottom: number; top: number } | null {
  const top = topFaceHeight(box, x, z);
  if (top === null) return null;
  // A slab tilted by theta is h/cos(theta) thick measured vertically.
  const cx = Math.max(Math.abs(Math.cos(box.rotX)), 1e-4);
  return { bottom: top - box.h / cx, top };
}

/**
 * Transforms a world XZ point into the box's local frame, returning null when
 * it falls outside the footprint. The Z extent grows with pitch, since a tilted
 * slab covers more ground than its depth.
 */
function toLocalXZ(
  box: WorldBox,
  x: number,
  z: number,
): { lx: number; lz: number } | null {
  const dx = x - box.cx;
  const dz = z - box.cz;
  const c = Math.cos(-box.rotY);
  const s = Math.sin(-box.rotY);
  const lx = dx * c + dz * s;
  const lz = -dx * s + dz * c;
  const halfD =
    (box.d / 2) * Math.abs(Math.cos(box.rotX)) +
    (box.h / 2) * Math.abs(Math.sin(box.rotX));
  if (Math.abs(lx) > box.w / 2 || Math.abs(lz) > halfD) return null;
  return { lx, lz };
}
