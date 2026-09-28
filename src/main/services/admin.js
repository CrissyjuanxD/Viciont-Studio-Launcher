'use strict';
// Administración de instancias. Doble llave:
//   1. El nick tiene que tener permisos concedidos desde el panel web del estudio.
//   2. Hay que escribir la clave personal de ese nick (la genera el panel).
// Cada petición va con la sesión del jugador + su clave, y el servidor comprueba los permisos.
//
// Instancia sincronizada: la carpeta de la instancia en el PC del administrador es la fuente.
// Se juega y se modifica como cualquier instancia (mods, configs, options.txt…) y al publicar el
// launcher compara con lo publicado: solo sube lo nuevo o cambiado y quita lo que ya no está.
// Los textos, imágenes y permisos se guardan aparte como borrador hasta que se publican.

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { shell } = require('electron');
const { readJson, writeJsonAtomic, exists, statOrNull, hashFile, hashBuffer, ensureDir, normalizeRel, safeJoin, rmrf, listFiles, linkOrCopy } = require('../util/fsx');
const { pool, downloadAll } = require('../util/downloader');
const { getText } = require('../util/net');
const { TaskProgress } = require('../util/progress');
const { send, readSlice } = require('../util/upload');
const { openZip } = require('../util/zip');
const kv = require('../util/kvfile');
const { readSecure, writeSecure } = require('../core/secure');
const { configFile } = require('../core/paths');
const { NICK_RE } = require('../auth/offline');
const modrinth = require('./modrinth');
const { LOADERS } = require('../game/loaders');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const KEY_FILE = configFile('admin.dat');
const SINGLE_MAX = 64 * 1024 * 1024;
const PART = 48 * 1024 * 1024;
const MIN_API = 3; // versión del servidor que entiende todo lo de la 1.1.0
const TYPE_DIRS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
// Se fusionan por claves al actualizar: el jugador solo recibe los ajustes que cambies tú.
const MERGE_FILES = new Set(['options.txt', 'optionsof.txt', 'optionsshaders.txt']);
// Solo se copian si el jugador no los tiene.
const ONCE_FILES = new Set(['servers.dat']);
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const MEDIA_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };
const PROTECTABLE = ['mods'];

// Carpetas y archivos de la instancia que nunca se publican (registros, cachés, cosas del launcher…).
const SKIP_TOP = new Set(['logs', 'crash-reports', 'screenshots', '.cache', 'cache', 'local', 'downloads', 'backups', '.vsl',
  'customskinloader', '.fabric', '.mixin.out', 'essential', 'usercache.json', 'usernamecache.json', 'launcher_profiles.json',
  'command_history.txt', 'patchouli_books', 'modernfix', '.curseclient', 'minecraftinstance.json', 'mmc-pack.json',
  'instance.cfg', 'profile.json', 'natives', 'libraries', 'versions', 'assets', 'icon.png', '.optifine', 'realms_persistence.json']);
// Lo que se publica por defecto si está en la carpeta.
const SUGGESTED = new Set(['mods', 'config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks', 'scripts', 'global_packs',
  'datapacks', 'options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat', 'fancymenu_data', 'customization', 'paxi',
  'openloader', 'resources', 'emotes']);
const IGNORE_FILE_RE = /(^|\/)(desktop\.ini|thumbs\.db|\.ds_store)$|\.(log|tmp|part)$|(^|\/)\.git(\/|$)/i;
const isCslPath = (rel) => /^mods\/[^/]*customskinloader[^/]*\.jar$/i.test(rel);
const topOf = (rel) => String(rel).split('/')[0];

function err(message, code) { return Object.assign(new Error(message), { code }); }

function cleanMeta(m = {}, id) {
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  const lt = m.loader && LOADERS[m.loader.type] ? m.loader.type : 'vanilla';
  const loader = { type: lt, version: lt === 'vanilla' ? '' : str(m.loader?.version, 60) };
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
    order: Math.max(-9999, Math.min(9999, Math.round(Number(m.order) || 0))),
    featured: Boolean(m.featured),
    accent: /^#[0-9a-f]{6}$/i.test(m.accent || '') ? m.accent : '',
    changelog: str(m.changelog, 2000),
    // lo que ven los jugadores: el botón "Carpeta" y los mods (se pueden ocultar con Fabric o Quilt)
    showFolder: m.showFolder !== false,
    protect: [...new Set((Array.isArray(m.protect) ? m.protect : []).filter((x) => PROTECTABLE.includes(x)))],
  };
}

const mediaFrom = (inst) => ({
  icon: inst?.media?.icon ? { key: inst.media.icon } : null,
  background: inst?.media?.background ? { key: inst.media.background, type: inst.media.backgroundType } : null,
});

const defaultPolicy = (rel) => {
  const lower = rel.toLowerCase();
  if (MERGE_FILES.has(lower)) return 'merge';
  if (ONCE_FILES.has(lower)) return 'once';
  return 'always';
};

// Política de un archivo: la que eligió el administrador, la publicada o la de siempre.
// (antes options.txt era "solo la primera vez"; ahora se fusiona por claves)
function inheritedPolicy(ws, rel) {
  const b = ws.base?.[rel]?.policy;
  if (b === 'once' && MERGE_FILES.has(rel.toLowerCase())) return 'merge';
  return b || defaultPolicy(rel);
}
const effPolicy = (ws, rel) => ws.policies?.[rel] || inheritedPolicy(ws, rel);

const sameFiles = (a, b) => {
  if (a.length !== b.length) return false;
  const m = new Map(b.map((f) => [f.path, String(f.sha1).toLowerCase()]));
  return a.every((f) => m.get(f.path) === String(f.sha1).toLowerCase());
};

function newWs(owner, baseVersion, base) {
  const include = new Set(SUGGESTED);
  for (const rel of Object.keys(base)) include.add(topOf(rel));
  return { owner: owner || null, baseVersion, base, include: [...include], policies: {}, known: {}, localKeys: {}, hash: {}, syncedAt: Date.now() };
}

