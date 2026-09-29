'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { getText } = require('../util/net');
const { readJson, writeJsonAtomic, exists, hashFile, ensureDir, rmrf } = require('../util/fsx');
const { downloadAll } = require('../util/downloader');
const { openZip, jarMainClass } = require('../util/zip');
const { mavenPath, libraryArtifact } = require('./rules');
const { versionJsonPath } = require('./versions');
const { resolveForgeFull } = require('./loaders');

const NAMES = { forge: 'Forge', neoforge: 'NeoForge' };

function libFile(dirs, coords) {
  return path.join(dirs.libraries, ...mavenPath(coords).split('/'));
}

function runJava(javaExe, args, cwd, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaExe, args, { cwd, windowsHide: true });
    let tail = '';
    const keep = (d) => { tail = (tail + d.toString()).slice(-6000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        const e = new Error('Operación cancelada');
        e.name = 'AbortError';
        return reject(e);
      }
      if (code === 0) resolve(tail);
      else {
        const e = new Error(`Un paso de la instalación falló (código ${code})`);
        e.output = tail;
        reject(e);
      }
    });
  });
}

const stripQuotes = (v) => (typeof v === 'string' && v.length >= 2 && v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1) : v);

async function planForge({ type, mc, version, dirs, signal, repair }) {
  const name = NAMES[type];
  const mapFile = path.join(dirs.versions, 'vsl-loaders.json');
  const map = (await readJson(mapFile)) || {};
  const key = `${type}:${mc}:${version}`;
  const known = map[key];
  if (known && !repair && (await exists(versionJsonPath(dirs, known))) &&
      (await exists(path.join(dirs.versions, known, '.vsl-forge.json')))) {
    return { id: known, items: [], post: null };
  }

  const { full, url } = await resolveForgeFull(type, mc, version);
  const installer = path.join(dirs.caches, 'installers', `${type}-${full}-installer.jar`);
  let sha1 = null;
  try { sha1 = (await getText(`${url}.sha1`, { timeout: 10000, retries: 1, signal })).trim().slice(0, 40).toLowerCase(); } catch { sha1 = null; }
  if (sha1 && !/^[a-f0-9]{40}$/.test(sha1)) sha1 = null;
  await downloadAll([{ url, dest: installer, sha1, label: `instalador de ${name}` }], { signal, verify: sha1 ? 'hash' : 'size' });

  const zip = await openZip(installer);
  let closeZip = true;
  try {
    const profile = JSON.parse(await zip.readText('install_profile.json'));

    if (profile.versionInfo) {
      const vi = { ...profile.versionInfo };
      const inst = profile.install || {};
      vi.inheritsFrom = vi.inheritsFrom || inst.minecraft || mc;
      vi.jar = vi.jar || inst.minecraft || mc;
      await writeJsonAtomic(versionJsonPath(dirs, vi.id), vi);
      if (inst.path && inst.filePath) {
        const dest = libFile(dirs, inst.path);
        if (repair || !(await exists(dest))) await zip.extract(inst.filePath, dest);
      }
      await writeJsonAtomic(path.join(dirs.versions, vi.id, '.vsl-forge.json'), { type, full, at: Date.now() });
      map[key] = vi.id;
      await writeJsonAtomic(mapFile, map);
      return { id: vi.id, items: [], post: null };
    }

    const versionJson = JSON.parse(await zip.readText(String(profile.json || '/version.json').replace(/^\//, '')));
    const id = versionJson.id;
    await writeJsonAtomic(versionJsonPath(dirs, id), versionJson);

    const items = new Map();
    const bundled = [];
    for (const lib of [...(profile.libraries || []), ...(versionJson.libraries || [])]) {
      if (!lib?.name) continue;
      const a = libraryArtifact(lib);
      if (!a) continue;
      const dest = path.join(dirs.libraries, ...a.path.split('/'));
      const inJar = `maven/${a.path}`;
      if (zip.has(inJar)) { bundled.push({ inJar, dest, sha1: a.sha1 }); continue; }
      if (!a.url) continue;
      items.set(dest.toLowerCase(), { url: a.url, dest, sha1: a.sha1, size: a.size, label: lib.name });
    }

    closeZip = false;
    const post = async (java, progress) => {
      const z = zip;
      try {
        for (const b of bundled) {
          const ok = (await exists(b.dest)) && (!b.sha1 || (await hashFile(b.dest)) === b.sha1);
          if (!ok) await z.extract(b.inJar, b.dest);
        }
        const tmp = path.join(dirs.caches, 'forge-tmp', full);
        await rmrf(tmp);
        await ensureDir(tmp);
        const data = {
          SIDE: 'client',
          MINECRAFT_JAR: path.join(dirs.versions, mc, `${mc}.jar`),
          MINECRAFT_VERSION: profile.minecraft || mc,
          ROOT: dirs.meta,
          INSTALLER: installer,
          LIBRARY_DIR: dirs.libraries,
        };
        for (const [k, v] of Object.entries(profile.data || {})) {
          let val = v?.client ?? '';
          if (val.startsWith('[') && val.endsWith(']')) val = libFile(dirs, val.slice(1, -1));
          else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
          else if (val.startsWith('/')) {
            const dest = path.join(tmp, ...val.slice(1).split('/'));
            await z.extract(val.slice(1), dest);
            val = dest;
          }
          data[k] = val;
        }
        const resolve = (a) => {
          if (typeof a !== 'string') return a;
          if (a.startsWith('[') && a.endsWith(']')) return libFile(dirs, a.slice(1, -1));
          return a.replace(/\{([A-Z0-9_]+)\}/g, (m, k) => (k in data ? data[k] : m));
        };
        const procs = (profile.processors || []).filter((p) => !p.sides || p.sides.includes('client'));
        let n = 0;
        for (const proc of procs) {
          n++;
          progress?.setPhase('loader', `Instalando ${name} (${n}/${procs.length})`);
          const outputs = Object.entries(proc.outputs || {}).map(([k, v]) => [resolve(k), stripQuotes(resolve(v))]);
          if (outputs.length) {
            let allOk = true;
            for (const [file, sha] of outputs) {
              if (!(await exists(file)) || (await hashFile(file)) !== String(sha).toLowerCase()) { allOk = false; break; }
            }
            if (allOk) continue;
          }
          const jar = libFile(dirs, proc.jar);
          const cp = [jar, ...(proc.classpath || []).map((c) => libFile(dirs, c))];
          const main = await jarMainClass(jar);
          if (!main) throw new Error(`El instalador de ${name} está incompleto (${proc.jar})`);
          const args = (proc.args || []).map(resolve);
          try {
            await runJava(java.java, ['-cp', cp.join(path.delimiter), main, ...args], tmp, signal);
          } catch (e) {
            if (e.name !== 'AbortError') e.message = `No se pudo instalar ${name}: ${e.message}`;
            throw e;
          }
          for (const [file, sha] of outputs) {
            if (!(await exists(file)) || (await hashFile(file)) !== String(sha).toLowerCase()) {
              throw new Error(`No se pudo instalar ${name}: un archivo generado no es correcto (${path.basename(file)})`);
            }
          }
        }
        await rmrf(tmp);
        await writeJsonAtomic(path.join(dirs.versions, id, '.vsl-forge.json'), { type, full, at: Date.now() });
        map[key] = id;
        await writeJsonAtomic(mapFile, map);
      } finally {
        z.close();
      }
    };
    return { id, items: [...items.values()], post, dispose: () => zip.close() };
  } finally {
    if (closeZip) zip.close();
  }
}

module.exports = { planForge };
