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
 * Also owns the fog as a published fact: setEnvironment writes it once, the cel
 * materials get it as uniforms, OutlineFog bakes it into the outline pass,
 * EmissiveFog uploads it to the unlit emissive materials, and fogAmountAt()
 * hands the same curve to the GlowLayer. Anything else drawn unshaded owes that
 * fade, or it hangs in front of the fog wall at full strength.
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
  Vector4,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import { DITHER_GLSL } from "./Dither";
import { attachEmissiveFog, setEmissiveFog } from "./EmissiveFog";
import { refreshOutlineFog, setOutlineFog } from "./OutlineFog";
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
 * by the height slope, measured from world-space taps a texel apart — never
 * from screen-space derivatives, which make the relief boil as the player walks
 * (see perturbNormal) — so the light bands ripple across individual
 * cobblestones.
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
 * The rim highlight is gated OFF near-level surfaces, and must stay that way:
 * on a plane the grazing angle is just the distance from the eye, so an
 * ungated rim draws a hard-edged, camera-locked disc on the floor that slides
 * around with the player. See the gate itself for the measurement.
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

/**
 * The hard-band quantizer, shared verbatim by every surface shader in the game.
 *
 * It was three identical copies — cel, grass and water — which was harmless
 * only because nobody had ever changed it. `SHADOW_GLSL` below is the one that
 * made sharing necessary rather than tidy, and the two travel together: a band
 * function that disagreed between the three would put a different terminator on
 * a wall, the grass in front of it and the water beside it.
 */
export const BAND_GLSL = `
// Quantizes a 0..1 diffuse term into hard bands, smoothstepping across each
// edge so the terminator reads as a hard line without aliasing.
//
// **The transition is at least one PIXEL wide, and the fixed 0.15 it used to be
// is only the floor.** A band edge is a hard edge with no geometry behind it,
// so nothing in the pipe antialiases it: FXAA works on luminance contrast and
// these are low-contrast interior edges, and there is no MSAA (the only thing
// drawn to the default framebuffer is FXAA's own quad). That was harmless while
// the normal driving \`ndl\` was a facet normal — a wall's band index moves a
// thousandth of a band per pixel and one edge crosses the whole face. It stops
// being harmless the moment a BUMP map drives it: the relief puts a terminator
// around every grain, thousands of them per screen, each one aliasing on its
// own. Measured against a 4x supersampled reference of the same frame, the
// valley floor's near ground went from 1.8% of pixels off-reference to 10.3%
// when it gained a height map — and the whole of that difference was here.
//
// \`fwidth(x)\` is how fast the band index moves per pixel, so widening the
// smoothstep to it makes the edge exactly resolvable and no wider. Where the
// index moves slowly — every wall, roof and flat face in the game — it is below
// the authored 0.15 and nothing changes at all. Clamped at 0.5 because half a
// cell either side already spans the whole band: past that the quantization
// would invert rather than soften, and what it degrades to instead is smooth
// shading, which is the correct answer for a surface whose bands can no longer
// be drawn.
float band(float ndl, float steps) {
  float x = ndl * steps;
  float w = clamp(fwidth(x), 0.15, 0.5);
  return min((floor(x) + smoothstep(0.5 - w, 0.5 + w, fract(x))) / steps, 1.0);
}
`;

/**
 * The stepped shadow lookup, and the uniforms it reads. Included by the cel,
 * grass and water fragment shaders so all three sample the SAME depth map with
 * the SAME kernel.
 *
 * Grass and water went without this for as long as they existed, and the
 * artefact is the loudest continuity break the frame had: the key light is the
 * moon, so a cottage lays a hard shadow across the ground — and that shadow
 * stopped dead at the edge of a grass rect and at the waterline, because the
 * two surfaces standing in the same shadow were the two that could not see it.
 *
 * A consumer owes three uniforms (`lightMatrix`, `shadowParams`) and one
 * sampler (`shadowMap`), and owes REGISTERING with
 * `CelMaterialFactory.registerShadowConsumer` — the factory pushes all three,
 * and a material that is never registered samples an unbound texture.
 */
