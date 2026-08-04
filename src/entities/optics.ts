/**
 * optics.ts — The three fittable sights, built onto whatever weapon asked for
 * them.
 * Owns: the geometry of the irons, the holo and the scope, and the eye
 * reference each one reports. Owns nothing about what a sight DOES — that is
 * `sights.ts`, from `CONFIG.sights`.
 *
 * Shared by both weapons on purpose: an optic is a thing bolted to a rail, and
 * the rifle and the SMG both have one. Duplicating these builders per weapon
 * would be three more places for the eye reference to drift, and the eye
 * reference is the number ADS derives the whole aimed pose from.
 *
 * Everything here is expressed against the weapon's own `OpticMount` — the
 * height of its rail and where along it the sight sits — so the same optic
 * lands correctly on a receiver of a different height without a single number
 * being re-tuned. That is not a convenience: `ViewModel.setSight` derives the
 * aimed pose from `sightCenter`, so a sight that ends up somewhere else is
 * still perfectly aligned, just carried differently.
 *
 * The other number everything is measured against is `eyeDistance` — how far
 * back the eye is held, which is what turns a length here into the angle the
 * shooter actually gets. It lives in `CONFIG.sights`, so an optic's size and
 * its eye relief are two halves of one decision; see `eyeDistance` below.
 *
 * Invariants: each optic is merged into its OWN meshes rather than into the
 * weapon's, which is what lets one be swapped for another without rebuilding
 * the gun under it. Emissive parts go through `build.lit`, never `collect`.
 */
