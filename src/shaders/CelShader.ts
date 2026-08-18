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
 * pipeline.imageProcessingEnabled must stay false. Output is also opaque —
 * gl_FragColor's alpha is 1 for every variant but getGlass(), the world's one
 * alpha-blended material, which writes a Fresnel alpha, needs no depth write
 * (see there, and MapBuilder's pane rules), carries the one depth bias in
 * the renderer — GLASS_DEPTH_UNITS, without which a pane past ~100 m is not
 * drawn at all — and is the one variant that samples anything the renderer
 * drew for itself (setReflection, whose cube ReflectionSystem bakes and whose
 * strength is 0 until it has). Materials are cached/shared per color — don't create per-mesh
 * materials. A NEW material is seeded with
 * every piece of shared state on the spot (applyCamera/applyEnvironment/
 * applyPointLights/applyShadow): the per-frame walks are guarded on change and
 * skip a still frame entirely, so what a material is born with is what it keeps
 * until that state next moves. addOutline() skips meshes with
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
 * Opt-in at COMPILE time (getGlass, `#define CEL_GLASS`): a pane of glazing —
 * a Fresnel between what is behind it and a reflection of the sky with the
 * city composited into it, written out as a per-pixel alpha. A define rather
 * than a uniform because, unlike the two above, its terms cannot be multiplied
 * out to nothing by a zero colour: a reflect(), a pow(), a sky gradient and a
 * cube fetch on every pixel of the world is not a price the other thousand
 * meshes should pay to keep the roster uniform.
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
// The tile's own weathering — see graphics.groundVariation in the config for
// why a ground texture gets a wider cell and a wider swing than a flat colour.
uniform float groundVariationScale;
uniform float groundVariationAmount;
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

#ifdef CEL_GLASS
// Glazing. x = reflectance face-on, y = the Fresnel falloff's exponent,
// z = cosine half-width of the sun's halo in the reflection, w = how much of
// the tint a face-on pane keeps. See CelMaterialFactory.getGlass.
uniform vec4 glassParams;
// The top of the sky dome. The HORIZON end of the same gradient is fogColor,
// which is already here and which SkySpec.horizonColor is required to sit
// close to — the one place that requirement is load-bearing rather than
// cosmetic.
uniform vec3 skyZenithColor;
// The world as glass sees it: one cube baked per map install from the map's
// own geometry (systems/ReflectionSystem.ts). Alpha 1 where the bake drew
// something and 0 where it saw nothing at all, which is what lets the sky
// above stay the analytic gradient and the city below be a picture of the
// city. Colour is NOT premultiplied — see the sample below.
uniform samplerCube reflectionCube;
// The box the mirrored ray is parallax-corrected against (the map's own
// extent, floor to roofline) and the point the cube was baked from:
// reflectProbe.xyz is that point, and .w is how much of the bake a pane
// returns — 0 on a map that baked nothing, which is every map with no glazing
// on it.
uniform vec3 reflectBoxMin;
uniform vec3 reflectBoxMax;
uniform vec4 reflectProbe;
#endif

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

#ifdef CEL_GLASS
// Parallax correction for the reflection cube: where the mirrored ray leaves
// the map, expressed as a direction from the point the cube was baked at.
//
// A cube map is a picture taken from ONE place, and sampled with the raw
// mirrored ray it behaves as if everything in it were infinitely far away —
// so the city in a pane would sit still while the player walks past it, which
// reads as a decal rather than as a reflection. Intersecting the ray with a
// box that stands in for the world and re-aiming from the bake point at the
// hit is the standard correction, and here the box is not an approximation of
// anything: it is the map's own extent, which is a square with a hard boundary
// on all four sides and a roofline over it.
//
// The reciprocal is taken against a floor rather than the component itself. A
// ray exactly parallel to a face divides by zero, which is a well-behaved
// infinity that never wins the min below — but a ray parallel to a face it is
// also exactly ON divides zero by zero, and one NaN takes the whole sample
// with it. sign() cannot supply the missing direction (sign(0) is 0), so the
// magnitude is clamped and the sign restored by hand.
vec3 reflectBoxDir(vec3 dir, vec3 pos) {
  vec3 sgn = sign(dir);
  sgn += 1.0 - abs(sgn);
  vec3 inv = 1.0 / (sgn * max(abs(dir), vec3(1e-5)));
  vec3 tHi = (reflectBoxMax - pos) * inv;
  vec3 tLo = (reflectBoxMin - pos) * inv;
  // The far intersection on each axis; the nearest of the three is the face
  // the ray actually leaves through. max() picks the far one per axis because
  // one of the pair is behind the ray whenever pos is inside the box.
  vec3 t = max(tHi, tLo);
  float hit = min(min(t.x, t.y), t.z);
  vec3 aimed = (pos + dir * max(hit, 0.0)) - reflectProbe.xyz;
  // And then flipped in Y, which is not a correction to any of the above: a
  // cube face is stored top-down while a framebuffer is bottom-up, so a cube
  // RENDERED into comes out mirrored about the horizon. Babylon says as much
  // by giving a cube render target INVCUBIC_MODE, and its own reflection path
  // spends that define on this one line. Without it a pane reflects the
  // pavement where the sky should be, which reads as glass that is simply too
  // dark rather than as anything upside down — the mistake is invisible until
  // it is looked for.
  return vec3(aimed.x, -aimed.y, aimed.z);
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
  // The same world-space drift the flat colours get below, and here it is
  // load-bearing rather than a nicety: this albedo REPEATS, every 4 m on the
  // valley floor and every 1.5 m on the street, and the eye finds a period in a
  // ground plane faster than in anything else in the frame. A drift keyed on
  // world position has no period to find, so the repeat stops being the most
  // legible thing about the ground the moment there is a slower change laid
  // over it. It is also why the tiles themselves are painted with no feature
  // larger than a quarter of their width — the big variation is THIS, and a
  // tile that carried its own would only be advertising where it ends.
  //
  // No vBaked.y branch, unlike the flat path. That mask exists because a flat
  // cel colour is worn by the rigs, the viewmodel and every effect mesh, and a
  // world-keyed term on a moving mesh shimmers as it walks. Nothing that moves
  // is ever ground: getGroundTextured is reached only from the terrain and from
  // the kit's paved surfaces, both of them baked map geometry.
  base *= 1.0 + groundVariationAmount * (valueNoise(vPosW * groundVariationScale) - 0.5);
  #else
  vec3 base = baseColor;
  // Weathering: a slow value drift over world space, so a 48 m merged block
  // stops being one flat tone. Every wall, roof, plank and rock in the game is
  // drawn from a palette of a hundred-odd hexes, and the merge is per colour —
  // so all 26 cottages are literally the same PLASTER, and a whole block of
  // them arrives as a single mesh in a single value.
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
  // rigs, the viewmodel and every effect mesh.
  //
  // A BRANCH, not a mix. GLSL evaluates both arguments of mix(), so the mask
  // written that way still ran valueNoise — eight variationHash calls, each a
  // sin/dot/fract — on every pixel of the viewmodel that fills the lower third
  // of the screen, on every pixel of sixteen bot rigs and every particle, and
  // then multiplied the result by zero. The branch is uniform across a whole
  // mesh (the mask is a vertex attribute that is 1 or 0 per model, never in
  // between), so it is exactly the shape a GPU predicts well.
  if (vBaked.y > 0.5) {
    base *= 1.0 + variationAmount * (valueNoise(vPosW * variationScale) - 0.5);
  }
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

  // Opaque unless this is glazing, and the whole of what makes a pane a pane.
  float alpha = 1.0;

#ifdef CEL_GLASS
  // A window is two layers over one another and nothing else in the world is:
  // what it REFLECTS, and the tint of what you see THROUGH it. Both are
  // composited here rather than picked between, because which one you get is
  // the angle you are standing at — face-on a shopfront is the room behind it,
  // and from down the street the same glass is a sheet of sky.
  //
  // What it reflects is built in two goes down the mirrored eye ray: the sky,
  // analytically, and then the city over the top of it out of a cube baked
  // from the map's own geometry. The sky half comes first because it is what
  // the cube does NOT hold — the bake draws no dome, so everything above the
  // roofline comes back with alpha 0 and this gradient is what is left there.
  vec3 mirrored = reflect(-viewDir, n);
  vec3 sky = mix(fogColor, skyZenithColor,
    smoothstep(0.0, 0.55, mirrored.y));
  // The sun in that sky, as a HALO rather than a disc, which is what makes it
  // agree with the dome: SkySpec.discRadius is 0 on the one map with glass on
  // it, so a hard disc here would be a reflection of something the player
  // cannot look up and see. Gated by the same shadow map as everything else —
  // glass in a tower's shade does not glare.
  float halo = smoothstep(glassParams.z, 1.0, dot(mirrored, -lightDir));
  sky += lightColor * halo * shadow;

  // And the world, which is the half that makes a curtain wall read as glass
  // rather than as a tinted slab: the tower opposite, the street under it and
  // the traffic on the street, all moving across the pane as the player walks
  // because the ray is parallax-corrected before it is sampled.
  //
  // The bake is ONE cube from ONE point on the map (see ReflectionSystem), so
  // what a pane returns is the right city seen from slightly the wrong place.
  // That is the trade the feature is: six face renders once per map install
  // against a per-frame probe per building, on a renderer whose whole budget
  // argument is that the world is static and drawn once. Sold by the fact that
  // a reflection is read as motion and colour rather than as a picture —
  // nobody counts the windows in a window.
  //
  // Un-premultiplied by hand. The bake clears to a transparent black and the
  // world draws over it opaque, so a texel on a silhouette filters to a
  // fraction of the colour AND a fraction of the alpha; mixing toward that
  // colour directly would draw a dark seam around every roofline in the
  // reflection. Same arithmetic, and the same reason, as the composite below.
  vec4 world = textureCube(reflectionCube, reflectBoxDir(mirrored, vPosW));
  sky = mix(sky, world.rgb / max(world.a, 0.001), world.a * reflectProbe.w);

  // Schlick, and deliberately NOT banded. Every other term in this shader is
  // quantized and this one must not be: the band edge would be a contour line
  // across a FLAT sheet, drawn where the view angle crosses a step and nowhere
  // else — so it would slide over the glazing as the player walks, which is
  // exactly the artefact the rim light is gated off level surfaces to avoid.
  // The water's fresnel is smooth for the same reason and is the precedent.
  float fres = glassParams.x + (1.0 - glassParams.x)
    * pow(1.0 - max(dot(viewDir, n), 0.0), glassParams.y);

  // Composite the two layers into one colour and one alpha. The reflection
  // covers the tint, the tint covers what is behind the pane, and dividing by
  // the total is what keeps the blend from darkening the result twice — the
  // rasterizer is about to multiply the colour by this alpha, so what goes out
  // has to be the layers' colour rather than their contribution.
  float tint = glassParams.w;
  alpha = fres + tint * (1.0 - fres);
  col = (sky * fres + col * tint * (1.0 - fres)) / max(alpha, 0.001);
#endif

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
  //
  // The two atmosphere terms are applied to the colour and NOT to the alpha,
  // and a half-transparent pane in full fog still comes out right: whatever is
  // behind it is at least as far away and has already been mixed to the same
  // fogColor, so blending fog over fog lands on fog whatever the weight is.
  float fog = clamp((dist - fogParams.x) / (fogParams.y - fogParams.x), 0.0, 1.0);
  col = mix(col, fogColor, fog * fog);

  // Last thing before the write, because the write is the quantiser.
  gl_FragColor = vec4(dither(col), alpha);
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
 * Glazing settings for one pane material (see CONFIG.graphics.glass).
 *
 * Four numbers describing one surface, and they are read together: `tint` and
 * `reflectance` are the two layers a pane is made of, and `falloff` is how
 * fast the second takes over from the first as the angle opens out.
 */
export interface GlassSpec {
  /**
   * How much of the sky a pane returns FACE-ON, 0..1. Real glass is 0.04-0.08
   * and this is allowed to sit a little above it: the reflection is the only
   * thing telling the player a window is glass rather than a hole, and at a
   * physical 0.04 an office frontage seen square-on has nothing on it at all.
   */
  reflectance: number;
  /**
   * The Fresnel exponent. 5 is Schlick's; lower brings the sheen on sooner as
   * the angle opens, which is what makes a street of glass read as glass while
   * you walk down the middle of it rather than only at the far end of it.
   */
  falloff: number;
  /**
   * Cosine half-width of the sun's halo in the reflection — 1 is a point and
   * 0.9 is a 25-degree wash. Broad on purpose: this stands in for a disc the
   * sky does not draw (see the shader), and a hard glint would advertise that.
   */
  halo: number;
  /**
   * How much of the pane's own colour a face-on view keeps, 0..1 — so this is
   * how DARK the glass is, and it is the number that decides what can be seen
   * through a shopfront.
   *
   * It has a fairness dimension and not only a look: a bot's line of sight
   * already passes through glass (`OPAQUE_ONLY` subtracts a pane), so a window
   * the player cannot see through is one the AI can shoot them through. Tint
   * it enough to read as glass and no further.
   */
  tint: number;
}

/**
 * One reflection probe, as the glazing material that samples it needs it.
 *
 * `ReflectionSystem` owns all five and hands them over together, because they
 * are one fact: a cube is only meaningful with the point it was baked from and
 * the box its rays are re-aimed against. Splitting them into setters would let
 * a pane sample one probe's picture through another probe's parallax, which
 * looks like the reflection sliding off the building it belongs to.
 */
export interface ProbeReflection {
  /** The baked cube. Alpha 1 where the bake drew world, 0 where it saw sky. */
  cube: BaseTexture;
  /** The box the mirrored ray leaves the world through. */
  boxMin: Vector3;
  boxMax: Vector3;
  /** Where the bake was taken from. */
  at: Vector3;
  /** How much of it a pane returns, against the sky it would otherwise show. */
  strength: number;
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
  /**
   * How far toward the eye a pane is biased in the depth test, in polygon
   * offset UNITS — one unit being the depth buffer's own smallest resolvable
   * step at that fragment. **Without it, glazing past ~100 m is not drawn at
   * all**, which is the bug this exists for and it is a depth-precision one
   * rather than anything about the shading.
   *
   * A pane stands a few centimetres off the wall behind it (`kit/city.ts`'s
   * `glaze`: 0.04 m of glass over the shaft, the collars proud of that again),
   * and the depth buffer stops being able to tell the two apart with distance.
   * The camera's near plane is 5 cm — it has to be, the viewmodel's optics sit
   * inside 5 cm of the eye — and against a 24-bit buffer that leaves a step of
   * 1 cm at 90 m, 3 cm at 160 m and 27 cm at the fog wall, while the standoff
   * stays what the builder gave it. Measured on Coldharbour's curtain wall,
   * square on, with the pane held at a constant size on screen: full at 40 and
   * 90 m, **gone entirely from 130 m out** — the tower goes back to being blank
   * concrete, with nothing wrong in the shader and nothing wrong in the
   * geometry.
   *
   * A polygon offset is the fix rather than a workaround because it is stated
   * in exactly the units the problem is: it scales with the buffer's step at
   * the fragment's own depth, so it is millimetres up close, where the pane
   * needs nothing, and metres at the far end of the map, where the buffer's own
   * step is that coarse. Nothing else on offer moves: `maxZ` is worth nothing
   * (measured — the near plane is the whole of the precision), a bigger
   * standoff would have to be half a metre of glass proud of the wall by the
   * fog wall, and the near plane is spoken for.
   *
   * Sixteen against a measured knee of eight, because `r` is
   * implementation-defined and this was measured on one implementation. What it
   * costs at the far end is that the fins and collars standing 0.1-0.2 m proud
   * of the glass are overdrawn by it past ~100 m, where they are a pixel or two
   * of trim — against a whole elevation of glazing, which is the thing the
   * player can actually see.
   *
   * Only the depth TEST is biased: a blended draw writes no depth (see
   * `getGlass`), so nothing downstream inherits the offset.
   */
  private static readonly GLASS_DEPTH_UNITS = -16;

  private cache = new Map<string, ShaderMaterial>();
  private emissiveCache = new Map<string, StandardMaterial>();

  private lightDir = new Vector3(-0.5, -0.9, 0.4).normalize();
  private lightColor = new Color3(0.55, 0.62, 0.8);
  private ambientColor = new Color3(0.16, 0.18, 0.24);
  private skyLightColor = new Color3(0.08, 0.11, 0.18);
  /**
   * The top of the sky dome, as glazing reflects it — a picture of the sky
   * rather than the light it throws, which is what `skyLightColor` above is
   * and why the two are different values. Falls back to the map's flat
   * `skyColor` when it states no dome at all; see `applyEnvironment`.
   */
  private skyZenithColor = new Color3(0.1, 0.14, 0.22);
  private rimColor = new Color3(0.18, 0.2, 0.26);
  private mistColor = new Color3(0.1, 0.12, 0.15);
  private mistParams = new Vector2(2.2, 0.45);

  // Packed point-light uniforms, re-used every frame to avoid allocation.
  private pointPos = new Float32Array(MAX_POINT_LIGHTS * 3);
  private pointColor = new Float32Array(MAX_POINT_LIGHTS * 3);
  private pointRange = new Float32Array(MAX_POINT_LIGHTS);
  private pointCount = 0;

  /**
   * The eye every material in the cache is currently holding — both what
   * `updateCamera` compares against and what a material is BORN with. The two
   * have to be the same value, and that is the whole of why this field exists
   * rather than a bare "last position walked".
   *
   * `updateCamera` skips the walk when the camera has not moved, so a material
   * minted during a still frame is a material the walk will not visit again
   * until something moves — and a still frame is not the rare case: a paused
   * round, a kit screen, a player standing still and the editor's free-fly
   * camera resting on its panel are all exactly still, to the bit. Seeded from
   * anything else, such a material fogs and rims against wherever it was
   * seeded instead of against the eye; from the origin, and the editor's
   * floor-colour field repaints the whole terrain in a material that thinks
   * the viewer is standing in the middle of the map.
   *
   * The origin is the seed because the origin is what an unwritten `vec3`
   * uniform already is, so the invariant "every material in the cache holds
   * this value" is true before the first frame as well as after it. That is
   * also why there is no first-upload sentinel: a camera genuinely at the
   * origin needs no walk, because the cache is already there.
   */
  private readonly camPos = Vector3.Zero();

  // Shadow-map state, pushed onto every cel material as it is created.
  private shadowMap: BaseTexture | null = null;
  private shadowMatrix = Matrix.Identity();
  private shadowParams = new Vector4(0.0025, 0.15, 0.06, 0);

  /**
   * What each glazing material was built FROM, so a per-probe twin of it can be
   * built from the same thing.
   *
   * The reflection is the one piece of shared state that is not shared: every
   * other uniform in here is the same on every material in the cache, and a
   * cube is one probe's picture of one place. So a pane group's material is
   * keyed by (colour, slot) rather than by colour alone, and this is what lets
   * `glassProbe` mint slot 7 of a colour it was never told the name of.
   */
  private glassRecipes = new Map<
    ShaderMaterial,
    { hex: string; glass: GlassSpec }
  >();
  /**
   * The cube a glazing material is BORN holding, before any probe has claimed
   * it — `ReflectionSystem`'s first probe, published once at construction.
   *
   * It is bound with a strength of 0, so what is in it never reaches a pixel.
   * The binding is not optional even so: a `samplerCube` with nothing on its
   * unit reads whatever 2D texture is there, which is undefined behaviour
   * rather than a black fetch. This is what makes "a glazing material always
   * has a cube" true from the moment `MapBuilder` asks for one, which is
   * before any probe has been placed.
   */
  private defaultCube: BaseTexture | null = null;

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
      this.applyCamera(mat);
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
      this.applyCamera(mat);
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
      this.applyCamera(mat);
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
   * The glazing material: the same flat cel colour as get(), composited over
   * what is behind it and carrying a reflection of the sky.
   *
   * **This is the one ALPHA-BLENDED material in the world layer**, and it is
   * the only one that has any business being one. Everything else here is a
   * flat opaque cel colour, the water fakes its depth with a fresnel between
   * two opaque colours rather than showing the bed through itself, and the only
   * other transparent thing in the scene at all is the capture zone's skirt,
   * which is annotation rather than world. What it costs is the two things
   * transparency always costs and they are paid for below in `MapBuilder`: a
   * pane writes no depth and so is sorted rather than z-buffered, and it must
   * be neither an outline nor a shadow caster.
   *
   * **It is also the one material with a depth BIAS**, and that is not about
   * transparency at all: a pane hangs centimetres off the wall behind it, which
   * is a gap the depth buffer loses with distance. See `GLASS_DEPTH_UNITS`.
   *
   * Cached under its own key and named `cel-glass-#rrggbb`, like the glossy and
   * translucent variants — though unlike them nothing recovers ink from it,
   * because glass is not outlined.
   */
  getGlass(hex: string, glass: GlassSpec, slot = 0): ShaderMaterial {
    const cacheKey = slot === 0 ? `\0glass-${hex}` : `\0glass-${hex}#${slot}`;
    let mat = this.cache.get(cacheKey);
    if (!mat) {
      mat = new ShaderMaterial(
        slot === 0 ? `cel-glass-${hex}` : `cel-glass-${hex}#${slot}`,
        this.scene,
        { vertex: "cel", fragment: "cel" },
        {
          attributes: [...CelMaterialFactory.ATTRIBUTES],
          uniforms: [
            ...CelMaterialFactory.UNIFORMS,
            "glassParams",
            "skyZenithColor",
            "reflectBoxMin",
            "reflectBoxMax",
            "reflectProbe",
          ],
          samplers: [...CelMaterialFactory.SAMPLERS, "reflectionCube"],
          defines: ["#define CEL_GLASS"],
          // What puts these subMeshes in the transparent pass at all. The
          // material's own `alpha` stays 1: the alpha that matters is written
          // per pixel by the shader, and a material-wide one would fade the
          // reflection along with everything else.
          needAlphaBlending: true,
        },
      );
      // Biased toward the eye by the depth buffer's own step, which is what
      // keeps a distant window a window — see GLASS_DEPTH_UNITS.
      mat.zOffsetUnits = CelMaterialFactory.GLASS_DEPTH_UNITS;
      mat.setColor3("baseColor", Color3.FromHexString(hex));
      this.applyCamera(mat);
      this.applyEnvironment(mat);
      this.applyPointLights(mat);
      this.applyShadow(mat);
      this.applySpec(mat, null);
      this.applyTranslucency(mat, null);
      this.applyGlass(mat, glass);
      this.applyReflection(mat);
      this.glassRecipes.set(mat, { hex, glass });
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
      this.applyCamera(mat);
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
            "groundVariationScale",
            "groundVariationAmount",
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
      // Set once here rather than in `applyEnvironment` beside the flat
      // colours' pair: these two come from CONFIG and not from the map, so
      // nothing an environment change carries could move them.
      const groundVar = CONFIG.graphics.groundVariation;
      mat.setFloat(
        "groundVariationScale",
        1 / Math.max(0.001, groundVar.metersPerCell),
      );
      mat.setFloat("groundVariationAmount", groundVar.amount);
      if (bump) {
        mat.setTexture("bumpTex", bump);
        mat.setFloat("bumpScale", opts.bumpScale ?? 0.1);
      }
      this.applyCamera(mat);
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
    skyZenithColor: Color3;
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
    this.skyZenithColor = env.skyZenithColor;
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
   *
   * **The walk is the expensive half, so it is skipped when the packed arrays
   * come out unchanged.** Every entry here is four setters on every material in
   * the cache, and a `ShaderMaterial` setter is a linear scan of the 24-name
   * uniform list before it stores anything.
   *
   * **Measured, and it fires far less often than it reads.** Any fixture with
   * `flicker > 0` has `flame()` rewriting its intensity every frame, so as long
   * as one lit lamp is among the winning slots — which in a village is most
   * places a player stands — the arrays genuinely differ and the walk runs in
   * full. On Hollowmere at a standstill it saved nothing at all. What it does
   * cover is the rest: an unlit stretch of map, a map with no flickering
   * fixtures, a menu, a pause. The comparison is ~112 numbers against 172
   * setter calls, so losing the bet is far cheaper than not taking it.
   *
   * **The comparison is against `Math.fround` of each input and must stay that
   * way** — see the loop. Reading a `Float32Array` back and testing it against
   * the float64 that was stored into it is a mismatch for nearly every real
   * value, and the guard was silently losing every frame, quiet cases
   * included, until it narrowed both sides.
   *
   * What this does NOT save is the GL upload. `setArray3` bypasses Babylon's
   * own value cache and re-pushes on every material bind regardless, which is
   * a thing only a uniform buffer can fix.
   */
  setPointLights(lights: PointLightData[]): void {
    const count = Math.min(lights.length, MAX_POINT_LIGHTS);
    let changed = count !== this.pointCount;
    for (let i = 0; i < count; i++) {
      const l = lights[i];
      const b = i * 3;
      // **Narrowed BEFORE the comparison, not just on the way in.** The packed
      // arrays are `Float32Array`s, so what a store keeps is `Math.fround` of
      // what it was given, and comparing that back against the float64 the
      // light still holds is a mismatch for every value not exactly
      // representable in 32 bits — which is nearly all of them: a colour
      // channel is byte/255 times an intensity, a fixture's position has been
      // through a `rotateY`. Without the fround the guard reported "changed"
      // on essentially every frame and never skipped the walk it exists for.
      const x = Math.fround(l.position.x);
      const y = Math.fround(l.position.y);
      const z = Math.fround(l.position.z);
      const r = Math.fround(l.color.r * l.intensity);
      const g = Math.fround(l.color.g * l.intensity);
      const bl = Math.fround(l.color.b * l.intensity);
      const range = Math.fround(l.range);
      if (
        this.pointPos[b] === x &&
        this.pointPos[b + 1] === y &&
        this.pointPos[b + 2] === z &&
        this.pointColor[b] === r &&
        this.pointColor[b + 1] === g &&
        this.pointColor[b + 2] === bl &&
        this.pointRange[i] === range
      ) {
        continue;
      }
      changed = true;
      this.pointPos[b] = x;
      this.pointPos[b + 1] = y;
      this.pointPos[b + 2] = z;
      this.pointColor[b] = r;
      this.pointColor[b + 1] = g;
      this.pointColor[b + 2] = bl;
      this.pointRange[i] = range;
    }
    this.pointCount = count;
    if (!changed) return;
    this.cache.forEach((mat) => this.applyPointLights(mat));
  }

  /**
   * Call once per frame so shader fog/rim track the active camera.
   *
   * Guarded on the position for the same reason `setPointLights` is, and unlike
   * that one it wins cleanly: nothing perturbs a still camera, so a menu, a
   * pause, the deploy screen and a player standing still all stop re-uploading
   * `camPos` to 43 materials — measured at 258 setter calls a frame before the
   * guards and 175 after, on a static Hollowmere view.
   *
   * **What pays for the guard is `applyCamera` running on every material as it
   * is created**, exactly as the environment, the lights and the shadow state
   * already do. Skipping a walk is only sound while the cache cannot hold a
   * material the walk has never visited.
   */
  updateCamera(camPos: Vector3): void {
    if (!camPos.equals(this.camPos)) {
      this.camPos.copyFrom(camPos);
      this.cache.forEach((mat) => this.applyCamera(mat));
    }
    // A bake that arrived before Babylon had dynamically imported the outline
    // shaders is still outstanding; this is where it lands. No-op otherwise.
    // Outside the guard: it is not about the camera, and a bake landing on a
    // frame the player happened to be standing still for would be dropped.
    refreshOutlineFog(this.scene);
  }

  /**
   * Copies the eye the cache is currently holding into `out`.
   *
   * For the one caller that has to BORROW it: `ReflectionSystem` renders the
   * world from the probe rather than from the player, so every cel material in
   * that bake has to fog and rim against the probe — and the six faces have to
   * put back exactly what they found, because the main pass of the same frame
   * follows them.
   */
  readEye(out: Vector3): Vector3 {
    return out.copyFrom(this.camPos);
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

  /**
   * The cube every glazing material is bound to until a probe claims it.
   * Called once, by `ReflectionSystem`'s constructor, before `MapBuilder` has
   * asked for a pane material at all. See `defaultCube`.
   */
  setDefaultReflection(cube: BaseTexture): void {
    this.defaultCube = cube;
    for (const mat of this.glassRecipes.keys()) this.applyReflection(mat);
  }

  /**
   * The glazing material for ONE reflection probe: the same colour and the
   * same four glass numbers as `base`, carrying that probe's cube, the box its
   * ray is corrected against, and where it was baked from.
   *
   * This is the one place the per-colour cache is deliberately widened, and
   * the reason is that a cube is not shared state: it is one probe's picture
   * of one place, and two buildings that reflect the same thing are two
   * buildings in the same street. `slot` is the probe's index and the second
   * half of the cache key, so a map installed twice reuses the same materials
   * rather than growing the cache by a mapful every round.
   *
   * Costs no draw call: the glazing is already one merged mesh per map block
   * (`MapBuilder.paneGroup`), so this hands each of those meshes a material of
   * its own rather than splitting anything. What it does cost is a seat in the
   * cache for every one of them — the per-frame walks are guarded, so that is
   * paid on the frames that move the camera or the lights.
   */
  glassProbe(
    base: ShaderMaterial,
    slot: number,
    refl: ProbeReflection,
  ): ShaderMaterial {
    const recipe = this.glassRecipes.get(base);
    if (!recipe) {
      // Not a glazing material, which is a caller error rather than a state
      // this can be in. Handing the base back leaves the pane drawn and
      // reflecting nothing, which is the old behaviour and not a crash.
      if (import.meta.env.DEV) {
        console.warn(`[cel] glassProbe on a non-glass material: ${base.name}`);
      }
      return base;
    }
    const mat = this.getGlass(recipe.hex, recipe.glass, slot);
    mat.setTexture("reflectionCube", refl.cube);
    // **Cloned, and that is not defensive tidiness.** `ShaderMaterial` keeps
    // the Vector3 it is handed BY REFERENCE and reads it again on every bind —
    // which is exactly what `applyCamera` leans on to push one eye onto the
    // whole cache with a single copy. Here it inverts: the caller hands over
    // one scratch pair reused down a loop over 37 probes, so storing the
    // reference would leave every glazing material in the map sharing the last
    // probe's box.
    mat.setVector3("reflectBoxMin", refl.boxMin.clone());
    mat.setVector3("reflectBoxMax", refl.boxMax.clone());
    mat.setVector4(
      "reflectProbe",
      new Vector4(refl.at.x, refl.at.y, refl.at.z, refl.strength),
    );
    return mat;
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
    // The sky's own colour rather than the light it casts, and only the glass
    // materials declare it — a `setColor3` for a uniform an effect does not
    // have is dropped when the material binds, which is what lets this ride
    // along here instead of needing a second walk over a second list.
    mat.setColor3("skyZenithColor", this.skyZenithColor);
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

  /** The eye the shader fogs and rims against. See `camPos` for why on create. */
  private applyCamera(mat: ShaderMaterial): void {
    mat.setVector3("camPos", this.camPos);
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

  /**
   * Glazing is per-material like the other two, but unlike them it has no
   * null arm: `CEL_GLASS` is a compile-time define, so the only material this
   * is ever called on is one built to be glass and there is no "off" value to
   * push onto the rest of the cache.
   */
  private applyGlass(mat: ShaderMaterial, glass: GlassSpec): void {
    mat.setVector4(
      "glassParams",
      new Vector4(glass.reflectance, glass.falloff, glass.halo, glass.tint),
    );
  }

  /**
   * What a glazing material is BORN with: a bound cube and a strength of zero,
   * which is a pane that reflects the sky and nothing else.
   *
   * Unlike every other `apply*` here this is not a copy of shared state, and
   * that is the whole shape of the reflection: `glassProbe` is what gives a
   * material a real one, and it does it on the spot rather than from a walk.
   */
  private applyReflection(mat: ShaderMaterial): void {
    if (this.defaultCube) mat.setTexture("reflectionCube", this.defaultCube);
    mat.setVector3("reflectBoxMin", Vector3.Zero());
    mat.setVector3("reflectBoxMax", Vector3.Zero());
    mat.setVector4("reflectProbe", new Vector4(0, 0, 0, 0));
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
