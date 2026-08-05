# spec_visuals.md — visual work worth doing after the Babylon 9 upgrade

Written against `8f8a80b` (Babylon 9.19.1). This is a **live proposal** that is
part record now: **§1 and §4 are built**; §2 and §3 are not.
`specs/game_design.md` is the historical document and is not a contract; this
one is meant to be one until it is either built or deliberately dropped.

Scope: the Babylon 9 upgrade brought three headline features into the tree
(gaussian splatting, GPU-render particles, subsurface scattering) as ~20 lazy
chunks that never execute. This spec is the verdict on each, plus the one
adjacent idea worth building instead of the feature it came from.

Everything here obeys the rules already in `CLAUDE.md`. Where a proposal comes
close to breaking one, the rule is named.

---

## 0. Rejected, and why it stays rejected

Both of these are recorded so the next person to see the chunk names in a build
log does not have to re-derive the answer.

### Gaussian splatting — never

A splat is a view-dependent radiance blob, not a surface, and every part of this
renderer assumes surfaces with normals.

- `CelShader`'s four-band key light, three-band sky fill, `step(0.72, rim)` and
  two-band toon specular all run off `facetNormal()`. A splat has nothing to
  feed any of them.
- `renderOutline` draws a back-face shell extruded **along each vertex's own
  normal**. That ink is the look, and splats cannot take it.
- It cannot receive the stepped shadow map, cannot be lit by the 16-slot point
  array, and cannot be merged by colour — so it defeats `mergeByMaterial` and
  `BlockMerge` at once, in a tree whose entire draw-call budget rests on them.
- It is sorted alpha, which puts it outside the depth-tested world the
  visual/collider contract is written against.
- It needs trained capture assets (PLY/SPZ, megabytes), against a tree that
  ships zero model files by design.

It would read as a photograph pasted onto a cartoon. Do not revisit.

### Babylon's subsurface scattering — structurally unavailable

Babylon's SSS is a screen-space diffusion pass driven by `PrePassRenderer` and
configured off `PBRMaterial.subSurface`. There is no PBR material anywhere in
this world: the single `PBRMaterial` reference is in the retired `GlbSoldier`,
and it exists only to read the albedo texture off an imported mesh and throw the
material away. Every world surface is a custom `ShaderMaterial` writing
`gl_FragColor` directly, so opting in means rewriting all of them to emit
prepass targets — and enabling exactly the post chain that
`pipeline.imageProcessingEnabled = false` exists to keep out.

The *effect* it stands for is worth having. See §4, which gets it for six lines
of GLSL and one uniform.

---

## 1. `Atmosphere` on `GPUParticleSystem` — BUILT

**The one change with a real visual return, and the one to do first.**

`src/systems/Atmosphere.ts` is a single CPU `ParticleSystem` capped at **1200**
motes, of which Hollowmere asks for `count: 140` (`emitRate = count / 3`). Its
own header says it is "what makes a big dark arena feel like it has air in it
rather than being a vacuum with walls" — and at that density the valley reads as
having specks in it, not air.

`GPUParticleSystem` moves the simulation to transform feedback, so the same CPU
cost buys tens of thousands. The ash becomes weather.

### What changes

`Atmosphere` swaps its `ParticleSystem` for a `GPUParticleSystem` and raises the
cap. Everything `apply()` already sets exists on the GPU class with the same
names — `minEmitBox`/`maxEmitBox`, `color1`/`color2`/`colorDead`,
`minSize`/`maxSize`, `minLifeTime`/`maxLifeTime`, `emitRate`, `blendMode`
(`BLENDMODE_ADD` and `BLENDMODE_STANDARD` both exist), `direction1`/`direction2`,
`gravity`, `minEmitPower`/`maxEmitPower`, `updateSpeed` — so `apply()` is
substantially unchanged.

`ParticleSpec.count` keeps its meaning (motes in the air, not a raw cap) and
Hollowmere's 140 rises to something in the low thousands. That number is a
**look decision to be made at the fog wall**: past 78 m everything is `fogColor`
anyway, so density is only ever judged inside it.

