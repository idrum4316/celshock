import { MeshBuilder } from "@babylonjs/core";
import type { RoomTheme } from "./types";

/**
 * Forest: sunlit grove with trees, mossy rocks, and old ruins.
 * Wolves rush in packs while archers snipe from range.
 * Boss: the Treant — ground-slam AOE (jump it!) and sapling minions.
 */
export const ForestTheme: RoomTheme = {
  name: "Forest",
  environment: {
    floorColor: "#4a8f43",
    wallColor: "#2f5d33",
    wallTrimColor: "#6db56a",
    accentColor: "#8fd14f",
    skyColor: "#b8e0c9",
    fogColor: "#a9d4b4",
    fogStart: 30,
    fogEnd: 95,
    lighting: {
      color: "#fff6dc",
      intensity: 1.05,
      direction: [-0.5, -0.9, 0.4],
    },
    props: [
      {
        name: "tree",
        countRange: [6, 10],
        blocking: true,
        radius: 0.6,
        scaleRange: [0.9, 1.5],
        build: (scene, mats) => {
          const trunk = MeshBuilder.CreateCylinder(
            "tree-trunk",
            { height: 2.4, diameter: 0.55, tessellation: 8 },
            scene,
          );
          trunk.position.y = 1.2;
          trunk.material = mats.get("#6b4a2f");
          const canopy = MeshBuilder.CreateSphere(
            "tree-canopy",
            { diameter: 2.6, segments: 8 },
            scene,
          );
          canopy.parent = trunk;
          canopy.position.y = 1.9;
          canopy.material = mats.get("#3f9142");
          return trunk;
        },
      },
      {
        name: "rock",
        countRange: [3, 6],
        blocking: true,
        radius: 0.7,
        scaleRange: [0.7, 1.3],
        build: (scene, mats) => {
          const rock = MeshBuilder.CreateSphere(
            "rock",
            { diameter: 1.4, segments: 6 },
            scene,
          );
          rock.scaling.y = 0.55;
          rock.position.y = 0.35;
          rock.material = mats.get("#8d9291");
          return rock;
        },
      },
      {
        name: "ruin-pillar",
        countRange: [2, 4],
        blocking: true,
        radius: 0.5,
        scaleRange: [0.8, 1.2],
        build: (scene, mats) => {
          const pillar = MeshBuilder.CreateCylinder(
            "ruin-pillar",
            { height: 2.0, diameter: 0.8, tessellation: 7 },
            scene,
          );
          pillar.position.y = 1.0;
          pillar.material = mats.get("#b8b2a2");
          const cap = MeshBuilder.CreateBox(
            "ruin-cap",
            { width: 1.1, height: 0.3, depth: 1.1 },
            scene,
          );
          cap.parent = pillar;
          cap.position.y = 1.1;
          cap.rotation.y = 0.4;
          cap.material = mats.get("#a09a8a");
          return pillar;
        },
      },
    ],
  },
  enemies: [
    {
      name: "Wolf",
      kind: "melee",
      body: "quad",
      color: "#7f8a94",
      accentColor: "#d8dee4",
      scale: 1,
      health: 30,
      speed: 6.5,
      damage: 10,
      attackRange: 2.0,
      attackCooldown: 1.2,
    },
    {
      name: "Archer",
      kind: "ranged",
      body: "capsule",
      color: "#4e6b3a",
      accentColor: "#c2b280",
      scale: 1,
      health: 25,
      speed: 3.5,
      damage: 8,
      attackRange: 16,
      attackCooldown: 2.2,
      projectileSpeed: 18,
      projectileColor: "#8fd14f",
    },
  ],
  boss: {
    name: "Treant",
    pattern: "slam",
    color: "#5b3d26",
    accentColor: "#3f9142",
    scale: 1.6,
    health: 420,
    speed: 2.6,
    contactDamage: 14,
    attackCooldown: 3.2,
    aoeRadius: 6.5,
    aoeDamage: 30,
  },
};
