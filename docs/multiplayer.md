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

## A death, on the side that only watches

The authority decides who died and has already charged the ticket, written the
killfeed line and started the respawn clock before a client hears about it. What
is left is a body falling over, and that is the client's alone — the same
`RagdollSystem` pool, the same five refusals, the same collapse tween underneath
them as offline. Three things make that work and each has a way of failing
quietly.

**The trigger is the interpolated death, not the `kill` event.** `NetRoster`
reads the `alive` edge either side of the one call that can move it and raises
`onDeath`; `Game` wires that to `ragdolls.spawn` exactly as `onBotKilled` is
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
that was not charging for it.** `BattleSystem.onBotKilled` fires for a bot shot
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

## What is not built yet

Stated so nobody assumes otherwise:

- **Choosing your name.** It is `?name=` and a default, because the menu has no
  text entry anywhere in it: a focused input has to be kept from feeding the
  game's own key handling, and neither that nor a pad path exists. `Game.playerName`
  is where it lands.
- **A round you join is a round you are already in.** `joinMatch` books the
  local round immediately, so the deploy screen can be up before the welcome
  arrives. `NetSession.seated` gates the uploads, so nothing is reported until
  the server has answered — but a player who deploys inside that window is in
  the world before the authority knows where. Widening with latency, and closed
  properly by spawn selection below.
- **Spawn selection.** Reinforcements arrive through `HeadlessGame.step`. The
  `deploy` message is accepted and deliberately inert: letting a client choose
  means offering it a validated list first, and an unvalidated index is a
  request to be placed anywhere on the map.
- **In-flight grenade replication.** The blast is authoritative and every client
  sees it; the projectile arcing toward them is not yet replicated, so a grenade
  currently arrives as an explosion.
- **Reconnect into your own slot.** A dropped player rejoins as a new peer and
  takes whatever slot is free. The match keeps its world for a minute, so the
  round survives; the seat is not reserved.
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
