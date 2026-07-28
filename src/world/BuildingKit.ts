import { Mesh, MeshBuilder, Scene } from "@babylonjs/core";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { LightSpec } from "./environment";
import { COBBLE_TEX_SCALE, getCobblestoneTexture } from "./textures";

/**
 * Parametric builders for everything Hollowmere is made of.
 *
 * Each builder assembles its geometry **at the origin, unrotated**, and hands
 * back three parallel lists in local space — `MapBuilder` merges the meshes per
 * colour and then transforms all three into place. Building at identity is what
 * makes the merge safe: `MergeMeshes` bakes world matrices and returns an
 * identity-transform mesh, the same trick `RifleModel.buildRifle` relies on.
 *
 * Nothing here touches `metadata.solid`, `checkCollisions`, or `isPickable` —
 * the visual/collider split is `MapBuilder`'s job, and builders only declare
 * where the collider boxes should go.
 */

/**
 * A collider box in the structure's local space. `rotX` exists for ramps —
 * an inclined collider is what lets the player's ground probe walk up one.
 */
export interface BoxSpec {
  w: number;
  h: number;
  d: number;
  x: number;
  y: number;
  z: number;
  rotX?: number;
  rotY?: number;
}

/**
 * The union of every builder's options. One flat bag rather than per-builder
 * types keeps the layout data terse and the dispatch in `MapBuilder` trivial;
 * builders ignore what they don't use.
 */
export interface BuildParams {
  width?: number;
  depth?: number;
  height?: number;
  length?: number;
  /** Cottage: punch a doorway and hollow the interior. */
  enterable?: boolean;
  litWindows?: boolean;
  ruined?: boolean;
  /** Terrace: which Z face the access ramp runs off. */
  rampSide?: -1 | 1;
  /** Gatehouse: banner colour identifying the owning team. */
  teamColor?: string;
  /** Road: cobblestone street (default) or the old flat dirt track. */
  surface?: "cobble" | "dirt";
}

/** A fixture light in the structure's local space. */
export interface LocalLight extends Omit<LightSpec, "offset"> {
  x: number;
  y: number;
  z: number;
}

/** What every builder returns. */
export interface Structure {
  meshes: Mesh[];
  colliders: BoxSpec[];
  lights: LocalLight[];
}

// --- village palette -------------------------------------------------------
// Art constants, deliberately not in CONFIG: these are material choices, not
// gameplay tunables.

const TIMBER = "#453b31";
const PLASTER = "#6b6459";
const STONE = "#5a5f5c";
const DARK_STONE = "#3d423f";
const SLATE = "#33383a";
const THATCH = "#5c5340";
const IRON = "#2f3338";
const PLANK = "#4a4034";
const DIRT = "#4a4438";

const FLAME = "#ffbe63";

/**
 * Accumulator handed to each builder. Keeps the builders declarative — they
 * describe a shape as a list of boxes and cylinders rather than juggling
 * Babylon handles.
 */
class Build implements Structure {
  meshes: Mesh[] = [];
  colliders: BoxSpec[] = [];
  lights: LocalLight[] = [];

  constructor(
    private scene: Scene,
    private mats: CelMaterialFactory,
    private tag: string,
  ) {}

  /** A cel-shaded box. Visual only. */
  box(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    color: string,
    rot?: { x?: number; y?: number; z?: number },
  ): Mesh {
    const m = MeshBuilder.CreateBox(
      `${this.tag}-box${this.meshes.length}`,
      { width: w, height: h, depth: d },
      this.scene,
    );
    m.position.set(x, y, z);
    if (rot) m.rotation.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
    m.material = this.mats.get(color);
    this.meshes.push(m);
    return m;
  }

  /**
   * A box surfaced with a world-mapped ground texture (cobblestone). The
   * shader samples by world XZ, so no UV authoring is needed and the pattern
   * keeps a constant real-world size however the box is sized — and tiles
   * seamlessly across separate structures sharing the material. For
   * up-facing surfaces only; walls would streak.
   */
  groundBox(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
  ): Mesh {
    const m = MeshBuilder.CreateBox(
      `${this.tag}-ground${this.meshes.length}`,
      { width: w, height: h, depth: d },
      this.scene,
    );
    m.position.set(x, y, z);
    m.material = this.mats.getGroundTextured(
      "cobble",
      getCobblestoneTexture(this.scene),
      COBBLE_TEX_SCALE,
    );
    this.meshes.push(m);
    return m;
  }

