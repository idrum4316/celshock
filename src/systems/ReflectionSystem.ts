/**
 * ReflectionSystem.ts — The world as glass sees it: ONE cube map, baked from
 * the map's own geometry once per map install, and the box the shader
 * parallax-corrects the mirrored ray against.
 *
 * The only render target in the game besides the shadow map, and the only
 * thing in the renderer that draws the world a second time. It is affordable
 * for exactly one reason: the world is static, so the bake is not a pass, it
 * is a build step that happens to run on the GPU.
 *
 * Invariants:
 * - The render list is the map's OPAQUE visuals. The glazing is left out of
 *   its own reflection (a pane in the bake would blend against a transparent
 *   clear and come back premultiplied), and so is the sky — the dome rides at
 *   infiniteDistance, and a box projection would drag it around with the
 *   viewer. The cube's ALPHA is what tells the shader which it is looking at:
 *   1 where the bake drew something, 0 where it saw nothing and the shader's
 *   own sky gradient stands.
 * - The renderList must be replaced on every install, before the next frame:
 *   last build's meshes are disposed by then, exactly as for
 *   `ShadowSystem.setCasters`.
 * - The bake renders the world from the PROBE, so the cel materials' eye moves
 *   for the six faces and is put back after each one — the main pass of the
 *   same frame follows them and would otherwise fog the whole map against a
 *   point in the middle of it.
 * - A map with no glazing bakes nothing and publishes strength 0. The cube
 *   stays bound regardless; see `CelMaterialFactory.setReflection`.
 */
