/**
 * Props.ts — Scatter prop factories (trees, gravestones, lanterns, fungus,
 * logs, fire drums, rubble, boulders, brambles, barrels, jungle trees). Pure
 * mesh builders:
 * each assembles at the origin
 * and returns a hierarchy; placement/merging/colliders are the caller's job.
 * Invariants: emissive parts (lantern glow, fire, fungus) MUST set
 * metadata.noOutline (and noGlow where they shouldn't feed the GlowLayer).
 * Never set metadata.solid here — colliders come from MapBuilder only.
 * Never call rng() here — the per-prop jitter that makes a stand of
 * trees look like a stand of trees comes from the caller's seeded `rng`, so the
 * same layout builds the same world on every boot (see world/rng.ts).
 */
import { Mesh, MeshBuilder, Scene } from "@babylonjs/core";
import { CONFIG } from "../config";
import type { CelMaterialFactory } from "../shaders/CelShader";

/**
 * Scatter props for Hollowmere — the loose dressing that fills space between
 * the authored buildings. Harvested from the retired room themes; each builder
 * takes `(scene, mats)` — plus an `rng` where the prop is randomised —
 * assembles a parented primitive hierarchy at the origin, and returns the root.
 * Emissive children are tagged `noOutline` so the outline shell doesn't swallow
 * their glow.
 *
 * Placement (position, rotation, scale) is the caller's business — unlike the
 * old `PropSpec`, these carry no counts and no transform of their own.
 *
 * `rng` defaults to `Math.random` so a one-off caller (a model viewer, a test)
 * stays a two-argument call; MapBuilder always passes the map's seeded stream.
 */

const BARK = "#4a4238";
const DEAD_BARK = "#3c3730";
const NEEDLE = "#26402f";
const NEEDLE_LIT = "#35563d";
// Jungle hardwood: paler and greyer than the valley's dead bark — a wet trunk
// under a bright sky, not a charred one under a moon.
const JUNGLE_BARK = "#5b5443";
const LEAF = "#2c5230";
const LEAF_LIT = "#437a3e";
// Creeper and moss. The same value as the kit's CREEPER, deliberately restated
// rather than imported: Props.ts owns its own palette and takes nothing from
// the structure kit, so a prop stays placeable without a builder.
const VINE = "#41552f";
const STONE = "#7a7f7c";
const DARK_STONE = "#5f6461";
const IRON = "#2f3338";
const RUST = "#5d4a3c";
const DARK_METAL = "#262a33";
const CONCRETE = "#4a4d54";

/**
 * Dead tree: a leaning bare trunk with a crown of clawing branches. No
 * canopy — the silhouette is all splinters, and moonlight through them is
 * most of what the player sees at distance.
 */
export function buildDeadTree(
  scene: Scene,
  mats: CelMaterialFactory,
  rng: () => number = Math.random,
): Mesh {
  const barkMat = mats.get(BARK);
  const trunk = MeshBuilder.CreateCylinder(
    "tree-trunk",
    { height: 5.2, diameterTop: 0.32, diameterBottom: 0.85, tessellation: 6 },
    scene,
  );
  trunk.position.y = 2.6;
  trunk.material = barkMat;
  trunk.rotation.z = (rng() - 0.5) * 0.18;

  const branches = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rng() * 0.6;
    const h = 1.4 + rng() * 1.4;
    const branch = MeshBuilder.CreateCylinder(
      `branch${i}`,
      { height: h, diameterTop: 0.04, diameterBottom: 0.2, tessellation: 5 },
      scene,
    );
    branch.parent = trunk;
    branch.position.set(
      Math.cos(a) * 0.25,
      0.9 + rng() * 1.4,
      Math.sin(a) * 0.25,
    );
    branch.rotation.z = -Math.cos(a) * (0.7 + rng() * 0.5);
    branch.rotation.x = Math.sin(a) * (0.7 + rng() * 0.5);
    branch.material = mats.get(DEAD_BARK);
  }
  return trunk;
}

