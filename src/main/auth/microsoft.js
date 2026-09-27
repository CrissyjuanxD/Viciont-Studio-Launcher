'use strict';
// Inicio de sesión con Microsoft (cuentas premium de Minecraft Java), igual que
// Modrinth App y el launcher oficial: la contraseña se escribe SOLO en la página
// oficial de Microsoft, dentro de una ventana aparte; el launcher nunca la ve.
// Microsoft recuerda tu cuenta en esa ventana (como en Modrinth), así que la
// próxima vez solo tendrás que elegirla.

const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, shell, session } = require('electron');
const { request, HttpError } = require('../util/net');
const xbox = require('./xbox');

const PARTITION = 'persist:vsl-microsoft';
const ICON = path.join(__dirname, '..', '..', 'renderer', 'img', 'icon.png');
const MS_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(live\.com|microsoft\.com|microsoftonline\.com|xboxlive\.com|xbox\.com|msauth\.net|msftauth\.net|live\.net|microsoftonline-p\.com|office\.com|bing\.com)(\/|$)/i;
const { authError } = xbox;

let current = null; // ventana de inicio de sesión abierta (solo puede haber una)

// La ventana se identifica como un navegador normal (sin "Electron"), igual que
// el motor de Windows que usa Modrinth, para que Microsoft muestre su página de siempre.
let sessionReady = false;
function loginSession() {
  const ses = session.fromPartition(PARTITION);
  if (!sessionReady) {
    sessionReady = true;
    const ua = app.userAgentFallback.replace(/\s(Electron|viciont-studio-launcher|Viciont Studio Launcher)\/\S+/gi, '');
    ses.setUserAgent(ua);
    ses.setPermissionRequestHandler((_, perm, cb) => cb(['clipboard-sanitized-write', 'storage-access', 'top-level-storage-access'].includes(perm)));
  }
  return ses;
}

// Trae al frente la ventana de Microsoft si ya está abierta.
function focusLoginWindow() {
  if (!current || current.isDestroyed()) return false;
  if (current.isMinimized()) current.restore();
  current.show();
  current.focus();
  current.flashFrame(true);
  return true;
}

function cancelLogin() {
  if (current && !current.isDestroyed()) current.close();
}

