/**
 * config/weapons.ts — the round, and what differs between the guns.
 * Owns: the weapon table (its keys ARE `WeaponId`), recoil, and the gunfeel
 * dressing. Contract: `docs/weapons.md`.
 * Gotcha: every round in the game is hitscan through the same
 * `CombatSystem.fire`; a weapon's `recoilMult`/`bloomMult` SCALE `recoil`
 * rather than restating it.
 */

/**
 * The weapons the player can carry, and everything that differs between
 * them. The keys ARE the weapon ids — `WeaponId` in `entities/weapons.ts`
 * is derived from this table, so adding a weapon here and a model builder
 * beside `RifleModel` is the whole job.
 *
 * They all fire the same hitscan round through the same `CombatSystem.fire`,
 * and each takes any of the three optics below — an optic is bolted to a
 * rail and every weapon here has one. What separates them is the trade this
 * table spells out: the rifle hits hard enough to kill in four and holds a
 * line across the valley, the SMG empties a bigger magazine half again as
 * fast and cannot be trusted past the far side of a street, the DMR kills in
 * two and gives you one trigger pull at a time to do it with, and the carbine
 * spends three rounds on every pull whether or not it needed them.
 *
 * The time to kill is deliberately close for the two automatics (rifle 4
 * rounds at 8/s = 0.375 s, SMG 6 at 13/s = 0.385 s). What you are choosing
 * between them is not damage per second, it is how much of the screen a
 * burst covers. The other two step outside that at opposite ends: the DMR is
 * 2 rounds at 3/s = 0.333 s, faster than either, and it pays for it with the
 * error budget — a missed rifle round costs 0.125 s and a missed DMR round
 * costs 0.333 — while the carbine's three rounds leave in 0.1 s and cost 0.4 s
 * of nothing at all afterwards.
 *
 * `semiAuto` and `burst` are two different questions and the carbine is what
 * proves it: `semiAuto` asks whether the trigger has to come UP between pulls
 * and `burst` asks what one pull SPENDS. Three of the four answer only the
 * first; the carbine answers both, and nothing here answers `burst` without
 * also answering `semiAuto`, because a burst weapon that fired on a held
 * trigger would be an automatic with a stutter.
 *
 * `recoilMult` and `bloomMult` SCALE `CONFIG.recoil` rather than restating
 * it: the shape of recoil — how much springs back, how fast, where it is
 * capped — belongs to the game, not to the weapon. Bloom is multiplied at
 * its ceiling too, or a weapon that blooms faster would pay nothing for it
 * after the second shot.
 */
