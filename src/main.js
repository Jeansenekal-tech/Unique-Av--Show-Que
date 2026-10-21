// Unique AV Show Cue - main process
const { app, BrowserWindow, ipcMain, dialog, Menu, screen, protocol, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const http = require('http');
const { Readable } = require('stream');
const osc = require('./osc');
const { createUpdater } = require('./updater');

const APP_NAME = 'Unique AV Show Cue';

// ---------------------------------------------------------------------------
// media:// protocol — streams local files with Range support so audio/video
// can seek and be routed through Web Audio (needs CORS headers).
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } }
]);

const MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wave': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/flac', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml'
};

function handleMedia(request) {
  try {
    const u = new URL(request.url);
    const filePath = decodeURIComponent(u.pathname.slice(1));
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const base = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    };
    const range = request.headers.get('range');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= size) end = size - 1;
      if (start >= size) {
        return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
      }
      const stream = fs.createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(stream), {
        status: 206,
        headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
      status: 200, headers: { ...base, 'Content-Length': String(size) }
    });
  } catch (e) {
    return new Response('Not found', { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
let mainWin = null;
let outWin = null;
let outReady = false;
let outQueue = [];
let isDirty = false;
let pendingOpenPath = null;
const updater = createUpdater((st) => sendToMain('update-status', st));

function webPrefs() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    backgroundThrottling: false,
    autoplayPolicy: 'no-user-gesture-required'
  };
}

function createMainWindow() {
  // Fit the screen it opens on (laptops are often 1366×768 or scaled 125–150%).
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const small = wa.width < 1400 || wa.height < 880;
  mainWin = new BrowserWindow({
    width: Math.min(1400, wa.width), height: Math.min(880, wa.height),
    minWidth: Math.min(900, wa.width), minHeight: Math.min(560, wa.height),
    center: true, show: !small,
    title: APP_NAME, backgroundColor: '#111317',
    webPreferences: webPrefs()
  });
  if (small) { mainWin.maximize(); mainWin.show(); }
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.on('close', (e) => {
    if (!isDirty) return;
    const choice = dialog.showMessageBoxSync(mainWin, {
      type: 'warning', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2,
      title: APP_NAME, message: 'Save changes to this show before closing?'
    });
    if (choice === 2) { e.preventDefault(); return; }
    if (choice === 0) {
      e.preventDefault();
      mainWin.webContents.send('menu', 'save-and-quit');
    }
  });
  mainWin.on('closed', () => {
    mainWin = null;
    if (outWin) outWin.destroy();
    app.quit();
  });
  mainWin.webContents.on('did-finish-load', () => {
    if (pendingOpenPath) { openShowPath(pendingOpenPath); pendingOpenPath = null; }
  });
}

function displayList() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `Display ${i + 1}${d.id === primary ? ' (main)' : ''} – ${d.size.width}×${d.size.height}`,
    primary: d.id === primary,
    bounds: d.bounds
  }));
}

function createOutputWindow(displayId) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  let target = displays.find(d => d.id === displayId);
  if (!target) target = displays.find(d => d.id !== primary.id) || primary;
  // Full screen on a second display; a movable window if only the main screen is available.
  const fullscreen = target.id !== primary.id;
  const b = target.bounds;

  outReady = false;
  outWin = new BrowserWindow({
    x: fullscreen ? b.x : b.x + 80, y: fullscreen ? b.y : b.y + 80,
    width: fullscreen ? b.width : 960, height: fullscreen ? b.height : 540,
    frame: !fullscreen, fullscreen, backgroundColor: '#000000',
    title: 'Show Output', autoHideMenuBar: true, show: false,
    webPreferences: webPrefs()
  });
  outWin.setMenuBarVisibility(false);
  outWin.loadFile(path.join(__dirname, 'output.html'));
  outWin.once('ready-to-show', () => { outWin.showInactive(); if (mainWin) mainWin.focus(); });
  outWin.webContents.on('did-finish-load', () => {
    outReady = true;
    const q = outQueue; outQueue = [];
    q.forEach(c => outWin.webContents.send('output-cmd', c));
    sendToMain('output-state', { open: true, displayId: target.id, fullscreen });
  });
  outWin.on('closed', () => {
    outWin = null; outReady = false; outQueue = [];
    sendToMain('output-state', { open: false });
  });
}

