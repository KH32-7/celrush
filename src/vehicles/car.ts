import { Matrix4, Vector3 } from 'three';
import { clamp, lerp, moveToward, smoothstep } from '../core/math';
import { contactStatic, RigidBody } from '../physics/rigidbody';
import { CAR as P } from '../tuning/params';
import type { TrackFrame } from '../track/track';
import { newProj } from '../track/track';
import { Surface, SURFACE_NAMES, type GroundHit } from '../world/ground';
import { DriftEvent } from './drift';
import { Vehicle, type SimEnv } from './vehicle';

export interface Wheel {
  mount: Vector3;
  front: boolean;
  left: boolean;
  x: number;
  xPrev: number;
  contact: boolean;
  cp: Vector3;
  n: Vector3;
  load: number;
  /** distance from mount to wheel center along -up (visual) */
  dist: number;
  spin: number;
  spinVel: number;
  skid: number;
  surface: Surface;
}

const G = 9.81;
const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _m = new Vector3();
const _p = new Vector3();
const _F = new Vector3();
const _wf = new Vector3();
const _wr = new Vector3();
const _v = new Vector3();
const _t = new Vector3();
const _n = new Vector3();
const _mat = new Matrix4();
const _frame: TrackFrame = { pos: new Vector3(), tan: new Vector3(), right: new Vector3(), up: new Vector3() };
const _proj = newProj();

const CORNERS = [
  new Vector3(-0.92, -0.32, -2.1), new Vector3(0.92, -0.32, -2.1), new Vector3(-0.92, -0.32, 2.05), new Vector3(0.92, -0.32, 2.05),
  new Vector3(-0.95, -0.2, 0), new Vector3(0.95, -0.2, 0),
  new Vector3(-0.72, 0.62, -0.4), new Vector3(0.72, 0.62, -0.4), new Vector3(-0.72, 0.62, 1.0), new Vector3(0.72, 0.62, 1.0),
];

/**
 * Raycast-suspension car: 4 spring-damper wheels + anti-roll bars, slip-angle tire model with a
 * friction ellipse, aero drag/downforce. Drift is physical (rear grip drops) plus two arcade assists:
 * the velocity is carved around the corner and a yaw controller holds the chosen drift angle.
 */
export class Car extends Vehicle {
  readonly kind = 'car' as const;
  body: RigidBody;
  wheels: Wheel[];
  steerAngle = 0;
  surface: Surface = Surface.Road;
  gear = 1;
  readonly spheres = [
    { p: new Vector3(0, 0, -1.15), r: 1.05 },
    { p: new Vector3(0, 0, 1.15), r: 1.05 },
  ];
  private hit: GroundHit = { h: 0, n: new Vector3(), surface: Surface.Road, d: 0, s: 0 };
  private lastVy = 0;
  needsRespawn = false;
  contacts = 0;

  constructor() {
    super();
    this.body = new RigidBody(P.mass, new Vector3(...P.size), new Vector3(...P.inertiaScale));
    this.body.angularDrag = 0.05;
    const mk = (x: number, z: number, front: boolean): Wheel => ({
      mount: new Vector3(x, P.mountY, z), front, left: x < 0, x: 0, xPrev: 0, contact: false,
      cp: new Vector3(), n: new Vector3(0, 1, 0), load: 0, dist: P.restLength, spin: 0, spinVel: 0, skid: 0, surface: Surface.Road,
    });
    this.wheels = [
      mk(-P.halfTrack, P.frontZ, true), mk(P.halfTrack, P.frontZ, true),
      mk(-P.halfTrack, P.rearZ, false), mk(P.halfTrack, P.rearZ, false),
    ];
  }

  place(env: SimEnv, s: number, d: number) {
    const tr = env.track;
    tr.frameAt(s, _frame);
    tr.pointAt(s, d, _p);
    const h = env.ground ? env.ground.heightAt(_p.x, _p.z, -1) : _p.y;
    const b = this.body;
    b.pos.set(_p.x, h + 0.78, _p.z);
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
    for (const w of this.wheels) { w.x = w.xPrev = 0.1; w.contact = false; }
    this.drift.cancel();
    this.drift.boostTime = 0;
    this.savePrev();
    this.upsideT = 0;
    this.stuckT = 0;
    this.needsRespawn = false;
  }

