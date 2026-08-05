/**
 * CelShader.ts — The look: custom cel ShaderMaterial (banded directional key +
 * up to MAX_POINT_LIGHTS=16 dynamic point lights + ambient, fog, ground mist,
 * rim, hard stepped shadows, opt-in toon specular) and CelMaterialFactory,
 * the cache every lit material comes from.
 * Invariants: the scene's ONLY Babylon light is ShadowSystem's shadow-camera
 * DirectionalLight, which no material reads — light arrives via these
 * uniforms, uploaded by LightingSystem once per frame. Flat/faceted shading is
 * recovered in the fragment shader from screen-space derivatives — NEVER call
 * convertToFlatShadedMesh(). Output is display-ready color, which is why
 * pipeline.imageProcessingEnabled must stay false. Materials are cached/shared
 * per color — don't create per-mesh materials. addOutline() skips meshes with
 * metadata.noOutline, tints the ink from the mesh's own cel colour, and
 * registers the mesh for updateOutlineScales() (distance thinning, prunes
 * disposed meshes). Effect meshes use getEmissive() (unlit StandardMaterial).
 */
import {
  type BaseTexture,
  Color3,
  Effect,
  Matrix,
  Mesh,
  Scene,
  ShaderMaterial,
  StandardMaterial,
  Vector2,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
// The bone includes self-register in the IncludesShadersStore; import them
// explicitly so the cel vertex shader's #include<bones...> can never be
// tree-shaken away. Their contents are guarded internally by
// NUM_BONE_INFLUENCERS, so non-skinned materials compile to identical code.
import "@babylonjs/core/Shaders/ShadersInclude/bonesDeclaration";
import "@babylonjs/core/Shaders/ShadersInclude/bonesVertex";

/**
 * Custom cel-shading: quantized diffuse bands, a hard stylized rim highlight,
 * flat colors (or a texture albedo — uv-mapped for the skinned player body,
 * world-XZ-mapped for ground surfaces like cobblestone roads), and per-theme
 * atmosphere blended in the fragment shader. Ground-textured materials may
 * also carry a matching height map (CEL_BUMP): the facet normal is perturbed
 * by the height slope (surface-gradient bump — no tangents, no UVs), so the
 * light bands ripple across individual cobblestones.
 * Outlines are drawn with Babylon's outline renderer (inverted hull).
 *
 * Lighting has four parts, all banded so the toon look survives:
 * - a directional key light (moon/sun) quantized into 4 hard bands and gated
 *   by a hard two-level shadow term (ShadowSystem's depth map — lit or not,
 *   never a soft penumbra),
 * - up to `MAX_POINT_LIGHTS` dynamic point lights (torches, neon, muzzle
 *   flashes) quantized into 3 bands with a smooth radial falloff, and
 * - a flat ambient term that sets how black the unlit side goes — the main
 *   dial for the horror mood. Point lights deliberately ignore the shadow
 *   map, so a lantern still warms ground the moon can't reach.
 * Opt-in per material (getGlossy / getGroundTextured's spec): a toon
 * specular — one two-band Blinn highlight from the key light, gated by the
 * same shadow. Everything not explicitly glossy stays matte.
 * Opt-in the same way (getTranslucent): a translucency band — the key light
 * coming THROUGH a thin surface rather than off it, for awnings and foliage.
 * Everything not explicitly translucent stays opaque.
 *
 * Atmosphere is distance fog plus a separate height-based ground mist, so
 * arenas fade into darkness and the floor sits in a low-lying haze.
 *
 * Shading is faceted: the fragment shader recovers each triangle's geometric
 * normal from screen-space derivatives of the world position rather than
 * using the interpolated vertex normal. Every mesh in the game is built from
 * coarse primitives, so hard facets are the intended look — and doing it in
 * the shader avoids `convertToFlatShadedMesh()`, which would unweld vertices
 * on every prop, enemy, and clone.
 */

/**
 * Shader-side light slots. The LightingSystem uploads the nearest N — a big
 * arena holds far more fixtures than this, and with only a handful of slots
 * a cluster of small glows (fungus, glyphs) would starve the lanterns and
 * braziers that actually shape the room.
 */
export const MAX_POINT_LIGHTS = 16;

Effect.ShadersStore["celVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
#ifdef CEL_TEXTURED
attribute vec2 uv;
#endif

// Self-guarded by NUM_BONE_INFLUENCERS (0 for rigid meshes, set automatically
// by ShaderMaterial for skinned ones): declares matricesIndices/Weights and
// the mBones/boneSampler uniforms.
#include<bonesDeclaration>

uniform mat4 world;
uniform mat4 viewProjection;

varying vec3 vNormalW;
varying vec3 vPosW;
#ifdef CEL_TEXTURED
varying vec2 vUv;
#endif

void main() {
  mat4 finalWorld = world;
  // No-op when NUM_BONE_INFLUENCERS == 0; otherwise blends finalWorld
  // through the bone matrices.
  #include<bonesVertex>
  vec4 worldPos = finalWorld * vec4(position, 1.0);
  vPosW = worldPos.xyz;
  vNormalW = normalize(mat3(finalWorld) * normal);
  #ifdef CEL_TEXTURED
  vUv = uv;
  #endif
  gl_Position = viewProjection * worldPos;
}
`;

Effect.ShadersStore["celFragmentShader"] = `
#extension GL_OES_standard_derivatives : enable
precision highp float;

#define MAX_POINT_LIGHTS ${MAX_POINT_LIGHTS}

varying vec3 vNormalW;
varying vec3 vPosW;

uniform vec3 lightDir;
uniform vec3 lightColor;
uniform vec3 ambientColor;
// Hemispheric fill from the sky dome: full strength on up-facing surfaces,
// nothing underneath. Banded like everything else so the toon look survives.
uniform vec3 skyLightColor;
uniform vec3 rimColor;
#ifdef CEL_TEXTURED
uniform sampler2D baseColorTex;
varying vec2 vUv;
#else
#ifdef CEL_GROUND_TEX
// World-mapped ground albedo: sampled at vPosW.xz * texScale, so no UVs are
// needed and the pattern keeps a constant real-world size across placements.
uniform sampler2D baseColorTex;
uniform float texScale;
#ifdef CEL_BUMP
// Height map matching the albedo texel-for-texel (domed setts, dark mortar).
uniform sampler2D bumpTex;
uniform float bumpScale; // metres of fake relief at height value 1.0
#endif
#else
uniform vec3 baseColor;
#endif
#endif
uniform vec3 fogColor;
uniform vec2 fogParams;  // x = start, y = end
uniform vec3 mistColor;
uniform vec2 mistParams; // x = height falloff, y = strength
uniform vec3 camPos;

uniform vec3 pointPos[MAX_POINT_LIGHTS];
uniform vec3 pointColor[MAX_POINT_LIGHTS]; // rgb premultiplied by intensity
uniform float pointRange[MAX_POINT_LIGHTS];
uniform float pointCount;

// Stepped directional shadows. lightMatrix is the ShadowGenerator's
// view*projection (no [0,1] bias baked in — the UV/depth remap below mirrors
// Babylon's own computeShadow: uv = clip.xy*0.5+0.5, depth = (clip.z+1)*0.5).
uniform mat4 lightMatrix;
uniform sampler2D shadowMap;
uniform vec3 shadowParams; // x = depth bias, y = darkness, z = normal offset

// Toon specular: one hard two-band Blinn highlight from the key light.
// specColor is premultiplied by intensity — black (the default) is matte.
uniform vec3 specColor;
uniform float specShininess;

// Translucency: the key light coming THROUGH a thin surface rather than off
// it — a canvas awning or a pine crown with the moon behind it. Premultiplied
// by intensity — black (the default) is opaque.
uniform vec3 transColor;

// Geometric (per-triangle) normal from the world position's screen-space
// derivatives. The cross product's sign depends on triangle winding and
// viewing direction, so it is flipped to agree with the interpolated normal.
vec3 facetNormal() {
  vec3 n = normalize(cross(dFdx(vPosW), dFdy(vPosW)));
  return dot(n, vNormalW) < 0.0 ? -n : n;
}

// Quantizes a 0..1 diffuse term into hard bands, smoothstepping across each
// edge so the terminator reads as a hard line without aliasing.
float band(float ndl, float steps) {
  float x = ndl * steps;
  return min((floor(x) + smoothstep(0.35, 0.65, fract(x))) / steps, 1.0);
}

// Hard two-level shadow: lit or not, nothing in between — a soft penumbra
// would fight the flat bands. The sample point is pushed off the facet along
// its normal so a flat face never tests against its own depth (acne).
float shadowVisibility(vec3 n) {
  vec4 sc4 = lightMatrix * vec4(vPosW + n * shadowParams.z, 1.0);
  vec3 sc = sc4.xyz / sc4.w;
  vec2 uv = sc.xy * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
  if (sc.z < -1.0 || sc.z > 1.0) return 1.0;
  float depth = (sc.z + 1.0) * 0.5 - shadowParams.x;
  float lit = step(depth, texture2D(shadowMap, uv).x);
  return mix(shadowParams.y, 1.0, lit);
}

#ifdef CEL_BUMP
// Bump mapping for the world-XZ ground textures: perturbs the facet normal
// by the height map's slope, so the quantized light bands ripple across
// individual stones instead of sliding over one flat plane. This is the
// surface-gradient formulation (Mikkelsen 2010): it works in whatever space
// the height map is sampled in — world XZ here — with no tangent frame and
// no UVs, and dFdx/dFdy are already in use for facetNormal().
vec3 perturbNormal(vec3 n) {
  vec2 uv = vPosW.xz * texScale;
  float h = texture2D(bumpTex, uv).r * bumpScale;
  vec3 sigmaX = dFdx(vPosW);
  vec3 sigmaY = dFdy(vPosW);
  vec3 r1 = cross(sigmaY, n);
  vec3 r2 = cross(n, sigmaX);
  float det = dot(sigmaX, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - grad);
}
#endif

void main() {
  vec3 n = facetNormal();

  // --- directional key light (4 bands), gated by the stepped shadow ---
  // The shadow's normal-offset uses the true facet normal — the bump relief
  // is fake, and offsetting along it would leak light at stone edges.
  float shadow = shadowVisibility(n);

  #ifdef CEL_BUMP
  // From here on the bumped normal drives every lighting term: key bands,
  // point lights, rim, and the specular streak all follow the setts.
  n = perturbNormal(n);
  #endif

  vec3 light = ambientColor;
  light += lightColor * band(max(dot(n, -lightDir), 0.0), 4.0) * shadow;

  // Sky fill: the whole dome is a dim source, so anything looking up at it
  // picks up moonlight even where the key light is blocked. Deliberately NOT
  // gated by the shadow map — a roof in the moon's shadow still faces the sky.
  // This is what keeps roads, roofs and open ground reading as moonlit while
  // walls and undersides stay black.
  light += skyLightColor * band(0.5 + 0.5 * n.y, 3.0);

  // --- point lights (3 bands, smooth inverse-square-ish falloff) ---
  for (int i = 0; i < MAX_POINT_LIGHTS; i++) {
    if (float(i) < pointCount) {
      vec3 toLight = pointPos[i] - vPosW;
      float dist = length(toLight);
      float range = max(pointRange[i], 0.001);
      // Smooth window falloff: 1 at the source, 0 at the range limit.
      float atten = clamp(1.0 - dist / range, 0.0, 1.0);
      atten *= atten;
      float ndl = max(dot(n, toLight / max(dist, 0.001)), 0.0);
      // Lift the floor a little so lit surfaces read as glowing pools of
      // light rather than only the faces pointed at the flame.
      light += pointColor[i] * atten * (0.25 + 0.75 * band(ndl, 3.0));
    }
  }

  // Base albedo: flat palette color, the skinned character's texture, or a
  // world-mapped ground texture. All are used raw (display-ready), matching
  // the no-image-processing pipe.
  #ifdef CEL_TEXTURED
  vec3 base = texture2D(baseColorTex, vUv).rgb;
  #else
  #ifdef CEL_GROUND_TEX
  vec3 base = texture2D(baseColorTex, vPosW.xz * texScale).rgb;
  #else
  vec3 base = baseColor;
  #endif
  #endif
  vec3 col = base * light;

  // Soft shoulder: several lights overlapping (or a torch at point-blank
  // range) would otherwise clip to flat white and destroy the palette. This
  // compresses everything above 0.75 into the remaining headroom, so hot
  // spots stay tinted by the light that made them.
  vec3 over = max(col - 0.75, 0.0);
  col = min(col, vec3(0.75)) + 0.25 * over / (1.0 + over);

  // Hard-edged rim highlight (step, not smooth — keeps colors flat).
  vec3 viewDir = normalize(camPos - vPosW);
  float rim = 1.0 - max(dot(viewDir, n), 0.0);
  col += base * rimColor * step(0.72, rim);

  // Toon specular: Blinn half-vector against the key light, quantized into
  // two hard bands (bright core + faint halo) and gated by the same shadow
  // as the diffuse — a glint never appears where the moon doesn't reach.
  // Added after the soft shoulder on purpose: a highlight is allowed to
  // blow past the 0.75 ceiling, that's what makes it read as a shine.
  // Matte materials carry specColor 0 and this contributes nothing.
  vec3 h = normalize(viewDir - lightDir);
  float spec = pow(max(dot(n, h), 0.0), specShininess);
  col += specColor * band(spec, 2.0) * shadow;

  // Translucency: light that came through the surface instead of off it. Two
  // terms multiply. dot(viewDir, lightDir) is how close the eye is to
  // looking INTO the key light — viewDir runs surface-to-eye and lightDir is
  // the direction the light travels, so the two align exactly when the source
  // is on the far side of the surface from the viewer. dot(n, lightDir) is
  // the diffuse term's mirror: the facet must be turned AWAY from the light,
  // since nothing transmits through a face the light is already landing on.
  // Banded like everything else, gated by the same shadow as the diffuse and
  // the specular (light cannot come through a surface the moon doesn't
  // reach), and added past the soft shoulder for the same reason the specular
  // is — a lit awning is allowed to be the brightest thing in the frame.
  // Opaque materials carry transColor 0 and this contributes nothing.
  float through = max(dot(viewDir, lightDir), 0.0) * max(dot(n, lightDir), 0.0);
  col += transColor * band(through, 2.0) * shadow;

  // --- atmosphere ---
  float dist = length(vPosW - camPos);

  // Low-lying ground mist: thickest at the floor, builds up with distance.
  // The ramp is deliberately long so lit ground near the player stays
  // readable and only the middle distance turns to soup.
  float mist = mistParams.y
    * exp(-max(vPosW.y, 0.0) / max(mistParams.x, 0.001))
    * clamp((dist - 6.0) / 45.0, 0.0, 1.0);
  col = mix(col, mistColor, clamp(mist, 0.0, 0.9));

  // Theme-tinted distance fog — reaches full strength so far walls vanish.
  float fog = clamp((dist - fogParams.x) / (fogParams.y - fogParams.x), 0.0, 1.0);
  col = mix(col, fogColor, fog * fog);

  gl_FragColor = vec4(col, 1.0);
}
`;

/** One dynamic light as uploaded to the cel shader. */
export interface PointLightData {
  position: Vector3;
  color: Color3;
  /** Radius at which the contribution reaches zero. */
  range: number;
  intensity: number;
}

/** Toon specular settings for one glossy material (see CONFIG.graphics.spec). */
export interface SpecSpec {
  /** Highlight tint, e.g. "#aecbf2"; scaled by intensity on upload. */
  color: string;
  intensity: number;
  /** Blinn exponent — high is a pinpoint glint, low a broad wet sheen. */
  shininess: number;
}

/**
 * Translucency settings for one thin material (see
 * CONFIG.graphics.translucency). One colour and nothing else: the term's
 * shape — how sharply it fires as the eye comes round into the key light —
 * is the band count in the shader, which belongs to the look rather than to
 * the material, the same way the diffuse's four bands do.
 */
export interface TranslucencySpec {
  /**
   * The colour the light arrives as after passing through — canvas warms it,
   * needles green it. Scaled by intensity on upload; unlike the rim, it does
   * NOT pick up the surface's own albedo, so a dark night-time canvas can
   * still glow pale.
   */
  color: string;
  intensity: number;
}

/**
 * Creates and caches one cel ShaderMaterial per color, and keeps the shared
 * environment uniforms (light, fog, mist, camera, dynamic lights) in sync on
 * all of them.
 */
export class CelMaterialFactory {
  /** Cache key for the one skinned+textured material (never a hex color). */
  private static readonly SKINNED_KEY = "\0skinned";
  /** Uniforms every cel material shares, flat or skinned. */
  private static readonly UNIFORMS = [
    "world",
    "viewProjection",
    "lightDir",
    "lightColor",
    "ambientColor",
    "skyLightColor",
    "rimColor",
    "baseColor",
    "fogColor",
    "fogParams",
    "mistColor",
    "mistParams",
    "camPos",
    "pointPos",
    "pointColor",
    "pointRange",
    "pointCount",
    "lightMatrix",
    "shadowParams",
    "specColor",
    "specShininess",
    "transColor",
  ];
  /** Every cel material samples the shadow map, whatever its albedo path. */
  private static readonly SAMPLERS = ["shadowMap"];

  private cache = new Map<string, ShaderMaterial>();
  private emissiveCache = new Map<string, StandardMaterial>();

  private lightDir = new Vector3(-0.5, -0.9, 0.4).normalize();
  private lightColor = new Color3(0.55, 0.62, 0.8);
  private ambientColor = new Color3(0.16, 0.18, 0.24);
  private skyLightColor = new Color3(0.08, 0.11, 0.18);
  private rimColor = new Color3(0.18, 0.2, 0.26);
  private fogColor = new Color3(0.05, 0.06, 0.08);
  private fogStart = 24;
  private fogEnd = 78;
  private mistColor = new Color3(0.1, 0.12, 0.15);
  private mistParams = new Vector2(2.2, 0.45);

  // Packed point-light uniforms, re-used every frame to avoid allocation.
  private pointPos = new Float32Array(MAX_POINT_LIGHTS * 3);
  private pointColor = new Float32Array(MAX_POINT_LIGHTS * 3);
  private pointRange = new Float32Array(MAX_POINT_LIGHTS);
  private pointCount = 0;

  // Shadow-map state, pushed onto every cel material as it is created.
  private shadowMap: BaseTexture | null = null;
  private shadowMatrix = Matrix.Identity();
  private shadowParams = new Vector3(0.0025, 0.15, 0.06);

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
          uniforms: [...CelMaterialFactory.UNIFORMS],
          samplers: [...CelMaterialFactory.SAMPLERS],
        },
      );
      mat.setColor3("baseColor", Color3.FromHexString(hex));
      mat.setVector3("camPos", Vector3.Zero());
      this.applyEnvironment(mat);
      this.applyPointLights(mat);
      this.applyShadow(mat);
      this.applySpec(mat, null);
      this.applyTranslucency(mat, null);
      this.cache.set(hex, mat);
    }
    return mat;
  }

  /**
   * The same flat cel colour as get(), but with the toon specular band
   * enabled — a hard key-light highlight for metal, glass, wet stone.
   * Cached under its own key so the matte variant of the same colour is
   * untouched; named `cel-gloss-#rrggbb` so outlineInkFor() still recovers
   * the palette colour for the ink.
   */
  getGlossy(hex: string, spec: SpecSpec): ShaderMaterial {
    const cacheKey = `\0gloss-${hex}`;
    let mat = this.cache.get(cacheKey);
    if (!mat) {
      mat = new ShaderMaterial(
        `cel-gloss-${hex}`,
        this.scene,
        { vertex: "cel", fragment: "cel" },
        {
          attributes: ["position", "normal"],
          uniforms: [...CelMaterialFactory.UNIFORMS],
          samplers: [...CelMaterialFactory.SAMPLERS],
        },
      );
      mat.setColor3("baseColor", Color3.FromHexString(hex));
      mat.setVector3("camPos", Vector3.Zero());
      this.applyEnvironment(mat);
      this.applyPointLights(mat);
      this.applyShadow(mat);
      this.applySpec(mat, spec);
      this.applyTranslucency(mat, null);
      this.cache.set(cacheKey, mat);
    }
    return mat;
  }

  /**
   * The same flat cel colour as get(), but with the translucency band enabled
   * — the key light coming through the surface rather than off it, for the
   * thin things it should read through: canvas awnings, foliage, anything a
   * silhouette is meant to glow at the edges of when the moon is behind it.
   *
   * Deliberately a third variant beside matte and glossy rather than a fourth
   * combination with it: a surface thin enough to transmit is not one with a
   * hard Blinn glint on it, and the cache is per colour, so an axis that
   * multiplies is an axis that costs.
   *
   * Cached under its own key and named `cel-trans-#rrggbb` so
   * outlineInkFor() still recovers the palette colour for the ink.
   */
  getTranslucent(hex: string, trans: TranslucencySpec): ShaderMaterial {
    const cacheKey = `\0trans-${hex}`;
    let mat = this.cache.get(cacheKey);
    if (!mat) {
      mat = new ShaderMaterial(
        `cel-trans-${hex}`,
        this.scene,
        { vertex: "cel", fragment: "cel" },
        {
          attributes: ["position", "normal"],
          uniforms: [...CelMaterialFactory.UNIFORMS],
          samplers: [...CelMaterialFactory.SAMPLERS],
        },
      );
      mat.setColor3("baseColor", Color3.FromHexString(hex));
      mat.setVector3("camPos", Vector3.Zero());
      this.applyEnvironment(mat);
      this.applyPointLights(mat);
      this.applyShadow(mat);
      this.applySpec(mat, null);
      this.applyTranslucency(mat, trans);
      this.cache.set(cacheKey, mat);
    }
    return mat;
  }

  /**
   * The one cel material for skinned, textured meshes (the imported player
   * body). Same lighting/fog/rim pipeline as the flat colors, but the albedo
   * comes from a texture and the vertex shader is bone-deformed — ShaderMaterial
   * auto-adds the bone attributes, defines, and `boneSampler`/`mBones` uniforms
   * when it binds a mesh with a skeleton. Cached under a sentinel key in the
   * same map so environment, point-light, and camera updates reach it.
   */
  getSkinned(tex: BaseTexture): ShaderMaterial {
    let mat = this.cache.get(CelMaterialFactory.SKINNED_KEY);
    if (!mat) {
      mat = new ShaderMaterial(
        "cel-skinned",
        this.scene,
        { vertex: "cel", fragment: "cel" },
        {
          attributes: ["position", "normal", "uv"],
          uniforms: [...CelMaterialFactory.UNIFORMS],
          samplers: ["baseColorTex", ...CelMaterialFactory.SAMPLERS],
          defines: ["#define CEL_TEXTURED"],
        },
      );
      mat.setTexture("baseColorTex", tex);
      mat.setVector3("camPos", Vector3.Zero());
      this.applyEnvironment(mat);
      this.applyPointLights(mat);
      this.applyShadow(mat);
      this.applySpec(mat, null);
      this.applyTranslucency(mat, null);
      this.cache.set(CelMaterialFactory.SKINNED_KEY, mat);
    }
    return mat;
  }

  /**
   * A cel material whose albedo is a texture sampled in world space
   * (`vPosW.xz * texScale`) rather than from UVs — for flat ground surfaces
   * only (walls would streak). World mapping means every mesh sharing it
   * tiles seamlessly at a constant real-world scale no matter how it is
   * sized, rotated about Y, or merged, and primitives need no UV authoring.
   * Cached per key in the shared map so environment, point-light, and camera
   * updates reach it like any flat colour.
   *
   * @param key cache key, e.g. "cobble" — one material per texture/scale pair
   * @param tex tiling texture; mipmaps + anisotropy are the caller's job
   * @param texScale texture repeats per metre (1 / metres-per-tile)
   * @param opts.spec enables the toon specular band (wet sheen); omit for matte
   * @param opts.bump height map matching the albedo texel-for-texel — the
   *   shader perturbs the normal by its slope (CEL_BUMP). Must tile exactly
   *   like the albedo.
   * @param opts.bumpScale metres of fake relief at height value 1.0
   */
  getGroundTextured(
    key: string,
    tex: BaseTexture,
    texScale: number,
    opts: { spec?: SpecSpec; bump?: BaseTexture; bumpScale?: number } = {},
  ): ShaderMaterial {
    const { spec, bump } = opts;
    const cacheKey = `\0ground-${key}${spec ? "-spec" : ""}${bump ? "-bump" : ""}`;
    let mat = this.cache.get(cacheKey);
    if (!mat) {
      mat = new ShaderMaterial(
        `cel-ground-${key}`,
        this.scene,
        { vertex: "cel", fragment: "cel" },
        {
          attributes: ["position", "normal"],
          uniforms: [
            ...CelMaterialFactory.UNIFORMS,
            "texScale",
            ...(bump ? ["bumpScale"] : []),
          ],
          samplers: [
            "baseColorTex",
            ...(bump ? ["bumpTex"] : []),
            ...CelMaterialFactory.SAMPLERS,
          ],
          defines: [
            "#define CEL_GROUND_TEX",
            ...(bump ? ["#define CEL_BUMP"] : []),
          ],
        },
      );
      mat.setTexture("baseColorTex", tex);
      mat.setFloat("texScale", texScale);
      if (bump) {
        mat.setTexture("bumpTex", bump);
        mat.setFloat("bumpScale", opts.bumpScale ?? 0.1);
      }
      mat.setVector3("camPos", Vector3.Zero());
      this.applyEnvironment(mat);
      this.applyPointLights(mat);
      this.applyShadow(mat);
      this.applySpec(mat, spec ?? null);
      this.applyTranslucency(mat, null);
      this.cache.set(cacheKey, mat);
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

  /** Applies a theme's lighting/atmosphere to every cel material. */
  setEnvironment(env: {
    lightDir: Vector3;
    lightColor: Color3;
    ambientColor: Color3;
    skyLightColor: Color3;
    rimColor: Color3;
    fogColor: Color3;
    fogStart: number;
    fogEnd: number;
    mistColor: Color3;
    mistHeight: number;
    mistStrength: number;
  }): void {
    this.lightDir = env.lightDir.normalizeToNew();
    this.lightColor = env.lightColor;
    this.ambientColor = env.ambientColor;
    this.skyLightColor = env.skyLightColor;
    this.rimColor = env.rimColor;
    this.fogColor = env.fogColor;
    this.fogStart = env.fogStart;
    this.fogEnd = env.fogEnd;
    this.mistColor = env.mistColor;
    this.mistParams.set(env.mistHeight, env.mistStrength);
    this.cache.forEach((mat) => this.applyEnvironment(mat));
  }

  /**
   * Uploads the active dynamic lights (already reduced to the nearest
   * `MAX_POINT_LIGHTS` by the LightingSystem). Called once per frame.
   */
  setPointLights(lights: PointLightData[]): void {
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
    this.pointCount = count;
    this.cache.forEach((mat) => this.applyPointLights(mat));
  }

  /** Call once per frame so shader fog/rim track the active camera. */
  updateCamera(camPos: Vector3): void {
    this.cache.forEach((mat) => mat.setVector3("camPos", camPos));
  }

  /**
   * Binds the ShadowSystem's depth map to every cel material. Called once at
   * startup — the texture object is stable even though its contents re-render.
   */
  setShadowMap(map: BaseTexture): void {
    this.shadowMap = map;
    this.cache.forEach((mat) => mat.setTexture("shadowMap", map));
  }

  /** The light's view*projection; re-uploaded when the shadow camera moves. */
  setShadowMatrix(matrix: Matrix): void {
    this.shadowMatrix = matrix;
    this.cache.forEach((mat) => mat.setMatrix("lightMatrix", matrix));
  }

  /** Depth bias, in-shadow darkness, facet-normal offset. */
  setShadowParams(bias: number, darkness: number, normalBias: number): void {
    this.shadowParams.set(bias, darkness, normalBias);
    this.cache.forEach((mat) => mat.setVector3("shadowParams", this.shadowParams));
  }

  private applyEnvironment(mat: ShaderMaterial): void {
    mat.setVector3("lightDir", this.lightDir);
    mat.setColor3("lightColor", this.lightColor);
    mat.setColor3("ambientColor", this.ambientColor);
    mat.setColor3("skyLightColor", this.skyLightColor);
    mat.setColor3("rimColor", this.rimColor);
    mat.setColor3("fogColor", this.fogColor);
    mat.setVector2("fogParams", new Vector2(this.fogStart, this.fogEnd));
    mat.setColor3("mistColor", this.mistColor);
    mat.setVector2("mistParams", this.mistParams);
  }

  private applyPointLights(mat: ShaderMaterial): void {
    // Float32Array is accepted by setArray3/setFloats (typed as number[]).
    mat.setArray3("pointPos", this.pointPos as unknown as number[]);
    mat.setArray3("pointColor", this.pointColor as unknown as number[]);
    mat.setFloats("pointRange", this.pointRange as unknown as number[]);
    mat.setFloat("pointCount", this.pointCount);
  }

  private applyShadow(mat: ShaderMaterial): void {
    if (this.shadowMap) mat.setTexture("shadowMap", this.shadowMap);
    mat.setMatrix("lightMatrix", this.shadowMatrix);
    mat.setVector3("shadowParams", this.shadowParams);
  }

  /** Specular is per-material, never theme-wide: null keeps a material matte. */
  private applySpec(mat: ShaderMaterial, spec: SpecSpec | null): void {
    if (!spec) {
      mat.setColor3("specColor", Color3.Black());
      // Shininess 1 is a no-op exponent — the zero specColor wins anyway.
      mat.setFloat("specShininess", 1);
      return;
    }
    mat.setColor3(
      "specColor",
      Color3.FromHexString(spec.color).scale(spec.intensity),
    );
    mat.setFloat("specShininess", Math.max(1, spec.shininess));
  }

  /**
   * Translucency is per-material for the same reason specular is: null keeps
   * a material opaque, and the zero colour is what the shader's term
   * multiplies out to nothing against.
   */
  private applyTranslucency(
    mat: ShaderMaterial,
    trans: TranslucencySpec | null,
  ): void {
    mat.setColor3(
      "transColor",
      trans
        ? Color3.FromHexString(trans.color).scale(trans.intensity)
        : Color3.Black(),
    );
  }
}

/**
 * Outlined meshes and the width they were authored at, so
 * updateOutlineScales() can thin the ink with distance. Entries for disposed
 * meshes (the map is rebuilt every round) are pruned lazily on the next pass.
 */
const outlineEntries: { mesh: Mesh; width: number }[] = [];

/**
 * Ink for a mesh: a darkened take on its own cel colour, so outlines read as
 * coloured line work instead of a uniform black cut-out. The factory names
 * flat materials `cel-#rrggbb` (matte), `cel-gloss-#rrggbb` (specular) or
 * `cel-trans-#rrggbb` (translucent), which is how the colour is recovered
 * here; textured/skinned materials get the palette-neutral fallback ink.
 */
function outlineInkFor(mesh: Mesh): Color3 {
  const o = CONFIG.graphics.outlines;
  const name = mesh.material?.name ?? "";
  const m = /^cel-(?:gloss-|trans-)?(#(?:[0-9a-fA-F]{6}))$/.exec(name);
  if (m) {
    return Color3.FromHexString(m[1]).scale(o.tintFactor);
  }
  return Color3.FromHexString(o.fallbackColor);
}

/**
 * Enables bold outlines on a mesh and all of its children — coloured ink that
 * updateOutlineScales() thins with distance. Meshes tagged
 * `metadata.noOutline` (glows, holo reticles) are skipped.
 */
export function addOutline(mesh: Mesh, width = 0.045): void {
  const apply = (m: Mesh) => {
    if (m.metadata && m.metadata.noOutline === true) return;
    m.renderOutline = true;
    m.outlineColor = outlineInkFor(m);
    m.outlineWidth = width;
    outlineEntries.push({ mesh: m, width });
  };
  apply(mesh);
  for (const child of mesh.getChildMeshes()) {
    if (child instanceof Mesh) apply(child);
  }
}

/**
 * Re-scales every registered outline for the camera's current position: full
 * width up close, thinning to `outlines.minScale` at the fog wall, so distant
 * silhouettes stay shaped instead of filling in. Meshes whose outlines were
 * LOD-dropped (bots past `lodOutlineDistance` — `renderOutline` false) are
 * left alone; their authored width returns when the LOD flips them back on.
 * Called once per frame from Game.
 */
export function updateOutlineScales(camPos: Vector3): void {
  const o = CONFIG.graphics.outlines;
  for (let i = outlineEntries.length - 1; i >= 0; i--) {
    const e = outlineEntries[i];
    if (e.mesh.isDisposed()) {
      outlineEntries[i] = outlineEntries[outlineEntries.length - 1];
      outlineEntries.pop();
      continue;
    }
    if (!e.mesh.renderOutline) continue;
    const sphere = e.mesh.getBoundingInfo().boundingSphere;
    const d = Math.max(
      0,
      Vector3.Distance(sphere.centerWorld, camPos) - sphere.radiusWorld,
    );
    const t = Math.min(
      1,
      Math.max(0, (d - o.fullDistance) / (o.farDistance - o.fullDistance)),
    );
    e.mesh.outlineWidth = e.width * (1 - t * (1 - o.minScale));
  }
}
