/**
 * config/world.ts — the map's extents and its surface dressing.
 * Owns: map size, water and grass. Contract: `docs/world.md`.
 * Gotcha: water and grass are VISUAL ONLY — no collider, no picking. Their
 * palettes live in the map's `EnvironmentSpec`; this is motion and shape.
 */

/** Map extents. The village is authored inside this square, centred on origin. */
export const map = {
  size: 240,
} as const;

/**
 * Baked per-vertex ambient occlusion (`world/ambientOcclusion.ts`). Costs
 * nothing per frame — it is a vertex attribute written once per map build —
 * so both numbers are about the LOOK rather than about the budget.
 */
export const ao = {
  /**
   * How far an occluder reaches, in metres.
   *
   * This is the size of the shading, not its strength: at 2.5 m a doorway, the
   * inside of an arch and the foot of a wall all darken, while a street with a
   * cottage on the far side does not. Pushing it out starts shading whole
   * facades from their neighbours, which reads as dirt rather than as form —
   * and it is the one number here that costs build time, quadratically, since
   * it decides how many boxes each vertex has to ask.
   */
  radius: 2.5,
  /**
   * How dark a fully occluded vertex goes, as a fraction of the ambient and
   * sky-fill terms.
   *
   * It multiplies only those two — the key light has a shadow map of its own
   * and the point lights deliberately ignore occlusion, the same way they
   * ignore the shadow map, so a lantern in a doorway still lights the doorway.
   * That is also why this can be as strong as it is: it is a fraction of the
   * dimmest light in the scene, not of the frame.
   *
   * 0 disables the bake entirely, and disables it at the source — no attribute
   * is written, so every mesh falls back to the unoccluded default.
   */
  strength: 0.55,
} as const;

/**
 * Shallow surface water (the creek at B, the bog at E). Visual only — the
 * planes carry no collider, so wading is free and swimming never comes up.
 * Palette lives in the map's EnvironmentSpec; this is motion and shape.
 */
export const water = {
  /** Default surface height above the ground plane: ankle-deep. */
  surfaceY: 0.32,
  /**
   * Normal-map tiling (uv repeats per metre) for the three scrolled layers:
   * swell, chop, ripple — periods of 20 m, 7 m and 2.9 m.
   *
   * **These have a floor, and it is a sampling limit rather than a taste.**
   * The tile is 512 px, so a layer at 0.38 uv/m puts a texel every 5 mm, which
   * at any range a player actually stands from water is finer than a pixel:
   * the layer stops being ripples and becomes a moire lattice that the shader
   * cannot rotate or warp its way out of, because it is aliasing rather than
   * repetition. Measured on Greyfen's flood — the checker is plainly there at
   * 0.38 and gone at 0.14. Do not tighten these to get "more detail"; that is
   * the trade that put the pattern on screen in the first place.
   */
  waveScale1: 0.05,
  waveScale2: 0.14,
  waveScale3: 0.34,
  /**
   * Scroll speeds (uv per second); the layers cross at an angle. These are uv,
   * so they are tied to the scales above — a layer's world speed is
   * `waveSpeedN / waveScaleN` m/s, and the three sit at 0.32, 0.21 and 0.15.
   */
  waveSpeed1: 0.016,
  waveSpeed2: 0.029,
  waveSpeed3: 0.05,
  /** 0 = mirror flat, 1 = the normal map's full relief. */
  waveStrength: 0.6,
  /**
   * How far each layer drags the one above it (uv). The whole point is that a
   * warped lattice is no longer a lattice: without it three tiled layers just
   * beat against each other and the beat is as regular as the tile.
   */
  warpStrength: 0.11,
  /**
   * Range (m) over which the fine layers fade out. Past it a normal-map texel
   * is smaller than a pixel and the tiling aliases into a moire grid, which is
   * the same complaint from the other end. The swell layer never fades — the
   * surface must not flatten into a mirror, or the glint turns into a sheet.
   */
  detailFade: 34,
  /** Moon glint: Blinn exponent and brightness. */
  specPower: 90,
  specStrength: 0.9,
  /** How fast the view angle tips the body from deep to shallow colour. */
  fresnelPower: 2.2,
  /** Shoreline foam: band width (m), mask tiling, mask scroll speed. */
  foamWidth: 0.7,
  foamScale: 0.3,
  foamSpeed: 0.04,
  /**
   * The baked bed-depth map (see `WaterSystem.bakeDepth`) and what reads it.
   * `depthMax` is the depth the byte saturates at, so it only has to cover the
   * deepest bed under any rect; `texels` is its resolution in texels per metre
   * and `texelsMax` the cap a map-wide rect hits.
   */
  depthMax: 1.5,
  depthTexels: 2,
  depthTexelsMax: 512,
  /** Depth (m) at which the shoreline foam has faded out. */
  foamDepth: 0.12,
  /** Depth (m) over which the body reaches its deep colour. */
  depthFade: 0.55,
  /** How far shallow water is pulled toward the shallow colour (0..1). */
  depthTint: 0.35,
} as const;

/**
 * Grass fields (src/systems/GrassSystem.ts): thin-instanced tufts with a
 * vertex-shader wind sway plus a radial "pusher" bend around every nearby
 * combatant — the ripple as you run through it. Visual only: no collider,
 * no picking, no outline. Palette lives in the map's EnvironmentSpec.
 */
export const grass = {
  /** Tufts per square metre when a rect doesn't override density. One tuft
   *  is `bladesPerTuft` blades, so this is ~5x that in blades. */
  density: 1.1,
  bladesPerTuft: 5,
  /**
   * Blade height range (metres). Knee-high at the top end — tall enough to
   * read as a field and to swallow boots, short enough that it never hides
   * a crawling firefight.
   */
  heightMin: 0.45,
  heightMax: 0.85,
  /** Ambient wind: XZ direction (normalized on use), tip travel (m), speed. */
  windDir: [0.78, 0.63],
  windStrength: 0.16,
  windSpeed: 1.7,
  /**
   * Character interaction: how far out a body bends blades (m) and how far
   * the tip travels at ground zero (m). The radius wants to be just past a
   * sprint stride so the grass reacts ahead of the feet, not under them.
   */
  pushRadius: 1.35,
  pushStrength: 0.6,
  /**
   * Shader array size for simultaneous pushers. The player plus the seven
   * nearest bots; beyond that the bend is outside reading distance anyway.
   */
  maxPushers: 8,
} as const;
