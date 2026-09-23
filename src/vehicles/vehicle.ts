import { Quaternion, Vector3 } from 'three';
import { emptyControls, type Controls } from '../core/input';
import type { RigidBody } from '../physics/rigidbody';
import type { Track } from '../track/track';
import { newProj } from '../track/track';
import type { Ground } from '../world/ground';
import type { WaveField } from '../world/water';
import { DriftState } from './drift';

/** Floating/static wedge ramp. pos = center of the low edge at base height. */
export interface RampShape {
  pos: Vector3;
  dir: Vector3;
  right: Vector3;
  len: number;
  width: number;
  height: number;
}

export interface SphereObstacle {
  pos: Vector3;
  r: number;
  /** visual knock-back offset (buoys wobble when hit) */
  kick: Vector3;
}

export interface SimEnv {
  track: Track;
  ground: Ground | null;
  water: WaveField | null;
  time: number;
  spheres: SphereObstacle[];
  ramps: RampShape[];
  /** river current speed along the track direction, m/s */
  current: number;
}

/** One-shot things that happened during the physics steps of the current frame. FX/audio/camera drain them. */
export interface VehicleEvents {
  driftStart: boolean;
  stageUp: number;
  boost: number;
  landed: number;
  wallHit: number;
  wallPoint: Vector3;
  bump: number;
  splash: number;
  cleanLanding: boolean;
  padHit: boolean;
}

export const newEvents = (): VehicleEvents => ({
  driftStart: false, stageUp: 0, boost: 0, landed: 0, wallHit: 0, wallPoint: new Vector3(), bump: 0, splash: 0, cleanLanding: false, padHit: false,
});

const _f = new Vector3();
const _up = new Vector3();

export abstract class Vehicle {
  abstract readonly kind: 'car' | 'boat';
  abstract body: RigidBody;
  controls: Controls = emptyControls();
  drift = new DriftState();
  proj = newProj();
  prevPos = new Vector3();
  prevQuat = new Quaternion();
  events = newEvents();
  grounded = false;
  airTime = 0;
  speed = 0;
  fwdSpeed = 0;
  slip = 0;
  /** 0..1, engine note */
  rpm = 0;
  /** 0..1 how hard tires / hull are scrubbing */
  skid = 0;
  /** seconds of invulnerable ghosting after respawn */
  ghostT = 0;
  livery = 0;
  isPlayer = false;
  /** lower = worse AI; 1 = player-grade physics */
  powerScale = 1;
  stuckT = 0;
  upsideT = 0;

  abstract step(dt: number, env: SimEnv): void;
  /** Corner-ish collision spheres for vehicle vs vehicle, local space. */
  abstract readonly spheres: { p: Vector3; r: number }[];

  forward(out: Vector3) {
    return out.set(0, 0, -1).applyQuaternion(this.body.quat);
  }
  right(out: Vector3) {
    return out.set(1, 0, 0).applyQuaternion(this.body.quat);
  }
  up(out: Vector3) {
    return out.set(0, 1, 0).applyQuaternion(this.body.quat);
  }

  savePrev() {
    this.prevPos.copy(this.body.pos);
    this.prevQuat.copy(this.body.quat);
  }

  pose(alpha: number, pos: Vector3, quat: Quaternion) {
    pos.lerpVectors(this.prevPos, this.body.pos, alpha);
    quat.slerpQuaternions(this.prevQuat, this.body.quat, alpha);
  }

  clearEvents() {
    const e = this.events;
    e.driftStart = false; e.stageUp = 0; e.boost = 0; e.landed = 0; e.wallHit = 0; e.bump = 0; e.splash = 0;
    e.cleanLanding = false; e.padHit = false;
  }

  /** Common kinematic metrics, call at the top of step(). */
  protected measure() {
    const b = this.body;
    this.forward(_f);
    this.speed = b.vel.length();
    this.fwdSpeed = b.vel.dot(_f);
    this.right(_up);
    const vr = b.vel.dot(_up);
    this.slip = Math.atan2(-vr, Math.max(Math.abs(this.fwdSpeed), 1.5));
  }

  abstract place(env: SimEnv, s: number, d: number): void;

  giveBoost(duration: number) {
    this.drift.giveBoost(duration);
    this.events.padHit = true;
  }
}
