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
import { EditorGizmos } from "./gizmos";
import { EditorPanel } from "./EditorPanel";
import { inspect } from "./inspect";
import {
  applyTransform,
  isRotatable,
  originOf,
  quantize,
  rebuildNavigation,
  repositionScene,
  rotationOf,
} from "./mutate";
import { NavOverlay } from "./navOverlay";
import { ProxyLayer } from "./proxies";
import { LayoutSaver } from "./save";
import { validate, type Finding } from "./validate";
import { pickRef, sameRef, SelectionHighlight, type SelectionRef } from "./selection";
import { workLightEnvironment } from "./workLight";

/** Everything the editor borrows from Game. */
export interface EditorDeps {
  canvas: HTMLCanvasElement;
  camera: FreeCamera;
  input: InputManager;
  scene: Scene;
  glow: GlowLayer;
  /** The map as currently built — an editor build, so it carries `editor`. */
  map: GameMap;
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

  constructor(private deps: EditorDeps) {
    this.cam = new EditorCamera(deps.camera, deps.canvas);
    this.panel = new EditorPanel();
    this.panel.setVisible(true);
    this.proxies = new ProxyLayer(deps.scene, deps.glow);
    this.proxies.build(deps.map);
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
      if (e.code === "KeyL") {
        this.workLight = !this.workLight;
        this.applyLighting();
      } else if (e.code === "Escape") {
        this.select(null);
      } else if (e.code === "KeyN") {
        // Building the overlay is the expensive half, so it is only built the
        // first time it is asked for, then kept in step with navigation.
        const on = !this.navOverlay.isVisible;
        if (on) this.navOverlay.build(this.deps.map, this.fieldForOverlay());
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
    this.panel.setInspector(view.title, view.rows);
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
    repositionScene(this.deps.map, ref, at, rotY);
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
    const { map, layout } = this.deps;
    const fresh = rebuildNavigation(map, layout);
    map.nav = fresh.nav;
    map.obstacles = fresh.obstacles;
    this.revalidate();
    if (this.navOverlay.isVisible) {
      this.navOverlay.build(map, this.fieldForOverlay());
      this.navOverlay.setVisible(true);
      this.panel.setNavOverlay(true, this.navOverlay.counts());
    }
  }

  /**
   * Re-runs the checks and pushes them to the panel. Cheap next to the
   * navigation rebuild that precedes it, so it just runs every time.
   */
  private revalidate(): void {
    const { map, layout, fixtures } = this.deps;
    this.findings = validate(map, layout, fixtures);
    this.panel.setNav(map.nav.walkableCount);
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
    this.proxies.build(this.deps.map);
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
    const index = this.deps.map.editor;
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
