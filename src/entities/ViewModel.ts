/**
 * ViewModel.ts — The first-person weapon: whichever gun is carried and the two
 * gloved arms holding it, parented to the camera, plus every offset that moves
 * them (hip/ADS pose, sprint carry, reload dip and mag swap, the off-hand
 * throw's arm and give, sway, bob, kick).
 * Owns: the on-screen weapon. Nothing else may reparent or pose it.
 *
 * Invariants:
 * - The ADS pose is DERIVED, never authored: `adsPos` places the weapon so
 *   that the FITTED sight's own `sightCenter` lands on the camera's axis at
 *   that sight's `eyeRelief`. The reticle then projects to the exact centre
 *   of the screen, which is where CombatSystem sends the bullets. Hand-tuning
 *   that offset breaks the one guarantee ADS is for, and it has to be
 *   re-derived every time EITHER half of the loadout changes — a different
 *   weapon carries the same optic at a different height. `applyFit` is the
 *   only place that may write it.
 * - The aimed pose is also scaled by the sight's `zoomComp`, which is a
 *   uniform scale about the camera's origin: `adsPos` and the node's own
 *   scaling take the same factor, so no ray direction moves and the sight
 *   stays exactly on the axis. Scaling one without the other is what would
 *   break it.
 * - Every weapon is built once and all but the carried one is disabled, the
 *   same trick the optics use: a loadout change is a handful of boolean
 *   writes and a re-derivation, never a rebuild. That is also why the muzzle
 *   and the ejection port are nodes owned HERE rather than the model's — they
 *   have things hanging off them (Player's flash) that must survive a swap.
 * - Everything here is cosmetic WITH ONE EXCEPTION, and it is a read rather
 *   than a write: `throwHandWorld` is where the grenade leaves from, so the
 *   throwing hand's pose is the one thing on this rig that something in the
 *   world is placed by. A grenade that spawned anywhere else is a grenade the
 *   hand did not throw, which is the whole reason the arm exists.
 * - Everything else here is cosmetic. It reads the camera; it never writes it,
 *   and it never touches aim, spread or damage.
 * - Meshes render in VIEWMODEL_GROUP with the depth buffer cleared first, so
 *   the weapon is never sliced open by the wall the player is standing
 *   against. Anything else attached to it (Player's muzzle flash) must join
 *   that group or it will be hidden behind the gun it belongs to.
 * - Arms are built at the origin and merged per colour before being parented,
 *   the same rule as BuildingKit and the weapon models: MergeMeshes bakes
 *   world matrices, so the merge is only correct at identity.
 * - The loadout screen's turntable (`beginInspect`/`updateInspect`) is the one
 *   pose that is not the carried one, and it is the only thing here that may
 *   write `rotationQuaternion`. While one is set Babylon ignores `rotation`
 *   entirely, so `endInspect` clearing it is what lets the carried pose come
 *   back at all.
 */
