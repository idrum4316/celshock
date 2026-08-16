/**
 * LobbyScreen.ts — The match browser: what this server is running, and the way
 * into one of them.
 * Owns `#lobby`, its row cursor, and the rendering of a `MatchList`. Owns no
 * networking — it never fetches and never connects. `Game` hands it a result and
 * takes `onJoin`/`onCreate`/`onRefresh`/`onClose` back, the same
 * render-what-you-are-given shape `SettingsScreen` follows.
 * Invariants: the rows are DERIVED from the list (`buildRows`), never authored
 * as markup, because the match rows are as many as the server says and the
 * keyboard navigation has to know about every one of them. Every string that
 * came off the wire reaches the DOM through `textContent`, never through the
 * template — see `fillRow`.
 *
 * **This screen is a list over one server, not a server browser.** There is one
 * match server behind the game's own origin, it holds its matches in memory, and
 * the list it serves is authoritative for itself — so there is nothing central
 * to check in with and no address to type. The day there are two processes, this
 * screen's shape survives and what changes is who answers `/matches`; see
 * `docs/multiplayer.md`.
 */
import "./lobby.css";
import type { MatchSummary } from "../net/protocol";
import type { LobbyResult } from "../net/lobby";
import { MAPS } from "../world/maps";
import { pingQuality, pingText } from "./ping";

/**
 * One line, in screen order.
 *
 * The actions are rows rather than buttons beside the list, for the same reason
 * the main menu became a list: a cursor that reaches every affordance is one a
 * pad can drive without anybody inventing a face button per control.
 */
type LobbyRow =
  | { kind: "match"; match: MatchSummary }
  /**
   * The map a NEW match would be started on — the same pick as the menu's Map
   * row, shown again here because this is where it is spent.
   *
   * It says nothing about the match rows above it: a match is played on the map
   * it is running, and joining one takes that map whatever this row says. Above
   * `create` for the reason the menu puts Map above Deploy — the parameter,
   * then the button that spends it.
   */
  | { kind: "map" }
  | { kind: "create" }
  | { kind: "refresh" }
  | { kind: "back" };

/** What the screen is doing, which decides what stands in for the list. */
type LobbyPhase =
  | { phase: "loading" }
  | { phase: "ready"; result: LobbyResult }
  /** A join is in flight. The list stays up so the chosen row is still read. */
  | { phase: "joining"; matchId: string };

/**
 * Label and hint for each action row.
 *
 * `create`'s hint is the one that is not a constant — it names the map the row
 * would start a match on, which is `fillRow`'s job because the answer is a
 * field. What is here is the fallback for a screen that has not been told one.
 */
const ACTION_LABELS: Record<"create" | "refresh" | "back", [string, string]> = {
  create: ["New match", "Start a fresh round"],
  refresh: ["Refresh", "Ask the server again"],
  back: ["Back", "Return to the menu"],
};

/**
 * Are these the same row, across a rebuild?
 *
 * An action row is identified by its kind and a match row by its id — never by
 * anything that CHANGES, which is why the player count and the state are not
 * compared. A row whose count went from 3 to 4 is the same row, and a cursor
 * that let go of it every time somebody joined would be unusable on a busy
 * server.
 */
function sameRow(a: LobbyRow, b: LobbyRow): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "match" && b.kind === "match") return a.match.id === b.match.id;
  return true;
}

/**
 * A map's display name from its id.
 *
 * The server sends an id because that is what it is authoritative about; the
 * name is presentation and lives in the client's own table. An id this build has
 * never heard of falls through VERBATIM rather than being hidden — a server one
 * version ahead is exactly when a player most needs to see what is running — and
 * that fallback is why every row's text is assigned rather than interpolated.
 */
function mapName(id: string): string {
  return MAPS.find((m) => m.id === id)?.name ?? id;
}

/**
 * What a row says about a match, past the player count.
 *
 * `empty` is deliberately not shown as "empty": every match has sixteen bodies
 * in it whatever the roster says, so joining one is not joining an abandoned
 * server — it is taking a bot's place in a fight already happening. "Bots only"
 * is what is actually true, and it is an invitation rather than a warning.
 */
function stateLabel(match: MatchSummary): string {
  switch (match.state) {
    case "rotating":
      return "Changing map";
    case "empty":
      return "Bots only";
    case "live":
      return match.humans >= match.slots ? "Full" : "In progress";
  }
}

export class LobbyScreen {
  private root: HTMLElement;
  private rows: LobbyRow[] = [];
  private rowEls: HTMLElement[] = [];
  private index = 0;
  private state: LobbyPhase = { phase: "loading" };