/**
 * Living pine: a straight trunk under four stacked cones of needles — the
 * counterpart to `buildDeadTree`, and the only green thing standing in the
 * valley.
 *
 * Two things about the shape are deliberate. The lean is a fifth of the dead
 * tree's, because a dead trunk reads as *failing* and a live one has to read as
 * the thing that hasn't; the whole silhouette is the crown, so a tilt that
 * looks like character on bare branches just looks like a felled pine here.
 * And the lowest tier's skirt starts at 1.8 m, clear of the 1.7 m hit sphere:
 * the collider is the trunk only (see `PROP_BODIES`), so needles hanging at
 * chest height would be foliage you can shoot straight through — the exact
 * complaint the prop bodies were measured to fix.
 */
export function buildPine(
  scene: Scene,
  mats: CelMaterialFactory,
  rng: () => number = Math.random,
): Mesh {
  const trunk = MeshBuilder.CreateCylinder(
    "pine-trunk",
    { height: 6.4, diameterTop: 0.3, diameterBottom: 0.62, tessellation: 6 },
    scene,
  );
  trunk.position.y = 3.2;
  trunk.material = mats.get(BARK);
  trunk.rotation.z = (rng() - 0.5) * 0.04;

  // Centre height, cone height, bottom and top diameters. The top tier closes
  // to a point; the rest are truncated so each tier's skirt overhangs the one
  // above it and the crown steps rather than tapering smoothly.
  const tiers: [number, number, number, number][] = [
    [2.9, 2.2, 3.3, 1.9],
    [4.1, 2.0, 2.6, 1.4],
    [5.2, 1.7, 1.9, 0.9],
    [6.1, 1.4, 1.1, 0],
  ];
  tiers.forEach(([y, h, bottom, top], i) => {
    const tier = MeshBuilder.CreateCylinder(
      `pine-tier${i}`,
      {
        height: h * (0.9 + rng() * 0.2),
        diameterTop: top,
        diameterBottom: bottom,
        tessellation: 7,
      },
      scene,
    );
    tier.parent = trunk;
    // Local to the trunk's centre, so the tiers ride its lean.
    tier.position.set((rng() - 0.5) * 0.12, y - 3.2, (rng() - 0.5) * 0.12);
    tier.rotation.y = rng() * Math.PI * 2;
    // Moonlight only reaches the top of the crown — and passes THROUGH it,
    // which is why the needles are translucent rather than merely a lighter
    // green: a pine with the moon behind it should have a lit edge, and a
    // stand of them between you and the moon should read as a screen you are
    // seeing light past rather than as a row of black cones. The material is
    // one per colour either way, so this costs no extra draw call.
    tier.material = mats.getTranslucent(
      i < 2 ? NEEDLE : NEEDLE_LIT,
      CONFIG.graphics.translucency.foliage,
    );
  });
  return trunk;
}

/**
 * Jungle hardwood: a buttressed trunk running bare for two storeys and then
 * spreading into a canopy of broad fronds. The tall counterpart to the pine —
 * where a pine is a cone you see the whole of, this is a column with the
 * foliage held above the fight, so a stand of them closes the sky without
 * closing the sight lines under it.
 *
 * Three things about the shape are load-bearing rather than decorative:
 *
 * - **The lowest frond hangs at ~9 m**, five times clear of the 1.7 m hit
 *   sphere. The collider is the trunk and its buttress core only (see
 *   `PROP_BODIES`), so anything at chest height would be foliage rounds pass
 *   straight through — the pine's rule, and a canopy tree has far more leaf to
 *   get it wrong with.
 * - **The buttresses stay inside 1.0 m of the axis**, which is the collider's
 *   own half-width, so the flare a player walks up to is the flare that stops
 *   them. They are what makes the trunk read as tropical at all; a bare
 *   cylinder of this height is a telegraph pole.
 * - **The fronds are two segments, not one**, and the outer one droops harder.
 *   A single straight blade reads as a plank at any distance the fog leaves
 *   visible; the break is where the whole silhouette comes from.
 *
 * Nothing here is scaled non-uniformly — `renderOutline` extrudes along vertex
 * normals and `VertexData.transform` does not re-normalise them, so a squashed
 * part grows a lopsided ink shell.
 */
