/**
 * DebrisSystem.ts — The glass a broken pane throws: a pool of flat rigid bodies
 * under `PhysicsWorld`, cut to the pane they came out of.
 * Owns: the shard pool, its bodies and meshes, the per-size collision shapes,
 * and the burst's own clock.
 * Invariants: it is the second `PhysicsClient` and owns no engine — see
 * `PhysicsWorld`. Nothing here feeds navigation, cover or hit detection: a shard
 * is dressing, exactly as a corpse is, and rounds and bodies pass through it.
 *
 * ## A shard is a fraction of its pane, not a fixed chip
 *
 * This threw twelve 16 cm chips into an 0.8 m cube at the crossing point, for
 * every pane on the map. Against a cottage window that reads; against a
 * shopfront bay it is the bug the whole system was built to avoid — a sheet of
 * glass several metres across vanishes in one frame and a handful of gravel
 * appears where the round went in, so the eye reads the pane as DELETED rather
 * than broken.
 *
 * So the burst is cut from the pane instead. The face is divided into cells of
 * `sqrt(area / shards)` metres, clamped to `[shardMin, shardMax]`; a piece fills
 * `shardPack` of its cell; and the pieces are laid out ON the face, in its
 * plane, before they are thrown. At t=0 the burst is very nearly the sheet that
 * was standing there, which is what makes the next quarter second read as it
 * coming apart.
 *
 * Where a pane is bigger than twelve cells — a curtain wall, or any map whose
 * kit glazes an elevation in one piece — the patch is centred on the hole and
 * clipped to the face rather than spread thin across it. That is the graceful
 * failure and it is deliberate: twelve pieces sprinkled over ninety square
 * metres is confetti, while twelve over the three metres either side of the
 * round is a hole with glass falling out of it. **The right fix for a pane that
 * big is a smaller pane** — see `kit/city.ts`, where the unit is the bay the
 * mullions already divide the elevation into.
 *
 * ## Which way the glass goes, and why it is never the round's way
 *
 * A sheet leaves its frame along its own NORMAL. The round drags glass along
 * its own path only WITHIN the plane, where the round's direction is projected.
 * That is not just how a pane fails: it is what keeps the pieces out of the wall
 * behind them. All but a dozen of Coldharbour's panes are decoration hanging
 * 4 cm off a solid mass, so a burst thrown along the bullet spawns bodies inside
 * the shaft they were hanging on, and Havok spends the first frames shoving them
 * back out through the face they came from.
 *
 * Which side it leaves BY is the pane's own answer. A cosmetic pane hangs on
 * something solid, so the glass falls out toward the shooter — the one side
 * that is provably open, because a round crossed it to get here. A barrier pane
 * is a way THROUGH (see `BoxSpec.glass`), so its glass goes the way the round
 * went, into the room the shot has just opened.
 *
 * ## Everything here is bounded, and each bound is a different thing
 *
 * **The POOL** is `glass.maxConcurrent` bursts of `glass.shards` bodies, built
 * once in the constructor and never rebuilt. At four and twelve that is 48
 * bodies, about five corpses — against eight corpses (80 bodies) measured at
 * 0.121 ms/frame, with the whole roster's AI at 0.39–0.42 ms in the same run.
 * The two are one budget and want raising together or not at all.
 *
 * **The DISTANCE** is `glass.shardDistance` and is deliberately not the fog wall
 * that gates a corpse. It is expressed for a piece of `shardMax` and scaled by
 * the piece actually cut, because the question a gate answers is how big the
 * thing looks: a 16 cm chip is a pixel at sixty metres and a 0.9 m panel is not.
 * The BREAK is not gated by it: the pane goes at any range, because that is the
 * world changing rather than an effect playing.
 *
 * **The POOL EVICTS, but only what has already landed.** It used to refuse
 * outright, which is `GrenadeSystem`'s rule — but a refused burst is a window
 * that came out of a building with no glass in it, which is exactly the
 * mismatch above. `glass.shardSteal` is the compromise: a burst still in the
 * air is never stolen, because glass that vanishes mid-fall is worse than glass
 * that never flew, while one lying on the pavement is fair game.
 *
 * **There is no fallback and no reason for one.** Havok is required (see
 * `PhysicsWorld`) and the bodies are hung on the meshes in this constructor, so
 * a burst is either under the solver or is not drawn at all. What used to be
 * here was a scripted ballistic arc with the terrain as a floor, for the case
 * where a window broke before the WASM landed — a case that no longer exists,
 * carrying a second integrator and a terrain pointer for a fall nobody had
 * seen since the engine started shipping with the build.
 */
