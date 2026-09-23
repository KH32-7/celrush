import { Vector3, type Scene } from 'three';
import type { Racer } from '../game/racer';
import type { World } from '../scene/world';
import { FX } from '../tuning/palette';
import { Boat } from '../vehicles/boat';
import { HULL_STERN_Z } from '../vehicles/boatHull';
import { Car } from '../vehicles/car';
import { Surface } from '../world/ground';
import { Blobs, Sparks } from './particles';
import { Skids } from './skids';

const _p = new Vector3();
const _v = new Vector3();
const _f = new Vector3();
const _r = new Vector3();
const _u = new Vector3();
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Turns vehicle telemetry + one-shot events into manga effects.
 * Rates are per second and accumulate fractionally so emission is frame-rate independent.
 */
export class VehicleFx {
  readonly blobs = new Blobs(1600);
  readonly sparks = new Sparks(800);
  readonly skids: Skids | null = null;
  private acc = new Map<string, number>();

  constructor(scene: Scene, private world: World) {
    scene.add(this.blobs.mesh, this.sparks.mesh);
    if (world.def.vehicle === 'car') {
      this.skids = new Skids();
      scene.add(this.skids.mesh);
    }
  }

  private emit(key: string, rate: number, dt: number) {
    const a = (this.acc.get(key) ?? Math.random()) + rate * dt;
    const n = Math.floor(a);
    this.acc.set(key, a - n);
    return n;
  }

  private waterH(x: number, z: number) {
    return this.world.field ? this.world.field.heightAt(x, z) : 0;
  }

  update(dt: number, racers: Racer[], cam: Vector3) {
    for (const r of racers) {
      if (r.vehicle instanceof Car) this.car(r, r.vehicle, dt);
      else this.boat(r, r.vehicle as Boat, dt);
    }
    this.blobs.update(dt, cam);
    this.sparks.update(dt);
    this.skids?.flush();
  }

  private car(r: Racer, v: Car, dt: number) {
    const b = v.body;
    v.forward(_f);
    v.right(_r);
    v.up(_u);
    const id = r.id;
    const spd = v.speed;
    for (const i of [2, 3]) {
      const w = v.wheels[i];
      const active = w.contact && w.skid > 0.35 && spd > 3;
      this.skids?.add(id * 4 + i, w.cp, _r, 0.26, active);
      if (!w.contact) continue;
      // tire smoke
      // tire smoke: small puffs that stay behind the car, never a wall in front of the camera
      const n = this.emit(`s${id}${i}`, w.skid > 0.45 ? 8 + 16 * w.skid : 0, dt);
      for (let k = 0; k < n; k++) {
        _p.copy(w.cp).addScaledVector(_u, 0.15).addScaledVector(_f, -0.3);
        _v.copy(_f).multiplyScalar(-rnd(0.5, 2)).addScaledVector(_r, rnd(-1, 1)).add(new Vector3(0, rnd(0.6, 1.4), 0)).addScaledVector(b.vel, 0.12);
        this.blobs.spawn(_p, _v, rnd(0.35, 0.5), rnd(1.2, 1.7), rnd(0.45, 0.7), FX.smoke, -1.2, 2.5);
      }
      // dust off the tarmac
      const off = w.surface === Surface.Runoff || w.surface === Surface.Dirt;
      const nd = this.emit(`d${id}${i}`, off && spd > 5 ? spd * 1.4 : 0, dt);
      for (let k = 0; k < nd; k++) {
        _p.copy(w.cp).addScaledVector(_u, 0.15);
        _v.copy(_f).multiplyScalar(-rnd(2, 5)).addScaledVector(_r, rnd(-2, 2)).add(new Vector3(0, rnd(1, 3), 0));
        this.blobs.spawn(_p, _v, rnd(0.25, 0.4), rnd(1.0, 1.6), rnd(0.5, 0.8), FX.dust, 2, 2.2, w.cp.y);
      }
      // drift sparks in charge-stage color
      if (v.drift.active && v.drift.stage > 0) {
        const ns = this.emit(`k${id}${i}`, 26 + v.drift.stage * 14, dt);
        for (let k = 0; k < ns; k++) {
          _p.copy(w.cp).addScaledVector(_u, 0.08);
          _v.copy(_f).multiplyScalar(-rnd(3, 8)).addScaledVector(_r, rnd(-3, 3)).add(new Vector3(0, rnd(1.5, 4.5), 0)).addScaledVector(b.vel, 0.6);
          this.sparks.spawn(_p, _v, rnd(0.2, 0.4), FX.spark[v.drift.stage - 1], 14, w.cp.y + 0.02);
        }
      }
    }
    // boost embers from the exhausts
    if (v.drift.boosting) {
      const n = this.emit(`b${id}`, 40, dt);
      for (let k = 0; k < n; k++) {
        b.localToWorld(_p.set(rnd(-0.45, 0.45), -0.28, 2.5), _p);
        _v.copy(_f).multiplyScalar(-rnd(5, 10)).addScaledVector(_u, rnd(-0.5, 1.5)).addScaledVector(b.vel, 0.8);
        this.sparks.spawn(_p, _v, rnd(0.15, 0.3), Math.random() < 0.5 ? FX.flame : FX.flameCore, 2);
      }
    }
    this.events(r, v, dt);
  }

