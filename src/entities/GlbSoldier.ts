/**
 * GlbSoldier.ts — The player's body: the ONE imported asset in the game
 * (models/*.glb, added by explicit request). Owns locomotion clip playback
 * plus a procedural per-frame bone overlay (aim/reload/rifle carry) applied
 * after animations, and world-space rifle attachment.
 * Invariants: uses Matrix math throughout — the glTF root is mirrored, and
 * quaternion decomposition fails on mirrored nodes; do not "simplify" to
 * quaternions. Calibration matrices assume the stance was captured at yaw 0.
 * Do NOT extend the GLB approach to bots or weapons (they stay primitive;
 * SoldierModel's pooling/merging rules still apply to them), and do not add
 * further asset files unless explicitly asked.
 */
import {
  AnimationGroup,
  Matrix,
  Mesh,
  Quaternion,
  Scene,
  SceneLoader,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import type { PBRMaterial } from "@babylonjs/core";
import type { BaseTexture } from "@babylonjs/core";
import { CONFIG } from "../config";
import { addOutline, CelMaterialFactory } from "../shaders/CelShader";
import type { RifleParts } from "./RifleModel";
import glbUrl from "../../models/Meshy_AI_A_modern_soldier_with_biped_Meshy_AI_Meshy_Merged_Animations.glb?url";

/**
 * The imported player body: a rigged, textured GLB soldier that replaces the
 * primitive-built body in third person. Everything the procedural rig did by
 * posing TransformNode joints is reproduced here on the GLB joint nodes:
 *
 * - locomotion comes from the asset's own in-place Walking/Running clips,
 *   crossfaded and time-scaled by actual ground speed;
 * - aim pitch, the two-handed rifle carry, reload dip, jump slack and the
 *   idle stance are a procedural overlay applied to the joint nodes' local
 *   transforms every frame after the animation system has written them
 *   (`scene.onAfterAnimationsObservable`), so clips and overrides never
 *   fight. The glTF animations target plain TransformNodes (the skeleton's
 *   Bone objects sync from them in skeleton.prepare), so the overlay drives
 *   those same nodes directly — no bone-matrix dirty-flag games;
 * - the rifle is not parented into the joint hierarchy (the Armature's 0.01
 *   scale would shrink it); instead it is re-posed each frame from the right
 *   hand node's freshly computed world transform.
 *
 * Joints are aimed by world-space direction targets ("point the upper arm
 * down-forward"), which is robust against the asset's unknown joint-local
 * axes — no hand-authored local rotations anywhere.
 */

/** Per-frame inputs, mirrored from the values Player.animate already smooths. */
export interface SoldierPoseParams {
  /** Actual ground speed (m/s): config speed scaled by move input. */
  groundSpeed: number;
  /** Smoothed move-input magnitude 0..1. */
  moveBlend: number;
  /** Smoothed airborne weight 0..1. */
  airBlend: number;
  /** Smoothed reload weight 0..1. */
  reloadBlend: number;
  /** Camera aim pitch (rad, + up), recoil included. */
  aimPitch: number;
  /** Weapon punch 0..1 (weaponKickT squared). */
  kick: number;
  /** Free-running clock for the idle breath sway. */
  idleT: number;
}

// --- art constants for this specific asset ---------------------------------

/** Bind-pose height in model units, measured from the GLB's bounds. */
const MODEL_HEIGHT = 1.67;
/** Uniform scale that makes the asset fill the 1.8 m player capsule. */
const MODEL_SCALE = CONFIG.player.height / MODEL_HEIGHT;
/** Extra yaw so the model's authored facing matches the capsule's +Z. */
const FACE_YAW = 0;

/** Ground speeds (m/s) that pick the clip, with a hysteresis band between. */
const WALK_ENTER = 4.8;
const RUN_ENTER = 5.5;
/** Speeds at which each clip plays at speedRatio 1 (no foot-slide). */
const WALK_REF_SPEED = 4.4;
const RUN_REF_SPEED = CONFIG.player.moveSpeed;

/** Clip weight ramps in over this ground speed (below it the stance wins). */
const CLIP_FULL_SPEED = 2.5;

/**
 * Two-handed rifle carry, as world-space direction targets in character
 * space (+z forward, +x right, +y up): which way each arm segment points.
 * Tuned in the model viewer (see CLAUDE.md) against the asset's skeleton.
 */
const CARRY = {
  upperR: new Vector3(0.22, -0.72, 0.65),
  lowerR: new Vector3(-0.08, -0.2, 0.98),
  upperL: new Vector3(-0.15, -0.5, 0.85),
  lowerL: new Vector3(0.42, 0.08, 0.9),
};
/** How much of the aim pitch the arms inherit, so the rifle tracks the camera. */
const ARM_PITCH_FOLLOW = 0.85;
/** Extra downward tip for the left arm while reloading (drops to the mag). */
const RELOAD_ARM_DROP = 0.9;
/** Rifle tip-down while reloading, applied through the right arm. */
const RELOAD_RIFLE_DROP = 0.5;

/** Rifle offset in the right-hand joint's frame (position in metres). The
 * euler maps the hand's basis onto "barrel forward, top rail up"; measured
 * against the asset's carry pose in the model viewer. */
const RIFLE_OFFSET = {
  pos: new Vector3(0, -0.02, 0.02),
  euler: new Vector3(-1.268, 2.987, 2.405),
  scale: 0.85,
};
/** Distance from the rifle origin to the handguard hold (left-hand target). */
const HANDGUARD_FORWARD = 0.2;

/** Structural view over TransformNode for the world-chain walk. */
interface ChainNode {
  position: Vector3;
  scaling: Vector3;
  rotationQuaternion: Quaternion | null;
  rotation?: Vector3;
  parent: unknown;
  children?: unknown[];
}

const tmpM2 = new Matrix();
const tmpM3 = new Matrix();
const tmpM4 = new Matrix();
const tmpM5 = new Matrix();
const tmpQ1 = Quaternion.Identity();
const tmpQ2 = Quaternion.Identity();
const tmpQ3 = Quaternion.Identity();
/** Reserved for worldOf's euler fallback so it never clobbers a live temp. */
const tmpQEuler = Quaternion.Identity();
const tmpV1 = new Vector3();
const tmpV2 = new Vector3();
const tmpV3 = new Vector3();
const tmpScale = new Vector3();

/**
 * Babylon's glTF import converts handedness with a z-mirror on the "__root__"
 * node, so every joint/armature world matrix has a negative determinant and
 * decompose() cannot read its rotation as a quaternion. All overlay math
 * therefore composes in matrices (the reflection cancels in the conjugation
 * W·D·W⁻¹ and in the rifle's local), never in quaternions.
 */

/** Normalizes the rotation rows of a world matrix, keeping translation and
 * handedness: drops the armature's uniform 0.01 scale without decompose(). */
function orthonormalizeRows(m: Matrix): void {
  const a = m.m as unknown as Float32Array;
  for (let row = 0; row < 3; row++) {
    const i = row * 4;
    const len = Math.hypot(a[i], a[i + 1], a[i + 2]) || 1;
    a[i] /= len;
    a[i + 1] /= len;
    a[i + 2] /= len;
  }
}

export class GlbSoldier {
  /** Parent this under the player capsule; it carries scale/yaw/feet offset. */
  readonly root: TransformNode;
  /** Visible meshes (the skinned body) — Player toggles these in first person. */
  readonly meshes: Mesh[] = [];

  private readonly scene: Scene;
  /** The glTF "__root__" (rotation π about Y + z-mirror): the rifle parents
   * here so its local matrix keeps a positive determinant. */
  private gltfRoot: TransformNode | null = null;
  private walk: AnimationGroup | null = null;
  private run: AnimationGroup | null = null;
  private rifle: RifleParts | null = null;

  /** All joint nodes by name (the animation targets). */
  private readonly joints = new Map<string, TransformNode>();
  // Joints touched by the overlay.
  private hips: TransformNode | null = null;
  private spine: TransformNode | null = null;
  private spine1: TransformNode | null = null;
  private spine2: TransformNode | null = null;
  private head: TransformNode | null = null;
  private armR: TransformNode | null = null;
  private foreR: TransformNode | null = null;
  private handR: TransformNode | null = null;
  private armL: TransformNode | null = null;
  private foreL: TransformNode | null = null;
  private handL: TransformNode | null = null;

  /** Averaged mid-stride pose from the Walking clip, used as the idle stance. */
  private readonly stance = new Map<TransformNode, Quaternion>();
  private stanceHipsPos: Vector3 | null = null;
  /** Joint -> child joints, for memo invalidation after an override write. */
  private readonly children = new Map<unknown, TransformNode[]>();

  // Smoothed clip-mix state.
  private walkW = 0;
  private runW = 0;
  private band: "walk" | "run" = "walk";
  private idleW = 0;

  // Latest params from Player.animate; applied on the next render.
  private params: SoldierPoseParams = {
    groundSpeed: 0,
    moveBlend: 0,
    airBlend: 0,
    reloadBlend: 0,
    aimPitch: 0,
    kick: 0,
    idleT: 0,
  };

  /** Per-render world-matrix memo, seeded from the (refreshed) capsule. */
  private readonly worldMemo = new Map<unknown, Matrix>();

  private constructor(scene: Scene) {
    this.scene = scene;
    this.root = new TransformNode("glbSoldier", scene);
  }

  /** Loads the asset, re-materials it for the cel pipeline, starts the clips. */
  static async load(scene: Scene, mats: CelMaterialFactory): Promise<GlbSoldier> {
    const res = await SceneLoader.ImportMeshAsync("", glbUrl, "", scene);
    const rig = new GlbSoldier(scene);

    // Everything the loader made rootless hangs under the rig root, which
    // carries the capsule-relative scale, facing, and feet-on-ground offset.
    for (const n of [...res.meshes, ...res.transformNodes]) {
      if (!n.parent) n.parent = rig.root;
    }
    rig.root.scaling.setAll(MODEL_SCALE);
    rig.root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), FACE_YAW);
    rig.root.position.y = -CONFIG.player.height / 2;

    const skinned = res.meshes.find(
      (m): m is Mesh => m instanceof Mesh && !!m.skeleton,
    );
    if (!skinned) throw new Error("GlbSoldier: no skinned mesh in the GLB");

    // The glTF conversion root (mirrored) — the rifle's parent.
    rig.gltfRoot =
      (res.transformNodes.find((n) => n.name === "__root__") ?? null) ??
      ((skinned.parent?.parent ?? skinned.parent) as TransformNode | null);

    // Joint nodes: everything the animation groups target, plus their chain.
    for (const g of res.animationGroups) {
      for (const ta of g.targetedAnimations) {
        const node = ta.target as TransformNode;
        if (node?.name && !rig.joints.has(node.name)) {
          rig.joints.set(node.name, node);
        }
      }
    }

    // Swap the imported PBR material (black under a lightless scene) for the
    // skinned cel variant, keeping the albedo texture.
    const pbr = skinned.material as PBRMaterial;
    const tex: BaseTexture | null = pbr?.albedoTexture ?? null;
    if (tex) skinned.material = mats.getSkinned(tex);
    skinned.isPickable = false;
    // Bind-pose bounds don't track a walking skeleton; skip frustum culling.
    skinned.alwaysSelectAsActiveMesh = true;
    skinned.metadata = { ...(skinned.metadata ?? {}), noGlow: true };
    addOutline(skinned, 0.012);
    rig.meshes.push(skinned);

    const joint = (name: string) => rig.joints.get(name) ?? null;
    rig.hips = joint("Hips");
    rig.spine = joint("Spine");
    rig.spine1 = joint("Spine01");
    rig.spine2 = joint("Spine02");
    rig.head = joint("Head");
    rig.armR = joint("RightArm");
    rig.foreR = joint("RightForeArm");
    rig.handR = joint("RightHand");
    rig.armL = joint("LeftArm");
    rig.foreL = joint("LeftForeArm");
    rig.handL = joint("LeftHand");
    for (const node of rig.joints.values()) {
      const list = rig.children.get(node.parent) ?? [];
      list.push(node);
      rig.children.set(node.parent, list);
    }

    rig.walk = res.animationGroups.find((g) => g.name === "Walking") ?? null;
    rig.run = res.animationGroups.find((g) => g.name === "Running") ?? null;
    for (const g of [rig.walk, rig.run]) {
      if (!g) continue;
      g.start(true);
      g.setWeightForAllAnimatables(0);
    }
    rig.captureStance();

    // The overlay writes joint locals after the animation system, every render.
    scene.onAfterAnimationsObservable.add(() => rig.applyOverlay());
    return rig;
  }

  /** The rifle re-posed onto the right hand each frame from now on. */
  attachRifle(rifle: RifleParts): void {
    this.rifle = rifle;
    // Under the mirrored glTF root: the per-frame local matrix then has a
    // positive determinant (see followRifle), and Babylon flips winding for
    // the inherited reflection automatically.
    rifle.root.parent = this.gltfRoot ?? this.root;
    rifle.root.scaling.setAll(RIFLE_OFFSET.scale);
  }

  /** Called from Player.animate; the values land on the next rendered frame. */
  updatePose(p: SoldierPoseParams): void {
    this.params = p;
  }

  /** Verification/debug: current world position of a named joint. */
  debugBoneWorld(name: string): Vector3 | null {
    const j = this.joints.get(name);
    if (!j) return null;
    this.worldMemo.clear();
    const m = this.worldOf(j as unknown as ChainNode);
    return Vector3.TransformCoordinates(Vector3.Zero(), m);
  }

  /**
   * Averages the Walking clip's keys into a neutral mid-stride stance used
   * when no clip drives the joints (idle, airborne). Quaternions are summed
   * sign-aligned to the first key and normalised.
   */
  private captureStance(): void {
    if (!this.walk) return;
    const acc = new Map<TransformNode, { q: Quaternion; ref: Quaternion }>();
    let hipsPos = Vector3.Zero();
    let hipsN = 0;
    for (const ta of this.walk.targetedAnimations) {
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
        for (const k of keys) hipsPos.addInPlace(k.value as Vector3);
        hipsN += keys.length;
      }
    }
    for (const [j, e] of acc) {
      e.q.normalize();
      this.stance.set(j, e.q.clone());
    }
    if (hipsN > 0) this.stanceHipsPos = hipsPos.scale(1 / hipsN);
  }

  // --- per-render overlay ---------------------------------------------------

  private applyOverlay(): void {
    const dt = Math.min(this.scene.getEngine().getDeltaTime() / 1000, 0.05);
    const p = this.params;

    this.driveClips(dt, p);

    // Current-frame capsule transform: Player.update just wrote position/yaw
    // and the render loop hasn't recomputed matrices yet.
    const capsule = this.root.parent as ChainNode & {
      computeWorldMatrix?: (force?: boolean) => Matrix;
    } | null;
    this.worldMemo.clear();
    if (capsule?.computeWorldMatrix) {
      this.worldMemo.set(capsule, capsule.computeWorldMatrix(true));
    }

    // 1. Idle/airborne stance on the joints the clips own when moving.
    const stanceW = Math.max(this.idleW, p.airBlend * 0.55);
    if (stanceW > 0.001) {
      for (const [j, q] of this.stance) {
        if (j === this.armR || j === this.armL || j === this.foreR || j === this.foreL) continue;
        const cur = j.rotationQuaternion;
        if (!cur) continue;
        Quaternion.SlerpToRef(cur, q, stanceW, cur);
        this.invalidate(j);
      }
      if (this.hips && this.stanceHipsPos) {
        Vector3.LerpToRef(this.hips.position, this.stanceHipsPos, stanceW, this.hips.position);
        this.invalidate(this.hips);
      }
    }

    // 2. Aim pitch distributed over the spine (+ breath sway at idle), then head.
    const right = this.charRight();
    const breath = 0.02 * Math.sin(p.idleT * 2.1) * this.idleW;
    const pitch = -p.aimPitch;
    if (this.spine) this.worldDelta(this.spine, right, pitch * 0.1);
    if (this.spine1) this.worldDelta(this.spine1, right, pitch * 0.15);
    if (this.spine2) {
      this.worldDelta(
        this.spine2,
        right,
        pitch * 0.2 + breath + 0.22 * p.reloadBlend,
      );
    }
    if (this.head) this.worldDelta(this.head, right, pitch * 0.3);

    // 3. Two-handed rifle carry (full override of the clips' arm swing).
    this.poseArm(this.armR, this.foreR, CARRY.upperR, CARRY.lowerR, p);
    this.poseArm(this.armL, this.foreL, CARRY.upperL, CARRY.lowerL, p);

    // 3b. Pin the hand frames to the calibrated grip orientation, pitched
    // with the arms — otherwise clip twist rolls the rifle around. The
    // calibration is stored in character space so it follows the capsule yaw.
    const handAngle = -p.aimPitch * ARM_PITCH_FOLLOW + RELOAD_RIFLE_DROP * p.reloadBlend;
    const charRot = this.charRotationMatrix();
    this.pinHand(this.handR, "calR", handAngle, charRot);
    this.pinHand(this.handL, "calL", handAngle, charRot);

    // 4. Rifle follows the (final) right hand.
    this.followRifle(p);
  }

  /** Clip selection, crossfade, and playback speed from ground speed. */
  private driveClips(dt: number, p: SoldierPoseParams): void {
    const gs = p.groundSpeed;
    if (gs > RUN_ENTER) this.band = "run";
    else if (gs < WALK_ENTER) this.band = "walk";

    const clipW = Math.min(1, gs / CLIP_FULL_SPEED) * (1 - p.airBlend * 0.8);
    const walkTarget = this.band === "walk" ? clipW : 0;
    const runTarget = this.band === "run" ? clipW : 0;
    const ease = (cur: number, target: number, rate: number) =>
      cur + (target - cur) * Math.min(1, dt * rate);
    this.walkW = ease(this.walkW, walkTarget, 8);
    this.runW = ease(this.runW, runTarget, 8);
    this.idleW = ease(this.idleW, 1 - Math.min(1, gs / 1.2), 5);

    if (this.walk) {
      this.walk.setWeightForAllAnimatables(this.walkW);
      this.walk.speedRatio = Math.min(1.4, Math.max(0.5, gs / WALK_REF_SPEED));
    }
    if (this.run) {
      this.run.setWeightForAllAnimatables(this.runW);
      this.run.speedRatio = Math.min(1.8, Math.max(0.6, gs / RUN_REF_SPEED));
    }
  }

  /** Scratch for the constant lower-arm drop direction: handguardPoint
   * reuses the shared temps (tmpV1/tmpV2), so poseArm keeps its blend
   * target here across that call. */
  private readonly aimDrop = new Vector3();

  /**
   * Aims one two-joint arm at the carry directions, rotated by aim pitch so
   * the rifle tracks the camera; reload drops the support arm to the mag.
   */
  private poseArm(
    upper: TransformNode | null,
    lower: TransformNode | null,
    upperDir: Vector3,
    lowerDir: Vector3,
    p: SoldierPoseParams,
  ): void {
    if (!upper || !lower) return;
    const isLeft = upper === this.armL;
    const drop = isLeft
      ? RELOAD_ARM_DROP * p.reloadBlend
      : RELOAD_RIFLE_DROP * p.reloadBlend;
    const angle = -p.aimPitch * ARM_PITCH_FOLLOW + drop;
    const right = this.charRight();

    // The constants are authored in character space (+z forward, +x right,
    // +y up); map them through the capsule's yaw before applying the pitch.
    const fwd = this.charForward();
    const up = Vector3.UpReadOnly;
    const toWorld = (c: Vector3, out: Vector3) => {
      out.copyFrom(right).scaleInPlace(c.x);
      out.addInPlace(up.scale(c.y));
      out.addInPlace(fwd.scale(c.z));
      return out.normalize();
    };
    Quaternion.RotationAxisToRef(right, angle, tmpQ3);
    toWorld(upperDir, tmpV1).rotateByQuaternionToRef(tmpQ3, tmpV1).normalize();
    toWorld(lowerDir, tmpV2).rotateByQuaternionToRef(tmpQ3, tmpV2).normalize();

    this.aimJoint(upper, this.childJointOf(upper), tmpV1, 1);

    if (isLeft) {
      // Support hand holds the handguard: aim the forearm at the guard point
      // of this frame's rifle pose (right hand is already final). Blends
      // toward the constant drop direction while reloading. The guard lookup
      // clobbers the shared temps, so the drop direction is kept aside.
      this.aimDrop.copyFrom(tmpV2);
      const lowerChild = this.childJointOf(lower);
      if (lowerChild && p.reloadBlend < 0.999) {
        const guard = this.handguardPoint(p);
        if (guard) {
          const elbow = Vector3.TransformCoordinates(
            Vector3.Zero(),
            this.worldOf(lower as unknown as ChainNode),
          );
          tmpV3.copyFrom(guard).subtractInPlace(elbow);
          if (tmpV3.lengthSquared() > 1e-8) {
            tmpV3.normalize();
            Vector3.LerpToRef(tmpV3, this.aimDrop, p.reloadBlend, tmpV3);
            tmpV3.normalize();
            this.aimJoint(lower, lowerChild, tmpV3, 1);
            return;
          }
        }
      }
      this.aimJoint(lower, lowerChild, this.aimDrop, 1);
      return;
    }
    this.aimJoint(lower, this.childJointOf(lower), tmpV2, 1);
  }

  /** Scratch matrix for the rifle world target (not shared with other temps). */
  private readonly rifleM = new Matrix();
  /**
   * Calibrated hand-frame rotations (orthonormal world matrices) captured
   * from the first posed frame. Clips twist the hand joints as they swing;
   * pinning the hands to this frame (pitched with the arms) keeps the rifle
   * stable instead of inheriting clip twist.
   */
  private calR: Matrix | null = null;
  private calL: Matrix | null = null;

  /**
   * This frame's rifle world transform: the offset swung into the right
   * hand's (final, post-aim) frame. Shared by followRifle and the left arm.
   */
  private rifleWorldTarget(p: SoldierPoseParams): Matrix | null {
    if (!this.handR) return null;
    const r = CONFIG.recoil;
    const hw = tmpM5.copyFrom(this.worldOf(this.handR as unknown as ChainNode));
    orthonormalizeRows(hw);
    tmpV2.copyFrom(RIFLE_OFFSET.euler);
    tmpV2.x += -r.kickPitch * p.kick;
    Quaternion.FromEulerVectorToRef(tmpV2, tmpQ1);
    tmpV1.copyFrom(RIFLE_OFFSET.pos);
    tmpV1.z -= r.kickBack * p.kick;
    Matrix.ComposeToRef(tmpScale.setAll(RIFLE_OFFSET.scale), tmpQ1, tmpV1, tmpM3);
    tmpM3.multiplyToRef(hw, this.rifleM);
    return this.rifleM;
  }

  /** World position of the handguard hold, from the rifle target. */
  private handguardPoint(p: SoldierPoseParams): Vector3 | null {
    const m = this.rifleWorldTarget(p);
    if (!m) return null;
    const a = m.m;
    const len = Math.hypot(a[8], a[9], a[10]) || 1;
    return new Vector3(
      a[12] + (a[8] / len) * HANDGUARD_FORWARD,
      a[13] + (a[9] / len) * HANDGUARD_FORWARD,
      a[14] + (a[10] / len) * HANDGUARD_FORWARD,
    );
  }

  /**
   * Applies a world-space rotation D to a joint: the joint's world matrix
   * becomes L·W·D, so the new local is L·W·D·W⁻¹ (W = parent world). Done in
   * matrices because the glTF handedness mirror makes W undecomposable; the
   * reflection cancels, leaving a clean (det > 0) local rotation.
   */
  private applyWorldDelta(joint: TransformNode, delta: Matrix): void {
    const parent = joint.parent as ChainNode | null;
    if (!parent) return;
    const w = this.worldOf(parent);
    w.invertToRef(tmpM4);
    const q = joint.rotationQuaternion ?? Quaternion.Identity();
    Matrix.ComposeToRef(joint.scaling, q, joint.position, tmpM5);
    tmpM5.multiplyToRef(w, tmpM5);
    tmpM5.multiplyToRef(delta, tmpM5);
    tmpM5.multiplyToRef(tmpM4, tmpM5);
    if (!tmpM5.decompose(undefined, tmpQ1, undefined)) return;
    joint.rotationQuaternion = tmpQ1.clone();
    this.invalidate(joint);
  }

  /** Rotates a joint in world space, about `axis` by `angle`, on top of the
   * local rotation the animation system just wrote. */
  private worldDelta(joint: TransformNode, axis: Vector3, angle: number): void {
    if (Math.abs(angle) < 1e-5) return;
    Matrix.RotationAxisToRef(axis, angle, tmpM3);
    this.applyWorldDelta(joint, tmpM3);
  }

  /**
   * Points a joint at a world-space direction: rotates it so the line from
   * its origin to its child joint's origin matches `dirWorld`, by `weight`.
   */
  private aimJoint(
    joint: TransformNode,
    child: TransformNode | null,
    dirWorld: Vector3,
    weight: number,
  ): void {
    if (!child || weight <= 0) return;
    const bw = this.worldOf(joint as unknown as ChainNode);
    const cw = this.worldOf(child as unknown as ChainNode);
    const bPos = Vector3.TransformCoordinates(Vector3.Zero(), bw);
    const cPos = Vector3.TransformCoordinates(Vector3.Zero(), cw);
    tmpV3.copyFrom(cPos).subtractInPlace(bPos);
    if (tmpV3.lengthSquared() < 1e-10) return;
    tmpV3.normalize();
    Quaternion.FromUnitVectorsToRef(tmpV3, dirWorld, tmpQ1);
    Quaternion.SlerpToRef(Quaternion.Identity(), tmpQ1, weight, tmpQ1);
    Matrix.FromQuaternionToRef(tmpQ1, tmpM3);
    this.applyWorldDelta(joint, tmpM3);
  }

  /** Scratch: the capsule's world rotation as a matrix (rebuilt per render). */
  private readonly charRotM = new Matrix();

  /** The capsule's rotation (proper, det > 0) as a rotation matrix. */
  private charRotationMatrix(): Matrix {
    const w = this.worldOf(this.root as unknown as ChainNode);
    w.decompose(tmpScale, tmpQ1, tmpV3);
    return Matrix.FromQuaternionToRef(tmpQ1, this.charRotM);
  }

  /**
   * Rotates a hand joint so its world frame matches the calibrated grip
   * frame (stored in character space), pitched by the arm angle. Captures
   * the calibration from the first settled idle frame.
   */
  private pinHand(
    hand: TransformNode | null,
    slot: "calR" | "calL",
    angle: number,
    charRot: Matrix,
  ): void {
    if (!hand) return;
    const hw = tmpM5.copyFrom(this.worldOf(hand as unknown as ChainNode));
    orthonormalizeRows(hw);
    const ha = hw.m as unknown as Float32Array;
    ha[12] = 0;
    ha[13] = 0;
    ha[14] = 0;
    const cal = this[slot];
    if (!cal) {
      // Wait for a settled idle frame so the capture is the real carry
      // pose — the rifle offset was tuned against exactly this frame.
      if (this.idleW < 0.95) return;
      // calLocal = handWorld · charRot⁻¹  (character-space grip frame:
      // world = charSpace · charRot, so the inverse post-multiplies. The
      // pre-multiplied order only works when the capture happens at yaw 0;
      // any other capture yaw bakes a permanent twist into the rifle.)
      charRot.invertToRef(tmpM4);
      this[slot] = hw.multiply(tmpM4);
      return;
    }
    // desired = calLocal · charRot · pitch — world deltas post-multiply, so
    // the calibrated frame (and with it the rifle) rotates rigidly with the
    // capsule's yaw, then pitches about the character's right axis.
    Matrix.RotationAxisToRef(this.charRight(), angle, tmpM3);
    cal.multiplyToRef(charRot, tmpM2);
    tmpM2.multiplyToRef(tmpM3, tmpM2);
    // D takes the current hand frame to the desired one: H⁻¹·desired.
    hw.invertToRef(tmpM4);
    tmpM4.multiplyToRef(tmpM2, tmpM3);
    this.applyWorldDelta(hand, tmpM3);
  }

  /** Re-poses the rifle onto the right hand, with recoil/reload offsets. */
  private followRifle(p: SoldierPoseParams): void {
    if (!this.rifle || !this.gltfRoot) return;
    const target = this.rifleWorldTarget(p);
    if (!target) return;
    // To gltfRoot-local, where the inherited mirror cancels and the local
    // decomposes cleanly (positive determinant).
    this.worldOf(this.gltfRoot as unknown as ChainNode).invertToRef(tmpM4);
    target.multiplyToRef(tmpM4, tmpM3);
    if (!tmpM3.decompose(tmpScale, tmpQ2, tmpV3)) return;
    this.rifle.root.position.copyFrom(tmpV3);
    if (!this.rifle.root.rotationQuaternion) {
      this.rifle.root.rotationQuaternion = Quaternion.Identity();
    }
    this.rifle.root.rotationQuaternion.copyFrom(tmpQ2);
    this.rifle.root.scaling.copyFrom(tmpScale);
  }

  // --- world-chain helpers --------------------------------------------------

  /** Character right axis in world space (the capsule's, not the model's). */
  private charRight(): Vector3 {
    const w = this.worldOf(this.root as unknown as ChainNode);
    w.decompose(tmpScale, tmpQ1, tmpV3);
    return Vector3.TransformNormal(Vector3.Right(), Matrix.FromQuaternionToRef(tmpQ1, tmpM2)).normalize();
  }

  /** Character forward axis in world space (the capsule's facing). */
  private charForward(): Vector3 {
    const w = this.worldOf(this.root as unknown as ChainNode);
    w.decompose(tmpScale, tmpQ1, tmpV3);
    return Vector3.TransformNormal(Vector3.Forward(), Matrix.FromQuaternionToRef(tmpQ1, tmpM2)).normalize();
  }

  private childJointOf(joint: TransformNode): TransformNode | null {
    return this.children.get(joint)?.[0] ?? null;
  }

  /** Drops the memo for a joint and its descendants after an override write. */
  private invalidate(joint: TransformNode): void {
    this.worldMemo.delete(joint);
    for (const c of this.children.get(joint) ?? []) this.invalidate(c);
  }

  /**
   * Current-frame world matrix for any node between a joint and the capsule,
   * composed from live local TRS (post-animation, post-override) and memoized
   * per render. The capsule at the top is seeded refreshed.
   */
  private worldOf(n: ChainNode): Matrix {
    const hit = this.worldMemo.get(n);
    if (hit) return hit;
    const q =
      n.rotationQuaternion ??
      (n.rotation
        ? Quaternion.FromEulerVectorToRef(n.rotation, tmpQEuler)
        : Quaternion.Identity());
    const local = Matrix.ComposeToRef(n.scaling, q, n.position, new Matrix());
    const parent = n.parent as ChainNode | null;
    const world = parent ? local.multiply(this.worldOf(parent)) : local;
    this.worldMemo.set(n, world);
    return world;
  }
}
