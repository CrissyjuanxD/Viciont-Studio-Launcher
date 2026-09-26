// Fondo animado (WebGL): la espiral difuminada de la web + partículas, anillos
// de pulso, cubos flotantes y cortes glitch.
// Optimizado: se dibuja a media resolución, con límite de FPS, y se detiene por
// completo cuando la ventana no se ve, está en segundo plano o se está jugando.

import { onIdleChange, isIdle, effectsLevel } from './fx.js';

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uTime;
uniform float uRot1;
uniform float uRot2;
uniform float uOrbit;
uniform float uHue;
uniform vec2 uFlow;
uniform vec2 uMouse;
uniform float uIntensity;
uniform float uExtras;
uniform float uGlitch;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}

// Partículas: una por celda (solo en algunas), parpadeando y subiendo despacio.
float stars(vec2 uv, float scale, float t, float seed) {
  vec2 p = uv * scale + vec2(0.0, -t);
  vec2 id = floor(p);
  vec2 f = fract(p) - 0.5;
  float h = hash(id + seed);
  vec2 off = vec2(hash(id + seed + 1.3), hash(id + seed + 7.1)) - 0.5;
  float d = length(f - off * 0.6);
  float size = 0.03 + 0.05 * h * h;
  float tw = 0.55 + 0.45 * sin(uTime * (1.5 + h * 3.0) + h * 40.0);
  return smoothstep(size, 0.0, d) * step(0.7, h) * tw;
}

// Cubos (bloques) flotando con contorno de neón.
float boxes(vec2 uv, float t) {
  vec2 p = uv * 2.6 + vec2(t * 0.03, -t * 0.07);
  vec2 id = floor(p);
  vec2 f = fract(p) - 0.5;
  float h = hash(id * 1.7 + 3.1);
  if (h < 0.83) return 0.0;
  float a = t * (h - 0.9) * 1.6 + h * 6.2831;
  float c = cos(a);
  float s = sin(a);
  vec2 q = mat2(c, -s, s, c) * (f - (vec2(hash(id + 2.0), hash(id + 5.0)) - 0.5) * 0.35);
  float sz = 0.06 + 0.07 * fract(h * 13.0);
  vec2 d = abs(q) - sz;
  float box = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  return smoothstep(0.01, 0.0, abs(box)) + smoothstep(0.0, -0.03, box) * 0.12;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);

  // cortes glitch horizontales (esporádicos)
  float tick = floor(uTime * 14.0);
  float band = floor(uv.y * 16.0);
  float gl = step(0.9, hash(vec2(band, tick))) * uGlitch;
  uv.x += gl * (hash(vec2(band + 3.0, tick)) - 0.5) * 0.16;

  vec2 center = vec2(cos(uOrbit), sin(uOrbit)) * 0.10 + uMouse * 0.035 + vec2(0.18, 0.06);
  vec2 p = uv - center;
  vec2 w = vec2(fbm(p * 1.6 + uFlow), fbm(p * 1.6 - uFlow + 5.2)) - 0.5;
  p += w * 0.22;
  float r = length(p);
  float a = atan(p.y, p.x);
  float lr = log(r + 0.035);
  float s1 = pow(0.5 + 0.5 * sin(a * 2.0 + lr * 4.2 - uRot1), 2.4);
  float s2 = pow(0.5 + 0.5 * sin(a * 3.0 - lr * 2.6 + uRot2), 3.2);
  float env = (1.0 - smoothstep(0.06, 1.45, r)) * smoothstep(0.0, 0.2, r);
  float hue = 0.5 + 0.5 * sin(a + uHue + r * 2.2);

  vec3 purple = vec3(0.52, 0.22, 0.98);
  vec3 pink = vec3(1.0, 0.20, 0.72);
  vec3 col = vec3(0.018, 0.006, 0.035);
  col += mix(purple, pink, hue) * s1 * env * 0.72 * uIntensity;
  col += mix(pink, purple, hue) * s2 * env * 0.28 * uIntensity;
  col += mix(purple, pink, 0.4) * exp(-r * r * 14.0) * 0.28 * uIntensity;
  col += vec3(1.0, 0.86, 1.0) * pow(s1, 8.0) * env * 0.05 * uIntensity;

  if (uExtras > 0.0) {
    // anillos que salen del centro de la espiral
    float rw = fract(r * 1.8 - uTime * 0.18);
    float ring = smoothstep(0.0, 0.015, rw) * smoothstep(0.05, 0.015, rw) * smoothstep(1.3, 0.25, r) * smoothstep(0.05, 0.2, r);
    col += mix(pink, purple, hue) * ring * 0.16 * uExtras;
    // partículas en dos capas (efecto de profundidad)
    float st = stars(uv, 7.0, uTime * 0.025, 0.0) * 0.6 + stars(uv + 3.7, 13.0, uTime * 0.04, 5.0) * 0.4;
    col += vec3(1.0, 0.82, 1.0) * st * 0.7 * uExtras;
    // cubos flotantes
    col += vec3(0.78, 0.45, 1.0) * boxes(uv, uTime) * 0.28 * uExtras;
  }
  col.r += gl * 0.08;
  col.b += gl * 0.12;
  float vig = 1.0 - smoothstep(0.35, 1.8, length(uv));
  col *= vig;
  col += (hash(gl_FragCoord.xy + uFlow * 91.0) - 0.5) * (1.5 / 255.0);
  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(log || 'shader');
  }
  return sh;
}

