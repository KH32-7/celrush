import {
  AdditiveBlending, GLSL3, HalfFloatType, InstancedBufferAttribute, InstancedMesh, LinearFilter, Matrix4, Mesh, OrthographicCamera,
  PlaneGeometry, Scene, ShaderMaterial, Vector2, Vector3, WebGLRenderer, WebGLRenderTarget,
} from 'three';

/**
 * World-anchored foam map for boat wakes. Hulls stamp soft blobs; every frame the map decays and
 * spreads a little, so trails widen and break up as they age, exactly like a Kelvin wake fading out.
 * The water shader thresholds it against moving noise to get crisp cel foam.
 */
export class WakeMap {
  readonly size: number;
  readonly res: number;
  readonly center = new Vector2();
  private rtA: WebGLRenderTarget;
  private rtB: WebGLRenderTarget;
  private cam: OrthographicCamera;
  private decayScene = new Scene();
  private stampScene = new Scene();
  private decayMat: ShaderMaterial;
  private stamps: InstancedMesh;
  private strength: InstancedBufferAttribute;
  private count = 0;
  private readonly max = 512;
  private m = new Matrix4();

  constructor(private renderer: WebGLRenderer, size = 220, res = 512) {
    this.size = size;
    this.res = res;
    const opts = { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false };
    this.rtA = new WebGLRenderTarget(res, res, opts);
    this.rtB = new WebGLRenderTarget(res, res, opts);
    this.cam = new OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, -10, 10);
    this.cam.up.set(0, 0, -1);
    this.cam.position.set(0, 5, 0);
    this.cam.lookAt(0, 0, 0);
    this.decayMat = new ShaderMaterial({
      glslVersion: GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: { tPrev: { value: null }, uOffset: { value: new Vector2() }, uDecay: { value: 0.99 }, uTexel: { value: 1 / res } },
      vertexShader: `out vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tPrev; uniform vec2 uOffset; uniform float uDecay; uniform float uTexel;
        in vec2 vUv; layout(location = 0) out vec4 o;
        float s(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? 0.0 : texture(tPrev, uv).r; }
        void main() {
          vec2 uv = vUv + uOffset;
          float c = s(uv) * 0.6 + (s(uv + vec2(uTexel, 0.0)) + s(uv - vec2(uTexel, 0.0)) + s(uv + vec2(0.0, uTexel)) + s(uv - vec2(0.0, uTexel))) * 0.1;
          o = vec4(c * uDecay, 0.0, 0.0, 1.0);
        }`,
    });
    const q = new Mesh(new PlaneGeometry(2, 2), this.decayMat);
    q.frustumCulled = false;
    this.decayScene.add(q);

    const stampMat = new ShaderMaterial({
      glslVersion: GLSL3,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      vertexShader: /* glsl */ `
        in float aStrength; out vec2 vUv; out float vS;
        void main(){ vUv = uv; vS = aStrength; gl_Position = projectionMatrix * viewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float; in vec2 vUv; in float vS; layout(location = 0) out vec4 o;
        void main(){ float r = length(vUv - 0.5) * 2.0; o = vec4(vS * (1.0 - smoothstep(0.35, 1.0, r)), 0.0, 0.0, 1.0); }`,
    });
    const geo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.strength = new InstancedBufferAttribute(new Float32Array(this.max), 1);
    geo.setAttribute('aStrength', this.strength);
    this.stamps = new InstancedMesh(geo, stampMat, this.max);
    this.stamps.frustumCulled = false;
    this.stampScene.add(this.stamps);
  }

  get texture() {
    return this.rtA.texture;
  }

  /** Queue a foam blob at world (x, z). */
  stamp(x: number, z: number, radius: number, strength: number) {
    if (this.count >= this.max || strength <= 0.001) return;
    this.m.makeScale(radius * 2, 1, radius * 2).setPosition(x, 0, z);
    this.stamps.setMatrixAt(this.count, this.m);
    this.strength.setX(this.count, strength);
    this.count++;
  }

  private stepAcc = 0;

  /** Advances the map in fixed 1/60 s steps (the spread blur is per step, so this keeps it refresh-rate independent). */
  update(focus: Vector3, dt: number) {
    // stamps queued on frames with no step due are drawn by the next step
    this.stepAcc = Math.min(this.stepAcc + dt, 4 / 60);
    while (this.stepAcc >= 1 / 60) {
      this.stepAcc -= 1 / 60;
      this.step(focus, 1 / 60);
    }
  }

  private step(focus: Vector3, dt: number) {
    const texel = this.size / this.res;
    const nx = Math.round(focus.x / texel) * texel;
    const nz = Math.round(focus.z / texel) * texel;
    const off = this.decayMat.uniforms.uOffset.value as Vector2;
    // texture v runs along -Z because of the camera "up"; keep sampling consistent with the water shader
    off.set((nx - this.center.x) / this.size, -(nz - this.center.y) / this.size);
    this.center.set(nx, nz);
    this.decayMat.uniforms.uDecay.value = Math.exp(-dt / 1.9);
    this.decayMat.uniforms.tPrev.value = this.rtA.texture;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.rtB);
    r.render(this.decayScene, this.cam);
    this.stamps.count = this.count;
    if (this.count > 0) {
      this.stamps.instanceMatrix.needsUpdate = true;
      this.strength.needsUpdate = true;
      this.cam.position.set(nx, 5, nz);
      this.cam.lookAt(nx, 0, nz);
      r.render(this.stampScene, this.cam);
    }
    this.count = 0;
    r.setRenderTarget(prevTarget);
    const t = this.rtA;
    this.rtA = this.rtB;
    this.rtB = t;
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    for (const sc of [this.decayScene, this.stampScene]) {
      sc.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        (m.material as ShaderMaterial).dispose();
      });
    }
  }
}
