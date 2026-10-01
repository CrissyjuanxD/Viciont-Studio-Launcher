import { call, on, emit, state, setInstances, instance } from './api.js';
import { icon, hydrateIcons } from './icons.js';
import { esc, instIcon, mediaUrl, isVideo, bytes, speed } from './util.js';
import { initTooltips, toast, toastError, confirm, menu, anyModalOpen } from './ui.js';
import { initIdle, setEffects, startGlitchBursts, glitchTransition, bootScreen, isIdle, onIdleChange } from './fx.js';
import { createBackground } from './bg.js';
import { paintHead } from './skinart.js';
import * as loginView from './views/login.js';
import * as homeView from './views/home.js';
import * as instanceView from './views/instance.js';
import * as skinsView from './views/skins.js';
import * as adminView from './views/admin.js';
import { openSettings } from './views/settings.js';
import { crashModal } from './views/instance.js';

const VIEWS = { home: homeView, instance: instanceView, skins: skinsView, admin: adminView };
const $ = (id) => document.getElementById(id);
const permKey = (a) => JSON.stringify([Boolean(a?.unlocked), [...(a?.perms || [])].sort(), a?.scope ?? null]);

const scene = (() => {
  const root = $('scene');
  let currentKey = null;
  let video = null;
  const pauseVideo = (v) => { if (!video) return; if (v) video.pause(); else video.play().catch(() => {}); };
  onIdleChange((idle) => pauseVideo(idle));
  return {
    show(inst) {
      const bg = inst?.media?.background;
      const url = mediaUrl(bg);
      const key = url || null;
      if (key === currentKey) return;
      currentKey = key;
      const old = [...root.children];
      old.forEach((el) => { el.classList.remove('on'); setTimeout(() => el.remove(), 700); });
      video = null;
      if (!url) { app.bg.setPaused(false); return; }
      const layer = document.createElement('div');
      layer.className = 'scene__layer';
      if (isVideo(inst.media.backgroundType, bg)) {
        video = document.createElement('video');
        Object.assign(video, { src: url, muted: true, loop: true, autoplay: !isIdle(), playsInline: true, preload: 'auto' });
        video.setAttribute('muted', '');
        layer.appendChild(video);
        video.addEventListener('loadeddata', () => layer.classList.add('on'), { once: true });
        video.addEventListener('error', () => { layer.remove(); app.bg.setPaused(false); }, { once: true });
      } else {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        img.onload = () => layer.classList.add('on');
        img.onerror = () => { layer.remove(); app.bg.setPaused(false); };
        layer.appendChild(img);
      }
      root.appendChild(layer);
      layer.classList.add('is-glitching');
      setTimeout(() => layer.classList.remove('is-glitching'), 520);
      setTimeout(() => { if (currentKey === key) app.bg.setPaused(true); }, 800);
    },
    clear() {
      if (!currentKey) { app.bg.setPaused(false); return; }
      currentKey = null;
      video = null;
      [...root.children].forEach((el) => { el.classList.remove('on'); setTimeout(() => el.remove(), 700); });
      app.bg.setPaused(false);
    },
    pauseAll(v) { pauseVideo(v); },
  };
})();

let studioPromise = null;
let current = { name: null, cleanup: null, key: '' };

