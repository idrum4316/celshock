/**
 * HorrorPost.ts — Full-screen grade: vignette, corner desaturation, radial
 * chromatic aberration, animated grain, red damage flash.
 * Why hand-written: Babylon's image-processing pass re-gammas the cel shader's
 * already display-ready colors and washes the palette out — which is also why
 * pipeline.imageProcessingEnabled stays false. Keep the grade in this pass.
 */
import { Camera, Effect, PostProcess, Scene } from "@babylonjs/core";
import { CONFIG } from "../config";

/**
 * Full-screen horror grade applied after FXAA: a heavy vignette, corner
 * desaturation, radial chromatic aberration, animated film grain, and a red
 * flash driven by player damage.
 *
 * This is a hand-written pass rather than Babylon's image-processing block
 * because that block re-applies gamma to the cel shader's already
 * display-ready colors and washes the palette out.
 */
Effect.ShadersStore["horrorFragmentShader"] = `
precision highp float;

varying vec2 vUV;
uniform sampler2D textureSampler;

uniform float time;
uniform float vignette;
uniform float grain;
uniform float aberration;
uniform float damage;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec2 centered = vUV - 0.5;
  float r2 = dot(centered, centered);

  // Radial chromatic aberration — none at the crosshair, smeared at the edge.
  vec2 offset = centered * aberration * r2 * 0.09;
  vec3 col;
  col.r = texture2D(textureSampler, vUV + offset).r;
  col.g = texture2D(textureSampler, vUV).g;
  col.b = texture2D(textureSampler, vUV - offset).b;

  // Vignette: the corners fall away into the dark.
  col *= 1.0 - vignette * smoothstep(0.05, 0.62, r2);

  // Color drains toward the edges of vision.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum), clamp(r2 * 1.1, 0.0, 0.4));

  // Damage: blood pushes in from the border, but never closes over the
  // crosshair — the player still has to be able to fight while hurt.
  col = mix(col, vec3(0.42, 0.02, 0.03), damage * 0.8 * smoothstep(0.04, 0.42, r2));

  // Animated film grain, slightly stronger in the shadows.
  float n = hash(vUV * vec2(1024.0, 683.0) + fract(time) * 91.7);
  col += (n - 0.5) * grain * (1.3 - lum * 0.6);

  gl_FragColor = vec4(col, 1.0);
}
`;

export class HorrorPost {
  private post: PostProcess;
  private time = 0;
  private damage = 0;

  constructor(scene: Scene, camera: Camera) {
    const g = CONFIG.graphics;
    this.post = new PostProcess(
      "horror",
      "horror",
      ["time", "vignette", "grain", "aberration", "damage"],
      null,
      1.0,
      camera,
      undefined,
      scene.getEngine(),
    );
    this.post.onApply = (effect) => {
      effect.setFloat("time", this.time);
      effect.setFloat("vignette", g.vignette);
      effect.setFloat("grain", g.grain);
      effect.setFloat("aberration", g.aberration);
      effect.setFloat("damage", this.damage);
    };
  }

  /** Kicks the red edge flash; call when the player takes a hit. */
  flashDamage(): void {
    this.damage = CONFIG.graphics.damageFlash;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.damage > 0) {
      this.damage = Math.max(0, this.damage - dt * CONFIG.graphics.damageFlashDecay);
    }
  }
}
