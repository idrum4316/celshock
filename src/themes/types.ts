import type { Mesh, Scene } from "@babylonjs/core";
import type { CelMaterialFactory } from "../shaders/CelShader";

/** Body archetypes used to procedurally build enemy meshes. */
export type EnemyBody = "quad" | "sphere" | "capsule" | "wraith";

/** High-level AI behavior class. */
export type EnemyKind = "melee" | "ranged" | "flyer";

export interface EnemyType {
  name: string;
  kind: EnemyKind;
  body: EnemyBody;
  /** Main body color (hex). */
  color: string;
  /** Accent/head color (hex). */
  accentColor: string;
  /** Emissive eye/core color — the thing you see first in the dark. */
  eyeColor: string;
  scale: number;
  health: number;
  speed: number;
  damage: number;
  /** Melee: strike distance. Ranged: maximum firing distance. */
  attackRange: number;
  attackCooldown: number;
  projectileSpeed?: number;
  projectileColor?: string;
}

/** Boss fight archetype — each theme's boss uses one distinct pattern. */
export type BossPattern = "slam" | "burst" | "burrow";

export interface BossType {
  name: string;
  pattern: BossPattern;
  color: string;
  accentColor: string;
  /** Emissive eye/core color. */
  eyeColor: string;
  scale: number;
  health: number;
  speed: number;
  /** Damage dealt on contact (or dash hit for `burst` bosses). */
  contactDamage: number;
  /** Seconds between special attacks. */
  attackCooldown: number;
  projectileSpeed?: number;
  projectileColor?: string;
  aoeRadius?: number;
  aoeDamage?: number;
}

/** A dynamic light carried by a prop (torch flame, neon tube, fungus glow). */
export interface LightSpec {
  color: string;
  /** Radius where the light falls to zero, in world units at prop scale 1. */
  range: number;
  intensity: number;
  /** Local offset from the prop origin; scales with the prop. */
  offset: [number, number, number];
  /** 0 = steady, 1 = wild flicker (flame ~0.35, broken neon ~0.9). */
  flicker: number;
}

export interface PropSpec {
  name: string;
  /**
   * [min, max] instances per room at the baseline room area; the generator
   * scales these up with the arena's actual footprint.
   */
  countRange: [number, number];
  /** Blocking props collide with the player and steer enemies. */
  blocking: boolean;
  /** Approximate obstacle radius at scale 1 (for AI avoidance). */
  radius: number;
  scaleRange: [number, number];
  /** Attaches a dynamic point light to every instance of this prop. */
  light?: LightSpec;
  /** Builds the prop mesh at the origin; the generator positions/scales it. */
  build(scene: Scene, mats: CelMaterialFactory): Mesh;
}

/** Drifting motes (ash, spores, dust) that sell the air in a room. */
export interface ParticleSpec {
  color: string;
  /** Emissive motes glow through the dark; dull ones just catch fog. */
  emissive: boolean;
  count: number;
  size: number;
  /** Positive drifts upward (embers), negative falls (ash, snow). */
  riseSpeed: number;
}

/**
 * A room theme bundles everything needed for internal consistency:
 * environment palette + atmosphere + props, the enemy roster, and the boss.
 */
export interface RoomTheme {
  name: string;
  environment: {
    floorColor: string;
    wallColor: string;
    wallTrimColor: string;
    accentColor: string;
    skyColor: string;
    fogColor: string;
    fogStart: number;
    fogEnd: number;
    /** Low-lying ground haze. */
    mistColor: string;
    /** Height (world units) over which the mist thins out. */
    mistHeight: number;
    /** 0..1 peak mist opacity at floor level. */
    mistStrength: number;
    lighting: {
      color: string;
      intensity: number;
      /** Directional light vector (normalized at load). */
      direction: [number, number, number];
      /** Color of the unlit side — sets how black the shadows go. */
      ambientColor: string;
      ambientIntensity: number;
      /** Rim highlight tint (moon edge light). */
      rimColor: string;
      rimIntensity: number;
    };
    particles?: ParticleSpec;
    props: PropSpec[];
  };
  enemies: EnemyType[];
  boss: BossType;
}
