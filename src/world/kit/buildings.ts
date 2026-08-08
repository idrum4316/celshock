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
  GUARD_THICKNESS,
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
    // Proud of the plinth, not flush with it — see buildTavern's floor.
    b.box(w, 0.2, d, 0, 0.24, 0, PLANK);
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

  // Boards stand PROUD of the plinth they are laid on. Flush tops (both at
  // 0.3) put 130 m2 of taproom floor and stone footing on one plane, and the
  // two are different colours so they merge into different meshes — the depth
  // test is then a tie the draw order breaks arbitrarily, per pixel, and the
  // floor flickers as you walk. The 0.04 is the board thickness showing.
  b.box(w + 0.6, 0.3, d + 0.6, 0, 0.15, 0, DARK_STONE);
  b.box(w, 0.2, d, 0, 0.24, 0, PLANK);
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
 * Timber watchtower: a railed platform 4.75 m up, reached by an external ramp.
 * The only piece of verticality outside the barn loft and the chapel tower,
 * and deliberately exposed on the way up.
 *
 * **The ramp follows `buildBarn`'s worked example**, because it previously
 * made both of the mistakes that comment exists to name, and each one showed
 * up as the climb needing a jump:
 *
 * - **The pitch is derived from the RUN and the slab is cut to the SLOPE.**
 *   `atan2(rise, slabLength)` conflates the two, which left the walked surface
 *   ending 0.40 m short of the deck at 0.14 m below it — a hole with the
 *   platform's own south face standing in it, so arriving at the top of the
 *   climb dropped you off the end or stopped you against a wall.
 * - **The foot runs on PAST the ground** (`rampDrop`) rather than stopping
 *   level with the tower's own floor, where it left 0.31 m of end grain. The
 *   ground probe would have stepped up that happily; `moveWithCollisions` is
 *   what refuses, because the collision capsule's ellipsoid bottoms out 0.05 m
 *   above the feet and a 0.31 m face is a wall to it. Hence "I have to jump".
 *
 * The rails are `Build.guard`s, which is what makes them solid and stands them
 * off the deck and the ramp; that method owns why both halves of that matter.
 * The one thing local to here is the SOUTH side, which is two stubs cut to the
 * deck's overhang either side of the ramp — so the opening is the ramp's own
 * width and always holds two nav-cell centres however the tower is turned.
 */
