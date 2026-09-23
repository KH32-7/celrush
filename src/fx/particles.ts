import { BoxGeometry, Color, IcosahedronGeometry, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { smoothstep } from '../core/math';
import { makeToon, MASK } from '../render/toon';
import { col } from '../tuning/palette';

interface P {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; max: number;
  s0: number; s1: number;
  g: number; drag: number;
  floor: number;
  rx: number; ry: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();
const _p = new Vector3();
const _c = new Color();
const _axis = new Vector3();
const _z = new Vector3(0, 0, 1);

/**
 * Manga-style effects: smoke, dust and spray are OPAQUE low-poly blobs that get the same ink outline as
 * everything else (no soft alpha sprites). They fade by shrinking, the way inked FX pop out.
 */
export class Blobs {
  readonly mesh: InstancedMesh;
  private ps: P[] = [];
  private free: number[] = [];
  private alive: number[] = [];
  private colors: Color[] = [];

  constructor(readonly max = 1400) {
    // radius 0.5: spawn sizes are diameters in meters
    const geo = new IcosahedronGeometry(0.5, 1); // detail 1: reads as a puff, detail 0 read as gravel
    const mat = makeToon({ color: 0xffffff, mask: MASK.particle, rim: 0.4 });
    this.mesh = new InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    for (let i = 0; i < max; i++) {
      this.ps.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, s0: 1, s1: 1, g: 0, drag: 0, floor: -1e9, rx: 0, ry: 0 });
      this.free.push(max - 1 - i);
      this.colors.push(new Color());
      this.mesh.setColorAt(i, _c.setRGB(1, 1, 1));
    }
    this.mesh.count = 0;
  }

  spawn(pos: Vector3, vel: Vector3, size0: number, size1: number, life: number, hex: number, gravity = 0, drag = 1.5, floor = -1e9) {
    const i = this.free.pop();
    if (i === undefined) return;
    const p = this.ps[i];
    p.x = pos.x; p.y = pos.y; p.z = pos.z;
    p.vx = vel.x; p.vy = vel.y; p.vz = vel.z;
    p.life = 0; p.max = life; p.s0 = size0; p.s1 = size1; p.g = gravity; p.drag = drag; p.floor = floor;
    p.rx = Math.random() * 6.28; p.ry = Math.random() * 6.28;
    this.colors[i].copy(col(hex));
    this.alive.push(i);
  }

  /**
   * cam: blobs shrink away inside ~4 m of the camera so spray never becomes a wall over the screen.
   * focus: blobs on the camera -> focus sight line shrink too, so the player's vehicle stays visible.
   */
  update(dt: number, cam?: Vector3, focus?: Vector3) {
    let lx = 0, ly = 0, lz = 0, ll = 0;
    if (cam && focus) {
      lx = focus.x - cam.x; ly = focus.y - cam.y; lz = focus.z - cam.z;
      ll = lx * lx + ly * ly + lz * lz;
    }
    let n = 0;
    const keep: number[] = [];
    for (const i of this.alive) {
      const p = this.ps[i];
      p.life += dt;
      if (p.life >= p.max) {
        this.free.push(i);
        continue;
      }
      keep.push(i);
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy = p.vy * k - p.g * dt; p.vz *= k;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < p.floor) { p.y = p.floor; p.vy = Math.abs(p.vy) * 0.2; }
      const t = p.life / p.max;
      let s = p.s0 + (p.s1 - p.s0) * Math.sqrt(t);
      if (t > 0.65) s *= 1 - (t - 0.65) / 0.35;
      if (p.life < 0.07) {
        // ease-out-back: 0 -> ~1.12 -> 1 over the first 70 ms
        const u = p.life / 0.07 - 1;
        s *= 1 + 2.7 * u * u * u + 1.7 * u * u;
      }
      if (cam) {
        s *= smoothstep(1.5, 4.5, Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z));
        if (ll > 1) {
          const px = p.x - cam.x, py = p.y - cam.y, pz = p.z - cam.z;
          const u = (px * lx + py * ly + pz * lz) / ll;
          if (u > 0 && u < 1.08) {
            const dx = px - lx * u, dy = py - ly * u, dz = pz - lz * u;
            // clear tube, widest at the vehicle (~1.6 m) so the hull outline reads through the spray
            s *= smoothstep(0.35, 0.8 + 1.1 * Math.min(1, u), Math.hypot(dx, dy, dz) / (0.6 + s * 0.5));
          }
        }
      }
      _q.setFromAxisAngle(_axis.set(Math.sin(p.rx), 0.4, Math.cos(p.ry)).normalize(), p.rx + t * 2);
      _m.compose(_p.set(p.x, p.y, p.z), _q, _s.set(s, s * 0.85, s));
      this.mesh.setMatrixAt(n, _m);
      this.mesh.setColorAt(n, this.colors[i]);
      n++;
    }
    this.alive = keep;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    for (const i of this.alive) this.free.push(i);
    this.alive = [];
    this.mesh.count = 0;
  }
}

