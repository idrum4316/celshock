# Multiplayer

The contract for `server/`, `src/net/`, and the parts of `Game`, `BattleSystem`
and `CombatSystem` that a networked round changes. Read it before touching any
of them.

The shape in one sentence: **a dedicated Node server runs the real simulation
under Babylon's NullEngine, clients render it, and a roster slot is a slot
whether a person or a bot is in it.**

## The three decisions everything else follows from

**The server is the authority.** Bots, flags, tickets and damage are decided in
one process that no player controls. It is not a relay and there is no host
client — matches are public, played with strangers, and an unpoliced player
would be one with a permanent advantage.

**The authority re-runs the ray.** A shooter fires locally and flashes a
hitmarker; that marker is a *guess*. The round is reported, every target is
rewound to the instant the shooter was looking at, `CombatSystem.fire` is called
again on the server, and only that result deals damage. A client's claim is a
hint, never a fact.

**Movement is client-simulated and server-validated.** Each client runs its own
`Player` exactly as it does offline and reports where it ended up; the server
rejects what is physically impossible. This was chosen over replaying inputs
because `Player.update` reads `InputManager` and `CameraSystem` directly and
mutates some forty fields, and making it a replayable pure step is a refactor of
the largest entity file in the game. The price is stated plainly below.

## What is NOT defended against

Worth being honest about, because a reader who assumes otherwise will build on
sand.

- **Aimbots.** An aimbot is unusually good input and nothing can distinguish it.
  The shot cone bounds the lie to something a real player could have aimed at,
  and that is all it does.
- **Wallhacks.** Every client is sent every body's position because it has to
  draw them. A dedicated server does not change this; only per-viewer culling
  would, and that is not built.
- **Cheating inside the movement tolerance.** Someone moving at 1.19× sprint
  forever is invisible to the validator. The margin leans deliberately toward
  letting a laggy honest player through, because a legitimate player yanked
  backwards has a worse experience than everyone has from a cheat worth 19%
  speed.

## The roster is the feature

`server/Roster.ts` holds **sixteen slots, built once, never resized or
reordered.** A slot is never created or destroyed — only who feeds it changes.

- A match starts as soon as one person is present. Every unfilled slot is a bot.
- A human joining takes the lowest-numbered bot slot on the thinner team; the
  bot there is **benched**.
- A human leaving un-benches it, and the bot rejoins through the ordinary
  respawn queue with its skill and squad intact.

**Benching is not killing, and this matters.** Joining a match must not charge a
team a reinforcement, and neither must leaving, so neither path touches tickets.
`BattleSystem.setBenched` takes the bot off the field without a death.

The bench lives in `BattleSystem`, as a `Set<Bot>`, and **not as a flag on
`Bot`**: which slots hold people is a fact about the roster, and `Bot` is an AI
combatant that has no business knowing a lobby exists. Every loop over `bots` in
that file must skip the bench — respawn, the think budget, `hittablesAgainst`,
`acquire`, `separation`, `hearGunshot` and the squad centroids all do.

**A slot index IS a bot index**, by construction: `Roster` lays slots out team 0
then team 1, `BattleSystem` builds its pool the same way, and both are sized
from `CONFIG.bots.perTeam`. Keep that true or benching needs a mapping that can
disagree with itself.

Team balance is corrected by *arrivals*, never by moving anybody. Being
reassigned mid-round is disorienting; `Roster.claim` always takes the thinner
side, so an imbalance left by departures heals on its own.

**Which side the local player is on comes from the welcome and from nowhere
else.** That balance rule puts the SECOND person into a match on team 1, so a
client holding a hardcoded 0 reads every mine/theirs question in the game
backwards at once — the ticket strip, the flag colours, the minimap, the spawns
the deploy screen offers, the killfeed's "was that us", and the colours its own
body falls in. `Game.applyPlayerTeam` is the single funnel, and it is called
from **both ends of the race the welcome is in**: `joinMatch` books the local
round before the socket is open, so `buildRound` reads `NetSession.team` when
the welcome was early and `NetSession.onSeated` applies it when it was late.
What the funnel is for is the short list of things painted ONCE in a side's
colours — the death cam's stand-in body, the minimap backdrop, the HUD strip
outside `playing`, the deploy screen's spawn list. Everything else reads
`player.team` live every frame and needs nothing.

## On the client, a bot and a person are the same thing

`NetSoldier` is a `Combatant` with a `SoldierRig`, posed from snapshots. It never
thinks, never moves itself, never fires and never decides it is dead.
`NetRoster` pools sixteen of them, indexed by slot, built once and never
disposed.

The client is **not told** which slots are people. That is what makes "start
without a full lobby" and "give a leaver's slot back to a bot" one mechanism
instead of two: a slot changing hands touches no mesh, no pool entry and no
index.

Two consequences to preserve:

- **`STRIDE` is shared** (`SoldierModel.ts`). Both `Bot` and `NetSoldier`
  advance their walk cycle by distance travelled over the same divisor. If they
  differed, a bot and a person walking side by side at the same speed would
  swing their legs at different rates — which is precisely the tell that would
  give away which bodies are AI.
- **The walk weight is derived server-side**, from ground actually covered, not
  reported by the client. An animation flag a client sets is one it can lie
  about.
