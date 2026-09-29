import { state, on, call, instance } from '../api.js';
import { icon, hydrateIcons } from '../icons.js';
import { esc, richText, instIcon, loaderLabel, timeAgo, playTime, bytes, speed, duration } from '../util.js';
import { toast, toastError, confirm, menu, modal, busy } from '../ui.js';
import { scramble, burst } from '../fx.js';

export function statusChip(i) {
  const p = state.progress.get(i.id);
  switch (i.status) {
    case 'installing': return `<span class="chip chip--hot"><span class="spin" style="width:10px;height:10px;border-width:2px"></span>${p?.percent != null ? `${Math.floor(p.percent)}%` : 'Descargando'}</span>`;
    case 'running': return `<span class="chip chip--hot"><span class="live-dot"></span>Jugando</span>`;
    case 'launching': return '<span class="chip chip--hot">Iniciando…</span>';
    case 'update': return `<span class="chip chip--hot">${icon('refresh')}${i.interrupted ? 'Sin terminar' : 'Actualización'}</span>`;
    case 'installed': return `<span class="chip">${icon('check')}Instalada</span>`;
    default: return '';
  }
}

const PLAY_LABEL = { install: 'Descargar', update: 'Actualizar', play: 'Jugar' };
const HIDDEN_NAMES = { mods: 'los mods', config: 'config', resourcepacks: 'los resource packs' };

function topChips(inst) {
  const sync = inst.workspace ? `<span class="chip chip--sync">${icon('refresh')}Sincronizada con tu carpeta</span>` : '';
  const test = inst.test
    ? `<span class="chip chip--test">${icon('eye')}Copia de prueba</span><span class="inst__testnote">Así la ve un jugador: se descarga y se actualiza igual que la de cualquiera${inst.protect?.length ? ` (con ${inst.protect.map((p) => HIDDEN_NAMES[p] || p).join(', ')} ocultos)` : ''}. Publica una versión nueva y pulsa Actualizar para probarla.</span>`
    : '';
  return `${statusChip(inst)}${sync}${test}`;
}

const folderAllowed = (inst) => inst.showFolder !== false || inst.canManage || Boolean(inst.workspace);
const adminOn = () => Boolean(state.admin?.unlocked);

function actionHtml(inst) {
  const p = state.progress.get(inst.id);
  switch (inst.status) {
    case 'installing': return downloadCard(inst, p);
    case 'launching':
      return `<button class="play" type="button" disabled><span class="spin"></span><span class="play__label">Iniciando…</span></button>`;
    case 'running':
      return `<button class="play play--running" type="button" tabindex="-1"><span class="live-dot"></span><span class="play__label">Jugando</span></button>
        <button class="btn btn--danger" type="button" data-act="stop">${icon('stop')}Cerrar juego</button>`;
    case 'update':
      return `<button class="play play--update" type="button" data-act="install">${icon('refresh')}<span class="play__label">${PLAY_LABEL.update}</span></button>`;
    case 'installed':
      return `<button class="play" type="button" data-act="play">${icon('play')}<span class="play__label">${PLAY_LABEL.play}</span></button>`;
    default:
      return `<button class="play" type="button" data-act="install" ${inst.available ? '' : 'disabled'}>${icon('download')}<span class="play__label">${PLAY_LABEL.install}</span></button>`;
  }
}

function downloadCard(inst, p) {
  return `
    <div class="dl" id="dl">
      <div class="dl__thumb">${instIcon(inst)}<div class="dl__thumb-fill"></div></div>
      <div class="dl__body">
        <div class="dl__row"><span class="dl__title" data-f="title">${esc(dlTitle(inst, p))}</span><span class="dl__pct" data-f="pct"></span></div>
        <div class="dl__phase" data-f="phase">${esc(p?.label || 'Preparando…')}</div>
        <div class="dl__bar" data-f="bar"><span></span></div>
        <div class="dl__stats" data-f="stats"></div>
      </div>
      <button class="dl__cancel" type="button" data-act="cancel" data-tip="Cancelar (se guarda lo descargado)">${icon('close')}</button>
    </div>`;
}

function dlTitle(inst, p) {
  if (p?.kind === 'repair') return 'Reparando';
  if (p?.kind === 'launch') return 'Preparando';
  return inst.installed ? 'Actualizando' : 'Descargando';
}

