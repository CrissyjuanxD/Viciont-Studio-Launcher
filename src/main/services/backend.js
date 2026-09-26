'use strict';
// Cliente del servidor del estudio (Cloudflare Worker + R2): instancias,
// permisos, archivos privados, skins no premium y administración.

const path = require('node:path');
const { request, getJson } = require('../util/net');
const { readJson, writeJsonAtomic } = require('../util/fsx');
const { configFile } = require('../core/paths');

// Configuración remota: permite cambiar la URL del servidor sin publicar otra versión.
const REMOTE_CONFIG = 'https://raw.githubusercontent.com/CrissyjuanxD/Viciont-Studio-Launcher/main/remote/launcher.json';
const REMOTE_CACHE = configFile('remote.json');

class Backend {
  constructor(settings, log) {
    this.settings = settings;
    this.log = log;
    this.remote = null;
  }

  async init() {
    this.remote = await readJson(REMOTE_CACHE, null);
    this.refreshRemote().catch(() => {});
  }

  async refreshRemote() {
    try {
      const data = await getJson(`${REMOTE_CONFIG}?t=${Math.floor(Date.now() / 60000)}`, { timeout: 8000, retries: 1 });
      if (data && typeof data === 'object') {
        this.remote = data;
        await writeJsonAtomic(REMOTE_CACHE, data);
      }
    } catch (e) {
      this.log.warn('No se pudo leer la configuración remota:', e.message);
    }
    return this.remote;
  }

  base() {
    const s = this.settings.get().apiBase;
    const r = this.remote?.apiBase;
    const b = s || (typeof r === 'string' && /^https:\/\//i.test(r) ? r : '');
    return b ? b.replace(/\/+$/, '') : '';
  }

  configured() { return Boolean(this.base()); }

  news() { return Array.isArray(this.remote?.news) ? this.remote.news.slice(0, 6) : []; }

  async call(pathname, { method = 'GET', json, body, headers = {}, token, adminKey, type = 'json', timeout = 20000, signal, ok, retries } = {}) {
    const base = this.base();
    if (!base) {
      const e = new Error('El servidor de instancias todavía no está configurado.');
      e.code = 'ENOBACKEND';
      throw e;
    }
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (adminKey) h['X-Admin-Key'] = adminKey;
    try {
      const res = await request(`${base}${pathname}`, { method, json, body, headers: h, type, timeout, signal, ok, retries });
      return res.data;
    } catch (e) {
      if (e.json?.message) e.message = e.json.message;
      if (e.json?.error) e.code = e.json.error;
      throw e;
    }
  }

  url(pathname) { return `${this.base()}${pathname}`; }
}

module.exports = { Backend, REMOTE_CONFIG, path };
