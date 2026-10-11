'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { EventEmitter } = require('node:events');

const root = path.resolve(__dirname, '..');
function load(file, mocks = {}, extra = '') {
  const filename = path.join(root, file);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const fn = vm.runInThisContext(wrap(fs.readFileSync(filename, 'utf8') + extra), { filename });
  fn(module.exports, (name) => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name), module, filename, path.dirname(filename));
  return module.exports;
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsl-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const log = { info() {}, warn() {}, error() {} };
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function instanceFixture(t) {
  const dir = temp(t);
  const { Instances } = load('src/main/services/instances.js', {
    '../game/install': {}, '../game/launch': {}, '../game/crash': {}, './csl': {},
  });
  let active = { uuid: 'alice' };
  const accounts = { active: () => active, session: async (a) => a?.uuid, invalidateSession() {} };
  const backend = { base: () => 'https://test.local', configured: () => true, call: async () => ({ instances: [] }) };
  const instances = new Instances({ configRoot: dir, dirs: { instances: path.join(dir, 'instances') }, backend, accounts, log });
  return { instances, accounts, backend, dir, switchAccount: (uuid) => { active = { uuid }; } };
}

test('las actualizaciones de lista se agrupan y no mezclan respuestas entre cuentas', async (t) => {
  const f = instanceFixture(t);
  const a = deferred(); const b = deferred(); let calls = 0;
  f.backend.call = async (_, { token }) => { calls++; return token === 'alice' ? a.promise : b.promise; };
  const first = f.instances.refresh();
  assert.equal(f.instances.refresh(), first);
  await Promise.resolve();
  f.switchAccount('bob');
  const second = f.instances.refresh();
  b.resolve({ instances: [{ id: 'bob-private', name: 'Bob', version: 1 }] });
  await second;
  a.resolve({ instances: [{ id: 'alice-private', name: 'Alice', version: 1 }] });
  await first;
  assert.equal(calls, 2);
  assert.deepEqual([...f.instances.remote.keys()], ['bob-private']);
  const cache = JSON.parse(fs.readFileSync(f.instances.cacheFile));
  assert.equal(cache.key, 'https://test.local|bob');
});

test('la caché de otra cuenta no se reutiliza y una sesión revocada se renueva una vez', async (t) => {
  const f = instanceFixture(t);
  fs.writeFileSync(f.instances.cacheFile, JSON.stringify({ key: 'https://test.local|bob', list: [{ id: 'secret' }] }));
  await f.instances.loadCache();
  assert.equal(f.instances.remote.size, 0);
  let invalidations = 0, calls = 0;
  f.accounts.invalidateSession = () => { invalidations++; };
  f.backend.call = async () => {
    if (++calls === 1) throw Object.assign(new Error('revoked'), { status: 401 });
    return { instances: [{ id: 'allowed', version: 1 }] };
  };
  const result = await f.instances.refresh();
  assert.equal(invalidations, 1);
  assert.equal(calls, 2);
  assert.equal(result.instances[0].available, true);
});

test('los cambios de acceso notifican la instancia abierta, los sondeos iguales no redibujan', async () => {
  const module = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'src/renderer/js/api.js'), 'utf8'), {
    context: vm.createContext({ window: { vsl: { on() {} } }, console }),
  });
  await module.link(() => {}); await module.evaluate();
  const { setInstances, on } = module.namespace;
  const changes = []; let lists = 0;
  on('instance:event', (d) => changes.push(d)); on('instances', () => lists++);
  const row = { id: 'event', status: 'installed', installed: true, available: false };
  setInstances({ instances: [row], configured: true, at: 1 });
  setInstances({ instances: [{ ...row }], configured: true, at: 2 });
  assert.equal(changes.length, 1); assert.equal(lists, 1);
  setInstances({ instances: [{ ...row, available: true }], configured: true });
  assert.equal(changes.at(-1).available, true);
  setInstances({ instances: [{ ...row, available: true }], configured: true, error: 'EOFFLINE' });
  assert.equal(changes.length, 3);
  setInstances({ instances: [], configured: true });
  assert.equal(changes.at(-1), null);
});

function secureFixture(t, backend = 'gnome_libsecret', available = true) {
  const file = path.join(temp(t), 'accounts.dat');
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(value) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const out = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]); },
    decryptString(value) { const c = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(12, 28)); return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString(); },
  };
  return { file, safeStorage, ...load('src/main/core/secure.js', { electron: { safeStorage } }) };
}

test('las credenciales cifradas y sus temporales son privados; se migra el formato antiguo', (t) => {
  const f = secureFixture(t);
  const account = { token: 'sensitive-test-token', recovery: 'local-test-code' };
  fs.writeFileSync(f.file, 'VSL0' + Buffer.from(JSON.stringify(account)).toString('base64'), { mode: 0o644 });
  assert.deepEqual(f.readSecure(f.file, null), account);
  const bytes = fs.readFileSync(f.file);
  assert.equal(bytes.subarray(0, 4).toString(), 'VSL1');
  assert.equal(bytes.includes(Buffer.from(account.token)), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(f.readSecure(f.file, null), account);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['accounts.dat']);
});

test('sin llavero, incluido basic_text de Linux, los secretos solo viven en memoria', (t) => {
  for (const [backend, available] of [['unknown', false], ['basic_text', true]]) {
    const f = secureFixture(t, backend, available);
    const account = { token: 'sensitive-test-token' };
    fs.writeFileSync(f.file, 'VSL0' + Buffer.from(JSON.stringify(account)).toString('base64'));
    assert.deepEqual(f.readSecure(f.file, null), account);
    assert.equal(fs.existsSync(f.file), false);
    f.writeSecure(f.file, { token: 'new-session' });
    assert.equal(fs.existsSync(f.file), false);
    assert.deepEqual(f.readSecure(f.file, null), { token: 'new-session' });
    assert.equal(f.credentialsPersistent(), false);
  }
});

