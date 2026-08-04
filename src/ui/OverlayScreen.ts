/**
 * OverlayScreen.ts — The three full-screen cards that stop the game: the main
 * menu, the round-over result, and the pause list.
 * Owns: `#overlay` and everything written into it, the pause list's selection,
 * and the `.overlaid` class on `#hud` that hides the gameplay chrome behind a
 * card. A peer of DeployScreen and LoadoutScreen — Game wires its callbacks
 * (`onStart`, `onDifficulty`, `onOpenLoadout`, `onPauseAction`) and drives its
 * selection, and it knows nothing about game state beyond what it is handed.
 * Invariants: only one card is up at a time — each `show*` rewrites the whole
 * element — and `hide()` is the single way down from any of them.
 *
 * One class rather than three because the cards are one element, not three
 * screens that happen to overlap: they share the shell, the title block, the
 * controls table (which the menu and the pause list drew from two copies of
 * the same loop before this) and, between the menu and the round-over card,
 * the Deploy button. What splitting them would buy is three files that could
 * never be shown together anyway, at the cost of a base class or a duplicated
 * stylesheet. A card that grows its own state — a settings screen with rows to
 * edit, a map picker — has earned a file of its own; a card that is markup and
 * a button has not.
 *
 * Deliberately NOT here: `setPaused`/`setEditing`. Those hide parts of the
 * HUD's own chrome and stay with the HUD, even though a pause is what raises
 * one of them.
 */
import "./overlay.css";

/** The player's controls, as the menu and the pause list both show them. */
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

export class OverlayScreen {
  private root: HTMLElement;
  /** Live only while the pause card is up — the buttons die with its markup. */
  private pauseButtons: HTMLElement[] = [];
  private pauseIndex = 0;

