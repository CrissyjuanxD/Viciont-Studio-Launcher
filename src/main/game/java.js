'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { getJson, cached } = require('../util/net');
const { readJson, writeJsonAtomic, exists, rmrf, ensureDir, hashFile } = require('../util/fsx');
const { withZip } = require('../util/zip');

const RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const PLATFORM = process.arch === 'arm64' ? 'windows-arm64' : process.arch === 'ia32' ? 'windows-x86' : 'windows-x64';
const ADOPTIUM_ARCH = process.arch === 'arm64' ? 'aarch64' : process.arch === 'ia32' ? 'x86' : 'x64';
const COMPONENT_FOR_MAJOR = { 8: 'jre-legacy', 16: 'java-runtime-alpha', 17: 'java-runtime-gamma', 21: 'java-runtime-delta' };

const binPaths = (dir) => ({ javaw: path.join(dir, 'bin', 'javaw.exe'), java: path.join(dir, 'bin', 'java.exe') });

async function planMojang(component, dirs, { signal, repair }) {
  let index;
  try {
    index = await cached('java-runtime-index', 60 * 60 * 1000, () => getJson(RUNTIME_INDEX, { timeout: 20000, signal }));
  } catch (e) {
    const dir = path.join(dirs.java, component);
    const bins = binPaths(dir);
    if (e.name !== 'AbortError' && (await readJson(path.join(dir, '.vsl-runtime.json'))) && (await exists(bins.javaw))) {
      return { items: [], post: null, result: { dir, ...bins, source: 'mojang' } };
    }
    throw e;
  }
  const entry = index?.[PLATFORM]?.[component]?.[0];
  if (!entry?.manifest?.url) return null;
  const dir = path.join(dirs.java, component);
  const marker = path.join(dir, '.vsl-runtime.json');
  const bins = binPaths(dir);
  const info = await readJson(marker);
  const result = { dir, ...bins, version: entry.version?.name, source: 'mojang' };
  if (!repair && info?.sha1 === entry.manifest.sha1 && (await exists(bins.javaw))) {
    return { items: [], post: null, result };
  }
  const manifest = await cached(`java-manifest:${entry.manifest.sha1}`, 60 * 60 * 1000,
    () => getJson(entry.manifest.url, { timeout: 30000, signal }));
  const items = [];
  const folders = [];
  for (const [rel, f] of Object.entries(manifest.files || {})) {
    if (f.type === 'directory') { folders.push(path.join(dir, ...rel.split('/'))); continue; }
    if (f.type !== 'file' || !f.downloads?.raw) continue;
    const raw = f.downloads.raw;
    items.push({ url: raw.url, dest: path.join(dir, ...rel.split('/')), sha1: raw.sha1, size: raw.size, label: `Java (${rel.split('/').pop()})` });
  }
  const post = async () => {
    for (const d of folders) await ensureDir(d);
    await writeJsonAtomic(marker, { sha1: entry.manifest.sha1, version: entry.version?.name, installedAt: Date.now() });
  };
  return { items, post, result };
}

async function planTemurin(major, dirs, { signal }) {
  const dir = path.join(dirs.java, `temurin-${major}`);
  const bins = binPaths(dir);
  const marker = path.join(dir, '.vsl-runtime.json');
  const result = { dir, ...bins, source: 'temurin' };
  if ((await readJson(marker)) && (await exists(bins.javaw))) return { items: [], post: null, result };
  let pkg = null;
  for (const image of ['jre', 'jdk']) {
    const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${ADOPTIUM_ARCH}&image_type=${image}&os=windows&vendor=eclipse`;
    const list = await getJson(url, { timeout: 20000, signal }).catch(() => []);
    pkg = list?.[0]?.binary?.package;
    if (pkg?.link) break;
  }
  if (!pkg?.link) throw new Error(`No hay Java ${major} disponible para este equipo`);
  const zip = path.join(dirs.caches, 'java', pkg.name || `temurin-${major}.zip`);
  const post = async () => {
    if (pkg.checksum && (await hashFile(zip, 'sha256')) !== pkg.checksum) {
      await fsp.rm(zip, { force: true });
      throw new Error('La descarga de Java llegó dañada, inténtalo de nuevo');
    }
    const tmp = `${dir}.tmp`;
    await rmrf(tmp);
    await withZip(zip, (z) => z.extractAll(tmp, { strip: 1 }));
    await rmrf(dir);
    await fsp.rename(tmp, dir);
    await writeJsonAtomic(marker, { major, installedAt: Date.now(), name: pkg.name });
    await fsp.rm(zip, { force: true });
  };
  return { items: [{ url: pkg.link, dest: zip, size: pkg.size, label: `Java ${major}` }], post, result };
}

async function planJava(javaVersion, dirs, { custom, signal, repair } = {}) {
  const major = javaVersion?.majorVersion || 8;
  if (custom) {
    const javaw = /java\.exe$/i.test(custom) ? custom.replace(/java\.exe$/i, 'javaw.exe') : custom;
    if (!(await exists(javaw))) throw new Error(`No se encontró el Java personalizado: ${custom}`);
    return { items: [], post: null, result: { javaw, java: javaw.replace(/javaw\.exe$/i, 'java.exe'), major, source: 'custom' } };
  }
  const component = javaVersion?.component || COMPONENT_FOR_MAJOR[major] || 'jre-legacy';
  let plan = null;
  try { plan = await planMojang(component, dirs, { signal, repair }); } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  if (!plan) plan = await planTemurin(major, dirs, { signal });
  plan.result.major = major;
  return plan;
}

function probeJava(javaPath) {
  const exe = javaPath.replace(/javaw\.exe$/i, 'java.exe');
  return new Promise((resolve) => {
    execFile(exe, ['-version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const m = /version "([^"]+)"/.exec(stderr || stdout);
      if (!m) return resolve(null);
      const v = m[1];
      const major = v.startsWith('1.') ? Number(v.split('.')[1]) : Number(v.split(/[.+-]/)[0]);
      resolve({ version: v, major });
    });
  });
}

module.exports = { planJava, probeJava };
