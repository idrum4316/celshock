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
    rimColor: string;
    rimIntensity: number;
  };
  particles?: ParticleSpec;
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
    rimColor: Color3.FromHexString(lit.rimColor).scale(lit.rimIntensity),
    fogColor: Color3.FromHexString(env.fogColor),
    fogStart: env.fogStart,
    fogEnd: env.fogEnd,
    mistColor: Color3.FromHexString(env.mistColor),
    mistHeight: env.mistHeight,
    mistStrength: env.mistStrength,
  });
}
