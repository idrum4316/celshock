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
import { Vector3 } from "@babylonjs/core";
import type { WebSocket } from "ws";
import {
  decode,
  encode,
  MAX_NAME_LENGTH,
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  INPUT_HZ,
  TICK_HZ,
  type ClientMessage,
  type EntityState,
  type MatchSummary,
  type PointState,
  type ServerEvent,
  type ServerMessage,
  type Snapshot,
} from "../src/net/protocol";
import { CONFIG } from "../src/config";
import {
  DEFAULT_WEAPON,
  isPrimaryWeaponId,
  weaponSetup,
  type WeaponSetup,
} from "../src/entities/weapons";
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
 * How far off their own reported aim a claimed shot may leave, as a cosine.
 *
 * Generous — about 25 degrees — because it is bounding a lie rather than
 * measuring accuracy: the client's own spread, the recoil that has not been
 * reported yet, and a whole `INPUT_HZ` interval of un-uploaded mouse movement
 * all legitimately live inside it. Tightening it toward the real spread cone
 * would start refusing honest shots from anyone turning quickly.
 */
const SHOT_CONE_COS = Math.cos((25 * Math.PI) / 180);

/**
 * The same bound for a thrown grenade, and wider because the throw itself is
 * not along the aim: `CONFIG.grenade.throwLift` tilts it up before it leaves.
 */
const GRENADE_CONE_COS = Math.cos((50 * Math.PI) / 180);

/** How far a claimed muzzle may be from the shooter's own head, in metres. */
const MAX_ORIGIN_SLIP = 2;

/**
 * How long an empty match keeps its world before throwing it away.
 *
 * Long enough that a player who dropped and reconnected rejoins the round they
 * were in rather than a fresh one; short enough that a public server does not
 * accumulate abandoned scenes.
 */
const IDLE_DISPOSE_MS = 60_000;

/** How long the round-over card stays up before the next map is built. */
const ROUND_OVER_MS = 8_000;

/** Scratch for shot resolution; reused so a firefight allocates nothing. */
const SHOT_ORIGIN = new Vector3();
const SHOT_DIR = new Vector3();

/**
 * Ticks between snapshots. `SNAPSHOT_HZ` divides `TICK_HZ`, so this is exact —
 * see the note on those constants for why a fractional ratio is not allowed.
 */
const TICKS_PER_SNAPSHOT = TICK_HZ / SNAPSHOT_HZ;

/** What an unusable name falls back to, so a slot always has something to say. */
const NAME_FALLBACK = "operative";

/**
 * A display name that can safely go on fifteen other people's screens.
 *
 * BOUNDED rather than validated — anything may be a name, so this strips what
 * is not one: the C0/C1 control characters (which can hide the rest of a string
 * or rewrite a log line) and whitespace runs that make one name read as
 * several. The length cap matters because the name is in every roster
 * broadcast, and a client that could state a kilobyte would be handed sixteen
 * ways to send it.
 *
 * The `typeof` guard is not paranoia: `decode` returns parsed JSON asserted to
 * a `ClientMessage`, so the static type is a claim about a well-behaved client
 * and nothing more. Every other field off that message is range-checked before
 * use for the same reason.
 *
 * It deliberately does NOT escape markup. Escaping belongs to whatever renders
 * the string, and a name stored pre-escaped shows up as `&amp;` the moment it
 * reaches something that escapes properly — every screen in `src/ui/` writes a
 * name with `textContent`, which needs none.
 */
