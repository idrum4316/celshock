/**
 * ShadowSystem.ts — Owns the moon's shadow camera and the contact shadows
 * under combatants.
 *
 * The DirectionalLight here is the scene's ONLY Babylon light, and it exists
 * purely to define the shadow frustum: no material reads scene lights (cel
 * materials carry their own uniforms, effect materials are unlit), so it
 * shades nothing directly. Its ShadowGenerator renders a depth map that the
 * cel fragment shader samples as a hard two-level shadow term.
 *
 * Casters are the merged static world meshes, re-registered via setCasters()
 * after every map build (the map is disposed and rebuilt per round).
 * Characters never cast into the map — the player rig is ~60 meshes and each
 * bot 9, so per-frame caster cost would dwarf the ~40 merged static draws.
 * They get blob shadows instead: soft unlit alpha discs that follow each
 * combatant (raycast to the ground for the airborne-capable player, the
 * nav-surface height for always-grounded bots).
 *
 * Invariants:
 * - The light position is snapped to the shadow map's texel grid as it
 *   tracks the player, so shadow edges stay rock steady instead of crawling.
 * - The depth map re-renders only when the snapped focus moves.
 * - The depth pass draws only the casters standing in the window (see
 *   getCustomRenderList) — Babylon culls nothing off an explicit renderList.
 * - Meshes with metadata.noShadowCaster (flat ground sheets, roads) must
 *   never be registered — they are receivers, and casting from them is acne.
 * - Blob discs are isPickable=false, metadata.noOutline, and never casters.
 * - updateBlobs takes the player's ground height rather than probing for it:
 *   Player.floorY is that number, already found this frame.
 */
