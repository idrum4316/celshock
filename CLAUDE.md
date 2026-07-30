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
    Atmosphere.ts           # Drifting ash particle field
    Sky.ts                  # Generated sky dome (gradient/stars/halo), moon, clouds
    WaterSystem.ts          # Water surfaces from map WaterRects
  world/
    MapBuilder.ts           # Builds the map; merges visuals, emits colliders
    BuildingKit.ts          # Facade: shared types + BUILDERS registry
    kit/
      core.ts               # Build accumulator, palette, builder contract
      buildings.ts          # cottage, chapel, barn, mill, boathouse, gatehouse
      structures.ts         # silo, well, stall, fence, bridge, haystack, lamp
      terrain.ts            # terrace, ramp, road, jetty
    NavGrid.ts              # Walkable-surface graph + precomputed flow fields
    ObstacleField.ts        # Sub-cell collision push-out for thin props
    Props.ts                # Scatter props: trees, graves, rubble, braziers
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

### The scene has no Babylon lights

Not one. Cel materials carry their own `lightDir`/`lightColor`/`ambientColor` and
a packed array of up to `MAX_POINT_LIGHTS` (16) point lights as uniforms;
`LightingSystem` is the sole owner of dynamic light and uploads the winning slots
via `CelMaterialFactory.setPointLights()` once per frame. Adding a
`PointLight`/`HemisphericLight` to the scene will not affect any cel-shaded mesh.
Effect meshes (tracers, sparks, neon, reticles) use unlit emissive
`StandardMaterial`s from `mats.getEmissive()` and are unaffected by lighting
entirely.

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
file plus an `EnvironmentSpec`**.

Builders assemble geometry **at the origin, unrotated**, and return three
parallel lists (`meshes`, `colliders`, `lights`) in local space. `MapBuilder`
merges the meshes per colour and then transforms all three into place. Building
at identity is what makes the merge safe — `MergeMeshes` bakes world matrices and
returns an identity-transform mesh, the same trick `RifleModel.buildRifle` uses.

Layout gotchas that have already cost time:

- A collider's top face must stay within `CONFIG.nav.stepHeight` (0.6) of the
  ground beside it, or the nav flood fill never reaches it and bots treat it as a
  wall. The boathouse and jetty decks both failed this at 0.62–0.73 m.
- A control point's `pos` must not be inside a collider, or `surfaceAt` returns
  -1 there. Flag C was originally centred on the well.
- Ramps need `rotX` on the **collider**, not just the visual box, or the player
  walks into an invisible flat slab.

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

Three flags, all read elsewhere; new geometry that omits them misbehaves silently:

- `solid: true` — collider proxies only (see above). Unmarked geometry is shot
  through, seen through, and walked through.
- `noOutline: true` — skipped by `addOutline()`. Every emissive part (eyes,
  flames, signs, reticle) needs it.
- `noGlow: true` — excluded from the `GlowLayer` in the `Game` constructor. Only
  meshes existing at construction time are scanned.

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