  step(dt: number, env: SimEnv) {
    const b = this.body;
    const g = env.ground!;
    const tr = env.track;
    const c = this.controls;
    this.savePrev();
    this.measure();
    tr.project(b.pos.x, b.pos.z, this.proj.idx, this.proj);
    const hint = this.proj.idx;
    const fwd = this.forward(_fwd), right = this.right(_right), up = this.up(_up);
    const vF = this.fwdSpeed;
    const vAbs = Math.abs(vF);

    // ---------- drift state ----------
    const ev = this.drift.update(dt, c, { speed: vF, slip: this.slip, grounded: this.contacts >= 3, minSpeed: P.drift.minSpeed });
    if (ev & DriftEvent.Start) {
      this.events.driftStart = true;
      b.vel.addScaledVector(up, P.drift.hop);
    }
    if (ev & DriftEvent.StageUp) this.events.stageUp = this.drift.stage;
    if (ev & DriftEvent.Boost) this.events.boost = this.drift.lastStage;
    const drifting = this.drift.active;

    // ---------- steering ----------
    const maxSteer = lerp(P.steerLow, P.steerHigh, smoothstep(0, P.steerSpeedRef, vAbs));
    const target = c.steer * maxSteer * (drifting ? 1.25 : 1);
    this.steerAngle = moveToward(this.steerAngle, target, 4 * dt);

    // ---------- suspension raycasts ----------
    const maxLen = P.restLength + P.wheelRadius;
    let contacts = 0;
    for (const w of this.wheels) {
      w.xPrev = w.x;
      b.localToWorld(w.mount, _m);
      if (up.y < 0.2) {
        w.contact = false; w.x = 0; w.dist = P.restLength;
        continue;
      }
      let t = (_m.y - g.heightAt(_m.x, _m.z, hint)) / up.y;
      for (let k = 0; k < 2; k++) {
        _p.copy(_m).addScaledVector(up, -t);
        t += (_p.y - g.heightAt(_p.x, _p.z, hint)) / up.y;
      }
      if (t > maxLen || t < -0.6) {
        w.contact = false; w.x = 0; w.dist = P.restLength;
        continue;
      }
      w.contact = true;
      contacts++;
      w.x = Math.min(maxLen - t, P.restLength + 0.2);
      w.cp.copy(_m).addScaledVector(up, -t);
      g.sample(w.cp.x, w.cp.z, hint, this.hit);
      w.n.copy(this.hit.n);
      w.surface = this.hit.surface;
      w.dist = Math.max(t - P.wheelRadius, P.restLength - P.maxTravel - 0.05);
    }
    const wasAir = this.contacts === 0;
    this.contacts = contacts;
    this.grounded = contacts >= 2;

    // ---------- engine ----------
    const boosting = this.drift.boosting;
    let vTop = P.topSpeed * this.powerScale * (drifting ? P.drift.topSpeedMul : 1);
    let drive = 0;
    let braking = 0;
    if (c.brake > 0.05 && vF < 1.0 && c.throttle < 0.05) {
      drive = -c.brake * P.engineForce * 0.45 * Math.max(0, 1 - -vF / P.reverseTop);
    } else {
      if (c.throttle > 0) drive = c.throttle * P.engineForce * this.powerScale * Math.max(0, 1 - Math.max(vF, 0) ** 2 / (vTop * vTop));
      if (c.brake > 0.05) braking = c.brake * P.brakeForce * 0.25;
    }
    if (boosting) {
      vTop = P.boostTop;
      drive += P.boostForce * clamp(1 - vF / P.boostTop, 0, 1);
    }

    // ---------- wheel forces ----------
    let skidMax = 0;
    let surfCount = [0, 0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.contact) {
        w.load = 0;
        w.skid = 0;
        w.spinVel = moveToward(w.spinVel, c.throttle > 0 ? 60 : 0, 40 * dt);
        w.spin += w.spinVel * dt;
        continue;
      }
      surfCount[w.surface]++;
      const pair = this.wheels[i ^ 1];
      const xdot = clamp((w.x - w.xPrev) / dt, -6, 6);
      let F = P.spring * w.x + (xdot > 0 ? P.damperBump : P.damperRebound) * xdot;
      if (w.x > P.maxTravel) F += P.bumpStop * (w.x - P.maxTravel);
      F += P.antiRoll * (w.x - (pair.contact ? pair.x : 0));
      F = Math.max(0, F);
      w.load = F;
      _F.copy(up).multiplyScalar(F);
      b.addForceAtPoint(_F, w.cp);

      // tire frame on the contact plane
      const sn = w.front ? Math.sin(this.steerAngle) : 0;
      const cs = w.front ? Math.cos(this.steerAngle) : 1;
      _wf.copy(fwd).multiplyScalar(cs).addScaledVector(right, sn);
      _wf.addScaledVector(w.n, -_wf.dot(w.n)).normalize();
      _wr.crossVectors(_wf, w.n);
      b.pointVelocity(w.cp, _v);
      const vl = _v.dot(_wf), vt = _v.dot(_wr);
      const surfName = SURFACE_NAMES[w.surface];
      const surfGrip = P.surfaceGrip[surfName];
      let muLat = (w.front ? P.gripFront : P.gripRear) * surfGrip;
      if (drifting) muLat *= w.front ? P.drift.frontGrip : P.drift.rearGrip;
      const alpha = Math.atan2(vt, Math.max(Math.abs(vl), P.slipRefSpeed));
      let Fy = -muLat * F * Math.sin(P.tireC * Math.atan(P.tireB * alpha));

      const share = w.front ? P.frontDriveShare * 0.5 : (1 - P.frontDriveShare) * 0.5;
      let Fx = drive * share;
      if (braking > 0) Fx -= clamp(vl * 2500, -braking, braking);
      Fx -= clamp(vl * 30, -P.rollResist, P.rollResist); // near-constant rolling resistance
      if (c.throttle < 0.05 && c.brake < 0.05) Fx -= clamp(vl * 60, -250, 250); // engine braking

      const muX = P.gripLong * surfGrip * F + 1e-3;
      const muY = muLat * F + 1e-3;
      const k = Math.hypot(Fx / muX, Fy / muY);
      let spinBoost = 0;
      if (k > 1) {
        Fx /= k; Fy /= k;
        if (drive * share > muX * 0.8) spinBoost = 25; // wheelspin
      }
      _F.copy(_wf).multiplyScalar(Fx).addScaledVector(_wr, Fy);
      // apply slightly above the contact to tame body roll, like a raised roll center
      _p.copy(w.cp).addScaledVector(up, 0.28);
      b.addForceAtPoint(_F, _p);
      // surface drag (runoff / dirt)
      const sd = P.surfaceDrag[surfName];
      if (sd > 0) b.addForce(_t.copy(b.vel).multiplyScalar(-sd * 0.25 * Math.min(1, b.vel.length() / 10)));

      w.skid = clamp((Math.abs(vt) - 2.2) / 5, 0, 1) * (k > 0.9 ? 1 : 0.6) + (spinBoost > 0 ? 0.6 : 0);
      if (drifting && !w.front) w.skid = Math.max(w.skid, 0.7);
      skidMax = Math.max(skidMax, w.skid);
      w.spinVel = vl / P.wheelRadius + spinBoost;
      w.spin += w.spinVel * dt;
    }
    this.skid = skidMax;
    let best = 0;
    for (let s = 1; s < 5; s++) if (surfCount[s] > surfCount[best]) best = s;
    this.surface = best as Surface;

