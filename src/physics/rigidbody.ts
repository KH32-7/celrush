import { Matrix3, Quaternion, Vector3 } from 'three';

const _r = new Vector3();
const _t = new Vector3();
const _q = new Quaternion();

/**
 * 6-DOF rigid body with a diagonal (box) inertia tensor, semi-implicit Euler.
 * Forces are accumulated per step and cleared by integrate().
 */
export class RigidBody {
  mass: number;
  invMass: number;
  inertia = new Vector3();
  invInertia = new Vector3();
  pos = new Vector3();
  vel = new Vector3();
  quat = new Quaternion();
  angVel = new Vector3();
  force = new Vector3();
  torque = new Vector3();
  linearDrag = 0;
  angularDrag = 0;
  private R = new Matrix3();
  private invIW = new Matrix3();

  constructor(mass: number, size: Vector3, inertiaScale = new Vector3(1, 1, 1)) {
    this.mass = mass;
    this.invMass = 1 / mass;
    const { x: w, y: h, z: l } = size;
    this.inertia.set(
      (mass / 12) * (h * h + l * l) * inertiaScale.x,
      (mass / 12) * (w * w + l * l) * inertiaScale.y,
      (mass / 12) * (w * w + h * h) * inertiaScale.z,
    );
    this.invInertia.set(1 / this.inertia.x, 1 / this.inertia.y, 1 / this.inertia.z);
    this.updateInertiaWorld();
  }

  updateInertiaWorld() {
    const q = this.quat;
    // rotation matrix from quaternion
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const R = this.R.elements; // column-major
    R[0] = 1 - (yy + zz); R[3] = xy - wz; R[6] = xz + wy;
    R[1] = xy + wz; R[4] = 1 - (xx + zz); R[7] = yz - wx;
    R[2] = xz - wy; R[5] = yz + wx; R[8] = 1 - (xx + yy);
    // invIW = R * diag(invI) * R^T
    const d = this.invInertia;
    const e = this.invIW.elements;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        e[j * 3 + i] = R[i] * d.x * R[j] + R[3 + i] * d.y * R[3 + j] + R[6 + i] * d.z * R[6 + j];
      }
    }
  }

  /** world-space inverse inertia applied to v (in place into out) */
  applyInvInertia(v: Vector3, out: Vector3) {
    return out.copy(v).applyMatrix3(this.invIW);
  }

  addForce(f: Vector3) {
    this.force.add(f);
  }

  addForceAtPoint(f: Vector3, p: Vector3) {
    this.force.add(f);
    _r.subVectors(p, this.pos);
    this.torque.add(_t.crossVectors(_r, f));
  }

  addTorque(t: Vector3) {
    this.torque.add(t);
  }

  pointVelocity(p: Vector3, out: Vector3) {
    _r.subVectors(p, this.pos);
    return out.crossVectors(this.angVel, _r).add(this.vel);
  }

  applyImpulse(j: Vector3, p: Vector3) {
    this.vel.addScaledVector(j, this.invMass);
    _r.subVectors(p, this.pos);
    _t.crossVectors(_r, j).applyMatrix3(this.invIW);
    this.angVel.add(_t);
  }

  /** 1 / (effective inverse mass) for an impulse along n at world point p */
  effectiveMass(p: Vector3, n: Vector3) {
    _r.subVectors(p, this.pos);
    _t.crossVectors(_r, n).applyMatrix3(this.invIW);
    _t.cross(_r);
    return 1 / (this.invMass + n.dot(_t));
  }

  localToWorld(v: Vector3, out: Vector3) {
    return out.copy(v).applyQuaternion(this.quat).add(this.pos);
  }

  dirToWorld(v: Vector3, out: Vector3) {
    return out.copy(v).applyQuaternion(this.quat);
  }

  dirToLocal(v: Vector3, out: Vector3) {
    _q.copy(this.quat).invert();
    return out.copy(v).applyQuaternion(_q);
  }

  integrate(dt: number) {
    this.vel.addScaledVector(this.force, this.invMass * dt);
    _t.copy(this.torque).applyMatrix3(this.invIW);
    this.angVel.addScaledVector(_t, dt);
    if (this.linearDrag > 0) this.vel.multiplyScalar(Math.exp(-this.linearDrag * dt));
    if (this.angularDrag > 0) this.angVel.multiplyScalar(Math.exp(-this.angularDrag * dt));
    // hard safety limits: a physics blow-up must never become NaN
    const w2 = this.angVel.lengthSq();
    if (w2 > 400) this.angVel.multiplyScalar(20 / Math.sqrt(w2));
    this.pos.addScaledVector(this.vel, dt);
    // q' = q + 0.5 * (w, 0) * q * dt
    const q = this.quat, w = this.angVel;
    const hx = 0.5 * dt * w.x, hy = 0.5 * dt * w.y, hz = 0.5 * dt * w.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    q.set(
      qx + hx * qw + hy * qz - hz * qy,
      qy + hy * qw + hz * qx - hx * qz,
      qz + hz * qw + hx * qy - hy * qx,
      qw - hx * qx - hy * qy - hz * qz,
    ).normalize();
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
    this.updateInertiaWorld();
  }

  isFinite() {
    return Number.isFinite(this.pos.x + this.pos.y + this.pos.z + this.vel.x + this.vel.y + this.vel.z + this.quat.w);
  }
}

