import {
  Mesh,
  MeshBuilder,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { EnemyBody, EnemyType } from "../themes/types";

/**
 * Procedural enemy models.
 *
 * Every creature is an invisible root holding a small skeleton of
 * `TransformNode` joints with low-poly meshes hung off them, so the same
 * builder output can be posed and animated (walk cycles, jaw snaps, sway)
 * without any rigging or animation data. Glowing eyes are unlit emissive
 * meshes: in the dark rooms they are usually the first thing the player
 * sees of an enemy, which is most of the horror read.
 *
 * Geometry is authored at scale 1; the caller scales the root by
 * `EnemyType.scale`.
 */

/** Posable joints exposed for animation; unused ones stay empty. */
export interface EnemyRig {
  /** Invisible transform root — position/rotation/scaling live here. */
  root: Mesh;
  /** Height of the root above the floor at rest, at scale 1. */
  groundY: number;
  /** Hitscan sphere radius at scale 1. */
  hitRadius: number;
  /** Hip joints; rotated around X for the walk cycle. */
  legs: TransformNode[];
  /** Knee joints, counter-rotated so the stride bends. */
  knees: TransformNode[];
  /** Shoulder joints; swing opposite the legs. */
  arms: TransformNode[];
  /** Tail/tatter chain; sways with a travelling wave. */
  tail: TransformNode[];
  /** Free-spinning parts (drone gyros). */
  rings: TransformNode[];
  /** Torso — leans into movement and breathes. */
  body: TransformNode | null;
  head: TransformNode | null;
  /** Hinged jaw; opens during an attack windup. */
  jaw: TransformNode | null;
}

function emptyRig(root: Mesh, groundY: number, hitRadius: number): EnemyRig {
  return {
    root,
    groundY,
    hitRadius,
    legs: [],
    knees: [],
    arms: [],
    tail: [],
    rings: [],
    body: null,
    head: null,
    jaw: null,
  };
}

/** Invisible parent so the visible geometry can be posed freely underneath. */
function makeRoot(scene: Scene, name: string): Mesh {
  const root = new Mesh(name, scene);
  root.isVisible = false;
  root.isPickable = false;
  return root;
}

function box(
  scene: Scene,
  name: string,
  w: number,
  h: number,
  d: number,
  parent: TransformNode,
  pos: Vector3,
  mat: unknown,
): Mesh {
  const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
  m.parent = parent;
  m.position.copyFrom(pos);
  m.material = mat as Mesh["material"];
  m.isPickable = false;
  return m;
}

function cyl(
  scene: Scene,
  name: string,
  height: number,
  dTop: number,
  dBottom: number,
  tess: number,
  parent: TransformNode,
  pos: Vector3,
  mat: unknown,
): Mesh {
  const m = MeshBuilder.CreateCylinder(
    name,
    { height, diameterTop: dTop, diameterBottom: dBottom, tessellation: tess },
    scene,
  );
  m.parent = parent;
  m.position.copyFrom(pos);
  m.material = mat as Mesh["material"];
  m.isPickable = false;
  return m;
}

function sphere(
  scene: Scene,
  name: string,
  diameter: number,
  segments: number,
  parent: TransformNode,
  pos: Vector3,
  mat: unknown,
): Mesh {
  const m = MeshBuilder.CreateSphere(name, { diameter, segments }, scene);
  m.parent = parent;
  m.position.copyFrom(pos);
  m.material = mat as Mesh["material"];
  m.isPickable = false;
  return m;
}

/** A pair of glowing eyes. Unlit, un-outlined, and picked up by the GlowLayer. */
function addEyes(
  scene: Scene,
  mats: CelMaterialFactory,
  parent: TransformNode,
  colorHex: string,
  spread: number,
  y: number,
  z: number,
  size: number,
): void {
  const mat = mats.getEmissive(colorHex);
  for (const side of [-1, 1]) {
    const eye = MeshBuilder.CreateBox(
      "eye",
      { width: size, height: size * 0.62, depth: size * 0.5 },
      scene,
    );
    eye.parent = parent;
    eye.position.set(side * spread, y, z);
    eye.material = mat;
    eye.isPickable = false;
    eye.metadata = { noOutline: true };
  }
}

/** Builds the model for an enemy type. */
export function buildEnemyRig(
  scene: Scene,
  mats: CelMaterialFactory,
  type: EnemyType,
): EnemyRig {
  switch (type.body) {
    case "quad":
      return buildHound(scene, mats, type);
    case "sphere":
      return buildDrone(scene, mats, type);
    case "wraith":
      return buildWraith(scene, mats, type);
    default:
      return buildHumanoid(scene, mats, type);
  }
}

/**
 * Starved four-legged stalker: bony spine ridge, low slung skull with a
 * hinged jaw, and a whipping tail.
 */
function buildHound(
  scene: Scene,
  mats: CelMaterialFactory,
  type: EnemyType,
): EnemyRig {
  const hide = mats.get(type.color);
  const bone = mats.get(type.accentColor);
  const root = makeRoot(scene, `enemy-${type.name}`);
  const rig = emptyRig(root, 0.92, 0.95);

  const body = new TransformNode("body", scene);
  body.parent = root;
  rig.body = body;

  box(scene, "chest", 0.66, 0.52, 0.8, body, new Vector3(0, 0, 0.3), hide);
  box(scene, "haunch", 0.6, 0.56, 0.66, body, new Vector3(0, -0.02, -0.42), hide);

  // Exposed spine: a row of shrinking bony plates down the back.
  for (let i = 0; i < 5; i++) {
    const k = i / 4;
    const plate = box(
      scene,
      `spine${i}`,
      0.1,
      0.2 - k * 0.08,
      0.16,
      body,
      new Vector3(0, 0.3 - k * 0.04, 0.5 - i * 0.28),
      bone,
    );
    plate.rotation.x = -0.25;
  }

  // Neck angles down and forward, ending in the skull.
  const neck = new TransformNode("neck", scene);
  neck.parent = body;
  neck.position.set(0, 0.16, 0.62);
  neck.rotation.x = 0.42;
  box(scene, "neck", 0.3, 0.3, 0.42, neck, new Vector3(0, 0, 0.18), hide);

  const head = new TransformNode("head", scene);
  head.parent = neck;
  head.position.set(0, -0.04, 0.42);
  head.rotation.x = -0.42;
  rig.head = head;
  box(scene, "skull", 0.34, 0.3, 0.44, head, new Vector3(0, 0, 0.1), bone);
  box(scene, "snout", 0.24, 0.16, 0.3, head, new Vector3(0, -0.04, 0.42), bone);
  for (const side of [-1, 1]) {
    const ear = box(
      scene,
      "ear",
      0.06,
      0.24,
      0.12,
      head,
      new Vector3(side * 0.13, 0.2, -0.02),
      bone,
    );
    ear.rotation.z = side * 0.35;
    ear.rotation.x = -0.3;
  }
  addEyes(scene, mats, head, type.eyeColor, 0.1, 0.06, 0.28, 0.09);

  // Hinged lower jaw — snaps open on the attack windup.
  const jaw = new TransformNode("jaw", scene);
  jaw.parent = head;
  jaw.position.set(0, -0.12, 0.16);
  rig.jaw = jaw;
  box(scene, "jaw", 0.22, 0.09, 0.44, jaw, new Vector3(0, 0, 0.2), bone);

  // Four legs, two segments each, so the stride bends at the knee.
  const hips: [number, number][] = [
    [-0.26, 0.42],
    [0.26, 0.42],
    [-0.26, -0.4],
    [0.26, -0.4],
  ];
  for (const [x, z] of hips) {
    const hip = new TransformNode("hip", scene);
    hip.parent = body;
    hip.position.set(x, -0.12, z);
    box(scene, "thigh", 0.15, 0.44, 0.17, hip, new Vector3(0, -0.22, 0), hide);

    const knee = new TransformNode("knee", scene);
    knee.parent = hip;
    knee.position.set(0, -0.42, 0);
    box(scene, "shin", 0.12, 0.4, 0.13, knee, new Vector3(0, -0.2, 0), bone);
    box(scene, "paw", 0.16, 0.1, 0.26, knee, new Vector3(0, -0.36, 0.05), bone);

    rig.legs.push(hip);
    rig.knees.push(knee);
  }

  // Tail: a chain of shrinking segments that trails the body.
  let tailParent: TransformNode = body;
  for (let i = 0; i < 4; i++) {
    const seg = new TransformNode(`tail${i}`, scene);
    seg.parent = tailParent;
    seg.position.set(0, i === 0 ? 0.1 : 0, i === 0 ? -0.7 : -0.26);
    box(
      scene,
      `tailSeg${i}`,
      0.13 - i * 0.02,
      0.13 - i * 0.02,
      0.26,
      seg,
      new Vector3(0, 0, -0.13),
      i > 1 ? bone : hide,
    );
    rig.tail.push(seg);
    tailParent = seg;
  }

  return rig;
}

/**
 * Robed humanoid: hooded head with eyes burning in the cowl, jointed arms,
 * and a glowing focus in one hand for ranged casters.
 */
function buildHumanoid(
  scene: Scene,
  mats: CelMaterialFactory,
  type: EnemyType,
): EnemyRig {
  const cloth = mats.get(type.color);
  const trim = mats.get(type.accentColor);
  const root = makeRoot(scene, `enemy-${type.name}`);
  const rig = emptyRig(root, 0.96, 1.0);

  const body = new TransformNode("body", scene);
  body.parent = root;
  rig.body = body;

  // Torso tapers into a hanging robe that hides the hips.
  box(scene, "torso", 0.5, 0.62, 0.32, body, new Vector3(0, 0.34, 0), cloth);
  box(scene, "collar", 0.56, 0.12, 0.38, body, new Vector3(0, 0.66, 0), trim);
  cyl(scene, "robe", 0.72, 0.46, 0.78, 8, body, new Vector3(0, -0.28, 0), cloth);

  const head = new TransformNode("head", scene);
  head.parent = body;
  head.position.set(0, 0.82, 0);
  rig.head = head;
  sphere(scene, "skull", 0.34, 6, head, new Vector3(0, 0.02, 0.02), trim);
  // Cowl: an open cone pulled over the skull, leaving the face in shadow.
  cyl(scene, "hood", 0.42, 0.08, 0.52, 7, head, new Vector3(0, 0.08, -0.04), cloth);
  box(scene, "brim", 0.42, 0.1, 0.3, head, new Vector3(0, -0.04, 0.14), cloth);
  addEyes(scene, mats, head, type.eyeColor, 0.08, 0.0, 0.16, 0.07);

  for (const side of [-1, 1]) {
    const shoulder = new TransformNode("shoulder", scene);
    shoulder.parent = body;
    shoulder.position.set(side * 0.3, 0.58, 0);
    shoulder.rotation.z = side * 0.12;
    box(scene, "pauldron", 0.2, 0.18, 0.26, shoulder, new Vector3(0, 0.02, 0), trim);
    box(scene, "upperArm", 0.14, 0.36, 0.15, shoulder, new Vector3(0, -0.2, 0), cloth);

    const elbow = new TransformNode("elbow", scene);
    elbow.parent = shoulder;
    elbow.position.set(0, -0.38, 0);
    box(scene, "forearm", 0.12, 0.34, 0.13, elbow, new Vector3(0, -0.17, 0), cloth);
    box(scene, "hand", 0.13, 0.13, 0.15, elbow, new Vector3(0, -0.36, 0.02), trim);

    rig.arms.push(shoulder);
    rig.knees.push(elbow); // elbows bend with the same counter-rotation
  }

  // Ranged casters carry a staff whose tip glows in their projectile color.
  if (type.kind !== "melee" && rig.arms.length > 0) {
    const hand = rig.arms[1];
    const staff = new TransformNode("staff", scene);
    staff.parent = hand;
    staff.position.set(0.1, -0.5, 0.12);
    staff.rotation.x = 0.25;
    cyl(scene, "shaft", 1.5, 0.05, 0.06, 5, staff, new Vector3(0, 0.35, 0), trim);
    const tip = sphere(
      scene,
      "focus",
      0.19,
      6,
      staff,
      new Vector3(0, 1.06, 0),
      mats.getEmissive(type.projectileColor ?? type.eyeColor),
    );
    tip.metadata = { noOutline: true };
  }

  for (const side of [-1, 1]) {
    const hip = new TransformNode("hip", scene);
    hip.parent = body;
    hip.position.set(side * 0.15, -0.06, 0);
    box(scene, "thigh", 0.17, 0.44, 0.18, hip, new Vector3(0, -0.22, 0), cloth);

    const knee = new TransformNode("knee", scene);
    knee.parent = hip;
    knee.position.set(0, -0.44, 0);
    box(scene, "shin", 0.14, 0.4, 0.15, knee, new Vector3(0, -0.2, 0), cloth);
    box(scene, "foot", 0.16, 0.1, 0.28, knee, new Vector3(0, -0.36, 0.06), trim);

    rig.legs.push(hip);
  }

  return rig;
}

/** Hovering machine: armored core, spinning gyro rings, single hot lens. */
function buildDrone(
  scene: Scene,
  mats: CelMaterialFactory,
  type: EnemyType,
): EnemyRig {
  const shell = mats.get(type.color);
  const trim = mats.get(type.accentColor);
  const root = makeRoot(scene, `enemy-${type.name}`);
  const rig = emptyRig(root, 2.4, 0.7);

  const body = new TransformNode("body", scene);
  body.parent = root;
  rig.body = body;

  sphere(scene, "core", 0.8, 8, body, Vector3.Zero(), shell);
  box(scene, "spine", 0.22, 0.5, 0.5, body, new Vector3(0, 0.3, -0.1), trim);

  // Lens housing with a single glowing eye.
  const housing = new TransformNode("housing", scene);
  housing.parent = body;
  housing.position.set(0, 0.02, 0.34);
  rig.head = housing;
  cyl(scene, "lensRim", 0.22, 0.44, 0.32, 8, housing, new Vector3(0, 0, 0.06), trim);
  const lens = MeshBuilder.CreateSphere("lens", { diameter: 0.3, segments: 8 }, scene);
  lens.parent = housing;
  lens.position.set(0, 0, 0.16);
  lens.material = mats.getEmissive(type.eyeColor);
  lens.isPickable = false;
  lens.metadata = { noOutline: true };

  // Two gyro rings spinning on different axes.
  for (let i = 0; i < 2; i++) {
    const ring = new TransformNode(`ring${i}`, scene);
    ring.parent = body;
    ring.rotation.z = i === 0 ? 0 : Math.PI / 2;
    const torus = MeshBuilder.CreateTorus(
      `gyro${i}`,
      { diameter: 1.16 - i * 0.16, thickness: 0.08, tessellation: 12 },
      scene,
    );
    torus.parent = ring;
    torus.material = trim;
    torus.isPickable = false;
    rig.rings.push(ring);
  }

  // Thruster fins under the hull.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const fin = box(
      scene,
      `fin${i}`,
      0.12,
      0.3,
      0.26,
      body,
      new Vector3(Math.cos(a) * 0.42, -0.34, Math.sin(a) * 0.42),
      trim,
    );
    fin.rotation.y = -a;
    fin.rotation.x = 0.4;
  }

  return rig;
}

