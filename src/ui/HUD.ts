/**
 * HUD.ts — In-game DOM overlay: vitals/ammo, reinforcement gauge, flag strip,
 * capture-zone panel, crosshair, hitmarker, damage vignette, directional damage
 * arcs, toasts, killfeed, scoreboard, menu/round-over.
 * Invariants: Game pushes state every frame (setHealth/setAmmo/setFlags/
 * setCapture/setViewYaw/...) — setting HUD state from anywhere else is
 * overwritten next tick. Pure DOM manipulation; reads ControlPoint data, never
 * imports game systems beyond types. Transient elements (toasts, killfeed)
 * self-remove via setTimeout; the damage arcs are a fixed pool, never allocated
 * per hit.
 *
 * Per-frame writes touch text nodes, class flags and CSS custom properties
 * only — never innerHTML. Every element written 60 times a second (the ticket
 * gauge, the flag cells, the magazine strip) is built once and cached; the
 * markup-rebuilding calls (`setScoreboard`, `showMenu`, `showRoundOver`) are
 * the ones that fire on a state change instead.
 */
import { CONFIG } from "../config";
import type { ControlPoint } from "../systems/ConquestSystem";

/**
 * Geometry of one damage arc, in the pixels of its own SVG box. Art constants,
 * so they live here rather than in CONFIG — the timings that make it *feel*
 * right are the tunables, and those are in `CONFIG.damageIndicator`.
 */
const ARC_BOX = 300;
const ARC_RADIUS = 104;
const ARC_HALF_SPAN_DEG = 29;
const ARC_THICKNESS = 8;
/** How far the tip juts past the outer edge, and how much of the span it eats. */
const ARC_TIP = 5;
const ARC_TIP_HALF_U = 0.1;

/** One live directional damage arc, pointing at where a shot came from. */
interface DamageArc {
  el: HTMLElement;
  /** World bearing to the shooter (radians, 0 = +Z), fixed at the hit. */
  bearing: number;
  /** Seconds of life left; <= 0 means the slot is free. */
  t: number;
  /** 0..1 from the damage that spawned it — drives opacity. */
  strength: number;
}

/**
 * The arc shape: an annulus sector whose thickness tapers to nothing at both
 * ends, with a small tip at the apex jutting *outward* — away from the
 * crosshair, along the bearing to the shooter. A constant-thickness band
 * reads as a slice of a ring around the crosshair; the taper plus that tip is
 * what makes it read as a pointer. The tip is on the outer edge only, so the
 * inner edge stays a clean arc and the crosshair keeps its clearance. Built
 * once as a path string and shared by every element in the pool.
 */
function damageArcMarkup(): string {
  const c = ARC_BOX / 2;
  // Even, and fine enough that the tip's straight sides don't read as steps.
  const steps = 48;
  const outer: string[] = [];
  const inner: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const ang = ((-ARC_HALF_SPAN_DEG + u * ARC_HALF_SPAN_DEG * 2) * Math.PI) / 180;
    const taper = Math.pow(Math.max(0, Math.cos((u - 0.5) * Math.PI)), 0.7);
    // Linear falloff either side of the apex: straight sides, so it reads as a
    // point rather than a bulge. `steps` is even, so u = 0.5 is sampled exactly
    // and the apex is a real vertex.
    const tip = ARC_TIP * Math.max(0, 1 - Math.abs(u - 0.5) / ARC_TIP_HALF_U);
    const ro = ARC_RADIUS + (ARC_THICKNESS / 2) * taper + tip;
    const ri = ARC_RADIUS - (ARC_THICKNESS / 2) * taper;
    const sin = Math.sin(ang);
    const cos = Math.cos(ang);
    outer.push(`${(c + ro * sin).toFixed(1)} ${(c - ro * cos).toFixed(1)}`);
    inner.push(`${(c + ri * sin).toFixed(1)} ${(c - ri * cos).toFixed(1)}`);
  }
  inner.reverse();
  const d = `M ${outer.join(" L ")} L ${inner.join(" L ")} Z`;
  return `<svg viewBox="0 0 ${ARC_BOX} ${ARC_BOX}" width="${ARC_BOX}" height="${ARC_BOX}"><path d="${d}"/></svg>`;
}

/** Signed shortest angle from `a` to `b`, in radians. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * The flag the player is standing in, relative to the player's own team. Game
 * derives this from the live ControlPoint each frame; the HUD picks the words.
 */
