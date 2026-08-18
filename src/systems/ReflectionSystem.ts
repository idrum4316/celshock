/**
 * ReflectionSystem.ts — The world as glass sees it: one cube map PER GLAZED
 * BLOCK, baked from the map's own geometry once per map install, and the box
 * the shader parallax-corrects the mirrored ray against.
 *
 * The only render target in the game besides the shadow map, and the only
 * thing in the renderer that draws the world again. It is affordable for
 * exactly one reason: the world is static, so a bake is not a pass, it is a
 * build step that happens to run on the GPU.
 *
 * Invariants:
 * - One probe per `GameMap.paneGroups` entry, standing at the CENTRE of that
 *   group's own glazing, and the group's mesh gets a material of its own
 *   carrying that probe's cube. Costs no draw call: the glazing is already one
 *   merged mesh per map block.
 * - A probe's render list is the map's opaque visuals MINUS whatever encloses
 *   it — see `encloses`, and read it before touching this, because a probe
 *   standing inside a tower with the tower still in the bake reflects the
 *   inside of that tower onto every window in it.
 * - The renderList must be replaced on every install, before the next frame:
 *   last build's meshes are disposed by then, exactly as for
 *   `ShadowSystem.setCasters`.
 * - The bake renders the world from the probe, so the cel materials' eye is
 *   moved for it and put back around the whole render-target block — never
 *   per probe, or 37 bakes are 37 chances to put it back wrong.
 * - Probes are pooled and never disposed, like the bot rigs: a `ReflectionProbe`
 *   is six scene uniform buffers and a cube, and a round is not the place to
 *   build one.
 * - A map with no glazing bakes nothing. The default cube stays bound to the
 *   glazing material regardless; see `CelMaterialFactory.setDefaultReflection`.
 * - **An EDITOR build bakes nothing either**, for the reason the whole file is
 *   affordable: a bake is a build step because the world is static, and the
 *   editor is the one place it is not. See `build`.
 */