export const SHADOW_GLSL = `
// Stepped directional shadows. lightMatrix is the ShadowGenerator's
// view*projection (no [0,1] bias baked in — the UV/depth remap below mirrors
// Babylon's own computeShadow: uv = clip.xy*0.5+0.5, depth = (clip.z+1)*0.5).
uniform mat4 lightMatrix;
uniform sampler2D shadowMap;
// x = depth bias, y = darkness, z = normal offset, w = tap radius in UV
uniform vec4 shadowParams;

// Hard two-level shadow: lit or not, nothing in between — a soft penumbra
// would fight the flat bands. The sample point is pushed off the facet along
// its normal so a flat face never tests against its own depth (acne).
//
// The normal passed in is the one to OFFSET along, which is not always the one
// being lit: it must be the real geometry's. The cel shader hands it the facet
// normal rather than the bumped one, and water hands it the flat up-vector
// rather than the wave normal, for the same reason in both cases — the relief
// is a fiction, and offsetting along a fiction moves the shadow with it.
//
// **FOUR taps, and the count is the whole design.** One tap put the shadow map's
// own texel grid on screen: at 110 m over 2048 texels an edge climbs in 5.4 cm
// steps, and up close that reads as a staircase rather than as a line. The
// staircase has a spatial period of exactly one texel, so a kernel whose support
// covers one period cancels it — and anything WIDER starts producing a real
// penumbra, which is the thing this shader's flat bands cannot have. The
// softening is confined to the width of the artefact: a 5.4 cm edge is
// sub-pixel past about 2 m, so what is left still reads as the hard line the
// look wants. The cel terminator is band(dot(n, -lightDir), 4.0) and is not
// touched by any of this.
//
// The 2x2 is ROTATED per pixel, which matters as much as the count. Four taps
// averaged give five possible values, and five values along an edge are five
// visible contours — a staircase with more steps. Rotating by a hash of the
// pixel turns that residue into noise, which composes with dither() rather
// than fighting it.
//
// Hardware PCF is not available: this samples a plain depth texture and
// compares by hand rather than through a comparison sampler, so every tap is a
// full fetch. That is the other half of why the count stops at four.
float shadowVisibility(vec3 n, vec3 posW) {
  vec4 sc4 = lightMatrix * vec4(posW + n * shadowParams.z, 1.0);
  vec3 sc = sc4.xyz / sc4.w;
  vec2 uv = sc.xy * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
  if (sc.z < -1.0 || sc.z > 1.0) return 1.0;
  float depth = (sc.z + 1.0) * 0.5 - shadowParams.x;

  float a = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453)
    * 6.2831853;
  vec2 rot = vec2(cos(a), sin(a)) * shadowParams.w;
  vec2 perp = vec2(-rot.y, rot.x);

  float lit = step(depth, texture2D(shadowMap, uv + rot).x)
    + step(depth, texture2D(shadowMap, uv - rot).x)
    + step(depth, texture2D(shadowMap, uv + perp).x)
    + step(depth, texture2D(shadowMap, uv - perp).x);
  // Narrow smoothstep rather than a plain average: the four taps give a 0,
  // 0.25, 0.5, 0.75, 1 ladder, and this pulls the middle of it back toward a
  // decision so the edge stays an edge and only its jaggies are dissolved.
  return mix(shadowParams.y, 1.0, smoothstep(0.25, 0.75, lit * 0.25));
}
`;

/** The uniform names `SHADOW_GLSL` declares, for a consumer's uniform list. */
export const SHADOW_UNIFORM_NAMES = ["lightMatrix", "shadowParams"] as const;
/** The sampler `SHADOW_GLSL` declares, for a consumer's sampler list. */
export const SHADOW_SAMPLER_NAMES = ["shadowMap"] as const;