function paintProgress(root, inst, p) {
  const card = root.querySelector('#dl');
  if (!card || !p) return;
  const pct = p.percent;
  card.style.setProperty('--p', `${pct != null ? pct.toFixed(1) : 0}%`);
  const f = (n) => card.querySelector(`[data-f="${n}"]`);
  f('title').textContent = dlTitle(inst, p);
  f('phase').textContent = p.label || '';
  f('pct').textContent = pct != null && p.total > 0 ? `${Math.floor(pct)}%` : '';
  f('bar').classList.toggle('is-indeterminate', !(p.total > 0) || p.phase === 'install' || p.phase === 'loader' || p.phase === 'prepare');
  const parts = [];
  if (p.total > 0 && p.phase !== 'install' && p.phase !== 'loader') {
    parts.push(`<span><b>${esc(speed(p.speed))}</b></span>`);
    parts.push(`<span><b>${esc(bytes(p.done))}</b> de ${esc(bytes(p.total))}</span>`);
    if (p.eta != null) parts.push(`<span>quedan <b>${esc(duration(p.eta))}</b></span>`);
  } else if (p.filesTotal) parts.push(`<span>${p.filesDone} / ${p.filesTotal} archivos</span>`);
  f('stats').innerHTML = parts.join('');
}

export function render(root, route, app) {
  const id = route.id;
  let inst = instance(id);
  if (!inst) {
    app.scene.clear();
    root.innerHTML = `<div class="page"><div class="empty">${icon('alert')}<h3>Instancia no disponible</h3><p>Puede que ya no tengas permiso para verla o que Viciont Studios la haya retirado.</p><button class="btn btn--primary" data-home type="button">${icon('home')}Ir al inicio</button></div></div>`;
    root.querySelector('[data-home]').addEventListener('click', () => app.go({ name: 'home' }));
    return () => {};
  }
  app.scene.show(inst);
  app.bg.setMode('dim');

  const renderAll = () => {
    const settingsMax = state.settings?.memory?.max || 0;
    const assigned = inst.options?.memory?.max || settingsMax;
    const rec = inst.memory?.recommended || 0;
    root.innerHTML = `
      <section class="inst">
        <div class="inst__top">
          <div class="inst__chips">${topChips(inst)}</div>
          <div class="field__row">
            ${inst.workspace && adminOn() ? `<button class="btn btn--sm btn--ghost" type="button" data-act="edit">${icon('edit')}Editar</button>` : ''}
            ${inst.installed && folderAllowed(inst) ? `<button class="btn btn--sm btn--ghost" type="button" data-act="folder">${icon('folder')}Carpeta</button>` : ''}
            <button class="btn btn--sm btn--icon btn--ghost" type="button" data-act="more" data-tip="Más opciones" aria-label="Más opciones">${icon('more')}</button>
          </div>
        </div>
        <div class="inst__content">
          <div class="inst__head">
            <div class="inst__icon">${instIcon(inst)}</div>
            <div>
              <div class="inst__chips">
                <span class="chip">${icon('cube')}Minecraft ${esc(inst.mc || '')}</span>
                <span class="chip">${icon('layers')}${esc(loaderLabel(inst.loader))}</span>
                ${inst.filesCount ? `<span class="chip">${icon('package')}${inst.modsCount ?? inst.filesCount} ${inst.modsCount != null ? 'mods' : 'archivos'}</span>` : ''}
                ${inst.visibility === 'private' ? `<span class="chip chip--hot">${icon('lock')}Privada</span>` : ''}
                ${(inst.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
              </div>
              <h1 class="inst__title glitch" data-text="${esc(inst.name)}" id="inst-title">${esc(inst.name)}</h1>
            </div>
          </div>
          ${inst.summary ? `<p class="inst__summary">${esc(inst.summary)}</p>` : ''}
          ${inst.description ? `<div class="inst__desc rich" id="inst-desc">${richText(inst.description)}</div><button class="inst__more" type="button" id="inst-more">Leer más</button>` : ''}
          ${inst.workspace?.behind ? `<p class="inst__warn">${icon('alert')}Otro administrador publicó una versión más nueva. Tráela desde Administración antes de seguir cambiando cosas.</p>` : ''}
          ${inst.workspace && !inst.workspace.behind ? `<p class="inst__note">${icon('refresh')}Esta es tu carpeta de trabajo: lo que cambies aquí (mods, configs, options.txt…) es lo que se publica desde Administración.</p>` : ''}
          ${inst.interrupted ? `<p class="inst__warn">${icon('alert')}La descarga anterior no terminó. Pulsa el botón para continuar donde se quedó.</p>` : ''}
          ${!inst.available && inst.installed ? `<p class="inst__warn">${icon('alert')}Esta instancia ya no está en el servidor (o no hay conexión). Puedes seguir jugando la versión instalada.</p>` : ''}
          ${rec && assigned && rec > assigned ? `<p class="inst__warn">${icon('cpu')}Viciont Studios recomienda ${Math.round(rec / 1024 * 10) / 10} GB de RAM y tienes ${Math.round(assigned / 1024 * 10) / 10} GB asignados. Cámbialo en Opciones.</p>` : ''}
          ${inst.status === 'update' && inst.changelog ? `<div class="panel"><div class="panel__title">Novedades de la versión ${esc(inst.version)}</div><div class="rich">${richText(inst.changelog)}</div></div>` : ''}
        </div>
        <div class="inst__bottom">
          <div class="inst__actions" id="inst-action">${actionHtml(inst)}</div>
          <div class="inst__meta">
            <span>Versión <b>${esc(inst.version ?? '—')}</b>${inst.installed && inst.installedVersion !== inst.version ? ` (tienes la ${esc(inst.installedVersion)})` : ''}</span>
            ${inst.updatedAt ? `<span>Actualizada <b>${esc(timeAgo(inst.updatedAt))}</b></span>` : ''}
            ${inst.size ? `<span>Tamaño <b>${esc(bytes(inst.size))}</b></span>` : ''}
            ${inst.installed ? `<span>Jugado <b>${esc(playTime(inst.playTime))}</b></span>` : ''}
            ${inst.server ? `<span>Servidor <b>${esc(inst.server)}</b></span>` : ''}
          </div>
        </div>
      </section>`;
    hydrateIcons(root);
    const t = root.querySelector('#inst-title');
    scramble(t, inst.name, { duration: 600 });
    const more = root.querySelector('#inst-more');
    more?.addEventListener('click', () => {
      const d = root.querySelector('#inst-desc');
      d.classList.toggle('is-open');
      more.textContent = d.classList.contains('is-open') ? 'Leer menos' : 'Leer más';
    });
    const d = root.querySelector('#inst-desc');
    if (d && d.scrollHeight <= d.clientHeight + 4) { d.classList.add('is-open'); more?.remove(); }
    paintProgress(root, inst, state.progress.get(id));
  };

  const renderAction = () => {
    const box = root.querySelector('#inst-action');
    if (!box) return renderAll();
    box.innerHTML = actionHtml(inst);
    hydrateIcons(box);
    paintProgress(root, inst, state.progress.get(id));
  };

  let lastStatus = inst.status;
  const offInst = on(`instance:${id}`, (d) => {
    const prev = inst;
    inst = d;
    if (d.status !== lastStatus) {
      lastStatus = d.status;
      if (prev.installedVersion !== d.installedVersion || prev.available !== d.available || prev.version !== d.version) renderAll();
      else renderAction();
      const chips = root.querySelector('.inst__top .inst__chips');
      if (chips) { chips.innerHTML = topChips(inst); hydrateIcons(chips); }
    }
  });
  const offProg = on(`progress:${id}`, (p) => paintProgress(root, inst, p));

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'install') {
      burst(b);
      try { await call('instances:install', id); } catch (err) { toastError(err); }
    } else if (act === 'play') {
      burst(b);
      try {
        await busy(b, () => call('instances:play', id), 'Iniciando…');
      } catch (err) {
        if (err.code === 'EEXPIRED') {
          const ok = await confirm({ title: 'Sesión caducada', text: 'Tu sesión de Microsoft caducó. Vuelve a iniciar sesión para jugar.', ok: 'Iniciar sesión', icon: 'user' });
          if (ok) app.addAccount();
        } else toastError(err);
      }
    } else if (act === 'cancel') {
      const ok = await confirm({ title: '¿Cancelar la descarga?', text: 'Lo que ya se descargó se guarda: la próxima vez continuará donde se quedó.', ok: 'Cancelar descarga', cancel: 'Seguir', icon: 'pause' });
      if (ok) call('instances:cancel', id);
    } else if (act === 'stop') {
      const ok = await confirm({ title: '¿Cerrar el juego?', text: 'Se perderá lo que no se haya guardado. Mejor sal desde el menú del juego si puedes.', ok: 'Cerrar juego', danger: true, icon: 'stop' });
      if (ok) call('instances:stop', id);
    } else if (act === 'folder') {
      call('app:openFolder', 'instance', id).catch(toastError);
    } else if (act === 'edit') {
      app.go({ name: 'admin', id: inst.baseId || id, tab: 'content' });
    } else if (act === 'more') {
      openMenu(b, inst, app);
    }
  });

  renderAll();
  return () => { offInst(); offProg(); };
}

