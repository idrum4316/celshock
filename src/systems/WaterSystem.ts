/**
 * WaterSystem.ts — Water surfaces built from the map's WaterRects; syncs each
 * water material's time/camera/point-light uniforms every frame.
 * Invariants: water meshes are unpickable, non-colliding, and never carry
 * metadata.solid — ray tests must not see them. update() runs after the camera
 * and LightingSystem updates (shares the same 16 light slots). Meshes are
 * frozen; textures loaded once and reused across rebuilds.
 * A rect without its own `y` floats ankle-deep above the TERRAIN under it, not
 * above absolute zero — that is what lets a pool sit recessed in a dug bed.
 */
import {
  Color3,
  type GlowLayer,
  Mesh,
  MeshBuilder,
  Scene,
  type ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  Vector4,
} from "@babylonjs/core";

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
      const foam = new Texture(foamUrl, this.scene);
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
      mesh.position.set(r.x, waterY(r, terrain), r.z);
      mesh.isPickable = false;
      mesh.checkCollisions = false;
      mesh.metadata = { noGlow: true, noOutline: true };
      mesh.freezeWorldMatrix();
      // Built after Game's construction-time glow scan, so exclude by hand.
      this.glow.addExcludedMesh(mesh);

      const hx = r.width / 2;
      const hz = r.depth / 2;
      const mat = createWaterMaterial(
        this.scene,
        "water",
        this.textures,
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

      mesh.material = mat;
      this.bodies.push({ mesh, mat });
    }
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
    for (const { mesh, mat } of this.bodies) {
      mesh.dispose();
      mat.dispose();
    }
    this.bodies = [];
  }
}
