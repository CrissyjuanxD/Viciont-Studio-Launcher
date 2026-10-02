import { call, on, pathFor, state } from '../api.js';
import { icon, hydrateIcons } from '../icons.js';
import { esc, bytes, speed, duration, coverMini, mediaUrl, isVideo, loaderLabel, LOADER_NAMES, timeAgo, debounce, fileManager } from '../util.js';
import { modal, toast, toastError, confirm, menu, busy, anyModalOpen } from '../ui.js';
import { diffLines, prettyIfJson } from '../linediff.js';

const FOLDERS = [
  ['mods', 'Mods', 'package'],
  ['resourcepacks', 'Resource packs', 'palette'],
  ['shaderpacks', 'Shaders', 'sun'],
  ['config', 'Configuración', 'code'],
  ['', 'Otros archivos', 'file'],
];

const POLICY = {
  always: { label: 'Se reemplaza en cada actualización', short: 'Reemplazar', icon: 'refresh' },
  once: { label: 'Solo la primera vez (el jugador puede cambiarlo)', short: 'Solo 1.ª vez', icon: 'lock' },
  merge: { label: 'Fusionar ajustes: el jugador solo recibe los que confirmes al publicar', short: 'Fusionar', icon: 'layers' },
};
const PROTECT_LOADERS = ['fabric', 'quilt'];
const BIN_RE = /\.(jar|zip|rar|7z|gz|png|jpe?g|gif|webp|bmp|ico|ogg|mp3|wav|mp4|webm|mov|avi|dat|dat_old|nbt|mca|mcr|class|exe|dll|so|ttf|otf|woff2?|pdf|bin|db|sqlite)$/i;
const DIFF_MAX = 2 * 1024 * 1024;
const fileIcon = (p) => (FOLDERS.find(([dir]) => dir && p.startsWith(`${dir}/`)) || FOLDERS[FOLDERS.length - 1])[2];
const canDiff = (f) => !BIN_RE.test(f.path) && !f.policyOnly && (f.size || 0) <= DIFF_MAX && (f.oldSize || 0) <= DIFF_MAX;

const can = (perm) => (state.admin?.perms || []).includes(perm);
const NEED_CREATE = 'Necesitas el permiso «Crear instancias»';
const NEED_EDIT = 'Necesitas el permiso «Editar y publicar»';
const ASK = 'Pídeselo a quien administra el panel web de Viciont Studios.';
let permsAt = 0;
const permsStale = () => Date.now() - permsAt > 15000;
const freshPerms = (app) => { permsAt = Date.now(); return app.refreshAdmin({ fresh: true }).catch(() => null); };
let deniedAt = 0;
const denied = (need) => {
  if (Date.now() - deniedAt < 2500) return;
  deniedAt = Date.now();
  toast(`${need}. ${ASK}`, { kind: 'error', timeout: 6000 });
};

const RO_SEL = ['apply-version', 'modrinth', 'upload', 'upload-folder', 'content-more'].map((a) => `[data-act="${a}"]`)
  .concat(['[data-l]', '[data-pick]', '[data-clear]', '[data-policy]', '[data-restore]', '[data-del]', '[data-incl]', '[data-excl]', '[data-v]', '#allow', '.media-pick']).join(', ');

const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

export function render(root, route, app) {
  app.scene.clear();
  app.bg.setMode('dim');
  if (route.id) return renderEditor(root, route.id, app, route);
  return renderList(root, app);
}

function renderList(root, app) {
  root.innerHTML = `
    <div class="page page--admin">
      <div class="page__head">
        <div><h1 class="title-lg">Administrar <span class="hl">instancias</span></h1><p class="lead">Cada instancia es una carpeta en tu PC: cámbiala como quieras (mods, configs, resource packs…), pruébala jugando y publica solo lo que cambió.</p></div>
        <div class="field__row" id="adm-head"></div>
      </div>
      <div id="adm-note"></div>
      <div class="admin-grid" id="adm-grid"><div class="empty"><span class="spin"></span><p>Cargando…</p></div></div>
      <div id="adm-storage"></div>
    </div>`;
  hydrateIcons(root);

  const paintHead = () => {
    const box = root.querySelector('#adm-head');
    box.innerHTML = `${can('players') ? `<button class="btn" type="button" data-act="players">${icon('users')}Jugadores</button>` : ''}
      ${can('create') ? `<button class="btn btn--primary" type="button" data-act="new">${icon('plus')}Nueva instancia</button>` : `<button class="btn btn--primary is-ro" type="button" data-act="new" data-tip="${NEED_CREATE}">${icon('lock')}Nueva instancia</button>`}`;
    hydrateIcons(box);
  };
  paintHead();

  let storage = null;
  const loadStorage = async (fresh = false) => {
    try { storage = await call('admin:storage', { fresh }); } catch { storage = null; }
    const box = root.querySelector('#adm-storage');
    if (box) { box.innerHTML = storage ? storageDock(storage) : ''; hydrateIcons(box); }
    return storage;
  };

  let loadedAt = 0;
  const load = async () => {
    const grid = root.querySelector('#adm-grid');
    loadedAt = Date.now();
    try {
      const r = await call('admin:list');
      const note = root.querySelector('#adm-note');
      note.innerHTML = r.error ? `<div class="banner-note">${icon('alert')}<span>${esc(r.error)}</span></div>` : '';
      const cards = r.published.map((p) => {
        const l = p.local || {};
        const iconUrl = mediaUrl(p.media?.icon);
        const pending = (l.changes || 0) > 0 || l.dirtyMeta;
        return `<button class="acard" type="button" data-open="${esc(p.id)}">
          <div class="acard__icon">${iconUrl ? `<img src="${iconUrl}" alt="">` : coverMini(p.name)}</div>
          <div style="min-width:0"><div class="acard__name">${esc(p.name)}</div>
            <div class="acard__meta">
              <span class="tag">v${esc(p.version)}</span>
              <span class="tag">${esc(p.mc)} · ${esc(loaderLabel(p.loader))}</span>
              <span class="tag">${p.visibility === 'private' ? `${icon('lock')} privada (${(p.allow || []).length}${p.discord?.length ? ' + Discord' : ''})` : `${icon('globe')} pública`}</span>
              ${l.synced ? `<span class="tag">${icon('refresh')} sincronizada</span>` : ''}
              ${l.behind ? '<span class="chip chip--hot">hay una versión más nueva</span>' : ''}
              ${pending ? `<span class="chip chip--hot">${l.changes ? `${l.changes} cambio(s)` : 'cambios'} sin publicar</span>` : ''}
            </div></div>
        </button>`;
      });
      for (const d of r.drafts) {
        cards.push(`<button class="acard" type="button" data-open="${esc(d.id)}">
          <div class="acard__icon">${coverMini(d.name || d.id)}</div>
          <div style="min-width:0"><div class="acard__name">${esc(d.name || d.id)}</div>
            <div class="acard__meta"><span class="chip chip--hot">nueva · sin publicar</span>${d.local?.synced ? `<span class="tag">${d.local.changes} archivo(s)</span>` : ''}<span class="tag">editada ${esc(timeAgo(d.updatedAt))}</span></div></div>
        </button>`);
      }
      if (can('create')) cards.push(`<button class="acard acard--new" type="button" data-act="new">${icon('plus')}<span>Crear una instancia nueva</span></button>`);
      else if (cards.length) cards.push(`<button class="acard acard--new is-ro" type="button" data-act="new" data-tip="${NEED_CREATE}">${icon('lock')}<span>Crear una instancia nueva</span></button>`);
      if (!cards.length) cards.push(`<div class="empty">${icon('lock')}<h3>Sin instancias</h3><p>Todavía no tienes permisos sobre ninguna instancia.</p></div>`);
      grid.innerHTML = cards.join('');
      hydrateIcons(grid);
    } catch (e) {
      grid.innerHTML = `<div class="empty">${icon('alert')}<h3>No se pudo cargar</h3><p>${esc(e.message)}</p></div>`;
      hydrateIcons(grid);
      if (e.code === 'ELOCKED' || e.code === 'EBADKEY' || e.code === 'ENOACCESS') app.onAdminChange(false);
    }
  };

  root.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { app.go({ name: 'admin', id: open.dataset.open }); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'new') {
      if (permsStale()) await busy(b, () => freshPerms(app));
      if (can('create')) newInstanceModal(app); else denied(NEED_CREATE);
    }
    if (b.dataset.act === 'players' && can('players')) playersModal();
    if (b.dataset.act === 'storage' && storage) storageModal(storage, { reload: () => loadStorage(true), onChange: load });
  });
  load();
  loadStorage();
  if (permsStale()) freshPerms(app);
  const offs = [
    on('admin-perms', () => { paintHead(); load(); loadStorage(); }),
    on('focus', (f) => {
      if (!f) return;
      if (permsStale()) freshPerms(app);
      if (Date.now() - loadedAt > 10000) load();
    }),
  ];
  return () => offs.forEach((off) => off());
}

const pct = (used, limit) => (limit ? Math.min(1, used / limit) : 0);
const level = (p) => (p >= 1 ? 'is-full' : p >= 0.8 ? 'is-warn' : '');
const pctLabel = (used, limit) => {
  const p = limit ? (used / limit) * 100 : 0;
  return p > 0 && p < 1 ? '<1 %' : `${Math.round(p)} %`;
};
const num = (n) => Number(n || 0).toLocaleString('es-ES');

function ringSvg(parts) {
  return `<svg class="sring" viewBox="0 0 64 64" aria-hidden="true">${parts.map(({ r, w, p, cls }) => {
    const len = 2 * Math.PI * r;
    return `<circle class="sring__bg" cx="32" cy="32" r="${r}" stroke-width="${w}"/><circle class="sring__fg ${cls || ''}" cx="32" cy="32" r="${r}" stroke-width="${w}" stroke-dasharray="${len.toFixed(2)}" stroke-dashoffset="${(len * (1 - p)).toFixed(2)}"/>`;
  }).join('')}</svg>`;
}

function storageDock(s) {
  const pr = pct(s.r2.used, s.r2.limit);
  const pd = s.d1 ? pct(s.d1.used, s.d1.limit) : 0;
  return `<button class="storage-dock ${level(Math.max(pr, pd))}" type="button" data-act="storage" data-tip="Almacenamiento del servidor: pulsa para ver el detalle y limpiar">
    <span class="storage-dock__ring">${ringSvg([{ r: 28, w: 5, p: pr, cls: level(pr) }, ...(s.d1 ? [{ r: 20, w: 3.5, p: pd, cls: `sring__fg--db ${level(pd)}` }] : [])])}<b>${pctLabel(s.r2.used, s.r2.limit)}</b></span>
    <span class="storage-dock__text"><b>${bytes(s.r2.used)}</b> de ${bytes(s.r2.limit)} en archivos<small>Base de datos: ${s.d1 ? `${bytes(s.d1.used)} de ${bytes(s.d1.limit)}` : '—'}</small></span>
  </button>`;
}

function storageModal(initial, { reload, onChange }) {
  let s = initial;
  const m = modal({ size: 'xl', html: '<div class="modal__body" id="stg"></div>' });
  const body = m.content.querySelector('#stg');
  const draw = () => {
    const { r2, d1 } = s;
    const pr = pct(r2.used, r2.limit);
    const pd = d1 ? pct(d1.used, d1.limit) : 0;
    const free = (n) => (n ? ` · <span class="stg-free">${bytes(n)} sin usar</span>` : '');
    const items = [
      ...r2.instances.map((i) => ({ name: i.name, sub: `${num(i.files)} archivos${free(i.reclaimable)}`, size: i.bytes, del: s.canDeleteInstances ? i.id : null })),
      ...(r2.otherInstances ? [{ name: 'Otras instancias', sub: 'no tienes permiso sobre ellas', size: r2.otherInstances }] : []),
      { name: 'Skins de los jugadores', sub: `${num(r2.skins.files)} archivos${free(r2.skins.reclaimable)}`, size: r2.skins.bytes },
      ...(r2.orphans?.bytes ? [{ name: 'Restos de instancias borradas', sub: `${num(r2.orphans.files)} archivos · <span class="stg-free">se pueden borrar</span>`, size: r2.orphans.bytes }] : []),
      ...(r2.crash?.bytes ? [{ name: 'Informes de error del juego', sub: `${num(r2.crash.files)} informes · se borran solos a los ${d1?.logDays || 30} días, con los registros`, size: r2.crash.bytes }] : []),
      { name: 'Otros', sub: 'lista de instancias, nicks registrados…', size: r2.other },
    ].filter((x) => x.size > 0 || x.del);
    const max = Math.max(1, ...items.map((x) => x.size));
    body.innerHTML = `
      <h2 class="modal__title">Almacenamiento del servidor</h2>
      <p class="modal__text">Lo que ocupa tu servidor de Viciont Studios en Cloudflare. Los mods de Modrinth no cuentan: se descargan de su web.</p>
      <div class="stg-grid">
        <section class="stg-card">
          <div class="stg-head">${ringSvg([{ r: 27, w: 6, p: pr, cls: level(pr) }])}
            <div><div class="stg-title">Archivos <span class="muted">(Cloudflare R2)</span></div>
              <div class="stg-big"><b>${bytes(r2.used)}</b> de ${bytes(r2.limit)} gratis · ${pctLabel(r2.used, r2.limit)}</div>
              <small class="muted">${num(r2.files)} archivos. Si pasas de lo gratis, Cloudflare cobra unos 0,015 USD por GB al mes.</small></div></div>
          <div class="stg-list">${items.map((x) => `<div class="stg-row">
            <div class="stg-row__name"><b>${esc(x.name)}</b><small>${x.sub}</small></div>
            <div class="stg-row__bar"><span style="width:${Math.max(1.5, (x.size / max) * 100).toFixed(1)}%"></span></div>
            <span class="stg-row__size">${bytes(x.size)}</span>
            <span class="stg-row__acts">${x.del ? `<button class="icon-btn is-danger" type="button" data-del-inst="${esc(x.del)}" data-name="${esc(x.name)}" data-size="${x.size}" data-tip="Eliminar la instancia del servidor">${icon('trash')}</button>` : ''}</span>
          </div>`).join('')}</div>
          <div class="stg-actions">${s.canClean
            ? (r2.reclaimable > 0 ? `<button class="btn btn--primary" type="button" data-clean>${icon('sparkle')}Limpiar archivos sin usar (libera ${bytes(r2.reclaimable)})</button>` : `<span class="field__hint">${icon('check')} No hay archivos sin usar.</span>`)
            : '<span class="field__hint">Para limpiar necesitas el permiso de eliminar.</span>'}</div>
        </section>
        <section class="stg-card">
          ${d1 ? `<div class="stg-head">${ringSvg([{ r: 27, w: 6, p: pd, cls: `sring__fg--db ${level(pd)}` }])}
            <div><div class="stg-title">Base de datos <span class="muted">(Cloudflare D1)</span></div>
              <div class="stg-big"><b>${bytes(d1.used)}</b> de ${bytes(d1.limit)} gratis · ${pctLabel(d1.used, d1.limit)}</div></div></div>
          <div class="stg-list">
            <div class="stg-row stg-row--plain"><div class="stg-row__name"><b>Registros</b><small>${num(d1.logs)}${d1.oldestLog ? ` · desde el ${new Date(d1.oldestLog).toLocaleDateString('es-ES')}` : ''} · se borran solos a los ${d1.logDays} días</small></div></div>
            <div class="stg-row stg-row--plain"><div class="stg-row__name"><b>Jugadores</b><small>${num(d1.players)} que han usado el launcher</small></div></div>
          </div>
          <div class="stg-actions">${s.canClean && s.global
            ? `<button class="btn" type="button" data-logs="7">${icon('trash')}Borrar los de más de 7 días</button><button class="btn btn--danger" type="button" data-logs="0">Borrar todos</button>`
            : `<span class="field__hint">${s.global ? 'No tienes permiso para borrar registros.' : 'Borrar registros solo lo puede hacer un administrador con acceso a todas las instancias.'}</span>`}</div>`
            : '<p class="field__hint">El servidor no tiene base de datos.</p>'}
        </section>
      </div>
      <div class="modal__actions"><span class="field__hint" style="margin-right:auto">Calculado ${esc(timeAgo(s.at))}</span><button class="btn btn--ghost" type="button" data-refresh>${icon('refresh')}Recalcular</button><button class="btn btn--primary" type="button" data-close>Cerrar</button></div>`;
    hydrateIcons(body);
  };
  const refresh = async (btn) => {
    const next = btn ? await busy(btn, reload) : await reload();
    if (next) { s = next; draw(); }
  };
  body.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) { m.close(); return; }
    const rb = e.target.closest('[data-refresh]');
    if (rb) { try { await refresh(rb); } catch (er) { toastError(er); } return; }
    const cb = e.target.closest('[data-clean]');
    if (cb) {
      const ok = await confirm({ title: '¿Limpiar archivos sin usar?', text: `Se borran ${bytes(s.r2.reclaimable)}: archivos de versiones anteriores, iconos y fondos que cambiaste, restos de instancias borradas y skins que ya no usa nadie. Los jugadores no notan nada.`, ok: 'Limpiar', icon: 'sparkle' });
      if (!ok) return;
      try {
        const r = await busy(cb, () => call('admin:cleanStorage'));
        toast(`Liberados ${bytes(r.freed)} (${num(r.deleted)} archivos).`, { kind: 'success' });
        await refresh();
      } catch (er) { toastError(er); }
      return;
    }
    const lb = e.target.closest('[data-logs]');
    if (lb) {
      const days = Number(lb.dataset.logs);
      const ok = await confirm({ title: days ? `¿Borrar los registros de más de ${days} días?` : '¿Borrar todos los registros?', text: 'Son los que usas en el panel para ayudar a los jugadores cuando algo falla (también se borran sus informes de error). No se pueden recuperar.', ok: 'Borrar', danger: true, icon: 'trash' });
      if (!ok) return;
      try {
        const r = await busy(lb, () => call('admin:cleanLogs', days));
        toast(`Borrados ${num(r.deleted)} registros${r.crashes ? ` y ${num(r.crashes)} informes de error` : ''}.`, { kind: 'success' });
        await refresh();
      } catch (er) { toastError(er); }
      return;
    }
    const db = e.target.closest('[data-del-inst]');
    if (db) {
      const ok = await confirm({ title: `¿Eliminar ${db.dataset.name}?`, text: `Desaparecerá para todos los jugadores y se borrarán sus archivos del servidor (${bytes(Number(db.dataset.size))}). Tu carpeta en este PC se queda. No se puede deshacer.`, ok: 'Eliminar', danger: true, icon: 'trash' });
      if (!ok) return;
      try {
        await busy(db, () => call('admin:remove', db.dataset.delInst));
        toast(`${db.dataset.name} eliminada del servidor.`, { kind: 'success' });
        onChange?.();
        await refresh();
      } catch (er) { toastError(er); }
    }
  });
  draw();
}