/** Emissive streaks (drift sparks, boost embers, wall scrapes) stretched along their velocity. */
export class Sparks {
  readonly mesh: InstancedMesh;
  private ps: P[] = [];
  private free: number[] = [];
  private alive: number[] = [];
  private colors: Color[] = [];

  constructor(readonly max = 600) {
    const geo = new BoxGeometry(0.07, 0.07, 1);
    const mat = makeToon({ color: 0xffffff, unlit: true, emissiveBoost: 2.4, mask: MASK.emissive });
    this.mesh = new InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < max; i++) {
      this.ps.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, s0: 1, s1: 1, g: 0, drag: 0, floor: -1e9, rx: 0, ry: 0 });
      this.free.push(max - 1 - i);
      this.colors.push(new Color());
      this.mesh.setColorAt(i, _c.setRGB(1, 1, 1));
    }
    this.mesh.count = 0;
  }

  spawn(pos: Vector3, vel: Vector3, life: number, hex: number, gravity = 9.8, floor = -1e9, len = 1) {
    const i = this.free.pop();
    if (i === undefined) return;
    const p = this.ps[i];
    p.x = pos.x; p.y = pos.y; p.z = pos.z;
    p.vx = vel.x; p.vy = vel.y; p.vz = vel.z;
    p.life = 0; p.max = life; p.g = gravity; p.floor = floor; p.drag = 1.2; p.s0 = len;
    this.colors[i].copy(col(hex));
    this.alive.push(i);
  }

  update(dt: number) {
    let n = 0;
    const keep: number[] = [];
    for (const i of this.alive) {
      const p = this.ps[i];
      p.life += dt;
      if (p.life >= p.max) { this.free.push(i); continue; }
      keep.push(i);
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy = p.vy * k - p.g * dt; p.vz *= k;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < p.floor) { p.y = p.floor; p.vy = Math.abs(p.vy) * 0.35; }
      const sp = Math.hypot(p.vx, p.vy, p.vz);
      const t = p.life / p.max;
      const len = Math.max(0.15, Math.min(sp * 0.045, 1.4)) * p.s0 * (1 - t * 0.6);
      _axis.set(p.vx, p.vy, p.vz).multiplyScalar(1 / (sp || 1));
      _q.setFromUnitVectors(_z, sp > 0.01 ? _axis : _z);
      const th = 1 - t * 0.5;
      _m.compose(_p.set(p.x, p.y, p.z), _q, _s.set(th, th, len));
      this.mesh.setMatrixAt(n, _m);
      this.mesh.setColorAt(n, this.colors[i]);
      n++;
    }
    this.alive = keep;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    for (const i of this.alive) this.free.push(i);
    this.alive = [];
    this.mesh.count = 0;
  }
}
