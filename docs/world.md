# The world: maps as data, and the valley rim

How a map is declared, built, seeded and bounded — layouts, environments, the
heightfield, scatter, the two merges and the rim. Split out of
[`CLAUDE.md`](../CLAUDE.md), which keeps the summary and the two rules that
outrank everything here (visual/collider separation, and mesh metadata); this file
is the contract for `src/world/`.

## The map is data, not code

`src/world/hollowmere/layout.ts` is the entire level: placements (`{ kind, x, z,
rotY, params }`), scatter regions, control points, spawns, and the
water/grass/terrain rects. `BuildingKit` supplies the parametric pieces and
`MapBuilder` consumes the layout; neither special-cases Hollowmere, so **a second
map is one new layout file plus an `EnvironmentSpec`**. The vocabulary those files
are written in (`Placement`, `ScatterSpec`, `TerrainRect`, `MapLayout`) lives in
`src/world/layout.ts`, not beside Hollowmere's data — a new map must not import its
types from its predecessor, and `MapBuilder.build(layout, env)` takes both as
arguments for the same reason.

**The two halves are paired in `src/world/maps.ts`, and it plus
`vite.config.ts`'s `WRITABLE` table and `scripts/collision-hash.mjs`'s `MAPS` are
the only existing files a new map
touches.** A `MapDef` is `{ id, name, layout, environment, collision }`; `MAPS` is
the registry
and `DEFAULT_MAP` is the fallback. `Game` holds one `mapDef` field (`Game.mapDef`) and
reads both halves off it. Nothing outside `maps.ts` may import a map's own modules.
The shipped maps are **Hollowmere** (night), **Greyfen** (overcast dawn) and
**Coldharbour** (a city at clear afternoon). Greyfen
was forked from Hollowmere's layout, cleared back to a blank valley, and is
now being rebuilt as a jungle one: what stands is the **manor** on flag C and
nothing else, so it is the map being built rather than a second finished one.
Coldharbour was written from nothing and is the one that pushed on what a map is
allowed to be — see the next section. No two share a module in any direction.

## Three things that look global and are the map's

Everything below defaults to what the two valleys are, so a map that states
nothing is bit-identical to before any of them existed. Each was a genuine
global first and became an override when a map needed the other answer.

**`MapLayout.size` — how big the square is** (`CONFIG.map.size`, 240).
Coldharbour is 320. This was affordable because the extent was already an
ARGUMENT nearly everywhere: `GameMap.size` has always carried it, and `NavGrid`,
`ObstacleField`, the minimap and the deploy map have always been handed it. What
had to change is the handful of readers that took it from nothing — `TerrainField`
and `terrainSlab` (which now take their half-extent from the heightfield's own
`size * cell`, since the grid states it twice), `GrassSystem`'s collider index,
`Ridge`'s outside-play assertion, the editor's coordinate spinners and terrain
grade check, and `buildServerWorld`. Three things a larger map owes:

- `terrain.size * terrain.cell` must equal it. Nothing checks; the floor simply
  samples against the wrong origin and comes back as garbage.
- The rim's four boundary boxes stay over 200 m — they are `size + 4` long, so
  this holds for any map over ~196 — because **seven sites identify the boundary
  by `box.w > 200 || box.d > 200`** and know nothing else about it.
- The heightfield grows with the square rather than getting coarser, or the
  slope limit is measured over cells no author can control. Coldharbour is 80
  cells of 4 m against the valleys' 80 of 3.

**`EnvironmentSpec.fogEnd` — how far you can see.** `FOG_WALL` in
`config/fogWall.ts` used to be the answer and is now only the DEFAULT: a map's
`fogEnd` is pushed by `Game.installMap` into the three systems that gate on it —
`BattleSystem` (where a rig stops being drawn), `RagdollSystem` (where a corpse
is not worth tumbling) and `NetRoster` (the same call for a remote body). The
old dev warning that checked the two against each other is gone, because the
disagreement it reported is now the feature.

**What deliberately did NOT move with it** is the whole reason a clear map is a
layout problem as well as a palette one: `audio.maxDistance` is still 70 m,
`bots.perception.engageRange` still 55, and the shadow window still a fixed
110 m square following the player. So on Coldharbour you can see four times
further than a bot will start shooting, and the map is laid out knowing it — a
high sun to keep shadows inside the window, and streets whose clear line is
broken at chest height every few tens of metres.

