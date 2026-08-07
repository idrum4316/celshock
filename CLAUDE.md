# CLAUDE.md

Single source of truth for AI coding agents (and contributors) working in this
repository. `AGENTS.md` is a pointer to this file; `README.md` is user-facing.
`FINDINGS.md` is the open-threads list — things measured and found worth doing
but not yet done, each with the arithmetic behind it. Read it before starting
performance work, and delete an entry there when you fix or disprove it.

## Project overview

**HOLLOWMERE — Cel-Shaded Conquest**: a browser-based, single-player
**first-person** Conquest shooter (8v8 vs bots, five control points, ticket
bleed) built with **Babylon.js** + **TypeScript**, bundled with **Vite**. ES
modules (`"type": "module"`), Node 18+, WebGL2 browser required.

The game ships **zero audio files and zero model files** — every mesh is built
from Babylon primitives at runtime and all sound is synthesized WebAudio
(`src/core/Sfx.ts`). Do not add asset files unless explicitly asked.

The **one binary that does ship** is Havok's `.wasm` (~2 MB), pulled in by
`@babylonjs/havok` for the bot ragdolls and added on an explicit request. It is
never named by any path here: Havok's ESM glue resolves it against its own
`import.meta.url`, which Vite follows and emits as a content-hashed asset, so it
is versioned with the dependency. A hand-placed copy in `public/` as well is not
belt-and-braces — it is two megabytes shipped and precached twice, which is
exactly what happened before it was measured and taken out.

**`optimizeDeps.exclude` in `vite.config.ts` is what makes that work in DEV, and
it is load-bearing.** Resolving against the module's own location means the
binary has to still be beside the module: the dep optimizer breaks that by
copying the glue into `node_modules/.vite/deps/` and leaving the 2 MB binary
behind, so the URL 404s and the dev server's SPA fallback answers with
`index.html`. The error blames the wrong thing twice — first an
`application/wasm` MIME complaint, then `expected magic word 00 61 73 6d, found
3c 21 64 6f`, which is `<!do` — and no server MIME tuning fixes either.
**A production build resolves the asset itself, so `vite preview` works with or
without the exclusion and testing only there will not catch this.** Deployed
nginx needs nothing: `application/wasm` has been in its bundled `mime.types` for
years, unlike the web app manifest, which is why only that one has a block in
`docker/nginx.conf`. See "Bot deaths, and the one physics engine".

`src/entities/GlbSoldier.ts` and `src/entities/soldier/` are the **one
exception on disk and are currently unreferenced**: a rigged GLB player body
(own locomotion clips + a procedural bone overlay for aim/reload/rifle-carry),
added by explicit request back when the camera was over the shoulder. First
person retired it — the camera is inside the head, so there is no own-body to
render — and `Player` no longer imports it, which is what keeps the module and
its multi-megabyte `models/*.glb` out of the production bundle. Kept, not
deleted, because it is the only rigged-character work in the tree and a
killcam or spectator view would want it back. Do not wire it into anything
new, and do not extend the GLB approach to bots or weapons.

**Every source file has a contract header** at the top stating what it owns,
its invariants, and what it must never do. Read it before editing that file.

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run typecheck  # tsc --noEmit (strict, noUnusedLocals/Parameters)
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
npm run icons      # regenerate public/icons (committed; see "The installable app")
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
- **Sight alignment is checkable without looking at a picture**, and should be
  after anything that touches the viewmodel or the camera — for **every** optic,
  since each carries its own eye reference: take
  `scene.getTransformNodeByName("view_<weapon>_<sight>_sightCenter")
  .getAbsolutePosition()` (`weapon` is `rifle`/`smg`/`dmr`, `sight` is
  `iron`/`holo`/`scope` — all nine combinations, since a weapon change moves the
  optic too, plus `view_pistol_iron_sightCenter`, which is the sidearm's only
  one), subtract `camera.position`, and project onto `cameraSys.forward`
  and a right vector built from `aimYaw` — `(cos(aimYaw), 0, -sin(aimYaw))`.
  **Not `flatRight`**, which is deliberately the un-recoiled *and un-swayed*
  yaw (see `camera.aimSway`) and is therefore not perpendicular to `forward`
  while either is live; through it a correct sight reads a couple of
  millimetres off. At `adsBlend === 1` the two cross-axis
  components must be **0**, and the along-axis one is that sight's `eyeRelief`
  times its `zoomComp`. Give the weapon time to settle first: the sway spring is
  a real offset that decays over several seconds at headless frame rates, and
  reading through it looks exactly like a misaligned sight. Watch it fall (it
  tracks `player.view.swayX`) rather than trusting one sample.
  **Alignment is not occlusion, and only the second question needs a picture**:
  a sight can read a perfect zero on both cross axes and still be looking at
  the weapon's own stock, which is exactly what the DMR's irons did.
  `optics.ts`'s `ironSightFloor` is what keeps geometry out of the aperture; a
  screenshot at `adsBlend === 1` is what confirms it.