export function buildJungleTree(
  scene: Scene,
  mats: CelMaterialFactory,
  rng: () => number = Math.random,
): Mesh {
  const bark = mats.get(JUNGLE_BARK);
  const trunk = MeshBuilder.CreateCylinder(
    "jungle-trunk",
    { height: 11.2, diameterTop: 0.42, diameterBottom: 1.0, tessellation: 6 },
    scene,
  );
  trunk.position.y = 5.6;
  trunk.material = bark;
  // A hardwood carries its own weight — a fifth of the pine's already-slight
  // lean, and only enough that a stand of them is not a row of posts.
  trunk.rotation.z = (rng() - 0.5) * 0.05;

  // Buttress roots. Thin radial fins, leaning their tops into the trunk so the
  // flare widens toward the ground the way a real one does.
  const fins = 3;
  const finTurn = rng() * Math.PI * 2;
  for (let i = 0; i < fins; i++) {
    const a = (i / fins) * Math.PI * 2 + finTurn;
    const fin = MeshBuilder.CreateBox(
      `jungle-buttress${i}`,
      { width: 0.2, height: 2.3 + rng() * 0.5, depth: 1.1 },
      scene,
    );
    fin.parent = trunk;
    // Local to the trunk's centre: -5.6 is its foot.
    fin.position.set(Math.sin(a) * 0.42, -4.5, Math.cos(a) * 0.42);
    fin.rotation.y = a;
    fin.rotation.x = -0.16;
    fin.material = bark;
  }

  // The crown's own mass, filling the middle the fronds radiate out of.
  const crown = MeshBuilder.CreateCylinder(
    "jungle-crown",
    { height: 1.1, diameterTop: 0.7, diameterBottom: 2.3, tessellation: 6 },
    scene,
  );
  crown.parent = trunk;
  crown.position.y = 4.5;
  crown.rotation.y = rng() * Math.PI * 2;
  crown.material = mats.getTranslucent(
    LEAF,
    CONFIG.graphics.translucency.canopy,
  );

  // Two rings of fronds, offset from each other so the gaps in one sit over the
  // blades of the other. Inner blade out from the crown, outer blade drooping
  // off its tip.
  const rings: [number, number, number, number][] = [
    // count, height on the trunk, blade length, droop
    [6, 4.2, 2.4, 0.34],
    [5, 5.1, 2.0, 0.18],
  ];
  rings.forEach(([count, y, len, droop], ring) => {
    const turn = rng() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + turn + rng() * 0.25;
      const tilt = droop + rng() * 0.16;
      const blade = MeshBuilder.CreateBox(
        `jungle-frond${ring}-${i}`,
        { width: 0.95, height: 0.14, depth: len },
        scene,
      );
      blade.parent = trunk;
      blade.position.set(
        Math.sin(a) * (len / 2 + 0.5),
        y,
        Math.cos(a) * (len / 2 + 0.5),
      );
      blade.rotation.y = a;
      blade.rotation.x = tilt;
      // The lit green goes on the upper ring: what a canopy shows the sky is
      // never what it shows the ground beneath it.
      blade.material = mats.getTranslucent(
        ring === 0 ? LEAF : LEAF_LIT,
        CONFIG.graphics.translucency.canopy,
      );

      // The drooping tip, hung off the blade's own far end so it rides the
      // parent's yaw and tilt. Its centre is derived from its own break angle
      // rather than authored: a fixed offset leaves the joint open at one
      // angle and the two segments overlapping at another.
      const brk = 0.5 + rng() * 0.3;
      const tipLen = len * 0.8;
      const tip = MeshBuilder.CreateBox(
        `jungle-tip${ring}-${i}`,
        { width: 0.7, height: 0.12, depth: tipLen },
        scene,
      );
      tip.parent = blade;
      tip.rotation.x = brk;
      tip.position.set(
        0,
        (-Math.sin(brk) * tipLen) / 2,
        len / 2 + (Math.cos(brk) * tipLen) / 2,
      );
      tip.material = blade.material;
    }
  });
  return trunk;
}

