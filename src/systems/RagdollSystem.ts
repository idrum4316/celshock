/**
 * RagdollSystem.ts — Physics-driven deaths: the ONLY thing in this game that
 * runs a physics engine, and the only place `@babylonjs/havok` is reached.
 * Owns the Havok world, the static map registered into it, a pool of corpses,
 * and the hand-off of a rig's joints to the solver and back.
 *
 * It holds `RagdollSubject`s, not `Bot`s, and deliberately cannot tell the two
 * kinds apart: a bot killed in the fight and the stand-in body `DeathCam`
 * stands up where the player fell are the same thing to this file. Every rule
 * below applies to both, which is what stopped the player's corpse needing a
 * second copy of any of it.
 *
 * Invariants, each of which has a way of failing silently:
 * - `scene.physicsEnabled` is FALSE and stays false. Babylon steps physics from
 *   `scene.animate()` on every RENDERED frame, and this game renders under the
 *   menu, the deploy map and a pause — so a scene-driven step would be the one
 *   thing still moving behind a pause card. Stepping is `update()`'s job and is
 *   only ever called from `Game.updateGameplay`.
 * - Havok never touches a rig node. It writes POOL-OWNED PROXY nodes and the
 *   rig's joints are parented to those, because Havok's sync force-creates a
 *   `rotationQuaternion` on any node with a parent — and while one is set
 *   Babylon ignores `rotation`, which is what `animateSoldier` writes. One
 *   leaked quaternion is a bot frozen mid-tumble for the rest of the round.
 * - Nothing here feeds navigation, cover, or hit detection. A corpse is not in
 *   `NavGrid`, not in `ObstacleField`, not in `hittablesAgainst`. Bots walk
 *   through bodies and rounds pass through them, exactly as they did before
 *   this file existed. Do NOT "fix" that by feeding corpses into
 *   `ObstacleField` — its buckets are baked at map load for a reason.
 * - It is strictly cosmetic and always optional. Every refusal (WASM not
 *   loaded, WASM failed, setting off, pool full, too far away) falls back to
 *   `Bot`'s collapse tween, which is why that tween is load-bearing rather
 *   than legacy. The death cam's body is the ONE thing that may not be refused
 *   for a full pool — it is the sole subject of a four-second shot — and
 *   `takeSlot` is where that exception lives and where it stops.
 * - The sim is a FIXED step with a CARRIED remainder, so a tumble is identical
 *   at 30, 60 and 144 fps and reproducible headless, where `dt` is clamped to
 *   0.05. Both halves of that are load-bearing and both have already been
 *   wrong — see `update` and `init`.
 */
