import { MeshBuilder } from "@babylonjs/core";
import type { RoomTheme } from "./types";

/**
 * Cyberpunk: a dark neon plaza — glowing pillars, holo-signs, cargo crates.
 * Drones swarm from the air while hackers lob heavy plasma.
 * Boss: the Cybernetic Titan — projectile bursts, then dash-charges at low HP.
 */
export const CyberpunkTheme: RoomTheme = {
  name: "Cyberpunk",
  environment: {
    floorColor: "#23243d",
    wallColor: "#181a30",
    wallTrimColor: "#35f0ff",
    accentColor: "#ff2e97",
    skyColor: "#0a0a16",
    fogColor: "#141230",
    fogStart: 24,
    fogEnd: 80,
    lighting: {
      color: "#b9c8ff",
      intensity: 0.85,
      direction: [-0.3, -0.85, 0.5],
    },
    props: [
      {
        name: "neon-pillar",
        countRange: [4, 7],
        blocking: true,
        radius: 0.6,
        scaleRange: [0.9, 1.4],
        build: (scene, mats) => {
          const pillar = MeshBuilder.CreateBox(
            "neon-pillar",
            { width: 0.7, height: 4.2, depth: 0.7 },
            scene,
          );
          pillar.position.y = 2.1;
          pillar.material = mats.get("#2a2d4a");
          const strip = MeshBuilder.CreateBox(
            "neon-strip",
            { width: 0.16, height: 3.8, depth: 0.1 },
            scene,
          );
          strip.parent = pillar;
          strip.position.z = 0.4;
          strip.material = mats.getEmissive("#35f0ff");
          return pillar;
        },
      },
      {
        name: "holo-sign",
        countRange: [2, 4],
        blocking: true,
        radius: 0.35,
        scaleRange: [0.9, 1.2],
        build: (scene, mats) => {
          const pole = MeshBuilder.CreateCylinder(
            "holo-pole",
            { height: 3.2, diameter: 0.25, tessellation: 8 },
            scene,
          );
          pole.position.y = 1.6;
          pole.material = mats.get("#3a3f5c");
          const sign = MeshBuilder.CreateBox(
            "holo-panel",
            { width: 2.0, height: 1.1, depth: 0.08 },
            scene,
          );
          sign.parent = pole;
          sign.position.y = 1.4;
          sign.material = mats.getEmissive("#ff2e97");
          return pole;
        },
      },
      {
        name: "cargo-crate",
        countRange: [3, 6],
        blocking: true,
        radius: 0.85,
        scaleRange: [0.8, 1.3],
        build: (scene, mats) => {
          const crate = MeshBuilder.CreateBox(
            "cargo-crate",
            { width: 1.4, height: 1.2, depth: 1.4 },
            scene,
          );
          crate.position.y = 0.6;
          crate.material = mats.get("#2d3250");
          const stripe = MeshBuilder.CreateBox(
            "crate-stripe",
            { width: 1.45, height: 0.18, depth: 1.45 },
            scene,
          );
          stripe.parent = crate;
          stripe.position.y = 0.25;
          stripe.material = mats.getEmissive("#ffb400");
          return crate;
        },
      },
    ],
  },
  enemies: [
    {
      name: "Drone",
      kind: "flyer",
      body: "sphere",
      color: "#2b3a4d",
      accentColor: "#35f0ff",
      scale: 1,
      health: 20,
      speed: 5.0,
      damage: 7,
      attackRange: 14,
      attackCooldown: 1.8,
      projectileSpeed: 22,
      projectileColor: "#35f0ff",
    },
    {
      name: "Hacker",
      kind: "ranged",
      body: "capsule",
      color: "#3a2d5f",
      accentColor: "#ff2e97",
      scale: 1,
      health: 35,
      speed: 4.0,
      damage: 12,
      attackRange: 15,
      attackCooldown: 2.6,
      projectileSpeed: 15,
      projectileColor: "#ff2e97",
    },
  ],
  boss: {
    name: "Cybernetic Titan",
    pattern: "burst",
    color: "#444a66",
    accentColor: "#35f0ff",
    scale: 1.5,
    health: 460,
    speed: 4.2,
    contactDamage: 24,
    attackCooldown: 2.6,
    projectileSpeed: 20,
    projectileColor: "#ff2e97",
  },
};