export const weapons = {
  rifle: {
    name: "Assault Rifle",
    /** For the magazine caption, where the full name will not fit. */
    short: "Rifle",
    /** 30 per hit against 100 HP = 4 shots to kill. */
    damage: 30,
    /** Rounds per second. */
    fireRate: 8,
    /**
     * Whether the trigger has to be released between pulls. Held fire is
     * the default; see `Player.tryShot`, which owns the latch.
     */
    semiAuto: false,
    /**
     * Rounds one trigger pull spends. 1 is a weapon that fires a round when
     * it is asked to, which is everything here but the carbine — see the
     * table's header for why this is a separate question from `semiAuto`.
     *
     * Above 1 the rounds leave at `fireRate` and the trigger has no say once
     * the first is gone: a burst finishes itself, which is the whole point of
     * one, and `Player.burstLeft` is where that is remembered.
     */
    burst: 1,
    /**
     * Seconds from a burst's LAST round to the earliest next one — the
     * weapon's own dwell, not the finger's. Read only when `burst` > 1, where
     * it replaces `shotInterval` at the end of the burst and is the entire
     * cost of the mode.
     */
    burstCycle: 0,
    magSize: 24,
    reloadTime: 1.4,
    /** Bullet spread half-angle (radians). */
    spreadHip: 0.045,
    spreadAds: 0.006,
    range: 120,
    /** Scales `recoil.pitchPerShot`/`yawPerShot`. */
    recoilMult: 1,
    /** Scales `recoil.bloomPerShot` AND `recoil.maxBloom`. */
    bloomMult: 1,
    /** Multiplies `camera.adsBlendSpeed` alongside the optic's own — a
     *  light weapon comes up faster whatever is bolted to it. */
    adsSpeedMult: 1,
    /**
     * Shifts the hip pose along the camera axis (m, before `viewmodel
     * .scale`). The authored pose in `viewmodel.hipPos` is framed for this
     * weapon's length, so a shorter one has to sit closer or it reads as
     * being held out at arm's length.
     */
    hipZ: 0,
    /**
     * And across it (m, before `viewmodel.scale`). The pose is authored
     * around the reference weapon's BORE, and every long gun here carries
     * most of its bulk above that line — a receiver, an optic, a stock — so
     * the frame is filled by what is over the axis. A pistol is the other
     * way up: almost all of it, and both hands with it, hang below the bore,
     * and at the shared height it falls off the bottom edge and reads as a
     * dark sliver in the corner rather than as something being held.
     */
    hipY: 0,
    /**
     * Scales `camera.aimSway` — how steady this weapon is to hold. Mass and
     * where the hands sit, nothing else: a heavier weapon wanders less and
     * a light one carried high wanders more. The rifle is the reference.
     */
    swayMult: 1,
    /**
     * Seconds from the swap button to this weapon being usable — the whole
     * gesture, since the one being put away is gone by then (see
     * `viewmodel.swap.switchFrac`). It is the INCOMING weapon's number
     * because what the wait is actually about is getting this thing up and
     * on target: the sidearm's whole case is that its figure is the
     * smallest here.
     */
    drawTime: 0.55,
    /** Report pitch, as a multiplier on the shot's own frequencies. */
    sfxPitch: 1,
  },
  /**
   * The carbine: a bullpup firing a mechanical three-round burst, and the one
   * weapon here whose trigger buys a decision rather than a round.
   *
   * Three rounds at 34 is 102 against 100 HP, so a burst that lands is a kill
   * — the whole of it, in the 0.1 s the three take to leave. Nothing else here
   * comes close to that number, and nothing else here is punished for missing
   * the way this is: `burstCycle` is 0.4 s of a weapon that will not fire,
   * whether the burst hit, missed, or hit twice out of three. A carbine that
   * dropped two of the three has done 68, and the 32 that is left costs the
   * full half second — against the rifle's 0.125 s for the same mistake.
   *
   * So the sustained figure is deliberately the worst of the automatics: 3
   * rounds per 0.5 s is 6/s and 204 damage per second, under the rifle's 240
   * and the SMG's 234. What is being sold is not throughput, it is that the
   * fight can be over on one trigger pull if the pull was right — and that
   * the pull is a commitment, because those three rounds are gone whatever
   * happens after the first.
   *
   * `recoilMult` is 0.8 rather than the rifle's 1, and the burst is why: at 20
   * rounds a second there is no recovery between them, so the three climb as
   * one motion — about 2 deg aimed from the first round to the third, which
   * is a chest that becomes a head at ~25 m and a miss well past it. That is
   * the range cap doing its work by hand before the range cap has to.
   */
  carbine: {
    name: "Burst Carbine",
    short: "Carbine",
    /** 34 x 3 = 102 against 100 HP: the burst is the kill, not the round. */
    damage: 34,
    /** WITHIN the burst — 0.05 s a round, so three take 0.1 s. */
    fireRate: 20,
    /** One pull, one burst: the trigger has to come up for the next. */
    semiAuto: true,
    burst: 3,
    /** The bill for the mode, and the only thing holding it in the kit. */
    burstCycle: 0.4,
    /** Seven bursts, so seven kills — one more than the rifle's magazine. */
    magSize: 21,
    reloadTime: 1.45,
    /**
     * The worst hip figure of the three automatics, and consistent with the
     * mode: an unaimed burst does not scatter one round, it scatters three.
     */
    spreadHip: 0.075,
    /**
     * Tighter than the rifle's 0.006 and still twice the DMR's. It has to be
     * tighter: three rounds have to land on one decision, so a group that
     * merely covers a torso is a group that drops one of them.
     */
    spreadAds: 0.0055,
    /**
     * Between the SMG's street and the rifle's valley. Past this the burst's
     * own climb has already taken the third round over the shoulder, so the
     * cap mostly names a limit the weapon reaches on its own.
     */
    range: 90,
    recoilMult: 0.8,
    /** Blooms through the burst and has the whole cycle to bleed it off. */
    bloomMult: 1.15,
    adsSpeedMult: 1.15,
    /** Short overall — a bullpup's barrel is inside its stock. */
    hipZ: -0.05,
    hipY: 0,
    /** Mass sat back over the shoulder: steadier than its length suggests. */
    swayMult: 0.95,
    drawTime: 0.5,
    /** A rifle round out of a short barrel: sharper than the rifle, not thinner
     *  than the SMG. */
    sfxPitch: 1.08,
  },
  /**
   * The SMG: a pistol-calibre burst weapon. Higher rate, bigger magazine,
   * quicker to raise and quicker to reload; a third less damage per round,
   * spread half again as wide aimed and much wider from the hip, and a
   * range cap that runs out well inside the map.
   *
   * The recoil multiplier is the number that keeps it usable — at 13 rounds
   * a second the rifle's own per-shot kick would walk the muzzle off the
   * screen in half a magazine. Even at 0.55 it climbs faster than the rifle
   * does (0.19 rad/s against 0.21 — near enough the same), so the price of
   * the rate is paid in spread rather than in climb.
   */
  smg: {
    name: "Submachine Gun",
    short: "SMG",
    /** 18 against 100 HP = 6 shots to kill. */
    damage: 18,
    fireRate: 13,
    semiAuto: false,
    burst: 1,
    burstCycle: 0,
    magSize: 34,
    reloadTime: 1.15,
    spreadHip: 0.07,
    spreadAds: 0.016,
    /** Past this a round simply stops; the optic on top cannot change it. */
    range: 70,
    recoilMult: 0.55,
    bloomMult: 1.3,
    adsSpeedMult: 1.3,
    hipZ: -0.07,
    hipY: 0,
    /** Light, short, and held high — the liveliest thing in the kit. */
    swayMult: 1.2,
    drawTime: 0.48,
    sfxPitch: 1.35,
  },
  /**
   * The DMR: a semi-automatic marksman rifle. One round per trigger pull,
   * and the round is worth pulling for — 50 against 100 HP is two hits,
   * whatever the range and wherever they land.
   *
   * `semiAuto` is the whole design and not a detail on top of it. The other
   * two are held down and steered; this one is a sequence of decisions, and
   * every number here is chosen against that. The rate is a CEILING rather
   * than a cadence — nothing fires it faster than the trigger finger — so
   * `bloomMult` can be high without punishing the aimed shot it is meant to
   * reward: at any deliberate pace the bloom has bled off before the next
   * round leaves, and only trying to run it as an automatic finds the
   * ceiling. The recoil multiplier is the real cost of the two-shot kill.
   * At 2.2 a shot kicks 3.3 deg and only 70% of that springs back
   * (`recoverFraction`); a third of a second later ~1.2 deg of it is still
   * there, so a follow-up taken at the weapon's full rate goes high unless
   * it is pulled down by hand. Waiting is what makes the second shot land,
   * which is the same trade as the magazine: twelve rounds is six kills,
   * the rifle's, with none of the rifle's forgiveness.
   *
   * Hip spread is the worst on offer, deliberately: a long weapon on a sling
   * is not a close-quarters answer, and the way to say so is to make firing
   * it unaimed useless rather than merely worse.
   */
  dmr: {
    name: "Marksman Rifle",
    short: "DMR",
    /** 50 against 100 HP = 2 shots to kill, at any range it reaches. */
    damage: 50,
    /** A ceiling on the trigger finger, not a cadence — see `semiAuto`. */
    fireRate: 3,
    /** One round per pull. `Player.tryShot` holds the latch. */
    semiAuto: true,
    burst: 1,
    burstCycle: 0,
    magSize: 12,
    reloadTime: 1.9,
    spreadHip: 0.09,
    /** 0.14 deg aimed: the tightest group in the kit, by a factor of two. */
    spreadAds: 0.0025,
    /**
     * Past the fog wall (78 m) there is nothing to shoot at that you can
     * see, so this mostly buys the open lanes down the valley and the line
     * on the stat chart. It is still the honest number for the round: the
     * other two stop short of what their optics can pick out, and this one
     * does not.
     */
    range: 180,
    recoilMult: 2.2,
    bloomMult: 1.5,
    adsSpeedMult: 0.7,
    /** Longer than the rifle, so it sits further out or the muzzle fills the
     *  frame — the SMG's offset, in the other direction. */
    hipZ: 0.06,
    hipY: 0,
    /**
     * The steadiest weapon here, and it has to be. Sway is angular, so the
     * scope this weapon exists to carry magnifies it 3.5x; at the rifle's
     * figure the shot the DMR is for — one deliberate round at range —
     * would be a matter of timing the wander rather than of aiming. Mass
     * and a cheek on the comb are the excuse, the two-shot kill is the
     * reason. Crouched with a scope this is ~0.13 deg.
     */
    swayMult: 0.7,
    /** The heaviest thing here, and the slowest into the shoulder. */
    drawTime: 0.72,
    /** A heavier charge in a longer barrel: lower, and (see `Sfx.shoot`,
     *  where level tracks 1/pitch) louder, because it fires far less often. */
    sfxPitch: 0.82,
  },
  /**
   * The sidearm. Not a kit choice — every loadout carries it, and `Q` (pad Y)
   * swaps to it — which is why it is last in this table and why
   * `PRIMARY_WEAPON_IDS` exists to keep it off the loadout screen.
   *
   * It is deliberately the worst weapon here at everything except getting
   * into your hands. Four rounds to kill at 5.5/s semi is a 0.545 s ideal
   * time to kill, half again the rifle's, and it runs out of range inside the
   * width of the village. What it buys is `drawTime` 0.34 against the rifle's
   * 0.55 and an `adsSpeedMult` of 1.6: a magazine that runs dry mid-fight is
   * a third of a second from a loaded weapon instead of the 1.4 s a reload
   * costs, and that trade — not damage — is the entire reason to pull it.
   *
   * `semiAuto` is what stops it competing with the SMG: eight rounds at the
   * trigger finger's pace is a weapon you finish a fight with, not one you
   * start one with.
   */
  pistol: {
    name: "Sidearm",
    short: "Pistol",
    /** 25 against 100 HP = 4 shots to kill. */
    damage: 25,
    /** A ceiling on the trigger finger, as on the DMR. */
    fireRate: 5.5,
    semiAuto: true,
    burst: 1,
    burstCycle: 0,
    /** Seven in the magazine and one up the spout. */
    magSize: 8,
    reloadTime: 1.05,
    spreadHip: 0.055,
    spreadAds: 0.014,
    /** A pistol's honest reach: across a street, not down the valley. */
    range: 45,
    recoilMult: 1.15,
    bloomMult: 1.7,
    /** Nothing else here comes up this fast. */
    adsSpeedMult: 1.6,
    /** The shortest weapon in the game, so it sits closest to the eye. */
    hipZ: -0.12,
    /** Held up into the frame — see the field's note on the rifle. */
    hipY: 0.09,
    /** Light, and held out on the arms rather than braced on a shoulder. */
    swayMult: 1.45,
    /** The number the whole weapon exists for. */
    drawTime: 0.34,
    sfxPitch: 1.12,
  },
} as const;

