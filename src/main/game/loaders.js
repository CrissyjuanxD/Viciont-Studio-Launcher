'use strict';
// Cargadores de mods: Fabric, Quilt, Forge y NeoForge (listas de versiones e instalación).

const path = require('node:path');
const { getJson, getText, cached } = require('../util/net');
const { readJson, writeJsonAtomic, exists } = require('../util/fsx');
const { versionJsonPath } = require('./versions');

const LOADERS = {
  vanilla: { name: 'Vanilla' },
  fabric: { name: 'Fabric' },
  quilt: { name: 'Quilt' },
  forge: { name: 'Forge' },
  neoforge: { name: 'NeoForge' },
};

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_MAVEN = 'https://maven.minecraftforge.net';
const NEO_MAVEN = 'https://maven.neoforged.net';

// ---------- Listas de versiones ----------

async function fabricLike(base, mc) {
  const list = await cached(`${base}:${mc}`, 15 * 60 * 1000, () => getJson(`${base}/versions/loader/${encodeURIComponent(mc)}`));
  return (list || []).map((x) => ({ version: x.loader.version, stable: x.loader.stable !== false && !/beta|alpha|pre|rc/i.test(x.loader.version) }));
}

async function forgeMetadata() {
  return cached('forge-maven', 30 * 60 * 1000, async () => {
    const xml = await getText(`${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`, { timeout: 25000 });
    return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  });
}

async function forgePromotions() {
  return cached('forge-promos', 30 * 60 * 1000, () =>
    getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json').then((j) => j?.promos || {}).catch(() => ({})));
}

// "1.20.1-47.2.0" → versión de Forge "47.2.0" para Minecraft "1.20.1"
function splitForge(full, mc) {
  if (!full.startsWith(`${mc}-`)) return null;
  let v = full.slice(mc.length + 1);
  if (v.endsWith(`-${mc}`)) v = v.slice(0, -(mc.length + 1));
  return v;
}

async function forgeVersions(mc) {
  const [all, promos] = await Promise.all([forgeMetadata(), forgePromotions()]);
  const rec = promos[`${mc}-recommended`];
  const latest = promos[`${mc}-latest`];
  const out = [];
  for (const full of all) {
    const v = splitForge(full, mc);
    if (!v) continue;
    out.push({ version: v, full, stable: true, recommended: v === rec, latest: v === latest });
  }
  return out.sort((a, b) => compareNumeric(b.version, a.version));
}

function neoPrefix(mc) {
  const p = mc.split('.').map(Number);
  if (p.some((n) => !Number.isFinite(n))) return null;
  if (p[0] === 1) return `${p[1]}.${p[2] || 0}.`;
  return `${p[0]}.${p[1] || 0}.${p[2] || 0}.`;
}

async function neoforgeVersions(mc) {
  if (mc === '1.20.1') {
    const j = await cached('neo-legacy', 30 * 60 * 1000, () => getJson(`${NEO_MAVEN}/api/maven/versions/releases/net/neoforged/forge`));
    return (j?.versions || []).filter((v) => v.startsWith('1.20.1-'))
      .map((full) => ({ version: full.slice('1.20.1-'.length), full, stable: true }))
      .sort((a, b) => compareNumeric(b.version, a.version));
  }
  const prefix = neoPrefix(mc);
  if (!prefix) return [];
  const j = await cached('neo', 30 * 60 * 1000, () => getJson(`${NEO_MAVEN}/api/maven/versions/releases/net/neoforged/neoforge`));
  return (j?.versions || []).filter((v) => v.startsWith(prefix) && v.slice(prefix.length).split(/[.-]/)[0].match(/^\d+$/))
    .map((v) => ({ version: v, full: v, stable: !/beta|alpha/i.test(v) }))
    .sort((a, b) => compareNumeric(b.version, a.version));
}

function compareNumeric(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny) && x !== '' && y !== '') {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      if (x === '') return 1; // "1.0" > "1.0-beta"
      if (y === '') return -1;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

async function listLoaderVersions(type, mc) {
  switch (type) {
    case 'fabric': return fabricLike(FABRIC_META, mc);
    case 'quilt': return fabricLike(QUILT_META, mc);
    case 'forge': return forgeVersions(mc);
    case 'neoforge': return neoforgeVersions(mc);
    default: return [];
  }
}

// Versiones de Minecraft que soporta cada cargador (para filtrar en el panel).
async function supportedGameVersions(type) {
  if (type === 'fabric' || type === 'quilt') {
    const base = type === 'fabric' ? FABRIC_META : QUILT_META;
    const list = await cached(`${base}:game`, 30 * 60 * 1000, () => getJson(`${base}/versions/game`));
    return new Set((list || []).map((x) => x.version));
  }
  if (type === 'forge') {
    const all = await forgeMetadata();
    return new Set(all.map((f) => f.split('-')[0]));
  }
  return null; // NeoForge: se comprueba por versión
}

// ---------- Instalación ----------

// Fabric y Quilt: su JSON hereda de la versión vanilla.
async function installFabricLike(type, mc, loader, dirs, { signal } = {}) {
  const base = type === 'fabric' ? FABRIC_META : QUILT_META;
  const url = `${base}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`;
  const cacheKey = path.join(dirs.versions, 'vsl-loaders.json');
  const map = (await readJson(cacheKey)) || {};
  const key = `${type}:${mc}:${loader}`;
  if (map[key] && (await exists(versionJsonPath(dirs, map[key])))) return map[key];
  const json = await getJson(url, { signal, timeout: 25000 });
  if (!json?.id) throw new Error(`No se encontró ${LOADERS[type].name} ${loader} para Minecraft ${mc}`);
  await writeJsonAtomic(versionJsonPath(dirs, json.id), json);
  map[key] = json.id;
  await writeJsonAtomic(cacheKey, map);
  return json.id;
}

async function resolveForgeFull(type, mc, version) {
  if (type === 'forge') {
    const all = await forgeMetadata();
    const hit = all.find((f) => splitForge(f, mc) === version);
    if (!hit) throw new Error(`No existe Forge ${version} para Minecraft ${mc}`);
    return {
      full: hit,
      url: `${FORGE_MAVEN}/net/minecraftforge/forge/${hit}/forge-${hit}-installer.jar`,
      universal: `${FORGE_MAVEN}/net/minecraftforge/forge/${hit}/forge-${hit}-universal.jar`,
    };
  }
  if (mc === '1.20.1') {
    const full = version.startsWith('1.20.1-') ? version : `1.20.1-${version}`;
    return { full, url: `${NEO_MAVEN}/releases/net/neoforged/forge/${full}/forge-${full}-installer.jar` };
  }
  return { full: version, url: `${NEO_MAVEN}/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar` };
}

module.exports = {
  LOADERS, listLoaderVersions, supportedGameVersions, installFabricLike, resolveForgeFull, compareNumeric,
};
