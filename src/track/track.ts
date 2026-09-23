import { Vector3 } from 'three';
import { angleDiff, clamp, wrap } from '../core/math';
import type { CourseDef } from './courses';
import { resampleClosed, type P3 } from './spline';

export interface TrackProj {
  s: number;
  d: number;
  idx: number;
  cy: number;
  bank: number;
}

export const newProj = (): TrackProj => ({ s: 0, d: 0, idx: -1, cy: 0, bank: 0 });

export interface TrackFrame {
  pos: Vector3;
  tan: Vector3;
  right: Vector3;
  up: Vector3;
}

const CELL = 24;

/**
 * Uniformly sampled closed centerline with derived profiles.
 * Lateral offset d is measured along the HORIZONTAL right vector; +d = right of travel direction.
 * Surface height at (s, d) = cy(s) + d * tan(bank(s)).
 */
export class Track {
  readonly def: CourseDef;
  readonly n: number;
  readonly length: number;
  readonly step: number;
  readonly hw: number;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  readonly tx: Float32Array;
  readonly ty: Float32Array;
  readonly tz: Float32Array;
  readonly rx: Float32Array;
  readonly rz: Float32Array;
  readonly bank: Float32Array;
  /** signed horizontal curvature (1/m), + = turning right */
  readonly curv: Float32Array;
  private grid = new Map<number, number[]>();
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;

