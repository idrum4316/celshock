# Rendering: lights, fog, ink and the sky

The four light terms and the sixteen slots, the three passes that owe their own
fog, the constraints that look like bugs if you undo them, and the painted sky.
Split out of [`CLAUDE.md`](../CLAUDE.md), which keeps the summary; this file is
the contract for `LightingSystem`, `ShadowSystem`, `CelMaterialFactory`, the
shaders and `Sky`.

## The scene has (almost) no Babylon lights

Cel materials carry their own `lightDir`/`lightColor`/`ambientColor`/
`skyLightColor` and a packed array of up to `MAX_POINT_LIGHTS` (16) point lights as
uniforms; `LightingSystem` is the sole owner of dynamic light and uploads the
winning slots via `CelMaterialFactory.setPointLights()` once per frame. Adding a
`PointLight`/`HemisphericLight` to the scene will not affect any cel-shaded mesh.
Effect meshes (tracers, sparks, neon, reticles) use unlit emissive
`StandardMaterial`s from `mats.getEmissive()` and are unaffected by lighting.

**Nothing drawn outside the cel shader gets fog for free, and everything that
draws outside it owes the same fade.** The fog is a uniform on the cel materials
and a per-pixel `mix` in their fragment shader; **three** passes never run it.
Babylon's outline renderer writes `outlineColor` flat (its whole fragment shader
is `gl_FragColor = color`), the `GlowLayer` builds its bloom from a material's
emissive colour, which says nothing about where the mesh stands, and
`getEmissive()`'s unlit `StandardMaterial` — every lit window, flame, ember,
tracer, spark and team-colour bar — draws a flat colour with lighting disabled.
All three take their fog from the one published by
`CelMaterialFactory.setEnvironment`, so nothing can describe different weather
from the wall it hangs in front of — but they take it at **different
granularities, and the difference is forced**:

- **The outline fades per PIXEL**, baked into its shader by `src/shaders/OutlineFog.ts`.
  It has to. `BlockMerge` gives one mesh per 48 m block, so a per-mesh ink fade
  leaves the far half of a block in clear ink over a wall that has already gone
  to fog — measured on Greyfen, **50 of 687 outlined meshes span the entire fog
  band** (fog 0.0 at the near edge, 1.0 at the far), and those 50 are the
  village. Thinning is not a substitute: `outlines.minScale` still leaves a line,
  and a line of un-fogged ink is as visible thin as thick.
- **The bloom fades per MESH**, through `fogAmountAt` in
  `glow.customEmissiveColorSelector`. The glow map is generated from a material's
  emissive colour with no per-pixel hook at all, and it is affordable here where
  it was not for the ink: a bloom is a soft blob with no edge to misplace, and
  only 4 of 290 emissive meshes span more than half the fog band.
- **The emissive material fades per PIXEL**, through a `MaterialPluginBase` in
  `src/shaders/EmissiveFog.ts` that injects the same curve at
  `CUSTOM_FRAGMENT_MAIN_END`. A plugin *can* declare real uniforms, so unlike the
  ink this one is a buffer write rather than a re-bake — `setEmissiveFog` needs no
  cache invalidation at all. Distance is `vPositionW` against `vEyePosition`, both
  unconditional in `default.fragment`.

That this was invisible for a whole map is the point: on Hollowmere unfogged ink
is near-black against near-black fog and an unfogged glow reads as a lamp doing
its job. **A bright fog is what makes an un-attenuated pass obvious**, and
Greyfen showed all three — a stand of dead trees whose trunks fogged to pale grey
while every branch stayed a black scratch (a branch is 0.04 m of geometry inside
a 0.05 m ink shell, so it is almost entirely outline), six chapel windows that
were three saturated cyan bars on a wall faded almost to white, and a cottage
window measured at 77.6 m — inside a `fogEnd` of 78 — coming back rgb(249,177,92)
against its own `#ffb257` over a fog of rgb(194,204,212). **Fading the bloom is
not fading the thing**: the selector dimmed the halo around that bar and left the
bar. With the plugin the same pixel reads rgb(196,204,210).

**The three obvious cheaper fixes for the emissive pass are all wrong, and the
first one is the trap.** `scene.fogMode` would have been one line —
`StandardMaterial` has fog built in — but Babylon's is linear/exp over VIEW-SPACE
z where the cel shader's is `t*t` over the RADIAL distance, so a window over-fogs
against its own wall through the whole middle of the band and disagrees by up to
1.4x at the corners; it is also scene-wide, so the sky dome would need opting out
by hand. A `ShaderMaterial` of our own loses `material.emissiveColor`, which is
what the GlowLayer's selector reads — every lantern, tracer, visor and reticle in
the game stops glowing. And baking literals the way `OutlineFog` must is pure
cost here, where uniforms are available.