export function buildWatchtower(
  scene: Scene,
  mats: CelMaterialFactory,
): Structure {
  const b = new Build(scene, mats, "watchtower");
  const legs = 1.9;
  const deck = 5.0;
  const deckT = 0.3;
  /** Walkable height of the platform — the surface, not the slab's centre. */
  const deckTop = 4.75;
  const deckY = deckTop - deckT / 2;

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

  b.box(deck, deckT, deck, 0, deckY, 0, PLANK);
  b.block({ w: deck, h: deckT, d: deck, x: 0, y: deckY, z: 0 });

  // Access ramp, running up from -Z to the deck's south edge. Everything about
  // the platform's rails is cut against its width, so it is derived first.
  const rampW = 3;
  const rampT = 0.3;
  /** Rise over run. 0.35 sits inside the nav graph's 0.4 slope limit. */
  const rampGrade = 0.35;
  /** How far below the tower's own floor the ramp keeps going; see the header. */
  const rampDrop = 0.6;
  const rampRise = deckTop + rampDrop;
  const rampRun = rampRise / rampGrade;
  const rampPitch = Math.atan2(rampRise, rampRun);
  /** The slab's own length: it spans the run only once it is tilted. */
  const rampLen = Math.hypot(rampRun, rampRise);
  /** Where the walked surface meets the deck: its south edge, at deck height. */
  const rampTopZ = -deck / 2;
  /** The walked surface at a world Z — one plane, through the deck's edge. */
  const rampSurfaceAt = (z: number): number =>
    deckTop - (rampTopZ - z) * rampGrade;
  const rampZ = rampTopZ - rampRun / 2;
  // Placed by its TOP face: that surface has to meet the deck at one end and
  // pass through the ground at the other. A pitched slab's half-thickness is
  // measured VERTICALLY, so the term is h/2/cos, not h/2*cos.
  const rampY = rampSurfaceAt(rampZ) - rampT / 2 / Math.cos(rampPitch);
  b.box(rampW, rampT, rampLen, 0, rampY, rampZ, PLANK, { x: -rampPitch });
  b.block({
    w: rampW,
    h: rampT,
    d: rampLen,
    x: 0,
    y: rampY,
    z: rampZ,
    rotX: -rampPitch,
  });
  // Cleats across it. 15 m of bare plank at this pitch reads as a chute; these
  // are what say it is climbed. Nothing below the ground line — the last 1.7 m
  // of slab is buried, which is the whole point of `rampDrop`.
  for (let i = -5; i <= 5; i++) {
    const z = rampZ + (i * rampRun) / 12;
    const surface = rampSurfaceAt(z);
    if (surface < 0.12) continue;
    b.box(
      rampW - 0.3,
      0.08,
      0.14,
      0,
      surface + 0.04 / Math.cos(rampPitch),
      z,
      TIMBER,
      { x: -rampPitch },
    );
  }
  // Trestle bents under the span: 15 m of plank standing on nothing was the
  // other half of what read as wrong here. Colliders, because the upper one is
  // in ground a body can cross — above the ramp's midpoint the slab clears the
  // floor by more than HEADROOM, so the nav graph leaves that ground open and a
  // bot will route straight under it.
  for (const i of [1, 2]) {
    const z = rampTopZ - (i * rampRun) / 3;
    const bentH = rampSurfaceAt(z) - rampT / Math.cos(rampPitch);
    if (bentH < 0.4) continue;
    for (const sx of [-1, 1]) {
      const px = sx * (rampW / 2 - 0.2);
      b.box(0.24, bentH, 0.24, px, bentH / 2, z, TIMBER);
      b.block({ w: 0.34, h: bentH, d: 0.34, x: px, y: bentH / 2, z });
    }
    b.box(rampW, 0.18, 0.18, 0, bentH - 0.09, z, TIMBER);
  }
  // Handrails up both sides of the ramp, starting where it comes out of the
  // ground rather than at its buried foot. `guard` takes the horizontal RUN
  // and cuts the slab to it.
  const railFootZ = rampTopZ - deckTop / rampGrade;
  const rampRailZ = (rampTopZ + railFootZ) / 2;
  for (const side of ["-x", "+x"] as const) {
    const sx = side === "+x" ? 1 : -1;
    b.guard(
      side,
      (sx * rampW) / 2,
      rampRailZ,
      rampTopZ - railFootZ,
      rampSurfaceAt(rampRailZ),
      { pitch: rampPitch },
    );
  }

  // Railings round the platform. The -Z side is where the ramp arrives, so it
  // is two stubs and an opening the ramp's own width.
  const sideRun = deck + GUARD_THICKNESS * 2; // closes the corners
  b.guard("-x", -deck / 2, 0, sideRun, deckTop);
  b.guard("+x", deck / 2, 0, sideRun, deckTop);
  b.guard("+z", deck / 2, 0, deck, deckTop);
  const stub = (deck - rampW) / 2;
  for (const sx of [-1, 1]) {
    b.guard("-z", -deck / 2, (sx * (deck - stub)) / 2, stub, deckTop);
  }

  // Canopy on four short posts — the silhouette that says "someone watched".
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(0.22, 2.4, 0.22, sx * 2.1, deckTop + 1.2, sz * 2.1, TIMBER);
    }
  }
  b.gableRoof(deck + 0.6, deck + 0.6, 1.1, 0, deckTop + 2.4, 0, PLANK, 0.4);

  // Signal brazier, still lit.
  b.cyl(0.9, 0.85, 0.7, 8, 1.4, deckTop + 0.45, 1.4, IRON);
  b.glow(0.55, 0.5, 0.55, 1.4, deckTop + 0.9, 1.4, EMBER);
  b.light(EMBER, 22, 2.0, 0.4, 1.4, deckTop + 0.95, 1.4);

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
 * external ramp. Holds flag D and is the map's main piece of verticality —
 * "the map's best perch and the ramp to it is exposed", per the layout's own
 * design intent, which only means anything if the perch can be reached.
 *
 * Five things here are load-bearing rather than decorative, and every one of
 * them is what the ramp needed to stop being a dead end you could walk up and
 * nothing more:
 *
 * - **The east wall is built AROUND the loft opening** — two jambs, a sill and
 *   a lintel — not as one full-height slab with a plank glued on where a door
 *   should be. `b.wall` emits a collider, so a solid wall is solid at the loft
 *   whatever is drawn on it.
 * - **The sill's top face IS the threshold.** It stands flush with both the
 *   loft floor and the deck outside, so `NavGrid` finds one continuous height
 *   through the opening: `severLinks` spares a box standing no more than
 *   `stepHeight` above the higher end of a link, which is exactly what a flush
 *   sill is.
 * - **The ramp lands on a level deck, not on the doorway.** A pitched
 *   collider's top face is a different height on each side of a threshold, and
 *   the deck is what gives the ramp and the loft one flat surface to meet on.
 * - **The pitch is derived from the RUN and the slab is cut to the SLOPE.**
 *   Those are not the same number, and conflating them (`pitch =
 *   atan2(rise, slabLength)`) is what left the old ramp 0.3 m short of the
 *   loft and 1.5 m past the barn's north end. `stepHeight` (0.6) over
 *   `cellSize` (1.5) also caps the gradient at 0.4 — a steeper ramp severs
 *   itself from its own top and is walkable by the player and invisible to
 *   every bot.
 * - **The ramp runs on past the ground rather than stopping level with the
 *   barn's own floor** — see `rampDrop`, which is what makes it meet the
 *   terrain whatever `y` the placement carries.
 */
