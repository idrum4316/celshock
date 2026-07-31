/**
 * editor/inspect.ts — Turns a selection into the inspector's title and rows.
 * Owns: the read model. Writes nothing.
 *
 * Params are shown through the PARAMS descriptor table rather than by dumping
 * the params bag, because BuildParams is one flat union shared by 30 builders:
 * a bag may legitimately carry a field the selected builder ignores, and
 * showing it would suggest an effect that isn't there. Fields the layout left
 * unset are shown at the builder's own default, marked so, since that is what
 * the geometry in front of you was actually built from.
 */
import type { MapLayout } from "../world/layout";
import type { InspectorRow } from "./EditorPanel";
import { PARAMS } from "./params";
import type { SelectionRef } from "./selection";

const n = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

/** Radians as a readable multiple of pi, since layouts are authored that way. */
function angle(rad: number): string {
  const turns = rad / Math.PI;
  const q = Math.round(turns * 4) / 4;
  if (Math.abs(turns - q) > 1e-6 || q === 0) return `${n(rad)} rad`;
  if (q === 1) return "pi";
  if (q === -1) return "-pi";
  return `${n(q)} pi`;
}

export interface Inspection {
  title: string;
  rows: InspectorRow[];
}

/** The three fields water and grass rects share. */
function rectRows(r: {
  x: number;
  z: number;
  y?: number;
  width: number;
  depth: number;
}): InspectorRow[] {
  return [
    { label: "x / z", value: `${n(r.x)}, ${n(r.z)}` },
    { label: "y", value: n(r.y ?? 0) },
    { label: "size", value: `${n(r.width)} x ${n(r.depth)}` },
  ];
}

export function inspect(layout: MapLayout, ref: SelectionRef | null): Inspection {
  if (!ref) return { title: "", rows: [] };

  switch (ref.list) {
    case "placements": {
      const p = layout.placements[ref.index];
      if (!p) break;
      const rows: InspectorRow[] = [
        { label: "x / z", value: `${n(p.x)}, ${n(p.z)}` },
        { label: "y", value: n(p.y ?? 0) },
        { label: "rotY", value: angle(p.rotY ?? 0) },
      ];
      const specs = PARAMS[p.kind];
      if (!specs.length) {
        rows.push({ label: "params", value: "none" });
      } else {
        for (const s of specs) {
          const set = p.params?.[s.key];
          const value = set === undefined ? `${s.def} (default)` : String(set);
          rows.push({ label: s.label, value });
        }
      }
      return { title: `${p.kind} #${ref.index}`, rows };
    }

    case "scatter": {
      const s = layout.scatter[ref.index];
      if (!s) break;
      return {
        title: `${s.prop} field #${ref.index}`,
        rows: [
          { label: "x / z", value: `${n(s.x)}, ${n(s.z)}` },
          { label: "y", value: n(s.y ?? 0) },
          { label: "radius", value: n(s.radius) },
          { label: "count", value: String(s.count) },
          { label: "scale", value: s.scale ? `${n(s.scale[0])}–${n(s.scale[1])}` : "1" },
          { label: "blocking", value: s.blocking ? `yes (${n(s.clearance ?? 0.8)} m)` : "no" },
        ],
      };
    }

    case "controlPoints": {
      const cp = layout.controlPoints[ref.index];
      if (!cp) break;
      return {
        title: `flag ${cp.id} — ${cp.name}`,
        rows: [
          { label: "x / z", value: `${n(cp.pos.x)}, ${n(cp.pos.z)}` },
          { label: "y", value: n(cp.pos.y) },
          { label: "radius", value: n(cp.radius) },
        ],
      };
    }

    case "spawns": {
      const s = layout.spawns[ref.index];
      if (!s) break;
      const owner =
        s.team === null ? `flag ${s.controlPoint ?? "?"}` : `team ${s.team}`;
      return {
        title: `spawn #${ref.index}`,
        rows: [
          { label: "owner", value: owner },
          { label: "x / z", value: `${n(s.pos.x)}, ${n(s.pos.z)}` },
          { label: "y", value: n(s.pos.y) },
          { label: "yaw", value: angle(s.yaw) },
        ],
      };
    }

    case "water": {
      const r = layout.water?.[ref.index];
      if (!r) break;
      return { title: `water rect #${ref.index}`, rows: rectRows(r) };
    }

    case "grass": {
      const r = layout.grass?.[ref.index];
      if (!r) break;
      return {
        title: `grass rect #${ref.index}`,
        rows: [
          ...rectRows(r),
          {
            label: "density",
            value: r.density === undefined ? "default" : n(r.density),
          },
        ],
      };
    }
  }

  // A stale ref — the layout changed under the selection.
  return { title: "", rows: [] };
}
