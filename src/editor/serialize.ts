/**
 * editor/serialize.ts — Writes an edited layout back into layout.ts's source
 * text, changing as little as possible.
 * Owns: the emit rules and the value formatter.
 *
 * The governing rule, in two halves:
 *
 * - An entry nobody touched is re-emitted as its **original line, byte for
 *   byte**. Not reformatted, not normalised — copied.
 * - An entry that changed is rebuilt field by field, and each field whose
 *   value is still equal to what was loaded re-emits its **original source
 *   token**.
 *
 * That second half is what preserves `TERRACE_H`, `BANK_H`, `WARDEN`,
 * `Math.PI / 2` and hand-chosen spacing even inside an entry that was
 * partially edited — without this file ever having to evaluate or understand
 * those expressions. It compares against a deep snapshot of the layout taken
 * when the editor opened, so "unchanged" is decided on values, and the token
 * is just carried along.
 *
 * Newly written values are formatted, and only then does a substitution table
 * apply — scoped per field, because an unscoped `2 -> TERRACE_H` would happily
 * corrupt `params: { length: 2 }`.
 */
import { Vector3 } from "@babylonjs/core";
import type { MapLayout } from "../world/layout";
import {
  itemsOf,
  type ItemLine,
  type ParsedField,
  type Scan,
} from "./sourceScan";

/** Named constants worth restoring, per field path. */
const CONSTANTS: Record<string, [number, string][]> = {
  y: [
    [2, "TERRACE_H"],
    [1.5, "BANK_H"],
  ],
  "pos.y": [
    [2, "TERRACE_H"],
    [1.5, "BANK_H"],
  ],
};

const COLORS: Record<string, string> = {
  "#c9a15e": "WARDEN",
  "#ff3b3b": "BLIGHT",
};

/** Fields that read better as multiples of pi, matching how they're authored. */
const ANGLE_KEYS = new Set(["rotY", "yaw", "rotX"]);

/**
 * Declaration order per array, so a field the editor ADDS lands where the
 * house style puts it instead of being appended. Without this, giving an
 * unrotated cottage a rotY writes `{ kind, x, z, params, rotY }` while every
 * line around it reads `{ kind, x, z, rotY, params }`.
 *
 * Only affects entries being rewritten anyway; untouched lines are copied.
 */
const KEY_ORDER: Record<string, string[]> = {
  placements: ["kind", "x", "z", "y", "rotY", "params"],
  scatter: [
    "prop",
    "x",
    "z",
    "radius",
    "count",
    "y",
    "scale",
    "blocking",
    "clearance",
  ],
  controlPoints: ["id", "name", "pos", "radius"],
  spawns: ["team", "controlPoint", "pos", "yaw"],
  water: ["x", "z", "width", "depth", "y"],
  grass: ["x", "z", "width", "depth", "y", "density"],
};

export class SerializeError extends Error {}

/** A number, trimmed to something a human would have typed. */
function num(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}

/** Angles as `Math.PI / 2` and friends when they land on a quarter turn. */
function angle(v: number): string {
  if (v === 0) return "0";
  const turns = v / Math.PI;
  const q = Math.round(turns * 4) / 4;
  if (Math.abs(turns - q) > 1e-9) return num(v);
  const sign = q < 0 ? "-" : "";
  const a = Math.abs(q);
  if (a === 1) return `${sign}Math.PI`;
  if (a === 0.5) return `${sign}Math.PI / 2`;
  if (a === 0.25) return `${sign}Math.PI / 4`;
  if (a === 0.75) return `${sign}(Math.PI * 3) / 4`;
  if (a === 1.5) return `${sign}(Math.PI * 3) / 2`;
  return num(v);
}

/** Formats a value as source, at the given field path. */
function format(value: unknown, path: string): string {
  if (value === null || value === undefined) return "undefined";
  if (typeof value === "boolean") return String(value);

  if (typeof value === "number") {
    const leaf = path.split(".").pop() ?? path;
    if (ANGLE_KEYS.has(leaf)) return angle(value);
    for (const [n, name] of CONSTANTS[path] ?? []) {
      if (value === n) return name;
    }
    return num(value);
  }

  if (typeof value === "string") {
    const named = COLORS[value.toLowerCase()];
    return named ?? JSON.stringify(value);
  }

  if (value instanceof Vector3) {
    return `new Vector3(${num(value.x)}, ${num(value.y)}, ${num(value.z)})`;
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => format(v, path)).join(", ")}]`;
  }

  if (typeof value === "object") {
    const body = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${format(v, `${path}.${k}`)}`)
      .join(", ");
    return `{ ${body} }`;
  }

  return String(value);
}

