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

/**
 * Protocol version. Bumped on any incompatible change; a mismatch is refused.
 *
 * 3 is spawn selection. It is a version bump rather than a silent addition
 * because the change is to who ACTS FIRST: a version-3 server deploys a person
 * only once they have asked, so a version-2 client — which never sends
 * `deploy` — would sit dead in a live match forever, alive on its own screen
 * and absent from everyone else's. Refusing it at the handshake turns that into
 * a sentence the lobby can print.
 */
export const PROTOCOL_VERSION = 3;

/**
 * The longest display name a client may claim, in characters.
 *
 * Here rather than in `CONFIG` because both ends need it: the server TRUNCATES
 * to it (a bound the client cannot talk its way past) and the lobby's name
 * field stops there, so what a player types is what they get rather than
 * something silently shortened on arrival.
 */
export const MAX_NAME_LENGTH = 20;

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

// --- lobby ----------------------------------------------------------------

/**
 * One match as the lobby lists it.
 *
 * The only shape here that does NOT travel over the WebSocket — it is the body
 * of `GET /matches`, fetched before there is a socket at all. It lives in this
 * module anyway, because the rule is that a shape both ends must agree on is
 * declared once, and "the server writes it, the client parses it" is exactly
 * that. A client picks a row and sends its `id` back as `Join.matchId`.
 *
 * `slots` is on the wire rather than assumed to be sixteen: a client drawing
 * "3 / 16" from its own `CONFIG.bots.perTeam` would draw the wrong denominator
 * against a server built with a different one, and the row would be a lie in
 * the one place a player is choosing between servers.
 */
export interface MatchSummary {
  id: string;
  /** Which map is standing, so a lobby row can name it. */
  mapId: string;
  humans: number;
  slots: number;
  /**
   * `empty` — built, nobody in it, the world may already be disposed.
   * `live` — a round is being simulated.
   * `rotating` — the round ended and the next map is being built.
   */
  state: "empty" | "live" | "rotating";
}

/**
 * The body of `GET /matches`.
 *
 * It carries the server's protocol version even though every row is otherwise
 * about matches, because this is the FIRST thing a client asks and therefore
 * the cheapest place to discover a version mismatch. Learning it here means the
 * lobby can say "this server is running a newer build, reload" instead of
 * offering rows that all fail at the socket with a message nobody sees.
 */
export interface MatchList {
  protocol: number;
  /** True when the server will not create any more matches. */
  full: boolean;
  matches: MatchSummary[];
}

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

/**
 * One grenade in the air, as the client needs to draw it.
 *
 * **State and not an event**, which is the whole of the design here. A throw
 * announced once and simulated on each client would be sixteen ballistic
 * solves off one message — and they would not agree: the flight is integrated
 * per frame against a frame time nobody shares, and a bounce multiplies the
 * disagreement rather than damping it. The grenade would come to rest at your
 * feet on your screen and go off three metres away, because the blast is the
 * authority's and always has been. So the position is sent at the snapshot
 * cadence like everything else that moves, and interpolated behind the same
 * clock — see `net/NetGrenades`.
 *
 * Additive, like `fire` and `scores`: an older client ignores the field and
 * sees exactly what it saw before it existed, a newer client against an older
 * server draws nothing, and neither is a protocol break — hence no version
 * bump.
 */
