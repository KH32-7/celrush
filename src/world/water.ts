/**
 * Gerstner wave field. ONE parameter array feeds both the CPU sampler (physics) and the GLSL
 * (rendering), so what the hull floats on is exactly what the player sees.
 */

export interface WaveSpec {
  /** travel direction in degrees, 0 = +X, 90 = +Z */
  dir: number;
  length: number;
  amp: number;
  /** 0..1 crest sharpness; normalized over the set so crests never loop */
  steep: number;
  speed?: number;
  phase?: number;
}

export const WAVESETS: Record<string, WaveSpec[]> = {
  harbor: [
    { dir: 20, length: 11, amp: 0.1, steep: 0.5 },
    { dir: -40, length: 7, amp: 0.07, steep: 0.5, phase: 1.3 },
    { dir: 75, length: 4.5, amp: 0.04, steep: 0.4, phase: 2.1 },
  ],
  bay: [
    { dir: 25, length: 36, amp: 0.55, steep: 0.55 },
    { dir: -20, length: 22, amp: 0.34, steep: 0.6, phase: 1.7 },
    { dir: 62, length: 13.5, amp: 0.2, steep: 0.55, phase: 3.1 },
    { dir: -72, length: 8.2, amp: 0.1, steep: 0.5, phase: 0.6 },
    { dir: 110, length: 4.6, amp: 0.05, steep: 0.45, phase: 4.4 },
  ],
  canyon: [
    { dir: 10, length: 16, amp: 0.26, steep: 0.5 },
    { dir: -55, length: 9.5, amp: 0.15, steep: 0.55, phase: 2.2 },
    { dir: 80, length: 5.5, amp: 0.07, steep: 0.45, phase: 0.9 },
  ],
  storm: [
    { dir: 12, length: 74, amp: 1.7, steep: 0.62, speed: 0.9 },
    { dir: -18, length: 46, amp: 1.0, steep: 0.62, phase: 1.1 },
    { dir: 40, length: 27, amp: 0.55, steep: 0.6, phase: 2.8 },
    { dir: -63, length: 15, amp: 0.3, steep: 0.55, phase: 4.0 },
    { dir: 95, length: 8.5, amp: 0.14, steep: 0.5, phase: 5.2 },
    { dir: -120, length: 5, amp: 0.07, steep: 0.45, phase: 0.3 },
  ],
};

export const MAX_WAVES = 8;
const G = 9.81;

export interface WaterSample {
  h: number;
  nx: number;
  ny: number;
  nz: number;
  vx: number;
  vy: number;
  vz: number;
}

export const newWaterSample = (): WaterSample => ({ h: 0, nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0 });

export class WaveField {
  n = 0;
  readonly dx = new Float64Array(MAX_WAVES);
  readonly dz = new Float64Array(MAX_WAVES);
  readonly k = new Float64Array(MAX_WAVES);
  readonly w = new Float64Array(MAX_WAVES);
  readonly a = new Float64Array(MAX_WAVES);
  readonly q = new Float64Array(MAX_WAVES);
  readonly ph = new Float64Array(MAX_WAVES);
  /** vec4[8]: dirX, dirZ, k, omega */
  readonly uA = new Float32Array(MAX_WAVES * 4);
  /** vec4[8]: amp, Q, phase, unused */
  readonly uB = new Float32Array(MAX_WAVES * 4);
  time = 0;
  maxAmp = 0;

  constructor(specs: WaveSpec[], ampScale = 1) {
    this.set(specs, ampScale);
  }

  set(specs: WaveSpec[], ampScale = 1) {
    const n = Math.min(specs.length, MAX_WAVES);
    this.n = n;
    this.maxAmp = 0;
    this.uA.fill(0);
    this.uB.fill(0);
    for (let i = 0; i < n; i++) {
      const s = specs[i];
      const r = (s.dir * Math.PI) / 180;
      const k = (2 * Math.PI) / s.length;
      const amp = s.amp * ampScale;
      this.dx[i] = Math.cos(r);
      this.dz[i] = Math.sin(r);
      this.k[i] = k;
      this.w[i] = Math.sqrt(G * k) * (s.speed ?? 1);
      this.a[i] = amp;
      this.q[i] = amp > 0 ? s.steep / (k * amp * n) : 0;
      this.ph[i] = s.phase ?? 0;
      this.maxAmp += amp;
      this.uA.set([this.dx[i], this.dz[i], k, this.w[i]], i * 4);
      this.uB.set([amp, this.q[i], this.ph[i], 0], i * 4);
    }
  }

