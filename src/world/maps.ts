/**
 * maps.ts — The playable maps, as data: what a map IS, and which ones exist.
 * Owns: the `MapDef` pairing of a layout with the environment it is lit and
 * fogged by, and the registry `Game` picks one out of.
 * Invariants: the two halves travel together. A layout is placements and a
 * heightfield; an `EnvironmentSpec` is the palette, fog, sky and particles it
 * is meant to be seen under, and building one against the other's environment
 * gives a night village in daylight fog. Pairing them here is what stops the
 * orchestrator from having to know either name.
 *
 * This is the file a second map is added to, and — with its own `layout.ts`,
 * `heights.ts` and `environment.ts` under a directory of its own — the ONLY
 * existing file it has to touch. Nothing downstream may import a map's modules
 * directly: `Game` holds a `MapDef`, `MapBuilder.build` takes both halves as
 * arguments, and neither special-cases any particular map.
 */
import type { EnvironmentSpec } from "./environment";
import type { MapLayout } from "./layout";
import { GreyfenEnvironment } from "./greyfen/environment";
import { GreyfenLayout } from "./greyfen/layout";
import { HollowmereEnvironment } from "./hollowmere/environment";
import { HollowmereLayout } from "./hollowmere/layout";

/**
 * A map: the level data, the conditions it is seen under, and what to call it
 * on a scoreboard.
 *
 * Held by identity, not by id — `Game.applySky` skips repainting eight
 * megapixels of dome when the environment object is unchanged, and the
 * cheapest way to know that is that it is the same object. So a `MapDef` must
 * be a module-level constant, never rebuilt per round.
 */
export interface MapDef {
  /** Stable key. What a saved preference or a URL would name. */
  id: string;
  /** Shown to the player — the scoreboard's header and the round-over card. */
  name: string;
  layout: MapLayout;
  environment: EnvironmentSpec;
}

export const HOLLOWMERE: MapDef = {
  id: "hollowmere",
  name: "Hollowmere",
  layout: HollowmereLayout,
  environment: HollowmereEnvironment,
};

/**
 * Greyfen: the same valley at first light. Its layout was forked from
 * Hollowmere's and is diverging; the two share no module and must not.
 */
export const GREYFEN: MapDef = {
  id: "greyfen",
  name: "Greyfen",
  layout: GreyfenLayout,
  environment: GreyfenEnvironment,
};

/** Every map that can be played, in the order a picker would show them. */
export const MAPS: readonly MapDef[] = [HOLLOWMERE, GREYFEN];

/** What a round starts on with nothing chosen. */
export const DEFAULT_MAP: MapDef = HOLLOWMERE;
