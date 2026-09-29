'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_ROOT } = require('./paths');

const DIR = path.join(CONFIG_ROOT, 'launcher_logs');
const FILE = path.join(DIR, 'launcher.log');
const MAX = 2 * 1024 * 1024;
let stream = null;
let size = 0;

function open() {
  fs.mkdirSync(DIR, { recursive: true });
  try { size = fs.statSync(FILE).size; } catch { size = 0; }
  if (size > MAX) rotate();
  stream = fs.createWriteStream(FILE, { flags: 'a' });
  stream.on('error', () => { stream = null; });
}

function rotate() {
  try {
    stream?.end();
    for (let i = 2; i >= 1; i--) {
      const a = `${FILE}.${i}`;
      if (fs.existsSync(a)) fs.renameSync(a, `${FILE}.${i + 1}`);
    }
    if (fs.existsSync(FILE)) fs.renameSync(FILE, `${FILE}.1`);
  } catch {}
  size = 0;
}

const SECRET = /(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|(?:access|refresh)_?token["'=:\s]+[\w.\-~]{12,}|Bearer\s+[\w.\-~]{12,}|XBL3\.0 x=[^;\s]+;[\w.\-~]+|[A-Za-z0-9_-]{120,})/gi;
const redact = (s) => String(s).replace(SECRET, '[oculto]');

function write(level, args) {
  if (!stream) open();
  const text = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack || ''}` : typeof a === 'object' ? safeJson(a) : String(a))).join(' ');
  const line = `[${new Date().toISOString()}] [${level}] ${redact(text)}\n`;
  size += line.length;
  if (size > MAX) { rotate(); open(); }
  stream?.write(line);
  if (!process.env.VSL_QUIET && level !== 'debug') (level === 'error' ? console.error : console.log)(line.trimEnd());
}

function safeJson(o) {
  try { return JSON.stringify(o); } catch { return String(o); }
}

module.exports = {
  DIR,
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  debug: (...a) => write('debug', a),
  redact,
};
