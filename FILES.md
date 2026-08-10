# FILES.md

The module map, one line per file, stating what it owns. Split out of
[`CLAUDE.md`](CLAUDE.md), which is still the source of truth — it and the
subsystem contracts under [`docs/`](docs/) that it points to carry the rules
these modules obey; this file is for finding your way to the right one.

```
index.html          # The head, and NO interface CSS. The one inline rule is a
                    #   black background, so a dev reload does not flash white.
main.ts             # Bootstrap. Imports src/ui/base.css FIRST.
public/             # Copied to dist/ VERBATIM — unhashed URLs named by hand
                    #   (manifest.webmanifest, icons/ from `npm run icons`).
src/
  config/           # ALL tunable constants (no magic numbers in code).
                    #   One module per subsystem; import `CONFIG` from "…/config"
    index.ts            # Composes CONFIG from the sections. The ONLY importer of
                        #   them. A new tunable goes in a section, not here
    fogWall.ts          # FOG_WALL alone — bots.ts reads it, so it cannot live in
                        #   index.ts without an import cycle
    conquest.ts         # Flags, capture meter, tickets, bleed
    bots.ts             # Bot AI + the nav grid (bots, nav)
    player.ts           # Movement, crouch, ground probe, vitals
    weapons.ts          # The weapon table, recoil, gunfeel (weapons, recoil,
                        #   gunfeel)
    sights.ts           # The optic table — its ORDER is the loadout row
    viewmodel.ts        # Where the weapon sits in front of the camera
    grenade.ts          # The throw, bounce, fuse and blast
    camera.ts           # Look, FOV, view punch, shake
    aimAssist.ts        # Controller aim assist and its three invariants
    input.ts            # Deadzones, curves, pad haptics (input, rumble)
    audio.ts            # Levels, distances, rolloff for the synthesized mix
    graphics.ts         # Render pipeline knobs + pooled effects (graphics,
                        #   effects)
    hud.ts              # Minimap and damage arcs (minimap, damageIndicator)
    lighting.ts         # The dynamic light budget (uniforms, not Babylon lights)
    world.ts            # Map extents, water, grass (map, water, grass)
    sky.ts              # The painted sky and moon shafts (sky, godRays)
    teams.ts            # The two sides; index 0 is the player's
  core/
    Game.ts             # Orchestrator + state machine + main loop. Constructor
                        #   is construction only; wiring is wireSystems (+ four
                        #   subject methods), installDomListeners, wireScreens;
                        #   tick dispatches one method per screen
    InputManager.ts     # Keyboard/mouse + gamepad state + rumble
    CameraSystem.ts     # First-person cam at the eye; ADS zooms and slows by
                        #   the fitted optic, at the weapon's own rate
    Sfx.ts              # Procedural WebAudio, spatialised, voice-capped
    prefs.ts            # Remembered difficulty, map and loadout: the
                        #   localStorage round trip only. Ids that index a table
                        #   are validated, never trusted
    settings.ts         # Settings shape, defaults, localStorage. Applies
                        #   nothing — that is Game.applySettings, the ONLY
                        #   place a setting reaches whatever owns it
  entities/
    Player.ts           # Movement, sprint, crouch, jump, weapon state
    ViewModel.ts        # The first-person weapon: carried gun + gloved arms on
                        #   the camera, hip/ADS/sprint/reload, sway, bob, and
                        #   the kit turntable. Builds every weapon, enables one
    weaponKit.ts        # The build accumulator every weapon model is written
                        #   in + WeaponParts and WeaponSights (rail, or fixed),
                        #   and the five colour groups a weapon merges into
    RifleModel.ts       # Low-poly SCAR-pattern battle rifle
    CarbineModel.ts     # Low-poly FAMAS-pattern bullpup burst carbine —
                        #   magazine behind the grip, carry-handle blade,
                        #   full-hand trigger guard, folded bipod
    SmgModel.ts         # Low-poly compact SMG — same contract
    DmrModel.ts         # Low-poly semi-auto marksman rifle
    LmgModel.ts         # Low-poly belt-fed light machine gun — feed cover and
                        #   split rail, box under the receiver, the exposed
                        #   brass belt, side-folded carry handle
    PistolModel.ts      # 1911 sidearm — the one weapon that does not call
                        #   optics.ts: no rail, so its notch and blade are its
                        #   own and are all it ever wears
    optics.ts           # The five optic assemblies, built onto whichever
                        #   weapon's OpticMount asked for them
    weapons.ts          # WeaponId + WeaponSetup, + SIDEARM/PRIMARY_WEAPON_IDS
    sights.ts           # SightId + magnification -> FOV, sensitivity, zoomComp
    Combatant.ts        # Team + the shared shootable/shooter interface
    Bot.ts              # Bot FSM (advance/hunt/engage/takeCover/suppressed/
                        #   retreat/capture) + movement, aim, magazine, peek
    BotMemory.ts        # One bot's decaying picture of the fight
    BotSkill.ts         # skill scalar -> BotProfile; difficulty tiers
    SoldierModel.ts     # Merged bot rig + procedural animation, and the
                        #   RagdollSubject interface
  systems/
    BattleSystem.ts     # Bot pool, AI scheduling, LOS, distance LOD
    ConquestSystem.ts   # Flags, meters, tickets, bleed, spawns, planSquads
    CaptureZoneSystem.ts# Flags drawn in the world: ring, skirt, beacon
    CombatSystem.ts     # Hitscan + pooled tracers and sparks
    GrenadeSystem.ts    # The one thing that isn't hitscan + BlastDust
    RagdollSystem.ts    # The ONLY Havok in the game, entirely optional —
                        #   every refusal falls back to a collapse tween.
                        #   Cannot tell a dead bot from the player's stand-in
    DeathCam.ts         # The player's own death; the only occlusion pick
                        #   outside combat
    AimAssistSystem.ts  # Gamepad-only: outer bubble slows the stick, inner one
                        #   rotates. Bounded by the player's own turn rate
    LightingSystem.ts   # Dynamic point lights: fixtures, flashes, lamps
    ShadowSystem.ts     # Moon shadow map (stepped) + blob shadows
    Atmosphere.ts       # Ash field on the GPU. No CPU fallback — WebGL2 is a
                        #   hard requirement and guarantees it
    Sky.ts              # Generated dome, textured moon, fBm cloud decks
    WaterSystem.ts      # Water surfaces from map WaterRects
  editor/               # Dev-only map editor (F2). Dynamically imported —
    index.ts            #   never statically imported from anywhere, or it
    EditorCamera.ts     #   lands in the production bundle
    EditorPanel.ts
    panel.css           #   Imported by EditorPanel so it rides the dynamic
                        #   chunk. Never link it from HTML
    workLight.ts        #   Brightened EnvironmentSpec for authoring
    selection.ts        #   SelectionRef, predicate pick, highlight
    proxies.ts          #   Stand-ins for flags/spawns/scatter/water/grass
    gizmos.ts           #   Move + Y-rotate handles, snapping
    mutate.ts           #   Layout writes: transform, fields, add/delete
    fields.ts           #   FieldSpec + the key conventions inspect, the panel
                        #   and mutate all have to agree on
    inspect.ts/params.ts#   Inspector read model + per-kind param table
    sourceScan.ts       #   layout.ts as text: regions, entries, tokens
    terrainBrush.ts     #   Terrain mode: hover highlight + sculpt stroke
    serialize.ts/save.ts#   Minimal-diff emit + POST to the dev server
    saveEnvironment.ts  #   environment.ts patched one top-level KEY at a time
                        #     — what the floor picker writes
    tuning.ts           #   Tool constants (NOT src/config/ — not gameplay)
  world/
    layout.ts           # Placement/ScatterSpec/Heightfield/MapLayout — the
                        #   map-data vocabulary, map-agnostic
    TerrainField.ts     # The floor's height and the ONLY place that knows it:
                        #   heightAt() + per-block VertexData + terrainSlab()
    Ridge.ts            # The valley rim. Shape only — no collider, nothing
                        #   inside ±size/2
    rng.ts              # mulberry32 — the seeded PRNG world-building uses
    MapBuilder.ts       # Builds the map; merges visuals, emits colliders
    BuildingKit.ts      # Facade: shared types + BUILDERS registry
    kit/core.ts         #   Build accumulator, palette, builder contract
    kit/buildings.ts    #   cottage, townhouse, tavern, smithy, ruin,
                        #   watchtower, chapel, barn, mill, boathouse,
                        #   gatehouse, stiltHut, jungleRuin
    kit/manor.ts        #   manor — the two-storey colonial house with the
                        #   wrap-around gallery. Its own file: bigger than the
                        #   rest of buildings.ts together
    kit/structures.ts   #   silo, well, stall, fence, stoneWall, bridge,
                        #   trestleBridge, templeRuin, haystack, lamp, cart,
                        #   crates, woodpile, shed, trough, shrine, kiln
    kit/terrain.ts      #   terrace, ramp, road, jetty, boardwalk
    NavGrid.ts          # Walkable-surface graph + precomputed flow fields
    CoverMap.ts         # Baked per-surface directional cover masks
    boxGeometry.ts      # Analytic WorldBox primitives, shared by NavGrid /
                        #   ObstacleField / CoverMap
    ObstacleField.ts    # Sub-cell collision push-out for thin props
    Props.ts            # Scatter props: trees, graves, rubble, braziers,
                        #   boulders, brambles, barrels, and the understory —
                        #   ferns, fallen buttress logs, carved stelae
    textures.ts         # Generated canvas textures: the cobbles, and the floor
                        #   surfaces — grain painted from the map's floorColor
    floorSurfaces.ts    # What the valley floor is MADE of: the surface roster
                        #   and the ONE place a floor material is built
    environment.ts      # EnvironmentSpec + applyEnvironment
    maps.ts             # MapDef + the MAPS registry. The only EXISTING file a
                        #   new map has to touch (plus vite.config's WRITABLE)
    hollowmere/layout.ts      # A MAP — every placement, flag and spawn
    hollowmere/heights.ts     # GENERATED floor heights (editor terrain mode)
    hollowmere/environment.ts # Palette, fog, mist, particles — night
    greyfen/layout.ts         # The second map, being built: the jungle manor
                              #   on C, a stilt-hut settlement and a temple on
                              #   the other flags, and the trestle over the river
    greyfen/heights.ts        # GENERATED floor heights — a Y-shaped river,
                              #   wadeable everywhere (banks grade at 0.22)
    greyfen/environment.ts    # Palette, fog, sun, sky — overcast dawn
  ui/                   # One .css beside each module that writes markup
    base.css            #   Reset, canvas, #hud root, and ONLY primitives two
                        #   or more screens share. Imported by main.ts
    HUD.ts/hud.css      # Gameplay chrome ONLY: tickets, flags, capture panel,
                        #   vitals, ammo, crosshair, killfeed, scoreboard,
                        #   damage arcs, + .paused/.editing/.dying
    OverlayScreen.ts    # The three cards — menu, round-over, pause — and the
      overlay.css       #   .overlaid class they raise
    DeployScreen.ts     # Top-down deploy map + the deploy and kit buttons
      deploy.css
    LoadoutScreen.ts    # Kit screen: two slots, a stat chart derived from
      loadout.css       #   CONFIG.weapons, and the turntable stage
    SettingsScreen.ts   # Toggles built from a ROW TABLE. Owns no setting —
      settings.css      #   picks leave through onToggle, return as setValues
    Minimap.ts          # Corner minimap: flags, friendlies, firing enemies
      minimap.css
  pwa/
    register.ts         # SW registration + the touch fullscreen gesture.
                        #   Knows nothing about the game
    sw.js               # The service worker, as a TEMPLATE — not typechecked,
                        #   never imported; vite.config.ts emits dist/sw.js
  shaders/
    CelShader.ts        # Custom cel ShaderMaterial + outline helper
    OutlineFog.ts       # Bakes the map's fog into Babylon's outline pass, so
                        #   ink fades per PIXEL instead of per merged mesh
    EmissiveFog.ts      # The same fog as a material plugin on every unlit
                        #   emissive material — windows, flames, tracers
    WaterShader.ts      # Animated water ShaderMaterial
    GodRays.ts          # Moon shafts: screen-space radial blur
    HorrorPost.ts       # Vignette / grain / aberration / damage flash
```
