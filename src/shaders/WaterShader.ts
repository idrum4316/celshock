/**
 * WaterShader.ts — Stylized shallow-water ShaderMaterial: scrolling normal
 * layers, banded lighting (matching the cel look), shoreline foam, fresnel.
 * Invariants: point-light uniform arrays are pre-allocated to MAX_POINT_LIGHTS
 * and filled by WaterSystem each frame from the same LightingSystem slots as
 * the cel shader. No vertex displacement; opaque output. No Babylon lights.
 */
import { Effect, Scene, ShaderMaterial, Texture, Vector3, Vector4 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { DITHER_GLSL } from "./Dither";
import {
  BAND_GLSL,
  MAX_POINT_LIGHTS,
  SHADOW_GLSL,
  SHADOW_SAMPLER_NAMES,
  SHADOW_UNIFORM_NAMES,
} from "./CelShader";

/**
 * Shallow-water surface — the one smooth-shaded material in a faceted world.
 *
 * A flat plane with three scrolling normal-map layers (no vertex displacement:
 * the water is ankle-deep, so silhouette detail would never read), lit to
 * match the cel shader rather than realistic water:
 *
 * - the directional key light is quantized into hard bands, and its glint is a
 *   `smoothstep`ped Blinn lobe — a hard-edged sparkle, not a gradient — scaled
 *   by the map's own `WaterEnvSpec.glint`, because a moon on a creek and a sun
 *   on a flooded valley are reflections of very different sizes;
 * - point lights contribute mostly specular glints, so a muzzle flash over
 *   the creek snaps across the surface the way it does across the village;
 * - body colour is a fresnel between deep and shallow palette colours, both
 *   murky and opaque (there is no refraction, and the camera can never go
 *   under a knee-deep plane), lifted toward the shallow one over a shoal;
 * - foam is a shoreline band, broken up by the foam mask and given a slowly
 *   breathing waterline;
 * - mist and distance fog are copied term-for-term from the cel shader so
 *   the waterline fades out exactly like the ground it sits in.
 *
 * **Three rules exist because one rect is the whole valley.** Greyfen's flood
 * is a single 250 m plane, and at that size everything a small pool forgives
 * becomes the only thing anyone sees:
 *
 * 1. **A tiled layer must never be sampled on the world axes.** Each layer's
 *    uv is rotated by its own angle, so no layer's lattice is parallel to the
 *    plane's edges, to the fog, or to another layer's — three grids at three
 *    angles read as noise where three aligned ones read as plaid.
 * 2. **Each layer is warped by the one above it.** A rotated lattice is still
 *    a lattice; dragging its uv by the previous layer's slope (`warpStrength`)
 *    is what actually destroys the repeat, and it costs one madd.
 * 3. **The fine layers fade out with distance and the swell never does.**
 *    Past `detailFade` a texel is subpixel and the tiling aliases into a moire
 *    grid — but flattening the surface completely turns `dot(n, h)` uniform
 *    and the far field becomes one hard sheet of glint, which is worse than
 *    the moire. The swell layer carries the far water on its own.
 *
 * The shoreline is read from a **baked bed-depth map** (one per body, built by
 * `WaterSystem.bakeDepth` off the same `TerrainField` the ground probe uses),
 * not from the rect bounds: a rect that spans the map has its bounds out past
 * the ridge, so bounds-only foam draws a waterline nowhere near the water's
 * edge. Depth also grades the body colour, which is what gives a big sheet the
 * low-frequency variation that hides a texture repeat in the first place. The
 * bounds band is kept and the two are taken together, so a pool whose rect
 * genuinely ends in open water still foams at the seam.
 *
 * Output is opaque and display-ready (`imageProcessingEnabled` stays false).
 */

Effect.ShadersStore["waterVertexShader"] = `
precision highp float;

attribute vec3 position;

uniform mat4 world;
uniform mat4 viewProjection;

varying vec3 vPosW;

void main() {
  vec4 worldPos = world * vec4(position, 1.0);
  vPosW = worldPos.xyz;
  gl_Position = viewProjection * worldPos;
}
`;

Effect.ShadersStore["waterFragmentShader"] = `
precision highp float;

#define MAX_POINT_LIGHTS ${MAX_POINT_LIGHTS}

varying vec3 vPosW;

uniform sampler2D normalTex;
uniform sampler2D foamTex;
uniform sampler2D depthTex; // r = bed depth / depthParams.x, over "bounds"
uniform float time;
uniform vec3 camPos;

uniform vec3 lightDir;
uniform vec3 lightColor;
uniform vec3 ambientColor;
uniform vec3 fogColor;
uniform vec2 fogParams;  // x = start, y = end
uniform vec3 mistColor;
uniform vec2 mistParams; // x = height falloff, y = strength

uniform vec3 deepColor;
uniform vec3 shallowColor;
uniform vec3 foamColor;
uniform vec4 bounds;     // minX, minZ, maxX, maxZ — for the shoreline band
uniform vec4 waveA;      // normal-map: scale1, scale2, speed1, speed2
uniform vec4 waveB;      // waveStrength, specPower, specStrength, fresnelPower
uniform vec4 waveC;      // scale3, speed3, warpStrength, detailFade
uniform vec4 depthParams; // depthMax, foamDepth, depthFade, depthTint
uniform vec3 foamParams; // width, texture scale, scroll speed

uniform vec3 pointPos[MAX_POINT_LIGHTS];
uniform vec3 pointColor[MAX_POINT_LIGHTS]; // rgb premultiplied by intensity
uniform float pointRange[MAX_POINT_LIGHTS];
uniform float pointCount;

${BAND_GLSL}
${SHADOW_GLSL}
${DITHER_GLSL}

// Rotates a uv about the origin. Every tiled layer goes through this: a
// lattice sampled straight off world X/Z is parallel to the plane's own edges
// and to every other layer's, and that is what reads as "the pattern".
vec2 swirl(vec2 p, float c, float s) {
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

void main() {
  float viewDist = length(vPosW - camPos);
  // Rule 3: the fine layers go first, the chop lasts longer, the swell stays.
  float fine = 1.0 - smoothstep(waveC.w * 0.3, waveC.w, viewDist);
  float chop = 1.0 - smoothstep(waveC.w * 0.8, waveC.w * 2.4, viewDist);

  // --- bed depth, off the baked map (metres) ---
  vec2 duv = (vPosW.xz - bounds.xy) / max(bounds.zw - bounds.xy, vec2(0.001));
  float depth = texture2D(depthTex, duv).r * depthParams.x;
  float shallowness = 1.0 - clamp(depth / max(depthParams.z, 0.001), 0.0, 1.0);

  // --- surface normal: three rotated, warped, scrolled normal-map layers ---
  vec2 p = vPosW.xz;
  vec2 uv1 = swirl(p, 0.9323, 0.3616) * waveA.x
    + vec2(time * waveA.z, time * waveA.z * 0.63);
  vec3 n1 = texture2D(normalTex, uv1).rgb * 2.0 - 1.0;
  // Rule 2: each layer is dragged by the slope of the one above it.
  vec2 uv2 = swirl(p, -0.3314, 0.9435) * waveA.y + n1.xy * waveC.z
    + vec2(-time * waveA.w * 0.71, time * waveA.w);
  vec3 n2 = texture2D(normalTex, uv2).rgb * 2.0 - 1.0;
  vec2 uv3 = swirl(p, -0.9284, -0.3717) * waveC.x + n2.xy * waveC.z * 0.6
    + vec2(time * waveC.y * 0.5, -time * waveC.y);
  vec3 n3 = texture2D(normalTex, uv3).rgb * 2.0 - 1.0;

  vec2 slope = n1.xy
    + n2.xy * mix(0.35, 0.85, chop)
    + n3.xy * (0.55 * fine);
  vec3 nt = normalize(vec3(slope, n1.z * n2.z));
  // Tangent space of a flat XZ surface: x -> world X, y -> world Z, z -> up.
  vec3 n = normalize(vec3(nt.x, nt.z, nt.y));
  // A shoal is a little calmer than a channel — but only a little, for the same
  // reason the swell never fades: a flatter patch is a mirror, a mirror has one
  // specular answer across its whole area, and that answer arrives as a hard
  // white blob sitting in open water.
  float relief = waveB.x * mix(0.85, 1.0, 1.0 - shallowness);
  n = normalize(mix(vec3(0.0, 1.0, 0.0), n, relief));

  vec3 viewDir = normalize(camPos - vPosW);

  // --- key light (3 bands) over a fresnel-tipped body colour ---
  // Gated by the same depth map as the bank it laps against — a jetty standing
  // in the moon has to lay its shadow ON the water, not stop at the waterline.
  //
  // The offset normal is the FLAT up-vector, not n. Every wave here is a
  // normal-map fiction over a plane that never moves, so offsetting the shadow
  // sample along the swell would slide the shadow's edge back and forth with
  // the chop — the water's version of the bump-map problem the cel shader
  // solves by offsetting along the facet rather than the perturbed normal.
  vec3 light = ambientColor;
  light += lightColor * band(max(dot(n, -lightDir), 0.0), 3.0)
    * shadowVisibility(vec3(0.0, 1.0, 0.0), vPosW);

  float fres = pow(1.0 - max(dot(viewDir, n), 0.0), waveB.w);
  vec3 base = mix(deepColor, shallowColor,
    clamp(fres * 1.4 + shallowness * depthParams.w, 0.0, 1.0));
  vec3 col = base * light;

  // --- key-light glint: hard-edged banded sparkle, scaled by the map's own
  // WaterEnvSpec.glint — a moon on a creek and a sun on a flood are not the
  // same reflection. ---
  vec3 h = normalize(-lightDir + viewDir);
  float spec = pow(max(dot(n, h), 0.0), waveB.y);
  col += lightColor * waveB.z * smoothstep(0.25, 0.6, spec) * mix(0.6, 1.0, chop);

  // --- point lights: a little diffuse lift, mostly glints ---
  for (int i = 0; i < MAX_POINT_LIGHTS; i++) {
    if (float(i) < pointCount) {
      vec3 toLight = pointPos[i] - vPosW;
      float dist = length(toLight);
      float atten = clamp(1.0 - dist / max(pointRange[i], 0.001), 0.0, 1.0);
      atten *= atten;
      vec3 ldir = toLight / max(dist, 0.001);
      float lndl = max(dot(n, ldir), 0.0);
      vec3 lh = normalize(ldir + viewDir);
      float lspec = pow(max(dot(n, lh), 0.0), waveB.y * 0.6);
      col += pointColor[i] * atten
        * (base * lndl * 0.5 + smoothstep(0.2, 0.55, lspec) * 0.9);
    }
  }

  // Same soft shoulder as the cel shader, so stacked lights stay tinted.
  vec3 over = max(col - 0.75, 0.0);
  col = min(col, vec3(0.75)) + 0.25 * over / (1.0 + over);

  // --- shoreline foam: the nearer of the rect's edge and the real waterline ---
  vec2 edge = min(vPosW.xz - bounds.xy, bounds.zw - vPosW.xz);
  // The bed's depth expressed in the same metres the band is measured in, so
  // one width tunable covers both. A rect that ends in open water still foams.
  float shore = min(
    min(edge.x, edge.y),
    depth * (foamParams.x / max(depthParams.y, 0.001)));
  float foamTexV = texture2D(foamTex,
    swirl(vPosW.xz, 0.8020, -0.5972) * foamParams.y + vec2(time * foamParams.z)).r;
  // The waterline breathes in and out a few centimetres, warped by the swell
  // so the band wanders along the bank instead of tracing it exactly.
  float waterline = shore + sin(time * 1.3 + shore * 5.0) * 0.12 + n1.x * 0.25;
  float foamBand = 1.0 - smoothstep(0.0, foamParams.x, waterline);
  // The mask has to survive being inside the band, not just be biased over the
  // line by it: a mudflat is metres of near-zero depth, and a band that goes
  // solid the moment it is full paints the whole flat white.
  float foam = smoothstep(0.30, 0.85, foamTexV + foamBand * 0.35) * foamBand;
  // Sparse flecks drifting out in the open water, on their own angle again.
  float flecks = smoothstep(0.82, 0.97, texture2D(foamTex,
    swirl(vPosW.xz, -0.1455, 0.9894) * foamParams.y * 0.6
      - vec2(time * foamParams.z * 0.7)).r)
    * 0.14 * mix(0.25, 1.0, chop);
  // Never all the way to the foam colour: a shoal broad enough to foam across
  // its whole width goes solid white at 1.0 and reads as snow, not froth.
  col = mix(col, foamColor * light, clamp(foam * 0.8 + flecks, 0.0, 1.0));

  // --- atmosphere: identical to the cel shader ---
  float mist = mistParams.y
    * exp(-max(vPosW.y, 0.0) / max(mistParams.x, 0.001))
    * clamp((viewDist - 6.0) / 45.0, 0.0, 1.0);
  col = mix(col, mistColor, clamp(mist, 0.0, 0.9));
  float fog = clamp(
    (viewDist - fogParams.x) / (fogParams.y - fogParams.x), 0.0, 1.0);
  col = mix(col, fogColor, fog * fog);

  // Last thing before the write, because the write is the quantiser.
  gl_FragColor = vec4(dither(col), 1.0);
}
`;

/** Uniforms the WaterSystem pushes per frame / per round. */
const WATER_UNIFORMS = [
  "world",
  "viewProjection",
  "time",
  "camPos",
  "lightDir",
  "lightColor",
  "ambientColor",
  "fogColor",
  "fogParams",
  "mistColor",
  "mistParams",
  "deepColor",
  "shallowColor",
  "foamColor",
  "bounds",
  "waveA",
  "waveB",
  "waveC",
  "depthParams",
  "foamParams",
  "pointPos",
  "pointColor",
  "pointRange",
  "pointCount",
];

/**
 * One water material per body (each carries its own shoreline `bounds` and its
 * own baked bed-depth map). Motion/visual tunables come straight from
 * CONFIG.water; palette and lighting uniforms are set by the WaterSystem from
 * the map's environment.
 *
 * Every uniform the fragment shader reads is written here or by the system —
 * `foamParams` was declared, read and never uploaded, which silently zeroed
 * `foamWidth`/`foamScale`/`foamSpeed` and left `smoothstep(0.0, 0.0, x)` to
 * decide the shoreline. There was no foam on any map. Add a uniform to the
 * shader and it owes a line here.
 */
export function createWaterMaterial(
  scene: Scene,
  name: string,
  textures: { normal: Texture; foam: Texture; depth: Texture },
  bounds: Vector4,
): ShaderMaterial {
  const mat = new ShaderMaterial(
    name,
    scene,
    { vertex: "water", fragment: "water" },
    {
      attributes: ["position"],
      uniforms: [...WATER_UNIFORMS, ...SHADOW_UNIFORM_NAMES],
      samplers: ["normalTex", "foamTex", "depthTex", ...SHADOW_SAMPLER_NAMES],
    },
  );
  const w = CONFIG.water;
  mat.setTexture("normalTex", textures.normal);
  mat.setTexture("foamTex", textures.foam);
  mat.setTexture("depthTex", textures.depth);
  mat.setVector4("bounds", bounds);
  mat.setVector4("waveA", new Vector4(w.waveScale1, w.waveScale2, w.waveSpeed1, w.waveSpeed2));
  mat.setVector4("waveB", new Vector4(w.waveStrength, w.specPower, w.specStrength, w.fresnelPower));
  mat.setVector4("waveC", new Vector4(w.waveScale3, w.waveSpeed3, w.warpStrength, w.detailFade));
  mat.setVector4("depthParams", new Vector4(w.depthMax, w.foamDepth, w.depthFade, w.depthTint));
  mat.setVector3("foamParams", new Vector3(w.foamWidth, w.foamScale, w.foamSpeed));
  mat.setFloat("time", 0);
  mat.setVector3("camPos", Vector3.Zero());
  mat.setArray3("pointPos", new Array(MAX_POINT_LIGHTS * 3).fill(0));
  mat.setArray3("pointColor", new Array(MAX_POINT_LIGHTS * 3).fill(0));
  mat.setFloats("pointRange", new Array(MAX_POINT_LIGHTS).fill(0));
  mat.setFloat("pointCount", 0);
  return mat;
}