    // ---------- body forces ----------
    const spd = b.vel.length();
    b.addForce(_t.copy(b.vel).multiplyScalar(-P.aeroDrag * spd));
    if (contacts > 0) {
      const df = P.downforce * vF * vF * 0.5;
      b.localToWorld(_t.set(0, 0, P.frontZ), _m);
      b.addForceAtPoint(_F.copy(up).multiplyScalar(-df), _m);
      b.localToWorld(_t.set(0, 0, P.rearZ), _m);
      b.addForceAtPoint(_F.copy(up).multiplyScalar(-df), _m);
    }
    b.force.y -= G * b.mass;

    const r = -b.angVel.dot(up); // yaw rate, + = turning right
    if (drifting && contacts >= 2) {
      // arcade drift: the path bends at a rate chosen by steering, speed is conserved by rotating velocity
      const into = clamp(c.steer * this.drift.dir, -1, 1);
      const turnRate = this.drift.dir * lerp(0.4, 1.05, (into + 1) / 2) * smoothstep(5, 18, vAbs) * P.drift.carve;
      const a = -turnRate * dt;
      const ca = Math.cos(a), sa = Math.sin(a);
      const vx = b.vel.x, vz = b.vel.z;
      b.vel.x = vx * ca + vz * sa;
      b.vel.z = -vx * sa + vz * ca;
      // yaw controller holds the drift angle
      const betaT = this.drift.dir * lerp(P.drift.angleMin, P.drift.angleMax, (into + 1) / 2);
      const pathRate = turnRate / P.drift.carve;
      const rDes = pathRate + P.drift.yawKp * (betaT - this.slip);
      const tauR = (rDes - r) * P.drift.yawKd * b.inertia.y;
      b.addTorque(_t.copy(up).multiplyScalar(-tauR));
    } else if (contacts >= 3 && vAbs > 6) {
      // stability assist: catches slides past ~9 degrees so grip driving never spins out
      const ex = Math.abs(this.slip) - 0.16;
      if (ex > 0) {
        const tauR = -Math.sign(this.slip) * ex * 10 * b.inertia.y * smoothstep(6, 20, vAbs);
        b.addTorque(_t.copy(up).multiplyScalar(-tauR));
      }
      // light yaw damping against keyboard twitch
      const rNat = (vF * Math.tan(this.steerAngle)) / (P.rearZ - P.frontZ);
      b.addTorque(_t.copy(up).multiplyScalar((r - rNat) * 0.8 * b.inertia.y));
    }

