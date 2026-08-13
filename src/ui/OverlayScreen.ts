/**
 * OverlayScreen.ts — The four full-screen cards that stop the game: the main
 * menu, the round-over result, the pause list, and the one that stands over a
 * map being built.
 * Owns: `#overlay` and everything written into it, the action cursor the pause
 * list and the round-over card share, and the `.overlaid` class on `#hud` that
 * hides the gameplay chrome behind a card. A peer of DeployScreen and
 * LoadoutScreen — Game wires its callbacks (`onStart`, `onMainMenu`,
 * `onDifficulty`, `onOpenLoadout`, `onPauseAction`) and drives its selection,
 * and it knows nothing about game state beyond what it is handed.
 * Invariants: only one card is up at a time — each `show*` rewrites the whole
 * element — and `hide()` is the single way down from any of them.
 *
 * One class rather than four because the cards are one element, not four
 * screens that happen to overlap: they share the shell, the title block, the
 * controls table (which the menu and the pause list drew from two copies of
 * the same loop before this) and, between the menu and the round-over card,
 * the Deploy button. What splitting them would buy is four files that could
 * never be shown together anyway, at the cost of a base class or a duplicated
 * stylesheet. A card that grows its own state — a settings screen with rows to
 * edit, a map picker — has earned a file of its own; a card that is markup and
 * a button has not, and the building card is markup and not even that.
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
  // Three keys, because they are two different asks: the wheel swaps to the
  // other weapon and the numbers name one outright. Y is the kit screen's
  // button in a menu and this one in a round; the two states never overlap, so
  // the table can name it here without qualification.
  ["Weapon", "Y", "Wheel 1 2"],
  ["Grenade", "RB", "G"],
  ["Sprint", "L3", "Shift"],
  // Two keys because they behave differently — Ctrl is held, C latches, and
  // on the pad B latches too. The table's grammar is one chip per key and it
  // has nowhere to say which is which; the pair reads as "either", which is
  // true, and one press of each tells the rest.
  ["Crouch", "B", "Ctrl C"],
  ["Pause", "Start", "Esc"],
];

/**
 * What the pause menu can do, and the label for each. In screen order.
 *
 * `settings` sits above the two destructive items on purpose: it is the only
 * one you can pick and come back from, and putting it under "Quit to menu"
 * would file the harmless action below the one that ends the round.
 */
export type PauseAction = "resume" | "settings" | "restart" | "quit";
const PAUSE_ITEMS: readonly [PauseAction, string][] = [
  ["resume", "Resume"],
  ["settings", "Settings"],
  ["restart", "Restart round"],
  ["quit", "Quit to menu"],
];

/**
 * What the main menu's cursor can rest on, in screen order.
 *
 * The menu used to be four things reached by four different buttons — left and
 * right for the difficulty, `L`/Y for the kit, `O` for the settings, and a
 * confirm from anywhere for the round — which is a keyboard's idea of a menu
 * and leaves a pad player with no way at all to reach a row nobody thought to
 * give a face button. It is a LIST now: up and down move the cursor, A picks
 * what it is on, and the dedicated keys survive as accelerators rather than as
 * the only way in.
 */
type MenuItem = "map" | "difficulty" | "loadout" | "settings" | "start";

/**
 * Everything the menu card draws itself from.
 *
 * An object rather than five positional arguments: two `readonly string[]` and
 * two `number` in a row is a signature where swapping the map's index with the
 * difficulty tier still typechecks and silently picks the wrong thing.
 */
export interface MenuState {
  maps: readonly string[];
  selectedMap: number;
  difficulties: readonly string[];
  selected: number;
  kit: string;
  /** The chosen map's control-point count — the tagline states it. */
  flagCount: number;
}

/**
 * Small counts as words, because the tagline is prose: "take and hold five
 * points" is a sentence and "take and hold 5 points" is a stat line. Anything
 * past the ones a Conquest map plausibly carries falls back to the digits.
 */
const COUNT_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
const spellCount = (n: number) => COUNT_WORDS[n] ?? String(n);
const MENU_ITEMS: readonly MenuItem[] = [
  "map",
  "difficulty",
  "loadout",
  "settings",
  "start",
];
/**
 * Where the cursor sits when the menu is raised. Deploy rather than the top
 * row, because it is the thing all but one visitor to this screen came for —
 * and because it keeps Enter/A meaning "start the round" the moment the title
 * appears, exactly as it did before there was a cursor at all.
 */
