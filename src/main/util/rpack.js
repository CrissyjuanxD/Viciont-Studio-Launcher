'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { promisify } = require('node:util');

const deflateRaw = promisify(zlib.deflateRaw);
const SKIP_RE = /(^|\/)(desktop\.ini|thumbs\.db|\.ds_store)$|\.zip$|(^|\/)\.git(\/|$)/i;
const PACK_RE = /^resourcepacks\/[^/]+$/;

const isZipPack = (rel) => /\.zip$/i.test(rel);

function packFiles(packPath, list) {
  const prefix = `${packPath}/`;
  return list
    .filter((f) => f.path.startsWith(prefix) && !SKIP_RE.test(f.path.slice(prefix.length)))
    .map((f) => ({ ...f, rel: f.path.slice(prefix.length) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function packId(packPath, list) {
  if (!PACK_RE.test(packPath || '')) return null;
  if (isZipPack(packPath)) return String(list.find((f) => f.path === packPath)?.sha1 || '').toLowerCase() || null;
  const files = packFiles(packPath, list);
  if (!files.length) return null;
  const h = crypto.createHash('sha1');
  for (const f of files) h.update(`${f.rel}\t${String(f.sha1).toLowerCase()}\n`);
  return h.digest('hex');
}

let TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function writeZip(files, out) {
  if (files.length > 65000) throw new Error('El pack tiene demasiados archivos para un .zip (máximo 65000).');
  const stream = fs.createWriteStream(out);
  const failed = new Promise((_, reject) => stream.once('error', reject));
  failed.catch(() => {});
  let offset = 0;
  const central = [];
  const put = async (buf) => {
    offset += buf.length;
    if (!stream.write(buf)) await Promise.race([once(stream, 'drain'), failed]);
  };
  try {
    for (const f of files) {
      const data = await fsp.readFile(f.abs);
      const packed = await deflateRaw(data, { level: 6 });
      const store = packed.length >= data.length;
      const body = store ? data : packed;
      const name = Buffer.from(f.rel, 'utf8');
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(store ? 0 : 8, 8);
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0x21, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      central.push({ name, crc, method: store ? 0 : 8, csize: body.length, size: data.length, offset });
      await put(local);
      await put(name);
      await put(body);
      if (offset > 0xfffffff0) throw new Error('El pack es demasiado grande para un .zip.');
    }
    const start = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(0, 12);
      h.writeUInt16LE(0x21, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.csize, 20);
      h.writeUInt32LE(c.size, 24);
      h.writeUInt16LE(c.name.length, 28);
      h.writeUInt32LE(c.offset, 42);
      await put(h);
      await put(c.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - start, 12);
    end.writeUInt32LE(start, 16);
    await put(end);
    await Promise.race([new Promise((resolve) => stream.end(resolve)), failed]);
  } catch (e) {
    stream.destroy();
    await fsp.rm(out, { force: true }).catch(() => {});
    throw e;
  }
  return { size: offset };
}

module.exports = { PACK_RE, isZipPack, packFiles, packId, writeZip };
