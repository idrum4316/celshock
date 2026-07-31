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
 * - Builders NEVER set metadata.solid, checkCollisions, or isPickable — the
 *   visual/collider split is MapBuilder's job; builders only declare where
 *   collider boxes go.
 * - Collider top faces must stay within CONFIG.nav.stepHeight of adjacent
 *   ground or the nav flood fill never reaches them. Ramp colliders need
 *   rotX, not just the visual.
 * - No Hollowmere special-casing; register new builders in
 *   BuildingKit.ts's BUILDERS.
 */
import { Mesh, MeshBuilder, Scene } from "@babylonjs/core";
import { CONFIG } from "../../config";
import type { CelMaterialFactory } from "../../shaders/CelShader";
import type { LightSpec } from "../environment";
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
    // Wet-stone sheen + per-sett bump: the street catches a hard streak
    // looking moonward, and the light bands ripple over individual stones.
    m.material = this.mats.getGroundTextured(
      "cobble",
      getCobblestoneTexture(this.scene),
      COBBLE_TEX_SCALE,
      {
        spec: CONFIG.graphics.spec.cobble,
        bump: getCobblestoneBumpTexture(this.scene),
        bumpScale: CONFIG.graphics.cobbleBumpScale,
      },
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