function versionPicker(container, initial = {}) {
  const st = { mc: initial.mc || '', loader: initial.loader?.type || 'fabric', loaderVersion: initial.loader?.version || '', snapshots: false };
  let mcList = [];
  container.innerHTML = `
    <div class="field"><span class="field__label">Versión de Minecraft <em>*</em></span>
      <div class="field__row"><select class="input select" data-f="mc"></select>
      <label class="check" style="white-space:nowrap"><input type="checkbox" data-f="snap"> Snapshots</label></div></div>
    <div class="field"><span class="field__label">Cargador de mods</span>
      <div class="segmented" data-f="loader">${Object.entries(LOADER_NAMES).map(([k, v]) => `<button type="button" data-l="${k}">${v}</button>`).join('')}</div></div>
    <div class="field" data-f="lv-box"><span class="field__label">Versión de ${'<span data-f="lname"></span>'} <em>*</em></span>
      <select class="input select" data-f="lv"><option>Cargando…</option></select>
      <span class="field__hint" data-f="lhint"></span></div>`;
  const q = (f) => container.querySelector(`[data-f="${f}"]`);
  const drawMc = () => {
    const list = mcList.filter((v) => st.snapshots || v.type === 'release' || v.id === st.mc);
    q('mc').innerHTML = list.map((v) => `<option value="${esc(v.id)}" ${v.id === st.mc ? 'selected' : ''}>${esc(v.id)}${v.type !== 'release' ? ` (${v.type})` : ''}</option>`).join('');
    if (!st.mc && list[0]) st.mc = list[0].id;
  };
  const drawLoader = async () => {
    container.querySelectorAll('[data-l]').forEach((b) => b.classList.toggle('is-active', b.dataset.l === st.loader));
    q('lv-box').hidden = st.loader === 'vanilla';
    q('lname').textContent = LOADER_NAMES[st.loader];
    if (st.loader === 'vanilla') { st.loaderVersion = ''; return; }
    const sel = q('lv');
    sel.innerHTML = '<option>Cargando…</option>';
    q('lhint').textContent = '';
    try {
      const list = await call('catalog:loaderVersions', st.loader, st.mc);
      if (!list.length) {
        sel.innerHTML = '<option value="">No disponible para esta versión</option>';
        st.loaderVersion = '';
        q('lhint').textContent = `${LOADER_NAMES[st.loader]} no tiene versiones para Minecraft ${st.mc}.`;
        return;
      }
      const pick = list.find((v) => v.version === st.loaderVersion) || list.find((v) => v.recommended) || list.find((v) => v.stable) || list[0];
      st.loaderVersion = pick.version;
      sel.innerHTML = list.slice(0, 300).map((v) => `<option value="${esc(v.version)}" ${v === pick ? 'selected' : ''}>${esc(v.version)}${v.recommended ? ' ★ recomendada' : v.latest ? ' (última)' : !v.stable ? ' (beta)' : ''}</option>`).join('');
    } catch (e) {
      sel.innerHTML = '<option value="">Error al cargar</option>';
      q('lhint').textContent = e.message;
    }
  };
  q('mc').addEventListener('change', () => { st.mc = q('mc').value; drawLoader(); });
  q('snap').addEventListener('change', () => { st.snapshots = q('snap').checked; drawMc(); });
  container.querySelectorAll('[data-l]').forEach((b) => b.addEventListener('click', () => { st.loader = b.dataset.l; drawLoader(); }));
  q('lv').addEventListener('change', () => { st.loaderVersion = q('lv').value; });
  call('catalog:mcVersions').then((l) => { mcList = l; drawMc(); drawLoader(); }).catch((e) => { q('mc').innerHTML = `<option>${esc(e.message)}</option>`; });
  return {
    value: () => ({ mc: st.mc, loader: { type: st.loader, version: st.loader === 'vanilla' ? '' : st.loaderVersion } }),
    set: (v) => {
      if (v.mc) st.mc = v.mc;
      if (v.loader?.type) st.loader = v.loader.type;
      st.loaderVersion = v.loader?.version || '';
      if (mcList.length) drawMc();
      drawLoader();
    },
  };
}

function newInstanceModal(app) {
  const m = modal({
    size: 'lg',
    html: `<div class="modal__body">
      <h2 class="modal__title">Nueva instancia</h2>
      <p class="modal__text">Se crea una carpeta en tu PC para esta instancia. Empieza desde cero o importa una que ya tengas (Modrinth App, CurseForge, Prism…).</p>
      <form id="nf" style="display:grid;gap:16px;margin-top:18px">
        <div class="mr-app-row" id="nf-mr">
          <span>${icon('download')}<b>¿La tienes en Modrinth App?</b> Elígela y se rellena todo sola.</span>
          <button class="btn btn--sm" type="button" data-mrapp>${icon('search')}Elegir de Modrinth App</button>
        </div>
        <div class="editor__cols">
          <label class="field"><span class="field__label">Nombre <em>*</em></span><input class="input" name="name" maxlength="60" required placeholder="Viciont Hardcore 4" autofocus></label>
          <label class="field"><span class="field__label">Identificador <em>*</em></span><input class="input mono" name="id" maxlength="48" required placeholder="viciont-hardcore-4"><span class="field__hint">Minúsculas, números y guiones. No se puede cambiar después.</span></label>
        </div>
        <div id="vp" style="display:grid;gap:16px"></div>
        <div id="nf-err"></div>
        <div class="modal__actions">
          <button class="btn btn--ghost" type="button" data-import="mrpack">${icon('package')}Importar .mrpack</button>
          <button class="btn btn--ghost" type="button" data-import="folder">${icon('folder')}Importar carpeta</button>
          <button class="btn btn--primary" type="submit">${icon('plus')}Crear</button>
        </div>
      </form></div>`,
  });
  const f = m.content.querySelector('#nf');
  const vp = versionPicker(m.content.querySelector('#vp'));
  let idTouched = false;
  let fromMr = null;
  f.name.addEventListener('input', () => { if (!idTouched) f.id.value = slugify(f.name.value); });
  f.id.addEventListener('input', () => { idTouched = true; f.id.value = slugify(f.id.value); });
  const drawMr = () => {
    const row = m.content.querySelector('#nf-mr');
    row.classList.toggle('is-picked', Boolean(fromMr));
    row.innerHTML = fromMr
      ? `<span>${fromMr.iconData ? `<img src="${fromMr.iconData}" alt="">` : icon('check')}Se importará <b>${esc(fromMr.name)}</b> de Modrinth App · Minecraft ${esc(fromMr.mc)} · ${esc(loaderLabel(fromMr.loader))}</span><button class="btn btn--sm btn--ghost" type="button" data-mrapp-clear>Quitar</button>`
      : `<span>${icon('download')}<b>¿La tienes en Modrinth App?</b> Elígela y se rellena todo sola.</span><button class="btn btn--sm" type="button" data-mrapp>${icon('search')}Elegir de Modrinth App</button>`;
    f.querySelector('[type="submit"]').innerHTML = `${icon('plus')}${fromMr ? 'Crear e importar' : 'Crear'}`;
    hydrateIcons(m.content);
  };
  m.content.querySelector('#nf-mr').addEventListener('click', async (e) => {
    if (e.target.closest('[data-mrapp-clear]')) { fromMr = null; drawMr(); return; }
    if (!e.target.closest('[data-mrapp]')) return;
    const inst = await pickModrinthInstance();
    if (!inst) return;
    fromMr = inst;
    f.name.value = inst.name;
    if (!idTouched) f.id.value = slugify(inst.name);
    if (inst.mc) vp.set({ mc: inst.mc, loader: inst.loader });
    drawMr();
  });
  const create = async (btn) => {
    const v = vp.value();
    const id = slugify(f.id.value || f.name.value);
    if (!f.name.value.trim() || !id) throw new Error('Pon un nombre para la instancia.');
    if (!v.mc) throw new Error('Elige la versión de Minecraft.');
    if (v.loader.type !== 'vanilla' && !v.loader.version) throw new Error('Esa combinación de versión y cargador no está disponible.');
    await busy(btn, () => call('admin:create', { id, name: f.name.value.trim(), mc: v.mc, loader: v.loader }));
    return id;
  };
  const err = (e) => { m.content.querySelector('#nf-err').innerHTML = `<div class="form-error">${icon('alert')}<span>${esc(e.message)}</span></div>`; hydrateIcons(m.content); };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const id = await create(e.submitter);
      m.close();
      app.go(fromMr ? { name: 'admin', id, tab: 'content', import: 'modrinth-app', mr: fromMr } : { name: 'admin', id, tab: 'content' });
    } catch (er) { err(er); }
  });
  m.content.querySelectorAll('[data-import]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const id = await create(b);
      m.close();
      app.go({ name: 'admin', id, tab: 'content', import: b.dataset.import });
    } catch (er) { err(er); }
  }));
}

async function playersModal() {
  const m = modal({
    size: 'lg',
    html: `<div class="modal__body"><h2 class="modal__title">Jugadores no premium</h2>
      <p class="modal__text">Nicks registrados en el launcher. Si alguien perdió su código de recuperación, libera su nick para que pueda volver a registrarlo.</p>
      <input class="input" id="pq" placeholder="Buscar nick…" style="margin-top:16px">
      <div id="pl" style="display:grid;gap:8px;margin-top:12px;max-height:50vh;overflow:auto"></div></div>`,
  });
  const list = m.content.querySelector('#pl');
  const load = async () => {
    list.innerHTML = '<span class="spin"></span>';
    try {
      const r = await call('admin:offlineAccounts', m.content.querySelector('#pq').value.trim());
      list.innerHTML = (r.accounts || []).map((a) => `<div class="field__row" style="justify-content:space-between;padding:10px 12px;border:1px solid var(--line);border-radius:12px">
        <span><b>${esc(a.name)}</b> <span class="muted mono" style="font-size:.76rem">desde ${esc(new Date(a.createdAt).toLocaleDateString('es-ES'))}${a.skin ? ' · con skin' : ''}</span></span>
        <button class="btn btn--sm btn--danger" type="button" data-release="${esc(a.name)}">Liberar nick</button></div>`).join('') || '<p class="field__hint">No hay jugadores todavía.</p>';
    } catch (e) { list.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  };
  m.content.querySelector('#pq').addEventListener('input', debounce(load, 350));
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-release]');
    if (!b) return;
    const ok = await confirm({ title: `¿Liberar ${b.dataset.release}?`, text: 'Cualquiera podrá registrar ese nick de nuevo. Su skin se borrará.', ok: 'Liberar', danger: true });
    if (!ok) return;
    try { await call('admin:releaseNick', b.dataset.release); toast('Nick liberado.', { kind: 'success' }); load(); } catch (er) { toastError(er); }
  });
  load();
}

