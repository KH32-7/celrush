import './ui/style.css';
import { Quaternion, Vector3 } from 'three';
import { AudioSys } from './audio/audio';
import { ChaseCamera, type CamMode } from './camera/chase';
import { emptyControls, Input } from './core/input';
import { FixedLoop } from './core/loop';
import { clamp, damp } from './core/math';
import { VehicleFx } from './fx/vehicleFx';
import { Race, type Mode } from './game/race';
import { Pipeline } from './render/pipeline';
import { toonGlobals } from './render/toon';
import { buildWorld, type World } from './scene/world';
import { courseById, coursesFor } from './track/courses';
import { col, FX, UI } from './tuning/palette';
import { BOAT, CAR, RENDER } from './tuning/params';
import { Boat } from './vehicles/boat';
import { Car } from './vehicles/car';
import { Surface } from './world/ground';
import { Hud, type HudState } from './ui/hud';
import { applyCssPalette, Menu, type Selection } from './ui/menu';
import { loadSettings, saveBest, saveSettings } from './ui/settings';
import { toggleTuning } from './ui/tuning';

applyCssPalette();
const params = new URLSearchParams(location.search);
const settings = loadSettings();
const gameCanvas = document.getElementById('game') as HTMLCanvasElement;
const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;
const pipeline = new Pipeline(gameCanvas);
const input = new Input();
input.autoThrottle = settings.autoThrottle;
const audio = new AudioSys();
audio.setVolumes(settings.sfx, settings.music);
const hud = new Hud(hudCanvas);
const camera = new ChaseCamera(innerWidth / innerHeight);
camera.shakeScale = settings.shake ? 1 : 0;

let world: World | null = null;
let race: Race | null = null;
let fx: VehicleFx | null = null;
type Phase = 'title' | 'select' | 'race' | 'paused' | 'results';
let phase: Phase = 'title';
let attractIdx = 0;
let attractT = 0;
let finishT = 0;
let boostVis = 0;
let lightningT = 4;
let flash = 0;
let invert = 0;
let lastSel: Selection = { kind: 'car', course: 'harbor', mode: 'race' };
const stats = { fps: 0 };
let fpsAcc = 0;
let fpsN = 0;
const camModes: CamMode[] = ['chase', 'near', 'hood'];
let camModeI = 0;
const playerControls = emptyControls();

try {
  const s = localStorage.getItem('celrush.sel');
  if (s) lastSel = { ...lastSel, ...(JSON.parse(s) as Selection) };
} catch {
  /* ignore */
}

function applyQuality() {
  const caps = [1, 1.5, 2];
  RENDER.pixelRatioCap = caps[settings.quality];
  RENDER.shadowMapSize = settings.quality === 0 ? 1024 : 2048;
  resize();
}

function resize() {
  const pr = Math.min(window.devicePixelRatio || 1, RENDER.pixelRatioCap);
  pipeline.setSize(innerWidth, innerHeight, pr);
  camera.cam.aspect = innerWidth / innerHeight;
  camera.cam.updateProjectionMatrix();
  hud.resize();
}
window.addEventListener('resize', resize);

function applyTheme(w: World) {
  const t = w.theme;
  const u = pipeline.mComp.uniforms;
  u.uInk.value.copy(col(t.ink));
  u.uFog.value.copy(col(t.fog));
  u.uFogStart.value = t.fogStart;
  u.uFogEnd.value = t.fogEnd;
  const f = pipeline.mFinal.uniforms;
  f.uSat.value = t.grade.saturation;
  f.uContrast.value = t.grade.contrast;
  f.uLift.value = t.grade.lift;
  f.uVignette.value = t.grade.vignette;
  f.uInk.value.copy(col(t.ink));
  f.uRain.value = t.id === 'storm' ? 1 : 0;
  f.uRainColor.value.copy(col(FX.rain));
  f.uFlashColor.value.copy(col(FX.lightning));
}

const hooks = {
  msg: (t: string, c: number, big?: boolean) => {
    if (phase === 'race' || phase === 'results') hud.message(t, c, big);
  },
  sound: (n: string, v?: number) => {
    if (phase !== 'race' && phase !== 'results') return;
    if (n === 'boost') audio.play('boost');
    else if (n === 'count') audio.play('count');
    else audio.play(n, v);
  },
};

