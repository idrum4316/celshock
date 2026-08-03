/**
 * HUD.ts — In-game DOM overlay: health/ammo, tickets, flag strip, capture-zone
 * panel, crosshair, hitmarker, damage vignette, directional damage arcs,
 * toasts, killfeed, scoreboard, menu/round-over.
 * Invariants: Game pushes state every frame (setHealth/setAmmo/setFlags/
 * setCapture/setViewYaw/...) — setting HUD state from anywhere else is
 * overwritten next
 * tick. Pure DOM manipulation; reads ControlPoint data, never imports game
 * systems beyond types. Transient elements (toasts, killfeed) self-remove via
 * setTimeout; the damage arcs are a fixed pool, never allocated per hit.
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

/**
 * DOM-based HUD: health/ammo, the Conquest scoreboard (tickets and the flag
 * strip), crosshair, hitmarker, damage vignette, toasts, and full-screen
 * overlays. Styling lives in index.html.
 */
export class HUD {
  private root: HTMLElement;
  private healthFill: HTMLElement;
  private healthText: HTMLElement;
  private ammoText: HTMLElement;
  private ticketBar: HTMLElement;
  private flagStrip: HTMLElement;
  /** One cell per flag, rebuilt only when the roster changes. */
  private flagCells: { wrap: HTMLElement; fill: HTMLElement }[] = [];
  private crosshair: HTMLElement;
  /** The crosshair's ring, resized every frame to the live bullet spread. */
  private crosshairRing: HTMLElement;
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
      <div id="ticket-bar"></div>
      <div id="flag-strip"></div>
      <div id="crosshair"><div class="dot"></div><span class="ring"></span></div>
      <div id="hitmarker" class="hidden">✕</div>
      <div id="vignette"></div>
      <div id="damage-dirs"></div>
      <div id="message" class="hidden"></div>
      <div id="toasts"></div>
      <div id="killfeed"></div>
      <div id="scoreboard" class="hidden"></div>
      <div id="lock-hint" class="hidden">Click to capture the mouse</div>
      <div id="capture-status" class="hidden">
        <div class="cap-head"><span class="cap-id"></span><span class="cap-name"></span></div>
        <div class="cap-meter"><div class="cap-meter-fill"></div></div>
        <div class="cap-state"></div>
      </div>
      <div id="hud-bottom">
        <div class="panel">
          <div class="label">HP</div>
          <div class="bar"><div id="health-fill" class="fill"></div></div>
          <div id="health-text"></div>
        </div>
        <div class="panel right"><div id="ammo-text"></div></div>
      </div>
      <div id="overlay" class="hidden"></div>
    `;
    this.healthFill = document.getElementById("health-fill")!;
    this.healthText = document.getElementById("health-text")!;
    this.ammoText = document.getElementById("ammo-text")!;
    this.ticketBar = document.getElementById("ticket-bar")!;
    this.flagStrip = document.getElementById("flag-strip")!;
    this.crosshair = document.getElementById("crosshair")!;
    this.crosshairRing = this.crosshair.querySelector(".ring") as HTMLElement;
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
  }

  update(dt: number): void {
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) this.hitmarker.classList.add("hidden");
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
    this.healthFill.classList.toggle("low", frac < 0.3);
    this.healthText.textContent = `${Math.ceil(current)} / ${max}`;
  }

  setAmmo(ammo: number, magSize: number, reloading: boolean): void {
    this.ammoText.textContent = reloading ? "RELOADING…" : `${ammo} / ${magSize}`;
    this.ammoText.classList.toggle("reloading", reloading);
  }

  /** Reinforcement counts, with the player's own team first. */
  setTickets(names: readonly string[], tickets: readonly number[], playerTeam: number): void {
    const mine = playerTeam;
    const theirs = 1 - playerTeam;
    this.ticketBar.innerHTML =
      `<span class="team mine">${names[mine].toUpperCase()} <b>${tickets[mine]}</b></span>` +
      `<span class="sep">/</span>` +
      `<span class="team theirs"><b>${tickets[theirs]}</b> ${names[theirs].toUpperCase()}</span>`;
  }

  /**
   * The A..E flag strip. Each cell shows its owner as a colour and its capture
   * progress as a fill, so a flag being taken is visible without looking at it.
   */
  setFlags(points: ControlPoint[], playerTeam: number): void {
    if (this.flagCells.length !== points.length) {
      this.flagStrip.innerHTML = "";
      this.flagCells = points.map((p) => {
        const wrap = document.createElement("div");
        wrap.className = "flag";
        wrap.innerHTML = `<span class="id">${p.def.id}</span><div class="cap"><div class="cap-fill"></div></div>`;
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
      cell.fill.style.width = `${Math.abs(p.meter) * 100}%`;
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
    // `hidden` the null branch above puts back on.
    this.capture.className = `zone ${status.owner}${status.contested ? " contested" : ""}`;
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
   * Crosshair state, pushed every frame. The ring's diameter IS the current
   * bullet spread in screen pixels, so recoil bloom is visible as the ring
   * opening up and settling as it bleeds off.
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
    this.crosshairRing.style.width = `${size}px`;
    this.crosshairRing.style.height = `${size}px`;
  }

  flashHitmarker(): void {
    this.hitmarker.classList.remove("hidden");
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
    el.innerHTML = `<span class="k">${killer}</span><span class="x">&#9587;</span><span class="v">${victim}</span>`;
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
    const row = (t: number) => `
      <tr class="${t === rows.playerTeam ? "mine" : "theirs"}">
        <td class="name">${rows.teams[t].toUpperCase()}</td>
        <td>${rows.tickets[t]}</td>
        <td>${rows.flags[t]}</td>
        <td>${rows.kills[t]}</td>
        <td>${rows.deaths[t]}</td>
      </tr>`;
    this.scoreboard.innerHTML = `
      <table>
        <tr><th>TEAM</th><th>TICKETS</th><th>FLAGS</th><th>KILLS</th><th>LOSSES</th></tr>
        ${row(0)}${row(1)}
      </table>
      <div class="you">YOU &mdash; ${rows.playerKills} kills, ${rows.playerDeaths} deaths</div>
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

  setLockHint(visible: boolean): void {
    this.lockHint.classList.toggle("hidden", !visible);
  }

  /**
   * The main menu, including the difficulty picker.
   *
   * `#overlay` is inside a `pointer-events: none` HUD and does not opt back in
   * (only `#deploy` does), so the difficulty row asks for pointer events on
   * itself alone — the rest of the overlay stays inert and a stray click can
   * never be mistaken for a UI action.
   */
  showMenu(difficulties: readonly string[], selected: number): void {
    this.overlay.classList.remove("hidden");
    const tiers = difficulties
      .map(
        (name, i) =>
          `<button class="tier${i === selected ? " on" : ""}" data-tier="${i}">${name}</button>`,
      )
      .join("");
    this.overlay.innerHTML = `
      <h1>HOLLOWMERE</h1>
      <p class="tagline">Conquest — take and hold five points against the Blight</p>
      <div class="difficulty">
        <span class="label">Enemy skill</span>
        ${tiers}
        <span class="hint">&larr; &rarr; or D-pad</span>
      </div>
      <table class="controls">
        <tr><th></th><th>Gamepad</th><th>Keyboard / Mouse</th></tr>
        <tr><td>Move</td><td>Left stick</td><td>WASD</td></tr>
        <tr><td>Look</td><td>Right stick</td><td>Mouse</td></tr>
        <tr><td>Aim (ADS)</td><td>LT</td><td>Right-click</td></tr>
        <tr><td>Shoot</td><td>RT</td><td>Left-click</td></tr>
        <tr><td>Jump</td><td>A / ✕</td><td>Space</td></tr>
        <tr><td>Reload</td><td>X / ▢</td><td>R</td></tr>
        <tr><td>Sprint</td><td>L3</td><td>Shift</td></tr>
      </table>
      <p class="prompt">Click, press Enter, or press Start to begin</p>
    `;
    this.overlay
      .querySelectorAll<HTMLElement>("button.tier")
      .forEach((btn) => {
        btn.onclick = () => this.onDifficulty(Number(btn.dataset.tier));
      });
  }

  /** Wired by Game: the player picked a difficulty tier from the menu. */
  onDifficulty: (tier: number) => void = () => {};

  showRoundOver(
    winnerName: string,
    playerWon: boolean,
    tickets0: number,
    tickets1: number,
  ): void {
    this.overlay.classList.remove("hidden");
    this.overlay.innerHTML = `
      <h1 class="${playerWon ? "win" : "dead"}">${playerWon ? "VICTORY" : "DEFEAT"}</h1>
      <p class="tagline">${winnerName} hold Hollowmere. Reinforcements remaining: ${tickets0} / ${tickets1}.</p>
      <p class="prompt">Click, press Enter, or press Start for another round</p>
    `;
  }

  hideOverlay(): void {
    this.overlay.classList.add("hidden");
  }
}
