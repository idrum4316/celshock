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
import { CONFIG } from "../src/config";
import { MAPS } from "../src/world/maps";
import { HeadlessGame } from "./HeadlessGame";
import { Roster } from "./Roster";
import { validateMove } from "./validate";

/** One connected human. */
interface Peer {
  id: string;
  name: string;
  socket: WebSocket;
  /** The roster slot this peer holds, which is also its entity id on the wire. */
  slot: number;
  /** Last input sequence accepted from this peer. */
  seq: number;
}

const STEP_MS = 1000 / TICK_HZ;

/**
 * The largest client-reported gap a single movement sample may claim, in
 * seconds. Longer stalls are legitimate — a backgrounded tab, a GC pause — but
 * the ground they would buy is not, so the step is validated against this and
 * the rest of the gap is simply lost.
 */
const MAX_MOVE_GAP = 0.5;

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

  /** Last broadcast position per slot, for deriving a player's walk cycle. */
  private readonly lastSeen: ({ x: number; z: number } | undefined)[] = [];

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

    const peer: Peer = { id, name, socket, slot: slot.index, seq: 0 };
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

    // The bot in this slot comes off the field and a person takes its place.
    const player = this.game.addPlayer(slot.index, slot.team);
    // Deployed straight away for now. A deploy screen that lets the player pick
    // a spawn is phase 7; until then joining puts you in the fight, which is
    // what makes the phase testable at all.
    const spawn = this.game.spawnFor(slot.team);
    if (spawn) {
      player.spawn(spawn.pos, spawn.yaw);
      this.pending.push({
        e: "spawn",
        slot: slot.index,
        pos: [spawn.pos.x, spawn.pos.y, spawn.pos.z],
        yaw: spawn.yaw,
      });
    }

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
    this.game.removePlayer(peer.slot);
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
      // A slot is a person or a bot, and the wire says the same thing either
      // way — one `EntityState` per slot, in slot order. Clients pool one body
      // per slot and never learn which is which.
      const player = this.game.players.get(i);
      if (player) {
        this.entityScratch.push({
          i,
          p: [player.position.x, player.position.y, player.position.z],
          yaw: player.yaw,
          // A human has no separate feet yaw: the first-person body turns as
          // one. Sending `yaw` for both means a remote player's torso twist
          // computes to zero, which is right — there is no strafe-walk pose to
          // reproduce because there was never a rig producing one.
          bodyYaw: player.yaw,
          pitch: player.pitch,
          // Derived from travel rather than reported, so a client cannot lie
          // about its own animation, and so the walk cycle matches the ground
          // actually covered — the same rule `NetSoldier` follows on the far
          // side.
          moving: this.movingFor(i, player.position.x, player.position.z),
          alive: player.alive,
          dead: player.alive ? 0 : 1,
        });
        continue;
      }
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
        this.onMove(peer, msg);
        break;
      case "shot":
      case "grenade":
      case "deploy":
        // Phase 5 and 7. Sequence tracking starts now so that a client which is
        // already sending is not silently ignored while the handlers land.
        if ("seq" in msg) peer.seq = Math.max(peer.seq, msg.seq);
        break;
    }
  }

  /**
   * One reported movement sample: validate it, then keep it or push back.
   *
   * The client simulates its own `Player` and tells us where it ended up. This
   * is the whole of what stops that being a licence to teleport — see
   * `server/validate.ts` for what is and is not caught, and why the tolerance
   * leans toward letting a laggy honest player through.
   */
  private onMove(peer: Peer, msg: Extract<ClientMessage, { t: "move" }>): void {
    const player = this.game.players.get(peer.slot);
    if (!player || !this.game.map) return;

    // Stale or replayed. Sequence numbers are the client's own counter, so an
    // out-of-order arrival is dropped rather than applied backwards.
    if (msg.seq <= player.seq) return;

    // Elapsed CLIENT time since the last accepted sample, clamped. Unclamped,
    // a client that claims a huge gap buys itself a proportionally huge legal
    // step, which is the obvious way to dress a teleport as a lag spike.
    const raw = player.lastTime > 0 ? (msg.time - player.lastTime) / 1000 : 1 / TICK_HZ;
    const dt = Math.min(Math.max(raw, 1 / TICK_HZ), MAX_MOVE_GAP);

    // A dead player reports nothing worth keeping. Their body is wherever they
    // fell and the server owns it until they redeploy.
    if (!player.alive) return;

    const [x, y, z] = msg.pos;
    const verdict = validateMove(this.game.map, player.position, { x, y, z }, dt);
    if (!verdict.ok) {
      // Rejected: the authoritative position is unchanged, and the client is
      // told to come back to it. The sequence sent is the last one ACCEPTED, so
      // the client knows which of its samples survived.
      this.send(peer, {
        t: "correct",
        pos: [player.position.x, player.position.y, player.position.z],
        seq: player.seq,
        reason: verdict.reason!,
      });
      return;
    }

    player.seq = msg.seq;
    player.lastTime = msg.time;
    peer.seq = msg.seq;
    player.apply(
      Date.now(),
      x,
      y,
      z,
      msg.yaw,
      msg.pitch,
      msg.crouching,
      msg.sprinting,
    );
  }

  /**
   * How much walk cycle a player should be shown with, from the ground they
   * covered between snapshots.
   *
   * Derived and not reported: an animation flag a client sets is an animation
   * flag a client can lie about, and a body that slides without moving its legs
   * is the classic tell. `moveSpeed` is the reference, so a walk reads as a
   * full stride and a crouch-shuffle as a partial one.
   */
  private movingFor(slot: number, x: number, z: number): number {
    const prev = this.lastSeen[slot];
    const interval = TICKS_PER_SNAPSHOT / TICK_HZ;
    let moving = 0;
    if (prev) {
      const speed = Math.hypot(x - prev.x, z - prev.z) / interval;
      moving = Math.min(1, speed / CONFIG.player.moveSpeed);
    }
    this.lastSeen[slot] = { x, z };
    return moving;
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