function setCourse(id: string) {
  if (world && world.def.id === id) return;
  race?.dispose();
  race = null;
  world?.dispose();
  world = buildWorld(courseById(id), pipeline.renderer);
  fx = new VehicleFx(world.scene, world);
  hud.setTrack(world.track);
  applyTheme(world);
  camera.snap();
}

function startAttract() {
  if (!world) return;
  race?.dispose();
  fx?.clear();
  race = new Race(world, 'race', hooks, { attract: true });
  attractIdx = 0;
  attractT = 0;
  camera.mode = 'chase';
  camera.snap();
}

function startRace(sel: Selection) {
  lastSel = { ...sel };
  try {
    localStorage.setItem('celrush.sel', JSON.stringify(lastSel));
  } catch {
    /* ignore */
  }
  setCourse(sel.course);
  race?.dispose();
  fx?.clear();
  race = new Race(world!, sel.mode, hooks);
  race.autodrive = params.get('auto') === '1';
  camera.mode = camModes[camModeI];
  camera.snap();
  camera.startIntro();
  hud.clearMessages();
  phase = 'race';
  finishT = 0;
  menu.hide();
  audio.init();
  audio.start(world!.def.vehicle, world!.theme.id === 'storm');
  audio.startMusic();
}

const menu = new Menu(
  document.getElementById('ui')!,
  {
    preview(sel) {
      lastSel = { ...lastSel, ...sel };
      setCourse(sel.course);
      startAttract();
    },
    start: (sel) => startRace(sel),
    resume() {
      phase = 'race';
      menu.hide();
    },
    restart() {
      startRace(lastSel);
    },
    quit() {
      phase = 'select';
      audio.stopLoops();
      startAttract();
      menu.showSelect();
    },
    settings(s) {
      saveSettings(s);
      input.autoThrottle = s.autoThrottle;
      camera.shakeScale = s.shake ? 1 : 0;
      audio.setVolumes(s.sfx, s.music);
      applyQuality();
    },
    sound(n) {
      audio.init();
      audio.play(n);
      audio.startMusic();
    },
  },
  settings,
  lastSel,
);

