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
//
// Carpetas ocultas a los jugadores (las elige el administrador en Permisos):
//   · mods (Fabric/Quilt): se guardan aparte y el cargador los lee desde ahí.
//   · config y resourcepacks: se guardan aparte y el launcher los pone en su sitio solo mientras
//     se juega (con enlaces duros: no ocupan el doble ni tardan). Al cerrar el juego se quitan y
//     lo que el juego cambió se guarda. Los resource packs quedan ocultos en el Explorador incluso
//     mientras se juega.

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { readJson, writeJsonAtomic, writeFileAtomic, exists, statOrNull, hashFile, rmrf, safeJoin, normalizeRel, ensureDir, dirSize, renameRetry } = require('../util/fsx');
const { downloadAll, pool } = require('../util/downloader');
const { getText } = require('../util/net');
const { TaskProgress } = require('../util/progress');
const kv = require('../util/kvfile');
const { planGame } = require('../game/install');
const { launchGame } = require('../game/launch');
const { collectCrash } = require('../game/crash');
const csl = require('./csl');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}(~test)?$/;
const TEST = '~test';
const baseId = (id) => String(id || '').replace(/~test$/, '');
const isTestId = (id) => String(id || '').endsWith(TEST);
// Cargadores que pueden leer los mods desde otra carpeta (así la carpeta "mods" se ve vacía).
const PROTECT_LOADERS = new Set(['fabric', 'quilt']);
const isProtectable = (rel) => /^mods\/[^/]+\.jar$/i.test(rel);
// Carpetas que se guardan aparte y solo se ponen en su sitio mientras se juega (cualquier cargador).
const STAGED = ['config', 'resourcepacks'];
const topOf = (rel) => String(rel).split('/')[0].toLowerCase();

// Dónde va cada archivo: 'g' = carpeta del juego, 'p' = mods ocultos (por SHA-1), 'h' = config/resourcepacks ocultos.
function locOf(rel, kinds) {
  if (kinds.includes('mods') && isProtectable(rel)) return 'p';
  const top = topOf(rel);
  if (rel.includes('/') && STAGED.includes(top) && kinds.includes(top)) return 'h';
  return 'g';
}

const isAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Oculta (o vuelve a mostrar) archivos y carpetas en el Explorador: atributos "oculto" + "sistema".
function setHidden(paths, on) {
  if (process.platform !== 'win32' || !paths.length) return Promise.resolve();
  return pool(paths, 4, (p) => new Promise((resolve) => {
    const c = spawn('attrib', [on ? '+h' : '-h', on ? '+s' : '-s', p], { windowsHide: true, stdio: 'ignore' });
    c.on('exit', resolve);
    c.on('error', resolve);
  }));
}

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
    this.waiting = new Map(); // id → temporizador (juego de una sesión anterior que sigue abierto)
  }

  setDirs(dirs) { this.dirs = dirs; }

  gameDir(id) {
    if (!ID_RE.test(id)) throw new Error('Identificador de instancia no válido');
    return path.join(this.dirs.instances, id);
  }
  stateFile(id) { return path.join(this.gameDir(id), '.vsl', 'state.json'); }
  journalFile(id) { return path.join(this.gameDir(id), '.vsl', 'journal.json'); }
  // Carpetas aparte (fuera de la instancia) para lo que se oculta a los jugadores.
  pkName(id) { return crypto.createHash('sha1').update(`vsl:${id}`).digest('hex').slice(0, 24); }
  // mods ocultos (solo .jar: Fabric revisa todo lo que hay dentro, subcarpetas incluidas)
  protectedDir(id) { return path.join(this.dirs.meta, 'pk', this.pkName(id)); }
  // config y resource packs ocultos, y el diario de lo que está puesto mientras se juega
  hiddenDir(id) { return path.join(this.dirs.meta, 'pk-files', this.pkName(id)); }
  stageFile(id) { return path.join(this.hiddenDir(id), 'stage.json'); }
  // Copia de lo último que se recibió de un archivo que se fusiona por claves (options.txt…).
  baseCopy(id, rel, hidden = false) {
    return hidden ? path.join(this.hiddenDir(id), 'base', ...rel.split('/')) : path.join(this.gameDir(id), '.vsl', 'base', ...rel.split('/'));
  }
  fileAt(id, rel, sha1, loc) {
    if (loc === 'p') return path.join(this.protectedDir(id), `${String(sha1).toLowerCase()}.jar`);
    if (loc === 'h') return path.join(this.hiddenDir(id), ...rel.split('/'));
    return safeJoin(this.gameDir(id), rel);
  }

  async readState(id) { return readJson(this.stateFile(id)); }
  async writeState(id, st) { await writeJsonAtomic(this.stateFile(id), st); }

  // Qué se oculta de esta instancia a este jugador (los administradores lo ven todo;
  // la copia de prueba se comporta como la de un jugador cualquiera).
  protectKinds(summary, loader, test = false) {
    const list = Array.isArray(summary?.protect) ? summary.protect : [];
    if (!list.length || !(test || !summary.canManage)) return [];
    return list.filter((k) => (k === 'mods' ? PROTECT_LOADERS.has(loader?.type) : STAGED.includes(k))).sort();
  }
  protects(summary, loader, test = false) { return this.protectKinds(summary, loader, test).includes('mods'); }
  kindsOf(st) { return Array.isArray(st?.protectKinds) ? st.protectKinds : (st?.protected ? ['mods'] : []); }

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
    if (this.running.has(id) || this.waiting.has(id)) status = 'running';
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
    if (this.running.has(id) || this.waiting.has(id)) throw new Error('Cierra el juego antes de actualizar esta instancia');
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
    await this.unstage(id); // por si quedaron puestos los archivos ocultos de una partida anterior
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
    const kinds = this.protectKinds(instance, manifest.loader, test);
    const destOf = (f, loc) => this.fileAt(id, f.path, f.sha1, loc);
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
        f.loc = locOf(f.path, kinds);
        const dest = destOf(f, f.loc);
        const rec = prevFiles[f.path];
        const was = rec?.loc || 'g';
        // se activó o se quitó la protección: se mueve el archivo en vez de volver a bajarlo
        // (los mods ocultos se guardan por su SHA-1: solo se aprovechan si no cambiaron)
        if (rec && was !== f.loc && ((was !== 'p' && f.loc !== 'p') || rec.sha1 === sha)) {
          await this.moveFile(this.fileAt(id, f.path, rec.sha1, was), dest).catch(() => {});
        }
        const st = await statOrNull(dest);
        if (st && f.policy === 'once') return; // archivo que el jugador puede cambiar (servers.dat…)
        if (f.policy === 'merge' && st) {
          if (rec && rec.sha1 === sha) return; // el administrador no lo cambió: se queda el del jugador
          const url = this.fileUrl(bid, f, downloadToken);
          if (!url) return;
          const incoming = path.join(gameDir, '.vsl', 'incoming', sha);
          merges.push({ rel: f.path, dest, incoming, prevSha1: rec?.sha1 || null, hidden: f.loc === 'h' });
          items.push({ url, dest: incoming, sha1: sha, size: f.size, label: path.basename(f.path), force: true });
          return;
        }
        if (st) {
          if (!thorough && rec && rec.sha1 === sha && rec.size === st.size && Math.abs((rec.mtime || 0) - st.mtimeMs) < 2) return;
          if (st.size === f.size && (await hashFile(dest).catch(() => '')) === sha) return;
        }
        const url = this.fileUrl(bid, f, downloadToken);
        if (!url) return;
        if (f.policy === 'merge') fresh.push({ rel: f.path, dest, hidden: f.loc === 'h' });
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
        const baseFile = this.baseCopy(id, m.rel, m.hidden);
        let base = await fsp.readFile(baseFile, 'utf8').catch(() => null);
        if (base == null && m.prevSha1) base = await getText(this.blobUrl(bid, m.prevSha1, downloadToken), { timeout: 15000, retries: 0 }).catch(() => null);
        const mine = await fsp.readFile(m.dest, 'utf8').catch(() => '');
        await writeFileAtomic(m.dest, kv.merge3(mine, base, incoming));
        await ensureDir(path.dirname(baseFile));
        await fsp.writeFile(baseFile, incoming);
      }
      for (const m of fresh) {
        const baseFile = this.baseCopy(id, m.rel, m.hidden);
        await ensureDir(path.dirname(baseFile));
        await fsp.copyFile(m.dest, baseFile).catch(() => {});
      }
      await rmrf(path.join(gameDir, '.vsl', 'incoming'));

      // Quitar archivos que ya no forman parte de la instancia (no toca lo que añadió el jugador)
      const keep = new Map(files.map((f) => [f.path.toLowerCase(), f]));
      const keptProtected = new Set(files.filter((f) => f.loc === 'p').map((f) => f.sha1.toLowerCase()));
      for (const [rel, rec] of Object.entries(prevFiles)) {
        try {
          const was = rec.loc || 'g';
          // en la carpeta oculta los mods se guardan por su SHA-1: si cambió o se quitó, sobra el anterior
          if (was === 'p') {
            if (!keptProtected.has(rec.sha1)) await fsp.rm(this.fileAt(id, rel, rec.sha1, 'p'), { force: true });
            continue;
          }
          if (keep.has(rel.toLowerCase())) continue; // sigue en la instancia (si cambió de sitio, ya se movió)
          if (rec.policy === 'once' || rec.policy === 'merge') {
            // el archivo ya es del jugador: si estaba oculto, pasa a su carpeta normal
            if (was === 'h') await this.moveFile(this.fileAt(id, rel, rec.sha1, 'h'), safeJoin(gameDir, rel)).catch(() => {});
            continue;
          }
          await fsp.rm(this.fileAt(id, rel, rec.sha1, was), { force: true });
          if (was === 'h') await this.pruneDirs(this.hiddenDir(id), rel);
        } catch { /* ruta inválida */ }
      }
      if (!kinds.includes('mods')) await this.dropJars(id);

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
        protected: kinds.includes('mods'),
        protectKinds: kinds,
      });
      await fsp.rm(this.journalFile(id), { force: true });
      this.log.info(`Instancia ${id} lista (versión ${manifest.version}, ${items.length} archivos nuevos${kinds.length ? `, ocultos: ${kinds.join(', ')}` : ''})`);
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

  // Quita las carpetas que quedaron vacías entre el archivo y la carpeta principal (config, resourcepacks…).
  async pruneDirs(root, rel) {
    const parts = rel.split('/').slice(0, -1);
    while (parts.length > 1) {
      try { await fsp.rmdir(path.join(root, ...parts)); } catch { return; }
      parts.pop();
    }
  }

  // Sin mods ocultos: se borran los que quedaran en la carpeta aparte (el resto de lo oculto se queda).
  async dropJars(id) {
    const pdir = this.protectedDir(id);
    for (const n of await fsp.readdir(pdir).catch(() => [])) {
      if (/^[a-f0-9]{40}\.jar$/i.test(n)) await fsp.rm(path.join(pdir, n), { force: true }).catch(() => {});
    }
    await fsp.rmdir(pdir).catch(() => {});
  }

  // Coloca cada archivo donde toca (carpeta normal u oculta) si cambió la protección desde la última descarga.
  async relayout(id, st, kinds) {
    if (this.kindsOf(st).join(',') === kinds.join(',')) return st;
    await this.unstage(id);
    const gameDir = this.gameDir(id);
    const files = { ...(st.files || {}) };
    for (const [rel, rec] of Object.entries(files)) {
      const want = locOf(rel, kinds);
      const cur = rec.loc || 'g';
      if (cur === want) continue;
      const to = this.fileAt(id, rel, rec.sha1, want);
      await this.moveFile(this.fileAt(id, rel, rec.sha1, cur), to).catch(() => {});
      if (cur === 'h') await this.pruneDirs(this.hiddenDir(id), rel);
      if (cur === 'g') await this.pruneDirs(gameDir, rel);
      files[rel] = { ...rec, loc: want, mtime: (await statOrNull(to))?.mtimeMs ?? rec.mtime };
    }
    if (!kinds.includes('mods')) await this.dropJars(id);
    const next = { ...st, files, protected: kinds.includes('mods'), protectKinds: kinds };
    await this.writeState(id, next);
    return next;
  }

  // ---------- Carpetas ocultas mientras se juega (config, resourcepacks) ----------
  // Pone los archivos ocultos en la carpeta del juego con enlaces duros (o copias si no se puede).
  async stage(id, st) {
    const hidden = Object.entries(st.files || {}).filter(([, r]) => r.loc === 'h').map(([rel]) => rel);
    if (!hidden.length) return null;
    await this.unstage(id, { force: true });
    const gameDir = this.gameDir(id);
    const hdir = this.hiddenDir(id);
    const jf = this.stageFile(id);
    // primero se anota todo: si el launcher se cierra a medias, se sabe qué hay que quitar
    const journal = { at: Date.now(), pid: null, files: hidden.map((rel) => ({ rel })), dirs: [], hide: [] };
    await writeJsonAtomic(jf, journal);
    const created = new Set();
    const mkdirs = async (dir) => {
      const missing = [];
      let d = dir;
      while (d.length > gameDir.length && !(await exists(d))) { missing.push(d); d = path.dirname(d); }
      for (const m of missing.reverse()) {
        await fsp.mkdir(m).catch(() => {});
        created.add(path.relative(gameDir, m).split(path.sep).join('/'));
      }
    };
    let links = 0;
    await pool(journal.files, 8, async (e) => {
      const src = path.join(hdir, ...e.rel.split('/'));
      const dst = safeJoin(gameDir, e.rel);
      if (!(await statOrNull(src))?.isFile()) { e.skip = true; return; }
      await mkdirs(path.dirname(dst));
      const old = await statOrNull(dst);
      if (old?.isDirectory()) { e.skip = true; return; }
      if (old) await fsp.rm(dst, { force: true });
      try {
        await fsp.link(src, dst);
        e.mode = 'link';
        links++;
      } catch {
        await fsp.copyFile(src, dst);
        e.mode = 'copy';
      }
      const d = await fsp.stat(dst, { bigint: true });
      e.ino = String(d.ino);
      e.size = Number(d.size);
      e.mtime = Number(d.mtimeMs);
    });
    // En el Explorador se ocultan los resource packs y las carpetas nuevas de config (los archivos
    // sueltos de config no: algunos mods no pueden reescribir un archivo oculto).
    const hide = new Set();
    for (const c of created) {
      const parts = c.split('/');
      if (parts.length < 2) continue; // la carpeta config o resourcepacks en sí se sigue viendo
      if (parts.length === 2 || !created.has(parts.slice(0, -1).join('/'))) hide.add(c);
    }
    for (const e of journal.files) {
      if (e.skip) continue;
      const parts = e.rel.split('/');
      if (parts[0].toLowerCase() === 'resourcepacks' && parts.length === 2) hide.add(e.rel);
    }
    journal.dirs = [...created];
    journal.hide = [...hide];
    await writeJsonAtomic(jf, journal);
    await setHidden(journal.hide.map((r) => safeJoin(gameDir, r)), true);
    this.log.info(`Archivos ocultos puestos para jugar: ${id} (${journal.files.filter((e) => !e.skip).length}, ${links} enlaces)`);
    return journal;
  }

  async setStagePid(id, pid) {
    const jf = this.stageFile(id);
    const j = await readJson(jf);
    if (j) await writeJsonAtomic(jf, { ...j, pid });
  }

  // Quita de la carpeta del juego lo que se puso al jugar; lo que el juego cambió se guarda.
  // force: aunque el juego de una sesión anterior siga abierto (solo antes de volver a ponerlos).
  async unstage(id, { force = false } = {}) {
    const jf = this.stageFile(id);
    const j = await readJson(jf);
    if (!j) return false;
    if (!force && !this.running.has(id) && isAlive(j.pid)) return false;
    const gameDir = this.gameDir(id);
    const hdir = this.hiddenDir(id);
    await setHidden((j.hide || []).map((r) => safeJoin(gameDir, r)), false);
    let saved = 0;
    await pool(j.files || [], 8, async (e) => {
      if (e.skip || !normalizeRel(e.rel)) return;
      const dst = safeJoin(gameDir, e.rel);
      const src = path.join(hdir, ...e.rel.split('/'));
      const d = await fsp.stat(dst, { bigint: true }).catch(() => null);
      if (!d || !d.isFile()) return; // el juego lo borró: se queda la copia guardada
      const same = e.mode === 'link' && e.ino && String(d.ino) === e.ino;
      const changed = !same && (e.size == null || Number(d.size) !== e.size || Math.abs(Number(d.mtimeMs) - e.mtime) > 1 || e.mode !== 'copy');
      if (changed) {
        // el juego lo reescribió (o se cambió estando puesto): esa versión pasa a ser la guardada
        await this.moveFile(dst, src).catch(() => {});
        saved++;
      } else {
        await fsp.rm(dst, { force: true }).catch(() => {});
      }
    });
    for (const rel of [...(j.dirs || [])].sort((a, b) => b.length - a.length)) {
      if (!normalizeRel(rel)) continue;
      await fsp.rmdir(safeJoin(gameDir, rel)).catch(() => {});
    }
    // si en una carpeta nueva quedó algo del jugador (o de un mod), se vuelve a ver
    const left = [];
    for (const rel of j.hide || []) if (normalizeRel(rel) && await exists(safeJoin(gameDir, rel))) left.push(safeJoin(gameDir, rel));
    await setHidden(left, false);
    await fsp.rm(jf, { force: true });
    this.log.info(`Archivos ocultos retirados: ${id}${saved ? ` (${saved} cambiados por el juego)` : ''}`);
    return true;
  }

  // Al abrir el launcher: si quedó algo puesto (se cerró con el juego abierto o se apagó el PC), se retira.
  async recoverStaged() {
    for (const id of await this.localIds()) {
      const j = await readJson(this.stageFile(id));
      if (!j) continue;
      if (isAlive(j.pid)) {
        // el juego de la sesión anterior sigue abierto: se retira cuando se cierre
        const timer = setInterval(() => {
          if (isAlive(j.pid)) return;
          clearInterval(timer);
          this.waiting.delete(id);
          this.unstage(id).catch(() => {}).finally(() => this.emitChange(id));
        }, 15000);
        timer.unref?.();
        this.waiting.set(id, { timer, pid: j.pid });
        continue;
      }
      await this.unstage(id).catch((e) => this.log.warn(`No se pudieron retirar los archivos ocultos de ${id}:`, e.message));
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
    if (this.running.has(id) || this.waiting.has(id)) return { already: true };
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
      if (!ws) st = await this.relayout(id, st, this.protectKinds(remote || st.summary, st.loader, isTestId(id)));
      // mods ocultos: Fabric los lee de la carpeta; Quilt necesita la lista de archivos
      const extraJvm = [];
      if (!ws && this.kindsOf(st).includes('mods')) {
        const pdir = this.protectedDir(id);
        if (st.loader?.type === 'quilt') {
          const jars = (await fsp.readdir(pdir).catch(() => [])).filter((n) => /\.jar$/i.test(n)).map((n) => path.join(pdir, n));
          if (jars.length) extraJvm.push(`-Dloader.addMods=${jars.join(path.delimiter)}`);
        } else extraJvm.push(`-Dfabric.addMods=${pdir}`);
      }
      // config y resource packs ocultos: se ponen en su sitio solo mientras se juega
      const staged = ws ? null : await this.stage(id, st);
      const o = st.options || {};
      const summary = remote || st.summary || {};
      let game;
      try {
        game = await launchGame(plan, {
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
      } catch (e) {
        if (staged) await this.unstage(id, { force: true }).catch(() => {});
        throw e;
      }
      this.running.set(id, game);
      if (staged) await this.setStagePid(id, game.pid).catch(() => {});
      await this.writeState(id, { ...st, lastPlayed: Date.now() });
      this.settings.set({ lastInstance: id });
      this.log.info(`Juego iniciado: ${id} (pid ${game.pid})`);
      game.on('exit', async ({ code, duration }) => {
        const crashed = code !== 0 && code !== null;
        // primero el informe (el juego pudo escribir en config mientras se cerraba)
        const crash = crashed ? await collectCrash({ gameDir, startedAt: game.startedAt, pid: game.pid, logFile: game.logFile }).catch(() => null) : null;
        this.running.delete(id);
        if (staged) await this.unstage(id, { force: true }).catch((e) => this.log.warn(`No se pudieron retirar los archivos ocultos de ${id}:`, e.message));
        const cur = (await this.readState(id)) || st;
        await this.writeState(id, { ...cur, playTime: (cur.playTime || 0) + Math.round(duration / 1000) }).catch(() => {});
        this.log.info(`Juego cerrado: ${id} (código ${code}, ${Math.round(duration / 1000)} s)${crash?.report ? ` · ${crash.report.name}` : ''}`);
        this.emit('game-exit', { id, code, duration, crashed, log: crashed ? game.lines.slice(-60) : [], crash });
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
    const w = this.waiting.get(id);
    if (w && process.platform === 'win32' && isAlive(w.pid)) {
      // juego de una sesión anterior del launcher (sigue abierto)
      spawn('taskkill', ['/pid', String(w.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      return;
    }
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
    if (this.running.has(id) || this.waiting.has(id)) throw new Error('Cierra el juego antes de desinstalar');
    if (this.tasks.has(id)) await this.tasks.get(id).ctrl.abort();
    const dir = this.gameDir(id);
    await this.unstage(id, { force: true }).catch(() => {});
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
    await rmrf(this.hiddenDir(id));
    this.log.info(`Instancia desinstalada: ${id}`);
    this.emitChange(id);
    return true;
  }

  async size(id) { return (await dirSize(this.gameDir(id))) + (await dirSize(this.protectedDir(id))) + (await dirSize(this.hiddenDir(id))); }

  logTail(id) { return this.running.get(id)?.lines.slice(-400) || []; }
}

module.exports = { Instances, ID_RE, baseId, isTestId, isProtectable, STAGED };