- **Grenades are testable without waiting for a round to develop**, and should
  be: `g.grenades` (the debug handle's field) takes `throwAlong`/`throwAt`
  directly and `g.grenades.update(1/60)` steps the flight, so a whole
  detonation is a synchronous loop inside one `page.evaluate` rather than
  something you wait 2 fps for. Two traps. A bot you moved by hand has to be
  put back to `alive = true` between blasts — `takeDamage` kills it and
  `hittablesAgainst` then quietly leaves it out, which reads exactly like the
  falloff being broken. And "0 damage" at a plausible range is usually the
  line-of-sight ray finding a wall, not a bug: sample the same distance in all
  four compass directions before believing it.
- **The blast DUST is not steppable that way, and needs the particle clock
  pinned instead.** `g.grenades.update()` only ages the pool's bookkeeping —
  the puffs are simulated on the GPU, so they advance on RENDERED frames, by
  `updateSpeed * scene.getAnimationRatio()` each. Headless that ratio is the
  real frame delta (~30 at 2 fps, and unlike `dt` it is not clamped to 0.05),
  so a 2.4 s cloud is three frames and lands nowhere near the age you wanted.
  Override `scene.getAnimationRatio` with a value you control — 0 freezes the
  dust outright, and setting it to `seconds * 60` for exactly one rendered
  frame (count them on `scene.onAfterRenderObservable`) steps the cloud to a
  known age and holds it there for a screenshot. Two more things worth
  knowing: `dust.burst()` takes a real `Vector3` and nothing else, because
  `copyFrom` reads `_x`/`_y`/`_z` and a plain `{x,y,z}` silently gives a cloud
  at NaN; and `getActiveCount()` is the ring size rather than a count of live
  puffs, so it reads 34 for a cloud that faded out a minute ago.
- **The throw ANIMATION is a still-frame job, not a video one**, and 2 fps is
  plenty for it: redefine the clock the whole gesture is posed from
  (`Object.defineProperty(g.player, "throwT", { get: () => 0.145 })`, plus
  `throwPending` to `false` so the frozen frame does not also throw a real
  grenade) and screenshot each phase. Live-tune the hand's keys without a
  reload by writing `g.player.view.throwKeys[i].pos/rot` — they are resolved
  from `CONFIG` once at construction, so the poses are editable in place while
  the timing and the give are not.
- **The weapon SWAP is a still-frame job too, and its transient will fool the
  sight check.** Freeze it the way the throw is frozen — `swapPending = false`
  first (or `completeSwap` fires on every frame), then
  `Object.defineProperty(g.player, "swapT", { get: () => 0.34 * 0.42 })` — and
  the pose holds at the peak, which is where the frame has to be clear of the
  weapon entirely. The trap is the other way round: a swap taken just before an
  alignment reading leaves the weapon halfway back up, which measures as a
  sight ~0.22 m low and reads exactly like a misaligned optic. Watch
  `player.swapT` reach -1 AND the sway decay before believing a number; at
  headless frame rates that is several seconds after the button.
- **A ragdoll is steppable synchronously, like a grenade, and must be**:
  `g.ragdolls.update(1/60)` in a loop inside one `page.evaluate` runs a whole
  tumble, settle, sink and retire in a fraction of a second, where waiting at
  2 fps would take minutes. Set the body up by hand — move a bot, call
  `bot.takeDamage(999, shooterOrigin)`, then `g.ragdolls.spawn(bot, camPos)`,
  which returns whether it was accepted. Four traps. **Reading a rig joint's
  world position needs `computeWorldMatrix(true)` first** — outside the render
  loop `getAbsolutePosition()` returns a stale cache, and a joint that looks
  pinned while its proxy falls is that, not a broken hand-off. **A bot reused
  between takes has to be put back to `alive = true` with `hp` restored**, the
  same trap the grenade notes record. **The camera's pitch is negative for
  down** (`forward.y = sin(pitch)`), and placing test bodies along
  `cameraSys.forward` while it is pitched throws them into the air — build a
  horizontal basis from `aimYaw` instead. And **the settled pose is a numeric
  question before it is a visual one**: the joints' height spread says whether a
  body is face-down (all within ~0.01 m) or on its side (~0.5 m), which a
  headless screenshot at this scale will not.
- **The ash field is frozen for a pixel diff with `stop()` + `reset()`**, on
  `g.atmosphere.system` — it empties the field and, crucially, keeps it empty.
  That still holds now the field runs on `GPUParticleSystem`, but only because
  `Atmosphere` constructs it with `emitRateControl: true`: Babylon's legacy GPU
  mode keeps accumulating emissions while stopped, so under it the same pair
  refills the sky a second later. Do not change that option. Note the field
  takes `maxLifeTime` to reach its steady state, so let `getActiveCount()`
  settle before capturing anything that includes it. Read `system` through the
  handle each time rather than holding it: the buffer is sized to the applied
  `ParticleSpec`, so a *different* spec replaces the whole system (an unchanged
  one never does, which is what keeps an editor rebuild from blinking the sky
  out).
- The muzzle flash is unhittable at 2 fps (`gunfeel.flashTime` is 0.05 s of game
  time); force it with `player.flashRoot.setEnabled(true)` instead.
- Getting into `playing` takes an indeterminate number of Enter presses: the menu
  gates its confirm on `overlayT > 0.5` and headless frames are ~0.5 s apart, so
  press until `state === "playing"` rather than pressing twice. A LONG PRESS is
  what registers — `keyboard.press()` can put the down and the up inside one
  ~0.5 s frame gap, so the key set is empty on every `input.update()` and nothing
  happens however many times you send it. A long wait after getting in gets the
  player killed, which drops the state back to `deploy` and freezes the pose —
  override `player.takeDamage` if you need to stand still.
- The kit screen's turntable needs no clicking to reach: `g.openLoadout()` from
  the debug handle does it (from `menu` or `deploy` — assigning `g.state =
  "deploy"` first is the way in from a live round). The pose is readable rather
  than only visible — `player.view.inspectYaw`/`inspectPitch` for the angles, and
  `view.weapon.rotationQuaternion` must be **null** again after the screen
  closes or the carried pose will never come back. Re-run the sight-alignment
  check above after a session on it: a quaternion or a scale left behind by the
  turntable would show up there and nowhere else.

To inspect a model in isolation, drop a throwaway `modelviewer.html` + `.ts` at
the repo root (Vite serves it as a second page) with an `ArcRotateCamera` driven
by `camera.setPosition`.

## File tour

```
index.html                  # The head, and NO interface CSS — see "The
                            #   interface's CSS". The one inline rule is a
                            #   black background, so a dev reload does not
                            #   flash white before the modules evaluate.
main.ts                     # Bootstrap. Imports src/ui/base.css FIRST.
public/                     # Copied to dist/ VERBATIM — unhashed URLs that the
  manifest.webmanifest      #   manifest, index.html and a home screen all name
  icons/                    #   by hand. Generated by `npm run icons`.
src/
  config.ts                 # ALL tunable constants (no magic numbers in code)
  core/
    Game.ts                 # Orchestrator + game state machine + main loop
    InputManager.ts         # Unified keyboard/mouse + gamepad state + rumble
    CameraSystem.ts         # First-person cam at the eye; ADS zooms + slows
                            #   by whatever optic is fitted, and comes up at
                            #   the carried weapon's own rate
    Sfx.ts                  # Procedural WebAudio, spatialised and voice-capped
    settings.ts             # The player's display settings: the Settings
                            #   shape, its defaults and the localStorage round
                            #   trip. Applies nothing — that is
                            #   Game.applySettings, which is the ONLY place a
                            #   setting reaches whatever owns it
  entities/
    Player.ts               # Movement, sprint, jump, weapon state, viewmodel
    ViewModel.ts            # The first-person weapon: the carried gun + gloved
                            #   arms on the camera, hip/ADS/sprint/reload,
                            #   sway, bob, plus the kit screen's turntable.
                            #   Builds every weapon, enables one.
    weaponKit.ts            # The build accumulator every weapon model is
                            #   written in (colours, box/tube/pin/shell, the
                            #   per-colour merge) + the WeaponParts contract
                            #   and WeaponSights (a rail, or one fixed sight)
    RifleModel.ts           # Low-poly SCAR-pattern battle rifle
    SmgModel.ts             # Low-poly compact SMG — same contract, so the
                            #   viewmodel carries any of them
    DmrModel.ts             # Low-poly semi-auto marksman rifle — heavy barrel,
                            #   folded bipod, adjustable comb
    PistolModel.ts          # Low-poly 1911 sidearm. The one weapon that does
                            #   not call optics.ts: no rail, so its notch and
                            #   blade are its own and are all it ever wears
    optics.ts               # The three optic assemblies, built onto whichever
                            #   weapon's OpticMount asked for them
    weapons.ts              # WeaponId + the resolved WeaponSetup the player
                            #   and the camera run on, + the SIDEARM /
                            #   PRIMARY_WEAPON_IDS split (the kit's three)
    sights.ts               # SightId + the derivation from a sight's
                            #   magnification to FOV, sensitivity and the
                            #   viewmodel's zoom compensation
    GlbSoldier.ts           # UNREFERENCED since the first-person conversion —
    soldier/                #   the retired rigged GLB body and its pieces.
                            #   See "Project overview". Do not re-wire.
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
    GrenadeSystem.ts        # The one thing that isn't hitscan: thrown
                            #   grenades, their bounces, the fuse, the blast,
                            #   + BlastDust, the cloud it lifts off the ground
    RagdollSystem.ts        # Bot corpses under physics: the ONLY Havok in the
                            #   game, the only place a physics engine is
                            #   touched, and entirely optional — every refusal
                            #   falls back to Bot's collapse tween
    AimAssistSystem.ts      # Gamepad-only aim assist: an outer bubble that
                            #   slows the stick, an inner one that rotates —
                            #   mostly adhesion (matching the target's angular
                            #   velocity), a little magnetism. Bounded by the
                            #   player's own turn rate; inert without input
    LightingSystem.ts       # Dynamic point lights: fixtures, flashes, lamps
    ShadowSystem.ts         # Moon shadow map (stepped shadows) + blob shadows
    Atmosphere.ts           # Drifting ash particle field, simulated on the
                            #   GPU (transform feedback). No CPU fallback —
                            #   WebGL2 is a hard requirement and guarantees it
    Sky.ts                  # Generated sky: dome (gradient/galactic band/stars/
                            #   moon halo), textured moon, fBm cloud decks
    WaterSystem.ts          # Water surfaces from map WaterRects
  editor/                   # Dev-only map editor (F2). Dynamically imported —
    index.ts                #   never statically imported from anywhere else,
    EditorCamera.ts         #   or it lands in the production bundle.
    EditorPanel.ts          #   Free-fly cam drives CameraSystem's own camera.
    panel.css               #   The panel's styling — imported by EditorPanel,
                            #   so it rides the dynamic chunk and never reaches
                            #   a production build. Never link it from HTML.
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
    Ridge.ts                # The valley rim: the landform that closes the map
                            #   off. Shape only — VertexData out, no collider,
                            #   nothing inside ±size/2. See "The valley rim"
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
    maps.ts                 # MapDef (layout + environment + name) + the MAPS
                            #   registry. The ONLY file a second map touches.
    hollowmere/
      layout.ts             # THE MAP — every placement, flag and spawn
      heights.ts            # GENERATED floor heights (editor terrain mode)
      environment.ts        # Hollowmere's palette, fog, mist, particles
  ui/                       # One .css beside each module that writes markup.
    base.css                #   Reset, canvas, #hud root, and ONLY the
                            #   primitives two or more screens share (.frame,
                            #   .brackets, .hidden, --ov-scale, @keyframes
                            #   pulse, the kit button). Imported by main.ts.
    HUD.ts / hud.css        # The gameplay chrome ONLY: tickets, flags,
                            #   capture-zone panel, vitals, ammo, crosshair,
                            #   killfeed, scoreboard, world-anchored damage
                            #   arcs, + the .paused/.editing state rules
    OverlayScreen.ts        # The three full-screen cards — menu, round-over,
      overlay.css           #   pause — and the .overlaid class they raise
    DeployScreen.ts         # Top-down deploy map — click a marker or step the
      deploy.css            #   selection with the arrows/d-pad — + the deploy
                            #   and kit buttons
    LoadoutScreen.ts        # The kit screen: weapon slot, optic slot, the
      loadout.css           #   stat chart derived from CONFIG.weapons, and the
                            #   turntable stage — a hole in its own scrim, with
                            #   the live viewmodel posed on it
    SettingsScreen.ts       # The settings screen: a list of toggles over a
      settings.css          #   scrim, built from a ROW TABLE rather than
                            #   markup. Owns no setting — every pick leaves
                            #   through onToggle and comes back as setValues
    Minimap.ts              # Corner minimap: flags, friendlies, firing enemies
      minimap.css
  pwa/
    register.ts             # Service worker registration + the touch-device
                            #   fullscreen gesture. Knows nothing about the game.
    sw.js                   # The service worker, as a TEMPLATE — not typechecked,
                            #   never imported; vite.config.ts emits dist/sw.js
                            #   from it with the build's precache manifest.
  shaders/
    CelShader.ts            # Custom cel ShaderMaterial + outline helper
    WaterShader.ts          # Animated water ShaderMaterial
    GodRays.ts              # Moon shafts: screen-space radial blur of the
                            #   frame's bright pixels away from the moon
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

**`installMap` is the one place a map is built**, and both callers — a round
starting and an editor rebuild — go through it. It disposes the standing map,
builds `this.mapDef`, and hands the result to every system that reads geometry
or environment off it: shadows (casters, key light, fog range), atmosphere,
water, grass and the player's terrain. It used to be two copies of that
sequence that had already drifted apart, and the failure mode is silent in the
worst way — a system added to the round's copy and forgotten in the editor's
keeps a cached pointer into a *disposed* map, so the editor renders last
build's water over this build's terrain and nothing throws. **Anything new that
consumes a `GameMap` or an `EnvironmentSpec` goes in `installMap`.**

What stays with the callers is what they genuinely disagree about: the round
applies the environment and repaints the sky, while the editor drives
`applyEnvironment` itself so it can toggle its work light; and the round alone
owns what is about a *fight* rather than a map — battle, conquest, the flag
markers and the minimap.

`Game`'s state machine is `menu -> deploy -> playing`, with `deploy` re-entered
on every death and `roundover` when a side runs out of tickets. The 3D scene
renders in every state, which is what lets the deploy screen and the menu sit
over a live view.

**`loadout` and `paused` are lids, not steps in that cycle.** Each records
which state it covered (`loadoutFrom` / `pausedFrom`) and puts it back. The
loadout screen covers `menu` or `deploy`; a pause covers `playing` or `deploy`.

A pause taken while waiting out a respawn therefore returns to the deploy map
rather than dropping the player into the world.

Pausing is just `tick` not calling `updateGameplay` — everything else still
renders, so the round reads as held rather than gone —
plus two things that would otherwise leak past it: `Sfx.setSuspended` stops the
audio clock (the tail of the last shot is still there when you come back, and
the voice counter stays honest because nothing ends while the clock is
stopped), and the HUD is ticked with `dt = 0` so the killfeed and the toasts
freeze with the world instead of fading off a frozen screen.

**Losing the pointer lock is the trigger, and it has to be.** Escape belongs to
the browser — it is the UA's own gesture for dropping the lock and the keydown
behind it is not reliably delivered — so `Game` listens for the lock going away
and pauses on the *transition* out of it, which also covers alt-tab and any
other focus loss. A player who never took the lock (a pad player) has none to
lose, hence the transition test rather than a bare "not locked". `Escape` and
gamepad Start are the second trigger, through `input.pausePressed`. Start also
raises `confirmPressed` (it is the menus' deploy button), so the paused branch
handles pause first and breaks. Gamepad **B** resumes as well
(`menuBackPressed`), the same back it is on the kit screen. The list is
confirmed with `menuConfirmPressed` — Enter and pad A but *not* the mouse —
because a click on the empty half of a pause screen is not a menu choice. The
deploy screen follows the same rule for the same reason and one more: see
"Getting into a round".

`#hud.paused` is deliberately **not** `.overlaid`: the menu and the round-over
card hide the gauges because what is under them is last round's, while under a
pause the tickets, flags and vitals are current and frozen with the scene. What
it does hide is what would be lying — the crosshair, the hitmarker, the damage
arcs and the "click to capture the mouse" hint. It is also the one overlay that
takes pointer events across its whole area, because the deploy screen
underneath takes them too and a click through the backdrop would land on its
map or its Deploy button. Re-taking the lock on resume tolerates a rejection: Chrome refuses one
for about a second after Escape released it, which is exactly the sequence a
pause ends with, and the next click gets it.

`Game.updateGameplay` has a load-bearing order at the end of the frame: camera
update → `mats.updateCamera()` → carried-light updates → `lighting.update(dt,
camera.position, mats)` → `sfx.setListener()`. Light slot selection, shader fog,
and audio panning all key off the camera position, so anything that moves the
camera must run before them.

`ConquestSystem.update` runs *before* `BattleSystem.update`, so a bot's think
tick sees this frame's flag ownership rather than last frame's.

### First person, and the weapon on the camera

The camera sits **at `Player.eyePos`** — the same point `CONFIG.camera.eyeHeight`
defines and the same point bots test line of sight against, so what a bot can
see of you is what you can see of it.

**Crouch is that one point moving, and it only works because it is one point.**
Asking for crouch eases `eyePos` down to `CONFIG.player.crouchEyeHeight`, which
lowers the camera, breaks a bot's line of sight and moves its aim point all at
once — so ducking behind a waist-high wall genuinely breaks contact rather than
looking like it does. The catch is that `Player.center` must come down the same
half metre (`crouchCenterHeight`), and forgetting it inverts the whole feature:
bots aim at `eyePos` and hit-test against the sphere at `center`, so a dropped
eye against an unmoved sphere puts every incoming round through the middle of
the target instead of grazing its top, and crouching makes you *easier* to kill.
The two numbers are chosen to keep the sphere's top the same 0.05 m above the
eye it is when standing — the same visible-but-unhittable trap `CoverMap`'s
`hardHeight` documents from the other side. The collider capsule is deliberately
*not* resized: `moveWithCollisions` is horizontal-only and the ground probe
places the feet, so a shorter body would buy nothing and would owe a stand-up
clearance test. Sprint outranks crouch and is resolved first, so the two can
never argue over the blend.

**It is asked for two ways, and the split is per input rather than per player.**
Ctrl is a hold — the crouch taken for one corner, where letting go is how you
stand up — while `C` and the pad's **B** flip a latch, for the crouch held
through a firefight; on a pad that is the only workable shape, since B held
rules out the rest of the face buttons. Both toggles share ONE latch in
`InputManager`, so either can answer the other, and the hold simply ORs on top
of it. The cost is that B is also the menus' back button: a press that lifts
the pause lid or closes the kit screen flips the latch behind it, so
`Game` calls `input.clearCrouchToggle()` wherever a B press hands control back
to gameplay (a B resume) and on `spawnPlayer` (a fresh body neither crouches
nor runs).

**A latch is spent by whatever overrides it, never suspended under it**, and
that rule is what keeps two toggles from stacking up a stance the player has
stopped asking for. Starting to run spends a latched crouch (so a sprint does
not drop you back into a crouch you asked for before it) and ending a run
spends the sprint latch (so a pad player who stops for a corner walks out of
it rather than sprinting the moment they touch the stick). Pressing either
latch clears the other outright, since the two stances are exclusive and the
one asked for second wins. `Player.update` is where the two edges live,
because `input.sprint`/`input.crouch` are only the *ask* — the stick, the
optic and the reload are what decide whether a sprint is happening — and it
calls back into `InputManager.clearCrouchToggle`/`clearSprintToggle` on the
transitions. **Held keys are exempt**: Shift and Ctrl are a live ask rather
than a latch, so a Ctrl held through a sprint still crouches you when the
sprint ends, and nothing here can clear a key that is still down.

Bots have no equivalent — their rig has no knees
(see `CoverMap`), and this is player-only. There is no occlusion pick and no pull-in
any more: the old shoulder camera had to ray-test its way out of walls, and a
camera inside the head has nothing to be occluded by. There is also **no player
body mesh at all**. The only things the player renders are the viewmodel, its
brass, and the blob shadow `ShadowSystem` draws underfoot.

`src/entities/ViewModel.ts` owns the weapon: the carried gun plus two gloved
arms, parented to the camera and posed in camera space. Four things there are
load-bearing.

- **The aimed pose is derived, not authored.** `adsPos` cancels the FITTED
  sight's own `sightCenter` offset (times `viewmodel.scale` — the node's
  position is in the camera's frame while the sight's offset is in the weapon's)
  so that sight's reticle lands on the camera axis at its own
  `CONFIG.sights[id].eyeRelief`. The reticle then projects to the exact centre
  of the screen, which is where `CombatSystem` sends the bullets. Hand-tuning
  that offset — or forgetting the scale factor, which puts the sight a couple
  of degrees low — gives a sight picture that looks plausible and shoots high.
  It is verifiable: at `adsBlend === 1` the reticle's offset from the camera
  axis is exactly zero. `applyFit` is the only thing allowed to write it, and
  it owes a re-derivation on every loadout change — **including a change of
  weapon**, because the same optic sits at a different height on each one.
- **The viewmodel renders in `VIEWMODEL_GROUP` (1).** Babylon clears depth
  between rendering groups, so the weapon draws over the world instead of
  intersecting the wall the player is standing against. Anything attached to
  the weapon has to join that group — Player's muzzle flash does; the ejected
  brass deliberately does **not**, because it is thrown into the world and
  should be occluded like anything else.
- **Scale and stand-off are a framing decision, not realism.** A 54° vertical
  FOV against a real eye's ~130° means a rifle framed where a rifle actually
  sits fills the screen. `viewmodel.scale` shrinks it and `hipPos.z` pushes it
  out until it reads at the size the eye expects. That pose is authored for the
  rifle's length, so a shorter weapon adds its own `hipZ` to pull it back in —
  otherwise an SMG reads as being held out at arm's length.
- **The camera owns the bob phase; the weapon reads it.** Both bob on the same
  drive, and two integrators fed the same number drift apart — the weapon would
  visibly swim against the view. `Player` pushes the drive with
  `cam.setBobDrive()` and passes `cam.bobPhase` straight through to the
  viewmodel. Player runs before the camera in the frame order, so that phase is
  one frame old, which is 16 ms of an ~0.8 s cycle.
- **Footsteps are a third reader of that phase, never a step timer.** The
  camera's vertical bob is `sin(bobPhase * 2)`, so its two dips per stride —
  3π/4 and 7π/4, where the head is lowest and a foot is taking the weight — are
  where the sound goes; a step heard off the beat of the dip you can see is
  worse than no step at all. Cadence therefore comes free: the bob stalls when
  the player stops or leaves the ground, and `camera.bobCrouchMult` already
  halves it in a crouch. It also means **sprinting does not step faster** — the
  drive is movement *intent*, which is 1 at a walk — so a sprint is louder
  boots at a walk's cadence (measured: 2.55 steps/s either way, a 2.0 m stride
  walking against 2.6 m sprinting). Speeding the gait up means speeding the
  camera's bob up with it. `Player.update` returns these as `PlayerEvents`
  (`jumped` / `footstep` / `landed`) rather than playing anything: `Sfx` is
  Game's, and the same split is why bots emit `onStep` and let
  `Sfx.botStep` decide, from the listener position, whether it is audible.