/**
 * Fern clump: a low crown of arching fronds, each broken into two segments the
 * same way a canopy tree's are.
 *
 * **Non-blocking, and that is the load-bearing decision here.** The canopy tree
 * keeps its foliage out of its collider because there is nothing to shoot nine
 * metres up; a fern sits at exactly the height of the hit sphere, so the same
 * reasoning inverts — anything soft at chest height must be either genuinely
 * solid or genuinely absent, never visible and shot straight through. And
 * solid is the wrong answer, because the one promise a jungle-tree belt makes
 * is that the canopy starts nine metres up and the sight lines under it stay
 * open. A bullet-stopping box in every gap between the trunks would contradict
 * that, punch nav holes through the understory and give bots one more thing to
 * wedge on. You walk through ferns. `bramble` makes the same call.
 */
export function buildFernClump(
  scene: Scene,
  mats: CelMaterialFactory,
  rng: () => number = Math.random,
): Mesh {
  const crown = MeshBuilder.CreateCylinder(
    "fern-crown",
    { height: 0.3, diameterTop: 0.26, diameterBottom: 0.4, tessellation: 5 },
    scene,
  );
  crown.position.y = 0.15;
  crown.material = mats.get(LEAF);

  // MANY blades, and SHORT ones. Both numbers are the difference between a
  // fern and an agave: the canopy tree's fronds are 2.0-2.4 m and read as a
  // canopy because they are nine metres up, but the same blade at ankle height
  // is a plank lying in the dirt — which is what the first pass looked like.
  // A clump reads as foliage from the count of edges in its silhouette, not
  // from the size of any one leaf.
  const blades = 7 + Math.floor(rng() * 4);
  const turn = rng() * Math.PI * 2;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + turn + rng() * 0.3;
    const len = 0.72 + rng() * 0.3;
    const blade = MeshBuilder.CreateBox(
      `fern-blade${i}`,
      { width: 0.3, height: 0.07, depth: len },
      scene,
    );
    blade.parent = crown;
    blade.position.set(Math.sin(a) * len * 0.42, 0.42, Math.cos(a) * len * 0.42);
    blade.rotation.y = a;
    // Negative: a frond leaves the crown climbing, then breaks over.
    blade.rotation.x = -0.5 - rng() * 0.25;
    blade.material = mats.getTranslucent(
      i % 2 === 0 ? LEAF_LIT : LEAF,
      CONFIG.graphics.translucency.canopy,
    );

    // The drooping tip, hung off the blade's far end with its centre derived
    // from its own break angle — buildJungleTree's frond, at a third the size.
    const brk = 0.8 + rng() * 0.4;
    const tipLen = len * 0.75;
    const tip = MeshBuilder.CreateBox(
      `fern-tip${i}`,
      { width: 0.22, height: 0.06, depth: tipLen },
      scene,
    );
    tip.parent = blade;
    tip.rotation.x = brk;
    tip.position.set(
      0,
      (-Math.sin(brk) * tipLen) / 2,
      len / 2 + (Math.cos(brk) * tipLen) / 2,
    );
    tip.material = blade.material;
  }
  return crown;
}

/**
 * A fallen jungle hardwood: a rolled trunk lying along its own local X, with
 * two buttress fins still standing off it and the torn root plate at one end.
 *
 * The buttresses are what make this a jungle log rather than the temperate one
 * — the same fins `buildJungleTree` stands its trunks on, seen from the side.
 *
 * Its collider (`PROP_BODIES`) is the TRUNK only. The fins reach 1.4 m and the
 * root plate 1.9, but both are thin plates, and a box that held them would stop
 * rounds through a metre of visible daylight along the whole prop — the canopy
 * tree's rule, applied in the same direction rather than inverted. At the trunk
 * height alone it also bakes as low cover rather than as a wall, which is what
 * a log should be.
 */
