'use strict';

let USER_AGENT = 'ViciontStudioLauncher/dev (+https://github.com/CrissyjuanxD/Viciont-Studio-Launcher)';
const setUserAgent = (ua) => { USER_AGENT = ua; };
const userAgent = () => USER_AGENT;

class HttpError extends Error {
  constructor(status, url, body) {
    let detail = '';
    try {
      const j = JSON.parse(body);
      detail = j.message || j.errorMessage || j.error_description || j.error || '';
    } catch { detail = String(body || '').slice(0, 160); }
    super(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
    try { this.json = JSON.parse(body); } catch { this.json = null; }
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError(signal)); }, { once: true });
});

function abortError(signal) {
  const r = signal?.reason;
  if (r instanceof Error && r.name === 'AbortError') return r;
  const e = new Error('Operación cancelada');
  e.name = 'AbortError';
  return e;
}

const isNetworkError = (e) => e && (e.name === 'TypeError' || e.name === 'TimeoutError' || e.code === 'ETIMEDOUT' ||
  /fetch failed|network|socket|ECONN|ENOTFOUND|EAI_AGAIN|timeout|terminated/i.test(`${e.message} ${e.cause?.code || ''}`));

async function request(url, opts = {}) {
  const {
    method = 'GET', headers = {}, body, json, form, timeout = 25000, signal,
    retries = 2, type = 'json', ok = [],
  } = opts;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError(signal);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
    try {
      const h = { 'User-Agent': USER_AGENT, ...headers };
      let payload = body;
      if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
      if (form !== undefined) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
      if (type === 'json' && !h.Accept) h.Accept = 'application/json';
      const res = await fetch(url, { method, headers: h, body: payload, signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok && !ok.includes(res.status)) {
        const text = await res.text().catch(() => '');
        const err = new HttpError(res.status, url, text);
        const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
        if (retryable && attempt < retries) {
          const ra = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 15000) : 600 * 2 ** attempt, signal);
          continue;
        }
        throw err;
      }
      if (type === 'response') return { status: res.status, headers: res.headers, data: res };
      let data;
      if (type === 'buffer') data = Buffer.from(await res.arrayBuffer());
      else {
        const text = await res.text();
        if (type === 'json') {
          try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`Respuesta no válida de ${new URL(url).host}`); }
        } else data = text;
      }
      return { status: res.status, headers: res.headers, data };
    } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      if (e instanceof HttpError) throw e;
      if ((timedOut || isNetworkError(e)) && attempt < retries) {
        await sleep(700 * 2 ** attempt, signal);
        continue;
      }
      if (timedOut) {
        const err = new Error(`El servidor ${new URL(url).host} tardó demasiado en responder`);
        err.code = 'ETIMEDOUT';
        throw err;
      }
      if (isNetworkError(e)) {
        const err = new Error(`No se pudo conectar con ${new URL(url).host}. Revisa tu conexión a internet.`);
        err.code = 'ENETWORK';
        err.cause = e;
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

const getJson = async (url, opts) => (await request(url, { ...opts, type: 'json' })).data;
const getText = async (url, opts) => (await request(url, { ...opts, type: 'text' })).data;
const getBuffer = async (url, opts) => (await request(url, { ...opts, type: 'buffer' })).data;

const memo = new Map();
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  if (hit?.p) return hit.p;
  const p = fn().then((v) => { memo.set(key, { t: Date.now(), v }); return v; })
    .catch((e) => { if (hit && 'v' in hit) { memo.set(key, hit); return hit.v; } memo.delete(key); throw e; });
  memo.set(key, { ...(hit || {}), p });
  return p;
}

module.exports = {
  HttpError, request, getJson, getText, getBuffer, cached, sleep, abortError, isNetworkError,
  setUserAgent, userAgent,
};
