import type { Mode, Race } from '../game/race';
import { fmt } from '../game/race';
import { coursesFor, courseById, type VehicleKind } from '../track/courses';
import { Track } from '../track/track';
import { css, LIVERIES, UI } from '../tuning/palette';
import { loadBest, type Settings } from './settings';

export interface Selection {
  kind: VehicleKind;
  course: string;
  mode: Mode;
}

export interface MenuHandlers {
  preview(sel: Selection): void;
  start(sel: Selection): void;
  resume(): void;
  restart(): void;
  quit(): void;
  settings(s: Settings): void;
  sound(name: string): void;
}

type Screen = 'title' | 'select' | 'pause' | 'results' | 'settings' | 'loading' | 'none';

const MODES: { id: Mode; t: string; k: string }[] = [
  { id: 'race', t: 'RACE', k: 'AI 3대와 3바퀴 경주' },
  { id: 'time', t: 'TIME ATTACK', k: '내 최고 랩 고스트와 대결' },
  { id: 'survival', t: 'SURVIVAL', k: '구간을 지날 때마다 시간 연장' },
];

export function applyCssPalette() {
  const r = document.documentElement.style;
  r.setProperty('--ink', css(UI.ink));
  r.setProperty('--paper', css(UI.paper));
  r.setProperty('--paper-dim', css(UI.paperDim));
  r.setProperty('--accent', css(UI.accent));
  r.setProperty('--accent2', css(UI.accent2));
  r.setProperty('--blue', css(UI.blue));
  r.setProperty('--dim', css(UI.dim));
  r.setProperty('--good', css(UI.good));
}

const thumbs = new Map<string, HTMLCanvasElement>();
function thumb(id: string) {
  let c = thumbs.get(id);
  if (c) return c;
  const t = new Track(courseById(id));
  c = document.createElement('canvas');
  c.width = 184;
  c.height = 128;
  const g = c.getContext('2d')!;
  const pad = 12;
  const wx = t.maxX - t.minX, wz = t.maxZ - t.minZ;
  const k = Math.min((c.width - pad * 2) / wx, (c.height - pad * 2) / wz);
  const ox = (c.width - wx * k) / 2 - t.minX * k, oz = (c.height - wz * k) / 2 - t.minZ * k;
  const path = () => {
    g.beginPath();
    for (let i = 0; i <= t.n; i += 6) {
      const j = i % t.n;
      g.lineTo(ox + t.px[j] * k, oz + t.pz[j] * k);
    }
    g.closePath();
  };
  g.lineJoin = 'round';
  g.strokeStyle = css(UI.ink);
  g.lineWidth = 10;
  path();
  g.stroke();
  g.strokeStyle = css(UI.accent2);
  g.lineWidth = 4.5;
  path();
  g.stroke();
  thumbs.set(id, c);
  return c;
}

/** DOM menus. Keyboard: arrows move, Enter picks, Esc backs out. Mouse works too. */
export class Menu {
  screen: Screen = 'none';
  private prev: Screen = 'none';
  sel: Selection;
  private focus = 0;
  private buttons: HTMLElement[] = [];

  constructor(private root: HTMLElement, private h: MenuHandlers, public settings: Settings, sel: Selection) {
    this.sel = sel;
  }

  private set(html: string, cls = '') {
    this.root.innerHTML = `<div class="screen ${cls}">${html}</div>`;
    this.buttons = Array.from(this.root.querySelectorAll<HTMLElement>('.btn'));
    this.buttons.forEach((b, i) => {
      b.addEventListener('mouseenter', () => this.setFocus(i, false));
      b.addEventListener('click', () => {
        this.h.sound('ui-ok');
        this.act(b.dataset.act ?? '', b.dataset.v ?? '');
      });
    });
  }

  private setFocus(i: number, sound = true) {
    if (!this.buttons.length) return;
    this.focus = (i + this.buttons.length) % this.buttons.length;
    this.buttons.forEach((b, k) => b.classList.toggle('focus', k === this.focus));
    if (sound) this.h.sound('ui');
  }

  hide() {
    this.screen = 'none';
    this.root.innerHTML = '';
    this.buttons = [];
  }

  showTitle() {
    this.screen = 'title';
    this.set(
      `<div class="focus-lines"></div>
       <div class="logo">CEL <span class="r">RUSH</span></div>
       <div class="logo-sub">셀 러시 · 만화 속 화면을 달리는 아케이드 레이서</div>
       <div class="press">PRESS ENTER / CLICK</div>
       <button class="btn go" data-act="to-select" style="position:absolute;opacity:0;width:1px;height:1px"></button>`,
    );
    this.root.querySelector('.screen')!.addEventListener('click', () => this.act('to-select', ''));
  }

