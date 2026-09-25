import { useEffect, useRef } from 'react'
import * as THREE from 'three'

// The VARUNA voice orb: a glowing, morphing 3D sphere (three.js shader).
//   listening → cyan, ripples with the operator's voice (levelRef)
//   thinking  → violet, fast swirl
//   speaking  → blue/green, pulses on every spoken word (levelRef kicks)
//   idle      → calm slow breathing
// `levelRef.current` (0..1) is read every frame, so audio never re-renders React.

const PALETTE = {
  idle: ['#3B9EFF', '#7C5CFF'],
  listening: ['#00E5FF', '#3B9EFF'],
  thinking: ['#9B5CFF', '#FF5CD6'],
  speaking: ['#32D7A0', '#3B9EFF'],
  error: ['#FF453A', '#FF9F0A'],
}

// Ashima Arts 3D simplex noise (MIT).
const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`

const VERT = `${NOISE}
uniform float uTime; uniform float uAmp; uniform float uFreq;
varying vec3 vNormal; varying vec3 vView; varying float vN;
void main(){
  float n = snoise(normal * uFreq + vec3(uTime * 0.6, uTime * 0.4, uTime * 0.5));
  float n2 = snoise(normal * uFreq * 2.3 - vec3(uTime * 0.9));
  vN = n;
  vec3 pos = position + normal * (n * uAmp + n2 * uAmp * 0.15);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`

const FRAG = `
uniform vec3 uA; uniform vec3 uB; uniform float uTime; uniform float uGlow;
varying vec3 vNormal; varying vec3 vView; varying float vN;
void main(){
  float fres = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.4);
  float band = 0.5 + 0.5 * sin(vN * 2.2 + uTime * 1.2 + vNormal.y * 1.5);
  vec3 col = mix(uA, uB, band);
  // glossy highlight from the upper-left, like a glass orb
  vec3 L = normalize(vec3(-0.5, 0.7, 0.8));
  float spec = pow(max(dot(reflect(-L, vNormal), vView), 0.0), 24.0);
  col = col * (0.75 + 0.25 * max(dot(vNormal, L), 0.0));
  col += fres * (0.8 + uGlow) * mix(uB, vec3(1.0), 0.45);
  col += vec3(1.0) * spec * 0.55;
  gl_FragColor = vec4(col, 0.95);
}`

export default function VarunaOrb({ mode = 'idle', levelRef, size = 88 }) {
  const hostRef = useRef(null)
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() => {
    const host = hostRef.current
    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
    } catch {
      host.dataset.fallback = '1' // CSS orb (see styles below) if WebGL isn't available
      return undefined
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.setSize(size, size)
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10)
    camera.position.z = 4.2
    const uniforms = {
      uTime: { value: 0 },
      uAmp: { value: 0.08 },
      uFreq: { value: 1.05 },
      uGlow: { value: 0 },
      uA: { value: new THREE.Color(PALETTE.idle[0]) },
      uB: { value: new THREE.Color(PALETTE.idle[1]) },
    }
    const mesh = new THREE.Mesh(
      // Detail 24 ≈ 12.5k triangles: identical at 64–76 px, ~7× less vertex-shader work than 64 (84k).
      new THREE.IcosahedronGeometry(1, 24),
      new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true }),
    )
    scene.add(mesh)

    const tA = new THREE.Color()
    const tB = new THREE.Color()
    let raf = 0
    let last = performance.now()
    let level = 0
    const loop = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const m = modeRef.current
      const target = Math.max(0, Math.min(1, levelRef?.current || 0))
      level += (target - level) * (m === 'speaking' ? 0.25 : 0.35)
      if (m === 'speaking' && levelRef) levelRef.current *= 0.9 // word kicks decay
      const speed = m === 'thinking' ? 2.6 : m === 'listening' ? 1.4 : m === 'speaking' ? 1.6 : 0.6
      uniforms.uTime.value += dt * speed
      const amp = m === 'thinking' ? 0.13 : m === 'idle' ? 0.05 + Math.sin(now / 900) * 0.015 : 0.06 + level * 0.26
      uniforms.uAmp.value += (amp - uniforms.uAmp.value) * 0.15
      uniforms.uGlow.value = level
      const [a, b] = PALETTE[m] || PALETTE.idle
      uniforms.uA.value.lerp(tA.set(a), 0.08)
      uniforms.uB.value.lerp(tB.set(b), 0.08)
      mesh.rotation.y += dt * (m === 'thinking' ? 1.2 : 0.35)
      mesh.rotation.x = Math.sin(now / 2400) * 0.3
      const s = 1 + level * 0.12
      mesh.scale.setScalar(s)
      renderer.render(scene, camera)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      mesh.geometry.dispose()
      mesh.material.dispose()
      renderer.forceContextLoss() // dispose() alone keeps the GL context; browsers cap them (~16)
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [size, levelRef])

  const [c1, c2] = PALETTE[mode] || PALETTE.idle
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {/* soft outer glow behind the sphere */}
      <div
        className="pointer-events-none absolute inset-[-30%] rounded-full blur-xl transition-colors duration-500"
        style={{ background: `radial-gradient(circle, ${c1}66 0%, ${c2}22 45%, transparent 70%)` }}
      />
      <div
        ref={hostRef}
        className="relative h-full w-full [&[data-fallback='1']]:animate-pulse [&[data-fallback='1']]:rounded-full"
        style={{ background: hostRef.current?.dataset.fallback ? `radial-gradient(circle at 35% 30%, #fff, ${c1} 40%, ${c2})` : undefined }}
      />
    </div>
  )
}
