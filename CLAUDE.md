# CLAUDE.md

The rules for AI coding agents (and contributors): what each thing owns, what is
load-bearing, and what must never be undone. `AGENTS.md` points here; `README.md`
is user-facing. Three companions carry what is looked up rather than reasoned
about, so this file stays the part worth reading end to end:

- **`FILES.md`** — the module map, one line per file. Read it to find the right
  module.
- **`VERIFYING.md`** — headless-browser quirks and how to force each subsystem.
  Read it before writing a Playwright script.
- **`FINDINGS.md`** — the open-threads list: measured, worth doing, not yet done.
  Read it before performance work; delete an entry when you fix or disprove it.

A rule belongs here, not there. If you add something to a companion that a change
could silently break, it is a rule and it belongs in this file.

**Every source file has a contract header** stating what it owns, its invariants,
and what it must never do. Read it before editing that file.

## Project overview

**HOLLOWMERE — Cel-Shaded Conquest**: a browser-based, single-player
**first-person** Conquest shooter (8v8 vs bots, five control points, ticket
bleed). **Babylon.js** + **TypeScript**, bundled with **Vite**. ES modules, Node
18+, WebGL2 required.

**Zero audio files and zero model files** — every mesh is built from Babylon
primitives at runtime, all sound is synthesized WebAudio (`src/core/Sfx.ts`). Do
not add asset files unless explicitly asked. Two exceptions, both generated or
vendored rather than authored: `public/icons/` and Havok's `.wasm`.

**Havok's `.wasm` (~2 MB) is the one binary that ships**, pulled in by
`@babylonjs/havok` for the ragdolls on an explicit request. It is never named by
path: Havok's ESM glue resolves it against its own `import.meta.url`, which Vite
follows and emits as a content-hashed asset versioned with the dependency. Do
**not** also hand-place a copy in `public/` — that ships and precaches 2 MB twice.

**`optimizeDeps.exclude` in `vite.config.ts` is load-bearing for DEV.** The dep
optimizer copies the glue into `node_modules/.vite/deps/` and leaves the binary
behind, so the URL 404s and the SPA fallback answers with `index.html`. The error
blames the wrong thing twice — an `application/wasm` MIME complaint, then
`expected magic word 00 61 73 6d, found 3c 21 64 6f` (`<!do`) — and no MIME
tuning fixes either. **A production build resolves the asset itself, so `vite
preview` works with or without the exclusion; testing only there will not catch
this.** Deployed nginx needs nothing (`application/wasm` is in its bundled
`mime.types`; the web app manifest is not, which is why only that has a block in
`docker/nginx.conf`).

**The same optimizer bites from the other side: never add a deep static import
into `@babylonjs/core`.** A new subpath entry (`@babylonjs/core/Shaders/...`)
makes Vite re-optimize the dependency *mid-session*, which rewrites the chunk
files Babylon's OWN dynamic `import()`s resolve against — and the ones a running
page already holds then 404. It cost a debugging session: the casualties were
`glowMapGeneration.vertex` and `default.vertex`, so the glow layer and every
`StandardMaterial` in the game silently lost their shaders and **everything that
glows stopped glowing, with nothing wrong in the renderer at all**. The dev
server console names the missing chunks; the browser only shows the symptom.
Confirmed by control: re-adding two such imports to a running server 404s a dozen
Babylon chunks, removing them is clean. A fresh start (or `rm -rf
node_modules/.vite`) re-optimizes cleanly and hides it, which is why this
survives a restart for whoever pulled the change but never reproduces for whoever
wrote it. Anything needing a Babylon shader's source must **wait for Babylon to
import it** (`OutlineFog.applyWanted` is the worked example) rather than reach
for it directly. The two `ShadersInclude/bones*` imports in `CelShader.ts`
predate this and are load-bearing; do not take them as licence for more.

**There is no rigged character asset in the tree.** `GlbSoldier.ts`,
`entities/soldier/`, its `models/*.glb` and `@babylonjs/loaders` were deleted when
first person retired them — the camera is inside the head, so there is no own-body
to render. The death cam deliberately does not bring them back: it stands up a bot
rig, because four seconds of screen time is not worth megabytes in the bundle, and
the bot rig is already what the ragdoll's bone table is measured against.
Everything a character needs is procedural (`SoldierModel.ts`). Do not reintroduce
a GLB body, and do not extend that approach to bots or weapons.

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run typecheck  # tsc --noEmit (strict, noUnusedLocals/Parameters)
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
npm run icons      # regenerate public/icons (committed)
```

No test suite, no linter. `npm run typecheck` is the only automated gate — run it
after any change.

### Manual/automated verification

Playwright + Chromium are devDeps for ad-hoc browser smoke tests; write throwaway
scripts to the scratchpad, not the repo, and drive them through the
`window.__celshock` handle `Game`'s constructor exposes. **[`VERIFYING.md`](VERIFYING.md)
is the list of headless quirks** — the ~2 fps frame budget and what it invalidates,
how to force ADS / a grenade / a ragdoll / the death cam, and the sight-alignment
check every viewmodel or camera change owes. Read it before writing the script,
not after it misleads you.

## File tour

**[`FILES.md`](FILES.md)** is the module map — one line per file, stating what it
owns. The rules those modules obey are below.

## Architecture

### Ownership and wiring

`src/core/Game.ts` is the only place systems meet. Systems never import each
other; `Game` wires them with callbacks (`battle.onBotKilled/onBotFired`,
`conquest.onCaptured/onNeutralised`, `player.onDamaged`, `deployScreen.onDeploy`)
and hands bot AI a `BattleCtx` (in `entities/Bot.ts`) built once rather than
rebuilt per frame. New cross-system behavior belongs in that wiring, not in an
import between systems.

**`installMap` is the one place a map is built**, and both callers — a round
starting and an editor rebuild — go through it. It disposes the standing map,
builds `this.mapDef`, and hands the result to every system that reads geometry or
environment off it: shadows (casters, key light, fog range), atmosphere, water,
grass, the player's terrain, the grenade pool, the physics body. It was once two
copies that had drifted apart, and the failure is silent: a system added to the
round's copy and forgotten in the editor's keeps a cached pointer into a *disposed*
map, so the editor renders last build's water over this build's terrain and
nothing throws. **Anything new that consumes a `GameMap` or an `EnvironmentSpec`
goes in `installMap`.** What stays with the callers is what they genuinely
disagree about: the round applies the environment and repaints the sky while the
editor drives `applyEnvironment` itself so it can toggle its work light, and the
round alone owns what is about a *fight* — battle, conquest, flag markers, minimap.

`Game`'s state machine is `menu -> deploy -> playing -> dying -> deploy`, with
`roundover` when a side runs out of tickets. The 3D scene renders in **every**
state, which is what lets the deploy screen and the menu sit over a live view.

**`dying` is the death cam and is a STEP, not a lid** — `updateWorld` runs in full
underneath it. **`loadout` and `paused` are lids**: each records which state it
covered (`loadoutFrom` / `pausedFrom`) and puts it back. The loadout screen covers
`menu` or `deploy`; a pause covers `playing`, `dying` or `deploy`, so a pause taken
while waiting out a respawn returns to the deploy map rather than dropping the
player into the world.

Pausing is just `tick` not calling `updateGameplay` — everything else still
renders, so the round reads as held rather than gone — plus two things that would
leak past it: `Sfx.setSuspended` stops the audio clock (the tail of the last shot
is still there on return, and the voice counter stays honest because nothing ends
while the clock is stopped), and the HUD is ticked with `dt = 0` so the killfeed
and toasts freeze with the world instead of fading off a frozen screen.

**Losing the pointer lock is the trigger, and it has to be.** Escape belongs to
the browser — it is the UA's gesture for dropping the lock and the keydown behind
it is not reliably delivered — so `Game` pauses on the *transition* out of the
lock, which also covers alt-tab and any focus loss. A player who never took the
lock (a pad player) has none to lose, hence the transition test rather than a bare
"not locked". `Escape` and gamepad Start are the second trigger, through
`input.pausePressed`; Start also raises `confirmPressed` (it is the menus' deploy
button), so the paused branch handles pause first and breaks. Gamepad **B** resumes
(`menuBackPressed`). The list is confirmed with `menuConfirmPressed` — Enter and
pad A but *not* the mouse — because a click on the empty half of a pause screen is
not a menu choice. Re-taking the lock on resume tolerates a rejection: Chrome
refuses one for about a second after Escape released it, which is exactly how a
pause ends, and the next click gets it.

`#hud.paused` is deliberately **not** `.overlaid`: the menu and round-over card
hide the gauges because what is under them is last round's, while under a pause the
tickets, flags and vitals are current and frozen with the scene. It hides what
would be lying — crosshair, hitmarker, damage arcs, mouse hint. It is also the one
overlay taking pointer events across its whole area, because the deploy screen
underneath takes them too and a click through the backdrop would land on its map or
Deploy button.

`Game.updateGameplay` has a load-bearing order at the end of the frame: camera
update → `mats.updateCamera()` → carried-light updates → `lighting.update(dt,
camera.position, mats)` → `sfx.setListener()`. Light slot selection, shader fog and
audio panning all key off the camera position.

`ConquestSystem.update` runs *before* `BattleSystem.update`, so a bot's think tick
sees this frame's flag ownership rather than last frame's.

### First person, and the weapon on the camera

The camera sits **at `Player.eyePos`** — the same point `CONFIG.camera.eyeHeight`
defines and the same point bots test LOS against, so what a bot can see of you is
what you can see of it. There is **no player body mesh at all**: the player renders
only the viewmodel, its brass, and the blob shadow. There is no occlusion pick and
no camera pull-in — a camera inside the head has nothing to be occluded by.

**Crouch is that one point moving, and it only works because it is one point.** It
eases `eyePos` down to `CONFIG.player.crouchEyeHeight`, which lowers the camera,
breaks a bot's LOS and moves its aim point at once. **`Player.center` must come
down the same half metre (`crouchCenterHeight`)** or the feature inverts: bots aim
at `eyePos` and hit-test the sphere at `center`, so a dropped eye against an
unmoved sphere puts every round through the middle of the target instead of grazing
its top, and crouching makes you *easier* to kill. The two numbers keep the
sphere's top the same 0.05 m above the eye it is when standing — the
visible-but-unhittable trap `CoverMap`'s `hardHeight` documents from the other
side. The collider capsule is deliberately *not* resized: `moveWithCollisions` is
horizontal-only and the ground probe places the feet, so a shorter body buys
nothing and would owe a stand-up clearance test. Sprint outranks crouch and is
resolved first. Bots have no equivalent — their rig has no knees.

**Crouch is asked for two ways, and the split is per input.** Ctrl is a hold; `C`
and the pad's **B** flip a latch, which on a pad is the only workable shape since B
held rules out the rest of the face buttons. Both toggles share ONE latch in
`InputManager` and the hold ORs on top. B is also the menus' back button, so `Game`
calls `input.clearCrouchToggle()` wherever a B press hands control back to gameplay,
and on `spawnPlayer`.

**A latch is spent by whatever overrides it, never suspended under it.** Starting to
run spends a latched crouch; ending a run spends the sprint latch (so a pad player
who stops for a corner walks out of it); pressing either latch clears the other.
`Player.update` owns both edges, because `input.sprint`/`input.crouch` are only the
*ask* — the stick, the optic and the reload decide whether a sprint is happening —
and it calls back into `InputManager.clearCrouchToggle`/`clearSprintToggle`. **Held
keys are exempt**: Shift and Ctrl are a live ask, so a Ctrl held through a sprint
still crouches you when the sprint ends.

`src/entities/ViewModel.ts` owns the weapon: the carried gun plus two gloved arms,
parented to the camera and posed in camera space.

- **The aimed pose is derived, not authored.** `adsPos` cancels the FITTED sight's
  own `sightCenter` offset (times `viewmodel.scale` — the node's position is in the
  camera's frame while the sight's offset is in the weapon's) so that sight's
  reticle lands on the camera axis at its own `CONFIG.sights[id].eyeRelief`,
  projecting to the exact centre of the screen, where `CombatSystem` sends the
  bullets. Hand-tuning it — or forgetting the scale factor, which puts the sight a
  couple of degrees low — gives a sight picture that looks plausible and shoots
  high. `applyFit` is the only thing allowed to write it and owes a re-derivation on
  every loadout change, **including a change of weapon**, because the same optic
  sits at a different height on each one.
- **The viewmodel renders in `VIEWMODEL_GROUP` (1).** Babylon clears depth between
  rendering groups, so the weapon draws over the world instead of being sliced open
  by the wall the player stands against. Anything attached joins that group —
  Player's muzzle flash does; the ejected brass deliberately does **not**, because it
  is thrown into the world and should be occluded like anything else.
- **Scale and stand-off are a framing decision, not realism.** A 54° vertical FOV
  against a real eye's ~130° means a rifle framed where a rifle actually sits fills
  the screen; `viewmodel.scale` shrinks it and `hipPos.z` pushes it out. That pose is
  authored for the rifle's length, so a shorter weapon adds its own `hipZ` or an SMG
  reads as being held at arm's length.
- **The camera owns the bob phase; the weapon reads it.** Two integrators fed the
  same number drift apart and the weapon would visibly swim against the view.
  `Player` pushes the drive with `cam.setBobDrive()` and passes `cam.bobPhase`
  through. Player runs before the camera, so that phase is one frame old — 16 ms of
  an ~0.8 s cycle.
- **Footsteps are a third reader of that phase, never a step timer.** The camera's
  vertical bob is `sin(bobPhase * 2)`, so its two dips per stride (3π/4 and 7π/4,
  where the head is lowest and a foot takes the weight) are where the sound goes.
  Cadence comes free: the bob stalls when the player stops or leaves the ground and
  `camera.bobCrouchMult` halves it in a crouch. It also means **sprinting does not
  step faster** — the drive is movement *intent*, 1 at a walk — so a sprint is louder
  boots at a walk's cadence (2.55 steps/s either way, a 2.0 m stride walking against
  2.6 m sprinting). Speeding the gait up means speeding the camera's bob up with it.
  `Player.update` returns `PlayerEvents` (`jumped`/`footstep`/`landed`) rather than
  playing anything: `Sfx` is Game's, the same split as bots emitting `onStep` and letting `Sfx.botStep` decide
  audibility from the listener position.
- **A landing is an arrival.** The ground probe's `stepHeight` tolerance keeps the
  feet glued walking down a kerb and is **grounded-only**: extended to a body in the
  air (testing `velY <= 0`) a jump lands 0.6 m early and is teleported the rest of
  the way in one frame — measured **0.656 m in a single frame against a physical
  maximum of 0.14 m**, which read exactly like a dropped frame. What replaces it is
  `CameraSystem.land()`: a damped spring given a downward *velocity* scaled by impact
  speed, so the eye sinks ~6 cm over 67 ms on a plain jump, rebounds ~1 cm and
  settles inside half a second. The camera owns the spring; the viewmodel READS
  `landDip` — one integrator, the same rule as the bob phase. The nod and roll are
  damped by `land.adsMult` while the dip is not: the eye dropping is parallax and
  moves nothing, while the rotations swing the picture off rounds that still fly
  along the un-nodded `forward`. **The roll needs
  `camera.updateUpVectorFromRotation`**: `rotation.z` reaches the view matrix only
  through the up vector, which Babylon otherwise refreshes only on frames the roll
  *changes*, baking in that frame's yaw and pitch — so the frame a landing settled on
  left a stale up vector for the rest of the round (no tilt where you landed, a
  growing one as you turned away). **The viewmodel's airborne give is sprung for the
  same reason**: `velY` is a step function at both ends of a jump, so a give read
  straight off it snapped `airDropMax` to neutral on contact.

The bob and the view punch move the **rendered camera only** — `aimPitch`/`aimYaw`
never see them, so bullets don't bob.

**The aimed hold sway is the one thing on the camera that is not cosmetic, and it
has to be.** An aimed weapon wanders — two sines an axis, pitch breathing at
~0.23 Hz and yaw at half that, tracing a slow figure-eight — and it is added to
`aimPitch`/`aimYaw`, where the bullets, the aim assist and the damage arcs all see
it. Applied to the rendered camera alone it would slide the *world* behind a sight
still welded to the axis the rounds fly down: the reticle would look alive and lie.
Applied to the aim, the sight stays centred, the world drifts, and what you shoot
is what is under the reticle. It rides the ADS blend (hip fire untouched — a drift
you fight while running is nausea, not texture) and is an *offset*, never
integrated into `pitch`/`yaw`, or a held aim would walk away on its own. Three
things scale it: `CONFIG.weapons[id].swayMult` (the DMR is steadiest at 0.7 because
sway is angular and its scope magnifies it 3.5x) and the stance multipliers `Player`
pushes through `setSwayDrive`. It is deliberately **not** normalised by
magnification the way the ADS look rates are: a sight magnifying your unsteadiness
is the trade it is asking you to make.

