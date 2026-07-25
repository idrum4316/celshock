import { Mesh, MeshBuilder, Scene } from "@babylonjs/core";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { RoomTheme } from "./types";

const BARK = "#4a4238";
const DEAD_BARK = "#3c3730";
const STONE = "#7a7f7c";
const IRON = "#2f3338";

/**
 * Dead tree: a leaning bare trunk with a crown of clawing branches. No
 * canopy — the silhouette is all splinters, and moonlight through them is
 * most of what the player sees at distance.
 */
function buildDeadTree(scene: Scene, mats: CelMaterialFactory): Mesh {
  const barkMat = mats.get(BARK);
  const trunk = MeshBuilder.CreateCylinder(
    "tree-trunk",
    { height: 5.2, diameterTop: 0.32, diameterBottom: 0.85, tessellation: 6 },
    scene,
  );
  trunk.position.y = 2.6;
  trunk.material = barkMat;
  trunk.rotation.z = (Math.random() - 0.5) * 0.18;

  const branches = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + Math.random() * 0.6;
    const h = 1.4 + Math.random() * 1.4;
    const branch = MeshBuilder.CreateCylinder(
      `branch${i}`,
      { height: h, diameterTop: 0.04, diameterBottom: 0.2, tessellation: 5 },
      scene,
    );
    branch.parent = trunk;
    branch.position.set(
      Math.cos(a) * 0.25,
      0.9 + Math.random() * 1.4,
      Math.sin(a) * 0.25,
    );
    branch.rotation.z = -Math.cos(a) * (0.7 + Math.random() * 0.5);
    branch.rotation.x = Math.sin(a) * (0.7 + Math.random() * 0.5);
    branch.material = mats.get(DEAD_BARK);
  }
  return trunk;
}

/** Leaning headstone with a cracked-off corner. */
function buildGravestone(scene: Scene, mats: CelMaterialFactory): Mesh {
  const stone = mats.get(STONE);
  const slab = MeshBuilder.CreateBox(
    "grave-slab",
    { width: 1.0, height: 1.5, depth: 0.24 },
    scene,
  );
  slab.position.y = 0.75;
  slab.rotation.x = (Math.random() - 0.5) * 0.22;
  slab.rotation.z = (Math.random() - 0.5) * 0.3;
  slab.material = stone;

  const cap = MeshBuilder.CreateCylinder(
    "grave-cap",
    { height: 0.22, diameter: 1.0, tessellation: 7 },
    scene,
  );
  cap.parent = slab;
  cap.rotation.x = Math.PI / 2;
  cap.position.y = 0.72;
  cap.material = stone;

  const plinth = MeshBuilder.CreateBox(
    "grave-plinth",
    { width: 1.3, height: 0.28, depth: 0.5 },
    scene,
  );
  plinth.parent = slab;
  plinth.position.y = -0.72;
  plinth.material = mats.get("#5f6461");
  return slab;
}

/** Iron lamp post — the warm anchor in an otherwise blue-black room. */
function buildLantern(scene: Scene, mats: CelMaterialFactory): Mesh {
  const iron = mats.get(IRON);
  const post = MeshBuilder.CreateCylinder(
    "lantern-post",
    { height: 3.6, diameterTop: 0.14, diameterBottom: 0.24, tessellation: 6 },
    scene,
  );
  post.position.y = 1.8;
  post.material = iron;

  const arm = MeshBuilder.CreateBox(
    "lantern-arm",
    { width: 0.9, height: 0.1, depth: 0.1 },
    scene,
  );
  arm.parent = post;
  arm.position.set(0.35, 1.75, 0);
  arm.material = iron;

  const cage = MeshBuilder.CreateCylinder(
    "lantern-cage",
    { height: 0.62, diameterTop: 0.42, diameterBottom: 0.3, tessellation: 6 },
    scene,
  );
  cage.parent = post;
  cage.position.set(0.75, 1.42, 0);
  cage.material = iron;

  const flame = MeshBuilder.CreateSphere(
    "lantern-flame",
    { diameter: 0.3, segments: 6 },
    scene,
  );
  flame.parent = cage;
  flame.material = mats.getEmissive("#ffbe63");
  flame.metadata = { noOutline: true };

  const cap = MeshBuilder.CreateCylinder(
    "lantern-cap",
    { height: 0.18, diameterTop: 0.1, diameterBottom: 0.5, tessellation: 6 },
    scene,
  );
  cap.parent = cage;
  cap.position.y = 0.38;
  cap.material = iron;
  return post;
}

/** Cluster of luminous corpse-fungus — small, cold, and everywhere. */
function buildFungus(scene: Scene, mats: CelMaterialFactory): Mesh {
  const stem = mats.get("#6a6f63");
  const glow = mats.getEmissive("#6effc0");
  const base = MeshBuilder.CreateCylinder(
    "fungus-base",
    { height: 0.5, diameterTop: 0.12, diameterBottom: 0.2, tessellation: 5 },
    scene,
  );
  base.position.y = 0.25;
  base.material = stem;

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.random();
    const r = 0.25 + Math.random() * 0.35;
    const h = 0.3 + Math.random() * 0.4;
    const stalk = MeshBuilder.CreateCylinder(
      `fungus-stalk${i}`,
      { height: h, diameterTop: 0.07, diameterBottom: 0.1, tessellation: 5 },
      scene,
    );
    stalk.parent = base;
    stalk.position.set(Math.cos(a) * r, h / 2 - 0.2, Math.sin(a) * r);
    stalk.material = stem;

    const cap = MeshBuilder.CreateSphere(
      `fungus-cap${i}`,
      { diameter: 0.26 + Math.random() * 0.12, segments: 5 },
      scene,
    );
    cap.parent = stalk;
    cap.position.y = h / 2;
    cap.scaling.y = 0.55;
    cap.material = glow;
    cap.metadata = { noOutline: true };
  }
  return base;
}