  /** Displacement of the surface particle whose rest position is (x0, z0). */
  displace(x0: number, z0: number, t: number, out: { x: number; y: number; z: number }) {
    let ox = 0, oy = 0, oz = 0;
    for (let i = 0; i < this.n; i++) {
      const th = this.k[i] * (this.dx[i] * x0 + this.dz[i] * z0) - this.w[i] * t + this.ph[i];
      const c = Math.cos(th), s = Math.sin(th);
      const qa = this.q[i] * this.a[i];
      ox += qa * this.dx[i] * c;
      oz += qa * this.dz[i] * c;
      oy += this.a[i] * s;
    }
    out.x = ox; out.y = oy; out.z = oz;
    return out;
  }

  private tmp = { x: 0, y: 0, z: 0 };

  /** Rest position whose displaced surface lands on (x, z) - fixed-point inversion. */
  private invert(x: number, z: number, t: number, iters = 4) {
    let x0 = x, z0 = z;
    for (let it = 0; it < iters; it++) {
      this.displace(x0, z0, t, this.tmp);
      x0 = x - this.tmp.x;
      z0 = z - this.tmp.z;
    }
    return [x0, z0] as const;
  }

  heightAt(x: number, z: number, t = this.time) {
    if (this.n === 0) return 0;
    const [x0, z0] = this.invert(x, z, t, 3);
    let h = 0;
    for (let i = 0; i < this.n; i++) {
      h += this.a[i] * Math.sin(this.k[i] * (this.dx[i] * x0 + this.dz[i] * z0) - this.w[i] * t + this.ph[i]);
    }
    return h;
  }

  /** Height, normal and orbital particle velocity at world (x, z). */
  sample(x: number, z: number, out: WaterSample, t = this.time): WaterSample {
    if (this.n === 0) {
      out.h = 0; out.nx = 0; out.ny = 1; out.nz = 0; out.vx = 0; out.vy = 0; out.vz = 0;
      return out;
    }
    const [x0, z0] = this.invert(x, z, t, 4);
    let h = 0, nx = 0, ny = 1, nz = 0, vx = 0, vy = 0, vz = 0;
    for (let i = 0; i < this.n; i++) {
      const th = this.k[i] * (this.dx[i] * x0 + this.dz[i] * z0) - this.w[i] * t + this.ph[i];
      const c = Math.cos(th), s = Math.sin(th);
      const a = this.a[i], wa = this.k[i] * a, qa = this.q[i] * a;
      h += a * s;
      nx -= this.dx[i] * wa * c;
      nz -= this.dz[i] * wa * c;
      ny -= this.q[i] * wa * s;
      vx += qa * this.dx[i] * this.w[i] * s;
      vz += qa * this.dz[i] * this.w[i] * s;
      vy -= a * this.w[i] * c;
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    out.h = h; out.nx = nx / l; out.ny = ny / l; out.nz = nz / l;
    out.vx = vx; out.vy = vy; out.vz = vz;
    return out;
  }
}

/** GLSL twin of WaveField.displace + analytic normal + Jacobian (for crest foam). */
export const GERSTNER_GLSL = /* glsl */ `
uniform vec4 uWaveA[${MAX_WAVES}];
uniform vec4 uWaveB[${MAX_WAVES}];
uniform int uWaveCount;
uniform float uTime;

void gerstner(vec2 p, out vec3 disp, out vec3 nrm, out float jac) {
  disp = vec3(0.0);
  vec3 n = vec3(0.0, 1.0, 0.0);
  float jxx = 1.0, jzz = 1.0, jxz = 0.0;
  for (int i = 0; i < ${MAX_WAVES}; i++) {
    if (i >= uWaveCount) break;
    vec4 A = uWaveA[i];
    vec4 B = uWaveB[i];
    float th = A.z * dot(A.xy, p) - A.w * uTime + B.z;
    float c = cos(th), s = sin(th);
    float qa = B.y * B.x;
    float wa = A.z * B.x;
    disp.x += qa * A.x * c;
    disp.z += qa * A.y * c;
    disp.y += B.x * s;
    n.x -= A.x * wa * c;
    n.z -= A.y * wa * c;
    n.y -= B.y * wa * s;
    jxx -= B.y * wa * A.x * A.x * s;
    jzz -= B.y * wa * A.y * A.y * s;
    jxz -= B.y * wa * A.x * A.y * s;
  }
  nrm = normalize(n);
  jac = jxx * jzz - jxz * jxz;
}
`;
