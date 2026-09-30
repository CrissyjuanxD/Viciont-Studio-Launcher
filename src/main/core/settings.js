'use strict';

const os = require('node:os');
const { EventEmitter } = require('node:events');
const { readJsonSync, writeJsonAtomicSync } = require('../util/fsx');
const { configFile } = require('./paths');

const FILE = configFile('settings.json');
const totalMB = Math.floor(os.totalmem() / 1024 / 1024);

function recommendedMax() {
  const v = Math.floor((totalMB * 0.45) / 512) * 512;
  return Math.min(8192, Math.max(2048, v));
}

const DEFAULT_JVM = '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20';

const DEFAULTS = {
  dataDir: null,
  memory: { min: 1024, max: recommendedMax() },
  jvmArgs: DEFAULT_JVM,
  resolution: { width: 1280, height: 720, fullscreen: false },
  javaPaths: {},
  onLaunch: 'hide',
  reopenOnExit: true,
  concurrency: 10,
  effects: 'full',
  hardwareAcceleration: true,
  apiBase: '',
  autoUpdate: true,
  discordRpc: true,
  discordHidePrivate: false,
  lastInstance: null,
  lastVersion: null,
  updateTried: null,
};

const clampInt = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

function sanitize(s) {
  const d = DEFAULTS;
  const out = { ...d, ...s };
  const maxMem = Math.max(1024, totalMB - 512);
  out.memory = {
    min: clampInt(s?.memory?.min, 256, maxMem, d.memory.min),
    max: clampInt(s?.memory?.max, 512, maxMem, d.memory.max),
  };
  if (out.memory.min > out.memory.max) out.memory.min = out.memory.max;
  out.jvmArgs = typeof s?.jvmArgs === 'string' ? s.jvmArgs.slice(0, 4000) : d.jvmArgs;
  out.resolution = {
    width: clampInt(s?.resolution?.width, 320, 15360, d.resolution.width),
    height: clampInt(s?.resolution?.height, 240, 8640, d.resolution.height),
    fullscreen: Boolean(s?.resolution?.fullscreen),
  };
  out.javaPaths = typeof s?.javaPaths === 'object' && s.javaPaths ? Object.fromEntries(
    Object.entries(s.javaPaths).filter(([k, v]) => /^\d{1,2}$/.test(k) && typeof v === 'string' && v.length < 600 && /[\\/](javaw?\.exe|java)$/i.test(v)),
  ) : {};
  out.onLaunch = ['keep', 'minimize', 'hide'].includes(s?.onLaunch) ? s.onLaunch : d.onLaunch;
  out.reopenOnExit = s?.reopenOnExit !== false;
  out.concurrency = clampInt(s?.concurrency, 1, 24, d.concurrency);
  out.effects = ['full', 'reduced', 'minimal'].includes(s?.effects) ? s.effects : d.effects;
  out.hardwareAcceleration = s?.hardwareAcceleration !== false;
  out.apiBase = typeof s?.apiBase === 'string' && /^https?:\/\/[^\s]+$/i.test(s.apiBase.trim()) ? s.apiBase.trim().replace(/\/+$/, '') : '';
  out.autoUpdate = s?.autoUpdate !== false;
  out.discordRpc = s?.discordRpc !== false;
  out.discordHidePrivate = s?.discordHidePrivate === true;
  delete out.discordShowPrivate;
  out.dataDir = typeof s?.dataDir === 'string' && s.dataDir.length > 2 ? s.dataDir : null;
  out.lastInstance = typeof s?.lastInstance === 'string' ? s.lastInstance : null;
  out.lastVersion = typeof s?.lastVersion === 'string' && /^\d+\.\d+\.\d+$/.test(s.lastVersion) ? s.lastVersion : null;
  const tried = s?.updateTried;
  out.updateTried = tried && typeof tried.version === 'string' && /^\d+\.\d+\.\d+$/.test(tried.version) && Number.isFinite(tried.at) ? { version: tried.version, at: tried.at } : null;
  return out;
}

class Settings extends EventEmitter {
  constructor() {
    super();
    this.data = sanitize(readJsonSync(FILE, {}) || {});
  }

  get() { return JSON.parse(JSON.stringify(this.data)); }

  set(patch) {
    const merged = { ...this.data, ...patch };
    if (patch.memory) merged.memory = { ...this.data.memory, ...patch.memory };
    if (patch.resolution) merged.resolution = { ...this.data.resolution, ...patch.resolution };
    this.data = sanitize(merged);
    writeJsonAtomicSync(FILE, this.data);
    this.emit('change', this.get());
    return this.get();
  }

  reset(keys) {
    const patch = {};
    for (const k of keys) patch[k] = DEFAULTS[k];
    return this.set(patch);
  }
}

module.exports = { Settings, DEFAULTS, DEFAULT_JVM, totalMB, recommendedMax };