export interface GrenadeState {
  /**
   * Names the FLIGHT, not a pool slot: monotonic on the server and never
   * reused, so a client can key a sample buffer on it. See `Grenade.id` in
   * `GrenadeSystem` for what reuse would draw.
   */
  i: number;
  p: Vec3;
  /**
   * The thrower's roster slot, or -1 for one nobody on the roster threw.
   *
   * On the wire so that the one client who must NOT draw this can tell: the
   * thrower has watched their own copy leave their own hand since the frame
   * they threw it, a round trip before this arrived, and drawing the
   * authority's as well would put two grenades in the air for one throw.
   */
  by: number;
  /**
   * Seconds of fuse left, so the pip blinks in step with the thrower's own —
   * see `pipLit`. It falls linearly, which is what makes lerping it between
   * two samples exact rather than merely close.
   */
  fuse: number;
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
  /**
   * Grenades in the air, and ABSENT when there are none — which is most ticks.
   * A snapshot goes out twenty times a second and a grenade is a rare thing,
   * so the empty array is worth not sending; a client reads the missing field
   * as "nothing is flying", which is also what an older server means by it.
   */
  grenades?: GrenadeState[];
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
  /**
   * A body went down, whoever it belonged to and whoever put it there.
   *
   * `from` and `amount` are the killing blow's origin and size — the same pair
   * `damage` carries, and for the same reason on the far side: they are what a
   * client throws the corpse with. Without them every death would be a body
   * lifted straight up, because a zero-length direction is all
   * `RagdollSystem.applyImpulse` would have to work from. They are on the KILL
   * rather than on the snapshot because a death is an instant and a snapshot is
   * a state — sending a bearing every tick for the one tick it matters is the
   * trade this event type exists to avoid.
   *
   * Raised exactly once per death, for a bot and a person alike. `Match` is
   * where the two paths converge and where that "exactly once" is argued.
   */
  | {
      e: "kill";
      killer: number;
      victim: number;
      headshot: boolean;
      from: Vec3;
      amount: number;
    }
  /**
   * A blow one player took: how big, which way it came from, and what it left
   * them on.
   *
   * **Addressed to the victim.** It is the only message in the protocol that
   * carries a health at all — see `docs/multiplayer.md` on why one is enough —
   * so broadcasting it published every player's exact pool to every client,
   * live, with the bearing they were shot from beside it. `victim` stays on the
   * wire and the client still checks it, for the reason `hit` below does.
   */
  | { e: "damage"; victim: number; amount: number; from: Vec3; health: number }
  /**
   * A round the authority agrees landed — the shooter's own hitmarker, arriving
   * a round trip after the prediction it either claims or corrects.
   *
   * **Addressed to the shooter.** Everything not marked that way here is public
   * by nature: a client needs the kills, the captures and the blasts to draw the
   * same round as everyone else. This one is feedback about one person's
   * trigger, and broadcasting it handed every client a live feed of who was
   * hitting whom — including `killed`, which says a body is going down a tick
   * before the snapshot shows it. `Match` sends it to one peer; the client still
   * checks `shooter`, because the two halves deploy separately and an older
   * server broadcasts it with this same shape.
   */
  | { e: "hit"; shooter: number; victim: number; killed: boolean; headshot: boolean }
  | { e: "died"; slot: number; by: number; respawnIn: number }
  /**
   * A weapon went off in this slot. Public, and the only thing on the wire that
   * says a shot was fired at all.
   *
   * It carries a slot and nothing else, because where that body is has already
   * arrived in the snapshot every client holds — a position here would be a
   * second copy of one, on a different clock, that could only disagree with the
   * one being drawn. What the client does with it is the minimap reveal, the
   * offline rule that gunfire gives an enemy away; a client cannot reach that
   * rule on its own, because the trigger was pulled by an AI it does not run
   * or by a person it never hears from.
   *
   * **At most once per slot per snapshot, not once per round.** A reveal is a
   * timer being refreshed rather than a count, so a second event inside the
   * same 50 ms says nothing the first did not — and sixteen automatic weapons
   * at 600 rpm would put ten times the traffic on the wire to say it. `Match`
   * coalesces; a client may still receive several in a row for one slot after a
   * dropped frame and must treat each as "still firing".
   *
   * Additive: a client that has never heard of it ignores it, and a new client
   * against an older server simply gets no reveals, so this arrived without a
   * `PROTOCOL_VERSION` bump.
   */
  | { e: "fire"; slot: number }
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

/**
 * The round's scoreboard: kills and deaths for every slot, in slot order.
 *
 * **State, not events, and that is the whole design.** A client could add up
 * the `kill` events instead, and it would be wrong within a minute — events are
 * a queue a reconnect drops, a spectator joining mid-round has missed every one
 * of them, and `kill` names the killer's TEAM rather than the body that did it,
 * because the killfeed only ever needed a side. Sending the table means a
 * missed message is corrected by the next one and a joiner is right on arrival.
 *
 * **Sent only when it changes**, which is a few times a minute rather than
 * twenty times a second: `Match` compares `HeadlessGame.scoreVersion` against
 * what it last sent, on the same tick the snapshot goes out. Thirty-two numbers
 * on a snapshot that carries none of them is the trade the `fire` event makes
 * next door — the wire says a thing once rather than repeating it at the
 * simulation's cadence.
 *
 * Both arrays are indexed by slot and always the full roster's length, so a
 * client indexes them with the same number it indexes everything else with.
 * Deaths are counted at the victim's door and kills at the killer's, once each
 * — see `HeadlessGame.creditKill`.
 *
 * Additive, like `fire`: an older client ignores a message type it has no case
 * for, and a newer client against an older server simply shows a board of
 * zeros. Neither is a protocol break, so this arrived without a version bump.
 */
export interface ScoresMessage {
  t: "scores";
  kills: number[];
  deaths: number[];
}

export type ServerMessage =
  | Welcome
  | RoundStart
  | RosterMessage
  | Snapshot
  | EventsMessage
  | ScoresMessage
  | Correction
  | Rejected;

// --- client -> server -----------------------------------------------------

export interface Join {
  t: "join";
  version: number;
  /**
   * What to call this player.
   *
   * Truncated and stripped on arrival, never trusted as sent — it is the one
   * client-supplied string that other people's screens render, so it is bounded
   * on the authority's side for the same reason the weapon id below is resolved
   * there. See `MAX_NAME_LENGTH`.
   */
  name: string;
  /**
   * Which match to join, from a `MatchSummary.id` the lobby listed.
   *
   * Absent means "put me wherever there is room", which is what `?mp` on the
   * URL does and what a client with no lobby has always done. Naming a match
   * that has since filled or been disposed is REFUSED rather than redirected:
   * a player who picked a specific row and silently landed somewhere else has
   * been lied to, and the lobby can simply refresh and show why.
   */
  matchId?: string;
  /**
   * Start a NEW match rather than filling one that has room.
   *
   * Only consulted when `matchId` is absent — naming a match and asking for a
   * fresh one are contradictory, and the named one wins because it is the more
   * specific request. Bounded by the server's match cap, so this is a request
   * and not an instruction.
   *
   * It exists because "there is room somewhere" and "I want to play there" are
   * different questions. A lobby showing a half-full round on a map you do not
   * want needs a way past it that is not waiting for sixteen strangers.
   */
  create?: boolean;
  /**
   * The map a NEW match should be started on.
   *
   * A request and only that. It is consulted when this join CREATES a match and
   * ignored entirely when it lands in one that already exists — a match's map is
   * a fact about the match, and sixteen people are already standing in it. So a
   * client sends its preference on every join and the server spends it or drops
   * it; what a client must never do is take its own answer, which is the bug
   * this field was added to fix (a lobby join built whatever the menu had
   * selected while the authority ran something else).
   *
   * Resolved against the server's own `MAPS` table exactly as the weapon id is,
   * and an id it has never heard of falls back to the default rather than being
   * refused. Additive: a server that has never heard of the field creates on its
   * default map, which is what every client got before this existed.
   */
  map?: string;
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

/**
 * Where this client would like to come back in.
 *
 * Sent when the player confirms a spawn on the deploy screen, and it is the
 * only thing that puts a person into the world: the authority holds a dead
 * player at the end of their reinforcement wait until one of these arrives.
 *
 * `spawn` is an index into the MAP's own spawn table — `GameMap.spawns`, the
 * layout module both sides build from — and never into the list the deploy
 * screen happens to be showing. That list is derived from flag ownership and
 * changes as the round does, so an index into it means one thing on the client
 * and another on the server the moment a flag falls between the two. An index
 * into the layout is a name that cannot drift, and the server still validates
 * it against what it would offer that team RIGHT NOW — a spawn behind a flag
 * this player's side no longer holds is refused and the authority picks
 * instead, exactly as it does for a bot.
 */
export interface DeployMessage {
  t: "deploy";
  /** Index into `GameMap.spawns` — see above; not an index into the offer. */
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
