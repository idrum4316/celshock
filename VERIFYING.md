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
- **`page.screenshot()` waits for the load event, so it cannot photograph the
  boot screen.** Hold the entry chunk back with `page.route` and the shot comes
  back showing the menu, taken seconds later once the hold expired — the DOM
  assertions in the same script are correct and the picture disagrees with all
  of them. `Page.captureScreenshot` over a raw CDP session grabs the frame as it
  stands.
- **A DOM assertion cannot prove a PAINT, and anything that covers a freeze
  needs the second one.** The building card was once booked one
  `requestAnimationFrame` ahead of the build instead of two, which is early
  enough to be in the DOM and too early to be on the glass — every markup check
  passed while the player still watched the old screen freeze. What catches it
  is a CDP screencast (`Page.startScreencast`, ack each `Page.screencastFrame`)
  taken across the stall: with the main thread blocked, whatever frame is being
  held IS what the player sees. Use node-side receipt time to find the stall;
  `metadata.timestamp` is not a Unix epoch and will not line up with
  `Date.now()`. The cheaper standing check is to no-op the blocking call and
  screenshot the moment before it would have run.
- **To prove something still MOVES under a block, count distinct frames — and
  hide everything else that animates first.** Replace the blocking call with a
  spin of a known length, screencast across it, and compare frame payloads:
  anything that differs moved without the main thread. Hide the other animated
  elements with an injected `visibility: hidden` before triggering, or the
  pulsing prompt keeps every frame distinct on its own and the test passes
  whatever the thing under test does. Frames sampled at the very edges of the
  block can come from the teardown either side of it and show the card
  half-dismantled; take the middle 80% and let PNG payload size stand in for
  "did this frame contain the bright thing" across the lot.
- **`startRound()` does not build the map — it books it.** The state goes to
  `loading` and `buildRound()` runs two animation frames later, so a script that
  calls it and reads the world on the next line gets last round's (or nothing at
  all). Wait for `state === "deploy"` rather than for the call to return, and
  time the build around `buildRound` if that is what you are measuring. To hold
  the building card still for a screenshot, replace `g.buildRound` with a no-op
  before calling `startRound`.
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
  spring-back) — never tune from it. **What headless CAN settle is the
  arithmetic**, and that is where the recoil pattern is checked:
  `player.recoilKick(adsBlend)` is a pure function of the string counter, the
  drift and the stance blends, so zeroing `fireCooldown` between `tryShot`
  calls drives a whole magazine in one `page.evaluate` and the envelope, the
  ceilings and the walk come out exact. Write the stance in by hand
  (`Object.assign(player, { crouchBlend: 1, moveBlend: 0, airBlend: 0 })`) —
  those are eased in `update` and will not hold otherwise. The viewmodel's kick
  spring is steppable the same way, and being closed-form it gives the same
  answer at any `dt`, which is the one recoil number a headless run may be
  trusted on.
- `Game.updateGameplay` pushes HUD state every frame, so `hud.setScoreboard(...)`
  by hand is overwritten next tick. Drive the input (`page.keyboard.down("Tab")`).
- Free a stuck vite port by PID from `ss -tlnp`. Never `pkill -f vite` — it
  matches the calling shell.
- **Do not edit anything under `src/` while a script is driving the page.** Vite
  pushes an HMR update, the module graph has no accept handler, and the page
  does a FULL RELOAD — which drops `window.__celshock` and every
  `Object.defineProperty` override and `window.__*` helper the script installed.
  What it looks like is a `TypeError: window.__x is not a function` tens of
  seconds after the last line that used the same helper successfully. Worse than
  the crash is the case where it does not crash: readings taken either side of
  the reload are against DIFFERENT source, silently. At ~2 fps a sweep runs for
  minutes, which is exactly long enough to be tempted. Finish the run, or copy
  the tree.
- The muzzle flash is unhittable at 2 fps (`gunfeel.flashTime` 0.05 s); force it
  with `player.flashRoot.setEnabled(true)`.
