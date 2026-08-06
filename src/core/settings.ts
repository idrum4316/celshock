/**
 * settings.ts — The player's display settings and where they are remembered.
 * Owns the `Settings` shape, its defaults and the localStorage round trip;
 * owns nothing that applies them (that is `Game.applySettings`).
 * Invariants: every field is read INDEPENDENTLY, so a key added later cannot
 * invalidate what an older build stored; storage throwing is never fatal, the
 * same tolerance `readDifficulty` and friends already have in Game.ts.
 */
import { CONFIG } from "../config";

/**
 * One boolean per row on the settings screen.
 *
 * Deliberately flat and all-boolean for now. The screen renders whatever is in
 * its row table, so a non-boolean setting (a slider, an enumeration) means a
 * second control type there rather than a change to this shape — keep that in
 * mind before widening the type: the storage layer below is generic over the
 * keys, not over their types.
 */
export type Settings = {
  /** The frame-rate readout in the HUD's corner. */
  fpsCounter: boolean;
  /** The camera-rotation smear. Off detaches the pass, not just its effect. */
  motionBlur: boolean;
};

/**
 * What a fresh install gets.
 *
 * The blur's default is derived from `CONFIG` rather than restated, so the
 * config stays the single answer to "does this effect ship on" — its own note
 * already documents 0 as the disabled value. The counter is off because it is
 * an instrument, not chrome.
 */
export const SETTING_DEFAULTS: Settings = {
  fpsCounter: false,
  motionBlur: CONFIG.graphics.motionBlur.strength > 0,
};

/** One key per field, so the fields are independent in the store as well. */
const KEY_PREFIX = "hollowmere.setting.";

/**
 * Reads every field on its own, falling back per field.
 *
 * A single JSON blob would have been shorter and is the trap: the settings
 * list is expected to grow, and a blob written by today's build is missing
 * tomorrow's key — which reads back as `undefined` and quietly turns a
 * defaulted-on setting off. Per-key storage means an unknown key is simply
 * absent and takes its default.
 */
export function readSettings(): Settings {
  const out = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(out) as (keyof Settings)[]) {
    const stored = readFlag(key);
    if (stored !== null) out[key] = stored;
  }
  return out;
}

/** Writes every field. Cheap enough to do wholesale on each toggle. */
export function writeSettings(settings: Settings): void {
  for (const key of Object.keys(settings) as (keyof Settings)[]) {
    writeFlag(key, settings[key]);
  }
}

function readFlag(key: keyof Settings): boolean | null {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + key);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // Private browsing and file:// both throw here. Defaults are fine.
  }
  return null;
}

function writeFlag(key: keyof Settings, value: boolean): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + key, value ? "1" : "0");
  } catch {
    // Not being able to remember a setting is not worth failing over.
  }
}
