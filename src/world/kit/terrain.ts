/**
 * kit/terrain.ts — Ground-shaping builders: terrace, ramp, road, jetty.
 * All follow the contract in kit/core.ts (origin-local geometry, no
 * solid/pickable/collisions metadata).
 * Extra care here: these are walkable surfaces, so their collider top faces
 * must stay within CONFIG.nav.stepHeight of adjacent ground and ramps need
 * rotX on the COLLIDER, not just the visual.
 */
import { Scene } from "@babylonjs/core";
import type { CelMaterialFactory } from "../../shaders/CelShader";
import { terrainSlab } from "../TerrainField";
import {
  Build,
  type BuildCtx,
  type BuildParams,
  type Structure,
  DARK_STONE,
  DIRT,
  PLANK,
  TIMBER,
} from "./core";

/**
 * A raised earth terrace with a ramp on one side. Used for the chapel's
 * graveyard platform; the top face and the ramp are both walkable colliders.
 */
export function buildTerrace(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "terrace");
  const w = p.width ?? 30;
  const d = p.depth ?? 26;
  const h = p.height ?? 2;
  const side = p.rampSide ?? -1;

  b.box(w, h, d, 0, h / 2, 0, DIRT);
  b.block({ w, h, d, x: 0, y: h / 2, z: 0 });
  // Retaining wall, so the terrace edge reads as built rather than extruded.
  for (const sx of [-1, 1]) {
    b.box(0.4, h + 0.3, d, (sx * w) / 2, (h + 0.3) / 2, 0, DARK_STONE);
  }
  b.box(w, h + 0.3, 0.4, 0, (h + 0.3) / 2, (-side * d) / 2, DARK_STONE);

  // Ramp up the chosen face.
  const rampLen = h * 5;
  const pitch = Math.atan2(h, rampLen);
  const rz = (side * (d + rampLen)) / 2;
  b.box(7, 0.3, rampLen, 0, h / 2, rz, DIRT, { x: side * pitch });
  b.block({ w: 7, h: 0.3, d: rampLen, x: 0, y: h / 2, z: rz, rotX: side * pitch });
  return b;
}

/**
 * A standalone earth ramp, rising from -Z to +Z over `length`. Used to get in
 * and out of the creek at more than one point — a sunken lane with a single
 * exit is a trap, and the nav grid needs somewhere to route bots through.
 */
export function buildRamp(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "ramp");
  const w = p.width ?? 5;
  const len = p.length ?? 8;
  const h = p.height ?? 1.5;
  const pitch = Math.atan2(h, len);
  b.box(w, 0.3, len, 0, h / 2, 0, DIRT, { x: -pitch });
  b.block({ w, h: 0.3, d: len, x: 0, y: h / 2, z: 0, rotX: -pitch });
  // Kerb stones, so the ramp reads as built rather than as a floating slab.
  for (const sx of [-1, 1]) {
    b.box(0.4, h + 0.3, len, (sx * w) / 2, h / 2 - 0.2, 0, DARK_STONE, {
      x: -pitch,
    });
  }
  return b;
}

/**
 * Road surface. Visual only — it sits on the ground, so nothing ever stands on
 * the slab itself: feet rest on the floor from the ground probe and the nav
 * grid. The slab is therefore sunk so its top sits only a centimetre proud —
 * enough to avoid z-fighting the floor, but not enough to swallow a
 * character's ankles. Cobblestone by default; `surface: "dirt"` gives the flat
 * track for farm lanes.
 *
 * It is the one builder whose shape depends on where it is going. MapBuilder
 * samples the floor once, at a placement's own centre, and translates the whole
 * structure by it — fine for a cottage, wrong for 130 m of street, which used
 * to float at one end and bury itself at the other over sculpted ground. So the
 * slab is re-cut against the heightfield by `terrainSlab`, which returns null
 * over level ground and leaves the single box the road has always been. That
 * fast path is why a flat map costs exactly what it used to.
 */
export function buildRoad(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
  ctx?: BuildCtx,
): Structure {
  const b = new Build(scene, mats, "road");
  const top = 0.01;
  const h = 0.08;
  const w = p.width ?? 8;
  const len = p.length ?? 40;
  const dirt = p.surface === "dirt";

  const contoured =
    ctx &&
    terrainSlab(ctx.terrain, {
      w,
      len,
      x: ctx.x,
      z: ctx.z,
      rotY: ctx.rotY,
      originY: ctx.y,
      top,
      thickness: h,
    });
  if (contoured) b.surface(contoured, dirt ? DIRT : undefined);
  else if (dirt) b.box(w, h, len, 0, top - h / 2, 0, DIRT);
  else b.groundBox(w, h, len, 0, top - h / 2, 0);
  return b;
}

/** Rotting jetty over the bog, running along Z. */
export function buildJetty(
  scene: Scene,
  mats: CelMaterialFactory,
  p: BuildParams = {},
): Structure {
  const b = new Build(scene, mats, "jetty");
  const len = p.length ?? 18;
  const w = 3;
  // Deck top must stay under CONFIG.nav.stepHeight above the mud, or the
  // flood fill never reaches it and bots treat the jetty as a wall.
  b.box(w, 0.24, len, 0, 0.45, 0, PLANK);
  b.block({ w, h: 0.24, d: len, x: 0, y: 0.45, z: 0 });
  const posts = Math.round(len / 3);
  for (let i = 0; i <= posts; i++) {
    const z = -len / 2 + (i / posts) * len;
    for (const sx of [-1, 1]) {
      b.cyl(1.3, 0.26, 0.32, 5, (sx * w) / 2.5, 0.05, z, TIMBER);
    }
  }
  return b;
}
