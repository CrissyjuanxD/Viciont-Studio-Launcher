'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');
const PREVIEW = process.env.VSL_ART_PREVIEW || '';
const url = (...p) => pathToFileURL(path.join(ROOT, ...p)).href;

const BASE = `
@font-face { font-family: 'Bebas Neue'; src: url('${url('src', 'renderer', 'fonts', 'bebas-neue-400.woff2')}'); }
@font-face { font-family: 'Chakra Petch'; font-weight: 500; src: url('${url('src', 'renderer', 'fonts', 'chakra-petch-500.woff2')}'); }
@font-face { font-family: 'Share Tech Mono'; src: url('${url('src', 'renderer', 'fonts', 'share-tech-mono-400.woff2')}'); }
* { margin: 0; box-sizing: border-box; }
html, body { overflow: hidden; background: #0b0414; }
.art { position: relative; overflow: hidden; }
.glow { position: absolute; border-radius: 50%; }
.scan { position: absolute; inset: 0; background: repeating-linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 0 1px, transparent 1px 3px); }
`;

const ART = [
  {
    file: 'installerHeader.bmp', w: 150, h: 57,
    html: `
      <div class="art" style="width:150px;height:57px;background:linear-gradient(90deg,#0b0414 0%,#0b0414 12%,#150720 100%)">
        <div class="glow" style="right:-38px;top:-52px;width:150px;height:140px;background:radial-gradient(closest-side,rgba(236,72,153,0.42),transparent)"></div>
        <div class="glow" style="right:34px;bottom:-64px;width:140px;height:110px;background:radial-gradient(closest-side,rgba(168,85,247,0.4),transparent)"></div>
        <div class="scan"></div>
        <img src="${url('src', 'renderer', 'img', 'emblem.webp')}" style="position:absolute;right:16px;top:9px;height:39px;filter:drop-shadow(0 0 8px rgba(168,85,247,0.9))">
      </div>`,
  },
  {
    file: 'installerUpdate.bmp', w: 460, h: 260,
    html: `
      <div class="art" style="width:460px;height:260px;background:radial-gradient(120% 95% at 50% 0%,#1b0a31 0%,#0b0414 58%,#07020d 100%);color:#f7f2ff;text-align:center">
        <div class="glow" style="left:-90px;top:-100px;width:330px;height:270px;background:radial-gradient(closest-side,rgba(168,85,247,0.42),transparent)"></div>
        <div class="glow" style="right:-100px;bottom:-130px;width:360px;height:290px;background:radial-gradient(closest-side,rgba(236,72,153,0.32),transparent)"></div>
        <div class="scan"></div>
        <div style="position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,transparent,#a855f7 20%,#ec4899 60%,#ff2bd6 80%,transparent);box-shadow:0 0 12px rgba(236,72,153,0.9)"></div>
        <img src="${url('src', 'renderer', 'img', 'emblem.webp')}" style="position:absolute;left:50%;top:26px;height:60px;transform:translateX(-50%);filter:drop-shadow(0 0 16px rgba(168,85,247,0.85))">
        <div style="position:absolute;left:0;right:0;top:98px;font:400 46px/1 'Bebas Neue';letter-spacing:0.08em;text-shadow:-2px 0 rgba(255,43,214,0.7),2px 0 rgba(122,92,255,0.7),0 0 26px rgba(168,85,247,0.6)">ACTUALIZANDO</div>
        <div style="position:absolute;left:0;right:0;top:152px;font:400 12px/1 'Share Tech Mono';letter-spacing:0.32em;color:#f0abfc">VICIONT STUDIOS LAUNCHER</div>
        <div style="position:absolute;left:60px;right:60px;top:196px;height:8px;border-radius:4px;background:#1d1030"></div>
        <div style="position:absolute;left:0;right:0;top:224px;font:500 11px/1 'Chakra Petch';letter-spacing:0.04em;color:#9b8cba">Se abrirá solo cuando termine</div>
      </div>`,
  },
];

function toBmp(img) {
  const { width: w, height: h } = img.getSize();
  const src = img.toBitmap();
  const stride = Math.ceil((w * 3) / 4) * 4;
  const data = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const row = (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      data[row + x * 3] = src[s];
      data[row + x * 3 + 1] = src[s + 1];
      data[row + x * 3 + 2] = src[s + 2];
    }
  }
  const head = Buffer.alloc(54);
  head.write('BM', 0, 'ascii');
  head.writeUInt32LE(54 + data.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(w, 18);
  head.writeInt32LE(h, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(data.length, 34);
  head.writeInt32LE(2835, 38);
  head.writeInt32LE(2835, 42);
  return Buffer.concat([head, data]);
}

async function render(art, i) {
  const file = path.join(os.tmpdir(), `vsl-art-${process.pid}-${i}.html`);
  fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE}</style></head><body>${art.html}</body></html>`);
  const win = new BrowserWindow({ width: art.w, height: art.h, useContentSize: true, show: false, frame: false, webPreferences: { offscreen: true } });
  try {
    await win.loadURL(pathToFileURL(file).href);
    await win.webContents.executeJavaScript(`Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`);
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: art.w, height: art.h });
    const sized = img.getSize().width === art.w ? img : img.resize({ width: art.w, height: art.h, quality: 'best' });
    fs.writeFileSync(path.join(OUT, art.file), toBmp(sized));
    if (PREVIEW) fs.writeFileSync(path.join(PREVIEW, art.file.replace(/\.bmp$/, '.png')), sized.toPNG());
    console.log(`${art.file} ${sized.getSize().width}x${sized.getSize().height}`);
  } finally {
    win.destroy();
    fs.rmSync(file, { force: true });
  }
}

app.on('window-all-closed', () => {});
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  if (PREVIEW) fs.mkdirSync(PREVIEW, { recursive: true });
  for (const [i, art] of ART.entries()) await render(art, i);
  app.quit();
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
