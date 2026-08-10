# VERIFYING.md

How to drive this game from a headless browser, and the quirks that have already
cost time doing it. Split out of [`CLAUDE.md`](CLAUDE.md), which with the
subsystem contracts under [`docs/`](docs/) is still the source of truth for
architecture and invariants — read this when you are writing a smoke test, not
when you are reasoning about a change.

Playwright + Chromium are devDeps for ad-hoc smoke tests; write throwaway scripts
to the scratchpad, not the repo. `Game`'s constructor exposes `window.__celshock`
(`g` below). Headless quirks that have already cost time:

- Headless SwiftShader runs at ~2 fps and `dt` is clamped to 0.05, so **game time
  runs at ~25% of wall clock**. Don't wait for bots to cross a 240 m map — force a
  skirmish by overriding `battle.spawnPointFor`, or drive rules directly with
  `conquest.update(1/60, fakeCombatants)` in a loop.
- Getting into `playing` takes an indeterminate number of Enter presses (the menu
  gates confirm on `overlayT > 0.5`), so press until `state === "playing"`. A LONG
  PRESS is what registers — `keyboard.press()` can fit the down and up inside one
  ~0.5 s frame gap, leaving the key set empty on every `input.update()`. A long
  wait after getting in gets the player killed (state drops to `deploy`, pose
  freezes) — override `player.takeDamage` to stand still.
- Assigning `input.ads` or `cameraSys.adsBlend` does not stick;
  `InputManager.update()` rewrites the flag every tick. Redefine instead —
  `Object.defineProperty(g.input, "ads", { get: () => true, set: () => {} })` —
  and let `CameraSystem` converge.
- Recoil/spread measured headless is wrong (fewer frames per shot means less
  spring-back) — never tune from it.
- `Game.updateGameplay` pushes HUD state every frame, so `hud.setScoreboard(...)`
  by hand is overwritten next tick. Drive the input (`page.keyboard.down("Tab")`).
- Free a stuck vite port by PID from `ss -tlnp`. Never `pkill -f vite` — it
  matches the calling shell.
- The muzzle flash is unhittable at 2 fps (`gunfeel.flashTime` 0.05 s); force it
  with `player.flashRoot.setEnabled(true)`.
