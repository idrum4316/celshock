/**
 * editor/params.ts — Which BuildParams each builder actually reads, and what
 * it defaults to.
 * Owns: the descriptor table the inspector builds its controls from.
 *
 * This table has to be hand-maintained, and there is no way around it:
 * `BuildParams` (world/kit/core.ts) is deliberately ONE flat bag shared by
 * every builder — "builders ignore what they don't use" — so nothing at
 * runtime can say which fields `cottage` cares about and which it drops on the
 * floor. Showing all ten controls for every kind would be worse than useless:
 * most would do nothing, and there would be no way to tell which.
 *
 * **When you add a builder or teach an existing one a new param, add it here.**
 * The values below are read off the builders themselves; a default that drifts
 * shows the wrong number in the inspector but cannot corrupt a layout, because
 * a control the user never touches is never written.
 */
import type { BuilderKind } from "../world/BuildingKit";
import type { BuildParams } from "../world/kit/core";
import type { ScatterCircle, ScatterSpec } from "../world/layout";

/** One editable field. `step` is the drag/nudge granularity for numbers. */
export type ParamSpec =
  | { key: keyof BuildParams; type: "number"; label: string; def: number; min: number; max: number; step: number }
  | { key: keyof BuildParams; type: "boolean"; label: string; def: boolean }
  | {
      key: keyof BuildParams;
      type: "choice";
      label: string;
      def: string;
      options: string[];
      /**
       * The stored value is a number, not the option string. `rampSide` is
       * `-1 | 1`; writing "-1" into the layout would typecheck nowhere and
       * would reach the builder as a string.
       */
      numeric?: boolean;
    };

const num = (
  key: keyof BuildParams,
  label: string,
  def: number,
  min: number,
  max: number,
  step = 0.5,
): ParamSpec => ({ key, type: "number", label, def, min, max, step });

const bool = (key: keyof BuildParams, label: string, def = false): ParamSpec => ({
  key,
  type: "boolean",
  label,
  def,
});

/** Footprint triple shared by most enclosed buildings. */
const wdh = (w: number, d: number, h: number): ParamSpec[] => [
  num("width", "width", w, 2, 40),
  num("depth", "depth", d, 2, 40),
  num("height", "height", h, 1.5, 20),
];

/**
 * Every builder kind, mapped to the params it reads. An empty array means the
 * builder takes no params at all — it is placed as-is and only moved/rotated.
 */
export const PARAMS: Record<BuilderKind, ParamSpec[]> = {
  cottage: [
    ...wdh(7, 6, 3.4),
    bool("enterable", "enterable"),
    bool("ruined", "ruined"),
    bool("litWindows", "lit windows"),
  ],
  townhouse: [
    ...wdh(6.5, 6.5, 6.8),
    bool("enterable", "enterable"),
    bool("litWindows", "lit windows"),
  ],
  // Fixed footprint, for the reason buildJungleManor's header gives: the plan,
  // both stair runs, the stairwell void and the colonnade's bays are solved
  // against one another, so a width spinner would break three of them.
  manor: [bool("litWindows", "lit windows")],
  ruin: [num("width", "width", 10, 3, 40), num("depth", "depth", 8, 3, 40)],
  gatehouse: [
    { key: "teamColor", type: "choice", label: "team", def: "#c9a15e", options: ["#c9a15e", "#ff3b3b"] },
  ],
  shed: wdh(3.4, 2.8, 2.6),
  fence: [num("length", "length", 10, 2, 60, 1)],
  stoneWall: [
    num("length", "length", 12, 2, 60, 1),
    num("height", "height", 1.5, 0.5, 4, 0.25),
  ],
  bridge: [
    num("length", "length", 12, 4, 40, 1),
    num("width", "width", 3.2, 1.5, 12, 0.2),
  ],
  woodpile: [num("length", "length", 5, 1, 20, 0.5)],
  cart: [bool("ruined", "ruined")],
  terrace: [
    num("width", "width", 30, 4, 80, 1),
    num("depth", "depth", 26, 4, 80, 1),
    num("height", "height", 2, 0.5, 8, 0.25),
    // -1 / +1 rather than a number box: it names a face, not a distance.
    {
      key: "rampSide",
      type: "choice",
      label: "ramp side",
      def: "-1",
      options: ["-1", "1"],
      numeric: true,
    },
  ],
  ramp: [
    num("width", "width", 5, 1.5, 20),
    num("length", "length", 8, 2, 40, 1),
    num("height", "height", 1.5, 0.25, 8, 0.25),
  ],
  road: [
    num("width", "width", 8, 2, 20, 0.5),
    num("length", "length", 40, 4, 160, 1),
    { key: "surface", type: "choice", label: "surface", def: "cobble", options: ["cobble", "dirt"] },
  ],
  jetty: [num("length", "length", 18, 4, 60, 1)],

  // Fixed-geometry kinds: placed, rotated, and otherwise not configurable.
  tavern: [],
  smithy: [],
  watchtower: [],
  chapel: [],
  barn: [],
  silo: [],
  mill: [],
  boathouse: [],
  well: [],
  stall: [],
  haystack: [],
  lamp: [],
  crates: [],
  trough: [],
  shrine: [],
  kiln: [],
};

