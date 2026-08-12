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

## The reload is a gesture with a magazine in it

Every fraction below is a share of `CONFIG.weapons[id].reloadTime`, laid out in
`CONFIG.viewmodel.reload`, so one timeline carries a 1.05 s sidearm and a 3.4 s
machine gun without a per-weapon number anywhere.

- **It is a TIMELINE, not a pose.** `reloadBlend` is only the gate — what eases
  the weapon back out when a swap or a death cancels one — and `reloadPhase` is
  the gesture. The weapon tips out of the carry over `tiltIn`, holds while the
  magazine is changed under it, and is level again by `tiltOut`'s end, which is
  before the magazine refills: a weapon still coming level on the frame the
  round is available is a reload that lied about when it ended.
- **The beats are `Sfx.reload`'s clacks and must move with them.** That sound is
  four metallic events — catch, magazine out, magazine seated, bolt — and
  `magOut`/`magSeat`/`bolt` are three of them to the frame. What makes the
  gesture legible is that what you see lands on what you hear; a magazine that
  falls half a beat off the clack releasing it is two unrelated things happening
  at once. **Change a fraction in one file and change it in the other.**
- **The magazine is the one part of a weapon that moves on its own**, and it can
  only move because the model merged it into a node of its own
  (`WeaponParts.magazine`, a second `merge` call exactly like an optic's).
  Everything else on a weapon is inside one merged mesh per colour and cannot be
  animated at all without the same split. It leaves along `magDrop` — the
  weapon's own rake, from `magDropAxis`, because a magazine sliding straight
  down out of a raked well shears through the front of it.
- **The old one FALLS and the new one is DRIVEN**, and the two easings say so:
  the drop accelerates (nothing has a hand on it) and clears the frame entirely,
  while the insert's distance-to-go falls as `1 - x²` so the magazine is at its
  fastest on the frame it arrives. The clear is what lets one node stand in for
  two magazines — what comes back is read as a fresh one because it was never
  seen to be the same one.
- **The hand carries it by construction, not by matching keys.** From
  `insertFrom` the support hand rides exactly the travel the magazine rides;
  before that they part company on purpose, because a hand chasing a falling
  magazine down reads as having dropped it.
- **The seat and the bolt are IMPULSES, not poses** — instant attack, squared
  decay, the same shape as the per-shot kick, because they are the same kind of
  event. In the pose stack as blends they would be two more places the weapon
  leans and neither would land on its sound.
- **The magazine keys off `reloading`, never off the eased blend.** It has two
  places to be and no way to be between them, so a cancelled reload puts it back
  in the weapon rather than lerping it home through the receiver.
  `ViewModel.stow()` is the only place that state is cleared and all three ways
  out of a half-finished reload — a swap, a round starting, the kit screen
  coming up over one — go through it, or the weapon comes back without a
  magazine in it.
- **`Player.reloadPhase` freezes where a cancelled reload left it** rather than
  resetting to 1. The pose is played off the phase and eased out by the blend,
  so a phase that snapped to the end underneath a blend still at 1 would take
  the pose off in a single frame.
- **The pose is a CANT, not a lift.** A rifle is not hoisted in front of the
  face to change a magazine, so `reloadPos` barely moves — the weapon stays near
  carry height, pulled in a little — and the roll is what brings the magwell
  where the eye can find it. Two passes got this wrong from opposite ends. The
  original *dipped* the weapon, which played the whole magazine change below the
  bottom edge of a frame the magwell was already hanging out of. The fix over-
  corrected and raised it far enough to frame the magazine dead centre, which
  looked staged at the hip and put a receiver across the middle of the screen on
  an aimed reload.
- **`reloadRot.z` must be negative.** A positive roll takes the right flank up
  and swings the underside out to the right, away from a camera sitting to the
  LEFT of a weapon carried at `hipPos.x`: the magwell is presented to nobody and
  the weapon reads as held out at an angle rather than worked on. Negative rolls
  the underside toward the camera and carries the magwell inboard, which is both
  where the support hand comes from and the way a right-handed shooter actually
  cants a rifle to change magazines. `seatKick`/`boltKick` roll *against* that
  cant — a magazine driven home knocks the cant out — and flip with it.
- **A reload BREAKS THE AIM (`reload.aimBreak`), and that is geometry as much as
  realism.** Nobody changes a magazine through their optic, and an aimed weapon
  is *on the camera axis*, so a reload pose applied there swings the receiver
  across the middle of the screen whichever way it moves. The gesture's weight
  scales the hip→ADS blend back down, so the aimed reload is the hip reload, off
  to the side where it belongs, and the sight is back on the axis by the end of
  `tiltOut` — before the round it is loading can be fired. It is not a full 1: a
  little aim is left in so the weapon settles back from near the sight instead of
  swinging up from the hip on the last beat, which also keeps a scoped weapon
  from being flung out of a narrow FOV and back into it.
- Measured at 1280x720 through the hold: the magwell and the top third of a
  seated rifle magazine sit inside the bottom of the frame (roughly y 600–720),
  the magazine leaves through that edge, and the aimed reload keeps the whole
  middle of the screen clear.

## The loadout: five weapons, five optics, and a sidearm

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

**The player's own look-speed setting multiplies the CONFIG rates and nothing
else** (`CameraSystem.setLookScale`, one multiplier per device, fed from
`Settings.mouseSensitivity`/`stickSensitivity` by `Game.applySettings`). That is
the whole of its reach, and it is deliberate: the ADS multipliers, the optic's
magnification and the aim assist's bound are all expressed *against* those rates,
so scaling at the source moves the three together and none of them has to know
the setting exists. **The one place it has to be written out is
`CameraSystem.stickYawRate`**, because that getter is not a rate the camera uses
— it is the rate the aim assist bounds itself as a fraction of, and a player who
has halved their stick speed has halved what "the player always out-turns the
assist" is measured against.

## Recoil has a shape, and the shape is learnable

Two terms make the difference between recoil you fight and recoil you learn, and
neither is a weapon's own number scaled.

**`recoil.firstShotMult` (1.6) is what makes a burst have a punch and a settle
rather than a flat ramp.** A weapon that has been sitting still and one that is
mid-string are not the same weapon; without this they were, because shot 1 and
shot 20 kicked identically. It is also what makes a tap distinct from a held
trigger, which is the entire reason to tap. `Player` owns the string counter,
beside `spreadBloom` and with exactly its lifecycle — raised by a shot, bled off
by `stringResetTime` (0.35 s), and dropped by anything that takes the weapon
away. **The string belongs to the WEAPON, not to the finger**, the same split
`burstLeft` and `triggerHeld` already draw, so `completeSwap` clears it
explicitly: the sidearm's `drawTime` of 0.34 s is a hundredth of a second inside
the window, and without that line the pistol's first round would inherit the
rifle's settled kick.

**It does not apply to a weapon that is a string of one**, and the exclusion is
the feature rather than an exception to it. `Player.recoilRamp` returns 1 when
`semiAuto && burst === 1`, which is the DMR and the pistol: every shot there is
a first shot, so the multiplier would not be texture at all — just a flat 60%
recoil increase wearing feel's clothing, and on the DMR's 2.2 that is 5.2° on
every deliberate scoped round. Their `recoilMult` already carries the punch a
single shot is supposed to have. The carbine is `semiAuto` too and is
deliberately **included**, because `burst > 1` means one pull is three rounds
climbing as one motion, which is exactly the thing that has a first round in it;
`burstCycle` 0.4 s exceeds the reset window, so every burst gets the punch.

**Per-weapon `yawBias` (−1..+1) is what makes the horizontal learnable at all.**
It used to be symmetric noise, and the only correct response to a random walk is
to stop firing — so every weapon's spray was the same shape at a different rate.
The bias makes the walk drift. It **scales** the noise rather than adding to it
(`(rand * (1 − |bias|) + bias) * yawPerShot`), so the total is still bounded by
`yawPerShot` and every ceiling documented for `maxYaw` survives untouched; 0 is
bit-for-bit the old behaviour, which is what the DMR is.

The magnitudes track how legible a single kick is. The SMG's **+0.6** is the
strongest because 13 rounds a second on the smallest per-shot kick is otherwise
indistinguishable from noise — only a consistent drift is readable at that rate.
The carbine's **−0.5** is strong because three rounds in 0.1 s cannot be steered,
only pre-aimed. The LMG's **−0.25** is the gentlest for the same reason its
`recoilMult` is: seventy-five rounds of a hard pull ends up pointing at a wall.

**The signs are paired, not scattered.** Rifle, SMG and pistol pull right;
carbine and LMG pull left. So a rifle-plus-sidearm loadout is one hand to learn
across the swap, and the other family is a genuinely different weapon rather
than the same one at a different rate — the thing the kit screen's stat chart is
trying to say, said in the hands instead.

A weapon's numbers scale `CONFIG.recoil` rather than restating it: `recoilMult` and
`bloomMult` SCALE the per-shot terms, because the shape of recoil belongs to the
game. `bloomMult` multiplies the *ceiling* as well as the per-shot term — a weapon
that blooms faster has to be allowed to bloom further, or the extra rounds per
second cost it nothing after the second shot.

The three automatics are balanced on time to kill, not damage per second: 4 rifle
rounds at 8/s is 0.375 s, 6 SMG rounds at 13/s is 0.385 s, 5 LMG rounds at 10/s is
0.4 s. The choice buys how much of the screen a burst covers, how far away it still
means anything, and how long you may go on firing it.

**Every one of those figures is the CLOSE one, and that is a change of meaning
rather than a caveat.** A weapon's `damage` is what a round does at or inside
`falloffNear`; past `falloffFar` it does `damageFar`, and between the two it
lerps against the distance the round actually flew. `range` is untouched and
still the hard reach — but a round that has stopped hurting is a more
interesting fact than a round that has stopped existing, so the ramp lives well
inside it and `range` is no longer the interesting end of the weapon.

What the second column buys is that the kit can now say something it could not:
the DMR alone is exempt, the LMG loses damage per second and never a round, the
carbine's burst stops being a kill at a stated distance, and the SMG falls off
hardest and earliest. Two rewards and two bills, which is the same balance the
close figures strike.

- **The rifle** is 4 rounds to **53.1 m** and 5 beyond it — 0.375 s becoming
  0.5 s at a boundary that sits inside the 78 m fog wall, so it is a distance a
  player can actually learn.
- **The LMG's 24 → 21 crosses no round boundary at all** (21 × 5 = 105). Five
  hits kill at 85 m exactly as they do at 5, and only the sustained figure moves
  (240 → 210). That is the same reward `bloomMult` 0.5 is, on a third axis.
- **The DMR has no fall-off**, and the exemption *is* the weapon: "two shots,
  whatever the range" is the sentence its entry opens with. It is stated as
  `damageFar` equal to `damage` rather than as an absent field, so every weapon
  carries the same three numbers and the lerp needs no special case — the same
  argument `floorSurfaces.ts` makes for `flat` being a real member of its list.
- **The sidearm and the bots' round sit on a knife edge**, and it is worth
  knowing about: 25 × 4 is exactly 100, so there is no headroom and the first
  centimetre past `falloffNear` costs a whole round. Anything that moves either
  `damage` off 25 moves a boundary by tens of metres.

**Fall-off on the carbine quantises, and that is the one place these numbers are
placed rather than chosen.** Every other weapon degrades a round at a time; the
carbine has all three rounds cross the threshold together, so a burst kills
while the round makes 33.4 and does not the moment it does not — 0.1 s to kill
becoming 0.5 s, a 5x cliff crossed in one step. The drop from 34 to 33.4 is 8%
of the ramp's fall, so **the breakpoint sits just past `falloffNear` almost
regardless of `falloffFar`**: moving `falloffNear` is how you move the cliff and
`damageFar` barely touches it. It is at **39.6 m**, which is where the weapon's
own entry already says it runs out. An earlier version ran 20 → 55 and put the
cliff at 22.9 m while claiming 55 in its own comment, so: **quote the breakpoint
when any of those three move, never `falloffFar`, and re-derive it rather than
assuming it followed.**

## The head zone

A round inside `CONFIG.combat.headRadius` (0.22 m) of the target's `eyePos` is
worth `headshotMult` (2). The rifle and the pistol kill in two, the SMG in
three, the LMG in three, and **the DMR kills in one at any range** — the only
one-shot kill in the game, and the reward its `semiAuto`, its 2.2 recoil
multiplier and its exemption from fall-off have all been asking for. It costs a
scope, a 3/s ceiling and a 22 cm target.

Three things about it are structural rather than tuning:

- **It is the PLAYER's, by construction rather than by a check.** Bots aim at
  `t.eyePos` — the point the zone is centred on — so a head sphere their rounds
  could reach would make every accurate bot shot a headshot and halve a tuned
  bot TTK overnight. `ShotOptions.headMult` is what turns it on; only
  `Player.shotOptions` sets it, and at 1 or absent the sphere is **never
  ray-tested**, so the sixteen shooters without the feature pay nothing for one.
  A friendly-fire or PvP mode would need one field changed and nothing added.
- **It is an upgrade to a body hit, never a candidate of its own.** `center` +
  `hitRadius` 0.75 already encloses the head, so a head sphere entered the
  nearest-hit search only to lose it; testing it after the body hit resolves
  costs one sphere per round that LANDED rather than one per target per shot,
  and it cannot create a hit that the body sphere did not already register. The
  ~12 cm of crown standing above that sphere stays unhittable exactly as it was
  — reaching it would be a change to every bot's silhouette smuggled in under a
  player feature.
- **Fall-off applies first.** A headshot at 100 m with the rifle is 44, not 60.
  The head multiplies what the round did, and what the round did is a function
  of how far it flew.

It works under crouch for free: `center` and `eyePos` ride the one blend, so a
crouching player's head comes down with the rest of them.

Feedback is split deliberately. `HUD.flashHitmarker` lets a **kill outrank a
head hit** on screen, because of the two things the marker can say, "this one is
going down" is the one that changes what you do next — and the two would
otherwise fight over the same four ticks. The ding (`Sfx.headshot`) plays
regardless, and that is where the read actually lands: it is two sines with no
noise in it at all, precisely so it cuts through a burst of ordinary markers
instead of merging into them.

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
sustained figure (6 rounds/s, 204 dps) the worst of the four automatics.

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

**The LMG is the third weapon you simply hold the trigger down on, and the only
one here that does not have to stop; every other number on it is the price of
that.** Seventy-five rounds is
fifteen kills and seven and a half seconds of fire; the rifle's twenty-four is six
kills and three seconds. What makes that affordable is that the ARITHMETIC is a
wash and only the timing differs: 24 damage at 10/s is 240 a second, exactly the
rifle's 30 at 8/s, and the duty cycle matches to within a percent (3.0 s of fire
against 1.4 s of reload is 68%; 7.5 against 3.4 is 69%). Two weapons deliver the
same damage over a minute, and the one that never has to stop in the middle of a
fight is choosing WHEN, not how much — which is worth exactly as much as the fight
in the middle of the rifle's reload was going to cost.

