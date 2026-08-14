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

/**
 * One line, in screen order.
 *
 * The actions are rows rather than buttons beside the list, for the same reason
 * the main menu became a list: a cursor that reaches every affordance is one a
 * pad can drive without anybody inventing a face button per control.
 */
type LobbyRow =
  | { kind: "match"; match: MatchSummary }
  | { kind: "create" }
  | { kind: "refresh" }
  | { kind: "back" };

/** What the screen is doing, which decides what stands in for the list. */
type LobbyPhase =
  | { phase: "loading" }
  | { phase: "ready"; result: LobbyResult }
  /** A join is in flight. The list stays up so the chosen row is still read. */
  | { phase: "joining"; matchId: string };

/** Label and hint for each action row. */
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

  /** Wired by Game: join this specific match. */
  onJoin: (matchId: string) => void = () => {};
  /** Wired by Game: start a new match on this server. */
  onCreate: () => void = () => {};
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
    // Raised anew every time, so the cursor starts at the top of a list the
    // player has not seen. Unlike the main menu there is no row worth
    // preserving across visits — the rows themselves differ each time.
    this.index = 0;
    this.state = { phase: "loading" };
    this.render();
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
        this.onJoin(row.match.id);
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
   * The rows this list currently has.
   *
   * The actions are always present, even when the fetch failed — a server that
   * did not answer is the case where Refresh matters most, and a screen with no
   * Back is one that traps a pad player.
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
    rows.push({ kind: "create" }, { kind: "refresh" }, { kind: "back" });
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
        <p class="lb-sub"></p>
        <div class="lb-body">
          ${this.rows.map((row, i) => this.rowMarkup(row, i)).join("")}
        </div>
        <p class="lb-nav">
          <span><kbd>&uarr;</kbd><kbd>&darr;</kbd><kbd class="pad">Stick / D-pad</kbd> move</span>
          <span><kbd>Enter</kbd><kbd class="pad">A</kbd> select</span>
          <span><kbd>Esc</kbd><kbd class="pad">B</kbd> back</span>
        </p>
      </div>
    `;

    // Assigned, not interpolated. The subtitle carries a server-supplied error
    // string and a row carries a possibly-unknown map id, and `textContent` is
    // the whole of the defence — the same rule `HUD` states at the top of its
    // own file for the strings it writes every frame.
    const sub = this.root.querySelector<HTMLElement>(".lb-sub");
    if (sub) sub.textContent = this.subtitle();

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
        this.activate();
      };
    });
    this.applySelection();
  }

  /** The two text cells of a row, both assigned rather than interpolated. */
  private fillRow(el: HTMLElement, row: LobbyRow): void {
    const name = el.querySelector<HTMLElement>(".lb-id");
    const state = el.querySelector<HTMLElement>(".lb-state");
    if (!name || !state) return;
    if (row.kind === "match") {
      name.textContent = mapName(row.match.mapId);
      state.textContent = stateLabel(row.match);
      return;
    }
    const [label, hint] = ACTION_LABELS[row.kind];
    name.textContent = label;
    state.textContent = hint;
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

  private rowMarkup(row: LobbyRow, i: number): string {
    const sel = i === this.index ? " sel" : "";
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
