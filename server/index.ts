/**
 * server/index.ts — Process entry: the two HTTP endpoints, the WebSocket
 * listener, and the match registry.
 * Owns: accepting a socket, parsing the first message, routing the peer to a
 * `Match`, creating matches and bounding how many exist. It owns no simulation
 * and no game rules — everything past the handshake belongs to `Match`.
 * Invariants: nothing here trusts a client. A socket that does not open with a
 * well-formed `join` at the right protocol version is closed, and a peer is
 * only ever given the slot the roster hands out. Never import a rendering
 * system; see `server/README.md` for what a NullEngine cannot do.
 *
 * **This registry IS the lobby.** Matches live in this process's memory, so the
 * list it serves on `/matches` is authoritative for itself and needs nothing
 * central to check in with — which is true exactly as long as there is one
 * process. Two replicas behind one proxy would each serve their own half of the
 * world as though it were all of it, and a player picking `m1` would reach
 * whichever replica the proxy chose. See `docs/multiplayer.md`.
 */
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  decode,
  encode,
  PROTOCOL_VERSION,
  type ClientMessage,
  type MatchList,
} from "../src/net/protocol";
import { Match } from "./Match";

const PORT = Number(process.env.PORT ?? 8080);

/**
 * How many matches this process will hold at once.
 *
 * Node is single-threaded, so every match here shares one core: a sixteen-bot
 * round costs a few percent of it at `TICK_HZ` (see the note on that constant),
 * and each also holds a scene, sixteen rigs and a nav graph in memory. Four is
 * a deliberately conservative default for one small box — raise it with the env
 * var once you have measured the box you are actually on, rather than guessing
 * upward from here.
 *
 * The cap is what makes "create a match" a safe button to put in a lobby. A
 * create path with nothing bounding it is a way for anyone to spend the whole
 * server's memory from the menu.
 */
const MAX_MATCHES = Math.max(1, Number(process.env.MAX_MATCHES ?? 4));

/**
 * Matches, by id. One for now — matchmaking across several is phase 8, and the
 * registry exists so that adding it does not mean rewriting the handshake.
 */
const matches = new Map<string, Match>();

/**
 * Monotonic, not `matches.size`. Ids derived from the size are reused as soon
 * as a match is forgotten, so two different matches in one process could both
 * be called `m2` — and a client's logs, or a reconnect naming one, would refer
 * to whichever happened to be alive.
 */
let nextMatchId = 1;

/** Builds and registers a match. The only place either happens. */
function createMatch(): Match {
  const match = new Match(`m${nextMatchId++}`);
  match.onRetired = () => matches.delete(match.id);
  matches.set(match.id, match);
  return match;
}

/**
 * Where a joining peer should land, or why it cannot.
 *
 * Every match always has sixteen bodies in it, so "is there room" is a question
 * about how many of those are bots rather than about how many people are
 * present — which is exactly the property that lets a match start with one
 * human in it and fill up later.
 *
 * **A named match is never substituted.** A peer that asked for `m3` and could
 * be seated in `m4` instead is refused, because it picked that row off a lobby
 * for a reason — the map on it, or the people in it — and being quietly moved
 * is indistinguishable from the lobby being wrong. The refusal names the cause,
 * and the lobby's answer is to refresh, which is honest and takes a second.
 *
 * An UNNAMED join is the opposite and still fills whatever has room: that is
 * `?mp` on the URL and every client that predates the lobby, neither of which
 * expressed a preference to betray.
 */
function routeJoin(
  matchId?: string,
  create?: boolean,
): { match: Match } | { refuse: string } {
  if (matchId !== undefined) {
    const match = matches.get(matchId);
    // Gone rather than never-existed, most likely: an idle match disposes its
    // world after a minute and drops out of the registry, so a lobby left open
    // on a desk names matches that have since retired.
    if (!match) return { refuse: `match ${matchId} is no longer running` };
    if (!match.hasBotSlot()) return { refuse: `match ${matchId} is full` };
    return { match };
  }
  if (create) {
    if (matches.size >= MAX_MATCHES) {
      return { refuse: "this server is already running as many matches as it can" };
    }
    return { match: createMatch() };
  }
  for (const match of matches.values()) {
    if (match.hasBotSlot()) return { match };
  }
  if (matches.size >= MAX_MATCHES) {
    return { refuse: "every match on this server is full" };
  }
  return { match: createMatch() };
}

/** The lobby's view of this process. */
function matchList(): MatchList {
  return {
    protocol: PROTOCOL_VERSION,
    full:
      matches.size >= MAX_MATCHES &&
      ![...matches.values()].some((m) => m.hasBotSlot()),
    matches: [...matches.values()].map((m) => m.summary()),
  };
}

const http = createServer((req, res) => {
  if (req.url === "/matches") {
    res.writeHead(200, {
      "content-type": "application/json",
      // The lobby fetches this before any socket exists, and in DEV it does so
      // from another origin: the client is on Vite's port and the server on its
      // own, with no nginx in between to make them one. Read-only and public —
      // it is the same list anyone can get by connecting — so there is nothing
      // here an origin check would protect. In production nginx proxies
      // `/matches` onto the game's own origin and this header is moot.
      "access-control-allow-origin": "*",
      // A lobby row that is four seconds stale is a row that lies about who is
      // in it, and this is cheap to recompute.
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(matchList()));
    return;
  }
  // Kept distinct from `/matches`: this one answers "is the process alive" for
  // the container healthcheck, and must not start depending on the lobby's
  // shape. Docker calls it every 30 s.
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http, path: "/ws" });

wss.on("connection", (socket: WebSocket) => {
  // A peer is anonymous until it says `join`. Until then it holds no slot, so a
  // socket that opens and says nothing costs one entry in ws's own client set
  // and nothing in any match.
  let joined = false;

  const refuse = (reason: string): void => {
    socket.send(encode({ t: "rejected", reason }));
    socket.close();
  };

  socket.on("message", (raw) => {
    const msg = decode(String(raw)) as ClientMessage | null;
    if (!msg) return refuse("malformed message");

    if (!joined) {
      if (msg.t !== "join") return refuse("first message must be join");
      if (msg.version !== PROTOCOL_VERSION) {
        return refuse(
          `protocol ${msg.version} but this server speaks ${PROTOCOL_VERSION}`,
        );
      }
      const route = routeJoin(msg.matchId, msg.create);
      // Refused BEFORE `joined` is set, so a client that named a match which
      // has since filled can pick another row and try again on the same socket
      // rather than reconnecting. `refuse` closes it anyway today; leaving the
      // flag alone is what makes a retry a one-line change rather than a
      // handshake redesign.
      if ("refuse" in route) return refuse(route.refuse);
      joined = true;
      // `admit` builds the world on the first arrival, so it is async. A
      // failure there must close the socket rather than leave a client waiting
      // on a welcome that is never coming.
      route.match.admit(socket, msg.name, msg.weapon).catch((err: unknown) => {
        console.error("admit failed:", err);
        refuse("could not start a match");
      });
      return;
    }
    // Past the handshake the match owns the peer, including this socket's
    // remaining messages — it registered its own handler in `admit`.
  });
});

http.listen(PORT, () => {
  console.log(
    `hollowmere server on :${PORT} (protocol ${PROTOCOL_VERSION}, up to ${MAX_MATCHES} matches)`,
  );
});
