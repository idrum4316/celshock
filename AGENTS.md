# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

**HOLLOWMERE — Cel-Shaded Conquest**: a browser-based, single-player Conquest
shooter (16v16 vs bots, five control points, ticket bleed) built with
**Babylon.js** + **TypeScript**, bundled with **Vite**. ES modules
(`"type": "module"`), Node 18+, WebGL2 browser required.

The game ships **zero model files and zero audio files** — every mesh is built
from Babylon primitives at runtime and all sound is synthesized WebAudio
(`src/core/Sfx.ts`). A glTF asset pipeline was tried and deliberately reverted;
do not reintroduce asset files unless explicitly asked.

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run typecheck  # tsc --noEmit (strict + noUnusedLocals/Parameters)
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
```

There is **no test suite and no linter**. `npm run typecheck` is the only
automated gate — run it after every change. Playwright is a devDependency for
ad-hoc browser smoke tests only; write those as throwaway scripts outside the
repo and drive the game via the `window.__celshock` handle exposed by `Game`.
Headless quirks (slow SwiftShader fps, clamped `dt`, input rewriting) are
documented in `CLAUDE.md` — read it before writing verification scripts.

## Architecture

`main.ts` bootstraps `src/core/Game.ts`, the **only place systems meet**.
Systems never import each other; `Game` wires them with callbacks
(`onBotKilled`, `onCaptured`, `onDeploy`, …). New cross-system behavior belongs
in that wiring, not in a new import between systems. Game state machine:
`menu -> deploy -> playing` (re-entering `deploy` on each death), then
`roundover`; the 3D scene renders live behind every state.

```
src/config.ts      # ALL tunable constants (CONFIG, as const) — no gameplay
                   # magic numbers elsewhere
src/core/          # Game (orchestrator), InputManager, CameraSystem, Sfx
src/entities/      # Player, Bot (FSM), SoldierModel, RifleModel, Viewmodel,
                   # Combatant (shared shootable interface)
src/systems/       # BattleSystem (bot pool/AI), ConquestSystem (flags/tickets),
                   # CombatSystem (hitscan), LightingSystem, Atmosphere
src/world/         # MapBuilder, BuildingKit, NavGrid, Props, environment
src/world/hollowmere/  # THE MAP as data: layout.ts + environment.ts
src/ui/            # HUD, DeployScreen (DOM overlays)
src/shaders/       # CelShader (custom ShaderMaterial), HorrorPost (grade)
```

`README.md` has the full file-by-file tour; `CLAUDE.md` has the non-obvious
constraints in depth. Read both before a substantial change.

## Load-bearing rules (do not undo these)

- **Visual meshes ≠ collider proxies.** Every ray test (camera occlusion,
  hitscan, bot LOS, ground probes) filters on `metadata.solid === true`, and
  only invisible collider boxes carry it. Visuals are merged per colour and
  frozen; colliders are never merged. `MapBuilder.collider()` is the only place
  colliders are created — geometry added by any other path is invisible to
  navigation too.
- **Mesh metadata is a contract:** `solid` (colliders only), `noOutline`
  (every emissive part needs it), `noGlow` (excluded from the GlowLayer scan,
  which only runs at construction). Omitting them misbehaves silently.
- **The scene has no Babylon lights.** Cel materials carry their own uniforms;
  `LightingSystem` owns all dynamic light and uploads the nearest 16 point
  lights per frame. Adding a `PointLight`/`HemisphericLight` does nothing to
  cel-shaded meshes. Transient lights (muzzle flashes) are budgeted per frame
  via `Game.spendMuzzleLightBudget` — any new per-bot transient light needs the
  same treatment.
- **Bots never use `moveWithCollisions`** and never run their own pathfinding —
  they steer on `NavGrid`'s precomputed per-objective flow fields. Bot rigs are
  pooled once and never disposed (respawn re-poses); AI think ticks are
  staggered round-robin at `CONFIG.bots.thinkRate`.
- **Frame-order matters** at the end of `Game.updateGameplay`: camera →
  `mats.updateCamera()` → carried lights → `lighting.update()` →
  `sfx.setListener()` → `player.setFirstPerson()` → `viewmodel.update()`.
  `ConquestSystem.update` runs before `BattleSystem.update` so bots see this
  frame's flag ownership.
- **Rendering constraints:** `pipeline.imageProcessingEnabled` must stay
  `false` (the cel shader outputs display-ready color; Babylon's pass re-gammas
  it). Never call `convertToFlatShadedMesh()` — faceting is recovered in the
  fragment shader from screen-space derivatives. Glow is a `GlowLayer` keyed on
  emissive color, not threshold bloom.
- **Everyone is hitscan** — player and bots share `CombatSystem.fire()`, which
  takes the shooter's target list (friendly fire excluded by construction).
  Tracers/sparks are pooled; add effects to pools, never allocate per shot.
- **Builders assemble at the origin, unrotated**, returning parallel
  `meshes`/`colliders`/`lights` lists; `MapBuilder` merges then transforms.
  This identity-transform build is what makes `MergeMeshes` safe.

## Conventions

- **All tunables live in `src/config.ts`** (`CONFIG`, `as const`). Note the
  gotcha: `as const` gives fields literal types, so `let x = CONFIG.bots.x`
  then reassigning fails to compile — annotate `let x: number`.
- Smoothing uses the frame-lerp idiom `Math.min(1, dt * rate)`. The one
  deliberate exception is recoil decay in `CameraSystem`
  (`Math.exp(-rate * dt)`), because burst climb must not vary with frame rate.
- TypeScript is strict with `noUnusedLocals`/`noUnusedParameters` — the
  typecheck will fail on dead variables.
- Animation is procedural (posed joint hierarchies, speed-driven walk cycles) —
  new bot behavior means new FSM states, never new clips.
- The map is data: a second map is one new `layout.ts` + `EnvironmentSpec`;
  `MapBuilder`/`BuildingKit` must not special-case Hollowmere.

## Files not to edit / not part of the build

- `dist/` — build output (gitignored); regenerate with `npm run build`.
- `node_modules/` — gitignored.
- `specs/game_design.md` — describes the original roguelike prototype;
  historical, **not a live contract**.
- `undefined/` — tracked stray screenshot output from a script with a bad path;
  ignore it.
