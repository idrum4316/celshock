# FINDINGS

Open threads: things measured or derived and found worth acting on, but not
yet acted on. Each entry says what is **measured**, what is **derived from the
code** and therefore still a hypothesis, and what would settle it.

This is not a bug tracker and not a design document. A finding leaves here by
being fixed (and folded into `CLAUDE.md` or the subsystem's contract under
`docs/` if it turns out to be load-bearing)
or by being disproved. If you disprove one, delete it and say so in the
commit — a stale finding is worse than no finding, because the next person
spends an afternoon re-deriving it.

---

## 1. Frame pacing: the mean says 60, the tail says 28

**Status:** measured, cause unknown.

### What was measured

On a laptop panel that runs 120 Hz on AC and 60 Hz on battery, with the
in-game readout (`#hud-fps`, added alongside the settings screen):

| power | rate | frame time | 1% low |
| --- | --- | --- | --- |
| AC (120 Hz) | >60 | — | — |
| battery (60 Hz) | 60 | 17 ms | **28** |

The counter itself is sound: `Engine.getFps()` is `1000 / mean(frame
interval)` over a 30-frame rolling window, sampled once per `beginFrame()`,
and it agreed with an independent `requestAnimationFrame` count over a
four-second window to **0.9%**. There is exactly one `beginFrame()` per rAF
callback in Babylon's `_processFrame`, and the game has a single
`runRenderLoop` and a single `scene.render()`, so nothing double-counts.

### What it means

A 17 ms mean frame time is the loop sitting on the 60 Hz vsync cadence:
99% of frames are fine. A 1% low of 28 is a tail averaging `1/28 s = 36 ms`.
That number is the tell — **a frame that misses its vsync deadline does not
take 18 ms, it waits for the next interval and takes 33.3 ms.** 36 is just
past that, so the slowest 1% are not "slow frames", they are *dropped* ones,
where the picture is held for two display intervals.

At 60 fps, 1% is 0.6 frames per second: **a visible hitch roughly every 1.7
seconds.** That is very legible under first-person mouse look, and the mean
can never show it, which is the whole reason the low is on screen.

The AC case may be a different and worse problem. If the panel is at 120 Hz
and gameplay reads 60/17, the frame cost is straddling the 8.3 ms budget and
getting pinned to the **60 harmonic** — every frame taking two intervals
instead of one — with excursions to three or four. That is not "capped at 60",
it is running at half the panel's cap with alternating pacing. Not yet
confirmed: the AC reading above is from memory rather than from a capture,
and the frame time beside it was not recorded.

### Candidates, none investigated

- **GC.** A collection every second or two matches the cadence closely.
- **The shadow depth pass** (see finding 2) — but that is a *steady* per-frame
  cost, so it fits the mean sitting at 60 rather than the spikes.
- **HUD `innerHTML` rebuilds.** `magStrip`, `nadePips`, `flagStrip`, the
  damage arcs and the scoreboard are all rebuilt as markup rather than
  patched. Event-driven, not periodic, but a burst of killfeed and arc
  activity lands several in one frame.
- **`ConquestSystem.planSquads`**, on its own 2 Hz timer.
- **WebAudio node churn** in `Sfx` — nodes are created per voice.
- The browser compositor, or anything else on the machine.

### How to settle it

Per-phase timers around the `updateGameplay` stages, accumulated per frame and
logged **only for frames over ~25 ms**. That costs nothing on the 99% and
names the phase on the 1%. If no phase accounts for the gap, the time is
outside the game's own code and GC is the first suspect —
`performance.measureUserAgentSpecificMemory()` or a DevTools allocation
timeline over a minute of play would confirm it.

Worth capturing the AC case properly at the same time: `median_ms` from the
console snippet distinguishes 120 Hz (~8.3) from 60 Hz (~16.7) directly.

---

## 2. The shadow map's refresh test almost never fails during play

**Status:** measured, and half of it acted on. The frequency below was
arithmetic when this was written and has since been captured: **97.5% of frames
re-render** while the view is turning at an ordinary rate, which is what the
arithmetic predicted.

The *cost* has been measured too, and the first response to it is in: the pass
was submitting **all 314 casters and 79k triangles** on every re-render,
because Babylon culls nothing off an explicit `renderList`. It now draws only
the ~150 that can reach the window (`ShadowSystem.cullToWindow`), which is
lossless — see CLAUDE.md. Measured over an identical 24-bearing sweep, that
change and the god-ray detach together took the frame from **846 to 674 draws
and 253k to 194k triangles**.

