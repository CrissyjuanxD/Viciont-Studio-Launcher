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
    this.data = { active: null, list: [], device: null };
    this.meCache = new Map();
    this.sessionFlights = new Map(); // una sola conexión con el servidor a la vez por cuenta
    this.sessionFails = new Map(); // si falla, se espera cada vez más antes de reintentar
    this.msLogin = null; // una sola ventana de Microsoft a la vez
  }

  load() {
    const d = readSecure(FILE, null);
    if (d && Array.isArray(d.list)) this.data = { active: d.active || null, list: d.list, device: d.device || null };
    if (!this.find(this.data.active)) this.data.active = this.data.list[0]?.uuid || null;
  }

  // Clave propia de este PC para Xbox (como el launcher oficial y Modrinth). Va cifrada con las cuentas.
  deviceStore() {
    return {
      get: () => this.data.device || null,
      set: (dev) => { this.data.device = dev; writeSecure(FILE, this.data); },
    };
  }

  // Registro de actividad (lo recoge el servicio de telemetría).
  track(type, info = {}) { this.emit('track', type, info); }

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

  // forgetMicrosoft: que Microsoft olvide también la cuenta en la ventana de inicio de
  // sesión (para PCs compartidos). Si no, la próxima vez solo hay que elegirla, como en Modrinth.
  remove(uuid, { forgetMicrosoft = false } = {}) {
    const acc = this.find(uuid);
    this.data.list = this.data.list.filter((a) => a.uuid !== uuid);
    if (this.data.active === uuid) this.data.active = this.data.list[0]?.uuid || null;
    this.meCache.delete(uuid);
    this.save();
    if (acc?.type === 'microsoft' && forgetMicrosoft) microsoft.clearWebSession().catch(() => {});
    return this.summary();
  }

  // ---------- Premium ----------
  // Si ya hay un inicio de sesión en curso, se trae su ventana al frente (nunca se abren dos).
  loginMicrosoft() {
    if (this.msLogin) {
      microsoft.focusLoginWindow();
      return this.msLogin;
    }
    this.msLogin = this._loginMicrosoft().finally(() => { this.msLogin = null; });
    return this.msLogin;
  }

  cancelLogin() {
    microsoft.cancelLogin();
  }

  async _loginMicrosoft() {
    let acc;
    try {
      acc = await microsoft.login(this.deviceStore());
    } catch (e) {
      if (e.code !== 'ECANCEL') {
        this.log.warn('Inicio de sesión con Microsoft fallido:', e.message);
        this.track('auth.error', { level: 'error', message: `Microsoft: ${e.message}`, data: { code: e.code || null, xerr: e.xerr || null, status: e.status || null } });
      }
      throw e;
    }
    acc.needsLogin = false;
    acc.backend = null;
    this.upsert(acc);
    this.data.active = acc.uuid;
    this.save();
    this.clearSessionFails(acc.uuid);
    this.log.info(`Sesión premium iniciada: ${acc.name}`);
    this.track('auth.login', { uuid: acc.uuid, message: 'Inició sesión con Microsoft (premium)', data: { flow: acc.flow } });
    return this.summary();
  }

  // Renueva el token de Minecraft si caduca pronto (dura 24 h).
  async ensureFresh(acc, { force = false } = {}) {
    if (!acc || acc.type !== 'microsoft') return acc;
    if (!force && acc.mcToken && acc.mcExpiresAt - Date.now() > 15 * 60 * 1000) return acc;
    try {
      const fresh = await microsoft.refresh(acc, this.deviceStore());
      fresh.needsLogin = false;
      const saved = this.upsert(fresh);
      this.save();
      return saved;
    } catch (e) {
      if (e.code === 'EEXPIRED' || e.code === 'ENOGAME') {
        this.upsert({ ...acc, needsLogin: true });
        this.save();
      }
      if (e.code !== 'ENETWORK') this.track('auth.refresh_failed', { uuid: acc.uuid, level: 'warn', message: `No se pudo renovar la sesión premium: ${e.message}`, data: { code: e.code || null } });
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
    this.clearSessionFails(acc.uuid);
    this.log.info(`Sesión no premium iniciada: ${nick}`);
    this.track('auth.login', { uuid: acc.uuid, message: code ? 'Entró con su nick no premium (código de recuperación)' : 'Entró con un nick no premium' });
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
  // force: reintentar ya aunque el último intento fallara (cuando lo pide el jugador).
  async session(acc = this.active(), { force = false } = {}) {
    if (!acc || !this.backend.configured()) return null;
    const base = this.backend.base();
    if (acc.backend?.token && acc.backend.base === base && acc.backend.exp - Date.now() > 60 * 60 * 1000) return acc.backend.token;
    // si varias partes del launcher piden sesión a la vez, se hace una sola vez
    const key = `${acc.uuid}@${base}`;
    if (this.sessionFlights.has(key)) return this.sessionFlights.get(key);
    // tras un fallo no se reintenta cada pocos segundos: 30 s, 1 min, 2 min… hasta 10 min
    const fail = this.sessionFails.get(key);
    if (fail && !force && Date.now() < fail.until) throw fail.error;
    const flight = this._session(acc, base)
      .then((token) => { this.sessionFails.delete(key); return token; })
      .catch((e) => {
        const count = (fail?.count || 0) + 1;
        this.sessionFails.set(key, { count, error: e, until: Date.now() + Math.min(10 * 60 * 1000, 30 * 1000 * 2 ** (count - 1)) });
        throw e;
      })
      .finally(() => this.sessionFlights.delete(key));
    this.sessionFlights.set(key, flight);
    return flight;
  }

  async _session(acc, base) {
    let token;
    if (acc.type === 'microsoft') {
      const fresh = await this.ensureFresh(acc);
      const { challenge } = await this.backend.call('/v1/auth/challenge', { method: 'POST', json: {} });
      // 1) como un servidor de Minecraft (join) y 2) certificado firmado por Mojang, por si
      //    Mojang no le contesta a nuestro servidor. El token de Minecraft nunca se envía.
      const [join, proof] = await Promise.allSettled([microsoft.joinServer(fresh, challenge), microsoft.premiumProof(fresh, challenge)]);
      if (join.status === 'rejected') this.log.warn('Mojang no aceptó el join:', join.reason?.message);
      const body = { name: fresh.name, challenge };
      if (proof.status === 'fulfilled') {
        fresh.cert = proof.value.cert;
        Object.assign(body, proof.value.payload);
      } else {
        this.log.warn('No se pudo preparar el certificado premium:', proof.reason?.message);
      }
      const r = await this.backend.call('/v1/auth/premium', { method: 'POST', json: body });
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

  clearSessionFails(uuid) {
    for (const k of [...this.sessionFails.keys()]) if (k.startsWith(`${uuid}@`)) this.sessionFails.delete(k);
  }

  // El servidor rechazó el token (caducado o servidor nuevo): se pedirá otro.
  invalidateSession(acc = this.active()) {
    if (!acc?.backend) return;
    acc.backend = null;
    this.upsert(acc);
    this.save();
  }

  // ¿Qué sabe el servidor de esta cuenta? (incluye si tiene permisos de administración)
  async me({ fresh = false, force = false } = {}) {
    const acc = this.active();
    if (!acc || !this.backend.configured()) return null;
    const c = this.meCache.get(acc.uuid);
    if (!fresh && c && c.base === this.backend.base() && Date.now() - c.at < 5 * 60 * 1000) return c.data;
    let data = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.session(acc, { force: force && attempt === 0 });
      try {
        data = await this.backend.call('/v1/me', { token, timeout: 12000, retries: 0 });
        break;
      } catch (e) {
        if (e.status === 401 && attempt === 0) { this.invalidateSession(acc); continue; }
        throw e;
      }
    }
    this.meCache.set(acc.uuid, { at: Date.now(), base: this.backend.base(), data });
    return data;
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
      return { type: 'microsoft', name: acc.name, uuid: acc.uuid, accessToken: acc.mcToken, xuid: acc.xuid || '0' };
    }
    return { type: 'offline', name: acc.name, uuid: acc.uuid, accessToken: '0' };
  }
}

module.exports = { Accounts };