export function buildBarn(scene: Scene, mats: CelMaterialFactory): Structure {
  const b = new Build(scene, mats, "barn");
  const w = 16;
  const d = 22;
  const h = 8;
  const t = 0.4;

  // The loft is what the rest of the building is dimensioned against.
  /** Walkable height of the hayloft — the surface, not the slab's centre. */
  const loftTop = 4.2;
  const loftT = 0.3;
  const loftD = d / 3;
  /** Flush with the north wall's inner face, so the hay door opens onto it. */
  const loftZ = d / 2 - t / 2 - loftD / 2;

  // The loft doorway in the east wall, and the deck the ramp lands on.
  const doorW = 3.2;
  const doorH = 2.4;
  const doorS = loftZ - doorW / 2;
  const doorN = loftZ + doorW / 2;
  const deckW = 3.4;
  const deckD = doorW + 1.2;
  const deckX = w / 2 + t / 2 + deckW / 2;
  /** The deck's south edge — where the ramp arrives. */
  const deckS = loftZ - deckD / 2;

  b.box(w, 0.2, d, 0, 0.1, 0, PLANK);
  b.doorWall(w, h, t, 0, h / 2, -d / 2, PLANK, 4.5, 5);
  // The north cart door runs up PAST the loft floor, which is what turns its
  // upper half into a hay door: the perch's whole value is the sightline over
  // the paddocks, and a wall at the loft's north edge is a room with a view of
  // planks.
  b.doorWall(w, h, t, 0, h / 2, d / 2, PLANK, 4.5, loftTop + doorH);
  b.wall(t, h, d, -w / 2, h / 2, 0, PLANK);

  // East wall, in four pieces around the loft doorway.
  const jambS = doorS + d / 2;
  b.wall(t, h, jambS, w / 2, h / 2, doorS - jambS / 2, PLANK);
  const jambN = d / 2 - doorN;
  b.wall(t, h, jambN, w / 2, h / 2, doorN + jambN / 2, PLANK);
  b.wall(t, loftTop, doorW, w / 2, loftTop / 2, loftZ, PLANK);
  const lintel = h - loftTop - doorH;
  b.wall(t, lintel, doorW, w / 2, h - lintel / 2, loftZ, PLANK);
  // Frame, so the opening reads as a door rather than as missing wall.
  for (const sz of [-1, 1]) {
    const z = loftZ + sz * (doorW / 2 - 0.08);
    b.box(t + 0.14, doorH, 0.16, w / 2, loftTop + doorH / 2, z, TIMBER);
  }
  b.box(t + 0.14, 0.16, doorW, w / 2, loftTop + doorH - 0.08, loftZ, TIMBER);

  for (let i = -3; i <= 3; i++) {
    const z = i * 3.2;
    for (const sx of [-1, 1]) {
      // No corner post standing across the loft doorway.
      if (sx > 0 && Math.abs(z - loftZ) < doorW / 2 + 0.3) continue;
      b.box(0.3, h, 0.3, (sx * w) / 2, h / 2, z, TIMBER);
    }
  }
  b.gableRoof(w, d, 3.4, 0, h, 0, PLANK, 0.6);

  // Hayloft: a solid floor over the north third, walkable from the ramp.
  b.box(w - t * 2, loftT, loftD, 0, loftTop - loftT / 2, loftZ, PLANK);
  b.block({
    w: w - t * 2,
    h: loftT,
    d: loftD,
    x: 0,
    y: loftTop - loftT / 2,
    z: loftZ,
  });
  for (let i = -2; i <= 2; i++) {
    const z = loftZ + (i * loftD) / 5;
    b.box(w - t * 2, 0.22, 0.22, 0, loftTop - loftT - 0.11, z, TIMBER); // joist
  }
  // The south edge's lip is VISUAL ONLY, deliberately: the drop into the barn
  // is the loft's second exit and the thing you shoot down through. A collider
  // here is a rail you can neither step off nor fire over.
  b.box(w - t * 2, 0.5, 0.2, 0, loftTop + 0.25, loftZ - loftD / 2, TIMBER);
  // Loose hay. Flat pads rather than bales: anything up here tall enough to
  // read as cover has to be a collider, and a bale's top face would be a
  // standable surface 0.9 m clear of the floor that nothing can link to.
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 2.4);
    b.box(2.6, 0.14, 2.2, x, loftTop + 0.07, loftZ + loftD / 2 - 1.4, THATCH);
  }

  // The deck outside the loft door.
  const deckT = 0.3;
  b.box(deckW, deckT, deckD, deckX, loftTop - deckT / 2, loftZ, PLANK);
  b.block({
    w: deckW,
    h: deckT,
    d: deckD,
    x: deckX,
    y: loftTop - deckT / 2,
    z: loftZ,
  });
  for (const sz of [-1, 1]) {
    const z = loftZ + sz * (deckD / 2 - 0.3);
    const postH = loftTop - deckT;
    b.box(0.28, postH, 0.28, deckX + deckW / 2 - 0.3, postH / 2, z, TIMBER);
  }

  // External ramp up the east side to that deck. 0.35 rise over run, inside
  // the nav graph's 0.4 slope limit.
  const rampGrade = 0.35;
  /**
   * How far below the barn's own floor the ramp keeps going. A ramp whose foot
   * stops exactly at the structure's origin only meets the ground when the
   * placement's `y` is zero and the floor under it is level, and it misses by
   * centimetres otherwise — the second barn on Hollowmere carries `y: 0.33`,
   * which lifted the foot to 0.62 above the ground it stands on, two
   * centimetres past `stepHeight`, and severed the whole loft from the graph.
   * A `stepHeight` of overrun buries the last 1.7 m instead, where the terrain
   * simply wins the surface (`addSurface` keeps the higher of two within
   * `HEIGHT_EPS`) and costs nothing.
   */
  const rampDrop = 0.6;
  const rampRun = (loftTop + rampDrop) / rampGrade;
  const rampT = 0.3;
  const rampPitch = Math.atan2(loftTop + rampDrop, rampRun);
  /** The slab's own length: it spans the run only once it is tilted. */
  const rampLen = Math.hypot(rampRun, loftTop + rampDrop);
  // Placed by its TOP face — the surface walked on has to meet the deck at one
  // end and pass through the ground at the other. `topFaceHeight` measures the
  // slab's half-thickness VERTICALLY, so that term is h/2/cos, not h/2*cos.
  const rampY = (loftTop - rampDrop) / 2 - rampT / 2 / Math.cos(rampPitch);
  const rampZ = deckS - rampRun / 2;
  /** The ramp's walked surface at a point `lz` along the slab. */
  const rampTopAt = (lz: number): number =>
    rampY + rampT / 2 / Math.cos(rampPitch) + lz * Math.tan(rampPitch);
  b.box(deckW, rampT, rampLen, deckX, rampY, rampZ, PLANK, { x: -rampPitch });
  b.block({
    w: deckW,
    h: rampT,
    d: rampLen,
    x: deckX,
    y: rampY,
    z: rampZ,
    rotX: -rampPitch,
  });
  // Cleats across the ramp. Local (0, y, z) on a slab pitched by -rampPitch
  // lands at world (0, y*cos + z*sin, z*cos - y*sin).
  for (let i = -4; i <= 4; i++) {
    const ly = rampT / 2 + 0.04;
    const lz = (i * rampLen) / 10;
    // Nothing below the ground line: the last stretch of slab is buried.
    if (rampTopAt(lz) < 0.1) continue;
    b.box(
      deckW - 0.3,
      0.08,
      0.14,
      deckX,
      rampY + ly * Math.cos(rampPitch) + lz * Math.sin(rampPitch),
      rampZ - ly * Math.sin(rampPitch) + lz * Math.cos(rampPitch),
      TIMBER,
      { x: -rampPitch },
    );
  }

  // Handrail up the ramp's outer edge and round the deck. These were VISUAL
  // ONLY, and the ramp's was the worse half of that: 4.2 m of climb with an
  // open side you could walk straight off. `guard` is what makes them solid
  // without costing the route a nav cell — it owns that whole argument.
  //
  // The rail starts where the ramp leaves the ground rather than at its buried
  // foot, and only the OUTER side carries one: the ramp runs up the barn's east
  // wall, which is the other edge.
  const railFootZ = deckS - loftTop / rampGrade;
  const railZ = (deckS + railFootZ) / 2;
  const railX = deckX + deckW / 2;
  b.guard("+x", railX, railZ, deckS - railFootZ, rampTopAt(railZ - rampZ), {
    pitch: rampPitch,
  });
  // Round the deck: the outer edge runs long at both ends, closing the corner
  // against the north rail and meeting the ramp's rail in one line.
  b.guard("+x", railX, loftZ, deckD + GUARD_THICKNESS * 2, loftTop);
  b.guard("+z", loftZ + deckD / 2, deckX, deckW, loftTop);

  // A lantern over the loft door, hung off the wall on a bracket: the same
  // iron arm / tapered housing / capped flame `lamp` is built from, because a
  // bare `glow` is a flame floating in mid-air with nothing holding it. The
  // arm beds into the LINTEL rather than crossing the opening, and the housing
  // hangs clear above the door's head. The farmstead is the darkest district
  // on the map and the ramp is meant to be an exposed approach, which it can
  // only be if the player can see it is there.
  const lampY = loftTop + doorH + 0.5;
  const lampX = w / 2 + t / 2 + 0.7;
  b.box(0.9, 0.1, 0.1, w / 2 + t / 2 + 0.4, lampY + 0.3, loftZ, IRON);
  b.cyl(0.62, 0.42, 0.3, 6, lampX, lampY, loftZ, IRON);
  b.glow(0.3, 0.3, 0.3, lampX, lampY, loftZ, FLAME);
  b.cyl(0.18, 0.1, 0.5, 6, lampX, lampY + 0.4, loftZ, IRON);
  b.light(FLAME, 22, 1.9, 0.28, lampX, lampY, loftZ);

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