export function buildButtressLog(
  scene: Scene,
  mats: CelMaterialFactory,
  rng: () => number = Math.random,
): Mesh {
  const bark = mats.get(JUNGLE_BARK);
  const trunk = MeshBuilder.CreateCylinder(
    "buttresslog-trunk",
    { height: 5.2, diameterTop: 0.72, diameterBottom: 0.95, tessellation: 7 },
    scene,
  );
  trunk.position.y = 0.48;
  trunk.rotation.z = Math.PI / 2;
  // Rolled about its own axis, so no two logs show the same facet uppermost.
  trunk.rotation.x = (rng() - 0.5) * 0.3;
  trunk.material = bark;

  // Buttress fins, still standing off the butt end. Parented to the trunk, so
  // they ride its roll — a fin that ignored it would float.
  for (let i = 0; i < 2; i++) {
    const fin = MeshBuilder.CreateBox(
      `buttresslog-fin${i}`,
      { width: 0.16, height: 1.5, depth: 1.1 },
      scene,
    );
    fin.parent = trunk;
    fin.position.set(0, -2.0, (i === 0 ? 1 : -1) * 0.42);
    fin.rotation.x = (i === 0 ? 1 : -1) * 0.22;
    fin.material = bark;
  }

  // The torn root plate: a disc on edge, closing the butt.
  const plate = MeshBuilder.CreateCylinder(
    "buttresslog-plate",
    { height: 0.28, diameterTop: 1.7, diameterBottom: 1.9, tessellation: 7 },
    scene,
  );
  plate.parent = trunk;
  plate.position.y = -2.7;
  plate.material = mats.get(DEAD_BARK);

  // Moss along the upper flank — a log on a wet floor is the first thing the
  // forest takes.
  for (let i = 0; i < 3; i++) {
    const moss = MeshBuilder.CreateBox(
      `buttresslog-moss${i}`,
      { width: 0.5, height: 0.1, depth: 0.62 },
      scene,
    );
    moss.parent = trunk;
    moss.position.set(0.44, -1.4 + i * 1.5, 0);
    moss.rotation.z = 0.3;
    moss.material = mats.get(VINE);
  }
  return trunk;
}

/**
 * A carved stele: a leaning slab of worked stone with relief bands and a
 * chamfered cap, half-swallowed at the foot.
 *
 * The temple's outriders — the thing that says a stepped platform in a jungle
 * was a place rather than a hill. It is the only one of the three understory
 * props that clears the 1.7 m hit sphere, so it is the only one `CoverMap`
 * bakes as genuine hard cover.
 *
 * Its collider is wide and thin and oriented with the prop, which is the
 * gravestone's lesson: squared off to its own width it would block five times
 * its thickness. The stone leans a few degrees while the box does not, so the
 * top corner stands a little outside it — the same approximation the gravestone
 * already makes at a much steeper angle.
 */
export function buildCarvedStele(
  scene: Scene,
  mats: CelMaterialFactory,
  rng: () => number = Math.random,
): Mesh {
  const stone = mats.get(STONE);
  const slab = MeshBuilder.CreateBox(
    "stele-slab",
    { width: 0.95, height: 2.3, depth: 0.42 },
    scene,
  );
  slab.position.y = 1.15;
  // Shallower than the gravestone's: nobody has been keeping this one upright,
  // but a temple mason set it deeper than a village sexton did.
  slab.rotation.x = (rng() - 0.5) * 0.18;
  slab.rotation.z = (rng() - 0.5) * 0.24;
  slab.material = stone;

  const cap = MeshBuilder.CreateCylinder(
    "stele-cap",
    { height: 0.2, diameter: 0.98, tessellation: 6 },
    scene,
  );
  cap.parent = slab;
  cap.rotation.x = Math.PI / 2;
  cap.position.y = 1.2;
  cap.material = stone;

  // Relief bands across the face — the carving, at the only fidelity a cel
  // shader's flat bands can carry at this distance.
  for (let i = 0; i < 3; i++) {
    const band = MeshBuilder.CreateBox(
      `stele-band${i}`,
      { width: 0.78, height: 0.14, depth: 0.06 },
      scene,
    );
    band.parent = slab;
    band.position.set(0, 0.55 - i * 0.55, 0.24);
    band.material = mats.get(DARK_STONE);
  }

  const plinth = MeshBuilder.CreateBox(
    "stele-plinth",
    { width: 1.3, height: 0.3, depth: 0.7 },
    scene,
  );
  plinth.parent = slab;
  plinth.position.y = -1.1;
  plinth.material = mats.get(DARK_STONE);

  // Creeper up one face.
  const vine = MeshBuilder.CreateBox(
    "stele-vine",
    { width: 0.16, height: 1.6, depth: 0.08 },
    scene,
  );
  vine.parent = slab;
  vine.position.set(-0.3, -0.15, -0.25);
  vine.material = mats.get(VINE);
  return slab;
}