  /** A box that also blocks movement and stops bullets. */
  wall(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    color: string,
  ): Mesh {
    this.colliders.push({ w, h, d, x, y, z });
    return this.box(w, h, d, x, y, z, color);
  }

  /** A cel-shaded cylinder. Visual only. */
  cyl(
    height: number,
    dTop: number,
    dBot: number,
    tess: number,
    x: number,
    y: number,
    z: number,
    color: string,
    rot?: { x?: number; y?: number; z?: number },
  ): Mesh {
    const m = MeshBuilder.CreateCylinder(
      `${this.tag}-cyl${this.meshes.length}`,
      { height, diameterTop: dTop, diameterBottom: dBot, tessellation: tess },
      this.scene,
    );
    m.position.set(x, y, z);
    if (rot) m.rotation.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
    m.material = this.mats.get(color);
    this.meshes.push(m);
    return m;
  }

  /**
   * An unlit emissive detail — a flame, a window's glow. Tagged `noOutline`
   * because the outline shell would otherwise swallow it.
   */
  glow(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    color: string,
  ): Mesh {
    const m = MeshBuilder.CreateBox(
      `${this.tag}-glow${this.meshes.length}`,
      { width: w, height: h, depth: d },
      this.scene,
    );
    m.position.set(x, y, z);
    m.material = this.mats.getEmissive(color);
    m.metadata = { noOutline: true };
    this.meshes.push(m);
    return m;
  }

  /** A collider with no geometry — invisible blocking, or a walkable surface. */
  block(spec: BoxSpec): void {
    this.colliders.push(spec);
  }

  light(
    color: string,
    range: number,
    intensity: number,
    flicker: number,
    x: number,
    y: number,
    z: number,
  ): void {
    this.lights.push({ color, range, intensity, flicker, x, y, z });
  }

  /**
   * A wall with a doorway punched through it, as two jambs plus a lintel.
   * Runs along X, centred on the local origin offset.
   */
  doorWall(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    color: string,
    gapWidth: number,
    gapHeight: number,
  ): void {
    const side = (w - gapWidth) / 2;
    if (side > 0.05) {
      const off = gapWidth / 2 + side / 2;
      this.wall(side, h, d, x - off, y, z, color);
      this.wall(side, h, d, x + off, y, z, color);
    }
    const lintel = h - gapHeight;
    if (lintel > 0.05) {
      this.wall(gapWidth, lintel, d, x, y + h / 2 - lintel / 2, z, color);
    }
  }

  /** A gabled roof: two slanted slabs meeting at a ridge. */
  gableRoof(
    w: number,
    d: number,
    rise: number,
    x: number,
    y: number,
    z: number,
    color: string,
    overhang = 0.35,
  ): void {
    const slopeW = w / 2 + overhang;
    const len = Math.sqrt(slopeW * slopeW + rise * rise);
    const pitch = Math.atan2(rise, slopeW);
    for (const s of [-1, 1]) {
      this.box(
        len,
        0.18,
        d + overhang * 2,
        x + (s * slopeW) / 2,
        y + rise / 2,
        z,
        color,
        { z: -s * pitch },
      );
    }
    // The gable ends, so you don't see straight into the roof void.
    for (const s of [-1, 1]) {
      this.box(w, rise, 0.16, x, y + rise / 2, z + (s * d) / 2, color);
    }
    // Roofs block bullets and sight, but the collider is a flat slab at the
    // eaves rather than two rotated planes — cheaper, and nothing walks up there.
    this.block({ w: w + overhang * 2, h: 0.3, d: d + overhang * 2, x, y, z });
  }
}

// --- builders --------------------------------------------------------------

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

/**
 * A raised earth terrace with a ramp on one side. Used for the chapel's
 * graveyard platform; the top face and the ramp are both walkable colliders.
 */
