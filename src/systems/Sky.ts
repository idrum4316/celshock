/**
 * Sky.ts — Procedural night sky: baked dome texture (gradient/stars/halo),
 * moon, scrolling cloud layers. All unlit emissive meshes, infiniteDistance,
 * unpickable; moon bloom via the GlowLayer.
 * Invariants: moonDir is negated to align with the shader's light direction;
 * the moon renders in a later renderingGroup than the dome. Rebuilt from an
 * EnvironmentSpec via apply() — keep it data-driven, no Hollowmere specifics.
 */
import {
  Color3,
  DynamicTexture,
  GlowLayer,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Texture,
  Vector3,
} from "@babylonjs/core";
import { CONFIG } from "../config";
import type { EnvironmentSpec, SkySpec } from "../world/environment";

/**
 * The night sky: a gradient dome with the stars and the moon's halo baked
 * into a generated texture, an emissive moon disc that feeds the GlowLayer,
 * and cloud banks on sphere shells just inside the dome, scrolling azimuthally.
 * Everything is painted at runtime — the game ships no image files — and
 * nothing here is lit: the scene has no Babylon lights, so sky materials
 * are unlit emissive by construction.
 *
 * Every sky mesh uses `infiniteDistance` (it rides with the camera, so the
 * horizon never gets closer and the clouds are always overhead) and stays
 * outside the pick/collide contract: no `solid` metadata, `isPickable =
 * false`, `noOutline`. These meshes are built after Game's constructor-time
 * GlowLayer scan, so the pieces that must NOT bloom (dome, clouds — a
 * full-screen gradient would haze the frame) are excluded directly, the
 * WaterSystem way. The moon keeps its bloom on purpose.
 *
 * The moon sits opposite the key light's direction (`lighting.direction`),
 * so the disc always agrees with the shadows the cel shader paints. Its
 * halo is drawn into the dome texture at the matching uv, which the sphere
 * builder guarantees: v = 1 - acos(y)/PI from the zenith, u = atan2(-z, x)
 * around the horizon, and DynamicTexture uploads flip Y, so canvas row 0 is
 * v = 1.
 */
export class Sky {
  private disposables: { dispose(): void }[] = [];
  private cloudTextures: DynamicTexture[] = [];
  private cloudSpeeds: number[] = [];

  constructor(
    private scene: Scene,
    private glow: GlowLayer,
  ) {
    // Rendering groups above 0 clear the depth buffer by default (the
    // classic FPS-viewmodel trick). The sky lives in group 1 so the moon
    // draws over the dome, but it must still respect the WORLD's depth —
    // without this the moon and clouds render through players and walls.
    scene.setRenderingAutoClearDepthStencil(1, false);
  }