function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return NAME_FALLBACK;
  const clean = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return clean.length > 0 ? clean : NAME_FALLBACK;
}

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

  /**
   * What each seated player is carrying, resolved from the weapon TABLE.
   *
   * The server owns this. A client names a weapon id at join and the id is
   * validated; the damage, range and fall-off are looked up here and never
   * cross the wire, because a client that could state its own damage would
   * state whatever it liked.
   */
  private readonly loadouts = new Map<number, WeaponSetup>();

  /** When each slot last fired, for the rate limit. */
  private readonly lastShot: number[] = [];

  constructor(readonly id: string) {
    // A bot went down, however it was done. The bearing and the size of the
    // killing blow ride along because a client throws its corpse with them —
    // `Bot.takeDamage` captured both before this fired, which is the same pair
    // the offline game hands `RagdollSystem` and the reason it does not need a
    // second copy of any of it.
    this.game.onKillEvent = (bot, killer, headshot) => {
      this.pending.push({
        e: "kill",
        killer,
        victim: this.game.battle.bots.indexOf(bot),
        headshot,
        from: [bot.deathFrom.x, bot.deathFrom.y, bot.deathFrom.z],
        amount: bot.deathDamage,
      });
    };
    this.game.conquest.onCaptured = (point, by) =>
      this.pending.push({ e: "captured", point: point.def.id, by });
    this.game.conquest.onNeutralised = (point) =>
      this.pending.push({ e: "neutralised", point: point.def.id });
    this.game.onPlayerDamaged = (player, amount, from, killed) => {
      this.pending.push({
        e: "damage",
        victim: player.slot,
        amount,
        from: from ? [from.x, from.y, from.z] : [0, 0, 0],
        health: player.health,
      });
      if (killed) {
        // The other half of "one kill event per death". A person goes down
        // through this callback whoever pulled the trigger — a bot's rifle, a
        // blast, another client's round — so it is the only place that sees
        // every one of them, exactly as `onKillEvent` is for a bot.
        //
        // The killer's team is DERIVED and not carried: friendly fire is
        // excluded by construction everywhere in this game (`fire` takes the
        // shooter's own target list), so the side that killed a person is
        // always the other one, and plumbing a killer down through
        // `CombatSystem.takeDamage` to be told what is already known would be
        // the kind of wire field that can disagree with the world.
        //
        // `headshot` is false rather than unknown: the flag is the SHOOTER's
        // feedback and reaches them on their own `hit` event, which is
        // resolved where the head zone was actually tested. Nothing renders it
        // for a victim.
        this.pending.push({
          e: "kill",
          killer: 1 - player.team,
          victim: player.slot,
          headshot: false,
          from: from ? [from.x, from.y, from.z] : [0, 0, 0],
          amount,
        });
        this.pending.push({
          e: "died",
          slot: player.slot,
          by: -1,
          respawnIn: player.respawnT,
        });
      }
    };
    this.game.onExplosion = (at) =>
      this.pending.push({ e: "explode", at: [at.x, at.y, at.z] });
    this.game.onPlayerSpawned = (player, at, yaw) =>
      this.pending.push({
        e: "spawn",
        slot: player.slot,
        pos: [at.x, at.y, at.z],
        yaw,
      });
  }

  hasBotSlot(): boolean {
    return this.roster.hasBotSlot();
  }

  /**
   * This match as the lobby lists it.
   *
   * `state` is read off what is actually running rather than tracked as a
   * field, so it cannot disagree with the loop: the timer exists only while
   * there are peers (`stop` clears it when the last one leaves) and `rotating`
   * spans the gap between a round ending and the next map being built.
   */
  summary(): MatchSummary {
    return {
      id: this.id,
      mapId: this.mapId,
      humans: this.roster.humanCount,
      slots: this.roster.slots.length,
      state: this.rotating ? "rotating" : this.timer ? "live" : "empty",
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
  async admit(socket: WebSocket, rawName: string, weapon?: string): Promise<void> {
    const id = `p${nextPeerId++}`;
    // Cleaned HERE, at the one door into the roster, rather than at the
    // handshake — the same placement as the weapon lookup below, and for the
    // same reason: a second caller of `admit` must not be able to skip it.
    const name = cleanName(rawName);
    const slot = this.roster.claim(id, name);
    if (!slot) {
      socket.send(encode({ t: "rejected", reason: "match full" }));
      socket.close();
      return;
    }

    const peer: Peer = { id, name, socket, slot: slot.index, seq: 0 };
    this.peers.set(id, peer);
    // Somebody came back before the world was thrown away.
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

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
    // A slot changing hands must not inherit the last occupant's travel. The
    // walk cycle is derived from how far a body moved between snapshots, so a
    // stale entry here makes the new arrival's first frame a sprint from
    // wherever the previous player was standing.
    delete this.lastSeen[slot.index];
    // Resolved from the weapon table HERE, not taken from the client. An
    // unknown id, or the sidearm (which the kit screen never offers), falls
    // back to the default rather than being refused — a client on a newer
    // build naming a weapon this server has not heard of should still play.
    this.loadouts.set(
      slot.index,
      weaponSetup(weapon && isPrimaryWeaponId(weapon) ? weapon : DEFAULT_WEAPON),
    );
    // Not spawned here: a fresh player is dead with a zero timer, which is
    // exactly the state the reinforcement pass in `HeadlessGame.step` picks up.
    // Joining and redeploying are the same act and go through the same door.
    void player;

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
    this.loadouts.delete(peer.slot);
    delete this.lastShot[peer.slot];
    delete this.lastSeen[peer.slot];
    const slot = this.roster.release(peer.id);
    if (slot) {
      console.log(`[${this.id}] ${peer.name} left; slot ${slot.index} back to a bot`);
    }
    this.broadcastRoster();
    // Nobody watching: stop burning a core on a fight with no audience. The
    // world stays built for a while, so somebody rejoining resumes the round
    // rather than reloading it — but not forever. An idle match holds a scene,
    // sixteen rigs and a nav graph, and on a public server the matches nobody
    // came back to would accumulate for the life of the process.
    if (this.peers.size === 0) {
      this.stop();
      this.idleTimer = setTimeout(() => this.retire(), IDLE_DISPOSE_MS);
    }
  }

  /** Wired by the registry: this match has gone and should be forgotten. */
  onRetired: () => void = () => {};

  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private retire(): void {
    if (this.peers.size > 0) return;
    this.idleTimer = null;
    this.game.dispose();
    this.onRetired();
    console.log(`[${this.id}] idle; world disposed`);
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

    if (!live && this.game.conquest.winner !== null && !this.rotating) {
      this.pending.push({ e: "roundover", winner: this.game.conquest.winner });
      // The round is over but the match is not. Everyone stays seated, the
      // card goes up on every client, and the next map is built after a pause
      // — a server that stopped here would leave sixteen people looking at a
      // frozen world with no way out but reconnecting.
      this.rotating = true;
      this.broadcastSnapshot();
      setTimeout(() => this.rotate(), ROUND_OVER_MS);
      return;
    }
    if (this.ticks % TICKS_PER_SNAPSHOT === 0) this.broadcastSnapshot();
  }

  private rotating = false;

  /**
   * Next map, same people.
   *
   * The roster is untouched: who is in which slot is a fact about the MATCH,
   * not about the round, so a rotation rebuilds the world and restarts the
   * fight without anybody being re-seated or having to rejoin. Every seated
   * player is dead with a zero timer afterwards, which is exactly the state
   * `HeadlessGame.step` deploys them from.
   */
  private async rotate(): Promise<void> {
    const order = MAPS.map((m) => m.id);
    const next = order[(order.indexOf(this.mapId) + 1) % order.length];
    this.mapId = next;
    const def = MAPS.find((m) => m.id === next) ?? MAPS[0];

    await this.game.startRound(def, 1);
    for (const player of this.game.players.values()) {
      player.retire();
      player.respawnT = 0;
    }
    // Re-bench, because `startRound` reset the whole bot roster and the bots in
    // occupied slots would otherwise walk back into a fight somebody is
    // already standing in.
    for (const slot of this.roster.slots) {
      if (slot.occupant.kind === "human") {
        this.game.battle.setBenched(this.game.battle.bots[slot.index], true);
      }
    }
    this.ticks = 0;
    this.rotating = false;
    this.broadcast({ t: "roundstart", mapId: this.mapId, now: Date.now() });
    this.broadcastRoster();
    console.log(`[${this.id}] rotated to ${this.mapId}`);
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
          // The same tween a bot's body plays, off the same field — see
          // `NetPlayer.deathProgress` for why this is not a bare 1.
          dead: player.deathProgress,
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
        this.onShot(peer, msg);
        break;
      case "grenade":
        this.onGrenade(peer, msg);
        break;
      case "deploy":
        // Not implemented, and deliberately inert rather than half-wired.
        // Reinforcements arrive through `HeadlessGame.step`, which is the one
        // door a person enters the world by; letting a client CHOOSE its spawn
        // means offering it a validated list first, and an unvalidated
        // `spawn` index is a request to be placed anywhere on the map.
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

    // Elapsed CLIENT time since the last sample, clamped. Unclamped, a client
    // that claims a huge gap buys itself a proportionally huge legal step,
    // which is the obvious way to dress a teleport as a lag spike.
    //
    // The first sample has nothing to measure against, so it is assumed to
    // cover one INPUT interval — the cadence a client actually sends at.
    // Assuming a single TICK instead (which this did at first) gives the very
    // first packet a 16 ms budget it has no way of knowing about.
    const raw =
      player.lastTime > 0 ? (msg.time - player.lastTime) / 1000 : 1 / INPUT_HZ;
    const dt = Math.min(Math.max(raw, 1 / TICK_HZ), MAX_MOVE_GAP);

    // The CLOCK advances whether or not the POSITION is accepted, and this is
    // load-bearing. Updating it only on success means one rejected move leaves
    // `lastTime` behind forever: every later sample is then measured against
    // the whole elapsed gap — or, on the very first move, against the
    // first-sample assumption above — and a player whose opening packet was a
    // fraction too long is judged against a 16 ms budget for the rest of the
    // match and can never move again. It presents as movement simply not
    // working, with corrections streaming, and it cost a debugging session.
    // Advancing it here is safe because the gap is clamped anyway.
    player.lastTime = msg.time;

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

  /**
   * A round a client says it fired. The authority decides what it hit.
   *
   * Three gates before the ray is even run, in ascending cost:
   *
   *   1. **Rate.** A client cannot fire faster than its weapon's own
   *      `shotInterval`. Without this, "hold the trigger" is a client-side
   *      opinion and a modified one empties a magazine in a frame.
   *   2. **Direction.** The round must leave within a cone of where the shooter
   *      last said it was looking. This is what stops a claimed shot fired
   *      backwards, through the floor, or at somebody the shooter is not facing.
   *      It does NOT stop an aimbot — nothing can, since an aimbot is just
   *      unusually good input — but it bounds the lie to something a real
   *      player could have aimed at.
   *   3. **Origin.** The round must start near the shooter's own head. A client
   *      that could name any origin could shoot from inside your skull.
   *
   * Only then is the ray re-run, against every target rewound to what the
   * shooter was looking at. The client already flashed a hitmarker; this is
   * where it becomes true or turns out to have been a guess.
   */
  private onShot(peer: Peer, msg: Extract<ClientMessage, { t: "shot" }>): void {
    const player = this.game.players.get(peer.slot);
    if (!player || !player.alive || !this.game.map) return;

    const weapon = this.loadouts.get(peer.slot);
    if (!weapon) return;

    // 1. rate
    const now = Date.now();
    if (now - (this.lastShot[peer.slot] ?? 0) < weapon.shotInterval * 1000 * 0.9) {
      return;
    }
    this.lastShot[peer.slot] = now;

    // 2. direction
    const [dx, dy, dz] = msg.dir;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;
    // The shooter's own reported look vector. Yaw is atan2(x, z) and pitch is
    // negative-for-down, the same convention `CameraSystem` uses.
    const cp = Math.cos(player.pitch);
    const lx = Math.sin(player.yaw) * cp;
    const ly = Math.sin(player.pitch);
    const lz = Math.cos(player.yaw) * cp;
    if (nx * lx + ny * ly + nz * lz < SHOT_CONE_COS) return;

    // 3. origin
    const [ox, oy, oz] = msg.origin;
    if (
      Math.hypot(ox - player.eyePos.x, oy - player.eyePos.y, oz - player.eyePos.z) >
      MAX_ORIGIN_SLIP
    ) {
      return;
    }

    SHOT_ORIGIN.set(ox, oy, oz);
    SHOT_DIR.set(nx, ny, nz);
    const result = this.game.resolveShot(
      player,
      SHOT_ORIGIN,
      SHOT_DIR,
      msg.time,
      weapon,
    );
    if (!result?.target) return;

    const victimSlot = this.slotOf(result.target);
    this.pending.push({
      e: "hit",
      shooter: peer.slot,
      victim: victimSlot,
      killed: result.killed,
      headshot: result.headshot,
    });

    // The `hit` above and NOTHING ELSE. Everything a death owes — the ticket,
    // the `kill` line, the `died` clock — is raised by whichever of the two
    // authority callbacks saw the body go down: `onPlayerDamaged` for a person,
    // `onKillEvent` for a bot, and each of those fires for every death of its
    // kind however it was dealt. Pushing a second `kill` from here would put
    // two lines in the killfeed for one body, and the one this method could
    // build would be the poorer of the two — it does not know where a bot's
    // killing blow came from, which is what the corpse is thrown with.
  }

  /**
   * A grenade a client says it threw.
   *
   * Gated like a shot, minus the rate limit — a player carries
   * `CONFIG.grenade.carried` of them and the pouch is refilled only by death,
   * so the ammunition IS the limit. The pouch is the server's count, not the
   * client's: a client that tracked its own would throw as many as it liked.
   */
  private onGrenade(peer: Peer, msg: Extract<ClientMessage, { t: "grenade" }>): void {
    const player = this.game.players.get(peer.slot);
    if (!player || !player.alive) return;
    if (player.grenades <= 0) return;

    const [dx, dy, dz] = msg.dir;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    const nx = dx / len, ny = dy / len, nz = dz / len;
    const cp = Math.cos(player.pitch);
    const lx = Math.sin(player.yaw) * cp;
    const ly = Math.sin(player.pitch);
    const lz = Math.cos(player.yaw) * cp;
    // A grenade leaves along a lifted version of the aim, so the cone has to be
    // wider than a bullet's — `throwLift` tilts it up before it is thrown.
    if (nx * lx + ny * ly + nz * lz < GRENADE_CONE_COS) return;

    const [ox, oy, oz] = msg.origin;
    if (
      Math.hypot(ox - player.eyePos.x, oy - player.eyePos.y, oz - player.eyePos.z) >
      MAX_ORIGIN_SLIP
    ) {
      return;
    }

    SHOT_ORIGIN.set(ox, oy, oz);
    SHOT_DIR.set(nx, ny, nz);
    // Spent only if the arm accepts it — the pool refuses rather than stealing
    // a live slot, and a refused throw must cost nothing.
    if (this.game.grenades.throwAlong(SHOT_ORIGIN, SHOT_DIR, player.team, false)) {
      player.grenades--;
    }
  }

  /** Which roster slot a hit body belongs to, or -1 if it is not on the roster. */
  private slotOf(target: unknown): number {
    for (const [slot, player] of this.game.players) {
      if (player === target) return slot;
    }
    const i = this.game.battle.bots.indexOf(target as never);
    return i;
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