**What is left open is the original question**, and the cull does not answer
it: the pass still runs on essentially every frame, and whether re-rendering a
2048² depth map at that cadence is worth what it costs is still unmeasured in
milliseconds. The options below stand, all of them still quality trades, and
they are now trading against a pass that is roughly half the size.

### The claim in the contract

`ShadowSystem`'s header says the depth map "re-renders only when the snapped
focus moves", and `update()` implements exactly that: the focus is snapped to
whole shadow-map texels in the light's basis, and `resetRefreshCounter()` is
called only when the snapped value changed. The intent is that a stationary
player pays for one depth pass and then nothing.

### Why it does not hold up

Two numbers from `CONFIG.graphics.shadows`:

```
texel = frustumSize / mapSize = 110 m / 2048 = 0.0537 m
```

and the focus is **not** the player — it is (`Game.updateGameplay`):

```ts
this.shadowFocus
  .copyFrom(this.player.position)
  .addInPlace(this.cameraSys.forward.scale(8));
```

So the focus sits on an **8 m lever arm off the camera's forward**, and moves
when the player walks *or when the player turns*. The lever is what makes this
sharp:

- **Walking.** `player.moveSpeed` is 4.6 m/s (6.9 sprinting). At 60 fps that
  is 0.077 m per frame — **1.4 texels**. Every frame re-renders. At 120 fps it
  is 0.7 texels walking and 1.07 sprinting.
- **Turning.** One texel of focus movement is `0.0537 / 8 = 0.0067 rad`, which
  is **0.38°**. So any turn faster than about **23°/s at 60 fps** moves the
  focus a full texel between frames. Ordinary aiming is many times that; a
  flick is two orders of magnitude past it.

The snap is tested on all three axes (`sx`, `sy`, `sz`) and any one changing
is enough, so real movement — which projects onto more than one — triggers
more readily than the single-axis figures above suggest.

There is a third path worth knowing about: `cameraSys.forward` is built from
`aimYaw`/`aimPitch`, which **include the aimed hold sway** (bob and the view
punch are excluded — they move the rendered camera only). So a player standing
perfectly still and holding ADS still has a continuously drifting focus, and
still re-renders every frame. Hip fire while standing still is the one case
where the optimisation genuinely engages.

**Net: during active play the depth pass runs on essentially every frame.**
The optimisation buys a saving only when standing still, not aiming, and not
touching the mouse — which is close to never in a round.

### Why it might matter

A 2048² depth pass over ~150 merged casters is not free. **The cost in
milliseconds is still not measured** — it could be 0.5 ms or 3 ms, and on the
120 Hz case the difference decides whether the frame fits an 8.3 ms budget.
Measure before trading any quality for it.

### Options, in rough order of cost

1. **Measure first.** A GPU timer query around the shadow generator's pass, or
   simply `shadows.setCasters([])` for a run and compare the readout's frame
   time. That single comparison says whether any of this is worth doing.
   Nothing below should be attempted before it, and the caster cull is in
   precisely because it needed no such licence — it costs nothing visually.
2. **Widen the deadband.** Re-render when the focus has moved more than *k*
   texels rather than one. Shadow edges crawl by up to *k* texels when it does
   fire, which is what the snapping exists to prevent — so this trades a
   visible artifact for frames and needs to be looked at, not just measured.
3. **Drop the lever arm, or shorten it.** The 8 m bias exists so the window
   covers what is ahead rather than centring behind the player. A smaller
   bias re-renders less on turns; zero makes turning free and wastes half the
   window behind the player.
4. **Decouple from turning entirely** — bias along the player's *movement*
   direction instead of the camera's, so mouse look costs nothing. Changes
   which ground is covered, so it wants a look at the shadow window's edges
   during a fast strafe.
5. **Amortise**: re-render at a fixed cadence (say 30 Hz) rather than on
   demand. Halves the cost and introduces a one-frame lag between the world
   and its shadows, which on a 38° moon may well be invisible.

Note that (2)–(5) all trade shadow quality for frame time, and the current
behaviour is the *correct* one for quality. Nothing here is a bug — it is an
optimisation whose precondition turns out to be rare, and a cost nobody has
put a number on.

---

## 3. The GlowLayer draws the whole village into a buffer it cannot light

**Status:** measured. The mechanism is confirmed against Babylon's source; the
one open question is what excluding the geometry costs visually.

### What was measured

**~150 draws and ~30k triangles a frame**, spent rendering cel-shaded world
geometry into the glow layer's texture. Restricting the layer to meshes with a
non-black emissive `StandardMaterial` removed them; a frozen-scene pixel diff
at three lamp-facing vantage points came out **below the frame-to-frame noise
floor**.

