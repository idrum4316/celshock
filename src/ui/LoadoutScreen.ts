/**
 * LoadoutScreen.ts — The kit screen: pick a weapon, fit an optic, read what
 * the trade costs.
 * Owns: its own DOM under `#hud`, the two-slot selection model, and the stat
 * table it derives from `CONFIG.weapons`. It reports choices and redraws
 * nothing on its own — `Game` applies a pick and calls `setFit` back, so the
 * highlighted button can never get ahead of the weapon in the player's hands.
 *
 * A screen rather than a row, because there are two slots now and the row it
 * replaces was a strip of buttons wedged under a menu that already had a
 * difficulty picker on it. It is reachable from the MAIN MENU and from the
 * DEPLOY screen, and deliberately not from the pause menu: a round you are
 * already standing in is not somewhere you get to change what you are
 * carrying. Nothing enforces that with a flag; the states that can open it are
 * the states that offer the button.
 *
 * The stat bars are DERIVED from the weapon table rather than authored. Each
 * one is that weapon's number against the best number any weapon has, so a
 * third weapon added to CONFIG re-scales the chart instead of dating it.
 *
 * CSS contract: `#hud` is `pointer-events: none`, so this overlay opts back in
 * — the same carve-out `#deploy` takes.
 */
import { CONFIG } from "../config";
import { SIGHT_IDS, type SightId } from "../entities/sights";
import { WEAPON_IDS, type WeaponId } from "../entities/weapons";

/** Which half of the kit the keyboard/pad is currently stepping through. */
type Slot = "weapon" | "sight";
const SLOTS: readonly Slot[] = ["weapon", "sight"];

/**
 * What each weapon is for, in the player's terms. Copy, not configuration —
 * every number these describe lives in `CONFIG.weapons` and is read from there
 * for the buttons and the bars rather than written twice.
 */
const WEAPON_BLURBS: Record<WeaponId, string> = {
  rifle:
    "A full-power battle rifle. Four rounds kill at any distance you can see a target at, and it holds its group across the valley — but the magazine is short and every round has to be worth its recoil.",
  smg: "Pistol-calibre, and it empties a long magazine in under three seconds. Quickest to the shoulder, cheapest to miss with, and past the width of a street it will not group whatever optic is on top of it.",
};

/**
 * What each optic is for. The numbers these describe live in `CONFIG.sights`,
 * and the magnification on each button is read from there.
 */
const SIGHT_BLURBS: Record<SightId, string> = {
  iron: "Rear aperture over a hooded post. The widest picture on the weapon and the fastest to the shoulder — best where the fight is already close.",
  holo: "A lit ring and dot floating in a tube optic. The issued sight: enough magnification to pick a target out of the dark, little enough to swing between two.",
  scope:
    "Telescopic, with a duplex reticle. Slow to bring up and a tunnel to look down, and the only thing on offer that will show you a body at the far end of the valley.",
};

/** One bar on the stat chart: a caption, the figure, and its share of the best. */
interface StatRow {
  label: string;
  value: string;
  frac: number;
}

/** Formats a magnification the way a lens is marked. */
function magLabel(id: SightId): string {
  return `${CONFIG.sights[id].magnification.toFixed(1)}×`;
}

/** The largest value of one field across every weapon — the bars' full scale. */
function best(pick: (w: (typeof CONFIG.weapons)[WeaponId]) => number): number {
  return Math.max(...WEAPON_IDS.map((id) => pick(CONFIG.weapons[id])));
}

/** The smallest, for the fields where less is better (spread). */
function least(pick: (w: (typeof CONFIG.weapons)[WeaponId]) => number): number {
  return Math.min(...WEAPON_IDS.map((id) => pick(CONFIG.weapons[id])));
}

/**
 * The chart for one weapon. Accuracy is the AIMED spread inverted — a bar
 * that grows with the number would rank the SMG as the accurate one — and is
 * shown in degrees, which is the only unit that means anything at a glance.
 */
function weaponStats(id: WeaponId): StatRow[] {
  const w = CONFIG.weapons[id];
  const deg = (rad: number) => ((rad * 180) / Math.PI).toFixed(2);
  return [
    { label: "Damage", value: `${w.damage}`, frac: w.damage / best((x) => x.damage) },
    {
      label: "Rate",
      value: `${w.fireRate}/s`,
      frac: w.fireRate / best((x) => x.fireRate),
    },
    {
      label: "Magazine",
      value: `${w.magSize}`,
      frac: w.magSize / best((x) => x.magSize),
    },
    {
      label: "Accuracy",
      value: `±${deg(w.spreadAds)}°`,
      frac: least((x) => x.spreadAds) / w.spreadAds,
    },
    { label: "Range", value: `${w.range} m`, frac: w.range / best((x) => x.range) },
    {
      label: "Handling",
      value: `${w.adsSpeedMult.toFixed(2)}×`,
      frac: w.adsSpeedMult / best((x) => x.adsSpeedMult),
    },
  ];
}

/** The kit as one line, for the menu button and the HUD's magazine caption. */
export function kitLabel(weapon: WeaponId, sight: SightId): string {
  return `${CONFIG.weapons[weapon].name} · ${CONFIG.sights[sight].name}`;
}

export class LoadoutScreen {
  private root: HTMLElement;
  private body: HTMLElement;
  private weapon: WeaponId = WEAPON_IDS[0];
  private sight: SightId = SIGHT_IDS[0];
  /** Which row the d-pad is on. Left/right steps inside it; up/down swaps it. */
  private slot: Slot = "weapon";