function sendToMain(ch, data) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, data);
}

function sendToOutput(cmd, displayId) {
  if (!outWin) {
    // Only showing something opens the window. Volume, mixer, master and stop
    // commands have nothing to act on yet; the mixer is re-sent when it opens.
    if (!cmd || (cmd.cmd !== 'play' && cmd.cmd !== 'identify')) return;
    outQueue.push(cmd);
    createOutputWindow(displayId);
    return;
  }
  if (!outReady) { outQueue.push(cmd); return; }
  outWin.webContents.send('output-cmd', cmd);
}

// ---------------------------------------------------------------------------
// OSC
// ---------------------------------------------------------------------------
let oscIn = null;
let oscOut = dgram.createSocket('udp4');
oscOut.on('error', () => {});

function startOsc(port) {
  return new Promise((resolve) => {
    stopOsc();
    if (!port) return resolve({ ok: false, error: 'No port' });
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;
    sock.on('error', (err) => {
      if (!settled) { settled = true; resolve({ ok: false, error: err.message }); }
      try { sock.close(); } catch (e) {}
      if (oscIn === sock) oscIn = null;
    });
    sock.on('message', (buf, rinfo) => {
      try {
        osc.decode(buf).forEach(m => sendToMain('osc-in', { address: m.address, args: m.args, from: rinfo.address }));
      } catch (e) { /* ignore malformed packets */ }
    });
    sock.bind(port, () => {
      oscIn = sock;
      if (!settled) { settled = true; resolve({ ok: true, port }); }
    });
  });
}
function stopOsc() {
  if (oscIn) { try { oscIn.close(); } catch (e) {} oscIn = null; }
}

// ---------------------------------------------------------------------------
// Web control — plain HTTP GETs (e.g. a Stream Deck "Website" button) turned
// into the same commands as OSC: http://localhost:53000/cue/3 = /showcue/cue 3
// ---------------------------------------------------------------------------
let httpServer = null;
const HTTP_ALIASES = { stop: 'stopall', pause: 'pauseall', resume: 'resumeall' };
const HTTP_NEEDS_ARG = ['cue', 'fire', 'setgo', 'standby', 'master'];
const HTTP_NO_ARG = ['go', 'next', 'prev', 'playnext', 'stopall', 'panic', 'pauseall', 'resumeall'];

function httpCommand(url) {
  let path0;
  try { path0 = decodeURIComponent(url.split('?')[0]); } catch (e) { return null; }
  const parts = path0.split('/').filter(Boolean);
  if (parts[0] && /^(showcue|mix16showcue)$/i.test(parts[0])) parts.shift();
  if (!parts.length) return null;
  const cmd = HTTP_ALIASES[parts[0].toLowerCase()] || parts[0].toLowerCase();
  const args = parts.slice(1, 2).map(a => (a !== '' && !isNaN(a) ? Number(a) : a));
  if (HTTP_NEEDS_ARG.includes(cmd) ? !args.length : !HTTP_NO_ARG.includes(cmd)) return null;
  if (cmd === 'master' && typeof args[0] !== 'number') return null;
  return { address: '/showcue/' + cmd, args };
}

