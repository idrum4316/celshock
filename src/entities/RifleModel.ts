import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import type { CelMaterialFactory } from "../shaders/CelShader";

/** Handles into a built rifle: the pose root plus alignment landmarks. */
export interface RifleParts {
  root: TransformNode;
  /** Barrel tip — tracer/muzzle-flash origin. */
  muzzle: TransformNode;
  /** Center of the holo sight window; the ADS camera axis passes through it. */
  sightCenter: TransformNode;
  meshes: Mesh[];
}

const BODY = "#2b2b33"; // aluminium upper receiver, barrel, hinge block
const POLYMER = "#1d232c"; // lower receiver, grip, magazine, handguard, stock
const METAL = "#454e5e"; // rails, sights, charging handle, small fittings
const RETICLE = "#ff3b30";

/** Color groups, merged into one mesh each. Order fixes the merged names. */
const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["body", BODY],
  ["polymer", POLYMER],
  ["metal", METAL],
];

/** Sight window center, in rifle-local space (also the ADS aim axis). */
const WIN_Y = 0.185;
const WIN_Z = 0.02;

/**
 * Builds a low-poly cel-styled SCAR-pattern battle rifle with a holographic
 * sight. Local +z is the barrel axis, origin at the receiver center.
 *
 * The silhouette follows the FN SCAR: one long monolithic upper receiver
 * carrying a full-length top rail, an angular polymer lower with a flared
 * magwell, a squared vented handguard, a side-folding skeleton stock with a
 * raised cheek riser, and a reciprocating charging handle on the left.
 *
 * All of it is static, so the ~50 boxes are merged down to one mesh per color
 * once built. That keeps draw calls flat and — more importantly — keeps the
 * outline pass drawing one clean border per color group instead of wrapping
 * every screw and rail rib in its own black shell.
 *
 * The reticle is an unlit emissive ring + dot floating inside the sight
 * window, so looking through the window down +z gives a proper sight picture.
 */