**`OutlineFog` is the only place this tree touches Babylon's compiled-effect
cache, and its header is the argument for why.** `OutlineRenderer` hardcodes its
`uniformsNames`, so the fade cannot be given a uniform at all: the distance is
recovered from `viewProjection` in the vertex shader (rows 0/1/3 are `P00*right`,
`P11*up` and `forward`, and the eye is the point whose clip x, y and w all
vanish — verified exact to 1e-6, and it must be that radial distance rather than
the free `gl_Position.w`, which disagrees by up to 1.4x at the corners), and the
fog colour and range are baked in as literals. Re-baking therefore has to make
Babylon forget the compiled programs, since it rebuilds a submesh's effect only
when its *defines* change, which a re-bake does not.

Three rules about that invalidation, all learned the hard way:

- **Clear the draw wrappers FIRST and IMMEDIATELY, then forget the cache entry.**
  `mesh.resetDrawCache()` defaults to `immediate = false`, which does not merely
  drop each wrapper — it queues that wrapper's `Effect.dispose()` on the engine's
  `endFrame`, and a dispose is a REF RELEASE: Babylon ref-counts an effect by how
  many wrappers asked `createEffect` for it, and the release that reaches zero
  deletes the GL program and drops the cache entry itself. Deleting the entry by
  hand *first* desynchronises that count. The bake runs inside `startRound`, so
  the order was: forget the entry, clear ~500 wrappers with their releases still
  pending, build and render the new map (which compiles a fresh effect, the entry
  being gone, and hands it to every wrapper the frame rebuilds), and only then, at
  `endFrame`, do the queued releases land and take a LIVE generation to zero — its
  program deleted under the wrappers still pointing at it. **The map is rebuilt
  after the bake, so its meshes are innocent and the damage lands only on what
  SURVIVES a map change: the pooled bot rigs and the viewmodel.** Their outline
  shells then draw from a deleted program as garbage that swallows the body it
  belongs to — on Greyfen's pale fog a squad reads as flat yellow cut-outs of
  itself, measured at 534 of 642 outline wrappers holding a freed effect one
  switch in and compounding with every further switch, while on Hollowmere the
  same garbage is near-black against near-black and invisible. Resetting
  immediately puts the releases back inside the bake, where the last one frees the
  effect with nothing holding it; the delete that follows is a backstop that can
  now strand nobody. `_releaseEffect` is still not the way to do it — it deletes
  the program on the spot, wrappers or no wrappers.
- **Scope that reset to the outline PASSES, not the whole mesh.** An unscoped
  `resetDrawCache` disposes every material's wrapper too, and disposing is a
  release: with nothing else holding them the cel materials, the sky and the
  post-process chain lose their programs and recompile. Measured on a map change:
  15 recompiles unscoped against the 1 the outline itself owes.
  `OutlineRenderer` keeps its four render-pass ids in `_passIdForDrawWrapper`.
- **Reset the draw cache of EVERY mesh in the scene, and never filter that walk.**
  The reset is the whole mechanism, not a belt-and-braces beside the cache delete:
  `OutlineRenderer.isReady` asks the engine for an effect only when its *defines*
  string changes, and the outline pass's defines never change, so a draw wrapper
  that already holds an effect never consults the cache again however many entries
  are forgotten. Two narrower sets have both been tried and both were wrong. The
  outline REGISTRY misses `ViewModel`'s ~40 meshes, which set `renderOutline` by
  hand and never call `addOutline`. `scene.meshes` filtered on `renderOutline`
  looks exactly right and is the same mistake one layer along: the flag is a
  runtime toggle — `Bot.setOutlines` clears it past `lodOutlineDistance` (20 m),
  so most bot rigs have it off at any instant — and rigs are POOLED, alive across
  every map change, so one LOD'd out during a re-bake keeps last map's fog for the
  rest of the session. Greyfen → Hollowmere left 148 wrappers mixing ink to
  `#c2ccd4`, which at the fog wall IS the ink: each rig's nine merged meshes read
  as white slivers scattered over the village, and it survived a whole session
  because a fresh boot has only one bake and nothing stale to keep. Unfiltered
  costs 4.9 ms for 1,910 meshes across the four passes, once per fog change,
  beside a ~570 ms map build.
  `setOutlineFog` owns its own invalidation for exactly this reason — the first
  cut split it across the caller and got that list wrong.

**A fifth term modifies two of the four, and it arrives as a VERTEX ATTRIBUTE
rather than a uniform.** `world/ambientOcclusion.ts` bakes per-vertex ambient
occlusion once per map build, out of the collider boxes `MapBuilder.collider()
already records plus the terrain under them, and the cel shader multiplies it
into the flat ambient and the sky fill — **not** the key light, which the shadow
map already owns, and **not** the point lights, for the same reason those ignore
the shadow map: a lantern in a doorway has to light the doorway.

Three rules about it, and the first is the one everything else rests on:

- **Occlusion lives in the colour buffer's ALPHA, and 1 means unoccluded.** A
  mesh with no colour buffer leaves that attrib array disabled, and a disabled
  generic attrib reads `(0, 0, 0, 1)` — verified in
  `ThinEngine._bindVertexBuffersAttributes`, which `continue`s past a missing
  buffer after `unbindAllAttributes()`. Alpha therefore defaults to exactly the
  neutral value, so the pooled bot rigs, the viewmodel's meshes, the grenades and
  the death cam's stand-in body are all correct **without carrying a buffer at
  all** — no define, no branch, and above all no fourth `cel-<variant>-#rrggbb`
  cache entry for `outlineInkFor`'s regex to learn. RGB defaults to 0, which is
  not neutral for a multiplier, which is why the green channel is used as a
  *mask* (1 on baked world geometry) rather than as a second multiplier.