- **A person's body falls over on the same field a bot's does.**
  `NetPlayer.deathProgress` is `Bot.deathProgress` derived from the respawn
  clock, and it rides `EntityState.dead`. Sending a bare `1` instead — which is
  what it did — makes a killed player VANISH on the tick they die instead of
  collapsing, and it takes the ragdoll's fallback with it, since a corpse the
  pool declines has nothing else left to play.

## Coming into the world is an ASK, and it is the only one

A person chooses where they drop in, in a match exactly as offline: the deploy
screen is the same screen, offering the same list, and the difference is only
who acts on the choice. The client sends `deploy` and the authority puts the
body somewhere; **nothing on the client may place it.** That is the same rule
the rest of this document argues for a bullet, applied to the one question a
shooter cannot afford two opinions about — where somebody is.

**A person is deployed only when they have BOTH waited and asked.** The
reinforcement clock in `HeadlessGame.step` says when and `NetPlayer.deployRequest`
says where, and neither is enough alone. There is deliberately no timeout into
the world: a player looking at the map is doing the thing the screen is for, and
the alternative is yanking them out of it mid-decision. A slot whose person is
still choosing is simply a slot with nobody on the field — which is what it was
while they were dead anyway.

**The index on the wire is into the MAP's spawn table, not into the offer.**
The offer — `ConquestSystem.deployOptions` — is derived from flag ownership and
re-derived every frame, so its indices renumber the moment a flag changes hands
and the same number means two different places on two machines a round trip
apart. `GameMap.spawns` is the layout module both sides build from and never
moves. `spawnIndex` is the client's half and `deployAt` is the authority's, and
the authority's half is the check: a spawn is honoured only if it is in the list
that team would be offered *now*. The enemy's gatehouse, a flag lost while the
message was in flight and an index that is not a spawn at all are all refused by
that one lookup.

**A refusal costs the position and never the reinforcement.** `spawnPointFor`
falls through to the pick a bot would get, because the player asked to come back
and coming back is not the part they are asking permission for. A refusal that
left them dead would be a client desync — a list a tick out of date — punished
as though it were a cheat.

**The request stands until it is answered, on both sides.** `NetSession` holds
it and re-sends on the next welcome, because the two moments a client is seated
without being in the world are exactly the two where a dropped request strands
somebody: a confirm made before the welcome lands (the local round is booked
before the socket opens), and a reconnect, which seats this client into a fresh
body that is dead until it asks. The server holds an EARLY ask rather than
refusing it, for the mirror reason: the client's countdown is the one the player
watches and it legitimately reaches zero a trip ahead of the server's.

**A reconnect puts the deploy screen back up, over whatever was on it.**
`Game`'s `onSeated` does that from `playing` and `dying` — the client's old slot
is gone, its new one is dead, and every movement sample it sends is dropped as
"a dead player reports nothing worth keeping", so a client that carried on
playing would be a ghost nobody can see or shoot. It deliberately does NOT do it
from `deploy`, where the screen is already up and re-showing it would reset a
selection the player is in the middle of making.

**The deploy screen keeps its place by IDENTITY.** Its list is live in a
netplay round — a flag falling two hundred metres away removes a row — so a
carried index would quietly become a different position under a hand already on
Enter. This is the same rule the lobby follows, arrived at from the other
direction.

**`PROTOCOL_VERSION` is 3 for this**, and it earns the bump: the change is to
who acts first, so a version-2 client against a version-3 server would sit dead
in a live match forever, alive on its own screen and absent from everyone
else's. Refused at the handshake, it is a sentence the lobby prints instead.

**The deploy screen and every lid over it step the netplay frame, and there is
no state left that draws a live round without stepping it.**
`Game.updateNetWorld` is called from `updateWorld` for the states inside the
round and from `updateNetUnderCard` for the ones that are outside it, because a
player waiting to come back — or sitting in a menu — is watching a fight that
has not stopped for them: unstepped, sixteen bodies stand frozen behind the card
and snap on the frame they leave it, the ticket strip under it shows the round
they died in, and the flags the deploy offer is derived from never arrive at all
before the first deploy, so a player joining a match in progress is offered their
home spawn and nothing else. `RagdollSystem` is in that method for a sharper
reason than symmetry: `updateNet` is what raises an interpolated death, and a
death raised while the pool is not stepped is a corpse that takes a rig and hangs
in the air for the rest of the round. It stays out of `menu`, which is a round
that is not running — and `menu` needs no test of its own, because `enterMenu`
calls `leaveMatch` and `this.net` is null in every state that reads back as one.
A `paused` netplay round IS running, which is the whole difference between a lid
here and a lid offline.

**The scoreboard is up on that screen too, and it is a match feature more than
an offline one.** Offline the deploy screen is a couple of seconds; in a match it
is where a player spends every reinforcement clock of every death, watching a
round they are not in — the exact moment "how is this going" is worth asking.
`Game.pushScoreboard` runs from `tick` for `playing`, `dying` and `deploy`
alike, so the panel follows the round rather than the weapon in your hands.

