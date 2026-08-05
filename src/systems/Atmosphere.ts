/**
 * Atmosphere.ts — One shared drifting-particle system (ash/embers/motes),
 * reconfigured per environment via apply(ParticleSpec). Texture is generated
 * at runtime. apply(undefined) stops the emitter.
 *
 * The simulation is transform feedback (`GPUParticleSystem`), which is what
 * makes a field of tens of thousands cost what a thousand cost on the CPU.
 * There is no CPU fallback and there is deliberately no capability check:
 * Babylon reports transform feedback for any WebGL2 context
 * (`supportTransformFeedbacks = _webGLVersion > 1`), and WebGL2 is a hard
 * requirement of the game — `main.ts` says as much, and registers the service
 * worker before the `Game` precisely so the install survives a machine where
 * the scene throws. A branch that cannot execute on any browser that can run
 * this game is a branch nothing will ever exercise, so it would rot.
 */
import {
  Color4,
  DynamicTexture,
  GPUParticleSystem,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import type { ParticleSpec } from "../world/environment";

/**
 * How long a mote lives. Named because the pool is sized against the upper
 * bound: in emit-rate-controlled mode the system settles at
 * `emitRate * maxLifeTime` live slots.
 */
const MIN_LIFE = 6;
const MAX_LIFE = 14;

/**
 * Drifting motes filling the volume of the current room — spores, falling
 * ash, rising embers. It is what makes a big dark arena feel like it has air
 * in it rather than being a vacuum with walls, and at the ~650 motes the CPU
 * pool could hold it read as specks in the air rather than as air.
 *
 * One system is reused across rooms; the per-theme spec is re-applied on
 * every room build and the emitter box is resized to the new arena.
 */
export class Atmosphere {
  private system: GPUParticleSystem | null = null;
  private texture: DynamicTexture;

  constructor(private scene: Scene) {
    // Soft round mote, generated so the game still ships no image files.
    const size = 64;
    this.texture = new DynamicTexture(
      "mote",
      { width: size, height: size },
      scene,
      false,
    );
    const ctx = this.texture.getContext();
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.4, "rgba(255,255,255,0.55)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    this.texture.update();
    this.texture.hasAlpha = true;
  }

  /**
   * Builds the emitter on first use.
   *
   * `emitRateControl` is not a detail. In that mode the system holds
   * `emitRate * maxLifeTime` live slots and recycles them in a circular
   * buffer, which is the CPU class's own behaviour — and, load-bearingly, it
   * is the only mode in which a stopped system stops accumulating emissions.
   * Babylon's legacy GPU mode adds to the emit accumulator whether or not the
   * system is stopped, so `stop()` + `reset()` would empty the field and then
   * refill it over the next second. That pair is how a headless harness pins
   * the ash for a stable pixel diff (see `CLAUDE.md`), so the freeze has to
   * keep working: with emit-rate control the field goes empty and stays
   * empty, exactly as it did on the CPU path.
   */
  private build(): GPUParticleSystem {
    const ps = new GPUParticleSystem(
      "motes",
      { capacity: CONFIG.graphics.particlePoolSize, emitRateControl: true },
      this.scene,
    );
    ps.particleTexture = this.texture;
    ps.emitter = Vector3.Zero();
    return ps;
  }

  /**
   * Rebuilds the mote field for a room; `undefined` disables it.
   *
   * **The live slot count only ever grows.** Babylon adds slots as the field
   * ramps up and drops them only on `reset()`, so a sparser spec applied
   * after a denser one — a second map, or `undefined` — emits at the new rate
   * but goes on stepping the old buffer. It costs vertex work and shows
   * nothing: a slot with no live particle is culled to a degenerate position.
   * Resetting here instead would be worse, because it empties the sky and
   * refills it over `MAX_LIFE` seconds on every editor rebuild, which is what
   * `installMap` does on each keystroke. If a second map ever makes that cost
   * real, reset on a *decrease* only.
   */
  apply(spec: ParticleSpec | undefined, width: number, depth: number): void {
    if (!spec) {
      this.system?.stop();
      return;
    }

    this.system ??= this.build();
    const ps = this.system;

    const hx = width / 2 - 1;
    const hz = depth / 2 - 1;
    ps.minEmitBox = new Vector3(-hx, 0.2, -hz);
    ps.maxEmitBox = new Vector3(hx, 11, hz);

    const c = Color4.FromHexString(spec.color.padEnd(9, "f"));
    ps.color1 = new Color4(c.r, c.g, c.b, spec.emissive ? 0.85 : 0.5);
    ps.color2 = new Color4(c.r * 0.7, c.g * 0.7, c.b * 0.7, 0.3);
    ps.colorDead = new Color4(c.r, c.g, c.b, 0);

    ps.minSize = spec.size * 0.6;
    ps.maxSize = spec.size * 1.8;
    ps.minLifeTime = MIN_LIFE;
    ps.maxLifeTime = MAX_LIFE;
    // `count` is motes in the air, not a raw cap: a mote lives ~10 s on
    // average, so a third of it per second is what holds that many aloft.
    ps.emitRate = spec.count / 3;
    warnIfPoolClamped(ps.emitRate);
    // Embers add into the dark; ash and dust just occlude. The constants are
    // BaseParticleSystem's, so they are read off the GPU class rather than
    // off `ParticleSystem` — naming the CPU class for two integers is what
    // would drag the whole CPU particle system back into the bundle.
    ps.blendMode = spec.emissive
      ? GPUParticleSystem.BLENDMODE_ADD
      : GPUParticleSystem.BLENDMODE_STANDARD;

    // Slow lateral drift plus the theme's vertical motion.
    const rise = spec.riseSpeed;
    ps.direction1 = new Vector3(-0.35, rise * 0.6, -0.35);
    ps.direction2 = new Vector3(0.35, rise * 1.4, 0.35);
    ps.gravity = new Vector3(0, rise * 0.15, 0);
    ps.minEmitPower = 0.2;
    ps.maxEmitPower = 0.6;
    ps.updateSpeed = 0.012;

    ps.start();
  }

  dispose(): void {
    this.system?.dispose();
    this.system = null;
    this.texture.dispose();
  }
}

/**
 * A map asking for more motes than the pool holds is clamped, and the clamp is
 * silent in a way that does not look like a clamp.
 *
 * Babylon bounds the live SLOT count to the pool and leaves the emit rate
 * alone. Emit-rate control sizes the buffer at `emitRate * MAX_LIFE` precisely
 * so the circular write pointer takes a full `MAX_LIFE` to come round — which
 * is what guarantees no live mote is ever recycled out from under itself.
 * Clamp the slots without clamping the rate and that wrap period falls below
 * `MAX_LIFE`, so the longest-lived motes are re-emitted while still visible.
 * The symptom is motes POPPING OUT rather than a thinner field, and nothing
 * about it points at the pool.
 *
 * Clamping `emitRate` to match would preserve the wrap and is the worse fix:
 * it keeps the field looking correct while quietly overriding the density the
 * map asked for. Say so instead, and let whoever wrote the number decide.
 */
function warnIfPoolClamped(emitRate: number): void {
  if (!import.meta.env.DEV) return;
  const pool = CONFIG.graphics.particlePoolSize;
  const wanted = Math.ceil(emitRate * MAX_LIFE);
  if (wanted <= pool) return;
  console.warn(
    `Atmosphere: the mote field wants ${wanted} slots and the pool holds ` +
      `${pool}. Motes will be recycled after ${(pool / emitRate).toFixed(1)} s ` +
      `against a ${MAX_LIFE} s maximum life, so the longest-lived ones will ` +
      `pop out instead of fading. Lower the map's ParticleSpec.count (below ` +
      `${Math.floor((pool / MAX_LIFE) * 3)}) or raise ` +
      `CONFIG.graphics.particlePoolSize.`,
  );
}
