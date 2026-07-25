import { Mesh, MeshBuilder, Scene } from "@babylonjs/core";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { RoomTheme } from "./types";

const BONE = "#c9bda2";
const OLD_BONE = "#9c9078";
const SANDSTONE = "#7d6a52";
const CHARRED = "#4a3d33";

/** Ribcage arch — two curved tusks meeting over a buried spine. */
function buildBoneArch(scene: Scene, mats: CelMaterialFactory): Mesh {
  const boneMat = mats.get(BONE);
  const spine = MeshBuilder.CreateBox(
    "arch-spine",
    { width: 0.5, height: 0.4, depth: 3.4 },
    scene,
  );
  spine.position.y = 0.2;
  spine.material = mats.get(OLD_BONE);

  for (let i = 0; i < 4; i++) {
    const z = -1.2 + i * 0.8;
    const scale = 1 - Math.abs(i - 1.5) * 0.12;
    for (const side of [-1, 1]) {
      const rib = MeshBuilder.CreateCylinder(
        `rib${i}${side}`,
        { height: 3.4 * scale, diameterTop: 0.14, diameterBottom: 0.3, tessellation: 5 },
        scene,
      );
      rib.parent = spine;
      rib.position.set(side * 0.9 * scale, 1.5 * scale, z);
      rib.rotation.z = side * 0.55;
      rib.material = boneMat;
    }
  }
  return spine;
}

/** Heap of skulls and long bones, picked clean. */
function buildSkullPile(scene: Scene, mats: CelMaterialFactory): Mesh {
  const heap = MeshBuilder.CreateSphere(
    "skull-pile",
    { diameter: 1.9, segments: 6 },
    scene,
  );
  heap.scaling.y = 0.5;
  heap.position.y = 0.35;
  heap.material = mats.get(OLD_BONE);

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.random();
    const skull = MeshBuilder.CreateSphere(
      `skull${i}`,
      { diameter: 0.46, segments: 5 },
      scene,
    );
    skull.parent = heap;
    skull.position.set(Math.cos(a) * 0.6, 0.65 + Math.random() * 0.4, Math.sin(a) * 0.6);
    skull.rotation.y = Math.random() * Math.PI;
    skull.material = mats.get(BONE);

    const jaw = MeshBuilder.CreateBox(
      `skull-jaw${i}`,
      { width: 0.3, height: 0.12, depth: 0.34 },
      scene,
    );
    jaw.parent = skull;
    jaw.position.set(0, -0.2, 0.06);
    jaw.material = mats.get(BONE);
  }
  return heap;
}

/** Carved obelisk whose glyphs still hold a dull red charge. */
function buildObelisk(scene: Scene, mats: CelMaterialFactory): Mesh {
  const stone = mats.get(SANDSTONE);
  const shaft = MeshBuilder.CreateCylinder(
    "obelisk",
    { height: 4.6, diameterTop: 0.5, diameterBottom: 1.0, tessellation: 4 },
    scene,
  );
  shaft.position.y = 2.3;
  shaft.rotation.y = Math.random() * Math.PI;
  shaft.rotation.z = (Math.random() - 0.5) * 0.12;
  shaft.material = stone;

  const base = MeshBuilder.CreateBox(
    "obelisk-base",
    { width: 1.5, height: 0.45, depth: 1.5 },
    scene,
  );
  base.parent = shaft;
  base.position.y = -2.3;
  base.rotation.y = 0.4;
  base.material = mats.get("#6a5a45");

  for (let i = 0; i < 3; i++) {
    const glyph = MeshBuilder.CreateBox(
      `glyph${i}`,
      { width: 0.34, height: 0.34, depth: 0.08 },
      scene,
    );
    glyph.parent = shaft;
    glyph.position.set(0, -0.9 + i * 0.9, 0.36 - i * 0.03);
    glyph.rotation.z = Math.PI / 4;
    glyph.material = mats.getEmissive("#ff4a2f");
    glyph.metadata = { noOutline: true };
  }
  return shaft;
}

/** Iron brazier burning something that should have gone out long ago. */
function buildBrazier(scene: Scene, mats: CelMaterialFactory): Mesh {
  const iron = mats.get(CHARRED);
  const bowl = MeshBuilder.CreateCylinder(
    "brazier-bowl",
    { height: 0.65, diameterTop: 1.25, diameterBottom: 0.55, tessellation: 8 },
    scene,
  );
  bowl.position.y = 1.35;
  bowl.material = iron;

  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = MeshBuilder.CreateCylinder(
      `brazier-leg${i}`,
      { height: 1.5, diameterTop: 0.16, diameterBottom: 0.1, tessellation: 4 },
      scene,
    );
    leg.parent = bowl;
    leg.position.set(Math.cos(a) * 0.42, -0.85, Math.sin(a) * 0.42);
    leg.rotation.z = -Math.cos(a) * 0.22;
    leg.rotation.x = Math.sin(a) * 0.22;
    leg.material = iron;
  }

  const fire = MeshBuilder.CreateCylinder(
    "brazier-fire",
    { height: 1.15, diameterTop: 0.05, diameterBottom: 0.95, tessellation: 6 },
    scene,
  );
  fire.parent = bowl;
  fire.position.y = 0.6;
  fire.material = mats.getEmissive("#ff7a2a");
  fire.metadata = { noOutline: true };
  return bowl;
}

