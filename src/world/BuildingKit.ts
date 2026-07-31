/**
 * BuildingKit.ts — Facade for the parametric structure builders. Re-exports
 * the shared types and the BUILDERS registry; the implementation lives in
 * kit/ (core.ts = Build accumulator + palette + contract, buildings.ts,
 * structures.ts, terrain.ts).
 * Invariants: builders assemble AT THE ORIGIN, UNROTATED and NEVER set
 * metadata.solid, checkCollisions, or isPickable — MapBuilder owns the
 * visual/collider split. Collider top faces must stay within
 * CONFIG.nav.stepHeight of adjacent ground; ramp colliders need rotX.
 * New builders: write them in the kit/ file they belong to, register here.
 * No Hollowmere special-casing.
 */
export type { BoxSpec, BuildParams, LocalLight, Structure } from "./kit/core";

import {
  buildCottage,
  buildTownhouse,
  buildTavern,
  buildSmithy,
  buildRuin,
  buildWatchtower,
  buildChapel,
  buildBarn,
  buildMill,
  buildBoathouse,
  buildGatehouse,
} from "./kit/buildings";
import {
  buildSilo,
  buildWell,
  buildStall,
  buildFence,
  buildStoneWall,
  buildBridge,
  buildHaystack,
  buildLampPost,
  buildCart,
  buildCrates,
  buildWoodpile,
  buildShed,
  buildTrough,
  buildShrine,
  buildKiln,
} from "./kit/structures";
import { buildTerrace, buildRamp, buildRoad, buildJetty } from "./kit/terrain";

/** Every builder, keyed by the name the layout data uses. */
export const BUILDERS = {
  cottage: buildCottage,
  townhouse: buildTownhouse,
  tavern: buildTavern,
  smithy: buildSmithy,
  ruin: buildRuin,
  watchtower: buildWatchtower,
  chapel: buildChapel,
  barn: buildBarn,
  silo: buildSilo,
  mill: buildMill,
  boathouse: buildBoathouse,
  gatehouse: buildGatehouse,
  well: buildWell,
  stall: buildStall,
  fence: buildFence,
  stoneWall: buildStoneWall,
  bridge: buildBridge,
  terrace: buildTerrace,
  ramp: buildRamp,
  road: buildRoad,
  jetty: buildJetty,
  haystack: buildHaystack,
  lamp: buildLampPost,
  cart: buildCart,
  crates: buildCrates,
  woodpile: buildWoodpile,
  shed: buildShed,
  trough: buildTrough,
  shrine: buildShrine,
  kiln: buildKiln,
} as const;

export type BuilderKind = keyof typeof BUILDERS;
