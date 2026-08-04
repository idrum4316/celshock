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
 * The map is a `MapDef` held in one field (`mapDef`) and built in one method
 * (`installMap`), which both a round start and an editor rebuild go through —
 * no map's layout or environment may be named anywhere else in here.
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
import { MotionBlur } from "../shaders/MotionBlur";
import { Bot } from "../entities/Bot";
import { difficultyNames } from "../entities/BotSkill";
import type { Combatant, Team } from "../entities/Combatant";
import { Player } from "../entities/Player";
import {
  DEFAULT_SIGHT,
  isSightId,
  type SightId,
} from "../entities/sights";
import {
  DEFAULT_WEAPON,
  isWeaponId,
  type WeaponId,
} from "../entities/weapons";
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
import { DEFAULT_MAP, type MapDef } from "../world/maps";
import { MapBuilder, type BuildOptions, type GameMap } from "../world/MapBuilder";
import { DeployScreen } from "../ui/DeployScreen";
import { HUD, type CaptureStatus } from "../ui/HUD";
import { kitLabel, LoadoutScreen } from "../ui/LoadoutScreen";
import { Minimap } from "../ui/Minimap";
import { enterFullscreenOnTouch } from "../pwa/register";
import { CameraSystem } from "./CameraSystem";
import { InputManager } from "./InputManager";
import { Sfx } from "./Sfx";

/**
 * `menu` -> `deploy` -> `playing`, with `deploy` re-entered on every death,
 * and `roundover` when one side runs out of tickets.
 *
 * `paused` is the other side state, and unlike the rest it remembers where it
 * came from (`pausedFrom`): a pause is a lid over `playing` or `deploy`, and
 * resuming puts the state back exactly as it was rather than moving the game
 * on. Nothing simulates while it is up — the scene still renders, which is what
 * makes a paused round look held rather than gone.
 *
 * `editor` sits outside that cycle: it is a dev-only side state reachable from
 * anywhere with F2, and leaving it always restarts the round rather than
 * resuming, because the systems that cache the GameMap cannot be handed a map
 * that was rebuilt underneath them.
 */
type GameState =
  | "menu"
  | "deploy"
  | "playing"
  | "paused"
  | "loadout"
  | "roundover"
  | "editor";

/** Grass bends around combatants; in the editor there are none. */
const EMPTY_PUSHERS: readonly Combatant[] = [];

/**
 * The carried-light id for one of the kit screen's bench lamps. A function so
 * that putting them up and taking them down cannot disagree about the name —
 * a carried light nobody removes never gives its shader slot back.
 */
const kitLampId = (n: number) => `kit-lamp-${n}`;

/** Where the chosen enemy-skill tier is remembered between sessions. */
const DIFFICULTY_KEY = "hollowmere.difficulty";
/** …and the loadout. Same store, same tolerance for it not working. */
const SIGHT_KEY = "hollowmere.sight";
const WEAPON_KEY = "hollowmere.weapon";

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
 * The remembered optic. Validated rather than trusted: the value is a string
 * out of a store the player can edit, and a sight that no longer exists would
 * otherwise index the assembly table with `undefined`.
 */
function readSight(): SightId {
  try {
    const raw = window.localStorage.getItem(SIGHT_KEY);
    if (raw !== null && isSightId(raw)) return raw;
  } catch {
    // As above.
  }
  return DEFAULT_SIGHT;
}

function writeSight(id: SightId): void {
  try {
    window.localStorage.setItem(SIGHT_KEY, id);
  } catch {
    // As above.
  }
}

/** The remembered weapon. Validated exactly as the optic is, and for the
 *  same reason: it indexes a table of built models. */
function readWeapon(): WeaponId {
  try {
    const raw = window.localStorage.getItem(WEAPON_KEY);
    if (raw !== null && isWeaponId(raw)) return raw;
  } catch {
    // As above.
  }
  return DEFAULT_WEAPON;
}

