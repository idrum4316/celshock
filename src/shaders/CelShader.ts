import {
  BaseTexture,
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

  // Quantize diffuse into 4 bands; smoothstep across each band edge keeps
  // the toon look but softens the transitions so they don't alias.
  float ndl = max(dot(n, -lightDir), 0.0);
  float x = ndl * 4.0;
  float shade = min((floor(x) + smoothstep(0.35, 0.65, fract(x))) / 4.0, 1.0);
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

// Textured variant: same lighting/fog model, but the base color is sampled
// from an albedo texture (used for imported glTF assets).
Effect.ShadersStore["celTexVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 world;
uniform mat4 viewProjection;

varying vec3 vNormalW;
varying vec3 vPosW;
varying vec2 vUV;

void main() {
  vec4 worldPos = world * vec4(position, 1.0);
  vPosW = worldPos.xyz;
  vNormalW = normalize(mat3(world) * normal);
  vUV = uv;
  gl_Position = viewProjection * worldPos;
}
`;

Effect.ShadersStore["celTexFragmentShader"] = `
precision highp float;

varying vec3 vNormalW;
varying vec3 vPosW;
varying vec2 vUV;

uniform sampler2D albedo;
uniform vec3 lightDir;
uniform vec3 lightColor;
uniform vec3 fogColor;
uniform vec2 fogParams;
uniform vec3 camPos;

void main() {
  vec3 n = normalize(vNormalW);
  vec3 baseColor = texture2D(albedo, vUV).rgb;

  float ndl = max(dot(n, -lightDir), 0.0);
  float x = ndl * 4.0;
  float shade = min((floor(x) + smoothstep(0.35, 0.65, fract(x))) / 4.0, 1.0);
  vec3 col = baseColor * lightColor * (0.45 + 0.55 * shade);

  vec3 viewDir = normalize(camPos - vPosW);
  float rim = 1.0 - max(dot(viewDir, n), 0.0);
  col += baseColor * step(0.75, rim) * 0.18;

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
  private texCache = new Map<number, ShaderMaterial>();
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

  /**
   * Cel material that samples an albedo texture instead of a flat color
   * (for imported glTF assets). Cached per texture.
   */
  getTextured(texture: BaseTexture): ShaderMaterial {
    let mat = this.texCache.get(texture.uniqueId);
    if (!mat) {
      mat = new ShaderMaterial(
        `celTex-${texture.uniqueId}`,
        this.scene,
        { vertex: "celTex", fragment: "celTex" },
        {
          attributes: ["position", "normal", "uv"],
          uniforms: [
            "world",
            "viewProjection",
            "lightDir",
            "lightColor",
            "fogColor",
            "fogParams",
            "camPos",
          ],
          samplers: ["albedo"],
        },
      );
      mat.setTexture("albedo", texture);
      mat.setVector3("camPos", Vector3.Zero());
      // Imported foliage often has open backs; showing both sides is safer.
      mat.backFaceCulling = false;
      this.applyEnvironment(mat);
      this.texCache.set(texture.uniqueId, mat);
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
    this.texCache.forEach((mat) => this.applyEnvironment(mat));
  }

  /** Call once per frame so shader fog/rim track the active camera. */
  updateCamera(camPos: Vector3): void {
    this.cache.forEach((mat) => mat.setVector3("camPos", camPos));
    this.texCache.forEach((mat) => mat.setVector3("camPos", camPos));
  }

  private applyEnvironment(mat: ShaderMaterial): void {
    mat.setVector3("lightDir", this.lightDir);
    mat.setColor3("lightColor", this.lightColor);
    mat.setColor3("fogColor", this.fogColor);
    mat.setVector2("fogParams", new Vector2(this.fogStart, this.fogEnd));
  }
}

/**
 * Enables bold black outlines on a mesh and all of its children.
 * Meshes tagged `metadata.noOutline` (glows, holo reticles) are skipped.
 */
export function addOutline(mesh: Mesh, width = 0.045): void {
  const apply = (m: Mesh) => {
    if (m.metadata && m.metadata.noOutline === true) return;
    m.renderOutline = true;
    m.outlineColor = Color3.Black();
    m.outlineWidth = width;
  };
  apply(mesh);
  for (const child of mesh.getChildMeshes()) {
    if (child instanceof Mesh) apply(child);
  }
}
