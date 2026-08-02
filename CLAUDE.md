# CLAUDE.md

Single source of truth for AI coding agents (and contributors) working in this
repository. `AGENTS.md` is a pointer to this file; `README.md` is user-facing.

## Project overview

**HOLLOWMERE — Cel-Shaded Conquest**: a browser-based, single-player Conquest
shooter (8v8 vs bots, five control points, ticket bleed) built with
**Babylon.js** + **TypeScript**, bundled with **Vite**. ES modules
(`"type": "module"`), Node 18+, WebGL2 browser required.

The game ships **zero audio files and (almost) zero model files** — every mesh
except one is built from Babylon primitives at runtime and all sound is
synthesized WebAudio (`src/core/Sfx.ts`). The single exception, added by
explicit request, is the **player's body**: a rigged GLB (`models/*.glb`)
driven by `src/entities/GlbSoldier.ts` (own locomotion clips + a procedural
bone overlay for aim/reload/rifle-carry). Bots and weapons stay primitive —
do not extend the GLB approach to them (rig pooling/merging rules still
apply), and do not add further asset files unless explicitly asked.

**Every source file has a contract header** at the top stating what it owns,
its invariants, and what it must never do. Read it before editing that file.

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run typecheck  # tsc --noEmit (strict, noUnusedLocals/Parameters)
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
```

There is no test suite and no linter. `npm run typecheck` is the only automated
gate — run it after any change.

### Manual/automated verification

Playwright + Chromium are devDeps for ad-hoc browser smoke tests; write throwaway
scripts to the scratchpad, not the repo. `Game`'s constructor exposes
`window.__celshock`, which is the handle those scripts drive. Headless quirks that
have already cost time:

- Headless SwiftShader renders this scene at ~2 fps, so a menu confirm must hold
  Enter across several frames to register.
- Forcing ADS by assigning `input.ads` or `cameraSys.adsBlend` does not stick —
  `InputManager.update()` rewrites the flag every tick and the blend decays.
  Redefine the property instead:
  `Object.defineProperty(g.input, "ads", { get: () => true, set: () => {} })`,
  then let `CameraSystem` converge.
- Recoil/spread numbers measured headless are wrong (fewer frames per shot means
  less spring-back between shots) — never tune from them.
- `dt` is clamped to 0.05, so at ~5 fps headless **game time runs at ~25% of wall
  clock**. Waiting for bots to walk across a 240 m map is not practical; force a
  skirmish by overriding `battle.spawnPointFor` instead. Rules-level things
  (capture times, bleed, ticket drain) are better driven directly by calling
  `conquest.update(1/60, fakeCombatants)` in a loop.
- `Game.updateGameplay` pushes HUD state every frame, so setting something like
  `hud.setScoreboard(true, ...)` by hand is overwritten on the next tick. Drive
  the input instead (`page.keyboard.down("Tab")`).
- Killing a spawned `npx vite` can leave an orphan holding the port; free it by
  PID from `ss -tlnp`. Never `pkill -f vite` — it matches the calling shell's own
  command line.

To inspect a model in isolation, drop a throwaway `modelviewer.html` + `.ts` at
the repo root (Vite serves it as a second page) with an `ArcRotateCamera` driven
by `camera.setPosition`.

## File tour

```
main.ts                     # Bootstrap
src/
  config.ts                 # ALL tunable constants (no magic numbers in code)
  core/
    Game.ts                 # Orchestrator + game state machine + main loop
    InputManager.ts         # Unified keyboard/mouse + gamepad state + rumble
    CameraSystem.ts         # Third-person shoulder cam; ADS pulls in + zooms
    Sfx.ts                  # Procedural WebAudio, spatialised and voice-capped
  entities/
    Player.ts               # Movement, sprint, jump, weapon state, body wiring
    GlbSoldier.ts           # Player body: rigged GLB (models/*.glb) + the
                            # procedural bone overlay (aim/reload/rifle carry)
    soldier/                # GlbSoldier's extracted pieces:
      tuning.ts             #   asset-measured constants + SoldierPoseParams
      matrixKit.ts          #   WorldChain memo + why-matrices rationale
      stance.ts             #   idle stance captured from the Walking clip
      clipDriver.ts         #   locomotion clip selection/crossfade/speed
    RifleModel.ts           # Low-poly SCAR-pattern rifle + holo sight builder
    Combatant.ts            # Team + the shared shootable/shooter interface
    Bot.ts                  # Bot FSM: advance / hunt / engage / takeCover /
                            #   suppressed / retreat / capture, + movement,
                            #   aim tracking, magazine, peek cycle
    BotMemory.ts            # One bot's decaying picture of the fight
    BotSkill.ts             # skill scalar -> BotProfile; difficulty tiers
    SoldierModel.ts         # Cheap merged bot rig + procedural animation
                            #   (walk cycle, aim pitch, torso twist, death)
  systems/
    BattleSystem.ts         # Bot pool, AI scheduling, LOS, distance LOD
    ConquestSystem.ts       # Flags, capture meters, tickets, bleed, spawns,
                            #   squad orders (planSquads) + defend posture
    CaptureZoneSystem.ts    # The flags drawn in the world: boundary ring,
                            #   proximity-revealed skirt, beacon
    CombatSystem.ts         # Hitscan + pooled tracers and sparks
    AimAssistSystem.ts      # Gamepad-only aim assist (slowdown + rotation)
    LightingSystem.ts       # Dynamic point lights: fixtures, flashes, lamps
    ShadowSystem.ts         # Moon shadow map (stepped shadows) + blob shadows
    Atmosphere.ts           # Drifting ash particle field
    Sky.ts                  # Generated sky dome (gradient/stars/halo), moon, clouds
    WaterSystem.ts          # Water surfaces from map WaterRects
  editor/                   # Dev-only map editor (F2). Dynamically imported —
    index.ts                #   never statically imported from anywhere else,
    EditorCamera.ts         #   or it lands in the production bundle.
    EditorPanel.ts          #   Free-fly cam drives CameraSystem's own camera.
    workLight.ts            #   Brightened EnvironmentSpec for authoring.
    selection.ts            #   SelectionRef, predicate pick, highlight
    proxies.ts              #   Stand-ins for flags/spawns/scatter/water/grass
    gizmos.ts               #   Move + Y-rotate handles, snapping
    mutate.ts               #   Layout writes: transform, fields, add/delete
    fields.ts               #   FieldSpec + the key conventions the inspector,
                            #   the panel and mutate all have to agree on
    inspect.ts / params.ts  #   Inspector read model + per-kind param table
    sourceScan.ts           #   layout.ts as text: regions, entries, tokens
    terrainBrush.ts         #   Terrain mode: hover highlight + sculpt stroke
    serialize.ts / save.ts  #   Minimal-diff emit + POST to the dev server
    tuning.ts               #   Tool constants (NOT config.ts — not gameplay).
  world/
    layout.ts               # Placement/ScatterSpec/Heightfield/MapLayout —
                            # the map-data vocabulary, map-agnostic
    TerrainField.ts         # The floor's height, and the ONLY place that knows
                            # it: heightfield -> heightAt() + the per-block
                            # VertexData MapBuilder hangs ground meshes on,
                            # plus terrainSlab() which bends a road onto it
    rng.ts                  # mulberry32 — the seeded PRNG world-building uses
    MapBuilder.ts           # Builds the map; merges visuals, emits colliders
    BuildingKit.ts          # Facade: shared types + BUILDERS registry
    kit/
      core.ts               # Build accumulator, palette, builder contract
      buildings.ts          # cottage, townhouse, tavern, smithy, ruin,
                            # watchtower, chapel, barn, mill, boathouse,
                            # gatehouse
      structures.ts         # silo, well, stall, fence, stoneWall, bridge,
                            # haystack, lamp, cart, crates, woodpile, shed,
                            # trough, shrine, kiln
      terrain.ts            # terrace, ramp, road, jetty
    NavGrid.ts              # Walkable-surface graph + precomputed flow fields
    CoverMap.ts             # Baked per-surface directional cover masks
    boxGeometry.ts          # The analytic WorldBox primitives, shared by
                            #   NavGrid / ObstacleField / CoverMap
    ObstacleField.ts        # Sub-cell collision push-out for thin props
    Props.ts                # Scatter props: trees, graves, rubble, braziers,
                            # boulders, brambles, barrels
    textures.ts             # Generated canvas textures (cobblestone etc.)
    environment.ts          # EnvironmentSpec + applyEnvironment
    hollowmere/
      layout.ts             # THE MAP — every placement, flag and spawn
      heights.ts            # GENERATED floor heights (editor terrain mode)
      environment.ts        # Hollowmere's palette, fog, mist, particles
  ui/
    HUD.ts                  # DOM overlay: tickets, flags, capture-zone panel,
                            # killfeed, scoreboard, world-anchored damage arcs
    DeployScreen.ts         # Clickable top-down deploy map
    Minimap.ts              # Corner minimap: flags, friendlies, firing enemies
  shaders/
    CelShader.ts            # Custom cel ShaderMaterial + outline helper
    WaterShader.ts          # Animated water ShaderMaterial
    HorrorPost.ts           # Vignette / grain / aberration / damage flash pass
