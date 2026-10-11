'use strict';

const fs = require('node:fs');
const { safeStorage } = require('electron');
const { writeFileAtomicSync } = require('../util/fsx');

const MAGIC_ENC = Buffer.from('VSL1');
const MAGIC_PLAIN = Buffer.from('VSL0');
const volatile = new Map();

function credentialsPersistent() {
  return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
}

function encode(obj) {
  const json = JSON.stringify(obj);
  return Buffer.concat([MAGIC_ENC, safeStorage.encryptString(json)]);
}

function decode(buf) {
  if (!buf || buf.length < 4) return null;
  const magic = buf.subarray(0, 4);
  const body = buf.subarray(4);
  if (magic.equals(MAGIC_ENC)) return JSON.parse(safeStorage.decryptString(body));
  if (magic.equals(MAGIC_PLAIN)) return JSON.parse(Buffer.from(body.toString(), 'base64').toString('utf8'));
  return null;
}

function readSecure(file, fallback) {
  if (volatile.has(file)) return JSON.parse(volatile.get(file));
  try {
    const bytes = fs.readFileSync(file);
    const value = decode(bytes);
    if (value == null) return fallback;
    // Migra los archivos antiguos en claro; nunca vuelve a escribir Base64.
    if (bytes.subarray(0, 4).equals(MAGIC_PLAIN) || !credentialsPersistent()) writeSecure(file, value);
    else fs.chmodSync(file, 0o600);
    return value;
  } catch { return fallback; }
}

function writeSecure(file, obj) {
  if (credentialsPersistent()) {
    writeFileAtomicSync(file, encode(obj), { mode: 0o600 });
    volatile.delete(file);
    return;
  }
  volatile.set(file, JSON.stringify(obj));
  // Conserva un archivo cifrado si su llavero está temporalmente inaccesible.
  // Sí retira formatos inseguros: las credenciales viven solo en esta sesión.
  try {
    const magic = fs.readFileSync(file).subarray(0, 4);
    if (magic.equals(MAGIC_PLAIN) || safeStorage.getSelectedStorageBackend?.() === 'basic_text') fs.unlinkSync(file);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

module.exports = { readSecure, writeSecure, credentialsPersistent };