  /**
   * Wired by Game: join this specific match, which is running this map.
   *
   * The map id travels WITH the id rather than being looked up later, because
   * this row is where the two are known together — the client has to build the
   * match's world and not its own, and a join that carried only the id would
   * leave the game guessing until the welcome arrived.
   */
  onJoin: (matchId: string, mapId: string) => void = () => {};
  /** Wired by Game: start a new match on this server, on the chosen map. */
  onCreate: () => void = () => {};
  /**
   * Wired by Game: the map row moved, to this index into `MAPS`.
   *
   * An index and not the choice itself: `Game` owns the pick (it is the same
   * one the menu shows and the same one that is remembered), so this screen
   * asks for it to move and is told what it became through `setMapChoice`. It
   * never writes its own state — the rule every list-shaped screen here keeps.
   */
  onPickMap: (index: number) => void = () => {};
  /** Wired by Game: fetch the list again. */
  onRefresh: () => void = () => {};
  /** Wired by Game: leave the screen. */
  onClose: () => void = () => {};

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "lobby";
    this.root.className = "hidden";
    document.getElementById("hud")!.appendChild(this.root);
  }

  show(): void {
    this.root.classList.remove("hidden");
    // Raised anew every time, and never on the row the list happens to start
    // with. Unlike the main menu there is nothing worth preserving across
    // visits — the rows themselves differ each time — but the row it OPENS on
    // matters for the same reason `MENU_DEFAULT` puts the menu's cursor on
    // Deploy rather than on Map: the screen is raised to do something, and the
    // first row is a picker that would answer a blind Enter by cycling a map.
    // The identity rule then keeps the cursor here when the list lands under
    // it.
    this.index = 0;
    this.state = { phase: "loading" };
    this.render();
    const create = this.rows.findIndex((r) => r.kind === "create");
    if (create >= 0) this.setIndex(create);
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  isOpen(): boolean {
    return !this.root.classList.contains("hidden");
  }

  /** A fetch came back. */
  setList(result: LobbyResult): void {
    this.state = { phase: "ready", result };
    this.render();
  }

  /** A join is in flight; the screen stays up until the round replaces it. */
  setJoining(matchId: string): void {
    this.state = { phase: "joining", matchId };
    this.render();
  }

  /**
   * Which map a new match would be started on, as an index into `MAPS`.
   *
   * Pushed in by `Game` both when the screen opens and after every pick, so the
   * row and the game's own choice cannot disagree — the same one-way shape
   * `SettingsScreen.setValues` has.
   */
  setMapChoice(index: number): void {
    if (index === this.mapChoice) return;
    this.mapChoice = index;
    this.render();
  }

  /** The map row's selection. Index into `MAPS`; `Game` owns the value. */
  private mapChoice = 0;

  moveRow(delta: number): void {
    if (this.rows.length === 0) return;
    const n = this.rows.length;
    this.setIndex((this.index + delta + n) % n);
  }

  /** Fires the cursor's row — Enter / pad A / a click. */
  activate(): void {
    const row = this.rows[this.index];
    if (!row) return;
    // A join already in flight swallows further picks. Two `connect`s would
    // leave `Game.net` pointing at one session while another still holds a
    // socket — `joinMatch` guards on `this.net` and would drop the second on
    // the floor, which looks from here like a button that did nothing.
    if (this.state.phase === "joining") return;
    switch (row.kind) {
      case "match":
        // A full match is drawn dimmed and refuses the confirm, rather than
        // being left out of the list. Knowing a round is there and full is
        // worth more than a shorter list, and the server would refuse the
        // join anyway — this only saves the round trip.
        if (row.match.humans >= row.match.slots) return;
        this.onJoin(row.match.id, row.match.mapId);
        break;
      // WRAPS, where left/right clamps — the same split the menu's map row
      // keeps. A confirm that answers nothing is the thing a list screen is
      // rebuilt to remove, so the button always moves the choice on.
      case "map":
        if (MAPS.length > 0) this.onPickMap((this.mapChoice + 1) % MAPS.length);
        break;
      case "create":
        this.onCreate();
        break;
      case "refresh":
        this.onRefresh();
        break;
      case "back":
        this.onClose();
        break;
    }
  }

  /**
   * Left/right on the cursor's row.
   *
   * Only the map row has anything to step, and it CLAMPS where the confirm
   * wraps. Every other row does one thing on Enter and deliberately nothing on
   * a horizontal nudge: a match row's map belongs to that match, so there is
   * nothing here for left and right to change.
   */
  stepRow(delta: number): void {
    // A join in flight swallows this for the reason `activate` states — the
    // screen is on its way out and the pick would be spent on nothing.
    if (this.state.phase === "joining") return;
    if (this.rows[this.index]?.kind !== "map") return;
    this.onPickMap(this.mapChoice + delta);
  }

  /**
   * The rows this list currently has.
   *
   * The actions are always present, even when the fetch failed — a server that
   * did not answer is the case where Refresh matters most, and a screen with no
   * Back is one that traps a pad player. The map row is one of them for the
   * same reason: it is what a new match would be started on, and creating one
   * is exactly what a player does when the list is empty.
   */
  private buildRows(): LobbyRow[] {
    const rows: LobbyRow[] = [];
    if (this.state.phase !== "loading") {
      const result =
        this.state.phase === "ready" ? this.state.result : this.lastOk;
      if (result?.ok) {
        for (const match of result.list.matches) rows.push({ kind: "match", match });
      }
    }
    rows.push(
      { kind: "map" },
      { kind: "create" },
      { kind: "refresh" },
      { kind: "back" },
    );
    return rows;
  }

  /**
   * The last list that arrived, kept so a join in flight can keep drawing the
   * rows the player picked from instead of collapsing to three actions under
   * their cursor.
   */
  private lastOk: LobbyResult | null = null;

  private render(): void {
    if (this.state.phase === "ready" && this.state.result.ok) {
      this.lastOk = this.state.result;
    }
    // The row the cursor is ON, captured before the list is rebuilt under it.
    const held = this.rows[this.index];
    this.rows = this.buildRows();
    // Kept by IDENTITY, not by index. A refresh inserts match rows ABOVE the
    // actions, so an index carried across one silently means a different row —
    // press Refresh, let a match appear, press Enter again and you have created
    // a match instead of refreshing, with the highlight having moved under your
    // hand to say so. Falling back to the clamp covers the row that genuinely
    // went away (a match that filled), which should leave the cursor near where
    // it was rather than at the top.
    const wanted = held ? this.rows.findIndex((r) => sameRow(r, held)) : -1;
    this.index =
      wanted >= 0
        ? wanted
        : Math.max(0, Math.min(this.index, this.rows.length - 1));

    this.root.innerHTML = `
      <div class="lb-panel frame">
        <h2>Multiplayer</h2>
        <p class="lb-sub"><span class="lb-status"></span><span class="lb-ping"></span></p>
        <div class="lb-body">
          ${this.rows.map((row, i) => this.rowMarkup(row, i)).join("")}
        </div>
        <p class="lb-nav">
          <span><kbd>&uarr;</kbd><kbd>&darr;</kbd><kbd class="pad">Stick / D-pad</kbd> move</span>
          <span><kbd>&larr;</kbd><kbd>&rarr;</kbd> map</span>
          <span><kbd>Enter</kbd><kbd class="pad">A</kbd> select</span>
          <span><kbd>Esc</kbd><kbd class="pad">B</kbd> back</span>
        </p>
      </div>
    `;

    // Assigned, not interpolated. The subtitle carries a server-supplied error
    // string and a row carries a possibly-unknown map id, and `textContent` is
    // the whole of the defence — the same rule `HUD` states at the top of its
    // own file for the strings it writes every frame.
    const sub = this.root.querySelector<HTMLElement>(".lb-status");
    if (sub) sub.textContent = this.subtitle();
    this.fillPing();

    // `Array.from`, not a spread: the root tsconfig's `lib` has DOM but not
    // DOM.Iterable, so a `NodeListOf` is not statically iterable here.
    this.rowEls = Array.from(
      this.root.querySelectorAll<HTMLElement>("[data-row]"),
    );
    this.rowEls.forEach((el, i) => {
      this.fillRow(el, this.rows[i]);
      // Hover moves the cursor, so the highlighted row and the one Enter will
      // fire can never disagree — the rule every list-shaped screen keeps.
      el.onmouseenter = () => this.setIndex(i);
      el.onpointerdown = () => {
        this.setIndex(i);
        // A row that PICKS rather than fires takes its clicks on the buttons
        // inside it, which is the same split the main menu keeps: its map and
        // difficulty rows are ordinary clicks and everything that LEAVES a
        // screen is a pointerdown. Firing the map row here as well would cycle
        // the choice on the way down and then set the clicked one on the way
        // up, which lands in the right place by luck and flickers getting
        // there.
        if (this.rows[i]?.kind !== "map") this.activate();
      };
    });
    // Bound after the rows, so a click on a map button is not also the row's.
    // `onclick` (mouse-UP) is what the menu's own map buttons use, and the row
    // above deliberately does not act on the DOWN edge under them.
    this.root.querySelectorAll<HTMLElement>("button[data-map]").forEach((btn) => {
      btn.onclick = () => this.onPickMap(Number(btn.dataset.map));
    });
    this.applySelection();
  }

  /** The two text cells of a row, both assigned rather than interpolated. */
  private fillRow(el: HTMLElement, row: LobbyRow): void {
    const name = el.querySelector<HTMLElement>(".lb-id");
    if (!name) return;
    // The map row's second cell is its buttons, which `rowMarkup` wrote from
    // this build's own map table — there is no wire string in it, so there is
    // nothing here to assign.
    if (row.kind === "map") {
      name.textContent = "Map";
      return;
    }
    const state = el.querySelector<HTMLElement>(".lb-state");
    if (!state) return;
    if (row.kind === "match") {
      name.textContent = mapName(row.match.mapId);
      state.textContent = stateLabel(row.match);
      return;
    }
    const [label, hint] = ACTION_LABELS[row.kind];
    name.textContent = label;
    // The one hint that is not a constant: the row states which map it would
    // start a match on, so the choice one row above is visibly what this
    // button spends. `MAPS` is this build's own table, but it reaches the DOM
    // through `textContent` like every other cell here.
    state.textContent =
      row.kind === "create" && MAPS[this.mapChoice]
        ? `${hint} on ${MAPS[this.mapChoice].name}`
        : hint;
  }

  /** The line under the title: what happened, or what is running. */
  private subtitle(): string {
    if (this.state.phase === "loading") return "Looking for matches…";
    if (this.state.phase === "joining") return "Joining…";
    const result = this.state.result;
    if (!result.ok) return result.error;
    if (result.list.full) {
      return "Every match on this server is full.";
    }
    const n = result.list.matches.length;
    if (n === 0) return "No matches running — start one.";
    return `${n} match${n === 1 ? "" : "es"} on this server`;
  }

  /**
   * The round trip to this server, beside the count of what it is running.
   *
   * **One reading for the screen and not one per row**, because there is one
   * server behind every row on it: the same number printed four times would
   * read as though picking a row picked a connection, when what a match row
   * chooses is a round on a machine the player has already reached. It is the
   * fetch's own round trip — see `fetchMatches` — so it refreshes when the list
   * does and there is no timer on this screen.
   *
   * A fetch that failed leaves the cell EMPTY rather than showing a zero or a
   * dash: the subtitle beside it is already saying the server did not answer,
   * and a second cell saying so in numbers is a reading nobody took.
   */
  private fillPing(): void {
    const el = this.root.querySelector<HTMLElement>(".lb-ping");
    if (!el) return;
    // A join in flight keeps drawing the list the player picked from, so it
    // keeps that list's reading with it — the same `lastOk` the rows fall back
    // to.
    const result =
      this.state.phase === "ready"
        ? this.state.result
        : this.state.phase === "joining"
          ? this.lastOk
          : null;
    const ping = result?.ok ? result.ping : -1;
    el.className = `lb-ping ${pingQuality(ping)}`;
    el.textContent = ping < 0 ? "" : `ping ${pingText(ping)} ms`;
  }

  private rowMarkup(row: LobbyRow, i: number): string {
    const sel = i === this.index ? " sel" : "";
    // The map picker: one button per map, the chosen one lit, exactly the
    // shape the menu's Map row has. The names are interpolated because they
    // are THIS build's own constants — the rule at the top of the file is
    // about strings that came off the wire, and a match's map id (which may be
    // anything) goes through `fillRow` like every other one.
    if (row.kind === "map") {
      const buttons = MAPS.map(
        (m, n) =>
          `<button class="lb-pick${n === this.mapChoice ? " on" : ""}" data-map="${n}">${m.name}</button>`,
      ).join("");
      return `<div class="lb-row lb-action lb-mapline${sel}" data-row="${i}">
          <span class="lb-id"></span><span class="lb-picks">${buttons}</span>
          <span class="lb-count"></span>
        </div>`;
    }
    if (row.kind !== "match") {
      return `<div class="lb-row lb-action${sel}" data-row="${i}">
          <span class="lb-id"></span><span class="lb-state"></span>
          <span class="lb-count"></span>
        </div>`;
    }
    const full = row.match.humans >= row.match.slots;
    const busy =
      this.state.phase === "joining" && this.state.matchId === row.match.id;
    // The counts are numbers the server computed, so they are safe to
    // interpolate; the two text cells next door are not, and are left empty
    // for `fillRow`.
    return `<div class="lb-row lb-match${sel}${full ? " full" : ""}${busy ? " busy" : ""}" data-row="${i}">
        <span class="lb-id"></span><span class="lb-state"></span>
        <span class="lb-count"><b>${row.match.humans}</b> / ${row.match.slots}</span>
      </div>`;
  }

  private setIndex(i: number): void {
    if (i === this.index) return;
    this.index = i;
    this.applySelection();
  }

  /** Paints the cursor onto rows that already exist, never by redrawing. */
  private applySelection(): void {
    this.rowEls.forEach((el, i) => el.classList.toggle("sel", i === this.index));
  }
}
