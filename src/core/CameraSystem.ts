/**
 * CameraSystem.ts — First-person camera: aim yaw/pitch, ADS blend (FOV +
 * sensitivity), recoil, per-shot view punch, head bob.
 * Owns: the scene's active camera. The camera sits AT the player's eye — it
 * never leaves the head, so there is no occlusion pick and no pull-in.
 * How far ADS zooms, how much it slows the look, and how fast it gets there
 * all belong to the LOADOUT (`setLoadout`), not to CONFIG.camera — the
 * camera's own numbers are the hip-fire ones. Zoom and sensitivity are the
 * optic's alone; only the blend RATE is shared with the weapon, because how
 * fast a sight comes up is a fact about the weight in your hands as well as
 * about the glass on top of it.
 * Invariants: recoil decay uses true Math.exp(-rate*dt) — NOT the frame-lerp
 * idiom — because burst climb must not vary with frame rate. Recoil only
 * partly springs back (CONFIG.recoil.recoverFraction); the rest is pushed into
 * the player's aim permanently — a deliberate product decision, not a bug.
 * The view punch (FOV spike / camera shove / jitter), the head bob and the
 * landing absorb are pure cosmetics: they are applied only to the rendered
 * camera, never to aimPitch/aimYaw, so bullets and bots never see them.
 * The aimed hold sway is the ONE exception, and deliberately so: it is part of
 * aimPitch/aimYaw, because the weapon hangs off this camera and a sight
 * picture that drifts while the rounds fly down an undrifted axis is a reticle
 * that lies. See CONFIG.camera.aimSway.
 * The landing absorb is a damped spring this system owns and the viewmodel
 * READS (`landDip`) — one integrator per impact, the same rule as the bob
 * phase. It is also the only thing that writes the camera's roll.
 * Must run before mats.updateCamera()/lighting.update()/sfx.setListener()
 * in Game's frame order.
 */
