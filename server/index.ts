/**
 * server/index.ts — Process entry: the HTTP health endpoint, the WebSocket
 * listener, and the match registry.
 * Owns: accepting a socket, parsing the first message, and handing the peer to
 * a `Match`. It owns no simulation and no game rules — everything past the
 * handshake belongs to `Match`.
 * Invariants: nothing here trusts a client. A socket that does not open with a
 * well-formed `join` at the right protocol version is closed, and a peer is
 * only ever given the slot the roster hands out. Never import a rendering
 * system; see `server/README.md` for what a NullEngine cannot do.
 */
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { decode, encode, PROTOCOL_VERSION, type ClientMessage } from "../src/net/protocol";
import { Match } from "./Match";

const PORT = Number(process.env.PORT ?? 8080);

/**
 * Matches, by id. One for now — matchmaking across several is phase 8, and the
 * registry exists so that adding it does not mean rewriting the handshake.
 */
const matches = new Map<string, Match>();

/**
 * The match a joining peer should land in.
 *
 * Every match always has sixteen bodies in it, so "is there room" is a question
 * about how many of those are bots rather than about how many people are
 * present — which is exactly the property that lets a match start with one
 * human in it and fill up later.
 */
function matchForJoin(): Match {
  for (const match of matches.values()) {
    if (match.hasBotSlot()) return match;
  }
  const match = new Match(`m${matches.size + 1}`);
  matches.set(match.id, match);
  return match;
}

const http = createServer((req, res) => {
  if (req.url === "/health") {
    const body = JSON.stringify({
      ok: true,
      protocol: PROTOCOL_VERSION,
      matches: [...matches.values()].map((m) => m.summary()),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
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
      joined = true;
      // `admit` builds the world on the first arrival, so it is async. A
      // failure there must close the socket rather than leave a client waiting
      // on a welcome that is never coming.
      matchForJoin()
        .admit(socket, msg.name)
        .catch((err: unknown) => {
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
  console.log(`hollowmere server on :${PORT} (protocol ${PROTOCOL_VERSION})`);
});
