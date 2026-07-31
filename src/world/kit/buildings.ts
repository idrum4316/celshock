/**
 * kit/buildings.ts — The big enterable/landmark buildings: cottage, townhouse,
 * tavern, smithy, ruin, watchtower, chapel, barn, mill, boathouse, gatehouse.
 * All follow the contract in kit/core.ts (origin-local geometry, no
 * solid/pickable/collisions metadata).
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
  PLASTER,
  SLATE,
  STONE,
  THATCH,
  TIMBER,
} from "./core";

/**
 * Village house: plaster over a timber frame, gabled roof, a couple of lit
 * windows. The workhorse — most of Hollowmere is these at varying sizes.
 *
 * Solid by default. Enterable cottages cost four extra colliders and a hole in
 * the nav grid, so only the ones worth fighting over get interiors.
 */
export function buildCottage(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const w = p.width ?? 7;
  const d = p.depth ?? 6;
  const h = p.height ?? 3.4;
  const b = new Build(scene, mats, "cottage");
  const t = 0.35;

  if (p.enterable) {
    b.box(w, 0.2, d, 0, 0.1, 0, PLANK); // floor
    b.doorWall(w, h, t, 0, h / 2, -d / 2, PLASTER, 1.6, 2.2);
    b.wall(w, h, t, 0, h / 2, d / 2, PLASTER);
    b.wall(t, h, d, -w / 2, h / 2, 0, PLASTER);
    b.wall(t, h, d, w / 2, h / 2, 0, PLASTER);
  } else {
    // A solid block reads identically from outside and costs one collider.
    b.box(w, h, d, 0, h / 2, 0, PLASTER);
    b.block({ w, h, d, x: 0, y: h / 2, z: 0 });
  }

  // Corner posts and a sill beam — the timber framing that sells the period.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(0.28, h, 0.28, (sx * w) / 2, h / 2, (sz * d) / 2, TIMBER);
    }
  }
  b.box(w + 0.1, 0.24, 0.24, 0, h * 0.62, -d / 2, TIMBER);
  b.box(w + 0.1, 0.24, 0.24, 0, h * 0.62, d / 2, TIMBER);
  b.box(w + 0.4, 0.3, d + 0.4, 0, 0.15, 0, DARK_STONE); // plinth

  if (p.ruined) {
    // Collapsed roof: one slope only, and a broken gable.
    b.box(w * 0.7, 0.18, d + 0.6, -w * 0.18, h + 0.5, 0, THATCH, { z: -0.5 });
    b.box(w, 0.9, 0.16, 0, h + 0.45, d / 2, PLASTER);
    b.block({ w: w + 0.6, h: 0.3, d: d + 0.6, x: 0, y: h, z: 0 });
  } else {
    b.gableRoof(w, d, 1.5, 0, h, 0, THATCH);
  }

  if (p.litWindows) {
    for (const sx of [-1, 1]) {
      b.glow(0.7, 0.8, 0.06, (sx * w) / 4, h * 0.55, -d / 2 - t / 2, "#ffb257");
    }
  }
  return b;
}

/**
 * Two-storey townhouse: a jettied upper floor oversailing the ground floor,
 * close-studded timber framing, steep slate roof, brick stack.
 *
 * The cottage is a village silhouette; this is a *street* silhouette — taller
 * than it is wide, so a row of them walls a lane in and gives the square an
 * actual skyline. `enterable` hollows the ground floor only; the upper storey
 * is the ceiling.
 */
