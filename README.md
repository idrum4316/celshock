# CELSHOCK — Cel-Shaded Roguelike Third-Person Shooter

A browser-based, single-player roguelike third-person shooter built with
**Babylon.js** and **TypeScript**. Fight through procedurally generated,
themed rooms — a Treant-guarded forest, a neon cyberpunk plaza, a sand-worm
desert — with seamless third-person ↔ first-person ADS switching and a
custom cel-shaded look.

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
  repeats) with matching environment, props, and enemies.
- Clear all enemies to open the exit door; a random **powerup** (damage,
  speed, max HP, or mag size) spawns at the room center. Enemies sometimes
  drop **health orbs**.
- Room 5 is a **boss arena** with the theme's boss. Beat it to win the run.
- Death is **permadeath**: the run (and all powerups) resets.

Boss tips: jump over the Treant's ground slam; dodge sideways when the
Titan charges; keep moving when the Sand Worm's dust ring follows you.

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
    Player.ts               # Movement, jumping, weapon state, placeholder body
    Enemy.ts                # FSM AI (spawn/chase/attack/die), procedural meshes
    Boss.ts                 # Three boss patterns: slam / burst / burrow
  systems/
    RoomGenerator.ts        # Procedural arenas: walls, door, props, spawns
    ThemeManager.ts         # Theme registry + scene/lighting/fog application
    CombatSystem.ts         # Hitscan, pooled tracers/projectiles/sparks, AOEs
    EnemySystem.ts          # Spawning, AI updates, separation, clear detection
    LootSystem.ts           # Health orbs + run-scoped powerups
  themes/
    types.ts                # RoomTheme / EnemyType / BossType / PropSpec
    ForestTheme.ts          # Wolves + Archers, Treant boss
    CyberpunkTheme.ts       # Drones + Hackers, Cybernetic Titan boss
    DesertTheme.ts          # Scorpions + Bandits, Sand Worm boss
  ui/
    HUD.ts                  # DOM overlay: bars, crosshair, messages, menus
  shaders/
    CelShader.ts            # Custom cel ShaderMaterial + outline helper
```

### The theme system

A `RoomTheme` is a single data object that owns *everything* a room needs to
be internally consistent: floor/wall palette, sky and fog colors, light
direction/tint, prop builders, the enemy roster, and the boss definition.

- `ThemeManager.pick()` selects a random theme per room and
  `ThemeManager.apply()` pushes its environment into the scene clear color
  and every cel material's lighting/fog uniforms.
- `RoomGenerator` only consumes theme data — it never special-cases a theme —
  so **adding a theme is one new file** exporting a `RoomTheme` plus one line
  in `ThemeManager`'s registry.
- Enemies and bosses are built procedurally from data (`body` archetype,
  colors, scale, behavior numbers), so new enemy types need no art.

### Rendering

Cel shading is a custom `ShaderMaterial` (`src/shaders/CelShader.ts`):
diffuse light is quantized into 3 hard bands, a step-function rim highlight
adds the toon pop, and theme-tinted distance fog is blended in the fragment
shader. Bold outlines use Babylon's outline renderer (inverted hull).
Materials are cached per color and shared across meshes.

### Performance notes

- Tracers, sparks, and enemy projectiles are **object-pooled**.
- Player bullets are hitscan (one ray + sphere tests per shot).
- One `ShaderMaterial` per color, shared; placeholder geometry is low-poly.

## Known limitations

- Placeholder geometry (per the spec) rather than modeled/animated characters;
  enemy "animation" is procedural (scaling telegraphs, bobbing, spawn/death
  tweens).
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
