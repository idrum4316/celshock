/**
 * DeployScreen.ts — Top-down deploy map: renders spawn options from the
 * GameMap's collider geometry, hit-tests clicks, steps the selection for the
 * keyboard/pad (moveSelection), fires onDeploy (wired in Game) when a
 * selection is confirmed.
 * Invariants: CSS contract — #hud is pointer-events:none and this overlay
 * opts back in; don't break that or gameplay clicks die. Re-checks map/
 * conquest readiness every update; the 3D scene renders live behind it.
 */
import "./deploy.css";
import { CONFIG } from "../config";
import type { Team } from "../entities/Combatant";
import type { ConquestSystem } from "../systems/ConquestSystem";
import type { GameMap, SpawnPointDef } from "../world/MapBuilder";

/**
 * The between-lives screen: a top-down view of the map with the flags you
 * hold, where you can pick a spawn and drop back in — and a way through to the
 * loadout screen before you do. Waiting out a respawn is the natural moment to
 * reconsider the kit, and it is the only moment inside a round when changing
 * it costs nothing: the weapon is already put away.
 *
 * The map is drawn straight from the collider boxes rather than from a separate
 * authored minimap. That keeps the two from ever disagreeing — if a building
 * blocks movement it appears here, and nothing has to be updated twice when the
 * layout changes.
 *
 * Note the CSS contract: `#hud` is `pointer-events: none` so the HUD never eats
 * a click meant for the game, which means this overlay has to opt back in.
 */
export class DeployScreen {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private statusEl: HTMLElement;
  /** The kit button's caption; rewritten when the fit changes. */
  private kitEl: HTMLElement;
  /** The confirm button; greyed until the reinforcement wait is over. */
  private goBtn!: HTMLElement;

  /** Wired by Game. */
  onDeploy: (spawn: SpawnPointDef) => void = () => {};
  /** Wired by Game: the player wants the loadout screen before dropping in. */
  onOpenLoadout: () => void = () => {};

  private map: GameMap | null = null;
  private conquest: ConquestSystem | null = null;
  private team: Team = 0;
  private options: SpawnPointDef[] = [];
  private selected = 0;
  /** Screen-space hit targets, rebuilt every draw. */
  private hotspots: { x: number; y: number; r: number; index: number }[] = [];
  private ready = false;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "deploy";
    this.root.className = "hidden";
    // `.map-wrap` exists only to hang the chamfered hull and the corner
    // brackets on — a canvas cannot draw its own chrome.
    this.root.innerHTML = `
      <h2>SELECT DEPLOYMENT</h2>
      <div class="map-wrap brackets">
        <div class="hull"></div>
        <canvas id="deploy-map" width="620" height="620"></canvas>
      </div>
      <!-- Every input hint on this screen lives in one row, and the buttons
           below carry only what they do. The kit button used to spell its own
           key out, which cost the row more width than it had: the map is
           height-led, so on a 768-tall laptop the two buttons and a long
           weapon name did not fit across it. -->

      <div id="deploy-status"></div>
      <div id="deploy-nav">
        <span><kbd>&larr;</kbd><kbd>&rarr;</kbd><kbd class="pad">D-pad</kbd> choose position</span>
        <span><kbd>L</kbd><kbd class="pad">Y</kbd> loadout</span>
      </div>
      <div id="deploy-actions">
        <button id="deploy-go"><b>Deploy</b><i>Enter &middot; A</i></button>
        <button id="deploy-kit"><span class="lbl">Loadout</span><b></b></button>
      </div>
    `;
    document.getElementById("hud")!.appendChild(this.root);
    this.canvas = this.root.querySelector("#deploy-map")!;
    this.ctx = this.canvas.getContext("2d")!;
    this.statusEl = this.root.querySelector("#deploy-status")!;
    const kitBtn = this.root.querySelector<HTMLElement>("#deploy-kit")!;
    this.kitEl = kitBtn.querySelector("b")!;
    // Pointerdown rather than click, for the same reason the menu's kit button
    // uses it: the deploy confirm is a mouse-down anywhere, read a tick later,
    // so the state has to change on the down edge or the click that opened the
    // loadout also drops the player into the map behind it.
    kitBtn.onpointerdown = () => this.onOpenLoadout();

    // The deploy confirm is Enter / pad A and deliberately not the mouse, so
    // without this there is no pointer route off this screen except hitting one
    // of the markers — which on a phone, where the marker is 11 px on a map
    // scaled to the viewport, is not a target. Pointerdown for the reason the
    // markers use it: the same event goes on to take the pointer lock, and it
    // can only do that once `spawnPlayer` has put the state into `playing`.
    this.goBtn = this.root.querySelector<HTMLElement>("#deploy-go")!;
    this.goBtn.onpointerdown = () => this.confirm();

