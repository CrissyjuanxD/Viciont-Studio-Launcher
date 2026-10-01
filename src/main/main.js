'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = fs.promises;
const { app, BrowserWindow, protocol, ipcMain, shell, dialog, Tray, Menu, nativeImage, session, clipboard } = require('electron');
const paths = require('./core/paths');
const log = require('./core/log');
const { Settings, totalMB, DEFAULT_JVM, recommendedMax } = require('./core/settings');
const { setUserAgent, getJson, cached } = require('./util/net');
const { dirSize, rmrf, exists, readJson } = require('./util/fsx');
const { Backend } = require('./services/backend');
const { Accounts } = require('./services/accounts');
const { Instances, baseId, isTestId } = require('./services/instances');
const { Skins } = require('./services/skins');
const { Media } = require('./services/media');
const { Admin } = require('./services/admin');
const { Updater } = require('./services/updater');
const { Telemetry } = require('./services/telemetry');
const { DiscordPresence } = require('./services/discord');
const modrinth = require('./services/modrinth');
const { getVersionManifest } = require('./game/versions');
const { listLoaderVersions, supportedGameVersions, LOADERS } = require('./game/loaders');
const { probeJava } = require('./game/java');
const { crashText } = require('./game/crash');

const isDev = !app.isPackaged;
const RENDERER = path.join(__dirname, '..', 'renderer');
const APP_NAME = 'Viciont Studios Launcher';
const VERSION = app.getVersion();
const TEST_SCRIPT = !app.isPackaged ? (process.argv.find((a) => a.startsWith('--vsl-test=')) || '').slice(11) : '';
const HIDDEN_TEST = Boolean(TEST_SCRIPT) && process.argv.includes('--hidden');

