/**
 * Game.ts — Orchestrator: engine/scene init, state machine, main loop, and ALL
 * cross-system wiring. The only place systems meet — systems never import each
 * other; new cross-system behavior is a callback wired here.
 * WHERE THINGS ARE, because this is a long file and a change should not need a
 * read of it: the constructor is CONSTRUCTION ONLY (a linear list of `new X`,
 * which has to stay there — those fields are what strictPropertyInitialization
 * checks) and ends in three calls. Cross-system callbacks are `wireSystems` and
 * the four subject methods under it (`wireDeaths`, `wireGrenades`, `wireBattle`,
 * `wireConquest`) — a new one goes in whichever names its subject. Browser
 * listeners are `installDomListeners`. Screen callbacks are `wireScreens`.
 * `tick` is a dispatch: the input handling for each screen is its own
 * `update*Screen`/`updateMenuCard`/`updatePauseMenu` method, and only `playing`,
 * `dying` and `editor` are inline, because they are two lines each.
 * The remembered difficulty/map/loadout live in `prefs.ts`, the display
 * settings in `settings.ts`; neither applies anything, that is this file's job.
 * State machine: menu -> deploy -> playing (deploy re-entered on each death)
 * -> roundover. The 3D scene renders live behind every state.
 * Load-bearing frame order at the end of updateGameplay: camera update ->
 * carried lights -> lighting.update() -> sfx.setListener(). The shader's eye
 * (mats.updateCamera) is NOT in that chain — it is pushed once per frame in
 * `tick`, because every state renders and only some of them simulate.
 * ConquestSystem.update runs before BattleSystem.update (bots see this frame's
 * flag ownership). Muzzle-flash light budget is spent here
 * (spendMuzzleLightBudget) — new per-bot transient lights need the same
 * treatment; a grenade's blast light is deliberately outside it (seconds
 * apart, not eighty a second). A bot goes down through registerBotKill
 * whichever of the three things killed it — rifle, player rifle, grenade — and
 * whoever put it there is credited through creditKill, one door each: the
 * victim's death is known where it fell and the kill only where it was fired.
 * The map is a `MapDef` held in one field (`mapDef`) and built in one method
 * (`installMap`), which both a round start and an editor rebuild go through —
 * no map's layout or environment may be named anywhere else in here.
 * Also owns: GlowLayer scan (construction-time only; metadata.noGlow contract)
 * and its distance fade (customEmissiveColorSelector — the bloom is the one
 * pass that reads a material and never asks where the mesh stands, so without
 * it a glow is the last thing left when the world around it has gone to fog;
 * infiniteDistance exempts the moon),
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
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { CONFIG, FOG_WALL } from "../config";
import {
  CelMaterialFactory,
  fogAmountAt,
  updateOutlineScales,
} from "../shaders/CelShader";
import { GodRays } from "../shaders/GodRays";
import { HorrorPost } from "../shaders/HorrorPost";
import { MotionBlur } from "../shaders/MotionBlur";
import { Bot } from "../entities/Bot";
import { difficultyNames } from "../entities/BotSkill";
import { callsign } from "../entities/callsigns";
import type { Combatant, Team } from "../entities/Combatant";
import { NetSession } from "../net/NetSession";
import { fetchMatches } from "../net/lobby";
import type { ServerEvent } from "../net/protocol";
import { Player } from "../entities/Player";
import { type SightId } from "../entities/sights";
import { VIEWMODEL_GROUP } from "../entities/ViewModel";
import { type PrimaryWeaponId } from "../entities/weapons";
import { AimAssistSystem } from "../systems/AimAssistSystem";
import { Atmosphere } from "../systems/Atmosphere";
import { BattleSystem } from "../systems/BattleSystem";
import { CaptureZoneSystem } from "../systems/CaptureZoneSystem";
import { CombatSystem, type Hittable } from "../systems/CombatSystem";
import { ConquestSystem } from "../systems/ConquestSystem";
import { DeathCam } from "../systems/DeathCam";
import { GrassSystem } from "../systems/GrassSystem";
import { GrenadeSystem } from "../systems/GrenadeSystem";
import { RagdollSystem } from "../systems/RagdollSystem";
import { LightingSystem } from "../systems/LightingSystem";
import { ShadowSystem } from "../systems/ShadowSystem";
import { Sky } from "../systems/Sky";
import { WaterSystem } from "../systems/WaterSystem";
import { applyEnvironment, type EnvironmentSpec } from "../world/environment";
import type { EditorSession } from "../editor";
import { MAPS, type MapDef } from "../world/maps";
import { MapBuilder, type BuildOptions, type GameMap } from "../world/MapBuilder";
import { DeployScreen } from "../ui/DeployScreen";
import { HUD, type CaptureStatus, type ScoreRow } from "../ui/HUD";
import { OverlayScreen } from "../ui/OverlayScreen";
import { kitLabel, LoadoutScreen } from "../ui/LoadoutScreen";
import { SettingsScreen } from "../ui/SettingsScreen";
import { LobbyScreen } from "../ui/LobbyScreen";
import { Minimap } from "../ui/Minimap";
import { enterFullscreenOnTouch } from "../pwa/register";
import { CameraSystem } from "./CameraSystem";
import { InputManager } from "./InputManager";
import {
  readDifficulty,
  readMap,
  readSight,
  readWeapon,
  writeDifficulty,
  writeMap,
  writeSight,
  writeWeapon,
} from "./prefs";
import { readSettings, writeSettings, type Settings } from "./settings";
import { Sfx } from "./Sfx";

/**
 * `menu` -> `loading` -> `deploy` -> `playing` -> `dying` -> `deploy`, with
 * `roundover` when one side runs out of tickets.
 *
 * `loading` is the map being built, and it is a STEP for the same reason
 * `dying` is: it is a thing the game is doing, not a lid over one. It lasts
 * exactly one frame of wall clock and an indeterminate amount of it — the
 * build is ~0.7 s of synchronous work, which is a freeze if nothing says
 * otherwise (see `startRound`, which is the split that lets the card be drawn
 * first). It exists as a STATE rather than as a flag because the frame in
 * between belongs to nobody otherwise: `tick` would keep dispatching to the
 * menu it just left, and a second confirm in that window would start a second
 * round on top of the first. Nothing may simulate here — there is no map yet.
 *
 * `dying` is the death cam: the player is down, a body is falling where they
 * stood, and the camera has left the head to watch it. It is a STEP in the
 * cycle rather than a lid, and that distinction is the whole feature — the
 * fight carries on underneath it (`updateWorld` runs in full), where a lid
 * stops everything. It ends on its own clock, and the deploy screen it opens
 * subtracts the time already spent, so a life costs what it always did.
 *
 * `deploy` simulates nothing and never may — offline the world is genuinely
 * held while the map is up. In a NETPLAY round it is the one state outside the
 * fight that still steps the netplay half of a frame (`updateNetWorld`), which
 * is not the same thing: the authority has not paused, and everything this
 * screen shows — the flags its offer is derived from, the tickets on the strip
 * under it, the bodies moving behind it — arrives from a frame. It is also the
 * state a player LEAVES by asking rather than by acting: `onDeploy` sends a
 * request and the server's own spawn event is what puts them in the world.
 *
 * `paused` is the other side state, and unlike the rest it remembers where it
 * came from (`pausedFrom`): a pause is a lid over `playing`, `dying` or
 * `deploy`, and resuming puts the state back exactly as it was rather than
 * moving the game on. Nothing simulates while it is up — the scene still
 * renders, which is what makes a paused round look held rather than gone.
 *
 * `loadout` and `settings` are lids of the same shape, each remembering what it
 * covered. The kit screen covers `menu` or `deploy`; the settings screen also
 * covers `paused`, because turning an effect off is something you judge against
 * the scene rather than from the title card — which makes it the one lid that
 * can be raised over another one.
 *
 * `lobby` is a lid too, and the simplest of the three: it covers `menu` and
 * only `menu`, so it needs no `-From` field to remember where it came from.
 * Picking a match out of it leaves through `startRound` exactly as Deploy does,
 * which is why the lobby is not a step in the state machine — a networked round
 * and a single-player one are the same `loading -> deploy -> playing` cycle,
 * differing only in whether `Game.net` exists.
 *
 * `editor` sits outside that cycle: it is a dev-only side state reachable from
 * anywhere with F2, and leaving it always restarts the round rather than
 * resuming, because the systems that cache the GameMap cannot be handed a map
 * that was rebuilt underneath them.
 */
