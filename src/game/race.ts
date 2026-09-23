import { Object3D, Quaternion, Vector3 } from 'three';
import type { Controls } from '../core/input';
import { clamp } from '../core/math';
import { contactSpheres } from '../physics/rigidbody';
import type { World } from '../scene/world';
import { UI } from '../tuning/palette';
import { buildBoat, buildCar } from '../vehicles/models';
import { AIDriver, RacingLine } from './ai';
import { GhostRecorder, loadGhost, saveGhost, type GhostTrack } from './ghost';
import { ghostify, Racer } from './racer';

export type Mode = 'race' | 'time' | 'survival';
export type RaceState = 'intro' | 'countdown' | 'racing' | 'finished';

export interface RaceHooks {
  msg(text: string, color: number, big?: boolean): void;
  sound(name: string, v?: number): void;
}

export interface ResultRow {
  name: string;
  place: number;
  time: number;
  best: number;
  player: boolean;
  livery: number;
}

const AI_NAMES = ['RIN', 'BOLT', 'MOKA'];
const INTRO = 3.2;
const COUNT = 3;
const _a = new Vector3();
const _b = new Vector3();
const _t = new Vector3();

export class Race {
  readonly racers: Racer[] = [];
  readonly player: Racer;
  readonly line: RacingLine;
  readonly laps: number;
  state: RaceState = 'intro';
  clock = 0;
  stateT = 0;
  countNum = 4;
  survivalLeft = 40;
  private survivalBest = 0;
  private ghostRec = new GhostRecorder();
  ghost: GhostTrack | null = null;
  ghostView: Object3D | null = null;
  ghostDelta: number | null = null;
  private rocket = false;
  private rocketFail = false;
  results: ResultRow[] = [];
  newRecord = false;
  autodrive = false;
  private finalLapShown = false;
  readonly attract: boolean;

  constructor(readonly world: World, readonly mode: Mode, readonly hooks: RaceHooks, opts: { attract?: boolean } = {}) {
    this.attract = !!opts.attract;
    const kind = world.def.vehicle;
    this.laps = mode === 'survival' ? 999 : world.def.laps;
    this.line = new RacingLine(world.track, kind);
    const L = world.track.length;
    const hw = world.track.hw;
    const solo = mode !== 'race' && !this.attract;
    const n = solo ? 1 : 4;
    const playerSlot = solo ? 0 : 2;
    let aiI = 0;
    for (let i = 0; i < n; i++) {
      const isPlayer = i === playerSlot && !this.attract;
      const livery = isPlayer ? 0 : i === 0 ? 1 : i === 1 ? 2 : 3;
      const r = new Racer(kind, livery, isPlayer ? 'YOU' : AI_NAMES[aiI++ % AI_NAMES.length], isPlayer);
      const s = L - 9 - i * (kind === 'car' ? 7.5 : 10);
      const d = solo ? 0 : (i % 2 ? 1 : -1) * hw * (kind === 'car' ? 0.32 : 0.28);
      r.vehicle.place(world.env, s, d);
      r.prevS = r.vehicle.proj.s;
      r.progress = r.prevS - L;
      r.lap = -1;
      r.padCd = world.pads.map(() => 0);
      if (!isPlayer || this.attract) {
        const skill = [0.965, 0.985, 1.0, 0.975][i];
        r.ai = new AIDriver(this.line, skill, kind, (i % 2 ? 1 : -1) * 1.2);
      }
      world.scene.add(r.view.root);
      this.racers.push(r);
    }
    this.player = this.racers.find((r) => r.isPlayer) ?? this.racers[0];
    if (mode === 'time' && !this.attract) {
      this.ghost = loadGhost(world.def.id);
      const gv = kind === 'car' ? buildCar(1).root : buildBoat(1).root;
      ghostify(gv, 0.42);
      gv.visible = false;
      world.scene.add(gv);
      this.ghostView = gv;
    }
    if (this.attract) {
      this.state = 'racing';
      for (const r of this.racers) r.lap = 0;
    }
  }

  get kind() {
    return this.world.def.vehicle;
  }

  private get L() {
    return this.world.track.length;
  }

  /** seconds into the countdown digit (0..1) for the HUD pop animation */
  get countdown(): { n: number; t: number } | null {
    if (this.state === 'countdown') {
      const left = COUNT - this.stateT;
      return { n: Math.ceil(left), t: 1 - (left - Math.floor(left)) };
    }
    if (this.state === 'racing' && this.clock < 0.9 && !this.attract) return { n: 0, t: this.clock / 0.9 };
    return null;
  }

