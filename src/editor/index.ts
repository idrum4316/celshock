/**
 * editor/index.ts — The map editor's entry point and the only module Game
 * knows about.
 * Owns: the editor session lifetime — what exists while the editor is open and
 * what is torn down when it closes.
 *
 * Game reaches this through a dynamic import behind an import.meta.env.DEV
 * gate. That is deliberate and load-bearing: a static import would keep every
 * editor module in the production bundle even with the branch eliminated.
 * Nothing in src/editor/ may be imported statically from src/core, src/world,
 * src/systems or src/entities.
 *
 * The editor borrows the running scene rather than building its own — same
 * materials, same lighting, same grade — so what you author is what you play.
 */
import type { FreeCamera, GlowLayer, Mesh, Scene } from "@babylonjs/core";
import { Vector3 } from "@babylonjs/core";
import type { InputManager } from "../core/InputManager";
import type { EnvironmentSpec } from "../world/environment";
import type { MapLayout } from "../world/layout";
import type { GameMap } from "../world/MapBuilder";
import { EditorCamera } from "./EditorCamera";
import type { FieldValue } from "./fields";
import { EditorGizmos } from "./gizmos";
import { EditorPanel, type AddGroup } from "./EditorPanel";
import { inspect } from "./inspect";
import {
  addItem,
  applyTransform,
  deleteItem,
  isRotatable,
  originOf,
  quantize,
  rebuildNavigation,
  repositionScene,
  rotationOf,
  setField,
  tierFor,
  type Tier,
} from "./mutate";
import { NavOverlay } from "./navOverlay";
import { BUILDER_KINDS, SCATTER_PROPS } from "./params";
import { ProxyLayer } from "./proxies";
import { LayoutSaver } from "./save";
import { EDITOR } from "./tuning";
import { validate, type Finding } from "./validate";
import {
  pickRef,
  sameRef,
  SelectionHighlight,
  type SelectionList,
  type SelectionRef,
} from "./selection";
import { workLightEnvironment } from "./workLight";

/** What the add menu offers, and which layout list each entry lands in. */
const ADD_GROUPS: AddGroup[] = [
  { list: "placements", label: "structure", choices: [...BUILDER_KINDS] },
  { list: "scatter", label: "scatter field", choices: [...SCATTER_PROPS] },
  { list: "water", label: "water rect", choices: [] },
  { list: "grass", label: "grass rect", choices: [] },
  { list: "spawns", label: "spawn point", choices: [] },
  { list: "controlPoints", label: "control point", choices: [] },
];

/** True while the keyboard belongs to an inspector control, not the editor. */
function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

/** Everything the editor borrows from Game. */
export interface EditorDeps {
  canvas: HTMLCanvasElement;
  camera: FreeCamera;
  input: InputManager;
  scene: Scene;
  glow: GlowLayer;
  /** The map as currently built — an editor build, so it carries `editor`. */
  map: GameMap;
  /**
   * Disposes the current map and builds a fresh one from the (edited) layout,
   * re-pointing everything Game owns that caches it — shadow casters, water,
   * grass. Returns the new map.
   *
   * This is the editor's third rebuild tier and the expensive one (~570 ms
   * measured headless). It is the only correct answer to a param change, a new
   * entry or a deleted one: those change how many colliders an item emits,
   * which shifts every later index in `colliderBoxes` and invalidates the
   * per-item editor index wholesale.
   */
  rebuildMap: () => GameMap;
  /** The layout that map was built from. Edited in place by the editor. */
  layout: MapLayout;
  /** The map's own environment, so the work light can be derived from it. */
  environment: EnvironmentSpec;
  /** Registered static fixtures, for the 16-slot light-cluster check. */
  fixtures: readonly { position: Vector3 }[];
  /**
   * Pushes an environment into the scene. Game owns the scene and materials;
   * the editor only ever asks for a spec to be applied.
   */
  applyEnvironment: (env: EnvironmentSpec) => void;
  /**
   * Re-renders the shadow depth pass. It normally re-renders only when the
   * shadow window moves, which is right for a static map and wrong the moment
   * a caster is dragged.
   */
  invalidateShadows: () => void;
}