function renderEditor(root, id, app, route = {}) {
  let d = null;
  let tab = route.tab || 'general';
  let filter = '';
  let only = '';
  let syncing = false;
  const offs = [];
  const ws = () => d?.workspace || { synced: false };
  const ro = () => Boolean(d) && !can(d.baseVersion ? 'edit' : 'create');
  const need = () => (d?.baseVersion ? NEED_EDIT : NEED_CREATE);
  const lockIn = (box) => {
    if (!box || !ro()) return;
    box.querySelectorAll('input, textarea, select').forEach((el) => { if (el.id !== 'ffilter') el.disabled = true; });
    box.querySelectorAll('.switch').forEach((el) => el.classList.add('is-disabled'));
    box.querySelectorAll('.field__label, .panel__title > span:first-child').forEach((el) => {
      if (!el.querySelector('.ro-lock')) el.insertAdjacentHTML('beforeend', `<span class="ro-lock">${icon('lock')}</span>`);
    });
    box.querySelectorAll(RO_SEL).forEach((el) => {
      el.classList.add('is-ro');
      if (el.dataset.tip) el.dataset.tipSub = need(); else el.dataset.tip = need();
    });
  };

  let metaPatch = {};
  const flushMeta = debounce(async () => {
    const patch = metaPatch;
    metaPatch = {};
    try {
      const r = await call('admin:saveMeta', id, patch);
      d = { ...r, meta: { ...r.meta, allow: d.meta.allow, deny: d.meta.deny || [], discord: d.meta.discord || [] }, workspace: d.workspace };
      paintBar();
    } catch (e) { toastError(e); }
  }, 450);
  const saveMeta = (patch) => { metaPatch = { ...metaPatch, ...patch }; flushMeta(); };

  let acc = { s: '' };
  let accVer = 0;
  let accRetry = null;
  const paintAcc = () => {
    const label = {
      saving: '<span class="spin"></span>Guardando…',
      saved: `${icon('check')}Guardado`,
      error: `${icon('alert')}No se guardó`,
      draft: d?.baseVersion ? `${icon('alert')}Sin guardar` : 'Se aplica al publicar',
    }[acc.s] || '';
    const tip = acc.s === 'error'
      ? `${acc.error || 'No se pudo conectar con el servidor'}. Se vuelve a intentar sola; también puedes pulsar «Guardar solo textos y permisos».`
      : acc.s === 'draft' && d?.baseVersion ? 'Pulsa «Guardar solo textos y permisos» para aplicarlo. Con el servidor 12 o más nuevo se guarda solo.' : '';
    const cls = acc.s === 'draft' && !d?.baseVersion ? 'later' : acc.s;
    document.querySelectorAll('[data-acc-state]').forEach((el) => {
      el.className = `save-state${cls ? ` is-${cls}` : ''}`;
      el.innerHTML = label;
      if (tip) el.dataset.tip = tip; else delete el.dataset.tip;
      hydrateIcons(el);
    });
  };
  const pushAccess = debounce(async () => {
    const ver = accVer;
    let next;
    try {
      const r = await call('admin:saveAccess', id, { allow: d.meta.allow, deny: d.meta.deny || [], discord: d.meta.discord || [] });
      d = { ...d, dirtyMeta: r.dirtyMeta, metaChanges: r.metaChanges, apiVersion: r.apiVersion };
      next = !r.access?.live ? { s: 'draft' } : r.access.saved ? { s: 'saved' } : { s: 'error', error: r.access.error };
    } catch (e) {
      next = { s: 'error', error: e.message };
      toastError(e);
    }
    if (ver !== accVer || !root.isConnected) return;
    acc = next;
    paintAcc();
    paintBar();
    clearTimeout(accRetry);
    if (acc.s === 'error') accRetry = setTimeout(() => { if (acc.s === 'error' && root.isConnected) saveAccess(); }, 8000);
  }, 400);
  const saveAccess = () => { accVer++; acc = { s: 'saving' }; paintAcc(); pushAccess(); };
  offs.push(() => clearTimeout(accRetry));

  let dcOn = null;
  let dcInfo = null;
  let dcKey = '';
  let dcAt = 0;
  let dcBusy = null;
  let redrawDc = null;
  let accessOpen = null;
  const loadDiscord = () => {
    dcBusy ??= call('admin:discord').then((r) => {
      dcInfo = r;
      const key = JSON.stringify([r.enabled, r.error, (r.channels || []).map((c) => [c.id, c.name, c.guild, c.nicks, c.people, c.error])]);
      if (key !== dcKey) { dcKey = key; redrawDc?.(); }
      accessOpen?.refresh();
      return dcInfo;
    }).finally(() => { dcAt = Date.now(); dcBusy = null; });
    return dcBusy;
  };
  const tickDiscord = () => {
    if (!d || !root.isConnected || (document.hidden && !window.__vslForceActive) || (d.apiVersion || 0) < 11) return;
    if (tab !== 'access' && !accessOpen) return;
    if (Date.now() - dcAt < (state.focused ? 5000 : 30000)) return;
    loadDiscord().catch(() => {});
  };
  const dcTimer = setInterval(tickDiscord, 1000);
  offs.push(() => clearInterval(dcTimer));
  const updateAccess = (patch) => {
    d.meta = { ...d.meta, ...patch };
    const seen = new Set();
    d.meta.deny = (d.meta.deny || []).filter((n) => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 500);
    saveAccess();
    paintBar();
    if (tab === 'access') drawTab();
  };

  const setWs = (w) => { if (w) d.workspace = w; };

  const draw = () => {
    const iconKey = d.media?.icon;
    const iconSrc = iconKey?.local ? `vsl-media://local/admin/${iconKey.name}` : mediaUrl(iconKey?.key);
    const w = ws();
    root.innerHTML = `
      <div class="editor">
        <div class="editor__head">
          <button class="btn btn--icon btn--ghost" type="button" data-act="back" data-tip="Volver">${icon('arrowLeft')}</button>
          <div class="acard__icon" style="width:44px;height:44px;border-radius:12px">${iconSrc ? `<img src="${iconSrc}" alt="">` : coverMini(d.meta.name)}</div>
          <div style="min-width:0;flex:1"><div class="title-md">${esc(d.meta.name)}</div>
            <div class="acard__meta" style="margin-top:4px"><span class="tag mono">${esc(d.id)}</span>${d.baseVersion ? `<span class="tag">publicada v${d.baseVersion}</span>` : '<span class="chip chip--hot">nueva</span>'}<span class="tag">${esc(d.meta.mc)} · ${esc(loaderLabel(d.meta.loader))}</span>${w.synced ? `<span class="tag">${icon('refresh')} sincronizada</span>` : ''}${ro() ? `<span class="tag tag--ro">${icon('lock')} solo lectura</span>` : ''}</div></div>
          ${w.synced ? `<button class="btn btn--sm btn--ghost" type="button" data-act="play-ws" data-tip="Juega con tu carpeta para probar los cambios">${icon('play')}Jugar</button>` : ''}
          ${d.baseVersion ? `<button class="btn btn--sm btn--ghost" type="button" data-act="test" data-tip="Instala otra copia como la de un jugador para probar las actualizaciones">${icon('eye')}Copia de prueba</button>` : ''}
          <button class="btn btn--sm btn--ghost" type="button" data-act="more">${icon('more')}</button>
        </div>
        <div class="editor__tabs">
          ${[['general', 'General', 'edit'], ['look', 'Apariencia', 'image'], ['content', 'Contenido', 'package'], ['access', 'Permisos', 'lock']]
            .map(([k, l, ic]) => `<button class="editor__tab ${tab === k ? 'is-active' : ''}" type="button" data-tab="${k}">${icon(ic)}${l}${k === 'content' ? '<span class="count"></span>' : ''}</button>`).join('')}
        </div>
        <div class="editor__body" id="ed-body"></div>
        <div class="pubbar"><div class="pubbar__info" id="ed-info"></div>
          <div class="field__row" id="ed-actions"></div></div>
      </div>`;
    hydrateIcons(root);
    drawTab();
    paintBar();
  };

  const paintBar = () => {
    const info = root.querySelector('#ed-info');
    if (!info) return;
    const w = ws();
    const files = w.files || [];
    const ch = w.changes || { total: 0 };
    const pending = ch.total > 0 || d.dirtyMeta;
    info.innerHTML = `${w.synced ? `<span><b>${files.length}</b> archivos</span><span><b>${bytes(files.reduce((a, f) => a + (f.size || 0), 0))}</b></span><span><b>${files.filter((f) => f.path.startsWith('mods/')).length}</b> mods</span>` : '<span>Sin sincronizar en este PC</span>'}
      ${pending ? `<button type="button" class="chip chip--hot" data-act="changes" data-tip="Ver qué cambió">${ch.total ? `${ch.total} cambio(s) de archivos` : ''}${ch.total && d.dirtyMeta ? ' + ' : ''}${d.dirtyMeta && d.baseVersion ? 'textos o permisos' : ''}${!d.baseVersion ? 'sin publicar' : ''}</button>` : `<span>${icon('check')} Todo publicado</span>`}
      <span>${d.meta.visibility === 'private' ? `${icon('lock')} privada · ${d.meta.allow.length} nick(s)${d.meta.discord?.length ? ' + Discord' : ''}` : `${icon('globe')} pública`}</span>`;
    const acts = root.querySelector('#ed-actions');
    const next = (d.baseVersion || 0) + 1;
    acts.innerHTML = ro()
      ? `${d.baseVersion && d.dirtyMeta ? `<button class="btn btn--ghost is-ro" type="button" data-act="meta-only" data-tip="${need()}">${icon('lock')}Guardar solo textos y permisos</button>` : ''}
        <button class="btn btn--primary is-ro" type="button" data-act="publish" data-tip="${need()}">${icon('lock')}Publicar versión ${next}</button>`
      : `${d.baseVersion && d.dirtyMeta ? `<button class="btn btn--ghost" type="button" data-act="meta-only" data-tip="Publica textos, imágenes y permisos sin subir una versión nueva">${icon('check')}Guardar solo textos y permisos</button>` : ''}
        <button class="btn btn--primary" type="button" data-act="publish" ${w.synced && !w.behind ? '' : 'disabled'} data-tip="${w.synced ? (w.behind ? 'Primero trae la versión más nueva' : 'Sube solo lo que cambió') : 'Primero sincroniza la instancia con tu PC'}">${icon('upload')}Publicar versión ${next}</button>`;
    hydrateIcons(info);
    hydrateIcons(acts);
    const c = root.querySelector('[data-tab="content"] .count');
    if (c) c.textContent = w.synced ? (ch.total ? `${ch.total}` : files.length) : '';
    c?.classList.toggle('count--hot', Boolean(ch.total));
  };

  const drawTab = () => {
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    const body = root.querySelector('#ed-body');
    if (!body) return;
    if (tab === 'general') tabGeneral(body);
    if (tab === 'look') tabLook(body);
    if (tab === 'content') tabContent(body);
    if (tab === 'access') tabAccess(body);
    if (ro()) {
      body.insertAdjacentHTML('afterbegin', `<div class="banner-note banner-note--ro">${icon('lock')}<span><b>Solo lectura.</b> ${d.baseVersion
        ? 'No tienes el permiso «Editar y publicar»: puedes ver toda la instancia, pero no cambiarla ni publicar versiones.'
        : 'No tienes el permiso «Crear instancias»: puedes ver esta instancia nueva, pero no cambiarla ni publicarla.'} ${ASK}</span></div>`);
      lockIn(body);
    }
    hydrateIcons(body);
  };

  const tabGeneral = (body) => {
    const mt = d.meta;
    body.innerHTML = `
      <div class="editor__cols">
        <label class="field"><span class="field__label">Nombre <em>*</em></span><input class="input" data-m="name" maxlength="60" value="${esc(mt.name)}"></label>
        <label class="field"><span class="field__label">Resumen (una frase)</span><input class="input" data-m="summary" maxlength="180" value="${esc(mt.summary)}" placeholder="El hardcore más difícil de Viciont Studios"></label>
      </div>
      <label class="field"><span class="field__label">Descripción</span><textarea class="input textarea" data-m="description" rows="5" maxlength="5000" placeholder="Explica de qué va la instancia. Usa **negrita**, pega enlaces (https://…) o escribe [texto](https://…), y deja una línea en blanco entre párrafos.">${esc(mt.description)}</textarea><span class="field__hint">Admite **negrita** y enlaces: pega la dirección (https://…) o escribe [texto](https://…). Los jugadores los abren con un clic.</span></label>
      <div class="panel"><div class="panel__title"><span>Versión del juego</span></div>
        <div id="ed-vp" style="display:grid;gap:14px"></div>
        <div class="field__row" style="margin-top:12px"><button class="btn btn--sm" type="button" data-act="apply-version">${icon('check')}Usar esta versión</button><span class="field__hint">Si cambias de versión, revisa que tus mods sean compatibles.</span></div>
      </div>
      <div class="editor__cols">
        <label class="field"><span class="field__label">RAM recomendada (MB)</span><input class="input mono" data-m="memory" type="number" min="0" step="512" value="${mt.memory?.recommended || ''}" placeholder="6144"><span class="field__hint">Se avisa al jugador si tiene menos asignada.</span></label>
        <label class="field"><span class="field__label">Servidor (IP)</span><input class="input mono" data-m="server" maxlength="120" value="${esc(mt.server)}" placeholder="play.viciont.net:25565"><span class="field__hint">Opcional: el juego entra directo al servidor al pulsar Jugar.</span></label>
      </div>
      <div class="editor__cols">
        <label class="field"><span class="field__label">Etiquetas</span><input class="input" data-m="tags" value="${esc((mt.tags || []).join(', '))}" placeholder="Hardcore, Evento, Serie"><span class="field__hint">Separadas por comas (máximo 6).</span></label>
        <label class="field"><span class="field__label">Orden en la lista</span><input class="input mono" data-m="order" type="number" value="${mt.order || 0}"><span class="field__hint">Las de número más bajo salen primero.</span></label>
      </div>
      <label class="field"><span class="field__label">Novedades de esta versión</span><textarea class="input textarea" data-m="changelog" rows="3" maxlength="2000" placeholder="Qué cambia para los jugadores al actualizar (se muestra en el botón Actualizar).">${esc(mt.changelog)}</textarea></label>`;
    const vp = versionPicker(body.querySelector('#ed-vp'), { mc: mt.mc, loader: mt.loader });
    body.querySelectorAll('[data-m]').forEach((el) => el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
      const k = el.dataset.m;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (k === 'memory') v = { recommended: Number(el.value) || 0 };
      if (k === 'tags') v = el.value.split(',').map((t) => t.trim()).filter(Boolean);
      if (k === 'order') v = Number(el.value) || 0;
      d.meta = { ...d.meta, [k]: v };
      saveMeta({ [k]: v });
    }));
    body.querySelector('[data-act="apply-version"]').addEventListener('click', async (e) => {
      const v = vp.value();
      if (v.loader.type !== 'vanilla' && !v.loader.version) { toast('Esa combinación no está disponible.', { kind: 'error' }); return; }
      try {
        d = { ...(await busy(e.currentTarget, () => call('admin:saveMeta', id, v))), workspace: d.workspace };
        toast(`Versión: Minecraft ${v.mc} · ${loaderLabel(v.loader)}`, { kind: 'success' });
        draw();
      } catch (er) { toastError(er); }
    });
  };

  const tabLook = (body) => {
    const src = (m) => (m?.local ? `vsl-media://local/admin/${m.name}` : mediaUrl(m?.key));
    const iconM = d.media?.icon;
    const bgM = d.media?.background;
    const bannerM = d.media?.banner;
    const bgIsVideo = bgM && isVideo(bgM.type, bgM.name || bgM.key);
    const bannerOk = (d.apiVersion || 0) >= 6;
    body.innerHTML = `
      <div class="look-grid">
        <div class="field"><span class="field__label">Icono</span>
          <div class="media-pick media-pick--icon ${iconM ? 'has-media' : ''}" data-pick="icon">
            ${iconM ? `<img src="${src(iconM)}" alt="">` : ''}
            <span class="media-pick__label">${icon('image')}${ro() ? 'Sin icono' : 'Elegir icono<small>PNG, JPG, WEBP o GIF</small>'}</span>
          </div>
          ${iconM ? '<button class="btn btn--sm btn--ghost" type="button" data-clear="icon">Quitar</button>' : ''}
        </div>
        <div class="field"><span class="field__label">Fondo de la instancia</span>
          <div class="media-pick media-pick--bg ${bgM ? 'has-media' : ''}" data-pick="background">
            ${bgM ? (bgIsVideo ? `<video src="${src(bgM)}" muted loop autoplay playsinline></video>` : `<img src="${src(bgM)}" alt="">`) : ''}
            <span class="media-pick__label">${icon('video')}${ro() ? 'Sin fondo' : 'Elegir fondo<small>Imagen, GIF o vídeo (MP4/WEBM, hasta 80 MB)</small>'}</span>
          </div>
          <div class="field__row">${bgM ? '<button class="btn btn--sm btn--ghost" type="button" data-clear="background">Quitar</button>' : ''}<span class="field__hint">Se ve detrás del botón Jugar. Las imágenes se optimizan solas; para vídeo usa algo corto que se pueda repetir en bucle.</span></div>
        </div>
        <div class="field"><span class="field__label">Banner de la tarjeta</span>
          <div class="media-pick media-pick--banner ${bannerM ? 'has-media' : ''} ${bannerOk ? '' : 'is-disabled'}" ${bannerOk ? 'data-pick="banner"' : ''}>
            ${bannerM ? `<img src="${src(bannerM)}" alt="">` : ''}
            <span class="media-pick__label">${icon('image')}${ro() ? 'Sin banner' : 'Elegir banner<small>PNG, JPG, WEBP o GIF</small>'}</span>
          </div>
          <div class="field__row">${bannerM ? '<button class="btn btn--sm btn--ghost" type="button" data-clear="banner">Quitar</button>' : ''}<span class="field__hint">Es la imagen de la tarjeta en <b>Inicio → Instancias disponibles</b> (se ve recortada a 16:9). Si no eliges ninguno, se usa el fondo.</span></div>
          ${bannerOk ? '' : `<p class="inst__warn">${icon('alert')}Para usarlo hay que actualizar el servidor de Viciont Studios (versión 6 o más nueva).</p>`}
        </div>
      </div>`;
    body.querySelectorAll('[data-pick]').forEach((el) => el.addEventListener('click', () => pickMedia(el.dataset.pick)));
    body.querySelectorAll('[data-clear]').forEach((el) => el.addEventListener('click', async () => {
      d = { ...(await call('admin:clearMedia', id, el.dataset.clear)), workspace: d.workspace };
      draw();
    }));
  };

  const pickMedia = (kind) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = kind === 'background' ? 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm' : 'image/png,image/jpeg,image/webp,image/gif';
    inp.addEventListener('change', async () => {
      const file = inp.files[0];
      if (!file) return;
      const t = toast('Preparando imagen…', { timeout: 0 });
      try {
        const out = await processMedia(file, kind);
        d = { ...(await call('admin:setMedia', id, kind, out)), workspace: d.workspace };
        draw();
      } catch (e) { toastError(e); } finally { t(); }
    });
    inp.click();
  };

  const tabContent = (body) => {
    const w = ws();
    if (!w.synced) {
      const p = state.progress.get(id);
      const needPerm = Boolean(d.baseVersion) && (d.apiVersion || 0) >= 7 && !can('sync');
      body.innerHTML = `
        <div class="panel sync-panel">
          <div class="sync-panel__icon">${icon('refresh')}</div>
          <div>
            <h3 class="title-md">Sincroniza esta instancia con tu PC</h3>
            <p class="field__hint" style="margin-top:6px">Se ${d.baseVersion ? `descarga la versión publicada (v${d.baseVersion})` : 'crea la carpeta'} en tu PC. Desde ahí la cambias como quieras —desde aquí, desde el ${fileManager(state.info?.platform)} o jugando— y al publicar solo se sube lo que cambió. A los jugadores solo se les actualizan esos archivos.${d.baseVersion && (d.apiVersion || 0) >= 7 ? ' La sincronización queda registrada en el panel de Viciont Studios.' : ''}</p>
            ${d.sync?.revokedAt ? `<p class="inst__warn" style="margin-top:10px">${icon('alert')}${esc(d.sync.revokedBy || 'Viciont Studios')} revocó ${esc(timeAgo(d.sync.revokedAt))} tu sincronización de esta instancia desde el panel.</p>` : ''}
            ${needPerm ? `<p class="inst__warn" style="margin-top:10px">${icon('lock')}Para sincronizarla necesitas el permiso «Sincronizar con su carpeta». Pídeselo a quien administra el panel web de Viciont Studios.</p>` : ''}
            ${d.legacy ? `<p class="inst__warn" style="margin-top:10px">${icon('alert')}Tienes cambios de una versión anterior del launcher: al sincronizar se pasarán a tu carpeta.</p>` : ''}
            ${w.error ? `<div class="form-error" style="margin-top:10px">${esc(w.error)}</div>` : ''}
            <div class="field__row" style="margin-top:14px"><button class="btn btn--primary" type="button" data-act="sync" ${syncing || needPerm ? 'disabled' : ''}>${syncing ? '<span class="spin"></span>' : icon('download')}${syncing ? esc(p?.label || 'Sincronizando…') : 'Sincronizar con mi PC'}</button></div>
          </div>
        </div>${ro() && d.publishedFiles?.length ? `
        <div class="files" id="files">
          <div class="files__toolbar"><span class="files__title">${icon('package')}Contenido publicado (v${d.baseVersion})</span><input class="input" id="ffilter" placeholder="Filtrar…" value="${esc(filter)}" style="margin-left:auto"></div>
          <div id="flist"></div>
        </div>` : ''}`;
      if (body.querySelector('#flist')) {
        drawFiles(body);
        body.querySelector('#ffilter').addEventListener('input', debounce((e) => { filter = e.target.value.toLowerCase(); drawFiles(body); }, 150));
      }
      return;
    }
    const ch = w.changes || { total: 0 };
    body.innerHTML = `
      <div class="banner-note banner-note--sync">${icon('refresh')}<span><b>Sincronizada con tu carpeta.</b> Todo lo que cambies en ella —desde aquí, desde el ${fileManager(state.info?.platform)} o jugando— queda como cambios sin publicar.${w.dir ? `<small class="mono">${esc(w.dir)}</small>` : ''}</span>${d.baseVersion ? `<button class="btn btn--sm" type="button" data-act="unsync">${icon('eyeOff')}Dejar de sincronizar</button>` : ''}</div>
      ${w.behind ? `<div class="banner-note">${icon('alert')}<span>Otro administrador publicó la versión ${w.remoteVersion}. Tráela antes de publicar: lo que hayas cambiado tú se respeta.</span><button class="btn btn--sm btn--primary" type="button" data-act="pull">${icon('download')}Traer cambios</button></div>` : ''}
      <div class="files" id="files">
        <div class="files__toolbar">
          <button class="btn btn--sm btn--primary" type="button" data-act="modrinth">${icon('search')}Buscar en Modrinth</button>
          <button class="btn btn--sm" type="button" data-act="upload">${icon('upload')}Añadir archivos</button>
          <button class="btn btn--sm" type="button" data-act="upload-folder">${icon('folder')}Añadir carpeta</button>
          <button class="btn btn--sm btn--ghost" type="button" data-act="open-ws" data-tip="Abre tu carpeta en el ${fileManager(state.info?.platform)}: lo que cambies ahí también cuenta">${icon('external')}Abrir carpeta</button>
          <button class="btn btn--sm btn--ghost" type="button" data-act="rescan" data-tip="Vuelve a mirar qué cambió en la carpeta">${icon('refresh')}Comprobar</button>
          <button class="btn btn--sm btn--ghost" type="button" data-act="content-more">${icon('more')}</button>
          <input class="input" id="ffilter" placeholder="Filtrar…" value="${esc(filter)}" style="margin-left:auto">
        </div>
        <div class="files__summary">${ch.total
          ? `${icon('alert')}<span><b>${ch.total}</b> cambio(s) sin publicar:</span>${ch.added ? `<button type="button" class="state state--added ${only === 'added' ? 'is-on' : ''}" data-only="added" data-tip="Ver solo estos">${ch.added} nuevo(s)</button>` : ''}${ch.modified ? `<button type="button" class="state state--modified ${only === 'modified' ? 'is-on' : ''}" data-only="modified" data-tip="Ver solo estos">${ch.modified} modificado(s)</button>` : ''}${ch.removed ? `<button type="button" class="state state--removed ${only === 'removed' ? 'is-on' : ''}" data-only="removed" data-tip="Ver solo estos">${ch.removed} se quitará(n)</button>` : ''}${only ? `<button type="button" class="chip chip--add" data-only="">${icon('close')}Mostrar todo</button>` : ''}<button class="btn btn--sm" type="button" data-act="changes">${icon('eye')}Ver cambios</button>`
          : `${icon('check')}<span>Tu carpeta está igual que la versión ${d.baseVersion ? `publicada (v${d.baseVersion})` : 'guardada'}.</span>`}</div>
        <div id="flist"></div>
      </div>
      <div class="panel" style="margin-top:14px">
        <div class="panel__title"><span>Qué se publica de tu carpeta</span></div>
        <div class="chips-list" id="incl"></div>
        ${w.candidates?.length ? `<p class="field__hint" style="margin-top:12px">Estas carpetas están en tu PC pero <b>no</b> se publican (por ejemplo mundos o mapas de minimapas). Añádelas solo si quieres repartirlas:</p><div class="chips-list" id="cand" style="margin-top:8px"></div>` : ''}
      </div>
      <p class="field__hint">${ro() ? '' : 'Arrastra archivos aquí para añadirlos. '}<b>Reemplazar</b> = se sobrescribe en cada actualización. <b>Solo la 1.ª vez</b> = el jugador puede cambiarlo. <b>Fusionar</b> (options.txt) = el jugador solo recibe los ajustes que confirmes al publicar y conserva los suyos (teclas, volumen…). Los mods de Modrinth se descargan desde su CDN: no ocupan espacio en tu servidor.</p>`;
    drawFiles(body);
    drawIncl(body);
    body.querySelector('#ffilter').addEventListener('input', debounce((e) => { filter = e.target.value.toLowerCase(); drawFiles(body); }, 150));
    const zone = body.querySelector('#files');
    zone.addEventListener('dragover', (e) => { e.preventDefault(); if (!ro()) zone.classList.add('drop-hint'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drop-hint'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('drop-hint');
      if (ro()) { denied(need()); return; }
      const paths = [...e.dataTransfer.files].map((f) => pathFor(f)).filter(Boolean);
      if (!paths.length) return;
      const target = await askFolder(paths.every((p) => /\.jar$/i.test(p)) ? 'mods' : '');
      if (target == null) return;
      await addPaths(paths, target);
    });
  };

  const drawIncl = (body) => {
    const w = ws();
    const box = body.querySelector('#incl');
    if (box) {
      const present = new Set((w.files || []).map((f) => f.path.split('/')[0].toLowerCase()));
      const shown = (w.include || []).filter((n) => present.has(n.toLowerCase()));
      box.innerHTML = shown.map((n) => `<span class="chip">${icon('folder')}${esc(n)}<button class="chip__x" type="button" data-excl="${esc(n)}" data-tip="No publicar">${icon('close')}</button></span>`).join('') || '<span class="field__hint">Aún no hay nada en tu carpeta.</span>';
    }
    const cand = body.querySelector('#cand');
    if (cand) {
      cand.innerHTML = w.candidates.map((c) => `<button class="chip chip--add" type="button" data-incl="${esc(c.name)}" data-tip="Publicar también">${icon(c.dir ? 'folder' : 'file')}${esc(c.name)} <small>${c.dir ? `${c.count} archivos · ` : ''}${bytes(c.size)}</small>${icon('plus')}</button>`).join('');
    }
    lockIn(box);
    lockIn(cand);
    hydrateIcons(body);
  };

  const addPaths = async (paths, target) => {
    const t = toast(`Añadiendo ${paths.length} elemento(s)…`, { timeout: 0 });
    try {
      const r = await call('admin:addPaths', id, paths, target);
      setWs(r.workspace);
      toast(`${r.added} archivo(s) añadidos a tu carpeta.`, { kind: 'success' });
      drawTab();
      paintBar();
    } catch (er) { toastError(er); } finally { t(); }
  };

  const drawFiles = (body) => {
    const list = body.querySelector('#flist');
    if (!list) return;
    const pubList = !ws().synced;
    const w = pubList ? { files: (d.publishedFiles || []).map((f) => ({ ...f, state: 'same' })), removed: [] } : ws();
    const all = w.files || [];
    const match = (f) => !filter || f.path.toLowerCase().includes(filter) || (f.title || '').toLowerCase().includes(filter);
    const files = only === 'removed' ? [] : all.filter((f) => match(f) && (!only || f.state === only));
    const removed = !only || only === 'removed' ? (w.removed || []).filter(match) : [];
    if (!all.length && !(w.removed || []).length) {
      list.innerHTML = `<div class="empty" style="margin:14px;border-radius:12px">${icon('package')}<h3>Carpeta vacía</h3><p>${ro() ? 'Todavía no hay archivos en esta carpeta.' : 'Busca mods en Modrinth, añade tus archivos, importa una instancia o abre la carpeta y pon ahí lo que quieras.'}</p></div>`;
      hydrateIcons(list);
      return;
    }
    if (!files.length && !removed.length) {
      list.innerHTML = `<div class="empty" style="margin:14px;border-radius:12px">${icon('search')}<p>No hay archivos con este filtro.</p></div>`;
      hydrateIcons(list);
      return;
    }
    const groups = FOLDERS.map(([dir, label, ic]) => {
      const items = files.filter((f) => (dir ? f.path.startsWith(`${dir}/`) : !FOLDERS.some(([x]) => x && f.path.startsWith(`${x}/`))));
      return { dir, label, ic, items };
    }).filter((g) => g.items.length);
    const stateBadge = (s) => (s === 'added' ? '<span class="state state--added">Nuevo</span>' : s === 'modified' ? '<span class="state state--modified">Modificado</span>' : '');
    list.innerHTML = groups.map((g) => `
      <div class="files__group">
        <div class="files__ghead">${icon(g.ic)}${esc(g.label)} <span class="muted">${g.items.length} · ${bytes(g.items.reduce((a, f) => a + (f.size || 0), 0))}</span></div>
        ${g.items.sort((a, b) => a.path.localeCompare(b.path)).map((f) => {
          const name = f.title || f.path.split('/').pop();
          const src = f.source === 'modrinth' ? '<span class="src src--modrinth">Modrinth</span>' : '<span class="src src--upload">Propio</span>';
          const keys = w.merge?.[f.path];
          const kept = w.mergeKept?.[f.path];
          return `<div class="frow ${f.state !== 'same' ? `frow--${f.state}` : ''}">
            <div class="frow__icon">${f.icon ? `<img src="${esc(f.icon)}" alt="" loading="lazy">` : icon(g.ic)}</div>
            <div class="frow__name"><b>${esc(name)}</b><small>${esc(f.path)}${f.versionName ? ` · ${esc(f.versionName)}` : ''}${keys ? ` · <a href="#" data-keys="${esc(f.path)}">${keys.length} ajuste(s) cambiado(s)</a>` : ''}${kept ? ` · <a href="#" data-keys="${esc(f.path)}">${kept.length} solo en tu PC</a>` : ''}</small></div>
            <span class="frow__badges">${stateBadge(f.state)}${src}</span>
            <span class="frow__size">${bytes(f.size || 0)}</span>
            <span class="field__row" style="gap:2px">
              ${f.state !== 'same' && canDiff(f) ? `<button class="icon-btn" type="button" data-fdiff="${esc(f.path)}" data-tip="${f.state === 'added' ? 'Ver su contenido' : 'Ver qué cambió'}">${icon('eye')}</button>` : ''}
              <button class="icon-btn" type="button" data-policy="${esc(f.path)}" data-tip="${esc(POLICY[f.policy]?.label || '')}">${icon(POLICY[f.policy]?.icon || 'refresh')}</button>
              ${f.state !== 'same' && d.baseVersion ? `<button class="icon-btn" type="button" data-restore="${esc(f.path)}" data-tip="${f.state === 'added' ? 'Quitar (no estaba publicado)' : 'Deshacer: dejarlo como está publicado'}">${icon('history')}</button>` : ''}
              ${pubList ? '' : `<button class="icon-btn is-danger" type="button" data-del="${esc(f.path)}" data-tip="Quitar (va a la Papelera)">${icon('trash')}</button>`}
            </span>
          </div>`;
        }).join('')}
      </div>`).join('') + (removed.length ? `
      <div class="files__group">
        <div class="files__ghead">${icon('trash')}Se quitarán al publicar <span class="muted">${removed.length}</span></div>
        ${removed.map((f) => `<div class="frow frow--removed">
          <div class="frow__icon">${f.icon ? `<img src="${esc(f.icon)}" alt="" loading="lazy">` : icon('file')}</div>
          <div class="frow__name"><b>${esc(f.title || f.path.split('/').pop())}</b><small>${esc(f.path)}</small></div>
          <span class="frow__badges"><span class="state state--removed">Se quitará</span></span>
          <span class="frow__size">${bytes(f.size || 0)}</span>
          <span class="field__row" style="gap:2px">${canDiff(f) ? `<button class="icon-btn" type="button" data-fdiff="${esc(f.path)}" data-tip="Ver lo que se quita">${icon('eye')}</button>` : ''}<button class="icon-btn" type="button" data-restore="${esc(f.path)}" data-tip="Recuperar">${icon('history')}</button></span>
        </div>`).join('')}
      </div>` : '');
    lockIn(list);
    hydrateIcons(list);
  };

  const tabAccess = (body) => {
    const mt = d.meta;
    const protectable = PROTECT_LOADERS.includes(mt.loader?.type);
    const v5 = (d.apiVersion || 0) >= 5;
    body.innerHTML = `
      <div class="panel">
        <div class="panel__title"><span>¿Quién puede ver esta instancia?</span></div>
        <div class="segmented" id="vis"><button type="button" data-v="public">${icon('globe')} Pública</button><button type="button" data-v="private">${icon('lock')} Privada</button></div>
        <p class="field__hint" style="margin-top:10px" id="vis-hint"></p>
      </div>
      <div class="panel" id="allow-box">
        <div class="panel__title"><span>Nicks con permiso</span><span class="field__row" style="gap:10px"><span data-acc-state></span><span class="muted mono" style="font-size:.8rem" id="allow-count"></span><button class="btn btn--sm btn--ghost" type="button" data-act="access-list" data-tip="Lista de todos los que pueden verla, también los de Discord">${icon('users')}Ver todos</button></span></div>
        <div class="chips-input" id="allow"><input placeholder="${ro() ? (mt.allow.length ? '' : 'Ningún nick') : 'Escribe un nick y pulsa Enter (o pega varios separados por comas)'}"></div>
        <p class="field__hint" id="allow-more" style="margin-top:8px" hidden></p>
        <p class="field__hint" style="margin-top:10px">Vale para cuentas de Microsoft y no premium: el jugador debe entrar al launcher con ese nick. Los nicks no premium están protegidos con su código de recuperación, así nadie puede hacerse pasar por otro. Los administradores de esta instancia la ven siempre.</p>
      </div>
      <div class="panel" id="dc-box">
        <div class="panel__title"><span>Acceso con Discord</span></div>
        <label class="switch"><input type="checkbox" id="dc-on"> Dar acceso a quien escriba su nick en un canal de Discord</label>
        <p class="field__hint" style="margin-top:6px">Viciont Studios Bot lee el canal: quien escriba ahí su nick de Minecraft puede ver la instancia en unos segundos, sin que tengas que añadirlo a mano. Cada persona puede apuntar hasta 5 nicks. Si borra su mensaje, pierde ese acceso. Para quitar a alguien concreto, usa «Ver todos».</p>
        <div id="dc-list" style="margin-top:12px"></div>
      </div>
      <div class="panel">
        <div class="panel__title"><span>Qué ven los jugadores de sus archivos</span></div>
        <label class="switch"><input type="checkbox" id="show-folder" ${mt.showFolder !== false ? 'checked' : ''}> Mostrar el botón «Carpeta» de la instancia</label>
        <p class="field__hint" style="margin:6px 0 12px">Si lo quitas, los jugadores no ven el botón para abrir la carpeta de la instancia (siguen pudiendo abrir sus mundos y capturas).</p>
        <div class="protect-list">
          <div>
            <label class="switch ${protectable ? '' : 'is-disabled'}"><input type="checkbox" data-protect="mods" ${mt.protect?.includes('mods') ? 'checked' : ''} ${protectable ? '' : 'disabled'}> Ocultar la carpeta «mods»</label>
            <p class="field__hint" style="margin-top:6px">${protectable
              ? 'La carpeta <b>mods</b> se ve vacía: el launcher guarda los mods en otro sitio del PC y el juego los carga igual.'
              : `Solo funciona con <b>Fabric</b> o <b>Quilt</b> (esta instancia usa ${esc(loaderLabel(mt.loader))}).`}</p>
          </div>
          <div>
            <label class="switch ${v5 ? '' : 'is-disabled'}"><input type="checkbox" data-protect="config" ${mt.protect?.includes('config') ? 'checked' : ''} ${v5 ? '' : 'disabled'}> Ocultar el contenido de «config»</label>
            <p class="field__hint" style="margin-top:6px">Las configs de los mods (y lo que guarden ahí, como vídeos o imágenes) se guardan en otro sitio del PC y el launcher solo las pone en su sitio mientras se juega; al cerrar el juego se quitan y se guarda lo que el jugador cambió (por ejemplo sus ajustes de vídeo). Las carpetas de config quedan ocultas en el Explorador también mientras se juega.</p>
          </div>
          <div>
            <label class="switch ${v5 ? '' : 'is-disabled'}"><input type="checkbox" data-protect="resourcepacks" ${mt.protect?.includes('resourcepacks') ? 'checked' : ''} ${v5 ? '' : 'disabled'}> Ocultar los resource packs</label>
            <p class="field__hint" style="margin-top:6px">Igual que config: solo están mientras se juega y no se ven en la carpeta <b>resourcepacks</b> del ${fileManager(state.info?.platform)} (ni desde el botón «Abrir carpeta de paquetes» del juego). Los packs que añada el jugador siguen funcionando.</p>
          </div>
          ${v5 ? '' : `<p class="inst__warn">${icon('alert')}Para ocultar config y resource packs, primero actualiza el servidor (pega el código nuevo en Cloudflare y pulsa Deploy).</p>`}
          <p class="field__hint">Dificulta que se copie el contenido privado o que se vean antes de tiempo las sorpresas de un evento, aunque nada de lo que se instala en el PC de alguien se puede proteger al 100%. Todo viene desactivado; los administradores, su carpeta sincronizada y los jugadores con el launcher antiguo lo ven todo. Usa «Copia de prueba» para verlo como un jugador.</p>
        </div>
      </div>`;
    const drawVis = () => {
      body.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('is-active', b.dataset.v === d.meta.visibility));
      body.querySelector('#vis-hint').textContent = d.meta.visibility === 'private'
        ? `Solo la verán (y podrán descargarla) los nicks de la lista${d.meta.discord?.length ? ' y los que estén en el canal de Discord' : ''}. Los archivos privados también están protegidos en el servidor.`
        : 'Cualquier jugador del launcher la verá y podrá descargarla.';
      const priv = d.meta.visibility === 'private';
      body.querySelector('#allow-box').style.opacity = priv ? '1' : '0.5';
      body.querySelector('#dc-box').style.opacity = priv ? '1' : '0.5';
    };
    const allowBox = body.querySelector('#allow');
    const input = allowBox.querySelector('input');
    const CHIPS = 24;
    const drawAllow = () => {
      allowBox.querySelectorAll('.chip').forEach((c) => c.remove());
      for (const n of d.meta.allow.slice(0, CHIPS)) {
        const c = document.createElement('span');
        c.className = 'chip';
        c.dataset.nick = n;
        c.innerHTML = ro() ? esc(n) : `${esc(n)} ${icon('close')}`;
        if (!ro()) c.title = 'Quitar';
        allowBox.insertBefore(c, input);
      }
      const more = body.querySelector('#allow-more');
      const extra = d.meta.allow.length - CHIPS;
      more.hidden = extra <= 0;
      if (extra > 0) more.innerHTML = `Y ${extra} nick(s) más. <a href="#" data-act="access-list">Verlos todos</a>`;
      body.querySelector('#allow-count').textContent = `${d.meta.allow.length} nick(s)${d.meta.discord?.length ? ' + Discord' : ''}`;
    };
    const setAllow = (list) => {
      const seen = new Set();
      d.meta.allow = list.filter((n) => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 500);
      d.meta.deny = (d.meta.deny || []).filter((n) => !seen.has(n.toLowerCase()));
      drawAllow();
      saveAccess();
      paintBar();
    };
    const dcSwitch = body.querySelector('#dc-on');
    const dcList = body.querySelector('#dc-list');
    if (dcOn == null) dcOn = Boolean(d.meta.discord?.length);
    const setDiscord = (ids) => {
      d.meta.discord = [...new Set(ids)].slice(0, 5);
      saveAccess();
      paintBar();
      drawAllow();
      drawVis();
    };
    const drawDiscord = async () => {
      if (!dcList.isConnected) return;
      dcSwitch.checked = dcOn;
      if ((d.apiVersion || 0) < 11) {
        dcSwitch.disabled = true;
        dcList.innerHTML = `<p class="inst__warn">${icon('alert')}Para usarlo hay que actualizar el servidor de Viciont Studios (versión 11 o más nueva).</p>`;
        hydrateIcons(dcList);
        return;
      }
      if (!dcOn) { dcList.innerHTML = ''; return; }
      if (!dcInfo) {
        dcList.innerHTML = '<p class="field__hint"><span class="spin"></span> Buscando los canales de nicks…</p>';
        try { await loadDiscord(); } catch (e) {
          dcList.innerHTML = `<div class="form-error">${icon('alert')}<span>${esc(e.message)}</span></div>`;
          hydrateIcons(dcList);
          return;
        }
        if (!dcList.isConnected || !dcInfo) return;
      }
      const chans = dcInfo.channels || [];
      const sel = new Set(d.meta.discord || []);
      const gone = [...sel].filter((x) => !chans.some((c) => c.id === x));
      if (!dcInfo.enabled) {
        dcList.innerHTML = `<p class="inst__warn">${icon('alert')}El servidor de Viciont Studios todavía no está conectado al bot de Discord (falta el enlace BOT_DB en Cloudflare).</p>`;
      } else if (!chans.length && !gone.length) {
        dcList.innerHTML = `<p class="field__hint">${dcInfo.error ? `${esc(dcInfo.error)} ` : ''}Todavía no hay ningún canal de nicks. Invita a <b>Viciont Studios Bot</b> a tu servidor de Discord y escribe <code>/nicks activar</code> en el canal donde la gente pone su nick.</p>`;
      } else {
        dcList.innerHTML = `<div class="dc-list">${chans.map((c) => `<label class="check dc-ch"><input type="checkbox" data-dc="${esc(c.id)}" ${sel.has(c.id) ? 'checked' : ''}><span><b>#${esc(c.name || c.id)}</b><small>${esc(c.guild || 'Discord')} · ${Number(c.nicks) || 0} nick(s)${c.people != null ? ` de ${Number(c.people) || 0} persona(s)` : ''}${c.error ? ` · ${esc(c.error)}` : ''}</small></span></label>`).join('')}
          ${gone.map((x) => `<label class="check dc-ch is-gone"><input type="checkbox" data-dc="${esc(x)}" checked><span><b>Canal ${esc(x)}</b><small>Viciont Studios Bot ya no lee este canal: desmárcalo</small></span></label>`).join('')}</div>
          ${sel.size ? '' : '<p class="field__hint" style="margin-top:8px">Marca el canal de nicks que da acceso a esta instancia.</p>'}`;
      }
      lockIn(dcList);
      hydrateIcons(dcList);
    };
    redrawDc = () => { if (dcOn && dcList.isConnected) drawDiscord(); };
    dcSwitch.addEventListener('change', async () => {
      dcOn = dcSwitch.checked;
      if (!dcOn) { if (d.meta.discord?.length) setDiscord([]); drawDiscord(); return; }
      await drawDiscord();
      if (!d.meta.discord?.length && dcInfo?.enabled && dcInfo.channels?.length === 1) { setDiscord([dcInfo.channels[0].id]); drawDiscord(); }
    });
    dcList.addEventListener('change', (e) => {
      if (!e.target.closest('[data-dc]')) return;
      setDiscord([...dcList.querySelectorAll('[data-dc]')].filter((x) => x.checked).map((x) => x.dataset.dc));
      drawDiscord();
    });
    body.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
      d.meta.visibility = b.dataset.v;
      drawVis();
      saveMeta({ visibility: b.dataset.v });
      paintBar();
    }));
    const addFromInput = () => {
      const parts = input.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      const valid = parts.filter((p) => /^[A-Za-z0-9_]{3,16}$/.test(p));
      if (parts.length && !valid.length) toast('Los nicks solo pueden tener letras, números y _ (3-16).', { kind: 'error' });
      if (valid.length) setAllow([...d.meta.allow, ...valid]);
      input.value = '';
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addFromInput(); }
      if (e.key === 'Backspace' && !input.value && d.meta.allow.length) setAllow(d.meta.allow.slice(0, -1));
    });
    input.addEventListener('paste', () => setTimeout(addFromInput, 0));
    input.addEventListener('blur', addFromInput);
    allowBox.addEventListener('click', (e) => {
      const c = e.target.closest('.chip[data-nick]');
      if (c) setAllow(d.meta.allow.filter((n) => n !== c.dataset.nick));
      else input.focus();
    });
    body.querySelector('#show-folder').addEventListener('change', (e) => {
      d.meta.showFolder = e.target.checked;
      saveMeta({ showFolder: e.target.checked });
    });
    body.querySelectorAll('[data-protect]').forEach((c) => c.addEventListener('change', () => {
      d.meta.protect = [...body.querySelectorAll('[data-protect]')].filter((x) => x.checked).map((x) => x.dataset.protect).sort();
      saveMeta({ protect: d.meta.protect });
    }));
    drawVis();
    drawAllow();
    drawDiscord();
    paintAcc();
  };

  const reload = async () => {
    d = await call('admin:open', id);
    acc = { s: '' };
    draw();
  };

  const refreshWs = async () => {
    try { setWs(await call('admin:workspace', id)); } catch (er) { toastError(er); return; }
    drawTab();
    paintBar();
  };

  const doSync = async () => {
    syncing = true;
    drawTab();
    const off = on(`progress:${id}`, () => { if (tab === 'content') { const b = root.querySelector('[data-act="sync"]'); const p = state.progress.get(id); if (b && p) b.lastChild.textContent = `${p.label || 'Descargando…'}${p.percent != null ? ` ${Math.floor(p.percent)}%` : ''}`; } });
    try {
      setWs(await call('admin:sync', id));
      d.legacy = false;
      toast('Instancia sincronizada: ya puedes cambiarla en tu carpeta.', { kind: 'success' });
    } catch (er) { toastError(er); } finally {
      off();
      syncing = false;
      draw();
    }
  };

  let scanAt = 0;
  let scanning = false;
  const autoScan = async () => {
    if (!d || !ws().synced || syncing || scanning || anyModalOpen() || Date.now() - scanAt < 2000) return;
    scanning = true;
    try {
      const before = JSON.stringify(d.workspace);
      const w = await call('admin:workspace', id);
      scanAt = Date.now();
      if (!d || JSON.stringify(w) === before) return;
      setWs(w);
      if (tab === 'content') {
        const y = root.scrollTop;
        const typing = document.activeElement?.id === 'ffilter';
        drawTab();
        if (root.scrollTop !== y) { root.style.scrollBehavior = 'auto'; root.scrollTop = y; root.style.scrollBehavior = ''; }
        if (typing) root.querySelector('#ffilter')?.focus();
      }
      paintBar();
    } catch {} finally { scanning = false; }
  };

  root.addEventListener('click', (e) => {
    const l = e.target.closest('.is-ro');
    if (!l || !root.contains(l)) return;
    e.preventDefault();
    e.stopPropagation();
    denied(need());
  }, true);

  root.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-tab]');
    if (tb) { tab = tb.dataset.tab; drawTab(); if (tab === 'content') autoScan(); return; }
    const keysLink = e.target.closest('[data-keys]');
    if (keysLink) { e.preventDefault(); okeysModal(id, d, keysLink.dataset.keys, refreshWs, ro()); return; }
    const onlyBtn = e.target.closest('[data-only]');
    if (onlyBtn) { only = onlyBtn.dataset.only === only ? '' : onlyBtn.dataset.only; drawTab(); return; }
    const fd = e.target.closest('[data-fdiff]');
    if (fd) {
      const w = ws();
      const f = [...(w.files || []), ...(w.removed || []).map((x) => ({ ...x, state: 'removed' }))].find((x) => x.path === fd.dataset.fdiff);
      if (f) diffModal(id, f);
      return;
    }
    const pol = e.target.closest('[data-policy]');
    if (pol) {
      const f = (ws().files || []).find((x) => x.path === pol.dataset.policy);
      const opts = ['always', 'once', ...(/\.(txt|properties|cfg|ini)$/i.test(f.path) ? ['merge'] : [])];
      menu(pol, opts.map((p) => ({ label: POLICY[p].label, icon: p === f.policy ? 'check' : POLICY[p].icon, onClick: async () => {
        try { setWs((await call('admin:setPolicy', id, f.path, p)).workspace); drawTab(); paintBar(); } catch (er) { toastError(er); }
      } })));
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      try { setWs((await call('admin:removeFiles', id, [del.dataset.del])).workspace); drawTab(); paintBar(); } catch (er) { toastError(er); }
      return;
    }
    const res = e.target.closest('[data-restore]');
    if (res) {
      try { setWs((await busy(res, () => call('admin:restoreFiles', id, [res.dataset.restore]))).workspace); drawTab(); paintBar(); } catch (er) { toastError(er); }
      return;
    }
    const inc = e.target.closest('[data-incl], [data-excl]');
    if (inc) {
      const name = inc.dataset.incl || inc.dataset.excl;
      if (inc.dataset.excl) {
        const ok = await confirm({ title: `¿Dejar de publicar «${name}»?`, text: 'Sus archivos se quitarán a los jugadores en la próxima versión. En tu PC no se borra nada.', ok: 'No publicar', icon: 'eyeOff' });
        if (!ok) return;
      }
      try { setWs((await call('admin:setInclude', id, name, Boolean(inc.dataset.incl))).workspace); drawTab(); paintBar(); } catch (er) { toastError(er); }
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'back') app.go({ name: 'admin' });
    if (act === 'changes') changesModal(id, d, refreshWs, ro());
    if (act === 'access-list') {
      e.preventDefault();
      accessModal({
        name: d.meta.name, getMeta: () => d.meta, update: updateAccess, ro: ro(), apiVersion: d.apiVersion,
        mode: !d.baseVersion ? 'draft' : (d.apiVersion || 0) >= 12 ? 'auto' : 'manual',
        channels: () => dcInfo?.channels || null,
        attach: (api) => {
          accessOpen = api;
          if (!api) return;
          paintAcc();
          if ((d.meta.discord || []).length && Date.now() - dcAt > 3000) loadDiscord().catch(() => {});
        },
      });
    }
    if (act === 'sync') doSync();
    if (act === 'unsync') {
      const pending = ws().changes?.total || 0;
      const ok = await confirm({
        title: '¿Dejar de sincronizar esta instancia?',
        text: `Tu carpeta dejará de ser la carpeta de trabajo de ${d.meta.name} y pasará a ser una instancia normal, que se actualiza sola como la de cualquier jugador.${pending ? ` Tienes ${pending} cambio(s) sin publicar: se perderán en la próxima actualización.` : ''} Podrás volver a sincronizarla cuando quieras${(d.apiVersion || 0) >= 7 ? ' si tienes el permiso «Sincronizar con su carpeta»' : ''}.`,
        ok: 'Dejar de sincronizar', danger: true, icon: 'eyeOff',
      });
      if (!ok) return;
      try { await busy(b, () => call('admin:unsync', id)); toast('Has dejado de sincronizar la instancia.', { kind: 'success' }); await reload(); } catch (er) { toastError(er); }
    }
    if (act === 'pull') {
      try {
        const r = await busy(b, () => call('admin:pull', id));
        setWs(r.workspace);
        await reload();
        toast(r.conflicts.length ? `Versión traída. Se mantuvieron tus cambios en: ${r.conflicts.slice(0, 4).join(', ')}${r.conflicts.length > 4 ? '…' : ''}` : 'Versión traída: tu carpeta está al día.', { kind: 'success', timeout: 8000 });
      } catch (er) { toastError(er); }
    }
    if (act === 'rescan') {
      try { setWs(await busy(b, () => call('admin:workspace', id))); drawTab(); paintBar(); } catch (er) { toastError(er); }
    }
    if (act === 'open-ws') call('admin:openFolder', id).catch(toastError);
    if (act === 'play-ws') {
      try { await busy(b, () => call('instances:play', id), 'Iniciando…'); toast('Juego iniciado con tu carpeta. Cuando cierres el juego, pulsa Comprobar para ver los cambios.', { kind: 'success', timeout: 7000 }); } catch (er) { toastError(er); }
    }
    if (act === 'test') {
      try {
        const tid = await busy(b, () => call('admin:testCopy', id));
        toast('Instalando la copia de prueba: así la verá un jugador.', { kind: 'success' });
        await app.refreshInstances(true);
        app.go({ name: 'instance', id: tid });
      } catch (er) { toastError(er); }
    }
    if (act === 'modrinth') modrinthModal(id, d, (w) => { setWs(w); drawTab(); paintBar(); });
    if (act === 'upload' || act === 'upload-folder') {
      const target = await askFolder(act === 'upload' ? 'mods' : '');
      if (target == null) return;
      try {
        const r = await call('admin:addFiles', id, target, act === 'upload-folder');
        if (r) { setWs(r.workspace); toast(`${r.added} archivo(s) añadidos a tu carpeta.`, { kind: 'success' }); drawTab(); paintBar(); }
      } catch (er) { toastError(er); }
    }
    if (act === 'content-more') {
      menu(b, [
        { label: 'Importar de Modrinth App', icon: 'download', onClick: async () => { const inst = await pickModrinthInstance(); if (inst) importFolder(id, (w) => { setWs(w); reload(); }, inst); } },
        { label: 'Importar instancia (carpeta)', icon: 'folder', onClick: () => importFolder(id, (w) => { setWs(w); reload(); }) },
        { label: 'Importar modpack .mrpack', icon: 'package', onClick: () => importMrpack(id, (w) => { setWs(w); reload(); }) },
        ...(d.baseVersion && ws().changes?.total ? ['-', { label: 'Deshacer todos los cambios', icon: 'history', danger: true, onClick: async () => {
          const ok = await confirm({ title: '¿Deshacer todos los cambios?', text: 'Tu carpeta volverá a estar como la versión publicada. Los archivos nuevos van a la Papelera.', ok: 'Deshacer', danger: true, icon: 'history' });
          if (!ok) return;
          const w = ws();
          const paths = [...w.files.filter((f) => f.state !== 'same').map((f) => f.path), ...w.removed.map((f) => f.path)];
          try { setWs((await call('admin:restoreFiles', id, paths)).workspace); drawTab(); paintBar(); } catch (er) { toastError(er); }
        } }] : []),
      ]);
    }
    if (act === 'publish') publish(id, d, async () => { await reload(); });
    if (act === 'meta-only') {
      try {
        await busy(b, () => call('admin:updateMeta', id, d.meta));
        toast('Textos y permisos publicados.', { kind: 'success' });
        await reload();
      } catch (er) { toastError(er); }
    }
    if (act === 'more') {
      menu(b, [
        ...(d.dirtyMeta && d.baseVersion ? [{ label: 'Descartar cambios de textos e imágenes', icon: 'refresh', onClick: async () => {
          const ok = await confirm({ title: '¿Descartar los cambios de textos?', text: 'Se recuperan los textos, imágenes y permisos publicados. Tu carpeta no se toca.', ok: 'Descartar', danger: true, icon: 'trash' });
          if (!ok) return;
          await call('admin:discard', id);
          await reload();
        } }] : []),
        ...(ws().synced ? [{ label: 'Abrir mi carpeta', icon: 'folder', onClick: () => call('admin:openFolder', id).catch(toastError) }] : []),
        ...(d.baseVersion && can('delete') ? ['-', { label: 'Eliminar del servidor', icon: 'trash', danger: true, onClick: async () => {
          const ok = await confirm({ title: `¿Eliminar ${d.meta.name}?`, text: 'Desaparecerá para todos los jugadores y se borrarán sus archivos del servidor. Tu carpeta se queda en este PC. No se puede deshacer.', ok: 'Eliminar', danger: true, icon: 'trash' });
          if (!ok) return;
          try { await call('admin:remove', id); toast('Instancia eliminada del servidor.', { kind: 'success' }); app.go({ name: 'admin' }); } catch (er) { toastError(er); }
        } }] : []),
        ...(!d.baseVersion ? [{ label: 'Descartar instancia nueva', icon: 'trash', danger: true, onClick: async () => {
          const ok = await confirm({ title: '¿Descartar esta instancia?', text: 'Nunca se publicó: se borra su borrador. Tu carpeta se queda en este PC (puedes desinstalarla desde su página).', ok: 'Descartar', danger: true, icon: 'trash' });
          if (!ok) return;
          await call('admin:discard', id);
          app.go({ name: 'admin' });
        } }] : []),
      ]);
    }
  });

  call('admin:open', id).then((r) => {
    d = r;
    draw();
    const imp = route.import;
    if (imp === 'mrpack') importMrpack(id, (w) => { setWs(w); reload(); });
    if (imp === 'folder') importFolder(id, (w) => { setWs(w); reload(); });
    if (imp === 'modrinth-app' && route.mr) importFolder(id, (w) => { setWs(w); reload(); }, route.mr);
  }).catch((e) => {
    root.innerHTML = `<div class="page"><div class="empty">${icon('alert')}<h3>No se pudo abrir</h3><p>${esc(e.message)}</p><button class="btn" type="button" data-back>Volver</button></div></div>`;
    hydrateIcons(root);
    root.querySelector('[data-back]').addEventListener('click', () => app.go({ name: 'admin' }));
  });
  root.innerHTML = '<div class="page"><div class="empty"><span class="spin"></span><p>Abriendo…</p></div></div>';
  offs.push(on('admin-sync-revoked', (list) => { if (d && list.some((x) => x.id === id)) reload().catch(() => {}); }));
  offs.push(on('admin-perms', () => { if (d) draw(); }));
  offs.push(on('focus', (f) => {
    if (!f) return;
    if (permsStale()) freshPerms(app);
    autoScan();
    if (d && (tab === 'access' || accessOpen) && (d.apiVersion || 0) >= 11 && Date.now() - dcAt > 2000) loadDiscord().catch(() => {});
  }));
  offs.push(on('game', (g) => { if (g?.state === 'exit' && g.id === id) setTimeout(autoScan, 800); }));
  if (permsStale()) freshPerms(app);
  return () => offs.forEach((f) => f());
}

const okind = (k) => (k.key.startsWith('key_') ? 'tecla' : k.key.startsWith('soundCategory_') ? 'volumen' : k.personal ? 'personal' : '');

function okeyRow(file, k, on, ro = false) {
  const kind = okind(k);
  const from = k.from == null ? 'no estaba' : k.from;
  const long = from.length + k.to.length > 48;
  return `<label class="okey check ${on ? 'is-on' : ''}">
      <input type="checkbox" data-okey="${esc(k.key)}" data-ofile="${esc(file)}" ${on ? 'checked' : ''} ${ro ? 'disabled' : ''}>
      <span class="okey__key"><b class="mono">${esc(k.key)}</b>${kind ? `<span class="tag">${kind}</span>` : ''}</span>
      <span class="okey__vals mono" ${long ? `data-tip="${esc(`${from} → ${k.to}`)}"` : ''}><span class="okey__from ${k.from == null ? 'is-new' : ''}">${esc(from)}</span>${icon('arrowRight')}<span class="okey__to">${esc(k.to)}</span></span>
      <span class="okey__state">${on ? 'Se sube' : 'No se sube'}</span>
    </label>`;
}

function okeysHtml(file, pending = [], hidden = [], ro = false) {
  const keptList = hidden.length ? `<details class="okeys__kept"><summary>${hidden.length} ajuste(s) que no subiste en otra versión: siguen solo en tu PC</summary>
      ${ro ? '' : '<p class="okeys__hint">Márcalos si ahora sí quieres que los reciban los jugadores.</p>'}
      <div class="okeys__list">${hidden.map((k) => okeyRow(file, k, false, ro)).join('')}</div></details>` : '';
  if (!pending.length) return `<div class="okeys okeys--quiet" data-okeys="${esc(file)}"><div class="okeys__head"><div class="okeys__title">${icon('layers')}<span><b class="mono">${esc(file)}</b></span></div><span class="okeys__count" data-ocount></span></div>${keptList}</div>`;
  return `<div class="okeys" data-okeys="${esc(file)}">
      <div class="okeys__head">
        <div class="okeys__title">${icon('layers')}<span>Ajustes cambiados en <b class="mono">${esc(file)}</b></span></div>
        <span class="okeys__count" data-ocount></span>
        <div class="field__row" style="gap:4px">
          ${pending.length > 1 && !ro ? `<button class="btn btn--sm btn--ghost" type="button" data-oall>${icon('check')}<span>Marcar todos</span></button>` : ''}
          <button class="btn btn--sm btn--ghost" type="button" data-odiff="${esc(file)}" data-tip="Ver las líneas que cambiaron">${icon('eye')}Líneas</button>
        </div>
      </div>
      <p class="okeys__hint">${ro ? `${NEED_EDIT} para elegir qué ajustes se suben.` : 'Marca los cambios que quieres subir. Los que dejes sin marcar <b>no se suben</b>: se quedan solo en tu PC y a los jugadores no les cambia nada.'}</p>
      <div class="okeys__list">${pending.map((k) => okeyRow(file, k, k.confirmed, ro)).join('')}</div>
      ${keptList}
    </div>`;
}

function okeysAll(w, ro = false) {
  const files = [...new Set([...Object.keys(w.merge || {}), ...Object.keys(w.mergeKept || {})])].sort();
  return files.map((f) => okeysHtml(f, w.merge?.[f] || [], w.mergeKept?.[f] || [], ro)).join('');
}

function bindOkeys(box, id, onPick) {
  const setRow = (row, on) => {
    row.querySelector('input').checked = on;
    row.classList.toggle('is-on', on);
    row.querySelector('.okey__state').textContent = on ? 'Se sube' : 'No se sube';
  };
  const paint = (panel) => {
    const main = [...panel.querySelectorAll(':scope > .okeys__list .okey')];
    const extra = [...panel.querySelectorAll('.okeys__kept .okey')].filter((r) => r.querySelector('input').checked);
    const on = main.filter((r) => r.querySelector('input').checked).length + extra.length;
    const total = main.length + extra.length;
    const count = panel.querySelector('[data-ocount]');
    if (count) {
      count.textContent = !total ? '' : !on ? 'No se sube ninguno' : on === total && total > 1 ? `Se suben los ${total}` : `Se sube${on > 1 ? 'n' : ''} ${on} de ${total}`;
      count.classList.toggle('is-on', on > 0);
    }
    const all = panel.querySelector('[data-oall]');
    if (all) {
      const full = main.every((r) => r.querySelector('input').checked);
      all.dataset.full = full ? '1' : '';
      all.querySelector('span').textContent = full ? 'Desmarcar todos' : 'Marcar todos';
    }
  };
  const save = async (file, keys, on) => {
    try { await call('admin:mergePick', id, file, keys, on); onPick?.(); } catch (er) { toastError(er); }
  };
  box.querySelectorAll('.okeys').forEach(paint);
  box.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-okey]');
    if (!cb) return;
    setRow(cb.closest('.okey'), cb.checked);
    paint(cb.closest('.okeys'));
    save(cb.dataset.ofile, [cb.dataset.okey], cb.checked);
  });
  box.addEventListener('click', (e) => {
    const all = e.target.closest('[data-oall]');
    if (all) {
      const panel = all.closest('.okeys');
      const on = !all.dataset.full;
      const rows = [...panel.querySelectorAll(':scope > .okeys__list .okey')];
      rows.forEach((r) => setRow(r, on));
      paint(panel);
      save(panel.dataset.okeys, rows.map((r) => r.querySelector('input').dataset.okey), on);
      return;
    }
    const od = e.target.closest('[data-odiff]');
    if (od) diffModal(id, { path: od.dataset.odiff, state: 'modified' });
  });
}

function okeysPicked(box) {
  const out = {};
  box.querySelectorAll('.okeys').forEach((p) => {
    out[p.dataset.okeys] = [...p.querySelectorAll('input[data-okey]')].filter((c) => c.checked).map((c) => c.dataset.okey);
  });
  return out;
}

function okeysModal(id, d, file, onClose, ro = false) {
  const w = d.workspace || {};
  let dirty = false;
  const m = modal({
    size: 'lg',
    onClose: () => { if (dirty) onClose?.(); },
    html: `<div class="modal__body"><h2 class="modal__title">Ajustes de ${esc(file)}</h2>
      <p class="modal__text">Lo que cambió en tu PC respecto a la versión publicada (v${d.baseVersion}). Cada jugador conserva sus propios ajustes: solo recibe los que marques aquí.</p>
      <div class="okeys-box">${okeysHtml(file, w.merge?.[file] || [], w.mergeKept?.[file] || [], ro)}</div>
      <div class="modal__actions"><button class="btn btn--primary" type="button" data-close>Listo</button></div></div>`,
  });
  bindOkeys(m.content, id, () => { dirty = true; });
  m.content.querySelector('[data-close]').addEventListener('click', () => m.close());
}

function accessModal({ name, getMeta, update, ro, apiVersion, mode, channels, attach }) {
  let filter = '';
  let dc = null;
  let dcError = null;
  let stamp = null;
  let loading = false;
  let closed = false;
  const HINT = {
    auto: 'Los cambios se guardan solos: los jugadores los ven en unos segundos.',
    draft: 'Los cambios se aplican al publicar la instancia.',
    manual: 'Los cambios quedan como borrador: para aplicarlos pulsa «Guardar solo textos y permisos», abajo en el editor.',
  };
  const m = modal({
    size: 'lg',
    onClose: () => { closed = true; attach?.(null); },
    html: `<div class="modal__body">
      <h2 class="modal__title">Quién puede ver «${esc(name)}»</h2>
      <p class="modal__text" id="acc-sum"></p>
      ${ro ? '' : `<form class="field__row" id="acc-add" style="margin-top:14px"><input class="input" name="n" autocomplete="off" spellcheck="false" placeholder="Añadir nicks: escribe uno o pega varios separados por comas"><button class="btn btn--primary" type="submit">${icon('plus')}Añadir</button></form>`}
      <input class="input" id="acc-q" placeholder="Buscar un nick…" spellcheck="false" style="margin-top:10px">
      <div class="acc-list" id="acc-list"></div>
      <p class="field__hint" style="margin-top:12px">${ro ? 'Solo lectura: necesitas el permiso «Editar y publicar» para cambiar la lista.' : HINT[mode] || HINT.manual} Los administradores de esta instancia la ven siempre.</p>
      <div class="modal__actions">${ro ? '' : '<span data-acc-state></span>'}<button class="btn btn--primary" type="button" data-close>Listo</button></div></div>`,
  });
  const box = m.content.querySelector('#acc-list');
  const channelName = (cid) => (channels?.() || []).find((c) => c.id === cid)?.name;
  const stampOf = () => {
    const sel = new Set(getMeta().discord || []);
    return JSON.stringify((channels?.() || []).filter((c) => sel.has(c.id)).map((c) => [c.id, c.changedAt ?? c.syncedAt ?? null, c.nicks ?? null]));
  };
  const loadNicks = async () => {
    const ids = getMeta().discord || [];
    if (!ids.length || (apiVersion || 0) < 11 || loading || closed) return;
    loading = true;
    const s = stampOf();
    try {
      dc = await call('admin:discordNicks', ids);
      dcError = null;
      stamp = s;
    } catch (e) {
      dcError = e.message;
      if (!dc) dc = [];
    } finally { loading = false; }
    if (!closed) draw();
  };
  const lower = (n) => String(n).toLowerCase();
  const btn = (attr, nick, label) => (ro ? '' : `<button class="btn btn--sm btn--ghost" type="button" ${attr}="${esc(nick)}">${label}</button>`);
  const row = (nick, sub, action) => `<div class="acc-row"><span class="acc-row__name"><b>${esc(nick)}</b>${sub ? `<small>${sub}</small>` : ''}</span>${action}</div>`;
  const group = (ic, title, count, rows, empty) => `<section class="acc-group"><div class="acc-group__title">${icon(ic)}${title} <span class="muted">${count}</span></div>${rows.length ? rows.join('') : `<p class="field__hint">${empty}</p>`}</section>`;
  const draw = () => {
    const mt = getMeta();
    const allow = mt.allow || [];
    const deny = mt.deny || [];
    const linked = (mt.discord || []).length > 0;
    const denied = new Set(deny.map(lower));
    const manual = new Set(allow.map(lower));
    const match = (n) => !filter || lower(n).includes(filter);
    const fromDc = (dc || []).filter((x) => !denied.has(lower(x.nick)));
    const parts = [`${allow.length} añadido(s) a mano`];
    if (linked) parts.push(dc ? `${fromDc.length} desde Discord` : 'Discord: cargando…');
    if (deny.length) parts.push(`${deny.length} retirado(s)`);
    m.content.querySelector('#acc-sum').textContent = `${mt.visibility === 'private' ? '' : 'La instancia es pública: ahora la ve todo el mundo; esta lista vale cuando sea privada. '}${parts.join(' · ')}.`;
    const several = (mt.discord || []).length > 1;
    const sections = [group('user', 'Añadidos a mano', allow.length, allow.filter(match).map((n) => row(n, '', btn('data-rm', n, 'Quitar'))), filter ? 'Ningún nick coincide.' : 'Nadie añadido a mano.')];
    if (linked) {
      const rows = fromDc.filter((x) => match(x.nick)).map((x) => row(x.nick, [esc(x.user || 'Discord'), ...(several ? [`#${esc(channelName?.(x.channel) || x.channel)}`] : []), ...(manual.has(lower(x.nick)) ? ['también añadido a mano'] : [])].join(' · '), btn('data-deny', x.nick, 'Retirar')));
      sections.push(group('discord', 'Desde Discord', dc ? fromDc.length : '…', rows, dcError ? esc(dcError) : !dc ? '<span class="spin"></span> Cargando…' : filter ? 'Ningún nick coincide.' : 'Nadie ha escrito su nick todavía.'));
    }
    if (deny.length || linked) sections.push(group('eyeOff', 'Retirados', deny.length, deny.filter(match).map((n) => row(n, 'No entra aunque escriba su nick en Discord', btn('data-undeny', n, 'Permitir de nuevo'))), filter ? 'Ningún nick coincide.' : 'Nadie retirado.'));
    const y = box.scrollTop;
    box.innerHTML = sections.join('');
    hydrateIcons(box);
    box.scrollTop = y;
  };
  box.addEventListener('click', (e) => {
    const mt = getMeta();
    const rm = e.target.closest('[data-rm]');
    const dn = e.target.closest('[data-deny]');
    const un = e.target.closest('[data-undeny]');
    if (rm) update({ allow: (mt.allow || []).filter((n) => n !== rm.dataset.rm) });
    else if (dn) update({ deny: [...(mt.deny || []), dn.dataset.deny] });
    else if (un) update({ deny: (mt.deny || []).filter((n) => n !== un.dataset.undeny) });
    else return;
    draw();
  });
  const form = m.content.querySelector('#acc-add');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const parts = form.n.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    const valid = parts.filter((p) => /^[A-Za-z0-9_]{3,16}$/.test(p));
    if (valid.length < parts.length) toast(`${parts.length - valid.length} no son nicks válidos: solo letras, números y _ (de 3 a 16).`, { kind: 'error' });
    if (!valid.length) return;
    const mt = getMeta();
    const have = new Set((mt.allow || []).map(lower));
    const add = valid.filter((n) => { const k = lower(n); if (have.has(k)) return false; have.add(k); return true; });
    update({ allow: [...(mt.allow || []), ...add].slice(0, 500), deny: (mt.deny || []).filter((n) => !have.has(lower(n))) });
    form.n.value = '';
    draw();
  });
  m.content.querySelector('#acc-q').addEventListener('input', debounce((e) => { filter = e.target.value.trim().toLowerCase(); draw(); }, 120));
  m.content.querySelector('[data-close]').addEventListener('click', () => m.close());
  attach?.({ refresh: () => { if (dcError || (stamp !== null && stampOf() !== stamp)) loadNicks(); } });
  loadNicks();
  draw();
}

