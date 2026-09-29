let level = 'full';
let idle = false;
const idleListeners = new Set();

export const reducedMotion = () => level === 'minimal' || matchMedia('(prefers-reduced-motion: reduce)').matches;
export const effectsLevel = () => level;
export const isIdle = () => !window.__vslForceActive && (idle || document.hidden);

export function setEffects(l) {
  level = ['full', 'reduced', 'minimal'].includes(l) ? l : 'full';
  const html = document.documentElement;
  html.classList.remove('fx-full', 'fx-reduced', 'fx-minimal');
  html.classList.add(`fx-${level}`);
  idleListeners.forEach((fn) => fn(isIdle()));
}

export function onIdleChange(fn) {
  idleListeners.add(fn);
  return () => idleListeners.delete(fn);
}

export function initIdle() {
  let t = null;
  const apply = (v) => {
    if (idle === v) return;
    idle = v;
    document.documentElement.classList.toggle('is-idle', isIdle());
    idleListeners.forEach((fn) => fn(isIdle()));
  };
  const onBlur = () => { clearTimeout(t); t = setTimeout(() => apply(true), 4000); };
  const onFocus = () => { clearTimeout(t); apply(false); };
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', () => {
    document.documentElement.classList.toggle('is-idle', isIdle());
    idleListeners.forEach((fn) => fn(isIdle()));
  });
  if (!document.hasFocus()) onBlur();
}

const GLYPHS = '!<>-_\\/[]{}=+*^?#01§$%&@ABCDEFXYZ';
export function scramble(el, text, { duration = 700 } = {}) {
  if (!el) return;
  const target = String(text ?? '');
  cancelAnimationFrame(el._scramble || 0);
  if (reducedMotion() || !target || isIdle()) { el.textContent = target; return; }
  const len = target.length;
  const order = Array.from({ length: len }, (_, i) => (i / len) * 0.65 + (((i * 7919) % 13) / 13) * 0.35);
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    let out = '';
    for (let i = 0; i < len; i++) {
      const ch = target[i];
      out += ch === ' ' || t >= order[i] ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    }
    el.textContent = out;
    if (t < 1) el._scramble = requestAnimationFrame(step);
    else el.textContent = target;
  };
  el._scramble = requestAnimationFrame(step);
}

export function typeLoop(el, words) {
  if (!el) return () => {};
  clearTimeout(el._typing);
  const list = (words || []).filter(Boolean);
  if (!list.length) { el.textContent = ''; return () => {}; }
  if (reducedMotion()) { el.textContent = list[0]; return () => {}; }
  let wi = 0;
  let ci = 0;
  let deleting = false;
  let stopped = false;
  const schedule = (ms) => { if (!stopped) el._typing = setTimeout(tick, ms); };
  function tick() {
    if (!el.isConnected) return;
    if (isIdle()) return schedule(1500);
    const w = list[wi % list.length];
    if (!deleting) {
      ci++;
      el.textContent = w.slice(0, ci);
      if (ci >= w.length) { deleting = true; return schedule(1800); }
      return schedule(45 + Math.random() * 55);
    }
    ci--;
    el.textContent = w.slice(0, ci);
    if (ci <= 0) { deleting = false; wi++; return schedule(320); }
    return schedule(26);
  }
  el.textContent = '';
  schedule(400);
  return () => { stopped = true; clearTimeout(el._typing); };
}

export function startGlitchBursts() {
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
  };
  const loop = () => {
    if (!isIdle() && level !== 'minimal') {
      const els = [...document.querySelectorAll('.glitch, .glitch-img')].filter(inView);
      if (els.length) {
        const el = els[(Math.random() * els.length) | 0];
        el.classList.add('is-bursting');
        setTimeout(() => el.classList.remove('is-bursting'), 480);
      }
    }
    const base = level === 'reduced' ? 5200 : 1900;
    setTimeout(loop, base + Math.random() * 3200);
  };
  setTimeout(loop, 1600);
}

export function burst(el) {
  if (!el || reducedMotion()) return;
  el.classList.remove('is-bursting');
  void el.offsetWidth;
  el.classList.add('is-bursting');
  setTimeout(() => el.classList.remove('is-bursting'), 480);
}

export function glitchTransition(swap) {
  const layer = document.getElementById('transition-fx');
  if (!layer || reducedMotion() || level === 'reduced') { swap(); return; }
  layer.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const s = document.createElement('span');
    const h = 4 + Math.random() * 14;
    s.style.top = `${Math.random() * (100 - h)}%`;
    s.style.height = `${h}%`;
    s.style.setProperty('--d', `${(Math.random() * 90) | 0}ms`);
    s.style.setProperty('--x', `${(Math.random() > 0.5 ? 1 : -1) * (20 + Math.random() * 40)}%`);
    s.className = i % 2 ? 'is-pink' : 'is-purple';
    layer.appendChild(s);
  }
  layer.classList.remove('is-on');
  void layer.offsetWidth;
  layer.classList.add('is-on');
  document.documentElement.classList.add('is-switching');
  setTimeout(swap, 140);
  setTimeout(() => {
    layer.classList.remove('is-on');
    document.documentElement.classList.remove('is-switching');
  }, 520);
}

export function bindTilt(root) {
  root.addEventListener('pointermove', (e) => {
    if (reducedMotion()) return;
    const card = e.target.closest?.('[data-tilt]');
    if (!card) return;
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    card.style.setProperty('--rx', `${((0.5 - y) * 6).toFixed(2)}deg`);
    card.style.setProperty('--ry', `${((x - 0.5) * 8).toFixed(2)}deg`);
  }, { passive: true });
  root.addEventListener('pointerout', (e) => {
    const card = e.target.closest?.('[data-tilt]');
    if (card && !card.contains(e.relatedTarget)) { card.style.removeProperty('--rx'); card.style.removeProperty('--ry'); }
  });
}

export function bootScreen() {
  const el = document.getElementById('boot');
  if (!el) return { done: () => {} };
  const quick = reducedMotion();
  if (!quick) [...el.querySelectorAll('.boot__line')].forEach((l, i) => setTimeout(() => l.classList.add('on'), 100 + i * 220));
  const t0 = performance.now();
  return {
    done() {
      const wait = Math.max(0, (quick ? 0 : 1000) - (performance.now() - t0));
      setTimeout(() => {
        el.classList.add('boot--out');
        setTimeout(() => el.remove(), 600);
      }, wait);
    },
  };
}

export function glitchImg(src, cls = '') {
  return `<div class="glitch-img ${cls}"><img class="glitch-img__main" src="${src}" alt=""><img class="glitch-img__ghost glitch-img__ghost--a" src="${src}" alt=""><img class="glitch-img__ghost glitch-img__ghost--b" src="${src}" alt=""></div>`;
}
