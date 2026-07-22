import {
  Color3,
  Effect,
  Mesh,
  Scene,
  ShaderMaterial,
  StandardMaterial,
  Vector2,
  Vector3,
} from "@babylonjs/core";

/**
 * Custom cel-shading: quantized diffuse bands, a hard stylized rim highlight,
 * flat colors, and per-theme distance fog blended in the fragment shader.
 * Outlines are drawn with Babylon's outline renderer (inverted hull).
 */

Effect.ShadersStore["celVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;

uniform mat4 world;
uniform mat4 viewProjection;

varying vec3 vNormalW;
varying vec3 vPosW;

void main() {
  vec4 worldPos = world * vec4(position, 1.0);
  vPosW = worldPos.xyz;
  vNormalW = normalize(mat3(world) * normal);
  gl_Position = viewProjection * worldPos;
}
`;

Effect.ShadersStore["celFragmentShader"] = `
precision highp float;

varying vec3 vNormalW;
varying vec3 vPosW;

uniform vec3 lightDir;
uniform vec3 lightColor;
uniform vec3 baseColor;
uniform vec3 fogColor;
uniform vec2 fogParams; // x = start, y = end
uniform vec3 camPos;

void main() {
  vec3 n = normalize(vNormalW);

  // Quantize diffuse into 3 hard bands for the toon look.
  float ndl = max(dot(n, -lightDir), 0.0);
  float shade = ceil(ndl * 3.0) / 3.0;
  vec3 col = baseColor * lightColor * (0.45 + 0.55 * shade);

  // Hard-edged rim highlight (step, not smooth — keeps colors flat).
  vec3 viewDir = normalize(camPos - vPosW);
  float rim = 1.0 - max(dot(viewDir, n), 0.0);
  col += baseColor * step(0.75, rim) * 0.18;

  // Theme-tinted distance fog.
  float dist = length(vPosW - camPos);
  float fog = clamp((dist - fogParams.x) / (fogParams.y - fogParams.x), 0.0, 1.0);
  col = mix(col, fogColor, fog * 0.9);

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Creates and caches one cel ShaderMaterial per color, and keeps the shared
 * environment uniforms (light, fog, camera position) in sync on all of them.
 */
export class CelMaterialFactory {
  private cache = new Map<string, ShaderMaterial>();
  private emissiveCache = new Map<string, StandardMaterial>();

  private lightDir = new Vector3(-0.5, -0.9, 0.4).normalize();
  private lightColor = new Color3(1, 1, 1);
  private fogColor = new Color3(0.75, 0.85, 0.9);
  private fogStart = 60;
  private fogEnd = 140;

  constructor(private scene: Scene) {}

  /** Returns the shared cel material for a hex color, creating it on demand. */
  get(hex: string): ShaderMaterial {
    let mat = this.cache.get(hex);
    if (!mat) {
      mat = new ShaderMaterial(
        `cel-${hex}`,
        this.scene,
        { vertex: "cel", fragment: "cel" },
        {
          attributes: ["position", "normal"],
          uniforms: [
            "world",
            "viewProjection",
            "lightDir",
            "lightColor",
            "baseColor",
            "fogColor",
            "fogParams",
            "camPos",
          ],
        },
      );
      mat.setColor3("baseColor", Color3.FromHexString(hex));
      mat.setVector3("camPos", Vector3.Zero());
      this.applyEnvironment(mat);
      this.cache.set(hex, mat);
    }
    return mat;
  }

  /** Shared unlit emissive material (used for neon/glow/effect meshes). */
  getEmissive(hex: string): StandardMaterial {
    let mat = this.emissiveCache.get(hex);
    if (!mat) {
      mat = new StandardMaterial(`emissive-${hex}`, this.scene);
      mat.emissiveColor = Color3.FromHexString(hex);
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.disableLighting = true;
      this.emissiveCache.set(hex, mat);
    }
    return mat;
  }

  /** Applies a theme's lighting/fog to every cel material (existing + future). */
  setEnvironment(
    lightDir: Vector3,
    lightColor: Color3,
    fogColor: Color3,
    fogStart: number,
    fogEnd: number,
  ): void {
    this.lightDir = lightDir.normalizeToNew();
    this.lightColor = lightColor;
    this.fogColor = fogColor;
    this.fogStart = fogStart;
    this.fogEnd = fogEnd;
    this.cache.forEach((mat) => this.applyEnvironment(mat));
  }

  /** Call once per frame so shader fog/rim track the active camera. */
  updateCamera(camPos: Vector3): void {
    this.cache.forEach((mat) => mat.setVector3("camPos", camPos));
  }

  private applyEnvironment(mat: ShaderMaterial): void {
    mat.setVector3("lightDir", this.lightDir);
    mat.setColor3("lightColor", this.lightColor);
    mat.setColor3("fogColor", this.fogColor);
    mat.setVector2("fogParams", new Vector2(this.fogStart, this.fogEnd));
  }
}

/** Enables bold black outlines on a mesh and all of its children. */
export function addOutline(mesh: Mesh, width = 0.045): void {
  const apply = (m: Mesh) => {
    m.renderOutline = true;
    m.outlineColor = Color3.Black();
    m.outlineWidth = width;
  };
  apply(mesh);
  for (const child of mesh.getChildMeshes()) {
    if (child instanceof Mesh) apply(child);
  }
}
