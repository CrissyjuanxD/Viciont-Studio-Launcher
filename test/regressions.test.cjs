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

test('una descarga en curso no muestra el aviso de descarga sin terminar', async (t) => {
  const f = instanceFixture(t);
  const id = 'demo';
  fs.mkdirSync(path.dirname(f.instances.journalFile(id)), { recursive: true });
  fs.writeFileSync(f.instances.journalFile(id), '{}');
  const remote = { id, name: 'Demo', version: 1 };
  assert.equal((await f.instances.describe(id, remote)).interrupted, true);
  f.instances.tasks.set(id, { kind: 'install' });
  const d = await f.instances.describe(id, remote);
  assert.equal(d.interrupted, false);
  assert.equal(d.status, 'installing');
});

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function adminFixture(t, modrinth, files) {
  const dir = temp(t);
  const game = path.join(dir, 'game');
  const stateFile = path.join(game, '.vsl', 'state.json');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(game, rel)), { recursive: true });
    fs.writeFileSync(path.join(game, rel), body);
  }
  const f = { game, trashed: [], downloads: [], writes: 0, bodies: {}, failNext: false };
  const fsx = require(path.join(root, 'src/main/util/fsx.js'));
  const real = load('src/main/util/downloader.js', { './fsx': { ...fsx, hashFile: fsx.hashFileLocal } });
  const { Admin } = load('src/main/services/admin.js', {
    electron: { shell: { trashItem: async (p) => { f.trashed.push(path.relative(game, p).split(path.sep).join('/')); fs.rmSync(p); } } },
    '../core/secure': { readSecure: () => null, writeSecure() {} },
    '../core/paths': { configFile: (n) => path.join(dir, n) },
    './modrinthApp': {},
    './modrinth': modrinth,
    '../util/fsx': { ...fsx, hashFile: fsx.hashFileLocal },
    '../util/downloader': {
      pool: real.pool,
      downloadAll: async (items) => {
        if (f.failNext) { f.failNext = false; throw new Error('sin conexión'); }
        for (const it of items) { f.downloads.push(it); fs.writeFileSync(it.dest, f.bodies[it.url]); }
      },
    },
  });
  const instances = {
    gameDir: () => game,
    baseCopy: (id, rel) => path.join(game, '.vsl', 'base', ...rel.split('/')),
    readState: async () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    writeState: async (id, st) => { f.writes++; fs.writeFileSync(stateFile, JSON.stringify(st)); },
    remote: new Map(),
  };
  f.setWorkspace = (ws) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ workspace: { baseVersion: 1, base: {}, include: ['mods', 'config'], policies: {}, known: {}, localKeys: {}, hash: {}, ...ws } }));
  };
  f.admin = new Admin({ getDirs: () => ({ admin: dir }), backend: {}, accounts: { active: () => null }, instances, log });
  f.admin.metaDraft = async () => ({ d: { meta: { mc: '1.20.1', loader: { type: 'fabric' } } } });
  return f;
}

test('las actualizaciones de mods se detectan solo con la misma versión de Minecraft y sin descargar nada', async (t) => {
  const calls = { current: 0, latest: [] };
  const v = (id, project, number, date, type = 'release') => ({ id, projectId: project, number, type, date, dependencies: [] });
  const modrinth = {
    LOADER_TAGS: { fabric: ['fabric'] },
    versionsByHashes: async (hashes) => {
      calls.current++;
      const known = { [sha1('sodium-old')]: v('S1', 'sodium', '0.5.8', '2024-02-01T00:00:00Z'), [sha1('iris-new')]: v('I9', 'iris', '1.8.0', '2025-05-01T00:00:00Z'), [sha1('beta-mod')]: v('B1', 'bm', '2.0-beta', '2025-01-01T00:00:00Z', 'beta') };
      return Object.fromEntries(hashes.filter((h) => known[h]).map((h) => [h, known[h]]));
    },
    latestByHashes: async (hashes, opts) => {
      calls.latest.push(opts);
      const latest = { [sha1('sodium-old')]: v('S2', 'sodium', '0.5.13', '2025-03-03T00:00:00Z'), [sha1('iris-new')]: v('I8', 'iris', '1.7.0', '2025-01-01T00:00:00Z'), [sha1('beta-mod')]: v('B2', 'bm', '2.1-beta', '2025-02-01T00:00:00Z', 'beta') };
      return Object.fromEntries(hashes.filter((h) => latest[h]).map((h) => [h, latest[h]]));
    },
    projects: async (ids) => ids.map((id) => ({ id, title: id.toUpperCase(), icon_url: null })),
  };
  const f = adminFixture(t, modrinth, { 'mods/sodium.jar': 'sodium-old', 'mods/iris.jar': 'iris-new', 'mods/beta.jar': 'beta-mod', 'mods/propio.jar': 'local', 'config/a.json': '{}' });
  f.setWorkspace({});
  await f.admin.wsStatus('demo');
  const r = await f.admin.modUpdates('demo');
  assert.equal(r.files['mods/sodium.jar'].latest.number, '0.5.13');
  assert.equal(r.files['mods/sodium.jar'].title, 'SODIUM');
  assert.equal(r.files['mods/iris.jar'].latest, undefined);
  assert.equal(r.files['mods/beta.jar'].latest.number, '2.1-beta');
  assert.equal(r.files['mods/propio.jar'], undefined);
  assert.deepEqual(calls.latest.map((o) => [o.loaders, o.mc, o.types]).sort(), [[['fabric'], '1.20.1', ['release']], [['fabric'], '1.20.1', ['release', 'beta']]].sort());
  await f.admin.modUpdates('demo');
  assert.equal(calls.current, 1);
  assert.equal(calls.latest.length, 2);
  assert.equal(f.downloads.length, 0);
  assert.deepEqual(f.trashed, []);
});

