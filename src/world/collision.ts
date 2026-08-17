/**
 * collision.ts — The shape of a baked collider set, and how to expand one back
 * into `WorldBox`es.
 * Owns: the `MapCollision` type the generated `<map>/collision.ts` files are
 * written against, and the tuple→struct expansion the server rebuilds from.
 * Invariants: this file names no map. The generated modules are reached through
 * `MapDef.collision`, which is a LAZY import so the client never downloads a
 * chunk it has no use for — it builds the real thing. Nothing here runs in the
 * browser at all today; it exists so the multiplayer server and the bake script
 * agree on one format instead of two.
 *
 * Why the data exists: the server simulates under Babylon's NullEngine, which
 * has no canvas, so `DynamicTexture` throws and `MapBuilder` (which reaches one
 * through `floorMaterial`) cannot run there. It rebuilds the solid world from
 * these boxes instead. That is sound because `MapBuilder.collider()` is the one
 * place a collider is made and a `WorldBox` records everything
 * `MeshBuilder.CreateBox` needs to reproduce it — so both sides end up picking
 * against the same geometry with the same predicates from `solid.ts`, rather
 * than against two implementations that can drift. That includes `porous`,
 * which is a flag on the box and therefore part of the geometry: a server that
 * dropped it would rebuild a world whose fences stop rounds the client sent
 * through them.
 */
import type { WorldBox } from "./MapBuilder";

/**
 * One collider, as `[w, h, d, cx, cy, cz, rotX, rotY]`, plus a ninth entry on
 * the few that are `porous` (a fence: a wall to a body, air to a round).
 *
 * A tuple rather than an object because a map carries thousands of them and the
 * field names would be the same eight words repeated tens of thousands of times
 * in a generated file somebody has to review the diff of.
 *
 * The porous flag is OPTIONAL rather than a `0` on every row for the same
 * reason: it is true of a few dozen boxes out of hundreds, and writing it out
 * everywhere is a column of zeroes in a file that is reviewed as a diff. It
 * must nonetheless be baked — the server resolves every shot, so a fence it
 * thinks is solid is a fence that eats hits the shooter watched land.
 */
export type CollisionBox = readonly [
  w: number,
  h: number,
  d: number,
  cx: number,
  cy: number,
  cz: number,
  rotX: number,
  rotY: number,
  porous?: 0 | 1,
];

/** One map's baked collider set. Generated — see `scripts/bake-collision.mjs`. */
export interface MapCollision {
  /**
   * Hash over the map's `layout.ts` and `heights.ts` at the time of the bake.
   * `npm run build` refuses to proceed when it no longer matches, because a
   * stale bake is a server whose walls are somewhere else from its clients'.
   */
  sourceHash: string;
  boxes: readonly CollisionBox[];
  /**
   * The `strut` boxes — ray geometry with no body behind it — **grouped as the
   * client merged them**, one inner array per collider mesh.
   *
   * Separate from `boxes` because these are not the solid world: nothing
   * derived from geometry may see them (see `BoxSpec.rayOnly`), and `boxes` is
   * exactly the list `NavGrid`, `CoverMap` and `ObstacleField` are handed. The
   * grouping is baked rather than a flat list because the server merges each
   * group into one mesh the way the client does, and merging every fence on
   * the map into a single mesh would put one bounding box around the whole
   * village — every ray in the process would then pay for every fence's
   * triangles.
   */
  rayGroups: readonly (readonly CollisionBox[])[];
}

function toWorldBox([
  w,
  h,
  d,
  cx,
  cy,
  cz,
  rotX,
  rotY,
  porous,
]: CollisionBox): WorldBox {
  const box: WorldBox = { w, h, d, cx, cy, cz, rotX, rotY };
  // Only when set, so a rebuilt box is key-for-key what `MapBuilder.collider`
  // produced — `porous: undefined` and no key at all read the same to every
  // consumer, but only one of them is the same object.
  if (porous) box.porous = true;
  return box;
}

/** Expands a baked set into the `WorldBox`es `NavGrid` and friends consume. */
export function toWorldBoxes(collision: MapCollision): WorldBox[] {
  return collision.boxes.map(toWorldBox);
}

/** The ray-only geometry, still grouped by the mesh each group merges into. */
export function toRayGroups(collision: MapCollision): WorldBox[][] {
  return collision.rayGroups.map((group) => group.map(toWorldBox));
}