import {
  Mesh,
  MeshBuilder,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShape,
  PhysicsShapeBox,
  Quaternion,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { WorldPane } from "../world/MapBuilder";
import { DEBRIS_GROUP, WORLD_GROUP, type PhysicsClient, type PhysicsWorld } from "./PhysicsWorld";

/**
 * The glazing's own colour, and it is the kit's `GLASS` restated rather than
 * imported: `src/world/kit/core.ts` is the world layer's palette and a system
 * may not reach into it. If the two ever disagree the shards are the wrong
 * colour and nothing else breaks, which is the right failure for a duplicated
 * art constant — see `CombatSystem`, whose spark colours are literals for the
 * same reason.
 *
 * **A shard is drawn OPAQUE in it, unlike the pane it came out of.** That is
 * not an oversight: the pane's material composites a reflection over this
 * colour and reads as glass because it is a sheet with a sky in it, and a piece
 * of it in mid-air has neither — transparent, it is very nearly invisible, and
 * forty-eight of them would be forty-eight sorted draws for the privilege.
 * `mats.get` is the matte variant. It is also what makes the moment of the
 * break read: shattering glass goes opaque as it crazes, so a plane of matte
 * panels appearing where a clear sheet stood is the right first frame.
 */
const SHARD_COLOR = "#2a333b";

/** Where a body waits between bursts, well under any map. */
const PARKED_Y = -1000;

/**
 * Metres. Piece dimensions are rounded to this before a collision shape is
 * looked up, which is what makes the shape cache a fixed handful rather than
 * one shape per pane size on the map: both dimensions live in
 * `[shardMin, shardMax]`, so there are at most a few hundred keys in principle
 * and a dozen in practice, and every one of them is reused for the life of the
 * process.
 */
const SIZE_STEP = 0.05;

/** One piece of glass: its mesh, and the body that moves it. */
interface Shard {
  mesh: Mesh;
  body: PhysicsBody;
}

/** One pane's worth of shards, reused for the life of the process. */
interface Burst {
  shards: Shard[];
  /** Seconds since it was thrown, or -1 when the slot is free. */
  t: number;
  /** The piece size this burst's bodies are currently shaped for. */
  w: number;
  h: number;
}

export class DebrisSystem implements PhysicsClient {
  private bursts: Burst[] = [];
  /**
   * Collision shapes by rounded size, shared by every body of that size and
   * never disposed until this system is. A shape is a WASM allocation and the
   * frame a window breaks on is the worst one available to spend it, so the
   * first burst of a given size pays for it and no later one does.
   */
  private shapes = new Map<number, PhysicsShape>();
  /**
   * The burst's own jitter stream, re-seeded by `reset` — so per round, and
   * per map with it.
   *
   * Seeded for `RagdollSystem`'s reason rather than for reproducibility of the
   * glass itself: nothing may make a ROUND play out differently because a
   * window happened to break near a bot, and a shared `Math.random` would put
   * every later draw in the process one call out of step.
   */
  private seed = 0x91a5;

  // Scratch. A burst runs every frame while it is live, and FINDINGS #7 already
  // measures 13.4 KB/frame of allocation churn without this file in it. The two
  // vectors are the throw, handed straight to the body and never read back.
  private readonly vel = new Vector3();
  private readonly spin = new Vector3();

  constructor(
    private scene: Scene,
    private mats: CelMaterialFactory,
    private physics: PhysicsWorld,
  ) {
    physics.register(this);
    this.buildPool();
  }

  /** How many bursts are live. Test hook. */
  get activeCount(): number {
    return this.bursts.reduce((n, b) => n + (b.t >= 0 ? 1 : 0), 0);
  }

  // --- PhysicsClient --------------------------------------------------------

  /** Whether any burst still owes the solver time. */
  physicsActive(): boolean {
    return this.bursts.some((b) => b.t >= 0);
  }

  afterFirstStep(): void {
    for (const burst of this.bursts) {
      if (burst.t < 0) continue;
      for (const s of burst.shards) s.body.disablePreStep = true;
    }
  }

  /** The ground went away: park everything rather than leave it hanging. */
  worldCleared(): void {
    for (const burst of this.bursts) if (burst.t >= 0) this.release(burst);
  }

  // --- the burst ------------------------------------------------------------

  /**
   * The pane `geom` went in, crossed at `at` by a round travelling along `dir`.
   *
   * Returns whether anything was drawn, which is false past the distance gate
   * and false with every slot's burst still in the air — and in both cases the
   * pane is still gone, because the break is the world changing and this is
   * only what it looked like.
   */
  burst(geom: WorldPane, at: Vector3, dir: Vector3, camPos: Vector3): boolean {
    if (this.bursts.length === 0) return false;
    const g = CONFIG.glass;

    // --- the sheet's own frame ---------------------------------------------
    //
    // A pane is thin in ONE of its two horizontal axes and the other spans the
    // face. Local +x is world (cos, -sin) and local +z is world (sin, cos) —
    // `GlassSystem.segmentHitsPane`'s convention, which this must not mirror or
    // every yawed building on the map throws its glass sideways.
    const c = Math.cos(geom.rotY);
    const s = Math.sin(geom.rotY);
    const alongX = geom.w >= geom.d;
    const faceW = alongX ? geom.w : geom.d;
    const faceH = geom.h;
    const thick = alongX ? geom.d : geom.w;
    // Across the face, and out of it.
    const ux = alongX ? c : s;
    const uz = alongX ? -s : c;
    const nx = alongX ? s : c;
    const nz = alongX ? c : -s;

    // --- how big a piece, and how many cells it takes to cover the face -----
    const pitch = clamp(Math.sqrt((faceW * faceH) / g.shards), g.shardMin, g.shardMax);
    const cols = Math.max(1, Math.round(faceW / pitch));
    const rows = Math.max(1, Math.round(faceH / pitch));
    const cellW = faceW / cols;
    const cellH = faceH / rows;
    const pieceW = clamp(cellW * g.shardPack, g.shardMin, g.shardMax);
    const pieceH = clamp(cellH * g.shardPack, g.shardMin, g.shardMax);

    // The gate is an apparent size, not a distance: `shardDistance` is quoted
    // for a piece of `shardMax` and everything smaller stops nearer, in
    // proportion. See the header.
    const reach = (g.shardDistance * Math.max(pieceW, pieceH)) / g.shardMax;
    if (Vector3.Distance(at, camPos) > reach) return false;

    const slot = this.take();
    if (!slot) return false;

    // --- the patch of the face this burst is cut from -----------------------
    //
    // As square as the budget and the face allow, then grown into whichever
    // dimension is short of the other — twelve pieces want to be 3 x 4 and not
    // 12 x 1, because a hole is round and a slot is not.
    let pr = Math.min(rows, Math.max(1, Math.round(Math.sqrt(g.shards))));
    let pc = Math.min(cols, Math.max(1, Math.floor(g.shards / pr)));
    for (;;) {
      const canC = pc < cols && (pc + 1) * pr <= g.shards;
      const canR = pr < rows && pc * (pr + 1) <= g.shards;
      if (canR && (!canC || pr <= pc)) pr++;
      else if (canC) pc++;
      else break;
    }

    // Where the round crossed, in the face's own coordinates: `du` across it
    // from the centre, `dv` up it.
    const du = (at.x - geom.cx) * ux + (at.z - geom.cz) * uz;
    const dv = at.y - geom.cy;
    const hitI = clamp(Math.floor(((du + faceW / 2) / faceW) * cols), 0, cols - 1);
    const hitJ = clamp(Math.floor(((dv + faceH / 2) / faceH) * rows), 0, rows - 1);
    const i0 = clamp(hitI - ((pc - 1) >> 1), 0, cols - pc);
    const j0 = clamp(hitJ - ((pr - 1) >> 1), 0, rows - pr);

    // --- which way it leaves ------------------------------------------------
    //
    // Toward the shooter for a cosmetic pane (the side a round provably came
    // through, and the side that is not a wall), the way the round went for a
    // barrier one (which is a way through, and has a room behind it). See the
    // header.
    const facing = dir.x * nx + dir.z * nz;
    const side = (facing > 0 ? -1 : 1) * (geom.box >= 0 ? -1 : 1);
    // The round's own direction, projected into the plane. Out-of-plane it is
    // the normal above and nothing else, which is what keeps the glass out of
    // the mass the pane is hanging on.
    const carry = dir.x * ux + dir.z * uz;

    this.reshape(slot, pieceW, pieceH);
    slot.t = 0;

    const rand = () => {
      // xorshift on the shared seed: one stream for every burst, so the draw
      // count is a function of how much glass has broken and of nothing else.
      this.seed ^= this.seed << 13;
      this.seed ^= this.seed >>> 17;
      this.seed ^= this.seed << 5;
      return ((this.seed >>> 0) % 10000) / 10000;
    };
    // Clear of the pane's own thickness on the side it is leaving by, so a
    // piece starts neither inside the sheet it replaces nor inside the mass
    // that sheet was hanging on — and, for a barrier pane, on the far side of
    // the collider that is still standing until the authority says otherwise.
    // The `pieceH` term is the tilt below: a plate pitched a tenth of a radian
    // reaches that much further out of the plane than its own thickness.
    const standoff = side * (thick / 2 + g.shardCollide / 2 + pieceH * 0.06 + 0.02);

    for (const [k, shard] of slot.shards.entries()) {
      // Laid out ON the face: cell centres of the patch, in reading order, with
      // a little play inside the cell. The wrap is for a pane too small to hold
      // the whole burst — its pieces double up on cells it does have, which
      // reads as a busier shatter rather than as a stack in the middle.
      const cell = k % (pc * pr);
      const i = i0 + (cell % pc);
      const j = j0 + Math.floor(cell / pc);
      const u = -faceW / 2 + (i + 0.5) * cellW + (rand() - 0.5) * cellW * 0.2;
      const v = -faceH / 2 + (j + 0.5) * cellH + (rand() - 0.5) * cellH * 0.2;

      shard.mesh.position.set(
        geom.cx + u * ux + standoff * nx,
        geom.cy + v,
        geom.cz + u * uz + standoff * nz,
      );
      // Yawed onto the pane's own normal, so the thin axis of the box is the
      // thin axis of the sheet. The tilt and the roll are small on purpose:
      // the first frame is a cracked pane and not a cloud, and Havok has the
      // rest of the fall to make it one.
      Quaternion.RotationYawPitchRollToRef(
        Math.atan2(nx, nz),
        (rand() - 0.5) * 0.2,
        (rand() - 0.5) * 0.24,
        shard.mesh.rotationQuaternion!,
      );
      shard.mesh.setEnabled(true);

      // **What the round did, and what gravity is about to do.** A piece at the
      // hole is blown out of the frame and carried along the round's own path;
      // one at the far corner of the sheet simply lets go. The falloff is the
      // whole difference between a break and an explosion.
      const d = Math.hypot(u - du, v - dv) / g.shardBlast;
      const f = 1 / (1 + d * d);
      const out = g.shardSpeed * (0.2 + 0.8 * f) * side;
      const along = g.shardSpeed * g.shardAlongShot * f;
      this.vel.set(
        out * nx + carry * along * ux + (rand() - 0.5) * g.shardSpread,
        dir.y * along - g.shardDrop * (1 - 0.5 * f) + (rand() - 0.5) * g.shardSpread,
        out * nz + carry * along * uz + (rand() - 0.5) * g.shardSpread,
      );
      const spin = g.shardSpin * (0.25 + 0.75 * f);
      this.spin.set(
        (rand() - 0.5) * spin,
        (rand() - 0.5) * spin,
        (rand() - 0.5) * spin,
      );

      shard.body.setMotionType(PhysicsMotionType.DYNAMIC);
      // Two-phase teleport, exactly as a corpse's bones take: one step reads
      // the node into the sim, and `afterFirstStep` hands ownership over.
      shard.body.disablePreStep = false;
      shard.body.setLinearVelocity(this.vel);
      shard.body.setAngularVelocity(this.spin);
    }
    return true;
  }

  /**
   * Ages every burst, sinks the ones that have outlived themselves, and
   * retires them.
   *
   * Like `RagdollSystem.update` it does NOT step the engine — `PhysicsWorld`
   * does, and must have run for this frame first.
   */
  update(dt: number): void {
    const g = CONFIG.glass;
    for (const burst of this.bursts) {
      if (burst.t < 0) continue;
      burst.t += dt;

      // The sink is the same idea as a corpse's and for the same reason: the
      // matte cel material writes alpha 1.0 outright and one instance of it is
      // shared by everything of that colour, so a fade here would dim every
      // shard in the pool at once rather than the burst that is expiring. A
      // shard goes down through the floor instead.
      const sinking = burst.t - g.shardLife;
      if (sinking > 0) {
        const drop = (sinking / g.shardSink) * 0.5;
        for (const s of burst.shards) s.mesh.position.y -= drop * dt * 8;
      }
      if (burst.t > g.shardLife + g.shardSink) this.release(burst);
    }
  }

  /**
   * A slot for a new pane: a free one, or the oldest burst that has already
   * landed. Null when every slot holds glass still in the air — see
   * `glass.shardSteal`.
   */
  private take(): Burst | null {
    let oldest: Burst | null = null;
    for (const burst of this.bursts) {
      if (burst.t < 0) return burst;
      if (!oldest || burst.t > oldest.t) oldest = burst;
    }
    if (!oldest || oldest.t < CONFIG.glass.shardSteal) return null;
    this.release(oldest);
    return oldest;
  }

  /**
   * Re-cuts a slot's pieces to a new size, which is a no-op for a slot that
   * already carries it — panes come in a handful of sizes and a burst usually
   * follows one of its own kind.
   *
   * The mesh is a UNIT box and its scaling is what sizes it, because Havok's
   * transform sync writes position and orientation onto an unparented node and
   * leaves scaling alone. The body is sized by its shape instead: the two are
   * set from the same numbers here and nowhere else, and a mismatch would show
   * as a piece resting a few centimetres inside the road.
   */
  private reshape(slot: Burst, w: number, h: number): void {
    if (slot.w === w && slot.h === h) return;
    slot.w = w;
    slot.h = h;
    const shape = this.shapeFor(w, h);
    const mass = massFor(w, h);
    for (const s of slot.shards) {
      s.mesh.scaling.set(w, h, CONFIG.glass.shardThickness);
      s.body.shape = shape;
      // After the shape, which recomputes the mass properties from it.
      s.body.setMassProperties({ mass });
    }
  }

  /** The shared collision shape for a piece of this size, built once. */
  private shapeFor(w: number, h: number): PhysicsShape {
    const qw = Math.round(w / SIZE_STEP);
    const qh = Math.round(h / SIZE_STEP);
    const key = qw * 1000 + qh;
    const found = this.shapes.get(key);
    if (found) return found;
    const d = CONFIG.bots.death;
    const shape = new PhysicsShapeBox(
      Vector3.Zero(),
      Quaternion.Identity(),
      new Vector3(qw * SIZE_STEP, qh * SIZE_STEP, CONFIG.glass.shardCollide),
      this.scene,
    );
    shape.material = { friction: d.friction, restitution: 0.12 };
    shape.filterMembershipMask = DEBRIS_GROUP;
    // The world and nothing else — see `DEBRIS_GROUP`.
    shape.filterCollideMask = WORLD_GROUP;
    this.shapes.set(key, shape);
    return shape;
  }

  /** Parks a burst's shards and frees the slot. */
  private release(burst: Burst): void {
    burst.t = -1;
    for (const s of burst.shards) {
      s.mesh.setEnabled(false);
      s.body.setLinearVelocity(Vector3.ZeroReadOnly);
      s.body.setAngularVelocity(Vector3.ZeroReadOnly);
      s.body.setMotionType(PhysicsMotionType.STATIC);
      // Parked THROUGH the plugin, not just by moving the node. A static body
      // whose transform was only written on the mesh leaves its collision
      // proxy where it stopped — an invisible box lying in the street that
      // rounds and bodies stop on. `RagdollSystem.park` carries the measurement
      // that found it.
      s.mesh.position.set(0, PARKED_Y, 0);
      s.body.disablePreStep = false;
      this.physics.plugin.setPhysicsBodyTransformation(s.body, s.mesh);
      s.body.disablePreStep = true;
    }
  }

  /**
   * The whole pool — meshes and bodies together — built once at construction.
   *
   * It was two methods, and the split was the fallback's: the meshes were made
   * here and the bodies hung on them later, from a `physicsStarted` callback,
   * so a window broken before the WASM landed still threw shards on a scripted
   * arc. The engine is up before this system is constructed now, so there is
   * one phase and a shard has a body from the moment it exists.
   *
   * It is still not built on the frame a window breaks: 48 boxes, their GL
   * buffers and their shapes are not a cost to pay on the frame somebody pulled
   * a trigger — `DeathCam`'s stand-in rig is built at `startRound` for the same
   * reason. What a burst DOES pay for on that frame is a `reshape`, which is
   * twelve scalings and twelve shape assignments and never an allocation once
   * that size has been seen.
   *
   * **A shard's body is on the MESH, with no proxy node**, which is the one way
   * this is simpler than a corpse. A ragdoll needs proxies because Havok's sync
   * force-creates a `rotationQuaternion` on any node with a parent and the rig
   * is posed through Euler channels — but a shard is parented to nothing, is
   * posed by nobody, and is handed back to nothing. The quaternion Havok writes
   * is the only thing that ever orients it.
   */
  private buildPool(): void {
    const g = CONFIG.glass;
    const d = CONFIG.bots.death;
    const material = this.mats.get(SHARD_COLOR);
    // A middle size, so the pool starts consistent and the first burst of any
    // ordinary pane is the only one that ever builds a shape.
    const w0 = (g.shardMin + g.shardMax) / 2;
    const shape = this.shapeFor(w0, w0);
    for (let i = 0; i < g.maxConcurrent; i++) {
      const shards: Shard[] = [];
      for (let j = 0; j < g.shards; j++) {
        // A UNIT box: `reshape` scales it to the pane's own cell, so one mesh
        // serves every pane size on the map. Flat rather than cubic by the
        // scaling it is given — a shard is a piece of a sheet, and a cube at
        // this size reads as gravel.
        const mesh = MeshBuilder.CreateBox(`shard${i}-${j}`, { size: 1 }, this.scene);
        mesh.scaling.set(w0, w0, g.shardThickness);
        mesh.material = material;
        mesh.position.y = PARKED_Y;
        mesh.rotationQuaternion = Quaternion.Identity();
        mesh.isPickable = false;
        mesh.checkCollisions = false;
        mesh.setEnabled(false);
        // No outline and no glow. An ink shell around a piece of glass is most
        // of the pixels it covers, and 48 outlined meshes is 96 draws for
        // something on screen for a second and a half. `noGlow` is what makes
        // the second half true and is NOT inert: this pool exists by the time
        // `Game`'s construction-time exclusion scan runs, because `Game` builds
        // this system before it builds the glow layer's exclusions.
        mesh.metadata = { noOutline: true, noGlow: true };

        const body = new PhysicsBody(
          mesh,
          PhysicsMotionType.STATIC,
          false,
          this.scene,
        );
        body.shape = shape;
        body.setMassProperties({ mass: massFor(w0, w0) });
        body.setLinearDamping(d.linearDamping);
        body.setAngularDamping(d.angularDamping);

        shards.push({ mesh, body });
      }
      this.bursts.push({ shards, t: -1, w: w0, h: w0 });
    }
  }

  /** Drops every burst and re-seeds the jitter. Round start and map rebuild. */
  reset(): void {
    for (const burst of this.bursts) if (burst.t >= 0) this.release(burst);
    this.seed = 0x91a5;
  }

  dispose(): void {
    this.reset();
    for (const burst of this.bursts) {
      for (const s of burst.shards) {
        s.body.dispose();
        s.mesh.dispose();
      }
    }
    this.bursts = [];
    for (const s of this.shapes.values()) s.dispose();
    this.shapes.clear();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A piece's mass, from its area. `glass.shardMass` is quoted for a piece of
 * `shardMax` and everything smaller is lighter in proportion, so a cottage
 * window's shards skitter where a shopfront's panels drop.
 */
function massFor(w: number, h: number): number {
  const g = CONFIG.glass;
  return (g.shardMass * w * h) / (g.shardMax * g.shardMax);
}