- **A landing is an arrival, and it is spent in two places.** The ground
  probe's `stepHeight` tolerance is what keeps the feet glued walking down a
  kerb, and it is **grounded-only**: extended to a body in the air — which is
  what testing `velY <= 0` did — a jump lands a full 0.6 m early and is
  teleported the rest of the way in one frame. Measured, that was a **0.656 m
  single-frame drop against a physical maximum of 0.14 m**, over a third of the
  jump's own height, and it read exactly like a dropped frame. Airborne, the
  landing is where the feet meet the floor and the snap resolves one frame of
  overlap. What replaces it is `CameraSystem.land()`: a damped spring given a
  downward *velocity* scaled by impact speed, so the eye sinks ~6 cm over 67 ms
  on a plain jump, rebounds ~1 cm and is settled inside half a second. The
  camera owns that spring and the viewmodel READS `landDip` — one integrator,
  the same rule as the bob phase. The nod and the roll are damped by
  `land.adsMult` while the dip is not: the eye dropping is parallax and moves
  nothing, while the rotations swing the picture off rounds that still fly
  along the un-nodded `forward`. **The roll needs
  `camera.updateUpVectorFromRotation`**: `rotation.z` reaches the view matrix
  only through the camera's up vector, and Babylon otherwise treats that vector
  as state it refreshes on the frames the roll *changes* — baking in the yaw
  and pitch of that frame along with it. So the frame a landing settled on left
  a stale up vector standing for the rest of the round: no tilt where you
  landed, and a growing one as you turned away from it, which read as the camera
  being stuck tilted after a jump. The flag derives it from `rotation` every
  frame instead. **The viewmodel's airborne give is sprung for
  the same reason the landing is**: `velY` is a step function at both ends of a
  jump, so a give read straight off it snapped `airDropMax` back to neutral on
  the contact frame.

The bob and the view punch move the **rendered camera only** — `aimPitch`/
`aimYaw` never see them, so bullets don't bob.

**The aimed hold sway is the one thing on the camera that is not cosmetic, and
it has to be.** An aimed weapon wanders — two sines an axis, the pitch term
breathing at ~0.23 Hz and the yaw term at half that, so the pair traces a slow
figure-eight rather than a line — and it is added to `aimPitch`/`aimYaw`, where
the bullets, the aim assist and the damage arcs all see it. The alternative is
the trap: the viewmodel is parented to the camera, so a wander applied to the
rendered camera alone would slide the *world* behind a sight that is still
welded to the axis the rounds fly down. The reticle would look alive and lie.
Applied to the aim, the same picture is honest — the sight stays centred, the
world drifts, and what you shoot is what is under the reticle. It rides the ADS
blend, so hip fire is untouched (a drift you have to fight while running is
nausea, not texture), and it is an *offset*, never integrated into `pitch`/
`yaw`, or a held aim would walk away on its own. Three things scale it:
`CONFIG.weapons[id].swayMult` (mass in the hands — the DMR is steadiest at 0.7
because sway is angular and its scope magnifies it 3.5x), and the stance
multipliers `Player` pushes through `setSwayDrive` — moving costs, crouching
buys. It is deliberately **not** normalised by magnification the way the ADS
look rates are: a sight magnifying your unsteadiness is the trade it is asking
you to make.

`Player.setBodyHidden` now hides
the viewmodel, which matters in the editor: it flies the same camera the weapon
is parented to, so a visible rifle would ride along in front of it.

### The loadout: three weapons, three optics, and a sidearm

Two tables, two slots, and neither knows about the other. `CONFIG.weapons`
declares what can be carried and `CONFIG.sights` what can be bolted to it;
`entities/weapons.ts` and `entities/sights.ts` derive `WeaponId`/`SightId`
**from those tables**, so each is declared in exactly one place. Every weapon
*with a rail* takes all three optics, which is not a shortcut — an optic is a
thing on a rail, and every weapon the kit offers has one. The sidearm does not,
and "The sidearm" below is that whole exception.

