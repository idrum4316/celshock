# Cel-Shaded Roguelike Shooter - Full Specification

---

## **Overview**

A **browser-based, single-player roguelike third-person shooter** built with **Babylon.js** and **TypeScript**.

**Core Pillars:**

- **Cel-shaded art style** (custom shaders, bold outlines, flat colors).
- **Third-person camera** with **seamless first-person ADS (Aim Down Sights) switching**.
- **Procedurally generated rooms** with **wildly different but internally consistent themes** (environment, enemies, boss).
- **Controller + keyboard/mouse support** (Xbox/PlayStation layouts).
- **Modular, extensible architecture** for future expansion.

**Goal:** Deliver a **playable prototype** with 2-3 room themes, clean code, and a README for setup.

---

---

## **Core Requirements**

### **1. Perspective System**

- **Default:** Third-person over-the-shoulder camera (similar to *Gears of War*).
- **ADS Mode:** Seamless transition to first-person view when aiming down sights.
- **Smooth interpolation** between camera modes to avoid jarring transitions.

### **2. Art Style**

- **Cel-shaded rendering** using Babylon.js custom shaders or post-processing.
- **Bold outlines**, flat colors, and minimal gradients for a cartoonish aesthetic.
- **Stylized low-poly or semi-realistic models** that fit the cel-shaded look.

### **3. Gameplay Loop**

- **Procedural room generation** with randomized layouts and enemy spawns.
- **Roguelike mechanics:** Permadeath, randomized room themes, and loot.
- **Room progression:** Player clears rooms of enemies, with the final room being a boss fight.
- **Boss fights:** Unique boss for each theme, with mechanics tailored to the room's theme.

### **4. Combat**

- **Shooting mechanics** with a primary weapon (e.g., assault rifle or pistol).
- **ADS (Aim Down Sights)** improves accuracy and switches to first-person view.
- **Enemy AI:** Basic pathfinding, shooting, and dodging behaviors.
- **Health system** for player and enemies.

### **5. Controls**

- **Full gamepad support** (Xbox/PlayStation layouts).
- **Keyboard/mouse fallback** (WASD + mouse look).
- **Input mapping:**
  
  | Action   | Gamepad      | Keyboard/Mouse |
  | -------- | ------------ | -------------- |
  | Movement | Left stick   | WASD           |
  | Look     | Right stick  | Mouse          |
  | ADS      | LT (trigger) | Right-click    |
  | Shoot    | RT (trigger) | Left-click     |
  | Jump     | A            | Space          |
  | Reload   | X            | R              |
  

### **6. Technical Stack**

- **Framework:** Babylon.js (latest stable version).
- **Language:** TypeScript.
- **Physics:** Babylon.js built-in or Ammo.js for collisions.
- **Input:** Babylon.js Gamepad API + keyboard/mouse events.

---

---

## **Procedural Room Generation**

### **Room Themes**

Each room is assigned a **randomly selected theme** that defines its:

- **Environment** (e.g., forest, cyberpunk, desert, dungeon, alien).
- **Enemies** (e.g., robots for cyberpunk, zombies for dungeon, xenomorphs for alien).
- **Boss** (only in the final room, thematically consistent with the room).

**Key Rule:** All elements in a room (walls, floor, enemies, props) **must match the theme**.

### **Theme Examples**


| Theme     | Environment          | Enemies               | Boss             |
| --------- | -------------------- | --------------------- | ---------------- |
| Forest    | Trees, grass, ruins  | Wolves, Archers       | Treant           |
| Cyberpunk | Neon city, holograms | Drones, Hackers       | Cybernetic Titan |
| Desert    | Sand, pyramids       | Scorpions, Bandits    | Sand Worm        |
| Dungeon   | Stone, torches       | Skeletons, Bats       | Lich             |
| Alien     | Bio-organic, slime   | Xenomorphs, Parasites | Hive Queen       |


### **Implementation Notes**

- Use a **`RoomTheme` interface** to define assets, enemies, and props for each theme:
  ```typescript
  interface RoomTheme {
    name: string;
    environment: {
      floorTexture: string;
      wallTexture: string;
      props: string[]; // e.g., ["cactus", "barrel"]
      lighting: { color: string; intensity: number };
    };
    enemies: EnemyType[];
    boss?: BossType; // Only for boss rooms
  }
  ```
- **Procedural generation** should ensure:
  - Random theme selection for each room.
  - Randomized but **thematically consistent** enemy spawns and props.
  - Final room is always a **boss fight** with a theme-consistent boss.