### Rules this touches

- **`Atmosphere` is one system reused across maps**, reconfigured by
  `installMap` via `apply(environment.particles, map.size, map.size)`. That does
  not change. `apply(undefined)` must still stop the emitter.
- **It stays out of `CONFIG`.** Particle *shape* is a map's environment
  (`ParticleSpec` in `world/environment.ts`); only a hard ceiling on the pool
  would belong in `CONFIG.graphics`.

### Costs, honestly

- **This buys density, not frames.** 1200 particles is not the bottleneck here;
  draw calls are, which is why `BlockMerge` exists. Nobody should expect
  performance back, and a large enough count will *cost* fill rate — these are
  alpha-blended quads and the ash field covers the screen.
- **CPU-side control is lost.** Per-particle update callbacks and some
  sorting/blend options do not exist on the GPU class, and
  `stop()`/`reset()`/`dispose()` behave differently. Anything that freezes the
  scene deterministically depends on that pair: the Babylon 9 verification
  harness pinned the ash with exactly `stop()` + `reset()` to get a stable pixel
  diff, and a swap that quietly breaks it makes the next upgrade much harder to
  verify. **Whatever replaces it must be written down here.**
- ~~**Gate on `GPUParticleSystem.IsSupported`** and keep the CPU path as the
  fallback. It needs WebGL2, which the game already requires, so the fallback
  should never fire — but a silently empty sky is a worse failure than a sparse
  one.~~ **Reversed when built — see "As built".** The fallback was written,
  shipped for an afternoon, and then deleted: "should never fire" turned out to
  be "cannot fire", which makes it not a safety net but an untestable branch.
- It pulls `gpuRenderParticles.*` in at runtime, turning precache weight that
  currently never executes into weight that does. No change to the download.

### Verification

Frame time at the square with the count at its final value, against the same
vantage on the CPU path; a screenshot at the chapel looking down the valley
(the one place the field is seen in depth); and confirmation that the
deterministic freeze still works, since the pixel-diff harness depends on it.

### As built

`Atmosphere` is a `GPUParticleSystem` and nothing else; the one ceiling is
`CONFIG.graphics.particlePoolCeiling` (32,000), and the buffer is sized to
whichever spec is applied rather than standing at it — `fit()` rebuilds the
system when a map wants a different number of slots, which it cannot do for a
map re-applying its own module-constant spec. Everything else `apply()` sets is
on `BaseParticleSystem`, so the body is unchanged. Hollowmere's `count` went
140 → **4,000** and its `size` 0.06 → **0.12** — and which of those two did the
work is the finding, below.

**There is no CPU fallback, and the capability gate the proposal asked for is
gone with it.** Babylon derives `supportTransformFeedbacks` from
`_webGLVersion > 1`, so `GPUParticleSystem.IsSupported` is true on *any* WebGL2
context — and WebGL2 is a hard requirement of the game, which is why `main.ts`
registers the service worker before constructing the `Game` at all. The
fallback was therefore not a safety net but a branch no browser that can run
this game will ever take: untestable, and so certain to rot. If that
requirement ever softens, a sparse ash field is not what would need fixing.

