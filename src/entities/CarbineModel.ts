/**
 * CarbineModel.ts — Builds the low-poly bullpup burst carbine from primitives,
 * and hangs the same five optics off its rail.
 * Returns WeaponParts, exactly as the other three builders do: all of them are
 * interchangeable to everything above them, which is what lets `ViewModel`
 * carry any one.
 * Invariants: assembled at the origin with the root at identity and merged
 * before it is moved — `weaponKit.ts` owns that contract and the primitives.
 * The optics are `optics.ts`'s, built against `MOUNT` rather than re-tuned.
 */
import { Scene, TransformNode, Vector3 } from "@babylonjs/core";
import type { CelMaterialFactory } from "../shaders/CelShader";
import { buildOptics, type OpticMount } from "./optics";
import { BODY, METAL, POLYMER, RUBBER, WeaponBuild, type WeaponParts } from "./weaponKit";

/**
 * Top face of the rail. Between the DMR's and the rifle's, and high for a
 * weapon this short — a bullpup's action is under the shooter's cheek, so the
 * receiver is at its deepest exactly where the eye is, and the rail has to
 * clear it rather than the barrel.
 */
const RAIL_TOP = 0.086;

/**
 * Where the carbine offers its rail, and the one place the layout pays off in
 * numbers rather than in silhouette.
 *
 * The REAR station is what a bullpup buys: the receiver runs all the way to
 * the butt pad, so the aperture can sit at -0.28 where the rifle's stops at
 * -0.185 and there is still stock behind it. The front station is the one that
 * is bounded, and not by the optics for once — `optics.ts` would carry a
 * folded leaf out to about z = 0.51 here (the cone is kinder on this weapon
 * than on any other, since nothing forward of the mount stands as high as the
 * rail) — but by the rail itself, which stops at the gas block because past it
 * the barrel is exposed. That is the whole point of the layout: 0.60 of sight
 * radius out of a weapon 0.96 long, against the rifle's 0.715 out of 1.25.
 */
const MOUNT: OpticMount = {
  railTop: RAIL_TOP,
  mountZ: -0.02,
  ironRearZ: -0.28,
  ironFrontZ: 0.32,
};

/**
 * Where each hand grips, in weapon-local units. The trigger hand sits well
 * forward of the magazine — that is what a bullpup IS — and the support hand
 * is behind the hand stop rather than in front of it.
 */
const GRIP_HAND = new Vector3(0.02, -0.12, -0.1);
const GRIP_ELBOW = new Vector3(0.26, -0.515, -0.47);
const SUPPORT_HAND = new Vector3(-0.02, -0.075, 0.2);
const SUPPORT_ELBOW = new Vector3(-0.3, -0.5, -0.08);

/**
 * Where the support hand goes for the magazine swap. Further BACK than any
 * other weapon here by a wide margin, and that is the layout again: the shared
 * `CONFIG.viewmodel.magHandOffset` takes the hand back and down to a magwell
 * under a receiver, and this weapon keeps its magazine behind the firing hand,
 * a full 0.45 back from where the support hand rests on the handguard. Applied
 * unchanged, the shared offset puts the hand on the trigger guard.
 */
const MAG_HAND = new Vector3(-0.02, -0.075, -0.45);

/**
 * Builds a low-poly cel-styled bullpup burst carbine. Local +z is the barrel
 * axis, origin at the receiver centre — the same frame the other three weapons
 * are built in, so the viewmodel poses any of them with the same numbers.
 *
 * **The layout is the argument, and it is the one thing the other three cannot
 * say.** They are all the same weapon at three sizes: a receiver, a magazine
 * under it, a grip behind that, a stock behind that. This one folds the action
 * into the stock and puts the magazine BEHIND the firing hand, which changes
 * every line on it at once — the grip stands alone at the front with nothing
 * under the barrel, the magazine is a block against the shoulder, the trigger
 * reaches its own mechanism through a linkage bar down the side, the brass
 * leaves at the cheek, and the top is one flat plane from butt pad to gas
 * block with no cheek riser, no folding hinge and no separate stock on it.
 * A player who cannot read a stat chart can tell it from the rifle in the dark.
 *
 * Four smaller things carry the same job where the layout runs out: a squared
 * ported brake instead of the round cages the other three wear, a hooked hand
 * stop instead of a vertical foregrip, a polymer shell with the receiver dark
 * only where it shows (the rifle's colour distribution inverted), and the
 * three-position selector standing where the thumb falls, which is the fire
 * mode itself made visible.
 *
 * ~110 parts, merged to one mesh per colour. The merge is what makes the
 * detail free and what keeps the outline pass drawing one border per colour
 * group instead of a black shell around every rib.
 */
