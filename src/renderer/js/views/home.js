// Pantalla principal: logo con glitch, bienvenida, "continuar jugando" e instancias.

import { state, on, call } from '../api.js';
import { icon } from '../icons.js';
import { esc, instIcon, instThumb, loaderLabel, timeAgo, bytes } from '../util.js';
import { typeLoop, scramble, glitchImg, bindTilt } from '../fx.js';
import { statusChip } from './instance.js';

export function render(root, _route, app) {
  app.scene.clear();
  app.bg.setMode('home');
  const acc = state.accounts.active;
  root.innerHTML = `
    <section class="home">
      <div class="home__hero">
        <div class="home__brand">
          ${glitchImg('img/emblem.webp', 'home__emblem')}
          <h1 class="home__title"><span class="glitch" data-text="VICIONT">VICIONT</span><span class="glitch glitch--grad" data-text="STUDIO">STUDIO</span></h1>
          <p class="home__tagline"><span id="home-typing"></span><span class="caret"></span></p>
          <p class="home__welcome">Bienvenido${acc ? `, <b id="home-name">${esc(acc.name)}</b>` : ''}. Elige una instancia de la barra lateral o de la lista.</p>
        </div>
        <div id="home-continue"></div>
      </div>
      <div class="home__section">
        <div class="section-head">
          <h2 class="title-md">Instancias <span class="hl">disponibles</span></h2>
          <button class="btn btn--sm btn--ghost" id="home-refresh" type="button">${icon('refresh')}Actualizar lista</button>
        </div>
        <div id="home-note"></div>
        <div class="grid-cards" id="home-grid"></div>
      </div>
      <footer class="home__footer">
        <span>Launcher oficial de <b>Viciont Studios</b> · creado por <b>CrissyjuanxD</b></span>
        <div class="socials" id="home-socials"></div>
      </footer>
    </section>`;

  let stopTyping = typeLoop(root.querySelector('#home-typing'), ['instancias oficiales del estudio', 'eventos, series y hardcores', 'descargas rápidas y seguras', 'skins para todos']);
  const nameEl = root.querySelector('#home-name');
  if (nameEl) scramble(nameEl, acc.name);
  bindTilt(root);

  const renderList = () => {
    const grid = root.querySelector('#home-grid');
    const note = root.querySelector('#home-note');
    const list = state.instances;
    const meta = state.instancesMeta;
    note.innerHTML = '';
    if (meta.error === 'EOFFLINE') note.innerHTML = `<div class="banner-note">${icon('alert')}<span>Sin conexión con el servidor. Se muestran las instancias que ya tienes instaladas.</span></div>`;
    if (!list.length) {
      grid.innerHTML = meta.configured === false || meta.error === 'ENOBACKEND'
        ? `<div class="empty">${icon('server')}<h3>Servidor en preparación</h3><p>El estudio todavía está configurando el servidor de instancias. Vuelve a mirar pronto.</p></div>`
        : `<div class="empty">${icon('cube')}<h3>Nada por aquí todavía</h3><p>Cuando el estudio publique una instancia para tu cuenta aparecerá aquí.</p></div>`;
    } else {
      grid.innerHTML = list.map((i) => `
        <button class="icard" type="button" data-id="${esc(i.id)}" data-tilt>
          <div class="icard__media">${instThumb(i)}<div class="icard__status">${statusChip(i)}</div></div>
          <div class="icard__body">
            <div class="icard__icon">${instIcon(i)}</div>
            <div class="icard__name">${esc(i.name)}</div>
            <div class="icard__meta">
              <span class="tag">${esc(i.mc || '')}</span>
              <span class="tag">${esc(loaderLabel(i.loader))}</span>
              ${i.visibility === 'private' ? `<span class="tag">${icon('lock')} privada</span>` : ''}
            </div>
            ${i.summary ? `<p class="icard__summary">${esc(i.summary)}</p>` : ''}
          </div>
        </button>`).join('');
    }
    // continuar jugando
    const cont = root.querySelector('#home-continue');
    const last = [...list].filter((i) => i.installed && i.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed)[0]
      || list.find((i) => i.featured) || list[0];
    if (!last) { cont.innerHTML = ''; return; }
    const played = last.installed && last.lastPlayed;
    cont.innerHTML = `
      <div class="home__continue">
        <div class="home__continue-media">${instThumb(last)}</div>
        <div class="home__continue-body">
          <span class="home__continue-kicker">${played ? `Jugado ${esc(timeAgo(last.lastPlayed))}` : 'Destacada'}</span>
          <span class="home__continue-name">${esc(last.name)}</span>
          <div class="icard__meta"><span class="tag">${esc(last.mc || '')}</span><span class="tag">${esc(loaderLabel(last.loader))}</span>${last.size ? `<span class="tag">${esc(bytes(last.size))}</span>` : ''}</div>
          <button class="btn btn--primary btn--block" type="button" data-open="${esc(last.id)}">${icon(played ? 'play' : 'arrowRight')}${played ? 'Continuar' : 'Ver instancia'}</button>
        </div>
      </div>`;
  };

  root.addEventListener('click', (e) => {
    const card = e.target.closest('[data-id], [data-open]');
    if (card) app.go({ name: 'instance', id: card.dataset.id || card.dataset.open });
    const s = e.target.closest('[data-social]');
    if (s) call('app:openExternal', s.dataset.social).catch(() => {});
  });
  root.querySelector('#home-refresh').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await app.refreshInstances(); } finally { btn.disabled = false; }
  });

  renderList();
  const off = on('instances', renderList);

  // redes del estudio (desde la web)
  app.studio().then((st) => {
    const box = root.querySelector('#home-socials');
    if (!box || !st) return;
    const items = [['youtube', 'YouTube'], ['x', 'X'], ['discord', 'Discord']].filter(([k]) => st.socials?.[k]);
    box.innerHTML = items.map(([k, label]) => `<button class="social-btn" type="button" data-social="${esc(st.socials[k])}" data-tip="${label} de Viciont Studios">${icon(k)}</button>`).join('')
      + `<button class="social-btn" type="button" data-social="${esc(st.site)}" data-tip="Web del estudio">${icon('globe')}</button>`;
    if (st.typing?.length) {
      stopTyping();
      stopTyping = typeLoop(root.querySelector('#home-typing'), st.typing);
    }
  });

  return () => { off(); stopTyping(); };
}
