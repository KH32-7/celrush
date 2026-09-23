import {
  BoxGeometry, Color, ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh,
  Object3D, PlaneGeometry, Quaternion, Scene, SphereGeometry, Vector3,
} from 'three';
import { fbm2, ridged2, Rng, valueNoise2 } from '../core/rng';
import { MeshBuilder, trs } from '../render/geom';
import { makeToon, MASK, toonGlobals } from '../render/toon';
import { col, FX, type Theme } from '../tuning/palette';
import { RENDER } from '../tuning/params';
import type { Track, TrackFrame } from '../track/track';

const _v = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _m = new Matrix4();
const _c = new Color();
export const frame = (): TrackFrame => ({ pos: new Vector3(), tan: new Vector3(), right: new Vector3(), up: new Vector3() });

// ------------------------------------------------------------ light

export function setupLight(scene: Scene, t: Theme) {
  const sunDir = new Vector3(...t.sunDir).normalize();
  toonGlobals.uSunDir.value.copy(sunDir);
  toonGlobals.uSunColor.value.copy(col(t.sunColor)).multiplyScalar(t.sunIntensity);
  toonGlobals.uShadeTint.value.copy(col(t.shadeTint));
  toonGlobals.uRimColor.value.copy(col(t.rim));
  toonGlobals.uNight.value = t.night ? 1 : 0;
  toonGlobals.uHeadOn.value = t.night ? 1 : 0;
  toonGlobals.uHeadColor.value.copy(col(FX.headlight));
  const sun = new DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  const e = RENDER.shadowExtent;
  sun.shadow.camera.left = -e;
  sun.shadow.camera.right = e;
  sun.shadow.camera.top = e;
  sun.shadow.camera.bottom = -e;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 600;
  sun.shadow.mapSize.set(RENDER.shadowMapSize, RENDER.shadowMapSize);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.05;
  scene.add(sun);
  scene.add(sun.target);
  return {
    sun,
    /** keep the shadow frustum on the focus, snapped to texels so shadow edges don't crawl */
    follow(focus: Vector3) {
      const texel = (2 * e) / RENDER.shadowMapSize;
      const fx = Math.round(focus.x / texel) * texel;
      const fz = Math.round(focus.z / texel) * texel;
      sun.target.position.set(fx, focus.y, fz);
      sun.position.set(fx + sunDir.x * 300, focus.y + sunDir.y * 300, fz + sunDir.z * 300);
      sun.target.updateMatrixWorld();
    },
  };
}

// ------------------------------------------------------------ sky furniture

export function makeClouds(t: Theme, rng: Rng, center: Vector3, count: number, rMin: number, rMax: number, yMin: number, yMax: number) {
  const mb = new MeshBuilder();
  const top = col(t.sky.cloud), shade = col(t.sky.cloudShade);
  // one cloud = cluster of puffs with a flattened underside
  for (let i = 0; i < 9; i++) {
    const x = (i - 4) * 0.55 + rng.range(-0.2, 0.2);
    const r = 0.75 + (1 - Math.abs(i - 4) / 5) * 0.9 + rng.range(-0.1, 0.2);
    const y = r * 0.3;
    const g = new IcosahedronGeometry(r, 1);
    const pos = g.getAttribute('position');
    for (let k = 0; k < pos.count; k++) if (pos.getY(k) < -r * 0.25) pos.setY(k, -r * 0.25);
    g.computeVertexNormals();
    mb.add(g, trs(x, y, rng.range(-0.4, 0.4)), _c.copy(top).lerp(shade, i % 3 === 0 ? 0.25 : 0), true);
  }
  const geo = mb.build();
  const mat = makeToon({ vertexColors: true, rim: 1, mask: MASK.backdrop });
  const mesh = new InstancedMesh(geo, mat, count);
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(rMin, rMax);
    const s = rng.range(14, 34);
    _q.setFromAxisAngle(_v.set(0, 1, 0), rng.range(0, Math.PI * 2));
    _m.compose(_v.set(center.x + Math.cos(a) * r, rng.range(yMin, yMax), center.z + Math.sin(a) * r), _q, _s.set(s * rng.range(1.2, 2), s, s));
    mesh.setMatrixAt(i, _m);
  }
  mesh.frustumCulled = false;
  return mesh;
}

