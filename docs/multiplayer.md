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

## What is not built yet

Stated so nobody assumes otherwise:

- **A lobby.** The way into a match is `?mp` on the URL. The menu is a
  list-shaped screen with a cursor (`docs/ui.md`) and a Multiplayer row belongs
  in it.
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
  different worlds.
