/**
 * SettingsScreen.ts — The settings screen: a list of choices over a scrim.
 * Owns #settings and its own row selection; owns no setting, and applies
 * nothing — every change leaves through `onChange` and comes back as a
 * `setValues` from Game, so the screen can never disagree with what is stored.
 * Invariants: the rows are DATA (`ROWS`), never markup — this screen exists to
 * grow, and a hardcoded row is a row the keyboard navigation does not know
 * about. Every row is one CHOICE over a list of options, whatever it is drawn
 * as: `style` picks the button group or the slider and changes nothing below
 * the markup (see `ControlRow`). Above #loadout's z-index, because it is
 * reachable from the pause lid and has to cover everything the pause card sits
 * over.
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
 * **`style` is where a longer list stops fitting, and it is a rendering choice
 * over the SAME options.** The control column is fixed — three rungs is ~60 px a
 * button and sixteen is 10 px, narrower than one character of a letterspaced
 * 10 px face — so a row whose options run past a handful draws as a slider
 * instead: a track the whole list is laid along, a thumb at the current rung and
 * the value beside it.
 *
 * **The slider is positioned by INDEX, not by value, and that is what keeps it
 * a choice over `options` rather than a second kind of setting.** The thumb
 * travels one option per equal share of the track, so what the store holds is
 * always a member of the same table the arrow keys step through, the same table
 * a codec in [`settings.ts`](../core/settings.ts) validates against — a drag
 * cannot land on a value a keypress could not reach, and nothing downstream
 * learns that the row looks different. It also means a ladder with deliberate
 * spacing keeps it: `CONFIG.camera.lookScales` is geometric, so an inch of drag
 * is the same RATIO of look speed wherever on the track it is taken.
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
  /** How the options are drawn. Absent is the button group. */
  style?: "slider";
}

type AnyControl = { [K in keyof Settings]: ControlRow<K> }[keyof Settings];

type Row = { heading: string } | AnyControl;

const isControl = (r: Row): r is AnyControl => "key" in r;

/** Off/On, the shape four of the five rows share. */
const OFF_ON = [
  { value: false, label: "Off" },
  { value: true, label: "On" },
] as const;

/**
 * The look-speed ladder, straight off the config's list — the same rule the
 * render scale follows, so the screen cannot offer a rung the store would
 * refuse to remember. Two decimals on every rung, including 1, so the numbers
 * hold one column width as they step rather than jumping about under the
 * cursor.
 */
const LOOK_SCALES = CONFIG.camera.lookScales.map((v) => ({
  value: v,
  label: `${v.toFixed(2)}&times;`,
}));

