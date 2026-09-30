'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { app } = require('electron');

const APP_DIR_NAME = 'ViciontStudioLauncher';
const TEST_HOME = !app.isPackaged && process.env.VSL_HOME ? path.resolve(process.env.VSL_HOME) : null;
const CONFIG_ROOT = TEST_HOME || path.join(app.getPath('appData'), APP_DIR_NAME);
const DEFAULT_DATA_ROOT = TEST_HOME || (process.platform === 'linux'
  ? path.join(process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share'), APP_DIR_NAME)
  : CONFIG_ROOT);
const DATA_MARKER = '.vsl-data';
const DEVICE_DIR = TEST_HOME ? path.join(TEST_HOME, 'device') : process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'Viciont Studios')
  : process.platform === 'darwin'
    ? path.join(app.getPath('home'), 'Library', 'Application Support', 'Viciont Studios')
    : path.join(process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share'), 'viciont-studios');

app.setPath('userData', path.join(CONFIG_ROOT, 'electron'));
app.setPath('sessionData', path.join(CONFIG_ROOT, 'electron'));

function dataDirs(root) {
  const meta = path.join(root, 'meta');
  return {
    root,
    meta,
    versions: path.join(meta, 'versions'),
    libraries: path.join(meta, 'libraries'),
    assets: path.join(meta, 'assets'),
    natives: path.join(meta, 'natives'),
    java: path.join(meta, 'java'),
    instances: path.join(root, 'instances'),
    caches: path.join(root, 'caches'),
    media: path.join(root, 'caches', 'media'),
    skins: path.join(root, 'skins'),
    admin: path.join(root, 'admin'),
  };
}

function ensureDataRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  const marker = path.join(root, DATA_MARKER);
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'Carpeta de datos de Viciont Studio Launcher. No borres este archivo.\r\n');
  }
}

function registerDataDir(root) {
  if (process.platform !== 'win32' || TEST_HOME) return;
  execFile('reg', ['add', 'HKCU\\Software\\ViciontStudioLauncher', '/v', 'DataDir', '/t', 'REG_SZ', '/d', root, '/f'],
    { windowsHide: true }, () => {});
}

const configFile = (name) => path.join(CONFIG_ROOT, name);

module.exports = { APP_DIR_NAME, CONFIG_ROOT, DEFAULT_DATA_ROOT, DATA_MARKER, DEVICE_DIR, dataDirs, ensureDataRoot, registerDataDir, configFile };