export function buildTownhouse(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "townhouse");
  const w = p.width ?? 6.5;
  const d = p.depth ?? 6.5;
  const h = p.height ?? 6.8;
  const t = 0.35;
  const g = 3.3; // ground-floor ceiling
  const up = h - g; // upper storey
  const jut = 0.45; // how far the upper floor oversails

  b.box(w + 0.5, 0.3, d + 0.5, 0, 0.15, 0, DARK_STONE); // plinth
  if (p.enterable) {
    b.box(w, 0.2, d, 0, 0.2, 0, PLANK);
    b.doorWall(w, g, t, 0, g / 2, -d / 2, PLASTER, 1.6, 2.3);
    b.wall(w, g, t, 0, g / 2, d / 2, PLASTER);
    b.wall(t, g, d, -w / 2, g / 2, 0, PLASTER);
    b.wall(t, g, d, w / 2, g / 2, 0, PLASTER);
    // The upper floor doubles as the ceiling slab.
    b.wall(w + jut * 2, up, d + jut * 2, 0, g + up / 2, 0, PLASTER);
  } else {
    b.box(w, g, d, 0, g / 2, 0, PLASTER);
    b.block({ w, h: g, d, x: 0, y: g / 2, z: 0 });
    b.box(w + jut * 2, up, d + jut * 2, 0, g + up / 2, 0, PLASTER);
    b.block({ w: w + jut * 2, h: up, d: d + jut * 2, x: 0, y: g + up / 2, z: 0 });
  }

  // Bressumer beam under the overhang, then close studding above it — the
  // vertical rhythm is what separates a townhouse from a taller cottage.
  b.box(w + jut * 2 + 0.2, 0.34, d + jut * 2 + 0.2, 0, g + 0.17, 0, TIMBER);
  const studs = Math.max(2, Math.round(w / 1.3));
  for (let i = 0; i <= studs; i++) {
    const x = -(w / 2) + (i / studs) * w;
    for (const sz of [-1, 1]) {
      b.box(0.2, up, 0.2, x, g + up / 2, sz * (d / 2 + jut), TIMBER);
    }
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(0.28, g, 0.28, (sx * w) / 2, g / 2, (sz * d) / 2, TIMBER);
      b.box(0.26, up, 0.26, sx * (w / 2 + jut), g + up / 2, sz * (d / 2 + jut), TIMBER);
    }
  }

  b.gableRoof(w + jut * 2, d + jut * 2, 2.1, 0, h, 0, SLATE, 0.4);

  // Brick stack, kept inside the footprint so it needs no collider of its own.
  const ch = h + 2.6;
  b.box(1.0, ch, 1.0, w / 2 - 0.6, ch / 2, d / 2 - 1.4, BRICK);
  b.box(1.3, 0.24, 1.3, w / 2 - 0.6, ch, d / 2 - 1.4, DARK_STONE);

  if (p.litWindows) {
    for (const sx of [-1, 1]) {
      b.glow(0.75, 0.9, 0.06, (sx * w) / 4, g * 0.55, -d / 2 - t / 2, "#ffb257");
      b.glow(0.7, 0.85, 0.06, (sx * w) / 4, g + up * 0.5, -(d / 2 + jut) - 0.05, "#ffb257");
    }
  }
  return b;
}

/**
 * The tavern: the biggest house in the village and the only one with its
 * lights still on. Two storeys, a covered porch on the -Z face, and a hanging
 * sign. Always enterable — a taproom you can brawl in is the whole point.
 */
