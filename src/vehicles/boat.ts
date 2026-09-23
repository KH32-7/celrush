import { Matrix4, Vector3 } from 'three';
import { clamp, lerp, moveToward, smoothstep } from '../core/math';
import { contactStatic, RigidBody } from '../physics/rigidbody';
import { BOAT as P } from '../tuning/params';
import type { TrackFrame } from '../track/track';
import { newProj } from '../track/track';
import { newWaterSample } from '../world/water';
import { hullStation, HULL_STERN_Z } from './boatHull';
import { DriftEvent } from './drift';
import { Vehicle, type SimEnv } from './vehicle';

interface HullPoint {
  p: Vector3;
  n: Vector3;
  area: number;
  col: number;
  aft: boolean;
  /** last submersion depth, for slam detection */
  depth: number;
}

const G = 9.81;
const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _P = new Vector3();
const _F = new Vector3();
const _v = new Vector3();
const _nW = new Vector3();
const _t = new Vector3();
const _n = new Vector3();
const _wv = new Vector3();
const _mat = new Matrix4();
const _frame: TrackFrame = { pos: new Vector3(), tan: new Vector3(), right: new Vector3(), up: new Vector3() };
const _proj = newProj();
const _ws = newWaterSample();

/**
 * Planing speedboat. Forces come from ~40 hull sample points:
 *  - buoyancy: each point owns a vertical water column (Archimedes per column)
 *  - hydrodynamic pressure on the point's outward normal (planing lift at speed, slam on wave impacts)
 *  - anisotropic drag in the hull frame (keel resists sideways motion, small drag along the hull)
 * Propulsion is a vectored outboard that only pushes while the prop is under water.
 */
export class Boat extends Vehicle {
  readonly kind = 'boat' as const;
  body: RigidBody;
  points: HullPoint[] = [];
  readonly propLocal = new Vector3(0, -0.52, HULL_STERN_Z + 0.12);
  readonly spheres = [
    { p: new Vector3(0, 0.1, -1.7), r: 1.0 },
    { p: new Vector3(0, 0.1, 0), r: 1.15 },
    { p: new Vector3(0, 0.1, 1.7), r: 1.1 },
  ];
  private corners: Vector3[] = [];
  wetRatio = 0;
  propSub = 0;
  steerAngle = 0;
  /** 0..1 how much of the hull is lifted out (for spray FX) */
  planing = 0;
  bowWet = 0;
  needsRespawn = false;
  private lastVy = 0;
  private totalArea = 0;
  landingPitch = 0;
  surfBoost = 0;

  constructor() {
    super();
    this.body = new RigidBody(P.mass, new Vector3(...P.size), new Vector3(...P.inertiaScale));
    this.body.angularDrag = 0.1;
    this.buildPoints();
  }

  private buildPoints() {
    const S = P.stations;
    let area = 0;
    for (let i = 0; i < S; i++) {
      const u = (i + 0.5) / S;
      const st = hullStation(u);
      const dz = P.hullLength / S;
      const stA = hullStation(Math.max(0, u - 0.5 / S));
      const stB = hullStation(Math.min(1, u + 0.5 / S));
      // keel rake: how much the bottom rises toward the bow at this station (bow normals lean forward)
      const rake = (stB.keelY - stA.keelY) / dz;
      const hb = st.halfBeam;
      const dead = Math.atan2(st.chineY - st.keelY, hb);
      const stripArea = 2 * hb * dz;
      const pts: [number, number, number, number][] = [
        // x, y, nx (side lean), share of strip area
        [0, st.keelY, 0, 0.22],
        [-hb * 0.5, (st.keelY + st.chineY) / 2, -Math.sin(dead), 0.24],
        [hb * 0.5, (st.keelY + st.chineY) / 2, Math.sin(dead), 0.24],
        [-hb * 0.95, st.chineY, -0.55, 0.15],
        [hb * 0.95, st.chineY, 0.55, 0.15],
      ];
      for (const [x, y, nx, share] of pts) {
        const n = new Vector3(nx, -Math.cos(Math.abs(nx) > 0.5 ? 0.9 : dead), -rake).normalize();
        const a = stripArea * share;
        area += a;
        this.points.push({ p: new Vector3(x, y, st.z), n, area: a, col: st.deckY - y, aft: u < 0.45, depth: 0 });
      }
    }
    const scale = P.waterplaneArea / area;
    for (const pt of this.points) pt.area *= scale;
    this.totalArea = P.waterplaneArea;
    // collision corners: bow tip, shoulders, transom corners
    const bow = hullStation(1), sh = hullStation(0.72), tr = hullStation(0);
    this.corners = [
      new Vector3(0, bow.deckY - 0.1, bow.z),
      new Vector3(-sh.halfBeam, 0.2, sh.z), new Vector3(sh.halfBeam, 0.2, sh.z),
      new Vector3(-tr.halfBeam, 0.2, tr.z), new Vector3(tr.halfBeam, 0.2, tr.z),
      new Vector3(-tr.halfBeam, 0.2, 0), new Vector3(tr.halfBeam, 0.2, 0),
    ];
  }

