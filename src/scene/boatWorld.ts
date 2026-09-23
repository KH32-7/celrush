import {
  BoxGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, InstancedMesh, Matrix4, Mesh, PlaneGeometry, Quaternion, Scene,
  TorusGeometry, Vector3, type WebGLRenderer,
} from 'three';
import { smoothstep } from '../core/math';
import { fbm2, Rng, valueNoise2 } from '../core/rng';
import { WakeMap } from '../fx/wake';
import { MeshBuilder, trs } from '../render/geom';
import { makeSky } from '../render/sky';
import { makeToon, MASK } from '../render/toon';
import { makeWater } from '../render/water';
import type { CourseDef } from '../track/courses';
import { newProj, Track } from '../track/track';
import { col, FX, theme, type Theme } from '../tuning/palette';
import type { RampShape, SimEnv, SphereObstacle } from '../vehicles/vehicle';
import { newWaterSample, WaveField, WAVESETS } from '../world/water';
import { frame, makeBackdrop, makeClouds, makeGate, makeLighthouse, makeRocks, makeTrees, rockGeometry, setupLight } from './common';
import { disposeScene, type Pad, type World } from './world';

const _v = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _m = new Matrix4();
const _n = new Vector3();
const _up = new Vector3(0, 1, 0);
const _ws = newWaterSample();

interface Buoy {
  base: Vector3;
  off: Vector3;
  vel: Vector3;
  sphere: SphereObstacle;
  mesh: InstancedMesh;
  idx: number;
}

function buoyGeometry(a: Color, b: Color) {
  const mb = new MeshBuilder();
  mb.add(new CylinderGeometry(0.55, 0.62, 1.1, 10), trs(0, 0.2, 0), a, true);
  mb.add(new CylinderGeometry(0.64, 0.64, 0.22, 10), trs(0, 0.55, 0), b, true);
  mb.add(new ConeGeometry(0.5, 0.9, 10), trs(0, 1.2, 0), a, true);
  mb.add(new CylinderGeometry(0.05, 0.05, 0.8, 5), trs(0, 1.9, 0), b, true);
  return mb.build();
}

