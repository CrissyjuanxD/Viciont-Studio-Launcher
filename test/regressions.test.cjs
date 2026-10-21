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

test('el pack del servidor hecho con una carpeta da un .zip válido y siempre igual, sin zips ni archivos del sistema', async (t) => {
  const { packId, packFiles, writeZip } = require(path.join(root, 'src/main/util/rpack.js'));
  const { openZip } = require(path.join(root, 'src/main/util/zip.js'));
  const dir = temp(t);
  const files = { 'pack.mcmeta': '{"pack":{}}', 'assets/minecraft/textures/a.png': crypto.randomBytes(2000), 'assets/ñandú/b.json': 'x'.repeat(5000), 'Viejo.zip': 'zip', 'desktop.ini': 'x' };
  const list = Object.entries(files).map(([rel, body]) => {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return { path: `resourcepacks/Pack/${rel}`, sha1: sha1(body), abs };
  });
  list.push({ path: 'resourcepacks/Otro.zip', sha1: 'b'.repeat(40) }, { path: 'mods/a.jar', sha1: 'c'.repeat(40) });
  const picked = packFiles('resourcepacks/Pack', list);
  assert.deepEqual(picked.map((f) => f.rel), ['assets/minecraft/textures/a.png', 'assets/ñandú/b.json', 'pack.mcmeta']);
  const id = packId('resourcepacks/Pack', list);
  assert.equal(packId('resourcepacks/Pack', [...list].reverse()), id);
  assert.notEqual(packId('resourcepacks/Pack', list.map((f) => (f.path.endsWith('b.json') ? { ...f, sha1: 'd'.repeat(40) } : f))), id);
  assert.equal(packId('resourcepacks/Otro.zip', list), 'b'.repeat(40));
  assert.equal(packId('resourcepacks/Nada', list), null);
  assert.equal(packId('mods/a.jar', list), null);
  const out = (n) => path.join(temp(t), `${n}.zip`);
  const a = out('a');
  const b = out('b');
  await writeZip(picked, a);
  await writeZip(picked, b);
  assert.equal(sha1(fs.readFileSync(a)), sha1(fs.readFileSync(b)));
  const z = await openZip(a);
  try {
    assert.deepEqual(z.names(), picked.map((f) => f.rel));
    for (const f of picked) assert.ok((await z.read(f.rel)).equals(Buffer.from(files[f.rel])));
  } finally { z.close(); }
});

test('al publicar, el pack del servidor solo se vuelve a crear si cambió algo de la carpeta', async (t) => {
  const f = adminFixture(t, {}, { 'resourcepacks/Pack/pack.mcmeta': '{}', 'resourcepacks/Pack/a.png': 'png', 'resourcepacks/Listo.zip': 'zip' });
  const list = ['pack.mcmeta', 'a.png'].map((n) => ({ path: `resourcepacks/Pack/${n}`, sha1: sha1(n === 'a.png' ? 'png' : '{}'), size: 3, source: 'upload', abs: path.join(f.game, 'resourcepacks', 'Pack', n) }));
  list.push({ path: 'resourcepacks/Listo.zip', sha1: sha1('zip'), size: 3, source: 'modrinth', url: 'https://cdn.modrinth.com/data/x/Listo.zip' });
  const tmp = temp(t);
  const first = await f.admin.buildPack('resourcepacks/Pack', list, null, tmp);
  assert.equal(first.rp.path, 'resourcepacks/Pack');
  assert.ok(first.upload && fs.existsSync(first.upload.file));
  assert.equal(first.rp.sha1, first.upload.sha);
  const same = await f.admin.buildPack('resourcepacks/Pack', list, { rp: first.rp }, tmp);
  assert.equal(same.upload, null);
  assert.deepEqual(same.rp, first.rp);
  fs.writeFileSync(path.join(f.game, 'resourcepacks', 'Pack', 'a.png'), 'png2');
  const changed = await f.admin.buildPack('resourcepacks/Pack', list.map((x) => (x.path.endsWith('a.png') ? { ...x, sha1: sha1('png2') } : x)), { rp: first.rp }, tmp);
  assert.ok(changed.upload);
  assert.notEqual(changed.rp.id, first.rp.id);
  const zip = await f.admin.buildPack('resourcepacks/Listo.zip', list, null, tmp);
  assert.deepEqual(zip, { rp: { path: 'resourcepacks/Listo.zip', id: sha1('zip'), sha1: sha1('zip'), size: 3, url: 'https://cdn.modrinth.com/data/x/Listo.zip' }, upload: null });
  await assert.rejects(f.admin.buildPack('resourcepacks/Falta', list, null, tmp), /está vacía o ya no existe/);
});

