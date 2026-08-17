/**
 * server/world.ts — Rebuilds a map's SOLID world under a NullEngine, from the
 * baked collider set plus the layout.
 * Owns: the collider meshes the server's rays pick against, the terrain floor's
 * collider clones, and the nav/cover/obstacle structures built from them.
 * Invariants: this is the collider half of `MapBuilder.build` and nothing else
 * — no visuals, no materials, no textures, no AO bake, and the one merge here
 * is `strutMesh`, which merges COLLIDERS and draws nothing. It must produce
 * geometry that lines up with the client's exactly, or a shot that lands on a
 * wall here passes through it there.
 *
 * Why a rebuild and not a build: the server has no canvas, so
 * `DynamicTexture.getContext()` throws and `MapBuilder` cannot run at all (it
 * reaches one through `floorMaterial`). See `scripts/bake-collision.mjs`.
 *
 * Two sources, and the split is not arbitrary:
 *
 *   - **The boxes are baked**, because they come out of the structure builders
 *     and those build meshes and read textures. `MapBuilder.collider()` is the
 *     only place a collider is made and the `WorldBox` it records carries
 *     everything `CreateBox` needs, so the bake is lossless.
 *   - **Everything else is read from the layout**, because it is already data
 *     or already arithmetic: control points and spawns pass through
 *     `MapBuilder.build` untouched, and the floor is `TerrainField`. Baking
 *     those too would be three more things that can go stale for no gain.
 *
 * The four boundary boxes need no special handling — `collider()` made them,
 * so they are in the bake like everything else, and they keep the `w > 200 ||
 * d > 200` shape that `NavGrid`, `ObstacleField` and `CoverMap` identify the
 * boundary by.
 */
import { Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../src/config";
import {
  toRayGroups,
  toWorldBoxes,
  type MapCollision,
} from "../src/world/collision";
import { CoverMap } from "../src/world/CoverMap";
import type { GameMap, WorldBox } from "../src/world/MapBuilder";
import { BLOCK_SIZE } from "../src/world/MapBuilder";
import type { MapDef } from "../src/world/maps";
import { NavGrid } from "../src/world/NavGrid";
import { ObstacleField } from "../src/world/ObstacleField";
import { TerrainField, terrainPatches } from "../src/world/TerrainField";

/**
 * Builds one collider box, matching `MapBuilder.collider()` exactly.
 *
 * The flags are the contract every ray test in the game reads: `solid` is what
 * `SOLID_ONLY` filters on, `porous` is what `OPAQUE_ONLY` subtracts from it,
 * and `MapBuilder` deliberately leaves `surface` absent so the box reads as
 * "hard". All three are copied here rather than shared
 * because the two functions build from different inputs — one from a `BoxSpec`
 * in a structure's local frame, one from a `WorldBox` already in world space —
 * and the only thing they have in common is the result.
 */
function colliderBox(scene: Scene, box: WorldBox, i: number): Mesh {
  const mesh = MeshBuilder.CreateBox(
    `col${i}`,
    { width: box.w, height: box.h, depth: box.d },
    scene,
  );
  mesh.position.set(box.cx, box.cy, box.cz);
  mesh.rotation.set(box.rotX, box.rotY, 0);
  mesh.isVisible = false;
  mesh.isPickable = true;
  // `checkCollisions` is what `moveWithCollisions` walks, and nothing on the
  // server moves that way — the client does its own movement and the bots never
  // touched the collidable list. Left on anyway so the mesh is identical to the
  // client's in every field a future reader might compare.
  mesh.checkCollisions = true;
  // `porous` copied through for the reason the whole file exists: the server
  // resolves every shot, so a fence it thought was solid would eat rounds the
  // shooter watched go between the rails, and the client would be showing a
  // hitmarker the authority disagrees with.
  mesh.metadata = box.porous ? { solid: true, porous: true } : { solid: true };
  mesh.freezeWorldMatrix();
  return mesh;
}

/**
 * One group of `strut` boxes as the single collider mesh the client merged them
 * into — a fence's posts and rails.
 *
 * **This is the one merge on the server, and it is here because the client's
 * pick has to meet the same geometry the server's does.** The header's "no
 * merges" is about visuals: there is nothing to draw here and this produces no
 * material, no texture and no draw call — it is a triangle soup that exists to
 * be picked, and merging is what keeps the cost of picking it flat. Group by
 * group, exactly as baked: merging all of them into one mesh would wrap one
 * bounding box around every fence in the village, and then every ray this
 * process fires would pay for all of them.
 *
 * `rayOnly` keeps it out of `SOLID_ONLY`, matching the client, so the movement
 * validator and everything else that asks where a body may be never sees a
 * rail. Nothing here is in `colliderBoxes`, so the nav graph, the cover bake
 * and the obstacle field never see one either — which is what keeps this world
 * identical to the one `npm run parity` compares.
 */
function strutMesh(scene: Scene, group: WorldBox[], i: number): Mesh {
  const parts = group.map((box, j) => {
    const part = MeshBuilder.CreateBox(
      `timber${i}-${j}`,
      { width: box.w, height: box.h, depth: box.d },
      scene,
    );
    part.position.set(box.cx, box.cy, box.cz);
    part.rotation.set(box.rotX, box.rotY, 0);
    return part;
  });
  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  if (!merged) throw new Error(`strut group ${i} failed to merge`);
  merged.name = `timber${i}`;
  merged.isVisible = false;
  merged.isPickable = true;
  merged.checkCollisions = false;
  merged.metadata = { solid: true, rayOnly: true };
  merged.freezeWorldMatrix();
  return merged;
}

/**
 * The floor, as collider clones — one mesh per terrain block.
 *
 * This is the one collider in the game that is not a box, and the one that
 * carries `surface: "ground"`. It matters here for the same reason it matters
 * on the client: without it, line of sight runs straight through hills, and a
 * bot on the far side of a rise is visible to one that should not see it.
 * `terrainPatches` is pure arithmetic over the heightfield, so it costs the
 * server nothing that the bake would have saved.
 */
function terrainColliders(scene: Scene, terrain: TerrainField, size: number): Mesh[] {
  const out: Mesh[] = [];
  for (const patch of terrainPatches(terrain, size, BLOCK_SIZE)) {
    const col = new Mesh(`terrain-${patch.key}-col`, scene);
    patch.data.applyToMesh(col);
    col.isVisible = false;
    col.isPickable = true;
    // Vertical placement is the ground probe's job — the same reason the client
    // keeps the floor out of `moveWithCollisions`.
    col.checkCollisions = false;
    col.metadata = { solid: true, surface: "ground" };
    col.freezeWorldMatrix();
    out.push(col);
  }
  return out;
}

/**
 * Rebuilds `def`'s solid world into `scene`.
 *
 * Returns a real `GameMap` so the systems that consume one need no server-only
 * variant — `BattleSystem.setMap` reads `nav`/`cover`/`obstacles` and
 * `ConquestSystem.start` reads `controlPoints`/`spawns`, and both get exactly
 * what they get on the client. The two fields that are genuinely absent are
 * `visuals` (there is nothing to draw) and `editor` (there is no editor); both
 * are empty rather than faked.
 */
export async function buildServerWorld(scene: Scene, def: MapDef): Promise<GameMap> {
  const collision: MapCollision = (await def.collision()).default;
  // The layout's own extent, exactly as `MapBuilder.build` reads it: a server
  // that took the global would rasterize a larger map's nav grid over a 240 m
  // square and steer bots against a world a third the size of the clients'.
  const size = def.layout.size ?? CONFIG.map.size;
  const terrain = new TerrainField(def.layout.terrain);
  const boxes = toWorldBoxes(collision);

  const colliders = boxes.map((box, i) => colliderBox(scene, box, i));
  const rayGroups = toRayGroups(collision);
  colliders.push(...rayGroups.map((group, i) => strutMesh(scene, group, i)));
  const floor = terrainColliders(scene, terrain, size);
  colliders.push(...floor);

  // Same order and same inputs as `MapBuilder.build`: the graph is derived from
  // the finished collider set, never from the geometry that suggested it.
  const nav = new NavGrid(size, boxes, terrain, def.layout.surfaces);
  const cover = new CoverMap(nav, boxes);
  const obstacles = new ObstacleField(size, boxes);

  // One flow field per objective, plus a route home per team — the set
  // `BattleSystem.fieldFor`/`homeFieldFor` ask for by name.
  //
  // The two radii are `MapBuilder.build`'s and must stay equal to it: a goal
  // radius decides how big the flat-bottomed basin at the end of the field is,
  // so a server that used a different one would send bots to a subtly different
  // place from where the clients draw them walking.
  for (const cp of def.layout.controlPoints) {
    nav.buildField(cp.id, cp.pos, cp.radius * 0.6);
  }
  for (const team of [0, 1] as const) {
    const home = def.layout.spawns.find((s) => s.team === team);
    if (home) nav.buildField(`home${team}`, home.pos, 6);
  }

  return {
    size,
    controlPoints: def.layout.controlPoints,
    spawns: def.layout.spawns,
    colliders,
    colliderBoxes: boxes,
    rayGroups,
    terrainColliders: floor,
    visuals: [],
    nav,
    obstacles,
    cover,
    // Passed through rather than left empty. Nothing on the server reads them —
    // water and grass are visual — but a `GameMap` that disagrees with the
    // client's about what the map contains is a trap for whoever next writes a
    // rule that does read them.
    water: def.layout.water ?? [],
    grass: def.layout.grass ?? [],
    terrain,
    dispose(): void {
      for (const mesh of colliders) mesh.dispose();
    },
  };
}

/** Where the ground is at a point — what movement validation measures against. */
export function groundAt(map: GameMap, x: number, z: number): number {
  return map.terrain.heightAt(x, z);
}

/** Scratch so the helpers above never allocate per call. */
export const scratch = new Vector3();