### Why it happens

`Game`'s exclusion scan is one loop in the constructor:

```ts
for (const m of this.scene.meshes) {
  if (m.metadata && m.metadata.noGlow === true) glow.addExcludedMesh(m as Mesh);
}
```

That runs **before any map exists** — the map is built per round, long after —
so every mesh `MapBuilder` produces is eligible forever. `WaterSystem`,
`GrassSystem`, `CaptureZoneSystem` and `Sky` each call `addExcludedMesh` by
hand for exactly this reason; the map does not.

What those meshes contribute is nothing. `ThinGlowLayer._shouldRenderMesh` is
just `hasMesh`, and `_setEmissiveTextureAndColor` falls back to `neutralColor`
— `(0, 0, 0, 1)` — for any material without an `emissiveColor`, which is every
cel `ShaderMaterial`. They are drawn as opaque black.

### The catch, and it is the whole question

Opaque black is not *quite* nothing: it is what makes the glow buffer
depth-occlude, so a brazier behind a cottage does not bloom through the wall.
Excluding the world would let it. The blur kernel is 56 px on a half-resolution
texture, so the bleed would be local rather than map-wide, and it did not show
at the three vantage points sampled — but those were chosen for lamps in the
open, which is the case least likely to show it.

### How to settle it

Stand an emissive fixture directly behind a wall — the smithy's forge or a
lit window with a building between it and the camera — and diff with and
without the exclusion. If it bleeds, the fallback is to exclude by distance
from the nearest emissive rather than wholesale, which keeps the occluders
that matter and drops the 90% of the village that is nowhere near a light.

---

## 4. ~~A 4× MSAA backbuffer is allocated and resolved for nothing~~ — FIXED

The engine is now `new Engine(canvas, false, {})` and
`gl.getParameter(gl.SAMPLES)` reads **0** on the default framebuffer, against
the 4 it used to. The reasoning was never in doubt — FXAA sends every pass of
the scene into post-process render targets, so the only thing ever drawn to the
default framebuffer is one full-screen quad, and multisampling it antialiases
edges that do not exist while costing a resolve every frame and ~30 MB at 720p.
`stencil` went with it: nothing in `src/` uses one and there is no
`HighlightLayer`.

Kept as a heading rather than deleted because the saving is what pays for
finding 5's render scale, and the two want reading together.

---

## 5. The fill-rate budget: four full-screen passes and 18.6k particles

**Status:** counted, not costed, and now partly *steerable* — the lever this
entry asked for exists.

- **Four chained passes at the render resolution** — fxaa, godRays, motionBlur,
  horror — plus the glow layer's blur. Finding 2's detach takes that to three
  for most of a round and the blur is already a player setting.
