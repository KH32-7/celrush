import { clamp } from '../core/math';

export interface AudioTelemetry {
  rpm: number;
  throttle: number;
  speed: number;
  skid: number;
  offroad: boolean;
  wet: number;
  boost: boolean;
  airborne: boolean;
}

interface Loop {
  src: AudioBufferSourceNode;
  filt: BiquadFilterNode;
  gain: GainNode;
}

/**
 * Everything is synthesized: no audio files, no network. Engine pitch and filter track RPM directly,
 * which is a better speed readout than the gauge.
 */
export class AudioSys {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private musicBus!: GainNode;
  private noise!: AudioBuffer;
  private eng: { o1: OscillatorNode; o2: OscillatorNode; o3: OscillatorNode; filt: BiquadFilterNode; gain: GainNode; am: GainNode; lfo: OscillatorNode; lfoGain: GainNode } | null = null;
  private skid: Loop | null = null;
  private wind: Loop | null = null;
  private water: Loop | null = null;
  private rain: Loop | null = null;
  private kind: 'car' | 'boat' = 'car';
  sfxVol = 0.8;
  musicVol = 0.45;
  private musicOn = false;
  private musicTimer = 0;
  private nextBeat = 0;
  private beat = 0;

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.sfxVol;
    this.sfx.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVol * 0.5;
    this.musicBus.connect(this.master);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setVolumes(sfx: number, music: number) {
    this.sfxVol = sfx;
    this.musicVol = music;
    if (!this.ctx) return;
    this.sfx.gain.setTargetAtTime(sfx, this.ctx.currentTime, 0.05);
    this.musicBus.gain.setTargetAtTime(music * 0.5, this.ctx.currentTime, 0.05);
  }