export function buildTavern(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "tavern");
  const w = 13;
  const d = 10;
  const g = 3.6;
  const up = 3.4;
  const h = g + up;
  const t = 0.4;
  const jut = 0.5;

  b.box(w + 0.6, 0.3, d + 0.6, 0, 0.15, 0, DARK_STONE);
  b.box(w, 0.2, d, 0, 0.2, 0, PLANK);
  b.doorWall(w, g, t, 0, g / 2, -d / 2, PLASTER, 2.2, 2.6);
  b.doorWall(w, g, t, 0, g / 2, d / 2, PLASTER, 1.8, 2.3); // yard door
  b.wall(t, g, d, -w / 2, g / 2, 0, STONE);
  b.wall(t, g, d, w / 2, g / 2, 0, STONE);
  b.wall(w + jut * 2, up, d + jut * 2, 0, g + up / 2, 0, PLASTER);

  b.box(w + jut * 2 + 0.2, 0.36, d + jut * 2 + 0.2, 0, g + 0.18, 0, TIMBER);
  for (let i = -3; i <= 3; i++) {
    for (const sz of [-1, 1]) {
      b.box(0.22, up, 0.22, i * 1.9, g + up / 2, sz * (d / 2 + jut), TIMBER);
    }
  }
  b.gableRoof(w + jut * 2, d + jut * 2, 2.4, 0, h, 0, THATCH, 0.5);

  // Porch: four posts under a lean-to, deep enough to stand a fight in.
  const px = 3.2;
  const pz = -d / 2 - 2.2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(0.24, 2.7, 0.24, sx * px, 1.35, pz + sz * 1.6, TIMBER);
    }
  }
  b.box(px * 2 + 1.2, 0.16, 4.4, 0, 2.85, pz, THATCH, { x: -0.16 });
  b.box(px * 2 + 1.2, 0.24, 0.24, 0, 2.7, pz - 1.6, TIMBER);

  // Hanging sign — the landmark read from down the road.
  b.box(0.16, 0.16, 1.8, w / 2 - 1.4, g + 0.9, -d / 2 - 0.9, IRON);
  b.box(1.4, 1.0, 0.1, w / 2 - 1.4, g + 0.3, -d / 2 - 1.6, PLANK);
  b.glow(0.9, 0.5, 0.04, w / 2 - 1.4, g + 0.3, -d / 2 - 1.68, "#c9a15e");

  // Chimneys at both gable ends.
  for (const sx of [-1, 1]) {
    const ch = h + 2.4;
    b.box(1.1, ch, 1.2, (sx * w) / 2 - sx * 0.8, ch / 2, 0.6, BRICK);
    b.box(1.4, 0.24, 1.5, (sx * w) / 2 - sx * 0.8, ch, 0.6, DARK_STONE);
  }

  for (const sx of [-1, 1]) {
    b.glow(1.0, 1.0, 0.06, sx * 4.2, g * 0.55, -d / 2 - t / 2, "#ffb257");
    b.glow(0.8, 0.9, 0.06, sx * 2.4, g + up * 0.5, -(d / 2 + jut) - 0.05, "#ffb257");
  }
  b.light("#ffb257", 24, 2.1, 0.22, 0, 2.6, pz);
  return b;
}

/**
 * The smithy: three stone walls open to the street, a brick forge still
 * banked, and a stack taller than the roof. The open front makes it a piece
 * of cover you fight *through* rather than around.
 */
export function buildSmithy(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "smithy");
  const w = 9;
  const d = 8;
  const h = 4.4;
  const t = 0.5;

  b.box(w, 0.2, d, 0, 0.1, 0, DARK_STONE);
  b.wall(w, h, t, 0, h / 2, d / 2, STONE);
  b.wall(t, h, d, -w / 2, h / 2, 0, STONE);
  b.wall(t, h, d, w / 2, h / 2, 0, STONE);
  // Open front: jambs and a lintel only.
  b.doorWall(w, h, t, 0, h / 2, -d / 2, STONE, 5.0, 3.2);
  for (const sx of [-1, 1]) {
    b.box(0.3, h, 0.3, (sx * w) / 2, h / 2, -d / 2, TIMBER);
  }
  b.gableRoof(w, d, 1.8, 0, h, 0, SLATE);

  // Forge and stack against the back wall.
  b.wall(3.0, 1.5, 1.6, -1.6, 0.75, d / 2 - 1.3, BRICK);
  // The coals sit *on* the forge bed rather than on its face: a glow plate
  // hung off the front reads as a floating light box from the street. The
  // flame above them is what stops the bed reading as a lamp — and the fixture
  // light sits in front of and above the bed, so the brickwork under it is lit
  // instead of being the one dark thing in the room.
  b.glow(2.2, 0.24, 0.9, -1.6, 1.56, d / 2 - 1.3, EMBER);
  b.glow(1.1, 0.55, 0.5, -1.6, 1.9, d / 2 - 1.3, FLAME);
  const ch = h + 3.4;
  b.box(1.8, ch, 1.6, -1.6, ch / 2, d / 2 - 1.2, BRICK);
  b.box(2.1, 0.26, 1.9, -1.6, ch, d / 2 - 1.2, DARK_STONE);
  b.light(EMBER, 20, 2.3, 0.45, -1.6, 2.1, d / 2 - 2.3);

  // Anvil on its stump, and a quench barrel.
  b.cyl(0.9, 1.1, 1.2, 8, 2.0, 0.45, 0.4, TIMBER);
  b.box(1.2, 0.35, 0.45, 2.0, 1.05, 0.4, IRON);
  b.cyl(0.4, 0.3, 0.45, 6, 2.7, 1.15, 0.4, IRON);
  b.block({ w: 1.4, h: 1.3, d: 0.9, x: 2.0, y: 0.65, z: 0.4 });
  b.cyl(1.1, 0.9, 1.0, 8, 3.2, 0.55, -1.8, PLANK);
  b.cyl(0.12, 1.04, 1.04, 8, 3.2, 0.9, -1.8, IRON);
  b.block({ w: 1.1, h: 1.1, d: 1.1, x: 3.2, y: 0.55, z: -1.8 });
  return b;
}

