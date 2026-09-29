'use strict';

const path = require('node:path');
const { getJson, cached } = require('../util/net');
const { readJson, writeJsonAtomic, exists, hashFile } = require('../util/fsx');
const { downloadAll } = require('../util/downloader');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

async function getVersionManifest(dirs, { force = false } = {}) {
  const file = path.join(dirs.meta, 'version_manifest_v2.json');
  try {
    return await cached('mojang-manifest', force ? 0 : 10 * 60 * 1000, async () => {
      const data = await getJson(MANIFEST_URL, { timeout: 20000 });
      if (!data?.versions?.length) throw new Error('Lista de versiones vacía');
      writeJsonAtomic(file, data).catch(() => {});
      return data;
    });
  } catch (e) {
    const local = await readJson(file);
    if (local?.versions?.length) return local;
    throw e;
  }
}

function versionJsonPath(dirs, id) {
  return path.join(dirs.versions, id, `${id}.json`);
}

async function ensureVanillaJson(dirs, id, { signal, progress } = {}) {
  const file = versionJsonPath(dirs, id);
  const local = await readJson(file);
  let manifest;
  try { manifest = await getVersionManifest(dirs); } catch (e) {
    if (local) return local;
    throw e;
  }
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) {
    if (local) return local;
    throw new Error(`La versión ${id} de Minecraft no existe`);
  }
  if (local && (await exists(file))) {
    const sha = await hashFile(file).catch(() => '');
    if (!entry.sha1 || sha === entry.sha1) return local;
  }
  await downloadAll([{ url: entry.url, dest: file, sha1: entry.sha1, label: `${id}.json` }], { signal, progress, verify: 'hash' });
  return readJson(file);
}

async function loadVersionJson(dirs, id) {
  const json = await readJson(versionJsonPath(dirs, id));
  if (!json) throw new Error(`Falta el archivo de la versión ${id}. Reinstala la instancia.`);
  return json;
}

function mergeVersions(child, parent) {
  const merged = { ...parent, ...child };
  merged.id = child.id;
  merged.inheritsFrom = undefined;
  merged.mainClass = child.mainClass || parent.mainClass;
  merged.libraries = [...(child.libraries || []), ...(parent.libraries || [])];
  if (child.arguments || parent.arguments) {
    merged.arguments = {
      game: [...(parent.arguments?.game || []), ...(child.arguments?.game || [])],
      jvm: [...(parent.arguments?.jvm || []), ...(child.arguments?.jvm || [])],
    };
  }
  merged.minecraftArguments = child.minecraftArguments || parent.minecraftArguments;
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.assets = child.assets || parent.assets;
  merged.downloads = child.downloads || parent.downloads;
  merged.javaVersion = child.javaVersion || parent.javaVersion;
  merged.logging = child.logging || parent.logging;
  merged.type = child.type || parent.type;
  merged.baseJar = child.downloads?.client ? child.id : (parent.baseJar || parent.jar || parent.id);
  merged.chain = [...(parent.chain || [parent.id]), child.id];
  return merged;
}

async function resolveVersion(dirs, id, depth = 0) {
  if (depth > 6) throw new Error('Herencia de versiones demasiado profunda');
  const json = await loadVersionJson(dirs, id);
  if (!json.inheritsFrom) {
    return { ...json, baseJar: json.jar || json.id, chain: [json.id] };
  }
  const parent = await resolveVersion(dirs, json.inheritsFrom, depth + 1);
  return mergeVersions(json, parent);
}

function sortByRelease(ids, manifest) {
  const time = new Map(manifest.versions.map((v) => [v.id, Date.parse(v.releaseTime)]));
  return [...ids].sort((a, b) => (time.get(b) || 0) - (time.get(a) || 0));
}

module.exports = {
  MANIFEST_URL, getVersionManifest, ensureVanillaJson, loadVersionJson, resolveVersion,
  versionJsonPath, sortByRelease,
};