`Player.setBodyHidden` hides the viewmodel, which matters in the editor: it flies
the same camera the weapon is parented to.

### The loadout: three weapons, three optics, and a sidearm

Two tables, two slots, neither knowing about the other. `CONFIG.weapons` declares
what can be carried and `CONFIG.sights` what can be bolted to it;
`entities/weapons.ts` and `entities/sights.ts` derive `WeaponId`/`SightId` **from
those tables**, so each is declared in exactly one place. Every weapon *with a
rail* takes all three optics; the sidearm has no rail.

**A weapon owns the round; an optic owns the picture.** Damage, rate, magazine,
spread, range and the recoil multipliers are the weapon's and reach nothing but
`Player`; magnification, eye relief and the aimed FOV are the optic's. They meet in
exactly two places: the aimed pose (the optic's `sightCenter` on *this* weapon's
rail) and the ADS blend RATE, the product of the optic's `adsSpeedMult` and the
weapon's. `swayMult` is the weapon's alone.

Everything about an optic falls out of `magnification`: the aimed FOV is
`2*atan(tan(fovHip/2) / mag)`, the ADS look multipliers are
`camera.adsLookMouse|Stick / mag` (so the crosshair crosses the *screen* at the
same rate through any optic — a 3.5x scope on hip-fire rates is unusable), and the
viewmodel's zoom compensation is `adsMagReference / mag`. The holo is 1.6, exactly
the 0.62 rad the camera used before optics were a choice.

A weapon's numbers scale `CONFIG.recoil` rather than restating it: `recoilMult` and
`bloomMult` SCALE the per-shot terms, because the shape of recoil belongs to the
game. `bloomMult` multiplies the *ceiling* as well as the per-shot term — a weapon
that blooms faster has to be allowed to bloom further, or the extra rounds per
second cost it nothing after the second shot.

The two automatics are balanced on time to kill, not damage per second: 4 rifle
rounds at 8/s is 0.375 s, 6 SMG rounds at 13/s is 0.385 s. The choice buys how much
of the screen a burst covers and how far away it still means anything.

**The DMR steps outside that, and `semiAuto` is why it can.** Two rounds at 3/s is
0.333 s — the best ideal TTK in the kit — but the rate is a *ceiling on the trigger
finger* rather than a cadence, and the error budget pays for it: a missed rifle
round costs 0.125 s, a missed DMR round 0.333. Its `recoilMult` of 2.2 is the second
half of the bill: only 70% of a kick springs back (`recoil.recoverFraction`), so a
third of a second after a shot ~1.2 deg is still on the aim. That also makes a high
`bloomMult` cheap: at any deliberate pace the bloom has bled off before the next
round leaves.

The trigger latch lives in **`Player.tryShot`, which takes the trigger rather than
being called behind it** — a semi-automatic has to see the trigger come *up*, and a
caller that only speaks while it is down can never report one. The latch is set
*before* the alive/reloading/sprinting guards, so a trigger held through a reload
does not fire the instant the reload ends.

- **Every weapon and every optic is built once; all but one of each is
  `setEnabled(false)`.** A loadout change is a handful of boolean writes and a
  re-derived `adsPos` — never a rebuild, which would happen inside a deploy screen
  and drop Player's muzzle flash on the floor.
- **The muzzle and the ejection port are the VIEWMODEL's nodes, not the model's.**
  A model's landmarks are `Vector3`s and `ViewModel` moves its own two nodes to
  whichever weapon is carried; Player's flash is parented to one and its brass thrown
  from the other, and neither may hang off a rig that can be switched off underneath.
- **Each weapon carries its own arms.** Where a hand grips is the model's business
  (`WeaponParts.grip`/`support`) and the forearm's geometry is baked along the
  hand-to-elbow line, so an arm cannot be translated onto a shorter gun.
- **Zoom compensation is a uniform scale about the camera's origin.** Past
  `viewmodel.adsMagReference` the weapon is scaled down *and* drawn proportionally
  closer — `adsPos` and `weapon.scaling` take the same factor — which changes no ray
  direction, so the sight stays on the axis and only the apparent size is held still.
  Without it a 3.5x optic magnifies the receiver across the whole screen.
- **The additive pose offsets take that factor too** (`ViewModel.off`). Sway, bob,
  airborne give and kick are metres in the *camera's* frame, and a compensated weapon
  is drawn closer, where the same metre is a much bigger angle; left unscaled, a flick
  of sway that nudges the holo swings the scope's bore off the axis. Rotations are
  exempt — the weapon turns about its own root, so the displacement already scales.
- **The scope is a real hollow tube, so its own weapon can get into the picture.**
  A view cone spreads with distance and runs onto the barrel; the tube's height above
  the rail, its length and the scope's omission of the folded front iron are all set
  by that constraint, not by looks. How much of the frame is clear is set by the far
  rim's angular size, which is why a long eye relief turns the picture into a keyhole.
- **An optic's size and its eye relief are ONE number.** Everything the eye gets
  from a sight is angular, so halving an optic *and* the distance the eye is held at
  leaves the picture identical to the pixel while the thing on the weapon is half the
  size. `optics.ts` measures every dimension against `eyeDistance(id)` =
  `CONFIG.sights[id].eyeRelief / viewmodel.scale`; changing one alone re-sizes the
  picture instead of the sight. Two floors bound it: the camera's near plane (`minZ`
  0.05 against a stand-off of `eyeRelief * zoomComp` — the scope's 0.17 buys ~0.02 m
  of margin) and the cone's clearance over the rail, which is what the rises are.
- **A straight tube is the worst shape to spend the cone on** — a cylinder wide
  enough not to clip at the objective is far wider than the cone needs at the
  eyepiece, which is how the scope became a drainpipe. It is built as
  `SCOPE_SECTIONS` steps, each only as wide as the cone is at *its* far rim. Anything
  clamped to or standing on the tube is sized by `outerAt`, which reports the
  section's radius rather than the cone's.

**The optics are built against the weapon, not for it.** `optics.ts` takes an
`OpticMount` — the rail's height, where along it the sight sits, and its two back-up
iron stations — and measures everything from those four numbers, so the SMG's
shallow receiver and the DMR's deeper one carry the same three sights with nothing
re-tuned. Adding a weapon is a config entry, a model builder returning
`WeaponParts`, and an `OpticMount` (or, with no rail, a `fixed` sight assembly);
adding an optic is a config entry and a builder in `optics.ts`.

**The mount is not free, and the DMR is where that shows.** Two of the four numbers
are bounded by the optics rather than the receiver: the scope's cone reaches the
rail's ribs at about z = 0.59 and the holo's reaches the FOLDED front iron leaf at
about z = 0.53, which is why the DMR's rail stops where it does and why its front
iron station sits no further out than the rifle's despite a longer receiver. The
extra sight radius a marksman rifle wants comes out of the rear station instead;
`DmrModel.ts`'s `MOUNT` documents both.

**The irons bound the weapon from the other end, and that is what the stock's
heights are.** An aperture's eye relief is over half a receiver's length, so the eye
sits BEHIND the butt and everything on a stock stands in the one part of the picture
there is no looking around. `optics.ts` exports `ironSightFloor` — the underside of
the cone from the eye to the rear ring's bore — and `DmrModel` derives its comb from
it, with the butt and spine hung off the comb. A cheek riser over that line does not
clip the sight picture, it *is* the sight picture, which is what the DMR shipped
with; a comb is adjustable precisely because irons and glass want different heights,
and this is it at the bottom of its travel. Forward of the rear station the cone
runs onto the rail and the front sight's base, and that is correct.

#### The sidearm

**Every loadout carries a pistol, reachable two ways.** The mouse WHEEL swaps to
the other weapon and so does pad **Y**; `1` and `2` name a slot outright (primary,
sidearm). `drawSlot` refuses a request for the weapon already up, so a second press
of `1` costs nothing rather than replaying the animation. `InputManager` normalises
`deltaMode` and gates on `input.wheelStep` before calling a wheel event a notch, or
a trackpad's inertial fling swaps repeatedly after the fingers lift. The number keys
sit in the trap `BOUND_CODES` documents — crouch is Ctrl, and Ctrl+1/Ctrl+2 are
browser tab switches no page handler sees — which is the other reason the wheel is
named first.

The pistol is an ordinary `CONFIG.weapons` entry; the only thing making it a
sidearm is `entities/weapons.ts` keeping it out of `PRIMARY_WEAPON_IDS`. That split
is the one place the distinction is stated: the kit screen offers the primaries,
`SIDEARM` names the other, and the stat chart ranks against the primaries alone,
because a bar scaled by a weapon nobody can decline says nothing the player can act
on.

What it buys is not damage (25 a round at 5.5/s semi is the worst TTK here) but
`drawTime` 0.34 against the rifle's 0.55. **There is no reserve ammunition in this
game**, so a dry magazine is the problem the second slot solves: a third of a second
to a loaded weapon where a reload is one and a half. Refilling a slung magazine, or
making the draw as slow as a reload, removes the feature's reason to exist.

- **The two slots are an ARRAY, indexed by exactly the number on the key.**
  `PRIMARY_SLOT` is 0, `SIDEARM_SLOT` is 1, so what `1`/`2` name and what
  `Player.slot` holds are one fact with no table between. `drawSlot` is the single
  entry point; `swapWeapon` is "the other index".
- **Each slot keeps its own magazine, in a `Holster`.** A weapon put away half-empty
  comes back half-empty. `Player.ammo` is an accessor onto the carried holster rather
  than a field, so no mirrored count needs keeping in step. Both are refilled by
  `fullReset` and nothing else — the slung one explicitly, since only the carried
  weapon is reachable through `startReload`.
- **The swap is a gesture with the exchange buried inside it**, the same shape as
  the grenade throw: `Player.swapT` counts up, the pose is a TRIANGLE that takes the
  weapon fully out of frame, and `completeSwap` fires at
  `viewmodel.swap.switchFrac` — at the peak, where nothing is on screen to see the
  models change. The drop must clear the bottom edge (`viewmodel.swap` sizes it
  against the FOV) or the swap is one model popping into another.
- **Nothing fires or reloads while it is in flight**, and a reload in progress is
  cancelled rather than remembered — the magazine being worked on is going away with
  the weapon. The trigger latch survives, because it belongs to the finger.
- **Its glass is not a choice, and that is a SHAPE rather than a convention.**
  `WeaponParts.sights` is a `WeaponSights` union: `fitted` (a rail — one assembly per
  optic) or `fixed` (the notch and blade machined into the slide). `wornSight`
  resolves the fitted request into the worn answer and `ViewModel.applyFit` is its
  only caller, which keeps the aimed pose, the zoom compensation and — through
  `carriedSight` — the camera's FOV all derived from one sight. A pistol aimed down a
  3.5x scope's FOV is the mismatch the union makes impossible to spell.
- **`Player.onCarryChanged` is how the rest of the game hears about it.**
  `Game.applyCarry` pushes the camera's fit and the HUD's caption, and all three
  things that change the hands — a kit pick, a swap completing, a fresh body coming up
  with the primary — reach it without remembering to. `applyLoadout` is the kit's own
  path; the deploy and kit screens keep naming the PRIMARY.
- **`hipY` is the sibling of `hipZ`, and the pistol is why it exists.** The hip pose
  is authored around the reference weapon's bore and every long gun carries its bulk
  *above* that line; a pistol hangs below it, hands and all. Measured on 1280x720:
  without it the grip and both fists are outside the frustum.

`PistolModel.ts` is the one weapon builder that does not call `optics.ts` — a 1911
has no rail, and what stands on the back of its slide is a square notch, not the
rear aperture every optic here is built around. It still reports a `sightCenter` and
`applyFit` derives the aimed pose from it exactly as for a holo, so the eye
reference is not duplicated; only the geometry in front of it is the weapon's own.

The kit screen (`src/ui/LoadoutScreen.ts`) owns its DOM under `#hud` and is a
`loadout` game state — a lid over `menu` or `deploy` that remembers which
(`loadoutFrom`). It is reachable from the **main menu and the deploy screen** (a
button, `L`, or gamepad X) and deliberately not from the pause menu: a round you are
already standing in is not somewhere you change what you are carrying. Nothing
enforces that with a flag; the states that offer the button are the ones that read
`loadoutPressed`. Every pick applies immediately through `Game.applyLoadout` and
persists to `localStorage` like the difficulty tier, so confirm just closes.

- **The stat bars are derived from the table**, each weapon's figure against the
  best any weapon has, so a third weapon re-scales the chart instead of dating it.
  Accuracy is the aimed spread *inverted* — a bar that grew with the number would rank
  the SMG as the accurate one.
- **The buttons that OPEN the screen fire on `pointerdown`, not click**, the same
  edge every button that *leaves* a screen uses. It was once load-bearing — the
  menu's confirm was "a mouse button went down anywhere", read from the button mask
  on the next tick, which happens before a `click` (mouse *up*) ever fires, so a
  click that asked for the loadout also deployed the player out from under it. The
  pointer is no longer in that confirm, so this is now consistency rather than a
  fix. Buttons *inside* the screen can use `click` safely.

On the keyboard, d-pad and left stick the screen splits the axes: up/down chooses
the slot, left/right steps through it (the menu behind keeps left/right for
difficulty). Enter, pad **A**, pad **B** and `L`/pad Y all close it — every pick is
already applied, so there is nothing for a confirm and a cancel to disagree about.

### Grenades

Everyone carries two and there is no resupply, so the pouch is refilled by death
and nothing else (`Player.fullReset`, `Bot.spawn`). Two a life makes each throw a
decision rather than a second trigger.

**This is the only thing in the game that is not hitscan**, and everything about
`src/systems/GrenadeSystem.ts` follows from that:

- **ONE ray per grenade per frame**, cast along the step and a radius past it so a
  fast grenade cannot tunnel between frames, filtered on `metadata.solid === true`.
  Affordable only because there are at most a handful in the air. A reported normal
  facing *away* from the grenade is flipped before the bounce: a collider's back face
  is what a grenade thrown from inside a doorway finds, and bouncing off one drives
  it straight through the wall it just hit.
- **A slow grenade on a flat surface is parked outright** (`resting`). A body that
  micro-bounces never settles, and one that never settles never stops paying for its
  collision ray.
- **`TerrainField` is a backstop under the colliders, not the floor test.** The
  terrain blocks are `solid` and the ray normally finds them; the clamp catches a
  grenade that slipped past a seam so it does not fall out of the world with a live
  fuse. It uses `heightAt`, so it can sit a fraction under the *drawn* surface — fine
  for a backstop, not for anything that has to line up.
- **The blast resolves against the THROWER's target list**, fetched at detonation
  rather than at the throw — a grenade is in the air for seconds and the roster it
  goes off among is not the one it left the hand among. Friendly fire is excluded by
  construction, exactly as in `CombatSystem.fire`, so a grenade cannot hurt its own
  side including the thrower; the alternative is bots routinely killing their squad.
- **Damage needs line of sight from the blast centre** — one ray per victim already
  inside the radius. Measured: 130 at the epicentre, flat inside 2.6 m, falling
  linearly to 0 at 8.5 m, blocked outright by a wall.
- **The pool REFUSES rather than stealing a live slot**, and both callers spend
  their grenade only after it has accepted — hence `Player`'s split of
  `canThrowGrenade` from `spendGrenade`, and `Bot` decrementing after
  `ctx.throwGrenade` returns true. A count debited for a throw that never arrived is
  the most confusing thing this could hand a player.

**The blast is a fireball, embers and DUST, and the dust outlives the rest.**
`BlastDust` is a few dozen soft quads expanding, slowing and fading over
`dust.life`, not emissive, `BLENDMODE_STANDARD`, tinted from the map's `mistColor`
toward its key light. **This is the one place a GPU particle system may be spawned
per event** — the rule against it (muzzle smoke, brass) is about per-shot effects at
eighty shots a second; there are seconds between detonations. Four of these six are
Babylon's rather than the game's:

- **It is a POOL of GPU systems, one per concurrent cloud.** In
  emit-rate-controlled mode a `GPUParticleSystem` re-emits into a ring of
  `max(emitRate * maxLifeTime, this frame's emission)` slots from a circular write
  pointer. `emitRate` is zero here — that is what makes it a burst — so the ring is
  exactly one `manualEmitCount`, and a second blast inside the first cloud's life
  would overwrite its slots and pop a standing cloud off the screen. `Atmosphere`
  documents the other side of this invariant.
- **A stopped system refuses manual emissions too** (the update shader gates its
  emit branch on `stopFactor != 0`), so `stop()` is not a way to hold a burst system
  idle. Each is started once and left started; with `emitRate` zero an idle one emits
  nothing and costs nothing.
