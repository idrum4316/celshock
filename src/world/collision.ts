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
 * against the same geometry with the same `SOLID_ONLY` predicate, rather than
 * against two implementations that can drift.
 */
import type { WorldBox } from "./MapBuilder";

/**
 * One collider, as `[w, h, d, cx, cy, cz, rotX, rotY]`.
 *
 * A tuple rather than an object because a map carries thousands of them and the
 * field names would be the same eight words repeated tens of thousands of times
 * in a generated file somebody has to review the diff of.
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
}

/** Expands a baked set into the `WorldBox`es `NavGrid` and friends consume. */
export function toWorldBoxes(collision: MapCollision): WorldBox[] {
  return collision.boxes.map(([w, h, d, cx, cy, cz, rotX, rotY]) => ({
    w,
    h,
    d,
    cx,
    cy,
    cz,
    rotX,
    rotY,
  }));
}
