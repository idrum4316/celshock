import type { Mesh, Scene } from "@babylonjs/core";
import type { CelMaterialFactory } from "../shaders/CelShader";

/** Placeholder body archetypes used to procedurally build enemy meshes. */
export type EnemyBody = "capsule" | "sphere" | "quad";

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

export interface PropSpec {
  name: string;
  /** [min, max] instances per room. */
  countRange: [number, number];
  /** Blocking props collide with the player and steer enemies. */
  blocking: boolean;
  /** Approximate obstacle radius at scale 1 (for AI avoidance). */
  radius: number;
  scaleRange: [number, number];
  /** Builds the prop mesh at the origin; the generator positions/scales it. */
  build(scene: Scene, mats: CelMaterialFactory): Mesh;
}

/**
 * A room theme bundles everything needed for internal consistency:
 * environment palette + props, the enemy roster, and the theme's boss.
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
    lighting: {
      color: string;
      intensity: number;
      /** Directional light vector (normalized at load). */
      direction: [number, number, number];
    };
    props: PropSpec[];
  };
  enemies: EnemyType[];
  boss: BossType;
}