// Abre la página oficial de Microsoft y espera el código de autorización.
function openLoginWindow(url) {
  // como Modrinth: si ya había una ventana de inicio de sesión, se cierra antes de abrir otra
  if (current && !current.isDestroyed()) current.destroy();
  return new Promise((resolve, reject) => {
    let done = false;
    const win = new BrowserWindow({
      width: 1000, height: 700, minWidth: 500, minHeight: 500, center: true,
      alwaysOnTop: true, autoHideMenuBar: true, show: true,
      title: 'Iniciar sesión en Minecraft — Viciont Studio Launcher',
      backgroundColor: '#ffffff', icon: ICON,
      webPreferences: { session: loginSession(), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    current = win;
    win.setMenu(null);
    win.on('page-title-updated', (e) => e.preventDefault());
    win.flashFrame(true);
    win.once('focus', () => win.flashFrame(false));
    win.focus();
    const finish = (err, code) => {
      if (done) return;
      done = true;
      if (current === win) current = null;
      if (!win.isDestroyed()) win.destroy();
      if (err) reject(err); else resolve(code);
    };
    const check = (u) => {
      if (!u || !u.startsWith(xbox.REDIRECT)) return false;
      const q = new URL(u).searchParams;
      const code = q.get('code');
      const error = q.get('error');
      if (code) finish(null, code);
      else if (error === 'access_denied') finish(authError('Cancelaste el inicio de sesión.', 'ECANCEL'));
      else finish(authError(q.get('error_description') || 'Microsoft no completó el inicio de sesión.'));
      return true;
    };
    const wc = win.webContents;
    wc.on('will-redirect', (e, u) => { if (check(e?.url || u)) e.preventDefault(); });
    wc.on('did-navigate', (_, u) => check(u));
    wc.on('did-redirect-navigation', (e, u) => check(e?.url || u));
    // Solo se permiten páginas de Microsoft; cualquier otro enlace se abre en el navegador.
    wc.on('will-navigate', (e, u) => {
      const target = e?.url || u;
      if (check(target)) { e.preventDefault(); return; }
      if (!MS_HOSTS.test(target)) {
        e.preventDefault();
        if (/^https:\/\//i.test(target)) shell.openExternal(target);
      }
    });
    wc.setWindowOpenHandler(({ url: u }) => {
      if (/^https:\/\//i.test(u)) shell.openExternal(u);
      return { action: 'deny' };
    });
    wc.on('did-fail-load', (_, code, desc, u) => {
      if (u?.startsWith(xbox.REDIRECT) || code === -3) return;
      if (!done && code <= -100) finish(authError('No se pudo abrir la página de Microsoft. Revisa tu conexión.', 'ENETWORK'));
    });
    win.on('closed', () => finish(authError('Cerraste la ventana de inicio de sesión.', 'ECANCEL')));
    // se cierra sola a los 10 minutos, como en Modrinth
    const timer = setTimeout(() => finish(authError('El inicio de sesión tardó demasiado. Vuelve a intentarlo.', 'ECANCEL')), 10 * 60 * 1000);
    win.on('closed', () => clearTimeout(timer));
    win.loadURL(url).catch(() => {});
  });
}

// Olvida la cuenta de Microsoft recordada en la ventana de inicio de sesión.
async function clearWebSession() {
  try { await session.fromPartition(PARTITION).clearStorageData(); } catch { /* sin datos */ }
}

async function getProfile(mcAccessToken) {
  try {
    const { data } = await request('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: `Bearer ${mcAccessToken}` }, timeout: 20000,
    });
    return data;
  } catch (e) {
    if (e.status === 404) throw authError('Esta cuenta de Microsoft no tiene Minecraft: Java Edition.', 'ENOGAME');
    if (e.status === 401) throw authError('La sesión de Minecraft caducó. Vuelve a iniciar sesión.', 'EEXPIRED');
    throw e;
  }
}

const dashed = (id) => String(id).replace(/-/g, '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

function accountFromProfile(profile, refreshToken, mc, flow, xuid) {
  return {
    type: 'microsoft',
    flow,
    uuid: dashed(profile.id),
    name: profile.name,
    msRefresh: refreshToken,
    mcToken: mc.accessToken,
    mcExpiresAt: mc.expiresAt,
    xuid: xuid || null,
    skins: profile.skins || [],
    capes: profile.capes || [],
    addedAt: Date.now(),
  };
}

// ---------- Dispositivo (clave propia del PC, como Modrinth) ----------
async function ensureDevice(store) {
  let dev = store.get();
  if (!dev?.key?.privatePem) dev = { key: xbox.createDeviceKey() };
  if (!dev.token || !dev.notAfter || dev.notAfter - Date.now() < 30 * 60 * 1000) {
    const t = await xbox.deviceToken(dev.key);
    dev = { ...dev, token: t.token, notAfter: t.notAfter };
    store.set(dev);
  }
  return dev;
}

async function xboxToMinecraft(accessToken, sessionId, store) {
  const dev = await ensureDevice(store);
  const auth = await xbox.sisuAuthorize(sessionId, accessToken, dev.token, dev.key);
  const xsts = await xbox.xstsAuthorize(auth, dev.token, dev.key);
  const mc = await xbox.minecraftLogin(xsts);
  return { mc, xuid: xsts.xid };
}

// ---------- Método clásico (plan B y cuentas añadidas con la 1.0.0) ----------
// RpsTicket: "t=" con el token del cliente del launcher oficial (MBI_SSL) y "d=" con
// el de la 1.0.0 (XboxLive.signin).
const V1_SCOPE = 'XboxLive.signin offline_access';

async function v1Token(form) {
  try {
    const { data } = await request('https://login.live.com/oauth20_token.srf', {
      method: 'POST', form: { client_id: xbox.CLIENT_ID, redirect_uri: xbox.REDIRECT, scope: V1_SCOPE, ...form }, timeout: 20000,
    });
    if (!data?.access_token) throw authError('Microsoft no devolvió una sesión válida.');
    return data;
  } catch (e) {
    if (e instanceof HttpError && (e.status === 400 || e.status === 401)) throw authError('La sesión de Microsoft caducó. Vuelve a iniciar sesión.', 'EEXPIRED');
    throw e;
  }
}

async function classicXbox(msAccessToken, prefix) {
  let xbl;
  try {
    xbl = (await request('https://user.auth.xboxlive.com/user/authenticate', {
      method: 'POST', headers: { 'x-xbl-contract-version': '1' }, timeout: 25000,
      json: { Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `${prefix}=${msAccessToken}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' },
    })).data;
  } catch (e) {
    if (!e.status) throw authError('No se pudo conectar con Xbox Live. Revisa tu conexión.', 'ENETWORK');
    throw authError(`Xbox Live rechazó el inicio de sesión (HTTP ${e.status}).`, 'EXBOX', { status: e.status });
  }
  let xsts;
  try {
    xsts = (await request('https://xsts.auth.xboxlive.com/xsts/authorize', {
      method: 'POST', headers: { 'x-xbl-contract-version': '1' }, timeout: 25000,
      json: { Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' },
    })).data;
  } catch (e) {
    const x = e.json?.XErr;
    throw authError(xbox.XERR[x] || `Xbox Live rechazó la cuenta (${x || e.status || e.message}).`, 'EXBOX', { xerr: x || null });
  }
  const claim = xsts?.DisplayClaims?.xui?.[0];
  if (!claim?.uhs || !xsts.Token) throw authError('Xbox Live no devolvió una sesión válida.', 'EXBOX');
  try {
    return { mc: await xbox.minecraftLogin({ uhs: claim.uhs, token: xsts.Token }), xuid: claim.xid || null };
  } catch {
    // servicio anterior de Minecraft (por si el nuevo falla)
    const mc = (await request('https://api.minecraftservices.com/authentication/login_with_xbox', {
      method: 'POST', json: { identityToken: `XBL3.0 x=${claim.uhs};${xsts.Token}` }, timeout: 25000,
    })).data;
    return { mc: { accessToken: mc.access_token, expiresAt: Date.now() + (Number(mc.expires_in) || 86400) * 1000 }, xuid: claim.xid || null };
  }
}

// Del token de Microsoft al de Minecraft: primero el método moderno (dispositivo
// firmado, como Modrinth) y, si falla por algo que no sea un problema de la cuenta,
// el clásico con el mismo token. Así un cambio de Xbox no deja a nadie sin poder entrar.
async function toMinecraft(msAccessToken, sessionId, store) {
  try {
    return { ...(await xboxToMinecraft(msAccessToken, sessionId, store)), flow: 'sisu' };
  } catch (e) {
    if (e.xerr || e.code === 'ENETWORK') throw e;
    return { ...(await classicXbox(msAccessToken, 't')), flow: 'classic' };
  }
}


// Si Xbox no ofrece el inicio moderno (caída o cambio), se usa la página clásica.
async function classicLogin() {
  const p = new URLSearchParams({ client_id: xbox.CLIENT_ID, response_type: 'code', redirect_uri: xbox.REDIRECT, scope: xbox.SCOPE, prompt: 'select_account' });
  const code = await openLoginWindow(`https://login.live.com/oauth20_authorize.srf?${p}`);
  const ms = await xbox.msToken({ code, grant_type: 'authorization_code' });
  const { mc, xuid } = await classicXbox(ms.access_token, 't');
  return accountFromProfile(await getProfile(mc.accessToken), ms.refresh_token, mc, 'classic', xuid);
}

// ---------- API ----------
/**
 * store: { get(): dispositivo|null, set(dispositivo) } — se guarda cifrado con las cuentas.
 */
async function login(store) {
  let flow;
  try {
    const dev = await ensureDevice(store);
    const { verifier, challenge } = xbox.pkce();
    const { sessionId, url } = await xbox.sisuAuthenticate(dev.token, challenge, dev.key);
    flow = { verifier, sessionId, url };
  } catch (e) {
    if (e.code === 'ECANCEL') throw e;
    return classicLogin();
  }
  const code = await openLoginWindow(flow.url);
  const ms = await xbox.oauthToken(code, flow.verifier);
  const r = await toMinecraft(ms.access_token, flow.sessionId, store);
  const profile = await getProfile(r.mc.accessToken);
  return accountFromProfile(profile, ms.refresh_token, r.mc, r.flow, r.xuid);
}

// Renueva la sesión sin volver a pedir la contraseña (unos 90 días).
async function refresh(account, store) {
  if (!account.msRefresh) throw authError('Vuelve a iniciar sesión con Microsoft.', 'EEXPIRED');
  let ms;
  let r;
  if (account.flow === 'sisu' || account.flow === 'classic') {
    ms = await xbox.oauthRefresh(account.msRefresh);
    r = account.flow === 'sisu' ? await toMinecraft(ms.access_token, null, store) : { ...(await classicXbox(ms.access_token, 't')), flow: 'classic' };
  } else {
    // cuenta añadida con la versión 1.0.0
    ms = await v1Token({ refresh_token: account.msRefresh, grant_type: 'refresh_token' });
    r = { ...(await classicXbox(ms.access_token, 'd')), flow: 'v1' };
  }
  const profile = await getProfile(r.mc.accessToken);
  return { ...account, ...accountFromProfile(profile, ms.refresh_token || account.msRefresh, r.mc, r.flow, r.xuid || account.xuid), addedAt: account.addedAt };
}

// Demuestra a nuestro servidor que la cuenta es premium sin enviarle el token
// (el mismo sistema que usan los servidores de Minecraft en modo online).
async function joinServer(account, serverId) {
  await request('https://sessionserver.mojang.com/session/minecraft/join', {
    method: 'POST', type: 'text', ok: [204],
    json: { accessToken: account.mcToken, selectedProfile: account.uuid.replace(/-/g, ''), serverId },
    timeout: 15000,
  });
}

// ---------- Prueba premium con el certificado de Mojang ----------
// Si Mojang no contesta a nuestro servidor, este comprueba la cuenta sin hablar con
// Mojang: el certificado de jugador (el mismo que usa el juego para el chat firmado)
// y las texturas del perfil vienen firmados por Mojang, y el launcher firma nuestro
// desafío con la clave del certificado. El token de Minecraft nunca sale del PC.
const pemBody = (pem) => String(pem || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

function privateKeyFrom(pem) {
  const der = Buffer.from(pemBody(pem), 'base64');
  try { return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }); } catch { /* formato antiguo */ }
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs1' });
}

async function playerCertificate(account) {
  const c = account.cert;
  const now = Date.now();
  if (c?.publicKey && c?.privateKey && Date.parse(c.expiresAt) - now > 60 * 60 * 1000 && Date.parse(c.refreshedAfter || c.expiresAt) > now) return c;
  let data;
  try {
    ({ data } = await request('https://api.minecraftservices.com/player/certificates', {
      method: 'POST', headers: { Authorization: `Bearer ${account.mcToken}` }, body: '', timeout: 20000,
    }));
  } catch (e) {
    if (e.status === 401) throw authError('La sesión de Minecraft caducó. Vuelve a iniciar sesión.', 'EEXPIRED');
    throw e;
  }
  if (!data?.keyPair?.publicKey || !data?.keyPair?.privateKey || !data?.publicKeySignatureV2 || !data?.expiresAt) throw authError('Mojang no devolvió un certificado válido.');
  const publicKey = pemBody(data.keyPair.publicKey);
  crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }); // comprobación
  const privateKey = privateKeyFrom(data.keyPair.privateKey).export({ type: 'pkcs8', format: 'pem' });
  return { publicKey, privateKey, signature: data.publicKeySignatureV2, expiresAt: data.expiresAt, refreshedAfter: data.refreshedAfter || null };
}

// Texturas del perfil firmadas por Mojang (dicen el nombre actual de la cuenta).
const texturesCache = new Map();
async function signedTextures(uuid) {
  const id = String(uuid).replace(/-/g, '');
  const hit = texturesCache.get(id);
  if (hit && Date.now() - hit.at < 12 * 60 * 1000) return hit.textures;
  const { data } = await request(`https://sessionserver.mojang.com/session/minecraft/profile/${id}?unsigned=false`, { timeout: 15000, retries: 3 });
  const t = (data?.properties || []).find((p) => p.name === 'textures');
  if (!t?.value || !t?.signature) throw authError('Mojang no devolvió el perfil firmado.');
  const textures = { value: t.value, signature: t.signature };
  texturesCache.set(id, { at: Date.now(), textures });
  return textures;
}

/**
 * Devuelve { cert, payload }: el certificado (para guardarlo cifrado con la cuenta)
 * y los datos que se envían al servidor del estudio.
 */
async function premiumProof(account, challenge) {
  const [cert, textures] = await Promise.all([playerCertificate(account), signedTextures(account.uuid)]);
  const proof = crypto.sign('sha256', Buffer.from(`vsl-auth:${challenge}`), crypto.createPrivateKey(cert.privateKey)).toString('base64');
  return {
    cert,
    payload: {
      uuid: String(account.uuid).replace(/-/g, ''),
      cert: { publicKey: cert.publicKey, expiresAt: cert.expiresAt, signature: cert.signature },
      proof,
      textures,
    },
  };
}

module.exports = { login, refresh, getProfile, joinServer, premiumProof, dashed, clearWebSession, focusLoginWindow, cancelLogin };
