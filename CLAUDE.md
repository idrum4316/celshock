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
    Bot.ts                  # Bot FSM: advance / engage / reposition / capture
    SoldierModel.ts         # Cheap merged bot rig + procedural animation
  systems/
    BattleSystem.ts         # Bot pool, AI scheduling, LOS, distance LOD
    ConquestSystem.ts       # Flags, capture meters, tickets, bleed, spawns
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
    mutate.ts               #   Layout writes + scene reposition + nav rebuild
    inspect.ts / params.ts  #   Inspector read model + per-kind param table
    sourceScan.ts           #   layout.ts as text: regions, entries, tokens
    serialize.ts / save.ts  #   Minimal-diff emit + POST to the dev server
    tuning.ts               #   Tool constants (NOT config.ts — not gameplay).
  world/
    layout.ts               # Placement/ScatterSpec/MapLayout — the map-data
                            # vocabulary, map-agnostic
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
    ObstacleField.ts        # Sub-cell collision push-out for thin props
    Props.ts                # Scatter props: trees, graves, rubble, braziers,
                            # boulders, brambles, barrels
    textures.ts             # Generated canvas textures (cobblestone etc.)
    environment.ts          # EnvironmentSpec + applyEnvironment
    hollowmere/
      layout.ts             # THE MAP — every placement, flag, and spawn
      environment.ts        # Hollowmere's palette, fog, mist, particles
  ui/
    HUD.ts                  # DOM overlay: tickets, flags, killfeed, scoreboard
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
(`{ kind, x, z, rotY, params }`), scatter regions, control points, and spawns.
`BuildingKit` supplies the parametric pieces and `MapBuilder` consumes the
layout; neither special-cases Hollowmere, so **a second map is one new layout
file plus an `EnvironmentSpec`**. The vocabulary those files are written in
(`Placement`, `ScatterSpec`, `MapLayout`) lives in `src/world/layout.ts`, not
beside Hollowmere's data — a new map must not import its types from its
predecessor. `MapBuilder.build(layout, env)` takes both as arguments for the
same reason.

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

### The map editor (dev only)

`F2` in a dev build opens `src/editor/` — free-fly the real scene, click to
select, drag gizmos, inspect params. Everything under `src/editor/` is reached
through **one dynamic `import()` inside a `import.meta.env.DEV` branch in
`Game.toggleEditor`**, and the *whole method body* is behind that gate, not just
the keybind. That is what makes the import unreachable under `vite build` so
Rollup drops the chunk instead of emitting an orphan. Never import
`src/editor/` statically from anywhere.

Things it deliberately does not do:

- **It does not make visuals pickable.** Babylon skips the `isPickable` test
  when a pick supplies a predicate, so the editor picks on
  `metadata.editorRef` and the visual/collider table below stands unchanged.
- **It does not build colliders.** Proxy meshes for flags, spawns, scatter
  regions and water/grass rects are visual only, and never enter
  `colliderBoxes` — `MapBuilder.collider()` is still the sole collider factory.
- **It does not re-run builders to move things.** A builder assembles at the
  origin and `MapBuilder` transforms the result, so `repositionItem()` moves the
  visuals, the collider proxies and the `WorldBox`es directly. Measured: a full
  editor build is ~570 ms, `NavGrid` + all 7 flow fields ~45 ms, one builder
  call ~0.9 ms. So dragging repositions every frame and rebuilds navigation only
  when the drag ends.

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

Surface heights come from evaluating each collider's top-face *plane* at the cell
centre, not from its bounding box. That is deliberate: a pitched ramp's AABB
reports its peak across the whole footprint and would read as a wall. If you
touch `topFaceHeight`, note that the half-thickness is `h/2/cos(rotX)` and the
slope is `tan(rotX)` — writing it as `h/2*cos` and `-tan` is the easy sign error,
and it silently makes every ramp unwalkable.

Reachability is a flood fill from the map's outer ring. That is what keeps bots
off rooftops: a roof is a perfectly good standable surface, but nothing beside it
is within a step, so it is never reached.

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
  picks per think.

Bots hold a target until it dies, breaks LOS, or leaves range. Without that
hysteresis, "nearest visible enemy" flips every tick in a crowd, which resets
`aimT` and means bots essentially never finish their reaction wind-up and fire.
This looked exactly like "bots don't shoot" and is worth remembering.

### Conquest rules

`ConquestSystem` owns flags, the capture meter, tickets, and bleed. The meter
runs -1..+1 and ownership flips only by crossing 0, so a flag must be
neutralised before it changes hands. Occupancy is counted from the combatant
list `Game` assembles each frame (player + all bots).

The player's health regenerates after `CONFIG.player.regenDelay`. This is not
decoration: with sixteen hostile bots and no medics, a pool that never refills
turns the round into a respawn queue.

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