class Admin extends EventEmitter {
  constructor({ getDirs, backend, accounts, instances, log }) {
    super();
    this.getDirs = getDirs;
    this.backend = backend;
    this.accounts = accounts;
    this.instances = instances;
    this.log = log;
    this.saved = {}; // cuenta → clave recordada (cifrada en admin.dat)
    this.sessions = new Map(); // cuenta → { key, nick, perms, scope }
    this.tasks = new Map();
    this.grants = new Map(); // rutas elegidas por el usuario (arrastrar y soltar / diálogos)
    this.pub = new Map(); // id → instancia publicada (null si no lo está)
    this.apiOk = 0;
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

  // El servidor tiene que estar actualizado para sincronizar, publicar y hacer copias de prueba.
  async ensureServer() {
    if (Date.now() - this.apiOk < 10 * 60 * 1000) return;
    const h = await this.backend.call('/v1/health', { timeout: 10000, retries: 1 });
    if (!(Number(h?.version) >= MIN_API)) {
      throw err('El servidor de Viciont Studios necesita actualizarse para esta versión del launcher: pega el código nuevo del servidor en Cloudflare y pulsa Deploy.', 'EOLDSERVER');
    }
    this.apiOk = Date.now();
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

  // ---------- Borrador de textos, imágenes y permisos ----------
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
    const out = { id: d.id, meta: d.meta, media: d.media || { icon: null, background: null }, updatedAt: Date.now() };
    if (Array.isArray(d.files)) out.files = d.files;
    await writeJsonAtomic(this.draftFile(d.id), out);
  }

  async fetchPublished(id) {
    const r = await this.call(`/v1/admin/instances/${id}`, { ok: [404] });
    const inst = r?.instance?.version ? r.instance : null;
    this.pub.set(id, inst);
    return inst ? r : null;
  }

  // Borrador actual (o los datos publicados si no hay cambios).
  async metaDraft(id) {
    const local = await this.readDraft(id);
    let inst = this.pub.get(id);
    if (inst === undefined) inst = (await this.fetchPublished(id).catch(() => null))?.instance || null;
    if (local) {
      const d = { id, meta: cleanMeta(local.meta, id), media: local.media || { icon: null, background: null } };
      if (Array.isArray(local.files)) d.files = local.files;
      return { d, inst };
    }
    if (!inst) throw err('No se encontró la instancia. Vuelve a abrirla.', 'ENODRAFT');
    return { d: { id, meta: cleanMeta(inst, id), media: mediaFrom(inst) }, inst };
  }

  // ¿Hay textos, imágenes o permisos sin publicar?
  metaDirty(d, inst) {
    if (!inst?.version) return true;
    if (JSON.stringify(cleanMeta(d.meta, d.id)) !== JSON.stringify(cleanMeta(inst, d.id))) return true;
    const pub = mediaFrom(inst);
    return ['icon', 'background'].some((k) => d.media?.[k]?.local || (d.media?.[k]?.key || null) !== (pub[k]?.key || null));
  }

  // Solo se guarda un borrador si de verdad hay algo distinto de lo publicado.
  async persistMeta(d, inst) {
    if (Array.isArray(d.files) || this.metaDirty(d, inst)) await this.writeDraft(d);
    else await fsp.rm(this.draftFile(d.id), { force: true });
  }

  async view(id, d, inst, { legacy = false, ws = true } = {}) {
    return {
      id,
      meta: d.meta,
      media: d.media || { icon: null, background: null },
      baseVersion: inst?.version || 0,
      published: Boolean(inst?.version),
      dirtyMeta: this.metaDirty(d, inst),
      legacy: legacy || Array.isArray(d.files),
      ...(ws ? { workspace: await this.wsStatus(id).catch((e) => ({ synced: false, error: e.message })) } : {}),
    };
  }

  async list() {
    const out = { published: [], drafts: [] };
    try {
      const r = await this.call('/v1/admin/instances');
      out.published = r.instances || [];
      for (const p of out.published) this.pub.set(p.id, p.version ? p : null);
    } catch (e) {
      out.error = e.message;
    }
    const drafts = new Map();
    try {
      for (const f of await fsp.readdir(this.dirs().drafts)) {
        if (!f.endsWith('.json')) continue;
        const d = await readJson(path.join(this.dirs().drafts, f));
        if (d?.id && ID_RE.test(d.id)) drafts.set(d.id, d);
      }
    } catch { /* sin borradores */ }
    const pubIds = new Set(out.published.map((p) => p.id));
    for (const p of out.published) {
      const d = drafts.get(p.id);
      const ws = await this.quickWs(p.id);
      const dirtyMeta = d ? Array.isArray(d.files) || this.metaDirty({ id: p.id, meta: d.meta, media: d.media }, p) : false;
      p.local = { synced: ws.synced, changes: ws.changes, behind: ws.synced && p.version > ws.baseVersion, dirtyMeta };
    }
    for (const [id, d] of drafts) {
      if (pubIds.has(id)) continue;
      const ws = await this.quickWs(id);
      out.drafts.push({ id, name: d.meta?.name, updatedAt: d.updatedAt, isNew: true, local: { synced: ws.synced, changes: ws.changes } });
    }
    return out;
  }

  async create({ id, name, mc, loader }) {
    const clean = String(id || '').trim().toLowerCase();
    if (!ID_RE.test(clean)) throw err('Identificador no válido: usa minúsculas, números y guiones (2-48 caracteres).', 'EBADID');
    if (await exists(this.draftFile(clean))) throw err('Ya tienes una instancia nueva con ese identificador.', 'EEXISTS');
    if (await exists(this.instances.stateFile(clean))) throw err('Ya hay una instancia con ese identificador en este PC.', 'EEXISTS');
    try {
      const r = await this.call(`/v1/admin/instances/${clean}`, { ok: [404] });
      if (r?.instance) throw err('Ya existe una instancia publicada con ese identificador.', 'EEXISTS');
    } catch (e) {
      if (e.code === 'EEXISTS') throw e;
    }
    const d = { id: clean, meta: cleanMeta({ name, mc, loader, visibility: 'private' }, clean), media: { icon: null, background: null } };
    this.pub.set(clean, null);
    await this.writeDraft(d);
    await this.initEmptyWs(clean, d.meta);
    return this.view(clean, d, null);
  }

  async open(id) {
    if (!ID_RE.test(id)) throw err('Identificador no válido', 'EBADID');
    const local = await this.readDraft(id);
    let pub = null;
    try { pub = await this.fetchPublished(id); } catch (e) { if (!local) throw e; }
    const inst = pub?.instance || null;
    if (!local && !inst) throw err('No se encontró la instancia.', 'ENOTFOUND');
    const d = local
      ? { id, meta: cleanMeta(local.meta, id), media: local.media || { icon: null, background: null }, ...(Array.isArray(local.files) ? { files: local.files } : {}) }
      : { id, meta: cleanMeta(inst, id), media: mediaFrom(inst) };
    // borradores de la 1.0.x: si sus archivos son los publicados, ya no hacen falta
    if (Array.isArray(d.files) && (!d.files.length || (inst && sameFiles(d.files, pub.manifest?.files || [])))) {
      delete d.files;
      await this.persistMeta(d, inst);
    }
    return this.view(id, d, inst);
  }

  // Descarta los cambios de textos, imágenes y permisos (los archivos de la carpeta no se tocan).
  async discard(id) {
    await fsp.rm(this.draftFile(id), { force: true });
    await rmrf(path.join(this.dirs().imports, id));
    return true;
  }

  async saveMeta(id, patch) {
    const { d, inst } = await this.metaDraft(id);
    d.meta = cleanMeta({ ...d.meta, ...patch }, id);
    await this.persistMeta(d, inst);
    if (patch.mc || patch.loader) {
      // la carpeta sincronizada juega con la versión y el cargador que elijas
      const st = await this.instances.readState(id);
      if (st?.workspace) await this.instances.writeState(id, { ...st, mc: d.meta.mc, loader: d.meta.loader });
    }
    return this.view(id, d, inst, { ws: false });
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
    const { d, inst } = await this.metaDraft(id);
    const name = `${crypto.createHash('sha256').update(buf).digest('hex')}.${ext}`;
    const file = path.join(this.dirs().media, name);
    await ensureDir(this.dirs().media);
    if (!(await exists(file))) await fsp.writeFile(file, buf);
    d.media = d.media || {};
    d.media[kind] = { name, type, size: buf.length, local: true };
    await this.persistMeta(d, inst);
    return this.view(id, d, inst, { ws: false });
  }

  async clearMedia(id, kind) {
    const { d, inst } = await this.metaDraft(id);
    d.media = d.media || {};
    d.media[kind] = null;
    await this.persistMeta(d, inst);
    return this.view(id, d, inst, { ws: false });
  }

  // ---------- Carpeta sincronizada ----------
  async mustWs(id) {
    const st = await this.instances.readState(id);
    if (!st?.workspace) throw err('Primero sincroniza esta instancia con tu PC.', 'ENOSYNC');
    return { st, dir: this.instances.gameDir(id) };
  }

  // Guarda la configuración de la carpeta sin pisar lo que el juego haya escrito entretanto.
  async saveWs(id, ws, patch = {}) {
    const cur = (await this.instances.readState(id)) || {};
    await this.instances.writeState(id, { ...cur, ...patch, workspace: ws });
  }

  includeTop(ws, name) {
    const lower = String(name).toLowerCase();
    if (!name || SKIP_TOP.has(lower)) return;
    if (!ws.include.some((x) => x.toLowerCase() === lower)) ws.include.push(name);
  }

  async baseText(id, rel) {
    return fsp.readFile(this.instances.baseCopy(id, rel), 'utf8').catch(() => null);
  }

  // Archivos de la carpeta que se publican (con su SHA-1; solo se recalcula lo que cambió).
  async scanWs(id, st) {
    const ws = st.workspace;
    const dir = this.instances.gameDir(id);
    const include = new Set((ws.include || []).map((x) => x.toLowerCase()));
    const owned = new Set(Object.entries(st.files || {}).filter(([, r]) => r.managedBy === 'launcher').map(([p]) => p.toLowerCase()));
    const files = new Map();
    const candidates = [];
    const rels = [];
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { /* carpeta vacía */ }
    for (const e of entries) {
      const lower = e.name.toLowerCase();
      if (SKIP_TOP.has(lower) || /\.(log|tmp)$/i.test(lower)) continue;
      if (!include.has(lower)) { candidates.push({ name: e.name, dir: e.isDirectory() }); continue; }
      if (e.isDirectory()) {
        for (const rel of await listFiles(path.join(dir, e.name), { skip: (r) => /(^|\/)\.git$/i.test(r) })) rels.push(`${e.name}/${rel}`);
      } else if (e.isFile()) rels.push(e.name);
    }
    const hash = ws.hash || {};
    const next = {};
    await pool(rels, 8, async (rel) => {
      if (IGNORE_FILE_RE.test(rel) || owned.has(rel.toLowerCase()) || isCslPath(rel) || !normalizeRel(rel)) return;
      const abs = path.join(dir, ...rel.split('/'));
      const s = await statOrNull(abs);
      if (!s) return;
      const c = hash[rel];
      const sha1 = c && c.size === s.size && Math.abs(c.mtime - s.mtimeMs) < 2 ? c.sha1 : await hashFile(abs).catch(() => null);
      if (!sha1) return;
      next[rel] = { size: s.size, mtime: s.mtimeMs, sha1 };
      files.set(rel, { path: rel, sha1, size: s.size, abs });
    });
    ws.hash = next;
    return { files, candidates };
  }

  // Cambios respecto a lo publicado.
  async diffWs(id, ws, scan) {
    const base = ws.base || {};
    const added = new Set();
    const modified = new Set();
    const merge = {};
    for (const [rel, f] of scan.files) {
      const b = base[rel];
      if (!b) { added.add(rel); continue; }
      const pol = effPolicy(ws, rel);
      if (b.sha1 === f.sha1) {
        if ((b.policy || 'always') !== pol) modified.add(rel);
        continue;
      }
      if (pol === 'merge') {
        const baseText = await this.baseText(id, rel);
        if (baseText != null) {
          const keys = kv.changedKeys(baseText, await fsp.readFile(f.abs, 'utf8').catch(() => ''), ws.localKeys?.[rel] || []);
          if (keys.length) merge[rel] = keys;
          if (keys.length || (b.policy || 'always') !== pol) modified.add(rel);
          continue;
        }
      }
      modified.add(rel);
    }
    const removed = Object.keys(base).filter((rel) => !scan.files.has(rel) && !isCslPath(rel));
    return { added, modified, removed, merge };
  }

  async quickWs(id) {
    try {
      const st = await this.instances.readState(id);
      if (!st?.workspace) return { synced: false, changes: 0 };
      const scan = await this.scanWs(id, st);
      const diff = await this.diffWs(id, st.workspace, scan);
      await this.saveWs(id, st.workspace);
      return { synced: true, baseVersion: st.workspace.baseVersion || 0, changes: diff.added.size + diff.modified.size + diff.removed.length };
    } catch {
      return { synced: false, changes: 0 };
    }
  }

  async wsStatus(id) {
    const st = await this.instances.readState(id);
    if (!st?.workspace) return { synced: false, installed: Boolean(st?.installedVersion), installedVersion: st?.installedVersion || 0 };
    const ws = st.workspace;
    const dir = this.instances.gameDir(id);
    const scan = await this.scanWs(id, st);
    const diff = await this.diffWs(id, ws, scan);
    await this.saveWs(id, ws);
    const remote = this.pub.get(id) || this.instances.remote.get(id) || null;
    const infoOf = (rel, sha1) => {
      const b = ws.base?.[rel];
      const k = ws.known?.[rel];
      return (b && b.sha1 === sha1 && b) || (k && k.sha1 === sha1 && k) || null;
    };
    const files = [...scan.files.values()].map((f) => {
      const m = infoOf(f.path, f.sha1);
      return {
        path: f.path, size: f.size,
        state: diff.added.has(f.path) ? 'added' : diff.modified.has(f.path) ? 'modified' : 'same',
        policy: effPolicy(ws, f.path),
        source: m?.url ? 'modrinth' : 'local',
        project: m?.project || null, title: m?.title || null, icon: m?.icon || null, versionName: m?.versionName || null,
      };
    });
    const removed = diff.removed.map((rel) => ({ path: rel, size: ws.base[rel].size || 0, title: ws.base[rel].title || null, icon: ws.base[rel].icon || null }));
    const candidates = [];
    for (const c of scan.candidates) {
      let size = 0;
      let count = 1;
      const p = path.join(dir, c.name);
      if (c.dir) {
        const list = await listFiles(p);
        count = list.length;
        if (!count) continue;
        for (const f of list.slice(0, 3000)) size += (await statOrNull(path.join(p, ...f.split('/'))))?.size || 0;
      } else size = (await statOrNull(p))?.size || 0;
      candidates.push({ ...c, size, count });
    }
    return {
      synced: true,
      dir,
      baseVersion: ws.baseVersion || 0,
      remoteVersion: remote?.version || 0,
      behind: Boolean(remote?.version && remote.version > (ws.baseVersion || 0)),
      files,
      removed,
      changes: { added: diff.added.size, modified: diff.modified.size, removed: diff.removed.length, total: diff.added.size + diff.modified.size + diff.removed.length },
      merge: diff.merge,
      include: ws.include,
      candidates,
    };
  }

  async initEmptyWs(id, meta) {
    const dir = this.instances.gameDir(id);
    await ensureDir(path.join(dir, '.vsl'));
    const prev = (await this.instances.readState(id)) || {};
    await this.instances.writeState(id, {
      ...prev,
      mc: meta.mc,
      loader: meta.loader,
      summary: { ...meta, id, version: 0 },
      installedVersion: 0,
      workspace: newWs(this.accounts.active()?.uuid, 0, {}),
    });
    this.instances.emitChange(id);
  }

  // Convierte la instancia en tu carpeta de trabajo: si ya está publicada, primero se descarga
  // (o se completa) la versión publicada, como la tendría cualquier jugador.
  async sync(id) {
    const cur = await this.instances.readState(id);
    if (cur?.workspace) return this.wsStatus(id);
    await this.ensureServer();
    const { d, inst } = await this.metaDraft(id);
    let base = {};
    let version = 0;
    if (inst?.version) {
      const pub = await this.fetchPublished(id);
      await this.instances.install(id);
      version = pub.manifest?.version || inst.version;
      base = Object.fromEntries((pub.manifest?.files || []).map((f) => [f.path, { ...f }]));
    } else {
      await ensureDir(path.join(this.instances.gameDir(id), '.vsl'));
    }
    const st = (await this.instances.readState(id)) || {};
    await this.instances.writeState(id, {
      ...st,
      mc: inst?.mc || d.meta.mc,
      loader: inst?.loader || d.meta.loader,
      summary: st.summary || { ...d.meta, id, version },
      installedVersion: version || st.installedVersion || 0,
      protected: false,
      workspace: newWs(this.accounts.active()?.uuid, version, base),
    });
    await this.fetchBaseCopies(id);
    if (Array.isArray(d.files)) await this.applyLegacy(id, d, inst);
    this.log.info(`Instancia sincronizada con la carpeta local: ${id} (versión ${version})`);
    this.instances.emitChange(id);
    return this.wsStatus(id);
  }

  // Copia de lo publicado de options.txt y parecidos (para saber qué ajustes cambias tú).
  async fetchBaseCopies(id) {
    const st = await this.instances.readState(id);
    const ws = st?.workspace;
    if (!ws) return;
    let token;
    for (const [rel, b] of Object.entries(ws.base || {})) {
      if (effPolicy(ws, rel) !== 'merge') continue;
      const file = this.instances.baseCopy(id, rel);
      if (await exists(file)) continue;
      try {
        if (token === undefined) token = (await this.instances.fetchManifest(id)).downloadToken || '';
        const url = b.source === 'upload' || !b.url ? this.instances.blobUrl(id, b.sha1, token) : b.url;
        const text = await getText(url, { timeout: 20000, retries: 1 });
        await ensureDir(path.dirname(file));
        await fsp.writeFile(file, text);
      } catch (e) {
        this.log.warn(`No se pudo guardar la copia publicada de ${rel}:`, e.message);
      }
    }
  }

  // Borradores de la 1.0.x (lista de archivos): se pasan a la carpeta sincronizada.
  async applyLegacy(id, d, inst) {
    const { st, dir } = await this.mustWs(id);
    const ws = st.workspace;
    const want = new Map(d.files.map((f) => [f.path, f]));
    for (const rel of Object.keys(ws.base)) {
      if (!want.has(rel)) await fsp.rm(safeJoin(dir, rel), { force: true }).catch(() => {});
    }
    const items = [];
    for (const f of d.files) {
      const rel = normalizeRel(f.path);
      if (!rel) continue;
      const dest = safeJoin(dir, rel);
      const s = await statOrNull(dest);
      if (!(s && s.size === f.size && (await hashFile(dest).catch(() => '')) === String(f.sha1).toLowerCase())) {
        if (f.local && (await exists(f.local))) {
          await ensureDir(path.dirname(dest));
          await fsp.copyFile(f.local, dest);
        } else if (f.url) {
          items.push({ url: f.url, dest, sha1: f.sha1, size: f.size, label: path.basename(rel), force: true });
        }
      }
      if (f.url) ws.known[rel] = { sha1: f.sha1, size: f.size, source: f.source === 'url' ? 'url' : 'modrinth', url: f.url, project: f.project, versionId: f.versionId, title: f.title, icon: f.icon, versionName: f.versionName };
      if (f.policy && f.policy !== inheritedPolicy(ws, rel) && !(f.policy === 'once' && MERGE_FILES.has(rel.toLowerCase()))) ws.policies[rel] = f.policy;
      this.includeTop(ws, topOf(rel));
    }
    if (items.length) await downloadAll(items, { concurrency: 4 });
    await this.saveWs(id, ws);
    delete d.files;
    await this.persistMeta(d, inst);
  }

  async trash(dir, rel) {
    const abs = safeJoin(dir, String(rel).replace(/\/+$/, ''));
    if (!(await exists(abs))) return;
    await shell.trashItem(abs).catch(() => rmrf(abs));
  }

  // Añade archivos o carpetas del PC a la carpeta sincronizada (targetDir: "mods", "config", "" = raíz…).
  async addLocal(id, paths, targetDir = '') {
    const { st, dir } = await this.mustWs(id);
    const ws = st.workspace;
    const base = normalizeRel(targetDir) || '';
    let added = 0;
    for (const p of paths) {
      const s = await statOrNull(p);
      if (!s) continue;
      const rel = normalizeRel(`${base ? `${base}/` : ''}${path.basename(p)}`);
      if (!rel) continue;
      const dest = safeJoin(dir, rel);
      if (path.resolve(p).toLowerCase() !== dest.toLowerCase()) {
        if (s.isDirectory()) {
          await fsp.cp(p, dest, { recursive: true, force: true, filter: (src) => !/(^|[\\/])(\.git|desktop\.ini|thumbs\.db)$/i.test(src) });
        } else {
          await ensureDir(path.dirname(dest));
          await fsp.copyFile(p, dest);
        }
      }
      added += s.isDirectory() ? (await listFiles(dest)).length : 1;
      this.includeTop(ws, topOf(rel));
    }
    await this.saveWs(id, ws);
    return { added, workspace: await this.wsStatus(id) };
  }

  // Descarga un mod, resource pack o shader de Modrinth (con sus dependencias) a la carpeta.
  async addModrinth(id, { projectId, versionId }) {
    const { st, dir } = await this.mustWs(id);
    const ws = st.workspace;
    const { d } = await this.metaDraft(id);
    const scan = await this.scanWs(id, st);
    const present = new Map(); // proyecto → archivo que ya está en la carpeta
    for (const [rel, f] of scan.files) {
      const m = [ws.known?.[rel], ws.base?.[rel]].find((x) => x?.project && x.sha1 === f.sha1);
      if (m) present.set(m.project, rel);
    }
    const added = [];
    const items = [];
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
      const rel = `${TYPE_DIRS[type]}/${v.file.filename}`;
      const old = present.get(proj.id);
      if (old && old !== rel) await this.trash(dir, old);
      present.set(proj.id, rel);
      ws.known[rel] = {
        sha1: v.file.sha1, size: v.file.size, source: 'modrinth', url: v.file.url, project: proj.id, versionId: v.id,
        title: proj.title, icon: proj.icon_url || null, versionName: v.number,
      };
      items.push({ url: v.file.url, dest: safeJoin(dir, rel), sha1: v.file.sha1, size: v.file.size, label: v.file.filename });
      this.includeTop(ws, TYPE_DIRS[type]);
      added.push({ title: proj.title, path: rel });
      if (type === 'mod' && depth < 3) {
        for (const dep of v.dependencies) {
          if (dep.type !== 'required' || !dep.projectId || present.has(dep.projectId)) continue;
          try { await add(dep.projectId, dep.versionId, depth + 1); } catch (e) { this.log.warn('Dependencia no añadida:', e.message); }
        }
      }
    };
    await add(projectId, versionId, 0);
    const key = `ws:${id}`;
    const progress = this.startProgress(key, 'Descargando de Modrinth…');
    try { await downloadAll(items, { concurrency: 4, progress }); } finally { this.stopProgress(key); }
    await this.saveWs(id, ws);
    return { added, workspace: await this.wsStatus(id) };
  }