/** Two silhouette rings of peaks on the horizon, the far one paler: painted-backdrop depth. */
export function makeBackdrop(t: Theme, rng: Rng, center: Vector3, opts: { snow?: boolean; heightMul?: number; radius?: number } = {}) {
  const group = new Group();
  const R0 = opts.radius ?? 2300;
  const layers = [
    { r: R0, h: [140, 560], color: t.ground.rock2, fogMix: 0.5 },
    { r: R0 * 0.68, h: [50, 230], color: t.ground.grass2, fogMix: 0.28 },
  ];
  const fog = col(t.fog);
  for (let li = 0; li < layers.length; li++) {
    const L = layers[li];
    const mb = new MeshBuilder();
    const N = 220;
    const seed = rng.int(0, 9999);
    const base = new Color().copy(col(L.color)).lerp(fog, L.fogMix);
    const snowC = new Color().copy(col(t.ground.snow)).lerp(fog, L.fogMix * 0.6);
    const hts: number[] = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const n = ridged2(Math.cos(a) * 3 + 10, Math.sin(a) * 3 + 10, 5, seed);
      hts.push((L.h[0] + (L.h[1] - L.h[0]) * n) * (opts.heightMul ?? 1));
    }
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      const p0 = new Vector3(center.x + Math.cos(a0) * L.r, -30, center.z + Math.sin(a0) * L.r);
      const p1 = new Vector3(center.x + Math.cos(a1) * L.r, -30, center.z + Math.sin(a1) * L.r);
      // the peak sits between samples, pushed back so ridges have faces toward and away from the sun
      const am = (a0 + a1) / 2;
      const pk = new Vector3(center.x + Math.cos(am) * (L.r + 60), (hts[i] + hts[i + 1]) / 2, center.z + Math.sin(am) * (L.r + 60));
      const q0 = new Vector3(p0.x, hts[i], p0.z), q1 = new Vector3(p1.x, hts[i + 1], p1.z);
      const hMid = (hts[i] + hts[i + 1]) / 2;
      const c = opts.snow && hMid > L.h[1] * 0.72 ? snowC : base;
      mb.quad(p1, p0, q0, q1, base);
      mb.tri(q1, q0, pk, c);
    }
    const mesh = new Mesh(mb.build(), makeToon({ vertexColors: true, rim: 0.3, mask: MASK.backdrop, side: DoubleSide }));
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}

// ------------------------------------------------------------ vegetation / rocks

export type TreeKind = 'pine' | 'round' | 'palm';

function treeGeometry(kind: TreeKind, t: Theme) {
  const mb = new MeshBuilder();
  const trunk = col(t.props.trunk);
  const leaf = t.props.leaf.map((h) => col(h));
  if (kind === 'pine') {
    mb.add(new CylinderGeometry(0.25, 0.35, 2.4, 6), trs(0, 1.2, 0), trunk, true);
    mb.add(new ConeGeometry(2.6, 3.6, 7), trs(0, 3.6, 0), leaf[0], true);
    mb.add(new ConeGeometry(2.0, 3.0, 7), trs(0, 5.4, 0, 0, 0.4), leaf[1 % leaf.length], true);
    mb.add(new ConeGeometry(1.3, 2.6, 7), trs(0, 7.0, 0, 0, 0.9), leaf[0], true);
  } else if (kind === 'round') {
    mb.add(new CylinderGeometry(0.22, 0.3, 2.4, 6), trs(0, 1.2, 0), trunk, true);
    mb.add(new IcosahedronGeometry(2.1, 0), trs(0, 3.8, 0), leaf[0], true);
    mb.add(new IcosahedronGeometry(1.4, 0), trs(0.9, 4.6, 0.3), leaf[1 % leaf.length], true);
    mb.add(new IcosahedronGeometry(1.2, 0), trs(-0.8, 4.3, -0.5), leaf[1 % leaf.length], true);
  } else {
    // palm: bent trunk segments + drooping fronds
    let x = 0, y = 0;
    for (let i = 0; i < 6; i++) {
      const a = i * 0.07;
      mb.add(new CylinderGeometry(0.2 - i * 0.015, 0.24 - i * 0.015, 1.25, 6), trs(x, y + 0.6, 0, 0, 0, -a), trunk, true);
      x += Math.sin(a) * 1.2;
      y += Math.cos(a) * 1.15;
    }
    for (let k = 0; k < 7; k++) {
      const ang = (k / 7) * Math.PI * 2;
      const m = new Matrix4().compose(
        new Vector3(x + Math.cos(ang) * 1.2, y - 0.1, Math.sin(ang) * 1.2),
        new Quaternion().setFromAxisAngle(new Vector3(-Math.sin(ang), 0, Math.cos(ang)), 0.55),
        new Vector3(1, 1, 1),
      );
      const frond = new BoxGeometry(2.6, 0.08, 0.7);
      frond.rotateY(-ang);
      mb.add(frond, m, leaf[k % leaf.length], true);
    }
  }
  return mb.build();
}