/**
 * A roofless stone shell: chest-high walls, one corner still carrying its
 * chimney breast. Fills ground that would otherwise be empty with somewhere
 * to *fight*, which a solid building never does — every wall here is cover on
 * both sides and none of them reaches the eaves.
 */
export function buildRuin(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "ruin");
  const w = p.width ?? 10;
  const d = p.depth ?? 8;
  const t = 0.5;

  b.box(w, 0.2, d, 0, 0.1, 0, DARK_STONE);
  // North wall: mostly standing, broken down at one end.
  b.wall(w * 0.62, 3.4, t, -w * 0.19, 1.7, d / 2, MOSS_STONE);
  b.wall(w * 0.38, 1.8, t, w * 0.31, 0.9, d / 2, MOSS_STONE);
  // East wall standing tall, west wall down to a stub.
  b.wall(t, 2.7, d * 0.72, w / 2, 1.35, d * 0.14, MOSS_STONE);
  b.wall(t, 1.2, d * 0.5, -w / 2, 0.6, -d * 0.1, MOSS_STONE);
  // South wall: two jambs either side of where the door was.
  for (const sx of [-1, 1]) {
    b.wall(w * 0.3, 1.5, t, sx * w * 0.35, 0.75, -d / 2, MOSS_STONE);
  }
  // The chimney breast — the bit of a burnt cottage that always survives.
  b.wall(2.0, 5.2, 1.4, -w / 2 + 1.4, 2.6, d / 2 - 0.9, BRICK);
  b.box(2.4, 0.24, 1.7, -w / 2 + 1.4, 5.2, d / 2 - 0.9, DARK_STONE);
  // A fallen roof beam and the heap it came down in.
  b.box(0.4, 0.4, d * 0.8, w * 0.1, 1.0, 0, TIMBER, { x: 0.5, z: 0.2 });
  b.wall(2.4, 0.7, 2.0, w * 0.22, 0.35, -d * 0.2, DARK_STONE);
  b.wall(1.8, 0.6, 1.6, -w * 0.28, 0.3, d * 0.22, DARK_STONE);
  return b;
}

/**
 * Timber watchtower: a railed platform 4.6 m up, reached by an external ramp.
 * The only piece of verticality outside the barn loft and the chapel tower,
 * and deliberately exposed on the way up.
 *
 * The ramp collider carries `rotX` and its top meets the platform within a
 * step — get either wrong and the nav flood fill treats the whole thing as a
 * wall.
 */
