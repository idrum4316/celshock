/**
 * CoverMap.ts — Baked directional cover over the nav graph, and nothing else.
 * Owns: two per-surface direction masks (hard = stops bullets, soft = steering
 * preference only) and the queries over them.
 * Invariants: built ONCE at map load from the finished collider set and the
 * finished NavGrid; read-only and allocation-free thereafter. NEVER raycasts —
 * that is the entire point (see the class comment). The hard-cover height is
 * the hit sphere's top, NOT the eye height: cover that hides a bot from LOS but
 * not from bullets is worse than no cover at all — and for that same reason a
 * `porous` box is not baked as cover of either kind. Soft cover is a hint about
 * where to walk and must never be treated as a safety claim.
 */
import { Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { segmentHitsBox } from "./boxGeometry";
import type { WorldBox } from "./MapBuilder";
import type { NavGrid } from "./NavGrid";

/**
 * Cover, as an answer to one question: *if the threat is over there, does this
 * spot have something between us?*
 *
 * ## Why this is baked
 *
 * The obvious implementation is the one `Bot.pickDetourSide` already gestures
 * at — probe a few candidate spots at runtime and raycast to check. It works,
 * and it is the wrong shape here. Evaluating a handful of candidates per cover
 * decision, at 16 bots and `thinkRate` 5, is hundreds of extra `pickWithRay`
 * calls a second against an LOS budget that currently runs at a couple per
 * frame. And the answer never changes: the map is static, which is the same
 * reasoning that makes `NavGrid` bake seven flow fields at load and recompute
 * nothing.
 *
 * So cover is a lookup. The runtime cost of every query below is a bit test.
 *
 * ## Why a direction mask and not a visibility matrix
 *
 * A full cell-to-cell visibility bake over a 160x160 grid is 25,600^2 entries
 * and is not happening. But a bot does not need to know whether it can see a
 * specific cell — it needs to know whether the *bearing* the threat lies on is
 * blocked. Sixteen directions at 22.5 degrees each answer that in one byte,
 * which over the whole graph is 150 KB per mask against `NavGrid`'s own ~2.9 MB.
 *
 * The cost of that compression is honest and worth stating: bearings quantise
 * to 22.5 degrees (about +/-3.9 m of lateral slop at 20 m), and the probe has a
 * fixed length, so cover only applies against threats *further away* than the
 * probe. Both failure modes are benign — the second one correctly refuses to
 * let a bot hide behind a wall from someone standing on the other side of it.
 *
 * ## Two masks
 *
 * `hard` is geometry tall enough to stop a round aimed at a standing body.
 * `soft` is anything above knee height. Soft cover exists *only* to bias
 * movement toward walls and away from open squares — the bot rig has seven
 * joints and no knees, so there is no crouch, and a bot behind a waist-high
 * wall is exactly as shootable as one standing in the open. Treating soft cover
 * as protection would be a lie the animation cannot tell.
 */

/**
 * Directions in the mask. Sixteen is the largest that still fits a `Uint16Array`
 * and keeps the bake under a handful of milliseconds; eight leaves 45-degree
 * bearing error, which is enough to have a bot hide behind the wrong wall.
 */
const COVER_DIRECTIONS = 16;
const DIR_STEP = (Math.PI * 2) / COVER_DIRECTIONS;

export class CoverMap {
  /** Blocks a shot at a standing body. One bit per direction, per surface. */
  private readonly hard: Uint16Array;
  /** Above knee height: a steering preference, never a safety claim. */
  private readonly soft: Uint16Array;

  private readonly dim: number;
  private readonly cellSize: number;
  private readonly origin: number;
  private readonly maxSurfaces: number;
  private readonly heights: Float32Array;
  private readonly counts: Uint8Array;
  private readonly walkable: Uint8Array;

  /**
   * Cell offsets to search for a cover spot, nearest first. Precomputed so
   * `findCover` is a walk over a flat list rather than a nested loop with a
   * distance sort in it.
   */
  private readonly ring: Int32Array;

  constructor(nav: NavGrid, boxes: WorldBox[]) {
    const snap = nav.debugSnapshot();
    this.dim = snap.dim;
    this.cellSize = snap.cellSize;
    this.origin = snap.origin;
    this.maxSurfaces = snap.maxSurfaces;
    this.heights = snap.heights;
    this.counts = snap.counts;
    this.walkable = snap.walkable;

    const surfaces = this.dim * this.dim * this.maxSurfaces;
    this.hard = new Uint16Array(surfaces);
    this.soft = new Uint16Array(surfaces);

    this.bake(boxes);
    this.ring = this.buildRing();
  }

  // --- construction --------------------------------------------------------

  /**
   * Box-driven rather than cell-driven: walk each collider once and mark the
   * cells around it. Cell-driven would ask "what is near me" 25,600 times and
   * need a spatial index to answer; this way the box's own footprint *is* the
   * index, which is the same trick `NavGrid.rasterize` uses.
   */
  private bake(boxes: WorldBox[]): void {
    const c = CONFIG.bots.cover;
    const probe = c.probeDistance;
    const dirX = new Float64Array(COVER_DIRECTIONS);
    const dirZ = new Float64Array(COVER_DIRECTIONS);
    for (let d = 0; d < COVER_DIRECTIONS; d++) {
      dirX[d] = Math.sin(d * DIR_STEP);
      dirZ[d] = Math.cos(d * DIR_STEP);
    }

    for (const box of boxes) {
      // Same exclusions as the nav grid and the obstacle field: the ground
      // plane and the boundary ridge are not cover.
      if (box.w > 200 || box.d > 200) continue;
      // A porous box stops a body and nothing else, so it is not cover of
      // either kind. Not `hard` for the reason at the top of this file — cover
      // that hides a bot from LOS but not from bullets is worse than no cover
      // at all, and this one does not even hide it. Not `soft` either: soft
      // exists to bias movement toward walls and away from open ground, and a
      // fence line IS open ground with a rail across it.
      //
      // A pane's collider is `porous` too and is caught by the same line, which is
      // what makes glass need no term of its own here — and it wants the
      // exclusion twice over: it hides a bot from nothing because it is
      // transparent, and the round that finds them takes it away.
      if (box.porous) continue;
      // Pitched boxes are skipped here for a reason of this file's own, not
      // `segmentHitsBox`'s (which handles them): the `top`/`bottom` below are
      // the box's AABB, and a ramp's peak reported across its whole footprint
      // would read as chest-high cover standing at its foot. Cover from a
      // pitched box would have to be measured off the plane, one bearing at a
      // time, and nothing has needed it.
      if (Math.abs(box.rotX) > 1e-3) continue;

      const top = box.cy + box.h / 2;
      const bottom = box.cy - box.h / 2;

      const reach = Math.hypot(box.w, box.d) / 2 + probe;
      const minX = this.clampCell(this.toCell(box.cx - reach));
      const maxX = this.clampCell(this.toCell(box.cx + reach));
      const minZ = this.clampCell(this.toCell(box.cz - reach));
      const maxZ = this.clampCell(this.toCell(box.cz + reach));

      for (let cz = minZ; cz <= maxZ; cz++) {
        for (let cx = minX; cx <= maxX; cx++) {
          const cell = cz * this.dim + cx;
          const wx = this.toWorld(cx);
          const wz = this.toWorld(cz);
          const n = this.counts[cell];
          for (let s = 0; s < n; s++) {
            const surface = cell * this.maxSurfaces + s;
            if (!this.walkable[surface]) continue;
            const standing = this.heights[surface];
            // A box only covers a body if it brackets the relevant height:
            // tall enough to reach it, and footed low enough not to be a
            // lintel the round passes under.
            if (bottom > standing + c.footTolerance) continue;
            const hard = top >= standing + c.hardHeight;
            const soft = top >= standing + c.softHeight;
            if (!soft) continue;

            for (let d = 0; d < COVER_DIRECTIONS; d++) {
              const bit = 1 << d;
              // Nothing to learn if both masks already know about this bearing.
              if (this.soft[surface] & bit && (!hard || this.hard[surface] & bit)) {
                continue;
              }
              if (
                !segmentHitsBox(
                  box,
                  wx,
                  wz,
                  wx + dirX[d] * probe,
                  wz + dirZ[d] * probe,
                )
              ) {
                continue;
              }
              this.soft[surface] |= bit;
              if (hard) this.hard[surface] |= bit;
            }
          }
        }
      }
    }
  }

  /** Cell offsets within `searchRadius`, nearest first. Built once. */
  private buildRing(): Int32Array {
    const reach = Math.ceil(CONFIG.bots.cover.searchRadius / this.cellSize);
    const entries: { dx: number; dz: number; d2: number }[] = [];
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > reach * reach) continue;
        entries.push({ dx, dz, d2 });
      }
    }
    entries.sort((a, b) => a.d2 - b.d2);
    const out = new Int32Array(entries.length * 2);
    for (let i = 0; i < entries.length; i++) {
      out[i * 2] = entries[i].dx;
      out[i * 2 + 1] = entries[i].dz;
    }
    return out;
  }

  // --- queries -------------------------------------------------------------

  /**
   * Does `surface` have hard cover against a threat at `(tx, tz)`?
   *
   * The bearing is *toward* the threat: cover is between the two, so the mask
   * bit that matters is the one pointing at the shooter.
   */
  coverAt(surface: number, x: number, z: number, tx: number, tz: number): boolean {
    if (surface < 0) return false;
    return (this.hard[surface] & this.bitToward(x, z, tx, tz)) !== 0;
  }

  /** Same, for the knee-height mask. Steering only — never a safety claim. */
  softCoverAt(surface: number, x: number, z: number, tx: number, tz: number): boolean {
    if (surface < 0) return false;
    return (this.soft[surface] & this.bitToward(x, z, tx, tz)) !== 0;
  }

  /**
   * How exposed a surface is, 0 (walled in) to 1 (open ground). The popcount of
   * the unset hard bits — free, and exactly the term that biases a bot away
   * from the middle of the square.
   */
  opennessAt(surface: number): number {
    if (surface < 0) return 1;
    let bits = ~this.hard[surface] & 0xffff;
    let n = 0;
    while (bits) {
      bits &= bits - 1;
      n++;
    }
    return n / COVER_DIRECTIONS;
  }

  /**
   * The best nearby spot with hard cover from `(tx, tz)`, written into `into`.
   *
   * Walks the precomputed ring nearest-first and takes the first surface that
   * is walkable, covered from the threat, and not *closer* to the threat than
   * where the bot already is — running toward the shooter to reach a wall is
   * worse than staying put. Returns false when there is nothing better.
   */
  findCover(
    from: Vector3,
    tx: number,
    tz: number,
    into: Vector3,
  ): boolean {
    const cx = this.clampCell(this.toCell(from.x));
    const cz = this.clampCell(this.toCell(from.z));
    const here2 = (from.x - tx) ** 2 + (from.z - tz) ** 2;

    for (let i = 0; i < this.ring.length; i += 2) {
      const gx = cx + this.ring[i];
      const gz = cz + this.ring[i + 1];
      if (gx < 0 || gz < 0 || gx >= this.dim || gz >= this.dim) continue;
      const cell = gz * this.dim + gx;
      const wx = this.toWorld(gx);
      const wz = this.toWorld(gz);
      // Never break contact by charging the shooter.
      if ((wx - tx) ** 2 + (wz - tz) ** 2 < here2 * 0.64) continue;

      const n = this.counts[cell];
      for (let s = 0; s < n; s++) {
        const surface = cell * this.maxSurfaces + s;
        if (!this.walkable[surface]) continue;
        // Only spots the bot could actually walk onto from where it stands.
        if (Math.abs(this.heights[surface] - from.y) > CONFIG.nav.stepHeight) {
          continue;
        }
        if (!this.coverAt(surface, wx, wz, tx, tz)) continue;
        into.set(wx, this.heights[surface], wz);
        return true;
      }
    }
    return false;
  }

  // --- internals -----------------------------------------------------------

  /** The mask bit for the bearing from `(x, z)` toward `(tx, tz)`. */
  private bitToward(x: number, z: number, tx: number, tz: number): number {
    const a = Math.atan2(tx - x, tz - z);
    let d = Math.round(a / DIR_STEP) % COVER_DIRECTIONS;
    if (d < 0) d += COVER_DIRECTIONS;
    return 1 << d;
  }

  private toCell(world: number): number {
    return Math.floor((world - this.origin) / this.cellSize);
  }

  private toWorld(cell: number): number {
    return this.origin + (cell + 0.5) * this.cellSize;
  }

  private clampCell(cell: number): number {
    return cell < 0 ? 0 : cell >= this.dim ? this.dim - 1 : cell;
  }
}