type GameState =
  | "menu"
  | "loading"
  | "deploy"
  | "playing"
  | "dying"
  | "paused"
  | "loadout"
  | "settings"
  | "lobby"
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
  /** The menu, the round-over card and the pause list. */
  private overlayScreen: OverlayScreen;
  private deployScreen: DeployScreen;
  private loadoutScreen: LoadoutScreen;
  private settingsScreen: SettingsScreen;
  private lobbyScreen: LobbyScreen;
  private minimap: Minimap;
  private sfx: Sfx;
  private mapBuilder: MapBuilder;
  private combat: CombatSystem;
  /** Thrown grenades — the one thing on the map that is not hitscan. */
  private grenades: GrenadeSystem;
  /** Corpses under physics. The only Havok in the game, and optional. */
  private ragdolls: RagdollSystem;
  /** The player's own death: a stand-in body, and the camera that watches it. */
  private deathCam: DeathCam;
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
  /**
   * Whether the shaft pass is on the camera, and which slot of the camera's
   * post-process list it occupies. True to begin with — the constructor
   * attaches it — and the first `syncGodRays` takes it off if the moon is not
   * in frame.
   */
  private godRaysAttached = true;
  private godRaysSlot = 0;
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
   * Held across `toggleEditor`'s dynamic `import()`, because `this.editor` is
   * not the latch it looks like: it is not assigned until the session has been
   * built, which is a map build and a screenful of teardown after the await
   * returns. Two F2s inside a cold import both got past `if (this.editor)` and
   * ran the whole opening twice — a second `installMap` disposing the map the
   * first had just handed to `createEditor`, and the first session leaked with
   * no reference left to dispose it. Dev builds only, and the window is one
   * cold load wide, but it is exactly the failure `installMap` exists to stop.
   */
  private editorLoading = false;

  /**
   * Viewport height in CSS pixels, refreshed by `applyRenderScale` — which is
   * also the resize handler, so it is exactly the moment this can change. Only
   * the crosshair's spread projection reads it.
   */
  private viewportHeight = window.innerHeight;
  /**
   * The map being played, as the layout/environment pair `src/world/maps.ts`
   * keeps together. The single place either half is named: everything from the
   * round start to the editor session reads it off here, so a second map is a
   * `MapDef` in that registry and a write to this field, not a hunt through the
   * orchestrator for the fourteen places the old constants were spelled out.
   */
  private mapDef: MapDef = readMap();

  private state: GameState = "menu";
  /** Which state the pause menu is a lid over; where `resume()` puts it back. */
  private pausedFrom: "playing" | "dying" | "deploy" = "playing";
  /**
   * Whether the pointer was locked as of the last `pointerlockchange`. Losing
   * the lock is what pauses the game, and only a *transition* out of it counts
   * — a pad player who never took the lock has none to lose.
   */
  private hadPointerLock = false;
  /**
   * `performance.now()` of the last time the lock was TAKEN. A loss inside
   * `CONFIG.input.lockGrace` of it is the browser finishing an Escape it had
   * already started rather than the player leaving, and does not pause.
   */
  private lockTakenAt = 0;
  /**
   * A resume that still owes the pointer lock: how long it has been owed, and
   * how long until the next attempt. See `updatePendingLock`.
   */
  private lockPending = false;
  private lockPendingT = 0;
  private lockRetryT = 0;
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
  private weapon: PrimaryWeaponId = readWeapon();
  /** Which state the loadout screen is a lid over; where closing it returns. */
  private loadoutFrom: "menu" | "deploy" = "menu";
  /**
   * The display settings, and which state their screen is a lid over.
   *
   * `paused` is in the list where the kit screen's is not: a round you are
   * standing in is not somewhere you change what you carry, but it is exactly
   * where you want to judge an effect you have just turned off.
   */
  private settings: Settings = readSettings();
  private settingsFrom: "menu" | "deploy" | "paused" = "menu";
  /** Reused each frame: the player plus every bot, for objective occupancy. */
  /**
   * The networked round, or null offline.
   *
   * A field and a branch rather than a mode flag threaded through everything:
   * with no session, every path below runs exactly as it always has, and
   * nothing in `src/net/` is even constructed. What the branch buys is that the
   * two authorities — this machine and the server — can never both be running,
   * which is the failure that would be invisible and unfixable.
   */
  private net: NetSession | null = null;

  /**
   * Which match server to talk to, for both the lobby's list and the socket.
   *
   * `undefined` is the deployed case and means the page's own origin, which is
   * where nginx answers `/ws` and `/matches`. It is only ever something else in
   * DEV, from `?server=` or `?mp=` — the client is on Vite's port then and the
   * server on its own, with nothing in between to make them one origin.
   *
   * One field for both because they are one server. Letting the list and the
   * socket be aimed separately would make "browsing one server and joining
   * another" representable, which is not a thing anybody wants and is a bug the
   * moment it happens by accident.
   */
  private netUrl: string | undefined;

  /**
   * What to call this player on the wire. Server-side it is truncated and
   * stripped (see `MAX_NAME_LENGTH`); this is only what gets offered.
   *
   * Still `?name=` and a default, because the menu has no text entry anywhere
   * in it and adding one is its own feature — a focused input has to be kept
   * from feeding the game's own key handling, and neither the pad nor the
   * on-screen path exists. Named as a field rather than read at the join so
   * there is one obvious place for that feature to land.
   */
  private playerName = "player";

  private readonly combatants: Combatant[] = [];
  /** Scratch for the shadow focus point — no per-frame allocation. */
  private readonly shadowFocus = new Vector3();
  /**
   * Four scratch aim directions, one per per-frame reader of
   * `CameraSystem.forward`. Separate rather than shared because the shadow
   * focus SCALES the vector it is handed: one scratch between them would work
   * today only because the aim assist happens to read its copy before that
   * happens, which is a property of two files agreeing rather than of either.
   * The kit stage's is its own for the weaker version of the same reason — it
   * runs in a state where the other three do not, so sharing would rest on
   * which states are lids rather than on anything this line can hold.
   */
  private readonly aimForward = new Vector3();
  private readonly shadowForward = new Vector3();
  private readonly listenerForward = new Vector3();
  private readonly kitForward = new Vector3();
  /** …and the kit stage's flat right, the one per-frame reader of that pair. */
  private readonly kitRight = new Vector3();
  /** …and for the carried lamp, which rides a little above the player. */
  private readonly lampPos = new Vector3();
  /** …and for the kit screen's bench lamp, placed relative to the camera. */
  private readonly kitLampPos = new Vector3();
  /** …and for where a thrown grenade leaves the player's hand. */
  private readonly grenadeHand = new Vector3();
  /** Counts down while the player is waiting to redeploy. */
  private respawnT = 0;
  /**
   * What this life owes before the next one, latched by `enterDying` and spent
   * by `updateDeathCam` when the shot is over. Offline it is the config
   * constant; in a networked round it is whatever the `died` event said.
   */
  private deathRespawnIn: number = CONFIG.conquest.respawnDelay;
  /** Where the player's feet were when they died — scratch for `enterDying`. */
  private readonly deathFeet = new Vector3();
  /**
   * The round's scoreboard, OFFLINE: one line per body, indexed by bot.
   *
   * Per body rather than per team, because the team totals are the sum of the
   * rows and a second set of counters for them is a second set that can drift.
   * The player is not in these — they are not in the bot pool — and their own
   * two numbers are below, which is the same split every other list in this
   * file makes between `battle.bots` and `this.player`.
   *
   * **Netplay writes none of this.** In a match the board is the authority's
   * and arrives whole (`NetSession.slotKills`): this client runs no AI, its
   * local `BattleSystem` is a pool of dead bodies nobody steps, and a client
   * that added up the kill events it happened to receive would show a
   * different board on every screen. `scoreRows` is where the two sources
   * meet, and it is the only reader of either.
   */
  private readonly botKills: number[] = [];
  private readonly botDeaths: number[] = [];
  private playerKills = 0;
  private playerDeaths = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // **No MSAA, and that is a saving rather than a downgrade.** Asking for it
    // gave a 4x multisampled DEFAULT framebuffer — but the pipeline runs FXAA,
    // so every pass of the scene renders into post-process render targets and
    // the only thing ever drawn to the default framebuffer is the final
    // full-screen quad. The multisampling was antialiasing one quad's edges, of
    // which there are none, and paying a resolve every frame and ~30 MB at 720p
    // (66 MB at 1080p) to do it. FXAA still does the actual antialiasing.
    //
    // No stencil either: nothing in `src/` uses one, and there is no
    // `HighlightLayer` (the effect layer that would).
    //
    // `adaptToDeviceRatio` is deliberately still not passed. It would pin the
    // backing store to the display, and the resolution is a player setting —
    // `applyRenderScale` owns the scaling level from the first `applySettings`.
    this.engine = new Engine(canvas, false, {});
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
    // The bloom is the ONE pass that reads a material and never asks where the
    // mesh carrying it stands, so without this a glow is the last thing left
    // when everything around it has gone to fog: Greyfen's chapel windows are
    // 0.08 m slivers whose whole read at 60 m is bloom, and they sat on a wall
    // faded almost to white as three saturated cyan bars. Fogging the emissive
    // MATERIAL cannot fix it — the glow map is generated from the emissive
    // colour directly, so the base pass and the bloom have to be attenuated
    // separately, and the bloom is by far the larger term.
    //
    // This replaces Babylon's own selector wholesale, so it owes the default's
    // two other behaviours: `emissiveIntensity`, and the neutral colour for a
    // material with no emissive at all (every cel ShaderMaterial in the scene
    // reaches here, since the layer holds everything not explicitly excluded).
    // It does NOT reproduce an emissive texture's `level`, which is sound only
    // while nothing in this game pairs a texture with a glow — the moon is the
    // one textured emissive and it is exempt below.
    //
    // `infiniteDistance` is the exemption and it is exactly the right test:
    // every sky mesh sets it (see Sky.prepare), it means "this rides with the
    // camera", and the moon is the one glowing thing that must never fog — it
    // is not in the valley, and its bounding sphere is a dome radius away, so
    // any distance fade would delete it outright.
    glow.customEmissiveColorSelector = (mesh, _subMesh, material, result) => {
      // The kit screen hangs a dark card behind the weapon (see
      // `inspect.backdrop`), and the one thing in the game that card cannot
      // cover is this: a glow layer is composited over the FINISHED frame, so
      // a lamp the bench is standing in front of blooms straight through it.
      // Only what is on the stage may bloom while the stage is up, which
      // still leaves the reticle and the hot parts of the weapon itself
      // glowing — exactly what the screen is for. "On the stage" is the
      // viewmodel's rendering group MINUS the sky, which shares it (see
      // `Sky`'s constructor) and is picked back out by the same
      // `infiniteDistance` the fog exemption below turns on: without that
      // second half the moon hangs its bloom over the bench.
      if (
        this.state === "loadout" &&
        (mesh.renderingGroupId !== VIEWMODEL_GROUP || mesh.infiniteDistance)
      ) {
        result.set(0, 0, 0, material.alpha);
        return;
      }
      const emissive = (material as StandardMaterial).emissiveColor;
      if (!emissive) {
        const n = glow.neutralColor;
        result.set(n.r, n.g, n.b, n.a);
        return;
      }
      // Read off the base Material: only PBR declares it, and this selector
      // runs for whatever the layer holds.
      const level =
        (material as { emissiveIntensity?: number }).emissiveIntensity ?? 1;
      let k = level;
      if (!mesh.infiniteDistance) {
        // The sphere's CENTRE, deliberately — not the near point
        // `updateOutlineScales` thins width by. A bloom is a soft blob with no
        // edge to speak of, so its middle is where it reads from; the near
        // point of a block-merged mesh (the chapel's six windows are one, 8.5 m
        // of radius) sits a whole radius early and fogged them by 16% where the
        // wall behind was at 35%. Every glowing mesh here is a fitting or a
        // window, so a centre is never far from the light it stands for.
        const sphere = mesh.getBoundingInfo().boundingSphere;
        const d = Vector3.Distance(
          sphere.centerWorld,
          this.cameraSys.camera.globalPosition,
        );
        k *= 1 - fogAmountAt(d);
      }
      result.set(emissive.r * k, emissive.g * k, emissive.b * k, material.alpha);
    };
    this.glow = glow;
    // Moon shafts read the finished frame and add light back into it, so they
    // come after FXAA and before the grade — the vignette and grain have to
    // land on top of the beams, not under them.
    this.godRays = new GodRays(this.scene);
    // Attached here rather than by the pass itself, so the slot it lands in is
    // known: `syncGodRays` takes it off and puts it back in the same hole all
    // round, and Babylon has no way to ask where a pass used to be.
    this.godRaysSlot = this.cameraSys.camera.attachPostProcess(
      this.godRays.pass,
    );
    // Then the look smears, with the shafts already in the frame — they belong
    // to the same instant as the geometry, so they have to blur with it.
    this.motionBlur = new MotionBlur(this.scene, this.cameraSys.camera);
    // Vignette/grain/aberration go last, over the finished frame. Grain in
    // particular has to land AFTER the blur: smeared grain reads as smudge.
    this.post = new HorrorPost(this.scene, this.cameraSys.camera);
    this.sfx = new Sfx();
    this.hud = new HUD();
    // After the HUD: its root is the element every screen appends to.
    this.overlayScreen = new OverlayScreen();
    this.deployScreen = new DeployScreen();
    this.loadoutScreen = new LoadoutScreen();
    this.settingsScreen = new SettingsScreen(this.settings);
    this.lobbyScreen = new LobbyScreen();
    this.minimap = new Minimap();
    this.lighting = new LightingSystem();
    this.atmosphere = new Atmosphere(this.scene);
    // `mats` is not for building materials here — both systems own their own
    // shader. It is the publisher of the shadow map, its matrix and its params,
    // which both now sample (see `SHADOW_GLSL`).
    this.water = new WaterSystem(this.scene, glow, this.mats);
    this.grass = new GrassSystem(this.scene, glow, this.mats);
    this.mapBuilder = new MapBuilder(this.scene, this.mats, this.lighting);
    this.combat = new CombatSystem(this.scene, this.mats);
    this.grenades = new GrenadeSystem(this.scene, this.mats);
    this.ragdolls = new RagdollSystem(this.scene);
    // Fire and forget: the WASM lands whenever it lands, and until it does
    // every death takes the collapse tween. Not awaited anywhere — a physics
    // engine must never stand between the player and the first frame.
    this.ragdolls.init();
    this.deathCam = new DeathCam(this.scene, this.mats);
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

    // Everything above is CONSTRUCTION, and stays here because the fields it
    // assigns are what `strictPropertyInitialization` checks. Everything below
    // is wiring, and lives in a named method so a change has an obvious
    // destination — see `wireSystems` for the rule they all serve.
    this.wireSystems();
    this.installDomListeners(canvas);
    this.wireScreens();
    // Apply the remembered kit before anything is drawn: the viewmodel is
    // built with the defaults and the camera's zoom follows from the fit, so
    // deploying straight off a reload must not start on the wrong weapon.
    this.applyLoadout();
    // …and the remembered display settings, for the same reason: the blur is
    // attached by its own constructor, so a stored "off" has to be applied
    // before the first frame rather than on the first visit to the screen.
    this.applySettings();
    this.showMenu();
    // Debug/test handle (used by automated smoke tests).
    (window as unknown as { __celshock: Game }).__celshock = this;
    this.joinFromUrl();
    this.engine.runRenderLoop(() => this.tick());
  }

  /**
   * Installs every cross-system callback. **This is the wiring rule's one
   * home**: systems never import each other, so anything one has to tell
   * another is a callback assigned here or in one of the four methods below.
   *
   * Split by SUBJECT rather than by system, because that is how a change
   * arrives — a grenade behaviour is `wireGrenades`, a death is
   * `wireDeaths`. Order is irrelevant: these are property assignments on
   * objects the constructor has already built, and none reads another.
   */
  private wireSystems(): void {
    // Systems never import each other; every cross-system behaviour is a
    // callback installed here.
    this.player.onDamaged = (amount, died, from) =>
      this.onPlayerDamaged(amount, died, from);
    this.battle.setPlayer(this.player);
    // A bot's round killed somebody. The two halves are taken separately
    // because they are known in different places: the shooter is credited
    // whoever it hit — including the player, which is the one kill on the board
    // a bot used to be denied — while the ticket, the killfeed line and the
    // corpse are owed only when a BOT fell. The player's own death goes through
    // `onPlayerDamaged`, which `takeDamage` reached before this callback ran.
    this.battle.onBotKill = (victim, by) => {
      this.creditKill(by);
      if (victim instanceof Bot) this.registerBotKill(victim, by.team, false);
    };
    this.wireDeaths();
    this.wireGrenades();
    this.wireBattle();
    this.wireConquest();
  }

  /**
   * Corpses: where a fallen body's shadow goes, and how the death cam borrows
   * the same ragdoll pool every bot goes through.
   */
  private wireDeaths(): void {
    // A corpse under physics is metres from where its feet were when it died,
    // and `Bot.position` stops updating at that moment — so the body itself
    // has to say where its shadow goes. Only the ragdoll system knows; every
    // other dead bot answers 0 and keeps the old no-shadow behaviour.
    // The player answers through the death cam's stand-in body rather than
    // through itself, for the same reason and with the same result: `Player`
    // has no rig to have fallen anywhere, and the corpse does.
    this.shadows.corpseShadow = (cbt, out) => {
      const subject =
        cbt instanceof Bot
          ? cbt
          : cbt === this.player
            ? this.deathCam.subject
            : null;
      const strength = subject ? this.ragdolls.shadowFor(subject, out) : 0;
      if (strength > 0) out.y = this.standableAt(out.x, out.z, out.y);
      return strength;
    };
    // The death cam offers and retires its body through the same pool every
    // bot goes through — a callback rather than an import, because a system
    // may not reach into another one. Its default is the refusal, so the
    // collapse tween is what an unwired cam falls back to.
    //
    // The `true` is the priority offer, and this is the only place it may be
    // passed: the cam is four seconds of one body, and a pool held by four
    // bot corpses less than `sinkStart` old — which is what a firefight the
    // player lost looks like — would otherwise spend that shot on a corpse
    // standing to attention. See `RagdollSystem.takeSlot`.
    this.deathCam.onSpawnRagdoll = (corpse) =>
      this.ragdolls.spawn(corpse, this.cameraSys.camera.position, true);
    this.deathCam.onRetireRagdoll = (corpse) => this.ragdolls.retire(corpse);
  }

  /**
   * The one non-hitscan weapon: who a blast may hurt, and what a hit reports.
   */
  private wireGrenades(): void {
    // Grenades resolve their blast against the thrower's own target list, the
    // same way a bullet does — so friendly fire is excluded by construction
    // here too, and this system never learns what a team is.
    this.grenades.hittablesFor = (team) => this.battle.hittablesAgainst(team);
    // Netplay: the blast belongs to the authority and arrives as an `explode`
    // event, which reaches the thrower like everybody else. The local copy is
    // the ARC — the thing the thrower watched leave their hand — and firing
    // this as well would flash, bang and shake twice, a fraction of a second
    // apart, at two points that agree only to within the round trip.
    this.grenades.onExploded = (at) => {
      if (!this.net) this.onExplosion(at);
    };
    this.grenades.onBlastHit = (victim, thrower, by, killed) => {
      // "Was that ours" is a comparison against our own `Player`, which is why
      // the grenade carries the thrower rather than a flag saying so — that
      // system has no way to know what a player is.
      const byPlayer = by === this.player;
      // The killer's row, whoever fell, and before the victim filter below:
      // a blast that finishes the player is still a kill somebody threw.
      if (killed) this.creditKill(by);
      // The player's own death is already handled, all the way down to the
      // deploy screen, by `onPlayerDamaged` — `takeDamage` routed it there
      // before this callback ran. Only bots are this handler's business.
      if (!(victim instanceof Bot)) return;
      if (byPlayer) this.hud.flashHitmarker(killed);
      if (killed) this.registerBotKill(victim, thrower, byPlayer);
    };
    // A bot asking for a grenade on a position. The arm has the last word — a
    // solve it cannot make returns false and the bot spends nothing.
    this.battle.throwGrenadeFor = (bot, from, at) =>
      this.grenades.throwAt(from, at, bot.team, bot);
  }

  /**
   * What the bots need from the rest of the game: their sounds, their spawns,
   * their squad orders, and what standing on a flag means to them.
   */
  private wireBattle(): void {
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
    // `at` is CombatSystem's scratch vector — `suppress` keeps only `from`
    // and `nearMiss` reads it inside the call, so nothing outlives it here.
    this.combat.onNearMiss = (near, from, at) => {
      this.battle.suppress(near, from);
      if (near === this.player) {
        this.sfx.nearMiss(at);
        this.player.suppress();
      }
    };
    // A round arriving. Routed here rather than called directly for the same
    // reason the near miss is: `CombatSystem` fires the player's rounds and
    // all sixteen bots' and has no business knowing what `Sfx` is. Every gate
    // on this — distance, rate, the voice reserve — is on the far side, with
    // the budget it protects.
    this.combat.onImpact = (at, kind) => this.sfx.impact(at, kind);
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
  }

  /**
   * Flags changing hands, and the two ways the player is told about it.
   */
  private wireConquest(): void {
    this.conquest.onCaptured = (point, by) => {
      if (by === this.player.team) this.sfx.capture();
      else this.sfx.flagLost();
      const who = CONFIG.teams[by].name.toUpperCase();
      this.hud.showMessage(`${point.def.name.toUpperCase()} CAPTURED BY ${who}`, 2.5);
    };
    this.conquest.onNeutralised = (point) => {
      this.hud.toast(`${point.def.name} — neutralised`);
    };
  }

  /**
   * The browser-facing listeners: the user gesture that unlocks audio and takes
   * the pointer, the pointer-lock transition that PAUSES the round (read the
   * block below before changing it — Escape belongs to the UA, so the
   * transition is the trigger rather than the key), resize/orientation, and the
   * dev-only F2.
   *
   * Never removed: `Game` lives as long as the page does.
   */
  private installDomListeners(canvas: HTMLCanvasElement): void {
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
      if (locked) this.lockTakenAt = performance.now();
      // A lock granted and revoked in the same beat is the browser refusing,
      // not the player leaving: the request a resume makes lands while the UA
      // still owes an Escape-exit, and it takes back what it just gave. Pausing
      // on that is how a dismissed pause menu reappeared a split second later,
      // with nothing but the browser between the two. The retry in
      // `updatePendingLock` is what carries the resume from here.
      const refused =
        performance.now() - this.lockTakenAt < CONFIG.input.lockGrace * 1000;
      // `dying` counts too. The death cam deliberately KEEPS the lock — there
      // is nothing to click, and dropping it on the way in would pause the
      // very shot it is about to show — so it has a lock to lose like any
      // other live frame, and an alt-tab out of one must hold the round.
      if (
        !locked &&
        this.hadPointerLock &&
        !refused &&
        (this.state === "playing" || this.state === "dying")
      ) {
        this.pause();
      }
      this.hadPointerLock = locked;
    });
    window.addEventListener("keydown", () => this.sfx.unlock(), { once: true });
    // Through `applyRenderScale` rather than straight to `engine.resize`,
    // because `devicePixelRatio` is not a constant: it changes when a window
    // crosses to a monitor with a different density and when the page is
    // zoomed, and the scaling level is computed from it. Setting the level
    // resizes as a side effect, so nothing is lost by going the long way.
    window.addEventListener("resize", () => this.applyRenderScale());
    // A phone turned on its side reports the rotation before it has finished
    // laying the page out, so the resize that rides along with it can carry
    // the old dimensions — leaving the canvas stretched across a viewport it
    // no longer matches. The second, late resize is the one that lands.
    window.addEventListener("orientationchange", () => {
      this.applyRenderScale();
      window.setTimeout(() => this.applyRenderScale(), 300);
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
  }

  /**
   * The interface talking back: every screen's callbacks into `Game`.
   *
   * These are the only route from a click to a state change, which is why the
   * Deploy handlers are guarded on the state rather than trusted — the markup
   * they are bound to is thrown away and rebuilt around them.
   */
  private wireScreens(): void {
    this.overlayScreen.onDifficulty = (tier) => this.setDifficulty(tier);
    this.overlayScreen.onMap = (index) => this.setMap(index);
    this.overlayScreen.onOpenLoadout = () => this.openLoadout();
    // The menu's and the round-over card's Deploy button. Guarded on the state
    // rather than trusted, because the overlay's markup outlives neither: the
    // handler is bound to a button that `hideOverlay` throws away, and a click
    // landing between that and the next repaint must not start a second round.
    this.overlayScreen.onStart = () => {
      if (this.state === "menu" || this.state === "roundover") this.startRound();
    };
    this.deployScreen.onOpenLoadout = () => this.openLoadout();
    this.loadoutScreen.onWeapon = (id) => this.setWeapon(id);
    this.loadoutScreen.onSight = (id) => this.setSight(id);
    this.loadoutScreen.onClose = () => this.closeLoadout();
    this.player.onCarryChanged = () => this.applyCarry();
    this.overlayScreen.onOpenSettings = () => this.openSettings();
    this.overlayScreen.onOpenMultiplayer = () => this.openLobby();
    this.settingsScreen.onChange = (key, value) => this.setSetting(key, value);
    this.settingsScreen.onClose = () => this.closeSettings();
    // The row's own map travels with its id: a match is played on the map it is
    // running, and the row the player picked is where that is already known.
    this.lobbyScreen.onJoin = (matchId, mapId) => this.joinMatch({ matchId, mapId });
    // A new match is the one join that DOES take this client's map — the map
    // row on that screen is the same pick as the menu's, and `joinMatch` sends
    // it for the server to spend on the match it builds.
    this.lobbyScreen.onCreate = () => this.joinMatch({ create: true });
    this.lobbyScreen.onPickMap = (index) => this.setMap(index);
    this.lobbyScreen.onRefresh = () => void this.refreshLobby();
    this.lobbyScreen.onClose = () => this.closeLobby();
    this.overlayScreen.onPauseAction = (action) => {
      // Restart needs nothing put back by hand: `startRound` lifts the lid,
      // hides the overlay and ends in `enterDeploy`, which sets the state.
      if (action === "resume") this.resume();
      else if (action === "settings") this.openSettings();
      else if (action === "restart") this.startRound();
      else this.enterMenu();
    };
    // Guarded for the same reason `onStart` is, and it is the weaker of the
    // two: `spawnPlayer` sets the state outright, so a click that arrives from
    // under a screen raised over the deploy map would drop the player into the
    // world with that screen still up. The kit and settings scrims both take
    // pointer events across their whole area today, so nothing currently gets
    // through — which is a property of two stylesheets rather than of this
    // wiring, and is not what the guard should rest on.
    this.deployScreen.onDeploy = (spawn) => {
      if (this.state !== "deploy") return;
      // In a netplay round this is a REQUEST and not a deployment. The
      // authority owns the body: it decides whether that spawn is still one
      // this team may use and when the reinforcement clock allows it, and the
      // `spawn` event it answers with is what actually puts the player in the
      // world — through the same `spawnPlayer` this line calls offline. Putting
      // them there here as well would be the client deciding an outcome, and
      // the outcome it would decide is the one thing on this screen the server
      // cannot afford to have a second opinion about: where somebody is.
      if (this.net) {
        this.net.sendDeploy(this.conquest.spawnIndex(spawn));
        this.deployScreen.setPending();
        return;
      }
      this.spawnPlayer(spawn);
    };
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
    this.overlayScreen.showMenu({
      maps: MAPS.map((m) => m.name),
      selectedMap: MAPS.indexOf(this.mapDef),
      difficulties: difficultyNames(),
      selected: this.difficulty,
      kit: kitLabel(this.weapon, this.sight),
      // Stated rather than written into the markup: the number of flags is the
      // chosen map's, and a tagline that says "five" on a map with four is the
      // kind of wrong nobody reports.
      flagCount: this.mapDef.layout.controlPoints.length,
    });
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

  /**
   * Raises the settings lid over the menu, the deploy screen or a pause.
   *
   * Unlike the kit screen there is nothing to pose and nothing to light: the
   * screen is DOM over whatever is already rendering, so opening it is the
   * state change and the `show`. The pause card underneath stays up on purpose
   * — the settings screen is opaque where it matters and the card returning is
   * then the same element, not a redraw.
   */
  private openSettings(): void {
    if (
      this.state !== "menu" &&
      this.state !== "deploy" &&
      this.state !== "paused"
    ) {
      return;
    }
    this.settingsFrom = this.state;
    this.state = "settings";
    this.settingsScreen.setValues(this.settings);
    this.settingsScreen.show();
  }

  private closeSettings(): void {
    if (this.state !== "settings") return;
    this.settingsScreen.hide();
    this.state = this.settingsFrom;
    // The menu paints its own markup and was covered while the settings were
    // changed, so it is redrawn on the way out — the same reason
    // `closeLoadout` does it. The pause card was never taken down.
    if (this.state === "menu") this.showMenu();
  }

  /**
   * Raises the lobby over the menu, and asks the server what it is running.
   *
   * The fetch is fired here rather than by the screen, which renders what it is
   * handed and nothing else — the same split `SettingsScreen` keeps. It is not
   * awaited: the screen goes up in its loading state on this frame, and the
   * answer lands on whatever frame it lands on.
   *
   * Menu-only, unlike the settings lid. A lobby raised over a live round would
   * be offering to join a second match while standing in one.
   */
  private openLobby(): void {
    if (this.state !== "menu") return;
    this.state = "lobby";
    // The map row starts on whatever the menu underneath is offering — there is
    // one map choice in this game and two places it is shown, so the screen is
    // handed the standing one rather than keeping a second copy that could
    // disagree with it.
    this.lobbyScreen.setMapChoice(MAPS.indexOf(this.mapDef));
    this.lobbyScreen.show();
    void this.refreshLobby();
  }

  private closeLobby(): void {
    if (this.state !== "lobby") return;
    this.lobbyScreen.hide();
    this.state = "menu";
    // Redrawn on the way out, for the reason `closeSettings` states: the menu
    // owns its markup and has been covered.
    this.showMenu();
  }

  /**
   * Fetches the match list and hands it to the screen.
   *
   * Guarded on the screen still being open, because the fetch has a timeout of
   * several seconds and a player who pressed Back is entitled to have meant it
   * — a late answer must not repaint a screen that is down, or worse, put one
   * back up over the menu.
   */
  private async refreshLobby(): Promise<void> {
    const result = await fetchMatches(this.netUrl);
    if (this.state !== "lobby") return;
    this.lobbyScreen.setList(result);
  }

  /**
   * One pick from the settings screen: stored, persisted, applied, and pushed
   * back to the screen. The screen never writes its own state — it renders
   * what it is given — so this is the only path a toggle can take, and a
   * setting cannot show as applied when it is not.
   */
  private setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.settings[key] === value) return;
    this.settings = { ...this.settings, [key]: value };
    writeSettings(this.settings);
    this.applySettings();
    this.settingsScreen.setValues(this.settings);
  }

  /** Pushes every setting at whatever owns it. Called on load and on change. */
  private applySettings(): void {
    this.hud.setFpsVisible(this.settings.fpsCounter);
    this.applyRenderScale();
    this.setMotionBlurEnabled(this.settings.motionBlur);
    // After the blur, and that is the order rather than a preference: the
    // blur's own toggle takes the grade off and puts it back to keep the
    // chain's tail, so the grade has the last word on whether it is attached.
    this.post.setEnabled(this.settings.horrorGrade);
    // Turning it off drops any body still falling, which is the honest
    // response to "stop doing this" — the tween takes over from the next death.
    this.ragdolls.setEnabled(this.settings.ragdolls);
    // The look speeds go to the camera and stop there: the aim assist reads its
    // own bound off `stickYawRate`, which already carries the stick's.
    this.cameraSys.setLookScale(
      this.settings.mouseSensitivity,
      this.settings.stickSensitivity,
    );
  }

  /**
   * Sizes the backing store from the player's render scale and the display.
   *
   * Babylon's scaling level is the RECIPROCAL of the resolution — level 1 means
   * one backing pixel per CSS pixel, which is what the engine has always run at
   * because `adaptToDeviceRatio` was never passed. On a 2x panel that is a
   * quarter of the display's pixels, upscaled by the compositor. The setting is
   * expressed against the DISPLAY instead (see `CONFIG.graphics.renderScales`),
   * so `renderScale` 1.0 is the panel's own resolution on every machine and the
   * default derives back to the old behaviour.
   *
   * Read fresh every call rather than cached: this is also the resize handler,
   * and the density is exactly what a resize can have changed.
   */
  private applyRenderScale(): void {
    const dpr = window.devicePixelRatio || 1;
    this.engine.setHardwareScalingLevel(1 / (dpr * this.settings.renderScale));
    // The crosshair's spread projection needs the viewport height in CSS
    // pixels, and this is the one place that can have changed. Read here rather
    // than in `updateHud` because that read sits BETWEEN two batches of HUD
    // writes, and a geometry read with style mutations pending is what forces
    // an early layout — the one shape of layout thrashing the frame path had.
    this.viewportHeight = window.innerHeight;
  }

  /**
   * Adds or removes the motion blur pass, keeping the chain's order.
   *
   * The order is load-bearing and documented on both passes: GodRays, then the
   * blur, then the grade — the shafts belong to the frame they smear with, and
   * grain over a smear reads as a dirty lens. Babylon's `attachPostProcess`
   * APPENDS, so simply re-attaching the blur would put it behind the grade.
   * Taking the grade off and putting it back after is what restores the order
   * without computing an index into a chain that also holds the pipeline's own
   * FXAA — and it is Game's job because Game is what assembled the chain.
   *
   * Nothing throws if this is wrong. The symptom is smeared grain.
   */
  /**
   * Adds or removes the moon-shaft pass as the moon comes into frame and goes
   * out of it, for a reason the shafts state on themselves: a detached pass
   * costs nothing, while an attached one reads and writes the whole frame
   * however early its shader gives up. `GodRays.update` has already decided;
   * this is only the attachment.
   *
   * It goes back into the SLOT IT CAME OUT OF, and that is the whole reason
   * Game does the first attach. `detachPostProcess` nulls the entry rather
   * than removing it, and `attachPostProcess` with no index APPENDS — so the
   * detach-the-tail-and-put-it-back dance `setMotionBlurEnabled` does would
   * leave one more hole in the camera's list on every cycle here, in an array
   * that is walked every frame. Re-attaching into the hole leaves the list the
   * same length and the order exact, and never touches the other passes.
   *
   * This toggles as the moon crosses the edge of the fade, which is why it
   * has to be the cheap version rather than the rare one.
   */
  private syncGodRays(): void {
    const on = this.godRays.isLive;
    if (on === this.godRaysAttached) return;
    const camera = this.cameraSys.camera;
    if (on) {
      this.godRaysSlot = camera.attachPostProcess(
        this.godRays.pass,
        this.godRaysSlot,
      );
    } else {
      camera.detachPostProcess(this.godRays.pass);
    }
    this.godRaysAttached = on;
  }

  private setMotionBlurEnabled(on: boolean): void {
    if (on === this.motionBlur.isEnabled) return;
    const camera = this.cameraSys.camera;
    const pass = this.motionBlur.pass;
    if (on) {
      this.post.detach();
      camera.attachPostProcess(pass);
      this.post.attach();
    } else {
      camera.detachPostProcess(pass);
    }
    this.motionBlur.setEnabled(on);
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
   * The kit screen is the one overlay showing live 3D, so it owes by hand what
   * only `updateGameplay` normally does. That used to include the shader's eye
   * — a kit opened straight off the main menu would otherwise put the weapon a
   * whole map's width from where the shader thought the viewer was, and fog it
   * out to a flat grey silhouette — but `tick` now pushes that for every state,
   * and a screen showing live 3D is exactly why it has to. What is left is the
   * drag, which is read consume-on-read from the screen and mixed with the
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
    const eye = camera.position;
    // Into scratches: this is a per-frame path, so the plain getters would
    // mint two vectors a frame for as long as the screen is up.
    const forward = this.cameraSys.forwardToRef(this.kitForward);
    const right = this.cameraSys.flatRightToRef(this.kitRight);
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
  private setWeapon(id: PrimaryWeaponId): void {
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
    this.applyCarry();
    const label = kitLabel(this.weapon, this.sight);
    this.deployScreen.setKit(label);
    this.loadoutScreen.setFit(this.weapon, this.sight);
    // The menu draws the kit into its own markup, so it has to be rebuilt;
    // the other two were just patched above.
    if (this.state === "menu") this.showMenu();
  }

  /**
   * Pushes what is actually IN THE PLAYER'S HANDS, which the kit alone cannot
   * say: the sidearm is swapped to mid-round, and both of the things below
   * follow the weapon rather than the loadout.
   *
   * The camera is the load-bearing one. How far it zooms and how much it slows
   * are the fitted optic's, how fast it gets there and how much the aim wanders
   * are the weapon's, and the sidearm looks through its own sights whatever the
   * kit chose — so a swap that left the camera on the last weapon's fit would
   * aim a pistol down a scope's FOV. `player.carriedSight` is the one answer
   * both this and the aimed pose are derived from.
   *
   * Wired to `player.onCarryChanged`, so the three things that change the hands
   * — a kit pick, a swap completing, and a fresh body coming up with the
   * primary — all reach it without any of them having to remember to.
   */
  private applyCarry(): void {
    const weapon = this.player.carriedWeapon;
    const sight = this.player.carriedSight;
    this.cameraSys.setLoadout(weapon, sight);
    this.hud.setKit(kitLabel(weapon, sight));
    // …and what is NOT in them, which is the same push for the same reason:
    // the stowed row names the other slot, so it turns over exactly when this
    // one does. The short name rather than the full one — it is a caption on a
    // row that has to stay quieter than the readout above it.
    this.hud.setStowedKit(
      CONFIG.weapons[this.player.slungWeapon].short,
      this.player.slungSlot + 1,
    );
    // Its magazine as well, even though `updateHud` pushes that every frame:
    // this is the only path that runs before the first round and on the way
    // out of one, and a row reading "PISTOL /" on the deploy screen is worse
    // than the count it would otherwise be waiting a frame for.
    this.hud.setStowedAmmo(this.player.slungAmmo, this.player.slungMagSize);
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

  /**
   * The player PICKING the map: the menu's Map row, and the lobby's — which is
   * the map a match this client creates will be started on.
   *
   * **Only from the menu or the lobby over it, and that guard is the whole
   * safety argument.** `startRound` reads `mapDef` to apply the environment,
   * paint the sky and build the map, and hands the result to battle, conquest,
   * the flag markers and the minimap. Writing this field at any other time
   * leaves all four pointing into a `GameMap` that `installMap` has already
   * disposed — which throws nothing and renders last round's world over this
   * one's. The lobby is safe for the same reason the menu is: it is a lid over
   * it, no round is standing, and the next thing to read the field is a build.
   *
   * This is the PREFERENCE and is remembered as one. A map that arrives from a
   * match server is not a pick and goes through `applyMatchMap`, which
   * deliberately does not persist it — what you chose here is what the menu
   * offers you again after the match, not the map somebody else's round
   * happened to be on.
   *
   * The value assigned is an entry OUT OF `MAPS`; see `readMap`.
   */
  private setMap(index: number): void {
    if (this.state !== "menu" && this.state !== "lobby") return;
    const n = MAPS.length;
    const next = index < 0 ? 0 : index >= n ? n - 1 : index;
    if (MAPS[next] === this.mapDef) return;
    this.mapDef = MAPS[next];
    writeMap(this.mapDef.id);
    // Whichever of the two is on screen. The menu is redrawn whole because it
    // owns its markup; the lobby is handed the new choice and repaints its own
    // row — and the menu underneath it is redrawn by `closeLobby` anyway.
    if (this.state === "lobby") this.lobbyScreen.setMapChoice(next);
    else this.showMenu();
  }

  /**
   * The map the AUTHORITY says a match is on, applied to the standing choice.
   *
   * **A client never picks the map of a match it joins.** Both sides build the
   * world locally from the same layout module and nothing about it crosses the
   * wire, so a client that builds a different one is not playing the same game:
   * its walls, its flags and its spawns are somewhere else, and every position
   * that arrives is nonsense in the world it is drawn into. The map is stated in
   * the welcome and again on every rotation, and this is the one place that
   * answer is spent.
   *
   * Three answers, because the callers do two different things with it:
   *
   * - `same` — the standing map is already the match's, which is the ordinary
   *   case once the lobby has handed the row's map down to `joinMatch`.
   * - `changed` — applied here, and the caller owes a BUILD. Nothing else may
   *   write `mapDef` from a state that is not `menu`/`lobby`, and this is
   *   allowed to only because every caller rebuilds within the same frame.
   * - `unknown` — an id this build does not have (a server one version ahead).
   *   Nothing is written, and the caller's answer is `leaveUnknownMap`: there is
   *   no world to build, so there is no round to play.
   *
   * It does NOT persist the choice — see `setMap` for why.
   */
  private applyMatchMap(mapId: string): "same" | "changed" | "unknown" {
    const def = MAPS.find((m) => m.id === mapId);
    if (!def) return "unknown";
    if (def === this.mapDef) return "same";
    this.mapDef = def;
    return "changed";
  }

  /**
   * The authority is running a map this build does not have.
   *
   * The same three moves `NetSession.onRejected` makes and for the same reason:
   * the round is torn down, the player is put back where they chose from, and
   * the toast says what happened. A refusal that left them in a match would be
   * worse than useless — they would be standing in a world nobody else is in.
   */
  private leaveUnknownMap(mapId: string): void {
    this.enterMenu();
    this.hud.toast(`this server is running "${mapId}", which this build does not have`);
    this.openLobby();
  }

  private tick(): void {
    const real = this.engine.getDeltaTime() / 1000;
    const dt = Math.min(real, 0.05);
    this.input.update();
    // Every state, including the ones that simulate nothing: the readout is an
    // instrument, and a frame rate that stops being reported the moment you
    // open a menu is a frame rate you cannot investigate. It takes the real
    // delta rather than the clamped one — see `HUD.setFps`.
    this.hud.setFps(this.engine.getFps(), real);

    switch (this.state) {
      case "menu":
      case "roundover":
        this.updateMenuCard(dt);
        break;
      // `loading` deliberately has no arm and must not grow one. There is no
      // map to simulate against and no input worth taking — the whole reason
      // it is a state is that the frame between the confirm and the build
      // belongs to nobody, and anything given to it here is something that
      // could run twice or run against a map that is half torn down. The
      // frame still renders (below), which is what draws the card.
      case "loading":
        break;
      case "deploy":
        this.updateDeployScreen(dt);
        break;
      case "loadout":
        this.updateLoadoutScreen(dt);
        break;
      case "settings":
        this.updateSettingsScreen(dt);
        break;
      case "lobby":
        this.updateLobbyScreen();
        break;
      case "paused":
        this.updatePauseMenu();
        // A pause is a lid over the local game, and in a networked round the
        // local game is not the round: the authority never heard the key. So
        // the half of a frame that DRAWS what it was told is owed here exactly
        // as it is owed to the deploy screen, and for the same reason — both
        // are a round running without you, which offline is a thing that
        // cannot happen and here is the normal case. Left out, sixteen bodies
        // stand frozen behind the card and snap to where they really are on
        // the frame the player resumes.
        //
        // Still nothing that decides an outcome, which is what makes it legal
        // from a state that owns none. The lid stays on the half of the frame
        // that is genuinely this client's: the player does not move, does not
        // shoot, and reports nothing while the menu is up — `updateNet` sends
        // no move sample because it asks for `state === "playing"`, so being
        // paused is already indistinguishable on the wire from standing still.
        this.updateNetUnderLid(dt);
        break;
      case "playing":
        if (this.input.pausePressed) {
          this.pause();
          break;
        }
        // After the pause check, so a frame that ends the round's hold never
        // also chases a lock for it. Both live states owe it, for the same
        // reason the resume gives the lock back to both.
        this.updatePendingLock(dt);
        this.updateGameplay(dt);
        break;
      case "dying":
        // Pausable like any other live frame — a death cam is four seconds
        // during which the round is still going, so it must not be four
        // seconds during which Escape does nothing.
        if (this.input.pausePressed) {
          this.pause();
          break;
        }
        this.updatePendingLock(dt);
        this.updateDeathCam(dt);
        break;
      case "editor":
        this.updateEditor(dt);
        break;
    }

    // A pause stops the HUD's clock too: the killfeed, the toasts and the
    // damage vignette are all part of the frozen frame, and a fight fading off
    // the screen while nothing in the world moves is the tell that the pause
    // is only skin deep. Every other state passes the real dt.
    //
    // A NETWORKED pause is not a frozen frame and the test inverts with it:
    // the fight behind the card is live, kills keep arriving from the wire,
    // and a killfeed held at zero would stack them unread and then fade the
    // lot at once on the resume — the same tell, from the other side. So the
    // question is not which screen is up but whether what is under it moves,
    // which is what `worldHeld` answers.
    this.hud.update(this.worldHeld ? 0 : dt);
    this.post.update(dt);
    this.sky.update(dt);
    // After every state has had its go at the camera, and before the render
    // that the shafts are drawn into.
    this.godRays.update(
      this.scene,
      this.cameraSys.camera,
      this.sky.moonDirection,
    );
    // …and then off the camera entirely when it has nothing to add. Straight
    // after the update that decided it, and before the render it applies to.
    this.syncGodRays();
    // Every frame in every state, so the basis it reprojects against can never
    // go stale while the player sits in a menu. In the editor the free-fly cam
    // drives the Babylon camera directly and never touches these angles, so
    // the pass sees no rotation and stays inert — which is what we want in an
    // authoring tool.
    this.motionBlur.update(this.cameraSys.aimYaw, this.cameraSys.aimPitch);
    // The eye the cel shader fogs and rims against, last of all and in EVERY
    // state, because every state renders and only some of them simulate. It
    // used to be pushed from `updateSceneForCamera` and by hand from the kit
    // screen, which covered the four states that run a camera and left the
    // scene behind the menu, the building card and the deploy screen fogged
    // against wherever the last live frame stood — the origin, before there
    // has been one. That was 8.5 m of error on a fresh boot's first deploy
    // screen and exactly none anywhere else, and the reason it was only ever
    // 8.5 m is that nothing currently MOVES the camera in a state that does
    // not simulate. A deploy screen that flew to an overlook, or a menu that
    // panned, would have broken it silently and looked like a shader bug. Here
    // it cannot: `updateCamera` guards on the position, so a still camera in
    // any state costs one comparison and no walk.
    this.mats.updateCamera(this.cameraSys.camera.position);
    // In every state too, and AFTER the switch above rather than inside any of
    // its arms: what decides whether the board is up is the state this frame
    // ENDS in, so a frame that deployed the player, killed them or ended the
    // round has already changed it by the time this reads it. That is what
    // makes "the board goes away when the round does" a property of one line
    // rather than a call every one of those boundaries has to remember.
    this.pushScoreboard();
    this.scene.render();
  }

  /**
   * The title card and the round-over card, which share one overlay element.
   *
   * The menu is a LIST — the cursor keys move and step it, and the dedicated
   * keys are accelerators rather than the only way to reach a row. The
   * round-over card has no cursor, so it only takes the confirm.
   */
  private updateMenuCard(dt: number): void {
    this.overlayT += dt;
    // Menu only: `roundover` shares the overlay element but shows the
    // victory text, and redrawing the picker over it would wipe the result.
    if (this.state === "menu") {
      // The menu is a LIST: up/down move the cursor, left/right step
      // whatever it is resting on, and A fires it. The dedicated keys below
      // are accelerators now rather than the only way to reach a row —
      // which is what they were, and is why a pad could not open the
      // settings screen from here at all.
      if (this.input.menuUpPressed) this.overlayScreen.moveMenuSelection(-1);
      if (this.input.menuDownPressed) this.overlayScreen.moveMenuSelection(1);
      if (this.input.menuLeftPressed) this.overlayScreen.stepMenuItem(-1);
      if (this.input.menuRightPressed) this.overlayScreen.stepMenuItem(1);
      // Enter and pad A fire the cursor's row, and BREAK — they raise
      // `confirmPressed` on the same frame, and the fall-through below
      // would otherwise start the round out from under whichever screen
      // the row just opened. The same shape the paused branch uses to keep
      // Start from confirming behind its own resume.
      if (this.input.menuConfirmPressed && this.overlayT > 0.5) {
        this.overlayScreen.activateMenu();
        return;
      }
      if (this.input.loadoutPressed) {
        this.openLoadout();
        return;
      }
      if (this.input.settingsPressed) {
        this.openSettings();
        return;
      }
      if (this.input.multiplayerPressed) {
        this.openLobby();
        return;
      }
    }
    // What is left of the confirm is Enter, pad A and Start — no pointer
    // at all. On the menu card the first two have already been spent on the
    // cursor's row and broken out above, so this is Start, "start the game"
    // wherever the cursor happens to be resting; on the round-over card,
    // which has no cursor to fire, it is all three. The mouse and a tap
    // deploy through the Deploy button and nowhere else, or a click on the
    // map or difficulty row would start the round out from under the pick.
    if (this.input.confirmPressed && this.overlayT > 0.5) {
      this.startRound();
    }
  }

  /**
   * Waiting out a respawn: step the reinforcement clock, drive the spawn
   * picker, and take the confirm that deploys.
   */
  private updateDeployScreen(dt: number): void {
    if (this.input.pausePressed) {
      this.pause();
      return;
    }
    // The same key, and the reason the deploy screen offers it at all:
    // the wait for reinforcements is the one moment inside a round when
    // the weapon is already put away.
    if (this.input.loadoutPressed) {
      this.openLoadout();
      return;
    }
    if (this.input.settingsPressed) {
      this.openSettings();
      return;
    }
    this.respawnT -= dt;
    // The round carries on without us, and this is the screen that reads it.
    // The map below is drawn from `conquest.points`, which the wire keeps
    // current — but the bodies behind the card, the tickets on the strip and
    // the effects this client owns are all stepped from a frame, and this
    // state's frame is the only one they get while a player is choosing.
    this.updateNetUnderCard(dt);
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
  }

  /**
   * The kit screen. Two axes for two slots, and every way out closes it —
   * there is nothing to confirm, each pick is already on the weapon behind.
   */
  private updateLoadoutScreen(dt: number): void {
    // The third lid, and the one that hides the most: the scrim is opaque
    // except for the stage the weapon turns on. That makes no difference to
    // what is owed — the round is still being played by fifteen other people
    // and the reinforcement clock is still running down — and it is precisely
    // the screen where the freeze was hardest to see and the snap on the way
    // out hardest to explain. Offline this does nothing.
    this.updateNetUnderLid(dt);
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
      return;
    }
    if (this.input.menuUpPressed) this.loadoutScreen.moveSlot(-1);
    if (this.input.menuDownPressed) this.loadoutScreen.moveSlot(1);
    if (this.input.menuLeftPressed) this.loadoutScreen.cycle(-1);
    if (this.input.menuRightPressed) this.loadoutScreen.cycle(1);
    this.updateKitStage(dt);
  }

  /**
   * The settings list. The one screen where the confirm is NOT an exit: a
   * boolean has nothing to step through, so A and Enter flip the row.
   */
  private updateSettingsScreen(dt: number): void {
    // The one lid that can be raised over another, and the only one that can
    // cover a round from two states away — but the round underneath does not
    // care which screen is on top of it, only whether the authority is still
    // running it. So this owes exactly what the pause card owes, and the two
    // ask the same method rather than each deciding for themselves. Offline it
    // does nothing at all: there is no round running without you.
    this.updateNetUnderLid(dt);
    // Up/down picks the row, left/right and Enter flip it. The confirm is
    // NOT an exit here, which is the one place this screen departs from the
    // kit screen's shape: a boolean has nothing to step through, so A and
    // Enter are the natural "toggle this" and spending them on closing
    // would leave a pad with no way to change a setting at all. B, Escape
    // and `O` are the ways out, and every pick is already applied.
    if (
      this.input.menuBackPressed ||
      this.input.pausePressed ||
      this.input.settingsPressed
    ) {
      // B is the pad's crouch toggle as well; the press that closed this
      // screen has already flipped the latch behind it. Same correction the
      // pause branch and `spawnPlayer` make, and for the same reason.
      if (this.input.menuBackPressed) this.input.clearCrouchToggle();
      this.closeSettings();
      return;
    }
    if (this.input.menuUpPressed) this.settingsScreen.moveRow(-1);
    if (this.input.menuDownPressed) this.settingsScreen.moveRow(1);
    // Left/right step and CLAMP; confirm steps forward and WRAPS. With a
    // boolean these were the same move, and with a ladder on the screen they
    // stop being — see `SettingsScreen.stepRow`.
    if (this.input.menuLeftPressed) this.settingsScreen.stepRow(-1, false);
    if (this.input.menuRightPressed) this.settingsScreen.stepRow(1, false);
    if (this.input.menuConfirmPressed) this.settingsScreen.stepRow(1, true);
  }

  /**
   * The lobby. A list like the settings screen, and with one row that steps:
   * the map a new match would be started on. Left/right is spent there and
   * NOWHERE else — a horizontal nudge on a match row has nothing to change,
   * because that match's map is the authority's, and a nudge that did something
   * anyway would make the cursor's own edges feel like traps (the reasoning
   * `stepMenuItem` states next door).
   */
  private updateLobbyScreen(): void {
    // B, Escape and `M` all leave, matching the settings screen's three ways
    // out. Enter is spent on joining, which is what the screen is for.
    if (
      this.input.menuBackPressed ||
      this.input.pausePressed ||
      this.input.multiplayerPressed
    ) {
      // B is the pad's crouch toggle as well; the press that closed this screen
      // has already flipped the latch behind it. The same correction the pause
      // and settings branches make.
      if (this.input.menuBackPressed) this.input.clearCrouchToggle();
      this.closeLobby();
      return;
    }
    if (this.input.menuUpPressed) this.lobbyScreen.moveRow(-1);
    if (this.input.menuDownPressed) this.lobbyScreen.moveRow(1);
    // Left/right CLAMP and the confirm WRAPS, the same pair the menu's own map
    // row keeps: a slider you have to watch is worse than one you can feel, and
    // a confirm that answers nothing is worse than one that always moves.
    if (this.input.menuLeftPressed) this.lobbyScreen.stepRow(-1);
    if (this.input.menuRightPressed) this.lobbyScreen.stepRow(1);
    if (this.input.menuConfirmPressed) this.lobbyScreen.activate();
  }

  /**
   * The pause list. Nothing simulates while it is up; this only moves the
   * cursor and takes the choice.
   */
  private updatePauseMenu(): void {
    // Pause is checked first and breaks: Start raises `pausePressed` and
    // `confirmPressed` on the same frame, and resuming must not also fire
    // whichever item the selection happens to be on.
    // B backs out of a pause the same way it backs out of the kit screen:
    // the lid comes off and the state under it comes back, which is what
    // "Resume" does anyway.
    if (this.input.pausePressed || this.input.menuBackPressed) {
      // B is also the pad's crouch toggle, so the press that lifted the lid
      // has already flipped the latch. Only a B resume owes the correction
      // — clearing it on every resume would stand up a player who paused
      // deliberately crouched behind cover.
      if (this.input.menuBackPressed) this.input.clearCrouchToggle();
      this.resume();
      return;
    }
    // The one lid that can be raised over another. Checked after the
    // resume, so a frame carrying both keys ends the pause rather than
    // opening a screen over a round that is about to un-hold.
    if (this.input.settingsPressed) {
      this.openSettings();
      return;
    }
    if (this.input.menuUpPressed) this.overlayScreen.movePauseSelection(-1);
    if (this.input.menuDownPressed) this.overlayScreen.movePauseSelection(1);
    // Keyboard/pad confirm only — the buttons handle their own clicks, and
    // a click on the empty half of the screen is not a menu choice.
    if (this.input.menuConfirmPressed) this.overlayScreen.activatePause();
  }

  /**
   * Takes the pointer lock back, tolerating the browser saying no.
   *
   * Chrome refuses a fresh lock for about a second after the user pressed
   * Escape to leave one — which is precisely the sequence a pause menu ends
   * with — and reports it by rejecting the promise. That is not an error worth
   * surfacing: `updatePendingLock` asks again a moment later, and if the
   * browser holds out, the lock hint is already on screen and the player's next
   * click takes the lock through the `pointerdown` handler above. Older
   * browsers return nothing at all from this call, hence the shape of the
   * check.
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
    if (
      this.state !== "playing" &&
      this.state !== "dying" &&
      this.state !== "deploy"
    ) {
      return;
    }
    this.pausedFrom = this.state;
    this.state = "paused";
    // A pause outranks a resume that never got its lock: a second pause taken
    // while one was still being chased must not have the round grab the mouse
    // out from under the menu it just raised.
    this.lockPending = false;
    this.hud.setPaused(true);
    this.overlayScreen.showPause();
    // Suspends the audio clock, so the tail of the last shot is still there
    // when the round starts again instead of ringing out over the menu.
    //
    // OFFLINE ONLY, and not merely because a live fight should be audible.
    // Suspending stops `AudioContext.currentTime`, and a networked round goes
    // on making noise the moment it is stopped: `hit`, `damage` and `explode`
    // all sound straight off the wire, from the message handler, in whatever
    // state the client happens to be in. Scheduled against a clock that is not
    // running, none of them plays and none of them ENDS — so each holds a
    // voice against the cap until the resume, at which point the whole
    // pause-worth of them fires on the same instant. The choice is between a
    // menu with gunfire behind it and a menu that saves the gunfire up.
    if (!this.net) this.sfx.setSuspended(true);
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
    this.overlayScreen.hide();
    this.clearPause();
    this.state = this.pausedFrom;
    // `dying` too. The death cam is a live frame that holds the lock, so a
    // pause over it has to give back what it took — the alternative is a cam
    // that resumes unlocked and a player who is silently mouse-free for the
    // rest of it and into whatever comes next.
    if (this.state === "playing" || this.state === "dying") {
      // The click that chose "Resume" is still held, and it is about to become
      // the click that takes the pointer lock back — the same trap the deploy
      // map's click documents in `spawnPlayer`.
      this.input.consumeFire();
      // NOT a bare `requestLock()`: a resume driven by Escape is asking for the
      // lock with the browser's own release-the-lock key still down. See
      // `updatePendingLock`.
      this.lockPending = true;
      this.lockPendingT = 0;
      this.lockRetryT = 0;
    }
  }

  /**
   * Carries a resume's pointer lock until the browser agrees to it.
   *
   * A pause taken with Escape ends with Escape, and that one key is both the
   * resume and the UA's gesture for dropping a lock — so the request a resume
   * makes is the one request the browser is least willing to grant. Chrome
   * refuses outright for about a second after an Escape-exit, and a lock taken
   * while the key is still down is dropped again by its auto-repeat, which
   * `pointerlockchange` would read as a player leaving and pause on. Both look
   * to the player like the same thing: a menu that flickers off and back on,
   * and a round that eventually resumes with the mouse still loose.
   *
   * So the request waits for the key to come UP and is then retried on an
   * interval until the lock lands, or until the window runs out — at which
   * point the round is still running, the lock hint is on screen, and the next
   * click takes it through the `pointerdown` handler. Nothing here can pause:
   * a refusal is not a state change.
   */
  private updatePendingLock(dt: number): void {
    if (!this.lockPending) return;
    if (this.input.pointerLocked) {
      this.lockPending = false;
      return;
    }
    this.lockPendingT += dt;
    if (this.lockPendingT > CONFIG.input.lockRetryWindow) {
      this.lockPending = false;
      return;
    }
    if (this.input.pauseKeyHeld) return;
    this.lockRetryT -= dt;
    if (this.lockRetryT > 0) return;
    this.lockRetryT = CONFIG.input.lockRetryInterval;
    this.requestLock();
  }

  /**
   * Back to the main menu, from the pause screen. Mirrors `endRound` minus a
   * result: the round is abandoned rather than finished, so there is no winner
   * to show and nothing to keep.
   *
   * The map is deliberately left standing. `startRound` rebuilds it anyway,
   * and disposing it here would only trade a live backdrop for an empty one.
   * That is exactly why the death cam has to be told: the body is standing in
   * the backdrop this leaves up, so a round abandoned from a pause taken over
   * `dying` would put the main menu over the player's own frozen corpse, with
   * `.dying` still on the HUD and a ragdoll slot still held until the next
   * round's `enterDeploy` happened to clear both.
   */
  private enterMenu(): void {
    this.state = "menu";
    // A networked round ends HERE, and the socket is closed rather than left to
    // time out: a peer that merely goes quiet holds its roster slot until the
    // server notices, and the bot that should have taken the seat back stays
    // benched for as long as that takes.
    //
    // This was inert while `?mp` was the only way into a match — there was no
    // route from the menu back into one, so a stale session could never be hit.
    // The lobby is that route, and without this the second join is refused by
    // `joinMatch`'s own guard and looks like a dead button.
    this.leaveMatch();
    // The match's map went with it. A netplay round is played on whatever the
    // authority is running (`applyMatchMap`), which is not a choice this player
    // made and was deliberately never persisted — so the menu goes back to
    // offering the one they did pick, rather than to whichever stranger's round
    // they last dropped into. Legal here because the state is already `menu`.
    this.mapDef = readMap();
    this.clearPause();
    this.deployScreen.hide();
    this.stowKit();
    this.settingsScreen.hide();
    this.deathCam.stop();
    this.hud.setDeathCam(false);
    this.minimap.setVisible(false);
    this.player.setBodyHidden(true);
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
   * A map is mid-build with a `buildRound` already queued for the next frame.
   *
   * A method rather than `this.state === "loading"` written out twice, because
   * `toggleEditor` has to ask it on both sides of an await and TypeScript
   * carries the first check's narrowing straight through one — it calls the
   * second comparison dead, which is precisely the assumption the second check
   * exists to refuse. Behind a call it cannot narrow, so the question stays
   * askable.
   */
  private buildPending(): boolean {
    return this.state === "loading";
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
    // A map is mid-build and a `buildRound` is already queued for the next
    // frame. Opening the editor into that would put a second build behind it
    // and leave the editor holding a map that the first one had disposed —
    // the failure `installMap` exists to prevent, arriving by the one door it
    // does not cover. One frame, and F2 works on the next.
    if (this.buildPending()) return;
    // A previous F2 is still waiting on the import. Its `createEditor` has not
    // run yet, so `this.editor` is still null and would wave this one through.
    if (this.editorLoading) return;
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

    this.editorLoading = true;
    let createEditor;
    try {
      ({ createEditor } = await import("../editor"));
    } finally {
      // Cleared before the opening rather than after it: everything below this
      // point is synchronous, so nothing can interleave with it, and a throw in
      // the import must not wedge F2 for the rest of the session.
      this.editorLoading = false;
    }
    // Both pre-await guards owe a second look. The import is a task boundary,
    // so the `loading` state that was clear a moment ago may not be — a round
    // started underneath would have its build stomped to "editor" here.
    if (this.buildPending() || this.editor) return;

    this.state = "editor";
    const map = this.buildEditorMap();
    this.overlayScreen.hide();
    // F2 is reachable from the pause menu, and an editor session that inherited
    // a suspended audio context and a hidden crosshair would be a puzzle.
    this.clearPause();
    this.hud.setEditing(true);
    this.deployScreen.hide();
    // F2 is reachable from the loadout screen too, and it would sit over the
    // editor's own panel. The settings screen is above both and owes the same.
    this.stowKit();
    this.settingsScreen.hide();
    // And from the death cam, whose body would otherwise be left standing in
    // the map the editor is about to rebuild — `installMap` frees the ragdoll
    // slot underneath it, so the cam has to be told rather than find out.
    this.deathCam.stop();
    this.hud.setDeathCam(false);
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
      mapId: this.mapDef.id,
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
    // The fog wall is stated twice — here, where it is painted, and in CONFIG,
    // where the bot LOD and the ragdoll gate read it. They are the same
    // distance by definition, and a map that disagreed would silently pose,
    // draw or tumble bodies in solid fog. Dev only: it is an authoring
    // mistake, not a runtime condition.
    if (import.meta.env.DEV && environment.fogEnd !== FOG_WALL) {
      console.warn(
        `Map fogEnd ${environment.fogEnd} != CONFIG FOG_WALL ${FOG_WALL}; ` +
          "the bot LOD and the ragdoll distance gate are keyed off the latter.",
      );
    }
    this.map?.dispose();
    this.combat.clearTransient();
    // A grenade whose fuse outlived the map it was thrown across would go off
    // over terrain that no longer exists — and, in the editor, in the middle
    // of a rebuild.
    this.grenades.reset();
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
    // How hard the grade is pushed is the map's; whether it runs at all stays
    // the player's (`applySettings`). A vignette that reads as dread over a
    // night village reads as a lens fault over a bright one.
    this.post.setGrade(environment.grade);
    this.shadows.setCasters(map.visuals);
    this.atmosphere.apply(environment.particles, map.size, map.size);
    this.water.build(map.water, environment, map.terrain);
    this.grass.build(map.grass, environment, map.colliderBoxes, map.terrain);
    this.player.setTerrain(map.terrain);
    // The floor a grenade comes to rest on, as a backstop under the collider
    // proxies — the same terrain the player's ground probe falls back to, and
    // the map's own mist and moon, which are what colour the blast dust.
    this.grenades.setTerrain(map.terrain);
    this.grenades.setEnvironment(environment);
    // The corpses' static world. Same reason the grenades are cleared above:
    // a physics world still holding shapes built from the map that was just
    // disposed is geometry that no longer exists, and in the editor that means
    // in the middle of a rebuild. Editor builds register nothing at all.
    this.ragdolls.setMap(map, opts?.editor === true);
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

  /**
   * Puts the building card up and hands the round itself to the next frame.
   *
   * The split is the whole point. Everything `buildRound` does is synchronous
   * and adds up to the better part of a second — merges, the occlusion bake,
   * the nav grid — and a browser paints between TASKS, not inside one, so
   * before this the card the player had just confirmed stayed on screen,
   * frozen, for the entire build and the deploy screen appeared straight out
   * of it. Nothing was slow that is not slow now; what was missing was any
   * sign that the game had heard the button. So: raise the card, yield, and
   * let the freeze happen with something on screen that explains it.
   *
   * `requestAnimationFrame` rather than a timeout, because what is owed is a
   * PAINT and rAF is the only thing that tracks one — and TWO of them, which
   * is the part that is easy to get wrong and was, once, here. A frame runs
   * its animation callbacks and THEN paints, so a single rAF booked from
   * ordinary task code fires before the card it is waiting on has ever been
   * on the glass: the build blocks, and what stands frozen for the whole
   * second is the menu, exactly as before the split. Caught on a screencast,
   * which is the only thing that can see it — every DOM assertion passes,
   * because the markup is right and it is the compositor that never got a
   * turn. One rAF *is* enough from inside the render loop, which is where the
   * real callers are, but that makes correctness a property of the call site
   * rather than of this method. The second one costs a frame and owes nothing
   * to anybody's ordering. `main.ts` defers taking the boot screen down the
   * same way and for the same reason.
   *
   * The lids come down HERE rather than in `buildRound` — a kit screen that
   * stayed up over the building card would be the same lie in a smaller frame.
   */
  private startRound(): void {
    // One round at a time. `tick` dispatches nothing in `loading`, so no input
    // can reach here twice on its own — but the guard is kept LOCAL to the
    // method that owns the invariant rather than left resting on the three
    // callers all continuing to be careful. A second build over a queued one
    // leaves the systems holding a map the first one disposed, which is the
    // silent failure `installMap` exists to prevent.
    if (this.state === "loading") return;
    this.overlayScreen.hide();
    // Reachable from the menu, so any lid may still be up over it — including
    // the lobby, which is the one that got here on a networked round.
    this.stowKit();
    this.settingsScreen.hide();
    this.lobbyScreen.hide();
    // Reachable straight from the pause menu ("Restart round"), and harmless
    // from anywhere else.
    this.clearPause();
    this.state = "loading";
    this.overlayScreen.showBuilding(this.mapDef.name);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => this.buildRound()),
    );
  }

  /**
   * Builds the map and everything standing on it, then opens the deploy
   * screen. Always entered from `startRound`, one frame later — see there for
   * why the two are not one method.
   */
  private buildRound(): void {
    // The welcome beat the build. Read here for the same reason the team is —
    // it can land on either side of this method, and the half that arrives
    // first has nothing on screen to correct. `NetSession.onSeated` is the
    // other half and defers to this one while the state is `loading`.
    //
    // FIRST, before a single line of the build: everything below reads
    // `mapDef` — the environment, the sky, `installMap` — so a map applied
    // after any of them is a round half built out of each.
    if (this.net?.seated) {
      if (this.applyMatchMap(this.net.mapId) === "unknown") {
        this.leaveUnknownMap(this.net.mapId);
        return;
      }
    }
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
    // Every rig goes back to the pool restored; a corpse cannot outlive the
    // round it fell in.
    this.ragdolls.reset();
    this.conquest.start(map);
    // The flags' markers read the same radius ConquestSystem tests against,
    // and follow the same terrain the ring is drawn across.
    this.zones.build(map.controlPoints, map.terrain, map.nav, env);
    this.player.fullReset();
    // Offline the player is team 0 for the life of the process. In a netplay
    // round the side is the authority's, and the session has it whenever the
    // welcome beat this build; when it did not, the welcome applies it itself.
    // Either way it goes in through the one funnel — see `applyPlayerTeam`.
    this.applyPlayerTeam(this.net?.seated ? this.net.team : 0, map);
    // A new round is a new board. Sized from the pool here rather than at
    // construction, so it is the roster that says how many rows there are.
    this.botKills.length = 0;
    this.botDeaths.length = 0;
    for (let i = 0; i < this.battle.bots.length; i++) {
      this.botKills.push(0);
      this.botDeaths.push(0);
    }
    this.playerKills = 0;
    this.playerDeaths = 0;
    // The building card comes down on the far side of the work it covered, and
    // with it `.overlaid` — the deploy screen is one of the two that reads the
    // HUD underneath it rather than hiding it.
    this.overlayScreen.hide();
    this.enterDeploy(0);
  }

  /**
   * Which side the player is on, and everything already standing in its
   * colours.
   *
   * Offline the answer is always team 0. In a netplay round it is the
   * authority's — `Roster.claim` seats the second human on team 1 — and it
   * arrives in the welcome, which can land on EITHER side of the local build
   * because `joinMatch` books the round before the socket is open. So this is
   * called from both ends: `buildRound` deals whatever the session already
   * has, and `NetSession.onSeated` deals it again when it turns out to
   * disagree. That is why nothing here may assume it is running on a fresh
   * round.
   *
   * Almost everything downstream reads `player.team` live, every frame, and
   * needs nothing from this. What it collects is the things that take a COPY
   * and would otherwise wear the old side's colours for the rest of the round:
   * the death cam's stand-in body is built once, the minimap's backdrop is
   * prerendered once, and the HUD's strip is only re-read inside `playing` —
   * which the deploy screen the welcome usually lands under is not.
   */
  private applyPlayerTeam(team: Team, map: GameMap): void {
    this.player.team = team;
    // Built here, not at the moment of death: nine merged meshes and their GL
    // buffers is not a cost to pay on the frame the player is killed on. A
    // change of side is the one thing that rebuilds it, and `prepare` is the
    // one that knows how to do that safely — see there.
    this.deathCam.prepare(team);
    this.minimap.setMap(map, team);
    this.hud.setTickets(
      [CONFIG.teams[0].name, CONFIG.teams[1].name],
      this.conquest.tickets,
      team,
    );
    this.hud.setFlags(this.conquest.points, team);
    // Only when it is already up. `enterDeploy` shows it a moment after a
    // build, so doing it there too would be the same paint twice — and a team
    // that changed UNDER a standing deploy screen has to go back through
    // `show`, because the spawn list it is offering belongs to the other side.
    if (this.deployScreen.visible) {
      this.deployScreen.show(map, this.conquest, team);
    }
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
    // Both stances latch, and a fresh body neither crouches nor runs. The
    // crouch one also catches the pad's B doing double duty: backing out of
    // the kit screen on the way to deploying flips the latch, and nothing else
    // would clear it.
    this.input.clearCrouchToggle();
    this.input.clearSprintToggle();
    this.state = "playing";
    // `enterDeploy` dropped the lock, and until now the only thing that ever
    // took it back was a click — the `pointerdown` handler in the constructor,
    // which is the deploy map's own click arriving a moment later. A pad player
    // never generates one, so every deployment left them in the world with the
    // OS cursor sitting over the crosshair until they reached for the mouse.
    // Taking it here covers both: the click path asks twice in the same gesture
    // (harmless — the second request resolves onto the same lock) and the pad
    // path asks at all. It is a best effort, exactly as `requestLock`'s note
    // says: a browser that insists on a user gesture refuses, and a pad player
    // there is no worse off than before.
    this.requestLock();
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
    // The weapon swap, asked for either way round: the wheel and pad Y want
    // "the other one", the number keys name a slot. Both land on the same
    // gesture, and `drawSlot` is what refuses a request for the weapon already
    // up — so a second press of `1` costs nothing rather than replaying half a
    // second of animation.
    //
    // Nothing else is owed here: the hands, the camera's fit and the HUD's
    // caption are all pushed from `player.onCarryChanged` when the weapons
    // actually change places, which is partway through the gesture rather
    // than now.
    const swapped = this.input.swapPressed
      ? this.player.swapWeapon()
      : this.input.slotPressed >= 0 &&
        this.player.drawSlot(this.input.slotPressed);
    if (swapped) this.sfx.swap(this.player.swapTotal);
    // A throw is a gesture with a release inside it, so it is two checks a
    // frame apart rather than one call: the button starts the arm, and the
    // grenade leaves when the arm gets there. The release is tested here,
    // straight after `player.update`, because that is the call that posed the
    // hand it comes out of.
    if (this.player.throwReleaseDue()) this.releaseGrenade();
    if (this.input.grenadePressed) this.player.beginThrow();

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
        this.enemyTargets(),
        this.player.range,
        this.player.shotOptions,
      );
      // Networked: report the round. Everything above stays exactly as it is —
      // the local resolve is what draws the tracer, flashes the hitmarker and
      // kicks the weapon, and none of that may wait on a round trip. What it
      // no longer does is decide anything: in a netplay round `enemyTargets`
      // answers with the `NetSoldier`s the roster is drawing, whose
      // `takeDamage` returns false and changes nothing, so the hitmarker below
      // is a PREDICTION and the server's `hit` event is the truth.
      //
      // `shot.dir` and not `cameraSys.forward`: the spread was rolled inside
      // `fire`, and the server has to re-resolve this bullet rather than a
      // differently-jittered one.
      this.net?.sendShot(this.cameraSys.camera.position, shot.dir, 0);

      // Bots hear the player's rifle the same way they hear each other's. This
      // is the only place the player's own gunfire enters the world, so it is
      // the only place that can say so.
      this.battle.hearGunshot(muzzle, this.player.team);
      // Recoil: kick the aim up and off toward the weapon's own bias, softened
      // braced and stiffened on the move. It decays on its own, so the burst
      // climbs and settles.
      //
      // The vector is built by `Player.recoilKick` and not here: every number
      // in it is the weapon's, and `docs/weapons.md` has always said the recoil
      // multipliers reach nothing but `Player`. Wiring it to the camera is this
      // call site's whole job, which is what a call site in `Game` is for.
      // Exactly once per shot — it reads the string counter and the drift
      // `tryShot` just advanced.
      const kick = this.player.recoilKick(blend);
      this.cameraSys.addRecoil(kick.pitch, kick.yaw);
      // Cosmetic view punch: FOV spike + shove + a nudge thrown the way this
      // round went, on the rendered camera only — the bullets above already
      // left with the clean aim.
      this.cameraSys.addPunch(this.player.kickDrift);
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
        // stop putting rounds into a body that is already going down. A
        // headshot is the second axis and loses to a kill on the marker,
        // because "stop shooting" is the more urgent thing to say; it keeps
        // its own sound either way, which is where the read actually lands.
        this.hud.flashHitmarker(killed, shot.headshot);
        if (shot.headshot) this.sfx.headshot();
        else this.sfx.hit();
        // Netplay: this marker is a guess, and remembering that it was made is
        // what keeps the authority's answer from repeating it a round trip
        // later. See `claimPredictedHit`.
        if (this.net) this.creditPredictedHit(shot.headshot);
        this.input.rumble(
          killed ? haptic.killStrong : haptic.hitStrong,
          killed ? haptic.killWeak : haptic.hitWeak,
          killed ? haptic.killMs : haptic.hitMs,
        );
        if (killed && shot.target instanceof Bot) {
          // Both doors, one line apart: our row, and the body's. Offline only
          // — in a netplay round `killed` is false above, because the roster's
          // bodies refuse local damage and the authority scores this round.
          this.creditKill(this.player);
          this.registerBotKill(shot.target, this.player.team, true);
        }
      }
      if (this.player.reloading) this.sfx.reload(this.player.reloadTime);
    }

    if (!this.updateWorld(dt)) return;

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
   * Everything in a frame that is about the FIGHT rather than about the player:
   * the objectives, the bots, the rounds already in the air, and the bodies on
   * the ground. Returns false when the round ended on this frame, which is the
   * caller's cue to do nothing else with a game that is over.
   *
   * It is its own method because the death cam needs every line of it and not
   * one line of what surrounds it. The whole point of watching your own body
   * fall is that the fight carries on around it — tickets bleed, a squad takes
   * the flag you died on, your killer walks past — and a death cam over a world
   * that stopped is a screenshot. Splitting it here is what makes that true by
   * construction rather than by keeping two copies of the sequence in step, the
   * same failure `installMap` exists to prevent one layer down.
   */
  /**
   * What the URL says about multiplayer, read once at construction.
   *
   * Three parameters, and only the first is needed in a deployed build:
   *
   * - `?name=` — what to call this player, until the lobby grows text entry.
   * - `?server=ws://host:port/ws` — which match server the LOBBY should list
   *   and join. Purely a dev affordance: the client is on Vite's port and the
   *   server on its own, so same-origin does not reach it.
   * - `?mp` — skip the menu and join immediately, optionally naming the server
   *   the way `?server=` does. It predates the lobby and is kept because it is
   *   how the smoke tests get into a networked round in one navigation; the
   *   menu's Multiplayer row is the way a player gets there.
   */
  private joinFromUrl(): void {
    const params = new URLSearchParams(location.search);
    const name = params.get("name");
    if (name) this.playerName = name;
    const server = params.get("server");
    if (server) this.netUrl = server;
    const mp = params.get("mp");
    if (mp === null) return;
    // A value on `?mp` names the server too, so the one-navigation form does
    // not also need `?server=`.
    if (mp !== "") this.netUrl = mp;
    this.joinMatch();
  }

  /**
   * Joins a networked match: a specific one from the lobby, a fresh one, or
   * whatever has room when neither is asked for.
   *
   * The map is built LOCALLY exactly as an offline round builds it — the server
   * has the same layout and the same baked colliders, so the world both sides
   * reason about is the same one without a byte of it crossing the wire. What
   * comes over the wire is only what MOVES.
   *
   * **Which map that is belongs to the MATCH, never to this menu.** `opts.mapId`
   * is the row's, straight off the list the lobby is showing, and it is applied
   * before the build so the common case builds the right world first time. It is
   * an optimisation and not the guarantee: an unnamed join has no row to read,
   * and a match can rotate between the fetch and the pick, so the welcome is
   * still what settles it — see `applyMatchMap`. What travels the other way is
   * `map`, the map to start a match on if this join CREATES one.
   */
  joinMatch(opts: { matchId?: string; create?: boolean; mapId?: string } = {}): void {
    if (this.net) return;
    // Refused before anything is built or connected, which is the cheapest of
    // the three places this can be caught and the only one that leaves the
    // player looking at the list they picked from.
    if (opts.mapId !== undefined && this.applyMatchMap(opts.mapId) === "unknown") {
      this.hud.toast(`that match is on "${opts.mapId}", which this build does not have`);
      return;
    }
    const net = new NetSession(this.scene, this.mats);
    this.net = net;

    // The server placed us. This is the only thing that spawns the local body
    // in a networked round — there is no local respawn timer, because a
    // reinforcement is the authority's to spend.
    net.onSpawn = (pos, yaw) => {
      this.spawnPlayer({ pos: pos.clone(), yaw });
    };

    // A rejected position. Small disagreements are eased so an occasional
    // refusal is not a visible jerk; a large one is a genuine desync and
    // easing it would mean spending seconds visibly inside a wall.
    net.onCorrection = (pos, reason) => {
      const off = Vector3.Distance(this.player.position, pos);
      if (off > CONFIG.net.correctionSnap) {
        this.player.placeAt(pos.clone());
        this.hud.toast(`resynced (${reason})`);
      } else {
        this.player.nudgeTo(pos);
      }
    };

    // The side the authority put us on, arriving after the round was booked.
    // The build below is optimistic about everything, and about this it was
    // wrong for the second person into a match: `Roster.claim` fills the
    // thinner team, so they are on team 1 while every screen here is painted
    // for team 0.
    //
    // Two cases and one of them is not this callback's: a welcome that beats
    // the build has nothing on screen to correct and is read straight off the
    // session by `buildRound`, which is what the `loading` test defers to. The
    // team not having changed is the ordinary case — every first joiner, and
    // every reconnect that lands back on the same side — and it repaints
    // nothing there, because re-showing the deploy screen would throw away the
    // spawn the player is in the middle of choosing.
    net.onSeated = (team) => {
      if (this.state === "loading" || !this.map) return;
      // The map before the team, because a map that disagrees rebuilds the
      // whole round and `buildRound` deals the team itself on the way through.
      // This is the case the lobby's row could not cover: an unnamed join, or a
      // match that rotated between the list and the pick. The wasted build is
      // the price of booking the round before the socket is open, and it is
      // paid rarely — the welcome usually lands while `loading` is still up,
      // where the branch above defers to `buildRound`.
      switch (this.applyMatchMap(net.mapId)) {
        case "unknown":
          this.leaveUnknownMap(net.mapId);
          return;
        case "changed":
          this.startRound();
          return;
      }
      if (team !== this.player.team) this.applyPlayerTeam(team, this.map);
      // A seat is a body the authority is holding until it is ASKED for, and
      // this callback is raised again on every reconnect — where the client is
      // usually in the middle of the round it thinks it is still playing. Its
      // old slot is gone, the new one is dead with a zero clock, and every
      // movement sample it sends from here on is dropped as "a dead player
      // reports nothing worth keeping": it would walk the map as a ghost that
      // nobody can see, be hit by nothing, and hit nothing back.
      //
      // So the screen that asks goes back up. After the team above, so the
      // spawns it offers belong to the new seat.
      //
      // `deploy` is deliberately not in this list: that screen is already up
      // and asking, and re-showing it would reset a selection the player is in
      // the middle of making — the same reason `applyPlayerTeam` re-shows it
      // only when the side has actually changed. A request made before the
      // reconnect is not lost with the socket either: `NetSession` holds it
      // until the authority answers with a spawn, and re-sends it on the seat
      // that answers.
      if (this.state === "playing" || this.state === "dying") {
        this.enterDeploy(0);
      }
    };

    net.onEvent = (event) => this.onNetEvent(event);

    // Somebody else's body went down. The same pool, the same offer and the
    // same five refusals every bot's corpse goes through — the only difference
    // is that offline `registerBotKill` reaches this line having just charged a
    // ticket and written a killfeed line, and here the authority did both
    // before the news arrived. A callback rather than a reach into the roster
    // for the reason every other cross-system effect in this file is one.
    //
    // Not the priority offer: that is the death cam's alone, and a full pool
    // refusing a body across the square is the pool working. The collapse tween
    // the server is already driving through `EntityState.dead` is what a
    // refusal falls back to, which is why that tween is load-bearing on this
    // path exactly as it is on the bots'.
    net.roster.onDeath = (soldier) =>
      this.ragdolls.spawn(soldier, this.cameraSys.camera.position);
    net.roster.onRetire = (soldier) => this.ragdolls.retire(soldier);

    // A new round on a new map, same seat. The world is rebuilt LOCALLY from
    // the same layout the server is using — the map never crosses the wire —
    // and the server's spawn event puts the body back afterwards.
    //
    // Through `applyMatchMap` and not `setMap`, which is the player picking one
    // and refuses to run outside the menu: a rotation arrives in `roundover`,
    // so every one of them used to leave the client rebuilding the map it was
    // already on while the server moved to the next.
    net.onRoundStart = (mapId) => {
      if (this.applyMatchMap(mapId) === "unknown") {
        this.leaveUnknownMap(mapId);
        return;
      }
      this.startRound();
    };
    net.onStateChange = (state) => {
      if (state === "closed") this.hud.toast("disconnected");
    };

    // The handshake was refused — a match that filled or retired between the
    // list and the pick, or a server speaking a protocol this build does not.
    // The round that was optimistically started is torn down and the player is
    // put back where they chose from, with the server's own words for why.
    net.onRejected = (reason) => {
      // `enterMenu` drops the session and tears the round down; the lobby then
      // goes back up over it and re-fetches, so the row that refused is gone
      // from the list by the time the player reads why.
      this.enterMenu();
      this.hud.toast(reason);
      this.openLobby();
    };

    // The screen stays up under the build, showing which row is being joined,
    // and `startRound` takes it down on the way into `loading`.
    if (opts.matchId) this.lobbyScreen.setJoining(opts.matchId);

    this.startRound();
    net.connect({
      name: this.playerName,
      url: this.netUrl,
      weapon: this.weapon,
      matchId: opts.matchId,
      create: opts.create,
      // Sent on every join rather than only on a create, because "there is room
      // somewhere" can end in a fresh match too — the server spends this only
      // when it actually builds one, and ignores it otherwise.
      map: this.mapDef.id,
    });
  }

  /**
   * Drops the networked session, if there is one. Idempotent, and safe to call
   * from a state that never had one — which is most of `enterMenu`'s callers.
   */
  private leaveMatch(): void {
    this.net?.dispose();
    this.net = null;
    // Nothing can claim these now. They would time out on their own inside the
    // second, and clearing them is what makes that a property of the boundary
    // rather than of the window's length.
    this.hitCredits.length = 0;
  }

  /** What a server event does to this client's screen. Presentation only. */
  private onNetEvent(event: ServerEvent): void {
    switch (event.e) {
      case "kill": {
        const killer = CONFIG.teams[event.killer].name;
        const victimSlot = this.net?.roster.soldiers[event.victim];
        const victim = victimSlot ? CONFIG.teams[victimSlot.team].name : "";
        this.hud.addKill(killer, victim, event.killer === this.player.team);
        // Arm the corpse with the round that felled it. It is SPENT later, by
        // `NetRoster` when the interpolated death arrives — this event is real
        // time and the body is drawn `interpDelay` behind it, so throwing it
        // here would throw a body that has not visibly been hit yet.
        if (victimSlot) {
          victimSlot.deathFrom.set(event.from[0], event.from[1], event.from[2]);
          victimSlot.deathDamage = event.amount;
        }
        break;
      }
      case "captured":
        this.hud.showMessage(
          `${event.point.toUpperCase()} CAPTURED BY ${CONFIG.teams[event.by].name.toUpperCase()}`,
          2.5,
        );
        break;
      case "neutralised":
        this.hud.toast(`${event.point} — neutralised`);
        break;
      case "roundover":
        this.endRound(event.winner);
        break;
      // Our own round landed — or, as often, did not. The local hitmarker was
      // a prediction made against interpolated bodies; this is the authority
      // re-resolving it against what we were actually looking at. When the two
      // disagree the server wins, and what is cued here is the CORRECTION and
      // nothing else: a round the shooter has already been told about is
      // claimed silently, because a marker and a tick arriving twice for one
      // bullet — a round trip apart, so plainly a second event rather than an
      // echo — reads as two hits and makes the cue worth less than it was.
      //
      // The server addresses this one to the shooter, so the slot test is a
      // GUARD and not the filter it used to be. It stays because the two halves
      // ship as separate images: during a rolling deploy this client may be
      // talking to a server old enough to still broadcast the event, and a
      // hitmarker for somebody else's round is exactly the failure a version
      // check at the handshake cannot catch, since the shape did not change.
      case "hit":
        if (
          event.shooter === this.net?.slot &&
          !this.claimPredictedHit(event.killed, event.headshot)
        ) {
          this.hud.flashHitmarker(event.killed, event.headshot);
          if (event.headshot) this.sfx.headshot();
          else this.sfx.hit();
        }
        break;

      // We were hit. Health is the server's, so it is assigned rather than
      // subtracted — a client that decremented its own would drift out of step
      // with the authority over a firefight and disagree about who is alive.
      // `applyServerHealth` also arms the regen lock, which is the half of the
      // hit that never crosses the wire: the server holds the health down for
      // `regenDelay` and then heals it back, and the client runs the identical
      // curve locally rather than being told about every point of it.
      //
      // Addressed to the victim by the server, so — exactly as with `hit` above
      // — the slot test is a rolling-deploy guard rather than the filter it was.
      case "damage":
        if (event.victim === this.net?.slot) {
          this.player.applyServerHealth(event.health);
          this.netDamageFrom.set(event.from[0], event.from[1], event.from[2]);
          this.netDamageAmount = event.amount;
          this.onPlayerDamaged(event.amount, false, this.netDamageFrom);
        }
        break;

      // A death, decided elsewhere. `killPlayer` is the local path and must not
      // run here: it charges a ticket and starts a respawn clock, both of which
      // the server already owns.
      //
      // What it DOES owe is the four seconds of watching, because a death cam
      // decides nothing — it is a camera and a stand-in body, and the round
      // carries on underneath it either way. The bearing and the size of the
      // killing blow are the `damage` event's, which the server queues
      // immediately ahead of this one and which is the only thing that knows
      // them: `died` carries a slot and a clock and nothing to throw a body
      // with. `enterDying` falls through to the deploy screen on its own if the
      // cam cannot come up, so this is not a state that can strand a player.
      case "died":
        if (event.slot === this.net?.slot) {
          this.player.health = 0;
          this.player.alive = false;
          if (this.state === "playing") {
            this.enterDying(
              this.netDamageFrom,
              this.netDamageAmount,
              event.respawnIn,
            );
          } else {
            this.enterDeploy(event.respawnIn);
          }
        }
        break;

      // Somebody's weapon went off. Gunfire gives an enemy away on the minimap
      // for a couple of seconds, which offline is `wireBattle` reading
      // `BattleSystem.onBotFired` — a callback that fires on nothing here,
      // because this client runs no AI and never hears another person's
      // trigger. So the authority says it instead, and the two paths make the
      // same team test at the same point: a friendly is drawn on that map
      // whether they are shooting or not, and our own slot is the player, who
      // is the arrow in the middle of it.
      //
      // Public, and it may name a body across the map behind a wall — exactly
      // as offline, where any enemy bot firing anywhere is revealed. It gives
      // nothing away that the snapshot has not already handed over: every
      // position is in there, and what the minimap withholds it withholds by
      // choice rather than by ignorance.
      case "fire": {
        const shooter = this.net?.roster.soldiers[event.slot];
        if (shooter && shooter.team !== this.player.team) {
          this.minimap.reveal(shooter);
        }
        break;
      }

      // A blast the authority resolved. The light, the noise and the
      // concussion are `onExplosion`'s, exactly as they are offline — the
      // difference is only who decided it happened.
      case "explode":
        this.netDamageFrom.set(event.at[0], event.at[1], event.at[2]);
        this.onExplosion(this.netDamageFrom);
        break;

      case "spawn":
        break;
    }
  }

  /**
   * Who the local player's own rounds may find: the bots offline, the bodies
   * drawn from the wire in a netplay round.
   *
   * Two callers — the shot resolve and the gamepad aim assist — and the whole
   * reason this is a method is that they must never be handed different lists:
   * the assist's job is to hold an aim the rounds can use.
   *
   * `battle` is not merely the wrong list in a netplay round, it is an EMPTY
   * one, and empty in a way no team check reveals. `buildRound` calls
   * `battle.reset()`, which leaves every bot in the pool dead, and `updateWorld`
   * returns before `battle.update` is ever reached, so nothing respawns them;
   * the only other combatant that side knows about is the local player, whom the
   * team check drops. Reading that list there cost the shooter every local cue a
   * hit is owed — sparks landed on the wall behind the man who was hit, no
   * hitmarker arrived until the server's `hit` event had made the round trip,
   * and aim assist had nothing to hold on to at all.
   *
   * The result is a scratch array owned by whichever side answered. Consume it
   * inside the call, exactly as `BattleSystem.hittablesAgainst`'s own contract
   * requires — both callers do.
   */
  private enemyTargets(): Hittable[] {
    return this.net
      ? this.net.roster.hittablesAgainst(this.player.team)
      : this.battle.hittablesAgainst(this.player.team);
  }

  /**
   * Every body but the local player's, as the minimap draws them.
   *
   * The same substitution `enemyTargets` makes, for the same reason and with
   * the same failure behind it: in a netplay round `battle.bots` is a pool
   * `battle.reset()` left dead and `updateWorld` never steps again, so the map
   * drew no friendlies at all and a reveal had nobody to name. It was not a
   * missing feature so much as a list that had quietly gone empty — the panel
   * still drew, the flags still moved, and only the blips were gone.
   *
   * Unlike `enemyTargets` this is a plain READ — no shot is resolved against
   * it, no team is filtered out of it — so it hands back the array as it
   * stands rather than a scratch list, and both teams are in it because the
   * minimap decides for itself which half it may draw.
   *
   * The local player's own slot IS in the netplay array, and is left dead by
   * `NetRoster.applyRoster` for the life of the session (its snapshots are
   * skipped, so nothing revives it). That is what keeps a friendly blip from
   * sitting under the arrow that already stands for the player.
   */
  private mapBodies(): readonly Combatant[] {
    return this.net ? this.net.roster.soldiers : this.battle.bots;
  }

  /**
   * Rounds this client has already cued a hitmarker for, waiting on the
   * authority to say whether it agrees.
   *
   * The pair of methods below is the whole of the rule that a landed round is
   * announced ONCE. Both ends have an opinion about the same bullet — the local
   * resolve the instant the trigger went, the server's `hit` a round trip later
   * — and the second is worth a marker and a noise only when it carries
   * something the first did not.
   *
   * A queue rather than a counter because several rounds are in flight at
   * automatic rates, and each is claimed in the order it was fired: the server
   * re-resolves them in that order and reports them down one socket, so
   * first-in-first-out pairs them without the protocol carrying a shot id.
   * Entries expire on their own, which is what stops a round the authority
   * scored as a MISS — no event ever arrives for one — from leaving a credit
   * standing to swallow the next real correction.
   *
   * Only bullets are ever in here: `Match` raises `hit` from the shot path and
   * from nowhere else, so a blast can neither leave a credit nor claim one.
   */
  private readonly hitCredits: { headshot: boolean; until: number }[] = [];

  /** Drops credits the authority never claimed. Ordered, so the front is oldest. */
  private pruneHitCredits(now: number): void {
    while (this.hitCredits.length > 0 && this.hitCredits[0].until <= now) {
      this.hitCredits.shift();
    }
  }

  /** A local resolve says this round landed, and the marker is already up. */
  private creditPredictedHit(headshot: boolean): void {
    const now = performance.now();
    this.pruneHitCredits(now);
    this.hitCredits.push({
      headshot,
      until: now + CONFIG.net.hitCreditWindow * 1000,
    });
  }

  /**
   * The authority's verdict on a round. True when this client has already said
   * everything the verdict has to say, and the event owes no second cue.
   *
   * The credit is spent either way — this round's answer has arrived, whatever
   * it is. Two things override agreement:
   *
   * - **A kill.** The prediction cannot make that claim (`NetSoldier.takeDamage`
   *   returns false, so the local resolve never reports one), and the red marker
   *   is the one that means STOP SHOOTING — the most useful thing a hitmarker
   *   ever says, and never a repetition.
   * - **A headshot the prediction missed.** The bodies here are drawn
   *   `interpDelay` behind, so the head zone the server found on its rewound
   *   copy is not always the one this client tested against.
   *
   * The other direction — this client called a headshot and the server scored a
   * body hit — is deliberately silent. It is a hit either way, the marker for it
   * is already on screen, and correcting the flavour downward is worth less than
   * the doubled cue it would cost.
   */
  private claimPredictedHit(killed: boolean, headshot: boolean): boolean {
    this.pruneHitCredits(performance.now());
    const credit = this.hitCredits.shift();
    if (!credit) return false;
    if (killed) return false;
    return !(headshot && !credit.headshot);
  }

  /** Scratch for a networked damage bearing; never allocated per hit. */
  private readonly netDamageFrom = new Vector3();
  /**
   * How much the last networked hit was for, kept alongside the bearing so the
   * `died` event that follows it has something to throw the corpse with.
   */
  private netDamageAmount = 0;

  /**
   * The networked half of a frame.
   *
   * Called from `updateWorld` after the local player has moved, so what is
   * uploaded is this frame's position rather than last frame's, and before
   * anything reads where the other bodies are. `updateWorld` and not
   * `updateGameplay` because the death cam runs the former and not the latter,
   * and a death cam over sixteen bodies frozen mid-stride is the screenshot
   * that split is there to prevent.
   */
  private updateNet(dt: number): void {
    if (!this.net) return;
    this.net.update(
      dt,
      {
        position: this.player.position,
        yaw: this.cameraSys.aimYaw,
        pitch: this.cameraSys.aimPitch,
        crouching: this.player.crouching,
        sprinting: this.player.sprinting,
      },
      this.conquest.points,
      this.cameraSys.camera.position,
      // Only a player who is actually IN the round reports where they are. The
      // health flag alone is not that question any more, now that this runs
      // under the deploy screen too: a round opens with a live `Player` that
      // has never been placed, so a bare `alive` would upload the last round's
      // position — or the origin — on behalf of a body the authority holds as
      // dead and has not deployed yet. The server drops those samples anyway
      // (`onMove` returns on a dead player), which is exactly why the client
      // should not be sending them.
      this.state === "playing" && this.player.alive,
    );
    // The mirrored ticket counts, so the HUD strip reads the server's round
    // rather than a local `ConquestSystem` that is no longer being stepped.
    this.conquest.tickets[0] = this.net.tickets[0];
    this.conquest.tickets[1] = this.net.tickets[1];
  }

  /**
   * The half of a netplay frame that is this client's rather than the
   * authority's: everybody else's bodies, and the effects nobody else advances.
   *
   * One method because it has two callers that must never drift apart —
   * `updateWorld` for the states that are IN the round, and the deploy screen
   * for the one state that is not. A player waiting to come back is watching a
   * fight that has not stopped for them, and this screen is a live view of it
   * with a top-down map of the flags over the top; left unstepped, sixteen
   * bodies stand frozen behind the card and then snap to wherever they really
   * are on the frame the player deploys.
   *
   * `RagdollSystem` is in here for a reason sharper than symmetry: `updateNet`
   * is what raises an interpolated death, and a death raised while the pool is
   * not being stepped is a corpse that takes a rig, parents its joints to
   * proxies nothing writes, and hangs in the air for the rest of the round.
   * Stepping the roster without stepping the pool is not half the feature, it
   * is a haunting.
   *
   * This is still not simulation and may never become it. Nothing here decides
   * an outcome, which is what keeps it callable from a state that owns none —
   * and it stays out of `paused` and `menu` for the reason it belongs in
   * `deploy`: those two are a round that is not running, and this is a round
   * running without you.
   */
  private updateNetWorld(dt: number): void {
    this.updateNet(dt);
    this.combat.update(dt);
    this.grenades.update(dt);
    this.ragdolls.update(dt);
  }

  /**
   * That same frame, plus the two gauges, for a card the round is running
   * behind. Offline both callers are a game genuinely held; in netplay neither
   * is, and the difference is the whole of this method.
   *
   * The two HUD pushes are `updateGameplay`'s, made here because the deploy
   * screen and the pause card are the two overlays that deliberately do NOT
   * hide the gauges under them: a flag falling while you pick where to drop in
   * — or while you sit in a menu — changes both, and a strip that only
   * refreshes once you are back in the world spends the whole of that showing
   * the round you left.
   *
   * One method rather than the same eight lines twice, for the reason
   * `updateNetWorld` is one method: two copies of a frame drift, and the way
   * they drift is that a screen added to one keeps drawing while the other
   * stands still.
   */
  private updateNetUnderCard(dt: number): void {
    if (!this.net) return;
    this.updateNetWorld(dt);
    this.hud.setTickets(
      [CONFIG.teams[0].name, CONFIG.teams[1].name],
      this.conquest.tickets,
      this.player.team,
    );
    this.hud.setFlags(this.conquest.points, this.player.team);
  }

  /**
   * What the game is actually DOING, looked at through whatever screens are
   * stacked over it. `settings` is the one lid that can cover another one, so
   * this is two deep and can be no deeper: nothing may be raised over it.
   *
   * `menu` needs no arm because a lid cannot be over a networked round there —
   * `enterMenu` calls `leaveMatch`, so `this.net` is null in every state that
   * reads back as `menu`.
   */
  /**
   * True while the world on screen is genuinely stopped — an offline pause, and
   * the settings screen raised over one. It is what the HUD's own clock keys
   * off: the killfeed and the toasts belong to the frame, so they freeze with
   * it and fade with it, and the failure either way round is a fight fading off
   * a still screen or a still screen catching up in one jump.
   *
   * The deploy screen is deliberately not in here even offline, where it holds
   * the world just as hard: the gauges under it are the ones a player reads
   * while choosing, and the countdown on the card is a clock of its own.
   */
  private get worldHeld(): boolean {
    if (this.net) return false;
    return (
      this.state === "paused" ||
      (this.state === "settings" && this.settingsFrom === "paused")
    );
  }

  private get stateUnderLids(): GameState {
    if (this.state === "settings") {
      return this.settingsFrom === "paused" ? this.pausedFrom : this.settingsFrom;
    }
    if (this.state === "paused") return this.pausedFrom;
    if (this.state === "loadout") return this.loadoutFrom;
    return this.state;
  }

  /**
   * A netplay round carrying on under a lid: the frame, the gauges, and the
   * reinforcement clock when what is under the stack is the deploy screen.
   *
   * The clock is here rather than left to `updateDeployScreen` because it is
   * the ROUND's and not the screen's. The authority runs `NetPlayer.respawnT`
   * down whatever this client has on top, and the local copy is a countdown
   * drawn on the card plus the gate on its own Deploy button — so a lid that
   * stops it makes a player wait out time the server has already given them
   * back, and the number on the card is wrong the whole while. Offline that
   * same lid genuinely holds the round and the clock is right to stop with it.
   */
  private updateNetUnderLid(dt: number): void {
    if (!this.net) return;
    this.updateNetUnderCard(dt);
    if (this.stateUnderLids !== "deploy") return;
    this.respawnT -= dt;
    this.deployScreen.update(this.respawnT);
  }

  private updateWorld(dt: number): boolean {
    // A networked round is somebody else's simulation. Everything below this
    // decides an outcome — who owns a flag, where a bot is going, who died —
    // and the authority has already decided all of it, so the client draws what
    // it was told and runs none of it. The bodies, the flags and the tickets
    // all arrive through `NetSession`, which is stepped from `updateGameplay`
    // where the local player's own frame is.
    //
    // What it still owes is the DRESSING on what it was told, and that is a
    // shorter list than "everything below": a tracer, the impact at the end of
    // it and the grenade the thrower watched leave their own hand decide
    // nothing, are owned by this client alone, and are stepped by nobody else.
    // Left out they do not merely stop moving — a tracer is spawned AT the
    // muzzle a hundredth of a metre long and it is `update` that flies it and
    // hides it again, so every shot left a lit dot hanging in the air where
    // the muzzle had been, and a thrown grenade hung at the release point with
    // a fuse that never ran down. Nothing in here may decide an outcome; that
    // is what keeps this from growing back into the simulation below.
    //
    // The bodies are drawn from here rather than from `updateGameplay` so that
    // the DEATH CAM gets them too. Every line of this method is what a death
    // cam needs and none of what surrounds it — that is the split the header
    // above argues — and a networked round left `updateNet` on the other side
    // of it, so the four seconds spent watching your own body fall were four
    // seconds during which nobody else moved. The order is unchanged: this is
    // still the first thing after the local player has been simulated and
    // before anything reads where anybody is.
    if (this.net) {
      this.updateNetWorld(dt);
      return true;
    }

    // --- objectives ---
    // Runs before the bots so their think tick sees this frame's ownership.
    this.combatants.length = 0;
    this.combatants.push(this.player, ...this.battle.bots);
    this.conquest.update(dt, this.combatants);
    if (this.conquest.winner !== null) {
      this.endRound(this.conquest.winner);
      return false;
    }

    // --- bots ---
    this.battle.update(dt, this.cameraSys.camera.position);
    this.spendMuzzleLightBudget();
    this.combat.update(dt);
    // After the bots, so a grenade thrown on this frame's think tick flies on
    // this frame rather than sitting in the thrower's hand until the next one.
    this.grenades.update(dt);
    // After the grenades, because a blast kill resolves in there — so a body
    // taken this frame gets its first step this frame rather than hanging in
    // the air for one. This is the ONLY place the physics world is stepped:
    // `scene.physicsEnabled` is false precisely so that a pause, the deploy
    // map and the menu — all of which render — cannot advance it.
    this.ragdolls.update(dt);
    return true;
  }

  /**
   * The frame while the player is down: the same fight, watched from outside.
   *
   * It runs the world first and the camera second, the same order
   * `updateGameplay` does and for the same reason — everything downstream of
   * the camera (shader fog, light slots, audio panning) keys off where the
   * viewer is, and the viewer here is following a body that the ragdoll step
   * above has just moved.
   *
   * The wait is not additive: the deploy screen opens with `respawnDelay` minus
   * the time already spent here, so a life still costs the same eight seconds
   * it did before there was anything to watch.
   */
  private updateDeathCam(dt: number): void {
    if (!this.updateWorld(dt)) return;
    this.deathCam.update(dt);
    // The one place the camera is allowed off the player's eye.
    this.cameraSys.place(this.deathCam.eye, this.deathCam.look);
    // The body, not the corpse's last standing position: the shadow window has
    // to cover what is on screen, and what is on screen is wherever the tumble
    // ended up.
    this.shadowFocus.copyFrom(this.deathCam.look);
    this.updateSceneForCamera(dt, this.shadowFocus, this.player, this.combatants);
    this.zones.update(
      dt,
      this.conquest.points,
      this.player.team,
      this.cameraSys.camera.position,
    );
    this.updateHud(dt, true);
    // A cam that is no longer up ends this state as surely as one that ran its
    // course. The clock alone would not: `stop()` zeroes it, so a cam dropped
    // by anything that did not also move the state on would leave `elapsed` at
    // 0 for the rest of the round — a state whose exit condition is a clock
    // that has stopped ticking, which is a player who never respawns. Every
    // stop site does move the state today, and this is what keeps the exit from
    // depending on all of them continuing to.
    const dc = CONFIG.player.deathCam;
    if (!this.deathCam.active || this.deathCam.elapsed >= dc.time) {
      this.enterDeploy(Math.max(0, this.deathRespawnIn - dc.time));
    }
  }

  /**
   * The player's throw, at the moment the hand reaches full extension. It
   * leaves from the VIEWMODEL's throwing hand rather than from a point
   * measured off the eye, which is the difference between a grenade that was
   * thrown and one that was fired: the eye follows the same object out of the
   * same hand it watched cock back, off the camera's axis and on the off-hand
   * side, instead of finding it already in flight down the middle of the
   * screen on the frame the button went down.
   *
   * `handAhead` survives as a FLOOR on that point for the reason it was there
   * in the first place — a throw taken with a wall at your shoulder must not
   * spawn the grenade inside the wall, where its first act would be to bounce
   * back into your face. The extended hand clears it comfortably.
   *
   * The count is spent only once the pool has agreed to carry it: a grenade
   * debited for a throw that never happened is the most confusing thing this
   * feature could hand a player, which is why `Player` splits the release from
   * the booking. A refusal here costs the arm's cooldown and nothing else.
   */
  private releaseGrenade(): void {
    const g = CONFIG.grenade;
    const eye = this.cameraSys.camera.position;
    const forward = this.cameraSys.forward;
    this.grenadeHand.copyFrom(this.player.throwHandWorld());
    const ahead =
      (this.grenadeHand.x - eye.x) * forward.x +
      (this.grenadeHand.y - eye.y) * forward.y +
      (this.grenadeHand.z - eye.z) * forward.z;
    if (ahead < g.handAhead) {
      const d = g.handAhead - ahead;
      this.grenadeHand.addInPlaceFromFloats(
        forward.x * d,
        forward.y * d,
        forward.z * d,
      );
    }
    if (
      !this.grenades.throwAlong(
        this.grenadeHand,
        forward,
        this.player.team,
        this.player,
      )
    ) {
      return;
    }
    this.player.spendGrenade();
    // Networked: the authority throws its own copy and owns the blast. The
    // local one above still flies — it is what the thrower watches arc — but
    // it hurts nobody, because `hittablesFor` is wired to `battle`, and in a
    // netplay round that list is empty: the local bot pool is reset dead and
    // never stepped. A bullet is given the roster's bodies instead
    // (`enemyTargets`) because a shot owes the shooter an immediate tracer and
    // hitmarker; a blast owes nothing of the kind — its light, noise and
    // concussion all arrive on the server's `explode` event — so pointing this
    // at them would buy a line-of-sight ray per body within the radius and
    // nothing else. The pouch is the server's count too; spending here only
    // keeps the HUD honest.
    this.net?.sendGrenade(this.grenadeHand, this.cameraSys.forward);
    this.sfx.grenadeThrow();
    // The body's own follow-through, through the spring the landing and the
    // blast concussion already share — one integrator on the eye, never a
    // shake of its own.
    this.cameraSys.land(g.throwShake);
  }

  /**
   * Camera & rendering support. This tail order is LOAD-BEARING: light slot
   * selection, the shader's fog, and audio panning all key off the camera
   * position, so anything that moves the camera must run before them:
   * aim assist -> camera update -> shadows (window, blobs, outline thinning)
   * -> carried lights -> lighting.update() -> water.update() -> grass.update()
   * -> sfx.setListener(), and then `tick` pushes the shader's eye for every
   * state on the way into the render.
   * Nothing after this method may move the camera.
   */
  private updateCameraAndLighting(dt: number): void {
    // Aim assist reads last frame's aim and this frame's enemy list (consumed
    // synchronously — the battle scratch array is safe to pass), and is inert
    // unless the player is looking with a gamepad stick. It takes the EYE
    // rather than the rendered camera on purpose: its tracking term
    // differences the target's direction frame to frame, and the camera's bob
    // would land in that difference as a shake. It also takes the camera's
    // current full-stick turn rate, which is what bounds the assist below the
    // player's own look speed at every optic.
    const assist = this.aimAssist.update(
      dt,
      this.input,
      this.player.eyePos,
      this.cameraSys.forwardToRef(this.aimForward),
      this.cameraSys.aimYaw,
      this.cameraSys.aimPitch,
      this.cameraSys.stickYawRate,
      this.enemyTargets(),
    );
    // First person: the camera goes to the eye the bots shoot at, so what a
    // bot can see of you is exactly what you can see of it.
    this.cameraSys.update(dt, this.input, this.player.eyePos, assist);
    // Shadows follow the player (biased a little along the view so the
    // window covers what's ahead); outline ink thins with the same camera.
    // From the body's CENTRE, not its feet: the shadow window is placed around
    // this point and it should sit in the middle of the body it follows.
    this.shadowFocus
      .copyFrom(this.player.center)
      .addInPlace(this.cameraSys.forwardToRef(this.shadowForward).scaleInPlace(8));
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
   *
   * The shader's own eye is deliberately NOT here. It is the one thing in this
   * list a state that simulates nothing still owes, so `tick` pushes it for
   * every state instead — see the call above `scene.render()`.
   */
  private updateSceneForCamera(
    dt: number,
    shadowFocus: Vector3,
    player: Player | null,
    pushers: readonly Combatant[],
  ): void {
    this.shadows.update(shadowFocus, this.mats);
    if (player) {
      this.shadows.updateBlobs(
        player,
        this.battle.bots,
        this.cameraSys.camera.position,
        player.floorY,
      );
    }
    updateOutlineScales(this.cameraSys.camera.position);
    if (player) {
      const lc = CONFIG.lighting;
      // The map decides whether the player carries a lamp at all. A carried
      // light always wins one of the sixteen slots, so a daylight map leaving
      // it on does not merely add nothing — it costs a lantern somewhere.
      const lampIntensity =
        this.mapDef.environment.lighting.lampIntensity ?? lc.lampIntensity;
      if (lampIntensity > 0) {
        this.lighting.setCarried(
          "player-lamp",
          // Above the body's CENTRE. `lampHeight` is measured from there — a
          // lamp is carried, so it rides the chest and drops with a crouch
          // rather than being pinned to the ground the player stands on.
          this.lampPos.set(
            player.center.x,
            player.center.y + lc.lampHeight,
            player.center.z,
          ),
          lc.lampColor,
          lc.lampRange,
          lampIntensity,
        );
      } else {
        this.lighting.removeCarried("player-lamp");
      }
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
    this.sfx.setListener(
      this.cameraSys.camera.position,
      this.cameraSys.forwardToRef(this.listenerForward),
    );
  }

  /**
   * Pushes this frame's state to the DOM HUD and the minimap.
   *
   * `dying` is the death cam's frame: the gauges are still true and still
   * wanted (the round is live, and watching the tickets while you wait is half
   * the point of showing it at all), but everything about AIMING has stopped
   * being. The crosshair, the capture panel and the arcs are the three the cam
   * has to switch off, and each is off for its own reason rather than because
   * the state changed — see below.
   */
  private updateHud(dt: number, dying = false): void {
    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setAmmo(this.player.ammo, this.player.magSize, this.player.reloading);
    this.hud.setStowedAmmo(this.player.slungAmmo, this.player.slungMagSize);
    this.hud.setGrenades(this.player.grenades, CONFIG.grenade.carried);
    if (!dying) {
      // The crosshair ring IS the live spread: radians at the aim plane,
      // projected through the current FOV into screen pixels. Skipped rather
      // than merely hidden while dying — there is no weapon being aimed, so
      // there is no spread to project.
      const spreadPx =
        (Math.tan(this.player.spread(this.cameraSys.adsBlend)) /
          Math.tan(this.cameraSys.camera.fov / 2)) *
        (this.viewportHeight / 2);
      this.hud.setCrosshair(this.cameraSys.adsBlend, spreadPx);
    }
    // Damage arcs are world-anchored, so they need this frame's aim yaw to be
    // re-projected onto the screen — pushed here like every other HUD input.
    this.hud.setViewYaw(dying ? this.deathCam.yaw : this.cameraSys.aimYaw);
    this.hud.setTickets(
      [CONFIG.teams[0].name, CONFIG.teams[1].name],
      this.conquest.tickets,
      this.player.team,
    );
    this.hud.setFlags(this.conquest.points, this.player.team);
    // Null while dying: `captureStatus` asks which zone the PLAYER is standing
    // in, and a body on the ground is not standing in one — a panel counting a
    // capture nobody is contributing to is worse than no panel.
    this.hud.setCapture(dying ? null : this.captureStatus());
    this.hud.setLockHint(!this.input.pointerLocked && !this.input.gamepadConnected);
    this.minimap.update(
      dt,
      this.player.position,
      // The cam's own bearing, so the map keeps agreeing with the picture
      // above it while the camera orbits away from the player's last heading.
      dying ? this.deathCam.yaw : this.cameraSys.yaw,
      this.conquest.points,
      this.mapBodies(),
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
    // The single funnel for "the death cam's job is over", so every path out
    // of it — the clock running down, the round ending, F2 — retires the body
    // and hands the rig back without any of them remembering to. Idempotent,
    // and a no-op for the deploy that starts a round.
    this.deathCam.stop();
    this.hud.setDeathCam(false);
    this.minimap.setVisible(false);
    // `updateGameplay` stops here, so the viewmodel would freeze mid-pose in
    // front of a dead player's last view. In third person the body simply
    // stood where it fell; a rifle stuck to the camera has to be put away.
    this.player.setBodyHidden(true);
    this.hud.clearDamageDirections();
    // updateHud stops running outside `playing`, so the panel has to be told
    // to go — otherwise the zone the player died in stays on screen. The
    // SCOREBOARD is deliberately not told anything here: it is pushed from
    // `tick` in every state that has a round behind it, and this screen is one
    // of them — a player waiting out a reinforcement is exactly who wants it.
    this.hud.setCapture(null);
    if (this.map) this.deployScreen.show(this.map, this.conquest, this.player.team);
    this.deployScreen.update(this.respawnT);
    this.state = "deploy";
    document.exitPointerLock();
  }

  private endRound(winner: Team): void {
    this.state = "roundover";
    // The round can end on a frame the death cam is up — a squad taking the
    // last flag while the player watches their own body — and the result card
    // is not somewhere a corpse follows them to.
    this.deathCam.stop();
    this.hud.setDeathCam(false);
    this.deployScreen.hide();
    this.player.setBodyHidden(true); // same reason as enterDeploy
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
    this.overlayScreen.showRoundOver(
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
    // The blow itself, on the aim rather than on the picture. Skipped on the
    // frame that killed you: `enterDying` hands the camera to `DeathCam` a
    // few lines below, and a flinch on a body nobody is looking through is
    // state left behind for the next life to inherit.
    if (!died) {
      const pc = CONFIG.player;
      this.cameraSys.addFlinch(
        amount * pc.flinchPitchPerDamage,
        (Math.random() * 2 - 1) * amount * pc.flinchYawPerDamage,
      );
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
      // Our own row's death, offline: the victim's door, and the bot that shot
      // us was credited at its own by `battle.onBotKill`.
      this.playerDeaths += 1;
      this.hud.addKill(
        CONFIG.teams[1 - this.player.team].name,
        "YOU",
        true,
      );
      this.enterDying(from, amount);
    }
  }

  /**
   * Raises the death cam: a stand-in body where the player was standing, thrown
   * by the round that killed them, and the camera out of the head to watch it.
   *
   * The pointer lock is deliberately KEPT. There is nothing to click for four
   * seconds, and dropping it would trip the lock-loss pause on the very frame
   * the shot begins — pausing the thing the player was about to be shown.
   * `enterDeploy` is still what releases it, one state later.
   *
   * If the cam cannot come up at all — no rig, which means no round has started
   * — this falls straight through to the deploy screen at the full delay. A
   * state whose exit condition is a clock that never starts is a game that
   * never respawns you, and that is the one failure here worth spelling out.
   *
   * `respawnIn` is how long this life owes before the next one, and it is a
   * parameter rather than the config constant because in a networked round the
   * clock is the SERVER's. It happens to be the same number today — both sides
   * read `conquest.respawnDelay` — and the point of taking it here is that
   * nothing breaks quietly on the day one of them stops.
   */
  private enterDying(
    from: Vector3 | undefined,
    amount: number,
    // Annotated, because `CONFIG` is `as const` and the bare default would give
    // this parameter the literal type `8` — see the convention in CLAUDE.md.
    respawnIn: number = CONFIG.conquest.respawnDelay,
  ): void {
    this.deathRespawnIn = respawnIn;
    this.deathFeet.set(
      this.player.position.x,
      this.player.floorY,
      this.player.position.z,
    );
    this.deathCam.start(
      this.deathFeet,
      this.cameraSys.yaw,
      this.cameraSys.camera.position,
      this.cameraSys.forward,
      from,
      amount,
    );
    if (!this.deathCam.active) {
      this.enterDeploy(respawnIn);
      return;
    }
    // The weapon is parented to the camera, so it would ride the cam out of
    // the head and hang in front of the body — the same reason `enterDeploy`
    // puts it away, arriving one state earlier.
    this.player.setBodyHidden(true);
    // Anything on the HUD that is about aiming is now a lie: there is no
    // crosshair to believe and the damage arcs are anchored to a view yaw that
    // has stopped being the player's.
    this.hud.setDeathCam(true);
    this.hud.clearDamageDirections();
    this.state = "dying";
  }

  /**
   * A bot went down: the sound, the ticket, its line on the board and the
   * killfeed.
   *
   * One method rather than three copies because there are now three ways to
   * kill one — a bot's rifle, the player's rifle, and either side's grenade —
   * and they disagree about nothing except whose name goes on the line.
   * `byPlayer` is what separates the player's own kill from their team's, and
   * it is the only thing the three callers pass differently.
   *
   * This is the VICTIM's door, so it counts the death and not the kill: the
   * killer is credited by `creditKill` at whichever call site actually knows
   * who they were. Every caller here raises both, one line apart.
   *
   * Deliberately NOT the hitmarker or the rumble: those are about the shot
   * that landed rather than the body that fell, and they belong with whichever
   * weapon put it there.
   */
  private registerBotKill(bot: Bot, killer: Team, byPlayer: boolean): void {
    // The one place all three ways a bot can die converge, so the one place
    // the body has to be offered to the physics pool. It needs no impact
    // vector passed down: `Bot.takeDamage` already captured where the killing
    // blow came from, which every damage path in the game hands it.
    this.ragdolls.spawn(bot, this.cameraSys.camera.position);
    this.sfx.enemyDie();
    this.conquest.registerDeath(bot.team);
    const slot = this.battle.bots.indexOf(bot);
    if (slot >= 0) this.botDeaths[slot] = (this.botDeaths[slot] ?? 0) + 1;
    this.hud.addKill(
      byPlayer ? "YOU" : CONFIG.teams[killer].name,
      CONFIG.teams[bot.team].name,
      byPlayer,
    );
  }

  /**
   * The scoreboard, pushed once per frame from `tick` in EVERY state that has a
   * round behind it — playing, the death cam, and the deploy screen.
   *
   * It is here rather than in `updateHud` for the reason `mats.updateCamera` is
   * in `tick`: `updateHud` runs while you are alive and holding a weapon, and
   * this panel is owed to two states that are neither. **The deploy screen is
   * where a player most wants it** — it is the one screen in the game you sit
   * on while the round carries on without you, for a reinforcement clock's
   * worth of every death in a match, and it is where you decide where to come
   * back in. A board that goes dark exactly then is dark for a good share of
   * the round.
   *
   * The state test is `this.state` and deliberately not `stateUnderLids`: a lid
   * is a screen the player ASKED for and put in front of the round, so the
   * board goes away under one — which also means nothing has to remember to
   * hide it. That is the whole reason this is a per-frame push rather than a
   * call at each boundary: the six ways out of a round (deploying, dying, the
   * round ending, a pause, the kit screen, the menu) each used to owe a
   * `setScoreboard(false)`, and the one that forgot would leave last round's
   * numbers hanging over the next screen.
   *
   * Assembled only while the board is actually up: the payload is an object
   * and three arrays, and `flagsHeld` counts the control points twice.
   */
  private pushScoreboard(): void {
    const inRound =
      this.state === "playing" ||
      this.state === "dying" ||
      this.state === "deploy";
    if (!inRound || !this.input.scoreboard) {
      this.hud.setScoreboard(false);
      return;
    }
    const rows = this.scoreRows();
    // The team totals are SUMMED from the rows rather than counted beside
    // them, so the header and the columns under it cannot disagree — one
    // number that is wrong and one that is right is worse than two that are
    // wrong together, because nothing on screen shows which is which.
    const kills: [number, number] = [0, 0];
    const deaths: [number, number] = [0, 0];
    for (const r of rows) {
      kills[r.team] += r.kills;
      deaths[r.team] += r.deaths;
    }
    this.hud.setScoreboard(true, {
      map: this.mapDef.name,
      teams: [CONFIG.teams[0].name, CONFIG.teams[1].name],
      tickets: this.conquest.tickets,
      flags: [this.conquest.flagsHeld(0), this.conquest.flagsHeld(1)],
      kills,
      deaths,
      playerTeam: this.player.team,
      rows,
    });
  }

  /**
   * One row per body in the round, for the scoreboard.
   *
   * **The two sources meet HERE and nowhere else.** Offline the board is this
   * client's own — the player's two numbers plus a line per bot in the pool.
   * In a match it is the authority's, read off the session: a slot's name from
   * the roster, its kills and deaths from the last `scores` message, and the
   * row order straight from the roster, because a slot index is the same number
   * on both sides of the wire and on both sides of this branch.
   *
   * A bot's name is DERIVED rather than sent (`callsign`), which is what keeps
   * "a bot and a person are the same body on screen" true while still letting
   * this one screen tell them apart: nothing about the row changes how anything
   * is drawn, and the server spends no bandwidth naming sixteen bodies that
   * already have a number each.
   *
   * Assembled only while Tab is held — see the caller.
   */
  private scoreRows(): ScoreRow[] {
    const rows: ScoreRow[] = [];
    if (this.net) {
      for (const slot of this.net.slots) {
        const occupant = slot.occupant;
        rows.push({
          name:
            occupant.kind === "human" ? occupant.name : callsign(slot.index),
          team: slot.team,
          kills: this.net.slotKills[slot.index] ?? 0,
          deaths: this.net.slotDeaths[slot.index] ?? 0,
          you: slot.index === this.net.slot,
        });
      }
      return rows;
    }
    // Offline the player is not in the pool — they are the seventeenth body in
    // a sixteen-bot round — so their line is pushed rather than found.
    rows.push({
      name: "YOU",
      team: this.player.team,
      kills: this.playerKills,
      deaths: this.playerDeaths,
      you: true,
    });
    for (let i = 0; i < this.battle.bots.length; i++) {
      rows.push({
        name: callsign(i),
        team: this.battle.bots[i].team,
        kills: this.botKills[i] ?? 0,
        deaths: this.botDeaths[i] ?? 0,
        you: false,
      });
    }
    return rows;
  }

  /**
   * Somebody put a body down: one kill on their own row, OFFLINE.
   *
   * **The kill is counted at the killer's door and the death at the victim's,
   * once each**, because the two are known in different places. Every death in
   * the game already arrives somewhere — `registerBotKill` for a bot,
   * `onPlayerDamaged` for the player — while who fired is known only to
   * whatever pulled the trigger, and a single door would mean one of the two
   * inventing the half it cannot see. It is also what lets a bot be credited
   * for killing the PLAYER, which no bot-shaped kill callback could carry.
   *
   * Silent in a netplay round by the same rule that empties every other local
   * count there: the board is the authority's, this is only ever the offline
   * one, and a kill is credited to a bot the server is not simulating. Nothing
   * gates it — the callers that could fire in a match are the ones whose local
   * `takeDamage` returns false, so no kill is ever raised to be counted.
   */
  private creditKill(by: Combatant | null): void {
    if (by === this.player) {
      this.playerKills += 1;
      return;
    }
    const slot = by instanceof Bot ? this.battle.bots.indexOf(by) : -1;
    // `?? 0` rather than a bare increment, for the reason the authority's copy
    // takes the same care: the rows are sized at the round's build, and one
    // that is somehow not there yet starts at one rather than at `NaN`, which
    // would spread through the team totals on the way to the screen.
    if (slot >= 0) this.botKills[slot] = (this.botKills[slot] ?? 0) + 1;
  }

  /**
   * A grenade went off. The light, the noise and the concussion — none of
   * which the grenade system may reach on its own, which is why they arrive
   * here as one event with a position on it.
   *
   * The light is deliberately outside `spendMuzzleLightBudget`. Transients
   * always win a shader slot, and the budget exists because sixteen bots firing
   * is up to eighty flashes a second; there are seconds between blasts, so one
   * slot each is never what blacks the village out.
   *
   * The camera's concussion reuses `land()` rather than growing a shake of its
   * own: the eye taking a pressure wave and the eye taking a landing are the
   * same damped spring, and the alternative is a second integrator writing the
   * same offset — the trap the bob phase documents from the other side. It
   * falls off over twice the blast radius, so a grenade you survived at the
   * edge still registers as one. What it does NOT reuse is the punch's
   * direction: `addPunch` takes one, so the shove is thrown away from where
   * the blast actually was rather than being the same nudge every time.
   */
  private onExplosion(at: Vector3): void {
    const lc = CONFIG.lighting;
    this.lighting.pulse(
      at,
      lc.explosionColor,
      lc.explosionRange,
      lc.explosionIntensity,
      lc.explosionLife,
    );
    this.sfx.explosion(at);
    if (this.state !== "playing") return;
    const g = CONFIG.grenade;
    const reach = g.blastRadius * 2;
    const d = Vector3.Distance(at, this.cameraSys.camera.position);
    if (d >= reach) return;
    this.cameraSys.land(g.shakeSpeed * (1 - d / reach));
    // Which side it went off, as the punch's drift: the sign of the blast's
    // bearing across the view. A grenade behind a shoulder throws the view the
    // other way, which is free here because the punch already takes a
    // direction for the gun and a pressure wave has one just as much.
    const right = this.cameraSys.flatRight;
    const bearing = (at.x - this.cameraSys.camera.position.x) * right.x +
      (at.z - this.cameraSys.camera.position.z) * right.z;
    this.cameraSys.addPunch(d > 0.001 ? -bearing / d : 0);
    const haptic = CONFIG.rumble;
    this.input.rumble(haptic.hurtStrong, haptic.hurtWeak, haptic.hurtMs);
  }

  /**
   * The surface something at (x, z) would be STANDING on, resolved nearest the
   * height `near` — the drawn terrain, or a deck or slab above it.
   *
   * The same pair of questions `CaptureZoneSystem` asks to lay a ring on the
   * ground, and asked here for the same reason: the terrain alone buries
   * anything on a boathouse deck or a paved square, and the nav graph alone
   * has nothing to say about the stretches nothing walks on. `surfaceAt(...,
   * true)` is the upper envelope, because the floor is flat triangles across a
   * bilinear field and the smooth value sits under the mesh on a twisted cell.
   */
  private standableAt(x: number, z: number, near: number): number {
    if (!this.map) return near;
    const floor = this.map.terrain.surfaceAt(x, z, true);
    const surface = this.map.nav.surfaceAt(x, near, z);
    return surface < 0 ? floor : Math.max(floor, this.map.nav.heightOf(surface));
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