**`MapLayout.surfaces` — how deep the nav graph stacks** (`CONFIG.nav.maxSurfaces`,
3). See `docs/bots.md`: a map raises it only because it stacks FLOORS, and the
guarantee that a floor survives is the ORDER its builder declares colliders in,
not the number.

Three rules:

- A `MapDef` must be a **module constant**, never rebuilt per round, and anything
  resolving one — `readMap()` from `localStorage`, say — must return an entry **out
  of `MAPS`** rather than a copy. `applySky` skips repainting eight megapixels of
  dome by comparing the environment by *identity*, so a spread-together `MapDef`
  fails that test open and repaints the sky, two fBm cloud masks included, on every
  round start. Nothing throws; it is a hitch with nothing in the profile to blame.
- **`Game.mapDef` may only be written from the `menu` state** (`Game.setMap`
  enforces it). `startRound` reads it to apply the environment, paint the sky and
  build the map, then hands the result to battle, conquest, the flag markers and the
  minimap — a write at any other time leaves all four pointing into a `GameMap` that
  `installMap` has already disposed.
- A map's display name and its **flag count** are **passed to the UI, never written
  there** — through `setScoreboard`'s `map` field, `showRoundOver`, and
  `MenuState.flagCount`. The `<h1>HOLLOWMERE</h1>` on the title screen is the
  deliberate exception: that one is the game's name, which happens also to be the
  first map's. The tagline beside it is *not* — it states the flag count, and that
  is the chosen map's.

**Five globals are per-map overrides on `EnvironmentSpec`, each defaulting to its
`CONFIG` value** — so a map that says nothing gets exactly the shipped look. They
exist because each turned out to be a statement about Hollowmere rather than about
the game: `sky.discRadius` (0 draws no disc **and** switches the god rays off, via
the zero-`moonDir` contract `Sky.clear` already documents), `sky.haloStrength`,
`grade` (the map scales the horror grade; the PLAYER still decides whether it runs
at all), `groundSpec` (the wet cobble sheen, which `config/graphics.ts` warns is tuned to the
key light's elevation), and `lighting.lampIntensity` (0 removes the player's
shoulder lamp, which otherwise spends one of the sixteen light slots).

**`groundSpec` is re-applied over the material cache, not folded into the cache
key**, and that is the whole reason it works. `getGlossy` keys on `\0gloss-<hex>`
and `getGroundTextured` on `\0ground-<key>-spec-bump`; neither includes the spec's
*values*, and `CelMaterialFactory` outlives a map — so the second map to ask for the
same colour silently gets the first map's material, uniforms and all. `setGroundSpec`
walks the cache the way `setEnvironment` already does. `getGroundTextured` also takes
the stored override rather than its caller's values, because materials are built
during `installMap`, which runs *after* `applyEnvironment`: a fresh material would
otherwise be born with the shipped night sheen and never revisited.

**What the floor is MADE of is a second per-map choice, and it owns no colour.**
`EnvironmentSpec.floorSurface` names a pattern out of `src/world/floorSurfaces.ts`
— `flat` (the default, and the plain cel colour the floor has always been), `dirt`,
`gravel`, `sand` or `turf` — and every tone that pattern paints is *derived* from
`floorColor` by `ramp`, which quantizes the pattern's tone field onto a handful of
flat multiples of it. That is the rule holding the two apart: `floorColor` is
already what the untextured floor is, what `ridgeScreeColor` is asked to melt into
and what a grass field's roots are matched against, so a surface carrying a palette
of its own would be a second answer to one question and the two would drift the
first time a map was re-tinted. Switching a map's surface changes the grain of its
ground, never the colour of it. Three consequences:

- **The albedo cache key carries the colour and the bump's does not.** A surface's
  field is seeded per pattern and reads no colour, so one height map serves every
  tint of `dirt` — while two maps on `dirt` in different soils must be two albedo
  textures rather than whichever asked first, the same trap `setGroundSpec` exists
  to close. All three shipped maps are on `dirt` now (a dead valley's soil, a wet
  jungle's loam and a city's weathered paving), so this is a live case rather
  than a hypothetical: verified in one session, three distinct albedos and
  materials against one shared bump map. The field itself is memoized one deep, which is enough because
  `floorMaterial` asks for the albedo and the bump one line apart.
- **The floor material is deliberately MATTE and must stay that way.**
  `getGroundTextured` only registers a material for `setGroundSpec` to re-apply to
  when the caller asked for a spec at all, and that sheen is the wet *cobble* one —
  a road's weather. Asking for a spec here would put a wet-stone glint on soil on
  every map that states a `groundSpec`.