import { MeshBuilder, Mesh, Color3, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import { SIGHT_IDS, type SightId } from "./sights";
import { FACETS, METAL, POLYMER, type SightAssembly, type WeaponBuild } from "./weaponKit";

/**
 * Where a weapon offers its rail, and where along it a sight sits. Everything
 * an optic builds is measured from these four numbers.
 */
export interface OpticMount {
  /** Top face of the receiver's rail — what every sight base stands on. */
  railTop: number;
  /** The optic's own centre along the barrel axis (the holo window). */
  mountZ: number;
  /** The rear and front back-up iron stations. */
  ironRearZ: number;
  ironFrontZ: number;
}

/**
 * How far the eye sits behind a sight's own centre, in WEAPON units — the one
 * number every size here is measured against.
 *
 * An optic is only ever seen through, so what matters about it is angular: the
 * bore's half-angle at the eye is `radius / eyeDistance`, and NOTHING else
 * about the sight picture is a length. Halve an optic and halve the distance
 * the eye is held at, and the picture through it is identical to the pixel
 * while the thing bolted to the weapon is half the size. That is the whole
 * reason these are as small as they are: the sights used to be sized against
 * an eye held a rifle's length back, which made every one of them wider than
 * the receiver it stood on.
 *
 * `CONFIG.sights[id].eyeRelief` is in the CAMERA's frame and the weapon is
 * drawn at `viewmodel.scale`, so the conversion is that scale — see
 * `ViewModel.applyFit`, which derives the aimed pose from the same two numbers
 * in the other direction.
 */
const eyeDistance = (id: SightId): number =>
  CONFIG.sights[id].eyeRelief / CONFIG.viewmodel.scale;

/**
 * Rises above the rail. Each is the LOWEST its own optic can be carried, and
 * for the two tube sights the floor is the same thing: the cone the eye sees
 * through the sight spreads with distance, and where it spreads far enough it
 * runs onto the weapon's own top deck — the rifle's rail runs out to 0.53 with
 * a folded iron leaf standing on the end of it. A sight lower than this puts
 * the gun in its own picture. The irons have no such floor, because what you
 * see under the front post through a rear aperture IS the weapon.
 *
 * These are therefore not free to be "realistic", and they are what is left of
 * the old bulk: the optics themselves came down by a third to a half, the
 * mounts under them by rather less.
 */
const IRON_RISE = 0.036;
const WIN_RISE = 0.078;
const SCOPE_RISE = 0.1;

/**
 * The holo's clear bore and wall. The shooter looks PAST the wall, so every
 * millimetre of it costs sight picture — keep it near the outline width and
 * let the bore carry the size. Outer radius is `(BORE + WALL * 2) / 2`, which
 * is what the turrets and the mount stand off from.
 *
 * The bore is `2 * eyeDistance("holo") * tan(half-angle)`, and the half-angle
 * is what the window is FOR — about 3.3 deg, a window a fifth of the screen
 * high, wide enough to find a target through and small enough that the housing
 * is not the largest thing on the weapon.
 */
const BORE = 0.072;
const WALL = 0.007;

/**
 * The two iron stations share a bore, which is what gives the picture its
 * depth: the rear ring is a third of the eye's distance to the front one, so
 * it reads as twice the size and the front hood floats inside it.
 */
const IRON_BORE = 0.048;

/**
 * The 3.5x scope. A telescope here is a real tube the eye looks down — there
 * is no lens and no post-process, so how much of the frame is clear glass is
 * decided by the rim's angular size, and the bore has to be wide enough to be
 * worth looking through: `SCOPE_CONE` is the tangent of the half-angle that
 * buys, and at these numbers the picture is a circle about two thirds of the
 * screen high.
 *
 * That single number is what sizes the body, because a straight tube is the
 * WORST shape to spend it on: a cylinder wide enough not to clip the cone at
 * the objective is far wider than the cone needs at the eyepiece, which is
 * exactly the drainpipe this used to be. The tube is built as `SCOPE_SECTIONS`
 * steps instead, each only as wide as the cone is at ITS far rim — so the body
 * flares from eyepiece to objective the way a real scope's does, and the
 * silhouette is a scope rather than a can.
 */
const SCOPE_CONE = 0.099;
const SCOPE_WALL = 0.007;
const SCOPE_SECTIONS = 3;
/**
 * Ocular and objective, relative to `mountZ`. The tube's height and length are
 * set by ONE constraint, and it is not appearance: the view cone runs onto the
 * weapon's own rail and barrel where it spreads far enough, putting a lit
 * muzzle device inside the bottom of the sight picture. `SCOPE_RISE` is high
 * enough to keep the cone's lower edge clear of the rail, the gas block and
 * the flash hider all the way out, and the scope's omission of the folded
 * front iron is the same constraint again. Lower the rings and the weapon
 * appears in its own scope.
 *
 * Length is the one dimension that is NOT free to shrink with the rest: the
 * far rim's distance from the eye is what the bore is divided by, so a shorter
 * tube is a wider one. This is as long as it can be without reaching past the
 * charging handle.
 */
const SCOPE_OCULAR_DZ = -0.13;
const SCOPE_OBJECTIVE_DZ = 0.12;

/**
 * The clear bore a scope section ending `dz` from the sight centre must carry,
 * so that its far rim sits exactly on the view cone.
 */
const scopeBore = (dz: number): number =>
  2 * SCOPE_CONE * (eyeDistance("scope") + dz - SCOPE_OCULAR_DZ);

/**
 * The height a weapon's own geometry must stay UNDER at depth `z`, if it is not
 * to eat into the iron sight picture.
 *
 * What the eye gets through an aperture is the cone from the eye to the rear
 * ring's bore, and anything standing into that cone between the two takes a
 * bite out of the picture — enough of it and the picture is gone. The eye sits
 * `eyeDistance("iron")` behind the rear station (that is exactly what
 * `ViewModel.applyFit` puts it at), so the cone's lower edge is the straight
 * line from there to the bore's lower rim; this is that line at `z`.
 *
 * Exported because a stock is the one part of a weapon that lives BEHIND its
 * own rear sight, which makes it the one part whose height is not free — see
 * the comb in `DmrModel`, which is what this was written for. Forward of the
 * rear station the same cone runs onto the rail and the front sight's own
 * base, and that is not a fault: what you see under the post through an
 * aperture is meant to be the weapon.
 */
export function ironSightFloor(mount: OpticMount, z: number): number {
  const eyeBack = eyeDistance("iron");
  return (
    mount.railTop +
    IRON_RISE -
    (IRON_BORE / 2) * ((z - mount.ironRearZ + eyeBack) / eyeBack)
  );
}

/**
 * Builds all three optics onto one weapon and returns them keyed by id, with
 * every mesh they added.
 *
 * Called with the weapon already merged, so `build`'s colour groups are empty
 * and each optic's parts land in its own meshes.
 */
export function buildOptics(
  build: WeaponBuild,
  mount: OpticMount,
  prefix: string,
): { sights: Record<SightId, SightAssembly>; meshes: Mesh[] } {
  const b = build;
  const ironY = mount.railTop + IRON_RISE;
  const winY = mount.railTop + WIN_RISE;
  const scopeY = mount.railTop + SCOPE_RISE;
  const winZ = mount.mountZ;

  /**
   * The back-up irons, folded flat the way they would be with an optic
   * mounted — standing them up would put pillars in the middle of the sight
   * picture the housing exists to keep clear. Part of each OPTIC rather than
   * of the weapon, so the iron loadout can stand its own sights up in the same
   * place without two sets of leaves fighting over it.
   */
  const foldedIrons = (front: boolean): void => {
    const r = mount.railTop;
    b.box("rsBase", METAL, 0.034, 0.016, 0.032, 0, r + 0.002, mount.ironRearZ + 0.042);
    b.box("rsLeaf", METAL, 0.028, 0.01, 0.062, 0, r + 0.008, mount.ironRearZ);
    // The front pair is the last thing the scope's view cone runs onto — see
    // SCOPE_OCULAR_DZ. A weapon wearing a scope this size is set up around it
    // rather than over a set of irons, so it simply does not carry them.
    if (!front) return;
    b.box("fsBase", METAL, 0.032, 0.016, 0.028, 0, r + 0.002, mount.ironFrontZ - 0.044);
    b.box("fsLeaf", METAL, 0.026, 0.008, 0.062, 0, r + 0.007, mount.ironFrontZ);
  };

  /**
   * Irons: a rear aperture on a low block and a hooded front post. The post's
   * TIP and the aperture's centre both sit on `ironY`, which is where the
   * sight centre goes — so aiming lines all three up at once and the picture
   * is right by construction.
   */
  const buildIron = (node: TransformNode): Vector3 => {
    // Both bases stand from the rail to the BORE's floor, never into it. The
    // bore's lower edge is only a few millimetres above the receiver from the
    // eye's point of view, so a base sized by hand blocks the bottom of the
    // aperture — which reads as a sight with a bite taken out of it.
    const floor = ironY - IRON_BORE / 2;
    const baseH = floor - mount.railTop;
    const baseY = (mount.railTop + floor) / 2;
    // Rear: a ring standing just clear of the rail on its own base.
    b.box("ironRearBase", METAL, 0.026, baseH, 0.026, 0, baseY, mount.ironRearZ);
    b.shell("ironRearRing", METAL, IRON_BORE, 0.0055, 0.01, ironY, mount.ironRearZ, 10);
    // Front: the same ring as a hood, with the post rising from its floor to
    // the axis. The bead is the aim point — a tritium dot, and the only thing
    // on this sight that is visible against a dark treeline.
    b.box("ironFrontBase", METAL, 0.028, baseH, 0.028, 0, baseY, mount.ironFrontZ);
    b.shell("ironFrontHood", METAL, IRON_BORE, 0.005, 0.012, ironY, mount.ironFrontZ, 10);
    const postH = IRON_BORE / 2;
    b.box("ironPost", METAL, 0.005, postH, 0.007, 0, ironY - postH / 2, mount.ironFrontZ);
    b.merge("iron", node);
    const bead = b.lit(
      MeshBuilder.CreateSphere(
        `${prefix}_ironBead`,
        { diameter: 0.005, segments: 6 },
        b.scene,
      ),
      node,
    );
    bead.position.set(0, ironY, mount.ironFrontZ);
    // The eye reference is the REAR aperture: that is the hole you look
    // through, and the front post lands on the axis behind it for free.
    return new Vector3(0, ironY, mount.ironRearZ);
  };

  /**
   * The holographic sight: rail mount plus a round tube housing around the
   * sight axis, with a lit ring and dot floating in the bore.
   *
   * The mount's top face meets the housing's underside exactly, so the two
   * read as one assembly rather than a sight balanced on a block.
   */
  const buildHolo = (node: TransformNode): Vector3 => {
    foldedIrons(true);
    // Turrets and battery cap, standing off the housing's outer radius.
    const rOut = BORE / 2 + WALL;
    // Foot plate on the rail, and a saddle from it to the housing's underside.
    // The saddle is whatever is LEFT between the two, not a size of its own:
    // at this rise it is a low mount rather than the riser block the old
    // shoulder-height housing needed, and hard-coding a height for it would
    // put the tube back up in the air or bury it in the receiver.
    const footY = mount.railTop + 0.004;
    const saddleFrom = mount.railTop + 0.008;
    const saddleTo = winY - rOut;
    b.box("opticFoot", METAL, 0.056, 0.01, 0.104, 0, footY, winZ);
    b.box(
      "opticMount",
      POLYMER,
      0.048,
      saddleTo - saddleFrom,
      0.096,
      0,
      (saddleFrom + saddleTo) / 2,
      winZ,
    );
    b.box("opticLever", METAL, 0.014, 0.022, 0.038, 0.031, footY + 0.006, winZ + 0.02);
    b.pin("opticNut", METAL, 0.01, 0.062, 0, footY + 0.006, winZ - 0.032);
    // The housing: a shell of `FACETS` slabs about the sight axis, with a
    // heavier rim at each end. The bore is the sight picture — the rims are
    // sized OUTWARD from it so a wider rim never eats into what you can see.
    b.shell("sightTube", POLYMER, BORE, WALL, 0.042, winY, winZ);
    b.shell("sightRimF", POLYMER, BORE + 0.003, 0.009, 0.011, winY, winZ + 0.024);
    b.shell("sightRimR", POLYMER, BORE + 0.003, 0.009, 0.011, winY, winZ - 0.024);
    b.pin("elevTurret", METAL, 0.022, 0.013, 0, winY + rOut + 0.006, winZ, "y");
    b.pin("elevCap", METAL, 0.016, 0.006, 0, winY + rOut + 0.016, winZ, "y");
    b.pin("windTurret", METAL, 0.022, 0.013, rOut + 0.006, winY, winZ, "x");
    b.pin("battery", METAL, 0.019, 0.012, -(rOut + 0.006), winY - 0.006, winZ, "x");
    b.merge("holo", node);

    // Reticle: emissive ring + center dot.
    // Scaled with the bore, so the ring subtends what it always did: a reticle
    // is an angle, and one left at its old size in a smaller window would fill
    // the picture it is supposed to sit in.
    const ring = b.lit(
      MeshBuilder.CreateTorus(
        `${prefix}_reticleRing`,
        { diameter: 0.016, thickness: 0.002, tessellation: 24 },
        b.scene,
      ),
      node,
    );
    ring.rotation.x = Math.PI / 2; // face down the barrel axis
    ring.position.set(0, winY, winZ - 0.003);

    const dot = b.lit(
      MeshBuilder.CreateSphere(
        `${prefix}_reticleDot`,
        { diameter: 0.0032, segments: 6 },
        b.scene,
      ),
      node,
    );
    dot.position.set(0, winY, winZ - 0.003);

    // Faint holo glass filling the bore (own material — alpha must not leak
    // into the shared emissive cache). A disc, not a quad: the corners of a
    // square lens would poke through a round housing.
    const glassMat = new StandardMaterial(`${prefix}_holoGlass`, b.scene);
    glassMat.emissiveColor = Color3.FromHexString("#35f0ff");
    glassMat.diffuseColor = Color3.Black();
    glassMat.specularColor = Color3.Black();
    glassMat.disableLighting = true;
    glassMat.alpha = 0.12;
    const glass = MeshBuilder.CreateDisc(
      `${prefix}_holoGlass`,
      { radius: BORE / 2, tessellation: FACETS, sideOrientation: Mesh.DOUBLESIDE },
      b.scene,
    );
    glass.parent = node;
    glass.position.set(0, winY, winZ + 0.009);
    glass.material = glassMat;
    // noGlow: the GlowLayer would turn the faint tint into a cyan haze that
    // obscures the sight picture.
    glass.metadata = { noOutline: true, noGlow: true };
    glass.isPickable = false;

    return new Vector3(0, winY, winZ);
  };

  /**
   * The 3.5x scope: a long tube in two clamp rings, with a duplex reticle
   * hung near the objective end.
   *
   * There is no glass and no post-process here — the eye genuinely looks down
   * a hollow tube, and what it can see through it is set by the far rim. That
   * is why the bore is half again the holo's: at 3.5x a narrow tube is a
   * keyhole. The reticle's arms are cut to just inside that far rim, so they
   * run out to the edge of the visible circle and stop.
   */
  const buildScope = (node: TransformNode): Vector3 => {
    foldedIrons(false);
    const ocularZ = winZ + SCOPE_OCULAR_DZ;
    const objectiveZ = winZ + SCOPE_OBJECTIVE_DZ;
    const seg = (SCOPE_OBJECTIVE_DZ - SCOPE_OCULAR_DZ) / SCOPE_SECTIONS;
    // The body, as steps that each just clear the cone at their own far rim.
    // A section is limited by that rim and by nothing else — its near end is
    // always wider than the cone needs there — so the staircase circumscribes
    // the cone and the sight picture is the last section's.
    // A section's outer radius is its FAR rim's — which is the radius the
    // whole section carries, so anything clamped to or standing on the tube at
    // `dz` has to be sized against the section `dz` falls in, not against the
    // cone where it happens to sit.
    const outerAt = (dz: number): number => {
      const i = Math.min(
        SCOPE_SECTIONS,
        Math.max(1, Math.ceil((dz - SCOPE_OCULAR_DZ) / seg)),
      );
      return scopeBore(SCOPE_OCULAR_DZ + i * seg) / 2 + SCOPE_WALL;
    };
    for (let i = 0; i < SCOPE_SECTIONS; i++) {
      const far = SCOPE_OCULAR_DZ + seg * (i + 1);
      b.shell(
        "scopeTube",
        POLYMER,
        scopeBore(far),
        SCOPE_WALL,
        seg,
        scopeY,
        winZ + far - seg / 2,
      );
    }
    const rOcular = outerAt(SCOPE_OCULAR_DZ);
    const rObjective = outerAt(SCOPE_OBJECTIVE_DZ);
    // Eyepiece and objective bell, both sized outward from their own section's
    // bore so neither can narrow the sight picture.
    b.shell("scopeOcular", POLYMER, rOcular * 2, 0.012, 0.016, scopeY, ocularZ - 0.004);
    b.shell("scopeDiopter", METAL, rOcular * 2, 0.009, 0.01, scopeY, ocularZ + 0.026, 10);
    b.shell("scopeBell", POLYMER, rObjective * 2, 0.009, 0.026, scopeY, objectiveZ + 0.012);
    // Two clamp rings, each around the section it lands on, on bases tall
    // enough to bridge the gap the cone needs (see SCOPE_RISE) — clearing the
    // weapon's own rail is why a scope stands off as far as this one does.
    // A base runs from a hair under the rail to the underside of its own clamp
    // ring, so the two meet with no seam and no overlap however high this
    // weapon carries its rail.
    const baseBottom = mount.railTop - 0.003;
    for (const dz of [-0.02, 0.085] as const) {
      const rRing = outerAt(dz);
      const baseTop = scopeY - rRing - 0.007;
      b.box(
        "scopeRingBase",
        METAL,
        0.042,
        baseTop - baseBottom,
        0.024,
        0,
        (baseBottom + baseTop) / 2,
        winZ + dz,
      );
      b.shell("scopeRing", METAL, rRing * 2, 0.007, 0.02, scopeY, winZ + dz, 10);
    }
    const turretZ = winZ + 0.005;
    const rTurret = outerAt(0.005);
    b.pin("scopeElev", METAL, 0.026, 0.015, 0, scopeY + rTurret + 0.007, turretZ, "y");
    b.pin("scopeElevCap", METAL, 0.018, 0.006, 0, scopeY + rTurret + 0.018, turretZ, "y");
    b.pin("scopeWind", METAL, 0.026, 0.015, rTurret + 0.007, scopeY, turretZ, "x");
    b.pin("scopeParallax", METAL, 0.021, 0.012, -(rTurret + 0.006), scopeY, turretZ, "x");
    b.merge("scope", node);

    // Duplex reticle: four arms in from the tube wall, and a centre dot. Built
    // as one merged emissive mesh — five separate draws for a crosshair is
    // five too many on the one model that is always on screen.
    // The arms run to just inside the CONE at the reticle's own depth, not to
    // the tube wall beside it: the visible circle is the cone's, and a wall
    // this far up the flare is well outside it.
    const retZ = objectiveZ - 0.06;
    const armIn = 0.011;
    const armOut = SCOPE_CONE * (eyeDistance("scope") + retZ - ocularZ) - 0.004;
    const armLen = armOut - armIn;
    const armMid = (armIn + armOut) / 2;
    const bars: Mesh[] = [];
    for (const side of [-1, 1] as const) {
      const v = MeshBuilder.CreateBox(
        `${prefix}_scopeRetV`,
        { width: 0.0017, height: armLen, depth: 0.0012 },
        b.scene,
      );
      v.position.set(0, scopeY + side * armMid, retZ);
      bars.push(v);
      const h = MeshBuilder.CreateBox(
        `${prefix}_scopeRetH`,
        { width: armLen, height: 0.0017, depth: 0.0012 },
        b.scene,
      );
      h.position.set(side * armMid, scopeY, retZ);
      bars.push(h);
    }
    const centre = MeshBuilder.CreateSphere(
      `${prefix}_scopeRetDot`,
      { diameter: 0.003, segments: 6 },
      b.scene,
    );
    centre.position.set(0, scopeY, retZ);
    bars.push(centre);
    const reticle = Mesh.MergeMeshes(bars, true, true);
    if (reticle) {
      reticle.name = `${prefix}_scopeReticle`;
      b.lit(reticle, node);
    }

    // The eye reference is the ocular rim — a scope's eye relief is measured
    // to the glass you put your eye behind, not to the middle of the tube.
    return new Vector3(0, scopeY, ocularZ);
  };

  const BUILDERS: Record<SightId, (node: TransformNode) => Vector3> = {
    iron: buildIron,
    holo: buildHolo,
    scope: buildScope,
  };

  const sights = {} as Record<SightId, SightAssembly>;
  const meshes: Mesh[] = [];
  for (const id of SIGHT_IDS) {
    const node = new TransformNode(`${prefix}_sight_${id}`, b.scene);
    node.parent = b.root;
    const centre = BUILDERS[id](node);
    const sightCenter = new TransformNode(`${prefix}_${id}_sightCenter`, b.scene);
    sightCenter.parent = node;
    sightCenter.position = centre;
    // The builder has already parented its merged colour groups and its
    // reticle to `node`, so the node itself is the list — no bookkeeping to
    // keep in step with it.
    const own = node.getChildMeshes(true) as Mesh[];
    meshes.push(...own);
    sights[id] = { root: node, sightCenter, meshes: own };
  }
  return { sights, meshes };
}
