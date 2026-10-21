'use strict';

const path = require('node:path');
const fsp = require('node:fs').promises;
const { getJson, cached } = require('../util/net');

const INDEX = 'https://github.com/CrissyjuanxD/ViciontRP/releases/latest/download/mod.json';
const LOADERS = new Set(['fabric', 'quilt']);
const RANGE = { min: '1.21', max: '26.3' };
const FILE_RE = /^ViciontRP-mod-[A-Za-z0-9.+-]+\.jar$/;

function cmpVersion(a, b) {
  const x = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const y = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

const inRange = (mc, e) => cmpVersion(mc, e.min) >= 0 && cmpVersion(mc, e.max) <= 0;

function usesPlugin(summary) {
  if (!summary) return false;
  return Boolean(summary.plugin || summary.rps?.length || summary.rp || summary.serverPacks?.length || summary.serverPack);
}

async function index() {
  const r = await cached('vrpmod:index', 6 * 60 * 60 * 1000, () => getJson(INDEX, { timeout: 15000 }));
  const files = (Array.isArray(r?.files) ? r.files : []).filter((f) => FILE_RE.test(f?.file || '') && /^https:\/\//.test(f.url || '')
    && /^[a-f0-9]{40}$/.test(f.sha1 || '') && f.min && f.max);
  return { version: String(r?.version || ''), files };
}

async function modFile(mc, loader) {
  if (!mc || !LOADERS.has(loader)) return null;
  return (await index()).files.find((f) => inRange(mc, f)) || null;
}

async function support(mc, loader) {
  const files = await index().then((r) => r.files).catch(() => []);
  const ranges = (files.length ? files : [RANGE]).map((f) => ({ min: f.min, max: f.max })).sort((a, b) => cmpVersion(a.min, b.min));
  const versions = ranges.map((r) => (r.min === r.max ? r.min : `${r.min} a ${r.max}`));
  if (!LOADERS.has(loader)) return { ok: false, reason: 'loader', versions };
  if (mc && ranges.some((r) => inRange(mc, r))) return { ok: true, versions };
  return { ok: false, reason: 'version', versions };
}

const modDir = (dirs) => path.join(dirs.meta, 'viciontrp');

async function prune(dirs, keep) {
  for (const n of await fsp.readdir(modDir(dirs)).catch(() => [])) {
    if (n !== keep && FILE_RE.test(n)) await fsp.rm(path.join(modDir(dirs), n), { force: true }).catch(() => {});
  }
}

module.exports = { modFile, modDir, prune, support, usesPlugin, cmpVersion, RANGE };