const app = {
  bg: null,
  scene,
  studio() { studioPromise ??= call('app:studio').catch(() => null); return studioPromise; },
  go(route, { instant = false } = {}) {
    const key = JSON.stringify(route);
    if (key === current.key) return;
    state.route = route;
    const swap = () => {
      try { current.cleanup?.(); } catch (e) { console.error(e); }
      const view = $('view');
      view.innerHTML = '<div class="view__inner"></div>';
      const inner = view.firstChild;
      const mod = VIEWS[route.name] || homeView;
      current = { name: route.name, key, cleanup: null };
      try { current.cleanup = mod.render(inner, route, app); } catch (e) { console.error(e); inner.innerHTML = `<div class="page"><div class="empty">${icon('alert')}<h3>Error</h3><p>${esc(e.message)}</p></div></div>`; }
      hydrateIcons(inner);
      paintRailActive();
      call('app:presence', { view: route.name, id: route.id || null }).catch(() => {});
    };
    if (instant || !current.name) swap(); else glitchTransition(swap);
  },
  async refreshInstances(force = false) {
    try {
      setInstances(await call(force ? 'instances:refresh' : 'instances:list'));
      if (!force) setInstances(await call('instances:refresh'));
    } catch (e) { toastError(e); }
  },
  async refreshAvatar() {
    const canvas = $('rail-avatar').querySelector('canvas');
    const acc = state.accounts.active;
    const btn = $('rail-avatar');
    btn.dataset.tip = acc ? acc.name : 'Sin sesión';
    btn.dataset.tipSub = acc ? (acc.type === 'microsoft' ? 'Cuenta de Microsoft' : 'Cuenta no premium') : '';
    $('rail-avatar-type').innerHTML = acc ? icon(acc.type === 'microsoft' ? 'microsoft' : 'user') : '';
    let cur = null;
    try { cur = await call('skins:current'); } catch { cur = null; }
    await paintHead(canvas, cur?.image || null);
  },
  async switchAccount(uuid) {
    const summary = await call('accounts:switch', uuid);
    state.accounts = summary;
    glitchTransition(() => app.onAccountChange());
    const name = summary.active?.name || '';
    const playing = state.instances.some((i) => i.status === 'running');
    toast(playing ? `Ahora usas la cuenta ${name}. El juego que está abierto sigue con la cuenta anterior.` : `Ahora usas la cuenta ${name}.`, { kind: 'success' });
    return summary;
  },
  onAccountChange() {
    if (!state.accounts.active) { showLogin(); return; }
    app.refreshAvatar();
    app.refreshInstances(true);
    app.refreshAdmin();
    if (current.name === 'home' || current.name === 'skins' || current.name === 'admin') { current.key = ''; app.go(current.name === 'admin' ? { name: 'home' } : state.route, { instant: true }); }
  },
  async refreshAdmin({ fresh = false } = {}) {
    let st;
    try { st = await call('admin:status', { fresh }); } catch { st = { access: false, unlocked: false, perms: [] }; }
    app.onAdminChange(Boolean(st?.unlocked), st);
    return state.admin;
  },
  onAdminChange(unlocked, st) {
    const before = permKey(state.admin);
    if (st) state.admin = st;
    state.admin = { ...(state.admin || {}), unlocked };
    if (!unlocked) state.admin.perms = [];
    state.info.admin = { ...(state.info.admin || {}), unlocked };
    $('rail-admin').hidden = !unlocked;
    paintTitlebar();
    if (!unlocked && current.name === 'admin') app.go({ name: 'home' });
    else if (permKey(state.admin) !== before) emit('admin-perms', state.admin);
  },
  addAccount() { showLogin({ canCancel: true }); },
  openSettings(tab) { return openSettings(app, tab); },
};

function paintRail() {
  const list = $('rail-list');
  const items = state.instances;
  list.innerHTML = items.map((i) => {
    const p = state.progress.get(i.id);
    const sub = { installing: `Descargando${p?.percent != null ? ` ${Math.floor(p.percent)}%` : '…'}`, update: 'Actualización disponible', running: 'Jugando ahora', installed: 'Lista para jugar', 'not-installed': 'Sin descargar', launching: 'Iniciando…' }[i.status] || '';
    const ring = i.status === 'installing'
      ? `<svg class="rail-inst__ring" viewBox="0 0 64 64"><circle class="bgc" cx="32" cy="32" r="30"/><circle class="fgc" cx="32" cy="32" r="30" stroke-dasharray="188.5" stroke-dashoffset="${188.5 * (1 - (p?.percent || 0) / 100)}"/></svg>` : '';
    const badge = i.status === 'update' ? '<span class="rail-inst__badge"></span>' : i.status === 'running' ? '<span class="rail-inst__badge is-running"></span>' : '';
    const tip = `${i.name}${i.test ? ' · copia de prueba' : ''}`;
    const tipSub = i.workspace && i.status === 'installed' ? 'Tu carpeta sincronizada' : sub;
    return `<button class="rail-inst" type="button" data-inst="${esc(i.id)}" data-tip="${esc(tip)}" data-tip-sub="${esc(tipSub)}" aria-label="${esc(tip)}"><span class="rail-inst__img">${instIcon(i)}</span>${ring}${badge}${i.test ? '<span class="rail-inst__tag">P</span>' : ''}</button>`;
  }).join('');
  paintRailActive();
}

