/**
 * editor/save.ts — Turns the edited layout back into layout.ts and posts it to
 * the dev server.
 * Owns: the raw-source snapshot, the save call, and the dirty accounting.
 *
 * The raw source arrives through Vite's `?raw` import, so the browser holds
 * both the parsed layout and the exact text it was parsed from. All the
 * decisions about what to rewrite happen here, under `npm run typecheck`; the
 * server side is a byte writer that checks the path and little else.
 */
import layoutSource from "../world/hollowmere/layout.ts?raw";
import type { MapLayout } from "../world/layout";
import {
  serializeLayout,
  snapshot,
  validateScan,
  type SerializeError,
} from "./serialize";
import { scanLayout, type Scan } from "./sourceScan";

/** The path the dev-server plugin will accept. Must match vite.config.ts. */
const LAYOUT_PATH = "src/world/hollowmere/layout.ts";

export interface SaveResult {
  ok: boolean;
  message: string;
}

export class LayoutSaver {
  private scan: Scan;
  /**
   * The layout as it was when the editor opened. Every "has this changed?"
   * question is answered against this, which is what lets untouched entries
   * be copied from source rather than regenerated.
   */
  private original: MapLayout;
  private scanError: string | null = null;

  constructor(current: MapLayout) {
    this.scan = scanLayout(layoutSource);
    this.original = snapshot(current);
    try {
      validateScan(this.scan);
    } catch (err) {
      this.scanError = String((err as SerializeError).message ?? err);
    }
  }

  /** Non-null when the source could not be modelled and saving is unsafe. */
  get blocked(): string | null {
    return this.scanError;
  }

  /** The file contents a save would write, without writing them. */
  preview(current: MapLayout): string {
    return serializeLayout(this.scan, this.original, current);
  }

  async save(current: MapLayout): Promise<SaveResult> {
    if (this.scanError) return { ok: false, message: this.scanError };

    let source: string;
    try {
      source = serializeLayout(this.scan, this.original, current);
    } catch (err) {
      return { ok: false, message: String((err as Error).message ?? err) };
    }

    try {
      const res = await fetch("/__layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: LAYOUT_PATH, source }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        return { ok: false, message: data.error ?? `HTTP ${res.status}` };
      }
      // The file on disk is now what we just sent, so subsequent saves must
      // diff against it — otherwise the second save would re-apply the first
      // one's edits on top of stale text.
      this.scan = scanLayout(source);
      this.original = snapshot(current);
      return { ok: true, message: "saved to layout.ts" };
    } catch (err) {
      return { ok: false, message: `dev server unreachable: ${String(err)}` };
    }
  }
}