function startHttp(port) {
  return new Promise((resolve) => {
    stopHttp();
    if (!port) return resolve({ ok: false, error: 'No port' });
    const srv = http.createServer((req, res) => {
      const m = req.url === '/favicon.ico' ? null : httpCommand(req.url || '/');
      if (m) sendToMain('osc-in', { ...m, from: 'http' });
      res.writeHead(m ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(m ? `OK ${m.address} ${m.args.join(' ')}`.trim() : 'Unknown address. Try /go, /cue/3, /stop, /panic, /pause, /resume, /next, /prev, /standby/3, /master/80');
    });
    let settled = false;
    srv.on('error', (err) => {
      if (!settled) { settled = true; resolve({ ok: false, error: err.message }); }
      if (httpServer === srv) httpServer = null;
    });
    srv.listen(port, '127.0.0.1', () => {
      httpServer = srv;
      if (!settled) { settled = true; resolve({ ok: true, port }); }
    });
  });
}
function stopHttp() {
  if (httpServer) { try { httpServer.close(); } catch (e) {} httpServer = null; }
}

// ---------------------------------------------------------------------------
// Show files
// ---------------------------------------------------------------------------
const SHOW_FILTER = [{ name: 'Show Cue file', extensions: ['showcue'] }, { name: 'All files', extensions: ['*'] }];

function openShowPath(p) {
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    sendToMain('show-opened', { path: p, data });
    app.addRecentDocument(p);
  } catch (e) {
    dialog.showErrorBox(APP_NAME, `Could not open show:\n${p}\n\n${e.message}`);
  }
}

