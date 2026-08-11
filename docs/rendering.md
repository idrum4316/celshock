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
axis that multiplies is an axis that costs. A fourth variant means a spec type, an
`apply*`, a `get*` under its own key, one entry in `UNIFORMS`, **and** teaching
`outlineInkFor`'s regex the new `cel-<variant>-#rrggbb` name, or the ink falls back
to the palette-neutral colour. The translucency term is directional both ways — it
needs the eye looking into the key light *and* the facet turned away from it — so it
can only be judged from under the thing, moonward.

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
  groups. Putting world geometry in group 1 makes it draw through everything.
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
  camera **1.55 m above the street**.
- **Two up-facing surfaces must never share a plane.** The merge is per colour, so a
  floor slab and the plinth under it land in *different* meshes and their draw order is
  arbitrary — a shared top face is a depth-test tie broken per pixel, which strobes as
  the camera moves. It does not read as z-fighting stipple either, because the two
  surfaces are different colours: the tavern's taproom flickered between blue-grey
  stone and brown boards across all 130 m² of it. Boards stand proud of their plinth
  (`buildTavern`, `buildTownhouse`). Coplanar faces within **one** colour group are
  fine — they merge into a single mesh, which is why gable roofs meeting at a ridge are
  not a bug.

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
