'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { getJson, cached } = require('../util/net');
const { readJson, writeJsonAtomic, exists, rmrf, ensureDir, hashFile } = require('../util/fsx');
const { withZip } = require('../util/zip');

const RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const COMPONENT_FOR_MAJOR = { 8: 'jre-legacy', 16: 'java-runtime-alpha', 17: 'java-runtime-gamma', 21: 'java-runtime-delta' };
const OS = process.platform;

function mojangPlatform(arch) {
  if (OS === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  if (OS === 'linux') return arch === 'x64' ? 'linux' : arch === 'ia32' ? 'linux-i386' : null;
  return arch === 'arm64' ? 'windows-arm64' : arch === 'ia32' ? 'windows-x86' : 'windows-x64';
}

const adoptiumArch = (arch) => (arch === 'arm64' ? 'aarch64' : arch === 'ia32' ? 'x86' : 'x64');
const adoptiumOs = () => (OS === 'darwin' ? 'mac' : OS === 'linux' ? 'linux' : 'windows');
const runtimeDir = (dirs, name, arch) => path.join(dirs.java, arch === process.arch ? name : `${name}-${arch}`);

function binPaths(dir, layout) {
  if (OS === 'win32') return { javaw: path.join(dir, 'bin', 'javaw.exe'), java: path.join(dir, 'bin', 'java.exe') };
  let home = dir;
  if (OS === 'darwin') home = layout === 'mojang' ? path.join(dir, 'jre.bundle', 'Contents', 'Home') : path.join(dir, 'Contents', 'Home');
  const bin = path.join(home, 'bin', 'java');
  return { javaw: bin, java: bin };
}

function javaEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const appDir = OS === 'linux' && env.APPIMAGE && env.APPDIR;
  if (appDir) {
    for (const k of ['LD_LIBRARY_PATH', 'PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
      const kept = String(env[k] || '').split(':').filter((p) => p && !p.startsWith(appDir));
      if (kept.length) env[k] = kept.join(':');
      else delete env[k];
    }
  }
  return env;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
  });
}

async function planMojang(component, dirs, { signal, repair, arch }) {
  const dir = runtimeDir(dirs, component, arch);
  const bins = binPaths(dir, 'mojang');
  let index;
  try {
    index = await cached('java-runtime-index', 60 * 60 * 1000, () => getJson(RUNTIME_INDEX, { timeout: 20000, signal }));
  } catch (e) {
    if (e.name !== 'AbortError' && (await readJson(path.join(dir, '.vsl-runtime.json'))) && (await exists(bins.javaw))) {
      return { items: [], post: null, result: { dir, ...bins, source: 'mojang' } };
    }
    throw e;
  }
  const entry = index?.[mojangPlatform(arch)]?.[component]?.[0];
  if (!entry?.manifest?.url) return null;
  const marker = path.join(dir, '.vsl-runtime.json');
  const info = await readJson(marker);
  const result = { dir, ...bins, version: entry.version?.name, source: 'mojang' };
  if (!repair && info?.sha1 === entry.manifest.sha1 && (await exists(bins.javaw))) {
    return { items: [], post: null, result };
  }
  const manifest = await cached(`java-manifest:${entry.manifest.sha1}`, 60 * 60 * 1000,
    () => getJson(entry.manifest.url, { timeout: 30000, signal }));
  const items = [];
  const folders = [];
  const executables = [];
  const links = [];
  for (const [rel, f] of Object.entries(manifest.files || {})) {
    const dest = path.join(dir, ...rel.split('/'));
    if (f.type === 'directory') { folders.push(dest); continue; }
    if (f.type === 'link' && f.target) { links.push({ dest, target: f.target }); continue; }
    if (f.type !== 'file' || !f.downloads?.raw) continue;
    const raw = f.downloads.raw;
    items.push({ url: raw.url, dest, sha1: raw.sha1, size: raw.size, label: `Java (${rel.split('/').pop()})` });
    if (f.executable) executables.push(dest);
  }
  const post = async () => {
    for (const d of folders) await ensureDir(d);
    if (OS !== 'win32') {
      for (const f of executables) await fsp.chmod(f, 0o755).catch(() => {});
      for (const l of links) {
        await ensureDir(path.dirname(l.dest));
        await fsp.rm(l.dest, { force: true }).catch(() => {});
        await fsp.symlink(l.target, l.dest).catch(() => {});
      }
    }
    await writeJsonAtomic(marker, { sha1: entry.manifest.sha1, version: entry.version?.name, installedAt: Date.now() });
  };
  return { items, post, result };
}