export function buildWatchtower(
  scene: Scene,
  mats: CelMaterialFactory,
): Structure {
  const b = new Build(scene, mats, "watchtower");
  const legs = 1.9;
  const deckY = 4.6;
  const deck = 5.0;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(0.34, deckY, 0.34, sx * legs, deckY / 2, sz * legs, TIMBER);
      b.block({ w: 0.5, h: deckY, d: 0.5, x: sx * legs, y: deckY / 2, z: sz * legs });
      // Cross-bracing, the diagonal that reads as scaffolding at distance.
      b.box(0.2, 0.2, legs * 2.9, sx * legs, deckY * 0.45, 0, TIMBER, { x: 0.62 });
    }
  }
  for (const sz of [-1, 1]) {
    b.box(legs * 2.6, 0.2, 0.2, 0, deckY * 0.55, sz * legs, TIMBER, { z: 0.6 });
  }

  b.box(deck, 0.3, deck, 0, deckY, 0, PLANK);
  b.block({ w: deck, h: 0.3, d: deck, x: 0, y: deckY, z: 0 });
  // Railings on three sides; the -Z side is where the ramp arrives.
  for (const sx of [-1, 1]) {
    b.box(0.16, 1.1, deck, (sx * deck) / 2, deckY + 0.7, 0, TIMBER);
  }
  b.box(deck, 1.1, 0.16, 0, deckY + 0.7, deck / 2, TIMBER);
  for (const sx of [-1, 1]) {
    b.box(1.4, 1.1, 0.16, sx * (deck / 2 - 0.7), deckY + 0.7, -deck / 2, TIMBER);
  }

  // Canopy on four short posts — the silhouette that says "someone watched".
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(0.22, 2.4, 0.22, sx * 2.1, deckY + 1.35, sz * 2.1, TIMBER);
    }
  }
  b.gableRoof(deck + 0.6, deck + 0.6, 1.1, 0, deckY + 2.55, 0, PLANK, 0.4);

  // Signal brazier, still lit.
  b.cyl(0.9, 0.85, 0.7, 8, 1.4, deckY + 0.6, 1.4, IRON);
  b.glow(0.55, 0.5, 0.55, 1.4, deckY + 1.05, 1.4, EMBER);
  b.light(EMBER, 22, 2.0, 0.4, 1.4, deckY + 1.1, 1.4);

  // Access ramp, running up from -Z to the deck's south edge.
  const rampLen = 12;
  const rampW = 3;
  const pitch = Math.atan2(deckY, rampLen);
  const rz = -(deck / 2 + rampLen / 2);
  b.box(rampW, 0.3, rampLen, 0, deckY / 2, rz, PLANK, { x: -pitch });
  b.block({ w: rampW, h: 0.3, d: rampLen, x: 0, y: deckY / 2, z: rz, rotX: -pitch });
  for (const sx of [-1, 1]) {
    b.box(0.16, 1.0, rampLen, (sx * rampW) / 2, deckY / 2 + 0.6, rz, TIMBER, {
      x: -pitch,
    });
  }
  return b;
}

/**
 * The chapel: a stone nave you can fight inside, with a bell tower that
 * overlooks the north half of the map. Flag A sits in the nave.
 */
export function buildChapel(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "chapel");
  const w = 12;
  const d = 20;
  const h = 7;
  const t = 0.6;

  b.box(w, 0.2, d, 0, 0.1, 0, DARK_STONE);
  // Nave: open at the south end, buttressed sides.
  b.doorWall(w, h, t, 0, h / 2, -d / 2, STONE, 2.6, 3.4);
  b.wall(w, h, t, 0, h / 2, d / 2, STONE);
  b.wall(t, h, d, -w / 2, h / 2, 0, STONE);
  b.wall(t, h, d, w / 2, h / 2, 0, STONE);
  for (let i = -2; i <= 2; i++) {
    for (const sx of [-1, 1]) {
      b.box(0.5, h * 0.8, 0.9, (sx * w) / 2, h * 0.4, i * 3.6, DARK_STONE);
    }
  }
  b.gableRoof(w, d, 2.6, 0, h, 0, SLATE);

  // Tall lancet windows, glowing faintly — the only warm thing for 60 metres.
  for (let i = -1; i <= 1; i++) {
    for (const sx of [-1, 1]) {
      b.glow(0.08, 2.6, 0.9, sx * (w / 2 + t / 2), h * 0.55, i * 5, "#7fd8ff");
    }
  }

  // Bell tower on the north end.
  const tw = 5;
  const th = 15;
  b.wall(tw, th, t, 0, th / 2, d / 2 + tw / 2 - t / 2, STONE);
  b.wall(tw, th, t, 0, th / 2, d / 2 + tw + tw / 2 - t / 2, STONE);
  b.wall(t, th, tw, -tw / 2, th / 2, d / 2 + tw, STONE);
  b.wall(t, th, tw, tw / 2, th / 2, d / 2 + tw, STONE);
  b.box(tw + 0.8, 0.4, tw + 0.8, 0, th, d / 2 + tw, DARK_STONE);
  // Spire.
  b.cyl(4.5, 0.15, tw * 0.95, 4, 0, th + 2.4, d / 2 + tw, SLATE);
  b.glow(0.9, 0.9, 0.9, 0, th - 2, d / 2 + tw, FLAME);
  b.light(FLAME, 26, 2.2, 0.3, 0, th - 2, d / 2 + tw);

  return b;
}

