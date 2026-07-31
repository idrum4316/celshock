/**
 * editor/workLight.ts — A brightened copy of a map's environment, for authoring.
 * Owns: the work-light EnvironmentSpec transform, nothing else.
 *
 * Hollowmere is a night map: fog closes at 78 m, ambient is a dim blue, and
 * most of what you see is silhouette. That is the point in play and useless for
 * building — you cannot judge a roofline you cannot see, and half the map is
 * past the fog wall.
 *
 * So the editor can push the lights up. This is a pure spec transform, applied
 * with `applyEnvironment`, which only writes shader uniforms and the clear
 * colour — idempotent and cheap enough to toggle per keypress with no rebuild.
 *
 * Two fields are deliberately NOT touched: `floorColor` and `wallColor` are
 * baked into the ground and ridge materials by MapBuilder.buildValley, so
 * changing them would need a full map rebuild to take effect. Everything the
 * work light does is uniform-only.
 */
import type { EnvironmentSpec } from "../world/environment";

/**
 * A daylit take on `env`: key light up and neutralised, ambient lifted well
 * clear of black, mist off, and the fog pushed out past the map's diagonal so
 * nothing is hidden. Structure and palette are otherwise the map's own, so
 * colours still read the way they will in play.
 */
export function workLightEnvironment(env: EnvironmentSpec): EnvironmentSpec {
  return {
    ...env,
    fogStart: 260,
    fogEnd: 420,
    mistStrength: 0,
    skyColor: "#2a3340",
    lighting: {
      ...env.lighting,
      color: "#fff4e0",
      intensity: 1.15,
      ambientColor: "#8f9aa8",
      ambientIntensity: 0.85,
      rimIntensity: env.lighting.rimIntensity * 0.5,
    },
  };
}
