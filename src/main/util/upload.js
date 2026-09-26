'use strict';
// Subidas al servidor con progreso real (bytes enviados) y tamaño conocido,
// que es lo que necesita Cloudflare R2.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { userAgent } = require('./net');

const CHUNK = 256 * 1024;

function send(url, { method = 'PUT', headers = {}, body, onBytes, signal, timeout = 120000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
    const req = lib.request(u, {
      method,
      headers: { 'User-Agent': userAgent(), 'Content-Length': String(buf.length), ...headers },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json ?? text);
        else {
          const e = new Error(json?.message || `HTTP ${res.statusCode}`);
          e.status = res.statusCode;
          e.code = json?.error;
          reject(e);
        }
      });
    });
    const onAbort = () => req.destroy(Object.assign(new Error('Operación cancelada'), { name: 'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => req.destroy(new Error('El servidor tardó demasiado en responder')));
    req.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    let off = 0;
    const pump = () => {
      while (off < buf.length) {
        const end = Math.min(buf.length, off + CHUNK);
        const piece = buf.subarray(off, end);
        const n = piece.length;
        off = end;
        const ok = req.write(piece, () => onBytes?.(n));
        if (!ok) { req.once('drain', pump); return; }
      }
      req.end();
    };
    pump();
  });
}

async function readSlice(file, start, length) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

module.exports = { send, readSlice };
