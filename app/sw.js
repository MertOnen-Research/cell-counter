/* Cell Counter - service worker.
 * Keeps a copy of the app on the device, so the installed app opens and works without a connection.
 *   - the page itself: network first (an update shows up straight away), saved copy when offline or slow
 *   - other files of the app (AI model, icons): saved copy first. BUMP `SHELL` WHENEVER ONE OF THEM CHANGES.
 *   - third-party files (AI runtime, ZIP library, fonts): saved copy first; their addresses carry a version.
 */
const SHELL = 'cell-counter-shell-v1';
const LIBS = 'cell-counter-libs-v1';
const ROOT = new URL('./', self.registration.scope).href;
const CORE = ['./', 'manifest.webmanifest', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const LIB_HOSTS = new Set(['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com']);
const PAGE_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, LIBS]);
    for (const name of await caches.keys()) {
      if (name.startsWith('cell-counter-') && !keep.has(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// only the app's own page (not e.g. /preview.jpg opened in a tab) gets the network-first treatment
function isPage(url) {
  return url.origin + url.pathname === ROOT || url.pathname.endsWith('/index.html');
}

// which cache a file belongs in; null = leave it to the browser
function cacheFor(url) {
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/.netlify/') || url.pathname.endsWith('/sw.js')) return null;
    return SHELL;
  }
  return LIB_HOSTS.has(url.hostname) ? LIBS : null;
}

async function announce() {
  for (const client of await self.clients.matchAll({ includeUncontrolled: true })) client.postMessage({ type: 'stored' });
}

async function store(cacheName, key, response) {
  await (await caches.open(cacheName)).put(key, response);
  await announce();
}

async function pageResponse(event) {
  const cache = await caches.open(SHELL);
  const saved = await cache.match(ROOT);
  const network = fetch(event.request).then((response) => {
    if (response.ok && response.type === 'basic' && !response.redirected) event.waitUntil(cache.put(ROOT, response.clone()));
    return response;
  });
  if (!saved) return network;
  network.catch(() => {});
  const slow = new Promise((resolve) => setTimeout(() => resolve(null), PAGE_TIMEOUT_MS));
  try {
    return (await Promise.race([network, slow])) || saved;
  } catch (_) {
    return saved;
  }
}

async function fileResponse(event, url, cacheName) {
  const cache = await caches.open(cacheName);
  const saved = await cache.match(url.href, { ignoreSearch: cacheName === SHELL });
  if (saved) return saved;
  const sameOrigin = url.origin === self.location.origin;
  let response;
  try {
    // third-party files are re-requested with CORS so the copy that is stored is a readable one
    response = await fetch(sameOrigin ? event.request : new Request(url.href, { mode: 'cors', credentials: 'omit' }));
  } catch (err) {
    if (sameOrigin) throw err;
    return fetch(event.request);
  }
  if (response.ok) event.waitUntil(store(cacheName, url.href, response.clone()));
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && isPage(url)) {
    event.respondWith(pageResponse(event));
    return;
  }
  const cacheName = cacheFor(url);
  if (cacheName) event.respondWith(fileResponse(event, url, cacheName));
});

// Font files are requested by the stylesheet, and the page cannot list the ones it loaded before this worker took
// control. Their addresses are in the stored Google Fonts stylesheet: store the basic Latin files it names.
async function storeFonts() {
  const cache = await caches.open(LIBS);
  for (const request of await cache.keys()) {
    if (new URL(request.url).hostname !== 'fonts.googleapis.com') continue;
    const css = await (await cache.match(request)).text();
    const wanted = new Set();
    for (const block of css.split('/*')) {
      if (!/^\s*latin\s*\*\//.test(block)) continue;
      const found = block.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
      if (found) wanted.add(found[1]);
    }
    for (const address of wanted) {
      try {
        if (await cache.match(address)) continue;
        const response = await fetch(new Request(address, { mode: 'cors', credentials: 'omit' }));
        if (response.ok) await cache.put(address, response);
      } catch (_) { /* fonts are optional: the app falls back to system fonts */ }
    }
  }
}

// The page lists the files it had already loaded before this worker took control; store the ones that belong to the app.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'precache' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    for (const address of data.urls) {
      try {
        const url = new URL(address);
        if (url.href === ROOT) continue;
        const cacheName = cacheFor(url);
        if (!cacheName) continue;
        const cache = await caches.open(cacheName);
        if (await cache.match(url.href, { ignoreSearch: cacheName === SHELL })) continue;
        const sameOrigin = url.origin === self.location.origin;
        const response = await fetch(sameOrigin ? url.href : new Request(url.href, { mode: 'cors', credentials: 'omit' }));
        if (response.ok) await cache.put(url.href, response);
      } catch (_) { /* one file failing must not stop the rest */ }
    }
    await storeFonts();
    await announce();
  })());
});
