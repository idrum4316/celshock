/**
 * net/protocol.ts — The wire format, and the ONLY module both the client and
 * the multiplayer server import.
 * Owns: every message shape, the tick/rate constants both sides must agree on,
 * and the slot/entity vocabulary. Pure types and plain constants — no Babylon,
 * no DOM, no `CONFIG`, nothing with a side effect. It is imported by a Node
 * process and by a browser, so anything that cannot run in both does not
 * belong here.
 * Invariants: the server is the authority for everything in a `Snapshot`; a
 * client may only ever ASK (`ClientMessage`), never assert. A client's claimed
 * hit is a hint the server re-resolves, never a fact — see `docs/multiplayer.md`.
 * Vectors cross the wire as plain `[x, y, z]` tuples rather than `Vector3`,
 * because `Vector3` is a Babylon class with private `_x` fields that neither
 * `JSON.stringify` nor a `DataView` encoder has any business knowing about.
 *
 * Encoding is JSON today. Every message is a flat object with short, fixed
 * fields precisely so that swapping in a binary encoder later is a change to
 * `encode`/`decode` and to nothing that calls them.
 */

/** Protocol version. Bumped on any incompatible change; a mismatch is refused. */
export const PROTOCOL_VERSION = 1;

/**
 * How often the server steps the simulation.
 *
 * 60 rather than 30 because every round in this game is hitscan and the
 * authority re-resolves each one against rewound positions: the rewind can only
 * be as fine as the history, and 16 ms of granularity is half of 33 ms of
 * error on a strafing target. It is affordable — `npm run simulate` runs a
 * sixteen-bot round at roughly a thousand ticks a second on one core, so a live
 * match at 60 Hz costs a few percent of it.
 */
export const TICK_HZ = 60;

/**
 * How often the server broadcasts a snapshot. Must DIVIDE `TICK_HZ` — a
 * fractional ratio makes the broadcast alternate between two tick spacings, and
 * a client interpolating on the assumption of an even cadence renders that as a
 * limp.
 */
export const SNAPSHOT_HZ = 20;

/** How often a client uploads its own movement. */
export const INPUT_HZ = 20;

/**
 * How far behind the newest snapshot a client renders other entities.
 *
 * Two snapshots' worth plus a margin: interpolation needs a sample on each side
 * of the render time, so anything less than one interval guarantees
 * extrapolation on a perfect connection, and the margin absorbs jitter. This is
 * also the window the server rewinds through for hit validation, which is why
 * the two live in one constant rather than being tuned apart and drifting.
 */
export const INTERP_DELAY_MS = 100;

/** How much position history the server keeps per combatant, for rewind. */
export const REWIND_WINDOW_MS = 400;

/** A world position or direction on the wire. */
export type Vec3 = [x: number, y: number, z: number];

/** 0 = Wardens, 1 = The Blight — the same indices `CONFIG.teams` uses. */
export type NetTeam = 0 | 1;

// --- roster ---------------------------------------------------------------

/**
 * Who is in a roster slot.
 *
 * The roster is a fixed 16 slots and a slot is never created or destroyed — it
 * only changes who feeds it. That is what makes "start without a full lobby"
 * and "backfill a leaver with a bot" the same mechanism rather than two.
 */
export type SlotOccupant =
  | { kind: "bot" }
  | { kind: "human"; peerId: string; name: string };

export interface SlotState {
  /** Stable index into the roster, 0..15. Also the entity id on the wire. */
  index: number;
  team: NetTeam;
  occupant: SlotOccupant;
}

// --- snapshots ------------------------------------------------------------

/**
 * One combatant as the client needs to draw it.
 *
 * Deliberately identical for a bot and a remote human: the client pools one
 * `NetSoldier` per slot and never learns which it is drawing. Everything that
 * differs between them is the server's problem.
 */
export interface EntityState {
  /** Roster slot index. */
  i: number;
  /** Feet. */
  p: Vec3;
  /** Where it looks, radians. */
  yaw: number;
  /** Where its feet point, radians — see `Bot`'s yaw/bodyYaw split. */
  bodyYaw: number;
  /** Torso pitch, radians. */
  pitch: number;
  /**
   * 0..1, how much of a walk cycle to play.
   *
   * The WEIGHT, not the phase. A client advances its own stride from this, so
   * the free-running cycle costs no bandwidth and cannot judder when a packet
   * is late — the leg is somewhere sensible either way.
   */
  moving: number;
  alive: boolean;
  /** Collapse tween progress, 0 while alive. */
  dead: number;
  /** Set on the tick it fired, for the muzzle flash and the tracer. */
  fired?: boolean;
}

/** A control point, mirrored onto the client's `ConquestSystem`. */
export interface PointState {
  id: string;
  owner: NetTeam | null;
  meter: number;
  contested: boolean;
}

export interface Snapshot {
  t: "snap";
  /** Server tick this was taken on. */
  tick: number;
  /** Server clock in ms, for the client's offset estimate. */
  now: number;
  entities: EntityState[];
  points: PointState[];
  tickets: [number, number];
}

// --- events ---------------------------------------------------------------

/**
 * Things that happen at an instant rather than being a state.
 *
 * Separate from the snapshot because a snapshot is lossy by design — a client
 * that misses one interpolates past it and loses nothing, whereas a missed kill
 * is a killfeed line that never appears. Events are queued per client and
 * cleared on acknowledgement.
 */
