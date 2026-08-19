# Bots: navigation, scaling, perception and squads

The nav graph and its silent caps, the three things carrying the frame budget,
what a bot notices without a ray, and how squads choose. Split out of
[`CLAUDE.md`](../CLAUDE.md), which keeps the summary; this file is the contract
for `NavGrid`, `ObstacleField`, `CoverMap`, `Bot` and `BattleSystem`.

## Navigation

`NavGrid` is built from the finished collider set at map load. The graph node is a
**surface** — a (cell, height) pair — not a cell, because one cell can hold the creek
floor and the bridge deck above it, or the barn floor and its hayloft.
The cap is `CONFIG.nav.maxSurfaces` (3) unless the map raises it
(`MapLayout.surfaces`) — Coldharbour, whose buildings have three walked floors
in them, states 4.

**The cap fails SILENTLY, and anything stacked has to be built
around it whatever the number is.** `addSurface` returns when the list is full,
so the next candidate in
a cell is discarded with nothing thrown and nothing to see. Terrain always takes one
slot, which leaves two at the default.

**The discard is in ARRIVAL order, not by height, and that is the lever.**
`addSurface` inserts sorted but refuses once the count is reached, so which
surfaces a crowded cell keeps is decided by the order the BUILDER pushed its
colliders — which makes emission order part of a builder's design rather than an
implementation detail. The rule is: **walked surfaces first, cover and parapets
next, roofs last.** `kit/manor.ts` states it for one building ("Roofs are emitted
LAST"); `kit/city.ts` generalises it, because a three-storey office stacks a
ground floor, two slabs, two window spandrels, three wall heads and a roof into
one perimeter column — nine candidates for four slots. Measured on Coldharbour
with a route probe from both home spawns: with that order, even the default 3
keeps every walked storey reachable, and it is the spandrels and the roof that
fall off the end. Get the order wrong instead and a floor leaves the graph with
the slab still drawn, the stair still climbable and nothing in the console. A stepped structure built the obvious way — nested solid
colliders, one per tier — spends a slot per tier in the cells at its centre and
therefore loses its TOP tier, the one thing anyone climbs it for. The fix is that
**each tier's collider is only the RING of tread it actually exposes**, so a cell
centre falls inside exactly one: `topFaceHeight` returns null outside a box's own
XZ footprint and `rasterize` skips on null. The visuals stay nested solid boxes,
which is also what satisfies the thick-box rule. `buildTempleRuin` in
`kit/structures.ts` is the worked example and carries the per-cell budget as a
table; `buildStiltHut` is the other end of it, sitting at exactly three (terrain,
platform, roof block) and forbidding a second floor slab in its header.

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

**That barrier test is evaluated from the top-face PLANE at the crossing, which is
what lets a PITCHED box through the same gate as an upright one** — and it must,
because "pitched" does not mean "ramp". A ramp spares itself: its slab at the
crossing is within a step of the surfaces at either end of a link running up it,
exactly as the terrace's top face is, and its underside spares the ground beneath
it by `HEADROOM`. A stair's *parapet* is pitched too, only because it rails a
pitched flight, and it stands a metre over the treads — so it severs, as it should.
`severLinks` used to skip every `rotX !== 0` box outright on the reasoning that
ramps are surfaces rather than barriers, and the manor's grand stair is what that
cost: the parapet severed nothing, so the graph offered diagonal links straight
*through* the handrail, every flow field preferred that shortcut to the flight's own
foot, and `ObstacleField` — which reads the same box correctly — pushed each bot
back out. Measured on Greyfen, a bot climbing from the great hall took **9.7 s with
four watchdog detours and ~3 s of grinding against the rail, against 4.6 s and none
once the link is cut**; the stuck watchdog is the only reason it was slow rather
than stranded. Severing them changes no connectivity anywhere — walkable surface
count and all seven flow fields' reach are identical on both maps — because a rail
only ever cut the shortcut, never the route. `segmentHitsBox` answers for pitched
boxes for the same reason: a footprint test says where a box *is*, and whether it is
a barrier belongs to the caller. `CoverMap` still skips them, for a reason of its
own that its comment carries.

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

## Bot scaling

Three things carry the frame budget; undoing any costs ~10× draw calls or a
permanent hitch:

- **The rig pool is built once and never disposed.** Death hides a rig, respawn
  re-poses it. `new Bot()` allocates a dozen meshes and their GL buffers, and Conquest
  respawns continuously.
- **Bot rigs are nineteen merged meshes** (`SoldierModel`) — forty-odd boxes
  merged one mesh per colour per segment. The outline pass draws everything
  twice, so fidelity is ~2× draw calls per bot per mesh, and **what a rig costs
  is COLOURS PER SEGMENT rather than boxes**: a pouch, a kneepad or an antenna
  in a colour that segment already carries is free, while a fifth colour on the
  torso is 32 draw calls across a full roster. The one mesh this rig spends on
  looks alone is the helmet band, because the head is what clears cover first.
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

## Bot perception, cover and skill

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
  sphere test at `hitRadius + suppressRadius`, reported via `onNearMiss`. It carries
  the round's point of closest approach as well, which is the same event the
  player's suppression and their directional crack are built on — the player is
  suppressed by exactly the thing that suppresses everyone else.
- **Lost line of sight costs no ray either** — `fire()` already pays for a wall pick,
  and a run of `losBrokenShots` blocked rounds drops the target.

**A bot's round falls off with range, and bots have no head zone.** Both are
deliberate and they pull in opposite directions, so read them together.

Bots carry no weapon from `CONFIG.weapons` — they fire one flat round — so
`bots.damageFar`/`falloffNear`/`falloffFar` are the whole of their damage curve.
It is fitted to the band they actually shoot in rather than to `range`: they
will not open fire past `engageRange` (55) and back off inside `minEngageRange`
(6), so a ramp ending at 70 would spend most of itself where nothing is ever
fired. 25 falling to 17 over 18 → 50 m makes them a four-shot kill inside 18 m,
five to 38, and six beyond. **This is a real difficulty reduction and the main
thing to feel-test**; it is also the point, since sixteen bots hitting for 25 at
any distance mean a crossed square is a coin toss no movement can improve.
`bots.damageFar: 25` restores the old behaviour exactly.

The head zone runs the other way, and its absence here is load-bearing rather
than an omission — see [`weapons.md`](weapons.md). Bots aim at `t.eyePos`, the
very point the zone is centred on, so a head sphere their rounds could reach
would make every accurate bot shot a headshot. Because the gate is
`ShotOptions.headMult` and they pass none, the sphere is never even ray-tested
on their path: sixteen shooters pay nothing for a feature they do not have.

**Cover is baked, never probed** (`world/CoverMap.ts`): one bit per direction per
surface, 16 directions, two masks — the same reasoning that makes `NavGrid` bake seven
flow fields. A cover query costs a bit test.

- **Hard cover is 1.7 m — the hit sphere's top, not the 1.55 m eye height.** LOS is
  tested from the eyes but hits are tested against the sphere (`center.y + hitRadius`
  = 1.65). Bake at eye height and a bot behind a 1.6 m wall is *visible but
  unhittable*, which reads as broken netcode.
- **Soft cover (0.9 m) is a steering preference and nothing else.** The rig grew knees
  and ankles for a remote human's stance, but nothing in the AI passes a crouch, so a
  bot never bends them: a bot behind a waist-high wall is exactly as shootable as one
  in the open. **Cover here means corners.**
- **A `porous` box is neither mask, and a `strut` is in no mask at all.** The
  bake skips the porous box outright: rounds go through it (that is what the
  flag means), so it cannot be hard cover for the reason above — and it cannot
  be soft either, because soft exists to steer bots toward walls and away from
  open ground, and a fence line *is* open ground with a rail across it. The
  timber that DOES stop rounds is `rayOnly` and emits no `WorldBox`, so it never
  reaches this bake either, which is right: a 0.18 m post is a thing a round
  hits, not a thing a body hides behind. The same split is why a bot's LOS runs
  across a fence — `BattleSystem` filters `OPAQUE_ONLY`, so a bot sees exactly
  as far as its rounds reach, timber included.
- **It is a preference, not a commitment** — the same rule as `ObstacleField`'s
  push-out. A spot not reached within `cover.abandonTime` is dropped, and a cooldown
  stops the search instantly re-picking it. A bot moving to cover still shoots; only
  the tucked-in half of the peek cycle holds fire. Without both, bots walked into walls
  holding fire for the whole round.

## Squads and movement texture

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
