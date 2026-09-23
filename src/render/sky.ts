import { BackSide, Color, GLSL3, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import { col, type Theme } from '../tuning/palette';
import { NOISE_GLSL } from './toon';

/** Sky dome: gradient + banded sun halo (+ stars at night). Writes mask 0 so no outlines/fog touch it. */
export function makeSky(t: Theme) {
  const mat = new ShaderMaterial({
    glslVersion: GLSL3,
    side: BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new Color().copy(col(t.sky.top)) },
      uHorizon: { value: new Color().copy(col(t.sky.horizon)) },
      uBottom: { value: new Color().copy(col(t.sky.bottom)) },
      uSun: { value: new Color().copy(col(t.sky.sun)) },
      uSunDir: { value: new Vector3(...t.sunDir).normalize() },
      uNight: { value: t.night ? 1 : 0 },
      uFlash: { value: 0 },
    },
    vertexShader: /* glsl */ `
      out vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // pin to the far plane
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uTop, uHorizon, uBottom, uSun, uSunDir;
      uniform float uNight, uFlash;
      in vec3 vDir;
      layout(location = 0) out vec4 oColor;
      layout(location = 1) out vec4 oNormal;
      ${NOISE_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 c = h > 0.0 ? mix(uHorizon, uTop, pow(smoothstep(0.0, 0.62, h), 0.75))
                         : mix(uHorizon, uBottom, smoothstep(0.0, -0.25, h));
        // a brighter band hugging the horizon, crisp-edged like a painted backdrop
        float band = smoothstep(0.075, 0.065, abs(h - 0.02));
        c = mix(c, mix(uHorizon, vec3(1.0), 0.25), band * 0.35 * (1.0 - uNight));
        float sd = dot(d, normalize(uSunDir));
        float disc = smoothstep(0.9988, 0.9991, sd);
        float halo1 = smoothstep(0.990, 0.9905, sd);
        float halo2 = smoothstep(0.962, 0.963, sd);
        c = mix(c, mix(c, uSun, 0.35), halo2 * 0.5);
        c = mix(c, mix(c, uSun, 0.6), halo1 * 0.6);
        c = mix(c, uSun * 2.2, disc);
        if (uNight > 0.5) {
          vec2 g = vec2(atan(d.z, d.x) * 120.0, d.y * 240.0);
          vec2 cell = floor(g);
          float r = hash12(cell);
          float star = step(0.985, r) * smoothstep(0.35, 0.05, length(fract(g) - 0.5)) * step(0.05, h);
          c += vec3(star) * (0.6 + 0.8 * hash12(cell + 7.0));
          // moon craters as a flat darker blot
          float m = smoothstep(0.9993, 0.9990, dot(d, normalize(uSunDir + vec3(0.004, 0.003, 0.0))));
          c = mix(c, c * 0.82, disc * (1.0 - m) * 0.0 + disc * step(0.6, vnoise(d.xz * 900.0)) * 0.25);
        }
        c = mix(c, vec3(1.0), uFlash);
        oColor = vec4(c, 1.0);
        oNormal = vec4(0.5, 0.5, 1.0, 0.0);
      }`,
  });
  const mesh = new Mesh(new SphereGeometry(4200, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}
