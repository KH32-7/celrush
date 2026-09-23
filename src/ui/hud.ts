import { clamp } from '../core/math';
import type { Mode } from '../game/race';
import { fmt } from '../game/race';
import type { Track } from '../track/track';
import { css, FX, LIVERIES, UI } from '../tuning/palette';

export interface HudState {
  kind: 'car' | 'boat';
  mode: Mode;
  speed: number;
  rpm: number;
  boostFrac: number;
  boosting: boolean;
  drift: { active: boolean; stage: number; frac: number };
  lap: number;
  laps: number;
  place: number;
  count: number;
  time: number;
  lapTime: number;
  best: number;
  countdown: { n: number; t: number } | null;
  survival: number | null;
  distance: number;
  wrongWay: boolean;
  racers: { x: number; z: number; player: boolean; livery: number }[];
  showRace: boolean;
}

interface Msg {
  text: string;
  color: number;
  big: boolean;
  t: number;
}

const FONT = `'Arial Black', 'Segoe UI Black', Impact, 'Malgun Gothic', sans-serif`;
const SUFFIX = ['ST', 'ND', 'RD', 'TH'];

/** Comic-book HUD on a 2D canvas: ink-stroked slanted numerals, parallelogram gauges, starburst countdown. */
export class Hud {
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private s = 1;
  private dpr = 1;
  private msgs: Msg[] = [];
  private map: HTMLCanvasElement | null = null;
  private mapTf = { ox: 0, oz: 0, k: 1 };
  private t = 0;
  private dots: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.cv = canvas;
    this.g = canvas.getContext('2d')!;
    this.dots = document.createElement('canvas');
    this.dots.width = this.dots.height = 8;
    const d = this.dots.getContext('2d')!;
    d.fillStyle = css(UI.ink, 0.22);
    d.beginPath();
    d.arc(2, 2, 1.3, 0, Math.PI * 2);
    d.arc(6, 6, 1.3, 0, Math.PI * 2);
    d.fill();
    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.cv.width = Math.floor(this.w * this.dpr);
    this.cv.height = Math.floor(this.h * this.dpr);
    this.s = clamp(Math.min(this.w / 1280, this.h / 760), 0.55, 1.6);
  }

  setTrack(track: Track) {
    const size = 200;
    const pad = 16;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const wx = track.maxX - track.minX, wz = track.maxZ - track.minZ;
    const k = (size - pad * 2) / Math.max(wx, wz);
    const ox = pad + (size - pad * 2 - wx * k) / 2 - track.minX * k;
    const oz = pad + (size - pad * 2 - wz * k) / 2 - track.minZ * k;
    this.mapTf = { ox, oz, k };
    const path = () => {
      g.beginPath();
      for (let i = 0; i <= track.n; i += 4) {
        const j = i % track.n;
        const x = ox + track.px[j] * k, y = oz + track.pz[j] * k;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
    };
    g.lineJoin = 'round';
    g.strokeStyle = css(UI.ink);
    g.lineWidth = 11;
    path();
    g.stroke();
    g.strokeStyle = css(UI.paper);
    g.lineWidth = 5.5;
    path();
    g.stroke();
    // start line tick
    const sx = ox + track.px[0] * k, sz = oz + track.pz[0] * k;
    g.strokeStyle = css(UI.accent);
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(sx - track.rx[0] * 9, sz - track.rz[0] * 9);
    g.lineTo(sx + track.rx[0] * 9, sz + track.rz[0] * 9);
    g.stroke();
    this.map = c;
  }

  message(text: string, color: number, big = false) {
    this.msgs = this.msgs.filter((m) => m.text !== text);
    this.msgs.push({ text, color, big, t: 0 });
    if (this.msgs.length > 4) this.msgs.shift();
  }

  clearMessages() {
    this.msgs = [];
  }

  private text(str: string, x: number, y: number, size: number, fill: number, align: CanvasTextAlign = 'left', skew = -0.18, stroke = 0.2) {
    const g = this.g;
    g.save();
    g.translate(x, y);
    g.transform(1, 0, skew, 1, 0, 0);
    g.font = `italic 900 ${size}px ${FONT}`;
    g.textAlign = align;
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    g.lineWidth = size * stroke;
    g.strokeStyle = css(UI.ink);
    g.fillStyle = css(UI.ink);
    g.fillText(str, size * 0.06, size * 0.08); // hard drop shadow, like a printed offset
    g.strokeText(str, 0, 0);
    g.fillStyle = css(fill);
    g.fillText(str, 0, 0);
    g.restore();
  }

  private para(x: number, y: number, w: number, h: number, fill: string, slant = 0.25, stroke = true, lw = 3) {
    const g = this.g;
    const o = h * slant;
    g.beginPath();
    g.moveTo(x + o, y);
    g.lineTo(x + w + o, y);
    g.lineTo(x + w, y + h);
    g.lineTo(x, y + h);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    if (stroke) {
      g.lineWidth = lw;
      g.strokeStyle = css(UI.ink);
      g.stroke();
    }
  }

  private panel(x: number, y: number, w: number, h: number) {
    const g = this.g;
    this.para(x + 5, y + 5, w, h, css(UI.ink), 0.2, false);
    this.para(x, y, w, h, css(UI.paper), 0.2, true, 3.5 * this.s);
    g.save();
    g.clip();
    g.fillStyle = g.createPattern(this.dots, 'repeat')!;
    g.fillRect(x, y, w + h, h);
    g.restore();
  }

  private burst(cx: number, cy: number, r: number, spikes: number, fill: number, rot: number) {
    const g = this.g;
    g.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const a = rot + (i / (spikes * 2)) * Math.PI * 2;
      const rr = i % 2 === 0 ? r : r * (0.62 + 0.08 * Math.sin(i * 7.3));
      g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    g.closePath();
    g.fillStyle = css(UI.ink);
    g.save();
    g.translate(7, 7);
    g.fill();
    g.restore();
    g.fillStyle = css(fill);
    g.fill();
    g.lineWidth = 6 * this.s;
    g.lineJoin = 'miter';
    g.strokeStyle = css(UI.ink);
    g.stroke();
  }

  draw(st: HudState | null, dt: number) {
    const g = this.g;
    this.t += dt;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    if (!st) return;
    const s = this.s;
    const W = this.w, H = this.h;

    if (st.showRace) {
      // ---- speed block (bottom right)
      const bx = W - 330 * s, by = H - 150 * s;
      this.panel(bx, by, 290 * s, 112 * s);
      const spd = Math.round(st.speed);
      this.text(String(spd), bx + 196 * s, by + 82 * s, 78 * s, st.boosting ? UI.accent2 : UI.paper, 'right');
      this.text('KM/H', bx + 206 * s, by + 80 * s, 20 * s, UI.ink, 'left', -0.18, 0);
      // rpm segments
      const segs = 14;
      for (let i = 0; i < segs; i++) {
        const on = i / segs < st.rpm;
        const hot = i >= segs - 3;
        const x = bx + 22 * s + i * 17.5 * s;
        this.para(x, by + 92 * s, 13 * s, 12 * s, on ? css(hot ? UI.accent : UI.accent2) : css(UI.paperDim), 0.35, true, 1.5 * s);
      }
      // boost bar
      if (st.boostFrac > 0) {
        this.para(bx + 12 * s, by - 24 * s, 260 * s * st.boostFrac, 14 * s, css(FX.boostFlame), 0.4, true, 2 * s);
        this.text('BOOST', bx + 18 * s, by - 30 * s, 16 * s, UI.paper);
      }

      // ---- drift charge (bottom center)
      if (st.drift.active || st.drift.stage > 0) {
        const cx = W / 2 - 120 * s, cy = H - 92 * s;
        for (let i = 0; i < 3; i++) {
          const full = st.drift.stage > i;
          const part = st.drift.stage === i ? clamp(st.drift.frac, 0, 1) : 0;
          const x = cx + i * 84 * s;
          this.para(x, cy, 74 * s, 26 * s, css(UI.paperDim), 0.5, true, 3 * s);
          const fillW = full ? 74 : part * 74;
          if (fillW > 0) this.para(x + 2 * s, cy + 2 * s, (fillW - 4) * s, 22 * s, css(FX.spark[i]), 0.5, false);
        }
        const pulse = st.drift.stage > 0 ? 1 + Math.sin(this.t * 18) * 0.06 : 1;
        this.text(['DRIFT', 'MINI', 'SUPER', 'ULTRA'][st.drift.stage], W / 2, cy - 12 * s, 26 * s * pulse, st.drift.stage ? FX.spark[st.drift.stage - 1] : UI.paper, 'center');
      }

      // ---- position + lap (top left)
      if (st.mode === 'race') {
        const pc = UI.place[clamp(st.place - 1, 0, 3)];
        this.text(String(st.place), 34 * s, 112 * s, 104 * s, pc);
        this.text(SUFFIX[clamp(st.place - 1, 0, 3)], 34 * s + (st.place === 1 ? 62 : 74) * s, 74 * s, 34 * s, pc);
        this.text(`/${st.count}`, 34 * s + (st.place === 1 ? 64 : 76) * s, 112 * s, 28 * s, UI.paper);
      }
      const ly = st.mode === 'race' ? 164 * s : 70 * s;
      if (st.mode !== 'survival') {
        this.text(`LAP ${st.lap}/${st.laps}`, 30 * s, ly, 34 * s, UI.paper);
        this.text(fmt(st.lapTime), 30 * s, ly + 38 * s, 26 * s, UI.paper);
        if (Number.isFinite(st.best)) this.text(`BEST ${fmt(st.best)}`, 30 * s, ly + 68 * s, 18 * s, UI.accent2);
        this.text(`TOTAL ${fmt(st.time)}`, 30 * s, ly + (Number.isFinite(st.best) ? 92 : 66) * s, 16 * s, UI.paperDim);
      } else if (st.survival !== null) {
        const warn = st.survival < 10;
        const sc = warn ? 1 + Math.sin(this.t * 12) * 0.05 : 1;
        this.text(st.survival.toFixed(1), W / 2, 96 * s, 72 * s * sc, warn ? UI.accent : UI.paper, 'center');
        this.text(`${Math.floor(st.distance)} m`, W / 2, 132 * s, 24 * s, UI.accent2, 'center');
      }

      // ---- minimap (top right)
      if (this.map) {
        const ms = 190 * s;
        const mx = W - ms - 26 * s, my = 22 * s;
        this.panel(mx - 8 * s, my - 4 * s, ms + 12 * s, ms + 8 * s);
        g.drawImage(this.map, mx, my, ms, ms);
        const k = ms / 200;
        const sorted = [...st.racers].sort((a, b) => Number(a.player) - Number(b.player));
        for (const r of sorted) {
          const x = mx + (this.mapTf.ox + r.x * this.mapTf.k) * k;
          const y = my + (this.mapTf.oz + r.z * this.mapTf.k) * k;
          g.beginPath();
          g.arc(x, y, (r.player ? 7.5 : 5.5) * s, 0, Math.PI * 2);
          g.fillStyle = css(LIVERIES[r.livery % LIVERIES.length].body);
          g.fill();
          g.lineWidth = (r.player ? 3 : 2) * s;
          g.strokeStyle = css(UI.ink);
          g.stroke();
        }
      }
    }

    // ---- countdown starburst
    if (st.countdown) {
      const { n, t } = st.countdown;
      const pop = 1.45 - 0.45 * Math.min(1, t * 3.2) + (t > 0.85 ? (t - 0.85) * 2 : 0);
      const cx = W / 2, cy = H * 0.38;
      const r = 118 * s * pop;
      this.burst(cx, cy, r, 14, n === 0 ? UI.accent : UI.accent2, this.t * 0.6);
      this.text(n === 0 ? 'GO!' : String(n), cx, cy + 34 * s * pop, (n === 0 ? 84 : 110) * s * pop, n === 0 ? UI.paper : UI.ink, 'center', -0.12, n === 0 ? 0.2 : 0.02);
    }

    // ---- messages
    // stack by baseline: advance by this line's height BEFORE drawing so big callouts never overlap
    let my = H * 0.17;
    for (const m of this.msgs) {
      m.t += dt;
      const life = m.big ? 1.8 : 1.3;
      if (m.t > life) continue;
      const a = m.t / life;
      const pop = a < 0.12 ? 0.6 + (a / 0.12) * 0.55 : a < 0.2 ? 1.15 - ((a - 0.12) / 0.08) * 0.15 : 1;
      const base = (m.big ? 64 : 38) * s;
      const size = base * pop;
      my += base;
      g.globalAlpha = a > 0.8 ? 1 - (a - 0.8) / 0.2 : 1;
      this.text(m.text, W / 2, my, size, m.color, 'center');
      g.globalAlpha = 1;
      my += base * 0.28;
    }
    this.msgs = this.msgs.filter((m) => m.t <= (m.big ? 1.8 : 1.3));

    if (st.wrongWay && Math.floor(this.t * 3) % 2 === 0) {
      this.para(W / 2 - 200 * s, H * 0.5 - 40 * s, 400 * s, 70 * s, css(UI.accent), 0.3, true, 4 * s);
      this.text('WRONG WAY', W / 2 + 10 * s, H * 0.5 + 12 * s, 46 * s, UI.paper, 'center');
    }
  }
}
