// Copia a src/renderer las fuentes y librerías de node_modules que usa la interfaz
// (así la app funciona sin internet y sin cargar nada de CDNs).
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'src', 'renderer');

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log('✓', path.relative(root, to));
};

const fonts = [
  ['@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2', 'bebas-neue-400.woff2'],
  ['@fontsource/chakra-petch/files/chakra-petch-latin-400-normal.woff2', 'chakra-petch-400.woff2'],
  ['@fontsource/chakra-petch/files/chakra-petch-latin-500-normal.woff2', 'chakra-petch-500.woff2'],
  ['@fontsource/chakra-petch/files/chakra-petch-latin-600-normal.woff2', 'chakra-petch-600.woff2'],
  ['@fontsource/chakra-petch/files/chakra-petch-latin-700-normal.woff2', 'chakra-petch-700.woff2'],
  ['@fontsource/share-tech-mono/files/share-tech-mono-latin-400-normal.woff2', 'share-tech-mono-400.woff2'],
];
for (const [src, name] of fonts) copy(path.join(nm, src), path.join(out, 'fonts', name));
copy(path.join(nm, 'skinview3d', 'bundles', 'skinview3d.bundle.js'), path.join(out, 'vendor', 'skinview3d.bundle.js'));