import {
  Color4,
  type Mesh,
  ReflectionProbe,
  RenderTargetTexture,
  type Scene,
  type ShaderMaterial,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import type { CelMaterialFactory, ProbeReflection } from "../shaders/CelShader";
import type { GameMap, WorldBox } from "../world/MapBuilder";

/**
 * A cube per glazed block, and why the count is what it is.
 *
 * **One cube for the whole map cannot show the building opposite**, which is
 * the only thing a reflection in a city is really made of. A pane returns what
 * lies in the mirrored direction, and a bake taken 150 m away has the right
 * city in it seen from the wrong place — the tower across the street lands in
 * the pane at the angle it subtends from the middle of the map. That was the
 * first version of this file, and it was a decal with parallax on it.
 *
 * **A cube per PANE is the other end and is not on offer**: Coldharbour draws
 * 6,139 sheets. What makes a middle affordable is that the glazing is already
 * merged into one mesh per map block — 37 of them — so one probe per merged
 * mesh costs 40 cubes and not one extra draw call. A probe then stands within
 * ~25 m of every pane it serves rather than ~150, and the building opposite is
 * genuinely in its cube.
 *
 * **The probe stands at the centre of the glass it serves**, which puts it
 * inside the shaft of a tower's wrap-around curtain wall and exactly ON the
 * plane of a flat shopfront. Both are right, for the same reason: a pane only
 * ever reflects the hemisphere in front of it, so what matters is that the
 * probe sees OUT in every direction its own panes face. For the shopfront that
 * is free — the office behind it is behind the probe too. For the tower it is
 * what `encloses` is for.
 */
export class ReflectionSystem {
  /**
   * The probe pool, indexed by slot. Grown on demand and never shrunk: a map
   * with fewer glazed blocks than the last one leaves the spare probes parked
   * with an empty render list, which costs a refresh-counter check a frame.
   */
  private readonly probes: ReflectionProbe[] = [];
  /** Scratch for the box handed to the factory, which copies it. */
  private readonly boxMin = Vector3.Zero();
  private readonly boxMax = Vector3.Zero();
  /** The eye the cel materials held before the render targets ran. */
  private readonly savedEye = Vector3.Zero();

  constructor(
    private readonly scene: Scene,
    private readonly mats: CelMaterialFactory,
  ) {
    // The eye is borrowed around the whole render-target block rather than
    // around each probe. Every cel material fogs and rims against `camPos`, so
    // a bake has to move it — and putting it back is then ONE restore for
    // however many probes ran, instead of a pair of hooks per probe that have
    // to agree with each other. The shadow map renders in this window too and
    // does not care: a depth pass reads no eye.
    //
    // Both are guarded walks (`updateCamera` skips a still camera), so on the
    // thousands of frames that bake nothing this is a vector copy and a
    // comparison.
    scene.onBeforeRenderTargetsRenderObservable.add(() => {
      this.mats.readEye(this.savedEye);
    });
    scene.onAfterRenderTargetsRenderObservable.add(() => {
      this.mats.updateCamera(this.savedEye);
    });
    // Probe 0 exists before any map does, because `MapBuilder` asks for a
    // glazing material during the build and that material has to be born with
    // a cube bound to it — see `CelMaterialFactory.setDefaultReflection`.
    this.mats.setDefaultReflection(this.probeAt(0).cubeTexture);
  }

  /**
   * Bakes the installed map's glazing, one cube per glazed block, and hands
   * each block's mesh the material that samples its own.
   *
   * Called from `Game.installMap` for the reason every line around it is: the
   * meshes this holds are the ones the next build disposes.
   *
   * **Editor builds park the probes and bake nothing**, which is the same
   * refusal `PhysicsWorld.setMap` makes one line below it in `installMap` and
   * for a sharper version of the same reason. A bake is affordable because the
   * world is static, so it is a BUILD STEP rather than a pass — and the editor
   * is the one place in the game where the world is not static and a build is
   * not rare. Every tier-3 rebuild pays for one, and an editor build makes it
   * worse from both ends: `PaneBlocks` keys per PLACEMENT there, so
   * Coldharbour's 40 glazed blocks become 82, and the render list is the
   * unmerged visuals. Measured on Coldharbour: 40 probes over 405 meshes in a
   * round against 82 over 610 in the editor, which is one frame of ~300,000
   * draw calls after every param edit, add, delete or brush stroke. With this
   * skip the same frame issues ~500, and the steady editor frame — ~420 draws,
   * all of them the shadow map and the main pass — is unchanged either way,
   * because a parked probe renders nothing.
   *
   * What the editor gives up is the city in its glass: a pane keeps the
   * glazing material `MapBuilder` gave it, which is born holding the default
   * cube at a strength of ZERO (`CelMaterialFactory.applyReflection`), so it
   * shows the analytic sky half of the reflection and no more. That is the
   * state a pane is in before any probe has claimed it rather than a new one,
   * and it is the right trade in a view that already strips the map's own
   * night back to a work light to author under.
   */
  build(map: GameMap, editor: boolean): void {
    const cfg = CONFIG.graphics.reflection;
    // Park everything first. A render list surviving into the next install is
    // a list of disposed meshes, and the probes this map does not reach never
    // get another one. This is what the editor's skip below leans on: it is
    // above the return, so a probe left over from the round the editor was
    // opened from is emptied rather than left holding a disposed map.
    for (const probe of this.probes) probe.cubeTexture.renderList = [];
    if (editor || map.paneGroups.length === 0) return;

    // The opaque world: `visuals` minus the glazing merged into it. A pane in
    // a bake is a blended draw over a transparent clear, and what comes back
    // is a colour already multiplied by an alpha the shader divides out again.
    const panes = new Set(map.paneGroups.map((g) => g.mesh));
    const opaque = map.visuals.filter((m) => !panes.has(m));

    // The lid of every probe's box: the tallest thing standing on the map. The
    // walls are the map's own boundary and the floor is per probe, because the
    // ground under one is the only part of that box a map's terrain moves.
    let roof = 0;
    for (const b of map.colliderBoxes) roof = Math.max(roof, top(b));
    const half = map.size / 2;

    const started = performance.now();
    let enclosing = 0;
    for (const [slot, group] of map.paneGroups.entries()) {
      const probe = this.probeAt(slot);
      centreOf(group.mesh, probe.position);
      const list = opaque.filter((m) => !encloses(m, probe.position));
      enclosing += opaque.length - list.length;
      probe.cubeTexture.renderList = list;
      probe.cubeTexture.resetRefreshCounter();

      const floor = map.terrain.surfaceAt(
        probe.position.x,
        probe.position.z,
        true,
      );
      this.boxMin.copyFromFloats(-half, floor, -half);
      this.boxMax.copyFromFloats(half, Math.max(roof, floor + 1), half);
      const base = group.mesh.material as ShaderMaterial | null;
      if (base) {
        const refl: ProbeReflection = {
          cube: probe.cubeTexture,
          boxMin: this.boxMin,
          boxMax: this.boxMax,
          at: probe.position,
          strength: cfg.strength,
        };
        group.mesh.material = this.mats.glassProbe(base, slot, refl);
      }
    }

    if (import.meta.env.DEV) {
      const n = map.paneGroups.length;
      console.info(
        `[reflection] ${n} probes over ${opaque.length} meshes ` +
          `(${(enclosing / n).toFixed(1)} enclosing each) queued in ` +
          `${(performance.now() - started).toFixed(1)} ms`,
      );
    }
  }

  /** The probe in a slot, built on first use and kept for the process. */
  private probeAt(slot: number): ReflectionProbe {
    const standing = this.probes[slot];
    if (standing) return standing;
    const probe = new ReflectionProbe(
      `world-reflection-${slot}`,
      CONFIG.graphics.reflection.size,
      this.scene,
    );
    const rtt = probe.cubeTexture;
    // Transparent black, and the alpha is the load-bearing half: it is how the
    // shader tells the city from the sky above it. Everything drawn here is a
    // cel material, and every cel variant but the glazing writes alpha 1.
    rtt.clearColor = new Color4(0, 0, 0, 0);
    // The world is static, so a bake is not a per-frame cost at all. `build` is
    // the only thing that ever asks for another one.
    rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    rtt.renderList = [];
    // A ReflectionProbe registers itself with the scene but nothing renders it:
    // Babylon collects render targets off the materials it finds on active
    // meshes, and these are bound to ShaderMaterials by hand. So they are
    // custom targets, which is also what puts them before the main pass.
    this.scene.customRenderTargets.push(rtt);
    // Per face, and cheap: `updateCamera` guards on the position, so the six
    // faces of one probe cost one walk of the material cache between them.
    rtt.onBeforeRenderObservable.add(() => {
      this.mats.updateCamera(probe.position);
    });
    this.probes[slot] = probe;
    return probe;
  }
}

/** A box's top face. `rotX` is ignored: nothing that carries one is a room. */
function top(b: WorldBox): number {
  return b.cy + b.h / 2;
}

/** The centre of a mesh's world bounding box, into `out`. */
function centreOf(mesh: Mesh, out: Vector3): Vector3 {
  const box = mesh.getBoundingInfo().boundingBox;
  return box.minimumWorld.addToRef(box.maximumWorld, out).scaleInPlace(0.5);
}

/**
 * Whether this mesh is what the probe is standing INSIDE — the geometry that
 * has to come out of the bake, or the cube is a picture of a wall.
 *
 * Two halves, and the second is not a refinement of the first.
 *
 * **Inside its world bounding box.** Coarse on purpose: the opaque world is
 * merged per map block per colour, so the mesh a tower's probe is inside is
 * that block's own merged mesh, and taking it out takes the tower with it. It
 * is not as coarse as it sounds — measured across Coldharbour's 37 probes, the
 * hits are one to five of the probe's own block's colour meshes, and a parked
 * car's probe hits nothing but the car's own body (4 x 2 m), because a colour
 * that appears once appears in a mesh of its own.
 *
 * **But never a flat receiver.** `noShadowCaster` marks the surfaces that are
 * lain on rather than stood in — the terrain patches, the roads, and the
 * valley rim, whose bounding boxes are enormous landform slabs. Two of
 * Coldharbour's corner towers stand inside `ridge-rock`'s box, 44 m from any
 * rock, and without this they would be the two buildings on the map whose
 * glass has no hills in it. The rule reads as a rule about geometry, and it is
 * one: a floor is not an enclosure.
 */
function encloses(mesh: Mesh, at: Vector3): boolean {
  if (mesh.metadata?.noShadowCaster === true) return false;
  const box = mesh.getBoundingInfo().boundingBox;
  const min = box.minimumWorld;
  const max = box.maximumWorld;
  return (
    at.x >= min.x &&
    at.x <= max.x &&
    at.y >= min.y &&
    at.y <= max.y &&
    at.z >= min.z &&
    at.z <= max.z
  );
}
