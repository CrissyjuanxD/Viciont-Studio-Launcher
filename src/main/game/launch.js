'use strict';
// Construye la línea de comandos de Minecraft y lanza el juego.

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { isAllowed } = require('./rules');
const { ensureDir, writeFileAtomic } = require('../util/fsx');

function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function parseServer(address) {
  const s = String(address || '').trim();
  if (!s) return null;
  const m = /^\[?([^\]]+?)\]?(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : 25565, raw: m[2] ? s : `${m[1]}:25565` };
}

/**
 * plan: resultado de planGame
 * opts: { dirs, account, gameDir, memory, jvmArgs, resolution, server, launcherVersion }
 */
function buildCommand(plan, opts) {
  const r = plan.resolved;
  const { account, gameDir, memory = {}, resolution = {}, dirs } = opts;
  const cpList = [];
  const seen = new Set();
  for (const p of [...plan.classpath, plan.jarPath]) {
    const k = p.toLowerCase();
    if (!seen.has(k)) { seen.add(k); cpList.push(p); }
  }
  const classpath = cpList.join(path.delimiter);
  const server = parseServer(opts.server);
  const json = JSON.stringify(r.arguments || {});
  const quickPlay = json.includes('quickPlayMultiplayer');
  const uuid = String(account.uuid || '').replace(/-/g, '');
  const width = Number(resolution.width) || 0;
  const height = Number(resolution.height) || 0;

  const vars = {
    auth_player_name: account.name,
    version_name: plan.launchId,
    game_directory: gameDir,
    assets_root: plan.assets.root,
    game_assets: plan.assets.virtual || plan.assets.root,
    assets_index_name: plan.assets.index,
    auth_uuid: uuid,
    auth_access_token: account.accessToken || '0',
    auth_session: account.accessToken ? `token:${account.accessToken}:${uuid}` : '0',
    clientid: account.clientId || '',
    auth_xuid: account.xuid || '0',
    user_type: account.type === 'microsoft' ? 'msa' : 'legacy',
    version_type: 'Viciont Studios',
    user_properties: '{}',
    resolution_width: String(width || 854),
    resolution_height: String(height || 480),
    natives_directory: plan.nativesDir,
    launcher_name: 'viciont-studio-launcher',
    launcher_version: opts.launcherVersion || '1.0.0',
    classpath,
    classpath_separator: path.delimiter,
    library_directory: dirs.libraries,
    quickPlayMultiplayer: server?.raw || '',
    quickPlayPath: path.join(gameDir, 'logs', 'quickplay.json'),
  };
  const features = {
    is_demo_user: false,
    has_custom_resolution: !resolution.fullscreen && width > 0 && height > 0,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: Boolean(server && quickPlay),
    is_quick_play_realms: false,
  };
  const sub = (s) => String(s).replace(/\$\{([^}]+)\}/g, (_, k) => (k in vars ? String(vars[k]) : ''));
  const expand = (list) => {
    const out = [];
    for (const a of list || []) {
      if (typeof a === 'string') { out.push(sub(a)); continue; }
      if (!a || !isAllowed(a.rules, features)) continue;
      const v = Array.isArray(a.value) ? a.value : [a.value];
      for (const x of v) out.push(sub(x));
    }
    return out;
  };

  const jvm = [];
  const min = Math.max(256, Number(memory.min) || 1024);
  const max = Math.max(min, Number(memory.max) || 2048);
  jvm.push(`-Xms${min}M`, `-Xmx${max}M`);
  jvm.push(...splitArgs(opts.jvmArgs));
  if (r.arguments?.jvm) {
    jvm.push(...expand(r.arguments.jvm));
  } else {
    jvm.push('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump');
    jvm.push(`-Djava.library.path=${plan.nativesDir}`);
    jvm.push('-Dminecraft.launcher.brand=viciont-studio-launcher', `-Dminecraft.launcher.version=${vars.launcher_version}`);
    jvm.push('-cp', classpath);
  }
  if (plan.logging?.argument) jvm.push(plan.logging.argument.replace('${path}', plan.logging.path));

  const game = [];
  if (r.arguments?.game) game.push(...expand(r.arguments.game));
  else if (r.minecraftArguments) game.push(...splitArgs(r.minecraftArguments).map(sub));
  if (resolution.fullscreen) game.push('--fullscreen');
  else if (!r.arguments?.game && width > 0 && height > 0) game.push('--width', String(width), '--height', String(height));
  if (server && !quickPlay) game.push('--server', server.host, '--port', String(server.port));

  return { java: plan.java.javaw, args: [...jvm, r.mainClass, ...game], javaMajor: plan.java.major };
}

// Los argumentos muy largos no caben en la línea de comandos de Windows (32 767 caracteres).
async function argFileIfNeeded(cmd, gameDir) {
  const length = cmd.java.length + cmd.args.reduce((n, a) => n + a.length + 3, 0);
  if (length < 30000 || (cmd.javaMajor || 8) < 9) return cmd.args;
  const quote = (a) => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const file = path.join(gameDir, 'logs', 'vsl-args.txt');
  await writeFileAtomic(file, cmd.args.map(quote).join('\n'));
  return [`@${file}`];
}

class GameProcess extends EventEmitter {
  constructor(child, logFile) {
    super();
    this.child = child;
    this.pid = child.pid;
    this.startedAt = Date.now();
    this.lines = [];
    this.logFile = logFile;
    this.log = fs.createWriteStream(logFile, { flags: 'w' });
    this.log.on('error', () => {});
    const onData = (d) => {
      this.log.write(d);
      const text = d.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        this.lines.push(line);
        if (this.lines.length > 300) this.lines.shift();
        if (!this.windowShown && /Backend library|Setting user:|LWJGL|OpenAL initialized|Sound engine started|Created: \d+x\d+/i.test(line)) {
          this.windowShown = true;
          this.emit('ready');
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => this.emit('error', e));
    child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.log.end();
      this.emit('exit', { code, signal, duration: Date.now() - this.startedAt });
    });
  }

  kill() {
    try {
      if (process.platform === 'win32' && this.pid) spawn('taskkill', ['/pid', String(this.pid), '/T', '/F'], { windowsHide: true });
      else this.child.kill();
    } catch { /* ya terminado */ }
  }
}

async function launchGame(plan, opts) {
  const cmd = buildCommand(plan, opts);
  await ensureDir(opts.gameDir);
  await ensureDir(path.join(opts.gameDir, 'logs'));
  const args = await argFileIfNeeded(cmd, opts.gameDir);
  const logFile = path.join(opts.gameDir, 'logs', 'vsl-latest.log');
  await fsp.rename(logFile, path.join(opts.gameDir, 'logs', 'vsl-previous.log')).catch(() => {});
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(cmd.java, args, {
    cwd: opts.gameDir, env, detached: true, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new GameProcess(child, logFile);
}

module.exports = { buildCommand, launchGame, parseServer, splitArgs };
