/**
 * WaterShader.ts — Stylized shallow-water ShaderMaterial: scrolling normal
 * layers, banded lighting (matching the cel look), shoreline foam, fresnel.
 * Invariants: point-light uniform arrays are pre-allocated to MAX_POINT_LIGHTS
 * and filled by WaterSystem each frame from the same LightingSystem slots as
 * the cel shader. No vertex displacement; opaque output. No Babylon lights.
 */
import { Effect, Scene, ShaderMaterial, Texture, Vector3, Vector4 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { MAX_POINT_LIGHTS } from "./CelShader";

/**
 * Shallow-water surface — the one smooth-shaded material in a faceted world.
 *
 * A flat plane with two scrolling normal-map layers (no vertex displacement:
 * the water is ankle-deep, so silhouette detail would never read), lit to
 * match the cel shader rather than realistic water:
 *
 * - the directional key light is quantized into hard bands, and the moon
 *   glint is a `smoothstep`ped Blinn lobe — a hard-edged sparkle, not a
 *   gradient;
 * - point lights contribute mostly specular glints, so a muzzle flash over
 *   the creek snaps across the surface the way it does across the village;
 * - body colour is a view-angle fresnel between deep and shallow palette
 *   colours, both murky and opaque — there is no refraction, and the camera
 *   can never go under a knee-deep plane;
 * - foam is a shoreline band derived from the rect bounds passed per body
 *   (no depth texture needed for axis-aligned pools), broken up by the foam
 *   mask and given a slowly breathing waterline;
 * - mist and distance fog are copied term-for-term from the cel shader so
 *   the waterline fades out exactly like the ground it sits in.
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
uniform vec3 foamParams; // width, texture scale, scroll speed

uniform vec3 pointPos[MAX_POINT_LIGHTS];
uniform vec3 pointColor[MAX_POINT_LIGHTS]; // rgb premultiplied by intensity
uniform float pointRange[MAX_POINT_LIGHTS];
uniform float pointCount;

// Same hard-band quantization as the cel shader.
float band(float ndl, float steps) {
  float x = ndl * steps;
  return min((floor(x) + smoothstep(0.35, 0.65, fract(x))) / steps, 1.0);
}

void main() {
  // --- surface normal: two scrolled normal-map layers, whiteout-blended ---
  vec2 uv1 = vPosW.xz * waveA.x + vec2(time * waveA.z, time * waveA.z * 0.63);
  vec2 uv2 = vPosW.xz * waveA.y + vec2(-time * waveA.w * 0.71, time * waveA.w);
  vec3 n1 = texture2D(normalTex, uv1).rgb * 2.0 - 1.0;
  vec3 n2 = texture2D(normalTex, uv2).rgb * 2.0 - 1.0;
  vec3 nt = normalize(vec3(n1.xy + n2.xy, n1.z * n2.z));
  // Tangent space of a flat XZ surface: x -> world X, y -> world Z, z -> up.
  vec3 n = normalize(vec3(nt.x, nt.z, nt.y));
  n = normalize(mix(vec3(0.0, 1.0, 0.0), n, waveB.x));

  vec3 viewDir = normalize(camPos - vPosW);

  // --- key light (3 bands) over a fresnel-tipped body colour ---
  vec3 light = ambientColor;
  light += lightColor * band(max(dot(n, -lightDir), 0.0), 3.0);

  float fres = pow(1.0 - max(dot(viewDir, n), 0.0), waveB.w);
  vec3 base = mix(deepColor, shallowColor, clamp(fres * 1.4, 0.0, 1.0));
  vec3 col = base * light;

  // --- moon glint: hard-edged banded sparkle ---
  vec3 h = normalize(-lightDir + viewDir);
  float spec = pow(max(dot(n, h), 0.0), waveB.y);
  col += lightColor * waveB.z * smoothstep(0.25, 0.6, spec);

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

  // --- shoreline foam ---
  vec2 edge = min(vPosW.xz - bounds.xy, bounds.zw - vPosW.xz);
  float shore = min(edge.x, edge.y);
  float foamTexV = texture2D(
    foamTex, vPosW.xz * foamParams.y + vec2(time * foamParams.z)).r;
  // The waterline breathes in and out a few centimetres.
  float waterline = shore + sin(time * 1.3 + shore * 5.0) * 0.12;
  float foamBand = 1.0 - smoothstep(0.0, foamParams.x, waterline);
  float foam = smoothstep(0.35, 0.7, foamTexV + foamBand * 0.5) * foamBand;
  // Sparse flecks drifting out in the open water.
  float flecks = smoothstep(0.82, 0.97, texture2D(
    foamTex, vPosW.xz * foamParams.y * 0.6 - vec2(time * foamParams.z * 0.7)).r)
    * 0.25;
  col = mix(col, foamColor * light, clamp(foam + flecks, 0.0, 1.0));

  // --- atmosphere: identical to the cel shader ---
  float dist = length(vPosW - camPos);
  float mist = mistParams.y
    * exp(-max(vPosW.y, 0.0) / max(mistParams.x, 0.001))
    * clamp((dist - 6.0) / 45.0, 0.0, 1.0);
  col = mix(col, mistColor, clamp(mist, 0.0, 0.9));
  float fog = clamp((dist - fogParams.x) / (fogParams.y - fogParams.x), 0.0, 1.0);
  col = mix(col, fogColor, fog * fog);

  gl_FragColor = vec4(col, 1.0);
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
  "foamParams",
  "pointPos",
  "pointColor",
  "pointRange",
  "pointCount",
];

/**
 * One water material per body (each carries its own shoreline `bounds`).
 * Motion/visual tunables come straight from CONFIG.water; palette and
 * lighting uniforms are set by the WaterSystem from the map's environment.
 */
export function createWaterMaterial(
  scene: Scene,
  name: string,
  textures: { normal: Texture; foam: Texture },
  bounds: Vector4,
): ShaderMaterial {
  const mat = new ShaderMaterial(
    name,
    scene,
    { vertex: "water", fragment: "water" },
    {
      attributes: ["position"],
      uniforms: [...WATER_UNIFORMS],
      samplers: ["normalTex", "foamTex"],
    },
  );
  const w = CONFIG.water;
  mat.setTexture("normalTex", textures.normal);
  mat.setTexture("foamTex", textures.foam);
  mat.setVector4("bounds", bounds);
  mat.setVector4("waveA", new Vector4(w.waveScale1, w.waveScale2, w.waveSpeed1, w.waveSpeed2));
  mat.setVector4("waveB", new Vector4(w.waveStrength, w.specPower, w.specStrength, w.fresnelPower));
  mat.setFloat("time", 0);
  mat.setVector3("camPos", Vector3.Zero());
  mat.setArray3("pointPos", new Array(MAX_POINT_LIGHTS * 3).fill(0));
  mat.setArray3("pointColor", new Array(MAX_POINT_LIGHTS * 3).fill(0));
  mat.setFloats("pointRange", new Array(MAX_POINT_LIGHTS).fill(0));
  mat.setFloat("pointCount", 0);
  return mat;
}