/** Leaning headstone with a cracked-off corner. */
export function buildGravestone(
  scene: Scene,
  mats: CelMaterialFactory,
  rng: () => number = Math.random,
): Mesh {
  const stone = mats.get(STONE);
  const slab = MeshBuilder.CreateBox(
    "grave-slab",
    { width: 1.0, height: 1.5, depth: 0.24 },
    scene,
  );
  slab.position.y = 0.75;
  slab.rotation.x = (rng() - 0.5) * 0.22;
  slab.rotation.z = (rng() - 0.5) * 0.3;
  slab.material = stone;

  const cap = MeshBuilder.CreateCylinder(
    "grave-cap",
    { height: 0.22, diameter: 1.0, tessellation: 7 },
    scene,
  );
  cap.parent = slab;
  cap.rotation.x = Math.PI / 2;
  cap.position.y = 0.72;
  cap.material = stone;

  const plinth = MeshBuilder.CreateBox(
    "grave-plinth",
    { width: 1.3, height: 0.28, depth: 0.5 },
    scene,
  );
  plinth.parent = slab;
  plinth.position.y = -0.72;
  plinth.material = mats.get("#5f6461");
  return slab;
}

/** Iron lamp post — the warm anchor in an otherwise blue-black village. */
export function buildLantern(scene: Scene, mats: CelMaterialFactory): Mesh {
  const iron = mats.get(IRON);
  const post = MeshBuilder.CreateCylinder(
    "lantern-post",
    { height: 3.6, diameterTop: 0.14, diameterBottom: 0.24, tessellation: 6 },
    scene,
  );
  post.position.y = 1.8;
  post.material = iron;

  const arm = MeshBuilder.CreateBox(
    "lantern-arm",
    { width: 0.9, height: 0.1, depth: 0.1 },
    scene,
  );
  arm.parent = post;
  arm.position.set(0.35, 1.75, 0);
  arm.material = iron;

  const cage = MeshBuilder.CreateCylinder(
    "lantern-cage",
    { height: 0.62, diameterTop: 0.42, diameterBottom: 0.3, tessellation: 6 },
    scene,
  );
  cage.parent = post;
  cage.position.set(0.75, 1.42, 0);
  cage.material = iron;

  const flame = MeshBuilder.CreateSphere(
    "lantern-flame",
    { diameter: 0.3, segments: 6 },
    scene,
  );
  flame.parent = cage;
  flame.material = mats.getEmissive("#ffbe63");
  flame.metadata = { noOutline: true };

  const cap = MeshBuilder.CreateCylinder(
    "lantern-cap",
    { height: 0.18, diameterTop: 0.1, diameterBottom: 0.5, tessellation: 6 },
    scene,
  );
  cap.parent = cage;
  cap.position.y = 0.38;
  cap.material = iron;
  return post;
}

