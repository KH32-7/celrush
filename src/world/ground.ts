import { Vector3 } from 'three';
import { smoothstep } from '../core/math';
import type { Track, TrackProj } from '../track/track';
import { newProj } from '../track/track';

export const enum Surface {
  Road = 0,
  Curb = 1,
  Runoff = 2,
  Dirt = 3,
  Wet = 4,
}

export const SURFACE_NAMES = ['road', 'curb', 'runoff', 'dirt', 'wet'] as const;

export interface GroundHit {
  h: number;
  n: Vector3;
  surface: Surface;
  d: number;
  s: number;
}

export const CURB_HEIGHT = 0.06;

/**
 * Drivable ground for car courses. Height is a pure function of track-relative (s, d):
 * the road mesh is built from the same function, so wheels and pixels agree exactly.
 */
export class Ground {
  readonly wallD: number;
  private proj = newProj();
  private dirtRanges: [number, number][];

  constructor(readonly track: Track) {
    const def = track.def;
    this.wallD = def.halfWidth + def.curb + def.runoff;
    this.dirtRanges = (def.dirt ?? []).map(([a, b]) => [a * track.length, b * track.length]);
  }

  /** Height profile across the road at a known projection. */
  heightProfile(cy: number, bank: number, d: number) {
    const hw = this.track.hw;
    const ad = Math.abs(d);
    const curbW = this.track.def.curb;
    let h = cy + d * Math.tan(bank);
    if (curbW > 0) {
      // raised curb with short ramps so wheels roll over instead of hitting a step
      const up = smoothstep(hw, hw + 0.18, ad) * (1 - smoothstep(hw + curbW - 0.18, hw + curbW, ad));
      h += CURB_HEIGHT * up;
    }
    // runoff dips gently so cars drift back toward the road
    const beyond = ad - (hw + curbW);
    if (beyond > 0) h -= Math.min(beyond, 6) * 0.025;
    return h;
  }

  heightAt(x: number, z: number, hint: number): number {
    const p = this.track.project(x, z, hint, this.proj);
    return this.heightProfile(p.cy, p.bank, p.d);
  }

  surfaceAt(p: TrackProj): Surface {
    const ad = Math.abs(p.d);
    const hw = this.track.hw;
    if (ad <= hw) return Surface.Road;
    if (ad <= hw + this.track.def.curb) return Surface.Curb;
    for (const [a, b] of this.dirtRanges) if (p.s >= a && p.s <= b) return Surface.Dirt;
    return Surface.Runoff;
  }

  /** Height, finite-difference normal and surface type. */
  sample(x: number, z: number, hint: number, out: GroundHit): GroundHit {
    const p = this.track.project(x, z, hint, this.proj);
    const h = this.heightProfile(p.cy, p.bank, p.d);
    const e = 0.3;
    const hx = this.heightAt(x + e, z, p.idx);
    const hz = this.heightAt(x, z + e, p.idx);
    out.n.set(-(hx - h) / e, 1, -(hz - h) / e).normalize();
    out.h = h;
    out.s = p.s;
    out.d = p.d;
    out.surface = this.surfaceAt(p);
    return out;
  }
}