const MENU_DEFAULT = MENU_ITEMS.indexOf("start");

/**
 * One button a card's cursor can rest on, and what firing it does.
 *
 * The `fire` thunk rather than a data attribute read back off the element,
 * because the two cards that carry a list answer to different callbacks and a
 * single `data-action` string would have to name both of their vocabularies.
 */
interface ActionItem {
  el: HTMLElement;
  fire: () => void;
}

export class OverlayScreen {
  private root: HTMLElement;
  /**
   * The cursor over a card's action buttons — the pause list's four and the
   * round-over card's two.
   *
   * One list for both, because they are the same thing: a short column of
   * buttons, one action apiece, stepped by up/down and fired by A. The MENU's
   * cursor is deliberately NOT folded in with them — its rows are settings
   * rather than actions, so left and right have to mean something there and
   * nothing here, and `activateMenu` has a row-by-row answer where these have
   * one thunk each.
   *
   * It owns the SELECTION and nothing else: each card still binds its own
   * press, because they do not agree on the edge and must not be made to. The
   * pause list takes ordinary CLICKS, and that is load-bearing — `Game`'s
   * document-level `pointerdown` requests the pointer lock whenever the state
   * is `playing`, so a Resume that changed state on the down edge would have
   * the very same gesture ask for the lock outright, behind the deferred,
   * retried path `updatePendingLock` exists to be. The round-over pair change
   * state on POINTERDOWN like the menu's Deploy, which is safe for the reason
   * that is not: the state they move to is `loading`.
   *
   * Live only while one of those cards is up — the buttons die with the markup
   * they are written into.
   */
  private actions: ActionItem[] = [];
  private actionIndex = 0;
  /** Live only while the menu card is up, for the same reason. */
  private menuEls = new Map<MenuItem, HTMLElement>();
  private menuIndex = MENU_DEFAULT;
  /** The difficulty row's state, so `activateMenu` can step it. */
  private tierCount = 0;
  private tier = 0;
  /** The map row's state, same reason. */
  private mapCount = 0;
  private mapIndex = 0;
  /**
   * Which card is up. The cursor is reset when the menu is RAISED and kept
   * across a redraw: `showMenu` is called again on every difficulty change and
   * on the way back from the kit and settings screens, and a cursor that
   * jumped back to Deploy each time would make the row you just left the one
   * place you cannot stay.
   */
  private card: "none" | "menu" | "roundover" | "pause" | "building" = "none";