/** Value equality that understands Vector3 and plain data. */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Vector3 && b instanceof Vector3) return a.equals(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).filter(
      (k) => (a as Record<string, unknown>)[k] !== undefined,
    );
    const kb = Object.keys(b as object).filter(
      (k) => (b as Record<string, unknown>)[k] !== undefined,
    );
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** A deep copy, so the original values survive being edited in place. */
export function snapshot<T>(value: T): T {
  if (value instanceof Vector3) return value.clone() as unknown as T;
  if (Array.isArray(value)) return value.map(snapshot) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = snapshot(v);
    return out as T;
  }
  return value;
}

/**
 * Rebuilds one entry's line. Retained fields keep their original order and
 * their original token; changed and added fields are formatted; fields the
 * editor removed simply do not appear.
 */
function emitItem(
  line: ItemLine,
  original: Record<string, unknown>,
  current: Record<string, unknown>,
  region: string,
): string {
  const fields = line.fields;
  // Untokenizable entry: refuse to rewrite it rather than risk mangling it.
  if (!fields) return line.source;

  const byKey = new Map(fields.map((f) => [f.key, f]));
  const canonical = KEY_ORDER[region] ?? [];
  // Canonical first, then anything the table doesn't know about, in the order
  // the source had it — an unrecognised field must never be silently dropped.
  const order = [
    ...canonical,
    ...fields.map((f) => f.key).filter((k) => !canonical.includes(k)),
    ...Object.keys(current).filter(
      (k) => !canonical.includes(k) && !byKey.has(k),
    ),
  ];

  const out: string[] = [];
  const done = new Set<string>();
  for (const key of order) {
    if (done.has(key)) continue;
    done.add(key);
    const now = current[key];
    if (now === undefined) continue; // absent, or removed by the editor
    const field = byKey.get(key);
    out.push(
      `${key}: ${field ? tokenFor(field, original[key], now, key) : format(now, key)}`,
    );
  }

  return `${line.indent}{ ${out.join(", ")} },`;
}

/** The original token when the value is untouched, a fresh one otherwise. */
function tokenFor(
  field: ParsedField,
  before: unknown,
  after: unknown,
  path: string,
): string {
  return equal(before, after) ? field.source : format(after, path);
}

/** The entries of one region, as plain records, from a layout. */
function entriesOf(layout: MapLayout, name: string): Record<string, unknown>[] {
  const v = (layout as unknown as Record<string, unknown>)[name];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

/**
 * Produces the new contents of layout.ts.
 *
 * Throws when an array's length no longer matches the source it was scanned
 * from. The editor cannot add or remove entries yet, so that can only mean the
 * file changed underneath the session — and writing then would clobber it.
 */
export function serializeLayout(
  scan: Scan,
  original: MapLayout,
  current: MapLayout,
): string {
  const out: string[] = [];
  let cursor = 0;

  for (const region of scan.regions) {
    for (; cursor <= region.start; cursor++) out.push(scan.lines[cursor]);

    const before = entriesOf(original, region.name);
    const after = entriesOf(current, region.name);
    const items = itemsOf(region);
    if (items.length !== before.length || before.length !== after.length) {
      throw new SerializeError(
        `${region.name}: source has ${items.length} entries, layout has ` +
          `${after.length} (loaded with ${before.length}). Reload the editor.`,
      );
    }

    let n = 0;
    for (const line of region.body) {
      if (line.kind === "raw") {
        out.push(line.source);
        continue;
      }
      const i = n++;
      // The whole point: an untouched entry is copied, not regenerated.
      out.push(
        equal(before[i], after[i])
          ? line.source
          : emitItem(line, before[i], after[i], region.name),
      );
    }
    cursor = region.end;
  }

  for (; cursor < scan.lines.length; cursor++) out.push(scan.lines[cursor]);
  return out.join("\n");
}

/** Regions the scanner must have found for a save to be considered safe. */
export function validateScan(scan: Scan): void {
  const required: Record<string, number> = {};
  for (const r of scan.regions) required[r.name] = r.end - r.start;
  for (const name of ["placements", "scatter", "controlPoints", "spawns"]) {
    if (!(name in required)) {
      throw new SerializeError(`layout.ts: could not find the ${name} array`);
    }
  }
}
