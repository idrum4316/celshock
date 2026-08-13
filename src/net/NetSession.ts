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
import { Connection, type ConnectionState } from "./Connection";
import { NetRoster } from "./NetRoster";
import { INPUT_HZ, type ServerEvent, type ServerMessage } from "./protocol";

const UPLOAD_INTERVAL = 1 / INPUT_HZ;

/** What the local player looks like this frame, for the upload. */
export interface LocalState {
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

  /** Wired by Game: the server has placed us. */
  onSpawn: (pos: Vector3, yaw: number) => void = () => {};
  /** Wired by Game: the server rejected our position and this is the truth. */
  onCorrection: (pos: Vector3, reason: string) => void = () => {};
  /** Wired by Game: an event worth showing — a kill, a capture, a round ending. */
  onEvent: (event: ServerEvent) => void = () => {};
  /** Wired by Game: the connection came up or went away. */
  onStateChange: (state: ConnectionState) => void = () => {};

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

  connect(name: string, url?: string): void {
    this.conn.connect(name, url);
  }

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
        this.seated = true;
        break;

      case "roster":
        this.roster.applyRoster(msg.slots, this.slot);
        break;

      case "snap":
        this.roster.applySnapshot(msg, this.points);
        break;

      case "events":
        for (const e of msg.events) {
          // Our own spawn is the one event that moves the local body, so it is
          // routed rather than merely shown.
          if (e.e === "spawn" && e.slot === this.slot) {
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

      case "rejected":
        console.warn(`[net] refused: ${msg.reason}`);
        break;
    }
  }

  dispose(): void {
    this.conn.close();
    this.roster.dispose();
  }
}