export type ServerEvent =
  | { e: "kill"; killer: number; victim: number; headshot: boolean }
  | { e: "damage"; victim: number; amount: number; from: Vec3; health: number }
  | { e: "hit"; shooter: number; victim: number; killed: boolean; headshot: boolean }
  | { e: "died"; slot: number; by: number; respawnIn: number }
  | { e: "explode"; at: Vec3 }
  | { e: "captured"; point: string; by: NetTeam }
  | { e: "neutralised"; point: string }
  | { e: "spawn"; slot: number; pos: Vec3; yaw: number }
  | { e: "roundover"; winner: NetTeam };

// --- server -> client -----------------------------------------------------

export interface Welcome {
  t: "welcome";
  version: number;
  matchId: string;
  /** The slot this client owns. */
  slot: number;
  team: NetTeam;
  mapId: string;
  now: number;
}

export interface RosterMessage {
  t: "roster";
  slots: SlotState[];
}

/**
 * A new round has started on this map, with the same people in the same slots.
 *
 * Distinct from `welcome` on purpose. An earlier draft broadcast a `welcome`
 * with `slot: -1` to announce a rotation, which every client would have taken
 * literally — `NetSession` assigns its own slot straight out of that field, so
 * one message meant to say "new map" would have told sixteen clients they no
 * longer had a body.
 */
export interface RoundStart {
  t: "roundstart";
  mapId: string;
  now: number;
}

/**
 * The server moving a client that reported an impossible position.
 *
 * Not a general correction channel: movement is client-simulated and trusted
 * within tolerance, so this fires only when the validator has actually rejected
 * something. A client that receives one has been snapped.
 */
export interface Correction {
  t: "correct";
  pos: Vec3;
  /** The last input sequence the server accepted before rejecting. */
  seq: number;
  reason: "speed" | "ground" | "solid";
}

export interface EventsMessage {
  t: "events";
  events: ServerEvent[];
}

export interface Rejected {
  t: "rejected";
  reason: string;
}

export type ServerMessage =
  | Welcome
  | RoundStart
  | RosterMessage
  | Snapshot
  | EventsMessage
  | Correction
  | Rejected;

// --- client -> server -----------------------------------------------------

export interface Join {
  t: "join";
  version: number;
  name: string;
  /**
   * The primary weapon this client wants to carry.
   *
   * The SERVER resolves this to damage and range, and validates it against the
   * real weapon table before it does — a client that names an unknown weapon,
   * or the sidearm, gets the default. Damage numbers must never travel on the
   * wire: a client that could state its own would state whatever it liked.
   */
  weapon?: string;
}

/**
 * One movement sample. Sent at `INPUT_HZ`, validated on arrival.
 *
 * The client simulates its own `Player` exactly as it does offline and reports
 * where it ended up; the server checks the step is physically possible and
 * keeps it, or rejects and corrects. There is no input replay here — see
 * `docs/multiplayer.md` for why that trade was taken.
 */
export interface MoveMessage {
  t: "move";
  /** Monotonic per client, so a correction can name what it rejected. */
  seq: number;
  /** Client clock in ms when this was sampled. */
  time: number;
  pos: Vec3;
  yaw: number;
  pitch: number;
  crouching: boolean;
  sprinting: boolean;
}

/**
 * A round the client believes it fired.
 *
 * `time` is the client's RENDER time — what it was actually looking at, which
 * is `INTERP_DELAY_MS` behind the newest snapshot it holds. The server rewinds
 * every target to that instant before re-running the ray, so a shot at a
 * moving enemy lands where the shooter saw them and not where they now are.
 *
 * There is deliberately no victim field. An earlier draft had one and the
 * server checked it for plausibility; naming the victim at all invites
 * validating the claim instead of re-deriving the answer, and re-deriving it is
 * the entire security property.
 */
export interface ShotMessage {
  t: "shot";
  seq: number;
  /** Client render time in ms — what the shooter was looking at. */
  time: number;
  origin: Vec3;
  /**
   * The direction the round ACTUALLY flew, spread already applied.
   *
   * Not the clean aim: `CombatSystem.fire` jitters internally, and the server
   * cannot reproduce the client's roll of that dice — so it fires with a spread
   * of zero along this vector instead, and both sides resolve the same bullet.
   * The trust that buys is bounded by a cone check against the shooter's last
   * reported view angles, which is what stops a client claiming a round fired
   * backwards or through its own feet.
   */
  dir: Vec3;
  /** Which of the two carried weapons, so the server reads the right damage. */
  slot: number;
}

export interface GrenadeMessage {
  t: "grenade";
  seq: number;
  time: number;
  origin: Vec3;
  dir: Vec3;
}

export interface DeployMessage {
  t: "deploy";
  /** Index into the spawn options the server offered. */
  spawn: number;
}

export type ClientMessage =
  | Join
  | MoveMessage
  | ShotMessage
  | GrenadeMessage
  | DeployMessage;

// --- encoding -------------------------------------------------------------

/**
 * The one place a message becomes bytes.
 *
 * JSON for now. At sixteen entities and `SNAPSHOT_HZ` that is roughly 40 KB/s
 * per client, which is affordable and legible in a devtools frame inspector —
 * worth a great deal while the protocol is still moving. Both functions are
 * deliberately the only encoding site so the swap to a `DataView` is local.
 */
export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

/** Returns null on anything that is not a well-formed message. */
export function decode(raw: string): ServerMessage | ClientMessage | null {
  try {
    const msg = JSON.parse(raw);
    return typeof msg === "object" && msg !== null && typeof msg.t === "string"
      ? msg
      : null;
  } catch {
    return null;
  }
}