- **`updateSpeed` is `1/60`**, which is what makes the numbers mean what they say:
  the GPU clock advances by `updateSpeed * scene.getAnimationRatio()` and that ratio
  is `dt * 60`, so a lifetime is seconds and an emit power is m/s. (`Atmosphere`'s
  0.012 is deliberately not that.)
- **The fade cannot be curved.** `addColorGradient` on a GPU system in Babylon
  9.19.1 throws on the next render and takes the whole scene's rendering down with it
  — a black frame, not a fallback. Size and velocity gradients are fine. So alpha runs
  linearly from `color1`/`color2` to `colorDead`, and `dust.opacity` is set for how
  the cloud reads at half life rather than at birth.
- **The cloud is lifted off the detonation** (`dust.lift`). A puff is a billboard
  metres across, so one centred where the grenade went off has its lower half under
  the cobbles and reads as a smear painted on the street. Only the cloud moves —
  damage, light and embers still resolve at the blast.
- **Its colour is the map's, through `installMap`** (`grenades.setEnvironment`) —
  the same place `grenades.reset()` clears the standing clouds and the grenades. A
  fuse that outlived its map would go off over terrain that no longer exists.

**The player's throw is a GESTURE with a release inside it**, which is what stops
it reading as a second trigger. It was once an event — the button spent a grenade,
the body appeared on the camera axis that frame, the weapon dipped on a bell curve
— and all three are what a muzzle does, so players read it as the rifle firing the
grenade. It is now a timeline (`CONFIG.viewmodel.throw`) owned as a clock by
`Player`, counting up from the button:

- The **off hand comes into frame holding the frag** — the throwing arm is
  `ViewModel`'s, one rig shared by every weapon, parented to the camera (the weapon
  is tipping out of the way at the time) and disabled whenever no throw is in flight.
  Seeing what is about to be thrown is the whole job of the wind-up.
- The **support hand goes with it** — it is the same hand, so leaving it on the
  handguard puts two left arms on screen; hiding it is what motivates the weapon's
  give, held for as long as the hand is away rather than arcing back like an impulse.
- **The grenade leaves the HAND**, at `throw.windup`, from
  `ViewModel.throwHandWorld()`. `grenade.handAhead` survives only as a floor on that
  point (a throw with a wall at your shoulder must not spawn inside it);
  `handSide`/`handUp` are gone, because a point measured off the eye is exactly what
  read as a muzzle.
- `Player.beginThrow` books the ARM (the cooldown) and `spendGrenade` books the
  grenade at the release, so a pool refusal costs a cooldown and never a count.
  `throwReleaseDue` is the single consumed edge saying the hand got there, and is
  false if the player died mid-wind-up.
- The eye's follow-through goes through `CameraSystem.land` — the same spring as a
  landing and a blast concussion. One integrator, three callers.