---

---

## **Architecture Guidelines**

### **Modular Design**

Separate systems into **reusable classes/modules**:

- `PlayerController` (movement, shooting, ADS).
- `CameraSystem` (third-person + first-person switching).
- `RoomGenerator` (procedural room creation with theme selection).
- `ThemeManager` (loads and applies theme-specific assets and logic).
- `EnemySystem` (AI, spawning, behaviors).
- `CombatSystem` (damage, health, weapons).
- `InputManager` (unified input handling for controllers/keyboard).

### **Project Structure**

```
/src
  /core
    Game.ts             # Main game loop
    InputManager.ts     # Handles all input
    CameraSystem.ts     # Manages camera modes
  /entities
    Player.ts           # Player logic
    Enemy.ts            # Enemy logic
    Boss.ts             # Boss logic
  /systems
    RoomGenerator.ts    # Procedural rooms + theme selection
    ThemeManager.ts     # Manages theme assets and consistency
    CombatSystem.ts     # Damage, weapons
  /themes
    ForestTheme.ts      # Forest-specific assets/enemies
    CyberpunkTheme.ts   # Cyberpunk-specific assets/enemies
    DesertTheme.ts      # Desert-specific assets/enemies
  /ui
    HUD.ts              # Health, ammo, room counter
  /assets
    /models             # Placeholder 3D models
    /textures           # Theme-specific textures
  /shaders
    CelShader.ts        # Custom cel-shading
index.html
main.ts
```

### **State Management**

- Use a **finite state machine (FSM)** for player/enemy behaviors (e.g., `Idle`, `Shooting`, `Reloading`).
- Track game state (e.g., `Room`, `BossFight`, `GameOver`).

### **Performance**

- Optimize for **60 FPS** in modern browsers.
- Use **object pooling** for bullets/enemies.

---

---

## **Deliverables**

### **MVP (Minimum Viable Product)**

- Playable prototype with:
  - 1 player character (with ADS switching).
  - **2-3 distinct room themes** (e.g., forest, cyberpunk, desert).
  - **2-3 enemy types per theme** (e.g., wolves and archers for forest, drones and hackers for cyberpunk).
  - **1 boss per theme** (e.g., Treant for forest, Cybernetic Titan for cyberpunk).
  - Cel-shaded visuals.
  - Controller + keyboard/mouse support.

### **Code Quality**

- **TypeScript** with clean, commented code.
- **No hardcoded values** (use constants/config files).
- **README.md** with:
  - Setup instructions (`npm install`, `npm run dev`).
  - Controls (controller + keyboard).
  - Architecture overview (including theme system).
  - Known limitations.
  - Next steps for expansion (e.g., adding more themes).

### **Extras (If Time Permits)**

- Simple **sound effects** (shooting, enemy deaths).
- **Particle effects** (muzzle flash, hit markers).
- **Basic animations** (idle, walk, shoot).

---

---

## **Evaluation Criteria**

- **Completion:** How close to a **fully playable prototype**?
- **Architecture:** Is the code **modular, extensible, and well-organized**? Does the theme system work cleanly?
- **Gameplay:** Are the **core mechanics (ADS, shooting, room progression)** functional?
- **Visuals:** Does the **cel-shaded style** hold up? Are the **themes visually distinct**?
- **Consistency:** Are the **rooms internally consistent** (environment, enemies, boss)?
- **Controls:** Are **controller and keyboard inputs** responsive?
- **Performance:** Does it run smoothly in a browser?

---

---

## **Priority Checklist (MVP)**

- [ ] Third-person camera with ADS switching.
- [ ] Cel-shaded rendering.
- [ ] 2-3 room themes (consistent environments/enemies/bosses).
- [ ] Controller support.
- [ ] Boss fight in final room.
- [ ] Modular architecture.

---

---

## **Notes**

- Prioritize **core gameplay** (movement, ADS, shooting, room progression) over polish.
- Use **placeholder assets** (colored cubes/spheres with theme-appropriate materials) if 3D models are time-consuming.
  - Example: Use **green textures for forest**, **neon for cyberpunk**, **sand colors for desert**.
- Ensure the **camera transition** is smooth and **controller input** is reliable.
- **Avoid over-engineering**—focus on a **solid foundation** for future expansion.
- For the prototype, **2-3 fully implemented themes** are sufficient to demonstrate the system.
