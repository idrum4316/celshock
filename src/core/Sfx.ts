/**
 * Tiny procedural sound effects via WebAudio — no audio assets needed.
 * The context is created lazily on the first user gesture (call `unlock()`).
 */
export class Sfx {
  private ctx: AudioContext | null = null;

  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        this.ctx = null;
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
  }

  shoot(): void {
    this.tone(210, 0.06, "square", 0.05, 0.45);
    this.noise(0.04, 0.03);
  }

  hit(): void {
    this.tone(880, 0.04, "square", 0.04, 1);
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

  doorOpen(): void {
    this.tone(440, 0.12, "sine", 0.07, 1.5);
    setTimeout(() => this.tone(660, 0.18, "sine", 0.07, 1.2), 130);
  }

  pickup(): void {
    this.tone(700, 0.08, "sine", 0.07, 1.6);
  }

  boom(): void {
    this.noise(0.35, 0.12);
    this.tone(70, 0.35, "sine", 0.12, 0.6);
  }

  bossRoar(): void {
    this.tone(90, 0.7, "sawtooth", 0.1, 0.5);
    this.noise(0.5, 0.05);
  }

  jump(): void {
    this.tone(330, 0.08, "sine", 0.04, 1.6);
  }

  /** freqMult: ending frequency as a multiple of the start (for slides). */
  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    freqMult: number,
  ): void {
    if (!this.ctx) return;
    try {
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * freqMult), t0 + dur);
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch {
      // audio is non-critical; ignore failures
    }
  }

  private noise(dur: number, vol: number): void {
    if (!this.ctx) return;
    try {
      const t0 = this.ctx.currentTime;
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
      const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(gain).connect(this.ctx.destination);
      src.start(t0);
    } catch {
      // ignore
    }
  }
}
