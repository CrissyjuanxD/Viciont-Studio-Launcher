'use strict';
// Autenticación de Xbox con "SISU" y token de dispositivo firmado: el mismo método
// que usan el launcher oficial de Minecraft y Modrinth App.
//
//   1. El PC tiene una clave propia (ECDSA P-256) → token de dispositivo de Xbox.
//   2. SISU devuelve la página oficial de Microsoft para iniciar sesión (con PKCE).
//   3. Con el código de Microsoft, SISU autoriza al usuario (y al título Minecraft).
//   4. XSTS → token de Minecraft (launcher/login).
// Todas las peticiones a Xbox van firmadas con la clave del dispositivo.

const crypto = require('node:crypto');
const { userAgent } = require('../util/net');

const CLIENT_ID = '00000000402b5328';
const REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const TITLE_ID = '1794566092';

const XERR = {
  2148916227: 'Esta cuenta está suspendida en Xbox Live.',
  2148916229: 'La configuración de privacidad o de familia de la cuenta no permite jugar en línea.',
  2148916233: 'Esta cuenta de Microsoft no tiene perfil de Xbox. Entra una vez en minecraft.net o xbox.com para crearlo y vuelve a intentarlo.',
  2148916234: 'Debes aceptar los términos de Xbox Live. Entra en xbox.com y vuelve a intentarlo.',
  2148916235: 'Xbox Live no está disponible en tu país o región.',
  2148916236: 'Tu cuenta necesita verificación de edad (Corea del Sur).',
  2148916237: 'Tu cuenta necesita verificación de edad (Corea del Sur).',
  2148916238: 'Es una cuenta de menor de edad: un adulto debe añadirla a un grupo familiar de Microsoft.',
};

// Diferencia entre el reloj del PC y el de Microsoft (las firmas llevan la hora).
let skew = 0;
const now = () => Date.now() + skew;

function authError(message, code = 'EAUTH', extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- Clave del dispositivo ----------
function createDeviceKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    id: crypto.randomUUID(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    x: jwk.x,
    y: jwk.y,
  };
}

const proofKey = (key) => ({ kty: 'EC', x: key.x, y: key.y, crv: 'P-256', alg: 'ES256', use: 'sig' });

// Firma de Xbox: versión + hora (FILETIME) + método + ruta + autorización + cuerpo.
function signature(key, path, body, authorization = '') {
  const filetime = (BigInt(Math.floor(now() / 1000)) + 11644473600n) * 10000000n;
  const t = Buffer.alloc(8);
  t.writeBigUInt64BE(filetime);
  const v = Buffer.from([0, 0, 0, 1]);
  const zero = Buffer.from([0]);
  const payload = Buffer.concat([
    v, zero, t, zero, Buffer.from('POST'), zero, Buffer.from(path), zero,
    Buffer.from(authorization), zero, body, zero,
  ]);
  const sig = crypto.sign('sha256', payload, { key: crypto.createPrivateKey(key.privatePem), dsaEncoding: 'ieee-p1363' });
  return Buffer.concat([v, t, sig]).toString('base64');
}

async function signedPost(url, body, key, { contract = true, timeout = 25000 } = {}) {
  const path = new URL(url).pathname;
  const raw = Buffer.from(JSON.stringify(body));
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    Accept: 'application/json',
    Signature: signature(key, path, raw),
    'User-Agent': userAgent(),
  };
  if (contract) headers['x-xbl-contract-version'] = '1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: raw, signal: ctrl.signal });
  } catch (e) {
    throw authError('No se pudo conectar con Xbox Live. Revisa tu conexión.', 'ENETWORK', { cause: e });
  } finally {
    clearTimeout(timer);
  }
  const date = Date.parse(res.headers.get('date') || '');
  if (Number.isFinite(date)) skew = date - Date.now();
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, headers: res.headers, data };
}

function xboxFailure(step, r) {
  const x = r.data?.XErr;
  if (x && XERR[x]) return authError(XERR[x], 'EXBOX', { xerr: x });
  if (r.status === 401 || r.status === 403) return authError(`Xbox Live rechazó el inicio de sesión (${step}${x ? `, ${x}` : ''}).`, 'EXBOX', { status: r.status });
  return authError(`Xbox Live no respondió bien (${step}, HTTP ${r.status}).`, 'EXBOX', { status: r.status });
}

