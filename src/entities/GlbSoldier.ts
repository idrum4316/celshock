/**
 * GlbSoldier.ts — The player's body: the ONE imported asset in the game
 * (models/*.glb, added by explicit request). Owns asset loading/material
 * swap and the procedural per-frame bone overlay (stance, aim pitch,
 * lower/upper-body strafe split, velocity lean, jump tuck, two-handed rifle
 * carry, phased reload, rifle follow) applied after animations.
 * Split across soldier/: tuning.ts (constants + SoldierPoseParams),
 * matrixKit.ts (WorldChain + why-matrices rationale), stance.ts (idle pose),
 * clipDriver.ts (locomotion clips). The overlay pipeline below stays in one
 * file deliberately — its methods share matrix temp registers, and splitting
 * them risks clobbering a live temp.
 * Invariants: uses Matrix math throughout — the glTF root is mirrored, and
 * quaternion decomposition fails on mirrored nodes; do not "simplify" to
 * quaternions. Calibration matrices assume the stance was captured at yaw 0.
 * Do NOT extend the GLB approach to bots or weapons (they stay primitive;
 * SoldierModel's pooling/merging rules still apply to them), and do not add
 * further asset files unless explicitly asked.
 */
import {
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
import type { WeaponParts } from "./weaponKit";
import glbUrl from "../../models/Meshy_AI_A_modern_soldier_with_biped_Meshy_AI_Meshy_Merged_Animations.glb?url";
import {
  AIR_BASE_KNEE,
  AIR_BASE_THIGH,
  AIR_REACH_KNEE,
  AIR_REACH_THIGH,
  AIR_TUCK_KNEE,
  AIR_TUCK_THIGH,
  ARM_PITCH_FOLLOW,
  BACKPEDAL_LEAN,
  CARRY,
  FACE_YAW,
  HANDGUARD_FORWARD,
  HEAD_GLANCE,
  HIP_YAW_COUNTER,
  HIP_YAW_MAX,
  MAG_DOWN,
  MAG_FORWARD,
  MODEL_SCALE,
  RELOAD_ARM_DROP,
  RELOAD_MAG_IN,
  RELOAD_MAG_OUT,
  RELOAD_RIFLE_DROP,
  RELOAD_SEAT,
  RIFLE_OFFSET,
  SPRINT_LEAN,
  STRAFE_ROLL,
  TURN_SWAY,
  TURN_SWAY_MAX,
  type SoldierPoseParams,
} from "./soldier/tuning";
import { WorldChain, orthonormalizeRows, type ChainNode } from "./soldier/matrixKit";
import { captureStance } from "./soldier/stance";
import { ClipDriver } from "./soldier/clipDriver";

export type { SoldierPoseParams };

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

const tmpM2 = new Matrix();
const tmpM3 = new Matrix();
const tmpM4 = new Matrix();
const tmpM5 = new Matrix();
const tmpQ1 = Quaternion.Identity();
const tmpQ2 = Quaternion.Identity();
const tmpQ3 = Quaternion.Identity();
const tmpV1 = new Vector3();
const tmpV2 = new Vector3();
const tmpV3 = new Vector3();
const tmpScale = new Vector3();

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export class GlbSoldier {
  /** Parent this under the player capsule; it carries scale/yaw/feet offset. */
  readonly root: TransformNode;
  /** Visible meshes (the skinned body) — Player toggles these in first person. */
  readonly meshes: Mesh[] = [];

  private readonly scene: Scene;
  /** The glTF "__root__" (rotation π about Y + z-mirror): the rifle parents
   * here so its local matrix keeps a positive determinant. */
  private gltfRoot: TransformNode | null = null;
  private clips: ClipDriver | null = null;
  private rifle: WeaponParts | null = null;

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
  // Leg joints: owned by the clips on the ground, posed procedurally in air.
  private upLegL: TransformNode | null = null;
  private upLegR: TransformNode | null = null;
  private legL: TransformNode | null = null;
  private legR: TransformNode | null = null;

  /** Averaged mid-stride pose from the Walking clip, used as the idle stance. */
  private readonly stance = new Map<TransformNode, Quaternion>();
  private stanceHipsPos: Vector3 | null = null;

  // Latest params from Player.animate; applied on the next render.
  private params: SoldierPoseParams = {
    groundSpeed: 0,
    moveBlend: 0,
    airBlend: 0,
    reloadBlend: 0,
    aimPitch: 0,
    kick: 0,
    idleT: 0,
    localVelX: 0,
    localVelZ: 0,
    velY: 0,
    reloadPhase: 1,
    sprintBlend: 0,
    turnRate: 0,
  };

  /** Smoothed hips yaw for the lower/upper-body strafe split (rad). */
  private hipsYaw = 0;

  /** Per-render world-matrix memo + child registry (see matrixKit). */
  private readonly chain = new WorldChain();

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
    rig.upLegL = joint("LeftUpLeg");
    rig.upLegR = joint("RightUpLeg");
    rig.legL = joint("LeftLeg");
    rig.legR = joint("RightLeg");
    for (const node of rig.joints.values()) {
      rig.chain.register(node);
    }

    const walk = res.animationGroups.find((g) => g.name === "Walking") ?? null;
    const run = res.animationGroups.find((g) => g.name === "Running") ?? null;
    for (const g of [walk, run]) {
      if (!g) continue;
      g.start(true);
      g.setWeightForAllAnimatables(0);
    }
    rig.clips = new ClipDriver(walk, run);
    const stance = captureStance(walk);
    for (const [j, q] of stance.joints) rig.stance.set(j, q);
    rig.stanceHipsPos = stance.hipsPos;

    // The overlay writes joint locals after the animation system, every render.
    scene.onAfterAnimationsObservable.add(() => rig.applyOverlay());
    return rig;
  }

  /** The rifle re-posed onto the right hand each frame from now on. */
  attachRifle(rifle: WeaponParts): void {
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
    this.chain.clear();
    const m = this.chain.worldOf(j as unknown as ChainNode);
    return Vector3.TransformCoordinates(Vector3.Zero(), m);
  }

  // --- per-render overlay ---------------------------------------------------

  private applyOverlay(): void {
    const dt = Math.min(this.scene.getEngine().getDeltaTime() / 1000, 0.05);
    const p = this.params;

    this.clips?.update(dt, p.groundSpeed, p.localVelZ, p.airBlend);
    const idleW = this.clips?.idleW ?? 1;
    const moveW = 1 - idleW;

    // Current-frame capsule transform: Player.update just wrote position/yaw
    // and the render loop hasn't recomputed matrices yet.
    const capsule = this.root.parent as ChainNode & {
      computeWorldMatrix?: (force?: boolean) => Matrix;
    } | null;
    this.chain.clear();
    if (capsule?.computeWorldMatrix) {
      this.chain.seed(capsule, capsule.computeWorldMatrix(true));
    }

    // 1. Idle/airborne stance on the joints the clips own when moving. The
    // airborne weight is FULL: the air pose below owns the legs outright.
    const stanceW = Math.max(idleW, p.airBlend);
    if (stanceW > 0.001) {
      for (const [j, q] of this.stance) {
        if (j === this.armR || j === this.armL || j === this.foreR || j === this.foreL) continue;
        const cur = j.rotationQuaternion;
        if (!cur) continue;
        Quaternion.SlerpToRef(cur, q, stanceW, cur);
        this.chain.invalidate(j);
      }
      if (this.hips && this.stanceHipsPos) {
        Vector3.LerpToRef(this.hips.position, this.stanceHipsPos, stanceW, this.hips.position);
        this.chain.invalidate(this.hips);
      }
    }

    // 1b. Idle weight shift: a slow hip sway so standing still isn't a statue.
    if (this.hips && this.stanceHipsPos && idleW > 0.01) {
      this.hips.position.x +=
        this.stanceHipsPos.y * 0.02 * Math.sin(p.idleT * 0.45) * idleW;
      this.chain.invalidate(this.hips);
    }

    // 1c. Lower/upper-body split: hips yaw toward the velocity direction
    // (clamped) so a strafe walks sideways instead of gliding; the spine
    // counter-rotates in step 2 to keep the torso and rifle on the camera.
    // Backpedal plays the clip in reverse, so the feet step BACKWARD in hip
    // space and the yaw must mirror — keyed off the clip's smoothed playback
    // direction, which eases the hips through neutral on a fwd/back flip
    // and inherits the backpedal hysteresis for pure strafes.
    const up = Vector3.UpReadOnly;
    const stepDir = this.clips?.stepDir ?? 1;
    let hipsYawTarget = 0;
    if (moveW > 0.01 && p.airBlend < 0.5) {
      const lat = p.localVelX;
      const fwdAbs = Math.abs(p.localVelZ);
      if (lat * lat + fwdAbs * fwdAbs > 0.09) {
        hipsYawTarget =
          clamp(Math.atan2(lat, fwdAbs), -HIP_YAW_MAX, HIP_YAW_MAX) *
          stepDir *
          moveW *
          (1 - p.airBlend);
      }
    }
    this.hipsYaw += (hipsYawTarget - this.hipsYaw) * Math.min(1, dt * 7);
    if (this.hips) this.worldDelta(this.hips, up, this.hipsYaw);

    // 2. Aim pitch distributed over the spine, plus the velocity lean
    // (sprint tips forward, backpedal leans back), the strafe roll, the
    // torso's follow-through behind camera turns, and the counter-yaw that
    // cancels 1c above the waist. The head glances down at the mag swap.
    const right = this.charRight();
    const fwd = this.charForward();
    const breath = 0.02 * Math.sin(p.idleT * 2.1) * idleW;
    const pitch = -p.aimPitch;
    const backW = clamp(-p.localVelZ / 3.5, 0, 1) * moveW;
    const lean = SPRINT_LEAN * p.sprintBlend - BACKPEDAL_LEAN * backW;
    const roll =
      -STRAFE_ROLL *
      clamp(p.localVelX / CONFIG.player.moveSpeed, -1, 1) *
      moveW *
      (1 - p.airBlend);
    const sway =
      clamp(-p.turnRate * TURN_SWAY, -TURN_SWAY_MAX, TURN_SWAY_MAX) *
      (1 - p.airBlend);
    const magW = this.magWindowW(p);
    if (this.spine) {
      this.worldDelta(this.spine, right, pitch * 0.1);
      this.worldDelta(this.spine, up, -this.hipsYaw * HIP_YAW_COUNTER.spine);
    }
    if (this.spine1) {
      this.worldDelta(this.spine1, right, pitch * 0.15 + lean * 0.4);
      this.worldDelta(this.spine1, up, -this.hipsYaw * HIP_YAW_COUNTER.spine1);
      this.worldDelta(this.spine1, fwd, roll * 0.5);
    }
    if (this.spine2) {
      this.worldDelta(
        this.spine2,
        right,
        pitch * 0.2 + breath + 0.22 * p.reloadBlend + lean * 0.6,
      );
      this.worldDelta(this.spine2, up, -this.hipsYaw * HIP_YAW_COUNTER.spine2 + sway);
      this.worldDelta(this.spine2, fwd, roll * 0.5);
    }
    if (this.head) {
      this.worldDelta(this.head, right, pitch * 0.3 + HEAD_GLANCE * magW);
    }

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

    // 3c. Airborne legs: knees tuck on the rise, reach for the ground on the
    // fall, with a small base crouch so the apex isn't a statue. The stance
    // (full weight while airborne) already neutralised the clip stride, so
    // these deltas pose from mid-stride. Angles are about the character's
    // right axis: negative swings a leg forward, positive swings it back.
    const airW = p.airBlend;
    if (airW > 0.01) {
      const jv = CONFIG.player.jumpVelocity;
      const rise = clamp(p.velY / jv, 0, 1);
      const fall = clamp(-p.velY / jv, 0, 1);
      const thigh =
        (AIR_REACH_THIGH * fall - AIR_TUCK_THIGH * rise - AIR_BASE_THIGH) * airW;
      const knee =
        (AIR_TUCK_KNEE * rise - AIR_REACH_KNEE * fall + AIR_BASE_KNEE) * airW;
      // A touch of asymmetry keeps the tuck from looking mirrored.
      if (this.upLegL) this.worldDelta(this.upLegL, right, thigh);
      if (this.upLegR) this.worldDelta(this.upLegR, right, thigh * 0.65 - 0.08 * airW);
      if (this.legL) this.worldDelta(this.legL, right, knee);
      if (this.legR) this.worldDelta(this.legR, right, knee * 0.8);
    }

    // 4. Rifle follows the (final) right hand.
    this.followRifle(p);
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

    this.aimJoint(upper, this.chain.childOf(upper), tmpV1, 1);

    if (isLeft) {
      // Support hand holds the handguard: aim the forearm at the guard point
      // of this frame's rifle pose (right hand is already final). Mid-reload
      // it leaves the guard for the magazine well (magW); the constant drop
      // direction remains the base whenever no precise target applies. The
      // point lookups allocate rather than clobber the shared temps, so the
      // drop direction is kept aside across them.
      this.aimDrop.copyFrom(tmpV2);
      const lowerChild = this.chain.childOf(lower);
      if (lowerChild && p.reloadBlend < 0.999) {
        const guard = this.handguardPoint(p);
        if (guard) {
          const elbow = Vector3.TransformCoordinates(
            Vector3.Zero(),
            this.chain.worldOf(lower as unknown as ChainNode),
          );
          tmpV3.copyFrom(guard).subtractInPlace(elbow);
          if (tmpV3.lengthSquared() > 1e-8) {
            tmpV3.normalize();
            const magW = this.magWindowW(p);
            if (magW > 0.001) {
              const mag = this.magPoint(p);
              if (mag) {
                const magDir = mag.subtractInPlace(elbow);
                if (magDir.lengthSquared() > 1e-8) {
                  Vector3.LerpToRef(tmpV3, magDir.normalize(), magW, tmpV3);
                  tmpV3.normalize();
                }
              }
            }
            Vector3.LerpToRef(
              tmpV3,
              this.aimDrop,
              p.reloadBlend * (1 - magW),
              tmpV3,
            );
            tmpV3.normalize();
            this.aimJoint(lower, lowerChild, tmpV3, 1);
            return;
          }
        }
      }
      this.aimJoint(lower, lowerChild, this.aimDrop, 1);
      return;
    }
    this.aimJoint(lower, this.chain.childOf(lower), tmpV2, 1);
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
    const hw = tmpM5.copyFrom(this.chain.worldOf(this.handR as unknown as ChainNode));
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
   * Support-hand-to-magazine weight over the reload cycle: ramps in as the
   * hand leaves the handguard, holds through the swap, ramps out on the way
   * back. Zero unless a reload is actually in flight.
   */
  private magWindowW(p: SoldierPoseParams): number {
    if (p.reloadBlend < 0.01) return 0;
    const ph = p.reloadPhase;
    return (
      p.reloadBlend *
      smoothstep(RELOAD_MAG_IN[0], RELOAD_MAG_IN[1], ph) *
      (1 - smoothstep(RELOAD_MAG_OUT[0], RELOAD_MAG_OUT[1], ph))
    );
  }

  /** Brief weight for the mag-seat wiggle near the end of the swap. */
  private seatW(phase: number): number {
    return (
      smoothstep(RELOAD_SEAT[0], RELOAD_SEAT[0] + 0.06, phase) *
      (1 - smoothstep(RELOAD_SEAT[1] - 0.06, RELOAD_SEAT[1], phase))
    );
  }

  /**
   * World position of the magazine well (the reload support-hand target),
   * from the rifle target — the tipped-down rifle while reloading, so the
   * hand tracks it. Includes the small seat wiggle.
   */
  private magPoint(p: SoldierPoseParams): Vector3 | null {
    const m = this.rifleWorldTarget(p);
    if (!m) return null;
    const a = m.m;
    const zLen = Math.hypot(a[8], a[9], a[10]) || 1;
    const yLen = Math.hypot(a[4], a[5], a[6]) || 1;
    const jiggle = Math.sin(p.reloadPhase * 26) * 0.015 * this.seatW(p.reloadPhase);
    return new Vector3(
      a[12] + (a[8] / zLen) * MAG_FORWARD - (a[4] / yLen) * MAG_DOWN,
      a[13] + (a[9] / zLen) * MAG_FORWARD - (a[5] / yLen) * MAG_DOWN + jiggle,
      a[14] + (a[10] / zLen) * MAG_FORWARD - (a[6] / yLen) * MAG_DOWN,
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
    const w = this.chain.worldOf(parent);
    w.invertToRef(tmpM4);
    const q = joint.rotationQuaternion ?? Quaternion.Identity();
    Matrix.ComposeToRef(joint.scaling, q, joint.position, tmpM5);
    tmpM5.multiplyToRef(w, tmpM5);
    tmpM5.multiplyToRef(delta, tmpM5);
    tmpM5.multiplyToRef(tmpM4, tmpM5);
    if (!tmpM5.decompose(undefined, tmpQ1, undefined)) return;
    joint.rotationQuaternion = tmpQ1.clone();
    this.chain.invalidate(joint);
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
    const bw = this.chain.worldOf(joint as unknown as ChainNode);
    const cw = this.chain.worldOf(child as unknown as ChainNode);
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
    const w = this.chain.worldOf(this.root as unknown as ChainNode);
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
    const hw = tmpM5.copyFrom(this.chain.worldOf(hand as unknown as ChainNode));
    orthonormalizeRows(hw);
    const ha = hw.m as unknown as Float32Array;
    ha[12] = 0;
    ha[13] = 0;
    ha[14] = 0;
    const cal = this[slot];
    if (!cal) {
      // Wait for a settled idle frame so the capture is the real carry
      // pose — the rifle offset was tuned against exactly this frame.
      if ((this.clips?.idleW ?? 0) < 0.95) return;
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
    this.chain.worldOf(this.gltfRoot as unknown as ChainNode).invertToRef(tmpM4);
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
    const w = this.chain.worldOf(this.root as unknown as ChainNode);
    w.decompose(tmpScale, tmpQ1, tmpV3);
    return Vector3.TransformNormal(Vector3.Right(), Matrix.FromQuaternionToRef(tmpQ1, tmpM2)).normalize();
  }

  /** Character forward axis in world space (the capsule's facing). */
  private charForward(): Vector3 {
    const w = this.chain.worldOf(this.root as unknown as ChainNode);
    w.decompose(tmpScale, tmpQ1, tmpV3);
    return Vector3.TransformNormal(Vector3.Forward(), Matrix.FromQuaternionToRef(tmpQ1, tmpM2)).normalize();
  }
}
