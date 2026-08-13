/**
 * server/Match.ts — One match: its roster, its peers, its simulation loop, and
 * the snapshots that go out from it.
 * Owns: the fixed-step clock, the peer set, and the bridge between a roster slot
 * changing hands and the bot in that slot being benched or released. It owns no
 * game rules — those are `HeadlessGame`'s — and no transport details beyond
 * `send`/`broadcast`, which are the one place a dead socket is handled.
 * Invariants: a peer's slot is assigned here and nowhere else, and a peer never
 * names its own slot. The loop is fixed-step and drift-corrected: a `dt` taken
 * from wall clock would make the simulation run at the speed of the server's
 * load, and every recoil, bleed and reload timer in `CONFIG` is written against
 * real seconds.
 */
import type { WebSocket } from "ws";
import {
  decode,
  encode,
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  TICK_HZ,
  type ClientMessage,
  type EntityState,
  type PointState,
  type ServerEvent,
  type ServerMessage,
  type Snapshot,
} from "../src/net/protocol";
import { MAPS } from "../src/world/maps";
import { HeadlessGame } from "./HeadlessGame";
import { Roster } from "./Roster";

/** One connected human. */
interface Peer {
  id: string;
  name: string;
  socket: WebSocket;
  /** Last input sequence accepted from this peer. */
  seq: number;
}

const STEP_MS = 1000 / TICK_HZ;

/**
 * Ticks between snapshots. `SNAPSHOT_HZ` divides `TICK_HZ`, so this is exact —
 * see the note on those constants for why a fractional ratio is not allowed.
 */
const TICKS_PER_SNAPSHOT = TICK_HZ / SNAPSHOT_HZ;

let nextPeerId = 1;

export class Match {
  readonly roster = new Roster();
  readonly game = new HeadlessGame();

  private readonly peers = new Map<string, Peer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private mapId = MAPS[0].id;
  private ticks = 0;

  /**
   * Events accumulated since the last broadcast.
   *
   * Queued rather than sent as they happen because a kill and the snapshot that
   * shows the body falling belong in the same frame for a client: delivering the
   * killfeed line first makes the corpse arrive late, and it reads as lag in the
   * one moment a player is paying most attention.
   */
  private readonly pending: ServerEvent[] = [];

  /** Reused so a snapshot allocates nothing per tick beyond its own arrays. */
  private readonly entityScratch: EntityState[] = [];

  constructor(readonly id: string) {
    this.game.onKillEvent = (bot, killer) => {
      this.pending.push({
        e: "kill",
        killer,
        victim: this.game.battle.bots.indexOf(bot),
        headshot: false,
      });
    };
    this.game.conquest.onCaptured = (point, by) =>
      this.pending.push({ e: "captured", point: point.def.id, by });
    this.game.conquest.onNeutralised = (point) =>
      this.pending.push({ e: "neutralised", point: point.def.id });
  }

  hasBotSlot(): boolean {
    return this.roster.hasBotSlot();
  }

  summary(): { id: string; humans: number; slots: number; tick: number } {
    return {
      id: this.id,
      humans: this.roster.humanCount,
      slots: this.roster.slots.length,
      tick: this.ticks,
    };
  }

  /**
   * Seats a connected socket.
   *
   * A refused join is a full match, which the registry should have prevented by
   * routing elsewhere — but the check is kept here anyway, because the caller
   * asking "is there room" and this method acting on the answer are two separate
   * moments and a race between them is exactly how a seventeenth player gets in.
   */
  async admit(socket: WebSocket, name: string): Promise<void> {
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

    // The round is built on the first arrival, not at construction: building a
    // world costs a couple of hundred milliseconds and a match nobody has joined
    // has nothing to simulate.
    await this.ensureRunning();

    this.send(peer, {
      t: "welcome",
      version: PROTOCOL_VERSION,
      matchId: this.id,
      slot: slot.index,
      team: slot.team,
      mapId: this.mapId,
      now: Date.now(),
    });
    this.broadcastRoster();
    console.log(
      `[${this.id}] ${name} (${id}) took slot ${slot.index} on team ${slot.team}`,
    );
  }

