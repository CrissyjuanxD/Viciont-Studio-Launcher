'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { request, getBuffer, getJson } = require('../util/net');
const { readJson, writeJsonAtomic, ensureDir, exists } = require('../util/fsx');

const LIB_VERSION = 1;

function pngInfo(buf) {
  if (!buf || buf.length < 33) return null;
  const sig = '89504e470d0a1a0a';
  if (buf.subarray(0, 8).toString('hex') !== sig || buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function validateSkin(buf, { premium }) {
  const info = pngInfo(buf);
  if (!info) throw new Error('El archivo no es una imagen PNG válida.');
  const { width: w, height: h } = info;
  if (premium) {
    if (!(w === 64 && (h === 64 || h === 32))) throw new Error('Para cuentas premium la skin debe medir 64×64 o 64×32 píxeles.');
  } else if (!([64, 128, 256, 512].includes(w) && (h === w || h === w / 2))) {
    throw new Error('La skin debe medir 64×64 (o 64×32). También se admiten skins HD de 128, 256 o 512.');
  }
  if (buf.length > 512 * 1024) throw new Error('La imagen es demasiado grande (máximo 512 KB).');
  return info;
}

const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

class Skins {
  constructor({ getDirs, accounts, backend, log }) {
    this.getDirs = getDirs;
    this.accounts = accounts;
    this.backend = backend;
    this.log = log;
  }

  dir() { return this.getDirs().skins; }
  libFile() { return path.join(this.dir(), 'library.json'); }

  async library() {
    const lib = await readJson(this.libFile(), null);
    return lib?.version === LIB_VERSION ? lib : { version: LIB_VERSION, items: [] };
  }

  async saveLibrary(lib) { await writeJsonAtomic(this.libFile(), lib); }

  async textureCached(url) {
    const key = sha1(Buffer.from(url));
    const file = path.join(this.getDirs().caches, 'textures', `${key}.png`);
    if (await exists(file)) return fsp.readFile(file);
    const buf = await getBuffer(url.replace(/^http:/, 'https:'), { timeout: 15000 });
    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, buf);
    return buf;
  }

  async state() {
    const acc = this.accounts.active();
    const lib = await this.library();
    const items = [];
    for (const it of lib.items) {
      try {
        items.push({ ...it, image: dataUrl(await fsp.readFile(path.join(this.dir(), `${it.hash}.png`))) });
      } catch {}
    }
    const out = { account: acc ? { name: acc.name, type: acc.type, uuid: acc.uuid } : null, items, current: null, capes: [], serverReady: this.backend.configured() };
    if (!acc) return out;
    try {
      out.current = await this.current(acc);
    } catch (e) {
      this.log.warn('No se pudo leer la skin actual:', e.message);
    }
    if (acc.type === 'microsoft') {
      for (const c of acc.capes || []) {
        try {
          out.capes.push({ id: c.id, alias: c.alias, active: c.state === 'ACTIVE', image: dataUrl(await this.textureCached(c.url)) });
        } catch {}
      }
    }
    return out;
  }

  async current(acc = this.accounts.active()) {
    if (!acc) return null;
    if (acc.type === 'microsoft') {
      const s = (acc.skins || []).find((x) => x.state === 'ACTIVE');
      if (!s?.url) return null;
      return { image: dataUrl(await this.textureCached(s.url)), model: String(s.variant).toLowerCase() === 'slim' ? 'slim' : 'classic', hash: sha1(Buffer.from(s.url)) };
    }
    if (!this.backend.configured()) return acc.skin?.hash ? await this.localByHash(acc.skin.hash, acc.skin.model) : null;
    const r = await this.backend.call(`/v1/skins/${encodeURIComponent(acc.name)}`, { ok: [404], timeout: 10000 }).catch(() => null);
    if (!r?.hash) return null;
    const buf = await this.textureCached(this.backend.url(`/csl/textures/${r.hash}`));
    return { image: dataUrl(buf), model: r.model === 'slim' ? 'slim' : 'classic', hash: r.hash };
  }

  async localByHash(hash, model) {
    const file = path.join(this.dir(), `${hash}.png`);
    if (!(await exists(file))) return null;
    return { image: dataUrl(await fsp.readFile(file)), model: model || 'classic', hash };
  }

  async add({ bytes, name, model }) {
    const buf = Buffer.from(bytes);
    validateSkin(buf, { premium: false });
    const hash = sha1(buf);
    await ensureDir(this.dir());
    await fsp.writeFile(path.join(this.dir(), `${hash}.png`), buf);
    const lib = await this.library();
    const existing = lib.items.find((x) => x.hash === hash);
    if (existing) {
      existing.name = String(name || existing.name).slice(0, 40);
      existing.model = model === 'slim' ? 'slim' : 'classic';
    } else {
      lib.items.unshift({ id: crypto.randomUUID(), hash, name: String(name || 'Mi skin').slice(0, 40), model: model === 'slim' ? 'slim' : 'classic', addedAt: Date.now() });
    }
    lib.items = lib.items.slice(0, 200);
    await this.saveLibrary(lib);
    return this.state();
  }

  async importFromName(name) {
    const nick = String(name || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) throw new Error('Escribe un nick válido.');
    const { status, data } = await request(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(nick)}`, { ok: [404, 204], timeout: 10000 });
    if (status !== 200 || !data?.id) throw new Error(`No existe ninguna cuenta premium llamada "${nick}".`);
    const prof = await getJson(`https://sessionserver.mojang.com/session/minecraft/profile/${data.id}`, { timeout: 10000 });
    const prop = prof?.properties?.find((p) => p.name === 'textures');
    const tex = prop ? JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')) : null;
    const skin = tex?.textures?.SKIN;
    if (!skin?.url) throw new Error(`${data.name} usa la skin por defecto.`);
    const buf = await this.textureCached(skin.url);
    return this.add({ bytes: buf, name: data.name, model: skin.metadata?.model === 'slim' ? 'slim' : 'classic' });
  }

  async update(id, { name, model }) {
    const lib = await this.library();
    const it = lib.items.find((x) => x.id === id);
    if (!it) throw new Error('Esa skin ya no está en tu biblioteca.');
    if (name != null) it.name = String(name).slice(0, 40) || it.name;
    if (model) it.model = model === 'slim' ? 'slim' : 'classic';
    await this.saveLibrary(lib);
    return this.state();
  }

  async remove(id) {
    const lib = await this.library();
    const it = lib.items.find((x) => x.id === id);
    lib.items = lib.items.filter((x) => x.id !== id);
    await this.saveLibrary(lib);
    if (it && !lib.items.some((x) => x.hash === it.hash)) await fsp.rm(path.join(this.dir(), `${it.hash}.png`), { force: true });
    return this.state();
  }

  async apply(id) {
    const acc = this.accounts.active();
    if (!acc) throw new Error('Inicia sesión primero.');
    const lib = await this.library();
    const it = lib.items.find((x) => x.id === id);
    if (!it) throw new Error('Esa skin ya no está en tu biblioteca.');
    const buf = await fsp.readFile(path.join(this.dir(), `${it.hash}.png`));
    if (acc.type === 'microsoft') {
      validateSkin(buf, { premium: true });
      const fresh = await this.accounts.ensureFresh(acc);
      const form = new FormData();
      form.append('variant', it.model === 'slim' ? 'slim' : 'classic');
      form.append('file', new Blob([buf], { type: 'image/png' }), 'skin.png');
      try {
        await request('https://api.minecraftservices.com/minecraft/profile/skins', {
          method: 'POST', body: form, headers: { Authorization: `Bearer ${fresh.mcToken}` }, timeout: 30000, retries: 0,
        });
      } catch (e) {
        if (e.status === 429) throw new Error('Mojang solo permite cambiar la skin unas pocas veces por minuto. Espera un momento.');
        if (e.status === 400) throw new Error('Mojang rechazó la imagen. Revisa que sea una skin válida de 64×64.');
        throw e;
      }
      await this.accounts.refreshProfile(fresh);
    } else {
      if (!this.backend.configured()) throw new Error('El servidor de skins todavía no está configurado.');
      const token = await this.accounts.session(acc);
      await this.backend.call('/v1/skins/me', {
        method: 'PUT', body: buf, token, timeout: 20000,
        headers: { 'Content-Type': 'image/png', 'X-Skin-Model': it.model === 'slim' ? 'slim' : 'classic' },
      });
      this.accounts.upsert({ ...acc, skin: { hash: it.hash, model: it.model } });
      this.accounts.save();
    }
    this.log.info(`Skin aplicada (${acc.type}): ${it.name}`);
    return this.state();
  }

  async resetSkin() {
    const acc = this.accounts.active();
    if (!acc) throw new Error('Inicia sesión primero.');
    if (acc.type === 'microsoft') {
      const fresh = await this.accounts.ensureFresh(acc);
      await request('https://api.minecraftservices.com/minecraft/profile/skins/active', { method: 'DELETE', headers: { Authorization: `Bearer ${fresh.mcToken}` } });
      await this.accounts.refreshProfile(fresh);
    } else if (this.backend.configured()) {
      const token = await this.accounts.session(acc);
      await this.backend.call('/v1/skins/me', { method: 'DELETE', token });
      this.accounts.upsert({ ...acc, skin: null });
      this.accounts.save();
    }
    return this.state();
  }

  async setCape(capeId) {
    const acc = this.accounts.active();
    if (acc?.type !== 'microsoft') throw new Error('Las capas solo están disponibles en cuentas premium.');
    const fresh = await this.accounts.ensureFresh(acc);
    const headers = { Authorization: `Bearer ${fresh.mcToken}` };
    if (capeId) {
      await request('https://api.minecraftservices.com/minecraft/profile/capes/active', { method: 'PUT', json: { capeId }, headers });
    } else {
      await request('https://api.minecraftservices.com/minecraft/profile/capes/active', { method: 'DELETE', headers });
    }
    await this.accounts.refreshProfile(fresh);
    return this.state();
  }
}

module.exports = { Skins, pngInfo, validateSkin };
