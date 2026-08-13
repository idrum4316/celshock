/**
 * solid.ts — The read side of `metadata.solid`: the one pick predicate every
 * ray test in the game filters with.
 * Invariants: this is a module CONSTANT, not a factory — it closes over nothing
 * and must keep closing over nothing, because the callers are per-shot and
 * per-frame and a predicate minted at the call site allocates on every one.
 * `MapBuilder` is the only writer of the flag (two sites); this is the only
 * spelling of the question.
 */
import type { AbstractMesh } from "@babylonjs/core";

/**
 * Collider proxies only — the invisible boxes `MapBuilder.collider()` tags,
 * never the visual geometry they stand in for. See `MapBuilder`'s header on the
 * visual/collider split for why the two roles are separate meshes.
 *
 * Every ray in the game runs through here: `CombatSystem`'s hitscan and its
 * wall cap, `BattleSystem`'s and `AimAssistSystem`'s line of sight, the
 * grenade's step ray and its throw check, `Player.probeGround`, the death cam's
 * pull-in, and the editor's centre-screen pick. They were seven copies of one
 * expression, two of them hoisted and five minted per call.
 *
 * It is written as a `!!metadata &&` guard rather than `metadata?.solid` so the
 * hot path does one truthiness test on a field that is `null` for most meshes
 * in the scene — every visual, every rig node, every effect — before it reaches
 * for a property at all.
 */
export const SOLID_ONLY = (m: AbstractMesh): boolean =>
  !!m.metadata && m.metadata.solid === true;
