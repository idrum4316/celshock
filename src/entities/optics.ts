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
 * Invariants: each optic is merged into its OWN meshes rather than into the
 * weapon's, which is what lets one be swapped for another without rebuilding
 * the gun under it. Emissive parts go through `build.lit`, never `collect`.
 */
import { MeshBuilder, Mesh, Color3, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
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
 * Rises above the rail. The irons sit as low as the rear ring's outer radius
 * allows — putting the aperture on the rail is the whole appeal of irons —
 * and the two tube optics stand off far enough for their housings to clear it.
 */
const IRON_RISE = 0.061;
const WIN_RISE = 0.101;
const SCOPE_RISE = 0.121;

/**
 * The holo's clear bore and wall. The shooter looks PAST the wall, so every
 * millimetre of it costs sight picture — keep it near the outline width and
 * let the bore carry the size. Outer radius is `(BORE + WALL * 2) / 2`, which
 * is what the turrets and the mount stand off from.
 */
const BORE = 0.1;
const WALL = 0.009;

/**
 * The two iron stations share a bore, which is what gives the picture its
 * depth: the rear ring is a third of the eye's distance to the front one, so
 * it reads as twice the size and the front hood floats inside it.
 */
const IRON_BORE = 0.07;

/**
 * The 3.5x scope. A telescope here is a real tube the eye looks down — there
 * is no lens and no post-process, so how much of the frame is clear glass is
 * decided by the OBJECTIVE rim's angular size, and the bore has to be wide
 * enough to be worth looking through.
 */
const SCOPE_BORE = 0.15;
const SCOPE_WALL = 0.008;
/**
 * Ocular and objective, relative to `mountZ`. The tube's height and length are
 * set by ONE constraint, and it is not appearance: a straight tube's view cone
 * spreads with distance, and where it spreads far enough it runs onto the
 * weapon's own barrel — a bright muzzle device sitting inside the bottom of
 * the sight picture. `SCOPE_RISE` is high enough, and the tube long enough, to
 * keep the cone's lower edge clear of the gas block, the folded front sight
 * and the flash hider all the way out. Lower the rings or shorten the body and
 * the weapon appears in its own scope.
 */
const SCOPE_OCULAR_DZ = -0.15;
const SCOPE_OBJECTIVE_DZ = 0.14;

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
    b.box("rsBase", METAL, 0.04, 0.02, 0.036, 0, r + 0.002, mount.ironRearZ + 0.045);
    b.box("rsLeaf", METAL, 0.032, 0.012, 0.07, 0, r + 0.01, mount.ironRearZ);
    // The front pair is the last thing the scope's view cone runs onto — see
    // SCOPE_OCULAR_DZ. A weapon wearing a scope this size is set up around it
    // rather than over a set of irons, so it simply does not carry them.
    if (!front) return;
    b.box("fsBase", METAL, 0.038, 0.02, 0.03, 0, r + 0.002, mount.ironFrontZ - 0.048);
    b.box("fsLeaf", METAL, 0.03, 0.009, 0.07, 0, r + 0.0085, mount.ironFrontZ);
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
    b.box("ironRearBase", METAL, 0.032, baseH, 0.03, 0, baseY, mount.ironRearZ);
    b.shell("ironRearRing", METAL, IRON_BORE, 0.006, 0.012, ironY, mount.ironRearZ, 10);
    // Front: the same ring as a hood, with the post rising from its floor to
    // the axis. The bead is the aim point — a tritium dot, and the only thing
    // on this sight that is visible against a dark treeline.
    b.box("ironFrontBase", METAL, 0.034, baseH, 0.032, 0, baseY, mount.ironFrontZ);
    b.shell("ironFrontHood", METAL, IRON_BORE, 0.005, 0.014, ironY, mount.ironFrontZ, 10);
    const postH = IRON_BORE / 2;
    b.box("ironPost", METAL, 0.006, postH, 0.008, 0, ironY - postH / 2, mount.ironFrontZ);
    b.merge("iron", node);
    const bead = b.lit(
      MeshBuilder.CreateSphere(
        `${prefix}_ironBead`,
        { diameter: 0.0065, segments: 6 },
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
    const footY = mount.railTop + 0.005;
    b.box("opticMount", POLYMER, 0.062, 0.045, 0.13, 0, footY + 0.0165, winZ);
    b.box("opticFoot", METAL, 0.07, 0.012, 0.134, 0, footY, winZ);
    b.box("opticLever", METAL, 0.018, 0.03, 0.05, 0.038, footY + 0.011, winZ + 0.026);
    b.pin("opticNut", METAL, 0.012, 0.076, 0, footY + 0.011, winZ - 0.042);
    // The housing: a shell of `FACETS` slabs about the sight axis, with a
    // heavier rim at each end. The bore is the sight picture — the rims are
    // sized OUTWARD from it so a wider rim never eats into what you can see.
    b.shell("sightTube", POLYMER, BORE, WALL, 0.052, winY, winZ);
    b.shell("sightRimF", POLYMER, BORE + 0.004, 0.013, 0.014, winY, winZ + 0.031);
    b.shell("sightRimR", POLYMER, BORE + 0.004, 0.013, 0.014, winY, winZ - 0.031);
    // Turrets and battery cap, standing off the housing's outer radius.
    const rOut = BORE / 2 + WALL;
    b.pin("elevTurret", METAL, 0.03, 0.018, 0, winY + rOut + 0.009, winZ, "y");
    b.pin("elevCap", METAL, 0.022, 0.008, 0, winY + rOut + 0.022, winZ, "y");
    b.pin("windTurret", METAL, 0.03, 0.018, rOut + 0.009, winY, winZ, "x");
    b.pin("battery", METAL, 0.026, 0.016, -(rOut + 0.008), winY - 0.008, winZ, "x");
    b.merge("holo", node);

    // Reticle: emissive ring + center dot.
    const ring = b.lit(
      MeshBuilder.CreateTorus(
        `${prefix}_reticleRing`,
        { diameter: 0.022, thickness: 0.0028, tessellation: 24 },
        b.scene,
      ),
      node,
    );
    ring.rotation.x = Math.PI / 2; // face down the barrel axis
    ring.position.set(0, winY, winZ - 0.004);

    const dot = b.lit(
      MeshBuilder.CreateSphere(
        `${prefix}_reticleDot`,
        { diameter: 0.0045, segments: 6 },
        b.scene,
      ),
      node,
    );
    dot.position.set(0, winY, winZ - 0.004);

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
    glass.position.set(0, winY, winZ + 0.012);
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
    const rOut = SCOPE_BORE / 2 + SCOPE_WALL;
    const bodyLen = objectiveZ - ocularZ;
    const midZ = (ocularZ + objectiveZ) / 2;
    b.shell("scopeTube", POLYMER, SCOPE_BORE, SCOPE_WALL, bodyLen, scopeY, midZ);
    // Eyepiece and objective bell, both sized outward from the bore so
    // neither can narrow the sight picture.
    b.shell("scopeOcular", POLYMER, SCOPE_BORE + 0.006, 0.014, 0.018, scopeY, ocularZ - 0.005);
    b.shell("scopeDiopter", METAL, SCOPE_BORE + 0.004, 0.011, 0.012, scopeY, ocularZ + 0.03, 10);
    b.shell("scopeBell", POLYMER, SCOPE_BORE + 0.012, 0.01, 0.03, scopeY, objectiveZ + 0.015);
    // Two clamp rings, on bases tall enough to bridge the gap the objective
    // needs (see SCOPE_RISE) — a big front lens is exactly why a scope stands
    // off its rail as far as this one does.
    // The base runs from a hair under the rail to the underside of its own
    // clamp ring, so the two meet with no seam and no overlap however high
    // this weapon carries its rail.
    const baseBottom = mount.railTop - 0.003;
    const baseTop = scopeY - rOut - 0.008;
    const ringBaseH = baseTop - baseBottom;
    for (const dz of [-0.04, 0.12] as const) {
      b.box(
        "scopeRingBase",
        METAL,
        0.05,
        ringBaseH,
        0.028,
        0,
        (baseBottom + baseTop) / 2,
        winZ + dz,
      );
      b.shell(
        "scopeRing",
        METAL,
        SCOPE_BORE + SCOPE_WALL * 2,
        0.008,
        0.024,
        scopeY,
        winZ + dz,
        10,
      );
    }
    const turretZ = winZ + 0.01;
    b.pin("scopeElev", METAL, 0.034, 0.02, 0, scopeY + rOut + 0.01, turretZ, "y");
    b.pin("scopeElevCap", METAL, 0.024, 0.008, 0, scopeY + rOut + 0.024, turretZ, "y");
    b.pin("scopeWind", METAL, 0.034, 0.02, rOut + 0.01, scopeY, turretZ, "x");
    b.pin("scopeParallax", METAL, 0.028, 0.016, -(rOut + 0.008), scopeY, turretZ, "x");
    b.merge("scope", node);

    // Duplex reticle: four arms in from the tube wall, and a centre dot. Built
    // as one merged emissive mesh — five separate draws for a crosshair is
    // five too many on the one model that is always on screen.
    const retZ = objectiveZ - 0.07;
    const armIn = 0.016;
    const armOut = SCOPE_BORE / 2 - 0.007;
    const armLen = armOut - armIn;
    const armMid = (armIn + armOut) / 2;
    const bars: Mesh[] = [];
    for (const side of [-1, 1] as const) {
      const v = MeshBuilder.CreateBox(
        `${prefix}_scopeRetV`,
        { width: 0.0022, height: armLen, depth: 0.0015 },
        b.scene,
      );
      v.position.set(0, scopeY + side * armMid, retZ);
      bars.push(v);
      const h = MeshBuilder.CreateBox(
        `${prefix}_scopeRetH`,
        { width: armLen, height: 0.0022, depth: 0.0015 },
        b.scene,
      );
      h.position.set(side * armMid, scopeY, retZ);
      bars.push(h);
    }
    const centre = MeshBuilder.CreateSphere(
      `${prefix}_scopeRetDot`,
      { diameter: 0.004, segments: 6 },
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
