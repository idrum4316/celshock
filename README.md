# CELSHOCK — Cel-Shaded Roguelike Third-Person Shooter

A browser-based, single-player roguelike third-person shooter built with
**Babylon.js** and **TypeScript**. Fight through procedurally generated,
themed rooms — a moonlit graveyard forest, a dead neon service level, a
boneyard under a blood moon — with seamless third-person ↔ first-person ADS
switching and a low-poly cel-shaded horror look: near-black arenas lit by
flickering torches, broken neon, and your own shoulder lamp.

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

| Action  | Gamepad (Xbox / PS) | Keyboard / Mouse |
| ------- | ------------------- | ---------------- |
| Move    | Left stick          | WASD             |
| Look    | Right stick         | Mouse            |
| ADS     | LT / L2             | Right-click      |
| Shoot   | RT / R2             | Left-click       |
| Jump    | A / ✕               | Space            |
| Reload  | X / ▢               | R                |
| Confirm | A or Start          | Enter / Click    |

Click the page once to capture the mouse (pointer lock). Gamepads use the
browser's standard mapping and are hot-pluggable — press any button after
connecting.

### How a run works

- A run is **5 rooms**; each room gets a **random theme** (no immediate
  repeats) with matching environment, props, lighting, and enemies. The
  arenas are big and dark — your shoulder lamp, the fixtures, and your own
  muzzle flashes are how you read them.
- Clear all enemies to open the exit door; a random **powerup** (damage,
  speed, max HP, or mag size) spawns at the room center. Enemies sometimes
  drop **health orbs**.
- Room 5 is a **boss arena** with the theme's boss. Beat it to win the run.
- Death is **permadeath**: the run (and all powerups) resets.

Boss tips: jump over the Rotwood Treant's ground slam; dodge sideways when
the Titan charges; keep moving when the Sand Worm's dust ring follows you.
Every boss carries an aura in its eye color, so it looms out of the fog
before you can make out its shape.

## Architecture

```
main.ts                     # Bootstrap
src/
  config.ts                 # All tunable constants (no magic numbers in code)
  core/
    Game.ts                 # Orchestrator + game state machine + main loop
    InputManager.ts         # Unified keyboard/mouse + gamepad state
    CameraSystem.ts         # Third-person camera with blended first-person ADS
    Sfx.ts                  # Procedural WebAudio sound effects (no assets)
  entities/
    Player.ts               # Movement, jumping, weapon state, jointed body
    RifleModel.ts           # Low-poly SCAR-pattern rifle + holo sight builder
    Viewmodel.ts            # First-person rifle: raise, sway, bob, recoil
    Enemy.ts                # FSM AI (spawn/chase/attack/die), drives the rig
    EnemyModels.ts          # Hound/humanoid/drone/wraith rigs + animation
    Boss.ts                 # Three boss patterns: slam / burst / burrow
    BossModels.ts           # Treant / Titan / Worm rigs + animation
  systems/
    RoomGenerator.ts        # Procedural arenas: walls, door, props, spawns
    ThemeManager.ts         # Theme registry + scene/lighting/fog application
    LightingSystem.ts       # Dynamic point lights: fixtures, flashes, lamps
    Atmosphere.ts           # Drifting ash / spore / ember particle field
    CombatSystem.ts         # Hitscan, pooled tracers/projectiles/sparks, AOEs
    EnemySystem.ts          # Spawning, AI updates, separation, clear detection
    LootSystem.ts           # Health orbs + run-scoped powerups
  themes/
    types.ts                # RoomTheme / EnemyType / BossType / PropSpec
    ForestTheme.ts          # Blackwood: Hounds + Archers + Wraiths, Treant boss
    CyberpunkTheme.ts       # Dead Sector: Drones + Husks + Hounds, Titan boss
    DesertTheme.ts          # Ashen Wastes: Scorpions + Bandits + Wraiths, Worm
  ui/
    HUD.ts                  # DOM overlay: bars, crosshair, messages, menus
  shaders/
    CelShader.ts            # Custom cel ShaderMaterial + outline helper
    HorrorPost.ts           # Vignette / grain / aberration / damage flash pass
```

### The theme system

A `RoomTheme` is a single data object that owns *everything* a room needs to
be internally consistent: floor/wall palette, sky/fog/mist colors, key light
and ambient tint, prop builders (including the lights those props carry), the
drifting particle spec, the enemy roster, and the boss definition.