- **It is a MATERIAL, so it is the one thing on an `EnvironmentSpec` that
  `applyEnvironment` cannot push.** It is baked by `MapBuilder.buildValley`, which
  is why the editor treats a floor edit as a full rebuild and why `workLight.ts`
  refuses to touch `floorColor` alongside the two rim colours.

**A surface is a FIELD sampled per texel, and nothing in one may be bigger than
about a quarter of the tile.** Every pattern is a noise recipe — folded octaves
for crumb, cellular noise over a warped domain for anything made of pieces —
evaluated into a tone plane and a height plane that are painted out together, so
a crown always sits on the grain it belongs to. Two rules come out of the version
this replaced, which scattered a few hundred filled ellipses per tile:

- **No silhouettes.** At any tile scale that keeps the repeat invisible across an
  open valley, a painted disc lands at 10–30 cm — and the eye reads a circle that
  size as an object, so the floor came back as a heap of pancakes and the height
  map turned each one into a coin. Cell borders are irregular polygons and cover
  the plane, which is why they replaced it. This is what made `turf` unusable
  (half-metre pale scales) and it was never a tuning problem.
- **No landmarks.** A tile cannot carry variation at a scale larger than itself:
  paint a damp patch across it and the patch is what advertises the period. The
  slow change of soil across a valley is `graphics.groundVariation` instead — the
  same world-space drift the flat cel colours get, applied to the ground texture
  path in `CelShader`, where it has no period to find.

**The finished visuals also carry BAKED AMBIENT OCCLUSION**, written after the
merge by `src/world/ambientOcclusion.ts` from the collider boxes and the terrain.
It is a vertex attribute rather than anything the environment can push, so it
costs nothing per frame and everything at build time (measured: 128k vertices in
71 ms, against a ~570 ms build). Two consequences for this layer: geometry added
by a path that emits no `WorldBox` occludes nothing, which is the same blind spot
navigation has and the same reason; and the editor's per-item rebuild moves a
mesh without rebaking, so a dragged cottage carries stale occlusion until the
next full rebuild. See `docs/rendering.md` for why the value lives in the colour
buffer's alpha.

**The floor is a height field, not a flat plane.** A `Heightfield` in the layout
feeds a `TerrainField` (`src/world/TerrainField.ts`), the one place the ground's
height is decided. It used to be the literal `0`, asserted independently in
`MapBuilder.buildValley`, `NavGrid.rasterize`, `Player.probeGround`,
`ShadowSystem.groundYUnder` and `GrassSystem` — five hardcodings of the same
constant, which is why the floor could not be anything but level. The grid is 80x80
cells of 3 m, sampled bilinearly, authored with the editor's terrain mode.

**The heights live in their own generated file** (`hollowmere/heights.ts`), imported
by the layout. `layout.ts` is authored — an ASCII village map, district commentary,
`BANK_H`/`TERRACE_H` in place of bare numbers — and the editor patches it one line at
a time to preserve all of that; several thousand bare numbers would drown it.
`heights.ts` is the opposite: pure generated data, rewritten wholesale, one grid row
per line so a diff shows which strips of the map moved.

- **`Placement.y`, `ScatterSpec.y` and `GrassRect.y` are offsets above the local
  floor**, not absolute heights, so dressing rides the ground when it moves. Control
  points and spawns stay absolute — the editor snaps their height to the nav surface.
  A `WaterRect` with no `y` floats `CONFIG.water.surfaceY` above **its own bed**,
  which makes a pool read as recessed: Hollowmere's bog bed is at -0.6 and its surface
  lands at -0.28, below the bank around it.
- **A `WaterRect` is an extent, not a shore, and only the terrain under it knows
  where the water actually ends.** Hollowmere's three rects are pools and their
  edges are roughly their banks; Greyfen's single rect is 250 m of flood over the
  whole valley, and its edges are out past the ridge — 11% of it is wet and the rest
  is under the hills that occlude it. `WaterSystem.bakeDepth` therefore bakes
  `surfaceY - terrain.surfaceAt(...)` across each rect into a one-byte-per-texel map
  (`CONFIG.water.depthTexels` per metre, capped) and the shader reads the waterline
  and the body colour out of that. Two consequences for an author: a rect may be
  drawn as large as is convenient, since the bed decides what is water; and
  **anything that reshapes the bed owes a water rebuild**, which `installMap` already
  does — the map dies with the terrain it was baked against.