function paintRailActive() {
  const r = state.route;
  $('rail-home').classList.toggle('is-active', r.name === 'home');
  $('rail-skins').classList.toggle('is-active', r.name === 'skins');
  $('rail-admin').classList.toggle('is-active', r.name === 'admin');
  document.querySelectorAll('.rail-inst').forEach((b) => b.classList.toggle('is-active', r.name === 'instance' && b.dataset.inst === r.id));
}

function updateRailProgress(p) {
  const b = document.querySelector(`.rail-inst[data-inst="${CSS.escape(p.id)}"]`);
  const c = b?.querySelector('.fgc');
  if (c && p.percent != null) c.setAttribute('stroke-dashoffset', String(188.5 * (1 - p.percent / 100)));
  if (b && p.percent != null) b.dataset.tipSub = `Descargando ${Math.floor(p.percent)}%`;
}

function paintTitlebar() {
  const box = $('titlebar-status');
  const chips = [];
  if (state.instancesMeta.error === 'EOFFLINE') chips.push(`<span class="chip chip--warn">${icon('alert')}Sin conexión</span>`);
  if (state.admin?.unlocked) chips.push(`<span class="chip">${icon('shield')}Admin</span>`);
  box.innerHTML = chips.join('');
  paintUpdateButton();
}

let tooltips = null;

function paintUpdateButton() {
  const b = $('upd-btn');
  const u = state.update;
  const starting = u?.onStart && !u.manual && !u.skipped && ['downloading', 'ready'].includes(u.status);
  const shown = !starting && ['downloading', 'ready', 'available'].includes(u?.status);
  b.hidden = !shown;
  if (!shown) return;
  const ready = u.status === 'ready' || u.status === 'available';
  const pct = ready ? 100 : Math.max(0, Math.min(100, Math.round(u.percent || 0)));
  b.classList.toggle('is-ready', ready);
  b.style.setProperty('--p', `${pct}%`);
  if (u.status === 'available') b.dataset.tipSub = `La versión ${u.version} está en la web de Viciont Studios: pulsa para descargarla.`;
  else if (ready) b.dataset.tipSub = `La versión ${u.version} ya está descargada: pulsa para actualizar.`;
  else b.dataset.tipSub = `Descargando la versión ${u.version || 'nueva'}… ${pct}%`;
  tooltips?.refresh();
}