const MODES = {
  home: { intensity: 1, extras: 1 },
  dim: { intensity: 0.6, extras: 0.6 },
  login: { intensity: 1, extras: 1 },
};

export function createBackground(canvas) {
  const fail = () => {
    document.documentElement.classList.add('no-webgl');
    return { setMode() {}, setPaused() {}, glitch() {}, destroy() {} };
  };
  let gl = null;
  try {
    gl = canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power',
    });
  } catch { gl = null; }
  if (!gl) return fail();

  let prog;
  let uni;
  let raf = 0;
  let lost = false;
  let paused = false;
  let hidden = false;
  let glitchUntil = 0;
  const target = { ...MODES.home };
  const cur = { ...MODES.home };
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const TAU = Math.PI * 2;

  function init() {
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) {
      console.warn('[fondo] WebGL no disponible:', e);
      return false;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    uni = {};
    for (const n of ['uRes', 'uTime', 'uRot1', 'uRot2', 'uOrbit', 'uHue', 'uFlow', 'uMouse', 'uIntensity', 'uExtras', 'uGlitch']) {
      uni[n] = gl.getUniformLocation(prog, n);
    }
    return true;
  }

  function scale() { return effectsLevel() === 'reduced' ? 0.34 : 0.5; }
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(window.innerWidth * dpr * scale()));
    const h = Math.max(2, Math.round(window.innerHeight * dpr * scale()));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  const start = performance.now();
  let last = 0;
  let pausedAt = performance.now();
  let pausedTotal = 0;

  function frame(now) {
    raf = 0;
    if (lost || paused || hidden || effectsLevel() === 'minimal') return;
    raf = requestAnimationFrame(frame);
    const minFrame = 1000 / (effectsLevel() === 'reduced' ? 20 : 30);
    if (now - last < minFrame) return;
    last = now;
    const t = (now - start - pausedTotal) / 1000;
    for (const k of ['intensity', 'extras']) cur[k] += (target[k] - cur[k]) * 0.06;
    mouse.x += (mouse.tx - mouse.x) * 0.04;
    mouse.y += (mouse.ty - mouse.y) * 0.04;
    const g = now < glitchUntil ? 1 : (Math.random() < 0.004 ? 1 : 0);
    gl.uniform2f(uni.uRes, canvas.width, canvas.height);
    gl.uniform1f(uni.uTime, t % 3600);
    gl.uniform1f(uni.uRot1, (t * 0.35) % TAU);
    gl.uniform1f(uni.uRot2, (t * 0.22) % TAU);
    gl.uniform1f(uni.uOrbit, (t * 0.12) % TAU);
    gl.uniform1f(uni.uHue, (t * 0.15) % TAU);
    gl.uniform2f(uni.uFlow, Math.cos(t * 0.05) * 2.0, Math.sin(t * 0.05) * 2.0);
    gl.uniform2f(uni.uMouse, mouse.x, mouse.y);
    gl.uniform1f(uni.uIntensity, cur.intensity);
    gl.uniform1f(uni.uExtras, cur.extras);
    gl.uniform1f(uni.uGlitch, g);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function kick() {
    if (!raf && !paused && !hidden && !lost) raf = requestAnimationFrame(frame);
  }

  // El tiempo de animación se congela mientras está parado (al volver sigue igual).
  let wasRunning = true;
  function updateRun() {
    const now = performance.now();
    const running = !paused && !hidden && !lost && effectsLevel() !== 'minimal';
    if (running && !wasRunning) { pausedTotal += now - pausedAt; kick(); }
    if (!running && wasRunning) pausedAt = now;
    wasRunning = running;
  }
  function setHidden(v) {
    hidden = v;
    updateRun();
  }

  if (!init()) return fail();
  resize();
  canvas.classList.add('is-ready');
  kick();

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 120); }, { passive: true });
  window.addEventListener('pointermove', (e) => {
    mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
    mouse.ty = -(e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });
  onIdleChange((v) => setHidden(v));
  if (isIdle()) setHidden(true);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => { if (init()) { lost = false; resize(); kick(); } });

  return {
    setMode(name) {
      Object.assign(target, MODES[name] || MODES.home);
      canvas.classList.toggle('is-dim', name === 'dim');
    },
    // cuando hay un fondo de instancia encima o se está jugando, no se dibuja nada
    setPaused(v) {
      paused = Boolean(v);
      updateRun();
      canvas.style.visibility = paused ? 'hidden' : '';
    },
    glitch(ms = 260) { glitchUntil = performance.now() + ms; },
    refresh() { resize(); updateRun(); kick(); },
  };
}
