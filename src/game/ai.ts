import { Vector3 } from 'three';
import type { Controls } from '../core/input';
import { clamp, damp, lerp, moveToward, wrap } from '../core/math';
import type { Track } from '../track/track';
import { BOAT, CAR } from '../tuning/params';
import type { Vehicle } from '../vehicles/vehicle';

/** Lateral offset + target speed every STRIDE meters around the lap. */
export class RacingLine {
  readonly stride = 4;
  readonly m: number;
  readonly off: Float32Array;
  readonly speed: Float32Array;

  constructor(readonly track: Track, kind: 'car' | 'boat') {
    const m = Math.floor(track.length / this.stride);
    this.m = m;
    this.off = new Float32Array(m);
    this.speed = new Float32Array(m);
    const margin = kind === 'car' ? 3.0 : 5;
    const lim = track.hw - margin;
    const cx = new Float64Array(m), cz = new Float64Array(m), rx = new Float64Array(m), rz = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const k = Math.floor((i * this.stride) / track.step) % track.n;
      cx[i] = track.px[k]; cz[i] = track.pz[k]; rx[i] = track.rx[k]; rz[i] = track.rz[k];
    }
    // relaxation toward the chord midpoint = curvature minimizing line inside the lanes
    const o = this.off;
    for (let it = 0; it < 500; it++) {
      for (let i = 0; i < m; i++) {
        const a = (i - 2 + m) % m, b = (i + 2) % m;
        const ax = cx[a] + rx[a] * o[a], az = cz[a] + rz[a] * o[a];
        const bx = cx[b] + rx[b] * o[b], bz = cz[b] + rz[b] * o[b];
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const t = (mx - cx[i]) * rx[i] + (mz - cz[i]) * rz[i];
        o[i] = clamp(lerp(o[i], t, 0.55), -lim, lim);
      }
    }
    // curvature of the line -> speed limit, then a backward braking pass
    // close to what the physics can actually do (car grip turn measured ~12.5 m/s^2)
    const aLat = kind === 'car' ? 12 : 9.5;
    const aBrake = kind === 'car' ? 15 : 8;
    const vTop = kind === 'car' ? CAR.topSpeed : BOAT.topSpeed;
    const px = (i: number) => cx[(i + m) % m] + rx[(i + m) % m] * o[(i + m) % m];
    const pz = (i: number) => cz[(i + m) % m] + rz[(i + m) % m] * o[(i + m) % m];
    for (let i = 0; i < m; i++) {
      const ax = px(i - 2), az = pz(i - 2), bx = px(i), bz = pz(i), qx = px(i + 2), qz = pz(i + 2);
      const d1 = Math.hypot(bx - ax, bz - az), d2 = Math.hypot(qx - bx, qz - bz), d3 = Math.hypot(qx - ax, qz - az);
      const area2 = Math.abs((bx - ax) * (qz - az) - (bz - az) * (qx - ax));
      const k = (2 * area2) / Math.max(1e-6, d1 * d2 * d3);
      this.speed[i] = Math.min(vTop, Math.sqrt(aLat / Math.max(k, 1e-5)));
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let i = m - 1; i >= 0; i--) {
        const nx = this.speed[(i + 1) % m];
        this.speed[i] = Math.min(this.speed[i], Math.sqrt(nx * nx + 2 * aBrake * this.stride));
      }
    }
  }

  private idx(s: number) {
    return Math.floor(wrap(s, this.track.length) / this.stride) % this.m;
  }

  offsetAt(s: number) {
    const f = wrap(s, this.track.length) / this.stride;
    const i = Math.floor(f) % this.m, j = (i + 1) % this.m;
    return lerp(this.off[i], this.off[j], f - Math.floor(f));
  }

  speedAt(s: number) {
    return this.speed[this.idx(s)];
  }

  minSpeedAhead(s: number, dist: number) {
    let v = Infinity;
    for (let d = 0; d <= dist; d += this.stride) v = Math.min(v, this.speed[this.idx(s + d)]);
    return v;
  }
}

const _t = new Vector3();
const _l = new Vector3();
const _f = new Vector3();
const _r = new Vector3();

