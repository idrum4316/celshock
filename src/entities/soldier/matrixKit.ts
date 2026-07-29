/**
 * soldier/matrixKit.ts — The matrix machinery GlbSoldier's overlay is built
 * on: the ChainNode structural view, orthonormalizeRows, and WorldChain
 * (per-render world-matrix memo + child registry + invalidation).
 *
 * WHY MATRICES, NEVER QUATERNIONS: Babylon's glTF import converts handedness
 * with a z-mirror on the "__root__" node, so every joint/armature world
 * matrix has a negative determinant and decompose() cannot read its rotation
 * as a quaternion. All overlay math composes in matrices (the reflection
 * cancels in the conjugation W·D·W⁻¹ and in the rifle's local). Do not
 * "simplify" any of this to quaternions.
 */
import { Matrix, Quaternion, TransformNode, Vector3 } from "@babylonjs/core";

/** Structural view over TransformNode for the world-chain walk. */
export interface ChainNode {
  position: Vector3;
  scaling: Vector3;
  rotationQuaternion: Quaternion | null;
  rotation?: Vector3;
  parent: unknown;
  children?: unknown[];
}

/** Normalizes the rotation rows of a world matrix, keeping translation and
 * handedness: drops the armature's uniform 0.01 scale without decompose(). */
export function orthonormalizeRows(m: Matrix): void {
  const a = m.m as unknown as Float32Array;
  for (let row = 0; row < 3; row++) {
    const i = row * 4;
    const len = Math.hypot(a[i], a[i + 1], a[i + 2]) || 1;
    a[i] /= len;
    a[i + 1] /= len;
    a[i + 2] /= len;
  }
}

/** Reserved for worldOf's euler fallback so it never clobbers a live temp. */
const tmpQEuler = Quaternion.Identity();

/**
 * Current-frame world matrices for nodes between a joint and the capsule,
 * composed from live local TRS (post-animation, post-override) and memoized
 * per render. The capsule at the top is seeded refreshed each frame.
 *
 * Usage contract: clear() once per render, seed() the freshly computed
 * capsule matrix, then worldOf() freely. After any override write to a
 * joint's local TRS, invalidate() that joint so descendants recompose.
 */
export class WorldChain {
  private readonly memo = new Map<unknown, Matrix>();
  /** Joint -> child joints, for memo invalidation after an override write. */
  private readonly children = new Map<unknown, TransformNode[]>();

  /** Register a joint so invalidate() reaches its descendants. */
  register(node: TransformNode): void {
    const list = this.children.get(node.parent) ?? [];
    list.push(node);
    this.children.set(node.parent, list);
  }

  clear(): void {
    this.memo.clear();
  }

  /** Seed a node's already-computed world matrix (the refreshed capsule). */
  seed(node: unknown, m: Matrix): void {
    this.memo.set(node, m);
  }

  childOf(joint: TransformNode): TransformNode | null {
    return this.children.get(joint)?.[0] ?? null;
  }

  /** Drops the memo for a joint and its descendants after an override write. */
  invalidate(joint: TransformNode): void {
    this.memo.delete(joint);
    for (const c of this.children.get(joint) ?? []) this.invalidate(c);
  }

  worldOf(n: ChainNode): Matrix {
    const hit = this.memo.get(n);
    if (hit) return hit;
    const q =
      n.rotationQuaternion ??
      (n.rotation
        ? Quaternion.FromEulerVectorToRef(n.rotation, tmpQEuler)
        : Quaternion.Identity());
    const local = Matrix.ComposeToRef(n.scaling, q, n.position, new Matrix());
    const parent = n.parent as ChainNode | null;
    const world = parent ? local.multiply(this.worldOf(parent)) : local;
    this.memo.set(n, world);
    return world;
  }
}