```

## Architecture

### Ownership and wiring

`src/core/Game.ts` is the only place systems meet. Systems never import each
other; `Game` wires them with callbacks (`battle.onBotKilled/onBotFired`,
`conquest.onCaptured/onNeutralised`, `player.onDamaged`, `deployScreen.onDeploy`)
and hands bot AI a `BattleCtx` (in `entities/Bot.ts`) built once and read through
to `BattleSystem` rather than rebuilt per frame. New cross-system behavior
belongs in that wiring, not in an import between systems.

`Game`'s state machine is `menu -> deploy -> playing`, with `deploy` re-entered
on every death and `roundover` when a side runs out of tickets. The 3D scene
renders in every state, which is what lets the deploy screen and the menu sit
over a live view.

`Game.updateGameplay` has a load-bearing order at the end of the frame: camera
update → `mats.updateCamera()` → carried-light updates → `lighting.update(dt,
camera.position, mats)` → `sfx.setListener()`. Light slot selection, shader fog,
and audio panning all key off the camera position, so anything that moves the
camera must run before them.

`ConquestSystem.update` runs *before* `BattleSystem.update`, so a bot's think
tick sees this frame's flag ownership rather than last frame's.

### The scene has (almost) no Babylon lights

Cel materials carry their own `lightDir`/`lightColor`/`ambientColor` and
a packed array of up to `MAX_POINT_LIGHTS` (16) point lights as uniforms;
`LightingSystem` is the sole owner of dynamic light and uploads the winning slots
via `CelMaterialFactory.setPointLights()` once per frame. Adding a
`PointLight`/`HemisphericLight` to the scene will not affect any cel-shaded mesh.
Effect meshes (tracers, sparks, neon, reticles) use unlit emissive
`StandardMaterial`s from `mats.getEmissive()` and are unaffected by lighting
entirely.

The one exception is `ShadowSystem`'s `DirectionalLight`, which no material
reads — it exists only to define the shadow camera for its `ShadowGenerator`.
The cel fragment shader samples that depth map as a hard two-level term gating
the key light. The shadow window follows the player (texel-snapped, re-rendered
only when the snapped focus moves), casters are the map's merged static meshes
re-registered every round via `shadows.setCasters(map.visuals)` (skip anything
flat with `metadata.noShadowCaster`), and characters get blob-shadow discs
instead of casting — the rigs are far too many meshes for the depth pass.

Lights come in three flavors: static fixtures (`lighting.add()`, registered by
`MapBuilder` from a builder's `LocalLight` list or a scatter prop's entry in
`SCATTER_LIGHTS`), transient pulses (`lighting.pulse()` — muzzle flash), and
carried lights (`setCarried()`/`removeCarried()` — the player's shoulder lamp).
Transient and carried lights always get a slot; static fixtures compete
nearest-first.

**That is why bot muzzle flashes are budgeted.** 16 bots firing would take all 16
slots with transients and black out the village's own lanterns, so
`BattleSystem` only records flash positions and `Game.spendMuzzleLightBudget`
spends `CONFIG.lighting.muzzleBudgetPerFrame` on the nearest few. Adding any new
per-bot transient light needs the same treatment.

### The map is data, not code

`src/world/hollowmere/layout.ts` is the entire level: a list of placements
(`{ kind, x, z, rotY, params }`), scatter regions, control points, spawns, and
the water/grass/terrain rects. `BuildingKit` supplies the parametric pieces and
`MapBuilder` consumes the layout; neither special-cases Hollowmere, so **a
second map is one new layout file plus an `EnvironmentSpec`**. The vocabulary
those files are written in (`Placement`, `ScatterSpec`, `TerrainRect`,
`MapLayout`) lives in `src/world/layout.ts`, not beside Hollowmere's data — a new
map must not import its types from its predecessor. `MapBuilder.build(layout,
env)` takes both as arguments for the same reason.

**The floor is a height field, not a flat plane.** A `Heightfield` in the layout
feeds a `TerrainField` (`src/world/TerrainField.ts`), and that field is the one
place the ground's height is decided. It used to be the literal number `0`,
asserted independently in `MapBuilder.buildValley`, `NavGrid.rasterize`,
`Player.probeGround`, `ShadowSystem.groundYUnder` and `GrassSystem` — five
hardcodings of the same constant, which is why the floor could not be anything
but level. The grid is 80x80 cells of 3 m, sampled bilinearly, and it is
authored with the editor's terrain mode rather than written by hand.

**The heights live in their own generated file** (`hollowmere/heights.ts`),
imported by the layout. That split is the point: `layout.ts` is authored — an
ASCII village map, district commentary, `BANK_H`/`TERRACE_H` in place of bare
numbers — and the editor patches it one line at a time to preserve all of that.
Several thousand bare numbers would drown it. `heights.ts` is the opposite: pure
generated data with nothing to preserve, so it is rewritten wholesale, one grid
row per line so a diff shows which strips of the map moved.

Two rules follow, and both are load-bearing:

- **`Placement.y`, `ScatterSpec.y` and `GrassRect.y` are offsets above the local
  floor**, not absolute heights, so dressing rides the ground when it moves.
  Control points and spawns stay absolute — the editor snaps their height to the
  nav surface for you. A `WaterRect` with no `y` floats `CONFIG.water.surfaceY`
  above **its own bed**, which is what makes a pool read as recessed instead of
  hovering: Hollowmere's bog bed is at -0.6 and its surface lands at -0.28,
  below the bank around it.
- **`NavGrid.link` is the slope limit.** It links neighbouring surfaces only
  within `stepHeight`, so at `cellSize` 1.5 a bank is walkable up to a gradient
  of 0.4 (~22 deg) and severs itself above that — `MAX_WALKABLE_GRADE`. On a 3 m
  terrain cell that is a 1.2 m single-cell step. Nothing else enforces it: the
  brush reports the gradient under the cursor live, and `validate.ts` scans every
  grid edge for it.

The terrain mesh is one quad per cell, emitted per 48 m block, with two fast
paths that keep a mostly-level map cheap: a map with no heightfield at all is a
single quad — the same two triangles the old flat ground box drew — and a block
whose vertices are all one height collapses to a quad too. Hollowmere is 25
blocks and **3,110 triangles**, because only the four holding the pools carry
real geometry.

**A road is re-cut against that mesh, and the how is load-bearing.** One height
sample at a placement's centre is right for a cottage and wrong for a 130 m
street, which used to float at one end and bury itself at the other, so
`terrainSlab` (in `TerrainField.ts`) tessellates the slab to follow the ground.
It is a builder reading `BuildCtx` — where MapBuilder is about to put it — and
still returning origin-local geometry, so the merge is unaffected. Three things
make it work, and undoing any of them puts black holes in the cobbles:

- **It samples `surfaceAt`, not `heightAt`.** The floor is *drawn* as flat
  triangles across a bilinear field; the two differ by up to a quarter of a
  cell's twist. Follow the smooth field and the road sinks under the mesh on
  every twisted cell — and the symptom is not a sunken road, it is the road's
  own outline shell showing through as black blobs, because the shell passes the
  depth test where the surface it belongs to does not.
- **Its cuts are the terrain's own grid lines, and nothing between them.** A
  slab quad then coincides with a terrain quad, corner for corner, and the two
  cannot cross. Subdividing finer is strictly *worse*: a mid-cell sample lands on
  the wrong side of the terrain's diagonal. `surfaceAt(x, z, true)` — the upper
  envelope of the cell's two triangle planes — covers the samples that can't be
  on a grid line (the road's own edges); being convex, a triangle drawn between
  three of its samples is guaranteed to clear the floor.
- **An odd quarter turn flips the diagonal.** `rotY = ±π/2` maps the local
  diagonal onto the world *anti*-diagonal, so the road would split every cell
  the opposite way from the ground it lies on. The quad starts one corner along
  in that case.

A road over level ground still collapses to the single box it always was —
`terrainSlab` returns null — so on the shipped map this costs exactly nothing:
the two merged road meshes are still 108 and 96 triangles.

Only `road` does this (`CONFORMS_TO_TERRAIN` in `BuildingKit.ts`). `terrace`,
`ramp`, `jetty` and `bridge` carry walkable box colliders, and bending only
their visuals would put the surface you see out of agreement with the surface
bullets spark off.

**Babylon defaults to a LEFT-handed system** (`scene.useRightHandedSystem` is
false), so a front face is *clockwise* seen from the front. Hand-built
`VertexData` wound the right-handed way — the order you get if you work the
cross product out on paper — fails in the worst possible manner: the meshes
build, the shaders compile, the console is clean, nav and picking are unaffected
(Babylon's triangle picking is two-sided), and the only symptom is that
`ComputeNormals` derives downward normals, so the floor is back-face culled and
lit from below. The world looks like it has no ground at all, and every number
you can check still reads correct. `assertFacesUp` throws on it in dev builds;
if you touch the winding, trust that over your own derivation. It is emitted **per 48 m block**,
and each block gets an invisible clone marked `solid`. That clone is the one
place a collider shares a visual's vertices: a heightfield has no box to stand in
for it, so `MapBuilder.collider()` (which exists to record `WorldBox`es) is
deliberately bypassed and `NavGrid` reads the field directly. The block split is
not just for culling — `CameraSystem` picks every frame and `CombatSystem` every
shot, and one map-wide floor mesh would defeat bounding-box rejection.

**Scatter placement is seeded** (`layout.seed`, via `src/world/rng.ts`). This is
not cosmetic: blocking scatter emits colliders, colliders feed `NavGrid` and
`ObstacleField`, so an unseeded scatter means the navigation graph differs
between page loads and a bot wedged on a boulder is only reproducible on some
boots. Never call `Math.random()` in world-building code. Changing the seed
rerolls the whole dressing field, which is a visible change to the level.

Builders assemble geometry **at the origin, unrotated**, and return three
parallel lists (`meshes`, `colliders`, `lights`) in local space. `MapBuilder`
merges the meshes per colour and then transforms all three into place. Building
at identity is what makes the merge safe — `MergeMeshes` bakes world matrices and
returns an identity-transform mesh, the same trick `RifleModel.buildRifle` uses.

A **second merge pass** (`BlockMerge`) then collapses neighbouring structures
and scatter fields into one mesh per (48 m map block, material). The village is
~230 structures and the outline pass draws every mesh twice, so without it the
map alone costs ~670 draws; with it, ~150, and frustum culling still throws away
most of the map because a block is well inside the 78 m fog wall. Merging across
placements is safe for the same reason it is safe within one, and outlines still
trace each building because `renderOutline` expands vertices along their own
normals.

Layout gotchas that have already cost time:

- **A blocking scatter prop's collider comes from `PROP_BODIES`, not from its
  `clearance`.** Clearance is a placement rule and is generous on purpose;
  sizing the box from it gave every prop a square collider inflated by its own
  spacing margin — a 0.24 m headstone stopped rounds through 1.2 m of air and a
  dead tree ate a 1.74 m corridor around a 0.7 m trunk. The box is oriented with
  the prop, which is the only thing that makes a fallen log or a headstone
  meaningful. Keep the numbers measured against `Props.ts`: too small costs a
  round clipping a silhouette, too large costs shots that visibly should have
  landed. Note `CreatePolyhedron`'s `size` is not a radius — `size: 0.8` is a
  2.26 m boulder, which is why that one is the only prop sized *up*.
- A collider's top face must stay within `CONFIG.nav.stepHeight` (0.6) of the
  ground beside it, or the nav flood fill never reaches it and bots treat it as a
  wall. The boathouse and jetty decks both failed this at 0.62–0.73 m.
- A control point's `pos` must not be inside a collider, or `surfaceAt` returns
  -1 there. Flag C was originally centred on the well.
- Ramps need `rotX` on the **collider**, not just the visual box, or the player
  walks into an invisible flat slab.
- A run of fence or dry-stone wall must be split wherever a road, ramp or gate
  crosses it. The nav graph honours thin walls (`severLinks`), so an unbroken
  run genuinely routes bots the long way round — or seals a plot outright.
  Enclosures like the burying ground need a gap of a couple of cells, and the
  corners left open help more than a wider gate.
- A `road` may cross a bank, and is the **one placement whose geometry is a
  function of the ground under it** — see below. Everything else is still lifted
  rigidly by one height sample at its own centre, which is right for a building
  and would be wrong for 130 m of street.

### The map editor (dev only)

`F2` in a dev build opens `src/editor/` — free-fly the real scene, click to
select, drag gizmos, edit properties, add and delete entries. Everything under
`src/editor/` is reached through **one dynamic `import()` inside a
`import.meta.env.DEV` branch in `Game.toggleEditor`**, and the *whole method
body* is behind that gate, not just the keybind. That is what makes the import
unreachable under `vite build` so Rollup drops the chunk instead of emitting an
orphan. Never import `src/editor/` statically from anywhere.

Things it deliberately does not do:

- **It does not make visuals pickable.** Babylon skips the `isPickable` test
  when a pick supplies a predicate, so the editor picks on
  `metadata.editorRef` and the visual/collider table below stands unchanged.
- **It does not build colliders.** Proxy meshes for flags, spawns, scatter
  regions and water/grass/terrain rects are visual only, and never enter
  `colliderBoxes` — `MapBuilder.collider()` is still the sole collider factory.
- **It does not re-run builders to move things.** A builder assembles at the
  origin and `MapBuilder` transforms the result, so `repositionItem()` moves the
  visuals, the collider proxies and the `WorldBox`es directly.

**There are two pointer modes, and that is the fix for a real problem rather
than a flourish.** `T` toggles terrain mode; the panel turns violet, because a
mode you forget you are in makes every click feel broken. The ground is *under*
everything, so a terrain annotation is a flat sheet competing for the same click
as the water rect, the grass rect and the jetty standing on it — whichever
happens to be on top wins and the rest become unselectable. A mode settles it by
construction: in terrain mode only the ground answers, and in object mode terrain
is not in the pick at all.

In terrain mode the cursor highlights the grid cells it covers, `[`/`]` resize
the brush, and the left button draws with one of **two tools**, swapped with `F`:

- **sculpt** — drag up or down to raise or lower the cells under a brush that
  stays where it was pressed.
- **level** — the click samples the height under it, and from then on the brush
  paints, pulling everything it is dragged over to that one height. Free-hand
  sculpting cannot produce a flat basin floor or a pad that meets the ground
  around it: every pass lands somewhere slightly different, and the nav grid's
  slope limit and a building's footings are exactly what "slightly different"
  ruins.

Both apply a linear falloff from the inner half outward. A hard-edged brush
would make a cliff on its first click, which the nav graph then refuses to walk
across; for the level tool the same falloff is what blends a levelled pad into
the ground around it. The status line shows the steepest gradient under the
cursor against `MAX_WALKABLE_GRADE` and turns red past it, and names the armed
tool — which also recolours the brush and the panel, for the same reason the
mode itself does.

A stroke is **absolute, not incremental**: the affected vertices are snapshotted
when the drag starts and every mouse move re-derives from that snapshot, so the
result cannot depend on frame rate or mouse speed. Painting makes the same rule
do more work — a vertex remembers the height it had when the stroke *first*
touched it and the *strongest* weight any pass has given it, so dragging back
and forth over the same ground settles instead of creeping toward the target one
pass at a time. Pointer moves are sampled rather than continuous, so the gap
between two of them is filled in with stamps half a brush apart; without that a
quick drag leaves a dotted line of untouched cells, which on a level stroke is
precisely the "nearly flat" it exists to eliminate.

During the stroke only the floor's *visual* blocks are re-tessellated
(`TerrainBrush.reapply`, sub-ms); colliders, navigation and everything whose `y`
rides the ground are stale until release, which schedules the ordinary debounced
geometry rebuild. That split is the whole reason it feels immediate — nothing
walks on the ground mid-drag. It is also why the brush picks against the floor's
**visual** blocks rather than its `solid` collider clones: the two carry the same
vertices except mid-stroke, and a painting brush that followed the stale collider
would drift away from the ground being levelled under it.

**Proxies and gizmos work in world space; the layout stores heights above the
local floor.** `originOf` adds the terrain height and `applyTransform` subtracts
it again, so a rect in a basin draws where it actually is and a round-trip drag
writes back the same relative offset it started with. Getting this wrong is not
subtle: a translucent proxy sheet left at the raw layout `y` hangs over a dug
basin and washes the whole thing flat, which reads as the ground having
disappeared. `waterY()` lives in `TerrainField.ts` for the same reason — it is
shared by `WaterSystem` and the proxy so the two cannot disagree.

**Three rebuild tiers, and which one you owe is decided by what changed.**
Measured: a full editor build is ~570 ms, `NavGrid` + all 7 flow fields ~45 ms,
one builder call ~0.9 ms.

| change | tier | cost |
| --- | --- | --- |
| dragging a gizmo | move that item's meshes and `WorldBox`es | sub-ms, every frame |
| drag released, flag/spawn edited | `NavGrid` + 7 flow fields + `ObstacleField` | ~45 ms |
| param, kind, add, delete, brush stroke released, **road drag released** | `Game.buildEditorMap()` — the whole map | ~570 ms |

The third tier is not laziness. Changing a param changes how many colliders an
item emits, which shifts every later index in `colliderBoxes` and invalidates
the per-item editor index wholesale; there is no correct patch, only a rebuild.
A road earns it for a different reason: its vertices were cut against the ground
it started on, so a translate leaves it contoured to the wrong patch of floor —
the one thing tier 1 cannot fix. `CONFORMS_TO_TERRAIN` is the list.
It is debounced by `EDITOR.rebuildDelay` so holding a spinner does not queue
thirty builds, and *not* debounced for add/delete, which are single deliberate
actions. Anything the editor holds that points at geometry — the highlight, the
gizmo anchor, the selection — is re-derived after it rather than patched.

**A `SelectionRef` is a list plus an index, so deleting invalidates every ref
after it in that list.** The editor drops its selection on delete rather than
trying to fix them up; the same reasoning is why `applyStructural` runs the
rebuild immediately instead of leaving stale indices addressable.

Property editing is driven by three files that must agree on what a field key
means: `fields.ts` declares the vocabulary (dotted paths like `params.width`,
plus the two compound keys `kind` and `owner` that write more than one field),
`inspect.ts` produces the controls, `mutate.setField` applies them. Two rules
there keep the layout terse: **a value equal to the builder's own default is
removed, not written**, and absent-means-default fields (`y`, `rotY`,
`blocking`, `clearance`, `density`, `scale`) disappear when cleared rather than
being written as an explicit zero. Angles are edited in degrees and stored in
radians so `Math.PI / 2` survives — see `qAngle`.

**Saving (`Ctrl+S`) patches `layout.ts`'s text; it does not regenerate it.**
The file is authored — the ASCII village map, the district commentary, and
`BANK_H`/`TERRACE_H`/`WARDEN`/`BLIGHT` in place of bare numbers would all die on
the first save of a code generator. So the source is authoritative and the
editor rewrites only the lines that changed:

- An entry nobody touched is re-emitted **byte for byte**. A no-op save is
  verified to reproduce the file exactly.
- An edited entry is rebuilt field by field, and each field still equal to what
  was loaded re-emits its **original source token** — which is how `TERRACE_H`
  and `Math.PI / 2` survive on a line that was rewritten. Comparison is against
  a deep snapshot taken when the editor opened, so nothing here ever has to
  evaluate those expressions.
- A **deleted** entry's line goes with it and nothing around it moves; an
  **added** entry is written fresh at the end of its array, which is where the
  editor appended it too.

Add and delete work because entries are matched to source lines by **object
identity**, not by position — a `WeakMap` from the live layout entry to
`{ line, values }`, bound when the editor opens and rebound after each save
(`Baseline` in `serialize.ts`). Positional matching would go wrong the instant
anything ahead of an entry was deleted. Rebinding after a save is also what
lets an entry added earlier in the session be edited again: it now has a line
of its own, so the second save rewrites it instead of appending a duplicate.

Gizmo output is quantised before it reaches the layout (`mutate.ts`), and
positions and angles are quantised **differently** on purpose. Positions round
to 3 dp, matching what the serializer writes. Angles must not: `Math.PI / 2`
rounded to `1.571` is no longer a quarter turn to within the emitter's
tolerance, so it would be written as a bare decimal and the file would drift
off house style. Angles instead snap to the exact quarter turn when they are
within a whisker of one, and keep 6 dp otherwise. Both then treat "close
enough to zero" as zero, so a drag that returns something to where it started
leaves no trace — without that, an un-rotated building picked up a redundant
`rotY: 0`, because `1e-17 !== 0` survives the drop-optional-field test and then
prints as `0`.

This rests on two properties of `layout.ts` that `sourceScan.ts` re-checks
every session: **every array entry is exactly one line**, and each array is
delimited by its own `const name: Type = [` … `];`. Those declarations are the
region anchors, so the file needs no marker comments. A line that fails to
tokenize becomes `opaque` and is never rewritten — the failure mode is always
"leave it alone". Multi-line entries are the one thing that would break this;
if you add one by hand, the editor will treat it as a comment and refuse to
touch it rather than corrupt it.

**The validation list ranks honestly, and the ranking is the design.** Errors
are things that are definitely broken and are zero on a healthy map: a control
point whose centre is not standable (the Flag-C-on-the-well bug), and a flag or
spawn unreachable from a home spawn. Warnings need a human: the biggest is
"standable ground nothing can reach", which is *also* how a roof looks, and how
the top of a boulder looks. `validate.ts` filters both out — roofs by height
above adjacent walkable ground, prop stands by flatness — but the nav grid
cannot distinguish a boathouse deck from a large flat collider top, so a
handful survive on Hollowmere while it plays perfectly well. Read that number
as a **delta**: note it, move a wall, look again. `makeIslandTest` is shared
with the overlay so the red cells on screen are exactly the reported findings.

That flatness filter is also why terrain is checked directly by `terrainGrade`
rather than left to `islands()`. A sculpting brush is a machine for producing
unreachable ground, but a flat pit floor looks exactly like the top of a boulder
to the island heuristic, so the one finding worth having is the one it
suppresses. `terrainGrade` scans every edge of the height grid against
`MAX_WALKABLE_GRADE` instead, and reports a count with the worst offender's
location — one finding per cell would bury everything else, since a single
stroke can steepen hundreds at once.

The `structure()` checks exist only because entries can be deleted: a duplicate
flag id silently merges two flags' flow fields (they are keyed by id), a spawn
naming a flag that no longer exists is skipped by `ConquestSystem` without
saying so, and a team with no home spawn deploys at the origin. None of these
can happen by dragging something, and all of them are errors.

**There is no undo.** The escape hatch is that leaving the editor rebuilds from
the layout module, so F2 (which asks first when there are unsaved edits) throws
away everything since the last save. Deleting the wrong building costs you the
work since that save, not the file.

`vite.config.ts` holds the dev-only write endpoint. It is deliberately outside
`tsconfig.json`'s `include` (`@types/node` is not installed), so it stays
trivial and the real logic lives in `src/editor/serialize.ts` under the
typecheck. Its `handleHotUpdate` swallows the editor's own writes: `layout.ts`
has no `import.meta.hot.accept`, so an update would propagate to `main.ts`,
find no accepting module, and full-reload the page on every save.

`build(layout, env, { editor: true })` skips `BlockMerge` so each placement
keeps its own meshes — ~1740 draws against ~150. **Never judge frame cost from
the editor.** Roads also go un-outlined there: in play they merge into one mesh
first, and kept separate each road's outline shell paints a black patch over
every junction it overlaps.

### Visual meshes and collider proxies are separate things

The single most load-bearing rule in the world layer. Every ray test filters on
`metadata.solid === true` — `CameraSystem`'s occlusion pick (every frame),
`CombatSystem`'s hitscan (every shot), `BattleSystem`'s line-of-sight, and
`Player.probeGround` — and `moveWithCollisions` walks every mesh with
`checkCollisions`. At village scale, visual geometry must stay out of both.

| Kind         | visible | pickable | collides | `solid` | merged | frozen |
| ------------ | ------- | -------- | -------- | ------- | ------ | ------ |
| **Visual**   | yes     | **no**   | **no**   | —       | yes    | yes    |
| **Collider** | **no**  | yes      | yes      | yes     | no     | yes    |

Colliders must line up with the surfaces they stand in for or bullet sparks land
off the visible geometry. `MapBuilder.collider()` is the only place that creates
them, and it also records a `WorldBox` for the nav grid — geometry added by any
other path is invisible to navigation.

**The floor is the one documented exception**, and it proves the rule rather than
bending it: the terrain heightfield has no box that could stand in for it, so
each block's collider is an invisible *clone of the visual's vertex data* — same
shape, still two separate meshes, still only the clone marked `solid`. It emits
no `WorldBox` (there is no box to emit) and `NavGrid` reads `TerrainField`
directly instead. It is also the only `solid` mesh with `checkCollisions = false`:
`moveWithCollisions` is horizontal-only, vertical placement is the ground probe's
job, and bots never touch the collidable list at all.

### Mesh metadata is a contract

Four flags, all read elsewhere; new geometry that omits them misbehaves silently:

- `solid: true` — collider proxies only (see above). Unmarked geometry is shot
  through, seen through, and walked through.
- `noOutline: true` — skipped by `addOutline()`. Every emissive part (eyes,
  flames, signs, reticle) needs it. Outlines are coloured ink (a darkened take
  on the mesh's own cel colour) thinned with distance by `updateOutlineScales()`.
- `noGlow: true` — excluded from the `GlowLayer` in the `Game` constructor. Only
  meshes existing at construction time are scanned.
- `noShadowCaster: true` — excluded from `ShadowSystem.setCasters()`. Flat
  receivers (ground, roads) need it: casting from them is pure shadow acne.

### Navigation

`NavGrid` is built from the finished collider set at map load. The graph node is
a **surface** — a (cell, height) pair — not a cell, because one cell can hold the
creek floor and the bridge deck above it, or the barn floor and its hayloft.
`MAX_SURFACES` is 3.

Every cell's *base* surface comes from `TerrainField.heightAt` at the cell
centre. This was a hardcoded `0`, and that constant — applied before any collider
was read — is what made the floor unable to be anything but flat: a free surface
at zero in every cell overrode anything trying to dig below it. Heights above the
base come from evaluating each collider's top-face *plane* at the cell centre,
not from its bounding box. That is deliberate: a pitched ramp's AABB reports its
peak across the whole footprint and would read as a wall. If you touch
`topFaceHeight`, note that the half-thickness is `h/2/cos(rotX)` and the slope is
`tan(rotX)` — writing it as `h/2*cos` and `-tan` is the easy sign error, and it
silently makes every ramp unwalkable.

`heights` is `.fill(-1)` to pad the slots no surface uses, but that is **not** a
"below ground" sentinel — every read walks `counts[cell]`, which is what lets
sunken terrain hold ordinary negative heights. Any new consumer must bound on
`counts` rather than testing `y < 0`.

Reachability is a flood fill from the map's outer ring. That is what keeps bots
off rooftops: a roof is a perfectly good standable surface, but nothing beside it
is within a step, so it is never reached. It also assumes that ring is open
ground, which is why a terrain patch putting a *wall* edge out at the ridge is
flagged.

**A link is cut when the segment between two cell centres crosses a solid box**
(`severLinks`). Sampling one column per cell centre means a wall thinner than a
cell — every fence, dry-stone field wall, ruin wall and gravestone — can sit
*between* centres, leaving the cells either side both standable and linked. The
flow field then points straight through the wall and the bot walks into it for
the rest of the round; `ObstacleField` keeps the body out of the stone but
cannot change where the field says to go. Testing the segment rather than
blocking whole cells is what keeps the 1.6 m cottage doorways passable. A box
only counts as a barrier where it stands more than `stepHeight` above both ends
of the link, so decks, kerbs and the terrace's own top face don't cut the links
leading onto themselves.

One flow field per objective (5 flags + 2 home spawns) is precomputed at load;
the map is static so nothing is ever recomputed. Bots read `nav.steer()` and
never run their own pathfinding.

**Bots do not use `moveWithCollisions`.** A cell being walkable *is* the
collision test, and it already accounts for headroom and step height; 16 agents
walking the collidable mesh list every frame would not be affordable.

**The grid is too coarse to be the whole collision test, though.** It samples
one column per cell *centre*, so a collider narrower than 1.5 m — every
scattered tree (1.1 m), gravestone, and fire drum — can sit between centres and
leave every cell around it walkable. `ObstacleField` (`world/ObstacleField.ts`)
is the sub-cell half: collider boxes bucketed at load, queried per step to push
a body clear of anything it overlaps. `Bot.stepTo` consults it, then asks the
grid; `Bot.tryMove` retries each axis alone so a blocked step slides instead of
freezing. Two rules keep the push-out from causing the problem it fixes:

- It is a *preference*, never a veto — if the pushed-clear spot is somewhere the
  graph rejects, the bot takes the overlapping one. Frozen is worse than
  clipping.
- Two fruitless sidesteps in a row set `squeezeT`, which drops the push-out
  entirely for a second, so a bot wedged in a gap narrower than its own body
  gets out instead of standing there for the rest of the round.

This is why bots being stuck in props also made them unshootable:
`CombatSystem.fire` caps a shot at the first `solid` hit and only counts a
target sphere closer than that, so the prop ate every round aimed at the body
inside it. The two symptoms are one bug.

### Bot scaling

Three things carry the frame budget, and undoing any of them costs ~10× draw
calls or a permanent hitch:

- **The rig pool is built once and never disposed.** Death hides a rig, respawn
  re-poses it. `new Bot()` allocates a dozen meshes and their GL buffers, and
  Conquest respawns continuously.
- **Bot rigs are nine merged meshes** (`SoldierModel`), against ~60 for the
  player's. The outline pass draws everything twice, so fidelity is ~2× draw
  calls per bot per mesh. The player keeps the detailed rig because it is the
  only character always on screen — do not "unify" the two.
- **AI is staggered at `CONFIG.bots.thinkRate`**, round-robin across frames.
  `acquire()` gathers candidates by distance and ray-tests them in ascending
  order, returning the first visible one — testing all of them fires up to 30
  picks per think. Two things keep that honest: the view cone rejects most
  candidates *before* any ray, and `CONFIG.bots.acquireRayBudget` caps how many
  survivors get tested. A dead bot must also not consume a think slot, or the
  living half of a roster thinks at half the advertised rate.

Bots hold a target until it dies, breaks LOS, or leaves range. Without that
hysteresis, "nearest visible enemy" flips every tick in a crowd, which resets
`aimT` and means bots essentially never finish their reaction wind-up and fire.
This looked exactly like "bots don't shoot" and is worth remembering. It is also
why losing a target does not simply null it: `BotMemory.lastAimed` outlives
`target`, and re-acquiring the same enemy resumes at `profile.reacquireDelay`
instead of from zero.

### Bot perception, cover and skill

**Everything a bot notices without seeing it is ray-free by construction**, and
that is the constraint the whole design hangs off — the LOS budget is the one
thing here that does not scale.

- **Field of view.** `acquire()` gates on a cone around `Bot.facing` before it
  ray-tests. Bots used to see 360° instantly out to 55 m. Two exemptions:
  `peripheralRange`, and a widened cone while a threat cue is live. It gates
  *acquisition* only — a bot faces its target once it has one, so you can flank
  an unaware bot, never a fighting one.
- **Damage direction is free and was being thrown away.** `CombatSystem.fire`
  has always passed the shooter's origin into `takeDamage`; `Bot` ignored it.
- **Hearing** is a squared-distance sweep inside `BattleSystem.botFire`, with a
  jittered position so bots converge on the *sound*, not the shooter. `Game`
  calls `hearGunshot` for the player's own fire.
- **Near misses** ride the target loop `CombatSystem.fire` already runs: one
  extra sphere test at `hitRadius + suppressRadius`, reported via `onNearMiss`.
- **Lost line of sight costs no ray either.** `fire()` already pays for a wall
  pick; a run of `losBrokenShots` blocked rounds drops the target.

**Cover is baked, never probed** (`world/CoverMap.ts`): one bit per direction
per surface, 16 directions, two masks. The map is static, so this is the same
reasoning that makes `NavGrid` bake seven flow fields. The runtime cost of a
cover query is a bit test. Three rules:

- **Hard cover is 1.7 m — the hit sphere's top, not the 1.55 m eye height.** LOS
  is tested from the eyes but hits are tested against the sphere
  (`center.y + hitRadius` = 1.65). Bake at eye height and a bot behind a 1.6 m
  wall is *visible but unhittable*, which reads as broken netcode.
- **Soft cover (0.9 m) is a steering preference and nothing else.** The rig has
  seven joints and no knees, so there is no crouch: a bot behind a waist-high
  wall is exactly as shootable as one in the open. **Cover here means corners.**
- **It is a preference, not a commitment** — the same rule as `ObstacleField`'s
  push-out. A spot not reached within `cover.abandonTime` is dropped, and a
  cooldown stops the search instantly re-picking it. A bot moving to cover still
  shoots; only the tucked-in half of the peek cycle holds fire. Both of those
  were learned the hard way: without them bots walked into walls holding fire
  for the whole round.

### Squads and movement texture

**Squad orders are planned as a group** (`ConquestSystem.planSquads`), on their
own 2 Hz timer rather than per bot per think. What it replaces was
`ranked[squad % ranked.length]`: squad N took the Nth-best flag, so a team with
two squads only ever pursued its top two objectives, could never choose to
defend (an owned flag scored a flat −30 however close it was to being lost), and
re-sorted the point list 80 times a second to do it.

- A claimed point is **penalised, not excluded**. When the round hinges on one
  flag, two squads stacking on it is correct; forced spreading is what sent bots
  wandering away from the fight that decided the game.
- **`ControlPoint.present[]` is finally read.** It had been counted every tick
  since the beginning by nothing at all; an owned flag with enemies on it now
  scores a defence bonus scaled by how far the meter has slipped.
- **Defending is a posture, not a destination.** `Bot.think` takes a
  `BotZone` (`none` / `contest` / `hold`): `contest` keeps the old drift, since
  bodies in the circle are what move the meter, while `hold` takes a covered
  vantage and watches. **`hold` is checked before the search cue** — a defender
  that hears a shot and walks off to investigate has abandoned the only thing it
  was there to do.

**Movement texture is heading, speed and facing only** — with one exception,
below. Two measured results worth keeping:

- `NavGrid.steerAhead` plus heading smoothing cut mean path curvature by ~27%.
  `steer` returns the direction to the next 8-neighbour cell *centre*, which is
  why bots walked flow fields as a visible 1.5 m zigzag.
- The per-bot lateral weave spreads a squad (+95% mean separation) but is itself
  a source of curvature: at a 5 s period it put back *exactly* the wobble the
  smoothing removed. Slowing it to 11 s keeps the spread and the straightness
  both. If you retune one, re-measure the other.

Smoothing runs **before** separation and the stuck watchdog, deliberately: the
watchdog's sidestep is what frees a bot wedged behind a tree, and smoothing
applied after it would blunt exactly that.

**`Bot.yaw` is where a bot LOOKS; `Bot.bodyYaw` is where its feet point.** The
rig hangs off a single root yaw, so before the split a bot aimed its whole body
at whatever it was tracking, and one strafing across a doorway walked visibly
sideways with its legs swinging along an axis it was not travelling on.
`animateSoldier` takes a `twist` for the difference, applied at `torso` with the
head taking a share on top; the legs are `torso`'s siblings under `body`, so
they are untouched. It costs one `rotation.y` write and no geometry, and it
fixes the walk cycle for free — the hips now swing along the direction of
travel.

Three rules come with it:

- The twist is **clamped** to `CONFIG.bots.movement.maxTorsoTwist`, and past it
  the hips come round with it, or the shoulders end up on backwards.
- A **stationary** bot's feet converge on its look direction. Nobody stands
  indefinitely with their body square and their head over one shoulder.
- **Perception reads `yaw`, never `bodyYaw`.** `BattleSystem.inView` keys off
  `Bot.facing`, and where a bot points its feet must not change what it can see.

This is still not a lean or a crouch. It is a yaw, and the rig has no joint that
could sell either of those.

**Skill is one scalar per bot** (`BotSkill.profileFor`), resolved into a
`BotProfile` once at assignment and never per frame — `CONFIG` is `as const`, so
lerping at each use site would need an annotation everywhere. It is drawn **per
squad** from a seeded generator, because an elite squad and a green squad is
something a player can read, where salt-and-pepper skill inside a squad is noise.
Difficulty tiers slide the distribution's centre and hold its width, so every
tier still contains aces and rookies.

### Conquest rules

`ConquestSystem` owns flags, the capture meter, tickets, and bleed. The meter
runs -1..+1 and ownership flips only by crossing 0, so a flag must be
neutralised before it changes hands. Occupancy is counted from the combatant
list `Game` assembles each frame (player + all bots).

The player's health regenerates after `CONFIG.player.regenDelay`. This is not
decoration: with sixteen hostile bots and no medics, a pool that never refills
turns the round into a respawn queue.

**A capture zone is drawn, not just counted** (`CaptureZoneSystem`, plus
`HUD.setCapture` for the panel that appears while you are standing in one). The
rules layer had no geometry at all, so the only way to find out whether you
were inside a flag was to watch the HUD strip move. Four things about it are
load-bearing:

- **The ring is the boundary.** It is built at `ControlPointDef.radius`, which
  is what `pointAt` tests, so the line on the floor is not an approximation of
  the zone — it is the zone. Drawing it at anything else would be worse than
  drawing nothing.
- **It follows the surface you STAND on, not the terrain.** A 28 m ring placed
  by one height sample at the flag is buried at one end, the same problem
  `terrainSlab` solves for roads — but sampling `TerrainField` alone is still
  wrong, because four of the five flags sit on a paved square or a deck whose
  top face is above the ground under it. The ring takes the higher of
  `terrain.surfaceAt(x, z, true)` and the nav graph's walkable height nearest
  the flag's own `y`.
- **The skirt is revealed by proximity, and that is a fix, not a flourish.**
  It is a cylinder around the zone, so from inside you are always looking
  through its far side; at any alpha that reads as a wall, that is a white wash
  over the entire screen. Per-frame vertex alpha keyed to the viewer's distance
  shows only the stretch you are about to cross.
- **Markers are annotation.** No `solid`, no collider, no `WorldBox`, excluded
  from the GlowLayer by hand (Game's scan is construction-time). They are the
  one persistent unlit `StandardMaterial` geometry in the world, so they get no
  shader fog and have to fade themselves out at the fog wall — the beacon
  keeps a floor so a distant flag still reads as a faint column in the mist.

### Rendering constraints that look like bugs if you undo them

- `pipeline.imageProcessingEnabled` must stay `false`: the cel shader outputs
  display-ready colors and Babylon's image-processing pass re-gammas them and
  washes the palette out. That is also why the vignette/grain/aberration/damage
  flash grade is hand-written (`src/shaders/HorrorPost.ts`).
- Glow is a `GlowLayer` keyed off emissive color, deliberately not threshold
  bloom — bright-but-not-emissive surfaces (desert sand) must stay crisp.
- Flat shading is recovered in the fragment shader from screen-space derivatives
  of the world position. Do not call `convertToFlatShadedMesh()`; it would unweld
  vertices on every prop and clone for no visual gain.
- `renderOutline` draws a back-face shell expanded by `outlineWidth` in every
  direction, so an emissive detail must protrude past its neighbors' shells or
  the glow is swallowed (this is why the player's visor slit and the lamp lens
  stick out).
- Fixture lights are hand-placed and must stay **spatially spread**. The 16-slot
  shader cap is absolute; `LightingSystem` picks nearest-first, so clustering
  lanterns wastes slots and flattens the darkness. The retired room generator
  enforced this automatically with a sqrt scale — hand authoring means enforcing
  it by eye.

### Procedural models

Every mesh except the player's GLB body is built from Babylon primitives at
runtime, and all audio is synthesized (`Sfx`). Don't reintroduce asset files
without being asked.

`RifleModel.buildRifle()` merges its ~50 static boxes into one mesh per color
(BODY/POLYMER/METAL) — that merge is what makes the outline pass draw one border
per color group instead of a black shell around every screw. It works only
because the root is still at identity while building: `MergeMeshes` bakes world
matrices and returns an identity-transform mesh, which is then re-parented.

## Conventions

- **All tunables live in `src/config.ts`** (`CONFIG`, `as const`). No gameplay
  magic numbers elsewhere — art/geometry constants stay in their model file.
- `CONFIG` is `as const`, so a field like `bots.engageRange` has a *literal*
  type. `let x = CONFIG.bots.engageRange` then reassigning it fails to compile —
  annotate `let x: number` instead.
- Smoothing is normally the frame-lerp idiom `Math.min(1, dt * rate)`. Recoil
  decay in `CameraSystem` deliberately uses true `Math.exp(-rate * dt)` instead,
  because it moves where bullets go and burst climb must not vary with frame
  rate.
- Recoil only partly springs back: `CONFIG.recoil.recoverFraction` (0.7) returns
  70% and pushes 30% permanently into the player's own `pitch`/`yaw`, so a
  magazine held down genuinely walks off target and has to be pulled back by
  hand. This is an explicit product decision, not a bug — a fully-recovering
  version was rejected.
- **Everyone** is hitscan — player and bots share `CombatSystem.fire()`, which
  takes the shooter's target list so friendly fire is excluded by construction
  rather than by a team check inside. There is no projectile pool to thrash in a
  16-bot firefight. Tracers and sparks are pooled; add effects to a pool rather
  than allocating per shot.
- TypeScript is strict with `noUnusedLocals`/`noUnusedParameters` — the
  typecheck will fail on dead variables.
- `Bot` holds a small FSM and drives a joint rig built by `SoldierModel`
  (invisible root + `TransformNode` joints). Animation is procedural — posed
  hierarchies, walk cycles driven by travel speed — so a new behavior means new
  FSM states, never new clips.
- The map is data: a second map is one new `layout.ts` + `EnvironmentSpec`;
  `MapBuilder`/`BuildingKit` must not special-case Hollowmere.

## Files not to edit / not part of the build

- `dist/` — build output (gitignored); regenerate with `npm run build`.
- `node_modules/` — gitignored.
- `specs/game_design.md` — describes the original roguelike prototype;
  historical, **not a live contract**.
- `undefined/` — tracked stray screenshot output from a script with a bad path;
  ignore it.