const unlock = () => {
  audio.init();
  audio.startMusic();
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

// ------------------------------------------------------------------ simulation

let debugFreeze = false;

function simUpdate(dt: number) {
  if (!race || debugFreeze) return;
  if (phase === 'paused' || phase === 'select' || phase === 'title') {
    if (race.attract && phase !== 'paused') race.step(dt, playerControls);
    return;
  }
  input.read(dt, playerControls);
  race.step(dt, playerControls);
}

const loop = new FixedLoop(simUpdate, (alpha, frameDt) => render(alpha, frameDt));

// ------------------------------------------------------------------ frame

const _pos = new Vector3();
const _q = new Quaternion();
const _f = new Vector3();
const _u = new Vector3();

function focusRacer() {
  if (!race) return null;
  if (race.attract) return race.racers[attractIdx % race.racers.length];
  return race.player;
}

function handleEdges() {
  const nav = {
    up: input.consume('up'), down: input.consume('down'), left: input.consume('left'), right: input.consume('right'),
    confirm: input.consume('confirm'), back: false,
  };
  const esc = input.consume('pause');
  if (input.consume('tuning')) toggleTuning(stats);
  if (phase === 'race') {
    if (esc) {
      phase = 'paused';
      menu.showPause();
      return;
    }
    if (input.consume('respawn') && race && race.state === 'racing' && !race.player.finished) race.respawn(race.player);
    if (input.consume('camera')) {
      camModeI = (camModeI + 1) % camModes.length;
      camera.mode = camModes[camModeI];
    }
    return;
  }
  nav.back = esc || input.consume('back');
  menu.nav(nav);
  if (phase === 'paused' && menu.screen === 'none') phase = 'race';
  input.consume('respawn');
  input.consume('camera');
}

function render(alpha: number, dt: number, draw = true) {
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    stats.fps = Math.round(fpsN / fpsAcc);
    fpsAcc = 0;
    fpsN = 0;
  }
  handleEdges();
  if (menu.screen === 'select' && phase !== 'select') phase = 'select';
  if (!world || !race) {
    hud.draw(null, dt);
    return;
  }
  const paused = phase === 'paused';
  for (const r of race.racers) r.sync(alpha, dt);

  // attract mode cycles through the pack
  if (race.attract) {
    attractT += dt;
    if (attractT > 9) {
      attractT = 0;
      attractIdx++;
      camera.snap();
    }
  }
  const fr = focusRacer()!;
  const v = fr.vehicle;
  v.pose(alpha, _pos, _q);
  const top = v.kind === 'car' ? CAR.topSpeed : BOAT.topSpeed;
  const airborne = v instanceof Car ? v.contacts === 0 : !(v as Boat).grounded;
  const groundAt = (x: number, z: number) =>
    world!.env.ground ? world!.env.ground.heightAt(x, z, v.proj.idx) : world!.field ? world!.field.heightAt(x, z) : 0;
  camera.update(dt, {
    pos: _pos, quat: _q, vel: v.body.vel, speed: v.speed, topSpeed: top, kind: v.kind, boosting: v.drift.boosting,
    driftDir: v.drift.active ? v.drift.dir : 0, airborne,
  }, groundAt);

  // one-shot events -> audio, camera, HUD
  if (!race.attract && !paused) {
    const e = v.events;
    if (e.boost) {
      audio.play('boost');
      camera.kick(9);
      camera.shake(0.18);
      hud.message(['', 'MINI BOOST', 'SUPER BOOST!', 'ULTRA BOOST!!'][e.boost] || 'BOOST!', FX.spark[Math.max(0, e.boost - 1)]);
    }
    if (e.stageUp) audio.play('stage', e.stageUp);
    if (e.driftStart) audio.play('drift');
    if (e.padHit) camera.kick(6);
    if (e.landed > 3) {
      audio.play(v.kind === 'boat' ? 'splash' : 'land', e.landed);
      camera.shake(Math.min(0.55, e.landed * 0.05));
    }
    if (e.cleanLanding) {
      hud.message('NICE LANDING!', UI.good);
      audio.play('land-good');
    }
    if (e.wallHit > 2) {
      audio.play('hit', e.wallHit);
      camera.shake(Math.min(0.6, e.wallHit * 0.06));
    }
    if (e.splash > 5 && v.kind === 'boat') {
      audio.play('splash', e.splash * 0.5);
      camera.shake(Math.min(0.3, e.splash * 0.02));
    }
    for (const r of race.racers) {
      if (r === fr) continue;
      if (r.vehicle.events.wallHit > 3 && r.vehicle.body.pos.distanceTo(_pos) < 30) audio.play('hit', r.vehicle.events.wallHit * 0.4);
    }
  }
  if (!paused) fx?.update(dt, race.racers, camera.cam.position);
  for (const r of race.racers) r.vehicle.clearEvents();

  const camPos = camera.cam.position;
  world.update(dt, world.env.time, _pos, camPos);
  toonGlobals.uTime.value = world.env.time;
  if (world.theme.night) {
    v.forward(_f);
    v.up(_u);
    toonGlobals.uHeadPos.value.copy(_pos).addScaledVector(_f, 2.2).addScaledVector(_u, 0.2);
    toonGlobals.uHeadDir.value.copy(_f).addScaledVector(_u, -0.12).normalize();
  }

  // post uniforms
  const f = pipeline.mFinal.uniforms;
  const sn = clamp((v.speed - top * 0.5) / (top * 0.5), 0, 1.2);
  f.uSpeed.value = settings.lines ? sn * (phase === 'race' ? 1 : 0.4) : 0;
  boostVis = damp(boostVis, v.drift.boosting ? 1 : 0, 6, dt);
  f.uBoost.value = boostVis * (settings.lines ? 1 : 0.4);
  f.uTime.value = world.env.time;
  if (world.theme.id === 'storm' && !paused) {
    lightningT -= dt;
    if (lightningT <= 0) {
      lightningT = 7 + Math.random() * 9;
      flash = 0.75;
      if (Math.random() < 0.35) invert = 0.07;
      audio.play('thunder', 0.3 + Math.random() * 0.9);
    }
  }
  flash = Math.max(0, flash - dt * 3.2);
  invert = Math.max(0, invert - dt);
  f.uFlash.value = flash * 0.55;
  f.uInvert.value = invert > 0 ? 1 : 0;
  (world.sky.material as unknown as { uniforms: Record<string, { value: number }> }).uniforms.uFlash.value = flash * 0.6;

  // gate countdown bulbs
  const bulbs = world.gate.userData.bulbs as { material: { uniforms: Record<string, { value: number }> } }[];
  if (bulbs) {
    const cd = race.countdown;
    const lit = race.state === 'countdown' && cd ? 3 - cd.n + 1 : race.state === 'racing' ? 3 : 0;
    bulbs.forEach((b, i) => (b.material.uniforms.uEmissiveBoost.value = i < lit ? 2.6 : 0.35));
  }

  if (draw) pipeline.render(world.scene, camera.cam);

  // HUD
  const showRace = phase === 'race' || phase === 'paused';
  let hs: HudState | null = null;
  if (showRace || phase === 'results') {
    const p = race.player;
    const pv = p.vehicle;
    hs = {
      kind: pv.kind, mode: race.mode, speed: pv.speed * 3.6, rpm: pv.rpm,
      boostFrac: pv.drift.boosting ? pv.drift.boostTime / pv.drift.boostMax : 0, boosting: pv.drift.boosting,
      drift: { active: pv.drift.active, stage: pv.drift.stage, frac: pv.drift.chargeFrac },
      lap: clamp(p.lap + 1, 1, race.laps), laps: race.laps, place: p.place, count: race.racers.length,
      time: race.clock, lapTime: race.state === 'racing' ? race.clock - p.lapStart : 0, best: p.best,
      countdown: race.countdown, survival: race.mode === 'survival' ? race.survivalLeft : null, distance: race.distance,
      wrongWay: p.wrongT > 1.2 && race.state === 'racing',
      racers: race.racers.map((r) => ({ x: r.vehicle.body.pos.x, z: r.vehicle.body.pos.z, player: r.isPlayer, livery: r.livery })),
      showRace: showRace && race.state !== 'intro',
    };
  }
  if (draw) hud.draw(hs, paused ? 0 : dt);

  // audio
  const offroad = v instanceof Car && (v.surface === Surface.Runoff || v.surface === Surface.Dirt);
  audio.update({
    rpm: v.rpm, throttle: v.controls.throttle, speed: v.speed, skid: v.skid, offroad,
    wet: v instanceof Boat ? v.wetRatio : 0, boost: v.drift.boosting, airborne,
  }, paused || phase !== 'race');

  // finish -> results
  if (phase === 'race' && race.state === 'finished') {
    finishT += dt;
    if (finishT > 3.2) {
      phase = 'results';
      const p = race.player;
      let rec = false;
      if (race.mode === 'survival') rec = saveBest(world.def.id, 'survival', race.distance);
      else if (race.mode === 'time' && Number.isFinite(p.best)) rec = saveBest(world.def.id, 'time', p.best);
      else if (race.mode === 'race' && p.finished) rec = saveBest(world.def.id, 'race', p.finishTime);
      menu.showResults(race, rec || race.newRecord);
    }
  }
}

