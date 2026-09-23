import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { STEP } from '../src/core/loop';
import type { CourseDef } from '../src/track/courses';
import { Track } from '../src/track/track';
import { Boat } from '../src/vehicles/boat';
import { Car } from '../src/vehicles/car';
import type { SimEnv, Vehicle } from '../src/vehicles/vehicle';
import { Ground } from '../src/world/ground';
import { WaveField, WAVESETS } from '../src/world/water';

/** Huge flat ring: room to measure turning circles without walls interfering. */
function skidpad(vehicle: 'car' | 'boat'): CourseDef {
  const pts: [number, number, number][] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    pts.push([Math.cos(a) * 5000, 0, Math.sin(a) * 5000]);
  }
  return {
    id: 'pad', name: 'pad', tagline: '', vehicle, theme: 'city', scale: 1, pts,
    halfWidth: 250, curb: 0, runoff: 20, bankScale: 0, maxBank: 0, laps: 1, seed: 1, pads: [],
  };
}

function env(kind: 'car' | 'boat', waves?: string): SimEnv {
  const track = new Track(skidpad(kind));
  return {
    track,
    ground: kind === 'car' ? new Ground(track) : null,
    water: kind === 'boat' ? new WaveField(waves ? WAVESETS[waves] : []) : null,
    time: 0, spheres: [], ramps: [], current: 0,
  };
}

function run(v: Vehicle, e: SimEnv, seconds: number, each?: (t: number) => void) {
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) {
    e.time += STEP;
    if (e.water) e.water.time = e.time;
    v.clearEvents();
    v.step(STEP, e);
    each?.(i * STEP);
  }
}

const up = new Vector3();
const f = new Vector3();

// vitest swallows console output of passing tests; metrics go to a file instead
mkdirSync('tests/out', { recursive: true });
writeFileSync('tests/out/physics.log', '');
const log = (s: string) => {
  appendFileSync('tests/out/physics.log', s + '\n');
  console.log(s);
};

describe('car physics', () => {
  it('settles on its suspension', () => {
    const e = env('car');
    const car = new Car();
    car.place(e, 0, 0);
    run(car, e, 3);
    const h = car.body.pos.y - e.ground!.heightAt(car.body.pos.x, car.body.pos.z, -1);
    car.up(up);
    log(`car rest: COM height ${h.toFixed(3)}m, speed ${car.speed.toFixed(3)}, up.y ${up.y.toFixed(4)}, compression ${car.wheels.map((w) => w.x.toFixed(3)).join(',')}`);
    expect(car.speed).toBeLessThan(0.05);
    expect(up.y).toBeGreaterThan(0.999);
    expect(h).toBeGreaterThan(0.5);
    expect(h).toBeLessThan(0.9);
  });

  it('accelerates to a sane top speed', () => {
    const e = env('car');
    const car = new Car();
    car.place(e, 0, 0);
    run(car, e, 0.5);
    let t100 = -1;
    car.controls.throttle = 1;
    run(car, e, 25, (t) => {
      if (t100 < 0 && car.fwdSpeed > 27.78) t100 = t;
      // keep it roughly straight along the ring
      car.controls.steer = 0;
    });
    log(`car 0-100km/h ${t100.toFixed(2)}s, speed after 25s ${(car.speed * 3.6).toFixed(1)} km/h`);
    expect(t100).toBeGreaterThan(2.5);
    expect(t100).toBeLessThan(6);
    expect(car.speed).toBeGreaterThan(45);
    expect(car.speed).toBeLessThan(56);
  });

  it('grip turn and drift', () => {
    const e = env('car');
    const car = new Car();
    car.place(e, 0, 0);
    car.controls.throttle = 1;
    run(car, e, 3.2);
    const v0 = car.speed;
    car.controls.throttle = 0.6;
    car.controls.steer = 1;
    let rSum = 0, n = 0, slipMax = 0;
    run(car, e, 3, (t) => {
      if (t > 1.5) { rSum += -car.body.angVel.y; n++; }
      slipMax = Math.max(slipMax, Math.abs(car.slip));
    });
    const R = car.speed / (rSum / n);
    car.up(up);
    log(`car grip turn from ${(v0 * 3.6).toFixed(0)}km/h: radius ${R.toFixed(1)}m, end speed ${(car.speed * 3.6).toFixed(0)}km/h, max slip ${(slipMax * 57.3).toFixed(1)}deg, up.y ${up.y.toFixed(3)}`);
    expect(up.y).toBeGreaterThan(0.9);

    // straighten, then drift
    car.controls.steer = 0;
    car.controls.throttle = 1;
    run(car, e, 3);
    const vd0 = car.speed;
    car.controls.steer = 0.8;
    car.controls.drift = true;
    let slipSum = 0; n = 0; rSum = 0;
    let stages = 0;
    run(car, e, 2.8, (t) => {
      if (car.events.stageUp) stages = car.events.stageUp;
      if (t > 0.8) { slipSum += car.slip; rSum += -car.body.angVel.y; n++; }
    });
    const vd1 = car.speed;
    const Rd = vd1 / (rSum / n);
    car.controls.drift = false;
    let boost = 0;
    run(car, e, 0.1, () => { if (car.events.boost) boost = car.events.boost; });
    car.up(up);
    log(`car drift: ${(vd0 * 3.6).toFixed(0)} -> ${(vd1 * 3.6).toFixed(0)} km/h, avg slip ${((slipSum / n) * 57.3).toFixed(1)}deg, radius ${Rd.toFixed(1)}m, stage ${stages}, boost ${boost}, up.y ${up.y.toFixed(3)}`);
    expect(stages).toBeGreaterThanOrEqual(2);
    expect(boost).toBeGreaterThanOrEqual(2);
    expect(up.y).toBeGreaterThan(0.9);
    expect(vd1 / vd0).toBeGreaterThan(0.72);
  });
});

