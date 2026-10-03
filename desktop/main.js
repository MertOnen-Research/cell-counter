// Cell Counter - desktop app. A window around the same web app, with everything it needs on disk:
// the page is served from app://cell-counter/, the libraries it would fetch from the internet are answered
// from the bundle, and every other network request is refused. Photos never leave the computer.
'use strict';
const { app, BrowserWindow, Menu, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const HOST = 'cell-counter';
const ORIGIN = `app://${HOST}`;
const BUNDLE = path.join(__dirname, 'bundle');
const APP_DIR = path.join(BUNDLE, 'app');
const VENDOR_DIR = path.join(BUNDLE, 'vendor');
const PROJECT_URL = 'https://github.com/MertOnen-Research/cell-counter';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// Reads one file from inside `root` (and nowhere else) as a response.
async function serve(root, relative) {
  const file = path.normalize(path.join(root, relative));
  if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    const data = await fs.promises.readFile(file);
    return new Response(data, {
      headers: {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache',
      },
    });
  } catch (_) {
    return new Response('Not found', { status: 404 });
  }
}

// The page asks the internet for these; the app answers from its own bundle instead.
function bundledCopyOf(url) {
  if (url.hostname === 'cdn.jsdelivr.net' && /^\/npm\/onnxruntime-web@[^/]+\/dist\/[\w.-]+$/.test(url.pathname)) {
    return path.join('ort', path.basename(url.pathname));
  }
  if (url.hostname === 'cdnjs.cloudflare.com' && /^\/ajax\/libs\/jszip\/[^/]+\/jszip\.min\.js$/.test(url.pathname)) return 'jszip.min.js';
  if (url.hostname === 'fonts.googleapis.com' && url.pathname === '/css2') return path.join('fonts', 'fonts.css');
  return null;
}

function registerProtocols() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.hostname !== HOST) return new Response('Not found', { status: 404 });
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/_vendor/')) return serve(VENDOR_DIR, pathname.slice('/_vendor/'.length));
    return serve(APP_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
  });
  const offline = (request) => {
    const copy = bundledCopyOf(new URL(request.url));
    if (copy) return serve(VENDOR_DIR, copy);
    return new Response('Cell Counter does not use the network.', { status: 403 });
  };
  protocol.handle('https', offline);
  protocol.handle('http', offline);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 400,
    minHeight: 560,
    show: false,
    title: 'Cell Counter',
    backgroundColor: '#0D0F13',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  // (the automated test shows the window without taking the keyboard away from whoever is using the computer)
  win.once('ready-to-show', () => (process.env.CELL_COUNTER_TEST_DOWNLOADS ? win.showInactive() : win.show()));
  // Links leave the app only for the project's own pages, and then in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === PROJECT_URL || url.startsWith(PROJECT_URL + '/') || url.startsWith(PROJECT_URL + '#')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN + '/')) event.preventDefault();
  });
  win.loadURL(ORIGIN + '/');
  return win;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [isMac ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Cell Counter on GitHub', click: () => shell.openExternal(PROJECT_URL) }] },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    registerProtocols();
    // The page only needs to read photos the person picks or drops; nothing else is granted.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'fileSystem'));
    // Used by the automated test only: save downloads into a folder instead of asking where.
    const testDownloads = process.env.CELL_COUNTER_TEST_DOWNLOADS;
    if (testDownloads) {
      session.defaultSession.on('will-download', (_event, item) => item.setSavePath(path.join(testDownloads, item.getFilename())));
    }
    app.setAboutPanelOptions({
      applicationName: 'Cell Counter',
      applicationVersion: app.getVersion(),
      credits: 'Free research tool, not for diagnosis.\nCredits and licences are in the Guide.',
      website: PROJECT_URL,
    });
    buildMenu();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
}
