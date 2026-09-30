'use strict';

const { EventEmitter } = require('node:events');
const { app } = require('electron');

const MANUAL = process.platform === 'darwin' || (process.platform === 'linux' && !process.env.APPIMAGE);
const RETRY_MS = 30 * 60 * 1000;
const CHECK_MS = 5 * 60 * 1000;
const FOCUS_MS = 2 * 60 * 1000;
const NOT_READY_MS = 90 * 1000;
const NOT_READY = new Set(['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ERR_UPDATER_ASSET_NOT_FOUND', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS']);

class Updater extends EventEmitter {
  constructor({ log, settings }) {
    super();
    this.log = log;
    this.settings = settings;
    this.state = { status: 'idle', version: null, percent: 0, manual: MANUAL, onStart: false, skipped: false, installing: false };
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
    au.autoInstallOnAppQuit = !MANUAL;
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

  install() {
    if (this.canInstall()) this.au.quitAndInstall(true, true);
  }
}

module.exports = { Updater };
