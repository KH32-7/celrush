import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, PlaneGeometry, Quaternion,
  Scene, Vector3, type WebGLRenderer,
} from 'three';
import { clamp, lerp, smoothstep } from '../core/math';
import { fbm2, ridged2, Rng, valueNoise2 } from '../core/rng';
import { MeshBuilder, trs } from '../render/geom';
import { makeSky } from '../render/sky';
import { makeToon, MASK } from '../render/toon';
import { makeWater } from '../render/water';
import type { CourseDef } from '../track/courses';
import { newProj, Track } from '../track/track';
import { col, FX, theme, type Theme } from '../tuning/palette';
import { buildBoat } from '../vehicles/models';
import type { SimEnv } from '../vehicles/vehicle';
import { Ground } from '../world/ground';
import { WaveField, WAVESETS } from '../world/water';
import { frame, makeBackdrop, makeClouds, makeCrane, makeGate, makeLighthouse, makeRocks, makeTrees, setupLight } from './common';
import { disposeScene, type Pad, type World } from './world';

const _v = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _m = new Matrix4();
const _c = new Color();

const LAMP_SPACING = 36;

interface TerrainInfo {
  h: number;
  water: boolean;
  nearRoad: boolean;
  rel: number;
}

/** Everything that decides the shape of land around a car course, per theme. */
class CarLand {
  private proj = newProj();
  readonly seaX: number;
  /** canal runs under the course's highest point (the bridge), derived from data so rescaling keeps it there */
  readonly canalZ: number;
  readonly canalX1: number;
  constructor(readonly track: Track, readonly ground: Ground, readonly t: Theme, readonly seed: number) {
    this.seaX = t.id === 'mountain' ? -1e9 : track.minX - 55;
    const def = track.def;
    const crest = def.pts.reduce((a, b) => (b[1] > a[1] ? b : a));
    this.canalZ = crest[2] * def.scale;
    this.canalX1 = crest[0] * def.scale + 125;
  }

  /** ground level if the road were not there */
  natural(x: number, z: number): number {
    const t = this.t;
    if (t.id === 'mountain') return 0;
    if (x < this.seaX) return -5;
    if (t.id === 'city') {
      // canal from the harbor, passing under the bridge on the main straight
      if (Math.abs(z - this.canalZ) < 13 && x < this.canalX1) return -5;
    }
    return 0.15 + (valueNoise2(x * 0.02, z * 0.02, this.seed) - 0.5) * 0.3;
  }

  info(x: number, z: number): TerrainInfo {
    const p = this.track.project(x, z, -1, this.proj);
    const ad = Math.abs(p.d);
    const wallD = this.ground.wallD;
    const edgeH = this.ground.heightProfile(p.cy, p.bank, Math.sign(p.d || 1) * wallD);
    if (this.t.id === 'mountain') {
      const rise = smoothstep(wallD + 3, wallD + 230, ad);
      const hills = ridged2(x * 0.0032, z * 0.0032, 5, this.seed) * 175 + fbm2(x * 0.012, z * 0.012, 3, this.seed + 5) * 22;
      const h = ad < wallD + 0.5 ? this.ground.heightProfile(p.cy, p.bank, p.d) - 0.45 : edgeH - 0.45 + rise * hills;
      return { h, water: false, nearRoad: ad < wallD + 8, rel: h - edgeH };
    }
    const nat = this.natural(x, z);
    const water = nat < -1;
    if (water) return { h: nat, water, nearRoad: ad < wallD + 2, rel: nat - edgeH };
    if (ad < wallD + 0.5) return { h: this.ground.heightProfile(p.cy, p.bank, p.d) - 0.45, water: false, nearRoad: true, rel: 0 };
    const b = smoothstep(wallD + 0.5, wallD + 22, ad);
    const h = lerp(edgeH - 0.45, nat, b);
    return { h, water: false, nearRoad: ad < wallD + 8, rel: h - edgeH };
  }
}

