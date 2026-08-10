/**
 * WaterSystem.ts — Water surfaces built from the map's WaterRects; syncs each
 * water material's time/camera/point-light uniforms every frame.
 * Invariants: water meshes are unpickable, non-colliding, and never carry
 * metadata.solid — ray tests must not see them. update() runs after the camera
 * and LightingSystem updates (shares the same 16 light slots). Meshes are
 * frozen; the two tiling textures are loaded once and reused across rebuilds.
 * A rect without its own `y` floats ankle-deep above the TERRAIN under it, not
 * above absolute zero — that is what lets a pool sit recessed in a dug bed.
 * The BED-DEPTH map is per body and per build — it is baked against the
 * TerrainField this build was handed, so it is exactly as disposable as the
 * mesh, and a stale one would draw last build's shoreline.
 */
import {
  Color3,
  Constants,
  type GlowLayer,
  Mesh,
  MeshBuilder,
  RawTexture,
  Scene,
  type ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  Vector4,
} from "@babylonjs/core";

import { CONFIG } from "../config";
import { MAX_POINT_LIGHTS, type PointLightData } from "../shaders/CelShader";
import { createWaterMaterial } from "../shaders/WaterShader";
import type { EnvironmentSpec } from "../world/environment";
import type { WaterRect } from "../world/MapBuilder";
import { waterY, type TerrainField } from "../world/TerrainField";
import foamUrl from "../../textures/water-foam.png?url";
import normalUrl from "../../textures/water-normal.png?url";

interface WaterBody {
  mesh: Mesh;
  mat: ShaderMaterial;
  /** Baked against this build's terrain, so it dies with the body. */
  depth: RawTexture;
}

/**
 * Owns the shallow-water surfaces: builds one ground plane per layout rect,
 * feeds them the map's environment palette, and per frame pushes time, the
 * camera position, and the same winning point-light set the cel shader gets
 * (so lanterns and muzzle flashes glint off the creek).
 *
 * The planes are drawn and never tested: unpickable, non-colliding, no
 * `solid` metadata — every ray (hitscan, LOS, ground probes) passes through
 * to the creek bed below. They are also excluded from the GlowLayer and the
 * outline pass per the metadata contract.
 */
export class WaterSystem {
  private bodies: WaterBody[] = [];
  private textures: { normal: Texture; foam: Texture } | null = null;
  private time = 0;

  // Packed point-light uniforms, reused every frame to avoid allocation.
  private pointPos = new Float32Array(MAX_POINT_LIGHTS * 3);
  private pointColor = new Float32Array(MAX_POINT_LIGHTS * 3);
  private pointRange = new Float32Array(MAX_POINT_LIGHTS);

  constructor(
    private scene: Scene,
    private glow: GlowLayer,
  ) {}

  /**
   * Rebuilds the water bodies for a round. No-ops to a dry map when the
   * layout has no water rects or the environment has no water palette.
   */
  build(rects: WaterRect[], env: EnvironmentSpec, terrain: TerrainField): void {
    this.dispose();
    if (rects.length === 0 || !env.water) return;

    if (!this.textures) {
      const normal = new Texture(normalUrl, this.scene);
      // Water is the one surface in the game seen almost edge-on, over a
      // hundred metres of it: without anisotropy the tiling turns to moire in
      // the middle distance no matter what the shader does with it.
      normal.anisotropicFilteringLevel = 8;
      const foam = new Texture(foamUrl, this.scene);
      foam.anisotropicFilteringLevel = 8;
      this.textures = { normal, foam };
    }

    const colors = env.water;
    for (const r of rects) {
      const mesh = MeshBuilder.CreateGround(
        "water",
        { width: r.width, height: r.depth },
        this.scene,
      );
      // Ankle-deep over the bed, not over absolute zero. Dig a basin under a
      // pool and the surface drops with it, so the water reads as sitting IN
      // the ground with a bank around it rather than hovering over a flat
      // plane. On a flat map the bed is 0 and this is the old behaviour.
      const surfaceY = waterY(r, terrain);
      mesh.position.set(r.x, surfaceY, r.z);
      mesh.isPickable = false;
      mesh.checkCollisions = false;
      mesh.metadata = { noGlow: true, noOutline: true };
      mesh.freezeWorldMatrix();
      // Built after Game's construction-time glow scan, so exclude by hand.
      this.glow.addExcludedMesh(mesh);

      const hx = r.width / 2;
      const hz = r.depth / 2;
      const depth = this.bakeDepth(r, surfaceY, terrain);
      const mat = createWaterMaterial(
        this.scene,
        "water",
        { ...this.textures, depth },
        new Vector4(r.x - hx, r.z - hz, r.x + hx, r.z + hz),
      );
      const lit = env.lighting;
      mat.setVector3(
        "lightDir",
        new Vector3(...lit.direction).normalize(),
      );
      mat.setColor3(
        "lightColor",
        Color3.FromHexString(lit.color).scale(lit.intensity),
      );
      mat.setColor3(
        "ambientColor",
        Color3.FromHexString(lit.ambientColor).scale(lit.ambientIntensity),
      );
      mat.setColor3("fogColor", Color3.FromHexString(env.fogColor));
      mat.setVector2("fogParams", new Vector2(env.fogStart, env.fogEnd));
      mat.setColor3("mistColor", Color3.FromHexString(env.mistColor));
      mat.setVector2("mistParams", new Vector2(env.mistHeight, env.mistStrength));
      mat.setColor3("deepColor", Color3.FromHexString(colors.deepColor));
      mat.setColor3("shallowColor", Color3.FromHexString(colors.shallowColor));
      mat.setColor3("foamColor", Color3.FromHexString(colors.foamColor));
      // The one wave tunable a map gets a say in — see WaterEnvSpec.glint.
      const w = CONFIG.water;
      mat.setVector4(
        "waveB",
        new Vector4(
          w.waveStrength,
          w.specPower,
          w.specStrength * (colors.glint ?? 1),
          w.fresnelPower,
        ),
      );

      mesh.material = mat;
      this.bodies.push({ mesh, mat, depth });
    }
  }

