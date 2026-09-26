'use strict';
// Cuentas del launcher (premium y no premium), guardadas cifradas en accounts.dat.

const { EventEmitter } = require('node:events');
const { readSecure, writeSecure } = require('../core/secure');
const { configFile } = require('../core/paths');
const microsoft = require('../auth/microsoft');
const offline = require('../auth/offline');

const FILE = configFile('accounts.dat');

function publicAccount(a, activeUuid) {
  if (!a) return null;
  const skin = a.type === 'microsoft' ? (a.skins || []).find((s) => s.state === 'ACTIVE') : a.skin;
  return {
    uuid: a.uuid,
    name: a.name,
    type: a.type,
    active: a.uuid === activeUuid,
    addedAt: a.addedAt,
    needsLogin: Boolean(a.needsLogin),
    skin: skin ? { url: skin.url || null, hash: skin.hash || null, variant: String(skin.variant || skin.model || 'classic').toLowerCase() } : null,
    hasRecovery: Boolean(a.claimSecret),
  };
}

class Accounts extends EventEmitter {
  constructor({ backend, log }) {
    super();
    this.backend = backend;
    this.log = log;
    this.data = { active: null, list: [] };
  }

  load() {
    const d = readSecure(FILE, null);
    if (d && Array.isArray(d.list)) this.data = { active: d.active || null, list: d.list };
    if (!this.find(this.data.active)) this.data.active = this.data.list[0]?.uuid || null;
  }

  save() {
    writeSecure(FILE, this.data);
    this.emit('change', this.summary());
  }

  find(uuid) { return this.data.list.find((a) => a.uuid === uuid) || null; }
  active() { return this.find(this.data.active); }

  summary() {
    return {
      active: publicAccount(this.active(), this.data.active),
      list: this.data.list.map((a) => publicAccount(a, this.data.active)),
    };
  }

  upsert(acc) {
    const i = this.data.list.findIndex((a) => a.uuid === acc.uuid);
    if (i >= 0) this.data.list[i] = { ...this.data.list[i], ...acc };
    else this.data.list.push(acc);
    return this.find(acc.uuid);
  }

  setActive(uuid) {
    if (!this.find(uuid)) throw new Error('Esa cuenta ya no existe');
    this.data.active = uuid;
    this.save();
    return this.summary();
  }

  remove(uuid) {
    this.data.list = this.data.list.filter((a) => a.uuid !== uuid);
    if (this.data.active === uuid) this.data.active = this.data.list[0]?.uuid || null;
    this.save();
    return this.summary();
  }

  // ---------- Premium ----------
  async loginMicrosoft(parentWindow) {
    const acc = await microsoft.login(parentWindow);
    acc.needsLogin = false;
    acc.backend = null;
    this.upsert(acc);
    this.data.active = acc.uuid;
    this.save();
    this.log.info(`Sesión premium iniciada: ${acc.name}`);
    return this.summary();
  }

  // Renueva el token de Minecraft si caduca pronto (dura 24 h).
  async ensureFresh(acc, { force = false } = {}) {
    if (!acc || acc.type !== 'microsoft') return acc;
    if (!force && acc.mcToken && acc.mcExpiresAt - Date.now() > 15 * 60 * 1000) return acc;
    try {
      const fresh = await microsoft.refresh(acc);
      fresh.needsLogin = false;
      const saved = this.upsert(fresh);
      this.save();
      return saved;
    } catch (e) {
      if (e.code === 'EEXPIRED' || e.code === 'ENOGAME') {
        this.upsert({ ...acc, needsLogin: true });
        this.save();
      }
      throw e;
    }
  }

  async refreshProfile(acc) {
    if (acc?.type !== 'microsoft') return acc;
    const fresh = await this.ensureFresh(acc);
    const profile = await microsoft.getProfile(fresh.mcToken);
    const saved = this.upsert({ ...fresh, name: profile.name, skins: profile.skins || [], capes: profile.capes || [] });
    this.save();
    return saved;
  }

  // ---------- No premium ----------
  async checkNick(name) {
    const problem = offline.validateNick(name);
    if (problem) return { ok: false, reason: 'format', message: problem };
    const nick = name.trim();
    const p = await offline.premiumLookup(nick);
    if (p.premium) {
      return { ok: false, reason: 'premium', message: `"${p.name}" es el nick de una cuenta premium. Elige otro o entra con tu cuenta de Microsoft.`, premiumName: p.name };
    }
    const mine = this.data.list.find((a) => a.type === 'offline' && a.name.toLowerCase() === nick.toLowerCase());
    if (mine) return { ok: true, reason: 'mine', message: 'Ya tienes este nick guardado en el launcher.' };
    if (this.backend.configured()) {
      try {
        const r = await this.backend.call('/v1/auth/offline/check', { method: 'POST', json: { name: nick }, timeout: 10000 });
        if (r?.claimed) return { ok: false, reason: 'claimed', message: 'Otro jugador del launcher ya usa este nick. Si es tuyo, entra con tu código de recuperación.' };
      } catch (e) {
        this.log.warn('No se pudo comprobar el nick en el servidor:', e.message);
      }
    }
    return { ok: true, reason: 'free', message: 'Nick disponible.' };
  }