  respawn(r: Racer) {
    const v = r.vehicle;
    const oldS = v.proj.s;
    const s = oldS - 6;
    v.place(this.world.env, s, clamp(v.proj.d * 0.3, -this.world.track.hw * 0.4, this.world.track.hw * 0.4));
    v.ghostT = 2;
    let ds = v.proj.s - oldS;
    if (ds > this.L / 2) ds -= this.L;
    if (ds < -this.L / 2) ds += this.L;
    r.progress += ds;
    r.prevS = v.proj.s;
    if (r.isPlayer) this.hooks.sound('respawn');
  }

  step(dt: number, pc: Controls) {
    const env = this.world.env;
    env.time += dt;
    if (env.water) env.water.time = env.time;
    this.stateT += dt;
    const held = this.state === 'intro' || this.state === 'countdown';

    if (this.state === 'intro' && this.stateT >= INTRO) {
      this.state = 'countdown';
      this.stateT = 0;
    }
    if (this.state === 'countdown') {
      const n = Math.ceil(COUNT - this.stateT);
      if (n !== this.countNum && n > 0) {
        this.countNum = n;
        this.hooks.sound('count', n);
      }
      // rocket start: press throttle in the last 0.45 s; mashing early spoils it
      const left = COUNT - this.stateT;
      if (pc.throttle > 0.5) {
        if (left > 1.1) this.rocketFail = true;
        else if (left < 0.45 && !this.rocketFail) this.rocket = true;
      }
      if (this.stateT >= COUNT) {
        this.state = 'racing';
        this.stateT = 0;
        this.clock = 0;
        this.hooks.sound('go');
        this.hooks.msg('GO!', UI.accent, true);
        for (const r of this.racers) r.lapStart = 0;
        if (this.rocket) {
          this.player.vehicle.giveBoost(1.1);
          this.hooks.msg('ROCKET START!', UI.accent2);
          this.hooks.sound('boost', 2);
        }
        for (const r of this.racers) if (r.ai && Math.random() < 0.5) r.vehicle.giveBoost(0.7);
      }
    }
    if (this.state === 'racing' || this.state === 'finished') this.clock += dt;

    const vehicles = this.racers.map((r) => r.vehicle);
    for (const r of this.racers) {
      const v = r.vehicle;
      const c = v.controls;
      if (held) {
        c.steer = 0;
        c.brake = 0;
        c.drift = false;
        c.throttle = r.isPlayer ? pc.throttle : 0;
        c.pitch = 0;
      } else if (r.isPlayer && !r.finished && !this.autodrive) {
        c.steer = pc.steer;
        c.throttle = pc.throttle;
        c.brake = pc.brake;
        c.drift = pc.drift;
        c.pitch = pc.pitch;
      } else {
        if (!r.ai) r.ai = new AIDriver(this.line, 0.97, this.kind, 0);
        r.ai.update(dt, v, vehicles, r.progress - this.player.progress, c);
        if (r.finished) c.throttle *= 0.6;
      }
    }

    for (const r of this.racers) r.vehicle.step(dt, env);

    if (held) {
      // pin to the grid, but let suspension / buoyancy settle naturally
      for (const r of this.racers) {
        const b = r.vehicle.body;
        b.vel.x *= 0.6;
        b.vel.z *= 0.6;
        b.angVel.y *= 0.6;
      }
    }

    // vehicle vs vehicle
    for (let i = 0; i < this.racers.length; i++) {
      for (let j = i + 1; j < this.racers.length; j++) {
        const A = this.racers[i].vehicle, B = this.racers[j].vehicle;
        if (A.ghostT > 0 || B.ghostT > 0) continue;
        if (A.body.pos.distanceToSquared(B.body.pos) > 64) continue;
        for (const sa of A.spheres) {
          for (const sb of B.spheres) {
            A.body.localToWorld(sa.p, _a);
            B.body.localToWorld(sb.p, _b);
            const jn = contactSpheres(A.body, _a, sa.r, B.body, _b, sb.r, 0.25);
            if (jn > 0) {
              const dv = jn / A.body.mass;
              _t.addVectors(_a, _b).multiplyScalar(0.5);
              for (const V of [A, B]) {
                if (dv > V.events.wallHit) {
                  V.events.wallHit = dv;
                  V.events.wallPoint.copy(_t);
                }
              }
            }
          }
        }
      }
    }

    const L = this.L;
    for (const r of this.racers) {
      const v = r.vehicle;
      if (v.needsRespawn) this.respawn(r);
      let ds = v.proj.s - r.prevS;
      if (ds > L / 2) ds -= L;
      if (ds < -L / 2) ds += L;
      r.prevS = v.proj.s;
      if (held) continue;
      r.progress += ds;

      // boost pads
      for (let k = 0; k < this.world.pads.length; k++) {
        if (r.padCd[k] > 0) {
          r.padCd[k] -= dt;
          continue;
        }
        const p = this.world.pads[k];
        let dps = v.proj.s - p.s;
        if (dps > L / 2) dps -= L;
        if (dps < -L / 2) dps += L;
        if (Math.abs(dps) < p.len / 2 + 0.5 && Math.abs(v.proj.d - p.d) < p.halfW + 0.6) {
          v.giveBoost(0.95);
          r.padCd[k] = 1.5;
          if (r.isPlayer) {
            this.hooks.sound('boost', 1);
            this.hooks.msg('BOOST!', UI.accent2);
          }
        }
      }

      // wrong way
      const i = v.proj.idx;
      v.forward(_t);
      const along = _t.x * this.world.track.tx[i] + _t.z * this.world.track.tz[i];
      r.wrongT = along < -0.35 && v.speed > 3 ? r.wrongT + dt : 0;

      if (this.attract) continue;
      const comp = Math.floor(r.progress / L);
      if (comp > r.lap) {
        if (comp >= 1 && r.lap >= 0) {
          const lt = this.clock - r.lapStart;
          r.lapTimes.push(lt);
          if (lt < r.best) r.best = lt;
          if (r.isPlayer) this.onPlayerLap(lt, comp);
        }
        r.lap = comp;
        r.lapStart = this.clock;
        if (r.isPlayer) this.ghostRec.reset();
        if (comp >= this.laps && !r.finished) {
          r.finished = true;
          r.finishTime = this.clock;
          if (r.isPlayer) this.finish();
        }
      }
    }

    if (this.mode === 'survival' && this.state === 'racing' && !this.attract) {
      this.survivalLeft -= dt;
      const sector = L / 6;
      const best = Math.floor(this.player.progress / sector);
      if (best > this.survivalBest) {
        if (this.survivalBest > 0 || best > 1) {
          const add = Math.max(4, 7 - Math.floor(best / 12));
          this.survivalLeft = Math.min(60, this.survivalLeft + add);
          this.hooks.msg(`+${add}s`, UI.good);
          this.hooks.sound('check');
        }
        this.survivalBest = best;
      }
      if (this.survivalLeft <= 0) {
        this.survivalLeft = 0;
        this.player.finished = true;
        this.player.finishTime = this.clock;
        this.finish();
      }
    }

    // ghost record / playback
    if (this.mode === 'time' && this.state === 'racing' && this.player.lap >= 0) {
      const lapT = this.clock - this.player.lapStart;
      this.ghostRec.record(dt, this.player.vehicle.body.pos, this.player.vehicle.body.quat);
      if (this.ghost && this.ghostView) {
        const ok = this.ghost.sample(lapT, this.ghostView.position, this.ghostView.quaternion as Quaternion);
        this.ghostView.visible = ok;
        this.ghostDelta = null;
      }
    }

    this.rank();
  }