  /**
   * A peer left. Its slot goes back to being a bot, and the bot walks on.
   *
   * The same handover as `admit`, run backwards, and it is why the roster is a
   * fixed table rather than a list that grows: there is nothing to allocate,
   * nothing to place in the world, and no window in which the match is fifteen
   * bodies instead of sixteen.
   */
  private drop(peer: Peer): void {
    if (!this.peers.delete(peer.id)) return;
    const slot = this.roster.release(peer.id);
    if (slot) {
      console.log(`[${this.id}] ${peer.name} left; slot ${slot.index} back to a bot`);
    }
    this.broadcastRoster();
    // Nobody watching: stop burning a core on a fight with no audience. The
    // world stays built, so the next arrival resumes rather than reloads.
    if (this.peers.size === 0) this.stop();
  }

  private async ensureRunning(): Promise<void> {
    if (this.timer) return;
    if (!this.game.map) {
      const def = MAPS.find((m) => m.id === this.mapId) ?? MAPS[0];
      await this.game.startRound(def, 1);
    }
    // Wall-clock accumulator rather than one step per timer fire: `setInterval`
    // drifts and coalesces under load, and a simulation that took its `dt` from
    // whenever the timer happened to run would speed up and slow down with the
    // host's load. Everything in `CONFIG` — reload times, bleed intervals,
    // recoil decay — is written against real seconds.
    let carried = 0;
    let last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      carried += now - last;
      last = now;
      // Bounded so a long stall (a GC pause, a suspended container) is dropped
      // rather than replayed as a burst of catch-up ticks that would teleport
      // every body on every client at once.
      if (carried > 250) carried = 250;
      while (carried >= STEP_MS) {
        carried -= STEP_MS;
        this.step();
      }
    }, STEP_MS);
    console.log(`[${this.id}] round started on ${this.mapId}`);
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.log(`[${this.id}] no peers left; loop stopped`);
  }

  /** One simulation step, and a snapshot on the ticks that owe one. */
  private step(): void {
    const live = this.game.step(1 / TICK_HZ);
    this.ticks++;

    if (!live && this.game.conquest.winner !== null) {
      this.pending.push({ e: "roundover", winner: this.game.conquest.winner });
      this.stop();
    }
    if (this.ticks % TICKS_PER_SNAPSHOT === 0) this.broadcastSnapshot();
  }

  /**
   * The world as the clients need to draw it.
   *
   * Every slot is sent every time. A delta encoding would be smaller and is the
   * obvious next step, but it is only correct once there is an acknowledgement
   * channel to say which baseline a client actually holds — and getting that
   * wrong is a client that renders a stale world with no way to notice.
   */
  private broadcastSnapshot(): void {
    const bots = this.game.battle.bots;
    this.entityScratch.length = 0;
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      this.entityScratch.push({
        i,
        p: [bot.position.x, bot.position.y, bot.position.z],
        yaw: bot.lookYaw,
        bodyYaw: bot.feetYaw,
        pitch: bot.aimAngle,
        moving: bot.moveAmount,
        alive: bot.alive,
        dead: bot.deathProgress,
      });
    }

    const points: PointState[] = this.game.conquest.points.map((p) => ({
      id: p.def.id,
      owner: p.owner,
      meter: p.meter,
      contested: p.contested,
    }));

    const snap: Snapshot = {
      t: "snap",
      tick: this.ticks,
      now: Date.now(),
      entities: this.entityScratch,
      points,
      tickets: [this.game.conquest.tickets[0], this.game.conquest.tickets[1]],
    };
    this.broadcast(snap);

    if (this.pending.length > 0) {
      this.broadcast({ t: "events", events: [...this.pending] });
      this.pending.length = 0;
    }
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