export function makeTrees(kind: TreeKind, t: Theme, pts: { x: number; y: number; z: number; s: number; r: number }[], rng: Rng) {
  const geo = treeGeometry(kind, t);
  const mat = makeToon({ vertexColors: true, rim: 0.8, defines: { WIND: 1 } });
  const mesh = new InstancedMesh(geo, mat, Math.max(1, pts.length));
  mesh.count = pts.length;
  pts.forEach((p, i) => {
    _q.setFromAxisAngle(_v.set(0, 1, 0), p.r);
    _m.compose(_v.set(p.x, p.y, p.z), _q, _s.set(p.s, p.s * rng.range(0.9, 1.15), p.s));
    mesh.setMatrixAt(i, _m);
    const v = rng.range(0.88, 1.08);
    mesh.setColorAt(i, _c.setRGB(v, v * rng.range(0.97, 1.03), v));
  });
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

export function rockGeometry(t: Theme, seed: number, detail = 1) {
  const g = new IcosahedronGeometry(1, detail);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    const n = valueNoise2(_v.x * 1.7 + seed, _v.z * 1.7 + _v.y * 1.3, seed) * 0.5 + fbm2(_v.x * 3 + 5, _v.y * 3 + _v.z, 2, seed) * 0.25;
    _v.multiplyScalar(0.72 + n * 0.6);
    if (_v.y < -0.3) _v.y = -0.3;
    pos.setXYZ(i, _v.x, _v.y, _v.z);
  }
  const mb = new MeshBuilder();
  const c1 = col(t.ground.rock), c2 = col(t.ground.rock2);
  const ng = g.index ? g.toNonIndexed() : g;
  const p = ng.getAttribute('position');
  const rng = new Rng(seed);
  for (let i = 0; i < p.count; i += 3) {
    const a = new Vector3().fromBufferAttribute(p, i), b = new Vector3().fromBufferAttribute(p, i + 1), c = new Vector3().fromBufferAttribute(p, i + 2);
    mb.tri(a, b, c, rng.next() < 0.6 ? c1 : c2);
  }
  return mb.build();
}