  /** Rebuilds the sky for a map's environment; a missing `sky` spec clears it. */
  apply(env: EnvironmentSpec): void {
    this.clear();
    const spec = env.sky;
    if (!spec) return;

    const cfg = CONFIG.sky;
    // The source the key light falls from — the moon's seat in the dome.
    const moonDir = Vector3.FromArray(env.lighting.direction)
      .normalize()
      .negate();

    // --- dome: gradient + stars + baked halo, one draw ---
    const domeMat = new StandardMaterial("sky-dome-mat", this.scene);
    domeMat.emissiveTexture = this.paintDomeTexture(spec, env, moonDir);
    domeMat.disableLighting = true;
    domeMat.diffuseColor = Color3.Black();
    domeMat.specularColor = Color3.Black();
    domeMat.disableDepthWrite = true;
    const dome = MeshBuilder.CreateSphere(
      "sky-dome",
      {
        diameter: cfg.domeRadius * 2,
        segments: 24,
        sideOrientation: Mesh.BACKSIDE,
      },
      this.scene,
    );
    dome.material = domeMat;
    this.prepare(dome, true);
    this.disposables.push(domeMat, domeMat.emissiveTexture!);

    // --- moon: emissive disc, deliberately left inside the GlowLayer ---
    const moonMat = new StandardMaterial("sky-moon-mat", this.scene);
    moonMat.emissiveColor = Color3.FromHexString(spec.moonColor).scale(
      cfg.moonEmissiveBoost,
    );
    moonMat.disableLighting = true;
    moonMat.diffuseColor = Color3.Black();
    moonMat.specularColor = Color3.Black();
    moonMat.disableDepthWrite = true;
    const moon = MeshBuilder.CreateDisc(
      "sky-moon",
      { radius: cfg.moonRadius, tessellation: 48 },
      this.scene,
    );
    moon.position.copyFrom(moonDir.scale(cfg.moonDistance));
    // Billboard, not lookAt: the disc must face the camera dead-on from
    // everywhere on the map, and with infiniteDistance it rides with it.
    moon.billboardMode = Mesh.BILLBOARDMODE_ALL;
    moon.material = moonMat;
    moon.renderingGroupId = 1; // after the dome, so depth can't drop it
    this.prepare(moon, false);
    this.disposables.push(moonMat);

    // --- cloud banks: sphere shells just inside the dome, so there are no
    // edges anywhere. Transparent, so they veil the moon on their own. ---
    for (const layer of cfg.cloudLayers) {
      const cloudTex = this.paintCloudTexture();
      cloudTex.uScale = layer.uScale; // azimuthal repeat: smaller, busier blobs
      const cloudMat = new StandardMaterial("sky-cloud-mat", this.scene);
      cloudMat.emissiveTexture = cloudTex;
      cloudMat.opacityTexture = cloudTex;
      cloudMat.emissiveColor = Color3.FromHexString(spec.cloudColor);
      cloudMat.alpha = spec.cloudOpacity * layer.opacity;
      cloudMat.disableLighting = true;
      cloudMat.diffuseColor = Color3.Black();
      cloudMat.specularColor = Color3.Black();
      cloudMat.disableDepthWrite = true;
      const cloud = MeshBuilder.CreateSphere(
        "sky-cloud",
        {
          diameter: (cfg.domeRadius - layer.radiusOffset) * 2,
          segments: 24,
          sideOrientation: Mesh.BACKSIDE,
        },
        this.scene,
      );
      cloud.material = cloudMat;
      cloud.renderingGroupId = 1;
      this.prepare(cloud, true);
      this.disposables.push(cloudMat, cloudTex);
      this.cloudTextures.push(cloudTex);
      this.cloudSpeeds.push(layer.speedU);
    }
  }

  /** Scrolls the cloud banks azimuthally. Runs in every game state. */
  update(dt: number): void {
    for (let i = 0; i < this.cloudTextures.length; i++) {
      this.cloudTextures[i].uOffset += this.cloudSpeeds[i] * dt;
    }
  }

  private clear(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.cloudTextures.length = 0;
    this.cloudSpeeds.length = 0;
  }

  /**
   * Tags a sky mesh out of every scene contract and parks it at infinite
   * distance. `excludeGlow` is for the pieces whose emissive fill must not
   * bloom (dome, clouds); the moon passes false so the GlowLayer haloes it.
   */
  private prepare(mesh: Mesh, excludeGlow: boolean): void {
    mesh.infiniteDistance = true;
    mesh.isPickable = false;
    // noGlow only where true — the moon keeps its bloom, so it must not
    // claim the flag (the contract reads it as "excluded from the GlowLayer").
    mesh.metadata = excludeGlow
      ? { noOutline: true, noGlow: true }
      : { noOutline: true };
    if (excludeGlow) this.glow.addExcludedMesh(mesh);
    this.disposables.push(mesh);
  }

