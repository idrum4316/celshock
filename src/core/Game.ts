/**
 * Game.ts — Orchestrator: engine/scene init, state machine, main loop, and ALL
 * cross-system wiring. The only place systems meet — systems never import each
 * other; new cross-system behavior is a callback wired here.
 * State machine: menu -> deploy -> playing (deploy re-entered on each death)
 * -> roundover. The 3D scene renders live behind every state.
 * Load-bearing frame order at the end of updateGameplay: camera update ->
 * mats.updateCamera() -> carried lights -> lighting.update() -> sfx.setListener().
 * ConquestSystem.update runs before BattleSystem.update (bots see this frame's
 * flag ownership). Muzzle-flash light budget is spent here
 * (spendMuzzleLightBudget) — new per-bot transient lights need the same treatment.
 * Also owns: GlowLayer scan (construction-time only; metadata.noGlow contract),
 * pipeline.imageProcessingEnabled === false, window.__celshock debug handle.
 */
import {
  DefaultRenderingPipeline,
  Engine,
  GlowLayer,
  Mesh,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import { CelMaterialFactory } from "../shaders/CelShader";
import { HorrorPost } from "../shaders/HorrorPost";
import { Bot } from "../entities/Bot";
import type { Combatant, Team } from "../entities/Combatant";
import { Player } from "../entities/Player";
import { AimAssistSystem } from "../systems/AimAssistSystem";
import { Atmosphere } from "../systems/Atmosphere";
import { BattleSystem } from "../systems/BattleSystem";
import { CombatSystem } from "../systems/CombatSystem";
import { ConquestSystem } from "../systems/ConquestSystem";
import { GrassSystem } from "../systems/GrassSystem";
import { LightingSystem } from "../systems/LightingSystem";
import { Sky } from "../systems/Sky";
import { WaterSystem } from "../systems/WaterSystem";
import { applyEnvironment } from "../world/environment";
import { HollowmereEnvironment } from "../world/hollowmere/environment";
import { MapBuilder, type GameMap } from "../world/MapBuilder";
import { DeployScreen } from "../ui/DeployScreen";
import { HUD } from "../ui/HUD";
import { Minimap } from "../ui/Minimap";
import { CameraSystem } from "./CameraSystem";
import { InputManager } from "./InputManager";
import { Sfx } from "./Sfx";

/**
 * `menu` -> `deploy` -> `playing`, with `deploy` re-entered on every death,
 * and `roundover` when one side runs out of tickets.
 */
type GameState = "menu" | "deploy" | "playing" | "roundover";

/**
 * Top-level orchestrator: owns the engine/scene, all systems, the game state
 * machine, and the per-frame update loop.
 *
 * Systems never import each other — `Game` is the only place they meet, and
 * cross-system behavior belongs in this wiring rather than in an import.
 */
export class Game {
  private engine: Engine;
  private scene: Scene;
  private mats: CelMaterialFactory;
  private input: InputManager;
  private cameraSys: CameraSystem;
  private hud: HUD;
  private deployScreen: DeployScreen;
  private minimap: Minimap;
  private sfx: Sfx;
  private mapBuilder: MapBuilder;
  private combat: CombatSystem;
  private aimAssist: AimAssistSystem;
  private battle: BattleSystem;
  private conquest: ConquestSystem;
  private lighting: LightingSystem;
  private atmosphere: Atmosphere;
  private sky: Sky;
  private water: WaterSystem;
  private grass: GrassSystem;
  private post: HorrorPost;
  private player: Player;

  private state: GameState = "menu";
  private map: GameMap | null = null;
  /** Small delay so overlay confirms aren't triggered by held buttons. */
  private overlayT = 0;
  /** Reused each frame: the player plus every bot, for objective occupancy. */
  private readonly combatants: Combatant[] = [];
  /** Counts down while the player is waiting to redeploy. */
  private respawnT = 0;
  /** Round scoreboard: kills and losses per team, plus the player's own line. */
  private readonly kills: [number, number] = [0, 0];
  private readonly losses: [number, number] = [0, 0];
  private playerKills = 0;
  private playerDeaths = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { stencil: true });
    this.scene = new Scene(this.engine);
    this.scene.collisionsEnabled = true;

    // The scene has no Babylon lights at all: cel materials carry their own
    // key/ambient/point-light uniforms (fed by the LightingSystem) and every
    // effect material is unlit emissive.
    this.mats = new CelMaterialFactory(this.scene);
    this.input = new InputManager(canvas);
    this.cameraSys = new CameraSystem(this.scene);

    // Post-processing: FXAA smooths the hard cel/outline edges. Glow comes
    // from a GlowLayer rather than threshold bloom — it keys off material
    // emissive color, so neon/reticle/tracer meshes bloom while bright
    // non-emissive surfaces stay crisp.
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
    // Vignette/grain/aberration go last, over the finished frame.
    this.post = new HorrorPost(this.scene, this.cameraSys.camera);
    this.sfx = new Sfx();
    this.hud = new HUD();
    this.deployScreen = new DeployScreen();
    this.minimap = new Minimap();
    this.lighting = new LightingSystem();
    this.atmosphere = new Atmosphere(this.scene);
    this.water = new WaterSystem(this.scene, glow);
    this.grass = new GrassSystem(this.scene, glow);
    this.mapBuilder = new MapBuilder(this.scene, this.mats, this.lighting);
    this.combat = new CombatSystem(this.scene, this.mats);
    this.aimAssist = new AimAssistSystem(this.scene);
    this.battle = new BattleSystem(this.scene, this.mats, this.combat);
    this.conquest = new ConquestSystem();
    this.player = new Player(this.scene, this.mats);
    this.player.setBodyHidden(true); // hidden until a round starts
    for (const m of this.scene.meshes) {
      if (m.metadata && m.metadata.noGlow === true) glow.addExcludedMesh(m as Mesh);
    }
    // The sky hangs behind every state (menu included), so it is dressed
    // once here and re-applied per round alongside the environment.
    this.sky = new Sky(this.scene, glow);
    this.sky.apply(HollowmereEnvironment);

    // --- system wiring ---
    // Systems never import each other; every cross-system behaviour is a
    // callback installed here.
    this.player.onDamaged = (_amount, died) => this.onPlayerDamaged(died);
    this.battle.setPlayer(this.player);
    this.battle.onBotKilled = (bot, killer) => {
      this.sfx.enemyDie();
      this.conquest.registerDeath(bot.team);
      this.kills[killer] += 1;
      this.losses[bot.team] += 1;
      this.hud.addKill(
        CONFIG.teams[killer].name,
        CONFIG.teams[bot.team].name,
        false,
      );
    };
    // Bots fire constantly and all over the map, so their shots are
    // spatialised and voice-capped rather than played flat like the player's.
    this.battle.onBotFired = (bot, at) => {
      this.sfx.botShot(at);
      // Gunfire gives an enemy away on the minimap for a couple of seconds.
      if (bot.team !== this.player.team) this.minimap.reveal(bot);
    };
    this.battle.spawnPointFor = (bot) => this.spawnPointFor(bot.team);
    this.battle.objectiveFor = (bot) =>
      this.conquest.objectiveFor(bot.team, bot.squad, bot.position);
    // A bot holds a flag only when it is standing on the one it was sent to.
    this.battle.inCaptureZone = (bot) => {
      const p = this.conquest.pointAt(bot.position);
      return !!p && p.def.id === bot.objective;
    };
    this.conquest.onCaptured = (point, by) => {
      if (by === this.player.team) this.sfx.capture();
      else this.sfx.flagLost();
      const who = CONFIG.teams[by].name.toUpperCase();
      this.hud.showMessage(`${point.def.name.toUpperCase()} CAPTURED BY ${who}`, 2.5);
    };
    this.conquest.onNeutralised = (point) => {
      this.hud.toast(`${point.def.name} — neutralised`);
    };
    this.deployScreen.onDeploy = (spawn) => this.spawnPlayer(spawn);

    // Pointer lock + audio unlock must happen inside a user gesture.
    // (pointerdown, not click: Babylon may preventDefault the pointer event,
    // which suppresses the compatibility click event entirely.)
    document.addEventListener("pointerdown", () => {
      this.sfx.unlock();
      if (!this.input.pointerLocked && this.state === "playing") {
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
      case "roundover":
        this.overlayT += dt;
        if (this.input.confirmPressed && this.overlayT > 0.5) {
          this.startRound();
        }
        break;
      case "deploy":
        this.respawnT -= dt;
        this.deployScreen.update(this.respawnT);
        // Enter / gamepad A deploys at the current selection; clicking the map
        // picks a different one.
        if (this.input.confirmPressed) this.deployScreen.confirm();
        break;
      case "playing":
        this.updateGameplay(dt);
        break;
    }

    this.hud.update(dt);
    this.post.update(dt);
    this.sky.update(dt);
    this.scene.render();
  }

  private startRound(): void {
    this.hud.hideOverlay();

    this.map?.dispose();
    this.combat.clearTransient();

    applyEnvironment(this.scene, HollowmereEnvironment, this.mats);
    this.sky.apply(HollowmereEnvironment);
    this.map = this.mapBuilder.build();
    this.atmosphere.apply(
      HollowmereEnvironment.particles,
      this.map.size,
      this.map.size,
    );
    this.water.build(this.map.water, HollowmereEnvironment);
    this.grass.build(this.map.grass, HollowmereEnvironment, this.map.colliderBoxes);

    this.battle.setMap(this.map);
    this.battle.reset();
    this.conquest.start(this.map);
    this.player.fullReset();
    this.player.team = 0;
    this.minimap.setMap(this.map, this.player.team);
    this.kills[0] = this.kills[1] = 0;
    this.losses[0] = this.losses[1] = 0;
    this.playerKills = 0;
    this.playerDeaths = 0;
    this.enterDeploy(0);
  }

  private spawnPlayer(at?: { pos: Vector3; yaw: number }): void {
    this.player.fullReset();
    const spawn = at ?? this.spawnPointFor(this.player.team);
    // Scatter slightly so redeploying onto a busy flag doesn't drop the player
    // inside a squadmate.
    const jitter = new Vector3(
      (Math.random() - 0.5) * 5,
      0,
      (Math.random() - 0.5) * 5,
    );
    this.player.placeAt(spawn ? spawn.pos.add(jitter) : new Vector3(0, 0, 0));
    this.cameraSys.reset(spawn ? spawn.yaw : 0);
    this.deployScreen.hide();
    this.player.setBodyHidden(false);
    this.minimap.setVisible(true);
    this.state = "playing";
  }

  /**
   * Where a combatant of `team` deploys. Home spawns only until
   * ConquestSystem starts handing out captured flags.
   */
  private spawnPointFor(team: 0 | 1): { pos: Vector3; yaw: number } | null {
    if (!this.map) return null;
    const pick = this.conquest.spawnFor(team);
    if (!pick) return null;
    // Scatter a little so a whole squad doesn't stack on one point.
    return {
      pos: pick.pos.add(
        new Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6),
      ),
      yaw: pick.yaw,
    };
  }

  private updateGameplay(dt: number): void {
    // --- player ---
    const jumped = this.player.update(dt, this.input, this.cameraSys);
    if (jumped) this.sfx.jump();
    if (this.input.reloadPressed && this.player.startReload()) this.sfx.reload();

    // --- shooting (hitscan from the camera through the crosshair) ---
    // Mouse fire requires pointer lock so UI clicks never discharge the gun.
    const canFire = this.input.pointerLocked || this.input.gamepadConnected;
    if (this.input.fire && canFire && this.player.tryShot()) {
      const blend = this.cameraSys.adsBlend;
      const spread = this.player.spread(blend);
      // Tracers start at the character's rifle — the camera never goes
      // first-person, so that rifle is always the one on screen.
      const muzzle = this.player.muzzleWorld();
      const shot = this.combat.fire(
        this.cameraSys.camera.position,
        this.cameraSys.forward,
        spread,
        this.player.damage,
        muzzle,
        this.battle.hittablesAgainst(this.player.team),
      );
      // Recoil: kick the aim up and off to a random side, softened while
      // braced in ADS. It decays on its own, so the burst climbs and settles.
      const rc = CONFIG.recoil;
      const kickMult = 1 - (1 - rc.adsMult) * blend;
      this.cameraSys.addRecoil(
        rc.pitchPerShot * kickMult,
        (Math.random() * 2 - 1) * rc.yawPerShot * kickMult,
      );
      // Cosmetic view punch: FOV spike + shove + jitter on the rendered
      // camera only — the bullets above already left with the clean aim.
      this.cameraSys.addPunch();
      // Muzzle flash: a hard, very short pulse that lights whatever is in
      // front of the player — the main reason to keep shooting in the dark.
      const lc = CONFIG.lighting;
      this.lighting.pulse(
        muzzle,
        lc.muzzleColor,
        lc.muzzleRange,
        lc.muzzleIntensity,
        lc.muzzleLife,
      );
      this.sfx.shoot();
      const haptic = CONFIG.rumble;
      this.input.rumble(haptic.shotStrong, haptic.shotWeak, haptic.shotMs);
      if (shot.target) {
        this.hud.flashHitmarker();
        this.sfx.hit();
        const killed = shot.killed && shot.target instanceof Bot;
        this.input.rumble(
          killed ? haptic.killStrong : haptic.hitStrong,
          killed ? haptic.killWeak : haptic.hitWeak,
          killed ? haptic.killMs : haptic.hitMs,
        );
        if (killed && shot.target instanceof Bot) {
          this.sfx.enemyDie();
          this.conquest.registerDeath(shot.target.team);
          this.kills[this.player.team] += 1;
          this.losses[shot.target.team] += 1;
          this.playerKills += 1;
          this.hud.addKill("YOU", CONFIG.teams[shot.target.team].name, true);
        }
      }
      if (this.player.reloading) this.sfx.reload();
    }

    // --- objectives ---
    // Runs before the bots so their think tick sees this frame's ownership.
    this.combatants.length = 0;
    this.combatants.push(this.player, ...this.battle.bots);
    this.conquest.update(dt, this.combatants);
    if (this.conquest.winner !== null) {
      this.endRound(this.conquest.winner);
      return;
    }

    // --- bots ---
    this.battle.update(dt, this.cameraSys.camera.position);
    this.spendMuzzleLightBudget();
    this.combat.update(dt);

    this.updateCameraAndLighting(dt);
    this.updateHud(dt);
  }

  /**
   * Camera & rendering support. This tail order is LOAD-BEARING: light slot
   * selection, the shader's fog, and audio panning all key off the camera
   * position, so anything that moves the camera must run before them:
   * aim assist -> camera update -> mats.updateCamera() -> carried lights ->
   * lighting.update() -> water.update() -> grass.update() -> sfx.setListener().
   * Nothing after this method may move the camera.
   */
  private updateCameraAndLighting(dt: number): void {
    // Aim assist reads last frame's camera pose and this frame's enemy list
    // (consumed synchronously — the battle scratch array is safe to pass),
    // and is inert unless the player is looking with a gamepad stick.
    const assist = this.aimAssist.update(
      dt,
      this.input,
      this.cameraSys.camera.position,
      this.cameraSys.forward,
      this.cameraSys.aimYaw,
      this.cameraSys.aimPitch,
      this.battle.hittablesAgainst(this.player.team),
    );
    this.cameraSys.update(dt, this.input, this.player.position, assist);
    this.mats.updateCamera(this.cameraSys.camera.position);
    const lc = CONFIG.lighting;
    this.lighting.setCarried(
      "player-lamp",
      this.player.position.add(new Vector3(0, lc.lampHeight, 0)),
      lc.lampColor,
      lc.lampRange,
      lc.lampIntensity,
    );
    this.lighting.update(dt, this.cameraSys.camera.position, this.mats);
    // Water reads the same camera and the same winning light set, so it
    // updates here too — before anything later can move the camera.
    this.water.update(
      dt,
      this.cameraSys.camera.position,
      this.lighting.activeLights,
    );
    // Grass reads the same camera and light set, plus the combatant list
    // (assembled above for the conquest occupancy pass) as its pushers —
    // that list is what bends the blades around running bodies.
    this.grass.update(
      dt,
      this.cameraSys.camera.position,
      this.lighting.activeLights,
      this.combatants,
    );
    // Same rule as the lights and the fog: this has to follow the camera.
    this.sfx.setListener(this.cameraSys.camera.position, this.cameraSys.forward);
  }

  /** Pushes this frame's state to the DOM HUD and the minimap. */
  private updateHud(dt: number): void {
    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setAmmo(this.player.ammo, this.player.magSize, this.player.reloading);
    // The crosshair ring IS the live spread: radians at the aim plane,
    // projected through the current FOV into screen pixels.
    const spreadPx =
      (Math.tan(this.player.spread(this.cameraSys.adsBlend)) /
        Math.tan(this.cameraSys.camera.fov / 2)) *
      (window.innerHeight / 2);
    this.hud.setCrosshair(this.input.ads, spreadPx);
    this.hud.setTickets(
      [CONFIG.teams[0].name, CONFIG.teams[1].name],
      this.conquest.tickets,
      this.player.team,
    );
    this.hud.setFlags(this.conquest.points, this.player.team);
    this.hud.setScoreboard(this.input.scoreboard, {
      teams: [CONFIG.teams[0].name, CONFIG.teams[1].name],
      tickets: this.conquest.tickets,
      flags: [this.conquest.flagsHeld(0), this.conquest.flagsHeld(1)],
      kills: this.kills,
      deaths: this.losses,
      playerTeam: this.player.team,
      playerKills: this.playerKills,
      playerDeaths: this.playerDeaths,
    });
    this.hud.setLockHint(!this.input.pointerLocked && !this.input.gamepadConnected);
    this.minimap.update(
      dt,
      this.player.position,
      this.cameraSys.yaw,
      this.conquest.points,
      this.battle.bots,
      this.player.team,
    );
  }

  /**
   * Opens the deploy screen. `delay` is the reinforcement wait — zero at the
   * start of a round, so the first deployment is immediate.
   */
  private enterDeploy(delay: number): void {
    this.respawnT = delay;
    this.minimap.setVisible(false);
    this.hud.setScoreboard(false);
    if (this.map) this.deployScreen.show(this.map, this.conquest, this.player.team);
    this.deployScreen.update(this.respawnT);
    this.state = "deploy";
    document.exitPointerLock();
  }

  private endRound(winner: Team): void {
    this.state = "roundover";
    this.deployScreen.hide();
    this.hud.setScoreboard(false);
    // `updateGameplay` stops running here, so push the final state once more —
    // otherwise the ticket bar sits frozen a frame behind the result text.
    this.hud.setTickets(
      [CONFIG.teams[0].name, CONFIG.teams[1].name],
      this.conquest.tickets,
      this.player.team,
    );
    this.hud.setFlags(this.conquest.points, this.player.team);
    this.overlayT = 0;
    this.minimap.setVisible(false);
    this.battle.reset();
    document.exitPointerLock();
    const won = winner === this.player.team;
    this.hud.showRoundOver(
      CONFIG.teams[winner].name,
      won,
      this.conquest.tickets[0],
      this.conquest.tickets[1],
    );
  }

  /** Called from `Player.takeDamage`, whoever pulled the trigger. */
  private onPlayerDamaged(died: boolean): void {
    if (this.state !== "playing") return;
    this.hud.flashDamage();
    this.post.flashDamage();
    this.sfx.playerHurt();
    const haptic = CONFIG.rumble;
    this.input.rumble(
      died ? haptic.deathStrong : haptic.hurtStrong,
      died ? haptic.deathWeak : haptic.hurtWeak,
      died ? haptic.deathMs : haptic.hurtMs,
    );
    if (died) {
      this.conquest.registerDeath(this.player.team);
      this.losses[this.player.team] += 1;
      this.playerDeaths += 1;
      this.hud.addKill(
        CONFIG.teams[1 - this.player.team].name,
        "YOU",
        true,
      );
      this.enterDeploy(CONFIG.conquest.respawnDelay);
    }
  }

  /**
   * Muzzle flashes are transient lights, and transients always win a shader
   * slot. Thirty-two bots firing would take all sixteen and black out the
   * village's own lanterns, so only the nearest few close-range flashes get one.
   */
  private spendMuzzleLightBudget(): void {
    const lc = CONFIG.lighting;
    const camera = this.cameraSys.camera.position;
    const flashes = this.battle.muzzleFlashes;
    if (flashes.length === 0) return;
    if (flashes.length > lc.muzzleBudgetPerFrame) {
      flashes.sort(
        (a, b) =>
          Vector3.DistanceSquared(a, camera) - Vector3.DistanceSquared(b, camera),
      );
    }
    const max = Math.min(flashes.length, lc.muzzleBudgetPerFrame);
    for (let i = 0; i < max; i++) {
      if (Vector3.Distance(flashes[i], camera) > lc.muzzleMaxDistance) break;
      this.lighting.pulse(
        flashes[i],
        lc.muzzleColor,
        lc.muzzleRange,
        lc.muzzleIntensity,
        lc.muzzleLife,
      );
    }
  }
}
