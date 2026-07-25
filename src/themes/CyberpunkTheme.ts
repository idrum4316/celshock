import { Mesh, MeshBuilder, Scene } from "@babylonjs/core";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { RoomTheme } from "./types";

const HULL = "#3c414d";
const DARK_METAL = "#262a33";
const RUST = "#5d4a3c";
const CONCRETE = "#4a4d54";

/** Burnt-out vehicle: crushed cabin, flat tyres, exposed frame. */
function buildWreck(scene: Scene, mats: CelMaterialFactory): Mesh {
  const body = MeshBuilder.CreateBox(
    "wreck-body",
    { width: 2.0, height: 0.8, depth: 4.2 },
    scene,
  );
  body.position.y = 0.75;
  body.rotation.z = (Math.random() - 0.5) * 0.12;
  body.material = mats.get(RUST);

  const cabin = MeshBuilder.CreateBox(
    "wreck-cabin",
    { width: 1.75, height: 0.75, depth: 1.9 },
    scene,
  );
  cabin.parent = body;
  cabin.position.set(0, 0.72, -0.2);
  cabin.rotation.x = 0.08;
  cabin.material = mats.get(DARK_METAL);

  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      const wheel = MeshBuilder.CreateCylinder(
        "wreck-wheel",
        { height: 0.34, diameter: 0.9, tessellation: 7 },
        scene,
      );
      wheel.parent = body;
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side * 0.95, -0.4, end * 1.4);
      wheel.material = mats.get("#1e2127");
    }
  }
  return body;
}

/** Structural girder wearing a shattered neon tube that will not die. */
function buildGirder(scene: Scene, mats: CelMaterialFactory): Mesh {
  const metal = mats.get(HULL);
  const column = MeshBuilder.CreateBox(
    "girder",
    { width: 0.7, height: 6.5, depth: 0.7 },
    scene,
  );
  column.position.y = 3.25;
  column.material = metal;

  for (const y of [-2.4, 0.4, 2.6]) {
    const plate = MeshBuilder.CreateBox(
      "girder-plate",
      { width: 1.15, height: 0.28, depth: 1.15 },
      scene,
    );
    plate.parent = column;
    plate.position.y = y;
    plate.material = mats.get(DARK_METAL);
  }

  const tube = MeshBuilder.CreateBox(
    "neon-tube",
    { width: 0.14, height: 2.6, depth: 0.14 },
    scene,
  );
  tube.parent = column;
  tube.position.set(0.44, 1.1, 0.02);
  tube.material = mats.getEmissive("#39f6ff");
  tube.metadata = { noOutline: true };
  return column;
}

/** Dead vending unit with a magenta sign still stuttering away. */
function buildVendor(scene: Scene, mats: CelMaterialFactory): Mesh {
  const shell = MeshBuilder.CreateBox(
    "vendor",
    { width: 1.5, height: 2.6, depth: 0.9 },
    scene,
  );
  shell.position.y = 1.3;
  shell.material = mats.get(HULL);

  const glass = MeshBuilder.CreateBox(
    "vendor-glass",
    { width: 1.1, height: 1.5, depth: 0.12 },
    scene,
  );
  glass.parent = shell;
  glass.position.set(0, 0.2, 0.5);
  glass.material = mats.get(DARK_METAL);

  const sign = MeshBuilder.CreateBox(
    "vendor-sign",
    { width: 1.25, height: 0.4, depth: 0.1 },
    scene,
  );
  sign.parent = shell;
  sign.position.set(0, 1.15, 0.52);
  sign.material = mats.getEmissive("#ff2e97");
  sign.metadata = { noOutline: true };

  const vent = MeshBuilder.CreateBox(
    "vendor-vent",
    { width: 1.2, height: 0.5, depth: 0.14 },
    scene,
  );
  vent.parent = shell;
  vent.position.set(0, -0.9, 0.5);
  vent.material = mats.get("#2f333c");
  return shell;
}

/** Burning drum — the one honest light in the sector. */
function buildFireDrum(scene: Scene, mats: CelMaterialFactory): Mesh {
  const drum = MeshBuilder.CreateCylinder(
    "drum",
    { height: 1.2, diameter: 0.95, tessellation: 8 },
    scene,
  );
  drum.position.y = 0.6;
  drum.material = mats.get(RUST);

  const rim = MeshBuilder.CreateTorus(
    "drum-rim",
    { diameter: 1.0, thickness: 0.1, tessellation: 10 },
    scene,
  );
  rim.parent = drum;
  rim.position.y = 0.55;
  rim.material = mats.get(DARK_METAL);

  const fire = MeshBuilder.CreateCylinder(
    "drum-fire",
    { height: 0.95, diameterTop: 0.06, diameterBottom: 0.72, tessellation: 6 },
    scene,
  );
  fire.parent = drum;
  fire.position.y = 0.9;
  fire.material = mats.getEmissive("#ff8a2a");
  fire.metadata = { noOutline: true };
  return drum;
}