- **`NavGrid.link` is the slope limit.** It links neighbouring surfaces only within
  `stepHeight`, so at `cellSize` 1.5 a bank is walkable up to a gradient of 0.4
  (~22 deg) and severs itself above that — `MAX_WALKABLE_GRADE`. On a 3 m terrain cell
  that is a 1.2 m single-cell step. Nothing else enforces it: the brush reports the
  gradient under the cursor live, and `validate.ts` scans every grid edge.

The terrain mesh is one quad per cell, emitted per 48 m block, with two fast paths
that keep a mostly-level map cheap: no heightfield at all is a single quad, and a
block whose vertices are all one height collapses to a quad too. Hollowmere is 25
blocks and **3,110 triangles**.

**A road is re-cut against that mesh.** One height sample at a placement's centre is
right for a cottage and wrong for a 130 m street, which used to float at one end and
bury itself at the other, so `terrainSlab` (in `TerrainField.ts`) tessellates the
slab to follow the ground. It is a builder reading `BuildCtx` and still returns
origin-local geometry, so the merge is unaffected. Three things make it work, and
undoing any puts black holes in the cobbles:

- **It samples `surfaceAt`, not `heightAt`.** The floor is *drawn* as flat triangles
  across a bilinear field and the two differ by up to a quarter of a cell's twist.
  Follow the smooth field and the road sinks under the mesh on every twisted cell —
  and the symptom is not a sunken road but the road's own outline shell showing
  through as black blobs, because the shell passes the depth test where the surface it
  belongs to does not.
- **Its cuts are the terrain's own grid lines, and nothing between them**, so a slab
  quad coincides with a terrain quad corner for corner. Subdividing finer is strictly
  *worse*: a mid-cell sample lands on the wrong side of the terrain's diagonal.
  `surfaceAt(x, z, true)` — the upper envelope of the cell's two triangle planes —
  covers samples that can't be on a grid line (the road's own edges); being convex, a
  triangle between three of its samples is guaranteed to clear the floor.
- **An odd quarter turn flips the diagonal.** `rotY = ±π/2` maps the local diagonal
  onto the world *anti*-diagonal, so the road would split every cell the opposite way
  from the ground it lies on; the quad starts one corner along.

A road over level ground still collapses to the single box it always was
(`terrainSlab` returns null), so this costs nothing on the shipped map. Only `road`
does this (`CONFORMS_TO_TERRAIN` in `BuildingKit.ts`); `terrace`, `ramp`, `stairs`,
`jetty` and `bridge` carry walkable box colliders, and bending only their visuals
would put the surface you see out of agreement with the surface bullets spark off.
The ones with a long run instead take an **overrun** — `stairs` and the manor's
service flight run on past their own feet and let the buried treads go — because a
placement height-samples once at its centre and a flight's foot is half a run away
from it.

**A walked surface more than `stepHeight` up needs something built to reach it, and
`stairs` is that piece.** Its run is `height / 0.35` and is derived rather than
authored, since a flight steeper than `MAX_WALKABLE_GRADE` severs its own links
without a symptom — the same trap `buildBoardwalk` refuses a `height` spinner over.
Butt the top of the run against the deck's edge: the joint is then two neighbouring
cells within a step, and nothing has to line up more precisely than that.

**Babylon defaults to a LEFT-handed system** (`scene.useRightHandedSystem` is
false), so a front face is *clockwise* seen from the front. Hand-built `VertexData`
wound the right-handed way — the order you get working the cross product out on
paper — fails in the worst possible manner: the meshes build, the shaders compile,
the console is clean, nav and picking are unaffected (Babylon's triangle picking is
two-sided), and the only symptom is that `ComputeNormals` derives downward normals,
so the floor is back-face culled and lit from below. The world looks like it has no
ground at all and every number you can check still reads correct. `assertFacesUp`
throws on it in dev builds; trust that over your own derivation.

The terrain is emitted **per 48 m block**, each with an invisible clone marked
`solid` — the one place a collider shares a visual's vertices, since a heightfield
has no box to stand in for it, so `MapBuilder.collider()` is bypassed and `NavGrid`
reads the field directly. The block split is not just for culling: `CameraSystem`
picks every frame and `CombatSystem` every shot, and one map-wide floor mesh would
defeat bounding-box rejection.

**That clone is also the one collider in the world that says what it is made
of.** It carries `metadata.surface = "ground"`, which is what a round stopping
there kicks up — a dull brown dust disc and a lowpassed thud rather than the
spark and tick a wall gives. Being bypassed by `collider()` is exactly what
makes this cheap: the clone *is* the heightfield, so it is the one thing that
can honestly answer the question, and every box `collider()` makes leaves the
field **absent**, which reads as `"hard"`.

