/**
 * MapBuilder.ts — Turns layout data into a GameMap: merges visual meshes per
 * material (frozen, unpickable) and then again per map block (BlockMerge —
 * neighbouring structures share a draw call), emits collider proxies,
 * registers fixture lights, builds NavGrid + ObstacleField.
 * Invariants: collider() is the ONLY place colliders are created — invisible,
 * pickable, checkCollisions, metadata.solid === true, never merged — and it
 * records the WorldBox for navigation. Geometry added by any other path is
 * invisible to rays AND bots. Colliders must line up with the visuals they
 * stand in for (sparks land on colliders). Visuals must never be pickable or
 * solid. Builders arrive at identity transform; merging then transforming is
 * what makes MergeMeshes safe. Must NOT special-case Hollowmere — a second map
 * is one new layout file.
 */
import { Material, Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { addOutline, type CelMaterialFactory } from "../shaders/CelShader";
import type { LightingSystem } from "../systems/LightingSystem";
import { BUILDERS, type BoxSpec, type Structure } from "./BuildingKit";
import { HollowmereEnvironment } from "./hollowmere/environment";
import { HollowmereLayout, type ScatterSpec } from "./hollowmere/layout";
import { NavGrid } from "./NavGrid";
import { ObstacleField } from "./ObstacleField";
import {
  buildBarrel,
  buildBoulder,
  buildBramble,
  buildDeadTree,
  buildFireDrum,
  buildFungus,
  buildGravestone,
  buildLog,
  buildRubble,
} from "./Props";

/** A capturable flag. */
export interface ControlPointDef {
  /** Single letter shown on the HUD strip: A..E. */
  id: string;
  name: string;
  pos: Vector3;
  radius: number;
}

/** A place a combatant can deploy to. */
export interface SpawnPointDef {
  /** Owning team, or null for a spawn tied to a control point. */
  team: 0 | 1 | null;
  /** Set when this spawn belongs to a control point. */
  controlPoint?: string;
  pos: Vector3;
  yaw: number;
}

/**
 * A rectangular body of shallow surface water. Purely visual: no collider,
 * no nav cost — combatants wade across the ground beneath. Consumed by the
 * WaterSystem, not by the MapBuilder (water is never merged or frozen).
 */
export interface WaterRect {
  x: number;
  z: number;
  /** Extents along X and Z. */
  width: number;
  depth: number;
  /** Surface height; defaults to CONFIG.water.surfaceY. */
  y?: number;
}

/**
 * A rectangular grass field. Purely visual: no collider, no nav cost —
 * combatants walk straight through (the shader bends the blades around
 * them). Consumed by the GrassSystem, not by the MapBuilder (grass is never
 * merged or frozen here; tufts that would grow inside a collider are
 * rejected by the GrassSystem at build time).
 */
export interface GrassRect {
  x: number;
  z: number;
  /** Extents along X and Z. */
  width: number;
  depth: number;
  /** Base height — set for fields on a terrace or embankment. */
  y?: number;
  /** Tufts per m²; defaults to CONFIG.grass.density. */
  density?: number;
}

/**
 * A collider's world-space geometry, kept alongside the mesh so the nav grid
 * can compute surface heights analytically instead of firing 25,600 rays.
 */
export interface WorldBox {
  w: number;
  h: number;
  d: number;
  cx: number;
  cy: number;
  cz: number;
  rotX: number;
  rotY: number;
}

/** The built world: geometry is in the scene, this is the queryable part. */
export interface GameMap {
  size: number;
  controlPoints: ControlPointDef[];
  spawns: SpawnPointDef[];
  /** Invisible collider proxies — the only pickable, collidable geometry. */
  colliders: Mesh[];
  /** The same colliders as plain boxes, for the nav grid. */
  colliderBoxes: WorldBox[];
  /** Drawn geometry, merged per colour. */
  visuals: Mesh[];
  /** Walkable-surface graph with one precomputed flow field per objective. */
  nav: NavGrid;
  /** Sub-cell collision the nav grid is too coarse to express. */
  obstacles: ObstacleField;
  /** Shallow-water bodies from the layout; empty when the map is dry. */
  water: WaterRect[];
  /** Grass fields from the layout; empty when the map is bald. */
  grass: GrassRect[];
  dispose(): void;
}

/** Scatter props, keyed by the name the layout data uses. */
const SCATTER_BUILDERS = {
  deadTree: buildDeadTree,
  gravestone: buildGravestone,
  log: buildLog,
  fungus: buildFungus,
  rubble: buildRubble,
  fireDrum: buildFireDrum,
  boulder: buildBoulder,
  bramble: buildBramble,
  barrel: buildBarrel,
} as const;

/** Lights carried by scatter props. Kept sparse — every one costs a shader slot. */
const SCATTER_LIGHTS: Partial<
  Record<ScatterSpec["prop"], { color: string; range: number; intensity: number; y: number; flicker: number }>
> = {
  fungus: { color: "#5bffb0", range: 9, intensity: 1.0, y: 0.6, flicker: 0.12 },
  fireDrum: { color: "#ff8a2a", range: 19, intensity: 2.0, y: 1.1, flicker: 0.4 },
};

/** Approximate prop heights at scale 1, for the burial check in `findSpot`. */
const PROP_HEIGHTS: Record<ScatterSpec["prop"], number> = {
  deadTree: 5.4,
  gravestone: 1.7,
  log: 0.9,
  fungus: 1.1,
  rubble: 1.5,
  fireDrum: 2.1,
  boulder: 1.4,
  bramble: 1.6,
  barrel: 1.3,
};

/**
 * Builds Hollowmere from `hollowmere/layout.ts`.
 *
 * ## The visual / collider split
 *
 * Every ray test in the game runs against `metadata.solid === true` meshes:
 * `CameraSystem`'s occlusion pull-in (every frame), `CombatSystem`'s hitscan
 * (every shot), and the bots' line-of-sight checks. `Player.moveWithCollisions`
 * separately walks every mesh with `checkCollisions`. At village scale, letting
 * visual geometry carry those jobs means thousands of triangle-picked meshes in
 * the hot path.
 *
 * So the two roles are split, and nothing does both:
 *
 * - **Visual** meshes are merged per colour, unpickable, non-colliding, and
 *   frozen. They are only ever drawn.
 * - **Collider** proxies are invisible boxes, pickable, colliding, and tagged
 *   `solid`. They are only ever tested.
 *
 * Colliders must line up with the surfaces they stand in for, or bullet sparks
 * land off the visible geometry.
 */
export class MapBuilder {
  constructor(
    private scene: Scene,
    private mats: CelMaterialFactory,
    private lighting: LightingSystem,
  ) {}

  /** World-space collider boxes, accumulated by `collider()` during a build. */
  private boxes: WorldBox[] = [];

  build(): GameMap {
    const size = CONFIG.map.size;
    const layout = HollowmereLayout;
    const visuals: Mesh[] = [];
    const colliders: Mesh[] = [];
    this.boxes = [];

    this.buildValley(size, visuals, colliders);

    // --- authored structures ---
    // Roads are merged into one draw call per material so overlapping junctions
    // (the central cross, etc.) don't z-fight between separate meshes.
    const roadParts: Mesh[] = [];
    const blocks = new BlockMerge();
    for (const p of layout.placements) {
      const builder = BUILDERS[p.kind];
      const s: Structure = builder(this.scene, this.mats, p.params ?? {});
      const origin = new Vector3(p.x, p.y ?? 0, p.z);
      const rotY = p.rotY ?? 0;
      const isRoad = p.kind === "road";

      for (const merged of mergeByMaterial(s.meshes, p.kind)) {
        merged.rotation.y = rotY;
        merged.position.addInPlace(origin);
        if (isRoad) roadParts.push(merged);
        else blocks.add(p.x, p.z, merged);
      }
      for (const box of s.colliders) {
        colliders.push(this.collider(`${p.kind}-col`, box, origin, rotY));
      }
      for (const l of s.lights) {
        const at = rotateY(l.x, l.y, l.z, rotY).addInPlace(origin);
        this.lighting.add(at, l.color, l.range, l.intensity, l.flicker);
      }
    }

    for (const merged of mergeByMaterial(roadParts, "roads")) {
      // Flat ground sheets receive shadows, never cast them.
      merged.metadata = { ...(merged.metadata ?? {}), noShadowCaster: true };
      if (!merged.metadata?.noOutline) addOutline(merged, 0.05);
      visuals.push(merged);
    }

    // --- scattered dressing ---
    for (const spec of layout.scatter) {
      this.scatterRegion(spec, blocks, colliders);
    }

    // One more merge across neighbouring structures — see BlockMerge.
    for (const merged of blocks.finish()) {
      if (!merged.metadata?.noOutline) addOutline(merged, 0.05);
      visuals.push(merged);
    }

    for (const m of visuals) this.markVisual(m);

    // Navigation is derived from the finished collider set, then a flow field
    // is precomputed per objective: five flags plus both home spawns. The map
    // is static, so this is the only time any of it is computed.
    const nav = new NavGrid(size, this.boxes);
    for (const cp of layout.controlPoints) {
      nav.buildField(cp.id, cp.pos, cp.radius * 0.6);
    }
    for (const team of [0, 1] as const) {
      const home = layout.spawns.find((s) => s.team === team);
      if (home) nav.buildField(`home${team}`, home.pos, 6);
    }

    return {
      size,
      nav,
      obstacles: new ObstacleField(size, this.boxes),
      controlPoints: layout.controlPoints,
      spawns: layout.spawns,
      colliders,
      colliderBoxes: this.boxes,
      visuals,
      water: layout.water ?? [],
      grass: layout.grass ?? [],
      dispose: () => {
        for (const m of visuals) m.dispose();
        for (const m of colliders) m.dispose();
        this.lighting.clear();
      },
    };
  }

  /** Ground plane plus the valley ridge that bounds play. */
  private buildValley(size: number, visuals: Mesh[], colliders: Mesh[]): void {
    const env = HollowmereEnvironment;
    const ground = MeshBuilder.CreateBox(
      "ground",
      { width: size, height: 1, depth: size },
      this.scene,
    );
    ground.position.y = -0.5;
    ground.material = this.mats.get(env.floorColor);
    // Receiver only: a flat sheet casting into the shadow map is pure acne.
    ground.metadata = { noShadowCaster: true };
    visuals.push(ground);
    colliders.push(
      this.collider("ground-col", { w: size, h: 1, d: size, x: 0, y: -0.5, z: 0 }),
    );

    // The ridge is tall enough that it never reads as a skybox edge through fog.
    const h = 20;
    const t = 2;
    const half = size / 2;
    const sides: [string, number, number, number, number][] = [
      ["n", size + t * 2, t, 0, half + t / 2],
      ["s", size + t * 2, t, 0, -half - t / 2],
      ["e", t, size + t * 2, half + t / 2, 0],
      ["w", t, size + t * 2, -half - t / 2, 0],
    ];
    for (const [name, w, d, x, z] of sides) {
      const wall = MeshBuilder.CreateBox(
        `ridge-${name}`,
        { width: w, height: h, depth: d },
        this.scene,
      );
      wall.position.set(x, h / 2, z);
      wall.material = this.mats.get(env.wallColor);
      addOutline(wall, 0.06);
      visuals.push(wall);
      colliders.push(
        this.collider(`ridge-${name}-col`, { w, h, d, x, y: h / 2, z }),
      );
    }
  }

  /**
   * Sprinkles a prop through a circular region by rejection sampling against
   * what is already there. Counts are authored per region rather than scaled
   * from floor area the way the retired room generator did it.
   *
   * Every instance in a region is merged into one mesh per colour. A stand of
   * sixteen dead trees becomes two draws instead of ninety-six — the trees do
   * not touch, so the outline pass still traces each trunk separately. The
   * cost is that the region culls as a unit, which is free in practice: a
   * region is ~25 m across and the fog reaches 78 m, so it is all visible
   * together or not at all.
   */
  private scatterRegion(
    spec: ScatterSpec,
    blocks: BlockMerge,
    colliders: Mesh[],
  ): void {
    const build = SCATTER_BUILDERS[spec.prop];
    const light = SCATTER_LIGHTS[spec.prop];
    const [minS, maxS] = spec.scale ?? [1, 1];
    const placed: { x: number; z: number; r: number }[] = [];
    const parts: Mesh[] = [];

    for (let i = 0; i < spec.count; i++) {
      const scale = minS + Math.random() * (maxS - minS);
      const clearance = (spec.clearance ?? 0.8) * scale;
      const spot = this.findSpot(spec, clearance, placed);
      if (!spot) continue;
      placed.push({ ...spot, r: clearance });

      const prop = build(this.scene, this.mats);
      prop.scaling.setAll(scale);
      prop.position.x = spot.x;
      prop.position.z = spot.z;
      prop.position.y = prop.position.y * scale + (spec.y ?? 0);
      prop.rotation.y = Math.random() * Math.PI * 2;
      // Bake the placement into the vertices, then hand the flattened
      // hierarchy to the merge — the same identity-transform trick the
      // structures use, applied one level up.
      parts.push(...flatten(prop));

      if (light) {
        this.lighting.add(
          new Vector3(spot.x, (spec.y ?? 0) + light.y * scale, spot.z),
          light.color,
          light.range * scale,
          light.intensity,
          light.flicker,
        );
      }
      if (spec.blocking) {
        // Real prop height, not a generic 3 m — a rubble heap's collider
        // reaching 3 m up blocks shots and sightlines over empty air.
        const h = PROP_HEIGHTS[spec.prop] * scale;
        colliders.push(
          this.collider(`${spec.prop}-col`, {
            w: clearance * 2,
            h,
            d: clearance * 2,
            x: spot.x,
            y: (spec.y ?? 0) + h / 2,
            z: spot.z,
          }),
        );
      }
    }

    for (const merged of mergeByMaterial(parts, `${spec.prop}-field`)) {
      blocks.add(spec.x, spec.z, merged);
    }
  }

  /**
   * A free spot inside the region: 14 tries, rejecting anything that overlaps
   * an earlier prop or lands inside a structure's collider. Returns null to
   * skip.
   */
  private findSpot(
    spec: ScatterSpec,
    clearance: number,
    placed: { x: number; z: number; r: number }[],
  ): { x: number; z: number } | null {
    for (let attempt = 0; attempt < 14; attempt++) {
      // sqrt keeps the distribution even rather than clumped at the centre.
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spec.radius;
      const x = spec.x + Math.cos(a) * r;
      const z = spec.z + Math.sin(a) * r;

      let ok = true;
      for (const p of placed) {
        const dx = p.x - x;
        const dz = p.z - z;
        if (dx * dx + dz * dz < (p.r + clearance + 1.2) ** 2) {
          ok = false;
          break;
        }
      }
      if (ok && this.insideCollider(spec, x, z, clearance)) ok = false;
      if (ok) return { x, z };
    }
    return null;
  }

  /**
   * True when a prop at (x, z) would end up buried inside an existing
   * collider box. Colliders below the prop's base don't count (gravestones
   * *stand on* the terrace), and neither do colliders clear above its top
   * (a log passes *under* a creek bridge). Ramps count as their full
   * footprint, so nothing spawns halfway into a slope.
   */
  private insideCollider(
    spec: ScatterSpec,
    x: number,
    z: number,
    clearance: number,
  ): boolean {
    const baseY = spec.y ?? 0;
    const topY = baseY + PROP_HEIGHTS[spec.prop] * (spec.scale?.[1] ?? 1);
    // The collider a prop gets spans `clearance` out from its centre — pad by
    // the full amount or the new collider ends up inside the structure's.
    const pad = clearance;
    for (const b of this.boxes) {
      // A tilted box (rotX ramps) spans a taller band than its thickness.
      let halfH = b.h / 2;
      if (b.rotX !== 0) halfH += (Math.abs(Math.sin(b.rotX)) * b.d) / 2;
      if (topY <= b.cy - halfH + 0.05 || baseY >= b.cy + halfH - 0.05) continue;
      // XZ overlap, tested in the box's local frame.
      let lx = x - b.cx;
      let lz = z - b.cz;
      if (b.rotY !== 0) {
        const c = Math.cos(b.rotY);
        const s = Math.sin(b.rotY);
        const rx = lx * c - lz * s;
        lz = lx * s + lz * c;
        lx = rx;
      }
      if (Math.abs(lx) <= b.w / 2 + pad && Math.abs(lz) <= b.d / 2 + pad) {
        return true;
      }
    }
    return false;
  }

  /**
   * Drawn, never tested. Unpickable and non-colliding so it stays out of every
   * ray pick and the collision broadphase; frozen because none of it moves.
   */
  private markVisual(mesh: Mesh): void {
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.freezeWorldMatrix();
    for (const child of mesh.getChildMeshes()) {
      child.isPickable = false;
      child.checkCollisions = false;
      child.freezeWorldMatrix();
    }
  }

  /** Tested, never drawn. The only geometry that carries `solid`. */
  private collider(
    name: string,
    box: BoxSpec,
    origin?: Vector3,
    parentRotY = 0,
  ): Mesh {
    const mesh = MeshBuilder.CreateBox(
      name,
      { width: box.w, height: box.h, depth: box.d },
      this.scene,
    );
    const local = rotateY(box.x, box.y, box.z, parentRotY);
    const at = origin ? local.addInPlace(origin) : local;
    const rotX = box.rotX ?? 0;
    const rotY = (box.rotY ?? 0) + parentRotY;
    mesh.position.copyFrom(at);
    mesh.rotation.set(rotX, rotY, 0);
    this.boxes.push({
      w: box.w,
      h: box.h,
      d: box.d,
      cx: at.x,
      cy: at.y,
      cz: at.z,
      rotX,
      rotY,
    });
    mesh.isVisible = false;
    mesh.isPickable = true;
    mesh.checkCollisions = true;
    mesh.metadata = { solid: true };
    mesh.freezeWorldMatrix();
    return mesh;
  }
}

/**
 * Side of a merge block, in metres. 48 m over a 240 m map gives a 5x5 grid of
 * blocks — coarse enough that the whole village collapses into a few dozen
 * draws, fine enough that frustum culling still throws away most of the map.
 * Well under the 78 m fog wall, so a block is never half-visible for long.
 */
const BLOCK_SIZE = 48;

/**
 * The second merge pass: collapses every structure and scatter field into one
 * mesh per (map block, material).
 *
 * The per-structure merge in `mergeByMaterial` already turns a cottage into
 * four meshes, but a dense village is ~200 structures and the outline pass
 * draws each mesh twice. Grouping neighbours by block takes the map from ~670
 * draws to ~150 without giving up culling: buildings are static, so the extra
 * vertices cost nothing that the draw calls weren't already costing more of.
 *
 * Merging across placements is safe for the same reason it is safe within one:
 * `MergeMeshes` bakes world matrices. Outlines still trace each building,
 * because `renderOutline` expands vertices along their own normals and the
 * buildings in a block are disjoint.
 */
class BlockMerge {
  private blocks = new Map<string, Mesh[]>();

  /** Files a positioned, per-material merged mesh under its map block. */
  add(x: number, z: number, mesh: Mesh): void {
    const key = `${Math.floor(x / BLOCK_SIZE)},${Math.floor(z / BLOCK_SIZE)}`;
    const group = this.blocks.get(key);
    if (group) group.push(mesh);
    else this.blocks.set(key, [mesh]);
  }

  /** Merges each block and returns the meshes the caller should draw. */
  finish(): Mesh[] {
    const out: Mesh[] = [];
    for (const [key, group] of this.blocks) {
      out.push(...mergeByMaterial(group, `block${key}`));
    }
    return out;
  }
}

/**
 * Flattens a prop hierarchy into a plain mesh list, unparenting each child so
 * its world transform survives the merge. `MergeMeshes` reads world matrices,
 * so the children have to be detached but left where they are.
 */
function flatten(root: Mesh): Mesh[] {
  const out: Mesh[] = [root];
  for (const child of root.getChildMeshes()) {
    const m = child as Mesh;
    m.computeWorldMatrix(true);
    m.setParent(null);
    out.push(m);
  }
  return out;
}

/** Rotates a local offset about the Y axis. */
function rotateY(x: number, y: number, z: number, angle: number): Vector3 {
  if (angle === 0) return new Vector3(x, y, z);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return new Vector3(x * c + z * s, y, -x * s + z * c);
}

/**
 * Collapses a structure's meshes into one per material.
 *
 * This is the whole draw-call budget for the village: a cottage goes from ~20
 * meshes to 4, and — because `renderOutline` draws a back-face shell per mesh —
 * from ~40 draws to 8. It also means the outline traces each colour group's
 * silhouette rather than every individual plank, which is the look the rifle
 * already uses.
 *
 * Merging is only safe because builders work at identity: `MergeMeshes` bakes
 * world matrices and hands back an identity-transform mesh, which the caller
 * then positions.
 */
function mergeByMaterial(meshes: Mesh[], tag: string): Mesh[] {
  const groups = new Map<Material, Mesh[]>();
  for (const m of meshes) {
    const mat = m.material;
    if (!mat) continue;
    const group = groups.get(mat);
    if (group) group.push(m);
    else groups.set(mat, [m]);
  }

  const out: Mesh[] = [];
  for (const [mat, group] of groups) {
    const merged =
      group.length === 1
        ? group[0]
        : Mesh.MergeMeshes(group, true, true, undefined, false, false);
    if (!merged) continue;
    merged.name = `${tag}-${mat.name}`;
    merged.material = mat;
    // Emissive groups keep their exemption: the outline shell would otherwise
    // expand past them and swallow the glow.
    if (group.some((m) => m.metadata?.noOutline)) {
      merged.metadata = { ...(merged.metadata ?? {}), noOutline: true };
    }
    out.push(merged as Mesh);
  }
  return out;
}
