/**
 * net/NetSession.ts — A networked round, from the client's side.
 * Owns: the `Connection`, the `NetRoster`, the movement upload clock, and the
 * translation of server messages into the callbacks `Game` wires. It is the
 * single seam between the game and the wire.
 * Invariants: `Game` talks to this and never to a socket; this talks to the
 * socket and never to a game system it was not handed. It decides nothing about
 * the round — every outcome here arrived from the authority.
 *
 * It exists so that `Game` gains a field and a branch rather than a protocol.
 * The offline path is untouched: with no session, `updateWorld` runs
 * `ConquestSystem` and `BattleSystem` exactly as it always has, and nothing in
 * this file is constructed at all.
 *
 * **Movement is uploaded, not commanded.** The local `Player` simulates itself
 * exactly as it does offline and this reports where it ended up at `INPUT_HZ`.
 * The server validates and, when it refuses, sends a correction — which is the
 * only thing that ever moves the local body from outside. See
 * `docs/multiplayer.md`.
 */
import { Scene, Vector3 } from "@babylonjs/core";
import type { Team } from "../entities/Combatant";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { ControlPoint } from "../systems/ConquestSystem";
import { Connection, type ConnectionState, type JoinOptions } from "./Connection";
import { NetRoster } from "./NetRoster";
import {
  INPUT_HZ,
  type ServerEvent,
  type ServerMessage,
  type SlotState,
} from "./protocol";

const UPLOAD_INTERVAL = 1 / INPUT_HZ;

/** What the local player looks like this frame, for the upload. */
export interface LocalState {
  /**
   * FEET — `Player.position`, never the collider capsule's centre. Every
   * consumer downstream (the validator, the rewind, the other clients' bodies)
   * builds upward from this `y` and takes it as the ground the player stands
   * on. See `Player.position` for what a half-body of error does to all three.
   */
  position: Vector3;
  yaw: number;
  pitch: number;
  crouching: boolean;
  sprinting: boolean;
}

export class NetSession {
  readonly conn = new Connection();
  readonly roster: NetRoster;

  /** The roster slot this client owns, or -1 before the welcome lands. */
  slot = -1;
  team: Team = 0;
  mapId = "";

  /** True once the welcome has arrived and the round is ours to play. */
  seated = false;

  /**
   * Who is in each slot, as the last roster message said.
   *
   * Kept here rather than in `NetRoster` because it is not about drawing
   * anybody: that class deliberately reads a roster only to find out which body
   * to stop rendering, and everything else about an occupant is invisible to
   * it — a bot and a person are the same object on screen and must stay that
   * way. The one screen that does need to tell them apart is the scoreboard,
   * which is naming rows rather than drawing bodies, and this is what it reads.
   */
  slots: readonly SlotState[] = [];

  /**
   * The round's board, indexed by slot, as the authority last stated it.
   *
   * Mirrored rather than counted, exactly like `tickets`. A client sees only
   * the kill events it was connected for — and `kill` names a killer's team
   * rather than the body — so anything added up here would be a different board
   * on every screen and would start a joiner's round at zero-all. Both arrays
   * are empty until the first `scores` message, which the server sends on
   * arrival and then only when the table moves; a row that has not arrived
   * reads as 0.
   */
  readonly slotKills: number[] = [];
  readonly slotDeaths: number[] = [];

  /** Wired by Game: the server has placed us. */
  onSpawn: (pos: Vector3, yaw: number) => void = () => {};
  /** Wired by Game: the server rejected our position and this is the truth. */
  onCorrection: (pos: Vector3, reason: string) => void = () => {};
  /** Wired by Game: an event worth showing — a kill, a capture, a round ending. */
  onEvent: (event: ServerEvent) => void = () => {};
  /** Wired by Game: the connection came up or went away. */
  onStateChange: (state: ConnectionState) => void = () => {};
  /** Wired by Game: the server refused the handshake, and this is why. */
  onRejected: (reason: string) => void = () => {};
  /** Wired by Game: a new round has begun on this map. */
  onRoundStart: (mapId: string) => void = () => {};

  /**
   * Wired by Game: the welcome landed, and this is the side we are on.
   *
   * The one thing in the welcome the client cannot work out for itself.
   * `Roster.claim` seats the second human on team 1, so a client that assumes
   * team 0 reads every mine/theirs question in the game backwards — its flags,
   * its ticket strip, its minimap and the colours its own corpse falls in.
   *
   * It is RAISED and not merely stored because the welcome can arrive on
   * either side of the local map build: `joinMatch` books the round before the
   * socket is open. `Game.buildRound` reads `team` off this class when the
   * welcome was early; this is how it hears about it when it was late.
   */
  onSeated: (team: Team) => void = () => {};

