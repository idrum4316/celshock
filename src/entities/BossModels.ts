import {
  Mesh,
  MeshBuilder,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { BossPattern, BossType } from "../themes/types";

/**
 * Procedural boss models — same idea as `EnemyModels`, at a scale where the
 * silhouette has to read across a very large arena: heavy masses, a glowing
 * face or core that tracks the player, and joints the fight patterns can pose
 * (arms rear back before a slam, a maw unhinges before a spit).
 *
 * Geometry is authored at scale 1; the caller scales the root by
 * `BossType.scale`.
 */
export interface BossRig {
  root: Mesh;
  groundY: number;
  hitRadius: number;
  /** Torso — sways while moving, recoils on attacks. */
  body: TransformNode | null;
  head: TransformNode | null;
  /** Shoulders (Treant/Titan) — raised during a windup. */
  arms: TransformNode[];
  /** Hinged mandibles / jaw halves. */
  jaws: TransformNode[];
  /** Free-spinning parts (Titan gyro, worm plating). */
  rings: TransformNode[];
  /** Trailing body segments (worm) — undulate behind the head. */
  segments: TransformNode[];
  /** Emissive parts that pulse brighter during a windup. */
  glows: Mesh[];
}

function emptyRig(root: Mesh, groundY: number, hitRadius: number): BossRig {
  return {
    root,
    groundY,
    hitRadius,
    body: null,
    head: null,
    arms: [],
    jaws: [],
    rings: [],
    segments: [],
    glows: [],
  };
}

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

/** Unlit emissive part, excluded from outlines and tracked for glow pulses. */
function glowMesh(rig: BossRig, mesh: Mesh): Mesh {
  mesh.metadata = { noOutline: true };
  rig.glows.push(mesh);
  return mesh;
}

export function buildBossRig(
  scene: Scene,
  mats: CelMaterialFactory,
  type: BossType,
): BossRig {
  switch (type.pattern) {
    case "slam":
      return buildTreant(scene, mats, type);
    case "burst":
      return buildTitan(scene, mats, type);
    default:
      return buildWorm(scene, mats, type);
  }
}

/** Hollow rotted tree-thing: split root legs, branch arms, burning eye sockets. */
function buildTreant(
  scene: Scene,
  mats: CelMaterialFactory,
  type: BossType,
): BossRig {
  const bark = mats.get(type.color);
  const growth = mats.get(type.accentColor);
  const eyeMat = mats.getEmissive(type.eyeColor);
  const root = makeRoot(scene, `boss-${type.name}`);
  const rig = emptyRig(root, 1.9, 2.0);

  const body = new TransformNode("body", scene);
  body.parent = root;
  rig.body = body;

  cyl(scene, "trunk", 3.4, 1.5, 2.0, 9, body, new Vector3(0, 0.2, 0), bark);
  // Splayed roots stand in for legs.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const leg = cyl(
      scene,
      `root${i}`,
      1.9,
      0.42,
      0.24,
      6,
      body,
      new Vector3(Math.cos(a) * 0.95, -1.7, Math.sin(a) * 0.95),
      bark,
    );
    leg.rotation.z = -Math.cos(a) * 0.42;
    leg.rotation.x = Math.sin(a) * 0.42;
  }

  // Face cavity: a dark hollow with two coals burning in it.
  const head = new TransformNode("head", scene);
  head.parent = body;
  head.position.set(0, 1.1, 0);
  rig.head = head;
  box(scene, "hollow", 1.05, 0.95, 0.35, head, new Vector3(0, 0, 0.72), mats.get("#0b0705"));
  for (const side of [-1, 1]) {
    glowMesh(
      rig,
      box(scene, "eye", 0.26, 0.3, 0.2, head, new Vector3(side * 0.26, 0.1, 0.84), eyeMat),
    );
  }
  // Splintered mouth — hinged so it can gape when it roars.
  for (let i = 0; i < 2; i++) {
    const jaw = new TransformNode(`jaw${i}`, scene);
    jaw.parent = head;
    jaw.position.set(0, -0.34, 0.62);
    const sign = i === 0 ? 1 : -1;
    for (let t = 0; t < 4; t++) {
      const tooth = cyl(
        scene,
        `splinter${i}-${t}`,
        0.34,
        0.02,
        0.13,
        4,
        jaw,
        new Vector3(-0.3 + t * 0.2, sign * 0.14, 0.12),
        growth,
      );
      tooth.rotation.x = sign === 1 ? Math.PI : 0;
    }
    rig.jaws.push(jaw);
  }

  // Heavy branch arms with clawed twig fingers.
  for (const side of [-1, 1]) {
    const shoulder = new TransformNode("shoulder", scene);
    shoulder.parent = body;
    shoulder.position.set(side * 1.0, 0.9, 0.1);
    shoulder.rotation.z = side * 0.5;
    cyl(scene, "upperLimb", 1.7, 0.45, 0.6, 6, shoulder, new Vector3(0, -0.8, 0), bark);

    const elbow = new TransformNode("elbow", scene);
    elbow.parent = shoulder;
    elbow.position.set(0, -1.6, 0);
    elbow.rotation.x = -0.5;
    cyl(scene, "forelimb", 1.5, 0.3, 0.42, 6, elbow, new Vector3(0, -0.7, 0), bark);
    for (let i = -1; i <= 1; i++) {
      const claw = cyl(
        scene,
        "claw",
        0.6,
        0.03,
        0.16,
        4,
        elbow,
        new Vector3(i * 0.18, -1.6, 0.05),
        bark,
      );
      claw.rotation.x = Math.PI + i * 0.15;
      claw.rotation.z = i * 0.3;
    }
    rig.arms.push(shoulder);
  }

  // Dead crown: bare branches with a few surviving clumps of growth.
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3;
    const branch = cyl(
      scene,
      `branch${i}`,
      1.6 + (i % 3) * 0.4,
      0.05,
      0.22,
      5,
      body,
      new Vector3(Math.cos(a) * 0.7, 2.4, Math.sin(a) * 0.7),
      bark,
    );
    branch.rotation.z = -Math.cos(a) * 0.75;
    branch.rotation.x = Math.sin(a) * 0.75;
    if (i % 2 === 0) {
      sphere(
        scene,
        `clump${i}`,
        1.0,
        4,
        body,
        new Vector3(Math.cos(a) * 1.45, 3.1, Math.sin(a) * 1.45),
        growth,
      );
    }
  }

  return rig;
}

