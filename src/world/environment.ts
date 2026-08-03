/**
 * environment.ts — EnvironmentSpec: the declarative shape of a map's look
 * (palette, lighting direction, fog, mist, sky, water, particles) plus
 * applyEnvironment(), which pushes it into the cel materials and scene.
 * Pure data in, uniforms out — a second map adds one new spec, no code here.
 */
import { Color3, Color4, Scene, Vector3 } from "@babylonjs/core";
import type { CelMaterialFactory } from "../shaders/CelShader";

/** A dynamic point light carried by a prop, registered when the prop is placed. */
export interface LightSpec {
  color: string;
  /** World units at prop scale 1. */
  range: number;
  intensity: number;
  /** Local offset from the prop origin; scales with the prop. */
  offset: [number, number, number];
  /** 0 steady .. 1 wild (flame ~.35, neon ~.9). */
  flicker: number;
}

/** Drifting mote field: ash, spores, embers. */
export interface ParticleSpec {
  color: string;
  emissive: boolean;
  count: number;
  size: number;
  /** Positive rises (embers), negative falls (ash). */
  riseSpeed: number;
}

/**
 * The night-sky palette. Everything here is baked or tinted by `Sky`
 * (`src/systems/Sky.ts`); geometry (dome radius, cloud layer heights, scroll
 * speeds) lives in `CONFIG.sky`. Omitting it leaves the bare clear colour.
 */
export interface SkySpec {
  /** Top of the dome gradient. */
  zenithColor: string;
  /**
   * Bright band at the horizon line. Should sit close to `fogColor` so the
   * dome melts into the fogged ridge instead of cutting against it.
   */
  horizonColor: string;
  /** Baked star field: colour, count, and 0..1 brightness. */
  starColor: string;
  starCount: number;
  starBrightness: number;
  /**
   * The moon hangs opposite the key light's direction, so the disc always
   * agrees with the shadows. This is just its colour — size is `CONFIG.sky`.
   */
  moonColor: string;
  /**
   * The broad scattering halo baked around the moon: the air near it lit up,
   * not the disc itself. Wants to be cooler and dimmer than `moonColor` —
   * this is the term that decides whether the sky reads as lit or as black.
   */
  moonGlowColor: string;
  /** Faint galactic band. Omit for an empty sky. */
  milkyWayColor?: string;
  /** Drifting cloud decks: tint (the shadowed body) and 0..1 ceiling alpha. */
  cloudColor: string;
  cloudOpacity: number;
  /**
   * The silver a deck takes on where the moon is behind it, added on a second
   * shell so the lit patch stays anchored to the moon while the cloud texture
   * scrolls through it. Strength is that shell's peak alpha.
   */
  cloudLitColor: string;
  cloudLitStrength: number;
}

/** Shallow-water palette. Omitting it leaves the map dry. */
export interface WaterEnvSpec {
  /** Body colour looking straight down. */
  deepColor: string;
  /** Colour the surface tips toward at grazing angles — the sky sheen. */
  shallowColor: string;
  /** Shoreline foam and drifting flecks. */
  foamColor: string;
}

/** Grass-field palette. Omitting it leaves the map bald. */
export interface GrassEnvSpec {
  /** Blade colour at the root — should sit close to floorColor so the field
   *  reads as growing out of the ground, not scattered on top of it. */
  rootColor: string;
  /** Blade colour at the tip — the part that catches the key light. */
  tipColor: string;
}

/**
 * Everything the renderer needs to make a place feel like one place: palette,
 * atmosphere, and the three light terms the cel shader bands.
 *
 * This is the old `RoomTheme.environment` minus `props` — a hand-laid map
 * carries its own placements, so the environment no longer owns a prop roster.
 */
export interface EnvironmentSpec {
  floorColor: string;
  wallColor: string;
  wallTrimColor: string;
  accentColor: string;
  skyColor: string;
  fogColor: string;
  fogStart: number;
  fogEnd: number;
  mistColor: string;
  mistHeight: number;
  mistStrength: number;
  lighting: {
    color: string;
    intensity: number;
    /** Normalized on load. */
    direction: [number, number, number];
    ambientColor: string;
    ambientIntensity: number;
    /**
     * Hemispheric fill from the sky itself, applied by n.y: full on up-facing
     * surfaces, nothing underneath, and never gated by the shadow map. Flat
     * ambient alone lifts every face equally and reads as a grey wash; this is
     * what makes ground and roofs look moonlit while walls stay dark. Should
     * sit close to the sky's own zenith/horizon colours.
     */
    skyLightColor: string;
    skyLightIntensity: number;
    rimColor: string;
    rimIntensity: number;
  };
  particles?: ParticleSpec;
  water?: WaterEnvSpec;
  grass?: GrassEnvSpec;
  sky?: SkySpec;
}

/**
 * Push an environment into the scene clear color and every cel material's
 * lighting/fog uniforms. The scene has no Babylon lights — this is how light
 * reaches the shader.
 */
export function applyEnvironment(
  scene: Scene,
  env: EnvironmentSpec,
  mats: CelMaterialFactory,
): void {
  const sky = Color3.FromHexString(env.skyColor);
  scene.clearColor = new Color4(sky.r, sky.g, sky.b, 1);

  const [dx, dy, dz] = env.lighting.direction;
  const lit = env.lighting;
  mats.setEnvironment({
    lightDir: new Vector3(dx, dy, dz),
    lightColor: Color3.FromHexString(lit.color).scale(lit.intensity),
    ambientColor: Color3.FromHexString(lit.ambientColor).scale(
      lit.ambientIntensity,
    ),
    skyLightColor: Color3.FromHexString(lit.skyLightColor).scale(
      lit.skyLightIntensity,
    ),
    rimColor: Color3.FromHexString(lit.rimColor).scale(lit.rimIntensity),
    fogColor: Color3.FromHexString(env.fogColor),
    fogStart: env.fogStart,
    fogEnd: env.fogEnd,
    mistColor: Color3.FromHexString(env.mistColor),
    mistHeight: env.mistHeight,
    mistStrength: env.mistStrength,
  });
}
