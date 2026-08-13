/**
 * net/NetRoster.ts — The sixteen other bodies on screen, driven by snapshots.
 * Owns: the `NetSoldier` pool, applying snapshots to it, the mirrored flag and
 * ticket state, and the distance LOD. It is the client's replacement for
 * `BattleSystem` in a networked round — same job on screen, none of the job
 * underneath, because no AI runs here.
 * Invariants: the pool is built once and NEVER disposed, sized to the roster,
 * and indexed by slot. A slot's soldier is the same object for the life of the
 * session; only its OCCUPANT changes, which is why a human taking a bot's place
 * costs nothing on this side and is invisible on screen.
 * Never runs a think tick, never calls `CombatSystem.fire`, never decides a
 * death. If any of those appear here, AI has come back to the client.
 *
 * The local player is not in the pool. `Game` keeps its own `Player` and the
 * server knows which slot that is; this renders everybody else, and the slot
 * belonging to the local player is left disabled.
 */
import { Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { NetSoldier } from "../entities/NetSoldier";
import type { Combatant, Team } from "../entities/Combatant";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { ControlPoint } from "../systems/ConquestSystem";
import type { PointState, SlotState, Snapshot } from "./protocol";

export class NetRoster {
  /** One per roster slot, indexed by slot. Built once, never disposed. */
  readonly soldiers: NetSoldier[] = [];

  /** Mirrored from the server each snapshot. */
  readonly tickets: [number, number] = [0, 0];

  /** The slot the local player owns, or -1 while spectating. */
  localSlot = -1;

  constructor(scene: Scene, mats: CelMaterialFactory) {
    for (let team = 0; team < 2; team++) {
      const spec = CONFIG.teams[team];
      for (let i = 0; i < CONFIG.bots.perTeam; i++) {
        this.soldiers.push(
          new NetSoldier(
            scene,
            mats,
            this.soldiers.length,
            team as Team,
            spec.color,
            spec.eyeColor,
          ),
        );
      }
    }
  }

  /**
   * A roster message: who is in which slot.
   *
   * Almost nothing to do, and that is the design working. A slot changing from
   * a bot to a human changes no mesh, no pool entry and no index — the body
   * carries on from where it was, now fed by a different source. The only
   * reaction needed is to stop drawing the slot the local player just took,
   * because that one is rendered as a first-person viewmodel instead.
   */
  applyRoster(slots: readonly SlotState[], localSlot: number): void {
    this.localSlot = localSlot;
    for (const slot of slots) {
      const soldier = this.soldiers[slot.index];
      if (!soldier) continue;
      soldier.team = slot.team;
      if (slot.index === localSlot) soldier.reset();
    }
  }

  /** Takes a snapshot: entity samples in, mirrored objective state in. */
  applySnapshot(snap: Snapshot, points: ControlPoint[]): void {
    for (const e of snap.entities) {
      if (e.i === this.localSlot) continue;
      const soldier = this.soldiers[e.i];
      if (!soldier) continue;
      soldier.receive(
        snap.now,
        e.p,
        e.yaw,
        e.bodyYaw,
        e.pitch,
        e.moving,
        e.dead,
        e.alive,
      );
    }

    this.tickets[0] = snap.tickets[0];
    this.tickets[1] = snap.tickets[1];
    applyPoints(points, snap.points);
  }

  /**
   * Poses every body for `renderTime`, and applies the same distance LOD
   * `BattleSystem` applies to bots.
   *
   * The LOD is worth keeping even though nothing here is simulated: it is a
   * DRAWING budget, and sixteen rigs with outlines is the same number of draw
   * calls whether an FSM or a socket decided where they stand.
   *
   * No `dt`, for the reason `NetSoldier.update` gives: nothing on this path
   * integrates against frame time.
   */
  update(renderTime: number, cameraPos: Vector3): void {
    const b = CONFIG.bots;
    for (const soldier of this.soldiers) {
      if (soldier.slot === this.localSlot) continue;
      soldier.update(renderTime);
      const d = Vector3.Distance(soldier.position, cameraPos);
      if (d > b.lodDisableDistance) {
        soldier.setEnabled(false);
        continue;
      }
      soldier.setOutlines(d < b.lodOutlineDistance);
    }
  }

  /** Everything drawable, for the systems that take a combatant list. */
  combatants(into: Combatant[]): void {
    for (const soldier of this.soldiers) {
      if (soldier.slot !== this.localSlot) into.push(soldier);
    }
  }

  dispose(): void {
    for (const soldier of this.soldiers) soldier.dispose();
    this.soldiers.length = 0;
  }
}

/**
 * Mirrors flag state onto the client's `ConquestSystem` points.
 *
 * Written in terms of the live `ControlPoint` objects rather than replacing
 * them, because `CaptureZoneSystem`, `HUD.setFlags` and `Minimap` all hold
 * references to those objects and read them every frame. Swapping the array
 * would leave three systems drawing last round's flags with nothing throwing.
 */
function applyPoints(points: ControlPoint[], states: readonly PointState[]): void {
  for (const state of states) {
    const point = points.find((p) => p.def.id === state.id);
    if (!point) continue;
    point.owner = state.owner;
    point.meter = state.meter;
    point.contested = state.contested;
  }
}
