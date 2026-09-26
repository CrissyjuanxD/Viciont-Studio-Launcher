// Dibuja la cabeza (foto de perfil) y el cuerpo de frente a partir de la skin.

const cache = new Map();

export function loadImage(src) {
  if (!src) return Promise.reject(new Error('sin imagen'));
  if (cache.has(src)) return cache.get(src);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('imagen no válida'));
    img.src = src;
  });
  cache.set(src, p);
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  return p;
}

function prep(canvas, w, h) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

// Cabeza con la capa del sombrero (como en NameMC).
export function drawHead(canvas, img, size = 64) {
  const ctx = prep(canvas, size, size);
  const s = img.width / 64;
  const pad = Math.round(size * 0.06);
  ctx.drawImage(img, 8 * s, 8 * s, 8 * s, 8 * s, pad, pad, size - pad * 2, size - pad * 2);
  ctx.drawImage(img, 40 * s, 8 * s, 8 * s, 8 * s, 0, 0, size, size);
}

// Cabeza por defecto cuando aún no hay skin (silueta con los colores del estudio).
export function drawDefaultHead(canvas, size = 64) {
  const ctx = prep(canvas, size, size);
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#6d28d9');
  g.addColorStop(1, '#db2777');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const u = size / 8;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(u, u * 3.2, u * 2, u);
  ctx.fillRect(u * 5, u * 3.2, u * 2, u);
  ctx.fillStyle = 'rgba(20,6,40,0.9)';
  ctx.fillRect(u * 2, u * 3.2, u, u);
  ctx.fillRect(u * 5, u * 3.2, u, u);
  ctx.fillRect(u * 3, u * 5.4, u * 2, u * 0.8);
}

export function isSlim(img) {
  if (img.height !== img.width) return false;
  try {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const s = img.width / 64;
    const a = (x, y) => ctx.getImageData(Math.floor(x * s), Math.floor(y * s), 1, 1).data[3];
    return [a(54, 20), a(55, 20), a(50, 16), a(54, 31)].filter((v) => v === 0).length >= 3;
  } catch {
    return false;
  }
}

// Cuerpo visto de frente (16 × 32 "píxeles" de skin), con capas exteriores.
export function drawBody(canvas, img, slim = false, scale = 4) {
  const W = 16 * scale;
  const H = 32 * scale;
  const ctx = prep(canvas, W, H);
  const s = img.width / 64;
  const modern = img.height === img.width;
  const aw = slim ? 3 : 4;
  const part = (sx, sy, sw, sh, dx, dy, mirror = false, over = false) => {
    const o = over ? 0.25 : 0;
    const dw = sw * scale + o * 2 * scale;
    const dh = sh * scale + o * 2 * scale;
    const x = dx * scale - o * scale;
    const y = dy * scale - o * scale;
    if (!mirror) {
      ctx.drawImage(img, sx * s, sy * s, sw * s, sh * s, x, y, dw, dh);
    } else {
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(img, sx * s, sy * s, sw * s, sh * s, -x - dw, y, dw, dh);
      ctx.restore();
    }
  };
  // piernas
  part(4, 20, 4, 12, 4, 20);
  if (modern) part(20, 52, 4, 12, 8, 20); else part(4, 20, 4, 12, 8, 20, true);
  // cuerpo
  part(20, 20, 8, 12, 4, 8);
  // brazos
  part(44, 20, aw, 12, 4 - aw, 8);
  if (modern) part(36, 52, aw, 12, 12, 8); else part(44, 20, aw, 12, 12, 8, true);
  // cabeza
  part(8, 8, 8, 8, 4, 0);
  // capas exteriores
  if (modern) {
    part(4, 36, 4, 12, 4, 20, false, true);
    part(4, 52, 4, 12, 8, 20, false, true);
    part(20, 36, 8, 12, 4, 8, false, true);
    part(44, 36, aw, 12, 4 - aw, 8, false, true);
    part(52, 52, aw, 12, 12, 8, false, true);
  }
  part(40, 8, 8, 8, 4, 0, false, true);
}

// Parte trasera de una capa (vista previa en la lista de capas).
export function drawCape(canvas, img, scale = 3) {
  const ctx = prep(canvas, 10 * scale, 16 * scale);
  const s = img.width / 64;
  ctx.drawImage(img, 1 * s, 1 * s, 10 * s, 16 * s, 0, 0, 10 * scale, 16 * scale);
}

export async function paintHead(canvas, src) {
  if (!src) { drawDefaultHead(canvas); return; }
  try { drawHead(canvas, await loadImage(src)); } catch { drawDefaultHead(canvas); }
}