    this.canvas.addEventListener("pointerdown", (e) => this.click(e));
  }

  /**
   * Shows what is being carried. Called by Game once it has actually changed
   * the loadout, never straight from the screen that asked for the change —
   * so the caption cannot get ahead of the weapon.
   */
  setKit(label: string): void {
    this.kitEl.textContent = label;
  }

  show(map: GameMap, conquest: ConquestSystem, team: Team): void {
    this.map = map;
    this.conquest = conquest;
    this.team = team;
    this.selected = 0;
    this.ready = false;
    this.root.classList.remove("hidden");
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  get visible(): boolean {
    return !this.root.classList.contains("hidden");
  }

  /** Redraws and refreshes the countdown. `remaining` is seconds until deploy. */
  update(remaining: number): void {
    if (!this.map || !this.conquest) return;
    this.options = this.conquest.deployOptions(this.team);
    if (this.selected >= this.options.length) this.selected = 0;
    this.ready = remaining <= 0;

    const name = this.spawnLabel(this.options[this.selected]);
    // The name is the selection read back. It is on this line rather than only
    // on the map because a marker highlighted 300 px away is not a label, and
    // stepping through spawns with a d-pad is exactly the case where nothing
    // else tells you what you just moved onto.
    this.statusEl.textContent = this.ready
      ? `READY TO DEPLOY  —  ${name}`
      : `REINFORCEMENTS IN ${Math.ceil(remaining)}  —  ${name}`;
    this.statusEl.classList.toggle("ready", this.ready);
    // `confirm()` is a no-op until the wait is over, so the button must not
    // look live before then — a control that answers nothing is worse than one
    // that is visibly not yet yours.
    this.goBtn.classList.toggle("waiting", !this.ready);
    this.draw();
  }

  /**
   * Steps the highlighted spawn, wrapping at both ends — the keyboard's arrows
   * and the pad's d-pad. The mouse picks a marker directly; without this there
   * was no way to change position at all without one, which made the pad's
   * confirm a deploy at whatever the list happened to start on.
   *
   * It only moves the index. `update()` runs every frame in this state and
   * redraws from it, so there is nothing to repaint here — and it is called
   * before that update, so the marker and the status line change on the same
   * frame the key was pressed.
   */
  moveSelection(delta: number): void {
    const n = this.options.length;
    if (n === 0) return;
    this.selected = (this.selected + delta + n) % n;
  }

  /** Deploys at the current selection. Used by the keyboard/gamepad confirm. */
  confirm(): void {
    if (!this.ready) return;
    const spawn = this.options[this.selected];
    if (spawn) this.onDeploy(spawn);
  }

  private spawnLabel(spawn: SpawnPointDef | undefined): string {
    if (!spawn) return "NO POSITION";
    if (!spawn.controlPoint) return CONFIG.teams[this.team].name.toUpperCase();
    const p = this.conquest?.pointById(spawn.controlPoint);
    return (p?.def.name ?? spawn.controlPoint).toUpperCase();
  }

  private click(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
    for (const h of this.hotspots) {
      const dx = h.x - x;
      const dy = h.y - y;
      if (dx * dx + dy * dy < h.r * h.r) {
        this.selected = h.index;
        this.update(this.ready ? 0 : 1);
        if (this.ready) this.confirm();
        return;
      }
    }
  }

  private draw(): void {
    const map = this.map;
    const conquest = this.conquest;
    if (!map || !conquest) return;
    const c = this.ctx;
    const size = this.canvas.width;
    const scale = size / map.size;
    const toX = (wx: number) => (wx + map.size / 2) * scale;
    // Canvas Y grows downward and world +Z is north, so the axis is flipped —
    // north ends up at the top, matching the layout diagram.
    const toY = (wz: number) => (map.size / 2 - wz) * scale;

    c.fillStyle = "#0b0e12";
    c.fillRect(0, 0, size, size);

    // Building footprints, straight from the collision data.
    c.fillStyle = "#39434a";
    for (const b of map.colliderBoxes) {
      if (b.w > 200 || b.d > 200) continue; // ground plane and ridge
      c.save();
      c.translate(toX(b.cx), toY(b.cz));
      c.rotate(-b.rotY);
      c.fillRect(
        (-b.w / 2) * scale,
        (-b.d / 2) * scale,
        b.w * scale,
        b.d * scale,
      );
      c.restore();
    }

    this.hotspots.length = 0;
    const mine = CONFIG.teams[this.team].color;
    const theirs = CONFIG.teams[1 - this.team].color;

    // Flags.
    for (const p of conquest.points) {
      const x = toX(p.def.pos.x);
      const y = toY(p.def.pos.z);
      c.beginPath();
      c.arc(x, y, p.def.radius * scale, 0, Math.PI * 2);
      c.fillStyle =
        p.owner === null
          ? "rgba(150,150,160,0.15)"
          : p.owner === this.team
            ? hexA(mine, 0.22)
            : hexA(theirs, 0.22);
      c.fill();
      c.strokeStyle =
        p.owner === null ? "#8b8f96" : p.owner === this.team ? mine : theirs;
      c.lineWidth = p.contested ? 3 : 1.5;
      c.stroke();

      c.fillStyle = "#e8e8ea";
      c.font = "bold 15px system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(p.def.id, x, y);
    }

    // Deployment markers.
    for (let i = 0; i < this.options.length; i++) {
      const s = this.options[i];
      const x = toX(s.pos.x);
      const y = toY(s.pos.z);
      const r = 11;
      this.hotspots.push({ x, y, r: r + 5, index: i });

      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fillStyle = i === this.selected ? mine : "rgba(0,0,0,0.65)";
      c.fill();
      c.strokeStyle = mine;
      c.lineWidth = i === this.selected ? 3 : 2;
      c.stroke();

      // A downward chevron, so a spawn never reads as a flag.
      c.beginPath();
      c.moveTo(x - 4, y - 3);
      c.lineTo(x + 4, y - 3);
      c.lineTo(x, y + 4);
      c.closePath();
      c.fillStyle = i === this.selected ? "#0b0e12" : mine;
      c.fill();
    }
  }
}

/** Hex colour with an alpha channel, for the zone fills. */
function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
