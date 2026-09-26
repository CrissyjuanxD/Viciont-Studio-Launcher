// Administración de instancias (nick autorizado en el panel + clave personal).
// Los botones se muestran según los permisos del nick; el servidor los vuelve a comprobar siempre.

import { call, on, pathFor, state } from '../api.js';
import { icon, hydrateIcons } from '../icons.js';
import { esc, bytes, speed, duration, coverMini, mediaUrl, isVideo, loaderLabel, LOADER_NAMES, timeAgo, debounce } from '../util.js';
import { modal, toast, toastError, confirm, menu, busy } from '../ui.js';

const FOLDERS = [
  ['mods', 'Mods', 'package'],
  ['resourcepacks', 'Resource packs', 'palette'],
  ['shaderpacks', 'Shaders', 'sun'],
  ['config', 'Configuración', 'code'],
  ['', 'Otros archivos', 'file'],
];

const can = (perm) => (state.admin?.perms || []).includes(perm);

const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

export function render(root, route, app) {
  app.scene.clear();
  app.bg.setMode('dim');
  if (route.id) return renderEditor(root, route.id, app);
  return renderList(root, app);
}

// ======================= LISTA =======================
function renderList(root, app) {
  root.innerHTML = `
    <div class="page">
      <div class="page__head">
        <div><h1 class="title-lg">Administrar <span class="hl">instancias</span></h1><p class="lead">Crea instancias, añade mods (de Modrinth o tuyos), configs, resource packs, imágenes y vídeos, y decide quién puede verlas.</p></div>
        <div class="field__row">
          ${can('players') ? `<button class="btn" type="button" data-act="players">${icon('users')}Jugadores</button>` : ''}
          ${can('create') ? `<button class="btn btn--primary" type="button" data-act="new">${icon('plus')}Nueva instancia</button>` : ''}
        </div>
      </div>
      <div id="adm-note"></div>
      <div class="admin-grid" id="adm-grid"><div class="empty"><span class="spin"></span><p>Cargando…</p></div></div>
    </div>`;
  hydrateIcons(root);

  const load = async () => {
    const grid = root.querySelector('#adm-grid');
    try {
      const r = await call('admin:list');
      const note = root.querySelector('#adm-note');
      note.innerHTML = r.error ? `<div class="banner-note">${icon('alert')}<span>${esc(r.error)}</span></div>` : '';
      const drafts = new Map(r.drafts.map((d) => [d.id, d]));
      const cards = r.published.map((p) => {
        const d = drafts.get(p.id);
        drafts.delete(p.id);
        const iconUrl = mediaUrl(p.media?.icon);
        return `<button class="acard" type="button" data-open="${esc(p.id)}">
          <div class="acard__icon">${iconUrl ? `<img src="${iconUrl}" alt="">` : coverMini(p.name)}</div>
          <div style="min-width:0"><div class="acard__name">${esc(p.name)}</div>
            <div class="acard__meta">
              <span class="tag">v${esc(p.version)}</span>
              <span class="tag">${esc(p.mc)} · ${esc(loaderLabel(p.loader))}</span>
              <span class="tag">${p.visibility === 'private' ? `${icon('lock')} privada (${(p.allow || []).length})` : `${icon('globe')} pública`}</span>
              ${d ? '<span class="chip chip--hot">borrador sin publicar</span>' : ''}
            </div></div>
        </button>`;
      });
      for (const d of drafts.values()) {
        cards.push(`<button class="acard" type="button" data-open="${esc(d.id)}">
          <div class="acard__icon">${coverMini(d.name || d.id)}</div>
          <div style="min-width:0"><div class="acard__name">${esc(d.name || d.id)}</div>
            <div class="acard__meta"><span class="chip chip--hot">nueva · sin publicar</span><span class="tag">editada ${esc(timeAgo(d.updatedAt))}</span></div></div>
        </button>`);
      }
      if (can('create')) cards.push(`<button class="acard acard--new" type="button" data-act="new">${icon('plus')}<span>Crear una instancia nueva</span></button>`);
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
    if (b.dataset.act === 'new' && can('create')) newInstanceModal(app);
    if (b.dataset.act === 'players' && can('players')) playersModal();
  });
  load();
  return () => {};
}

