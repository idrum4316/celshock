/**
 * prefs.ts — What the player picked last time: difficulty, map and loadout.
 * Owns the localStorage round trip for each; owns nothing that applies them
 * (that is `Game.setDifficulty` / `setMap` / `applyLoadout`).
 * Sibling of [`settings.ts`](settings.ts), which does the same job for the
 * display settings and is separate only because those are one flat object
 * behind one screen, where these are four unrelated picks made in three places.
 * Invariants: storage throwing is NEVER fatal — private browsing and `file://`
 * both throw on the first `getItem`, and a forgotten preference is not worth
 * failing a boot over, so every reader falls back to a default.
 * Anything read back that INDEXES a table is validated rather than trusted: the
 * store holds strings the player can edit, and an id that no longer exists
 * would otherwise look up a built model with `undefined`.
 */
import { CONFIG } from "../config";
import {
  DEFAULT_SIGHT,
  isSightId,
  type SightId,
} from "../entities/sights";
import {
  DEFAULT_WEAPON,
  isPrimaryWeaponId,
  type PrimaryWeaponId,
} from "../entities/weapons";
import { DEFAULT_MAP, MAPS, type MapDef } from "../world/maps";

/** Where the chosen enemy-skill tier is remembered between sessions. */
const DIFFICULTY_KEY = "hollowmere.difficulty";
/** …and the chosen map, by `MapDef.id`. */
const MAP_KEY = "hollowmere.map";
/** …and the loadout. Same store, same tolerance for it not working. */
const SIGHT_KEY = "hollowmere.sight";
const WEAPON_KEY = "hollowmere.weapon";

export function readDifficulty(): number {
  try {
    const raw = window.localStorage.getItem(DIFFICULTY_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (Number.isFinite(n)) return n;
  } catch {
    // Private browsing and file:// both throw here. A default is fine.
  }
  return CONFIG.bots.skill.defaultDifficulty;
}

export function writeDifficulty(tier: number): void {
  try {
    window.localStorage.setItem(DIFFICULTY_KEY, String(tier));
  } catch {
    // Not being able to remember the setting is not worth failing over.
  }
}

/**
 * The remembered map, resolved by id against `MAPS`.
 *
 * It MUST return an entry out of that array rather than anything built here.
 * `applySky` skips repainting an 8-megapixel dome — two thousand stars, a
 * galactic band, a stretched halo and two fBm cloud masks — by comparing the
 * environment by OBJECT IDENTITY, so a `MapDef` assembled on the way past
 * fails that test open and repaints the whole sky on every round start. The
 * symptom is a hitch with nothing in the profile to point at it.
 */
export function readMap(): MapDef {
  try {
    const raw = window.localStorage.getItem(MAP_KEY);
    const found = MAPS.find((m) => m.id === raw);
    if (found) return found;
  } catch {
    // As above. An unknown id also lands here, which is the same answer.
  }
  return DEFAULT_MAP;
}

export function writeMap(id: string): void {
  try {
    window.localStorage.setItem(MAP_KEY, id);
  } catch {
    // As above.
  }
}

/**
 * The remembered optic. Validated rather than trusted: the value is a string
 * out of a store the player can edit, and a sight that no longer exists would
 * otherwise index the assembly table with `undefined`.
 */
export function readSight(): SightId {
  try {
    const raw = window.localStorage.getItem(SIGHT_KEY);
    if (raw !== null && isSightId(raw)) return raw;
  } catch {
    // As above.
  }
  return DEFAULT_SIGHT;
}

export function writeSight(id: SightId): void {
  try {
    window.localStorage.setItem(SIGHT_KEY, id);
  } catch {
    // As above.
  }
}

/**
 * The remembered weapon. Validated exactly as the optic is, and for the same
 * reason: it indexes a table of built models. The test is the PRIMARY one, so
 * a store holding "pistol" — which is a real weapon id, just not one the kit
 * offers — falls back to the default rather than putting the sidearm in both
 * hands with nothing to swap to.
 */
export function readWeapon(): PrimaryWeaponId {
  try {
    const raw = window.localStorage.getItem(WEAPON_KEY);
    if (raw !== null && isPrimaryWeaponId(raw)) return raw;
  } catch {
    // As above.
  }
  return DEFAULT_WEAPON;
}

export function writeWeapon(id: PrimaryWeaponId): void {
  try {
    window.localStorage.setItem(WEAPON_KEY, id);
  } catch {
    // As above.
  }
}
