'use strict';
// Cliente de la API pública de Modrinth (búsqueda de mods, versiones y archivos).

const { request, cached } = require('../util/net');

const API = 'https://api.modrinth.com/v2';

async function api(pathname, opts = {}) {
  const { data } = await request(`${API}${pathname}`, { timeout: 20000, ...opts });
  return data;
}

const LOADER_TAGS = { fabric: ['fabric'], quilt: ['quilt', 'fabric'], forge: ['forge'], neoforge: ['neoforge'] };

/**
 * type: mod | resourcepack | shader | datapack | modpack
 */
async function search({ query = '', type = 'mod', mc, loader, offset = 0, limit = 20, sort = 'relevance' }) {
  const facets = [[`project_type:${type}`]];
  if (mc) facets.push([`versions:${mc}`]);
  if (type === 'mod' && loader && LOADER_TAGS[loader]) facets.push(LOADER_TAGS[loader].map((l) => `categories:${l}`));
  const q = new URLSearchParams({
    query, facets: JSON.stringify(facets), offset: String(offset), limit: String(limit), index: sort,
  });
  const r = await api(`/search?${q}`);
  return {
    total: r.total_hits,
    hits: (r.hits || []).map((h) => ({
      id: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author,
      icon: h.icon_url || null, downloads: h.downloads, type: h.project_type,
      clientSide: h.client_side, serverSide: h.server_side, categories: h.display_categories || h.categories || [],
    })),
  };
}

async function project(idOrSlug) {
  return cached(`mr-project:${idOrSlug}`, 10 * 60 * 1000, () => api(`/project/${encodeURIComponent(idOrSlug)}`));
}

async function projects(ids) {
  if (!ids.length) return [];
  return api(`/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`);
}

// Versiones compatibles de un proyecto (la primera es la más reciente).
async function versions(idOrSlug, { mc, loader, type = 'mod' } = {}) {
  const q = new URLSearchParams();
  if (mc) q.set('game_versions', JSON.stringify([mc]));
  if (type === 'mod' && loader && LOADER_TAGS[loader]) q.set('loaders', JSON.stringify(LOADER_TAGS[loader]));
  const list = await api(`/project/${encodeURIComponent(idOrSlug)}/version?${q}`);
  return (list || []).map(simplifyVersion);
}

function simplifyVersion(v) {
  const file = (v.files || []).find((f) => f.primary) || v.files?.[0];
  return {
    id: v.id, projectId: v.project_id, name: v.name, number: v.version_number, type: v.version_type,
    loaders: v.loaders, gameVersions: v.game_versions, date: v.date_published,
    dependencies: (v.dependencies || []).map((d) => ({ projectId: d.project_id, versionId: d.version_id, type: d.dependency_type })),
    file: file ? { url: file.url, filename: file.filename, sha1: file.hashes?.sha1, sha512: file.hashes?.sha512, size: file.size } : null,
  };
}

async function version(id) {
  return simplifyVersion(await api(`/version/${encodeURIComponent(id)}`));
}

// Busca varios archivos por su SHA-1 (para reconocer mods que ya están en Modrinth).
async function versionsByHashes(sha1s) {
  if (!sha1s.length) return {};
  const out = {};
  for (let i = 0; i < sha1s.length; i += 400) {
    const chunk = sha1s.slice(i, i + 400);
    const r = await api('/version_files', { method: 'POST', json: { hashes: chunk, algorithm: 'sha1' } });
    for (const [hash, v] of Object.entries(r || {})) {
      const s = simplifyVersion(v);
      const f = (v.files || []).find((x) => x.hashes?.sha1 === hash);
      if (f) s.file = { url: f.url, filename: f.filename, sha1: f.hashes.sha1, sha512: f.hashes.sha512, size: f.size };
      out[hash] = s;
    }
  }
  return out;
}

async function gameVersions() {
  return cached('mr-game-versions', 60 * 60 * 1000, () => api('/tag/game_version'));
}

module.exports = { search, project, projects, versions, version, versionsByHashes, gameVersions };