/**
 * The barn: a big open timber shed with a hayloft platform reachable by an
 * external ramp. Holds flag D and is the map's main piece of verticality.
 */
export function buildBarn(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "barn");
  const w = 16;
  const d = 22;
  const h = 8;
  const t = 0.4;

  b.box(w, 0.2, d, 0, 0.1, 0, PLANK);
  b.doorWall(w, h, t, 0, h / 2, -d / 2, PLANK, 4.5, 5);
  b.doorWall(w, h, t, 0, h / 2, d / 2, PLANK, 4.5, 5);
  b.wall(t, h, d, -w / 2, h / 2, 0, PLANK);
  b.wall(t, h, d, w / 2, h / 2, 0, PLANK);
  for (let i = -3; i <= 3; i++) {
    for (const sx of [-1, 1]) {
      b.box(0.3, h, 0.3, (sx * w) / 2, h / 2, i * 3.2, TIMBER);
    }
  }
  b.gableRoof(w, d, 3.4, 0, h, 0, PLANK, 0.6);

  // Hayloft: a solid floor over the north third, walkable from the ramp.
  const loftY = 4.2;
  const loftD = d / 3;
  const loftZ = d / 2 - loftD / 2;
  b.box(w - t * 2, 0.3, loftD, 0, loftY, loftZ, PLANK);
  b.block({ w: w - t * 2, h: 0.3, d: loftD, x: 0, y: loftY, z: loftZ });
  b.box(w - t * 2, 0.5, 0.2, 0, loftY + 0.4, loftZ - loftD / 2, TIMBER); // lip

  // External ramp up the east side to the loft doorway.
  const rampLen = 11;
  const pitch = Math.atan2(loftY, rampLen);
  b.box(3, 0.3, rampLen, w / 2 + 1.9, loftY / 2, loftZ, PLANK, { x: -pitch });
  b.block({
    w: 3,
    h: 0.3,
    d: rampLen,
    x: w / 2 + 1.9,
    y: loftY / 2,
    z: loftZ,
    rotX: -pitch,
  });
  b.box(0.3, 1.2, rampLen, w / 2 + 3.3, loftY / 2 + 0.8, loftZ, TIMBER, {
    x: -pitch,
  });
  // Loft doorway in the east wall — the ramp arrives here.
  b.box(0.5, 2.4, 3, w / 2, loftY + 1.4, loftZ, PLANK);

  return b;
}

/**
 * The mill: a stone-based timber mill with a waterwheel on its west face,
 * straddling the creek. Flag B sits at its base.
 */