// Selector de versión de Minecraft + cargador + versión del cargador.
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
  return { value: () => ({ mc: st.mc, loader: { type: st.loader, version: st.loader === 'vanilla' ? '' : st.loaderVersion } }) };
}

function newInstanceModal(app) {
  const m = modal({
    size: 'lg',
    html: `<div class="modal__body">
      <h2 class="modal__title">Nueva instancia</h2>
      <p class="modal__text">Empieza desde cero o importa un modpack que ya tengas (CurseForge, Prism, Modrinth…).</p>
      <form id="nf" style="display:grid;gap:16px;margin-top:18px">
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
  f.name.addEventListener('input', () => { if (!idTouched) f.id.value = slugify(f.name.value); });
  f.id.addEventListener('input', () => { idTouched = true; f.id.value = slugify(f.id.value); });
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
      app.go({ name: 'admin', id });
    } catch (er) { err(er); }
  });
  m.content.querySelectorAll('[data-import]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const id = await create(b);
      m.close();
      app.go({ name: 'admin', id, tab: 'content' });
      setTimeout(() => (b.dataset.import === 'mrpack' ? importMrpack(id, app) : importFolder(id, app)), 400);
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

// ======================= EDITOR =======================
function renderEditor(root, id, app) {
  let d = null;
  let tab = 'general';
  let filter = '';
  const offs = [];

  const saveMeta = debounce(async (patch) => {
    try { d = await call('admin:saveMeta', id, patch); paintBar(); } catch (e) { toastError(e); }
  }, 450);

  const draw = () => {
    const iconKey = d.media?.icon;
    const iconSrc = iconKey?.local ? `vsl-media://local/admin/${iconKey.name}` : mediaUrl(iconKey?.key);
    root.innerHTML = `
      <div class="editor">
        <div class="editor__head">
          <button class="btn btn--icon btn--ghost" type="button" data-act="back" data-tip="Volver">${icon('arrowLeft')}</button>
          <div class="acard__icon" style="width:44px;height:44px;border-radius:12px">${iconSrc ? `<img src="${iconSrc}" alt="">` : coverMini(d.meta.name)}</div>
          <div style="min-width:0;flex:1"><div class="title-md">${esc(d.meta.name)}</div>
            <div class="acard__meta" style="margin-top:4px"><span class="tag mono">${esc(d.id)}</span>${d.baseVersion ? `<span class="tag">publicada v${d.baseVersion}</span>` : '<span class="chip chip--hot">nueva</span>'}<span class="tag">${esc(d.meta.mc)} · ${esc(loaderLabel(d.meta.loader))}</span></div></div>
          <button class="btn btn--sm btn--ghost" type="button" data-act="more">${icon('more')}</button>
        </div>
        <div class="editor__tabs">
          ${[['general', 'General', 'edit'], ['look', 'Apariencia', 'image'], ['content', 'Contenido', 'package'], ['access', 'Permisos', 'lock']]
            .map(([k, l, ic]) => `<button class="editor__tab ${tab === k ? 'is-active' : ''}" type="button" data-tab="${k}">${icon(ic)}${l}${k === 'content' ? `<span class="count">${d.files.length}</span>` : ''}</button>`).join('')}
        </div>
        <div class="editor__body" id="ed-body"></div>
        <div class="pubbar"><div class="pubbar__info" id="ed-info"></div>
          <div class="field__row">
            ${d.baseVersion && can('edit') ? `<button class="btn btn--ghost" type="button" data-act="meta-only" data-tip="Publica textos, imágenes y permisos sin subir una versión nueva">${icon('check')}Guardar solo textos y permisos</button>` : ''}
            ${can(d.baseVersion ? 'edit' : 'create') ? `<button class="btn btn--primary" type="button" data-act="publish">${icon('upload')}Publicar versión ${(d.baseVersion || 0) + 1}</button>` : '<span class="field__hint">No tienes permiso para publicar cambios en esta instancia.</span>'}
          </div></div>
      </div>`;
    hydrateIcons(root);
    drawTab();
    paintBar();
  };

  const paintBar = () => {
    const info = root.querySelector('#ed-info');
    if (!info) return;
    const s = d.stats || {};
    info.innerHTML = `<span><b>${s.files ?? d.files.length}</b> archivos</span><span><b>${bytes(s.size || 0)}</b></span><span><b>${s.mods ?? 0}</b> mods</span>${s.pendingUpload ? `<span><b>${s.pendingUpload}</b> por subir</span>` : ''}<span>${d.meta.visibility === 'private' ? `${icon('lock')} privada · ${d.meta.allow.length} nick(s)` : `${icon('globe')} pública`}</span>`;
    hydrateIcons(info);
    const c = root.querySelector('[data-tab="content"] .count');
    if (c) c.textContent = d.files.length;
  };

  const drawTab = () => {
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    const body = root.querySelector('#ed-body');
    if (tab === 'general') tabGeneral(body);
    if (tab === 'look') tabLook(body);
    if (tab === 'content') tabContent(body);
    if (tab === 'access') tabAccess(body);
    hydrateIcons(body);
  };

  // ---------- General ----------
  const tabGeneral = (body) => {
    const mt = d.meta;
    body.innerHTML = `
      <div class="editor__cols">
        <label class="field"><span class="field__label">Nombre <em>*</em></span><input class="input" data-m="name" maxlength="60" value="${esc(mt.name)}"></label>
        <label class="field"><span class="field__label">Resumen (una frase)</span><input class="input" data-m="summary" maxlength="180" value="${esc(mt.summary)}" placeholder="El hardcore más difícil del estudio"></label>
      </div>
      <label class="field"><span class="field__label">Descripción</span><textarea class="input textarea" data-m="description" rows="5" maxlength="5000" placeholder="Explica de qué va la instancia. Usa **negrita** y deja una línea en blanco entre párrafos.">${esc(mt.description)}</textarea></label>
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
      <label class="switch"><input type="checkbox" data-m="featured" ${mt.featured ? 'checked' : ''}> Destacar en el inicio</label>
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
        d = await busy(e.currentTarget, () => call('admin:saveMeta', id, v));
        toast(`Versión: Minecraft ${v.mc} · ${loaderLabel(v.loader)}`, { kind: 'success' });
        draw();
      } catch (er) { toastError(er); }
    });
  };

  // ---------- Apariencia ----------
  const tabLook = (body) => {
    const src = (m) => (m?.local ? `vsl-media://local/admin/${m.name}` : mediaUrl(m?.key));
    const iconM = d.media?.icon;
    const bgM = d.media?.background;
    const bgIsVideo = bgM && isVideo(bgM.type, bgM.name || bgM.key);
    body.innerHTML = `
      <div class="editor__cols" style="grid-template-columns:auto 1fr;align-items:start">
        <div class="field"><span class="field__label">Icono</span>
          <div class="media-pick media-pick--icon ${iconM ? 'has-media' : ''}" data-pick="icon">
            ${iconM ? `<img src="${src(iconM)}" alt="">` : ''}
            <span class="media-pick__label">${icon('image')}Elegir icono<small>PNG, JPG, WEBP o GIF</small></span>
          </div>
          ${iconM ? '<button class="btn btn--sm btn--ghost" type="button" data-clear="icon">Quitar</button>' : ''}
        </div>
        <div class="field"><span class="field__label">Fondo de la instancia</span>
          <div class="media-pick media-pick--bg ${bgM ? 'has-media' : ''}" data-pick="background">
            ${bgM ? (bgIsVideo ? `<video src="${src(bgM)}" muted loop autoplay playsinline></video>` : `<img src="${src(bgM)}" alt="">`) : ''}
            <span class="media-pick__label">${icon('video')}Elegir fondo<small>Imagen, GIF o vídeo (MP4/WEBM, hasta 80 MB)</small></span>
          </div>
          <div class="field__row">${bgM ? '<button class="btn btn--sm btn--ghost" type="button" data-clear="background">Quitar</button>' : ''}<span class="field__hint">Se ve detrás del botón Jugar. Las imágenes se optimizan solas; para vídeo usa algo corto que se pueda repetir en bucle.</span></div>
        </div>
      </div>`;
    body.querySelectorAll('[data-pick]').forEach((el) => el.addEventListener('click', () => pickMedia(el.dataset.pick)));
    body.querySelectorAll('[data-clear]').forEach((el) => el.addEventListener('click', async () => {
      d = await call('admin:clearMedia', id, el.dataset.clear);
      draw();
    }));
  };

  const pickMedia = (kind) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = kind === 'icon' ? 'image/png,image/jpeg,image/webp,image/gif' : 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm';
    inp.addEventListener('change', async () => {
      const file = inp.files[0];
      if (!file) return;
      const t = toast('Preparando imagen…', { timeout: 0 });
      try {
        const out = await processMedia(file, kind);
        d = await call('admin:setMedia', id, kind, out);
        draw();
      } catch (e) { toastError(e); } finally { t(); }
    });
    inp.click();
  };

  // ---------- Contenido ----------
  const tabContent = (body) => {
    body.innerHTML = `
      <div class="files" id="files">
        <div class="files__toolbar">
          <button class="btn btn--sm btn--primary" type="button" data-act="modrinth">${icon('search')}Buscar en Modrinth</button>
          <button class="btn btn--sm" type="button" data-act="upload">${icon('upload')}Subir archivos</button>
          <button class="btn btn--sm" type="button" data-act="upload-folder">${icon('folder')}Subir carpeta</button>
          <button class="btn btn--sm btn--ghost" type="button" data-act="import-folder">${icon('download')}Importar instancia</button>
          <button class="btn btn--sm btn--ghost" type="button" data-act="import-mrpack">${icon('package')}Importar .mrpack</button>
          <input class="input" id="ffilter" placeholder="Filtrar…" value="${esc(filter)}" style="margin-left:auto">
        </div>
        <div id="flist"></div>
      </div>
      <p class="field__hint">Arrastra archivos aquí para añadirlos. <b>Sobrescribir</b> = se reemplaza en cada actualización. <b>Solo la primera vez</b> = el jugador puede cambiarlo (ideal para <code>options.txt</code>). Los mods de Modrinth se descargan desde su CDN: no ocupan espacio en tu servidor.</p>`;
    drawFiles(body);
    body.querySelector('#ffilter').addEventListener('input', debounce((e) => { filter = e.target.value.toLowerCase(); drawFiles(body); }, 150));
    const zone = body.querySelector('#files');
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drop-hint'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drop-hint'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('drop-hint');
      const paths = [...e.dataTransfer.files].map((f) => pathFor(f)).filter(Boolean);
      if (!paths.length) return;
      const target = await askFolder(paths.every((p) => /\.jar$/i.test(p)) ? 'mods' : '');
      if (target == null) return;
      await addPaths(paths, target);
    });
  };

  const addPaths = async (paths, target) => {
    const t = toast(`Añadiendo ${paths.length} elemento(s)…`, { timeout: 0 });
    try {
      const r = await call('admin:addPaths', id, paths, target);
      d = r.draft;
      toast(`${r.added} archivo(s) añadidos.`, { kind: 'success' });
      draw();
    } catch (er) { toastError(er); } finally { t(); }
  };

  const drawFiles = (body) => {
    const list = body.querySelector('#flist');
    const files = d.files.filter((f) => !filter || f.path.toLowerCase().includes(filter) || (f.title || '').toLowerCase().includes(filter));
    if (!d.files.length) {
      list.innerHTML = `<div class="empty" style="margin:14px;border-radius:12px">${icon('package')}<h3>Instancia vacía</h3><p>Busca mods en Modrinth, sube tus archivos o importa una instancia que ya tengas.</p></div>`;
      hydrateIcons(list);
      return;
    }
    const groups = FOLDERS.map(([dir, label, ic]) => {
      const items = files.filter((f) => (dir ? f.path.startsWith(`${dir}/`) : !FOLDERS.some(([x]) => x && f.path.startsWith(`${x}/`))));
      return { dir, label, ic, items };
    }).filter((g) => g.items.length);
    list.innerHTML = groups.map((g) => `
      <div class="files__group">
        <div class="files__ghead">${icon(g.ic)}${esc(g.label)} <span class="muted">${g.items.length} · ${bytes(g.items.reduce((a, f) => a + (f.size || 0), 0))}</span></div>
        ${g.items.sort((a, b) => a.path.localeCompare(b.path)).map((f) => {
          const name = f.title || f.path.split('/').pop();
          const src = f.source === 'modrinth' ? '<span class="src src--modrinth">Modrinth</span>' : f.source === 'url' ? '<span class="src src--url">Enlace</span>' : f.local ? '<span class="src src--pending">Por subir</span>' : '<span class="src src--upload">Propio</span>';
          return `<div class="frow">
            <div class="frow__icon">${f.icon ? `<img src="${esc(f.icon)}" alt="" loading="lazy">` : icon(g.ic)}</div>
            <div class="frow__name"><b>${esc(name)}</b><small>${esc(f.path)}${f.versionName ? ` · ${esc(f.versionName)}` : ''}</small></div>
            ${src}
            <span class="frow__size">${bytes(f.size || 0)}</span>
            <span class="field__row" style="gap:2px">
              <button class="icon-btn" type="button" data-policy="${esc(f.path)}" data-tip="${f.policy === 'once' ? 'Solo la primera vez (el jugador puede cambiarlo)' : 'Se sobrescribe en cada actualización'}">${icon(f.policy === 'once' ? 'lock' : 'refresh')}</button>
              <button class="icon-btn is-danger" type="button" data-del="${esc(f.path)}" data-tip="Quitar">${icon('trash')}</button>
            </span>
          </div>`;
        }).join('')}
      </div>`).join('');
    hydrateIcons(list);
  };

  // ---------- Permisos ----------
  const tabAccess = (body) => {
    const mt = d.meta;
    body.innerHTML = `
      <div class="panel">
        <div class="panel__title"><span>¿Quién puede ver esta instancia?</span></div>
        <div class="segmented" id="vis"><button type="button" data-v="public">${icon('globe')} Pública</button><button type="button" data-v="private">${icon('lock')} Privada</button></div>
        <p class="field__hint" style="margin-top:10px" id="vis-hint"></p>
      </div>
      <div class="panel" id="allow-box">
        <div class="panel__title"><span>Nicks con permiso</span><span class="muted mono" style="font-size:.8rem" id="allow-count"></span></div>
        <div class="chips-input" id="allow"><input placeholder="Escribe un nick y pulsa Enter (o pega varios separados por comas)"></div>
        <p class="field__hint" style="margin-top:10px">Vale para cuentas premium y no premium: el jugador debe entrar al launcher con ese nick. Los nicks no premium están protegidos con su código de recuperación, así nadie puede hacerse pasar por otro.</p>
      </div>`;
    const drawVis = () => {
      body.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('is-active', b.dataset.v === d.meta.visibility));
      body.querySelector('#vis-hint').textContent = d.meta.visibility === 'private'
        ? 'Solo la verán (y podrán descargarla) los nicks de la lista. Los archivos privados también están protegidos en el servidor.'
        : 'Cualquier jugador del launcher la verá y podrá descargarla.';
      body.querySelector('#allow-box').style.opacity = d.meta.visibility === 'private' ? '1' : '0.5';
    };
    const allowBox = body.querySelector('#allow');
    const input = allowBox.querySelector('input');
    const drawAllow = () => {
      allowBox.querySelectorAll('.chip').forEach((c) => c.remove());
      for (const n of d.meta.allow) {
        const c = document.createElement('span');
        c.className = 'chip';
        c.dataset.nick = n;
        c.innerHTML = `${esc(n)} ${icon('close')}`;
        c.title = 'Quitar';
        allowBox.insertBefore(c, input);
      }
      body.querySelector('#allow-count').textContent = `${d.meta.allow.length} nick(s)`;
    };
    const setAllow = (list) => {
      d.meta.allow = [...new Set(list)].slice(0, 500);
      drawAllow();
      saveMeta({ allow: d.meta.allow });
      paintBar();
    };
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
      const c = e.target.closest('.chip');
      if (c) setAllow(d.meta.allow.filter((n) => n !== c.dataset.nick));
      else input.focus();
    });
    drawVis();
    drawAllow();
  };

  // ---------- Acciones ----------
  root.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-tab]');
    if (tb) { tab = tb.dataset.tab; drawTab(); return; }
    const pol = e.target.closest('[data-policy]');
    if (pol) {
      const f = d.files.find((x) => x.path === pol.dataset.policy);
      d = await call('admin:updateFile', id, f.path, { policy: f.policy === 'once' ? 'always' : 'once' }).catch((er) => { toastError(er); return d; });
      drawFiles(root);
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      d = await call('admin:removeFiles', id, [del.dataset.del]).catch((er) => { toastError(er); return d; });
      drawFiles(root);
      paintBar();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'back') app.go({ name: 'admin' });
    if (act === 'modrinth') modrinthModal(id, d, (nd) => { d = nd; drawFiles(root); paintBar(); });
    if (act === 'upload' || act === 'upload-folder') {
      const target = await askFolder(act === 'upload' ? 'mods' : '');
      if (target == null) return;
      try {
        const r = await call('admin:addFiles', id, target, act === 'upload-folder');
        if (r) { d = r.draft; toast(`${r.added} archivo(s) añadidos.`, { kind: 'success' }); draw(); }
      } catch (er) { toastError(er); }
    }
    if (act === 'import-folder') importFolder(id, app, (nd) => { d = nd; draw(); });
    if (act === 'import-mrpack') importMrpack(id, app, (nd) => { d = nd; draw(); });
    if (act === 'publish') publish(id, d, app);
    if (act === 'meta-only') {
      try {
        await busy(b, () => call('admin:updateMeta', id, d.meta));
        toast('Textos y permisos publicados.', { kind: 'success' });
      } catch (er) { toastError(er); }
    }
    if (act === 'more') {
      menu(b, [
        { label: 'Descartar borrador', icon: 'refresh', onClick: async () => {
          const ok = await confirm({ title: '¿Descartar los cambios?', text: d.baseVersion ? 'Se perderán los cambios sin publicar. La instancia publicada no cambia.' : 'Esta instancia nunca se publicó: se borrará el borrador.', ok: 'Descartar', danger: true, icon: 'trash' });
          if (!ok) return;
          await call('admin:discard', id);
          app.go({ name: 'admin' });
        } },
        ...(d.baseVersion && can('delete') ? ['-', { label: 'Eliminar del servidor', icon: 'trash', danger: true, onClick: async () => {
          const ok = await confirm({ title: `¿Eliminar ${d.meta.name}?`, text: 'Desaparecerá para todos los jugadores y se borrarán sus archivos del servidor. No se puede deshacer.', ok: 'Eliminar', danger: true, icon: 'trash' });
          if (!ok) return;
          try { await call('admin:remove', id); toast('Instancia eliminada.', { kind: 'success' }); app.go({ name: 'admin' }); } catch (er) { toastError(er); }
        } }] : []),
      ]);
    }
  });

  offs.push(on('admin-progress', () => {}));
  call('admin:open', id).then((r) => { d = r; draw(); }).catch((e) => {
    root.innerHTML = `<div class="page"><div class="empty">${icon('alert')}<h3>No se pudo abrir</h3><p>${esc(e.message)}</p><button class="btn" type="button" data-back>Volver</button></div></div>`;
    hydrateIcons(root);
    root.querySelector('[data-back]').addEventListener('click', () => app.go({ name: 'admin' }));
  });
  root.innerHTML = '<div class="page"><div class="empty"><span class="spin"></span><p>Abriendo…</p></div></div>';
  return () => offs.forEach((f) => f());
}