/** Cluster of luminous corpse-fungus — small, cold, and everywhere. */
export function buildFungus(
  scene: Scene,
  mats: CelMaterialFactory,
  rng: () => number = Math.random,
): Mesh {
  const stem = mats.get("#6a6f63");
  const glow = mats.getEmissive("#6effc0");
  const base = MeshBuilder.CreateCylinder(
    "fungus-base",
    { height: 0.5, diameterTop: 0.12, diameterBottom: 0.2, tessellation: 5 },
    scene,
  );
  base.position.y = 0.25;
  base.material = stem;

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng();
    const r = 0.25 + rng() * 0.35;
    const h = 0.3 + rng() * 0.4;
    const stalk = MeshBuilder.CreateCylinder(
      `fungus-stalk${i}`,
      { height: h, diameterTop: 0.07, diameterBottom: 0.1, tessellation: 5 },
      scene,
    );
    stalk.parent = base;
    stalk.position.set(Math.cos(a) * r, h / 2 - 0.2, Math.sin(a) * r);
    stalk.material = stem;

    const cap = MeshBuilder.CreateSphere(
      `fungus-cap${i}`,
      { diameter: 0.26 + rng() * 0.12, segments: 5 },
      scene,
    );
    cap.parent = stalk;
    cap.position.y = h / 2;
    cap.scaling.y = 0.55;
    cap.material = glow;
    cap.metadata = { noOutline: true };
  }
  return base;
}

/** Fallen, half-rotted log. */
export function buildLog(
  scene: Scene,
  mats: CelMaterialFactory,
  rng: () => number = Math.random,
): Mesh {
  const log = MeshBuilder.CreateCylinder(
    "log",
    { height: 3.0, diameterTop: 0.55, diameterBottom: 0.7, tessellation: 6 },
    scene,
  );
  log.rotation.z = Math.PI / 2;
  log.rotation.x = (rng() - 0.5) * 0.4;
  log.position.y = 0.36;
  log.material = mats.get(DEAD_BARK);

  const stub = MeshBuilder.CreateCylinder(
    "log-stub",
    { height: 0.9, diameterTop: 0.12, diameterBottom: 0.22, tessellation: 5 },
    scene,
  );
  stub.parent = log;
  stub.position.set(0, 0.6, 0.3);
  stub.rotation.x = 0.6;
  stub.material = mats.get(BARK);
  return log;
}

/** Burning oil drum — the villagers' braziers, still lit. */
export function buildFireDrum(scene: Scene, mats: CelMaterialFactory): Mesh {
  const drum = MeshBuilder.CreateCylinder(
    "drum",
    { height: 1.2, diameter: 0.95, tessellation: 8 },
    scene,
  );
  drum.position.y = 0.6;
  drum.material = mats.get(RUST);

  const rim = MeshBuilder.CreateTorus(
    "drum-rim",
    { diameter: 1.0, thickness: 0.1, tessellation: 10 },
    scene,
  );
  rim.parent = drum;
  rim.position.y = 0.55;
  rim.material = mats.get(DARK_METAL);

  const fire = MeshBuilder.CreateCylinder(
    "drum-fire",
    { height: 0.95, diameterTop: 0.06, diameterBottom: 0.72, tessellation: 6 },
    scene,
  );
  fire.parent = drum;
  fire.position.y = 0.9;
  fire.material = mats.getEmissive("#ff8a2a");
  fire.metadata = { noOutline: true };
  return drum;
}

/** Glacial boulder — hard cover in the fields and the woods. */
export function buildBoulder(
  scene: Scene,
  mats: CelMaterialFactory,
  rng: () => number = Math.random,
): Mesh {
  const rock = MeshBuilder.CreatePolyhedron(
    "boulder",
    { type: 1, size: 0.8 },
    scene,
  );
  rock.position.y = 0.6;
  rock.scaling.set(1.3 + rng() * 0.4, 0.85 + rng() * 0.3, 1.2);
  rock.rotation.set(rng() * 0.4, rng() * Math.PI, 0.12);
  rock.material = mats.get("#565d59");

  // A shoulder stone, so the silhouette isn't a single tidy lump.
  const chip = MeshBuilder.CreatePolyhedron(
    "boulder-chip",
    { type: 0, size: 0.42 },
    scene,
  );
  chip.parent = rock;
  chip.position.set(0.7, -0.35, 0.4);
  chip.rotation.set(rng(), rng(), rng());
  chip.material = mats.get("#474e4a");
  return rock;
}