describe('boat physics', () => {
  it('floats level at rest', () => {
    const e = env('boat');
    const boat = new Boat();
    boat.place(e, 0, 0);
    run(boat, e, 6);
    boat.up(up);
    boat.forward(f);
    log(`boat rest: COM y ${boat.body.pos.y.toFixed(3)}, trim ${(Math.asin(f.y) * 57.3).toFixed(2)}deg, up.y ${up.y.toFixed(4)}, speed ${boat.speed.toFixed(3)}, wet ${boat.wetRatio.toFixed(2)}`);
    expect(up.y).toBeGreaterThan(0.995);
    expect(boat.speed).toBeLessThan(0.05);
    expect(boat.body.pos.y).toBeGreaterThan(0);
    expect(boat.body.pos.y).toBeLessThan(0.5);
  });

  it('planes and reaches top speed', () => {
    const e = env('boat');
    const boat = new Boat();
    boat.place(e, 0, 0);
    run(boat, e, 2);
    boat.controls.throttle = 1;
    let t60 = -1;
    const trims: string[] = [];
    run(boat, e, 25, (t) => {
      if (t60 < 0 && boat.fwdSpeed > 16.67) t60 = t;
      if (Math.abs(t % 4) < STEP) {
        boat.forward(f);
        trims.push(`${(boat.fwdSpeed * 3.6).toFixed(0)}km/h trim ${(Math.asin(f.y) * 57.3).toFixed(1)} y ${boat.body.pos.y.toFixed(2)} wet ${boat.wetRatio.toFixed(2)}`);
      }
    });
    boat.forward(f);
    log(`boat 0-60km/h ${t60.toFixed(2)}s, top ${(boat.speed * 3.6).toFixed(1)}km/h, trim ${(Math.asin(f.y) * 57.3).toFixed(1)}deg, wet ${boat.wetRatio.toFixed(2)}\n  ${trims.join('\n  ')}`);
    expect(boat.speed).toBeGreaterThan(26);
    expect(boat.speed).toBeLessThan(36);
  });

  it('turns and drifts without capsizing', () => {
    const e = env('boat');
    const boat = new Boat();
    boat.place(e, 0, 0);
    boat.controls.throttle = 1;
    run(boat, e, 8);
    const v0 = boat.speed;
    boat.controls.steer = 1;
    let rSum = 0, n = 0, rollMax = 0;
    run(boat, e, 4, (t) => {
      boat.right(f);
      rollMax = Math.max(rollMax, Math.abs(Math.asin(f.y)));
      if (t > 2) { rSum += -boat.body.angVel.y; n++; }
    });
    const R = boat.speed / (rSum / n);
    log(`boat turn from ${(v0 * 3.6).toFixed(0)}km/h: radius ${R.toFixed(1)}m, end ${(boat.speed * 3.6).toFixed(0)}km/h, max heel ${(rollMax * 57.3).toFixed(1)}deg`);
    boat.controls.steer = 0;
    run(boat, e, 4);
    const vd0 = boat.speed;
    boat.controls.steer = 0.8;
    boat.controls.drift = true;
    let slipSum = 0, stages = 0;
    n = 0; rSum = 0;
    run(boat, e, 2.8, (t) => {
      if (boat.events.stageUp) stages = boat.events.stageUp;
      if (t > 0.8) { slipSum += boat.slip; rSum += -boat.body.angVel.y; n++; }
    });
    const vd1 = boat.speed;
    boat.up(up);
    log(`boat drift: ${(vd0 * 3.6).toFixed(0)} -> ${(vd1 * 3.6).toFixed(0)}km/h, slip ${((slipSum / n) * 57.3).toFixed(1)}deg, radius ${(vd1 / (rSum / n)).toFixed(1)}m, stage ${stages}, up.y ${up.y.toFixed(3)}`);
    expect(up.y).toBeGreaterThan(0.8);
    expect(stages).toBeGreaterThanOrEqual(2);
  });

  it('rides storm swells without blowing up', () => {
    const e = env('boat', 'storm');
    const boat = new Boat();
    boat.place(e, 0, 0);
    boat.controls.throttle = 1;
    let air = 0, maxAir = 0, landings = 0;
    run(boat, e, 30, () => {
      if (!boat.grounded) { air += STEP; maxAir = Math.max(maxAir, air); } else air = 0;
      if (boat.events.landed) landings++;
    });
    boat.up(up);
    log(`storm: speed ${(boat.speed * 3.6).toFixed(0)}km/h, longest air ${maxAir.toFixed(2)}s, landings ${landings}, up.y ${up.y.toFixed(3)}, finite ${boat.body.isFinite()}`);
    expect(boat.body.isFinite()).toBe(true);
    expect(up.y).toBeGreaterThan(0.5);
  });
});
