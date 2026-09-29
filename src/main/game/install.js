'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { exists, readJson, writeJsonAtomic, rmrf, ensureDir, linkOrCopy } = require('../util/fsx');
const { withZip } = require('../util/zip');
const { ensureVanillaJson, resolveVersion } = require('./versions');
const { resolveLibraries, libraryArtifact, libraryNatives, isModernNative, parseMaven } = require('./rules');
const { planJava } = require('./java');
const { planAssets } = require('./assets');
const { installFabricLike } = require('./loaders');
const { planForge } = require('./forge');

const NATIVE_FILE = process.platform === 'win32' ? /\.dll$/i : process.platform === 'darwin' ? /\.(dylib|jnilib)$/i : /\.so(\.\d+)*$/i;

function nativeArch(lib) {
  const c = parseMaven(lib.name).classifier || '';
  if (/-(arm64|aarch64|aarch_64)$/.test(c)) return 'arm64';
  if (/-arm(32)?$/.test(c)) return 'arm';
  if (/-(x86|i386)$/.test(c)) return 'ia32';
  return 'x64';
}

function gameArch(libraries) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return process.arch;
  return libraries.some((l) => /:natives-macos-arm64$/.test(l.name)) ? 'arm64' : 'x64';
}

async function extractNatives(list, dir) {
  const marker = path.join(dir, '.vsl-natives.json');
  const key = list.map((n) => n.file).sort().join('|');
  const info = await readJson(marker);
  if (info?.key === key) return;
  await rmrf(dir);
  await ensureDir(dir);
  for (const n of list) {
    if (!(await exists(n.file))) continue;
    await withZip(n.file, (z) => z.extractAll(dir, {
      filter: (name) => NATIVE_FILE.test(name) && !(n.exclude || []).some((ex) => name.startsWith(ex)),
      map: (rel) => rel.split('/').pop(),
    }));
  }
  await writeJsonAtomic(marker, { key, at: Date.now() });
}

async function planGame(spec, ctx) {
  if (process.env.VSL_TEST_NOGAME === '1' && !require('electron').app.isPackaged) {
    return { launchId: spec.mc, mc: spec.mc, items: [], posts: [], dispose: () => {} };
  }
  const { dirs, signal, repair } = ctx;
  const mc = spec.mc;
  const loader = spec.loader?.type && spec.loader.type !== 'vanilla' ? spec.loader : null;
  const items = new Map();
  const add = (it) => {
    const k = it.dest.toLowerCase();
    if (!items.has(k)) items.set(k, it);
  };
  const posts = [];
  const disposers = [];

  const vanilla = await ensureVanillaJson(dirs, mc, { signal });
  const client = vanilla.downloads?.client;
  if (!client?.url) throw new Error(`Minecraft ${mc} no tiene cliente descargable`);
  add({ url: client.url, dest: path.join(dirs.versions, mc, `${mc}.jar`), sha1: client.sha1, size: client.size, label: `Minecraft ${mc}` });

  let launchId = mc;
  let forgePost = null;
  if (loader?.type === 'fabric' || loader?.type === 'quilt') {
    launchId = await installFabricLike(loader.type, mc, loader.version, dirs, { signal });
  } else if (loader?.type === 'forge' || loader?.type === 'neoforge') {
    const f = await planForge({ type: loader.type, mc, version: loader.version, dirs, signal, repair });
    launchId = f.id;
    f.items.forEach(add);
    if (f.dispose) disposers.push(f.dispose);
    forgePost = f.post;
  } else if (loader) {
    throw new Error(`Cargador no soportado: ${loader.type}`);
  }

  const resolved = await resolveVersion(dirs, launchId);
  const libraries = resolveLibraries(resolved.libraries, {});
  const arch = gameArch(libraries);
  const javaPlan = await planJava(resolved.javaVersion || vanilla.javaVersion, dirs, {
    custom: ctx.javaCustom?.((resolved.javaVersion || vanilla.javaVersion)?.majorVersion || 8), signal, repair, arch,
  });
  javaPlan.items.forEach(add);
  if (javaPlan.post) posts.push(javaPlan.post);
  if (forgePost) posts.push((progress) => forgePost(javaPlan.result, progress));

  const classpath = [];
  const natives = [];
  for (const lib of libraries) {
    const a = libraryArtifact(lib);
    if (a) {
      const dest = path.join(dirs.libraries, ...a.path.split('/'));
      if (a.url) add({ url: a.url, dest, sha1: a.sha1, size: a.size, label: lib.name, optional: lib.clientreq === false });
      classpath.push(dest);
      if (isModernNative(lib) && nativeArch(lib) === arch) natives.push({ file: dest, exclude: ['META-INF/'] });
    }
    const n = libraryNatives(lib);
    if (n) {
      const dest = path.join(dirs.libraries, ...n.path.split('/'));
      add({ url: n.url, dest, sha1: n.sha1, size: n.size, label: `${lib.name} (nativos)` });
      natives.push({ file: dest, exclude: n.exclude });
    }
  }

  let logging = null;
  const lf = resolved.logging?.client;
  if (lf?.file?.url) {
    const dest = path.join(dirs.assets, 'log_configs', lf.file.id);
    add({ url: lf.file.url, dest, sha1: lf.file.sha1, size: lf.file.size, label: 'configuración de registros' });
    logging = { argument: lf.argument, path: dest };
  }

  const assetsPlan = await planAssets(resolved, dirs, { signal, gameDir: ctx.gameDir });
  assetsPlan.items.forEach(add);

  const nativesDir = path.join(dirs.natives, launchId);
  const baseJar = path.join(dirs.versions, resolved.baseJar || mc, `${resolved.baseJar || mc}.jar`);
  const jarPath = path.join(dirs.versions, launchId, `${launchId}.jar`);
  posts.push(async () => {
    if (assetsPlan.post) await assetsPlan.post();
    await extractNatives(natives, nativesDir);
    if (jarPath !== baseJar) {
      const [a, b] = await Promise.all([fsp.stat(baseJar).catch(() => null), fsp.stat(jarPath).catch(() => null)]);
      if (a && (!b || b.size !== a.size)) await linkOrCopy(baseJar, jarPath);
    }
  });

  return {
    launchId, resolved, mc, arch,
    java: javaPlan.result,
    items: [...items.values()],
    posts,
    dispose: () => disposers.forEach((d) => { try { d(); } catch {} }),
    classpath, nativesDir, jarPath, logging,
    assets: assetsPlan.result,
  };
}

module.exports = { planGame, extractNatives };
