/**
 * Sfx.ts — All audio: synthesized WebAudio, zero asset files.
 * Owns: the AudioContext, one cached noise buffer shared by every shot, voice
 * cap (CONFIG.audio.maxVoices — over-cap sounds are skipped silently), and
 * positional panning relative to the listener.
 * Invariants: never generate a fresh noise buffer per sound. setListener() is
 * called once per frame by Game, after the camera update. Firefox needs the
 * legacy setPosition/setOrientation path — keep both.
 */
import type { Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";

/**
 * Procedural sound effects via WebAudio — no audio assets.
 *
 * Three things here exist because of the jump from a twelve-enemy arena to a
 * thirty-two-bot battlefield:
 *
 * - **One cached noise buffer.** Filling a fresh `AudioBuffer` per shot meant
 *   ~1,900 `Math.random()` calls each time; with a full firefight that was
 *   hundreds of buffer allocations a second on the main thread. Now a single
 *   one-second buffer is generated on unlock and every burst plays a random
 *   slice of it.
 * - **Positional playback.** A distant firefight has to sit behind you rather
 *   than in your ear, so world-space sounds run through a `PannerNode` with
 *   distance rolloff and are dropped entirely past `maxDistance`.
 * - **A voice cap.** Sixteen bots at five rounds a second is ~80 gunshots
 *   a second. Beyond `maxVoices` concurrent one-shots, new ones are skipped —
 *   the ear cannot pick them apart anyway, and the scheduler can't keep up.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private listener: AudioListener | null = null;
  /** Reused by every `noise()` call; built once on unlock. */
  private noiseBuffer: AudioBuffer | null = null;
  /** Currently-playing one-shots, for the voice cap. */
  private voices = 0;

  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 1;
        this.master.connect(this.ctx.destination);
        this.listener = this.ctx.listener;
        this.buildNoiseBuffer();
      } catch {
        this.ctx = null;
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
  }

  /**
   * Points the audio listener at the camera. Called once per frame, after the
   * camera has moved — same ordering rule as the lighting and fog uniforms.
   */
  setListener(position: Vector3, forward: Vector3): void {
    const l = this.listener;
    if (!l || !this.ctx) return;
    const t = this.ctx.currentTime;
    // Firefox still only implements the deprecated setters.
    if (l.positionX) {
      l.positionX.setValueAtTime(position.x, t);
      l.positionY.setValueAtTime(position.y, t);
      l.positionZ.setValueAtTime(position.z, t);
      l.forwardX.setValueAtTime(forward.x, t);
      l.forwardY.setValueAtTime(forward.y, t);
      l.forwardZ.setValueAtTime(forward.z, t);
      l.upX.setValueAtTime(0, t);
      l.upY.setValueAtTime(1, t);
      l.upZ.setValueAtTime(0, t);
    } else {
      (l as unknown as { setPosition(x: number, y: number, z: number): void })
        .setPosition(position.x, position.y, position.z);
      (l as unknown as {
        setOrientation(...a: number[]): void;
      }).setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
    }
  }

  // --- player-local one-shots (always 2D, always audible) ---

  /**
   * The player's rifle. Four layers, because weight lives in the low end:
   * a low sine thump is the body, a descending square is the supersonic
   * crack, lowpass-swept noise is the boom tail, and a short bright noise
   * slice is the muzzle snap. Four voices per shot at 8 rps averages ~5
   * concurrent — affordable against the 24-voice cap.
   */
  shoot(): void {
    this.tone(120, 0.14, "sine", 0.3, 0.32);
    this.tone(1500, 0.045, "square", 0.1, 0.2);
    this.boom(0.16, 0.35);
    this.noise(0.03, 0.18);
  }

  /** Hitmarker: a chunky two-part "thock", not a beep. */
  hit(): void {
    this.tone(520, 0.05, "square", 0.07, 0.7);
    this.noise(0.025, 0.12);
  }

  enemyDie(): void {
    this.tone(300, 0.25, "sawtooth", 0.06, 0.3);
  }

  playerHurt(): void {
    this.tone(110, 0.2, "sawtooth", 0.08, 0.7);
  }

  reload(): void {
    this.tone(500, 0.05, "square", 0.04, 1);
    setTimeout(() => this.tone(650, 0.05, "square", 0.04, 1), 120);
  }

  pickup(): void {
    this.tone(700, 0.08, "sine", 0.07, 1.6);
  }

  jump(): void {
    this.tone(330, 0.08, "sine", 0.04, 1.6);
  }

  /** Flag captured. */
  capture(): void {
    this.tone(440, 0.12, "sine", 0.07, 1.5);
    setTimeout(() => this.tone(660, 0.18, "sine", 0.07, 1.2), 130);
  }

  /** Flag lost or neutralised — the same shape, falling instead of rising. */
  flagLost(): void {
    this.tone(520, 0.14, "sine", 0.06, 0.65);
    setTimeout(() => this.tone(340, 0.2, "sine", 0.06, 0.7), 130);
  }

  // --- world-space ---

  /**
   * A bot's rifle, somewhere out in the village. Cheap, spatialised, and the
   * first thing dropped when the voice budget runs out.
   */
  botShot(at: Vector3): void {
    const panner = this.panner(at);
    if (!panner) return;
    this.tone(190, 0.05, "square", 0.055, 0.45, panner);
    this.noise(0.035, 0.035, panner);
  }

  /**
   * A bot working its magazine. The player's own reload is flat and
   * front-and-centre; this one is spatialised, because knowing *which* of the
   * enemies in front of you has just gone dry is the point of hearing it — it
   * is the cue to push.
   */
  botReload(at: Vector3): void {
    const panner = this.panner(at);
    if (!panner) return;
    this.tone(430, 0.05, "square", 0.03, 1, panner);
    setTimeout(() => {
      const second = this.panner(at);
      if (second) this.tone(560, 0.05, "square", 0.03, 1, second);
    }, 120);
  }

  // --- primitives ----------------------------------------------------------

  private buildNoiseBuffer(): void {
    if (!this.ctx) return;
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, rate, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
  }

  /**
   * A distance-attenuated output node, or null when the sound is too far away
   * or the voice budget is spent.
   */
  private panner(at: Vector3): PannerNode | null {
    if (!this.ctx || !this.master) return null;
    const a = CONFIG.audio;
    if (this.voices >= a.maxVoices) return null;
    const node = this.ctx.createPanner();
    node.panningModel = "equalpower";
    node.distanceModel = "linear";
    node.refDistance = a.refDistance;
    node.maxDistance = a.maxDistance;
    node.rolloffFactor = 1;
    node.positionX.value = at.x;
    node.positionY.value = at.y;
    node.positionZ.value = at.z;
    node.connect(this.master);
    return node;
  }

  /** freqMult: ending frequency as a multiple of the start (for slides). */
  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    freqMult: number,
    out?: AudioNode | null,
  ): void {
    if (!this.ctx || !this.master) return;
    if (this.voices >= CONFIG.audio.maxVoices) return;
    try {
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * freqMult), t0 + dur);
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(out ?? this.master);
      this.voices += 1;
      osc.onended = () => {
        this.voices -= 1;
      };
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch {
      // audio is non-critical; ignore failures
    }
  }

  /**
   * Noise through a lowpass filter swept downward — the booming tail of a
   * gunshot. Same shared buffer and voice-cap rules as `noise()`.
   */
  private boom(dur: number, vol: number): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    if (this.voices >= CONFIG.audio.maxVoices) return;
    try {
      const t0 = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(900, t0);
      filter.frequency.exponentialRampToValueAtTime(120, t0 + dur);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(filter).connect(gain).connect(this.master);
      this.voices += 1;
      src.onended = () => {
        this.voices -= 1;
      };
      const offset = Math.random() * Math.max(0, this.noiseBuffer.duration - dur);
      src.start(t0, offset, dur);
    } catch {
      // ignore
    }
  }

  /** Plays a random slice of the shared noise buffer. */
  private noise(dur: number, vol: number, out?: AudioNode | null): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    if (this.voices >= CONFIG.audio.maxVoices) return;
    try {
      const t0 = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      // A different slice each time, so repeated shots don't phase together.
      const offset = Math.random() * Math.max(0, this.noiseBuffer.duration - dur);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(gain).connect(out ?? this.master);
      this.voices += 1;
      src.onended = () => {
        this.voices -= 1;
      };
      src.start(t0, offset, dur);
    } catch {
      // ignore
    }
  }
}
