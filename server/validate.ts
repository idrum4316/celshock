/**
 * server/validate.ts — Is the position a client just reported physically
 * possible?
 * Owns: the speed, ground and solid checks, and nothing else. It returns a
 * verdict; `Match` decides what to do about it.
 * Invariants: pure and allocation-free — it runs once per player per input tick
 * and must not become a place that touches sockets, rosters or rounds.
 *
 * This is what we bought instead of input replay. Clients simulate their own
 * `Player` exactly as they do offline and report where they ended up, which
 * costs nothing on the client and no refactor of `Player.update` — and the
 * price is that the server has to say what "impossible" means rather than
 * simply recomputing the answer. Three cheats are worth stopping and each has a
 * check here:
 *
 *   - **speedhack** — covering more ground than the fastest legal stance could
 *   - **teleport** — the degenerate case of the same check, over one tick
 *   - **noclip** — standing where the map is solid, or off the floor entirely
 *
 * What it deliberately does NOT stop is a player who cheats *within* tolerance:
 * someone moving at 1.19x sprint forever is invisible to this. That is the
 * accepted cost of trusting movement, and the tolerance below is the dial. It
 * is set for false negatives over false positives on purpose — a legitimate
 * player yanked backwards by a bad rejection has a worse experience than
 * everyone has from a cheat that buys 19% speed.
 */
import { Vector3 } from "@babylonjs/core";
import { CONFIG } from "../src/config";
import type { GameMap } from "../src/world/MapBuilder";

export type RejectReason = "speed" | "ground" | "solid";

export interface Verdict {
  ok: boolean;
  reason?: RejectReason;
}

const OK: Verdict = { ok: true };

/**
 * Headroom on the speed check.
 *
 * A client's step is its own frame time, which is neither the server's tick nor
 * constant: a browser that stalls for 200 ms and then resumes legitimately
 * covers 200 ms of ground in one sample. The margin absorbs that, plus the
 * slope bonus of running downhill and the rounding in a float position that has
 * been through a socket.
 */
const SPEED_TOLERANCE = 1.35;

/** How far above the floor a player may legitimately be, in metres. */
const AIR_ALLOWANCE = 6;

/** How far below it before they have fallen through the world. */
const SINK_ALLOWANCE = 1.5;

/**
 * The fastest a player can legitimately travel, in m/s.
 *
 * Sprint is the only stance that beats a plain walk, and ADS and crouch are
 * both slower — so the ceiling is the sprint multiplier and nothing else needs
 * enumerating. Read from `CONFIG` rather than written out, so a balance change
 * to movement speed cannot silently turn every player into a suspected cheat.
 */
const MAX_SPEED = CONFIG.player.moveSpeed * CONFIG.player.sprintMult;

/**
 * Checks one reported step.
 *
 * `dt` is the elapsed CLIENT time between this sample and the last accepted
 * one. It is clamped by the caller — a client that claims a huge `dt` would
 * otherwise buy itself a proportionally huge legal step, which is the obvious
 * way to dress a teleport up as a lag spike.
 */
export function validateMove(
  map: GameMap,
  from: Vector3,
  to: { x: number; y: number; z: number },
  dt: number,
): Verdict {
  // --- speed ---
  // Horizontal only. Vertical travel is gravity and jumping, whose bounds are
  // the ground check's business, and folding the two together would make a
  // legitimate fall down the terrace read as a speedhack.
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const travelled = Math.hypot(dx, dz);
  const allowed = MAX_SPEED * SPEED_TOLERANCE * dt;
  if (travelled > allowed) return { ok: false, reason: "speed" };

  // --- inside the world at all ---
  const half = map.size / 2;
  if (Math.abs(to.x) > half || Math.abs(to.z) > half) {
    return { ok: false, reason: "solid" };
  }

  // --- ground ---
  // The floor under the point, from the same `TerrainField` the client's own
  // ground probe reads. A player may be well above it (a jump, a roof, the
  // watchtower) but never appreciably below it.
  const floor = map.terrain.heightAt(to.x, to.z);
  if (to.y < floor - SINK_ALLOWANCE) return { ok: false, reason: "ground" };

  // A ceiling on how high above the terrain a player may be is NOT checked
  // here, and must not be: the map is full of legitimate high ground that the
  // heightfield knows nothing about — roofs, the gatehouse, the trestle. The
  // `AIR_ALLOWANCE` above the nearest walkable SURFACE is the meaningful test,
  // and the nav graph is what knows where those are.
  const surface = map.nav.surfaceAt(to.x, to.y, to.z);
  if (surface >= 0) {
    const standing = map.nav.heightOf(surface);
    if (to.y > standing + AIR_ALLOWANCE) return { ok: false, reason: "ground" };
  }

  // --- solid ---
  // Sub-cell collision, the same structure the bots are pushed out of props
  // with. `resolve` reports whether the point had to move to be legal; if it
  // did, the client is standing inside something.
  const out = SCRATCH;
  const pushed = map.obstacles.resolve(to.x, to.y, to.z, CONFIG.nav.bodyRadius, out);
  if (pushed) {
    const slipped = Math.hypot(out.x - to.x, out.z - to.z);
    // A small push-out is ordinary — a player brushing a crate is inside its
    // radius by centimetres all the time, and `ObstacleField`'s own contract
    // calls the push a preference rather than a veto. Only a deep one means
    // somebody is standing in a wall.
    if (slipped > CONFIG.nav.bodyRadius) return { ok: false, reason: "solid" };
  }

  return OK;
}

/**
 * Reused so validation allocates nothing per player per tick.
 *
 * A real `Vector3` and not a `{x, y, z}` literal: `ObstacleField.resolve`
 * writes through `.set`, and a plain object silently has no such method.
 */
const SCRATCH = new Vector3();
