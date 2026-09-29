import { call, state } from '../api.js';
import { icon, hydrateIcons } from '../icons.js';
import { esc, debounce } from '../util.js';
import { toastError } from '../ui.js';
import { glitchImg, scramble } from '../fx.js';

export function render(root, { onDone, canCancel = false, onCancel } = {}) {
  let step = 'choose';
  let checkSeq = 0;
  let disposed = false;
  let msBusy = false;

  const draw = () => {
    root.innerHTML = `
      <div class="login__card">
        <div class="login__brand">
          ${glitchImg('img/emblem.webp')}
          <h1 class="login__title"><span class="glitch" data-text="INICIAR SESIÓN" id="login-title">INICIAR SESIÓN</span></h1>
          <p class="login__sub">Viciont Studios Launcher</p>
        </div>
        <div id="login-step"></div>
        <p class="login__foot">Creado por <b>CrissyjuanxD</b> · Viciont Studios</p>
      </div>`;
    hydrateIcons(root);
    scramble(root.querySelector('#login-title'), 'INICIAR SESIÓN');
    drawStep();
  };

  const drawStep = () => {
    const box = root.querySelector('#login-step');
    if (disposed || !box) return;
    if (step === 'choose') {
      box.innerHTML = `
        <div class="login__options">
          <button class="login-opt" type="button" data-opt="ms">
            <span class="login-opt__icon">${icon('microsoft')}</span>
            <span><span class="login-opt__title">Cuenta de Microsoft (premium)</span><span class="login-opt__desc">Si compraste Minecraft: Java Edition. Tu skin se verá en todos los servidores.</span></span>
          </button>
          <button class="login-opt" type="button" data-opt="offline">
            <span class="login-opt__icon">${icon('user')}</span>
            <span><span class="login-opt__title">Sin cuenta premium</span><span class="login-opt__desc">Solo con tu nick. Tu skin la verán quienes jueguen con este launcher.</span></span>
          </button>
          ${canCancel ? `<button class="btn btn--ghost btn--block" type="button" data-opt="cancel">Volver</button>` : ''}
        </div>
        <div id="login-error" style="margin-top:14px"></div>`;
    } else if (step === 'ms') {
      box.innerHTML = `
        <div class="login__form" style="justify-items:center;text-align:center;padding:10px 0">
          <span class="spin" style="width:34px;height:34px;border-width:3px"></span>
          <p class="login__sub">Termina el inicio de sesión en la ventana de Microsoft…<br><small class="muted">Tu contraseña solo se escribe en la página oficial de Microsoft.</small></p>
          <div class="field__row" style="justify-content:center">
            <button class="btn btn--sm" type="button" data-opt="ms-focus">${icon('external')}Mostrar la ventana</button>
            <button class="btn btn--sm btn--ghost" type="button" data-opt="ms-cancel">Cancelar</button>
          </div>
        </div>`;
    } else if (step === 'offline') {
      box.innerHTML = `
        <button class="login__back" type="button" data-opt="back">${icon('arrowLeft')}Volver</button>
        <form class="login__form" id="offline-form" autocomplete="off">
          <label class="field">
            <span class="field__label">Tu nick de Minecraft</span>
            <input class="input" id="nick" name="nick" maxlength="16" placeholder="Ej: Crissy_2026" spellcheck="false" autofocus>
            <span class="nick-status" id="nick-status">Entre 3 y 16 caracteres: letras, números y _</span>
          </label>
          <details id="rec-box">
            <summary class="field__hint" style="cursor:pointer">¿Ya usaste este nick en otro PC?</summary>
            <label class="field" style="margin-top:10px">
              <span class="field__label">Código de recuperación</span>
              <input class="input mono" id="rec" name="rec" placeholder="Pega tu código aquí" spellcheck="false">
              <span class="field__hint">Lo encuentras en Ajustes → Cuenta del otro PC. Sirve para demostrar que el nick es tuyo.</span>
            </label>
          </details>
          <div id="login-error"></div>
          <button class="btn btn--primary btn--block" type="submit" id="offline-go" disabled>${icon('arrowRight')}Entrar</button>
        </form>`;
      const input = box.querySelector('#nick');
      const status = box.querySelector('#nick-status');
      const go = box.querySelector('#offline-go');
      const setStatus = (kind, text) => {
        status.className = `nick-status ${kind ? `is-${kind}` : ''}`;
        status.innerHTML = `${kind === 'ok' ? icon('check') : kind === 'bad' ? icon('alert') : kind === 'wait' ? '<span class="spin" style="width:14px;height:14px"></span>' : ''}<span>${esc(text)}</span>`;
      };
      let lastOk = null;
      const check = debounce(async () => {
        const name = input.value.trim();
        const seq = ++checkSeq;
        lastOk = null;
        go.disabled = true;
        if (!name) { setStatus('', 'Entre 3 y 16 caracteres: letras, números y _'); return; }
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
          setStatus('bad', name.length < 3 ? 'Mínimo 3 caracteres.' : 'Solo letras, números y guion bajo (_), máximo 16.');
          return;
        }
        setStatus('wait', 'Comprobando en la base de datos de Mojang (NameMC)…');
        try {
          const r = await call('accounts:checkNick', name);
          if (seq !== checkSeq) return;
          if (r.ok) { setStatus('ok', r.message); lastOk = name; go.disabled = false; }
          else {
            setStatus('bad', r.message);
            if (r.reason === 'claimed') { box.querySelector('#rec-box').open = true; lastOk = name; go.disabled = false; }
          }
        } catch (e) {
          if (seq === checkSeq) setStatus('bad', e.message);
        }
      }, 450);
      input.addEventListener('input', () => { input.value = input.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16); check(); });
      box.querySelector('#offline-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!lastOk || lastOk !== name) return;
        go.disabled = true;
        go.innerHTML = '<span class="spin"></span>Entrando…';
        try {
          const summary = await call('accounts:loginOffline', name, box.querySelector('#rec').value.trim());
          state.accounts = summary;
          onDone?.(summary);
        } catch (err) {
          showError(err.message);
          go.disabled = false;
          go.innerHTML = `${icon('arrowRight')}Entrar`;
          if (err.code === 'ENICKTAKEN' || err.code === 'EBADCODE') box.querySelector('#rec-box').open = true;
        }
      });
      setTimeout(() => input.focus(), 50);
    }
    hydrateIcons(box);
  };

  const showError = (msg) => {
    const el = root.querySelector('#login-error');
    if (el) el.innerHTML = msg ? `<div class="form-error">${icon('alert')}<span>${esc(msg)}</span></div>` : '';
  };

  const onClick = async (e) => {
    const b = e.target.closest('[data-opt]');
    if (!b || disposed) return;
    const opt = b.dataset.opt;
    if (opt === 'cancel') { onCancel?.(); return; }
    if (opt === 'back') { step = 'choose'; drawStep(); return; }
    if (opt === 'offline') { step = 'offline'; drawStep(); return; }
    if (opt === 'ms-focus') { call('accounts:loginMicrosoft').catch(() => {}); return; }
    if (opt === 'ms-cancel') { call('accounts:cancelLogin').catch(() => {}); return; }
    if (opt === 'ms') {
      if (msBusy) return;
      msBusy = true;
      step = 'ms';
      drawStep();
      try {
        const summary = await call('accounts:loginMicrosoft');
        if (disposed) return;
        state.accounts = summary;
        onDone?.(summary);
      } catch (err) {
        if (disposed) return;
        step = 'choose';
        drawStep();
        if (err.code !== 'ECANCEL') showError(err.message);
      } finally {
        msBusy = false;
      }
    }
  };
  root.addEventListener('click', onClick);

  draw();
  return () => {
    disposed = true;
    root.removeEventListener('click', onClick);
  };
}

export { toastError };