Two things about the arm are learned rather than authored, recorded on
`viewmodel.throw` and `THROW_ELBOW`: **the elbow must leave the frame at every
pose** (a forearm's flat cut end in open screen is a floating log, not an arm), and
**the hand cannot be posed where a real one would be** — at 0.35 m the fist and frag
fill a quarter of the screen.

**The player throws where they are looking; a bot says where it wants the grenade
to land** — `throwAlong` / `throwAt`, ballistics behind both. `throwAt` is the low
arc of the standard solve and returns false when the throw cannot be made at
`throwSpeed`, which is what an AI needs to hear. Two consequences:

- **`throwSpeed` is bounded from below by the bots, not the player.** Flat range is
  `v^2 / g`, so 24 against a gravity of 18 reaches 32 m and `grenade.bot.maxRange`
  (30) has to fit inside that or every AI throw is refused. Measured: 8/12/20/28 m
  solve, 34 m refuses.
- **A solved throw lands slightly long**, because the fuse outlives the flight and
  the grenade rolls; `friction` is tuned against that rather than against the bounce.
  Measured flat: 0.7–1.8 m past the aim point across the whole 11–30 m band, well
  inside the bots' own scatter (at the 0.5 it started on, 4–6 m).

**The range band IS the bots' self-preservation.** A bot has no idea how far its own
blast reaches — no self-damage to teach it, no rig pose that could sell taking cover
from its own frag — so it is never allowed to throw at anything nearer than
`minRange`. Skill scales the *chance*, not the accuracy: an ace throwing wildly is
indistinguishable from a rookie, while an ace throwing more often is a squad that
starts using grenades once it has been held up.

Three things elsewhere are part of this: **the blast light is deliberately outside
`spendMuzzleLightBudget`** (transients always win a slot, and there are seconds
between blasts); **the camera's concussion reuses `CameraSystem.land()`**, since a
shake of its own would be a second integrator writing the same offset; and **a
blast kills through `Game.registerBotKill`**, the one place a bot's death reaches
the scoreboard, tickets and killfeed from all three causes (the hitmarker and rumble
stay with the weapon, being about the shot that landed rather than the body).

### The interface is four screens and the chrome

`src/ui/` holds one class per thing on screen, and `HUD` is not where a new one
goes: `OverlayScreen` owns the three full-screen cards, `DeployScreen` the deploy
map, `LoadoutScreen` the kit, `SettingsScreen` the toggles, `Minimap` the corner
map, and `HUD` **only** the gameplay chrome.

Each screen builds its own root element and appends it to `#hud`, which is why
construction order in `Game`'s constructor matters exactly once: `HUD` writes
`#hud.innerHTML` and would wipe anything already appended, so it is built first.
Stacking is not DOM order — `#overlay` (10) and `#loadout` (11) carry z-indices,
because a pause can be taken with the deploy map on screen.

**The three cards are one class because they are one element** — they share the
shell, the title block, the controls table and the Deploy button. The bar for a
screen of its own is *state*: the deploy map has a selection and a canvas, the kit
screen has two slots and a turntable; a card that is markup plus a button has not
earned one.

**A class on `#hud` belongs to whoever raises it.** `OverlayScreen` sets
`.overlaid`, `LoadoutScreen` sets `.kitting`, `HUD` sets `.paused`, `.editing` and
`.dying`. That is why a pause is two calls from `Game` rather than one: the card
goes up and the crosshair comes down, and they are not the same decision —
`.overlaid` would take the tickets and vitals with it, which under a pause are
still true.

**One stylesheet per module that writes markup, imported by that module**
(`HUD.ts`→`hud.css` … `editor/EditorPanel.ts`→`editor/panel.css`); `main.ts`
imports `base.css` first. Vite bundles them into one hashed stylesheet the built
`index.html` links from its head. All of it was once ~2,050 lines inline in
`index.html`, which cost three things worth not paying again: no compile-time link
between markup and the rules styling it, so a renamed class was a silent visual
break; the editor's ~170 lines shipped in every production build; and a CSS-only
change moved no content-hashed filename. Three rules keep it that way:

- **`base.css` is for what two or more screens share** — the reset, the canvas, the
  `#hud` root, `.frame`, `.brackets`, `.hidden`, the `--ov-scale` short-viewport
  block, `@keyframes pulse`, and the kit button. A rule only one screen uses belongs
  in that screen's sheet however tempting the shared file is.
- **A screen's state rules go with whoever sets the class**, not whoever owns the
  element: `#hud.paused #deploy { opacity: 0.18 }` is in `hud.css` because
  `HUD.setPaused` puts `.paused` on, even though `#deploy` is the deploy screen's.
- **`index.html` gets no interface CSS, ever.** The one inline rule is a black
  `html, body` background: a production build links the stylesheet render-blocking
  from the head, but the dev server injects it from JS, leaving one frame of default
  white — on a night game that reads as a camera flash.

### Getting into a round

Three screens stand between the title and the world, each driven by a pointer *and*
by a pad, with no path that needs the other.

**Every screen here is a LIST: move the cursor, A picks, B backs out.** That
replaced a screen per verb — left/right for difficulty, `L`/Y for the kit, `O` for
settings — which is a keyboard's idea of a menu: every action needs its own button,
and an action nobody found a button for is one a pad cannot reach (the settings
screen was exactly that). The dedicated keys survive as accelerators; none is the
only way in.

- **The cursor is `OverlayScreen`'s, and it is a class on rows that already
  exist.** `MENU_ITEMS` is the list, `activateMenu` is what A fires, and the mark is
  a caret on the label plus a ring on the control — never a fill, since the tier
  buttons and Deploy button are *already* filled hot to say what is chosen. **The
  ring has to be INSET on anything chamfered**: every button here is cut by a
  `clip-path`, which clips its own element's outline and box-shadow along with the
  corner, so an offset outline draws on the tier group (a plain div) and silently on
  nothing else.
- **A / Enter fire the cursor's row and BREAK; Start still starts the round from
  anywhere.** Both flags come up on the same frame for A, so the order is the whole
  mechanism — without the break, A on the settings row opens the screen and then
  deploys the player out from under it.
- **THE POINTER DEPLOYS ONLY THROUGH THE DEPLOY BUTTON**, on this card and the
  round-over one. `confirmPressed` was "a button went down anywhere", mouse and
  finger alike, which is fine on a card that is only a title and wrong the moment
  the menu grew controls: the map and difficulty rows fire on the click's mouse-UP
  while the confirm reads the mouse-DOWN a tick earlier, so **choosing a map or a
  difficulty started the round on the same press**. Neither flag carries a pointer
  now; the button carries the mouse and the tap by itself. Restoring a
  click-anywhere confirm to a screen that has controls on it restores that bug.
- **The cursor survives a redraw and resets when the card is RAISED**
  (`OverlayScreen.card`). `showMenu` is called again on every difficulty change and on
  the way back from the kit and settings screens; a cursor that jumped home each time
  would make the row you just left the one place you cannot stay.

**The LEFT STICK drives all of it, and holding a direction repeats.** It is the
left stick alone (the right one turns the kit turntable), read raw against
`input.menuStickThreshold` rather than through the movement deadzone, because a menu
step is discrete and a stick resting a third of the way over must not scroll a list.
`InputManager` folds keys, d-pad and stick into two DIRECTIONS rather than four
buttons, so opposing presses cancel and a diagonal resolves into one step per axis;
`stepNav` turns a held direction into the edge-and-repeat the menus read. The repeat
is what makes a stick usable (it has no detent to tap) and deliberately does not
extend to confirm or back.

**Each screen has ONE content width and everything hangs off it.** `#overlay`
declares `--col` (settings grid, Deploy button, controls table, pause list, result
bar) and `#deploy` declares `--map` (status line, hint row, button row, so they meet
the map's edges). The two big titles are the deliberate exception.

- **The menu's two settings rows are one grid, not two rows.** Centred
  independently they put labels, controls and hints at three different x each.
  `.ov-settings` owns the three columns and each row is `display: contents`. The
  control column is `1fr`, so the four difficulty tiers and the kit button span the
  same width — which sets the tiers' padding, since at 18px their min-content
  overflowed `--col` at every viewport size.
- **Only the controls opt into pointer events, never the rows.** `#hud` is
  `pointer-events: none` and the menu's confirm is a mouse-down anywhere, so a row
  that claimed events would turn its labels, hints and the grid's gaps into dead zones
  where a click does nothing instead of starting the round.
- **`#deploy-actions` wraps.** The map is height-led, so on a 768-tall laptop it is
  430 px across and the longest kit ("Marksman rifle · Scope") does not fit beside a
  Deploy button. Both buttons grow, so a broken row gives two full-width buttons
  stacked rather than one hanging over the map's edge. That width is also why every
  input hint lives in the one hint row.

**The menu and round-over card carry a `Deploy` button**
(`OverlayScreen.bindStart` → `Game.onStart`), and it is the **only** thing on either
card a pointer can deploy with. It began as a redundant target beside a
click-anywhere confirm, which is why it exists at all: an instruction in prose is not
a target, and "click, press Enter, or press Start" made a pad player work out which
was theirs. It now carries the mouse and the finger by itself. It is also where the
menu's cursor starts, keeping Enter and A meaning "start the round" the moment the
title appears.

**That button is why the deploy screen's confirm is `menuConfirmPressed`.** It
changes state on the down edge, which puts the `deploy` branch in front of the very
click that asked for it — and the first deploy of a round has `respawnT` at 0, so a
confirm counting the mouse fired immediately and dropped the player in at whichever
spawn the list started on, skipping the screen. Enter and pad A only; the map takes
its own clicks and the two buttons take their own.

**The spawn is steppable** (`DeployScreen.moveSelection`, wired to the menu
directions in `Game`'s `deploy` branch, so the stick steps it too). Both axes step
the same list: the spawns are points scattered over a map rather than a row or
column, so no direction *means* anything, and a direction that does nothing reads as
a screen ignoring the pad. The selection is stepped *before* `update()` redraws, so
the marker and the status line — which names the selection, because a highlight
300 px away is not a label — move on the frame the key was pressed.

**`#deploy-go` is the pointer's way off that screen**, since the confirm no longer
takes a click. Pointerdown, like the map's markers: the same event goes on to take
the pointer lock, which it can only do once `spawnPlayer` has moved the state to
`playing`. It greys itself (`.waiting`) while `confirm()` is still a no-op.

**The right half of the kit screen is a turntable carrying the real viewmodel.** It
is not a second model, not a render target and not a second camera: `ViewModel`
simply has a pose that is not the carried one (`beginInspect` / `spinInspect` /
`updateInspect` / `endInspect`), and the weapon is already parented to the camera
and drawn in `VIEWMODEL_GROUP`.

- **The stage is a hole in the screen's scrim.** Everything the kit screen draws is
  DOM and DOM is above the canvas, so a backdrop over the stage would dim the weapon
  along with the world. `#loadout`'s scrim stops at the panel column and the stage
  gets a vignette instead; `show()` marks `#hud` so the CSS can hide the menu, the
  deploy map and every gauge while the kit is up.
- **The stage's geometry is shared with `CONFIG.viewmodel.inspect`.** The pose is
  placed by back-projecting a SCREEN anchor, and the anchor works out to exactly the
  CSS `--panel` fraction (the stage's centre is `(1+p)/2` across, which in NDC is
  `p`). Both are fractions of the viewport, so a resize moves them together; the
  distance additionally gives way on a viewport narrower than `aspectReference`,
  because apparent size follows the vertical FOV while the room to fit in is a share
  of the width.
- **The turntable rotation is a quaternion, and the only thing allowed to write
  one.** The carried pose is Euler, composed in the weapon's own frame, so at a
  side-on yaw the pitch a drag asks for arrives as a roll. `endInspect` dropping the
  quaternion is what lets the Euler pose come back at all — while one is set Babylon
  ignores `rotation` entirely.
- **It rotates about a derived pivot, not the node's origin** (which on a rifle is
  the receiver — a turntable about that would swing the weapon around the screen).
  `applyFit` measures the pivot from the weapon's own muzzle landmark.
- **The hands let go.** A forearm cut off at the elbow reads fine on a carried
  weapon and as a severed arm on a bench, so `ViewModel` hides the arm meshes for the
  duration — one place writes mesh visibility.

`Game.updateKitStage` drives it, because `loadout` is the one lid state showing live
3D and owes by hand the per-frame pushes only `updateGameplay` makes. The camera
position is the load-bearing one — the cel shader fogs against `camPos`, which
outside a round is whatever the last gameplay frame left and `Vector3.Zero()` before
the first, so a kit opened off the main menu would fog the weapon to a grey
silhouette. It also puts up the two bench lamps (`CONFIG.lighting.kitLamps`),
through `LightingSystem` like every other light because a carried light always wins
a slot; they are far brighter than the shoulder lamp on purpose, since moonlight
alone on a night game's albedo is a black silhouette. `stowKit` is the single
teardown — screen, pose and lamps — and all four exits go through it, because a
carried light nobody removes survives `lighting.clear()` and follows the player into
the round.

### The scene has (almost) no Babylon lights

Cel materials carry their own `lightDir`/`lightColor`/`ambientColor`/
`skyLightColor` and a packed array of up to `MAX_POINT_LIGHTS` (16) point lights as
uniforms; `LightingSystem` is the sole owner of dynamic light and uploads the
winning slots via `CelMaterialFactory.setPointLights()` once per frame. Adding a
`PointLight`/`HemisphericLight` to the scene will not affect any cel-shaded mesh.
Effect meshes (tracers, sparks, neon, reticles) use unlit emissive
`StandardMaterial`s from `mats.getEmissive()` and are unaffected by lighting.

**Nothing drawn outside the cel shader gets fog for free, and everything that
draws outside it owes the same fade.** The fog is a uniform on the cel materials
and a per-pixel `mix` in their fragment shader; **three** passes never run it.
Babylon's outline renderer writes `outlineColor` flat (its whole fragment shader
is `gl_FragColor = color`), the `GlowLayer` builds its bloom from a material's
emissive colour, which says nothing about where the mesh stands, and
`getEmissive()`'s unlit `StandardMaterial` — every lit window, flame, ember,
tracer, spark and team-colour bar — draws a flat colour with lighting disabled.
All three take their fog from the one published by
`CelMaterialFactory.setEnvironment`, so nothing can describe different weather
from the wall it hangs in front of — but they take it at **different
granularities, and the difference is forced**:

- **The outline fades per PIXEL**, baked into its shader by `src/shaders/OutlineFog.ts`.
  It has to. `BlockMerge` gives one mesh per 48 m block, so a per-mesh ink fade
  leaves the far half of a block in clear ink over a wall that has already gone
  to fog — measured on Greyfen, **50 of 687 outlined meshes span the entire fog
  band** (fog 0.0 at the near edge, 1.0 at the far), and those 50 are the
  village. Thinning is not a substitute: `outlines.minScale` still leaves a line,
  and a line of un-fogged ink is as visible thin as thick.
- **The bloom fades per MESH**, through `fogAmountAt` in
  `glow.customEmissiveColorSelector`. The glow map is generated from a material's
  emissive colour with no per-pixel hook at all, and it is affordable here where
  it was not for the ink: a bloom is a soft blob with no edge to misplace, and
  only 4 of 290 emissive meshes span more than half the fog band.
- **The emissive material fades per PIXEL**, through a `MaterialPluginBase` in
  `src/shaders/EmissiveFog.ts` that injects the same curve at
  `CUSTOM_FRAGMENT_MAIN_END`. A plugin *can* declare real uniforms, so unlike the
  ink this one is a buffer write rather than a re-bake — `setEmissiveFog` needs no
  cache invalidation at all. Distance is `vPositionW` against `vEyePosition`, both
  unconditional in `default.fragment`.

That this was invisible for a whole map is the point: on Hollowmere unfogged ink
is near-black against near-black fog and an unfogged glow reads as a lamp doing
its job. **A bright fog is what makes an un-attenuated pass obvious**, and
Greyfen showed all three — a stand of dead trees whose trunks fogged to pale grey
while every branch stayed a black scratch (a branch is 0.04 m of geometry inside
a 0.05 m ink shell, so it is almost entirely outline), six chapel windows that
were three saturated cyan bars on a wall faded almost to white, and a cottage
window measured at 77.6 m — inside a `fogEnd` of 78 — coming back rgb(249,177,92)
against its own `#ffb257` over a fog of rgb(194,204,212). **Fading the bloom is
not fading the thing**: the selector dimmed the halo around that bar and left the
bar. With the plugin the same pixel reads rgb(196,204,210).

**The three obvious cheaper fixes for the emissive pass are all wrong, and the
first one is the trap.** `scene.fogMode` would have been one line —
`StandardMaterial` has fog built in — but Babylon's is linear/exp over VIEW-SPACE
z where the cel shader's is `t*t` over the RADIAL distance, so a window over-fogs
against its own wall through the whole middle of the band and disagrees by up to
1.4x at the corners; it is also scene-wide, so the sky dome would need opting out
by hand. A `ShaderMaterial` of our own loses `material.emissiveColor`, which is
what the GlowLayer's selector reads — every lantern, tracer, visor and reticle in
the game stops glowing. And baking literals the way `OutlineFog` must is pure
cost here, where uniforms are available.

**`OutlineFog` is the only place this tree touches Babylon's compiled-effect
cache, and its header is the argument for why.** `OutlineRenderer` hardcodes its
`uniformsNames`, so the fade cannot be given a uniform at all: the distance is
recovered from `viewProjection` in the vertex shader (rows 0/1/3 are `P00*right`,
`P11*up` and `forward`, and the eye is the point whose clip x, y and w all
vanish — verified exact to 1e-6, and it must be that radial distance rather than
the free `gl_Position.w`, which disagrees by up to 1.4x at the corners), and the
fog colour and range are baked in as literals. Re-baking therefore has to make
Babylon forget the compiled programs, since it rebuilds a submesh's effect only
when its *defines* change, which a re-bake does not.

Three rules about that invalidation, all learned the hard way:

- **Clear the draw wrappers FIRST and IMMEDIATELY, then forget the cache entry.**
  `mesh.resetDrawCache()` defaults to `immediate = false`, which does not merely
  drop each wrapper — it queues that wrapper's `Effect.dispose()` on the engine's
  `endFrame`, and a dispose is a REF RELEASE: Babylon ref-counts an effect by how
  many wrappers asked `createEffect` for it, and the release that reaches zero
  deletes the GL program and drops the cache entry itself. Deleting the entry by
  hand *first* desynchronises that count. The bake runs inside `startRound`, so
  the order was: forget the entry, clear ~500 wrappers with their releases still
  pending, build and render the new map (which compiles a fresh effect, the entry
  being gone, and hands it to every wrapper the frame rebuilds), and only then, at
  `endFrame`, do the queued releases land and take a LIVE generation to zero — its
  program deleted under the wrappers still pointing at it. **The map is rebuilt
  after the bake, so its meshes are innocent and the damage lands only on what
  SURVIVES a map change: the pooled bot rigs and the viewmodel.** Their outline
  shells then draw from a deleted program as garbage that swallows the body it
  belongs to — on Greyfen's pale fog a squad reads as flat yellow cut-outs of
  itself, measured at 534 of 642 outline wrappers holding a freed effect one
  switch in and compounding with every further switch, while on Hollowmere the
  same garbage is near-black against near-black and invisible. Resetting
  immediately puts the releases back inside the bake, where the last one frees the
  effect with nothing holding it; the delete that follows is a backstop that can
  now strand nobody. `_releaseEffect` is still not the way to do it — it deletes
  the program on the spot, wrappers or no wrappers.
- **Scope that reset to the outline PASSES, not the whole mesh.** An unscoped
  `resetDrawCache` disposes every material's wrapper too, and disposing is a
  release: with nothing else holding them the cel materials, the sky and the
  post-process chain lose their programs and recompile. Measured on a map change:
  15 recompiles unscoped against the 1 the outline itself owes.
  `OutlineRenderer` keeps its four render-pass ids in `_passIdForDrawWrapper`.
- **Reset the draw cache of EVERY mesh in the scene, and never filter that walk.**
  The reset is the whole mechanism, not a belt-and-braces beside the cache delete:
  `OutlineRenderer.isReady` asks the engine for an effect only when its *defines*
  string changes, and the outline pass's defines never change, so a draw wrapper
  that already holds an effect never consults the cache again however many entries
  are forgotten. Two narrower sets have both been tried and both were wrong. The
  outline REGISTRY misses `ViewModel`'s ~40 meshes, which set `renderOutline` by
  hand and never call `addOutline`. `scene.meshes` filtered on `renderOutline`
  looks exactly right and is the same mistake one layer along: the flag is a
  runtime toggle — `Bot.setOutlines` clears it past `lodOutlineDistance` (20 m),
  so most bot rigs have it off at any instant — and rigs are POOLED, alive across
  every map change, so one LOD'd out during a re-bake keeps last map's fog for the
  rest of the session. Greyfen → Hollowmere left 148 wrappers mixing ink to
  `#c2ccd4`, which at the fog wall IS the ink: each rig's nine merged meshes read
  as white slivers scattered over the village, and it survived a whole session
  because a fresh boot has only one bake and nothing stale to keep. Unfiltered
  costs 4.9 ms for 1,910 meshes across the four passes, once per fog change,
  beside a ~570 ms map build.
  `setOutlineFog` owns its own invalidation for exactly this reason — the first
  cut split it across the caller and got that list wrong.

**Four light terms, not three.** Beside the key light, the flat ambient and the
point lights there is a *hemispheric* term, `skyLightColor`, applied by `n.y` and
never gated by the shadow map: full strength on up-facing surfaces, nothing
underneath. It is what makes streets, roofs and open ground read as moonlit while
walls and undersides stay black — flat ambient alone lifts every face equally, which
reads as a grey wash. Because it is ungated, a roof in the moon's shadow still
catches it. It lifts *albedo*, so a bright material (the cobble street) gains far
more from it than a dark one.

**Two more terms are per-material opt-ins, and they are three cache variants rather
than a matrix.** `getGlossy` adds the toon specular (`specColor`/`specShininess`)
and `getTranslucent` the translucency band (`transColor`) — the key light coming
*through* a thin surface, for stall awnings and pine crowns. Both default to a
**black colour**, which is what makes them free on materials that skip them: every
cel material carries both uniforms and zero multiplies the term out. A material is
matte, glossy *or* translucent — never two — because the cache is per colour and an
axis that multiplies is an axis that costs. A fourth variant means a spec type, an
`apply*`, a `get*` under its own key, one entry in `UNIFORMS`, **and** teaching
`outlineInkFor`'s regex the new `cel-<variant>-#rrggbb` name, or the ink falls back
to the palette-neutral colour. The translucency term is directional both ways — it
needs the eye looking into the key light *and* the facet turned away from it — so it
can only be judged from under the thing, moonward.

The one exception is `ShadowSystem`'s `DirectionalLight`, which no material reads:
it exists only to define the shadow camera for its `ShadowGenerator`. The cel
fragment shader samples that depth map as a hard two-level term gating the key
light. The shadow window follows the player (texel-snapped, re-rendered only when
the snapped focus moves), casters are the map's merged static meshes re-registered
every round via `shadows.setCasters(map.visuals)` (skipping anything flat with
`metadata.noShadowCaster`), and characters get blob-shadow discs instead of casting.

**The depth pass draws only the casters standing in the window, and has to do that
culling itself.** Babylon culls nothing off an explicit `renderList`:
`ObjectRenderer._prepareRenderingManager` dispatches every enabled, visible mesh in
it, so the pass was submitting the whole village on every re-render — 314 casters and
79k triangles against the ~150 that can reach a 110 m window.
`ShadowSystem.cullToWindow`, hung off the shadow map's `getCustomRenderList`, is the
fix, and it is **lossless rather than a quality trade**: the light is orthographic,
so a caster's shadow lands at its own position in the light's plane and a box test
there cannot drop anything that could have darkened a texel.

**The blob shadows do not probe for the player's ground; they are handed
`Player.floorY`.** `Player.probeGround` is a whole-scene ray pick (1,775 meshes
walked, 758 solid colliders tested, ~2.5 ms) and `ShadowSystem` used to cast the
identical ray for the identical body on the same frame. Anything else wanting the
floor under the player reads that field rather than probing again.

Lights come in three flavors: static fixtures (`lighting.add()`, registered by
`MapBuilder` from a builder's `LocalLight` list or a scatter prop's entry in
`SCATTER_LIGHTS`), transient pulses (`lighting.pulse()` — muzzle flash), and carried
lights (`setCarried()`/`removeCarried()`). Transient and carried lights always get a
slot; static fixtures compete nearest-first. **That is why bot muzzle flashes are
budgeted**: 16 bots firing would take all 16 slots with transients and black out the
village's lanterns, so `BattleSystem` only records flash positions and
`Game.spendMuzzleLightBudget` spends `CONFIG.lighting.muzzleBudgetPerFrame` on the
nearest few. Any new per-bot transient light needs the same treatment. Fixture
lights are hand-placed and must stay **spatially spread** — clustering lanterns
wastes slots and flattens the darkness.

### The map is data, not code

`src/world/hollowmere/layout.ts` is the entire level: placements (`{ kind, x, z,
rotY, params }`), scatter regions, control points, spawns, and the
water/grass/terrain rects. `BuildingKit` supplies the parametric pieces and
`MapBuilder` consumes the layout; neither special-cases Hollowmere, so **a second
map is one new layout file plus an `EnvironmentSpec`**. The vocabulary those files
are written in (`Placement`, `ScatterSpec`, `TerrainRect`, `MapLayout`) lives in
`src/world/layout.ts`, not beside Hollowmere's data — a new map must not import its
types from its predecessor, and `MapBuilder.build(layout, env)` takes both as
arguments for the same reason.

**The two halves are paired in `src/world/maps.ts`, and it plus
`vite.config.ts`'s `WRITABLE` table are the only existing files a new map
touches.** A `MapDef` is `{ id, name, layout, environment }`; `MAPS` is the registry
and `DEFAULT_MAP` is the fallback. `Game` holds one `mapDef` field (`Game.mapDef`) and
reads both halves off it. Nothing outside `maps.ts` may import a map's own modules.
The shipped maps are **Hollowmere** (night) and **Greyfen** (overcast dawn). The
second was forked from the first's layout, cleared back to a blank valley, and is
now being rebuilt as a jungle one: what stands is the **manor** on flag C and
nothing else, so it is the map being built rather than a second finished one. The
two share no module in either direction.

Three rules:

- A `MapDef` must be a **module constant**, never rebuilt per round, and anything
  resolving one — `readMap()` from `localStorage`, say — must return an entry **out
  of `MAPS`** rather than a copy. `applySky` skips repainting eight megapixels of
  dome by comparing the environment by *identity*, so a spread-together `MapDef`
  fails that test open and repaints the sky, two fBm cloud masks included, on every
  round start. Nothing throws; it is a hitch with nothing in the profile to blame.
- **`Game.mapDef` may only be written from the `menu` state** (`Game.setMap`
  enforces it). `startRound` reads it to apply the environment, paint the sky and
  build the map, then hands the result to battle, conquest, the flag markers and the
  minimap — a write at any other time leaves all four pointing into a `GameMap` that
  `installMap` has already disposed.
- A map's display name and its **flag count** are **passed to the UI, never written
  there** — through `setScoreboard`'s `map` field, `showRoundOver`, and
  `MenuState.flagCount`. The `<h1>HOLLOWMERE</h1>` on the title screen is the
  deliberate exception: that one is the game's name, which happens also to be the
  first map's. The tagline beside it is *not* — it states the flag count, and that
  is the chosen map's.

**Five globals are per-map overrides on `EnvironmentSpec`, each defaulting to its
`CONFIG` value** — so a map that says nothing gets exactly the shipped look. They
exist because each turned out to be a statement about Hollowmere rather than about
the game: `sky.discRadius` (0 draws no disc **and** switches the god rays off, via
the zero-`moonDir` contract `Sky.clear` already documents), `sky.haloStrength`,
`grade` (the map scales the horror grade; the PLAYER still decides whether it runs
at all), `groundSpec` (the wet cobble sheen, which `config.ts` warns is tuned to the
key light's elevation), and `lighting.lampIntensity` (0 removes the player's
shoulder lamp, which otherwise spends one of the sixteen light slots).

**`groundSpec` is re-applied over the material cache, not folded into the cache
key**, and that is the whole reason it works. `getGlossy` keys on `\0gloss-<hex>`
and `getGroundTextured` on `\0ground-<key>-spec-bump`; neither includes the spec's
*values*, and `CelMaterialFactory` outlives a map — so the second map to ask for the
same colour silently gets the first map's material, uniforms and all. `setGroundSpec`
walks the cache the way `setEnvironment` already does. `getGroundTextured` also takes
the stored override rather than its caller's values, because materials are built
during `installMap`, which runs *after* `applyEnvironment`: a fresh material would
otherwise be born with the shipped night sheen and never revisited.

**What the floor is MADE of is a second per-map choice, and it owns no colour.**
`EnvironmentSpec.floorSurface` names a pattern out of `src/world/floorSurfaces.ts`
— `flat` (the default, and the plain cel colour the floor has always been), `dirt`,
`gravel`, `sand` or `turf` — and every tone that pattern paints is *derived* from
`floorColor` by `shadeOf`. That is the rule holding the two apart: `floorColor` is
already what the untextured floor is, what `ridgeScreeColor` is asked to melt into
and what a grass field's roots are matched against, so a surface carrying a palette
of its own would be a second answer to one question and the two would drift the
first time a map was re-tinted. Switching a map's surface changes the grain of its
ground, never the colour of it. Three consequences:

- **The albedo cache key carries the colour and the bump's does not.** Grain
  layouts are seeded per surface and read no colour, so one height map serves every
  tint of `dirt` — while two maps on `dirt` in different soils must be two albedo
  textures rather than whichever asked first, the same trap `setGroundSpec` exists
  to close.
- **The floor material is deliberately MATTE and must stay that way.**
  `getGroundTextured` only registers a material for `setGroundSpec` to re-apply to
  when the caller asked for a spec at all, and that sheen is the wet *cobble* one —
  a road's weather. Asking for a spec here would put a wet-stone glint on soil on
  every map that states a `groundSpec`.
- **It is a MATERIAL, so it is the one thing on an `EnvironmentSpec` that
  `applyEnvironment` cannot push.** It is baked by `MapBuilder.buildValley`, which
  is why the editor treats a floor edit as a full rebuild and why `workLight.ts`
  refuses to touch `floorColor` alongside the two rim colours.

**The floor is a height field, not a flat plane.** A `Heightfield` in the layout
feeds a `TerrainField` (`src/world/TerrainField.ts`), the one place the ground's
height is decided. It used to be the literal `0`, asserted independently in
`MapBuilder.buildValley`, `NavGrid.rasterize`, `Player.probeGround`,
`ShadowSystem.groundYUnder` and `GrassSystem` — five hardcodings of the same
constant, which is why the floor could not be anything but level. The grid is 80x80
cells of 3 m, sampled bilinearly, authored with the editor's terrain mode.

**The heights live in their own generated file** (`hollowmere/heights.ts`), imported
by the layout. `layout.ts` is authored — an ASCII village map, district commentary,
`BANK_H`/`TERRACE_H` in place of bare numbers — and the editor patches it one line at
a time to preserve all of that; several thousand bare numbers would drown it.
`heights.ts` is the opposite: pure generated data, rewritten wholesale, one grid row
per line so a diff shows which strips of the map moved.

- **`Placement.y`, `ScatterSpec.y` and `GrassRect.y` are offsets above the local
  floor**, not absolute heights, so dressing rides the ground when it moves. Control
  points and spawns stay absolute — the editor snaps their height to the nav surface.
  A `WaterRect` with no `y` floats `CONFIG.water.surfaceY` above **its own bed**,
  which makes a pool read as recessed: Hollowmere's bog bed is at -0.6 and its surface
  lands at -0.28, below the bank around it.
- **`NavGrid.link` is the slope limit.** It links neighbouring surfaces only within
  `stepHeight`, so at `cellSize` 1.5 a bank is walkable up to a gradient of 0.4
  (~22 deg) and severs itself above that — `MAX_WALKABLE_GRADE`. On a 3 m terrain cell
  that is a 1.2 m single-cell step. Nothing else enforces it: the brush reports the
  gradient under the cursor live, and `validate.ts` scans every grid edge.

The terrain mesh is one quad per cell, emitted per 48 m block, with two fast paths
that keep a mostly-level map cheap: no heightfield at all is a single quad, and a
block whose vertices are all one height collapses to a quad too. Hollowmere is 25
blocks and **3,110 triangles**.

**A road is re-cut against that mesh.** One height sample at a placement's centre is
right for a cottage and wrong for a 130 m street, which used to float at one end and
bury itself at the other, so `terrainSlab` (in `TerrainField.ts`) tessellates the
slab to follow the ground. It is a builder reading `BuildCtx` and still returns
origin-local geometry, so the merge is unaffected. Three things make it work, and
undoing any puts black holes in the cobbles:

- **It samples `surfaceAt`, not `heightAt`.** The floor is *drawn* as flat triangles
  across a bilinear field and the two differ by up to a quarter of a cell's twist.
  Follow the smooth field and the road sinks under the mesh on every twisted cell —
  and the symptom is not a sunken road but the road's own outline shell showing
  through as black blobs, because the shell passes the depth test where the surface it
  belongs to does not.
- **Its cuts are the terrain's own grid lines, and nothing between them**, so a slab
  quad coincides with a terrain quad corner for corner. Subdividing finer is strictly
  *worse*: a mid-cell sample lands on the wrong side of the terrain's diagonal.
  `surfaceAt(x, z, true)` — the upper envelope of the cell's two triangle planes —
  covers samples that can't be on a grid line (the road's own edges); being convex, a
  triangle between three of its samples is guaranteed to clear the floor.