- **The bake runs AFTER every merge, and cannot be moved earlier.**
  `VertexData.merge` throws `"Cannot merge vertex data that do not have the same
  set of attributes"` the moment one mesh in a group carries `colors` and another
  does not, and `mergeByMaterial`'s `disposeSource = true` is what turns
  Babylon's attribute-aligning path off. Baking last also makes a positional
  estimate legitimate: two meshes meeting at a corner are in different merge
  groups (the merge is per colour), and shading a vertex from where it *is*
  rather than from what it belongs to is what makes the two sides agree.
- **`hasVertexAlpha` must stay false.** `setVerticesData` does not set it, and
  the world is opaque — the alpha here is a lighting term, not a transparency.
- **Only a CEL-SHADED mesh may be given the buffer**, and `visuals` is not all
  cel materials. The cel shader reads a colour buffer as a lighting term;
  `StandardMaterial` reads it as a *colour* and multiplies its output by it,
  with `Mesh.useVertexColors` defaulting to true and nothing but the buffer's
  absence to turn the `VERTEXCOLOR` define off. `mergeByMaterial` emits one mesh
  per material, so every lit window, brazier flame, ember and sign arrives in
  `visuals` as a `block<x>,<y>-emissive-#rrggbb` drawn with an unlit emissive
  `StandardMaterial` — 42 of them on Hollowmere. Baking `rgb = (0, 1, 0)` onto
  those multiplied each one by pure green, so the village's lanterns and fires
  rendered as green blobs *inside their own correctly-coloured bloom*, since the
  `GlowLayer` builds its halo from `material.emissiveColor` and never saw the
  vertex buffer. `walk` skips anything whose material is not a `ShaderMaterial`.

The same buffer's green channel gates the cel shader's **albedo weathering**, a
slow value-noise drift over world position that stops a 48 m merged block
arriving as one flat tone. It is keyed on position rather than on anything
per-object because that survives the merge for free — and it is gated because a
world-keyed term on a *moving* mesh makes it shimmer as it walks.

**Four light terms, not three.** Beside the key light, the flat ambient and the
point lights there is a *hemispheric* term, `skyLightColor`, applied by `n.y` and
never gated by the shadow map: full strength on up-facing surfaces, nothing
underneath. It is what makes streets, roofs and open ground read as moonlit while
walls and undersides stay black — flat ambient alone lifts every face equally, which
reads as a grey wash. Because it is ungated, a roof in the moon's shadow still
catches it. It lifts *albedo*, so a bright material (the cobble street) gains far
more from it than a dark one.

**Two more terms are per-material opt-ins, and they are three cache variants rather
than a matrix.** `getGlossy` adds the toon specular (`specColor`/`specShininess`)
and `getTranslucent` the translucency band (`transColor`) — the key light coming
*through* a thin surface, for stall awnings and pine crowns. Both default to a
**black colour**, which is what makes them free on materials that skip them: every
cel material carries both uniforms and zero multiplies the term out. A material is
matte, glossy *or* translucent — never two — because the cache is per colour and an
axis that multiplies is an axis that costs. Another such variant means a spec type,
an `apply*`, a `get*` under its own key, one entry in `UNIFORMS`, **and** teaching
`outlineInkFor`'s regex the new `cel-<variant>-#rrggbb` name, or the ink falls back
to the palette-neutral colour. The translucency term is directional both ways — it
needs the eye looking into the key light *and* the facet turned away from it — so it
can only be judged from under the thing, moonward.

## The glazing: the one thing here that is not opaque

`getGlass` is the fourth variant and the odd one out three times over, and each
difference is forced by what a window is.

**It is a DEFINE (`CEL_GLASS`) rather than a uniform**, unlike the two above. The
trick that makes those free is that a black colour multiplies the term out — but
this one is a `reflect()`, a `pow()` and a sky gradient, and there is no value of
any uniform that makes a GPU skip them. Every wall, roof, road and rig in the
frame would evaluate a reflection to keep the roster uniform.

**It writes a per-pixel ALPHA, and it is the only material in the world layer
that does.** A pane is two layers over one another: what it reflects, and the
tint of what you see through it. `CONFIG.graphics.glass` carries the four numbers
— `reflectance` face-on, the Fresnel `falloff`, the sun `halo`'s width and how
dark the `tint` is — and the shader composites the pair into one colour and one
alpha, dividing by that alpha because the rasterizer is about to multiply by it.
The material's own `alpha` stays 1; what puts these subMeshes in the transparent
pass is `needAlphaBlending` in the `ShaderMaterial` options. Depth writes turn
themselves off — Babylon's `setAlphaMode` clears the depth mask for any blended
draw — so panes are sorted rather than z-buffered, which is why the glazing
merges per map block (`MapBuilder.paneGroup`) and why a transparent mesh costs
more than its triangle count says.