- **Sight alignment is checkable without a picture**, and should be after anything
  touching the viewmodel or camera — for **every** optic, since each carries its
  own eye reference. Take
  `scene.getTransformNodeByName("view_<weapon>_<sight>_sightCenter")
  .getAbsolutePosition()` (all twenty-five of
  `rifle`/`carbine`/`smg`/`dmr`/`lmg` × `reflex`/`iron`/`holo`/`prism`/`scope`, since
  a weapon change moves the optic too, plus `view_pistol_iron_sightCenter`) and put it
  in the CAMERA's frame — `computeWorldMatrix(true)` on both, then transform the
  point by `cameraSys.camera.getWorldMatrix().clone().invert()` (the camera is the
  CameraSystem's, not a field on `Game`). At `adsBlend === 1` the answer is
  `(0, 0, eyeRelief × zoomComp)` for that sight; measured across all
  twenty-five, the worst cross-axis component is **6 µm**, so anything above a
  few thousandths of a millimetre is real. Prefer this to projecting the
  world-space offset onto a hand-built basis: the camera's own matrix already
  IS the basis, it needs no argument about which yaw to use, and it hands you
  the expected value instead of a pair of numbers that should be zero.
  - **Waiting three frames is necessary and is not always sufficient — check
    `view.swayX`/`view.swayYaw` have actually decayed.** The viewmodel's own
    sway trails the camera's look rates, and the aimed hold sway keeps the
    camera turning forever, so a reading taken while it is still settling is
    off by tens of microns. Measured: the first optic sampled after entering a
    round read **38 µm** of cross-axis error at four frames and **4.8 µm** at
    forty-four, with `swayX` falling from 1.3e-4 to 1.2e-13 across the same
    span. Every other optic in the same run was under 10 µm, which is the tell
    — one outlier that is also the first sample is a transient, not geometry.
  - Projecting by hand still works, but **not through `flatRight`** — that is
    deliberately the un-recoiled and un-swayed yaw (see `camera.aimSway`), so it
    is not perpendicular to `forward` while either is live and a correct sight
    reads millimetres off. Build the right vector from `cameraSys.aimYaw`:
    `(cos(aimYaw), 0, -sin(aimYaw))`.
  - **WAIT ON RENDERED FRAMES, NOT ON THE SPRINGS** — this is the one that
    produces a confident wrong answer. `Game.setWeapon`/`setSight` apply a kit
    **synchronously and without a swap** (the path is written for the menu,
    where the gun is already put away), so `applyFit` moves `adsPos` on the spot
    while `swapT`, `adsBlend`, `swayX` and `swayPitch` are all still carrying the
    PREVIOUS combination's settled values. A predicate over those is true before
    a single frame has re-posed anything, and what you then measure is the old
    weapon's pose against the new weapon's sight node. Count
    `scene.onAfterRenderObservable` and wait three frames past the fit change; at
    2 fps that is a real wait, and the tell that you skipped it is
    `view.weapon.position` reading **identical across combinations** while
    `view.adsPos` varies. Read the two side by side and they must be equal.
    Measured wrong this way, twenty-three of twenty-five optics come back 1–22 mm
    low or high, in a pattern that correlates neatly with the sight and looks
    exactly like a real geometry bug; measured right, all twenty-five are zero.
  - **The kick's NEAR-PLANE clearance is a second reading off the same node,
    and it needs the two magnified optics specifically.** The per-shot kick
    travels the weapon toward the eye, so on the prism and the scope it can
    drive the sight through `camera.minZ`. Freeze the spring
    (`Object.defineProperty(g.player, "kickDisp", { get: () => 1.35 })`, the
    stacked-burst worst case, plus `kickDrift` pinned so the roll is in it too),
    force ADS, and read the same `sightCenter` z: it must exceed `minZ` for
    every weapon on both optics. **Do not derive this instead of measuring it.**
    The bound in `ViewModel` is computed on the weapon NODE's travel while what
    has to clear the plane is the SIGHT, which the kick's pitch and roll swing
    by another ~4 mm — derived, the DMR with the prism reads 6.2 cm and
    measures 3.8.
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
- **A pixel diff needs the frame FROZEN, and three separate things move it.**
  Measured noise floor between two consecutive grabs with nothing changed at all:
  **42-47% of pixels**, which swamps anything being looked for. The grade's grain
  is by far the largest — it is re-hashed every frame at ~14 LSB, so
  `g.post.setEnabled(false)` on its own takes the floor to **0.00%**. The ash is
  next (see below), and `g.sky.update = () => {}` pins the cloud decks, which
  drift even under the pause lid because `sky.update` is called from `tick`
  OUTSIDE `updateGameplay`. Check the floor by grabbing twice and diffing before
  trusting any measurement; a method that cannot reach zero is not measuring what
  you think.
- **The pause lid is a free camera.** `g.state = "paused"` stops `updateGameplay`
  while the scene still renders, so nothing overwrites `cameraSys.camera` and it
  can be placed by hand — `cam.position.set(...)` plus `cam.setTarget(...)` frames
  a roofline or a shadow edge from anywhere, which beats hunting for a vantage by
  walking the player. Two caveats: `camPos` is a uniform pushed in
  `updateGameplay`, so it stays at the player's last value and the fog, mist and
  rim in that frame are computed from the wrong eye — fine for geometry and
  shadows, wrong for anything about distance. And the HUD does not appear in a
  canvas grab, so the pause card is invisible to `readPixels` even though a
  Playwright `screenshot()` shows it.
- **One vantage per process run when the numbers matter.** Cycling
  `paused → playing → paused` between vantages lets a frame of gameplay run, and
  the player moves, falls or gets shoved in it. The same measurement taken as the
  second of two vantages read 55 runs against 30 for the first — enough to invent
  a result. Relaunch per vantage.
- **A "does this surface do X" diff needs a MASK of that surface**, or it is
  measuring whatever else is on those pixels. Build it by toggling the thing off:
  grab, `mesh.setEnabled(false)`, grab, and the pixels that changed are its. That
  is what separates "the grass now takes shadows" from "the ground under the grass
  always did" — and at a downsampled resolution it does NOT work, because every
  blade pixel is a blend of grass and ground. Grab at full canvas size.
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