// Pide la carpeta de destino dentro de la instancia.
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

// Búsqueda en Modrinth
function modrinthModal(id, draft, onChange) {
  let type = 'mod';
  let offset = 0;
  let total = 0;
  const m = modal({
    size: 'lg',
    html: `<div class="modal__body"><h2 class="modal__title">Buscar en <span class="grad-text">Modrinth</span></h2>
      <p class="modal__text">Solo se muestran los compatibles con Minecraft ${esc(draft.meta.mc)}${draft.meta.loader.type !== 'vanilla' ? ` y ${esc(LOADER_NAMES[draft.meta.loader.type])}` : ''}. Las dependencias necesarias se añaden solas.</p>
      <div class="field__row" style="margin-top:16px">
        <div class="segmented" id="mt"><button type="button" data-t="mod" class="is-active">Mods</button><button type="button" data-t="resourcepack">Resource packs</button><button type="button" data-t="shader">Shaders</button></div>
        <input class="input" id="mq" placeholder="Buscar… (sodium, jei, create…)" autofocus>
      </div>
      <div class="mr-results" id="mr" style="margin-top:14px"></div>
      <div class="field__row" style="justify-content:center;margin-top:10px"><button class="btn btn--sm btn--ghost" type="button" id="more" hidden>Cargar más</button></div></div>`,
  });
  const box = m.content.querySelector('#mr');
  const inDraft = (pid) => draft.files.some((f) => f.project === pid);
  const search = async (append = false) => {
    if (!append) { offset = 0; box.innerHTML = '<span class="spin"></span>'; }
    try {
      const r = await call('modrinth:search', { query: m.content.querySelector('#mq').value.trim(), type, mc: draft.meta.mc, loader: draft.meta.loader.type, offset, limit: 20 });
      total = r.total;
      const html = r.hits.map((h) => `<div class="mr-item">
        ${h.icon ? `<img src="${esc(h.icon)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div style="min-width:0"><b>${esc(h.title)}</b><small>${esc(h.description)}</small><small class="mono">por ${esc(h.author)} · ${Number(h.downloads).toLocaleString('es-ES')} descargas${h.clientSide === 'unsupported' ? ' · solo servidor' : ''}</small></div>
        <button class="btn btn--sm ${inDraft(h.id) ? '' : 'btn--primary'}" type="button" data-add="${esc(h.id)}" ${inDraft(h.id) ? 'disabled' : ''}>${inDraft(h.id) ? 'Añadido' : 'Añadir'}</button>
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
      draft = r.draft;
      onChange(r.draft);
      b.textContent = 'Añadido';
      b.classList.remove('btn--primary');
      b.disabled = true;
      const extra = r.added.length - 1;
      toast(`Añadido ${r.added[0]?.title || ''}${extra > 0 ? ` + ${extra} dependencia(s)` : ''}.`, { kind: 'success' });
    } catch (er) { toastError(er); }
  });
  search();
}

