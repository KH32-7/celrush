import { Color, DoubleSide, FrontSide, GLSL3, ShaderMaterial, UniformsLib, UniformsUtils, Vector3, type Side } from 'three';
import { col } from '../tuning/palette';
import { RENDER } from '../tuning/params';

/**
 * Outline classes written to the normal buffer's alpha. The composite pass reads them to decide
 * which edges to draw and where halftone applies.
 */
export const MASK = {
  sky: 0.0,
  particle: 0.25,
  water: 0.5,
  emissive: 0.75,
  /** far scenery (clouds, backdrop ridges): outlined but only lightly fogged */
  backdrop: 0.9,
  solid: 1.0,
} as const;

/** Uniforms shared by every toon material (one object, referenced by all). */
export const toonGlobals = {
  uSunDir: { value: new Vector3(0.4, 0.8, 0.3).normalize() },
  uSunColor: { value: new Color(1, 1, 1) },
  uShadeTint: { value: new Color(0.45, 0.5, 0.75) },
  uRimColor: { value: new Color(1, 1, 1) },
  uBand1: { value: RENDER.band1 },
  uBand2: { value: RENDER.band2 },
  uRimStrength: { value: RENDER.rimStrength },
  uTime: { value: 0 },
  uNight: { value: 0 },
  uHeadPos: { value: new Vector3() },
  uHeadDir: { value: new Vector3(0, 0, -1) },
  uHeadColor: { value: new Color(1, 1, 0.9) },
  uHeadOn: { value: 0 },
};

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
`;

const VERT = /* glsl */ `
#include <common>
#include <color_pars_vertex>
#include <shadowmap_pars_vertex>
out vec3 vWPos;
out vec3 vWNormal;
out vec3 vVNormal;
out vec2 vUv;
#ifdef WIND
uniform float uTime;
#endif
void main() {
  #include <color_vertex>
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #ifdef WIND
    // foliage sway, stronger toward the top of the mesh
    float sway = sin(uTime * 1.7 + (instanceMatrix[3].x + instanceMatrix[3].z) * 0.21) * 0.06 * max(position.y, 0.0);
    transformed.x += sway;
    transformed.z += sway * 0.6;
  #endif
  #include <project_vertex>
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  vec4 wp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
  #endif
  wp = modelMatrix * wp;
  vWPos = wp.xyz;
  vVNormal = normalize(transformedNormal);
  vWNormal = normalize((vec4(transformedNormal, 0.0) * viewMatrix).xyz);
  vUv = uv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
#include <common>
#include <packing>
#include <color_pars_fragment>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

uniform vec3 uColor;
uniform vec3 uEmissive;
uniform float uSpec;
uniform float uGloss;
uniform float uRimAmt;
uniform float uMask;
uniform float uUnlit;
uniform float uGhost;
uniform float uEmissiveBoost;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShadeTint;
uniform vec3 uRimColor;
uniform float uBand1;
uniform float uBand2;
uniform float uRimStrength;
uniform float uTime;
uniform float uNight;
uniform vec3 uHeadPos;
uniform vec3 uHeadDir;
uniform vec3 uHeadColor;
uniform float uHeadOn;

in vec3 vWPos;
in vec3 vWNormal;
in vec3 vVNormal;
in vec2 vUv;

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oNormal;

${NOISE_GLSL}

#ifdef PATTERN
uniform vec3 uPA;
uniform vec3 uPB;
uniform vec3 uPC;
uniform vec3 uPD;
uniform vec3 uPE;
uniform vec3 uPF;
uniform vec4 uPParams;
#endif

float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[idx] + 0.5) / 16.0;
}

