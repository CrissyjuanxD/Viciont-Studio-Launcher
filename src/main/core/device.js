'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { DEVICE_DIR } = require('./paths');

const KEY_FILE = path.join(DEVICE_DIR, 'device.key');

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: 6000 }, (e, out) => resolve(e ? '' : String(out || '')));
});

async function machineId() {
  if (process.platform === 'win32') {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const out = await run(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']);
    return /MachineGuid\s+REG_SZ\s+([0-9a-f-]{36})/i.exec(out)?.[1]?.toLowerCase() || '';
  }
  if (process.platform === 'darwin') {
    const out = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1]?.toLowerCase() || '';
  }
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    const v = (await fsp.readFile(f, 'utf8').catch(() => '')).trim();
    if (/^[0-9a-f]{32}$/i.test(v)) return v.toLowerCase();
  }
  return '';
}

async function loadKey() {
  const saved = Buffer.from((await fsp.readFile(KEY_FILE, 'utf8').catch(() => '')).trim(), 'base64');
  if (saved.length === 32) return saved;
  const key = crypto.randomBytes(32);
  await fsp.mkdir(DEVICE_DIR, { recursive: true });
  await fsp.writeFile(KEY_FILE, key.toString('base64'), { mode: 0o600 });
  return key;
}

let ready = null;
function material() {
  ready ||= Promise.all([loadKey(), machineId()]).catch((e) => { ready = null; throw e; });
  return ready;
}

async function proof(nick) {
  const [key, id] = await material();
  return crypto.createHmac('sha256', key).update(`vsl-device:v1:${id}:${String(nick).toLowerCase()}`).digest('hex');
}

module.exports = { proof, KEY_FILE };
