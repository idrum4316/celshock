# HOLLOWMERE — Cel-Shaded Conquest

A browser-based, single-player **Conquest** shooter built with **Babylon.js** and
**TypeScript**. Sixteen-a-side against bots over five control points in a
fog-drowned horror village, with seamless third-person ↔ first-person ADS
switching and a low-poly cel-shaded look: a near-black valley lit by guttering
lanterns, burning braziers, muzzle flashes, and your own shoulder lamp.

## Setup

```bash
npm install
npm run dev      # start the dev server (Vite), open the printed URL
```

Other scripts:

```bash
npm run build    # typecheck + production build to dist/
npm run preview  # serve the production build
```

Requires Node 18+ and a WebGL2-capable browser (Chrome/Edge/Firefox/Safari).

## Controls

| Action     | Gamepad (Xbox / PS) | Keyboard / Mouse |
| ---------- | ------------------- | ---------------- |
| Move       | Left stick          | WASD             |
| Look       | Right stick         | Mouse            |
| Sprint     | L3                  | Shift            |
| ADS        | LT / L2             | Right-click      |
| Shoot      | RT / R2             | Left-click       |
| Jump       | A / ✕               | Space            |
| Reload     | X / ▢               | R                |
| Scoreboard | Back / Share        | Tab              |
| Confirm    | A or Start          | Enter / Click    |

Click the page once to capture the mouse (pointer lock). Gamepads use the
browser's standard mapping and are hot-pluggable — press any button after
connecting.

Gamepad look comes with **aim assist**: the stick slows down while the
crosshair is over an enemy, and the view pulls gently toward the target
(full strength while aiming down sights, weaker at the hip while firing or
steering). Pushing the stick against the pull cancels it — a committed push
always breaks free. It only engages while the right stick is the active
look device — the moment the mouse moves, assist disengages and sensitivity
is untouched, so mixed setups never penalize keyboard/mouse aim. Tuning
lives in `CONFIG.aimAssist`.

### How a round works

- Two teams of sixteen — the **Wardens** (warm amber) and **the Blight** (cold
  crimson) — fight over **five control points** across a 240 × 240 m village.
- Stand inside a zone to capture it. More bodies capture faster, with
  diminishing returns; if both teams are inside, the meter freezes. A flag has
  to be swept through **neutral** before it changes hands, so you cannot steal
  one by briefly outnumbering the defender.
- Each team starts with **400 reinforcements**. Every death costs one, and
  whichever side holds **fewer flags bleeds** tickets steadily on top. Winning
  fights while ignoring objectives still loses the round.
- Death opens the **deploy screen**: a top-down map of the village where you
  pick a spawn from the flags you hold, or fall back to your home gatehouse.
  Health regenerates a few seconds after you stop taking fire.
- The round ends when one side hits zero.

Map notes: the **Mill** sits down in a creek 1.5 m below the embankments on
either side, so whoever holds the banks shoots into it. The **Barn**'s hayloft
is the best perch on the map and the ramp up to it is fully exposed. The
**Chapel** is on a terrace with a single ramp — hard to take, easy to hold. The
**Bog Docks** are mist-choked and cramped by design. The **Square** has four
road approaches and almost no cover.

## Architecture

```
main.ts                     # Bootstrap
src/
  config.ts                 # All tunable constants (no magic numbers in code)
  core/
    Game.ts                 # Orchestrator + game state machine + main loop
    InputManager.ts         # Unified keyboard/mouse + gamepad state
    CameraSystem.ts         # Third-person camera with blended first-person ADS
    Sfx.ts                  # Procedural WebAudio, spatialised and voice-capped
  entities/
    Player.ts               # Movement, sprint, jump, weapon state, body wiring
    GlbSoldier.ts           # Player body: rigged GLB (models/*.glb), clips +
                            # procedural bone overlay (aim/reload/rifle carry)
    RifleModel.ts           # Low-poly SCAR-pattern rifle + holo sight builder
    Viewmodel.ts            # First-person rifle: raise, sway, bob, recoil
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
  world/
    MapBuilder.ts           # Builds the map; merges visuals, emits colliders
    BuildingKit.ts          # Parametric cottages, chapel, barn, mill, ramps...
    NavGrid.ts              # Walkable-surface graph + precomputed flow fields
    Props.ts                # Scatter props: trees, graves, rubble, braziers
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
    HorrorPost.ts           # Vignette / grain / aberration / damage flash pass
```