function changesHtml(d, { compact = false } = {}) {
  const w = d.workspace || {};
  const files = w.files || [];
  const added = files.filter((f) => f.state === 'added');
  const modified = files.filter((f) => f.state === 'modified');
  const removed = (w.removed || []).map((f) => ({ ...f, state: 'removed' }));
  const meta = d.baseVersion ? d.metaChanges || [] : [];
  const row = (f) => {
    const name = f.title || f.path.split('/').pop();
    const keys = f.state === 'modified' ? w.merge?.[f.path] : null;
    let detail = '';
    if (f.state === 'modified') {
      if (f.policyOnly) detail = `solo cambió cómo se actualiza: ${POLICY[f.oldPolicy]?.short || f.oldPolicy} → ${POLICY[f.policy]?.short || f.policy}`;
      else if (f.oldVersionName && f.versionName && f.oldVersionName !== f.versionName) detail = `versión ${f.oldVersionName} → ${f.versionName}`;
      else if (keys) detail = `${keys.length} ajuste(s) cambiado(s): elige arriba cuáles se suben`;
    }
    const size = f.state === 'modified' && f.oldSize != null && f.oldSize !== f.size ? `<b>${bytes(f.oldSize)}</b> → ${bytes(f.size)}` : bytes(f.size || 0);
    const action = keys
      ? `<button class="btn btn--sm btn--ghost" type="button" data-chg-keys="${esc(f.path)}">${icon('layers')}Ajustes</button>`
      : canDiff(f) ? `<button class="btn btn--sm btn--ghost" type="button" data-diff="${esc(f.path)}">${icon('eye')}${f.state === 'modified' ? 'Diferencias' : 'Ver'}</button>` : '<span></span>';
    return `<div class="chg"><div class="chg__row">
        <div class="chg__icon">${f.icon ? `<img src="${esc(f.icon)}" alt="" loading="lazy">` : icon(fileIcon(f.path))}</div>
        <div class="chg__name"><b>${esc(name)}</b><small>${esc(f.path)}${detail ? ` · ${esc(detail)}` : ''}</small></div>
        <span class="chg__size">${size}</span>${action}
      </div></div>`;
  };
  const group = (title, ic, cls, list) => (list.length ? `<div class="changes__group"><div class="changes__title">${icon(ic)}${title} <span class="state state--${cls}">${list.length}</span></div>${[...list].sort((a, b) => a.path.localeCompare(b.path)).map(row).join('')}</div>` : '');
  const metaHtml = meta.length ? `<div class="changes__group"><div class="changes__title">${icon('edit')}Textos, imágenes y permisos <span class="state state--modified">${meta.length}</span></div>
    <div class="chg"><dl class="meta-chg">${meta.map((c) => `<dt>${esc(c.label)}</dt><dd>${c.added || c.removed
      ? [c.added?.length ? `+ ${c.added.map(esc).join(', ')}` : '', c.removed?.length ? `<s>− ${c.removed.map(esc).join(', ')}</s>` : ''].filter(Boolean).join(' · ') || `${esc(c.from)} → ${esc(c.to)}`
      : `<s>${esc(c.from)}</s> → ${esc(c.to)}`}</dd>`).join('')}</dl></div></div>` : '';
  const body = metaHtml + group('Modificados', 'edit', 'modified', modified) + group('Nuevos', 'plus', 'added', added) + group('Se quitarán', 'trash', 'removed', removed);
  return `<div class="changes ${compact ? 'changes--compact' : ''}">${body || '<p class="field__hint">No hay cambios sin publicar.</p>'}</div>`;
}