  // Quita archivos o carpetas (van a la Papelera, por si acaso).
  async removeFiles(id, paths) {
    const { dir } = await this.mustWs(id);
    for (const p of paths) await this.trash(dir, p);
    return { workspace: await this.wsStatus(id) };
  }

  // Deshace los cambios de esos archivos: vuelven a estar como en la versión publicada.
  async restoreFiles(id, paths) {
    const { st, dir } = await this.mustWs(id);
    const ws = st.workspace;
    let token;
    const items = [];
    for (const rel of paths) {
      const b = ws.base?.[rel];
      if (!b) { await this.trash(dir, rel); continue; }
      const dest = safeJoin(dir, rel);
      if (effPolicy(ws, rel) === 'merge') {
        const text = await this.baseText(id, rel);
        if (text != null) {
          await ensureDir(path.dirname(dest));
          await fsp.writeFile(dest, text);
          if (ws.localKeys) delete ws.localKeys[rel];
          continue;
        }
      }
      let url = b.url;
      if (b.source === 'upload' || !url) {
        if (token === undefined) token = (await this.instances.fetchManifest(id)).downloadToken || '';
        url = this.instances.blobUrl(id, b.sha1, token);
      }
      items.push({ url, dest, sha1: b.sha1, size: b.size, label: path.basename(rel), force: true });
    }
    const key = `ws:${id}`;
    const progress = this.startProgress(key, 'Recuperando archivos…');
    try { if (items.length) await downloadAll(items, { concurrency: 4, progress }); } finally { this.stopProgress(key); }
    await this.saveWs(id, ws);
    return { workspace: await this.wsStatus(id) };
  }