### The map is data

`src/world/hollowmere/layout.ts` is the whole level: a list of placements
(`{ kind, x, z, rotY, params }`), scatter regions, control points, and spawns.
`BuildingKit` provides the parametric pieces, `MapBuilder` consumes the layout,
and neither special-cases Hollowmere — **a second map is one new layout file**.

### Visual meshes and collision proxies are separate

This is the load-bearing decision of the whole conversion. Every ray test runs
against `metadata.solid === true` meshes — the camera's occlusion pull-in every
frame, hitscan on every shot, and bot line-of-sight — and the player's collider
walks every mesh with `checkCollisions`. At village scale, letting visual
geometry do those jobs means thousands of triangle-picked meshes in the hot
path.

So nothing does both:

| Kind         | visible | pickable | collides | `solid` | merged | frozen |
| ------------ | ------- | -------- | -------- | ------- | ------ | ------ |
| **Visual**   | yes     | **no**   | **no**   | —       | yes    | yes    |
| **Collider** | **no**  | yes      | yes      | yes     | no     | yes    |

Visual geometry is merged per colour — a cottage goes from ~20 meshes to 4, and
because `renderOutline` draws a shell per mesh, from ~40 draws to 8. The whole
village is ~160 drawn meshes and ~300 invisible collider boxes.

### Navigation

`NavGrid` rasterises every collider's **top face** into a 160 × 160 grid. The
graph node is a *surface* — a (cell, height) pair — because one cell can hold
the creek floor and the bridge deck above it, or the barn floor and its hayloft.
Surfaces are linked when they are adjacent and within a step, then flood-filled
from open ground; that flood fill is what keeps bots off rooftops, since a roof
is standable but nothing next to it is within a step.

One **flow field per objective** (five flags plus both home spawns) is computed
at load, so all 32 bots share seven breadth-first searches instead of running
their own pathfinding. The map is static, so none of it is ever recomputed.

The grid routes; it does not collide. It samples one column per 1.5 m cell
*centre*, so anything narrower than a cell — every scattered tree, gravestone
and fire drum — can sit between two centres and be invisible to it, and bots
walked straight into props and stood inside them. `ObstacleField` covers that
gap: collider boxes are bucketed at load, and each step is pushed clear of
whatever it overlaps before the grid is asked whether the spot is standable.
Steps also slide along a blocked axis rather than failing outright, and a
watchdog sidesteps a bot that stops making progress. Bots being embedded in
geometry was never only cosmetic — `CombatSystem` stops every shot at the first
`solid` hit, so a bot inside a tree had the tree soaking up rounds aimed at it.

### Bots

Thirty-two bots, from a pool built once and never disposed — death hides a rig,
respawn re-poses it, so continuous respawning never allocates. Each rig is nine
merged meshes (`SoldierModel`), against ~60 for the player's, because the
outline pass draws everything twice and the player is the only character always
on screen.

The expensive half of the AI — target acquisition, line-of-sight rays, objective
re-evaluation — runs at 5 Hz per bot, round-robin across frames, which is a
couple of ray picks per frame for the whole roster. Movement integrates every
frame. Bots hold a target until it dies, breaks line of sight, or leaves range:
without that hysteresis "nearest visible enemy" flips every tick in a crowd and
resets the reaction timer, so nobody ever fires.

Distance LOD keyed off the camera: past the fog a rig is disabled outright, past
35 m the pose freezes, past 20 m outlines are dropped.