**`emitRateControl: true` is the load-bearing constructor option, and it is
what the "whatever replaces the freeze must be written down here" note was
asking for. Nothing replaces it: `stop()` + `reset()` still works, *because* of
that flag.** Babylon 9's GPU system has two modes. The legacy one recycles dead
particles up to `capacity` and adds to its emit accumulator **whether or not
the system is stopped** — under it the pair empties the field and then refills
it over the following second, which is precisely the silent breakage this spec
worried about. Emit-rate control instead holds `emitRate * maxLifeTime` live
slots in a circular buffer (the CPU class's own behaviour) and guards the
accumulator on `!_stopped`. Measured on the shipped config: `getActiveCount()`
climbs to its steady state and then reads **0, 0, 0, 0, 0** across five samples
after `stop()` + `reset()`, and the screenshot pair is a field of motes against
a completely clean frame. A future harness pins the ash exactly as the last one
did.

### What the density actually turned on — the premise this spec got wrong

**"Raise the count and the ash becomes weather" is false, and the whole range
was measured rather than sampled.** Live slots are `ceil(count / 3 * 14)`
exactly — 654 at the old 140, 9,334 at 2,000, 18,667 at 4,000, 37,334 at 8,000,
74,667 at 16,000. Across all of it the picture at street level is
**indistinguishable**: at 74,667 motes there is still no ash visible against a
dark wall. Two reasons compound, and neither is fixed by a bigger number:

- **The emit box is the whole 240 m map.** 18,667 motes over 622,000 m³ is one
  per 33 m³, and past the 78 m fog wall everything is `fogColor` — so most of
  the field is paid for and never seen. What would fix *this* is a
  camera-local emit box, which is not proposed here: it would put the field in
  a frame none of the rest of the map data is written in.
- **A 0.06 m mote is one to three pixels at street distance**, arriving at
  alpha 0.5 and fading to nothing, which puts it under the amplitude of the
  grain pass. Multiplying sub-threshold specks gives more sub-threshold
  specks. Confirmed from the other end with a deliberately absurd `size: 0.9`
  pass that filled the screen with blobs at a *lower* count than shipped — the
  field renders correctly; the authored mote was simply invisible.

**`size` is the lever.** At a fixed 3,000 count: 0.06 reads as nothing, 0.12
reads as flecks against a wall and against the hillside, 0.25 reads as soft
blobs — snow, not ash. Shipped at 0.12, with `count` at 4,000 for coverage
rather than for visibility.

**Count is also the only one of the two that costs.** Measured headless, frame
time roughly doubles between 4,000 and 16,000 (1.39 → 0.65 fps) for no visible
return, while the three sizes at a fixed count differ far less. That is why
`particlePoolCeiling` is set at 32,000 rather than at the 80,000 it briefly
was: the headroom above the shipped count is there for another map, not as an
invitation. Nothing pays for that headroom until a map spends it — Hollowmere
allocates the 18,667 slots it uses.

**The frame-time comparison the spec asked for is still owed.** Headless runs
on SwiftShader, a *software* rasteriser, where alpha quads and transform
feedback cost what they never would on a GPU. The numbers above are sound as
*ratios* between configurations measured the same way, and worthless as
absolutes. There is no CPU-path baseline to compare against any more either,
since that path is deleted — the honest baseline is `8f8a80b`.

## 2. Blast dust in `GrenadeSystem.spawnBlast`

**Second, and small.**

`spawnBlast` already throws 14 pooled ember meshes on an even yaw spread
(`CONFIG.grenade.emberCount/emberSpeed/emberLife`). The gap is not embers — it
is **dust**: a grenade going off in a cobbled square should leave a low
expanding cloud that hangs for a second after the light has gone.

This is affordable for exactly the reason the blast light is exempt from
`spendMuzzleLightBudget`: there are seconds between detonations, and at most a
handful of grenades in the air. A one-shot GPU burst per blast is nothing.

### Rules this touches

- **The embers stay.** They are pooled meshes with their own update in
  `updateEffects`, and they read as debris rather than as smoke. Dust is
  additive to them, not a replacement.
- **It emits on the detonation event, not per victim.** `detonate` already
  hands the position out through `onExploded`; the dust belongs with
  `spawnBlast`, which is where the blast's own visuals live.
- **`installMap` must clear it**, the same way it clears the grenade pool — a
  cloud left standing over terrain that no longer exists is the editor-rebuild
  failure mode that rule exists for.
- Dust is **not** emissive: `BLENDMODE_STANDARD`, occluding, tinted toward
  `mistColor` rather than the flame.

### Verification

`g.grenades` takes `throwAt` directly and `g.grenades.update(1/60)` steps the
flight, so a whole detonation is a synchronous loop inside one `page.evaluate` —
the dust can be screenshotted at a fixed number of steps past the blast without
waiting for a round to develop.

---

## 3. Bog mist wisps — optional

**Third, and skippable.**

The map already carries `mistColor`/`mistHeight`/`mistStrength` (a shader term
in every cel material) and a bog with water in it. A second, low, slow GPU
emitter bounded to the bog would give the one part of Hollowmere that is
supposed to feel wet something moving in it.

Cheap to try once §1 exists, and easy to abandon: it is one more emitter with a
smaller box. It is listed third because the ground mist term already does most
of this job in the shader, and a second reader of the same idea can end up
fighting it — the same trap the bob phase documents. If it does not clearly beat
the shader term alone, drop it.

---

## 4. A translucency band in the cel shader — BUILT

**The idea worth taking from SSS, without taking SSS.**

What subsurface scattering buys visually is light coming *through* a thin
surface rather than off it. There are places here that would read better for it:
the stall and cart canvas with a lamp behind them, the chapel windows, brambles
and thin foliage against the moon.

The cel fragment shader can have it as one more banded term beside the rim and
the toon specular, driven by the key light only:

- a transmission factor from `max(dot(viewDir, lightDir), 0.0)` — how close the
  eye is to looking *into* the light through the surface,
- gated by `max(dot(-n, -lightDir), 0.0)` — the face must be turned away from
  the light for anything to come through it,
- quantised through the existing `band()` so it stays flat, and multiplied by a
  per-material `translucency` colour.

### Why this shape

- **`specColor`/`specShininess` are the precedent, and it should copy them
  exactly.** They are already a per-material opt-in term: `applySpec` writes
  `Color3.Black()` for materials that do not want it, with a comment noting the
  zero colour wins whatever the exponent is, and `getGlossy` is the variant
  constructor that enables it under its own cache key. A translucency term wants
  the same three pieces — a `TranslucencySpec`, an `applyTranslucency`, and a
  `getTranslucent` cached under its own key — and one more entry in `UNIFORMS`.
- **It is banded, not smooth.** A soft falloff here is the thing that would
  actually break the look; the whole point of `step(0.72, rim)` is that nothing
  in this renderer fades.
- **It is gated by the key light's shadow the way the specular is.** Light
  cannot come through a surface the moon does not reach.
- **No prepass, no PBR, no image processing.** Six lines of GLSL and one
  uniform, entirely inside the file that already owns the lighting model.

### The cost to watch

Every cel material takes the extra uniform whether it uses it or not, and the
cache already holds a matte and a glossy variant per colour. A third axis makes
it a matte/glossy/translucent set — so `getTranslucent` should be reachable only
from the handful of builders that actually want it (awnings, glass, foliage),
never wired in by default.

### Verification

This is a look change, so it is judged in a picture: a stall awning with a lamp
behind it, before and after, at the same vantage. The check that matters
alongside it is that **nothing else moved** — a new uniform in `UNIFORMS` is
shared by every cel material in the scene, so the four-vantage pixel diff from
the upgrade should be re-run and come back at the control floor for the views
with no translucent material in them.

### As built

The shape is the proposal's, unchanged, and it is five lines of GLSL and one
uniform:

```glsl
float through = max(dot(viewDir, lightDir), 0.0) * max(dot(n, lightDir), 0.0);
col += transColor * band(through, 2.0) * shadow;
```

`viewDir` runs surface-to-eye and `lightDir` is the direction the light
*travels*, so the two align exactly when the source is on the far side of the
surface from the viewer — the first term needs no negation, and writing it with
one is the easy way to build a term that fires when you turn your back on the
moon. The second is the diffuse term's mirror (`dot(n, -lightDir)` inverted).
It is added past the soft shoulder, beside the specular and for the same
reason.

`specColor`/`specShininess` were copied as promised: `TranslucencySpec`,
`applyTranslucency`, `getTranslucent` under its own cache key, one entry in
`UNIFORMS`, black for everything that does not opt in, and the material named
`cel-trans-#rrggbb` so `outlineInkFor`'s regex still recovers the palette
colour for the ink — that regex is the one place outside the factory that has
to learn a new variant name.

**One uniform, not two.** The specular's precedent argues for a `shininess`
twin, and there is deliberately none: `band(x, 2.0)` already fires at
`through > 0.175` and saturates past `0.825`, which is a hard 41°/75° split,
and the sharpness of that split is a fact about the *look* — the same thing the
diffuse's four bands are — rather than about the material. `TranslucencySpec`
is a colour and an intensity.

**It is a third variant, never a fourth combination.** `getTranslucent`
applies a null spec, so translucent implies matte. The cache is per colour, and
an axis that multiplies is an axis that costs; a surface thin enough to
transmit is not one with a hard Blinn glint on it either.

Two surfaces opted in, both named in the proposal:

- **The market-stall awning** (`buildStall`, via a new `Build.translucentBox`).
  It is the one surface on the map anyone routinely stands *underneath*, which
  is the whole precondition — a roof is not, and did not get it.
- **The pine crown** (`buildPine`). Costs nothing: `NEEDLE`/`NEEDLE_LIT` are
  the pines' own colours, so the translucent material replaces the matte one
  rather than adding a merge group.

The chapel's lancet windows were the third candidate and are **not** wired in.
They are already `glow()` — unlit emissive `StandardMaterial` — so there is no
cel material on them for the term to live on, and the thing translucency would
buy them they already have.

### Measured

Frozen headless (lamp flicker zeroed, ash `stop()`+`reset()`, cloud `uOffset`
pinned, bots disabled, grain off, viewmodel hidden), 1280x720, five vantages,
per-pixel max-channel difference:

| vantage | pre-change vs zeroed | pre-change vs shipped |
| --- | --- | --- |
| under a stall awning | 0.05 mean | **3.09 mean, 39.8% of pixels** |
| the same stall at 5 m | 0.04 | **0.65 mean, 7.9%** |
| the pinewood, moon beyond it | 0.00 | **0.39 mean, 2.0%** |
| control: the chapel | 0.00 | 0.00 mean, 0.00% |
| control: the square, moon behind | 0.04 | 0.01 mean, 0.09% |

**"Nothing else moved" holds, and the residual is not the shader.** The middle
column is the pre-change build against the shipped one with `transColor` forced
to zero at runtime: the extra uniform costs an algebraic `+ vec3(0)` and moves
nothing. What little is left is a sliver of edge pixels on the awnings
themselves — a translucent awning is a *different material*, so it lands in its
own merge group and its outline shell resolves a few pixels differently against
its neighbour. The chapel control is exactly 0.

The diff images are also the check that the term is landing where it should:
at the pinewood the difference is confined to the crowns, and reads as a hard
lit rim down each cone's moonward edge with the body unchanged — which is the
band doing its job rather than a wash.

**It is judged looking INTO the moon and nowhere else.** Both terms are
directional, so a shot taken with the light behind the camera shows nothing
whatever the intensity is; the control vantage above is that, and it is the
control precisely because it cannot move. Hollowmere's moon sits at yaw 2.52,
pitch 0.67.

---

## Order, and what not to touch

1. ~~§1 `Atmosphere` on GPU particles~~ — built; see "As built" above.
2. ~~§4 the translucency band~~ — built; see "As built" above.
3. §2 blast dust — small, and easier once §1 has settled the GPU-particle
   conventions.
4. §3 bog mist — only if §1 makes it obviously cheap, and drop it if it fights
   the shader's mist term.

**Do not put GPU particles on muzzle smoke or brass.** Those are per-shot, at up
to eighty shots a second across sixteen bots. The rule there is pooled effects
reused per shot, never a system allocated per event, and it is the same reasoning
that budgets bot muzzle *lights* — sixteen bots firing is what makes a per-event
cost unaffordable, however cheap one of them is.

**Do not add asset files for any of this.** Every texture these need is
generated at runtime, the way `Atmosphere` already generates its own mote
texture with a `DynamicTexture`.
