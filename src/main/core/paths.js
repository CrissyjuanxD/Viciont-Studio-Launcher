'use strict';
// Estructura de carpetas (parecida a la de Modrinth App):
//
//   %APPDATA%\ViciontStudioLauncher\          ← configuración (siempre aquí)
//     settings.json, accounts.dat, state.json, launcher_logs\, electron\
//   <carpeta de datos> (por defecto la misma)  ← se puede mover desde Ajustes
//     meta\versions  meta\libraries  meta\assets  meta\natives  meta\java
//     instances\<id>\   (mods, config, saves, resourcepacks… de cada instancia)
//     caches\  skins\  admin\

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { app } = require('electron');

const APP_DIR_NAME = 'ViciontStudioLauncher';
// VSL_HOME solo se usa en desarrollo (pruebas con una carpeta aparte).
const TEST_HOME = !app.isPackaged && process.env.VSL_HOME ? path.resolve(process.env.VSL_HOME) : null;
const CONFIG_ROOT = TEST_HOME || path.join(app.getPath('appData'), APP_DIR_NAME);
const DATA_MARKER = '.vsl-data';

// El perfil de Chromium va dentro de nuestra carpeta para que el desinstalador lo encuentre.
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

// El desinstalador lee esta clave para saber dónde están los datos si se movieron.
function registerDataDir(root) {
  if (process.platform !== 'win32' || TEST_HOME) return;
  execFile('reg', ['add', 'HKCU\\Software\\ViciontStudioLauncher', '/v', 'DataDir', '/t', 'REG_SZ', '/d', root, '/f'],
    { windowsHide: true }, () => {});
}

const configFile = (name) => path.join(CONFIG_ROOT, name);

module.exports = { APP_DIR_NAME, CONFIG_ROOT, DATA_MARKER, dataDirs, ensureDataRoot, registerDataDir, configFile };
