# Deaths: the one physics engine, and the death cam

Havok's only appearance in the tree — what a ragdoll may and may not touch, why
the collapse tween stays — and the four seconds after the player is killed. Split
out of [`CLAUDE.md`](../CLAUDE.md), which keeps the summary; this file is the
contract for `RagdollSystem` and `DeathCam`.

## Deaths, and the one physics engine

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

**A crouch was a sixth refusal and is not one any more, and what bought it back is
the bone table.** A leg was ONE rigid 0.72 m bone oriented by the hip joint, which a
folded leg is nowhere near, so a body caught mid-crouch had to be refused and take
the tween — which meant the one stance a player holds while being shot at was also
the one stance that could not fall over. There was no pose that fixed it either:
straight legs under lowered hips reach through the floor, and lifting the hips to
meet them is half a metre of pop on the frame of death. So the leg became three
bones — thigh, shin and boot, hung off the same hip, knee and ankle the crouch bends
— and the proxies take whatever pose the rig is already in. Measured on a body
killed at a full crouch: the knee is thrown holding its drawn 2.58 rad fold, keeps
it through the first steps rather than being snapped straight, and the corpse settles
on its side still curled. A standing body is unchanged — every joint within 0.06 m of
the floor's height, legs straight to 0.05 rad. Three things go with it and are the
part that is easy to get wrong:

- **A joint limit must CONTAIN the pose a body can be thrown in.** The standing pose
  is the zero of all three angular axes, and the knee reaches 2.58 rad from there;
  a range that stopped short would have the solver straightening a leg on the frame
  of death, which is the pop this feature exists to remove arriving through the fix
  for it. The ankle's -1.39 rad is likewise the DRAWN crouch's and not anatomy's.
- **A bone hangs off its parent bone, not off the chest.** `BoneLink.parent` is what
  says so and the pivot is in that parent's frame. Pinning a shin to the torso
  instead holds it at a fixed offset from the ribs and lets it swing there — a corpse
  whose knee is a second hip.
- **A corpse does not collide with itself**, because a folded leg lays the shin along
  the thigh and puts the boot inside it, and a body that shoved its own limbs apart
  on the frame it was thrown is worse than one that clips. Each pooled slot owns its
  bone shapes in its own collision group (bit 0 is the world's, slot `i` takes bit
  `i + 1`) — which is also why the shapes are per slot rather than one set shared by
  every corpse: the mask lives on the SHAPE, so sharing them could only turn every
  body's self-collision off together with every corpse-against-corpse one. Two
  corpses landing on each other still collide.

The four extra bones cost nothing measurable. One harness, run either side of the
split — a whole death's 150 substeps timed end to end, median of seven trials —
gave eight falling corpses 0.279 ms/step at six bones and 0.290 at ten, inside a
trial spread of 0.24-0.42. Those absolutes do not line up with the ones
`maxConcurrent` carries below and are not meant to: different harness, different
session, and headless absolutes are inflated anyway. The PAIR is the measurement.

**The gate is the FOG WALL, and it is one number for everything that stops at it
— the MAP's number.** Three systems gate on the same distance for the same
reason (there is nothing to see past it): `BattleSystem`, where a rig stops being
drawn; `NetRoster`, the same call for a body coming off the wire; and
`death.maxDistance` here, one metre past which the solver would be tumbling
something nobody can see. `BattleSystem` wrote its own `78` out by hand before
any of this, which is how the ragdoll gate came to be keyed off an unrelated LOD.

What each of the three now holds is a FIELD that `Game.installMap` pushes
`EnvironmentSpec.fogEnd` into, and `FOG_WALL` in `config/fogWall.ts` is what they
carry before a map is installed. It used to be the answer, with a dev warning
when a map's `fogEnd` disagreed — and the disagreement is now the point:
Coldharbour has no fog wall at all, sees 480 m, and a body vanishing at 78 there
would vanish in plain sight. `config/fogWall.ts` is still its own module for the
original reason (`config/bots.ts` reads it, and taking it from `index.ts` would
be an import cycle).

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
the same run — taken on the six-bone body, and the leg split that followed did not
move it; a settled one is 0.0004 ms because the engine is not stepped at all, and
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
- **The knee and the ankle are bones and the rifle is not**, which is the same
  question answered twice: a bone is worth having where the RIG can already put the
  joint somewhere the one box could not follow. The crouch bends knees and ankles, so
  they earn one each.
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

## The death cam

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
- **It is stood up in the STANCE they died in**, off `Player.stance` — the eased
  blend, not the `crouching` intent, which would round a body a third of the way into
  a crouch up to a full one and spend half a metre of pop on the one body the camera
  is about to point at for four seconds. Two things follow the blend and they are not
  the same thing: the rig is posed by `animateSoldier`, which drops the hips and leaves
  the boots planted, and `RagdollSubject.center` comes down to `crouchCenterHeight`
  because that is where the round landed and what the throw is aimed away from. The
  ROOT does not move — the crouch lives inside the rig, so a root pulled down with it
  puts the feet through the floor. It is the same split `NetPlayer` draws for a remote
  body. The fallback tween is handed the stance too, and unfolds it on the way down.
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
