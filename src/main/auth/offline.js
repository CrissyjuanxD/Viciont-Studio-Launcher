'use strict';

const crypto = require('node:crypto');
const { request, HttpError } = require('../util/net');

const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;

function validateNick(name) {
  const n = String(name || '').trim();
  if (n.length < 3) return 'El nick debe tener al menos 3 caracteres.';
  if (n.length > 16) return 'El nick puede tener como máximo 16 caracteres.';
  if (!NICK_RE.test(n)) return 'Solo se permiten letras, números y guion bajo (_).';
  return null;
}

function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const LOOKUPS = [
  (n) => `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(n)}`,
  (n) => `https://api.minecraftservices.com/minecraft/profile/lookup/name/${encodeURIComponent(n)}`,
];

async function premiumLookup(name) {
  let lastErr = null;
  for (const url of LOOKUPS) {
    try {
      const { status, data } = await request(url(name), { timeout: 10000, retries: 1, ok: [204, 404] });
      if (status === 404 || status === 204 || !data?.id) return { premium: false };
      return { premium: true, name: data.name, id: data.id };
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status === 400) return { premium: false };
    }
  }
  const err = new Error('No se pudo comprobar el nick con Mojang ahora mismo. Inténtalo de nuevo en unos segundos.');
  err.cause = lastErr;
  err.code = 'ELOOKUP';
  throw err;
}

module.exports = { validateNick, offlineUuid, premiumLookup, NICK_RE };
