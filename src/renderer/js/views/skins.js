// Skins (como en Modrinth): vista 3D, biblioteca de skins, aplicar y capas.

import { call, state } from '../api.js';
import { icon, hydrateIcons } from '../icons.js';
import { esc } from '../util.js';
import { toast, toastError, confirm, modal, busy } from '../ui.js';
import { loadImage, drawBody, drawCape, isSlim } from '../skinart.js';
import { isIdle, onIdleChange, reducedMotion } from '../fx.js';

const VIEW_W = 280;
const VIEW_H = 360;
let libPromise = null;
function loadViewerLib() {
  if (window.skinview3d) return Promise.resolve(window.skinview3d);
  libPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/skinview3d.bundle.js';
    s.onload = () => resolve(window.skinview3d);
    s.onerror = () => reject(new Error('No se pudo cargar el visor 3D'));
    document.head.appendChild(s);
  });
  return libPromise;
}

export function render(root, _route, app) {
  app.scene.clear();
  app.bg.setMode('dim');
  let data = null;
  let selected = null; // id de la biblioteca o 'current'
  let viewer = null;
  let anim = 'idle';
  let disposed = false;

  root.innerHTML = `
    <section class="skins">
      <div class="skins__stage" id="stage">
        <div class="skins__name"><h2 id="sk-name">Skins</h2><span id="sk-badge"></span></div>
        <canvas id="sk3d"></canvas>
        <div class="skins__floor"></div>
        <div class="skins__tools">
          <button class="btn btn--sm" type="button" data-anim="idle">${icon('user')}Quieto</button>
          <button class="btn btn--sm" type="button" data-anim="walk">${icon('arrowRight')}Andar</button>
          <button class="btn btn--sm" type="button" data-anim="wave">${icon('sparkle')}Saludar</button>
          <button class="btn btn--sm btn--icon" type="button" data-anim="rotate" data-tip="Girar solo">${icon('refresh')}</button>
        </div>
      </div>
      <div class="skins__panel">
        <div class="page__head" style="margin:0">
          <div><h1 class="title-lg">Tus <span class="hl">skins</span></h1><p class="lead" id="sk-lead"></p></div>
        </div>
        <div class="panel" id="sk-current"></div>
        <div class="panel">
          <div class="panel__title"><span>Biblioteca</span><span class="field__row">
            <button class="btn btn--sm btn--ghost" type="button" data-act="from-nick">${icon('search')}Copiar de un nick</button>
          </span></div>
          <div class="skin-grid" id="sk-grid"></div>
        </div>
        <div class="panel" id="sk-capes" hidden></div>
        <div class="field__row" style="justify-content:flex-end">
          <button class="btn btn--ghost" type="button" data-act="reset">${icon('refresh')}Quitar mi skin</button>
          <button class="btn btn--primary" type="button" data-act="apply" id="sk-apply" disabled>${icon('check')}Aplicar skin</button>
        </div>
      </div>
    </section>`;
  hydrateIcons(root);

  const canvas = root.querySelector('#sk3d');
  const stage = root.querySelector('#stage');

  const setupViewer = async () => {
    try {
      const lib = await loadViewerLib();
      if (disposed) return;
      // Tamaño fijo (como en Modrinth): el visor nunca depende del tamaño de la
      // ventana, así no puede entrar en un bucle de "crecer hasta abajo".
      viewer = new lib.SkinViewer({ canvas, width: VIEW_W, height: VIEW_H, pixelRatio: Math.min(2, window.devicePixelRatio || 1) });
      viewer.fov = 50;
      viewer.zoom = 0.86;
      viewer.autoRotate = !reducedMotion();
      viewer.autoRotateSpeed = 0.55;
      viewer.controls.enableZoom = false;
      setAnim('idle');
      showSelected();
      viewer.renderPaused = isIdle();
    } catch (e) {
      stage.querySelector('.skins__floor').insertAdjacentHTML('afterend', `<p class="field__hint" style="padding:20px">${esc(e.message)}</p>`);
    }
  };

  const setAnim = (name) => {
    if (!viewer) return;
    const lib = window.skinview3d;
    if (name === 'rotate') { viewer.autoRotate = !viewer.autoRotate; return; }
    anim = name;
    viewer.animation = name === 'walk' ? new lib.WalkingAnimation() : name === 'wave' ? new lib.WaveAnimation() : new lib.IdleAnimation();
    if (name === 'walk') viewer.animation.speed = 0.7;
    root.querySelectorAll('[data-anim]').forEach((b) => b.classList.toggle('btn--primary', b.dataset.anim === anim));
  };

  const current = () => (selected === 'current' ? data?.current : data?.items.find((x) => x.id === selected));

  const showSelected = async () => {
    if (!viewer) return;
    const s = current() || { image: 'img/default-skin.png', model: 'classic' };
    try {
      await viewer.loadSkin(s.image, { model: s.model === 'slim' ? 'slim' : 'default' });
      const cape = data?.capes?.find((c) => c.active);
      if (cape) await viewer.loadCape(cape.image); else viewer.loadCape(null);
    } catch { /* imagen dañada */ }
  };

  const draw = () => {
    const acc = data?.account;
    const premium = acc?.type === 'microsoft';
    root.querySelector('#sk-name').textContent = acc?.name || 'Skins';
    root.querySelector('#sk-badge').innerHTML = acc ? `<span class="chip ${premium ? 'chip--hot' : ''}">${icon(premium ? 'microsoft' : 'user')}${premium ? 'Premium' : 'No premium'}</span>` : '';
    root.querySelector('#sk-lead').textContent = premium
      ? 'Tu skin se cambia en tu cuenta de Minecraft: la verá todo el mundo, en cualquier servidor.'
      : data?.serverReady
        ? 'Tu skin se guarda en el servidor del estudio. La verán quienes jueguen con Viciont Studio Launcher (en instancias con mods).'
        : 'El servidor de skins del estudio todavía no está listo. Puedes preparar tu biblioteca mientras tanto.';
    const cur = root.querySelector('#sk-current');
    cur.innerHTML = data?.current
      ? `<div class="panel__title"><span>Skin actual</span></div>
         <div class="field__row"><button class="skin-card ${selected === 'current' ? 'is-selected' : ''}" type="button" data-pick="current" style="width:130px"><canvas></canvas><span class="skin-card__name">En uso</span></button>
         <p class="field__hint">Esta es la skin que tienes puesta ahora mismo. Elige otra de tu biblioteca y pulsa <b>Aplicar skin</b>.</p></div>`
      : `<div class="panel__title"><span>Skin actual</span></div><p class="field__hint">Todavía no tienes skin: se usa la de por defecto. Añade una a tu biblioteca y aplícala.</p>`;
    if (data?.current) paintBody(cur.querySelector('canvas'), data.current.image, data.current.model === 'slim');

    const grid = root.querySelector('#sk-grid');
    grid.innerHTML = `
      <button class="skin-card skin-card--add" type="button" data-act="add">${icon('plus')}<span class="skin-card__name">Añadir skin</span><small class="muted">PNG 64×64</small></button>
      ${(data?.items || []).map((s) => `
        <div class="skin-card ${selected === s.id ? 'is-selected' : ''}" role="button" tabindex="0" data-pick="${esc(s.id)}">
          ${data.current?.hash === s.hash ? '<span class="skin-card__badge"><span class="chip chip--hot">En uso</span></span>' : ''}
          <button class="skin-card__del" type="button" data-del="${esc(s.id)}" data-tip="Quitar de la biblioteca">${icon('close')}</button>
          <canvas></canvas>
          <span class="skin-card__name">${esc(s.name)}</span>
          <small class="muted">${s.model === 'slim' ? 'Delgado' : 'Clásico'}</small>
        </div>`).join('')}`;
    (data?.items || []).forEach((s) => {
      const c = grid.querySelector(`[data-pick="${CSS.escape(s.id)}"] canvas`);
      if (c) paintBody(c, s.image, s.model === 'slim');
    });

    const capes = root.querySelector('#sk-capes');
    capes.hidden = !premium || !data.capes.length;
    if (!capes.hidden) {
      capes.innerHTML = `<div class="panel__title"><span>Capas</span></div>
        <div class="capes">
          <button class="cape ${data.capes.some((c) => c.active) ? '' : 'is-selected'}" type="button" data-cape="">${icon('close')}<span>Sin capa</span></button>
          ${data.capes.map((c) => `<button class="cape ${c.active ? 'is-selected' : ''}" type="button" data-cape="${esc(c.id)}"><canvas></canvas><span>${esc(c.alias || 'Capa')}</span></button>`).join('')}
        </div>`;
      data.capes.forEach((c) => {
        const el = capes.querySelector(`[data-cape="${CSS.escape(c.id)}"] canvas`);
        if (el) loadImage(c.image).then((img) => drawCape(el, img)).catch(() => {});
      });
    }
    const apply = root.querySelector('#sk-apply');
    const s = current();
    apply.disabled = !s || selected === 'current' || s.hash === data.current?.hash;
    hydrateIcons(root);
  };

  const refresh = async () => {
    try {
      data = await call('skins:state');
    } catch (e) {
      toastError(e);
      data = { account: state.accounts.active, items: [], capes: [], current: null };
    }
    if (!selected || (selected !== 'current' && !data.items.find((x) => x.id === selected))) selected = data.current ? 'current' : data.items[0]?.id || null;
    draw();
    showSelected();
  };

  // añadir desde archivo (selector o arrastrar y soltar)
  const addFile = async (file) => {
    if (!file) return;
    if (!/png$/i.test(file.type) && !/\.png$/i.test(file.name)) { toast('La skin tiene que ser una imagen PNG.', { kind: 'error' }); return; }
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const slim = isSlim(img);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = file.name.replace(/\.png$/i, '').slice(0, 40);
      const m = await askNameModel(name, slim);
      if (!m) return;
      data = await call('skins:add', { bytes, name: m.name, model: m.model });
      const added = data.items[0];
      selected = added?.id || selected;
      draw();
      showSelected();
      toast('Skin añadida a tu biblioteca.', { kind: 'success' });
    } catch (e) { toastError(e); } finally { URL.revokeObjectURL(url); }
  };

  const pickFile = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png';
    inp.addEventListener('change', () => addFile(inp.files[0]));
    inp.click();
  };

  root.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const ok = await confirm({ title: '¿Quitar esta skin?', text: 'Se borrará de tu biblioteca (no cambia la skin que tienes puesta).', ok: 'Quitar', danger: true, icon: 'trash' });
      if (ok) { data = await call('skins:remove', del.dataset.del).catch((er) => { toastError(er); return data; }); draw(); }
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (pick) { selected = pick.dataset.pick; draw(); showSelected(); return; }
    const an = e.target.closest('[data-anim]');
    if (an) { setAnim(an.dataset.anim); return; }
    const cape = e.target.closest('[data-cape]');
    if (cape) {
      try {
        data = await busy(cape, () => call('skins:setCape', cape.dataset.cape || null));
        draw();
        showSelected();
        toast('Capa actualizada.', { kind: 'success' });
      } catch (er) { toastError(er); }
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'add') pickFile();
    if (b.dataset.act === 'from-nick') {
      const m = modal({
        size: 'sm',
        html: `<div class="modal__body"><h2 class="modal__title">Copiar skin de un nick</h2>
          <p class="modal__text">Escribe el nick de cualquier jugador premium y se añadirá su skin a tu biblioteca.</p>
          <form id="nf" style="display:grid;gap:12px;margin-top:16px"><input class="input" name="n" maxlength="16" placeholder="Nick premium" autofocus>
          <div class="modal__actions" style="margin-top:6px"><button class="btn btn--primary" type="submit">${icon('download')}Copiar skin</button></div></form></div>`,
      });
      m.content.querySelector('#nf').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const btn = ev.submitter;
        try {
          data = await busy(btn, () => call('skins:addFromName', ev.target.n.value.trim()));
          selected = data.items[0]?.id || selected;
          m.close();
          draw();
          showSelected();
          toast('Skin copiada a tu biblioteca.', { kind: 'success' });
        } catch (er) { toastError(er); }
      });
    }
    if (b.dataset.act === 'apply') {
      const s = current();
      if (!s) return;
      try {
        data = await busy(b, () => call('skins:apply', s.id), 'Aplicando…');
        selected = 'current';
        draw();
        showSelected();
        app.refreshAvatar();
        toast(data.account?.type === 'microsoft' ? '¡Skin cambiada en tu cuenta de Minecraft!' : '¡Skin guardada! Se verá en las instancias con mods de este launcher.', { kind: 'success' });
      } catch (er) { toastError(er); }
    }
    if (b.dataset.act === 'reset') {
      const ok = await confirm({ title: '¿Quitar tu skin?', text: 'Volverás a tener la skin por defecto.', ok: 'Quitar skin', danger: true, icon: 'refresh' });
      if (!ok) return;
      try { data = await call('skins:reset'); selected = null; draw(); app.refreshAvatar(); } catch (er) { toastError(er); }
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-pick]')) e.target.click();
  });

  // arrastrar y soltar un PNG
  stage.parentElement.addEventListener('dragover', (e) => { e.preventDefault(); root.querySelector('.skins').classList.add('drop-hint'); });
  stage.parentElement.addEventListener('dragleave', () => root.querySelector('.skins').classList.remove('drop-hint'));
  stage.parentElement.addEventListener('drop', (e) => {
    e.preventDefault();
    root.querySelector('.skins').classList.remove('drop-hint');
    addFile(e.dataTransfer.files[0]);
  });

  const offIdle = onIdleChange((v) => { if (viewer) viewer.renderPaused = v; });
  setupViewer();
  refresh();

  return () => {
    disposed = true;
    offIdle();
    if (viewer) {
      // libera también la memoria de gráficos del visor 3D (si no, se queda reservada)
      let gl = null;
      try { gl = viewer.renderer.getContext(); } catch { gl = null; }
      viewer.dispose();
      try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ya liberado */ }
      viewer = null;
    }
  };
}