function updatingScreen(version) {
  const el = document.createElement('div');
  el.className = 'updating';
  el.innerHTML = `
    <div class="updating__box">
      <img class="updating__logo" src="img/emblem.webp" alt="">
      <h2 class="updating__title">Actualizando</h2>
      <p class="updating__ver mono">Versión ${esc(version)}</p>
      <div class="updating__bar"><span></span></div>
      <p class="updating__text">El launcher se cerrará un momento y se volverá a abrir solo, ya actualizado.</p>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  return () => { el.classList.remove('on'); setTimeout(() => el.remove(), 250); };
}

let startBox = null;
let booted = false;
let notified = null;

function notifyUpdate() {
  const u = state.update;
  if (!booted || !u?.version || notified === u.version || (u.onStart && !u.skipped)) return;
  const ready = !u.manual && u.status === 'ready';
  const web = u.manual && u.status === 'available' && !u.onStart;
  if (!ready && !web) return;
  notified = u.version;
  toast(ready
    ? `La versión ${u.version} del launcher ya está descargada. Para instalarla, pulsa «Actualizar» aquí o «Hay una versión disponible», arriba a la izquierda.`
    : `Hay una versión nueva del launcher (${u.version}). Para descargarla, pulsa «Ver» aquí o «Hay una versión disponible», arriba a la izquierda.`,
  { kind: 'success', timeout: 12000, actions: [{ label: ready ? 'Actualizar' : 'Ver', onClick: () => onUpdateButton() }] });
}

function startUpdateScreen() {
  const el = document.createElement('div');
  el.className = 'updating updating--start';
  el.innerHTML = `
    <div class="updating__box">
      <img class="updating__logo" src="img/emblem.webp" alt="">
      <h2 class="updating__title">Actualizando</h2>
      <p class="updating__ver mono" data-f="ver"></p>
      <div class="updating__bar is-progress" data-f="bar"><span></span></div>
      <p class="updating__stats mono" data-f="stats"></p>
      <p class="updating__text" data-f="text"></p>
      <button class="btn btn--sm btn--ghost" type="button" data-f="skip">Seguir sin actualizar</button>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  const f = (n) => el.querySelector(`[data-f="${n}"]`);
  f('skip').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await call('app:skipStartUpdate'); } catch (er) { toastError(er); }
  });
  return {
    paint(u) {
      const installing = u.installing || u.status === 'ready';
      const pct = installing ? 100 : Math.max(0, Math.min(100, Math.round(u.percent || 0)));
      f('ver').textContent = `Versión ${u.version || ''}`;
      f('bar').classList.toggle('is-progress', !installing);
      f('bar').style.setProperty('--p', `${pct}%`);
      f('stats').textContent = installing ? '' : u.total ? `${bytes(u.transferred || 0)} de ${bytes(u.total)}${u.bps ? ` · ${speed(u.bps)}` : ''} · ${pct}%` : `${pct}%`;
      f('text').textContent = installing
        ? 'Instalando: el launcher se cerrará un momento y se volverá a abrir solo, ya actualizado.'
        : 'Hay una versión nueva del launcher. Se está descargando y se instalará sola en cuanto termine.';
      f('skip').hidden = installing;
    },
    close() { el.classList.remove('on'); setTimeout(() => el.remove(), 250); },
  };
}

function paintStartUpdate() {
  const u = state.update;
  if (!u?.onStart) return;
  if (u.manual) {
    if (!booted || u.status !== 'available') return;
    let asked = null;
    try { asked = localStorage.getItem('vsl-upd-asked'); } catch {}
    if (asked === u.version) return;
    try { localStorage.setItem('vsl-upd-asked', u.version); } catch {}
    onUpdateButton();
    return;
  }
  const show = !u.skipped && (u.status === 'downloading' || u.status === 'ready');
  if (show) {
    startBox ||= startUpdateScreen();
    startBox.paint(u);
    return;
  }
  if (!startBox) return;
  startBox.close();
  startBox = null;
  if (u.status === 'error') toast('No se pudo descargar la actualización del launcher. Se volverá a intentar la próxima vez que lo abras.', { kind: 'error', timeout: 8000 });
  else if (u.skipped) toast('La actualización se sigue descargando: se instalará al cerrar el launcher o cuando pulses «Hay una versión disponible».', { timeout: 8000 });
}

async function onUpdateButton() {
  const u = state.update;
  if (u?.status === 'available') {
    const how = state.info?.platform === 'linux'
      ? ' e instala el paquete nuevo (.deb o .rpm) encima del que tienes'
      : ', ábrela y arrastra el launcher a Aplicaciones para reemplazar el que tienes';
    const ok = await confirm({ title: 'Hay una versión nueva', text: `Descarga la versión ${u.version} desde la web de Viciont Studios${how}. Tus instancias y cuentas se conservan.`, ok: 'Ir a la descarga', icon: 'download' });
    if (ok) call('app:openDownload').catch(toastError);
    return;
  }
  if (u?.status !== 'ready') {
    if (state.accounts?.active && !$('shell').hidden) app.openSettings('launcher');
    return;
  }
  const ok = await confirm({ title: 'Actualizar el launcher', text: `El launcher se cerrará unos segundos para instalar la versión ${u.version}: verás el progreso en una ventanita y se volverá a abrir solo.`, ok: 'Actualizar ahora', icon: 'download' });
  if (!ok) return;
  const shownAt = Date.now();
  const close = updatingScreen(u.version);
  try {
    await call('app:installUpdate');
  } catch (e) {
    setTimeout(() => { close(); toastError(e); }, Math.max(0, 1200 - (Date.now() - shownAt)));
  }
}

let loginCleanup = null;
function closeLogin() {
  try { loginCleanup?.(); } catch (e) { console.error(e); }
  loginCleanup = null;
  const box = $('login');
  box.hidden = true;
  box.innerHTML = '';
}

