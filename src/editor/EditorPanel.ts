/**
 * editor/EditorPanel.ts — The editor's DOM overlay: title bar, live camera
 * readout, key help.
 * Owns: its own root element and every node inside it. Owns no editor state —
 * it is handed values and displays them.
 *
 * Follows the HUD/DeployScreen pattern: build the tree once from an innerHTML
 * template, cache the nodes that change, then only ever write textContent and
 * classList. Styling lives in index.html with the rest.
 *
 * The root is appended to #hud, which is pointer-events: none so gameplay
 * clicks fall through to the canvas — so the panel MUST re-enable
 * pointer-events on itself or none of its controls will ever be clickable.
 * #deploy does the same thing for the same reason.
 */

/** One read-only line in the inspector. */
export interface InspectorRow {
  label: string;
  value: string;
}

/** The subset of a validation finding the panel needs to render it. */
export interface PanelFinding {
  severity: "error" | "warning" | "info";
  text: string;
}

export class EditorPanel {
  private root: HTMLDivElement;
  private posEl: HTMLElement;
  private speedEl: HTMLElement;
  private workLightEl: HTMLElement;
  private navEl: HTMLElement;
  private statusEl: HTMLElement;
  private overlayEl: HTMLElement;
  private findingsEl: HTMLElement;
  private inspector: HTMLElement;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "editor-panel";
    this.root.className = "hidden";
    this.root.innerHTML = `
      <h2>MAP EDITOR</h2>
      <div class="ed-row"><span class="ed-key">pos</span><span id="ed-pos">—</span></div>
      <div class="ed-row"><span class="ed-key">speed</span><span id="ed-speed">—</span></div>
      <div class="ed-row"><span class="ed-key">work light</span><span id="ed-worklight">—</span></div>
      <div class="ed-row"><span class="ed-key">walkable</span><span id="ed-nav">—</span></div>
      <div class="ed-row"><span class="ed-key">nav overlay</span><span id="ed-overlay">off</span></div>
      <div class="ed-warn">editor build: ~10x the draw calls of play — never judge performance here</div>
      <div id="ed-status" class="ed-status idle">—</div>
      <div id="ed-inspector" class="ed-inspector"></div>
      <div id="ed-findings" class="ed-findings"></div>
      <div class="ed-help">
        <div><b>RMB</b> hold to look</div>
        <div><b>WASD</b> fly &nbsp; <b>Q/E</b> down/up</div>
        <div><b>Shift</b> boost &nbsp; <b>Wheel</b> speed</div>
        <div><b>LMB</b> select &nbsp; <b>Esc</b> deselect</div>
        <div><b>Alt</b> hold to place off-grid</div>
        <div><b>N</b> nav overlay &nbsp; <b>Ctrl+S</b> save</div>
        <div><b>L</b> work light &nbsp; <b>F2</b> back to the game</div>
      </div>
    `;
    document.getElementById("hud")!.appendChild(this.root);
    this.posEl = this.root.querySelector("#ed-pos")!;
    this.speedEl = this.root.querySelector("#ed-speed")!;
    this.workLightEl = this.root.querySelector("#ed-worklight")!;
    this.navEl = this.root.querySelector("#ed-nav")!;
    this.statusEl = this.root.querySelector("#ed-status")!;
    this.overlayEl = this.root.querySelector("#ed-overlay")!;
    this.findingsEl = this.root.querySelector("#ed-findings")!;
    this.inspector = this.root.querySelector("#ed-inspector")!;
  }

  /**
   * Replaces the inspector body. Rebuilt wholesale on a selection change
   * rather than diffed — a selection change swaps the entire control set, and
   * these are a dozen nodes touched at human speed, not per frame.
   */
  setInspector(title: string, rows: InspectorRow[]): void {
    this.inspector.innerHTML = "";
    if (!rows.length && !title) {
      this.inspector.classList.add("hidden");
      return;
    }
    this.inspector.classList.remove("hidden");
    const h = document.createElement("div");
    h.className = "ed-title";
    h.textContent = title;
    this.inspector.appendChild(h);
    for (const r of rows) {
      const el = document.createElement("div");
      el.className = "ed-row";
      const k = document.createElement("span");
      k.className = "ed-key";
      k.textContent = r.label;
      const v = document.createElement("span");
      v.textContent = r.value;
      el.append(k, v);
      this.inspector.appendChild(el);
    }
  }

  setWorkLight(on: boolean): void {
    this.workLightEl.textContent = on ? "on" : "off — night grade";
  }

  /**
   * The validation list. Each row is clickable and flies the camera to the
   * spot — a finding you cannot find is not much use.
   */
  setFindings(findings: readonly PanelFinding[], onPick: (i: number) => void): void {
    this.findingsEl.innerHTML = "";
    if (!findings.length) {
      this.findingsEl.innerHTML = `<div class="ed-ok">no problems found</div>`;
      return;
    }
    const errors = findings.filter((f) => f.severity === "error").length;
    const head = document.createElement("div");
    head.className = "ed-title";
    head.textContent = errors
      ? `${errors} error${errors > 1 ? "s" : ""}, ${findings.length} total`
      : `${findings.length} note${findings.length > 1 ? "s" : ""}`;
    this.findingsEl.appendChild(head);

    findings.forEach((f, i) => {
      const el = document.createElement("div");
      el.className = `ed-finding ${f.severity}`;
      el.textContent = f.text;
      el.title = "click to fly there";
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        onPick(i);
      });
      this.findingsEl.appendChild(el);
    });
  }

  /** Nav overlay state and per-bucket instance counts. */
  setNavOverlay(
    on: boolean,
    counts: { walkable: number; island: number; unrouted: number },
  ): void {
    this.overlayEl.textContent = on
      ? `on — ${counts.island} cut off, ${counts.unrouted} unrouted`
      : "off";
  }

  /** Save/scan feedback. `tone` colours it; the text is shown verbatim. */
  setStatus(text: string, tone: "idle" | "busy" | "ok" | "error"): void {
    this.statusEl.textContent = text;
    this.statusEl.className = `ed-status ${tone}`;
  }

  /**
   * Walkable-surface count after the last navigation rebuild. A single number,
   * but the useful one: a wall dropped across a gate or a deck lifted out of
   * step range shows up here as a sudden drop.
   */
  setNav(walkable: number): void {
    this.navEl.textContent = walkable.toLocaleString();
  }

  setVisible(on: boolean): void {
    this.root.classList.toggle("hidden", !on);
  }

  /** Called every frame while the editor is open. */
  update(x: number, y: number, z: number, speed: number): void {
    this.posEl.textContent = `${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`;
    this.speedEl.textContent = `${speed.toFixed(0)} m/s`;
  }

  dispose(): void {
    this.root.remove();
  }
}
