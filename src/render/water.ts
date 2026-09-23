import {
  BufferGeometry, Color, Float32BufferAttribute, GLSL3, Group, Mesh, ShaderMaterial, Texture, UniformsLib, UniformsUtils, Vector2, Vector3,
} from 'three';
import { col, type Theme } from '../tuning/palette';
import { GERSTNER_GLSL, type WaveField } from '../world/water';
import { MASK, NOISE_GLSL, toonGlobals } from './toon';

const VERT = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
${GERSTNER_GLSL}
uniform float uFadeStart;
uniform float uFadeEnd;
uniform vec3 uCamPos;
out vec2 vRest;
out vec3 vWPos;
out float vFade;
void main() {
  vec4 wr = modelMatrix * vec4(position, 1.0);
  float dist = length(wr.xz - uCamPos.xz);
  float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);
  vec3 disp; vec3 nrm; float jac;
  gerstner(wr.xz, disp, nrm, jac);
  vec3 transformed = position + disp * fade;
  vec3 objectNormal = normal;
  vec3 transformedNormal = normalMatrix * objectNormal;
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  vRest = wr.xz;
  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vFade = fade;
}
`;

const FRAG = /* glsl */ `
precision highp float;
#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
${GERSTNER_GLSL}
${NOISE_GLSL}
uniform vec3 uDeep, uMid, uLight, uFoam, uSpecCol, uHorizonCol;
uniform vec3 uSunDir, uSunColor, uShadeTint;
uniform float uMaxAmp;
uniform float uFoamAmt;
uniform sampler2D uWake;
uniform vec2 uWakeCenter;
uniform float uWakeSize;
uniform float uWakeOn;
uniform vec2 uFlow;
in vec2 vRest;
in vec3 vWPos;
in float vFade;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oNormal;

