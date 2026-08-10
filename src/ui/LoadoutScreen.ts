/**
 * LoadoutScreen.ts — The kit screen: pick a weapon, fit an optic, turn the
 * thing over in your hands, and read what the trade costs.
 * Owns: its own DOM under `#hud`, the two-slot selection model, the stat
 * table it derives from `CONFIG.weapons`, and the pointer drags over its
 * stage. It reports choices and redraws nothing on its own — `Game` applies a
 * pick and calls `setFit` back, so the highlighted button can never get ahead
 * of the weapon in the player's hands.
 *
 * The weapon on the right is not a picture: it is the real viewmodel, the one
 * that will be in the player's hands, posed on a turntable by `ViewModel` and
 * drawn by the live scene behind this overlay. Two consequences run through
 * the file:
 * - **The stage is a hole in the scrim, not a panel.** The weapon is on the
 *   canvas and every part of this screen is above it, so the stage half carries
 *   no background of its own — only a vignette to frame it. Which is also why
 *   `show()` marks `#hud` and the CSS hides the menu and the deploy map while
 *   the kit is up: they are DOM too, and either would paint over the weapon.
 * - **The stage's geometry is shared with `CONFIG.viewmodel.inspect`.** The
 *   panel column's width is what puts the stage's centre 0.46 of the way
 *   across the viewport, which is the anchor the weapon is placed at. Both
 *   sides are fractions of the viewport, so a resize moves them together.
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
 * "Any weapon" means `PRIMARY_WEAPON_IDS` throughout — the sidearm is in the
 * same table and is not a choice, so it appears on neither the buttons nor the
 * scale. Ranking against a weapon nobody can decline would shrink every bar on
 * the screen to say something the player cannot act on.
 *
 * CSS contract: `#hud` is `pointer-events: none`, so this overlay opts back in
 * — the same carve-out `#deploy` takes.
 */
import "./loadout.css";
import { CONFIG } from "../config";
import { SIGHT_IDS, type SightId } from "../entities/sights";
import {
  PRIMARY_WEAPON_IDS,
  type PrimaryWeaponId,
  type WeaponId,
} from "../entities/weapons";

/** Which half of the kit the keyboard/pad is currently stepping through. */
type Slot = "weapon" | "sight";
const SLOTS: readonly Slot[] = ["weapon", "sight"];

/**
 * What each weapon is for, in the player's terms. Copy, not configuration —
 * every number these describe lives in `CONFIG.weapons` and is read from there
 * for the buttons and the bars rather than written twice.
 */
const WEAPON_BLURBS: Record<PrimaryWeaponId, string> = {
  rifle:
    "A full-power battle rifle. Four rounds kill at any distance you can see a target at, and it holds its group across the valley — but the magazine is short and every round has to be worth its recoil.",
  smg: "Pistol-calibre, and it empties a long magazine in under three seconds. Quickest to the shoulder, cheapest to miss with, and past the width of a street it will not group whatever optic is on top of it.",
  dmr: "Semi-automatic: one round per trigger pull, and two rounds anywhere on a man will do it. The tightest group and the longest reach in the kit, paid for with a kick that has to be ridden back down before the second shot means anything.",
};

/**
 * What each optic is for. The numbers these describe live in `CONFIG.sights`,
 * and the magnification on each button is read from there.
 */
const SIGHT_BLURBS: Record<SightId, string> = {
  reflex:
    "A lit dot in an open frame, and the least magnification on offer. Nothing to line up and nothing in the way — the clearest picture in the kit, a fraction slower up than the irons already standing on the rail.",
  iron: "Rear aperture over a hooded post. Nothing to switch on and the fastest to the shoulder, paid for with a post that covers whatever it is aimed at.",
  holo: "A lit ring and dot floating in a tube optic. The issued sight: enough magnification to pick a target out of the dark, little enough to swing between two.",
  prism:
    "A short prismatic body on an integral mount, with an etched chevron. Enough magnification to make a body across the square worth shooting at, and enough field left to swing onto the next one.",
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
  return Math.max(...PRIMARY_WEAPON_IDS.map((id) => pick(CONFIG.weapons[id])));
}

/** The smallest, for the fields where less is better (spread). */
function least(pick: (w: (typeof CONFIG.weapons)[WeaponId]) => number): number {
  return Math.min(...PRIMARY_WEAPON_IDS.map((id) => pick(CONFIG.weapons[id])));
}

/**
 * The chart for one weapon. Accuracy is the AIMED spread inverted — a bar
 * that grows with the number would rank the SMG as the accurate one — and is
 * shown in degrees, which is the only unit that means anything at a glance.
 *
 * Rate is left as a bare figure even though it means something different on a
 * semi-automatic (a ceiling on the trigger finger, not a cadence): the value
 * column is 52px and "3/s semi" does not fit in it. The fire mode is on the
 * weapon's own button instead, next to the number it qualifies.
 */