function islandMesh(t: Theme, rng: Rng, R: number, H: number, seed: number) {
  const mb = new MeshBuilder();
  const rings = 9, segs = 22;
  const sand = col(t.ground.sand), grass = col(t.ground.grass), grass2 = col(t.ground.grass2), rock = col(t.ground.rock), rock2 = col(t.ground.rock2);
  const pts: Vector3[][] = [];
  for (let r = 0; r <= rings; r++) {
    const row: Vector3[] = [];
    const rr = r / rings;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const nr = 1 + (valueNoise2(Math.cos(a) * 2 + seed, Math.sin(a) * 2, seed) - 0.5) * 0.5;
      const rad = R * (rr * 1.25) * nr;
      let y = rr <= 0.8 ? H * Math.pow(1 - (rr / 0.8) ** 2, 0.6) : -6 * ((rr - 0.8) / 0.45);
      y += (fbm2(Math.cos(a) * rad * 0.05 + seed, Math.sin(a) * rad * 0.05, 2, seed) - 0.5) * H * 0.25 * (1 - rr);
      if (rr > 0.6 && rr <= 0.8) y = Math.min(y, 1.2 + (0.8 - rr) * 8);
      row.push(new Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad));
    }
    pts.push(row);
  }
  const top = new Vector3(0, H * 1.02, 0);
  for (let s = 0; s < segs; s++) {
    const s2 = (s + 1) % segs;
    mb.tri(top, pts[0][s2], pts[0][s], grass);
    for (let r = 0; r < rings; r++) {
      const a = pts[r][s], b = pts[r][s2], c = pts[r + 1][s2], d = pts[r + 1][s];
      const cy = (a.y + b.y + c.y + d.y) / 4;
      const steep = Math.abs(a.y - d.y) / Math.max(0.5, a.distanceTo(d));
      let cc = cy < 1.6 ? sand : steep > 0.9 ? (rng.next() < 0.5 ? rock : rock2) : rng.next() < 0.5 ? grass : grass2;
      if (cy < -1) cc = sand;
      mb.quad(a, b, c, d, cc);
    }
  }
  const mesh = new Mesh(mb.build(), makeToon({ vertexColors: true, rim: 0.5 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildBoatWorld(def: CourseDef, renderer: WebGLRenderer): World {
  const t = theme(def.theme);
  const track = new Track(def);
  const rng = new Rng(def.seed);
  const scene = new Scene();
  const light = setupLight(scene, t);
  const sky = makeSky(t);
  scene.add(sky);
  const field = new WaveField(WAVESETS[def.waves ?? 'bay']);
  const storm = t.id === 'storm';
  const water = makeWater(t, field, { fadeStart: storm ? 360 : 260, fadeEnd: storm ? 1000 : 720 });
  scene.add(water.group);
  const wake = new WakeMap(renderer);
  const wallD = track.hw + def.runoff;
  const center = new Vector3((track.minX + track.maxX) / 2, 0, (track.minZ + track.maxZ) / 2);
  const f = frame();
  const pj = newProj();
  const distToCourse = (x: number, z: number) => Math.abs(track.project(x, z, -1, pj).d);

  const env: SimEnv = { track, ground: null, water: field, time: 0, spheres: [], ramps: [], current: def.current ?? 0 };

  // ---- course buoys, alternating colors, bobbing and knockable
  const buoys: Buoy[] = [];
  const bA = col(t.props.buoyA), bB = col(t.props.buoyB);
  const spacing = 17;
  const nB = Math.floor(track.length / spacing);
  const meshA = new InstancedMesh(buoyGeometry(bA, bB), makeToon({ vertexColors: true, spec: 0.4, rim: 1 }), nB);
  const meshB = new InstancedMesh(buoyGeometry(bB, bA), makeToon({ vertexColors: true, spec: 0.4, rim: 1 }), nB);
  meshA.castShadow = meshB.castShadow = true;
  meshA.frustumCulled = meshB.frustumCulled = false;
  let ca = 0, cb = 0;
  for (let k = 0; k < nB; k++) {
    const s = k * spacing;
    for (const side of [-1, 1]) {
      const pos = track.pointAt(s, side * (track.hw + 1.2), new Vector3());
      const useA = (k + (side > 0 ? 1 : 0)) % 2 === 0;
      const mesh = useA ? meshA : meshB;
      const idx = useA ? ca++ : cb++;
      if (idx >= nB) continue;
      const sphere: SphereObstacle = { pos: pos.clone(), r: 0.75, kick: new Vector3() };
      env.spheres.push(sphere);
      buoys.push({ base: pos, off: new Vector3(), vel: new Vector3(), sphere, mesh, idx });
    }
  }
  meshA.count = ca;
  meshB.count = cb;
  scene.add(meshA, meshB);

  // ---- ramps: striped floating wedges
  const rampMb = new MeshBuilder();
  const rA = col(t.props.rampA), rB = col(t.props.rampB);
  for (const [sf, d] of def.ramps ?? []) {
    const s = sf * track.length;
    track.frameAt(s, f);
    const dir = new Vector3(f.tan.x, 0, f.tan.z).normalize();
    const right = new Vector3().crossVectors(dir, _up).normalize();
    const pos = track.pointAt(s, d, new Vector3());
    const R: RampShape = { pos: new Vector3(pos.x, -0.35, pos.z), dir, right, len: 13, width: 7, height: 2.7 };
    env.ramps.push(R);
    const P = (lz: number, lx: number, ly: number) =>
      new Vector3(R.pos.x + dir.x * lz + right.x * lx, R.pos.y + ly, R.pos.z + dir.z * lz + right.z * lx);
    const hw = R.width / 2;
    const strips = 8;
    for (let i = 0; i < strips; i++) {
      const z0 = (i / strips) * R.len, z1 = ((i + 1) / strips) * R.len;
      const y0 = (z0 / R.len) * R.height, y1 = (z1 / R.len) * R.height;
      rampMb.quad(P(z0, hw, y0), P(z0, -hw, y0), P(z1, -hw, y1), P(z1, hw, y1), i % 2 ? rA : rB);
    }
    // sides + back + float pontoons
    for (const sx of [-1, 1]) rampMb.quad(P(0, sx * hw, -1.2), P(R.len, sx * hw, -1.2), P(R.len, sx * hw, R.height), P(0, sx * hw, 0), rB);
    rampMb.quad(P(R.len, hw, -1.2), P(R.len, -hw, -1.2), P(R.len, -hw, R.height), P(R.len, hw, R.height), rA);
    for (const sx of [-1, 1]) rampMb.add(new CylinderGeometry(0.9, 0.9, R.len + 1, 10), trs(0, 0, 0), rA, true), void sx;
  }
  if (rampMb.pos.length) {
    const rm = new Mesh(rampMb.build(), makeToon({ vertexColors: true, spec: 0.3, rim: 1, side: DoubleSide }));
    rm.castShadow = true;
    scene.add(rm);
  }

  // ---- floating boost pads
  const pads: Pad[] = [];
  const padMat = makeToon({ defines: { PAD: 1 }, pattern: { a: FX.padBase, b: FX.padArrow }, unlit: true, mask: MASK.emissive, side: DoubleSide });
  const padObjs: { mesh: Mesh; x: number; z: number; yaw: number }[] = [];
  for (const [sf, d] of def.pads) {
    const s = sf * track.length;
    track.frameAt(s, f);
    const mesh = new Mesh(new PlaneGeometry(4.2, 9).rotateX(-Math.PI / 2), padMat);
    track.pointAt(s, d, mesh.position);
    const yaw = Math.atan2(-f.tan.x, -f.tan.z);
    padObjs.push({ mesh, x: mesh.position.x, z: mesh.position.z, yaw });
    pads.push({ s, d, len: 9, halfW: 2.3, mesh });
    scene.add(mesh);
  }

  const gate = makeGate(track, t, 0, track.hw + 2, true);
  scene.add(gate);

  // ---- theme scenery
  let beam: Mesh | null = null;
  const riverRocks: Vector3[] = [];
  if (t.id === 'bay' || t.id === 'storm') {
    const islands: { x: number; z: number; R: number; H: number }[] = [];
    const want = storm ? 12 : 16;
    for (let i = 0; i < 300 && islands.length < want; i++) {
      const R = storm ? rng.range(12, 34) : rng.range(18, 60);
      const s = rng.range(0, track.length);
      track.pointAt(s, rng.sign() * (wallD + R + rng.range(15, 260)), _v);
      if (distToCourse(_v.x, _v.z) < wallD + R * 1.3 + 8) continue;
      if (islands.some((o) => Math.hypot(o.x - _v.x, o.z - _v.z) < o.R + R + 20)) continue;
      islands.push({ x: _v.x, z: _v.z, R, H: storm ? rng.range(8, 30) : rng.range(6, 24) });
    }
    const palms: { x: number; y: number; z: number; s: number; r: number }[] = [];
    const rocks: { x: number; y: number; z: number; s: number; r: number; sy?: number }[] = [];
    islands.forEach((isl, i) => {
      if (storm) {
        rocks.push({ x: isl.x, y: -2, z: isl.z, s: isl.R, r: rng.range(0, 6), sy: isl.H / isl.R });
        for (let k = 0; k < 4; k++) rocks.push({ x: isl.x + rng.range(-isl.R, isl.R), y: -1, z: isl.z + rng.range(-isl.R, isl.R), s: rng.range(2, 6), r: rng.range(0, 6) });
        return;
      }
      const m = islandMesh(t, rng, isl.R, isl.H, i * 13 + 1);
      m.position.set(isl.x, 0, isl.z);
      scene.add(m);
      const n = Math.floor(isl.R / 8);
      for (let k = 0; k < n; k++) {
        const a = rng.range(0, Math.PI * 2), r = isl.R * rng.range(0.35, 0.75);
        const rr = r / isl.R;
        const y = rr <= 0.8 ? isl.H * Math.pow(1 - (rr / 0.8) ** 2, 0.6) * 0.85 : 0.5;
        palms.push({ x: isl.x + Math.cos(a) * r, y: Math.max(0.6, y - 0.5), z: isl.z + Math.sin(a) * r, s: rng.range(0.9, 1.3), r: rng.range(0, 6) });
      }
      for (let k = 0; k < 5; k++) {
        const a = rng.range(0, Math.PI * 2);
        rocks.push({ x: isl.x + Math.cos(a) * isl.R * 1.0, y: -0.5, z: isl.z + Math.sin(a) * isl.R * 1.0, s: rng.range(1.5, 4), r: rng.range(0, 6) });
      }
    });
    if (palms.length) scene.add(makeTrees('palm', t, palms, rng));
    if (rocks.length) scene.add(makeRocks(t, rocks, storm ? 29 : 17));
    // lighthouse on the island closest to the start
    track.pointAt(track.length * 0.04, -(wallD + 45), _v);
    const lh = makeLighthouse(t, storm ? 34 : 26);
    lh.position.set(_v.x, 1, _v.z);
    scene.add(lh);
    scene.add(makeRocks(t, [{ x: _v.x, y: -1, z: _v.z, s: 9, r: 0, sy: 0.35 }], 41));
    if (storm) {
      beam = new Mesh(
        new ConeGeometry(9, 140, 16, 1, true).translate(0, -70, 0).rotateX(-Math.PI / 2),
        makeToon({ color: t.props.lampLight, unlit: true, emissiveBoost: 1.4, mask: MASK.emissive, ghost: 0.28, side: DoubleSide }),
      );
      beam.position.set(_v.x, 1 + 34 + 1.6, _v.z);
      scene.add(beam);
    }
  }

  if (t.id === 'canyon') {
    // layered rock walls: vertical faces with ledges, strata banded by height
    const mb = new MeshBuilder();
    const strata = [col(t.ground.rock), col(t.ground.rock3), col(t.ground.rock2), col(t.ground.rock3)];
    const topC = col(t.ground.sand), topG = col(t.ground.grass2);
    const step = 5;
    const N = Math.ceil(track.length / step);
    const rows = [-5, 0, 7, 14, 22, 31, 41];
    const seed = def.seed;
    for (const side of [-1, 1]) {
      const cols: Vector3[][] = [];
      for (let i = 0; i <= N; i++) {
        const s = Math.min(i * step, track.length);
        const top = 38 + fbm2(s * 0.004, side * 3, 3, seed) * 44;
        const col_: Vector3[] = [];
        for (let r = 0; r < rows.length; r++) {
          const y = Math.min(rows[r], top);
          const out = side * (wallD + 0.6 + Math.max(0, valueNoise2(s * 0.05, y * 0.12 + side * 7, seed) - 0.3) * 6 + (y / 40) * 3);
          const p = track.pointAt(s, out, new Vector3());
          p.y = y;
          col_.push(p);
        }
        const rim = track.pointAt(s, side * (wallD + 12), new Vector3());
        rim.y = top;
        col_.push(rim);
        const far = track.pointAt(s, side * (wallD + 160), new Vector3());
        far.y = top + fbm2(s * 0.01, 9 + side, 2, seed) * 10;
        col_.push(far);
        cols.push(col_);
      }
      for (let i = 0; i < N; i++) {
        const A = cols[i], B = cols[i + 1];
        for (let r = 0; r < A.length - 1; r++) {
          const yMid = (A[r].y + A[r + 1].y) / 2;
          let c = strata[Math.floor((yMid + valueNoise2(i * 0.2, r, seed) * 3) / 6) & 3];
          if (r >= A.length - 2) c = valueNoise2(i * 0.1, side, seed) > 0.55 ? topG : topC;
          else if (r === A.length - 3) c = strata[1];
          if (side < 0) mb.quad(A[r], B[r], B[r + 1], A[r + 1], c);
          else mb.quad(B[r], A[r], A[r + 1], B[r + 1], c);
        }
      }
    }
    const walls = new Mesh(mb.build(), makeToon({ vertexColors: true, spec: 0.08, rim: 0.5 }));
    walls.castShadow = true;
    walls.receiveShadow = true;
    scene.add(walls);
    // natural stone arch across the river
    const sArch = track.length * 0.42;
    track.frameAt(sArch, f);
    const archR = wallD + 7;
    const ag = new TorusGeometry(archR, 5.5, 7, 18, Math.PI);
    const archMb = new MeshBuilder();
    archMb.add(ag, trs(0, 0, 0), col(t.ground.rock), true);
    const arch = new Mesh(archMb.build(), makeToon({ vertexColors: true, rim: 0.6 }));
    arch.position.set(f.pos.x, 8, f.pos.z);
    arch.rotation.y = Math.atan2(f.tan.x, f.tan.z) + Math.PI / 2;
    arch.castShadow = true;
    scene.add(arch);
    // river rocks: obstacles with permanent foam
    const rocks: { x: number; y: number; z: number; s: number; r: number }[] = [];
    for (let i = 0; i < (def.rocks ?? 0); i++) {
      const s = track.length * (0.08 + (i / (def.rocks ?? 1)) * 0.86) + rng.range(-20, 20);
      const d = rng.sign() * track.hw * rng.range(0.35, 0.75);
      track.pointAt(s, d, _v);
      const r = rng.range(1.8, 3.0);
      rocks.push({ x: _v.x, y: -0.6, z: _v.z, s: r, r: rng.range(0, 6) });
      env.spheres.push({ pos: new Vector3(_v.x, 0, _v.z), r: r * 0.95, kick: new Vector3() });
      riverRocks.push(new Vector3(_v.x, 0, _v.z));
    }
    scene.add(makeRocks(t, rocks, 71));
    // scrub on the rim
    const scrub: { x: number; y: number; z: number; s: number; r: number }[] = [];
    for (let i = 0; i < 160; i++) {
      const s = rng.range(0, track.length);
      const side = rng.sign();
      track.pointAt(s, side * (wallD + 16 + rng.range(0, 90)), _v);
      if (distToCourse(_v.x, _v.z) < wallD + 14) continue;
      scrub.push({ x: _v.x, y: 38 + fbm2(s * 0.004, side * 3, 3, seed) * 44 - 0.5, z: _v.z, s: rng.range(0.6, 1.0), r: rng.range(0, 6) });
    }
    scene.add(makeTrees('round', t, scrub, rng));
    void rockGeometry;
  }

  scene.add(makeBackdrop(t, rng, center, { heightMul: t.id === 'canyon' ? 0.8 : storm ? 0.45 : 0.6, radius: 2500 }));
  scene.add(makeClouds(t, rng, center, storm ? 70 : 34, storm ? 250 : 500, storm ? 1300 : 1700, storm ? 90 : 180, storm ? 170 : 420));

  const wakeCenter = new Vector3();
  return {
    def, theme: t, track, env, scene, sky, water, field, wake, pads, gate,
    update(dt, time, focus, cam) {
      light.follow(focus);
      sky.position.copy(cam);
      water.update(cam, time);
      if (dt > 0) {
        for (const r of riverRocks) {
          if (Math.abs(r.x - focus.x) < 100 && Math.abs(r.z - focus.z) < 100) wake.stamp(r.x, r.z, 4.5, 0.5 * dt * 60);
        }
        wakeCenter.copy(focus);
        wake.update(wakeCenter, dt);
      }
      water.setWake(wake.texture, wake.center, wake.size);
      // buoys bob on the swell and spring back after a hit
      for (const b of buoys) {
        b.vel.addScaledVector(b.sphere.kick, 6);
        b.sphere.kick.set(0, 0, 0);
        b.vel.addScaledVector(b.off, -9 * dt);
        b.vel.multiplyScalar(Math.exp(-2.2 * dt));
        b.off.addScaledVector(b.vel, dt);
        b.off.y = 0;
        const x = b.base.x + b.off.x, z = b.base.z + b.off.z;
        field.sample(x, z, _ws, time);
        b.sphere.pos.set(x, _ws.h, z);
        _n.set(_ws.nx, _ws.ny, _ws.nz);
        _q.setFromUnitVectors(_up, _n);
        const tilt = Math.min(0.5, b.vel.length() * 0.2);
        if (tilt > 0.01) _q.multiply(new Quaternion().setFromAxisAngle(_v.set(b.vel.z, 0, -b.vel.x).normalize(), tilt));
        _m.compose(_v.set(x, _ws.h - 0.35, z), _q, _s.set(1, 1, 1));
        b.mesh.setMatrixAt(b.idx, _m);
      }
      meshA.instanceMatrix.needsUpdate = true;
      meshB.instanceMatrix.needsUpdate = true;
      for (const p of padObjs) {
        field.sample(p.x, p.z, _ws, time);
        p.mesh.position.y = _ws.h + 0.06;
        _q.setFromUnitVectors(_up, _n.set(_ws.nx, _ws.ny, _ws.nz));
        p.mesh.quaternion.copy(_q).multiply(new Quaternion().setFromAxisAngle(_up, p.yaw));
      }
      if (beam) beam.rotation.y = time * 0.9;
      void smoothstep;
    },
    dispose() {
      disposeScene(scene);
      wake.dispose();
    },
  };
}

void BoxGeometry;