function argvShowPath(argv) {
  return argv.slice(1).find(a => a && a.toLowerCase().endsWith('.showcue') && fs.existsSync(a));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('show-open-dialog', async () => {
  const r = await dialog.showOpenDialog(mainWin, { title: 'Open Show', filters: SHOW_FILTER, properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    app.addRecentDocument(p);
    return { path: p, data };
  } catch (e) {
    dialog.showErrorBox(APP_NAME, `Could not open show:\n${e.message}`);
    return null;
  }
});

ipcMain.handle('show-save', async (_e, { path: p, data, saveAs }) => {
  let target = p;
  if (!target || saveAs) {
    const r = await dialog.showSaveDialog(mainWin, {
      title: 'Save Show', filters: SHOW_FILTER,
      defaultPath: target || `${(data && data.name) || 'Untitled Show'}.showcue`
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
    if (!target.toLowerCase().endsWith('.showcue')) target += '.showcue';
  }
  // Store paths relative to the show file too, so a show folder can be moved.
  const dir = path.dirname(target);
  const out = JSON.parse(JSON.stringify(data));
  (out.cues || []).forEach(c => {
    if (c.file) c.relFile = path.relative(dir, c.file).split(path.sep).join('/');
  });
  fs.writeFileSync(target, JSON.stringify(out, null, 2), 'utf8');
  app.addRecentDocument(target);
  return target;
});

ipcMain.handle('resolve-media', async (_e, { showPath, cues }) => {
  // Returns cue id -> resolved absolute path (or null if missing)
  const dir = showPath ? path.dirname(showPath) : null;
  const res = {};
  for (const c of cues) {
    if (!c.file && !c.relFile) continue;
    if (c.file && fs.existsSync(c.file)) { res[c.id] = c.file; continue; }
    if (dir && c.relFile) {
      const alt = path.resolve(dir, c.relFile);
      if (fs.existsSync(alt)) { res[c.id] = alt; continue; }
    }
    res[c.id] = null;
  }
  return res;
});

ipcMain.handle('pick-media', async (_e, kind) => {
  const filters = {
    audio: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'aif', 'aiff', 'flac', 'ogg', 'opus'] }],
    video: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }],
    image: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] }],
    any: [{ name: 'Media', extensions: ['wav', 'mp3', 'm4a', 'aac', 'aif', 'aiff', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'm4v', 'webm', 'mkv', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] }]
  }[kind] || [];
  const r = await dialog.showOpenDialog(mainWin, {
    title: 'Choose media', filters: [...filters, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile', 'multiSelections']
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('confirm', async (_e, { message, detail, buttons }) => {
  const r = await dialog.showMessageBox(mainWin, {
    type: 'question', buttons: buttons || ['OK', 'Cancel'], defaultId: 0, cancelId: (buttons || ['OK', 'Cancel']).length - 1,
    title: APP_NAME, message, detail
  });
  return r.response;
});

ipcMain.handle('get-displays', () => displayList());
ipcMain.handle('osc-start', (_e, port) => startOsc(port));
ipcMain.handle('osc-stop', () => { stopOsc(); return { ok: true }; });
ipcMain.handle('http-start', (_e, port) => startHttp(port));
ipcMain.handle('http-stop', () => { stopHttp(); return { ok: true }; });
ipcMain.on('osc-send', (_e, { host, port, address, args }) => {
  try {
    const buf = osc.encode(address, args || []);
    oscOut.send(buf, port, host || '127.0.0.1');
  } catch (e) {
    sendToMain('toast', `OSC send failed: ${e.message}`);
  }
});

ipcMain.on('output-cmd', (_e, { cmd, displayId }) => sendToOutput(cmd, displayId));
ipcMain.on('output-open', (_e, displayId) => {
  if (outWin) outWin.destroy();
  createOutputWindow(displayId);
});
ipcMain.on('output-close', () => { if (outWin) outWin.destroy(); });
ipcMain.on('output-event', (_e, evt) => sendToMain('output-event', evt));

ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('update-check', () => { updater.check(); return updater.getState(); });
ipcMain.handle('update-install', () => updater.install());
ipcMain.on('update-config', (_e, cfg) => updater.configure(cfg || {}));

ipcMain.on('set-dirty', (_e, v) => { isDirty = !!v; if (mainWin) mainWin.setDocumentEdited(isDirty); });
ipcMain.on('set-title', (_e, t) => { if (mainWin) mainWin.setTitle(t); });
ipcMain.on('quit-now', () => { isDirty = false; if (mainWin) mainWin.close(); });

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
function buildMenu() {
  const send = (cmd) => () => sendToMain('menu', cmd);
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: send('check-updates') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: send('settings') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Show', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Open Show…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        { type: 'separator' },
        { label: 'Add Media…', accelerator: 'CmdOrCtrl+I', click: send('add-media') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Exit' }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' },
        { label: 'Duplicate Cue', accelerator: 'CmdOrCtrl+D', click: send('duplicate') },
        { label: 'Renumber Cues', click: send('renumber') }
      ]
    },
    {
      label: 'Show',
      submenu: [
        { label: 'GO', accelerator: 'Space', registerAccelerator: false, click: send('go') },
        { label: 'Stop All (fade)', accelerator: 'Esc', registerAccelerator: false, click: send('stop-all') },
        { label: 'Panic – Stop All Now', accelerator: 'Shift+Esc', registerAccelerator: false, click: send('panic') },
        { label: 'Pause / Resume All', accelerator: 'P', registerAccelerator: false, click: send('pause-all') },
        { type: 'separator' },
        { label: 'Lock Show (show mode)', accelerator: 'CmdOrCtrl+L', click: send('toggle-lock') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Open Output Window', accelerator: 'CmdOrCtrl+Shift+O', click: send('output-open') },
        { label: 'Close Output Window', click: send('output-close') },
        { type: 'separator' },
        ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') }, { type: 'separator' }]),
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard & OSC Reference', click: send('help') },
        { label: 'Check for Updates…', click: send('check-updates') },
        { label: `About ${APP_NAME}`, click: () => dialog.showMessageBox(mainWin, { title: APP_NAME, message: APP_NAME, detail: `Version ${app.getVersion()}\nUnique AV` }) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const p = argvShowPath(argv);
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
      if (p) openShowPath(p);
    }
  });

  app.on('open-file', (e, p) => { // macOS
    e.preventDefault();
    if (mainWin) openShowPath(p); else pendingOpenPath = p;
  });

  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');

  app.whenReady().then(() => {
    protocol.handle('media', handleMedia);
    const allowed = ['midi', 'midiSysex', 'media', 'speaker-selection', 'audioCapture'];
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.includes(perm)));
    session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.includes(perm));
    if (session.defaultSession.setDevicePermissionHandler) session.defaultSession.setDevicePermissionHandler(() => true);

    pendingOpenPath = pendingOpenPath || argvShowPath(process.argv);
    buildMenu();
    createMainWindow();

    screen.on('display-added', () => sendToMain('displays-changed', displayList()));
    screen.on('display-removed', () => sendToMain('displays-changed', displayList()));
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { stopOsc(); stopHttp(); try { oscOut.close(); } catch (e) {} });
}
