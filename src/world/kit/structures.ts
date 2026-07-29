/**
 * kit/structures.ts — Small standalone structures and cover: silo, well,
 * stall, fence, bridge, haystack, lamp post. All follow the contract in
 * kit/core.ts (origin-local geometry, no solid/pickable/collisions metadata).
 */
import { Scene } from "@babylonjs/core";
import type { CelMaterialFactory } from "../../shaders/CelShader";
import {
  Build,
  type BuildParams,
  type Structure,
  DARK_STONE,
  FLAME,
  IRON,
  PLANK,
  STONE,
  THATCH,
  TIMBER,
  SLATE,
} from "./core";

/** Grain silo: a tall corrugated cylinder. Pure cover, not enterable. */
export function buildSilo(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "silo");
  const h = 12;
  const dia = 6;
  b.cyl(h, dia, dia * 1.06, 10, 0, h / 2, 0, DARK_STONE);
  for (let i = 1; i < 5; i++) {
    b.cyl(0.25, dia * 1.05, dia * 1.05, 10, 0, (i * h) / 5, 0, IRON);
  }
  b.cyl(2.4, 0.6, dia * 1.02, 10, 0, h + 1.2, 0, SLATE);
  b.block({ w: dia, h, d: dia, x: 0, y: h / 2, z: 0 });
  return b;
}

/** Stone well — the Square's centrepiece and flag C's anchor. */
export function buildWell(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "well");
  b.cyl(1.5, 3.2, 3.4, 10, 0, 0.75, 0, STONE);
  b.cyl(0.3, 2.6, 2.6, 10, 0, 1.5, 0, DARK_STONE);
  b.block({ w: 3.4, h: 1.5, d: 3.4, x: 0, y: 0.75, z: 0 });
  for (const sx of [-1, 1]) {
    b.box(0.28, 3.2, 0.28, sx * 1.3, 2.9, 0, TIMBER);
  }
  b.box(3.4, 0.3, 0.9, 0, 4.4, 0, PLANK); // roof over the shaft
  b.cyl(2.4, 0.4, 0.4, 6, 0, 3.8, 0, TIMBER, { z: Math.PI / 2 }); // windlass
  return b;
}

/** Market stall: a plank counter under a sagging awning. Waist-high cover. */
export function buildStall(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "stall");
  b.wall(3.4, 1.1, 1.5, 0, 0.55, 0, PLANK);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(0.16, 2.6, 0.16, sx * 1.6, 1.3, sz * 0.7, TIMBER);
    }
  }
  b.box(4, 0.14, 2.2, 0, 2.6, 0, THATCH, { x: 0.14 });
  return b;
}

/** Post-and-rail fence run along X. Blocks movement, not sight. */
export function buildFence(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "fence");
  const len = p.length ?? 10;
  const posts = Math.max(2, Math.round(len / 2.5));
  for (let i = 0; i <= posts; i++) {
    const x = -len / 2 + (i / posts) * len;
    b.box(0.18, 1.5, 0.18, x, 0.75, 0, TIMBER);
  }
  b.box(len, 0.12, 0.1, 0, 1.2, 0, TIMBER);
  b.box(len, 0.12, 0.1, 0, 0.6, 0, TIMBER);
  b.block({ w: len, h: 1.4, d: 0.4, x: 0, y: 0.7, z: 0 });
  return b;
}

/**
 * Plank footbridge over the creek, running along Z. The deck is a walkable
 * collider, so the ground probe finds it.
 */
export function buildBridge(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "bridge");
  const len = p.length ?? 12;
  const w = p.width ?? 3.2;
  b.box(w, 0.28, len, 0, 0, 0, PLANK);
  b.block({ w, h: 0.28, d: len, x: 0, y: 0, z: 0 });
  for (const sx of [-1, 1]) {
    b.box(0.16, 1.1, len, (sx * w) / 2, 0.55, 0, TIMBER);
    const posts = Math.round(len / 3);
    for (let i = 0; i <= posts; i++) {
      b.box(0.2, 1.2, 0.2, (sx * w) / 2, 0.6, -len / 2 + (i / posts) * len, TIMBER);
    }
  }
  return b;
}

/** Haystack — soft cover in the paddocks. */
export function buildHaystack(
  scene: Scene,
  mats: CelMaterialFactory,
): Structure {
  const b = new Build(scene, mats, "haystack");
  b.cyl(2.2, 2.6, 3.2, 7, 0, 1.1, 0, THATCH);
  b.cyl(1.4, 0.2, 2.6, 7, 0, 2.9, 0, THATCH);
  b.block({ w: 3.2, h: 2.2, d: 3.2, x: 0, y: 1.1, z: 0 });
  return b;
}

/** Iron lamp post, the village's standard fixture. Carries a light. */
export function buildLampPost(
  scene: Scene,
  mats: CelMaterialFactory,
): Structure {
  const b = new Build(scene, mats, "lamp");
  b.cyl(4, 0.14, 0.26, 6, 0, 2, 0, IRON);
  b.box(0.9, 0.1, 0.1, 0.35, 3.75, 0, IRON);
  b.cyl(0.62, 0.42, 0.3, 6, 0.75, 3.45, 0, IRON);
  b.glow(0.3, 0.3, 0.3, 0.75, 3.45, 0, FLAME);
  b.cyl(0.18, 0.1, 0.5, 6, 0.75, 3.85, 0, IRON);
  b.block({ w: 0.5, h: 4, d: 0.5, x: 0, y: 2, z: 0 });
  b.light(FLAME, 22, 2.2, 0.35, 0.75, 3.45, 0);
  return b;
}
