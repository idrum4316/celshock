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
import { CONFIG } from "../config";
import type { Settings } from "../core/settings";

/**
 * One line on the screen. A `heading` opens a section and carries no control;
 * everything else is a labelled CHOICE bound to one field of `Settings`.
 *
 * **A toggle is a two-option choice, which is why there is only one control
 * type here rather than two.** The markup was already an N-button group with
 * Off and On in it, so an enumeration needed no second renderer, no second
 * key handler and no second hit-testing path — only a longer list.
 *
 * `ControlRow` is generic over the key so each row's options are typed against
 * that key's own value; `AnyControl` distributes it into a union, which is what
 * stops `renderScale` being given `true`. The pairing is enforced HERE, in the
 * table, because it cannot be at the callback: `onChange` has to be one
 * function over every key.
 *
 * The grouping is here before it is strictly needed. Two rows do not need a
 * DISPLAY heading — twelve will, and retrofitting one means re-deriving the
 * navigation around rows that are not selectable, which is exactly the kind of
 * thing that is cheap now and fiddly later.
 */
interface ControlRow<K extends keyof Settings> {
  key: K;
  label: string;
  hint: string;
  options: readonly { value: Settings[K]; label: string }[];
}

type AnyControl = { [K in keyof Settings]: ControlRow<K> }[keyof Settings];

type Row = { heading: string } | AnyControl;

const isControl = (r: Row): r is AnyControl => "key" in r;

/** Off/On, the shape four of the five rows share. */
const OFF_ON = [
  { value: false, label: "Off" },
  { value: true, label: "On" },
] as const;

const ROWS: readonly Row[] = [
  { heading: "Display" },
  {
    key: "renderScale",
    label: "Render scale",
    hint: "Share of the display's own pixels the scene is drawn at",
    // Straight off the config's ladder, so the screen cannot offer a rung the
    // store would refuse to remember.
    options: CONFIG.graphics.renderScales.map((v) => ({
      value: v,
      label: `${Math.round(v * 100)}%`,
    })),
  },
  {
    key: "fpsCounter",
    label: "FPS counter",
    hint: "Rate, frame time and 1% low",
    options: OFF_ON,
  },
  {
    key: "motionBlur",
    label: "Motion blur",
    hint: "Smears the view on a fast turn",
    options: OFF_ON,
  },
  {
    key: "horrorGrade",
    label: "Horror filter",
    hint: "Vignette, grain, and the red damage flash",
    options: OFF_ON,
  },
  {
    key: "ragdolls",
    label: "Ragdolls",
    hint: "Bodies fall under physics instead of collapsing",
    options: OFF_ON,
  },
];

/** The selectable rows, in screen order — headings are not stepped onto. */
const CONTROLS = ROWS.filter(isControl);

export class SettingsScreen {
  private root: HTMLElement;
  private body: HTMLElement;
  private values: Settings;
  /** Which toggle the arrow keys are on. Indexes `TOGGLES`, not `ROWS`. */
  private row = 0;

  /**
   * Wired by Game. Reports a change; does not apply or redraw it.
   *
   * One function over every key, so its value type is the union of every
   * field's — the key/value pairing is guaranteed by `ROWS` instead, where each
   * row's options are typed against its own key.
   */
  onChange: (key: keyof Settings, value: Settings[keyof Settings]) => void =
    () => {};
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
          <span><kbd>&uarr;</kbd><kbd>&darr;</kbd><kbd class="pad">Stick</kbd> row</span>
          <span><kbd>&larr;</kbd><kbd>&rarr;</kbd><kbd>Enter</kbd><kbd class="pad">A</kbd> change</span>
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
    const n = CONTROLS.length;
    if (n === 0) return;
    this.row = (this.row + delta + n) % n;
    this.draw();
  }

  /**
   * Steps the highlighted row's value.
   *
   * **Left/right clamp; Enter wraps.** They used to be the same move because a
   * boolean has only one other value to reach, and with a three-rung ladder on
   * the screen they stop being: left on the lowest rung has to stay put, or a
   * player stepping down a resolution list lands back at the top and reads it
   * as the setting having refused. Enter is the opposite case — it is one key
   * being asked to reach every value, so it has to come round.
   */
  stepRow(delta: number, wrap: boolean): void {
    const row = CONTROLS[this.row];
    if (!row) return;
    const options = row.options as readonly { value: unknown }[];
    const at = options.findIndex((o) => o.value === this.values[row.key]);
    const from = at < 0 ? 0 : at;
    const next = wrap
      ? (from + delta + options.length) % options.length
      : Math.max(0, Math.min(options.length - 1, from + delta));
    if (next === from) return;
    this.onChange(row.key, options[next].value as Settings[keyof Settings]);
  }

  /**
   * The row's hint, with the resolved pixel count spliced into the scale's.
   *
   * "75%" on its own says nothing a player can act on — what they want to know
   * is the number of pixels it lands on, and that depends on their window and
   * their panel, so it cannot be written into the table. Rounded down the same
   * way Babylon rounds the backing store, so the two agree.
   */
  private hintFor(row: AnyControl): string {
    if (row.key !== "renderScale") return row.hint;
    const dpr = window.devicePixelRatio || 1;
    const scale = this.values.renderScale;
    const w = Math.floor(window.innerWidth * dpr * scale);
    const h = Math.floor(window.innerHeight * dpr * scale);
    return `${row.hint} &mdash; ${w}&times;${h}`;
  }

  /**
   * Rebuilds the list rather than patching it — it is redrawn only on a pick
   * or a row move, and the alternative is three places that have to agree on
   * which row carries the highlight.
   */
  private draw(): void {
    let i = -1;
    this.body.innerHTML = ROWS.map((r) => {
      if (!isControl(r)) return `<h3 class="se-head">${r.heading}</h3>`;
      i += 1;
      const current = this.values[r.key];
      const options = r.options as readonly { value: unknown; label: string }[];
      const buttons = options
        .map(
          (o, n) =>
            `<button class="se-opt${o.value === current ? " on" : ""}" ` +
            `data-row="${i}" data-opt="${n}">${o.label}</button>`,
        )
        .join("");
      return `
        <div class="se-row${i === this.row ? " active" : ""}" data-row="${i}">
          <span class="se-label">${r.label}</span>
          <div class="se-choice">${buttons}</div>
          <span class="se-hint">${this.hintFor(r)}</span>
        </div>`;
    }).join("");

    // The button carries its row and its index rather than a key and a value:
    // a value has to survive a round trip through a dataset string, and `false`
    // and `0.5` do not come back as themselves. The table is the only place
    // that knows what an option means.
    this.body.querySelectorAll<HTMLElement>("button.se-opt").forEach((btn) => {
      btn.onclick = () => {
        const row = CONTROLS[Number(btn.dataset.row)];
        const options = row?.options as readonly { value: unknown }[] | undefined;
        const opt = options?.[Number(btn.dataset.opt)];
        if (opt) this.onChange(row.key, opt.value as Settings[keyof Settings]);
      };
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
