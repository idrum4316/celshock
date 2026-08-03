/**
 * Sfx.ts — All audio: synthesized WebAudio, zero asset files.
 * Owns: the AudioContext, one cached noise buffer shared by every shot, one
 * shared convolution reverb every gunshot sends into, a master soft clip, the
 * voice cap (CONFIG.audio.maxVoices — over-cap sounds are skipped silently),
 * and positional panning relative to the listener.
 * Invariants: never generate a fresh noise buffer or impulse response per
 * sound — both are built once on unlock. setListener() is called once per
 * frame by Game, after the camera update. Firefox needs the legacy
 * setPosition/setOrientation path — keep both.
 */
import type { Vector3 } from "@babylonjs/core";
import { CONFIG } from "../config";

/**
 * How far past full scale the master soft clip stays roughly linear. 3 lets a
 * firefight stack three simultaneous full-level sounds before the curve bends
 * enough to hear, and saturates rather than clipping past that.
 */
const SOFT_CLIP_DRIVE = 3;

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
 *
 * **Gunfire is noise, not tone.** Every layer of a shot is a filtered slice of
 * the shared noise buffer; the single pitched oscillator left in a report is
 * the low chest thump, which genuinely is one frequency. An oscillator at any
 * audible pitch reads as a beep however it is enveloped, and that — more than
 * spectrum or envelope — is what made synthesized gunfire sound like a toy.
 *
 * **The tail is the reverb, not the shot.** Outdoors, a rifle is a two
 * millisecond transient followed by a quarter second of the village answering
 * it. That answer is one shared `ConvolverNode` on a send, so it costs nothing
 * per shot and, crucially, is not a voice: eighty shots a second all decay
 * through the same bus instead of eighty tail voices fighting over the cap.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private listener: AudioListener | null = null;
  /** Reused by every `burst()` call; built once on unlock. */
  private noiseBuffer: AudioBuffer | null = null;
  /** The shared environment reverb every gunshot sends into. */
  private reverb: ConvolverNode | null = null;
  /** Currently-playing one-shots, for the voice cap. */
  private voices = 0;
  /** Last listener position, for propagation delay and air absorption. */
  private lx = 0;
  private ly = 0;
  private lz = 0;

  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 1;
        // A firefight sums twenty-odd voices, and un-limited that is digital
        // clipping — the crackle reads as a broken speaker, not as loud.
        //
        // This is a **static soft clip, deliberately not a
        // `DynamicsCompressor`.** Measured: Chrome's compressor took a shot's
        // 0.45 transient down to 0.07, and — because its detector barely
        // engages on an isolated click — left a reload louder than the rifle
        // that needed it. Any envelope follower has that failure mode against
        // impulsive material: it ducks the very leading edge that makes a
        // gunshot sound like one. A `tanh` curve has no time constants at all,
        // so anything below saturation passes at exactly unity and only the
        // sums that would have clipped are bent.
        const clip = this.ctx.createWaveShaper();
        const curve = new Float32Array(1024);
        for (let i = 0; i < curve.length; i++) {
          const u = (i / (curve.length - 1)) * 2 - 1;
          curve[i] = Math.tanh(u * SOFT_CLIP_DRIVE);
        }
        clip.curve = curve;
        clip.oversample = "4x";
        // The pre-gain maps ±SOFT_CLIP_DRIVE of input across the curve, which
        // is what makes the small-signal slope unity.
        const pre = this.ctx.createGain();
        pre.gain.value = 1 / SOFT_CLIP_DRIVE;
        this.master.connect(pre).connect(clip).connect(this.ctx.destination);
        // The reverb is a send: dry stays at full level and wet is mixed in
        // alongside it, joining the dry path at the soft clip so the two are
        // saturated together rather than separately.
        this.reverb = this.ctx.createConvolver();
        const wet = this.ctx.createGain();
        wet.gain.value = CONFIG.audio.reverbMix;
        this.reverb.connect(wet).connect(pre);
        this.listener = this.ctx.listener;
        this.buildNoiseBuffer();
        this.buildImpulse();
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
    this.lx = position.x;
    this.ly = position.y;
    this.lz = position.z;
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
   * The player's rifle, at the player's own ear. Four layers plus the shared
   * reverb, in the order the ear resolves them: the blast, the body of the
   * report, the chest thump, and the bolt riding home a beat later. Sum of
   * durations is ~0.2 s, so at 8 rps this averages under three concurrent
   * voices — cheaper than the version it replaces, because the tail that used
   * to be a per-shot voice is now the shared bus.
   */
  shoot(): void {
    // Two rounds from the same rifle are never the same report, and eight a
    // second of one recording is the loudest tell that a gun is synthesized.
    const v = 0.92 + Math.random() * 0.16;
    // The blast. Broadband and gone in 20 ms — this is the crack, and it is
    // the loudest thing in the mix by a wide margin.
    this.burst({
      dur: 0.022, vol: 0.44 * v, type: "highpass", freq: 1400 * v, q: 0.6,
      send: 0.5,
    });
    // The body of the report, sweeping down as the gas column collapses. A
    // lowpass throws away most of a noise slice's amplitude, so its gain is
    // set well above the level it actually plays at.
    this.burst({
      dur: 0.12, vol: 0.6, type: "lowpass", freq: 2600 * v, freqEnd: 260,
      send: 1,
    });
    // Chest thump: the low pressure wave, and the one part of a gunshot that
    // really is a single frequency. A sine's peak is its gain exactly.
    this.tone(96 * v, 0.17, "sine", 0.26, 0.45, null, { send: 0.7 });
    // The bolt riding home, behind the shot rather than under it — mechanism,
    // so it has to sit far below the blast.
    this.burst({
      dur: 0.04, vol: 0.16, type: "bandpass", freq: 2900, q: 1.3, delay: 0.045,
      send: 0.25,
    });
  }

  /** Hitmarker: a chunky two-part "thock", not a beep. */
  hit(): void {
    this.tone(520, 0.05, "square", 0.07, 0.7);
    this.burst({ dur: 0.025, vol: 0.12 });
  }

  /**
   * A round cracking past the player's head. Not a hit and not a hit sound —
   * the supersonic N-wave, which arrives *before* the report of the rifle that
   * fired it and is the only thing that tells you you are being shot at rather
   * than shot near. Wired from `CombatSystem.onNearMiss` for the player only.
   */
  nearMiss(): void {
    const v = 0.9 + Math.random() * 0.2;
    this.burst({
      dur: 0.02, vol: 0.5, type: "bandpass", freq: 3400 * v, freqEnd: 1100,
      q: 0.9, send: 0.3,
    });
  }

  enemyDie(): void {
    this.tone(300, 0.25, "sawtooth", 0.06, 0.3);
  }

  playerHurt(): void {
    this.tone(110, 0.2, "sawtooth", 0.08, 0.7);
  }

  /**
   * Working the magazine: catch, magazine out, fresh magazine seated, bolt
   * released. Four metallic clicks rather than two beeps, and spaced across
   * the *actual* reload so the animation's end lands on the bolt rather than
   * on silence — which is why the offsets are fractions of the config value
   * and not absolute times.
   */
  reload(): void {
    const t = CONFIG.weapon.reloadTime;
    this.clack(2600, 0.9, 0);
    this.clack(1500, 0.5, t * 0.18);
    this.clack(760, 1, t * 0.55);
    this.clack(3400, 0.8, t * 0.8);
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
   * A bot's rifle, somewhere out in the village. Two layers, spatialised, and
   * the first thing dropped when the voice budget runs out.
   *
   * **Distance is heard three ways here, and only one of them is volume.** The
   * panner handles the level; on top of that the report arrives late (sound
   * covers the map in a fifth of a second, and a flash you see before you hear
   * it is the strongest range cue there is), air absorption strips the top off
   * the crack long before the shot gets quiet, and the reverb send climbs, so
   * a shot across the valley is nearly all tail. The result is that a rifle at
   * 15 m and one at 60 m are different *sounds*, not the same sound twice.
   */
  botShot(at: Vector3): void {
    const a = CONFIG.audio;
    const dist = this.distanceToListener(at);
    // Beyond maxDistance the linear rolloff has already reached silence, so
    // building the nodes only burns voices that could have carried an audible
    // shot. Reject before the panner, not after.
    if (dist > a.maxDistance) return;
    const panner = this.panner(at);
    if (!panner) return;
    const far = dist / a.maxDistance;
    const delay = dist / a.speedOfSound;
    const send = a.reverbMix * (0.4 + far * a.reverbDistanceSend);
    const v = 0.9 + Math.random() * 0.2;
    this.burst({
      dur: 0.03, vol: 0.4 * v * (1 - far * 0.8), type: "highpass",
      freq: (2400 - 1700 * far) * v, q: 0.6, delay, out: panner,
      send: send * 0.3,
    });
    // The far half of the map hears a longer, duller thud; the near half hears
    // a report with an edge on it.
    this.burst({
      dur: 0.1 + far * 0.14, vol: 0.62, type: "lowpass",
      freq: 1500 - 1150 * far, freqEnd: 190, delay, out: panner, send,
    });
  }

  /**
   * A bot working its magazine. The player's own reload is flat and
   * front-and-centre; this one is spatialised, because knowing *which* of the
   * enemies in front of you has just gone dry is the point of hearing it — it
   * is the cue to push. Fixed offsets rather than the player's fractions: bot
   * reload time is a per-bot skill value and this only has a position.
   */
  botReload(at: Vector3): void {
    const dist = this.distanceToListener(at);
    if (dist > CONFIG.audio.maxDistance) return;
    const panner = this.panner(at);
    if (!panner) return;
    const delay = dist / CONFIG.audio.speedOfSound;
    this.clack(2200, 0.5, delay, panner);
    this.clack(760, 0.6, delay + 0.3, panner);
    this.clack(3100, 0.45, delay + 0.55, panner);
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
   * The village's impulse response: a handful of discrete slaps off the
   * nearest walls, then a decaying diffuse tail. Built once.
   *
   * Two details carry it. The tail is run through a one-pole lowpass as it is
   * written, because air and stone eat the top end first — an undarkened noise
   * tail is a hiss, which reads as tape, not as a valley. And the two channels
   * get independent noise and different early-reflection times: identical
   * channels collapse to a point between your ears, and the whole reason a
   * gunshot sounds outdoors is that its tail comes from everywhere at once.
   */
  private buildImpulse(): void {
    if (!this.ctx || !this.reverb) return;
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * CONFIG.audio.reverbSeconds);
    const ir = this.ctx.createBuffer(2, len, rate);
    // Milliseconds and amplitude of the early reflections, per channel.
    const early = [
      [13, 0.5, 29, 0.36, 48, 0.26, 71, 0.18, 104, 0.12],
      [19, 0.46, 34, 0.33, 57, 0.24, 83, 0.17, 119, 0.11],
    ];
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp += 0.3 * (Math.random() * 2 - 1 - lp);
        // Squared falloff reaching exactly zero at the end, so the tail can
        // never click off.
        d[i] = lp * (1 - t) * (1 - t) * 0.6;
      }
      const table = early[ch];
      for (let k = 0; k < table.length; k += 2) {
        const at = Math.floor((rate * table[k]) / 1000);
        if (at < len) d[at] += table[k + 1];
      }
    }
    this.reverb.buffer = ir;
  }

  private distanceToListener(at: Vector3): number {
    const dx = at.x - this.lx;
    const dy = at.y - this.ly;
    const dz = at.z - this.lz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
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

  /**
   * freqMult: ending frequency as a multiple of the start (for slides).
   * `extra` carries the two things only gunfire needs — a scheduling offset
   * and a reverb send — so the eight plain call sites stay plain.
   */
  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    freqMult: number,
    out?: AudioNode | null,
    extra?: { delay?: number; send?: number },
  ): void {
    if (!this.ctx || !this.master) return;
    if (this.voices >= CONFIG.audio.maxVoices) return;
    try {
      const t0 = this.ctx.currentTime + (extra?.delay ?? 0);
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * freqMult), t0 + dur);
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(out ?? this.master);
      this.send(gain, extra?.send);
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
   * One layer of a percussive sound: a random slice of the shared noise buffer
   * through an optional filter, with a two-stage decay.
   *
   * **The two stages are the point.** A single exponential from full to
   * silence is a whoosh however short you make it; every impulsive sound in
   * the physical world collapses most of the way in the first few percent of
   * its length and then trails. That envelope, applied to filtered noise, is
   * what the ear reads as "something struck", and it is doing more work here
   * than any of the frequency choices above it.
   */
  private burst(b: {
    dur: number;
    vol: number;
    /** Omitted leaves the slice unfiltered. */
    type?: BiquadFilterType;
    freq?: number;
    /** Swept to, over the layer's duration. */
    freqEnd?: number;
    q?: number;
    /** Seconds from now, on the audio clock — not a setTimeout. */
    delay?: number;
    out?: AudioNode | null;
    /** Level into the shared environment reverb, pre-panner. */
    send?: number;
  }): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    if (this.voices >= CONFIG.audio.maxVoices) return;
    try {
      const t0 = this.ctx.currentTime + (b.delay ?? 0);
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(b.vol, t0);
      gain.gain.exponentialRampToValueAtTime(b.vol * 0.18, t0 + b.dur * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + b.dur);
      let head: AudioNode = src;
      if (b.type && b.freq) {
        const f = this.ctx.createBiquadFilter();
        f.type = b.type;
        f.Q.value = b.q ?? 1;
        f.frequency.setValueAtTime(b.freq, t0);
        if (b.freqEnd) {
          f.frequency.exponentialRampToValueAtTime(b.freqEnd, t0 + b.dur);
        }
        src.connect(f);
        head = f;
      }
      head.connect(gain).connect(b.out ?? this.master);
      this.send(gain, b.send);
      this.voices += 1;
      src.onended = () => {
        this.voices -= 1;
      };
      // A different slice each time, so repeated shots don't phase together.
      const offset = Math.random() * Math.max(0, this.noiseBuffer.duration - b.dur);
      src.start(t0, offset, b.dur);
    } catch {
      // ignore
    }
  }

  /**
   * Taps a layer into the shared reverb. Tapped *before* the panner
   * deliberately: reverberant energy is diffuse and arrives from every
   * direction, so it is neither panned nor distance-attenuated — callers set
   * the send level from distance themselves.
   */
  private send(from: GainNode, level: number | undefined): void {
    if (!this.ctx || !this.reverb || !level) return;
    const s = this.ctx.createGain();
    s.gain.value = level;
    from.connect(s).connect(this.reverb);
  }

  /**
   * A piece of the weapon's mechanism. Bandpassed noise, because metal on
   * metal is a resonance and a struck resonance is exactly what a filtered
   * noise burst is — a square wave at the same pitch is a beep.
   */
  private clack(
    freq: number,
    vol: number,
    delay: number,
    out?: AudioNode | null,
  ): void {
    // The bandpass throws away about half the noise's amplitude, so the raw
    // gain sits above the level this ends up playing at — and the whole family
    // sits far below a report, because a magazine catch is not a gunshot.
    this.burst({
      dur: 0.045, vol: 0.28 * vol, type: "bandpass", freq, q: 1.2,
      delay, out, send: 0.2,
    });
  }
}