  async loginOffline(name, recoveryCode) {
    const nick = String(name || '').trim();
    const problem = offline.validateNick(nick);
    if (problem) throw Object.assign(new Error(problem), { code: 'EFORMAT' });
    const p = await offline.premiumLookup(nick);
    if (p.premium) throw Object.assign(new Error(`"${p.name}" pertenece a una cuenta premium. Elige otro nick.`), { code: 'EPREMIUM' });
    const uuid = offline.offlineUuid(nick);
    const existing = this.find(uuid);
    const acc = existing ? { ...existing, name: nick } : { type: 'offline', uuid, name: nick, addedAt: Date.now() };
    const code = String(recoveryCode || '').trim();
    if (code) acc.claimSecret = code;
    acc.backend = null;
    if (this.backend.configured()) {
      try {
        await this.offlineSession(acc, { forceNew: true });
      } catch (e) {
        if (e.code === 'ENICKTAKEN' || e.code === 'EBADCODE') throw e;
        this.log.warn('Servidor no disponible, la cuenta se registrará más tarde:', e.message);
      }
    }
    this.upsert(acc);
    this.data.active = acc.uuid;
    this.save();
    this.log.info(`Sesión no premium iniciada: ${nick}`);
    return this.summary();
  }

  async offlineSession(acc, { forceNew = false } = {}) {
    if (acc.claimSecret) {
      try {
        const r = await this.backend.call('/v1/auth/offline/login', { method: 'POST', json: { name: acc.name, secret: acc.claimSecret } });
        acc.backend = { token: r.token, exp: r.expiresAt, base: this.backend.base() };
        return acc.backend.token;
      } catch (e) {
        if (e.status === 404 && !forceNew) {
          delete acc.claimSecret; // el servidor se reinició: volvemos a registrar el nick
        } else if (e.status === 401 || e.status === 403) {
          throw Object.assign(new Error('El código de recuperación no es correcto para este nick.'), { code: 'EBADCODE' });
        } else if (e.status !== 404) throw e;
      }
    }
    try {
      const r = await this.backend.call('/v1/auth/offline/claim', { method: 'POST', json: { name: acc.name } });
      acc.claimSecret = r.secret;
      acc.backend = { token: r.token, exp: r.expiresAt, base: this.backend.base() };
      return acc.backend.token;
    } catch (e) {
      if (e.status === 409) throw Object.assign(new Error('Otro jugador del launcher ya usa este nick. Si es tuyo, usa tu código de recuperación.'), { code: 'ENICKTAKEN' });
      if (e.status === 403 && e.code === 'premium') throw Object.assign(new Error(e.message), { code: 'EPREMIUM' });
      throw e;
    }
  }

  // Token de sesión para nuestro servidor (se renueva solo).
  async session(acc = this.active()) {
    if (!acc || !this.backend.configured()) return null;
    const base = this.backend.base();
    if (acc.backend?.token && acc.backend.base === base && acc.backend.exp - Date.now() > 60 * 60 * 1000) return acc.backend.token;
    let token;
    if (acc.type === 'microsoft') {
      const fresh = await this.ensureFresh(acc);
      const { challenge } = await this.backend.call('/v1/auth/challenge', { method: 'POST', json: {} });
      await microsoft.joinServer(fresh, challenge);
      const r = await this.backend.call('/v1/auth/premium', { method: 'POST', json: { name: fresh.name, challenge } });
      fresh.backend = { token: r.token, exp: r.expiresAt, base };
      token = r.token;
      this.upsert(fresh);
    } else {
      token = await this.offlineSession(acc);
      this.upsert(acc);
    }
    this.save();
    return token;
  }

  recoveryCode(uuid) {
    const a = this.find(uuid);
    return a?.type === 'offline' ? a.claimSecret || null : null;
  }

  // Datos que necesita el juego al arrancar.
  async launchIdentity() {
    let acc = this.active();
    if (!acc) throw new Error('Inicia sesión para jugar');
    if (acc.type === 'microsoft') {
      acc = await this.ensureFresh(acc);
      return { type: 'microsoft', name: acc.name, uuid: acc.uuid, accessToken: acc.mcToken, xuid: '0' };
    }
    return { type: 'offline', name: acc.name, uuid: acc.uuid, accessToken: '0' };
  }
}

module.exports = { Accounts };
