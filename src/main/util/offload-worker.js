'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { setUserAgent } = require('./net');

if (workerData?.ua) setUserAgent(workerData.ua);
const { downloadAllLocal } = require('./downloader');
const { hashFileLocal } = require('./fsx');

const aborts = new Map();
const errOut = (e) => ({ name: e?.name, message: e?.message || String(e), code: e?.code, status: e?.status, item: e?.item });

async function download(m) {
  const ctrl = new AbortController();
  aborts.set(m.id, ctrl);
  const acc = { total: 0, files: 0, done: 0, filesDone: 0 };
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!acc.total && !acc.files && !acc.done && !acc.filesDone) return;
    parentPort.postMessage({ type: 'progress', id: m.id, ...acc });
    acc.total = 0; acc.files = 0; acc.done = 0; acc.filesDone = 0;
  };
  const soon = () => { if (!timer) timer = setTimeout(flush, 100); };
  const progress = m.progress ? {
    addTotal(bytes, files = 0) { acc.total += Math.max(0, bytes || 0); acc.files += files; soon(); },
    addDone(bytes) { acc.done += bytes; soon(); },
    fileDone(n = 1) { acc.filesDone += n; soon(); },
  } : null;
  try {
    const r = await downloadAllLocal(m.items, { concurrency: m.concurrency, signal: ctrl.signal, progress, verify: m.verify });
    flush();
    parentPort.postMessage({
      id: m.id, ok: true,
      result: { downloaded: r.downloaded, skipped: r.skipped, failedOptional: r.failedOptional.map((f) => ({ index: m.items.indexOf(f.item), error: errOut(f.error) })) },
    });
  } catch (e) {
    flush();
    parentPort.postMessage({ id: m.id, ok: false, error: errOut(e) });
  } finally {
    aborts.delete(m.id);
  }
}

parentPort.postMessage({ type: 'ready' });

parentPort.on('message', (m) => {
  if (m.type === 'abort') { aborts.get(m.id)?.abort(); return; }
  if (m.type === 'download') { download(m); return; }
  if (m.type === 'hash') {
    hashFileLocal(m.file, m.algo)
      .then((result) => parentPort.postMessage({ id: m.id, ok: true, result }))
      .catch((e) => parentPort.postMessage({ id: m.id, ok: false, error: errOut(e) }));
  }
});
