/**
 * boxGeometry.ts — The analytic WorldBox primitives, and nothing else.
 * Owns: the box-frame transform, the top-face plane, the slab span, and the
 * XZ segment test. Pure functions, no Babylon, no state, no allocation beyond
 * the two small results that say so in their signature.
 *
 * Why this exists as a shared file rather than a helper in each caller: the
 * top-face plane is sign-sensitive and was written out independently in
 * `NavGrid.topFaceHeight` and `ObstacleField.push`, with the same warning
 * comment copy-pasted onto both. `CoverMap` needs it a third time, and cover
 * computed from different geometry than collision is how you get bots hiding
 * behind nothing. There is now exactly one site to get wrong.
 *
 * Invariants: half-thickness is h/2/cos(rotX) and the slope is tan(rotX) —
 * writing it as h/2*cos and -tan is the easy sign error and it silently makes
 * every ramp unwalkable. Every footprint here is `halfDepth`, never `d / 2`:
 * a pitched slab covers more ground than its depth, and the two only agree at
 * zero pitch.
 */
import type { WorldBox } from "./MapBuilder";

/**
 * Below this the box is pitched to (or past) vertical and its top face stops
 * being a function of position at all, so every query here refuses rather than
 * dividing by something near zero.
 */
const MIN_COS = 1e-4;

/**
 * Half-depth of the box's footprint in its own frame. A slab tilted by `rotX`
 * covers more ground than its depth, so the pitch grows this.
 */
export function halfDepth(box: WorldBox): number {
  return (
    (box.d / 2) * Math.abs(Math.cos(box.rotX)) +
    (box.h / 2) * Math.abs(Math.sin(box.rotX))
  );
}

/** Vertical thickness of the slab: a slab tilted by theta is h/cos(theta) thick. */
export function slabThickness(box: WorldBox): number {
  return box.h / Math.max(Math.abs(Math.cos(box.rotX)), MIN_COS);
}

/**
 * Height of the box's top face at `lz` — the *post*-rotation local Z of a point
 * in the box's own frame. Null for a box pitched to vertical.
 *
 * This is the one place the pitch math lives. The top face is a plane through
 * local (0, h/2, 0) tilted by `rotX`; written against the post-rotation Z that
 * gives a half-thickness of h/2/cos and a slope of tan. Not h/2*cos and -tan.
 *
 * It is analytic rather than an axis-aligned bounds lookup because a ramp's
 * bounding box reports its peak across the whole footprint and reads as a wall.
 */
export function topFaceAtLocalZ(box: WorldBox, lz: number): number | null {
  const cx = Math.cos(box.rotX);
  if (Math.abs(cx) < MIN_COS) return null;
  return box.cy + box.h / 2 / cx - lz * (Math.sin(box.rotX) / cx);
}

/**
 * Transforms a world XZ point into the box's local frame, returning null when
 * it falls outside the footprint.
 */
export function toLocalXZ(
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
  if (Math.abs(lx) > box.w / 2 || Math.abs(lz) > halfDepth(box)) return null;
  return { lx, lz };
}

/**
 * Height of the box's top face above `(x, z)` in world space, or null when that
 * is outside the box's footprint.
 */
export function topFaceHeight(box: WorldBox, x: number, z: number): number | null {
  const local = toLocalXZ(box, x, z);
  if (!local) return null;
  return topFaceAtLocalZ(box, local.lz);
}

/** The vertical slab a box occupies above `(x, z)`, or null outside it. */
export function verticalSpan(
  box: WorldBox,
  x: number,
  z: number,
): { bottom: number; top: number } | null {
  const top = topFaceHeight(box, x, z);
  if (top === null) return null;
  return { bottom: top - slabThickness(box), top };
}

/**
 * True when the XZ segment from (x0,z0) to (x1,z1) crosses the box's footprint.
 * Slab test in the box's own frame, so a rotated wall is handled without
 * inflating it to an AABB.
 *
 * The depth half-extent is `halfDepth`, so a PITCHED box is answered for
 * correctly too — it reduces to `d / 2` at zero pitch, so nothing that was
 * already passing flat boxes changes. This used to be `d / 2` outright, with a
 * contract line telling callers to exclude pitched boxes; `NavGrid.severLinks`
 * obeyed it by skipping every pitched box, which is how a stair's PARAPET —
 * pitched, because it rails a pitched flight — came to sever nothing at all.
 * A footprint test says where a box is, not whether it is a barrier; that
 * second question belongs to the caller, which is where it now lives.
 */
export function segmentHitsBox(
  box: WorldBox,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): boolean {
  const c = Math.cos(-box.rotY);
  const s = Math.sin(-box.rotY);
  const dx0 = x0 - box.cx;
  const dz0 = z0 - box.cz;
  const dx1 = x1 - box.cx;
  const dz1 = z1 - box.cz;
  const ax = dx0 * c + dz0 * s;
  const az = -dx0 * s + dz0 * c;
  const bx = dx1 * c + dz1 * s;
  const bz = -dx1 * s + dz1 * c;

  let t0 = 0;
  let t1 = 1;
  const half: [number, number] = [box.w / 2, halfDepth(box)];
  const from: [number, number] = [ax, az];
  const dir: [number, number] = [bx - ax, bz - az];
  for (let axis = 0; axis < 2; axis++) {
    const d = dir[axis];
    const p = from[axis];
    const h = half[axis];
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(p) > h) return false;
      continue;
    }
    let near = (-h - p) / d;
    let far = (h - p) / d;
    if (near > far) [near, far] = [far, near];
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
    if (t0 > t1) return false;
  }
  return true;
}