import {
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  type Node,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import type { CelMaterialFactory } from "../shaders/CelShader";
import { buildDmr } from "./DmrModel";
import { buildRifle } from "./RifleModel";
import { buildSmg } from "./SmgModel";
import { DEFAULT_SIGHT, sightSetup, type SightId, type SightSetup } from "./sights";
import type { GripSpec, WeaponBuilder, WeaponParts } from "./weaponKit";
import {
  DEFAULT_WEAPON,
  WEAPON_IDS,
  weaponSetup,
  type WeaponId,
  type WeaponSetup,
} from "./weapons";

/**
 * Rendering group for everything that hangs off the camera. Babylon clears
 * depth between rendering groups, so group 1 draws over the world instead of
 * intersecting it — the standard fix for a viewmodel clipping through
 * geometry the player walks up to.
 */
export const VIEWMODEL_GROUP = 1;

/**
 * The model builder for each weapon. The one place the ids in
 * `CONFIG.weapons` meet the geometry, and a `Record` rather than a lookup so
 * adding a weapon without a model fails to compile.
 */
const WEAPON_BUILDERS: Record<WeaponId, WeaponBuilder> = {
  rifle: buildRifle,
  smg: buildSmg,
  dmr: buildDmr,
};

/** What the weapon needs to know about the player, per frame. */
export interface ViewModelParams {
  /** 0 = hip, 1 = fully aimed. The camera's blend, not the raw input. */
  adsBlend: number;
  /** 0..1 movement drive — the same value the camera bobs on. */
  moveBlend: number;
  sprintBlend: number;
  reloadBlend: number;
  /** 0..1 through the reload, for the support hand's trip to the magwell. */
  reloadPhase: number;
  /**
   * Seconds since the throw was asked for, or negative when there is no throw
   * in flight. Seconds rather than a blend because the gesture is a TIMELINE
   * with a release in the middle of it (see `viewmodel.throw`) — the hand
   * cocks, whips, lets go and comes back, and a single 1 -> 0 weight cannot
   * say where in that the arm is. Player owns the clock; this only reads it.
   */
  throwTime: number;
  /** Per-shot punch, 1 at the shot and squared by the caller. */
  kick: number;
  /** Smoothed look rates (rad/s) — the weapon trails both. */
  turnRate: number;
  pitchRate: number;
  /** The camera's bob phase, so weapon and view stride together. */
  bobPhase: number;
  /** Vertical velocity (m/s), for the airborne give. */
  velY: number;
  /**
   * The camera's landing absorb, in metres and negative while the eye is
   * sunk. Read, never integrated here: one spring per impact (see
   * `CameraSystem.landDip`), the same rule the bob phase follows.
   */
  landDip: number;
}

const GLOVE = "#23262c";
const SLEEVE = "#3d4335";

/**
 * The throwing arm's geometry, in the same model units the weapons' arms are
 * built in (its node carries `scale`, exactly as the weapon does). The fist is
 * at the node's origin so the whole gesture can be authored as where the HAND
 * is, and the forearm runs back and outboard from it to an elbow that is
 * rigid — the arm swings as one piece, the same simplification the support
 * hand's trip to the magwell already makes.
 *
 * Its LENGTH is load-bearing rather than anatomical: the forearm stops at a
 * flat cut where a shoulder there is no geometry for would be, so the cut has
 * to stay off the screen at every pose in the gesture or the arm reads as a
 * floating log. Long, aimed down and outboard, it runs off the bottom-left
 * corner instead — see the note on the hand keys in `viewmodel.throw`.
 */
const THROW_ELBOW = new Vector3(-0.22, -0.55, -0.24);
/**
 * The frag in the fist, in those same model units — so 0.046 m once the node's
 * scale is applied, against `grenade.radius`'s 0.11 in the world. Deliberately
 * not the same number: the thrown body is sized to be NOTICED arriving across
 * a street, and a ball that size held at the lens is a beachball in a glove.
 * What has to match is the read — an olive sphere with a live pip on it.
 */
const THROW_BALL = 0.075;
/**
 * How far past the release the hand carries on, as a fraction of the whip it
 * just travelled, and the share of the recovery it spends getting there. An
 * arm that reversed on the release frame reads as the throw being cancelled
 * rather than followed through.
 */
const THROW_FOLLOW = 0.18;
const THROW_FOLLOW_FRAC = 0.28;

/** A plain triple, which is how every pose in CONFIG is written. */
type XYZ = { x: number; y: number; z: number };

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const smoothstep01 = (x: number) => x * x * (3 - 2 * x);
/** Ramp from a to b, clamped at both ends. */
const ramp = (a: number, b: number, x: number) =>
  smoothstep01(clamp((x - a) / (b - a), 0, 1));

/**
 * What the turntable needs from the camera it is parented to. The weapon is
 * placed by SCREEN position, so it has to know how the camera projects: the
 * anchor is back-projected through these, which is also what makes the pose
 * survive a resize or a camera left zoomed by the last round.
 */
export interface InspectParams {
  /** Vertical field of view (radians) — Babylon's default fixed axis. */
  fovY: number;
  /** Render width / height. */
  aspect: number;
}

/** One built weapon and the arms holding it — enabled only while carried. */
interface WeaponRig {
  /** Parent of everything in this rig; the switch a loadout change throws. */
  root: TransformNode;
  parts: WeaponParts;
  /** The support arm, which leaves the handguard for the magazine swap. */
  supportArm: TransformNode;
}

export class ViewModel {
  /** Every visible part, for the one visibility switch Player owns. */
  readonly meshes: Mesh[] = [];
  /**
   * The gloved arms, of every weapon — the subset that lets go while the
   * weapon is on the turntable. A forearm cut off at the elbow is a fact of
   * first person that reads fine when the weapon is being carried and reads as
   * a severed arm when it is being turned over on a bench.
   */
  private readonly arms: Mesh[] = [];
  /** Whether the on-screen weapon is visible at all (Player's switch). */
  private shown = false;
  private inspecting = false;
  /**
   * The carried weapon's barrel tip and ejection port, as nodes that outlive a
   * loadout change. Player hangs the muzzle flash off the first and throws its
   * brass from the second, so neither may be a child of a rig that can be
   * switched off underneath them.
   */
  readonly muzzle: TransformNode;
  readonly ejectPort: TransformNode;

  /** Carries the whole pose; every rig hangs off it. */
  private readonly weapon: TransformNode;
  private readonly rigs = {} as Record<WeaponId, WeaponRig>;

  /**
   * The throwing arm, and the grenade in its fist. Parented to the CAMERA
   * rather than to `weapon`: the weapon tips out of the way for the throw, and
   * a hand that inherited that would be shoved around by the very pose it is
   * the cause of. Disabled whenever no throw is in flight, which is nearly
   * always — `setEnabled` rather than `isVisible`, so it composes with (and
   * cannot be trampled by) `applyMeshVisibility`'s two flags.
   */
  private readonly throwHand: TransformNode;
  /** Hidden the instant the real grenade leaves; back for the next wind-up. */
  private readonly throwBall: TransformNode;
  /**
   * The gesture as four keys — rest, cock, release, follow-through — resolved
   * once so the per-frame job is one lerp between two of them. The last is
   * DERIVED from the other two rather than authored: a little further along
   * the line the hand was already travelling when it let go, so an arm that
   * stopped dead on the release frame instead carries on and slows, and it
   * stays right whatever the three authored keys are moved to.
   */
  private readonly throwKeys: { pos: Vector3; rot: Vector3 }[] = [];

  /** Aimed position, derived from the fit (see the header). */
  private readonly adsPos = new Vector3();
  /** The carried weapon and the fitted optic. Written only by `applyFit`. */
  private weaponFit: WeaponSetup = weaponSetup(DEFAULT_WEAPON);
  private sight: SightSetup = sightSetup(DEFAULT_SIGHT);
  /** The authored hip pose, plus the carried weapon's own length offset. */
  private readonly hipPos: Vector3;
  private readonly hipRot: Vector3;

  /**
   * The carried weapon's turntable pivot, in the weapon's own frame: a point
   * along its axis derived from its own muzzle landmark (see
   * `inspect.pivotFrac`), so the SMG spins about the middle of the SMG.
   * Written by `applyFit` with everything else the fit decides.
   */
  private readonly pivot = new Vector3();
  /** Turntable angles, in radians. Only the inspect path reads them. */
  private inspectYaw = 0;
  private inspectPitch = 0;

  // Sway state: a spring behind the look rates, so the weapon settles after
  // the camera has stopped instead of snapping back with it.
  private swayX = 0;
  private swayY = 0;
  private swayYaw = 0;
  private swayPitch = 0;
  /**
   * Smoothed airborne give (metres). The lag is the point: the body's vertical
   * speed steps at both ends of a jump, and the weapon is the one thing on
   * screen that must not step with it.
   */
  private airGive = 0;

  /** Scratch — the pose is rebuilt every frame and must not allocate. */
  private readonly pos = new Vector3();
  private readonly rot = new Vector3();
  /**
   * Every positional offset laid on TOP of the base pose — sprint, reload,
   * sway, bob, the airborne give and the per-shot kick. Kept apart from
   * `pos` so the zoom compensation can be applied to it: these are metres in
   * the camera's frame, and a compensated weapon is a weapon drawn closer,
   * where the same metre is a much bigger angle. Left unscaled, a flick of
   * sway that nudges the holo's picture would swing a 3.5x scope's bore
   * clean off the axis.
   *
   * Rotations deliberately do NOT get the same treatment: the weapon turns
   * about its own root, so the displacement a given angle produces already
   * scales with the model, and the angle at the eye comes out unchanged.
   */
  private readonly off = new Vector3();
  /** Scratch for the turntable's rotation — built per frame, never allocated. */
  private readonly spinYaw = Matrix.Identity();
  private readonly spinPitch = Matrix.Identity();
  private readonly spin = Matrix.Identity();
  /**
   * The quaternion the node itself holds while inspecting. Handed over once by
   * `beginInspect` and mutated in place after that — Babylon compares the
   * object against its own cache, so an in-place write is seen, exactly as it
   * is for `position`.
   */
  private readonly spinQ = new Quaternion();

  constructor(scene: Scene, mats: CelMaterialFactory, camera: Node) {
    const v = CONFIG.viewmodel;
    this.hipPos = new Vector3(v.hipPos.x, v.hipPos.y, v.hipPos.z);
    this.hipRot = new Vector3(v.hipRot.x, v.hipRot.y, v.hipRot.z);

    this.weapon = new TransformNode("viewmodel", scene);
    this.weapon.parent = camera;
    this.weapon.scaling.setAll(v.scale);

    // Every weapon is built up front. The cost is a set of merged colour
    // groups per weapon sitting disabled — against a rebuild in the middle of
    // a deploy screen, which would drop Player's muzzle flash on the floor and
    // stall the frame it happened on.
    for (const id of WEAPON_IDS) {
      const root = new TransformNode(`viewmodel_${id}`, scene);
      root.parent = this.weapon;
      const parts = WEAPON_BUILDERS[id](scene, mats, `view_${id}`);
      parts.root.parent = root;
      const supportArm = new TransformNode(`viewmodel_${id}_supportArm`, scene);
      supportArm.parent = root;
      const arms = [
        ...buildArm(scene, mats, `${id}_trigger`, parts.grip, root),
        ...buildArm(scene, mats, `${id}_support`, parts.support, supportArm),
      ];
      this.meshes.push(...parts.meshes, ...arms);
      this.arms.push(...arms);
      this.rigs[id] = { root, parts, supportArm };
    }

    // The throwing arm: ONE rig shared by every weapon, unlike the two arms
    // above. Where a hand grips is the model's business and is why those are
    // per-weapon; a fist closed around a grenade is not holding the gun at all
    // and has nothing to fit.
    this.throwHand = new TransformNode("viewmodel_throwHand", scene);
    this.throwHand.parent = camera;
    this.throwHand.scaling.setAll(v.scale);
    this.throwHand.setEnabled(false);
    const throwArm = buildArm(
      scene,
      mats,
      "throwHand",
      { hand: Vector3.Zero(), elbow: THROW_ELBOW },
      this.throwHand,
    );
    const ball = MeshBuilder.CreateSphere(
      "view_throwGrenade",
      { diameter: THROW_BALL * 2, segments: 6 },
      scene,
    );
    ball.parent = this.throwHand;
    ball.position.set(0, 0.04, 0.06);
    ball.material = mats.get("#3f4a33");
    ball.isPickable = false;
    const pip = MeshBuilder.CreateSphere(
      "view_throwGrenadePip",
      { diameter: THROW_BALL * 0.62, segments: 4 },
      scene,
    );
    pip.parent = ball;
    // Proud of the body's ink shell, the same rule the thrown grenade's pip and
    // the player's visor slit both follow.
    pip.position.y = THROW_BALL;
    pip.material = mats.getEmissive("#ff5a4f");
    pip.metadata = { noOutline: true };
    pip.isPickable = false;
    this.throwBall = ball;
    this.meshes.push(...throwArm, ball, pip);
    this.arms.push(...throwArm);

    const th = v.throw;
    const key = (pos: XYZ, rot: XYZ) => ({
      pos: new Vector3(pos.x, pos.y, pos.z),
      rot: new Vector3(rot.x, rot.y, rot.z),
    });
    this.throwKeys.push(
      key(th.handRest, th.handRestRot),
      key(th.handCock, th.handCockRot),
      key(th.handRelease, th.handReleaseRot),
      key(th.handRelease, th.handReleaseRot),
    );
    // The follow-through, extrapolated past the release along the whip.
    for (const f of ["pos", "rot"] as const) {
      this.throwKeys[3][f]
        .subtractInPlace(this.throwKeys[1][f])
        .scaleInPlace(THROW_FOLLOW)
        .addInPlace(this.throwKeys[2][f]);
    }

    this.muzzle = new TransformNode("viewmodel_muzzle", scene);
    this.muzzle.parent = this.weapon;
    this.ejectPort = new TransformNode("viewmodel_ejectPort", scene);
    this.ejectPort.parent = this.weapon;
    this.applyFit();

    for (const m of this.meshes) {
      // Ink an order of magnitude finer than the world's: a body-width
      // outline on parts this small swallows the whole weapon in black.
      // Not registered with addOutline() on purpose — distance thinning is
      // meaningless for something 0.5 m from the lens.
      if (!m.metadata?.noOutline) {
        m.renderOutline = true;
        m.outlineColor = Color3.Black();
        m.outlineWidth = 0.004;
      }
      m.renderingGroupId = VIEWMODEL_GROUP;
      // Bounds of a camera-parented mesh are recomputed from a matrix that
      // moves with the frustum; skip the cull test rather than race it.
      m.alwaysSelectAsActiveMesh = true;
    }

    // Start in the hip pose so the first rendered frame is already right.
    this.weapon.position.copyFrom(this.hipPos);
    this.weapon.rotation.copyFrom(this.hipRot);
  }

  /** Picks up a weapon: shows that rig, hides the rest, re-derives the pose. */
  setWeapon(id: WeaponId): void {
    this.weaponFit = weaponSetup(id);
    // The rig being put down keeps whatever mid-reload offset its support arm
    // had — and, if the swap caught a throw in flight, an arm switched off
    // for it. Both are per-rig state that a weapon this hand has never held
    // must not inherit.
    for (const wid of WEAPON_IDS) {
      this.rigs[wid].supportArm.position.setAll(0);
      this.rigs[wid].supportArm.setEnabled(true);
    }
    this.applyFit();
  }

  /** Fits an optic to the carried weapon. */
  setSight(id: SightId): void {
    this.sight = sightSetup(id);
    this.applyFit();
  }

  /**
   * Puts the fit on screen and re-derives everything downstream of it.
   *
   * The derivation is the one thing here that is not art direction. The
   * sight's own centre is a child of the weapon root, which sits at identity
   * under `weapon`, so its local offset is exactly what has to be cancelled —
   * scaled, because `weapon.position` is in the camera's frame while the
   * sight's offset is in the weapon's, and `scale` is what separates the two.
   * Dropping that factor drops the reticle a couple of degrees below the
   * point of impact: a sight picture that looks plausible and shoots high.
   *
   * `zoomComp` then shrinks the whole aimed configuration — the stand-off and
   * the model together — about the camera's origin, which cannot move the
   * sight off the axis because a scale about the origin preserves directions.
   * It is how a 3.5x optic magnifies the world without magnifying the weapon.
   */
  private applyFit(): void {
    const v = CONFIG.viewmodel;
    const fitted = this.weaponFit.id;
    for (const id of WEAPON_IDS) {
      const rig = this.rigs[id];
      rig.root.setEnabled(id === fitted);
      for (const [key, assembly] of Object.entries(rig.parts.sights)) {
        assembly.root.setEnabled(key === this.sight.id);
      }
    }
    const parts = this.rigs[fitted].parts;
    this.muzzle.position.copyFrom(parts.muzzle);
    this.ejectPort.position.copyFrom(parts.ejectPort);
    // A shorter weapon sits closer, or it reads as being held at arm's length.
    this.hipPos.set(v.hipPos.x, v.hipPos.y, v.hipPos.z + this.weaponFit.hipZ);

    // Where the turntable spins: along this weapon's own axis, so a swap on
    // the kit screen re-centres the model instead of hanging the SMG off the
    // point the rifle's receiver used to sit at.
    this.pivot.set(0, 0, parts.muzzle.z * v.inspect.pivotFrac);

    const s = v.scale * this.sight.zoomComp;
    const centre = parts.sights[this.sight.id].sightCenter.position;
    this.adsPos.set(
      -centre.x * s,
      -centre.y * s,
      this.sight.eyeRelief * this.sight.zoomComp - centre.z * s,
    );
  }

  /** World position of the muzzle (tracer and flash origin). */
  muzzleWorld(): Vector3 {
    return this.muzzle.getAbsolutePosition().clone();
  }

  setVisible(visible: boolean): void {
    this.shown = visible;
    this.applyMeshVisibility();
  }

  /**
   * The one place a mesh's visibility is written. Two flags decide it — shown
   * at all, and whether the hands are on the weapon — and routing both through
   * here is what stops the kit screen's "show the weapon" and its "let go of
   * it" from fighting over the arms depending on which ran last.
   */
  private applyMeshVisibility(): void {
    for (const m of this.meshes) m.isVisible = this.shown;
    if (this.inspecting) for (const m of this.arms) m.isVisible = false;
  }

  /** Drops every transient offset — called when a round starts. */
  reset(): void {
    this.swayX = 0;
    this.swayY = 0;
    this.swayYaw = 0;
    this.swayPitch = 0;
    for (const id of WEAPON_IDS) {
      this.rigs[id].supportArm.position.setAll(0);
      this.rigs[id].supportArm.setEnabled(true);
    }
    this.throwHand.setEnabled(false);
  }

  /**
   * Takes the weapon off the shoulder and puts it on the loadout screen's
   * turntable, opened at the authored angles rather than wherever it was left
   * three deploys ago — the same rule the kit screen's own cursor follows.
   *
   * The pose switches to a quaternion here, and that is not a detail: the
   * carried pose is Euler and Babylon composes it in the WEAPON's frame, so at
   * a side-on yaw the pitch a drag asks for arrives as a roll. A quaternion
   * built yaw-then-pitch keeps the pitch about the camera's own horizontal
   * axis at every yaw, which is what makes a drag feel like a hand on the
   * weapon. `endInspect` puts the Euler pose back.
   */
  beginInspect(): void {
    const i = CONFIG.viewmodel.inspect;
    this.inspectYaw = i.baseYaw;
    this.inspectPitch = i.basePitch;
    this.weapon.rotationQuaternion = this.spinQ;
    this.inspecting = true;
    // Nothing here runs `update`, so a throw caught by the kit screen would
    // leave its arm frozen across the turntable for as long as the screen is up.
    this.throwHand.setEnabled(false);
    this.applyMeshVisibility();
  }

  /** Hands the weapon back to the carried pose, hands and all. */
  endInspect(): void {
    // Euler `rotation` is dead while this is set, so dropping it is what lets
    // the hip pose return at all.
    this.weapon.rotationQuaternion = null;
    this.weapon.scaling.setAll(CONFIG.viewmodel.scale);
    this.inspecting = false;
    this.applyMeshVisibility();
  }

  /**
   * Turns the weapon on the turntable — radians, from a drag or a stick. Yaw
   * wraps; pitch stops short of straight up and down, where a spinning
   * turntable stops reading as one.
   */
  spinInspect(dYaw: number, dPitch: number): void {
    const i = CONFIG.viewmodel.inspect;
    this.inspectYaw = (this.inspectYaw + dYaw) % (Math.PI * 2);
    this.inspectPitch = clamp(this.inspectPitch + dPitch, -i.pitchMax, i.pitchMax);
  }

  /**
   * Poses the weapon on the turntable. Not a step of `update` — nothing that
   * moves the carried weapon applies to one being looked at, so sway, bob, the
   * kick and the whole hip/ADS blend are simply absent.
   *
   * Two things are derived rather than authored, and both are what make the
   * stage hold still:
   * - The position is the stage's screen anchor BACK-PROJECTED to the inspect
   *   distance, so the weapon sits where the DOM says the stage is at any
   *   window size, and the distance is scaled by the live FOV against the
   *   hip-fire one so a camera left zoomed by the last round frames it the
   *   same. (Babylon holds the vertical FOV, hence the aspect on x alone.)
   * - The pivot correction. The node rotates about its own origin, which on a
   *   rifle is the receiver and nowhere near the middle of the model, so a
   *   turntable about it would swing the weapon around the screen. Placing the
   *   ROTATED pivot on the anchor instead keeps the weapon's own centre
   *   nailed to the stage while it turns.
   */
  updateInspect(p: InspectParams): void {
    const v = CONFIG.viewmodel;
    const i = v.inspect;

    // Yaw first, then pitch about the camera's horizontal axis: Babylon's
    // matrix product applies the left operand first (the same order
    // scale-rotate-translate is composed in).
    Matrix.RotationYToRef(this.inspectYaw, this.spinYaw);
    Matrix.RotationXToRef(this.inspectPitch, this.spinPitch);
    this.spinYaw.multiplyToRef(this.spinPitch, this.spin);
    Quaternion.FromRotationMatrixToRef(this.spin, this.spinQ);

    // The distance also gives way to a viewport narrower than the one the
    // framing was authored for: apparent size follows the VERTICAL fov, while
    // the room the weapon has to fit in is the stage's share of the WIDTH, so
    // on a nearly square window a rifle framed for 16:9 lies across the panel.
    const fit = Math.max(1, i.aspectReference / p.aspect);
    // Written as "hold the visible half-height at the weapon" rather than as a
    // distance, because that IS the framing: how much of the world fits beside
    // the weapon is what decides how big it looks, and holding it fixed is what
    // makes the stage identical through any FOV the last round left behind.
    const halfH = i.dist * fit * Math.tan(CONFIG.camera.fovHip / 2);
    const dist = halfH / Math.tan(p.fovY / 2);
    this.pos.copyFrom(this.pivot).scaleInPlace(v.scale);
    Vector3.TransformCoordinatesToRef(this.pos, this.spin, this.pos);
    this.pos.set(
      i.anchorX * halfH * p.aspect - this.pos.x,
      i.anchorY * halfH - this.pos.y,
      dist - this.pos.z,
    );

    this.weapon.position.copyFrom(this.pos);
    this.weapon.scaling.setAll(v.scale);
  }

  update(dt: number, p: ViewModelParams): void {
    const v = CONFIG.viewmodel;
    const t = smoothstep01(clamp(p.adsBlend, 0, 1));

    // --- base pose: hip -> aimed, with sprint and reload layered on top ---
    // The state offsets are additive rather than exclusive, so a reload that
    // starts mid-sprint bends out of one and into the other with no pop.
    Vector3.LerpToRef(this.hipPos, this.adsPos, t, this.pos);
    this.rot.copyFrom(this.hipRot).scaleInPlace(1 - t);
    this.off.setAll(0);
    const sprintW = p.sprintBlend;
    if (sprintW > 0.001) {
      addScaled(this.off, v.sprintPos, sprintW);
      addScaled(this.rot, v.sprintRot, sprintW);
    }
    const reloadW = p.reloadBlend;
    if (reloadW > 0.001) {
      addScaled(this.off, v.reloadPos, reloadW);
      addScaled(this.rot, v.reloadRot, reloadW);
    }
    // The throw's give is NOT a symmetric arc like the blends above: it is the
    // support hand being somewhere else, so it comes on as fast as the hand
    // leaves the handguard, holds for as long as the hand is away, and eases
    // back as the arm returns. A weapon that dipped and recovered on a bell
    // curve is the shape of a recoil impulse, which is exactly what the old
    // throw was mistaken for.
    const th = v.throw;
    const total = th.windup + th.recover;
    const cockT = th.windup * th.cockFrac;
    const throwing = p.throwTime >= 0 && p.throwTime <= total;
    if (throwing) {
      const w =
        ramp(0, cockT, p.throwTime) *
        (1 - ramp(th.windup + th.recover * 0.3, total, p.throwTime));
      addScaled(this.off, th.weaponPos, w);
      addScaled(this.rot, th.weaponRot, w);
    }

    // --- sway: the weapon trails the look, damped hard while braced ---
    const swayMult = 1 - (1 - v.adsSwayMult) * t;
    const s = Math.min(1, dt * v.swaySmooth);
    this.swayX += (clamp(-p.turnRate * v.swayPos, -v.swayMax, v.swayMax) - this.swayX) * s;
    this.swayY +=
      (clamp(-p.pitchRate * v.swayPitchPos, -v.swayMax, v.swayMax) - this.swayY) * s;
    this.swayYaw +=
      (clamp(-p.turnRate * v.swayRot, -v.swayMax, v.swayMax) - this.swayYaw) * s;
    this.swayPitch +=
      (clamp(p.pitchRate * v.swayRot, -v.swayMax, v.swayMax) - this.swayPitch) * s;
    this.off.x += this.swayX * swayMult;
    this.off.y += this.swayY * swayMult;
    this.rot.y += this.swayYaw * swayMult;
    this.rot.x += this.swayPitch * swayMult;

    // --- bob: the camera's phase, so the weapon strides with the view ---
    const bobW = p.moveBlend * (1 - (1 - v.adsBobMult) * t);
    if (bobW > 0.001) {
      this.off.x += Math.sin(p.bobPhase) * v.bobLateral * bobW;
      this.off.y += Math.sin(p.bobPhase * 2) * v.bobVertical * bobW;
      this.rot.z += Math.sin(p.bobPhase) * v.bobRoll * bobW;
    }

    // --- airborne give: the weapon lags the body through a jump ---
    // Sprung, not read straight off velY. Vertical speed is a STEP function at
    // both ends of a jump — 0 to jumpVelocity at the push, impact speed to 0
    // on the frame the feet land — so a give taken directly from it snaps the
    // full `airDropMax` back to neutral in one frame, which is exactly the
    // pop the landing absorb below exists to replace.
    const give = -clamp(p.velY * v.airDrop, -v.airDropMax, v.airDropMax);
    this.airGive += (give - this.airGive) * Math.min(1, dt * v.airDropSmooth);
    this.off.y += this.airGive;

    // --- landing absorb: the hands take the impact after the eye does ---
    // The camera owns the spring and this reads it, the same arrangement as
    // the bob phase. The weapon is parented to the camera, so it already
    // travels with the dip; what these two add is the part that SHOWS — a
    // share of the sink again on top of it, and the muzzle dropping (rot.x
    // positive is nose-down, the way the per-shot kick is nose-up) as the
    // arms give and come back.
    this.off.y += p.landDip * v.landFollow;
    this.rot.x -= p.landDip * v.landPitch;

    // --- per-shot kick: back, up, and nose-high ---
    if (p.kick > 0.001) {
      const r = CONFIG.recoil;
      this.off.z -= r.kickBack * p.kick;
      this.off.y += r.kickBack * 0.25 * p.kick;
      this.rot.x -= r.kickPitch * p.kick;
    }

    // The zoom compensation rides the same blend as the pose, so the weapon
    // shrinks into the aim exactly as the FOV closes around it and its
    // apparent size never jumps. At t = 0 this is 1 and the hip pose is
    // untouched; with a sight at or under the reference magnification it is 1
    // throughout and both lines below are a multiply by one.
    const k = 1 + (this.sight.zoomComp - 1) * t;
    this.pos.addInPlace(this.off.scaleInPlace(k));
    this.weapon.position.copyFrom(this.pos);
    this.weapon.rotation.copyFrom(this.rot);
    this.weapon.scaling.setAll(v.scale * k);

    // --- support hand: off the handguard, to the magwell, and back ---
    const magW = this.magWindow(p);
    const supportArm = this.rigs[this.weaponFit.id].supportArm;
    if (magW > 0.0001 || supportArm.position.lengthSquared() > 0) {
      const o = v.magHandOffset;
      supportArm.position.set(o.x * magW, o.y * magW, o.z * magW);
    }
    // ...and off the weapon entirely for a throw. The hand that throws IS the
    // support hand, so leaving it welded to the handguard would put two left
    // arms on screen at once — and hiding it is what motivates the give above:
    // the weapon tips because only the firing hand is still on it.
    supportArm.setEnabled(!throwing);

    // --- the throwing arm: the gesture the grenade actually leaves from ---
    this.throwHand.setEnabled(throwing);
    if (throwing) this.poseThrowHand(p.throwTime, cockT, th.windup, total);
  }

  /**
   * Places the throwing hand on the gesture's timeline. Four keys and one lerp
   * between two of them; what carries the read is the EASING, which differs
   * per segment because the phases of a throw are not the same motion:
   * - the wind-up eases in and out — the arm cocking is deliberate;
   * - the whip eases IN and is cut off at the release, so the hand is at its
   *   fastest on the very frame the grenade leaves it, which is the frame the
   *   eye is asked to believe the throw on;
   * - the follow-through eases OUT, the arm running down against itself;
   * - the return is a smoothstep, out of frame and forgotten.
   */
  private poseThrowHand(
    t: number,
    cockT: number,
    windup: number,
    total: number,
  ): void {
    const holdT = windup + (total - windup) * THROW_FOLLOW_FRAC;
    let a = 0;
    let b = 1;
    let w: number;
    if (t <= cockT) {
      w = smoothstep01(t / cockT);
    } else if (t <= windup) {
      a = 1;
      b = 2;
      const x = (t - cockT) / (windup - cockT);
      w = x * x;
    } else if (t <= holdT) {
      a = 2;
      b = 3;
      const x = (t - windup) / (holdT - windup);
      w = 1 - (1 - x) * (1 - x);
    } else {
      a = 3;
      b = 0;
      w = smoothstep01((t - holdT) / (total - holdT));
    }
    Vector3.LerpToRef(
      this.throwKeys[a].pos,
      this.throwKeys[b].pos,
      w,
      this.throwHand.position,
    );
    Vector3.LerpToRef(
      this.throwKeys[a].rot,
      this.throwKeys[b].rot,
      w,
      this.throwHand.rotation,
    );
    // The frag is in the fist right up to the release and gone after it: the
    // one in the air from that frame on is GrenadeSystem's, thrown from this
    // hand's own position, and two of them on screen at once would give the
    // whole thing away.
    this.throwBall.setEnabled(t < windup);
  }

  /**
   * Where the throwing hand is in the world — the release point Game hands to
   * `GrenadeSystem`, so the grenade leaves the hand the player watched cock
   * back instead of appearing on the camera axis like a muzzle. One frame
   * stale in the camera's own motion, exactly as the muzzle and the ejection
   * port are, because the camera has not been updated yet this frame.
   */
  throwHandWorld(): Vector3 {
    return this.throwHand.getAbsolutePosition().clone();
  }

  /**
   * Support-hand weight over the reload: ramps in as the hand leaves the
   * handguard, holds through the swap, ramps out on the way back. Zero unless
   * a reload is actually in flight.
   */
  private magWindow(p: ViewModelParams): number {
    if (p.reloadBlend < 0.01) return 0;
    const w = CONFIG.viewmodel.magWindow;
    return p.reloadBlend * ramp(w[0], w[1], p.reloadPhase) * (1 - ramp(w[2], w[3], p.reloadPhase));
  }
}

function addScaled(
  target: Vector3,
  by: { x: number; y: number; z: number },
  w: number,
): void {
  target.x += by.x * w;
  target.y += by.y * w;
  target.z += by.z * w;
}

/**
 * One gloved hand plus the forearm running back out of frame, built at the
 * origin in weapon-local units and merged per colour before being parented —
 * the arm is rigid relative to the weapon (a viewmodel's hands never let go),
 * so there is nothing to animate and every reason to collapse the draw calls.
 * Each weapon gets its own pair, because where a hand sits is the model's
 * business and a shorter gun is held somewhere else entirely.
 *
 * The forearm is aimed with a throwaway node rather than trigonometry:
 * `lookAt` puts local +z on the elbow and the cylinders are laid along it.
 * Every part is then detached with `setParent(null)` — which folds the aim
 * node's transform into the part's own — BEFORE the merge, because
 * `bakeCurrentTransformIntoVertices` (the one-mesh path, as in MapBuilder)
 * resets the local matrix and would leave a still-parented mesh transformed
 * twice.
 */
function buildArm(
  scene: Scene,
  mats: CelMaterialFactory,
  name: string,
  grip: GripSpec,
  parent: TransformNode,
): Mesh[] {
  const parts = new Map<string, Mesh[]>();
  const collect = (color: string, m: Mesh) => {
    m.material = mats.get(color);
    m.isPickable = false;
    const g = parts.get(color);
    if (g) g.push(m);
    else parts.set(color, [m]);
  };

  // The fist: a blocky glove wrapped around the grip/handguard.
  const fist = MeshBuilder.CreateBox(
    `view_${name}Hand`,
    { width: 0.09, height: 0.125, depth: 0.11 },
    scene,
  );
  fist.position.copyFrom(grip.hand);
  collect(GLOVE, fist);

  // Wrist -> elbow, tapering out to the sleeve.
  const aim = new TransformNode(`view_${name}Aim`, scene);
  aim.position.copyFrom(grip.hand);
  aim.lookAt(grip.elbow);
  const len = Vector3.Distance(grip.hand, grip.elbow);

  const wrist = MeshBuilder.CreateCylinder(
    `view_${name}Wrist`,
    { height: len * 0.28, diameterTop: 0.084, diameterBottom: 0.092, tessellation: 8 },
    scene,
  );
  wrist.parent = aim;
  wrist.rotation.x = Math.PI / 2; // +y axis -> the aim node's +z
  wrist.position.z = len * 0.16;
  collect(GLOVE, wrist);

  const sleeve = MeshBuilder.CreateCylinder(
    `view_${name}Sleeve`,
    { height: len * 0.76, diameterTop: 0.096, diameterBottom: 0.13, tessellation: 8 },
    scene,
  );
  sleeve.parent = aim;
  sleeve.rotation.x = Math.PI / 2;
  sleeve.position.z = len * 0.62;
  collect(SLEEVE, sleeve);

  const merged: Mesh[] = [];
  for (const [color, group] of parts) {
    for (const m of group) m.setParent(null);
    const m =
      group.length === 1
        ? group[0].bakeCurrentTransformIntoVertices()
        : Mesh.MergeMeshes(group, true, true);
    if (!m) continue;
    m.name = `view_${name}_${color.slice(1)}`;
    m.material = mats.get(color);
    m.parent = parent;
    m.isPickable = false;
    merged.push(m);
  }
  aim.dispose();
  return merged;
}