test('si Windows no deja abrir el instalador, el launcher no se cierra y avisa', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = temp(t);
  let quits = 0;
  const app = { isPackaged: true, getVersion: () => '1.5.0', quit: () => { quits++; } };
  const { Updater } = load('src/main/services/updater.js', { electron: { app } });
  const make = (file) => {
    const u = new Updater({ log, settings: { get: () => ({}) } });
    u.au = { installerPath: file, downloadedUpdateHelper: { downloadedFileInfo: { isAdminRightsRequired: false } } };
    u.state.status = 'ready';
    u.state.version = '1.5.1';
    return u;
  };
  const bad = path.join(dir, 'Setup-1.5.1.exe');
  fs.writeFileSync(bad, 'esto no es un programa');
  for (const file of [bad, path.join(dir, 'no-existe.exe')]) {
    const u = make(file);
    u.state.installing = true;
    assert.equal(await u.install(), false);
    assert.equal(u.state.installing, false);
    assert.equal(u.state.skipped, true);
    assert.equal(u.state.blocked.version, '1.5.1');
    assert.equal(u.state.blocked.why, 'blocked');
    assert.equal(u.installOnQuit(), null);
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(quits, 0);
  const ok = make(path.join(process.env.SystemRoot, 'System32', 'where.exe'));
  assert.equal(await ok.install(), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(quits, 1);
  assert.equal(ok.state.blocked, null);
  assert.equal(ok.installOnQuit(), null);
});

async function hotFixture(t, { hidden = false } = {}) {
  const dir = temp(t);
  const http = require('node:http');
  const blobs = new Map();
  const server = http.createServer((req, res) => {
    const sha = req.url.split('?')[0].split('/').pop();
    if (!blobs.has(sha)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Length': blobs.get(sha).length });
    res.end(blobs.get(sha));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dl = require(path.join(root, 'src/main/util/downloader.js'));
  const { Instances } = load('src/main/services/instances.js', {
    '../game/install': {}, '../game/launch': {}, '../game/crash': {}, './csl': {},
    '../util/downloader': { ...dl, downloadAll: dl.downloadAllLocal },
  });
  const id = 'evento';
  let manifest = null;
  const summary = { id, name: 'Evento', version: 1, protect: hidden ? ['resourcepacks'] : [] };
  const backend = { base: () => base, configured: () => true, call: async () => ({ instance: { ...summary, version: manifest.version }, manifest, downloadToken: null }) };
  const accounts = { active: () => ({ uuid: 'a' }), session: async () => 'a', invalidateSession() {} };
  const instances = new Instances({ configRoot: dir, dirs: { instances: path.join(dir, 'instances'), meta: path.join(dir, 'meta') }, backend, accounts, log,
    settings: { get: () => ({ concurrency: 4 }) } });
  const game = instances.gameDir(id);
  const put = (body) => { const sha = sha1(body); blobs.set(sha, Buffer.from(body)); return sha; };
  const file = (p, body, extra = {}) => ({ path: p, sha1: put(body), size: Buffer.byteLength(body), source: 'upload', ...extra });
  async function install(files, version = 1) {
    const kinds = hidden ? ['resourcepacks'] : [];
    const record = {};
    for (const f of files) {
      const loc = hidden && f.path.startsWith('resourcepacks/') ? 'h' : 'g';
      const abs = instances.fileAt(id, f.path, f.sha1, loc);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, blobs.get(f.sha1));
      record[f.path] = { sha1: f.sha1, size: f.size, mtime: fs.statSync(abs).mtimeMs, policy: f.policy || 'always', loc };
    }
    const st = { installedVersion: version, mc: '1.21.1', loader: { type: 'fabric', version: '0.16' }, files: record, summary, protectKinds: kinds, protected: false };
    fs.mkdirSync(path.join(game, '.vsl'), { recursive: true });
    await instances.writeState(id, st);
    return st;
  }
  return { instances, id, game, file, install, setManifest: (m) => { manifest = m; }, read: (rel) => fs.readFileSync(path.join(game, ...rel.split('/')), 'utf8') };
}

test('con el juego abierto, el launcher cambia solo los packs que cambiaron y quita el botón de actualizar si no hubo nada más', async (t) => {
  const f = await hotFixture(t);
  const a1 = f.file('resourcepacks/Pack/a.png', 'a1');
  const old = f.file('resourcepacks/Old.zip', 'viejo');
  const mod = f.file('mods/x.jar', 'jar');
  const options = f.file('options.txt', 'resourcePacks:["vanilla","file/New.zip"]\n', { policy: 'merge' });
  await f.install([a1, old, mod, options]);
  const a2 = f.file('resourcepacks/Pack/a.png', 'a2');
  const b = f.file('resourcepacks/Pack/b.png', 'b');
  const fresh = f.file('resourcepacks/New.zip', 'nuevo');
  const files = [a2, b, fresh, mod, options];
  f.setManifest({ version: 2, mc: '1.21.1', loader: { type: 'fabric', version: '0.16' }, files });
  const p = await f.instances.hotPrepare(f.id, { progress: null });
  assert.deepEqual(p.enable, ['New.zip']);
  assert.equal(f.read('resourcepacks/New.zip'), 'nuevo');
  assert.equal(f.read('resourcepacks/Pack/b.png'), 'b');
  assert.equal(f.read('resourcepacks/Pack/a.png'), 'a1');
  assert.equal(f.read('resourcepacks/Old.zip'), 'viejo');
  assert.equal((await f.instances.readState(f.id)).installedVersion, 1);
  const r = await f.instances.hotApply(p.job);
  assert.deepEqual(r, { onlyPacks: true, version: 2 });
  assert.equal(f.read('resourcepacks/Pack/a.png'), 'a2');
  assert.ok(!fs.existsSync(path.join(f.game, 'resourcepacks', 'Old.zip')));
  assert.ok(!fs.existsSync(path.join(f.game, '.vsl', 'hot')));
  const st = await f.instances.readState(f.id);
  assert.equal(st.installedVersion, 2);
  assert.deepEqual(Object.keys(st.files).sort(), files.map((x) => x.path).sort());
  const server = files.filter((x) => x.path.toLowerCase().startsWith('resourcepacks/')).map((x) => `${x.path}\t${x.sha1}`).sort().join('\n');
  assert.equal(await f.instances.installedAssets(f.id), sha1(server));
  assert.deepEqual(await f.instances.hotPrepare(f.id, { progress: null }), { nothing: true, version: 2 });
});

test('si la versión también cambia mods, los packs se actualizan igual pero el botón de actualizar sigue', async (t) => {
  const f = await hotFixture(t);
  const a1 = f.file('resourcepacks/Pack/a.png', 'a1');
  await f.install([a1, f.file('mods/x.jar', 'jar')]);
  const a2 = f.file('resourcepacks/Pack/a.png', 'a2');
  f.setManifest({ version: 2, mc: '1.21.1', loader: { type: 'fabric', version: '0.16' }, files: [a2, f.file('mods/x.jar', 'jar2')] });
  const p = await f.instances.hotPrepare(f.id, { progress: null });
  assert.deepEqual(p.enable, []);
  assert.deepEqual(await f.instances.hotApply(p.job), { onlyPacks: false, version: 2 });
  assert.equal(f.read('resourcepacks/Pack/a.png'), 'a2');
  assert.equal(f.read('mods/x.jar'), 'jar');
  const st = await f.instances.readState(f.id);
  assert.equal(st.installedVersion, 1);
  assert.equal(st.files['resourcepacks/Pack/a.png'].sha1, a2.sha1);
});

test('con los resourcepacks ocultos, el pack nuevo llega a la carpeta del juego y al cerrar se retira bien', async (t) => {
  const f = await hotFixture(t, { hidden: true });
  const a1 = f.file('resourcepacks/Pack/a.png', 'a1');
  const z1 = f.file('resourcepacks/Z.zip', 'z1');
  const st = await f.install([a1, z1]);
  await f.instances.stage(f.id, st);
  assert.equal(f.read('resourcepacks/Z.zip'), 'z1');
  const a2 = f.file('resourcepacks/Pack/a.png', 'a2');
  const z2 = f.file('resourcepacks/Z.zip', 'z2');
  const n = f.file('resourcepacks/Nuevo/n.png', 'n');
  f.setManifest({ version: 2, mc: '1.21.1', loader: { type: 'fabric', version: '0.16' }, files: [a2, z2, n] });
  const p = await f.instances.hotPrepare(f.id, { progress: null });
  assert.equal(f.read('resourcepacks/Nuevo/n.png'), 'n');
  await f.instances.hotApply(p.job);
  assert.equal(f.read('resourcepacks/Z.zip'), 'z2');
  assert.equal(f.read('resourcepacks/Pack/a.png'), 'a2');
  const hidden = (rel) => fs.readFileSync(f.instances.fileAt(f.id, rel, null, 'h'), 'utf8');
  assert.equal(hidden('resourcepacks/Z.zip'), 'z2');
  assert.equal(hidden('resourcepacks/Nuevo/n.png'), 'n');
  f.instances.running.set(f.id, {});
  await f.instances.unstage(f.id, { force: true });
  assert.ok(!fs.existsSync(path.join(f.game, 'resourcepacks', 'Z.zip')));
  assert.ok(!fs.existsSync(path.join(f.game, 'resourcepacks', 'Nuevo')));
  assert.ok(!fs.existsSync(path.join(f.game, 'resourcepacks', 'Pack')));
  assert.equal(hidden('resourcepacks/Z.zip'), 'z2');
  assert.equal(hidden('resourcepacks/Pack/a.png'), 'a2');
  assert.equal((await f.instances.readState(f.id)).installedVersion, 2);
});

test('el canal del mod solo responde a su partida y pasa por preparar, aplicar y el pase', async (t) => {
  const calls = [];
  let job = 0;
  const instances = {
    readState: async () => ({ installedVersion: 3 }),
    installedAssets: async () => 'c'.repeat(40),
    hotPrepare: async (id, { progress }) => { progress.addTotal(10); progress.addDone(10); return { job: { n: ++job }, enable: ['New.zip'] }; },
    hotApply: async (j) => { calls.push(['apply', j.n]); return { onlyPacks: true, version: 4 }; },
  };
  const backend = { call: async (p, o) => { calls.push([p, o.json.instance]); return { ticket: 'pase', expiresAt: Date.now() + 86400000 }; } };
  const { Bridge } = load('src/main/services/bridge.js', { './instances': { baseId: (id) => id.replace(/~test$/, '') } });
  const bridge = new Bridge({ instances, accounts: { session: async () => 'sesion' }, backend, log, version: '1.5.2' });
  const env = await bridge.open('evento~test');
  t.after(() => bridge.server.close());
  const base = env.VICIONT_BRIDGE;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(env.VICIONT_BRIDGE_TOKEN, /^[a-f0-9]{48}$/);
  const req = (method, p, { token = env.VICIONT_BRIDGE_TOKEN, headers = {}, body } = {}) => fetch(`${base}${p}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  assert.equal((await req('GET', '/hello', { token: 'f'.repeat(48) })).status, 401);
  assert.equal((await req('GET', '/hello', { headers: { Origin: 'https://example.com' } })).status, 403);
  const hello = await req('GET', '/hello');
  assert.deepEqual([hello.instance, hello.assets, hello.version, hello.launcher], ['evento', 'c'.repeat(40), 3, '1.5.2']);
  assert.equal((await req('POST', '/ticket')).ticket, 'pase');
  assert.equal((await req('POST', '/ticket')).ticket, 'pase');
  assert.equal((await req('POST', '/assets/apply')).status, 409);
  await req('POST', '/assets/prepare', { body: { assets: 'd'.repeat(40) } });
  let s;
  for (let i = 0; i < 50; i++) {
    s = await req('GET', '/assets/status');
    if (s.state === 'ready') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual([s.state, s.done, s.total, s.replace, s.enable], ['ready', 10, 10, true, ['New.zip']]);
  const applied = new Promise((r) => bridge.once('applied', r));
  assert.equal((await req('POST', '/assets/apply')).onlyPacks, true);
  assert.deepEqual(await applied, { id: 'evento~test', onlyPacks: true, version: 4 });
  assert.deepEqual(calls, [['/v1/play/ticket', 'evento'], ['apply', 1]]);
  const old = env.VICIONT_BRIDGE_TOKEN;
  bridge.close('evento~test');
  assert.equal((await req('GET', '/hello', { token: old })).status, 401);
});

test('el launcher elige el jar del mod ViciontRP de cada versión de Minecraft', async () => {
  const index = {
    version: '1.1.0',
    files: [
      { file: 'ViciontRP-mod-1.21.1-1.0.0.jar', url: 'https://github.com/x/a.jar', sha1: 'a'.repeat(40), size: 1, min: '1.21', max: '1.21.1' },
      { file: 'ViciontRP-mod-1.21.4-1.0.0.jar', url: 'https://github.com/x/b.jar', sha1: 'b'.repeat(40), size: 1, min: '1.21.2', max: '1.21.4' },
      { file: 'ViciontRP-mod-26.3-1.0.0.jar', url: 'https://github.com/x/c.jar', sha1: 'c'.repeat(40), size: 1, min: '26.3', max: '26.3' },
      { file: '../malo.jar', url: 'https://github.com/x/d.jar', sha1: 'd'.repeat(40), size: 1, min: '1.0', max: '99' },
    ],
  };
  const vrp = load('src/main/services/vrpmod.js', { '../util/net': { getJson: async () => index, cached: (k, ttl, fn) => fn() } });
  assert.ok(vrp.cmpVersion('1.21', '1.21.1') < 0);
  assert.ok(vrp.cmpVersion('1.21.10', '1.21.9') > 0);
  assert.ok(vrp.cmpVersion('26.1', '1.21.11') > 0);
  assert.equal((await vrp.modFile('1.21', 'fabric')).file, 'ViciontRP-mod-1.21.1-1.0.0.jar');
  assert.equal((await vrp.modFile('1.21.3', 'quilt')).file, 'ViciontRP-mod-1.21.4-1.0.0.jar');
  assert.equal(await vrp.modFile('1.21.5', 'fabric'), null);
  assert.equal(await vrp.modFile('1.21.1', 'forge'), null);
  assert.equal(await vrp.modFile('1.20.1', 'fabric'), null);
  const versions = ['1.21 a 1.21.1', '1.21.2 a 1.21.4', '26.3'];
  assert.deepEqual(await vrp.support('1.20.1', 'fabric'), { ok: false, reason: 'version', versions });
  assert.deepEqual(await vrp.support('1.21.5', 'fabric'), { ok: false, reason: 'version', versions });
  assert.deepEqual(await vrp.support('26.4', 'fabric'), { ok: false, reason: 'version', versions });
  assert.deepEqual(await vrp.support('1.21.1', 'neoforge'), { ok: false, reason: 'loader', versions });
  assert.equal((await vrp.support('26.3', 'fabric')).ok, true);
  assert.equal(vrp.usesPlugin({ plugin: true }), true);
  assert.equal(vrp.usesPlugin({ serverPacks: ['resourcepacks/A'] }), true);
  assert.equal(vrp.usesPlugin({ serverPacks: [] }), false);
});