test('cambiar la versión de un mod solo quita el archivo anterior cuando la nueva ya está descargada', async (t) => {
  const file = (name, body) => ({ url: `https://cdn.test/${name}`, filename: name, sha1: sha1(body), size: body.length });
  const versions = { S2: { id: 'S2', projectId: 'sodium', number: '0.5.13', type: 'release', date: '2025-03-03T00:00:00Z', dependencies: [], file: file('sodium-2.jar', 'sodium-new') } };
  const modrinth = {
    LOADER_TAGS: { fabric: ['fabric'] },
    version: async (id) => versions[id],
    project: async (id) => ({ id, project_type: 'mod', title: 'Sodium', icon_url: null }),
    versionsByHashes: async () => ({}),
  };
  const f = adminFixture(t, modrinth, { 'mods/sodium-1.jar': 'sodium-old' });
  f.bodies['https://cdn.test/sodium-2.jar'] = 'sodium-new';
  f.setWorkspace({
    base: { 'mods/sodium-1.jar': { path: 'mods/sodium-1.jar', sha1: sha1('sodium-old'), size: 10, source: 'modrinth', url: 'https://cdn.test/sodium-1.jar', project: 'sodium', versionName: '0.5.8', policy: 'once' } },
    policies: { 'mods/sodium-1.jar': 'once' },
  });
  f.failNext = true;
  await assert.rejects(f.admin.setModVersion('demo', 'mods/sodium-1.jar', 'S2'), /sin conexión/);
  assert.ok(fs.existsSync(path.join(f.game, 'mods', 'sodium-1.jar')));
  assert.deepEqual(f.trashed, []);
  const r = await f.admin.setModVersion('demo', 'mods/sodium-1.jar', 'S2');
  assert.deepEqual(f.trashed, ['mods/sodium-1.jar']);
  const added = r.workspace.files.find((x) => x.path === 'mods/sodium-2.jar');
  assert.equal(added.state, 'added');
  assert.equal(added.source, 'modrinth');
  assert.equal(added.policy, 'once');
  assert.deepEqual(added.replaces, { path: 'mods/sodium-1.jar', versionName: '0.5.8' });
  assert.deepEqual(r.workspace.removed[0].replacedBy, { path: 'mods/sodium-2.jar', versionName: '0.5.13' });
});

test('revisar una carpeta sin cambios no vuelve a escribir el estado de la instancia', async (t) => {
  const files = {};
  for (let i = 0; i < 40; i++) files[`config/m${i % 7}/f${i}.json`] = `{"v":${i}}`;
  const f = adminFixture(t, {}, { ...files, 'mods/a.jar': 'a', 'saves/mundo/level.dat': 'x' });
  f.setWorkspace({});
  const first = await f.admin.wsStatus('demo');
  const writes = f.writes;
  const again = await f.admin.wsStatus('demo');
  assert.equal(f.writes, writes);
  assert.deepEqual(again.files, first.files);
  assert.deepEqual(again.candidates.map((c) => [c.name, c.count]), [['saves', 1]]);
});