- **An odd quarter turn flips the diagonal.** `rotY = ±π/2` maps the local diagonal
  onto the world *anti*-diagonal, so the road would split every cell the opposite way
  from the ground it lies on; the quad starts one corner along.

A road over level ground still collapses to the single box it always was
(`terrainSlab` returns null), so this costs nothing on the shipped map. Only `road`
does this (`CONFORMS_TO_TERRAIN` in `BuildingKit.ts`); `terrace`, `ramp`, `jetty`
and `bridge` carry walkable box colliders, and bending only their visuals would put
the surface you see out of agreement with the surface bullets spark off.

**Babylon defaults to a LEFT-handed system** (`scene.useRightHandedSystem` is
false), so a front face is *clockwise* seen from the front. Hand-built `VertexData`
wound the right-handed way — the order you get working the cross product out on
paper — fails in the worst possible manner: the meshes build, the shaders compile,
the console is clean, nav and picking are unaffected (Babylon's triangle picking is
two-sided), and the only symptom is that `ComputeNormals` derives downward normals,
so the floor is back-face culled and lit from below. The world looks like it has no
ground at all and every number you can check still reads correct. `assertFacesUp`
throws on it in dev builds; trust that over your own derivation.

The terrain is emitted **per 48 m block**, each with an invisible clone marked
`solid` — the one place a collider shares a visual's vertices, since a heightfield
has no box to stand in for it, so `MapBuilder.collider()` is bypassed and `NavGrid`
reads the field directly. The block split is not just for culling: `CameraSystem`
picks every frame and `CombatSystem` every shot, and one map-wide floor mesh would
defeat bounding-box rejection.

### The valley rim

The map's boundary is **four collider boxes and a landform, and they are two
separate things** — the clearest case of the visual/collider split in the tree.
`MapBuilder.buildValley` emits the four boxes (20 m tall, 244 m long, inner faces at
exactly ±120) and they are the only thing that stops anything leaving;
`src/world/Ridge.ts` draws an escarpment over them and stops nothing. That split is
why seven sites — `NavGrid` (rasterize, severLinks, clearBlocked), `ObstacleField`,
`CoverMap`, `Minimap`, `DeployScreen` — identify the boundary with `box.w > 200 ||
box.d > 200` and know nothing about the rim. **Keep the boxes over 200 m and keep
the rim collider-free**, or that heuristic is the first casualty. The minimap and
deploy map still draw a clean square while the world shows a lumpy one; they are
schematics, and that is correct.

- **It is built OUTWARD from ±120 and never inward**, into space no player can
  occupy, so it costs zero playable area. `assertOutsidePlay` throws in dev.
- **Its basal band is vertical and flush with the collider plane.** Colliders have
  to line up with the surfaces they stand in for, and a face battered outward from the
  floor would put visible rock most of a metre in front of the box at chest height, so
  rounds would spark on air. `PLINTH_FLOOR` (1.8 m) clears the standing eye, the hit
  sphere's top and `CoverMap`'s hard-cover height; the noise and the passes ride above
  it, never through it. Measured flush to 0.000 m at 1.05/1.55/1.7 m on all four rims.
- **The crest is an ANGLE from the map centre, never a height.** `Sky.ts` culls
  stars below dome row 0.46 (7.2° elevation) and cloud below 0.47, and paints the dome
  flat `fogColor` beneath the horizon — so a crest under that exposes a band of sky
  with nothing painted in it. A tangent clamped at `MIN_SLOPE` makes that true by
  construction, and buys the corners bigger massifs than the sides for free. The rim
  measures 8.19° at its lowest (the two passes deliberately dipping) against the 7.2°
  floor.
- **A pass is a saddle, not a cutting.** `MIN_SLOPE` sits just above the sky's floor
  rather than at the rim's own height precisely so a pass has somewhere to drop to —
  at 0.17 the clamp swallowed the cut and the cols were invisible. Only the crest
  falls; the face is left alone, because pulling it in and raising the basal band
  turns a way out of the valley into a quarry.
- **Its own RNG stream.** `buildValley` runs *before* the scatter loop, so a single
  draw from `MapBuilder`'s shared stream would reroll every scatter region on the map
  — a visible change with nothing in the diff to point at it. Verify a rim change by
  fingerprinting `colliderBoxes`.

Shape lives on `MapLayout.ridge` (a `RidgeSpec`, all fields optional) and the
palette on `EnvironmentSpec` (`ridgeColor`/`ridgeScreeColor`). That split is not
tidiness: `applyEnvironment` writes uniforms and nothing else, which is what lets
the editor's work light swap a spec per keypress with no rebuild, so a *shape*
living there would silently stop working. The rim is a **receiver only**
(`noShadowCaster`) — a 20–45 m crest throws 26–58 m of shadow at the moon's 38° and
the shadow window is a fixed 110 m square following the player, so a casting rim
would end its shadow in a hard line sliding across open ground as you walk.

**Scatter placement is seeded** (`layout.seed`, via `src/world/rng.ts`). This is not
cosmetic: blocking scatter emits colliders, colliders feed `NavGrid` and
`ObstacleField`, so an unseeded scatter means the navigation graph differs between
page loads and a bot wedged on a boulder is only reproducible on some boots. Never
call `Math.random()` in world-building code. One stream serves the whole build, so
**inserting a region rerolls every region after it** — append rather than insert if
you want a readable diff.

**A scatter region is a disc or an oriented rectangle** (`ScatterCircle` /
`ScatterRect`, discriminated by which extents are present — `radius`, or
`width`/`depth` plus `rotY`). Both shapes draw the same two random numbers per
placement attempt, so the shipped map's dressing is bit-identical to what the
circle-only sampler produced. A region is filed under the map block its **centre**
falls in, so break a belt longer than the 78 m fog wall into a few rectangles.

Builders assemble geometry **at the origin, unrotated**, and return three parallel
lists (`meshes`, `colliders`, `lights`) in local space; `MapBuilder` merges the
meshes per colour and then transforms all three into place. Building at identity is
what makes the merge safe — `MergeMeshes` bakes world matrices and returns an
identity-transform mesh. **A scatter region obeys the same rule**, which is what
lets the editor move and turn one by writing a transform. A merge of *one* mesh is
the exception `MergeMeshes` will not handle — `mergeByMaterial` bakes those by hand,
and before it did, every colour used by a single part of a rotated building (the
tavern's sign, the smithy's forge glow, the boathouse lamp) was translated into
place without being rotated.

A **second merge pass** (`BlockMerge`) collapses neighbouring structures and scatter
fields into one mesh per (48 m map block, material). The village is ~230 structures
and the outline pass draws every mesh twice, so without it the map alone costs ~670
draws; with it, ~150, and frustum culling still throws away most of the map because
a block is well inside the 78 m fog wall. Outlines still trace each building,
because `renderOutline` expands vertices along their own normals.

Layout gotchas that have already cost time:

- **A blocking scatter prop's collider comes from `PROP_BODIES`, not from its
  `clearance`.** Clearance is a placement rule and generous on purpose; sizing the box
  from it gave every prop a square collider inflated by its own spacing margin — a
  0.24 m headstone stopped rounds through 1.2 m of air and a dead tree ate a 1.74 m
  corridor around a 0.7 m trunk. The box is oriented with the prop, which is the only
  thing that makes a fallen log or a headstone meaningful. Keep the numbers measured
  against `Props.ts`: too small costs a round clipping a silhouette, too large costs
  shots that visibly should have landed. Note `CreatePolyhedron`'s `size` is not a
  radius — `size: 0.8` is a 2.26 m boulder, the only prop sized *up*.
- A collider's top face must stay within `CONFIG.nav.stepHeight` (0.6) of the ground
  beside it, or the nav flood fill never reaches it and bots treat it as a wall. The
  boathouse and jetty decks both failed this at 0.62–0.73 m.
- A control point's `pos` must not be inside a collider, or `surfaceAt` returns -1
  there. Flag C was originally centred on the well.
- Ramps need `rotX` on the **collider**, not just the visual box, or the player
  walks into an invisible flat slab.
- A run of fence or dry-stone wall must be split wherever a road, ramp or gate
  crosses it. The nav graph honours thin walls (`severLinks`), so an unbroken run
  genuinely routes bots the long way round — or seals a plot outright. Enclosures like
  the burying ground need a gap of a couple of cells, and corners left open help more
  than a wider gate.

### The map editor (dev only)

`F2` in a dev build opens `src/editor/` — free-fly the real scene, click to select,
drag gizmos, edit properties, add and delete entries. Everything under
`src/editor/` is reached through **one dynamic `import()` inside a
`import.meta.env.DEV` branch in `Game.toggleEditor`**, and the *whole method body*
is behind that gate, not just the keybind — that is what makes the import unreachable
under `vite build` so Rollup drops the chunk. Never import `src/editor/` statically.

Things it deliberately does not do:

- **It does not make visuals pickable.** Babylon skips the `isPickable` test when a
  pick supplies a predicate, so the editor picks on `metadata.editorRef`.
- **It does not build colliders.** Proxy meshes for flags, spawns, scatter regions
  and water/grass/terrain rects are visual only and never enter `colliderBoxes`.
- **It does not re-run builders to move things.** A builder assembles at the origin
  and `MapBuilder` transforms the result, so `repositionItem()` moves the visuals, the
  collider proxies and the `WorldBox`es directly.

**There are two pointer modes.** `T` toggles terrain mode and the panel turns
violet, because a mode you forget you are in makes every click feel broken. The
ground is *under* everything, so a terrain annotation is a flat sheet competing for
the same click as the water rect, the grass rect and the jetty standing on it —
whichever is on top wins and the rest become unselectable. In terrain mode only the
ground answers; in object mode terrain is not in the pick at all.

In terrain mode the cursor highlights the cells it covers, `[`/`]` resize the brush,
and the left button draws with one of **two tools**, swapped with `F`: **sculpt**
(drag up or down to raise or lower the cells under a brush that stays where it was
pressed) and **level** (the click samples the height under it and the brush then
paints, pulling everything it is dragged over to that one height). Free-hand
sculpting cannot produce a flat basin floor or a pad that meets the ground around
it, and the nav grid's slope limit and a building's footings are exactly what
"slightly different every pass" ruins.

Both apply a linear falloff from the inner half outward. A hard-edged brush would
make a cliff on its first click, which the nav graph then refuses to walk across;
for the level tool the same falloff blends a levelled pad into the ground around it.
The status line shows the steepest gradient under the cursor against
`MAX_WALKABLE_GRADE` and turns red past it, and names the armed tool.

A stroke is **absolute, not incremental**: the affected vertices are snapshotted
when the drag starts and every mouse move re-derives from that snapshot, so the
result cannot depend on frame rate or mouse speed. Painting makes the same rule do
more work — a vertex remembers the height it had when the stroke *first* touched it
and the *strongest* weight any pass has given it, so dragging back and forth settles
instead of creeping toward the target. Pointer moves are sampled rather than
continuous, so the gap between two is filled with stamps half a brush apart; without
that a quick drag leaves a dotted line of untouched cells, which on a level stroke
is precisely the "nearly flat" it exists to eliminate.

During the stroke only the floor's *visual* blocks are re-tessellated
(`TerrainBrush.reapply`, sub-ms); colliders, navigation and everything whose `y`
rides the ground are stale until release, which schedules the debounced rebuild.
That split is why it feels immediate — nothing walks on the ground mid-drag. It is
also why the brush picks against the floor's **visual** blocks rather than its
`solid` clones: the two carry the same vertices except mid-stroke, and a painting
brush following the stale collider would drift away from the ground being levelled.

**Proxies and gizmos work in world space; the layout stores heights above the local
floor.** `originOf` adds the terrain height and `applyTransform` subtracts it again,
so a rect in a basin draws where it actually is and a round-trip drag writes back
the same relative offset. Getting this wrong is not subtle: a translucent proxy
sheet left at the raw layout `y` hangs over a dug basin and washes it flat, which
reads as the ground having disappeared. `waterY()` lives in `TerrainField.ts` so
`WaterSystem` and the proxy cannot disagree.

**Three rebuild tiers, decided by what changed.** Measured: a full editor build is
~570 ms, `NavGrid` + all 7 flow fields ~45 ms, one builder call ~0.9 ms.

| change | tier | cost |
| --- | --- | --- |
| dragging a gizmo | move that item's meshes and `WorldBox`es | sub-ms, every frame |
| drag released, flag/spawn edited | `NavGrid` + 7 flow fields + `ObstacleField` | ~45 ms |
| param, kind, add, delete, brush stroke released, **road drag released** | `Game.buildEditorMap()` — the whole map | ~570 ms |

The third tier is not laziness. Changing a param changes how many colliders an item
emits, which shifts every later index in `colliderBoxes` and invalidates the
per-item editor index wholesale; there is no correct patch, only a rebuild. A road
earns it for a different reason: its vertices were cut against the ground it started
on, so a translate leaves it contoured to the wrong patch of floor
(`CONFORMS_TO_TERRAIN` is the list). It is debounced by `EDITOR.rebuildDelay` so
holding a spinner does not queue thirty builds, and *not* debounced for add/delete,
which are single deliberate actions. Anything the editor holds that points at
geometry — highlight, gizmo anchor, selection — is re-derived after it rather than
patched. **A `SelectionRef` is a list plus an index, so deleting invalidates every
ref after it in that list**: the editor drops its selection on delete rather than
fixing them up, and `applyStructural` runs the rebuild immediately rather than
leaving stale indices addressable.