void main() {
  vec3 disp; vec3 n; float jac;
  gerstner(vRest, disp, n, jac);
  n = normalize(mix(vec3(0.0, 1.0, 0.0), n, vFade));
  jac = mix(1.0, jac, vFade);
  // animated ripple detail, only nudges the normal so bands get wobbly painted edges
  vec2 rp = vWPos.xz * 0.35 + uFlow * uTime;
  float r1 = vnoise(rp + vec2(uTime * 0.6, 0.0)) - 0.5;
  float r2 = vnoise(rp * 2.3 - vec2(0.0, uTime * 0.9)) - 0.5;
  vec3 N = normalize(n + vec3(r1, 0.0, r2) * 0.22);
  vec3 V = normalize(cameraPosition - vWPos);
  vec3 L = normalize(uSunDir);
  float h = disp.y * vFade / max(uMaxAmp, 0.05);

  float ndl = dot(N, L);
  float sh = getShadowMask();
  float tone = ndl * 0.55 + h * 0.45 + 0.25;
  tone = min(tone, mix(-0.3, 1.0, smoothstep(0.4, 0.6, sh)));
  float w = fwidth(tone) + 0.01;
  float t1 = smoothstep(0.18 - w, 0.18 + w, tone);
  float t2 = smoothstep(0.62 - w, 0.62 + w, tone);
  vec3 c = mix(uDeep, mix(uMid, uLight, t2), t1);
  c = mix(c * uShadeTint * 1.25, c, smoothstep(0.4, 0.6, sh) * 0.6 + 0.4);

  // grazing reflection band
  float fr = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  float fw = fwidth(fr) + 0.01;
  c = mix(c, mix(uLight, uHorizonCol, 0.5), smoothstep(0.55 - fw, 0.55 + fw, fr) * 0.55);

  // sparkle highlights
  vec3 H = normalize(L + V);
  float sp = pow(max(dot(N, H), 0.0), 180.0);
  float spark = step(0.55, sp) * step(0.5, sh);
  c = mix(c, uSpecCol * 1.6 * uSunColor, spark);

  // crest foam from wave compression (Jacobian) + height, broken up by noise into cel blobs
  float fn = vnoise(vWPos.xz * 0.6 + uTime * 0.3) * 0.6 + vnoise(vWPos.xz * 1.7) * 0.4;
  float crest = smoothstep(0.62, 0.3, jac) * smoothstep(0.1, 0.5, h);
  float foam = step(0.62 - crest * uFoamAmt * 0.55, fn) * step(0.05, crest);

  // wake foam: world-anchored foam map stamped by hulls, thresholded against moving noise
  if (uWakeOn > 0.5) {
    // wake camera looks down with screen-up = -Z, so texture v runs opposite to world z
    vec2 wuv = vec2((vWPos.x - uWakeCenter.x) / uWakeSize + 0.5, 0.5 - (vWPos.z - uWakeCenter.y) / uWakeSize);
    if (all(greaterThan(wuv, vec2(0.0))) && all(lessThan(wuv, vec2(1.0)))) {
      float wk = texture(uWake, wuv).r;
      float wn = vnoise(vWPos.xz * 1.1 + uTime * 0.5) * 0.55 + vnoise(vWPos.xz * 3.1 - uTime) * 0.45;
      // lacy trails, not a solid sheet: only the strongest part of the trail turns fully white
      foam = max(foam, step(1.0 - wk * 0.75, wn) * step(0.1, wk));
    }
  }
  float fedge = foam;
  c = mix(c, uFoam * mix(0.82, 1.0, step(0.5, sh)), fedge);

  oColor = vec4(c, 1.0);
  vec3 nv = normalize((viewMatrix * vec4(N, 0.0)).xyz);
  float band = foam > 0.5 ? 1.0 : mix(0.0, 1.0, t1 * 0.5 + t2 * 0.5);
  oNormal = vec4(nv.xy * 0.5 + 0.5, band, ${MASK.water.toFixed(2)});
}
`;

function gridGeom(half: number, spacing: number, hole: number) {
  const n = Math.round((half * 2) / spacing);
  const pos: number[] = [];
  const idx: number[] = [];
  const nrm: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      pos.push(-half + i * spacing, 0, -half + j * spacing);
      nrm.push(0, 1, 0);
    }
  }
  const row = n + 1;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -half + i * spacing, z0 = -half + j * spacing;
      const x1 = x0 + spacing, z1 = z0 + spacing;
      if (hole > 0 && x0 >= -hole && x1 <= hole && z0 >= -hole && z1 <= hole) continue;
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

export interface WaterView {
  group: Group;
  material: ShaderMaterial;
  update(camPos: Vector3, time: number): void;
  setWake(tex: Texture, center: Vector2, size: number): void;
}

/**
 * Camera-following nested grids. All levels snap to the coarsest spacing, which is a multiple of every
 * finer spacing, so vertices always land on the same world lattice: no wave swimming, holes line up.
 */
export function makeWater(
  t: Theme, field: WaveField, opts: { fadeStart?: number; fadeEnd?: number; flow?: [number, number]; level?: number } = {},
): WaterView {
  const level = opts.level ?? 0;
  const uniforms = UniformsUtils.merge([
    UniformsLib.lights,
    {
      uWaveA: { value: field.uA },
      uWaveB: { value: field.uB },
      uWaveCount: { value: field.n },
      uTime: { value: 0 },
      uFadeStart: { value: opts.fadeStart ?? 260 },
      uFadeEnd: { value: opts.fadeEnd ?? 700 },
      uCamPos: { value: new Vector3() },
      uDeep: { value: new Color().copy(col(t.water.deep)) },
      uMid: { value: new Color().copy(col(t.water.mid)) },
      uLight: { value: new Color().copy(col(t.water.light)) },
      uFoam: { value: new Color().copy(col(t.water.foam)) },
      uSpecCol: { value: new Color().copy(col(t.water.spec)) },
      uHorizonCol: { value: new Color().copy(col(t.sky.horizon)) },
      uMaxAmp: { value: field.maxAmp },
      uFoamAmt: { value: 1 },
      uWake: { value: null },
      uWakeCenter: { value: new Vector2() },
      uWakeSize: { value: 1 },
      uWakeOn: { value: 0 },
      uFlow: { value: new Vector2(...(opts.flow ?? [0, 0])) },
    },
  ]);
  uniforms.uWaveA.value = field.uA;
  uniforms.uWaveB.value = field.uB;
  uniforms.uSunDir = toonGlobals.uSunDir;
  uniforms.uSunColor = toonGlobals.uSunColor;
  uniforms.uShadeTint = toonGlobals.uShadeTint;
  const material = new ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, lights: true, glslVersion: GLSL3 });
  const group = new Group();
  const levels: [number, number, number][] = [
    [100, 1, 0],
    [400, 4, 96],
    [1600, 16, 384],
  ];
  const SNAP = 16;
  for (const [half, sp, hole] of levels) {
    const m = new Mesh(gridGeom(half, sp, hole), material);
    m.frustumCulled = false;
    m.receiveShadow = true;
    group.add(m);
  }
  return {
    group,
    material,
    update(camPos, time) {
      group.position.set(Math.round(camPos.x / SNAP) * SNAP, level, Math.round(camPos.z / SNAP) * SNAP);
      uniforms.uTime.value = time;
      uniforms.uCamPos.value.copy(camPos);
      uniforms.uWaveCount.value = field.n;
      uniforms.uMaxAmp.value = field.maxAmp;
    },
    setWake(tex, center, size) {
      uniforms.uWake.value = tex;
      uniforms.uWakeCenter.value.copy(center);
      uniforms.uWakeSize.value = size;
      uniforms.uWakeOn.value = 1;
    },
  };
}
