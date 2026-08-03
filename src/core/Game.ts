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
 * ShadowSystem wiring (casters re-registered per round from map.visuals),
 * pipeline.imageProcessingEnabled === false, window.__celshock debug handle.
 */
import {
  Color3,
  DefaultRenderingPipeline,
  Engine,
  GlowLayer,
  Mesh,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import { CelMaterialFactory, updateOutlineScales } from "../shaders/CelShader";
import { GodRays } from "../shaders/GodRays";
import { HorrorPost } from "../shaders/HorrorPost";
import { Bot } from "../entities/Bot";
import { difficultyNames } from "../entities/BotSkill";
import type { Combatant, Team } from "../entities/Combatant";
import { Player } from "../entities/Player";
import { AimAssistSystem } from "../systems/AimAssistSystem";
import { Atmosphere } from "../systems/Atmosphere";
import { BattleSystem } from "../systems/BattleSystem";
import { CaptureZoneSystem } from "../systems/CaptureZoneSystem";
import { CombatSystem } from "../systems/CombatSystem";
import { ConquestSystem } from "../systems/ConquestSystem";
import { GrassSystem } from "../systems/GrassSystem";
import { LightingSystem } from "../systems/LightingSystem";
import { ShadowSystem } from "../systems/ShadowSystem";
import { Sky } from "../systems/Sky";
import { WaterSystem } from "../systems/WaterSystem";
import { applyEnvironment, type EnvironmentSpec } from "../world/environment";
import type { EditorSession } from "../editor";
import { HollowmereEnvironment } from "../world/hollowmere/environment";
import { HollowmereLayout } from "../world/hollowmere/layout";
import { MapBuilder, type GameMap } from "../world/MapBuilder";
import { DeployScreen } from "../ui/DeployScreen";
import { HUD, type CaptureStatus } from "../ui/HUD";
import { Minimap } from "../ui/Minimap";
import { CameraSystem } from "./CameraSystem";
import { InputManager } from "./InputManager";
import { Sfx } from "./Sfx";

/**
 * `menu` -> `deploy` -> `playing`, with `deploy` re-entered on every death,
 * and `roundover` when one side runs out of tickets.
 *
 * `editor` sits outside that cycle: it is a dev-only side state reachable from
 * anywhere with F2, and leaving it always restarts the round rather than
 * resuming, because the systems that cache the GameMap cannot be handed a map
 * that was rebuilt underneath them.
 */
type GameState = "menu" | "deploy" | "playing" | "roundover" | "editor";

/** Grass bends around combatants; in the editor there are none. */
const EMPTY_PUSHERS: readonly Combatant[] = [];

/** Where the chosen enemy-skill tier is remembered between sessions. */
const DIFFICULTY_KEY = "hollowmere.difficulty";

function readDifficulty(): number {
  try {
    const raw = window.localStorage.getItem(DIFFICULTY_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (Number.isFinite(n)) return n;
  } catch {
    // Private browsing and file:// both throw here. A default is fine.
  }
  return CONFIG.bots.skill.defaultDifficulty;
}

function writeDifficulty(tier: number): void {
  try {
    window.localStorage.setItem(DIFFICULTY_KEY, String(tier));
  } catch {
    // Not being able to remember the setting is not worth failing over.
  }
}

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
  /** The flags' in-world markers — rings, skirts and beacons. */
  private zones: CaptureZoneSystem;
  private lighting: LightingSystem;
  private shadows: ShadowSystem;
  private atmosphere: Atmosphere;
  private sky: Sky;
  private water: WaterSystem;
  private grass: GrassSystem;
  private post: HorrorPost;
  /** Moon shafts. Driven from the sky's own moon direction every frame. */
  private godRays: GodRays;
  /** The environment the sky is currently painted for — see applySky(). */
  private skyEnv: EnvironmentSpec | null = null;
  private player: Player;
  private canvas: HTMLCanvasElement;
  /**
   * Kept as a field, not a constructor local: the exclusion scan in the
   * constructor runs once, so anything created later (the editor's proxies and
   * overlays) has to exclude itself by hand and needs the layer to do it.
   */
  private glow: GlowLayer;
  /** Non-null only while the state is "editor". Dev builds only. */
  private editor: EditorSession | null = null;

  private state: GameState = "menu";
  private map: GameMap | null = null;
  /** Small delay so overlay confirms aren't triggered by held buttons. */
  private overlayT = 0;
  /**
   * Selected enemy-skill tier, applied on every round start. Persisted, because
   * re-picking it after each reload is exactly the friction that makes people
   * leave a difficulty setting alone.
   */
  private difficulty = readDifficulty();
  /** Reused each frame: the player plus every bot, for objective occupancy. */
  private readonly combatants: Combatant[] = [];
  /** Scratch for the shadow focus point — no per-frame allocation. */
  private readonly shadowFocus = new Vector3();
  /** Counts down while the player is waiting to redeploy. */
  private respawnT = 0;
  /** Round scoreboard: kills and losses per team, plus the player's own line. */
  private readonly kills: [number, number] = [0, 0];
  private readonly losses: [number, number] = [0, 0];
  private playerKills = 0;
  private playerDeaths = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.engine = new Engine(canvas, true, { stencil: true });
    this.scene = new Scene(this.engine);
    this.scene.collisionsEnabled = true;

    // The scene has no Babylon lights at all: cel materials carry their own
    // key/ambient/point-light uniforms (fed by the LightingSystem) and every
    // effect material is unlit emissive.
    this.mats = new CelMaterialFactory(this.scene);
    // Stepped moon shadows + contact blobs. Must exist before any cel
    // material is created so the shadow map binds on creation.
    this.shadows = new ShadowSystem(this.scene, this.mats);
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
    this.glow = glow;
    // Moon shafts read the finished frame and add light back into it, so they
    // come after FXAA and before the grade — the vignette and grain have to
    // land on top of the beams, not under them.
    this.godRays = new GodRays(this.scene, this.cameraSys.camera);
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
    this.zones = new CaptureZoneSystem(this.scene, glow);
    this.player = new Player(this.scene, this.mats);
    this.player.setBodyHidden(true); // hidden until a round starts
    for (const m of this.scene.meshes) {
      if (m.metadata && m.metadata.noGlow === true) glow.addExcludedMesh(m as Mesh);
    }
    // The sky hangs behind every state (menu included), so it is dressed
    // once here and re-applied per round alongside the environment.
    this.sky = new Sky(this.scene, glow);
    this.applySky();

    // --- system wiring ---
    // Systems never import each other; every cross-system behaviour is a
    // callback installed here.
    this.player.onDamaged = (amount, died, from) =>
      this.onPlayerDamaged(amount, died, from);
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
    // A bot reloading is a window the player can push into, so it has to be
    // audible. Spatialised for the same reason bot fire is.
    this.battle.onBotReloaded = (bot) => this.sfx.botReload(bot.position);
    // A round cracking past is a cue, not a hit. CombatSystem finds these
    // inside the target loop it already runs per shot, and has no business
    // knowing what a bot is — so the routing happens here.
    this.combat.onNearMiss = (near, from) => this.battle.suppress(near, from);
    this.battle.spawnPointFor = (bot) => this.spawnPointFor(bot.team);
    // Squad orders are planned as a group, so squads can be spread across
    // objectives — or deliberately stacked on the one that decides the round.
    this.battle.planSquads = (team, centroids, previous) =>
      this.conquest.planSquads(team, centroids, previous);
    // A bot is "on" a flag only when it is the one it was sent to. Whether that
    // means contesting it or holding it is the squad's posture.
    this.battle.zoneFor = (bot) => {
      const p = this.conquest.pointAt(bot.position);
      if (!p || p.def.id !== bot.objective) return "none";
      return bot.defending && p.owner === bot.team ? "hold" : "contest";
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

    // The map editor is a development tool: the whole of src/editor is behind
    // a dynamic import so none of it reaches a production bundle.
    if (import.meta.env.DEV) {
      window.addEventListener("keydown", (e) => {
        if (e.code === "F2") {
          e.preventDefault();
          void this.toggleEditor();
        }
      });
    }

    this.hud.onDifficulty = (tier) => this.setDifficulty(tier);
    this.showMenu();
    // Debug/test handle (used by automated smoke tests).
    (window as unknown as { __celshock: Game }).__celshock = this;
    this.engine.runRenderLoop(() => this.tick());
  }

  /**
   * Dresses the sky and hands the moon shafts their colour. The two belong
   * together: the shafts are the moon's own light in the air, so they take the
   * halo's tint rather than a colour of their own, and re-applying the sky
   * without re-tinting them would leave last environment's beams in the frame.
   *
   * Called on every round start, and deliberately a no-op when the environment
   * has not changed. `Sky.apply` repaints an 8-megapixel dome (two thousand
   * stars, a galactic band, a stretched halo) and two fBm cloud masks, and the
   * sky over Hollowmere is the same sky it was last round — unlike the map,
   * which genuinely has to be rebuilt. A second map, with a spec object of its
   * own, repaints as it should.
   */
  private applySky(): void {
    const env = HollowmereEnvironment;
    if (this.skyEnv === env) return;
    this.skyEnv = env;
    this.sky.apply(env);
    if (env.sky) {
      const tint = Color3.FromHexString(env.sky.moonGlowColor);
      this.godRays.setTint(tint.r, tint.g, tint.b);
    }
  }

  /**
   * Redraws the menu overlay. The difficulty row is re-rendered rather than
   * patched because `showMenu` writes the whole overlay anyway — and the round
   * -over screen shares that overlay, so there is nothing to keep in sync.
   */
  private showMenu(): void {
    this.hud.showMenu(difficultyNames(), this.difficulty);
  }

  /**
   * Picks an enemy-skill tier. Applied at the next round start rather than
   * immediately: `assignSkills` re-rolls the whole roster, and doing that
   * mid-round would change the bots you are currently fighting.
   */
  private setDifficulty(tier: number): void {
    const n = difficultyNames().length;
    const next = tier < 0 ? 0 : tier >= n ? n - 1 : tier;
    if (next === this.difficulty) return;
    this.difficulty = next;
    writeDifficulty(next);
    if (this.state === "menu") this.showMenu();
  }

  private tick(): void {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    this.input.update();

    switch (this.state) {
      case "menu":
      case "roundover":
        this.overlayT += dt;
        // Menu only: `roundover` shares the overlay element but shows the
        // victory text, and redrawing the picker over it would wipe the result.
        if (this.state === "menu") {
          if (this.input.menuLeftPressed) this.setDifficulty(this.difficulty - 1);
          if (this.input.menuRightPressed) this.setDifficulty(this.difficulty + 1);
        }
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
      case "editor":
        this.updateEditor(dt);
        break;
    }

    this.hud.update(dt);
    this.post.update(dt);
    this.sky.update(dt);
    // After every state has had its go at the camera, and before the render
    // that the shafts are drawn into.
    this.godRays.update(
      this.scene,
      this.cameraSys.camera,
      this.sky.moonDirection,
    );
    this.scene.render();
  }

  /**
   * Enters or leaves the map editor. Dev-only, and the import is dynamic so
   * `src/editor` never reaches a production bundle.
   *
   * Leaving always restarts the round rather than resuming. BattleSystem,
   * ConquestSystem, Minimap and DeployScreen all cache the GameMap they were
   * handed, so the only safe way back from a session that may have rebuilt the
   * map is to build a fresh one and re-point all of them — which is exactly
   * what `startRound` does.
   */
  private async toggleEditor(): Promise<void> {
    // Gating the whole body, not just the keybind: this is what makes the
    // dynamic import unreachable under `vite build`, so Rollup drops the
    // editor chunk entirely rather than emitting an orphan nobody fetches.
    if (!import.meta.env.DEV) return;
    if (this.editor) {
      // Leaving rebuilds the map from the layout module, so anything edited
      // and not written to disk is gone. Until the editor can save, that is
      // every edit — ask before throwing the work away.
      if (
        this.editor.hasUnsavedChanges &&
        !window.confirm("Discard unsaved map edits and return to the game?")
      ) {
        return;
      }
      this.editor.dispose();
      this.editor = null;
      this.hud.setEditing(false);
      this.startRound();
      return;
    }

    const { createEditor } = await import("../editor");
    // A pending F2 while the module loaded, or a round change underneath it.
    if (this.editor) return;

    this.state = "editor";
    const map = this.buildEditorMap();
    this.hud.hideOverlay();
    this.hud.setEditing(true);
    this.deployScreen.hide();
    this.minimap.setVisible(false);
    this.player.setBodyHidden(true);
    if (document.pointerLockElement) document.exitPointerLock();

    this.editor = createEditor({
      canvas: this.canvas,
      camera: this.cameraSys.camera,
      input: this.input,
      scene: this.scene,
      glow: this.glow,
      map,
      rebuildMap: () => this.buildEditorMap(),
      layout: HollowmereLayout,
      environment: HollowmereEnvironment,
      fixtures: this.lighting.fixtures,
      applyEnvironment: (env) => applyEnvironment(this.scene, env, this.mats),
      invalidateShadows: () => this.shadows.invalidate(),
    });
    // Open where the player was standing, looking the way they were looking.
    this.editor.warpTo(
      this.cameraSys.camera.position.clone(),
      this.cameraSys.aimYaw,
      this.cameraSys.aimPitch,
    );
  }

  /**
   * Builds the map the editor works on, from whatever the layout currently
   * says, and re-points everything here that caches it.
   *
   * Per-item rather than block-merged: the shipped merge collapses neighbouring
   * structures into one mesh, which is exactly what makes an individual
   * placement unselectable. It costs ~10x the draw calls, which is why the
   * editor panel says never to judge performance there.
   *
   * Called on entry and again whenever the editor changes something the
   * builders read — a param, a kind, an added or deleted entry. Deliberately
   * does NOT touch battle/conquest/minimap: those keep pointing at a map that
   * is now disposed, which is safe only because leaving the editor always runs
   * `startRound` and re-points them at a fresh, properly merged build.
   */
  private buildEditorMap(): GameMap {
    this.map?.dispose();
    this.combat.clearTransient();
    // The editor draws its own flag proxies, and its terrain moves under them;
    // leaving the play markers up would double every ring. Leaving the editor
    // always runs startRound, which builds them again.
    this.zones.dispose();
    const map = this.mapBuilder.build(HollowmereLayout, HollowmereEnvironment, {
      editor: true,
    });
    this.map = map;
    this.shadows.setCasters(map.visuals);
    this.water.build(map.water, HollowmereEnvironment, map.terrain);
    this.grass.build(
      map.grass,
      HollowmereEnvironment,
      map.colliderBoxes,
      map.terrain,
    );
    this.player.setTerrain(map.terrain);
    return map;
  }

  /**
   * The editor frame. Same tail as gameplay minus the player: no aim assist,
   * no blob shadows, no carried lamp, no grass pushers.
   */
  private updateEditor(dt: number): void {
    const editor = this.editor;
    if (!editor) return;
    editor.update(dt);
    // The shadow window follows the camera itself here — there is no player to
    // centre it on, and the same forward bias keeps what's ahead covered.
    this.shadowFocus
      .copyFrom(this.cameraSys.camera.position)
      .addInPlace(editor.forward.scale(8));
    this.updateSceneForCamera(dt, this.shadowFocus, null, EMPTY_PUSHERS);
  }

  private startRound(): void {
    this.hud.hideOverlay();
    // Re-draw skills for the chosen tier. The rig pool is never disposed, so
    // this is the only place the roster's difficulty can change.
    this.battle.setDifficulty(this.difficulty);

    this.map?.dispose();
    this.combat.clearTransient();

    applyEnvironment(this.scene, HollowmereEnvironment, this.mats);
    this.applySky();
    this.map = this.mapBuilder.build(HollowmereLayout, HollowmereEnvironment);
    // The shadow camera follows the environment's key light, and its casters
    // are the fresh map's visuals — last round's meshes are now disposed.
    this.shadows.setLightDirection(HollowmereEnvironment.lighting.direction);
    this.shadows.setFogRange(
      HollowmereEnvironment.fogStart,
      HollowmereEnvironment.fogEnd,
    );
    this.shadows.setCasters(this.map.visuals);
    this.atmosphere.apply(
      HollowmereEnvironment.particles,
      this.map.size,
      this.map.size,
    );
    this.water.build(this.map.water, HollowmereEnvironment, this.map.terrain);
    this.grass.build(
      this.map.grass,
      HollowmereEnvironment,
      this.map.colliderBoxes,
      this.map.terrain,
    );
    this.player.setTerrain(this.map.terrain);

    this.battle.setMap(this.map);
    this.battle.reset();
    this.conquest.start(this.map);
    // The flags' markers read the same radius ConquestSystem tests against,
    // and follow the same terrain the ring is drawn across.
    this.zones.build(
      this.map.controlPoints,
      this.map.terrain,
      this.map.nav,
      HollowmereEnvironment,
    );
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
      // Bots hear the player's rifle the same way they hear each other's. This
      // is the only place the player's own gunfire enters the world, so it is
      // the only place that can say so.
      this.battle.hearGunshot(muzzle, this.player.team);
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
    // Reads the camera (it fades the markers into the fog wall) but never
    // moves it, so it belongs after the tail above rather than inside it.
    this.zones.update(
      dt,
      this.conquest.points,
      this.player.team,
      this.cameraSys.camera.position,
    );
    this.updateHud(dt);
  }

  /**
   * Camera & rendering support. This tail order is LOAD-BEARING: light slot
   * selection, the shader's fog, and audio panning all key off the camera
   * position, so anything that moves the camera must run before them:
   * aim assist -> camera update -> mats.updateCamera() -> shadows (window,
   * blobs, outline thinning) -> carried lights -> lighting.update() ->
   * water.update() -> grass.update() -> sfx.setListener().
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
    // Shadows follow the player (biased a little along the view so the
    // window covers what's ahead); outline ink thins with the same camera.
    this.shadowFocus
      .copyFrom(this.player.position)
      .addInPlace(this.cameraSys.forward.scale(8));
    this.updateSceneForCamera(dt, this.shadowFocus, this.player, this.combatants);
  }

  /**
   * The half of the tail that needs only a posed camera — shared with the map
   * editor, which has no player, no bots and no aim assist but still has to
   * keep fog, shadows, outlines, lights, water, grass and audio agreeing about
   * where the viewer is.
   *
   * The order here is the load-bearing part of the sequence above and must not
   * be rearranged. `player` is null in the editor: it gates exactly the two
   * steps that need a body — blob shadows and the carried shoulder lamp — and
   * gating them in place is what keeps both callers on one ordering.
   */
  private updateSceneForCamera(
    dt: number,
    shadowFocus: Vector3,
    player: Player | null,
    pushers: readonly Combatant[],
  ): void {
    this.mats.updateCamera(this.cameraSys.camera.position);
    this.shadows.update(shadowFocus, this.mats);
    if (player) {
      this.shadows.updateBlobs(
        player,
        this.battle.bots,
        this.cameraSys.camera.position,
      );
    }
    updateOutlineScales(this.cameraSys.camera.position);
    if (player) {
      const lc = CONFIG.lighting;
      this.lighting.setCarried(
        "player-lamp",
        player.position.add(new Vector3(0, lc.lampHeight, 0)),
        lc.lampColor,
        lc.lampRange,
        lc.lampIntensity,
      );
    }
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
      pushers,
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
    // Damage arcs are world-anchored, so they need this frame's aim yaw to be
    // re-projected onto the screen — pushed here like every other HUD input.
    this.hud.setViewYaw(this.cameraSys.aimYaw);
    this.hud.setTickets(
      [CONFIG.teams[0].name, CONFIG.teams[1].name],
      this.conquest.tickets,
      this.player.team,
    );
    this.hud.setFlags(this.conquest.points, this.player.team);
    this.hud.setCapture(this.captureStatus());
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
   * The flag the player is standing in, as the HUD wants it — null when they
   * are outside every zone, which is what hides the panel. The zone test is
   * `ConquestSystem.pointAt`, the same one that decides occupancy, so the
   * panel appears exactly when the player starts counting toward the meter.
   */
  private captureStatus(): CaptureStatus | null {
    const p = this.conquest.pointAt(this.player.position);
    if (!p) return null;
    const mine = this.player.team;
    const theirs = 1 - mine;
    // The meter runs -1 (team 0) .. +1 (team 1), so "my way" is negative for
    // team 0 and positive for team 1.
    const mineWay = mine === 0 ? -1 : 1;
    return {
      id: p.def.id,
      name: p.def.name,
      owner: p.owner === null ? "neutral" : p.owner === mine ? "mine" : "theirs",
      progress: Math.abs(p.meter),
      held: p.meter * mineWay >= 0 ? "mine" : "theirs",
      // Which way it is MOVING, which is a question about bodies, not about
      // the meter: walk onto a flag the enemy holds outright and you are
      // capturing it, even though the bar is still full red. The player is in
      // the zone by construction here, so `mine` is never zero.
      taking: p.present[mine] >= p.present[theirs] ? "mine" : "theirs",
      contested: p.contested,
      enemies: p.present[theirs],
    };
  }

  /**
   * Opens the deploy screen. `delay` is the reinforcement wait — zero at the
   * start of a round, so the first deployment is immediate.
   */
  private enterDeploy(delay: number): void {
    this.respawnT = delay;
    this.minimap.setVisible(false);
    this.hud.clearDamageDirections();
    this.hud.setScoreboard(false);
    // updateHud stops running outside `playing`, so the panel has to be told
    // to go — otherwise the zone the player died in stays on screen.
    this.hud.setCapture(null);
    if (this.map) this.deployScreen.show(this.map, this.conquest, this.player.team);
    this.deployScreen.update(this.respawnT);
    this.state = "deploy";
    document.exitPointerLock();
  }

  private endRound(winner: Team): void {
    this.state = "roundover";
    this.deployScreen.hide();
    this.hud.setScoreboard(false);
    this.hud.clearDamageDirections();
    this.hud.setCapture(null);
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
  private onPlayerDamaged(amount: number, died: boolean, from?: Vector3): void {
    if (this.state !== "playing") return;
    this.hud.flashDamage();
    // The vignette says "hit"; the arc says "from there". Bearing is taken
    // once, in world space, from the shot's origin — the HUD re-projects it
    // against the view every frame from then on.
    if (from) {
      const dx = from.x - this.player.position.x;
      const dz = from.z - this.player.position.z;
      if (dx * dx + dz * dz > 1e-6) {
        this.hud.addDamageDirection(Math.atan2(dx, dz), amount);
      }
    }
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
   * slot. Sixteen bots firing would take all sixteen and black out the
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