function weaponStats(id: PrimaryWeaponId): StatRow[] {
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
  /** The caption under the weapon on the stage. */
  private stageCap: HTMLElement;
  /**
   * Drag accumulated since `Game` last read it. Pixels, not radians — how far
   * a pixel turns the weapon is the viewmodel's business, and this screen has
   * no opinion about it.
   */
  private dragX = 0;
  private dragY = 0;
  private weapon: PrimaryWeaponId = PRIMARY_WEAPON_IDS[0];
  private sight: SightId = SIGHT_IDS[0];
  /** Which row the d-pad is on. Left/right steps inside it; up/down swaps it. */
  private slot: Slot = "weapon";

  /** Wired by Game. Each reports a choice; none of them redraws. */
  onWeapon: (id: PrimaryWeaponId) => void = () => {};
  onSight: (id: SightId) => void = () => {};
  onClose: () => void = () => {};

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "loadout";
    this.root.className = "hidden";
    this.root.innerHTML = `
      <div class="lo-scrim"></div>
      <div class="lo-panel">
        <h2>LOADOUT</h2>
        <div class="lo-body"></div>
        <p class="lo-foot">
          <span><kbd>&larr;</kbd><kbd>&rarr;</kbd><kbd class="pad">Stick</kbd> choose</span>
          <span><kbd>&uarr;</kbd><kbd>&darr;</kbd><kbd class="pad">Stick</kbd> slot</span>
          <button class="lo-back"><kbd>Enter</kbd><kbd class="pad">B</kbd> Done</button>
        </p>
      </div>
      <div class="lo-stage">
        <span class="lo-stage-cap"></span>
        <span class="lo-stage-hint">Drag &middot; right stick to turn</span>
      </div>
    `;
    document.getElementById("hud")!.appendChild(this.root);
    this.body = this.root.querySelector(".lo-body")!;
    this.stageCap = this.root.querySelector(".lo-stage-cap")!;
    this.bindStage(this.root.querySelector<HTMLElement>(".lo-stage")!);
    // A pick is applied the moment it is made, so this closes and nothing
    // else. `click` is safe here where the buttons that OPEN this screen need
    // pointerdown: the state under it takes its confirm from a mouse-down,
    // and by the time a click fires that button is already back up.
    this.root.querySelector<HTMLElement>("button.lo-back")!.onclick = () =>
      this.onClose();
    this.draw();
  }

  /**
   * Turns the weapon under a mouse drag.
   *
   * `setPointerCapture` is what makes a drag that leaves the stage — over the
   * panel, off the window — keep turning the weapon instead of stopping dead
   * at the edge, which is the whole difference between a handle and a hotspot.
   * Deltas are taken from `clientX/Y` rather than `movementX/Y`: the pointer is
   * not locked here, and the movement fields are the ones this game reads only
   * when it is.
   */
  private bindStage(stage: HTMLElement): void {
    let last: { x: number; y: number } | null = null;
    stage.addEventListener("pointerdown", (e) => {
      last = { x: e.clientX, y: e.clientY };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add("turning");
    });
    stage.addEventListener("pointermove", (e) => {
      if (!last) return;
      this.dragX += e.clientX - last.x;
      this.dragY += e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
    });
    const end = () => {
      last = null;
      stage.classList.remove("turning");
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
  }

  /**
   * The drag since the last call, in pixels, and zeroed by reading it — the
   * same consume-on-read shape `InputManager` gives mouse look, so a frame
   * that never ran cannot turn the weapon twice.
   */
  consumeDrag(): { x: number; y: number } {
    const drag = { x: this.dragX, y: this.dragY };
    this.dragX = 0;
    this.dragY = 0;
    return drag;
  }

  /** Shows the kit that is actually fitted. Called by Game, never by a click. */
  setFit(weapon: PrimaryWeaponId, sight: SightId): void {
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
    // The screens this one covers are DOM, and the weapon it shows is not:
    // either of them left up would paint over the stage. The CSS carries the
    // rule; this is the flag it reads.
    document.getElementById("hud")!.classList.add("kitting");
    this.draw();
  }

  hide(): void {
    this.root.classList.add("hidden");
    document.getElementById("hud")!.classList.remove("kitting");
    // A drag interrupted by the screen closing must not turn the weapon on the
    // next open.
    this.dragX = 0;
    this.dragY = 0;
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
      const n = PRIMARY_WEAPON_IDS.length;
      const i = PRIMARY_WEAPON_IDS.indexOf(this.weapon);
      this.onWeapon(PRIMARY_WEAPON_IDS[(i + delta + n) % n]);
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
    const weapons = PRIMARY_WEAPON_IDS.map((id) => {
      const w = CONFIG.weapons[id];
      return `
        <button class="lo-opt${id === this.weapon ? " on" : ""}" data-weapon="${id}">
          <b>${w.name}</b><i>${w.damage} dmg · ${w.fireRate}/s ${w.semiAuto ? "semi" : "auto"}</i>
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

    // The stage's own caption: what is actually on the turntable, named where
    // the eye already is rather than only over on the buttons.
    this.stageCap.textContent = kitLabel(this.weapon, this.sight);

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
        if (w) this.onWeapon(w as PrimaryWeaponId);
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
