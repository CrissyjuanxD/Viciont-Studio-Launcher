'use strict';
// Administración de instancias. Doble llave:
//   1. El nick tiene que tener permisos concedidos desde el panel web del estudio.
//   2. Hay que escribir la clave personal de ese nick (la genera el panel).
// Cada petición va con la sesión del jugador + su clave, y el servidor comprueba los permisos.
// Los cambios se preparan en un borrador local y se publican en el servidor de una vez:
// solo se suben los archivos nuevos (el resto ya está en R2 o viene de Modrinth).

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { readJson, writeJsonAtomic, exists, statOrNull, hashFile, ensureDir, normalizeRel, rmrf, listFiles, linkOrCopy } = require('../util/fsx');
const { pool } = require('../util/downloader');
const { TaskProgress } = require('../util/progress');
const { send, readSlice } = require('../util/upload');
const { openZip } = require('../util/zip');
const { readSecure, writeSecure } = require('../core/secure');
const { configFile } = require('../core/paths');
const { NICK_RE } = require('../auth/offline');
const modrinth = require('./modrinth');
const { LOADERS } = require('../game/loaders');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const KEY_FILE = configFile('admin.dat');
const SINGLE_MAX = 64 * 1024 * 1024;
const PART = 48 * 1024 * 1024;
const TYPE_DIRS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
const ONCE_FILES = new Set(['options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat']);
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const MEDIA_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };

// Carpetas que nunca se suben al importar una instancia.
const SKIP_TOP = new Set(['logs', 'crash-reports', 'screenshots', '.cache', 'cache', 'local', 'downloads', 'backups', '.vsl',
  'customskinloader', '.fabric', '.mixin.out', 'essential', 'usercache.json', 'usernamecache.json', 'launcher_profiles.json',
  'command_history.txt', 'patchouli_books', 'modernfix', '.curseclient', 'minecraftinstance.json', 'mmc-pack.json',
  'instance.cfg', 'profile.json', 'natives', 'libraries', 'versions', 'assets', 'icon.png', '.optifine']);
const SUGGESTED = new Set(['mods', 'config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks', 'scripts', 'global_packs',
  'datapacks', 'options.txt', 'servers.dat', 'fancymenu_data', 'customization', 'paxi', 'openloader', 'resources', 'emotes']);

function err(message, code) { return Object.assign(new Error(message), { code }); }

function cleanMeta(m = {}, id) {
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  const loader = m.loader && LOADERS[m.loader.type] ? { type: m.loader.type, version: str(m.loader.version, 60) } : { type: 'vanilla', version: '' };
  const allow = [...new Set((Array.isArray(m.allow) ? m.allow : []).map((x) => str(x, 40)).filter((x) => NICK_RE.test(x) || UUID_RE.test(x)))].slice(0, 500);
  return {
    id,
    name: str(m.name, 60) || id,
    summary: str(m.summary, 180),
    description: str(m.description, 5000),
    mc: str(m.mc, 40),
    loader,
    visibility: m.visibility === 'private' ? 'private' : 'public',
    allow,
    memory: { recommended: Math.min(32768, Math.max(0, Math.round(Number(m.memory?.recommended) || 0))) },
    server: str(m.server, 120),
    tags: (Array.isArray(m.tags) ? m.tags : []).map((t) => str(t, 24)).filter(Boolean).slice(0, 6),
    order: Math.round(Number(m.order) || 0),
    featured: Boolean(m.featured),
    accent: /^#[0-9a-f]{6}$/i.test(m.accent || '') ? m.accent : '',
    changelog: str(m.changelog, 2000),
  };
}

class Admin extends EventEmitter {
  constructor({ getDirs, backend, accounts, log }) {
    super();
    this.getDirs = getDirs;
    this.backend = backend;
    this.accounts = accounts;
    this.log = log;
    this.saved = {}; // cuenta → clave recordada (cifrada en admin.dat)
    this.sessions = new Map(); // cuenta → { key, nick, perms, scope }
    this.tasks = new Map();
    this.grants = new Map(); // rutas elegidas por el usuario (arrastrar y soltar / diálogos)
  }

  // ---------- Acceso ----------
  load() {
    const d = readSecure(KEY_FILE, null);
    if (d?.keys && typeof d.keys === 'object') this.saved = d.keys;
  }