  /**
   * The live control points, kept as a field because a snapshot arrives on a
   * socket callback rather than on a frame — there is no call stack to thread
   * them down. `update` refreshes the reference every frame.
   */
  private points: ControlPoint[] = [];

  private uploadT = 0;
  private seq = 0;
  private readonly scratch = new Vector3();

  constructor(scene: Scene, mats: CelMaterialFactory) {
    this.roster = new NetRoster(scene, mats);
    this.conn.onStateChange = (s) => this.onStateChange(s);
    this.conn.onMessage = (msg) => this.receive(msg);
  }

  /**
   * Everything in `opts` is passed straight through and not kept here:
   * `Connection` holds it so a RECONNECT re-sends the same loadout and asks for
   * the same match, and a second copy in this class would be one that could
   * disagree with what is actually on the wire.
   */
  connect(opts: JoinOptions): void {
    this.conn.connect(opts);
  }

  /** Which match we are in, once the server has said. Empty before that. */
  matchId = "";

  /**
   * One frame of a networked round: draw everybody else, then report ourselves.
   *
   * `points` are the client's own `ControlPoint` objects, mutated in place —
   * `CaptureZoneSystem`, `HUD` and `Minimap` all hold references to them, so
   * they are updated rather than replaced.
   */
  update(
    dt: number,
    local: LocalState,
    points: ControlPoint[],
    cameraPos: Vector3,
    alive: boolean,
  ): void {
    this.points = points;
    this.roster.update(this.conn.renderTime(), cameraPos);

    if (!this.seated || !alive) return;
    this.uploadT += dt;
    if (this.uploadT < UPLOAD_INTERVAL) return;
    this.uploadT = 0;
    this.conn.send({
      t: "move",
      seq: ++this.seq,
      // The CLIENT clock, deliberately. The server measures the gap between two
      // of our samples to decide what step was possible, and both readings have
      // to come off the same clock for that difference to mean anything.
      time: Date.now(),
      pos: [local.position.x, local.position.y, local.position.z],
      yaw: local.yaw,
      pitch: local.pitch,
      crouching: local.crouching,
      sprinting: local.sprinting,
    });
  }

  /**
   * Reports a round this client just fired.
   *
   * `dir` must be the direction the bullet ACTUALLY flew — spread already
   * applied — because the server fires with zero spread along it. Sending the
   * clean aim instead would resolve a different bullet from the one the player
   * watched leave the barrel.
   *
   * `renderTime` is what the shooter was looking at, not now: other bodies are
   * drawn `interpDelay` in the past, so that is the instant the server has to
   * rewind them to for the crosshair to have meant anything.
   */
  sendShot(origin: Vector3, dir: Vector3, weaponSlot: number): void {
    if (!this.seated) return;
    this.conn.send({
      t: "shot",
      seq: ++this.seq,
      time: this.conn.renderTime(),
      origin: [origin.x, origin.y, origin.z],
      dir: [dir.x, dir.y, dir.z],
      slot: weaponSlot,
    });
  }

  /**
   * Asks to be deployed at one of the map's spawns.
   *
   * `spawn` is an index into `GameMap.spawns` — see `DeployMessage` for why it
   * is that and not an index into the list the screen is showing. This is an
   * ASK and the only one in the protocol that moves the local body: the server
   * decides whether the position is still one this team may use, when the
   * reinforcement clock allows it, and answers with a `spawn` event. Nothing
   * here puts the player in the world.
   *
   * The request STANDS until the authority answers it with a spawn, and that is
   * what makes it survive a socket. `joinMatch` books the local round before
   * the socket is open, so the deploy screen can be up and confirmable before
   * the welcome lands; and a reconnect re-seats this client into a fresh body
   * that is dead until it asks. In both cases the player has already pressed
   * the button, and a request dropped on the floor leaves them looking at a
   * screen that answered once and then wanted pressing again for no reason they
   * could see.
   */
  sendDeploy(spawn: number): void {
    this.pendingDeploy = spawn;
    this.flushDeploy();
  }

