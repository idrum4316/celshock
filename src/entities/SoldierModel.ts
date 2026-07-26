import { Mesh, MeshBuilder, Scene, TransformNode } from "@babylonjs/core";
import { addOutline, type CelMaterialFactory } from "../shaders/CelShader";

/**
 * The bot soldier rig: a humanoid built to be cheap enough to draw thirty-two
 * of at once.
 *
 * `Player.buildBody` assembles ~60 individual meshes, and every one of them is
 * drawn twice because of the outline pass. That is fine for the one character
 * always at the centre of the screen, and ruinous for a full Conquest roster —
 * 32 bots at that fidelity is ~1,700 draw calls before the village is drawn at
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
  /** Muzzle landmark, for tracer origins. */
  muzzle: TransformNode;
  /** Every drawn mesh, for LOD visibility and outline toggling. */
  meshes: Mesh[];
  /** Height of the body centre above the feet. */
  centerHeight: number;
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
  const hipL = new TransformNode("bot-hipL", scene);
  hipL.parent = body;
  hipL.position.set(-0.12, -0.02, 0);
  segment("bot-legL", hipL, [
    [0.17, 0.34, 0.18, 0, -0.17, 0, ARMOR],
    [0.15, 0.32, 0.15, 0, -0.5, 0, SUIT],
    [0.17, 0.08, 0.24, 0, -0.68, 0.03, TRIM],
  ]);

  const hipR = new TransformNode("bot-hipR", scene);
  hipR.parent = body;
  hipR.position.set(0.12, -0.02, 0);
  segment("bot-legR", hipR, [
    [0.17, 0.34, 0.18, 0, -0.17, 0, ARMOR],
    [0.15, 0.32, 0.15, 0, -0.5, 0, SUIT],
    [0.17, 0.08, 0.24, 0, -0.68, 0.03, TRIM],
  ]);

  for (const m of meshes) {
    if (!m.metadata?.noOutline) addOutline(m, 0.02);
  }

  return {
    root,
    body,
    torso,
    head,
    shoulderL,
    shoulderR,
    hipL,
    hipR,
    muzzle,
    meshes,
    centerHeight,
  };
}

/**
 * Poses the rig. Purely procedural, like every other animation in the game —
 * there are no clips, and a new behaviour means new numbers rather than new art.
 *
 * @param phase  walk cycle phase, advanced by distance travelled
 * @param moving 0..1 blend between the idle and walk poses
 * @param aim    aim pitch in radians, applied at the spine
 * @param dead   collapse blend, 0 alive .. 1 fully down
 */
export function animateSoldier(
  rig: SoldierRig,
  phase: number,
  moving: number,
  aim: number,
  dead: number,
): void {
  if (dead > 0) {
    // Pitch forward and sink; the rig is hidden once the tween completes.
    rig.body.rotation.x = dead * 1.5;
    rig.body.position.y = -dead * 0.7;
    rig.torso.rotation.x = 0;
    rig.hipL.rotation.x = 0;
    rig.hipR.rotation.x = 0;
    return;
  }
  rig.body.rotation.x = 0;
  rig.body.position.y = 0;

  const swing = Math.sin(phase) * 0.7 * moving;
  rig.hipL.rotation.x = swing;
  rig.hipR.rotation.x = -swing;
  // Counter-swing on the left arm; the right holds the weapon steady.
  rig.shoulderL.rotation.x = -swing * 0.5 - 0.15;
  rig.shoulderR.rotation.x = 0.1;
  rig.shoulderR.rotation.z = -0.25;
  rig.shoulderL.rotation.z = 0.2;
  // Lean into the run, and pitch the spine to wherever the bot is aiming.
  rig.torso.rotation.x = aim * 0.5 + moving * 0.1;
  rig.head.rotation.x = aim * 0.5;
  rig.body.position.y = Math.abs(Math.sin(phase)) * 0.04 * moving;
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
