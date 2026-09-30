'use strict';

const { EventEmitter } = require('node:events');
const { app } = require('electron');

const MANUAL = process.platform === 'darwin' || (process.platform === 'linux' && !process.env.APPIMAGE);
const RETRY_MS = 30 * 60 * 1000;

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
    au.on('error', (e) => { this.firstCheck = false; this.set({ status: 'error', error: String(e?.message || e).split(/\r?\n/)[0].slice(0, 200) }); });
    if (this.settings.get().autoUpdate) {
      this.firstCheck = true;
      this.check();
      this.timer = setInterval(() => this.check(), 6 * 60 * 60 * 1000);
      this.timer.unref?.();
    }
  }

  startAllowed(version) {
    const t = this.settings.get().updateTried;
    return !(t && t.version === version && Date.now() - t.at < RETRY_MS);
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  async check() {
    if (!this.au) return { ...this.state, status: app.isPackaged ? 'unavailable' : 'dev' };
    if (['downloading', 'ready', 'available'].includes(this.state.status)) return this.state;
    try { await this.au.checkForUpdates(); } catch (e) { this.firstCheck = false; this.set({ status: 'error', error: e.message }); }
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
