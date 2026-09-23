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
  /** car gear index (0 for boats); a change triggers the shift cut */
  gear: number;
  /** boat: 0..1 how submerged the prop is (1 for cars) */
  prop: number;
}

/** Another vehicle heard from the camera: position/velocity relative to the listener, already in listener space. */
export interface AudioVoiceInput {
  /** listener-space offset: x right, y up, z forward (m) */
  x: number;
  y: number;
  z: number;
  /** closing speed toward the listener, m/s (positive = approaching) */
  closing: number;
  rpm: number;
}

interface Loop {
  src: AudioBufferSourceNode;
  filt: BiquadFilterNode;
  gain: GainNode;
}

interface Engine {
  osc: OscillatorNode[];
  drive: GainNode;
  filt: BiquadFilterNode;
  gain: GainNode;
  am: GainNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  jitter: AudioBufferSourceNode;
  exhaust: Loop;
}

interface Voice {
  o1: OscillatorNode;
  o2: OscillatorNode;
  filt: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

/** Per-theme music: tempo, key and a four-chord progression (semitones from the root, minor/major flag). */
interface Tune {
  bpm: number;
  root: number;
  prog: [number, boolean][];
  swing: number;
}

const TUNES: Record<string, Tune> = {
  city: { bpm: 138, root: 45, prog: [[0, false], [8, true], [3, true], [10, true]], swing: 0 },
  mountain: { bpm: 148, root: 40, prog: [[0, false], [5, false], [10, true], [3, true]], swing: 0 },
  night: { bpm: 158, root: 42, prog: [[0, false], [8, true], [10, true], [7, false]], swing: 0 },
  bay: { bpm: 128, root: 43, prog: [[0, true], [9, false], [5, true], [7, true]], swing: 0.12 },
  canyon: { bpm: 150, root: 38, prog: [[0, false], [10, true], [5, true], [0, false]], swing: 0.06 },
  storm: { bpm: 162, root: 41, prog: [[0, false], [1, true], [8, true], [7, false]], swing: 0 },
  menu: { bpm: 112, root: 45, prog: [[0, false], [8, true], [3, true], [10, true]], swing: 0.1 },
};

/** Reverb send per theme: open bays are dry, the canyon walls and city blocks throw it back. */
const SPACE: Record<string, number> = { city: 0.16, mountain: 0.14, night: 0.2, bay: 0.08, canyon: 0.34, storm: 0.16 };

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/**
 * Everything is synthesized: no audio files, no network. Engine pitch and filter track RPM directly,
 * which is a better speed readout than the gauge.
 */
export class AudioSys {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private musicBus!: GainNode;
  private musicDuck!: GainNode;
  private musicPause!: BiquadFilterNode;
  private reverb!: ConvolverNode;
  private sfxSend!: GainNode;
  private musicSend!: GainNode;
  private noise!: AudioBuffer;
  private engineWave!: PeriodicWave;
  private outboardWave!: PeriodicWave;
  private eng: Engine | null = null;
  private skid: Loop | null = null;
  private squeal: Loop | null = null;
  private wind: Loop | null = null;
  private water: Loop | null = null;
  private rain: Loop | null = null;
  private voices: Voice[] = [];
  private kind: 'car' | 'boat' = 'car';
  sfxVol = 0.8;
  musicVol = 0.45;
  private musicOn = false;
  private musicTimer = 0;
  private nextBeat = 0;
  private step16 = 0;
  private tune: Tune = TUNES.menu;
  private pendingTune: Tune | null = null;
  private intensity = 0;
  private lastThrottle = 0;
  private lastGear = 0;
  private lastCrackle = 0;
  private wasPaused = false;

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 8;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp).connect(ctx.destination);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.sfxVol;
    this.sfx.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVol * 0.5;
    // music chain: [duck (bass/pad, sidechained to the kick)] -> pause lowpass -> bus.
    // Unducked voices enter at the pause lowpass so pausing muffles the whole track.
    this.musicDuck = ctx.createGain();
    this.musicPause = ctx.createBiquadFilter();
    this.musicPause.type = 'lowpass';
    this.musicPause.frequency.value = 20000;
    this.musicDuck.connect(this.musicPause).connect(this.musicBus).connect(this.master);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(1.8, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    this.reverb.connect(wet).connect(this.master);
    this.sfxSend = ctx.createGain();
    this.sfxSend.gain.value = 0.12;
    this.sfx.connect(this.sfxSend).connect(this.reverb);
    this.musicSend = ctx.createGain();
    this.musicSend.gain.value = 0.22;
    this.musicBus.connect(this.musicSend).connect(this.reverb);

    // four-stroke firing pulse: strong low harmonics with the even ones lifted gives the "burble"
    this.engineWave = this.wave([0, 1, 0.75, 0.5, 0.55, 0.3, 0.32, 0.16, 0.2, 0.08, 0.1, 0.05, 0.06]);
    // two-stroke outboard: buzzy, odd-heavy
    this.outboardWave = this.wave([0, 1, 0.25, 0.7, 0.2, 0.5, 0.15, 0.38, 0.1, 0.26, 0.08, 0.18]);

    // background tabs throttle timers; stop the clock instead of letting the sequencer pile up notes
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else {
        void this.ctx.resume();
        this.nextBeat = this.ctx.currentTime + 0.05;
      }
    });
  }

  private wave(amps: number[]) {
    const ctx = this.ctx!;
    const real = new Float32Array(amps.length);
    const imag = new Float32Array(amps.length);
    for (let i = 1; i < amps.length; i++) {
      // fixed pseudo-random phases so harmonics don't all peak together (less "synth", more combustion)
      const ph = (i * 2.399) % (Math.PI * 2);
      real[i] = amps[i] * Math.cos(ph);
      imag[i] = amps[i] * Math.sin(ph);
    }
    return ctx.createPeriodicWave(real, imag);
  }

  /** Stereo decaying noise tail, darker toward the end. */
  private impulse(seconds: number, decay: number) {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const k = 0.15 + 0.8 * (1 - t);
        lp += (Math.random() * 2 - 1 - lp) * k;
        d[i] = lp * Math.pow(1 - t, decay) * (i < ctx.sampleRate * 0.012 ? i / (ctx.sampleRate * 0.012) : 1);
      }
    }
    return buf;
  }

  setVolumes(sfx: number, music: number) {
    this.sfxVol = sfx;
    this.musicVol = music;
    if (!this.ctx) return;
    this.sfx.gain.setTargetAtTime(sfx, this.ctx.currentTime, 0.05);
    this.musicBus.gain.setTargetAtTime(music * 0.5, this.ctx.currentTime, 0.05);
  }

  /** Theme id picks the music and the reverb size. 'menu' for the title/select screens. */
  setTheme(id: string) {
    this.pendingTune = TUNES[id] ?? TUNES.city;
    if (!this.ctx) {
      this.tune = this.pendingTune;
      return;
    }
    this.sfxSend.gain.setTargetAtTime(SPACE[id] ?? 0.12, this.ctx.currentTime, 0.3);
  }

  /** 0 = menu/results (no drums), 1 = racing, 2 = final lap (lead line + open hats) */
  setIntensity(level: number) {
    this.intensity = level;
  }

  private loop(type: BiquadFilterType, freq: number, q: number, dest: AudioNode = this.sfx): Loop {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filt).connect(gain).connect(dest);
    src.start(0, Math.random() * 1.5);
    return { src, filt, gain };
  }

  /** Build the continuous layers for this vehicle kind. */
  start(kind: 'car' | 'boat', storm: boolean, opponents = 0) {
    if (!this.ctx) return;
    this.stopLoops();
    this.kind = kind;
    const ctx = this.ctx;
    const boat = kind === 'boat';
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), o3 = ctx.createOscillator();
    o1.setPeriodicWave(boat ? this.outboardWave : this.engineWave);
    o2.setPeriodicWave(this.engineWave);
    o3.setPeriodicWave(boat ? this.outboardWave : this.engineWave);
    o3.detune.value = 9;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 1.8) * 0.9 + 0.1 * Math.tanh(x * 6);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    const drive = ctx.createGain();
    drive.gain.value = 0.6;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 1.6;
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = boat ? 320 : 180;
    body.Q.value = 1.1;
    body.gain.value = 5;
    const am = ctx.createGain();
    am.gain.value = 1;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const g2 = ctx.createGain();
    g2.gain.value = 0.7;
    const g3 = ctx.createGain();
    g3.gain.value = 0.35;
    o1.connect(drive);
    o2.connect(g2).connect(drive);
    o3.connect(g3).connect(drive);
    drive.connect(shaper).connect(filt).connect(body).connect(am).connect(gain).connect(this.sfx);
    // propeller chop for the outboard: amplitude LFO locked to engine speed
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = boat ? 0.3 : 0;
    lfo.connect(lfoGain).connect(am.gain);
    // combustion jitter: slow noise wobbling the amplitude so idle doesn't sound like a test tone
    const jitter = ctx.createBufferSource();
    jitter.buffer = this.noise;
    jitter.loop = true;
    const jf = ctx.createBiquadFilter();
    jf.type = 'lowpass';
    jf.frequency.value = 40;
    const jg = ctx.createGain();
    jg.gain.value = 0.35;
    jitter.connect(jf).connect(jg).connect(am.gain);
    for (const o of [o1, o2, o3, lfo]) o.start();
    jitter.start();
    // exhaust/intake hiss that opens up with throttle
    const exhaust = this.loop('bandpass', 800, 1.2);
    this.eng = { osc: [o1, o2, o3], drive, filt, gain, am, lfo, lfoGain, jitter, exhaust };

    this.skid = boat ? this.loop('highpass', 1600, 0.7) : this.loop('bandpass', 1500, 1.2);
    // narrow resonant band on top of the scrub = the tonal tire squeal
    this.squeal = boat ? null : this.loop('bandpass', 2100, 14);
    this.wind = this.loop('bandpass', 520, 0.6);
    this.water = boat ? this.loop('lowpass', 500, 0.8) : null;
    this.rain = storm ? this.loop('highpass', 2600, 0.5) : null;
    if (this.rain) this.rain.gain.gain.value = 0.07;
    this.lastGear = 0;

    for (let i = 0; i < opponents; i++) this.voices.push(this.voice(boat));
  }

  private voice(boat: boolean): Voice {
    const ctx = this.ctx!;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.setPeriodicWave(boat ? this.outboardWave : this.engineWave);
    o2.setPeriodicWave(this.engineWave);
    o2.detune.value = -7 + Math.random() * 14;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 1;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const g2 = ctx.createGain();
    g2.gain.value = 0.6;
    const pan = ctx.createStereoPanner();
    o1.connect(filt);
    o2.connect(g2).connect(filt);
    filt.connect(gain).connect(pan).connect(this.sfx);
    o1.start();
    o2.start();
    return { o1, o2, filt, gain, pan };
  }

  stopLoops() {
    const kill = (l: Loop | null) => {
      if (!l) return;
      try { l.src.stop(); } catch { /* already stopped */ }
      l.gain.disconnect();
    };
    kill(this.skid); kill(this.squeal); kill(this.wind); kill(this.water); kill(this.rain);
    this.skid = this.squeal = this.wind = this.water = this.rain = null;
    if (this.eng) {
      for (const o of [...this.eng.osc, this.eng.lfo, this.eng.jitter]) {
        try { o.stop(); } catch { /* already stopped */ }
      }
      kill(this.eng.exhaust);
      this.eng.gain.disconnect();
      this.eng = null;
    }
    for (const v of this.voices) {
      try { v.o1.stop(); v.o2.stop(); } catch { /* already stopped */ }
      v.pan.disconnect();
    }
    this.voices = [];
  }

  update(t: AudioTelemetry, paused: boolean, others: AudioVoiceInput[] = []) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (paused !== this.wasPaused) {
      this.wasPaused = paused;
      this.musicPause.frequency.setTargetAtTime(paused ? 700 : 20000, now, paused ? 0.08 : 0.25);
    }
    if (!this.eng) return;
    const tc = 0.04;
    const mute = paused ? 0 : 1;
    const e = this.eng;

    // gear change: a quick ignition cut + a little pop so shifts read even at a glance
    if (this.kind === 'car' && t.gear !== this.lastGear) {
      if (this.lastGear > 0 && t.gear > this.lastGear && !paused) {
        e.am.gain.cancelScheduledValues(now);
        e.am.gain.setValueAtTime(1, now);
        e.am.gain.linearRampToValueAtTime(0.25, now + 0.03);
        e.am.gain.linearRampToValueAtTime(1, now + 0.12);
        this.pop(0.02, 0.5);
      }
      this.lastGear = t.gear;
    }
    // overrun crackle: lifting off the throttle at high rpm spits pops out of the exhaust
    if (!paused && this.lastThrottle > 0.6 && t.throttle < 0.2 && t.rpm > 0.55 && now - this.lastCrackle > 0.6) {
      const n = this.kind === 'car' ? 3 + Math.floor(Math.random() * 4) : 2;
      for (let i = 0; i < n; i++) this.pop(0.04 + i * (0.05 + Math.random() * 0.07), 0.35 + Math.random() * 0.5);
      this.lastCrackle = now;
    }
    this.lastThrottle = t.throttle;

    const f = this.kind === 'car' ? 40 + t.rpm * 190 : 34 + t.rpm * 150;
    const [o1, o2, o3] = e.osc;
    o1.frequency.setTargetAtTime(f, now, tc);
    o2.frequency.setTargetAtTime(f * 0.5, now, tc);
    o3.frequency.setTargetAtTime(this.kind === 'car' ? f * 1.5 : f * 2, now, tc);
    // on load the engine is driven harder (more grit) and the filter opens
    e.drive.gain.setTargetAtTime(0.45 + t.throttle * 0.9 + (t.boost ? 0.4 : 0), now, 0.06);
    if (this.kind === 'car') {
      e.filt.frequency.setTargetAtTime(420 + t.rpm * 2400 + t.throttle * 1600, now, tc);
      e.gain.gain.setTargetAtTime((0.06 + t.throttle * 0.05 + t.rpm * 0.05) * mute, now, 0.05);
    } else {
      e.lfo.frequency.setTargetAtTime(f / 5, now, tc);
      // prop in the air: the note loses the chop and screams
      e.lfoGain.gain.setTargetAtTime(0.3 * clamp(t.prop * 1.5, 0.2, 1), now, 0.05);
      e.filt.frequency.setTargetAtTime(360 + t.rpm * 1900 + t.throttle * 800 + (1 - t.prop) * 1200, now, tc);
      e.gain.gain.setTargetAtTime((0.055 + t.throttle * 0.05 + t.rpm * 0.04) * mute, now, 0.05);
    }
    e.exhaust.filt.frequency.setTargetAtTime(f * 4 + 300, now, tc);
    e.exhaust.gain.gain.setTargetAtTime((0.01 + t.throttle * t.rpm * 0.05 + (t.boost ? 0.04 : 0)) * mute, now, 0.05);

    const sk = clamp(t.skid, 0, 1);
    if (this.kind === 'car') {
      const off = t.offroad ? clamp(t.speed / 40, 0, 1) : 0;
      this.skid?.gain.gain.setTargetAtTime((sk * 0.1 + off * 0.1) * mute, now, 0.05);
      this.skid?.filt.frequency.setTargetAtTime(t.offroad ? 650 : 1500, now, 0.1);
      const sq = t.offroad || t.airborne ? 0 : clamp((sk - 0.25) / 0.6, 0, 1);
      this.squeal?.gain.gain.setTargetAtTime(sq * 0.22 * mute, now, 0.06);
      // squeal pitch wanders with load, like a real tire
      this.squeal?.filt.frequency.setTargetAtTime(1750 + sk * 600 + Math.sin(now * 7) * 90, now, 0.05);
    } else {
      this.skid?.gain.gain.setTargetAtTime(sk * 0.1 * mute, now, 0.05);
    }
    const w = clamp(t.speed / 60, 0, 1.3);
    this.wind?.gain.gain.setTargetAtTime((w * w * 0.18 + (t.boost ? 0.1 : 0) + (t.airborne ? 0.05 : 0)) * mute, now, 0.1);
    this.wind?.filt.frequency.setTargetAtTime(380 + w * 700 + (t.boost ? 400 : 0), now, 0.1);
    if (this.water) {
      this.water.gain.gain.setTargetAtTime(clamp(t.speed * 0.009, 0, 0.26) * clamp(t.wet * 2.5, 0, 1) * mute, now, 0.06);
      this.water.filt.frequency.setTargetAtTime(260 + t.speed * 28, now, 0.1);
    }
    if (this.rain) this.rain.gain.gain.setTargetAtTime(0.07 * mute, now, 0.2);

    // opponents: distance falloff, air absorption, stereo position and doppler
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      const o = others[i];
      if (!o) {
        v.gain.gain.setTargetAtTime(0, now, 0.1);
        continue;
      }
      const d = Math.hypot(o.x, o.y, o.z);
      const fall = clamp(1 - d / 110, 0, 1);
      const vol = (fall * fall * 0.9) / (1 + d * 0.04);
      const dop = clamp(343 / (343 - clamp(o.closing, -120, 120)), 0.75, 1.35);
      const fo = (this.kind === 'car' ? 40 + o.rpm * 190 : 34 + o.rpm * 150) * dop;
      v.o1.frequency.setTargetAtTime(fo, now, 0.05);
      v.o2.frequency.setTargetAtTime(fo * 0.5, now, 0.05);
      v.filt.frequency.setTargetAtTime(300 + 2600 * fall * fall + o.rpm * 600, now, 0.08);
      v.gain.gain.setTargetAtTime(vol * 0.09 * mute, now, 0.06);
      v.pan.pan.setTargetAtTime(clamp(o.x / Math.max(4, d), -0.9, 0.9), now, 0.05);
    }
  }

  // ---------------------------------------------------------------- one-shots

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0, dest?: AudioNode) {
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
    o.connect(g).connect(dest ?? this.sfx);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  private burst(type: BiquadFilterType, f0: number, f1: number, dur: number, vol: number, q = 1, delay = 0, bus?: AudioNode, attack = 0.01) {
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
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f).connect(g).connect(bus ?? this.sfx);
    s.start(t0, Math.random());
    s.stop(t0 + dur + 0.05);
  }

  /** exhaust pop: a very short dark noise crack with a thump under it */
  private pop(delay: number, v: number) {
    this.burst('lowpass', 1800 + Math.random() * 1200, 300, 0.07, 0.3 * v, 0.9, delay, undefined, 0.002);
    this.tone('sine', 110, 50, 0.06, 0.18 * v, delay);
  }

  play(name: string, v = 1) {
    if (!this.ctx) return;
    switch (name) {
      case 'boost':
        // whoomp + rising jet whoosh + a bright ping on top
        this.tone('sine', 160, 38, 0.5, 0.45);
        this.burst('bandpass', 300, 4200, 0.75, 0.3, 1.1, 0, undefined, 0.04);
        this.burst('highpass', 3000, 6000, 0.35, 0.08, 0.7, 0.05);
        this.tone('triangle', 1320, 1760, 0.18, 0.06, 0.02);
        this.pop(0, 0.8);
        break;
      case 'stage': {
        const k = 1 + (v - 1) * 0.26;
        this.tone('triangle', 660 * k, 660 * k, 0.12, 0.14);
        this.tone('triangle', 990 * k, 990 * k, 0.16, 0.11, 0.06);
        this.tone('sine', 1980 * k, 1980 * k, 0.2, 0.04, 0.06);
        break;
      }
      case 'drift':
        this.burst('bandpass', 1400, 900, 0.18, 0.1, 2);
        break;
      case 'hit': {
        const k = Math.min(1, v * 0.12);
        // crunch (mid noise) + body thump + metallic ring
        this.burst('bandpass', 2200, 500, 0.3, 0.5 * k, 0.8, 0, undefined, 0.002);
        this.burst('lowpass', 900, 200, 0.35, 0.4 * k);
        this.tone('sine', 95, 40, 0.25, 0.5 * k);
        this.tone('square', 740 + Math.random() * 300, 520, 0.18, 0.05 * k);
        break;
      }
      case 'land':
        this.tone('sine', 80, 32, 0.32, Math.min(0.6, v * 0.08));
        this.burst('lowpass', 600, 150, 0.28, Math.min(0.32, v * 0.045));
        this.burst('bandpass', 2400, 1200, 0.08, Math.min(0.12, v * 0.015), 1.5);
        break;
      case 'splash':
        this.burst('bandpass', 1300, 450, 0.55, Math.min(0.42, v * 0.05), 0.8);
        this.burst('lowpass', 420, 110, 0.35, Math.min(0.32, v * 0.04));
        this.burst('highpass', 4000, 2500, 0.6, Math.min(0.12, v * 0.015), 0.6, 0.08, undefined, 0.08);
        break;
      case 'count':
        this.tone('square', 660, 660, 0.14, 0.1);
        this.tone('sine', 1320, 1320, 0.14, 0.05);
        break;
      case 'go':
        this.tone('square', 1320, 1320, 0.55, 0.12);
        this.tone('square', 990, 990, 0.55, 0.07);
        this.tone('sine', 660, 660, 0.55, 0.1);
        break;
      case 'lap':
        [523, 659, 784].forEach((f, i) => this.tone('triangle', f, f, 0.16, 0.15, i * 0.08));
        break;
      case 'finish':
        [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone('triangle', f, f, 0.24, 0.17, i * 0.09));
        [1047, 1319, 1568].forEach((f) => this.tone('square', f, f, 0.9, 0.04, 0.5));
        this.burst('highpass', 5000, 3000, 1.2, 0.07, 0.5, 0.45, undefined, 0.3);
        break;
      case 'check':
        this.tone('triangle', 880, 1320, 0.14, 0.14);
        this.tone('sine', 1760, 1760, 0.12, 0.05, 0.07);
        break;
      case 'respawn':
        this.tone('sine', 300, 900, 0.25, 0.12);
        this.burst('bandpass', 800, 3000, 0.3, 0.06, 2);
        break;
      case 'land-good':
        [784, 1047, 1319].forEach((f, i) => this.tone('triangle', f, f, 0.12, 0.13, i * 0.06));
        break;
      case 'thunder':
        this.burst('lowpass', 2400, 400, 0.25, 0.35, 0.7, v, undefined, 0.003);
        this.burst('lowpass', 260, 50, 3.2, 0.75, 0.7, v + 0.05, undefined, 0.15);
        this.tone('sine', 55, 28, 1.8, 0.35, v);
        break;
      case 'ui':
        this.tone('triangle', 880, 880, 0.05, 0.08);
        break;
      case 'ui-ok':
        this.tone('triangle', 660, 1320, 0.12, 0.11);
        this.tone('sine', 1320, 1320, 0.1, 0.04, 0.05);
        break;
    }
  }

  // ---------------------------------------------------------------- music

  /**
   * Procedural 16-bar loop per theme: kick/snare/hats, sidechained bass and pad, a pluck arpeggio and
   * (final lap) a lead line built from the chord tones. The drum pattern drops out on the menu.
   */
  startMusic() {
    if (!this.ctx || this.musicOn) return;
    this.musicOn = true;
    this.nextBeat = this.ctx.currentTime + 0.1;
    this.step16 = 0;
    const tick = () => {
      if (!this.ctx || !this.musicOn) return;
      // after a hitch (tab switch, long frame) skip ahead instead of firing every missed note at once
      if (this.nextBeat < this.ctx.currentTime - 0.05) this.nextBeat = this.ctx.currentTime + 0.05;
      while (this.nextBeat < this.ctx.currentTime + 0.15) {
        this.musicStep(this.nextBeat - this.ctx.currentTime);
        const tu = this.tune;
        const sixteenth = 60 / tu.bpm / 4;
        const sw = this.step16 % 2 === 0 ? 1 + tu.swing : 1 - tu.swing;
        this.nextBeat += sixteenth * sw;
        this.step16++;
      }
      this.musicTimer = window.setTimeout(tick, 25);
    };
    tick();
  }

  stopMusic() {
    this.musicOn = false;
    clearTimeout(this.musicTimer);
  }

  private musicStep(delay: number) {
    const s = this.step16 % 256; // 16 bars of 16 sixteenths
    // theme change: switch on the next bar line instead of waiting out the whole phrase
    if (s % 16 === 0 && this.pendingTune) {
      this.tune = this.pendingTune;
      this.pendingTune = null;
    }
    const tu = this.tune;
    const spb = 60 / tu.bpm;
    const bar = Math.floor(s / 16);
    const e = s % 16;
    const [deg, major] = tu.prog[bar % 4];
    const root = tu.root + deg;
    const chord = major ? [0, 4, 7, 11] : [0, 3, 7, 10];
    const lvl = this.intensity;
    const fill = bar % 8 === 7 && e >= 12;
    const breakdown = lvl > 0 && bar >= 12 && bar < 14;

    if (lvl > 0 && !breakdown) {
      if (e % 4 === 0 && !(fill && e > 12)) {
        this.drum('kick', delay);
        this.duck(delay, spb * 0.45);
      }
      if (e === 4 || e === 12) this.drum('snare', delay);
      if (fill && e > 12) this.drum('snare', delay, 0.45 + (e - 12) * 0.15);
      const open = lvl > 1 && e % 4 === 2;
      this.drum(open ? 'open' : 'hat', delay, e % 4 === 2 ? 1 : e % 2 ? 0.45 : 0.7);
    } else if (lvl > 0 && breakdown) {
      if (e === 0) this.drum('kick', delay);
      if (e % 2 === 0) this.drum('hat', delay, 0.35);
    }

    // bass: root on the beat, octave pops on the offbeats
    if (lvl > 0 || e % 8 === 0) {
      if (e % 2 === 0) {
        const n = e % 8 === 6 ? root + 12 : e === 10 ? root + 7 : root;
        this.synth('sawtooth', midi(n), spb * (lvl > 0 ? 0.42 : 1.6), lvl > 0 ? 0.1 : 0.07, delay, lvl > 0 ? 650 : 400, this.musicDuck);
      }
    }
    // pad: the whole chord, one per bar
    if (e === 0) {
      for (const c of chord.slice(0, 3)) this.pad(midi(root + 24 + c), spb * 4, delay);
    }
    // arp: 16th pluck through the chord, up an octave on the back half of the bar
    const arpOn = lvl > 0 ? !breakdown || e % 2 === 0 : e % 4 === 0;
    if (arpOn) {
      const idx = [0, 1, 2, 3, 2, 1, 0, 2][e % 8];
      const n = root + 36 + chord[idx] + (e >= 8 && lvl > 0 ? 12 : 0);
      this.synth('square', midi(n), spb * 0.2, lvl > 0 ? 0.03 : 0.022, delay, lvl > 0 ? 2600 : 1400);
    }
    // lead: final lap only, simple motif on chord tones that answers itself every two bars
    if (lvl > 1 && !breakdown) {
      const motif = bar % 2 === 0 ? [0, -1, -1, 2, -1, -1, 1, -1, 3, -1, -1, 2, -1, 1, -1, -1] : [2, -1, -1, 1, -1, -1, 0, -1, 1, -1, 2, -1, -1, -1, -1, -1];
      const m = motif[e];
      if (m >= 0) this.lead(midi(root + 48 + chord[m]), spb * (m === 0 ? 0.7 : 0.45), delay);
    }
  }

  private duck(delay: number, len: number) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + Math.max(0, delay);
    const g = this.musicDuck.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.5, t0);
    g.linearRampToValueAtTime(1, t0 + len);
  }

  private synth(type: OscillatorType, f: number, dur: number, vol: number, delay: number, cutoff: number, dest: AudioNode = this.musicPause) {
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
    o.connect(fl).connect(g).connect(dest);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  private pad(f: number, dur: number, delay: number) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + Math.max(0, delay);
    const fl = ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.value = this.intensity > 0 ? 1400 : 900;
    fl.Q.value = 0.7;
    const g = ctx.createGain();
    const vol = this.intensity > 0 ? 0.018 : 0.026;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + dur * 0.2);
    g.gain.setValueAtTime(vol, t0 + dur * 0.75);
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    fl.connect(g).connect(this.musicDuck);
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(fl);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    }
  }

  private lead(f: number, dur: number, delay: number) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + Math.max(0, delay);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(f * 0.985, t0);
    o.frequency.exponentialRampToValueAtTime(f, t0 + 0.04);
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.5;
    const vg = ctx.createGain();
    vg.gain.value = f * 0.006;
    vib.connect(vg).connect(o.frequency);
    const fl = ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.035, t0 + 0.01);
    g.gain.setValueAtTime(0.035, t0 + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(fl).connect(g).connect(this.musicPause);
    o.start(t0);
    vib.start(t0);
    o.stop(t0 + dur + 0.02);
    vib.stop(t0 + dur + 0.02);
  }

  private drum(kind: 'kick' | 'snare' | 'hat' | 'open', delay: number, vel = 1) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + Math.max(0, delay);
    if (kind === 'kick') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(150, t0);
      o.frequency.exponentialRampToValueAtTime(44, t0 + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.55, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
      o.connect(g).connect(this.musicPause);
      o.start(t0);
      o.stop(t0 + 0.28);
      this.burst('highpass', 3000, 3000, 0.012, 0.05, 0.7, Math.max(0, delay), this.musicPause, 0.001);
    } else if (kind === 'snare') {
      this.burst('bandpass', 1900, 1200, 0.17, 0.22 * vel, 0.8, Math.max(0, delay), this.musicPause, 0.002);
      this.tone('triangle', 220, 160, 0.08, 0.1 * vel, Math.max(0, delay), this.musicPause);
    } else {
      const open = kind === 'open';
      this.burst('highpass', 7500, 6500, open ? 0.2 : 0.04, (open ? 0.05 : 0.055) * vel, 0.8, Math.max(0, delay), this.musicPause, 0.001);
    }
  }
}