The bill is the two things it cannot do, and both are the worst figures in the
kit. It cannot start a fight — `adsSpeedMult` 0.55 and `drawTime` 0.95 against the
sidearm's 0.34, and a hip spread of 0.115 that makes firing it unaimed a way of
saying where you are. And it cannot recover from being caught empty: 3.4 s is more
than twice any other reload, in a game with no reserve ammunition, which is the
[sidearm](#the-sidearm)'s case made by a second weapon rather than by argument.

`bloomMult` is the one number on it that is a reward, and it is what makes the
magazine mean anything: at 0.5 the bloom ceiling is 0.015 against the rifle's
0.03, so the aimed group opens to 0.023 rad and stops, and the fortieth round of a
burst lands where the fourth did. A weapon that bloomed like the rifle would carry
seventy-five rounds and have nothing to do with the last fifty. `recoilMult` 0.7 is
the same argument on the other axis: at 10 rounds a second the rifle's own kick is
0.26 rad/s of climb, and 0.182 is the gentlest in the kit — a burst you steer
rather than one you abandon.

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
- **The flash hangs off the viewmodel but is not one of its meshes, so putting the
  weapon away has to END it rather than hide it.** `ViewModel.setVisible` walks
  `meshes` — every weapon's parts and both arms, and the throwing arm with them —
  and the flash petals are Player's, so the call does not reach them. The clock
  that retires them is `updateGunfeel`, which is inside `Player.update` and so
  stops the instant `updateGameplay` does. Nothing may fire while the weapon is
  stowed, which made this look self-managing; being stowed *part-way through* a
  flash is the case that was missing, and dying inside the 50 ms of one hung the
  star — in the viewmodel's depth-cleared group, so over everything — in the middle
  of the screen for the whole death cam. `Player.applyVisibility` zeroes `flashT`
  and disables the root whenever the body is hidden, which is the one funnel every
  caller already goes through. Anything else transient that Player parents to the
  camera owes the same.
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

**Its carry handle is the same rule from the other side, and is why that handle has
no bridge.** The model is a FAMAS, whose one unmistakable feature is a triangular
handle over the barrel with the sights in a tunnel through it — and a tunnel is
exactly what `RAIL_REACH` forbids, since nothing forward of the mount may stand
above `railTop` without sitting in the middle of the scope's picture. So the handle
is cut off at the sight line: a blade running the full depth from the barrel to the
rail's underside, with the rail as its top face, which is what the flat-top variant
of that weapon did for the same reason. What carries the silhouette instead is
everything BELOW the rail, where there is no cone to answer to — the blade and the
raked strut onto the gas block, a full-hand trigger guard drawn around the
viewmodel's own glove, and a bipod folded down the handguard's flanks.

**The LMG is the third weapon that rule has shaped, and there it took the rail
apart.** A belt-fed carries two things on top of the barrel that nothing else here
does — a folding carry handle and a front sight standing well forward — and both
are above `railTop` where a real one puts them, which is the middle of the scope's
picture. So the handle is hinged at the front and folded back down the barrel's
LEFT flank, under the sight line, and the rail is split: it runs the length of the
feed cover and stops with it, and what bridges the gap to the front iron station is
a tower standing on the barrel whose top face IS `RAIL_TOP` and no higher. That
split is also the honest read of the weapon — the barrel comes off a machine gun,
and nothing that is lifted away mid-fight may carry the optic — which is the same
bargain the carbine's handle struck: the constraint answered by the layout instead
of paid for.

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
  `Game.applyCarry` pushes the camera's fit, the HUD's caption and the HUD's stowed
  row, and all three things that change the hands — a kit pick, a swap completing, a
  fresh body coming up with the primary — reach it without remembering to.
  `applyLoadout` is the kit's own path; the deploy and kit screens keep naming the
  PRIMARY.
- **The slot that is DOWN is readable too** (`slungWeapon`/`slungSlot`/`slungAmmo`/
  `slungMagSize`), and nothing about firing depends on it: it exists so the HUD can
  say the second slot is there at all. A weapon the viewmodel never shows and the
  ammunition readout never counts is one a player can carry a whole round without
  finding, which is the sidearm's own failure mode — see [`ui.md`](ui.md).
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
(BODY/POLYMER/METAL/RUBBER/BRASS) — that merge is what makes the outline pass draw
one border per colour group instead of a black shell around every screw, and it is
what makes detail nearly free: one draw per colour however many boxes go in. A
colour missing from `SECTIONS` is silently never merged, so anything `collect()`
takes has to be listed there. The merge works only because the root is still at
identity while building.

**A merge is also how a part is let OUT of the weapon.** `merge` swaps the
accumulator, so a builder that wants a piece to move on its own builds it after
the weapon's own merge and merges it into a node of its own — which is what the
optics have always done and what the **magazine** now does. That node sits at
identity, so the merged geometry lands where it was built and its
`position`/`rotation` are pure offsets from seated. It costs one more merged mesh
per colour the magazine uses, on a rig that is disabled unless it is the carried
one. The LMG's `magazine` is its belt box **and the belt** — a belt is fed from
the box it is coiled in, so swapping the container and leaving a run of brass
hanging out of the feed would be a reload that loaded nothing — while `boxMount`
stays with the weapon, since the fresh box needs a shelf to hang from. The
pistol's is the only one built with geometry a seated magazine never shows: its
magazine is up inside the grip, so the body is there to be seen on the way out
and sized clear of the grip's walls on every face.

**A colour group is free where it is unused, which is why BRASS is one.** `merge`
skips a group with nothing in it, so the LMG's exposed belt costs the other four
weapons nothing at all — and the belt has to be its own group rather than METAL,
because brass is the one thing on a weapon that is not part of the weapon and
merged into the fittings it would come out steel-coloured and steel-glossy along
with the rails.

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
