'use strict';
// Discord Rich Presence: en tu perfil de Discord se ve que usas Viciont Studio
// Launcher, qué instancia estás mirando, qué estás descargando y a qué juegas.
// Habla directamente con la app de Discord del PC (tubería local discord-ipc-N):
// no hace falta cuenta ni nada en internet, y si Discord no está abierto no pasa nada.

const net = require('node:net');
const crypto = require('node:crypto');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const RETRY_MS = 30 * 1000;
const MIN_GAP_MS = 5 * 1000; // Discord acepta ~5 cambios cada 20 s
const LOGO = 'https://raw.githubusercontent.com/CrissyjuanxD/Viciont-Studio-Launcher/main/docs/discord-logo.png';
const DOWNLOAD = 'https://github.com/CrissyjuanxD/Viciont-Studio-Launcher/releases/latest';

function frame(op, payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(data.length, 4);
  return Buffer.concat([head, data]);
}

class DiscordPresence {
  constructor({ log, version }) {
    this.log = log;
    this.version = version;
    this.clientId = '';
    this.enabled = false;
    this.sock = null;
    this.ready = false;
    this.buf = Buffer.alloc(0);
    this.retryTimer = null;
    this.sendTimer = null;
    this.lastSent = 0;
    this.wanted = null; // actividad que se quiere mostrar
    this.sentKey = '';
  }

  configure({ enabled, clientId }) {
    const id = /^\d{15,25}$/.test(String(clientId || '')) ? String(clientId) : '';
    const on = Boolean(enabled && id);
    const changed = id !== this.clientId || on !== this.enabled;
    this.clientId = id;
    this.enabled = on;
    if (!changed) return;
    this.disconnect();
    if (on) this.connect();
  }

  // ---------- Conexión con la app de Discord ----------
  connect(index = 0) {
    if (!this.enabled || this.sock) return;
    if (index > 9) { this.scheduleRetry(); return; }
    const pipe = process.platform === 'win32' ? `\\\\?\\pipe\\discord-ipc-${index}` : `${process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp'}/discord-ipc-${index}`;
    const sock = net.createConnection(pipe);
    let opened = false;
    sock.once('connect', () => {
      opened = true;
      this.sock = sock;
      this.buf = Buffer.alloc(0);
      sock.write(frame(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
    });
    sock.on('data', (chunk) => this.onData(chunk));
    sock.on('error', () => {
      if (!opened) { sock.destroy(); this.connect(index + 1); }
    });
    sock.on('close', () => {
      if (!opened) return;
      if (this.sock === sock) { this.sock = null; this.ready = false; this.sentKey = ''; }
      this.scheduleRetry();
    });
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (!this.enabled) return;
    this.retryTimer = setTimeout(() => this.connect(), RETRY_MS);
    this.retryTimer.unref?.();
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.sendTimer);
    const s = this.sock;
    this.sock = null;
    this.ready = false;
    this.sentKey = '';
    if (s) {
      try { s.write(frame(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: crypto.randomUUID() })); } catch { /* ya cerrada */ }
      s.end();
      setTimeout(() => s.destroy(), 300).unref?.();
    }
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (len < 0 || len > 1024 * 1024) { this.sock?.destroy(); return; }
      if (this.buf.length < 8 + len) return;
      let msg = null;
      try { msg = JSON.parse(this.buf.subarray(8, 8 + len).toString('utf8')); } catch { msg = null; }
      this.buf = this.buf.subarray(8 + len);
      if (op === OP.PING) this.sock?.write(frame(OP.PONG, msg || {}));
      else if (op === OP.CLOSE) {
        this.log.warn('[discord] Discord cerró la conexión:', msg?.message || msg?.code || '');
        this.sock?.destroy();
      } else if (op === OP.FRAME && msg?.evt === 'READY') {
        this.ready = true;
        this.log.info(`[discord] Conectado (${msg.data?.user?.username || 'usuario'})`);
        this.flush(true);
      } else if (op === OP.FRAME && msg?.evt === 'ERROR') {
        this.log.warn('[discord]', msg.data?.message || 'error');
      }
    }
  }

  // ---------- Actividad ----------
  set(activity) {
    this.wanted = activity;
    this.flush();
  }

  flush(force = false) {
    if (!this.ready || !this.sock) return;
    const key = JSON.stringify(this.wanted);
    if (!force && key === this.sentKey) return;
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - this.lastSent));
    clearTimeout(this.sendTimer);
    if (wait > 0 && !force) {
      this.sendTimer = setTimeout(() => this.flush(), wait);
      return;
    }
    this.lastSent = Date.now();
    this.sentKey = key;
    this.sock.write(frame(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: this.wanted }, nonce: crypto.randomUUID() }));
  }

  // Construye la actividad a partir de lo que pasa en el launcher.
  static build({ version, view, instance, playing, downloading, showPrivate }) {
    const base = {
      assets: { large_image: LOGO, large_text: `Viciont Studio Launcher ${version}` },
      buttons: [{ label: 'Descargar el launcher', url: DOWNLOAD }],
    };
    const label = (inst) => (inst.visibility === 'private' && !showPrivate ? 'una instancia privada' : inst.name);
    const detail = (inst) => {
      if (inst.visibility === 'private' && !showPrivate) return 'Viciont Studios';
      const loader = inst.loader?.type && inst.loader.type !== 'vanilla' ? ` · ${inst.loaderName || inst.loader.type}` : '';
      return inst.mc ? `Minecraft ${inst.mc}${loader}` : 'Viciont Studios';
    };
    const withIcon = (inst, a) => {
      if (inst.iconUrl && (inst.visibility !== 'private' || showPrivate)) {
        a.assets = { large_image: inst.iconUrl, large_text: inst.name, small_image: LOGO, small_text: `Viciont Studio Launcher ${version}` };
      }
      return a;
    };
    if (playing) {
      return withIcon(playing, { ...base, details: `Jugando en ${label(playing)}`.slice(0, 128), state: detail(playing).slice(0, 128), timestamps: { start: playing.since } });
    }
    if (downloading) {
      return withIcon(downloading, { ...base, details: `Descargando ${label(downloading)}`.slice(0, 128), state: downloading.percent != null ? `${Math.floor(downloading.percent)} %` : 'Preparando…' });
    }
    if (view === 'instance' && instance) return withIcon(instance, { ...base, details: `Viendo ${label(instance)}`.slice(0, 128), state: detail(instance).slice(0, 128) });
    if (view === 'skins') return { ...base, details: 'Cambiando de skin', state: 'En el launcher' };
    if (view === 'login') return { ...base, details: 'Iniciando sesión', state: 'En el launcher' };
    return { ...base, details: 'En el inicio', state: 'Eligiendo instancia' };
  }
}

module.exports = { DiscordPresence };