function diffHtml(r) {
  const note = (t) => `<div class="chg__note">${t}</div>`;
  if (r.kind === 'binary') return note('No es un archivo de texto: no se pueden mostrar sus líneas.');
  if (r.kind === 'large') return note('El archivo es demasiado grande para compararlo aquí.');
  if (r.oldText == null) return note(`No se pudo descargar la versión publicada para compararla${r.oldError ? ` (${esc(r.oldError)})` : ''}.`);
  const p = prettyIfJson(r.path, r.oldText, r.newText);
  const res = diffLines(p.a, p.b);
  if (res.tooMany) return note(`Cambió casi todo el archivo (${res.added} líneas nuevas y ${res.removed} quitadas): son demasiados cambios para mostrarlos línea a línea.`);
  if (!res.hunks.length) return note('El contenido es el mismo (quizá solo cambiaron los saltos de línea).');
  const lines = res.hunks.map((h, i) => {
    const before = i === 0 ? (h.lines[0].a ?? h.lines[0].b ?? 1) - 1 : -1;
    const gap = i === 0 ? (before > 0 ? `<div class="diff__gap">··· ${before} línea(s) sin cambios ···</div>` : '') : '<div class="diff__gap">···</div>';
    return gap + h.lines.map((l) => `<div class="diff__line ${l.t === '+' ? 'diff__line--add' : l.t === '-' ? 'diff__line--del' : ''}"><span class="diff__n">${l.a ?? ''}</span><span class="diff__n">${l.b ?? ''}</span><span class="diff__m">${l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</span><span class="diff__t">${esc(l.text)}</span></div>`).join('');
  }).join('');
  return `<div class="diff__stats"><span class="add">+${res.added} línea(s)</span><span class="del">−${res.removed} línea(s)</span>${p.formatted ? '<span>JSON formateado para compararlo</span>' : ''}${res.truncated ? '<span>(solo las primeras líneas)</span>' : ''}</div><div class="diff">${lines}</div>`;
}