  /**
   * Paints the dome: zenith-to-horizon gradient, the star field (fading
   * toward the horizon), and the moon's halo at the uv the sphere builder
   * maps to the key light's source direction.
   */
  private paintDomeTexture(
    spec: SkySpec,
    env: EnvironmentSpec,
    moonDir: Vector3,
  ): DynamicTexture {
    const cfg = CONFIG.sky;
    const w = cfg.domeTextureWidth;
    const h = cfg.domeTextureHeight;
    const tex = new DynamicTexture(
      "sky-dome-tex",
      { width: w, height: h },
      this.scene,
      true,
    );
    const ctx = tex.getContext();

    // Gradient — canvas row 0 is v=1 (the zenith), row h/2 is the horizon.
    // The bright band peaks at row ~0.43h, about 12 deg ABOVE the horizon,
    // because the valley ridge hides the lowest ~10 deg from anywhere on the
    // ground: a band centred on the horizon line itself would never be seen.
    // Below the horizon the dome fades to the fog colour, so the gap between
    // the ridge and the dome reads as more fog.
    const zenith = spec.zenithColor;
    const horizon = spec.horizonColor;
    const fog = env.fogColor;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, zenith);
    grad.addColorStop(0.28, mixHex(zenith, horizon, 0.5));
    grad.addColorStop(0.43, horizon);
    grad.addColorStop(0.5, mixHex(horizon, fog, 0.6));
    grad.addColorStop(0.58, fog);
    grad.addColorStop(1, fog);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Stars: many dim, few bright, dissolving near the horizon murk.
    const star = Color3.FromHexString(spec.starColor);
    for (let i = 0; i < spec.starCount; i++) {
      const x = Math.random() * w;
      const v = 0.55 + Math.random() * 0.43; // clear of the horizon band
      const y = (1 - v) * h;
      const mag = Math.pow(Math.random(), 2.2);
      const altFade = 0.25 + 0.75 * Math.min(1, (v - 0.55) / 0.18);
      const alpha = spec.starBrightness * (0.25 + 0.75 * mag) * altFade;
      const r = 0.5 + mag * (cfg.starMaxSize - 0.5);
      ctx.fillStyle = rgba(star, alpha);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // The moon's halo, baked at the same uv the formulas in the class doc
    // derive from the light direction — the disc mesh floats over its glow.
    const mx =
      wrap01(Math.atan2(-moonDir.z, moonDir.x) / (Math.PI * 2)) * w;
    const my = (Math.acos(clamp(moonDir.y, -1, 1)) / Math.PI) * h;
    const moon = Color3.FromHexString(spec.moonColor);
    const halo = ctx.createRadialGradient(mx, my, 0, mx, my, cfg.haloRadiusPx);
    halo.addColorStop(0, rgba(moon, 0.55));
    halo.addColorStop(0.3, rgba(moon, 0.2));
    halo.addColorStop(1, rgba(moon, 0));
    ctx.fillStyle = halo;
    const hr = cfg.haloRadiusPx;
    ctx.fillRect(mx - hr, my - hr, hr * 2, hr * 2);

    tex.update();
    return tex;
  }

  /**
   * Paints a cloud mask for the shells: soft white blobs in the alpha
   * channel (the material's `cloudColor` supplies the tint), confined to a
   * latitude band — canvas rows 0.15..0.48, i.e. elevations ~4..63 deg.
   * Below that the ridge hides the sky anyway; above it the sphere's pole
   * pinch would smear the blobs. Band edges fade out so no ring shows, and
   * every blob is stamped at the horizontal wrap offsets so azimuthal
   * scrolling never shows a seam.
   */
  private paintCloudTexture(): DynamicTexture {
    const size = CONFIG.sky.cloudTextureSize;
    const tex = new DynamicTexture(
      "sky-cloud-tex",
      { width: size, height: size },
      this.scene,
      true,
    );
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, size, size);

    const yTop = 0.15 * size;
    const yBot = 0.48 * size;
    for (let i = 0; i < CONFIG.sky.cloudBlobs; i++) {
      const cx = Math.random() * size;
      const cy = yTop + Math.random() * (yBot - yTop);
      const t = (cy - yTop) / (yBot - yTop);
      const edgeFade = Math.min(1, Math.min(t, 1 - t) / 0.18);
      const r = size * (0.08 + Math.random() * 0.16);
      const a = (0.06 + Math.random() * 0.1) * edgeFade;
      for (const dx of [-size, 0, size]) {
        const g = ctx.createRadialGradient(cx + dx, cy, 0, cx + dx, cy, r);
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(cx + dx - r, cy - r, r * 2, r * 2);
      }
    }

    tex.update();
    tex.hasAlpha = true;
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    return tex;
  }

  dispose(): void {
    this.clear();
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function wrap01(x: number): number {
  return x - Math.floor(x);
}

function rgba(c: Color3, a: number): string {
  const r = Math.round(clamp(c.r, 0, 1) * 255);
  const g = Math.round(clamp(c.g, 0, 1) * 255);
  const b = Math.round(clamp(c.b, 0, 1) * 255);
  return `rgba(${r},${g},${b},${clamp(a, 0, 1)})`;
}

/** Linear blend between two hex colours, returned as a hex string. */
function mixHex(a: string, b: string, t: number): string {
  const ca = Color3.FromHexString(a);
  const cb = Color3.FromHexString(b);
  return Color3.Lerp(ca, cb, t).toHexString();
}
