import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { clamp, damp, lerp, smoothstep } from '../core/math';
import { valueNoise2 } from '../core/rng';
import { CAMERA } from '../tuning/params';

export interface CamTarget {
  pos: Vector3;
  quat: Quaternion;
  vel: Vector3;
  speed: number;
  topSpeed: number;
  kind: 'car' | 'boat';
  boosting: boolean;
  driftDir: number;
  airborne: boolean;
}

export type CamMode = 'chase' | 'near' | 'hood' | 'orbit' | 'intro';

const _f = new Vector3();
const _d = new Vector3();
const _p = new Vector3();
const _look = new Vector3();
const _v = new Vector3();

/**
 * Chase camera. Distance and FOV are derived from speed (reaction-time budget: faster -> see further),
 * never tuned separately. Heading blends toward the velocity so a drift shows the car's angle.
 */
export class ChaseCamera {
  readonly cam: PerspectiveCamera;
  mode: CamMode = 'orbit';
  private afterIntro: CamMode = 'chase';
  private dir = new Vector3(0, 0, -1);
  private pos = new Vector3();
  private look = new Vector3();
  private roll = 0;
  private trauma = 0;
  private fovKick = 0;
  private t = 0;
  private orbitA = 0;
  private introT = 0;
  shakeScale = 1;
  private inited = false;

  constructor(aspect: number) {
    this.cam = new PerspectiveCamera(64, aspect, 0.3, 6000);
  }

  shake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  kick(deg: number) {
    this.fovKick = Math.max(this.fovKick, deg);
  }

  /** Fly-around before the countdown, then settle into `after` (the player's chosen view). */
  startIntro(after: CamMode = 'chase') {
    this.mode = 'intro';
    this.introT = 0;
    this.afterIntro = after;
  }

  snap() {
    this.inited = false;
  }

  update(dt: number, tg: CamTarget, groundAt: (x: number, z: number) => number) {
    this.t += dt;
    const P = CAMERA[tg.kind];
    _f.set(0, 0, -1).applyQuaternion(tg.quat);
    _f.y = 0;
    if (_f.lengthSq() < 1e-4) _f.set(0, 0, -1);
    _f.normalize();
    // blend toward travel direction; reversing keeps looking along the nose
    _v.copy(tg.vel).setY(0);
    const vs = _v.length();
    if (vs > 1 && _v.dot(_f) > 0) {
      _v.multiplyScalar(1 / vs);
      _f.lerp(_v, smoothstep(3, 16, vs) * (tg.driftDir !== 0 ? 0.62 : 0.4)).normalize();
    }
    if (!this.inited) {
      this.dir.copy(_f);
    }
    const turnRate = tg.driftDir !== 0 ? 4 : 6.5;
    this.dir.lerp(_f, 1 - Math.exp(-turnRate * dt)).normalize();

    const sn = clamp(tg.speed / tg.topSpeed, 0, 1.25);
    const dist = lerp(P.dist, P.distFast, sn);
    const height = lerp(P.height, P.heightFast, sn);
    let fov = lerp(P.fov, P.fovFast, sn) + (tg.boosting ? P.fovBoost : 0) + this.fovKick;
    this.fovKick = damp(this.fovKick, 0, 3, dt);

    let wantPos: Vector3;
    let wantLook: Vector3;
    if (this.mode === 'hood') {
      _d.set(0, tg.kind === 'car' ? 0.75 : 1.5, tg.kind === 'car' ? -0.4 : 0.9).applyQuaternion(tg.quat);
      wantPos = _p.copy(tg.pos).add(_d);
      _d.set(0, 0.2, -20).applyQuaternion(tg.quat);
      wantLook = _look.copy(tg.pos).add(_d);
      fov += 6;
    } else if (this.mode === 'orbit') {
      this.orbitA += dt * 0.22;
      const r = tg.kind === 'car' ? 9 : 12;
      wantPos = _p.set(tg.pos.x + Math.sin(this.orbitA) * r, tg.pos.y + 2.8, tg.pos.z + Math.cos(this.orbitA) * r);
      wantLook = _look.copy(tg.pos).setY(tg.pos.y + 0.6);
      fov = 50;
    } else {
      const near = this.mode === 'near' ? 0.72 : 1;
      wantPos = _p.copy(tg.pos).addScaledVector(this.dir, -dist * near);
      wantPos.y += height * near;
      wantLook = _look.copy(tg.pos).addScaledVector(this.dir, 4.5);
      wantLook.y += P.look;
      if (this.mode === 'intro') {
        this.introT += dt;
        const k = smoothstep(0, 3.2, this.introT);
        const a = lerp(Math.PI * 0.85, 0, k);
        const r = lerp(10, dist, k);
        _d.copy(this.dir).applyAxisAngle(_v.set(0, 1, 0), a);
        wantPos.copy(tg.pos).addScaledVector(_d, -r);
        wantPos.y += lerp(4.5, height, k);
        fov = lerp(48, fov, k);
        if (this.introT > 3.2) this.mode = this.afterIntro;
      }
    }

    if (!this.inited) {
      this.pos.copy(wantPos);
      this.look.copy(wantLook);
      this.inited = true;
    }
    const lh = this.mode === 'orbit' ? 2 : 12;
    const lv = tg.airborne ? 3 : tg.kind === 'boat' ? 4.5 : 9;
    this.pos.x = damp(this.pos.x, wantPos.x, lh, dt);
    this.pos.z = damp(this.pos.z, wantPos.z, lh, dt);
    this.pos.y = damp(this.pos.y, wantPos.y, lv, dt);
    this.look.lerp(wantLook, 1 - Math.exp(-(this.mode === 'hood' ? 30 : 14) * dt));
    const g = groundAt(this.pos.x, this.pos.z) + (tg.kind === 'boat' ? 1.2 : 0.7);
    if (this.pos.y < g) this.pos.y = g;

    const rollT = this.mode === 'chase' || this.mode === 'near' ? -tg.driftDir * 0.045 : 0;
    this.roll = damp(this.roll, rollT, 4, dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const sh = this.trauma * this.trauma * this.shakeScale;
    const nx = valueNoise2(this.t * 22, 1.3) - 0.5, ny = valueNoise2(this.t * 24, 7.7) - 0.5, nr = valueNoise2(this.t * 18, 3.1) - 0.5;

    this.cam.position.copy(this.pos);
    this.cam.position.x += nx * sh * 0.6;
    this.cam.position.y += ny * sh * 0.5;
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(this.look);
    this.cam.rotateZ(this.roll + nr * sh * 0.06);
    if (Math.abs(this.cam.fov - fov) > 0.01) {
      this.cam.fov = damp(this.cam.fov, fov, 5, dt);
      this.cam.updateProjectionMatrix();
    }
  }
}
