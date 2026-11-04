import * as THREE from 'three'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

// A lean bloom for integrated GPUs: bright-pass straight to 1/4 resolution,
// then three blurred levels (1/4, 1/8, 1/16). It does not composite itself —
// the final pass samples `textures` and adds them (saves a full-res pass).
// Same knobs as UnrealBloomPass: strength, radius, threshold.

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`

const BRIGHT = /* glsl */ `
  uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThresh; varying vec2 vUv;
  void main(){
    vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    c *= 0.25;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    gl_FragColor = vec4(c * smoothstep(uThresh, uThresh + 0.12, l), 1.0);
  }`
const DOWN = /* glsl */ `
  uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
  void main(){
    vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    gl_FragColor = vec4(c * 0.25, 1.0);
  }`
// 9-tap gaussian in 5 bilinear fetches
const BLUR = /* glsl */ `
  uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;
  void main(){
    vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270;
    c += texture2D(tSrc, vUv + uDir * 1.3846154).rgb * 0.3162162;
    c += texture2D(tSrc, vUv - uDir * 1.3846154).rgb * 0.3162162;
    c += texture2D(tSrc, vUv + uDir * 3.2307692).rgb * 0.0702703;
    c += texture2D(tSrc, vUv - uDir * 3.2307692).rgb * 0.0702703;
    gl_FragColor = vec4(c, 1.0);
  }`

export class LiteBloomPass extends Pass {
  constructor(strength = 0.4, radius = 0.5, threshold = 0.85) {
    super()
    this.strength = strength
    this.radius = radius
    this.threshold = threshold
    this.needsSwap = false
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
    this.levels = [0, 1, 2].map(() => [new THREE.WebGLRenderTarget(2, 2, opts), new THREE.WebGLRenderTarget(2, 2, opts)])
    this.textures = this.levels.map((l) => l[0].texture)
    const mk = (fs, u) => new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: fs, depthTest: false, depthWrite: false })
    this.bright = mk(BRIGHT, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThresh: { value: threshold } })
    this.down = mk(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } })
    this.blur = mk(BLUR, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } })
    this.quad = new FullScreenQuad(null)
    this.srcTexel = new THREE.Vector2(1, 1)
  }

  setSize(w, h) {
    this.srcTexel.set(1 / w, 1 / h)
    this.levels.forEach((pair, i) => {
      const d = 4 << i
      pair.forEach((rt) => rt.setSize(Math.max(2, Math.round(w / d)), Math.max(2, Math.round(h / d))))
    })
  }

  draw(renderer, mat, target) {
    this.quad.material = mat
    renderer.setRenderTarget(target)
    this.quad.render(renderer)
  }

  render(renderer, writeBuffer, readBuffer) {
    const [[a0, a1], [b0, b1], [c0, c1]] = this.levels
    // bright pass, full -> 1/4 (taps 1 source texel apart ≈ a 4x4 box with bilinear)
    this.bright.uniforms.tSrc.value = readBuffer.texture
    this.bright.uniforms.uTexel.value.copy(this.srcTexel)
    this.bright.uniforms.uThresh.value = this.threshold
    this.draw(renderer, this.bright, a0)
    const blurPair = (rt0, rt1) => {
      const tx = 1 / rt0.width
      const ty = 1 / rt0.height
      this.blur.uniforms.tSrc.value = rt0.texture
      this.blur.uniforms.uDir.value.set(tx, 0)
      this.draw(renderer, this.blur, rt1)
      this.blur.uniforms.tSrc.value = rt1.texture
      this.blur.uniforms.uDir.value.set(0, ty)
      this.draw(renderer, this.blur, rt0)
    }
    blurPair(a0, a1)
    for (const [src, dst, dst1] of [
      [a0, b0, b1],
      [b0, c0, c1],
    ]) {
      this.down.uniforms.tSrc.value = src.texture
      this.down.uniforms.uTexel.value.set(0.5 / src.width, 0.5 / src.height)
      this.draw(renderer, this.down, dst)
      blurPair(dst, dst1)
    }
  }

  /** per-level weights for the composite, following UnrealBloomPass's radius curve */
  weights(out) {
    const r = this.radius
    const f = [1.0, 0.7, 0.4]
    return out.set(...f.map((x) => this.strength * THREE.MathUtils.lerp(x, 1.2 - x, r) * 1.25))
  }

  dispose() {
    this.levels.flat().forEach((rt) => rt.dispose())
    ;[this.bright, this.down, this.blur].forEach((m) => m.dispose())
    this.quad.dispose()
  }
}
