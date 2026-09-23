import GUI from 'lil-gui';
import { toonGlobals } from '../render/toon';
import { RENDER } from '../tuning/params';

let gui: GUI | null = null;

/** F2: live cel-shading tuning (the design doc's #1 risk is a half-baked look, so every knob is exposed). */
export function toggleTuning(stats: { fps: number }) {
  if (gui) {
    gui.destroy();
    gui = null;
    return;
  }
  gui = new GUI({ title: 'CEL RUSH 튜닝 (F2)' });
  gui.add(stats, 'fps').listen().disable();
  const ink = gui.addFolder('아웃라인');
  ink.add(RENDER, 'outlines').name('켜기');
  ink.add(RENDER, 'outlineWidth', 0.4, 3.5, 0.05).name('두께');
  ink.add(RENDER, 'depthThreshold', 0.01, 0.4, 0.005).name('깊이 임계');
  ink.add(RENDER, 'normalThreshold', -0.2, 0.95, 0.01).name('노멀 임계(내적)');
  const light = gui.addFolder('계단식 라이팅');
  light.add(RENDER, 'band1', -0.2, 0.95, 0.01).name('명부 경계').onChange((v: number) => (toonGlobals.uBand1.value = v));
  light.add(RENDER, 'band2', -0.6, 0.6, 0.01).name('암부 경계').onChange((v: number) => (toonGlobals.uBand2.value = v));
  light.add(RENDER, 'rimStrength', 0, 1.5, 0.01).name('림 라이트').onChange((v: number) => (toonGlobals.uRimStrength.value = v));
  const ht = gui.addFolder('하프톤');
  ht.add(RENDER, 'halftone').name('켜기');
  ht.add(RENDER, 'halftoneScale', 2, 14, 0.1).name('점 간격(px)');
  ht.add(RENDER, 'halftoneStrength', 0, 1, 0.01).name('강도');
  const bl = gui.addFolder('블룸 · 속도선');
  bl.add(RENDER, 'bloomStrength', 0, 2.5, 0.01).name('블룸 강도');
  bl.add(RENDER, 'bloomThreshold', 0.4, 2, 0.01).name('블룸 임계');
  bl.add(RENDER, 'speedLines', 0, 2, 0.01).name('집중선');
}
