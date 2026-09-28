'use strict';
// Descargas y SHA-1 en un hilo aparte. El proceso principal de Electron también mueve y pinta
// la ventana: si se satura con miles de archivos (descargas, comprobaciones), el launcher se
// "traba" hasta que termina. Aquí solo llegan avisos de progreso agrupados (10 por segundo).
// Si el hilo no arranca o se cae, lo pendiente se hace en el proceso principal como antes.

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { userAgent } = require('./net');

let worker = null;
let ready = false;
let deaths = 0;
let broken = false;
let seq = 0;
const jobs = new Map(); // id → { resolve, reject, progress, applied, cleanup }

function rebuild(e) {
  const err = new Error(e?.message || 'Error desconocido');
  if (e?.name) err.name = e.name;
  if (e?.code) err.code = e.code;
  if (e?.status) err.status = e.status;
  if (e?.item) err.item = e.item;
  return err;
}

function settle(id, fn) {
  const j = jobs.get(id);
  if (!j) return;
  jobs.delete(id);
  j.cleanup?.();
  fn(j);
}

function spawn() {
  const w = new Worker(path.join(__dirname, 'offload-worker.js'), { workerData: { ua: userAgent() } });
  w.unref();
  ready = false;
  const gone = (e) => {
    if (worker !== w) return;
    worker = null;
    // si ni siquiera llegó a arrancar (o se cae una y otra vez) no se vuelve a intentar
    if (!ready || ++deaths >= 3) broken = true;
    const err = Object.assign(new Error(`El hilo de descargas se cerró: ${e?.message || e}`), { workerDied: true });
    for (const id of [...jobs.keys()]) settle(id, (j) => j.reject(err));
  };
  w.on('message', (m) => {
    if (m.type === 'ready') { ready = true; return; }
    if (m.type === 'progress') {
      const j = jobs.get(m.id);
      const p = j?.progress;
      if (p) {
        if (m.total || m.files) p.addTotal(m.total, m.files);
        if (m.done) p.addDone(m.done);
        if (m.filesDone) p.fileDone(m.filesDone);
        j.applied.total += m.total || 0;
        j.applied.files += m.files || 0;
        j.applied.done += m.done || 0;
        j.applied.filesDone += m.filesDone || 0;
      }
      return;
    }
    settle(m.id, (j) => (m.ok ? j.resolve(m.result) : j.reject(rebuild(m.error))));
  });
  w.on('error', (e) => gone(e));
  w.on('exit', (code) => gone(new Error(`código ${code}`)));
  return w;
}

function available() {
  if (broken) return false;
  if (worker) return true;
  try {
    worker = spawn();
    return true;
  } catch {
    broken = true;
    return false;
  }
}

function run(type, payload, { signal, progress } = {}) {
  return new Promise((resolve, reject) => {
    if (!available()) { reject(Object.assign(new Error('Sin hilo de descargas'), { workerDied: true })); return; }
    const id = ++seq;
    const j = { resolve, reject, progress, applied: { total: 0, files: 0, done: 0, filesDone: 0 } };
    jobs.set(id, j);
    const w = worker;
    w.postMessage({ type, id, ...payload });
    if (signal) {
      // se avisa al hilo y se espera a que cierre sus archivos (la cancelación sigue siendo segura)
      const onAbort = () => w.postMessage({ type: 'abort', id });
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        j.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
    }
    j.undo = () => {
      // el trabajo se repite en el proceso principal: se descuenta lo que ya se había contado
      if (!progress) return;
      progress.total = Math.max(0, progress.total - j.applied.total);
      progress.filesTotal = Math.max(0, progress.filesTotal - j.applied.files);
      progress.done = Math.max(0, progress.done - j.applied.done);
      progress.filesDone = Math.max(0, progress.filesDone - j.applied.filesDone);
    };
    const reject0 = j.reject;
    j.reject = (e) => { if (e?.workerDied) j.undo(); reject0(e); };
  });
}

// Misma forma que downloadAll: { downloaded, skipped, failedOptional: [{ item, error }] }
async function download(items, opts = {}, local) {
  const { concurrency, signal, progress, verify } = opts;
  const plain = items.map((it) => ({
    url: it.url, urls: it.urls, dest: it.dest, sha1: it.sha1, size: it.size, optional: it.optional,
    label: it.label, headers: it.headers, force: it.force,
  }));
  let r;
  try {
    r = await run('download', { items: plain, concurrency, verify, progress: Boolean(progress) }, { signal, progress });
  } catch (e) {
    if (e?.workerDied) return local(items, opts);
    throw e;
  }
  return {
    downloaded: r.downloaded,
    skipped: r.skipped,
    failedOptional: r.failedOptional.map((f) => ({ item: items[f.index], error: rebuild(f.error) })),
  };
}

async function hash(file, algo, local) {
  try {
    return await run('hash', { file, algo });
  } catch (e) {
    if (e?.workerDied) return local(file, algo);
    throw e;
  }
}

module.exports = { available, download, hash };
