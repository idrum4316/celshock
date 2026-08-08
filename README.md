# HOLLOWMERE — Cel-Shaded Conquest

A browser-based, single-player **Conquest** shooter built with **Babylon.js** and
**TypeScript**. Eight-a-side against bots over five control points in a
fog-drowned horror village, in **first person** (aiming down sights brings the
the fitted sight onto the centre of the screen and zooms the view) with a
low-poly cel-shaded look: a near-black valley lit by guttering
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
npm run icons    # regenerate the install icons under public/icons (committed)
```

Requires Node 18+ and a WebGL2-capable browser (Chrome/Edge/Firefox/Safari).

## Installing it

The build is an installable app (a PWA): a web app manifest, generated icons,
and a service worker that caches the whole bundle, so once it has loaded a
round it launches offline.

- **Android / Chrome / Edge** — open the site, then _Install app_ from the
  browser menu (or the prompt in the address bar). It launches fullscreen and
  landscape, without browser chrome.
- **iOS / Safari** — open the site, _Share_ → _Add to Home Screen_. iOS gives
  it a standalone window rather than true fullscreen; that is as far as Safari
  goes.
- **Desktop Chrome/Edge** — the same _Install_ works, and gives it its own
  window.

Left in a browser tab on a phone, the first tap takes the screen and locks it
to landscape instead, so the URL bar is out of the way either way.

This needs the site served over **HTTPS** (or `localhost`) — a service worker
will not register otherwise, and without one there is no install prompt.

**A phone still needs a controller.** The game reads keyboard, mouse and
gamepad; there are no on-screen touch controls, so a phone plays it with a
Bluetooth pad paired to it and not with thumbs on the glass.

## Controls

| Action     | Gamepad (Xbox / PS) | Keyboard / Mouse |
| ---------- | ------------------- | ---------------- |
| Move       | Left stick          | WASD             |
| Look       | Right stick         | Mouse            |
| Sprint     | L3 (toggle)         | Shift (hold)     |
| Crouch     | B / ○ (hold)        | Ctrl or C (hold) |
| ADS        | LT / L2             | Right-click      |
| Shoot      | RT / R2             | Left-click       |
| Jump       | A / ✕               | Space            |
| Reload     | X / ▢               | R                |
| Grenade    | RB / R1             | G                |
| Scoreboard | Back / Share        | Tab              |
| Loadout    | Y / △ (menus)       | L (menus)        |
| Confirm    | A or Start          | Enter / Click    |

Click the page once to capture the mouse (pointer lock). Gamepads use the
browser's standard mapping and are hot-pluggable — press any button after
connecting. Pads with vibration support get **rumble** for shots, hits,
kills, and damage taken (requires a browser with the Gamepad haptics API,
e.g. Chrome/Edge with an Xbox or DualSense controller).

Gamepad look comes with **aim assist**: the stick slows down while the
crosshair is over an enemy, and the view pulls gently toward the target
(full strength while aiming down sights, weaker at the hip while firing or
steering). Pushing the stick against the pull cancels it — a committed push
always breaks free. It only engages while the right stick is the active
look device — the moment the mouse moves, assist disengages and sensitivity
is untouched, so mixed setups never penalize keyboard/mouse aim.

### How a round works

- Two teams of sixteen — the **Wardens** (warm amber) and **the Blight** (cold
  crimson) — fight over **five control points** across a 240 × 240 m village.
- Stand inside a zone to capture it. More bodies capture faster, with
  diminishing returns; if both teams are inside, the meter freezes. A flag has
  to be swept through **neutral** before it changes hands, so you cannot steal
  one by briefly outnumbering the defender.
- Every zone is **drawn in the world**: a coloured ring on the ground marking
  the exact capture boundary, a low glow that rises from the stretch of it you
  are walking up to, and a beacon over the flag you can see across the village.
  They carry the owner's colour and pulse while the flag is being taken. Step
  inside and a panel names the point and shows the meter running.
- Each team starts with **400 reinforcements**. Every death costs one, and
  whichever side holds **fewer flags bleeds** tickets steadily on top. Winning
  fights while ignoring objectives still loses the round.
- Everyone — you and every bot — spawns with **two frag grenades** and no way
  to get more. They arc, bounce off walls and roll, go off on a fuse rather
  than on impact, and are lethal at the centre and survivable at the edge.
  Fragments do not go through walls, so a corner is real cover. The blinking
  red pip on one that has landed near you is the only warning you get.
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

## Tech in one paragraph

Everything you see and hear is generated at runtime: every mesh is built from
Babylon primitives and merged per colour, all audio is synthesized WebAudio,
the cel look is a custom `ShaderMaterial` with 16 dynamic point-light slots,
and the 16 bots steer on a precomputed nav grid with one flow field per
objective — no pathfinding and no physics engine.

**Contributor/agent documentation lives in [`CLAUDE.md`](CLAUDE.md)** —
architecture, load-bearing invariants, and conventions. Every source file also
has a contract header at the top.

## Known limitations

- Characters (bots) are primitive assemblies, not modeled/rigged meshes; all
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
- **No touch controls.** The game installs and runs on a phone, but every input
  is keyboard, mouse or gamepad — a touch is only good for the menus' "tap to
  continue", so playing on a phone means pairing a controller.

## Next steps for expansion

- A second map: one new `layout.ts` plus an `EnvironmentSpec`.
- Kits and weapon variety — extract a `WeaponType` the way themes were data.
- Squad orders, so friendly bots can be told which flag to take.
- Deliberate cover selection and suppression in the bot FSM.
- Vehicles, which would need new physics, camera modes, and AI.

## License

[MIT](LICENSE) — do what you like with it, including commercially, as long as
the copyright notice travels with the copy.

One license covers the whole repository, which is only possible because there
are no authored assets to license separately: every mesh is built from Babylon
primitives at runtime and all audio is synthesized. The dependencies are
permissive and compatible — Babylon.js is Apache-2.0, and the Havok physics
build pulled in by `@babylonjs/havok` (the one binary that ships, for the
ragdolls) carries its own MIT terms from Babylon.js.