const ROWS: readonly Row[] = [
  // Controls first, and that is about the cursor rather than about importance:
  // `show()` opens on row 0, and look speed is the setting a player goes
  // looking for on the first evening — a resolution is something you change
  // once when the frame rate tells you to.
  { heading: "Controls" },
  {
    key: "mouseSensitivity",
    label: "Mouse look",
    hint: "Mouse look speed",
    options: LOOK_SCALES,
    style: "slider",
  },
  {
    key: "stickSensitivity",
    label: "Stick look",
    hint: "Gamepad look speed",
    options: LOOK_SCALES,
    style: "slider",
  },
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
   * The slider drag in progress: which control row it is on, and the track's
   * box as it stood when the pointer went down. Null when nothing is held.
   * See `beginDrag` for why the geometry is captured rather than re-read.
   */
  private drag: {
    row: number;
    left: number;
    width: number;
    thumb: number;
  } | null = null;

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
        <p class="ui-foot">
          <span><kbd>&uarr;</kbd><kbd>&darr;</kbd><kbd class="pad">Stick</kbd> row</span>
          <span><kbd>&larr;</kbd><kbd>&rarr;</kbd><kbd>Enter</kbd><kbd class="pad">A</kbd> change</span>
          <button class="ui-back"><kbd>Esc</kbd><kbd class="pad">B</kbd> Back</button>
        </p>
      </div>
    `;
    document.getElementById("hud")!.appendChild(this.root);
    this.body = this.root.querySelector(".se-body")!;
    // The pointer's way off this screen, in the footer every lid screen ends
    // with (`.ui-foot` / `.ui-back` in base.css) — same place, same chips,
    // same weight on all three, which is the point of it being shared.
    //
    // `click` is safe on a button INSIDE a screen that is already up: the
    // pointerdown rule the menu's kit button documents is about buttons that
    // race the overlay's own mouse-down confirm on the way in.
    this.root.querySelector<HTMLElement>("button.ui-back")!.onclick = () =>
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
    // A drag held on the window would otherwise outlive the screen: the pointer
    // that opened a pause and came back up over the round would still be moving
    // a slider nobody can see. Escape closes this screen with a button down as
    // easily as with one up.
    this.endDrag();
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
   * The row's hint, with what the chosen value actually WORKS OUT TO spliced
   * onto the end of it.
   *
   * "75%" on its own says nothing a player can act on — what they want to know
   * is the number of pixels it lands on, and that depends on their window and
   * their panel, so it cannot be written into the table. A bare "1.25x" is the
   * same problem one step worse, since it is a multiplier over a number the
   * screen never shows: what a player is comparing against the shooter they
   * came from is a turn per unit of hand movement, so that is what the hint
   * resolves to. Both are computed rather than stored, because both depend on
   * something the table cannot know.
   */
  private hintFor(row: AnyControl): string {
    const deg = (rad: number) => Math.round((rad * 180) / Math.PI);
    const c = CONFIG.camera;
    switch (row.key) {
      case "renderScale": {
        // Rounded down the same way Babylon rounds the backing store, so the
        // two agree.
        const dpr = window.devicePixelRatio || 1;
        const scale = this.values.renderScale;
        const w = Math.floor(window.innerWidth * dpr * scale);
        const h = Math.floor(window.innerHeight * dpr * scale);
        return `${row.hint} &mdash; ${w}&times;${h}`;
      }
      // Per 1000 px rather than per pixel: the rate itself is a fraction of a
      // degree, and the number a player recognises is the sweep.
      case "mouseSensitivity":
        return `${row.hint} &mdash; ${deg(
          c.sensX * 1000 * this.values.mouseSensitivity,
        )}&deg; per 1000 px`;
      // At full deflection, which is the only deflection a rate can be quoted
      // at — everything short of it is the stick curve's business.
      case "stickSensitivity":
        return `${row.hint} &mdash; ${deg(
          c.stickSensX * this.values.stickSensitivity,
        )}&deg;/s at full stick`;
      default:
        return row.hint;
    }
  }

  /**
   * The control cell's markup: a button per option, or the slider a long ladder
   * is laid along.
   *
   * The slider carries its position as `--t`, a 0..1 fraction of the OPTION
   * INDEX, and the stylesheet turns that into a thumb offset. That split is the
   * point: this file may not restate the thumb's size, so the one calculation
   * that needs it (`t` -> pixels, and back again on a drag) is written once in
   * CSS and measured off the DOM in `beginDrag`, rather than kept as a number
   * in two places that must agree or the thumb sits where the value is not.
   */
  private controlMarkup(row: AnyControl, index: number): string {
    const options = row.options as readonly { value: unknown; label: string }[];
    const current = this.values[row.key];
    const at = options.findIndex((o) => o.value === current);
    if (row.style === "slider") {
      const from = at < 0 ? 0 : at;
      const t = options.length > 1 ? from / (options.length - 1) : 0;
      return (
        `<div class="se-choice slider">` +
        `<div class="se-slider" data-row="${index}" style="--t:${t}">` +
        `<div class="se-track"></div><div class="se-fill"></div>` +
        `<div class="se-thumb"></div>` +
        `</div>` +
        `<span class="se-value">${options[from].label}</span>` +
        `</div>`
      );
    }
    const buttons = options
      .map(
        (o, n) =>
          `<button class="se-opt${o.value === current ? " on" : ""}" ` +
          `data-row="${index}" data-opt="${n}">${o.label}</button>`,
      )
      .join("");
    return `<div class="se-choice">${buttons}</div>`;
  }

  /**
   * Takes the press on a slider and holds the drag open on the WINDOW.
   *
   * The listeners cannot go on the element and the geometry cannot be re-read
   * per move, both for the same reason: `draw` rebuilds `innerHTML` wholesale,
   * so the element under the finger is destroyed and replaced the first time
   * the value crosses a rung. Anything bound to it — a listener, a pointer
   * capture — goes with it, and the drag dies one rung in. Window listeners
   * outlive the redraw, and the track's box is measured ONCE here: the row's
   * height and the grid's columns do not depend on the value, so the box a
   * press starts in is the box the whole drag happens in.
   */
  private beginDrag(el: HTMLElement, event: PointerEvent): void {
    const box = el.getBoundingClientRect();
    const thumb = el.querySelector<HTMLElement>(".se-thumb");
    this.drag = {
      row: Number(el.dataset.row),
      left: box.left,
      width: box.width,
      // The stylesheet's number, measured rather than restated. A thumb is
      // centred on its value, so half of it is unreachable travel at each end.
      thumb: thumb ? thumb.getBoundingClientRect().width : 0,
    };
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.endDrag);
    window.addEventListener("pointercancel", this.endDrag);
    // A press is also a row selection, which matters on a touchscreen and on a
    // first click into the panel — there is no hover to have moved it already.
    if (this.row !== this.drag.row) {
      this.row = this.drag.row;
      this.draw();
    }
    // Stops the drag selecting the labels either side of it.
    event.preventDefault();
    this.dragTo(event.clientX);
  }

  /** Where on the ladder a pointer at `clientX` is, and the pick it makes. */
  private dragTo(clientX: number): void {
    const d = this.drag;
    if (!d) return;
    const row = CONTROLS[d.row];
    if (!row) return;
    const options = row.options as readonly { value: unknown }[];
    const travel = d.width - d.thumb;
    const t = travel > 0 ? (clientX - d.left - d.thumb / 2) / travel : 0;
    // Round, not floor: every rung gets the half-share of track either side of
    // it, so the thumb goes where it was dropped rather than one rung short.
    const at = Math.round(Math.max(0, Math.min(1, t)) * (options.length - 1));
    const option = options[at];
    // Guarded here as well as in `Game.setSetting`, because this fires per
    // pointer event and the round trip through the store is a localStorage
    // write: a drag should cost one write per rung crossed, not one per pixel.
    if (option && option.value !== this.values[row.key]) {
      this.onChange(row.key, option.value as Settings[keyof Settings]);
    }
  }

  private onDragMove = (event: PointerEvent): void => {
    this.dragTo(event.clientX);
  };

  /** Ends a drag from any of the four things that can end one. */
  private endDrag = (): void => {
    if (!this.drag) return;
    this.drag = null;
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.endDrag);
    window.removeEventListener("pointercancel", this.endDrag);
  };

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
      return `
        <div class="se-row${i === this.row ? " active" : ""}" data-row="${i}">
          <span class="se-label">${r.label}</span>
          ${this.controlMarkup(r, i)}
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
    // Pointerdown, not click: a slider has to answer while the button is still
    // held, and `beginDrag` takes the press as a pick in its own right, so a
    // tap on the track is a click and a hold is a drag through one path.
    this.body.querySelectorAll<HTMLElement>(".se-slider").forEach((el) => {
      el.onpointerdown = (event) => this.beginDrag(el, event);
    });
    // Hovering a row moves the keyboard selection with it, so the highlighted
    // row and the one the arrows are about to step can never disagree — the
    // rule the pause list and the kit screen's slots both follow.
    this.body.querySelectorAll<HTMLElement>(".se-row").forEach((el) => {
      el.onmouseenter = () => {
        const next = Number(el.dataset.row);
        // Never while a slider is held: the redraw that a drag causes lands a
        // fresh row under a pointer that has not moved between rows at all, and
        // taking the selection from it would let a drag started on one slider
        // walk the highlight onto another.
        if (next !== this.row && !this.drag) {
          this.row = next;
          this.draw();
        }
      };
    });
  }
}
