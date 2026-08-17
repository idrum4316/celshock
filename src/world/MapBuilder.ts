/**
 * MapBuilder.ts — Turns layout data into a GameMap: merges visual meshes per
 * material (frozen, unpickable) and then again per map block (BlockMerge —
 * neighbouring structures share a draw call), emits collider proxies,
 * registers fixture lights, builds NavGrid + CoverMap + ObstacleField.
 * Invariants: collider() is the ONLY place colliders are created — invisible,
 * pickable, checkCollisions, metadata.solid === true, never merged — and it
 * records the WorldBox for navigation. It sets no `metadata.surface`, and that
 * absence is meaningful: it is what makes every box read as "hard" to the
 * impact effects. The terrain floor's clone is the one collider that says
 * otherwise ("ground"). Geometry added by any other path is
 * invisible to rays AND bots. Colliders must line up with the visuals they
 * stand in for (sparks land on colliders). Visuals must never be pickable or
 * solid. Builders arrive at identity transform; merging then transforming is
 * what makes MergeMeshes safe. Must NOT special-case Hollowmere — a second map
 * is one new layout file, and build() takes the layout and environment as
 * arguments precisely so nothing here can reach for a named one.
 * Scatter runs off the layout's seeded RNG, never Math.random: blocking props
 * emit colliders, and colliders decide navigation.
 * The floor comes from a TerrainField, not a flat box, and every authored `y`
 * in the layout is an offset ABOVE it — so a building dropped into a basin
 * needs no bookkeeping. The floor mesh is the one place a visual and a
 * collider share vertices (an invisible clone per block); a heightfield has no
 * box to stand in for it, and splitting it per block is what keeps ray picks
 * rejecting it as cheaply as the old flat box did.
 * `build(..., { editor: true })` keeps geometry per layout item, tags it with
 * metadata.editorRef and indexes it — at the cost of the BlockMerge pass and
 * roughly 10x the draw calls. Authoring only; never measure frame cost there.
 */