  /** Wired by Game. Each reports a choice; none of them redraws. */
  onWeapon: (id: WeaponId) => void = () => {};
  onSight: (id: SightId) => void = () => {};
  onClose: () => void = () => {};

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "loadout";
    this.root.className = "hidden";
    this.root.innerHTML = `
      <h2>LOADOUT</h2>
      <div class="lo-body"></div>
      <p class="lo-foot">
        <span><kbd>&larr;</kbd><kbd>&rarr;</kbd> choose</span>
        <span><kbd>&uarr;</kbd><kbd>&darr;</kbd> slot</span>
        <button class="lo-back"><kbd>Enter</kbd> Done</button>
      </p>
    `;
    document.getElementById("hud")!.appendChild(this.root);
    this.body = this.root.querySelector(".lo-body")!;
    // A pick is applied the moment it is made, so this closes and nothing
    // else. `click` is safe here where the buttons that OPEN this screen need
    // pointerdown: the state under it takes its confirm from a mouse-down,
    // and by the time a click fires that button is already back up.
    this.root.querySelector<HTMLElement>("button.lo-back")!.onclick = () =>
      this.onClose();
    this.draw();
  }

  /** Shows the kit that is actually fitted. Called by Game, never by a click. */
  setFit(weapon: WeaponId, sight: SightId): void {
    if (weapon === this.weapon && sight === this.sight) return;
    this.weapon = weapon;
    this.sight = sight;
    this.draw();
  }

  show(): void {
    // Always open on the weapon row: it is the choice that changes the other
    // one's meaning, and a screen that remembers where you left the cursor
    // three deploys ago is a screen you have to look at before you can use it.
    this.slot = "weapon";
    this.root.classList.remove("hidden");
    this.draw();
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  get visible(): boolean {
    return !this.root.classList.contains("hidden");
  }

  /** Steps the active slot — the menu's up/down. */
  moveSlot(delta: number): void {
    const i = SLOTS.indexOf(this.slot);
    this.slot = SLOTS[(i + delta + SLOTS.length) % SLOTS.length];
    this.draw();
  }

  /**
   * Steps the choice inside the active slot, wrapping at both ends — the
   * menu's left/right. Reports it and leaves the drawing to `setFit`.
   */
  cycle(delta: number): void {
    if (this.slot === "weapon") {
      const i = WEAPON_IDS.indexOf(this.weapon);
      this.onWeapon(WEAPON_IDS[(i + delta + WEAPON_IDS.length) % WEAPON_IDS.length]);
    } else {
      const i = SIGHT_IDS.indexOf(this.sight);
      this.onSight(SIGHT_IDS[(i + delta + SIGHT_IDS.length) % SIGHT_IDS.length]);
    }
  }

  /**
   * Rebuilds the whole body rather than patching it. It is two rows of
   * buttons and six bars, redrawn only when something is picked — and the
   * alternative is four places that have to agree on which button carries the
   * highlight.
   */
  private draw(): void {
    const weapons = WEAPON_IDS.map((id) => {
      const w = CONFIG.weapons[id];
      return `
        <button class="lo-opt${id === this.weapon ? " on" : ""}" data-weapon="${id}">
          <b>${w.name}</b><i>${w.damage} dmg · ${w.fireRate}/s</i>
        </button>`;
    }).join("");
    const sights = SIGHT_IDS.map(
      (id) => `
        <button class="lo-opt${id === this.sight ? " on" : ""}" data-sight="${id}">
          <b>${CONFIG.sights[id].name}</b><i>${magLabel(id)}</i>
        </button>`,
    ).join("");
    const bars = weaponStats(this.weapon)
      .map(
        (s) => `
        <div class="lo-stat">
          <span class="lo-stat-name">${s.label}</span>
          <span class="lo-bar"><u style="width:${(s.frac * 100).toFixed(1)}%"></u></span>
          <span class="lo-stat-val">${s.value}</span>
        </div>`,
      )
      .join("");

    this.body.innerHTML = `
      <div class="lo-slots">
        <div class="lo-slot${this.slot === "weapon" ? " active" : ""}" data-slot="weapon">
          <span class="lo-slot-name">Weapon</span>
          <div class="lo-opts">${weapons}</div>
        </div>
        <div class="lo-slot${this.slot === "sight" ? " active" : ""}" data-slot="sight">
          <span class="lo-slot-name">Optic</span>
          <div class="lo-opts">${sights}</div>
        </div>
      </div>
      <div class="lo-detail frame">
        <div class="lo-stats">${bars}</div>
        <div class="lo-blurbs">
          <p class="lo-blurb">${WEAPON_BLURBS[this.weapon]}</p>
          <p class="lo-blurb dim">${SIGHT_BLURBS[this.sight]}</p>
        </div>
      </div>
    `;

    this.body.querySelectorAll<HTMLElement>("button.lo-opt").forEach((btn) => {
      btn.onclick = () => {
        const w = btn.dataset.weapon;
        if (w) this.onWeapon(w as WeaponId);
        else this.onSight(btn.dataset.sight as SightId);
      };
    });
    // Hovering a row moves the keyboard slot with it, so the highlighted row
    // and the one the arrow keys are about to step can never disagree — the
    // same rule the pause menu's list follows.
    this.body.querySelectorAll<HTMLElement>(".lo-slot").forEach((row) => {
      row.onmouseenter = () => {
        const next = row.dataset.slot as Slot;
        if (next !== this.slot) {
          this.slot = next;
          this.draw();
        }
      };
    });
  }
}
