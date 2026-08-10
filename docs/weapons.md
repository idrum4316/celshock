# Weapons, the viewmodel and the loadout

How the first-person camera, the gun on it, the two weapon slots and the five
optics fit together, plus the procedural model rules they are built under. Split
out of [`CLAUDE.md`](../CLAUDE.md), which keeps the summary; this file is the
contract. Read it before touching `ViewModel`, `Player`'s carry/aim path,
`optics.ts` or any weapon model.

## First person, and the weapon on the camera

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

## The loadout: four weapons, five optics, and a sidearm

Two tables, two slots, neither knowing about the other. `CONFIG.weapons` declares
what can be carried and `CONFIG.sights` what can be bolted to it;
`entities/weapons.ts` and `entities/sights.ts` derive `WeaponId`/`SightId` **from
those tables**, so each is declared in exactly one place. Every weapon *with a
rail* takes every optic; the sidearm has no rail.

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

**The carbine is the third question the trigger can be asked, and `semiAuto` and
`burst` are why there are three.** `semiAuto` asks whether the trigger has to come
UP between pulls; `burst` asks what one pull SPENDS. The rifle and the SMG answer
neither, the DMR and the pistol answer only the first, and the carbine answers both
— nothing may answer `burst` alone, because a burst weapon firing on a held trigger
is an automatic with a stutter in it. Its three rounds at 34 are 102 against 100 HP
and leave in 0.1 s, the best ideal time to kill in the game by a factor of three,
and the whole of the price is `burstCycle`: 0.4 s in which the weapon will not
fire, spent identically whether the burst killed, missed, or landed two of three.
That is the error budget again in its harshest form — a missed rifle round costs
0.125 s and a wasted carbine burst costs half a second — and it is what keeps the
sustained figure (6 rounds/s, 204 dps) the worst of the three automatics.

**A burst in flight is the one thing that fires with the trigger up, and that is
what makes it a mode rather than three fast rounds.** `Player.burstLeft` is the
whole of it: the pull spent all three, so the remainder leaves on the weapon's
clock and the release cannot stop it — a burst that stopped when the finger came
up would stop mid-burst on every tap, which is not something a player could aim.
Two rules keep it honest. The `fireCooldown` test comes FIRST, before the guards,
because mid-burst that cooldown is the gap between rounds rather than a refusal.
And the guards then ABANDON what is owed rather than banking it: a reload, a
sprint, a swap, an empty magazine or a death drops the remainder on the floor,
because a burst that resumed after any of them would fire seconds later out of a
weapon the player has since reloaded, holstered or died holding. `fullReset` clears
it for the one case the guards cannot see — `dying` stops `tryShot` being called at
all, so a body killed mid-burst would otherwise owe rounds to the next life.

**The DMR steps outside that too, and `semiAuto` is why it can.** Two rounds at 3/s is
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
does not fire the instant the reload ends. It belongs to the FINGER, which is why a
swap keeps it (a trigger held across one still needs releasing) while the burst,
which belongs to the weapon, goes with the weapon.

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
shallow receiver and the DMR's deeper one carry the same five sights with nothing
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

**The carbine is that constraint answered by the layout rather than paid for.** A
bullpup keeps nothing above the rail forward of the mount — no gas block standing
proud, no folding leaf on the end of a long rail — so the cone would carry a folded
front iron out past z = 0.5, and what stops the station short is the rail itself
ending at the gas block because the barrel is exposed from there on. The rear
station is where it wins: the receiver runs to the butt pad, so the aperture sits at
-0.28 where the rifle's stops at -0.185 and there is still stock behind it. 0.60 of
sight radius out of a weapon 0.96 long, against the rifle's 0.715 out of 1.25 — the
same trade the layout makes everywhere else on it.

**Read from the optic's side, that is one constraint and `RAIL_REACH` is it: how
high a sight is carried and how wide its picture is are ONE decision, not two.**
A view cone spreads with distance and the longest rail here (the DMR's, to
z = 0.57) is what it runs onto, so a new optic gets `rise >= cone * (eyeDistance
+ RAIL_REACH - its ocular offset)` and no freedom left over — the reflex's window
HEIGHT and the prism's `PRISM_CONE` are both that inequality solved rather than
authored, which is what stops them going quietly wrong the next time a rise or an
eye relief moves. What is left over is the daylight under the picture, and it is a
named constant either way. The width of a window is free (nothing on a weapon
stands out sideways) and the irons are exempt: what you see under the post through
an aperture is meant to be the weapon.

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

### The sidearm

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
  the [grenade throw](grenades.md): `Player.swapT` counts up, the pose is a TRIANGLE that takes the
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

## Procedural models

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