  showSelect() {
    this.screen = 'select';
    const s = this.sel;
    const courses = coursesFor(s.kind);
    if (!courses.some((c) => c.id === s.course)) s.course = courses[0].id;
    const bestFor = (id: string) => {
      const v = loadBest(id, s.mode);
      if (v === null) return '기록 없음';
      return s.mode === 'survival' ? `최고 ${Math.floor(v)} m` : s.mode === 'time' ? `베스트 랩 ${fmt(v)}` : `최고 기록 ${fmt(v)}`;
    };
    this.set(
      `<div class="select-wrap">
        <div class="panel"><h2>VEHICLE <small>탈것</small></h2>
          <button class="btn ${s.kind === 'car' ? 'on' : ''}" data-act="kind" data-v="car"><span class="t">CAR</span><span class="k">자동차 · 그립과 드리프트</span></button>
          <button class="btn ${s.kind === 'boat' ? 'on' : ''}" data-act="kind" data-v="boat"><span class="t">BOAT</span><span class="k">보트 · 파도와 점프</span></button>
        </div>
        <div class="panel"><h2>COURSE <small>코스</small></h2>
          ${courses
            .map(
              (c) => `<button class="btn course ${c.id === s.course ? 'on' : ''}" data-act="course" data-v="${c.id}">
                <span data-thumb="${c.id}"></span>
                <span><span class="t">${c.name}</span><span class="k">${c.tagline}</span><span class="best">${bestFor(c.id)}</span></span>
              </button>`,
            )
            .join('')}
        </div>
        <div class="panel"><h2>MODE <small>모드</small></h2>
          ${MODES.map((m) => `<button class="btn ${m.id === s.mode ? 'on' : ''}" data-act="mode" data-v="${m.id}"><span class="t">${m.t}</span><span class="k">${m.k}</span></button>`).join('')}
          <button class="btn go" data-act="start">START!</button>
          <button class="btn" data-act="open-settings"><span class="t">SETTINGS</span><span class="k">화질 · 소리 · 연출</span></button>
        </div>
      </div>
      <div class="help"><kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd> 조향 &nbsp; <kbd>W</kbd> / <kbd>↑</kbd> 가속 &nbsp; <kbd>S</kbd> / <kbd>↓</kbd> 감속·후진 &nbsp; <kbd>Space</kbd> 드리프트(누른 채 코너, 떼면 부스트) &nbsp; <kbd>R</kbd> 리스폰 &nbsp; <kbd>C</kbd> 카메라 &nbsp; <kbd>Esc</kbd> 일시정지<br>
      공중에서 <kbd>S</kbd> / <kbd>↓</kbd> 기수 들기 · 메뉴도 WASD와 Space로 조작 · 게임패드 지원 · <kbd>F2</kbd> 셀셰이딩 튜닝 패널</div>`,
    );
    this.root.querySelectorAll<HTMLElement>('[data-thumb]').forEach((el) => el.replaceWith(thumb(el.dataset.thumb!)));
    const idx = this.buttons.findIndex((b) => b.dataset.act === 'start');
    this.setFocus(idx, false);
  }

  showPause() {
    this.screen = 'pause';
    this.set(
      `<div class="panel menu-col"><h2>PAUSE <small>일시정지</small></h2>
        <button class="btn" data-act="resume"><span class="t">RESUME</span><span class="k">계속 달리기</span></button>
        <button class="btn" data-act="restart"><span class="t">RESTART</span><span class="k">처음부터 다시</span></button>
        <button class="btn" data-act="open-settings"><span class="t">SETTINGS</span><span class="k">설정</span></button>
        <button class="btn" data-act="quit"><span class="t">QUIT</span><span class="k">코스 선택으로</span></button>
      </div>`,
      'dim',
    );
    this.setFocus(0, false);
  }

  showResults(race: Race, record: boolean) {
    this.screen = 'results';
    const p = race.player;
    let head: string;
    let body: string;
    if (race.mode === 'survival') {
      head = `${Math.floor(race.distance)} m`;
      body = `<p style="font-family:'Malgun Gothic';font-weight:900">버틴 시간 ${fmt(p.finishTime)} · 완주 랩 ${Math.max(0, p.lap)}</p>`;
    } else if (race.mode === 'time') {
      head = Number.isFinite(p.best) ? fmt(p.best) : 'DNF';
      body = `<table>${p.lapTimes.map((t, i) => `<tr class="${t === p.best ? 'me' : ''}"><td>LAP ${i + 1}</td><td style="text-align:right">${fmt(t)}</td></tr>`).join('')}
        <tr><td>TOTAL</td><td style="text-align:right">${fmt(p.finishTime)}</td></tr></table>`;
    } else {
      head = ['1ST', '2ND', '3RD', '4TH'][p.place - 1] + ' PLACE';
      body = `<table>${race.results
        .map(
          (r) => `<tr class="${r.player ? 'me' : ''}"><td>${r.place}</td><td><span class="swatch" style="background:${css(LIVERIES[r.livery].body)}"></span>${r.name}</td>
            <td style="text-align:right">${Number.isFinite(r.time) ? fmt(r.time) : 'RACING'}</td><td style="text-align:right;font-size:14px">BEST ${fmt(r.best)}</td></tr>`,
        )
        .join('')}</table>`;
    }
    this.set(
      `<div class="panel results" style="display:flex;flex-direction:column;align-items:center;gap:14px">
        <div class="big">${head}</div>
        ${record ? '<div class="badge">NEW RECORD!</div>' : ''}
        ${body}
        <div style="display:flex;gap:14px;width:100%">
          <button class="btn go" data-act="restart" style="font-size:24px">AGAIN</button>
          <button class="btn" data-act="quit" style="text-align:center"><span class="t">MENU</span><span class="k">코스 선택</span></button>
        </div>
      </div>`,
      'dim',
    );
    this.setFocus(0, false);
  }

