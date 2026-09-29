'use strict';

const path = require('node:path');
const { readJson, exists, linkOrCopy, hashFile } = require('../util/fsx');
const { downloadAll, pool } = require('../util/downloader');

const RESOURCES = 'https://resources.download.minecraft.net';

async function planAssets(resolved, dirs, { signal, gameDir } = {}) {
  const ai = resolved.assetIndex;
  if (!ai) return { items: [], post: null, result: { index: resolved.assets || 'legacy', root: dirs.assets, virtual: null } };
  const indexFile = path.join(dirs.assets, 'indexes', `${ai.id}.json`);
  let valid = await exists(indexFile);
  if (valid && ai.sha1) valid = (await hashFile(indexFile).catch(() => '')) === ai.sha1;
  if (!valid) {
    await downloadAll([{ url: ai.url, dest: indexFile, sha1: ai.sha1, size: ai.size, label: `índice ${ai.id}` }], { signal, verify: 'hash' });
  }
  const index = await readJson(indexFile);
  if (!index?.objects) throw new Error('El índice de recursos está dañado');

  const byHash = new Map();
  for (const o of Object.values(index.objects)) byHash.set(o.hash, o.size);
  const items = [...byHash].map(([hash, size]) => ({
    url: `${RESOURCES}/${hash.slice(0, 2)}/${hash}`,
    dest: path.join(dirs.assets, 'objects', hash.slice(0, 2), hash),
    sha1: hash, size, label: 'recursos del juego', kind: 'asset',
  }));

  let virtual = null;
  let post = null;
  if (index.virtual || index.map_to_resources) {
    virtual = index.map_to_resources && gameDir ? path.join(gameDir, 'resources') : path.join(dirs.assets, 'virtual', ai.id);
    post = async () => {
      await pool(Object.entries(index.objects), 24, async ([name, o]) => {
        const dest = path.join(virtual, ...name.split('/'));
        if (await exists(dest)) return;
        await linkOrCopy(path.join(dirs.assets, 'objects', o.hash.slice(0, 2), o.hash), dest);
      }, signal);
    };
  }
  return { items, post, result: { index: ai.id, root: dirs.assets, virtual } };
}

module.exports = { planAssets };