So a new map, a new building or a new prop owes nothing here at all — the
default is the common case, and the exception is a single line beside the one
mesh that is genuinely different. Splitting the boxes into stone, timber and
metal later is a `surface` argument on `collider()` plus a member of
`ImpactKind`; nothing between the world layer and `CombatSystem` moves, and
nothing already built has to be revisited.

## The valley rim

The map's boundary is **four collider boxes and a landform, and they are two
separate things** — the clearest case of the visual/collider split in the tree.
`MapBuilder.buildValley` emits the four boxes (20 m tall, 244 m long, inner faces at
exactly ±120) and they are the only thing that stops anything leaving;
`src/world/Ridge.ts` draws an escarpment over them and stops nothing. That split is
why seven sites — `NavGrid` (rasterize, severLinks, clearBlocked), `ObstacleField`,
`CoverMap`, `Minimap`, `DeployScreen` — identify the boundary with `box.w > 200 ||
box.d > 200` and know nothing about the rim. **Keep the boxes over 200 m and keep
the rim collider-free**, or that heuristic is the first casualty. The minimap and
deploy map still draw a clean square while the world shows a lumpy one; they are
schematics, and that is correct.

- **It is built OUTWARD from ±120 and never inward**, into space no player can
  occupy, so it costs zero playable area. `assertOutsidePlay` throws in dev.
- **Its basal band is vertical and flush with the collider plane.** Colliders have
  to line up with the surfaces they stand in for, and a face battered outward from the
  floor would put visible rock most of a metre in front of the box at chest height, so
  rounds would spark on air. `PLINTH_FLOOR` (1.8 m) clears the standing eye, the hit
  sphere's top and `CoverMap`'s hard-cover height; the noise and the passes ride above
  it, never through it. Measured flush to 0.000 m at 1.05/1.55/1.7 m on all four rims.
- **The crest is an ANGLE from the map centre, never a height.** `Sky.ts` culls
  stars below dome row 0.46 (7.2° elevation) and cloud below 0.47, and paints the dome
  flat `fogColor` beneath the horizon — so a crest under that exposes a band of sky
  with nothing painted in it. A tangent clamped at `MIN_SLOPE` makes that true by
  construction, and buys the corners bigger massifs than the sides for free. The rim
  measures 8.19° at its lowest (the two passes deliberately dipping) against the 7.2°
  floor.
- **A pass is a saddle, not a cutting.** `MIN_SLOPE` sits just above the sky's floor
  rather than at the rim's own height precisely so a pass has somewhere to drop to —
  at 0.17 the clamp swallowed the cut and the cols were invisible. Only the crest
  falls; the face is left alone, because pulling it in and raising the basal band
  turns a way out of the valley into a quarry.
- **Its own RNG stream.** `buildValley` runs *before* the scatter loop, so a single
  draw from `MapBuilder`'s shared stream would reroll every scatter region on the map
  — a visible change with nothing in the diff to point at it. Verify a rim change by
  fingerprinting `colliderBoxes`.

Shape lives on `MapLayout.ridge` (a `RidgeSpec`, all fields optional) and the
palette on `EnvironmentSpec` (`ridgeColor`/`ridgeScreeColor`). That split is not
tidiness: `applyEnvironment` writes uniforms and nothing else, which is what lets
the editor's work light swap a spec per keypress with no rebuild, so a *shape*
living there would silently stop working. The rim is a **receiver only**
(`noShadowCaster`) — a 20–45 m crest throws 26–58 m of shadow at the moon's 38° and
the shadow window is a fixed 110 m square following the player, so a casting rim
would end its shadow in a hard line sliding across open ground as you walk.

**Scatter placement is seeded** (`layout.seed`, via `src/world/rng.ts`). This is not
cosmetic: blocking scatter emits colliders, colliders feed `NavGrid` and
`ObstacleField`, so an unseeded scatter means the navigation graph differs between
page loads and a bot wedged on a boulder is only reproducible on some boots. Never
call `Math.random()` in world-building code. One stream serves the whole build, so
**inserting a region rerolls every region after it** — append rather than insert if
you want a readable diff.

**A scatter region is a disc or an oriented rectangle** (`ScatterCircle` /
`ScatterRect`, discriminated by which extents are present — `radius`, or
`width`/`depth` plus `rotY`). Both shapes draw the same two random numbers per
placement attempt, so the shipped map's dressing is bit-identical to what the
circle-only sampler produced. A region is filed under the map block its **centre**
falls in, so break a belt longer than the 78 m fog wall into a few rectangles.