function showLogin({ canCancel = false } = {}) {
  const box = $('login');
  closeLogin();
  $('shell').hidden = true;
  box.hidden = false;
  app.scene.clear();
  app.bg?.setMode('login');
  call('app:presence', { view: 'login' }).catch(() => {});
  loginCleanup = loginView.render(box, {
    canCancel,
    onCancel: () => {
      closeLogin();
      $('shell').hidden = false;
      call('app:presence', { view: state.route?.name || 'home', id: state.route?.id || null }).catch(() => {});
    },
    onDone: () => {
      closeLogin();
      showShell();
      toast(`¡Hola, ${state.accounts.active?.name}!`, { kind: 'success' });
    },
  });
}

function showShell() {
  $('login').hidden = true;
  $('shell').hidden = false;
  app.refreshAvatar();
  paintRail();
  current.key = '';
  app.go(state.route?.name && state.route.name !== 'admin' ? state.route : { name: 'home' }, { instant: true });
  app.refreshInstances(true);
  app.refreshAdmin();
}

on('instances', () => {
  paintRail();
  paintTitlebar();
  if (state.route.name === 'instance' && !instance(state.route.id)) app.go({ name: 'home' });
});
on('progress', updateRailProgress);
on('task-done', (d) => {
  const inst = instance(d.id);
  const name = inst?.name || d.id;
  if (d.ok && d.kind !== 'launch') toast(`${name} está lista para jugar.`, { kind: 'success', actions: state.route.id === d.id ? [] : [{ label: 'Ver', onClick: () => app.go({ name: 'instance', id: d.id }) }] });
  else if (d.cancelled) toast(`Descarga de ${name} pausada. Continuará donde se quedó.`);
  else if (!d.ok) toast(`No se pudo instalar ${name}: ${d.error}`, { kind: 'error', timeout: 9000, actions: [{ label: 'Reintentar', onClick: () => call('instances:install', d.id) }] });
});
on('accounts', () => { if (!$('shell').hidden) app.refreshAvatar(); });
on('update', () => { paintUpdateButton(); paintStartUpdate(); notifyUpdate(); });
on('admin-sync-revoked', (list) => {
  for (const x of list || []) toast(`${x.by || 'Viciont Studios'} revocó desde el panel tu sincronización de «${x.name}». Tu carpeta vuelve a ser una instancia normal y se actualizará como la de cualquier jugador.`, { kind: 'error', timeout: 12000 });
});
on('admin-locked', () => {
  app.onAdminChange(false);
  toast('Se cerró el modo administrador: tu clave o tus permisos cambiaron.', { kind: 'error', timeout: 8000 });
});
on('game', (d) => {
  if (d.state === 'running') {
    scene.pauseAll(true);
    app.bg.setPaused(true);
  } else if (d.state === 'exit') {
    scene.pauseAll(isIdle());
    if (state.route.name !== 'instance') app.bg.setPaused(false);
    if (d.crashed && d.duration < 6 * 60 * 60 * 1000) crashModal(d);
  }
});
on('close-requested', async () => {
  if (anyModalOpen() && document.querySelector('.modal.is-close-ask')) return;
  const ok = await confirm({
    title: 'Hay una descarga en curso',
    text: 'Si sales ahora, se pausa de forma segura: nada queda dañado y la próxima vez continuará donde se quedó.',
    ok: 'Pausar y salir', cancel: 'Seguir descargando', icon: 'pause',
  });
  call('app:closeDecision', Boolean(ok));
});
on('closing', () => toast('Pausando descargas de forma segura…', { timeout: 0 }));