/** Floating shroud: empty hood, trailing rags, long grasping arms. */
function buildWraith(
  scene: Scene,
  mats: CelMaterialFactory,
  type: EnemyType,
): EnemyRig {
  const shroud = mats.get(type.color);
  const trim = mats.get(type.accentColor);
  const root = makeRoot(scene, `enemy-${type.name}`);
  const rig = emptyRig(root, 1.75, 0.95);

  const body = new TransformNode("body", scene);
  body.parent = root;
  rig.body = body;

  // Robe tapers to nothing — the thing has no legs.
  cyl(scene, "shroud", 1.5, 0.78, 0.04, 8, body, new Vector3(0, -0.72, 0), shroud);
  box(scene, "shoulders", 0.78, 0.2, 0.36, body, new Vector3(0, 0.08, 0), shroud);

  const head = new TransformNode("head", scene);
  head.parent = body;
  head.position.set(0, 0.36, 0);
  rig.head = head;
  cyl(scene, "cowl", 0.56, 0.1, 0.56, 7, head, new Vector3(0, 0.06, -0.02), shroud);
  box(scene, "cowlFace", 0.4, 0.34, 0.18, head, new Vector3(0, -0.04, 0.16), trim);
  addEyes(scene, mats, head, type.eyeColor, 0.1, 0.0, 0.24, 0.09);

  // Long thin arms hanging forward, ending in claws.
  for (const side of [-1, 1]) {
    const shoulder = new TransformNode("shoulder", scene);
    shoulder.parent = body;
    shoulder.position.set(side * 0.36, 0.02, 0.04);
    shoulder.rotation.x = -0.5;
    box(scene, "arm", 0.11, 0.5, 0.12, shoulder, new Vector3(0, -0.25, 0), shroud);

    const elbow = new TransformNode("elbow", scene);
    elbow.parent = shoulder;
    elbow.position.set(0, -0.5, 0);
    elbow.rotation.x = -0.5;
    box(scene, "forearm", 0.09, 0.42, 0.1, elbow, new Vector3(0, -0.21, 0), shroud);
    for (let i = -1; i <= 1; i++) {
      const claw = box(
        scene,
        "claw",
        0.04,
        0.22,
        0.05,
        elbow,
        new Vector3(i * 0.07, -0.5, 0.02),
        trim,
      );
      claw.rotation.z = i * 0.25;
    }
    rig.arms.push(shoulder);
    rig.knees.push(elbow);
  }

  // Rag strips hanging off the hem; they sway with a travelling wave.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const rag = new TransformNode(`rag${i}`, scene);
    rag.parent = body;
    rag.position.set(Math.cos(a) * 0.22, -1.2, Math.sin(a) * 0.22);
    box(
      scene,
      `ragStrip${i}`,
      0.12,
      0.5 + (i % 3) * 0.16,
      0.06,
      rag,
      new Vector3(0, -0.25 - (i % 3) * 0.08, 0),
      shroud,
    );
    rig.tail.push(rag);
  }

  return rig;
}