Builders assemble geometry **at the origin, unrotated**, and return three parallel
lists (`meshes`, `colliders`, `lights`) in local space; `MapBuilder` merges the
meshes per colour and then transforms all three into place. Building at identity is
what makes the merge safe — `MergeMeshes` bakes world matrices and returns an
identity-transform mesh. **A scatter region obeys the same rule**, which is what
lets the editor move and turn one by writing a transform. A merge of *one* mesh is
the exception `MergeMeshes` will not handle — `mergeByMaterial` bakes those by hand,
and before it did, every colour used by a single part of a rotated building (the
tavern's sign, the smithy's forge glow, the boathouse lamp) was translated into
place without being rotated.

A **second merge pass** (`BlockMerge`) collapses neighbouring structures and scatter
fields into one mesh per (48 m map block, material). The village is ~230 structures
and the outline pass draws every mesh twice, so without it the map alone costs ~670
draws; with it, ~150, and frustum culling still throws away most of the map because
a block is well inside the 78 m fog wall. Outlines still trace each building,
because `renderOutline` expands vertices along their own normals.

**A building that stacks WALKED FLOORS is a different kind of thing from
everything else in the kit, and `kit/city.ts`'s header is its contract.** Every
other builder is one walked surface with a roof over it; an office with three
storeys and a stair between each pair runs into four limits at once, and the
file states all four. In summary, because a new multi-storey builder anywhere
will meet them: emit walked surfaces FIRST (see `docs/bots.md` on arrival
order); a flight is `rise / 0.35` long and the slab it climbs to may not cover
it, so put flights in a LANE at one edge and leave that lane out of the slab
above — alternating edges storey by storey so two voids never stack, and keeping
the head of the lane out of the void as a LANDING that runs from the top tread
to the elevation ahead of it, or the top tread is merely flush with the slab
beside it and walking off the stair the way you climbed it drops you a storey (a
landing of a fixed depth only moves that drop back by its own depth: measured on
Coldharbour, 4.5 m of open lane still stood in front of an office landing over a
3.4 m fall); a walked
slab needs real depth behind its top face or its own outline shell paints it;
and a mullion or a fin is a `strut`, never a wall.

## Panes: the one thing in the world that is not static

`Build.pane` is the fourth box word, and the only one whose geometry leaves
`Structure.meshes`. A pane is drawn like a `box` and passes a round like a
`porous` `block`; a `breakable` one also keeps an identity through both merge
passes, so `GlassSystem` can take that sheet and no other out of the world at
runtime.

**Which sheets those are is a DESIGN question and it is answered before any
cost one: glass breaks where there is enterable space behind it.** A sheet hung
on something solid stops nothing — the round has always ended on the concrete —
so breaking it changes nothing you can play with, and it costs the building the
one thing an elevation was saying: a street-level shopfront that shatters into a
blank grey shaft is a building admitting it is a box. Coldharbour draws **6,139
sheets and twenty-four of them break**, all twenty-four SHOPFRONT bays — twelve
on the two offices and twelve on the eight shophouses.
The curtain walls (4 cm off a solid shaft), the punched windows drawn on the
same shaft, the shophouses' sash windows drawn on their own shells and the cars'
greenhouses (a cabin nobody gets into) stay whole. The
offices' upper window bands are the case one step further on: they are left
OPEN, because glass over a spandrel that already stops a body is worth neither
the pane nor the drawing.

Everything below follows from that split, and the sharpest consequence is that
**a sheet which is not `breakable` is geometry and nothing else**: no
`WorldPane`, no collider, no bucket in the sweep, no row in the collision bake,
no index on the wire. The city's glazing is drawn by the same code and known to
no other part of the game.

**The DRAW CALLS are the one cost every sheet pays, and the answer is that
glazing is merged and a pane is a vertex range rather than a mesh.** A mesh each
would be 6,139 meshes against ~150 for the whole map — and worse than the count
says, because glazing is alpha-blended and a transparent mesh is sorted and
drawn on its own rather than batched. Instead it merges per placement
(`MapBuilder.paneGroup`) and then again per 48 m block (`PaneBlocks`), which on
Coldharbour is **82 glazed placements into 40 meshes**. A breakable pane's
positions are a known range in the result: breaking one collapses that range
onto its own first vertex, every triangle in it becomes degenerate and
rasterizes nothing, and the cost is one `updateVerticesData` on one small
buffer. Only the eight blocks that hold a breakable pane keep an updatable
position buffer at all; the other 32 are immutable for the life of the map.

