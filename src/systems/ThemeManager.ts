import { Color3, Color4, Scene, Vector3 } from "@babylonjs/core";
import { CyberpunkTheme } from "../themes/CyberpunkTheme";
import { DesertTheme } from "../themes/DesertTheme";
import { ForestTheme } from "../themes/ForestTheme";
import type { RoomTheme } from "../themes/types";
import type { CelMaterialFactory } from "../shaders/CelShader";

/**
 * Registry of room themes. Picks a random theme per room (avoiding immediate
 * repeats) and applies its environment (sky, fog, lighting) to the scene and
 * to every cel material — this is what keeps each room internally consistent.
 */
export class ThemeManager {
  readonly themes: RoomTheme[] = [ForestTheme, CyberpunkTheme, DesertTheme];
  private lastName = "";

  pick(): RoomTheme {
    const candidates = this.themes.filter((t) => t.name !== this.lastName);
    const theme = candidates[Math.floor(Math.random() * candidates.length)];
    this.lastName = theme.name;
    return theme;
  }

  apply(scene: Scene, theme: RoomTheme, mats: CelMaterialFactory): void {
    const env = theme.environment;

    const sky = Color3.FromHexString(env.skyColor);
    scene.clearColor = new Color4(sky.r, sky.g, sky.b, 1);

    const [dx, dy, dz] = env.lighting.direction;
    const lit = env.lighting;
    mats.setEnvironment({
      lightDir: new Vector3(dx, dy, dz),
      lightColor: Color3.FromHexString(lit.color).scale(lit.intensity),
      ambientColor: Color3.FromHexString(lit.ambientColor).scale(
        lit.ambientIntensity,
      ),
      rimColor: Color3.FromHexString(lit.rimColor).scale(lit.rimIntensity),
      fogColor: Color3.FromHexString(env.fogColor),
      fogStart: env.fogStart,
      fogEnd: env.fogEnd,
      mistColor: Color3.FromHexString(env.mistColor),
      mistHeight: env.mistHeight,
      mistStrength: env.mistStrength,
    });
  }
}
