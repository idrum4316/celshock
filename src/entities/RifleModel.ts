/**
 * RifleModel.ts — Builds the low-poly rifle + optic from primitives.
 * Returns RifleParts: pose root plus alignment landmarks (muzzle, grip, ...).
 * Invariants: buildRifle() merges its ~150 parts into one mesh per color while
 * the root is still at identity — MergeMeshes bakes world matrices, so the
 * merge only works unrotated at the origin (same trick as BuildingKit). The
 * merge is what makes the outline pass draw one border per color group.
 * Emissive parts (reticle, glass) MUST carry metadata.noOutline/noGlow or they
 * get black shells and glow-scan artifacts.
 * Nothing here may be scaled non-uniformly: MergeMeshes transforms normals
 * without re-normalising them, and `renderOutline` extrudes along those
 * normals — a squashed part would grow a lopsided ink shell. Round shells are
 * built as faceted slab rings (`shell()`) for exactly that reason.
 */
import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import type { CelMaterialFactory } from "../shaders/CelShader";

/** Handles into a built rifle: the pose root plus alignment landmarks. */
export interface RifleParts {
  root: TransformNode;
  /** Barrel tip — tracer/muzzle-flash origin. */
  muzzle: TransformNode;
  /** Center of the optic's bore; the ADS camera axis passes through it. */
  sightCenter: TransformNode;
  meshes: Mesh[];
}

const BODY = "#2b2b33"; // aluminium upper receiver, barrel, hinge block
const POLYMER = "#1d232c"; // lower receiver, grip, magazine, handguard, stock
const METAL = "#454e5e"; // rails, sights, charging handle, small fittings
const RUBBER = "#15181d"; // the contact surfaces: butt pad, grip cap, foregrip
const RETICLE = "#ff3b30";

/**
 * Color groups, merged into one mesh each. Order fixes the merged names, and
 * a color absent from this list is silently never merged — anything `collect`
 * takes has to appear here.
 */
const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["body", BODY],
  ["polymer", POLYMER],
  ["metal", METAL],
  ["rubber", RUBBER],
];

/** Sight window center, in rifle-local space (also the ADS aim axis). */
const WIN_Y = 0.185;
const WIN_Z = 0.02;
/**
 * The optic's clear bore and wall. The shooter looks PAST the wall, so every
 * millimetre of it costs sight picture — keep it near the outline width and
 * let the bore carry the size. Outer radius is `(BORE + WALL * 2) / 2`, which
 * is what the turrets and the mount stand off from.
 */
const BORE = 0.1;
const WALL = 0.009;
/** Facets around a round shell. 14 reads round at arm's length and stays cheap. */
const FACETS = 14;