**So a networked lid covers the local half of a frame and nothing else**, and
the things a pause normally freezes alongside the world have to be let go with
it. The HUD keeps its real `dt` — a killfeed held at zero stacks the kills that
arrive while the card is up and fades the lot on the resume. The reinforcement
countdown keeps running, because it is the server's `NetPlayer.respawnT` that
gates the deploy and the local copy is a number on a card plus the gate on its
own button: a lid that stops it makes a player wait out time the authority has
already given back. The audio clock is left running, which is the least obvious
of the three: `hit`, `damage` and `explode` sound straight from the message
handler in whatever state the client is in, and against a suspended
`AudioContext` they neither play nor reach `onended`, so each holds a voice
against the cap until the resume and then they all fire on the same instant.

**Three lids — `paused`, `settings` and `loadout` — and `settings` is the one
that can be raised over another**, so what a frame owes cannot be read off
`Game.state` alone: `stateUnderLids` looks through the stack (two deep, and it
can be no deeper — nothing may cover the settings screen) and `worldHeld` asks
the only question the HUD's clock cares about. All three call
`updateNetUnderLid` rather than each deciding for itself, for the reason
`updateNetWorld` has one home, and **a fourth screen owes the same call the day
it is written**. The kit screen is the one where this is easiest to skip and
worst to skip: its scrim is opaque but for the stage the weapon turns on, so the
freeze behind it is nearly invisible and the snap on the way out is
unattributable.

What a lid still covers is everything that would be a decision — the player does
not move, shoot or upload; `updateNet` asks for `state === "playing"` before it
sends a move sample, so a paused client is already indistinguishable on the wire
from one standing still. **That is the cost of the feature and it is not a
bug**: the body stays in the world, breathing and shootable, for as long as the
menu is up.

## A death, on the side that only watches

The authority decides who died and has already charged the ticket, written the
killfeed line and started the respawn clock before a client hears about it. What
is left is a body falling over, and that is the client's alone — the same
`RagdollSystem` pool, the same five refusals, the same collapse tween underneath
them as offline. Three things make that work and each has a way of failing
quietly.

**The trigger is the interpolated death, not the `kill` event.** `NetRoster`
reads the `alive` edge either side of the one call that can move it and raises
`onDeath`; `Game` wires that to `ragdolls.spawn` exactly as `onBotKill` is
wired to `registerBotKill`. Two reasons it is not the event. The event arrives in
real time and the body is drawn `interpDelay` behind it, so spawning from the
event throws a corpse a tenth of a second before the round that killed it appears
to land. And every death is in the snapshot stream by construction, whereas an
event is a message a reconnect can drop — a missed killfeed line is a missed
line, but a missed corpse is a body that never falls.

**The `kill` event still has to arrive, because it carries the throw.** `from`
and `amount` are the killing blow's origin and size — the pair `damage` already
carried, and the pair `RagdollSystem.applyImpulse` needs — so the event ARMS a
soldier and the interpolated death SPENDS it. An unarmed death is still a death:
a zero-length direction reads as "straight up", so the body falls over instead of
being thrown, which is what a lost `kill` should look like and is never a body
that fails to fall.

**One `kill` event per death, and the server has two doors onto that.**
`onKillEvent` sees every bot go down and `onPlayerDamaged` sees every person,
whoever dealt it — a rifle, a blast, another client's round. `Match.onShot` must
raise only the `hit`: a second `kill` from there would put two lines in the
killfeed for one body, and it is the poorer of the two anyway, because it does
not know where a bot's killing blow came from. The killer's team on a person's
death is DERIVED (`1 - victim.team`) rather than carried, because friendly fire
is excluded by construction everywhere in this game.

**`HeadlessGame.resolveShot` is the third way a bot can die, and it is the one
that was not charging for it.** `BattleSystem.onBotKill` fires for a bot shot
by another bot and the grenade handler fires for a blast, but a person's round
reaches `CombatSystem.fire` through `resolveShot` and touches neither — so every
bot a human killed cost that team no reinforcement at all, and the only thing
draining their tickets was the flag bleed. It is charged there now, one line
after the resolve, exactly where the client's `Game` charges the same kill
through `registerBotKill`. The failure mode is worth remembering because it is
silent in both directions: rounds simply ran long, which reads as mistuned
config rather than a missing call.

**While the pool owns a rig, `NetSoldier.update` stands aside entirely** — the
same one-line answer `Bot.update` gives in its own dead branch, and for the same
reason: the solver writes proxy nodes the joints hang off, and a second writer on
those nodes is two things posing one body. `alive` is still read from the samples
ahead of that guard, because it is the pool's own self-defence — a slot whose
subject came back to life releases it on the next step, and it can only know that
from the wire.

**The local player's own death is the death cam, and it runs here too.** The
`died` event routes to `enterDying` rather than straight to the deploy screen: a
death cam decides nothing, so nothing about it belongs to the authority except
the clock, which arrives on the event as `respawnIn`. The bearing and size of the
blow come from the `damage` event the server queues immediately ahead of it —
`died` carries a slot and a clock and nothing to throw a body with. And because
`dying` is a STEP and not a lid, `updateNet` is called from `updateWorld` rather
than from `updateGameplay`: on the other side of that split, the four seconds
spent watching your own body fall were four seconds during which nobody else on
the map moved.

## The client runs none of the simulation and all of its own dressing

