/**
 * HUD.ts — In-game DOM overlay: health/ammo, tickets, flag strip, crosshair,
 * hitmarker, damage vignette, toasts, killfeed, scoreboard, menu/round-over.
 * Invariants: Game pushes state every frame (setHealth/setAmmo/setFlags/...) —
 * setting HUD state from anywhere else is overwritten next tick. Pure DOM
 * manipulation; reads ControlPoint data, never imports game systems beyond
 * types. Transient elements (toasts, killfeed) self-remove via setTimeout.
 */
import type { ControlPoint } from "../systems/ConquestSystem";

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
  private message: HTMLElement;
  private toasts: HTMLElement;
  private overlay: HTMLElement;
  private lockHint: HTMLElement;
  private killfeed: HTMLElement;
  private scoreboard: HTMLElement;

  private hitT = 0;
  private vignetteT = 0;
  private messageT = 0;

  constructor() {
    this.root = document.getElementById("hud")!;
    this.root.innerHTML = `
      <div id="ticket-bar"></div>
      <div id="flag-strip"></div>
      <div id="crosshair"><div class="dot"></div><span class="ring"></span></div>
      <div id="hitmarker" class="hidden">✕</div>
      <div id="vignette"></div>
      <div id="message" class="hidden"></div>
      <div id="toasts"></div>
      <div id="killfeed"></div>
      <div id="scoreboard" class="hidden"></div>
      <div id="lock-hint" class="hidden">Click to capture the mouse</div>
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
    this.message = document.getElementById("message")!;
    this.toasts = document.getElementById("toasts")!;
    this.overlay = document.getElementById("overlay")!;
    this.lockHint = document.getElementById("lock-hint")!;
    this.killfeed = document.getElementById("killfeed")!;
    this.scoreboard = document.getElementById("scoreboard")!;
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
   * Crosshair state, pushed every frame. The ring's diameter IS the current
   * bullet spread in screen pixels, so recoil bloom is visible as the ring
   * opening up and settling as it bleeds off.
   */
  setCrosshair(ads: boolean, spreadPx: number): void {
    this.crosshair.classList.toggle("ads", ads);
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

  setLockHint(visible: boolean): void {
    this.lockHint.classList.toggle("hidden", !visible);
  }

  showMenu(): void {
    this.overlay.classList.remove("hidden");
    this.overlay.innerHTML = `
      <h1>HOLLOWMERE</h1>
      <p class="tagline">Conquest — take and hold five points against the Blight</p>
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
  }

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