function buildRoad(track: Track, ground: Ground, def: CourseDef, t: Theme) {
  const hw = track.hw, cw = def.curb, wd = ground.wallD;
  const ds: number[] = [];
  const pushSym = (vals: number[]) => {
    const neg = vals.map((v) => -v).reverse();
    ds.push(...neg, ...vals);
  };
  const inner = [0.001, hw * 0.33, hw * 0.66, hw];
  const outer = cw > 0 ? [hw + 0.18, hw + cw - 0.18, hw + cw, wd] : [wd];
  pushSym([...inner, ...outer]);
  const step = 2;
  const N = Math.ceil(track.length / step);
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const cols = ds.length;
  for (let i = 0; i <= N; i++) {
    const s = Math.min(i * step, track.length);
    const cy = track.interp(track.py, s), bank = track.interp(track.bank, s);
    for (const d of ds) {
      track.pointAt(s, d, _v);
      pos.push(_v.x, ground.heightProfile(cy, bank, d), _v.z);
      uv.push(d, s);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const lamp = t.night ? LAMP_SPACING : 0;
  const mat = makeToon({
    defines: { ROAD: 1 },
    pattern: {
      a: t.road.asphalt, b: t.road.asphalt2, c: t.road.line, d: t.road.lineYellow, e: t.road.curbA, f: t.road.runoff,
      params: [hw, cw, track.length, lamp],
    },
    rim: 0,
    spec: 0,
  });
  const mesh = new Mesh(g, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function buildWalls(track: Track, ground: Ground, land: CarLand, t: Theme) {
  const wd = ground.wallD;
  const mb = new MeshBuilder();
  const glow = new MeshBuilder();
  const step = 2;
  const N = Math.ceil(track.length / step);
  const cWall = col(t.road.wall), cStripe = col(t.road.wallStripe), cLine = col(t.road.line), cRail = col(t.road.rail), cDark = col(t.props.lamp);
  const kind = t.id === 'mountain' ? 'rail' : 'concrete';
  const H = 1.05;
  const p0 = new Vector3(), p1 = new Vector3();
  const cyAt = (s: number) => track.interp(track.py, s), bkAt = (s: number) => track.interp(track.bank, s);
  const pillarsMb = new MeshBuilder();
  for (const side of [-1, 1]) {
    for (let i = 0; i < N; i++) {
      const s0 = i * step, s1 = Math.min((i + 1) * step, track.length);
      const hIn0 = ground.heightProfile(cyAt(s0), bkAt(s0), side * wd), hIn1 = ground.heightProfile(cyAt(s1), bkAt(s1), side * wd);
      track.pointAt(s0, side * wd, p0);
      track.pointAt(s1, side * wd, p1);
      const q0 = track.pointAt(s0, side * (wd + 0.4), new Vector3()), q1 = track.pointAt(s1, side * (wd + 0.4), new Vector3());
      const a0 = new Vector3(p0.x, hIn0 - 1.3, p0.z), a1 = new Vector3(p1.x, hIn1 - 1.3, p1.z);
      const b0 = new Vector3(p0.x, hIn0 + (kind === 'rail' ? 0.45 : H), p0.z), b1 = new Vector3(p1.x, hIn1 + (kind === 'rail' ? 0.45 : H), p1.z);
      const c0 = new Vector3(q0.x, b0.y, q0.z), c1 = new Vector3(q1.x, b1.y, q1.z);
      const d0 = new Vector3(q0.x, hIn0 - 1.3, q0.z), d1 = new Vector3(q1.x, hIn1 - 1.3, q1.z);
      const stripeOn = Math.floor(i / 2) % 2 === 0;
      if (kind === 'concrete') {
        const band0 = new Vector3(p0.x, b0.y - 0.28, p0.z), band1 = new Vector3(p1.x, b1.y - 0.28, p1.z);
        // inner face (toward the road), two-tone
        const fIn = side < 0 ? [a0, a1, band1, band0] : [a1, a0, band0, band1];
        mb.quad(fIn[0], fIn[1], fIn[2], fIn[3], cWall);
        const fBand = side < 0 ? [band0, band1, b1, b0] : [band1, band0, b0, b1];
        if (t.night) glow.quad(fBand[0], fBand[1], fBand[2], fBand[3], cStripe);
        else mb.quad(fBand[0], fBand[1], fBand[2], fBand[3], stripeOn ? cStripe : cLine);
        const fTop = side < 0 ? [b0, b1, c1, c0] : [b1, b0, c0, c1];
        mb.quad(fTop[0], fTop[1], fTop[2], fTop[3], cWall);
        const fOut = side < 0 ? [c0, c1, d1, d0] : [c1, c0, d0, d1];
        mb.quad(fOut[0], fOut[1], fOut[2], fOut[3], cWall);
      } else {
        // steel guardrail: a rail band on posts, the rest see-through
        const r0 = new Vector3(p0.x, hIn0 + 0.42, p0.z), r1 = new Vector3(p1.x, hIn1 + 0.42, p1.z);
        const u0 = new Vector3(p0.x, hIn0 + 0.8, p0.z), u1 = new Vector3(p1.x, hIn1 + 0.8, p1.z);
        const f = side < 0 ? [r0, r1, u1, u0] : [r1, r0, u0, u1];
        mb.quad(f[0], f[1], f[2], f[3], cRail);
        const fb = side < 0 ? [u0, u1, r1, r0] : [u1, u0, r0, r1];
        mb.quad(fb[0], fb[1], fb[2], fb[3], cRail);
        if (i % 2 === 0) mb.add(new BoxGeometry(0.16, 1.4, 0.16), trs(p0.x, hIn0 + 0.1, p0.z), cDark, true);
        // road-edge fascia so elevated sections do not look paper thin
        const e0 = new Vector3(p0.x, hIn0 - 0.02, p0.z), e1 = new Vector3(p1.x, hIn1 - 0.02, p1.z);
        const fe = side < 0 ? [a0, a1, e1, e0] : [a1, a0, e0, e1];
        mb.quad(fe[0], fe[1], fe[2], fe[3], cWall);
      }
    }
  }
  // road underside + pillars where the road flies over low ground (bridge, overpass)
  const under = new MeshBuilder();
  for (let i = 0; i < N; i++) {
    const s0 = i * step, s1 = Math.min((i + 1) * step, track.length);
    const l0 = track.pointAt(s0, -wd - 0.4, new Vector3()), r0 = track.pointAt(s0, wd + 0.4, new Vector3());
    const l1 = track.pointAt(s1, -wd - 0.4, new Vector3()), r1 = track.pointAt(s1, wd + 0.4, new Vector3());
    const y0 = cyAt(s0) - 1.3, y1 = cyAt(s1) - 1.3;
    l0.y = r0.y = y0;
    l1.y = r1.y = y1;
    under.quad(l0, l1, r1, r0, cWall);
    if (i % 9 === 0) {
      const c = track.pointAt(s0, 0, new Vector3());
      const nat = land.natural(c.x, c.z);
      const top = cyAt(s0) - 1.3;
      if (top - nat > 1.8) {
        for (const d of [-track.hw * 0.55, track.hw * 0.55]) {
          const p = track.pointAt(s0, d, new Vector3());
          const hgt = top - nat + 1;
          pillarsMb.add(new BoxGeometry(1.6, hgt, 1.6), trs(p.x, nat - 1 + hgt / 2, p.z), cWall, true);
        }
        const f = frame();
        track.frameAt(s0, f);
        const yaw = Math.atan2(f.tan.x, f.tan.z);
        pillarsMb.add(new BoxGeometry(wd * 2, 0.9, 1.8), trs(c.x, top - 0.45, c.z, 0, yaw), cWall, true);
      }
    }
  }
  const g = new Group();
  const mat = makeToon({ vertexColors: true, rim: 0.5 });
  const walls = new Mesh(mb.build(), mat);
  walls.castShadow = true;
  walls.receiveShadow = true;
  g.add(walls);
  if (glow.pos.length) g.add(new Mesh(glow.build(), makeToon({ vertexColors: true, unlit: true, emissiveBoost: 2.2, mask: MASK.emissive })));
  g.add(new Mesh(under.build(), mat));
  if (pillarsMb.pos.length) {
    const pm = new Mesh(pillarsMb.build(), mat);
    pm.castShadow = true;
    g.add(pm);
  }
  return g;
}

function buildTerrain(track: Track, land: CarLand, t: Theme) {
  const margin = t.id === 'mountain' ? 900 : 700;
  const sp = 8;
  const x0 = Math.floor((track.minX - margin) / sp) * sp, x1 = Math.ceil((track.maxX + margin) / sp) * sp;
  const z0 = Math.floor((track.minZ - margin) / sp) * sp, z1 = Math.ceil((track.maxZ + margin) / sp) * sp;
  const nx = (x1 - x0) / sp + 1, nz = (z1 - z0) / sp + 1;
  const H = new Float32Array(nx * nz);
  const infos: TerrainInfo[] = new Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const inf = land.info(x0 + i * sp, z0 + j * sp);
      infos[j * nx + i] = inf;
      H[j * nx + i] = inf.h;
    }
  }
  const pos: number[] = [], nrm: number[] = [], colr: number[] = [], idx: number[] = [];
  let snowLine = -1e9;
  if (t.id === 'mountain') {
    let maxY = -1e9;
    for (let i = 0; i < track.n; i++) maxY = Math.max(maxY, track.py[i]);
    snowLine = maxY + 70;
  }
  const g1 = col(t.ground.grass), g2 = col(t.ground.grass2), rock = col(t.ground.rock), rock2 = col(t.ground.rock2), snow = col(t.ground.snow);
  const walk = col(t.ground.sidewalk), sand = col(t.ground.sand), dirt = col(t.ground.dirt);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = x0 + i * sp, z = z0 + j * sp, h = H[k];
      pos.push(x, h, z);
      const hl = H[j * nx + Math.max(0, i - 1)], hr = H[j * nx + Math.min(nx - 1, i + 1)];
      const hd = H[Math.max(0, j - 1) * nx + i], hu = H[Math.min(nz - 1, j + 1) * nx + i];
      _v.set(-(hr - hl) / (2 * sp), 1, -(hu - hd) / (2 * sp)).normalize();
      nrm.push(_v.x, _v.y, _v.z);
      const inf = infos[k];
      const patch = fbm2(x * 0.01, z * 0.01, 3, 7) > 0.5;
      let c: Color;
      if (inf.water) c = sand;
      else if (t.id === 'mountain') {
        if (h > snowLine + (fbm2(x * 0.02, z * 0.02, 2, 3) - 0.5) * 40) c = snow;
        else if (_v.y < 0.78 || inf.rel > 95) c = fbm2(x * 0.03, z * 0.03, 2, 9) > 0.5 ? rock : rock2;
        else if (inf.nearRoad) c = dirt;
        else c = patch ? g1 : g2;
      } else if (inf.nearRoad) c = walk;
      else if (x < land.seaX + 14) c = walk;
      else c = patch ? g1 : g2;
      colr.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new Float32BufferAttribute(colr, 3));
  g.setAttribute('uv', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(idx);
  const mesh = new Mesh(g, makeToon({ vertexColors: true, rim: 0.25, defines: { TERRAIN: 1 } }));
  mesh.receiveShadow = true;
  return mesh;
}

function buildPads(track: Track, def: CourseDef, t: Theme, ground: Ground): Pad[] {
  const pads: Pad[] = [];
  const len = 7, halfW = 1.8;
  const mat = makeToon({ defines: { PAD: 1 }, pattern: { a: FX.padBase, b: FX.padArrow }, unlit: true, emissiveBoost: 1, mask: MASK.emissive });
  for (const [sf, d] of def.pads) {
    const s = sf * track.length;
    const g = new PlaneGeometry(1, 1, 1, 6);
    const p = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      const ss = s - len / 2 + v * len, dd = d - halfW + u * halfW * 2;
      track.pointAt(ss, dd, _v);
      const y = ground.heightProfile(track.interp(track.py, ss), track.interp(track.bank, ss), dd) + 0.05;
      p.setXYZ(i, _v.x, y, _v.z);
    }
    g.computeVertexNormals();
    // PlaneGeometry faces +Z; after remapping onto the road some winding faces down: make it double-sided in effect
    const mesh = new Mesh(g, mat);
    mesh.material.side = 2;
    pads.push({ s, d, len, halfW, mesh });
  }
  void t;
  return pads;
}

export function buildCarWorld(def: CourseDef, _renderer: WebGLRenderer): World {
  const t = theme(def.theme);
  const track = new Track(def);
  const ground = new Ground(track);
  const rng = new Rng(def.seed);
  const scene = new Scene();
  const light = setupLight(scene, t);
  const sky = makeSky(t);
  scene.add(sky);
  const land = new CarLand(track, ground, t, def.seed);
  const wallD = ground.wallD;
  const center = new Vector3((track.minX + track.maxX) / 2, 0, (track.minZ + track.maxZ) / 2);

  scene.add(buildRoad(track, ground, def, t));
  scene.add(buildWalls(track, ground, land, t));
  scene.add(buildTerrain(track, land, t));

  // ---- sea / canal water (city, night)
  let field: WaveField | null = null;
  let water: ReturnType<typeof makeWater> | null = null;
  const moored: { obj: Group; x: number; z: number; ph: number }[] = [];
  if (t.id !== 'mountain') {
    field = new WaveField(WAVESETS.harbor);
    water = makeWater(t, field, { level: -0.9, fadeStart: 200, fadeEnd: 500 });
    scene.add(water.group);
    // quay + canal walls give the water a crisp edge
    const qb = new MeshBuilder();
    const cq = col(t.ground.sidewalk), cq2 = col(t.road.wall);
    const zA = track.minZ - 600, zB = track.maxZ + 600;
    qb.add(new BoxGeometry(3, 6, zB - zA), trs(land.seaX + 1.5, -2.8, (zA + zB) / 2), cq2, true);
    if (t.id === 'city') {
      const cx0 = land.seaX, cx1 = land.canalX1, cz = land.canalZ;
      for (const zz of [cz - 13, cz + 13]) qb.add(new BoxGeometry(cx1 - cx0, 6, 2), trs((cx0 + cx1) / 2, -2.8, zz), cq2, true);
      qb.add(new BoxGeometry(2, 6, 26), trs(cx1, -2.8, cz), cq2, true);
    }
    const quay = new Mesh(qb.build(), makeToon({ vertexColors: true, rim: 0.3 }));
    quay.receiveShadow = true;
    scene.add(quay);
    void cq;
    // harbor furniture
    const cranes = t.id === 'city' ? [-160, 10, 190, 330] : [-80, 260];
    for (const z of cranes) {
      const cr = makeCrane(t);
      cr.position.set(land.seaX + 8, 0, z);
      cr.rotation.y = -Math.PI / 2;
      scene.add(cr);
    }
    const lh = makeLighthouse(t, 24);
    lh.position.set(land.seaX - 190, 0, track.maxZ + 60);
    scene.add(lh);
    const rocksAt: { x: number; y: number; z: number; s: number; r: number }[] = [];
    for (let i = 0; i < 6; i++) rocksAt.push({ x: lh.position.x + rng.range(-8, 8), y: -1, z: lh.position.z + rng.range(-8, 8), s: rng.range(3, 6), r: rng.range(0, 6) });
    scene.add(makeRocks(t, rocksAt, 5));
    for (let i = 0; i < 4; i++) {
      const b = buildBoat(i).root;
      const x = land.seaX - 8 - (i % 2) * 5, z = track.minZ + 40 + i * 70;
      b.position.set(x, -0.7, z);
      b.rotation.y = Math.PI / 2 + rng.range(-0.1, 0.1);
      scene.add(b);
      moored.push({ obj: b, x, z, ph: rng.range(0, 6) });
    }
  }

  // ---- buildings, trees, lamps (city / night)
  const occupied = new Set<number>();
  const occKey = (x: number, z: number) => Math.floor(x / 10) * 100000 + Math.floor(z / 10);
  const claim = (x: number, z: number, r: number) => {
    for (let dx = -r; dx <= r; dx += 10) for (let dz = -r; dz <= r; dz += 10) if (occupied.has(occKey(x + dx, z + dz))) return false;
    for (let dx = -r; dx <= r; dx += 10) for (let dz = -r; dz <= r; dz += 10) occupied.add(occKey(x + dx, z + dz));
    return true;
  };
  const pj = newProj();
  const clearOfRoad = (x: number, z: number, margin: number) => Math.abs(track.project(x, z, -1, pj).d) > wallD + margin;
  const f = frame();
  const treePts: { x: number; y: number; z: number; s: number; r: number }[] = [];

  if (t.id === 'city' || t.id === 'night') {
    const B: { x: number; z: number; w: number; d: number; h: number; yaw: number; c: number }[] = [];
    for (let s = 0; s < track.length; s += 12) {
      track.frameAt(s, f);
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      for (const side of [-1, 1]) {
        for (let row = 0; row < 3; row++) {
          if (rng.next() < 0.25) continue;
          const d = side * (wallD + 9 + row * 26 + rng.range(0, 6));
          track.pointAt(s + rng.range(-3, 3), d, _v);
          const w = rng.range(10, 20), dd = rng.range(10, 20);
          if (land.natural(_v.x, _v.z) < -1 || land.natural(_v.x + w / 2, _v.z) < -1 || land.natural(_v.x - w / 2, _v.z) < -1) continue;
          if (!clearOfRoad(_v.x, _v.z, 6 + Math.max(w, dd) / 2)) continue;
          if (!claim(_v.x, _v.z, Math.max(w, dd) / 2)) continue;
          let h = rng.range(9, 20) + row * rng.range(6, 16);
          if (rng.next() < 0.08) h += rng.range(20, 45);
          B.push({ x: _v.x, z: _v.z, w, d: dd, h, yaw, c: rng.int(0, 99) });
        }
      }
      // sidewalk trees
      if (Math.floor(s / 12) % 2 === 0) {
        for (const side of [-1, 1]) {
          track.pointAt(s, side * (wallD + 3.4), _v);
          if (land.natural(_v.x, _v.z) < -1 || !clearOfRoad(_v.x, _v.z, 2.5)) continue;
          if (occupied.has(occKey(_v.x, _v.z))) continue;
          treePts.push({ x: _v.x, y: land.info(_v.x, _v.z).h, z: _v.z, s: rng.range(0.75, 1.0), r: rng.range(0, 6) });
        }
      }
    }
    const bgeo = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const bmat = makeToon({
      defines: { BUILDING: 1 },
      pattern: { a: t.props.window, b: t.props.windowLit, params: [3.4, 3.0, 0, 0] },
      spec: 0.05, rim: 0.6,
    });
    const bm = new InstancedMesh(bgeo, bmat, B.length);
    const roofs = new InstancedMesh(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0), makeToon({ color: t.props.roof, rim: 0.4 }), B.length * 2);
    let rc = 0;
    B.forEach((b, i) => {
      _q.setFromAxisAngle(_v.set(0, 1, 0), b.yaw);
      _m.compose(_v.set(b.x, -0.5, b.z), _q, _s.set(b.w, b.h + 0.5, b.d));
      bm.setMatrixAt(i, _m);
      bm.setColorAt(i, _c.copy(col(t.props.building[b.c % t.props.building.length])));
      for (let k = 0; k < 2; k++) {
        const ox = rng.range(-b.w * 0.3, b.w * 0.3), oz = rng.range(-b.d * 0.3, b.d * 0.3);
        _v.set(ox, 0, oz).applyQuaternion(_q);
        _m.compose(_v.set(b.x + _v.x, b.h, b.z + _v.z), _q, _s.set(rng.range(2, 5), rng.range(1, 2.5), rng.range(2, 5)));
        roofs.setMatrixAt(rc++, _m);
      }
    });
    roofs.count = rc;
    bm.castShadow = true;
    bm.receiveShadow = true;
    roofs.castShadow = true;
    bm.frustumCulled = roofs.frustumCulled = false;
    scene.add(bm, roofs);

    // park trees in the gaps
    for (let i = 0; i < 260; i++) {
      const x = rng.range(track.minX - 250, track.maxX + 250), z = rng.range(track.minZ - 250, track.maxZ + 250);
      if (land.natural(x, z) < -1 || !clearOfRoad(x, z, 5) || occupied.has(occKey(x, z))) continue;
      treePts.push({ x, y: land.info(x, z).h, z, s: rng.range(0.8, 1.2), r: rng.range(0, 6) });
    }
    scene.add(makeTrees('round', t, treePts, rng));

    // street lamps: positions match the ROAD shader's light pools
    const poles = new MeshBuilder();
    const heads = new MeshBuilder();
    const cl = col(t.props.lamp), ch = col(t.props.lampLight);
    for (let k = 0; k * LAMP_SPACING < track.length; k++) {
      const s = k * LAMP_SPACING + LAMP_SPACING / 2;
      const side = (k % 2) * 2 - 1;
      track.frameAt(s, f);
      track.pointAt(s, side * (wallD + 1.2), _v);
      const base = land.info(_v.x, _v.z).h;
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      poles.add(new CylinderGeometry(0.12, 0.16, 8, 6), trs(_v.x, base + 4, _v.z), cl, true);
      const arm = new Vector3(-side * 1.6, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), yaw);
      poles.add(new BoxGeometry(0.12, 0.12, 3.2), trs(_v.x + arm.x, base + 8, _v.z + arm.z, 0, yaw + Math.PI / 2), cl, true);
      heads.add(new BoxGeometry(0.9, 0.2, 0.5), trs(_v.x + arm.x * 1.9, base + 7.85, _v.z + arm.z * 1.9, 0, yaw), ch, true);
    }
    const pm = new Mesh(poles.build(), makeToon({ vertexColors: true, rim: 0.4 }));
    pm.castShadow = true;
    scene.add(pm);
    scene.add(new Mesh(heads.build(), makeToon({ vertexColors: true, unlit: true, emissiveBoost: t.night ? 2.4 : 1.1, mask: MASK.emissive })));

    // night: neon billboards facing the road
    if (t.night) {
      const nb = new MeshBuilder();
      const frameMb = new MeshBuilder();
      for (let s = 60; s < track.length; s += 150) {
        const side = rng.sign();
        track.frameAt(s, f);
        track.pointAt(s, side * (wallD + 14), _v);
        if (land.natural(_v.x, _v.z) < -1 || !clearOfRoad(_v.x, _v.z, 10)) continue;
        const yaw = Math.atan2(f.tan.x, f.tan.z) + (side > 0 ? -1 : 1) * 0.9;
        const base = land.info(_v.x, _v.z).h;
        frameMb.add(new BoxGeometry(0.5, 12, 0.5), trs(_v.x, base + 6, _v.z), col(t.props.lamp), true);
        frameMb.add(new BoxGeometry(12.6, 6.6, 0.4), trs(_v.x, base + 15, _v.z, 0, yaw), col(t.props.roof), true);
        const nc = col(rng.pick(t.props.neon));
        const n2 = col(rng.pick(t.props.neon));
        nb.add(new BoxGeometry(11.6, 1.0, 0.5), trs(_v.x, base + 17.2, _v.z, 0, yaw), nc, true);
        nb.add(new BoxGeometry(11.6, 0.4, 0.5), trs(_v.x, base + 12.4, _v.z, 0, yaw), nc, true);
        nb.add(new BoxGeometry(3.4, 3.4, 0.5), trs(_v.x, base + 14.8, _v.z, 0, yaw), n2, true);
      }
      const fm = new Mesh(frameMb.build(), makeToon({ vertexColors: true, rim: 0.6 }));
      fm.castShadow = true;
      scene.add(fm);
      scene.add(new Mesh(nb.build(), makeToon({ vertexColors: true, unlit: true, emissiveBoost: 2.0, mask: MASK.emissive })));
    }
  }

  // ---- mountain: pine forest, rocks, snow backdrop
  if (t.id === 'mountain') {
    const snowLine = Math.max(...Array.from(track.py)) + 60;
    for (let i = 0; i < 2600 && treePts.length < 1700; i++) {
      const a = rng.range(0, Math.PI * 2);
      const s = rng.range(0, track.length);
      track.pointAt(s, rng.sign() * (wallD + 5 + Math.pow(rng.next(), 1.4) * 420), _v);
      _v.x += Math.cos(a) * 6;
      _v.z += Math.sin(a) * 6;
      if (!clearOfRoad(_v.x, _v.z, 4)) continue;
      const inf = land.info(_v.x, _v.z);
      if (inf.h > snowLine) continue;
      const hx = land.info(_v.x + 3, _v.z).h, hz = land.info(_v.x, _v.z + 3).h;
      if (Math.hypot(hx - inf.h, hz - inf.h) / 3 > 0.75) continue;
      treePts.push({ x: _v.x, y: inf.h - 0.3, z: _v.z, s: rng.range(0.8, 1.5), r: rng.range(0, 6) });
    }
    scene.add(makeTrees('pine', t, treePts, rng));
    const rocks: { x: number; y: number; z: number; s: number; r: number }[] = [];
    for (let i = 0; i < 400 && rocks.length < 170; i++) {
      const s = rng.range(0, track.length);
      track.pointAt(s, rng.sign() * (wallD + 3 + rng.range(0, 160)), _v);
      if (!clearOfRoad(_v.x, _v.z, 2)) continue;
      rocks.push({ x: _v.x, y: land.info(_v.x, _v.z).h, z: _v.z, s: rng.range(1.2, 4.5), r: rng.range(0, 6) });
    }
    scene.add(makeRocks(t, rocks, 11));
    // chalets
    const ch = new MeshBuilder();
    for (let i = 0; i < 6; i++) {
      const s = rng.range(0, track.length);
      const side = rng.sign();
      track.frameAt(s, f);
      track.pointAt(s, side * (wallD + 22), _v);
      if (!clearOfRoad(_v.x, _v.z, 14)) continue;
      const base = land.info(_v.x, _v.z).h;
      const yaw = Math.atan2(f.tan.x, f.tan.z);
      ch.add(new BoxGeometry(9, 5, 7), trs(_v.x, base + 2.3, _v.z, 0, yaw), col(t.props.building[i % t.props.building.length]), true);
      const roof = new CylinderGeometry(0.01, 6.6, 3.4, 4, 1);
      roof.rotateY(Math.PI / 4);
      ch.add(roof, trs(_v.x, base + 6.5, _v.z, 0, yaw, 0, 1.05, 1, 0.8), col(t.props.roof), true);
    }
    const chm = new Mesh(ch.build(), makeToon({ vertexColors: true, rim: 0.6 }));
    chm.castShadow = true;
    scene.add(chm);
  }

  scene.add(makeBackdrop(t, rng, center, { snow: t.id === 'mountain', heightMul: t.id === 'mountain' ? 1.35 : 0.55, radius: 2400 }));
  scene.add(makeClouds(t, rng, center, t.id === 'night' ? 18 : 34, 500, 1700, t.id === 'mountain' ? 220 : 180, 420));

  const gate = makeGate(track, t, 0, wallD + 0.6);
  scene.add(gate);
  const pads = buildPads(track, def, t, ground);
  for (const p of pads) scene.add(p.mesh);

  const env: SimEnv = { track, ground, water: null, time: 0, spheres: [], ramps: [], current: 0 };

  return {
    def, theme: t, track, env, scene, sky, water, field, wake: null, pads, gate,
    update(_dt, time, focus, cam) {
      light.follow(focus);
      sky.position.copy(cam);
      if (water && field) {
        field.time = time;
        water.update(cam, time);
        for (const b of moored) {
          b.obj.position.y = -0.95 + field.heightAt(b.x, b.z) * 0.8;
          b.obj.rotation.z = Math.sin(time * 0.9 + b.ph) * 0.03;
        }
      }
    },
    dispose() {
      disposeScene(scene);
    },
  };
}

void clamp;
