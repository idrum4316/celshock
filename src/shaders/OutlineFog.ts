/**
 * OutlineFog.ts — Per-pixel distance fog for Babylon's outline pass.
 * Owns: the patched `outlineVertexShader`/`outlinePixelShader` sources, and the
 * one place in this tree that reaches into Babylon's compiled-effect cache.
 * Invariants: the fog it bakes must be the SAME fog the cel shader is given —
 * `CelMaterialFactory.setEnvironment` is the only caller, so the ink and the
 * surface under it cannot describe different weather. Patching is anchored on
 * Babylon's own `#define CUSTOM_*` markers and throws in dev if one is missing,
 * because the failure mode of a silent miss is the bug this exists to fix.
 *
 * WHY THIS IS NOT DONE THE OBVIOUS WAY. An outline is a back-face shell drawn
 * by Babylon's `OutlineRenderer`, whose entire fragment shader is
 * `gl_FragColor = color` — a flat per-MESH colour, no fog, no depth. Fading
 * that colour on the CPU (which `updateOutlineScales` did first, and still does
 * for width) can only ever be per mesh, and per mesh is not enough here:
 * `BlockMerge` collapses the map into one mesh per 48 m block per material, so
 * a single mesh routinely spans the whole fog band. Measured on Greyfen: of 687
 * outlined meshes, 50 had fog 0.0 at their near edge and 1.0 at their far edge.
 * Those 50 are the village. The symptom is ink hanging in clear black lines
 * over walls that have already dissolved into the fog wall.
 *
 * THE TWO THINGS THAT MAKE A PER-PIXEL FADE POSSIBLE WITHOUT A UNIFORM.
 * `OutlineRenderer` builds its effect with a hardcoded `uniformsNames` list and
 * offers no hook to extend it, so a new uniform cannot be bound at all — every
 * value the fade needs has to be recovered from what is already there:
 *
 * - **Distance** comes from `viewProjection`. Rows 0, 1 and 3 of a perspective
 *   view-projection are `P00 * right`, `P11 * up` and `forward`; the view
 *   rotation is orthonormal, so `forward` is unit length and the other two
 *   normalise by their own length. The eye is the one point whose clip x, y and
 *   w all vanish, which those three rows give directly — no matrix inverse, so
 *   it compiles under GLSL ES 1.00 (a WebGL2 context still runs these shaders
 *   in 1.00 mode, where `inverse`/`transpose` do not exist). The result is
 *   `length(worldPos - eye)`, the SAME radial distance the cel shader fogs by.
 *   Using `gl_Position.w` instead would have been free, but planar depth
 *   disagrees with radial by up to 1.4x at the corners of a 54 deg FOV, and an
 *   outline that fogs differently from its own surface is this bug again.
 * - **Fog colour and range** are baked into the source as literals, because
 *   there is nowhere to put them. That is what `setOutlineFog` re-bakes, and
 *   why it has to drop the compiled programs.
 *
 * WHAT THE INVALIDATION COSTS. `Engine.createEffect` caches on shader NAME plus
 * defines, never on source, so a re-bake is invisible to it and the stale
 * program would be handed back forever — and `OutlineRenderer` compounds it by
 * asking the cache for an effect only when its DEFINES change, which is never.
 * `dropCompiled` is what forces the recompile, and every one of its rules was
 * paid for in a bug — see it.
 *
 * THE ONE THING THIS FILE MUST NEVER DO is statically import a Babylon shader
 * module to get at its source. See `applyWanted`. It cost a whole debugging
 * session: the symptom is not in the renderer at all.
 */
import { Color3, ShaderStore, type Scene } from "@babylonjs/core";

const VERTEX = "outlineVertexShader";
const FRAGMENT = "outlinePixelShader";

/** Babylon's own sources, captured before the first patch overwrites them. */
let pristineVertex = "";
let pristineFragment = "";

/**
 * Recovers the eye from `viewProjection` and hands the fragment shader the same
 * radial distance the cel shader measures. `worldPos` is the EXTRUDED shell
 * vertex, which is what should be fogged — it is the thing being drawn.
 *
 * Degenerates under an orthographic projection, which has no eye point. Nothing
 * here draws outlines through one: the shadow pass renders depth only.
 */