  saveKeys() {
    if (Object.keys(this.saved).length) writeSecure(KEY_FILE, { keys: this.saved });
    else fsp.rm(KEY_FILE, { force: true }).catch(() => {});
  }

  forget(uuid) {
    this.sessions.delete(uuid);
    if (this.saved[uuid]) { delete this.saved[uuid]; this.saveKeys(); }
  }

  current() {
    const acc = this.accounts.active();
    return acc ? this.sessions.get(acc.uuid) || null : null;
  }

  unlocked() { return Boolean(this.current()); }

  can(perm) { return Boolean(this.current()?.perms?.includes(perm)); }

  quickStatus() {
    const s = this.current();
    return { unlocked: Boolean(s), perms: s?.perms || [] };
  }

  async status({ fresh = false } = {}) {
    const acc = this.accounts.active();
    const base = { configured: this.backend.configured(), server: this.backend.base() || null, nick: acc?.name || null, access: false, unlocked: false, perms: [] };
    if (!acc || !base.configured) return base;
    let me;
    try { me = await this.accounts.me({ fresh }); } catch (e) {
      const s = this.sessions.get(acc.uuid);
      return { ...base, error: e.message, access: Boolean(s), unlocked: Boolean(s), perms: s?.perms || [] };
    }
    if (!me?.admin) {
      // el panel le quitó el acceso (o nunca lo tuvo): se olvida la clave de esta cuenta
      this.forget(acc.uuid);
      return base;
    }
    let s = this.sessions.get(acc.uuid);
    if (!s && this.saved[acc.uuid]) {
      try { s = await this.verify(acc, this.saved[acc.uuid]); } catch (e) {
        if (e.code === 'EBADKEY' || e.code === 'ENOACCESS') this.forget(acc.uuid);
      }
    }
    return {
      ...base, access: true, hasKey: Boolean(me.admin.hasKey), unlocked: Boolean(s), remembered: Boolean(this.saved[acc.uuid]),
      perms: s?.perms || me.admin.perms || [], scope: s?.scope ?? me.admin.scope,
    };
  }

  async verify(acc, key) {
    const r = await this.request(acc, key, '/v1/admin/ping', { timeout: 12000, retries: 0 });
    const s = { key, nick: r.nick, perms: Array.isArray(r.perms) ? r.perms : [], scope: r.scope };
    this.sessions.set(acc.uuid, s);
    return s;
  }

