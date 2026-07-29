/**
 * soldier/stance.ts — Derives the idle/airborne stance from the GLB's own
 * Walking clip: a neutral mid-stride pose used when no clip drives the
 * joints. Pure function, called once at load by GlbSoldier.
 */
import { AnimationGroup, Quaternion, TransformNode, Vector3 } from "@babylonjs/core";

export interface StanceData {
  /** Averaged mid-stride local rotation per joint. */
  joints: Map<TransformNode, Quaternion>;
  /** Averaged mid-stride hips position, or null if the clip lacks hips keys. */
  hipsPos: Vector3 | null;
}

/**
 * Averages the Walking clip's keys into a neutral mid-stride stance.
 * Quaternions are summed sign-aligned to the first key and normalised.
 */
export function captureStance(walk: AnimationGroup | null): StanceData {
  const joints = new Map<TransformNode, Quaternion>();
  let hipsPos: Vector3 | null = null;
  if (!walk) return { joints, hipsPos };

  const acc = new Map<TransformNode, { q: Quaternion; ref: Quaternion }>();
  let hipsSum = Vector3.Zero();
  let hipsN = 0;
  for (const ta of walk.targetedAnimations) {
    const target = ta.target as TransformNode;
    const keys = ta.animation.getKeys();
    if (!keys.length) continue;
    if (ta.animation.targetProperty === "rotationQuaternion") {
      const entry = acc.get(target) ?? {
        q: Quaternion.Zero(),
        ref: keys[0].value as Quaternion,
      };
      for (const k of keys) {
        const v = k.value as Quaternion;
        const sign = Quaternion.Dot(v, entry.ref) < 0 ? -1 : 1;
        entry.q.x += v.x * sign;
        entry.q.y += v.y * sign;
        entry.q.z += v.z * sign;
        entry.q.w += v.w * sign;
      }
      acc.set(target, entry);
    } else if (
      ta.animation.targetProperty === "position" &&
      target.name === "Hips"
    ) {
      for (const k of keys) hipsSum.addInPlace(k.value as Vector3);
      hipsN += keys.length;
    }
  }
  for (const [j, e] of acc) {
    e.q.normalize();
    joints.set(j, e.q.clone());
  }
  if (hipsN > 0) hipsPos = hipsSum.scale(1 / hipsN);
  return { joints, hipsPos };
}
