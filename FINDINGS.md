# FINDINGS

Open threads: things measured or derived and found worth acting on, but not
yet acted on. Each entry says what is **measured**, what is **derived from the
code** and therefore still a hypothesis, and what would settle it.

This is not a bug tracker and not a design document. A finding leaves here by
being fixed (and folded into `CLAUDE.md` if it turns out to be load-bearing)
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

## 4. A 4× MSAA backbuffer is allocated and resolved for nothing

**Status:** measured, and the reasoning is not in doubt. Untried only because
it wants a look on real hardware rather than SwiftShader.

`new Engine(canvas, true, { stencil: true })` asks for antialiasing, and
`gl.getParameter(gl.SAMPLES)` confirms **4** on the default framebuffer. But
the pipeline runs FXAA, so every pass of the scene renders into post-process
render targets, and the only thing ever drawn to the default framebuffer is the
final full-screen quad. The multisampling therefore antialiases one quad's
edges — of which there are none — while costing a resolve every frame and
roughly 30 MB at 720p, 66 MB at 1080p.

`antialias: false` should be free frames and free memory, with FXAA still doing
the actual anti-aliasing. Worth checking whether `stencil` is wanted either;
nothing in the tree appeared to use it.

---

## 5. The fill-rate budget: four full-screen passes and 18.6k particles

**Status:** counted, not costed. Both are visual features rather than mistakes,
so this is a note about where a weak GPU's time goes, not a list of fixes.

- **Four chained passes at native resolution** — fxaa, godRays, motionBlur,
  horror — plus the glow layer's blur. Finding 2's detach takes that to three
  for most of a round and the blur is already a player setting. The remaining
  lever is a resolution scale (`engine.setHardwareScalingLevel`), which the
  settings screen now exists to host.
- **The ash field is 18,667 alpha-blended GPU particles** (`getCapacity`, at
  steady state). Simulation is on the GPU and cheap; the overdraw is not.

Neither should be cut by default. If a graphics-quality setting is ever wanted,
these two are what it should move, in that order.

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
has already been removed (see CLAUDE.md on `Player.floorY`). Bounding what is
left would mean probing the analytic boxes `ObstacleField` already buckets
instead of the mesh list — cheap in principle, but it has to reproduce
`topFaceHeight`'s handling of pitched ramps exactly, so it is not a five-minute
change and nothing is currently broken by it.

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

**Status:** measured headless, so the absolute milliseconds are inflated the
same way finding 6's are and only the RANKING is trustworthy. Recorded because
the ratio is larger than it looks like it should be, and because this landed
next to finding 1's unexplained frame-time tail.

With `CONFIG.bots.death.maxConcurrent` (4) corpses live, per frame:

| phase | ms | note |
| --- | --- | --- |
| `ragdolls.update` — bodies still moving | 1.37 | 24 dynamic bodies, 20 constraints, against the map's static compound |
| `battle.update` | 0.24 | all 16 bots, same run, as the yardstick |
| `ragdolls.update` — everything settled | 0.002 | the engine is not touched at all |

So a tumble costs roughly **5–6× the whole roster's AI** while it is happening.
Two things bound it and are why this is a finding rather than a bug:

- **It is short.** A body settles in ~1.1 s (measured: ground contact at frame
  20, velocity under `sleepSpeed` by frame 30, frozen by ~frame 65), and from
  then to the sink at 6 s it costs 0.002 ms. The expensive window is the fall.
- **It is capped and gated.** Four at once, none past 35 m, and every refusal
  takes the collapse tween instead.

The static world build is separate and one-off: **33–50 ms** inside
`installMap` for 733 boxes plus 25 terrain mesh blocks, against a map build
already costing ~570 ms, and it happens behind the deploy screen. Body count
is flat at 25 across three rounds, so the teardown does not leak.

### What is not yet known

Whether the 1.37 ms is Havok's step or the JS around it. The plugin's per-step
sync walks every body in the engine, which is why the map is ONE static body
rather than 758 — but that was reasoned, not measured against the alternative.
The `hasSettled` velocity read is 24 WASM calls a frame and is the other
candidate; it could be sampled every other frame for nothing lost.

### How to settle it

Time `engine._step` alone against the rest of `ragdolls.update` inside the same
loop the table above used. If the step dominates, the lever is fewer substeps
while several corpses are live; if the JS dominates, it is the velocity poll.
Do it on real hardware, not headless — at 2 fps the WASM boundary cost is not
in the same proportion it will be at 60.
