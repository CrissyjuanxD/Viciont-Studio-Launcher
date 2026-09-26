// Ventanas modales, confirmaciones, avisos, tooltips y menús.

import { icon, hydrateIcons } from './icons.js';
import { esc } from './util.js';

const root = () => document.getElementById('modals');
const stack = [];

export function modal({ html = '', size = '', locked = false, onClose, className = '' } = {}) {
  const el = document.createElement('div');
  el.className = `modal ${className}`;
  el.innerHTML = `
    <div class="modal__backdrop"></div>
    <div class="modal__dialog ${size ? `modal__dialog--${size}` : ''}" role="dialog" aria-modal="true" tabindex="-1">
      <button class="modal__close" type="button" aria-label="Cerrar">${icon('close')}</button>
      <div class="modal__content"></div>
    </div>`;
  const content = el.querySelector('.modal__content');
  content.innerHTML = html;
  hydrateIcons(content);
  const dialog = el.querySelector('.modal__dialog');
  let closed = false;
  const api = {
    el, content, dialog,
    close(result) {
      if (closed) return;
      closed = true;
      el.classList.add('is-closing');
      document.removeEventListener('keydown', onKey, true);
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      setTimeout(() => el.remove(), 170);
      onClose?.(result);
    },
    setLocked(v) { el.classList.toggle('is-locked', Boolean(v)); api.locked = Boolean(v); },
    locked,
  };
  const onKey = (e) => {
    if (stack[stack.length - 1] !== api) return;
    if (e.key === 'Escape' && !api.locked) { e.preventDefault(); api.close(); }
    if (e.key === 'Tab') trapFocus(e, dialog);
  };
  el.querySelector('.modal__close').addEventListener('click', () => !api.locked && api.close());
  el.querySelector('.modal__backdrop').addEventListener('click', () => !api.locked && api.close());
  document.addEventListener('keydown', onKey, true);
  api.setLocked(locked);
  root().appendChild(el);
  stack.push(api);
  requestAnimationFrame(() => (dialog.querySelector('[autofocus]') || dialog).focus());
  return api;
}

function trapFocus(e, dialog) {
  const f = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent);
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export const anyModalOpen = () => stack.length > 0;

/**
 * Confirmación con estilo. Devuelve true/false (o el valor del botón elegido).
 * buttons: [{ label, value, kind: 'primary'|'danger'|'ghost' }]
 */
export function confirm({ title, text = '', html = '', icon: ic = 'alert', danger = false, ok = 'Aceptar', cancel = 'Cancelar', buttons, extra = '' } = {}) {
  return new Promise((resolve) => {
    const btns = buttons || [
      ...(cancel ? [{ label: cancel, value: false, kind: 'ghost' }] : []),
      { label: ok, value: true, kind: danger ? 'danger' : 'primary' },
    ];
    const m = modal({
      size: 'sm',
      html: `
        <div class="confirm">
          <div class="confirm__icon ${danger ? 'is-danger' : ''}">${icon(ic)}</div>
          <h2 class="confirm__title">${esc(title)}</h2>
          ${text ? `<p class="confirm__text">${esc(text)}</p>` : ''}
          ${html ? `<div class="confirm__text">${html}</div>` : ''}
          ${extra ? `<div class="confirm__extra">${extra}</div>` : ''}
          <div class="modal__actions">
            ${btns.map((b, i) => `<button class="btn btn--${b.kind || 'ghost'}" data-i="${i}" type="button" ${i === btns.length - 1 ? 'autofocus' : ''}>${esc(b.label)}</button>`).join('')}
          </div>
        </div>`,
      onClose: (r) => resolve(r ?? (buttons ? null : false)),
    });
    m.content.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
      const v = btns[Number(b.dataset.i)].value;
      const inputs = {};
      m.content.querySelectorAll('.confirm__extra input').forEach((inp) => { inputs[inp.name] = inp.type === 'checkbox' ? inp.checked : inp.value; });
      m.close(extra ? { value: v, inputs } : v);
    }));
  });
}

