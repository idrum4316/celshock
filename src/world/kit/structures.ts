/**
 * kit/structures.ts — Small standalone structures and cover: silo, well,
 * stall, fence, stone wall, bridge, haystack, lamp post, cart, crates,
 * woodpile, shed, trough, shrine, kiln. All follow the contract in
 * kit/core.ts (origin-local geometry, no solid/pickable/collisions metadata).
 *
 * Cover vocabulary, so a layout can pick the right height deliberately:
 * fence and trough are *low* (step over with the eyes, not the body), cart,
 * crates, woodpile and haystack are *waist/chest* high cover you crouch
 * behind, and stone wall, shed, silo and kiln break sightlines outright.
 */
import { Scene } from "@babylonjs/core";
import type { CelMaterialFactory } from "../../shaders/CelShader";
import {
  Build,
  type BuildParams,
  type Structure,
  BRICK,
  DARK_STONE,
  EMBER,
  FLAME,
  IRON,
  MOSS_STONE,
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
 * Dry-stone field wall run along X. Unlike `fence` this is chest-high and
 * opaque: it breaks a sightline rather than just a walking line, which is what
 * turns open ground into a fight instead of a shooting gallery. Author it in
 * runs with gaps — a sealed field is a wall the nav grid routes bots all the
 * way around.
 */
export function buildStoneWall(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "stonewall");
  const len = p.length ?? 12;
  const h = p.height ?? 1.5;
  b.wall(len, h, 0.5, 0, h / 2, 0, MOSS_STONE);
  // Capstones, and a stouter pier every few metres: the silhouette is what
  // sells dry stone, since the shader gives it no texture.
  b.box(len, 0.18, 0.66, 0, h + 0.09, 0, DARK_STONE);
  const piers = Math.max(1, Math.round(len / 5));
  for (let i = 0; i <= piers; i++) {
    const x = -len / 2 + (i / piers) * len;
    b.box(0.7, h + 0.35, 0.72, x, (h + 0.35) / 2, 0, MOSS_STONE);
  }
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

/**
 * Farm cart, bed along X. Chest-high cover with a readable silhouette — the
 * staves and the raised shafts break up the box so it never reads as a crate.
 * `ruined` drops it on a broken axle, for ground that has already been fought
 * over.
 */
export function buildCart(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "cart");
  const tilt = p.ruined ? 0.22 : 0;
  const bedY = p.ruined ? 0.85 : 1.0;
  b.box(3.2, 0.3, 1.6, 0, bedY, 0, PLANK, { z: tilt });
  // Side and end boards.
  for (const sz of [-1, 1]) {
    b.box(3.2, 0.75, 0.14, 0, bedY + 0.5, sz * 0.8, PLANK, { z: tilt });
  }
  b.box(0.14, 0.75, 1.6, -1.6, bedY + 0.5, 0, PLANK, { z: tilt });
  // Wheels: flat discs on an axle, the cheapest thing that reads as a cart.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const broken = p.ruined && sx < 0 && sz < 0;
      b.cyl(
        0.18,
        broken ? 0.5 : 1.15,
        broken ? 0.5 : 1.15,
        broken ? 6 : 9,
        sx * 1.1,
        broken ? 0.25 : 0.6,
        sz * 0.9,
        TIMBER,
        { z: Math.PI / 2, x: broken ? 0.9 : 0 },
      );
    }
  }
  b.cyl(2.0, 0.16, 0.16, 6, 0, 0.6, 0, IRON, { z: Math.PI / 2 });
  // Shafts, raised as if the horse were unhitched in a hurry.
  for (const sz of [-1, 1]) {
    b.box(2.4, 0.14, 0.14, 2.5, bedY + 0.55, sz * 0.55, TIMBER, { z: 0.28 });
  }
  b.block({ w: 3.4, h: 1.7, d: 2.0, x: 0, y: 0.85, z: 0 });
  return b;
}

/** Stack of crates and barrels — waist-to-chest cover for yards and docks. */
export function buildCrates(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "crates");
  b.box(1.5, 1.2, 1.4, -0.6, 0.6, 0, PLANK);
  b.box(1.3, 1.1, 1.3, 0.8, 0.55, 0.3, TIMBER);
  b.box(1.2, 1.0, 1.1, -0.35, 1.7, -0.15, TIMBER, { y: 0.4 });
  // Barrel leaning against the stack.
  b.cyl(1.3, 0.85, 0.95, 8, 0.9, 0.65, -0.9, PLANK);
  for (const y of [0.35, 0.95]) {
    b.cyl(0.12, 0.99, 0.99, 8, 0.9, y, -0.9, IRON);
  }
  b.block({ w: 3.2, h: 2.3, d: 2.6, x: 0.1, y: 1.15, z: 0 });
  return b;
}

