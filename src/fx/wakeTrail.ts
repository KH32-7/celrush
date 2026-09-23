import { BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Mesh } from 'three';
import { makeToon, MASK } from '../render/toon';
import { FX } from '../tuning/palette';

interface Pt {
  x: number;
  z: number;
  vx: number;
  vz: number;
  age: number;
  life: number;
  w: number;
  /** no quad joins this point to the previous one (boat was airborne / trail restarted) */
  cut: boolean;
}

/**
 * Foam ribbons cut into the water behind each hull: two arms from the stern corners that drift outward
 * (the Kelvin "V") plus a churned prop-wash stripe down the middle. Points stay where the water is and
 * spread sideways as they age, so the V opens by itself as the boat pulls away.
 */
export class WakeTrails {
  readonly mesh: Mesh;
  private trails = new Map<number, Pt[]>();
  /** ribbons whose next point must start a new strip */
  private broken = new Set<number>();
  private pos: Float32Array;
  private attr: BufferAttribute;

  constructor(private waterH: (x: number, z: number) => number, private maxQuads = 1400) {
    const g = new BufferGeometry();
    this.pos = new Float32Array(maxQuads * 4 * 3);
    this.attr = new BufferAttribute(this.pos, 3);
    this.attr.setUsage(DynamicDrawUsage);
    g.setAttribute('position', this.attr);
    const nrm = new Float32Array(maxQuads * 4 * 3);
    for (let i = 0; i < maxQuads * 4; i++) nrm[i * 3 + 1] = 1;
    g.setAttribute('normal', new BufferAttribute(nrm, 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(maxQuads * 4 * 2), 2));
    const idx = new Uint32Array(maxQuads * 6);
    for (let i = 0; i < maxQuads; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    g.setIndex(new BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    const mat = makeToon({ color: FX.spray, rim: 0.3, side: DoubleSide, mask: MASK.particle });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -4;
    this.mesh = new Mesh(g, mat);
    this.mesh.frustumCulled = false;
  }

  /**
   * Feed one trail point. key identifies the ribbon (racer * 3 + side), active=false breaks the ribbon.
   * (vx, vz) is the sideways drift of the foam in world space.
   */
  add(key: number, x: number, z: number, vx: number, vz: number, width: number, life: number, active: boolean) {
    let t = this.trails.get(key);
    if (!t) this.trails.set(key, (t = []));
    if (!active) {
      this.broken.add(key);
      return;
    }
    const last = t[t.length - 1];
    const cut = !last || this.broken.has(key);
    if (!cut && Math.hypot(x - last.x, z - last.z) < 0.9) return;
    this.broken.delete(key);
    t.push({ x, z, vx, vz, age: 0, life, w: width * (0.75 + Math.random() * 0.5), cut });
    if (t.length > 90) t.shift();
  }

  update(dt: number) {
    let q = 0;
    const P = this.pos;
    for (const t of this.trails.values()) {
      for (const p of t) {
        p.age += dt;
        const k = Math.exp(-0.9 * dt);
        p.vx *= k;
        p.vz *= k;
        p.x += p.vx * dt;
        p.z += p.vz * dt;
      }
      while (t.length && t[0].age >= t[0].life) t.shift();
      for (let i = 1; i < t.length && q < this.maxQuads; i++) {
        const a = t[i - 1], b = t[i];
        if (b.cut) continue;
        // ribbon cross direction = perpendicular to the segment, on the water plane
        let dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4 || len > 6) continue;
        dx /= len;
        dz /= len;
        const wa = this.width(a), wb = this.width(b);
        if (wa <= 0.02 && wb <= 0.02) continue;
        const ya = this.waterH(a.x, a.z) + 0.07, yb = this.waterH(b.x, b.z) + 0.07;
        const o = q * 12;
        // wound counter-clockwise seen from above so the up normal is the front face (lit, not shade-tinted)
        P[o] = a.x + dz * wa; P[o + 1] = ya; P[o + 2] = a.z - dx * wa;
        P[o + 3] = a.x - dz * wa; P[o + 4] = ya; P[o + 5] = a.z + dx * wa;
        P[o + 6] = b.x - dz * wb; P[o + 7] = yb; P[o + 8] = b.z + dx * wb;
        P[o + 9] = b.x + dz * wb; P[o + 10] = yb; P[o + 11] = b.z - dx * wb;
        q++;
      }
    }
    this.attr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, q * 6);
  }

  /** half-width: swells quickly as the foam spreads, then thins out and vanishes (inked FX shrink, not fade) */
  private width(p: Pt) {
    const t = p.age / p.life;
    const grow = Math.min(1, t * 6);
    const fade = t > 0.45 ? 1 - (t - 0.45) / 0.55 : 1;
    return p.w * 0.5 * (0.5 + 0.5 * grow) * fade * (1 + t * 0.8);
  }

  clear() {
    this.trails.clear();
    this.broken.clear();
    this.mesh.geometry.setDrawRange(0, 0);
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
  }
}