async function planTemurin(major, dirs, { signal, arch }) {
  const dir = runtimeDir(dirs, `temurin-${major}`, arch);
  const bins = binPaths(dir, 'temurin');
  const marker = path.join(dir, '.vsl-runtime.json');
  const result = { dir, ...bins, source: 'temurin' };
  if ((await readJson(marker)) && (await exists(bins.javaw))) return { items: [], post: null, result };
  let pkg = null;
  for (const image of ['jre', 'jdk']) {
    const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${adoptiumArch(arch)}&image_type=${image}&os=${adoptiumOs()}&vendor=eclipse`;
    const list = await getJson(url, { timeout: 20000, signal }).catch(() => []);
    pkg = list?.[0]?.binary?.package;
    if (pkg?.link) break;
  }
  if (!pkg?.link) throw new Error(`No hay Java ${major} disponible para este equipo`);
  const archive = path.join(dirs.caches, 'java', pkg.name || `temurin-${major}.${OS === 'win32' ? 'zip' : 'tar.gz'}`);
  const post = async () => {
    if (pkg.checksum && (await hashFile(archive, 'sha256')) !== pkg.checksum) {
      await fsp.rm(archive, { force: true });
      throw new Error('La descarga de Java llegó dañada, inténtalo de nuevo');
    }
    const tmp = `${dir}.tmp`;
    await rmrf(tmp);
    if (/\.zip$/i.test(archive)) {
      await withZip(archive, (z) => z.extractAll(tmp, { strip: 1 }));
    } else {
      await ensureDir(tmp);
      await run('tar', ['-xzf', archive, '-C', tmp, '--strip-components=1']);
    }
    await rmrf(dir);
    await fsp.rename(tmp, dir);
    await writeJsonAtomic(marker, { major, installedAt: Date.now(), name: pkg.name });
    await fsp.rm(archive, { force: true });
  };
  return { items: [{ url: pkg.link, dest: archive, size: pkg.size, label: `Java ${major}` }], post, result };
}

async function planJava(javaVersion, dirs, { custom, signal, repair, arch = process.arch } = {}) {
  const major = javaVersion?.majorVersion || 8;
  if (custom) {
    const javaw = /java\.exe$/i.test(custom) ? custom.replace(/java\.exe$/i, 'javaw.exe') : custom;
    if (!(await exists(javaw))) throw new Error(`No se encontró el Java personalizado: ${custom}`);
    return { items: [], post: null, result: { javaw, java: javaw.replace(/javaw\.exe$/i, 'java.exe'), major, source: 'custom' } };
  }
  const component = javaVersion?.component || COMPONENT_FOR_MAJOR[major] || 'jre-legacy';
  let plan = null;
  try { plan = await planMojang(component, dirs, { signal, repair, arch }); } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  if (!plan) plan = await planTemurin(major, dirs, { signal, arch });
  plan.result.major = major;
  plan.result.arch = arch;
  return plan;
}

function probeJava(javaPath) {
  const exe = javaPath.replace(/javaw\.exe$/i, 'java.exe');
  return new Promise((resolve) => {
    execFile(exe, ['-version'], { timeout: 8000, windowsHide: true, env: javaEnv() }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const m = /version "([^"]+)"/.exec(stderr || stdout);
      if (!m) return resolve(null);
      const v = m[1];
      const major = v.startsWith('1.') ? Number(v.split('.')[1]) : Number(v.split(/[.+-]/)[0]);
      resolve({ version: v, major });
    });
  });
}

module.exports = { planJava, probeJava, mojangPlatform, binPaths, javaEnv };
