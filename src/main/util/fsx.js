'use strict';
// Utilidades de sistema de archivos con escrituras atómicas (nunca dejan
// un archivo a medias aunque el launcher se cierre o se vaya la luz).

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { isMainThread } = require('node:worker_threads');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function statOrNull(p) {
  try { return await fsp.stat(p); } catch { return null; }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJson(p, fallback = null) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fallback; }
}

function readJsonSync(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// En Windows el antivirus o el indexador pueden bloquear un archivo un instante.
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return await fsp.rename(from, to); } catch (e) {
      if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(40 * 2 ** i);
    }
  }
}

async function writeFileAtomic(p, data) {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await renameRetry(tmp, p);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

function writeFileAtomicSync(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

const writeJsonAtomic = (p, obj) => writeFileAtomic(p, JSON.stringify(obj, null, 2));
const writeJsonAtomicSync = (p, obj) => writeFileAtomicSync(p, JSON.stringify(obj, null, 2));

// En el proceso principal el SHA-1 se calcula en el hilo de descargas (no traba la ventana).
let offload = null;
function hashFile(p, algo = 'sha1') {
  if (isMainThread) {
    offload ??= require('./offload');
    if (offload.available()) return offload.hash(p, algo, hashFileLocal);
  }
  return hashFileLocal(p, algo);
}

function hashFileLocal(p, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(p, { highWaterMark: 1 << 20 });
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

const hashBuffer = (buf, algo = 'sha1') => crypto.createHash(algo).update(buf).digest('hex');

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 });
}

// Une rutas impidiendo salir de la carpeta raíz ("../", rutas absolutas, etc.).
function safeJoin(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/');
  if (!clean || clean.includes('\0') || /^[a-zA-Z]:/.test(clean) || clean.startsWith('/')) {
    throw new Error(`Ruta no permitida: ${rel}`);
  }
  const base = path.resolve(root);
  const target = path.resolve(base, clean);
  const a = (base + path.sep).toLowerCase();
  if (!target.toLowerCase().startsWith(a)) throw new Error(`Ruta no permitida: ${rel}`);
  return target;
}

// Normaliza una ruta relativa de instancia ("mods/x.jar"), o null si no es válida.
function normalizeRel(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (!parts.length || parts.some((s) => s === '..' || /[<>:"|?*\x00-\x1f]/.test(s))) return null;
  return parts.join('/');
}

async function dirSize(dir) {
  let total = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      if (e.isFile()) {
        const st = await statOrNull(p);
        if (st) total += st.size;
      }
    }));
  };
  await walk(dir);
  return total;
}

// Lista archivos de forma recursiva devolviendo rutas relativas con "/".
async function listFiles(dir, { skip } = {}) {
  const out = [];
  const walk = async (d, rel) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip && skip(r, e)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, r);
      else if (e.isFile()) out.push(r);
    }
  };
  await walk(dir, '');
  return out;
}

// Crea un enlace duro (no ocupa espacio extra) o copia si no se puede.
async function linkOrCopy(src, dest) {
  await ensureDir(path.dirname(dest));
  await fsp.rm(dest, { force: true });
  try { await fsp.link(src, dest); } catch { await fsp.copyFile(src, dest); }
}

module.exports = {
  sleep, exists, statOrNull, ensureDir, readJson, readJsonSync, renameRetry,
  writeFileAtomic, writeFileAtomicSync, writeJsonAtomic, writeJsonAtomicSync,
  hashFile, hashFileLocal, hashBuffer, rmrf, safeJoin, normalizeRel, dirSize, listFiles, linkOrCopy,
};