/** Heap of shattered concrete and twisted rebar. */
function buildRubble(scene: Scene, mats: CelMaterialFactory): Mesh {
  const heap = MeshBuilder.CreateBox(
    "rubble",
    { width: 1.9, height: 0.6, depth: 1.6 },
    scene,
  );
  heap.position.y = 0.3;
  heap.rotation.y = Math.random() * Math.PI;
  heap.material = mats.get(CONCRETE);

  for (let i = 0; i < 3; i++) {
    const chunk = MeshBuilder.CreateBox(
      `chunk${i}`,
      { width: 0.7, height: 0.5, depth: 0.6 },
      scene,
    );
    chunk.parent = heap;
    chunk.position.set(
      (Math.random() - 0.5) * 1.2,
      0.4,
      (Math.random() - 0.5) * 1.0,
    );
    chunk.rotation.set(Math.random(), Math.random(), Math.random());
    chunk.material = mats.get("#565a62");
  }

  const rebar = MeshBuilder.CreateCylinder(
    "rebar",
    { height: 1.7, diameterTop: 0.05, diameterBottom: 0.07, tessellation: 4 },
    scene,
  );
  rebar.parent = heap;
  rebar.position.set(0.5, 0.8, -0.3);
  rebar.rotation.z = 0.7;
  rebar.material = mats.get("#6b5c4a");
  return heap;
}

/**
 * Dead Sector: a rain-black service level where the grid mostly failed.
 * Broken neon stutters over wrecks and rubble; fire drums do the rest.
 * Sentry drones sweep, husks shoot from cover, scrap hounds rush.
 * Boss: the Cybernetic Titan — projectile bursts, then dash-charges at low HP.
 */
export const CyberpunkTheme: RoomTheme = {
  name: "Dead Sector",
  environment: {
    floorColor: "#3b3f48",
    wallColor: "#252932",
    wallTrimColor: "#4d3f6e",
    accentColor: "#ff2e97",
    skyColor: "#05060c",
    fogColor: "#090b14",
    fogStart: 18,
    fogEnd: 68,
    mistColor: "#141827",
    mistHeight: 2.2,
    mistStrength: 0.38,
    lighting: {
      color: "#6f7dff",
      intensity: 0.5,
      direction: [0.3, -0.85, -0.35],
      ambientColor: "#171b2b",
      ambientIntensity: 1.0,
      rimColor: "#ff2e97",
      rimIntensity: 0.3,
    },
    particles: {
      color: "#93a0b8",
      emissive: false,
      count: 80,
      size: 0.05,
      riseSpeed: -0.5,
    },
    props: [
      {
        name: "wreck",
        countRange: [4, 7],
        blocking: true,
        radius: 1.8,
        scaleRange: [0.9, 1.2],
        build: buildWreck,
      },
      {
        name: "girder",
        countRange: [4, 7],
        blocking: true,
        radius: 0.55,
        scaleRange: [0.9, 1.5],
        light: {
          color: "#39f6ff",
          range: 15,
          intensity: 1.7,
          offset: [0.44, 4.4, 0],
          flicker: 0.9,
        },
        build: buildGirder,
      },
      {
        name: "vendor",
        countRange: [3, 5],
        blocking: true,
        radius: 0.9,
        scaleRange: [0.9, 1.2],
        light: {
          color: "#ff2e97",
          range: 14,
          intensity: 1.8,
          offset: [0, 2.5, 0.8],
          flicker: 0.75,
        },
        build: buildVendor,
      },
      {
        name: "fire-drum",
        countRange: [2, 4],
        blocking: true,
        radius: 0.6,
        scaleRange: [0.9, 1.2],
        light: {
          color: "#ff8a2a",
          range: 19,
          intensity: 2.6,
          offset: [0, 1.6, 0],
          flicker: 0.4,
        },
        build: buildFireDrum,
      },
      {
        name: "rubble",
        countRange: [5, 9],
        blocking: true,
        radius: 1.1,
        scaleRange: [0.7, 1.4],
        build: buildRubble,
      },
    ],
  },
  enemies: [
    {
      name: "Sentry Drone",
      kind: "flyer",
      body: "sphere",
      color: "#3b4250",
      accentColor: "#7a86a0",
      eyeColor: "#ff2e97",
      scale: 1.05,
      health: 24,
      speed: 5.2,
      damage: 8,
      attackRange: 17,
      attackCooldown: 1.9,
      projectileSpeed: 24,
      projectileColor: "#ff2e97",
    },
    {
      name: "Husk",
      kind: "ranged",
      body: "capsule",
      color: "#2f3a44",
      accentColor: "#6f8fa8",
      eyeColor: "#39f6ff",
      scale: 1.05,
      health: 32,
      speed: 3.6,
      damage: 10,
      attackRange: 19,
      attackCooldown: 2.1,
      projectileSpeed: 22,
      projectileColor: "#39f6ff",
    },
    {
      name: "Scrap Hound",
      kind: "melee",
      body: "quad",
      color: "#43464f",
      accentColor: "#8d939f",
      eyeColor: "#ffb020",
      scale: 1,
      health: 30,
      speed: 7.0,
      damage: 9,
      attackRange: 2.1,
      attackCooldown: 1.1,
    },
  ],
  boss: {
    name: "Cybernetic Titan",
    pattern: "burst",
    color: "#3a4152",
    accentColor: "#6d7893",
    eyeColor: "#ff2e97",
    scale: 1.7,
    health: 500,
    speed: 3.4,
    contactDamage: 18,
    attackCooldown: 2.6,
    projectileSpeed: 26,
    projectileColor: "#ff2e97",
  },
};