/** Split logs stacked between end posts. Long, low, and cheap to author. */
export function buildWoodpile(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "woodpile");
  const len = p.length ?? 5;
  const rows = 3;
  for (let row = 0; row < rows; row++) {
    const y = 0.35 + row * 0.62;
    // Alternate the stagger per row so the stack doesn't read as a grid.
    for (const sz of [-1, 1]) {
      b.cyl(len - row * 0.4, 0.6, 0.62, 7, 0, y, sz * 0.36, TIMBER, {
        z: Math.PI / 2,
      });
    }
  }
  for (const sx of [-1, 1]) {
    b.box(0.2, 2.4, 0.2, (sx * len) / 2, 1.2, 0, PLANK);
  }
  b.block({ w: len, h: 1.9, d: 1.3, x: 0, y: 0.95, z: 0 });
  return b;
}

/** Lean-to shed: a plank shack with a mono-pitch roof. Solid, never enterable. */
export function buildShed(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "shed");
  const w = p.width ?? 3.4;
  const d = p.depth ?? 2.8;
  const h = p.height ?? 2.6;
  b.box(w, h, d, 0, h / 2, 0, PLANK);
  b.block({ w, h, d, x: 0, y: h / 2, z: 0 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(0.2, h, 0.2, (sx * w) / 2, h / 2, (sz * d) / 2, TIMBER);
    }
  }
  // Mono-pitch roof, falling towards -Z.
  const rise = 0.7;
  const slope = Math.atan2(rise, d);
  b.box(w + 0.5, 0.16, d / Math.cos(slope) + 0.5, 0, h + rise / 2, 0, THATCH, {
    x: -slope,
  });
  b.box(w * 0.45, h * 0.7, 0.1, 0, h * 0.4, -d / 2 - 0.06, TIMBER); // door
  return b;
}

/** Stone water trough and hitching rail. Low cover — cross it, don't hide. */
export function buildTrough(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "trough");
  b.box(3.0, 0.7, 1.1, 0, 0.35, 0, STONE);
  for (const sx of [-1, 1]) {
    b.box(0.18, 0.34, 1.1, (sx * 3.0) / 2, 0.87, 0, STONE);
  }
  for (const sz of [-1, 1]) {
    b.box(3.0, 0.34, 0.18, 0, 0.87, (sz * 1.1) / 2, STONE);
  }
  b.box(2.6, 0.06, 0.8, 0, 0.88, 0, DARK_STONE); // standing water
  b.block({ w: 3.0, h: 1.0, d: 1.1, x: 0, y: 0.5, z: 0 });
  // Hitching rail behind it.
  for (const sx of [-1, 1]) {
    b.box(0.16, 1.4, 0.16, sx * 1.3, 0.7, 1.6, TIMBER);
  }
  b.box(3.0, 0.14, 0.12, 0, 1.25, 1.6, TIMBER);
  b.block({ w: 3.0, h: 1.4, d: 0.4, x: 0, y: 0.7, z: 1.6 });
  return b;
}

/**
 * Roadside shrine: a stone pillar with a lit niche. Carries a small light, so
 * keep them spread — every one competes for a shader slot with the lamps.
 */
export function buildShrine(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "shrine");
  b.box(1.5, 0.4, 1.5, 0, 0.2, 0, DARK_STONE);
  b.box(1.0, 1.8, 1.0, 0, 1.3, 0, MOSS_STONE);
  // The niche: a shallow recess read as two jambs and a hood.
  for (const sx of [-1, 1]) {
    b.box(0.28, 0.8, 0.2, sx * 0.36, 1.9, -0.5, MOSS_STONE);
  }
  b.box(1.1, 0.22, 0.34, 0, 2.35, -0.45, DARK_STONE);
  b.glow(0.34, 0.5, 0.12, 0, 1.85, -0.52, FLAME);
  b.cyl(0.7, 0.28, 0.9, 4, 0, 2.55, 0, SLATE); // capstone
  b.block({ w: 1.5, h: 2.6, d: 1.5, x: 0, y: 1.3, z: 0 });
  b.light(FLAME, 12, 1.3, 0.5, 0, 1.9, -0.6);
  return b;
}

/**
 * Charcoal kiln: a squat brick dome with its mouth still burning. A landmark
 * for the woods, and one of the few warm lights outside the village.
 */
export function buildKiln(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "kiln");
  b.cyl(2.6, 3.0, 3.8, 9, 0, 1.3, 0, BRICK);
  b.cyl(1.1, 1.3, 3.0, 9, 0, 3.15, 0, BRICK);
  for (const y of [0.8, 1.9]) {
    b.cyl(0.16, 3.6, 3.6, 9, 0, y, 0, IRON);
  }
  b.cyl(0.5, 1.5, 1.1, 8, 0, 3.9, 0, IRON); // chimney collar
  // Stoke hole, facing -Z.
  b.box(1.0, 1.0, 0.3, 0, 0.55, -1.65, DARK_STONE);
  b.glow(0.62, 0.62, 0.14, 0, 0.55, -1.78, EMBER);
  b.block({ w: 3.8, h: 3.6, d: 3.8, x: 0, y: 1.8, z: 0 });
  b.light(EMBER, 17, 1.9, 0.42, 0, 0.8, -2.0);
  return b;
}
