import { ShaderMaterial, Vector3, type Mesh, type Object3D } from 'three';
import { toonGlobals } from '../render/toon';
import { Boat } from '../vehicles/boat';
import { Car } from '../vehicles/car';
import { buildBoat, buildCar, type BoatView, type CarView } from '../vehicles/models';
import type { AIDriver } from './ai';

let nextId = 0;

/** Clone every material on obj into a dithered see-through variant (ghost cars, respawn blink). */
export function ghostify(obj: Object3D, amount = 0.45) {
  obj.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const mat = m.material as ShaderMaterial;
    if (!mat.isShaderMaterial || !mat.uniforms.uGhost) return;
    const c = mat.clone();
    Object.assign(c.uniforms, toonGlobals);
    c.uniforms.uGhost.value = amount;
    m.material = c;
    m.castShadow = false;
  });
}

/** A vehicle in the race: physics body + its view + race bookkeeping. */
export class Racer {
  readonly id = nextId++;
  readonly vehicle: Car | Boat;
  readonly view: CarView | BoatView;
  readonly kind: 'car' | 'boat';
  ai: AIDriver | null = null;
  progress = 0;
  prevS = 0;
  lap = 0;
  lapStart = 0;
  lapTimes: number[] = [];
  best = Infinity;
  finished = false;
  finishTime = 0;
  place = 1;
  wrongT = 0;
  padCd: number[] = [];
  sector = 0;
  private blinkT = 0;

  constructor(kind: 'car' | 'boat', readonly livery: number, readonly name: string, readonly isPlayer: boolean) {
    this.kind = kind;
    if (kind === 'car') {
      this.vehicle = new Car();
      this.view = buildCar(livery);
    } else {
      this.vehicle = new Boat();
      this.view = buildBoat(livery);
    }
    this.vehicle.livery = livery;
    this.vehicle.isPlayer = isPlayer;
  }

  sync(alpha: number, dt: number) {
    const v = this.vehicle;
    const root = this.view.root;
    v.pose(alpha, root.position, root.quaternion);
    this.blinkT += dt;
    root.visible = v.ghostT <= 0 || Math.floor(this.blinkT * 14) % 2 === 0;
    if (v instanceof Car) {
      const view = this.view as CarView;
      for (let i = 0; i < 4; i++) {
        const w = v.wheels[i];
        const pv = view.wheels[i];
        pv.position.set(w.mount.x, w.mount.y - w.dist, w.mount.z);
        pv.rotation.set(-w.spin, w.front ? -v.steerAngle : 0, 0, 'YXZ');
      }
      const boosting = v.drift.boosting;
      for (const f of view.flames) {
        f.visible = boosting;
        if (boosting) {
          const k = 0.75 + Math.random() * 0.5;
          f.scale.set(k, 0.8 + Math.random() * 0.6 + v.drift.boostTime * 0.3, k);
        }
      }
      (view.brake.material as ShaderMaterial).uniforms.uEmissiveBoost.value = v.controls.brake > 0.1 && v.fwdSpeed > 0.5 ? 3.4 : 1.1;
    } else {
      const view = this.view as BoatView;
      view.engine.rotation.y = -(v as Boat).steerAngle * 1.3;
      for (const f of view.flames) {
        f.visible = v.drift.boosting;
        if (f.visible) {
          const k = 0.8 + Math.random() * 0.5;
          f.scale.set(k, 0.9 + Math.random() * 0.7, k);
        }
      }
    }
  }

  worldPos(out: Vector3) {
    return out.copy(this.vehicle.body.pos);
  }
}