  /** Wired by Game: the player picked a difficulty tier from the menu. */
  onDifficulty: (tier: number) => void = () => {};
  /** Wired by Game: the player asked for the loadout screen. */
  onOpenLoadout: () => void = () => {};
  /** Wired by Game: the player asked to start a round. */
  onStart: () => void = () => {};
  /** Wired by Game: the player picked something from the pause list. */
  onPauseAction: (action: PauseAction) => void = () => {};

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "overlay";
    this.root.className = "hidden";
    // Appended like every other screen, and before the deploy map and the
    // minimap because Game builds this first. DOM order does not decide the
    // stacking here — `#overlay` carries a z-index of its own, since a pause
    // can be taken with either of those on screen and an overlay you can see a
    // map through is not an overlay.
    document.getElementById("hud")!.appendChild(this.root);
  }

  /**
   * The controls table, which the menu and the pause list both carry.
   *
   * Built here rather than at each call site: the two were the same loop
   * written out twice, so a control rebound in one place quietly disagreed
   * with the other.
   */
  private controlsTable(): string {
    const rows = CONTROLS.map(
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
    return `
      <div class="ov-controls frame">
        <div class="ov-controls-head">
          <span>Controls</span><span>Keyboard &amp; mouse</span><span>Gamepad</span>
        </div>
        ${rows}
      </div>`;
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
   * The two rows are ONE grid, not two centred rows. They are the same shape —
   * label, control, hint — and centring each independently put their labels,
   * their controls and their hints at three different x each, which is most of
   * what made this screen read as a pile rather than a panel. `.ov-settings`
   * owns the columns and each row is `display: contents`, so the label column
   * ends on one edge and both controls begin on the next.
   *
   * `#overlay` is inside a `pointer-events: none` HUD and does not opt back in
   * (only `#deploy` does), so the individual CONTROLS ask for pointer events —
   * the tier buttons and the kit button, never the rows around them. The
   * labels, the hints and the grid's own gaps stay inert, so a click that
   * lands between two buttons is still the confirm that starts the round.
   */
  showMenu(
    difficulties: readonly string[],
    selected: number,
    kit: string,
  ): void {
    this.root.classList.remove("hidden");
    this.setOverlaid(true);
    const tiers = difficulties
      .map(
        (name, i) =>
          `<button class="tier${i === selected ? " on" : ""}" data-tier="${i}">${name}</button>`,
      )
      .join("");
    this.root.innerHTML = `
      <div class="ov-title">
        <h1>HOLLOWMERE</h1>
        <p class="tagline">Conquest &mdash; take and hold five points against the Blight</p>
      </div>
      <div class="ov-settings">
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
      </div>
      <button class="ov-start"><b>Deploy</b><i>Enter &middot; A &middot; Start</i></button>
      ${this.controlsTable()}
    `;
    this.root
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
    const kitBtn = this.root.querySelector<HTMLElement>("button.kit-open");
    if (kitBtn) kitBtn.onpointerdown = () => this.onOpenLoadout();
    this.bindStart();
  }

  /**
   * The one button that starts the round, shared by the menu and the round-over
   * card. It is redundant with the confirm on the mouse — a click anywhere on
   * either screen already deploys — and that is precisely why it needs to
   * exist: an instruction in prose is not a target, and a pad player reading
   * "click, press Enter, or press Start" has to work out which of those they
   * own. A button with the glyphs on it says both at once.
   *
   * POINTERDOWN, for the reason the kit button documents: the overlay's own
   * confirm is a mouse-down read on the next tick, before any `click` fires.
   * Here the two agree on what should happen, so the button is only claiming
   * the action it was already going to get — but on the down edge, so the
   * ordering is the same as the kit button's and cannot drift.
   */
  private bindStart(): void {
    const btn = this.root.querySelector<HTMLElement>("button.ov-start");
    if (btn) btn.onpointerdown = () => this.onStart();
  }

  showRoundOver(
    winnerName: string,
    playerWon: boolean,
    tickets0: number,
    tickets1: number,
    mapName: string,
  ): void {
    this.root.classList.remove("hidden");
    this.setOverlaid(true);
    this.root.innerHTML = `
      <div class="ov-title">
        <h1 class="${playerWon ? "win" : "dead"}">${playerWon ? "VICTORY" : "DEFEAT"}</h1>
        <p class="tagline">${winnerName} hold ${mapName}</p>
      </div>
      <div class="ov-result frame">
        <span class="lbl">REINFORCEMENTS REMAINING</span>
        <span class="vals"><b>${tickets0}</b><i>/</i><b>${tickets1}</b></span>
      </div>
      <button class="ov-start"><b>Another round</b><i>Enter &middot; A &middot; Start</i></button>
    `;
    this.bindStart();
  }

  /**
   * The pause menu: a short action list, the controls table, and nothing else.
   *
   * It deliberately does NOT call `setOverlaid`. The menu and the round-over
   * card hide the gameplay chrome because what is under them is last round's
   * and no longer true; under a pause everything on screen is this round's and
   * frozen exactly as it stood, so the tickets, the flags and your own vitals
   * are worth reading. `#hud.paused` — which the HUD raises, not this — takes
   * away only the things that would be lying.
   *
   * The action list is the one part of the overlay that takes pointer events,
   * the same carve-out the difficulty row gets. Selection is a class on a
   * button that already exists rather than a re-render, so arrowing down the
   * list does not restart the prompt's animation or drop the hover state.
   */
  showPause(): void {
    this.root.classList.remove("hidden");
    const items = PAUSE_ITEMS.map(
      ([action, label]) =>
        `<button class="pact" data-action="${action}">${label}</button>`,
    ).join("");
    this.root.innerHTML = `
      <div class="ov-title">
        <h1 class="pause-title">PAUSED</h1>
        <p class="tagline">The round is held &mdash; nothing moves until you resume</p>
      </div>
      <div class="pause-actions">${items}</div>
      ${this.controlsTable()}
      <p class="prompt">Esc &middot; Start &middot; B to resume</p>
    `;
    this.pauseButtons = [];
    this.root
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

  private setPauseSelection(i: number): void {
    this.pauseIndex = i;
    this.pauseButtons.forEach((b, k) => b.classList.toggle("on", k === i));
  }

  /** Takes whichever card is up back down. The single way off all three. */
  hide(): void {
    this.root.classList.add("hidden");
    this.setOverlaid(false);
    // The buttons live in the card's markup, so they die with it.
    this.pauseButtons = [];
    this.pauseIndex = 0;
  }

  /**
   * Hides the gameplay chrome behind a full-screen card. The menu and the
   * round-over card sit over a live 3D scene, and the ticket gauge, flag strip,
   * killfeed and vitals underneath them are last round's — readable enough
   * through the scrim to look like the HUD is still running when it is not.
   * Same mechanism as `HUD.setEditing`, and for the same reason: the HUD keeps
   * writing to those nodes, so the hiding has to be in CSS.
   *
   * Reaching for `#hud` from here is the pattern LoadoutScreen's `.kitting`
   * already sets: the class belongs to whoever decides it is raised, and every
   * screen in this directory is a child of that element anyway.
   *
   * The deploy screen deliberately does NOT do this — you pick a spawn while
   * the round continues, and the tickets and flags are exactly what you are
   * deciding against.
   */
  private setOverlaid(on: boolean): void {
    document.getElementById("hud")!.classList.toggle("overlaid", on);
  }
}