  /** Wired by Game: the player picked a difficulty tier from the menu. */
  onDifficulty: (tier: number) => void = () => {};
  /** Wired by Game: the player picked a map from the menu. */
  onMap: (index: number) => void = () => {};
  /** Wired by Game: the player asked for the loadout screen. */
  onOpenLoadout: () => void = () => {};
  /** Wired by Game: the player asked for the settings screen. */
  onOpenSettings: () => void = () => {};
  /** Wired by Game: the player asked to start a round. */
  onStart: () => void = () => {};
  /**
   * Wired by Game: the player asked to leave the finished round for the title
   * screen. The round-over card's only other way out, and the reason that card
   * grew a cursor at all — before it, the one thing you could do with a
   * finished match was play the same map again.
   */
  onMainMenu: () => void = () => {};
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
   * The line that says how a list-shaped card is driven, under its actions.
   *
   * Shared by the menu and the round-over card for the same reason the
   * controls table is: it is the same sentence about the same two inputs, and
   * two copies of it are two things to forget when the navigation changes. It
   * names the stick first — the d-pad was always answered and the stick was
   * not, and the stick is the half a pad player reaches for.
   */
  private navHint(): string {
    return `
      <p class="ov-nav">
        <span><kbd>&uarr;</kbd><kbd>&darr;</kbd><kbd class="pad">Stick / D-pad</kbd> move</span>
        <span><kbd>Enter</kbd><kbd class="pad">A</kbd> select</span>
      </p>`;
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
   * the tier buttons, the kit button and Deploy, never the rows around them.
   * The labels, the hints and the grid's own gaps stay inert, and a click that
   * lands on one of them now does NOTHING: the pointer's only way off this
   * screen is the Deploy button. It used to be every pixel of it, which meant
   * choosing a map or a difficulty deployed you the instant you chose one —
   * those two fire on mouse-UP, and the confirm reads the mouse-DOWN before it.
   */
  showMenu(opts: MenuState): void {
    const { maps, selectedMap, difficulties, selected, kit, flagCount } = opts;
    this.root.classList.remove("hidden");
    this.setOverlaid(true);
    // Raised anew, not redrawn — see `card`.
    if (this.card !== "menu") this.menuIndex = MENU_DEFAULT;
    this.card = "menu";
    this.tierCount = difficulties.length;
    this.tier = selected;
    this.mapCount = maps.length;
    this.mapIndex = selectedMap;
    const tiers = difficulties
      .map(
        (name, i) =>
          `<button class="tier${i === selected ? " on" : ""}" data-tier="${i}">${name}</button>`,
      )
      .join("");
    const mapButtons = maps
      .map(
        (name, i) =>
          `<button class="tier${i === selectedMap ? " on" : ""}" data-map="${i}">${name}</button>`,
      )
      .join("");
    this.root.innerHTML = `
      <div class="ov-title">
        <h1>HOLLOWMERE</h1>
        <p class="tagline">Conquest &mdash; take and hold ${spellCount(flagCount)} points against the Blight</p>
      </div>
      <div class="ov-settings">
        <div class="segmented" data-menu="map">
          <span class="label">Map</span>
          <div class="tiers">${mapButtons}</div>
          <span class="hint">&larr; &rarr;</span>
        </div>
        <div class="segmented" data-menu="difficulty">
          <span class="label">Enemy skill</span>
          <div class="tiers">${tiers}</div>
          <span class="hint">&larr; &rarr;</span>
        </div>
        <div class="kit" data-menu="loadout">
          <span class="label">Loadout</span>
          <button class="kit-open"><b>${kit}</b><i>Change kit</i></button>
          <span class="hint">L / Y</span>
        </div>
        <div class="kit" data-menu="settings">
          <span class="label">Display</span>
          <button class="settings-open"><b>Settings</b><i>Counter &middot; effects</i></button>
          <span class="hint">O</span>
        </div>
      </div>
      <button class="ov-start" data-menu="start"><b>Deploy</b><i>Enter &middot; A &middot; Start</i></button>
      ${this.navHint()}
      ${this.controlsTable()}
    `;
    this.root
      .querySelectorAll<HTMLElement>("button[data-tier]")
      .forEach((btn) => {
        btn.onclick = () => this.onDifficulty(Number(btn.dataset.tier));
      });
    this.root.querySelectorAll<HTMLElement>("button[data-map]").forEach((btn) => {
      btn.onclick = () => this.onMap(Number(btn.dataset.map));
    });
    // The cursor's row is collected from the markup rather than kept in step
    // by hand, so a row added above only has to name itself in `MENU_ITEMS`.
    this.clearCursors();
    this.root.querySelectorAll<HTMLElement>("[data-menu]").forEach((el) => {
      const item = el.dataset.menu as MenuItem;
      this.menuEls.set(item, el);
      // Hovering moves the cursor with it, so the highlighted row and the one
      // Enter is about to fire can never disagree — the rule the pause list,
      // the kit screen's slots and the settings rows all follow.
      el.onmouseenter = () => this.setMenuSelection(MENU_ITEMS.indexOf(item));
    });
    this.applyMenuSelection();
    // POINTERDOWN, not click — kept now that the confirm no longer counts the
    // mouse, because it is the edge these two have always changed state on and
    // the deploy screen's twins still do it for a live reason. Every button on
    // this card that leaves the screen it is on agrees on the down edge; the
    // ones that only step a row (map, difficulty) are ordinary clicks.
    const kitBtn = this.root.querySelector<HTMLElement>("button.kit-open");
    if (kitBtn) kitBtn.onpointerdown = () => this.onOpenLoadout();
    const setBtn = this.root.querySelector<HTMLElement>("button.settings-open");
    if (setBtn) setBtn.onpointerdown = () => this.onOpenSettings();
    this.bindStart();
  }

  /**
   * The one button that starts the round, shared by the menu and the round-over
   * card, and the ONLY thing on either that a pointer can deploy with. It began
   * as a redundant target beside a click-anywhere confirm — an instruction in
   * prose is not a target, and a pad player reading "click, press Enter, or
   * press Start" has to work out which of those they own — and is now carrying
   * the mouse and the finger by itself, which is what lets the rows above it
   * be picked from without also ending the screen they are on.
   *
   * POINTERDOWN, the same edge every button here that leaves the screen uses.
   */
  private bindStart(): void {
    const btn = this.root.querySelector<HTMLElement>("button.ov-start");
    if (btn) btn.onpointerdown = () => this.onStart();
  }

  /** Steps the menu cursor, wrapping at both ends. No-op off the menu card. */
  moveMenuSelection(delta: number): void {
    if (this.menuEls.size === 0) return;
    const n = MENU_ITEMS.length;
    this.setMenuSelection((this.menuIndex + delta + n) % n);
  }

  /**
   * Left/right on the cursor's row. Only the two segmented rows — the map and
   * the difficulty — have anything to step; on a row that is a button this is
   * deliberately nothing, because a horizontal nudge that fired a screen would
   * make the cursor's own left and right edges feel like traps.
   *
   * It CLAMPS where `activateMenu` wraps: left and right are a slider along a
   * row of four tiers, and a slider that jumps from Ace back to Green at the
   * end is one you have to watch rather than feel.
   */
  stepMenuItem(delta: number): void {
    if (this.menuEls.size === 0) return;
    if (MENU_ITEMS[this.menuIndex] === "difficulty") {
      this.onDifficulty(this.tier + delta);
    } else if (MENU_ITEMS[this.menuIndex] === "map") {
      this.onMap(this.mapIndex + delta);
    }
  }

  /**
   * Fires the cursor's row — Enter / gamepad A.
   *
   * The difficulty row cycles rather than doing nothing: a confirm that
   * answers nothing is the thing this screen was rebuilt to remove, and with
   * four tiers on screen and the current one lit, a press that advances to the
   * next says what it did. It WRAPS, unlike left/right, so the button always
   * changes something wherever the row happens to be resting.
   */
  activateMenu(): void {
    if (this.menuEls.size === 0) return;
    switch (MENU_ITEMS[this.menuIndex]) {
      case "map":
        if (this.mapCount > 0) this.onMap((this.mapIndex + 1) % this.mapCount);
        break;
      case "difficulty":
        if (this.tierCount > 0) this.onDifficulty((this.tier + 1) % this.tierCount);
        break;
      case "loadout":
        this.onOpenLoadout();
        break;
      case "settings":
        this.onOpenSettings();
        break;
      case "start":
        this.onStart();
        break;
    }
  }

  private setMenuSelection(i: number): void {
    if (i === this.menuIndex) return;
    this.menuIndex = i;
    this.applyMenuSelection();
  }

  /**
   * Paints the cursor. A class on rows that already exist rather than a
   * redraw, so moving down the menu does not restart the title's animation or
   * drop the hover state under the mouse — the same rule the pause list keeps.
   */
  private applyMenuSelection(): void {
    MENU_ITEMS.forEach((item, i) => {
      this.menuEls.get(item)?.classList.toggle("sel", i === this.menuIndex);
    });
  }

  /**
   * The result card, and the two things a finished match can become.
   *
   * It is a LIST, like every other screen here. It used to be a result and one
   * button, which quietly made a round-over the one place in the game with no
   * way back to the title: the map, the difficulty and the kit are all chosen
   * on the menu, so a player who wanted any of them had to reload the page.
   * The two are deliberately not equals — another round on the same map is
   * what most of this card's visitors want, so it keeps the filled Deploy
   * button and the cursor, and leaving is the outlined alternative under it.
   *
   * `B` / Backspace also leaves, which is what that key means on every other
   * screen in this directory, and the caption says so. `Game` owns that one:
   * the card cannot see a key.
   */
  showRoundOver(
    winnerName: string,
    playerWon: boolean,
    tickets0: number,
    tickets1: number,
    mapName: string,
  ): void {
    this.root.classList.remove("hidden");
    this.setOverlaid(true);
    this.card = "roundover";
    this.clearCursors();
    this.root.innerHTML = `
      <div class="ov-title">
        <h1 class="${playerWon ? "win" : "dead"}">${playerWon ? "VICTORY" : "DEFEAT"}</h1>
        <p class="tagline">${winnerName} hold ${mapName}</p>
      </div>
      <div class="ov-result frame">
        <span class="lbl">REINFORCEMENTS REMAINING</span>
        <span class="vals"><b>${tickets0}</b><i>/</i><b>${tickets1}</b></span>
      </div>
      <div class="ov-actions">
        <button class="ov-start"><b>Another round</b><i>Enter &middot; A &middot; Start</i></button>
        <button class="ov-quit"><b>Main menu</b><i>Backspace &middot; B</i></button>
      </div>
      ${this.navHint()}
    `;
    this.bindStart();
    const quit = this.root.querySelector<HTMLElement>("button.ov-quit");
    // POINTERDOWN, the edge `bindStart` uses beside it — the two halves of one
    // choice must not answer on two different edges.
    if (quit) quit.onpointerdown = () => this.onMainMenu();
    const start = this.root.querySelector<HTMLElement>("button.ov-start");
    if (start && quit) {
      this.bindActions([
        { el: start, fire: () => this.onStart() },
        { el: quit, fire: () => this.onMainMenu() },
      ]);
    }
  }

  /**
   * The card that stands over a map being built.
   *
   * It exists because building one is ~0.7 s of merges, an occlusion bake and
   * a nav grid on a single frame, and until there was something to put up, the
   * card the player had just confirmed simply froze where it stood and the
   * deploy screen appeared out of it. A hang and a load look identical; the
   * only thing that separates them is whether the game said which it was.
   *
   * `setOverlaid` for the same reason the menu calls it — what is under this
   * is either last round's HUD or nothing at all.
   *
   * No button, no cursor, no callbacks: this is the one card the player cannot
   * act on, and it takes itself down (`Game.buildRound` does) rather than
   * waiting to be dismissed.
   *
   * The bar is indeterminate and has to be — the work it covers is one
   * synchronous call, so there is no progress to read even in principle — and
   * it is the one thing on any of these cards that must keep moving with the
   * main thread stopped dead. See `.ov-bar i` in `overlay.css`: that is a
   * constraint on which CSS properties may animate it, not a style choice.
   */
  showBuilding(mapName: string): void {
    this.root.classList.remove("hidden");
    this.setOverlaid(true);
    this.card = "building";
    this.clearCursors();
    this.root.innerHTML = `
      <div class="ov-title">
        <h1 class="building-title">${mapName}</h1>
        <p class="tagline">Building the valley</p>
      </div>
      <p class="prompt">Stand by</p>
      <div class="ov-bar"><i></i></div>
    `;
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
   * The action list is the one part of this card that takes pointer events,
   * the same carve-out the difficulty row gets. Selection is a class on a
   * button that already exists rather than a re-render, so arrowing down the
   * list does not restart the prompt's animation or drop the hover state.
   */
  showPause(): void {
    this.root.classList.remove("hidden");
    this.card = "pause";
    this.clearCursors();
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
    const buttons: ActionItem[] = [];
    this.root.querySelectorAll<HTMLElement>("button.pact").forEach((btn) => {
      const action = btn.dataset.action as PauseAction;
      // CLICK, not pointerdown, and see `actions` for why that is a rule here
      // rather than a habit: Resume changes the state to `playing`, and the
      // document listener that would see the same press wants a pointer lock.
      btn.onclick = () => this.onPauseAction(action);
      buttons.push({ el: btn, fire: () => this.onPauseAction(action) });
    });
    this.bindActions(buttons);
  }

  /**
   * Puts a card's buttons under the cursor and lights the first.
   *
   * Hovering moves the selection with the mouse, so the highlighted button and
   * the one Enter is about to fire can never disagree — the rule the menu, the
   * kit screen's slots and the settings rows all keep.
   */
  private bindActions(items: ActionItem[]): void {
    this.actions = items;
    items.forEach(({ el }, i) => {
      el.onmouseenter = () => this.setActionSelection(i);
    });
    this.setActionSelection(0);
  }

  /** Steps the action cursor, wrapping at both ends. */
  moveActionSelection(delta: number): void {
    const n = this.actions.length;
    if (n === 0) return;
    this.setActionSelection((this.actionIndex + delta + n) % n);
  }

  /** Fires the action the cursor is on — Enter / gamepad A. */
  activateAction(): void {
    this.actions[this.actionIndex]?.fire();
  }

  private setActionSelection(i: number): void {
    this.actionIndex = i;
    this.actions.forEach(({ el }, k) => el.classList.toggle("sel", k === i));
  }

  /**
   * Forgets both cursors, because the elements they point at are about to stop
   * existing — every `show*` rewrites the whole card and `hide` throws it away.
   * A stale entry here is a `classList.toggle` on a detached node, which is
   * silent, and a `fire` thunk a key could still reach.
   */
  private clearCursors(): void {
    this.menuEls.clear();
    this.actions = [];
    this.actionIndex = 0;
  }

  /** Takes whichever card is up back down. The single way off all four. */
  hide(): void {
    this.root.classList.add("hidden");
    this.setOverlaid(false);
    // The buttons live in the card's markup, so they die with it.
    this.clearCursors();
    this.card = "none";
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