export interface CaptureStatus {
  /** Single letter, A..E. */
  id: string;
  name: string;
  owner: "mine" | "theirs" | "neutral";
  /** 0..1 — how far the meter has run, whichever way it has run. */
  progress: number;
  /**
   * The side the meter currently stands for — the bar's colour. Distinct from
   * `taking` on purpose: a flag at 95% theirs that you have just walked onto
   * is still showing a red bar while it runs back down toward you.
   */
  held: "mine" | "theirs";
  /** Which way the meter is being pushed, from who is standing in the zone. */
  taking: "mine" | "theirs";
  contested: boolean;
  /** Enemies standing in the zone with you. */
  enemies: number;
}

/** The player's controls, as the menu lists them. */
const CONTROLS: readonly [string, string, string][] = [
  ["Move", "Left stick", "W A S D"],
  ["Look", "Right stick", "Mouse"],
  ["Aim", "LT", "RMB"],
  ["Fire", "RT", "LMB"],
  ["Jump", "A", "Space"],
  ["Reload", "X", "R"],
  ["Sprint", "L3", "Shift"],
  ["Crouch", "B", "Ctrl"],
  ["Pause", "Start", "Esc"],
];

/** What the pause menu can do, and the label for each. In screen order. */
export type PauseAction = "resume" | "restart" | "quit";
const PAUSE_ITEMS: readonly [PauseAction, string][] = [
  ["resume", "Resume"],
  ["restart", "Restart round"],
  ["quit", "Quit to menu"],
];

/**
 * DOM-based HUD: vitals/ammo, the Conquest reinforcement gauge and flag strip,
 * crosshair, hitmarker, damage vignette, toasts, and full-screen overlays.
 * Styling lives in index.html.
 */
export class HUD {
  private root: HTMLElement;
  private healthFill: HTMLElement;
  private healthText: HTMLElement;
  private healthBar: HTMLElement;
  private ammoMag: HTMLElement;
  private ammoCap: HTMLElement;
  private magStrip: HTMLElement;
  private hudRight: HTMLElement;
  private weaponLabel: HTMLElement;
  /** One tick per round in the magazine; rebuilt only when the size changes. */
  private magTicks: HTMLElement[] = [];
  private magBuilt = -1;
  private flagStrip: HTMLElement;
  /** One cell per flag, rebuilt only when the roster changes. */
  private flagCells: { wrap: HTMLElement; fill: HTMLElement }[] = [];
  /** The reinforcement gauge's parts — written every frame, never rebuilt. */
  private ticketParts: {
    tag: HTMLElement;
    num: HTMLElement;
    fill: HTMLElement;
  }[] = [];
  private crosshair: HTMLElement;
  private hitmarker: HTMLElement;
  private vignette: HTMLElement;
  private damageDirs: HTMLElement;
  private message: HTMLElement;
  private toasts: HTMLElement;
  private overlay: HTMLElement;
  private lockHint: HTMLElement;
  private killfeed: HTMLElement;
  private scoreboard: HTMLElement;
  private capture: HTMLElement;
  /** The capture panel's parts, looked up once — it is written every frame. */
  private captureParts: {
    id: HTMLElement;
    name: HTMLElement;
    fill: HTMLElement;
    state: HTMLElement;
  };

  /** The pause menu's buttons and which one is selected; empty when closed. */
  private pauseButtons: HTMLElement[] = [];
  private pauseIndex = 0;

  private hitT = 0;
  private vignetteT = 0;
  private messageT = 0;
  /** Fixed pool, grown to CONFIG.damageIndicator.maxArcs and never past it. */
  private damageArcs: DamageArc[] = [];
  /** The view yaw the arcs are projected against; pushed every frame. */
  private viewYaw = 0;

