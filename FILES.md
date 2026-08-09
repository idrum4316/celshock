# FILES.md

The module map, one line per file, stating what it owns. Split out of
[`CLAUDE.md`](CLAUDE.md), which carries the rules these modules obey and is still
the source of truth; this file is for finding your way to the right one.

```
index.html          # The head, and NO interface CSS. The one inline rule is a
                    #   black background, so a dev reload does not flash white.
main.ts             # Bootstrap. Imports src/ui/base.css FIRST.
public/             # Copied to dist/ VERBATIM — unhashed URLs named by hand
                    #   (manifest.webmanifest, icons/ from `npm run icons`).
src/
  config.ts         # ALL tunable constants (no magic numbers in code)
  core/
    Game.ts             # Orchestrator + state machine + main loop
    InputManager.ts     # Keyboard/mouse + gamepad state + rumble
    CameraSystem.ts     # First-person cam at the eye; ADS zooms and slows by
                        #   the fitted optic, at the weapon's own rate
    Sfx.ts              # Procedural WebAudio, spatialised, voice-capped
    settings.ts         # Settings shape, defaults, localStorage. Applies
                        #   nothing — that is Game.applySettings, the ONLY
                        #   place a setting reaches whatever owns it
  entities/
    Player.ts           # Movement, sprint, crouch, jump, weapon state
    ViewModel.ts        # The first-person weapon: carried gun + gloved arms on
                        #   the camera, hip/ADS/sprint/reload, sway, bob, and
                        #   the kit turntable. Builds every weapon, enables one
    weaponKit.ts        # The build accumulator every weapon model is written
                        #   in + WeaponParts and WeaponSights (rail, or fixed)
    RifleModel.ts       # Low-poly SCAR-pattern battle rifle
    SmgModel.ts         # Low-poly compact SMG — same contract
    DmrModel.ts         # Low-poly semi-auto marksman rifle
    PistolModel.ts      # 1911 sidearm — the one weapon that does not call
                        #   optics.ts: no rail, so its notch and blade are its
                        #   own and are all it ever wears
    optics.ts           # The three optic assemblies, built onto whichever
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
    tuning.ts           #   Tool constants (NOT config.ts — not gameplay)
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
                        #   watchtower, chapel, barn, mill, boathouse, gatehouse
    kit/structures.ts   #   silo, well, stall, fence, stoneWall, bridge,
                        #   haystack, lamp, cart, crates, woodpile, shed,
                        #   trough, shrine, kiln
    kit/terrain.ts      #   terrace, ramp, road, jetty
    NavGrid.ts          # Walkable-surface graph + precomputed flow fields
    CoverMap.ts         # Baked per-surface directional cover masks
    boxGeometry.ts      # Analytic WorldBox primitives, shared by NavGrid /
                        #   ObstacleField / CoverMap
    ObstacleField.ts    # Sub-cell collision push-out for thin props
    Props.ts            # Scatter props: trees, graves, rubble, braziers,
                        #   boulders, brambles, barrels
    textures.ts         # Generated canvas textures (cobblestone etc.)
    environment.ts      # EnvironmentSpec + applyEnvironment
    maps.ts             # MapDef + the MAPS registry. The only EXISTING file a
                        #   new map has to touch (plus vite.config's WRITABLE)
    hollowmere/layout.ts      # A MAP — every placement, flag and spawn
    hollowmere/heights.ts     # GENERATED floor heights (editor terrain mode)
    hollowmere/environment.ts # Palette, fog, mist, particles — night
    greyfen/layout.ts         # The second map. Forked from Hollowmere's and
    greyfen/heights.ts        #   diverging; the two share no module
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
    WaterShader.ts      # Animated water ShaderMaterial
    GodRays.ts          # Moon shafts: screen-space radial blur
    HorrorPost.ts       # Vignette / grain / aberration / damage flash
```
