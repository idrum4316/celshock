/**
 * fingerprint.ts — A compact, comparable summary of a built world.
 * Owns: what "the same map" means when two processes build one and have to
 * agree. Read by `server/parity.ts` and by the browser half of
 * `scripts/check-world-parity.mjs`.
 * Invariants: pure — takes a `GameMap`, allocates a small object, touches
 * nothing. It must stay runnable in both a browser and a NullEngine process,
 * so no DOM and no rendering. Every field must be deterministic: anything
 * seeded from `Math.random()` or from frame timing would make two correct
 * builds disagree and turn this from a check into noise.
 *
 * It fingerprints the DERIVED structures, not the inputs. Comparing collider
 * counts would pass while every box sat a metre to the left; the nav graph is
 * downstream of every box's position, size and rotation, so a graph that
 * matches means the geometry did.
 */
import type { GameMap } from "./MapBuilder";

/** A stable, order-independent hash of a numeric array. */
function hashNumbers(values: ArrayLike<number>): string {
  // FNV-1a over the rounded values. Rounding matters: these are floats that
  // have been through a matrix or two, and the last bits of a double differ
  // between two arithmetically identical paths often enough to be useless as
  // an equality test. A millimetre is far finer than anything gameplay reads.
  let h = 0x811c9dc5;
  for (let i = 0; i < values.length; i++) {
    const v = Math.round(values[i] * 1000) | 0;
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** What two builds of the same map must agree on. */
export interface WorldFingerprint {
  boxes: number;
  /** Nav surfaces — a (cell, height) pair each, so this counts geometry. */
  surfaces: number;
  walkable: number;
  navDim: number;
  /** Hashes over the graph's own arrays. */
  heights: string;
  counts: string;
  walkableMask: string;
  links: string;
  /** Total collider volume, as a coarse independent cross-check. */
  volume: number;
}

export function worldFingerprint(map: GameMap): WorldFingerprint {
  const snap = map.nav.debugSnapshot();
  let volume = 0;
  for (const b of map.colliderBoxes) volume += b.w * b.h * b.d;

  return {
    boxes: map.colliderBoxes.length,
    surfaces: map.nav.surfaceCount,
    walkable: map.nav.walkableCount,
    navDim: snap.dim,
    heights: hashNumbers(snap.heights),
    counts: hashNumbers(snap.counts),
    walkableMask: hashNumbers(snap.walkable),
    links: hashNumbers(snap.links),
    volume: Math.round(volume * 1000) / 1000,
  };
}
