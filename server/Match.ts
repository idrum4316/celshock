/**
 * server/Match.ts — One match: its roster, its peers, and (from phase 2) the
 * simulation loop.
 * Owns: the peer set, the handshake reply, and the bridge between a roster slot
 * changing hands and the bot in that slot being benched or released.
 * Invariants: a peer's slot is assigned here and nowhere else, and a peer never
 * names its own slot. Every outbound message goes through `send`/`broadcast` so
 * there is one place a dead socket is handled.
 *
 * The simulation is deliberately NOT here yet — phase 2 adds `HeadlessGame` and
 * this file drives it. What is here is everything that is true regardless of
 * whether a tick has ever run, so that the loop lands in a file that already
 * knows who is playing.
 */
import type { WebSocket } from "ws";
import {
  decode,
  encode,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "../src/net/protocol";
import { Roster } from "./Roster";

/** One connected human. */
interface Peer {
  id: string;
  name: string;
  socket: WebSocket;
  /** Last input sequence accepted from this peer. */
  seq: number;
}

let nextPeerId = 1;

export class Match {
  readonly roster = new Roster();

  private readonly peers = new Map<string, Peer>();

  constructor(readonly id: string) {}

  hasBotSlot(): boolean {
    return this.roster.hasBotSlot();
  }

  summary(): { id: string; humans: number; slots: number } {
    return {
      id: this.id,
      humans: this.roster.humanCount,
      slots: this.roster.slots.length,
    };
  }

  /**
   * Seats a connected socket.
   *
   * A refused join is a full match, which the registry should have prevented by
   * routing elsewhere — but the check is kept here anyway, because the caller
   * asking "is there room" and this method acting on the answer are two
   * separate moments and a race between them is exactly how a seventeenth
   * player gets in.
   */
  admit(socket: WebSocket, name: string): void {
    const id = `p${nextPeerId++}`;
    const slot = this.roster.claim(id, name);
    if (!slot) {
      socket.send(encode({ t: "rejected", reason: "match full" }));
      socket.close();
      return;
    }

    const peer: Peer = { id, name, socket, seq: 0 };
    this.peers.set(id, peer);

    socket.on("message", (raw) => {
      const msg = decode(String(raw)) as ClientMessage | null;
      if (msg) this.onMessage(peer, msg);
    });
    socket.on("close", () => this.drop(peer));
    socket.on("error", () => this.drop(peer));

    this.send(peer, {
      t: "welcome",
      version: PROTOCOL_VERSION,
      matchId: this.id,
      slot: slot.index,
      team: slot.team,
      // Phase 2 replaces this with the match's actual map.
      mapId: "hollowmere",
      now: Date.now(),
    });
    this.broadcastRoster();
    console.log(`[${this.id}] ${name} (${id}) took slot ${slot.index} on team ${slot.team}`);
  }

  /**
   * A peer left. Its slot goes back to being a bot, and the bot walks on.
   *
   * This is the same handover as `admit`, run backwards, and it is why the
   * roster is a fixed table rather than a list that grows: there is nothing to
   * allocate, nothing to place in the world, and no window in which the match
   * is fifteen bodies instead of sixteen.
   */
  private drop(peer: Peer): void {
    if (!this.peers.delete(peer.id)) return;
    const slot = this.roster.release(peer.id);
    if (slot) {
      console.log(`[${this.id}] ${peer.name} left; slot ${slot.index} back to a bot`);
    }
    this.broadcastRoster();
  }

  private onMessage(peer: Peer, msg: ClientMessage): void {
    switch (msg.t) {
      case "join":
        // Already seated. A second join is a confused client, not an attack.
        break;
      case "move":
      case "shot":
      case "grenade":
      case "deploy":
        // Phase 4 onward. Sequence tracking starts now so that a client which
        // is already sending is not silently ignored while the handlers land.
        if ("seq" in msg) peer.seq = Math.max(peer.seq, msg.seq);
        break;
    }
  }

  private broadcastRoster(): void {
    this.broadcast({ t: "roster", slots: this.roster.slots });
  }

  private send(peer: Peer, msg: ServerMessage): void {
    if (peer.socket.readyState === peer.socket.OPEN) {
      peer.socket.send(encode(msg));
    }
  }

  private broadcast(msg: ServerMessage): void {
    const payload = encode(msg);
    for (const peer of this.peers.values()) {
      if (peer.socket.readyState === peer.socket.OPEN) peer.socket.send(payload);
    }
  }
}