/**
 * Drives with the same physics and the same controls as the player: pure pursuit on the racing line,
 * speed profile from curvature, drifts through tight corners to earn boosts, sidesteps traffic.
 */
export class AIDriver {
  private laneT = 0;
  private lane = 0;
  private steer = 0;
  private driftHold = 0;
  private stuckT = 0;
  private reverseT = 0;
  rubber = 1;

  constructor(readonly line: RacingLine, readonly skill: number, readonly kind: 'car' | 'boat', readonly bias: number) {
    this.lane = bias;
  }

  update(dt: number, v: Vehicle, others: Vehicle[], gapToPlayer: number, out: Controls) {
    const tr = this.line.track;
    const s = v.proj.s;
    const spd = v.fwdSpeed;
    // traffic: pick a lane away from anything close ahead
    this.laneT -= dt;
    if (this.laneT <= 0) {
      this.laneT = 0.6;
      let want = this.bias;
      for (const o of others) {
        if (o === v) continue;
        let ds = o.proj.s - s;
        if (ds < -tr.length / 2) ds += tr.length;
        if (ds > tr.length / 2) ds -= tr.length;
        if (ds > -3 && ds < 16 && Math.abs(o.proj.d - (this.line.offsetAt(s) + this.lane)) < 2.8) {
          want = o.proj.d > this.line.offsetAt(s) ? -3.2 : 3.2;
        }
      }
      this.lane = want;
    }
    const look = 7 + Math.max(0, spd) * 0.42;
    const sa = s + look;
    const lim = tr.hw - 1.5;
    const d = clamp(this.line.offsetAt(sa) + this.lane, -lim, lim);
    tr.pointAt(sa, d, _t);
    v.forward(_f);
    v.right(_r);
    _l.subVectors(_t, v.body.pos);
    const ang = Math.atan2(_l.dot(_r), Math.max(0.1, _l.dot(_f)));
    const gain = this.kind === 'car' ? 2.6 : 2.2;
    this.steer = moveToward(this.steer, clamp(ang * gain, -1, 1), 6 * dt);

    // nosed into a wall: back out with opposite lock, then carry on
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      out.steer = -Math.sign(ang || 1);
      out.throttle = 0;
      out.brake = 1;
      out.drift = false;
      out.pitch = 0;
      return;
    }
    this.stuckT = spd < 1.2 ? this.stuckT + dt : 0;
    if (this.stuckT > 1.2) {
      this.stuckT = 0;
      this.reverseT = 1.1;
    }

    // rubber band: gentle, never teleports
    const rb = gapToPlayer > 70 ? 0.93 : gapToPlayer < -60 ? 1.05 : 1;
    this.rubber = damp(this.rubber, rb, 0.5, dt);
    v.powerScale = this.rubber * lerp(0.95, 1.0, this.skill);

    // the profile already contains the braking pass, so a short window is enough
    const target = this.line.minSpeedAhead(s, Math.max(8, spd * 0.6)) * this.skill * this.rubber;
    let throttle = spd < target - 1 ? 1 : spd < target + 1.5 ? 0.45 : 0;
    let brake = spd > target + 3 ? clamp((spd - target) / 7, 0, 1) : 0;

    // drift the tight stuff
    const curv = tr.avgCurvAhead(s, 8, 40);
    const need = Math.abs(curv) * spd * spd;
    if (this.driftHold > 0) {
      this.driftHold -= dt;
      if (need < 4 && v.drift.stage >= 1) this.driftHold = 0;
    } else if (need > (this.kind === 'car' ? 14 : 8) && spd > (this.kind === 'car' ? 22 : 14)) {
      this.driftHold = 1.2 + this.skill;
    }
    const drifting = this.driftHold > 0;
    if (drifting) {
      brake = 0;
      throttle = 1;
    }
    out.steer = drifting && Math.abs(this.steer) < 0.3 ? Math.sign(curv || this.steer) * 0.5 : this.steer;
    out.throttle = throttle;
    out.brake = brake;
    out.drift = drifting;
    out.pitch = 0;
  }
}
