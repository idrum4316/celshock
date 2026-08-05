/**
 * Props.ts — Scatter prop factories (trees, gravestones, lanterns, fungus,
 * logs, fire drums, rubble, boulders, brambles, barrels). Pure mesh builders:
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
const STONE = "#7a7f7c";
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
