// Builds desktop/bundle/: the web app plus the third-party files it normally fetches from the internet
// (AI runtime, ZIP library, fonts). The packaged app serves all of it from disk and never uses the network.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const out = path.join(here, 'bundle');
const appSrc = path.join(here, '..', 'app');
const mod = (...p) => path.join(here, 'node_modules', ...p);

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

fs.rmSync(out, { recursive: true, force: true });

// 1. the web app itself, minus what only the website needs
const WEB_ONLY = new Set(['sw.js', 'robots.txt', 'sitemap.xml', 'preview.jpg', 'screenshot-wide.jpg', 'screenshot-narrow.jpg']);
for (const name of fs.readdirSync(appSrc)) {
  if (WEB_ONLY.has(name) || name.startsWith('.')) continue;
  copy(path.join(appSrc, name), path.join(out, 'app', name));
}

// 2. ONNX Runtime Web: the script the page loads and the WebAssembly pair it asks for
const ortVersion = require(mod('onnxruntime-web', 'package.json')).version;
const page = fs.readFileSync(path.join(appSrc, 'index.html'), 'utf8');
const wanted = (page.match(/AI_ORT_VERSION = '([^']+)'/) || [])[1];
if (wanted !== ortVersion) throw new Error(`The page asks for onnxruntime-web ${wanted} but ${ortVersion} is installed. Update desktop/package.json.`);
for (const name of ['ort.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  copy(mod('onnxruntime-web', 'dist', name), path.join(out, 'vendor', 'ort', name));
}

// 3. JSZip
copy(mod('jszip', 'dist', 'jszip.min.js'), path.join(out, 'vendor', 'jszip.min.js'));

// 4. Fonts: one stylesheet that stands in for the Google Fonts one, pointing at the bundled files
const FONTS = [
  ['space-grotesk', [400, 500, 600, 700]],
  ['ibm-plex-mono', [400, 500, 600]],
];
let css = '';
for (const [family, weights] of FONTS) {
  for (const weight of weights) {
    for (const subset of ['latin', 'latin-ext']) {
      const sheet = fs.readFileSync(mod('@fontsource', family, `${subset}-${weight}.css`), 'utf8');
      css += sheet.replace(/url\(\.\/files\/([^)]+\.woff2)\)\s*format\('woff2'\)(,\s*url\([^)]+\)\s*format\('woff'\))?/g, (_, file) => {
        copy(mod('@fontsource', family, 'files', file), path.join(out, 'vendor', 'fonts', file));
        return `url(app://cell-counter/_vendor/fonts/${file}) format('woff2')`;
      }) + '\n';
    }
  }
}
if (/url\(\.\//.test(css)) throw new Error('A font address was not rewritten; check the @fontsource stylesheet format.');
fs.writeFileSync(path.join(out, 'vendor', 'fonts', 'fonts.css'), css);

// 5. licence texts of what is bundled
const LICENCES = [
  ['onnxruntime-web', mod('onnxruntime-web', 'LICENSE')],  // may be missing from the package; see THIRD_PARTY_NOTICES.md
  ['jszip', mod('jszip', 'LICENSE.markdown')],
  ['space-grotesk', mod('@fontsource', 'space-grotesk', 'LICENSE')],
  ['ibm-plex-mono', mod('@fontsource', 'ibm-plex-mono', 'LICENSE')],
];
for (const [name, file] of LICENCES) {
  if (fs.existsSync(file)) copy(file, path.join(out, 'licences', `${name}.txt`));
}
copy(path.join(here, '..', 'THIRD_PARTY_NOTICES.md'), path.join(out, 'licences', 'THIRD_PARTY_NOTICES.md'));

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`bundle ready: ${(size(out) / 1e6).toFixed(1)} MB (onnxruntime-web ${ortVersion})`);