  /**
   * The deploy request the authority has not answered yet, or null.
   *
   * Cleared by the `spawn` event rather than by the send, which is what makes
   * it a standing request rather than a fire-and-forget: an unanswered one is
   * re-sent on the next welcome.
   */
  private pendingDeploy: number | null = null;

  private flushDeploy(): void {
    if (!this.seated || this.pendingDeploy === null) return;
    this.conn.send({ t: "deploy", spawn: this.pendingDeploy });
  }

  /**
   * Reports a grenade this client just threw.
   *
   * `dir` is the aim, not the launch vector: `GrenadeSystem.throwAlong` applies
   * `CONFIG.grenade.throwLift` itself, so both sides tilt the same aim by the
   * same amount and get the same arc. Sending the already-lifted vector would
   * have the server lift it twice.
   */
  sendGrenade(origin: Vector3, dir: Vector3): void {
    if (!this.seated) return;
    this.conn.send({
      t: "grenade",
      seq: ++this.seq,
      time: this.conn.renderTime(),
      origin: [origin.x, origin.y, origin.z],
      dir: [dir.x, dir.y, dir.z],
    });
  }

  /** Mirrored ticket counts, for the HUD. */
  get tickets(): readonly [number, number] {
    return this.roster.tickets;
  }

  private receive(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.slot = msg.slot;
        this.team = msg.team;
        this.mapId = msg.mapId;
        this.matchId = msg.matchId;
        this.seated = true;
        // Interpreting the welcome is this class's job, not `Connection`'s —
        // so the match we actually landed in is handed back down for the
        // reconnect to aim at. See `Connection.pinMatch` for why a retry that
        // re-sent the ORIGINAL join would be a bug.
        this.conn.pinMatch(msg.matchId);
        // A deploy confirmed before the welcome arrived. Sent now rather than
        // forgotten — the player has already asked, and the seat is what they
        // were waiting on.
        this.flushDeploy();
        // Last, so that whatever `Game` does with the team is done against a
        // session that is already fully seated. A reconnect comes through here
        // a second time and can land in a slot on the OTHER team, which is why
        // this is an edge rather than a one-shot.
        this.onSeated(msg.team);
        break;

      // A new round on a new map, same seat. Only the map changes here; the
      // slot and team deliberately do not, because a rotation does not re-seat
      // anybody.
      case "roundstart":
        this.mapId = msg.mapId;
        // Last round's board is not this round's. The server clears and
        // re-sends its own within a snapshot of this message; clearing here is
        // what keeps the fraction of a second in between from showing a
        // finished round's kills against a map that has just been built.
        this.slotKills.length = 0;
        this.slotDeaths.length = 0;
        this.onRoundStart(msg.mapId);
        break;

      case "roster":
        this.slots = msg.slots;
        this.roster.applyRoster(msg.slots, this.slot);
        break;

      // The board, whole. Copied INTO the arrays rather than replacing them,
      // because they are `readonly` fields other code holds a reference to —
      // the same reason `tickets` is written element-wise next door.
      case "scores":
        this.slotKills.length = 0;
        this.slotDeaths.length = 0;
        this.slotKills.push(...msg.kills);
        this.slotDeaths.push(...msg.deaths);
        break;

      case "snap":
        this.roster.applySnapshot(msg, this.points);
        break;

      case "events":
        for (const e of msg.events) {
          // Our own spawn is the one event that moves the local body, so it is
          // routed rather than merely shown.
          if (e.e === "spawn" && e.slot === this.slot) {
            // The answer to whatever we asked for, so there is nothing left
            // standing. Cleared before the callback, which is the one that
            // hides the screen that made the request.
            this.pendingDeploy = null;
            this.scratch.set(e.pos[0], e.pos[1], e.pos[2]);
            this.onSpawn(this.scratch, e.yaw);
          }
          this.onEvent(e);
        }
        break;

      case "correct":
        this.scratch.set(msg.pos[0], msg.pos[1], msg.pos[2]);
        this.onCorrection(this.scratch, msg.reason);
        break;

      // The handshake was refused — a full match, a match that has retired, or
      // a protocol the server does not speak. It carries a reason precisely so
      // it can be shown, and a lobby that sent the player here is the thing
      // best placed to show it.
      case "rejected":
        console.warn(`[net] refused: ${msg.reason}`);
        this.onRejected(msg.reason);
        break;
    }
  }

  dispose(): void {
    this.conn.close();
    this.roster.dispose();
  }
}