  private boat(r: Racer, v: Boat, dt: number) {
    const b = v.body;
    v.forward(_f);
    v.right(_r);
    v.up(_u);
    const id = r.id;
    const spd = v.speed;
    const wet = v.wetRatio > 0.04;
    const wake = this.world.wake;
    if (wet && spd > 2) {
      // wake: two stern stamps + a fainter bow stamp; widening/decay happens in the map
      const k = Math.min(1, spd / 18) * Math.min(1, v.wetRatio * 3) * dt * 60;
      for (const sx of [-0.9, 0.9]) {
        b.localToWorld(_p.set(sx, 0, HULL_STERN_Z - 0.2), _p);
        wake?.stamp(_p.x, _p.z, 1.0 + spd * 0.02, 0.1 * k);
      }
      if (v.drift.active) {
        b.localToWorld(_p.set(-v.drift.dir * 1.0, 0, HULL_STERN_Z - 0.4), _p);
        wake?.stamp(_p.x, _p.z, 2.2, 0.16 * k);
      }
    }
    // bow spray, both sides
    if (wet && spd > 5) {
      const n = this.emit(`bow${id}`, spd * 1.3 * (0.35 + Math.min(1, v.bowWet * 2 + v.planing)), dt);
      // bow spray fans OUT to the sides (never up over the hull, where it would hide the boat)
      for (let k = 0; k < n; k++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        b.localToWorld(_p.set(side * rnd(0.8, 1.1), -0.1, rnd(-1.6, -0.6)), _p);
        _v.copy(_r).multiplyScalar(side * rnd(4, 6 + spd * 0.2)).add(new Vector3(0, rnd(1.5, 2.5 + spd * 0.08), 0)).addScaledVector(b.vel, 0.4);
        this.blobs.spawn(_p, _v, rnd(0.25, 0.4), rnd(0.45, 0.7), rnd(0.5, 0.75), FX.spray, 9.8, 0.6, this.waterH(_p.x, _p.z) - 0.4);
      }
    }
    // rooster tail from the prop
    if (v.propSub > 0.3 && v.controls.throttle > 0.3 && spd > 6) {
      const boost = v.drift.boosting ? 1 : 0;
      // rooster tail: a low arc left BEHIND the boat (world velocity mostly zero), tall only on boost
      const n = this.emit(`rt${id}`, 8 + spd * 0.3 + boost * 20, dt);
      for (let k = 0; k < n; k++) {
        b.localToWorld(_p.set(rnd(-0.2, 0.2), -0.2, HULL_STERN_Z + 0.9), _p);
        _v.copy(_f).multiplyScalar(-rnd(0.05, 0.2) * spd).addScaledVector(_r, rnd(-1, 1)).add(new Vector3(0, rnd(2, 3.2) + boost * 2.5, 0)).addScaledVector(b.vel, 0.15);
        this.blobs.spawn(_p, _v, rnd(0.3, 0.45), rnd(0.55, 0.9) + boost * 0.4, rnd(0.55, 0.8), FX.spray, 9.8, 0.4, this.waterH(_p.x, _p.z) - 0.4);
      }
    }
    // drift spray wall off the swinging stern
    if (v.drift.active && wet) {
      const side = -v.drift.dir;
      const n = this.emit(`dw${id}`, 12 + spd * 0.3, dt);
      for (let k = 0; k < n; k++) {
        b.localToWorld(_p.set(side * 1.1, 0, rnd(0, HULL_STERN_Z)), _p);
        _v.copy(_r).multiplyScalar(side * rnd(6, 10)).add(new Vector3(0, rnd(2.5, 4.5), 0)).addScaledVector(_f, -rnd(1, 3));
        this.blobs.spawn(_p, _v, rnd(0.3, 0.45), rnd(0.7, 1.1), rnd(0.5, 0.75), FX.spray, 9.8, 0.7, this.waterH(_p.x, _p.z) - 0.4);
      }
      if (v.drift.stage > 0) {
        const ns = this.emit(`ds${id}`, 20 + v.drift.stage * 14, dt);
        for (let k = 0; k < ns; k++) {
          b.localToWorld(_p.set(side * 0.8, 0.1, HULL_STERN_Z), _p);
          _v.copy(_r).multiplyScalar(side * rnd(2, 6)).add(new Vector3(0, rnd(2, 5), 0)).addScaledVector(b.vel, 0.5);
          this.sparks.spawn(_p, _v, rnd(0.25, 0.45), FX.spark[v.drift.stage - 1], 9);
        }
      }
    }
    if (v.drift.boosting) {
      const n = this.emit(`bb${id}`, 30, dt);
      for (let k = 0; k < n; k++) {
        b.localToWorld(_p.set(rnd(-0.2, 0.2), 0.5, HULL_STERN_Z + 0.8), _p);
        _v.copy(_f).multiplyScalar(-rnd(4, 8)).add(new Vector3(0, rnd(0, 2), 0)).addScaledVector(b.vel, 0.8);
        this.sparks.spawn(_p, _v, rnd(0.15, 0.3), Math.random() < 0.5 ? FX.boostFlame : FX.flameCore, 2);
      }
    }
    this.events(r, v, dt);
  }

