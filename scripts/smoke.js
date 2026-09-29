'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { app } = require('electron');

const OUT = path.resolve(process.env.VSL_SMOKE_OUT || 'smoke-out');
const TESTS = (process.env.VSL_SMOKE_TESTS || '1.21.1').split(',').map((s) => s.trim()).filter(Boolean);
const LAUNCH = process.env.VSL_SMOKE_LAUNCH !== '0';
const NOGL = process.env.VSL_SMOKE_NOGL === '1';
const GL_MISSING = /pixel format|NSGL|GLFW error 6554[23]|No OpenGL context/i;
const VERSION = require('../package.json').version;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() }));
});

function screenshot(file) {
  if (process.platform === 'darwin') return run('screencapture', ['-x', file]);
  if (process.platform === 'linux') return run('import', ['-window', 'root', file]);
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('${file}')`;
  return run('powershell', ['-NoProfile', '-Command', ps]);
}

function offlineUuid(name) {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return h.toString('hex');
}

async function loaderFor(type, mc) {
  const { getJson } = require('../src/main/util/net');
  if (type === 'fabric' || type === 'quilt') {
    const base = type === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3';
    const list = await getJson(`${base}/versions/loader/${mc}`);
    const pick = list.find((l) => l.loader.stable !== false && !/beta|pre/i.test(l.loader.version)) || list[0];
    return { type, version: pick.loader.version };
  }
  if (type === 'forge') {
    const p = await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    return { type, version: p.promos[`${mc}-recommended`] || p.promos[`${mc}-latest`] };
  }
  if (type === 'neoforge') {
    const list = await getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
    const [, minor, patch] = mc.split('.');
    const prefix = `${minor}.${patch || 0}.`;
    const versions = list.versions.filter((v) => v.startsWith(prefix) && !/beta/.test(v));
    return { type, version: versions[versions.length - 1] };
  }
  throw new Error(`Cargador desconocido: ${type}`);
}

function machineOf(buf) {
  if (buf.length < 64) return 'unknown';
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 6 > buf.length) return 'unknown';
    return { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' }[buf.readUInt16LE(pe + 4)] || 'other';
  }
  const magic = buf.readUInt32BE(0);
  if (magic === 0xcafebabe) return 'universal';
  if (magic === 0xcffaedfe || magic === 0xcefaedfe) {
    const cpu = buf.readUInt32LE(4);
    return { 0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'ia32' }[cpu] || 'other';
  }
  if (magic === 0x7f454c46) return { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32', 0x28: 'arm' }[buf.readUInt16LE(0x12)] || 'other';
  return 'unknown';
}

async function checkNatives(dir, arch) {
  const files = (await fsp.readdir(dir).catch(() => [])).filter((n) => /\.(dll|dylib|jnilib|so(\.\d+)*)$/i.test(n));
  const out = { files: files.length, archs: {}, bad: [] };
  for (const f of files) {
    const fd = await fsp.open(path.join(dir, f), 'r');
    const buf = Buffer.alloc(4096);
    await fd.read(buf, 0, 4096, 0);
    await fd.close();
    const m = machineOf(buf);
    out.archs[m] = (out.archs[m] || 0) + 1;
    if ((m === 'x64' || m === 'arm64') && m !== arch) out.bad.push(`${f}: ${m}`);
  }
  if (!out.archs[arch] && !out.archs.universal) out.bad.push(`ninguno para ${arch}`);
  return out;
}

async function newestFile(dir) {
  const names = await fsp.readdir(dir).catch(() => []);
  let best = null;
  for (const n of names) {
    const st = await fsp.stat(path.join(dir, n)).catch(() => null);
    if (st?.isFile() && (!best || st.mtimeMs > best.t)) best = { n, t: st.mtimeMs };
  }
  return best ? path.join(dir, best.n) : null;
}

async function testOne(spec, dirs, deps) {
  const { planGame, downloadAll, launchGame, probeJava, TaskProgress } = deps;
  const [mc, type] = spec.split(':');
  const slug = spec.replace(/[^a-z0-9.]+/gi, '-');
  const gameDir = path.join(dirs.instances, slug);
  const res = { spec, ok: false };
  const t0 = Date.now();
  try {
    const loader = type ? await loaderFor(type, mc) : null;
    res.loader = loader?.version || null;
    const plan = await planGame({ mc, loader }, { dirs, gameDir });
    const progress = new TaskProgress(slug, { name: slug, kind: 'launch' });
    try {
      await downloadAll(plan.items, { concurrency: 16, progress, verify: 'size' });
      for (const post of plan.posts) await post(progress);
    } finally {
      plan.dispose();
      clearInterval(progress._timer);
    }
    res.arch = plan.arch;
    res.java = { source: plan.java.source, major: plan.java.major, version: (await probeJava(plan.java.javaw))?.version || null };
    res.natives = await checkNatives(plan.nativesDir, plan.arch);
    res.prepared = Math.round((Date.now() - t0) / 1000);
    if (!LAUNCH) {
      res.ok = Boolean(res.java.version) && res.natives.files > 0 && !res.natives.bad.length;
      return res;
    }
    await fsp.mkdir(gameDir, { recursive: true });
    await fsp.writeFile(path.join(gameDir, 'options.txt'), 'onboardAccessibility:false\nskipMultiplayerWarning:true\ntutorialStep:none\nnarrator:0\npauseOnLostFocus:false\nrenderDistance:4\nsoundCategory_master:0.0\n');
    const name = 'VSLSmoke';
    const game = await launchGame(plan, {
      dirs, gameDir,
      account: { name, uuid: offlineUuid(name), accessToken: '', type: 'offline' },
      memory: { min: 512, max: 2048 }, jvmArgs: '', extraJvm: [],
      resolution: { width: 854, height: 480 }, launcherVersion: VERSION,
    });
    let exited = null;
    game.once('exit', (e) => { exited = e; });
    const started = () => game.lines.some((l) => /Backend library: LWJGL|LWJGL Version|Trying GL version/i.test(l));
    const loaded = () => game.lines.some((l) => /Sound engine started|Created: \d+x\d+|OpenAL initialized|Reloading ResourceManager/i.test(l));
    const ready = NOGL ? started : loaded;
    const until = Date.now() + 5 * 60 * 1000;
    while (!exited && !ready() && Date.now() < until) await wait(1000);
    if (!exited && ready()) await wait(NOGL ? 15000 : 30000);
    await screenshot(path.join(OUT, `${slug}.png`));
    if (NOGL) {
      const crash = await newestFile(path.join(gameDir, 'crash-reports'));
      const text = `${game.lines.join('\n')}\n${crash ? await fsp.readFile(crash, 'utf8').catch(() => '') : ''}`;
      res.ok = started() && (!exited || GL_MISSING.test(text)) && !res.natives.bad.length;
      res.outcome = res.ok ? 'llega a abrir la ventana (la máquina de pruebas no tiene OpenGL)' : exited ? `cerrado (código ${exited.code})` : 'no arrancó a los 5 min';
    } else {
      res.outcome = exited ? `cerrado (código ${exited.code})` : loaded() ? 'en marcha' : 'sin cargar a los 5 min';
      res.ok = !exited && loaded() && !res.natives.bad.length;
    }
    if (!exited) {
      game.kill();
      const stop = Date.now() + 15000;
      while (!exited && Date.now() < stop) await wait(500);
    }
  } catch (e) {
    res.error = e.message;
  } finally {
    res.seconds = Math.round((Date.now() - t0) / 1000);
    await fsp.copyFile(path.join(gameDir, 'logs', 'vsl-latest.log'), path.join(OUT, `${slug}.log`)).catch(() => {});
    const crash = await newestFile(path.join(gameDir, 'crash-reports'));
    if (crash) await fsp.copyFile(crash, path.join(OUT, `${slug}-crash.txt`)).catch(() => {});
  }
  return res;
}

app.whenReady().then(async () => {
  await fsp.mkdir(OUT, { recursive: true });
  const paths = require('../src/main/core/paths');
  const deps = {
    planGame: require('../src/main/game/install').planGame,
    downloadAll: require('../src/main/util/downloader').downloadAll,
    launchGame: require('../src/main/game/launch').launchGame,
    probeJava: require('../src/main/game/java').probeJava,
    TaskProgress: require('../src/main/util/progress').TaskProgress,
  };
  const dirs = paths.dataDirs(paths.DEFAULT_DATA_ROOT);
  paths.ensureDataRoot(dirs.root);
  console.log(`Prueba ${VERSION} · ${process.platform}/${process.arch} · datos en ${dirs.root}`);
  const results = [];
  for (const spec of TESTS) {
    console.log(`\n▶ ${spec}`);
    const r = await testOne(spec, dirs, deps);
    results.push(r);
    console.log(JSON.stringify(r, null, 2));
  }
  await fsp.writeFile(path.join(OUT, 'results.json'), JSON.stringify({ platform: process.platform, arch: process.arch, results }, null, 2));
  const summary = results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.spec}${r.loader ? ` (${r.loader})` : ''} | ${r.arch || '-'} | Java ${r.java?.version || '-'} (${r.java?.source || '-'}) | nativos ${r.natives ? `${r.natives.files}${r.natives.bad.length ? `, mal: ${r.natives.bad.join(' ')}` : ''}` : '-'} | ${r.outcome || r.error || (LAUNCH ? '' : 'solo preparar')} | ${r.seconds}s |`).join('\n');
  const table = `### ${process.platform}/${process.arch}\n\n| | Versión | Arq. | Java | Nativos | Resultado | Tiempo |\n|---|---|---|---|---|---|---|\n${summary}\n`;
  console.log(`\n${table}`);
  if (process.env.GITHUB_STEP_SUMMARY) await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, table);
  app.exit(results.every((r) => r.ok) ? 0 : 1);
});