function bindChanges(box, id, d) {
  box.addEventListener('click', async (e) => {
    const kb = e.target.closest('[data-chg-keys]');
    if (kb) {
      const panel = [...box.querySelectorAll('.okeys')].find((p) => p.dataset.okeys === kb.dataset.chgKeys);
      if (panel) {
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        panel.classList.remove('is-flash');
        void panel.offsetWidth;
        panel.classList.add('is-flash');
      }
      return;
    }
    const b = e.target.closest('[data-diff]');
    if (!b) return;
    const card = b.closest('.chg');
    const open = card.querySelector('.chg__diff');
    if (open) { open.remove(); return; }
    const pane = document.createElement('div');
    pane.className = 'chg__diff';
    pane.innerHTML = '<div class="chg__note"><span class="spin"></span> Comparando con lo publicado…</div>';
    card.appendChild(pane);
    try {
      pane.innerHTML = diffHtml(await call('admin:fileDiff', id, b.dataset.diff));
    } catch (er) {
      pane.innerHTML = `<div class="chg__note">${esc(er.message)}</div>`;
    }
    hydrateIcons(pane);
  });
}

function changesModal(id, d, onChange, ro = false) {
  const w = d.workspace || {};
  const ch = w.changes || { total: 0 };
  const metaN = d.baseVersion ? (d.metaChanges || []).length : 0;
  const ok = okeysAll(w, ro);
  let dirty = false;
  const m = modal({
    size: 'xl',
    onClose: () => { if (dirty) onChange?.(); },
    html: `<div class="modal__body"><h2 class="modal__title">Cambios sin publicar</h2>
      <p class="modal__text">Lo que cambia respecto a la versión ${d.baseVersion ? `publicada (v${d.baseVersion})` : 'guardada'}: ${ch.total} archivo(s)${metaN ? ` y ${metaN} cambio(s) de textos o permisos` : ''}. Pulsa <b>Diferencias</b> para ver las líneas que cambiaron en una config.</p>
      ${ok ? `<div class="okeys-box">${ok}</div>` : ''}
      ${changesHtml(d)}
      <div class="modal__actions"><button class="btn btn--primary" type="button" data-close>Cerrar</button></div></div>`,
  });
  bindChanges(m.content, id, d);
  bindOkeys(m.content, id, () => { dirty = true; });
  m.content.querySelector('[data-close]').addEventListener('click', () => m.close());
}