import {
  HavokPlugin,
  Mesh,
  PhysicsBody,
  PhysicsConstraintAxis,
  PhysicsMotionType,
  PhysicsShape,
  PhysicsShapeBox,
  PhysicsShapeContainer,
  PhysicsShapeMesh,
  Physics6DoFConstraint,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { CONFIG, FOG_WALL } from "../config";
import {
  RAGDOLL_BONES,
  RAGDOLL_LINKS,
  resetSoldierPose,
  type BoneJoint,
  type RagdollSubject,
  type SoldierRig,
} from "../entities/SoldierModel";
import type { GameMap } from "../world/MapBuilder";
import { mulberry32 } from "../world/rng";

/** Where the WASM has got to. `spawn` only accepts in `ready`. */
type InitState = "idle" | "loading" | "ready" | "failed";

/** One bone of one pooled corpse. */
interface Bone {
  joint: BoneJoint;
  /** The node Havok writes. The rig's joint is parented to it while active. */
  proxy: TransformNode;
  body: PhysicsBody;
}

/** One corpse's worth of bodies, reused for the life of the process. */
interface Slot {
  bones: Bone[];
  constraints: Physics6DoFConstraint[];
  /** Null when the slot is free. */
  subject: RagdollSubject | null;
  rig: SoldierRig | null;
  /** Seconds since this corpse was taken. */
  t: number;
  /** Seconds the whole body has been under `sleepSpeed`. */
  stillT: number;
  /**
   * True once the pose is baked back into the rig's hierarchy and the bodies
   * have stopped. A frozen corpse is still a corpse — it lies there costing one
   * property write — which is why this is NOT the same thing as `sinking`.
   */
  frozen: boolean;
  /**
   * True once the body has started going. This is the one that makes a slot
   * reclaimable: a corpse on its way out may be cut short, a corpse merely
   * lying still may not.
   */
  sinking: boolean;
  /** `rig.root.position.y` when the sink started, so the drop is absolute. */
  sinkFromY: number;
  /** Each bone's parent in the rig it is currently holding — see `freeze`. */
  restParent: Map<BoneJoint, TransformNode>;
}

const UP = new Vector3(0, 1, 0);

/** Where a body waits between corpses — see `park`. */
const PARKED_Y = -1000;

/**
 * The pool's own stream, re-seeded per round. It is deliberately NOT the
 * subject's: `Bot.rand` also drives grenade chance, throw scatter and strafe
 * direction, so drawing the tumble's jitter from it made a bot's BEHAVIOUR
 * depend on whether a corpse near it was accepted — which turns on the camera
 * distance, the pool's occupancy, the settings toggle and whether the WASM
 * loaded. A seeded round has to play out the same way twice, and that is the
 * one thing the seed is for.
 */
const SPIN_SEED = 0x5eed;

export class RagdollSystem {
  private state: InitState = "idle";
  // `IPhysicsEngine` is not on the barrel export and this file keeps to barrel
  // imports like every other, so the type comes from the getter that produces
  // it. CONFIG is `as const`, hence the annotation on a field meant to change.
  private engine: ReturnType<Scene["getPhysicsEngine"]> = null;
  /**
   * Held as the concrete plugin rather than reached through
   * `engine.getPhysicsPlugin()`, whose type is the union of the v1 and v2
   * interfaces and carries neither of the two things this file needs of it:
   * the world's real step length, and an immediate transform write (`park`).
   */
  private plugin: HavokPlugin | null = null;
  private enabled: boolean = CONFIG.bots.death.ragdoll;
  /**
   * Past this a body is not worth tumbling, because it is not worth drawing —
   * the map's `fogEnd`, pushed by `Game.installMap` beside the same number
   * going to `BattleSystem` and `NetRoster`. It is the fog wall by
   * construction rather than by coincidence (see `bots.death.maxDistance`),
   * and the construction is that all three read the one distance the map
   * paints; `CONFIG` holds what a map with no opinion gets.
   */
  private viewDistance = FOG_WALL;
  /** Sim time owed but not yet stepped — see `update`. */
  private accum = 0;
  /** The tumble's jitter. See `SPIN_SEED`. */
  private rand: () => number = mulberry32(SPIN_SEED);

  /** Every bone shape in the pool, held flat for disposal — see `buildShapes`. */
  private shapes: PhysicsShape[] = [];
  private slots: Slot[] = [];

  /** The map as one static body: a container of every collider in the world. */
  private worldNode: TransformNode | null = null;
  private worldBody: PhysicsBody | null = null;
  private worldShape: PhysicsShapeContainer | null = null;
  private worldLeaves: PhysicsShape[] = [];
  /** Held so a map installed before the WASM resolved is still registered. */
  private pendingMap: GameMap | null = null;

  // Scratch — this runs every frame with up to `maxConcurrent` corpses live,
  // and FINDINGS.md #7 already measures 13.4 KB/frame of churn.
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly scratchScale = new Vector3();
  private readonly scratchQuat = new Quaternion();

  constructor(private scene: Scene) {}

  /** True once physics is up. Read before offering a corpse. */
  get ready(): boolean {
    return this.state === "ready";
  }

  /** How many corpses are simulating. Test hook. */
  get activeCount(): number {
    return this.slots.reduce((n, s) => n + (s.subject ? 1 : 0), 0);
  }

  /**
   * The player's toggle. Off drops every body still falling — the honest
   * response to "stop doing this" — and gives back the static world, which is
   * the only part of this that costs anything per round.
   *
   * The WASM load is deliberately NOT gated with it. The binary is precached
   * with the rest of the build whether or not it is ever used, so refusing to
   * instantiate the engine would save a one-off rather than the download, and
   * it would put a first-death-after-enabling on the tween while the module
   * resolved.
   */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) {
      this.reset();
      this.clearWorld();
      return;
    }
    if (this.state === "ready" && this.pendingMap) {
      this.buildWorld(this.pendingMap);
    }
  }

  /**
   * Starts the WASM load. Never awaited, never throws — a failure leaves the
   * game running on the collapse tween and says so once.
   *
   * The import is dynamic so Havok's glue stays out of the main chunk's parse.
   * Unlike `src/editor/`, it is deliberately NOT `import.meta.env.DEV`-gated:
   * this ships.
   *
   * Nothing here names the `.wasm`, and it must not. Havok's ESM glue resolves
   * the binary against its own `import.meta.url`, which Vite follows at build
   * time and emits as a CONTENT-HASHED asset — so the binary is versioned with
   * the dependency and needs no `locateFile`. Putting a hand-placed copy in
   * `public/` as well is not belt-and-braces, it is two megabytes shipped and
   * precached twice; measured exactly that before it was taken out again.
   */
  init(): void {
    if (this.state !== "idle") return;
    this.state = "loading";
    import("@babylonjs/havok")
      .then((m) => m.default())
      .then((havok) => {
        // `false` = do NOT use the frame delta for the world step. The plugin
        // then ignores whatever it is handed and advances a fixed amount,
        // which is what makes a tumble frame-rate independent.
        const plugin = new HavokPlugin(false, havok);
        // ...and THIS is the amount. The argument to `_step` is discarded in
        // this mode (`executeStep`: `_useDeltaForWorldStep ? delta :
        // _fixedTimeStep`), so without this line `death.substep` is not the
        // step length at all — it only divides the frame, and the world
        // advances by the plugin's own default of 1/60 however many times
        // that comes to. The two agreed by coincidence, so the knob was inert:
        // lowering it to 1/120 for a finer tumble would have run the sim at
        // double speed instead. Verified before this line existed by stepping
        // with 1/600 and 1/10 and measuring the same 2.5 m fall in 30 steps.
        plugin.setTimeStep(CONFIG.bots.death.substep);
        this.scene.enablePhysics(
          new Vector3(0, CONFIG.bots.death.gravity, 0),
          plugin,
        );
        // enablePhysics sets this true. It must not stay true — see the header.
        this.scene.physicsEnabled = false;
        this.engine = this.scene.getPhysicsEngine();
        this.plugin = plugin;
        this.buildPool();
        this.state = "ready";
        if (this.enabled && this.pendingMap) this.buildWorld(this.pendingMap);
      })
      .catch((err) => {
        this.state = "failed";
        console.warn(
          "Havok unavailable — deaths fall back to the collapse tween.",
          err,
        );
      });
  }

  /**
   * `installMap`'s hook: drop last build's static world and register this one.
   *
   * Called for every map build, and it must be, because the alternative is a
   * physics world holding shapes built from a DISPOSED map's geometry — the
   * silent failure `installMap`'s own note is about.
   *
   * Editor builds are skipped outright: there are no corpses in the editor and
   * a tier-3 rebuild is already ~570 ms. So is a map installed while the
   * setting is off — the build is 33–50 ms of shape work EVERY round, and
   * nothing will ever fall on it; `setEnabled` puts it up if the player
   * changes their mind, which is what `pendingMap` is held for.
   */
  /** See `viewDistance`. Pushed with the map, not read from CONFIG. */
  setViewDistance(metres: number): void {
    this.viewDistance = metres;
  }

  setMap(map: GameMap | null, editor: boolean): void {
    this.reset();
    this.clearWorld();
    this.pendingMap = editor ? null : map;
    if (this.enabled && this.state === "ready" && this.pendingMap) {
      this.buildWorld(this.pendingMap);
    }
  }

  /**
   * Offer a dead body to the pool. Returns false if it was refused, and the
   * caller must then run the collapse tween instead — `Bot`'s, or the death
   * cam's copy of it for the player's corpse.
   *
   * Distance is sampled ONCE, here: a corpse does not move, and re-testing per
   * frame would switch a tumble off halfway through because the player backed
   * away from it.
   *
   * `priority` is the death cam's, and nothing else may pass it — see
   * `takeSlot`. It buys a slot when the pool is full and buys nothing else:
   * the distance gate and the already-held test are ahead of it, because a
   * body offered twice is broken however important it is.
   */
  spawn(subject: RagdollSubject, camPos: Vector3, priority = false): boolean {
    if (!this.enabled || this.state !== "ready" || !this.worldBody) return false;
    if (Vector3.Distance(subject.position, camPos) > this.viewDistance) {
      return false;
    }
    // A body already held is not offered twice. `registerBotKill` is the one
    // caller and fires once, but a rig in two slots would be two sets of
    // bodies fighting over the same joints.
    if (subject.ragdolling || this.slots.some((s) => s.subject === subject)) {
      return false;
    }
    // A crouched body is NOT refused, and the bone table is what earns that.
    // A leg was one rigid 0.72 m segment oriented by the hip joint until it had
    // a knee and an ankle of its own, and a body caught mid-crouch would have
    // been thrown with two planks sticking forward out of its hips, propping a
    // corpse up off geometry its own drawn legs were nowhere near. There was no
    // pose that fixed it — straight legs under lowered hips reach through the
    // floor, and lifting the hips to meet them is half a metre of pop on the
    // frame of death — so the refusal stood in for the missing joints. The
    // joints exist now (`RAGDOLL_BONES`), the proxies below take whatever pose
    // the rig is in, and the one stance a player is most likely to be shot in
    // falls over like every other.
    const slot = this.takeSlot(priority);
    if (!slot) return false;

    const rig = subject.rig;
    slot.subject = subject;
    slot.rig = rig;
    slot.t = 0;
    slot.stillT = 0;
    slot.frozen = false;
    slot.sinking = false;
    slot.sinkFromY = rig.root.position.y;
    // Where each joint has to go back to, taken from the rig's own build-time
    // snapshot rather than from the node's current parent, so a rig that was
    // somehow left half-restored cannot quietly bake the wrong hierarchy in.
    slot.restParent.clear();
    for (const bone of slot.bones) {
      const rest = rig.rest.find((r) => r.node === rig[bone.joint]);
      if (rest) slot.restParent.set(bone.joint, rest.parent);
    }
    subject.ragdolling = true;
    // The rig must be visible for the corpse to be worth simulating; the LOD
    // in BattleSystem re-enables it every frame while `state === "dead"`.
    subject.setEnabled(true);

    for (const bone of slot.bones) {
      const joint = rig[bone.joint];
      // Place the proxy exactly where the joint currently is in the world, so
      // the ragdoll starts in the pose the bot died in rather than in a T-pose.
      joint.computeWorldMatrix(true);
      joint
        .getWorldMatrix()
        .decompose(this.scratchScale, this.scratchQuat, this.v1);
      bone.proxy.position.copyFrom(this.v1);
      bone.proxy.rotationQuaternion!.copyFrom(this.scratchQuat);
      // Parent the joint UNDER the proxy. setParent preserves the world
      // transform by writing a local TRS, and — verified against Babylon's
      // implementation — writes Euler when there is no quaternion, so the rig
      // stays quaternion-free through both this and the hand-back.
      joint.setParent(bone.proxy);

      // The body is pooled and still carries the last corpse's motion.
      bone.body.setLinearVelocity(Vector3.ZeroReadOnly);
      bone.body.setAngularVelocity(Vector3.ZeroReadOnly);
      bone.body.setMotionType(PhysicsMotionType.DYNAMIC);
      // Two-phase teleport: one step reads the node into the sim, then the sim
      // owns it. `setTargetTransform` is NOT this — it is a kinematic target
      // the body accelerates toward.
      bone.body.disablePreStep = false;
    }

    this.applyImpulse(slot, subject);
    return true;
  }

  /**
   * Steps the sim, ages every corpse, sinks the settled ones and retires them.
   * Called ONLY from `Game.updateGameplay`, which is what holds the whole
   * thing still under a pause and under the deploy screen.
   */
  update(dt: number): void {
    if (this.state !== "ready" || !this.engine) return;
    const d = CONFIG.bots.death;

    // Step only while something is still moving. Once every corpse has frozen
    // the engine is not touched at all.
    const simulating = this.slots.some((s) => s.subject && !s.frozen);
    if (!simulating) {
      // Nothing owes any time, and a remainder carried across a lull would
      // give the next corpse a free part-step on the frame it died.
      this.accum = 0;
    } else {
      // Fixed steps with the REMAINDER CARRIED, bounded so a long frame cannot
      // spiral. Carrying it is what makes the step fixed at all: spending the
      // frame instead — `left = dt`, step until it runs out — rounds every
      // frame UP to a whole substep, so the sim advances `ceil(dt / substep)`
      // steps, which is one at any rate above 60 fps and two at anything just
      // under it. Measured over a second of wall clock before this: 60 steps
      // at 30 fps and at a clean 60, but 118 at 59 and one per frame at 144 —
      // a tumble at 2x and 2.4x speed, jittering between the two on a real
      // 60 Hz display as `dt` crosses 1/60. `maxSteps` still bounds the
      // catch-up, which is what makes a headless run at 2 fps play in slow
      // motion rather than teleporting bodies across the map.
      this.accum = Math.min(this.accum + dt, d.substep * d.maxSteps);
      let first = true;
      while (this.accum >= d.substep) {
        this.engine._step(d.substep);
        this.accum -= d.substep;
        // The teleport is read in on the FIRST step and no other; from here
        // the sim owns the bodies and must not be overwritten by their nodes.
        // Inside the loop rather than after it: a frame running two steps
        // would otherwise re-teleport a fresh corpse onto the transform step
        // one had just synced back, which Havok does not come out of in the
        // state it went in — 0.13 m of divergence between 30 and 60 fps over
        // half a second, on an identical body with an identical impulse. It
        // cannot be hoisted to "the first step ever" either: a corpse taken on
        // a later frame has its own teleport to read in.
        if (first) {
          first = false;
          for (const slot of this.slots) {
            if (!slot.subject || slot.frozen) continue;
            for (const bone of slot.bones) bone.body.disablePreStep = true;
          }
        }
      }
    }

    for (const slot of this.slots) {
      if (!slot.subject || !slot.rig) continue;
      // The rig was recycled out from under us. It should not be possible —
      // a corpse is gone at `sinkStart + sinkTime` (6 s) and Conquest wants
      // the rig at `respawnDelay` (8 s) — but the failure if it ever were is
      // a slot re-parenting a LIVE bot's joints for the rest of the round, so
      // it is checked here rather than left to that margin holding.
      if (slot.subject.alive) {
        this.release(slot);
        continue;
      }
      slot.t += dt;
      // Stop simulating as soon as it has come to rest, or at the hard stop.
      if (!slot.frozen && (this.hasSettled(slot, dt) || slot.t > d.settleTime)) {
        this.freeze(slot);
      }
      if (slot.t < d.sinkStart) continue;
      // Its time is up. Freezing first is what makes the sink one write.
      if (!slot.frozen) this.freeze(slot);
      if (!slot.sinking) {
        slot.sinking = true;
        slot.sinkFromY = slot.rig.root.position.y;
      }
      const k = Math.min(1, (slot.t - d.sinkStart) / d.sinkTime);
      // Eased, so the body starts going rather than dropping on one frame.
      slot.rig.root.position.y = slot.sinkFromY - d.sinkDepth * k * k;
      if (k >= 1) this.release(slot);
    }
  }

  /**
   * Where a downed body's shadow goes, and how strong. 0 means "not mine" —
   * which is every bot this system is not holding, so an unwired `ShadowSystem`
   * behaves exactly as it did before.
   */
  shadowFor(subject: RagdollSubject, out: Vector3): number {
    const slot = this.slots.find((s) => s.subject === subject);
    if (!slot || !slot.rig) return 0;
    const d = CONFIG.bots.death;
    out.copyFrom(slot.rig.torso.getAbsolutePosition());
    if (slot.t <= d.sinkStart) return 1;
    // Fades with the body rather than snapping off under it.
    return Math.max(0, 1 - (slot.t - d.sinkStart) / d.sinkTime);
  }

  /**
   * Drops ONE body early, if this pool is holding it. Idempotent, and a no-op
   * for a body it never took — so a caller may offer and retire without ever
   * checking which of the six refusals it hit.
   *
   * A bot never needs this: its corpse outlives the death cam's whole window
   * and retires on its own clock. The player's does, because the deploy screen
   * comes up over the top of it and a body left lying there would come back
   * mid-sink on the next life.
   */
  retire(subject: RagdollSubject): void {
    const slot = this.slots.find((s) => s.subject === subject);
    if (slot) this.release(slot);
  }

  /**
   * Drops every corpse and restores every rig. Round start and map rebuild.
   *
   * Re-seeds the jitter with it, so the same round twice throws its bodies the
   * same way — the stream is the pool's, so the only thing it could otherwise
   * carry across is how many people died last round.
   */
  reset(): void {
    for (const slot of this.slots) if (slot.subject) this.release(slot);
    this.rand = mulberry32(SPIN_SEED);
    this.accum = 0;
  }

  dispose(): void {
    this.reset();
    this.clearWorld();
    for (const slot of this.slots) {
      for (const c of slot.constraints) c.dispose();
      for (const b of slot.bones) {
        b.body.dispose();
        b.proxy.dispose();
      }
    }
    this.slots = [];
    for (const s of this.shapes) s.dispose();
    this.shapes = [];
  }

  // --- construction -------------------------------------------------------

  /**
   * One shape per bone for ONE slot, in that slot's own collision group.
   *
   * Per slot rather than one set shared by every corpse, and the group is why.
   * A ragdoll's own bones overlap by construction — a folded leg lies the shin
   * along the thigh and puts the boot inside it — so a corpse that collided
   * with itself would spend the frame it was thrown on shoving its own limbs
   * apart. Filtering is the only way to say that: the mask lives on the SHAPE,
   * so a shape shared between slots could only turn every corpse's
   * self-collision off together with every corpse-against-corpse one, and two
   * bodies landing on each other is worth keeping. Bit 0 is left to the world
   * (`PhysicsShape` defaults to membership 1), so slot `i` takes bit `i + 1`
   * and collides with everything except itself.
   *
   * The wrap at 30 is a backstop, not a design: past thirty slots two corpses
   * would share a group and pass through each other, which is the mildest
   * failure available and far better than shifting into the sign bit.
   */
  private buildShapes(slot: number): Map<BoneJoint, PhysicsShape> {
    const d = CONFIG.bots.death;
    const group = 1 << (1 + (slot % 30));
    const shapes = new Map<BoneJoint, PhysicsShape>();
    for (const bone of RAGDOLL_BONES) {
      const shape = new PhysicsShapeBox(
        new Vector3(...bone.center),
        Quaternion.Identity(),
        new Vector3(...bone.size),
        this.scene,
      );
      shape.material = { friction: d.friction, restitution: d.restitution };
      shape.filterMembershipMask = group;
      // Written unsigned, because this crosses into the WASM as a uint32. It
      // reads back out of Havok as the same bits signed (-3 for slot 0), and
      // both forms answer a `&` test identically.
      shape.filterCollideMask = ~group >>> 0;
      shapes.set(bone.joint, shape);
      this.shapes.push(shape);
    }
    return shapes;
  }

  private buildPool(): void {
    const d = CONFIG.bots.death;
    for (let i = 0; i < d.maxConcurrent; i++) {
      const shapes = this.buildShapes(i);
      const bones: Bone[] = RAGDOLL_BONES.map((spec) => {
        const proxy = new TransformNode(`ragdoll${i}-${spec.joint}`, this.scene);
        // Pre-created so Havok's sync only ever copies into it — the one place
        // a quaternion is allowed to exist anywhere near this rig.
        proxy.rotationQuaternion = Quaternion.Identity();
        proxy.position.y = PARKED_Y;
        const body = new PhysicsBody(
          proxy,
          PhysicsMotionType.STATIC,
          false,
          this.scene,
        );
        body.shape = shapes.get(spec.joint)!;
        body.setMassProperties({ mass: spec.mass });
        body.setLinearDamping(d.linearDamping);
        body.setAngularDamping(d.angularDamping);
        return { joint: spec.joint, proxy, body };
      });

      const byJoint = new Map(bones.map((b) => [b.joint, b]));
      const constraints: Physics6DoFConstraint[] = [];
      for (const [joint, link] of Object.entries(RAGDOLL_LINKS)) {
        if (!link) continue;
        const child = byJoint.get(joint as BoneJoint);
        // The bone this one hangs off, which is the chest for everything above
        // the hips and the segment above for a knee and an ankle. Pinning the
        // whole leg to the chest instead would hold a shin at a fixed offset
        // from the ribs and let it swing there — a corpse whose knee is a
        // second hip.
        const parent = byJoint.get(link.parent);
        if (!child || !parent) continue;
        const c = new Physics6DoFConstraint(
          {
            pivotA: new Vector3(...link.pivot),
            pivotB: Vector3.Zero(),
            // Identical axes on both sides: every joint is at identity
            // relative to its parent in the carried pose, so the standing pose
            // is the ZERO of all three angular axes and the limits below read
            // as plain ranges rather than offsets from an authored rest angle.
            axisA: new Vector3(1, 0, 0),
            axisB: new Vector3(1, 0, 0),
            perpAxisA: new Vector3(0, 1, 0),
            perpAxisB: new Vector3(0, 1, 0),
            // Constrained bodies overlap by construction; letting them collide
            // is what makes a ragdoll jitter itself apart.
            collision: false,
          },
          [
            { axis: PhysicsConstraintAxis.LINEAR_X, minLimit: 0, maxLimit: 0 },
            { axis: PhysicsConstraintAxis.LINEAR_Y, minLimit: 0, maxLimit: 0 },
            { axis: PhysicsConstraintAxis.LINEAR_Z, minLimit: 0, maxLimit: 0 },
            {
              axis: PhysicsConstraintAxis.ANGULAR_X,
              minLimit: link.x[0],
              maxLimit: link.x[1],
            },
            {
              axis: PhysicsConstraintAxis.ANGULAR_Y,
              minLimit: link.y[0],
              maxLimit: link.y[1],
            },
            {
              axis: PhysicsConstraintAxis.ANGULAR_Z,
              minLimit: link.z[0],
              maxLimit: link.z[1],
            },
          ],
          this.scene,
        );
        parent.body.addConstraint(child.body, c);
        constraints.push(c);
      }

      this.slots.push({
        bones,
        constraints,
        subject: null,
        rig: null,
        t: 0,
        stillT: 0,
        frozen: false,
        sinking: false,
        sinkFromY: 0,
        restParent: new Map(),
      });
    }
  }

  /**
   * Registers the whole map as ONE static body carrying a container of every
   * collider — Hollowmere's ~733 boxes plus the floor's own 25 blocks.
   *
   * One body rather than 758: the plugin's per-step sync walks every body in
   * the engine, and while a static one bails out immediately, a list of 25
   * entries is cheaper to walk than one of 783. It is also one thing to tear
   * down, which is what makes the leak on a map rebuild avoidable.
   *
   * A local set of statics around each corpse was the alternative and is worse
   * on both counts that matter: a tumbling body leaves the set and falls
   * through the wall at its edge, and building shapes at the moment of a kill
   * is a hitch on the worst possible frame.
   */
  private buildWorld(map: GameMap): void {
    const container = new PhysicsShapeContainer(this.scene);

    for (const b of map.colliderBoxes) {
      const shape = new PhysicsShapeBox(
        Vector3.Zero(),
        Quaternion.Identity(),
        new Vector3(b.w, b.h, b.d),
        this.scene,
      );
      // MapBuilder.collider writes `mesh.rotation.set(rotX, rotY, 0)` and
      // Babylon's Euler order is yaw-pitch-roll, so this is the same
      // orientation — which is what carries the ramps across for free.
      container.addChild(
        shape,
        new Vector3(b.cx, b.cy, b.cz),
        Quaternion.RotationYawPitchRoll(b.rotY, b.rotX, 0),
      );
      this.worldLeaves.push(shape);
    }

    // The floor is the documented collider exception: a heightfield has no box
    // to stand in for it, so its blocks are mesh clones and come across as
    // mesh shapes. Hollowmere is 25 blocks / ~3,110 triangles in total, and
    // they are static, so the BVH is built once per map and never again.
    for (const mesh of map.terrainColliders) {
      const shape = new PhysicsShapeMesh(mesh as Mesh, this.scene);
      container.addChild(shape);
      this.worldLeaves.push(shape);
    }

    const node = new TransformNode("ragdoll-world", this.scene);
    const body = new PhysicsBody(
      node,
      PhysicsMotionType.STATIC,
      false,
      this.scene,
    );
    body.shape = container;
    this.worldNode = node;
    this.worldBody = body;
    this.worldShape = container;
  }

  private clearWorld(): void {
    this.worldBody?.dispose();
    this.worldShape?.dispose();
    // Every leaf, or the WASM heap grows one map build at a time.
    for (const s of this.worldLeaves) s.dispose();
    this.worldNode?.dispose();
    this.worldLeaves = [];
    this.worldBody = null;
    this.worldShape = null;
    this.worldNode = null;
  }

  // --- lifetime -----------------------------------------------------------

  /**
   * A free slot, or a sinking one — never a live one.
   *
   * The pool REFUSES rather than stealing a body still tumbling, the same rule
   * `GrenadeSystem`'s pool follows and for the same reason: a corpse yanked
   * out of the air mid-fall is worse than one that never fell. A slot already
   * sinking is committed to vanishing, so it is fair game.
   *
   * **`priority` is the one exception, and it belongs to the death cam alone.**
   * A bot's corpse is one of sixteen bodies somewhere on screen; the player's
   * is the sole subject of a four-second shot the camera is about to point at,
   * and a body standing to attention through that is the exact failure
   * `DeathCam`'s header says the state exists to remove. Being refused was not
   * rare either: a slot is held for the whole `sinkStart` (5 s) and only then
   * becomes reclaimable, so four nearby deaths inside five seconds lock the
   * pool — and a player who has just fought hard enough to be killed is
   * usually standing in exactly that. Measured before this: a corpse 0.65 m
   * from the camera refused outright, and accepted on the same offer once the
   * four bot corpses had aged past `sinkStart`.
   *
   * It takes the OLDEST corpse, which is the one nearest its own sink and so
   * the one with least left to lose. Nothing else may pass it: every priority
   * offer costs a body that was already falling, so a second caller would be
   * two claims on one exception and the pool would be back to arbitrary.
   */
  private takeSlot(priority: boolean): Slot | null {
    const free = this.slots.find((s) => !s.subject);
    if (free) return free;
    // Only one already going, never one merely lying still: a corpse that has
    // settled is a corpse the player can see, and yanking it is the pop this
    // whole feature exists to remove.
    const sinking = this.slots.find((s) => s.sinking);
    if (sinking) {
      this.release(sinking);
      return sinking;
    }
    if (!priority || this.slots.length === 0) return null;
    let oldest = this.slots[0];
    for (const s of this.slots) if (s.t > oldest.t) oldest = s;
    this.release(oldest);
    return oldest;
  }

  private applyImpulse(slot: Slot, subject: RagdollSubject): void {
    const imp = CONFIG.bots.death.impulse;
    const chest = slot.bones.find((b) => b.joint === "torso");
    if (!chest) return;

    // Direction is free: `deathFrom` is the shooter's eye or the blast centre.
    // Y is kept, so a round from a rooftop pushes a body down.
    subject.center.subtractToRef(subject.deathFrom, this.v1);
    if (this.v1.lengthSquared() < 1e-6) this.v1.copyFrom(UP);
    this.v1.normalize();
    const mag = Math.min(
      imp.max,
      imp.base + subject.deathDamage * imp.perDamage,
    );
    this.v1.scaleInPlace(mag);

    // Applied ABOVE the centre of mass, so the tumble falls out of the
    // off-centre application instead of needing an authored spin.
    chest.proxy.getAbsolutePosition().addToRef(
      this.v2.copyFrom(UP).scaleInPlace(imp.lift),
      this.v2,
    );
    chest.body.applyImpulse(this.v1, this.v2);

    // A seeded kick so two identical deaths do not fall identically. THIS
    // POOL'S stream — never Math.random, which would make a death impossible
    // to reproduce, and never the subject's own, which is what `SPIN_SEED`
    // is about.
    this.v2.set(
      (this.rand() * 2 - 1) * imp.spin,
      (this.rand() * 2 - 1) * imp.spin,
      (this.rand() * 2 - 1) * imp.spin,
    );
    chest.body.applyAngularImpulse(this.v2);
  }

  /**
   * True once every bone has been under `sleepSpeed` AND `sleepSpin` for
   * `sleepTime`.
   *
   * The spin is not redundant with the speed: a body that has come to rest on
   * its back and is turning on the spot has almost no linear velocity, and
   * freezing it bakes the pose it happened to be passing through. It is the
   * pose that is being committed to here, so the test has to cover every way
   * one can still be changing.
   */
  private hasSettled(slot: Slot, dt: number): boolean {
    const d = CONFIG.bots.death;
    let fastest = 0;
    let spinniest = 0;
    for (const bone of slot.bones) {
      bone.body.getLinearVelocityToRef(this.v1);
      fastest = Math.max(fastest, this.v1.length());
      bone.body.getAngularVelocityToRef(this.v1);
      spinniest = Math.max(spinniest, this.v1.length());
    }
    if (fastest > d.sleepSpeed || spinniest > d.sleepSpin) {
      slot.stillT = 0;
      return false;
    }
    slot.stillT += dt;
    return slot.stillT >= d.sleepTime;
  }

  /**
   * Bakes the settled pose back into the rig's own hierarchy and stops
   * simulating.
   *
   * `setParent` preserves the world transform, so the corpse keeps the shape it
   * landed in — as an ordinary Euler-posed hierarchy under `rig.root`, which is
   * what makes the sink one property write for the whole body.
   *
   * A settled corpse therefore stops being collidable, and that is the right
   * end of the trade rather than an omission: the bodies do not follow the
   * sink (that is the point of baking the pose in), so a corpse left standing
   * in the world would be a ledge that outlives the body a player can see, and
   * anything resting on it would hang in mid-air at `sinkStart`. Two bodies
   * falling at the same time still collide — both are live in the sim.
   */
  private freeze(slot: Slot): void {
    if (slot.frozen || !slot.rig) return;
    const rig = slot.rig;
    for (const bone of slot.bones) {
      // Before the park, and it has to be: `setParent` derives the local
      // transform from the joint's world matrix, which hangs off the proxy.
      rig[bone.joint].setParent(slot.restParent.get(bone.joint)!);
      this.park(bone);
    }
    slot.frozen = true;
  }

  /**
   * Takes a bone's body out of the world and holds it at `PARKED_Y`.
   *
   * Moving the proxy node is NOT enough, and that is the whole reason this
   * exists. The plugin copies a node's transform into its body during the
   * pre-step and only while prestep is enabled, so a body parked with
   * `disablePreStep` still true stays exactly where the corpse settled — an
   * invisible static box lying on the street. Measured before this: a downward
   * physics ray over open ground read 0.000 m before a death and **0.303 m
   * after the body had been retired and its slot freed**, which the next corpse
   * to fall there would have landed on.
   *
   * Writing the transform through the plugin by hand is what makes the park
   * immediate. Waiting for the next step will not do: the step is skipped
   * exactly when nothing is simulating, which is the state a release usually
   * leaves behind.
   */
  private park(bone: Bone): void {
    bone.body.setLinearVelocity(Vector3.ZeroReadOnly);
    bone.body.setAngularVelocity(Vector3.ZeroReadOnly);
    bone.proxy.position.set(0, PARKED_Y, 0);
    bone.proxy.rotationQuaternion!.copyFrom(Quaternion.Identity());
    // TELEPORT for the length of the write, then back to the pooled state.
    bone.body.disablePreStep = false;
    this.plugin?.setPhysicsBodyTransformation(bone.body, bone.proxy);
    bone.body.disablePreStep = true;
    bone.body.setMotionType(PhysicsMotionType.STATIC);
  }

  /**
   * Hands the rig back, restored exactly, and frees the slot. Idempotent.
   *
   * The ordering is deliberate: the rig is put back and hidden BEFORE
   * `ragdolling` is cleared, so `Bot.update` never sees a half-restored rig.
   * The frame after this, its dead branch runs the tail of the tween against a
   * hidden rig — harmless, and it means `Bot.spawn` has one case to handle
   * rather than two.
   */
  private release(slot: Slot): void {
    const { subject, rig } = slot;
    if (!subject || !rig) {
      slot.subject = null;
      slot.rig = null;
      return;
    }
    for (const bone of slot.bones) this.park(bone);
    // Both of these belong to a CORPSE, and `update`'s guard can hand this a
    // body that came back to life while the pool was holding it. Hiding a live
    // bot costs a frame of invisibility (`BattleSystem` re-enables it on the
    // next one) and writing its root would drop it at the dead one's sink
    // height for that frame. The joints still have to go back, which is the
    // whole reason that guard releases rather than just forgetting the slot.
    if (!subject.alive) {
      // Undo the sink before handing the rig back: `root.position` is the
      // bot's own, and a respawn writes it through `syncTransform` — but a rig
      // retired by `reset()` mid-sink would otherwise keep the offset.
      if (slot.sinking) rig.root.position.y = slot.sinkFromY;
      subject.setEnabled(false);
    }
    // The authoritative restore: parents, positions, rotations, quaternions
    // and scalings, on every posed node. See its own note for why
    // `animateSoldier(..., 0)` is not a substitute.
    resetSoldierPose(rig);
    subject.ragdolling = false;
    slot.subject = null;
    slot.rig = null;
    slot.frozen = false;
    slot.sinking = false;
    slot.t = 0;
    slot.stillT = 0;
    slot.restParent.clear();
  }
}