That is what makes the glazing unit a free choice — a tower is cut into bays
because a curtain wall's whole appearance is the grid it is divided by, and the
cut costs nothing the renderer pays per frame.

What makes that collapse the whole of a break rather than the first half of one
is that a pane owns nothing else to take down with it: it carries no outline and
casts no shadow (below), so there is no second registration anywhere to revoke.
And `bakeVertexAo` writes the COLOUR buffer, so it is untouched by a later
position rewrite and the bake may still run last.

**A pane is CLEAR, and that is a rule about the world and not only a look.**
`Build.pane` is the only builder call that reaches `CelMaterialFactory.getGlass`
— the world's one alpha-blended material, which composites a reflection of the
sky over the tint of whatever is behind the glass (see
[`docs/rendering.md`](rendering.md) for the shader). Two consequences belong
here rather than there:

- **The merged pane meshes are marked `noOutline` and `noShadowCaster`**, in the
  `paneBlocks.finish` loop in `MapBuilder.build`. Ink on a transparent mesh
  needs a stencil buffer this engine does not have and lands as a dark plate
  behind the pane; a clear sheet laying a hard shadow on the pavement is simply
  wrong. A window's frame is drawn by the mullion, the collar and the reveal.
- **It settles a fairness question that was open while glass was opaque.** A
  pane is `porous`, so `OPAQUE_ONLY` already lets a bot's line of sight through
  one — a shopfront the player could not see through was one the AI could see
  and shoot through. `CONFIG.graphics.glass.tint` is what keeps that honest, and
  it is why the number is judged from a pavement against a lit interior rather
  than picked for looks.

**A pane may RAKE, and a raked one may not break.** `Build.pane`'s `rotZ` tilts
a sheet out of vertical, and the case it exists for is a car's windscreen: a
cabin is a cabin because its glass leans, and upright it is a box on a box —
which is what `buildCar` was before it. The tilt lives on the MESH and
deliberately not on `PaneSpec`, because everything downstream of that spec
describes a sheet in a wall with six numbers and a yaw — the collider a
breakable pane spawns, the `WorldPane` the wire names it by, and
`GlassSystem`'s sweep, which tests a plane it assumes is upright. Any of the
three would stand a raked sheet silently back up, so the two options are
mutually exclusive and `Build.pane` throws on the pair in a dev build rather
than leaving it to be found. Glazing may lean; glass that BREAKS is a sheet in
a wall.

