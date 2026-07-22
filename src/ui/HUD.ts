/**
 * DOM-based HUD: health/ammo, room counter, boss bar, crosshair, hitmarker,
 * damage vignette, toasts, and full-screen overlays (menu/death/victory).
 * Styling lives in index.html.
 */
export class HUD {
  private root: HTMLElement;
  private healthFill: HTMLElement;
  private healthText: HTMLElement;
  private ammoText: HTMLElement;
  private roomText: HTMLElement;
  private bossWrap: HTMLElement;
  private bossName: HTMLElement;
  private bossFill: HTMLElement;
  private crosshair: HTMLElement;
  private hitmarker: HTMLElement;
  private vignette: HTMLElement;
  private message: HTMLElement;
  private toasts: HTMLElement;
  private overlay: HTMLElement;
  private lockHint: HTMLElement;

  private hitT = 0;
  private vignetteT = 0;
  private messageT = 0;

  constructor() {
    this.root = document.getElementById("hud")!;
    this.root.innerHTML = `
      <div id="room-info"></div>
      <div id="boss-bar-wrap" class="hidden">
        <div id="boss-name"></div>
        <div class="bar boss"><div id="boss-fill" class="fill"></div></div>
      </div>
      <div id="crosshair"><div class="dot"></div><span class="ring"></span></div>
      <div id="hitmarker" class="hidden">✕</div>
      <div id="vignette"></div>
      <div id="message" class="hidden"></div>
      <div id="toasts"></div>
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
    this.roomText = document.getElementById("room-info")!;
    this.bossWrap = document.getElementById("boss-bar-wrap")!;
    this.bossName = document.getElementById("boss-name")!;
    this.bossFill = document.getElementById("boss-fill")!;
    this.crosshair = document.getElementById("crosshair")!;
    this.hitmarker = document.getElementById("hitmarker")!;
    this.vignette = document.getElementById("vignette")!;
    this.message = document.getElementById("message")!;
    this.toasts = document.getElementById("toasts")!;
    this.overlay = document.getElementById("overlay")!;
    this.lockHint = document.getElementById("lock-hint")!;
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

  setRoom(index: number, total: number, themeName: string): void {
    this.roomText.textContent = `ROOM ${index} / ${total} — ${themeName.toUpperCase()}`;
  }

  setBoss(name: string | null, fraction: number): void {
    if (name === null) {
      this.bossWrap.classList.add("hidden");
      return;
    }
    this.bossWrap.classList.remove("hidden");
    this.bossName.textContent = name.toUpperCase();
    this.bossFill.style.width = `${Math.max(0, fraction) * 100}%`;
  }

  setAds(ads: boolean): void {
    this.crosshair.classList.toggle("ads", ads);
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

  setLockHint(visible: boolean): void {
    this.lockHint.classList.toggle("hidden", !visible);
  }

  showMenu(): void {
    this.overlay.classList.remove("hidden");
    this.overlay.innerHTML = `
      <h1>CELSHOCK</h1>
      <p class="tagline">A cel-shaded roguelike third-person shooter</p>
      <table class="controls">
        <tr><th></th><th>Gamepad</th><th>Keyboard / Mouse</th></tr>
        <tr><td>Move</td><td>Left stick</td><td>WASD</td></tr>
        <tr><td>Look</td><td>Right stick</td><td>Mouse</td></tr>
        <tr><td>Aim (ADS)</td><td>LT</td><td>Right-click</td></tr>
        <tr><td>Shoot</td><td>RT</td><td>Left-click</td></tr>
        <tr><td>Jump</td><td>A / ✕</td><td>Space</td></tr>
        <tr><td>Reload</td><td>X / ▢</td><td>R</td></tr>
      </table>
      <p class="prompt">Click, press Enter, or press Start to begin</p>
    `;
  }

  showGameOver(roomIndex: number, total: number): void {
    this.overlay.classList.remove("hidden");
    this.overlay.innerHTML = `
      <h1 class="dead">YOU DIED</h1>
      <p class="tagline">Fell in room ${roomIndex} of ${total}. The run is lost — that's the roguelike deal.</p>
      <p class="prompt">Click, press Enter, or press Start for a new run</p>
    `;
  }

  showVictory(): void {
    this.overlay.classList.remove("hidden");
    this.overlay.innerHTML = `
      <h1 class="win">RUN COMPLETE</h1>
      <p class="tagline">Boss down. Every room cleared.</p>
      <p class="prompt">Click, press Enter, or press Start for another run</p>
    `;
  }

  hideOverlay(): void {
    this.overlay.classList.add("hidden");
  }
}
