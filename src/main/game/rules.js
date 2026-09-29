'use strict';

const os = require('node:os');

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const ARCH = process.arch === 'ia32' ? 'x86' : process.arch;
const ARCH_BITS = ARCH === 'x86' ? '32' : '64';

function ruleMatches(rule, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== OS_NAME) return false;
    if (rule.os.arch && rule.os.arch !== ARCH) return false;
    if (rule.os.version) {
      try { if (!new RegExp(rule.os.version).test(os.release())) return false; } catch { return false; }
    }
  }
  if (rule.features) {
    for (const [k, v] of Object.entries(rule.features)) {
      if (Boolean(features?.[k]) !== Boolean(v)) return false;
    }
  }
  return true;
}

function isAllowed(rules, features = {}) {
  if (!Array.isArray(rules) || !rules.length) return true;
  let allowed = false;
  for (const r of rules) {
    if (ruleMatches(r, features)) allowed = r.action === 'allow';
  }
  return allowed;
}

function parseMaven(name) {
  const [coords, extRaw] = String(name).split('@');
  const [group, artifact, version, classifier] = coords.split(':');
  return { group, artifact, version, classifier, ext: extRaw || 'jar' };
}

function mavenPath(name) {
  const m = parseMaven(name);
  if (!m.group || !m.artifact || !m.version) throw new Error(`Nombre de librería no válido: ${name}`);
  const file = `${m.artifact}-${m.version}${m.classifier ? `-${m.classifier}` : ''}.${m.ext}`;
  return [...m.group.split('.'), m.artifact, m.version, file].join('/');
}

function libraryKey(name) {
  const m = parseMaven(name);
  return `${m.group}:${m.artifact}${m.classifier ? `:${m.classifier}` : ''}${m.ext !== 'jar' ? `@${m.ext}` : ''}`;
}

const MAVEN_FIXES = [
  [/^https?:\/\/files\.minecraftforge\.net\/maven\//i, 'https://maven.minecraftforge.net/'],
  [/^http:\/\/files\.minecraftforge\.net\//i, 'https://maven.minecraftforge.net/'],
  [/^http:\/\//i, 'https://'],
];
function fixUrl(url) {
  let u = String(url || '');
  for (const [re, rep] of MAVEN_FIXES) {
    if (re.test(u)) { u = u.replace(re, rep); break; }
  }
  return u;
}

function libraryArtifact(lib) {
  if (lib.downloads) {
    const a = lib.downloads.artifact;
    if (!a) return null;
    return { path: a.path || mavenPath(lib.name), url: a.url ? fixUrl(a.url) : '', sha1: a.sha1, size: a.size };
  }
  const p = mavenPath(lib.name);
  const base = fixUrl(lib.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/');
  const sha1 = lib.sha1 || (Array.isArray(lib.checksums) ? lib.checksums[0] : undefined);
  return { path: p, url: base + p, sha1, size: lib.size };
}

function libraryNatives(lib) {
  const key = lib.natives?.[OS_NAME];
  if (!key) return null;
  const classifier = key.replace('${arch}', ARCH_BITS);
  const c = lib.downloads?.classifiers?.[classifier];
  if (c) return { path: c.path, url: fixUrl(c.url), sha1: c.sha1, size: c.size, exclude: lib.extract?.exclude || [] };
  const m = parseMaven(lib.name);
  const p = mavenPath(`${m.group}:${m.artifact}:${m.version}:${classifier}`);
  const base = fixUrl(lib.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/');
  return { path: p, url: base + p, exclude: lib.extract?.exclude || [] };
}

function isModernNative(lib) {
  const c = parseMaven(lib.name).classifier || '';
  return c.startsWith('natives-');
}

function resolveLibraries(libraries, features) {
  const seen = new Set();
  const out = [];
  for (const lib of libraries || []) {
    if (!lib?.name || !isAllowed(lib.rules, features)) continue;
    const key = libraryKey(lib.name) + (lib.natives ? '#natives' : '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lib);
  }
  return out;
}

module.exports = {
  OS_NAME, ARCH, ARCH_BITS, isAllowed, parseMaven, mavenPath, libraryKey, fixUrl,
  libraryArtifact, libraryNatives, isModernNative, resolveLibraries,
};