/** Fallen, half-rotted log. */
function buildLog(scene: Scene, mats: CelMaterialFactory): Mesh {
  const log = MeshBuilder.CreateCylinder(
    "log",
    { height: 3.0, diameterTop: 0.55, diameterBottom: 0.7, tessellation: 6 },
    scene,
  );
  log.rotation.z = Math.PI / 2;
  log.rotation.x = (Math.random() - 0.5) * 0.4;
  log.position.y = 0.36;
  log.material = mats.get(DEAD_BARK);

  const stub = MeshBuilder.CreateCylinder(
    "log-stub",
    { height: 0.9, diameterTop: 0.12, diameterBottom: 0.22, tessellation: 5 },
    scene,
  );
  stub.parent = log;
  stub.position.set(0, 0.6, 0.3);
  stub.rotation.x = 0.6;
  stub.material = mats.get(BARK);
  return log;
}

/**
 * Blackwood: a moonlit graveyard forest under a dead sky. Lantern posts and
 * corpse-fungus are the only real light; everything else is silhouette.
 * Gaunt hounds run you down while bone archers and grave wraiths hang back.
 * Boss: the Rotwood Treant — ground-slam AOE (jump it!) and sapling minions.
 */
export const ForestTheme: RoomTheme = {
  name: "Blackwood",
  environment: {
    floorColor: "#3f4a3d",
    wallColor: "#2b332c",
    wallTrimColor: "#586352",
    accentColor: "#7fe0a0",
    skyColor: "#070a0d",
    fogColor: "#0a0f13",
    fogStart: 20,
    fogEnd: 76,
    mistColor: "#16211d",
    mistHeight: 2.8,
    mistStrength: 0.42,
    lighting: {
      color: "#8fb4ff",
      intensity: 0.55,
      direction: [-0.35, -0.85, 0.4],
      ambientColor: "#1b2634",
      ambientIntensity: 1.0,
      rimColor: "#7ea6ff",
      rimIntensity: 0.35,
    },
    particles: {
      color: "#9effc8",
      emissive: true,
      count: 90,
      size: 0.07,
      riseSpeed: 0.35,
    },
    props: [
      {
        name: "dead-tree",
        countRange: [7, 11],
        blocking: true,
        radius: 0.55,
        scaleRange: [0.9, 1.7],
        build: buildDeadTree,
      },
      {
        name: "gravestone",
        countRange: [5, 9],
        blocking: true,
        radius: 0.6,
        scaleRange: [0.8, 1.3],
        build: buildGravestone,
      },
      {
        name: "log",
        countRange: [3, 5],
        blocking: true,
        radius: 1.4,
        scaleRange: [0.8, 1.2],
        build: buildLog,
      },
      {
        name: "lantern",
        countRange: [2, 4],
        blocking: true,
        radius: 0.3,
        scaleRange: [0.9, 1.2],
        light: {
          color: "#ffb257",
          range: 22,
          intensity: 2.4,
          offset: [0.75, 3.2, 0],
          flicker: 0.35,
        },
        build: buildLantern,
      },
      {
        name: "fungus",
        countRange: [3, 5],
        blocking: false,
        radius: 0.5,
        scaleRange: [0.7, 1.4],
        light: {
          color: "#5bffb0",
          range: 8,
          intensity: 1.0,
          offset: [0, 0.6, 0],
          flicker: 0.12,
        },
        build: buildFungus,
      },
    ],
  },
  enemies: [
    {
      name: "Gaunt Hound",
      kind: "melee",
      body: "quad",
      color: "#584f45",
      accentColor: "#cec5ae",
      eyeColor: "#ff5a3c",
      scale: 1.05,
      health: 34,
      speed: 6.8,
      damage: 10,
      attackRange: 2.2,
      attackCooldown: 1.2,
    },
    {
      name: "Bone Archer",
      kind: "ranged",
      body: "capsule",
      color: "#404f3a",
      accentColor: "#c6bfa2",
      eyeColor: "#9dff6a",
      scale: 1,
      health: 28,
      speed: 3.4,
      damage: 9,
      attackRange: 18,
      attackCooldown: 2.2,
      projectileSpeed: 20,
      projectileColor: "#9dff6a",
    },
    {
      name: "Grave Wraith",
      kind: "flyer",
      body: "wraith",
      color: "#333e4e",
      accentColor: "#93aac9",
      eyeColor: "#7fd8ff",
      scale: 1.05,
      health: 26,
      speed: 4.2,
      damage: 11,
      attackRange: 15,
      attackCooldown: 2.6,
      projectileSpeed: 15,
      projectileColor: "#7fd8ff",
    },
  ],
  boss: {
    name: "Rotwood Treant",
    pattern: "slam",
    color: "#4a3d2e",
    accentColor: "#416a3d",
    eyeColor: "#ff7a2f",
    scale: 1.7,
    health: 460,
    speed: 2.8,
    contactDamage: 14,
    attackCooldown: 3.2,
    aoeRadius: 7.5,
    aoeDamage: 30,
  },
};
