/**
 * SoldierModel.ts — The cheap bot rig: nine merged meshes (vs ~60 for the
 * player's GLB body) plus procedural animation (animateSoldier: walk cycle,
 * aim, upper-body twist, crouch, death collapse — posed TransformNode joints,
 * never clips), plus the bone table `RagdollSystem` builds a corpse's rigid
 * bodies from.
 * Invariants: merging per color is what keeps 16 bots affordable — the outline
 * pass draws every mesh twice. Do NOT "unify" this rig with the player's
 * detailed GLB body; the player keeps fidelity because it's the only character
 * always on screen. Emissive parts (visor) need metadata.noOutline. Rigs are
 * built once by BattleSystem's pool and re-posed on respawn, never disposed.
 * `rig.rest` is the hierarchy as built and is the ONLY thing a ragdoll may
 * restore from — see JointRest.
 */
import {
  Mesh,
  MeshBuilder,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import { addOutline, type CelMaterialFactory } from "../shaders/CelShader";

/**
 * The bot soldier rig: a humanoid built to be cheap enough to draw sixteen
 * of at once.
 *
 * `Player.buildBody` assembles ~60 individual meshes, and every one of them is
 * drawn twice because of the outline pass. That is fine for the one character
 * always at the centre of the screen, and ruinous for a full Conquest roster —
 * 16 bots at that fidelity is ~850 draw calls before the village is drawn at
 * all.
 *
 * So each limb here is built from several boxes and then **merged into one mesh
 * per colour**, the same trick `RifleModel.buildRifle` uses to collapse ~50
 * boxes into 3. A bot ends up at nine meshes: torso, sash, head, visor, two
 * arms, two legs, rifle. The joints stay as `TransformNode`s above the merged
 * meshes, so procedural animation is unaffected — only the leaf geometry is
 * batched.
 *
 * The player keeps its own detailed rig. Sharing one model between the two
 * would mean either downgrading the player or paying full price for bots.
 */

const ARMOR = "#3b443d";
const SUIT = "#20262b";
const TRIM = "#2b2b33";
const GUN = "#2b2b33";

/** Which joint a ragdoll bone hangs off. Keys into `SoldierRig`. */
export type BoneJoint =
  | "torso"
  | "head"
  | "shoulderL"
  | "shoulderR"
  | "hipL"
  | "hipR";

/**
 * Every joint the rig poses, bone or not.
 *
 * `resetSoldierPose` restores all of them, which is why this is a wider list
 * than `RAGDOLL_BONES`: the rifle and the muzzle are carried by a bone rather
 * than being one, and `body` is the node the collapse tween moves.
 */
const POSED_JOINTS = [
  "body",
  "torso",
  "head",
  "shoulderL",
  "shoulderR",
  "hipL",
  "hipR",
  "kneeL",
  "kneeR",
  "ankleL",
  "ankleR",
  "gun",
  "muzzle",
] as const;

type PosedJoint = (typeof POSED_JOINTS)[number];

/**
 * The leg, in segments, measured off the box lists in `buildSoldier`.
 *
 * The knee sits at the bottom of the thigh box and the ankle at the bottom of
 * the shin box, so at rest every one of these joints is at zero and the drawn
 * leg is exactly what it was before the joints existed. `LEG_SPAN` is the hip's
 * height above the ankle standing, which is what the crouch's inverse kinematics
 * solves against — it is not the leg's full length, because the boot hangs
 * below the ankle and is rigid.
 */
const THIGH = 0.34;
const SHIN = 0.32;
const LEG_SPAN = THIGH + SHIN;

/** The head joint's height above the torso joint. Moves with the box lists. */
const HEAD_ABOVE_TORSO = 0.52;

/**
 * How far a full crouch takes the body DOWN, and it is read from the eye rather
 * than authored here.
 *
 * This is the number that makes the pose honest. `Player.syncCombatant` drops
 * the eye and the hit sphere by the same half metre on the same blend, and the
 * sphere's top therefore keeps its standing relation to the eye — so a crouched
 * body drawn any shallower than the eye fell is a helmet standing above a sphere
 * that no longer reaches it, which is the visible-but-unhittable failure
 * `config/player.ts` spends its longest comment preventing. Deriving it here
 * means the two cannot drift: retune the crouch and the pose follows.
 *
 * `player.height / 2 - player.crouchCenterHeight` is the same 0.5 m from the
 * sphere's side, and the pair being equal is the invariant, not a coincidence.
 */
const CROUCH_DROP = CONFIG.camera.eyeHeight - CONFIG.player.crouchEyeHeight;

/**
 * Forward lean of the spine at full crouch, radians.
 *
 * Kept modest deliberately. A deeper lean would buy some of the drop for free —
 * the head hangs `HEAD_ABOVE_TORSO` off the spine, so pitching it lowers the
 * helmet without folding the legs — but it swings the head FORWARD by the same
 * geometry, and past ~30 degrees that carries it outside the very sphere it is
 * supposed to sit in. At 0.3 rad the head lands 0.15 m forward of the axis and
 * 0.64 m from the sphere's centre, inside a radius of 0.7 with room to spare.
 */
const CROUCH_LEAN = 0.3;

/**
 * One rigid body's box, in its joint's own frame.
 *
 * These are ART constants and live here rather than in `CONFIG` for the reason
 * the file header gives: they are measured off the box lists below and have to
 * move when those move. A mass is not quite art, but it is meaningless away
 * from the extents it goes with, so the pair stays together — what `CONFIG`
 * owns is the sim (impulse, gravity, corpse life), not the skeleton.
 *
 * The extents are the union of each limb's boxes, not a fitted hull: a bot is
 * a stack of blocks and a box per limb is exactly the right fidelity for one.
 */
export interface BoneSpec {
  joint: BoneJoint;
  /** Full extents (not half), in the joint's frame. */
  size: [number, number, number];
  /** Box centre in the joint's frame — a limb hangs BELOW its joint. */
  center: [number, number, number];
  mass: number;
}

/**
 * The ragdoll's six bones, derived from the segment box lists below. Extents
 * are the union of a joint's boxes, trimmed a little inside the silhouette: a
 * collider fatter than the mesh makes a corpse hover, which is the same tell
 * `terrainSlab` documents from the other side.
 *
 * Six and no more, and the legs are the interesting half of that. There is no
 * elbow and no spine — a forearm is baked into the merged upper-arm mesh — and
 * there IS a knee and an ankle, but neither is a bone: a corpse's leg is one
 * rigid segment from hip to sole, exactly as it was before the crouch needed
 * joints to bend. That is what `animateSoldier` straightens the legs for the
 * moment `dead` goes above zero — the bone box below is 0.72 m of straight
 * leg, and handing physics a folded one would be a collider that agrees with
 * the mesh nowhere.
 *
 * **The rifle is deliberately NOT a bone.** It stays parented to `torso` and
 * rides that body for free. Giving it one would drop it out of hands that
 * cannot open — the arm is a single welded segment with no elbow, wrist or
 * finger — so the weapon would fall away while two fists stayed cupped around
 * nothing, which reads as a bug rather than as a dropped weapon.
 */
export const RAGDOLL_BONES: readonly BoneSpec[] = [
  // Chest: the carrier plate, pack and sash, spanning y in [-0.03, 0.49].
  { joint: "torso", size: [0.42, 0.52, 0.3], center: [0, 0.23, -0.03], mass: 34 },
  // Helmet, neck and visor, y in [-0.025, 0.235].
  { joint: "head", size: [0.26, 0.26, 0.27], center: [0, 0.105, 0], mass: 6 },
  // Shoulder to hand in one piece, y in [-0.48, 0.07].
  {
    joint: "shoulderL",
    size: [0.16, 0.55, 0.18],
    center: [0, -0.205, 0.015],
    mass: 5,
  },
  {
    joint: "shoulderR",
    size: [0.16, 0.55, 0.18],
    center: [0, -0.205, 0.015],
    mass: 5,
  },
  // Hip to boot sole, y in [-0.72, 0].
  {
    joint: "hipL",
    size: [0.17, 0.72, 0.2],
    center: [0, -0.36, 0.02],
    mass: 15,
  },
  {
    joint: "hipR",
    size: [0.17, 0.72, 0.2],
    center: [0, -0.36, 0.02],
    mass: 15,
  },
];

/**
 * One bone's pin to the chest: where it hangs, in the CHEST's frame, and how
 * far it may swing there.
 *
 * Limits are radians, per axis, symmetric about the carried pose. They are
 * loose enough to look boneless in flight and tight enough that a settled body
 * does not end up with its head on backwards. The table below is where the
 * numbers and the reasoning for them live.
 */
export interface BoneLink {
  /** Pivot in the chest's frame. */
  pivot: [number, number, number];
  /** Angular range about x (pitch), as [min, max]. */
  x: [number, number];
  /** About y (yaw). */
  y: [number, number];
  /** About z (roll). */
  z: [number, number];
}

/**
 * Where each bone is pinned to the chest and how far it may swing there.
 * `torso` is the root body and is absent — nothing pins it.
 *
 * Every joint is at identity relative to its parent in the carried pose, so
 * **the standing pose is the zero of all three angular axes** and these read as
 * plain ranges rather than as offsets from some authored rest angle.
 *
 * The ROLL ranges are asymmetric per side on purpose: a symmetric one lets an
 * arm or a leg fold in through the body it hangs off.
 *
 * The hips are the trap. `hipL`/`hipR` are children of `body`, NOT of `torso`
 * (see the leg section below), so the pivot in chest space is their own local
 * y of -0.02 MINUS the torso's +0.1 — the -0.12 here. Reading the hip's local
 * position straight off the node instead puts both legs 0.1 m up inside the
 * chest, which reads as a body folded in half.
 */
export const RAGDOLL_LINKS: Readonly<Partial<Record<BoneJoint, BoneLink>>> = {
  head: { pivot: [0, 0.52, 0], x: [-0.5, 0.5], y: [-0.7, 0.7], z: [-0.5, 0.5] },
  shoulderL: {
    pivot: [-0.28, 0.42, 0],
    x: [-1.6, 1.2],
    y: [-0.5, 0.5],
    z: [-0.2, 1.7],
  },
  shoulderR: {
    pivot: [0.28, 0.42, 0],
    x: [-1.6, 1.2],
    y: [-0.5, 0.5],
    z: [-1.7, 0.2],
  },
  hipL: {
    pivot: [-0.12, -0.12, 0],
    x: [-0.9, 1.4],
    y: [-0.3, 0.3],
    z: [-0.15, 0.8],
  },
  hipR: {
    pivot: [0.12, -0.12, 0],
    x: [-0.9, 1.4],
    y: [-0.3, 0.3],
    z: [-0.8, 0.15],
  },
};

/**
 * One joint's place in the hierarchy as BUILT, captured before anything has a
 * chance to move it.
 *
 * The ragdoll detaches these joints and hands them to the physics engine, and
 * putting them back has to be exact — a bot whose rig is restored even
 * slightly wrong is one that walks around subtly broken for the rest of the
 * session. Snapshotting at construction rather than at death is what makes
 * that impossible to get wrong: the rest pose can never have drifted, because
 * nothing has run yet when it is taken.
 */
export interface JointRest {
  node: TransformNode;
  parent: TransformNode;
  position: Vector3;
}

export interface SoldierRig {
  /** Invisible transform the rig hangs from; positioned at the body centre. */
  root: Mesh;
  body: TransformNode;
  torso: TransformNode;
  head: TransformNode;
  shoulderL: TransformNode;
  shoulderR: TransformNode;
  hipL: TransformNode;
  hipR: TransformNode;
  /**
   * Knees and ankles, which exist for the crouch and for nothing else — a bot
   * never bends them, and a standing body holds them all at zero. The ankle is
   * what keeps a boot flat on the ground while the shin folds under a squat;
   * without it the sole tips up with the shin and the toe goes through the
   * floor. Neither is a ragdoll bone: see `RAGDOLL_BONES`.
   */
  kneeL: TransformNode;
  kneeR: TransformNode;
  ankleL: TransformNode;
  ankleR: TransformNode;
  /** The rifle held across the chest. A ragdoll bone of its own. */
  gun: TransformNode;
  /** Muzzle landmark, for tracer origins. */
  muzzle: TransformNode;
  /** Every drawn mesh, for LOD visibility and outline toggling. */
  meshes: Mesh[];
  /** Height of the body centre above the feet. */
  centerHeight: number;
  /** Where every ragdoll bone joint sits when alive — see `JointRest`. */
  rest: readonly JointRest[];
}

/**
 * Everything `RagdollSystem` needs of a body it is about to throw. `Bot`
 * satisfies it structurally and so does the player's corpse stand-in, which is
 * the whole point: the pool has no business knowing which of the two it holds.
 *
 * It lives HERE rather than in `RagdollSystem` because it is a fact about a
 * soldier rig, and because the alternative is `DeathCam` importing a type from
 * another system — the one thing the wiring rules in CLAUDE.md forbid. Nothing
 * implementing it has to import it either; TypeScript's structural typing is
 * what keeps `Bot` free of any knowledge that a physics engine exists.
 */
export interface RagdollSubject {
  readonly rig: SoldierRig;
  /** The body's feet, used once for the distance gate at the moment of death. */
  readonly position: Vector3;
  /** The body's centre of mass, which the killing impulse is aimed away from. */
  readonly center: Vector3;
  /** Where the killing blow came from: a shooter's eye, or a blast centre. */
  readonly deathFrom: Vector3;
  /** How much of it there was, which scales the throw. */
  readonly deathDamage: number;
  /**
   * Set by the pool for as long as it owns the joints. Whoever poses this rig
   * has to leave it alone in that window, or two writers fight over one node.
   */
  ragdolling: boolean;
  /** A live body is released immediately — the pool's self-defence guard. */
  readonly alive: boolean;
  setEnabled(on: boolean): void;
}

/** Builds one soldier in the given team's colours. */
export function buildSoldier(
  scene: Scene,
  mats: CelMaterialFactory,
  teamColor: string,
  eyeColor: string,
): SoldierRig {
  const centerHeight = 0.9;
  const root = MeshBuilder.CreateCapsule(
    "bot",
    { height: 1.8, radius: 0.4 },
    scene,
  );
  root.isVisible = false;
  root.isPickable = false;

  const meshes: Mesh[] = [];
  const body = new TransformNode("bot-body", scene);
  body.parent = root;

  /**
   * Builds one limb from a list of boxes, merges it per colour, and parents the
   * results to a joint. Offsets are relative to the joint, so the merge can
   * happen at identity and the joint carries the animation.
   */
  const segment = (
    name: string,
    parent: TransformNode,
    boxes: [number, number, number, number, number, number, string][],
  ): void => {
    const parts: Mesh[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const [w, h, d, x, y, z, color] = boxes[i];
      const m = MeshBuilder.CreateBox(
        `${name}${i}`,
        { width: w, height: h, depth: d },
        scene,
      );
      m.position.set(x, y, z);
      m.material = mats.get(color);
      parts.push(m);
    }
    for (const merged of mergeByColor(parts, name)) {
      merged.parent = parent;
      merged.isPickable = false;
      meshes.push(merged);
    }
  };

  // --- torso: chest block, carrier plate, pack, and the team sash ---
  const torso = new TransformNode("bot-torso", scene);
  torso.parent = body;
  torso.position.y = 0.1;
  segment("bot-torso-m", torso, [
    [0.44, 0.5, 0.26, 0, 0.24, 0, ARMOR],
    [0.36, 0.22, 0.06, 0, 0.32, 0.15, ARMOR],
    [0.42, 0.1, 0.28, 0, 0.02, 0, TRIM],
    [0.28, 0.3, 0.13, 0, 0.26, -0.18, TRIM],
    // The sash is the friend/foe read at range — the only saturated colour on
    // the whole model, so it survives being three pixels wide through fog.
    [0.1, 0.46, 0.3, -0.13, 0.26, 0, teamColor],
  ]);

  // --- head: helmet with a glowing visor slit ---
  const head = new TransformNode("bot-head", scene);
  head.parent = torso;
  head.position.y = 0.52;
  segment("bot-head-m", head, [
    [0.25, 0.23, 0.26, 0, 0.13, 0, ARMOR],
    [0.27, 0.05, 0.28, 0, 0.21, 0, TRIM],
    [0.13, 0.07, 0.13, 0, 0.01, 0, SUIT],
  ]);
  // The visor protrudes past the helmet so the outline shell can't swallow it.
  const visor = MeshBuilder.CreateBox(
    "bot-visor",
    { width: 0.19, height: 0.05, depth: 0.05 },
    scene,
  );
  visor.parent = head;
  visor.position.set(0, 0.13, 0.145);
  visor.material = mats.getEmissive(eyeColor);
  visor.metadata = { noOutline: true };
  visor.isPickable = false;
  meshes.push(visor);

  // --- arms ---
  const shoulderL = new TransformNode("bot-shL", scene);
  shoulderL.parent = torso;
  shoulderL.position.set(-0.28, 0.42, 0);
  segment("bot-armL", shoulderL, [
    [0.14, 0.26, 0.14, 0, -0.13, 0, SUIT],
    [0.16, 0.1, 0.16, 0, 0.02, 0, ARMOR],
    [0.13, 0.24, 0.13, 0, -0.36, 0.05, SUIT],
  ]);

  const shoulderR = new TransformNode("bot-shR", scene);
  shoulderR.parent = torso;
  shoulderR.position.set(0.28, 0.42, 0);
  segment("bot-armR", shoulderR, [
    [0.14, 0.26, 0.14, 0, -0.13, 0, SUIT],
    [0.16, 0.1, 0.16, 0, 0.02, 0, ARMOR],
    [0.13, 0.24, 0.13, 0, -0.36, 0.05, SUIT],
  ]);

  // --- rifle: one merged block held across the chest ---
  const gun = new TransformNode("bot-gun", scene);
  gun.parent = torso;
  gun.position.set(0.2, 0.2, 0.2);
  segment("bot-rifle", gun, [
    [0.08, 0.1, 0.7, 0, 0, 0, GUN],
    [0.06, 0.14, 0.18, 0, -0.11, -0.02, GUN],
    [0.07, 0.16, 0.16, 0, 0.03, -0.28, GUN],
    [0.05, 0.05, 0.3, 0, 0.01, 0.4, GUN],
  ]);
  const muzzle = new TransformNode("bot-muzzle", scene);
  muzzle.parent = gun;
  muzzle.position.set(0, 0.01, 0.56);

  // --- legs ---
  /**
   * Thigh, shin and boot, hung off a hip, a knee and an ankle.
   *
   * The three boxes are the three the leg has always been and they are drawn in
   * the same places: the knee is the bottom of the thigh box and the ankle the
   * bottom of the shin box, so every offset here is the old hip-frame one minus
   * the joint it now hangs from, and a rig at rest is unchanged to the
   * micrometre. It also costs nothing to draw — each box is its own colour, so
   * `mergeByColor` produced three meshes for a leg before the joints existed and
   * produces the same three now.
   */
  const leg = (
    name: string,
    hip: TransformNode,
  ): [TransformNode, TransformNode] => {
    segment(name, hip, [[0.17, 0.34, 0.18, 0, -0.17, 0, ARMOR]]);
    const knee = new TransformNode(`${name}-knee`, scene);
    knee.parent = hip;
    knee.position.y = -THIGH;
    segment(name, knee, [[0.15, 0.32, 0.15, 0, -0.16, 0, SUIT]]);
    const ankle = new TransformNode(`${name}-ankle`, scene);
    ankle.parent = knee;
    ankle.position.y = -SHIN;
    segment(name, ankle, [[0.17, 0.08, 0.24, 0, -0.02, 0.03, TRIM]]);
    return [knee, ankle];
  };

  const hipL = new TransformNode("bot-hipL", scene);
  hipL.parent = body;
  hipL.position.set(-0.12, -0.02, 0);
  const [kneeL, ankleL] = leg("bot-legL", hipL);

  const hipR = new TransformNode("bot-hipR", scene);
  hipR.parent = body;
  hipR.position.set(0.12, -0.02, 0);
  const [kneeR, ankleR] = leg("bot-legR", hipR);

  for (const m of meshes) {
    if (!m.metadata?.noOutline) addOutline(m, 0.012);
  }

  const rig: SoldierRig = {
    root,
    body,
    torso,
    head,
    shoulderL,
    shoulderR,
    hipL,
    hipR,
    kneeL,
    kneeR,
    ankleL,
    ankleR,
    gun,
    muzzle,
    meshes,
    centerHeight,
    rest: [],
  };
  // Taken here, at the end of the build, so it records the hierarchy as
  // authored above rather than whatever a previous life left behind.
  rig.rest = POSED_JOINTS.map((key: PosedJoint) => {
    const node = rig[key];
    return {
      node,
      parent: node.parent as TransformNode,
      position: node.position.clone(),
    };
  });
  return rig;
}

/**
 * Puts every joint back to the transform `buildSoldier` gave it.
 *
 * This is the ONLY correct reset after anything that re-parented or
 * quaternion-posed the rig, and `animateSoldier(rig, 0, 0, 0, 0, 0)` is not a
 * substitute for it. That call writes fourteen Euler channels — `body.x`,
 * `body.position.y`, both hips' `x`, both knees' `x`, both ankles' `x`, both
 * shoulders' `x` and `z`, `torso.x`, `torso.y`, `head.x`, `head.y` — and the rig
 * has far more than fourteen. It never touches a `parent`, a
 * `rotationQuaternion`, a `scaling`, any `position.x/z`, or anything at all on
 * `gun`. A ragdoll leaves residue in every one of those.
 *
 * The quaternion is the load-bearing line. While one is set Babylon ignores
 * `rotation` entirely — the trap `ViewModel`'s inspect turntable documents from
 * the other side — so a quaternion left behind by a corpse freezes the
 * respawned bot in its death pose for the rest of the round, with its position
 * still updating correctly underneath.
 */
/**
 * Metres of ground covered per radian... more precisely, the divisor that turns
 * distance travelled into walk-cycle phase: `phase += distance / STRIDE`.
 *
 * It lives here, with the rig the phase poses, because two things advance it
 * and they must agree. `Bot` integrates it from its own speed; `NetSoldier`
 * integrates it from the distance an interpolated body actually moved. If the
 * two used different strides, a bot and a remote human walking side by side at
 * the same speed would swing their legs at different rates — which is precisely
 * the tell that would give away which bodies are AI, in a game whose whole
 * roster design rests on that being invisible.
 *
 * Advancing by DISTANCE rather than by time is what makes a footfall a point on
 * the cycle instead of a timer: something slowed to a walk steps more slowly for
 * free, and something stopped stops stepping.
 */
export const STRIDE = 0.9;

export function resetSoldierPose(rig: SoldierRig): void {
  for (const { node, parent, position } of rig.rest) {
    // A direct assignment, never setParent: setParent preserves the WORLD
    // transform, which is the opposite of what a reset wants.
    node.parent = parent;
    node.rotationQuaternion = null;
    node.rotation.setAll(0);
    node.position.copyFrom(position);
    node.scaling.setAll(1);
  }
  animateSoldier(rig, 0, 0, 0, 0, 0);
}

/**
 * Poses the rig. Purely procedural, like every other animation in the game —
 * there are no clips, and a new behaviour means new numbers rather than new art.
 *
 * @param phase  walk cycle phase, advanced by distance travelled
 * @param moving 0..1 blend between the idle and walk poses
 * @param aim    aim pitch in radians, applied at the spine
 * @param twist  upper-body yaw relative to the feet, radians
 * @param dead   collapse blend, 0 alive .. 1 fully down
 * @param crouch 0..1 stance blend, 0 standing .. 1 fully crouched
 *
 * `crouch` defaults to zero, and that default is the whole of a bot's stance:
 * nothing in the AI passes it, so a bot stands whatever it is doing, and the
 * only thing in the game that bends these knees is a remote human's stance
 * arriving from the authority (`EntityState.crouch`). The local player has no
 * body to pose — the camera is inside the head.
 *
 * `twist` is the only parameter that is not a pitch or a blend, and it is worth
 * saying why it exists. The rig's `root` carries one yaw, so before it a bot
 * pointed its whole body — feet included — at whatever it was looking at. A bot
 * strafing across a doorway while tracking you walked visibly sideways, legs
 * swinging along an axis it was not travelling on. Splitting the two lets the
 * feet follow the direction of travel and the torso (with the head, arms and
 * rifle hanging off it) turn to the target, which is most of what "soldier"
 * looks like. It costs one extra `rotation.y` write and no geometry at all —
 * `torso` was always a child of `body`, with the legs as its siblings.
 */
export function animateSoldier(
  rig: SoldierRig,
  phase: number,
  moving: number,
  aim: number,
  twist: number,
  dead: number,
  crouch = 0,
): void {
  if (dead > 0) {
    // Pitch forward and sink; the rig is hidden once the tween completes.
    //
    // A body shot out of a crouch UNFOLDS as it goes down, over the same tween:
    // it has to end straight, because the legs are one rigid bone apiece to
    // `RagdollSystem` and to the corpse's own collapse, and it must not get
    // there by standing up on the frame it died — half a metre of pop is worse
    // than anything the tween is hiding.
    const dying = crouchDrop(crouch) * (1 - dead);
    rig.body.rotation.x = dead * 1.5;
    rig.body.position.y = -dead * 0.7 - dying;
    rig.torso.rotation.x = 0;
    rig.torso.rotation.y = 0;
    poseLegs(rig, dying, 0);
    return;
  }
  rig.body.rotation.x = 0;

  const lean = CROUCH_LEAN * crouch;
  const drop = crouchDrop(crouch);

  // A deep squat cannot swing its legs through a stride, so the walk is damped
  // toward a shuffle as the body folds — which is also what the stance costs in
  // speed (`player.crouchMoveMult`), arrived at from the animation side.
  const swing = Math.sin(phase) * 0.7 * moving * (1 - 0.65 * crouch);
  poseLegs(rig, drop, swing);
  // Counter-swing on the left arm; the right holds the weapon steady.
  rig.shoulderL.rotation.x = -swing * 0.5 - 0.15;
  rig.shoulderR.rotation.x = 0.1;
  rig.shoulderR.rotation.z = -0.25;
  rig.shoulderL.rotation.z = 0.2;
  // Lean into the run, and pitch the spine to wherever the bot is aiming.
  rig.torso.rotation.x = aim * 0.5 + moving * 0.1 + lean;
  // Twist the upper body off the feet. The head takes a share of it on top, so
  // the helmet leads the shoulders rather than being welded square to them.
  rig.torso.rotation.y = twist;
  rig.head.rotation.y = twist * 0.35;
  // Most of the crouch's lean is taken back at the neck, so a hunkered body
  // still looks where it is aiming and its visor — the friend/foe read at
  // range — still faces the way it is shooting.
  rig.head.rotation.x = aim * 0.5 - lean * 0.6;
  rig.body.position.y = Math.abs(Math.sin(phase)) * 0.04 * moving - drop;
}

/**
 * How far the HIPS drop for a given stance blend.
 *
 * Not the same as how far the eye drops, and the difference is the spine: the
 * head hangs `HEAD_ABOVE_TORSO` off the torso joint, so pitching that joint by
 * `CROUCH_LEAN * crouch` already lowers the helmet by
 * `HEAD_ABOVE_TORSO * (1 - cos lean)` before a knee bends at all. Take that off
 * and the head lands exactly `CROUCH_DROP * crouch` down — which is exactly
 * where the eye and the centre of the hit sphere went.
 */
function crouchDrop(crouch: number): number {
  const lean = CROUCH_LEAN * crouch;
  return CROUCH_DROP * crouch - HEAD_ABOVE_TORSO * (1 - Math.cos(lean));
}

/**
 * Folds both legs to carry the hips `drop` metres below where they stand, and
 * adds the walk's swing on top.
 *
 * Two-link inverse kinematics rather than authored angles, because the pose has
 * to hold at every point of the stance blend and not only at its ends: the
 * boots are planted, so the knee and the ankle are whatever the hip height says
 * they are, and a crouch caught halfway is as correct as one at rest. Angles
 * lerped between a standing and a squatting key instead would slide the feet
 * through the floor and back over the quarter-second the blend takes.
 *
 * The solve is the standard one for a two-link chain reaching straight down:
 * `psi` is the thigh's angle off vertical from the law of cosines, and the shin
 * takes whatever angle puts the ankle back under the hip. The ankle then
 * cancels the shin so the boot stays flat. At `drop === 0` every term is zero
 * by construction — the chain is straight — so a standing rig is posed exactly
 * as it was before any of this existed.
 */
function poseLegs(rig: SoldierRig, drop: number, swing: number): void {
  let thigh = 0;
  let knee = 0;
  let shin = 0;
  if (drop > 0) {
    // Hip height above the ankle. Clamped off the fully-folded end, where the
    // triangle degenerates and `acos` starts returning NaN rather than an
    // angle; at the crouch this game asks for it is 0.18 m against a floor of
    // 0.03, so the clamp is a guard and never a limit.
    const span = Math.max(LEG_SPAN - drop, Math.abs(THIGH - SHIN) + 0.01);
    const psi = Math.acos(
      clamp((THIGH * THIGH + span * span - SHIN * SHIN) / (2 * THIGH * span)),
    );
    shin = Math.asin(clamp((THIGH * Math.sin(psi)) / SHIN));
    thigh = -psi;
    knee = shin + psi;
  }
  rig.hipL.rotation.x = thigh + swing;
  rig.hipR.rotation.x = thigh - swing;
  rig.kneeL.rotation.x = knee;
  rig.kneeR.rotation.x = knee;
  rig.ankleL.rotation.x = -shin;
  rig.ankleR.rotation.x = -shin;
}

/** Keeps a cosine or a sine inside its domain against floating-point drift. */
function clamp(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

/** Merges a limb's boxes into one mesh per colour, at identity. */
function mergeByColor(parts: Mesh[], name: string): Mesh[] {
  const groups = new Map<unknown, Mesh[]>();
  for (const m of parts) {
    const key = m.material;
    const g = groups.get(key);
    if (g) g.push(m);
    else groups.set(key, [m]);
  }
  const out: Mesh[] = [];
  for (const group of groups.values()) {
    const mat = group[0].material;
    const merged =
      group.length === 1
        ? group[0]
        : Mesh.MergeMeshes(group, true, true, undefined, false, false);
    if (!merged) continue;
    merged.name = name;
    merged.material = mat;
    out.push(merged as Mesh);
  }
  return out;
}
