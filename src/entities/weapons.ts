/**
 * weapons.ts — The weapons the player can carry, as a type and as the resolved
 * numbers everything downstream reads.
 * Owns: the derivation from `CONFIG.weapons[id]` to a `WeaponSetup`. Nothing
 * else may re-read that table — Player, CameraSystem and the loadout screen
 * must agree on what is being carried.
 * Invariants: `WeaponId` is derived from the CONFIG table, so the table is the
 * only place a weapon is declared. Holds no state and no geometry: the models
 * are RifleModel's and SmgModel's, and which one is carried is Game's.
 *
 * The sibling of `sights.ts`, and split from it for the reason the two are
 * separate slots: a weapon decides what the round does, an optic decides what
 * you can see when you send it. Neither reads the other.
 */
import { CONFIG } from "../config";

/**
 * A weapon. Derived from the config table rather than written out, so the two
 * cannot drift and a new weapon is one entry plus one model builder.
 */
export type WeaponId = keyof typeof CONFIG.weapons;

/** In screen order — the loadout row, and what the cycle keys step through. */
export const WEAPON_IDS = Object.keys(CONFIG.weapons) as WeaponId[];

export function isWeaponId(value: string): value is WeaponId {
  return Object.prototype.hasOwnProperty.call(CONFIG.weapons, value);
}

/** The default carry: the weapon the game shipped with. */
export const DEFAULT_WEAPON: WeaponId = "rifle";

/**
 * Everything a carried weapon decides, resolved once when it is picked up.
 *
 * Every field is a plain `number` on purpose. `CONFIG` is `as const`, so the
 * table's own fields are literal types and a `let` holding one cannot be
 * reassigned; resolving through here is what lets the rest of the game treat
 * a weapon's stats as numbers that happen to differ between two weapons.
 */
export interface WeaponSetup {
  id: WeaponId;
  name: string;
  short: string;
  damage: number;
  fireRate: number;
  magSize: number;
  reloadTime: number;
  spreadHip: number;
  spreadAds: number;
  /** Where a round from this weapon stops (m). */
  range: number;
  /** Scales the per-shot aim kick. */
  recoilMult: number;
  /** Scales both the per-shot spread bloom and its ceiling. */
  bloomMult: number;
  /** Multiplier on the ADS blend rate, alongside the fitted optic's own. */
  adsSpeedMult: number;
  /** Hip-pose shift along the camera axis, for a weapon of a different length. */
  hipZ: number;
  sfxPitch: number;
  /** Seconds between rounds — `1 / fireRate`, resolved once. */
  shotInterval: number;
}

/**
 * Resolves a weapon's config entry into the numbers the player and the camera
 * run on. Called when the loadout changes, never per frame.
 */
export function weaponSetup(id: WeaponId): WeaponSetup {
  const w = CONFIG.weapons[id];
  return {
    id,
    name: w.name,
    short: w.short,
    damage: w.damage,
    fireRate: w.fireRate,
    magSize: w.magSize,
    reloadTime: w.reloadTime,
    spreadHip: w.spreadHip,
    spreadAds: w.spreadAds,
    range: w.range,
    recoilMult: w.recoilMult,
    bloomMult: w.bloomMult,
    adsSpeedMult: w.adsSpeedMult,
    hipZ: w.hipZ,
    sfxPitch: w.sfxPitch,
    shotInterval: 1 / w.fireRate,
  };
}
