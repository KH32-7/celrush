import { BufferGeometry, Color, Euler, Float32BufferAttribute, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';

const _a = new Vector3();
const _b = new Vector3();
const _n = new Vector3();
const _v = new Vector3();
const _nm = new Matrix3();

/**
 * Accumulates flat-shaded, vertex-colored triangles into one geometry.
 * One vehicle / prop = one draw call; hard facet normals give the post-process outline
 * clean interior edges to find.
 */
export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];

  tri(a: Vector3, b: Vector3, c: Vector3, color: Color) {
    _a.subVectors(b, a);
    _b.subVectors(c, a);
    _n.crossVectors(_a, _b);
    if (_n.lengthSq() < 1e-12) return this;
    _n.normalize();
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(_n.x, _n.y, _n.z);
      this.col.push(color.r, color.g, color.b);
      this.uv.push(0, 0);
    }
    return this;
  }

  /** a-b-c-d counter-clockwise seen from the front */
  quad(a: Vector3, b: Vector3, c: Vector3, d: Vector3, color: Color) {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
    return this;
  }

  /** Append any three geometry, transformed, tinted. Keeps its own (smooth) normals. */
  add(geo: BufferGeometry, m: Matrix4, color: Color, flat = false) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.getAttribute('position');
    const nAttr = g.getAttribute('normal');
    const uvAttr = g.getAttribute('uv');
    _nm.getNormalMatrix(m);
    for (let i = 0; i < p.count; i += 3) {
      const verts: Vector3[] = [];
      for (let k = 0; k < 3; k++) verts.push(new Vector3().fromBufferAttribute(p, i + k).applyMatrix4(m));
      if (flat) {
        this.tri(verts[0], verts[1], verts[2], color);
        continue;
      }
      for (let k = 0; k < 3; k++) {
        const v = verts[k];
        this.pos.push(v.x, v.y, v.z);
        _v.fromBufferAttribute(nAttr, i + k).applyMatrix3(_nm).normalize();
        this.nrm.push(_v.x, _v.y, _v.z);
        this.col.push(color.r, color.g, color.b);
        if (uvAttr) this.uv.push(uvAttr.getX(i + k), uvAttr.getY(i + k));
        else this.uv.push(0, 0);
      }
    }
    if (g !== geo) g.dispose();
    return this;
  }

  /**
   * Loft closed rings (all with the same vertex count) into a flat-shaded tube.
   * colorAt receives the quad's center and ring/segment indices.
   */
  loft(rings: Vector3[][], colorAt: (c: Vector3, ring: number, seg: number) => Color, capStart = true, capEnd = true) {
    const m = rings[0].length;
    const c = new Vector3();
    const centroid = (ring: Vector3[]) => {
      const ctr = new Vector3();
      for (const p of ring) ctr.add(p);
      return ctr.multiplyScalar(1 / ring.length);
    };
    const cents = rings.map(centroid);
    const nrm = new Vector3(), e1 = new Vector3(), e2 = new Vector3(), out = new Vector3();
    for (let r = 0; r < rings.length - 1; r++) {
      const A = rings[r], B = rings[r + 1];
      const axisC = new Vector3().addVectors(cents[r], cents[r + 1]).multiplyScalar(0.5);
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        c.copy(A[i]).add(A[j]).add(B[i]).add(B[j]).multiplyScalar(0.25);
        // orient every quad outward from the tube axis, whatever order the rings were given in
        e1.subVectors(A[j], A[i]);
        e2.subVectors(B[i], A[i]);
        nrm.crossVectors(e1, e2);
        out.subVectors(c, axisC);
        const color = colorAt(c, r, i);
        // winding (A[i], A[j], B[j]) has normal e1 x e2: keep it when that already points outward
        if (nrm.dot(out) >= 0) this.quad(A[i], A[j], B[j], B[i], color);
        else this.quad(A[i], B[i], B[j], A[j], color);
      }
    }
    const cap = (ring: Vector3[], awayFrom: Vector3, idx: number) => {
      const ctr = centroid(ring);
      const dir = new Vector3().subVectors(ctr, awayFrom);
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        e1.subVectors(ring[i], ctr);
        e2.subVectors(ring[j], ctr);
        nrm.crossVectors(e1, e2);
        const color = colorAt(ctr, idx, -1);
        if (nrm.dot(dir) >= 0) this.tri(ctr, ring[i], ring[j], color);
        else this.tri(ctr, ring[j], ring[i], color);
      }
    };
    if (capStart) cap(rings[0], cents[1], 0);
    if (capEnd) cap(rings[rings.length - 1], cents[rings.length - 2], rings.length - 1);
    return this;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _e = new Euler();
const _q = new Quaternion();
const _s = new Vector3();
const _p = new Vector3();
/** translate * rotate(XYZ euler) * scale */
export function trs(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _q.setFromEuler(_e.set(rx, ry, rz));
  return new Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}