import {
  Color4,
  ReflectionProbe,
  RenderTargetTexture,
  type Scene,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import type { CelMaterialFactory } from "../shaders/CelShader";
import type { GameMap, WorldBox } from "../world/MapBuilder";

/**
 * One reflection cube for the whole map, and the reasoning behind the number.
 *
 * The honest way to reflect a city is a probe per building, or a screen-space
 * pass, and neither is on offer here. Screen space cannot answer the question
 * this feature exists for: a pane you are looking at reflects what is BEHIND
 * you, which is precisely what is not on screen. A probe per building is six
 * face renders each, and the money would have to come out of a frame budget
 * whose whole argument is that the world is merged, frozen and drawn once.
 *
 * What one cube plus a box projection gets wrong is position — the reflection
 * of a tower is the right tower, the right colour, moving the right way as you
 * walk, seen from the middle of the map rather than from the pane. What it
 * gets right is everything a reflection is actually read by. Nobody counts the
 * windows in a window.
 *
 * The bake point is the map's centre, which on the one map with glazing on it
 * is a paved square with the whole skyline around it. `place()` will climb out
 * of a building if a future map puts one there, because a cube baked inside a
 * lobby would put that lobby in every window in the city.
 */
export class ReflectionSystem {
  private readonly probe: ReflectionProbe;
  /** The bake's own box: the map's extent, its floor and its roofline. */
  private readonly boxMin = Vector3.Zero();
  private readonly boxMax = Vector3.Zero();
  /** The eye the cel materials held when the bake borrowed it, per face. */
  private readonly borrowedEye = Vector3.Zero();

  constructor(scene: Scene, private readonly mats: CelMaterialFactory) {
    const cfg = CONFIG.graphics.reflection;
    this.probe = new ReflectionProbe("world-reflection", cfg.size, scene);
    const rtt = this.probe.cubeTexture;
    // Transparent black, and the alpha is the load-bearing half: it is how the
    // shader tells the city from the sky above it. Everything drawn here is a
    // cel material, and every cel variant but the glazing writes alpha 1.
    rtt.clearColor = new Color4(0, 0, 0, 0);
    // The world is static, so the bake is not a per-frame cost at all. Reset by
    // `build`, which is the only thing that ever asks for another one.
    rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    rtt.renderList = [];
    // A ReflectionProbe registers itself with the scene but nothing renders it:
    // Babylon collects render targets off the materials it finds on active
    // meshes, and this one is bound to a ShaderMaterial by hand. So it is a
    // custom target, which is also what puts it before the main pass.
    scene.customRenderTargets.push(rtt);
    // The bake is a picture of the world from the probe, so it has to be lit,
    // fogged and rimmed from there. Both hooks fire per face; the eye is put
    // back after each one, so the six faces cost twelve walks of the material
    // cache — once per map install, against a walk a still frame skips.
    //
    // **The eye is read on face 0 and only face 0**, because by face 1 the eye
    // IS the probe and reading it again saves the wrong thing. Measured before
    // that guard existed: the whole cache came out of the bake holding the
    // probe's position, so the main pass of the install frame fogged the map
    // against a point in the middle of it and the next frame quietly put it
    // right — one wrong frame, on the one frame the player is being shown a
    // building card, which is as close to invisible as a bug gets.
    rtt.onBeforeRenderObservable.add((faceIndex) => {
      if (faceIndex === 0) this.mats.readEye(this.borrowedEye);
      this.mats.updateCamera(this.probe.position);
    });
    rtt.onAfterUnbindObservable.add(() => {
      this.mats.updateCamera(this.borrowedEye);
    });
  }

  /**
   * Bakes the installed map, and publishes the result to the glazing.
   *
   * Called from `Game.installMap` for the reason every line around it is: the
   * meshes this holds are the ones the next build disposes.
   *
   * A map with no glazing bakes nothing — it would be six renders of a village
   * nothing on it can reflect — and publishes a strength of 0, which is the
   * whole of the off switch. The cube is still handed over: see
   * `CelMaterialFactory.setReflection` on why a bound samplerCube is not
   * optional even when its contents are.
   */
  build(map: GameMap): void {
    const cfg = CONFIG.graphics.reflection;
    const rtt = this.probe.cubeTexture;
    if (map.paneGroups.length === 0) {
      rtt.renderList = [];
      this.mats.setReflection(rtt, this.boxMin, this.boxMax, this.probe.position, 0);
      return;
    }

    // The opaque world, which is `visuals` minus the glazing merged into it.
    // A pane in its own bake is a blended draw over a transparent clear, and
    // what comes back is a colour already multiplied by an alpha the shader is
    // about to divide out again.
    const panes = new Set(map.paneGroups.map((g) => g.mesh));
    rtt.renderList = map.visuals.filter((m) => !panes.has(m));

    const floor = this.place(map);
    // The box the mirrored ray leaves the world through. Its walls are the
    // map's own boundary — the four colliders nothing may pass — and its lid is
    // the tallest thing standing inside them. Its floor is the ground under the
    // probe rather than the lowest collider on the map: colliders under a
    // walked surface are deliberately thick (see the world contract), so the
    // lowest of them is a slab several metres below anything that can be seen.
    const half = map.size / 2;
    let roof = floor;
    for (const b of map.colliderBoxes) roof = Math.max(roof, top(b));
    this.boxMin.copyFromFloats(-half, floor, -half);
    this.boxMax.copyFromFloats(half, roof, half);

    // The renderList is new geometry every time, so the standing bake is of a
    // map that no longer exists.
    rtt.resetRefreshCounter();
    this.mats.setReflection(
      rtt,
      this.boxMin,
      this.boxMax,
      this.probe.position,
      cfg.strength,
    );
  }

  /**
   * Stands the probe at the map's centre, `reflection.height` over the ground,
   * and returns that ground.
   *
   * The climb is for a map this project does not have yet. Coldharbour's
   * origin is the civic square and the loop below finds nothing there, but a
   * map that puts a building on its centre would otherwise bake the inside of
   * it into every window on the map — a failure with no symptom except that
   * the city looks wrong, which is the kind this codebase pays a few lines to
   * make impossible. Standing on the roof of that building is not right
   * either; it is merely recoverable, and it says so in the console.
   */
  private place(map: GameMap): number {
    const floor = map.terrain.surfaceAt(0, 0, true);
    let y = floor + CONFIG.graphics.reflection.height;
    // Four passes: each one clears every box it was inside, and a stack that
    // needs more than four is a map with a problem this cannot solve anyway.
    for (let pass = 0; pass < 4; pass++) {
      let lifted = y;
      for (const b of map.colliderBoxes) {
        if (contains(b, y)) lifted = Math.max(lifted, top(b) + 2);
      }
      if (lifted === y) break;
      y = lifted;
      if (import.meta.env.DEV) {
        console.warn(
          `[reflection] the map's centre is built on; the bake stands at y=${y.toFixed(1)}`,
        );
      }
    }
    this.probe.position.copyFromFloats(0, y, 0);
    return floor;
  }
}

/** A box's top face. `rotX` is ignored: nothing that carries one is a room. */
function top(b: WorldBox): number {
  return b.cy + b.h / 2;
}

/**
 * Whether the map's origin at height `y` is inside this box. Only the origin,
 * because that is the only column the probe ever stands in — which is what
 * lets the turn be undone by rotating the box's own half-extents rather than
 * the point.
 */
function contains(b: WorldBox, y: number): boolean {
  if (y < b.cy - b.h / 2 || y > top(b)) return false;
  // The point is at the origin, so the offset to the box centre is -c; turn it
  // into the box's own frame by rotating it back through -rotY.
  const dx = -b.cx;
  const dz = -b.cz;
  const cos = Math.cos(b.rotY);
  const sin = Math.sin(b.rotY);
  const lx = dx * cos + dz * sin;
  const lz = -dx * sin + dz * cos;
  return Math.abs(lx) <= b.w / 2 && Math.abs(lz) <= b.d / 2;
}