  place(env: SimEnv, s: number, d: number) {
    const tr = env.track;
    tr.frameAt(s, _frame);
    tr.pointAt(s, d, _P);
    const b = this.body;
    const h = env.water ? env.water.heightAt(_P.x, _P.z) : 0;
    b.pos.set(_P.x, h + 0.22, _P.z);
    _fwd.copy(_frame.tan).setY(0).normalize();
    _right.crossVectors(_fwd, _up.set(0, 1, 0)).normalize();
    _up.crossVectors(_right, _fwd);
    _mat.makeBasis(_right, _up, _t.copy(_fwd).negate());
    b.quat.setFromRotationMatrix(_mat);
    b.vel.set(0, 0, 0);
    b.angVel.set(0, 0, 0);
    b.updateInertiaWorld();
    this.proj.idx = -1;
    tr.project(b.pos.x, b.pos.z, -1, this.proj);
    this.drift.cancel();
    this.drift.boostTime = 0;
    this.savePrev();
    this.upsideT = 0;
    this.stuckT = 0;
    this.needsRespawn = false;
  }

  step(dt: number, env: SimEnv) {
    const b = this.body;
    const water = env.water!;
    const tr = env.track;
    const c = this.controls;
    this.savePrev();
    this.measure();
    tr.project(b.pos.x, b.pos.z, this.proj.idx, this.proj);
    const fwd = this.forward(_fwd), right = this.right(_right), up = this.up(_up);
    const vF = this.fwdSpeed;
    const vAbs = Math.abs(vF);
    const wet0 = this.wetRatio > 0.04;

    // ---------- drift ----------
    const ev = this.drift.update(dt, c, { speed: vF, slip: this.slip, grounded: wet0, minSpeed: P.drift.minSpeed });
    if (ev & DriftEvent.Start) this.events.driftStart = true;
    if (ev & DriftEvent.StageUp) this.events.stageUp = this.drift.stage;
    if (ev & DriftEvent.Boost) this.events.boost = this.drift.lastStage;
    const drifting = this.drift.active;

    // water particle velocity at the hull center + river current
    water.sample(b.pos.x, b.pos.z, _ws);
    _wv.set(_ws.vx, _ws.vy, _ws.vz);
    if (env.current !== 0) {
      const i = this.proj.idx;
      const prof = 1 - clamp(Math.abs(this.proj.d) / (tr.hw + 4), 0, 1) ** 2;
      _wv.x += tr.rz[i] * env.current * prof;
      _wv.z += -tr.rx[i] * env.current * prof;
    }

    // ---------- hull points ----------
    let wetArea = 0;
    let bowWet = 0;
    let slam = 0;
    const rhoG = P.rho * G;
    for (const pt of this.points) {
      b.localToWorld(pt.p, _P);
      const h = water.heightAt(_P.x, _P.z);
      const depth = h - _P.y;
      const prevDepth = pt.depth;
      pt.depth = depth;
      if (depth <= 0) continue;
      const sub = Math.min(depth, pt.col);
      const frac = Math.min(1, depth / 0.1);
      wetArea += pt.area * frac;
      if (!pt.aft && pt.p.z < -1.3) bowWet += frac;
      _F.set(0, rhoG * pt.area * sub, 0);

      b.pointVelocity(_P, _v).sub(_wv);
      _F.y -= P.heaveDamping * pt.area * _v.y * frac;

      b.dirToWorld(pt.n, _nW);
      const vn = _v.dot(_nW);
      if (vn > 0) {
        _F.addScaledVector(_nW, -pt.area * (P.planeLinear * vn + P.planeQuad * vn * vn) * frac);
        if (prevDepth <= 0 && vn > 3.5) slam = Math.max(slam, vn);
      } else {
        _F.addScaledVector(_nW, pt.area * P.suction * P.planeLinear * -vn * frac);
      }

      const vl = _v.dot(fwd), vt = _v.dot(right);
      // power-slide: stern lets go almost completely, the bow keeps a little bite
      const latMul = drifting ? (pt.aft ? P.drift.latDragMul : P.drift.latDragFore) : 1;
      _F.addScaledVector(fwd, -P.dragLong * pt.area * vl * Math.abs(vl) * frac);
      b.addForceAtPoint(_F, _P);
      // keel side force acts near the COM height: applied at the true depth it would heel the hull
      // outward in every turn, the opposite of what a planing hull does
      const latF = -(P.dragLat * 2.2 * vt + P.dragLat * 0.55 * vt * Math.abs(vt)) * pt.area * frac * latMul;
      _P.addScaledVector(up, -pt.p.y * 0.8);
      b.addForceAtPoint(_t.copy(right).multiplyScalar(latF), _P);
    }
    this.wetRatio = wetArea / this.totalArea;
    this.bowWet = bowWet / 10;
    const wet = this.wetRatio > 0.04;
    this.grounded = wet;
    if (slam > 0) this.events.splash = Math.max(this.events.splash, slam);
    this.planing = clamp((vAbs - 10) / 14, 0, 1) * clamp(1 - this.wetRatio * 1.4, 0, 1);

    b.force.y -= G * b.mass;

    // ---------- propulsion ----------
    b.localToWorld(this.propLocal, _P);
    const propDepth = water.heightAt(_P.x, _P.z) - _P.y;
    this.propSub = clamp((propDepth + 0.12) / 0.3, 0, 1);
    const boosting = this.drift.boosting;
    let vTop = P.topSpeed * this.powerScale * (drifting ? P.drift.topSpeedMul : 1);
    let thrust = 0;
    if (c.throttle > 0.05) thrust = c.throttle * P.thrust * this.powerScale * Math.max(0, 1 - (Math.max(vF, 0) / vTop) ** 3);
    if (c.brake > 0.05) thrust -= c.brake * P.reverseThrust * (vF > 1 ? 1.6 : 1) * (vF < -6 ? 0 : 1);
    if (boosting) {
      vTop = P.boostTop;
      thrust += P.boostThrust * clamp(1 - vF / P.boostTop, 0, 1);
    }
    if (this.surfBoost > 0) {
      thrust += 3000 * clamp(1 - vF / P.boostTop, 0, 1);
      this.surfBoost -= dt;
    }
    const steerMax = lerp(P.outboardSteer, P.outboardSteer * 0.55, smoothstep(5, 28, vAbs));
    this.steerAngle = moveToward(this.steerAngle, c.steer * steerMax, 3.5 * dt);
    const sd = Math.sin(this.steerAngle), cd = Math.cos(this.steerAngle);
    _t.copy(fwd).multiplyScalar(cd).addScaledVector(right, -sd).multiplyScalar(thrust * this.propSub);
    b.addForceAtPoint(_t, _P);
    // skeg side force: a turned lower unit steers even off-throttle
    b.addForceAtPoint(_t.copy(right).multiplyScalar(-sd * P.rudderLift * vF * Math.abs(vF) * this.propSub), _P);

    // ---------- arcade handling layer (only while in the water) ----------
    const r = -b.angVel.dot(up);
    if (wet) {
      const speedN = smoothstep(0.5, 10, vAbs);
      const into = drifting ? clamp(c.steer * this.drift.dir, -1, 1) : 0;
      let rDes: number;
      // yaw-rate targets are capped by speed so lateral acceleration stays near 1.1-1.5 g
      if (drifting) {
        const turnRate = this.drift.dir * lerp(0.5, 1.0, (into + 1) / 2) * Math.min(1.3, 17 / Math.max(vAbs, 1)) * speedN;
        const a = -turnRate * P.drift.carve * dt;
        const ca = Math.cos(a), sa = Math.sin(a);
        const vx = b.vel.x, vz = b.vel.z;
        b.vel.x = vx * ca + vz * sa;
        b.vel.z = -vx * sa + vz * ca;
        const betaT = this.drift.dir * lerp(P.drift.angleMin, P.drift.angleMax, (into + 1) / 2);
        rDes = clamp(turnRate + P.drift.yawKp * (betaT - this.slip), -1.5, 1.5);
      } else {
        rDes = c.steer * Math.min(1.2, 11.5 / Math.max(vAbs, 1)) * speedN * Math.sign(vF || 1);
      }
      const gain = drifting ? P.drift.yawKd : P.turnAssist;
      const tauR = (rDes - r) * gain * b.inertia.y * clamp(this.wetRatio * 3, 0.3, 1);
      b.addTorque(_t.copy(up).multiplyScalar(-tauR));
      // heel into the turn in proportion to lateral acceleration (roll PD), like a planing hull carving
      const aLat = r * vF;
      let heelT = clamp((aLat / G) * P.bankIntoTurn * 0.2, -0.3, 0.3);
      if (drifting) heelT = clamp(heelT + this.drift.dir * 0.06, -0.36, 0.36);
      const heel = -Math.asin(clamp(right.y, -1, 1));
      const rollRate = b.angVel.dot(fwd);
      b.addTorque(_t.copy(fwd).multiplyScalar(((heelT - heel) * 14 - rollRate * 4.5) * b.inertia.z * clamp(this.wetRatio * 3, 0.2, 1)));
      // planing layer: dynamic lift raises the hull (less wetted area, less drag) and the hull trims
      // bow-up through the "hump" near 11 m/s before settling around 4 degrees on the plane
      const wetF = clamp(this.wetRatio * 2.5, 0, 1);
      const planeF = smoothstep(5, 19, vF);
      _P.set(0, 0, -0.5).applyQuaternion(b.quat).add(b.pos);
      b.addForceAtPoint(_t.copy(up).multiplyScalar(b.mass * G * P.planeLift * planeF * wetF), _P);
      const hump = smoothstep(2, 10, vF) * (1 - 0.6 * smoothstep(12, 26, vF));
      const trimT = 0.02 + P.trimHump * hump + (boosting ? 0.03 : 0);
      const trim = Math.asin(clamp(fwd.y, -1, 1));
      const pitchRate = b.angVel.dot(right);
      b.addTorque(_t.copy(right).multiplyScalar(((trimT - trim) * P.trimKp - pitchRate * P.trimKd) * b.inertia.x * wetF * smoothstep(1, 6, vF)));
      // surfing: slide down the local wave slope
      if (_ws.ny > 0.2) {
        b.force.x += b.mass * G * P.surfSlope * (_ws.nx / _ws.ny) * this.wetRatio * 2.2;
        b.force.z += b.mass * G * P.surfSlope * (_ws.nz / _ws.ny) * this.wetRatio * 2.2;
      }
      // self-righting when heeled past ~60 degrees (arcade: capsizing is not fun)
      if (up.y < 0.5) {
        _n.set(0, 1, 0).cross(up).negate();
        b.addTorque(_t.copy(_n).multiplyScalar(6 * b.inertia.z * (0.5 - up.y)));
      }
    }

    // ---------- air ----------
    if (!wet) {
      this.airTime += dt;
      this.lastVy = b.vel.y;
      b.addTorque(_t.copy(right).multiplyScalar(c.pitch * P.air.pitch * b.inertia.x));
      b.addTorque(_t.copy(up).multiplyScalar(-c.steer * P.air.yaw * b.inertia.y));
      const rollErr = _n.set(0, 1, 0).crossVectors(up, _n).dot(fwd);
      const rollRate = b.angVel.dot(fwd);
      b.addTorque(_t.copy(fwd).multiplyScalar((rollErr * P.air.level - rollRate * 1.2) * b.inertia.z));
      b.angVel.multiplyScalar(Math.exp(-0.8 * dt));
    } else if (this.airTime > 0) {
      if (this.airTime > 0.55) {
        this.events.landed = Math.max(this.events.landed, -this.lastVy);
        // landing grade: pitch relative to the wave surface under the hull
        const surfPitch = Math.asin(clamp(-(_ws.nx * fwd.x + _ws.nz * fwd.z), -1, 1));
        const pitch = Math.asin(clamp(fwd.y, -1, 1));
        this.landingPitch = pitch - surfPitch;
        if (Math.abs(this.landingPitch) < P.landingGood && vF > 10) {
          // every clean landing earns the surge; only real jumps get the callout
          if (this.airTime > 0.8) this.events.cleanLanding = true;
          this.surfBoost = 0.6;
        } else if (this.landingPitch < -P.landingGood) {
          // nose-dive: bleed speed hard
          b.vel.multiplyScalar(0.82);
        }
      }
      this.airTime = 0;
    }

    b.integrate(dt);

    // ---------- collisions ----------
    const wallD = tr.hw + tr.def.runoff;
    for (const lc of this.corners) {
      b.localToWorld(lc, _P);
      tr.project(_P.x, _P.z, this.proj.idx, _proj);
      const ad = Math.abs(_proj.d);
      if (ad > wallD) {
        const i = _proj.idx;
        const sg = Math.sign(_proj.d);
        _n.set(-sg * tr.rx[i], 0, -sg * tr.rz[i]).normalize();
        const jn = contactStatic(b, _P, _n, ad - wallD, P.wallRestitution, P.wallFriction);
        const dv = jn / b.mass;
        if (dv > this.events.wallHit) {
          this.events.wallHit = dv;
          this.events.wallPoint.copy(_P);
        }
        if (dv > 4 && this.drift.active) this.drift.cancel();
      }
    }
    for (const s of env.spheres) {
      const dx = b.pos.x - s.pos.x, dz = b.pos.z - s.pos.z;
      if (dx * dx + dz * dz > (s.r + 4) ** 2) continue;
      for (const sp of this.spheres) {
        b.localToWorld(sp.p, _P);
        _n.subVectors(_P, s.pos);
        _n.y *= 0.3;
        const dist = _n.length();
        const pen = sp.r + s.r - dist;
        if (pen > 0 && dist > 1e-4) {
          _n.multiplyScalar(1 / dist);
          _t.copy(_P).addScaledVector(_n, -sp.r);
          const jn = contactStatic(b, _t, _n, pen, 0.35, 0.1);
          const dv = jn / b.mass;
          if (dv > 0.5) s.kick.addScaledVector(_n, -Math.min(dv, 6) * 0.35);
          if (dv > this.events.wallHit) {
            this.events.wallHit = dv;
            this.events.wallPoint.copy(_t);
          }
        }
      }
    }
    for (const rp of env.ramps) this.collideRamp(rp);

    // ---------- telemetry ----------
    let rpmT = clamp(vAbs / (vTop * 0.95), 0.18, 1) * (0.55 + 0.45 * c.throttle);
    if (this.propSub < 0.3 && c.throttle > 0.1) rpmT = 1; // prop out of water: engine screams
    this.rpm = moveToward(this.rpm, rpmT, (rpmT > this.rpm ? 2.5 : 1.8) * dt);
    this.skid = drifting ? 0.8 : clamp(Math.abs(this.slip) * 3 - 0.3, 0, 1);

    this.upsideT = up.y < 0.05 ? this.upsideT + dt : 0;
    this.stuckT = c.throttle > 0.5 && vAbs < 1.2 ? this.stuckT + dt : 0;
    if (this.upsideT > 2 || this.stuckT > 4 || b.pos.y < -30 || !b.isFinite()) this.needsRespawn = true;
    if (this.ghostT > 0) this.ghostT -= dt;
  }

  private collideRamp(rp: import('./vehicle').RampShape) {
    const b = this.body;
    const dx = b.pos.x - rp.pos.x, dz = b.pos.z - rp.pos.z;
    if (dx * dx + dz * dz > (rp.len + 8) ** 2) return;
    const slope = rp.height / rp.len;
    const invLen = 1 / Math.hypot(1, slope);
    for (const pt of this.points) {
      b.localToWorld(pt.p, _P);
      const rx = _P.x - rp.pos.x, rz = _P.z - rp.pos.z;
      const lz = rx * rp.dir.x + rz * rp.dir.z;
      const lx = rx * rp.right.x + rz * rp.right.z;
      if (lz < 0 || lz > rp.len || Math.abs(lx) > rp.width / 2) continue;
      const top = rp.pos.y + slope * lz;
      const pen = top - _P.y;
      if (pen <= 0 || pen > 1.6) continue;
      // top-face normal, tilted back against the run-up direction
      _n.set(-rp.dir.x * slope, 1, -rp.dir.z * slope).multiplyScalar(invLen);
      contactStatic(b, _P, _n, pen * invLen * 0.5, 0.0, 0.04);
    }
  }
}
