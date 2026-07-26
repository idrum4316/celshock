# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- Killing a spawned `npx vite` can leave an orphan holding the port; free it by
  PID from `ss -tlnp`. Never `pkill -f vite` — it matches the calling shell's own
  command line.

To inspect a model in isolation, drop a throwaway `modelviewer.html` + `.ts` at
the repo root (Vite serves it as a second page) with an `ArcRotateCamera` driven
by `camera.setPosition`.

## Architecture

`README.md` has the full file-by-file tour and the design rationale — read it
before a substantial change. What follows is what isn't obvious from any single
file.

### Ownership and wiring

`src/core/Game.ts` is the only place systems meet. Systems never import each
other; `Game` wires them with callbacks (`combat.onPlayerHit`,
`enemySys.onEnemyDied/onBossDied`) and hands enemy AI an `AICtx` (in
`entities/Enemy.ts`) that is mutated in place each frame rather than rebuilt. New
cross-system behavior belongs in that wiring, not in an import between systems.

`Game.updateGameplay` has a load-bearing order at the end of the frame: camera
update → `mats.updateCamera()` → carried-light updates → `lighting.update(dt,
camera.position, mats)` → `player.setFirstPerson()` → `viewmodel.update()`. Light
slot selection and shader fog both key off the camera position, so anything that
moves the camera must run before them.

### The scene has no Babylon lights

Not one. Cel materials carry their own `lightDir`/`lightColor`/`ambientColor` and
a packed array of up to `MAX_POINT_LIGHTS` (16) point lights as uniforms;
`LightingSystem` is the sole owner of dynamic light and uploads the winning slots
via `CelMaterialFactory.setPointLights()` once per frame. Adding a
`PointLight`/`HemisphericLight` to the scene will not affect any cel-shaded mesh.
Effect meshes (tracers, sparks, neon, reticles) use unlit emissive
`StandardMaterial`s from `mats.getEmissive()` and are unaffected by lighting
entirely.

Lights come in three flavors: static fixtures (`lighting.add()`, registered
automatically from a theme prop's `light` spec), transient pulses
(`lighting.pulse()` — muzzle flash, shockwave), and carried lights
(`setCarried()`/`removeCarried()` — the player's shoulder lamp, a boss aura).
Transient and carried lights always get a slot; static fixtures compete
nearest-first.

### Themes are data, not code

A `RoomTheme` (`src/themes/types.ts`) owns everything a room needs: palette, fog
and mist, key/ambient/rim lighting, prop builders with their attached lights, the
particle spec, the enemy roster, and the boss. `RoomGenerator` and the enemy/boss
model builders consume that data and never special-case a theme, so **adding a
theme is one new file plus one entry in `ThemeManager.themes`** — and a new enemy
or boss needs no art, only numbers plus one of the existing `body`/`pattern`
archetypes.

### Mesh metadata is a contract

Three flags, all read elsewhere; new geometry that omits them misbehaves silently:

- `solid: true` — walls and blocking props. Both `CameraSystem`'s collision pick
  and `CombatSystem`'s hitscan filter on it, so unmarked geometry is shot
  through and seen through. Decorative props stay unmarked (and unpickable) on
  purpose so they never enter a ray test.
- `noOutline: true` — skipped by `addOutline()`. Every emissive part (eyes,
  flames, signs, reticle) needs it.
- `noGlow: true` — excluded from the `GlowLayer` in the `Game` constructor. Only
  meshes existing at construction time are scanned.

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
- Prop counts scale with floor area, but **light-bearing props scale by the
  square root of that** (`RoomGenerator` line ~205). Scaling them linearly floods
  the 16 shader slots and destroys the darkness.

### Procedural models

Every mesh — player, enemies, bosses, weapon, props, environment — is built from
Babylon primitives at runtime. The game ships zero model files and zero audio
files (`Sfx` synthesizes WebAudio). A glTF asset pipeline was tried and reverted;
it survives only in `stash@{0}`. Don't reintroduce assets without being asked.

`RifleModel.buildRifle()` merges its ~50 static boxes into one mesh per color
(BODY/POLYMER/METAL) — that merge is what makes the outline pass draw one border
per color group instead of a black shell around every screw. It works only
because the root is still at identity while building: `MergeMeshes` bakes world
matrices and returns an identity-transform mesh, which is then re-parented.

**ADS obstruction drives the optic's dimensions.** At
`CONFIG.viewmodel.adsSightDistance = 0.52` the sight window subtends ~31% of
screen height, so hood walls are 0.007, the irons are modelled folded flat
(upright posts put pillars in the middle of the glass), and the viewmodel outline
is 0.0012. Raising `adsSightDistance` to shrink the rifle is not an option: past
~0.55 the buttstock crosses the camera's `minZ` and fills the lower screen with a
black cross-section.

### Gameplay conventions

- **All tunables live in `src/config.ts`** (`CONFIG`, `as const`). No gameplay
  magic numbers elsewhere — art/geometry constants stay in their model file.
- Smoothing is normally the frame-lerp idiom `Math.min(1, dt * rate)`. Recoil
  decay in `CameraSystem` deliberately uses true `Math.exp(-rate * dt)` instead,
  because it moves where bullets go and burst climb must not vary with frame
  rate.
- Recoil only partly springs back: `CONFIG.recoil.recoverFraction` (0.7) returns
  70% and pushes 30% permanently into the player's own `pitch`/`yaw`, so a
  magazine held down genuinely walks off target and has to be pulled back by
  hand. This is an explicit product decision, not a bug — a fully-recovering
  version was rejected.
- Player bullets are hitscan (one ray plus sphere tests). Tracers, sparks, and
  enemy projectiles are object-pooled in `CombatSystem`; add effects to a pool
  rather than allocating per shot.
- Enemy and boss classes hold a small FSM and drive a joint rig built by
  `EnemyModels`/`BossModels` (invisible root + `TransformNode` joints). Animation
  is procedural — posed hierarchies, walk cycles driven by travel speed,
  telegraph poses — so a new behavior means new FSM states, never new clips.

## Notes

- `specs/game_design.md` is the original specification the prototype was built
  against; it is history, not a live contract.
- The tracked `undefined/` directory is stray screenshot output from a script
  with a bad path. It is not part of the build.
