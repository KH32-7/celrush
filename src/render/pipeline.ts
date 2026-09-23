import {
  Camera, Color, DepthTexture, GLSL3, HalfFloatType, LinearFilter, Mesh, NearestFilter, OrthographicCamera, PerspectiveCamera,
  PlaneGeometry, Scene, ShaderMaterial, Vector2, WebGLRenderer, WebGLRenderTarget, type IUniform,
} from 'three';
import { RENDER } from '../tuning/params';
import { NOISE_GLSL } from './toon';

const FS_VERT = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function pass(frag: string, uniforms: Record<string, IUniform>) {
  return new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: FS_VERT,
    fragmentShader: 'precision highp float;\nin vec2 vUv;\nlayout(location = 0) out vec4 fragColor;\n' + frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

const COMPOSITE = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uNear, uFar;
uniform float uWidth, uDepthTh, uNormalTh, uOutlines;
uniform vec3 uInk;
uniform vec3 uFog;
uniform float uFogStart, uFogEnd;
uniform float uHtScale, uHtStrength, uHalftone;
uniform float uPx;

float lin(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
vec3 decodeN(vec4 t) {
  vec2 xy = t.xy * 2.0 - 1.0;
  return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}

void main() {
  vec2 px = 1.0 / uRes;
  vec3 c = texture(tColor, vUv).rgb;
  vec4 nt = texture(tNormal, vUv);
  float m0 = nt.a;
  float rawD = texture(tDepth, vUv).r;
  float d0 = lin(rawD);
  vec3 n0 = decodeN(nt);
  bool sky = m0 < 0.1;

  float edge = 0.0;
  if (uOutlines > 0.5 && !sky) {
    // line width in device pixels; thinner with distance so far detail doesn't turn to mush
    float w = uWidth * uPx * mix(1.0, 0.6, smoothstep(25.0, 350.0, d0));
    float facing = max(n0.z, 0.08);
    float th = uDepthTh * (1.0 + 0.5 / facing);
    if (m0 > 0.4 && m0 < 0.6) th *= 5.0;          // water vs water: only big occlusions
    if (m0 > 0.2 && m0 < 0.3) th *= 0.6;          // particles: eager silhouettes
    float edgeD = 0.0, edgeN = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      vec2 o = vec2(cos(a), sin(a)) * w * px;
      vec2 uv2 = vUv + o;
      float dn = lin(texture(tDepth, uv2).r);
      // one-sided: only the NEARER pixel paints the line -> crisp, single-sided silhouettes
      edgeD = max(edgeD, smoothstep(th, th * 1.6, (dn - d0) / d0));
      vec4 nn = texture(tNormal, uv2);
      if (m0 > 0.85 && nn.a > 0.85) {
        float nd = dot(n0, decodeN(nn));
        edgeN = max(edgeN, smoothstep(uNormalTh + 0.08, uNormalTh - 0.08, nd) * step(-0.02 * d0, d0 - dn + 0.02 * d0));
      }
    }
    edge = max(edgeD, edgeN * 0.85);
  }

  // halftone dots in shadow bands, fixed to the screen so the pattern never slides with the camera
  if (uHalftone > 0.5 && !sky && m0 > 0.3 && m0 < 0.95 + 0.1) {
    float band = nt.b;
    float amt = band < 0.25 ? 1.0 : band < 0.75 ? 0.4 : 0.0;
    if (m0 > 0.4 && m0 < 0.6) amt *= 0.7;
    if (m0 > 0.7 && m0 < 0.8) amt = 0.0;
    amt *= uHtStrength * (1.0 - smoothstep(120.0, 380.0, d0));
    if (amt > 0.0) {
      vec2 p = gl_FragCoord.xy / (uHtScale * uPx);
      p = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p;
      float dist = length(fract(p) - 0.5);
      float r = sqrt(amt) * 0.48;
      float aa = 0.08;
      float dotm = 1.0 - smoothstep(r - aa, r + aa, dist);
      c *= mix(1.0, 0.58, dotm);
    }
  }

  float fogF = sky ? 0.0 : smoothstep(uFogStart, uFogEnd, d0);
  if (m0 > 0.85 && m0 < 0.95) fogF = smoothstep(uFogStart, uFogEnd * 4.0, d0) * 0.75; // backdrop layer
  c = mix(c, uInk, edge * (1.0 - fogF * 0.85));
  c = mix(c, uFog, fogF);
  fragColor = vec4(c, 1.0);
}
`;

const BRIGHT = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
void main() {
  vec3 s = texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  s *= 0.25;
  float l = max(s.r, max(s.g, s.b));
  float k = smoothstep(uThreshold, uThreshold + 0.35, l);
  fragColor = vec4(s * k, 1.0);
}
`;

const DOWN = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
void main() {
  vec3 c = texture(tSrc, vUv).rgb * 4.0;
  c += texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  fragColor = vec4(c / 8.0, 1.0);
}
`;

const UP = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tAdd;
uniform vec2 uTexel;
void main() {
  vec3 c = vec3(0.0);
  c += texture(tSrc, vUv + uTexel * vec2(-2.0, 0.0)).rgb;
  c += texture(tSrc, vUv + uTexel * vec2(2.0, 0.0)).rgb;
  c += texture(tSrc, vUv + uTexel * vec2(0.0, -2.0)).rgb;
  c += texture(tSrc, vUv + uTexel * vec2(0.0, 2.0)).rgb;
  c += texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb * 2.0;
  c += texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb * 2.0;
  c += texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb * 2.0;
  c += texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb * 2.0;
  fragColor = vec4(c / 12.0 + texture(tAdd, vUv).rgb, 1.0);
}
`;

const FINAL = /* glsl */ `
uniform sampler2D tComp;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uSat, uContrast, uLift, uVignette;
uniform vec3 uInk;
uniform float uSpeed, uBoost, uTime, uFlash, uInvert, uRain, uAspect, uLines;
uniform vec3 uFlashColor;
uniform vec3 uRainColor;
uniform vec2 uCenter;
uniform float uImpact;
uniform vec2 uImpactPos;
uniform vec3 uImpactInk, uImpactPaper;
uniform float uBoostFlash;
uniform vec3 uBoostFlashColor;
${NOISE_GLSL}

vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // vanishing point follows the direction of travel, so lines converge off-center in a slide
  vec2 ctr = uCenter;
  vec2 dc = vUv - ctr;
  vec2 dca = dc * vec2(uAspect, 1.0);
  float r = length(dca);

  // boost: radial smear toward the screen edge + slight chromatic split
  float amt = uBoost * smoothstep(0.2, 0.75, r) * 0.05;
  vec3 c = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float k = float(i) / 5.0;
    vec2 uv = vUv - dc * amt * k;
    c.r += texture(tComp, uv + dc * amt * 0.25).r;
    c.g += texture(tComp, uv).g;
    c.b += texture(tComp, uv - dc * amt * 0.25).b;
  }
  c /= 6.0;
  c += texture(tBloom, vUv).rgb * uBloom;

  vec3 s = toSRGB(c);
  float l = dot(s, vec3(0.299, 0.587, 0.114));
  s = mix(vec3(l), s, uSat);
  s = (s - 0.5) * uContrast + 0.5 + uLift;

  // manga focus lines, converging on the vanishing point
  float inten = clamp(uSpeed * uLines + uBoost * 0.8, 0.0, 1.5);
  if (inten > 0.01) {
    float ang = atan(dca.y, dca.x);
    float a = (ang / 6.28318 + 0.5) * 220.0;
    float id = floor(a);
    float f = fract(a);
    float tt = floor(uTime * 16.0);
    float rnd = hash12(vec2(id, tt));
    float rnd2 = hash12(vec2(id * 1.7, tt + 3.0));
    float inner = mix(0.78, 0.34, clamp(inten, 0.0, 1.0)) + rnd2 * 0.22;
    float taper = smoothstep(inner, inner + 0.55, r);
    float wdt = (0.12 + 0.5 * rnd) * taper;
    float line = step(abs(f - 0.5), wdt * 0.5) * step(0.5 - 0.25 * min(inten, 1.0), rnd);
    s = mix(s, uInk, line * 0.62 * min(inten, 1.0));
    float wl = step(abs(f - 0.5), wdt * 0.35) * step(0.93, rnd2) * uBoost;
    s = mix(s, vec3(1.0), wl * taper * 0.8);
  }

  if (uRain > 0.0) {
    vec2 rp = vec2(vUv.x * uAspect + vUv.y * 0.18, vUv.y);
    float col = floor(rp.x * 140.0);
    float h1 = hash12(vec2(col, 1.0));
    float y = fract(rp.y * 1.6 + uTime * (2.2 + h1 * 1.5) + h1 * 10.0);
    float streak = step(0.92, h1 + 0.1) * step(y, 0.09) * step(abs(fract(rp.x * 140.0) - 0.5), 0.12);
    s = mix(s, uRainColor, streak * 0.45 * uRain);
    s = mix(s, s * vec3(0.9, 0.95, 1.0), 0.15 * uRain);
  }

  // boost: a short burst of the charge color pushed in from the screen edges
  if (uBoostFlash > 0.0) {
    s = mix(s, toSRGB(uBoostFlashColor), uBoostFlash * (0.2 + 0.8 * smoothstep(0.15, 0.85, r)));
  }

  // impact frame: the picture drops to two flat tones (negative) with burst rays from the hit point
  if (uImpact > 0.0) {
    vec3 ink = toSRGB(uImpactInk), paper = toSRGB(uImpactPaper);
    float lum = dot(s, vec3(0.299, 0.587, 0.114));
    float th = step(0.52, lum);
    vec3 two = mix(paper, ink, th);
    vec2 d = (vUv - uImpactPos) * vec2(uAspect, 1.0);
    float ia = (atan(d.y, d.x) / 6.28318 + 0.5) * 72.0;
    float rr = hash12(vec2(floor(ia), floor(uTime * 24.0)));
    float ray = step(abs(fract(ia) - 0.5), 0.06 + 0.22 * rr) * step(0.62, rr) * smoothstep(0.12, 0.42, length(d));
    two = mix(two, mix(ink, paper, th), ray);
    s = mix(s, two, uImpact);
  }

  s *= 1.0 - uVignette * smoothstep(0.42, 1.05, r);
  s = mix(s, uFlashColor, uFlash);
  s = mix(s, vec3(1.0) - s, uInvert);
  fragColor = vec4(s, 1.0);
}
`;

const FXAA = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
void main() {
  vec3 rgbNW = texture(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture(tSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb;
  vec3 rgbSE = texture(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb;
  vec3 rgbM = texture(tSrc, vUv).rgb;
  vec3 luma = vec3(0.299, 0.587, 0.114);
  float lNW = dot(rgbNW, luma), lNE = dot(rgbNE, luma), lSW = dot(rgbSW, luma), lSE = dot(rgbSE, luma), lM = dot(rgbM, luma);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 rgbA = 0.5 * (texture(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture(tSrc, vUv + dir * -0.5).rgb + texture(tSrc, vUv + dir * 0.5).rgb);
  float lB = dot(rgbB, luma);
  fragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
`;

const BLOOM_LEVELS = 5;

/**
 * Order (fixed by the design doc): geometry -> outline -> halftone -> bloom -> grade.
 * Bloom runs AFTER the ink so glow never eats the lines.
 */
export class Pipeline {
  readonly renderer: WebGLRenderer;
  private gbuf: WebGLRenderTarget;
  private comp: WebGLRenderTarget;
  private fin: WebGLRenderTarget;
  private down: WebGLRenderTarget[] = [];
  private up: WebGLRenderTarget[] = [];
  private quad: Mesh;
  private qScene = new Scene();
  private qCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly mComp: ShaderMaterial;
  private mBright: ShaderMaterial;
  private mDown: ShaderMaterial;
  private mUp: ShaderMaterial;
  readonly mFinal: ShaderMaterial;
  private mFxaa: ShaderMaterial;
  private w = 1;
  private h = 1;
  pixelRatio = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.setClearColor(new Color(0, 0, 0), 0);
    const mk = (w: number, h: number, extra: object = {}) =>
      new WebGLRenderTarget(w, h, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, ...extra });
    this.gbuf = new WebGLRenderTarget(1, 1, { count: 2, type: HalfFloatType, depthBuffer: true, depthTexture: new DepthTexture(1, 1) });
    this.gbuf.textures[0].minFilter = this.gbuf.textures[0].magFilter = LinearFilter;
    this.gbuf.textures[1].minFilter = this.gbuf.textures[1].magFilter = NearestFilter;
    this.comp = mk(1, 1);
    this.fin = new WebGLRenderTarget(1, 1, { minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.down.push(mk(1, 1));
      if (i < BLOOM_LEVELS - 1) this.up.push(mk(1, 1));
    }
    this.mComp = pass(COMPOSITE, {
      tColor: { value: this.gbuf.textures[0] }, tNormal: { value: this.gbuf.textures[1] }, tDepth: { value: this.gbuf.depthTexture },
      uRes: { value: new Vector2() }, uNear: { value: 0.1 }, uFar: { value: 5000 },
      uWidth: { value: RENDER.outlineWidth }, uDepthTh: { value: RENDER.depthThreshold }, uNormalTh: { value: RENDER.normalThreshold },
      uOutlines: { value: 1 }, uInk: { value: new Color() }, uFog: { value: new Color() }, uFogStart: { value: 200 }, uFogEnd: { value: 1200 },
      uHtScale: { value: RENDER.halftoneScale }, uHtStrength: { value: RENDER.halftoneStrength }, uHalftone: { value: 1 }, uPx: { value: 1 },
    });
    this.mBright = pass(BRIGHT, { tSrc: { value: null }, uTexel: { value: new Vector2() }, uThreshold: { value: RENDER.bloomThreshold } });
    this.mDown = pass(DOWN, { tSrc: { value: null }, uTexel: { value: new Vector2() } });
    this.mUp = pass(UP, { tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new Vector2() } });
    this.mFinal = pass(FINAL, {
      tComp: { value: this.comp.texture }, tBloom: { value: null }, uBloom: { value: RENDER.bloomStrength },
      uSat: { value: 1.1 }, uContrast: { value: 1.05 }, uLift: { value: 0 }, uVignette: { value: 0.3 }, uInk: { value: new Color() },
      uSpeed: { value: 0 }, uBoost: { value: 0 }, uTime: { value: 0 }, uFlash: { value: 0 }, uInvert: { value: 0 }, uRain: { value: 0 },
      uAspect: { value: 1 }, uLines: { value: 1 }, uFlashColor: { value: new Color(1, 1, 1) }, uRainColor: { value: new Color(0.8, 0.85, 1) },
      uCenter: { value: new Vector2(0.5, 0.54) }, uImpact: { value: 0 }, uImpactPos: { value: new Vector2(0.5, 0.5) },
      uImpactInk: { value: new Color() }, uImpactPaper: { value: new Color() },
      uBoostFlash: { value: 0 }, uBoostFlashColor: { value: new Color() },
    });
    this.mFxaa = pass(FXAA, { tSrc: { value: this.fin.texture }, uTexel: { value: new Vector2() } });
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.mComp);
    this.quad.frustumCulled = false;
    this.qScene.add(this.quad);
  }

  setSize(cssW: number, cssH: number, pixelRatio: number) {
    this.pixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(cssW, cssH, false);
    const w = Math.max(1, Math.floor(cssW * pixelRatio));
    const h = Math.max(1, Math.floor(cssH * pixelRatio));
    this.w = w;
    this.h = h;
    this.gbuf.setSize(w, h);
    this.comp.setSize(w, h);
    this.fin.setSize(w, h);
    let bw = w, bh = h;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
      this.down[i].setSize(bw, bh);
      if (i < BLOOM_LEVELS - 1) this.up[i].setSize(bw, bh);
    }
    (this.mComp.uniforms.uRes.value as Vector2).set(w, h);
    this.mComp.uniforms.uPx.value = Math.max(1, pixelRatio * Math.min(cssH / 900, 1.4));
    (this.mFxaa.uniforms.uTexel.value as Vector2).set(1 / w, 1 / h);
    this.mFinal.uniforms.uAspect.value = w / h;
  }

  private blit(mat: ShaderMaterial, target: WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.qScene, this.qCam);
  }

  render(scene: Scene, camera: Camera) {
    const r = this.renderer;
    const cam = camera as PerspectiveCamera;
    this.mComp.uniforms.uNear.value = cam.near;
    this.mComp.uniforms.uFar.value = cam.far;
    this.mComp.uniforms.uWidth.value = RENDER.outlineWidth;
    this.mComp.uniforms.uDepthTh.value = RENDER.depthThreshold;
    this.mComp.uniforms.uNormalTh.value = RENDER.normalThreshold;
    this.mComp.uniforms.uHtScale.value = RENDER.halftoneScale;
    this.mComp.uniforms.uHtStrength.value = RENDER.halftoneStrength;
    this.mComp.uniforms.uOutlines.value = RENDER.outlines ? 1 : 0;
    this.mComp.uniforms.uHalftone.value = RENDER.halftone ? 1 : 0;
    this.mBright.uniforms.uThreshold.value = RENDER.bloomThreshold;
    this.mFinal.uniforms.uBloom.value = RENDER.bloomStrength;
    this.mFinal.uniforms.uLines.value = RENDER.speedLines;

    r.setRenderTarget(this.gbuf);
    r.clear(true, true, false);
    r.render(scene, camera);

    this.blit(this.mComp, this.comp);

    // bloom mip chain
    this.mBright.uniforms.tSrc.value = this.comp.texture;
    (this.mBright.uniforms.uTexel.value as Vector2).set(1 / this.w, 1 / this.h);
    this.blit(this.mBright, this.down[0]);
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      this.mDown.uniforms.tSrc.value = this.down[i - 1].texture;
      (this.mDown.uniforms.uTexel.value as Vector2).set(1 / this.down[i - 1].width, 1 / this.down[i - 1].height);
      this.blit(this.mDown, this.down[i]);
    }
    let src = this.down[BLOOM_LEVELS - 1];
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      this.mUp.uniforms.tSrc.value = src.texture;
      this.mUp.uniforms.tAdd.value = this.down[i].texture;
      (this.mUp.uniforms.uTexel.value as Vector2).set(0.5 / src.width, 0.5 / src.height);
      this.blit(this.mUp, this.up[i]);
      src = this.up[i];
    }
    this.mFinal.uniforms.tBloom.value = this.up[0].texture;
    this.blit(this.mFinal, this.fin);
    this.blit(this.mFxaa, null);
  }
}
