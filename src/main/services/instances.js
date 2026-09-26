'use strict';
// Instancias para los jugadores: lista (según permisos), instalación, actualización,
// reparación, arranque del juego y desinstalación.
//
// Seguridad ante cierres: antes de tocar una instancia se escribe un "diario"
// (.vsl/journal.json). Cada archivo se descarga a .part y solo se renombra cuando
// su SHA-1 es correcto. Si el launcher se cierra a medias, el diario sigue ahí y la
// próxima vez se verifica todo y se continúa donde se quedó.

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { EventEmitter } = require('node:events');
const { readJson, writeJsonAtomic, exists, statOrNull, hashFile, rmrf, safeJoin, normalizeRel, ensureDir, dirSize } = require('../util/fsx');
const { downloadAll, pool } = require('../util/downloader');
const { TaskProgress } = require('../util/progress');
const { planGame } = require('../game/install');
const { launchGame } = require('../game/launch');
const csl = require('./csl');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;

class Instances extends EventEmitter {
  constructor({ dirs, settings, backend, accounts, log, configRoot }) {
    super();
    this.dirs = dirs;
    this.settings = settings;
    this.backend = backend;
    this.accounts = accounts;
    this.log = log;
    this.cacheFile = path.join(configRoot, 'instances-cache.json');
    this.remote = new Map();
    this.remoteError = null;
    this.remoteAt = 0;
    this.tasks = new Map(); // id → { ctrl, progress, promise, kind }
    this.running = new Map(); // id → GameProcess
  }

  setDirs(dirs) { this.dirs = dirs; }

  gameDir(id) {
    if (!ID_RE.test(id)) throw new Error('Identificador de instancia no válido');
    return path.join(this.dirs.instances, id);
  }
  stateFile(id) { return path.join(this.gameDir(id), '.vsl', 'state.json'); }
  journalFile(id) { return path.join(this.gameDir(id), '.vsl', 'journal.json'); }

  async readState(id) { return readJson(this.stateFile(id)); }
  async writeState(id, st) { await writeJsonAtomic(this.stateFile(id), st); }

  // ---------- Lista ----------
  async loadCache() {
    const c = await readJson(this.cacheFile, null);
    if (c?.list) for (const s of c.list) this.remote.set(s.id, s);
  }

  async refresh() {
    if (!this.backend.configured()) {
      this.remoteError = 'ENOBACKEND';
      return this.list();
    }
    try {
      const token = await this.accounts.session().catch((e) => {
        this.log.warn('Sin sesión en el servidor:', e.message);
        return null;
      });
      const r = await this.backend.call('/v1/instances', { token, timeout: 15000 });
      this.remote = new Map((r.instances || []).filter((s) => ID_RE.test(s.id)).map((s) => [s.id, s]));
      this.remoteError = null;
      this.remoteAt = Date.now();
      await writeJsonAtomic(this.cacheFile, { at: this.remoteAt, list: [...this.remote.values()] });
    } catch (e) {
      this.remoteError = e.code === 'ENETWORK' || e.code === 'ETIMEDOUT' ? 'EOFFLINE' : (e.code || 'EERROR');
      this.log.warn('No se pudo actualizar la lista de instancias:', e.message);
    }
    return this.list();
  }

  async localIds() {
    let entries = [];
    try { entries = await fsp.readdir(this.dirs.instances, { withFileTypes: true }); } catch { return []; }
    const ids = [];
    for (const e of entries) {
      if (e.isDirectory() && ID_RE.test(e.name) && (await exists(path.join(this.dirs.instances, e.name, '.vsl', 'state.json')))) ids.push(e.name);
    }
    return ids;
  }

  async describe(id, remote) {
    const st = await this.readState(id);
    const journal = await readJson(this.journalFile(id));
    const summary = remote || st?.summary || null;
    if (!summary) return null;
    const task = this.tasks.get(id);
    let status = 'not-installed';
    if (st?.installedVersion) status = remote && remote.version > st.installedVersion ? 'update' : 'installed';
    if (journal) status = st?.installedVersion ? 'update' : 'not-installed';
    if (task) status = task.kind === 'launch' ? 'launching' : 'installing';
    if (this.running.has(id)) status = 'running';
    return {
      ...summary,
      available: Boolean(remote),
      installed: Boolean(st?.installedVersion),
      installedVersion: st?.installedVersion || null,
      interrupted: Boolean(journal),
      status,
      lastPlayed: st?.lastPlayed || null,
      playTime: st?.playTime || 0,
      options: st?.options || {},
      progress: task?.progress?.snapshot() || null,
    };
  }