/**
 * Poses a rig for the current frame.
 *
 * @param moving   0..1 how fast the creature is travelling relative to its
 *                 top speed — drives stride amplitude and lean.
 * @param attackK  0..1 progress through an attack windup.
 */
export function animateRig(
  rig: EnemyRig,
  body: EnemyBody,
  t: number,
  moving: number,
  attackK: number,
): void {
  const stride = 0.55 + 0.45 * moving;

  switch (body) {
    case "quad": {
      // Diagonal gait: front-left moves with rear-right.
      const phase = t * 9 * (0.5 + moving);
      const offsets = [0, Math.PI, Math.PI, 0];
      for (let i = 0; i < rig.legs.length; i++) {
        const swing = Math.sin(phase + offsets[i]);
        rig.legs[i].rotation.x = swing * 0.55 * stride;
        if (rig.knees[i]) {
          rig.knees[i].rotation.x = Math.max(0, -swing) * 0.7 * stride;
        }
      }
      if (rig.body) {
        rig.body.position.y = Math.abs(Math.sin(phase)) * 0.06 * moving;
        // Hunches low and coils back just before it lunges.
        rig.body.rotation.x = -0.12 * attackK;
        rig.body.position.z = -0.12 * attackK;
      }
      if (rig.jaw) rig.jaw.rotation.x = 0.15 + attackK * 0.7;
      break;
    }
    case "sphere": {
      for (let i = 0; i < rig.rings.length; i++) {
        const ring = rig.rings[i];
        if (i === 0) ring.rotation.y = t * 2.2;
        else ring.rotation.x = -t * 1.6;
      }
      if (rig.body) {
        rig.body.position.y = Math.sin(t * 2.4) * 0.12;
        rig.body.rotation.z = Math.sin(t * 1.3) * 0.08;
        // Winds back and tilts its lens down before firing.
        rig.body.rotation.x = attackK * 0.35;
      }
      break;
    }
    case "wraith": {
      if (rig.body) {
        rig.body.position.y = Math.sin(t * 1.7) * 0.16;
        rig.body.rotation.z = Math.sin(t * 0.9) * 0.07;
        rig.body.rotation.x = -attackK * 0.2;
      }
      for (let i = 0; i < rig.tail.length; i++) {
        const rag = rig.tail[i];
        rag.rotation.x = Math.sin(t * 2.6 - i * 0.7) * 0.28;
        rag.rotation.z = Math.cos(t * 2.1 - i * 0.5) * 0.22;
      }
      for (let i = 0; i < rig.arms.length; i++) {
        const side = i === 0 ? -1 : 1;
        // Reaches for the player as the attack charges.
        rig.arms[i].rotation.x = -0.5 - attackK * 0.9 + Math.sin(t * 1.9 + i) * 0.12;
        rig.arms[i].rotation.z = side * (0.1 + attackK * 0.25);
        if (rig.knees[i]) rig.knees[i].rotation.x = -0.5 + attackK * 0.35;
      }
      break;
    }
    default: {
      const phase = t * 6.5 * (0.5 + moving);
      for (let i = 0; i < rig.legs.length; i++) {
        const swing = Math.sin(phase + i * Math.PI);
        rig.legs[i].rotation.x = swing * 0.5 * stride * (0.35 + moving);
      }
      for (let i = 0; i < rig.arms.length; i++) {
        const swing = Math.sin(phase + i * Math.PI + Math.PI);
        // Both arms come up as the caster charges its focus.
        rig.arms[i].rotation.x = swing * 0.35 * moving - attackK * 1.1;
        if (rig.knees[i]) rig.knees[i].rotation.x = -0.25 - attackK * 0.5;
      }
      if (rig.body) {
        rig.body.position.y = Math.abs(Math.sin(phase)) * 0.05 * moving;
        rig.body.rotation.x = 0.08 * moving + attackK * 0.12;
      }
      break;
    }
  }

  // Tails trail with a travelling wave (quads only; wraith rags handled above).
  if (body === "quad") {
    for (let i = 0; i < rig.tail.length; i++) {
      const seg = rig.tail[i];
      seg.rotation.y = Math.sin(t * 4 - i * 0.8) * 0.22;
      seg.rotation.x = i === 0 ? -0.25 : Math.sin(t * 3 - i * 0.6) * 0.1;
    }
  }
}
