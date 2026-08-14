/**
 * net/lobby.ts — Asking a match server what it is running, before there is a
 * socket.
 * Owns: the `/matches` request and the one piece of arithmetic behind it —
 * turning the WebSocket URL the rest of the net layer speaks in into the HTTP
 * origin the list lives on. Owns no UI and no state: it is one function that
 * fetches and returns.
 * Invariants: never opens a socket, never joins anything, and never throws a
 * raw `TypeError` at a caller — a server that is down is an ordinary answer for
 * a lobby to render, not an exception for it to handle.
 *
 * This is the ONE part of multiplayer that is not the WebSocket. It is plain
 * HTTP on purpose: a client browsing matches has not committed to anything yet,
 * and making it hold a socket open to read a list would mean every idle player
 * sitting on a menu is a connection the server has to carry.
 */
import type { MatchList } from "./protocol";

/**
 * How long to wait for a list before calling the server down, in ms.
 *
 * Short, because this is a menu: the endpoint does no work — it walks a Map of
 * at most a handful of matches and stringifies it — so anything past a second
 * is a network that is not going to answer, and a lobby that spins for thirty
 * seconds before admitting it is a lobby nobody waits out.
 */
const LIST_TIMEOUT_MS = 4000;

/**
 * Where the match list lives, given where the socket does.
 *
 * The net layer speaks in WebSocket URLs — a relative `/ws` in a deployed
 * build, an absolute `ws://host:port/ws` for a dev client pointed at another
 * port — and the list is the same server over HTTP. So the ORIGIN is what
 * carries over and the path is replaced outright: `wss://` becomes `https://`,
 * `ws://` becomes `http://`, and a relative URL means the page's own origin,
 * which is exactly what nginx's `/matches` proxy answers on.
 *
 * The path is not derived from the socket's (`/ws` → `/matches` by string
 * surgery) because those two are proxied independently and only agree by
 * convention. Naming it outright means a server that moves its socket does not
 * silently take the lobby with it.
 */
function listUrl(wsUrl: string): string {
  if (/^wss?:\/\//.test(wsUrl)) {
    const parsed = new URL(wsUrl);
    return `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}/matches`;
  }
  return `${location.origin}/matches`;
}

/** What a lobby got back, or why it got nothing. */
export type LobbyResult =
  | { ok: true; list: MatchList }
  | { ok: false; error: string };

/**
 * Fetches the match list from the server the given socket URL points at.
 *
 * Every failure comes back as `{ ok: false }` with something a player can read.
 * The distinction that matters to the caller is not WHICH failure it was but
 * that there is nothing to show, and a lobby that renders "could not reach the
 * match server" is more use than one that renders an empty list — an empty list
 * means "no matches running", which is a different and joinable situation.
 */
export async function fetchMatches(wsUrl?: string): Promise<LobbyResult> {
  const url = listUrl(wsUrl ?? "");
  try {
    const res = await fetch(url, {
      // The server sends `no-store`, but a client that asks for a fresh copy
      // does not have to trust it — this is a list whose whole value is being
      // current.
      cache: "no-store",
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `match server returned ${res.status}` };
    const list = (await res.json()) as MatchList;
    // Shape-checked rather than trusted. This is the one endpoint that can be
    // answered by something that is not the match server at all: a misconfigured
    // proxy hands back `index.html` with a 200, and `list.matches.map` on a
    // string is a crash in the menu rather than a message in it.
    if (!Array.isArray(list?.matches)) {
      return { ok: false, error: "match server sent something unreadable" };
    }
    return { ok: true, list };
  } catch (err) {
    // `AbortSignal.timeout` rejects with a `TimeoutError`; a server that is not
    // listening rejects with a `TypeError` that says only "Failed to fetch".
    // Neither is worth showing verbatim.
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut ? "match server did not answer" : "could not reach the match server",
    };
  }
}