  async list() {
    const ids = new Set([...this.remote.keys(), ...(await this.localIds())]);
    const out = [];
    for (const id of ids) {
      const d = await this.describe(id, this.remote.get(id));
      if (d) out.push(d);
    }
    out.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || (b.updatedAt || 0) - (a.updatedAt || 0));
    return { instances: out, error: this.remoteError, configured: this.backend.configured(), at: this.remoteAt };
  }

  async get(id) {
    return this.describe(id, this.remote.get(id));
  }

  emitChange(id) {
    this.get(id).then((d) => this.emit('instance', d)).catch(() => {});
  }

  // ---------- Instalar / actualizar / reparar ----------
  async fetchManifest(id) {
    const token = await this.accounts.session().catch(() => null);
    const r = await this.backend.call(`/v1/instances/${id}`, { token, timeout: 20000 });
    if (!r?.manifest || !Array.isArray(r.manifest.files)) throw new Error('El servidor devolvió una instancia incompleta');
    return r;
  }

  install(id, { repair = false } = {}) {
    if (this.tasks.has(id)) return this.tasks.get(id).promise;
    if (this.running.has(id)) throw new Error('Cierra el juego antes de actualizar esta instancia');
    const ctrl = new AbortController();
    const summary = this.remote.get(id);
    const progress = new TaskProgress(id, { name: summary?.name || id, kind: repair ? 'repair' : 'install' });
    let last = 0;
    progress.on('update', (s) => {
      const now = Date.now();
      if (now - last < 250 && s.phase === this._lastPhase) return;
      last = now;
      this._lastPhase = s.phase;
      this.emit('progress', s);
    });
    const task = { ctrl, progress, kind: repair ? 'repair' : 'install' };
    this.tasks.set(id, task);
    this.emitChange(id);
    task.promise = this._install(id, { repair, signal: ctrl.signal, progress })
      .then((r) => {
        this.emit('task-done', { id, ok: true, kind: task.kind });
        return r;
      })
      .catch((e) => {
        const cancelled = e.name === 'AbortError';
        if (!cancelled) this.log.error(`Error instalando ${id}:`, e);
        this.emit('task-done', { id, ok: false, cancelled, kind: task.kind, error: cancelled ? null : e.message });
        if (!cancelled) throw e;
        return null;
      })
      .finally(() => {
        progress.stop();
        this.tasks.delete(id);
        this.emitChange(id);
      });
    return task.promise;
  }

  async _install(id, { repair, signal, progress }) {
    const gameDir = this.gameDir(id);
    progress.setPhase('prepare', 'Conectando con el servidor…');
    const { instance, manifest, downloadToken } = await this.fetchManifest(id);
    this.remote.set(id, instance);
    const prev = (await this.readState(id)) || {};
    const hadJournal = await exists(this.journalFile(id));
    const thorough = repair || hadJournal;
    await ensureDir(path.join(gameDir, '.vsl'));
    await writeJsonAtomic(this.journalFile(id), { target: manifest.version, from: prev.installedVersion || null, startedAt: Date.now(), repair });

    const settings = this.settings.get();
    progress.setPhase('prepare', `Preparando Minecraft ${manifest.mc}…`);
    const plan = await planGame({ mc: manifest.mc, loader: manifest.loader }, {
      dirs: this.dirs, signal, repair: thorough, gameDir,
      javaCustom: (major) => settings.javaPaths?.[major] || undefined,
    });
    try {
      // Archivos de la instancia (mods, configs, resourcepacks…)
      progress.setPhase('check', 'Comprobando archivos de la instancia…');
      const files = [];
      const seen = new Set();
      for (const f of manifest.files) {
        const rel = normalizeRel(f.path);
        if (!rel || seen.has(rel.toLowerCase()) || !/^[a-f0-9]{40}$/i.test(f.sha1 || '')) continue;
        if (rel.toLowerCase().startsWith('.vsl/')) continue; // carpeta interna del launcher
        seen.add(rel.toLowerCase());
        files.push({ ...f, path: rel });
      }
      const apiBase = this.backend.base();
      if (manifest.loader?.type && manifest.loader.type !== 'vanilla' && !files.some(csl.isCslFile)) {
        const extra = await csl.cslFile(manifest.mc, manifest.loader.type).catch((e) => {
          this.log.warn('No se pudo añadir CustomSkinLoader:', e.message);
          return null;
        });
        if (extra && !seen.has(extra.path.toLowerCase())) files.push(extra);
      }
      const items = [];
      const prevFiles = prev.files || {};
      await pool(files, 16, async (f) => {
        const dest = safeJoin(gameDir, f.path);
        const st = await statOrNull(dest);
        if (st && f.policy === 'once') return; // archivo que el jugador puede cambiar (options.txt…)
        if (st) {
          const rec = prevFiles[f.path];
          if (!thorough && rec && rec.sha1 === f.sha1 && rec.size === st.size && Math.abs((rec.mtime || 0) - st.mtimeMs) < 2) return;
          if (st.size === f.size && (await hashFile(dest).catch(() => '')) === f.sha1.toLowerCase()) return;
        }
        let url = f.url;
        if (f.source === 'upload' || !url) {
          url = `${apiBase}/v1/instances/${id}/blobs/${f.sha1.toLowerCase()}${downloadToken ? `?t=${encodeURIComponent(downloadToken)}` : ''}`;
        }
        // solo HTTPS (o el servidor local de pruebas); el SHA-1 se comprueba igualmente
        if (!/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) return;
        items.push({ url, dest, sha1: f.sha1.toLowerCase(), size: f.size, label: path.basename(f.path), force: true });
      }, signal);

      progress.setPhase('download', thorough ? 'Verificando y descargando…' : 'Descargando…');
      const all = [...plan.items, ...items];
      await downloadAll(all, { concurrency: settings.concurrency, signal, progress, verify: thorough ? 'hash' : 'size' });

      progress.setPhase('install', 'Instalando…');
      for (const post of plan.posts) {
        if (signal.aborted) break;
        await post(progress);
      }
      if (signal.aborted) throw Object.assign(new Error('Operación cancelada'), { name: 'AbortError' });

      // Quitar archivos que ya no forman parte de la instancia (no toca lo que añadió el jugador)
      const keep = new Set(files.map((f) => f.path.toLowerCase()));
      for (const [rel, rec] of Object.entries(prevFiles)) {
        if (keep.has(rel.toLowerCase()) || rec.policy === 'once') continue;
        try { await fsp.rm(safeJoin(gameDir, rel), { force: true }); } catch { /* ruta inválida */ }
      }

      if (manifest.loader?.type && manifest.loader.type !== 'vanilla') await csl.configure(gameDir, apiBase).catch(() => {});

      const record = {};
      for (const f of files) {
        const st = await statOrNull(safeJoin(gameDir, f.path));
        if (st) record[f.path] = { sha1: f.sha1.toLowerCase(), size: st.size, mtime: st.mtimeMs, policy: f.policy || 'always', managedBy: f.managedBy };
      }
      await this.writeState(id, {
        ...prev,
        installedVersion: manifest.version,
        launchId: plan.launchId,
        mc: manifest.mc,
        loader: manifest.loader,
        files: record,
        summary: instance,
        installedAt: Date.now(),
      });
      await fsp.rm(this.journalFile(id), { force: true });
      this.log.info(`Instancia ${id} lista (versión ${manifest.version}, ${items.length} archivos nuevos)`);
      return { version: manifest.version };
    } finally {
      plan.dispose();
    }
  }

  cancel(id) {
    const t = this.tasks.get(id);
    if (t) t.ctrl.abort();
  }

  // Cancela todo de forma segura y espera a que se cierren los archivos abiertos.
  async cancelAll() {
    const list = [...this.tasks.values()];
    for (const t of list) t.ctrl.abort();
    await Promise.allSettled(list.map((t) => t.promise));
  }

  busy() { return this.tasks.size > 0; }

  // ---------- Jugar ----------
  async play(id, hooks = {}) {
    if (this.running.has(id)) return { already: true };
    if (this.tasks.has(id)) throw new Error('Espera a que termine la descarga');
    const st = await this.readState(id);
    if (!st?.installedVersion) throw new Error('Primero descarga la instancia');
    if (await exists(this.journalFile(id))) throw new Error('La última actualización no terminó. Pulsa "Actualizar" para completarla.');
    const remote = this.remote.get(id);
    if (remote && remote.version > st.installedVersion && !this.remoteError) throw new Error('Hay una actualización pendiente. Pulsa "Actualizar".');

    const ctrl = new AbortController();
    const progress = new TaskProgress(id, { name: st.summary?.name || id, kind: 'launch' });
    const task = { ctrl, progress, kind: 'launch' };
    this.tasks.set(id, task);
    this.emitChange(id);
    task.promise = (async () => {
      const settings = this.settings.get();
      const gameDir = this.gameDir(id);
      progress.setPhase('prepare', 'Preparando el juego…');
      const identity = await this.accounts.launchIdentity();
      const plan = await planGame({ mc: st.mc, loader: st.loader }, {
        dirs: this.dirs, signal: ctrl.signal, gameDir,
        javaCustom: (major) => settings.javaPaths?.[major] || undefined,
      });
      try {
        // comprobación rápida: si falta algo (p. ej. lo borró el antivirus) se vuelve a bajar
        await downloadAll(plan.items, { concurrency: settings.concurrency, signal: ctrl.signal, progress, verify: 'size' });
        for (const post of plan.posts) await post(progress);
      } finally {
        plan.dispose();
      }
      if (st.loader?.type && st.loader.type !== 'vanilla') await csl.configure(gameDir, this.backend.base()).catch(() => {});
      const o = st.options || {};
      const summary = remote || st.summary || {};
      const game = await launchGame(plan, {
        dirs: this.dirs,
        gameDir,
        account: identity,
        memory: o.memory || settings.memory,
        jvmArgs: o.jvmArgs ?? settings.jvmArgs,
        resolution: o.resolution || settings.resolution,
        server: o.autoJoin === false ? null : summary.server,
        launcherVersion: hooks.version,
      });
      this.running.set(id, game);
      await this.writeState(id, { ...st, lastPlayed: Date.now() });
      this.settings.set({ lastInstance: id });
      this.log.info(`Juego iniciado: ${id} (pid ${game.pid})`);
      game.on('exit', async ({ code, duration }) => {
        this.running.delete(id);
        const cur = (await this.readState(id)) || st;
        await this.writeState(id, { ...cur, playTime: (cur.playTime || 0) + Math.round(duration / 1000) }).catch(() => {});
        this.log.info(`Juego cerrado: ${id} (código ${code}, ${Math.round(duration / 1000)} s)`);
        this.emit('game-exit', { id, code, duration, crashed: code !== 0 && code !== null, log: code !== 0 ? game.lines.slice(-40) : [] });
        this.emitChange(id);
      });
      game.on('ready', () => this.emit('game-ready', { id }));
      this.emit('game-start', { id, pid: game.pid });
      return { pid: game.pid };
    })().finally(() => {
      progress.stop();
      this.tasks.delete(id);
      this.emitChange(id);
    });
    return task.promise;
  }

  stop(id) {
    this.running.get(id)?.kill();
  }

  anyRunning() { return this.running.size > 0; }

  // ---------- Otros ----------
  async setOptions(id, patch) {
    const st = await this.readState(id);
    if (!st) throw new Error('La instancia no está instalada');
    const options = { ...(st.options || {}), ...patch };
    for (const k of Object.keys(options)) if (options[k] === null) delete options[k];
    await this.writeState(id, { ...st, options });
    this.emitChange(id);
    return options;
  }

  async uninstall(id, { keepSaves = false } = {}) {
    if (this.running.has(id)) throw new Error('Cierra el juego antes de desinstalar');
    if (this.tasks.has(id)) await this.tasks.get(id).ctrl.abort();
    const dir = this.gameDir(id);
    if (keepSaves && (await exists(path.join(dir, 'saves')))) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const dest = path.join(this.dirs.root, 'backups', `${id}-${stamp}`);
      await ensureDir(dest);
      await fsp.rename(path.join(dir, 'saves'), path.join(dest, 'saves')).catch(async () => {
        await fsp.cp(path.join(dir, 'saves'), path.join(dest, 'saves'), { recursive: true });
      });
    }
    await rmrf(dir);
    this.log.info(`Instancia desinstalada: ${id}`);
    this.emitChange(id);
    return true;
  }

  async size(id) { return dirSize(this.gameDir(id)); }

  logTail(id) { return this.running.get(id)?.lines.slice(-200) || []; }
}

module.exports = { Instances, ID_RE };