export function buildRifle(
  scene: Scene,
  mats: CelMaterialFactory,
  prefix: string,
): RifleParts {
  const root = new TransformNode(`${prefix}_rifle`, scene);
  const groups = new Map<string, Mesh[]>();
  const pivots: TransformNode[] = [];

  const collect = (color: string, m: Mesh): Mesh => {
    m.material = mats.get(color);
    m.isPickable = false;
    const g = groups.get(color);
    if (g) g.push(m);
    else groups.set(color, [m]);
    return m;
  };

  const box = (
    name: string,
    color: string,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    parent: TransformNode = root,
  ): Mesh => {
    const m = MeshBuilder.CreateBox(
      `${prefix}_${name}`,
      { width: w, height: h, depth: d },
      scene,
    );
    m.parent = parent;
    m.position.set(x, y, z);
    return collect(color, m);
  };

  /** Cylinder laid along the barrel axis. */
  const tube = (
    name: string,
    color: string,
    dFront: number,
    dRear: number,
    len: number,
    x: number,
    y: number,
    z: number,
  ): Mesh => {
    const m = MeshBuilder.CreateCylinder(
      `${prefix}_${name}`,
      { height: len, diameterTop: dFront, diameterBottom: dRear, tessellation: 10 },
      scene,
    );
    m.parent = root;
    m.rotation.x = Math.PI / 2; // +y axis -> +z barrel axis
    m.position.set(x, y, z);
    return collect(color, m);
  };

  /** Raked sub-assembly (grip, magazine, foregrip) hung off its own pivot. */
  const pivot = (
    name: string,
    x: number,
    y: number,
    z: number,
    rotX: number,
    parent: TransformNode = root,
  ): TransformNode => {
    const n = new TransformNode(`${prefix}_${name}`, scene);
    n.parent = parent;
    n.position.set(x, y, z);
    n.rotation.x = rotX;
    pivots.push(n);
    return n;
  };

  // --- upper receiver: one extrusion from the stock hinge to the muzzle end,
  // topped by a continuous ribbed rail (the SCAR's defining line) ---
  box("upper", BODY, 0.082, 0.072, 0.8, 0, 0.034, 0.14);
  // Rail base stays receiver-dark so only the ribs catch light; an all-metal
  // rail reads as a bright stripe down the top of the gun at distance.
  box("rail", BODY, 0.058, 0.014, 0.8, 0, 0.077, 0.14);
  for (let i = 0; i < 10; i++) {
    box("railRib", METAL, 0.062, 0.012, 0.014, 0, 0.082, -0.22 + i * 0.075);
  }
  box("ejectPort", METAL, 0.01, 0.032, 0.11, 0.045, 0.042, 0.06);
  box("deflector", BODY, 0.018, 0.03, 0.05, 0.046, 0.055, -0.03);

  // Reciprocating charging handle, left side, riding in its own slot.
  box("chSlot", POLYMER, 0.008, 0.016, 0.22, -0.043, 0.05, 0.16);
  box("chArm", METAL, 0.055, 0.016, 0.035, -0.072, 0.05, 0.22);
  box("chKnob", METAL, 0.022, 0.026, 0.05, -0.095, 0.05, 0.225);

  // --- lower receiver: flared magwell, enlarged trigger guard, raked grip ---
  box("lower", POLYMER, 0.076, 0.095, 0.42, 0, -0.045, -0.06);
  box("magwell", POLYMER, 0.082, 0.085, 0.16, 0, -0.08, 0.06);
  box("magRelease", METAL, 0.012, 0.03, 0.03, 0.044, -0.055, -0.02);
  box("boltRelease", METAL, 0.012, 0.022, 0.05, -0.044, -0.05, -0.05);
  box("guardFront", POLYMER, 0.05, 0.055, 0.018, 0, -0.125, -0.075);
  box("guardBottom", POLYMER, 0.05, 0.016, 0.1, 0, -0.15, -0.125);
  box("trigger", METAL, 0.016, 0.045, 0.016, 0, -0.118, -0.1);

  const gripPivot = pivot("gripPivot", 0, -0.1, -0.155, -0.3);
  box("grip", POLYMER, 0.056, 0.145, 0.078, 0, -0.07, 0, gripPivot);
  // Dark cap: a light one reads as a second magazine floorplate at a glance.
  box("gripCap", BODY, 0.058, 0.018, 0.082, 0, -0.15, 0, gripPivot);

  // Curved STANAG magazine: two segments, the lower one kicked further out.
  const magPivot = pivot("magPivot", 0, -0.115, 0.055, 0.14);
  box("magUpper", POLYMER, 0.058, 0.1, 0.105, 0, -0.05, 0, magPivot);
  const magLower = pivot("magLowerPivot", 0, -0.1, 0, 0.13, magPivot);
  box("magLower", POLYMER, 0.056, 0.085, 0.1, 0, -0.0425, 0, magLower);
  box("magFloor", METAL, 0.062, 0.02, 0.108, 0, -0.095, 0, magLower);

  // --- side-folding skeleton stock: hinge block, split struts, cheek riser ---
  box("stockHinge", BODY, 0.078, 0.1, 0.07, 0, 0.015, -0.3);
  box("slingLoop", METAL, 0.03, 0.05, 0.016, 0.045, 0.02, -0.3);
  box("stockTop", POLYMER, 0.058, 0.045, 0.22, 0, 0.055, -0.4);
  box("cheekRiser", POLYMER, 0.05, 0.035, 0.15, 0, 0.09, -0.395);
  box("stockBottom", POLYMER, 0.055, 0.035, 0.2, 0, -0.055, -0.39);
  box("stockRear", POLYMER, 0.07, 0.2, 0.045, 0, 0.005, -0.495);
  box("buttPad", BODY, 0.072, 0.075, 0.028, 0, -0.06, -0.505);

  // --- handguard: squared tube with side vents and three-side rails ---
  box("handguard", POLYMER, 0.09, 0.078, 0.28, 0, -0.012, 0.4);
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < 3; i++) {
      box("vent", BODY, 0.006, 0.03, 0.045, side * 0.046, -0.012, 0.31 + i * 0.07);
    }
    box("sideRail", METAL, 0.014, 0.026, 0.2, side * 0.048, -0.038, 0.4);
  }
  box("bottomRail", METAL, 0.05, 0.016, 0.2, 0, -0.058, 0.4);
  const foregripPivot = pivot("foregripPivot", 0, -0.046, 0.44, 0.45);
  box("foregrip", POLYMER, 0.048, 0.1, 0.055, 0, -0.05, 0, foregripPivot);

  // Folding front sight, hooded, sitting ahead of the optic on the rail.
  box("fsBase", METAL, 0.038, 0.024, 0.032, 0, 0.088, 0.5);
  box("fsPost", METAL, 0.014, 0.062, 0.014, 0, 0.128, 0.5);
  for (const side of [-1, 1] as const) {
    box("fsEar", METAL, 0.009, 0.058, 0.014, side * 0.02, 0.126, 0.5);
  }
  // Folded rear aperture, behind the optic.
  box("rsBase", METAL, 0.04, 0.022, 0.04, 0, 0.088, -0.14);
  box("rsAperture", METAL, 0.03, 0.035, 0.012, 0, 0.11, -0.14);

  // --- barrel: gas block, exposed barrel, birdcage flash hider ---
  box("gasBlock", BODY, 0.052, 0.055, 0.07, 0, 0, 0.575);
  tube("barrel", BODY, 0.036, 0.036, 0.13, 0, 0, 0.6);
  tube("flashHider", BODY, 0.048, 0.042, 0.075, 0, 0, 0.7);
  tube("crown", METAL, 0.05, 0.05, 0.012, 0, 0, 0.735);

  // --- holo sight: rail mount, rear emitter body, open hood ---
  box("opticMount", POLYMER, 0.062, 0.045, 0.12, 0, 0.106, WIN_Z);
  box("opticScrew", METAL, 0.02, 0.03, 0.02, 0.038, 0.1, WIN_Z);
  // Emitter body bridges mount to hood; its top stops at the window's lower
  // bar so nothing intrudes into the sight picture.
  box("opticBody", POLYMER, 0.06, 0.05, 0.07, 0, 0.12, WIN_Z - 0.04);
  box("sightL", POLYMER, 0.016, 0.1, 0.036, -0.048, WIN_Y, WIN_Z);
  box("sightR", POLYMER, 0.016, 0.1, 0.036, 0.048, WIN_Y, WIN_Z);
  box("sightTop", POLYMER, 0.112, 0.016, 0.036, 0, WIN_Y + 0.05, WIN_Z);
  box("sightBot", POLYMER, 0.112, 0.016, 0.036, 0, WIN_Y - 0.05, WIN_Z);

  // Merge each color group. The root is still at identity here, so baking the
  // world matrices and re-parenting the results leaves the geometry in place.
  const meshes: Mesh[] = [];
  for (const [name, color] of SECTIONS) {
    const parts = groups.get(color);
    if (!parts || parts.length === 0) continue;
    const merged = Mesh.MergeMeshes(parts, true, true);
    if (!merged) continue;
    merged.name = `${prefix}_rifle_${name}`;
    merged.parent = root;
    merged.isPickable = false;
    meshes.push(merged);
  }
  for (const p of pivots) p.dispose();

  // Reticle: emissive ring + center dot. Tagged noOutline so the outline
  // pass never wraps black borders around the glow.
  const ring = MeshBuilder.CreateTorus(
    `${prefix}_reticleRing`,
    { diameter: 0.036, thickness: 0.0045, tessellation: 24 },
    scene,
  );
  ring.parent = root;
  ring.rotation.x = Math.PI / 2; // face down the barrel axis
  ring.position.set(0, WIN_Y, WIN_Z - 0.004);
  ring.material = mats.getEmissive(RETICLE);
  ring.metadata = { noOutline: true };
  ring.isPickable = false;
  meshes.push(ring);

  const dot = MeshBuilder.CreateSphere(
    `${prefix}_reticleDot`,
    { diameter: 0.007, segments: 6 },
    scene,
  );
  dot.parent = root;
  dot.position.set(0, WIN_Y, WIN_Z - 0.004);
  dot.material = mats.getEmissive(RETICLE);
  dot.metadata = { noOutline: true };
  dot.isPickable = false;
  meshes.push(dot);

  // Faint holo glass filling the window (own material — alpha must not
  // leak into the shared emissive cache).
  const glassMat = new StandardMaterial(`${prefix}_holoGlass`, scene);
  glassMat.emissiveColor = Color3.FromHexString("#35f0ff");
  glassMat.diffuseColor = Color3.Black();
  glassMat.specularColor = Color3.Black();
  glassMat.disableLighting = true;
  glassMat.alpha = 0.12;
  const glass = MeshBuilder.CreatePlane(
    `${prefix}_holoGlass`,
    { width: 0.08, height: 0.084, sideOrientation: Mesh.DOUBLESIDE },
    scene,
  );
  glass.parent = root;
  glass.position.set(0, WIN_Y, WIN_Z + 0.012);
  glass.material = glassMat;
  // noGlow: the GlowLayer would turn the faint tint into a cyan haze that
  // obscures the sight picture.
  glass.metadata = { noOutline: true, noGlow: true };
  glass.isPickable = false;
  meshes.push(glass);

  const muzzle = new TransformNode(`${prefix}_muzzle`, scene);
  muzzle.parent = root;
  muzzle.position = new Vector3(0, 0, 0.75);

  const sightCenter = new TransformNode(`${prefix}_sightCenter`, scene);
  sightCenter.parent = root;
  sightCenter.position = new Vector3(0, WIN_Y, WIN_Z);

  return { root, muzzle, sightCenter, meshes };
}