export function buildMill(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "mill");
  const w = 10;
  const d = 9;
  const h = 9;
  const t = 0.45;

  b.box(w, 0.2, d, 0, 0.1, 0, PLANK);
  b.box(w + 0.6, 2.4, d + 0.6, 0, 1.2, 0, STONE); // stone base course
  b.doorWall(w, h, t, 0, h / 2, -d / 2, PLASTER, 1.8, 2.3);
  b.wall(w, h, t, 0, h / 2, d / 2, PLASTER);
  b.wall(t, h, d, -w / 2, h / 2, 0, PLASTER);
  b.wall(t, h, d, w / 2, h / 2, 0, PLASTER);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(0.3, h, 0.3, (sx * w) / 2, h / 2, (sz * d) / 2, TIMBER);
    }
  }
  b.gableRoof(w, d, 2.2, 0, h, 0, THATCH);

  // Waterwheel: a spoked disc standing in the creek on the west face.
  const wheelR = 3.2;
  const wx = -w / 2 - 0.9;
  b.cyl(0.5, wheelR * 2, wheelR * 2, 12, wx, wheelR - 0.6, 0, TIMBER, {
    z: Math.PI / 2,
  });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.box(
      0.8,
      0.16,
      1.4,
      wx,
      wheelR - 0.6 + Math.sin(a) * wheelR * 0.82,
      Math.cos(a) * wheelR * 0.82,
      PLANK,
      { x: -a },
    );
  }
  b.block({ w: 2, h: wheelR * 2, d: wheelR * 2, x: wx, y: wheelR - 0.6, z: 0 });

  b.glow(0.6, 0.7, 0.06, -w / 4, h * 0.6, -d / 2 - t / 2, "#ffb257");
  b.light("#ffb257", 20, 1.8, 0.32, 0, h * 0.6, -d / 2 - 0.6);
  return b;
}

/**
 * Boathouse: a plank shed on stilts at the bog's edge, open to the water.
 * Holds flag E in a deliberately cramped, low-visibility fight.
 */
export function buildBoathouse(
  scene: Scene,
  mats: CelMaterialFactory,
): Structure {
  const b = new Build(scene, mats, "boathouse");
  const w = 11;
  const d = 13;
  const h = 4.6;
  const t = 0.3;

  b.box(w, 0.25, d, 0, 0.6, 0, PLANK);
  b.block({ w, h: 0.25, d, x: 0, y: 0.6, z: 0 });
  for (const sx of [-1, 1]) {
    for (let i = -1; i <= 1; i++) {
      b.cyl(1.4, 0.3, 0.36, 5, (sx * w) / 2.4, 0.1, i * 4.5, TIMBER);
    }
  }
  b.doorWall(w, h, t, 0, h / 2 + 0.7, -d / 2, PLANK, 3.4, 3);
  b.wall(w, h, t, 0, h / 2 + 0.7, d / 2, PLANK);
  b.wall(t, h, d, -w / 2, h / 2 + 0.7, 0, PLANK);
  b.doorWall(t, h, d, w / 2, h / 2 + 0.7, 0, PLANK, 3.4, 3);
  b.gableRoof(w, d, 1.6, 0, h + 0.7, 0, PLANK, 0.5);

  b.glow(0.5, 0.5, 0.5, 0, h + 0.2, -d / 2 + 0.4, "#6effc0");
  b.light("#6effc0", 14, 1.2, 0.15, 0, h + 0.2, -d / 2 + 0.4);
  return b;
}

/**
 * Home-spawn gatehouse: a barricaded stone arch on the valley road. Not
 * capturable — it exists so a losing team always has somewhere safe to deploy.
 */
export function buildGatehouse(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const teamColor = p.teamColor ?? "#c9a15e";
  const b = new Build(scene, mats, "gatehouse");
  const w = 18;
  const h = 8;
  const t = 1.2;

  for (const sx of [-1, 1]) {
    b.wall(4, h, 4, (sx * w) / 2, h / 2, 0, DARK_STONE);
    b.box(5, 0.6, 5, (sx * w) / 2, h, 0, STONE);
  }
  b.wall(w - 4, 2.2, t, 0, h - 1.1, 0, STONE); // arch lintel
  // Sandbag/timber barricades flanking the road.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      b.wall(3.2, 1.1, 1.2, sx * (5 + i * 0.4), 0.55, -4 - i * 1.6, TIMBER);
    }
  }
  // Team banners: the emissive read that tells you whose ground this is.
  for (const sx of [-1, 1]) {
    b.glow(0.15, 3.2, 1.6, (sx * w) / 2 - sx * 2.4, h - 2.4, 0, teamColor);
  }
  b.light(teamColor, 24, 1.6, 0.1, 0, h - 2, 0);
  return b;
}
