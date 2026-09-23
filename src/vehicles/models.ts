import {
  BoxGeometry, ConeGeometry, CylinderGeometry, Group, IcosahedronGeometry, Mesh, Object3D, SphereGeometry, Vector3,
} from 'three';
import { MeshBuilder, trs } from '../render/geom';
import { makeToon, MASK, type ToonMaterial } from '../render/toon';
import { col, FX, LIVERIES } from '../tuning/palette';
import { CAR } from '../tuning/params';
import { hullStation } from './boatHull';

let shared: { body: ToonMaterial; glow: ToonMaterial; flame: ToonMaterial; wheel: ToonMaterial } | null = null;

export function vehicleMaterials() {
  if (!shared) {
    shared = {
      body: makeToon({ vertexColors: true, spec: 0.55, gloss: 70, rim: 1 }),
      wheel: makeToon({ vertexColors: true, spec: 0.2, gloss: 30, rim: 0.6 }),
      glow: makeToon({ vertexColors: true, unlit: true, emissiveBoost: 1.8, mask: MASK.emissive }),
      flame: makeToon({ vertexColors: true, unlit: true, emissiveBoost: 2.6, mask: MASK.emissive }),
    };
  }
  return shared;
}

// ---------------------------------------------------------------- car

interface CarStation { z: number; yb: number; ys: number; yw: number; yr: number; wb: number; ws: number; ww: number; wr: number }

const CAR_STATIONS: CarStation[] = [
  { z: -2.2, yb: -0.36, ys: -0.2, yw: -0.04, yr: 0.02, wb: 0.78, ws: 0.84, ww: 0.8, wr: 0.56 },
  { z: -2.02, yb: -0.4, ys: -0.16, yw: 0.06, yr: 0.13, wb: 0.86, ws: 0.95, ww: 0.92, wr: 0.74 },
  { z: -1.35, yb: -0.22, ys: -0.1, yw: 0.16, yr: 0.27, wb: 0.9, ws: 0.98, ww: 0.95, wr: 0.8 },
  { z: -0.58, yb: -0.22, ys: -0.1, yw: 0.2, yr: 0.33, wb: 0.9, ws: 0.98, ww: 0.95, wr: 0.82 },
  { z: 0.08, yb: -0.22, ys: -0.1, yw: 0.23, yr: 0.8, wb: 0.9, ws: 0.98, ww: 0.95, wr: 0.6 },
  { z: 0.78, yb: -0.22, ys: -0.1, yw: 0.25, yr: 0.78, wb: 0.9, ws: 0.99, ww: 0.96, wr: 0.58 },
  { z: 1.5, yb: -0.22, ys: -0.08, yw: 0.27, yr: 0.38, wb: 0.9, ws: 0.99, ww: 0.95, wr: 0.8 },
  { z: 1.98, yb: -0.36, ys: -0.1, yw: 0.27, yr: 0.33, wb: 0.88, ws: 0.95, ww: 0.93, wr: 0.78 },
  { z: 2.2, yb: -0.32, ys: -0.12, yw: 0.2, yr: 0.25, wb: 0.8, ws: 0.86, ww: 0.84, wr: 0.7 },
];

export interface CarView {
  root: Group;
  body: Group;
  wheels: Object3D[];
  flames: Mesh[];
  brake: Mesh;
}