/** Kinds whose rotation should snap to the axis-aligned layout rule. */
export function isStructural(kind: BuilderKind): boolean {
  return kind !== "cart" && kind !== "crates" && kind !== "woodpile";
}

/**
 * Every builder kind, alphabetically — the add menu and the kind picker.
 *
 * Derived from PARAMS rather than listed again, so a builder added to
 * BuildingKit and to the table above cannot be missing from the menu.
 */
export const BUILDER_KINDS: readonly BuilderKind[] = (
  Object.keys(PARAMS) as BuilderKind[]
).sort();

/** The params one kind reads, as a set, for pruning after a kind change. */
export function paramKeys(kind: BuilderKind): Set<string> {
  return new Set(PARAMS[kind].map((s) => s.key as string));
}

type ScatterProp = ScatterSpec["prop"];

/**
 * What a fresh scatter region of each prop starts as. Circular: a disc is the
 * shape you can judge from a single click, and the shape control turns it into
 * a rectangle around the same footprint.
 */
type ScatterDefaults = Omit<ScatterCircle, "prop" | "x" | "z">;

/**
 * Starting values for a newly added scatter region, per prop.
 *
 * Read off the regions Hollowmere already uses rather than invented: a boulder
 * field wants 1.0 m of clearance and a gravestone 0.6, and a bramble patch is
 * non-blocking on purpose — you walk through brambles. Getting these wrong
 * would not corrupt anything, but every new region would need the same four
 * corrections by hand.
 *
 * A Record over the prop union, so a new scatter prop is a compile error here.
 */
export const SCATTER_DEFAULTS: Record<ScatterProp, ScatterDefaults> = {
  deadTree: { radius: 11, count: 10, scale: [0.8, 1.4], blocking: true, clearance: 0.55 },
  // Wider clearance than the dead tree and a tighter scale range: the crown is
  // 3.3 m across at scale 1, so the dead tree's 0.55 grows a stand of pines
  // into one solid green mass.
  pine: { radius: 12, count: 9, scale: [0.9, 1.3], blocking: true, clearance: 1.2 },
  gravestone: { radius: 5, count: 8, scale: [0.8, 1.3], blocking: true, clearance: 0.6 },
  log: { radius: 12, count: 5, scale: [0.8, 1.2], blocking: true, clearance: 1.4 },
  fungus: { radius: 14, count: 5, scale: [0.8, 1.4] },
  rubble: { radius: 8, count: 4, scale: [0.8, 1.2], blocking: true, clearance: 1.1 },
  fireDrum: { radius: 2, count: 1, blocking: true, clearance: 0.6 },
  boulder: { radius: 10, count: 5, scale: [0.8, 1.3], blocking: true, clearance: 1.0 },
  bramble: { radius: 12, count: 7, scale: [0.8, 1.4] },
  barrel: { radius: 6, count: 3, blocking: true, clearance: 0.55 },
};

export const SCATTER_PROPS = Object.keys(SCATTER_DEFAULTS).sort() as ScatterProp[];