import { FreeCamera, Scene, Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";
import {
  DEFAULT_SIGHT,
  sightSetup,
  type SightId,
  type SightSetup,
} from "../entities/sights";
import { DEFAULT_WEAPON, weaponSetup, type WeaponId } from "../entities/weapons";
import type { InputManager } from "./InputManager";

/**
 * First-person camera. Aiming down sights brings the weapon's sight onto the
 * camera axis (ViewModel's job) while this system zooms the FOV, slows the
 * look, and damps the bob — one blend drives all three so the transition
 * reads as a single motion.
 */
export class CameraSystem {
  readonly camera: FreeCamera;
  yaw = 0;
  pitch = 0.12;
  /** 0 = hip, 1 = fully aimed (ADS). */
  adsBlend = 0;

  /**
   * The fitted optic's resolved numbers: aimed FOV, look multipliers, and how
   * fast the blend converges. Everything ADS does about zoom comes from here
   * rather than from CONFIG.camera, so a loadout change is one assignment.
   */
  private sight: SightSetup = sightSetup(DEFAULT_SIGHT);
  /**
   * The carried weapon's share of the ADS blend rate. How fast a sight comes
   * up is the optic's `adsSpeedMult` times this — a scope is slow on either
   * weapon, and either weapon raises the same scope at its own pace. Nothing
   * else about the gun reaches the camera.
   */
  private weaponAdsMult = weaponSetup(DEFAULT_WEAPON).adsSpeedMult;
  /** The carried weapon's steadiness in the hands, scaling the hold sway. */
  private weaponSwayMult = weaponSetup(DEFAULT_WEAPON).swayMult;

  /**
   * Head-bob phase, in radians, advanced by travel rather than by time.
   * Public because the viewmodel bobs on the SAME phase — two integrators fed
   * the same drive would drift apart and the weapon would swim against the
   * view. ViewModel reads it one frame late (Player updates before the
   * camera does), which is 16 ms of a 0.8 s cycle.
   */
  bobPhase = 0;
  /** Smoothed 0..1 movement drive for the bob, pushed by Player each frame. */
  private bobAmount = 0;
  private bobTarget = 0;

  /**
   * The springy part of the recoil, stacked on top of the player's own aim
   * and decaying back to zero. The rest of each kick goes straight into
   * `pitch`/`yaw` and stays there — see `addRecoil`.
   */
  private recoilPitch = 0;
  private recoilYaw = 0;
  /**
   * View punch, 1 at the shot and falling to 0 over `recoil.punchTime`.
   * Squared before use so the spike is at the impact frame.
   */
  private punchT = 0;

  /**
   * The aimed hold sway: this frame's offsets, and the free-running breath
   * phase they are drawn from. Part of the AIM (see the header) — the weapon
   * wanders and the rounds wander with it.
   *
   * The phase runs whether or not anything is aiming, so bringing a sight up
   * does not restart the same wander from the same place every time; it wraps
   * at 4pi rather than at 2pi because the slowest term runs at half rate, and
   * every term's multiplier is a half-integer so all four are continuous
   * across the wrap.
   */
  private swayPhase = 0;
  private swayPitch = 0;
  private swayYaw = 0;
  /** Eased weight from the player's stance, 1 = standing still. */
  private swayAmount = 1;
  private swayTarget = 1;

  /**
   * The landing absorb: how far the eye has sunk into a touchdown, in metres
   * and never positive until the recovery overshoots. A damped spring rather
   * than a decaying pulse, because knees are one — it is given a downward
   * VELOCITY at the impact and finds its own way back, so the dip has weight
   * on the way in and a small rebound on the way out instead of a sawtooth.
   *
   * Public because the weapon rides a share of it (`ViewModel`). One
   * integrator, read by both — the same rule the bob phase follows, and for
   * the same reason: two springs on one impact drift apart and the gun swims
   * against the view.
   */
  landDip = 0;
  private landVel = 0;

  /** Scratch for the rendered camera position — no per-frame allocation. */
  private readonly eye = new Vector3();

  constructor(scene: Scene) {
    this.camera = new FreeCamera("mainCamera", new Vector3(0, 3, -8), scene);
    this.camera.minZ = 0.05;
    this.camera.fov = CONFIG.camera.fovHip;
    this.camera.inputs.clear(); // fully driven by this system
    // The roll (`rotation.z`, written by the landing absorb) reaches the view
    // matrix only through the camera's UP VECTOR, and Babylon otherwise keeps
    // that vector as state refreshed on the frames `rotation.z` *changes*.
    // Since the refresh bakes the yaw and pitch of that frame in with the
    // roll, the frame a landing settles on leaves a stale up vector standing
    // for the rest of the round: the tilt is zero where it was settled and
    // grows with every degree you turn away from it. This derives the up
    // vector from `rotation` every frame instead, which is what the flag is
    // for. Never remove it while anything writes roll.
    this.camera.updateUpVectorFromRotation = true;
    scene.activeCamera = this.camera;
  }

  /** Takes the whole loadout. Cheap enough to call on every change. */
  setLoadout(weapon: WeaponId, sight: SightId): void {
    this.sight = sightSetup(sight);
    const w = weaponSetup(weapon);
    this.weaponAdsMult = w.adsSpeedMult;
    this.weaponSwayMult = w.swayMult;
  }

  /**
   * Where the weapon is actually pointed: the player's aim, plus recoil, plus
   * the hold sway. Everything downstream — the shot, the aim assist, the
   * damage arcs — reads the aim through here, so the sway is honest by
   * construction rather than by anyone remembering to add it.
   */
  get aimPitch(): number {
    return this.pitch + this.recoilPitch + this.swayPitch;
  }

  get aimYaw(): number {
    return this.yaw + this.recoilYaw + this.swayYaw;
  }

  /** World-space aim direction (through the crosshair). */
  get forward(): Vector3 {
    const cp = Math.cos(this.aimPitch);
    return new Vector3(
      cp * Math.sin(this.aimYaw),
      Math.sin(this.aimPitch),
      cp * Math.cos(this.aimYaw),
    );
  }

  /** Yaw-only forward, for movement on the ground plane. Deliberately the
   * un-recoiled yaw: strafing must not swim while the gun is kicking. */
  get flatForward(): Vector3 {
    return new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  get flatRight(): Vector3 {
    return new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = 0.12;
    this.adsBlend = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.punchT = 0;
    // The phase deliberately survives a respawn — it is a body breathing, not
    // a round starting, and restarting it would put every life's first aimed
    // shot at the same point of the same wander.
    this.swayPitch = 0;
    this.swayYaw = 0;
    this.swayAmount = 1;
    this.swayTarget = 1;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.bobTarget = 0;
    this.landDip = 0;
    this.landVel = 0;
  }

  /**
   * Absorbs a landing; called by Player with the speed the feet arrived at.
   * Scaled across the fall speeds that count as one at all, so stepping off a
   * kerb bends nothing and a drop off the chapel terrace bends everything.
   *
   * The impact sets a downward velocity rather than a displacement — a leg
   * that is already loaded does not reset when it takes a second hit — and the
   * hardest of two impacts in the same breath wins rather than summing, so a
   * bounce down a flight of steps cannot dig the eye through the floor.
   */
  land(speed: number): void {
    const l = CONFIG.camera.land;
    const t = Math.min(1, (speed - l.minSpeed) / (l.fullSpeed - l.minSpeed));
    if (t <= 0) return;
    this.landVel = Math.min(this.landVel, -l.dipSpeed * t);
  }

  /**
   * This frame's bob drive: 0 standing, 1 at full ground speed. Pushed by
   * Player (which owns the movement) before the camera updates; airborne is
   * simply zero, because feet that aren't on the ground aren't striding.
   */
  setBobDrive(speed01: number, grounded: boolean): void {
    this.bobTarget = grounded ? Math.max(0, Math.min(1, speed01)) : 0;
  }

  /**
   * How steady the player is standing, as a multiplier on the hold sway: 1 is
   * standing still, above it is moving, below it is crouched. Pushed by Player
   * (which owns the stance) for the same reason the bob drive is — the stance
   * blends are movement's, and the camera has no business re-deriving them.
   * Eased here rather than there, because it is this system's offset.
   */
  setSwayDrive(steadiness: number): void {
    this.swayTarget = Math.max(0, steadiness);
  }

  /**
   * Fires the cosmetic view punch; called once per shot. Unlike `addRecoil`
   * this touches nothing the bullets read — it is FOV, a small backward
   * shove, and high-frequency jitter on the rendered camera only.
   */
  addPunch(): void {
    this.punchT = 1;
  }

  /**
   * Kicks the aim; called once per shot fired. Each kick is split: most of it
   * springs back on its own, but `1 - recoverFraction` of it is added to the
   * player's own aim and never comes back, which is what actually walks the
   * muzzle off target over a long burst. The permanent part moves `yaw` too,
   * so the character turns with it — the same as any other look input.
   */
  addRecoil(pitch: number, yaw: number): void {
    const r = CONFIG.recoil;
    const keep = 1 - r.recoverFraction;
    this.pitch += pitch * keep;
    this.yaw += yaw * keep;
    this.recoilPitch = Math.min(
      r.maxPitch,
      this.recoilPitch + pitch * r.recoverFraction,
    );
    this.recoilYaw = Math.max(
      -r.maxYaw,
      Math.min(r.maxYaw, this.recoilYaw + yaw * r.recoverFraction),
    );
  }

  /**
   * `eyePos` is the player's eye in world space — the camera goes there
   * outright, offset only by the cosmetic bob and punch.
   *
   * `assist` is the gamepad aim-assist frame from `AimAssistSystem` (null
   * when inactive). Its slowdown is multiplied into the stick terms ONLY —
   * the mouse look path is deliberately never scaled — and its rotation is
   * applied on top of the player's own input, then clamped like any other.
   */
  update(
    dt: number,
    input: InputManager,
    eyePos: Vector3,
    assist: { stickMult: number; yaw: number; pitch: number } | null = null,
  ): void {
    const c = CONFIG.camera;

    // --- look ---
    const aiming = this.adsBlend > 0.5;
    const mouseMult = aiming ? this.sight.mouseMult : 1;
    const stickMult = aiming ? this.sight.stickMult : 1;
    const assistMult = assist ? assist.stickMult : 1;
    this.yaw += input.mouseLookX * c.sensX * mouseMult;
    this.pitch -= input.mouseLookY * c.sensY * mouseMult;
    this.yaw += input.stickLookX * c.stickSensX * stickMult * assistMult * dt;
    this.pitch -= input.stickLookY * c.stickSensY * stickMult * assistMult * dt;
    if (assist) {
      this.yaw += assist.yaw;
      this.pitch += assist.pitch;
    }
    this.pitch = Math.max(c.pitchMin, Math.min(c.pitchMax, this.pitch));

    // --- recoil settles back toward the player's own aim ---
    // A true exponential, not the frame-lerp used for the cosmetic blends:
    // this one moves where the bullets go, so how high a burst climbs must
    // not depend on the frame rate.
    const settle = Math.exp(-CONFIG.recoil.recovery * dt);
    this.recoilPitch *= settle;
    this.recoilYaw *= settle;

    // --- view punch decays (cosmetic — safe to use a plain time decay) ---
    this.punchT = Math.max(0, this.punchT - dt / CONFIG.recoil.punchTime);

    // --- landing absorb settles (semi-implicit Euler on a damped spring) ---
    // Velocity first, then position off the NEW velocity. The other way round
    // is explicit Euler, which gains energy every step and rings instead of
    // settling — on a spring the eye sits in, that is nausea. dt is
    // clamped to 0.05 upstream, which keeps `omega * dt` well inside stability
    // at these frequencies.
    const l = CONFIG.camera.land;
    if (this.landDip !== 0 || this.landVel !== 0) {
      const w = Math.PI * 2 * l.frequency;
      this.landVel +=
        (-w * w * this.landDip - 2 * l.damping * w * this.landVel) * dt;
      this.landDip += this.landVel * dt;
      // Park it exactly, so the eye and the weapon both stop reading a
      // micrometre of sag for the rest of the round.
      if (Math.abs(this.landDip) < 1e-4 && Math.abs(this.landVel) < 1e-3) {
        this.landDip = 0;
        this.landVel = 0;
      }
    }

    // --- ADS blend (exponential ease toward target) ---
    const target = input.ads ? 1 : 0;
    this.adsBlend +=
      (target - this.adsBlend) *
      Math.min(1, dt * this.sight.blendSpeed * this.weaponAdsMult);
    const t = smoothstep(this.adsBlend);

    // --- hold sway: the wander of an aimed weapon ---
    // Two sines per axis. The pitch term is the breath and the yaw term runs
    // at half its rate, which is what draws the slow figure-eight instead of a
    // diagonal; the smaller pair, at 2.5x and 3.5x the breath, is what keeps
    // it from reading as a machine tracing the same loop. Every multiplier is
    // a half-integer of the phase, so all four are continuous where it wraps.
    //
    // It is scaled by the ADS blend, so it eases in with the sight and hip
    // fire is left exactly as it was. This is an offset ON TOP of the player's
    // aim, never integrated into `pitch`/`yaw`: it has to average out to where
    // they were pointing, or a held aim would simply drift away.
    const sw = c.aimSway;
    this.swayAmount +=
      (this.swayTarget - this.swayAmount) * Math.min(1, dt * sw.smooth);
    this.swayPhase =
      (this.swayPhase + Math.PI * 2 * sw.rate * dt) % (Math.PI * 4);
    const b = this.swayPhase;
    const swayW = t * this.swayAmount * this.weaponSwayMult;
    this.swayPitch =
      sw.pitch * (Math.sin(b) + 0.28 * Math.sin(b * 2.5 + 0.6)) * swayW;
    this.swayYaw =
      sw.yaw * (Math.sin(b * 0.5 + 1) + 0.22 * Math.sin(b * 3.5 + 2.4)) * swayW;

    // --- head bob: phase advances with travel, amplitude eases with intent ---
    this.bobAmount +=
      (this.bobTarget - this.bobAmount) * Math.min(1, dt * c.bobSmooth);
    this.bobPhase = (this.bobPhase + dt * c.bobRate * this.bobAmount) % (Math.PI * 2);
    const bobW = this.bobAmount * (1 - (1 - c.bobAdsMult) * t);

    // --- position: the eye, plus the two cosmetic offsets ---
    const dir = this.forward;
    this.eye.copyFrom(eyePos);
    if (bobW > 0.001) {
      // Vertical at twice the lateral rate: one dip per footfall, one sway
      // per stride. The lateral term rides the flat right axis so it stays
      // level with the horizon when looking up or down.
      const right = this.flatRight;
      this.eye.y += Math.sin(this.bobPhase * 2) * c.bobVertical * bobW;
      this.eye.addInPlace(
        right.scale(Math.sin(this.bobPhase) * c.bobLateral * bobW),
      );
    }
    // The eye sinks with the knees. Translation only — a metre of drop is a
    // metre of parallax and nothing else, so the bullets are untouched.
    this.eye.y += this.landDip;
    const r = CONFIG.recoil;
    const punch = this.punchT * this.punchT;
    if (punch > 0) {
      this.eye.subtractInPlace(dir.scale(r.camPush * punch));
    }

    // The nod and the roll are what make the absorb read as a body arriving
    // rather than as the floor moving: the chin drops toward the impact and
    // the weight comes down on one side. Both are damped while aiming, the
    // same bargain the bob makes — a braced shooter absorbs with the legs, and
    // it is only the ROTATIONAL part that swings the picture off the rounds
    // (which fly along the un-nodded `forward`, like every other cosmetic
    // here). The dip itself is left alone; knees bend whether or not you are
    // looking through a sight.
    const swing = this.landDip * (1 - (1 - l.adsMult) * t);
    const nod = swing * l.nod;

    this.camera.position.copyFrom(this.eye);
    if (punch > 0 || nod !== 0) {
      const shPitch = punch > 0 ? (Math.random() * 2 - 1) * r.shakePitch * punch : 0;
      const shYaw = punch > 0 ? (Math.random() * 2 - 1) * r.shakeYaw * punch : 0;
      const sp = this.aimPitch + shPitch + nod;
      const sy = this.aimYaw + shYaw;
      const cp = Math.cos(sp);
      this.camera.setTarget(
        this.eye.add(
          new Vector3(cp * Math.sin(sy), Math.sin(sp), cp * Math.cos(sy)),
        ),
      );
    } else {
      this.camera.setTarget(this.eye.add(dir));
    }
    // Roll goes on AFTER the target: `setTarget` writes yaw and pitch out of
    // the direction and never touches z, so this is the one axis the camera
    // keeps of its own. It is also the only place anything writes it.
    this.camera.rotation.z = swing * l.roll;
    this.camera.fov =
      c.fovHip + (this.sight.fovAds - c.fovHip) * t + r.fovPunch * punch;
  }
}

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}