export function buildCar(liveryIdx: number): CarView {
  const L = LIVERIES[liveryIdx % LIVERIES.length];
  const mats = vehicleMaterials();
  const cBody = col(L.body), cAcc = col(L.accent), cDark = col(L.dark), cGlass = col(L.glass), cStripe = col(L.stripe);
  const mb = new MeshBuilder();
  const rings = CAR_STATIONS.map((s) => [
    new Vector3(s.wb, s.yb, s.z), new Vector3(s.ws, s.ys, s.z), new Vector3(s.ww, s.yw, s.z), new Vector3(s.wr, s.yr, s.z),
    new Vector3(-s.wr, s.yr, s.z), new Vector3(-s.ww, s.yw, s.z), new Vector3(-s.ws, s.ys, s.z), new Vector3(-s.wb, s.yb, s.z),
  ]);
  mb.loft(rings, (c, ring, seg) => {
    if (seg === -1) return cBody;
    if (seg === 7) return cDark;
    if (seg === 0 || seg === 6) return ring >= 1 && ring <= 6 ? cDark : cBody;
    const greenhouse = ring >= 3 && ring <= 5;
    if (seg === 3) {
      if (ring === 3 || ring === 5) return cGlass; // windshield, rear window
      if (ring === 4) return cAcc; // roof
      return Math.abs(c.x) < 0.2 ? cStripe : cBody; // hood / trunk
    }
    if ((seg === 2 || seg === 4) && greenhouse) return ring === 5 ? cBody : cGlass;
    return cBody;
  });
  // side skirts, splitter, diffuser
  mb.add(new BoxGeometry(0.12, 0.2, 1.7), trs(0.92, -0.3, 0), cDark);
  mb.add(new BoxGeometry(0.12, 0.2, 1.7), trs(-0.92, -0.3, 0), cDark);
  mb.add(new BoxGeometry(1.7, 0.06, 0.34), trs(0, -0.4, -2.12), cDark);
  mb.add(new BoxGeometry(1.5, 0.14, 0.3), trs(0, -0.34, 2.1), cDark);
  // spoiler
  mb.add(new BoxGeometry(1.84, 0.07, 0.4), trs(0, 0.62, 1.98, -0.12), cAcc, true);
  mb.add(new BoxGeometry(0.08, 0.34, 0.1), trs(0.55, 0.45, 1.95), cDark, true);
  mb.add(new BoxGeometry(0.08, 0.34, 0.1), trs(-0.55, 0.45, 1.95), cDark, true);
  mb.add(new BoxGeometry(0.06, 0.26, 0.46), trs(0.93, 0.66, 1.98), cAcc, true);
  mb.add(new BoxGeometry(0.06, 0.26, 0.46), trs(-0.93, 0.66, 1.98), cAcc, true);
  // mirrors, intake, exhausts
  mb.add(new BoxGeometry(0.2, 0.1, 0.14), trs(1.02, 0.28, -0.42), cBody, true);
  mb.add(new BoxGeometry(0.2, 0.1, 0.14), trs(-1.02, 0.28, -0.42), cBody, true);
  mb.add(new BoxGeometry(0.7, 0.06, 0.4), trs(0, 0.29, -1.0, 0.05), cDark, true);
  mb.add(new CylinderGeometry(0.075, 0.075, 0.3, 8), trs(0.42, -0.28, 2.2, Math.PI / 2), col(FX.metal));
  mb.add(new CylinderGeometry(0.075, 0.075, 0.3, 8), trs(-0.42, -0.28, 2.2, Math.PI / 2), col(FX.metal));
  // driver helmet visible through the glass
  mb.add(new SphereGeometry(0.2, 10, 8), trs(-0.36, 0.42, 0.45), cAcc);

  const root = new Group();
  const body = new Group();
  const bodyMesh = new Mesh(mb.build(), mats.body);
  bodyMesh.castShadow = true;
  body.add(bodyMesh);

  // lights (unlit, bloom)
  const lb = new MeshBuilder();
  lb.add(new BoxGeometry(0.34, 0.09, 0.08), trs(0.58, 0.02, -2.16, 0, 0.22), col(FX.headlight), true);
  lb.add(new BoxGeometry(0.34, 0.09, 0.08), trs(-0.58, 0.02, -2.16, 0, -0.22), col(FX.headlight), true);
  const lights = new Mesh(lb.build(), mats.glow);
  body.add(lights);
  const tb = new MeshBuilder();
  tb.add(new BoxGeometry(0.46, 0.09, 0.06), trs(0.52, 0.12, 2.2), col(FX.taillight), true);
  tb.add(new BoxGeometry(0.46, 0.09, 0.06), trs(-0.52, 0.12, 2.2), col(FX.taillight), true);
  const brakeMat = makeToon({ vertexColors: true, unlit: true, emissiveBoost: 1.2, mask: MASK.emissive });
  const brake = new Mesh(tb.build(), brakeMat);
  body.add(brake);

  // boost flames
  const flames: Mesh[] = [];
  const fb = new MeshBuilder();
  fb.add(new ConeGeometry(0.11, 0.9, 7), trs(0, -0.45, 0, Math.PI), col(FX.flame), true);
  fb.add(new ConeGeometry(0.06, 0.55, 6), trs(0, -0.3, 0.0, Math.PI), col(FX.flameCore), true);
  const fgeo = fb.build();
  for (const x of [0.42, -0.42]) {
    const f = new Mesh(fgeo, mats.flame);
    f.position.set(x, -0.28, 2.36);
    f.rotation.x = -Math.PI / 2;
    f.visible = false;
    flames.push(f);
    body.add(f);
  }
  root.add(body);

  // wheels: tire + rim + spokes so spin reads
  const wb = new MeshBuilder();
  const r = CAR.wheelRadius;
  wb.add(new CylinderGeometry(r, r, 0.27, 16), trs(0, 0, 0, 0, 0, Math.PI / 2), col(FX.tire), true);
  wb.add(new CylinderGeometry(r * 0.62, r * 0.62, 0.29, 10), trs(0, 0, 0, 0, 0, Math.PI / 2), col(FX.rim), true);
  wb.add(new BoxGeometry(0.3, r * 1.1, 0.07), trs(0, 0, 0), cAcc, true);
  wb.add(new BoxGeometry(0.3, 0.07, r * 1.1), trs(0, 0, 0), cAcc, true);
  const wgeo = wb.build();
  const wheels: Object3D[] = [];
  for (let i = 0; i < 4; i++) {
    const pivot = new Object3D();
    const w = new Mesh(wgeo, mats.wheel);
    w.castShadow = true;
    pivot.add(w);
    root.add(pivot);
    wheels.push(pivot);
  }
  return { root, body, wheels, flames, brake };
}

