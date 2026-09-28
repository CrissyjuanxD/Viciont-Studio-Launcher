'use strict';
// Instancias de Modrinth App en este PC, para importarlas sin exportar un .mrpack.
// Solo se lee (la base de datos se abre en modo lectura): Modrinth App nunca se toca.
//
// Formatos que entiende:
//   · actual: app.db con las tablas "instances" + "instance_content_sets" (versión y cargador)
//   · 0.8-0.9: app.db con la tabla "profiles"
//   · antiguo (Theseus): un profile.json dentro de cada carpeta de profiles/

const path = require('node:path');
const fsp = require('node:fs/promises');
const { app } = require('electron');
const { exists, readJson, statOrNull } = require('../util/fsx');

const LOADERS = new Set(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']);
const ICON_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const ICON_MAX = 4 * 1024 * 1024;

function normLoader(type, version, mc) {
  const t = String(type || 'vanilla').toLowerCase();
  const lt = LOADERS.has(t) ? t : 'vanilla';
  let v = lt === 'vanilla' ? '' : String(version || '');
  if (mc && v.startsWith(`${mc}-`)) v = v.slice(mc.length + 1); // Forge: "1.20.1-47.3.0" → "47.3.0"
  return { type: lt, version: v };
}

const ms = (t) => { const n = Number(t) || 0; return n && n < 1e12 ? n * 1000 : n; };

function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

// Filas de la base de datos (formato actual o el de la 0.8-0.9) y la carpeta de los perfiles.
function readDb(file, base) {
  const db = openDb(file);
  try {
    const has = (t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    let root = base;
    try {
      const s = db.prepare('SELECT custom_dir FROM settings').get();
      if (s?.custom_dir) root = String(s.custom_dir);
    } catch { /* sin carpeta propia */ }
    let rows = [];
    if (has('instances') && has('instance_content_sets')) {
      rows = db.prepare(`SELECT i.path AS path, i.name AS name, i.icon_path AS icon, i.last_played AS lastPlayed, i.install_stage AS stage,
          cs.game_version AS mc, cs.loader AS loader, cs.loader_version AS loaderVersion
        FROM instances i LEFT JOIN instance_content_sets cs ON cs.id = i.applied_content_set_id`).all();
    } else if (has('profiles')) {
      rows = db.prepare(`SELECT path, name, icon_path AS icon, last_played AS lastPlayed, install_stage AS stage,
          game_version AS mc, mod_loader AS loader, mod_loader_version AS loaderVersion FROM profiles`).all();
    }
    return { profilesDir: path.join(root, 'profiles'), rows };
  } finally {
    db.close();
  }
}

// Theseus antiguo: profiles/<carpeta>/profile.json
async function readLegacy(profilesDir) {
  const rows = [];
  let entries = [];
  try { entries = await fsp.readdir(profilesDir, { withFileTypes: true }); } catch { return rows; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = await readJson(path.join(profilesDir, e.name, 'profile.json'));
    const m = p?.metadata;
    if (!m?.game_version) continue;
    rows.push({ path: e.name, name: m.name, icon: m.icon, lastPlayed: m.last_played ? Date.parse(m.last_played) : 0, stage: p.install_stage, mc: m.game_version, loader: m.loader, loaderVersion: m.loader_version?.id });
  }
  return rows;
}

// Lista las instancias de Modrinth App (las jugadas hace menos, primero).
async function listInstances(log) {
  const appData = app.getPath('appData');
  const out = [];
  const seen = new Set();
  for (const base of [path.join(appData, 'ModrinthApp'), path.join(appData, 'com.modrinth.theseus')]) {
    if (!(await exists(base))) continue;
    let profilesDir = path.join(base, 'profiles');
    let rows = [];
    const dbFile = path.join(base, 'app.db');
    if (await exists(dbFile)) {
      try { ({ profilesDir, rows } = readDb(dbFile, base)); } catch (e) { log?.warn('No se pudo leer Modrinth App:', e.message); }
    }
    if (!rows.length) rows = await readLegacy(profilesDir);
    for (const r of rows) {
      if (!r?.path) continue;
      const dir = path.resolve(profilesDir, String(r.path));
      if (!dir.toLowerCase().startsWith(path.resolve(profilesDir).toLowerCase() + path.sep)) continue; // nada fuera de profiles/
      const key = dir.toLowerCase();
      if (seen.has(key) || !(await statOrNull(dir))?.isDirectory()) continue;
      seen.add(key);
      const mc = String(r.mc || '');
      out.push({
        name: String(r.name || r.path).slice(0, 60),
        dir,
        mc,
        loader: normLoader(r.loader, r.loaderVersion, mc),
        icon: r.icon && ICON_TYPES[path.extname(String(r.icon)).toLowerCase()] && (await exists(String(r.icon))) ? String(r.icon) : null,
        lastPlayed: ms(r.lastPlayed),
        installed: !r.stage || String(r.stage) === 'installed',
      });
    }
  }
  out.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || a.name.localeCompare(b.name));
  return out;
}

// Icono de una instancia (como bytes, para optimizarlo en la interfaz igual que uno elegido a mano).
async function readIcon(file) {
  const type = ICON_TYPES[path.extname(file).toLowerCase()];
  const st = await statOrNull(file);
  if (!type || !st || st.size > ICON_MAX) return null;
  return { bytes: await fsp.readFile(file), type, name: path.basename(file) };
}

module.exports = { listInstances, readIcon };