const _n = new Vector3();
const _v = new Vector3();
const _vt = new Vector3();

/**
 * Resolve a single point contact against static geometry.
 * penetration > 0 pushes the body out along n; restitution and Coulomb friction via impulses.
 * Returns the normal impulse magnitude (for FX/audio).
 */
export function contactStatic(
  body: RigidBody, p: Vector3, n: Vector3, penetration: number, restitution: number, friction: number,
): number {
  _n.copy(n);
  if (penetration > 0) body.pos.addScaledVector(_n, penetration * 0.8);
  body.pointVelocity(p, _v);
  const vn = _v.dot(_n);
  if (vn >= 0) return 0;
  const m = body.effectiveMass(p, _n);
  const e = vn < -1.5 ? restitution : 0;
  const jn = -(1 + e) * vn * m;
  _vt.copy(_n).multiplyScalar(jn);
  body.applyImpulse(_vt, p);
  // friction
  body.pointVelocity(p, _v);
  _vt.copy(_v).addScaledVector(_n, -_v.dot(_n));
  const vtLen = _vt.length();
  if (vtLen > 1e-4) {
    _vt.multiplyScalar(1 / vtLen);
    const mt = body.effectiveMass(p, _vt);
    const jt = Math.min(vtLen * mt, friction * jn);
    _vt.multiplyScalar(-jt);
    body.applyImpulse(_vt, p);
  }
  return jn;
}

const _d = new Vector3();
const _pa = new Vector3();
const _rv = new Vector3();
const _va = new Vector3();
const _vb = new Vector3();

/** Sphere vs sphere between two dynamic bodies (sphere centers given in world space). */
export function contactSpheres(
  a: RigidBody, ca: Vector3, ra: number, b: RigidBody, cb: Vector3, rb: number, restitution: number,
): number {
  _d.subVectors(cb, ca);
  const dist = _d.length();
  const minD = ra + rb;
  if (dist >= minD || dist < 1e-5) return 0;
  _d.multiplyScalar(1 / dist); // normal from a to b
  const pen = minD - dist;
  const wa = a.invMass / (a.invMass + b.invMass);
  a.pos.addScaledVector(_d, -pen * wa);
  b.pos.addScaledVector(_d, pen * (1 - wa));
  _pa.copy(ca).addScaledVector(_d, ra);
  a.pointVelocity(_pa, _va);
  b.pointVelocity(_pa, _vb);
  _rv.subVectors(_vb, _va);
  const vn = _rv.dot(_d);
  if (vn >= 0) return 0;
  const ma = 1 / a.effectiveMass(_pa, _d);
  const mb = 1 / b.effectiveMass(_pa, _d);
  const j = (-(1 + restitution) * vn) / (ma + mb);
  _rv.copy(_d).multiplyScalar(j);
  b.applyImpulse(_rv, _pa);
  _rv.multiplyScalar(-1);
  a.applyImpulse(_rv, _pa);
  return j;
}
