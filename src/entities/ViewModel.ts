/**
 * ViewModel.ts — The first-person weapon: whichever gun is carried and the two
 * gloved arms holding it, parented to the camera, plus every offset that moves
 * them (hip/ADS pose, sprint carry, reload dip and mag swap, sway, bob, kick).
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
 * - Both weapons are built once and all but the carried one is disabled, the
 *   same trick the optics use: a loadout change is a handful of boolean
 *   writes and a re-derivation, never a rebuild. That is also why the muzzle
 *   and the ejection port are nodes owned HERE rather than the model's — they
 *   have things hanging off them (Player's flash) that must survive a swap.
 * - Everything here is cosmetic. It reads the camera; it never writes it, and
 *   it never touches aim, spread or damage.
 * - Meshes render in VIEWMODEL_GROUP with the depth buffer cleared first, so
 *   the weapon is never sliced open by the wall the player is standing
 *   against. Anything else attached to it (Player's muzzle flash) must join
 *   that group or it will be hidden behind the gun it belongs to.
 * - Arms are built at the origin and merged per colour before being parented,
 *   the same rule as BuildingKit and the weapon models: MergeMeshes bakes
 *   world matrices, so the merge is only correct at identity.
 */
import {
  Color3,
  Mesh,
  MeshBuilder,
  type Node,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import type { CelMaterialFactory } from "../shaders/CelShader";
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
  /** Per-shot punch, 1 at the shot and squared by the caller. */
  kick: number;
  /** Smoothed look rates (rad/s) — the weapon trails both. */
  turnRate: number;
  pitchRate: number;
  /** The camera's bob phase, so weapon and view stride together. */
  bobPhase: number;
  /** Vertical velocity (m/s), for the airborne give. */
  velY: number;
}

const GLOVE = "#23262c";
const SLEEVE = "#3d4335";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const smoothstep01 = (x: number) => x * x * (3 - 2 * x);
/** Ramp from a to b, clamped at both ends. */
const ramp = (a: number, b: number, x: number) =>
  smoothstep01(clamp((x - a) / (b - a), 0, 1));

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

  /** Aimed position, derived from the fit (see the header). */
  private readonly adsPos = new Vector3();
  /** The carried weapon and the fitted optic. Written only by `applyFit`. */
  private weaponFit: WeaponSetup = weaponSetup(DEFAULT_WEAPON);
  private sight: SightSetup = sightSetup(DEFAULT_SIGHT);
  /** The authored hip pose, plus the carried weapon's own length offset. */
  private readonly hipPos: Vector3;
  private readonly hipRot: Vector3;

  // Sway state: a spring behind the look rates, so the weapon settles after
  // the camera has stopped instead of snapping back with it.
  private swayX = 0;
  private swayY = 0;
  private swayYaw = 0;
  private swayPitch = 0;

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

  constructor(scene: Scene, mats: CelMaterialFactory, camera: Node) {
    const v = CONFIG.viewmodel;
    this.hipPos = new Vector3(v.hipPos.x, v.hipPos.y, v.hipPos.z);
    this.hipRot = new Vector3(v.hipRot.x, v.hipRot.y, v.hipRot.z);

    this.weapon = new TransformNode("viewmodel", scene);
    this.weapon.parent = camera;
    this.weapon.scaling.setAll(v.scale);

    // Both weapons are built up front. The cost is one extra set of merged
    // colour groups sitting disabled — against a rebuild in the middle of a
    // deploy screen, which would drop Player's muzzle flash on the floor and
    // stall the frame it happened on.
    for (const id of WEAPON_IDS) {
      const root = new TransformNode(`viewmodel_${id}`, scene);
      root.parent = this.weapon;
      const parts = WEAPON_BUILDERS[id](scene, mats, `view_${id}`);
      parts.root.parent = root;
      const supportArm = new TransformNode(`viewmodel_${id}_supportArm`, scene);
      supportArm.parent = root;
      this.meshes.push(...parts.meshes);
      this.meshes.push(...buildArm(scene, mats, `${id}_trigger`, parts.grip, root));
      this.meshes.push(
        ...buildArm(scene, mats, `${id}_support`, parts.support, supportArm),
      );
      this.rigs[id] = { root, parts, supportArm };
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
    // had; zero it, or picking it up again starts with the hand at the magwell.
    for (const wid of WEAPON_IDS) this.rigs[wid].supportArm.position.setAll(0);
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
    for (const m of this.meshes) m.isVisible = visible;
  }

  /** Drops every transient offset — called when a round starts. */
  reset(): void {
    this.swayX = 0;
    this.swayY = 0;
    this.swayYaw = 0;
    this.swayPitch = 0;
    for (const id of WEAPON_IDS) this.rigs[id].supportArm.position.setAll(0);
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
    this.off.y -= clamp(p.velY * v.airDrop, -v.airDropMax, v.airDropMax);

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
