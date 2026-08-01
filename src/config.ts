/**
 * config.ts — Central game configuration (`CONFIG`, `as const`).
 * Owns: ALL gameplay/balance tunables. No gameplay magic numbers elsewhere;
 * art/geometry constants stay in their model file.
 * Gotcha: `as const` gives fields literal types — `let x = CONFIG.bots.x` then
 * reassigning fails to compile. Annotate `let x: number` instead.
 * Keep the per-value comments: they record why a number is what it is.
 */
export const CONFIG = {
  /** Conquest round rules. */
  conquest: {
    /**
     * Starting reinforcements per team. Sized against the drain below for a
     * round of roughly 12-15 minutes; deaths dominate the rate, so this is the
     * number most worth revisiting after real playtesting.
     */
    tickets: 400,
    /** Cost of one death. */
    ticketsPerDeath: 1,
    /** How often the flag-deficit bleed is applied (seconds). */
    bleedInterval: 3,
    /**
     * Tickets lost per interval, per flag the losing team is behind by: 20/min
     * when one flag down, 60/min when three down. Steep enough that ignoring
     * objectives loses the round, shallow enough that one bad push doesn't.
     */
    bleedPerFlagDeficit: 1,
    /** Radius of a control point's capture zone (metres). */
    captureRadius: 12,
    /**
     * Capture meter runs -1 (team 0 owns) .. +1 (team 1 owns) and moves at
     * this rate per second with one attacker present. Crossing 0 neutralizes,
     * so a flag must be swept through neutral before it flips.
     */
    captureRate: 0.07,
    /**
     * Extra capture rate per additional body, with diminishing returns — the
     * Nth attacker adds `captureRate * crowdFalloff^(N-1)`.
     */
    crowdFalloff: 0.55,
    /** Cap on the crowd bonus, so a whole squad can't instantly flip a flag. */
    maxCaptureMult: 2.6,
    /** Seconds between death and being allowed to redeploy. */
    respawnDelay: 8,
  },

  /** Bot roster, AI cadence, and the render LOD that makes 16 of them viable. */
  bots: {
    /** Per team. The rig pool is sized to exactly `perTeam * 2`. */
    perTeam: 8,
    squadSize: 4,
    maxHealth: 100,
    /** Roughly the player's jog; the advancing sprint stays under theirs. */
    moveSpeed: 4.4,
    /** Sprint multiplier while advancing with no target. */
    advanceSprintMult: 1.35,
    /**
     * Full AI (target selection, LOS raycast, objective re-evaluation) runs at
     * this rate per bot, round-robin across frames. Movement still integrates
     * every frame. At 5 Hz with 16 bots that is ~1.3 ray picks per frame.
     */
    thinkRate: 5,
    /** 25 per hit against 100 HP = 4 shots to kill, matching the player. */
    damage: 25,
    fireRate: 5.5,
    /**
     * Aim error half-angle (radians), lerped by distance / `engageRange`.
     *
     * These read as very loose, but the miss radius is `angle * distance`
     * against a 0.75 m target sphere, so the hit rate falls off quadratically:
     * near-certain inside 20 m, about half at 30 m, roughly one in ten at 55 m.
     * Tightening them makes bots snipe across the square with no counterplay.
     */
    spreadNear: 0.02,
    spreadFar: 0.045,
    /**
     * Most line-of-sight rays one target-acquisition tick may spend.
     *
     * Candidates are ray-tested nearest-first and the first visible one wins,
     * so the common case is a single ray. But a bot in the middle of a crowded
     * fight can have nine enemies in range with the nearest few behind cover,
     * and testing all of them is exactly the "thousands of picks a second"
     * blow-up the acquisition code was written to avoid. Missing a distant
     * enemy for one 200 ms tick is not a behaviour anyone can see.
     */
    acquireRayBudget: 3,
    /** Bots will not open fire beyond this distance. */
    engageRange: 55,
    /** Below this, a bot backs off toward cover instead of closing. */
    minEngageRange: 6,
    /** Separation distance for the crowd-avoidance pass. */
    separation: 1.5,
    /**
     * Unstick watchdog. A bot that wants to move but covers less than
     * `stuckFraction` of its intended step for `stuckTime` seconds is grinding
     * on something its flow field cannot see — a scattered tree, a squadmate
     * pinning it to a wall — so it sidesteps for `detourTime` before trying the
     * direct line again. Without this a bot whose objective lies dead behind a
     * tree trunk pushes into the trunk forever: the push-out is exactly
     * opposite its steering, so there is no tangential motion to break the tie.
     */
    stuckTime: 0.5,
    stuckFraction: 0.35,
    detourTime: 1.0,
    /** How far to the side the watchdog looks when choosing a way round. */
    detourProbe: 1.6,
    /** Distance past which the pose is frozen (still translates). */
    lodFreezeDistance: 35,
    /** Distance past which outlines are dropped. */
    lodOutlineDistance: 20,

    /**
     * Fire discipline. Everything here is the same for every bot; anything that
     * should separate an ace from a rookie lives in `skill` below.
     */
    combat: {
      /**
       * Rounds before a reload. Matched to the player's magazine so the rhythm
       * of a firefight is symmetrical — and so the gap is a window the player
       * can learn to push into, which is the whole point of bots reloading at
       * all. Before this they had infinite ammo and only the burst pause.
       */
      magSize: 24,
      /**
       * Consecutive shots that hit geometry with no target found before the bot
       * concludes it has lost line of sight and drops the target.
       *
       * Not one: at these spread angles a wide round hitting the wall behind a
       * live target is ordinary, so a single blocked shot proves nothing. Three
       * in a row does, and it costs no rays at all — `CombatSystem.fire` already
       * pays for a wall pick per shot and the result was being thrown away.
       * This is what stops a bot shooting through a wall for a whole think
       * interval after the player breaks contact.
       */
      losBrokenShots: 3,
      /**
       * How long a hit disrupts a bot's aim, and how far off target it throws
       * the aim point (metres, at the target). There is no flinch *pose* — the
       * rig has 7 joints and 4 animation parameters — so "got hit" reads as a
       * yaw snap toward the shooter plus a brief aim disruption, and that is
       * the whole honest vocabulary for it.
       */
      flinchTime: 0.35,
      flinchKick: 1.2,
      /**
       * Yaw slew multiplier while turning toward a shot the bot did not see
       * coming. Fast, but not instant: snapping is what makes an aimbot read as
       * an aimbot.
       */
      flinchTurnMult: 2.5,
      /**
       * Seconds a damage bearing stays worth acting on. Longer than a firefight
       * exchange, shorter than a walk across the map.
       */
      threatMemory: 6,
      /**
       * Widening of the vision cone (radians, added to the half-angle) while a
       * threat cue is live. A soldier who has just been shot at is looking
       * harder than one on a quiet street.
       */
      alertFovBonus: 0.35,
    },

    /**
     * What a bot notices without seeing it. All of this is free of raycasts by
     * construction — hearing is a distance compare, damage direction and near
     * misses ride results the combat system already computes. A bot that has to
     * *look* to perceive is a bot that costs rays, and the LOS budget is the
     * one thing that does not scale here.
     */
    perception: {
      /**
       * How far a gunshot is noticed. Deliberately under `audio.maxDistance`
       * (70) so bots do not hear everything the player can — a bot reacting to
       * a firefight it has no business knowing about reads as cheating, and
       * the whole point of this is to make their knowledge legible.
       */
      hearRange: 45,
      /**
       * Metres of error on a heard position, so bots converge on the *sound*
       * rather than teleport their attention onto the exact shooter. Without
       * it, hearing is indistinguishable from wallhacks.
       */
      hearJitter: 4,
      /**
       * A friendly's gunfire is a weaker cue than an enemy's — it says "the
       * fight is over there", not "someone is shooting at me". This is quietly
       * how a squad converges on contact without any explicit coordination.
       */
      friendlyHearMult: 0.45,
      /**
       * Perpendicular distance within which a passing round counts as a near
       * miss. Roughly an arm's length: close enough to hear crack past.
       */
      suppressRadius: 1.2,
      /** Arousal added per near miss, and how fast both scalars bleed off. */
      suppressPerMiss: 0.4,
      suppressDecay: 0.5,
      alertDecay: 0.3,
      /**
       * How close a hunting bot has to get to a remembered position before it
       * counts as searched, and how long it sweeps there before giving up.
       */
      huntArriveRadius: 3.5,
      huntSweepTime: 2.5,
      /** Speed multiplier while hunting — a search is a walk, not a charge. */
      huntSpeedMult: 0.75,
    },

    /**
     * Cover. Baked once at map load into a per-surface direction mask; see
     * `src/world/CoverMap.ts` for why it is baked rather than probed.
     */
    cover: {
      /**
       * How far along a bearing the bake looks for something to hide behind.
       * Roughly three nav cells: far enough to find the wall of the building
       * you are standing beside, short enough that "cover" still means cover
       * *here* rather than somewhere down the street.
       */
      probeDistance: 4.5,
      /**
       * Height that actually stops a round — and this is the number people get
       * wrong. Line of sight is tested from the eyes at 1.55 m, but hits are
       * tested against the body sphere, whose top is `center.y + hitRadius` =
       * 0.9 + 0.75 = 1.65 m. Bake cover at eye height and a bot behind a 1.6 m
       * wall is *visible but unhittable*: the player sees a head, fires, and
       * the rounds vanish into the wall pick. 1.7 clears the sphere.
       */
      hardHeight: 1.7,
      /**
       * Knee height. Marks geometry worth walking along rather than across open
       * ground — and nothing more. The bot rig has no knees, so there is no
       * crouch, and a bot behind a waist-high wall is exactly as shootable as
       * one in the open. Never treat this as protection.
       */
      softHeight: 0.9,
      /**
       * How far above a standing surface a box may be footed and still count.
       * Above this it is a lintel or a hayloft and the round passes underneath.
       */
      footTolerance: 0.4,
      /** How far a bot will go looking for a covered spot. */
      searchRadius: 7,
      /** Close enough to a chosen cover spot to count as arrived. */
      arriveRadius: 1.2,
      /**
       * How far a bot leans out from its anchor to shoot, and how long each
       * half of the peek cycle lasts.
       *
       * The peek is what makes cover *readable*: a bot that reaches a corner
       * and stays there is simply harder to kill, which is the wrong kind of
       * difficulty. Stepping out to fire and pulling back gives the player a
       * rhythm to shoot into. `outTime` is skill-scaled — aces expose
       * themselves briefly, rookies stand there too long and get shot for it.
       */
      peekOffset: 1.3,
      peekInTime: 0.9,
      /**
       * Suppression above this pins a bot at its cover instead of letting it
       * keep trading, and below this it stops being pinned. Two thresholds
       * rather than one, or a bot on the boundary flickers.
       */
      suppressEnter: 0.7,
      suppressExit: 0.35,
      /**
       * How long the stuck watchdog may fire before a bot gives up on a cover
       * spot it cannot reach and goes back to fighting where it stands.
       */
      abandonTime: 1.5,
      /**
       * After giving up on a spot, how long before the bot considers cover
       * again. Without this the abandon is pointless: the next think re-runs
       * the search, gets the same unreachable corner back, and the bot spends
       * the round walking into a wall instead of fighting.
       */
      retryDelay: 4,
    },

    /**
     * Minimum seconds in a state before the bot is allowed to drop to a
     * lower-priority one. Transitions *up* the priority order are always
     * allowed, so nothing here can delay a reaction to being shot at.
     *
     * This exists because the transition table is stateless and re-derived at
     * `thinkRate`: without a floor, a bot on the edge of two conditions flips
     * between them every 200 ms and vibrates in place instead of committing.
     */
    stateDwell: {
      advance: 0,
      capture: 0.4,
      engage: 0.3,
      hunt: 1.2,
      retreat: 1.5,
      /**
       * Long enough to actually commit to reaching the corner. This is the
       * difference between a bot that peeked deliberately and one that twitched
       * back the instant line of sight reopened.
       */
      takeCover: 0.8,
      suppressed: 0.6,
    },

    /**
     * Per-bot skill. Every bot carries a `skill` in 0..1 and reads its concrete
     * numbers from a lerp between these two ends, so a firefight has aces and
     * rookies rather than sixteen identical shooters.
     *
     * Ends, not a single value plus a variance, because the interesting tuning
     * question is always "what does the worst one do" and "what does the best
     * one do" — a mean tells you neither.
     */
    skill: {
      /**
       * What every bot uses until per-squad assignment lands.
       *
       * Not 0.5: the bands are centred on "a spread of soldiers", not on the
       * old flat constants, and a mid-table draw lands measurably *worse* than
       * the pre-skill bot (a wider cone, a slower trigger, a shorter burst).
       * 0.65 puts reaction, spread and burst back on the old numbers, so the
       * only deliberate lethality changes are the ones with counterplay
       * attached — the reload window and the lagging aim point.
       */
      defaultSkill: 0.65,
      /**
       * Difficulty tiers. Each slides the centre of the skill distribution;
       * `spread` is the half-width of the band a squad is drawn from and stays
       * constant, so **every** tier still contains aces and rookies. That is
       * deliberate — a difficulty that only moves a mean produces sixteen
       * identical shooters who are all slightly better, which is exactly the
       * uniformity this whole system exists to break.
       *
       * Skill is drawn per *squad*, with a small jitter inside it: an elite
       * squad and a green squad is something a player can read and respond to,
       * where salt-and-pepper skill inside a squad just reads as noise.
       */
      difficulties: [
        { name: "Recruit", centre: 0.25 },
        { name: "Regular", centre: 0.5 },
        { name: "Veteran", centre: 0.75 },
        { name: "Elite", centre: 0.95 },
      ],
      /** Default tier index — `Regular`. */
      defaultDifficulty: 1,
      /** Half-width of the band a squad's centre is drawn from. */
      squadSpread: 0.2,
      /** Half-width of the per-bot jitter inside its squad's centre. */
      botSpread: 0.12,
      /**
       * Seed for the skill draw. Seeded rather than `Math.random()` for the
       * same reason world-building is: a round has to be reproducible, or
       * tuning seven stages of new behaviour against it is guesswork.
       */
      seed: 0x5eed,
      /** Seconds between acquiring a target and the first shot. */
      reactionTime: { rookie: 0.55, ace: 0.18 },
      /**
       * Fraction of the reaction time still owed when a bot re-acquires an
       * enemy it was already tracking.
       *
       * This exists because losing sight of a target has to null it, and a
       * null-then-reacquire reads as a target *change*, which resets the
       * wind-up — the exact failure that once made bots never fire at all. An
       * ace keeps most of its wind-up across a lost second and punishes your
       * second peek much faster than your first; a rookie starts over.
       */
      reacquireCredit: { rookie: 0.85, ace: 0.3 },
      /** Multiplies `spreadNear`/`spreadFar`. */
      spreadMult: { rookie: 1.6, ace: 0.7 },
      /**
       * How fast the aim point chases the target, per second.
       *
       * The most important number here. Bots used to aim at the target's exact
       * eye position on every shot, so a strafing player was hit at the same
       * rate as a stationary one and lateral movement bought nothing. A lagging
       * aim point makes movement work, and makes an ace feel *different* from a
       * rookie rather than merely luckier.
       */
      trackRate: { rookie: 4, ace: 14 },
      /** Yaw slew, per second. Replaces a hardcoded `dt * 8`. */
      turnRate: { rookie: 4.5, ace: 11 },
      /** Rounds per burst, and the pause between bursts. */
      burstSize: { rookie: 3, ace: 6 },
      burstPause: { rookie: 1.3, ace: 0.6 },
      /** Seconds spent reloading, once the magazine runs dry. */
      reloadTime: { rookie: 2.8, ace: 1.7 },
      /**
       * Half-angle of the vision cone, radians. 0.85 is a ~97 deg cone, 1.15 a
       * ~132 deg one — a useful human field of view, against the 360 deg
       * omniscience bots had before, where one with its back turned acquired
       * you the instant you rounded a corner.
       *
       * This only gates *initial* acquisition: a bot faces its target once it
       * has one, so a tracked enemy never falls out of the cone. That is the
       * intended behaviour — you can flank an unaware bot, not a fighting one.
       */
      fov: { rookie: 0.85, ace: 1.15 },
      /**
       * Inside this, an enemy is noticed regardless of facing. Nobody misses
       * someone at arm's length, and without it a bot can be knifed by an enemy
       * standing on its toes.
       */
      peripheralRange: { rookie: 5, ace: 9 },
      /**
       * Health fraction below which a bot under fire breaks contact instead of
       * trading. Aces disengage while they still can; rookies die in place.
       */
      retreatHealthFrac: { rookie: 0.2, ace: 0.45 },
      /**
       * How readily a bot breaks for cover rather than standing and trading.
       * Below `coverUseThreshold` it simply never does — which is the most
       * legible skill tell available: rookies fight in the open and die there,
       * where an ace is behind the corner before the second burst lands.
       */
      coverUse: { rookie: 0.1, ace: 1.0 },
      /**
       * Below this `coverUse`, a bot never breaks for cover at all. A hard
       * floor rather than a probability so the difference is *legible*: the
       * worst bots visibly fight in the open, every time, instead of doing it
       * a bit less often than the good ones.
       */
      coverUseThreshold: 0.3,
      /** Seconds a bot stays leaned out shooting before pulling back in. */
      peekOutTime: { rookie: 1.5, ace: 0.55 },
    },
  },

  /** Navigation grid covering the whole map. */
  nav: {
    /** Cell size in metres. 1.5 over a 240 m map gives a 160x160 grid. */
    cellSize: 1.5,
    /**
     * Half-width of a bot's body, used by `ObstacleField` to hold it off
     * collider faces. The rig's shoulders span ~0.35 m either side, so this is
     * a body plus a little air. Raising it past ~0.7 makes the narrowest
     * authored doorway (1.6 m, the cottages) impassable.
     */
    bodyRadius: 0.4,
    /** Max step-up a bot can walk over without a ramp. */
    stepHeight: 0.6,
  },

  /** Map extents. The village is authored inside this square, centred on origin. */
  map: {
    size: 240,
  },

  player: {
    maxHealth: 100,
    /**
     * Realistic infantry pace: a loaded combat jog is ~4 m/s. The original
     * 8 m/s read as a full sprint and made the village feel small.
     */
    moveSpeed: 4.6,
    /** Movement speed multiplier while aiming down sights. */
    adsMoveMult: 0.55,
    /**
     * Sprint multiplier: 6.9 m/s, an honest loaded sprint. Crossing the
     * 240 m map takes ~35 s at it (vs ~52 s jogging), so this stays
     * traversal necessity rather than a feature. Firing is blocked while
     * sprinting.
     */
    sprintMult: 1.5,
    jumpVelocity: 8.5,
    gravity: 22.0,
    height: 1.8,
    radius: 0.45,
    /**
     * Health regeneration, Battlefield-style: none for `regenDelay` seconds
     * after taking a hit, then `regenRate` per second back to full.
     *
     * Not optional. With sixteen hostile bots and no medics, a 100 HP pool that
     * never refills means a player who wins a fight is left too weak to take
     * the next one, and the round becomes a respawn queue.
     */
    regenDelay: 5,
    regenRate: 18,
    /**
     * Downward ground probe. Replaces the old flat-plane clamp so the chapel
     * terrace, barn ramp, and footbridges are standable.
     */
    groundProbeLength: 3.0,
    /** Largest rise the probe will snap up onto without a jump. */
    stepHeight: 0.6,
  },

  weapon: {
    /** 30 per hit against 100 HP = 4 shots to kill. */
    damage: 30,
    /** Rounds per second (full auto). */
    fireRate: 8,
    magSize: 24,
    reloadTime: 1.4,
    /** Bullet spread half-angle (radians). */
    spreadHip: 0.045,
    spreadAds: 0.006,
    range: 120,
  },

  /**
   * Recoil. Every shot kicks the aim up and slightly sideways and blooms the
   * spread; both settle back on their own between bursts, so tapping stays
   * accurate while holding the trigger walks the shots off target.
   */
  recoil: {
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
    /** Third-person weapon punch: recovery time (s), slide (m), pitch (rad). */
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
  },

  /**
   * Gunfeel dressing: the visible muzzle flash mesh and ejected brass.
   * Player-only — bots get neither (their flashes are the budgeted light
   * pulses, and 16 bots' worth of casing meshes is draw-call noise nobody
   * can see anyway).
   */
  gunfeel: {
    /** Seconds the muzzle flash mesh stays visible per shot. */
    flashTime: 0.05,
    /** Ejected brass: pool size, lifetime (s), launch speeds (m/s), gravity. */
    casingPool: 12,
    casingLife: 0.9,
    casingGravity: 12,
    casingEject: 1.8,
    casingUp: 2.6,
  },

  camera: {
    /** Mouse sensitivity (radians per pixel). */
    sensX: 0.0022,
    sensY: 0.002,
    /** ADS mouse sensitivity multiplier. */
    adsMouseMult: 0.6,
    /** Gamepad look speed (radians per second at full deflection). */
    stickSensX: 2.8,
    stickSensY: 1.8,
    adsStickMult: 0.5,
    /**
     * Third-person over-the-shoulder framing (hip fire). Tuned so the
     * character fills roughly half the frame height: ~3.3 m back at chest
     * height puts head-to-feet at ~0.52 rad against fovHip 0.95.
     * NOTE: pivotHeight is relative to the player capsule CENTER (~0.9 m
     * above ground), so 0.55 puts the pivot at ~1.45 m — chest height.
     */
    thirdPersonDistance: 3.3,
    shoulderOffset: 0.65,
    pivotHeight: 0.55,
    /** ADS framing: the shoulder cam pulls in and recentres over the
     *  shoulder rather than going first-person. */
    adsDistance: 2.0,
    adsShoulderOffset: 0.45,
    /** Eye height — bot line-of-sight checks against the player use this. */
    eyeHeight: 1.55,
    fovHip: 0.95,
    fovAds: 0.62,
    /** How fast the hip<->ADS blend converges (per second). */
    adsBlendSpeed: 10,
    pitchMin: -0.95,
    pitchMax: 1.25,
  },

  /**
   * Controller aim assist: a slowdown bubble around enemies plus a gentle
   * rotational pull toward the acquired target.
   *
   * Gamepad only by construction — it engages solely while the pad is the
   * active look device (last stick movement or any pad button; any mouse
   * movement disengages it the same frame), and the slowdown multiplies the
   * stick terms in CameraSystem exclusively. The mouse look path is never
   * scaled, so keyboard/mouse aim is bit-for-bit unaffected, even with a
   * pad plugged in.
   */
  aimAssist: {
    /** No acquisition beyond this distance (metres). */
    maxDistance: 60,
    /**
     * Half-angle of the acquisition cone around the crosshair (radians).
     * The live enemy nearest the crosshair inside it wins. 0.08 ≈ 4.6° —
     * a bot's chest subtends ~0.025 rad at 30 m, so this is "on or very
     * near target", not "anywhere on screen".
     */
    acquireAngle: 0.08,
    /** Stick sensitivity multiplier while a target is acquired. */
    slowdownMult: 0.5,
    /**
     * Rotational pull toward the target, radians per second. ADS gets the
     * full pull; hip-fire gets the weaker pull and only while firing or
     * pushing the right stick, so a resting hip camera never drifts.
     * rotateAdsSpeed may safely exceed the slowed ADS stick rate
     * (stickSens * adsStickMult * slowdownMult) — AimAssistSystem cancels
     * the pull in proportion to opposing stick deflection, so the player
     * can always break free with a committed push.
     */
    rotateAdsSpeed: 1.1,
    rotateHipSpeed: 0.45,
    /** Vertical pull scales by this — gentler than horizontal tracking. */
    verticalMult: 0.7,
  },

  input: {
    deadzone: 0.18,
    triggerThreshold: 0.35,
  },

  /**
   * Gamepad haptics (GamepadHapticsActuator "dual-rumble"). Magnitudes are
   * 0..1, durations in ms. Unsupported pads/browsers silently no-op. Per-shot
   * pulses are kept light and short so full-auto reads as a buzz; each new
   * pulse preempts the previous one rather than queueing.
   */
  rumble: {
    enabled: true,
    /** Per shot fired: light tick on the weak (high-frequency) motor. */
    shotWeak: 0.4,
    shotStrong: 0.3,
    shotMs: 70,
    /** Hitmarker confirmation. */
    hitWeak: 0.55,
    hitStrong: 0.2,
    hitMs: 70,
    /** Kill confirmation — replaces the hit pulse. */
    killWeak: 0.7,
    killStrong: 0.45,
    killMs: 140,
    /** Taking damage: heavy motor leads. */
    hurtWeak: 0.4,
    hurtStrong: 0.9,
    hurtMs: 220,
    /** Death: longest, heaviest pulse. */
    deathWeak: 0.7,
    deathStrong: 1,
    deathMs: 550,
  },

  audio: {
    /**
     * Concurrent one-shots. Sixteen bots firing is ~80 shots a second; past
     * this many voices the ear can't separate them and the scheduler can't keep
     * up, so extras are dropped rather than queued.
     */
    maxVoices: 24,
    /** Distance at which a world sound plays at full volume. */
    refDistance: 8,
    /** Distance at which it falls silent. Matched roughly to the fog. */
    maxDistance: 70,
  },

  effects: {
    tracerLife: 0.07,
    /**
     * Sized for a 16-bot firefight: everyone is hitscan, so a tracer is drawn
     * per shot from every combatant that fires.
     */
    tracerPoolSize: 64,
    sparkPoolSize: 48,
  },

  graphics: {
    /** Emissive glow (neon, reticle, tracers) — GlowLayer settings. */
    glowIntensity: 1.15,
    glowKernel: 56,
    /** Horror grade post-process (vignette / grain / chromatic aberration). */
    vignette: 0.62,
    grain: 0.055,
    aberration: 0.55,
    /** Peak red edge flash when the player is hit, and how fast it decays. */
    damageFlash: 1.0,
    damageFlashDecay: 2.6,
    /**
     * Hard-edged directional shadows from the key light (the moon), plus a
     * soft contact blob under every combatant. The shadow camera follows the
     * player inside a fixed ortho window — the fog wall at 78 m hides the
     * edge of the coverage.
     */
    shadows: {
      /** Shadow map resolution (square). 110 m / 2048 ≈ 5.4 cm texels. */
      mapSize: 2048,
      /** Width/height of the light's fixed ortho window, in metres. */
      frustumSize: 110,
      /** Light camera distance behind the focus, along the light direction. */
      distance: 90,
      /** Depth range of the ortho volume — must span valley floor to roofs. */
      depthRange: 180,
      /** Fraction of the key light that survives inside shadow. */
      darkness: 0.15,
      /**
       * Consumer-side depth bias and facet-normal offset (metres). The
       * faceted shader shades whole triangles at once, so the offset pushes
       * each triangle's sample off its own plane — flat faces never
       * self-shadow (acne) and cast shadows stay put.
       */
      bias: 0.0025,
      normalBias: 0.06,
      /** Soft contact disc under each combatant. */
      blobRadius: 0.6,
      blobOpacity: 0.55,
    },
    /**
     * Outlines are coloured ink (a darkened take on the mesh's own palette
     * colour) that thins out with distance, so far buildings stop reading as
     * black cut-outs against the fog.
     */
    outlines: {
      /** Full width this near; shrinks to minScale by farDistance. */
      fullDistance: 14,
      farDistance: 60,
      minScale: 0.3,
      /** Outline colour = the mesh's base colour scaled by this. */
      tintFactor: 0.3,
      /** Fallback ink for materials with no flat base colour to darken. */
      fallbackColor: "#12141a",
    },
    /**
     * Toon specular: one hard two-band Blinn highlight from the key light,
     * gated by the same stepped shadow as the diffuse term. Only surfaces
     * listed here carry it — everything else stays matte, which is most of
     * the point: a highlight reads as special when metal and wet stone are
     * the only things that shine.
     */
    spec: {
      /**
       * Rifle metal (rails, fittings, crown): tight cold glint off the
       * moon. High shininess keeps it a pinpoint on small parts.
       */
      rifle: { color: "#aecbf2", intensity: 0.6, shininess: 32 },
      /**
       * Wet cobblestone streets: broad, dim grazing sheen, so the road
       * catches a streak when you look toward the moon — the "rained an
       * hour ago" read. Low shininess spreads it across the street.
       */
      cobble: { color: "#5f7ba6", intensity: 0.35, shininess: 8 },
    },
    /**
     * Cobblestone bump: fake relief height (metres) of a sett dome at
     * height-map value 1.0. The light bands ripple across individual
     * stones; too high and the street reads as rubble.
     */
    cobbleBumpScale: 0.1,
  },

  /**
   * The corner minimap: full-map and north-up (matching the deploy screen),
   * drawn from the same collider data so the two can never disagree.
   * Enemies are hidden unless their own gunfire gives them away.
   */
  minimap: {
    /** Canvas size in pixels (square); the CSS box is set to match. */
    size: 220,
    /** Seconds an enemy stays on the minimap after one of their shots. */
    enemyRevealTime: 2.2,
    /** The final stretch of a reveal, spent fading out (seconds). */
    enemyFadeTime: 0.6,
    /** Blip radii in canvas pixels. */
    friendlyRadius: 2,
    enemyRadius: 2.5,
  },

  /**
   * Battlefield-style directional damage arcs around the crosshair. A hit
   * records the *world* bearing to whoever fired it; the arc is re-projected
   * against the live view yaw every frame, so turning toward the shooter
   * swings their arc up to the top of the screen and off to the side again if
   * you turn past them. That is the whole point of the thing — an indicator
   * frozen in screen space tells you where you were looking, not where they
   * are.
   */
  damageIndicator: {
    /** Seconds an arc lives, and the tail of that spent fading out. */
    life: 2.4,
    fadeTime: 1.4,
    /**
     * Two hits from within this many degrees of each other refresh one arc
     * instead of stacking two. A burst from one rifle is one threat; six
     * overlapping arcs would just read as a red ring.
     */
    mergeDegrees: 24,
    /** Most arcs alive at once; a new hit past this recycles the oldest. */
    maxArcs: 5,
    /** Damage that reads as a full-strength arc. One bot hit, by design. */
    fullDamage: 25,
    /** Opacity of the weakest and a full-strength arc. */
    minOpacity: 0.55,
    maxOpacity: 0.95,
  },

  lighting: {
    /** Muzzle flash pulse: color, reach, brightness, and life in seconds. */
    muzzleColor: "#ffcf7a",
    muzzleRange: 14,
    muzzleIntensity: 2.6,
    muzzleLife: 0.07,
    /**
     * Transient pulses always win a shader light slot, so 16 bots firing at
     * once would saturate all 16 and black out the village's own lanterns.
     * Only the nearest few muzzle flashes get a light, and only up close.
     */
    muzzleBudgetPerFrame: 4,
    muzzleMaxDistance: 30,
    /**
     * Shoulder lamp the player carries. Without it these arenas are too dark
     * to fight in between fixtures — and it gives the character a light of
     * their own to be silhouetted against.
     */
    lampColor: "#ffd9a8",
    lampRange: 18,
    lampIntensity: 1.6,
    lampHeight: 1.45,
  },

  /**
   * Shallow surface water (the creek at B, the bog at E). Visual only — the
   * planes carry no collider, so wading is free and swimming never comes up.
   * Palette lives in the map's EnvironmentSpec; this is motion and shape.
   */
  water: {
    /** Default surface height above the ground plane: ankle-deep. */
    surfaceY: 0.32,
    /** Normal-map tiling (uv repeats per metre) for the two scrolled layers. */
    waveScale1: 0.14,
    waveScale2: 0.38,
    /** Scroll speeds (uv per second); the layers cross at an angle. */
    waveSpeed1: 0.045,
    waveSpeed2: 0.08,
    /** 0 = mirror flat, 1 = the normal map's full relief. */
    waveStrength: 0.6,
    /** Moon glint: Blinn exponent and brightness. */
    specPower: 90,
    specStrength: 0.9,
    /** How fast the view angle tips the body from deep to shallow colour. */
    fresnelPower: 2.2,
    /** Shoreline foam: band width (m), mask tiling, mask scroll speed. */
    foamWidth: 1.1,
    foamScale: 0.3,
    foamSpeed: 0.04,
  },

  /**
   * Grass fields (src/systems/GrassSystem.ts): thin-instanced tufts with a
   * vertex-shader wind sway plus a radial "pusher" bend around every nearby
   * combatant — the ripple as you run through it. Visual only: no collider,
   * no picking, no outline. Palette lives in the map's EnvironmentSpec.
   */
  grass: {
    /** Tufts per square metre when a rect doesn't override density. One tuft
     *  is `bladesPerTuft` blades, so this is ~5x that in blades. */
    density: 1.1,
    bladesPerTuft: 5,
    /**
     * Blade height range (metres). Knee-high at the top end — tall enough to
     * read as a field and to swallow boots, short enough that it never hides
     * a crawling firefight.
     */
    heightMin: 0.45,
    heightMax: 0.85,
    /** Ambient wind: XZ direction (normalized on use), tip travel (m), speed. */
    windDir: [0.78, 0.63],
    windStrength: 0.16,
    windSpeed: 1.7,
    /**
     * Character interaction: how far out a body bends blades (m) and how far
     * the tip travels at ground zero (m). The radius wants to be just past a
     * sprint stride so the grass reacts ahead of the feet, not under them.
     */
    pushRadius: 1.35,
    pushStrength: 0.6,
    /**
     * Shader array size for simultaneous pushers. The player plus the seven
     * nearest bots; beyond that the bend is outside reading distance anyway.
     */
    maxPushers: 8,
  },

  /**
   * The night sky (src/systems/Sky.ts): a gradient dome with baked stars and
   * moon halo, an emissive moon disc that feeds the GlowLayer, and drifting
   * cloud banks. Palette lives in the map's EnvironmentSpec (`sky`); this is
   * geometry and motion. Everything rides at `infiniteDistance`, so radii and
   * heights are angular conveniences, not reachable places.
   */
  sky: {
    /** Dome radius. Well under the camera's default 10000 far plane. */
    domeRadius: 600,
    /** Dome texture: width wraps the horizon, height runs pole to pole. */
    domeTextureWidth: 1024,
    domeTextureHeight: 512,
    /** Moon disc radius and its distance along the key-light source dir.
     *  Beyond the cloud shells (so they veil it) and just inside the dome. */
    moonRadius: 26,
    moonDistance: 595,
    /**
     * Emissive scale on the moon colour — above 1 so the GlowLayer blooms it
     * into a proper halo on top of the soft one baked into the dome texture.
     */
    moonEmissiveBoost: 1.7,
    /** Radius of the baked halo gradient around the moon, in texture px. */
    haloRadiusPx: 46,
    /** Largest star dot, in texture px; most stars are drawn far smaller. */
    starMaxSize: 1.7,
    /**
     * Cloud banks: sphere shells just inside the dome (a plane would show
     * its edges as a hard square hanging in the sky). Each scrolls a
     * wrapping blob texture azimuthally; `speedU` is uv per second (a full
     * circuit takes ~5-10 minutes — clouds should drift, not fly),
     * `uScale` is the texture repeat around the horizon, `radiusOffset` how
     * far inside the dome the shell floats, and `opacity` multiplies the
     * map spec's `cloudOpacity`.
     */
    cloudTextureSize: 256,
    cloudBlobs: 30,
    cloudLayers: [
      { radiusOffset: 12, uScale: 1, speedU: 0.0035, opacity: 1.0 },
      { radiusOffset: 26, uScale: 2, speedU: -0.0018, opacity: 0.55 },
    ],
  },

  /**
   * The two sides. Colors are the primary friend/foe read in a dark scene —
   * warm amber against cold crimson, both legible under blue moonlight.
   */
  teams: [
    {
      name: "Wardens",
      color: "#c9a15e",
      accentColor: "#e8d3a8",
      eyeColor: "#ffc46b",
    },
    {
      name: "The Blight",
      color: "#5a4550",
      accentColor: "#9a8390",
      eyeColor: "#ff3b3b",
    },
  ],
} as const;