  constructor() {
    this.root = document.getElementById("hud")!;
    this.root.innerHTML = `
      <div id="scrim"></div>
      <div id="ticket-bar">
        <div class="side mine"><span class="tag"></span><span class="n"></span></div>
        <div class="gauge">
          <div class="track mine"><i></i></div>
          <div class="track theirs"><i></i></div>
        </div>
        <div class="side theirs"><span class="n"></span><span class="tag"></span></div>
      </div>
      <div id="flag-strip"></div>
      <div id="crosshair">
        <i class="t"></i><i class="r"></i><i class="b"></i><i class="l"></i>
        <span class="dot"></span>
      </div>
      <div id="hitmarker" class="hidden"><i></i><i></i><i></i><i></i></div>
      <div id="vignette"></div>
      <div id="damage-dirs"></div>
      <div id="message" class="hidden"></div>
      <div id="toasts"></div>
      <div id="killfeed"></div>
      <div id="scoreboard" class="frame hidden"></div>
      <div id="lock-hint" class="hidden"><b>CLICK</b> TO CAPTURE THE MOUSE</div>
      <div id="capture-status" class="hidden">
        <div class="cap-head"><span class="cap-id"></span><span class="cap-name"></span></div>
        <div class="cap-meter"><div class="cap-meter-fill"></div><i class="ticks"></i></div>
        <div class="cap-state"></div>
      </div>
      <div id="hud-bottom">
        <div id="hud-left">
          <div class="cap-row"><span class="cap">VITALS</span></div>
          <div class="hp-bar"><i id="health-fill"></i><b class="segs"></b></div>
          <div class="hp-num"><span id="health-text">100</span><em>HP</em></div>
        </div>
        <div id="hud-right">
          <div class="ammo">
            <span id="ammo-mag">0</span><span id="ammo-cap"></span>
          </div>
          <div id="mag-strip"></div>
          <div class="cap-row">
            <span class="cap" id="weapon-label">RIFLE &middot; AUTO</span>
            <span class="reload-note">RELOADING</span>
          </div>
        </div>
      </div>
      <div id="overlay" class="hidden"></div>
    `;
    this.healthFill = document.getElementById("health-fill")!;
    this.healthText = document.getElementById("health-text")!;
    this.healthBar = this.root.querySelector("#hud-left .hp-bar") as HTMLElement;
    this.ammoMag = document.getElementById("ammo-mag")!;
    this.ammoCap = document.getElementById("ammo-cap")!;
    this.magStrip = document.getElementById("mag-strip")!;
    this.hudRight = document.getElementById("hud-right")!;
    this.weaponLabel = document.getElementById("weapon-label")!;
    this.flagStrip = document.getElementById("flag-strip")!;
    this.crosshair = document.getElementById("crosshair")!;
    this.hitmarker = document.getElementById("hitmarker")!;
    this.vignette = document.getElementById("vignette")!;
    this.damageDirs = document.getElementById("damage-dirs")!;
    this.message = document.getElementById("message")!;
    this.toasts = document.getElementById("toasts")!;
    this.overlay = document.getElementById("overlay")!;
    this.lockHint = document.getElementById("lock-hint")!;
    this.killfeed = document.getElementById("killfeed")!;
    this.scoreboard = document.getElementById("scoreboard")!;
    this.capture = document.getElementById("capture-status")!;
    this.captureParts = {
      id: this.capture.querySelector(".cap-id") as HTMLElement,
      name: this.capture.querySelector(".cap-name") as HTMLElement,
      fill: this.capture.querySelector(".cap-meter-fill") as HTMLElement,
      state: this.capture.querySelector(".cap-state") as HTMLElement,
    };
    // The gauge is [mine, theirs] in DOM order, which is also the order
    // setTickets resolves the teams into — index 0 is always the player's.
    const bar = document.getElementById("ticket-bar")!;
    this.ticketParts = (["mine", "theirs"] as const).map((side) => ({
      tag: bar.querySelector(`.side.${side} .tag`) as HTMLElement,
      num: bar.querySelector(`.side.${side} .n`) as HTMLElement,
      fill: bar.querySelector(`.track.${side} i`) as HTMLElement,
    }));
  }

