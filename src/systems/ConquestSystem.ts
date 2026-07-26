import { Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import type { Combatant, Team } from "../entities/Combatant";
import type { ControlPointDef, GameMap, SpawnPointDef } from "../world/MapBuilder";

/** Live state of one flag. */
export interface ControlPoint {
  def: ControlPointDef;
  /** Who owns it, or null while neutral. */
  owner: Team | null;
  /**
   * Capture meter, -1 (team 0 holds it outright) .. +1 (team 1 does). Ownership
   * flips only by crossing 0, so a flag must be neutralised before it changes
   * hands — you cannot steal one by briefly outnumbering the defender.
   */
  meter: number;
  /** Bodies inside the zone this tick, per team. */
  present: [number, number];
  /** True while both teams are inside and the meter is frozen. */
  contested: boolean;
}

/**
 * Conquest: flags, capture meters, tickets, and the bleed that ends a round.
 *
 * The ticket model is the standard one. Each death costs the dying team a
 * ticket, and whichever side holds fewer flags loses tickets steadily on top —
 * so a team that is winning fights but ignoring objectives still loses. That
 * bleed is the only thing making the flags matter, which is why it scales with
 * the size of the deficit rather than being a flat drip.
 */
export class ConquestSystem {
  readonly points: ControlPoint[] = [];
  readonly tickets: [number, number] = [0, 0];
  /** Set once a side runs out; null while the round is live. */
  winner: Team | null = null;

  /** Wired by Game: a flag changed hands (for the HUD and a sound). */
  onCaptured: (point: ControlPoint, by: Team) => void = () => {};
  /** Wired by Game: a flag went neutral. */
  onNeutralised: (point: ControlPoint) => void = () => {};

  private spawns: SpawnPointDef[] = [];
  private bleedT = 0;

  start(map: GameMap): void {
    this.points.length = 0;
    for (const def of map.controlPoints) {
      this.points.push({
        def,
        owner: null,
        meter: 0,
        present: [0, 0],
        contested: false,
      });
    }
    this.spawns = map.spawns;
    this.tickets[0] = CONFIG.conquest.tickets;
    this.tickets[1] = CONFIG.conquest.tickets;
    this.winner = null;
    this.bleedT = 0;
  }

  /** Charges a team one ticket for a death. */
  registerDeath(team: Team): void {
    if (this.winner !== null) return;
    this.tickets[team] = Math.max(
      0,
      this.tickets[team] - CONFIG.conquest.ticketsPerDeath,
    );
    this.checkWin();
  }

  flagsHeld(team: Team): number {
    let n = 0;
    for (const p of this.points) if (p.owner === team) n++;
    return n;
  }

  /** The point a combatant is standing in, if any. */
  pointAt(pos: Vector3): ControlPoint | null {
    for (const p of this.points) {
      const dx = p.def.pos.x - pos.x;
      const dz = p.def.pos.z - pos.z;
      if (dx * dx + dz * dz < p.def.radius * p.def.radius) return p;
    }
    return null;
  }

  update(dt: number, combatants: Combatant[]): void {
    if (this.winner !== null) return;
    const c = CONFIG.conquest;

    // --- occupancy ---
    for (const p of this.points) {
      p.present[0] = 0;
      p.present[1] = 0;
    }
    for (const unit of combatants) {
      if (!unit.alive) continue;
      const p = this.pointAt(unit.position);
      if (p) p.present[unit.team] += 1;
    }

    // --- capture meters ---
    for (const p of this.points) {
      const a = p.present[0];
      const b = p.present[1];
      p.contested = a > 0 && b > 0;
      if (p.contested || (a === 0 && b === 0)) continue;

      const attackers = a > 0 ? a : b;
      const direction = a > 0 ? -1 : 1;
      // More bodies capture faster, but with diminishing returns, so a whole
      // squad can't flip a flag the instant it arrives.
      let mult = 0;
      for (let i = 0; i < attackers; i++) mult += c.crowdFalloff ** i;
      mult = Math.min(mult, c.maxCaptureMult);

      const before = p.meter;
      p.meter = clamp(p.meter + direction * c.captureRate * mult * dt, -1, 1);

      // Crossing zero neutralises; reaching the end captures.
      if (before !== 0 && Math.sign(before) !== Math.sign(p.meter) && p.owner !== null) {
        p.owner = null;
        this.onNeutralised(p);
      }
      const team: Team | null =
        p.meter <= -1 ? 0 : p.meter >= 1 ? 1 : null;
      if (team !== null && p.owner !== team) {
        p.owner = team;
        this.onCaptured(p, team);
      }
    }

    // --- ticket bleed ---
    this.bleedT += dt;
    if (this.bleedT >= c.bleedInterval) {
      this.bleedT -= c.bleedInterval;
      const held0 = this.flagsHeld(0);
      const held1 = this.flagsHeld(1);
      if (held0 !== held1) {
        const loser: Team = held0 < held1 ? 0 : 1;
        const deficit = Math.abs(held0 - held1);
        this.tickets[loser] = Math.max(
          0,
          this.tickets[loser] - c.bleedPerFlagDeficit * deficit,
        );
      }
      this.checkWin();
    }
  }

  /**
   * Where a combatant of `team` should deploy: a spawn attached to a flag they
   * hold, biased toward the one nearest the fighting, falling back to the home
   * gatehouse. Spawns tied to a contested flag are skipped, so nobody drops
   * into the middle of a firefight they cannot see coming.
   */
  spawnFor(team: Team): SpawnPointDef | null {
    const owned = this.flagSpawnsFor(team);
    if (owned.length > 0) {
      // Prefer a flag adjacent to a contested one — that is where the line is.
      const frontline = owned.filter((s) => {
        const p = this.points.find((q) => q.def.id === s.controlPoint)!;
        return this.points.some(
          (q) => q !== p && q.owner !== team && near(q.def.pos, p.def.pos, 90),
        );
      });
      const pool = frontline.length > 0 ? frontline : owned;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    const home = this.homeSpawnsFor(team);
    if (home.length === 0) return null;
    return home[Math.floor(Math.random() * home.length)];
  }

  /**
   * Flag spawns this team may deploy to: owned and not currently contested, so
   * nobody drops into the middle of a fight they can't see coming.
   */
  flagSpawnsFor(team: Team): SpawnPointDef[] {
    const out: SpawnPointDef[] = [];
    for (const s of this.spawns) {
      if (!s.controlPoint) continue;
      const p = this.points.find((q) => q.def.id === s.controlPoint);
      if (p && p.owner === team && !p.contested) out.push(s);
    }
    return out;
  }

  /** The uncapturable home spawn — always available, so you can never be locked out. */
  homeSpawnsFor(team: Team): SpawnPointDef[] {
    return this.spawns.filter((s) => s.team === team);
  }

  /** Everything the deploy screen should offer, home spawn first. */
  deployOptions(team: Team): SpawnPointDef[] {
    return [...this.homeSpawnsFor(team).slice(0, 1), ...this.flagSpawnsFor(team)];
  }

  pointById(id: string): ControlPoint | undefined {
    return this.points.find((p) => p.def.id === id);
  }

  /**
   * Which flag a squad should be heading for.
   *
   * Deliberately simple: score every point by how much it is worth taking and
   * hand the squad the best one, with the squad index breaking ties so the four
   * squads spread across the map instead of stacking on one flag.
   */
  objectiveFor(team: Team, squad: number, from: Vector3): string {
    if (this.points.length === 0) return "";
    const ranked = this.points
      .map((p) => ({ p, score: this.pointValue(p, team, from) }))
      .sort((a, b) => b.score - a.score);
    // Each squad takes a different entry from the ranked list, wrapping round,
    // so the four squads spread over the map instead of stacking on one flag.
    return ranked[squad % ranked.length].p.def.id;
  }

  private pointValue(p: ControlPoint, team: Team, from: Vector3): number {
    let score = 100;
    // Taking a flag off the enemy is worth more than grabbing a neutral one,
    // which is worth more than standing on your own.
    if (p.owner === null) score += 40;
    else if (p.owner !== team) score += 70;
    else score -= 30;
    if (p.contested) score += 50;
    // Distance is a mild penalty, not a dominant one — otherwise every squad
    // just defends whatever is closest to the home spawn.
    score -= Vector3.Distance(from, p.def.pos) * 0.25;
    return score;
  }

  private checkWin(): void {
    if (this.winner !== null) return;
    if (this.tickets[0] <= 0) this.winner = 1;
    else if (this.tickets[1] <= 0) this.winner = 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function near(a: Vector3, b: Vector3, dist: number): boolean {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz < dist * dist;
}