- **The resolution itself is now a setting** (`Settings.renderScale`, three
  rungs of the display's native pixels, `Game.applyRenderScale`). Note what the
  investigation behind it turned up, because it changes what this entry means:
  the engine was never rendering at native resolution at all. Without
  `adaptToDeviceRatio` the backing store matched the CSS pixel grid, so on a 2x
  panel every number here was being paid at a QUARTER of the display's pixels
  and upscaled by the compositor. The default derives back to exactly that, so
  nothing has moved yet — but 75% and 100% are now one keypress away, and
  **that** is the frame cost nobody has measured on real hardware.
- **The ash field is 18,667 alpha-blended GPU particles** (`getCapacity`, at
  steady state). Simulation is on the GPU and cheap; the overdraw is not.

Neither of the last two should be cut by default. If a graphics-quality preset
is ever wanted, these are what it should move, in that order.

---

## 6. Where the per-frame CPU actually goes

**Status:** measured headless, so the absolute milliseconds are inflated and
only the ranking is trustworthy. Recorded because two of these were surprises.

Per frame, in a live round with 16 bots:

| phase | ms | note |
| --- | --- | --- |
| `Player.probeGround` | 2.45 | one whole-scene ray pick |
| `battle.update` | 0.55 | 16 bots, staggered thinking |
| `game.updateHud` | 0.49 | |
| `minimap.update` | 0.28 | canvas redrawn every frame |
| everything else | < 0.2 each | |

**The ground probe dominates the game's own JS**, and it scales with the map
rather than with what is on screen: `scene.pickWithRay` with a predicate walks
all 1,775 meshes and ray-tests all 758 solid colliders. A second identical pick
has already been removed (see CLAUDE.md on `Player.floorY`).

### The analytic replacement: written, measured, NOT switched on

`ObstacleField.groundAt` is the bucketed answer this entry asks for — the
highest collider top face in the band the probe reaches — and `Player.probeGround`
is still the ray anyway. What settles it is the differential, and it is worth
recording in full so nobody re-runs it from scratch.

**Sampling the whole map on a half-metre grid at four standing heights is the
WRONG test and says so loudly**: 1.2% of 914k samples disagree on Hollowmere,
2.9% on Greyfen. Nearly all of that is an artefact of asking about positions a
body cannot occupy. Where the probe's origin lands a few millimetres *inside* a
ramp, `pickWithRay` starts within the mesh, punches through it, and reports the
UNDERSIDE — 0.347 for a surface at 0.653. The ray is the one lying there.

**The right domain is the nav graph's walkable surfaces** — every (cell, height)
pair the game says a body can stand on. Over those:

| map | standable samples | disagreements | worst |
| --- | --- | --- | --- |
| Hollowmere | 28,106 | 74 (0.26%) | 3.4 m |
| Greyfen | 23,037 | 42 (0.18%) | 0.59 m |

**The 116 split into two classes running in opposite directions**, which is why
this is not simply "nearly right":

- At the Hollowmere rim the analytic reports 1.2–3.4 m, the nav graph agrees
  with it, and the RAY finds nothing at all and falls back to the terrain.
- Along one Greyfen fence line the analytic reports a surface 0.5 m up that the
  ray passes straight through to the terrain collider below.

The second class is the blocker, and it is a property of the shared primitive
rather than of the call site: `topFaceAtLocalZ` extrapolates a box's top-face
plane across a footprint that `toLocalXZ` bounds with `halfDepth`, which
INFLATES for anything pitched — `(d/2)cos + (h/2)sin`. A tall thin box tilted a
few degrees therefore claims ground beside itself. `NavGrid` tolerates that (a
phantom node is a routing nuisance); a ground probe cannot, because it stands
the player on air.

**What it is waiting on is a footprint test that bounds the plane by the box's
real extent rather than its projected one.** Everything else is done: the query
exists, the buckets are there, and switching `probeGround` over is one line
against ~2.4 ms a frame.

Two things checked and found *not* to be problems, recorded so nobody
re-derives them: the point-light arrays are **not** re-uploaded per draw
(Babylon rebinds a material's uniforms once per frame — measured 99
`uniform3fv` calls a frame, not thousands), and the HUD costs **one** style
recalc and **one** layout per frame.

---

## 7. Allocation churn is real but too small to be the hitch

**Status:** measured. This is evidence *against* finding 1's GC hypothesis, and
it is here so the hypothesis is not re-run from scratch.

A CDP heap sampling profile over 40 frames of a live round:

```
total 13.4 KB/frame
  7.15 KB/frame  Sfx.ts — WebAudio voice nodes and their onended closures
  2.01 KB/frame  Babylon's own render loop
  the rest       < 0.7 KB/frame each
```

So the WebAudio churn finding 1 lists as a candidate is confirmed as **the
largest single allocator in the game** — and 13.4 KB/frame is ~800 KB/s at
60 fps, which is a young-generation scavenge every ten seconds or so, not a
36 ms stall every 1.7. Unless a scavenge here is far more expensive than it
should be, **GC is not what finding 1 is looking at**, and the per-phase timer
plan in that entry is still the way to find out what is.

Caveat worth keeping: this was sampled headless at ~2 fps, where game time runs
at ~25% of wall clock, so the *rate* of audio events per second is not the
rate a real round produces. The ranking is sound; the absolute figure is a
floor rather than an estimate.

---

## 8. A tumbling ragdoll is the most expensive thing in the frame while it lasts

**Status: the table below DOES NOT REPRODUCE, and the headline is withdrawn.**
Re-measured while raising `maxConcurrent`, and a falling corpse is roughly
0.015 ms rather than 0.34: eight of them cost 0.121 ms/frame against
`battle.update`'s 0.392 ms for all 16 bots in the same run, i.e. under a third
of the roster's AI where this claimed 5-6x. Both runs are headless and inflated,
but the yardstick is the same one, so the ratio is the part that moved.

The two do not reconcile and the difference is not just method. The re-measure
timed `ragdolls.update(1/60)` — exactly one substep — over 1,600 frames inside
the fall, with the spawn outside the timed region; a live 2 fps headless frame
clamps `dt` to 0.05 and so takes `maxSteps` (2) substeps, which is 2x, not 22x.
The rest is unexplained. The most likely candidate is that the original figure
was taken inside the render loop, where a `performance.now()` pair around one
call at 2 fps is measuring whatever else the frame was doing.

**Re-measure on real hardware before trusting either number.** What is safe to
carry forward: the shape (linear in corpse count, ~0 when settled) and the
substep sensitivity, not the absolutes.

The open question below is settled: **86% of the time is inside Havok's
`_step`**, not the JS around it, so the lever is substeps and not the velocity
poll. Measured over the same 1,600 frames with eight corpses live: 0.128 ms
total, 0.111 ms of it inside `_step`.

What the original run recorded, kept for the comparison:

With `CONFIG.bots.death.maxConcurrent` (4) corpses live, per frame:

| phase | ms | note |
| --- | --- | --- |
| `ragdolls.update` — bodies still moving | 1.37 | 24 dynamic bodies, 20 constraints, against the map's static compound |
| `battle.update` | 0.24 | all 16 bots, same run, as the yardstick |
| `ragdolls.update` — everything settled | 0.002 | the engine is not touched at all |

Two things bound it either way, and they are what still hold:

- **It is short.** A body settles in ~1.1 s (measured: ground contact at frame
  20, velocity under `sleepSpeed` by frame 30, frozen by ~frame 65), and from
  then to the sink at 6 s it costs ~0 (re-measured: 0.0004 ms/frame with eight
  settled corpses — `update` does not touch the engine). The window is the fall.
- **It is capped and gated.** Eight at once now, none past the fog wall, and
  every refusal takes the collapse tween instead. The cap is what makes the cost
  bounded rather than a function of how many people are dying; the unused slots
  are free (four corpses cost 0.061 ms in a pool of four and 0.062 ms in a pool
  of eight).

The static world build is separate and one-off: **33–50 ms** inside
`installMap` for 733 boxes plus 25 terrain mesh blocks, against a map build
already costing ~570 ms, and it happens behind the deploy screen. Body count
is flat at 25 across three rounds, so the teardown does not leak.

### What is not yet known

Why the two runs disagree by more than an order of magnitude. Until that is
resolved on real hardware, neither absolute is worth quoting; the re-measure is
the more careful of the two (spawn outside the timed region, 1,600 timed frames,
a zero-corpse control that reads exactly 0.000 ms) but it is still SwiftShader.

The plugin's per-step sync walking every body in the engine is why the map is
ONE static body rather than 758 — still reasoned, still never measured against
the alternative. The 86% step share above makes it the more interesting half.

### How to settle it

Repeat the re-measure with the page's own frame loop rather than a synchronous
`update` loop, on real hardware, and see which number it lands on. If the
original stands, the lever is fewer substeps while several corpses are live —
`hasSettled`'s velocity poll is now known not to be it.

---

## 9. A match server socket that goes silent is never reaped

**Status:** derived from the code, not measured. Found while bounding what a
socket may spend (`docs/multiplayer.md`, "What a socket may spend before it has
proved anything"); left undone because it is a different mechanism from any of
the bounds put in there.

### The claim

Nothing on the server pings a seated peer, and nothing times one out. A slot is
released by `Match.drop`, which runs off the socket's `close` or `error` — both
of which need the far end, or the kernel, to say something. A connection that
dies without a FIN says nothing at all: a laptop lid, a phone leaving wifi, a
NAT that forgot the mapping. TCP keepalive is what eventually notices, and
Node's default is the OS default, which on Linux is **two hours** before the
first probe.

So for up to two hours after a player disappears mid-round: their roster slot
is held, the bot that would have backfilled it stays benched, `HeadlessGame`
keeps a `NetPlayer` nobody owns in the rewind history, and — new — that socket
counts against `MAX_SOCKETS_PER_IP` for the address it came from, which is the
same address the player reconnects from. `IDLE_DISPOSE_MS` does not help: the
match is not idle, it has a peer in it as far as anything here can tell.

The cap makes the last of those worse than it was, and that is the honest
reason this is written down rather than left implicit: 16 is far above one
stale socket plus a reconnect, but it is a number that a household of players
with flaky wifi could walk into over an evening.

### What would settle it

A `ping` on an interval with a `pong` deadline is the standard answer and it is
about fifteen lines: `ws` exposes both, the deadline wants to be generous
(tens of seconds, not one — a browser answers a ping from the network stack,
but a suspended tab may not), and the peer that misses it goes through `drop`
exactly as a clean close does. Worth checking first whether a backgrounded
browser tab answers pings at all; if it does not, the deadline is the whole
design and the rest is easy.