/**
 * Recoil. Every shot kicks the aim up and slightly sideways and blooms the
 * spread; both settle back on their own between bursts, so tapping stays
 * accurate while holding the trigger walks the shots off target.
 */
export const recoil = {
  /** Aim kick per shot (radians): upward, and random left/right. */
  pitchPerShot: 0.026,
  yawPerShot: 0.011,
  /** Multiplier while fully aimed down sights — a braced stance kicks less. */
  adsMult: 0.55,
  /**
   * Fraction of each kick that springs back on its own. The remainder is
   * pushed into the player's own aim and stays there, so a magazine held
   * down walks the muzzle off target (~11 deg from the hip) and has to be
   * pulled back by hand. At 1.0 recoil is pure decoration.
   */
  recoverFraction: 0.7,
  /** How fast the springy part settles back (per second). */
  recovery: 6.5,
  /** Ceilings, so sustained fire can't walk the aim off the screen. */
  maxPitch: 0.17,
  maxYaw: 0.06,
  /**
   * Spread bloom: added per shot, its ceiling, and its bleed-off per second.
   * The bleed-off has to be well under `bloomPerShot * fireRate` (0.048/s
   * here) or holding the trigger never actually blooms.
   */
  bloomPerShot: 0.006,
  maxBloom: 0.03,
  bloomRecovery: 0.02,
  /** Weapon punch on the viewmodel: recovery time (s), slide (m), pitch (rad). */
  kickTime: 0.11,
  kickBack: 0.05,
  kickPitch: 0.12,
  /**
   * Cosmetic view punch per shot: an FOV spike, a backward camera shove,
   * and a fast random jitter, all decaying over punchTime. Deliberately NOT
   * part of aimPitch/aimYaw — bullets never see it; it only sells impact to
   * the eye. Kept small: at 8 rps the peaks overlap into a constant buzz.
   */
  punchTime: 0.09,
  fovPunch: 0.025,
  camPush: 0.035,
  shakePitch: 0.004,
  shakeYaw: 0.003,
} as const;

/**
 * Gunfeel dressing: the visible muzzle flash mesh and ejected brass.
 * Player-only — bots get neither (their flashes are the budgeted light
 * pulses, and 16 bots' worth of casing meshes is draw-call noise nobody
 * can see anyway).
 */
export const gunfeel = {
  /** Seconds the muzzle flash mesh stays visible per shot. */
  flashTime: 0.05,
  /**
   * Ejected brass: pool size, lifetime (s), launch speeds (m/s), gravity.
   *
   * The pool has to cover the fastest weapon's rate over one casing's
   * lifetime — 13/s x 0.9 s is 11.7 — or a held trigger runs it dry and the
   * brass simply stops coming out halfway through the magazine.
   */
  casingPool: 16,
  casingLife: 0.9,
  casingGravity: 12,
  casingEject: 1.8,
  casingUp: 2.6,
} as const;