/**
 * Builds a low-poly cel-styled SCAR-pattern battle rifle with a tube optic.
 * Local +z is the barrel axis, origin at the receiver center.
 *
 * The silhouette follows the FN SCAR: one long stepped upper receiver carrying
 * a full-length top rail, an angular polymer lower with a flared magwell, a
 * vented handguard, a side-folding skeleton stock with a rounded cheek riser,
 * and a reciprocating charging handle on the left.
 *
 * All of it is static, so the ~150 parts are merged down to one mesh per color
 * once built. That keeps draw calls flat and — more importantly — keeps the
 * outline pass drawing one clean border per color group instead of wrapping
 * every screw and rail rib in its own black shell. Detail here is nearly free
 * for that reason: this is the one model always on screen, half a metre from
 * the lens, and it costs four draws however many boxes go into it.
 *
 * The reticle is an unlit emissive ring + dot floating inside the sight bore,
 * so looking through the tube down +z gives a proper sight picture.
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
    // The small metal parts are the rifle's only glossy surface — a hard
    // moon glint on the rails/fittings sells them as steel against the
    // matte receiver and polymer.
    m.material =
      color === METAL
        ? mats.getGlossy(color, CONFIG.graphics.spec.rifle)
        : mats.get(color);
    m.isPickable = false;
    const g = groups.get(color);
    if (g) g.push(m);
    else groups.set(color, [m]);
    return m;
  };

  /** `rotZ` cants a part in the xy plane; `pivot` is the rotX equivalent. */
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
    rotZ = 0,
  ): Mesh => {
    const m = MeshBuilder.CreateBox(
      `${prefix}_${name}`,
      { width: w, height: h, depth: d },
      scene,
    );
    m.parent = parent;
    m.position.set(x, y, z);
    m.rotation.z = rotZ;
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

  /** Cylinder across the weapon: pins, hinges, turrets, battery caps. */
  const pin = (
    name: string,
    color: string,
    dia: number,
    len: number,
    x: number,
    y: number,
    z: number,
    axis: "x" | "y" = "x",
  ): Mesh => {
    const m = MeshBuilder.CreateCylinder(
      `${prefix}_${name}`,
      { height: len, diameter: dia, tessellation: 10 },
      scene,
    );
    m.parent = root;
    if (axis === "x") m.rotation.z = Math.PI / 2; // +y axis -> +x
    m.position.set(x, y, z);
    return collect(color, m);
  };

  /**
   * A round shell around the barrel axis at x = 0: `sides` slabs, each turned
   * to face its own facet. Used for the optic housing and the muzzle cage.
   *
   * Built from slabs rather than from a primitive because a hollow tube is the
   * one shape the primitives will not give you. A capped cylinder has no bore;
   * an uncapped one is a single-sided shell whose far wall vanishes when you
   * look through it, which is precisely the view an optic is for; and a torus
   * stretched along the axis would need a non-uniform scale, whose un-
   * normalised normals `renderOutline` then extrudes into a lopsided shell.
   * Facets are what the cel shader wants anyway — it flat-shades from
   * screen-space derivatives, so a smooth ring would read as a faceted one.
   *
   * Slabs are cut to meet at the OUTER radius, so they overlap inward and the
   * shell has no seams. `span` below 1 opens those joints into slots (the
   * muzzle cage); `a0` turns the whole ring, which is what puts a slot rather
   * than a strut at top dead centre.
   */
  const shell = (
    name: string,
    color: string,
    bore: number,
    wall: number,
    len: number,
    y: number,
    z: number,
    sides = FACETS,
    a0 = 0,
    span = 1,
  ): void => {
    const rMid = bore / 2 + wall / 2;
    const w = 2 * (bore / 2 + wall) * Math.tan(Math.PI / sides) * span;
    for (let i = 0; i < sides; i++) {
      const a = a0 + (i / sides) * Math.PI * 2;
      // rotZ = -a puts the slab's own +y (its thickness axis) on the radius.
      box(`${name}${i}`, color, w, wall, len, Math.sin(a) * rMid, y + Math.cos(a) * rMid, z, root, -a);
    }
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

  // --- upper receiver: one run from the stock hinge to the muzzle end, topped
  // by a continuous ribbed rail (the SCAR's defining line) ---
  // Two stacked slabs rather than one: the narrower top deck reads as the
  // receiver's chamfer, which a chamfer-shaped part could not do — additive
  // geometry can add a corner but never cut one off.
  box("upper", BODY, 0.082, 0.056, 0.8, 0, 0.028, 0.14);
  box("upperDeck", BODY, 0.068, 0.014, 0.8, 0, 0.063, 0.14);
  // Rail base stays receiver-dark so only the ribs catch light; an all-metal
  // rail reads as a bright stripe down the top of the gun at distance.
  box("rail", BODY, 0.058, 0.014, 0.8, 0, 0.077, 0.14);
  for (let i = 0; i < 10; i++) {
    box("railRib", METAL, 0.062, 0.012, 0.014, 0, 0.082, -0.22 + i * 0.075);
  }
  // Takedown pins, through the receiver and proud of it on both sides.
  pin("pinFront", METAL, 0.015, 0.088, 0, 0.014, 0.115);
  pin("pinRear", METAL, 0.015, 0.088, 0, 0.014, -0.185);
  box("ejectPort", METAL, 0.01, 0.032, 0.11, 0.045, 0.042, 0.06);
  // Dust cover hanging under the port, and the brass deflector behind it.
  box("portCover", METAL, 0.008, 0.026, 0.104, 0.047, 0.018, 0.058);
  box("deflector", BODY, 0.018, 0.03, 0.05, 0.046, 0.055, -0.03);

  // Reciprocating charging handle, left side, riding in its own slot.
  box("chSlot", POLYMER, 0.008, 0.016, 0.22, -0.043, 0.05, 0.16);
  box("chArm", METAL, 0.055, 0.016, 0.035, -0.072, 0.05, 0.22);
  box("chKnob", METAL, 0.022, 0.026, 0.05, -0.095, 0.05, 0.225);
  box("chLatch", METAL, 0.014, 0.014, 0.016, -0.095, 0.066, 0.213);

  // --- lower receiver: flared magwell, enlarged trigger guard, raked grip ---
  box("lower", POLYMER, 0.076, 0.095, 0.42, 0, -0.045, -0.06);
  box("magwell", POLYMER, 0.082, 0.085, 0.16, 0, -0.08, 0.06);
  // Flared lip at the mouth: the funnel is what a magwell is for, and without
  // it the well is a plain box the magazine happens to end inside.
  box("magFlareF", POLYMER, 0.088, 0.022, 0.014, 0, -0.114, 0.132);
  box("magFlareR", POLYMER, 0.088, 0.022, 0.014, 0, -0.114, -0.012);
  for (const side of [-1, 1] as const) {
    box("magFlareS", POLYMER, 0.008, 0.022, 0.152, side * 0.042, -0.114, 0.06);
  }
  box("magRelease", METAL, 0.012, 0.03, 0.03, 0.044, -0.055, -0.02);
  box("boltRelease", METAL, 0.012, 0.022, 0.05, -0.044, -0.05, -0.05);
  // Ambidextrous safety: a through-pin with a lever tab on each side.
  pin("safetyPin", METAL, 0.013, 0.088, 0, -0.03, -0.118);
  for (const side of [-1, 1] as const) {
    box("safetyLever", METAL, 0.012, 0.038, 0.014, side * 0.048, -0.046, -0.118);
  }
  box("guardFront", POLYMER, 0.05, 0.055, 0.018, 0, -0.125, -0.075);
  box("guardBottom", POLYMER, 0.05, 0.016, 0.1, 0, -0.15, -0.125);
  // Trigger, curved back toward the shooter across two raked segments.
  const trigPivot = pivot("trigPivot", 0, -0.105, -0.096, 0.4);
  box("trigger", METAL, 0.014, 0.032, 0.014, 0, -0.016, 0, trigPivot);
  box("triggerToe", METAL, 0.014, 0.024, 0.017, 0, -0.042, 0.008, trigPivot);

  const gripPivot = pivot("gripPivot", 0, -0.1, -0.155, -0.3);
  box("grip", POLYMER, 0.056, 0.145, 0.078, 0, -0.07, 0, gripPivot);
  box("gripSwell", POLYMER, 0.061, 0.05, 0.07, 0, -0.052, -0.006, gripPivot);
  // Finger grooves, as proud ridges rather than cuts: three thin bands in the
  // lighter receiver tone, standing just past the grip's front face.
  for (let i = 0; i < 3; i++) {
    box("gripRib", BODY, 0.05, 0.011, 0.014, 0, -0.042 - i * 0.032, 0.036, gripPivot);
  }
  // Dark cap: a light one reads as a second magazine floorplate at a glance.
  box("gripCap", RUBBER, 0.058, 0.018, 0.082, 0, -0.15, 0, gripPivot);

  // Curved STANAG magazine: two segments, the lower one kicked further out.
  const magPivot = pivot("magPivot", 0, -0.115, 0.055, 0.14);
  box("magUpper", POLYMER, 0.058, 0.1, 0.105, 0, -0.05, 0, magPivot);
  box("magRibU", BODY, 0.061, 0.008, 0.108, 0, -0.04, 0, magPivot);
  const magLower = pivot("magLowerPivot", 0, -0.1, 0, 0.13, magPivot);
  box("magLower", POLYMER, 0.056, 0.085, 0.1, 0, -0.0425, 0, magLower);
  box("magRibL", BODY, 0.059, 0.008, 0.103, 0, -0.04, 0, magLower);
  box("magFloor", METAL, 0.062, 0.02, 0.108, 0, -0.095, 0, magLower);
  box("magBase", RUBBER, 0.058, 0.014, 0.1, 0, -0.11, 0, magLower);

  // --- side-folding skeleton stock: hinge block, split struts, cheek riser ---
  box("stockHinge", BODY, 0.078, 0.1, 0.07, 0, 0.015, -0.3);
  pin("hingePin", METAL, 0.02, 0.086, 0, 0.045, -0.3);
  box("stockLatch", METAL, 0.012, 0.03, 0.03, -0.046, -0.01, -0.3);
  box("slingLoop", METAL, 0.03, 0.05, 0.016, 0.045, 0.02, -0.3);
  box("stockTop", POLYMER, 0.058, 0.045, 0.22, 0, 0.055, -0.4);
  // Rounded cheek riser — the one part of the weapon a face actually rests on,
  // and the last place a square edge belongs.
  box("cheekBase", POLYMER, 0.05, 0.018, 0.15, 0, 0.079, -0.395);
  tube("cheekRiser", POLYMER, 0.046, 0.048, 0.15, 0, 0.092, -0.395);
  box("stockBottom", POLYMER, 0.055, 0.035, 0.2, 0, -0.055, -0.39);
  box("stockRear", POLYMER, 0.07, 0.2, 0.045, 0, 0.005, -0.495);
  box("slingRear", METAL, 0.026, 0.03, 0.014, -0.04, -0.03, -0.472);
  box("buttPad", RUBBER, 0.072, 0.075, 0.028, 0, -0.06, -0.505);
  for (let i = 0; i < 2; i++) {
    box("buttGroove", BODY, 0.074, 0.008, 0.02, 0, -0.042 - i * 0.03, -0.508);
  }

  // --- handguard: stepped tube with side vents and three-side rails ---
  box("handguard", POLYMER, 0.09, 0.056, 0.28, 0, -0.012, 0.4);
  box("hgTop", POLYMER, 0.07, 0.014, 0.28, 0, 0.023, 0.4);
  box("hgBottom", POLYMER, 0.07, 0.014, 0.28, 0, -0.047, 0.4);
  box("hgCap", BODY, 0.086, 0.07, 0.014, 0, -0.012, 0.533);
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < 3; i++) {
      box("vent", BODY, 0.006, 0.03, 0.045, side * 0.046, -0.012, 0.31 + i * 0.07);
    }
    box("sideRail", METAL, 0.014, 0.026, 0.2, side * 0.048, -0.038, 0.4);
  }
  // M-LOK slots along the underside, between the bottom rail and the vents.
  for (let i = 0; i < 3; i++) {
    box("mlok", BODY, 0.03, 0.006, 0.05, 0, -0.052, 0.31 + i * 0.07);
  }
  box("bottomRail", METAL, 0.05, 0.016, 0.2, 0, -0.058, 0.4);
  const foregripPivot = pivot("foregripPivot", 0, -0.046, 0.44, 0.45);
  box("foregrip", POLYMER, 0.048, 0.1, 0.055, 0, -0.05, 0, foregripPivot);
  box("foregripCap", RUBBER, 0.05, 0.016, 0.057, 0, -0.104, 0, foregripPivot);

  // Back-up irons, both folded flat the way they would be with an optic
  // mounted — standing them up puts pillars in the middle of the sight
  // picture, which is exactly what the housing is trying to keep clear.
  box("fsBase", METAL, 0.038, 0.02, 0.03, 0, 0.086, 0.482);
  box("fsLeaf", METAL, 0.03, 0.009, 0.07, 0, 0.0925, 0.53);
  box("rsBase", METAL, 0.04, 0.02, 0.036, 0, 0.086, -0.14);
  box("rsLeaf", METAL, 0.032, 0.012, 0.07, 0, 0.094, -0.185);

  // --- barrel: gas block, exposed barrel, birdcage flash hider ---
  box("gasBlock", BODY, 0.052, 0.055, 0.07, 0, 0, 0.575);
  box("gasPort", METAL, 0.022, 0.014, 0.026, 0, 0.032, 0.575);
  tube("gasTube", METAL, 0.012, 0.012, 0.055, 0, 0.024, 0.552);
  tube("barrel", BODY, 0.036, 0.036, 0.13, 0, 0, 0.6);
  tube("barrelNut", METAL, 0.042, 0.042, 0.014, 0, 0, 0.652);
  // Birdcage: rear collar, four struts with the slots between them, open front
  // ring. `a0` is a half facet, so a slot rather than a strut sits at top dead
  // centre — which is where a muzzle device vents, to hold the barrel down.
  // The dark core is what the slots are cut against: without something behind
  // them they open onto the skybox and the cage reads as a smooth tube. Its
  // front face doubles as the bore, seen through the ring.
  tube("mzCollar", BODY, 0.05, 0.046, 0.022, 0, 0, 0.674);
  tube("mzCore", RUBBER, 0.03, 0.03, 0.058, 0, 0, 0.711);
  shell("mzStrut", BODY, 0.032, 0.009, 0.048, 0, 0.711, 4, Math.PI / 4, 0.5);
  // The bottom slot is webbed shut, the way a device that fights muzzle rise
  // vents everywhere but down.
  box("mzWeb", BODY, 0.021, 0.011, 0.048, 0, -0.0205, 0.711);
  shell("crown", METAL, 0.032, 0.011, 0.013, 0, 0.742, 10);

  // --- optic: rail mount plus a round tube housing around the sight axis ---
  // The mount's top face meets the housing's underside exactly, so the two
  // read as one assembly rather than a sight balanced on a block.
  box("opticMount", POLYMER, 0.062, 0.045, 0.13, 0, 0.1055, WIN_Z);
  box("opticFoot", METAL, 0.07, 0.012, 0.134, 0, 0.089, WIN_Z);
  box("opticLever", METAL, 0.018, 0.03, 0.05, 0.038, 0.1, WIN_Z + 0.026);
  pin("opticNut", METAL, 0.012, 0.076, 0, 0.1, WIN_Z - 0.042);
  // The housing: a shell of `FACETS` slabs about the sight axis, with a
  // heavier rim at each end. The bore is the sight picture — the rims are
  // sized OUTWARD from it so a wider rim never eats into what you can see.
  shell("sightTube", POLYMER, BORE, WALL, 0.052, WIN_Y, WIN_Z);
  shell("sightRimF", POLYMER, BORE + 0.004, 0.013, 0.014, WIN_Y, WIN_Z + 0.031);
  shell("sightRimR", POLYMER, BORE + 0.004, 0.013, 0.014, WIN_Y, WIN_Z - 0.031);
  // Turrets and battery cap, standing off the housing's outer radius.
  const rOut = BORE / 2 + WALL;
  pin("elevTurret", METAL, 0.03, 0.018, 0, WIN_Y + rOut + 0.009, WIN_Z, "y");
  pin("elevCap", METAL, 0.022, 0.008, 0, WIN_Y + rOut + 0.022, WIN_Z, "y");
  pin("windTurret", METAL, 0.03, 0.018, rOut + 0.009, WIN_Y, WIN_Z, "x");
  pin("battery", METAL, 0.026, 0.016, -(rOut + 0.008), WIN_Y - 0.008, WIN_Z, "x");

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
    { diameter: 0.022, thickness: 0.0028, tessellation: 24 },
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
    { diameter: 0.0045, segments: 6 },
    scene,
  );
  dot.parent = root;
  dot.position.set(0, WIN_Y, WIN_Z - 0.004);
  dot.material = mats.getEmissive(RETICLE);
  dot.metadata = { noOutline: true };
  dot.isPickable = false;
  meshes.push(dot);

  // Faint holo glass filling the bore (own material — alpha must not
  // leak into the shared emissive cache). A disc, not a quad: the corners of
  // a square lens would poke through a round housing.
  const glassMat = new StandardMaterial(`${prefix}_holoGlass`, scene);
  glassMat.emissiveColor = Color3.FromHexString("#35f0ff");
  glassMat.diffuseColor = Color3.Black();
  glassMat.specularColor = Color3.Black();
  glassMat.disableLighting = true;
  glassMat.alpha = 0.12;
  const glass = MeshBuilder.CreateDisc(
    `${prefix}_holoGlass`,
    { radius: BORE / 2, tessellation: FACETS, sideOrientation: Mesh.DOUBLESIDE },
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
