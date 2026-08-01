/**
 * kit/core.ts — Shared foundation for the parametric structure builders:
 * the Structure/BoxSpec/BuildParams/LocalLight types, the village palette,
 * and the Build accumulator every builder uses.
 *
 * Contract (applies to every builder in this directory):
 * - Builders assemble geometry AT THE ORIGIN, UNROTATED and return parallel
 *   local-space lists (meshes / colliders / lights). MapBuilder merges the
 *   meshes per colour and then transforms all three into place — building at
 *   identity is what makes MergeMeshes safe (same trick as
 *   RifleModel.buildRifle).
 * - A builder may take a BuildCtx to read where it is about to end up (the
 *   road bends onto the ground under it). That is a licence to SAMPLE the
 *   world, not to build in it: the geometry returned is still origin-local,
 *   because MapBuilder still rotates and translates it.
 * - Builders NEVER set metadata.solid, checkCollisions, or isPickable — the
 *   visual/collider split is MapBuilder's job; builders only declare where
 *   collider boxes go.
 * - Collider top faces must stay within CONFIG.nav.stepHeight of adjacent
 *   ground or the nav flood fill never reaches them. Ramp colliders need
 *   rotX, not just the visual.
 * - No Hollowmere special-casing; register new builders in
 *   BuildingKit.ts's BUILDERS.
 */
import { Mesh, MeshBuilder, Scene, VertexData } from "@babylonjs/core";
import type { ShaderMaterial } from "@babylonjs/core";
import { CONFIG } from "../../config";
import type { CelMaterialFactory } from "../../shaders/CelShader";
import type { LightSpec } from "../environment";
import type { TerrainField } from "../TerrainField";
import {
  COBBLE_TEX_SCALE,
  getCobblestoneBumpTexture,
  getCobblestoneTexture,
} from "../textures";

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

/**
 * Where a placement is about to be put, for the builders whose shape depends on
 * it. Only the ground-hugging ones take it — everything else is the same object
 * wherever it stands, and declaring the parameter is the opt-in.
 */
export interface BuildCtx {
  terrain: TerrainField;
  x: number;
  /** The world Y MapBuilder will translate by: the authored offset plus floor. */
  y: number;
  z: number;
  rotY: number;
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

export const TIMBER = "#453b31";
export const PLASTER = "#6b6459";
export const STONE = "#5a5f5c";
export const DARK_STONE = "#3d423f";
export const SLATE = "#33383a";
export const THATCH = "#5c5340";
export const IRON = "#2f3338";
export const PLANK = "#4a4034";
export const DIRT = "#4a4438";
/** Fired clay: chimney stacks, the forge, the charcoal kiln. */
export const BRICK = "#5b4038";
/** Lichened field stone — the dry walls and roadside shrines. */
export const MOSS_STONE = "#4f574c";

export const FLAME = "#ffbe63";
/** Forge/kiln mouth — hotter and redder than a lantern's FLAME. */
export const EMBER = "#ff7a2a";

/**
 * Accumulator handed to each builder. Keeps the builders declarative — they
 * describe a shape as a list of boxes and cylinders rather than juggling
 * Babylon handles.
 */
export class Build implements Structure {
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
    m.material = this.groundMaterial();
    this.meshes.push(m);
    return m;
  }

  /**
   * A surface handed in as finished vertices rather than described as a
   * primitive — a road tessellated to follow the ground under it. Takes the
   * same two materials `box` and `groundBox` do: a palette colour, or the
   * world-mapped cobblestone when `color` is omitted.
   *
   * Still origin-local: whoever built the vertices did so in the structure's
   * own frame, because MapBuilder rotates and translates the result.
   */
  surface(data: VertexData, color?: string): Mesh {
    const m = new Mesh(`${this.tag}-surface${this.meshes.length}`, this.scene);
    data.applyToMesh(m);
    m.material =
      color === undefined ? this.groundMaterial() : this.mats.get(color);
    this.meshes.push(m);
    return m;
  }

  /**
   * Wet-stone sheen + per-sett bump: the street catches a hard streak looking
   * moonward, and the light bands ripple over individual stones. Shared by
   * `groundBox` and `surface` so a flat road and a contoured one cannot end up
   * on two different materials — they merge into one draw call only while they
   * are on the same one.
   */
  private groundMaterial(): ShaderMaterial {
    return this.mats.getGroundTextured(
      "cobble",
      getCobblestoneTexture(this.scene),
      COBBLE_TEX_SCALE,
      {
        spec: CONFIG.graphics.spec.cobble,
        bump: getCobblestoneBumpTexture(this.scene),
        bumpScale: CONFIG.graphics.cobbleBumpScale,
      },
    );
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

  /**
   * The triangular panel that closes off the end of a pitched roof: base
   * corners at `±w / 2`, apex `rise` above them, `t` thick through Z, placed
   * by the centre of its base.
   *
   * Vertices rather than a box because the silhouette is the entire point. A
   * box here fills the roof's bounding rectangle, so its top corners stand
   * proud of the slabs it is meant to close by nearly the whole rise, and the
   * roof reads as a solid block with two diagonal strips laid across it rather
   * than as a peak.
   *
   * Wound for Babylon's LEFT-handed default (`scene.useRightHandedSystem` is
   * false), where a front face is clockwise seen from the front — the order
   * you get from working the cross product out on paper is inverted here, and
   * fails silently (see TerrainField's `assertFacesUp`).
   */
  gableEnd(
    w: number,
    rise: number,
    t: number,
    x: number,
    y: number,
    z: number,
    color: string,
  ): Mesh {
    // Cross-section, counter-clockwise in XY. The +Z face walks it in order,
    // the -Z face walks it reversed, and the quad bridging edge i is
    // front[i], back[i], back[i+1], front[i+1].
    const section = [
      [-w / 2, 0],
      [w / 2, 0],
      [0, rise],
    ];
    const front = section.map((p) => [p[0], p[1], t / 2]);
    const back = section.map((p) => [p[0], p[1], -t / 2]);

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    // Each face carries its own vertices, so ComputeNormals returns true face
    // normals — the same hard edges CreateBox gives every other piece here.
    const tri = (a: number[], b: number[], c: number[]): void => {
      for (const v of [a, b, c]) {
        positions.push(v[0], v[1], v[2]);
        uvs.push(v[0], v[1]);
        indices.push(indices.length);
      }
    };
    tri(front[0], front[1], front[2]);
    tri(back[0], back[2], back[1]);
    for (let i = 0; i < section.length; i++) {
      const j = (i + 1) % section.length;
      tri(front[i], back[i], back[j]);
      tri(front[i], back[j], front[j]);
    }

    const data = new VertexData();
    data.positions = positions;
    data.uvs = uvs;
    data.indices = indices;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    data.normals = normals;

    const m = this.surface(data, color);
    m.position.set(x, y, z);
    return m;
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
    // The gable ends, so you don't see straight into the roof void. Spanning
    // the slabs rather than the wall (`slopeW`, not `w / 2`) puts the panel's
    // sloped edges on the roof planes themselves: cut to the wall it stops
    // short of the eaves, and the wedge left over is a slit into the void at
    // exactly the corner the panel exists to close.
    for (const s of [-1, 1]) {
      this.gableEnd(slopeW * 2, rise, 0.16, x, y, z + (s * d) / 2, color);
    }
    // Roofs block bullets and sight, but the collider is a flat slab at the
    // eaves rather than two rotated planes — cheaper, and nothing walks up there.
    this.block({ w: w + overhang * 2, h: 0.3, d: d + overhang * 2, x, y, z });
  }
}