import { Material, Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { addOutline, type CelMaterialFactory } from "../shaders/CelShader";
import { bakeVertexAo } from "./ambientOcclusion";
import type { LightingSystem } from "../systems/LightingSystem";
import { BUILDERS, type BoxSpec, type Structure } from "./BuildingKit";
import type { EnvironmentSpec } from "./environment";
import { floorMaterial } from "./floorSurfaces";
import {
  isScatterRect,
  type MapLayout,
  type RidgeSpec,
  type ScatterSpec,
} from "./layout";
import { type LocalXZ, rotateToLocalXZ } from "./boxGeometry";
import {
  type BoxIndex,
  boxesNear,
  emptyBoxIndex,
  insertBox,
} from "./boxIndex";
import { ridgeSegments } from "./Ridge";
import { TerrainField, terrainPatches } from "./TerrainField";
import { NavGrid } from "./NavGrid";
import { CoverMap } from "./CoverMap";
import { ObstacleField } from "./ObstacleField";
import { mulberry32 } from "./rng";
import {
  buildBarrel,
  buildBoulder,
  buildBramble,
  buildButtressLog,
  buildCarvedStele,
  buildDeadTree,
  buildFernClump,
  buildFireDrum,
  buildFungus,
  buildGravestone,
  buildJungleTree,
  buildLog,
  buildPine,
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
  /**
   * Stops a body, not a round — see `BoxSpec.porous`, which is where a builder
   * declares it. Carried here because the box outlives the spec: `CoverMap`
   * bakes off these, and the server rebuilds its whole world from them.
   */
  porous?: true;
}

/**
 * Which layout item a mesh came from. Present in `metadata.editorRef` only on
 * editor builds — the shipped path merges across placements, so a mesh there
 * belongs to a whole map block rather than to any one item.
 */
export interface EditorRef {
  list: "placements" | "scatter";
  index: number;
}

/** One layout item's geometry, so the editor can move or rebuild it alone. */
export interface EditorItem {
  visuals: Mesh[];
  colliders: Mesh[];
  /** Positions in `GameMap.colliderBoxes` of this item's boxes. */
  boxes: number[];
  /**
   * The builder's own collider specs, in the structure's local space, in the
   * same order as `colliders`/`boxes`. Kept so a move or rotate can be
   * recomputed exactly — `repositionItem` needs the pre-transform boxes, and
   * the world-space ones have already had the placement baked into them.
   */
  localBoxes: BoxSpec[];
}

/**
 * Per-item geometry index. Built only when `build()` is given `editor: true`;
 * that mode also skips the BlockMerge pass, because merging across placements
 * is exactly what makes a single placement unrecoverable afterwards.
 */
export interface EditorIndex {
  placements: EditorItem[];
  scatter: EditorItem[];
}

/** Opt-in build behaviour. Absent in the shipped path. */
export interface BuildOptions {
  /**
   * Keep geometry per layout item and tag it, at the cost of the block merge:
   * ~1740 draws against ~150. Fine for authoring, never for play.
   */
  editor?: boolean;
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
  /**
   * The `strut` boxes — ray geometry with no body behind it — grouped by the
   * collider mesh each group was merged into.
   *
   * Not in `colliderBoxes` on purpose: everything derived from geometry reads
   * that list, and none of it can represent a 0.1 m rail (see
   * `BoxSpec.rayOnly`). The grouping is carried rather than flattened because
   * the server has to rebuild and merge the same meshes from the bake, and it
   * cannot recover from a flat list which boxes were one fence.
   */
  rayGroups: WorldBox[][];
  /**
   * The floor's collider blocks, a SUBSET of `colliders`.
   *
   * They are called out because they are the one collider with no `WorldBox`
   * behind it (a heightfield is not a box — see the terrain section of
   * `build`), so anything that wants the whole solid world as geometry has to
   * take `colliderBoxes` for the boxes and these for the floor.
   * `RagdollSystem` is the caller: it needs the real mesh to rest a body on.
   * Picking them out of `colliders` by name would work and is exactly the sort
   * of string-sniffing that breaks silently when a name changes.
   */
  terrainColliders: Mesh[];
  /** Drawn geometry, merged per colour. */
  visuals: Mesh[];
  /** Walkable-surface graph with one precomputed flow field per objective. */
  nav: NavGrid;
  /** Sub-cell collision the nav grid is too coarse to express. */
  obstacles: ObstacleField;
  /** Baked directional cover over the nav graph, for the AI. */
  cover: CoverMap;
  /** Shallow-water bodies from the layout; empty when the map is dry. */
  water: WaterRect[];
  /** Grass fields from the layout; empty when the map is bald. */
  grass: GrassRect[];
  /**
   * The floor's height, for everything that used to assume zero. Flat when the
   * layout declares no terrain, which is the whole of the old behaviour.
   */
  terrain: TerrainField;
  /** Per-item geometry. Editor builds only — undefined in play. */
  editor?: EditorIndex;
  dispose(): void;
}

/** Scatter props, keyed by the name the layout data uses. */
const SCATTER_BUILDERS = {
  deadTree: buildDeadTree,
  pine: buildPine,
  jungleTree: buildJungleTree,
  fernClump: buildFernClump,
  buttressLog: buildButtressLog,
  carvedStele: buildCarvedStele,
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

/** One scatter prop's measured body. See `PROP_BODIES`. */
interface PropBody {
  /** Collider footprint and height at scale 1 — the part that stops a bullet. */
  w: number;
  d: number;
  h: number;
  /**
   * Roughly how high the prop reaches, for `findSpot`'s burial check — a
   * different question from `h`, which stops at what is solid. A fire drum's
   * flame is 0.85 m of light that must not be planted inside a wall and 0 m of
   * anything a bullet can find.
   *
   * Approximate, and deliberately frozen at the values this table shipped
   * with: it feeds placement, so changing one rerolls the seeded dressing
   * field across the whole map for no gain.
   */
  visualTop: number;
}

/**
 * Every scatter prop's body at scale 1, measured off the builders in
 * `Props.ts`. The collider box is `w`/`d`/`h`, oriented with the prop.
 *
 * **This is deliberately not `ScatterSpec.clearance`, which is what it used to
 * be.** Clearance is a *placement* rule — how much room a prop wants around it
 * so a stand of trees doesn't grow into itself or into a wall — and it is
 * generous on purpose. Sizing the collider from it gave every blocking prop a
 * square box inflated by its own spacing margin, and square is the worst shape
 * for it: a headstone 0.24 m thick stopped rounds through 1.2 m of air, and a
 * dead tree ate a 1.74 m corridor at chest height around a 0.7 m trunk. Since
 * the same boxes are what `CombatSystem` caps a shot on, what `BattleSystem`
 * tests line of sight against and what `CameraSystem` pulls in on, one wrong
 * number was showing up as three unrelated-looking complaints.
 *
 * Keep these honest against `Props.ts`. Too small only costs a round clipping
 * through a silhouette; too large costs shots that visibly should have landed.
 */
const PROP_BODIES: Record<ScatterSpec["prop"], PropBody> = {
  // Trunk only, at roughly its width around chest height (it tapers 0.85 ->
  // 0.32 over 5.2 m). The branches are 4 cm twigs — nothing should stop on one.
  deadTree: { w: 0.7, d: 0.7, h: 5.2, visualTop: 5.4 },
  // Trunk only, same as the dead tree — the crown is 3.3 m of needles and
  // stopping rounds on it would give the map its one piece of cover you can see
  // daylight through. The builder keeps the lowest tier above the 1.7 m hit
  // sphere so nothing shootable hides in there. `visualTop` clears the tip.
  pine: { w: 0.62, d: 0.62, h: 6.4, visualTop: 7.0 },
  // Trunk plus its buttress core: the fins reach 0.97 m from the axis at their
  // widest, so a 1.0 m box is the flare you can see rather than a margin around
  // it. The canopy is 4 m of frond starting nine metres up and is not in this —
  // there is nothing to shoot up there, and a box that held it would stop
  // rounds through open air across the whole stand. Full trunk height, so a
  // jungle tree bakes as hard cover (CoverMap's 1.7 m) the way a wall does.
  jungleTree: { w: 1.0, d: 1.0, h: 11.2, visualTop: 11.6 },
  // Never blocking, so w/d/h are never read — filled honestly anyway, because
  // this is a Record and a lie here would be believed the day someone sets
  // `blocking` on a fern. `visualTop` IS read: findSpot's burial check runs for
  // every prop, blocking or not. The reasoning for keeping ferns walk-through
  // is in buildFernClump.
  fernClump: { w: 1.7, d: 1.7, h: 1.0, visualTop: 1.2 },
  // TRUNK ONLY, and lying along its own local X like the log — 5.2 m one way
  // and 1.0 m the other is meaningless axis-aligned. The buttress fins (1.4 m)
  // and the root plate (1.9 m) are thin plates and are deliberately outside
  // this: a box that held them would stop rounds through a metre of daylight
  // down the whole prop. At 1.0 m it sits under CoverMap's 1.7 m hard-cover
  // line, so it bakes as low cover — which is what a fallen log is.
  buttressLog: { w: 5.2, d: 1.0, h: 1.0, visualTop: 1.9 },
  // Wide and thin and oriented, the gravestone's lesson at temple scale. The
  // only understory prop that clears the 1.7 m hit sphere, so the only one
  // CoverMap bakes as hard cover.
  carvedStele: { w: 1.0, d: 0.45, h: 2.3, visualTop: 2.6 },
  // Slab and plinth: wide, and *thin*. The one prop whose orientation matters
  // most — squared off, it blocked five times its own thickness.
  gravestone: { w: 1.15, d: 0.42, h: 1.6, visualTop: 1.7 },
  // Lies along its own local X, so the collider's rotation is load-bearing:
  // 3 m one way and 0.7 m the other is meaningless axis-aligned.
  log: { w: 3.0, d: 0.7, h: 0.75, visualTop: 0.9 },
  fungus: { w: 0.8, d: 0.8, h: 0.9, visualTop: 1.1 },
  // Heap plus the chunks piled on it. The rebar is a 6 cm rod sticking out to
  // 1.8 m and is not in this — you do not lose a round to a piece of wire.
  rubble: { w: 1.9, d: 1.7, h: 1.05, visualTop: 1.5 },
  // The drum. NOT the flame above it, which is emissive and 0.85 m tall.
  fireDrum: { w: 0.95, d: 0.95, h: 1.25, visualTop: 2.1 },
  // The one prop that was already too *small*, and stays generous: measured,
  // a boulder is 2.4 m across the waist and 2.2 m tall, because
  // `CreatePolyhedron`'s `size: 0.8` is not a radius — it yields a 2.26 m
  // shape before the builder's own 1.3-1.7x stretch. The old clearance-derived
  // 2.0 m box already let rounds through visible rock. Height stays near it so
  // a large boulder still bakes as hard cover (CoverMap's 1.7 m).
  boulder: { w: 2.1, d: 1.9, h: 1.45, visualTop: 1.4 },
  bramble: { w: 0.8, d: 0.8, h: 1.2, visualTop: 1.6 },
  barrel: { w: 0.88, d: 0.88, h: 1.25, visualTop: 1.3 },
};

/**
 * Builds a map from the `MapLayout` and `EnvironmentSpec` it is handed — the
 * pair `world/maps.ts` keeps together. No map is named here.
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
 *
 * Open-frame geometry is described TWICE rather than approximated once, which
 * is how it keeps that rule: a collider tagged `porous` is the solid world to a
 * BODY and not there at all to a ROUND, and the `rayOnly` colliders beside it
 * (`Build.strut`, merged by `struts()`) are the reverse — the timber a round
 * stops on, with no body behind it and no `WorldBox` at all. A fence is a 1.4 m
 * porous slab for walking into and nine merged posts and rails for shooting at.
 * See `BoxSpec.porous` / `BoxSpec.rayOnly`, and `solid.ts` for the two
 * predicates that split them.
 */
export class MapBuilder {
  constructor(
    private scene: Scene,
    private mats: CelMaterialFactory,
    private lighting: LightingSystem,
  ) {}

  /** World-space collider boxes, accumulated by `collider()` during a build. */
  private boxes: WorldBox[] = [];

  /**
   * The `strut` boxes, grouped by the placement whose collider mesh they were
   * merged into. Deliberately NOT in `boxes` — nothing derived from geometry
   * (nav, cover, obstacles, AO, scatter) may see them. See `struts()`.
   */
  private rayGroups: WorldBox[][] = [];

  /**
   * Scratch for `insideCollider`'s box-frame transform. Reused because scatter
   * placement runs it a great many times per build.
   */
  private readonly localScratch: LocalXZ = { lx: 0, lz: 0 };

  /**
   * `boxes`, bucketed, so scatter placement can ask which colliders are near a
   * candidate spot instead of walking all of them. Replaced at the top of every
   * `build` and fed by `collider()`, so it is never out of step with `boxes`.
   *
   * Its `pad` is the largest clearance any scatter region will query with, and
   * that is computed from the layout rather than guessed — a query wider than
   * the pad would miss boxes silently, which is the one way this can be wrong.
   */
  private boxIndex: BoxIndex = emptyBoxIndex(CONFIG.map.size, 0);

  /**
   * The layout item currently being built, on editor builds only. `collider()`
   * files its box index here so the editor can find one item's boxes again
   * without re-deriving them. Null in the shipped path and between items.
   */
  private item: EditorItem | null = null;

  /**
   * Builds a map. The layout and environment are arguments, not imports: a
   * second map is a second layout file and nothing here changes.
   */
  build(layout: MapLayout, env: EnvironmentSpec, opts?: BuildOptions): GameMap {
    const size = CONFIG.map.size;
    const visuals: Mesh[] = [];
    const colliders: Mesh[] = [];
    // A view onto the floor's own blocks within `colliders` — see GameMap.
    const terrainColliders: Mesh[] = [];
    this.boxes = [];
    this.rayGroups = [];
    // Sized to the widest burial test this layout will run. `findSpot` asks
    // about `(spec.clearance ?? 0.8) * scale`, and `scale` tops out at the
    // upper end of the spec's own range — so the layout knows the answer before
    // a single box exists, which is the only moment the index can be told.
    this.boxIndex = emptyBoxIndex(size, maxScatterClearance(layout));
    // One stream for the whole build, so scatter regions stay reproducible in
    // authored order. Seeding per region would be stabler under editing but
    // would let two regions with the same seed sample identically.
    const rng = mulberry32(layout.seed ?? 0x484c);
    const forEditor = opts?.editor === true;
    const index: EditorIndex | undefined = forEditor
      ? { placements: [], scatter: [] }
      : undefined;
    this.item = null;

    const terrain = new TerrainField(layout.terrain);
    this.buildValley(
      size,
      env,
      terrain,
      visuals,
      colliders,
      terrainColliders,
      layout.ridge,
    );

    // --- authored structures ---
    // Roads are merged into one draw call per material so overlapping junctions
    // (the central cross, etc.) don't z-fight between separate meshes.
    const roadParts: Mesh[] = [];
    const blocks = new BlockMerge();
    for (const [i, p] of layout.placements.entries()) {
      const item = index ? newItem(index.placements) : null;
      this.item = item;
      // An authored y is an offset above the local floor, not an absolute
      // height, so a placement keeps its meaning when the ground under it moves.
      const origin = new Vector3(
        p.x,
        (p.y ?? 0) + terrain.heightAt(p.x, p.z),
        p.z,
      );
      const rotY = p.rotY ?? 0;
      const isRoad = p.kind === "road";
      // Where it lands is settled before it is built, because a builder may
      // need to read the ground under its footprint — one sample at the centre
      // is not enough for 130 m of road. The result is still origin-local.
      const builder = BUILDERS[p.kind];
      const s: Structure = builder(this.scene, this.mats, p.params ?? {}, {
        terrain,
        x: p.x,
        y: origin.y,
        z: p.z,
        rotY,
      });

      for (const merged of mergeByMaterial(s.meshes, p.kind)) {
        merged.rotation.y = rotY;
        merged.position.addInPlace(origin);
        if (item) {
          // The block merge is what makes a placement unrecoverable, so the
          // editor takes the draw-call hit and keeps its meshes separate.
          tag(merged, { list: "placements", index: i });
          item.visuals.push(merged);
          if (isRoad) {
            merged.metadata.noShadowCaster = true;
            // Roads are NOT outlined here. In play they are first merged into
            // one mesh, so the outline traces the road network's outer edge
            // once. Kept separate, each road's back-face shell is drawn over
            // whatever it overlaps — and roads overlap by design at every
            // junction, which paints a black patch across the crossing. The
            // selection highlight shows a road's extent instead.
          } else {
            addOutline(merged, 0.05);
          }
          visuals.push(merged);
        } else if (isRoad) {
          roadParts.push(merged);
        } else {
          blocks.add(p.x, p.z, merged);
        }
      }
      // Body boxes first, then the struts, so `item`'s three parallel arrays
      // agree on the order whichever kinds a structure declares.
      for (const box of s.colliders) {
        if (box.rayOnly) continue;
        const mesh = this.collider(`${p.kind}-col`, box, origin, rotY);
        if (item) {
          tag(mesh, { list: "placements", index: i });
          item.localBoxes.push(box);
        }
        colliders.push(mesh);
      }
      const strutSpecs = s.colliders.filter((box) => box.rayOnly);
      if (strutSpecs.length > 0) {
        const meshes = this.struts(
          `${p.kind}-timber`,
          strutSpecs,
          origin,
          rotY,
        );
        if (item) {
          // Unmerged in the editor, so these line up one for one with the
          // specs; the shipped build merges and has no item to keep.
          meshes.forEach((mesh, j) => {
            tag(mesh, { list: "placements", index: i });
            item.localBoxes.push(strutSpecs[j]);
          });
        }
        colliders.push(...meshes);
      }
      for (const l of s.lights) {
        const at = rotateY(l.x, l.y, l.z, rotY).addInPlace(origin);
        this.lighting.add(at, l.color, l.range, l.intensity, l.flicker);
      }
    }
    this.item = null;

    for (const merged of mergeByMaterial(roadParts, "roads")) {
      // Flat ground sheets receive shadows, never cast them.
      merged.metadata = { ...(merged.metadata ?? {}), noShadowCaster: true };
      if (!merged.metadata?.noOutline) addOutline(merged, 0.05);
      visuals.push(merged);
    }

    // --- scattered dressing ---
    for (const [i, spec] of layout.scatter.entries()) {
      const item = index ? newItem(index.scatter) : null;
      this.item = item;
      this.scatterRegion(spec, terrain, rng, blocks, colliders, item, i);
      if (item) for (const m of item.visuals) visuals.push(m);
    }
    this.item = null;

    // One more merge across neighbouring structures — see BlockMerge.
    for (const merged of blocks.finish()) {
      if (!merged.metadata?.noOutline) addOutline(merged, 0.05);
      visuals.push(merged);
    }

    // Ambient occlusion, and the position in this method is the whole of it.
    //
    // AFTER every merge, because `VertexData.merge` throws on a group where
    // some meshes carry `colors` and some do not, and `mergeByMaterial`
    // disposes its sources — which is what turns Babylon's attribute-aligning
    // path off. Baking last cannot hit that.
    //
    // BEFORE `markVisual`, which freezes the world matrices the bake needs to
    // recompute, and before the nav graph, which wants `this.boxes` for its own
    // reasons and is not affected either way.
    //
    // `this.boxes` is complete here — every `collider()` has run — and it is
    // the whole input besides the terrain. See `world/ambientOcclusion.ts` for
    // why the result lives in the vertex colour's alpha.
    const aoStart = performance.now();
    const aoVerts = bakeVertexAo(visuals, this.boxes, terrain, size);
    if (import.meta.env.DEV) {
      console.info(
        `[ao] ${aoVerts} vertices in ${(performance.now() - aoStart).toFixed(1)} ms`,
      );
    }

    for (const m of visuals) this.markVisual(m);

    // Navigation is derived from the finished collider set, then a flow field
    // is precomputed per objective: five flags plus both home spawns. The map
    // is static, so this is the only time any of it is computed.
    const nav = new NavGrid(size, this.boxes, terrain);
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
      // Cover needs the finished graph as well as the finished colliders, so it
      // is built last. Baked once here and only read from then on.
      cover: new CoverMap(nav, this.boxes),
      obstacles: new ObstacleField(size, this.boxes),
      controlPoints: layout.controlPoints,
      spawns: layout.spawns,
      colliders,
      colliderBoxes: this.boxes,
      rayGroups: this.rayGroups,
      terrainColliders,
      visuals,
      water: layout.water ?? [],
      grass: layout.grass ?? [],
      terrain,
      editor: index,
      dispose: () => {
        for (const m of visuals) m.dispose();
        for (const m of colliders) m.dispose();
        this.lighting.clear();
      },
    };
  }

  /** The valley floor plus the rim that bounds play. */
  private buildValley(
    size: number,
    env: EnvironmentSpec,
    terrain: TerrainField,
    visuals: Mesh[],
    colliders: Mesh[],
    /** The floor's blocks alone — see `GameMap.terrainColliders`. */
    terrainColliders: Mesh[],
    ridge: RidgeSpec | undefined,
  ): void {
    const floorMat = floorMaterial(
      this.mats,
      this.scene,
      env.floorColor,
      env.floorSurface,
    );
    for (const patch of terrainPatches(terrain, size, BLOCK_SIZE)) {
      const ground = new Mesh(`terrain-${patch.key}`, this.scene);
      patch.data.applyToMesh(ground);
      ground.material = floorMat;
      // Receiver only: a floor casting into its own depth map is pure acne.
      ground.metadata = { noShadowCaster: true };
      visuals.push(ground);

      // The floor is the one place a collider shares the visual's vertices.
      // `collider()` builds boxes and records a WorldBox for the nav grid, and
      // a heightfield is neither — NavGrid reads the TerrainField directly
      // instead, so this deliberately bypasses it.
      const col = new Mesh(`terrain-${patch.key}-col`, this.scene);
      patch.data.applyToMesh(col);
      col.isVisible = false;
      col.isPickable = true;
      // Vertical placement is the ground probe's job and bots never touch the
      // collidable list, so the floor stays out of moveWithCollisions.
      col.checkCollisions = false;
      // `surface` is the impact channel, and this is the only place in the
      // world that sets it to anything: the clone IS the heightfield, so it
      // is the one collider that can honestly say "ground". `collider()`
      // leaves the field absent on every box it makes, and absent reads as
      // "hard" — see `ImpactKind` in `systems/CombatSystem.ts`. Splitting the
      // boxes into stone/timber/metal later is a `surface` argument on
      // `collider()` and a row in that table; nothing here has to move.
      col.metadata = { solid: true, surface: "ground" };
      col.freezeWorldMatrix();
      colliders.push(col);
      terrainColliders.push(col);
    }

    // The boundary itself: four boxes, and they are the ONLY thing stopping
    // anything leaving the map. Five other systems — NavGrid (rasterize,
    // severLinks, clearBlocked), ObstacleField, CoverMap, Minimap and
    // DeployScreen — identify the boundary by `w > 200 || d > 200` and skip it,
    // so these must stay longer than 200 m and must stay the only boundary
    // colliders. They are invisible: what you see is the rim built below, whose
    // basal band is flush with the inner face at exactly ±half so sparks land
    // on the rock rather than in front of it.
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
      colliders.push(
        this.collider(`ridge-${name}-col`, { w, h, d, x, y: h / 2, z }),
      );
    }

    // The rim, as landform. Built outward from the boundary only, so it costs
    // no playable area — see Ridge.ts, which owns the shape and its invariants.
    for (const seg of ridgeSegments(ridge, size, terrain)) {
      const mesh = new Mesh(`ridge-${seg.key}`, this.scene);
      seg.data.applyToMesh(mesh);
      mesh.material = this.mats.get(
        seg.tone === "scree" ? env.ridgeScreeColor : env.ridgeColor,
      );
      // A 20-45 m crest throws 26-58 m of shadow at the moon's 38 deg, and the
      // shadow window is a fixed 110 m square that follows the player — so a
      // casting rim would end its shadow in a hard line that slides across open
      // ground as you walk. It is a receiver only.
      mesh.metadata = { noShadowCaster: true };
      addOutline(mesh, 0.05);
      visuals.push(mesh);
    }
  }

  /**
   * Sprinkles a prop through a region — a disc or an oriented rectangle — by
   * rejection sampling against what is already there. Counts are authored per
   * region rather than scaled from floor area the way the retired room
   * generator did it.
   *
   * Like a builder, this assembles **at the region's origin, unrotated**, and
   * the merged result is transformed into place afterwards. A rectangle is
   * therefore sampled in its own local frame and turned bodily by `rotY`, prop
   * yaws included, which is what lets the editor move and rotate a region by
   * writing one transform (`repositionItem`) instead of rebuilding it. The
   * rebuild then lands on the same offsets — bar the props whose new
   * surroundings reject them, which is the point of `findSpot`.
   *
   * Every instance in a region is merged into one mesh per colour. A stand of
   * sixteen dead trees becomes two draws instead of ninety-six — the trees do
   * not touch, so the outline pass still traces each trunk separately. The
   * cost is that the region culls as a unit, and is filed under the block its
   * CENTRE falls in: fine for a disc, and the reason to break a tree belt much
   * longer than the 78 m fog wall into a few rectangles rather than authoring
   * one that spans the map.
   */
  private scatterRegion(
    spec: ScatterSpec,
    terrain: TerrainField,
    rng: () => number,
    blocks: BlockMerge,
    colliders: Mesh[],
    item: EditorItem | null,
    index: number,
  ): void {
    const build = SCATTER_BUILDERS[spec.prop];
    const light = SCATTER_LIGHTS[spec.prop];
    const [minS, maxS] = scatterScale(spec);
    const placed: { x: number; z: number; r: number }[] = [];
    const parts: Mesh[] = [];
    // A disc has no orientation, so this is zero for every circular region —
    // which is every region on the shipped map.
    const rot = isScatterRect(spec) ? (spec.rotY ?? 0) : 0;
    const origin = new Vector3(
      spec.x,
      (spec.y ?? 0) + terrain.heightAt(spec.x, spec.z),
      spec.z,
    );

    for (let i = 0; i < spec.count; i++) {
      const scale = minS + rng() * (maxS - minS);
      const clearance = (spec.clearance ?? 0.8) * scale;
      const spot = this.findSpot(spec, rot, clearance, placed, rng);
      if (!spot) continue;
      placed.push({ x: spot.x, z: spot.z, r: clearance });

      // Sampled per prop, not per region: a stand of trees straddling a bank
      // should follow the bank rather than share one height and float. Stored
      // relative to the region's own floor, since that is what the transform
      // below adds back.
      const base = (spec.y ?? 0) + terrain.heightAt(spot.x, spot.z) - origin.y;

      const prop = build(this.scene, this.mats, rng);
      prop.scaling.setAll(scale);
      prop.position.x = spot.lx;
      prop.position.z = spot.lz;
      prop.position.y = prop.position.y * scale + base;
      // Drawn here and not a line earlier: `build` consumes the same seeded
      // stream, so moving this draw would reroll the whole dressing field.
      // Kept in a local because the collider below is oriented with the prop —
      // the only way a headstone or a fallen log gets a box that means anything.
      const yaw = rng() * Math.PI * 2;
      prop.rotation.y = yaw;
      // Bake the placement into the vertices, then hand the flattened
      // hierarchy to the merge — the same identity-transform trick the
      // structures use, applied one level up.
      parts.push(...flatten(prop));

      if (light) {
        this.lighting.add(
          new Vector3(spot.x, origin.y + base + light.y * scale, spot.z),
          light.color,
          light.range * scale,
          light.intensity,
          light.flicker,
        );
      }
      if (spec.blocking) {
        // The prop's measured body, oriented with it — not its placement
        // clearance squared off. See PROP_BODIES.
        const body = PROP_BODIES[spec.prop];
        const h = body.h * scale;
        const box = {
          w: body.w * scale,
          h,
          d: body.d * scale,
          x: spot.lx,
          y: base + h / 2,
          z: spot.lz,
          rotY: yaw,
        };
        const mesh = this.collider(`${spec.prop}-col`, box, origin, rot);
        // The region's own frame, so the editor can turn the field as a unit.
        if (item) item.localBoxes.push(box);
        colliders.push(mesh);
      }
    }

    for (const merged of mergeByMaterial(parts, `${spec.prop}-field`)) {
      merged.rotation.y = rot;
      merged.position.addInPlace(origin);
      if (item) {
        tag(merged, { list: "scatter", index });
        addOutline(merged, 0.05);
        item.visuals.push(merged);
      } else {
        blocks.add(spec.x, spec.z, merged);
      }
    }
  }

  /**
   * A free spot inside the region: 14 tries, rejecting anything that overlaps
   * an earlier prop or lands inside a structure's collider. Returns null to
   * skip.
   *
   * Both shapes draw exactly two numbers per attempt, in the same order, so
   * adding rectangles left every existing region's dressing field untouched.
   *
   * Returns the spot twice over: `lx`/`lz` in the region's own unrotated frame,
   * which is where the geometry is assembled, and `x`/`z` in the world, which
   * is what the rejection tests and the terrain sample need.
   */
  private findSpot(
    spec: ScatterSpec,
    rot: number,
    clearance: number,
    placed: { x: number; z: number; r: number }[],
    rng: () => number,
  ): { x: number; z: number; lx: number; lz: number } | null {
    for (let attempt = 0; attempt < 14; attempt++) {
      let lx: number;
      let lz: number;
      if (isScatterRect(spec)) {
        lx = (rng() - 0.5) * spec.width;
        lz = (rng() - 0.5) * spec.depth;
      } else {
        // sqrt keeps the distribution even rather than clumped at the centre.
        const a = rng() * Math.PI * 2;
        const r = Math.sqrt(rng()) * spec.radius;
        lx = Math.cos(a) * r;
        lz = Math.sin(a) * r;
      }
      const at = rotateY(lx, 0, lz, rot);
      const x = spec.x + at.x;
      const z = spec.z + at.z;

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
      if (ok) return { x, z, lx, lz };
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
    // The prop's visual reach, not its collider height: a lantern flame or a
    // spray of branches buried in a wall looks broken even though nothing
    // solid overlaps.
    const topY = baseY + PROP_BODIES[spec.prop].visualTop * scatterScale(spec)[1];
    // Padded by the placement clearance rather than by the prop's own
    // half-width, so a prop keeps visible daylight around it instead of merely
    // not intersecting.
    const pad = clearance;
    // The bucketed neighbours, then the two map-sized boxes the grid refuses.
    // The ridge is in that second list and it is load-bearing here: it is what
    // stops a prop being planted inside the valley wall.
    const near = boxesNear(this.boxIndex, x, z);
    if (
      near &&
      this.anyBuries(near, x, z, baseY, topY, pad)
    ) {
      return true;
    }
    return this.anyBuriesBoxes(this.boxIndex.oversized, x, z, baseY, topY, pad);
  }

  /** The burial test over indices into `boxIndex.boxes`. */
  private anyBuries(
    near: readonly number[],
    x: number,
    z: number,
    baseY: number,
    topY: number,
    pad: number,
  ): boolean {
    for (const i of near) {
      if (this.buries(this.boxIndex.boxes[i], x, z, baseY, topY, pad)) return true;
    }
    return false;
  }

  /** The same, over boxes held directly. */
  private anyBuriesBoxes(
    boxes: readonly WorldBox[],
    x: number,
    z: number,
    baseY: number,
    topY: number,
    pad: number,
  ): boolean {
    for (const b of boxes) {
      if (this.buries(b, x, z, baseY, topY, pad)) return true;
    }
    return false;
  }

  /** One box against one candidate spot. */
  private buries(
    b: WorldBox,
    x: number,
    z: number,
    baseY: number,
    topY: number,
    pad: number,
  ): boolean {
    // A tilted box (rotX ramps) spans a taller band than its thickness.
    let halfH = b.h / 2;
    if (b.rotX !== 0) halfH += (Math.abs(Math.sin(b.rotX)) * b.d) / 2;
    if (topY <= b.cy - halfH + 0.05 || baseY >= b.cy + halfH - 0.05) return false;
    // XZ overlap, tested in the box's local frame. The rotation is
    // `boxGeometry`'s rather than written out here — this call site had it
    // inverted, which mirrored the whole test across every yaw-rotated box
    // while carrying a comment describing the convention it was not using.
    // The extents test stays local because it pads by the placement
    // clearance, which `toLocalXZ` knows nothing about.
    const { lx, lz } = rotateToLocalXZ(b, x, z, this.localScratch);
    return Math.abs(lx) <= b.w / 2 + pad && Math.abs(lz) <= b.d / 2 + pad;
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

  /** Where a builder's local `BoxSpec` lands once the placement is applied. */
  private worldBoxOf(
    box: BoxSpec,
    origin?: Vector3,
    parentRotY = 0,
  ): WorldBox {
    const local = rotateY(box.x, box.y, box.z, parentRotY);
    const at = origin ? local.addInPlace(origin) : local;
    const world: WorldBox = {
      w: box.w,
      h: box.h,
      d: box.d,
      cx: at.x,
      cy: at.y,
      cz: at.z,
      rotX: box.rotX ?? 0,
      rotY: (box.rotY ?? 0) + parentRotY,
    };
    // Set rather than always written, so a box that is not porous carries no
    // key at all: `worldFingerprint` and the bake both walk these, and an
    // explicit `porous: false` on 820-odd boxes is a field in every baked
    // tuple to say nothing.
    if (box.porous) world.porous = true;
    return world;
  }

  /** The box itself, placed. Flags are the caller's — the two kinds differ. */
  private boxMesh(name: string, world: WorldBox): Mesh {
    const mesh = MeshBuilder.CreateBox(
      name,
      { width: world.w, height: world.h, depth: world.d },
      this.scene,
    );
    mesh.position.set(world.cx, world.cy, world.cz);
    mesh.rotation.set(world.rotX, world.rotY, 0);
    mesh.isVisible = false;
    mesh.isPickable = true;
    return mesh;
  }

  /** Tested, never drawn. The only geometry that carries `solid`. */
  private collider(
    name: string,
    box: BoxSpec,
    origin?: Vector3,
    parentRotY = 0,
  ): Mesh {
    const world = this.worldBoxOf(box, origin, parentRotY);
    const mesh = this.boxMesh(name, world);
    this.item?.boxes.push(this.boxes.length);
    this.item?.colliders.push(mesh);
    this.boxes.push(world);
    // The scatter index rides along here because this is the only place a
    // collider is ever made — the same property that makes `boxes` complete.
    // Feeding it anywhere else would leave the two able to disagree.
    insertBox(this.boxIndex, world);
    mesh.checkCollisions = true;
    // `porous` rides in the metadata rather than being answered by leaving
    // `solid` off, because the two questions have different answers and both
    // are asked of this mesh: it IS the solid world to a body (movement, the
    // ground probe) and is not there at all to a round. `OPAQUE_ONLY` is the
    // reader; dropping `solid` instead would let the player fall through a
    // fence top their own capsule is still being held out of.
    mesh.metadata = box.porous ? { solid: true, porous: true } : { solid: true };
    mesh.freezeWorldMatrix();
    return mesh;
  }

  /**
   * One placement's `strut`s: the ray geometry that stands where the timber is
   * drawn — a fence's posts and rails — as ONE collider mesh.
   *
   * **The merge is the whole reason this can afford to be honest.** A pick
   * costs per MESH far more than it costs per triangle: it runs the predicate,
   * inverts a world matrix and tests a bounding box before a triangle is ever
   * considered. Measured against Hollowmere's fences, 161 loose post and rail
   * boxes cost every ray in the game about 17% — the ground probe included,
   * and that is the most expensive single call the game makes per frame —
   * while the same geometry merged per fence costs the probe 1.4%, a shot
   * 0.3%, and 7.4% on the rays that actually cross a fence and have triangles
   * to test. Fourteen meshes, not a hundred and sixty-one.
   *
   * These emit no `WorldBox` and are not in `boxes`: navigation, cover, the
   * obstacle field and the AO bake read a fence's coarse `porous` box instead,
   * which is the shape they can represent (see `BoxSpec.rayOnly`). They go in
   * `rayGroups` instead, grouped exactly as merged, because the SERVER has to
   * rebuild the same geometry from the bake and a flat list would leave it
   * merging by guesswork.
   *
   * The editor gets them unmerged, for the reason it also skips the visual
   * `BlockMerge`: `repositionItem` walks colliders, local specs and boxes in
   * step, and one mesh standing for eleven specs cannot be moved that way.
   */
  private struts(
    name: string,
    specs: BoxSpec[],
    origin: Vector3,
    parentRotY: number,
  ): Mesh[] {
    const worlds = specs.map((s) => this.worldBoxOf(s, origin, parentRotY));
    this.rayGroups.push(worlds);
    const parts = worlds.map((w, i) => this.boxMesh(`${name}${i}`, w));
    for (const part of parts) {
      part.checkCollisions = false;
      part.metadata = { solid: true, rayOnly: true };
    }
    if (this.item) {
      for (const part of parts) {
        part.freezeWorldMatrix();
        // No `WorldBox` behind a strut, so there is no index to record — but
        // the slot is kept, because `repositionItem` reads these three arrays
        // in parallel and `boxes[-1]` is the undefined its guard expects.
        this.item.boxes.push(-1);
        this.item.colliders.push(part);
      }
      return parts;
    }
    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    if (!merged) return [];
    merged.name = name;
    merged.isVisible = false;
    merged.isPickable = true;
    merged.checkCollisions = false;
    merged.metadata = { solid: true, rayOnly: true };
    merged.freezeWorldMatrix();
    return [merged];
  }
}

/**
 * A scatter spec's scale range as a genuine `[min, max]`, whichever order it
 * was authored in.
 *
 * `spec.scale` is an interval, and nothing enforces which end is written
 * first: `scatterRegion` lerps between the two entries and reads the same
 * interval either way, and the editor writes the pair through two independent
 * number fields (`scale min` / `scale max` in `inspect.ts`) that can be left
 * crossed. Every reader that wants the TOP of the range has to sort for it —
 * taking `[1]` on faith is silently wrong on a descending pair, and both of
 * the readers below fail in the quiet direction: an under-padded `boxIndex`
 * misses boxes rather than reporting them (the failure its header names), and
 * an under-reaching `topY` clears a prop the wall would have buried.
 */
function scatterScale(spec: ScatterSpec): [number, number] {
  const [a, b] = spec.scale ?? [1, 1];
  return a <= b ? [a, b] : [b, a];
}

/**
 * The widest clearance any of this layout's scatter regions can ask about —
 * what `boxIndex` has to be padded by so no burial test can miss a box.
 *
 * `findSpot` queries with `(spec.clearance ?? 0.8) * scale` where `scale` is
 * drawn from the spec's own range, so the maximum is over the top of that
 * range. The `+ 1` is the same slack `findSpot` adds to its neighbour test and
 * costs nothing here: a wider pad is a slower index, never a wrong one.
 */
function maxScatterClearance(layout: MapLayout): number {
  let max = 0;
  for (const spec of layout.scatter ?? []) {
    max = Math.max(max, (spec.clearance ?? 0.8) * scatterScale(spec)[1]);
  }
  return max + 1;
}

/** Appends a fresh, empty item to an editor list and returns it. */
function newItem(into: EditorItem[]): EditorItem {
  const item: EditorItem = {
    visuals: [],
    colliders: [],
    boxes: [],
    localBoxes: [],
  };
  into.push(item);
  return item;
}

/**
 * Moves and rotates a built item to a new placement, in place — visuals,
 * collider proxies, and the WorldBoxes the nav grid reads.
 *
 * No rebuild is needed for this: a builder assembles at the origin and
 * MapBuilder transforms the result, so a placement's transform is the only
 * thing that changes. Re-running the builder would give the same geometry at a
 * different transform, one hundred times more slowly.
 *
 * Editor-only. It leaves `nav` and `obstacles` stale — they are derived from
 * the boxes at build time and must be rebuilt by the caller when it wants
 * navigation to agree with what is on screen again.
 */
export function repositionItem(
  item: EditorItem,
  boxes: WorldBox[],
  origin: Vector3,
  rotY: number,
): void {
  for (const m of item.visuals) {
    m.unfreezeWorldMatrix();
    m.position.copyFrom(origin);
    m.rotation.y = rotY;
    m.freezeWorldMatrix();
  }
  for (let i = 0; i < item.colliders.length; i++) {
    const spec = item.localBoxes[i];
    const mesh = item.colliders[i];
    if (!spec || !mesh) continue;
    const at = rotateY(spec.x, spec.y, spec.z, rotY).addInPlace(origin);
    const rotX = spec.rotX ?? 0;
    const ry = (spec.rotY ?? 0) + rotY;
    mesh.unfreezeWorldMatrix();
    mesh.position.copyFrom(at);
    mesh.rotation.set(rotX, ry, 0);
    mesh.freezeWorldMatrix();
    const box = boxes[item.boxes[i]];
    if (box) {
      box.cx = at.x;
      box.cy = at.y;
      box.cz = at.z;
      box.rotX = rotX;
      box.rotY = ry;
    }
  }
}

/**
 * Records which layout item a mesh belongs to. The editor picks with a
 * predicate on this, which is why visuals can stay `isPickable = false`:
 * Babylon skips the isPickable test entirely when a pick supplies a predicate,
 * so the visual/collider split survives the editor untouched.
 */
function tag(mesh: Mesh, ref: EditorRef): void {
  mesh.metadata = { ...(mesh.metadata ?? {}), editorRef: ref };
}

/**
 * Side of a merge block, in metres. 48 m over a 240 m map gives a 5x5 grid of
 * blocks — coarse enough that the whole village collapses into a few dozen
 * draws, fine enough that frustum culling still throws away most of the map.
 * Well under the 78 m fog wall, so a block is never half-visible for long.
 */
export const BLOCK_SIZE = 48;

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
 * The render exemptions a merged mesh may carry, and the reason they are part
 * of the merge KEY rather than something read off a member.
 *
 * `noOutline` could have been propagated from any one mesh safely, because it
 * tracks the MATERIAL: the kit's `glow()` reaches for `getEmissive`, so an
 * emissive group is unanimous by construction and the group key already
 * implies the flag. `noGlow` and `noShadowCaster` track a mesh's ROLE, which
 * is orthogonal to its colour — a flat sheet that must not cast stands in the
 * same paint as the wall behind it. Reading either off one member would hand
 * the whole colour group an exemption one mesh asked for, and through
 * `BlockMerge` that group is every structure within 48 m; requiring unanimity
 * instead would drop the exemption the one mesh genuinely needed. Both fail
 * silently. Keying splits a disagreeing group into one merged mesh per
 * exemption set, which costs a draw call exactly when there is a real
 * disagreement to represent and nothing at all otherwise.
 *
 * `solid` is deliberately NOT in the set — a merged VISUAL is never a
 * collider, and carrying it up would break the one rule the world layer cannot
 * bend.
 */
const EXEMPTIONS = ["noOutline", "noGlow", "noShadowCaster"] as const;

type Exemption = (typeof EXEMPTIONS)[number];

/** A mesh's exemptions, in a fixed order so the key is stable. */
function exemptionsOf(mesh: Mesh): Exemption[] {
  return EXEMPTIONS.filter((flag) => mesh.metadata?.[flag] === true);
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
  // Material first, then exemption set — see `EXEMPTIONS`. Nested rather than
  // keyed on a composed string, because two distinct materials are free to
  // share a name and a merge across them would draw one of them wrong.
  const groups = new Map<Material, Map<string, Group>>();
  for (const m of meshes) {
    const mat = m.material;
    if (!mat) continue;
    let byExemption = groups.get(mat);
    if (!byExemption) groups.set(mat, (byExemption = new Map()));
    const flags = exemptionsOf(m);
    const key = flags.join("-");
    const group = byExemption.get(key);
    if (group) group.meshes.push(m);
    else byExemption.set(key, { flags, meshes: [m] });
  }

  const out: Mesh[] = [];
  for (const [mat, byExemption] of groups) {
    for (const { flags, meshes: group } of byExemption.values()) {
      const merged =
        group.length === 1
          ? // A merge of two or more bakes their world matrices; a group of one
            // has to be baked by hand or the promise above is a lie for exactly
            // the colours only one mesh uses — and the caller, which positions
            // and rotates what it gets back, would clobber that mesh's own
            // transform instead of composing with it.
            group[0].bakeCurrentTransformIntoVertices()
          : Mesh.MergeMeshes(group, true, true, undefined, false, false);
      if (!merged) continue;
      // Suffixed only where a group actually splits, so the common name is the
      // one the rest of the tree already reads in a profile.
      merged.name = `${tag}-${mat.name}${flags.map((f) => `-${f}`).join("")}`;
      merged.material = mat;
      // From the KEY, not from a member — and this half of it was not a
      // precaution, it was a live bug. The exemption used to be read back off
      // the group AFTER the merge, and `MergeMeshes` is called with
      // `disposeSource = true`, so by then Babylon's `Node.dispose` has set
      // every source's `metadata` to null and the read came back false for any
      // group of two or more. Only a group of ONE survived it, because that
      // path bakes in place and disposes nothing. Measured on Hollowmere: 19
      // of the map's 42 merged emissive meshes lost `noOutline` here and were
      // handed an outline shell by the caller — a black ring drawn around
      // every lantern, flame and sign dense enough to have a neighbour its own
      // colour. Grouping first means the flags are read while the meshes are
      // still alive, and the group is unanimous, so the key is what they said.
      for (const flag of flags) {
        merged.metadata = { ...(merged.metadata ?? {}), [flag]: true };
      }
      out.push(merged as Mesh);
    }
  }
  return out;
}

/** One merge group: the meshes, and the exemptions they all agree on. */
type Group = { flags: Exemption[]; meshes: Mesh[] };