- **Sight alignment is checkable without a picture**, and should be after anything
  touching the viewmodel or camera — for **every** optic, since each carries its
  own eye reference. Take
  `scene.getTransformNodeByName("view_<weapon>_<sight>_sightCenter")
  .getAbsolutePosition()` (all twenty-five of
  `rifle`/`carbine`/`smg`/`dmr`/`lmg` × `reflex`/`iron`/`holo`/`prism`/`scope`, since
  a weapon change moves the optic too, plus `view_pistol_iron_sightCenter`), subtract `cameraSys.camera.position`
  (the camera is the CameraSystem's, not a field on `Game`), and project onto
  `cameraSys.forward` and a right vector built from `cameraSys.aimYaw` — `(cos(aimYaw), 0,
  -sin(aimYaw))`. **Not `flatRight`**, which is deliberately the un-recoiled and
  un-swayed yaw (see `camera.aimSway`) and so is not perpendicular to `forward` while either is live;
  through it a correct sight reads millimetres off. At `adsBlend === 1` both
  cross-axis components must be **0** and the along-axis one is that sight's
  `eyeRelief × zoomComp`. Let the weapon settle first — the sway spring decays over
  several seconds headless and reading through it looks exactly like a misaligned
  sight; watch `player.view.swayX` fall rather than trusting one sample.
  **Alignment is not occlusion, and only the second needs a picture**: a sight can
  read a perfect zero and still be looking at the weapon's own stock, which is what
  the DMR's irons did. `optics.ts`'s `ironSightFloor` keeps geometry out of the
  aperture; a screenshot at `adsBlend === 1` confirms it.
- **A fire mode is a synchronous test, and the burst has to be one.** Its rounds
  are 0.05 s apart and headless frames are 0.5 s, so nothing about it is
  observable by holding a key down. `player.tryShot(trigger)` is a pure state
  machine over `fireCooldown`/`triggerHeld`/`burstLeft`: zero the cooldown by
  hand between calls and a whole burst, a refused held trigger and an abandoned
  remainder are one `page.evaluate`. What to assert is the pair the mode is made
  of — `tryShot(false)` returning **true** while rounds are owed, and
  `tryShot(true)` returning **false** on a trigger that was never released.
- **Grenades are testable without waiting for a round**: `g.grenades` takes
  `throwAlong`/`throwAt` and `g.grenades.update(1/60)` steps the flight, so a whole
  detonation is a synchronous loop in one `page.evaluate`. A bot moved by hand must
  be put back to `alive = true` between blasts — `takeDamage` kills it and
  `hittablesAgainst` then leaves it out, which reads exactly like broken falloff.
  "0 damage" at a plausible range is usually the LOS ray finding a wall: sample the
  same distance in all four compass directions before believing it.
- **The blast DUST is not steppable that way** — the puffs run on the GPU and
  advance on RENDERED frames by `updateSpeed * scene.getAnimationRatio()`, and
  headless that ratio is the real frame delta (~30 at 2 fps, not clamped), so a
  2.4 s cloud is three frames. Override `scene.getAnimationRatio`: 0 freezes the
  dust, and `seconds * 60` for exactly one rendered frame (counted on
  `scene.onAfterRenderObservable`) steps the cloud to a known age and holds it.
  Also: `dust.burst()` needs a real `Vector3` (`copyFrom` reads `_x`/`_y`/`_z`, so
  a plain `{x,y,z}` silently gives a cloud at NaN), and `getActiveCount()` is the
  ring size, not live puffs.
- **The throw and swap ANIMATIONS are still-frame jobs**, and 2 fps is plenty.
  Redefine the clock each is posed from — `Object.defineProperty(g.player,
  "throwT", { get: () => 0.145 })` with `throwPending = false` so the frozen frame
  does not also throw a real grenade; `swapPending = false` first (or
  `completeSwap` fires every frame) then `swapT` pinned to `0.34 * 0.42` for the
  peak. Live-tune the hand by writing `g.player.view.throwKeys[i].pos/rot` —
  resolved from `CONFIG` once at construction, so poses are editable in place while
  timing and give are not. The swap's transient will fool the sight check: taken
  just before a reading it leaves the weapon halfway up and measures as a sight
  ~0.22 m low, so watch `player.swapT` reach -1 AND the sway decay first.
- **A ragdoll is steppable synchronously, like a grenade, and must be**:
  `g.ragdolls.update(1/60)` in a loop runs a whole tumble, settle, sink and retire
  in a fraction of a second. Move a bot, `bot.takeDamage(999, shooterOrigin)`, then
  `g.ragdolls.spawn(bot, camPos)`, which returns whether it was accepted. Four
  traps. **Reading a rig joint's world position needs `computeWorldMatrix(true)`
  first** — outside the render loop `getAbsolutePosition()` is a stale cache, and a
  joint that looks pinned while its proxy falls is that, not a broken hand-off. **A
  bot reused between takes needs `alive = true` and `hp` restored.** **The camera's
  pitch is negative for down** (`forward.y = sin(pitch)`), so placing bodies along
  `cameraSys.forward` while pitched throws them into the air — build a horizontal
  basis from `aimYaw`. And **the settled pose is a numeric question first**: the
  joints' height spread says face-down (all within ~0.01 m) or on its side
  (~0.5 m), which a headless screenshot at this scale will not.
- **The death cam is the one thing NOT steppable synchronously**, by design: it is
  a game state, so it advances only from `tick` — ~80 s of wall clock for its 4 s.
  SAMPLE `g.deathCam.elapsed` rather than sleeping a fixed wait. Everything else is
  forceable: `g.player.takeDamage(999, from)` enters it with a known impact
  bearing, `g.deathCam.corpse` is the stand-in body (`.rig`, `.ragdolling`), and
  `g.deathCam.stop()` + `g.state = "playing"` + `g.player.fullReset()` gets back
  out. The corpse rig is built ONCE per process and never rebuilt, so a leak is
  permanent: assert `rotationQuaternion === null` on all nine posed joints
  afterwards, plus each one's parent and local position against `rig.rest`. The
  fallback path is reached with `g.ragdolls.setEnabled(false)` before the kill;
  check the rig is STILL ENABLED past `bots.death.hideTime`, the one way it differs
  from `Bot`'s copy of the tween.
- **The ash field is frozen for a pixel diff with `stop()` + `reset()`** on
  `g.atmosphere.system`. That works on `GPUParticleSystem` only because
  `Atmosphere` constructs it with `emitRateControl: true`; Babylon's legacy GPU
  mode keeps accumulating while stopped and refills the sky a second later — do not
  change that option. The field takes `maxLifeTime` to reach steady state, so let
  `getActiveCount()` settle first. Read `system` through the handle each time: a
  *different* `ParticleSpec` replaces the whole system.
- **Water needs a vantage computed, not guessed, and the map picker is
  `localStorage["hollowmere.map"]` set in an `addInitScript` before the load.** A
  `WaterRect` is not where the water is (see [`docs/world.md`](docs/world.md)): on
  Greyfen one rect covers the map and only 11% of it is wet, so scan for cells where
  `surfaceAt(x, z) < surfaceY` and aim along the longest wet run from one. Three
  things will otherwise fill the frame with something that is not water and does not
  look like a mistake — the viewmodel (`player.view.weapon.setEnabled(false)`), the
  capture skirt, which you are always inside of near a flag (`g.zones.dispose()`),
  and the **fog**: Greyfen's `fogEnd` is 78 m, so a look down a long reach is a
  uniform wall of fog colour that reads exactly like being stuck inside a mesh. Put
  the camera within ~30 m of what you are judging. `g.water.bodies[i].mat` takes
  `setVector4` with a plain `{x,y,z,w}`, so a whole sweep of wave/foam/depth tunings
  is one page session without a rebuild.
- The kit turntable needs no clicking: `g.openLoadout()` reaches it from `menu` or
  `deploy` (assign `g.state = "deploy"` first from a live round). The pose is
  readable (`player.view.inspectYaw`/`inspectPitch`), and
  `view.weapon.rotationQuaternion` must be **null** again after the screen closes
  or the carried pose never comes back — re-run the sight-alignment check after a
  session on it, since a leaked quaternion or scale shows up there and nowhere
  else.

To inspect a model in isolation, drop a throwaway `modelviewer.html` + `.ts` at
the repo root (Vite serves it as a second page) with an `ArcRotateCamera` driven
by `camera.setPosition`.
