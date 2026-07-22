import { MeshBuilder } from "@babylonjs/core";
import type { RoomTheme } from "./types";

/**
 * Desert: sun-bleached dunes with cacti, sandstone monoliths, and pyramids.
 * Scorpions skitter in close while bandits take potshots.
 * Boss: the Sand Worm — burrows underground and erupts beneath your feet.
 */
export const DesertTheme: RoomTheme = {
  name: "Desert",
  environment: {
    floorColor: "#d9b166",
    wallColor: "#c19a52",
    wallTrimColor: "#8a6a34",
    accentColor: "#ff8c42",
    skyColor: "#f2ddae",
    fogColor: "#e8d3a0",
    fogStart: 32,
    fogEnd: 100,
    lighting: {
      color: "#fff1c9",
      intensity: 1.15,
      direction: [-0.6, -0.8, 0.2],
    },
    props: [
      {
        name: "cactus",
        countRange: [4, 8],
        blocking: true,
        radius: 0.4,
        scaleRange: [0.8, 1.4],
        build: (scene, mats) => {
          const body = MeshBuilder.CreateCylinder(
            "cactus-body",
            { height: 2.2, diameter: 0.55, tessellation: 8 },
            scene,
          );
          body.position.y = 1.1;
          body.material = mats.get("#4f8f4a");
          for (const [sideSign, y] of [
            [-1, 0.2],
            [1, 0.55],
          ] as const) {
            const arm = MeshBuilder.CreateCylinder(
              "cactus-arm",
              { height: 0.9, diameter: 0.32, tessellation: 6 },
              scene,
            );
            arm.parent = body;
            arm.position.set(0.45 * sideSign, y, 0);
            arm.rotation.z = sideSign * 0.9;
            arm.material = mats.get("#4f8f4a");
          }
          return body;
        },
      },
      {
        name: "pyramid",
        countRange: [1, 3],
        blocking: true,
        radius: 1.5,
        scaleRange: [1.0, 1.6],
        build: (scene, mats) => {
          const pyramid = MeshBuilder.CreateCylinder(
            "pyramid",
            { height: 2.4, diameterBottom: 3.2, diameterTop: 0, tessellation: 4 },
            scene,
          );
          pyramid.position.y = 1.2;
          pyramid.rotation.y = Math.PI / 4;
          pyramid.material = mats.get("#c9a35f");
          return pyramid;
        },
      },
      {
        name: "sandstone",
        countRange: [3, 6],
        blocking: true,
        radius: 0.7,
        scaleRange: [0.7, 1.2],
        build: (scene, mats) => {
          const rock = MeshBuilder.CreateSphere(
            "sandstone",
            { diameter: 1.5, segments: 5 },
            scene,
          );
          rock.scaling.y = 0.6;
          rock.position.y = 0.4;
          rock.material = mats.get("#b5936b");
          return rock;
        },
      },
    ],
  },
  enemies: [
    {
      name: "Scorpion",
      kind: "melee",
      body: "quad",
      color: "#8a4b2d",
      accentColor: "#d9b166",
      scale: 1,
      health: 26,
      speed: 7.0,
      damage: 9,
      attackRange: 1.9,
      attackCooldown: 1.1,
    },
    {
      name: "Bandit",
      kind: "ranged",
      body: "capsule",
      color: "#a3773f",
      accentColor: "#5c4326",
      scale: 1,
      health: 30,
      speed: 4.2,
      damage: 10,
      attackRange: 15,
      attackCooldown: 2.4,
      projectileSpeed: 17,
      projectileColor: "#ffd23f",
    },
  ],
  boss: {
    name: "Sand Worm",
    pattern: "burrow",
    color: "#b98c4f",
    accentColor: "#ff8c42",
    scale: 1.4,
    health: 480,
    speed: 3.2,
    contactDamage: 16,
    attackCooldown: 0.9,
    projectileSpeed: 15,
    projectileColor: "#e0c37a",
    aoeRadius: 5.0,
    aoeDamage: 28,
  },
};