function openMenu(anchor, inst, app) {
  const items = [];
  if (inst.installed) {
    if (folderAllowed(inst)) items.push({ label: 'Abrir carpeta de la instancia', icon: 'folder', onClick: () => call('app:openFolder', 'instance', inst.id).catch(toastError) });
    else if (inst.test && adminOn()) items.push({ label: 'Abrir carpeta (solo administradores)', icon: 'folder', onClick: () => call('app:openFolder', 'instance', inst.id).catch(toastError) });
    items.push({ label: 'Carpeta de mundos', icon: 'world', onClick: () => call('app:openFolder', 'instance-sub', { id: inst.id, sub: 'saves' }).catch(toastError) });
    items.push({ label: 'Capturas de pantalla', icon: 'image', onClick: () => call('app:openFolder', 'instance-sub', { id: inst.id, sub: 'screenshots' }).catch(toastError) });
    items.push('-');
    items.push({ label: 'Opciones de la instancia', icon: 'gear', onClick: () => optionsModal(inst) });
    if (inst.status === 'running') items.push({ label: 'Ver registro del juego', icon: 'terminal', onClick: () => logModal(inst) });
    if (inst.available && !inst.workspace && inst.status !== 'running' && inst.status !== 'installing') {
      items.push({ label: 'Reparar (verificar archivos)', icon: 'wrench', onClick: () => call('instances:repair', inst.id).catch(toastError) });
    }
    items.push('-');
    items.push({ label: 'Desinstalar', icon: 'trash', danger: true, disabled: inst.status === 'running', onClick: () => uninstall(inst, app) });
  } else {
    items.push({ label: 'Ir al inicio', icon: 'home', onClick: () => app.go({ name: 'home' }) });
  }
  menu(anchor, items);
}