function diffModal(id, f) {
  const m = modal({
    size: 'xl',
    html: `<div class="modal__body"><h2 class="modal__title">${f.state === 'added' ? 'Archivo nuevo' : 'Qué cambió'}</h2>
      <p class="modal__text mono">${esc(f.path)}</p>
      <div class="chg" style="margin-top:14px"><div class="chg__diff"><div class="chg__note"><span class="spin"></span> Comparando con lo publicado…</div></div></div>
      <div class="modal__actions"><button class="btn btn--primary" type="button" data-close>Cerrar</button></div></div>`,
  });
  m.content.querySelector('[data-close]').addEventListener('click', () => m.close());
  const pane = m.content.querySelector('.chg__diff');
  call('admin:fileDiff', id, f.path).then((r) => { pane.innerHTML = diffHtml(r); }).catch((e) => { pane.innerHTML = `<div class="chg__note">${esc(e.message)}</div>`; }).finally(() => hydrateIcons(pane));
}

function askFolder(def = 'mods') {
  return new Promise((resolve) => {
    const opts = [['mods', 'mods/'], ['config', 'config/'], ['resourcepacks', 'resourcepacks/'], ['shaderpacks', 'shaderpacks/'], ['', 'Raíz de la instancia'], ['custom', 'Otra carpeta…']];
    const m = modal({
      size: 'sm',
      onClose: (r) => resolve(r === undefined ? null : r),
      html: `<div class="modal__body"><h2 class="modal__title">¿Dónde van?</h2><p class="modal__text">Carpeta dentro de la instancia.</p>
        <div style="display:grid;gap:8px;margin-top:14px">${opts.map(([v, l]) => `<button class="btn ${v === def ? 'btn--primary' : ''}" type="button" data-v="${v}" style="justify-content:flex-start">${icon('folder')}${esc(l)}</button>`).join('')}</div>
        <input class="input mono" id="custom" placeholder="kubejs/assets" hidden style="margin-top:10px"></div>`,
    });
    const custom = m.content.querySelector('#custom');
    m.content.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.v === 'custom') {
        if (custom.hidden) { custom.hidden = false; custom.focus(); return; }
        const v = custom.value.trim().replace(/^\/+|\/+$/g, '');
        if (!v || v.includes('..')) { toast('Escribe una carpeta válida.', { kind: 'error' }); return; }
        m.close(v);
        return;
      }
      m.close(b.dataset.v);
    }));
    custom.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.content.querySelector('[data-v="custom"]').click(); });
  });
}