  /**
   * Bakes how deep the bed is under every point of a rect, as a single-channel
   * texture the shader reads to find the waterline.
   *
   * **This is the only thing that knows where a body of water actually ends.**
   * A rect's bounds are its extent, not its shore: Greyfen's flood is one
   * 250 m rect over the whole valley and its edges are out past the ridge, so
   * a shoreline drawn from the bounds is drawn nowhere the player can stand.
   * Depth is also what gives a sheet that size any low-frequency variation at
   * all — a shoal reads pale and a channel dark, which is most of what stops
   * the eye finding the tiling underneath.
   *
   * Sampled with `surfaceAt` rather than `heightAt` for the same reason a road
   * is: the shoreline is drawn against the floor's TRIANGLES, and on a twisted
   * cell the smooth field is a quarter-twist away from them.
   *
   * Resolution is `depthTexels` per metre, capped: a map-wide rect would
   * otherwise ask for a quarter-million samples per hundred metres of side.
   * Clamped addressing — a wrapped edge would fold the far bank onto the near.
   */
  private bakeDepth(
    r: WaterRect,
    surfaceY: number,
    terrain: TerrainField,
  ): RawTexture {
    const w = CONFIG.water;
    const res = (extent: number) =>
      Math.max(2, Math.min(w.depthTexelsMax, Math.round(extent * w.depthTexels)));
    const nx = res(r.width);
    const nz = res(r.depth);
    const data = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j++) {
      const z = r.z - r.depth / 2 + (r.depth * (j + 0.5)) / nz;
      for (let i = 0; i < nx; i++) {
        const x = r.x - r.width / 2 + (r.width * (i + 0.5)) / nx;
        const d = (surfaceY - terrain.surfaceAt(x, z, false)) / w.depthMax;
        data[j * nx + i] = d <= 0 ? 0 : d >= 1 ? 255 : Math.round(d * 255);
      }
    }
    // invertY false: row 0 is the min-Z edge, which is what the shader's
    // `(posW.xz - bounds.xy) / size` puts at v = 0.
    const tex = RawTexture.CreateRTexture(
      data,
      nx,
      nz,
      this.scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    return tex;
  }

  /**
   * Advances the animation and uploads camera/lights. Same frame-order rule
   * as the cel materials: call after the camera and LightingSystem update.
   */
  update(dt: number, camPos: Vector3, lights: readonly PointLightData[]): void {
    if (this.bodies.length === 0) return;
    this.time += dt;

    const count = Math.min(lights.length, MAX_POINT_LIGHTS);
    for (let i = 0; i < count; i++) {
      const l = lights[i];
      this.pointPos[i * 3] = l.position.x;
      this.pointPos[i * 3 + 1] = l.position.y;
      this.pointPos[i * 3 + 2] = l.position.z;
      this.pointColor[i * 3] = l.color.r * l.intensity;
      this.pointColor[i * 3 + 1] = l.color.g * l.intensity;
      this.pointColor[i * 3 + 2] = l.color.b * l.intensity;
      this.pointRange[i] = l.range;
    }

    for (const { mat } of this.bodies) {
      mat.setFloat("time", this.time);
      mat.setVector3("camPos", camPos);
      mat.setArray3("pointPos", this.pointPos as unknown as number[]);
      mat.setArray3("pointColor", this.pointColor as unknown as number[]);
      mat.setFloats("pointRange", this.pointRange as unknown as number[]);
      mat.setFloat("pointCount", count);
    }
  }

  dispose(): void {
    for (const { mesh, mat, depth } of this.bodies) {
      mesh.dispose();
      mat.dispose();
      // Baked against the terrain this body was built on; the next build's is
      // a different shape, so this one goes with the mesh rather than caching.
      depth.dispose();
    }
    this.bodies = [];
  }
}