/** Derelict war machine: armored hull, spinning gyro, glowing reactor core. */
function buildTitan(
  scene: Scene,
  mats: CelMaterialFactory,
  type: BossType,
): BossRig {
  const plate = mats.get(type.color);
  const trim = mats.get(type.accentColor);
  const eyeMat = mats.getEmissive(type.eyeColor);
  const root = makeRoot(scene, `boss-${type.name}`);
  const rig = emptyRig(root, 1.9, 1.9);

  const body = new TransformNode("body", scene);
  body.parent = root;
  rig.body = body;

  box(scene, "hull", 2.0, 2.3, 1.2, body, new Vector3(0, 0.2, 0), plate);
  box(scene, "chestPlate", 1.5, 1.0, 0.35, body, new Vector3(0, 0.5, 0.68), trim);
  box(scene, "waist", 1.3, 0.5, 0.9, body, new Vector3(0, -1.1, 0), trim);

  // Reactor core, visible through a gap in the chest armor.
  glowMesh(rig, sphere(scene, "core", 0.62, 8, body, new Vector3(0, -0.05, 0.66), eyeMat));

  // Head on a short neck, with a slit visor.
  const head = new TransformNode("head", scene);
  head.parent = body;
  head.position.set(0, 1.55, 0);
  rig.head = head;
  box(scene, "skull", 0.95, 0.72, 0.95, head, Vector3.Zero(), plate);
  box(scene, "crest", 0.3, 0.42, 0.7, head, new Vector3(0, 0.5, -0.1), trim);
  glowMesh(
    rig,
    box(scene, "visor", 0.78, 0.16, 0.18, head, new Vector3(0, 0.04, 0.48), eyeMat),
  );

  // Shoulder pods with arm cannons; the muzzles glow between bursts.
  for (const side of [-1, 1]) {
    const shoulder = new TransformNode("shoulder", scene);
    shoulder.parent = body;
    shoulder.position.set(side * 1.35, 0.85, 0);
    box(scene, "pod", 0.8, 1.0, 1.0, shoulder, Vector3.Zero(), plate);
    box(scene, "vent", 0.3, 0.7, 0.3, shoulder, new Vector3(side * 0.42, 0.1, -0.3), trim);
    box(scene, "cannon", 0.42, 0.42, 1.5, shoulder, new Vector3(0, -0.45, 0.6), trim);
    glowMesh(
      rig,
      box(scene, "muzzle", 0.24, 0.24, 0.16, shoulder, new Vector3(0, -0.45, 1.4), eyeMat),
    );
    rig.arms.push(shoulder);
  }

  // Gyro ring around the waist — spins faster as the fight goes on.
  const ring = new TransformNode("gyro", scene);
  ring.parent = body;
  ring.position.set(0, -0.9, 0);
  const torus = MeshBuilder.CreateTorus(
    "gyroRing",
    { diameter: 3.0, thickness: 0.18, tessellation: 16 },
    scene,
  );
  torus.parent = ring;
  torus.material = trim;
  torus.isPickable = false;
  rig.rings.push(ring);

  // Thruster glow underneath (it hovers).
  for (const side of [-1, 1]) {
    glowMesh(
      rig,
      cyl(
        scene,
        "thruster",
        0.3,
        0.42,
        0.2,
        7,
        body,
        new Vector3(side * 0.45, -1.5, 0),
        eyeMat,
      ),
    );
  }

  return rig;
}