    // ---------- air ----------
    if (contacts === 0) {
      this.airTime += dt;
      this.lastVy = b.vel.y;
      b.addTorque(_t.copy(right).multiplyScalar(c.pitch * P.air.pitch * b.inertia.x));
      b.addTorque(_t.copy(up).multiplyScalar(-c.steer * P.air.yaw * b.inertia.y));
      // torque along (up x worldUp) rotates up toward level; keep only its roll component
      const rollErr = _n.set(0, 1, 0).crossVectors(up, _n).dot(fwd);
      const rollRate = b.angVel.dot(fwd);
      b.addTorque(_t.copy(fwd).multiplyScalar((rollErr * P.air.level - rollRate * 1.5) * b.inertia.z));
      b.angVel.multiplyScalar(Math.exp(-1.2 * dt));
    } else {
      if (wasAir && this.airTime > 0.2) this.events.landed = Math.max(this.events.landed, -this.lastVy);
      this.airTime = 0;
      // arcade anti-rollover: past ~30 degrees of roll with wheels on the ground, push back upright
      if (up.y < 0.87) {
        const rollErr = _n.set(0, 1, 0).crossVectors(up, _n).dot(fwd);
        const rollRate = b.angVel.dot(fwd);
        b.addTorque(_t.copy(fwd).multiplyScalar((rollErr * 14 - rollRate * 3) * b.inertia.z));
      }
    }

    b.integrate(dt);

    // ---------- collisions: walls + body vs ground ----------
    const wallD = g.wallD;
    for (const lc of CORNERS) {
      b.localToWorld(lc, _p);
      tr.project(_p.x, _p.z, hint, _proj);
      const ad = Math.abs(_proj.d);
      if (ad > wallD) {
        const i = _proj.idx;
        const sg = Math.sign(_proj.d);
        _n.set(-sg * tr.rx[i], 0, -sg * tr.rz[i]).normalize();
        // resolve at COM height: a wall scrape may yaw the car but must never roll it over
        b.localToWorld(_t.set(lc.x, 0, lc.z), _m);
        const jn = contactStatic(b, _m, _n, ad - wallD, P.wallRestitution, P.wallFriction);
        const dv = jn / b.mass;
        if (dv > this.events.wallHit) {
          this.events.wallHit = dv;
          this.events.wallPoint.copy(_p);
        }
        if (dv > 4.5 && this.drift.active) this.drift.cancel();
      }
      const h = g.heightProfile(_proj.cy, _proj.bank, _proj.d);
      if (_p.y < h) {
        const jn = contactStatic(b, _p, _n.set(0, 1, 0), h - _p.y, 0.05, 0.55);
        if (jn / b.mass > 2) this.events.bump = Math.max(this.events.bump, jn / b.mass);
      }
    }

    // ---------- telemetry ----------
    const gears = [0, 12, 21, 30, 39, 48, 80];
    let gi = 1;
    while (gi < gears.length - 2 && vAbs > gears[gi]) gi++;
    this.gear = gi;
    const lo = gears[gi - 1], hi = gears[gi];
    let rpmT = lerp(0.3, 1.0, clamp((vAbs - lo) / (hi - lo), 0, 1));
    if (contacts === 0 || (this.skid > 0.5 && c.throttle > 0)) rpmT = Math.max(rpmT, 0.35 + 0.6 * c.throttle);
    this.rpm = moveToward(this.rpm, rpmT, 3 * dt);

    this.upsideT = up.y < 0.15 ? this.upsideT + dt : 0;
    this.stuckT = c.throttle > 0.5 && vAbs < 1.5 ? this.stuckT + dt : 0;
    if (this.upsideT > 1.6 || this.stuckT > 3.5 || b.pos.y < this.proj.cy - 25 || !b.isFinite()) this.needsRespawn = true;
    if (this.ghostT > 0) this.ghostT -= dt;
  }
}