// ---------------------------------------------------------------- boat

export interface BoatView {
  root: Group;
  body: Group;
  engine: Object3D;
  flames: Mesh[];
}

export function buildBoat(liveryIdx: number): BoatView {
  const L = LIVERIES[liveryIdx % LIVERIES.length];
  const mats = vehicleMaterials();
  const cHull = col(L.hull), cBody = col(L.body), cDark = col(L.dark), cDeck = col(L.deck), cGlass = col(L.glass), cAcc = col(L.accent);
  const mb = new MeshBuilder();
  const N = 16;
  const rings: Vector3[][] = [];
  for (let i = 0; i <= N; i++) {
    const u = Math.min(i / N, 0.985);
    const s = hullStation(u);
    const hb = Math.max(s.halfBeam, 0.04);
    const stripeY = s.deckY - (s.deckY - s.chineY) * 0.42;
    rings.push([
      new Vector3(hb * 1.03, s.deckY, s.z),
      new Vector3(hb * 1.02, stripeY, s.z),
      new Vector3(hb * 0.97, s.chineY, s.z),
      new Vector3(0, s.keelY, s.z),
      new Vector3(-hb * 0.97, s.chineY, s.z),
      new Vector3(-hb * 1.02, stripeY, s.z),
      new Vector3(-hb * 1.03, s.deckY, s.z),
    ]);
  }
  // livery color on the topsides so the hull pops against white foam and blue water
  mb.loft(rings, (c, ring, seg) => {
    if (seg === -1) return ring === 0 ? cBody : cHull;
    if (seg === 0 || seg === 5) return cHull; // light rub-rail stripe under the gunwale
    if (seg === 1 || seg === 4) return cBody;
    if (seg === 2 || seg === 3) return cDark;
    return c.z < -1.2 ? cHull : cDeck; // deck: foredeck white, cockpit sole deck color
  });
  // seats
  const stMid = hullStation(0.42);
  mb.add(new BoxGeometry(0.62, 0.3, 0.55), trs(-0.42, stMid.deckY + 0.2, 0.75), cAcc, true);
  mb.add(new BoxGeometry(0.62, 0.3, 0.55), trs(0.42, stMid.deckY + 0.2, 0.75), cDark, true);
  mb.add(new BoxGeometry(0.62, 0.55, 0.14), trs(-0.42, stMid.deckY + 0.45, 1.02), cAcc, true);
  mb.add(new BoxGeometry(0.62, 0.55, 0.14), trs(0.42, stMid.deckY + 0.45, 1.02), cDark, true);
  // console + wraparound windshield
  mb.add(new BoxGeometry(0.7, 0.45, 0.5), trs(-0.42, stMid.deckY + 0.2, -0.05), cHull, true);
  const ws = hullStation(0.6);
  const wy = ws.deckY + 0.02;
  const wz = ws.z + 0.1;
  const hwS = ws.halfBeam * 0.95;
  const top = 0.45;
  const pL = new Vector3(-hwS, wy, wz + 0.35), pC = new Vector3(0, wy, wz - 0.05), pR = new Vector3(hwS, wy, wz + 0.35);
  const qL = new Vector3(-hwS * 0.9, wy + top, wz + 0.62), qC = new Vector3(0, wy + top, wz + 0.3), qR = new Vector3(hwS * 0.9, wy + top, wz + 0.62);
  mb.quad(pL, pC, qC, qL, cGlass).quad(pC, pR, qR, qC, cGlass);
  mb.quad(pL, qL, qC, pC, cGlass).quad(pC, qC, qR, pR, cGlass);
  // driver
  mb.add(new BoxGeometry(0.42, 0.55, 0.32), trs(-0.42, stMid.deckY + 0.62, 0.72, -0.2), col(FX.suit), true);
  mb.add(new SphereGeometry(0.19, 12, 10), trs(-0.42, stMid.deckY + 1.05, 0.62), cBody);
  mb.add(new BoxGeometry(0.26, 0.09, 0.08), trs(-0.42, stMid.deckY + 1.06, 0.45), cDark, true);
  // bow rail + cleats
  const bow = hullStation(0.9);
  mb.add(new CylinderGeometry(0.025, 0.025, 1.2, 5), trs(0.25, bow.deckY + 0.18, bow.z + 0.4, Math.PI / 2 - 0.15, 0, 0), col(FX.metal));
  mb.add(new CylinderGeometry(0.025, 0.025, 1.2, 5), trs(-0.25, bow.deckY + 0.18, bow.z + 0.4, Math.PI / 2 - 0.15, 0, 0), col(FX.metal));

  const root = new Group();
  const body = new Group();
  const hullMesh = new Mesh(mb.build(), mats.body);
  hullMesh.castShadow = true;
  body.add(hullMesh);

  // nav lights
  const nb = new MeshBuilder();
  nb.add(new IcosahedronGeometry(0.06, 0), trs(bow.halfBeam + 0.02, bow.deckY + 0.02, bow.z), col(FX.navGreen), true);
  nb.add(new IcosahedronGeometry(0.06, 0), trs(-bow.halfBeam - 0.02, bow.deckY + 0.02, bow.z), col(FX.taillight), true);
  body.add(new Mesh(nb.build(), mats.glow));

  // outboard (separate so it swivels with steering)
  const st = hullStation(0);
  const eb = new MeshBuilder();
  eb.add(new BoxGeometry(0.5, 0.55, 0.62), trs(0, 0.28, 0.3), cBody, true);
  eb.add(new BoxGeometry(0.52, 0.12, 0.64), trs(0, 0.58, 0.3), cDark, true);
  eb.add(new BoxGeometry(0.14, 0.9, 0.22), trs(0, -0.35, 0.3), cDark, true);
  eb.add(new BoxGeometry(0.1, 0.1, 0.5), trs(0, -0.78, 0.26), cDark, true);
  eb.add(new BoxGeometry(0.5, 0.06, 0.1), trs(0, -0.7, 0.5), col(FX.metal), true);
  const engine = new Object3D();
  engine.position.set(0, st.deckY - 0.1, st.z);
  const engMesh = new Mesh(eb.build(), mats.body);
  engMesh.castShadow = true;
  engine.add(engMesh);
  body.add(engine);

  const flames: Mesh[] = [];
  const fb = new MeshBuilder();
  fb.add(new ConeGeometry(0.16, 1.0, 7), trs(0, -0.5, 0, Math.PI), col(FX.boostFlame), true);
  fb.add(new ConeGeometry(0.08, 0.6, 6), trs(0, -0.3, 0, Math.PI), col(FX.flameCore), true);
  const f = new Mesh(fb.build(), mats.flame);
  f.position.set(0, 0.42, 0.66);
  f.rotation.x = -Math.PI / 2;
  f.visible = false;
  engine.add(f);
  flames.push(f);
  root.add(body);
  return { root, body, engine, flames };
}
