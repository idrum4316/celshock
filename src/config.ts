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
    /**
     * How far a bot's round carries. NOT `engageRange` — that is when a bot
     * decides to shoot, this is where the ray stops, and it also bounds the
     * wall pick behind `losBrokenShots` and the near-miss sweep that
     * suppresses whoever the round went past. Was the player's own range back
     * when there was one rifle in the game and `CombatSystem` could read it
     * out of the config; now every shooter brings its own.
     */
    range: 120,
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
       * Rounds before a reload. Matched to the RIFLE's magazine so the rhythm
       * of a firefight is symmetrical — and so the gap is a window the player
       * can learn to push into, which is the whole point of bots reloading at
       * all. Before this they had infinite ammo and only the burst pause.
       * Bots carry one weapon whatever the player picked; the loadout is the
       * player's choice to make, not a thing the roster answers.
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
     * Movement texture. All of this is heading, speed and facing only — the rig
     * has seven joints and four animation parameters, so there is no crouch,
     * lean or vault to reach for. What is achievable is *where* and *how fast*,
     * and that turns out to carry most of it.
     */
    movement: {
      /**
       * How many cells down the flow field a bot aims. `steer` returns the next
       * cell centre, which is why bots walked a visible 1.5 m zigzag; looking
       * ahead points at where the route actually goes.
       */
      lookaheadCells: 3,
      /**
       * Heading smoothing, per second. The flow field's direction snaps between
       * eight compass points, and a body that turns instantly between them
       * reads as a machine following a grid — which is exactly what it was.
       *
       * Applied only to the flow-field states, and *before* the stuck
       * watchdog's sidestep, so smoothing can never blunt the thing that gets a
       * wedged bot out.
       */
      headingRate: 5,
      /**
       * Amplitude and period of the per-bot lateral weave. Four bots on one
       * flow field otherwise walk in single file down the exact same line,
       * which no squad has ever done.
       *
       * The period is long for a measured reason: the weave is itself a source
       * of curvature, and at 5 s it put back exactly as much path wobble as the
       * smoothing above had taken out (mean turn 7.25 deg against a 7.41 deg
       * baseline, for +60% squad spread). Slowing it to 11 s keeps the same
       * lateral displacement while changing direction half as fast — 5.13 deg
       * and +95% spread, better than the baseline on both counts instead of
       * trading one for the other.
       */
      laneOffset: 0.55,
      lanePeriod: 11,
      /** Per-bot speed variation, as a fraction. Nobody marches in lockstep. */
      speedJitter: 0.12,
      /**
       * A heading swing larger than this (radians, per think) means the route
       * just turned a corner — so pause and look before committing to it.
       */
      cornerAngle: 1.0,
      cornerPause: 0.45,
      /**
       * How strongly openness pulls a bot toward walls. A preference only: the
       * flow field still decides where it is going, this just biases which side
       * of the street it walks down.
       */
      wallHug: 0.35,
      /**
       * How far the upper body may turn off the feet, radians (~66 deg).
       *
       * The rig's root carries one yaw, so before the split a bot pointed its
       * whole body at whatever it was looking at and a strafing bot walked
       * visibly sideways. Now the feet follow travel and the torso twists to
       * the look direction — but only so far. Past this the hips have to come
       * round, which is both what a body does and what stops the shoulders
       * ending up on backwards.
       */
      maxTorsoTwist: 1.15,
      /**
       * How fast the feet swing to a new heading, per second. Slower than the
       * look slew (`skill.turnRate`) on purpose: the whole point is that the
       * head and torso lead and the feet follow.
       */
      bodyTurnRate: 6,
    },

    /**
     * Squad coordination. Squads are planned as a group, on their own slow
     * timer — this is four objects at 2 Hz, so it deliberately does not steal
     * from the per-bot think budget, where it would silently slow every bot's
     * reaction time.
     */
    squad: {
      /** How often a team's squad orders are re-planned. */
      updateRate: 2,
      /**
       * Score a flag loses per squad already heading there. A penalty, not an
       * exclusion: when the round hinges on one flag, two squads stacking on
       * it is correct, and the old `squad % flags` forced spreading is what
       * sent bots wandering away from the fight that decided the game.
       */
      claimPenalty: 45,
      /**
       * Bonus a squad's current objective keeps. Held on the squad rather than
       * the bot, so two flags' scores crossing cannot turn a squad round
       * halfway through its approach.
       */
      switchMargin: 30,
      /**
       * Bonus for a flag you own with enemies standing on it, scaled by how far
       * the meter has already slipped. This is the whole defence behaviour:
       * without it an owned flag scores a flat penalty however close it is to
       * being lost, so nobody ever goes home.
       */
      defendUnderAttack: 110,
      /**
       * How far outside the capture radius a defender will look for a covered
       * vantage. Holding a flag from the geometric centre of an open circle is
       * how you lose it; holding it from the doorway across the street is not.
       */
      defendStandoff: 6,
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
     * Crouch — held on Ctrl, latched by `C` or the pad's B (see
     * `InputManager.crouch`). It costs speed for a lower profile and a
     * steadier gun. Two numbers do the real work and they must move together:
     *
     * `crouchEyeHeight` is where the camera goes, where `Player.eyePos`
     * reports, and therefore what bots test line of sight against and aim at —
     * the same one-number-for-all-three rule the standing `camera.eyeHeight`
     * follows. That is what makes crouching behind a waist-high wall actually
     * break contact instead of just looking like it does.
     *
     * `crouchCenterHeight` moves the hit sphere down with it. Skip it and
     * crouching makes you EASIER to kill, not harder: bots aim at `eyePos`, so
     * a dropped eye against an unmoved sphere puts every shot through the
     * middle of the target instead of grazing its top. Standing, the sphere's
     * top (0.9 + 0.7) sits 0.05 m above the eye; crouched, 0.4 + 0.7 keeps the
     * same relation, so the profile shrinks by the half-metre the eye dropped
     * and nothing is visible-but-unhittable (or the reverse).
     */
    crouchEyeHeight: 1.05,
    crouchCenterHeight: 0.4,
    /** Movement multiplier while crouched — a shuffle, not a walk. */
    crouchMoveMult: 0.5,
    /**
     * Spread multiplier while crouched. Applied to the whole spread, bloom
     * included, so a braced stance is worth taking in a firefight and not
     * only for the cover. Modest on purpose: crouch is not a second ADS.
     */
    crouchSpreadMult: 0.7,
    /** How fast the stance blend converges (per second). */
    crouchBlendSpeed: 12,
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
   * fast and cannot be trusted past the far side of a street, and the DMR
   * kills in two and gives you one trigger pull at a time to do it with.
   *
   * The time to kill is deliberately close for the two automatics (rifle 4
   * rounds at 8/s = 0.375 s, SMG 6 at 13/s = 0.385 s). What you are choosing
   * between them is not damage per second, it is how much of the screen a
   * burst covers. The DMR is the one that steps outside that: 2 rounds at 3/s
   * is 0.333 s, faster than either, and it pays for it with the error budget
   * — a missed rifle round costs 0.125 s and a missed DMR round costs 0.333.
   *
   * `recoilMult` and `bloomMult` SCALE `CONFIG.recoil` rather than restating
   * it: the shape of recoil — how much springs back, how fast, where it is
   * capped — belongs to the game, not to the weapon. Bloom is multiplied at
   * its ceiling too, or a weapon that blooms faster would pay nothing for it
   * after the second shot.
   */
  weapons: {
    rifle: {
      name: "Assault Rifle",
      /** For the magazine caption, where the full name will not fit. */
      short: "Rifle",
      /** 30 per hit against 100 HP = 4 shots to kill. */
      damage: 30,
      /** Rounds per second. */
      fireRate: 8,
      /**
       * Whether the trigger has to be released between rounds. Held fire is
       * the default; see `Player.tryShot`, which owns the latch.
       */
      semiAuto: false,
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
       * Scales `camera.aimSway` — how steady this weapon is to hold. Mass and
       * where the hands sit, nothing else: a heavier weapon wanders less and
       * a light one carried high wanders more. The rifle is the reference.
       */
      swayMult: 1,
      /** Report pitch, as a multiplier on the shot's own frequencies. */
      sfxPitch: 1,
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
      /** Light, short, and held high — the liveliest thing in the kit. */
      swayMult: 1.2,
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
      /**
       * The steadiest weapon here, and it has to be. Sway is angular, so the
       * scope this weapon exists to carry magnifies it 3.5x; at the rifle's
       * figure the shot the DMR is for — one deliberate round at range —
       * would be a matter of timing the wander rather than of aiming. Mass
       * and a cheek on the comb are the excuse, the two-shot kill is the
       * reason. Crouched with a scope this is ~0.13 deg.
       */
      swayMult: 0.7,
      /** A heavier charge in a longer barrel: lower, and (see `Sfx.shoot`,
       *  where level tracks 1/pitch) louder, because it fires far less often. */
      sfxPitch: 0.82,
    },
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
  },

  /**
   * Fragmentation grenades. Everyone — the player and every bot — spawns with
   * `carried` of them and there is no resupply: two a life is the whole
   * economy, which is what makes each one a decision rather than a second
   * trigger.
   *
   * This is the one weapon in the game that is NOT hitscan, and the numbers
   * below are what pay for that. A thrown grenade is a body with a fuse: it
   * flies, it bounces off the same collider proxies bullets stop on, and it
   * goes off `fuse` seconds after it leaves the hand whatever it has hit on
   * the way. Cooking is deliberately absent — the fuse starts on release —
   * because a cook needs a hold-to-charge input on a button that is also the
   * pad's only free bumper, and the arc is already the skill.
   *
   * The blast is `damage` inside `innerRadius`, falling linearly to nothing at
   * `blastRadius`, and it needs line of sight: a wall between the two is a wall
   * the fragments stop in, tested with the same `metadata.solid` ray everything
   * else in this game uses. `damage` is deliberately over the 100 HP pool, so
   * a grenade that lands ON someone kills, and one that lands near them
   * softens them up — the falloff is where all the play is.
   *
   * Friendly fire is excluded the same way `CombatSystem.fire` excludes it: by
   * the target list the thrower is handed, never by a team check at the point
   * of damage. A grenade cannot hurt its own side, including the thrower. That
   * is a game decision rather than a physical one, and the alternative — bots
   * routinely killing their own squad with a lobbed frag — is not a fight
   * anybody wants to be in.
   */
  grenade: {
    /** Carried per life. There is no way to pick more up yet. */
    carried: 2,
    /** Seconds from leaving the hand to detonation. Not resettable, not cookable. */
    fuse: 2.6,
    /**
     * Launch speed (m/s) and the upward tilt added to the aim direction
     * (radians). The lift is what makes a throw at a flat horizon land out in
     * front of you instead of at your own feet; aiming up adds to it as it
     * should.
     *
     * The speed is bounded from below by the bots, not by the player: a
     * projectile's flat range is `v^2 / g`, so 24 against a gravity of 18 can
     * reach 32 m and `bot.maxRange` has to fit inside that or the ballistic
     * solve refuses every throw the AI ever asks for. Measured on flat ground,
     * a level throw from a standing eye first lands at 21 m and detonates at
     * 23; aiming 11 degrees up reaches 30 and 26 degrees reaches 35, so where
     * you are looking genuinely decides the throw.
     *
     * Against the exaggerated 18 m/s^2 gravity this is the same arc a 17.7 m/s
     * throw would take under real gravity — a strong overhand, not a mortar.
     */
    throwSpeed: 24,
    throwLift: 0.28,
    /**
     * Where it leaves the hand, relative to the eye and the way it is looking.
     * Far enough forward that a throw taken with a wall at your shoulder does
     * not spawn inside the wall, close enough that it still reads as thrown by
     * the hands you are looking past.
     */
    handAhead: 0.5,
    handSide: 0.2,
    handUp: -0.1,
    /** Seconds between the player's throws — the arm, not the fuse. */
    throwInterval: 0.7,
    gravity: 18,
    /** Collision radius (m); also the drawn size. */
    radius: 0.11,
    /**
     * Bounce: the fraction of the normal speed kept across an impact, and the
     * fraction of the tangential speed friction leaves behind. A frag is a lump
     * of steel and does not bounce like a ball — low restitution is what keeps
     * a grenade thrown into a room in that room, which is the whole reason to
     * throw one through a doorway.
     *
     * The FRICTION is the one that decides how the AI plays, and it is tuned
     * against the roll rather than against the bounce: `throwAt` solves for the
     * grenade to *arrive* at a point, and everything after that is overshoot.
     * At 0.5 a bot's grenade skated 4-6 m past its target; at 0.3 it settles
     * 0.7-1.8 m past across the whole 11-30 m band, which is well inside the
     * scatter and reads as a throw rather than as a skim.
     */
    restitution: 0.25,
    friction: 0.3,
    /** Below this speed, resting on a floor, it stops rolling. */
    restSpeed: 1.1,
    /** Full damage inside this radius, falling linearly to nothing at the next. */
    innerRadius: 2.6,
    blastRadius: 8.5,
    damage: 130,
    /**
     * Pool size. Seventeen combatants with two each is 34 in theory and never
     * anything like it in practice — but an exhausted pool REFUSES the throw
     * rather than stealing a live grenade's slot, so the count is never spent
     * on something that does not arrive.
     */
    poolSize: 20,
    /**
     * The blast's kick on the camera, as a fall speed handed to
     * `CameraSystem.land` — the eye taking a concussion is the same damped
     * spring as the eye taking a landing, so there is one integrator for both.
     * Scaled by the same falloff the damage uses.
     */
    shakeSpeed: 13,
    /** Fireball: how far it expands, and how long the whole flash lasts. */
    blastVisualRadius: 4.2,
    blastVisualTime: 0.42,
    /** Embers flung out of the blast: count, speed, lifetime, gravity. */
    emberCount: 14,
    emberSpeed: 13,
    emberLife: 0.75,
    emberGravity: 16,

    /**
     * When a bot throws one. Considered on its ordinary think tick rather than
     * on a timer of its own — it is a decision about a target it already has,
     * and a bot with no target has nothing to throw at.
     *
     * The range band is the whole safety model: a bot has no idea where its own
     * blast reaches, so it is simply never allowed to throw at something close
     * enough to catch itself. The far end is where the ballistic solve starts
     * dropping grenades short of anything.
     */
    bot: {
      minRange: 11,
      maxRange: 30,
      /**
       * Chance per think tick, scaled by the bot's skill. At the 5 Hz think
       * rate this is roughly one throw every few seconds of sustained contact
       * for an ace and rather less for a rookie — the point is that a grenade
       * arrives when you have been holding one position too long, not that it
       * arrives on a schedule.
       */
      chance: 0.06,
      /** Seconds before the same bot may throw again. */
      cooldown: 8,
      /** Aim scatter on the landing point (m). Bots are not mortars. */
      scatter: 2.4,
    },
  },

  camera: {
    /** Mouse sensitivity (radians per pixel). */
    sensX: 0.0022,
    sensY: 0.002,
    /** Gamepad look speed (radians per second at full deflection). */
    stickSensX: 2.8,
    stickSensY: 1.8,
    /**
     * Eye height, standing. The camera sits here (first person), Player.eyePos
     * reports it, and bot line-of-sight checks against the player use it — one
     * number for all three, so what a bot can see is what you can see.
     * Crouching interpolates all three toward `player.crouchEyeHeight`; it is
     * the same number doing the same three jobs, just lower.
     */
    eyeHeight: 1.55,
    /**
     * Hip-fire vertical FOV (radians). The AIMED field of view is not here —
     * it belongs to whichever optic is fitted, so it lives in `sights` below
     * and is derived from that sight's magnification against this number.
     */
    fovHip: 0.95,
    /**
     * How fast the hip<->ADS blend converges (per second), before the fitted
     * sight's own `adsSpeedMult` is applied.
     */
    adsBlendSpeed: 10,
    /**
     * Pitch limits. Wider than the third-person camera's, which had to stop
     * before the shoulder rig clipped the ground or the sky: ±1.45 is ~83°,
     * far enough to check your feet and the rooftops without ever inverting.
     */
    pitchMin: -1.45,
    pitchMax: 1.45,
    /**
     * Head bob. The phase advances with travel, not with time, so it stops
     * dead when you do; vertical runs at twice the lateral rate because a
     * stride dips the head once per FOOT and sways it once per PAIR.
     * Deliberately small — this is a shooter, and bob that reads as motion
     * on a walk reads as nausea over a round. It moves the rendered camera
     * only: aimPitch/aimYaw never see it, so bullets don't bob.
     */
    bobRate: 8.0,
    bobVertical: 0.026,
    bobLateral: 0.018,
    /**
     * ADS look sensitivity, as a multiplier on the hip-fire rates BEFORE the
     * fitted optic's magnification is divided out (see `sights`). Aiming
     * therefore moves the crosshair across the SCREEN at a near-constant rate
     * whatever is bolted to the rail — a 3.5x scope that kept the hip-fire
     * rates would be unusable, and one tuned by hand per optic would drift.
     * The shipped holo is 1.6x, so these reproduce the 0.6 / 0.5 the camera
     * used when the sight was not a choice.
     */
    adsLookMouse: 0.96,
    adsLookStick: 0.8,
    /** Bob multiplier while aimed — braced, so nearly still. */
    bobAdsMult: 0.2,
    /**
     * Bob multiplier while crouched. The bob drive is movement *intent*, not
     * speed, so without this a crouch-shuffle at half pace bobs the head as
     * hard as a jog — the stride reads at the wrong tempo for the distance
     * actually being covered.
     */
    bobCrouchMult: 0.45,
    /** How fast the bob amplitude follows the movement input (per second). */
    bobSmooth: 7,
    /**
     * The landing absorb: what the eye does when the feet arrive. A jump used
     * to end with the camera simply stopping — zero vertical speed on the
     * contact frame, nothing to show for the fall — which reads as a dropped
     * frame rather than as an arrival. This is the knees, and it is meant to
     * be felt: a hard landing is not supposed to be smooth, it is supposed to
     * be brief and deliberate.
     *
     * A damped spring, given a downward VELOCITY at the impact and left to
     * find its way back, so the motion has weight on the way in and a small
     * rebound on the way out. At these numbers a plain jump (8.5 m/s down)
     * sinks the eye 6 cm over 67 ms, comes back through neutral by ~1 cm and
     * is settled inside half a second; the worst drop the map offers is 8.5 cm.
     * Deep enough to punctuate the jump, short enough not to cost a fight.
     */
    land: {
      /**
       * Impact speeds (m/s) between which the absorb ramps from nothing to its
       * full depth. `minSpeed` is under the sound's own threshold on purpose:
       * a small hop bends the knees visibly before it makes any noise.
       */
      minSpeed: 2.5,
      fullSpeed: 11,
      /** Downward speed (m/s) handed to the eye by a full-speed landing. */
      dipSpeed: 2.4,
      /** Spring frequency (Hz) and damping ratio (<1 rebounds; 1 does not). */
      frequency: 2.0,
      damping: 0.5,
      /** Nod and roll per metre of dip (rad/m): the chin and the weight. */
      nod: 0.55,
      roll: 0.35,
      /**
       * Multiplier on the nod and the roll while aimed — the dip is left at
       * full, because bending your knees is not something a sight prevents.
       * The rotations are what swing the picture off the (un-nodded) rounds,
       * so they are the half worth suppressing when it matters.
       */
      adsMult: 0.35,
    },
    /**
     * Hold sway: the wander of an aimed weapon that nobody's arms can hold
     * still. Everything else the camera does for show — the bob, the punch,
     * the landing nod — is kept out of aimPitch/aimYaw so the bullets never
     * see it. This one is the opposite on purpose: it is part of the aim, so
     * the sight picture and the point of impact drift TOGETHER. The weapon is
     * parented to the camera, so what you see is the world sliding behind a
     * reticle that stays on the axis — which is what a hold actually looks
     * like, and the only version that does not make the reticle lie.
     *
     * It is scaled by the ADS blend, so hip fire is untouched: a drift the
     * player has to fight while running around is nausea, not texture.
     *
     * Angular, and deliberately NOT normalised by magnification the way the
     * look rates are (see `adsLookMouse`). A sight magnifies your unsteadiness
     * along with everything else — that is the trade a 3.5x optic is asking
     * you to make, and the answer to it is crouching, a heavier weapon, or
     * standing still.
     */
    aimSway: {
      /**
       * Peak offsets (rad) at full weight, before the state multipliers. The
       * pitch term breathes; the yaw term runs at half its rate, which is what
       * makes the pair trace a slow figure-eight rather than a diagonal line.
       * ~0.33 deg and ~0.42 deg — at 3.5x that reads as about a degree of
       * screen movement, and at 25 m it is ~15 cm of point of aim.
       */
      pitch: 0.0045,
      yaw: 0.006,
      /**
       * Breathing rate (Hz) — ~14 a minute. The secondary terms are fixed
       * half-integer multiples of it (see `CameraSystem.update`), which is
       * what lets the phase wrap at 4pi without a discontinuity.
       */
      rate: 0.23,
      /**
       * Aiming on the move: the drive is movement INTENT, like the bob's, so
       * a crouch-shuffle does not count as a jog. Aiming while walking is
       * meant to cost something.
       */
      moveMult: 1.9,
      /** Crouched, with the elbows somewhere: the steadiest a player gets. */
      crouchMult: 0.55,
      /** How fast the weight follows a change of state (per second). */
      smooth: 3,
    },
  },

  /**
   * The optics the player can fit, and everything that differs between them.
   * The keys ARE the sight ids — `SightId` in `entities/sights.ts` is derived
   * from this table, so adding an optic here and a builder in `RifleModel`
   * is the whole job.
   *
   * Every sight fires the same bullets: damage, spread and recoil are the
   * rifle's, not the optic's. What an optic changes is what you can SEE and
   * how fast you can bring it to bear, which is the trade the loadout screen
   * is asking you to make.
   *
   * `magnification` is the one number the rest is derived from — the aimed
   * FOV (`2*atan(tan(fovHip/2) / magnification)`), the look sensitivity (see
   * `camera.adsLookMouse`) and the viewmodel's zoom compensation
   * (`viewmodel.adsMagReference`) all fall out of it. Holo is 1.6, which is
   * exactly the 0.62 rad the camera used before optics were a choice, so
   * fitting it reproduces the shipped weapon frame for frame.
   */
  sights: {
    /**
     * Irons: a rear aperture and a hooded front post. No glass, the least
     * zoom, the widest picture and the fastest to the shoulder — the choice
     * for close work, where a magnified sight is a liability.
     */
    iron: {
      name: "Iron",
      magnification: 1.35,
      /**
       * Distance from the eye to the sight's own eye reference, aimed (m).
       *
       * This is half of a PAIR — `optics.ts` measures every dimension of the
       * sight against it, so the two only mean anything together. What the
       * eye sees through a sight is an angle: shorten this and shrink the
       * optic by the same factor, and the sight picture is identical while
       * the thing on the weapon is smaller. That is exactly what was done to
       * all three, which had been sized for an eye held so far back that the
       * optics came out wider than the receiver they stood on. Changing one
       * of the two alone re-sizes the picture instead.
       */
      eyeRelief: 0.33,
      /** Multiplier on `camera.adsBlendSpeed` — how fast it comes up. */
      adsSpeedMult: 1.2,
    },
    /** The shipped holographic sight: a lit ring and dot on a tube optic. */
    holo: {
      name: "Holo",
      magnification: 1.6,
      eyeRelief: 0.38,
      adsSpeedMult: 1,
    },
    /**
     * A 3.5x telescopic sight with a duplex reticle. Slow to raise and a
     * tunnel to look down, and the only thing on the rifle that will show you
     * a body at the far end of the valley.
     */
    scope: {
      name: "Scope",
      magnification: 3.5,
      /**
       * Short, and that is what makes it a scope rather than a pipe. The eye
       * looks down a real hollow tube here, so how much of the frame is clear
       * is set by the far rim's angular size — pull the eye back and the rim
       * shrinks until the sight picture is a keyhole, or the tube has to grow
       * to hold it, which is what made this one a drainpipe. Close in, the
       * near rim passes off the top and bottom of the screen and what is left
       * is a magnified circle in a dark surround.
       *
       * The floor under it is the camera's near plane (`CameraSystem` sets
       * 0.05): this is scaled by `zoomComp` before it becomes a stand-off, so
       * the eyepiece sits about 0.07 m out and any less would clip it open.
       */
      eyeRelief: 0.17,
      adsSpeedMult: 0.75,
    },
  },

  /**
   * The first-person weapon: where the rifle sits in front of the camera, and
   * everything that moves it there. All positions/rotations are CAMERA-LOCAL
   * (+x right, +y up, +z forward) and in rifle-model units — the viewmodel
   * node carries `scale`, so the rifle's own local coordinates and these
   * offsets are in the same frame.
   *
   * The aimed stand-off is NOT here — it is `sights[id].eyeRelief`, and it is
   * the one number that must not be treated as art direction: ViewModel
   * derives the aimed position from it so the fitted sight's own centre lands
   * exactly on the camera axis, which is where the bullets go. Move the sight
   * off that axis and the reticle stops being the point of impact.
   */
  viewmodel: {
    /**
     * Scale and stand-off together decide how much of the frame the rifle
     * eats. At full size half a metre from the lens it is a wall: this is a
     * 54° vertical FOV against a real eye's ~130°, so a viewmodel framed the
     * way a rifle actually sits fills the screen. Shrunk and pushed out, it
     * reads at the size the eye expects.
     */
    scale: 0.62,
    /**
     * The magnification the weapon is FRAMED at. Aiming narrows the FOV, and
     * a narrower FOV magnifies the rifle along with the world — harmless at
     * the holo's 1.6x, and at 3.5x a receiver across the whole screen. Past
     * this reference the viewmodel is scaled down and drawn in proportionally
     * closer, which is a uniform scale about the camera's own origin: it
     * changes no ray direction, so the sight picture and the point of impact
     * are untouched and only the apparent size of the weapon is held still.
     * Set it to the largest magnification on offer to disable the whole
     * mechanism.
     */
    adsMagReference: 1.6,
    /** Hip-fire pose: sight ~30% right and ~22% down, muzzle turned inboard. */
    hipPos: { x: 0.184, y: -0.185, z: 0.66 },
    hipRot: { x: 0.03, y: -0.08, z: 0.06 },
    /**
     * Sprint: the rifle carried ACROSS the body, muzzle swung inboard and
     * canted, reading as a diagonal through the lower right of the frame.
     *
     * The yaw sign is the whole pose. Babylon is left-handed, so a positive
     * `rotY` takes the barrel (+z) toward +x — outboard, away from the
     * shooter. That is a rifle held out to one side at arm's length: it
     * reads as broken rather than as running, and it swings the weapon off
     * the edge of the screen so only the optic is left. Inboard is negative.
     *
     * The drop is small on purpose. `hipPos.y` is already -0.185, so an
     * offset much past this lands near -0.3 and sinks the whole weapon out
     * of frame — the same symptom, from the other axis.
     */
    sprintPos: { x: -0.01, y: -0.05, z: -0.03 },
    sprintRot: { x: 0.2, y: -0.4, z: 0.3 },
    /** Reload: tipped down and rolled toward the magwell. */
    reloadPos: { x: 0.02, y: -0.1, z: -0.05 },
    reloadRot: { x: 0.3, y: -0.2, z: 0.42 },
    /**
     * The throw. A grenade goes with the OFF hand, so the weapon is not put
     * away for it — it drops out of the aim and rolls outboard while the other
     * arm does the work, and comes back. That is the whole animation: there is
     * no grenade in view and no arm swing, because both would need a rig the
     * viewmodel does not have, and a weapon that visibly gives way is enough
     * to say the hands are busy.
     *
     * `throwTime` is how long the pose takes to return, and it is deliberately
     * shorter than `grenade.throwInterval` so the weapon is settled again
     * before a second throw is allowed.
     */
    throwPos: { x: 0.06, y: -0.12, z: -0.08 },
    throwRot: { x: 0.26, y: 0.34, z: -0.3 },
    throwTime: 0.45,
    /** Where the support hand travels to for the magazine swap. */
    magHandOffset: { x: -0.02, y: -0.09, z: -0.34 },
    /** Support-hand window over the reload: leaves the guard, swaps, returns. */
    magWindow: [0.15, 0.35, 0.6, 0.8],
    /**
     * Sway: the weapon lags the view. Position offsets oppose the turn,
     * rotation follows it, both clamped so a fast flick can't swing the
     * rifle out of frame, and both eased so the weapon settles after the
     * camera stops.
     */
    swayPos: 0.05,
    swayRot: 0.1,
    swayPitchPos: 0.035,
    /** One ceiling for all four terms — metres for the offsets, radians for
     *  the rotations. They happen to want the same number. */
    swayMax: 0.09,
    swaySmooth: 8,
    /** Weapon bob, on the camera's own bob phase (see camera.bobRate). */
    bobLateral: 0.022,
    bobVertical: 0.014,
    bobRoll: 0.05,
    /** Sway/bob multipliers while aimed — a braced weapon barely moves. */
    adsSwayMult: 0.3,
    adsBobMult: 0.12,
    /**
     * Vertical give while airborne, from the fall speed (m per m/s). The
     * pose blends themselves need no smoothing constant: Player hands over
     * adsBlend/sprintBlend/reloadBlend already eased.
     */
    airDrop: 0.006,
    airDropMax: 0.05,
    /**
     * How fast the give follows that fall speed (per second). It exists
     * because the speed it follows does not ease: it jumps to the launch
     * velocity on the push and to zero on the frame the feet touch. Take the
     * give straight from it and the weapon snaps 5 cm back to neutral in one
     * frame, which is the pop the landing absorb is there to replace. ~70 ms
     * of lag — enough that the return is a motion, short enough that the
     * weapon still reads as attached to the body.
     */
    airDropSmooth: 14,
    /**
     * The landing absorb's share of the camera's dip (see `camera.land`). The
     * weapon already rides the camera down; this is how much further the arms
     * let it go, and the nose-down pitch per metre of that dip. Both are the
     * part you can actually see, because the rest of the sink moves the eye
     * and the weapon together.
     */
    landFollow: 0.35,
    landPitch: 0.5,

    /**
     * The loadout screen's turntable: the weapon held up to be LOOKED at
     * rather than carried, parked at a fixed place on the screen and turned by
     * the player. Framing numbers, in the same spirit as `scale` and `hipPos`
     * above — how much of the frame the weapon eats and where it sits, not
     * anything the rounds can tell apart.
     */
    inspect: {
      /**
       * Metres from the lens at the hip-fire FOV. Nearer than the hip pose, so
       * the weapon fills its half of the screen; ViewModel scales this by the
       * live FOV so the stage frames identically whatever the camera was left
       * zoomed to (dying mid-ADS is enough to leave it narrow — nothing
       * re-writes `camera.fov` until the next round starts).
       */
      dist: 1.25,
      /**
       * The aspect ratio `dist` frames the weapon for. Narrower than this and
       * the weapon is pushed proportionally further back: its size follows the
       * vertical FOV, but the room it has to fit in is the stage's share of the
       * width, so a nearly square window would otherwise lay a rifle across
       * the panel column. Wider is free — the stage only gets roomier.
       */
      aspectReference: 1.7,
      /**
       * Where on the SCREEN the weapon is centred, in NDC (-1..1, +x right,
       * +y up). This is the loadout screen's stage: its panel column takes the
       * left 46% of the viewport (`--panel` in #loadout's CSS) and the stage
       * the rest, so the stage's centre sits `(1 + 0.46) / 2` across — which in
       * NDC is 0.46 again. Both sides are FRACTIONS of the viewport, which is
       * what keeps the DOM and the weapon together at any window size.
       */
      anchorX: 0.46,
      anchorY: 0.06,
      /**
       * The turntable spins about a point this far along the weapon's own
       * muzzle offset, so a shorter weapon centres itself instead of swinging
       * around a stock that is no longer there. Measured from the models'
       * spans — the rifle runs -0.52..0.75 and the SMG -0.32..0.50, whose
       * midpoints are 0.15 and 0.18 of their own muzzle landmark.
       */
      pivotFrac: 0.17,
      /**
       * Opening angles. A yaw just past a quarter turn brings the ejection-port
       * side toward the viewer with the muzzle across to the right, leaning a
       * few degrees TOWARD it — the other way round reads as foreshortened,
       * because the near end is then the stock and the whole weapon tapers off
       * to a muzzle in the distance. The slight negative pitch tips the top
       * plate into view, so the optic reads as fitted rather than as a lump on
       * the receiver.
       */
      baseYaw: 1.78,
      basePitch: -0.12,
      /** Radians per pixel of drag, and per second at full stick deflection. */
      dragRate: 0.009,
      stickRate: 2.6,
      /** Pitch is clamped short of straight up/down; yaw wraps freely. */
      pitchMax: 1.15,
    },
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
    /**
     * Metres per second. A shot across the map arrives ~0.2 s after its muzzle
     * flash, which is the cue that tells the ear how far away a firefight is
     * far more strongly than volume does.
     */
    speedOfSound: 343,
    /**
     * The village answering a gunshot: one shared convolution reverb every shot
     * sends into. Length is the decay of the diffuse tail; a report outdoors is
     * a short transient followed by a few hundred milliseconds of stone and
     * timber, and it is that tail, not the report, that reads as "real gun".
     */
    reverbSeconds: 0.9,
    /** Wet level of that shared bus. */
    reverbMix: 0.5,
    /**
     * Extra reverb send per unit of `maxDistance`. Reverberant energy falls off
     * far more slowly than the direct sound, so a distant shot is mostly tail
     * and a close one is mostly crack.
     */
    reverbDistanceSend: 1.6,

    /**
     * Footsteps. The player's are triggered by the camera's bob phase rather
     * than by a timer of their own — a step you hear off the beat of the dip
     * you see is worse than no step at all — so there is no interval here.
     * What is here is how loud each stance is, and how far a bot's boots
     * carry.
     */
    footstep: {
      /** Walking, sprinting, and how much of that a crouch keeps. */
      walkVol: 0.5,
      sprintVol: 1,
      /**
       * Crouching is already slower and lower (the bob drive is damped by
       * `camera.bobCrouchMult`), so this only has to finish the job. It does
       * NOT make you quieter to the enemy: bots hear gunshots, never feet.
       */
      crouchMult: 0.3,
      /**
       * Impact speed (m/s) below which touching down is just walking, and the
       * speed at which a landing is as loud as it gets. A step off a kerb is
       * a footstep; a drop off the mill roof is not.
       */
      landMinSpeed: 3,
      landFullSpeed: 11,
      /**
       * How far a bot's footfalls carry, well inside `maxDistance` (70). Boots
       * are not rifles: at 70 m they would be inaudible in the mix and would
       * only spend voices the gunfire needs — 16 bots stepping twice a second
       * is 32 one-shots a second on its own. Short range keeps the cue
       * meaningful (someone is close, and roughly there) and the cost small.
       */
      botRange: 20,
    },
  },

  effects: {
    /**
     * A tracer is a short streak that FLIES, not a beam drawn muzzle-to-impact.
     * Everyone is hitscan, so the damage has already happened by the time the
     * streak leaves the barrel — the flight is pure presentation, and these two
     * numbers are what stop a shot reading as a laser.
     *
     * `tracerLength` is the streak itself (metres of lit round). Long enough to
     * read as a direction at 60 m, short enough that it never joins the muzzle
     * to the target. `tracerSpeed` is well under a real 900 m/s round: at true
     * muzzle velocity a 120 m shot crosses in 0.13 s, which at 60 fps is eight
     * frames of a streak nobody can follow, so it degenerates back into the
     * beam it is meant to replace.
     */
    tracerLength: 6,
    tracerSpeed: 320,
    /**
     * Sized for a 16-bot firefight: everyone is hitscan, so a tracer is drawn
     * per shot from every combatant that fires — and now each one lives for its
     * whole flight (up to `weapon.range / tracerSpeed`, ~0.4 s) rather than a
     * fixed 0.07 s, so several times as many are in the air at once. An
     * exhausted pool steals the oldest slot, which shows as a streak vanishing
     * mid-flight.
     */
    tracerPoolSize: 96,
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
     * Motion blur on the look. A rotation reprojects identically at every
     * distance, so this needs no depth buffer and no second pass over the
     * scene — and equally, translation (strafing past a wall) does not blur.
     */
    motionBlur: {
      /**
       * Fraction of the frame's rotation to smear across — how long the
       * shutter is open. 1 covers the whole frame (a 360-degree shutter,
       * more than a real camera); film convention is nearer 0.5. This sits
       * well under that on purpose: the blur should register as weight
       * behind a whip pan and stay unnoticed on an ordinary look around,
       * which is most of what a round is. 0 disables the pass, at which
       * point the shader is a straight copy.
       *
       * Measured: smear length is exactly linear in speed x strength, so
       * halving this is identical to halving the pan rate.
       */
      strength: 0.3,
      /** Taps along the smear, the sharp one included. Must be at least 2. */
      samples: 10,
      /**
       * Longest smear, as a fraction of the frame. This is a safety cap, not
       * a look: one dropped frame arrives as a single huge rotation, and
       * headless captures run slow enough to smear the screen flat without
       * it. It bites at a pan rate inversely proportional to `strength` —
       * roughly 550 deg/s at the value above — so ordinary play never
       * reaches it and a hitch saturates instead of exploding.
       */
      maxShift: 0.04,
      /** Rotation in one frame (radians) below which the pass is skipped. */
      minRotation: 0.0015,
      /**
       * Radial falloff, sharp at the crosshair and full past the outer edge.
       * The viewmodel is fixed in screen space and must not smear with the
       * world behind it, and there is no depth in this pass to tell them
       * apart — so the centre of the frame, where the weapon sits and where
       * the eye is tracking, keeps its edges. Widening the sharp core is the
       * second subtlety lever after `strength`, and the better-behaved one:
       * it takes the blur off exactly the pixels the player is reading and
       * leaves it where peripheral motion belongs.
       */
      maskInner: 0.35,
      maskOuter: 0.85,
    },
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
       *
       * Intensity is tied to how high the moon sits: the lower it is, the
       * closer the half-vector comes to the street's own normal when you look
       * along it, so the same number that read as a streak under a 59-degree
       * moon turned the whole road into the brightest thing in the frame at
       * 38 degrees. If the key light's elevation changes, re-check this.
       */
      cobble: { color: "#5f7ba6", intensity: 0.18, shininess: 8 },
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
     * A grenade going off. Unbudgeted, unlike the muzzle flashes above, and it
     * can be: there is one blast every few seconds at the very most, against
     * up to eighty muzzle flashes a second, so a transient slot for each one is
     * never the thing that blacks the village out. It is far brighter and far
     * longer than a muzzle flash for the obvious reason — for a third of a
     * second it is the only light in the valley that matters.
     */
    explosionColor: "#ffb45a",
    explosionRange: 28,
    explosionIntensity: 7,
    explosionLife: 0.34,
    /**
     * Shoulder lamp the player carries. Without it these arenas are too dark
     * to fight in between fixtures — and it gives the character a light of
     * their own to be silhouetted against.
     */
    lampColor: "#ffd9a8",
    lampRange: 18,
    lampIntensity: 1.6,
    lampHeight: 1.45,
    /**
     * The kit screen's bench lamps — carried lights that exist only while a
     * weapon is on the loadout turntable, placed relative to the CAMERA
     * (`ahead`/`side`/`up`, metres) rather than anywhere in the world.
     *
     * They are here because the alternative is whatever the moon and the last
     * frame's fixtures happen to be doing to a gun held at hip height in a
     * dark village — and on the one screen whose entire job is to show you the
     * weapon, that is a black silhouette. The weapon's albedo is a night
     * game's albedo, so this is deliberately far brighter than the shoulder
     * lamp: `col = albedo * light` in the cel shader, and a #2a-ish receiver
     * needs light well past 1 before it reads as metal rather than as a hole.
     *
     * Two of them — a warm key above the weapon and a dimmer cool fill from
     * beyond it and below — because a single light flattens the model into one
     * tone, and the hard bands the shader quantises the light into need
     * something to vary across before they read as shape.
     *
     * The short range is load-bearing: the stage is a hole in the kit screen's
     * scrim, so anything these reach is visible behind the weapon.
     */
    kitLamps: [
      { ahead: 1, side: 0, up: 0.62, color: "#ffe8c6", range: 3, intensity: 5.2 },
      { ahead: 1.6, side: 0.75, up: -0.25, color: "#a6bfe0", range: 3, intensity: 2.2 },
    ],
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
    /**
     * Seed for the star field, the galactic band, the moon's maria and the
     * cloud noise. The sky is dressing, not world-building, so nothing here
     * feeds navigation — but a sky that rerolls on every boot makes "is that
     * cloud bank new?" unanswerable while tuning, so it is seeded anyway.
     */
    seed: 0x5eed5c1,
    /** Dome radius. Well under the camera's default 10000 far plane. */
    domeRadius: 600,
    /**
     * Dome texture: width wraps the horizon, height runs pole to pole. The
     * dome is magnified hard — 360 degrees of texture against ~50 degrees of
     * screen — so this is what decides whether a star reads as a point or as
     * a bilinear smudge. At 4096 a 1 px star is still ~2 px on a 1080p screen.
     */
    domeTextureWidth: 4096,
    domeTextureHeight: 2048,
    /** Moon disc radius and its distance along the key-light source dir.
     *  Beyond the cloud shells (so they veil it) and just inside the dome. */
    moonRadius: 32,
    moonDistance: 595,
    /**
     * Emissive scale on the moon colour — above 1 so the GlowLayer blooms it
     * into a proper halo on top of the soft one baked into the dome texture.
     */
    moonEmissiveBoost: 1.9,
    /** Moon disc texture: size, the fraction of the radius that is limb
     *  falloff (a hard circle reads as a sticker), and how many maria. */
    moonTextureSize: 256,
    moonLimbFraction: 0.16,
    moonMaria: 11,
    /**
     * The scattering halo baked into the dome, as a fraction of the dome
     * texture's HEIGHT (i.e. of 180 degrees of sky): a wide, faint bloom of
     * moonlight in the air, plus the tight core inside it. This is the
     * single biggest reason the old sky read as black — a 46 px halo on a
     * 512 px dome is 8 degrees of glow and nothing else.
     */
    haloRadius: 0.42,
    haloCore: 0.09,
    haloStrength: 0.5,
    /**
     * Largest star dot, in texture px; most stars are drawn far smaller.
     * Keep it near a pixel: the dome is magnified, so a dot drawn much bigger
     * than this comes out as a soft bokeh ball rather than a star.
     */
    starMaxSize: 1.6,
    /**
     * Stars inside this fraction of the halo radius are washed out by it,
     * the way they are under a real moon — and, more practically, so the
     * brightest part of the sky doesn't turn into visual noise.
     */
    starMoonWash: 0.8,
    /** Bright stars (the top of the magnitude curve) get diffraction spikes. */
    starSpikeFraction: 0.06,
    starSpikeLength: 7,
    /**
     * The galactic band: a great circle of dust drawn as overlapping soft
     * blobs plus its own dense star field, tilted off the horizon.
     */
    milkyWayTilt: 0.6,
    milkyWayBlobs: 260,
    milkyWayWidth: 0.1,
    milkyWayStars: 900,
    /**
     * Cloud decks: sphere shells just inside the dome (a plane would show
     * its edges as a hard square hanging in the sky). Each carries a
     * tileable fBm cloud mask and scrolls it azimuthally; `speedU` is uv per
     * second (a full circuit takes ~5-10 minutes — clouds should drift, not
     * fly), `uScale` is the texture repeat around the horizon, `radiusOffset`
     * how far inside the dome the shell floats, `opacity` multiplies the map
     * spec's `cloudOpacity`, and `coverage` is the fBm threshold: LOWER is
     * more cloud, and above ~0.6 the deck breaks into wisps.
     */
    cloudTextureWidth: 1024,
    cloudTextureHeight: 512,
    /** Noise: base lattice cells across the sphere, and octaves above it. */
    cloudLattice: 4,
    cloudOctaves: 5,
    /**
     * Width of the fBm ramp at the coverage threshold — edge softness.
     *
     * This is also what hides the mask's resolution. The deck texture is
     * magnified ~9x on screen (1024 texels around the horizon against ~50
     * degrees of view), and bilinear magnification of a HARD alpha contour
     * comes out as straight-edged wedges and diamonds — which read as torn
     * paper, not as cloud. A wide ramp turns the contour into a gradient,
     * which magnifies cleanly and costs nothing.
     */
    cloudSoftness: 0.5,
    /**
     * Latitude band the deck occupies, in dome-texture rows (0 = zenith,
     * 0.5 = horizon). It stops short of the horizon because the valley ridge
     * hides the last few degrees, and short of the zenith because a deck
     * directly overhead hides the moon from every angle.
     */
    cloudBandTop: 0.08,
    cloudBandBottom: 0.47,
    /** Shell tessellation. The moonlit mask is per-vertex, so this is what
     *  decides how smooth the lit patch's falloff looks. */
    cloudSegments: 48,
    /**
     * Tightness of the moonlit patch: the exponent on dot(vertex, moonDir).
     * Low is a whole hemisphere of silver (soupy), high is a hard spot.
     */
    cloudLitPower: 8,
    cloudLayers: [
      { radiusOffset: 12, uScale: 1, speedU: 0.0035, opacity: 1.0, coverage: 0.6 },
      { radiusOffset: 26, uScale: 2, speedU: -0.0018, opacity: 0.5, coverage: 0.68 },
    ],
  },

  /**
   * Moon shafts (src/shaders/GodRays.ts): screen-space radial blur of the
   * bright parts of the frame away from the moon, so anything standing
   * between the camera and it cuts visible beams out of the haze.
   *
   * The pass costs `samples` texture fetches per pixel, so it early-outs
   * entirely when the moon is off screen or behind the camera — which is most
   * of the time in a fight.
   */
  godRays: {
    /** Taps along each ray. The look is set by density/decay, not by this. */
    samples: 32,
    /** How far along the ray the taps reach, in screen widths. */
    density: 0.55,
    /** Per-tap falloff — how quickly a beam fades away from the moon. */
    decay: 0.96,
    /** Weight per tap, before decay. */
    weight: 0.32,
    /** Final scale on the accumulated shafts. */
    intensity: 1.3,
    /**
     * Luminance a pixel needs before it radiates. This is the whole occlusion
     * test — there is no depth pass — so it has to sit above the brightest
     * thing in the world that is NOT sky. That is the wet cobbled street,
     * which comes back around 0.67 when you look along the moon; below this
     * the road smears upward and the frame fills with haze from the ground.
     */
    threshold: 0.78,
    /**
     * The shafts fade out as the moon leaves the frame — measured in screen
     * radii from the centre, since the blur has nothing to sample once the
     * source is off screen and popping is the alternative.
     */
    fadeStart: 0.55,
    fadeEnd: 1.25,
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
