export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function richText(text) {
  const parts = String(text || '').trim().split(/\n{2,}/).filter(Boolean);
  return parts.map((p) => `<p>${esc(p).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`).join('');
}

export function bytes(n, digits = 1) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toLocaleString('es-ES', { maximumFractionDigits: x < 10 ? digits : 0, minimumFractionDigits: 0 })} ${units[i]}`;
}

export const speed = (bps) => `${bytes(bps)}/s`;

export function duration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m}:${String(r).padStart(2, '0')}`;
  return `${r} s`;
}

export function playTime(sec) {
  const s = Number(sec) || 0;
  if (!s) return 'todavía no';
  if (s < 60) return 'menos de 1 min';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export function timeAgo(ts) {
  if (!ts) return 'nunca';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'hace un momento';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  const d = Math.floor(diff / 86400);
  if (d < 30) return `hace ${d} día${d === 1 ? '' : 's'}`;
  return new Date(ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function initials(name) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
}

export const mediaUrl = (key) => (key && /^[a-z0-9-]+\/[a-f0-9]{16,64}\.[a-z0-9]+$/i.test(key) ? `vsl-media://${key}` : null);
export const isVideo = (type, key) => /^video\//.test(type || '') || /\.(mp4|webm)$/i.test(key || '');

export function coverMini(name) {
  return `<div class="cover-mini"><span>${esc(initials(name))}</span></div>`;
}

export function instIcon(inst) {
  const url = mediaUrl(inst?.media?.icon);
  return url ? `<img src="${url}" alt="" loading="lazy" decoding="async">` : coverMini(inst?.name);
}

export function instThumb(inst) {
  const banner = mediaUrl(inst?.media?.banner);
  if (banner) return `<img src="${banner}" alt="" loading="lazy" decoding="async">`;
  const bg = inst?.media?.background;
  if (bg && !isVideo(inst.media.backgroundType, bg)) return `<img src="${mediaUrl(bg)}" alt="" loading="lazy" decoding="async">`;
  if (inst?.media?.thumb) return `<img src="${mediaUrl(inst.media.thumb)}" alt="" loading="lazy" decoding="async">`;
  const icon = mediaUrl(inst?.media?.icon);
  return icon ? `<img src="${icon}" alt="" loading="lazy" decoding="async" style="filter:blur(18px) saturate(1.4);transform:scale(1.3)">` : coverMini(inst?.name);
}

export const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

export function loaderLabel(loader) {
  if (!loader || loader.type === 'vanilla') return 'Vanilla';
  return `${LOADER_NAMES[loader.type] || loader.type} ${loader.version || ''}`.trim();
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