/** Sun-split driftwood, dry as paper. */
function buildDriftwood(scene: Scene, mats: CelMaterialFactory): Mesh {
  const trunk = MeshBuilder.CreateCylinder(
    "driftwood",
    { height: 2.6, diameterTop: 0.22, diameterBottom: 0.42, tessellation: 5 },
    scene,
  );
  trunk.rotation.z = 1.35;
  trunk.position.y = 0.4;
  trunk.material = mats.get(CHARRED);

  for (let i = 0; i < 2; i++) {
    const limb = MeshBuilder.CreateCylinder(
      `driftwood-limb${i}`,
      { height: 1.3, diameterTop: 0.05, diameterBottom: 0.18, tessellation: 4 },
      scene,
    );
    limb.parent = trunk;
    limb.position.set(0, 0.4 - i * 0.9, 0.1);
    limb.rotation.x = 0.8 + i * 0.5;
    limb.material = mats.get("#5b4c3f");
  }
  return trunk;
}

/**
 * Ashen Wastes: a boneyard under a blood moon, where the dunes are ash and
 * the only landmarks are ribcages and burning braziers.
 * Carrion scorpions skitter in, ash bandits snipe, dust wraiths drift.
 * Boss: the Sand Worm — burrows and erupts underneath you.
 */
export const DesertTheme: RoomTheme = {
  name: "Ashen Wastes",
  environment: {
    floorColor: "#5e5347",
    wallColor: "#3c342c",
    wallTrimColor: "#7d7263",
    accentColor: "#ff6a4a",
    skyColor: "#170a09",
    fogColor: "#241110",
    fogStart: 22,
    fogEnd: 82,
    mistColor: "#33221c",
    mistHeight: 1.9,
    mistStrength: 0.38,
    lighting: {
      color: "#ff8f6a",
      intensity: 0.6,
      direction: [0.4, -0.8, 0.3],
      ambientColor: "#2b1a15",
      ambientIntensity: 1.0,
      rimColor: "#ff9a70",
      rimIntensity: 0.4,
    },
    particles: {
      color: "#ff8a3c",
      emissive: true,
      count: 70,
      size: 0.06,
      riseSpeed: 0.55,
    },
    props: [
      {
        name: "bone-arch",
        countRange: [3, 6],
        blocking: true,
        radius: 1.5,
        scaleRange: [0.9, 1.6],
        build: buildBoneArch,
      },
      {
        name: "skull-pile",
        countRange: [4, 7],
        blocking: true,
        radius: 1.0,
        scaleRange: [0.8, 1.4],
        build: buildSkullPile,
      },
      {
        name: "obelisk",
        countRange: [3, 5],
        blocking: true,
        radius: 0.7,
        scaleRange: [0.9, 1.5],
        light: {
          color: "#ff4a2f",
          range: 12,
          intensity: 1.3,
          offset: [0, 2.2, 0.4],
          flicker: 0.15,
        },
        build: buildObelisk,
      },
      {
        name: "brazier",
        countRange: [3, 5],
        blocking: true,
        radius: 0.65,
        scaleRange: [0.9, 1.3],
        light: {
          color: "#ff7a2a",
          range: 21,
          intensity: 2.7,
          offset: [0, 2.1, 0],
          flicker: 0.4,
        },
        build: buildBrazier,
      },
      {
        name: "driftwood",
        countRange: [4, 7],
        blocking: false,
        radius: 1.2,
        scaleRange: [0.8, 1.3],
        build: buildDriftwood,
      },
    ],
  },
  enemies: [
    {
      name: "Carrion Scorpion",
      kind: "melee",
      body: "quad",
      color: "#6b4a35",
      accentColor: "#c9a878",
      eyeColor: "#ffd23c",
      scale: 1.1,
      health: 36,
      speed: 6.2,
      damage: 11,
      attackRange: 2.3,
      attackCooldown: 1.3,
    },
    {
      name: "Ash Bandit",
      kind: "ranged",
      body: "capsule",
      color: "#5a4a3c",
      accentColor: "#b9a488",
      eyeColor: "#ff8a3c",
      scale: 1.05,
      health: 30,
      speed: 3.8,
      damage: 10,
      attackRange: 20,
      attackCooldown: 2.0,
      projectileSpeed: 23,
      projectileColor: "#ffb43c",
    },
    {
      name: "Dust Wraith",
      kind: "flyer",
      body: "wraith",
      color: "#4a3b32",
      accentColor: "#b4a08a",
      eyeColor: "#ff4a2f",
      scale: 1.1,
      health: 28,
      speed: 4.4,
      damage: 12,
      attackRange: 16,
      attackCooldown: 2.5,
      projectileSpeed: 17,
      projectileColor: "#ff6a3c",
    },
  ],
  boss: {
    name: "Sand Worm",
    pattern: "burrow",
    color: "#6a5340",
    accentColor: "#bfa88a",
    eyeColor: "#ff4a2f",
    scale: 1.7,
    health: 480,
    speed: 3.0,
    contactDamage: 20,
    attackCooldown: 1.5,
    projectileSpeed: 19,
    projectileColor: "#ffb43c",
    aoeRadius: 6.5,
    aoeDamage: 30,
  },
};