  private events(r: Racer, v: Car | Boat, _dt: number) {
    const e = v.events;
    const b = v.body;
    const isBoat = v instanceof Boat;
    if (e.wallHit > 2.2) {
      const n = Math.min(26, 6 + e.wallHit * 3);
      for (let k = 0; k < n; k++) {
        _v.set(rnd(-1, 1), rnd(0.2, 1.2), rnd(-1, 1)).normalize().multiplyScalar(rnd(3, 9)).addScaledVector(b.vel, 0.3);
        if (isBoat) this.blobs.spawn(e.wallPoint, _v, rnd(0.25, 0.4), rnd(0.6, 1.0), rnd(0.5, 0.8), FX.spray, 9.8, 0.8, -0.5);
        else this.sparks.spawn(e.wallPoint, _v, rnd(0.2, 0.45), Math.random() < 0.5 ? FX.sparkWhite : FX.flame, 12);
      }
    }
    if (e.landed > 2.5) {
      // ring thrown OUTWARD from a radius around the hull so the vehicle itself stays readable
      const n = Math.min(16, 6 + e.landed * 1.5);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        _p.set(b.pos.x + Math.cos(a) * 1.8, b.pos.y - (isBoat ? 0.3 : 0.6), b.pos.z + Math.sin(a) * 1.8);
        _v.set(Math.cos(a) * rnd(4, 7), rnd(1, 2.5) + (isBoat ? Math.min(3, e.landed * 0.25) : 0), Math.sin(a) * rnd(4, 7)).addScaledVector(b.vel, 0.5);
        this.blobs.spawn(_p, _v, rnd(0.3, 0.45), rnd(0.6, 0.95), rnd(0.45, 0.7), isBoat ? FX.spray : FX.dust, isBoat ? 9.8 : 1, 1.5, _p.y - 0.5);
      }
      if (isBoat) this.world.wake?.stamp(b.pos.x, b.pos.z, 5 + e.landed * 0.3, 1.2);
    }
    if (isBoat && e.splash > 4) {
      v.forward(_f);
      for (let k = 0; k < 10; k++) {
        b.localToWorld(_p.set(rnd(-0.8, 0.8), 0, -1.6), _p);
        _v.set(rnd(-3, 3), rnd(3, 5 + e.splash * 0.4), rnd(-3, 3)).addScaledVector(b.vel, 0.4);
        this.blobs.spawn(_p, _v, rnd(0.3, 0.5), rnd(0.8, 1.3), rnd(0.6, 0.9), FX.spray, 9.8, 0.6, _p.y - 0.8);
      }
    }
    if (e.stageUp) {
      for (let k = 0; k < 14; k++) {
        b.localToWorld(_p.set(rnd(-1, 1), 0.2, 1.8), _p);
        _v.set(rnd(-4, 4), rnd(2, 6), rnd(-4, 4)).addScaledVector(b.vel, 0.7);
        this.sparks.spawn(_p, _v, rnd(0.3, 0.5), FX.spark[e.stageUp - 1], 8);
      }
    }
    if (e.boost) {
      v.forward(_f);
      for (let k = 0; k < 24; k++) {
        b.localToWorld(_p.set(rnd(-0.6, 0.6), 0, 2.3), _p);
        _v.copy(_f).multiplyScalar(-rnd(6, 14)).add(new Vector3(rnd(-2, 2), rnd(0, 3), rnd(-2, 2))).addScaledVector(b.vel, 0.7);
        this.sparks.spawn(_p, _v, rnd(0.25, 0.5), FX.spark[Math.max(0, e.boost - 1)], 4);
      }
    }
    void r;
  }

  clear() {
    this.blobs.clear();
    this.sparks.clear();
    this.skids?.clear();
  }
}
