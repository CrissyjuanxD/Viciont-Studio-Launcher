'use strict';
// Motor de descargas: varias a la vez, verificación SHA-1, reintentos, reanudación
// de archivos grandes y escritura segura (.part + renombrado al terminar).
// Un archivo nunca queda "a medias" en su ruta final.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { once, setMaxListeners } = require('node:events');
const { statOrNull, ensureDir, hashFile, renameRetry } = require('./fsx');
const { HttpError, sleep, abortError, userAgent } = require('./net');

const RESUME_MIN = 8 * 1024 * 1024;
const IDLE_TIMEOUT = 30000;
const ATTEMPTS = 5;

// Ejecuta fn sobre items con un límite de concurrencia. Si algo falla, deja
// terminar lo que está en curso (sin cortar escrituras) y lanza el primer error.
async function pool(items, limit, fn, signal) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      if (signal?.aborted) { failure = failure || abortError(signal); break; }
      const idx = next++;
      try { await fn(items[idx], idx); } catch (e) { failure = failure || e; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw failure;
}

async function isValid(item, verify) {
  if (item.force) return false;
  const st = await statOrNull(item.dest);
  if (!st || !st.isFile()) return false;
  if (item.size != null && st.size !== item.size) return false;
  if (verify === 'hash' && item.sha1) {
    try { return (await hashFile(item.dest, 'sha1')) === String(item.sha1).toLowerCase(); } catch { return false; }
  }
  return true;
}

function hashInto(file, hash) {
  return new Promise((resolve, reject) => {
    const s = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    s.on('data', (d) => hash.update(d));
    s.on('error', reject);
    s.on('end', resolve);
  });
}

async function attempt(url, item, ctx) {
  const { signal, progress } = ctx;
  const part = `${item.dest}.part`;
  await ensureDir(path.dirname(item.dest));
  let hash = item.sha1 ? crypto.createHash('sha1') : null;
  let start = 0;
  let counted = 0;
  const count = (n) => { counted += n; progress?.addDone(n); };

  if (item.size != null && item.size >= RESUME_MIN) {
    const st = await statOrNull(part);
    if (st && st.size > 0 && st.size < item.size) {
      if (hash) await hashInto(part, hash);
      start = st.size;
    }
  }

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let idle;
  let idleFired = false;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { idleFired = true; ctrl.abort(); }, IDLE_TIMEOUT);
  };
  let out = null;
  try {
    arm();
    const headers = { 'User-Agent': userAgent(), ...(item.headers || {}) };
    if (start) headers.Range = `bytes=${start}-`;
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new HttpError(res.status, url, body);
    }
    if (start && res.status !== 206) {
      // el servidor no admite reanudar: empezar de cero
      start = 0;
      if (item.sha1) hash = crypto.createHash('sha1');
    }
    if (item.size == null && !item._sized) {
      const len = Number(res.headers.get('content-length'));
      if (len > 0) { progress?.addTotal(len); item._sized = true; }
    }
    if (start) count(start);
    out = fs.createWriteStream(part, { flags: start ? 'a' : 'w' });
    const outError = new Promise((_, reject) => out.once('error', reject));
    outError.catch(() => {});
    let received = start;
    for await (const chunk of res.body) {
      arm();
      received += chunk.length;
      if (hash) hash.update(chunk);
      count(chunk.length);
      if (!out.write(chunk)) await Promise.race([once(out, 'drain'), outError]);
    }
    await new Promise((resolve, reject) => { out.end((err) => (err ? reject(err) : resolve())); });
    out = null;
    if (item.size != null && received !== item.size) {
      throw new Error(`Tamaño incorrecto (${received} de ${item.size} bytes)`);
    }
    if (hash) {
      const got = hash.digest('hex');
      if (got !== String(item.sha1).toLowerCase()) {
        await fsp.rm(part, { force: true });
        throw new Error('El archivo llegó dañado (SHA-1 no coincide)');
      }
    }
    await renameRetry(part, item.dest);
  } catch (e) {
    if (out) { out.destroy(); await once(out, 'close').catch(() => {}); }
    progress?.addDone(-counted);
    // los archivos pequeños se descartan; los grandes se reanudan en el siguiente intento
    if (item.size == null || item.size < RESUME_MIN || signal?.aborted) {
      if (!(signal?.aborted && item.size >= RESUME_MIN)) await fsp.rm(part, { force: true }).catch(() => {});
    }
    if (signal?.aborted) throw abortError(signal);
    if (idleFired) throw new Error('La descarga se quedó sin respuesta');
    throw e;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function downloadOne(item, ctx) {
  const urls = (item.urls || [item.url]).filter(Boolean);
  if (!urls.length) throw new Error(`Sin enlace de descarga para ${path.basename(item.dest)}`);
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    const url = urls[i % urls.length];
    try {
      await attempt(url, item, ctx);
      return;
    } catch (e) {
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      lastErr = e;
      const fatal = e instanceof HttpError && [400, 401, 403, 404, 410].includes(e.status);
      if (fatal && i + 1 >= urls.length) break;
      if (!fatal) await sleep(Math.min(8000, 450 * 2 ** i) + Math.random() * 300, ctx.signal);
    }
  }
  const name = item.label || path.basename(item.dest);
  const err = new Error(`No se pudo descargar ${name}: ${lastErr?.message || 'error desconocido'}`);
  err.cause = lastErr;
  err.item = { dest: item.dest, url: urls[0] };
  throw err;
}

/**
 * Descarga una lista de archivos.
 * items: { url | urls, dest, sha1?, size?, optional?, label?, headers? }
 * verify: 'size' (rápido) | 'hash' (comprueba SHA-1 de lo que ya existe)
 * Devuelve { downloaded, skipped, failedOptional }.
 */
const SMALL = 256 * 1024;

async function downloadAll(items, { concurrency = 8, signal, progress, verify = 'size' } = {}) {
  const needed = [];
  await pool(items, 48, async (it) => {
    if (!(await isValid(it, verify))) needed.push(it);
  }, signal);
  let bytes = 0;
  for (const it of needed) bytes += it.size || 0;
  progress?.addTotal(bytes, needed.length);

  // Los archivos pequeños (miles de recursos) van en su propia cola con más
  // conexiones: así la latencia de cada petición no frena la descarga.
  const small = needed.filter((it) => it.size != null && it.size < SMALL);
  const large = needed.filter((it) => !(it.size != null && it.size < SMALL));
  const inner = new AbortController();
  setMaxListeners(0, inner.signal);
  const onAbort = () => inner.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const failedOptional = [];
  let firstError = null;
  const run = (list, limit) => pool(list, limit, async (it) => {
    try {
      await downloadOne(it, { signal: inner.signal, progress });
    } catch (e) {
      if (it.optional && !inner.signal.aborted) { failedOptional.push({ item: it, error: e }); return; }
      if (!firstError && !(e.name === 'AbortError' && !signal?.aborted)) firstError = e;
      inner.abort();
      throw e;
    }
    progress?.fileDone();
  }, inner.signal).catch(() => {});
  try {
    await Promise.all([run(large, concurrency), run(small, Math.min(64, Math.max(16, concurrency * 3)))]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw abortError(signal);
  if (firstError) throw firstError;
  return { downloaded: needed.length - failedOptional.length, skipped: items.length - needed.length, failedOptional };
}

module.exports = { downloadAll, downloadOne, pool, isValid };