**It is also the one material in the renderer with a depth BIAS, and that is
not about transparency at all.** A pane hangs a few centimetres off the wall
behind it — `kit/city.ts`'s `glaze` stands 0.04 m of glass over the shaft, with
the collars proud of that again — and the depth buffer loses that gap with
distance. The near plane is 5 cm because the viewmodel's optics sit inside 5 cm
of the eye, and against a 24-bit buffer that leaves a step of 1 cm at 90 m, 3 cm
at 160 m and 27 cm at Coldharbour's fog wall. Measured square-on with the pane
held at a constant size on screen: full contribution at 40 and 90 m, **nothing
at all from 130 m out** — every distant tower back to blank concrete, with a
correct shader and correct geometry. `CelMaterialFactory.GLASS_DEPTH_UNITS`
(-16) is a polygon offset in the buffer's own units, so the correction is
millimetres up close and metres at the far end, exactly where the error is; the
near plane is spoken for and `maxZ` is worth nothing here (measured). What it
costs is the fins and collars standing 0.1–0.2 m proud of the glass, which the
bias overdraws past ~100 m where they are a pixel or two of trim.

**The reflection is built in two goes: an analytic sky, and the city over the
top of it out of a cube.** The sky half is the older one and is unchanged — it
mixes `fogColor` at the horizon toward `skyZenithColor` overhead, down the
mirrored eye ray, plus the key light as a broad halo where that ray points at
the sun. `skyZenithColor` is the one uniform taken from the map's DOME rather
than from its lighting block (`SkySpec.zenithColor`, falling back to the flat
`skyColor`) — a reflection is a picture of the sky, not the light the sky
throws, which is what `skyLightColor` beside it already is. The horizon end is
`fogColor` because `SkySpec.horizonColor` is required to sit close to it, which
is the one place that requirement is load-bearing rather than cosmetic.

**The city half is `systems/ReflectionSystem.ts`, and it is the only render
target in the game besides the shadow map.** One `ReflectionProbe` stands at the
map's centre, `graphics.reflection.height` (18 m) over the ground, and bakes the
map's opaque visuals into a 256-per-face cube once per `installMap`. It is
affordable for one reason and it is the same reason the whole world layer is
merged and frozen: the world is static, so this is not a pass, it is a build
step that happens to run on the GPU. Measured under SwiftShader, where an
ordinary frame costs 230-2500 ms, all six faces come to **70-110 ms** — a
fraction of one headless frame, once, under the building card.

Four things about it are load-bearing:

- **The bake draws no sky and no glazing, and the cube's ALPHA is what says
  so.** It clears to a transparent black and every cel variant but the glazing
  writes alpha 1, so a texel is 1 where the bake drew world and 0 where it saw
  nothing — which is exactly where the sky gradient above is what a pane should
  show. The shader composites on that alpha and un-premultiplies by hand, the
  same arithmetic and for the same reason as the Fresnel composite. The dome is
  left out because it rides at `infiniteDistance` and the box projection below
  would drag it around with the viewer; the panes are left out because a
  blended draw over a transparent clear comes back already multiplied.
- **The mirrored ray is parallax-corrected against the map's own extent**
  before it samples. A cube sampled with the raw ray behaves as if everything
  in it were infinitely far away, so the city in a pane would sit still while
  the player walks past it — a decal rather than a reflection. The box is not
  an approximation of anything: it is the boundary the four rim colliders
  already are, floor to tallest roofline.
- **The sample direction is flipped in Y**, and it is not a correction to any
  of the above. A cube face is stored top-down while a framebuffer is bottom-up,
  so a cube rendered into comes out mirrored about the horizon; Babylon says as
  much by giving a cube render target `INVCUBIC_MODE`, and its own reflection
  path spends `INVERTCUBICMAP` on the same line. Getting it wrong puts the
  pavement where the sky belongs, which reads as glass that is merely too dark.
- **The bake borrows the shader's eye and must give it back.** Every cel
  material fogs and rims against `camPos`, so the six faces are rendered with
  it moved to the probe — read on face 0 and *only* face 0, because by face 1
  the eye already is the probe. Before that guard the whole cache came out of
  the bake holding the probe's position and the main pass of the install frame
  fogged the map against a point in the middle of it.

What one cube gets wrong is position: a pane returns the right city, the right
colour, moving the right way, seen from the middle of the map rather than from
the pane. The honest alternatives are a probe per building (six renders each,
out of a budget whose whole argument is that the world is drawn once) and a
screen-space pass, which cannot answer the question the feature exists for — a
pane you are looking at reflects what is behind YOU. `graphics.reflection.
strength` (0.9) is deliberately short of 1 for the same reason: the last tenth
is what lets a player catch the approximation out by walking along a frontage.
A map with no glazing bakes nothing and publishes strength 0; the cube stays
bound regardless, because a `samplerCube` with nothing on its unit is undefined
behaviour rather than a black fetch.

**The Fresnel is deliberately NOT banded**, alone among the terms in this shader.
A band edge on a flat sheet is a contour drawn where the view angle crosses a
step and nowhere else, so it would slide across the glazing as the player walks —
exactly the artefact the rim light is gated off level surfaces to avoid, and for
exactly the same geometric reason. The water's fresnel is smooth and is the
precedent; the dither is what keeps the ramp from banding on its own.

