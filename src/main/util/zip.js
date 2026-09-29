'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { ensureDir, renameRetry } = require('./fsx');

function openRaw(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (err, zf) => (err ? reject(err) : resolve(zf)));
  });
}

async function openZip(file) {
  const zf = await openRaw(file);
  const entries = new Map();
  await new Promise((resolve, reject) => {
    zf.on('entry', (e) => { entries.set(e.fileName, e); zf.readEntry(); });
    zf.on('end', resolve);
    zf.on('error', reject);
    zf.readEntry();
  });

  const stream = (entry) => new Promise((resolve, reject) => {
    zf.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s)));
  });

  const api = {
    entries,
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    async read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const s = await stream(e);
      const chunks = [];
      for await (const c of s) chunks.push(c);
      return Buffer.concat(chunks);
    },
    async readText(name) {
      const b = await api.read(name);
      return b ? b.toString('utf8').replace(/^﻿/, '') : null;
    },
    async extract(name, dest) {
      const e = entries.get(name);
      if (!e) throw new Error(`Falta ${name} dentro del archivo`);
      await ensureDir(path.dirname(dest));
      const tmp = `${dest}.part`;
      await pipeline(await stream(e), fs.createWriteStream(tmp));
      await renameRetry(tmp, dest);
      return dest;
    },
    async extractAll(destDir, { filter, strip = 0, map } = {}) {
      const root = path.resolve(destDir) + path.sep;
      let count = 0;
      for (const [name, e] of entries) {
        if (/\/$/.test(name)) continue;
        if (filter && !filter(name)) continue;
        let rel = name.split('/').slice(strip).join('/');
        if (map) rel = map(rel, name);
        if (!rel) continue;
        const dest = path.resolve(destDir, rel);
        if (!dest.startsWith(root)) continue;
        await ensureDir(path.dirname(dest));
        await pipeline(await stream(e), fs.createWriteStream(dest));
        count++;
      }
      return count;
    },
    close() { try { zf.close(); } catch {} },
  };
  return api;
}

async function withZip(file, fn) {
  const z = await openZip(file);
  try { return await fn(z); } finally { z.close(); }
}

async function jarMainClass(file) {
  return withZip(file, async (z) => {
    const mf = await z.readText('META-INF/MANIFEST.MF');
    if (!mf) return null;
    const lines = mf.replace(/\r\n/g, '\n').replace(/\n /g, '').split('\n');
    const line = lines.find((l) => l.startsWith('Main-Class:'));
    return line ? line.slice('Main-Class:'.length).trim() : null;
  });
}

module.exports = { openZip, withZip, jarMainClass, fsp };
