// Auto-updates from GitHub Releases.
// Checks on start-up and every few hours, downloads in the background and
// installs only when the user chooses "Restart & update" (or when the app is
// next closed). It never restarts the app on its own, so a show is never cut off.
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// Unsigned Mac apps cannot replace themselves, so on macOS we only tell the
// user a new version exists and open the download page.
const IS_MAC = process.platform === 'darwin';

function releasesPage() {
  try {
    const y = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const owner = (/^owner:\s*(\S+)/m.exec(y) || [])[1];
    const repo = (/^repo:\s*(\S+)/m.exec(y) || [])[1];
    if (owner && repo) return `https://github.com/${owner}/${repo}/releases/latest`;
  } catch (e) {}
  return null;
}

const RECHECK_MS = 4 * 60 * 60 * 1000;

function createUpdater(send) {
  let autoUpdater = null;
  let loadError = null;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { loadError = e; }

  const state = { state: 'idle', version: null, percent: 0, message: '', current: app.getVersion() };
  let autoCheck = true;
  let manual = false;
  let timer = null;
  let checking = false;

  const emit = (patch) => { Object.assign(state, patch); send({ ...state, manual }); };

  if (autoUpdater) {
    autoUpdater.autoDownload = !IS_MAC;
    autoUpdater.autoInstallOnAppQuit = !IS_MAC;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => emit({ state: 'checking', message: '' }));
    autoUpdater.on('update-available', (info) => {
      if (IS_MAC) { emit({ state: 'available', version: info.version, url: releasesPage() }); manual = false; }
      else emit({ state: 'downloading', version: info.version, percent: 0 });
    });
    autoUpdater.on('update-not-available', () => { emit({ state: 'none', message: '' }); manual = false; });
    autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => { emit({ state: 'ready', version: info.version, percent: 100 }); manual = false; });
    autoUpdater.on('error', (err) => {
      // Stay quiet for background checks (e.g. no internet at a venue).
      emit({ state: 'error', message: friendly(err) });
      manual = false;
    });
  }

  function friendly(err) {
    const m = String((err && err.message) || err || '');
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_/i.test(m)) return 'No internet connection';
    if (/404|Not Found/i.test(m)) return 'No published release found on GitHub (is the repository public?)';
    if (/app-update\.yml/i.test(m)) return 'Updates are not set up in this copy (it was built on this computer). Install a copy built by GitHub to get updates.';
    if (/latest\.yml/i.test(m)) return 'The latest GitHub release has no update file';
    return m.split('\n')[0].slice(0, 160);
  }

  async function check(isManual) {
    manual = !!isManual;
    if (!app.isPackaged) { emit({ state: 'unavailable', message: 'Updates only work in the installed app' }); manual = false; return; }
    if (!autoUpdater) { emit({ state: 'unavailable', message: 'Updater not available: ' + (loadError && loadError.message) }); manual = false; return; }
    if (state.state === 'ready' || state.state === 'downloading' || state.state === 'available' || checking) { send({ ...state, manual }); manual = false; return; }
    checking = true;
    try { await autoUpdater.checkForUpdates(); }
    catch (e) { emit({ state: 'error', message: friendly(e) }); manual = false; }
    finally { checking = false; }
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (!autoCheck) return;
    timer = setInterval(() => check(false), RECHECK_MS);
  }

  return {
    configure({ auto }) {
      const first = state.state === 'idle';
      autoCheck = auto !== false;
      schedule();
      if (first && autoCheck) setTimeout(() => check(false), 8000);
      else send({ ...state, manual: false });
    },
    check: () => check(true),
    install() {
      if (state.state === 'available') {
        shell.openExternal(state.url || 'https://github.com');
        return true;
      }
      if (state.state !== 'ready' || !autoUpdater) return false;
      // isSilent=true, forceRunAfter=true: install quietly and reopen the app.
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
      return true;
    },
    getState: () => ({ ...state })
  };
}

module.exports = { createUpdater };