// ------------------------------------------------------------------ boot

applyQuality();
const autostart = params.get('course');
if (autostart) {
  const def = courseById(autostart);
  lastSel = { kind: def.vehicle, course: def.id, mode: (params.get('mode') as Mode) || 'race' };
  startRace(lastSel);
} else {
  const kind = lastSel.kind;
  const course = coursesFor(kind).some((c) => c.id === lastSel.course) ? lastSel.course : coursesFor(kind)[0].id;
  setCourse(course);
  startAttract();
  menu.showTitle();
}
loop.start();

// debug / verification handle
(window as unknown as Record<string, unknown>).__celrush = {
  get race() { return race; },
  get world() { return world; },
  get phase() { return phase; },
  pipeline, camera, stats, RENDER,
  setAuto(on: boolean) { if (race) race.autodrive = on; },
  /** freeze the simulation (camera/FX keep running) to inspect models with the orbit camera */
  set freeze(on: boolean) { debugFreeze = on; },
  get freeze() { return debugFreeze; },
  /** Step the game synchronously (60 Hz frames, 120 Hz physics) and draw the last frame.
   *  Verification hook: independent of rAF throttling in background tabs. */
  advance(seconds: number) {
    const frames = Math.max(1, Math.round(seconds * 60));
    for (let f = 0; f < frames; f++) {
      simUpdate(1 / 120);
      simUpdate(1 / 120);
      render(1, 1 / 60, f === frames - 1);
    }
    return race ? { state: race.state, clock: +race.clock.toFixed(2) } : null;
  },
};
