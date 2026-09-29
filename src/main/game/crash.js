'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');

const MAX_REPORT = 2 * 1024 * 1024;
const MAX_LOG = 1536 * 1024;
const LOG_HEAD = 192 * 1024;

async function newest(dir, re, since) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const e of entries) {
    if (!e.isFile() || !re.test(e.name)) continue;
    const file = path.join(dir, e.name);
    const st = await fsp.stat(file).catch(() => null);
    if (!st || st.mtimeMs < since) continue;
    if (!best || st.mtimeMs > best.mtime) best = { name: e.name, file, mtime: st.mtimeMs, size: st.size };
  }
  return best;
}

async function readCapped(file, size, max, head = 0) {
  if (size <= max) return { text: await fsp.readFile(file, 'utf8'), truncated: false };
  const fh = await fsp.open(file, 'r');
  try {
    const a = Buffer.alloc(head);
    if (head) await fh.read(a, 0, head, 0);
    const tailLen = max - head;
    const b = Buffer.alloc(tailLen);
    await fh.read(b, 0, tailLen, size - tailLen);
    const headText = head ? a.toString('utf8').replace(/[^\n]*$/, '') : '';
    const tailText = b.toString('utf8').replace(/^[^\n]*\n/, '');
    const skipped = Math.round((size - head - tailLen) / 1024);
    return { text: `${headText}${head ? '\n' : ''}[… ${skipped} KB sin mostrar …]\n\n${tailText}`, truncated: true };
  } finally {
    await fh.close();
  }
}

async function collectCrash({ gameDir, startedAt, pid, logFile }) {
  const since = (startedAt || 0) - 5000;
  const out = { report: null, jvm: null, log: null };
  try {
    const cr = await newest(path.join(gameDir, 'crash-reports'), /^crash-.*\.txt$/i, since);
    if (cr) out.report = { name: `crash-reports/${cr.name}`, ...(await readCapped(cr.file, cr.size, MAX_REPORT)) };
  } catch {}
  try {
    const hs = (pid && await newest(gameDir, new RegExp(`^hs_err_pid${pid}\\.log$`, 'i'), since)) || await newest(gameDir, /^hs_err_pid\d+\.log$/i, since);
    if (hs) out.jvm = { name: hs.name, ...(await readCapped(hs.file, hs.size, MAX_REPORT)) };
  } catch {}
  try {
    const st = logFile ? await fsp.stat(logFile) : null;
    if (st) out.log = { name: `logs/${path.basename(logFile)}`, ...(await readCapped(logFile, st.size, MAX_LOG, LOG_HEAD)) };
  } catch {}
  return out;
}

function crashText(c, header = '') {
  const parts = [];
  if (header) parts.push(header);
  if (c?.report) parts.push(`===== ${c.report.name} =====\n${c.report.text}`);
  if (c?.jvm) parts.push(`===== ${c.jvm.name} =====\n${c.jvm.text}`);
  if (c?.log) parts.push(`===== ${c.log.name}${c.log.truncated ? ' (recortado)' : ''} =====\n${c.log.text}`);
  return parts.join('\n\n');
}

module.exports = { collectCrash, crashText };
