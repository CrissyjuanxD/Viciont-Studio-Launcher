'use strict';
// Inicio de sesión con Microsoft (cuentas premium de Minecraft Java).
// Microsoft → Xbox Live → XSTS → Minecraft. La contraseña se escribe solo en la
// página oficial de Microsoft; el launcher únicamente recibe los tokens.

const { BrowserWindow, shell } = require('electron');
const { request, HttpError } = require('../util/net');

const CLIENT_ID = '00000000402b5328';
const REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
const SCOPE = 'XboxLive.signin offline_access';

const XERR = {
  2148916227: 'Esta cuenta está suspendida en Xbox Live.',
  2148916229: 'La configuración de privacidad o familia de la cuenta no permite jugar en línea.',
  2148916233: 'Esta cuenta de Microsoft no tiene perfil de Xbox. Entra una vez en minecraft.net o xbox.com para crearlo y vuelve a intentarlo.',
  2148916234: 'Debes aceptar los términos de Xbox Live. Entra en xbox.com y vuelve a intentarlo.',
  2148916235: 'Xbox Live no está disponible en tu país o región.',
  2148916236: 'Tu cuenta necesita verificación de edad (Corea del Sur).',
  2148916237: 'Tu cuenta necesita verificación de edad (Corea del Sur).',
  2148916238: 'Es una cuenta de menor de edad: un adulto debe añadirla a un grupo familiar de Microsoft.',
};

function authError(message, code) {
  const e = new Error(message);
  e.code = code || 'EAUTH';
  return e;
}

function authorizeUrl() {
  const p = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPE,
    prompt: 'select_account', mkt: 'es-ES',
  });
  return `https://login.live.com/oauth20_authorize.srf?${p}`;
}

// Abre la página oficial de Microsoft en una ventana aparte y espera el código.
function openLoginWindow(parent) {
  return new Promise((resolve, reject) => {
    let done = false;
    const win = new BrowserWindow({
      parent, modal: Boolean(parent), width: 500, height: 680, minWidth: 420, minHeight: 560,
      show: false, autoHideMenuBar: true, title: 'Iniciar sesión con Microsoft', backgroundColor: '#ffffff',
      webPreferences: {
        partition: `vsl-ms-${Date.now()}`, // sesión temporal: no se guardan cookies de Microsoft
        contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      },
    });
    win.setMenu(null);
    const finish = (err, code) => {
      if (done) return;
      done = true;
      if (!win.isDestroyed()) win.close();
      if (err) reject(err); else resolve(code);
    };
    const check = (url) => {
      if (!url || !url.startsWith(REDIRECT)) return false;
      const u = new URL(url);
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');
      if (code) finish(null, code);
      else if (error === 'access_denied') finish(authError('Cancelaste el inicio de sesión.', 'ECANCEL'));
      else finish(authError(u.searchParams.get('error_description') || 'Microsoft no completó el inicio de sesión.'));
      return true;
    };
    win.webContents.on('will-redirect', (e, url) => { if (check(e?.url || url)) e.preventDefault(); });
    win.webContents.on('will-navigate', (e, url) => { if (check(e?.url || url)) e.preventDefault(); });
    win.webContents.on('did-navigate', (_, url) => check(url));
    win.webContents.on('did-redirect-navigation', (e, url) => check(e?.url || url));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('did-fail-load', (_, code, desc, url) => {
      if (url?.startsWith(REDIRECT) || code === -3) return;
      if (!done && code <= -100) finish(authError('No se pudo abrir la página de Microsoft. Revisa tu conexión.', 'ENETWORK'));
    });
    win.on('closed', () => finish(authError('Cerraste la ventana de inicio de sesión.', 'ECANCEL')));
    win.once('ready-to-show', () => win.show());
    win.loadURL(authorizeUrl()).catch(() => {});
  });
}

async function msToken(form) {
  try {
    const { data } = await request('https://login.live.com/oauth20_token.srf', {
      method: 'POST', form: { client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPE, ...form }, timeout: 20000,
    });
    if (!data?.access_token) throw authError('Microsoft no devolvió una sesión válida.');
    return data;
  } catch (e) {
    if (e instanceof HttpError && (e.status === 400 || e.status === 401)) {
      throw authError('La sesión de Microsoft caducó. Vuelve a iniciar sesión.', 'EEXPIRED');
    }
    throw e;
  }
}

async function xboxToMinecraft(msAccessToken) {
  let xbl;
  try {
    xbl = (await request('https://user.auth.xboxlive.com/user/authenticate', {
      method: 'POST',
      headers: { 'x-xbl-contract-version': '1' },
      json: {
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
        RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
      },
    })).data;
  } catch (e) {
    throw authError(`No se pudo entrar en Xbox Live (${e.message}).`);
  }
  const uhs = xbl?.DisplayClaims?.xui?.[0]?.uhs;
  let xsts;
  try {
    xsts = (await request('https://xsts.auth.xboxlive.com/xsts/authorize', {
      method: 'POST',
      headers: { 'x-xbl-contract-version': '1' },
      json: { Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' },
    })).data;
  } catch (e) {
    const x = e.json?.XErr;
    throw authError(XERR[x] || `Xbox Live rechazó la cuenta (${x || e.message}).`);
  }
  let mc;
  try {
    mc = (await request('https://api.minecraftservices.com/authentication/login_with_xbox', {
      method: 'POST', json: { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }, timeout: 25000,
    })).data;
  } catch (e) {
    if (e.status === 429) throw authError('Demasiados intentos. Espera un minuto y vuelve a probar.');
    throw authError(`Minecraft no aceptó la sesión (${e.message}).`);
  }
  return { accessToken: mc.access_token, expiresAt: Date.now() + (Number(mc.expires_in) || 86400) * 1000 };
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

function accountFromProfile(profile, ms, mc) {
  return {
    type: 'microsoft',
    uuid: dashed(profile.id),
    name: profile.name,
    msRefresh: ms.refresh_token,
    mcToken: mc.accessToken,
    mcExpiresAt: mc.expiresAt,
    skins: profile.skins || [],
    capes: profile.capes || [],
    addedAt: Date.now(),
  };
}

async function login(parent) {
  const code = await openLoginWindow(parent);
  const ms = await msToken({ code, grant_type: 'authorization_code' });
  const mc = await xboxToMinecraft(ms.access_token);
  const profile = await getProfile(mc.accessToken);
  return accountFromProfile(profile, ms, mc);
}

// Renueva la sesión sin volver a pedir la contraseña (dura unos 90 días).
async function refresh(account) {
  if (!account.msRefresh) throw authError('Vuelve a iniciar sesión con Microsoft.', 'EEXPIRED');
  const ms = await msToken({ refresh_token: account.msRefresh, grant_type: 'refresh_token' });
  const mc = await xboxToMinecraft(ms.access_token);
  const profile = await getProfile(mc.accessToken);
  return { ...account, ...accountFromProfile(profile, { refresh_token: ms.refresh_token || account.msRefresh }, mc), addedAt: account.addedAt };
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

module.exports = { login, refresh, getProfile, joinServer, dashed };