  private loop(type: BiquadFilterType, freq: number, q: number): Loop {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filt).connect(gain).connect(this.sfx);
    src.start();
    return { src, filt, gain };
  }

  /** Build the continuous layers for this vehicle kind. */
  start(kind: 'car' | 'boat', storm: boolean) {
    if (!this.ctx) return;
    this.stopLoops();
    this.kind = kind;
    const ctx = this.ctx;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), o3 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o2.type = 'square';
    o3.type = 'sawtooth';
    o3.detune.value = 12;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * 2.4);
    }
    shaper.curve = curve;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 2.2;
    const am = ctx.createGain();
    am.gain.value = 1;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const g2 = ctx.createGain();
    g2.gain.value = 0.55;
    const g3 = ctx.createGain();
    g3.gain.value = 0.25;
    o1.connect(shaper);
    o2.connect(g2).connect(shaper);
    o3.connect(g3).connect(shaper);
    shaper.connect(filt).connect(am).connect(gain).connect(this.sfx);
    // propeller chop for the outboard: amplitude LFO locked to engine speed
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = kind === 'boat' ? 0.35 : 0;
    lfo.connect(lfoGain).connect(am.gain);
    o1.start();
    o2.start();
    o3.start();
    lfo.start();
    this.eng = { o1, o2, o3, filt, gain, am, lfo, lfoGain };
    this.skid = kind === 'car' ? this.loop('bandpass', 1900, 1.4) : this.loop('highpass', 1600, 0.7);
    this.wind = this.loop('bandpass', 520, 0.6);
    this.water = kind === 'boat' ? this.loop('lowpass', 500, 0.8) : null;
    this.rain = storm ? this.loop('highpass', 2600, 0.5) : null;
    if (this.rain) this.rain.gain.gain.value = 0.07;
  }

  stopLoops() {
    const kill = (l: Loop | null) => {
      if (!l) return;
      try { l.src.stop(); } catch { /* already stopped */ }
      l.gain.disconnect();
    };
    kill(this.skid); kill(this.wind); kill(this.water); kill(this.rain);
    this.skid = this.wind = this.water = this.rain = null;
    if (this.eng) {
      for (const o of [this.eng.o1, this.eng.o2, this.eng.o3, this.eng.lfo]) {
        try { o.stop(); } catch { /* already stopped */ }
      }
      this.eng.gain.disconnect();
      this.eng = null;
    }
  }

  update(t: AudioTelemetry, paused: boolean) {
    if (!this.ctx || !this.eng) return;
    const now = this.ctx.currentTime;
    const tc = 0.04;
    const mute = paused ? 0 : 1;
    if (this.kind === 'car') {
      const f = 44 + t.rpm * 178;
      this.eng.o1.frequency.setTargetAtTime(f, now, tc);
      this.eng.o2.frequency.setTargetAtTime(f * 0.5, now, tc);
      this.eng.o3.frequency.setTargetAtTime(f * 1.5, now, tc);
      this.eng.filt.frequency.setTargetAtTime(500 + t.rpm * 2600 + t.throttle * 1500, now, tc);
      this.eng.gain.gain.setTargetAtTime((0.05 + t.throttle * 0.06 + t.rpm * 0.04) * mute, now, 0.05);
    } else {
      const f = 34 + t.rpm * 150;
      this.eng.o1.frequency.setTargetAtTime(f, now, tc);
      this.eng.o2.frequency.setTargetAtTime(f * 0.5, now, tc);
      this.eng.o3.frequency.setTargetAtTime(f * 2, now, tc);
      this.eng.lfo.frequency.setTargetAtTime(f / 5, now, tc);
      this.eng.filt.frequency.setTargetAtTime(380 + t.rpm * 1900 + t.throttle * 700, now, tc);
      this.eng.gain.gain.setTargetAtTime((0.05 + t.throttle * 0.06 + t.rpm * 0.035) * mute, now, 0.05);
    }
    const sk = clamp(t.skid, 0, 1);
    this.skid?.gain.gain.setTargetAtTime((this.kind === 'car' ? sk * 0.16 + (t.offroad ? clamp(t.speed / 40, 0, 1) * 0.08 : 0) : sk * 0.1) * mute, now, 0.05);
    if (this.skid && this.kind === 'car') this.skid.filt.frequency.setTargetAtTime(t.offroad ? 700 : 1900, now, 0.1);
    const w = clamp(t.speed / 60, 0, 1.3);
    this.wind?.gain.gain.setTargetAtTime((w * w * 0.2 + (t.boost ? 0.08 : 0)) * mute, now, 0.1);
    this.wind?.filt.frequency.setTargetAtTime(380 + w * 700, now, 0.1);
    if (this.water) {
      this.water.gain.gain.setTargetAtTime(clamp(t.speed * 0.009, 0, 0.26) * clamp(t.wet * 2.5, 0, 1) * mute, now, 0.06);
      this.water.filt.frequency.setTargetAtTime(260 + t.speed * 28, now, 0.1);
    }
    if (this.rain) this.rain.gain.gain.setTargetAtTime(0.07 * mute, now, 0.2);
  }

  // ---------------------------------------------------------------- one-shots

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.sfx);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  private burst(type: BiquadFilterType, f0: number, f1: number, dur: number, vol: number, q = 1, delay = 0, bus?: GainNode) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f).connect(g).connect(bus ?? this.sfx);
    s.start(t0, Math.random());
    s.stop(t0 + dur + 0.05);
  }

  play(name: string, v = 1) {
    if (!this.ctx) return;
    switch (name) {
      case 'boost':
        this.tone('sine', 150, 36, 0.55, 0.5);
        this.burst('bandpass', 300, 3200, 0.6, 0.28, 1.2);
        break;
      case 'stage': {
        const k = 1 + (v - 1) * 0.26;
        this.tone('triangle', 660 * k, 660 * k, 0.12, 0.16);
        this.tone('triangle', 990 * k, 990 * k, 0.16, 0.12, 0.06);
        break;
      }
      case 'drift':
        this.burst('bandpass', 1200, 900, 0.15, 0.08, 2);
        break;
      case 'hit':
        this.burst('lowpass', 1400, 300, 0.28, Math.min(0.55, v * 0.07));
        this.tone('sine', 90, 40, 0.22, Math.min(0.5, v * 0.06));
        break;
      case 'land':
        this.tone('sine', 75, 34, 0.3, Math.min(0.6, v * 0.08));
        this.burst('lowpass', 500, 150, 0.25, Math.min(0.3, v * 0.04));
        break;
      case 'splash':
        this.burst('bandpass', 1100, 500, 0.45, Math.min(0.4, v * 0.05), 0.8);
        this.burst('lowpass', 400, 120, 0.3, Math.min(0.3, v * 0.04));
        break;
      case 'count':
        this.tone('square', 660, 660, 0.16, 0.12);
        break;
      case 'go':
        this.tone('square', 1320, 1320, 0.5, 0.14);
        this.tone('square', 990, 990, 0.5, 0.08);
        break;
      case 'lap':
        [523, 659, 784].forEach((f, i) => this.tone('triangle', f, f, 0.14, 0.16, i * 0.08));
        break;
      case 'finish':
        [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone('triangle', f, f, 0.22, 0.18, i * 0.09));
        break;
      case 'check':
        this.tone('triangle', 880, 1320, 0.14, 0.14);
        break;
      case 'respawn':
        this.tone('sine', 300, 900, 0.25, 0.12);
        break;
      case 'land-good':
        [784, 1047].forEach((f, i) => this.tone('triangle', f, f, 0.12, 0.14, i * 0.06));
        break;
      case 'thunder':
        this.burst('lowpass', 260, 60, 2.8, 0.7, 0.7, v);
        this.tone('sine', 55, 30, 1.6, 0.35, v);
        break;
      case 'ui':
        this.tone('triangle', 880, 880, 0.05, 0.09);
        break;
      case 'ui-ok':
        this.tone('triangle', 660, 1320, 0.12, 0.12);
        break;
    }
  }

  // ---------------------------------------------------------------- music

  /** Small procedural loop: kick/snare/hat + bass + pluck arpeggio, A minor, 140 BPM. */
  startMusic() {
    if (!this.ctx || this.musicOn) return;
    this.musicOn = true;
    this.nextBeat = this.ctx.currentTime + 0.1;
    this.beat = 0;
    const spb = 60 / 140 / 2; // eighth notes
    const roots = [45, 41, 48, 43]; // A2 F2 C3 G2
    const chord = [[0, 3, 7], [0, 4, 7], [0, 4, 7], [0, 4, 7]];
    const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
    const tick = () => {
      if (!this.ctx || !this.musicOn) return;
      while (this.nextBeat < this.ctx.currentTime + 0.15) {
        const t = this.nextBeat;
        const b = this.beat;
        const bar = Math.floor(b / 8) % 4;
        const e = b % 8;
        const delay = t - this.ctx.currentTime;
        if (e === 0 || e === 4 || e === 7) this.drum('kick', delay);
        if (e === 2 || e === 6) this.drum('snare', delay);
        this.drum('hat', delay, e % 2 ? 0.5 : 1);
        const root = roots[bar];
        const bassNote = e === 3 || e === 7 ? root + 12 : root;
        this.synth('sawtooth', midi(bassNote), spb * 0.9, 0.11, delay, 700);
        if (e % 2 === 0 || e === 5) {
          const ch = chord[bar];
          const n = root + 24 + ch[(b + bar) % 3] + (e > 4 ? 12 : 0);
          this.synth('square', midi(n), spb * 0.6, 0.035, delay, 2400);
        }
        this.nextBeat += spb;
        this.beat++;
      }
      this.musicTimer = window.setTimeout(tick, 25);
    };
    tick();
  }

  stopMusic() {
    this.musicOn = false;
    clearTimeout(this.musicTimer);
  }

  private synth(type: OscillatorType, f: number, dur: number, vol: number, delay: number, cutoff: number) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + Math.max(0, delay);
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const fl = ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.setValueAtTime(cutoff * 2, t0);
    fl.frequency.exponentialRampToValueAtTime(cutoff * 0.4, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(fl).connect(g).connect(this.musicBus);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  private drum(kind: 'kick' | 'snare' | 'hat', delay: number, vel = 1) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + Math.max(0, delay);
    if (kind === 'kick') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(140, t0);
      o.frequency.exponentialRampToValueAtTime(42, t0 + 0.14);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      o.connect(g).connect(this.musicBus);
      o.start(t0);
      o.stop(t0 + 0.25);
    } else {
      this.burst(kind === 'snare' ? 'bandpass' : 'highpass', kind === 'snare' ? 1800 : 7000, kind === 'snare' ? 1200 : 6000, kind === 'snare' ? 0.16 : 0.04, (kind === 'snare' ? 0.22 : 0.06) * vel, 0.8, Math.max(0, delay), this.musicBus);
    }
  }
}