export function buildTerrace(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "terrace");
  const w = p.width ?? 30;
  const d = p.depth ?? 26;
  const h = p.height ?? 2;
  const side = p.rampSide ?? -1;

  b.box(w, h, d, 0, h / 2, 0, DIRT);
  b.block({ w, h, d, x: 0, y: h / 2, z: 0 });
  // Retaining wall, so the terrace edge reads as built rather than extruded.
  for (const sx of [-1, 1]) {
    b.box(0.4, h + 0.3, d, (sx * w) / 2, (h + 0.3) / 2, 0, DARK_STONE);
  }
  b.box(w, h + 0.3, 0.4, 0, (h + 0.3) / 2, (-side * d) / 2, DARK_STONE);

  // Ramp up the chosen face.
  const rampLen = h * 5;
  const pitch = Math.atan2(h, rampLen);
  const rz = (side * (d + rampLen)) / 2;
  b.box(7, 0.3, rampLen, 0, h / 2, rz, DIRT, { x: side * pitch });
  b.block({ w: 7, h: 0.3, d: rampLen, x: 0, y: h / 2, z: rz, rotX: side * pitch });
  return b;
}

/**
 * A standalone earth ramp, rising from -Z to +Z over `length`. Used to get in
 * and out of the creek at more than one point — a sunken lane with a single
 * exit is a trap, and the nav grid needs somewhere to route bots through.
 */
export function buildRamp(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "ramp");
  const w = p.width ?? 5;
  const len = p.length ?? 8;
  const h = p.height ?? 1.5;
  const pitch = Math.atan2(h, len);
  b.box(w, 0.3, len, 0, h / 2, 0, DIRT, { x: -pitch });
  b.block({ w, h: 0.3, d: len, x: 0, y: h / 2, z: 0, rotX: -pitch });
  // Kerb stones, so the ramp reads as built rather than as a floating slab.
  for (const sx of [-1, 1]) {
    b.box(0.4, h + 0.3, len, (sx * w) / 2, h / 2 - 0.2, 0, DARK_STONE, {
      x: -pitch,
    });
  }
  return b;
}

/**
 * Flat road surface. Visual only — it sits on the ground plane. Cobblestone
 * by default; `surface: "dirt"` gives the old flat track for farm lanes.
 */
export function buildRoad(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "road");
  if (p.surface === "dirt") {
    b.box(p.width ?? 8, 0.08, p.length ?? 40, 0, 0.04, 0, DIRT);
  } else {
    b.groundBox(p.width ?? 8, 0.08, p.length ?? 40, 0, 0.04, 0);
  }
  return b;
}

/** Rotting jetty over the bog, running along Z. */
export function buildJetty(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "jetty");
  const len = p.length ?? 18;
  const w = 3;
  // Deck top must stay under CONFIG.nav.stepHeight above the mud, or the
  // flood fill never reaches it and bots treat the jetty as a wall.
  b.box(w, 0.24, len, 0, 0.45, 0, PLANK);
  b.block({ w, h: 0.24, d: len, x: 0, y: 0.45, z: 0 });
  const posts = Math.round(len / 3);
  for (let i = 0; i <= posts; i++) {
    const z = -len / 2 + (i / posts) * len;
    for (const sx of [-1, 1]) {
      b.cyl(1.3, 0.26, 0.32, 5, (sx * w) / 2.5, 0.05, z, TIMBER);
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

/** Every builder, keyed by the name the layout data uses. */
export const BUILDERS = {
  cottage: buildCottage,
  chapel: buildChapel,
  barn: buildBarn,
  silo: buildSilo,
  mill: buildMill,
  boathouse: buildBoathouse,
  gatehouse: buildGatehouse,
  well: buildWell,
  stall: buildStall,
  fence: buildFence,
  bridge: buildBridge,
  terrace: buildTerrace,
  ramp: buildRamp,
  road: buildRoad,
  jetty: buildJetty,
  haystack: buildHaystack,
  lamp: buildLampPost,
} as const;

export type BuilderKind = keyof typeof BUILDERS;
