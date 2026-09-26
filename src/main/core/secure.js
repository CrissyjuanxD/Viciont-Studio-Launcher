'use strict';
// Guardado cifrado con la protección de datos de Windows (DPAPI, vía safeStorage):
// solo tu usuario de Windows en este equipo puede leer las sesiones guardadas.

const fs = require('node:fs');
const { safeStorage } = require('electron');
const { writeFileAtomicSync } = require('../util/fsx');

const MAGIC_ENC = Buffer.from('VSL1');
const MAGIC_PLAIN = Buffer.from('VSL0');

function encode(obj) {
  const json = JSON.stringify(obj);
  if (safeStorage.isEncryptionAvailable()) return Buffer.concat([MAGIC_ENC, safeStorage.encryptString(json)]);
  return Buffer.concat([MAGIC_PLAIN, Buffer.from(Buffer.from(json, 'utf8').toString('base64'))]);
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
  try { return decode(fs.readFileSync(file)) ?? fallback; } catch { return fallback; }
}

function writeSecure(file, obj) {
  writeFileAtomicSync(file, encode(obj));
}

module.exports = { readSecure, writeSecure };