Effect.ShadersStore["celVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
// Baked world shading, written by world/ambientOcclusion.ts: alpha is ambient
// occlusion and green marks a vertex as WORLD geometry. Declared
// unconditionally and on purpose — a mesh with no colour buffer leaves this
// attrib array disabled, which reads back as the GL generic default
// (0, 0, 0, 1): occlusion 1 (none) and mask 0 (not world). Every rig, the
// viewmodel and every effect mesh is therefore correct without carrying one.
attribute vec4 color;
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
varying vec4 vBaked;
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
  vBaked = color;
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
// Baked per-vertex world shading. w is ambient occlusion, 1 = unoccluded;
// y is 1 on map geometry and 0 on everything else. Both defaults come from
// the disabled attrib rather than from a uniform — see the vertex stage.
varying vec4 vBaked;

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

// Albedo weathering: cell size (as 1/metres) and peak-to-peak swing. Uniforms
// rather than literals so the pair can be judged live against a wall.
uniform float variationScale;
uniform float variationAmount;

uniform vec3 pointPos[MAX_POINT_LIGHTS];
uniform vec3 pointColor[MAX_POINT_LIGHTS]; // rgb premultiplied by intensity
uniform float pointRange[MAX_POINT_LIGHTS];
uniform float pointCount;

${SHADOW_GLSL}

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

${BAND_GLSL}
${DITHER_GLSL}

// Trilinear value noise over world space, 0..1. Deliberately one octave: this
// is weathering, not detail — a second octave adds frequencies the palette
// cannot express and starts reading as texture on a surface that has none.
float variationHash(vec3 cell) {
  return fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

float valueNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  // Smoothstep the interpolant, or the cell boundaries show as creases.
  f = f * f * (3.0 - 2.0 * f);
  float n000 = variationHash(i + vec3(0.0, 0.0, 0.0));
  float n100 = variationHash(i + vec3(1.0, 0.0, 0.0));
  float n010 = variationHash(i + vec3(0.0, 1.0, 0.0));
  float n110 = variationHash(i + vec3(1.0, 1.0, 0.0));
  float n001 = variationHash(i + vec3(0.0, 0.0, 1.0));
  float n101 = variationHash(i + vec3(1.0, 0.0, 1.0));
  float n011 = variationHash(i + vec3(0.0, 1.0, 1.0));
  float n111 = variationHash(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

#ifdef CEL_BUMP
// Bump mapping for the world-XZ ground textures: perturbs the facet normal by
// the height map's slope, so the quantized light bands ripple across individual
// stones instead of sliding over one flat plane.
//
// **The slope is measured in WORLD space, from taps a texel apart, and it must
// not be measured in screen space.** The first cut used the surface-gradient
// formulation (Mikkelsen 2010) off dFdx(h)/dFdy(h), which is the right tool
// for a UV-mapped normal map on a mesh and the wrong one here, for a reason
// that only bites once the ground is the whole frame:
//
// A screen-space derivative measures how the height changes across ONE PIXEL,
// so the slope a given patch of ground reports depends on how big a pixel is
// there — which is a fact about the camera, not about the ground. On a floor
// seen at a grazing angle a pixel spans several texels along the view
// direction, so the difference is taken across unrelated grains and comes back
// as noise; and because the sampling grid slides over the texture as the player
// walks, that noise is DIFFERENT every frame. The relief boils. It is invisible
// on the cobbled street this shader was written for — a few square metres, seen
// from close and steep — and unmissable the moment a map states a
// floorSurface and 240 m of valley floor gains a height map. Measured against
// a 4x supersampled reference of the same frame, ground at 3-9 m went from 1.8%
// of pixels off-reference to 10.3% when the floor gained relief, and every bit
// of that was this function.
//
// Central differences at a fixed WORLD offset have neither problem. The slope
// at a point is the same however far away the camera is, so nothing boils; each
// tap is a filtered fetch rather than a difference of one, so the anisotropic
// sampler does its job; and the relief fades out on its own at distance,
// because two taps a texel apart converge as the mip chain smooths them. That
// last part is the whole reason no explicit distance fade is needed here.
//
// Three taps rather than four: forward differences off a shared centre. The
// asymmetry is half a texel of bias in where a grain's slope is reported, which
// is nothing beside a fetch per ground pixel.
vec3 perturbNormal(vec3 n) {
  vec2 uv = vPosW.xz * texScale;
  // One texel of the height map. Albedo and height are painted at the same
  // size (SIZE in world/textures.ts), which is what lets this be a constant.
  float e = 1.0 / 512.0;
  float h0 = texture2D(bumpTex, uv).r;
  float hx = texture2D(bumpTex, uv + vec2(e, 0.0)).r;
  float hz = texture2D(bumpTex, uv + vec2(0.0, e)).r;
  // Metres of rise per metre travelled: the tap is e / texScale metres away.
  float perMetre = bumpScale * texScale / e;
  vec3 grad = vec3((hx - h0) * perMetre, 0.0, (hz - h0) * perMetre);
  // Only the part of the gradient lying in the surface tilts it. On the
  // near-level ground this material is for that is almost all of it, and the
  // projection is what keeps a sloped road or a pitched deck honest.
  grad -= n * dot(grad, n);
  return normalize(n - grad);
}
#endif

void main() {
  vec3 n = facetNormal();

  // How level this facet is, read off the TRUE geometry before any bump map
  // touches it — the rim gate below keys on it, and reading it from the
  // perturbed normal would let individual setts flick the gate on and off.
  float level = abs(n.y);

  // --- directional key light (4 bands), gated by the stepped shadow ---
  // The shadow's normal-offset uses the true facet normal — the bump relief
  // is fake, and offsetting along it would leak light at stone edges.
  float shadow = shadowVisibility(n, vPosW);

  #ifdef CEL_BUMP
  // From here on the bumped normal drives every lighting term: key bands,
  // point lights, rim, and the specular streak all follow the setts.
  n = perturbNormal(n);
  #endif

  // Baked ambient occlusion, and it multiplies the two AMBIENT terms only.
  //
  // Not the key light: the shadow map already owns what the moon can reach, and
  // multiplying both would black out the underside of everything. Not the point
  // lights either, for the same reason those already ignore the shadow map — a
  // lantern hung in a doorway has to light the doorway, which is exactly the
  // place this term is darkest. What is left is the flat ambient and the sky
  // fill, which is the correct answer anyway: occlusion is a statement about
  // how much of the SKY a surface can see.
  //
  // Defaults to 1 on anything with no baked buffer (rigs, viewmodel, effects),
  // so this line is a no-op for them rather than a special case.
  float ao = vBaked.w;

  vec3 light = ambientColor * ao;
  light += lightColor * band(max(dot(n, -lightDir), 0.0), 4.0) * shadow;

  // Sky fill: the whole dome is a dim source, so anything looking up at it
  // picks up moonlight even where the key light is blocked. Deliberately NOT
  // gated by the shadow map — a roof in the moon's shadow still faces the sky.
  // This is what keeps roads, roofs and open ground reading as moonlit while
  // walls and undersides stay black.
  light += skyLightColor * band(0.5 + 0.5 * n.y, 3.0) * ao;

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
  // Weathering: a slow value drift over world space, so a 48 m merged block
  // stops being one flat tone. Every wall, roof, plank and rock in the game is
  // one of about thirty palette hexes, and the merge is per colour — so all 26
  // cottages are literally the same PLASTER, and a whole block of them arrives
  // as a single mesh in a single value.
  //
  // Keyed on POSITION rather than on anything per-object, which is what makes
  // it free: no vertex data, no build cost, and it survives the merge by
  // construction because the merge preserves world positions. It is also the
  // more useful axis for a village — the artefact is a flat 48 m block, and
  // what breaks that up is variation across the block rather than between the
  // buildings in it.
  //
  // INTERPOLATED, and that is not a detail. GrassShader gets away with a
  // floor()-cell hash because a tuft is a quarter of a metre and lands inside
  // one cell. On a six-metre wall a stepped hash draws a hard vertical seam
  // through the middle of it with no geometry behind it, which is worse than
  // the flatness. Value noise costs seven more taps and has no edges.
  //
  // Gated by the world mask, because a term keyed on world position applied to
  // a MOVING mesh makes it shimmer as it walks: a bot's torso would drift in
  // tone across the map. vBaked.y is 1 on baked map geometry and 0 on the
  // rigs, the viewmodel and every effect mesh, so this costs them one mix and
  // changes nothing.
  base *= mix(1.0, 1.0 + variationAmount * (valueNoise(vPosW * variationScale) - 0.5), vBaked.y);
  #endif
  #endif
  vec3 col = base * light;

  // Soft shoulder: several lights overlapping (or a torch at point-blank
  // range) would otherwise clip to flat white and destroy the palette. This
  // compresses everything above 0.75 into the remaining headroom, so hot
  // spots stay tinted by the light that made them.
  vec3 over = max(col - 0.75, 0.0);
  col = min(col, vec3(0.75)) + 0.25 * over / (1.0 + over);

  // Hard-edged rim highlight (step, not smooth — keeps colors flat), and
  // deliberately NOT applied to near-level surfaces.
  //
  // A rim light is a silhouette effect, but on a plane the grazing angle is
  // nothing but the distance from the eye: for a floor, 1 - dot(viewDir, n) is
  // 1 - eyeHeight/dist, which crosses the 0.72 step at eyeHeight/0.28 — 5.5 m
  // standing, 3.75 m crouched. So an ungated rim paints every ground pixel
  // beyond that radius and none inside it: a hard-edged disc of un-rimmed floor
  // locked to the camera and sliding across the map with the player. With the
  // shoulder lamp inside it that reads as a bright pool, then a dark ring, then
  // brighter ground — measured on Hollowmere's floor colour, luminance 0.205 at
  // 5.0 m against 0.263 at 5.6 m, a 28% step across one hard circle. A floor has
  // no silhouette to catch, so it gets no rim.
  //
  // The gate is on tilt, not on distance, because distance is the symptom. Zero
  // within 8 deg of level (every road, deck, terrace and the flat majority of
  // the heightfield), full past 26 deg — clear of the shallowest roof pitch in
  // the kit, ~24 deg (BuildingKit.gableRoof). Sculpted banks in between keep
  // most of theirs, and on a slope the boundary is broken up rather than being
  // a clean circle. Smooth, so a gentle rise doesn't draw an edge of its own.
  vec3 viewDir = normalize(camPos - vPosW);
  float rim = 1.0 - max(dot(viewDir, n), 0.0);
  col += base * rimColor * step(0.72, rim) * (1.0 - smoothstep(0.90, 0.99, level));

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

  // Last thing before the write, because the write is the quantiser.
  gl_FragColor = vec4(dither(col), 1.0);
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
    "variationScale",
    "variationAmount",
    "specColor",
    "specShininess",
    "transColor",
  ];
  /**
   * Every cel material's vertex attributes.
   *
   * `color` is on ALL of them, including the ones nothing ever bakes into. It
   * has to be: the attribute is declared unconditionally in the vertex shader
   * (there is no define to gate it, on purpose — see the shader), so leaving it
   * off a material's list would leave the effect without the location and the
   * varying would read whatever the driver left there. With it declared and no
   * buffer bound the attrib array is simply disabled, which is the defined
   * `(0, 0, 0, 1)` the whole design leans on.
   */
  private static readonly ATTRIBUTES = ["position", "normal", "color"];
  /** Every cel material samples the shadow map, whatever its albedo path. */
  private static readonly SAMPLERS = ["shadowMap"];

  private cache = new Map<string, ShaderMaterial>();
  private emissiveCache = new Map<string, StandardMaterial>();

  private lightDir = new Vector3(-0.5, -0.9, 0.4).normalize();
  private lightColor = new Color3(0.55, 0.62, 0.8);
  private ambientColor = new Color3(0.16, 0.18, 0.24);
  private skyLightColor = new Color3(0.08, 0.11, 0.18);
  private rimColor = new Color3(0.18, 0.2, 0.26);
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
  private shadowParams = new Vector4(0.0025, 0.15, 0.06, 0);

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
          attributes: [...CelMaterialFactory.ATTRIBUTES],
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
          attributes: [...CelMaterialFactory.ATTRIBUTES],
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
          attributes: [...CelMaterialFactory.ATTRIBUTES],
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
          attributes: [...CelMaterialFactory.ATTRIBUTES, "uv"],
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
          attributes: [...CelMaterialFactory.ATTRIBUTES],
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
      // The CALLER decides whether this ground is glossy at all; the installed
      // MAP decides how glossy — see `setGroundSpec`. That split matters here
      // because materials are built during `installMap`, which runs after
      // `applyEnvironment`: taking the caller's values would hand a freshly
      // built material the shipped night sheen and never revisit it, since the
      // override has already been applied to a cache this material was not yet
      // in.
      this.applySpec(mat, spec ? this.groundSpec : null);
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
      // Unlit means unfogged, which at village scale means a lit window burning
      // through the fog wall at full saturation. The plugin has to go on before
      // anything draws with the material — hence here, not in setEnvironment.
      attachEmissiveFog(mat);
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
    fogState.color.copyFrom(env.fogColor);
    fogState.start = env.fogStart;
    fogState.end = env.fogEnd;
    // The outline pass takes the same fog baked into its shader; doing it here
    // is what keeps it from ever describing different weather to the cel
    // materials this call is about to write. It owns its own invalidation —
    // notably it must NOT be given `outlineEntries`, which leaves out every
    // viewmodel mesh.
    setOutlineFog(this.scene, fogState.color, fogState.start, fogState.end);
    // And the third pass that never runs the cel shader: the unlit emissive
    // materials behind every window, flame and tracer.
    setEmissiveFog(fogState.color, fogState.start, fogState.end);
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
    // A bake that arrived before Babylon had dynamically imported the outline
    // shaders is still outstanding; this is where it lands. No-op otherwise.
    refreshOutlineFog(this.scene);
  }

  /**
   * Materials that sample the depth map but are not cel materials — the grass
   * and the water, each of which reproduces the cel lighting model in its own
   * shader (see `SHADOW_GLSL`).
   *
   * They cannot live in `this.cache`: that map is keyed by colour and its
   * entries are shared, permanent and created on demand, while these are one
   * per map build and disposed with the map. So they are a second list that
   * only the three shadow setters walk — the same shape as `specs`, which
   * holds foreign material references for the same reason.
   *
   * **Registering is the consumer's half of the contract and unregistering is
   * the other half.** Grass and water are rebuilt every round; a material left
   * here after its `dispose()` takes a `setMatrix` per frame for the rest of
   * the session.
   */
  private readonly shadowConsumers = new Set<ShaderMaterial>();

  /** Adds a non-cel material to the three shadow uploads, and seeds it now. */
  registerShadowConsumer(mat: ShaderMaterial): void {
    this.shadowConsumers.add(mat);
    this.applyShadow(mat);
  }

  /** Drops a consumer. Call from the owner's `dispose`, without exception. */
  unregisterShadowConsumer(mat: ShaderMaterial): void {
    this.shadowConsumers.delete(mat);
  }

  /** Every material that samples the depth map, cel or not. */
  private eachShadowReader(fn: (mat: ShaderMaterial) => void): void {
    this.cache.forEach(fn);
    this.shadowConsumers.forEach(fn);
  }

  /**
   * Binds the ShadowSystem's depth map to every cel material. Called once at
   * startup — the texture object is stable even though its contents re-render.
   */
  setShadowMap(map: BaseTexture): void {
    this.shadowMap = map;
    this.eachShadowReader((mat) => mat.setTexture("shadowMap", map));
  }

  /** The light's view*projection; re-uploaded when the shadow camera moves. */
  setShadowMatrix(matrix: Matrix): void {
    this.shadowMatrix = matrix;
    this.eachShadowReader((mat) => mat.setMatrix("lightMatrix", matrix));
  }

  /**
   * Depth bias, in-shadow darkness, facet-normal offset, and the depth map's
   * size — which is here because the kernel's tap offsets are in UV, and one
   * texel of UV is `1 / mapSize`. Passing the size rather than the offset keeps
   * the radius a graphics tunable instead of a number two files agree on.
   */
  setShadowParams(
    bias: number,
    darkness: number,
    normalBias: number,
    mapSize: number,
  ): void {
    const radius = CONFIG.graphics.shadows.pcfRadiusTexels / Math.max(1, mapSize);
    this.shadowParams.set(bias, darkness, normalBias, radius);
    this.eachShadowReader((mat) =>
      mat.setVector4("shadowParams", this.shadowParams),
    );
  }

  private applyEnvironment(mat: ShaderMaterial): void {
    mat.setVector3("lightDir", this.lightDir);
    mat.setColor3("lightColor", this.lightColor);
    mat.setColor3("ambientColor", this.ambientColor);
    mat.setColor3("skyLightColor", this.skyLightColor);
    mat.setColor3("rimColor", this.rimColor);
    mat.setColor3("fogColor", fogState.color);
    mat.setVector2("fogParams", new Vector2(fogState.start, fogState.end));
    mat.setColor3("mistColor", this.mistColor);
    mat.setVector2("mistParams", this.mistParams);
    // Weathering is a property of the LOOK rather than of the map, so it comes
    // from CONFIG and not from the environment — but it rides along here
    // because this is what already runs on every material, on creation and on
    // every environment change.
    const variation = CONFIG.graphics.albedoVariation;
    mat.setFloat("variationScale", 1 / Math.max(0.001, variation.metersPerCell));
    mat.setFloat("variationAmount", variation.amount);
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
    mat.setVector4("shadowParams", this.shadowParams);
  }

  /**
   * The spec each glossy material was BUILT with, so a later override can
   * find them again.
   *
   * This exists because the cache keys — `\0gloss-<hex>` and
   * `\0ground-<key>-spec-bump` — deliberately do not include the spec's
   * values, and the factory outlives a map: the second map to ask for the
   * same colour gets the first map's material, uniforms and all. Re-applying
   * over the cache is how `setEnvironment` already solves exactly this, and
   * doing it that way rather than widening the key keeps one material per
   * colour instead of one per colour per map ever loaded.
   */
  private readonly specs = new Map<ShaderMaterial, SpecSpec>();

  /** Specular is per-material, never theme-wide: null keeps a material matte. */
  private applySpec(mat: ShaderMaterial, spec: SpecSpec | null): void {
    if (!spec) {
      mat.setColor3("specColor", Color3.Black());
      // Shininess 1 is a no-op exponent — the zero specColor wins anyway.
      mat.setFloat("specShininess", 1);
      return;
    }
    this.specs.set(mat, spec);
    mat.setColor3(
      "specColor",
      Color3.FromHexString(spec.color).scale(spec.intensity),
    );
    mat.setFloat("specShininess", Math.max(1, spec.shininess));
  }

  /** What a ground material created from here on is built with. */
  private groundSpec: SpecSpec = CONFIG.graphics.spec.cobble;

  /**
   * Replaces the sheen on the GROUND material — the map's weather and the
   * elevation of its key light, which is what `CONFIG.graphics.spec.cobble`'s
   * own note says to re-check whenever the light moves.
   *
   * Passing `undefined` restores the shipped value, so switching back to a map
   * that states nothing genuinely undoes this rather than leaving the previous
   * map's streets behind. Scoped to the ground on purpose: the rifle's spec is
   * the player's weapon, which no map owns.
   */
  setGroundSpec(spec: SpecSpec | undefined): void {
    const next = spec ?? CONFIG.graphics.spec.cobble;
    this.groundSpec = next;
    this.specs.forEach((_, mat) => {
      if (mat.name.startsWith("cel-ground-")) this.applySpec(mat, next);
    });
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
 * The installed map's fog, as the passes that are NOT the cel shader see it.
 * Written by `CelMaterialFactory.setEnvironment`, which is also what pushes it
 * onto the cel materials as uniforms — one fact, one writer, so the ink and
 * the wall it hangs in front of cannot disagree.
 *
 * It is module state rather than a factory field because the passes that need
 * it reach it from outside any material. They take it two different ways, and
 * the difference is what each pass can be told:
 *
 * - The OUTLINE pass gets it baked into its shader by `OutlineFog`, and fades
 *   per PIXEL. It has to: `BlockMerge` gives one mesh per 48 m block, so a
 *   per-mesh ink fade left the far half of a block in clear ink over a wall
 *   that had already gone to fog (measured: 50 of 687 outlined meshes span the
 *   entire fog band).
 * - The GLOW layer gets it through `fogAmountAt`, and fades per MESH, because
 *   its bloom is generated from a material's emissive colour and there is no
 *   per-pixel hook at all. That is affordable where the outline's was not: a
 *   bloom is a soft blob with no edge to misplace.
 */
const fogState = { color: new Color3(0.05, 0.06, 0.08), start: 24, end: 78 };

/**
 * How much of the fog colour a surface `dist` from the eye is buried under, on
 * the cel shader's own curve — the `t * t` in CEL_FRAGMENT's atmosphere block,
 * repeated here for the passes that cannot run that shader.
 *
 * **Anything drawn unshaded owes this curve**, through here or baked as
 * `OutlineFog` bakes it, or it hangs in front of the fog wall at full strength
 * while the world behind it dissolves. That was two separate bugs on Greyfen,
 * and neither showed on Hollowmere: with a near-black fog, unfogged ink is
 * invisible against the wall and a glow reads as a lamp. A bright fog is what
 * makes an un-attenuated pass obvious.
 */
export function fogAmountAt(dist: number): number {
  const span = Math.max(0.001, fogState.end - fogState.start);
  const t = Math.min(1, Math.max(0, (dist - fogState.start) / span));
  return t * t;
}

/**
 * Outlined meshes and the width they were authored at, so
 * updateOutlineScales() can thin the ink with distance. Entries for disposed
 * meshes (the map is rebuilt every round) are pruned lazily on the next pass.
 * The ink's own fade is NOT here — it is per pixel, in `OutlineFog`.
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
 *
 * **Width only — the ink's colour is not this function's to fade.** Distance
 * here is per mesh (the bounding sphere's near point), which a width can live
 * with and a colour cannot: `BlockMerge` gives one mesh per 48 m block, so a
 * per-mesh ink fade leaves the far half of a block in clear ink over a wall
 * that has already gone to fog. That fade is per pixel, baked into the outline
 * shader by `OutlineFog`. Thinning is not a substitute for it either —
 * `minScale` still leaves a line, and a line of un-fogged ink is exactly as
 * visible as a thick one.
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
