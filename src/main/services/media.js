'use strict';
// Imágenes y vídeos de las instancias (iconos y fondos). Se guardan en caché y
// se sirven a la interfaz con el protocolo vsl-media:// (con soporte de rangos
// para que los vídeos arranquen al instante y ocupen poca memoria).

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { Readable } = require('node:stream');
const { downloadAll } = require('../util/downloader');
const { statOrNull } = require('../util/fsx');

const NAME_RE = /^([a-z0-9][a-z0-9-]{1,47})\/([a-f0-9]{16,64}\.(png|jpe?g|gif|webp|mp4|webm))$/i;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' };

class Media {
  constructor({ getDirs, backend, log }) {
    this.getDirs = getDirs;
    this.backend = backend;
    this.log = log;
    this.pending = new Map();
    this.localRoots = new Map(); // prefijo → carpeta (vista previa del panel de administración)
  }

  fileFor(key) {
    return path.join(this.getDirs().media, ...key.split('/'));
  }

  async ensure(key) {
    const m = NAME_RE.exec(key);
    if (!m) throw new Error('bad media name');
    const file = this.fileFor(key);
    if (await statOrNull(file)) return file;
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      const url = this.backend.url(`/v1/media/${m[1]}/${m[2]}`);
      await downloadAll([{ url, dest: file, label: m[2] }], { verify: 'size' });
      return file;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  // Manejador del protocolo vsl-media://<instancia>/<archivo>
  async handle(request) {
    try {
      const u = new URL(request.url);
      let key = `${u.host}${decodeURIComponent(u.pathname)}`.replace(/\/+$/, '');
      let file;
      if (u.host === 'local') {
        // vsl-media://local/<raíz>/<archivo> — archivos del panel aún sin publicar
        const [, root, name] = decodeURIComponent(u.pathname).split('/');
        const dir = this.localRoots.get(root);
        if (!dir || !/^[a-f0-9]{16,64}\.(png|jpe?g|gif|webp|mp4|webm)$/i.test(name || '')) return new Response('not found', { status: 404 });
        file = path.join(dir, name);
        key = name;
      } else {
        if (!NAME_RE.test(key)) return new Response('bad request', { status: 400 });
        file = await this.ensure(key);
      }
      const st = await statOrNull(file);
      if (!st) return new Response('not found', { status: 404 });
      const ext = key.split('.').pop().toLowerCase();
      const type = TYPES[ext] || 'application/octet-stream';
      const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=31536000, immutable' };
      if (range) {
        let start = range[1] ? Number(range[1]) : 0;
        let end = range[2] ? Number(range[2]) : st.size - 1;
        if (!range[1] && range[2]) { start = Math.max(0, st.size - Number(range[2])); end = st.size - 1; }
        end = Math.min(end, st.size - 1);
        if (start > end || start >= st.size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
        }
        const stream = fs.createReadStream(file, { start, end });
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}` },
        });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(st.size) } });
    } catch (e) {
      this.log.warn('media:', e.message);
      return new Response('error', { status: 502 });
    }
  }

  async clear() {
    await fsp.rm(this.getDirs().media, { recursive: true, force: true });
  }
}

module.exports = { Media, TYPES };
