'use strict';

const path = require('node:path');
const { readJson, writeJsonAtomic } = require('../util/fsx');
const { cached } = require('../util/net');
const modrinth = require('./modrinth');

const CSL_PROJECT = 'idMHQ4n2';
const ENTRY_NAME = 'ViciontStudio';

const isCslFile = (f) => f?.project === CSL_PROJECT || /customskinloader/i.test(f?.path || '');

async function cslFile(mc, loader) {
  if (!loader || loader === 'vanilla') return null;
  const list = await cached(`csl:${mc}:${loader}`, 6 * 60 * 60 * 1000, () => modrinth.versions(CSL_PROJECT, { mc, loader }));
  const v = list.find((x) => x.type === 'release' && x.file) || list.find((x) => x.file);
  if (!v?.file?.url) return null;
  return {
    path: `mods/${v.file.filename}`, url: v.file.url, sha1: v.file.sha1, size: v.file.size,
    source: 'modrinth', project: CSL_PROJECT, version: v.id, policy: 'always', managedBy: 'launcher',
  };
}

async function configure(gameDir, apiBase) {
  if (!apiBase) return;
  const root = `${apiBase.replace(/\/+$/, '')}/csl/`;
  const dir = path.join(gameDir, 'CustomSkinLoader');
  const cfgFile = path.join(dir, 'CustomSkinLoader.json');
  const cfg = await readJson(cfgFile);
  const list = Array.isArray(cfg?.loadlist) ? cfg.loadlist : [];
  if (list.some((e) => e && e.type === 'CustomSkinAPI' && e.root === root)) return;
  if (list.some((e) => e?.name === ENTRY_NAME)) {
    cfg.loadlist = list.filter((e) => e?.name !== ENTRY_NAME);
    await writeJsonAtomic(cfgFile, cfg);
  }
  await writeJsonAtomic(path.join(dir, 'ExtraList', `${ENTRY_NAME}.json`), { name: ENTRY_NAME, type: 'CustomSkinAPI', root });
}

module.exports = { cslFile, configure, isCslFile, CSL_PROJECT };
