'use strict';

const { EventEmitter } = require('node:events');
const { app } = require('electron');

const MANUAL = process.platform === 'darwin' || (process.platform === 'linux' && !process.env.APPIMAGE);

class Updater extends EventEmitter {
  constructor({ log, settings }) {
    super();
    this.log = log;
    this.settings = settings;
    this.state = { status: 'idle', version: null, percent: 0, manual: MANUAL };
    this.au = null;
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
    au.on('update-available', (i) => this.set({ status: MANUAL ? 'available' : 'downloading', version: i.version, percent: 0 }));
    au.on('update-not-available', () => this.set({ status: 'latest' }));
    au.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    au.on('update-downloaded', (i) => this.set({ status: 'ready', version: i.version, percent: 100 }));
    au.on('error', (e) => this.set({ status: 'error', error: String(e?.message || e).split(/\r?\n/)[0].slice(0, 200) }));
    if (this.settings.get().autoUpdate) {
      setTimeout(() => this.check(), 8000);
      this.timer = setInterval(() => this.check(), 6 * 60 * 60 * 1000);
      this.timer.unref?.();
    }
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  async check() {
    if (!this.au) return { ...this.state, status: app.isPackaged ? 'unavailable' : 'dev' };
    if (['downloading', 'ready', 'available'].includes(this.state.status)) return this.state;
    try { await this.au.checkForUpdates(); } catch (e) { this.set({ status: 'error', error: e.message }); }
    return this.state;
  }

  canInstall() { return !MANUAL && Boolean(this.au) && this.state.status === 'ready'; }

  install() {
    if (this.canInstall()) this.au.quitAndInstall(true, true);
  }
}

module.exports = { Updater };
