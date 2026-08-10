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
 * Shallow surface water (the creek at B, the bog at E). Visual only — the
 * planes carry no collider, so wading is free and swimming never comes up.
 * Palette lives in the map's EnvironmentSpec; this is motion and shape.
 */
export const water = {
  /** Default surface height above the ground plane: ankle-deep. */
  surfaceY: 0.32,
  /** Normal-map tiling (uv repeats per metre) for the two scrolled layers. */
  waveScale1: 0.14,
  waveScale2: 0.38,
  /** Scroll speeds (uv per second); the layers cross at an angle. */
  waveSpeed1: 0.045,
  waveSpeed2: 0.08,
  /** 0 = mirror flat, 1 = the normal map's full relief. */
  waveStrength: 0.6,
  /** Moon glint: Blinn exponent and brightness. */
  specPower: 90,
  specStrength: 0.9,
  /** How fast the view angle tips the body from deep to shallow colour. */
  fresnelPower: 2.2,
  /** Shoreline foam: band width (m), mask tiling, mask scroll speed. */
  foamWidth: 1.1,
  foamScale: 0.3,
  foamSpeed: 0.04,
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