- `ThemeManager.pick()` selects a random theme per room and
  `ThemeManager.apply()` pushes its environment into the scene clear color
  and every cel material's lighting/fog uniforms.
- `RoomGenerator` only consumes theme data — it never special-cases a theme —
  so **adding a theme is one new file** exporting a `RoomTheme` plus one line
  in `ThemeManager`'s registry.
- Enemies and bosses are built procedurally from data (`body` archetype,
  colors, eye color, scale, behavior numbers), so new enemy types need no art.
- A prop with a `light` spec registers a dynamic point light when placed, so
  lighting a new theme is data, not code.

### Rendering

Cel shading is a custom `ShaderMaterial` (`src/shaders/CelShader.ts`). Light
arrives in three banded parts, so the toon look survives a fully dynamic
scene:

- a **directional key light** (moon / blood moon) quantized into 4 hard bands,
- up to 16 **dynamic point lights** — torches, neon, muzzle flashes, the
  player's lamp — quantized into 3 bands with a smooth radial falloff, and
- a flat **ambient** term that sets how black the unlit side goes.

A soft shoulder compresses anything above 0.75 so overlapping lights saturate
in their own color instead of clipping to white. Atmosphere is theme-tinted
distance fog plus a separate height-based ground mist, both blended in the
fragment shader, and a step-function rim highlight adds the toon pop. Bold
outlines use Babylon's outline renderer (inverted hull). Materials are cached
per color and shared across meshes.

`LightingSystem` owns every dynamic light. A large arena holds far more
fixtures than the shader has slots, so each frame the nearest ones win —
imperceptible in practice, because distant lights are already swallowed by
fog. Transient flashes (muzzle, shockwaves) and *carried* lights (the player's
shoulder lamp, a boss's aura) are guaranteed a slot.

Finally `HorrorPost` grades the frame: vignette, corner desaturation, radial
chromatic aberration, animated film grain, and a red flash on damage. It is
hand-written because Babylon's image-processing block re-gammas the cel
shader's already display-ready colors and washes the palette out.

Shading is **faceted**: the fragment shader recovers each triangle's
geometric normal from screen-space derivatives of the world position instead
of using the interpolated vertex normal. Doing it in the shader gets flat
shading on every mesh for free — no `convertToFlatShadedMesh()` calls, no
unwelded vertices, and it applies automatically to anything built later.
Effect meshes (tracers, sparks, neon) use unlit emissive `StandardMaterial`s
and are unaffected.

**The game ships no 3D model files.** Every mesh — player, enemies, bosses,
weapons, props, environment — is built from Babylon primitives at runtime,
deliberately coarse so the facets read as the art style.

### Performance notes

- Tracers, sparks, and enemy projectiles are **object-pooled**.
- Player bullets are hitscan (one ray + sphere tests per shot).
- One `ShaderMaterial` per color, shared; all geometry is low-poly primitives.
- Rooms are large (~65–105 m per side), so prop and spawn counts scale with
  floor area — but light-bearing props scale by its square root, which keeps
  both the shader's light slots and the darkness intact.
- Static room geometry gets `freezeWorldMatrix()`; decorative props are
  marked unpickable so they never enter a hitscan ray test.
- No asset downloads: zero model files, and sound is synthesized at runtime.

## Known limitations

- Characters are primitive assemblies, not modeled/rigged meshes; all
  "animation" is procedural (posed joint hierarchies, walk cycles driven by
  travel speed, jaw/limb telegraphs, spawn/collapse tweens).
- Point lights are per-pixel but cast **no shadows** — the darkness is fog,
  ambient, and falloff, not occlusion.
- Enemy pathfinding is steering-based (seek + strafe + obstacle push-out),
  not navmesh-based; enemies can hesitate around large prop clusters.
- Single weapon; no manual weapon switching.
- Rooms are single arenas connected by a door transition, not a persistent
  dungeon map.
- Sound is minimal procedural WebAudio.

## Next steps for expansion

- **More themes**: add `src/themes/DungeonTheme.ts` / `AlienTheme.ts`
  (interface already supports them) and register in `ThemeManager`.
- More weapon types + weapon pickups as loot.
- Navmesh or flow-field pathfinding for smarter enemies.
- Elite enemy variants, room modifiers, and a meta-progression layer.
- glTF character models with real animations driven by the existing FSMs.
- Minimap, run stats, and seeded runs for sharing.