function writeWeapon(id: WeaponId): void {
  try {
    window.localStorage.setItem(WEAPON_KEY, id);
  } catch {
    // As above.
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
  private loadoutScreen: LoadoutScreen;
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
  private motionBlur: MotionBlur;
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
  /**
   * The map being played, as the layout/environment pair `src/world/maps.ts`
   * keeps together. The single place either half is named: everything from the
   * round start to the editor session reads it off here, so a second map is a
   * `MapDef` in that registry and a write to this field, not a hunt through the
   * orchestrator for the fourteen places the old constants were spelled out.
   */
  private mapDef: MapDef = DEFAULT_MAP;

  private state: GameState = "menu";
  /** Which state the pause menu is a lid over; where `resume()` puts it back. */
  private pausedFrom: "playing" | "deploy" = "playing";
  /**
   * Whether the pointer was locked as of the last `pointerlockchange`. Losing
   * the lock is what pauses the game, and only a *transition* out of it counts
   * — a pad player who never took the lock has none to lose.
   */
  private hadPointerLock = false;
  private map: GameMap | null = null;
  /** Small delay so overlay confirms aren't triggered by held buttons. */
  private overlayT = 0;
  /**
   * Selected enemy-skill tier, applied on every round start. Persisted, because
   * re-picking it after each reload is exactly the friction that makes people
   * leave a difficulty setting alone.
   */
  private difficulty = readDifficulty();
  /**
   * The kit. Unlike the difficulty tier this applies immediately — both halves
   * of it re-pose a weapon that is put away everywhere the loadout screen can
   * be opened from, so there is nothing to defer to the next round.
   */
  private sight: SightId = readSight();
  private weapon: WeaponId = readWeapon();
  /** Which state the loadout screen is a lid over; where closing it returns. */
  private loadoutFrom: "menu" | "deploy" = "menu";
  /** Reused each frame: the player plus every bot, for objective occupancy. */
  private readonly combatants: Combatant[] = [];
  /** Scratch for the shadow focus point — no per-frame allocation. */
  private readonly shadowFocus = new Vector3();
  /** …and for the kit screen's bench lamp, placed relative to the camera. */
  private readonly kitLampPos = new Vector3();
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
    // Then the look smears, with the shafts already in the frame — they belong
    // to the same instant as the geometry, so they have to blur with it.
    this.motionBlur = new MotionBlur(this.scene, this.cameraSys.camera);
    // Vignette/grain/aberration go last, over the finished frame. Grain in
    // particular has to land AFTER the blur: smeared grain reads as smudge.
    this.post = new HorrorPost(this.scene, this.cameraSys.camera);
    this.sfx = new Sfx();
    this.hud = new HUD();
    this.deployScreen = new DeployScreen();
    this.loadoutScreen = new LoadoutScreen();
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
    // The weapon is parented to the camera, so the camera has to exist first.
    this.player = new Player(this.scene, this.mats, this.cameraSys.camera);
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
    // Boots, from bots close enough for them to carry. `Sfx.botStep` rejects
    // the rest on distance — this fires for all 16 of them, so nothing
    // upstream should do work per step.
    this.battle.onBotStepped = (bot) => this.sfx.botStep(bot.position);
    // A round cracking past is a cue, not a hit. CombatSystem finds these
    // inside the target loop it already runs per shot, and has no business
    // knowing what a bot is — so the routing happens here.
    // The same event is the player's only warning that the rounds are meant
    // for them: a bot's report is spatialised and late, but the round itself
    // goes supersonic past the ear first. `suppress` ignores anything that
    // isn't a bot, so both handlers can take every near miss.
    this.combat.onNearMiss = (near, from) => {
      this.battle.suppress(near, from);
      if (near === this.player) this.sfx.nearMiss();
    };
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
        this.requestLock();
      }
      // The touch-device equivalent of the pointer lock: on a phone opened in
      // a browser tab there is no lock to take, and the URL bar is what is
      // eating the top of the screen. No-ops on the desktop and in an
      // installed app, which comes up fullscreen from the manifest.
      enterFullscreenOnTouch();
    });

    // Losing the pointer lock is the pause trigger, and it has to be, because
    // Escape belongs to the browser: it is the UA's own gesture for dropping
    // the lock and the keydown behind it is not reliably delivered to the page.
    // This catches every way out of a locked pointer — Escape, alt-tab, a
    // focus change — which is the same set of things that should stop the
    // round. `input.pausePressed` is the second trigger, for the pad player
    // (Start) and for the keyboard player who was not locked to begin with.
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === canvas;
      if (!locked && this.hadPointerLock && this.state === "playing") {
        this.pause();
      }
      this.hadPointerLock = locked;
    });
    window.addEventListener("keydown", () => this.sfx.unlock(), { once: true });
    window.addEventListener("resize", () => this.engine.resize());
    // A phone turned on its side reports the rotation before it has finished
    // laying the page out, so the resize that rides along with it can carry
    // the old dimensions — leaving the canvas stretched across a viewport it
    // no longer matches. The second, late resize is the one that lands.
    window.addEventListener("orientationchange", () => {
      this.engine.resize();
      window.setTimeout(() => this.engine.resize(), 300);
    });

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
    this.hud.onOpenLoadout = () => this.openLoadout();
    // The menu's and the round-over card's Deploy button. Guarded on the state
    // rather than trusted, because the overlay's markup outlives neither: the
    // handler is bound to a button that `hideOverlay` throws away, and a click
    // landing between that and the next repaint must not start a second round.
    this.hud.onStart = () => {
      if (this.state === "menu" || this.state === "roundover") this.startRound();
    };
    this.deployScreen.onOpenLoadout = () => this.openLoadout();
    this.loadoutScreen.onWeapon = (id) => this.setWeapon(id);
    this.loadoutScreen.onSight = (id) => this.setSight(id);
    this.loadoutScreen.onClose = () => this.closeLoadout();
    this.hud.onPauseAction = (action) => {
      // Restart needs nothing put back by hand: `startRound` lifts the lid,
      // hides the overlay and ends in `enterDeploy`, which sets the state.
      if (action === "resume") this.resume();
      else if (action === "restart") this.startRound();
      else this.enterMenu();
    };
    // Apply the remembered kit before anything is drawn: the viewmodel is
    // built with the defaults and the camera's zoom follows from the fit, so
    // deploying straight off a reload must not start on the wrong weapon.
    this.applyLoadout();
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
   * sky over the same map is the same sky it was last round — unlike the map
   * itself, which genuinely has to be rebuilt. The test is object identity,
   * which is why a `MapDef` has to be a module constant; switching maps brings
   * a different spec object and repaints, as it should.
   */
  private applySky(): void {
    const env = this.mapDef.environment;
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
    this.hud.showMenu(
      difficultyNames(),
      this.difficulty,
      kitLabel(this.weapon, this.sight),
    );
  }

  /**
   * Opens the loadout screen over whatever is on top of it, and remembers
   * which so closing it puts that back — the same lid-and-return shape the
   * pause menu has, and for the same reason: it is not a step in the
   * menu -> deploy -> playing cycle, it is a thing laid over two of them.
   *
   * Deliberately unreachable from `playing` and from the pause menu: a round
   * you are already standing in is not somewhere you get to change what you
   * are carrying. Nothing here enforces that — the states that offer the
   * button are the states that read `loadoutPressed`.
   */
  private openLoadout(): void {
    if (this.state !== "menu" && this.state !== "deploy") return;
    this.loadoutFrom = this.state;
    this.state = "loadout";
    this.loadoutScreen.setFit(this.weapon, this.sight);
    this.loadoutScreen.show();
    // The weapon comes out to be looked at. It is the real viewmodel on the
    // real camera — the kit screen shows what will be in the player's hands,
    // not a picture of it — which is why the screen's stage half is a hole in
    // its own scrim rather than a panel.
    this.player.inspectWeapon(true);
  }

  /**
   * Puts the kit screen away — the screen, the weapon on its stage, and the
   * lamp lighting it — without saying where the game goes next.
   *
   * Every exit owes all three, and there are four of them: the Done button,
   * the main menu, F2 into the editor and a round starting. The lamp is the
   * one that bites if it is missed. A carried light never loses its shader
   * slot and survives `lighting.clear()` between rounds, so one left behind
   * follows the player into the fight as a lantern nobody is holding.
   */
  private stowKit(): void {
    this.loadoutScreen.hide();
    this.player.inspectWeapon(false);
    CONFIG.lighting.kitLamps.forEach((_, n) =>
      this.lighting.removeCarried(kitLampId(n)),
    );
  }

  private closeLoadout(): void {
    if (this.state !== "loadout") return;
    this.stowKit();
    this.state = this.loadoutFrom;
    // The menu paints the kit into its own markup and was covered while it
    // changed, so it is redrawn on the way out. The deploy screen's caption is
    // a text node `applyLoadout` already patched.
    if (this.state === "menu") this.showMenu();
  }

  /**
   * Turns the weapon on the kit screen's stage, and keeps it lit while it is
   * there.
   *
   * The kit screen is the one overlay showing live 3D, so it owes by hand the
   * two per-frame pushes only `updateGameplay` normally makes. The camera
   * position is the load-bearing one: the cel shader fogs against `camPos`,
   * which outside a round is whatever the last gameplay frame left there —
   * `Vector3.Zero()` before the first one. A kit opened straight off the main
   * menu would put the weapon a whole map's width from where the shader thinks
   * the eye is, and fog it out to a flat grey silhouette. The other is the drag
   * itself, which is read consume-on-read from the screen and mixed with the
   * pad's right stick, so both devices turn the same turntable.
   *
   * The bench lamps are the third thing, and they go through `LightingSystem`
   * like every other light rather than being uploaded from here: carried
   * lights always win a slot, so one frame of `lighting.update` is all it
   * takes to put them on the weapon. `stowKit` takes them away again.
   */
  private updateKitStage(dt: number): void {
    const i = CONFIG.viewmodel.inspect;
    const drag = this.loadoutScreen.consumeDrag();
    const camera = this.cameraSys.camera;
    // Both axes are negated: a drag takes hold of the near face of the weapon,
    // so pulling right has to turn the far side left.
    this.player.updateInspect(
      -(drag.x * i.dragRate + this.input.stickLookX * i.stickRate * dt),
      -(drag.y * i.dragRate + this.input.stickLookY * i.stickRate * dt),
      camera.fov,
      this.engine.getAspectRatio(camera),
    );
    this.mats.updateCamera(camera.position);
    const eye = camera.position;
    const forward = this.cameraSys.forward;
    const right = this.cameraSys.flatRight;
    CONFIG.lighting.kitLamps.forEach((lamp, n) => {
      this.kitLampPos.set(
        eye.x + forward.x * lamp.ahead + right.x * lamp.side,
        eye.y + forward.y * lamp.ahead + right.y * lamp.side + lamp.up,
        eye.z + forward.z * lamp.ahead + right.z * lamp.side,
      );
      this.lighting.setCarried(
        kitLampId(n),
        this.kitLampPos,
        lamp.color,
        lamp.range,
        lamp.intensity,
      );
    });
    this.lighting.update(dt, camera.position, this.mats);
  }

  /**
   * Picks up a weapon, from the loadout screen and nowhere else.
   *
   * Applied immediately, magazine and all: it is only reachable from the menu
   * and the deploy screen, where the gun is already put away, so there is no
   * round in flight for a swap to interrupt.
   */
  private setWeapon(id: WeaponId): void {
    if (id === this.weapon) return;
    this.weapon = id;
    writeWeapon(id);
    this.applyLoadout();
  }

  /** Fits an optic. Same reachability, same immediacy. */
  private setSight(id: SightId): void {
    if (id === this.sight) return;
    this.sight = id;
    writeSight(id);
    this.applyLoadout();
  }

  /**
   * Pushes the kit to everything that reads it: the player (what the rounds
   * do, and which model ADS poses), the camera (how far it zooms, how much it
   * slows, how fast it gets there), and the three captions. Split from the
   * setters because the constructor owes the same push for a kit nobody just
   * picked, and because both halves of the loadout owe all of it — a weapon
   * change re-derives the aimed pose exactly as an optic change does.
   */
  private applyLoadout(): void {
    this.player.setWeapon(this.weapon);
    this.player.setSight(this.sight);
    this.cameraSys.setLoadout(this.weapon, this.sight);
    const label = kitLabel(this.weapon, this.sight);
    this.hud.setKit(label);
    this.deployScreen.setKit(label);
    this.loadoutScreen.setFit(this.weapon, this.sight);
    // The menu draws the kit into its own markup, so it has to be rebuilt;
    // the other two were just patched above.
    if (this.state === "menu") this.showMenu();
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
          // Left/right is the difficulty row — the only picker left on this
          // screen now that the kit has one of its own. `L` (pad X) opens it.
          if (this.input.menuLeftPressed) this.setDifficulty(this.difficulty - 1);
          if (this.input.menuRightPressed) this.setDifficulty(this.difficulty + 1);
          if (this.input.loadoutPressed) {
            this.openLoadout();
            break;
          }
        }
        if (this.input.confirmPressed && this.overlayT > 0.5) {
          this.startRound();
        }
        break;
      case "deploy":
        if (this.input.pausePressed) {
          this.pause();
          break;
        }
        // The same key, and the reason the deploy screen offers it at all:
        // the wait for reinforcements is the one moment inside a round when
        // the weapon is already put away.
        if (this.input.loadoutPressed) {
          this.openLoadout();
          break;
        }
        this.respawnT -= dt;
        // Stepped before the redraw, so the marker and the status line move on
        // the frame the key was pressed. Both axes step the same list — the
        // spawns are a handful of points scattered over a map rather than a
        // row or a column, so there is no axis that "means" anything, and a
        // d-pad direction that does nothing reads as a screen that ignores the
        // pad.
        if (this.input.menuRightPressed || this.input.menuDownPressed) {
          this.deployScreen.moveSelection(1);
        }
        if (this.input.menuLeftPressed || this.input.menuUpPressed) {
          this.deployScreen.moveSelection(-1);
        }
        this.deployScreen.update(this.respawnT);
        // Enter / gamepad A deploys at the current selection; the map takes its
        // own clicks and the kit button takes its own, so the MOUSE IS LEFT OUT
        // (`menuConfirmPressed`) — the same rule the pause and kit screens
        // follow, and here it is load-bearing rather than tidy. The menu's
        // Deploy button changes the state on the down edge, which puts this
        // case in front of the very click that asked for it; a confirm that
        // counted the mouse would deploy the player through the screen they
        // just opened, at whichever spawn the list happened to start on.
        if (this.input.menuConfirmPressed) this.deployScreen.confirm();
        break;
      case "loadout":
        // Two axes, two slots: up/down chooses which half of the kit is being
        // edited, left/right steps through it. Back, confirm and pause all
        // close — there is nothing to confirm here, every pick has already been
        // applied to the weapon behind the screen, so B and A do the same
        // thing and B is the one a pad player will reach for. The mouse is left
        // out of the confirm (`menuConfirmPressed`) because a click on the
        // empty half of the screen is not a choice, the same rule the pause
        // menu follows.
        if (
          this.input.menuBackPressed ||
          this.input.pausePressed ||
          this.input.menuConfirmPressed ||
          this.input.loadoutPressed
        ) {
          this.closeLoadout();
          break;
        }
        if (this.input.menuUpPressed) this.loadoutScreen.moveSlot(-1);
        if (this.input.menuDownPressed) this.loadoutScreen.moveSlot(1);
        if (this.input.menuLeftPressed) this.loadoutScreen.cycle(-1);
        if (this.input.menuRightPressed) this.loadoutScreen.cycle(1);
        this.updateKitStage(dt);
        break;
      case "playing":
        if (this.input.pausePressed) {
          this.pause();
          break;
        }
        this.updateGameplay(dt);
        break;
      case "paused":
        // Pause is checked first and breaks: Start raises `pausePressed` and
        // `confirmPressed` on the same frame, and resuming must not also fire
        // whichever item the selection happens to be on.
        // B backs out of a pause the same way it backs out of the kit screen:
        // the lid comes off and the state under it comes back, which is what
        // "Resume" does anyway.
        if (this.input.pausePressed || this.input.menuBackPressed) {
          this.resume();
          break;
        }
        if (this.input.menuUpPressed) this.hud.movePauseSelection(-1);
        if (this.input.menuDownPressed) this.hud.movePauseSelection(1);
        // Keyboard/pad confirm only — the buttons handle their own clicks, and
        // a click on the empty half of the screen is not a menu choice.
        if (this.input.menuConfirmPressed) this.hud.activatePause();
        break;
      case "editor":
        this.updateEditor(dt);
        break;
    }

    // A pause stops the HUD's clock too: the killfeed, the toasts and the
    // damage vignette are all part of the frozen frame, and a fight fading off
    // the screen while nothing in the world moves is the tell that the pause
    // is only skin deep. Every other state passes the real dt.
    this.hud.update(this.state === "paused" ? 0 : dt);
    this.post.update(dt);
    this.sky.update(dt);
    // After every state has had its go at the camera, and before the render
    // that the shafts are drawn into.
    this.godRays.update(
      this.scene,
      this.cameraSys.camera,
      this.sky.moonDirection,
    );
    // Every frame in every state, so the basis it reprojects against can never
    // go stale while the player sits in a menu. In the editor the free-fly cam
    // drives the Babylon camera directly and never touches these angles, so
    // the pass sees no rotation and stays inert — which is what we want in an
    // authoring tool.
    this.motionBlur.update(this.cameraSys.aimYaw, this.cameraSys.aimPitch);
    this.scene.render();
  }

  /**
   * Takes the pointer lock back, tolerating the browser saying no.
   *
   * Chrome refuses a fresh lock for about a second after the user pressed
   * Escape to leave one — which is precisely the sequence a pause menu ends
   * with — and reports it by rejecting the promise. That is not an error worth
   * surfacing: the lock hint is already on screen and the player's next click
   * takes the lock through the `pointerdown` handler above. Older browsers
   * return nothing at all from this call, hence the shape of the check.
   */
  private requestLock(): void {
    const pending = this.canvas.requestPointerLock() as unknown as
      | Promise<void>
      | undefined;
    if (pending && typeof pending.catch === "function") {
      pending.catch(() => {});
    }
  }

  /**
   * Puts a lid on the round. Reachable from `playing` and from `deploy` — a
   * player waiting out a respawn timer should not have to watch it run down
   * before they can leave — and it remembers which, because resuming has to
   * put the game back where it was rather than moving it on.
   *
   * Nothing here stops the render loop: `tick` simply stops calling
   * `updateGameplay`, so the scene, the sky and the post chain all keep
   * drawing the frozen frame. That is what the menu and the round-over screen
   * already do, and it is why a paused round reads as held rather than gone.
   */
  private pause(): void {
    if (this.state !== "playing" && this.state !== "deploy") return;
    this.pausedFrom = this.state;
    this.state = "paused";
    this.hud.setPaused(true);
    this.hud.showPause();
    // Suspends the audio clock, so the tail of the last shot is still there
    // when the round starts again instead of ringing out over the menu.
    this.sfx.setSuspended(true);
    document.exitPointerLock();
  }

  /**
   * Lifts the lid without deciding where the game goes next. Every exit from
   * `paused` owes this — including F2 into the editor, which is why it is a
   * method and not three lines repeated in `resume`.
   */
  private clearPause(): void {
    this.hud.setPaused(false);
    this.sfx.setSuspended(false);
  }

  private resume(): void {
    if (this.state !== "paused") return;
    this.hud.hideOverlay();
    this.clearPause();
    this.state = this.pausedFrom;
    if (this.state === "playing") {
      // The click that chose "Resume" is still held, and it is about to become
      // the click that takes the pointer lock back — the same trap the deploy
      // map's click documents in `spawnPlayer`.
      this.input.consumeFire();
      this.requestLock();
    }
  }

  /**
   * Back to the main menu, from the pause screen. Mirrors `endRound` minus a
   * result: the round is abandoned rather than finished, so there is no winner
   * to show and nothing to keep.
   *
   * The map is deliberately left standing. `startRound` rebuilds it anyway,
   * and disposing it here would only trade a live backdrop for an empty one.
   */
  private enterMenu(): void {
    this.state = "menu";
    this.clearPause();
    this.deployScreen.hide();
    this.stowKit();
    this.minimap.setVisible(false);
    this.player.setBodyHidden(true);
    this.hud.setScoreboard(false);
    this.hud.clearDamageDirections();
    this.hud.setCapture(null);
    this.battle.reset();
    document.exitPointerLock();
    // Same gate the round-over screen uses: the confirm that got here must not
    // fall through into starting the next round.
    this.overlayT = 0;
    this.showMenu();
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
    // F2 is reachable from the pause menu, and an editor session that inherited
    // a suspended audio context and a hidden crosshair would be a puzzle.
    this.clearPause();
    this.hud.setEditing(true);
    this.deployScreen.hide();
    // F2 is reachable from the loadout screen too, and it would sit over the
    // editor's own panel.
    this.stowKit();
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
      layout: this.mapDef.layout,
      environment: this.mapDef.environment,
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
   * Throws the standing map away, builds `this.mapDef` afresh, and hands the
   * result to everything that reads geometry or environment off it.
   *
   * THE ONE PLACE A MAP IS BUILT. Both callers — a round starting and an editor
   * rebuild — owe this whole sequence, and before it was one method they were
   * two copies of it that had already drifted apart. The failure mode is silent
   * in the worst way: a system added to the round's copy and forgotten in the
   * editor's keeps a cached pointer into a disposed map, so the editor renders
   * last build's water over this build's terrain and nothing throws. Anything
   * new that consumes a `GameMap` or an `EnvironmentSpec` goes here, and both
   * callers get it.
   *
   * What deliberately stays with the callers is what they genuinely disagree
   * about: the round applies the environment and repaints the sky, while the
   * editor drives `applyEnvironment` itself so it can toggle its work light;
   * and the round alone owns the things that are about a FIGHT rather than a
   * map — battle, conquest, the flag markers and the minimap.
   *
   * The particle field is the one thing the editor gains by being folded in
   * here, and it is a fix rather than a side effect: `atmosphere.apply` used to
   * be the round's alone, so an editor opened from a live round drifted ash and
   * one opened from the main menu did not. It is the map's own weather and it
   * now runs in both. What strips the night back for authoring is the work
   * light, which is the editor's to toggle.
   *
   * `editor: true` keeps geometry per layout item instead of block-merging it,
   * which is what makes an individual placement selectable. It costs ~10x the
   * draw calls — never judge frame cost from the editor.
   */
  private installMap(opts?: BuildOptions): GameMap {
    const { layout, environment } = this.mapDef;
    this.map?.dispose();
    this.combat.clearTransient();
    // The flag markers are geometry hung off the old map's terrain. The editor
    // draws proxies of its own and would double every ring; a round rebuilds
    // them below. Either way they cannot survive the map they were placed on.
    this.zones.dispose();
    const map = this.mapBuilder.build(layout, environment, opts);
    this.map = map;
    // The shadow camera follows the environment's key light, and its casters
    // are the fresh map's visuals — last build's meshes are now disposed.
    this.shadows.setLightDirection(environment.lighting.direction);
    this.shadows.setFogRange(environment.fogStart, environment.fogEnd);
    this.shadows.setCasters(map.visuals);
    this.atmosphere.apply(environment.particles, map.size, map.size);
    this.water.build(map.water, environment, map.terrain);
    this.grass.build(map.grass, environment, map.colliderBoxes, map.terrain);
    this.player.setTerrain(map.terrain);
    return map;
  }

  /**
   * The editor's rebuild. Called on entry and again whenever it changes
   * something the builders read — a param, a kind, an added or deleted entry.
   *
   * Deliberately does NOT re-point battle/conquest/minimap: those keep pointing
   * at a map that is now disposed, which is safe only because leaving the
   * editor always runs `startRound` and hands them a fresh, properly merged
   * build.
   */
  private buildEditorMap(): GameMap {
    return this.installMap({ editor: true });
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
    // Reachable from the menu, so the kit screen may still be up over it.
    this.stowKit();
    // Reachable straight from the pause menu ("Restart round"), and harmless
    // from anywhere else.
    this.clearPause();
    // Re-draw skills for the chosen tier. The rig pool is never disposed, so
    // this is the only place the roster's difficulty can change.
    this.battle.setDifficulty(this.difficulty);

    // The environment goes on before the build: the sky is painted from it,
    // and the cel materials the map's meshes are created against read their
    // fog and key light off the uniforms this writes.
    const env = this.mapDef.environment;
    applyEnvironment(this.scene, env, this.mats);
    this.applySky();
    const map = this.installMap();

    this.battle.setMap(map);
    this.battle.reset();
    this.conquest.start(map);
    // The flags' markers read the same radius ConquestSystem tests against,
    // and follow the same terrain the ring is drawn across.
    this.zones.build(map.controlPoints, map.terrain, map.nav, env);
    this.player.fullReset();
    this.player.team = 0;
    this.minimap.setMap(map, this.player.team);
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
    // The aim just jumped to the spawn heading. Reprojecting through that jump
    // would greet the player with one frame smeared across the whole screen.
    this.motionBlur.reset();
    this.deployScreen.hide();
    this.player.setBodyHidden(false);
    this.minimap.setVisible(true);
    // Deploying by clicking the map arrives here from a pointerdown whose
    // button is still down, and which is about to grab pointer lock on its way
    // up the DOM — so the fire gate below would be satisfied by the very click
    // that spawned the player. Hold the trigger until it is released.
    this.input.consumeFire();
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
    const ev = this.player.update(dt, this.input, this.cameraSys);
    if (ev.jumped) this.sfx.jump();
    if (ev.footstep > 0) this.sfx.step(ev.footstep);
    // Landing is scaled across the fall speeds that count as one at all, so a
    // hop off a kerb is a step and a drop off the terrace is not.
    if (ev.landed > 0) {
      const f = CONFIG.audio.footstep;
      if (ev.landed >= f.landMinSpeed) {
        this.sfx.land(
          Math.min(
            1,
            (ev.landed - f.landMinSpeed) / (f.landFullSpeed - f.landMinSpeed),
          ),
        );
      }
    }
    if (this.input.reloadPressed && this.player.startReload()) {
      this.sfx.reload(this.player.reloadTime);
    }

    // --- shooting (hitscan from the camera through the crosshair) ---
    // Mouse fire requires pointer lock so UI clicks never discharge the gun.
    // The deploy map's click is the exception that gate cannot see — it is the
    // click that TAKES the lock — and `spawnPlayer` calls `consumeFire()` for it.
    // The trigger goes IN rather than gating the call: a semi-automatic weapon
    // has to be told when it comes up, and only Player knows whether the one
    // being carried cares.
    const canFire = this.input.pointerLocked || this.input.gamepadConnected;
    if (this.player.tryShot(this.input.fire && canFire)) {
      const blend = this.cameraSys.adsBlend;
      const spread = this.player.spread(blend);
      // Tracers, the flash light and the noise all start at the viewmodel's
      // muzzle — about half a metre in front of the eye. That is the rifle
      // on screen, so it is the one the shot has to appear to come from.
      const muzzle = this.player.muzzleWorld();
      const shot = this.combat.fire(
        this.cameraSys.camera.position,
        this.cameraSys.forward,
        spread,
        this.player.damage,
        muzzle,
        this.battle.hittablesAgainst(this.player.team),
        this.player.range,
      );
      // Bots hear the player's rifle the same way they hear each other's. This
      // is the only place the player's own gunfire enters the world, so it is
      // the only place that can say so.
      this.battle.hearGunshot(muzzle, this.player.team);
      // Recoil: kick the aim up and off to a random side, softened while
      // braced in ADS. It decays on its own, so the burst climbs and settles.
      // The weapon's own multiplier rides on top of the ADS damping: a
      // 13-round-a-second SMG on the rifle's per-shot kick walks the muzzle
      // off the screen inside half a magazine.
      const rc = CONFIG.recoil;
      const kickMult = (1 - (1 - rc.adsMult) * blend) * this.player.recoilMult;
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
      this.sfx.shoot(this.player.sfxPitch);
      const haptic = CONFIG.rumble;
      this.input.rumble(haptic.shotStrong, haptic.shotWeak, haptic.shotMs);
      if (shot.target) {
        const killed = shot.killed && shot.target instanceof Bot;
        // Resolved before the marker so a kill gets the red one — the cue to
        // stop putting rounds into a body that is already going down.
        this.hud.flashHitmarker(killed);
        this.sfx.hit();
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
      if (this.player.reloading) this.sfx.reload(this.player.reloadTime);
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
    // First person: the camera goes to the eye the bots shoot at, so what a
    // bot can see of you is exactly what you can see of it.
    this.cameraSys.update(dt, this.input, this.player.eyePos, assist);
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
    this.hud.setCrosshair(this.cameraSys.adsBlend, spreadPx);
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
      map: this.mapDef.name,
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
    // `updateGameplay` stops here, so the viewmodel would freeze mid-pose in
    // front of a dead player's last view. In third person the body simply
    // stood where it fell; a rifle stuck to the camera has to be put away.
    this.player.setBodyHidden(true);
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
    this.player.setBodyHidden(true); // same reason as enterDeploy
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
      this.mapDef.name,
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