### Rendering

Cel shading is a custom `ShaderMaterial` (`src/shaders/CelShader.ts`). Light
arrives in three banded parts, so the toon look survives a fully dynamic scene:

- a **directional key light** (the moon) quantized into 4 hard bands,
- up to 16 **dynamic point lights** — lanterns, braziers, muzzle flashes, the
  player's lamp — quantized into 3 bands with a smooth radial falloff, and
- a flat **ambient** term that sets how black the unlit side goes.

A soft shoulder compresses anything above 0.75 so overlapping lights saturate in
their own color instead of clipping to white. Atmosphere is theme-tinted
distance fog plus a separate height-based ground mist, both blended in the
fragment shader, and a step-function rim highlight adds the toon pop. Bold
outlines use Babylon's outline renderer (inverted hull). Materials are cached per
color and shared across meshes.

`LightingSystem` owns every dynamic light and the shader has only 16 slots, so
each frame the nearest fixtures win — imperceptible in practice, because distant
lights are already swallowed by fog. Transient flashes and *carried* lights (the
player's lamp) are guaranteed a slot, which is exactly why bot muzzle flashes
are budgeted: 32 bots firing would take all 16 and black out the village.

Finally `HorrorPost` grades the frame: vignette, corner desaturation, radial
chromatic aberration, animated film grain, and a red flash on damage. It is
hand-written because Babylon's image-processing block re-gammas the cel shader's
already display-ready colors and washes the palette out.

Shading is **faceted**: the fragment shader recovers each triangle's geometric
normal from screen-space derivatives of the world position instead of using the
interpolated vertex normal. Doing it in the shader gets flat shading on every
mesh for free — no `convertToFlatShadedMesh()` calls, no unwelded vertices, and
it applies automatically to anything built later. Effect meshes (tracers, sparks)
use unlit emissive `StandardMaterial`s and are unaffected.

**The game ships no 3D model files.** Every mesh — player, bots, weapons, props,
buildings, environment — is built from Babylon primitives at runtime,
deliberately coarse so the facets read as the art style.

### Performance notes

- Village visuals are **merged per colour, per structure**; scatter props are
  merged per region.
- Static geometry is `freezeWorldMatrix()`'d and unpickable; collider proxies
  are plain invisible boxes.
- Player and bot shots are **hitscan** — there is no projectile pool to thrash
  in a 32-bot firefight. Tracers and sparks are pooled.
- Bots move on the nav graph rather than through Babylon's collider; 32 agents
  calling `moveWithCollisions` would walk the collidable mesh list 32× a frame.
- Audio uses **one cached noise buffer**, distance attenuation, and a 24-voice
  cap. Generating a fresh buffer per shot was ~1,900 `Math.random()` calls each.
- Almost no asset downloads: the one imported asset is the player's GLB body
  (`models/`, see `GlbSoldier.ts`); bots, weapons, and the world are still
  built from primitives, and all sound is synthesized at runtime.

## Known limitations

- Characters are primitive assemblies, not modeled/rigged meshes; all
  "animation" is procedural (posed joint hierarchies, walk cycles driven by
  travel speed).
- Point lights are per-pixel but cast **no shadows** — the darkness is fog,
  ambient, and falloff, not occlusion.
- Single weapon; no kits, classes, or vehicles.
- Nav cells hold up to three surfaces, so unusually deep stacks of walkable
  geometry would need `MAX_SURFACES` raised.
- Bots use cover incidentally (the flow field routes them past buildings) rather
  than deliberately picking firing positions.
- One map. The system supports more, but only Hollowmere is authored.

## Next steps for expansion

- A second map: one new `layout.ts` plus an `EnvironmentSpec`.
- Kits and weapon variety — extract a `WeaponType` the way themes were data.
- Squad orders, so friendly bots can be told which flag to take.
- Deliberate cover selection and suppression in the bot FSM.
- Vehicles, which would need new physics, camera modes, and AI.