/**
 * A live editing session. Game drives `update` each frame while its state is
 * "editor" and calls `dispose` on the way out.
 */
export class EditorSession {
  private cam: EditorCamera;
  private panel: EditorPanel;
  private workLight = true;
  private proxies: ProxyLayer;
  private highlight = new SelectionHighlight();
  private gizmos: EditorGizmos;
  private selected: SelectionRef | null = null;
  private dirty = false;
  private saver: LayoutSaver;
  private saving = false;
  private navOverlay: NavOverlay;
  private findings: Finding[] = [];
  private readonly detach: () => void;
  /**
   * The current map. Held here rather than read from `deps` because a param
   * change replaces it wholesale, and everything in this file that reaches for
   * geometry must see the map that is actually in the scene.
   */
  private map: GameMap;
  /** Coalesces the rebuild a run of typed characters would otherwise trigger. */
  private pending: Tier | null = null;
  private timer = 0;

  constructor(private deps: EditorDeps) {
    this.map = deps.map;
    this.cam = new EditorCamera(deps.camera, deps.canvas);
    this.panel = new EditorPanel();
    this.panel.setVisible(true);
    this.panel.setAddMenu(ADD_GROUPS, (list, choice) => this.onAdd(list, choice));
    this.proxies = new ProxyLayer(deps.scene, deps.glow);
    this.proxies.build(this.map);
    this.proxies.buildScatter(deps.layout.scatter);
    this.gizmos = new EditorGizmos(deps.scene, {
      onChange: (at, rotY) => this.onDrag(at, rotY),
      onCommit: () => this.onDragEnd(),
    });
    // On by default: the first thing anyone opening the editor wants is to see
    // the map. Toggle it off to check how a placement actually reads at night.
    this.applyLighting();
    this.select(null);

    this.navOverlay = new NavOverlay(deps.scene, deps.glow);
    this.revalidate();
    this.saver = new LayoutSaver(deps.layout);
    if (this.saver.blocked) {
      this.panel.setStatus(`cannot save: ${this.saver.blocked}`, "error");
    } else {
      this.panel.setStatus("ready", "idle");
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
        // The browser's own save dialog is never what anyone wants here.
        e.preventDefault();
        void this.save();
        return;
      }
      // Every shortcut below is a bare letter, so an inspector control that
      // has focus must swallow them or typing a name into a flag would toggle
      // the nav overlay and the work light on the way past.
      if (isTyping(e)) {
        if (e.code === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      if (e.code === "Delete" || e.code === "Backspace") {
        e.preventDefault();
        this.onDelete();
        return;
      }
      if (e.code === "KeyL") {
        this.workLight = !this.workLight;
        this.applyLighting();
      } else if (e.code === "Escape") {
        this.select(null);
      } else if (e.code === "KeyN") {
        // Building the overlay is the expensive half, so it is only built the
        // first time it is asked for, then kept in step with navigation.
        const on = !this.navOverlay.isVisible;
        if (on) this.navOverlay.build(this.map, this.fieldForOverlay());
        this.navOverlay.setVisible(on);
        this.panel.setNavOverlay(on, this.navOverlay.counts());
      }
    };
    // Left button only, and only when the camera is not being flown — the
    // right button owns look, so the two can never race for the same drag.
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || document.pointerLockElement) return;
      if ((e.target as HTMLElement)?.closest("#editor-panel")) return;
      // A click that started on a gizmo handle is a drag, not a reselect.
      if (this.gizmos.isDragging) return;
      this.select(pickRef(this.deps.scene, e.clientX, e.clientY));
    };
    document.addEventListener("keydown", onKeyDown);
    this.deps.canvas.addEventListener("pointerdown", onPointerDown);
    this.detach = () => {
      document.removeEventListener("keydown", onKeyDown);
      this.deps.canvas.removeEventListener("pointerdown", onPointerDown);
    };
  }

  /** The current selection, or null. */
  get selection(): SelectionRef | null {
    return this.selected;
  }

  private select(ref: SelectionRef | null): void {
    if (sameRef(ref, this.selected)) return;
    this.selected = ref;
    this.highlight.show(this.meshesFor(ref));
    this.refreshInspector();
    if (ref) {
      this.gizmos.setRotatable(isRotatable(ref));
      this.gizmos.attachTo(
        originOf(this.deps.layout, ref),
        rotationOf(this.deps.layout, ref),
      );
    } else {
      this.gizmos.attachTo(null);
    }
  }

  private refreshInspector(): void {
    const view = inspect(this.deps.layout, this.selected);
    this.panel.setInspector(
      view.title,
      view.fields,
      view.deletable
        ? {
            onChange: (key, value) => this.onField(key, value),
            onDelete: () => this.onDelete(),
          }
        : null,
    );
  }

  /**
   * One inspector control was used. The layout is written immediately — it is
   * the source of truth and the inspector must never show something the data
   * does not say — and the rebuild it implies is deferred, so holding an arrow
   * key on a spinner does not queue thirty map builds.
   */
  private onField(key: string, value: FieldValue): void {
    const ref = this.selected;
    if (!ref) return;
    setField(this.deps.layout, ref, key, value);
    this.dirty = true;
    this.refreshInspector();
    // Typing a coordinate has to move the handles too, or the next drag snaps
    // the item back to where the gizmo still thinks it is.
    this.gizmos.attachTo(
      originOf(this.deps.layout, ref),
      rotationOf(this.deps.layout, ref),
    );
    this.schedule(tierFor(ref.list));
  }

  /** Appends a new entry at the view centre and selects it. */
  private onAdd(list: string, choice: string): void {
    const at = this.placementPoint();
    const ref = addItem(this.deps.layout, list as SelectionList, choice, at);
    if (!ref) {
      this.panel.setStatus(`cannot add to ${list}`, "error");
      return;
    }
    this.dirty = true;
    this.panel.setStatus(`added ${choice || list} at the view centre`, "ok");
    this.applyStructural(ref.list, ref);
  }

  /** Deletes the selection. Indices shift, so the selection is dropped. */
  private onDelete(): void {
    const ref = this.selected;
    if (!ref) return;
    const what = inspect(this.deps.layout, ref).title || ref.list;
    if (!deleteItem(this.deps.layout, ref)) return;
    this.dirty = true;
    this.panel.setStatus(`deleted ${what}`, "ok");
    this.applyStructural(ref.list, null);
  }

  /**
   * Where a newly added item goes: whatever the view centre is pointing at.
   *
   * Picks against colliders rather than visuals, so a new building lands on
   * the terrace top or the road in front of you rather than on the roof shell
   * between you and it. With nothing under the crosshair it falls back to the
   * ground plane, and to a fixed distance ahead when the view is level or up.
   *
   * The height then comes from the NAV GRID rather than from the pick. Look at
   * the side of a barn and the pick lands halfway up a wall; a placement's `y`
   * is its base, so writing that would put the new item in mid-air and demand
   * a correction before anything else could be judged. Asking the grid what
   * can stand at that spot gives the same answer a bot would.
   */
  private placementPoint(): Vector3 {
    const { scene, canvas, camera } = this.deps;
    const hit = scene.pick(
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
      (m) => m.metadata?.solid === true,
    );

    let at: Vector3;
    if (hit?.hit && hit.pickedPoint) {
      at = hit.pickedPoint.clone();
    } else {
      const dir = this.cam.forward;
      const ground = dir.y < -0.05 ? -camera.position.y / dir.y : Infinity;
      at = camera.position.add(dir.scale(Math.min(Math.max(ground, 4), 120)));
      at.y = Math.max(0, at.y);
    }

    const surface = this.map.nav.surfaceAt(at.x, at.y, at.z);
    if (surface >= 0) at.y = this.map.nav.heightOf(surface);
    return at;
  }

  /**
   * An entry was added or removed: the rebuild happens now rather than on the
   * debounce, because a structural change is a single deliberate action and
   * leaving the scene disagreeing with the layout even briefly is confusing.
   */
  private applyStructural(list: SelectionList, select: SelectionRef | null): void {
    window.clearTimeout(this.timer);
    this.pending = null;
    if (tierFor(list) === "geometry") this.rebuildGeometry(select);
    else this.rebuildRouting(select);
  }

  /** Coalesces rebuilds; the heavier tier wins when both are asked for. */
  private schedule(tier: Tier): void {
    this.pending = this.pending === "geometry" ? "geometry" : tier;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      const due = this.pending;
      this.pending = null;
      if (due === "geometry") this.rebuildGeometry(this.selected);
      else if (due === "navigation") this.rebuildRouting(this.selected);
    }, EDITOR.rebuildDelay);
  }

  /**
   * Tier 3: the whole map. Everything the editor holds that points at geometry
   * is invalidated by this — the per-item index, the collider boxes, the
   * highlight — so all of it is re-derived rather than patched.
   */
  private rebuildGeometry(select: SelectionRef | null): void {
    this.gizmos.attachTo(null);
    this.highlight.clear();
    this.selected = null;
    this.map = this.deps.rebuildMap();
    this.rebuildProxies();
    this.deps.invalidateShadows();
    this.select(select);
    this.afterNavigationChanged();
  }

  /**
   * Tier 2: flags and spawns produce no geometry, so only the flow fields and
   * the proxies standing in for them need redoing.
   */
  private rebuildRouting(select: SelectionRef | null): void {
    const fresh = rebuildNavigation(this.map, this.deps.layout);
    this.map.nav = fresh.nav;
    this.map.obstacles = fresh.obstacles;
    this.selected = null;
    this.rebuildProxies();
    this.select(select);
    this.afterNavigationChanged();
  }

  /** Re-runs the checks and the overlay against the navigation just built. */
  private afterNavigationChanged(): void {
    this.revalidate();
    if (this.navOverlay.isVisible) {
      this.navOverlay.build(this.map, this.fieldForOverlay());
      this.navOverlay.setVisible(true);
      this.panel.setNavOverlay(true, this.navOverlay.counts());
    }
  }

  /**
   * Every frame of a drag: the layout is written and the geometry follows it.
   * Navigation is deliberately left stale until the drag ends.
   */
  private onDrag(raw: Vector3, rawRotY: number): void {
    const ref = this.selected;
    if (!ref) return;
    // Quantise once, then use the same numbers for the data and the geometry.
    const { at, rotY } = quantize(raw, rawRotY);
    applyTransform(this.deps.layout, ref, at, rotY);
    repositionScene(this.map, ref, at, rotY);
    if (ref.list !== "placements" && ref.list !== "scatter") {
      // Proxies carry their own geometry; rebuild the cheap layer wholesale
      // rather than tracking which mesh stands for which field.
      this.rebuildProxies();
    }
    this.deps.invalidateShadows();
    this.refreshInspector();
    this.dirty = true;
  }

  /** Drag finished: bring navigation back into agreement with the geometry. */
  private onDragEnd(): void {
    const fresh = rebuildNavigation(this.map, this.deps.layout);
    this.map.nav = fresh.nav;
    this.map.obstacles = fresh.obstacles;
    this.afterNavigationChanged();
  }

  /**
   * Re-runs the checks and pushes them to the panel. Cheap next to the
   * navigation rebuild that precedes it, so it just runs every time.
   */
  private revalidate(): void {
    const { layout, fixtures } = this.deps;
    this.findings = validate(this.map, layout, fixtures);
    this.panel.setNav(this.map.nav.walkableCount);
    this.panel.setFindings(this.findings, (i) => this.goTo(i));
  }

  /** Routing is checked against whichever flag is selected, else flag A. */
  private fieldForOverlay(): string | null {
    const ref = this.selected;
    if (ref?.list === "controlPoints") {
      return this.deps.layout.controlPoints[ref.index]?.id ?? null;
    }
    return this.deps.layout.controlPoints[0]?.id ?? null;
  }

  /** Flies the camera to a finding and selects whatever it points at. */
  private goTo(index: number): void {
    const f = this.findings[index];
    if (!f) return;
    if (f.at) {
      // Stand off along -Z and above, so the spot is in frame rather than
      // inside the camera.
      this.cam.warpTo(
        new Vector3(f.at.x, f.at.y + 18, f.at.z - 22),
        0,
        -0.6,
      );
    }
    if (f.ref) this.select(f.ref);
  }

  private rebuildProxies(): void {
    this.proxies.dispose();
    this.proxies.build(this.map);
    this.proxies.buildScatter(this.deps.layout.scatter);
    // The highlight held meshes that have just been disposed.
    this.highlight.show(this.meshesFor(this.selected));
  }

  /** True when there are edits that have not been written to layout.ts. */
  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  /**
   * Writes the layout back to src/world/hollowmere/layout.ts through the dev
   * server. Entries nobody touched come back byte-identical, so the diff is
   * only what was actually edited.
   */
  async save(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.panel.setStatus("saving…", "busy");
    const result = await this.saver.save(this.deps.layout);
    this.saving = false;
    if (result.ok) this.dirty = false;
    this.panel.setStatus(result.message, result.ok ? "ok" : "error");
  }

  /**
   * The geometry belonging to a selection. Placements and scatter come from
   * the build's own index; everything else has proxy meshes instead, which the
   * proxy layer finds by the same ref.
   */
  private meshesFor(ref: SelectionRef | null): Mesh[] {
    if (!ref) return [];
    const index = this.map.editor;
    if (index && (ref.list === "placements" || ref.list === "scatter")) {
      return index[ref.list][ref.index]?.visuals ?? [];
    }
    return this.proxies.meshesFor(ref);
  }

  private applyLighting(): void {
    const env = this.deps.environment;
    this.deps.applyEnvironment(this.workLight ? workLightEnvironment(env) : env);
    this.panel.setWorkLight(this.workLight);
  }

  /**
   * Opens looking at `from` — normally the player's last position — rather
   * than snapping to the map origin, so entering the editor keeps your place.
   */
  warpTo(from: Vector3, yaw: number, pitch: number): void {
    this.cam.warpTo(from, yaw, pitch);
  }

  /** The view direction, for Game's shadow focus. */
  get forward(): Vector3 {
    return this.cam.forward;
  }

  update(dt: number): void {
    // Alt is read per frame rather than latched on keydown: a keyup that
    // lands while the window is unfocused would otherwise leave snapping off.
    this.gizmos.setFreeMode(this.deps.input.altHeld);
    this.cam.update(dt, this.deps.input);
    const p = this.deps.camera.position;
    this.panel.update(p.x, p.y, p.z, this.cam.flySpeed);
  }

  dispose(): void {
    // A rebuild fired after Game has torn the session down would build a map
    // nothing is holding and leave it in the scene.
    window.clearTimeout(this.timer);
    this.pending = null;
    this.detach();
    this.navOverlay.dispose();
    this.gizmos.dispose();
    this.highlight.clear();
    this.proxies.dispose();
    this.cam.dispose();
    this.panel.dispose();
    // Leaving restarts the round, which re-applies the map's own environment —
    // but restore it here too so the scene is never left work-lit if that
    // changes.
    this.deps.applyEnvironment(this.deps.environment);
  }
}

/** Constructed by Game's dynamic import; keeps the call site to one symbol. */
export function createEditor(deps: EditorDeps): EditorSession {
  return new EditorSession(deps);
}