test('un llavero temporalmente inaccesible no borra el archivo cifrado existente', (t) => {
  const f = secureFixture(t, 'unknown', false);
  const saved = Buffer.from('VSL1previously-encrypted-content');
  fs.writeFileSync(f.file, saved);
  f.writeSecure(f.file, { token: 'session-only' });
  assert.deepEqual(fs.readFileSync(f.file), saved);
});

function accountFixture(t) {
  const dir = temp(t);
  const { Accounts } = load('src/main/services/accounts.js', {
    '../core/secure': { readSecure: () => null, writeSecure() {} },
    '../core/paths': { configFile: (f) => path.join(dir, f) },
    '../auth/microsoft': {}, '../core/device': { proof: async () => 'a'.repeat(64) },
    '../auth/offline': { validateNick: () => null, premiumLookup: async () => ({ premium: false }), offlineUuid: () => 'offline-test' },
  });
  const backend = { configured: () => true, base: () => 'https://test.local', version: async () => 14, call: async () => ({}) };
  return { accounts: new Accounts({ backend, log }), backend };
}

test('un registro rechazado o sin verificar no crea una cuenta local nueva', async (t) => {
  const { accounts } = accountFixture(t);
  accounts.offlineSession = async () => { throw Object.assign(new Error('No se pudo verificar'), { status: 503 }); };
  await assert.rejects(accounts.loginOffline('LocalPlayer'), { status: 503 });
  assert.equal(accounts.data.list.length, 0);
  accounts.offlineSession = async () => { throw Object.assign(new Error('Sin conexión'), { code: 'ENETWORK' }); };
  await assert.rejects(accounts.loginOffline('LocalPlayer'), { code: 'ENETWORK' });
  accounts.upsert({ uuid: 'offline-test', name: 'LocalPlayer', type: 'offline' });
  assert.equal((await accounts.loginOffline('LocalPlayer')).active.name, 'LocalPlayer');
});

test('forzar sesión renueva el token y cambiar recuperación conserva la nueva sesión', async (t) => {
  const { accounts, backend } = accountFixture(t);
  const account = { uuid: 'offline-test', name: 'LocalPlayer', type: 'offline', backend: { base: backend.base(), token: 'old-token', exp: Date.now() + 86400000 } };
  accounts.upsert(account); accounts.data.active = account.uuid;
  let refreshed = 0;
  accounts._session = async () => { refreshed++; return 'fresh-token'; };
  assert.equal(await accounts.session(account), 'old-token');
  assert.equal(await accounts.session(account, { force: true }), 'fresh-token');
  assert.equal(refreshed, 1);
  backend.call = async () => ({ secret: 'new-code', token: 'rotated-token', expiresAt: Date.now() + 86400000 });
  assert.equal(await accounts.newRecovery(account.uuid), 'new-code');
  assert.equal(accounts.find(account.uuid).backend.token, 'rotated-token');
  assert.equal(accounts.data.vault.localplayer.code, 'new-code');
});

test('Microsoft exige state y usa PKCE también en el inicio de sesión alternativo', async () => {
  const xbox = require('../src/main/auth/xbox');
  for (const matching of [false, true]) {
    let tokenExchange = null, authorize = null;
    class Window extends EventEmitter {
      constructor() { super(); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; }
      setMenu() {} flashFrame() {} focus() {} isDestroyed() { return Boolean(this.destroyed); }
      destroy() { this.destroyed = true; this.emit('closed'); }
      async loadURL(url) {
        authorize = new URL(url);
        queueMicrotask(() => this.webContents.emit('will-redirect', { preventDefault() {} }, `${xbox.REDIRECT}?code=test-code&state=${matching ? authorize.searchParams.get('state') : 'wrong-state'}`));
      }
    }
    const auth = load('src/main/auth/microsoft.js', {
      electron: { app: { userAgentFallback: 'test' }, BrowserWindow: Window, shell: {}, session: { fromPartition: () => ({ setUserAgent() {}, setPermissionRequestHandler() {} }) } },
      './xbox': { ...xbox, deviceToken: async () => { throw new Error('Simula fallback'); }, oauthToken: async (code, verifier) => { tokenExchange = { code, verifier }; throw Object.assign(new Error('Intercambio alcanzado'), { code: 'ETEST' }); } },
    });
    await assert.rejects(auth.login({ get: () => null, set() {} }), { code: matching ? 'ETEST' : 'ESTATE' });
    assert.ok(authorize.searchParams.get('state'));
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    if (matching) {
      assert.equal(tokenExchange.code, 'test-code');
      assert.equal(crypto.createHash('sha256').update(tokenExchange.verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
    } else assert.equal(tokenExchange, null);
  }
});

test('Sisu devuelve el mismo state aleatorio que envía a Microsoft', async (t) => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (_, opts) => {
    sent = JSON.parse(opts.body);
    return Response.json({ MsaOauthRedirect: 'https://login.live.com/test' }, { headers: { 'x-sessionid': 'test-session' } });
  });
  const xbox = load('src/main/auth/xbox.js');
  const flow = await xbox.sisuAuthenticate('device-token', 'pkce-challenge', xbox.createDeviceKey());
  assert.equal(flow.state, sent.Query.state);
  assert.match(flow.state, /^[a-f0-9]{64}$/);
});
