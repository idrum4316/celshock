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
 * - Meshes with metadata.noShadowCaster (flat ground sheets, roads) must
 *   never be registered — they are receivers, and casting from them is acne.
 * - Blob discs are isPickable=false, metadata.noOutline, and never casters.
 */
import {
  Color3,
  DirectionalLight,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Ray,
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
  /** Reused ray for the player's ground probe — no per-frame allocation. */
  private readonly groundRay = new Ray(Vector3.Zero(), new Vector3(0, -1, 0), 12);
  /** Last texel-snapped focus; forces a first update. */
  private readonly snappedFocus = new Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
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
    // LookAtLH basis: x = normalize(cross(up, z)), y = cross(z, x).
    const xAxis = Vector3.Cross(Vector3.Up(), dir).normalize();
    const yAxis = Vector3.Cross(dir, xAxis).normalize();
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
      this.light.position.copyFrom(
        xAxis
          .scale(sx)
          .addInPlace(yAxis.scale(sy))
          .addInPlace(dir.scale(sz - c.distance)),
      );
      this.generator.getShadowMap()?.resetRefreshCounter();
    }
    mats.setShadowMatrix(this.generator.getTransformMatrix());
  }

  /**
   * Moves every combatant's blob to their feet. Bots' `position.y` IS the
   * nav surface they stand on; the player can be airborne, so their ground
   * comes from a downward raycast against the collider set (one pick per
   * frame). Blobs fade out toward the fog wall.
   */
  updateBlobs(
    player: Combatant,
    bots: readonly Combatant[],
    camPos: Vector3,
  ): void {
    this.updateBlob(player, camPos, this.groundYUnder(player.position));
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

  /** Ground height under a point: first `solid` collider straight down. */
  private groundYUnder(pos: Vector3): number {
    this.groundRay.origin.set(pos.x, pos.y + 1, pos.z);
    const hit = this.scene.pickWithRay(
      this.groundRay,
      (m) => m.metadata?.solid === true,
    );
    return hit?.hit && hit.pickedPoint ? hit.pickedPoint.y : pos.y;
  }
}