// ---------- Pasos ----------
async function deviceToken(key) {
  const r = await signedPost('https://device.auth.xboxlive.com/device/authenticate', {
    Properties: {
      AuthMethod: 'ProofOfPossession',
      Id: `{${key.id.toUpperCase()}}`,
      DeviceType: 'Win32',
      Version: '10.16.0',
      ProofKey: proofKey(key),
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  }, key);
  if (r.status !== 200 || !r.data?.Token) throw xboxFailure('dispositivo', r);
  return { token: r.data.Token, notAfter: Date.parse(r.data.NotAfter) || now() + 12 * 3600 * 1000 };
}

function pkce() {
  const verifier = crypto.randomBytes(64).toString('hex');
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function sisuAuthenticate(devToken, challenge, key) {
  const r = await signedPost('https://sisu.xboxlive.com/authenticate', {
    AppId: CLIENT_ID,
    DeviceToken: devToken,
    Offers: [SCOPE],
    Query: {
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: crypto.randomBytes(32).toString('hex'),
      prompt: 'select_account',
    },
    RedirectUri: REDIRECT,
    Sandbox: 'RETAIL',
    TokenType: 'code',
    TitleId: TITLE_ID,
  }, key);
  const sessionId = r.headers.get('x-sessionid');
  if (r.status !== 200 || !r.data?.MsaOauthRedirect || !sessionId) throw xboxFailure('sisu', r);
  return { sessionId, url: r.data.MsaOauthRedirect };
}

async function msToken(form) {
  let res;
  try {
    res = await fetch('https://login.live.com/oauth20_token.srf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': userAgent() },
      body: new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPE, ...form }).toString(),
    });
  } catch (e) {
    throw authError('No se pudo conectar con Microsoft. Revisa tu conexión.', 'ENETWORK', { cause: e });
  }
  const date = Date.parse(res.headers.get('date') || '');
  if (Number.isFinite(date)) skew = date - Date.now();
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    if (res.status === 400 || res.status === 401) throw authError('La sesión de Microsoft caducó. Vuelve a iniciar sesión.', 'EEXPIRED');
    throw authError(`Microsoft no devolvió una sesión válida (HTTP ${res.status}).`);
  }
  return data;
}

const oauthToken = (code, verifier) => msToken({ code, code_verifier: verifier, grant_type: 'authorization_code' });
const oauthRefresh = (refreshToken) => msToken({ refresh_token: refreshToken, grant_type: 'refresh_token' });

async function sisuAuthorize(sessionId, accessToken, devToken, key) {
  const r = await signedPost('https://sisu.xboxlive.com/authorize', {
    AccessToken: `t=${accessToken}`,
    AppId: CLIENT_ID,
    DeviceToken: devToken,
    ProofKey: proofKey(key),
    Sandbox: 'RETAIL',
    SessionId: sessionId || null,
    SiteName: 'user.auth.xboxlive.com',
    RelyingParty: 'http://xboxlive.com',
    UseModernGamertag: true,
  }, key, { contract: false });
  if (r.status !== 200 || !r.data?.UserToken?.Token) throw xboxFailure('autorización', r);
  return r.data;
}

async function xstsAuthorize(auth, devToken, key) {
  const r = await signedPost('https://xsts.auth.xboxlive.com/xsts/authorize', {
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
    Properties: {
      SandboxId: 'RETAIL',
      UserTokens: [auth.UserToken.Token],
      DeviceToken: devToken,
      TitleToken: auth.TitleToken?.Token,
    },
  }, key);
  const uhs = r.data?.DisplayClaims?.xui?.[0]?.uhs;
  if (r.status !== 200 || !r.data?.Token || !uhs) throw xboxFailure('XSTS', r);
  return { token: r.data.Token, uhs, xid: r.data.DisplayClaims.xui[0].xid || null };
}

async function minecraftLogin(xsts) {
  let res;
  try {
    res = await fetch('https://api.minecraftservices.com/launcher/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgent() },
      body: JSON.stringify({ platform: 'PC_LAUNCHER', xtoken: `XBL3.0 x=${xsts.uhs};${xsts.token}` }),
    });
  } catch (e) {
    throw authError('No se pudo conectar con los servidores de Minecraft.', 'ENETWORK', { cause: e });
  }
  const data = await res.json().catch(() => null);
  if (res.status === 429) throw authError('Demasiados intentos. Espera un minuto y vuelve a probar.');
  if (!res.ok || !data?.access_token) throw authError(`Minecraft no aceptó la sesión (HTTP ${res.status}).`);
  return { accessToken: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 86400) * 1000 };
}

module.exports = {
  CLIENT_ID, REDIRECT, SCOPE, XERR,
  createDeviceKey, deviceToken, pkce, sisuAuthenticate, oauthToken, oauthRefresh, sisuAuthorize, xstsAuthorize, minecraftLogin,
  msToken, signature, authError,
};