**Glass is not outlined and casts no shadow**, and `MapBuilder` marks both on the
merged pane meshes. The shadow half is obvious once the pane is see-through. The
ink half is mechanical: Babylon draws an outline as an inverted hull BEFORE the
mesh and keeps it out of a transparent mesh's own area with a stencil pass, and
this engine is built with no stencil buffer at all (see `Game`'s constructor), so
the shell is not a ring around a pane but a dark plate behind the whole of it.
A window's frame is drawn by the mullion, the collar and the reveal, all of which
are geometry with ink of their own. Because nothing ever outlines a pane, glass
is also the one variant that owes `outlineInkFor`'s regex nothing.

**The shadow lookup is FOUR taps, and four is a ceiling rather than a budget.**
One tap put the depth map's own grid on screen — at 110 m over 2048 texels an
edge climbs in 5.4 cm steps — so the kernel spans exactly one texel, which is
the period of that staircase. Anything wider starts producing a real penumbra,
and a penumbra is the one thing the flat bands cannot have. The 2x2 is rotated
per pixel: four taps averaged give five values, five values along an edge are
five contours, and the rotation turns that residue into noise instead. Measured
as a containment check by collapsing the radius to zero (which makes all four
taps the same fetch, i.e. the old lookup): **0.33% of the frame differs, peaking
at 55/255** — a large change on very few pixels, which is the shape of something
confined to boundaries rather than spread over a penumbra.

**Grass and water sample that same depth map, and they are not cel materials.**
They reproduce the cel lighting model in their own shaders and went without a
shadow term entirely, which showed as a cottage's shadow stopping dead at the
edge of a grass rect and at the waterline. `CelShader` exports the lookup and
the band function as GLSL strings (`SHADOW_GLSL`, `BAND_GLSL`) so all three
share one kernel, and `CelMaterialFactory.registerShadowConsumer` /
`unregisterShadowConsumer` is how a non-cel material joins the three per-frame
uploads. **Registering is half the contract and unregistering is the other
half**: grass and water are rebuilt every round, and a material left registered
after its `dispose` takes uniform writes for the rest of the session. Water
offsets its shadow sample along the FLAT up-vector rather than the wave normal,
for the same reason the cel shader offsets along the facet rather than the
bumped normal — the relief is a fiction, and the shadow must not move with it.

**Every surface shader dithers its own output, and the grade is the wrong place
for it.** The chain is `hdr = false`, so the scene is quantised the instant it
lands in FXAA's input target, and the fog and mist ramps are shallow enough to
cross a quantisation step every few degrees of screen — measured at contours
nearly **seven pixels wide** on a plain village wall. `shaders/Dither.ts` adds
one LSB of triangular noise immediately before `gl_FragColor` in the cel, grass
and water shaders, which takes those contours to ~2 px. It is deliberately *not*
in `HorrorPost`: that pass is detachable by a player setting, and its grain is
already a ~10 LSB dither whenever it is attached — so the banding is a
**grade-off** artefact, and the grade-off frame is the one a pass inside the
grade cannot reach. The sky dome was the expected customer and measured as not
needing it (233 runs against 229): stars, the galactic band and the halo are
painted over the whole ramp, and the cloud decks sit in front.

The one exception is `ShadowSystem`'s `DirectionalLight`, which no material reads:
it exists only to define the shadow camera for its `ShadowGenerator`. The cel
fragment shader samples that depth map as a hard two-level term gating the key
light. The shadow window follows the player (texel-snapped, re-rendered only when
the snapped focus moves), casters are the map's merged static meshes re-registered
every round via `shadows.setCasters(map.visuals)` (skipping anything flat with
`metadata.noShadowCaster`), and characters get blob-shadow discs instead of casting.

**The depth pass draws only the casters standing in the window, and has to do that
culling itself.** Babylon culls nothing off an explicit `renderList`:
`ObjectRenderer._prepareRenderingManager` dispatches every enabled, visible mesh in
it, so the pass was submitting the whole village on every re-render — 314 casters and
79k triangles against the ~150 that can reach a 110 m window.
`ShadowSystem.cullToWindow`, hung off the shadow map's `getCustomRenderList`, is the
fix, and it is **lossless rather than a quality trade**: the light is orthographic,
so a caster's shadow lands at its own position in the light's plane and a box test
there cannot drop anything that could have darkened a texel.

**The blob shadows do not probe for the player's ground; they are handed
`Player.floorY`.** `Player.probeGround` is a whole-scene ray pick (1,775 meshes
walked, 758 solid colliders tested, ~2.5 ms) and `ShadowSystem` used to cast the
identical ray for the identical body on the same frame. Anything else wanting the
floor under the player reads that field rather than probing again.

Lights come in three flavors: static fixtures (`lighting.add()`, registered by
`MapBuilder` from a builder's `LocalLight` list or a scatter prop's entry in
`SCATTER_LIGHTS`), transient pulses (`lighting.pulse()` — muzzle flash), and carried
lights (`setCarried()`/`removeCarried()`). Transient and carried lights always get a
slot; static fixtures compete nearest-first. **That is why bot muzzle flashes are
budgeted**: 16 bots firing would take all 16 slots with transients and black out the
village's lanterns, so `BattleSystem` only records flash positions and
`Game.spendMuzzleLightBudget` spends `CONFIG.lighting.muzzleBudgetPerFrame` on the
nearest few. Any new per-bot transient light needs the same treatment. Fixture
lights are hand-placed and must stay **spatially spread** — clustering lanterns
wastes slots and flattens the darkness.

## Rendering constraints that look like bugs if you undo them

- `pipeline.imageProcessingEnabled` must stay `false`: the cel shader outputs
  display-ready colors and Babylon's image-processing pass re-gammas them and washes
  the palette out. That is also why the vignette/grain/aberration/damage flash grade is
  hand-written (`src/shaders/HorrorPost.ts`).
- Glow is a `GlowLayer` keyed off emissive color, deliberately not threshold bloom —
  bright-but-not-emissive surfaces must stay crisp.
- Flat shading is recovered in the fragment shader from screen-space derivatives of
  the world position. Do not call `convertToFlatShadedMesh()`; it would unweld vertices
  on every prop and clone for no visual gain.
- `renderOutline` draws a back-face shell expanded by `outlineWidth` in every
  direction, so an emissive detail must protrude past its neighbours' shells or the
  glow is swallowed (why the player's visor slit and the lamp lens stick out).
- **A flat surface you WALK on must be a thick box, not a thin slab**, and the
  reason is that same shell. `OutlineRenderer` draws it with a negative,
  slope-scaled polygon offset (`setZOffset(-1)`, `setZOffsetUnits(-4)`) that pulls
  it toward the camera, and the slope term is enormous at the grazing angle a
  floor is seen from — so the shell's underside, only `height + outlineWidth`
  behind the real top face, WINS the depth test and paints the surface flat in its
  own ink. The manor's board deck was 0.14 m thick and its whole 22 x 15 m hall
  floor came back as `outlineInkFor` of the boards, which on a dark timber reads as
  a black void and on a pale one as a grey wash. Nothing in the console, and the
  usual suspects all test clean: clearing the shadow casters changes nothing,
  because it is not a lighting bug at all. The same floor as a 0.54 m box renders
  correctly, which is why the podium under it never showed the fault. Depth is what
  buys the margin, so a walked surface gets a box as deep as whatever it stands on
  and is placed by its TOP face.
- **The rim highlight is gated off near-level surfaces, and the gate is not
  optional.** On a plane the grazing angle it keys on is nothing but distance from the
  eye — for a floor, `1 - dot(viewDir, n)` is `1 - eyeHeight/dist` — so an ungated rim
  fires on every ground pixel past `eyeHeight / 0.28` (5.5 m standing, 3.75 m crouched)
  and none inside it: a hard-edged disc of un-rimmed floor locked to the camera,
  sliding across the map with the player (measured luminance 0.205 at 5.0 m against
  0.263 at 5.6 m, a 28% step across one circle). The gate is on **tilt**, because
  distance is only the symptom, and it reads the **facet** normal rather than the
  bumped one — off the bumped normal, individual setts flick it on and off. It costs
  the rim on the near-horizontal top faces of a rig, which were never silhouettes.
- Rendering group **1 is the viewmodel's**, for the depth clear Babylon does between
  groups. Putting world geometry in group 1 makes it draw through everything. The
  **sky is in it too** (`Sky`'s constructor turns the depth clear back off so the
  moon still respects a wall), which is why anything reasoning about "what is on
  the camera" has to separate the two — `infiniteDistance` is the test, and both
  the glow's fog exemption and the kit screen's use it.
- **The kit screen's backdrop is the one blended mesh in the game whose DRAW
  ORDER is load-bearing** (`buildKitBackdrop` in `ViewModel.ts`). It has to cover
  the world and be covered by the weapon, and the only slot that does both is a
  blended mesh in group **0** with `alphaIndex` at `Infinity` — Babylon draws a
  group's blended meshes last, and its default `alphaIndex` is already
  `Number.MAX_VALUE`, so any ordinary large number sorts the card in front of the
  capture skirt instead of behind it. `depthFunction: ALWAYS` keeps a near wall
  from cutting it, `forceDepthWrite` is what stops the sky in group 1 drawing
  over it, and a **glow layer is composited over the finished frame and so cannot
  be covered at all** — `Game`'s emissive selector zeroes everything off the stage
  while the kit is up.
- **The post-process chain has an order, and a display setting that switches an
  effect off REMOVES its pass** rather than zeroing its uniforms — an attached but idle
  pass still reads and writes the whole frame. The order is FXAA, shafts, motion blur,
  horror grade, enforced by where each one re-attaches: `attachPostProcess` appends, so
  the blur's toggle takes the grade off and puts it back behind it
  (`Game.setMotionBlurEnabled`), and the grade's own toggle always appends because the
  tail is where it belongs. `HorrorPost` owns whether it is attached, so the blur's
  dance can never resurrect a grade the player turned off — the guard is in `attach`,
  not at the call sites. Nothing throws if this is wrong; the symptom is grain over a
  smear, which reads as a dirty lens. The red damage flash is painted by the grade's
  shader and goes off with it, leaving the HUD's damage arcs to tell the player where a
  hit came from.
- The cobblestone texture is 512² over a 1.5 m tile (`textures.ts`), sized for a
  camera **1.55 m above the street**. 512 is also written into the shader —
  `perturbNormal` takes its taps at a hard-coded `1.0 / 512.0` — so the two move
  together or every surface's relief is silently rescaled.
- **A world-mapped ground albedo gets the weathering drift too, and there it is
  load-bearing rather than a nicety.** The flat-colour path multiplies `base` by
  a slow world-space value noise so a 48 m merged block stops arriving in one
  tone; the ground path does the same with its own pair of numbers
  (`graphics.groundVariation`, a cell three tiles wide and a wider swing) for a
  different reason — a ground texture REPEATS, every 4 m on the valley floor and
  every 1.5 m on the street, and the eye finds a period in a ground plane faster
  than anywhere else in the frame. A drift keyed on world position has none to
  find. It is also why the tiles are painted with no feature larger than a
  quarter of their width: the big variation is this, and a tile carrying its own
  would only be advertising where it ends. The ground path skips the `vBaked.y`
  mask the flat path needs, because nothing that moves is ever ground.
- **A world-mapped height map's slope is measured in WORLD space, never in
  screen space**, and a band edge's smoothstep is **at least one pixel wide**.
  The two are the same artefact seen from both ends and both were exposed by
  the same change — a map stating a `floorSurface`, which turns 240 m of valley
  floor into bumped ground where before only a few square metres of cobbled
  street were. `dFdx(h)` measures the height's change across one PIXEL, so the
  slope a patch of ground reports depends on how big a pixel is there — a fact
  about the camera, not the ground — and at a grazing angle it differences
  unrelated grains and re-noises them every time the player takes a step; the
  relief boils. Central differences a texel apart are camera-independent, each
  tap is a filtered fetch the anisotropic sampler can do its job on, and the
  relief fades out on its own at range because the two taps converge as the mip
  chain smooths them, so no distance fade is needed. Meanwhile the terminators
  that relief puts around every grain are hard edges with no geometry behind
  them, and nothing in the pipe antialiases those — FXAA keys on luminance
  contrast and there is no MSAA — so `band` widens its smoothstep to `fwidth`
  wherever the band index moves faster than the authored 0.15 per pixel.
  Measured against a 4x supersampled reference of the same frame, ground at
  3–9 m: **1.8% of pixels off-reference before the floor had relief, 10.3%
  with it, 1.7% with both fixes** — the relief kept, and the whole frame now
  5.2% against the 5.8% it was before any of this.
- **Two up-facing surfaces must never share a plane.** The merge is per colour, so a
  floor slab and the plinth under it land in *different* meshes and their draw order is
  arbitrary — a shared top face is a depth-test tie broken per pixel, which strobes as
  the camera moves. It does not read as z-fighting stipple either, because the two
  surfaces are different colours: the tavern's taproom flickered between blue-grey
  stone and brown boards across all 130 m² of it. Boards stand proud of their plinth
  (`buildTavern`, `buildTownhouse`). Coplanar faces within **one** colour group are
  fine — they merge into a single mesh, which is why gable roofs meeting at a ridge are
  not a bug.
- **An impact disc is lifted off its surface (`effects.discLift`, 0.02 m) and
  that is not cosmetic.** A quad coplanar with the wall it was thrown from
  z-fights, and a flickering impact reads as a broken decal rather than as
  dust. It is the same tie the entry above describes, arriving from the other
  direction: there the fix was standing one surface proud at build time, here
  it is offsetting along the pick's own normal at spawn.

## Impacts: the one pooled effect that reads the world

`CombatSystem` throws three pools — tracers, sparks, and the **impact disc**,
which is the half a sphere could never do. A spark has no orientation; a disc
lies on the face the round was thrown from, using the surface normal the wall
pick already computed and used to discard.

What each kind looks like is a table in that file (`IMPACTS`), because art
constants live with the code that draws them — the two hex colours it replaced
were literals on the same line. Stone gets the old grey spark plus a small pale
bloom; earth gets **no spark at all** (dirt does not spark) and a bigger, duller
disc; flesh gets the spark and **no disc**, because a hit on a body must not put
dust on the world, and there is no blood anywhere in this game — this is not the
pass that would introduce it.

Three constraints hold it together, and undoing any of them is silent:

- **`DOUBLESIDE` is geometry, never `backFaceCulling`.** `getEmissive` caches
  one material per colour and this pool shares those materials with the tracers
  and the sparks, so a flag flipped here flips for every effect in the game.
- **The `noGlow` flag only works because `Game` builds `CombatSystem` before
  its construction-time GlowLayer scan.** Move the construction later and every
  dust disc blooms like a lamp. The scan is a one-shot loop over
  `scene.meshes`; anything built after it is eligible forever.
- **The disc gets its fog fade for free from `mats.getEmissive()`**
  (`EmissiveFog`), which is the whole reason it is an emissive mesh rather than
  a hand-rolled material. A dedicated unlit dust shader would owe the fade
  itself, and the obvious alternative — a particle system — is forbidden
  outright: `docs/grenades.md` names per-shot effects as exactly what that rule
  exists for. The ground puff is therefore tuned dim rather than glowing.

**The impact rides the tracer, and so does its sound.** Both are spawned when
the streak's head arrives rather than when the damage resolved, which is the
ordering `CombatSystem`'s header calls load-bearing: an impact seen or heard
before its round gets there is what makes a slowed tracer read as fake. One
`spawnImpact` raises all three so the picture and the noise cannot drift apart.

## The sky

Everything overhead is painted at runtime by `src/systems/Sky.ts` from the map's
`SkySpec`: an equirectangular dome texture (gradient, galactic band, stars, the
moon's scattering halo), a textured moon disc that feeds the GlowLayer, and two
drifting cloud decks.

**The dome is painted assuming something occludes the bottom of it**, and that
something is the valley rim — so the two are a contract, not neighbours. Stars and
the galactic band are culled below canvas row 0.46 (`if (y > h * 0.46) continue`,
written twice), `cloudBandBottom` stops cloud at 0.47, and the gradient runs to flat
`fogColor` from row 0.58 down. In elevation that is **7.2° for stars and 5.4° for
cloud**, below which nothing is painted at all. `Ridge.ts`'s `MIN_SLOPE` is the other
half of the contract; lowering the rim without moving these cutoffs uncovers a band
of empty dome.

- **Sky textures are uploaded with `update(false)`.** `DynamicTexture.update()`
  flips Y by default, which maps canvas row 0 to `v = 1` — the *nadir* on Babylon's
  sphere, whose UVs run `v = acos(y)/PI` down from the zenith. A sky painted top-down
  and then flipped puts its stars, band and halo under the map and leaves the visible
  half showing the fog colour the gradient ends on. It does not look upside down; it
  looks like there is no sky at all, with a moon still correctly placed because the
  disc is geometry, not paint.
- **Cloud masks are 3D noise sampled along each texel's own direction.** An equirect
  image stretches by `1/sin(latitude)`, so a 2D field smears into bands as it climbs
  and pinches at the pole; a tileable 3D lattice has no seam and no pole. The field is
  also **normalised to its own range before it is thresholded** — summed value noise
  clusters around 0.5, so a raw fBm against a 0.5 threshold produces haze, not cloud.
- **The moonlit silver is a second, additive shell with a static per-vertex alpha
  mask**, not a bright patch in the mask texture. The texture scrolls and the moon does
  not; baking the lit side in would drag the highlight across the sky.
- **Stars live or die on dome resolution.** 360 degrees of texture against ~50 of
  screen is a hard magnification, so a dot much over a pixel arrives as a bokeh ball —
  hence a 4096x2048 dome and `starMaxSize` ~1.6. The same magnification is why
  `cloudSoftness` is wide: bilinear magnification of a *hard* alpha contour comes out as
  straight-edged wedges, torn paper rather than cloud.
- **The dome wraps, so anything painted near its edge must be painted twice**
  (`acrossSeam`). The left and right edges are the same piece of sky, a canvas clips
  instead of wrapping, and the widest mark on the dome is the moon's halo — wider, at
  these settings, than the moon's own distance from the wrap column. Miss this and you
  get a bright gradient ending in a straight vertical line down the sky. `wrapU =
  WRAP_ADDRESSMODE` is also required (Babylon's `DynamicTexture` defaults BOTH axes to
  CLAMP) but only fixes the filtering: the seam that shows is in the paint. `v` stays
  clamped — it runs pole to pole and has nothing to meet.

`Game.applySky()` no-ops when the environment object is unchanged. The map is
rebuilt every round; the sky is not, and repainting 8 megapixels of dome plus two
noise masks for an unchanged sky is pure cost.

`GodRays` (`src/shaders/GodRays.ts`) adds the shafts in screen space: march each
pixel back toward the moon's projected position and accumulate what is bright along
the way, so anything dark between the camera and the moon leaves a beam-shaped hole.
There is no occlusion render pass — the substitute-material trick Babylon's
`VolumetricLightScatteringPostProcess` uses does not fit the cel materials — so **the
luminance threshold IS the occlusion test**, and it has to sit above the brightest
non-sky thing in the frame. That is the wet cobbled street (~0.67 looking along the
moon); below it the road smears upward and the frame fills with ground haze.

**The pass is DETACHED whenever the moon is behind the camera or off the side of the
screen**, which is most of a round (22 of 24 bearings on a level sweep). Its shader
early-outs too, but an early-out only skips the sample loop: an attached pass still
reads and writes the whole frame. `Game` owns the attachment (`syncGodRays`) and the
pass's FIRST attach as well, because Babylon's `detachPostProcess` nulls the slot
rather than removing it while `attachPostProcess` appends — so a pass that attached
itself would have no way to name the hole it came out of, and every cycle would leave
another one in a list walked every frame.