/**
 * Dead bramble thicket. Non-blocking on purpose: it is visual undergrowth that
 * fills bare ground without adding another thing for a bot to get wedged in.
 */
export function buildBramble(
  scene: Scene,
  mats: CelMaterialFactory,
  rng: () => number = Math.random,
): Mesh {
  const wood = mats.get(DEAD_BARK);
  const base = MeshBuilder.CreateCylinder(
    "bramble",
    { height: 0.4, diameterTop: 0.5, diameterBottom: 0.7, tessellation: 5 },
    scene,
  );
  base.position.y = 0.2;
  base.material = wood;

  const canes = 6 + Math.floor(rng() * 4);
  for (let i = 0; i < canes; i++) {
    const a = (i / canes) * Math.PI * 2 + rng() * 0.5;
    const h = 0.8 + rng() * 0.9;
    const cane = MeshBuilder.CreateCylinder(
      `cane${i}`,
      { height: h, diameterTop: 0.03, diameterBottom: 0.09, tessellation: 4 },
      scene,
    );
    cane.parent = base;
    cane.position.set(Math.cos(a) * 0.22, h / 2, Math.sin(a) * 0.22);
    cane.rotation.z = -Math.cos(a) * (0.5 + rng() * 0.6);
    cane.rotation.x = Math.sin(a) * (0.5 + rng() * 0.6);
    cane.material = wood;
  }
  return base;
}

/** Abandoned barrel — small hard cover, and the village's loose change. */
export function buildBarrel(scene: Scene, mats: CelMaterialFactory): Mesh {
  const barrel = MeshBuilder.CreateCylinder(
    "barrel",
    { height: 1.2, diameterTop: 0.8, diameterBottom: 0.9, tessellation: 8 },
    scene,
  );
  barrel.position.y = 0.6;
  barrel.material = mats.get("#4a4034");

  for (const y of [-0.32, 0.3]) {
    const hoop = MeshBuilder.CreateCylinder(
      `hoop${y}`,
      { height: 0.1, diameter: 0.96, tessellation: 8 },
      scene,
    );
    hoop.parent = barrel;
    hoop.position.y = y;
    hoop.material = mats.get(DARK_METAL);
  }

  const lid = MeshBuilder.CreateCylinder(
    "barrel-lid",
    { height: 0.08, diameter: 0.72, tessellation: 8 },
    scene,
  );
  lid.parent = barrel;
  lid.position.y = 0.62;
  lid.material = mats.get(BARK);
  return barrel;
}

/** Collapsed masonry with rebar poking out — waist-high cover. */
export function buildRubble(
  scene: Scene,
  mats: CelMaterialFactory,
  rng: () => number = Math.random,
): Mesh {
  const heap = MeshBuilder.CreateBox(
    "rubble",
    { width: 1.9, height: 0.6, depth: 1.6 },
    scene,
  );
  heap.position.y = 0.3;
  heap.rotation.y = rng() * Math.PI;
  heap.material = mats.get(CONCRETE);

  for (let i = 0; i < 3; i++) {
    const chunk = MeshBuilder.CreateBox(
      `chunk${i}`,
      { width: 0.7, height: 0.5, depth: 0.6 },
      scene,
    );
    chunk.parent = heap;
    chunk.position.set(
      (rng() - 0.5) * 1.2,
      0.4,
      (rng() - 0.5) * 1.0,
    );
    chunk.rotation.set(rng(), rng(), rng());
    chunk.material = mats.get("#565a62");
  }

  const rebar = MeshBuilder.CreateCylinder(
    "rebar",
    { height: 1.7, diameterTop: 0.05, diameterBottom: 0.07, tessellation: 4 },
    scene,
  );
  rebar.parent = heap;
  rebar.position.set(0.5, 0.8, -0.3);
  rebar.rotation.z = 0.7;
  rebar.material = mats.get("#6b5c4a");
  return heap;
}
