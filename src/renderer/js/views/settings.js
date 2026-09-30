import { call, state, emit, on } from '../api.js';
import { icon, hydrateIcons } from '../icons.js';
import { esc, bytes } from '../util.js';
import { modal, toast, toastError, confirm, busy } from '../ui.js';
import { setEffects } from '../fx.js';

const KEYRING = { darwin: 'el llavero de macOS', linux: 'el llavero del sistema' };
const keyring = () => KEYRING[state.info?.platform] || 'Windows';
const UNINSTALL = {
  win32: 'Desinstala el launcher desde <b>Configuración de Windows → Aplicaciones</b>. El desinstalador te preguntará si quieres <b>conservar tus instancias y mundos</b> (para reinstalar más tarde) o <b>borrarlo todo</b>.',
  darwin: 'Arrastra <b>Viciont Studios Launcher</b> desde <b>Aplicaciones</b> a la Papelera. Tus instancias, mundos y cuentas se quedan en la carpeta de datos de arriba: bórrala también si quieres eliminarlo todo.',
  linux: 'Si usas la <b>AppImage</b>, borra el archivo. Si instalaste el paquete <b>.deb</b> o <b>.rpm</b>, quítalo desde tu tienda de aplicaciones o con <code>sudo apt remove viciont-studios-launcher</code> (o <code>sudo dnf remove viciont-studios-launcher</code>). Tus instancias y mundos se quedan en la carpeta de datos de arriba y tus cuentas en <code>~/.config/ViciontStudioLauncher</code>: bórralas también si quieres eliminarlo todo.',
};

const TABS = [
  ['game', 'Juego', 'cpu'],
  ['launcher', 'Launcher', 'zap'],
  ['storage', 'Almacenamiento', 'hdd'],
  ['account', 'Cuenta', 'user'],
  ['admin', 'Administración', 'shield'],
  ['about', 'Acerca de', 'info'],
];

export function openSettings(app, tab = 'game') {
  const tabs = TABS;
  if (tab === 'admin' && !state.admin?.access) tab = 'game';
  const m = modal({
    size: 'full',
    html: `
      <div class="settings">
        <nav class="settings__nav">
          <h2>Ajustes</h2>
          ${tabs.map(([k, label, ic]) => `<button class="settings__tab" type="button" data-tab="${k}" ${k === 'admin' && !state.admin?.access ? 'hidden' : ''}>${icon(ic)}${label}</button>`).join('')}
        </nav>
        <div class="settings__pane" id="set-pane"></div>
      </div>`,
  });
  const pane = m.content.querySelector('#set-pane');
  m.content.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0';
  const show = (k) => {
    m.content.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === k));
    pane.scrollTop = 0;
    PANES[k](pane, app, m);
    hydrateIcons(pane);
  };
  m.content.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  show(tab);
  app.refreshAdmin?.({ fresh: true }).then((st) => {
    const b = m.content.querySelector('[data-tab="admin"]');
    if (b) b.hidden = !st?.access;
  }).catch(() => {});
  return m;
}

async function save(patch, quiet = false) {
  try {
    state.settings = await call('settings:set', patch);
    emit('settings', state.settings);
    if (!quiet) toast('Ajustes guardados.', { kind: 'success', timeout: 1800 });
    return state.settings;
  } catch (e) { toastError(e); return null; }
}