  async unlock(key, remember) {
    const acc = this.accounts.active();
    if (!acc) throw err('Inicia sesión primero.', 'ELOCKED');
    const k = String(key || '').trim().toUpperCase();
    if (!/^VSL-[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/.test(k)) throw err('Esa no es una clave válida. Tiene la forma VSL-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX.', 'EBADKEY');
    await this.verify(acc, k);
    if (remember) this.saved[acc.uuid] = k; else delete this.saved[acc.uuid];
    this.saveKeys();
    this.log.info(`Modo administrador activado (${acc.name})`);
    return this.status();
  }

  async lock() {
    const acc = this.accounts.active();
    if (acc) this.forget(acc.uuid);
    return { unlocked: false };
  }

  // Cabeceras de una petición de administración: sesión del jugador + clave personal.
  async headers(acc, key) {
    const token = await this.accounts.session(acc);
    if (!token) throw err('No se pudo conectar con el servidor de Viciont Studios.', 'ENOBACKEND');
    return { Authorization: `Bearer ${token}`, 'X-Admin-Key': key };
  }

  async request(acc, key, pathname, opts = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.backend.call(pathname, { ...opts, headers: { ...(opts.headers || {}), ...(await this.headers(acc, key)) } });
      } catch (e) {
        if (e.status === 401 && e.code === 'unauthorized' && attempt === 0) { this.accounts.invalidateSession(acc); continue; }
        if (e.status === 401 && e.code === 'bad_key') throw err('La clave de administrador no es correcta.', 'EBADKEY');
        if (e.status === 403 && (e.code === 'not_admin' || e.code === 'wrong_account')) throw err(e.message, 'ENOACCESS');
        if (e.status === 429) throw err(e.message, 'ETOOMANY');
        throw e;
      }
    }
  }

  async call(pathname, opts = {}) {
    const acc = this.accounts.active();
    const s = acc && this.sessions.get(acc.uuid);
    if (!s) throw err('Activa el modo administrador para continuar.', 'ELOCKED');
    try {
      return await this.request(acc, s.key, pathname, opts);
    } catch (e) {
      if (e.code === 'EBADKEY' || e.code === 'ENOACCESS') {
        this.forget(acc.uuid);
        this.emit('locked');
      }
      throw e;
    }
  }

  // Las rutas del PC solo se aceptan si el usuario las eligió (diálogo o arrastrar y soltar).
  grant(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return;
    this.grants.set(path.resolve(p).toLowerCase(), Date.now());
    if (this.grants.size > 5000) this.grants.delete(this.grants.keys().next().value);
  }

  granted(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
    const t = this.grants.get(path.resolve(p).toLowerCase());
    return Boolean(t && Date.now() - t < 30 * 60 * 1000);
  }

  // ---------- Borradores ----------
  dirs() {
    const d = this.getDirs().admin;
    return { root: d, drafts: path.join(d, 'drafts'), media: path.join(d, 'media'), imports: path.join(d, 'imports') };
  }

  draftFile(id) {
    if (!ID_RE.test(id)) throw err('Identificador no válido: usa minúsculas, números y guiones (2-48 caracteres).', 'EBADID');
    return path.join(this.dirs().drafts, `${id}.json`);
  }

  async readDraft(id) { return readJson(this.draftFile(id)); }

  async writeDraft(d) {
    d.updatedAt = Date.now();
    await writeJsonAtomic(this.draftFile(d.id), d);
    return this.publicDraft(d);
  }

  publicDraft(d) {
    const files = d.files || [];
    return {
      ...d,
      stats: {
        files: files.length,
        size: files.reduce((a, f) => a + (f.size || 0), 0),
        pendingUpload: files.filter((f) => f.source === 'upload' && f.local).length,
        mods: files.filter((f) => f.path.startsWith('mods/')).length,
      },
    };
  }

  async list() {
    const out = { published: [], drafts: [] };
    try {
      const r = await this.call('/v1/admin/instances');
      out.published = r.instances || [];
    } catch (e) {
      out.error = e.message;
    }
    try {
      for (const f of await fsp.readdir(this.dirs().drafts)) {
        if (!f.endsWith('.json')) continue;
        const d = await readJson(path.join(this.dirs().drafts, f));
        if (d?.id) out.drafts.push({ id: d.id, name: d.meta?.name, updatedAt: d.updatedAt, baseVersion: d.baseVersion || 0, isNew: !d.baseVersion });
      }
    } catch { /* sin borradores */ }
    return out;
  }

  async create({ id, name, mc, loader }) {
    const clean = String(id || '').trim().toLowerCase();
    if (!ID_RE.test(clean)) throw err('Identificador no válido: usa minúsculas, números y guiones (2-48 caracteres).', 'EBADID');
    if (await exists(this.draftFile(clean))) throw err('Ya tienes un borrador con ese identificador.', 'EEXISTS');
    try {
      const r = await this.call(`/v1/admin/instances/${clean}`, { ok: [404] });
      if (r?.instance) throw err('Ya existe una instancia publicada con ese identificador.', 'EEXISTS');
    } catch (e) {
      if (e.code === 'EEXISTS') throw e;
    }
    const d = {
      id: clean, baseVersion: 0,
      meta: cleanMeta({ name, mc, loader, visibility: 'private' }, clean),
      media: { icon: null, background: null },
      files: [],
    };
    return this.writeDraft(d);
  }

  async open(id) {
    const local = await this.readDraft(id);
    if (local) return this.publicDraft(local);
    const r = await this.call(`/v1/admin/instances/${id}`);
    const inst = r.instance;
    const d = {
      id,
      baseVersion: r.manifest?.version || inst.version || 0,
      meta: cleanMeta(inst, id),
      media: {
        icon: inst.media?.icon ? { key: inst.media.icon } : null,
        background: inst.media?.background ? { key: inst.media.background, type: inst.media.backgroundType } : null,
      },
      files: (r.manifest?.files || []).map((f) => ({ ...f })),
    };
    return this.writeDraft(d);
  }

  async discard(id) {
    await fsp.rm(this.draftFile(id), { force: true });
    await rmrf(path.join(this.dirs().imports, id));
    return true;
  }

  async saveMeta(id, meta) {
    const d = await this.mustDraft(id);
    d.meta = cleanMeta({ ...d.meta, ...meta }, id);
    return this.writeDraft(d);
  }

  async mustDraft(id) {
    const d = await this.readDraft(id);
    if (!d) throw err('No se encontró el borrador. Ábrelo de nuevo.', 'ENODRAFT');
    d.files = d.files || [];
    return d;
  }

  upsertFile(d, entry) {
    const i = d.files.findIndex((f) => f.path.toLowerCase() === entry.path.toLowerCase());
    if (i >= 0) d.files[i] = { ...d.files[i], ...entry };
    else d.files.push(entry);
  }

  // Añade archivos del PC (targetDir: "mods", "config", "" para la raíz, etc.).
  async addLocal(id, paths, targetDir = '') {
    const d = await this.mustDraft(id);
    const base = normalizeRel(targetDir) || '';
    const added = [];
    for (const p of paths) {
      const st = await statOrNull(p);
      if (!st) continue;
      if (st.isDirectory()) {
        const name = path.basename(p);
        const rels = await listFiles(p, { skip: (rel) => rel.split('/').some((s) => s === '.git' || s === 'desktop.ini' || s === 'Thumbs.db') });
        await pool(rels, 6, async (rel) => {
          const target = normalizeRel(`${base ? `${base}/` : ''}${name}/${rel}`);
          if (!target) return;
          const file = path.join(p, ...rel.split('/'));
          const fst = await statOrNull(file);
          added.push({ path: target, sha1: await hashFile(file), size: fst.size, source: 'upload', local: file, policy: ONCE_FILES.has(target.toLowerCase()) ? 'once' : 'always' });
        });
      } else {
        const target = normalizeRel(`${base ? `${base}/` : ''}${path.basename(p)}`);
        if (!target) continue;
        added.push({ path: target, sha1: await hashFile(p), size: st.size, source: 'upload', local: p, policy: ONCE_FILES.has(target.toLowerCase()) ? 'once' : 'always' });
      }
    }
    for (const a of added) this.upsertFile(d, a);
    await this.writeDraft(d);
    return { added: added.length, draft: this.publicDraft(d) };
  }

  async addModrinth(id, { projectId, versionId }) {
    const d = await this.mustDraft(id);
    const added = [];
    const add = async (pid, vid, depth) => {
      const proj = await modrinth.project(pid);
      const type = proj.project_type;
      if (!TYPE_DIRS[type]) throw err(`No se pueden añadir proyectos de tipo "${type}".`);
      let v;
      if (vid) v = await modrinth.version(vid);
      else {
        const list = await modrinth.versions(proj.id, { mc: d.meta.mc, loader: d.meta.loader.type, type });
        v = list.find((x) => x.file && x.type === 'release') || list.find((x) => x.file);
      }
      if (!v?.file) {
        const what = type === 'mod' ? `Minecraft ${d.meta.mc} con ${LOADERS[d.meta.loader.type]?.name || d.meta.loader.type}` : `Minecraft ${d.meta.mc}`;
        throw err(`"${proj.title}" no tiene una versión para ${what}.`, 'ENOVERSION');
      }
      d.files = d.files.filter((f) => f.project !== proj.id);
      const entry = {
        path: `${TYPE_DIRS[type]}/${v.file.filename}`, sha1: v.file.sha1, size: v.file.size, source: 'modrinth', url: v.file.url,
        project: proj.id, versionId: v.id, title: proj.title, icon: proj.icon_url || null, versionName: v.number, policy: 'always',
      };
      this.upsertFile(d, entry);
      added.push(entry);
      if (type === 'mod' && depth < 3) {
        for (const dep of v.dependencies) {
          if (dep.type !== 'required' || !dep.projectId) continue;
          if (d.files.some((f) => f.project === dep.projectId)) continue;
          try { await add(dep.projectId, dep.versionId, depth + 1); } catch (e) { this.log.warn('Dependencia no añadida:', e.message); }
        }
      }
    };
    await add(projectId, versionId, 0);
    await this.writeDraft(d);
    return { added, draft: this.publicDraft(d) };
  }

  async updateFile(id, filePath, patch) {
    const d = await this.mustDraft(id);
    const f = d.files.find((x) => x.path === filePath);
    if (!f) throw err('Ese archivo ya no está en la instancia.');
    if (patch.policy) f.policy = patch.policy === 'once' ? 'once' : 'always';
    if (patch.path) {
      const n = normalizeRel(patch.path);
      if (!n) throw err('Ruta no válida');
      if (d.files.some((x) => x !== f && x.path.toLowerCase() === n.toLowerCase())) throw err('Ya hay un archivo con esa ruta.');
      f.path = n;
    }
    return this.writeDraft(d);
  }

  async removeFiles(id, paths) {
    const d = await this.mustDraft(id);
    const set = new Set(paths);
    d.files = d.files.filter((f) => !set.has(f.path) && !paths.some((p) => p.endsWith('/') && f.path.startsWith(p)));
    return this.writeDraft(d);
  }

  // bytes: imagen ya optimizada en la interfaz (o el GIF/vídeo original).
  async setMedia(id, kind, { bytes, type }) {
    if (!['icon', 'background'].includes(kind)) throw err('Tipo de imagen no válido');
    const ext = MEDIA_EXT[type];
    if (!ext) throw err('Formato no admitido. Usa PNG, JPG, WEBP, GIF, MP4 o WEBM.');
    if (kind === 'icon' && /^video/.test(type)) throw err('El icono debe ser una imagen o un GIF.');
    const buf = Buffer.from(bytes);
    const max = /^video/.test(type) ? 80 : ext === 'gif' ? 15 : 8;
    if (buf.length > max * 1024 * 1024) throw err(`El archivo es demasiado grande (máximo ${max} MB).`);
    const d = await this.mustDraft(id);
    const name = `${crypto.createHash('sha256').update(buf).digest('hex')}.${ext}`;
    const file = path.join(this.dirs().media, name);
    await ensureDir(this.dirs().media);
    if (!(await exists(file))) await fsp.writeFile(file, buf);
    d.media = d.media || {};
    d.media[kind] = { name, type, size: buf.length, local: true };
    return this.writeDraft(d);
  }

  async clearMedia(id, kind) {
    const d = await this.mustDraft(id);
    d.media = d.media || {};
    d.media[kind] = null;
    return this.writeDraft(d);
  }

  // ---------- Importar ----------
  async scanFolder(dir) {
    let root = dir;
    for (const sub of ['.minecraft', 'minecraft']) {
      if (await exists(path.join(dir, sub, 'mods')) || await exists(path.join(dir, sub, 'config'))) { root = path.join(dir, sub); break; }
    }
    const detected = await detectInstance(dir);
    const entries = [];
    for (const e of await fsp.readdir(root, { withFileTypes: true })) {
      const lower = e.name.toLowerCase();
      if (SKIP_TOP.has(lower) || lower.endsWith('.log')) continue;
      const p = path.join(root, e.name);
      let size = 0;
      let count = 1;
      if (e.isDirectory()) {
        const files = await listFiles(p);
        count = files.length;
        for (const f of files.slice(0, 5000)) size += (await statOrNull(path.join(p, ...f.split('/'))))?.size || 0;
        if (!count) continue;
      } else size = (await statOrNull(p))?.size || 0;
      entries.push({ name: e.name, dir: e.isDirectory(), size, count, suggested: SUGGESTED.has(lower) });
    }
    entries.sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.name.localeCompare(b.name));
    return { root, detected, entries };
  }

  // Importa una carpeta de instancia (CurseForge, Prism, Modrinth, .minecraft…).
  async importFolder(id, root, include) {
    const d = await this.mustDraft(id);
    const progress = this.startProgress(`import:${id}`, 'Importando instancia');
    try {
      const files = [];
      for (const name of include) {
        const p = path.join(root, name);
        const st = await statOrNull(p);
        if (!st) continue;
        if (st.isDirectory()) {
          for (const rel of await listFiles(p)) files.push({ rel: `${name}/${rel}`, file: path.join(p, ...rel.split('/')) });
        } else files.push({ rel: name, file: p });
      }
      progress.addTotal(0, files.length);
      progress.setPhase('hash', 'Analizando archivos…');
      const entries = [];
      await pool(files, 6, async (f) => {
        const rel = normalizeRel(f.rel);
        const st = await statOrNull(f.file);
        if (!rel || !st) return;
        entries.push({ path: rel, sha1: await hashFile(f.file), size: st.size, source: 'upload', local: f.file, policy: ONCE_FILES.has(rel.toLowerCase()) ? 'once' : 'always' });
        progress.fileDone();
      });
      progress.setPhase('modrinth', 'Buscando mods en Modrinth…');
      const jars = entries.filter((e) => /^(mods|resourcepacks|shaderpacks)\/[^/]+\.(jar|zip)$/i.test(e.path));
      const found = await modrinth.versionsByHashes(jars.map((j) => j.sha1)).catch(() => ({}));
      let fromModrinth = 0;
      for (const e of entries) {
        const v = found[e.sha1];
        if (v?.file?.url) {
          Object.assign(e, { source: 'modrinth', url: v.file.url, project: v.projectId, versionId: v.id, versionName: v.number });
          delete e.local;
          fromModrinth++;
        }
        this.upsertFile(d, e);
      }
      await this.writeDraft(d);
      return { total: entries.length, fromModrinth, uploads: entries.length - fromModrinth, draft: this.publicDraft(d) };
    } finally {
      this.stopProgress(`import:${id}`);
    }
  }

  // Importa un modpack de Modrinth (.mrpack) en un borrador nuevo o existente.
  async importMrpack(id, file) {
    const d = await this.mustDraft(id);
    const z = await openZip(file);
    try {
      const index = JSON.parse(await z.readText('modrinth.index.json') || 'null');
      if (!index?.files) throw err('El archivo no es un modpack de Modrinth válido.');
      const deps = index.dependencies || {};
      if (deps.minecraft) d.meta.mc = deps.minecraft;
      if (deps.forge) d.meta.loader = { type: 'forge', version: deps.forge };
      else if (deps.neoforge) d.meta.loader = { type: 'neoforge', version: deps.neoforge };
      else if (deps['fabric-loader']) d.meta.loader = { type: 'fabric', version: deps['fabric-loader'] };
      else if (deps['quilt-loader']) d.meta.loader = { type: 'quilt', version: deps['quilt-loader'] };
      if (index.name && (!d.meta.name || d.meta.name === d.id)) d.meta.name = String(index.name).slice(0, 60);
      let count = 0;
      for (const f of index.files) {
        if (f.env?.client === 'unsupported') continue;
        const rel = normalizeRel(f.path);
        const url = (f.downloads || []).find((u) => /^https:\/\//i.test(u));
        if (!rel || !url || !f.hashes?.sha1) continue;
        const host = new URL(url).host;
        this.upsertFile(d, {
          path: rel, sha1: f.hashes.sha1, size: f.fileSize, url, policy: 'always',
          source: host === 'cdn.modrinth.com' ? 'modrinth' : 'url',
        });
        count++;
      }
      const out = path.join(this.dirs().imports, id);
      for (const name of z.names()) {
        const m = /^(client-overrides|overrides)\/(.+[^/])$/.exec(name);
        if (!m) continue;
        const rel = normalizeRel(m[2]);
        if (!rel) continue;
        const dest = path.join(out, ...rel.split('/'));
        await z.extract(name, dest);
        const st = await statOrNull(dest);
        this.upsertFile(d, { path: rel, sha1: await hashFile(dest), size: st.size, source: 'upload', local: dest, policy: ONCE_FILES.has(rel.toLowerCase()) ? 'once' : 'always' });
        count++;
      }
      d.meta = cleanMeta(d.meta, id);
      await this.writeDraft(d);
      return { total: count, draft: this.publicDraft(d) };
    } finally {
      z.close();
    }
  }

  // ---------- Publicar ----------
  startProgress(key, label) {
    const p = new TaskProgress(key, { kind: 'admin' });
    p.setPhase('start', label);
    let last = 0;
    p.on('update', (s) => {
      if (Date.now() - last < 250) return;
      last = Date.now();
      this.emit('progress', s);
    });
    this.tasks.set(key, p);
    return p;
  }

  stopProgress(key) {
    const p = this.tasks.get(key);
    if (p) { this.emit('progress', { ...p.snapshot(), finished: true }); p.stop(); }
    this.tasks.delete(key);
  }

  async publish(id) {
    const d = await this.mustDraft(id);
    const meta = cleanMeta(d.meta, id);
    if (!meta.mc) throw err('Elige la versión de Minecraft.');
    if (meta.loader.type !== 'vanilla' && !meta.loader.version) throw err('Elige la versión del cargador de mods.');
    if (meta.visibility === 'private' && !meta.allow.length) throw err('Una instancia privada necesita al menos un nick con permiso.');
    const key = `publish:${id}`;
    if (this.tasks.has(key)) throw err('Ya se está publicando esta instancia.');
    const progress = this.startProgress(key, 'Preparando publicación…');
    try {
      const uploads = d.files.filter((f) => f.source === 'upload');
      const sha1s = [...new Set(uploads.map((f) => f.sha1.toLowerCase()))];
      const { missing = [] } = sha1s.length
        ? await this.call(`/v1/admin/instances/${id}/blobs/missing`, { method: 'POST', json: { sha1s }, timeout: 60000 })
        : {};
      const todo = [];
      for (const sha of missing) {
        const f = uploads.find((x) => x.sha1.toLowerCase() === sha && x.local);
        if (!f || !(await exists(f.local))) {
          const name = uploads.find((x) => x.sha1.toLowerCase() === sha)?.path || sha;
          throw err(`Falta el archivo local de "${name}". Vuelve a añadirlo.`, 'EMISSINGFILE');
        }
        const st = await statOrNull(f.local);
        if ((await hashFile(f.local)) !== sha) throw err(`"${f.path}" cambió desde que lo añadiste. Vuelve a añadirlo.`, 'ECHANGED');
        todo.push({ sha, file: f.local, size: st.size, name: f.path });
      }
      const mediaTodo = ['icon', 'background'].map((k) => [k, d.media?.[k]]).filter(([, m]) => m?.local);
      progress.addTotal(todo.reduce((a, t) => a + t.size, 0) + mediaTodo.reduce((a, [, m]) => a + (m.size || 0), 0), todo.length);
      progress.setPhase('upload', todo.length ? `Subiendo ${todo.length} archivo(s)…` : 'Subiendo imágenes…');
      await pool(todo, 3, async (t) => {
        await this.uploadBlob(id, t, progress);
        progress.fileDone();
      });
      await this.uploadMedia(id, d, progress);
      progress.setPhase('publish', 'Publicando…');
      const files = d.files.map(({ local, ...f }) => f);
      const r = await this.call(`/v1/admin/instances/${id}/publish`, {
        method: 'POST', timeout: 60000,
        json: {
          baseVersion: d.baseVersion || 0,
          meta,
          media: this.mediaNames(d),
          files,
        },
      });
      await this.discard(id);
      this.log.info(`Instancia publicada: ${id} v${r.instance?.version}`);
      return r.instance;
    } finally {
      this.stopProgress(key);
    }
  }

  // Sube el icono y el fondo nuevos (si los hay) y los deja en la caché local.
  async uploadMedia(id, d, progress) {
    for (const kind of ['icon', 'background']) {
      const m = d.media?.[kind];
      if (!m?.local) continue;
      const file = path.join(this.dirs().media, m.name);
      await send(this.backend.url(`/v1/admin/instances/${id}/media/${m.name}`), {
        headers: { ...(await this.uploadHeaders()), 'Content-Type': m.type }, body: await fsp.readFile(file), onBytes: (n) => progress?.addDone(n),
      });
      d.media[kind] = { key: `${id}/${m.name}`, type: m.type };
      await linkOrCopy(file, path.join(this.getDirs().media, id, m.name)).catch(() => {});
    }
  }

  mediaNames(d) {
    const out = {};
    for (const kind of ['icon', 'background']) {
      const m = d.media?.[kind];
      out[kind] = m?.key ? m.key.split('/')[1] : null;
    }
    return out;
  }

  async uploadHeaders() {
    const acc = this.accounts.active();
    const s = acc && this.sessions.get(acc.uuid);
    if (!s) throw err('Activa el modo administrador para continuar.', 'ELOCKED');
    return this.headers(acc, s.key);
  }

  async uploadBlob(id, t, progress) {
    const base = this.backend.url(`/v1/admin/instances/${id}/blobs/${t.sha}`);
    const headers = { ...(await this.uploadHeaders()), 'Content-Type': 'application/octet-stream' };
    const onBytes = (n) => progress.addDone(n);
    if (t.size <= SINGLE_MAX) {
      const body = await fsp.readFile(t.file);
      for (let attempt = 0; ; attempt++) {
        try {
          await send(base, { headers, body, onBytes });
          return;
        } catch (e) {
          progress.addDone(-body.length);
          if (attempt >= 2 || (e.status && e.status < 500)) throw err(`No se pudo subir "${t.name}": ${e.message}`);
        }
      }
    }
    const { uploadId } = await send(`${base}/mpu`, { method: 'POST', headers, body: Buffer.alloc(0) });
    const parts = [];
    for (let i = 0, n = 1; i < t.size; i += PART, n++) {
      const chunk = await readSlice(t.file, i, Math.min(PART, t.size - i));
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await send(`${base}/mpu/${encodeURIComponent(uploadId)}/${n}`, { headers, body: chunk, onBytes, timeout: 300000 });
          parts.push({ partNumber: n, etag: r.etag });
          break;
        } catch (e) {
          progress.addDone(-chunk.length);
          if (attempt >= 2) throw err(`No se pudo subir "${t.name}": ${e.message}`);
        }
      }
    }
    await send(`${base}/mpu/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ parts })),
    });
  }

  // Cambios rápidos sin volver a publicar archivos (visibilidad, permisos, textos…).
  async updateMeta(id, meta) {
    const d = await this.readDraft(id);
    const json = { meta: cleanMeta(meta, id) };
    if (d) {
      await this.uploadMedia(id, d, null);
      json.media = this.mediaNames(d);
    }
    const r = await this.call(`/v1/admin/instances/${id}/meta`, { method: 'PUT', json });
    if (d) { d.meta = cleanMeta({ ...d.meta, ...meta }, id); await this.writeDraft(d); }
    return r.instance;
  }

  async remove(id) {
    await this.call(`/v1/admin/instances/${id}`, { method: 'DELETE', timeout: 60000 });
    await this.discard(id);
    return true;
  }

  async offlineAccounts(search = '') {
    return this.call(`/v1/admin/offline-accounts?search=${encodeURIComponent(search)}`);
  }

  async releaseNick(name) {
    return this.call(`/v1/admin/offline-accounts/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }
}