function modrinthModal(id, draft, onChange) {
  let type = 'mod';
  let offset = 0;
  let total = 0;
  let files = draft.workspace?.files || [];
  const m = modal({
    size: 'lg',
    html: `<div class="modal__body"><h2 class="modal__title">Buscar en <span class="grad-text">Modrinth</span></h2>
      <p class="modal__text">Solo se muestran los compatibles con Minecraft ${esc(draft.meta.mc)}${draft.meta.loader.type !== 'vanilla' ? ` y ${esc(LOADER_NAMES[draft.meta.loader.type])}` : ''}. Se descargan a tu carpeta con sus dependencias.</p>
      <div class="field__row" style="margin-top:16px">
        <div class="segmented" id="mt"><button type="button" data-t="mod" class="is-active">Mods</button><button type="button" data-t="resourcepack">Resource packs</button><button type="button" data-t="shader">Shaders</button></div>
        <input class="input" id="mq" placeholder="Buscar… (sodium, jei, create…)" autofocus>
      </div>
      <div class="mr-results" id="mr" style="margin-top:14px"></div>
      <div class="field__row" style="justify-content:center;margin-top:10px"><button class="btn btn--sm btn--ghost" type="button" id="more" hidden>Cargar más</button></div></div>`,
  });
  const box = m.content.querySelector('#mr');
  const inFolder = (pid) => files.some((f) => f.project === pid);
  const search = async (append = false) => {
    if (!append) { offset = 0; box.innerHTML = '<span class="spin"></span>'; }
    try {
      const r = await call('modrinth:search', { query: m.content.querySelector('#mq').value.trim(), type, mc: draft.meta.mc, loader: draft.meta.loader.type, offset, limit: 20 });
      total = r.total;
      const html = r.hits.map((h) => `<div class="mr-item">
        ${h.icon ? `<img src="${esc(h.icon)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div style="min-width:0"><b>${esc(h.title)}</b><small>${esc(h.description)}</small><small class="mono">por ${esc(h.author)} · ${Number(h.downloads).toLocaleString('es-ES')} descargas${h.clientSide === 'unsupported' ? ' · solo servidor' : ''}</small></div>
        <button class="btn btn--sm ${inFolder(h.id) ? '' : 'btn--primary'}" type="button" data-add="${esc(h.id)}" ${inFolder(h.id) ? 'disabled' : ''}>${inFolder(h.id) ? 'Añadido' : 'Añadir'}</button>
      </div>`).join('');
      if (append) box.insertAdjacentHTML('beforeend', html); else box.innerHTML = html || '<p class="field__hint">Sin resultados.</p>';
      offset += r.hits.length;
      m.content.querySelector('#more').hidden = offset >= total;
    } catch (e) { box.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  };
  m.content.querySelector('#mq').addEventListener('input', debounce(() => search(), 350));
  m.content.querySelector('#more').addEventListener('click', () => search(true));
  m.content.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => {
    type = b.dataset.t;
    m.content.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('is-active', x === b));
    search();
  }));
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    try {
      const r = await busy(b, () => call('admin:addModrinth', id, { projectId: b.dataset.add }));
      files = r.workspace?.files || files;
      onChange(r.workspace);
      b.textContent = 'Añadido';
      b.classList.remove('btn--primary');
      b.disabled = true;
      const extra = r.added.length - 1;
      toast(`Añadido ${r.added[0]?.title || ''}${extra > 0 ? ` + ${extra} dependencia(s)` : ''}.`, { kind: 'success' });
    } catch (er) { toastError(er); }
  });
  search();
}

async function pickModrinthInstance() {
  let list;
  const t = toast('Buscando instancias de Modrinth App…', { timeout: 0 });
  try { list = await call('admin:modrinthInstances'); } catch (e) { toastError(e); return null; } finally { t(); }
  if (!list.length) {
    toast('No se encontró ninguna instancia de Modrinth App en este PC.', { kind: 'info', timeout: 6000 });
    return null;
  }
  return new Promise((resolve) => {
    const m = modal({
      size: 'lg',
      onClose: (r) => resolve(r || null),
      html: `<div class="modal__body"><h2 class="modal__title">Importar de <span class="grad-text">Modrinth App</span></h2>
        <p class="modal__text">Instancias de Modrinth App en este PC. Se copian a tu carpeta: Modrinth App no se toca.</p>
        <input class="input" id="mrf" placeholder="Filtrar…" style="margin-top:14px">
        <div class="mr-results" id="mrl" style="margin-top:12px"></div></div>`,
    });
    const box = m.content.querySelector('#mrl');
    const draw = (q = '') => {
      const shown = list.map((i, n) => ({ i, n })).filter(({ i }) => !q || i.name.toLowerCase().includes(q));
      box.innerHTML = shown.map(({ i, n }) => `<button class="mr-item mr-pick" type="button" data-pick="${n}">
          ${i.iconData ? `<img src="${i.iconData}" alt="">` : `<div class="ph">${coverMini(i.name)}</div>`}
          <div style="min-width:0"><b>${esc(i.name)}</b><small>Minecraft ${esc(i.mc || '?')} · ${esc(loaderLabel(i.loader))}${i.lastPlayed ? ` · jugada ${esc(timeAgo(i.lastPlayed))}` : ''}${i.installed ? '' : ' · sin terminar de instalar'}</small></div>
          ${icon('arrowRight')}</button>`).join('') || '<p class="field__hint">Ninguna coincide.</p>';
      hydrateIcons(box);
    };
    m.content.querySelector('#mrf').addEventListener('input', (e) => draw(e.target.value.trim().toLowerCase()));
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (b) m.close(list[Number(b.dataset.pick)]);
    });
    draw();
  });
}

async function useModrinthIcon(id, file) {
  const ic = await call('admin:modrinthIcon', file);
  const out = await processMedia(new File([ic.bytes], ic.name, { type: ic.type }), 'icon');
  await call('admin:setMedia', id, 'icon', out);
}

async function importFolder(id, onDone, preset = null) {
  let scan;
  try { scan = preset ? await call('admin:scanPath', preset.dir) : await call('admin:scanFolder'); } catch (e) { toastError(e); return; }
  if (!scan) return;
  const det = preset ? { source: 'Modrinth App', name: preset.name, mc: preset.mc, loader: preset.loader } : scan.detected;
  const m = modal({
    size: 'lg',
    html: `<div class="modal__body"><h2 class="modal__title">Importar ${preset ? `<span class="grad-text">${esc(preset.name)}</span>` : 'instancia'}</h2>
      <p class="modal__text">${det ? `Detectado: <b>${esc(det.source)}</b> · Minecraft ${esc(det.mc || '?')} · ${esc(loaderLabel(det.loader))}.` : 'Elige qué quieres incluir.'} Se copia a tu carpeta; al publicar, los mods que existan en Modrinth se enlazan a su CDN y el resto se sube a tu servidor.</p>
      <div class="check-list" style="margin-top:14px">${scan.entries.map((e, i) => `<label><span class="check"><input type="checkbox" data-i="${i}" ${e.suggested ? 'checked' : ''}> ${icon(e.dir ? 'folder' : 'file')} ${esc(e.name)}</span><small>${e.dir ? `${e.count} archivos · ` : ''}${bytes(e.size)}</small></label>`).join('')}</div>
      ${det?.mc ? `<label class="check" style="margin-top:12px"><input type="checkbox" id="use-ver" checked> Usar la versión detectada (${esc(det.mc)} · ${esc(loaderLabel(det.loader))})</label>` : ''}
      ${preset?.icon ? `<label class="check" style="margin-top:8px"><input type="checkbox" id="use-icon" checked> Usar su icono</label>` : ''}
      <p class="field__hint" style="margin-top:8px">Los mundos (<code>saves</code>) pueden pesar mucho: inclúyelos solo si quieres repartir un mapa. Los mods desactivados no se copian.</p>
      <div class="modal__actions"><button class="btn btn--ghost" type="button" data-cancel>Cancelar</button><button class="btn btn--primary" type="button" data-go>${icon('download')}Importar</button></div></div>`,
  });
  m.content.querySelector('[data-cancel]').addEventListener('click', () => m.close());
  m.content.querySelector('[data-go]').addEventListener('click', async (e) => {
    const include = [...m.content.querySelectorAll('[data-i]')].filter((c) => c.checked).map((c) => scan.entries[Number(c.dataset.i)].name);
    if (!include.length) { toast('Elige al menos una carpeta.', { kind: 'error' }); return; }
    const btn = e.currentTarget;
    m.setLocked(true);
    const off = on('admin-progress', (p) => {
      if (p.id !== `import:${id}`) return;
      btn.innerHTML = `<span class="spin"></span>${esc(p.label)} ${p.filesTotal ? `${p.filesDone}/${p.filesTotal}` : ''}`;
    });
    try {
      btn.disabled = true;
      if (det?.mc && m.content.querySelector('#use-ver')?.checked) await call('admin:saveMeta', id, { mc: det.mc, loader: det.loader });
      const r = await call('admin:importFolder', id, scan.root, include);
      if (preset?.icon && m.content.querySelector('#use-icon')?.checked) await useModrinthIcon(id, preset.icon).catch((er) => toastError(er, 'No se pudo usar su icono: '));
      toast(`Importados ${r.total} archivos a tu carpeta.`, { kind: 'success', timeout: 7000 });
      m.setLocked(false);
      m.close();
      onDone?.(r.workspace);
    } catch (er) {
      toastError(er);
      m.setLocked(false);
      btn.disabled = false;
      btn.innerHTML = `${icon('download')}Importar`;
    } finally { off(); }
  });
}

async function importMrpack(id, onDone) {
  const t = toast('Importando modpack…', { timeout: 0 });
  try {
    const r = await call('admin:importMrpack', id);
    if (!r) return;
    toast(`Modpack importado: ${r.total} archivos en tu carpeta.`, { kind: 'success' });
    onDone?.(r.workspace);
  } catch (e) { toastError(e); } finally { t(); }
}

async function publish(id, d, onDone) {
  const w = d.workspace || {};
  const ch = w.changes || { total: 0 };
  if (!ch.total && !d.dirtyMeta && d.baseVersion) { toast('No hay nada nuevo que publicar.', { kind: 'info' }); return; }
  const ok = okeysAll(w);
  let picked = false;
  let answer;
  const answered = new Promise((resolve) => { answer = resolve; });
  const m = modal({
    size: 'lg',
    onClose: (r) => answer(r || null),
    html: `<div class="modal__body"><h2 class="modal__title">¿Publicar la versión ${(d.baseVersion || 0) + 1}?</h2>
      <p class="modal__text">${esc(d.meta.name)} · ${d.meta.visibility === 'private' ? `solo para ${d.meta.allow.length} nick(s)${d.meta.discord?.length ? ' y los del canal de Discord' : ''}` : 'visible para todos'}. Los jugadores verán el botón <b>Actualizar</b> y solo se les descargará lo que cambió.</p>
      <div class="files__summary" style="margin-top:14px">${ch.total ? `${ch.added ? `<span class="state state--added">${ch.added} nuevo(s)</span>` : ''}${ch.modified ? `<span class="state state--modified">${ch.modified} modificado(s)</span>` : ''}${ch.removed ? `<span class="state state--removed">${ch.removed} se quitará(n)</span>` : ''}` : '<span>Sin cambios de archivos (solo textos, imágenes o permisos).</span>'}</div>
      ${ok ? `<div class="okeys-box">${ok}</div>` : ''}
      ${changesHtml(d, { compact: true })}
      <div class="modal__actions"><button class="btn btn--ghost" type="button" data-cancel>Cancelar</button><button class="btn btn--primary" type="button" data-go>${icon('upload')}Publicar</button></div></div>`,
  });
  bindChanges(m.content, id, d);
  bindOkeys(m.content, id, () => { picked = true; });
  m.content.querySelector('[data-cancel]').addEventListener('click', () => m.close());
  m.content.querySelector('[data-go]').addEventListener('click', () => m.close({ mergeKeys: okeysPicked(m.content) }));
  const go = await answered;
  if (!go) { if (picked) await onDone?.(); return; }
  const pm = modal({
    size: 'sm', locked: true,
    html: `<div class="modal__body"><h2 class="modal__title">Publicando…</h2>
      <div class="progress-line" style="margin-top:18px"><div class="dl__phase" id="pp">Preparando…</div><div class="dl__bar is-indeterminate" id="pb"><span></span></div><div class="dl__stats" id="ps"></div></div>
      <p class="field__hint" style="margin-top:14px">No cierres el launcher hasta que termine.</p></div>`,
  });
  const off = on('admin-progress', (p) => {
    if (p.id !== `publish:${id}`) return;
    pm.content.querySelector('#pp').textContent = p.label;
    const bar = pm.content.querySelector('#pb');
    const pct = p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : null;
    bar.classList.toggle('is-indeterminate', pct == null);
    bar.style.setProperty('--p', `${pct || 0}%`);
    pm.content.querySelector('#ps').innerHTML = p.total > 0 ? `<span><b>${bytes(p.done)}</b> de ${bytes(p.total)}</span><span><b>${speed(p.speed)}</b></span>${p.eta != null ? `<span>quedan <b>${duration(p.eta)}</b></span>` : ''}` : '';
  });
  try {
    const inst = await call('admin:publish', id, go);
    pm.setLocked(false);
    pm.close();
    if (inst?.unchanged) toast('No había nada nuevo que publicar: los ajustes que no marcaste se quedan solo en tu PC.', { kind: 'info', timeout: 7000 });
    else toast(`¡${inst?.name || 'Instancia'} publicada! (versión ${inst?.version}). Pruébala con «Copia de prueba».`, { kind: 'success', timeout: 7000 });
    await onDone?.();
  } catch (e) {
    pm.setLocked(false);
    pm.close();
    toastError(e, 'No se pudo publicar: ');
    if (e.code === 'EREVOKED') await onDone?.();
  } finally { off(); }
}

async function processMedia(file, kind) {
  const type = file.type || '';
  if (/^video\//.test(type)) {
    if (kind !== 'background') throw new Error(`El ${kind === 'icon' ? 'icono' : 'banner'} debe ser una imagen o un GIF.`);
    if (file.size > 80 * 1024 * 1024) throw new Error('El vídeo pesa más de 80 MB. Recórtalo o comprímelo.');
    return { bytes: new Uint8Array(await file.arrayBuffer()), type };
  }
  if (type === 'image/gif') {
    if (file.size > 15 * 1024 * 1024) throw new Error('El GIF pesa más de 15 MB.');
    return { bytes: new Uint8Array(await file.arrayBuffer()), type };
  }
  if (!/^image\/(png|jpeg|webp)$/.test(type)) throw new Error('Formato no admitido.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('No se pudo leer la imagen')); i.src = url; });
    const c = document.createElement('canvas');
    if (kind === 'icon') {
      const s = Math.min(img.width, img.height);
      c.width = 256;
      c.height = 256;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
    } else {
      const scale = Math.min(1, (kind === 'banner' ? 960 : 1920) / img.width);
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
    }
    const blob = await new Promise((res) => c.toBlob(res, 'image/webp', kind === 'icon' ? 0.9 : 0.86));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/webp' };
  } finally { URL.revokeObjectURL(url); }
}

export { state };