Property editing is driven by three files that must agree on what a field key
means: `fields.ts` declares the vocabulary (dotted paths like `params.width`, plus
the three compound keys `kind`, `owner` and `shape` that write more than one field),
`inspect.ts` produces the controls, `mutate.setField` applies them. Two rules keep
the layout terse: **a value equal to the builder's own default is removed, not
written**, and absent-means-default fields (`y`, `rotY`, `blocking`, `clearance`,
`density`, `scale`) disappear when cleared rather than being written as an explicit
zero. Angles are edited in degrees and stored in radians so `Math.PI / 2` survives —
see `qAngle`.

**The map's FLOOR is edited through that same inspector, off a `SelectionRef` that
names no layout array.** `{ list: "floor" }` is a singleton ref reached from a panel
button — never from a pick, because the floor is under everything and picking it
would take every click meant for what stands on it, the same competition terrain
mode exists to settle. It rides the selection union rather than getting a panel of
its own because everything downstream of a selection (the shape-diffed inspector,
the debounced rebuild tier, the dirty flag) is written against a ref, and a second
path through all of that to edit two fields is the expensive way to spell it. Two
seams it opens: `setField`'s contract is "a layout entry, mutated in place", so the
floor takes its own writer (`setFloorField`) which also **reports whether anything
moved** — a colour input fires on every step of a drag and each step would otherwise
buy the ~570 ms rebuild; and the inspector's controls are now live whenever there
are any, with only the delete BUTTON conditional, since the two used to travel
together and a map cannot be without a floor. `fields.ts` grew a `color` kind for
it — a hex string is not something anyone can read as a colour, and choosing one
against the map it is going onto is the whole point of doing it here.

**Saving (`Ctrl+S`) patches `layout.ts`'s text; it does not regenerate it.** The
file is authored — the ASCII village map, the district commentary, and
`BANK_H`/`TERRACE_H`/`WARDEN`/`BLIGHT` in place of bare numbers would all die on the
first save of a code generator. So the editor rewrites only the lines that changed:
an entry nobody touched is re-emitted **byte for byte** (a no-op save is verified to
reproduce the file exactly); an edited entry is rebuilt field by field, and each
field still equal to what was loaded re-emits its **original source token**, which is
how `TERRACE_H` and `Math.PI / 2` survive on a rewritten line (comparison is against
a deep snapshot taken when the editor opened, so nothing ever evaluates those
expressions); a **deleted** entry's line goes with it and nothing around it moves;
an **added** entry is written fresh at the end of its array.

**A `LayoutSaver` is bound to ONE map, by id, and checks that it is.** The id picks
the source text (out of an `import.meta.glob` of every `world/*/layout.ts` — a `?raw`
specifier is static and cannot be chosen at runtime), both write paths, and the
heights module's export name. Every map's `layout.ts` has the same *shape*, so a
saver holding map A's text and handed map B's layout patches the wrong file and
mostly **succeeds** at it — the one failure mode here that loses work with a clean
"saved" in the status bar. The constructor refuses unless the source it found
declares that map's own `export const <MapId>Layout`, failing into `blocked` rather
than throwing. `serializeHeights` takes the id for the same reason: it writes the
`export const <MapId>Heights` that map's `layout.ts` imports, and a wrong name there
is a checkout that stops compiling after a terrain save.

**`environment.ts` is the third file a save may write, and it is patched one KEY
at a time** (`src/editor/saveEnvironment.ts`). The floor picker is what writes it,
and the file is authored in the same sense `layout.ts` is — nearly every colour in
a spec carries the argument for why it is that colour — so the same rule applies:
rewrite the line, leave everything around it alone. It is deliberately **not** built
on `sourceScan.ts`, which models flat arrays of one-line entries anchored on their
own `const name: Type = [`; a spec is one nested literal with multi-line members,
exactly the shape that scanner refuses to touch. Three rules make the shortcut safe:
a key is anchored at the literal's **own two-space indent**, so `lighting`, `sky`,
`water` and `grade`'s members (four spaces and deeper) are unreachable by
construction; the anchor must match **exactly once** or the patch is refused rather
than guessed; and the source must declare that map's own
`export const <MapId>Environment`, the same pairing check and the same silent
failure mode `LayoutSaver` documents. A `null` value REMOVES the line, which is how
`floorSurface` returns to its default. What it cannot do is keep the **comment**
above a key true — that prose is the author's, and after re-tinting a floor from the
editor the note explaining the old colour is theirs to bring back into line.

**`vite.config.ts`'s `WRITABLE` stays a literal table — three lines per map.** Path
safety comes from the client's path only ever being *looked up* in it and never used
to build a path, so a regex or a directory listing trades the guarantee for
convenience in the one tool here that writes to disk.

Add and delete work because entries are matched to source lines by **object
identity**, not position — a `WeakMap` from the live layout entry to `{ line, values
}`, bound when the editor opens and rebound after each save (`Baseline` in
`serialize.ts`). Positional matching would go wrong the instant anything ahead of an
entry was deleted. Rebinding after a save is also what lets an entry added earlier
in the session be edited again rather than appended twice.

Gizmo output is quantised before it reaches the layout (`mutate.ts`), and positions
and angles **differently** on purpose. Positions round to 3 dp, matching what the
serializer writes. Angles must not: `Math.PI / 2` rounded to `1.571` is no longer a
quarter turn to within the emitter's tolerance, so it would be written as a bare
decimal and drift off house style — angles snap to the exact quarter turn when
within a whisker of one and keep 6 dp otherwise. Both then treat "close enough to
zero" as zero, so a drag returning something to where it started leaves no trace;
without that, an un-rotated building picked up a redundant `rotY: 0`, because
`1e-17 !== 0` survives the drop-optional-field test and prints as `0`.

This rests on two properties of `layout.ts` that `sourceScan.ts` re-checks every
session: **every array entry is exactly one line**, and each array is delimited by
its own `const name: Type = [` … `];`. Those declarations are the region anchors, so
the file needs no marker comments. A line that fails to tokenize becomes `opaque`
and is never rewritten — the failure mode is always "leave it alone". Multi-line
entries are the one thing that would break this; the editor treats one as a comment
and refuses to touch it rather than corrupt it.

**The validation list ranks honestly, and the ranking is the design.** Errors are
definitely broken and are zero on a healthy map: a control point whose centre is not
standable (the Flag-C-on-the-well bug), and a flag or spawn unreachable from a home
spawn. Warnings need a human: the biggest is "standable ground nothing can reach",
which is *also* how a roof and the top of a boulder look. `validate.ts` filters both
out — roofs by height above adjacent walkable ground, prop stands by flatness — but
the nav grid cannot distinguish a boathouse deck from a large flat collider top, so
a handful survive on Hollowmere while it plays perfectly well. Read that number as a
**delta**: note it, move a wall, look again. `makeIslandTest` is shared with the
overlay so the red cells on screen are exactly the reported findings.

That flatness filter is why terrain is checked directly by `terrainGrade` rather
than left to `islands()`: a sculpting brush is a machine for producing unreachable
ground, but a flat pit floor looks exactly like the top of a boulder to the island
heuristic, so the one finding worth having is the one it suppresses. `terrainGrade`
scans every edge of the height grid against `MAX_WALKABLE_GRADE` and reports a count
with the worst offender's location — one finding per cell would bury everything else.

The `structure()` checks exist only because entries can be deleted: a duplicate flag
id silently merges two flags' flow fields (they are keyed by id), a spawn naming a
flag that no longer exists is skipped by `ConquestSystem` without saying so, and a
team with no home spawn deploys at the origin. None can happen by dragging
something, and all are errors.

**There is no undo.** The escape hatch is that leaving the editor rebuilds from the
layout module, so F2 (which asks first when there are unsaved edits) throws away
everything since the last save.

`vite.config.ts` holds the dev-only write endpoint. It is deliberately outside
`tsconfig.json`'s `include` (`@types/node` is not installed), so it stays trivial
and the real logic lives in `src/editor/serialize.ts` under the typecheck. Its
`handleHotUpdate` swallows the editor's own writes: none of the three files has
`import.meta.hot.accept`, so an update would propagate to `main.ts`, find no
accepting module, and full-reload the page on every save.

**Both sides of that swallow go through `norm`, and they have to.** The written
path comes from `resolve`, which uses the platform's own separators, while Vite
normalises the `ctx.file` it hands `handleHotUpdate` to POSIX ones — so on Windows
the Set was keyed on `C:\...\layout.ts` and probed with `C:/.../layout.ts` and never
matched. Nothing throws and no save fails; the page simply full-reloads on every
`Ctrl+S`, taking the camera, the selection and the whole session with it, which
reads as the editor crashing on save rather than as a path bug — and it cannot
reproduce for anyone authoring on Linux. Normalising both sides rather than adopting
Vite's spelling is what stops the two drifting apart again.

`build(layout, env, { editor: true })` skips `BlockMerge` so each placement keeps
its own meshes — ~1740 draws against ~150. **Never judge frame cost from the
editor.** Roads also go un-outlined there: in play they merge into one mesh first,
and kept separate each road's outline shell paints a black patch over every junction
it overlaps.

### Visual meshes and collider proxies are separate things

The single most load-bearing rule in the world layer. Every ray test filters on
`metadata.solid === true` — `CombatSystem`'s hitscan (every shot),
`BattleSystem`'s LOS, `Player.probeGround`, the grenade's step ray, the death cam's
pull-in — and `moveWithCollisions` walks every mesh with `checkCollisions`. At
village scale, visual geometry must stay out of both.

| Kind         | visible | pickable | collides | `solid` | merged | frozen |
| ------------ | ------- | -------- | -------- | ------- | ------ | ------ |
| **Visual**   | yes     | **no**   | **no**   | —       | yes    | yes    |
| **Collider** | **no**  | yes      | yes      | yes     | no     | yes    |

Colliders must line up with the surfaces they stand in for or bullet sparks land
off the visible geometry. `MapBuilder.collider()` is the only place that creates
them, and it also records a `WorldBox` for the nav grid — geometry added by any
other path is invisible to navigation.

**The floor is the one documented exception**, and it proves the rule rather than
bending it: the heightfield has no box that could stand in for it, so each block's
collider is an invisible *clone of the visual's vertex data* — same shape, still two
separate meshes, still only the clone marked `solid`. It emits no `WorldBox` and
`NavGrid` reads `TerrainField` directly. It is also the only `solid` mesh with
`checkCollisions = false`: `moveWithCollisions` is horizontal-only, vertical
placement is the ground probe's job, and bots never touch the collidable list.

### Mesh metadata is a contract

Four flags, all read elsewhere; new geometry that omits them misbehaves silently:

- `solid: true` — collider proxies only. Unmarked geometry is shot through, seen
  through, and walked through.
- `noOutline: true` — skipped by `addOutline()`. Every emissive part (eyes, flames,
  signs, reticle) needs it. Outlines are coloured ink (a darkened take on the mesh's
  own cel colour), thinned with distance per mesh by `updateOutlineScales()` and
  faded into the fog per pixel by `OutlineFog`.
- `noGlow: true` — excluded from the `GlowLayer` in the `Game` constructor. Only
  meshes existing at construction time are scanned. A mesh that stays in bloom
  is faded with distance instead (`customEmissiveColorSelector`), and
  `infiniteDistance` is that fade's one exemption — it is what every sky mesh
  sets, and the moon is not in the valley to be fogged out of.
- `noShadowCaster: true` — excluded from `ShadowSystem.setCasters()`. Flat receivers
  (ground, roads) need it: casting from them is pure shadow acne.

### Navigation

`NavGrid` is built from the finished collider set at map load. The graph node is a
**surface** — a (cell, height) pair — not a cell, because one cell can hold the creek
floor and the bridge deck above it, or the barn floor and its hayloft.
`MAX_SURFACES` is 3.

Every cell's *base* surface comes from `TerrainField.heightAt` at the cell centre.
Heights above the base come from evaluating each collider's top-face *plane* at the
cell centre, not from its bounding box: a pitched ramp's AABB reports its peak
across the whole footprint and would read as a wall. If you touch `topFaceHeight`,
note the half-thickness is `h/2/cos(rotX)` and the slope is `tan(rotX)` — writing it
as `h/2*cos` and `-tan` is the easy sign error, and it silently makes every ramp
unwalkable.

`heights` is `.fill(-1)` to pad unused slots, but that is **not** a "below ground"
sentinel — every read walks `counts[cell]`, which is what lets sunken terrain hold
ordinary negative heights. Any new consumer must bound on `counts` rather than
testing `y < 0`.

Reachability is a flood fill from the map's outer ring. That is what keeps bots off
rooftops: a roof is a perfectly good standable surface, but nothing beside it is
within a step. It also assumes that ring is open ground, which is why a terrain
patch putting a *wall* edge out at the ridge is flagged.

**A link is cut when the segment between two cell centres crosses a solid box**
(`severLinks`). Sampling one column per cell centre means a wall thinner than a cell
— every fence, dry-stone field wall, ruin wall and gravestone — can sit *between*
centres, leaving the cells either side both standable and linked; the flow field then
points straight through the wall and the bot walks into it for the rest of the round
(`ObstacleField` keeps the body out of the stone but cannot change where the field
says to go). Testing the segment rather than blocking whole cells is what keeps the
1.6 m cottage doorways passable. A box only counts as a barrier where it stands more
than `stepHeight` above both ends of the link, so decks, kerbs and the terrace's top
face don't cut the links leading onto them.

**A surface keeps ONE link per direction — the nearest STANDABLE neighbour — and
that is why `clearBlocked` runs before `link`.** A surface with no headroom can
never be stood on, so letting one win the single slot spends the link on a dead end.
It is not a rounding error: it made every ramp on the map a coin toss. The ground
*under* a ramp is blocked while the slab is within `HEADROOM` of it, while the
ramp's own top face is a separate surface only once it stands more than `HEIGHT_EPS`
(0.35 m) above that ground — below which `addSurface` merges the two and the climb
is free. Between 0.35 m and the `stepHeight` at which the buried ground drops out of
range there is a band where both are candidates and the blocked one is nearer, and
whether a ramp's cell centres land in that band is decided by the placement's world
position. The barn's loft ramp landed in it and the hayloft was unreachable by every
bot on the map.

**A ramp must also run on PAST the ground rather than stopping level with its own
structure's floor.** Nothing guarantees a placement's `y` is zero or the floor under
it level, and a foot even a couple of centimetres over `stepHeight` above the
terrain severs everything above it — Hollowmere's second barn carries `y: 0.33` and
did exactly that. A `stepHeight` of overrun buries the last stretch instead, where
the terrain simply wins the surface and it costs nothing. `buildBarn`'s `rampDrop`
is the worked example.

One flow field per objective (5 flags + 2 home spawns) is precomputed at load; the
map is static so nothing is ever recomputed. Bots read `nav.steer()` and never run
their own pathfinding. **Bots do not use `moveWithCollisions`** — a cell being
walkable *is* the collision test, and it already accounts for headroom and step
height; 16 agents walking the collidable mesh list every frame is not affordable.

**The grid is too coarse to be the whole collision test, though.** One column per
cell *centre* means a collider narrower than 1.5 m — every scattered tree (1.1 m),
gravestone, fire drum — can sit between centres and leave every cell around it
walkable. `ObstacleField` is the sub-cell half: collider boxes bucketed at load,
queried per step to push a body clear of anything it overlaps. `Bot.stepTo` consults
it, then asks the grid; `Bot.tryMove` retries each axis alone so a blocked step
slides instead of freezing. Two rules keep the push-out from causing the problem it
fixes: it is a *preference*, never a veto (if the pushed-clear spot is somewhere the
graph rejects, the bot takes the overlapping one — frozen is worse than clipping),
and two fruitless sidesteps in a row set `squeezeT`, which drops the push-out for a
second so a bot wedged in a gap narrower than its own body gets out.

This is why bots stuck in props were also unshootable: `CombatSystem.fire` caps a
shot at the first `solid` hit and only counts a target sphere closer than that, so
the prop ate every round aimed at the body inside it. The two symptoms are one bug.

### Bot scaling

Three things carry the frame budget; undoing any costs ~10× draw calls or a
permanent hitch:

- **The rig pool is built once and never disposed.** Death hides a rig, respawn
  re-poses it. `new Bot()` allocates a dozen meshes and their GL buffers, and Conquest
  respawns continuously.
- **Bot rigs are nine merged meshes** (`SoldierModel`). The outline pass draws
  everything twice, so fidelity is ~2× draw calls per bot per mesh.
- **AI is staggered at `CONFIG.bots.thinkRate`**, round-robin across frames.
  `acquire()` gathers candidates by distance and ray-tests them in ascending order,
  returning the first visible one — testing all of them fires up to 30 picks per think.
  Two things keep that honest: the view cone rejects most candidates *before* any ray,
  and `CONFIG.bots.acquireRayBudget` caps how many survivors get tested. A dead bot
  must also not consume a think slot, or the living half of a roster thinks at half
  the advertised rate.