export function makeRocks(t: Theme, pts: { x: number; y: number; z: number; s: number; r: number; sy?: number }[], seed: number) {
  const mesh = new InstancedMesh(rockGeometry(t, seed), makeToon({ vertexColors: true, spec: 0.1, rim: 0.7 }), Math.max(1, pts.length));
  mesh.count = pts.length;
  pts.forEach((p, i) => {
    _q.setFromAxisAngle(_v.set(0, 1, 0), p.r);
    _m.compose(_v.set(p.x, p.y, p.z), _q, _s.set(p.s, p.s * (p.sy ?? 0.8), p.s * 1.1));
    mesh.setMatrixAt(i, _m);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

// ------------------------------------------------------------ structures

export function makeLighthouse(t: Theme, h = 26) {
  const mb = new MeshBuilder();
  const a = col(t.props.towerA), b = col(t.props.towerB);
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    const y0 = (i / bands) * h, y1 = ((i + 1) / bands) * h;
    const r0 = 3.2 - (i / bands) * 1.4, r1 = 3.2 - ((i + 1) / bands) * 1.4;
    mb.add(new CylinderGeometry(r1, r0, y1 - y0, 12, 1, true), trs(0, (y0 + y1) / 2, 0), i % 2 ? b : a, true);
  }
  mb.add(new CylinderGeometry(2.4, 2.4, 0.5, 12), trs(0, h + 0.25, 0), col(t.props.lamp), true);
  mb.add(new CylinderGeometry(1.4, 1.4, 2.2, 10), trs(0, h + 1.6, 0), col(t.props.window), true);
  mb.add(new ConeGeometry(1.9, 2.2, 10), trs(0, h + 3.8, 0), b, true);
  mb.add(new CylinderGeometry(3.6, 4.2, 2.5, 12), trs(0, 0, 0), col(t.ground.rock), true);
  const g = new Group();
  const body = new Mesh(mb.build(), makeToon({ vertexColors: true, spec: 0.3, rim: 1 }));
  body.castShadow = true;
  g.add(body);
  const lamp = new Mesh(new SphereGeometry(0.9, 10, 8), makeToon({ color: t.props.lampLight, unlit: true, emissiveBoost: 3, mask: MASK.emissive }));
  lamp.position.y = h + 1.6;
  g.add(lamp);
  return g;
}

export function makeCrane(t: Theme) {
  const mb = new MeshBuilder();
  const y = col(t.props.rampA), dark = col(t.props.rampB), red = col(t.props.towerB);
  for (const [x, z] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) mb.add(new BoxGeometry(0.8, 14, 0.8), trs(x, 7, z), y, true);
  mb.add(new BoxGeometry(8, 1.5, 8), trs(0, 14.5, 0), y, true);
  mb.add(new BoxGeometry(1.6, 16, 1.6), trs(0, 23, 0), y, true);
  mb.add(new BoxGeometry(4, 3, 4), trs(0, 30, 0), red, true);
  mb.add(new BoxGeometry(1.2, 1.2, 34), trs(0, 32, -9), y, true);
  mb.add(new BoxGeometry(1.1, 1.1, 8), trs(0, 32, 10), dark, true);
  mb.add(new BoxGeometry(0.12, 18, 0.12), trs(0, 23, -22), dark, true);
  mb.add(new BoxGeometry(2.4, 2.4, 6), trs(0, 13, -22), col(t.props.building[0]), true);
  const m = new Mesh(mb.build(), makeToon({ vertexColors: true, spec: 0.2, rim: 1 }));
  m.castShadow = true;
  return m;
}

/** Start/finish arch spanning the track at s. */
export function makeGate(track: Track, t: Theme, s: number, span: number, floatBase = false) {
  const f = frame();
  track.frameAt(s, f);
  const g = new Group();
  const mb = new MeshBuilder();
  const a = col(t.props.towerA), b = col(t.props.towerB);
  const h = 9;
  const base = floatBase ? -2 : 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const y0 = base + ((h - base) * i) / 5, y1 = base + ((h - base) * (i + 1)) / 5;
      mb.add(new BoxGeometry(1.4, y1 - y0, 1.4), trs(side * span, (y0 + y1) / 2, 0), i % 2 ? b : a, true);
    }
    if (floatBase) mb.add(new CylinderGeometry(2.2, 2.4, 2.4, 10), trs(side * span, -0.3, 0), b, true);
  }
  mb.add(new BoxGeometry(span * 2 + 1.4, 1.2, 1.6), trs(0, h + 0.6, 0), b, true);
  const body = new Mesh(mb.build(), makeToon({ vertexColors: true, spec: 0.3, rim: 1 }));
  body.castShadow = true;
  g.add(body);
  const banner = new Mesh(
    new PlaneGeometry(span * 2 - 1, 2.2),
    makeToon({ side: DoubleSide, defines: { CHECKER: 1 }, pattern: { a: FX.checkerA, b: FX.checkerB, params: [Math.round(span * 1.2), 3, 0, 0] } }),
  );
  banner.position.set(0, h - 1.4, 0);
  g.add(banner);
  // countdown light bulbs
  const bulbs: Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const m = new Mesh(new SphereGeometry(0.45, 10, 8), makeToon({ color: FX.taillight, unlit: true, emissiveBoost: 0.4, mask: MASK.emissive }));
    m.position.set((i - 1) * 1.4, h + 1.8, -0.2);
    bulbs.push(m);
    g.add(m);
  }
  g.position.copy(f.pos);
  if (floatBase) g.position.y = 0;
  g.lookAt(_v.copy(f.pos).sub(f.tan));
  g.userData.bulbs = bulbs;
  return g;
}

export function placeOnTrack(obj: Object3D, track: Track, s: number, d: number, yOff = 0) {
  const f = frame();
  track.frameAt(s, f);
  track.pointAt(s, d, obj.position);
  obj.position.y += yOff;
  obj.lookAt(_v.copy(obj.position).sub(f.tan));
}