  showLoading(text = '코스 그리는 중...') {
    this.screen = 'loading';
    this.set(`<div class="loading">${text}</div>`, 'dim');
  }

  showSettings() {
    this.prev = this.screen;
    this.screen = 'settings';
    const s = this.settings;
    const q = ['LOW 저', 'MID 중', 'HIGH 고'][s.quality];
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    this.set(
      `<div class="panel menu-col"><h2>SETTINGS <small>설정</small></h2>
        <button class="btn" data-act="set" data-v="quality"><span class="t">화질 · ${q}</span><span class="k">해상도 배율과 그림자 해상도</span></button>
        <button class="btn" data-act="set" data-v="shake"><span class="t">화면 흔들림 · ${s.shake ? 'ON' : 'OFF'}</span><span class="k">착지·충돌 시 카메라 흔들림</span></button>
        <button class="btn" data-act="set" data-v="lines"><span class="t">집중선 · ${s.lines ? 'ON' : 'OFF'}</span><span class="k">고속 주행 시 만화식 속도선</span></button>
        <button class="btn" data-act="set" data-v="sfx"><span class="t">효과음 · ${pct(s.sfx)}</span><span class="k">엔진, 드리프트, 충돌</span></button>
        <button class="btn" data-act="set" data-v="music"><span class="t">음악 · ${pct(s.music)}</span><span class="k">배경 루프</span></button>
        <button class="btn" data-act="set" data-v="auto"><span class="t">자동 가속 · ${s.autoThrottle ? 'ON' : 'OFF'}</span><span class="k">가속 키를 누르지 않아도 달림</span></button>
        <button class="btn go" data-act="close-settings" style="font-size:24px">OK</button>
      </div>`,
      'dim',
    );
    this.setFocus(this.lastSettingFocus, false);
  }
  private lastSettingFocus = 0;

  private act(a: string, v: string) {
    const s = this.sel;
    switch (a) {
      case 'to-select':
        this.showSelect();
        this.h.preview(s);
        break;
      case 'kind':
        if (s.kind !== v) {
          s.kind = v as VehicleKind;
          s.course = coursesFor(s.kind)[0].id;
          this.h.preview(s);
        }
        this.showSelect();
        break;
      case 'course':
        if (s.course !== v) {
          s.course = v;
          this.h.preview(s);
        }
        this.showSelect();
        this.setFocus(this.buttons.findIndex((b) => b.dataset.v === v), false);
        break;
      case 'mode':
        s.mode = v as Mode;
        this.showSelect();
        this.setFocus(this.buttons.findIndex((b) => b.dataset.v === v), false);
        break;
      case 'start':
        this.h.start({ ...s });
        break;
      case 'resume':
        this.h.resume();
        break;
      case 'restart':
        this.h.restart();
        break;
      case 'quit':
        this.h.quit();
        break;
      case 'open-settings':
        this.showSettings();
        break;
      case 'close-settings':
        if (this.prev === 'pause') this.showPause();
        else this.showSelect();
        break;
      case 'set': {
        const st = this.settings;
        if (v === 'quality') st.quality = ((st.quality + 1) % 3) as 0 | 1 | 2;
        if (v === 'shake') st.shake = !st.shake;
        if (v === 'lines') st.lines = !st.lines;
        if (v === 'sfx') st.sfx = st.sfx >= 1 ? 0 : Math.round((st.sfx + 0.2) * 10) / 10;
        if (v === 'music') st.music = st.music >= 1 ? 0 : Math.round((st.music + 0.2) * 10) / 10;
        if (v === 'auto') st.autoThrottle = !st.autoThrottle;
        this.h.settings(st);
        this.lastSettingFocus = this.focus;
        const prev = this.prev;
        this.showSettings();
        this.prev = prev;
        break;
      }
    }
  }

  /** Keyboard / gamepad edges from the Input system. Returns true if the menu consumed Esc. */
  nav(e: { up: boolean; down: boolean; left: boolean; right: boolean; confirm: boolean; back: boolean }) {
    if (this.screen === 'none' || this.screen === 'loading') return false;
    if (this.screen === 'title') {
      if (e.confirm) this.act('to-select', '');
      return false;
    }
    if (e.up || e.left) this.setFocus(this.focus - 1);
    if (e.down || e.right) this.setFocus(this.focus + 1);
    if (e.confirm && this.buttons[this.focus]) {
      const b = this.buttons[this.focus];
      this.h.sound('ui-ok');
      this.act(b.dataset.act ?? '', b.dataset.v ?? '');
    }
    if (e.back) {
      if (this.screen === 'settings') this.act('close-settings', '');
      else if (this.screen === 'pause') this.act('resume', '');
      else if (this.screen === 'select') this.showTitle();
      return true;
    }
    return false;
  }
}