async function paintBody(canvas, src, slim) {
  try { drawBody(canvas, await loadImage(src), slim, 4); } catch { /* sin imagen */ }
}

function askNameModel(name, slim) {
  return new Promise((resolve) => {
    let model = slim ? 'slim' : 'classic';
    const m = modal({
      size: 'sm',
      onClose: (r) => resolve(r || null),
      html: `<div class="modal__body"><h2 class="modal__title">Nueva skin</h2>
        <form id="sf" style="display:grid;gap:14px;margin-top:16px">
          <label class="field"><span class="field__label">Nombre</span><input class="input" name="n" value="${esc(name)}" maxlength="40" autofocus></label>
          <div class="field"><span class="field__label">Modelo de brazos</span>
            <div class="segmented"><button type="button" data-m="classic" class="${model === 'classic' ? 'is-active' : ''}">Clásico (4 px)</button><button type="button" data-m="slim" class="${model === 'slim' ? 'is-active' : ''}">Delgado (3 px)</button></div>
            <span class="field__hint">Lo detectamos automáticamente; cámbialo si no es correcto.</span>
          </div>
          <div class="modal__actions"><button class="btn btn--primary" type="submit">${icon('plus')}Añadir</button></div>
        </form></div>`,
    });
    m.content.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => {
      model = b.dataset.m;
      m.content.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('is-active', x === b));
    }));
    m.content.querySelector('#sf').addEventListener('submit', (e) => {
      e.preventDefault();
      m.close({ name: e.target.n.value.trim() || 'Mi skin', model });
    });
  });
}