export function alertBox(title, text, ic = 'info') {
  return confirm({ title, text, icon: ic, cancel: null, ok: 'Entendido' });
}

// ---------- Avisos ----------
export function toast(message, { kind = 'info', timeout = 4200, actions = [] } = {}) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  const ic = kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'info';
  el.className = `toast toast--${kind}`;
  el.innerHTML = `${icon(ic)}<div class="toast__body"><div>${esc(message)}</div>${actions.length ? `<div class="toast__actions">${actions.map((a, i) => `<button class="btn btn--sm ${i === 0 ? 'btn--primary' : ''}" data-i="${i}" type="button">${esc(a.label)}</button>`).join('')}</div>` : ''}</div>`;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  const close = () => { el.classList.remove('on'); setTimeout(() => el.remove(), 320); };
  el.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => { actions[Number(b.dataset.i)].onClick?.(); close(); }));
  if (timeout) setTimeout(close, timeout);
  return close;
}

export const toastError = (e, prefix = '') => toast(`${prefix}${e?.message || e}`, { kind: 'error', timeout: 6500 });

// ---------- Tooltips (atributo data-tip, opcional data-tip-sub) ----------
export function initTooltips() {
  const tip = document.getElementById('tooltip');
  let current = null;
  const show = (el) => {
    const text = el.dataset.tip;
    if (!text) return;
    current = el;
    tip.innerHTML = `${esc(text)}${el.dataset.tipSub ? `<small>${esc(el.dataset.tipSub)}</small>` : ''}`;
    const r = el.getBoundingClientRect();
    const side = el.closest('.rail') ? 'right' : 'top';
    tip.style.visibility = 'hidden';
    tip.classList.add('on');
    const t = tip.getBoundingClientRect();
    let x;
    let y;
    if (side === 'right') { x = r.right + 12; y = r.top + r.height / 2 - t.height / 2; }
    else { x = r.left + r.width / 2 - t.width / 2; y = r.top - t.height - 8; if (y < 40) y = r.bottom + 8; }
    x = Math.max(8, Math.min(window.innerWidth - t.width - 8, x));
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(40, y)}px`;
    tip.style.visibility = '';
  };
  const hide = () => { current = null; tip.classList.remove('on'); };
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el && el !== current) show(el);
    else if (!el && current) hide();
  });
  document.addEventListener('pointerdown', hide);
  window.addEventListener('blur', hide);
  return { refresh: () => current && show(current), hide };
}

// ---------- Menú contextual ----------
let openMenu = null;
export function menu(anchor, items) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = items.map((it, i) => (it === '-' ? '<div class="menu__sep"></div>'
    : `<button class="menu__item ${it.danger ? 'is-danger' : ''}" data-i="${i}" type="button" role="menuitem" ${it.disabled ? 'disabled' : ''}>${icon(it.icon || 'info')}<span>${esc(it.label)}</span></button>`)).join('');
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  let x = r.left;
  let y = r.bottom + 8;
  if (x + m.width > window.innerWidth - 8) x = r.right - m.width;
  if (y + m.height > window.innerHeight - 8) y = r.top - m.height - 8;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(44, y)}px`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    closeMenu();
    items[Number(b.dataset.i)].onClick?.();
  });
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escKey, true);
  });
  openMenu = el;
  return el;
}

function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
function escKey(e) { if (e.key === 'Escape') closeMenu(); }
export function closeMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', escKey, true);
}

// Botón con estado de carga mientras se ejecuta una acción.
export async function busy(btn, fn, label) {
  if (!btn) return fn();
  const prev = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${label ? `<span>${esc(label)}</span>` : ''}`;
  try { return await fn(); } finally {
    if (btn.isConnected) { btn.disabled = false; btn.innerHTML = prev; }
  }
}
