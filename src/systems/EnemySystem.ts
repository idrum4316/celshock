import { Scene, Vector3 } from "@babylonjs/core";
import { Boss } from "../entities/Boss";
import { Enemy } from "../entities/Enemy";
import type { AICtx } from "../entities/Enemy";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { Hittable } from "./CombatSystem";
import type { EnemyType, RoomTheme } from "../themes/types";

/**
 * Owns every hostile in the current room: spawning from the room's theme,
 * per-frame AI updates, separation, death cleanup, and the room-clear check.
 */
export class EnemySystem {
  enemies: Enemy[] = [];
  boss: Boss | null = null;
  /** Wired by Game: fired once per enemy death (sfx + loot rolls). */
  onEnemyDied: (pos: Vector3) => void = () => {};
  onBossDied: () => void = () => {};

  constructor(
    private scene: Scene,
    private mats: CelMaterialFactory,
  ) {}

  /** Spawns a themed wave at the room's spawn points. */
  spawnWave(theme: RoomTheme, spawnPoints: Vector3[], count: number): void {
    for (let i = 0; i < count && i < spawnPoints.length; i++) {
      // Cycle the roster so every type in the theme shows up.
      const type = theme.enemies[i % theme.enemies.length];
      this.enemies.push(new Enemy(this.scene, this.mats, type, spawnPoints[i]));
    }
  }

  spawnBoss(theme: RoomTheme, pos: Vector3): void {
    this.boss = new Boss(this.scene, this.mats, theme.boss, pos);
  }

  /** Used by bosses to summon reinforcements mid-fight. */
  spawnMinion(type: EnemyType, pos: Vector3): void {
    this.enemies.push(new Enemy(this.scene, this.mats, type, pos));
  }

  update(dt: number, ctx: AICtx): void {
    for (const enemy of this.enemies) {
      enemy.update(dt, ctx);
      if (enemy.justDied) {
        enemy.justDied = false;
        this.onEnemyDied(enemy.root.position.clone());
      }
    }

    // Pairwise separation so ground units don't stack.
    for (let i = 0; i < this.enemies.length; i++) {
      const a = this.enemies[i];
      if (a.state === "dying" || a.type.kind === "flyer") continue;
      for (let j = i + 1; j < this.enemies.length; j++) {
        const b = this.enemies[j];
        if (b.state === "dying" || b.type.kind === "flyer") continue;
        const dx = b.root.position.x - a.root.position.x;
        const dz = b.root.position.z - a.root.position.z;
        const d2 = dx * dx + dz * dz;
        const min = 1.4;
        if (d2 < min * min && d2 > 0.0001) {
          const d = Math.sqrt(d2);
          const push = (min - d) / 2;
          const nx = dx / d;
          const nz = dz / d;
          a.root.position.x -= nx * push;
          a.root.position.z -= nz * push;
          b.root.position.x += nx * push;
          b.root.position.z += nz * push;
        }
      }
    }

    // Cull finished corpses.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i].dead) {
        this.enemies[i].dispose();
        this.enemies.splice(i, 1);
      }
    }

    if (this.boss) {
      this.boss.update(dt, ctx);
      if (this.boss.justDied) {
        this.boss.justDied = false;
        this.onBossDied();
      }
    }
  }

  /** Everything the player's hitscan can currently hit. */
  getHittables(): Hittable[] {
    const list: Hittable[] = this.enemies.filter((e) => e.state !== "dying");
    if (this.boss && !this.boss.dead) list.push(this.boss);
    return list;
  }

  /** True when the room is finished (boss must complete its death anim). */
  get cleared(): boolean {
    const enemiesGone = this.enemies.every((e) => e.state === "dying" || e.dead);
    const bossGone = this.boss === null || this.boss.dead;
    return enemiesGone && bossGone;
  }

  get bossFraction(): number | null {
    return this.boss ? this.boss.hpFraction : null;
  }

  disposeAll(): void {
    for (const enemy of this.enemies) enemy.dispose();
    this.enemies.length = 0;
    this.boss?.dispose();
    this.boss = null;
  }
}