**A weapon owns the round; an optic owns the picture.** Damage, rate, magazine,
spread, range and the recoil multipliers are the weapon's and reach nothing but
`Player`; magnification, eye relief and the aimed FOV are the optic's. They meet
in exactly two places, and both are deliberate: the aimed pose (the optic's
`sightCenter` on *this* weapon's rail) and the ADS blend RATE, which is the
product of the optic's `adsSpeedMult` and the weapon's — how fast a sight comes
up is a fact about the weight in your hands as well as the glass on top.
`swayMult` is the third weapon number that leaves `Player`, and it is not a
meeting: how steady a weapon is to hold is the weapon's alone, and the optic
only decides how much of that wander you are shown.

Everything about an optic still falls out of one number, `magnification`: the
aimed FOV is `2*atan(tan(fovHip/2) / mag)`, the ADS look multipliers are
`camera.adsLookMouse|Stick / mag` (so the crosshair crosses the *screen* at the
same rate through any optic — a 3.5x scope on the hip-fire rates is unusable),
and the viewmodel's zoom compensation is `adsMagReference / mag`. The holo is
1.6, which is exactly the 0.62 rad the camera used before optics were a choice,
so the rifle with a holo reproduces the shipped weapon frame for frame.

A weapon's own numbers work the same way, against `CONFIG.recoil` rather than
restating it: `recoilMult` and `bloomMult` SCALE the per-shot terms, because the
shape of recoil (how much springs back, how fast, where it is capped) belongs to
the game. `bloomMult` multiplies the *ceiling* as well as the per-shot term —
a weapon that blooms faster has to be allowed to bloom further, or the extra
rounds per second cost it nothing after the second shot.

The two automatics are balanced on time to kill, not on damage per second: 4
rifle rounds at 8/s is 0.375 s, 6 SMG rounds at 13/s is 0.385 s. What the
choice between them actually buys is how much of the screen a burst covers, and
how far away it still means anything.

**The DMR is the one weapon that steps outside that**, and `semiAuto` is why it
can. Two rounds at 3/s is 0.333 s — the best ideal time to kill in the kit —
but the rate is a *ceiling on the trigger finger* rather than a cadence, and
the error budget is what pays for it: a missed rifle round costs 0.125 s and a
missed DMR round costs 0.333. Its `recoilMult` of 2.2 is the second half of
that bill. Only 70% of a kick springs back (`recoil.recoverFraction`), so a
third of a second after a shot roughly 1.2 deg of it is still on the aim, and a
follow-up taken at the weapon's full rate goes high unless it is pulled down by
hand. That also makes `bloomMult` cheap to set high: at any deliberate pace the
bloom has bled off before the next round leaves, so only trying to run the
weapon as an automatic ever finds the ceiling.

The latch itself lives in **`Player.tryShot`, which takes the trigger rather
than being called behind it**. A semi-automatic has to see the trigger come
*up* — the release is what arms the next round — and a caller that only speaks
while the trigger is down can never report one. The latch is set *before* the
alive/reloading/sprinting guards, so a trigger held through a reload does not
fire the instant the reload ends.

Eight things are load-bearing:

- **Every weapon and every optic is built once, and all but one of each is
  `setEnabled(false)`.** A loadout change is a handful of boolean writes and a
  re-derived `adsPos` — never a rebuild, which would have to happen inside a
  deploy screen and would drop Player's muzzle flash on the floor.
- **The muzzle and the ejection port are the VIEWMODEL's nodes, not the
  model's.** A model's landmarks are `Vector3`s and `ViewModel` moves its own
  two nodes to whichever weapon is carried. Player's flash is parented to one
  and its brass thrown from the other, and neither may hang off a rig that can
  be switched off underneath it.
- **Each weapon carries its own arms.** Where a hand grips is the model's
  business (`WeaponParts.grip`/`support`), and the forearm's geometry is baked
  along the hand-to-elbow line, so an arm cannot simply be translated onto a
  shorter gun. One pair of merged meshes per weapon, one pair enabled.
- **Zoom compensation is a uniform scale about the camera's origin.** Past
  `viewmodel.adsMagReference` the weapon is scaled down *and* drawn
  proportionally closer — `adsPos` and `weapon.scaling` take the same factor —
  which changes no ray direction, so the sight stays exactly on the axis and
  only the apparent size of the weapon is held still. Without it a 3.5x optic
  magnifies the receiver across the whole screen along with the world.
- **The additive pose offsets take that factor too** (`ViewModel.off`). Sway,
  bob, the airborne give and the kick are metres in the *camera's* frame, and a
  compensated weapon is a weapon drawn closer, where the same metre is a much
  bigger angle. Left unscaled, a flick of sway that nudges the holo's picture
  swings the scope's bore clean off the axis. Rotations are deliberately
  exempt: the weapon turns about its own root, so the displacement a given
  angle produces already scales with the model.
- **The scope is a real hollow tube, so its own weapon can get into the
  picture.** A view cone spreads with distance and runs onto the barrel — a lit
  muzzle device sitting inside the sight picture. The tube's height above the
  rail, its length and the scope's omission of the folded front iron are all set
  by that one constraint, not by looks. How much of the frame is clear is set by
  the far rim's angular size, which is why a long eye relief turns the sight
  picture into a keyhole.
- **An optic's size and its eye relief are ONE number, and the pair is why the
  sights are as small as they are.** Everything the eye gets from a sight is
  angular — the bore's half-angle at the eye — so halving an optic *and* the
  distance the eye is held at leaves the picture identical to the pixel while
  the thing bolted to the weapon is half the size. `optics.ts` therefore
  measures every dimension against `eyeDistance(id)`, which is
  `CONFIG.sights[id].eyeRelief / viewmodel.scale`, and changing one of the two
  alone re-sizes the picture instead of the sight. The optics were originally
  sized for an eye held a rifle's length back, which is what made every one of
  them wider than the receiver it stood on. Two floors bound how far this goes:
  the camera's near plane (`minZ` 0.05, against a stand-off of `eyeRelief *
  zoomComp` — the scope's 0.17 buys ~0.02 m of margin) and the view cone's
  clearance over the weapon's own rail, which is what the rises are.
- **A straight tube is the worst shape to spend the cone on.** A cylinder wide
  enough not to clip the cone at the objective is far wider than the cone needs
  at the eyepiece, which is how the scope became a drainpipe. It is built as
  `SCOPE_SECTIONS` steps instead, each only as wide as the cone is at *its* far
  rim, so the body flares from eyepiece to objective the way a real one does.
  Anything clamped to or standing on the tube is sized by `outerAt`, which
  reports the section's radius rather than the cone's where it happens to sit.

**The optics are built against the weapon, not for it.** `optics.ts` takes an
`OpticMount` — the height of that weapon's rail, where along it the sight sits,
and its two back-up iron stations — and measures everything from those four
numbers. So the SMG's lower receiver and the DMR's deeper one carry the same
three sights with nothing re-tuned, and the derived `adsPos` puts each one on
the axis wherever it lands. Adding a weapon is a config entry, a model builder
returning `WeaponParts`, and an `OpticMount` — or, for a weapon with no rail, a
`fixed` sight assembly of its own instead of that mount; adding an optic is a
config entry and a builder in `optics.ts`.

**The mount is not free, though, and the DMR is where that shows.** Two of the
four numbers are bounded by the optics rather than by the receiver: the view
cone spreads with distance from the eye, so past a certain z it is looking at
the weapon's own rail. The scope's cone reaches the rail's ribs at about
z = 0.59 and the holo's reaches the FOLDED front iron leaf at about z = 0.53,
which is why the DMR's rail stops where it does and why its front iron station
sits no further out than the rifle's despite a longer receiver. A marksman
rifle wants the longest sight radius it can get; what it can actually have is
whatever leaves the sight picture clear, and the extra radius therefore comes
out of the rear station instead. `DmrModel.ts`'s `MOUNT` documents both.

**The irons bound the weapon from the other end too, and that is what the
stock's heights are.** An aperture's eye relief is over half a receiver's
length, so the eye sits BEHIND the butt: everything on a stock stands between
the eye and the rear sight, in the one part of the picture there is no looking
around. `optics.ts` exports `ironSightFloor` — the underside of the cone from
the eye to the rear ring's bore — and `DmrModel` derives its comb from it, with
the butt and the spine hung off the comb in turn. A scope's cheek riser over
that line does not clip the sight picture, it *is* the sight picture, which is
what the DMR shipped with. A comb is adjustable precisely because irons and
glass want the cheek at different heights; this is it at the bottom of its
travel. Forward of the rear station the same cone runs onto the rail and the
front sight's base, and that is correct — what you see under the post through
an aperture is meant to be the weapon.

#### The sidearm

**Every loadout carries a pistol, and there are two ways to reach it.** The
mouse WHEEL swaps to the other weapon and so does pad **Y**; the `1` and `2`
keys name a slot outright (primary, sidearm). The split is the point — the
wheel is what a keyboard-and-mouse player already reaches for and costs nothing
here (a weapon is the only thing a wheel could mean in this game, and there is
no page under the canvas to scroll), while the numbers are what you press when
you have lost track of what is in your hands. `drawSlot` refuses a request for
the weapon already up, so a second press of `1` costs nothing rather than
replaying the animation. `InputManager` normalises `deltaMode` and gates on
`input.wheelStep` before calling a wheel event a notch: a trackpad's inertial
fling would otherwise swap the weapon over and over for a second after the
fingers lift. Note the number keys sit in the trap `BOUND_CODES` documents —
crouch is Ctrl, and Ctrl+1/Ctrl+2 are browser tab switches no page handler ever
sees — which is the other reason the wheel is named first.

The pistol is an ordinary `CONFIG.weapons` entry — it fires, reloads, blooms
and kicks through the same numbers as everything else — and the only thing
that makes it a sidearm is `entities/weapons.ts` keeping it out of
`PRIMARY_WEAPON_IDS`. That split is the one place the distinction is stated:
the kit screen offers the primaries, `SIDEARM` names the other one, and the
stat chart ranks against the primaries alone, because a bar scaled by a weapon
nobody can decline says nothing the player can act on.

What it buys is not damage — 25 a round at 5.5/s semi is the worst time to kill
here — it is `drawTime` 0.34 against the rifle's 0.55. **There is no reserve
ammunition in this game**, so a magazine that runs dry is the problem the second
slot solves: a swap is a third of a second to a loaded weapon where a reload is
one and a half. Take that away (by refilling a slung magazine, or by making the
draw as slow as a reload) and the whole feature has no reason to exist.

Seven things are load-bearing:

- **The two slots are an ARRAY, indexed by exactly the number on the key.**
  `PRIMARY_SLOT` is 0 and `SIDEARM_SLOT` is 1, so what `1` and `2` name and
  what `Player.slot` holds are one fact with no table in between. `drawSlot`
  is the single entry point and `swapWeapon` is "the other index".
- **Each slot keeps its own magazine, in a `Holster`.** A weapon put away
  half-empty comes back half-empty. `Player.ammo` is an accessor onto the
  carried holster rather than a field, so there is no mirrored count for a swap
  to keep in step. Both are refilled by `fullReset` and by nothing else — the
  slung one has to be refilled explicitly there, since only the carried weapon
  is reachable through `startReload`.
- **The swap is a gesture with the exchange buried inside it**, the same shape
  as the grenade throw: `Player.swapT` counts up, the pose is a TRIANGLE that
  takes the weapon fully out of frame, and `completeSwap` fires at
  `viewmodel.swap.switchFrac` — at the peak, where nothing is on screen to see
  the models change. The drop has to clear the bottom edge (see the note on
  `viewmodel.swap`, which sizes it against the FOV) or the swap is one model
  popping into another.
- **Nothing fires or reloads while it is in flight**, and a reload in progress
  is cancelled rather than remembered — the magazine being worked on is going
  away with the weapon. The trigger latch deliberately survives, because it
  belongs to the finger rather than to the weapon.
- **Its glass is not a choice, and that is a SHAPE rather than a convention.**
  `WeaponParts.sights` is a `WeaponSights` union: `fitted` (a rail — one
  assembly per optic, the kit picks) or `fixed` (the notch and blade machined
  into the slide). `wornSight` resolves the fitted request into the worn answer
  and `ViewModel.applyFit` is its only caller, which is what keeps the aimed
  pose, the zoom compensation and — through `carriedSight` — the camera's own
  FOV all derived from one sight. A pistol aimed down a 3.5x scope's FOV is
  exactly the mismatch the union makes impossible to spell.
- **`Player.onCarryChanged` is how the rest of the game hears about it.**
  `Game.applyCarry` pushes the camera's fit and the HUD's caption, and all
  three things that change the hands — a kit pick, a swap completing, a fresh
  body coming up with the primary — reach it without any of them remembering
  to. `applyLoadout` is still the kit's own path; the deploy screen and the kit
  screen keep naming the PRIMARY, because that is what they are for.
- **`hipY` is the sibling of `hipZ`, and the pistol is why it exists.** The hip
  pose is authored around the reference weapon's bore, and every long gun here
  carries its bulk *above* that line. A pistol hangs below it, hands and all, so
  at the shared height it falls off the bottom edge and reads as a dark sliver
  in the corner. Measured on a 1280x720 frame: without it the grip and both
  fists are outside the frustum.

`PistolModel.ts` is the one weapon builder that does not call `optics.ts`, and
that is the union's whole point rather than a shortcut: a 1911 has no rail, and
what stands on the back of its slide is a square notch, not the rear aperture
every optic here is built around. The rule that matters is still obeyed — it
reports a `sightCenter` and `applyFit` derives the aimed pose from it exactly
as it does for a holo — so the eye reference is not duplicated; only the
geometry in front of it is the weapon's own.

The screen itself (`src/ui/LoadoutScreen.ts`) owns its own DOM under `#hud` and
is a `loadout` game state — a lid over `menu` or `deploy` that remembers which
(`loadoutFrom`) and puts it back, the same shape as `paused` and for the same
reason. It is reachable from the **main menu and the deploy screen** (a button,
`L`, or gamepad X) and deliberately not from the pause menu: a round you are
already standing in is not somewhere you get to change what you are carrying.
Nothing enforces that with a flag; the states that offer the button are the
states that read `loadoutPressed`. Every pick applies immediately through
`Game.applyLoadout` and persists to `localStorage` the same way the difficulty
tier does — there is nothing to confirm, so confirm just closes.

Two details there are not decoration:

- **The stat bars are derived from the table**, each weapon's figure against the
  best any weapon has, so a third weapon re-scales the chart instead of dating
  it. Accuracy is the aimed spread *inverted* — a bar that grew with the number
  would rank the SMG as the accurate one.
- **The buttons that OPEN the screen fire on `pointerdown`, not on click.** The
  menu's confirm is "a mouse button went down anywhere", read from the button
  mask on the next tick, which happens before a `click` (which lands on mouse
  *up*) ever fires. Changing the state on the down edge is what stops the click
  that asked for the loadout from also deploying the player out from under it.
  Buttons *inside* the screen can use `click` safely, because by then the button
  is already back up.

On the keyboard and the d-pad the screen splits the axes: up/down chooses which
slot is being edited, left/right steps through it. The menu behind it keeps
left/right for difficulty. Enter, pad **A**, pad **B** and `L`/pad X all close
it — every pick is already applied, so there is nothing for a confirm and a
cancel to disagree about, and B is what a pad player reaches for.

### Grenades

Everyone carries two and there is no resupply, so the pouch is refilled by
death and by nothing else — `Player.fullReset` and `Bot.spawn`. That scarcity
is the design: two a life makes each throw a decision rather than a second
trigger, and it is why nothing here needed an ammo economy to be built first.

**This is the only thing in the game that is not hitscan**, and everything
about `src/systems/GrenadeSystem.ts` follows from that one fact.

- **It collides with ONE ray per grenade per frame**, cast along the step and a
  radius past it so a fast grenade cannot tunnel between two frames, filtered
  on `metadata.solid === true` — the same collider proxies bullets stop on,
  never the visuals. There are at most a handful in the air, which is the whole
  reason that ray is affordable where a per-bullet one would not be. A reported
  normal facing *away* from the grenade is flipped before the bounce: a
  collider's back face is what a grenade thrown from inside a doorway finds,
  and bouncing off one drives it straight through the wall it just hit.
- **A slow grenade on a flat surface is parked outright** (`resting`). A body
  that micro-bounces on a floor never settles, and one that never settles never
  stops paying for its collision ray.
- **`TerrainField` is a backstop under the colliders, not the floor test.** The
  terrain blocks are `solid` and the ray normally finds them; the clamp is
  there so a grenade that slipped past a seam ends up on the ground rather than
  falling out of the world with a live fuse. It uses `heightAt`, so it can sit
  a fraction under the *drawn* surface — which is fine for a backstop and would
  not be for anything that has to line up (see `terrainSlab`).
- **The blast resolves against the THROWER's target list**, fetched at
  detonation rather than at the throw — a grenade is in the air for seconds and
  the roster it goes off among is not the one it left the hand among. Friendly
  fire is therefore excluded by construction, exactly as `CombatSystem.fire`
  excludes it, and a grenade cannot hurt its own side including the thrower.
  That is a game decision: the alternative is bots routinely killing their own
  squad with a lobbed frag.
- **Damage needs line of sight from the blast centre** — one ray per victim
  already inside the radius, which is bounded by how few things are ever that
  close. Measured on the shipped map: 130 at the epicentre, flat inside 2.6 m,
  falling linearly to 0 at 8.5 m, and blocked outright through a wall.
- **The pool REFUSES rather than stealing a live slot**, and both callers spend
  their grenade only after it has accepted. A count debited for a throw that
  never arrived is the most confusing thing this could hand a player, which is
  why `Player` splits `canThrowGrenade` from `spendGrenade` and why `Bot`
  decrements after `ctx.throwGrenade` returns true.

**The blast is a fireball, embers and DUST, and the dust is the half that
outlives it.** The fireball is 0.42 s and the embers read as debris thrown out;
`BlastDust` (in `GrenadeSystem.ts`) is what the blast lifts off the ground — a
few dozen soft quads expanding, slowing and fading over `dust.life`, not
emissive, `BLENDMODE_STANDARD`, tinted from the map's own `mistColor` toward its
key light. It is a GPU burst rather than a pooled mesh, and that is affordable
for the same reason the blast light is exempt from `spendMuzzleLightBudget`:
there are seconds between detonations. **This is the one place a GPU particle
system is allowed to be spawned per event** — the rule against it (muzzle smoke,
brass) is about per-shot effects at eighty shots a second. Six things there are
load-bearing, and four of them are Babylon's rather than the game's:

- **It is a POOL of GPU systems, one per concurrent cloud, and it cannot be
  one system holding all of them.** In emit-rate-controlled mode a
  `GPUParticleSystem` re-emits into a ring of `max(emitRate * maxLifeTime, this
  frame's emission)` slots from a circular write pointer. `emitRate` is zero
  here — that is what makes it a burst rather than a field — so the ring is
  exactly one `manualEmitCount`, and a second blast inside the first cloud's
  life would write over the first cloud's slots and pop a standing cloud off
  the screen. `Atmosphere` documents the other side of the same invariant.
- **A stopped system refuses manual emissions too**, so `stop()` is not a way
  to hold a burst system idle: the update shader gates its emit branch on
  `stopFactor != 0`. Each system is started once and left started; with
  `emitRate` at zero an idle one emits nothing and costs nothing.
- **`updateSpeed` is `1/60`, which is what makes the numbers mean what they
  say.** The GPU clock advances by `updateSpeed * scene.getAnimationRatio()`
  per frame and that ratio is `dt * 60`, so at `1/60` a lifetime is seconds and
  an emit power is metres per second. (`Atmosphere`'s 0.012 is deliberately not
  that.)
- **The fade cannot be curved.** `addColorGradient` on a GPU system in Babylon
  9.19.1 throws on the next render and takes the whole scene's rendering down
  with it — a black frame, not a fallback to the ungraded colours. Size and
  velocity gradients on the same system are fine. So alpha runs linearly from
  `color1`/`color2` to `colorDead`, and `dust.opacity` is set for how the cloud
  reads at half life rather than at birth.
- **The cloud is lifted off the detonation** (`dust.lift`). A puff is a
  billboard metres across, so one centred where the grenade actually went off
  has its lower half under the cobbles and the whole thing reads as a smear
  painted on the street. Only the cloud moves — the damage, the light and the
  embers still resolve at the blast.
- **Its colour is the map's, and reaches it through `installMap`**
  (`grenades.setEnvironment`) — the same place `grenades.reset()` clears the
  standing clouds, and for the same reason it clears the grenades.

**The player's throw is a GESTURE with a release inside it, and that is what
stops it reading as a second trigger.** It was once an event: the button spent
a grenade, the body appeared on the camera axis on that same frame, and the
weapon dipped and recovered on a bell curve. Every one of those three is what a
muzzle does, and players read it as the rifle firing the grenade. What replaced
it is a timeline (`CONFIG.viewmodel.throw`) owned as a clock by `Player`,
counting up from the button rather than decaying from it:

- The **off hand comes into frame holding the frag** — the throwing arm is
  `ViewModel`'s, one rig shared by every weapon, parented to the camera rather
  than to the weapon (which is tipping out of the way at the time) and disabled
  whenever no throw is in flight. Seeing what is about to be thrown is the
  whole job of the wind-up, so the cocked pose keeps the fist and the ball in
  frame.
- The **support hand goes with it.** It is the same hand, so leaving it on the
  handguard puts two left arms on screen — and hiding it is what motivates the
  weapon's give, which is now held for as long as the hand is away instead of
  arcing back like an impulse.
- **The grenade leaves the HAND**, at `throw.windup`, from
  `ViewModel.throwHandWorld()`. `grenade.handAhead` survives only as a floor on
  that point (a throw taken with a wall at your shoulder must not spawn inside
  the wall); `handSide`/`handUp` are gone, because a point measured off the eye
  is exactly the thing that read as a muzzle.
- `Player.beginThrow` books the ARM (the cooldown) and `spendGrenade` still
  books the grenade at the release, so a pool refusal costs a cooldown and
  never a count. `throwReleaseDue` is the single consumed edge that says the
  hand got there, and it is false if the player died mid-wind-up.
- The eye's own follow-through goes through `CameraSystem.land`, the same
  spring as a landing and a blast concussion. One integrator, three callers.

Two things about the arm are learned rather than authored, and both are
recorded where they are set: **the elbow must leave the frame at every pose**
(the forearm ends at a flat cut, and a cut end standing in open screen is a
floating log, not an arm), and **the hand cannot be posed at the distance a
real one would be** — at 0.35 m the fist and the frag fill a quarter of the
screen. Both are in `viewmodel.throw`'s note and on `THROW_ELBOW`.

**The player throws where they are looking; a bot says where it wants the
grenade to land.** Those are the two public entry points (`throwAlong` /
`throwAt`), and the ballistics live behind both. `throwAt` is the low arc of the
standard solve and returns false when the throw cannot be made at
`throwSpeed` — which is exactly what an AI needs to hear, since the alternative
is a bot lobbing grenades that land at its own feet. Two consequences worth
knowing:

- **`throwSpeed` is bounded from below by the bots, not by the player.** A
  projectile's flat range is `v^2 / g`, so 24 against a gravity of 18 reaches
  32 m and `grenade.bot.maxRange` (30) has to fit inside that or every AI throw
  is refused. Measured: 8/12/20/28 m all solve, 34 m refuses.
- **A solved throw lands slightly long**, because the fuse outlives the flight
  and the grenade rolls, and `friction` is tuned against that rather than
  against the bounce. Measured on flat ground: 0.7–1.8 m past the aim point
  across the whole 11–30 m band, well inside the bots' own scatter. At the 0.5
  it started on, a bot's grenade skated 4–6 m past its target. In the village
  the same throws land further out, and that is the walls and the banks doing
  their job rather than solve error.

**The range band IS the bots' self-preservation.** A bot has no idea how far its
own blast reaches — there is no self-damage to teach it and no rig pose that
could sell taking cover from its own frag — so it is simply never allowed to
throw at anything nearer than `minRange`. Skill scales the *chance*, not the
accuracy: an ace throwing wildly is indistinguishable from a rookie doing the
same, while an ace throwing more often is a squad that starts using grenades
once it has been held up, which is what the player actually reads.

Three things elsewhere are part of this and easy to miss:

- **The blast light is deliberately outside `spendMuzzleLightBudget`.**
  Transients always win a shader slot and the budget exists because sixteen
  bots firing is up to eighty flashes a second; there are seconds between
  blasts, so one slot each is never what blacks the village out.
- **The camera's concussion reuses `CameraSystem.land()`.** The eye taking a
  pressure wave and the eye taking a landing are the same damped spring, and a
  shake of its own would be a second integrator writing the same offset — the
  trap the bob phase documents from the other side.
- **A blast kills through `Game.registerBotKill`**, which is now the one place a
  bot's death reaches the scoreboard, the ticket count and the killfeed from all
  three things that can cause it. The hitmarker and the rumble deliberately stay
  with the weapon, because those are about the shot that landed rather than the
  body that fell.

`installMap` clears the pool: a grenade whose fuse outlived the map it was
thrown across would go off over terrain that no longer exists, and in the
editor that means in the middle of a rebuild.

### The interface is four screens and the chrome

`src/ui/` holds one class per thing on screen, and `HUD` is not the place a new
one goes. `OverlayScreen` owns the three full-screen cards (menu, round-over,
pause), `DeployScreen` the deploy map, `LoadoutScreen` the kit, `Minimap` the
corner map, and `HUD` **only** the gameplay chrome — vitals, ammo, the ticket
gauge, the flag strip, the capture panel, the crosshair, the killfeed, the
scoreboard and the damage arcs. HUD was the overlay screens as well for a long
time, which is why it grew with every screen that was added; it does not any
more.

Each screen builds its own root element and appends it to `#hud`, which is why
construction order in `Game`'s constructor matters exactly once: `HUD` writes
`#hud.innerHTML` and would wipe anything already appended, so it is built
first. Stacking is not DOM order — `#overlay` (10) and `#loadout` (11) carry
z-indices, because a pause can be taken with the deploy map on screen and a
card you can see a map through is not a card.

**The three cards are one class because they are one element.** They share the
shell, the title block, the controls table and — between the menu and the
round-over card — the Deploy button, so splitting them further buys three files
that can never be shown together at the cost of a base class or a duplicated
stylesheet. The bar for a screen of its own is *state*: the deploy map has a
selection and a canvas, the kit screen has two slots and a turntable, and a
card that is markup plus a button has not earned one.

**A class on `#hud` belongs to whoever raises it.** `OverlayScreen` sets
`.overlaid`, `LoadoutScreen` sets `.kitting`, and `HUD` sets `.paused` and
`.editing` because those two hide the HUD's own chrome. That is also why a
pause is two calls from `Game` rather than one: the card goes up and the
crosshair comes down, and they are not the same decision — `.overlaid` would
take the tickets and vitals with it, which under a pause are still true.

**One stylesheet per module that writes markup, imported by that module.**
`HUD.ts` imports `hud.css`, `OverlayScreen.ts` imports `overlay.css`,
`DeployScreen.ts` imports `deploy.css`,
`LoadoutScreen.ts` imports `loadout.css`, `SettingsScreen.ts` imports
`settings.css`, `Minimap.ts` imports `minimap.css`,
and `editor/EditorPanel.ts` imports `editor/panel.css`. `main.ts` imports
`base.css` first. Vite bundles them into one hashed stylesheet that the built
`index.html` links from its head.

All of it used to be ~2,050 lines inline in `index.html`, which cost three
things worth not paying again: the markup and the rules that style it lived in
files with no compile-time link between them, so a renamed class was a silent
visual break; the editor's ~170 lines shipped in every production build, which
is precisely what the dynamic `import()` exists to prevent; and a CSS-only
change moved no content-hashed filename, which is the wart the service worker's
"hash names AND contents" rule was written around.

Three rules keep it that way:

- **`base.css` is for what two or more screens share** — the reset, the canvas,
  the `#hud` root, `.frame`, `.brackets`, `.hidden`, the `--ov-scale` short
  viewport block, `@keyframes pulse`, and the kit button (the menu and the
  deploy screen draw the same one). A rule only one screen uses belongs in that
  screen's sheet however tempting the shared file is; that is how the old
  single file happened.
- **A screen's state rules go with whoever sets the class**, not with whoever
  owns the element. `#hud.paused #deploy { opacity: 0.18 }` is in `hud.css`
  because `HUD.setPaused` is what puts `.paused` on, even though `#deploy` is
  the deploy screen's.
- **`index.html` gets no interface CSS, ever.** The one inline rule left is a
  black `html, body` background, and it is not the interface's: a production
  build links the stylesheet render-blocking from the head, but the dev server
  injects it from JS, which leaves one frame of default white before the first
  module evaluates — on a night game that reads as a camera flash. It must
  never grow into a second place rules are written.

### Getting into a round

Three screens stand between the title and the world, and each is driven by a
pointer *and* by a pad, with no path that needs the other.

**Each screen has ONE content width and everything hangs off it.** Every block
used to size itself to its own contents and centre on that, so five stacked
blocks had five widths and no two shared an edge — which is what reads as
clutter rather than as a screen. `#overlay` declares `--col` (the settings
grid, the Deploy button, the controls table, the pause list and the result bar
all take it) and `#deploy` declares `--map` (the status line, the hint row and
the button row all take it, so they meet the map's own edges). The two big
titles are the deliberate exception: a symmetric block of text wider than the
column it heads is a typographic choice, not a misalignment.

Three things there are worth keeping:

- **The menu's two settings rows are one grid, not two rows.** Both are
  label / control / hint; centred independently they put their labels, their
  controls and their hints at three different x each. `.ov-settings` owns the
  three columns and each row is `display: contents`. The control column is
  `1fr`, so the four difficulty tiers and the kit button below them span the
  same width — which is what sets the tiers' padding, since at 18px their
  min-content overflowed `--col` at every viewport size.
- **Only the controls opt into pointer events, never the rows.** `#hud` is
  `pointer-events: none` and the menu's confirm is a mouse-down anywhere, so a
  row that claimed events would turn its labels, its hints and the grid's own
  gaps into dead zones where a click does nothing instead of starting the round.
- **`#deploy-actions` wraps.** The map is height-led, so on a 768-tall laptop
  it is 430 px across and the longest kit ("Marksman rifle · Scope") does not
  fit beside a Deploy button. Both buttons grow, so a row that breaks gives two
  full-width buttons stacked rather than one hanging over the map's edge. That
  width is also why every input hint on the screen lives in the one hint row
  and the buttons carry only what they do.

**The menu and the round-over card carry a `Deploy` button**
(`OverlayScreen.bindStart` → `Game.onStart`). It is redundant with the confirm — a click anywhere on
either screen already starts the round — and that is why it has to exist: an
instruction in prose is not a target, and "click, press Enter, or press Start"
made a pad player work out which of the three was theirs. The glyph line on the
button says all of it at once.

**That button is why the deploy screen's confirm is `menuConfirmPressed`.** It
changes the state on the down edge, which puts the `deploy` branch in front of
the very click that asked for it — and the first deploy of a round has
`respawnT` at 0, so a confirm that counted the mouse fired immediately and
dropped the player into the world at whichever spawn the list started on,
skipping the screen entirely. Enter and pad A only; the map takes its own
clicks and the two buttons take their own.

**The spawn is steppable** (`DeployScreen.moveSelection`, wired to the menu
arrows in `Game`'s `deploy` branch). Before it there was no way to change
position without a mouse, so a pad's confirm deployed at whatever the list
happened to start on. Both axes step the same list: the spawns are points
scattered over a map rather than a row or a column, so no direction *means*
anything, and a d-pad direction that does nothing reads as a screen ignoring
the pad. The selection is stepped *before* `update()` redraws, so the marker
and the status line — which names the selection, because a highlight 300 px
away is not a label — move on the frame the key was pressed.

**`#deploy-go` is the pointer's way off that screen**, since the confirm no
longer takes a click. Pointerdown, like the map's markers and for the same
reason: the same event goes on to take the pointer lock, which it can only do
once `spawnPlayer` has moved the state to `playing`. It greys itself
(`.waiting`) while `confirm()` is still a no-op — a control that answers
nothing is worse than one visibly not yet yours.

**The right half of the screen is a turntable carrying the real viewmodel** —
the weapon that will be in the player's hands, with the optic actually
fitted, turned by dragging it or by the pad's right stick. It is not a
second model, not a render target and not a second camera: `ViewModel` simply
has a pose that is not the carried one (`beginInspect` / `spinInspect` /
`updateInspect` / `endInspect`), and the weapon is already parented to the
camera and drawn in `VIEWMODEL_GROUP` over everything else. Five things there
are load-bearing:

- **The stage is a hole in the screen's scrim.** Everything the kit screen
  draws is DOM, and DOM is above the canvas, so a backdrop over the stage would
  dim the weapon along with the world behind it. `#loadout`'s scrim therefore
  stops at the panel column and the stage gets a vignette instead — and `show()`
  marks `#hud` so the CSS can hide the menu, the deploy map and every gauge
  while the kit is up. Either screen left standing paints straight over the
  weapon.
- **The stage's geometry is shared with `CONFIG.viewmodel.inspect`.** The pose
  is placed by back-projecting a SCREEN anchor, and the anchor works out to
  exactly the CSS `--panel` fraction (the stage's centre is `(1+p)/2` across,
  which in NDC is `p`). Both are fractions of the viewport, so a resize moves
  them together; the distance additionally gives way on a viewport narrower
  than `aspectReference`, because apparent size follows the vertical FOV while
  the room to fit in is a share of the width.
- **The turntable rotation is a quaternion, and it is the only thing allowed to
  write one.** The carried pose is Euler, composed in the weapon's own frame, so
  at a side-on yaw the pitch a drag asks for arrives as a roll. `endInspect`
  dropping the quaternion is what lets the Euler pose come back at all — while
  one is set Babylon ignores `rotation` entirely.
- **It rotates about a derived pivot, not about the node's origin,** which on a
  rifle is the receiver: a turntable about that would swing the weapon around
  the screen. `applyFit` measures the pivot from the weapon's own muzzle
  landmark, so the SMG spins about the middle of the SMG.
- **The hands let go.** A forearm cut off at the elbow reads fine on a carried
  weapon and reads as a severed arm on a bench, so `ViewModel` hides the arm
  meshes for the duration — one place writes mesh visibility, or "show the
  weapon" and "let go of it" fight over them.

`Game.updateKitStage` drives it, and it exists because `loadout` is the one lid
state that shows live 3D: it owes by hand the per-frame pushes only
`updateGameplay` makes. The camera position is the load-bearing one — the cel
shader fogs against `camPos`, which outside a round is whatever the last
gameplay frame left there and `Vector3.Zero()` before the first, so a kit opened
straight off the main menu would fog the weapon out to a grey silhouette. It
also puts up the two bench lamps (`CONFIG.lighting.kitLamps`), which go through
`LightingSystem` like every other light because a carried light always wins a
slot. They are far brighter than the shoulder lamp on purpose: the weapon's
albedo is a night game's albedo, and on the one screen whose whole job is to
show you the weapon, moonlight alone is a black silhouette. `stowKit` is the
single teardown — screen, pose and lamps — and all four exits go through it,
because a carried light nobody removes survives `lighting.clear()` and follows
the player into the round.

### The scene has (almost) no Babylon lights

Cel materials carry their own `lightDir`/`lightColor`/`ambientColor`/
`skyLightColor` and
a packed array of up to `MAX_POINT_LIGHTS` (16) point lights as uniforms;
`LightingSystem` is the sole owner of dynamic light and uploads the winning slots
via `CelMaterialFactory.setPointLights()` once per frame. Adding a
`PointLight`/`HemisphericLight` to the scene will not affect any cel-shaded mesh.
Effect meshes (tracers, sparks, neon, reticles) use unlit emissive
`StandardMaterial`s from `mats.getEmissive()` and are unaffected by lighting
entirely.

**Four light terms, not three.** Beside the key light, the flat ambient and the
point lights there is a *hemispheric* term, `skyLightColor`, applied by `n.y`
and never gated by the shadow map: full strength on up-facing surfaces, nothing
underneath. It is what makes streets, roofs and open ground read as moonlit
while walls and undersides stay black — flat ambient alone lifts every face
equally, which reads as a grey wash rather than as light coming from the sky.
Because it is ungated, a roof standing in the moon's shadow still catches it.
It also has a cost that is easy to miss: it lifts *albedo*, so a bright
material (the cobble street) gains far more from it than a dark one.

**Two more terms are per-material opt-ins, and they are three cache variants
rather than a matrix.** `getGlossy` adds the toon specular (`specColor` /
`specShininess`) and `getTranslucent` adds the translucency band (`transColor`)
— the key light coming *through* a thin surface rather than off it, for the
stall awnings and the pine crowns. Both default to a **black colour**, which is
what makes them cost nothing on the materials that skip them: every cel
material carries both uniforms, and zero multiplies the term out. A material is
matte, glossy *or* translucent — never two of those — because the cache is per
colour and an axis that multiplies is an axis that costs. Adding a fourth
variant means a spec type, an `apply*`, a `get*` under its own key, one entry
in `UNIFORMS`, **and** teaching `outlineInkFor`'s regex the new
`cel-<variant>-#rrggbb` name, or the ink falls back to the palette-neutral
colour. The translucency term is directional both ways — it needs the eye
looking into the key light *and* the facet turned away from it — so it can only
be judged from under the thing, moonward, and shows nothing at all with the
moon behind the camera.

The one exception is `ShadowSystem`'s `DirectionalLight`, which no material
reads — it exists only to define the shadow camera for its `ShadowGenerator`.
The cel fragment shader samples that depth map as a hard two-level term gating
the key light. The shadow window follows the player (texel-snapped, re-rendered
only when the snapped focus moves), casters are the map's merged static meshes
re-registered every round via `shadows.setCasters(map.visuals)` (skip anything
flat with `metadata.noShadowCaster`), and characters get blob-shadow discs
instead of casting — the rigs are far too many meshes for the depth pass.

**The depth pass draws only the casters standing in the window, and it has to
do that culling itself.** Babylon culls nothing off an explicit `renderList`:
`ObjectRenderer._prepareRenderingManager` dispatches every mesh in it that is
enabled and visible, so the pass was submitting the whole village on every
re-render — measured at 314 casters and 79k triangles against the ~150 that can
reach a 110 m window. `ShadowSystem.cullToWindow`, hung off the shadow map's
`getCustomRenderList`, is the fix, and it is **lossless rather than a quality
trade**: the light is orthographic, so a caster's shadow lands at its own
position in the light's plane and a box test in that plane cannot drop anything
that could have darkened a texel. What bounds it is `BlockMerge`'s granularity
— a caster is one mesh per 48 m block per colour — not the arithmetic.

**The blob shadows do not probe for the player's ground; they are handed
`Player.floorY`.** `Player.probeGround` is a whole-scene ray pick (1,775 meshes
walked, 758 solid colliders tested, ~2.5 ms) and `ShadowSystem` used to cast the
identical ray for the identical body on the same frame. Anything else wanting
the floor under the player reads that field rather than probing again.

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

**The two halves are paired in `src/world/maps.ts`, and that is the only file a
second map touches.** A `MapDef` is `{ id, name, layout, environment }`; `MAPS`
is the registry and `DEFAULT_MAP` is what a round starts on. `Game` holds one
`mapDef` field and reads both halves off it — the layout and the environment
used to be named at fourteen sites across `applySky`, `startRound`,
`buildEditorMap` and `toggleEditor`, which is what made "one new layout file"
true of the world layer and false of the orchestrator. Nothing outside
`maps.ts` may import a map's own modules.

Two rules come with it. A `MapDef` must be a **module constant**, never rebuilt
per round: `applySky` skips repainting eight megapixels of dome by comparing
the environment by *identity*, so a fresh object every round would repaint it
every round. And a map's display name is **passed to the UI, never written
there** — it reaches the scoreboard through `setScoreboard`'s `map` field and
the round-over card through `showRoundOver`. The `<h1>HOLLOWMERE</h1>` on the
title screen is the exception, and deliberately: that one is the game's name,
which happens to also be the first map's.

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

### The valley rim

The map's boundary is **four collider boxes and a landform, and they are two
separate things** — the clearest case of the visual/collider split in the tree.
`MapBuilder.buildValley` still emits the four boxes (20 m tall, 244 m long,
inner faces at exactly ±120) and they are the only thing that stops anything
leaving; `src/world/Ridge.ts` draws an escarpment over them and stops nothing.
That split is why **seven** sites — `NavGrid` (rasterize, severLinks,
clearBlocked), `ObstacleField`, `CoverMap`, `Minimap`, `DeployScreen` — can go
on identifying the boundary with `box.w > 200 || box.d > 200` and know nothing
about the rim. Keep the boxes over 200 m and keep the rim collider-free, or
that heuristic is the first casualty. The minimap and the deploy map will still
draw a clean square while the world shows a lumpy one; they are schematics, and
that is correct.

Five things about the landform are load-bearing:

- **It is built OUTWARD from ±120 and never inward**, into space no player can
  occupy, so it costs zero playable area. `assertOutsidePlay` throws in dev.
- **Its basal band is vertical and flush with the collider plane.** This is the
  one part of the profile that is not free to be pretty: colliders have to line
  up with the surfaces they stand in for, and a face that battered outward from
  the floor would put visible rock most of a metre in front of the box at chest
  height, so rounds would spark on air. `PLINTH_FLOOR` (1.8 m) clears the
  standing eye, the hit sphere's top and `CoverMap`'s hard-cover height; the
  noise and the passes ride above it, never through it. Measured flush to
  0.000 m at 1.05/1.55/1.7 m on all four rims.
- **The crest is an ANGLE from the map centre, never a height.** `Sky.ts` culls
  stars below dome row 0.46 (7.2° elevation) and cloud below 0.47, and paints
  the dome flat `fogColor` beneath the horizon — so a crest under that exposes
  a band of sky with nothing painted in it. A tangent clamped at `MIN_SLOPE`
  makes that true by construction rather than by careful authoring, and it buys
  the corners bigger massifs than the sides for free. The old box gave 9.46°;
  the rim measures 8.19° at its lowest, which is the two passes deliberately
  dipping, against the 7.2° floor.
- **A pass is a saddle, not a cutting.** `MIN_SLOPE` is set just above the sky's
  floor rather than at the rim's own height precisely so a pass has somewhere to
  drop to — at 0.17 the clamp swallowed the cut entirely and the cols were
  invisible. Only the crest falls; the face is left alone, because pulling it in
  and raising the basal band turns a way out of the valley into a quarry.
- **Its own RNG stream.** `buildValley` runs *before* the scatter loop, so a
  single draw from `MapBuilder`'s shared stream would reroll every scatter
  region on the map — a visible change to the level with nothing in the diff to
  point at it. Verify a rim change by fingerprinting `colliderBoxes`.

Shape lives on `MapLayout.ridge` (a `RidgeSpec`, all fields optional) and the
palette on `EnvironmentSpec` (`ridgeColor`/`ridgeScreeColor`, which replaced the
dead `wallColor`/`wallTrimColor`). That split is not tidiness: `applyEnvironment`
writes uniforms and nothing else, which is what lets the editor's work light
swap a spec per keypress with no rebuild, so a *shape* living there would
silently stop working. The rim is also a **receiver only** (`noShadowCaster`) —
a 20–45 m crest throws 26–58 m of shadow at the moon's 38°, and the shadow
window is a fixed 110 m square that follows the player, so a casting rim would
end its shadow in a hard line that slides across open ground as you walk.

**Scatter placement is seeded** (`layout.seed`, via `src/world/rng.ts`). This is
not cosmetic: blocking scatter emits colliders, colliders feed `NavGrid` and
`ObstacleField`, so an unseeded scatter means the navigation graph differs
between page loads and a bot wedged on a boulder is only reproducible on some
boots. Never call `Math.random()` in world-building code. Changing the seed
rerolls the whole dressing field, which is a visible change to the level. One
stream serves the whole build, so **inserting a region rerolls every region
after it** — append rather than insert if you want a diff you can read.

**A scatter region is a disc or an oriented rectangle** (`ScatterCircle` /
`ScatterRect`, discriminated by which extents are present — `radius`, or
`width`/`depth` plus `rotY`). A belt of trees down one side of a street is a
rectangle; spelling it as a chain of overlapping discs is tedious to author and
lumpy where they meet. Both shapes draw the same two random numbers per
placement attempt, so the shipped map's dressing is bit-identical to what the
circle-only sampler produced. A region is still filed under the map block its
**centre** falls in, so break a belt longer than the 78 m fog wall into a few
rectangles rather than authoring one that spans the map.

Builders assemble geometry **at the origin, unrotated**, and return three
parallel lists (`meshes`, `colliders`, `lights`) in local space. `MapBuilder`
merges the meshes per colour and then transforms all three into place. Building
at identity is what makes the merge safe — `MergeMeshes` bakes world matrices and
returns an identity-transform mesh, the same trick `RifleModel.buildRifle` uses.
**A scatter region obeys the same rule**: it samples in its own frame and is
transformed afterwards, which is what lets the editor move and turn one by
writing a transform. A merge of *one* mesh is the exception `MergeMeshes` will
not handle for you — `mergeByMaterial` bakes those by hand, and before it did,
every colour used by a single part of a rotated building (the tavern's sign, the
smithy's forge glow, the boathouse lamp) was translated into place without being
rotated.

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
plus the three compound keys `kind`, `owner` and `shape` that write more than
one field), `inspect.ts` produces the controls, `mutate.setField` applies them.
Two rules there keep the layout terse: **a value equal to the builder's own
default is removed, not written**, and absent-means-default fields (`y`, `rotY`,
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

### Bot deaths, and the one physics engine

A killed bot falls under **Havok** (`src/systems/RagdollSystem.ts`). This is the
only physics engine in the tree, the only place `@babylonjs/havok` is imported,
and a deliberate exception to "no asset files" — it ships a 2 MB WASM binary,
requested explicitly. It buys nothing but the fall: **nothing here feeds
navigation, cover or hit detection.** A corpse is not in `NavGrid`, not in
`ObstacleField`, not in `hittablesAgainst`; bots walk through bodies and rounds
pass through them, exactly as before. Do not "fix" that by feeding corpses into
`ObstacleField`, whose buckets are baked at map load.

**The collapse tween in `Bot.update`'s dead branch is not legacy — it is the
floor under all of this**, and it runs on four separate refusals: the WASM has
not loaded, the WASM failed, the setting is off, the pool is full, or the death
was past `death.maxDistance`. Deleting it is the single worst change available
here. It is also what keeps `Bot.ts`'s own note true: the tween is exempt from
the pose-freeze LOD *because it is five property writes*, a ragdoll cannot
inherit that exemption, so the ragdoll is gated by distance at the moment of
death and the tween still runs, still exempt, everywhere it declines.

Six things are load-bearing:

- **`scene.physicsEnabled` is FALSE and must stay false.** Babylon steps physics
  from `scene.animate()` on every RENDERED frame, and this game renders in every
  state — so a scene-driven step would leave corpses tumbling under the pause
  card, under the deploy map and behind the menu. `RagdollSystem.update` steps
  the world by hand and is called only from `Game.updateGameplay`, which is what
  a pause already stops. Measured: bit-identical body position across 12
  rendered frames while paused.
- **Havok never touches a rig node.** It writes pool-owned PROXY
  `TransformNode`s and the rig's joints are parented to those. This is not
  fastidiousness: Havok's sync calls `decomposeToTransformNode` on any node with
  a parent, which force-creates a `rotationQuaternion` — and while one is set
  Babylon ignores `rotation`, which is what `animateSoldier` writes. One leaked
  quaternion is a bot that respawns frozen mid-tumble for the rest of the round,
  with its position still updating correctly underneath. `setParent` is safe in
  both directions (verified: it writes Euler when there is no quaternion), which
  is what makes the hand-off and the hand-back clean.
- **`resetSoldierPose` is the authoritative restore, and
  `animateSoldier(rig, 0,0,0,0, 0)` is not a substitute.** That call writes ten
  Euler channels; the rig has far more, and never a `parent`, a
  `rotationQuaternion`, a `scaling` or anything on `gun`. `Bot.spawn` calls the
  former. Verified across three lives on one rig — a leak shows on life 2.
- **The map is registered as ONE static body** — a `PhysicsShapeContainer` of
  the ~733 collider boxes plus the 25 terrain blocks as mesh shapes (the floor
  is the documented collider exception and has no `WorldBox`, hence
  `GameMap.terrainColliders`). Built in `installMap` like everything else that
  consumes a `GameMap`, skipped on editor builds, and torn down leaf by leaf or
  the WASM heap grows one map build at a time. Measured 33–50 ms headless, and
  25 bodies flat across three rounds.
- **The rifle is not a bone.** It stays parented to `torso` and rides that body.
  Giving it one drops it out of hands that cannot open — the arm is a single
  welded segment with no elbow, wrist or finger — so the weapon falls away while
  two fists stay cupped around nothing.
- **A corpse sinks; it cannot fade.** The cel shader writes alpha 1.0 outright
  and its materials are shared per COLOUR by `CelMaterialFactory`, so an alpha
  write would dim every bot on the map. Sinking through the floor is what the
  tween always did.

The bone table, the pivots and the joint limits live in `SoldierModel.ts` with
the boxes they are measured from; `CONFIG.bots.death` owns the sim (impulse,
gravity, damping, corpse life). The impulse needs no new plumbing: `takeDamage`
is already handed the shooter's origin (or the blast centre), so `Bot` captures
`deathFrom`/`deathDamage` there and `Game.registerBotKill` — the one place all
three ways of dying converge — offers the body to the pool.

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
- **The rim highlight is gated off near-level surfaces, and the gate is not
  optional.** A rim light catches silhouettes, but on a plane the grazing angle
  it keys on is nothing but the distance from the eye — for a floor,
  `1 - dot(viewDir, n)` is `1 - eyeHeight/dist` — so an ungated rim fires on
  every ground pixel past `eyeHeight / 0.28` (5.5 m standing, 3.75 m crouched)
  and on none inside it. That is a hard-edged disc of un-rimmed floor locked to
  the camera, sliding across the map with the player; with the shoulder lamp
  inside it, it reads as a bright pool, a dark ring, then brighter ground
  (measured on Hollowmere's floor: luminance 0.205 at 5.0 m against 0.263 at
  5.6 m, a 28% step across one circle). The gate is on **tilt**, because
  distance is only the symptom, and it reads the **facet** normal rather than
  the bumped one — off the bumped normal, individual setts flick it on and off.
  It costs the rim on the near-horizontal top faces of a rig (shoulders, helmet
  crown), which were never silhouettes either — they are the same degeneracy
  seen edge-on.
- Fixture lights are hand-placed and must stay **spatially spread**. The 16-slot
  shader cap is absolute; `LightingSystem` picks nearest-first, so clustering
  lanterns wastes slots and flattens the darkness. The retired room generator
  enforced this automatically with a sqrt scale — hand authoring means enforcing
  it by eye.
- Rendering group **1 is the viewmodel's**, and it is there for the depth clear
  Babylon does between groups — that is what stops the rifle being sliced open
  by a wall the player walks into. Putting world geometry in group 1 makes it
  draw through everything; putting the weapon back in group 0 puts the wall
  through the weapon.
- **The post-process chain has an order, and a display setting that switches
  an effect off REMOVES its pass** rather than zeroing its uniforms — a pass
  attached but idle still reads and writes the whole frame, which is the same
  thing `syncGodRays` detaches for. The order is FXAA, shafts, motion blur,
  horror grade, and it is enforced by where each one re-attaches:
  `attachPostProcess` appends, so the blur's toggle takes the grade off and
  puts it back behind it (`Game.setMotionBlurEnabled`), and the grade's own
  toggle always appends because the tail is where it belongs. `HorrorPost`
  owns whether it is attached, so the blur's dance can never resurrect a grade
  the player turned off — the guard is in `attach`, not at the call sites.
  Nothing throws if any of this is wrong; the symptom is grain over a smear,
  which reads as a dirty lens. Note the red damage flash is painted by the
  grade's shader and goes off with it, and the HUD's damage arcs are what is
  left telling the player where a hit came from.
- The cobblestone texture is 512² over a 1.5 m tile (`textures.ts`). That is
  sized for a camera **1.55 m above the street**: at the 256 it was authored
  at, when the camera sat 3.3 m back, looking down at your own feet turned the
  setts into blobs.
- **Two up-facing surfaces must never share a plane.** The merge is per colour,
  so a floor slab and the plinth under it land in *different* meshes and their
  draw order is arbitrary — a shared top face is a depth-test tie broken per
  pixel, which strobes as the camera moves. It does not read as z-fighting
  stipple either, because the two surfaces are different colours: the tavern's
  taproom flickered between blue-grey stone and brown boards across all 130 m²
  of it. Boards stand proud of their plinth (`buildTavern`, `buildTownhouse`).
  Coplanar faces within **one** colour group are fine — they merge into a
  single mesh, which is why the gable roofs meeting at a ridge are not a bug.

### The sky

Everything overhead is painted at runtime by `src/systems/Sky.ts` from the map's
`SkySpec`: an equirectangular dome texture (gradient, galactic band, stars, the
moon's scattering halo), a textured moon disc that feeds the GlowLayer, and two
drifting cloud decks.

**The dome is painted assuming something occludes the bottom of it**, and that
something is the valley rim — so the two are a contract, not neighbours. Stars
and the galactic band are culled below canvas row 0.46 (`if (y > h * 0.46)
continue`, written twice), `cloudBandBottom` stops cloud at 0.47, and the
gradient runs to flat `fogColor` from row 0.58 down. In elevation that is
**7.2° for stars and 5.4° for cloud**, below which there is nothing painted at
all. `Ridge.ts`'s `MIN_SLOPE` is the other half of the contract and is set
against those numbers; lowering the rim without moving these cutoffs uncovers a
band of empty dome, and past the 78 m fog wall it does not matter because both
are `fogColor` anyway. Four more things are load-bearing:

- **Sky textures are uploaded with `update(false)`.** `DynamicTexture.update()`
  flips Y by default, which maps canvas row 0 to `v = 1` — the *nadir* on
  Babylon's sphere, whose UVs run `v = acos(y)/PI` down from the zenith. A sky
  painted top-down and then flipped puts its stars, its band and its halo under
  the map and leaves the visible half showing the fog colour the gradient ends
  on. It does not look upside down. It looks like there is no sky at all, with
  a moon still correctly placed in it because the disc is geometry, not paint.
- **Cloud masks are 3D noise sampled along each texel's own direction.** An
  equirect image stretches by `1/sin(latitude)`, so a 2D field smears into
  bands as it climbs and pinches at the pole; a tileable 3D lattice has no seam
  and no pole. The field is also **normalised to its own range before it is
  thresholded** — summed value noise clusters around 0.5, so a raw fBm against
  a 0.5 threshold produces haze, not cloud.
- **The moonlit silver is a second, additive shell with a static per-vertex
  alpha mask**, not a bright patch in the mask texture. The texture scrolls and
  the moon does not; baking the lit side in would drag the highlight across the
  sky with the clouds.
- **Stars live or die on dome resolution.** 360 degrees of texture against ~50
  of screen is a hard magnification, so a dot drawn much over a pixel arrives as
  a bokeh ball. That is why the dome is 4096x2048 and `starMaxSize` is ~1.6.
  The same magnification is why `cloudSoftness` is wide: bilinear magnification
  of a *hard* alpha contour comes out as straight-edged wedges — torn paper,
  not cloud — and a soft ramp magnifies cleanly for free.
- **The dome wraps, so anything painted near its edge must be painted twice**
  (`acrossSeam`). The left and right edges are the same piece of sky, a canvas
  clips instead of wrapping, and the widest mark on the dome is the moon's halo
  — wider, at these settings, than the moon's own distance from the wrap column.
  Miss this and you get a bright gradient ending in a straight vertical line
  down the sky. Setting `wrapU = WRAP_ADDRESSMODE` is also required (Babylon's
  `DynamicTexture` defaults BOTH axes to CLAMP) but it only fixes the
  filtering: the seam that shows is the one in the paint. `v` stays clamped —
  it runs pole to pole and has nothing to meet.

`Game.applySky()` no-ops when the environment object is unchanged. The map is
rebuilt every round; the sky is not, and repainting 8 megapixels of dome plus
two noise masks per round for an unchanged sky is pure cost.

`GodRays` (`src/shaders/GodRays.ts`) then adds the shafts, in screen space:
march each pixel back toward the moon's projected position and accumulate what
is bright along the way, so anything dark between the camera and the moon
leaves a beam-shaped hole. There is no occlusion render pass — the substitute
material trick Babylon's `VolumetricLightScatteringPostProcess` uses does not
fit the cel materials — so **the luminance threshold IS the occlusion test**,
and it has to sit above the brightest non-sky thing in the frame. That is the
wet cobbled street (~0.67 looking along the moon); below it the road smears
upward and the frame fills with ground haze.

**The pass is DETACHED whenever the moon is behind the camera or off the side
of the screen**, which is most of a round — measured at 22 of 24 bearings on a
level sweep. Its shader early-outs in that case too, but an early-out only
skips the sample loop: an attached pass still reads and writes the whole frame,
which is the same thing `MotionBlur` says about being switched off. `Game`
owns the attachment (`syncGodRays`), and owns the pass's FIRST attach as well,
because Babylon's `detachPostProcess` nulls the slot rather than removing it
while `attachPostProcess` appends — so a pass that attached itself would have
no way to name the hole it came out of, and every cycle would leave another
one in a list walked every frame.

### The installable app

The build installs to a home screen and launches fullscreen, landscape and
offline. Four files carry it: `public/manifest.webmanifest`, `public/icons/`,
`src/pwa/register.ts` and `src/pwa/sw.js`. Nothing in the game knows any of
this exists — `Game`'s one line is the fullscreen gesture.

**`public/` is the one place a URL is written by hand.** Vite copies it to
`dist/` unhashed, which is the point: a manifest names its icons, `index.html`
names the manifest, and a home screen keeps the `start_url` it installed with,
so those paths are a contract with something outside the build. The icons are
generated and *committed* the same way the water textures are (`npm run icons`
→ `scripts/generate-icons.mjs`, a zero-dependency PNG encoder), so nothing at
build time depends on a script having been run.

**The service worker is a template, not a module.** `src/pwa/sw.js` is never
imported and never typechecked; `vite.config.ts`'s `serviceWorker()` plugin
reads it in `writeBundle`, substitutes the whole `const PRECACHE = __PRECACHE__;`
line for the manifest of what was actually written to `dist/`, and emits
`dist/sw.js`. Four things there are load-bearing:

- **The version hashes every file's NAME AND CONTENTS.** Hashing the names
  alone looks sufficient because Vite content-hashes the asset filenames — but
  `index.html` is unhashed, and a byte-identical worker is one the browser
  never updates, so anything that changes only unhashed output would be served
  from cache forever. The stylesheet used to be the live case: it was inline in
  `index.html`, so a CSS-only change moved no hashed filename. It is a hashed
  asset now (see "The interface's CSS"), which makes this belt-and-braces
  rather than load-bearing for that particular change — keep it anyway, because
  `index.html` still carries the head, the manifest link and the meta tags, and
  the next thing to live only there will not announce itself.
- **The substitution anchors on the declaration, not on the placeholder.** The
  file's own header comment names `__PRECACHE__` twice; a plain string replace
  puts the manifest in the prose and leaves the code undefined.
- **`sw.js` must be served `no-cache`** (`docker/nginx.conf`). It is the update
  mechanism: a cached copy is a client that can never learn a new build exists.
- **Caching is cache-first over that precache**, because the bundle is a few
  megabytes of Babylon and every byte is needed before the first frame. The
  cost is that a returning player gets the previous build and the new one
  installs behind them, so a deploy takes effect on the launch *after* next.

Registration happens in `main.ts` **before** the `Game` is constructed, and is
`import.meta.env.PROD`-gated: it must survive a Game that throws on a machine
without WebGL2, and a worker caching a dev server's module graph would be
actively harmful.

Three details about the phone itself, each of which was a visible bug first:

- **Fullscreen is taken on `document.documentElement`, never on the canvas.**
  A fullscreen element is the only thing drawn and the HUD is a `<div>`
  *sibling* of the canvas, so fullscreening the canvas plays the game with no
  tickets, no flags, no crosshair and no deploy map. It is gated on a coarse
  pointer: an installed app is already fullscreen from the manifest, and on the
  desktop the pointer lock does the immersing.
- **A tap raises `confirmPressed` but not `menuConfirmPressed`.** The masks in
  `InputManager` stay mouse-only — they are held state and a tap has no hold —
  so touch is latched separately. Without it the title screen cannot be got
  past at all on a phone: the deploy map listens for its own `pointerdown`, but
  the menu's confirm is "a button went down anywhere", read from the mask.
- **`--ov-scale` scales `#overlay` and `#deploy` on short viewports** by
  growing the box to `100%/s` and scaling by `s` about the top-left, so the
  backdrop stays full-bleed and the desktop (s = 1) is untouched. Nothing in
  this HUD scrolls, and a landscape phone is ~350px tall against screens
  authored for 720p. **`#loadout` is deliberately excluded**: its stage is a
  hole the 3D turntable is placed through, back-projected from the same
  viewport fractions the CSS uses, so a transform would move the hole and leave
  the weapon behind it — which is also why it is the one screen that carries a
  short-viewport media query of its own, dropping the weapon prose so the
  chart and the names still fit a landscape phone.
- **Inside a scaled box, `vh` and `vw` are still the VIEWPORT's**, so a length
  written in them is scaled a second time on the way out. `#deploy`'s map is
  `calc(min(56vh, 60vw) / var(--ov-scale))` for exactly that reason: at s =
  0.45 the raw form rendered the map at a quarter of the height it asked for,
  and the divide is the identity on every desktop.

There are **no touch controls** — every input is keyboard, mouse or gamepad, so
a phone plays this with a pad paired to it. Menus and the deploy map take a
tap; nothing in a round does.

### Procedural models

Every mesh is built from Babylon primitives at runtime, and all audio is
synthesized (`Sfx`). Don't reintroduce asset files without being asked. The
install icons under `public/icons/` are the documented exception, and they are
*generated* by a committed script rather than authored — same rule as the water
textures.

`RifleModel.buildRifle()` merges its ~150 static parts into one mesh per color
(BODY/POLYMER/METAL/RUBBER) — that merge is what makes the outline pass draw one
border per color group instead of a black shell around every screw, and it is
what makes detail on this model nearly free: it is four draws however many boxes
go into it. A colour missing from `SECTIONS` is silently never merged, so
anything `collect()` takes has to be listed there. The merge works only
because the root is still at identity while building: `MergeMeshes` bakes world
matrices and returns an identity-transform mesh, which is then re-parented.

**Nothing in the rifle may be scaled non-uniformly.** `VertexData.transform`
transforms normals *without* re-normalising them, and `renderOutline` extrudes
each vertex along its own normal — so a squashed part grows an ink shell that is
fat on the squashed axis. This is why the round shells (the optic housing, the
muzzle cage) are built by `shell()`, a ring of slabs each turned to its own
facet, rather than by stretching a torus along the axis. The primitives offer
nothing else that would do: a capped cylinder has no bore, and an uncapped one
is a single-sided shell whose far wall disappears exactly when you look through
it. Facets cost nothing visually — the cel shader flat-shades from screen-space
derivatives, so a smooth ring would render as a faceted one anyway.
`ViewModel`'s arms follow the same rule, with the one wrinkle `mergeByMaterial`
already documents: a colour group of **one** mesh has to be baked by hand
(`bakeCurrentTransformIntoVertices`), and because that call resets the local
matrix, the part must be detached with `setParent(null)` first or the aim
node's transform is applied twice.

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
- **Every ROUND is hitscan** — player and bots share `CombatSystem.fire()`, which
  takes the shooter's target list so friendly fire is excluded by construction
  rather than by a team check inside, and the shooter's own `range` (the player's
  weapons carry three different distances, and it bounds the wall pick and the
  near-miss sweep as well as the damage). There is no projectile pool to thrash in a
  16-bot firefight. Tracers and sparks are pooled; add effects to a pool rather
  than allocating per shot. The grenade is the one deliberate exception (see
  "Grenades"), and it is affordable precisely because there are a handful in
  the air rather than eighty a second.
- TypeScript is strict with `noUnusedLocals`/`noUnusedParameters` — the
  typecheck will fail on dead variables.
- `Bot` holds a small FSM and drives a joint rig built by `SoldierModel`
  (invisible root + `TransformNode` joints). Animation is procedural — posed
  hierarchies, walk cycles driven by travel speed — so a new behavior means new
  FSM states, never new clips.
- The map is data: a second map is one new `layout.ts` + `EnvironmentSpec`,
  paired in `src/world/maps.ts` and reached through `Game.mapDef`;
  `MapBuilder`/`BuildingKit` must not special-case Hollowmere, and nothing
  outside `maps.ts` may import a map's own modules.
- Interface CSS lives in a `.css` beside the module that writes the markup and
  is imported by it — never in `index.html`. See "The interface's CSS".

## Files not to edit / not part of the build

- `dist/` — build output (gitignored); regenerate with `npm run build`.
- `node_modules/` — gitignored.
- `specs/game_design.md` — describes the original roguelike prototype;
  historical, **not a live contract**.
- `undefined/` — tracked stray screenshot output from a script with a bad path;
  ignore it.
