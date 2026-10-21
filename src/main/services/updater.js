'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { app } = require('electron');

const MANUAL = process.platform === 'darwin' || (process.platform === 'linux' && !process.env.APPIMAGE);
const RETRY_MS = 30 * 60 * 1000;
const CHECK_MS = 5 * 60 * 1000;
const FOCUS_MS = 2 * 60 * 1000;
const NOT_READY_MS = 90 * 1000;
const ELEVATE_WAIT_MS = 120 * 1000;
const FAILED_MS = 24 * 60 * 60 * 1000;
const WIN = process.platform === 'win32';
const NOT_READY = new Set(['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ERR_UPDATER_ASSET_NOT_FOUND', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS']);

class Updater extends EventEmitter {
  constructor({ log, settings }) {
    super();
    this.log = log;
    this.version = app.getVersion();
    this.settings = settings;
    this.state = { status: 'idle', version: null, percent: 0, manual: MANUAL, onStart: false, skipped: false, installing: false, blocked: null, failed: null };
    this.au = null;
    this.firstCheck = false;
  }

  init() {
    if (!app.isPackaged) return;
    try {
      ({ autoUpdater: this.au } = require('electron-updater'));
    } catch (e) {
      this.log.warn('Actualizador no disponible:', e.message);
      return;
    }
    const au = this.au;
    au.autoDownload = !MANUAL;
    au.autoInstallOnAppQuit = !MANUAL && !WIN;
    au.allowPrerelease = false;
    const short = (m) => String(m?.message || m).split(/\r?\n/)[0].slice(0, 240);
    au.logger = { info: (m) => this.log.debug(`[updater] ${short(m)}`), warn: (m) => this.log.warn(`[updater] ${short(m)}`), error: (m) => this.log.warn(`[updater] ${short(m)}`), debug: () => {} };
    au.on('checking-for-update', () => this.set({ status: 'checking' }));
    au.on('update-available', (i) => {
      const onStart = this.firstCheck && this.startAllowed(i.version);
      this.firstCheck = false;
      this.set({ status: MANUAL ? 'available' : 'downloading', version: i.version, percent: 0, onStart });
    });
    au.on('update-not-available', () => { this.firstCheck = false; this.set({ status: 'latest' }); });
    au.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent || 0), transferred: p.transferred || 0, total: p.total || 0, bps: p.bytesPerSecond || 0 }));
    au.on('update-downloaded', (i) => this.set({ status: 'ready', version: i.version, percent: 100 }));
    au.on('error', (e) => this.failed(e));
    const t = this.settings.get().updateTried;
    if (t?.version && t.version !== this.version && Date.now() - t.at < FAILED_MS) this.state.failed = t.version;
    this.auto = this.settings.get().autoUpdate;
    this.settings.on('change', (s) => {
      if (s.autoUpdate === this.auto) return;
      this.auto = s.autoUpdate;
      this.schedule();
    });
    this.schedule();
    if (this.auto) {
      this.firstCheck = true;
      this.check();
    }
  }

  schedule() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.au || !this.auto) return;
    this.timer = setInterval(() => this.check({ auto: true }), CHECK_MS);
    this.timer.unref?.();
  }

  checkSoon() {
    if (this.auto && Date.now() - (this.lastCheck || 0) > FOCUS_MS) this.check({ auto: true });
  }

  failed(e) {
    this.firstCheck = false;
    if (NOT_READY.has(e?.code)) {
      if (this.state.status === 'checking') this.set({ status: 'latest' });
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.check({ auto: true }), NOT_READY_MS);
      this.retry.unref?.();
      return;
    }
    this.set({ status: 'error', error: String(e?.message || e).split(/\r?\n/)[0].slice(0, 200) });
  }

  startAllowed(version) {
    const t = this.settings.get().updateTried;
    return !(t && t.version === version && Date.now() - t.at < RETRY_MS);
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  async check({ auto = false } = {}) {
    if (!this.au) return { ...this.state, status: app.isPackaged ? 'unavailable' : 'dev' };
    if (['downloading', 'ready', 'available'].includes(this.state.status)) return this.state;
    if (auto && this.canAutoCheck?.() === false) return this.state;
    this.lastCheck = Date.now();
    try { await this.au.checkForUpdates(); } catch (e) { this.failed(e); }
    return this.state;
  }

  skipStart() {
    if (this.state.onStart && !this.state.installing) this.set({ skipped: true });
    return this.state;
  }

  canInstall() { return !MANUAL && Boolean(this.au) && this.state.status === 'ready'; }

  installer(forceRun) {
    const helper = this.au.downloadedUpdateHelper;
    const file = this.au.installerPath;
    const info = helper?.downloadedFileInfo;
    if (!file || !info) return null;
    const args = ['--updated', '/S'];
    if (forceRun) args.push('--force-run');
    if (helper.packageFile) args.push(`--package-file=${helper.packageFile}`);
    return { file, args, admin: Boolean(info.isAdminRightsRequired) };
  }

  async elevated(it) {
    this.log.info(`El instalador de la ${this.state.version} pide permisos de administrador`);
    this.set({ elevating: true });
    try {
      const code = await run(path.join(process.resourcesPath, 'elevate.exe'), [it.file, ...it.args], ELEVATE_WAIT_MS);
      if (code) throw Object.assign(new Error('No se dieron los permisos de administrador'), { code: 'EDENIED' });
    } finally {
      this.set({ elevating: false });
    }
  }

  async launch(forceRun) {
    const it = this.installer(forceRun);
    if (!it) throw Object.assign(new Error('No se encontró el instalador descargado'), { code: 'ENOENT' });
    this.log.info(`Abriendo el instalador de la ${this.state.version}`);
    if (it.admin) return this.elevated(it);
    try {
      await run(it.file, it.args);
    } catch (e) {
      if (e.code !== 'EACCES') throw e;
      await this.elevated(it);
    }
  }

  async install() {
    if (!this.canInstall()) return false;
    if (!WIN) {
      this.au.quitAndInstall(true, true);
      return true;
    }
    try {
      await this.launch(true);
    } catch (e) {
      const why = e.code === 'EDENIED' ? 'denied' : 'blocked';
      this.log.warn(`No se pudo abrir el instalador de la ${this.state.version}: ${e.code || ''} ${e.message}`.trim());
      this.set({ installing: false, skipped: true, blocked: { version: this.state.version, why, code: e.code || null, at: Date.now() } });
      return false;
    }
    this.launched = true;
    setImmediate(() => app.quit());
    return true;
  }

  installOnQuit() {
    if (!WIN || this.launched || !this.canInstall() || this.state.blocked?.version === this.state.version) return null;
    const it = this.installer(false);
    if (!it || it.admin) return null;
    this.launched = true;
    this.log.info(`Instalando la ${this.state.version} al cerrar el launcher`);
    return run(it.file, it.args).catch((e) => this.log.warn(`No se pudo instalar la ${this.state.version} al cerrar: ${e.code || e.message}`));
  }
}

function run(cmd, args, waitExit = 0) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (e) {
      reject(e);
      return;
    }
    p.once('error', reject);
    p.once('spawn', () => {
      if (!waitExit) {
        p.unref();
        resolve(0);
        return;
      }
      const timer = setTimeout(() => { p.unref(); resolve(0); }, waitExit);
      p.once('exit', (code) => { clearTimeout(timer); resolve(code || 0); });
    });
  });
}

module.exports = { Updater };