export function buildCarbine(
  scene: Scene,
  mats: CelMaterialFactory,
  prefix: string,
): WeaponParts {
  const root = new TransformNode(`${prefix}_carbine`, scene);
  const b = new WeaponBuild(scene, mats, prefix, root);

  // --- the top plane: one rail from over the butt pad to the gas block ---
  // A bullpup's defining line seen from the side, and the reason there is no
  // cheek riser anywhere on this weapon: the rail IS the comb, and the face
  // rests against the pads on the shell below it.
  b.box("rail", BODY, 0.056, 0.014, 0.67, 0, 0.079, 0.005);
  for (let i = 0; i < 8; i++) {
    b.box("railRib", METAL, 0.06, 0.012, 0.014, 0, 0.084, -0.28 + i * 0.075);
  }

  // --- the shell: one polymer clamshell from the butt to the handguard, with
  // the action inside it ---
  // Deep, because everything the rifle keeps in a receiver AND everything it
  // keeps in a stock is in here. The narrow top deck is the chamfer additive
  // geometry cannot cut, the same two-slab trick the rifle's upper uses.
  b.box("shell", POLYMER, 0.08, 0.115, 0.5, 0, 0.015, -0.14);
  b.box("shellDeck", BODY, 0.068, 0.014, 0.5, 0, 0.065, -0.14);
  b.box("shellStep", POLYMER, 0.07, 0.02, 0.46, 0, -0.05, -0.15);
  // The clamshell seam, standing proud down both sides — a moulded weapon's
  // one honest line, and what stops the shell reading as a solid billet.
  for (const side of [-1, 1] as const) {
    b.box("seam", BODY, 0.006, 0.055, 0.42, side * 0.042, 0.01, -0.15);
    // Cheek pads: ambidextrous, because a bullpup's face is on the side of the
    // stock rather than on top of it. Kept well under the rail — anything
    // higher back here stands in the iron sight picture, which is the trap
    // `ironSightFloor` documents from the DMR's side.
    b.box("cheekPad", RUBBER, 0.006, 0.026, 0.14, side * 0.044, 0.03, -0.23);
  }

  // --- butt: the back of the shell, and nothing else ---
  b.box("buttPlate", BODY, 0.08, 0.115, 0.02, 0, 0.015, -0.4);
  b.box("buttPad", RUBBER, 0.082, 0.108, 0.018, 0, 0.012, -0.417);
  for (let i = 0; i < 2; i++) {
    b.box("buttGroove", BODY, 0.084, 0.008, 0.02, 0, 0.04 - i * 0.03, -0.42);
  }
  b.box("slingRear", METAL, 0.024, 0.03, 0.014, -0.038, -0.02, -0.372);

  // --- ejection port: right side, at the cheek ---
  // Where a bullpup's brass has to leave, and half of why the other half of
  // the receiver is a blanking plate: the port is swapped for the plate to
  // shoot it left-handed. The deflector stands BEHIND the port rather than in
  // front of it, which is the one place on this weapon a part is doing the
  // opposite of its equivalent on the rifle — there is a face back there.
  b.box("ejectPort", METAL, 0.008, 0.03, 0.1, 0.042, 0.03, -0.16);
  b.box("portCover", METAL, 0.007, 0.022, 0.096, 0.044, 0.008, -0.162);
  b.box("deflector", BODY, 0.018, 0.028, 0.045, 0.043, 0.042, -0.225);
  b.box("portBlank", BODY, 0.006, 0.028, 0.096, -0.042, 0.03, -0.16);

  // Non-reciprocating charging handle, left and forward — it rides the front
  // of the receiver where a bullpup's bolt carrier can be reached without
  // taking the face off the stock.
  b.box("chSlot", BODY, 0.006, 0.014, 0.16, -0.042, 0.045, 0.02);
  b.box("chArm", METAL, 0.04, 0.013, 0.026, -0.06, 0.045, 0.08);
  b.box("chKnob", METAL, 0.018, 0.02, 0.038, -0.076, 0.045, 0.085);

  // --- trigger group, standing alone at the front of the shell ---
  b.box("guardFront", POLYMER, 0.046, 0.05, 0.016, 0, -0.085, -0.045);
  b.box("guardBottom", POLYMER, 0.046, 0.014, 0.1, 0, -0.105, -0.095);
  const trigPivot = b.pivot("trigPivot", 0, -0.062, -0.075, 0.35);
  b.box("trigger", METAL, 0.013, 0.03, 0.013, 0, -0.015, 0, trigPivot);
  b.box("triggerToe", METAL, 0.013, 0.022, 0.015, 0, -0.038, 0.007, trigPivot);
  // The linkage bar: the trigger is a hand's length in front of the mechanism
  // it works, and this is the rod that crosses the gap. Nothing else in the
  // kit needs one, it runs down the side the camera actually sees (the weapon
  // is held to the right of the lens, so its LEFT flank is the one on screen),
  // and it is half-buried in its own channel so it reads as a mechanism rather
  // than as a stick glued to the gun.
  b.box("linkBar", METAL, 0.005, 0.012, 0.19, -0.041, -0.028, -0.16);
  b.pin("linkPinF", METAL, 0.008, 0.086, 0, -0.028, -0.07);
  b.pin("linkPinR", METAL, 0.008, 0.086, 0, -0.028, -0.25);

  // Three-position selector, above the grip where the firing thumb lands: the
  // fire mode as a part rather than as a line on the loadout screen.
  b.pin("selectorPin", METAL, 0.014, 0.086, 0, -0.03, -0.145);
  b.box("selectorLever", METAL, 0.01, 0.034, 0.012, -0.048, -0.02, -0.145, root, 0.5);
  for (let i = 0; i < 3; i++) {
    b.box("selectorMark", BODY, 0.004, 0.01, 0.006, -0.041, -0.008 - i * 0.014, -0.163);
  }

  const gripPivot = b.pivot("gripPivot", 0, -0.055, -0.12, -0.32);
  b.box("grip", POLYMER, 0.052, 0.135, 0.072, 0, -0.065, 0, gripPivot);
  b.box("gripSwell", POLYMER, 0.057, 0.046, 0.066, 0, -0.048, -0.005, gripPivot);
  for (let i = 0; i < 3; i++) {
    b.box("gripRib", BODY, 0.046, 0.01, 0.013, 0, -0.042 - i * 0.03, 0.034, gripPivot);
  }
  b.box("gripCap", RUBBER, 0.054, 0.016, 0.076, 0, -0.14, 0, gripPivot);

  // --- magazine: standing in the shell BEHIND the grip ---
  // The single most legible line on the weapon. Straight and vertical, with no
  // rake at all: a magazine that leans is a magazine feeding a receiver ahead
  // of it, and this one feeds straight up into the stock.
  b.box("magwell", POLYMER, 0.068, 0.06, 0.1, 0, -0.06, -0.235);
  b.box("magFlareF", POLYMER, 0.072, 0.016, 0.012, 0, -0.086, -0.19);
  b.box("magFlareR", POLYMER, 0.072, 0.016, 0.012, 0, -0.086, -0.28);
  b.box("mag", POLYMER, 0.05, 0.13, 0.076, 0, -0.145, -0.235);
  for (let i = 0; i < 3; i++) {
    b.box("magRib", BODY, 0.053, 0.007, 0.078, 0, -0.11 - i * 0.04, -0.235);
    // Witness slots down the flank, so the block is a magazine rather than a
    // handle. They read as cuts because they are darker, not because they are.
    b.box("magSlot", BODY, 0.052, 0.014, 0.01, 0, -0.115 - i * 0.04, -0.198);
  }
  b.box("magFloor", METAL, 0.054, 0.014, 0.08, 0, -0.217, -0.235);
  b.box("magBase", RUBBER, 0.05, 0.012, 0.074, 0, -0.229, -0.235);
  // The release is at the BACK of the well, worked by the firing thumb — the
  // hand nearest it is the one on the grip, not the one on the handguard.
  b.box("magRelease", METAL, 0.03, 0.028, 0.012, 0, -0.05, -0.293);
  b.box("magLatch", METAL, 0.012, 0.02, 0.02, 0.032, -0.058, -0.288);

  // --- handguard: a slim sleeve, with the rail carried over it on a spine ---
  b.box("handguard", POLYMER, 0.066, 0.058, 0.24, 0, -0.012, 0.22);
  b.box("hgTop", POLYMER, 0.056, 0.014, 0.24, 0, 0.024, 0.22);
  // What holds the rail up over the barrel. It is the one part forward of the
  // mount with any height to it, and it stops exactly at the rail's underside
  // — everything an optic looks over has to stay under `RAIL_TOP` or it is in
  // the bottom of the sight picture.
  b.box("railSpine", BODY, 0.04, 0.045, 0.26, 0, 0.05, 0.21);
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < 3; i++) {
      b.box("vent", BODY, 0.005, 0.024, 0.036, side * 0.034, -0.012, 0.14 + i * 0.07);
    }
  }
  for (let i = 0; i < 3; i++) {
    b.box("mlok", BODY, 0.028, 0.006, 0.046, 0, -0.045, 0.14 + i * 0.07);
  }
  b.box("bottomRail", METAL, 0.042, 0.014, 0.14, 0, -0.048, 0.21);
  b.box("hgCap", BODY, 0.064, 0.06, 0.012, 0, -0.012, 0.346);
  b.box("slingFront", METAL, 0.022, 0.026, 0.012, -0.036, -0.03, 0.12);
  // A hooked hand stop rather than a vertical foregrip: the hand butts up
  // BEHIND it, which is why it sits forward of `SUPPORT_HAND` instead of under
  // it, and it is the fourth weapon in a row that would otherwise have grown
  // the same stubby post under the barrel.
  const stopPivot = b.pivot("stopPivot", 0, -0.045, 0.26, -0.55);
  b.box("handStop", POLYMER, 0.04, 0.055, 0.03, 0, -0.028, 0, stopPivot);
  b.box("handStopCap", RUBBER, 0.042, 0.012, 0.032, 0, -0.06, 0, stopPivot);

  // --- barrel: short and exposed, ending in a squared brake ---
  b.box("gasBlock", BODY, 0.046, 0.05, 0.06, 0, 0, 0.375);
  b.box("gasPort", METAL, 0.02, 0.012, 0.024, 0, 0.03, 0.375);
  b.tube("barrel", BODY, 0.028, 0.032, 0.11, 0, 0, 0.45);
  b.tube("barrelNut", METAL, 0.038, 0.038, 0.012, 0, 0, 0.41);
  // The brake is SQUARE, and that is the point: the rifle and the SMG both end
  // in a round slotted cage and the DMR in a chambered one, so the fourth
  // muzzle in the kit has to be a different shape rather than a fourth size.
  // Its ports are dark boxes standing proud of both flanks — the same trick as
  // the rifle's birdcage core, where what reads as a cut is really something
  // darker behind the gap.
  b.box("brakeBody", BODY, 0.036, 0.036, 0.075, 0, 0, 0.545);
  for (let i = 0; i < 3; i++) {
    b.box("brakePort", RUBBER, 0.04, 0.014, 0.012, 0, 0.006, 0.522 + i * 0.024);
    b.box("brakeRib", METAL, 0.038, 0.008, 0.008, 0, 0.02, 0.522 + i * 0.024);
  }
  b.tube("mzCore", RUBBER, 0.024, 0.024, 0.03, 0, 0, 0.575);
  b.shell("crown", METAL, 0.026, 0.008, 0.012, 0, 0.585, 10);

  // The carbine itself is finished. Merge it before any optic is built, so a
  // sight's parts can never end up inside the weapon's colour groups.
  const meshes = b.merge("carbine", root);
  const optics = buildOptics(b, MOUNT, prefix);
  meshes.push(...optics.meshes);
  b.disposePivots();

  return {
    root,
    muzzle: new Vector3(0, 0, 0.6),
    // Matches the `ejectPort` box above: the right side of the shell, level
    // with the cheek. Brass past the ear is what a bullpup costs.
    ejectPort: new Vector3(0.046, 0.03, -0.16),
    grip: { hand: GRIP_HAND, elbow: GRIP_ELBOW },
    support: { hand: SUPPORT_HAND, elbow: SUPPORT_ELBOW },
    magHand: MAG_HAND,
    sights: { kind: "fitted", assemblies: optics.sights },
    meshes,
  };
}