async function importFolder(id, app, onDone) {
  let scan;
  try { scan = await call('admin:scanFolder'); } catch (e) { toastError(e); return; }
  if (!scan) return;
  const det = scan.detected;
  const m = modal({
    size: 'lg',
    html: `<div class="modal__body"><h2 class="modal__title">Importar instancia</h2>
      <p class="modal__text">${det ? `Detectado: <b>${esc(det.source)}</b> · Minecraft ${esc(det.mc || '?')} · ${esc(loaderLabel(det.loader))}` : 'Elige qué quieres incluir.'} Los mods que existan en Modrinth se enlazarán a su CDN; el resto se subirá a tu servidor.</p>
      <div class="check-list" style="margin-top:14px">${scan.entries.map((e, i) => `<label><span class="check"><input type="checkbox" data-i="${i}" ${e.suggested ? 'checked' : ''}> ${icon(e.dir ? 'folder' : 'file')} ${esc(e.name)}</span><small>${e.dir ? `${e.count} archivos · ` : ''}${bytes(e.size)}</small></label>`).join('')}</div>
      ${det?.mc ? `<label class="check" style="margin-top:12px"><input type="checkbox" id="use-ver" checked> Usar la versión detectada (${esc(det.mc)} · ${esc(loaderLabel(det.loader))})</label>` : ''}
      <p class="field__hint" style="margin-top:8px">Los mundos (<code>saves</code>) pueden pesar mucho: inclúyelos solo si quieres repartir un mapa.</p>
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
      toast(`Importados ${r.total} archivos: ${r.fromModrinth} desde Modrinth y ${r.uploads} para subir.`, { kind: 'success', timeout: 7000 });
      m.setLocked(false);
      m.close();
      onDone ? onDone(r.draft) : app.go({ name: 'admin', id });
    } catch (er) {
      toastError(er);
      m.setLocked(false);
      btn.disabled = false;
      btn.innerHTML = `${icon('download')}Importar`;
    } finally { off(); }
  });
}

async function importMrpack(id, app, onDone) {
  const t = toast('Importando modpack…', { timeout: 0 });
  try {
    const r = await call('admin:importMrpack', id);
    if (!r) return;
    toast(`Modpack importado: ${r.total} archivos.`, { kind: 'success' });
    onDone ? onDone(r.draft) : app.go({ name: 'admin', id });
  } catch (e) { toastError(e); } finally { t(); }
}

async function publish(id, d, app) {
  const pending = d.stats?.pendingUpload || 0;
  const ok = await confirm({
    title: `¿Publicar versión ${(d.baseVersion || 0) + 1}?`,
    html: `${esc(d.meta.name)} · ${d.files.length} archivos${pending ? ` · <b>${pending}</b> por subir` : ''}.<br>Los jugadores verán el botón <b>Actualizar</b>. ${d.meta.visibility === 'private' ? `Solo para ${d.meta.allow.length} nick(s).` : 'Visible para todos.'}`,
    ok: 'Publicar', icon: 'upload',
  });
  if (!ok) return;
  const m = modal({
    size: 'sm', locked: true,
    html: `<div class="modal__body"><h2 class="modal__title">Publicando…</h2>
      <div class="progress-line" style="margin-top:18px"><div class="dl__phase" id="pp">Preparando…</div><div class="dl__bar is-indeterminate" id="pb"><span></span></div><div class="dl__stats" id="ps"></div></div>
      <p class="field__hint" style="margin-top:14px">No cierres el launcher hasta que termine.</p></div>`,
  });
  const off = on('admin-progress', (p) => {
    if (p.id !== `publish:${id}`) return;
    m.content.querySelector('#pp').textContent = p.label;
    const bar = m.content.querySelector('#pb');
    const pct = p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : null;
    bar.classList.toggle('is-indeterminate', pct == null);
    bar.style.setProperty('--p', `${pct || 0}%`);
    m.content.querySelector('#ps').innerHTML = p.total > 0 ? `<span><b>${bytes(p.done)}</b> de ${bytes(p.total)}</span><span><b>${speed(p.speed)}</b></span>${p.eta != null ? `<span>quedan <b>${duration(p.eta)}</b></span>` : ''}` : '';
  });
  try {
    const inst = await call('admin:publish', id);
    m.setLocked(false);
    m.close();
    toast(`¡${inst?.name || 'Instancia'} publicada! (versión ${inst?.version})`, { kind: 'success', timeout: 6000 });
    app.go({ name: 'admin' });
  } catch (e) {
    m.setLocked(false);
    m.close();
    toastError(e, 'No se pudo publicar: ');
  } finally { off(); }
}

// Optimiza imágenes (WebP) antes de subirlas; GIF y vídeo se mantienen tal cual.
async function processMedia(file, kind) {
  const type = file.type || '';
  if (/^video\//.test(type)) {
    if (kind === 'icon') throw new Error('El icono debe ser una imagen o un GIF.');
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
      const scale = Math.min(1, 1920 / img.width);
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
