import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Mesh, Vector3 } from 'three';
import { DoubleSide } from 'three';
import { makeToon } from '../render/toon';
import { FX } from '../tuning/palette';

/** Ring buffer of tire-mark quads laid on the road surface. */
export class Skids {
  readonly mesh: Mesh;
  private pos: Float32Array;
  private attr: BufferAttribute;
  private w = 0;
  private count = 0;
  private last = new Map<number, { l: Vector3; r: Vector3 } | null>();
  private dirty = false;

  constructor(private max = 1800) {
    const g = new BufferGeometry();
    this.pos = new Float32Array(max * 4 * 3);
    this.attr = new BufferAttribute(this.pos, 3);
    this.attr.setUsage(DynamicDrawUsage);
    g.setAttribute('position', this.attr);
    const nrm = new Float32Array(max * 4 * 3);
    for (let i = 0; i < max * 4; i++) nrm[i * 3 + 1] = 1;
    g.setAttribute('normal', new BufferAttribute(nrm, 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(max * 4 * 2), 2));
    const idx = new Uint32Array(max * 6);
    for (let i = 0; i < max; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    g.setIndex(new BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    const mat = makeToon({ color: FX.skid, rim: 0, side: DoubleSide });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -4;
    this.mesh = new Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
  }

  add(key: number, p: Vector3, right: Vector3, width: number, active: boolean) {
    if (!active) {
      this.last.set(key, null);
      return;
    }
    const l = new Vector3().copy(p).addScaledVector(right, -width / 2);
    const r = new Vector3().copy(p).addScaledVector(right, width / 2);
    l.y += 0.03;
    r.y += 0.03;
    const prev = this.last.get(key);
    if (!prev) {
      this.last.set(key, { l, r });
      return;
    }
    const dist = prev.l.distanceTo(l);
    if (dist < 0.35) return;
    if (dist < 4) {
      const o = this.w * 12;
      const q = [prev.l, prev.r, r, l];
      for (let k = 0; k < 4; k++) {
        this.pos[o + k * 3] = q[k].x;
        this.pos[o + k * 3 + 1] = q[k].y;
        this.pos[o + k * 3 + 2] = q[k].z;
      }
      this.w = (this.w + 1) % this.max;
      this.count = Math.min(this.count + 1, this.max);
      this.dirty = true;
    }
    this.last.set(key, { l, r });
  }

  flush() {
    if (!this.dirty) return;
    this.attr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, this.count * 6);
    this.dirty = false;
  }

  clear() {
    this.count = 0;
    this.w = 0;
    this.last.clear();
    this.mesh.geometry.setDrawRange(0, 0);
  }
}