**The RAY TESTS are the cost only a breakable pane pays, and it pays them
because it has to.** A pane with a room behind it is the only thing in the way
while it stands, so it needs a collider that stops a body — which is why
`PaneSpec.breakable` spawns one rather than leaving it as a second decision. The
reason the flag has to stay rare is `MapBuilder.struts`'s header: 161 loose
collider boxes put ~17% on every ray in the game, `Player.probeGround` — already
the most expensive per-frame call at 2.45 ms (FINDINGS #6) — included. Six
thousand pickable boxes is not a trade, it is a regression. Twelve is nothing,
and the sweep that goes with them costs **~1 µs a shot** (twenty-four panes in
a handful of buckets; it was ~15 µs when every sheet on the map was a pane).

**What the enterable buildings cost is colliders, and that is the budget to
check before adding another.** A pick costs per MESH, so the whole solid set is
on the bill for every ray in the game; a tower is 3 boxes and an enterable
building is 35–50. Coldharbour's eight shophouses and two depots took it from
**425 solid meshes to 783**, measured A/B in one session at **+95% on every
ray** — the ground probe 91 → 180 µs and a 120 m shot 93 → 180 µs over a
196-ray spray, headless, so read the ratio and not the absolute. The ceiling that buys is Hollowmere's **863**, which is what
ships and what FINDINGS #6 was measured against — so this made the cheap map
dearer without moving the game's worst case. Check that number rather than the
building count.

**A pane that DOES break is sized like the thing that breaks, and the
elevation's own framing is what says how big that is.** `kit/city.ts` cuts the
shopfront into the bays its piers already divide it into: a break then reads as
one panel out of its frame with the piers either side still standing, where a
single sheet would take the whole frontage on one round. The second reason is
the shards: `DebrisSystem` cuts a burst of twelve pieces from the pane's own
face, so a pane much past ~20 m² is one the burst can only cover a patch of.
Measured over Coldharbour's twenty-four, the bays run **7.8–12.5 m²** — the
offices' 11.5 and 12.5, the shophouses' 7.8 and 11.6, the latter cut into one
bay or two by the unit's own width — which twelve pieces of about a metre
account for. The tower's bays are cut to the same rhythm for the look alone — nothing
holds a range into them and nothing ever will.

**Breaking a pane is five writes and one deferred rebuild.** The visual
range collapses; `solid` is cleared, which takes the box out of `SOLID_ONLY` and
`OPAQUE_ONLY` together; `checkCollisions` is cleared, which is the movement
half; `ObstacleField.remove` takes it out of the sub-cell push-out the bots and
the server's move validator both read; and `NavGrid.openBox` relinks the ground
it was severing and floods walkability into whatever that opened. All of that is
local and cheap.

**What is deferred is the flow fields, and they are the only expensive part.**
A field is a breadth-first sweep over every walkable surface; Coldharbour has
183k of them and seven fields, measured at **4.7 ms each and 15.9 ms for the
set** (headless, so inflated — the ranking is what to trust). `GlassSystem.update`
rebuilds ONE PER FRAME and every break inside that window folds into the same
pass. Bots keep steering on the field they have, which monotonicity guarantees
is stale rather than wrong.

Two contracts say the map never changes and both now say it changes in exactly
this one way: `ObstacleField`'s header, and `MapBuilder.build`'s note beside the
nav bake. Neither may grow at runtime and nothing may be added back.

Layout gotchas that have already cost time:

- **A blocking scatter prop's collider comes from `PROP_BODIES`, not from its
  `clearance`.** Clearance is a placement rule and generous on purpose; sizing the box
  from it gave every prop a square collider inflated by its own spacing margin — a
  0.24 m headstone stopped rounds through 1.2 m of air and a dead tree ate a 1.74 m
  corridor around a 0.7 m trunk. The box is oriented with the prop, which is the only
  thing that makes a fallen log or a headstone meaningful. Keep the numbers measured
  against `Props.ts`: too small costs a round clipping a silhouette, too large costs
  shots that visibly should have landed. Note `CreatePolyhedron`'s `size` is not a
  radius — `size: 0.8` is a 2.26 m boulder, the only prop sized *up*.
- A collider's top face must stay within `CONFIG.nav.stepHeight` (0.6) of the ground
  beside it, or the nav flood fill never reaches it and bots treat it as a wall. The
  boathouse and jetty decks both failed this at 0.62–0.73 m.
- A control point's `pos` must not be inside a collider, or `surfaceAt` returns -1
  there. Flag C was originally centred on the well. **A BLOCKING SCATTER REGION
  reaches a flag the same way and is much easier to miss**, because nothing in the
  layout says where its props will land: size and place one so its own radius plus
  the prop's half-length still clears the nearest flag centre. Measured on Greyfen —
  a log region centred 4.5 m off flag A dropped a 5.2 m trunk 0.53 m from the flag
  and made it uncapturable. Non-blocking props (ferns, brambles) carry no collider
  and may sit straight over a capture point.
- **Adding a placement rerolls every scatter region on the map.** `findSpot` draws
  from the shared stream once per *attempt*, accepted or rejected, and placements
  build before scatter — so a new building anywhere moves every belt and every
  dressing field, which is how the flag-A log above appeared from a change that
  never mentioned it. Re-walk the flags after touching either array.
- Ramps need `rotX` on the **collider**, not just the visual box, or the player
  walks into an invisible flat slab.
- A run of fence or dry-stone wall must be split wherever a road, ramp or gate
  crosses it. The nav graph honours thin walls (`severLinks`), so an unbroken run
  genuinely routes bots the long way round — or seals a plot outright. Enclosures like
  the burying ground need a gap of a couple of cells, and corners left open help more
  than a wider gate.
- **A fence is described twice — once for bodies, once for rounds — and both
  halves are load-bearing.** Its coarse box is `porous`: a body walks into it,
  stands on it and is routed around it, while nothing is ever stopped by the
  1.4 m of air the box also covers. Its posts and rails are `strut`s: a round,
  a sightline, a grenade and a blast fragment stop on the timber and nowhere
  else (see the collider section of `CLAUDE.md`). So a fence line is a
  *movement* decision when you author one — it costs a bot the walk around, and
  `CoverMap` bakes no cover from it, because a 0.18 m post is not something a
  body hides behind. Reach for the dry-stone wall when a run is meant to break
  a sightline, and expect open ground to stay a shooting gallery until
  something opaque stands in it.