const PANES = {
  game(pane) {
    const s = state.settings;
    const info = state.info;
    const total = info.totalMB;
    pane.innerHTML = `
      <div class="settings__section">
        <h3>Memoria (RAM)</h3>
        <p class="field__hint">Tu PC tiene <b>${(total / 1024).toFixed(1)} GB</b>. Recomendado para modpacks: entre 4 y 8 GB, dejando al menos 2 GB libres para el sistema.</p>
        <div class="settings__grid">
          <div class="field"><span class="field__label">Memoria mínima <em>*</em></span>
            <div class="stepper"><button type="button" data-step="min:-512">−</button><input id="mem-min" inputmode="numeric" value="${s.memory.min}"><span class="stepper__unit">MB</span><button type="button" data-step="min:512">+</button></div></div>
          <div class="field"><span class="field__label">Memoria máxima <em>*</em></span>
            <div class="stepper"><button type="button" data-step="max:-512">−</button><input id="mem-max" inputmode="numeric" value="${s.memory.max}"><span class="stepper__unit">MB</span><button type="button" data-step="max:512">+</button></div></div>
        </div>
        <input class="range" type="range" id="mem-range" min="1024" max="${Math.max(2048, total - 1024)}" step="512" value="${s.memory.max}">
        <div class="mem-bar"><span id="mem-bar-max"></span></div>
        <p class="field__hint" id="mem-note"></p>
      </div>
      <div class="settings__section">
        <h3>Argumentos de Java</h3>
        <textarea class="input mono textarea" id="jvm" rows="3" spellcheck="false">${esc(s.jvmArgs)}</textarea>
        <div class="field__row"><button class="btn btn--sm btn--ghost" type="button" id="jvm-reset">${icon('refresh')}Restablecer recomendados</button><span class="field__hint">Solo cámbialos si sabes lo que haces.</span></div>
      </div>
      <div class="settings__section">
        <h3>Ventana del juego</h3>
        <div class="settings__grid">
          <div class="field"><span class="field__label">Ancho</span><input class="input mono" id="res-w" type="number" min="320" value="${s.resolution.width}"></div>
          <div class="field"><span class="field__label">Alto</span><input class="input mono" id="res-h" type="number" min="240" value="${s.resolution.height}"></div>
        </div>
        <label class="switch"><input type="checkbox" id="res-fs" ${s.resolution.fullscreen ? 'checked' : ''}> Abrir en pantalla completa</label>
      </div>
      <div class="settings__section">
        <h3>Java</h3>
        <p class="field__hint">El launcher descarga automáticamente el Java oficial que necesita cada versión de Minecraft (8, 17, 21 o 25). Solo elige uno propio si tienes un motivo.</p>
        <div id="java-list" style="display:grid;gap:10px"></div>
      </div>`;
    const min = pane.querySelector('#mem-min');
    const max = pane.querySelector('#mem-max');
    const range = pane.querySelector('#mem-range');
    const paint = () => {
      const mx = Number(max.value) || 0;
      const pct = Math.min(100, (mx / total) * 100);
      pane.querySelector('#mem-bar-max').style.width = `${pct}%`;
      range.value = mx;
      range.style.setProperty('--p', `${((mx - range.min) / (range.max - range.min)) * 100}%`);
      const note = pane.querySelector('#mem-note');
      note.textContent = mx > total - 1536 ? '⚠ Estás dejando muy poca memoria para el sistema: el equipo podría ir lento.' : `Minecraft podrá usar hasta ${(mx / 1024).toFixed(1)} GB.`;
    };
    const commit = () => {
      let a = Math.round(Number(min.value) || 1024);
      let b = Math.round(Number(max.value) || 2048);
      if (a > b) a = b;
      min.value = a;
      max.value = b;
      paint();
      save({ memory: { min: a, max: b } }, true);
    };
    pane.querySelectorAll('[data-step]').forEach((btn) => btn.addEventListener('click', () => {
      const [k, d] = btn.dataset.step.split(':');
      const el = k === 'min' ? min : max;
      el.value = Math.max(512, (Number(el.value) || 0) + Number(d));
      commit();
    }));
    [min, max].forEach((el) => el.addEventListener('change', commit));
    range.addEventListener('input', () => { max.value = range.value; paint(); });
    range.addEventListener('change', commit);
    paint();
    pane.querySelector('#jvm').addEventListener('change', (e) => save({ jvmArgs: e.target.value }));
    pane.querySelector('#jvm-reset').addEventListener('click', async () => {
      pane.querySelector('#jvm').value = state.info.defaultJvm;
      await save({ jvmArgs: state.info.defaultJvm });
    });
    const res = () => save({ resolution: { width: Number(pane.querySelector('#res-w').value), height: Number(pane.querySelector('#res-h').value), fullscreen: pane.querySelector('#res-fs').checked } });
    ['#res-w', '#res-h', '#res-fs'].forEach((sel) => pane.querySelector(sel).addEventListener('change', res));

    const javaList = pane.querySelector('#java-list');
    const drawJava = () => {
      const jp = state.settings.javaPaths || {};
      javaList.innerHTML = [8, 17, 21, 25].map((v) => `
        <div class="field__row" style="justify-content:space-between;padding:10px 12px;border:1px solid var(--line);border-radius:12px">
          <span><b>Java ${v}</b> <span class="muted mono" style="font-size:.78rem">${jp[v] ? esc(jp[v]) : 'Automático (recomendado)'}</span></span>
          <span class="field__row">
            <button class="btn btn--sm btn--ghost" type="button" data-java="${v}">${icon('folder')}Elegir</button>
            ${jp[v] ? `<button class="btn btn--sm btn--ghost" type="button" data-java-auto="${v}">Automático</button>` : ''}
          </span>
        </div>`).join('');
      hydrateIcons(javaList);
    };
    javaList.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-java]');
      const a = e.target.closest('[data-java-auto]');
      if (b) {
        try {
          const r = await call('settings:chooseJava');
          if (!r) return;
          if (r.major !== Number(b.dataset.java)) {
            const ok = await confirm({ title: 'Versión distinta', text: `Ese Java es la versión ${r.major}, no la ${b.dataset.java}. ¿Usarlo igualmente?`, ok: 'Usar', icon: 'alert' });
            if (!ok) return;
          }
          await save({ javaPaths: { ...(state.settings.javaPaths || {}), [b.dataset.java]: r.path } });
          drawJava();
        } catch (er) { toastError(er); }
      }
      if (a) {
        const jp = { ...(state.settings.javaPaths || {}) };
        delete jp[a.dataset.javaAuto];
        await save({ javaPaths: jp });
        drawJava();
      }
    });
    drawJava();
  },

  launcher(pane, app) {
    const s = state.settings;
    const opt = (k, v, title, sub) => `<button type="button" class="opt ${s[k] === v ? 'is-active' : ''}" data-k="${k}" data-v="${v}"><b>${title}</b><small>${sub}</small></button>`;
    pane.innerHTML = `
      <div class="settings__section">
        <h3>Al iniciar el juego</h3>
        <div class="opt-grid">
          ${opt('onLaunch', 'hide', 'Cerrar la ventana', 'Recomendado: el launcher casi no gasta memoria mientras juegas.')}
          ${opt('onLaunch', 'minimize', 'Minimizar', 'La ventana sigue abierta en la barra de tareas.')}
          ${opt('onLaunch', 'keep', 'Dejar abierto', 'No hacer nada.')}
        </div>
        <label class="switch"><input type="checkbox" id="reopen" ${s.reopenOnExit ? 'checked' : ''}> Volver a mostrar el launcher al cerrar el juego</label>
      </div>
      <div class="settings__section">
        <h3>Descargas</h3>
        <div class="field" style="max-width:320px"><span class="field__label">Descargas simultáneas</span>
          <div class="stepper"><button type="button" data-c="-1">−</button><input id="conc" inputmode="numeric" value="${s.concurrency}"><button type="button" data-c="1">+</button></div>
          <span class="field__hint">Más descargas a la vez = más rápido con buena conexión. Si tu internet es lento, baja a 4-6.</span></div>
      </div>
      <div class="settings__section">
        <h3>Efectos visuales</h3>
        <div class="opt-grid">
          ${opt('effects', 'full', 'Completos', 'Fondo animado, glitch y todas las animaciones.')}
          ${opt('effects', 'reduced', 'Reducidos', 'Menos animaciones y fondo más ligero.')}
          ${opt('effects', 'minimal', 'Mínimos', 'Sin fondo animado. Ideal para PCs modestos.')}
        </div>
        <label class="switch"><input type="checkbox" id="hwacc" ${s.hardwareAcceleration ? 'checked' : ''}> Aceleración por hardware (requiere reiniciar el launcher)</label>
      </div>
      <div class="settings__section">
        <h3>Discord</h3>
        <label class="switch"><input type="checkbox" id="discord" ${s.discordRpc ? 'checked' : ''}> Mostrar en Discord lo que haces en el launcher</label>
        <label class="switch"><input type="checkbox" id="discord-private" ${s.discordHidePrivate ? '' : 'checked'} ${s.discordRpc ? '' : 'disabled'}> Mostrar también el nombre de las instancias privadas</label>
        <p class="field__hint">En tu perfil de Discord saldrá <b>«Jugando a Viciont Studios Launcher»</b>, la instancia que estás viendo o descargando y a cuál estás jugando. Necesitas tener Discord abierto en este PC.${state.info?.discord?.available ? '' : ' <b>Viciont Studios todavía no lo ha activado.</b>'}</p>
      </div>
      <div class="settings__section">
        <h3>Actualizaciones del launcher</h3>
        <label class="switch"><input type="checkbox" id="autoupd" ${s.autoUpdate ? 'checked' : ''}> Buscar e instalar actualizaciones automáticamente</label>
        <p class="field__hint">${state.update?.manual ? 'Al abrir el launcher te avisa si hay una versión nueva para que la descargues desde la web.' : 'Al abrir el launcher, si hay una versión nueva, se descarga y se instala sola: se cierra un momento y se vuelve a abrir ya actualizado.'}</p>
        <div class="field__row"><button class="btn btn--sm" type="button" id="check-upd">${icon('refresh')}Buscar ahora</button><span class="field__hint" id="upd-state"></span></div>
      </div>`;
    pane.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', async () => {
      const r = await save({ [b.dataset.k]: b.dataset.v }, true);
      if (!r) return;
      pane.querySelectorAll(`[data-k="${b.dataset.k}"]`).forEach((x) => x.classList.toggle('is-active', x === b));
      if (b.dataset.k === 'effects') { setEffects(r.effects); app.bg.refresh(); }
    }));
    pane.querySelector('#reopen').addEventListener('change', (e) => save({ reopenOnExit: e.target.checked }, true));
    pane.querySelector('#discord').addEventListener('change', (e) => {
      save({ discordRpc: e.target.checked }, true);
      pane.querySelector('#discord-private').disabled = !e.target.checked;
    });
    pane.querySelector('#discord-private').addEventListener('change', (e) => save({ discordHidePrivate: !e.target.checked }, true));
    pane.querySelector('#hwacc').addEventListener('change', (e) => save({ hardwareAcceleration: e.target.checked }));
    pane.querySelector('#autoupd').addEventListener('change', (e) => save({ autoUpdate: e.target.checked }, true));
    const conc = pane.querySelector('#conc');
    const setConc = (v) => { conc.value = Math.max(1, Math.min(24, v)); save({ concurrency: Number(conc.value) }, true); };
    pane.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => setConc(Number(conc.value) + Number(b.dataset.c))));
    conc.addEventListener('change', () => setConc(Number(conc.value) || 10));
    const upd = pane.querySelector('#upd-state');
    const paintUpd = (u) => {
      const map = { checking: 'Buscando…', latest: 'Tienes la última versión.', downloading: `Descargando la versión ${u?.version || ''}… ${u?.percent || 0}%`, ready: `La versión ${u?.version} está lista: pulsa «Hay una versión disponible» arriba para actualizar, o se instalará sola al cerrar el launcher.`, available: `Hay una versión nueva (${u?.version}): pulsa «Hay una versión disponible» arriba para descargarla desde la web.`, error: `No se pudo comprobar (${u?.error || 'error'}).`, dev: 'Modo desarrollo: sin actualizaciones.', unavailable: 'Actualizaciones no disponibles en esta copia.' };
      upd.textContent = map[u?.status] || '';
    };
    paintUpd(state.update);
    const offUpd = on('update', (u) => { if (upd.isConnected) paintUpd(u); else offUpd(); });
    pane.querySelector('#check-upd').addEventListener('click', async (e) => {
      const u = await busy(e.currentTarget, () => call('app:checkUpdates'));
      paintUpd(u);
    });
  },

  async storage(pane, app) {
    const info = state.info;
    pane.innerHTML = `
      <div class="settings__section">
        <h3>Carpeta de datos</h3>
        <p class="field__hint">Aquí se guardan las instancias, librerías, recursos y Java (como en Modrinth: <code>meta</code> compartida + <code>instances</code>).</p>
        <div class="code-box" id="data-dir">${esc(info.dataDir)}</div>
        <div class="field__row">
          <button class="btn btn--sm" type="button" id="open-data">${icon('folder')}Abrir carpeta</button>
          <button class="btn btn--sm btn--primary" type="button" id="change-data">${icon('edit')}Cambiar carpeta</button>
          <button class="btn btn--sm btn--ghost" type="button" id="reset-data">${icon('refresh')}Usar la predeterminada</button>
        </div>
      </div>
      <div class="settings__section">
        <h3>Espacio usado</h3>
        <dl class="kv" id="sizes"><dt>Calculando…</dt><dd></dd></dl>
        <div class="field__row">
          <button class="btn btn--sm btn--ghost" type="button" id="clear-cache">${icon('trash')}Limpiar caché</button>
          <button class="btn btn--sm btn--ghost" type="button" id="open-logs">${icon('terminal')}Registros del launcher</button>
        </div>
        <p class="field__hint">Limpiar la caché no borra instancias ni mundos: solo archivos temporales e imágenes, que se vuelven a descargar si hace falta.</p>
      </div>
      <div class="settings__section">
        <h3>Desinstalar</h3>
        <p class="field__hint">${UNINSTALL[info.platform] || UNINSTALL.win32}</p>
      </div>`;
    const sizes = pane.querySelector('#sizes');
    call('settings:storage').then((s) => {
      sizes.innerHTML = `<dt>Minecraft, librerías y Java</dt><dd>${bytes(s.meta)}</dd><dt>Instancias (mods, mundos…)</dt><dd>${bytes(s.instances)}</dd><dt>Caché</dt><dd>${bytes(s.caches)}</dd>`;
    }).catch(() => { sizes.innerHTML = '<dt>No se pudo calcular</dt><dd></dd>'; });
    pane.querySelector('#open-data').addEventListener('click', () => call('app:openFolder', 'data').catch(toastError));
    pane.querySelector('#open-logs').addEventListener('click', () => call('app:openFolder', 'logs').catch(toastError));
    pane.querySelector('#clear-cache').addEventListener('click', async (e) => {
      try { await busy(e.currentTarget, () => call('settings:clearCache')); toast('Caché limpiada.', { kind: 'success' }); PANES.storage(pane, app); } catch (er) { toastError(er); }
    });
    const move = async (target) => {
      const r = await confirm({
        title: 'Cambiar carpeta de datos',
        text: `Nueva carpeta: ${target || 'la predeterminada'}. ¿Qué hacemos con lo que ya tienes descargado?`,
        icon: 'folder',
        buttons: [
          { label: 'Cancelar', value: null, kind: 'ghost' },
          { label: 'Empezar vacía', value: 'empty', kind: 'ghost' },
          { label: 'Mover mis datos', value: 'move', kind: 'primary' },
        ],
      });
      if (!r) return;
      const t = toast('Moviendo datos… no cierres el launcher.', { timeout: 0 });
      try {
        const out = await call('settings:moveDataDir', target, { move: r === 'move' });
        state.info.dataDir = out.dataDir;
        toast('Carpeta de datos cambiada.', { kind: 'success' });
        PANES.storage(pane, app);
        app.refreshInstances(true);
      } catch (er) { toastError(er); } finally { t(); }
    };
    pane.querySelector('#change-data').addEventListener('click', async () => {
      const target = await call('settings:chooseDataDir');
      if (target) move(target);
    });
    pane.querySelector('#reset-data').addEventListener('click', () => move(null));
  },

  account(pane, app, m) {
    const draw = () => {
      const { list, active } = state.accounts;
      pane.innerHTML = `
        <div class="settings__section">
          <h3>Tus cuentas</h3>
          <div style="display:grid;gap:10px">
            ${list.map((a) => `
              <div class="field__row" style="justify-content:space-between;padding:12px 14px;border:1px solid ${a.active ? 'rgba(236,72,153,.6)' : 'var(--line)'};border-radius:14px;background:${a.active ? 'var(--grad-soft)' : 'transparent'}">
                <span class="field__row">${icon(a.type === 'microsoft' ? 'microsoft' : 'user')}<b>${esc(a.name)}</b><span class="chip">${a.type === 'microsoft' ? 'Premium' : 'No premium'}</span>${a.active ? '<span class="chip chip--hot">En uso</span>' : ''}${a.needsLogin ? '<span class="chip chip--warn">Inicia sesión otra vez</span>' : ''}</span>
                <span class="field__row">
                  ${a.active ? '' : `<button class="btn btn--sm" type="button" data-use="${esc(a.uuid)}">Usar</button>`}
                  <button class="btn btn--sm btn--ghost" type="button" data-out="${esc(a.uuid)}">${icon('logout')}Cerrar sesión</button>
                </span>
              </div>`).join('')}
          </div>
          <button class="btn btn--sm btn--primary" type="button" id="add-acc" style="justify-self:start">${icon('plus')}Añadir otra cuenta</button>
        </div>
        <div class="settings__section">
          <h3>Servidor de Viciont Studios</h3>
          <div id="srv-status" class="field__hint"><span class="spin" style="width:12px;height:12px"></span> Comprobando la conexión de tu cuenta…</div>
          <div class="field__row"><button class="btn btn--sm btn--ghost" type="button" id="srv-retry">${icon('refresh')}Volver a comprobar</button></div>
        </div>
        ${active?.type === 'offline' ? `
        <div class="settings__section">
          <h3>Código de recuperación</h3>
          <p class="field__hint">Tu nick <b>${esc(active.name)}</b> queda reservado para ti en el launcher. Si juegas en otro PC, entra con tu nick y este código. <b>No se lo pases a nadie.</b></p>
          <div class="code-box" id="rec-code">••••••••••••••••••••</div>
          <div class="field__row"><button class="btn btn--sm" type="button" id="rec-show">${icon('eye')}Mostrar</button><button class="btn btn--sm btn--ghost" type="button" id="rec-copy">${icon('copy')}Copiar</button></div>
        </div>` : ''}
        ${active?.type === 'microsoft' ? `
        <div class="settings__section">
          <h3>Perfil</h3>
          <div class="field__row"><button class="btn btn--sm" type="button" id="namemc">${icon('external')}Ver en NameMC</button><button class="btn btn--sm btn--ghost" type="button" id="refresh-prof">${icon('refresh')}Actualizar perfil</button></div>
        </div>` : ''}`;
      hydrateIcons(pane);
      pane.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', async () => {
        try { await app.switchAccount(b.dataset.use); } catch (er) { toastError(er); return; }
        draw();
      }));
      pane.querySelectorAll('[data-out]').forEach((b) => b.addEventListener('click', async () => {
        const acc = list.find((a) => a.uuid === b.dataset.out);
        const ms = acc?.type === 'microsoft';
        const r = await confirm({
          title: '¿Cerrar sesión?', text: `Se quitará ${acc?.name} de este launcher.${acc?.type === 'offline' ? ' Su código de recuperación se queda guardado en este PC para que puedas volver a entrar con este nick.' : ''}`, ok: 'Cerrar sesión', danger: true, icon: 'logout',
          extra: ms
            ? '<label class="check"><input type="checkbox" name="forget"> Olvidar también esta cuenta de Microsoft en este PC (recomendado si el PC es compartido)</label>'
            : '<label class="check"><input type="checkbox" name="forget"> Olvidar también el código de este nick en este PC (recomendado si el PC es compartido)</label>',
        });
        if (!r?.value) return;
        state.accounts = await call('accounts:logout', b.dataset.out, ms ? { forgetMicrosoft: Boolean(r.inputs?.forget) } : { forgetRecovery: Boolean(r.inputs?.forget) });
        app.onAccountChange();
        if (!state.accounts.active) { m.close(); return; }
        draw();
      }));
      pane.querySelector('#add-acc').addEventListener('click', () => { m.close(); app.addAccount(); });
      const srv = async () => {
        const box = pane.querySelector('#srv-status');
        if (!box) return;
        box.innerHTML = '<span class="spin" style="width:12px;height:12px"></span> Comprobando la conexión de tu cuenta…';
        const st = await call('accounts:serverStatus').catch((e) => ({ ok: false, message: e.message }));
        if (!box.isConnected) return;
        box.innerHTML = st.ok
          ? `<span class="chip">${icon('check')}Conectada</span> Tu cuenta <b>${esc(st.name || '')}</b> está verificada en el servidor de Viciont Studios${st.type === 'premium' ? ' (premium)' : ''}.`
          : `<span class="chip chip--warn">${icon('alert')}Sin conexión</span> ${esc(st.message || 'No se pudo conectar.')}`;
        hydrateIcons(box);
      };
      pane.querySelector('#srv-retry')?.addEventListener('click', srv);
      srv();
      const show = pane.querySelector('#rec-show');
      if (show) {
        let code = null;
        const get = async () => { code ??= await call('accounts:recoveryCode', active.uuid); return code; };
        show.addEventListener('click', async () => {
          const c = await get();
          pane.querySelector('#rec-code').textContent = c || 'Aún no hay código (se crea al conectar con el servidor de Viciont Studios).';
        });
        pane.querySelector('#rec-copy').addEventListener('click', async () => {
          const c = await get();
          if (c) { await call('app:copy', c); toast('Código copiado.', { kind: 'success' }); }
        });
      }
      pane.querySelector('#namemc')?.addEventListener('click', () => call('app:openExternal', `https://namemc.com/profile/${encodeURIComponent(active.name)}`));
      pane.querySelector('#refresh-prof')?.addEventListener('click', async (e) => {
        try { state.accounts = await busy(e.currentTarget, () => call('accounts:refresh')); app.onAccountChange(); toast('Perfil actualizado.', { kind: 'success' }); } catch (er) { toastError(er); }
      });
    };
    draw();
  },

  admin(pane, app) {
    const PERM_NAMES = { create: 'Crear instancias', edit: 'Editar y publicar', delete: 'Eliminar instancias', players: 'Nicks no premium' };
    const draw = async () => {
      pane.innerHTML = '<div class="settings__section"><p class="field__hint"><span class="spin"></span> Comprobando tu acceso…</p></div>';
      let st;
      try { st = await call('admin:status'); } catch (e) { st = { access: false, error: e.message }; }
      state.admin = st;
      const s = state.settings;
      if (!st.access) {
        pane.innerHTML = `
          <div class="settings__section">
            <h3>Administración</h3>
            <div class="form-error">${icon('lock')}<span>${esc(st.error ? `No se pudo comprobar tu acceso: ${st.error}` : 'Tu cuenta ya no tiene acceso de administración.')}</span></div>
          </div>`;
        hydrateIcons(pane);
        app.onAdminChange(false);
        return;
      }
      const perms = (st.perms || []).map((p) => `<span class="tag">${esc(PERM_NAMES[p] || p)}</span>`).join('') || '<span class="tag">sin permisos</span>';
      const scope = st.scope === '*' ? 'todas las instancias' : `${(st.scope || []).length} instancia(s)`;
      pane.innerHTML = `
        <div class="settings__section">
          <h3>Modo administrador</h3>
          <p class="field__hint">Tu cuenta <b>${esc(st.nick)}</b> tiene acceso de administración concedido desde el panel de Viciont Studios. Es un acceso en dos pasos: el panel autoriza tu nick y tú escribes tu <b>clave personal</b>. Nadie más puede usarla: queda vinculada a tu cuenta.</p>
          <dl class="kv"><dt>Permisos</dt><dd><span class="field__row" style="gap:6px">${perms}</span></dd><dt>Alcance</dt><dd>${esc(scope)}</dd></dl>
          ${st.unlocked
            ? `<div class="form-ok">${icon('shield')}<span>Modo administrador activo${st.remembered ? ' (clave recordada en este PC, cifrada)' : ''}.</span></div>
               <div class="field__row"><button class="btn btn--sm btn--primary" type="button" id="go-admin">${icon('grid')}Abrir administración</button><button class="btn btn--sm btn--danger" type="button" id="lock">${icon('lock')}Salir del modo administrador</button></div>`
            : `<form id="unlock" style="display:grid;gap:12px;max-width:520px">
                 <label class="field"><span class="field__label">Servidor</span><input class="input mono" type="text" value="${esc(st.server || 'sin configurar')}" readonly tabindex="-1" style="opacity:.75"></label>
                 <label class="field"><span class="field__label">Clave personal</span><input class="input mono" type="password" name="key" autocomplete="off" spellcheck="false" placeholder="VSL-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"></label>
                 ${st.hasKey ? '' : `<p class="field__hint">${icon('info')} Todavía no tienes clave: pídele a un responsable del panel que te genere una.</p>`}
                 <label class="check"><input type="checkbox" name="remember"> Recordar en este PC (se guarda cifrada con ${keyring()})</label>
                 <div id="unlock-err"></div>
                 <button class="btn btn--primary" type="submit" ${st.configured ? '' : 'disabled'}>${icon('unlock')}Activar</button>
               </form>`}
        </div>
        ${state.info.dev ? `<div class="settings__section">
          <h3>Servidor de pruebas (solo desarrollo)</h3>
          <p class="field__hint">En la versión instalada el servidor siempre sale de la configuración oficial (<code>remote/launcher.json</code>) y no se puede cambiar.</p>
          <label class="field"><span class="field__label">URL del servidor</span><input class="input mono" id="api" placeholder="http://127.0.0.1:8787" value="${esc(s.apiBase)}"></label>
          <div class="field__row"><button class="btn btn--sm" type="button" id="api-save">${icon('check')}Guardar</button><span class="field__hint">En uso ahora: <b>${esc(state.info.apiBase || 'ninguno')}</b></span></div>
        </div>` : ''}`;
      hydrateIcons(pane);
      pane.querySelector('#unlock')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const btn = f.querySelector('[type=submit]');
        try {
          const r = await busy(btn, () => call('admin:unlock', f.key.value, f.remember.checked), 'Comprobando…');
          app.onAdminChange(true, r);
          toast('Modo administrador activado.', { kind: 'success' });
          draw();
        } catch (er) {
          pane.querySelector('#unlock-err').innerHTML = `<div class="form-error">${icon('alert')}<span>${esc(er.message)}</span></div>`;
          hydrateIcons(pane);
        }
      });
      pane.querySelector('#lock')?.addEventListener('click', async () => { await call('admin:lock'); app.onAdminChange(false); draw(); });
      pane.querySelector('#go-admin')?.addEventListener('click', () => { document.querySelector('.modal .modal__close')?.click(); app.go({ name: 'admin' }); });
      pane.querySelector('#api-save')?.addEventListener('click', async () => {
        const v = pane.querySelector('#api').value.trim();
        if (v && !/^https?:\/\/[^\s]+$/i.test(v)) { toast('Escribe una URL válida (https://…).', { kind: 'error' }); return; }
        await save({ apiBase: v });
        state.info = await call('app:info');
        draw();
      });
    };
    draw();
  },

  about(pane) {
    const info = state.info;
    const privacyUrl = `${String(info.site || 'https://viciontstudios.pages.dev/').replace(/\/?$/, '/')}privacidad`;
    pane.innerHTML = `
      <div class="settings__section" style="justify-items:start">
        <img src="img/logo-full.webp" alt="Viciont Studios" style="width:260px;filter:drop-shadow(0 0 20px rgba(168,85,247,.6))">
        <h3>Viciont Studios Launcher ${esc(info.version)}</h3>
        <p class="field__hint">Launcher oficial de Viciont Studios, creado por <b>CrissyjuanxD</b>. Inspirado en Modrinth App.</p>
        <div class="field__row">
          <button class="btn btn--sm" type="button" data-link="https://github.com/CrissyjuanxD/Viciont-Studio-Launcher">${icon('github')}Código en GitHub</button>
          <button class="btn btn--sm btn--ghost" type="button" data-link="${esc(info.site)}">${icon('globe')}Web de Viciont Studios</button>
        </div>
      </div>
      <div class="settings__section">
        <h3>Información</h3>
        <dl class="kv"><dt>Versión</dt><dd>${esc(info.version)}</dd><dt>Datos</dt><dd>${esc(info.dataDir)}</dd><dt>Configuración</dt><dd>${esc(info.configDir)}</dd><dt>Servidor</dt><dd>${esc(info.apiBase || 'sin configurar')}</dd></dl>
      </div>
      <div class="settings__section">
        <h3>Privacidad y seguridad</h3>
        <ul class="plain-list">
          <li><b>Tu contraseña de Microsoft</b> solo se escribe en la página oficial de Microsoft (igual que en Modrinth o el launcher oficial). El launcher nunca la ve ni la guarda.</li>
          <li><b>Tus sesiones</b> se guardan cifradas con ${keyring()} en este PC y nunca se envían al servidor de Viciont Studios: tu cuenta premium se comprueba con Mojang como en cualquier servidor de Minecraft.</li>
          <li><b>Registro de actividad:</b> para ayudarte si algo falla, el launcher envía al servidor de Viciont Studios lo básico: cuándo entras o sales, cambios de skin, descargas y actualizaciones, cuándo juegas y los errores (con tu nick, la versión del launcher, tu sistema y tu RAM). Si el juego se cierra con un error, también su informe (crash report y registro del juego, sin tu nombre de usuario del sistema). Nunca se envían contraseñas, tokens, códigos de recuperación, tus archivos ni tu IP. Se borra a los 30 días.</li>
          <li><b>Archivos:</b> todo lo que se descarga se comprueba con su huella SHA-1; si algo no coincide, se descarta.</li>
        </ul>
        <div class="field__row">
          <button class="btn btn--sm" type="button" data-link="${esc(privacyUrl)}">${icon('shield')}Ver la política de privacidad completa</button>
        </div>
      </div>
      <div class="settings__section">
        <h3>Créditos y licencias</h3>
        <p class="field__hint">Minecraft es una marca de Mojang Studios / Microsoft. Este launcher no está afiliado a Mojang.<br>
        Skins no premium: <b>CustomSkinLoader</b> (GPL-3.0). Vista 3D: <b>skinview3d</b> (MIT). Mods y búsquedas: API pública de <b>Modrinth</b>.
        Fuentes: Bebas Neue, Chakra Petch y Share Tech Mono (SIL Open Font License). Java: runtime oficial de Mojang / Eclipse Temurin.</p>
      </div>`;
    pane.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => call('app:openExternal', b.dataset.link)));
  },
};
