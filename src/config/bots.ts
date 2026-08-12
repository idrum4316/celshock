/**
 * config/bots.ts — bot AI, and the nav grid it steers on.
 * Owns: squad sizes, skill tiers, perception, cover, the think budget and the
 * LOD/ragdoll gates. Contract: `docs/bots.md`.
 * Gotcha: three numbers here carry the frame budget — `thinkRate`, the rig
 * pool size and `lodDisableDistance`. Loosening any of them costs ~10x draw
 * calls or a permanent hitch.
 */

import { FOG_WALL } from "./fogWall";

/** Bot roster, AI cadence, and the render LOD that makes 16 of them viable. */
export const bots = {
  /** Per team. The rig pool is sized to exactly `perTeam * 2`. */
  perTeam: 8,
  squadSize: 4,
  maxHealth: 100,
  /**
   * The body sphere a round is tested against, about `Bot.center`. This is the
   * number `bots.cover.height` is derived from — the top of the sphere is
   * `centerHeight + hitRadius` = 0.9 + 0.75 = 1.65 m, and cover baked any lower
   * leaves a bot visible but unhittable.
   *
   * Here rather than as a literal on `Bot` because three separate pieces of
   * reasoning in this file and in `weapons.ts` are written against its value,
   * and none of them could read it.
   */
  hitRadius: 0.75,
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
  /**
   * The far end of the bot round's fall-off, and the run to it. Bots carry no
   * weapon from `CONFIG.weapons` — they fire one flat round — so these three
   * numbers are the whole of their damage curve, the same shape every weapon
   * in that table now has.
   *
   * The run is deliberately fitted to the band bots actually shoot in rather
   * than to `range`: they will not open fire past `engageRange` (55) and back
   * off inside `minEngageRange` (6), so a ramp ending at 70 would spend most
   * of itself where nothing is ever fired. 18 to 50 puts the whole curve
   * inside the fight, and 17 is a six-shot kill at the far edge of one.
   *
   * **This makes the game easier and that is the point.** Sixteen bots that
   * hit for 25 at any distance mean a crossed square is a coin toss no
   * movement can improve; the same bots falling to 17 at 50 m mean closing,
   * breaking a sightline and holding an angle are all worth something.
   * `damageFar: 25` restores the old behaviour exactly.
   *
   * Note the knife edge, which the sidearm shares: 25 x 4 is exactly 100, so
   * there is no headroom and the first centimetre past `falloffNear` costs a
   * whole round. Bots are a four-shot kill inside 18 m, five to 38, six
   * beyond — a clean staircase, but it means anything that moves `damage`
   * off 25 moves all three treads by metres.
   */
  damageFar: 17,
  falloffNear: 18,
  falloffFar: 50,
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
   * Distance past which the rig is not drawn at all — the fog wall, where
   * there is nothing to see. The bot keeps integrating, so the battle line
   * still moves out there; only the drawing and posing stop.
   */
  lodDisableDistance: FOG_WALL,

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
   * Dying: the ragdoll, and the collapse tween it falls back to.
   *
   * The ragdoll is Havok-powered and strictly cosmetic — nothing here feeds
   * navigation, cover or hit detection, so a machine where the WASM never
   * loads plays an identical round with the tween instead.
   *
   * That tween came first and is still the floor under everything here: it
   * runs whenever physics is unavailable, out of budget, or too far away to
   * be worth simulating, so `collapseTime`/`hideTime` are load-bearing rather
   * than legacy. They were hardcoded in `Bot.update` and are here now because
   * this file's own header says they should be.
   *
   * The ragdoll's SHAPE — which joints are bones, how big they are, where
   * they pin and how far they may swing — is NOT here. That is measured off
   * the rig's own boxes and lives with them in `SoldierModel.ts`, the same
   * split the header draws between gameplay tunables and art.
   */
  death: {
    /**
     * Seconds for the fallback collapse to pitch forward and sink, and when
     * the rig is hidden afterwards. The 0.2 s gap is the body lying still
     * for a beat, so it does not vanish on the frame it lands.
     */
    collapseTime: 0.7,
    hideTime: 0.9,
    /** Master switch. False keeps the tween everywhere. */
    ragdoll: true,
    /**
     * Bodies simulating at once. The next death takes the tween rather than
     * stealing a live slot — the same refusal `GrenadeSystem`'s pool makes,
     * and for the same reason: a corpse yanked out of a tumble is worse than
     * one that never tumbled. A slot already sinking is committed to
     * vanishing and may be reclaimed. The death cam's own body is the one
     * exception and takes the oldest corpse; see `RagdollSystem.takeSlot`.
     *
     * Eight is two squads, and it is now MEASURED rather than reasoned about.
     * Four was a guess made against FINDINGS.md #8's 1.37 ms for four falling
     * bodies — 5-6x the whole roster's AI — which does not reproduce. Timing
     * `ragdolls.update(1/60)` over 1,600 frames inside the fall, headless,
     * against `battle.update` for all 16 bots in the same run:
     *
     *   0 corpses 0.000 ms | 1: 0.033 | 2: 0.033 | 4: 0.062 | 6: 0.095
     *   8: 0.121 ms, against the roster's 0.39-0.42 ms
     *
     * So a falling corpse is ~0.015 ms and eight of them is under a third of
     * the AI, not several times it. Three things bound it: the fall is ~1.1 s
     * and a settled corpse costs 0.0004 ms/frame (the engine is not stepped at
     * all), the count is capped here, and the unused slots are free — four
     * corpses cost 0.061 ms in a pool of four and 0.062 ms in a pool of eight,
     * so raising this only ever costs when the bodies are actually falling.
     *
     * Headless absolutes are inflated the same way FINDINGS #6's are, and
     * `update(1/60)` is exactly one substep — a 30 fps frame takes two. Treat
     * the RATIO to the roster as the trustworthy part.
     */
    maxConcurrent: 8,
    /**
     * No ragdoll past this, measured ONCE at the moment of death — a corpse
     * does not move, and re-testing per frame would switch a tumble off
     * halfway through because the player backed away.
     *
     * It is the FOG WALL, and it is the same number as `lodDisableDistance`
     * BY CONSTRUCTION rather than by coincidence: that is where the rig stops
     * being drawn, so one metre further is a solver tumbling something the
     * player cannot see. Every death inside the fog is now eligible, which is
     * what a marksman rifle needs — its own range is bounded by the same wall.
     *
     * It is deliberately NOT `lodFreezeDistance` (35), which is what this was
     * pinned to and why nothing dying across the square ever fell over. That
     * LOD only skips `animateSoldier`, and `Bot.update`'s dead branch already
     * skips it while `ragdolling` — a ragdoll poses through the proxy nodes
     * its joints are parented to, which the solver writes whatever the LOD
     * says. Verified: a corpse at 50 m driven through the real
     * `BattleSystem.update` tumbles from a 0.64 m standing joint spread to
     * 0.002 m face-down on the floor, rig still enabled.
     *
     * This costs nothing per frame on its own — `maxConcurrent` is what
     * bounds the solver — but it does keep the pool busier, which is the
     * other half of why that went up with it.
     */
    maxDistance: FOG_WALL,
    /** Matches the grenade's exaggerated fall, not the player's. */
    gravity: -18,
    /**
     * Fixed simulation step, and the most catch-up allowed in one frame.
     *
     * Fixed rather than the frame's own `dt`, which is what makes a tumble
     * identical at 30, 60 and 144 fps — and reproducible headless, where the
     * clamp at 0.05 would otherwise make every recorded death a different
     * one. `maxSteps` bounds the spiral when a frame runs long.
     */
    substep: 1 / 60,
    maxSteps: 2,
    linearDamping: 0.15,
    /** High: a corpse that spins like a top is the funniest failure here. */
    angularDamping: 0.6,
    friction: 0.8,
    /** Near zero. A bouncing body is the second funniest. */
    restitution: 0.02,
    /**
     * The throw. `from` is the shooter's eye or the blast centre, so the
     * direction comes free; the magnitude scales with the blow, which is what
     * makes a 130-damage frag throw a body and a 25-damage round drop it.
     * Applied `lift` above the centre of mass, so the tumble falls out of the
     * off-centre application rather than needing an authored spin.
     *
     * `spin` is a seeded angular kick that breaks the symmetry of two
     * identical deaths. It is drawn from the ragdoll pool's own generator —
     * never Math.random, which would make a death impossible to reproduce,
     * and deliberately not the dying body's, which would put a bot's own
     * behaviour stream downstream of whether its corpse was accepted.
     */
    impulse: { base: 6, perDamage: 0.06, max: 22, lift: 0.25, spin: 1.2 },
    /**
     * Hard stop on simulating, and the early-out for a body that stopped
     * moving on its own. Once every bone is under `sleepSpeed` AND
     * `sleepSpin` for `sleepTime` the corpse is frozen into its pose and
     * costs nothing.
     *
     * Both thresholds, because freezing commits to a POSE: a body settled on
     * its back and still turning has almost no linear velocity, and the
     * speed test alone would bake whichever angle it was passing through.
     * `angularDamping` (0.6) is what makes the spin term cheap — it is
     * usually the first of the two to go quiet.
     */
    settleTime: 2.5,
    sleepSpeed: 0.12,
    sleepSpin: 0.5,
    sleepTime: 0.4,
    /**
     * Seconds after death that the body starts to go, how long that takes,
     * and how far it drops.
     *
     * It SINKS rather than fading, and that is forced rather than chosen: the
     * cel shader writes alpha 1.0 outright, and its materials are shared per
     * COLOUR by `CelMaterialFactory`, so an alpha write would dim every bot
     * on the map along with this one. Sinking through the floor is what the
     * collapse tween always did.
     *
     * 5 + 1 = gone at 6 s against `conquest.respawnDelay` of 8. Keep the two
     * seconds of margin: the rig is recycled at `respawnDelay`, and a corpse
     * still standing when `Bot.spawn` runs is a body that teleports.
     */
    sinkStart: 5,
    sinkTime: 1,
    sinkDepth: 1.2,
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
} as const;

/** Navigation grid covering the whole map. */
export const nav = {
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
} as const;
