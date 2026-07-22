import {
  DefaultRenderingPipeline,
  Engine,
  GlowLayer,
  HemisphericLight,
  Mesh,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import { CelMaterialFactory } from "../shaders/CelShader";
import { Player } from "../entities/Player";
import { Viewmodel } from "../entities/Viewmodel";
import type { AICtx } from "../entities/Enemy";
import { CombatSystem } from "../systems/CombatSystem";
import { EnemySystem } from "../systems/EnemySystem";
import { LootSystem, PickupKind } from "../systems/LootSystem";
import { Room, RoomGenerator } from "../systems/RoomGenerator";
import { ThemeManager } from "../systems/ThemeManager";
import { HUD } from "../ui/HUD";
import { CameraSystem } from "./CameraSystem";
import { InputManager } from "./InputManager";
import { Sfx } from "./Sfx";
import type { RoomTheme } from "../themes/types";

type GameState = "menu" | "fighting" | "cleared" | "gameover" | "victory";

/**
 * Top-level orchestrator: owns the engine/scene, all systems, the game
 * state machine (menu -> fighting -> cleared -> ... -> victory/gameover),
 * and the per-frame update loop.
 */
export class Game {
  private engine: Engine;
  private scene: Scene;
  private mats: CelMaterialFactory;
  private input: InputManager;
  private cameraSys: CameraSystem;
  private hud: HUD;
  private sfx: Sfx;
  private themeManager: ThemeManager;
  private roomGenerator: RoomGenerator;
  private combat: CombatSystem;
  private enemySys: EnemySystem;
  private loot: LootSystem;
  private player: Player;
  private viewmodel: Viewmodel;

  private state: GameState = "menu";
  private room: Room | null = null;
  private roomIndex = 0;
  private theme: RoomTheme | null = null;
  /** Small delay so overlay confirms aren't triggered by held buttons. */
  private overlayT = 0;
  private aiCtx: AICtx;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { stencil: true });
    this.scene = new Scene(this.engine);
    this.scene.collisionsEnabled = true;

    // Effects use unlit emissive materials; cel materials carry their own
    // light uniforms, so one soft ambient light is all the scene needs.
    new HemisphericLight("ambient", new Vector3(0, 1, 0), this.scene);

    this.mats = new CelMaterialFactory(this.scene);
    this.input = new InputManager(canvas);
    this.cameraSys = new CameraSystem(this.scene);

    // Post-processing: FXAA smooths the hard cel/outline edges. Glow comes
    // from a GlowLayer rather than threshold bloom — it keys off material
    // emissive color, so neon/reticle/tracer meshes bloom while the bright
    // desert sand (high luminance but not emissive) stays crisp.
    const g = CONFIG.graphics;
    const pipeline = new DefaultRenderingPipeline("post", false, this.scene, [
      this.cameraSys.camera,
    ]);
    // The cel shader outputs display-ready colors; the default image
    // processing pass would re-apply gamma and wash them out.
    pipeline.imageProcessingEnabled = false;
    pipeline.fxaaEnabled = true;
    const glow = new GlowLayer("glow", this.scene, {
      blurKernelSize: g.glowKernel,
    });
    glow.intensity = g.glowIntensity;
    this.sfx = new Sfx();
    this.hud = new HUD();
    this.themeManager = new ThemeManager();
    this.roomGenerator = new RoomGenerator(this.scene, this.mats);
    this.combat = new CombatSystem(this.scene, this.mats);
    this.enemySys = new EnemySystem(this.scene, this.mats);
    this.loot = new LootSystem(this.scene, this.mats);
    this.player = new Player(this.scene, this.mats);
    this.player.setFirstPerson(true); // hidden until a run starts
    this.viewmodel = new Viewmodel(this.scene, this.mats, this.cameraSys.camera);
    for (const m of this.scene.meshes) {
      if (m.metadata && m.metadata.noGlow === true) glow.addExcludedMesh(m as Mesh);
    }

    // --- system wiring ---
    this.combat.onPlayerHit = (dmg) => this.damagePlayer(dmg);
    this.enemySys.onEnemyDied = (pos) => {
      this.sfx.enemyDie();
      if (Math.random() < CONFIG.enemies.healthDropChance) {
        this.loot.spawnHealthOrb(pos);
      }
    };
    this.enemySys.onBossDied = () => this.sfx.bossRoar();

    this.aiCtx = {
      playerPos: this.player.position,
      playerGrounded: true,
      damagePlayer: (dmg) => this.damagePlayer(dmg),
      fireProjectile: (from, dir, speed, dmg, color) =>
        this.combat.fireEnemyProjectile(from, dir, speed, dmg, color),
      shockwave: (center, radius, color) => this.combat.shockwave(center, radius, color),
      spawnMinion: (pos) => {
        if (this.theme) {
          this.enemySys.spawnMinion(this.theme.enemies[0], pos);
        }
      },
      bounds: { width: 40, depth: 40 },
      obstacles: [],
      sfx: this.sfx,
    };

    // Pointer lock + audio unlock must happen inside a user gesture.
    // (pointerdown, not click: Babylon may preventDefault the pointer event,
    // which suppresses the compatibility click event entirely.)
    document.addEventListener("pointerdown", () => {
      this.sfx.unlock();
      if (!this.input.pointerLocked && this.state !== "gameover" && this.state !== "victory") {
        canvas.requestPointerLock();
      }
    });
    window.addEventListener("keydown", () => this.sfx.unlock(), { once: true });
    window.addEventListener("resize", () => this.engine.resize());

    this.hud.showMenu();
    // Debug/test handle (used by automated smoke tests).
    (window as unknown as { __celshock: Game }).__celshock = this;
    this.engine.runRenderLoop(() => this.tick());
  }

  private tick(): void {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    this.input.update();

    switch (this.state) {
      case "menu":
      case "gameover":
      case "victory":
        this.overlayT += dt;
        if (this.input.confirmPressed && this.overlayT > 0.5) {
          this.startRun();
        }
        break;
      case "fighting":
      case "cleared":
        this.updateGameplay(dt);
        break;
    }

    this.hud.update(dt);
    this.scene.render();
  }

  private startRun(): void {
    this.hud.hideOverlay();
    this.roomIndex = 0;
    this.player.fullReset();
    this.nextRoom();
  }

  private nextRoom(): void {
    this.roomIndex += 1;
    const isBossRoom = this.roomIndex === CONFIG.run.roomsPerRun;

    // Tear down the previous room.
    this.room?.dispose();
    this.enemySys.disposeAll();
    this.combat.clearTransient();
    this.loot.clear();

    // Build the next one from a fresh theme.
    this.theme = this.themeManager.pick();
    this.themeManager.apply(this.scene, this.theme, this.mats);
    this.room = this.roomGenerator.generate(this.theme, this.roomIndex, isBossRoom);

    this.combat.bounds = { width: this.room.width, depth: this.room.depth };
    this.aiCtx.bounds = this.combat.bounds;
    this.aiCtx.obstacles = this.room.obstacles;

    this.player.placeAt(this.room.playerSpawn);
    this.cameraSys.reset(this.room.playerYaw);

    if (isBossRoom) {
      this.enemySys.spawnBoss(this.theme, this.room.bossSpawn);
      this.hud.setBoss(this.theme.boss.name, 1);
      this.hud.showMessage(`BOSS: ${this.theme.boss.name.toUpperCase()}`, 3);
      this.sfx.bossRoar();
    } else {
      const count = Math.min(
        CONFIG.enemies.baseCount + (this.roomIndex - 1) * CONFIG.enemies.perRoomExtra,
        CONFIG.enemies.maxCount,
      );
      this.enemySys.spawnWave(this.theme, this.room.enemySpawns, count);
      this.hud.setBoss(null, 0);
      this.hud.showMessage(`${this.theme.name.toUpperCase()}`, 2);
    }

    this.hud.setRoom(this.roomIndex, CONFIG.run.roomsPerRun, this.theme.name);
    this.state = "fighting";
  }

  private updateGameplay(dt: number): void {
    const room = this.room!;

    // --- player ---
    const jumped = this.player.update(dt, this.input, this.cameraSys);
    if (jumped) this.sfx.jump();
    if (this.input.reloadPressed && this.player.startReload()) this.sfx.reload();

    // --- shooting (hitscan from the camera through the crosshair) ---
    // Mouse fire requires pointer lock so UI clicks never discharge the gun.
    const canFire = this.input.pointerLocked || this.input.gamepadConnected;
    if (this.input.fire && canFire && this.player.tryShot()) {
      const w = CONFIG.weapon;
      const blend = this.cameraSys.adsBlend;
      const spread = w.spreadHip + (w.spreadAds - w.spreadHip) * blend;
      // Tracers start at whichever rifle is on screen: the first-person
      // viewmodel while sighted in, the character's rifle otherwise.
      const muzzle = this.cameraSys.isFirstPerson
        ? this.viewmodel.muzzleWorld()
        : this.player.muzzleWorld();
      const result = this.combat.playerFire(
        this.cameraSys.camera.position,
        this.cameraSys.forward,
        spread,
        this.player.damage,
        muzzle,
        this.enemySys.getHittables(),
      );
      this.viewmodel.kick();
      this.sfx.shoot();
      if (result === "enemy") {
        this.hud.flashHitmarker();
        this.sfx.hit();
      }
      if (this.player.reloading) this.sfx.reload();
    }

    // --- enemies & combat effects ---
    // Always update the enemy system so death animations finish even after
    // the room flips to "cleared".
    this.aiCtx.playerPos = this.player.position;
    this.aiCtx.playerGrounded = this.player.grounded;
    this.enemySys.update(dt, this.aiCtx);

    if (this.state === "fighting") {
      const bossFrac = this.enemySys.bossFraction;
      if (bossFrac !== null && this.theme) {
        this.hud.setBoss(this.theme.boss.name, bossFrac);
      }

      if (this.enemySys.cleared) {
        if (room.isBossRoom) {
          this.state = "victory";
          this.overlayT = 0;
          this.hud.setBoss(null, 0);
          this.viewmodel.setVisible(false);
          this.hud.showVictory();
          document.exitPointerLock();
        } else {
          this.state = "cleared";
          room.open(this.mats);
          this.loot.spawnRandomPowerup(new Vector3(0, 0, 0));
          this.hud.showMessage("ROOM CLEARED — LOOT UP AND HEAD THROUGH THE DOOR", 3.5);
          this.sfx.doorOpen();
        }
      }
    } else if (this.state === "cleared") {
      // Walk into the open doorway to advance.
      const toDoor = this.player.position.subtract(room.doorPos);
      toDoor.y = 0;
      if (toDoor.length() < CONFIG.room.doorTriggerDistance) {
        this.nextRoom();
        return;
      }
    }

    this.combat.update(dt, this.player.position);
    this.loot.update(dt, this.player.position, (kind) => this.applyPickup(kind));
    room.update(dt);

    // --- camera & rendering support ---
    this.cameraSys.update(dt, this.input, this.player.position);
    this.mats.updateCamera(this.cameraSys.camera.position);
    this.player.setFirstPerson(this.cameraSys.isFirstPerson);
    this.viewmodel.update(dt, this.cameraSys, this.input, this.player);

    // --- HUD ---
    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setAmmo(this.player.ammo, this.player.magSize, this.player.reloading);
    // The holo reticle replaces the DOM crosshair once first-person.
    this.hud.setAds(this.cameraSys.isFirstPerson);
    this.hud.setLockHint(!this.input.pointerLocked && !this.input.gamepadConnected);
  }

  private damagePlayer(amount: number): void {
    if (this.state !== "fighting" && this.state !== "cleared") return;
    if (!this.player.alive) return;
    const died = this.player.takeDamage(amount);
    this.hud.flashDamage();
    this.sfx.playerHurt();
    if (died) {
      this.state = "gameover";
      this.overlayT = 0;
      this.hud.setBoss(null, 0);
      this.viewmodel.setVisible(false);
      this.hud.showGameOver(this.roomIndex, CONFIG.run.roomsPerRun);
      document.exitPointerLock();
    }
  }

  private applyPickup(kind: PickupKind): void {
    const loot = CONFIG.loot;
    this.sfx.pickup();
    switch (kind) {
      case "health":
        this.player.heal(loot.healthOrbHeal);
        this.hud.toast(`+${loot.healthOrbHeal} HP`);
        break;
      case "damage":
        this.player.mods.damageMult += loot.damageBonus;
        this.hud.toast(`DAMAGE +${Math.round(loot.damageBonus * 100)}%`);
        break;
      case "speed":
        this.player.mods.speedMult += loot.speedBonus;
        this.hud.toast(`SPEED +${Math.round(loot.speedBonus * 100)}%`);
        break;
      case "maxhp":
        this.player.mods.maxHpBonus += loot.maxHpBonus;
        this.player.heal(loot.maxHpBonus);
        this.hud.toast(`MAX HP +${loot.maxHpBonus}`);
        break;
      case "mag":
        this.player.mods.magBonus += loot.magBonus;
        this.hud.toast(`MAG SIZE +${loot.magBonus}`);
        break;
    }
  }
}
