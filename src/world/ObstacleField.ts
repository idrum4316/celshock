import { Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import type { WorldBox } from "./MapBuilder";

/**
 * "Is there a body's width of space here?", answered against the collider boxes
 * themselves rather than the nav grid.
 *
 * ## Why the nav grid isn't enough
 *
 * `NavGrid` samples one column per 1.5 m cell *centre*. A collider narrower than
 * a cell can sit entirely between two centres and leave every cell around it
 * walkable — and most of Hollowmere's props are exactly that: a scattered dead
 * tree or gravestone gets a 1.1 m collider, a fire drum 1.2 m. Flow fields then
 * route bots straight through the trunk. Even for the buildings the grid only
 * knows about walls that happen to cross a cell centre, so a bot can stand with
 * half its body inside a cottage wall.
 *
 * That is not just a visual glitch. `CombatSystem.fire` caps every shot at the
 * first `solid` hit and only counts a target sphere *closer* than that, so a bot
 * embedded in a prop has the prop soaking up every round aimed at it — the
 * "bots are stuck in things and impossible to shoot" pair is one bug.
 *
 * ## How
 *
 * Box footprints are bucketed once at load. A query pulls the handful of boxes
 * over one spot and pushes the body back out to `CONFIG.nav.bodyRadius` of any
 * face that is too tall to step onto and too low to duck under. Height is
 * evaluated from the top-face *plane* at the contact point, the same way
 * `NavGrid` does it, so a ramp reads as a floor at its foot rather than a wall.
 *
 * The map never changes, so the buckets are built once and then only read.
 */

/** Bucket edge in metres. Comfortably larger than any query radius. */
const BUCKET = 4;
/** Query radii are expanded by this when bucketing, so a query hits one bucket. */
const MAX_RADIUS = 1.0;
/** Vertical clearance a body needs; matches `NavGrid`'s headroom. */
const HEADROOM = 1.7;

export class ObstacleField {
  private readonly dim: number;
  private readonly origin: number;
  /** Box indices per bucket, `null` where nothing overlaps. */
  private readonly buckets: (number[] | null)[];
  private readonly boxes: WorldBox[] = [];

  constructor(size: number, boxes: WorldBox[]) {
    this.dim = Math.ceil(size / BUCKET) + 2;
    this.origin = -size / 2 - BUCKET;
    this.buckets = new Array(this.dim * this.dim).fill(null);

    for (const box of boxes) {
      // Same exclusions as the nav grid: the ground plane is the floor and the
      // ridge is pure boundary, which the grid's own extents already enforce.
      if (box.w > 200 || box.d > 200) continue;
      const index = this.boxes.push(box) - 1;

      // Conservative footprint: the rotated half-diagonal, plus the query slack.
      const reach =
        Math.hypot(box.w, box.d) / 2 +
        (box.h / 2) * Math.abs(Math.sin(box.rotX)) +
        MAX_RADIUS;
      const minX = this.clampCell(this.toCell(box.cx - reach));
      const maxX = this.clampCell(this.toCell(box.cx + reach));
      const minZ = this.clampCell(this.toCell(box.cz - reach));
      const maxZ = this.clampCell(this.toCell(box.cz + reach));
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const cell = cz * this.dim + cx;
          (this.buckets[cell] ??= []).push(index);
        }
      }
    }
  }

  /**
   * Pushes a body standing at `(x, y, z)` out of anything it overlaps, writing
   * the corrected position into `out` (`y` is passed through untouched) and
   * returning true when it had to move at all.
   *
   * Boxes are resolved in sequence against the running position and the whole
   * set is swept twice, so an inside corner settles instead of ping-ponging
   * between its two walls.
   */
  resolve(x: number, y: number, z: number, radius: number, out: Vector3): boolean {
    out.set(x, y, z);
    const cx = this.clampCell(this.toCell(x));
    const cz = this.clampCell(this.toCell(z));
    const bucket = this.buckets[cz * this.dim + cx];
    if (!bucket) return false;

    let moved = false;
    for (let pass = 0; pass < 2; pass++) {
      let touched = false;
      for (const index of bucket) {
        if (this.push(this.boxes[index], y, radius, out)) touched = true;
      }
      if (!touched) break;
      moved = true;
    }
    return moved;
  }

  /** One box against one body. Returns true when `out` was corrected. */
  private push(box: WorldBox, y: number, radius: number, out: Vector3): boolean {
    const cos = Math.cos(box.rotX);
    if (Math.abs(cos) < 1e-4) return false;

    // Into the box's frame. The Z extent grows with pitch: a tilted slab covers
    // more ground than its depth.
    const c = Math.cos(-box.rotY);
    const s = Math.sin(-box.rotY);
    const dx = out.x - box.cx;
    const dz = out.z - box.cz;
    const lx = dx * c + dz * s;
    const lz = -dx * s + dz * c;
    const hw = box.w / 2;
    const hd =
      (box.d / 2) * Math.abs(cos) + (box.h / 2) * Math.abs(Math.sin(box.rotX));

    const qx = clamp(lx, -hw, hw);
    const qz = clamp(lz, -hd, hd);

    // Height of the top face at the contact point, from the plane rather than
    // the bounding box — a ramp's peak must not be reported across its whole
    // footprint. Half-thickness is h/2/cos and the slope is tan; writing it as
    // h/2*cos and -tan is the easy sign error, and it makes ramps into walls.
    const top = box.cy + box.h / 2 / cos - qz * (Math.sin(box.rotX) / cos);
    // Low enough to step onto, so it is floor rather than obstruction.
    if (top <= y + CONFIG.nav.stepHeight) return false;
    // High enough to walk under: a lintel, a hayloft, a bridge deck.
    if (top - box.h / Math.abs(cos) >= y + HEADROOM) return false;

    let nx: number;
    let nz: number;
    if (lx > -hw && lx < hw && lz > -hd && lz < hd) {
      // Already inside. Leave by the nearest face, since any other exit would
      // drag the body through the whole box.
      const penX = hw - Math.abs(lx);
      const penZ = hd - Math.abs(lz);
      if (penX < penZ) {
        nx = (lx < 0 ? -1 : 1) * (hw + radius);
        nz = lz;
      } else {
        nx = lx;
        nz = (lz < 0 ? -1 : 1) * (hd + radius);
      }
    } else {
      const ox = lx - qx;
      const oz = lz - qz;
      const dist = Math.hypot(ox, oz);
      if (dist >= radius) return false;
      if (dist < 1e-6) {
        // Exactly on a face. Push straight out of the nearer one.
        if (hw - Math.abs(lx) < hd - Math.abs(lz)) {
          nx = (lx < 0 ? -1 : 1) * (hw + radius);
          nz = lz;
        } else {
          nx = lx;
          nz = (lz < 0 ? -1 : 1) * (hd + radius);
        }
      } else {
        nx = qx + (ox / dist) * radius;
        nz = qz + (oz / dist) * radius;
      }
    }

    // Back to world. `-rotY` was used above, so the inverse is `+rotY`.
    out.x = box.cx + nx * c - nz * s;
    out.z = box.cz + nx * s + nz * c;
    return true;
  }

  private toCell(world: number): number {
    return Math.floor((world - this.origin) / BUCKET);
  }

  private clampCell(cell: number): number {
    return cell < 0 ? 0 : cell >= this.dim ? this.dim - 1 : cell;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