  async setPolicy(id, rel, policy) {
    const { st, dir } = await this.mustWs(id);
    const ws = st.workspace;
    if (!['always', 'once', 'merge'].includes(policy)) throw err('Opción no válida');
    if (policy === 'merge') {
      const text = await fsp.readFile(safeJoin(dir, rel), 'utf8').catch(() => null);
      if (text == null || Buffer.byteLength(text) > 2 * 1024 * 1024 || !kv.looksLikeKv(text)) {
        throw err('Solo se pueden fusionar archivos de texto con ajustes "clave:valor" o "clave=valor", como options.txt.');
      }
    }
    ws.policies = ws.policies || {};
    if (policy === inheritedPolicy(ws, rel)) delete ws.policies[rel]; else ws.policies[rel] = policy;
    await this.saveWs(id, ws);
    if (policy === 'merge') await this.fetchBaseCopies(id);
    return { workspace: await this.wsStatus(id) };
  }

  // Elige qué carpetas o archivos de la raíz se publican.
  async setInclude(id, name, on) {
    const { st } = await this.mustWs(id);
    const ws = st.workspace;
    const lower = String(name || '').toLowerCase();
    if (!name || /[\\/]/.test(name) || SKIP_TOP.has(lower)) throw err('Esa carpeta no se puede publicar.');
    ws.include = ws.include.filter((x) => x.toLowerCase() !== lower);
    if (on) ws.include.push(String(name));
    await this.saveWs(id, ws);
    return { workspace: await this.wsStatus(id) };
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

  // Copia una instancia (CurseForge, Prism, Modrinth, .minecraft…) a la carpeta sincronizada.
  async importFolder(id, root, include) {
    const { st, dir } = await this.mustWs(id);
    const ws = st.workspace;
    if (path.resolve(root).toLowerCase() === path.resolve(dir).toLowerCase()) throw err('Esa ya es la carpeta de la instancia.');
    const key = `import:${id}`;
    const progress = this.startProgress(key, 'Copiando archivos…');
    try {
      const list = [];
      for (const name of include) {
        const p = path.join(root, name);
        const s = await statOrNull(p);
        if (!s) continue;
        if (s.isDirectory()) for (const rel of await listFiles(p)) list.push([`${name}/${rel}`, path.join(p, ...rel.split('/'))]);
        else list.push([name, p]);
      }
      progress.addTotal(0, list.length);
      let total = 0;
      await pool(list, 6, async ([rel, src]) => {
        const r = normalizeRel(rel);
        if (!r || IGNORE_FILE_RE.test(r)) return;
        const dest = safeJoin(dir, r);
        await ensureDir(path.dirname(dest));
        await fsp.copyFile(src, dest);
        total++;
        progress.fileDone();
      });
      for (const name of include) this.includeTop(ws, name);
      await this.saveWs(id, ws);
      return { total, workspace: await this.wsStatus(id) };
    } finally {
      this.stopProgress(key);
    }
  }

  // Descarga un modpack de Modrinth (.mrpack) en la carpeta sincronizada.
  async importMrpack(id, file) {
    const { st, dir } = await this.mustWs(id);
    const ws = st.workspace;
    const { d, inst } = await this.metaDraft(id);
    const z = await openZip(file);
    const key = `import:${id}`;
    const progress = this.startProgress(key, 'Descargando el modpack…');
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
      const items = [];
      for (const f of index.files) {
        if (f.env?.client === 'unsupported') continue;
        const rel = normalizeRel(f.path);
        const url = (f.downloads || []).find((u) => /^https:\/\//i.test(u));
        if (!rel || !url || !f.hashes?.sha1) continue;
        const m = /^https:\/\/cdn\.modrinth\.com\/data\/([A-Za-z0-9]+)\/versions\/([A-Za-z0-9]+)\//.exec(url);
        ws.known[rel] = m
          ? { sha1: f.hashes.sha1, size: f.fileSize, source: 'modrinth', url, project: m[1], versionId: m[2] }
          : { sha1: f.hashes.sha1, size: f.fileSize, source: 'url', url };
        items.push({ url, dest: safeJoin(dir, rel), sha1: f.hashes.sha1, size: f.fileSize, label: path.basename(rel) });
        this.includeTop(ws, topOf(rel));
      }
      // primero "overrides" y después "client-overrides" (tienen prioridad)
      let count = items.length;
      for (const prefix of ['overrides/', 'client-overrides/']) {
        for (const name of z.names()) {
          if (!name.startsWith(prefix) || name.endsWith('/')) continue;
          const rel = normalizeRel(name.slice(prefix.length));
          if (!rel) continue;
          await z.extract(name, safeJoin(dir, rel));
          this.includeTop(ws, topOf(rel));
          count++;
        }
      }
      await downloadAll(items, { concurrency: 6, progress });
      d.meta = cleanMeta(d.meta, id);
      await this.persistMeta(d, inst);
      await this.saveWs(id, ws, { mc: d.meta.mc, loader: d.meta.loader });
      return { total: count, workspace: await this.wsStatus(id) };
    } finally {
      z.close();
      this.stopProgress(key);
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

  // mergeKeys: { "options.txt": ["resourcePacks", …] } = ajustes que se aplican a los jugadores.
  // Los que no se marquen se quedan solo en tu PC (y no vuelven a salir como cambios).
  async publish(id, { mergeKeys = {} } = {}) {
    await this.ensureServer();
    const { st, dir } = await this.mustWs(id);
    const ws = st.workspace;
    const { d, inst } = await this.metaDraft(id);
    const meta = cleanMeta(d.meta, id);
    if (!meta.mc) throw err('Elige la versión de Minecraft.');
    if (meta.loader.type !== 'vanilla' && !meta.loader.version) throw err('Elige la versión del cargador de mods.');
    if (meta.visibility === 'private' && !meta.allow.length) throw err('Una instancia privada necesita al menos un nick con permiso.');
    if ((inst?.version || 0) !== (ws.baseVersion || 0)) {
      throw err(`Hay una versión más nueva publicada (v${inst?.version}). Pulsa "Traer cambios" antes de publicar.`, 'EBEHIND');
    }
    const key = `publish:${id}`;
    if (this.tasks.has(key)) throw err('Ya se está publicando esta instancia.');
    const progress = this.startProgress(key, 'Comprobando cambios…');
    const pubDir = path.join(dir, '.vsl', 'pub');
    try {
      const scan = await this.scanWs(id, st);
      const entries = [];
      const composed = new Map(); // archivo que se fusiona → texto que se publica
      const localKeys = { ...(ws.localKeys || {}) };
      const lookup = [];
      for (const f of scan.files.values()) {
        const policy = effPolicy(ws, f.path);
        const b = ws.base?.[f.path];
        let sha1 = f.sha1;
        let size = f.size;
        let local = f.abs;
        if (policy === 'merge') {
          const baseText = b ? await this.baseText(id, f.path) : null;
          const localText = await fsp.readFile(f.abs, 'utf8');
          let text = localText;
          if (baseText != null) {
            const changed = kv.changedKeys(baseText, localText, localKeys[f.path] || []);
            const pick = Array.isArray(mergeKeys[f.path]) ? new Set(mergeKeys[f.path]) : new Set(changed.filter((c) => !c.personal).map((c) => c.key));
            const mine = changed.filter((c) => !pick.has(c.key)).map((c) => c.key);
            if (mine.length) localKeys[f.path] = [...new Set([...(localKeys[f.path] || []), ...mine])];
            text = kv.compose(baseText, localText, changed.filter((c) => pick.has(c.key)).map((c) => c.key));
          }
          composed.set(f.path, text);
          const buf = Buffer.from(text, 'utf8');
          sha1 = hashBuffer(buf);
          size = buf.length;
          if (!(b && b.sha1 === sha1)) {
            local = path.join(pubDir, sha1);
            await ensureDir(pubDir);
            await fsp.writeFile(local, buf);
          }
        }
        if (b && b.sha1 === sha1) { entries.push({ ...b, policy }); continue; }
        const k = ws.known?.[f.path];
        if (k && k.sha1 === sha1 && k.url) {
          entries.push({ path: f.path, sha1, size, source: k.source === 'url' ? 'url' : 'modrinth', url: k.url, project: k.project, versionId: k.versionId, title: k.title, icon: k.icon, versionName: k.versionName, policy });
          continue;
        }
        const e = { path: f.path, sha1, size, source: 'upload', local, policy };
        if (/^(mods|resourcepacks|shaderpacks)\/[^/]+\.(jar|zip)$/i.test(f.path)) lookup.push(e);
        entries.push(e);
      }
      // lo que ya está en Modrinth se enlaza a su CDN (no ocupa espacio en tu servidor)
      progress.setPhase('modrinth', 'Buscando mods en Modrinth…');
      if (lookup.length) {
        const found = await modrinth.versionsByHashes(lookup.map((e) => e.sha1)).catch(() => ({}));
        for (const e of lookup) {
          const v = found[e.sha1];
          if (!v?.file?.url) continue;
          Object.assign(e, { source: 'modrinth', url: v.file.url, project: v.projectId, versionId: v.id, versionName: v.number });
          delete e.local;
        }
      }
      const untitled = [...new Set(entries.filter((e) => e.project && !e.title).map((e) => e.project))];
      if (untitled.length) {
        const projs = await modrinth.projects(untitled.slice(0, 500)).catch(() => []);
        const byId = new Map((projs || []).map((p) => [p.id, p]));
        for (const e of entries) {
          const p = e.project && !e.title ? byId.get(e.project) : null;
          if (p) { e.title = p.title; e.icon = p.icon_url || null; }
        }
      }

      const uploads = entries.filter((e) => e.source === 'upload');
      const sha1s = [...new Set(uploads.map((e) => e.sha1.toLowerCase()))];
      const { missing = [] } = sha1s.length
        ? await this.call(`/v1/admin/instances/${id}/blobs/missing`, { method: 'POST', json: { sha1s }, timeout: 60000 })
        : {};
      const todo = [];
      for (const sha of missing) {
        const e = uploads.find((x) => x.sha1.toLowerCase() === sha && x.local);
        if (!e || !(await exists(e.local))) throw err(`Falta el archivo "${uploads.find((x) => x.sha1 === sha)?.path || sha}" en tu carpeta.`, 'EMISSINGFILE');
        if ((await hashFile(e.local)) !== sha) throw err(`"${e.path}" cambió mientras se publicaba. Vuelve a intentarlo.`, 'ECHANGED');
        todo.push({ sha, file: e.local, size: (await statOrNull(e.local)).size, name: e.path });
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
      const files = entries.map(({ local, ...e }) => e);
      const r = await this.call(`/v1/admin/instances/${id}/publish`, {
        method: 'POST', timeout: 60000,
        json: { baseVersion: ws.baseVersion || 0, meta, media: this.mediaNames(d), files },
      });
      const version = r.instance?.version;
      // lo publicado pasa a ser la base de la carpeta
      for (const [rel, text] of composed) {
        const file = this.instances.baseCopy(id, rel);
        await ensureDir(path.dirname(file));
        await fsp.writeFile(file, text);
      }
      const now = (await this.instances.readState(id)) || st;
      const nws = { ...now.workspace, hash: ws.hash, baseVersion: version, base: Object.fromEntries(files.map((e) => [e.path, e])), localKeys };
      for (const rel of Object.keys(nws.known || {})) if (!scan.files.has(rel)) delete nws.known[rel];
      await this.instances.writeState(id, { ...now, workspace: nws, installedVersion: version, summary: r.instance, mc: meta.mc, loader: meta.loader });
      this.pub.set(id, r.instance);
      await this.discard(id);
      this.log.info(`Instancia publicada: ${id} v${version} (${uploads.length} archivos propios, ${todo.length} subidos)`);
      return r.instance;
    } finally {
      await rmrf(pubDir).catch(() => {});
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

  // Trae una versión que publicó otro administrador. Lo que cambiaste tú se respeta: si los dos
  // cambiasteis el mismo archivo, se queda el tuyo (y se avisa).
  async pull(id) {
    await this.ensureServer();
    const { st, dir } = await this.mustWs(id);
    const ws = st.workspace;
    const { instance, manifest, downloadToken } = await this.instances.fetchManifest(id);
    if (manifest.version <= (ws.baseVersion || 0)) return { conflicts: [], workspace: await this.wsStatus(id) };
    const scan = await this.scanWs(id, st);
    const R = new Map(manifest.files.map((f) => [f.path, f]));
    const B = ws.base || {};
    const conflicts = [];
    const items = [];
    const merges = [];
    for (const rel of new Set([...Object.keys(B), ...R.keys(), ...scan.files.keys()])) {
      if (isCslPath(rel) || !normalizeRel(rel)) continue;
      const b = B[rel]?.sha1;
      const r = R.get(rel)?.sha1;
      const l = scan.files.get(rel)?.sha1;
      if (r === b) continue; // el otro administrador no lo tocó
      const dest = safeJoin(dir, rel);
      const remoteUrl = () => this.instances.fileUrl(id, R.get(rel), downloadToken);
      if (l === b) {
        if (r === undefined) await this.trash(dir, rel);
        else if (remoteUrl()) items.push({ url: remoteUrl(), dest, sha1: r, size: R.get(rel).size, label: path.basename(rel), force: true });
        continue;
      }
      if (l === r) continue; // el mismo cambio en los dos lados
      if (l && r && effPolicy(ws, rel) === 'merge' && remoteUrl()) { merges.push({ rel, dest, url: remoteUrl() }); continue; }
      conflicts.push(rel);
    }
    const key = `ws:${id}`;
    const progress = this.startProgress(key, `Trayendo la versión ${manifest.version}…`);
    try {
      if (items.length) await downloadAll(items, { concurrency: 6, progress });
      for (const m of merges) {
        const remoteText = await getText(m.url, { timeout: 20000, retries: 1 });
        const baseText = await this.baseText(id, m.rel);
        await fsp.writeFile(m.dest, kv.merge3(await fsp.readFile(m.dest, 'utf8'), baseText, remoteText));
      }
    } finally { this.stopProgress(key); }
    const nws = { ...ws, baseVersion: manifest.version, base: Object.fromEntries(manifest.files.map((f) => [f.path, { ...f }])) };
    for (const rel of R.keys()) this.includeTop(nws, topOf(rel));
    // las copias base se renuevan con lo que se acaba de publicar
    for (const rel of Object.keys(nws.base)) if (effPolicy(nws, rel) === 'merge') await fsp.rm(this.instances.baseCopy(id, rel), { force: true });
    await this.saveWs(id, nws, { installedVersion: manifest.version, summary: instance, mc: manifest.mc, loader: manifest.loader });
    await this.fetchBaseCopies(id);
    this.pub.set(id, instance);
    this.instances.emitChange(id);
    return { conflicts, workspace: await this.wsStatus(id) };
  }

  // Copia de prueba: se instala como la de un jugador cualquiera (con los mods ocultos si toca).
  async testCopy(id) {
    await this.ensureServer();
    const pub = await this.fetchPublished(id);
    if (!pub) throw err('Publica la instancia antes de probarla como jugador.', 'ENOTPUBLISHED');
    const tid = `${id}~test`;
    this.instances.install(tid).catch((e) => this.log.warn(`Copia de prueba de ${id}:`, e.message));
    return tid;
  }

  // Deja de sincronizar: la carpeta se queda como una instalación normal de jugador.
  async unsync(id) {
    const st = await this.instances.readState(id);
    if (!st?.workspace) return true;
    if (!st.workspace.baseVersion) throw err('Esta instancia nunca se publicó: no se puede dejar de sincronizar.');
    const { workspace, ...rest } = st;
    await this.instances.writeState(id, { ...rest, installedVersion: workspace.baseVersion });
    this.instances.emitChange(id);
    return true;
  }

  // Cambios rápidos sin volver a publicar archivos (visibilidad, permisos, textos…).
  async updateMeta(id, meta) {
    const { d } = await this.metaDraft(id);
    d.meta = cleanMeta({ ...d.meta, ...meta }, id);
    await this.uploadMedia(id, d, null);
    const r = await this.call(`/v1/admin/instances/${id}/meta`, { method: 'PUT', json: { meta: d.meta, media: this.mediaNames(d) } });
    this.pub.set(id, r.instance);
    await this.persistMeta({ id, meta: d.meta, media: mediaFrom(r.instance) }, r.instance);
    return r.instance;
  }

  // Se borra del servidor; tu carpeta se queda (vuelve a ser una instancia sin publicar).
  async remove(id) {
    const { d } = await this.metaDraft(id).catch(() => ({ d: null }));
    await this.call(`/v1/admin/instances/${id}`, { method: 'DELETE', timeout: 60000 });
    this.pub.set(id, null);
    const st = await this.instances.readState(id);
    if (st?.workspace) {
      await this.instances.writeState(id, { ...st, installedVersion: 0, workspace: { ...st.workspace, baseVersion: 0, base: {} } });
      if (d) await this.writeDraft({ id, meta: d.meta, media: { icon: null, background: null } });
    } else {
      await this.discard(id);
    }
    return true;
  }

  async offlineAccounts(search = '') {
    return this.call(`/v1/admin/offline-accounts?search=${encodeURIComponent(search)}`);
  }

  async releaseNick(name) {
    return this.call(`/v1/admin/offline-accounts/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  // ---------- Almacenamiento del servidor (R2 + base de datos) ----------
  // null si el servidor todavía no sabe calcularlo (anterior a la API v4).
  async storage({ fresh = false } = {}) {
    const r = await this.call(`/v1/admin/storage${fresh ? '?fresh=1' : ''}`, { timeout: 90000, ok: [404] });
    return r?.ok ? r : null;
  }

  // Borra lo que ya no se usa: versiones anteriores, imágenes cambiadas, restos y skins sin usar.
  async cleanStorage() {
    return this.call('/v1/admin/storage/clean', { method: 'POST', json: {}, timeout: 120000 });
  }

  // Borra los registros de más de `days` días (0 = todos).
  async cleanLogs(days) {
    return this.call('/v1/admin/storage/logs', { method: 'POST', json: { olderThanDays: Math.max(0, Math.round(Number(days) || 0)) }, timeout: 60000 });
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