const VERTEX_BODY = `
vec3 celFogRight = vec3(viewProjection[0][0], viewProjection[1][0], viewProjection[2][0]);
vec3 celFogUp = vec3(viewProjection[0][1], viewProjection[1][1], viewProjection[2][1]);
vec3 celFogFwd = vec3(viewProjection[0][3], viewProjection[1][3], viewProjection[2][3]);
vec3 celFogEye = -celFogRight * (viewProjection[3][0] / dot(celFogRight, celFogRight))
  - celFogUp * (viewProjection[3][1] / dot(celFogUp, celFogUp))
  - celFogFwd * (viewProjection[3][3] / dot(celFogFwd, celFogFwd));
vCelFogDist = distance(worldPos.xyz, celFogEye);
`;

function glsl(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

/**
 * Rewrites both shader sources with this fog baked in. Anchors are Babylon's
 * `#define CUSTOM_*` markers, which are its documented injection points and the
 * only thing here that is not a plain uniform contract.
 */
function patch(color: Color3, start: number, end: number): void {
  const anchor = (src: string, marker: string, add: string, what: string) => {
    if (import.meta.env.DEV && !src.includes(marker)) {
      throw new Error(`OutlineFog: no ${marker} in ${what}; outlines will not fog`);
    }
    return src.replace(marker, `${marker}\n${add}`);
  };

  ShaderStore.ShadersStore[VERTEX] = anchor(
    anchor(
      pristineVertex,
      "#define CUSTOM_VERTEX_DEFINITIONS",
      "varying float vCelFogDist;",
      "outline vertex",
    ),
    // Sits after `worldPos` and `gl_Position` are assigned, so both are live.
    "#include<clipPlaneVertex>",
    VERTEX_BODY,
    "outline vertex",
  );

  const span = Math.max(0.001, end - start);
  ShaderStore.ShadersStore[FRAGMENT] = anchor(
    anchor(
      pristineFragment,
      "#define CUSTOM_FRAGMENT_DEFINITIONS",
      "varying float vCelFogDist;",
      "outline fragment",
    ),
    // Immediately after `gl_FragColor = color;`, so this fogs the ink Babylon
    // just wrote rather than replacing the whole shader's job.
    "#define CUSTOM_FRAGMENT_MAIN_END",
    `float celFogT = clamp((vCelFogDist - ${glsl(start)}) / ${glsl(span)}, 0.0, 1.0);
gl_FragColor = vec4(mix(gl_FragColor.rgb, vec3(${glsl(color.r)}, ${glsl(color.g)}, ${glsl(color.b)}), celFogT * celFogT), gl_FragColor.a);`,
    "outline fragment",
  );
}

/**
 * Forgets every compiled outline program so the next draw compiles the re-baked
 * source, and drops the draw wrappers still pointing at the old one. The cache
 * is keyed `"<vertex>+<fragment>@<defines>"` and the outline pass names both
 * halves `outline`, so that prefix takes this shader's variants (skinned,
 * instanced) and nothing else — the alternative, `releaseEffects()`, would
 * recompile the cel materials, the post-process chain and the sky on every
 * round start.
 *
 * **The cache entry is deleted, NOT released, and that is deliberate.**
 * `_releaseEffect` would also delete the GL program, and a draw wrapper holding
 * that `Effect` then draws with a deleted program — undefined behaviour, and
 * the sort that shows up as damage to whatever renders next rather than to the
 * outline. Forgetting the entry alone is enough to force a fresh compile, and
 * leaves anything still holding the old effect drawing correctly with the old
 * fog. The cost is a leaked program per fog change per define variant: a
 * handful over a session, against a class of bug that cannot be reasoned about.
 *
 * **The reset is what actually re-bakes anything; the cache delete alone does
 * nothing.** `OutlineRenderer.isReady` asks the engine for an effect only when
 * its DEFINES string changes — `if (cachedDefines !== join)` — and the outline
 * pass's defines never change for a given mesh. So a draw wrapper that already
 * holds an effect will never consult the cache again however many entries are
 * forgotten. Clearing the wrapper is the only way to make it ask, and the delete
 * exists so that what it then asks for is compiled from the re-baked source.
 *
 * **It walks EVERY mesh, and must not be filtered on `renderOutline`.** That
 * looks like the right set — it is the set the outline pass draws — but the flag
 * is a RUNTIME TOGGLE: `Bot.setOutlines` clears it past `lodOutlineDistance`
 * (20 m), so at any instant most bot rigs have it off, and bot rigs are POOLED —
 * built once, never disposed, alive across every map change. A rig that drew
 * under the old bake and was LOD'd out at the moment of the new one kept its
 * wrapper and went on drawing the previous map's fog for the rest of the
 * session. Measured on greyfen -> hollowmere: 148 wrappers still mixing ink to
 * Greyfen's `#c2ccd4`, which at the fog wall IS the ink — a bot's nine merged
 * meshes read as a scatter of white slivers over the village. Filtering on the
 * outline REGISTRY was the same mistake one layer along: it misses `ViewModel`'s
 * ~40 meshes, which set `renderOutline` by hand and never register (distance
 * thinning is meaningless 0.5 m from the lens). There is no cheap set that is
 * right, because anything may have the flag flipped on later; the whole scene is
 * the honest answer, and it is affordable: 7.1 ms for Hollowmere's 1,910 meshes,
 * once per fog change, against the ~570 ms the map build beside it costs. Only
 * the outline keys are dropped, so everything else re-fetches its effect from the
 * cache on the next frame rather than recompiling.
 *
 * This is the only place the game touches Babylon's effect cache. There is no
 * public equivalent: `createEffect` never consults the source it caches.
 */
function dropCompiled(scene: Scene): void {
  const cache = (
    scene.getEngine() as unknown as { _compiledEffects?: Record<string, unknown> }
  )._compiledEffects;
  if (cache) {
    for (const key of Object.keys(cache)) {
      if (key.startsWith("outline+outline@")) delete cache[key];
    }
  }
  for (const mesh of scene.meshes) mesh.resetDrawCache();
}

let bakedKey = "";
let wanted: { color: Color3; start: number; end: number } | null = null;

/**
 * Bakes the wanted fog if Babylon has registered the outline shaders yet.
 *
 * **The wait is why there is no `import "@babylonjs/core/Shaders/outline.vertex"`
 * here, and there must never be one.** `OutlineRenderer` pulls both shaders in
 * through a dynamic `import()`, so the store is empty until something is first
 * outlined — but importing them statically to fix that adds a deep entry to
 * `@babylonjs/core` and makes Vite re-optimize the dependency mid-session. The
 * chunks Babylon's OWN dynamic imports resolve against are rewritten by that
 * pass, and the ones already loaded 404: `glowMapGeneration.vertex` and
 * `default.vertex` were the casualties, which is the glow layer and every
 * StandardMaterial in the game. The symptom is that everything that glows stops
 * glowing, with nothing wrong in the renderer at all — see the `optimizeDeps`
 * warning in CLAUDE.md, which is the same trap from the other end. Waiting for
 * Babylon to import them itself costs one frame of un-fogged outlines and
 * touches nothing the optimizer can see.
 */
function applyWanted(scene: Scene): void {
  if (!wanted) return;
  const vertex = ShaderStore.ShadersStore[VERTEX];
  const fragment = ShaderStore.ShadersStore[FRAGMENT];
  if (!vertex || !fragment) return;
  if (!pristineVertex) {
    pristineVertex = vertex;
    pristineFragment = fragment;
  }
  patch(wanted.color, wanted.start, wanted.end);
  dropCompiled(scene);
  wanted = null;
}

/**
 * Installs this fog into the outline pass, recompiling only if it changed.
 * Called from `CelMaterialFactory.setEnvironment` — the same call that pushes
 * the fog onto the cel materials, so the two can never drift apart.
 *
 * Invalidation is entirely this function's, deliberately: the first cut left it
 * to the caller and the caller used the outline REGISTRY, which does not contain
 * the viewmodel. Nothing about a fog change should require a second party to
 * remember a second list.
 */
export function setOutlineFog(
  scene: Scene,
  color: Color3,
  start: number,
  end: number,
): void {
  const key = `${color.r},${color.g},${color.b},${start},${end}`;
  if (key === bakedKey) return;
  bakedKey = key;
  wanted = { color: color.clone(), start, end };
  applyWanted(scene);
}

/**
 * Retries a bake that arrived before Babylon had imported the outline shaders.
 * A no-op on every frame but the one or two after a fog change, and called from
 * `CelMaterialFactory.updateCamera` so nothing else has to remember it.
 */
export function refreshOutlineFog(scene: Scene): void {
  if (wanted) applyWanted(scene);
}
