/**
 * server/NetPlayer.ts — A connected human, as the simulation sees one.
 * Owns: the authoritative position, stance, health and team of one player, and
 * the position history the hit rewind reads.
 * Invariants: this is the ONLY record of where a player is that anything on the
 * server trusts. A client reports a position; `validate` decides whether this
 * object accepts it. Nothing here reads a client message directly.
 *
 * It is a `Combatant`, so `BattleSystem.acquire`, `hittablesAgainst` and
 * `ConquestSystem`'s occupancy count take it exactly as they take a `Bot` — a
 * bot cannot tell a person from another bot, and does not need to.
 *
 * There is no movement simulation here and that is the design, not an omission:
 * clients simulate their own `Player` and report the result, and the server's
 * job is to reject what is impossible rather than to recompute what is
 * ordinary. See `docs/multiplayer.md` for the trade that was taken and why
 * input replay was not.
 */
import { Vector3 } from "@babylonjs/core";
import { CONFIG } from "../src/config";
import type { Combatant, Team } from "../src/entities/Combatant";
import { REWIND_WINDOW_MS, TICK_HZ } from "../src/net/protocol";

/** One remembered position, for rewinding a shot to what the shooter saw. */
interface Trace {
  t: number;
  x: number;
  y: number;
  z: number;
  eyeY: number;
  centerY: number;
}

/** Enough history to cover the rewind window at the tick rate, plus slack. */
const TRACE_LEN = Math.ceil((REWIND_WINDOW_MS / 1000) * TICK_HZ) + 4;

export class NetPlayer implements Combatant {
  readonly position = new Vector3();
  readonly eyePos = new Vector3();
  readonly center = new Vector3();
  hitRadius = CONFIG.player.hitRadius;
  alive = false;
  health: number = CONFIG.player.maxHealth;

  yaw = 0;
  pitch = 0;
  crouching = false;
  sprinting = false;

  /** Highest input sequence accepted. A correction names this. */
  seq = 0;
  /** Client clock reading of the last accepted sample, for rate limiting. */
  lastTime = 0;

  /** Seconds until this player may deploy again. */
  respawnT = 0;

  /** Ring of past positions, oldest first. Read by the hit rewind in phase 5. */
  private readonly traces: Trace[] = [];

  constructor(
    readonly slot: number,
    public team: Team,
  ) {}

  /**
   * Accepts a validated position and stance.
   *
   * Crouch moves BOTH the eye and the centre, the same half metre, for the
   * reason `config/player.ts` spells out at length: bots aim at `eyePos`, so an
   * eye that drops while the hit sphere stays put makes crouching make you
   * easier to kill rather than harder. Getting that wrong here would invert the
   * mechanic for every networked player while leaving it correct offline.
   */
  apply(
    t: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    crouching: boolean,
    sprinting: boolean,
  ): void {
    const p = CONFIG.player;
    this.position.set(x, y, z);
    this.yaw = yaw;
    this.pitch = pitch;
    this.crouching = crouching;
    this.sprinting = sprinting;

    const eyeY = crouching ? p.crouchEyeHeight : CONFIG.camera.eyeHeight;
    const centerY = crouching ? p.crouchCenterHeight : CONFIG.camera.eyeHeight - 0.05;
    this.eyePos.set(x, y + eyeY, z);
    this.center.set(x, y + centerY, z);

    this.traces.push({ t, x, y, z, eyeY, centerY });
    if (this.traces.length > TRACE_LEN) this.traces.shift();
  }

  /**
   * Moves this player's hit spheres back to where they were at server time `t`.
   *
   * Phase 5 calls this around a shot so the authority re-resolves the ray
   * against what the shooter actually saw. It writes `eyePos` and `center` in
   * place because `CombatSystem.fire` reads them live — which is exactly why
   * `restore` must always run afterwards, in a `finally`.
   */
  rewindTo(t: number): void {
    if (this.traces.length === 0) return;
    const [a, b, blend] = this.bracket(t);
    const x = a.x + (b.x - a.x) * blend;
    const y = a.y + (b.y - a.y) * blend;
    const z = a.z + (b.z - a.z) * blend;
    const eyeY = a.eyeY + (b.eyeY - a.eyeY) * blend;
    const centerY = a.centerY + (b.centerY - a.centerY) * blend;
    this.eyePos.set(x, y + eyeY, z);
    this.center.set(x, y + centerY, z);
  }

  /** Puts the hit spheres back where the present says they are. */
  restore(): void {
    const p = CONFIG.player;
    const eyeY = this.crouching ? p.crouchEyeHeight : CONFIG.camera.eyeHeight;
    const centerY = this.crouching
      ? p.crouchCenterHeight
      : CONFIG.camera.eyeHeight - 0.05;
    this.eyePos.set(this.position.x, this.position.y + eyeY, this.position.z);
    this.center.set(this.position.x, this.position.y + centerY, this.position.z);
  }

  private bracket(t: number): [Trace, Trace, number] {
    const s = this.traces;
    if (t <= s[0].t) return [s[0], s[0], 0];
    const last = s[s.length - 1];
    if (t >= last.t) return [last, last, 0];
    for (let i = 0; i < s.length - 1; i++) {
      if (t <= s[i + 1].t) {
        const span = s[i + 1].t - s[i].t;
        return [s[i], s[i + 1], span > 0 ? (t - s[i].t) / span : 0];
      }
    }
    return [last, last, 0];
  }

  /**
   * Wired by `Match`: this player took a hit, for the vignette and the arc.
   *
   * A callback rather than a return value because `CombatSystem` calls
   * `takeDamage` and cares only whether it killed — the whole event, with the
   * bearing and the remaining health on it, has to leave by another door.
   */
  onDamaged: (amount: number, from: Vector3 | undefined, killed: boolean) => void =
    () => {};

  /**
   * Damage from a bot or another player. The server is the only thing that may
   * call this, and the client is told the outcome.
   *
   * `from` is where the round started, which the client turns into the
   * directional damage arc. Every damage path in the game already passes it.
   */
  takeDamage(amount: number, from?: Vector3): boolean {
    if (!this.alive) return false;
    this.health -= amount;
    const killed = this.health <= 0;
    if (killed) {
      this.health = 0;
      this.alive = false;
      this.respawnT = CONFIG.conquest.respawnDelay;
    }
    this.onDamaged(amount, from, killed);
    return killed;
  }

  spawn(at: Vector3, yaw: number): void {
    this.health = CONFIG.player.maxHealth;
    this.alive = true;
    this.crouching = false;
    this.sprinting = false;
    this.traces.length = 0;
    this.apply(Date.now(), at.x, at.y, at.z, yaw, 0, false, false);
  }

  /** Takes this player out of the fight without killing them — a disconnect. */
  retire(): void {
    this.alive = false;
    this.traces.length = 0;
  }
}
