'use strict';
// Registro de actividad para el panel del estudio: inicios de sesión, cambios de
// skin, descargas, partidas y errores. Sirve para ayudar a los jugadores cuando
// algo falla. Se envía en lotes al servidor del estudio con la sesión del jugador.
//
// Nunca se envían contraseñas, tokens, códigos de recuperación, archivos ni la IP;
// las rutas del PC se acortan (C:\Users\<usuario> → ~).

const os = require('node:os');
const { readJson, writeJsonAtomic } = require('../util/fsx');
const { configFile } = require('../core/paths');
const { redact } = require('../core/log');

const FILE = configFile('activity-queue.json');
const MAX_QUEUE = 300;
const FLUSH_MS = 60 * 1000;
const HEARTBEAT_MS = 15 * 60 * 1000;
const URGENT = new Set(['game.start', 'game.exit', 'game.crash', 'auth.login', 'auth.logout']);
const TYPE_RE = /^(launcher|auth|skin|cape|instance|game|admin)\.[a-z_]{2,24}$/;
const SECRET_KEY = /token|secret|password|recovery|claim|authorization|cookie|key/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOME_RES = [...new Set([os.homedir(), os.homedir().replace(/\\/g, '/')])].filter((h) => h.length > 3).map((h) => new RegExp(escapeRe(h), 'gi'));
const USER = os.userInfo().username;

function cleanText(t, max = 800) {
  let s = String(t);
  for (const re of HOME_RES) s = s.replace(re, '~');
  if (USER && USER.length > 2) s = s.replace(new RegExp(`\\\\Users\\\\${escapeRe(USER)}`, 'gi'), '\\Users\\~');
  return redact(s).slice(0, max);
}

function clean(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return cleanText(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => clean(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 30)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = clean(x, depth + 1);
    }
    return out;
  }
  return null;
}

class Telemetry {
  constructor({ accounts, backend, log, version }) {
    this.accounts = accounts;
    this.backend = backend;
    this.log = log;
    this.version = version;
    this.queue = [];
    this.flushing = null;
    this.saveTimer = null;
    this.soonTimer = null;
    this.playing = new Map(); // instancia → uuid de la cuenta
  }

  async init() {
    const q = await readJson(FILE, []);
    this.queue = (Array.isArray(q) ? q : []).filter((e) => e && TYPE_RE.test(e.type || '')).slice(-MAX_QUEUE);
    setInterval(() => this.flush(), FLUSH_MS).unref?.();
    setInterval(() => this.heartbeat(), HEARTBEAT_MS).unref?.();
    setTimeout(() => this.flush(), 8000).unref?.();
  }

  /**
   * type: "grupo.evento" (p. ej. game.start). info: { level, message, instance, data, uuid }
   * uuid: cuenta a la que pertenece (por defecto, la activa; si no hay ninguna, la próxima que entre).
   */
  track(type, { level = 'info', message, instance, data, uuid } = {}) {
    if (!TYPE_RE.test(type)) return;
    const e = {
      ts: Date.now(),
      type,
      level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
      uuid: uuid || this.accounts.active()?.uuid || null,
    };
    if (message) e.message = cleanText(message, 500);
    if (instance) e.instance = String(instance).slice(0, 48);
    if (data) e.data = clean(data);
    this.queue.push(e);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    this.saveSoon();
    if (URGENT.has(type) || e.level === 'error') this.flushSoon();
  }

  gameStarted(id) {
    const uuid = this.accounts.active()?.uuid || null;
    this.playing.set(id, uuid);
    return uuid;
  }

  gameStopped(id) {
    const uuid = this.playing.get(id) ?? null;
    this.playing.delete(id);
    return uuid;
  }

  heartbeat() {
    for (const [id, uuid] of this.playing) this.track('game.heartbeat', { instance: id, uuid });
  }

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => writeJsonAtomic(FILE, this.queue).catch(() => {}), 1500);
  }

  flushSoon() {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => this.flush(), 1500);
  }

  // Envía ya (con un límite de tiempo), p. ej. antes de cerrar sesión.
  async flushNow(ms = 4000) {
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, ms))]);
  }

  flush() {
    if (!this.flushing) this.flushing = this._flush().catch((e) => this.log.debug('No se pudo enviar el registro de actividad:', e.message)).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async _flush() {
    if (!this.queue.length || !this.backend.configured()) return;
    const active = this.accounts.active();
    const groups = new Map();
    const drop = new Set();
    for (const e of this.queue) {
      let uuid = e.uuid;
      if (uuid && !this.accounts.find(uuid)) { drop.add(e); continue; } // la cuenta ya no existe en este PC
      if (!uuid) uuid = active?.uuid;
      if (!uuid) continue; // aún no hay sesión: se envía cuando alguien entre
      if (!groups.has(uuid)) groups.set(uuid, []);
      groups.get(uuid).push(e);
    }
    if (drop.size) this.queue = this.queue.filter((e) => !drop.has(e));
    for (const [uuid, events] of groups) {
      const acc = this.accounts.find(uuid);
      if (!acc || acc.needsLogin) continue;
      let token;
      try { token = await this.accounts.session(acc); } catch { continue; }
      if (!token) continue;
      for (let i = 0; i < events.length; i += 100) {
        const batch = events.slice(i, i + 100);
        try {
          await this.backend.call('/v1/logs', {
            method: 'POST', token, timeout: 15000, retries: 0,
            json: { version: this.version, events: batch.map(({ uuid: _, ...rest }) => rest) },
          });
        } catch (e) {
          if (e.status === 401) this.accounts.invalidateSession(acc);
          if (e.status === 400 || e.status === 413) { const bad = new Set(batch); this.queue = this.queue.filter((x) => !bad.has(x)); }
          break;
        }
        const sent = new Set(batch);
        this.queue = this.queue.filter((x) => !sent.has(x));
      }
    }
    this.saveSoon();
  }
}

module.exports = { Telemetry, cleanText };
