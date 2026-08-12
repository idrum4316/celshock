/**
 * config/weapons.ts — the round, and what differs between the guns.
 * Owns: the weapon table (its keys ARE `WeaponId`), the head zone (`combat`),
 * recoil, and the gunfeel dressing. Contract: `docs/weapons.md`.
 * Gotcha: every round in the game is hitscan through the same
 * `CombatSystem.fire`; a weapon's `recoilMult`/`bloomMult`/`yawBias` SCALE
 * `recoil` rather than restating it.
 * Gotcha: `damage` is what a round does CLOSE. Every time-to-kill quoted in
 * this file is the close one — `damageFar` and the two fall-off distances are
 * the rest of the weapon, and on the carbine they decide a 5x cliff whose
 * position has to be re-derived rather than assumed.
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
 * two and gives you one trigger pull at a time to do it with, the carbine
 * spends three rounds on every pull whether or not it needed them, and the
 * LMG is the one that does not have to stop.
 *
 * **Every time-to-kill quoted below is the CLOSE one**, and that is a change
 * of meaning rather than a caveat. `damage` is what a round does at or inside
 * `falloffNear`; past `falloffFar` it does `damageFar`, and between the two it
 * lerps. So a weapon is no longer one number and a cliff at `range` — it is a
 * shape, and the shape is where the choice between these five actually lives.
 * `range` is unchanged and still the hard reach; the ramp sits well inside it,
 * because a round that has stopped hurting is a more interesting fact than a
 * round that has stopped existing.
 *
 * Read down the `damageFar` column and the kit says something it could not say
 * before: the DMR alone is exempt, the LMG loses damage per second and never a
 * round, the carbine's burst stops being a kill at a stated distance, and the
 * SMG falls off hardest and earliest. Two of those are rewards and two are
 * bills, which is the same balance the close figures strike.
 *
 * The time to kill is deliberately close for the three automatics (rifle 4
 * rounds at 8/s = 0.375 s, SMG 6 at 13/s = 0.385 s, LMG 5 at 10/s = 0.4 s).
 * What you are choosing between them is not damage per second — the rifle and
 * the LMG deliver the identical 240 — it is how much of the screen a burst
 * covers, how far away it still means anything, and how long you may keep
 * firing it. The other two step outside that at opposite ends: the DMR is
 * 2 rounds at 3/s = 0.333 s, faster than any of them, and it pays for it with
 * the error budget — a missed rifle round costs 0.125 s and a missed DMR round
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
    /**
     * 22 = 5 shots to kill. The rifle is meant to hold a line across the
     * valley and still does; the fifth round is what that costs.
     */
    damageFar: 22,
    falloffNear: 25,
    falloffFar: 70,
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
    /**
     * Which way this weapon pulls, -1 (hard left) to +1 (hard right).
     *
     * The horizontal kick used to be symmetric noise, which meant every
     * weapon's spray was the same shape and NONE of it could be learned —
     * the only correct response to a random walk is to stop firing. A bias
     * makes the walk drift, so a burst has a direction you can pre-empt, and
     * the six weapons stop being one recoil pattern scaled six ways.
     *
     * It scales the noise rather than adding to it (`Player.tryShot` draws
     * `(rand * (1 - |bias|) + bias)` into `kickDrift`), so the total is still
     * bounded by `yawPerShot` and every ceiling documented for `maxYaw`
     * survives untouched. 0 is bit-for-bit the old behaviour.
     *
     * **The draw is made ONCE per round and read three times** — by the aim
     * (`recoilKick`), by the model's lean and roll (`recoil.kickSide`/
     * `kickRoll`/`kickYaw`) and by the view punch's direction. Drawing it again
     * anywhere would put the weapon leaning one way while the muzzle walked the
     * other, which is the one thing a bias exists to prevent.
     *
     * The rifle is the reference and gets the mildest real bias: a pattern
     * you notice over a magazine, not one you are fighting from round two.
     *
     * **The signs are paired, not scattered.** The rifle, the SMG and the
     * pistol pull right; the carbine and the LMG pull left. So a rifle with
     * the sidearm behind it is one hand to learn across the swap, and the
     * other family is a genuinely different weapon rather than the same one
     * at a different rate — which is the same thing the kit screen's stat
     * chart is trying to say, said in the hands instead.
     */
    yawBias: 0.35,
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
    /**
     * **The number that matters here is 40 m, and it is not in this table.**
     *
     * A burst kills while three rounds make 100, so the weapon's whole
     * proposition — the fight is over on one trigger pull — expires the
     * instant the round drops under 33.4, which on this ramp is **39.6 m**.
     * Past it a landed burst does 99 or less and the follow-up costs the full
     * `burstCycle`: 0.1 s to kill becomes 0.5 s, a 5x cliff crossed in one
     * step. That is the climb argument in this entry's header turned into a
     * distance, and it lands where the header already says the weapon runs
     * out ("a chest that becomes a head at ~25 m and a miss well past it").
     *
     * **Fall-off on a burst weapon quantises, and that is why the ramp is
     * placed rather than chosen.** Every other weapon here degrades a round
     * at a time; this one has all three rounds cross the threshold together,
     * so the ONLY thing these three numbers decide is where the cliff goes.
     * The drop from 34 to 33.4 is 8% of the ramp's fall, so the breakpoint
     * sits just past `falloffNear` almost regardless of `falloffFar` — which
     * means moving `falloffNear` is how you move the cliff, and `damageFar`
     * barely touches it. An earlier version of this entry ran 20 -> 55 and
     * put the cliff at 22.9 m while claiming 55 in this very comment.
     *
     * So: quote the BREAKPOINT when any of these three move, never
     * `falloffFar`, and re-derive it rather than assuming it followed.
     */
    damageFar: 26,
    falloffNear: 35,
    falloffFar: 90,
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
    /**
     * Strong, and left — the opposite family to the rifle. Three rounds in
     * 0.1 s cannot be steered, only pre-aimed, so a weak bias would be
     * indistinguishable from the noise it replaces; the whole value of a
     * pattern on a burst weapon is that you can lead it before the pull.
     */
    yawBias: -0.5,
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
    /**
     * The steepest and earliest fall-off in the kit, and the shortest run to
     * it: 10 is TEN shots to kill, which at 13/s is 0.69 s of a magazine of
     * 34 spent on one man. "Cannot be trusted past the far side of a street"
     * was previously true only of the spread; this is the same sentence said
     * in damage, where a lucky group can't argue with it.
     */
    damageFar: 10,
    falloffNear: 12,
    falloffFar: 40,
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
    /**
     * The strongest in the kit, and the rate is why. Thirteen rounds a second
     * on the smallest per-shot kick is otherwise indistinguishable from
     * noise — the individual kicks are too small and too fast to read one at
     * a time, so only a consistent drift is legible at all. A hard pull is
     * what turns "spray the SMG" into "lead the SMG", which is the only way
     * a weapon at this rate can be skilful rather than lucky.
     */
    yawBias: 0.6,
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
   * (`recoverFraction`); a third of a second later ~1.4 deg of it is still
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
    /**
     * The one weapon here with no fall-off, and the exemption IS the weapon.
     * "Two shots to kill, whatever the range and wherever they land" is the
     * sentence the entry above opens with, and a curve that took the second
     * round to 49 somewhere down the valley would make it a three-shot rifle
     * at exactly the distances it exists to be used at.
     *
     * Stated as `damageFar` equal to `damage` rather than as an absent field,
     * so every weapon carries the same three numbers and the lerp needs no
     * special case: the ramp runs and resolves to 50 at both ends.
     */
    damageFar: 50,
    falloffNear: 40,
    falloffFar: 120,
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
    /**
     * Zero, and it is the one weapon here where that is a decision rather
     * than a default. One shot at a time is not a pattern — there is no
     * second round close enough behind the first for a drift to be learned
     * from — so a bias here would be a fixed error to dial out on every
     * pull, which is a tax and not a skill. `swayMult` 0.7 exists so this
     * weapon's single round goes where it is pointed; a bias would spend it.
     */
    yawBias: 0,
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
   * The LMG: belt-fed, and the only weapon here that does not have to stop.
   *
   * Every other primary is built around its magazine running out. Twenty-four
   * rounds is three seconds of rifle fire, and the fight you are in is decided
   * by whether it ends before that does. This one carries seventy-five, which
   * is fifteen kills and seven and a half seconds of continuous fire, and that
   * is the entire weapon.
   *
   * The arithmetic is deliberately a wash, and it is the reason the magazine
   * can be this big without the weapon being the obvious pick. Sustained output
   * is 240 damage per second — exactly the rifle's, to the round — and the duty
   * cycle is the same to within a percent: the rifle fires 3.0 s and reloads
   * 1.4 (68%), this fires 7.5 s and reloads 3.4 (69%). What differs is not how
   * much it delivers but WHEN it has to stop, and that is worth paying for,
   * because the fight in the middle of a rifle's reload is the fight the rifle
   * loses. Against three men crossing a square, the rifle is a weapon that runs
   * out halfway through the second one.
   *
   * The bill is in the two things a support weapon is bad at, and both are the
   * worst figures in the kit by a distance. It cannot START a fight: 0.55 on
   * the ADS blend and 0.95 s to draw mean anything already aimed in gets its
   * burst off first, and `spreadHip` at 0.115 makes firing it unaimed a way of
   * announcing where you are. And it cannot RECOVER from being caught empty:
   * 3.4 s is more than twice any reload here, in a game with no reserve
   * ammunition and a sidearm that comes up in 0.34 — which is the answer, and
   * is what the second slot is for.
   *
   * `bloomMult` at 0.5 is the one number that is a reward rather than a cost,
   * and it is what makes a long burst worth firing: bloom tops out at 0.015
   * against the rifle's 0.03, so the fortieth round lands where the fourth did.
   * A weapon whose group opened up like the rifle's would have a seventy-five
   * round magazine and nothing to do with it past the first second.
   */
  lmg: {
    name: "Machine Gun",
    short: "LMG",
    /** 24 against 100 HP = 5 shots to kill — the most rounds of anything here. */
    damage: 24,
    /**
     * 21 x 5 = 105, so the belt gun loses damage per second across the valley
     * and never loses a ROUND: five hits kill at 85 m exactly as they do at
     * 5. That is the same reward `bloomMult` 0.5 is — the weapon that does
     * not have to stop is the weapon whose fortieth round still counts — and
     * it is the gentlest curve here on the longest run to it.
     */
    damageFar: 21,
    falloffNear: 30,
    falloffFar: 85,
    /** 5 rounds at 10/s is 0.4 s: the worst ideal TTK of the three automatics,
     *  by a hair, and on purpose. */
    fireRate: 10,
    semiAuto: false,
    burst: 1,
    burstCycle: 0,
    /** Fifteen kills on one belt, against the rifle's six. The weapon. */
    magSize: 75,
    /** A belt box is not a magazine, and this is where it says so. */
    reloadTime: 3.4,
    /** The worst on offer. A machine gun fired from the hip is theatre. */
    spreadHip: 0.115,
    /** Wider than the rifle's 0.006 — honest, not a marksman's. What it has
     *  over the rifle is that this figure barely moves; see `bloomMult`. */
    spreadAds: 0.008,
    /** A full-power round out of a long heavy barrel: further than the rifle,
     *  well short of the DMR's. */
    range: 130,
    /**
     * Mass, and it has to be: at 10 rounds a second the rifle's own kick would
     * be 0.24 rad/s of settled climb. At 0.7 it is 0.168 — the gentlest in the
     * kit, under both the rifle's 0.208 and the SMG's 0.187, which is what
     * makes a long burst a thing you steer rather than a thing you abandon.
     */
    recoilMult: 0.7,
    /**
     * The gentlest bias in the kit beside the DMR's nothing, and it is the
     * same reward `recoilMult` and `bloomMult` are: a burst you steer rather
     * than one you abandon has to be steerable on both axes, and seventy-five
     * rounds of a hard pull is a weapon that ends up pointing at a wall.
     * Left, so it is not simply the rifle held down for longer.
     */
    yawBias: -0.25,
    /** The heart of the weapon — see the header. Half the rifle's ceiling. */
    bloomMult: 0.5,
    /** The slowest thing here into the shoulder. */
    adsSpeedMult: 0.55,
    /** Long, and front-heavy with a box under the receiver: it sits further
     *  out than the rifle or the muzzle fills the frame. */
    hipZ: 0.05,
    hipY: 0,
    /** Heavy, and carried low on a bipod's worth of nose weight. Steadier than
     *  anything but the DMR, which is the trade its own optic pays for. */
    swayMult: 0.75,
    /** Nothing here is slower to get up. Caught with it slung is caught. */
    drawTime: 0.95,
    /** A heavy charge in a long barrel, and (see `Sfx.shoot`, where level
     *  tracks 1/pitch) the loudest report in the kit. */
    sfxPitch: 0.88,
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
    /**
     * 15 is seven shots out of an eight-round magazine, which is the honest
     * end of "across a street, not down the valley" — the range cap says a
     * round stops at 45 m and this says it stopped meaning anything at 35.
     *
     * **`falloffNear` is 15 because 25 x 4 is exactly 100.** The sidearm sits
     * on a knife edge no other weapon here does: it has no headroom at all,
     * so the first centimetre past `falloffNear` costs a whole round and the
     * pistol becomes a five-shot weapon. At 10 that put the four-shot kill
     * inside a hallway; at 15 it covers a room, which is where the second
     * slot's whole case — a loaded weapon in 0.34 s — is actually spent.
     * Anything that moves `damage` off 25 moves this boundary by metres.
     */
    damageFar: 15,
    falloffNear: 15,
    falloffFar: 35,
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
    /**
     * Wrists rather than a shoulder, so a strong pull is honest — and at
     * 5.5/s semi it is trivially corrected between shots, which is what
     * makes a strong number safe here and not on the LMG. Right, with the
     * rifle: the two weapons most loadouts carry together pull the same way.
     */
    yawBias: 0.45,
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
 * What every round does regardless of what fired it: the head zone.
 *
 * **The head zone is on the PLAYER's rounds only, and that gate is load-bearing
 * rather than a difficulty setting.** Bots aim at `t.eyePos` — the same point
 * this zone is centred on — so a head sphere their rounds could find would make
 * every accurate bot shot a headshot and halve a tuned time to kill overnight.
 * `CombatSystem.fire` takes the multiplier from its caller and skips the sphere
 * test entirely below 1, which is also why sixteen bots pay nothing for a
 * feature they do not have.
 */
export const combat = {
  /**
   * Metres about `eyePos`. A bot's eye is 1.55 up, so this spans roughly chin
   * to crown — the head as a ball, which is all a sphere can honestly be.
   *
   * It sits INSIDE the body sphere (`hitRadius` 0.75 about `center`), so it is
   * never a separate candidate in the nearest-hit search — it could not win
   * one. It is an upgrade applied to a body hit that already landed, which is
   * also what makes it one extra sphere test per LANDED round rather than one
   * per target per shot.
   */
  headRadius: 0.22,
  /**
   * What a head hit is worth. At 2 the payoffs are legible without being
   * silly: the rifle and the pistol kill in two, the SMG in three, and the DMR
   * kills in ONE at any range — which is the reward its `semiAuto`, its 2.2
   * recoil multiplier and its exemption from fall-off have all been asking for.
   * It is the only one-shot kill in the game and it costs a scope, a 3/s
   * ceiling and a 22 cm target.
   */
  headshotMult: 2,
} as const;

/**
 * Recoil. Every shot kicks the aim up and slightly sideways and blooms the
 * spread; both settle back on their own between bursts, so tapping stays
 * accurate while holding the trigger walks the shots off target.
 */
export const recoil = {
  /**
   * Aim kick per shot (radians): upward, and left/right about the weapon's
   * bias. Both are the value at the TOP of a string — `pattern` below tapers
   * the first and ramps the second across the rounds that follow, so neither
   * of these numbers is what any particular shot actually kicks.
   *
   * They were 0.026 / 0.011 before the pattern existed, and both moved to keep
   * a magazine's total walk where it was while changing its SHAPE. The
   * vertical is up because the taper takes 20% off every round past the sixth
   * (the arithmetic is in `pattern`); the horizontal is up because a weapon
   * whose kick is 30% sideways at the end of a string is the whole point of
   * the exercise, and 0.011 could not carry that against a bias below 1.
   */
  pitchPerShot: 0.03,
  yawPerShot: 0.018,
  /**
   * What the FIRST round of a string kicks, as a multiple of the rest.
   *
   * A weapon that has been sitting still and one that is mid-burst are not the
   * same weapon, and without this they were: shot 1 and shot 20 kicked
   * identically, so a burst had a flat ramp instead of a punch that settles.
   * The punch is also what makes the first round of a tap distinct from a held
   * trigger, which is the entire reason to tap.
   *
   * It applies only where a string means something — `!semiAuto || burst > 1`,
   * resolved in `Player.recoilRamp`. The DMR and the pistol are strings of one
   * and every shot would be a first shot; their `recoilMult` (2.2 and 1.15)
   * already carries the punch, and 1.6x on top of the DMR's would put 6.0 deg
   * on every deliberate scoped round.
   */
  firstShotMult: 1.6,
  /**
   * Seconds without firing before the string resets and the next round is a
   * first one again. Comfortably longer than any automatic's gap (the LMG's
   * is 0.1 s) and shorter than the carbine's `burstCycle` of 0.4, so a burst
   * weapon gets the punch on the first round of EVERY burst — which is right
   * for three rounds that climb as one motion. The DMR's 0.333 s at full rate
   * sits just inside it, but the DMR is excluded anyway.
   */
  stringResetTime: 0.35,
  /**
   * The SHAPE of a string, as two envelopes over the same shot counter
   * `firstShotMult` reads (`Player.stringShots`). This is what stops a spray
   * being a straight line with jitter on it: the kick's DIRECTION rotates as
   * the string runs, so the pattern is a hook that can be learned rather than
   * a magnitude that can only be pulled against.
   *
   * A muzzle climbs hardest at the start and then binds — the shooter is
   * already leaning into it, and the weapon has nowhere further to rotate — so
   * the vertical tapers off. What replaces it is horizontal: the further into a
   * string, the more of the kick goes sideways about `yawBias`. Both envelopes
   * are 1 and `yawStart` respectively on the FIRST round, so this composes with
   * `firstShotMult` rather than relitigating it — shot one is still the punch
   * that argument describes, and it is now also the straightest round in the
   * magazine.
   *
   * **The two are tuned as a pair to leave the total walk alone**, which is
   * what makes this a change of shape rather than a nerf. For the rifle at the
   * hip (24 rounds, `recoilMult` 1) the per-shot multipliers sum to 20.5 against
   * the 24.6 they summed to when every round kicked the same, and
   * `pitchPerShot` went from 0.026 to 0.03 to pay for exactly that: the
   * permanent share is 0.03 x 0.3 x 20.5 = 0.1845 rad = **10.6 deg**, against
   * the 11.0 deg the flat version walked. Re-derive both figures if any of
   * these four numbers moves — the walk is quoted in `recoverFraction` and in
   * `docs/weapons.md`, and it does not follow on its own.
   */
  pattern: {
    /**
     * Rounds over which both envelopes travel from their first-shot value to
     * their settled one. Seven is a little under a third of the rifle's
     * magazine and a third of the SMG's first second, so the shape is legible
     * inside one burst rather than being a property of a whole magazine.
     */
    patternShots: 7,
    /**
     * What the vertical falls to once the muzzle has bound. Deliberately mild:
     * at 0.65 the late string barely climbs at all and the weapon stops being
     * something you pull down, which is the control the recoil is FOR. 0.8 is
     * enough to be felt as a settle under the horizontal arriving.
     */
    pitchSettled: 0.8,
    /**
     * What the horizontal starts at. Low, because the first rounds of a string
     * going almost straight up is the half of this that makes tapping precise —
     * a tap is a first shot, and a first shot has nowhere sideways to go.
     */
    yawStart: 0.3,
  },
  /** Multiplier while fully aimed down sights — a braced stance kicks less. */
  adsMult: 0.55,
  /**
   * The rest of the stance, on the same footing as `adsMult` and blended the
   * same way. Crouching already bought a tighter group (`player.crouchSpreadMult`)
   * and a steadier hold (`camera.aimSway.crouchMult`) and did nothing at all
   * about the kick, which made kneeling behind a wall a decision about the
   * first round and not about the eighth.
   *
   * The two penalties are the same fact from the other side: recoil is absorbed
   * by a body braced against it, and a body that is walking or in the air is
   * not braced. `airMult` is the harshest number here because a jump is the one
   * stance a player chooses freely and there is nothing under it at all.
   */
  crouchMult: 0.8,
  moveMult: 1.25,
  airMult: 1.5,
  /**
   * Fraction of each kick that springs back on its own. The remainder is
   * pushed into the player's own aim and stays there, so a magazine held
   * down walks the muzzle off target and has to be pulled back by hand. At
   * 1.0 recoil is pure decoration.
   *
   * **The walk is ~10.6 deg of climb and ~2.4 deg of drift for the rifle's 24
   * rounds from the hip**, and it is derived rather than set: the vertical is
   * `pitchPerShot * (1 - recoverFraction) * sum(firstShotMult-and-taper over
   * the magazine)`, which `pattern` works through. It was 11.0 deg and 1.6 deg
   * when every round in a string kicked the same, so what the pattern bought is
   * half again as much sideways for a twentieth less climb. Re-derive both when
   * anything in `pattern`, `pitchPerShot`, `yawPerShot` or `firstShotMult`
   * moves; neither figure follows on its own.
   */
  recoverFraction: 0.7,
  /** How fast the springy part settles back (per second). */
  recovery: 6.5,
  /**
   * Ceilings on the SPRINGY part, so sustained fire can't walk the aim off the
   * screen and a crossfire's flinches can't stack off it either.
   *
   * `maxYaw` moved with `yawPerShot` and had to: a ceiling is only meaningful
   * as a number of rounds, and 0.06 against the new per-shot term would have
   * bound after four rounds of hard drift where it used to take eight. 0.09
   * puts it back at about seven, which is where `pattern.patternShots` has the
   * horizontal reaching full strength anyway. `maxPitch` is untouched — the
   * vertical per-shot term barely moved once the taper is in it, and this
   * ceiling is also what catches a grenade's flinch (`player.flinchPitchPerDamage`).
   */
  maxPitch: 0.17,
  maxYaw: 0.09,
  /**
   * Spread bloom: added per shot, its ceiling, and its bleed-off per second.
   * The bleed-off has to be well under `bloomPerShot * fireRate` (0.048/s
   * here) or holding the trigger never actually blooms.
   */
  bloomPerShot: 0.006,
  maxBloom: 0.03,
  bloomRecovery: 0.02,
  /**
   * The weapon punch on the viewmodel: a DAMPED SPRING the shot gives a
   * velocity to, not a level the shot sets and then fades.
   *
   * It used to be the second thing: `weaponKickT` snapped to 1 and fell
   * linearly, squared on the way out. That has an instant attack and a monotone
   * return with nothing on the other side of neutral — a fade rather than a
   * recoil, and two rounds 77 ms apart simply re-set it to 1, so an automatic
   * looked like one long shot instead of a mechanism cycling. The spring is the
   * same idiom and the same argument as `camera.land` — an impact hands it a
   * VELOCITY and it finds its own way back, which is what puts a rise, an
   * overshoot past neutral and a settle in it. It also accumulates for free: a
   * second round arriving on a weapon that has not come home adds to what is
   * already there, exactly as a second landing does, which is why a held
   * trigger now reads as a weapon that never quite settles, and why the
   * carbine's three rounds in 0.1 s stack to 1.35 where one makes 1.00.
   *
   * **It is NOT the same integrator, and that is the one thing here that must
   * not be copied back from `land`.** That spring is 2 Hz and semi-implicit
   * Euler is fine for it; this one is 6 Hz, where `omega * dt` reaches 1.26 at
   * 30 fps and Euler falls apart. Measured on the Euler version, a single
   * round peaked at 0.08 of its travel at 30 fps, 0.54 at 60 and 0.78 at 120 —
   * recoil growing with the frame rate, which is the failure `recovery`'s true
   * exponential exists to prevent one field up. `Player` steps it in closed
   * form instead and every figure below holds at any frame rate.
   *
   * `Player` owns the spring and `ViewModel` reads it, the same split as the
   * bob phase and the landing dip, and for the same reason: two integrators on
   * one impact drift apart.
   */
  kick: {
    /**
     * The velocity one round hands the spring, in units of `kickBack` per
     * second. The number is large because it is a velocity into a 6 Hz spring
     * and most of it is spent inside 30 ms.
     *
     * **The peak displacement is DERIVED from all three of these, not from this
     * one**: `speed * exp(-z/sqrt(1-z^2) * atan(sqrt(1-z^2)/z)) / (2*PI*frequency)`,
     * which at these numbers is 79 x 0.478 / 37.7 = **1.00**. That is why the
     * distances below can still be read as metres-at-full-kick, exactly as they
     * were under the old envelope. Change the frequency or the damping and the
     * peak moves with them — re-derive it rather than assuming the distances
     * still mean what they say. It went 64 -> 79 when the damping was raised,
     * for that reason and no other: a stiffer return eats more of the impulse
     * before the weapon has got anywhere.
     */
    speed: 79,
    /**
     * Spring frequency (Hz) and damping ratio. 6 Hz puts the peak at 30 ms and
     * takes the visible motion out inside ~120 ms, so a single round is a
     * travel-and-return rather than a strobe, and a rifle at 8/s is nearly home
     * between rounds while an SMG at 13/s is not.
     *
     * **Damping is the bounce, and 0.42 was too much of it.** The ratio of each
     * swing to the last is `exp(-z*PI/sqrt(1-z^2))`, so 0.42 came back THROUGH
     * the carry to -0.22 and then rang again from there — a weapon on a spring
     * rather than a weapon absorbing a shot, and legible as bounce at every
     * fire rate in the kit. 0.65 puts the overshoot at -0.07: enough to settle
     * from the front, which is the half of the cycle the old linear fade could
     * not show at all, and not enough to read as a wobble. Raising the frequency
     * shortens everything and lowers the peak; raising the damping only lowers
     * the peak. Either way `speed` has to follow.
     */
    frequency: 6,
    damping: 0.65,
    /**
     * How much of the weapon's own `recoilMult` reaches the model, as an
     * exponent. **Never use `recoilMult` raw here**: the DMR's 2.2 is a
     * statement about the aim, and applied to a pose in metres it throws the
     * receiver across the frame. At 0.6 the rifle (1.0) is untouched, the DMR
     * moves 1.6x it and the SMG 0.7x — a spread wide enough that the five
     * weapons stop kicking the model identically, which is what they did.
     */
    compress: 0.6,
    /**
     * What is left of the OFF-AXIS terms while fully aimed. The z travel is
     * exempt and stays at full.
     *
     * That split is geometry, not taste. The weapon carries the sight, so
     * anything that rotates or laterally shifts the model while aimed takes the
     * RETICLE off the axis the rounds fly down — which is the reticle lying, the
     * same failure the aimed hold sway is arranged to avoid from the other
     * side. Travel along z moves the sight closer to the eye and leaves the
     * picture centred, so it costs nothing. It is also what a braced shoulder
     * actually does with a rifle: absorbs it straight back and lets it rotate
     * very little.
     */
    adsMult: 0.3,
    /**
     * The closest the fitted sight may come to the camera while the weapon is
     * travelling, in metres. **A floor under the near plane, not a look.**
     *
     * The kick's travel is toward the eye and an aimed sight is already only
     * centimetres from it, so on a magnified optic the two collide: the DMR
     * with the scope drove 4.8 cm of travel into a 7.8 cm stand-off and put the
     * eyepiece 2 cm BEHIND `camera.minZ`, which reads exactly as the scope
     * going inside your head. `ViewModel` scales the aimed travel down to fit
     * `sightDist - this` rather than clamping at it, so the spring keeps its
     * shape and only loses amplitude.
     *
     * **It has to sit well above `CameraSystem`'s `minZ` of 0.05, and the gap
     * is not slack.** The bound is computed on the WEAPON NODE's travel, while
     * what must clear the near plane is the SIGHT — a point offset from that
     * node, which the kick's pitch and roll swing by another ~4 mm. Derived
     * against `minZ` directly, the DMR with the prism still measured 3.8 cm.
     * So this is set from measurement rather than from the arithmetic: at
     * 68 mm the worst combination in the kit (the DMR on the prism, with a
     * burst stacked on it) measures 6.2 cm, and the ten magnified combinations
     * span 6.2-7.4. **Re-measure rather than re-deriving if any of it moves** —
     * the arithmetic under-predicts by about 4 mm.
     *
     * Only the prism and the scope are ever bound by it — the three unmagnified
     * sights stand off far enough that the travel never reaches the limit, so
     * this costs them nothing at all.
     */
    adsClearance: 0.068,
    /**
     * The largest displacement a STRING reaches, as a multiple of one round's
     * peak. The spring accumulates on a weapon that has not come home, so the
     * bound above has to be derived against this rather than against 1 — the
     * carbine's three rounds in 0.1 s reach 1.35, which is the worst in the kit
     * and is where this comes from. Derived for a single round instead, the DMR
     * with the prism cleared at a single shot and clipped through a burst.
     *
     * It only affects the aimed clearance. Nothing scales by it.
     */
    stackPeak: 1.35,
  },
  /**
   * The kick's reach on each axis, at a displacement of 1 (see `kick.speed`).
   * Metres and radians in the CAMERA's frame, like every other viewmodel
   * offset, so they take the zoom compensation with the rest of the pose.
   *
   * `kickBack` carries the longitudinal travel, and it is deliberately the
   * largest of them: in first person the camera cannot move backwards to any
   * visible degree (`camPush` is 3.5 cm along the view axis and reads as a
   * flicker of FOV), so the weapon coming toward the eye and settling IS what
   * recoil travel looks like from inside the head. The lateral three all take
   * the shot's own `kickDrift` — the same signed number `yawBias` shapes and
   * the aim kick is built from — so what the model does and what the muzzle
   * does are one motion rather than two.
   */
  kickBack: 0.065,
  kickPitch: 0.12,
  kickSide: 0.022,
  /**
   * The cant. `rot.z` is SUBTRACTED against the drift, because a positive roll
   * takes the weapon's right flank UP (see `viewmodel.reloadRot`) and a weapon
   * walking right should lean into the direction it is going, not away from it.
   * Flip this with that convention if it is ever flipped.
   */
  kickRoll: 0.05,
  kickYaw: 0.018,
  /**
   * The cosmetic view punch per shot: an FOV spike, a backward camera shove,
   * and a directed nudge on pitch, yaw and roll — all decaying over
   * `punchTime`. Deliberately NOT part of aimPitch/aimYaw: bullets, bots, the
   * aim assist and the motion blur never see it, and it only sells the impact
   * to the eye. Because it decays roughly seven times faster than the aim kick
   * does, it is also what lets the VIEW snap harder than the AIM does.
   *
   * **The three angles are one direction drawn per shot and held, not fresh
   * noise per frame.** They used to be re-rolled every frame, and that is why
   * they had to be tiny: white noise at 8-13 rounds a second overlaps into a
   * buzz that reads as a dirty lens rather than as a weapon going off, and the
   * only defence against it was turning it down until it could not be seen. A
   * single coherent nudge per shot reads as an impact at roughly twice the
   * amplitude, which is where these now sit. `CameraSystem.addPunch` draws the
   * direction — biased upward and toward the shot's own drift, with noise on
   * top, so the punch is visibly the same event as the kick and not a second
   * one happening at the same time.
   *
   * The roll opposes the weapon's `kickRoll` on purpose. Rolling the camera the
   * same way the model rolls cancels the two against each other and tips the
   * whole picture instead; opposed, the weapon reads as twisting in the hands.
   */
  punchTime: 0.09,
  fovPunch: 0.025,
  camPush: 0.035,
  shakePitch: 0.007,
  shakeYaw: 0.006,
  shakeRoll: 0.006,
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