  constructor(def: CourseDef) {
    this.def = def;
    this.hw = def.halfWidth;
    const ctrl: P3[] = def.pts.map(([x, y, z]) => [x * def.scale, y, z * def.scale]);
    const { pts, length } = resampleClosed(ctrl, 1);
    const n = pts.length / 3;
    this.n = n;
    this.length = length;
    this.step = length / n;
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.pz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.px[i] = pts[i * 3];
      this.py[i] = pts[i * 3 + 1];
      this.pz[i] = pts[i * 3 + 2];
    }
    this.tx = new Float32Array(n);
    this.ty = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.rx = new Float32Array(n);
    this.rz = new Float32Array(n);
    this.curv = new Float32Array(n);
    this.bank = new Float32Array(n);
    const heading = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      let dx = this.px[b] - this.px[a], dy = this.py[b] - this.py[a], dz = this.pz[b] - this.pz[a];
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      this.tx[i] = dx; this.ty[i] = dy; this.tz[i] = dz;
      const lh = Math.hypot(dx, dz) || 1;
      this.rx[i] = -dz / lh;
      this.rz[i] = dx / lh;
      heading[i] = Math.atan2(dx, -dz);
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 2 + n) % n, b = (i + 2) % n;
      this.curv[i] = angleDiff(heading[a], heading[b]) / (4 * this.step);
    }
    // smooth curvature for banking so the road never twists abruptly
    const win = Math.round(22 / this.step);
    const pref = new Float64Array(n * 3 + 1);
    for (let i = 0; i < n * 3; i++) pref[i + 1] = pref[i] + this.curv[i % n];
    for (let i = 0; i < n; i++) {
      const c = i + n;
      const avg = (pref[c + win + 1] - pref[c - win]) / (2 * win + 1);
      // right turn (+curv) -> outside (left, -d) higher -> negative bank
      this.bank[i] = -clamp(avg * def.bankScale, -def.maxBank, def.maxBank);
    }

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const key = this.cellKey(this.px[i], this.pz[i]);
      let arr = this.grid.get(key);
      if (!arr) this.grid.set(key, (arr = []));
      arr.push(i);
      minX = Math.min(minX, this.px[i]); maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]); maxZ = Math.max(maxZ, this.pz[i]);
    }
    this.minX = minX; this.maxX = maxX; this.minZ = minZ; this.maxZ = maxZ;
  }

  private cellKey(x: number, z: number) {
    const cx = Math.floor(x / CELL) + 4096, cz = Math.floor(z / CELL) + 4096;
    return cx * 8192 + cz;
  }

  wrapS(s: number) {
    return wrap(s, this.length);
  }

  /** linear interpolation of a per-sample profile at arc length s */
  interp(arr: ArrayLike<number>, s: number) {
    const f = this.wrapS(s) / this.step;
    const i = Math.floor(f) % this.n;
    const j = (i + 1) % this.n;
    const t = f - Math.floor(f);
    return arr[i] + (arr[j] - arr[i]) * t;
  }

  /** Center-line frame at s. up is tilted by bank; right lies on the banked surface. */
  frameAt(s: number, out: TrackFrame) {
    const f = this.wrapS(s) / this.step;
    const i = Math.floor(f) % this.n;
    const j = (i + 1) % this.n;
    const t = f - Math.floor(f);
    out.pos.set(
      this.px[i] + (this.px[j] - this.px[i]) * t,
      this.py[i] + (this.py[j] - this.py[i]) * t,
      this.pz[i] + (this.pz[j] - this.pz[i]) * t,
    );
    out.tan.set(
      this.tx[i] + (this.tx[j] - this.tx[i]) * t,
      this.ty[i] + (this.ty[j] - this.ty[i]) * t,
      this.tz[i] + (this.tz[j] - this.tz[i]) * t,
    ).normalize();
    const bank = this.bank[i] + (this.bank[j] - this.bank[i]) * t;
    const rx = this.rx[i] + (this.rx[j] - this.rx[i]) * t;
    const rz = this.rz[i] + (this.rz[j] - this.rz[i]) * t;
    const tb = Math.tan(bank);
    out.right.set(rx, tb, rz).normalize();
    out.up.crossVectors(out.right, out.tan).normalize();
    return out;
  }

  /** Surface point at (s, d). */
  pointAt(s: number, d: number, out: Vector3) {
    const f = this.wrapS(s) / this.step;
    const i = Math.floor(f) % this.n;
    const j = (i + 1) % this.n;
    const t = f - Math.floor(f);
    const rx = this.rx[i] + (this.rx[j] - this.rx[i]) * t;
    const rz = this.rz[i] + (this.rz[j] - this.rz[i]) * t;
    const inv = 1 / (Math.hypot(rx, rz) || 1);
    const bank = this.bank[i] + (this.bank[j] - this.bank[i]) * t;
    out.set(
      this.px[i] + (this.px[j] - this.px[i]) * t + rx * inv * d,
      this.py[i] + (this.py[j] - this.py[i]) * t + d * Math.tan(bank),
      this.pz[i] + (this.pz[j] - this.pz[i]) * t + rz * inv * d,
    );
    return out;
  }

  /**
   * Nearest centerline location to (x, z). With a valid hint the search is local (cheap, and never jumps
   * to a different part of the course); without one it uses the spatial grid.
   */
  project(x: number, z: number, hint: number, out: TrackProj): TrackProj {
    let best = -1, bd = Infinity;
    const n = this.n;
    if (hint >= 0) {
      const R = 10;
      for (let k = -R; k <= R; k++) {
        const i = (hint + k + n) % n;
        const dx = x - this.px[i], dz = z - this.pz[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; best = i; }
      }
      // hint lost (teleport, huge speed): fall back
      const lim = this.hw + 60;
      if (bd > lim * lim) best = -1;
      else {
        // walk further if the minimum sits on the window edge
        let guard = 0;
        while (guard++ < 400) {
          const a = (best + 1) % n, b = (best - 1 + n) % n;
          const da = (x - this.px[a]) ** 2 + (z - this.pz[a]) ** 2;
          const db = (x - this.px[b]) ** 2 + (z - this.pz[b]) ** 2;
          if (da < bd) { bd = da; best = a; } else if (db < bd) { bd = db; best = b; } else break;
        }
      }
    }
    if (best < 0) {
      bd = Infinity;
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      for (let r = 1; r <= 3 && best < 0; r++) {
        for (let ix = -r; ix <= r; ix++) {
          for (let iz = -r; iz <= r; iz++) {
            const arr = this.grid.get((cx + ix + 4096) * 8192 + (cz + iz + 4096));
            if (!arr) continue;
            for (const i of arr) {
              const d2 = (x - this.px[i]) ** 2 + (z - this.pz[i]) ** 2;
              if (d2 < bd) { bd = d2; best = i; }
            }
          }
        }
      }
      if (best < 0) {
        for (let i = 0; i < n; i += 2) {
          const d2 = (x - this.px[i]) ** 2 + (z - this.pz[i]) ** 2;
          if (d2 < bd) { bd = d2; best = i; }
        }
      }
    }
    const i = best;
    const rx = this.rx[i], rz = this.rz[i];
    const thx = rz, thz = -rx; // horizontal tangent from right vector
    const dx = x - this.px[i], dz = z - this.pz[i];
    const along = dx * thx + dz * thz;
    const s = this.wrapS(i * this.step + along);
    out.idx = i;
    out.s = s;
    // interpolate right vector at the refined position for an accurate lateral offset
    const f = s / this.step;
    const i0 = Math.floor(f) % n, i1 = (i0 + 1) % n, t = f - Math.floor(f);
    const cx = this.px[i0] + (this.px[i1] - this.px[i0]) * t;
    const cz = this.pz[i0] + (this.pz[i1] - this.pz[i0]) * t;
    const rrx = this.rx[i0] + (this.rx[i1] - this.rx[i0]) * t;
    const rrz = this.rz[i0] + (this.rz[i1] - this.rz[i0]) * t;
    const inv = 1 / (Math.hypot(rrx, rrz) || 1);
    out.d = (x - cx) * rrx * inv + (z - cz) * rrz * inv;
    out.cy = this.py[i0] + (this.py[i1] - this.py[i0]) * t;
    out.bank = this.bank[i0] + (this.bank[i1] - this.bank[i0]) * t;
    return out;
  }

  /** max |curvature| over [s, s+dist] */
  maxCurvAhead(s: number, dist: number) {
    let m = 0;
    const a = Math.floor(this.wrapS(s) / this.step);
    const cnt = Math.ceil(dist / this.step);
    for (let k = 0; k < cnt; k++) m = Math.max(m, Math.abs(this.curv[(a + k) % this.n]));
    return m;
  }

  /** signed curvature averaged over a window ahead */
  avgCurvAhead(s: number, from: number, to: number) {
    const a = Math.floor(this.wrapS(s + from) / this.step);
    const cnt = Math.max(1, Math.ceil((to - from) / this.step));
    let sum = 0;
    for (let k = 0; k < cnt; k++) sum += this.curv[(a + k) % this.n];
    return sum / cnt;
  }
}