/** Burrowing horror: plated segments behind a maw of hinged mandibles. */
function buildWorm(
  scene: Scene,
  mats: CelMaterialFactory,
  type: BossType,
): BossRig {
  const hide = mats.get(type.color);
  const plate = mats.get(type.accentColor);
  const eyeMat = mats.getEmissive(type.eyeColor);
  const root = makeRoot(scene, `boss-${type.name}`);
  const rig = emptyRig(root, 1.3, 1.7);

  const body = new TransformNode("body", scene);
  body.parent = root;
  rig.body = body;

  sphere(scene, "head", 2.2, 10, body, Vector3.Zero(), hide);

  // Maw: concentric rings narrowing into a glowing throat.
  const maw = new TransformNode("maw", scene);
  maw.parent = body;
  maw.position.set(0, 0.85, 0.15);
  rig.head = maw;
  cyl(scene, "lip", 0.7, 1.7, 1.1, 10, maw, new Vector3(0, 0.1, 0), plate);
  cyl(scene, "innerLip", 0.5, 1.15, 0.75, 9, maw, new Vector3(0, 0.35, 0), hide);
  glowMesh(
    rig,
    cyl(scene, "throat", 0.5, 0.85, 0.3, 9, maw, new Vector3(0, 0.28, 0), eyeMat),
  );

  // Four mandibles that unhinge outward before it spits.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const jaw = new TransformNode(`mandible${i}`, scene);
    jaw.parent = maw;
    jaw.position.set(Math.cos(a) * 0.75, 0.3, Math.sin(a) * 0.75);
    jaw.rotation.y = -a;
    const tusk = cyl(scene, `tusk${i}`, 1.5, 0.06, 0.4, 5, jaw, new Vector3(0, 0.6, 0), plate);
    tusk.rotation.x = -0.25;
    rig.jaws.push(jaw);
  }

  // Trailing segments, each a ribbed plate ring around a shrinking body.
  let parent: TransformNode = body;
  let segScale = 0.86;
  for (let i = 1; i <= 4; i++) {
    const seg = new TransformNode(`segment${i}`, scene);
    seg.parent = parent;
    seg.position.set(0, i === 1 ? -0.3 : -0.2, -1.55 * segScale);
    sphere(scene, `segBody${i}`, 2.2 * segScale, 8, seg, Vector3.Zero(), hide);
    const rib = MeshBuilder.CreateTorus(
      `segRib${i}`,
      { diameter: 2.3 * segScale, thickness: 0.22 * segScale, tessellation: 10 },
      scene,
    );
    rib.parent = seg;
    rib.rotation.x = Math.PI / 2;
    rib.position.z = 0.3;
    rib.material = plate;
    rib.isPickable = false;
    rig.segments.push(seg);
    parent = seg;
    segScale *= 0.82;
  }

  return rig;
}

