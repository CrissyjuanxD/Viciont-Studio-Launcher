'use strict';
// Instancias para los jugadores: lista (según permisos), instalación, actualización,
// reparación, arranque del juego y desinstalación.
//
// Seguridad ante cierres: antes de tocar una instancia se escribe un "diario"
// (.vsl/journal.json). Cada archivo se descarga a .part y solo se renombra cuando
// su SHA-1 es correcto. Si el launcher se cierra a medias, el diario sigue ahí y la
// próxima vez se verifica todo y se continúa donde se quedó.
//
// Tipos de instancia en este PC:
//   · normal: la que descarga cualquier jugador.
//   · sincronizada (state.workspace): la carpeta de un administrador; lo que cambie ahí es lo que
//     se publica. No se actualiza sola: los cambios de otros se traen desde Administración.
//   · copia de prueba ("<id>~test"): igual que la de un jugador cualquiera, para probar actualizaciones.

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { readJson, writeJsonAtomic, writeFileAtomic, exists, statOrNull, hashFile, rmrf, safeJoin, normalizeRel, ensureDir, dirSize, renameRetry } = require('../util/fsx');
const { downloadAll, pool } = require('../util/downloader');
const { getText } = require('../util/net');
const { TaskProgress } = require('../util/progress');
const kv = require('../util/kvfile');
const { planGame } = require('../game/install');
const { launchGame } = require('../game/launch');
const csl = require('./csl');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}(~test)?$/;
const TEST = '~test';
const baseId = (id) => String(id || '').replace(/~test$/, '');
const isTestId = (id) => String(id || '').endsWith(TEST);
// Cargadores que pueden leer los mods desde otra carpeta (así la carpeta "mods" se ve vacía).
const PROTECT_LOADERS = new Set(['fabric', 'quilt']);
const isProtectable = (rel) => /^mods\/[^/]+\.jar$/i.test(rel);

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
  // Copia de lo último que se recibió de un archivo que se fusiona por claves (options.txt…).
  baseCopy(id, rel) { return path.join(this.gameDir(id), '.vsl', 'base', ...rel.split('/')); }
  // Carpeta aparte (fuera de la instancia) para los mods ocultos a los jugadores.
  protectedDir(id) {
    return path.join(this.dirs.meta, 'pk', crypto.createHash('sha1').update(`vsl:${id}`).digest('hex').slice(0, 24));
  }

  async readState(id) { return readJson(this.stateFile(id)); }
  async writeState(id, st) { await writeJsonAtomic(this.stateFile(id), st); }

  // ¿Se ocultan los mods de esta instancia a este jugador? (los administradores lo ven todo;
  // la copia de prueba se comporta como la de un jugador cualquiera)
  protects(summary, loader, test = false) {
    if (!Array.isArray(summary?.protect) || !summary.protect.includes('mods')) return false;
    if (!PROTECT_LOADERS.has(loader?.type)) return false;
    return test || !summary.canManage;
  }

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
      this.remote = new Map((r.instances || []).filter((s) => ID_RE.test(s.id) && !isTestId(s.id)).map((s) => [s.id, s]));
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
    const test = isTestId(id);
    const ws = st?.workspace || null;
    const task = this.tasks.get(id);
    let status = 'not-installed';
    if (ws) status = 'installed';
    else if (st?.installedVersion) status = remote && remote.version > st.installedVersion ? 'update' : 'installed';
    if (journal && !ws) status = st?.installedVersion ? 'update' : 'not-installed';
    if (task) status = task.kind === 'launch' ? 'launching' : 'installing';
    if (this.running.has(id)) status = 'running';
    return {
      ...summary,
      id,
      baseId: baseId(id),
      test,
      canManage: Boolean(summary.canManage) && !test,
      workspace: ws ? { baseVersion: ws.baseVersion || 0, behind: Boolean(remote && remote.version > (ws.baseVersion || 0)) } : null,
      available: Boolean(remote),
      installed: Boolean(st?.installedVersion) || Boolean(ws),
      installedVersion: ws ? (ws.baseVersion || null) : (st?.installedVersion || null),
      interrupted: Boolean(journal) && !ws,
      status,
      lastPlayed: st?.lastPlayed || null,
      playTime: st?.playTime || 0,
      options: st?.options || {},
      progress: task?.progress?.snapshot() || null,
    };
  }

  async list() {
    const ids = new Set([...this.remote.keys(), ...(await this.localIds()), ...this.tasks.keys()]);
    const out = [];
    for (const id of ids) {
      const d = await this.describe(id, this.remote.get(baseId(id)));
      if (d) out.push(d);
    }
    out.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || (b.updatedAt || 0) - (a.updatedAt || 0) || Number(a.test) - Number(b.test));
    return { instances: out, error: this.remoteError, configured: this.backend.configured(), at: this.remoteAt };
  }

  async get(id) {
    return this.describe(id, this.remote.get(baseId(id)));
  }

  emitChange(id) {
    this.get(id).then((d) => this.emit('instance', d)).catch(() => {});
  }

  // ---------- Instalar / actualizar / reparar ----------
  async fetchManifest(id) {
    const token = await this.accounts.session().catch(() => null);
    // f=merge: este launcher sabe fusionar options.txt por claves
    const r = await this.backend.call(`/v1/instances/${baseId(id)}?f=merge`, { token, timeout: 20000 });
    if (!r?.manifest || !Array.isArray(r.manifest.files)) throw new Error('El servidor devolvió una instancia incompleta');
    return r;
  }

  blobUrl(id, sha1, downloadToken) {
    return `${this.backend.base()}/v1/instances/${baseId(id)}/blobs/${sha1}${downloadToken ? `?t=${encodeURIComponent(downloadToken)}` : ''}`;
  }

  // Enlace de descarga de un archivo del manifiesto (solo HTTPS o el servidor local de pruebas).
  fileUrl(id, f, downloadToken) {
    let url = f.url;
    if (f.source === 'upload' || !url) url = this.blobUrl(id, f.sha1.toLowerCase(), downloadToken);
    if (!/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) return null;
    return url;
  }

  install(id, { repair = false } = {}) {
    if (this.tasks.has(id)) return this.tasks.get(id).promise;
    if (this.running.has(id)) throw new Error('Cierra el juego antes de actualizar esta instancia');
    const ctrl = new AbortController();
    const summary = this.remote.get(baseId(id));
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
    const test = isTestId(id);
    const bid = baseId(id);
    const gameDir = this.gameDir(id);
    progress.setPhase('prepare', 'Conectando con el servidor…');
    const { instance, manifest, downloadToken } = await this.fetchManifest(id);
    this.remote.set(bid, instance);
    const prev = (await this.readState(id)) || {};
    if (prev.workspace) throw new Error('Esta instancia está sincronizada con tu carpeta: trae los cambios desde Administración.');
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
    const protect = this.protects(instance, manifest.loader, test);
    const pdir = this.protectedDir(id);
    const destOf = (f, loc) => (loc === 'p' ? path.join(pdir, `${f.sha1.toLowerCase()}.jar`) : safeJoin(gameDir, f.path));
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
      if (manifest.loader?.type && manifest.loader.type !== 'vanilla' && !files.some(csl.isCslFile)) {
        const extra = await csl.cslFile(manifest.mc, manifest.loader.type).catch((e) => {
          this.log.warn('No se pudo añadir CustomSkinLoader:', e.message);
          return null;
        });
        if (extra && !seen.has(extra.path.toLowerCase())) files.push(extra);
      }
      const items = [];
      const merges = []; // ya los tiene el jugador: se fusionan por claves al terminar
      const fresh = []; // se fusionan por claves pero el jugador aún no los tiene
      const prevFiles = prev.files || {};
      await pool(files, 16, async (f) => {
        const sha = f.sha1.toLowerCase();
        f.loc = protect && isProtectable(f.path) ? 'p' : 'g';
        const dest = destOf(f, f.loc);
        const rec = prevFiles[f.path];
        // se activó o se quitó la protección de mods: se mueve el archivo en vez de volver a bajarlo
        if (rec && (rec.loc || 'g') !== f.loc && rec.sha1 === sha) await this.moveFile(destOf(f, rec.loc || 'g'), dest);
        const st = await statOrNull(dest);
        if (st && f.policy === 'once') return; // archivo que el jugador puede cambiar (servers.dat…)
        if (f.policy === 'merge' && st) {
          if (rec && rec.sha1 === sha) return; // el administrador no lo cambió: se queda el del jugador
          const url = this.fileUrl(bid, f, downloadToken);
          if (!url) return;
          const incoming = path.join(gameDir, '.vsl', 'incoming', sha);
          merges.push({ rel: f.path, dest, incoming, prevSha1: rec?.sha1 || null });
          items.push({ url, dest: incoming, sha1: sha, size: f.size, label: path.basename(f.path), force: true });
          return;
        }
        if (st) {
          if (!thorough && rec && rec.sha1 === sha && rec.size === st.size && Math.abs((rec.mtime || 0) - st.mtimeMs) < 2) return;
          if (st.size === f.size && (await hashFile(dest).catch(() => '')) === sha) return;
        }
        const url = this.fileUrl(bid, f, downloadToken);
        if (!url) return;
        if (f.policy === 'merge') fresh.push({ rel: f.path, dest });
        items.push({ url, dest, sha1: sha, size: f.size, label: path.basename(f.path), force: true });
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

      // options.txt y parecidos: el jugador recibe solo los ajustes que cambió el administrador
      for (const m of merges) {
        const incoming = await fsp.readFile(m.incoming, 'utf8');
        const baseFile = this.baseCopy(id, m.rel);
        let base = await fsp.readFile(baseFile, 'utf8').catch(() => null);
        if (base == null && m.prevSha1) base = await getText(this.blobUrl(bid, m.prevSha1, downloadToken), { timeout: 15000, retries: 0 }).catch(() => null);
        const mine = await fsp.readFile(m.dest, 'utf8').catch(() => '');
        await writeFileAtomic(m.dest, kv.merge3(mine, base, incoming));
        await ensureDir(path.dirname(baseFile));
        await fsp.writeFile(baseFile, incoming);
      }
      for (const m of fresh) {
        const baseFile = this.baseCopy(id, m.rel);
        await ensureDir(path.dirname(baseFile));
        await fsp.copyFile(m.dest, baseFile).catch(() => {});
      }
      await rmrf(path.join(gameDir, '.vsl', 'incoming'));

      // Quitar archivos que ya no forman parte de la instancia (no toca lo que añadió el jugador)
      const keep = new Set(files.map((f) => f.path.toLowerCase()));
      const keptProtected = new Set(files.filter((f) => f.loc === 'p').map((f) => f.sha1.toLowerCase()));
      for (const [rel, rec] of Object.entries(prevFiles)) {
        try {
          // en la carpeta oculta los mods se guardan por su SHA-1: si cambió o se quitó, sobra el anterior
          if ((rec.loc || 'g') === 'p') {
            if (!keptProtected.has(rec.sha1)) await fsp.rm(path.join(pdir, `${rec.sha1}.jar`), { force: true });
            continue;
          }
          if (keep.has(rel.toLowerCase()) || rec.policy === 'once' || rec.policy === 'merge') continue;
          await fsp.rm(safeJoin(gameDir, rel), { force: true });
        } catch { /* ruta inválida */ }
      }
      if (!protect) await fsp.rmdir(pdir).catch(() => {});

      if (manifest.loader?.type && manifest.loader.type !== 'vanilla') await csl.configure(gameDir, this.backend.base()).catch(() => {});

      const record = {};
      for (const f of files) {
        const st = await statOrNull(destOf(f, f.loc));
        if (st) record[f.path] = { sha1: f.sha1.toLowerCase(), size: st.size, mtime: st.mtimeMs, policy: f.policy || 'always', managedBy: f.managedBy, loc: f.loc };
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
        protected: protect,
      });
      await fsp.rm(this.journalFile(id), { force: true });
      this.log.info(`Instancia ${id} lista (versión ${manifest.version}, ${items.length} archivos nuevos${protect ? ', mods ocultos' : ''})`);
      return { version: manifest.version };
    } finally {
      plan.dispose();
    }
  }

  async moveFile(from, to) {
    if (from === to || !(await exists(from))) return;
    await ensureDir(path.dirname(to));
    await fsp.rm(to, { force: true });
    await renameRetry(from, to).catch(async () => {
      await fsp.copyFile(from, to);
      await fsp.rm(from, { force: true }).catch(() => {});
    });
  }

  // Coloca los mods donde toca (carpeta oculta o "mods") si cambió la protección desde la última descarga.
  async relayout(id, st, protect) {
    if (Boolean(st.protected) === protect) return st;
    const gameDir = this.gameDir(id);
    const pdir = this.protectedDir(id);
    const files = { ...(st.files || {}) };
    for (const [rel, rec] of Object.entries(files)) {
      if (!isProtectable(rel)) continue;
      const want = protect ? 'p' : 'g';
      const cur = rec.loc || 'g';
      if (cur === want) continue;
      const at = (loc) => (loc === 'p' ? path.join(pdir, `${rec.sha1}.jar`) : safeJoin(gameDir, rel));
      await this.moveFile(at(cur), at(want)).catch(() => {});
      files[rel] = { ...rec, loc: want, mtime: (await statOrNull(at(want)))?.mtimeMs ?? rec.mtime };
    }
    if (!protect) await fsp.rmdir(pdir).catch(() => {});
    const next = { ...st, files, protected: protect };
    await this.writeState(id, next);
    return next;
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
    let st = await this.readState(id);
    const ws = st?.workspace;
    if (!st?.installedVersion && !ws) throw new Error('Primero descarga la instancia');
    if (!ws && await exists(this.journalFile(id))) throw new Error('La última actualización no terminó. Pulsa "Actualizar" para completarla.');
    const remote = this.remote.get(baseId(id));
    if (!ws && remote && remote.version > st.installedVersion && !this.remoteError) throw new Error('Hay una actualización pendiente. Pulsa "Actualizar".');
    if (!st.mc) throw new Error('Elige la versión de Minecraft de esta instancia en Administración.');

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
        const extra = ws ? await this.cslItems(gameDir, st) : [];
        await downloadAll([...plan.items, ...extra], { concurrency: settings.concurrency, signal: ctrl.signal, progress, verify: 'size' });
        for (const post of plan.posts) await post(progress);
      } finally {
        plan.dispose();
      }
      if (st.loader?.type && st.loader.type !== 'vanilla') await csl.configure(gameDir, this.backend.base()).catch(() => {});
      if (!ws) st = await this.relayout(id, st, this.protects(remote || st.summary, st.loader, isTestId(id)));
      // mods ocultos: Fabric los lee de la carpeta; Quilt necesita la lista de archivos
      const extraJvm = [];
      if (st.protected) {
        const pdir = this.protectedDir(id);
        if (st.loader?.type === 'quilt') {
          const jars = (await fsp.readdir(pdir).catch(() => [])).filter((n) => /\.jar$/i.test(n)).map((n) => path.join(pdir, n));
          if (jars.length) extraJvm.push(`-Dloader.addMods=${jars.join(path.delimiter)}`);
        } else extraJvm.push(`-Dfabric.addMods=${pdir}`);
      }
      const o = st.options || {};
      const summary = remote || st.summary || {};
      const game = await launchGame(plan, {
        dirs: this.dirs,
        gameDir,
        account: identity,
        memory: o.memory || settings.memory,
        jvmArgs: o.jvmArgs ?? settings.jvmArgs,
        extraJvm,
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

  // En la carpeta de un administrador también va CustomSkinLoader (lo añade el launcher; no se publica).
  async cslItems(gameDir, st) {
    if (!st.loader?.type || st.loader.type === 'vanilla') return [];
    const f = await csl.cslFile(st.mc, st.loader.type).catch(() => null);
    if (!f) return [];
    return [{ url: f.url, dest: safeJoin(gameDir, f.path), sha1: f.sha1, size: f.size, label: path.basename(f.path) }];
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
      const dest = path.join(this.dirs.root, 'backups', `${id.replace(TEST, '-prueba')}-${stamp}`);
      await ensureDir(dest);
      await fsp.rename(path.join(dir, 'saves'), path.join(dest, 'saves')).catch(async () => {
        await fsp.cp(path.join(dir, 'saves'), path.join(dest, 'saves'), { recursive: true });
      });
    }
    await rmrf(dir);
    await rmrf(this.protectedDir(id));
    this.log.info(`Instancia desinstalada: ${id}`);
    this.emitChange(id);
    return true;
  }

  async size(id) { return (await dirSize(this.gameDir(id))) + (await dirSize(this.protectedDir(id))); }

  logTail(id) { return this.running.get(id)?.lines.slice(-200) || []; }
}

module.exports = { Instances, ID_RE, baseId, isTestId, isProtectable };