  update(dt: number): void {
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) this.hitmarker.classList.add("hidden");
      else {
        // The pop is driven here rather than by a CSS animation: the marker is
        // re-triggered several times a second at full auto, and restarting a
        // keyframe animation needs a forced reflow every time.
        const pop = 1 + 0.4 * Math.max(0, this.hitT / 0.12);
        this.hitmarker.style.transform = `translate(-50%, -50%) scale(${pop.toFixed(3)})`;
      }
    }
    if (this.vignetteT > 0) {
      this.vignetteT -= dt;
      this.vignette.style.opacity = String(Math.max(0, this.vignetteT / 0.5) * 0.55);
    }
    if (this.messageT > 0) {
      this.messageT -= dt;
      if (this.messageT <= 0) this.message.classList.add("hidden");
    }
    this.updateDamageArcs(dt);
  }

  /**
   * The yaw the damage arcs are drawn against — the aim yaw, so an arc lines
   * up with the crosshair you would have to put on the shooter.
   */
  setViewYaw(yaw: number): void {
    this.viewYaw = yaw;
  }

  /**
   * Records a hit from `bearing` (world radians, 0 = +Z), the way Battlefield
   * does it: the direction is world-space and fixed at the moment of the hit,
   * and it is the *view* that moves under it. Repeated hits from roughly the
   * same place refresh one arc rather than stacking (see `mergeDegrees`).
   */
  addDamageDirection(bearing: number, amount: number): void {
    const cfg = CONFIG.damageIndicator;
    const strength = Math.max(0, Math.min(1, amount / cfg.fullDamage));
    const merge = (cfg.mergeDegrees * Math.PI) / 180;

    let slot: DamageArc | null = null;
    for (const arc of this.damageArcs) {
      if (arc.t > 0 && Math.abs(angleDelta(arc.bearing, bearing)) < merge) {
        // The newest hit wins the bearing: a shooter who has moved should drag
        // their arc with them rather than leave it where they opened up.
        arc.bearing = bearing;
        arc.t = cfg.life;
        arc.strength = Math.max(arc.strength, strength);
        return;
      }
      if (arc.t <= 0 && !slot) slot = arc;
    }

    if (!slot) {
      if (this.damageArcs.length < cfg.maxArcs) {
        const el = document.createElement("div");
        el.className = "arc";
        el.innerHTML = damageArcMarkup();
        this.damageDirs.appendChild(el);
        slot = { el, bearing, t: 0, strength };
        this.damageArcs.push(slot);
      } else {
        // Pool full and all live: the arc closest to expiring is the least
        // useful one, so recycle that rather than dropping the new threat.
        slot = this.damageArcs.reduce((a, b) => (b.t < a.t ? b : a));
      }
    }
    slot.bearing = bearing;
    slot.t = cfg.life;
    slot.strength = strength;
    slot.el.style.display = "block";
  }

  /** Wipes the arcs — death, deploy, round end. Stale threats mean nothing. */
  clearDamageDirections(): void {
    for (const arc of this.damageArcs) {
      arc.t = 0;
      arc.el.style.display = "none";
    }
  }

  private updateDamageArcs(dt: number): void {
    const cfg = CONFIG.damageIndicator;
    for (const arc of this.damageArcs) {
      if (arc.t <= 0) continue;
      arc.t -= dt;
      if (arc.t <= 0) {
        arc.el.style.display = "none";
        continue;
      }
      // World yaw 0 faces +Z and grows clockwise seen from above, which is the
      // same sense as a CSS rotation of an up-pointing shape — so the bearing
      // minus the view yaw IS the screen angle, with no axis flip.
      const rel = ((arc.bearing - this.viewYaw) * 180) / Math.PI;
      const fade = Math.min(1, arc.t / cfg.fadeTime);
      const opacity =
        (cfg.minOpacity + (cfg.maxOpacity - cfg.minOpacity) * arc.strength) * fade;
      // A brief pop outward on arrival: the arc has to catch the eye in a
      // firefight where the screen is already flashing red.
      const age = cfg.life - arc.t;
      const punch = 1 + 0.09 * Math.max(0, 1 - age / 0.16);
      arc.el.style.opacity = opacity.toFixed(3);
      arc.el.style.transform = `rotate(${rel.toFixed(2)}deg) scale(${punch.toFixed(3)})`;
    }
  }

  setHealth(current: number, max: number): void {
    const frac = Math.max(0, current / max);
    this.healthFill.style.width = `${frac * 100}%`;
    // The low state is carried on the whole block, not just the fill: the bar
    // goes red, the readout goes red, and both breathe, which is the one thing
    // that has to register without being looked at.
    const low = frac < 0.3;
    this.healthBar.classList.toggle("low", low);
    this.healthText.classList.toggle("low", low);
    this.healthText.textContent = String(Math.ceil(current));
  }

  setAmmo(ammo: number, magSize: number, reloading: boolean): void {
    if (this.magBuilt !== magSize) {
      this.magStrip.innerHTML = "";
      this.magTicks = [];
      for (let i = 0; i < magSize; i++) {
        const tick = document.createElement("i");
        this.magStrip.appendChild(tick);
        this.magTicks.push(tick);
      }
      this.magBuilt = magSize;
    }
    // One tick per round left in the magazine — the count is legible without
    // reading the number, which is the whole point of a strip.
    for (let i = 0; i < this.magTicks.length; i++) {
      this.magTicks[i].classList.toggle("spent", i >= ammo);
    }
    this.ammoMag.textContent = String(ammo);
    this.ammoCap.textContent = `/ ${magSize}`;
    this.ammoMag.classList.toggle("low", !reloading && ammo <= magSize * 0.25);
    this.hudRight.classList.toggle("reloading", reloading);
  }

  /**
   * Reinforcement counts, as two gauges draining away from the centre. The
   * player's team is always the left-hand one. `CONFIG.conquest.tickets` is the
   * full-scale reading — the gauge is a fraction of the round's starting pool,
   * so "we are losing" reads off the bar rather than off the arithmetic.
   */
  setTickets(names: readonly string[], tickets: readonly number[], playerTeam: number): void {
    const max = CONFIG.conquest.tickets;
    const order = [playerTeam, 1 - playerTeam];
    for (let i = 0; i < 2; i++) {
      const team = order[i];
      const part = this.ticketParts[i];
      const n = tickets[team];
      part.tag.textContent = names[team].toUpperCase();
      part.num.textContent = String(n);
      part.fill.style.width = `${Math.max(0, Math.min(1, n / max)) * 100}%`;
      part.num.classList.toggle("critical", n / max < 0.15);
    }
  }

  /**
   * The A..E flag strip. Each cell is a hexagon in its owner's colour, filling
   * from the bottom with the capture meter, so a flag being taken is visible
   * without looking at it. The two-layer shape (`.core` inset inside the
   * coloured hull) is how the cell gets a border at all: `clip-path` clips a
   * CSS border away with everything else outside the polygon.
   */
  setFlags(points: ControlPoint[], playerTeam: number): void {
    if (this.flagCells.length !== points.length) {
      this.flagStrip.innerHTML = "";
      this.flagCells = points.map((p) => {
        const wrap = document.createElement("div");
        wrap.className = "flag";
        wrap.innerHTML =
          `<div class="core"><i class="cap-fill"></i>` +
          `<span class="id">${p.def.id}</span></div>`;
        this.flagStrip.appendChild(wrap);
        return { wrap, fill: wrap.querySelector(".cap-fill") as HTMLElement };
      });
    }
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const cell = this.flagCells[i];
      const owner =
        p.owner === null ? "neutral" : p.owner === playerTeam ? "mine" : "theirs";
      cell.wrap.className = `flag ${owner}${p.contested ? " contested" : ""}`;
      // Meter runs -1..+1; show it as distance from neutral either way.
      cell.fill.style.height = `${Math.abs(p.meter) * 100}%`;
      cell.fill.className = `cap-fill ${
        Math.sign(p.meter) === (playerTeam === 0 ? -1 : 1) ? "mine" : "theirs"
      }`;
    }
  }

  /**
   * The "you are standing in it" panel: shown only while the player is inside
   * a capture zone, which is the one thing the flag strip cannot say. The ring
   * on the ground draws the boundary; this confirms which side of it you are
   * on, and what the meter is doing about it.
   */
  setCapture(status: CaptureStatus | null): void {
    if (!status) {
      this.capture.classList.add("hidden");
      return;
    }
    const parts = this.captureParts;
    // Rewritten wholesale rather than toggled, which is also what clears the
    // `hidden` the null branch above puts back on. `frame` has to be re-stated
    // here — it is what draws the panel's chamfered hull.
    this.capture.className = `frame zone ${status.owner}${
      status.contested ? " contested" : ""
    }`;
    parts.id.textContent = status.id;
    parts.name.textContent = status.name.toUpperCase();
    parts.fill.style.width = `${Math.round(status.progress * 100)}%`;
    parts.fill.className = `cap-meter-fill ${status.held}`;
    // A held flag with nobody contesting it has no meter story to tell, so the
    // panel says so rather than showing a full bar and leaving you to read it.
    if (status.contested) {
      const n = status.enemies;
      parts.state.textContent = `CONTESTED — ${n} ENEM${n === 1 ? "Y" : "IES"} IN ZONE`;
    } else if (status.owner === "mine" && status.progress >= 1) {
      parts.state.textContent = "SECURED";
    } else if (status.taking === "mine") {
      parts.state.textContent = "CAPTURING";
    } else {
      parts.state.textContent = "LOSING";
    }
  }

  /**
   * Crosshair state, pushed every frame. The gap between the four ticks IS the
   * current bullet spread in screen pixels, so recoil bloom is visible as the
   * crosshair opening up and settling as it bleeds off. The ticks read the gap
   * off the `--sp` custom property, so one write per frame moves all four and
   * the browser keeps it on the compositor.
   *
   * `adsBlend` fades it out rather than switching it off: aimed, the weapon's
   * own holo reticle sits on the camera axis at the exact centre of the
   * screen, and two aiming marks stacked on each other read as a smear. The
   * fade rides the same blend the sight comes up on, so the handover happens
   * while the rifle is still moving.
   */
  setCrosshair(adsBlend: number, spreadPx: number): void {
    this.crosshair.style.opacity = `${Math.max(0, 1 - adsBlend * 1.6)}`;
    const size = Math.round(Math.max(10, Math.min(90, spreadPx)));
    this.crosshair.style.setProperty("--sp", `${size}px`);
  }

  /**
   * The hit confirmation. A kill is a distinct, redder marker — the standard
   * shooter read, and the one piece of feedback that tells you to stop
   * shooting at a body that is already going down.
   */
  flashHitmarker(killed = false): void {
    this.hitmarker.classList.remove("hidden");
    this.hitmarker.classList.toggle("kill", killed);
    this.hitT = 0.12;
  }

  flashDamage(): void {
    this.vignetteT = 0.5;
    this.vignette.style.opacity = "0.55";
  }

  showMessage(text: string, seconds = 2.4): void {
    this.message.textContent = text;
    this.message.classList.remove("hidden");
    this.messageT = seconds;
  }

  toast(text: string): void {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    this.toasts.appendChild(el);
    setTimeout(() => el.classList.add("fade"), 1800);
    setTimeout(() => el.remove(), 2600);
  }

  /**
   * One kill line. `mine` tints entries the player was involved in, so your own
   * kills and deaths stand out from the background chatter of a 16-bot fight.
   */
  addKill(killer: string, victim: string, mine: boolean): void {
    const el = document.createElement("div");
    el.className = `kill${mine ? " mine" : ""}`;
    el.innerHTML =
      `<span class="k">${killer}</span>` +
      `<span class="x">&#9587;</span>` +
      `<span class="v">${victim}</span>`;
    this.killfeed.appendChild(el);
    // Cap the feed: a full battle would otherwise fill the screen edge to edge.
    while (this.killfeed.childElementCount > 6) {
      this.killfeed.firstElementChild!.remove();
    }
    setTimeout(() => el.classList.add("fade"), 4000);
    setTimeout(() => el.remove(), 4800);
  }

  setScoreboard(
    visible: boolean,
    rows?: {
      teams: readonly string[];
      tickets: readonly number[];
      flags: readonly number[];
      kills: readonly number[];
      deaths: readonly number[];
      playerTeam: number;
      playerKills: number;
      playerDeaths: number;
    },
  ): void {
    this.scoreboard.classList.toggle("hidden", !visible);
    if (!visible || !rows) return;
    const max = CONFIG.conquest.tickets;
    const row = (t: number) => {
      const frac = Math.max(0, Math.min(1, rows.tickets[t] / max));
      return `
      <div class="sb-row ${t === rows.playerTeam ? "mine" : "theirs"}">
        <span class="sb-name">${rows.teams[t].toUpperCase()}</span>
        <span class="sb-tickets">
          <b>${rows.tickets[t]}</b>
          <i class="sb-gauge"><u style="width:${(frac * 100).toFixed(1)}%"></u></i>
        </span>
        <span class="sb-n">${rows.flags[t]}</span>
        <span class="sb-n">${rows.kills[t]}</span>
        <span class="sb-n">${rows.deaths[t]}</span>
      </div>`;
    };
    this.scoreboard.innerHTML = `
      <div class="sb-head">
        <span class="sb-mode">CONQUEST</span>
        <span class="sb-map">HOLLOWMERE</span>
      </div>
      <div class="sb-cols">
        <span></span><span>REINFORCEMENTS</span><span>FLAGS</span>
        <span>KILLS</span><span>LOSSES</span>
      </div>
      ${row(rows.playerTeam)}${row(1 - rows.playerTeam)}
      <div class="sb-you">
        <span class="sb-label">OPERATIVE</span>
        <span class="sb-stat"><b>${rows.playerKills}</b> KILLS</span>
        <span class="sb-stat"><b>${rows.playerDeaths}</b> DEATHS</span>
      </div>
    `;
  }

  /**
   * Hides the gameplay chrome (tickets, flags, crosshair, health, ammo) while
   * the map editor is open. One class on the root rather than a toggle per
   * element — `update()` keeps writing to those nodes regardless, and CSS
   * hiding survives that where a per-element flag would be overwritten.
   */
  setEditing(on: boolean): void {
    this.root.classList.toggle("editing", on);
  }

  /**
   * The kit caption over the magazine strip. Pushed when the loadout changes
   * rather than every frame — it is one of the few strings on the HUD that
   * only moves when the player moves it.
   */
  setKit(label: string): void {
    this.weaponLabel.textContent = label.toUpperCase();
  }

  setLockHint(visible: boolean): void {
    this.lockHint.classList.toggle("hidden", !visible);
  }

  /**
   * The main menu: the difficulty picker and the way into the loadout screen.
   *
   * The kit itself is not edited here — it is two slots and a stat chart now,
   * which is a screen rather than a strip of buttons under a title. What sits
   * here is the button that opens it and a reminder of what is currently in
   * the player's hands, which is the part of the old row that was worth
   * keeping on the menu.
   *
   * `#overlay` is inside a `pointer-events: none` HUD and does not opt back in
   * (only `#deploy` does), so the difficulty row and the kit button ask for
   * pointer events on themselves alone — the rest of the overlay stays inert
   * and a stray click can never be mistaken for a UI action.
   */
  showMenu(
    difficulties: readonly string[],
    selected: number,
    kit: string,
  ): void {
    this.overlay.classList.remove("hidden");
    this.setOverlaid(true);
    const tiers = difficulties
      .map(
        (name, i) =>
          `<button class="tier${i === selected ? " on" : ""}" data-tier="${i}">${name}</button>`,
      )
      .join("");
    const controls = CONTROLS.map(
      ([action, pad, key]) => `
        <div class="ctl">
          <span class="ctl-act">${action}</span>
          <span class="ctl-keys">${key
            .split(" ")
            .map((k) => `<kbd>${k}</kbd>`)
            .join("")}</span>
          <span class="ctl-pad"><kbd class="pad">${pad}</kbd></span>
        </div>`,
    ).join("");
    this.overlay.innerHTML = `
      <div class="ov-title">
        <h1>HOLLOWMERE</h1>
        <p class="tagline">Conquest &mdash; take and hold five points against the Blight</p>
      </div>
      <div class="difficulty">
        <span class="label">Enemy skill</span>
        <div class="tiers">${tiers}</div>
        <span class="hint">&larr; &rarr; / D-pad</span>
      </div>
      <div class="kit">
        <span class="label">Loadout</span>
        <button class="kit-open"><b>${kit}</b><i>Change kit</i></button>
        <span class="hint">L / Y</span>
      </div>
      <div class="ov-controls frame">
        <div class="ov-controls-head">
          <span>Controls</span><span>Keyboard &amp; mouse</span><span>Gamepad</span>
        </div>
        ${controls}
      </div>
      <p class="prompt">Click, press Enter, or press Start to deploy</p>
    `;
    this.overlay
      .querySelectorAll<HTMLElement>("button.tier")
      .forEach((btn) => {
        btn.onclick = () => this.onDifficulty(Number(btn.dataset.tier));
      });
    // POINTERDOWN, not click. The menu's own confirm is "a mouse button went
    // down anywhere", read from the button mask on the next tick — which
    // happens before a `click` (that lands on mouse UP) ever fires. Opening
    // the loadout on the down edge changes the state first, so the confirm
    // arrives in a state that ignores the mouse instead of deploying the
    // player out from under the screen they just asked for.
    const kitBtn = this.overlay.querySelector<HTMLElement>("button.kit-open");
    if (kitBtn) kitBtn.onpointerdown = () => this.onOpenLoadout();
  }

  /** Wired by Game: the player picked a difficulty tier from the menu. */
  onDifficulty: (tier: number) => void = () => {};

  /** Wired by Game: the player asked for the loadout screen. */
  onOpenLoadout: () => void = () => {};

  showRoundOver(
    winnerName: string,
    playerWon: boolean,
    tickets0: number,
    tickets1: number,
  ): void {
    this.overlay.classList.remove("hidden");
    this.setOverlaid(true);
    this.overlay.innerHTML = `
      <div class="ov-title">
        <h1 class="${playerWon ? "win" : "dead"}">${playerWon ? "VICTORY" : "DEFEAT"}</h1>
        <p class="tagline">${winnerName} hold Hollowmere</p>
      </div>
      <div class="ov-result frame">
        <span class="lbl">REINFORCEMENTS REMAINING</span>
        <span class="vals"><b>${tickets0}</b><i>/</i><b>${tickets1}</b></span>
      </div>
      <p class="prompt">Click, press Enter, or press Start for another round</p>
    `;
  }

  /**
   * The pause menu: a short action list, the controls table, and nothing else.
   *
   * It deliberately does NOT call `setOverlaid`. The menu and the round-over
   * card hide the gameplay chrome because what is under them is last round's
   * and no longer true; under a pause everything on screen is this round's and
   * frozen exactly as it stood, so the tickets, the flags and your own vitals
   * are worth reading. `#hud.paused` takes away only the things that would be
   * lying — the crosshair, the hitmarker, the damage arcs and the lock hint.
   *
   * The action list is the one part of the overlay that takes pointer events,
   * the same carve-out the difficulty row gets. Selection is a class on a
   * button that already exists rather than a re-render, so arrowing down the
   * list does not restart the prompt's animation or drop the hover state.
   */
  showPause(): void {
    this.overlay.classList.remove("hidden");
    const items = PAUSE_ITEMS.map(
      ([action, label]) =>
        `<button class="pact" data-action="${action}">${label}</button>`,
    ).join("");
    this.overlay.innerHTML = `
      <div class="ov-title">
        <h1 class="pause-title">PAUSED</h1>
        <p class="tagline">The round is held &mdash; nothing moves until you resume</p>
      </div>
      <div class="pause-actions">${items}</div>
      <div class="ov-controls frame">
        <div class="ov-controls-head">
          <span>Controls</span><span>Keyboard &amp; mouse</span><span>Gamepad</span>
        </div>
        ${CONTROLS.map(
          ([action, pad, key]) => `
        <div class="ctl">
          <span class="ctl-act">${action}</span>
          <span class="ctl-keys">${key
            .split(" ")
            .map((k) => `<kbd>${k}</kbd>`)
            .join("")}</span>
          <span class="ctl-pad"><kbd class="pad">${pad}</kbd></span>
        </div>`,
        ).join("")}
      </div>
      <p class="prompt">Esc or Start to resume</p>
    `;
    this.pauseButtons = [];
    this.overlay
      .querySelectorAll<HTMLElement>("button.pact")
      .forEach((btn, i) => {
        btn.onclick = () => this.onPauseAction(btn.dataset.action as PauseAction);
        // Hovering moves the keyboard selection with it, so the highlighted
        // item and the one a click is about to fire can never disagree.
        btn.onmouseenter = () => this.setPauseSelection(i);
        this.pauseButtons.push(btn);
      });
    this.setPauseSelection(0);
  }

  /** Steps the pause selection, wrapping at both ends. */
  movePauseSelection(delta: number): void {
    const n = this.pauseButtons.length;
    if (n === 0) return;
    this.setPauseSelection((this.pauseIndex + delta + n) % n);
  }

  /** Fires the selected pause item — Enter / gamepad A. */
  activatePause(): void {
    const btn = this.pauseButtons[this.pauseIndex];
    if (btn) this.onPauseAction(btn.dataset.action as PauseAction);
  }

  /** Wired by Game: the player picked something from the pause menu. */
  onPauseAction: (action: PauseAction) => void = () => {};

  private setPauseSelection(i: number): void {
    this.pauseIndex = i;
    this.pauseButtons.forEach((b, k) => b.classList.toggle("on", k === i));
  }

  /**
   * Takes away the chrome that would be lying while the game is held: the
   * crosshair (nothing to shoot), the hitmarker and damage arcs (frozen
   * mid-decay), and the lock hint (the pause is why the mouse is free).
   */
  setPaused(on: boolean): void {
    this.root.classList.toggle("paused", on);
  }

  hideOverlay(): void {
    this.overlay.classList.add("hidden");
    this.setOverlaid(false);
    // The buttons live in the overlay's markup, so they die with it.
    this.pauseButtons = [];
    this.pauseIndex = 0;
  }

  /**
   * Hides the gameplay chrome behind a full-screen overlay. The menu and the
   * round-over card sit over a live 3D scene, and the ticket gauge, flag strip,
   * killfeed and vitals underneath them are last round's — readable enough
   * through the scrim to look like the HUD is still running when it is not.
   * Same mechanism as `setEditing`, and for the same reason: `update()` keeps
   * writing to those nodes, so the hiding has to be in CSS.
   *
   * The deploy screen deliberately does NOT do this — you pick a spawn while
   * the round continues, and the tickets and flags are exactly what you are
   * deciding against.
   */
  private setOverlaid(on: boolean): void {
    this.root.classList.toggle("overlaid", on);
  }
}