/**
 * Idle/locomotion pose for a boss rig.
 *
 * @param moving  0..1 travel speed relative to top speed.
 * @param windup  0..1 progress through an attack telegraph.
 */
export function animateBossRig(
  rig: BossRig,
  pattern: BossPattern,
  t: number,
  moving: number,
  windup: number,
): void {
  switch (pattern) {
    case "slam": {
      const gait = Math.sin(t * 3.4);
      if (rig.body) {
        rig.body.rotation.z = gait * 0.05 * (0.4 + moving);
        rig.body.position.y = Math.abs(gait) * 0.12 * moving;
        rig.body.rotation.x = windup * -0.18;
      }
      // Arms rear up and back over the windup, ready to come down.
      for (let i = 0; i < rig.arms.length; i++) {
        const side = i === 0 ? -1 : 1;
        rig.arms[i].rotation.x = -gait * side * 0.25 * moving - windup * 1.5;
        rig.arms[i].rotation.z = side * (0.5 + windup * 0.35);
      }
      for (let i = 0; i < rig.jaws.length; i++) {
        rig.jaws[i].rotation.x = (i === 0 ? 1 : -1) * windup * 0.5;
      }
      break;
    }
    case "burst": {
      if (rig.body) {
        rig.body.rotation.z = Math.sin(t * 1.1) * 0.05;
        rig.body.rotation.x = windup * 0.12;
      }
      if (rig.rings.length > 0) {
        rig.rings[0].rotation.y = t * (1.4 + windup * 6);
        rig.rings[0].rotation.x = Math.sin(t * 0.7) * 0.25;
      }
      // Cannons swing forward and level off as the burst charges.
      for (let i = 0; i < rig.arms.length; i++) {
        const side = i === 0 ? -1 : 1;
        rig.arms[i].rotation.x = -windup * 0.45;
        rig.arms[i].rotation.z = side * Math.sin(t * 1.3) * 0.05;
      }
      break;
    }
    default: {
      // Worm: the trailing segments undulate behind the head.
      for (let i = 0; i < rig.segments.length; i++) {
        const seg = rig.segments[i];
        seg.rotation.x = Math.sin(t * 2.2 - i * 0.9) * 0.16;
        seg.rotation.y = Math.cos(t * 1.7 - i * 0.7) * 0.14;
      }
      if (rig.body) rig.body.rotation.z = Math.sin(t * 1.4) * 0.08;
      // Mandibles unhinge outward before it spits.
      for (const jaw of rig.jaws) jaw.rotation.x = -windup * 0.8;
      break;
    }
  }

  // Emissive parts swell during a telegraph — the "it's charging" tell.
  const pulse = 1 + windup * 0.45 + Math.sin(t * 3) * 0.04;
  for (const glow of rig.glows) glow.scaling.setAll(pulse);
}
