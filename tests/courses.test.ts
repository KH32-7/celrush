import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { COURSES } from '../src/track/courses';
import { Track, newProj } from '../src/track/track';

describe('courses', () => {
  for (const def of COURSES) {
    it(`${def.id} is a sane closed loop`, () => {
      const t = new Track(def);
      let maxK = 0;
      for (let i = 0; i < t.n; i++) maxK = Math.max(maxK, Math.abs(t.curv[i]));
      // self-clearance: min distance between samples far apart along the lap
      const wall = def.halfWidth + def.curb + def.runoff;
      let clear = Infinity;
      const stride = 3;
      for (let i = 0; i < t.n; i += stride) {
        for (let j = i + stride; j < t.n; j += stride) {
          const sep = Math.min(j - i, t.n - (j - i)) * t.step;
          if (sep < wall * 4 + 40) continue;
          const d = Math.hypot(t.px[i] - t.px[j], t.pz[i] - t.pz[j]);
          if (d < clear) clear = d;
        }
      }
      let maxGrade = 0;
      for (let i = 0; i < t.n; i++) {
        const j = (i + 1) % t.n;
        maxGrade = Math.max(maxGrade, Math.abs(t.py[j] - t.py[i]) / t.step);
      }
      console.log(
        `${def.id.padEnd(12)} len=${t.length.toFixed(0)}m  minR=${(1 / maxK).toFixed(1)}m  clearance=${clear.toFixed(1)}m (need>${(wall * 2 + 8).toFixed(0)})  maxGrade=${(maxGrade * 100).toFixed(1)}%`,
      );
      expect(clear).toBeGreaterThan(wall * 2 + 8);
      expect(1 / maxK).toBeGreaterThan(def.vehicle === 'car' ? 16 : 24);
    });
  }

  it('projection round-trips', () => {
    const t = new Track(COURSES[0]);
    const p = newProj();
    const v = new Vector3();
    for (const s of [10, 333.3, 1200, t.length - 3]) {
      for (const d of [-6, 0, 4.5]) {
        t.pointAt(s, d, v);
        t.project(v.x, v.z, -1, p);
        expect(Math.abs(p.d - d)).toBeLessThan(0.05);
        const ds = Math.abs(((p.s - s + t.length * 1.5) % t.length) - t.length / 2);
        expect(ds).toBeLessThan(0.1);
      }
    }
  });
});