async function uninstall(inst, app) {
  const r = await confirm({
    title: `¿Desinstalar ${inst.name}${inst.test ? ' (copia de prueba)' : ''}?`,
    text: inst.workspace
      ? 'Es tu carpeta sincronizada: se borrará de este PC con todo lo que no hayas publicado. Lo publicado sigue en el servidor.'
      : 'Se borrarán sus archivos de este PC. Podrás volver a descargarla cuando quieras.',
    danger: true, ok: 'Desinstalar', icon: 'trash',
    extra: '<label class="check"><input type="checkbox" name="keepSaves" checked> Guardar una copia de mis mundos</label>',
  });
  if (!r || !r.value) return;
  try {
    await call('instances:uninstall', inst.id, { keepSaves: Boolean(r.inputs.keepSaves) });
    toast(r.inputs.keepSaves ? 'Instancia desinstalada. Tus mundos se guardaron en la carpeta "backups".' : 'Instancia desinstalada.', { kind: 'success' });
    await app.refreshInstances(true);
  } catch (e) { toastError(e); }
}

function optionsModal(inst) {
  const s = state.settings;
  const o = inst.options || {};
  const useMem = Boolean(o.memory);
  const mem = o.memory || s.memory;
  const res = o.resolution || s.resolution;
  const m = modal({
    size: 'lg',
    html: `
      <div class="modal__body">
        <h2 class="modal__title">Opciones de <span class="grad-text">${esc(inst.name)}</span></h2>
        <p class="modal__text">Solo afectan a esta instancia. Si no las activas, se usan los ajustes generales.</p>
        <div class="settings__section" style="margin-top:20px">
          <label class="switch"><input type="checkbox" id="o-mem" ${useMem ? 'checked' : ''}> Memoria propia para esta instancia</label>
          <div class="settings__grid" id="o-mem-box">
            <div class="field"><span class="field__label">Memoria mínima (MB)</span><input class="input mono" id="o-min" type="number" min="256" step="256" value="${mem.min}"></div>
            <div class="field"><span class="field__label">Memoria máxima (MB)</span><input class="input mono" id="o-max" type="number" min="512" step="256" value="${mem.max}"></div>
          </div>
          ${inst.memory?.recommended ? `<p class="field__hint">Recomendado por Viciont Studios: <b>${inst.memory.recommended} MB</b>.</p>` : ''}
        </div>
        <div class="settings__section">
          <label class="switch"><input type="checkbox" id="o-jvm" ${o.jvmArgs != null ? 'checked' : ''}> Argumentos de Java propios</label>
          <textarea class="input mono textarea" id="o-jvm-args" rows="3">${esc(o.jvmArgs ?? s.jvmArgs)}</textarea>
        </div>
        <div class="settings__section">
          <label class="switch"><input type="checkbox" id="o-res" ${o.resolution ? 'checked' : ''}> Resolución propia</label>
          <div class="settings__grid">
            <div class="field"><span class="field__label">Ancho</span><input class="input mono" id="o-w" type="number" value="${res.width}"></div>
            <div class="field"><span class="field__label">Alto</span><input class="input mono" id="o-h" type="number" value="${res.height}"></div>
          </div>
          <label class="check"><input type="checkbox" id="o-fs" ${res.fullscreen ? 'checked' : ''}> Pantalla completa</label>
        </div>
        ${inst.server ? `<div class="settings__section"><label class="switch"><input type="checkbox" id="o-join" ${o.autoJoin === false ? '' : 'checked'}> Entrar directamente al servidor ${esc(inst.server)} al jugar</label></div>` : ''}
        <div class="modal__actions">
          <button class="btn btn--ghost" type="button" data-close>Cancelar</button>
          <button class="btn btn--primary" type="button" data-save>${icon('check')}Guardar</button>
        </div>
      </div>`,
  });
  const c = m.content;
  c.querySelector('[data-close]').addEventListener('click', () => m.close());
  c.querySelector('[data-save]').addEventListener('click', async (e) => {
    const patch = {
      memory: c.querySelector('#o-mem').checked ? { min: Number(c.querySelector('#o-min').value), max: Number(c.querySelector('#o-max').value) } : null,
      jvmArgs: c.querySelector('#o-jvm').checked ? c.querySelector('#o-jvm-args').value : null,
      resolution: c.querySelector('#o-res').checked ? { width: Number(c.querySelector('#o-w').value), height: Number(c.querySelector('#o-h').value), fullscreen: c.querySelector('#o-fs').checked } : null,
    };
    if (patch.memory && patch.memory.min > patch.memory.max) { toast('La memoria mínima no puede ser mayor que la máxima.', { kind: 'error' }); return; }
    const join = c.querySelector('#o-join');
    if (join) patch.autoJoin = join.checked ? null : false;
    try {
      await busy(e.currentTarget, () => call('instances:setOptions', inst.id, patch));
      toast('Opciones guardadas.', { kind: 'success' });
      m.close();
    } catch (err) { toastError(err); }
  });
}

