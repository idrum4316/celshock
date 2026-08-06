/**
 * SettingsScreen.ts — The settings screen: a list of toggles over a scrim.
 * Owns #settings and its own row selection; owns no setting, and applies
 * nothing — every change leaves through `onToggle` and comes back as a
 * `setValues` from Game, so the screen can never disagree with what is stored.
 * Invariants: the rows are DATA (`ROWS`), never markup — this screen exists to
 * grow, and a hardcoded row is a row the keyboard navigation does not know
 * about. Above #loadout's z-index, because it is reachable from the pause lid
 * and has to cover everything the pause card sits over.
 */
import "./settings.css";
import type { Settings } from "../core/settings";

/**
 * One line on the screen. A `heading` opens a section and carries no control;
 * everything else is a labelled toggle bound to one field of `Settings`.
 *
 * The grouping is here before it is strictly needed. Two rows do not need a
 * DISPLAY heading — twelve will, and retrofitting one means re-deriving the
 * navigation around rows that are not selectable, which is exactly the kind of
 * thing that is cheap now and fiddly later.
 */
type Row =
  | { heading: string }
  | { key: keyof Settings; label: string; hint: string };

const isToggle = (r: Row): r is Extract<Row, { key: keyof Settings }> =>
  "key" in r;

const ROWS: readonly Row[] = [
  { heading: "Display" },
  {
    key: "fpsCounter",
    label: "FPS counter",
    hint: "Rate, frame time and 1% low",
  },
  {
    key: "motionBlur",
    label: "Motion blur",
    hint: "Smears the view on a fast turn",
  },
];

/** The selectable rows, in screen order — headings are not stepped onto. */
const TOGGLES = ROWS.filter(isToggle);

export class SettingsScreen {
  private root: HTMLElement;
  private body: HTMLElement;
  private values: Settings;
  /** Which toggle the arrow keys are on. Indexes `TOGGLES`, not `ROWS`. */
  private row = 0;

  /** Wired by Game. Reports a change; does not apply or redraw it. */
  onToggle: (key: keyof Settings, value: boolean) => void = () => {};
  onClose: () => void = () => {};

  constructor(initial: Settings) {
    this.values = { ...initial };
    this.root = document.createElement("div");
    this.root.id = "settings";
    this.root.className = "hidden";
    this.root.innerHTML = `
      <div class="se-panel frame">
        <h2>SETTINGS</h2>
        <div class="se-body"></div>
        <p class="se-foot">
          <span><kbd>&uarr;</kbd><kbd>&darr;</kbd> row</span>
          <span><kbd>&larr;</kbd><kbd>&rarr;</kbd><kbd>Enter</kbd> toggle</span>
          <button class="se-back"><kbd>Esc</kbd><kbd class="pad">B</kbd> Back</button>
        </p>
      </div>
    `;
    document.getElementById("hud")!.appendChild(this.root);
    this.body = this.root.querySelector(".se-body")!;
    // `click` is safe on a button INSIDE a screen that is already up: the
    // pointerdown rule the menu's kit button documents is about buttons that
    // race the overlay's own mouse-down confirm on the way in.
    this.root.querySelector<HTMLElement>("button.se-back")!.onclick = () =>
      this.onClose();
    this.draw();
  }

  /**
   * The stored settings, pushed by Game. This is the only way the screen
   * learns a value changed — including changes it asked for itself, which is
   * what keeps a rejected or clamped setting from showing as applied.
   */
  setValues(values: Settings): void {
    this.values = { ...values };
    this.draw();
  }

  show(): void {
    // Always open on the first row, for the reason the kit screen documents: a
    // screen that remembers a cursor from three sessions ago is one you have
    // to read before you can use it.
    this.row = 0;
    this.root.classList.remove("hidden");
    this.draw();
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  get visible(): boolean {
    return !this.root.classList.contains("hidden");
  }

  /** Steps the highlighted row, wrapping at both ends — the menu's up/down. */
  moveRow(delta: number): void {
    const n = TOGGLES.length;
    if (n === 0) return;
    this.row = (this.row + delta + n) % n;
    this.draw();
  }

  /**
   * Flips the highlighted row. Left/right and Enter all land here: a boolean
   * has nothing to step through, so "previous" and "next" are the same move
   * and pretending otherwise would make left/right feel broken on the ends.
   */
  toggleRow(): void {
    const row = TOGGLES[this.row];
    if (row) this.onToggle(row.key, !this.values[row.key]);
  }

  /**
   * Rebuilds the list rather than patching it — it is redrawn only on a pick
   * or a row move, and the alternative is three places that have to agree on
   * which row carries the highlight.
   */
  private draw(): void {
    let i = -1;
    this.body.innerHTML = ROWS.map((r) => {
      if (!isToggle(r)) return `<h3 class="se-head">${r.heading}</h3>`;
      i += 1;
      const on = this.values[r.key];
      return `
        <div class="se-row${i === this.row ? " active" : ""}" data-row="${i}">
          <span class="se-label">${r.label}</span>
          <div class="se-choice">
            <button class="se-opt${on ? "" : " on"}" data-key="${r.key}" data-on="0">Off</button>
            <button class="se-opt${on ? " on" : ""}" data-key="${r.key}" data-on="1">On</button>
          </div>
          <span class="se-hint">${r.hint}</span>
        </div>`;
    }).join("");

    this.body.querySelectorAll<HTMLElement>("button.se-opt").forEach((btn) => {
      btn.onclick = () =>
        this.onToggle(btn.dataset.key as keyof Settings, btn.dataset.on === "1");
    });
    // Hovering a row moves the keyboard selection with it, so the highlighted
    // row and the one the arrows are about to step can never disagree — the
    // rule the pause list and the kit screen's slots both follow.
    this.body.querySelectorAll<HTMLElement>(".se-row").forEach((el) => {
      el.onmouseenter = () => {
        const next = Number(el.dataset.row);
        if (next !== this.row) {
          this.row = next;
          this.draw();
        }
      };
    });
  }
}