void main() {
  if (uGhost > 0.0 && bayer4(gl_FragCoord.xy) > uGhost) discard;

  vec3 base = uColor;
  #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
    base *= vColor.rgb; // r186 declares vColor as vec4
  #endif
  float glow = 0.0;
  float noHalftone = 0.0;

  #ifdef ROAD
  {
    // uv.x = lateral offset d (m), uv.y = arc length s (m). uPParams = (halfWidth, curb, lapLength, lampSpacing)
    float d = vUv.x, s = vUv.y, ad = abs(d);
    float hw = uPParams.x, curb = uPParams.y;
    float aa = fwidth(ad) * 1.2 + 0.01;
    // asphalt: two tones in large soft-edged patches, the cel way to suggest wear
    float wear = fbm(vec2(s * 0.035, d * 0.09)); // "patch" is reserved in GLSL ES 3.0
    base = mix(uPA, uPB, step(0.56, wear));
    // edge lines
    float edge = smoothstep(hw - 0.62 - aa, hw - 0.62 + aa, ad) * (1.0 - smoothstep(hw - 0.3 - aa, hw - 0.3 + aa, ad));
    // center dashes
    float dash = step(fract(s / 11.0), 0.5) * (1.0 - smoothstep(0.14 - aa, 0.14 + aa, ad));
    // lane dashes at +-hw/3
    float lane = step(fract(s / 11.0 + 0.5), 0.4) * (1.0 - smoothstep(0.1 - aa, 0.1 + aa, abs(ad - hw / 3.0)));
    base = mix(base, uPC, max(edge, lane));
    base = mix(base, uPD, dash);
    if (ad > hw) {
      float stripe = step(0.5, fract(s / 4.0));
      base = mix(uPE, uPC, stripe);
    }
    if (ad > hw + curb) {
      float g = fbm(vec2(s * 0.12, d * 0.4));
      base = uPF * mix(0.9, 1.06, step(0.5, g));
    }
    // start/finish checker
    float ss = mod(s + 1.5, uPParams.z);
    if (ss < 3.0 && ad < hw) {
      vec2 ck = floor(vec2(d, s) / 1.0);
      base = mix(vec3(0.95), vec3(0.06), mod(ck.x + ck.y, 2.0));
    }
    // night: street lamp pools every lampSpacing meters, alternating sides
    if (uNight > 0.5 && uPParams.w > 0.0) {
      float ls = mod(s, uPParams.w) - uPParams.w * 0.5;
      float side = mod(floor(s / uPParams.w), 2.0) * 2.0 - 1.0;
      vec2 lp = vec2(ls, d - side * (hw + 0.5));
      float pool = 1.0 - smoothstep(6.5, 7.0, length(lp * vec2(0.8, 1.0)));
      glow += pool * 0.55;
    }
  }
  #endif

  #ifdef BUILDING
  {
    // procedural windows on vertical faces; uPParams.x = floor height, y = column width
    vec3 n = normalize(vWNormal);
    if (abs(n.y) < 0.5) {
      float u = abs(n.x) > abs(n.z) ? vWPos.z : vWPos.x;
      vec2 cell = vec2(u / uPParams.y, (vWPos.y - 0.6) / uPParams.x);
      vec2 f = fract(cell);
      float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.78) * step(1.0, cell.y);
      float r = hash12(floor(cell) + floor(vWPos.xz * 0.05));
      vec3 wc = uPA;
      if (uNight > 0.5 && r > 0.45) { wc = uPB; glow += win * 0.9; }
      else if (r > 0.82) wc = mix(uPA, vec3(1.0), 0.35);
      base = mix(base, wc, win);
    } else {
      base *= 0.82;
    }
  }
  #endif

  #ifdef PAD
  {
    // animated chevrons, uv.y along travel
    float x = abs(vUv.x - 0.5) * 2.0;
    float v = fract(vUv.y * 3.0 + x * 0.55 - uTime * 2.6);
    float arrow = step(v, 0.42);
    base = mix(uPA, uPB, arrow);
    glow += 0.6 + arrow * 1.2;
    noHalftone = 1.0;
  }
  #endif

  #ifdef CHECKER
  {
    vec2 ck = floor(vUv * uPParams.xy);
    base = mix(uPA, uPB, mod(ck.x + ck.y, 2.0));
  }
  #endif

  #ifdef STRIPES
  {
    float st = step(0.5, fract((vUv.x + vUv.y) * uPParams.x));
    base = mix(uPA, uPB, st);
  }
  #endif

  #ifdef TERRAIN
  {
    float g = fbm(vWPos.xz * 0.045);
    base *= mix(0.9, 1.05, step(0.52, g));
  }
  #endif

  vec3 N = normalize(vWNormal);
  vec3 NV = normalize(vVNormal);
  if (!gl_FrontFacing) { N = -N; NV = -NV; }
  vec3 V = normalize(cameraPosition - vWPos);

  vec3 color;
  float band;
  if (uUnlit > 0.5) {
    color = base * (1.0 + glow) * uEmissiveBoost + uEmissive;
    band = 1.0;
    noHalftone = 1.0;
  } else {
    float ndl = dot(N, uSunDir);
    float sh = getShadowMask();
    float light = min(ndl, mix(-0.25, 1.0, smoothstep(0.4, 0.6, sh)));
    float w = fwidth(light) * 0.75 + 0.004;
    float b1 = smoothstep(uBand1 - w, uBand1 + w, light);
    float b2 = smoothstep(uBand2 - w, uBand2 + w, light);
    vec3 dark = base * uShadeTint;
    vec3 mid = base * mix(uShadeTint, vec3(1.0), 0.62) * mix(vec3(1.0), uSunColor, 0.5);
    vec3 lit = base * uSunColor;
    color = mix(dark, mix(mid, lit, b1), b2);

    // hard specular highlight band (car paint, wet rock)
    vec3 H = normalize(uSunDir + V);
    float sp = pow(max(dot(N, H), 0.0), uGloss);
    float spw = fwidth(sp) + 0.02;
    color += uSunColor * uSpec * smoothstep(0.55 - spw, 0.55 + spw, sp) * b2;

    // rim light: thin bright band on the silhouette, strongest on the lit side
    float fr = 1.0 - max(dot(N, V), 0.0);
    float rw = fwidth(fr) + 0.015;
    float rim = smoothstep(0.7 - rw, 0.7 + rw, fr) * uRimAmt * uRimStrength;
    rim *= 0.45 + 0.55 * smoothstep(-0.2, 0.3, dot(N, uSunDir) + 0.25);
    color = mix(color, uRimColor * mix(vec3(1.0), base, 0.35) * 1.25, rim);

    // fake headlight cone (night)
    if (uHeadOn > 0.0) {
      vec3 toP = vWPos - uHeadPos;
      float dist = length(toP);
      float cone = dot(toP / max(dist, 0.001), uHeadDir);
      float hl = smoothstep(0.86, 0.9, cone) * (1.0 - smoothstep(34.0, 40.0, dist)) * step(1.5, dist);
      color += base * uHeadColor * hl * 0.9 * uHeadOn;
    }
    color += base * glow * vec3(1.0, 0.92, 0.7);
    color += uEmissive;
    band = mix(0.0, 0.5, b2) + 0.5 * b1;
  }
  oColor = vec4(color, 1.0);
  oNormal = vec4(NV.xy * 0.5 + 0.5, noHalftone > 0.5 ? 1.0 : band, uMask);
}
`;

export interface ToonOpts {
  color?: number;
  vertexColors?: boolean;
  emissive?: number;
  emissiveScale?: number;
  spec?: number;
  gloss?: number;
  rim?: number;
  mask?: number;
  unlit?: boolean;
  emissiveBoost?: number;
  side?: Side;
  defines?: Record<string, string | number | boolean>;
  pattern?: { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number; params?: [number, number, number, number] };
  ghost?: number;
}

export type ToonMaterial = ShaderMaterial;

export function makeToon(o: ToonOpts = {}): ToonMaterial {
  const uniforms = UniformsUtils.merge([
    UniformsLib.lights,
    {
      uColor: { value: new Color().copy(col(o.color ?? 0xffffff)) },
      uEmissive: { value: new Color().copy(col(o.emissive ?? 0x000000)).multiplyScalar(o.emissiveScale ?? 1) },
      uSpec: { value: o.spec ?? 0 },
      uGloss: { value: o.gloss ?? 40 },
      uRimAmt: { value: o.rim ?? 1 },
      uMask: { value: o.mask ?? MASK.solid },
      uUnlit: { value: o.unlit ? 1 : 0 },
      uEmissiveBoost: { value: o.emissiveBoost ?? 1 },
      uGhost: { value: o.ghost ?? 0 },
      uPA: { value: new Color() }, uPB: { value: new Color() }, uPC: { value: new Color() },
      uPD: { value: new Color() }, uPE: { value: new Color() }, uPF: { value: new Color() },
      uPParams: { value: [0, 0, 0, 0] },
    },
  ]);
  // shared globals by reference so one write updates every material
  Object.assign(uniforms, toonGlobals);
  const defines: Record<string, string | number | boolean> = { ...(o.defines ?? {}) };
  if (o.pattern) {
    defines.PATTERN = 1;
    const p = o.pattern;
    if (p.a !== undefined) uniforms.uPA.value.copy(col(p.a));
    if (p.b !== undefined) uniforms.uPB.value.copy(col(p.b));
    if (p.c !== undefined) uniforms.uPC.value.copy(col(p.c));
    if (p.d !== undefined) uniforms.uPD.value.copy(col(p.d));
    if (p.e !== undefined) uniforms.uPE.value.copy(col(p.e));
    if (p.f !== undefined) uniforms.uPF.value.copy(col(p.f));
    if (p.params) uniforms.uPParams = { value: p.params } as any;
  }
  const m = new ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    lights: true,
    vertexColors: !!o.vertexColors,
    side: o.side ?? FrontSide,
    glslVersion: GLSL3,
    defines,
  });
  if (o.side === DoubleSide) m.side = DoubleSide;
  return m;
}