Bots hold a target until it dies, breaks LOS, or leaves range. Without that
hysteresis, "nearest visible enemy" flips every tick in a crowd, which resets `aimT`
so bots essentially never finish their reaction wind-up and fire — this looked
exactly like "bots don't shoot". It is also why losing a target does not simply null
it: `BotMemory.lastAimed` outlives `target`, and re-acquiring the same enemy resumes
at `profile.reacquireDelay` instead of from zero.

### Deaths, and the one physics engine

A killed bot falls under **Havok** (`src/systems/RagdollSystem.ts`), and so does the
stand-in body the death cam stands up. This is the only physics engine in the tree
and the only place `@babylonjs/havok` is imported. It buys nothing but the fall:
**nothing here feeds navigation, cover or hit detection.** A corpse is not in
`NavGrid`, not in `ObstacleField`, not in `hittablesAgainst`; bots walk through
bodies and rounds pass through them. Do not "fix" that by feeding corpses into
`ObstacleField`, whose buckets are baked at map load.

**The collapse tween in `Bot.update`'s dead branch is not legacy — it is the floor
under all of this**, and it runs on five separate refusals: the WASM has not loaded,
the WASM failed, the setting is off, the pool is full, or the death was past
`death.maxDistance`. Deleting it is the single worst change available here. The tween
is exempt from the pose-freeze LOD *because it is five property writes*; **a ragdoll
needs no such exemption**, because it poses through the proxy nodes its joints are
parented to and the solver writes those whatever the LOD says. Reading those two as
one fact is what pinned `maxDistance` to `lodFreezeDistance` (35) and stopped anything
dying across the square from falling over at all — a marksman rifle's whole range.

**The gate is the FOG WALL, and it is one number for everything that stops at it.**
`FOG_WALL` in `config.ts` is a module constant because two unrelated tunables are the
same distance and must move together: `bots.lodDisableDistance`, where `BattleSystem`
stops drawing a rig, and `death.maxDistance`, one metre past which the solver would be
tumbling something nobody can see. `BattleSystem` wrote its own `78` out by hand
before this, which is how the ragdoll gate came to be keyed off an unrelated LOD. It
must agree with the MAP's `EnvironmentSpec.fogEnd` — the one that actually paints the
fog — and `installMap` warns in dev builds if a map disagrees, because on a second map
those two would otherwise drift in silence.

**The pool refuses rather than stealing a live slot, with exactly one exception: the
death cam's body.** A bot's corpse is one of sixteen; the player's is the sole subject
of a four-second shot, and a slot is held for the whole `sinkStart` (5 s), so a handful
of nearby deaths inside five seconds — which is what a firefight the player lost looks
like — locked the pool and spent that shot on a body standing to attention.
`RagdollSystem.spawn` takes a `priority` flag for it, `takeSlot` takes the OLDEST
corpse to honour it, and `Game`'s `onSpawnRagdoll` wiring is the only place that may
pass it: every priority offer costs a body that was already falling, so a second
caller would be two claims on one exception.

**`maxConcurrent` is what bounds the cost, and it is measured, not reasoned.** Eight
falling corpses are 0.121 ms/frame against the whole roster's AI at 0.39–0.42 ms in
the same run; a settled one is 0.0004 ms because the engine is not stepped at all, and
unused slots are free (four corpses cost the same in a pool of four and a pool of
eight). Raising the DISTANCE is what makes the pool busier — raise the two together.
FINDINGS #8's older 1.37 ms for four does not reproduce; see the note there.

- **`scene.physicsEnabled` is FALSE and must stay false.** Babylon steps physics
  from `scene.animate()` on every RENDERED frame, and this game renders in every state
  — so a scene-driven step would leave corpses tumbling under the pause card, under the
  deploy map and behind the menu. `RagdollSystem.update` steps the world by hand and
  is called only from `Game.updateGameplay`, which is what a pause already stops.
  Measured: bit-identical body position across 12 rendered frames while paused.
- **Havok never touches a rig node.** It writes pool-owned PROXY `TransformNode`s
  and the rig's joints are parented to those. Havok's sync calls
  `decomposeToTransformNode` on any node with a parent, which force-creates a
  `rotationQuaternion` — and while one is set Babylon ignores `rotation`, which is what
  `animateSoldier` writes. One leaked quaternion is a bot that respawns frozen
  mid-tumble for the rest of the round with its position still updating underneath.
  `setParent` is safe in both directions (verified: it writes Euler when there is no
  quaternion), which is what makes the hand-off and hand-back clean.
- **`resetSoldierPose` is the authoritative restore, and `animateSoldier(rig,
  0,0,0,0, 0)` is not a substitute.** That call writes ten Euler channels; the rig has
  far more, and never a `parent`, a `rotationQuaternion`, a `scaling` or anything on
  `gun`. `Bot.spawn` calls the former. Verified across three lives on one rig — a leak
  shows on life 2.
- **The map is registered as ONE static body** — a `PhysicsShapeContainer` of the
  ~733 collider boxes plus the 25 terrain blocks as mesh shapes (the floor has no
  `WorldBox`, hence `GameMap.terrainColliders`). Built in `installMap`, skipped on
  editor builds, and torn down leaf by leaf or the WASM heap grows one map build at a
  time. Measured 33–50 ms headless, and 25 bodies flat across three rounds.
- **The rifle is not a bone.** It stays parented to `torso` and rides that body.
  Giving it one drops it out of hands that cannot open — the arm is a single welded
  segment with no elbow, wrist or finger — so the weapon falls away while two fists
  stay cupped around nothing.
- **A corpse sinks; it cannot fade.** The cel shader writes alpha 1.0 outright and
  its materials are shared per COLOUR by `CelMaterialFactory`, so an alpha write would
  dim every bot on the map.

The bone table, pivots and joint limits live in `SoldierModel.ts` with the boxes
they are measured from; `CONFIG.bots.death` owns the sim (impulse, gravity, damping,
corpse life). The impulse needs no new plumbing: `takeDamage` is already handed the
shooter's origin (or the blast centre), so `Bot` captures `deathFrom`/`deathDamage`
there and `Game.registerBotKill` offers the body to the pool.

**The pool holds `RagdollSubject`s and cannot tell the two kinds apart.** That
interface lives in `SoldierModel.ts`, beside the rig and bone table it is a fact
about — not in `RagdollSystem`, because `DeathCam` needs it too and a system may not
import another one. `Bot` satisfies it structurally and imports nothing, which keeps
`Bot.ts` free of any knowledge that a physics engine exists. `retire(subject)` is
the one thing the player's corpse needs that a bot's does not: a bot's body outlives
the death cam's window and goes on its own clock, while the player's has to be gone
before the deploy screen comes up over it.

### The death cam

`Game` goes `playing -> dying` before the deploy map: a body is stood up where the
player fell, thrown by the round that did it, and the camera leaves the head to
watch it land (`src/systems/DeathCam.ts`, `CONFIG.player.deathCam`).

**It is a step in the state machine, not a lid, and that is the whole feature.**
`updateWorld` — objectives, bots, rounds in the air, bodies on the ground — runs in
full underneath it, so the tickets bleed, a squad takes the flag you died on, and
your killer walks past while you watch. A death cam over a frozen world is a
screenshot. `updateWorld` was split out of `updateGameplay` for exactly this: the
cam needs every line of it and not one line of what surrounds it.

**It costs no time.** `enterDeploy` is opened with `respawnDelay` MINUS the time
already spent, so a life is still eight seconds end to end. Lengthening `time`
without that subtract turns feedback into a punishment.

- **The body is the BOT rig**, which is why the retired GLB player body could be
  deleted outright: it hands to the pool with nothing adapted and is already what
  `RAGDOLL_BONES` is measured against. It is built at `startRound`, not at the moment
  of death — nine merged meshes and their GL buffers is not a cost to pay on the frame
  the player is killed on.
- **It is a stand-in, not the player.** `Player` has no rig and never grows one: it
  is a capsule, a viewmodel and an eye. The corpse is a separate object stood up at
  `Player.floorY` (the FEET — `Player.position` is the middle of the collider capsule)
  and hidden again at the end, so nothing in movement, collision or hit detection ever
  gains a mesh to disagree with.
- **The camera leaves the head through `CameraSystem.place`, the one exception to
  that system's own invariant**, and `update` is simply not called in that window — so
  no look input, ADS blend, recoil, bob or landing spring advances, and the aim is
  exactly where it was left when the round comes back. `place` writes the roll and the
  FOV explicitly, or a camera handed over mid-landing would watch the body through a
  tilted, zoomed frame for four seconds.
- **The pull-in is the only occlusion pick in the game outside combat**, and it is
  cast from the BODY outward, never from the camera in — a ray the other way starts
  inside whatever the camera has already backed into and reports the far face of it,
  walking the camera further into the stone. Its origin is the body's own chest rather
  than the look point, which during the rise can be inside a wall the player died
  facing. Measured against the valley rim: the camera stops 0.22–0.27 m short of the
  collider face and never crosses it. It is affordable because `Player.probeGround` is
  not running while the player is dead.
- **The frame is anchored on the corpse's own chest joint**, smoothed at
  `followRate`, which makes one set of numbers work at both ends of the fall: a
  standing body puts the chest at ~1.1 m and a fallen one at ~0.3 m. The joint is read
  with `computeWorldMatrix(true)` first — while the ragdoll owns it, its parent is a
  proxy node the solver moved this frame.
- **Physics is optional here exactly as for a bot**, and the fallback is `Bot`'s
  collapse tween with one difference: it is NOT followed by the hide at `hideTime`. A
  body that vanishes two thirds of a second into a four-second shot of it is the thing
  this state exists to remove. **A full pool is the one refusal it does not take** —
  it offers with `priority`, which evicts the oldest corpse; see the ragdoll section.
- **The pointer lock is deliberately KEPT.** There is nothing to click, and dropping
  it would trip the lock-loss pause on the very frame the shot begins. `enterDeploy`
  releases it one state later — and it is also the single funnel for retiring the body,
  so every path out (the clock, the round ending, F2) hands the rig back.

`HUD.setDeathCam` raises `.dying`, which hides the same four things `.paused` does
and is a class of its own anyway: a pause hides them because the world stopped; this
hides them because the world did *not* and the player is no longer in it. The gauges
stay for the mirror-image reason — they are live and true, and watching the tickets
run while you wait is half of why the cam is worth showing.

### Bot perception, cover and skill

**Everything a bot notices without seeing it is ray-free by construction** — the LOS
budget is the one thing here that does not scale.

- **Field of view.** `acquire()` gates on a cone around `Bot.facing` before it
  ray-tests (bots used to see 360° instantly out to 55 m). Two exemptions:
  `peripheralRange`, and a widened cone while a threat cue is live. It gates
  *acquisition* only — a bot faces its target once it has one, so you can flank an
  unaware bot, never a fighting one.
- **Damage direction is free** — `CombatSystem.fire` has always passed the shooter's
  origin into `takeDamage`.
- **Hearing** is a squared-distance sweep inside `BattleSystem.botFire`, with a
  jittered position so bots converge on the *sound*, not the shooter. `Game` calls
  `hearGunshot` for the player's own fire.
- **Near misses** ride the target loop `CombatSystem.fire` already runs: one extra
  sphere test at `hitRadius + suppressRadius`, reported via `onNearMiss`.
- **Lost line of sight costs no ray either** — `fire()` already pays for a wall pick,
  and a run of `losBrokenShots` blocked rounds drops the target.

**Cover is baked, never probed** (`world/CoverMap.ts`): one bit per direction per
surface, 16 directions, two masks — the same reasoning that makes `NavGrid` bake seven
flow fields. A cover query costs a bit test.

- **Hard cover is 1.7 m — the hit sphere's top, not the 1.55 m eye height.** LOS is
  tested from the eyes but hits are tested against the sphere (`center.y + hitRadius`
  = 1.65). Bake at eye height and a bot behind a 1.6 m wall is *visible but
  unhittable*, which reads as broken netcode.
- **Soft cover (0.9 m) is a steering preference and nothing else.** The rig has seven
  joints and no knees, so there is no crouch: a bot behind a waist-high wall is exactly
  as shootable as one in the open. **Cover here means corners.**
- **It is a preference, not a commitment** — the same rule as `ObstacleField`'s
  push-out. A spot not reached within `cover.abandonTime` is dropped, and a cooldown
  stops the search instantly re-picking it. A bot moving to cover still shoots; only
  the tucked-in half of the peek cycle holds fire. Without both, bots walked into walls
  holding fire for the whole round.

### Squads and movement texture

**Squad orders are planned as a group** (`ConquestSystem.planSquads`), on their own
2 Hz timer rather than per bot per think. What it replaced was `ranked[squad %
ranked.length]`: squad N took the Nth-best flag, so a team with two squads only ever
pursued its top two objectives, could never choose to defend (an owned flag scored a
flat −30 however close it was to being lost), and re-sorted the point list 80 times a
second to do it.

- A claimed point is **penalised, not excluded**. When the round hinges on one flag,
  two squads stacking on it is correct; forced spreading is what sent bots wandering
  away from the fight that decided the game.
- **`ControlPoint.present[]` is finally read** — an owned flag with enemies on it
  scores a defence bonus scaled by how far the meter has slipped.
- **Defending is a posture, not a destination.** `Bot.think` takes a `BotZone` (`none`
  / `contest` / `hold`): `contest` keeps the old drift, since bodies in the circle are
  what move the meter, while `hold` takes a covered vantage and watches. **`hold` is
  checked before the search cue** — a defender that hears a shot and walks off to
  investigate has abandoned the only thing it was there to do.

**Movement texture is heading, speed and facing only.** Two measured results worth
keeping: `NavGrid.steerAhead` plus heading smoothing cut mean path curvature by ~27%
(`steer` returns the direction to the next 8-neighbour cell *centre*, which is why
bots walked flow fields as a visible 1.5 m zigzag); and the per-bot lateral weave
spreads a squad (+95% mean separation) but is itself a source of curvature — at a 5 s
period it put back *exactly* the wobble the smoothing removed, and 11 s keeps the
spread and the straightness both. Retune one, re-measure the other. Smoothing runs
**before** separation and the stuck watchdog, deliberately: the watchdog's sidestep
is what frees a bot wedged behind a tree.

**`Bot.yaw` is where a bot LOOKS; `Bot.bodyYaw` is where its feet point.** The rig
hangs off a single root yaw, so before the split a bot aimed its whole body at
whatever it was tracking and one strafing across a doorway walked visibly sideways.
`animateSoldier` takes a `twist` for the difference, applied at `torso` with the head
taking a share on top; the legs are `torso`'s siblings under `body`, so they are
untouched. It costs one `rotation.y` write and fixes the walk cycle for free. Three
rules: the twist is **clamped** to `CONFIG.bots.movement.maxTorsoTwist` and past it
the hips come round with it, or the shoulders end up on backwards; a **stationary**
bot's feet converge on its look direction; and **perception reads `yaw`, never
`bodyYaw`** — `BattleSystem.inView` keys off `Bot.facing`, and where a bot points its
feet must not change what it can see. This is still not a lean or a crouch — the rig
has no joint that could sell either.

**Skill is one scalar per bot** (`BotSkill.profileFor`), resolved into a `BotProfile`
once at assignment and never per frame — `CONFIG` is `as const`, so lerping at each
use site would need an annotation everywhere. It is drawn **per squad** from a seeded
generator, because an elite squad and a green squad is something a player can read
where salt-and-pepper skill inside a squad is noise. Difficulty tiers slide the
distribution's centre and hold its width, so every tier still contains aces and
rookies.

### Conquest rules

`ConquestSystem` owns flags, the capture meter, tickets and bleed. The meter runs
-1..+1 and ownership flips only by crossing 0, so a flag must be neutralised before
it changes hands. Occupancy is counted from the combatant list `Game` assembles each
frame (player + all bots). The player's health regenerates after
`CONFIG.player.regenDelay`: with eight hostile bots and no medics, a pool that
never refills turns the round into a respawn queue.

**A capture zone is drawn, not just counted** (`CaptureZoneSystem`, plus
`HUD.setCapture` for the panel that appears while you stand in one):

- **The ring is the boundary.** It is built at `ControlPointDef.radius`, which is
  what `pointAt` tests, so the line on the floor is not an approximation of the zone —
  it is the zone. Drawing it anywhere else is worse than drawing nothing.
- **It follows the surface you STAND on, not the terrain.** A 28 m ring placed by one
  height sample at the flag is buried at one end (the problem `terrainSlab` solves for
  roads), but sampling `TerrainField` alone is still wrong, because four of the five
  flags sit on a paved square or a deck above the ground under it. The ring takes the
  higher of `terrain.surfaceAt(x, z, true)` and the nav graph's walkable height nearest
  the flag's own `y`.
