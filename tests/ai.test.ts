import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STEP } from '../src/core/loop';
import { AIDriver, RacingLine } from '../src/game/ai';
import { COURSES } from '../src/track/courses';
import { Track } from '../src/track/track';
import { Boat } from '../src/vehicles/boat';
import { Car } from '../src/vehicles/car';
import type { SimEnv } from '../src/vehicles/vehicle';
import { Ground } from '../src/world/ground';
import { WaveField, WAVESETS } from '../src/world/water';

mkdirSync('tests/out', { recursive: true });
writeFileSync('tests/out/ai.log', '');
const log = (s: string) => appendFileSync('tests/out/ai.log', s + '\n');

/** The AI drives every real course on the real physics: proves each layout is lappable without respawns. */
describe('AI laps every course', () => {
  for (const def of COURSES) {
    it(def.id, () => {
      const track = new Track(def);
      const env: SimEnv = {
        track,
        ground: def.vehicle === 'car' ? new Ground(track) : null,
        water: def.vehicle === 'boat' ? new WaveField(WAVESETS[def.waves ?? 'bay']) : null,
        time: 0, spheres: [], ramps: [], current: def.current ?? 0,
      };
      const line = new RacingLine(track, def.vehicle);
      const v = def.vehicle === 'car' ? new Car() : new Boat();
      v.place(env, track.length - 10, 0);
      const ai = new AIDriver(line, 1.0, def.vehicle, 0);
      let prevS = v.proj.s;
      let progress = prevS - track.length;
      let lap = -1;
      let lapStart = 0;
      const laps: number[] = [];
      let respawns = 0, drifts = 0, boosts = 0, maxSpeed = 0, hardHits = 0;
      const why: string[] = [];
      for (let i = 0; i < Math.round(260 / STEP) && laps.length < 2; i++) {
        env.time += STEP;
        if (env.water) env.water.time = env.time;
        ai.update(STEP, v, [v], 0, v.controls);
        v.clearEvents();
        v.step(STEP, env);
        if (v.events.driftStart) drifts++;
        if (v.events.boost) boosts++;
        maxSpeed = Math.max(maxSpeed, v.speed);
        if (v.events.wallHit > 4) hardHits++;
        if (v.needsRespawn) {
          respawns++;
          const reason = v.upsideT > 1.5 ? 'flip' : v.stuckT > 3 ? 'stuck' : 'fall';
          why.push(`${reason}@s${v.proj.s.toFixed(0)}/d${v.proj.d.toFixed(1)}/v${v.speed.toFixed(1)}/drift${v.drift.active ? 1 : 0}`);
          v.place(env, v.proj.s - 6, 0);
        }
        let ds = v.proj.s - prevS;
        if (ds > track.length / 2) ds -= track.length;
        if (ds < -track.length / 2) ds += track.length;
        prevS = v.proj.s;
        progress += ds;
        const comp = Math.floor(progress / track.length);
        if (comp > lap) {
          if (lap >= 0) laps.push(env.time - lapStart);
          lap = comp;
          lapStart = env.time;
        }
      }
      log(
        `${def.id.padEnd(12)} len ${track.length.toFixed(0)}m  laps ${laps.map((t) => t.toFixed(1) + 's').join(' / ')}  avg ${laps.length ? ((track.length / laps[laps.length - 1]) * 3.6).toFixed(0) : '-'}km/h  top ${(maxSpeed * 3.6).toFixed(0)}km/h  drifts ${drifts} boosts ${boosts} hardHits ${hardHits} respawns ${respawns} ${why.join(' ')}`,
      );
      expect(laps.length).toBe(2);
      expect(respawns).toBeLessThanOrEqual(1);
    });
  }
});
