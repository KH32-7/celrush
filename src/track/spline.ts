/**
 * Closed centripetal Catmull-Rom through control points, resampled at uniform arc length.
 * Centripetal (alpha 0.5) avoids cusps and self-loops on uneven control spacing.
 */
export type P3 = [number, number, number];

function tj(ti: number, a: P3, b: P3) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return ti + Math.pow(dx * dx + dy * dy + dz * dz, 0.25);
}

function crPoint(p0: P3, p1: P3, p2: P3, p3: P3, u: number, out: P3) {
  const t0 = 0;
  const t1 = tj(t0, p0, p1);
  const t2 = tj(t1, p1, p2);
  const t3 = tj(t2, p2, p3);
  const t = t1 + (t2 - t1) * u;
  for (let k = 0; k < 3; k++) {
    const a1 = ((t1 - t) / (t1 - t0)) * p0[k] + ((t - t0) / (t1 - t0)) * p1[k];
    const a2 = ((t2 - t) / (t2 - t1)) * p1[k] + ((t - t1) / (t2 - t1)) * p2[k];
    const a3 = ((t3 - t) / (t3 - t2)) * p2[k] + ((t - t2) / (t3 - t2)) * p3[k];
    const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
    const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
    out[k] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
  }
  return out;
}

/** Returns flat xyz array of points spaced `step` meters apart along the closed curve, plus total length. */
export function resampleClosed(ctrl: P3[], step: number): { pts: Float64Array; length: number } {
  const n = ctrl.length;
  const dense: number[] = [];
  const per = 64;
  const tmp: P3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    for (let j = 0; j < per; j++) {
      crPoint(p0, p1, p2, p3, j / per, tmp);
      dense.push(tmp[0], tmp[1], tmp[2]);
    }
  }
  const m = dense.length / 3;
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const a = i * 3, b = ((i + 1) % m) * 3;
    const dx = dense[b] - dense[a], dy = dense[b + 1] - dense[a + 1], dz = dense[b + 2] - dense[a + 2];
    cum[i + 1] = cum[i] + Math.hypot(dx, dy, dz);
  }
  const length = cum[m];
  const count = Math.max(8, Math.round(length / step));
  const realStep = length / count;
  const pts = new Float64Array(count * 3);
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const s = i * realStep;
    while (cum[seg + 1] < s) seg++;
    const f = (s - cum[seg]) / (cum[seg + 1] - cum[seg] || 1);
    const a = seg * 3, b = ((seg + 1) % m) * 3;
    pts[i * 3] = dense[a] + (dense[b] - dense[a]) * f;
    pts[i * 3 + 1] = dense[a + 1] + (dense[b + 1] - dense[a + 1]) * f;
    pts[i * 3 + 2] = dense[a + 2] + (dense[b + 2] - dense[a + 2]) * f;
  }
  return { pts, length };
}