`Game.updateWorld` returns early in a netplay round, and the line it draws is
"decides an outcome", not "moves something". Conquest and the bots are the
authority's and are skipped. **`CombatSystem`, `GrenadeSystem` and
`RagdollSystem` are still stepped**, because what they hold between frames is
this client's own effects and nobody else advances them.

**A ragdoll is on the near side of that line, and reading it as simulation is
what left multiplayer with no ragdolls at all.** A corpse decides nothing: it is
not in `NavGrid`, not in `ObstacleField`, not in `hittablesAgainst`, and the
authority has already spent the ticket and the kill by the time the news
arrives. Skipping the physics step does not merely stop bodies falling — it
stops them *finishing*, so a body the pool did take would hang mid-tumble for
the rest of the round with its joints parented to proxies nothing is writing.
The rule is the same one the tracer teaches next door: what this client owns
between frames, this client has to advance.

Getting that line wrong does not look like a missing effect, it looks like a
haunting. A tracer is spawned AT the muzzle a hundredth of a metre long and
`update` is what flies it out to the impact and hides it again — so a round
fired without that step leaves a lit dot floating where the muzzle was, one per
shot, forever. The impact spark, its dust and its sound ride the same clock (they
are spawned when the streak's head arrives, not when the ray resolved), so they
never happen at all; and a thrown grenade hangs at the release point with a fuse
that never runs down.

**The dressing needs targets, and they come from `NetRoster`, never from
`BattleSystem`.** `Game.enemyTargets` is the one place that choice is made, and
both callers that need it — the local shot resolve and the gamepad aim assist —
go through it, because an assist that holds an aim on a body the rounds cannot
find is worse than no assist. Asking `battle` there does not merely return the
wrong list, it returns an EMPTY one that no team check exposes: `buildRound`
calls `battle.reset()`, which leaves every bot in the local pool dead, and
`updateWorld` returns before `battle.update` could ever respawn one, so the only
combatant that side still knows about is the local player — whom the team check
drops. The symptom is a shooter's own screen going quiet: sparks on the wall
behind the man who was hit, no hitmarker until the `hit` event has made the
round trip, and aim assist inert. What the roster hands back are `NetSoldier`s
whose `takeDamage` returns false, so this is a PREDICTION and nothing else —
the authority re-resolves the same round against its own rewound copy, and only
that result deals damage.

**The minimap reads the same substitution, and it is the second place that
empty list had gone unnoticed.** `Game.mapBodies` is where the choice is made —
the bot pool offline, `NetRoster.soldiers` in a match — and without it a netplay
round drew no blips at all: the panel was up, the backdrop was right and the
flags moved on it, so what was missing did not read as a broken list so much as
a map of an empty village. Unlike `enemyTargets` this is a plain READ, so it
hands back both teams and the array as it stands, and the minimap decides for
itself which half it may draw. The local player's own slot is in that array and
is left dead for the life of the session — `NetRoster.applyRoster` resets it and
`applySnapshot` skips it — which is what keeps a friendly blip from sitting
under the arrow that already stands for them.

**Gunfire gives an enemy away, and in a match only the authority can say so.**
Offline that rule is `wireBattle` reading `BattleSystem.onBotFired`; here no
client runs the AI that pulled the trigger and none of them hears another
person's, so the server raises a public `fire` event carrying a slot and nothing
else. A position on it would be a second copy of one the snapshot has already
delivered, on a different clock, and could only disagree with the body being
drawn. `Match.noteFire` is the one door — `onBotFired` for a bot, an accepted
`shot` message for a person, so neither this side nor the far side can tell the
two apart — and it is noted BEFORE the ray is re-run, because a miss gives a
shooter away exactly as loudly as a hit. It is **coalesced to one per slot per
snapshot**: the client turns it into a timer rather than a count, so a second
event inside the same 50 ms says nothing the first did not, and sixteen
automatic weapons at 600 rpm would put ten times the traffic on the wire to say
it. Nothing is given away by making it public that the snapshot has not already
handed over — every position is in there, and what the minimap withholds it
withholds by choice rather than by ignorance.

**Both ends have an opinion about the same bullet, and it is announced once.**
The local resolve cues the marker and the tick the instant the trigger goes; the
server's `hit` arrives a round trip later saying whether it agrees. Cueing both
does not read as an echo — the gap is far too long — it reads as two hits, which
makes the marker worth less than it was. So a prediction leaves a credit
(`Game.creditPredictedHit`), the event claims it (`claimPredictedHit`), and the
event is silent unless it carries something the prediction could not: a KILL,
which the local resolve can never report and which is the marker that means stop
shooting, or a headshot where this client scored a body hit — the bodies here
are `interpDelay` behind, so the two do not always test the same head zone. The
opposite correction, a predicted headshot the server scored as a body hit, is
deliberately silent: it is a hit either way and the marker is already up.
Credits are a FIFO queue because rounds are re-resolved and reported in the
order they were fired, which pairs them without a shot id on the wire, and they
expire (`CONFIG.net.hitCreditWindow`) because a round the authority scored as a
miss is never followed by any event at all — an unclaimed credit that never went
away would swallow the next genuine correction.

A grenade is deliberately NOT given that list. `hittablesFor` stays wired to
`battle` and so finds nobody, which is right rather than merely harmless: a
bullet owes the shooter a tracer that stops in a body and an immediate marker,
while a blast owes nothing local at all — its light, noise and concussion arrive
on the server's `explode` event — so pointing it at the roster would buy a
line-of-sight ray per body inside the radius and no cue.

The blast is the one place the local copy and the authority both have an opinion,
and the authority wins: **`onExploded` is suppressed in a netplay round**. Every
client — the thrower included — gets the explosion from the server's `explode`
event, so firing the local one as well would flash, bang and shake twice, a
round trip apart, at two points that agree only to within that trip.

## Interpolation, and the clock underneath it

Remote bodies are drawn `CONFIG.net.interpDelay` behind the newest snapshot, so
every frame is between two samples that have arrived. Before the oldest and
after the newest it **clamps rather than extrapolating**: a body that keeps
walking because its packets stopped is one that has to be yanked back when they
resume.

The clock offset is load-bearing and easy to get backwards. One sample is
`serverNow - localNow` measured when the message is *handled*, which is
`trueOffset - delay` for a delay that is never negative. So every sample
**understates** the offset and the best estimate in a window is the **maximum**.
Taking the minimum picks the worst-delayed sample and drags render time that
much further behind; it read as a 342 ms skew between a server and a client on
the same machine.

`TICK_HZ` must be divisible by `SNAPSHOT_HZ`. A fractional ratio makes the
broadcast alternate between two spacings and a client interpolating on an even
cadence renders it as a limp.

## Lag compensation

`server/lagComp.ts` keeps `REWIND_WINDOW_MS` of every body's `center` and
`eyePos` and moves them back around a shot.

**`resolve` takes a callback and restores in a `finally`, and it must stay that
way.** A `rewind()`/`restore()` pair is a thing somebody forgets to balance, and
a throw between them leaves sixteen bodies permanently displaced with nothing to
report it — every later shot, LOS test and capture-zone check would silently use
ghost positions. There is a test that throws inside the callback.

The shooter is never rewound: they are resolving their own shot from where they
say they are now.

The window is clamped, not trusted. Unbounded rewind is a licence to shoot at
where somebody stood a second ago.

## What crosses the wire, and what does not

**Never on the wire:** damage numbers, weapon statistics, health arithmetic, map
geometry. A client names a *weapon id* at join; the server validates it against
the real table and looks up everything it means. The map is built locally on
both sides from the same layout module.

**An event with one audience is ADDRESSED, not broadcast and filtered.** Most of
what `Match` queues is public by nature — a flag changed hands, a body went
down, a grenade went off, a weapon fired — and every client needs it to draw the
same round.
Two are not, and both were broadcast with the client filtering them on arrival:

- **`hit`, to the shooter.** Feedback about one person's trigger. Broadcast, it
  told every client in the match who was hitting whom and, through `killed`,
  that a body was going down a tick before the snapshot would honestly show it.
- **`damage`, to the victim.** The sharper of the two, because it is the only
  message in the protocol carrying a health at all — so every client held every
  player's exact pool, live, with the bearing they were shot from beside it.
  That pair is precisely the read a wallhack is after.

A filter on the far side does not fix either, because it is a promise about the
client rather than a property of the server, and the payload is on the wire
regardless for anything reading the socket. So `PendingEvent` carries the
audience — a slot, or `ALL_PEERS` — and `flushEvents` builds a per-peer payload
on the ticks that have something addressed on them; a tick without one is the
single encoded broadcast it always was.

**The `kill` beside that `damage` stays public, and the pair is where the line
is.** That somebody DIED is everyone's business: the killfeed line and the
corpse are on every screen, and `from`/`amount` ride along because that is what
each client throws the body with. How close they were to dying before it
happened is nobody's business but theirs. `died` is broadcast too and could
equally be addressed to its slot — the client already gates it — but it adds
nothing to what its `kill` has just said in public except a respawn clock.

Two things about that queue are load-bearing. The audience rides on the SAME
list as the events, because a client reads one ordered stream: hit credits are
paired off it FIFO with no shot id on the wire, and `died` is read against the
bearing the `damage` immediately ahead of it left behind. A second list flushed
alongside the first would slide a tick's shared events wholly before or wholly
after that client's own and break both. And the client's `event.shooter ===
net.slot` / `event.victim === net.slot` tests stay, demoted from filters to
guards: client and server ship as separate images, so a rolling deploy can put a
new client in front of a server that still broadcasts, and neither event's shape
changed, so the handshake's version check would not catch it.

**The scoreboard is STATE and is sent as state, not added up from events.** The
authority keeps one line per slot — `HeadlessGame.slotKills`/`slotDeaths` — and
`Match` broadcasts the pair whole as a `scores` message on the ticks it has
moved, which it learns by comparing `scoreVersion` against what it last sent. A
client that instead counted the `kill` events it saw would be wrong three ways
at once: events are a queue a reconnect drops, a joiner has missed every one of
them that happened before they arrived, and `kill` names the killer's *team*
rather than the body, because the killfeed only ever needed a side. As state it
self-corrects — a lost message is superseded by the next — and a joiner is
handed the table on admission, which is a message to one peer for the same
reason `hit` is.

**A kill is counted at the KILLER's door and a death at the VICTIM's, once
each.** They are separate facts with separate witnesses: every death in the game
already arrives somewhere (`onKill` for a bot, `NetPlayer.onDamaged` for a
person) while who fired is known only to whatever pulled the trigger, so a
single door would mean one path inventing the half it cannot see. That is what
`HeadlessGame.creditKill` is, and it is why `BattleSystem.onBotKill` hands over
the shooting BOT and any victim rather than the falling bot and a team — the
older shape dropped every kill whose victim was a person, which on a server is
half the roster. The client's `Game` runs the identical pair offline.

**A team's totals are SUMMED from the rows and stored nowhere.** Two counters
for one fact is two counters that can disagree, and the one that would be wrong
is the one nothing on screen can check. `HeadlessGame.teamScore` is that sum on
the server (`npm run simulate` prints it); `Game.updateHud` does the same on the
client, over the same rows the columns under it are drawn from.

**The client sends** its position at `INPUT_HZ`, and — per event — the round it
fired and the grenade it threw. Every one of those is gated before it is acted
on. The shot's `dir` is the direction the round *actually* flew, spread already
applied, because `CombatSystem.fire` jitters internally and the server has to
re-resolve that bullet rather than a differently jittered one.

**Health REGENERATES on the server, and the client predicts the curve.** Regen
is a rule about a number the authority owns, so `NetPlayer.regen` runs it off the
same `regenDelay` and `regenRate` `Player.update` uses offline — a networked
round whose pool never refilled would be precisely the respawn queue
`config/player.ts` calls that rule load-bearing against, with the twist that only
the multiplayer half of the game had it. Nothing on the wire announces a healed
point: a `damage` event is the only message carrying a health at all, and it is
enough, because a hit is the only thing that can put the client's copy out by
more than a trip's worth of regen. So the client arms its own lock from that
event — `Player.applyServerHealth` is the assignment and the lock together — and
runs the identical curve locally. The drift that leaves is one round trip of
healing and it is on the CLIENT's side: a player may briefly believe they have
less health than the authority says, never more.

**Assigning that health without the lock is the bug the method exists for.** The
client healed straight back to full underneath a server that had never healed it
at all, so the HUD read 100 while the authority held 75 — and nothing looked
wrong until the next round landed and knocked the bar down to where it had
always been. A health that only ever *falls* to the truth is the shape of this
failure, and the cause is a client running half of a two-part rule.

**A position on the wire is the FEET**, and the whole of a body is built up from
it on the far side: the validator asks what is solid at that height, `NetPlayer`
raises the eye and the hit sphere off it, and `NetSoldier` stands a rig on it.
Nothing sends a height twice and nothing sends a height for a part of a body, so
a `y` that means anything else is wrong in three places at once and looks like
one bug in none of them. It has been wrong once: the client uploaded
`Player.root.position` — the collider capsule's CENTRE, half a body higher — and
so remote players floated 0.9 m off the ground, their hit spheres floated with
them, and the movement validator asked whether there was room for someone
standing 0.9 m in the air, which is how a **door lintel became a wall** and a
player got stuck walking through cottage doorways. That is why `Player.position`
is the feet and `Combatant` says so: it is a rule about a whole game's worth of
geometry, not a detail of one entity.

**The two ends of a body must agree about its middle, too.** A standing hit
sphere is centred at `height / 2` (0.9), which is what puts its top the 0.05 m
above the eye that `config/player.ts` argues for — and `SoldierModel`'s rig
centre, `Player.center` and `NetPlayer.center` are all that same number. Deriving
it from `eyeHeight` instead is the near miss: it is the *top* of the sphere that
the eye is 0.05 below, not the centre, and reading that comment as a centre put
the authority's idea of a player 0.6 m up their own chest — so the client drew a
body where the server had none and hitmarkers stopped meaning anything.

## The world the server stands in

The server has no canvas. `DynamicTexture.getContext()` throws
`OffscreenCanvas is not defined` and `GPUParticleSystem.IsSupported` is false,
so **`MapBuilder` cannot run there at all** — it reaches a texture through
`floorMaterial`.

It rebuilds the solid world instead, from `src/world/<map>/collision.ts`
(generated; see `scripts/bake-collision.mjs`). That is sound because
`MapBuilder.collider()` is the only place a collider is made and the `WorldBox`
it records is everything `MeshBuilder.CreateBox` needs. Both sides then pick
against that geometry with the same `scene.pickWithRay(SOLID_ONLY)` — one ray
implementation, not two.

**`npm run parity` is the guard on that claim** and should be run after anything
that touches the world layer. It compares the nav GRAPH, not the boxes: a box
count matches while every box sits a metre to the left, whereas the graph is
downstream of every box's position, size and rotation. It has already caught one
real fault — micrometre rounding in the bake moved 15 cells in and out of the
walkable set, because the nav grid rasterizes box tops into surface heights and
compares neighbours against `stepHeight`, so *any* perturbation flips whatever
was sitting exactly on a boundary. The bake emits full precision for that reason;
do not "tidy" it.

`npm run build` refuses to proceed when a bake is older than the layout it came
from. A stale bake is a server whose walls stand somewhere else from its
clients', and it is invisible until somebody is shot through a house.

## Grenades

Ballistics and damage are the server's; the dust is not. `GrenadeSystem` takes
`{ dust: false }` there, because `BlastDust` builds a `DynamicTexture` and a
`GPUParticleSystem` and neither exists without GL. Everything else in that file
is spheres and materials, which are inert without a renderer.

The pouch is the server's count. There is no resupply in this game — death is
the only refill — so the ammunition IS the limit, and a client tracking its own
would throw as many as it liked.

## The lobby, and why there is no central registry

**The registry in `server/index.ts` IS the lobby.** Matches live in that
process's memory, so the list it serves on `GET /matches` is authoritative for
itself: there is nothing for a match server to check in WITH, because there is
one of them and it already knows everything there is to know. A master server —
the thing dedicated servers heartbeat into so clients can be handed a list of
addresses — solves a problem this deployment does not have, and building one now
would be a second source of truth about matches that only one process owns.

That stops being true the moment there are two processes, and the trigger is
CPU: Node is single-threaded, so every match in a process shares one core.
`MAX_MATCHES` (env, default 4) is what bounds it, and it exists so that "New
match" is a safe button — a create path with nothing behind it is a way for
anyone to spend the server's memory from a menu.

Three pieces, and the shape is the same one every screen here follows:

- **`GET /matches`** returns a `MatchList`: the protocol version, whether the
  server will create any more, and a `MatchSummary` per match. The version is on
  it because this is the FIRST thing a client asks, so it is the cheapest place
  to find out the server is running a newer build.
- **`Join.matchId`** names a match, and a named match is **never substituted**.
  A peer that asked for `m3` and could be seated in `m4` is refused with a reason
  rather than moved, because it picked that row for something on it and being
  quietly relocated is indistinguishable from the lobby being wrong. An UNNAMED
  join still fills whatever has room — that is `?mp` and every client that
  predates this, neither of which expressed a preference to betray.
- **`LobbyScreen`** renders what `Game` hands it and fetches nothing, the split
  `SettingsScreen` already keeps.

**The reconnect is why `Connection.pinMatch` exists.** A retry re-sends the
original join, so a client that opened with `create: true` would stand up a NEW
match on every dropped socket — abandoning the one it was playing in and walking
through the match cap in a bad minute. `NetSession` reads the match out of the
welcome and pins the connection to it, which also turns a reconnect into a real
rejoin rather than a fresh roll of the dice.

**The name is the one client string other people's screens render**, so it is
bounded on arrival (`cleanName` in `Match.ts`) exactly as the weapon id is
resolved there: truncated to `MAX_NAME_LENGTH`, stripped of the control
characters that hide the rest of a string, and never escaped — escaping belongs
to whatever renders it, and every screen writes a name with `textContent`.

### The map belongs to the match, and a client never picks it

**A match is played on the map the authority is running, and joining one takes
that map whatever the menu had selected.** This is not a preference the client
gets to hold: the world is built LOCALLY on both sides and no geometry crosses
the wire, so a client on a different map is not playing the same game — its
walls, its flags and its spawns are somewhere else, and every position that
arrives is nonsense in the world it is drawn into. It read exactly like a
multiplayer bug of the ordinary kind: pick Greyfen in the menu, join a match
running Hollowmere, and the round comes up in Greyfen with bodies walking
through hillsides.

The map is stated in the `welcome` and again in every `roundstart`, and
`Game.applyMatchMap` is the single funnel that spends either. It answers three
things, because there are three:

- **`same`** — the ordinary case, and what the lobby's row buys. `LobbyScreen`
  hands the row's `mapId` down with its id (`onJoin`), so `joinMatch` applies it
  BEFORE booking the round and the first build is already the right world.
- **`changed`** — the caller owes a build, and there are three callers.
  `buildRound` reads it when the welcome beat the build (the same two-sided race
  the team has, and settled the same way); `NetSession.onSeated` rebuilds when
  the welcome lost, which is an unnamed `?mp` join or a match that rotated
  between the list and the pick; `onRoundStart` rebuilds on every rotation.
- **`unknown`** — an id this build does not have, from a server one version
  ahead. There is no world to build, so there is no round to play: the session is
  dropped and the player is put back in the lobby with the reason, the same three
  moves a `rejected` makes.

**Rotation was the case that proved the rule was missing.** The client used to
route it through `Game.setMap`, which refuses to run outside the menu — and a
rotation arrives in `roundover`, so *every* map change on the server left the
client rebuilding the map it was already on. `applyMatchMap` may write `mapDef`
from any state precisely because every caller builds within the same frame;
`setMap` keeps the menu guard, because it is the player choosing.

**`setMap` is the PREFERENCE and is remembered; a match's map is neither.**
Nothing on the netplay path calls `writeMap`, and `enterMenu` puts `mapDef` back
to `readMap()` on the way out of a match — so the menu offers what you chose,
not the map of whatever round you last dropped into.

**Creating a match is the one join that carries a map**, as `Join.map`. It is a
REQUEST: the server spends it only on a match this join actually builds (both
create paths in `routeJoin`, including the fallthrough where nothing had room)
and ignores it entirely when the peer lands in an existing match — a preference
cannot move a round sixteen people are already standing in. `Match`'s constructor
resolves it against the real `MAPS` table exactly as `admit` resolves the weapon
id, so an unknown id falls back to the default rather than standing up a match
naming a world the server does not have. Additive on the wire: a client that
sends no `map` gets the default, which is what every client got before the field
existed. The lobby's own Map row is where a player sets it, and it is the same
pick the menu shows — one choice, two places it is on screen.

## What is not built yet

Stated so nobody assumes otherwise:

- **Choosing your name.** It is `?name=` and a default, because the menu has no
  text entry anywhere in it: a focused input has to be kept from feeding the
  game's own key handling, and neither that nor a pad path exists. `Game.playerName`
  is where it lands.
- **In-flight grenade replication.** The blast is authoritative and every client
  sees it; the projectile arcing toward them is not yet replicated, so a grenade
  currently arrives as an explosion.
- **Hearing anybody else's weapon.** A remote body is silent: the shot, the
  reload and the boots are `Sfx.botShot`/`botReload`/`botStep` hung off
  `BattleSystem` callbacks offline, and none of those fires on a client here.
  The `fire` event is not that feature waiting to be plugged in — it is
  coalesced to one per slot per snapshot, which is right for a reveal and wrong
  for a report, and a shot a player can place by ear needs the muzzle's position
  and the rounds' own timing rather than a slot and a 50 ms bucket.
- **Reconnect into your own slot.** A dropped player rejoins as a new peer and
  takes whatever slot is free — on either team, and into a body that is dead
  until it asks, which is why the deploy screen goes back up on a re-seat. The
  match keeps its world for a minute, so the round survives; the seat is not
  reserved, and neither is the position you were standing in.
- **More than one match server process.** Matches live in memory, so two
  replicas behind one proxy put players who joined "the same" match into two
  different worlds — and each would serve its own half of `/matches` as though
  it were all of them. This is the one item above whose fix IS a central
  registry, and the ceiling that forces it is one core's worth of matches.

## Deploying it

`docker compose up --build` is the whole of it on a development machine: `web`
is nginx serving `dist/` and `match-server` is this process, deliberately
unpublished so the only route in is the proxy. On a server,
`docker-compose.prod.yml` is the same two services from the images CI pushes —
`idrum4316/hollowmere` and `idrum4316/hollowmere-server`, **two images from one
Dockerfile, and the workflow needs `target:` on each**; without it Docker builds
the last stage in the file, which is `web`, and the server image silently never
exists.

**Both `/ws` and `/matches` need a `location` block** — anything nginx does not
name falls through to the static root and comes back as a 404, and that failure
is a nasty one because the lobby works perfectly against `npm run server` on a
dev machine, where the client reaches the match server directly and nginx is not
in the picture at all.

**The upstream must be reached through a VARIABLE, and this is not a style
choice.** A literal `proxy_pass http://match-server:8080` is resolved when nginx
loads its config, so a `web` container with no match server beside it does not
serve a 502 — it exits, with `host not found in upstream "match-server"`, and
takes the single-player game down with it. That is the deployment this repo had
for most of its life and the one every reader assumes still works. Through
`set $match_server "${MATCH_SERVER}"` the lookup moves to request time, which
is also what makes the address a deploy-time setting; a named upstream then
needs a `resolver`, and `docker/14-resolvers.envsh` is what fills one in with a
fallback so that no DNS is still not a config error.

**The edge proxy in front of the domain needs to know about the WebSocket.** A
site that has only ever served files has never had to forward an Upgrade, and
the symptom when it does not is a socket that opens and closes immediately with
nothing worth reading in it. For nginx:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
```

Caddy needs nothing said: `reverse_proxy 127.0.0.1:8080` carries WebSockets on
its own.

**Capacity is one core per process, and it is not the constraint people expect.**
Measured on one container: four concurrent matches — sixty-four bodies, sixteen
of them under a nav graph and a think budget each — cost 13–25% of a core and
278 MB together; one match costs ~9% and 154 MB. `MAX_MATCHES` is what bounds
it, and the interesting limit is memory per match rather than CPU per tick.

In DEV the two are on different origins, which is what `?server=ws://host:port/ws`
is for and why `/matches` answers with `access-control-allow-origin: *`. The
list is public and read-only — it is the same information anyone gets by
connecting — so there is nothing there for an origin check to protect.

**A deploy that moves `PROTOCOL_VERSION` breaks returning players for exactly
one launch, and that is the service worker rather than a bug.** Caching is
cache-first, so a player who already has the app runs the PREVIOUS build once
while the new one installs behind them — against a server that has already
moved. They are refused at the handshake with the server's own words (`protocol
2 but this server speaks 3`), the lobby puts the reason on screen, and a reload
fixes it. Worth knowing before bumping the constant for something cosmetic;
worth saying out loud when you bump it for something real.

**The service worker will eat the lobby if it is let to.** In a deployed build
`/matches` is same-origin, `sw.js` is cache-first over everything same-origin,
and the Cache API ignores `no-store` on both the request and the response — so
the list is served from cache forever after the first fetch. `sw.js` exempts
`/matches` and `/health` by path. It reproduces on the live site only: there is
no worker in dev and none on a first load.