async function logModal(inst) {
  const lines = await call('instances:log', inst.id).catch(() => []);
  const m = modal({
    size: 'xl',
    html: `<div class="modal__body"><h2 class="modal__title">Registro del juego</h2>
      <pre class="code-box selectable" style="margin-top:16px;max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:0.76rem;letter-spacing:0">${esc(lines.join('\n') || 'Sin mensajes todavía.')}</pre>
      <div class="modal__actions"><button class="btn btn--ghost" data-folder type="button">${icon('folder')}Abrir carpeta de registros</button><button class="btn btn--primary" data-close type="button">Cerrar</button></div></div>`,
  });
  m.content.querySelector('[data-close]').addEventListener('click', () => m.close());
  m.content.querySelector('[data-folder]').addEventListener('click', () => call('app:openFolder', 'instance-sub', { id: inst.id, sub: 'logs' }).catch(toastError));
}

export function crashModal(data) {
  const inst = instance(data.id);
  const c = data.crash || {};
  const tabs = [
    c.report && { key: 'report', label: 'Crash report', ...c.report },
    c.jvm && { key: 'jvm', label: 'Error de Java', ...c.jvm },
    c.log && { key: 'log', label: 'Registro del juego', ...c.log },
  ].filter(Boolean);
  if (!tabs.length) tabs.push({ key: 'log', label: 'Registro del juego', name: '', text: (data.log || []).join('\n') || 'Sin registro' });
  const cause = /^Description:\s*(.+)$/m.exec(c.report?.text || '')?.[1]?.trim() || '';
  const exc = c.report ? (/^\s*((?:[\w$]+\.)+[\w$]*(?:Exception|Error)\b[^\n]*)/m.exec(c.report.text.split(/\n\n/).slice(1, 3).join('\n'))?.[1] || '') : '';
  const all = tabs.map((t) => `===== ${t.name || t.label} =====\n${t.text}`).join('\n\n');
  const header = `${inst?.name || data.id} · código ${data.code} · ${new Date().toLocaleString('es-ES')}`;
  let cur = tabs[0].key;
  const m = modal({
    size: 'xl',
    html: `<div class="modal__body">
      <h2 class="modal__title">El juego se cerró con un error</h2>
      <p class="modal__text">${esc(inst?.name || data.id)} terminó con el código ${esc(data.code)}.${c.report ? ' Minecraft guardó un crash report con todos los detalles:' : ' Este es el registro completo del juego:'}</p>
      ${cause || exc ? `<div class="crash__cause">${icon('alert')}<div>${cause ? `<b>${esc(cause)}</b>` : ''}${exc ? `<small class="mono">${esc(exc.slice(0, 300))}</small>` : ''}</div></div>` : ''}
      ${tabs.length > 1 ? `<div class="segmented crash__tabs">${tabs.map((t) => `<button type="button" data-tab="${t.key}" class="${t.key === cur ? 'is-active' : ''}">${esc(t.label)}</button>`).join('')}</div>` : ''}
      <div class="crash__file mono" data-file></div>
      <pre class="code-box selectable crash__text" data-text></pre>
      <p class="field__hint" style="margin-top:10px">Si pasa a menudo, prueba "Reparar" en el menú ⋯ de la instancia o dale más memoria en sus opciones. Para pedir ayuda, usa <b>Copiar todo</b> o <b>Guardar</b> y envíalo al equipo de Viciont Studios (también les llega una copia).</p>
      <div class="modal__actions">
        <button class="btn btn--ghost" data-crash type="button">${icon('folder')}Informes de error</button>
        <button class="btn btn--ghost" data-save type="button">${icon('download')}Guardar</button>
        <button class="btn btn--ghost" data-copy type="button">${icon('copy')}Copiar todo</button>
        <button class="btn btn--primary" data-close type="button">Entendido</button>
      </div></div>`,
  });
  const show = (key) => {
    cur = key;
    const t = tabs.find((x) => x.key === key) || tabs[0];
    m.content.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === key));
    m.content.querySelector('[data-file]').textContent = `${t.name || ''}${t.truncated ? ' · muy largo: se muestran el principio y el final (el archivo está completo en la carpeta)' : ''}`;
    const pre = m.content.querySelector('[data-text]');
    pre.textContent = t.text || 'Sin contenido';
    pre.scrollTop = key === 'log' ? pre.scrollHeight : 0;
  };
  show(cur);
  m.content.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  m.content.querySelector('[data-close]').addEventListener('click', () => m.close());
  m.content.querySelector('[data-copy]').addEventListener('click', () => call('app:copy', `${header}\n\n${all}`).then(() => toast('Informe completo copiado.', { kind: 'success' })).catch(toastError));
  m.content.querySelector('[data-save]').addEventListener('click', async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    try {
      const file = await call('app:saveText', `crash-${inst?.baseId || data.id}-${stamp}.txt`.replace(/~/g, '-'), `${header}\n\n${all}`);
      if (file) toast('Informe guardado.', { kind: 'success' });
    } catch (e) { toastError(e); }
  });
  m.content.querySelector('[data-crash]').addEventListener('click', () => call('app:openFolder', 'instance-sub', { id: data.id, sub: 'crash-reports' }).catch(toastError));
}