async function boot() {
  const bootFx = bootScreen();
  hydrateIcons(document);
  initIdle();
  tooltips = initTooltips();
  $('upd-btn').addEventListener('click', onUpdateButton);
  try {
    const [info, settings, accounts, list] = await Promise.all([
      call('app:info'), call('settings:get'), call('accounts:get'), call('instances:list'),
    ]);
    state.info = info;
    document.documentElement.classList.toggle('os-mac', info.platform === 'darwin');
    state.settings = settings;
    state.accounts = accounts;
    state.update = info.update;
    setInstances(list);
    setEffects(settings.effects);
    $('app-version').textContent = `v${info.version}`;
    document.title = `Viciont Studios Launcher ${info.version}`;
    $('rail-admin').hidden = true;
  } catch (e) {
    console.error(e);
    toastError(e);
  }
  app.bg = createBackground($('bg'));
  startGlitchBursts();
  paintTitlebar();

  $('rail-home').addEventListener('click', () => app.go({ name: 'home' }));
  $('rail-skins').addEventListener('click', () => app.go({ name: 'skins' }));
  $('rail-admin').addEventListener('click', () => app.go({ name: 'admin' }));
  $('rail-settings').addEventListener('click', () => app.openSettings());
  $('rail-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-inst]');
    if (b) app.go({ name: 'instance', id: b.dataset.inst });
  });
  $('rail-avatar').addEventListener('click', (e) => {
    const { list, active } = state.accounts;
    menu(e.currentTarget, [
      ...list.filter((a) => !a.active).map((a) => ({ label: `Cambiar a ${a.name}`, icon: a.type === 'microsoft' ? 'microsoft' : 'user', onClick: () => app.switchAccount(a.uuid).catch(toastError) })),
      { label: 'Añadir otra cuenta', icon: 'plus', onClick: () => app.addAccount() },
      '-',
      { label: 'Cambiar skin', icon: 'shirt', onClick: () => app.go({ name: 'skins' }) },
      ...(active?.type === 'microsoft' ? [{ label: 'Ver perfil en NameMC', icon: 'external', onClick: () => call('app:openExternal', `https://namemc.com/profile/${encodeURIComponent(active.name)}`) }] : []),
      { label: 'Ajustes de la cuenta', icon: 'gear', onClick: () => app.openSettings('account') },
    ]);
  });
  $('rail-logout').addEventListener('click', async () => {
    const acc = state.accounts.active;
    if (!acc) return;
    const ms = acc.type === 'microsoft';
    const r = await confirm({
      title: '¿Cerrar sesión?',
      text: `Saldrás de ${acc.name} en este launcher.${acc.type === 'offline' ? ' Tu código de recuperación se queda guardado en este PC para que puedas volver a entrar con este nick. Si vas a jugar en otro PC, anótalo antes (Ajustes → Cuenta).' : ''}`,
      ok: 'Cerrar sesión', danger: true, icon: 'logout',
      extra: ms
        ? '<label class="check"><input type="checkbox" name="forget"> Olvidar también esta cuenta de Microsoft en este PC (recomendado si el PC es compartido: la próxima vez pedirá la contraseña)</label>'
        : '<label class="check"><input type="checkbox" name="forget"> Olvidar también este nick en este PC: se borra su código y el PC deja de reconocerlo (recomendado si el PC es compartido: para volver a entrar necesitarás el código)</label>',
    });
    if (!r?.value) return;
    try {
      state.accounts = await call('accounts:logout', acc.uuid, ms ? { forgetMicrosoft: Boolean(r.inputs?.forget) } : { forgetRecovery: Boolean(r.inputs?.forget) });
      app.onAccountChange();
    } catch (e) { toastError(e); }
  });

  if (!state.accounts.active) showLogin();
  else showShell();
  bootFx.done();
  booted = true;
  paintStartUpdate();
  if (state.info?.justUpdated) setTimeout(() => toast(`Launcher actualizado a la versión ${state.info.version}.`, { kind: 'success', timeout: 6000 }), 1200);
}

boot();
let adminCheckedAt = Date.now();
window.addEventListener('focus', () => {
  if (!state.accounts?.active || Date.now() - adminCheckedAt < 2 * 60 * 1000) return;
  adminCheckedAt = Date.now();
  app.refreshAdmin({ fresh: true });
});
const reportUi = (msg) => { try { call('app:uiError', String(msg).slice(0, 400)).catch(() => {}); } catch {} };
window.addEventListener('error', (e) => { console.error(e.error || e.message); reportUi(`${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno})`); });
window.addEventListener('unhandledrejection', (e) => { const m = e.reason?.message || String(e.reason); if (!/Acción|AbortError/.test(m)) reportUi(`Promesa: ${m}`); });