  private onPlayerLap(lt: number, comp: number) {
    this.hooks.sound('lap');
    const best = this.player.best === lt && this.player.lapTimes.length > 1;
    if (this.mode === 'time') {
      const data = this.ghostRec.take();
      if (!this.ghost || lt < this.ghost.time) {
        saveGhost(this.world.def.id, lt, data);
        this.ghost = loadGhost(this.world.def.id);
        this.newRecord = true;
        this.hooks.msg('NEW RECORD!', UI.accent2, true);
        return;
      }
    }
    if (comp === this.laps - 1 && !this.finalLapShown && this.mode !== 'survival') {
      this.finalLapShown = true;
      this.hooks.msg('FINAL LAP!', UI.accent, true);
    } else if (comp < this.laps) {
      this.hooks.msg(best ? `BEST LAP ${fmt(lt)}` : `LAP ${comp + 1}`, best ? UI.good : UI.paper);
    }
  }

  private finish() {
    this.state = 'finished';
    this.stateT = 0;
    this.hooks.sound('finish');
    this.hooks.msg(this.mode === 'survival' ? 'TIME UP!' : 'FINISH!', UI.accent2, true);
    this.rank();
  }

  private rank() {
    const order = [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    order.forEach((r, i) => (r.place = i + 1));
    this.results = order.map((r) => ({
      name: r.name, place: r.place, time: r.finished ? r.finishTime : NaN, best: r.best, player: r.isPlayer, livery: r.livery,
    }));
  }

  /** distance covered in survival, meters */
  get distance() {
    return Math.max(0, this.player.progress);
  }

  dispose() {
    for (const r of this.racers) this.world.scene.remove(r.view.root);
    if (this.ghostView) this.world.scene.remove(this.ghostView);
  }
}

export function fmt(t: number) {
  if (!Number.isFinite(t)) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}