setUserAgent(`ViciontStudioLauncher/${VERSION} (+https://github.com/CrissyjuanxD/Viciont-Studio-Launcher)`);
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.viciontstudios.launcher');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  const settings = new Settings();
  const prevVersion = settings.get().lastVersion;
  const justUpdated = app.isPackaged && ((Boolean(prevVersion) && prevVersion !== VERSION) || process.argv.includes('--updated'));
  if (prevVersion !== VERSION) settings.set({ lastVersion: VERSION });
  if (settings.get().updateTried?.version === VERSION) settings.set({ updateTried: null });
  if (!settings.get().hardwareAcceleration) app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService,SpareRendererForSitePerProcess');

  protocol.registerSchemesAsPrivileged([
    { scheme: 'vsl', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
    { scheme: 'vsl-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);

  let dataRoot = settings.get().dataDir || paths.DEFAULT_DATA_ROOT;
  let dirs = paths.dataDirs(dataRoot);
  const getDirs = () => dirs;

  const backend = new Backend(settings, log, { allowOverride: isDev });
  const accounts = new Accounts({ backend, log });
  const instances = new Instances({ dirs, settings, backend, accounts, log, configRoot: paths.CONFIG_ROOT });
  const skins = new Skins({ getDirs, accounts, backend, log });
  const media = new Media({ getDirs, backend, log });
  const admin = new Admin({ getDirs, backend, accounts, instances, log });
  const updater = new Updater({ log, settings });
  updater.canAutoCheck = () => !instances.anyRunning() && !instances.busy();
  const telemetry = new Telemetry({ accounts, backend, log, version: VERSION });
  const track = (type, info) => { try { telemetry.track(type, info); } catch {} };
  const instName = (id) => `${instances.remote.get(baseId(id))?.name || baseId(id)}${isTestId(id) ? ' (copia de prueba)' : ''}`;

  const discord = new DiscordPresence({ log, version: VERSION });
  const presence = { view: 'home', instanceId: null, playing: null, downloading: null };
  const instInfo = (id) => {
    const r = instances.remote.get(baseId(id)) || {};
    const icon = typeof r.media?.icon === 'string' ? r.media.icon : null;
    return {
      id, name: r.name || id, mc: r.mc || '', loader: r.loader || null, loaderName: LOADERS[r.loader?.type]?.name || '',
      visibility: r.visibility || 'public', iconUrl: icon && backend.configured() ? backend.url(`/v1/media/${icon}`) : null,
    };
  };
  function updatePresence() {
    const s = settings.get();
    discord.configure({ enabled: s.discordRpc, clientId: backend.discordClientId() });
    if (!discord.enabled) return;
    discord.set(DiscordPresence.build({
      version: VERSION,
      view: presence.view,
      instance: presence.instanceId ? instInfo(presence.instanceId) : null,
      playing: presence.playing ? { ...instInfo(presence.playing.id), since: presence.playing.since } : null,
      downloading: presence.downloading ? { ...instInfo(presence.downloading.id), percent: presence.downloading.percent } : null,
      showPrivate: !s.discordHidePrivate,
    }));
  }

  let win = null;
  let tray = null;
  let quitting = false;
  let closeAsked = false;
  let hiddenForGame = false;
  const stateFile = paths.configFile('window.json');

  const send = (type, data) => {
    if (win && !win.isDestroyed()) win.webContents.send('vsl:event', { type, data });
  };

  async function createWindow() {
    const saved = await readJson(stateFile, {});
    win = new BrowserWindow({
      width: saved.width || 1180,
      height: saved.height || 720,
      x: saved.x, y: saved.y,
      minWidth: 960, minHeight: 600,
      show: false,
      backgroundColor: '#06020c',
      title: `${APP_NAME} ${VERSION}`,
      icon: path.join(RENDERER, 'img', 'icon.png'),
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 14, y: 11 } }
        : { titleBarOverlay: { color: '#07030d', symbolColor: '#e9e0ff', height: 36 } }),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: true,
        devTools: isDev,
      },
    });
    if (saved.maximized) win.maximize();
    win.setMenu(null);
    const wc = win.webContents;
    wc.on('will-navigate', (e, url) => { if (!String(e?.url || url).startsWith('vsl://app/')) e.preventDefault(); });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.on('before-input-event', (e, input) => {
      const mod = input.control || input.meta;
      if (!isDev && (input.key === 'F5' || (mod && ['r', 'R'].includes(input.key)) || (mod && (input.shift || input.alt) && ['i', 'I'].includes(input.key)))) e.preventDefault();
      if (isDev && input.key === 'F12' && input.type === 'keyDown') wc.toggleDevTools();
    });
    wc.on('render-process-gone', (_, d) => {
      log.error('La interfaz se cerró:', d.reason);
      track('launcher.error', { level: 'error', message: `La interfaz se cerró (${d.reason})`, data: { exitCode: d.exitCode } });
    });
    win.once('ready-to-show', () => {
      if (HIDDEN_TEST) {
        win.setOpacity(0);
        win.setIgnoreMouseEvents(true);
        win.setSkipTaskbar(true);
        win.showInactive();
        return;
      }
      win.show();
      win.focus();
    });
    win.on('close', (e) => {
      saveWindowState();
      if (quitting) return;
      if (instances.busy() || admin.tasks.size) {
        e.preventDefault();
        if (!closeAsked) {
          closeAsked = true;
          send('close-requested', { tasks: [...instances.tasks.keys()], admin: admin.tasks.size });
          setTimeout(() => { closeAsked = false; }, 800);
        }
      }
    });
    win.on('closed', () => {
      win = null;
      if (!quitting && instances.anyRunning()) ensureTray('El juego sigue abierto');
    });
    win.on('session-end', () => { quitting = true; instances.cancelAll(); });
    win.on('focus', () => { send('focus', true); updater.checkSoon(); });
    win.on('blur', () => send('focus', false));
    win.on('minimize', () => send('visibility', 'minimized'));
    win.on('restore', () => send('visibility', 'visible'));
    await win.loadURL('vsl://app/index.html');
  }

  function saveWindowState() {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const b = maximized ? (readJsonSyncSafe(stateFile) || {}) : win.getBounds();
    fs.writeFile(stateFile, JSON.stringify({ ...b, maximized }), () => {});
  }

  function readJsonSyncSafe(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

  function showWindow() {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else createWindow();
  }

  function ensureTray(tooltip) {
    if (!tray) {
      tray = new Tray(nativeImage.createFromPath(path.join(RENDERER, 'img', 'icon.png')).resize({ width: 16, height: 16 }));
      tray.on('click', showWindow);
    }
    tray.setToolTip(tooltip || APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Abrir ${APP_NAME}`, click: showWindow },
      { type: 'separator' },
      { label: 'Salir', click: () => { quitting = true; app.quit(); } },
    ]));
  }

  function destroyTray() {
    if (tray) { tray.destroy(); tray = null; }
  }

  instances.on('instance', (d) => send('instance', d));
  instances.on('progress', (p) => {
    send('progress', p);
    if (p.kind !== 'launch' && p.id) { presence.downloading = { id: p.id, percent: p.percent ?? null }; updatePresence(); }
    if (win && !win.isDestroyed() && p.kind !== 'launch') win.setProgressBar(p.total > 0 ? Math.min(1, p.done / p.total) : 2);
  });
  instances.on('task-done', (d) => {
    send('task-done', d);
    if (win && !win.isDestroyed() && !instances.busy()) win.setProgressBar(-1);
    if (presence.downloading?.id === d.id) { presence.downloading = null; updatePresence(); }
    if (d.kind === 'launch') return;
    const name = instName(d.id);
    const v = instances.remote.get(baseId(d.id))?.version;
    if (d.ok) track('instance.installed', { instance: baseId(d.id), message: `${d.kind === 'repair' ? 'Reparó' : 'Descargó / actualizó'} ${name}${v ? ` (versión ${v})` : ''}`, data: { version: v || null } });
    else if (d.cancelled) track('instance.paused', { instance: baseId(d.id), message: `Pausó la descarga de ${name}` });
    else track('instance.error', { level: 'error', instance: baseId(d.id), message: `Error al descargar ${name}: ${d.error}`, data: { kind: d.kind } });
  });
  instances.on('game-start', (d) => {
    send('game', { ...d, state: 'running' });
    presence.playing = { id: d.id, since: Date.now() };
    updatePresence();
    const uuid = telemetry.gameStarted(d.id);
    const r = instances.remote.get(baseId(d.id));
    track('game.start', { uuid, instance: baseId(d.id), message: `Empezó a jugar ${instName(d.id)}`, data: { mc: r?.mc || null, loader: r?.loader?.type || null } });
    const mode = settings.get().onLaunch;
    if (!win) return;
    if (mode === 'minimize') setTimeout(() => win?.minimize(), 1200);
    if (mode === 'hide') {
      const name = instName(d.id);
      ensureTray(`Jugando a ${name}`);
      setTimeout(() => {
        if (win && !instances.busy() && instances.anyRunning()) {
          hiddenForGame = true;
          saveWindowState();
          win.destroy();
        }
      }, 1500);
    }
  });
  instances.on('game-exit', (d) => {
    const uuid = telemetry.gameStopped(d.id);
    if (presence.playing?.id === d.id) { presence.playing = null; updatePresence(); }
    const mins = Math.round((d.duration || 0) / 60000);
    if (d.crashed) {
      const head = `Viciont Studios Launcher ${VERSION} · ${instName(d.id)} · código ${d.code} · ${mins} min · ${new Date().toISOString()}`;
      try {
        telemetry.trackCrash({
          uuid, level: 'error', instance: baseId(d.id),
          message: `El juego se cerró con error (código ${d.code}) en ${instName(d.id)} tras ${mins} min${d.crash?.report ? ' (con crash report)' : ''}`,
          data: { code: d.code, minutes: mins, crashReport: d.crash?.report?.name || null, log: (d.log || []).slice(-30).map((l) => String(l).slice(0, 300)) },
        }, d.crash ? crashText(d.crash, head) : '');
      } catch {}
    } else {
      track('game.exit', { uuid, instance: baseId(d.id), message: `Dejó de jugar ${instName(d.id)} (${mins} min)`, data: { minutes: mins } });
    }
    const s = settings.get();
    if (instances.anyRunning()) { send('game', { ...d, state: 'exit' }); return; }
    if (!win) {
      if (hiddenForGame && s.reopenOnExit) {
        hiddenForGame = false;
        destroyTray();
        createWindow().then(() => setTimeout(() => send('game', { ...d, state: 'exit' }), 1200));
      } else if (!hiddenForGame) {
        quitting = true;
        app.quit();
      }
      return;
    }
    hiddenForGame = false;
    destroyTray();
    if (s.reopenOnExit && win.isMinimized()) win.restore();
    send('game', { ...d, state: 'exit' });
  });
  admin.on('progress', (p) => send('admin-progress', p));
  admin.on('locked', () => send('admin-locked', true));
  admin.on('sync-revoked', (list) => send('admin-sync-revoked', list));
  accounts.on('change', (s) => send('accounts', s));
  accounts.on('track', (type, info) => track(type, info));
  let lastUpdateStatus = null;
  const installOnStart = () => {
    const s = updater.state;
    if (quitting || !s.onStart || s.skipped || s.installing || !updater.canInstall()) return;
    if (instances.busy() || instances.anyRunning() || admin.tasks.size) { updater.set({ skipped: true }); return; }
    settings.set({ updateTried: { version: s.version, at: Date.now() } });
    track('launcher.update', { message: `Instaló la actualización ${s.version} al abrir el launcher` });
    log.info(`Instalando la actualización ${s.version} al abrir el launcher`);
    quitting = true;
    updater.set({ installing: true });
    setTimeout(() => updater.install(), 1800);
  };
  updater.on('state', (s) => {
    send('update', s);
    if (s.status === 'ready' && s.onStart && !s.skipped && !s.installing) setImmediate(installOnStart);
    if (s.status === lastUpdateStatus) return;
    lastUpdateStatus = s.status;
    if (s.status === 'ready') track('launcher.update', { message: `Descargó la actualización ${s.version} del launcher` });
    if (s.status === 'error') track('launcher.update_error', { level: 'warn', message: `No se pudo actualizar el launcher: ${s.error}` });
  });

  const handlers = {};
  const on = (name, fn) => { handlers[name] = fn; };
  const parentWin = () => (win && !win.isDestroyed() ? win : undefined);

  let updateNotice = justUpdated;
  on('app:info', () => {
    const notice = updateNotice;
    updateNotice = false;
    return {
      name: APP_NAME, version: VERSION, dev: isDev, platform: process.platform, totalMB, recommendedMax: recommendedMax(),
      dataDir: dataRoot, configDir: paths.CONFIG_ROOT, backend: backend.configured(), apiBase: backend.base(),
      news: backend.news(), admin: admin.quickStatus(), update: updater.state, justUpdated: notice, defaultJvm: DEFAULT_JVM,
      discord: { available: Boolean(backend.discordClientId()) }, site: backend.siteUrl(),
      loaders: Object.fromEntries(Object.entries(LOADERS).map(([k, v]) => [k, v.name])),
    };
  });
  on('app:openExternal', (url) => {
    if (!/^https:\/\/[^\s]+$/i.test(String(url))) throw new Error('Enlace no permitido');
    return shell.openExternal(url);
  });
  on('app:openFolder', async (kind, id) => {
    if (kind === 'instance' && id) {
      const d = await instances.get(id);
      if (d && d.showFolder === false && !d.canManage && !d.workspace && !(d.test && admin.unlocked())) throw new Error('Esta instancia no permite abrir su carpeta.');
    }
    const targets = {
      data: () => dataRoot,
      logs: () => log.DIR,
      config: () => paths.CONFIG_ROOT,
      instance: () => instances.gameDir(String(id)),
      'instance-sub': () => path.join(instances.gameDir(String(id?.id)), String(id?.sub || '').replace(/[^a-z_-]/gi, '')),
    };
    const target = targets[kind]?.();
    if (!target) throw new Error('Carpeta no válida');
    await fsp.mkdir(target, { recursive: true });
    return shell.openPath(target);
  });
  on('app:copy', (text) => { clipboard.writeText(String(text).slice(0, 12 * 1024 * 1024)); return true; });
  on('app:saveText', async (name, text) => {
    const safe = String(name || 'informe.txt').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'informe.txt';
    const r = await dialog.showSaveDialog(parentWin(), { title: 'Guardar informe', defaultPath: path.join(app.getPath('desktop'), safe), filters: [{ name: 'Texto', extensions: ['txt'] }] });
    if (r.canceled || !r.filePath) return null;
    await fsp.writeFile(r.filePath, String(text ?? ''), 'utf8');
    return r.filePath;
  });
  on('app:presence', (p) => {
    const view = ['home', 'instance', 'skins', 'admin', 'login'].includes(p?.view) ? p.view : 'home';
    presence.view = view === 'admin' ? 'home' : view;
    presence.instanceId = view === 'instance' && typeof p?.id === 'string' ? p.id.slice(0, 48) : null;
    updatePresence();
    return true;
  });
  let uiErrors = 0;
  on('app:uiError', (message) => {
    if (++uiErrors > 5) return false;
    log.warn('[interfaz]', String(message).slice(0, 500));
    track('launcher.ui_error', { level: 'warn', message: String(message).slice(0, 400) });
    return true;
  });
  on('app:studio', async () => {
    const file = paths.configFile('studio.json');
    const site = backend.siteUrl();
    try {
      const d = await cached(`studio:${site}`, 60 * 60 * 1000, () => getJson(`${site}data/content.json`, { timeout: 10000, retries: 1 }));
      const out = {
        name: String(d?.site?.name || 'Viciont Studios').slice(0, 60),
        founder: String(d?.site?.founder || 'CrissyjuanxD').slice(0, 40),
        tagline: String(d?.site?.tagline || '').slice(0, 200),
        typing: (Array.isArray(d?.site?.typing) ? d.site.typing : []).map((t) => String(t).slice(0, 60)).slice(0, 8),
        socials: Object.fromEntries(['youtube', 'x', 'discord'].map((k) => [k, /^https:\/\//i.test(d?.socials?.[k] || '') ? d.socials[k] : ''])),
        site,
      };
      fs.writeFile(file, JSON.stringify(out), () => {});
      return out;
    } catch {
      return { ...(await readJson(file, { name: 'Viciont Studios', founder: 'CrissyjuanxD', typing: [], socials: {} })), site };
    }
  });
  on('app:closeDecision', async (quit) => {
    if (!quit) return false;
    quitting = true;
    send('closing', true);
    await instances.cancelAll();
    for (const p of admin.tasks.values()) p.stop();
    setTimeout(() => app.quit(), 150);
    return true;
  });
  on('app:checkUpdates', () => updater.check());
  on('app:skipStartUpdate', () => updater.skipStart());
  on('app:openDownload', () => shell.openExternal(`${backend.siteUrl().replace(/\/?$/, '/')}#launcher`).then(() => true));
  on('app:installUpdate', () => {
    if (!updater.canInstall()) throw new Error('No hay ninguna actualización lista para instalar.');
    if (instances.busy()) throw new Error('Espera a que terminen las descargas antes de actualizar.');
    if (instances.anyRunning()) throw new Error('Cierra el juego antes de actualizar el launcher.');
    quitting = true;
    setTimeout(() => updater.install(), 900);
    return true;
  });

  on('settings:get', () => settings.get());
  on('settings:set', (patch) => {
    const allowed = ['memory', 'jvmArgs', 'resolution', 'javaPaths', 'onLaunch', 'reopenOnExit', 'concurrency', 'effects', 'hardwareAcceleration', 'autoUpdate', 'discordRpc', 'discordHidePrivate'];
    if (isDev) allowed.push('apiBase');
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
    if (clean.javaPaths) {
      clean.javaPaths = Object.fromEntries(Object.entries(clean.javaPaths || {}).filter(([, v]) => typeof v === 'string' && /^(javaw?\.exe|java)$/i.test(path.basename(v)) && path.isAbsolute(v) && fs.existsSync(v)));
    }
    const before = settings.get().apiBase;
    const out = settings.set(clean);
    if (out.apiBase !== before) instances.refresh().then((l) => send('instances', l));
    if ('discordRpc' in clean || 'discordHidePrivate' in clean) updatePresence();
    return out;
  });
  let chosenDataDir = null;
  on('settings:chooseDataDir', async () => {
    const r = await dialog.showOpenDialog(parentWin(), { title: 'Elegir carpeta de datos', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    let target = r.filePaths[0];
    if (path.basename(target).toLowerCase() !== paths.APP_DIR_NAME.toLowerCase()) target = path.join(target, paths.APP_DIR_NAME);
    chosenDataDir = target;
    return target;
  });
  on('settings:moveDataDir', async (target, { move } = {}) => {
    if (instances.busy() || instances.anyRunning()) throw new Error('Cierra el juego y espera a que terminen las descargas.');
    if (target !== null && target !== chosenDataDir) throw new Error('Elige la carpeta con el botón "Cambiar".');
    const dest = target === null ? paths.DEFAULT_DATA_ROOT : path.resolve(String(target));
    if (path.resolve(dest).toLowerCase() === path.resolve(dataRoot).toLowerCase()) return { dataDir: dataRoot };
    paths.ensureDataRoot(dest);
    if (move) {
      for (const sub of ['meta', 'instances', 'skins', 'admin', 'backups']) {
        const from = path.join(dataRoot, sub);
        if (!(await exists(from))) continue;
        const to = path.join(dest, sub);
        send('moving', { sub });
        try { await fsp.rename(from, to); } catch {
          await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: false });
          await rmrf(from);
        }
      }
    }
    settings.set({ dataDir: dest === paths.DEFAULT_DATA_ROOT ? null : dest });
    dataRoot = dest;
    dirs = paths.dataDirs(dataRoot);
    instances.setDirs(dirs);
    media.localRoots.set('admin', path.join(dirs.admin, 'media'));
    paths.registerDataDir(dataRoot);
    return { dataDir: dataRoot };
  });
  on('settings:storage', async () => {
    const [meta, inst, caches] = await Promise.all([dirSize(dirs.meta), dirSize(dirs.instances), dirSize(dirs.caches)]);
    return { meta, instances: inst, caches, dataDir: dataRoot };
  });
  on('settings:clearCache', async () => {
    if (instances.busy()) throw new Error('Espera a que terminen las descargas.');
    await rmrf(dirs.caches);
    return true;
  });
  on('settings:chooseJava', async () => {
    const r = await dialog.showOpenDialog(parentWin(), process.platform === 'win32'
      ? { title: 'Elegir java.exe o javaw.exe', properties: ['openFile'], filters: [{ name: 'Java', extensions: ['exe'] }] }
      : { title: 'Elegir el archivo java (dentro de la carpeta bin de Java)', properties: ['openFile', 'treatPackageAsDirectory', 'showHiddenFiles'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const info = await probeJava(r.filePaths[0]);
    if (!info) throw new Error('Ese archivo no parece ser Java.');
    return { path: r.filePaths[0], ...info };
  });

  on('accounts:get', () => accounts.summary());
  on('accounts:loginMicrosoft', () => accounts.loginMicrosoft());
  on('accounts:cancelLogin', () => { accounts.cancelLogin(); return true; });
  on('accounts:serverStatus', async () => {
    if (!backend.configured()) return { ok: false, message: 'El servidor de Viciont Studios todavía no está configurado.' };
    try {
      const me = await accounts.me({ fresh: true, force: true });
      if (!me?.name) return { ok: false, message: 'Inicia sesión con una cuenta para conectarte al servidor de Viciont Studios.' };
      return { ok: true, name: me.name, type: me.type, admin: Boolean(me.admin) };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  on('accounts:checkNick', (name) => accounts.checkNick(name));
  on('accounts:loginOffline', (name, code) => accounts.loginOffline(name, code));
  on('accounts:switch', (uuid) => accounts.setActive(uuid));
  on('accounts:logout', async (uuid, opts) => {
    const acc = accounts.find(uuid);
    if (acc) {
      track('auth.logout', { uuid, message: 'Cerró sesión en el launcher' });
      await telemetry.flushNow(3000);
    }
    admin.forget(uuid);
    return accounts.remove(uuid, { forgetMicrosoft: opts?.forgetMicrosoft === true, forgetRecovery: opts?.forgetRecovery === true });
  });
  on('accounts:recoveryCode', (uuid) => accounts.recoveryCode(uuid));
  on('accounts:newRecovery', (uuid) => accounts.newRecovery(uuid));
  on('accounts:refresh', async () => {
    const a = accounts.active();
    if (a?.type === 'microsoft') await accounts.refreshProfile(a);
    return accounts.summary();
  });

  on('skins:state', () => skins.state());
  on('skins:add', (data) => skins.add(data));
  on('skins:addFromName', (name) => skins.importFromName(name));
  on('skins:update', (id, patch) => skins.update(id, patch));
  on('skins:remove', (id) => skins.remove(id));
  const premium = () => accounts.active()?.type === 'microsoft';
  on('skins:apply', async (id) => {
    const r = await skins.apply(id);
    if (premium()) track('skin.change', { message: 'Cambió su skin (Mojang)' });
    return r;
  });
  on('skins:reset', async () => {
    const r = await skins.resetSkin();
    if (premium()) track('skin.reset', { message: 'Volvió a la skin por defecto' });
    return r;
  });
  on('skins:setCape', async (id) => {
    const r = await skins.setCape(id);
    if (premium()) track('cape.change', { message: id ? 'Cambió su capa' : 'Se quitó la capa' });
    return r;
  });
  on('skins:current', () => skins.current().catch(() => null));

  on('instances:list', () => instances.list());
  on('instances:refresh', () => instances.refresh());
  on('instances:get', (id) => instances.get(id));
  on('instances:install', (id) => { instances.install(id).catch(() => {}); return true; });
  on('instances:repair', (id) => { instances.install(id, { repair: true }).catch(() => {}); return true; });
  on('instances:cancel', (id) => { instances.cancel(id); return true; });
  on('instances:play', async (id) => {
    try {
      return await instances.play(id, { version: VERSION });
    } catch (e) {
      if (e?.name !== 'AbortError') track('game.launch_error', { level: 'error', instance: baseId(id), message: `No se pudo iniciar ${instName(id)}: ${e.message}` });
      throw e;
    }
  });
  on('instances:stop', (id) => { instances.stop(id); return true; });
  on('instances:uninstall', async (id, opts) => {
    const r = await instances.uninstall(id, opts);
    track('instance.uninstall', { instance: baseId(id), message: `Desinstaló ${instName(id)}${opts?.keepSaves ? ' (guardó sus mundos)' : ''}` });
    return r;
  });
  on('instances:setOptions', (id, patch) => instances.setOptions(id, patch));
  on('instances:size', (id) => instances.size(id));
  on('instances:log', (id) => instances.logTail(id));

  const needAdmin = (fn) => (...a) => {
    if (!admin.unlocked()) throw Object.assign(new Error('Activa el modo administrador para continuar.'), { code: 'ELOCKED' });
    return fn(...a);
  };
  const needEdit = (fn) => needAdmin(async (id, ...a) => {
    await admin.mustEdit(id);
    return fn(id, ...a);
  });
  on('admin:status', (opts) => admin.status({ fresh: opts?.fresh === true }));
  on('admin:unlock', (key, remember) => admin.unlock(key, remember));
  on('admin:lock', () => admin.lock());
  on('admin:list', needAdmin(() => admin.list()));
  on('admin:create', needAdmin((d) => admin.create(d)));
  on('admin:open', needAdmin((id) => admin.open(id)));
  on('admin:discard', needAdmin((id) => admin.discard(id)));
  on('admin:saveMeta', needEdit((id, meta) => admin.saveMeta(id, meta)));
  on('admin:addFiles', needEdit(async (id, targetDir, folders) => {
    const r = await dialog.showOpenDialog(parentWin(), {
      title: folders ? 'Elegir carpetas' : 'Elegir archivos',
      properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return admin.addLocal(id, r.filePaths, targetDir);
  }));
  on('admin:addPaths', needEdit((id, list, targetDir) => {
    const ok = (Array.isArray(list) ? list : []).filter((p) => admin.granted(p));
    if (!ok.length) throw new Error(`Arrastra los archivos desde ${({ darwin: 'el Finder', linux: 'tu gestor de archivos' })[process.platform] || 'el Explorador de Windows'}.`);
    return admin.addLocal(id, ok, targetDir);
  }));
  on('admin:addModrinth', needEdit((id, ref) => admin.addModrinth(id, ref)));
  on('admin:setPolicy', needEdit((id, p, policy) => admin.setPolicy(id, p, policy)));
  on('admin:mergePick', needEdit((id, p, keys, value) => admin.mergePick(id, p, keys, Boolean(value))));
  on('admin:removeFiles', needEdit((id, list) => admin.removeFiles(id, list)));
  on('admin:restoreFiles', needEdit((id, list) => admin.restoreFiles(id, list)));
  on('admin:setInclude', needEdit((id, name, onOff) => admin.setInclude(id, name, onOff === true)));
  on('admin:workspace', needAdmin((id) => admin.wsStatus(id)));
  on('admin:fileDiff', needAdmin((id, rel) => admin.fileDiff(id, rel)));
  on('admin:sync', needAdmin(async (id) => {
    const r = await admin.sync(id);
    send('instances', await instances.list());
    return r;
  }));
  on('admin:pull', needAdmin(async (id) => {
    const r = await admin.pull(id);
    send('instances', await instances.list());
    return r;
  }));
  on('admin:unsync', needAdmin(async (id) => {
    await admin.unsync(id);
    send('instances', await instances.list());
    return true;
  }));
  on('admin:testCopy', needAdmin(async (id) => {
    const tid = await admin.testCopy(id);
    send('instances', await instances.list());
    return tid;
  }));
  on('admin:openFolder', needAdmin(async (id, sub) => {
    const dir = instances.gameDir(id);
    const target = sub ? path.join(dir, String(sub).replace(/[^a-z0-9_.-]/gi, '')) : dir;
    await fsp.mkdir(target, { recursive: true });
    return shell.openPath(target);
  }));
  on('admin:setMedia', needEdit((id, kind, data) => admin.setMedia(id, kind, data)));
  on('admin:clearMedia', needEdit((id, kind) => admin.clearMedia(id, kind)));
  on('admin:scanFolder', needAdmin(async () => {
    const r = await dialog.showOpenDialog(parentWin(), { title: 'Carpeta de la instancia (CurseForge, Prism, Modrinth, .minecraft…)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    admin.grant(r.filePaths[0]);
    return admin.scanFolder(r.filePaths[0]);
  }));
  on('admin:importFolder', needEdit((id, root, include) => {
    if (!admin.granted(root)) throw new Error('Vuelve a elegir la carpeta.');
    return admin.importFolder(id, root, include);
  }));
  on('admin:modrinthInstances', needAdmin(() => admin.modrinthInstances()));
  on('admin:modrinthIcon', needAdmin((file) => admin.modrinthIcon(file)));
  on('admin:scanPath', needAdmin((dir) => {
    if (!admin.granted(dir)) throw new Error('Vuelve a elegir la instancia.');
    return admin.scanFolder(dir);
  }));
  on('admin:importMrpack', needEdit(async (id) => {
    const r = await dialog.showOpenDialog(parentWin(), { title: 'Modpack de Modrinth', properties: ['openFile'], filters: [{ name: 'Modpack de Modrinth', extensions: ['mrpack'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return admin.importMrpack(id, r.filePaths[0]);
  }));
  on('admin:publish', needEdit(async (id, opts) => {
    const inst = await admin.publish(id, { mergeKeys: opts?.mergeKeys && typeof opts.mergeKeys === 'object' ? opts.mergeKeys : {} });
    instances.refresh().then((l) => send('instances', l));
    return inst;
  }));
  on('admin:updateMeta', needEdit(async (id, meta) => {
    const inst = await admin.updateMeta(id, meta);
    instances.refresh().then((l) => send('instances', l));
    return inst;
  }));
  on('admin:remove', needAdmin(async (id) => {
    await admin.remove(id);
    instances.refresh().then((l) => send('instances', l));
    return true;
  }));
  on('admin:offlineAccounts', needAdmin((q) => admin.offlineAccounts(q)));
  on('admin:releaseNick', needAdmin((n) => admin.releaseNick(n)));
  on('admin:storage', needAdmin((opts) => admin.storage({ fresh: opts?.fresh === true })));
  on('admin:cleanStorage', needAdmin(() => admin.cleanStorage()));
  on('admin:cleanLogs', needAdmin((days) => admin.cleanLogs(days)));
  on('admin:discord', needAdmin(() => admin.discordInfo()));
  on('admin:discordNicks', needAdmin((channels) => admin.discordNicks(channels)));

  on('catalog:mcVersions', async () => {
    const m = await getVersionManifest(dirs);
    return m.versions.map((v) => ({ id: v.id, type: v.type, date: v.releaseTime }));
  });
  on('catalog:loaderVersions', (type, mc) => listLoaderVersions(type, mc));
  on('catalog:loaderGames', async (type) => {
    const s = await supportedGameVersions(type);
    return s ? [...s] : null;
  });
  on('modrinth:search', (q) => modrinth.search(q));
  on('modrinth:versions', (id, q) => modrinth.versions(id, q));

  ipcMain.on('vsl-grant', (event, p) => {
    if (String(event.senderFrame?.url || '').startsWith('vsl://app/') && typeof p === 'string') admin.grant(p);
  });

  ipcMain.handle('vsl', async (event, channel, ...args) => {
    const url = event.senderFrame?.url || '';
    if (!url.startsWith('vsl://app/')) return { ok: false, error: { message: 'Origen no permitido' } };
    const fn = handlers[channel];
    if (!fn) return { ok: false, error: { message: `Acción desconocida: ${channel}` } };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      if (e?.name !== 'AbortError') log.warn(`[${channel}]`, e?.message || e);
      return { ok: false, error: { message: e?.message || String(e), code: e?.code || null, status: e?.status || null } };
    }
  });

  app.on('second-instance', showWindow);
  app.on('before-quit', (e) => {
    if (!quitting && win && !win.isDestroyed() && (instances.busy() || admin.tasks.size)) {
      e.preventDefault();
      showWindow();
      if (!closeAsked) {
        closeAsked = true;
        send('close-requested', { tasks: [...instances.tasks.keys()], admin: admin.tasks.size });
        setTimeout(() => { closeAsked = false; }, 800);
      }
      return;
    }
    quitting = true;
    saveWindowState();
    discord.disconnect();
  });
  app.on('window-all-closed', () => {
    if (quitting || !instances.anyRunning()) app.quit();
  });

  app.whenReady().then(async () => {
    log.info(`${APP_NAME} ${VERSION} — datos en ${dataRoot}`);
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: APP_NAME, submenu: [
          { role: 'about', label: `Acerca de ${APP_NAME}` }, { type: 'separator' },
          { role: 'services', label: 'Servicios' }, { type: 'separator' },
          { role: 'hide', label: `Ocultar ${APP_NAME}` }, { role: 'hideOthers', label: 'Ocultar otros' }, { role: 'unhide', label: 'Mostrar todo' }, { type: 'separator' },
          { role: 'quit', label: `Salir de ${APP_NAME}` },
        ] },
        { label: 'Edición', submenu: [
          { role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' },
          { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' },
        ] },
        { label: 'Ventana', role: 'window', submenu: [
          { role: 'minimize', label: 'Minimizar' }, { role: 'zoom', label: 'Zoom' }, { type: 'separator' },
          { role: 'close', label: 'Cerrar ventana' }, { role: 'front', label: 'Traer todo al frente' },
        ] },
      ]));
    }
    paths.ensureDataRoot(dataRoot);
    paths.registerDataDir(dataRoot);
    media.localRoots.set('admin', path.join(dirs.admin, 'media'));

    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_, perm, cb) => cb(perm === 'clipboard-sanitized-write'));
    ses.setPermissionCheckHandler((_, perm) => perm === 'clipboard-sanitized-write');

    const CSP = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: vsl-media: https://cdn.modrinth.com",
      "media-src 'self' vsl-media: blob:",
      "font-src 'self'",
      "connect-src 'self' data:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };
    protocol.handle('vsl', async (req) => {
      const u = new URL(req.url);
      if (u.host !== 'app') return new Response('not found', { status: 404 });
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(RENDERER, rel);
      if (!file.startsWith(RENDERER + path.sep)) return new Response('forbidden', { status: 403 });
      try {
        const body = await fsp.readFile(file);
        const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
        if (file.endsWith('.html')) headers['Content-Security-Policy'] = CSP;
        return new Response(body, { headers });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });
    protocol.handle('vsl-media', (req) => media.handle(req));

    accounts.load();
    admin.load();
    await backend.init();
    accounts.enrollDevices().catch((e) => log.warn('No se pudo vincular este PC a tus nicks:', e.message));
    await instances.loadCache();
    instances.recoverStaged().catch((e) => log.warn('No se pudieron revisar los archivos ocultos:', e.message));
    updater.init();
    await telemetry.init();
    track('launcher.start', {
      message: `Abrió el launcher ${VERSION}`,
      data: { os: `${os.version?.() || os.type()} (${os.release()})`, arch: process.arch, ramMB: totalMB, cpus: os.cpus().length, maxMemoryMB: settings.get().memory.max },
    });
    await createWindow();
    app.on('activate', showWindow);
    updatePresence();
    backend.refreshRemote().then(() => { updatePresence(); return instances.refresh(); }).then((l) => send('instances', l)).catch(() => {});
    if (TEST_SCRIPT) {
      const run = require(path.resolve(TEST_SCRIPT));
      const ctx = {
        win, log, instances, accounts, admin, settings, updater,
        exec: (js) => win.webContents.executeJavaScript(js, true),
        capture: async (file) => { const img = await win.webContents.capturePage(); fs.writeFileSync(file, img.toPNG()); },
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      };
      Promise.resolve().then(() => run(ctx)).catch((e) => log.error('[test]', e))
        .finally(() => { if (!process.argv.includes('--keep')) { quitting = true; app.quit(); } });
    }
    const t = setInterval(() => {
      if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) instances.refresh().then((l) => send('instances', l)).catch(() => {});
    }, 10 * 60 * 1000);
    t.unref?.();
  });

  let crashReports = 0;
  process.on('uncaughtException', (e) => {
    log.error('Error no controlado:', e);
    if (++crashReports <= 5) track('launcher.error', { level: 'error', message: `Error interno: ${e?.message || e}`, data: { stack: String(e?.stack || '').split('\n').slice(0, 6) } });
  });
  process.on('unhandledRejection', (e) => log.warn('Promesa sin controlar:', e));
}