- **The skirt is revealed by proximity.** It is a cylinder around the zone, so from
  inside you are always looking through its far side; at any alpha that reads as a
  wall, that is a white wash over the entire screen. Per-frame vertex alpha keyed to
  the viewer's distance shows only the stretch you are about to cross.
- **Markers are annotation.** No `solid`, no collider, no `WorldBox`, excluded from
  the GlowLayer by hand (Game's scan is construction-time). They are the one persistent
  unlit `StandardMaterial` geometry in the world, so they get no shader fog and have to
  fade themselves out at the fog wall — the beacon keeps a floor so a distant flag still
  reads as a faint column in the mist.

### Rendering constraints that look like bugs if you undo them

- `pipeline.imageProcessingEnabled` must stay `false`: the cel shader outputs
  display-ready colors and Babylon's image-processing pass re-gammas them and washes
  the palette out. That is also why the vignette/grain/aberration/damage flash grade is
  hand-written (`src/shaders/HorrorPost.ts`).
- Glow is a `GlowLayer` keyed off emissive color, deliberately not threshold bloom —
  bright-but-not-emissive surfaces must stay crisp.
- Flat shading is recovered in the fragment shader from screen-space derivatives of
  the world position. Do not call `convertToFlatShadedMesh()`; it would unweld vertices
  on every prop and clone for no visual gain.
- `renderOutline` draws a back-face shell expanded by `outlineWidth` in every
  direction, so an emissive detail must protrude past its neighbours' shells or the
  glow is swallowed (why the player's visor slit and the lamp lens stick out).
- **A flat surface you WALK on must be a thick box, not a thin slab**, and the
  reason is that same shell. `OutlineRenderer` draws it with a negative,
  slope-scaled polygon offset (`setZOffset(-1)`, `setZOffsetUnits(-4)`) that pulls
  it toward the camera, and the slope term is enormous at the grazing angle a
  floor is seen from — so the shell's underside, only `height + outlineWidth`
  behind the real top face, WINS the depth test and paints the surface flat in its
  own ink. The manor's board deck was 0.14 m thick and its whole 22 x 15 m hall
  floor came back as `outlineInkFor` of the boards, which on a dark timber reads as
  a black void and on a pale one as a grey wash. Nothing in the console, and the
  usual suspects all test clean: clearing the shadow casters changes nothing,
  because it is not a lighting bug at all. The same floor as a 0.54 m box renders
  correctly, which is why the podium under it never showed the fault. Depth is what
  buys the margin, so a walked surface gets a box as deep as whatever it stands on
  and is placed by its TOP face.
- **The rim highlight is gated off near-level surfaces, and the gate is not
  optional.** On a plane the grazing angle it keys on is nothing but distance from the
  eye — for a floor, `1 - dot(viewDir, n)` is `1 - eyeHeight/dist` — so an ungated rim
  fires on every ground pixel past `eyeHeight / 0.28` (5.5 m standing, 3.75 m crouched)
  and none inside it: a hard-edged disc of un-rimmed floor locked to the camera,
  sliding across the map with the player (measured luminance 0.205 at 5.0 m against
  0.263 at 5.6 m, a 28% step across one circle). The gate is on **tilt**, because
  distance is only the symptom, and it reads the **facet** normal rather than the
  bumped one — off the bumped normal, individual setts flick it on and off. It costs
  the rim on the near-horizontal top faces of a rig, which were never silhouettes.
- Rendering group **1 is the viewmodel's**, for the depth clear Babylon does between
  groups. Putting world geometry in group 1 makes it draw through everything.
- **The post-process chain has an order, and a display setting that switches an
  effect off REMOVES its pass** rather than zeroing its uniforms — an attached but idle
  pass still reads and writes the whole frame. The order is FXAA, shafts, motion blur,
  horror grade, enforced by where each one re-attaches: `attachPostProcess` appends, so
  the blur's toggle takes the grade off and puts it back behind it
  (`Game.setMotionBlurEnabled`), and the grade's own toggle always appends because the
  tail is where it belongs. `HorrorPost` owns whether it is attached, so the blur's
  dance can never resurrect a grade the player turned off — the guard is in `attach`,
  not at the call sites. Nothing throws if this is wrong; the symptom is grain over a
  smear, which reads as a dirty lens. The red damage flash is painted by the grade's
  shader and goes off with it, leaving the HUD's damage arcs to tell the player where a
  hit came from.
- The cobblestone texture is 512² over a 1.5 m tile (`textures.ts`), sized for a
  camera **1.55 m above the street**.
- **Two up-facing surfaces must never share a plane.** The merge is per colour, so a
  floor slab and the plinth under it land in *different* meshes and their draw order is
  arbitrary — a shared top face is a depth-test tie broken per pixel, which strobes as
  the camera moves. It does not read as z-fighting stipple either, because the two
  surfaces are different colours: the tavern's taproom flickered between blue-grey
  stone and brown boards across all 130 m² of it. Boards stand proud of their plinth
  (`buildTavern`, `buildTownhouse`). Coplanar faces within **one** colour group are
  fine — they merge into a single mesh, which is why gable roofs meeting at a ridge are
  not a bug.

### The sky

Everything overhead is painted at runtime by `src/systems/Sky.ts` from the map's
`SkySpec`: an equirectangular dome texture (gradient, galactic band, stars, the
moon's scattering halo), a textured moon disc that feeds the GlowLayer, and two
drifting cloud decks.

**The dome is painted assuming something occludes the bottom of it**, and that
something is the valley rim — so the two are a contract, not neighbours. Stars and
the galactic band are culled below canvas row 0.46 (`if (y > h * 0.46) continue`,
written twice), `cloudBandBottom` stops cloud at 0.47, and the gradient runs to flat
`fogColor` from row 0.58 down. In elevation that is **7.2° for stars and 5.4° for
cloud**, below which nothing is painted at all. `Ridge.ts`'s `MIN_SLOPE` is the other
half of the contract; lowering the rim without moving these cutoffs uncovers a band
of empty dome.

- **Sky textures are uploaded with `update(false)`.** `DynamicTexture.update()`
  flips Y by default, which maps canvas row 0 to `v = 1` — the *nadir* on Babylon's
  sphere, whose UVs run `v = acos(y)/PI` down from the zenith. A sky painted top-down
  and then flipped puts its stars, band and halo under the map and leaves the visible
  half showing the fog colour the gradient ends on. It does not look upside down; it
  looks like there is no sky at all, with a moon still correctly placed because the
  disc is geometry, not paint.
- **Cloud masks are 3D noise sampled along each texel's own direction.** An equirect
  image stretches by `1/sin(latitude)`, so a 2D field smears into bands as it climbs
  and pinches at the pole; a tileable 3D lattice has no seam and no pole. The field is
  also **normalised to its own range before it is thresholded** — summed value noise
  clusters around 0.5, so a raw fBm against a 0.5 threshold produces haze, not cloud.
- **The moonlit silver is a second, additive shell with a static per-vertex alpha
  mask**, not a bright patch in the mask texture. The texture scrolls and the moon does
  not; baking the lit side in would drag the highlight across the sky.
- **Stars live or die on dome resolution.** 360 degrees of texture against ~50 of
  screen is a hard magnification, so a dot much over a pixel arrives as a bokeh ball —
  hence a 4096x2048 dome and `starMaxSize` ~1.6. The same magnification is why
  `cloudSoftness` is wide: bilinear magnification of a *hard* alpha contour comes out as
  straight-edged wedges, torn paper rather than cloud.
- **The dome wraps, so anything painted near its edge must be painted twice**
  (`acrossSeam`). The left and right edges are the same piece of sky, a canvas clips
  instead of wrapping, and the widest mark on the dome is the moon's halo — wider, at
  these settings, than the moon's own distance from the wrap column. Miss this and you
  get a bright gradient ending in a straight vertical line down the sky. `wrapU =
  WRAP_ADDRESSMODE` is also required (Babylon's `DynamicTexture` defaults BOTH axes to
  CLAMP) but only fixes the filtering: the seam that shows is in the paint. `v` stays
  clamped — it runs pole to pole and has nothing to meet.

`Game.applySky()` no-ops when the environment object is unchanged. The map is
rebuilt every round; the sky is not, and repainting 8 megapixels of dome plus two
noise masks for an unchanged sky is pure cost.

`GodRays` (`src/shaders/GodRays.ts`) adds the shafts in screen space: march each
pixel back toward the moon's projected position and accumulate what is bright along
the way, so anything dark between the camera and the moon leaves a beam-shaped hole.
There is no occlusion render pass — the substitute-material trick Babylon's
`VolumetricLightScatteringPostProcess` uses does not fit the cel materials — so **the
luminance threshold IS the occlusion test**, and it has to sit above the brightest
non-sky thing in the frame. That is the wet cobbled street (~0.67 looking along the
moon); below it the road smears upward and the frame fills with ground haze.

**The pass is DETACHED whenever the moon is behind the camera or off the side of the
screen**, which is most of a round (22 of 24 bearings on a level sweep). Its shader
early-outs too, but an early-out only skips the sample loop: an attached pass still
reads and writes the whole frame. `Game` owns the attachment (`syncGodRays`) and the
pass's FIRST attach as well, because Babylon's `detachPostProcess` nulls the slot
rather than removing it while `attachPostProcess` appends — so a pass that attached
itself would have no way to name the hole it came out of, and every cycle would leave
another one in a list walked every frame.

### The installable app

The build installs to a home screen and launches fullscreen, landscape and offline.
Four files carry it: `public/manifest.webmanifest`, `public/icons/`,
`src/pwa/register.ts` and `src/pwa/sw.js`. Nothing in the game knows any of this
exists — `Game`'s one line is the fullscreen gesture.

**`public/` is the one place a URL is written by hand.** Vite copies it to `dist/`
unhashed, which is the point: a manifest names its icons, `index.html` names the
manifest, and a home screen keeps the `start_url` it installed with, so those paths
are a contract with something outside the build. The icons are generated and
*committed* (`npm run icons` → `scripts/generate-icons.mjs`, a zero-dependency PNG
encoder), so nothing at build time depends on a script having been run.

**The service worker is a template, not a module.** `src/pwa/sw.js` is never
imported and never typechecked; `vite.config.ts`'s `serviceWorker()` plugin reads it
in `writeBundle`, substitutes the whole `const PRECACHE = __PRECACHE__;` line for the
manifest of what was actually written to `dist/`, and emits `dist/sw.js`.

- **The version hashes every file's NAME AND CONTENTS.** Hashing names alone looks
  sufficient because Vite content-hashes asset filenames — but `index.html` is unhashed,
  and a byte-identical worker is one the browser never updates, so anything that
  changes only unhashed output would be served from cache forever. `index.html` still
  carries the head, the manifest link and the meta tags, and the next thing to live only
  there will not announce itself.
- **The substitution anchors on the declaration, not on the placeholder.** The file's
  header comment names `__PRECACHE__` twice; a plain string replace puts the manifest in
  the prose and leaves the code undefined.
- **`sw.js` must be served `no-cache`** (`docker/nginx.conf`). It is the update
  mechanism: a cached copy is a client that can never learn a new build exists.
- **Caching is cache-first over that precache**, because the bundle is a few
  megabytes of Babylon and every byte is needed before the first frame. The cost is that
  a returning player gets the previous build and the new one installs behind them, so a
  deploy takes effect on the launch *after* next.

Registration happens in `main.ts` **before** the `Game` is constructed and is
`import.meta.env.PROD`-gated: it must survive a Game that throws on a machine
without WebGL2, and a worker caching a dev server's module graph would be actively
harmful.

Details about the phone, each of which was a visible bug first:

- **Fullscreen is taken on `document.documentElement`, never on the canvas.** A
  fullscreen element is the only thing drawn and the HUD is a `<div>` *sibling* of the
  canvas, so fullscreening the canvas plays the game with no tickets, no flags, no
  crosshair and no deploy map. It is gated on a coarse pointer: an installed app is
  already fullscreen from the manifest, and on the desktop the pointer lock does the
  immersing.
- **A touch is felt nowhere in `InputManager`, and every screen a phone meets
  carries its own button** — the menu's and the round-over card's Deploy, the deploy
  screen's map and `#deploy-go`, the kit screen's — each listening for its own
  `pointerdown`, which a finger raises like any other pointer. A tap used to be
  latched into `confirmPressed` (the masks are held state and a tap has no hold) so
  that the title screen could be got past at all; that latch deployed the player off
  the menu's map and difficulty rows on the way, and went with the mouse.
- **`--ov-scale` scales `#overlay` and `#deploy` on short viewports** by growing the
  box to `100%/s` and scaling by `s` about the top-left, so the backdrop stays
  full-bleed and the desktop (s = 1) is untouched. Nothing in this HUD scrolls, and a
  landscape phone is ~350px tall against screens authored for 720p. **`#loadout` is
  deliberately excluded**: its stage is a hole the 3D turntable is placed through,
  back-projected from the same viewport fractions the CSS uses, so a transform would
  move the hole and leave the weapon behind it — which is also why it is the one screen
  carrying a short-viewport media query of its own.
- **Inside a scaled box, `vh` and `vw` are still the VIEWPORT's**, so a length written
  in them is scaled a second time on the way out. `#deploy`'s map is `calc(min(56vh,
  60vw) / var(--ov-scale))` for exactly that reason: at s = 0.45 the raw form rendered
  the map at a quarter of the height it asked for, and the divide is the identity on
  every desktop.

There are **no touch controls** — every input is keyboard, mouse or gamepad, so a
phone plays this with a pad paired to it. Menus and the deploy map take a tap;
nothing in a round does.

### Procedural models

`RifleModel.buildRifle()` merges its ~150 static parts into one mesh per colour
(BODY/POLYMER/METAL/RUBBER) — that merge is what makes the outline pass draw one
border per colour group instead of a black shell around every screw, and it is what
makes detail nearly free: four draws however many boxes go in. A colour missing from
`SECTIONS` is silently never merged, so anything `collect()` takes has to be listed
there. The merge works only because the root is still at identity while building.

**Nothing in the rifle may be scaled non-uniformly.** `VertexData.transform`
transforms normals *without* re-normalising them, and `renderOutline` extrudes each
vertex along its own normal — so a squashed part grows an ink shell that is fat on
the squashed axis. This is why the round shells (the optic housing, the muzzle cage)
are built by `shell()`, a ring of slabs each turned to its own facet, rather than by
stretching a torus. The primitives offer nothing else that would do: a capped
cylinder has no bore, and an uncapped one is a single-sided shell whose far wall
disappears exactly when you look through it. Facets cost nothing visually — the cel
shader flat-shades from screen-space derivatives. `ViewModel`'s arms follow the same
rule, with the wrinkle `mergeByMaterial` documents: a colour group of **one** mesh
has to be baked by hand (`bakeCurrentTransformIntoVertices`), and because that call
resets the local matrix, the part must be detached with `setParent(null)` first or
the aim node's transform is applied twice.

## Conventions

- **All tunables live in `src/config.ts`** (`CONFIG`, `as const`). No gameplay magic
  numbers elsewhere — art/geometry constants stay in their model file.
- `CONFIG` is `as const`, so a field like `bots.engageRange` has a *literal* type.
  `let x = CONFIG.bots.engageRange` then reassigning it fails to compile — annotate
  `let x: number` instead.
- Smoothing is normally the frame-lerp idiom `Math.min(1, dt * rate)`. Recoil decay
  in `CameraSystem` deliberately uses true `Math.exp(-rate * dt)`, because it moves
  where bullets go and burst climb must not vary with frame rate.
- Recoil only partly springs back: `CONFIG.recoil.recoverFraction` (0.7) returns 70%
  and pushes 30% permanently into the player's own `pitch`/`yaw`, so a magazine held
  down genuinely walks off target. An explicit product decision — a fully-recovering
  version was rejected.
- **Every ROUND is hitscan** — player and bots share `CombatSystem.fire()`, which
  takes the shooter's target list (so friendly fire is excluded by construction rather
  than by a team check inside) and the shooter's own `range`, which bounds the wall pick
  and the near-miss sweep as well as the damage. Tracers and sparks are pooled; add
  effects to a pool rather than allocating per shot. The grenade is the one deliberate
  exception.
- TypeScript is strict with `noUnusedLocals`/`noUnusedParameters` — the typecheck
  fails on dead variables.
- `Bot` holds a small FSM and drives a joint rig built by `SoldierModel` (invisible
  root + `TransformNode` joints). Animation is procedural, so a new behavior means new
  FSM states, never new clips.

## Files not to edit / not part of the build

- `dist/` — build output (gitignored); regenerate with `npm run build`.
- `node_modules/` — gitignored.
- `specs/game_design.md` — describes the original roguelike prototype; historical,
  **not a live contract**.
- `undefined/` — tracked stray screenshot output from a script with a bad path.
