import { Quaternion, Vector3 } from 'three';

const RATE = 20;

/** Best-lap ghost: pose samples at 20 Hz, stored per course in localStorage. No determinism needed. */
export class GhostRecorder {
  private buf: number[] = [];
  private acc = 0;

  reset() {
    this.buf = [];
    this.acc = 0;
  }

  record(dt: number, p: Vector3, q: Quaternion) {
    this.acc += dt;
    while (this.acc >= 1 / RATE) {
      this.acc -= 1 / RATE;
      this.buf.push(p.x, p.y, p.z, q.x, q.y, q.z, q.w);
    }
  }

  take(): Float32Array {
    const a = new Float32Array(this.buf);
    this.reset();
    return a;
  }
}

export class GhostTrack {
  constructor(readonly data: Float32Array, readonly time: number) {}

  /** pose at t seconds into the lap; false when the lap has run out */
  sample(t: number, p: Vector3, q: Quaternion): boolean {
    const n = this.data.length / 7;
    const f = t * RATE;
    const i = Math.floor(f);
    if (i < 0 || i >= n - 1) return false;
    const k = f - i;
    const a = i * 7, b = (i + 1) * 7, d = this.data;
    p.set(d[a] + (d[b] - d[a]) * k, d[a + 1] + (d[b + 1] - d[a + 1]) * k, d[a + 2] + (d[b + 2] - d[a + 2]) * k);
    const qa = new Quaternion(d[a + 3], d[a + 4], d[a + 5], d[a + 6]);
    const qb = new Quaternion(d[b + 3], d[b + 4], d[b + 5], d[b + 6]);
    q.slerpQuaternions(qa, qb, k);
    return true;
  }
}

const key = (course: string) => `celrush.ghost.${course}`;

export function saveGhost(course: string, time: number, data: Float32Array) {
  try {
    const bytes = new Uint8Array(data.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    localStorage.setItem(key(course), JSON.stringify({ time, data: btoa(s) }));
  } catch {
    /* storage full or blocked: ghosts are a nicety */
  }
}

export function loadGhost(course: string): GhostTrack | null {
  try {
    const raw = localStorage.getItem(key(course));
    if (!raw) return null;
    const o = JSON.parse(raw) as { time: number; data: string };
    const bin = atob(o.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new GhostTrack(new Float32Array(bytes.buffer), o.time);
  } catch {
    return null;
  }
}