import {
  type AbstractMesh,
  Color3,
  DirectionalLight,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  RenderTargetTexture,
  type Scene,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import type { Combatant } from "../entities/Combatant";
import type { CelMaterialFactory } from "../shaders/CelShader";

export class ShadowSystem {
  private readonly light: DirectionalLight;
  private readonly generator: ShadowGenerator;
  private readonly blobMaterial: StandardMaterial;
  private readonly blobs = new Map<Combatant, Mesh>();
  /** Last texel-snapped focus; forces a first update. */
  private readonly snappedFocus = new Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  /**
   * The two cross-axes of the light's own basis, kept from `update` so the
   * render-list cull can project casters into it. The third is the light's
   * direction, which `DirectionalLight` already holds.
   */
  private readonly xAxis = new Vector3(1, 0, 0);
  private readonly yAxis = new Vector3(0, 1, 0);
  /** Scratch for the cull, rebuilt on the frames the depth pass re-renders. */
  private readonly windowCasters: AbstractMesh[] = [];
  private fogStart = 24;
  private fogEnd = 78;

  constructor(private scene: Scene, mats: CelMaterialFactory) {
    const c = CONFIG.graphics.shadows;
    this.light = new DirectionalLight(
      "moonShadow",
      new Vector3(-0.3, -0.85, 0.42).normalize(),
      scene,
    );
    // Fixed square ortho window; auto-extends against the render list would
    // stretch the window to the whole 240 m map and halve the texel density.
    this.light.shadowFrustumSize = c.frustumSize;
    this.light.shadowMinZ = 1;
    this.light.shadowMaxZ = c.depthRange;
    this.light.autoUpdateExtends = false;

    this.generator = new ShadowGenerator(c.mapSize, this.light);
    // Bias lives consumer-side in the cel shader (shadowParams), where the
    // facet normal is known — not baked into the caster depths.
    this.generator.bias = 0;
    const map = this.generator.getShadowMap();
    if (map) {
      // Re-render only when told to (resetRefreshCounter in update/setCasters)
      // — the world is static, so the depth pass is wasted on frames where
      // the texel-snapped light window didn't move.
      map.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      map.resetRefreshCounter();
      // Draw only what stands in the window. Babylon culls NOTHING off an
      // explicit renderList — `ObjectRenderer._prepareRenderingManager`
      // dispatches every mesh that is enabled and visible — so without this
      // the depth pass submits the whole village on every re-render: measured
      // at 314 casters and 79k triangles, against ~150 that can reach the
      // window. It is called only on the frames that actually re-render,
      // which is why the cull is computed here rather than kept up to date in
      // `update`.
      map.getCustomRenderList = () => this.cullToWindow(map.renderList ?? []);
    }
    mats.setShadowMap(this.generator.getShadowMap()!);
    mats.setShadowParams(c.bias, c.darkness, c.normalBias);

    // Blob shadow: a radial-gradient disc, unlit black, depth-write off so it
    // layers over the ground without z-fighting.
    const tex = new DynamicTexture(
      "blobShadowTex",
      { width: 128, height: 128 },
      scene,
      false,
    );
    const ctx = tex.getContext();
    const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 64);
    grad.addColorStop(0, "rgba(0,0,0,1)");
    grad.addColorStop(0.55, "rgba(0,0,0,0.55)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    tex.update();
    this.blobMaterial = new StandardMaterial("blobShadow", scene);
    this.blobMaterial.emissiveColor = Color3.Black();
    this.blobMaterial.diffuseColor = Color3.Black();
    this.blobMaterial.specularColor = Color3.Black();
    this.blobMaterial.disableLighting = true;
    this.blobMaterial.opacityTexture = tex;
    this.blobMaterial.disableDepthWrite = true;
  }

  /** Points the shadow camera along the environment's key light. */
  setLightDirection(direction: readonly [number, number, number]): void {
    this.light.direction = new Vector3(
      direction[0],
      direction[1],
      direction[2],
    ).normalize();
    // Invalidate the snapped focus so the light re-centres on next update.
    this.snappedFocus.setAll(Number.POSITIVE_INFINITY);
  }

  /** Blob shadows fade with the same fog wall that hides distant geometry. */
  setFogRange(start: number, end: number): void {
    this.fogStart = start;
    this.fogEnd = end;
  }

  /**
   * Replaces the caster set with the freshly built map's visual meshes.
   * Called after every MapBuilder.build() — the previous round's meshes are
   * disposed, and a stale renderList entry would break the depth pass.
   */
  setCasters(meshes: readonly Mesh[]): void {
    const map = this.generator.getShadowMap();
    const list = map?.renderList;
    if (list) {
      for (const m of list.slice()) this.generator.removeShadowCaster(m, false);
    }
    for (const m of meshes) {
      if (m.metadata?.noShadowCaster) continue;
      this.generator.addShadowCaster(m, false);
    }
    map?.resetRefreshCounter();
  }

  /**
   * The casters that can write into the current shadow window.
   *
   * The light is ORTHOGRAPHIC, so a caster's shadow lands at its own position
   * in the light's plane — depth slides it along the view axis and never
   * sideways. That is what makes this exact rather than a guess: testing a
   * caster's bounds against the window in that plane cannot drop anything that
   * could have darkened a texel, so the depth map is identical to the one the
   * full list produces. A cull that had to allow for shadows cast in from
   * outside would need the window extended along the light, and this one does
   * not.
   *
   * The caster is measured as its world BOX rather than its bounding sphere —
   * the |e·a| half-extent projection, exact for an AABB — because a block
   * merge produces meshes that are wide and flat, and a sphere around one has
   * a 34 m radius where the block is four metres tall. Measured on Hollowmere:
   * 314 casters to 153 through the sphere, to ~150 through the box.
   *
   * **What bounds this is the granularity of a caster, not the test.** Every
   * caster is one `BlockMerge` mesh — one per 48 m map block per colour, ~12
   * to a block — so a 110 m window straddling four blocks each way admits
   * everything in sixteen of them however tight the arithmetic. Splitting them
   * finer would cull better and cost the main pass the draw calls the merge
   * exists to save, which is a bad trade in the other direction.
   *
   * Every caster's world matrix is frozen, so this is a handful of dot
   * products per caster on the frames that re-render.
   */
  private cullToWindow(all: readonly AbstractMesh[]): AbstractMesh[] {
    const c = CONFIG.graphics.shadows;
    const half = c.frustumSize / 2;
    const dir = this.light.direction;
    const ax = this.xAxis;
    const ay = this.yAxis;
    // Where the light's camera sits along its own view axis. The window's
    // near and far planes are measured from there.
    const camDepth = this.snappedFocus.z - c.distance;
    const near = camDepth + this.light.shadowMinZ;
    const far = camDepth + this.light.shadowMaxZ;
    const list = this.windowCasters;
    list.length = 0;
    for (const mesh of all) {
      const box = mesh.getBoundingInfo().boundingBox;
      const p = box.centerWorld;
      const e = box.extendSizeWorld;
      const u = p.x * ax.x + p.y * ax.y + p.z * ax.z;
      const ru = Math.abs(e.x * ax.x) + Math.abs(e.y * ax.y) + Math.abs(e.z * ax.z);
      if (Math.abs(u - this.snappedFocus.x) > half + ru) continue;
      const v = p.x * ay.x + p.y * ay.y + p.z * ay.z;
      const rv = Math.abs(e.x * ay.x) + Math.abs(e.y * ay.y) + Math.abs(e.z * ay.z);
      if (Math.abs(v - this.snappedFocus.y) > half + rv) continue;
      const w = p.x * dir.x + p.y * dir.y + p.z * dir.z;
      const rw =
        Math.abs(e.x * dir.x) + Math.abs(e.y * dir.y) + Math.abs(e.z * dir.z);
      if (w + rw < near || w - rw > far) continue;
      list.push(mesh);
    }
    return list;
  }

  /**
   * Forces the depth pass to re-render next frame even though the snapped
   * focus has not moved. `update()` skips the render when the window has not
   * shifted, which is right in play — the map is static — but wrong when a
   * caster itself moves, as it does under the map editor's drag.
   */
  invalidate(): void {
    this.generator.getShadowMap()?.resetRefreshCounter();
  }

  /**
   * Recentres the shadow window on the focus (the player, biased a little
   * along the camera's view) and re-uploads the light matrix. The recenter
   * is snapped to whole shadow-map texels in the light's own view basis:
   * moving the window by an integer number of texels leaves every texel on
   * the same world spot, so edges never crawl. The depth pass re-renders
   * only when the snapped focus actually changed.
   */
  update(focus: Vector3, mats: CelMaterialFactory): void {
    const c = CONFIG.graphics.shadows;
    const dir = this.light.direction;
    const texel = c.frustumSize / c.mapSize;
    // LookAtLH basis: x = normalize(cross(up, z)), y = cross(z, x). Kept on
    // the instance rather than in locals because the render-list cull projects
    // into the same basis, and because this runs every frame — the ToRef forms
    // are what stop it allocating four vectors to do it.
    const xAxis = this.xAxis;
    const yAxis = this.yAxis;
    Vector3.CrossToRef(Vector3.UpReadOnly, dir, xAxis);
    xAxis.normalize();
    Vector3.CrossToRef(dir, xAxis, yAxis);
    yAxis.normalize();
    const sx = Math.round(Vector3.Dot(focus, xAxis) / texel) * texel;
    const sy = Math.round(Vector3.Dot(focus, yAxis) / texel) * texel;
    // The depth axis is snapped too: an unsnapped window sliding along the
    // light direction shifts receiver depths against caster depths and the
    // hard edges crawl just the same.
    const sz = Math.round(Vector3.Dot(focus, dir) / texel) * texel;
    if (
      sx !== this.snappedFocus.x ||
      sy !== this.snappedFocus.y ||
      sz !== this.snappedFocus.z
    ) {
      this.snappedFocus.set(sx, sy, sz);
      const depth = sz - c.distance;
      this.light.position.set(
        xAxis.x * sx + yAxis.x * sy + dir.x * depth,
        xAxis.y * sx + yAxis.y * sy + dir.y * depth,
        xAxis.z * sx + yAxis.z * sy + dir.z * depth,
      );
      this.generator.getShadowMap()?.resetRefreshCounter();
    }
    mats.setShadowMatrix(this.generator.getTransformMatrix());
  }

  /**
   * Moves every combatant's blob to their feet. Bots' `position.y` IS the nav
   * surface they stand on; the player can be airborne, so their blob needs the
   * floor found under them rather than their own height.
   *
   * That floor is PASSED IN, and it is `Player.floorY` — the number
   * `Player.probeGround` found on this same frame, a few calls earlier in
   * `updateGameplay`. This used to cast its own downward ray for it, which was
   * the identical probe against the identical collider set for the identical
   * body: measured at 1.45 ms a frame, because `scene.pickWithRay` with a
   * predicate walks all 1,775 meshes and ray-tests all 758 solid colliders.
   * Two whole-scene picks a frame where the game only ever needed one.
   *
   * Blobs fade out toward the fog wall.
   */
  updateBlobs(
    player: Combatant,
    bots: readonly Combatant[],
    camPos: Vector3,
    playerGroundY: number,
  ): void {
    this.updateBlob(player, camPos, playerGroundY);
    for (const bot of bots) this.updateBlob(bot, camPos, bot.position.y);
  }

  private updateBlob(cbt: Combatant, camPos: Vector3, groundY: number): void {
    const blob = this.blobFor(cbt);
    if (!cbt.alive) {
      blob.setEnabled(false);
      return;
    }
    blob.setEnabled(true);
    blob.position.set(cbt.position.x, groundY + 0.04, cbt.position.z);
    const dist = Vector3.Distance(camPos, blob.position);
    const fade = Math.min(
      1,
      Math.max(0, 1 - (dist - this.fogStart) / (this.fogEnd - this.fogStart)),
    );
    blob.visibility = CONFIG.graphics.shadows.blobOpacity * fade;
  }

  private blobFor(cbt: Combatant): Mesh {
    let blob = this.blobs.get(cbt);
    if (!blob) {
      blob = MeshBuilder.CreateDisc(
        "blobShadow",
        { radius: CONFIG.graphics.shadows.blobRadius, tessellation: 32 },
        this.scene,
      );
      blob.rotation.x = -Math.PI / 2; // CreateDisc faces +Z; tip it face-up
      blob.material = this.blobMaterial;
      blob.isPickable = false;
      blob.metadata = { noOutline: true, noGlow: true };
      this.blobs.set(cbt, blob);
    }
    return blob;
  }
}
