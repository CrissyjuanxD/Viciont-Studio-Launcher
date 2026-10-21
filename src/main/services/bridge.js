'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { TaskProgress } = require('../util/progress');
const { baseId } = require('./instances');

const BODY_MAX = 16 * 1024;

// Canal privado entre el launcher y el mod ViciontRP mientras se juega: solo escucha en 127.0.0.1
// y cada partida tiene su propia clave (se le pasa al juego al abrirlo).
class Bridge extends EventEmitter {
  constructor({ instances, accounts, backend, log, version }) {
    super();
    this.instances = instances;
    this.accounts = accounts;
    this.backend = backend;
    this.log = log;
    this.version = version;
    this.sessions = new Map();
    this.server = null;
    this.port = 0;
    this.starting = null;
  }

  start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
        this.log.warn('Error en el canal del mod ViciontRP:', e.message);
        send(res, 500, { ok: false, error: e.message });
      }));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        server.unref?.();
        resolve(this.port);
      });
    });
    this.starting.catch(() => { this.starting = null; });
    return this.starting;
  }

  async open(id) {
    try {
      await this.start();
    } catch (e) {
      this.log.warn('No se pudo abrir el canal del mod ViciontRP:', e.message);
      return null;
    }
    this.close(id);
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, { id, state: 'idle' });
    return { VICIONT_BRIDGE: `http://127.0.0.1:${this.port}`, VICIONT_BRIDGE_TOKEN: token };
  }

  close(id) {
    for (const [token, s] of this.sessions) {
      if (s.id !== id) continue;
      s.ctrl?.abort();
      this.sessions.delete(token);
    }
  }

  async handle(req, res) {
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${this.port}`) return send(res, 403, { ok: false, error: 'forbidden' });
    const m = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || '');
    const s = m ? this.sessions.get(m[1]) : null;
    if (!s) return send(res, 401, { ok: false, error: 'unauthorized' });
    const body = req.method === 'POST' ? await readBody(req) : null;
    const route = `${req.method} ${req.url.split('?')[0]}`;
    if (route === 'GET /hello') {
      const st = await this.instances.readState(s.id);
      return send(res, 200, { ok: true, launcher: this.version, instance: baseId(s.id), assets: await this.instances.installedAssets(s.id), version: st?.installedVersion || 0 });
    }
    if (route === 'POST /ticket') return send(res, 200, { ok: true, ticket: await this.ticket(s) });
    if (route === 'POST /assets/prepare') {
      this.prepare(s, typeof body?.assets === 'string' ? body.assets : '');
      return send(res, 200, { ok: true, state: s.state });
    }
    if (route === 'GET /assets/status') {
      return send(res, 200, {
        ok: true, state: s.state, done: s.progress?.done || 0, total: s.progress?.total || 0, files: s.progress?.filesTotal || 0, filesDone: s.progress?.filesDone || 0, error: s.error || null,
        replace: s.state === 'ready', enable: s.enable || [],
      });
    }
    if (route === 'POST /assets/apply') {
      if (s.state !== 'ready' || !s.job) return send(res, 409, { ok: false, error: 'No hay assets preparados' });
      const job = s.job;
      s.job = null;
      s.state = 'idle';
      const r = await this.instances.hotApply(job);
      this.emit('applied', { id: s.id, ...r });
      return send(res, 200, { ok: true, ...r });
    }
    if (route === 'POST /assets/cancel') {
      s.ctrl?.abort();
      s.state = 'idle';
      s.job = null;
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: 'not_found' });
  }

  async ticket(s) {
    if (s.ticket && s.ticketExp - Date.now() > 60 * 60 * 1000) return s.ticket;
    const token = await this.accounts.session();
    const r = await this.backend.call('/v1/play/ticket', { method: 'POST', token, json: { instance: baseId(s.id) }, timeout: 15000, retries: 1 });
    s.ticket = r.ticket;
    s.ticketExp = Number(r.expiresAt) || Date.now() + 12 * 60 * 60 * 1000;
    return s.ticket;
  }

  prepare(s, target) {
    if (['checking', 'downloading', 'ready'].includes(s.state)) return;
    const ctrl = new AbortController();
    const progress = new TaskProgress(s.id, { kind: 'assets' });
    Object.assign(s, { state: 'checking', ctrl, progress, error: null, job: null, enable: [] });
    this.log.info(`El mod ViciontRP pide los assets nuevos de ${s.id}${target ? ` (${target.slice(0, 12)})` : ''}`);
    const watch = setInterval(() => { if (s.ctrl === ctrl && s.state === 'checking' && progress.total > 0) s.state = 'downloading'; }, 200);
    this.instances.hotPrepare(s.id, { signal: ctrl.signal, progress }).then((r) => {
      if (s.ctrl !== ctrl) return;
      if (r.nothing) s.state = 'nothing';
      else Object.assign(s, { state: 'ready', job: r.job, enable: r.enable || [] });
    }).catch((e) => {
      if (s.ctrl !== ctrl) return;
      s.state = e.name === 'AbortError' ? 'idle' : 'failed';
      s.error = e.message;
      if (e.name !== 'AbortError') this.log.warn(`No se pudieron preparar los assets de ${s.id}:`, e.message);
    }).finally(() => {
      clearInterval(watch);
      progress.stop();
    });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) { reject(new Error('Petición demasiado grande')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

module.exports = { Bridge };