// Detecta versión y cargador de carpetas de CurseForge, Prism/MultiMC o Modrinth App.
async function detectInstance(dir) {
  const cf = await readJson(path.join(dir, 'minecraftinstance.json'));
  if (cf?.gameVersion) {
    const name = cf.baseModLoader?.name || '';
    const m = /^(forge|neoforge|fabric|quilt)-(.+)$/.exec(name);
    let version = m?.[2] || '';
    if (m && version.startsWith(`${cf.gameVersion}-`)) version = version.slice(cf.gameVersion.length + 1);
    if (m?.[1] === 'fabric' || m?.[1] === 'quilt') version = version.replace(new RegExp(`-${cf.gameVersion}$`), '');
    return { source: 'CurseForge', name: cf.name, mc: cf.gameVersion, loader: m ? { type: m[1], version } : { type: 'vanilla', version: '' } };
  }
  const mmc = await readJson(path.join(dir, 'mmc-pack.json'));
  if (mmc?.components) {
    const c = (uid) => mmc.components.find((x) => x.uid === uid)?.version;
    const mc = c('net.minecraft');
    const map = [['net.minecraftforge', 'forge'], ['net.neoforged', 'neoforge'], ['net.fabricmc.fabric-loader', 'fabric'], ['org.quiltmc.quilt-loader', 'quilt']];
    const hit = map.find(([uid]) => c(uid));
    return { source: 'Prism Launcher', mc, loader: hit ? { type: hit[1], version: c(hit[0]) } : { type: 'vanilla', version: '' } };
  }
  const mr = await readJson(path.join(dir, 'profile.json'));
  if (mr?.metadata?.game_version) {
    const lt = mr.metadata.loader;
    return { source: 'Modrinth App', name: mr.metadata.name, mc: mr.metadata.game_version, loader: { type: LOADERS[lt] ? lt : 'vanilla', version: mr.metadata.loader_version?.id || '' } };
  }
  return null;
}

module.exports = { Admin, cleanMeta };
