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

const BODY = "#2b2b33"; // receiver, barrel, stock
const FURNITURE = "#1d232c"; // grip, magazine, handguard, sight housing
const METAL = "#454e5e"; // rails and small fittings
const RETICLE = "#ff3b30";

/**
 * Builds a boxy cel-styled assault rifle with a holographic sight. Local +z
 * is the barrel axis, origin at the receiver center. The reticle is an unlit
 * emissive ring + dot floating inside the sight window, so looking through
 * the window down +z gives a proper holo sight picture.
 */
export function buildRifle(
  scene: Scene,
  mats: CelMaterialFactory,
  prefix: string,
): RifleParts {
  const root = new TransformNode(`${prefix}_rifle`, scene);
  const meshes: Mesh[] = [];

  const box = (
    name: string,
    w: number,
    h: number,
    d: number,
    color: string,
    x: number,
    y: number,
    z: number,
  ): Mesh => {
    const m = MeshBuilder.CreateBox(
      `${prefix}_${name}`,
      { width: w, height: h, depth: d },
      scene,
    );
    m.parent = root;
    m.position.set(x, y, z);
    m.material = mats.get(color);
    meshes.push(m);
    return m;
  };

  // Receiver, barrel, and furniture.
  box("receiver", 0.075, 0.11, 0.46, BODY, 0, 0, 0);
  box("rail", 0.055, 0.02, 0.42, METAL, 0, 0.065, 0.03);
  box("handguard", 0.085, 0.095, 0.26, FURNITURE, 0, 0, 0.34);
  const barrel = MeshBuilder.CreateCylinder(
    `${prefix}_barrel`,
    { diameter: 0.042, height: 0.28, tessellation: 10 },
    scene,
  );
  barrel.parent = root;
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.01, 0.56);
  barrel.material = mats.get(BODY);
  meshes.push(barrel);
  box("frontSight", 0.02, 0.045, 0.025, BODY, 0, 0.06, 0.62);

  // Stock, grip, magazine (magazine raked forward like an AR).
  box("stock", 0.065, 0.11, 0.26, BODY, 0, -0.005, -0.35);
  box("buttpad", 0.075, 0.15, 0.045, FURNITURE, 0, -0.01, -0.49);
  const grip = box("grip", 0.06, 0.15, 0.09, FURNITURE, 0, -0.11, -0.12);
  grip.rotation.x = -0.35;
  const mag = box("magazine", 0.06, 0.2, 0.11, FURNITURE, 0, -0.14, 0.09);
  mag.rotation.x = 0.28;
  box("foregrip", 0.05, 0.11, 0.06, FURNITURE, 0, -0.095, 0.36);

  // Holographic sight: low base, open rectangular window, floating reticle.
  const winY = 0.155; // window center height
  const winZ = 0.02;
  box("sightBase", 0.055, 0.035, 0.15, FURNITURE, 0, 0.09, winZ);
  box("sightL", 0.016, 0.1, 0.032, FURNITURE, -0.048, winY, winZ);
  box("sightR", 0.016, 0.1, 0.032, FURNITURE, 0.048, winY, winZ);
  box("sightTop", 0.112, 0.016, 0.032, FURNITURE, 0, winY + 0.05, winZ);
  box("sightBot", 0.112, 0.016, 0.032, FURNITURE, 0, winY - 0.05, winZ);

  // Reticle: emissive ring + center dot. Tagged noOutline so the outline
  // pass never wraps black borders around the glow.
  const ring = MeshBuilder.CreateTorus(
    `${prefix}_reticleRing`,
    { diameter: 0.036, thickness: 0.0045, tessellation: 24 },
    scene,
  );
  ring.parent = root;
  ring.rotation.x = Math.PI / 2; // face down the barrel axis
  ring.position.set(0, winY, winZ - 0.004);
  ring.material = mats.getEmissive(RETICLE);
  ring.metadata = { noOutline: true };
  meshes.push(ring);

  const dot = MeshBuilder.CreateSphere(
    `${prefix}_reticleDot`,
    { diameter: 0.007, segments: 6 },
    scene,
  );
  dot.parent = root;
  dot.position.set(0, winY, winZ - 0.004);
  dot.material = mats.getEmissive(RETICLE);
  dot.metadata = { noOutline: true };
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
  glass.position.set(0, winY, winZ + 0.012);
  glass.material = glassMat;
  glass.metadata = { noOutline: true };
  meshes.push(glass);

  const muzzle = new TransformNode(`${prefix}_muzzle`, scene);
  muzzle.parent = root;
  muzzle.position = new Vector3(0, 0.01, 0.71);

  const sightCenter = new TransformNode(`${prefix}_sightCenter`, scene);
  sightCenter.parent = root;
  sightCenter.position = new Vector3(0, winY, winZ);

  return { root, muzzle, sightCenter, meshes };
}
