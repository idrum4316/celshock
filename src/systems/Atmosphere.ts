import {
  Color4,
  DynamicTexture,
  ParticleSystem,
  Scene,
  Vector3,
} from "@babylonjs/core";
import type { ParticleSpec } from "../themes/types";

/**
 * Drifting motes filling the volume of the current room — spores, falling
 * ash, rising embers. Cheap, but it is what makes a big dark arena feel like
 * it has air in it rather than being a vacuum with walls.
 *
 * One system is reused across rooms; the per-theme spec is re-applied on
 * every room build and the emitter box is resized to the new arena.
 */
export class Atmosphere {
  private system: ParticleSystem | null = null;
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

  /** Rebuilds the mote field for a room; `undefined` disables it. */
  apply(spec: ParticleSpec | undefined, width: number, depth: number): void {
    if (!spec) {
      this.system?.stop();
      return;
    }

    if (!this.system) {
      this.system = new ParticleSystem("motes", 1200, this.scene);
      this.system.particleTexture = this.texture;
      this.system.emitter = Vector3.Zero();
    }
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
    ps.minLifeTime = 6;
    ps.maxLifeTime = 14;
    ps.emitRate = spec.count / 3;
    // Embers add into the dark; ash and dust just occlude.
    ps.blendMode = spec.emissive
      ? ParticleSystem.BLENDMODE_ADD
      : ParticleSystem.BLENDMODE_STANDARD;

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
