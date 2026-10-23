// Bridge between the windows and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const path = require('path');

const INVOKE = ['show-open-dialog', 'show-save', 'resolve-media', 'pick-media', 'confirm', 'get-displays', 'osc-start', 'osc-stop', 'http-start', 'http-stop', 'get-version', 'update-check', 'update-install', 'show-rename'];
const SEND = ['osc-send', 'output-cmd', 'output-open', 'output-close', 'output-event', 'set-dirty', 'set-title', 'quit-now', 'update-config'];
const ON = ['menu', 'show-opened', 'osc-in', 'output-event', 'output-state', 'output-cmd', 'displays-changed', 'toast', 'update-status'];

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...a) => INVOKE.includes(ch) ? ipcRenderer.invoke(ch, ...a) : Promise.reject(new Error('blocked ' + ch)),
  send: (ch, ...a) => { if (SEND.includes(ch)) ipcRenderer.send(ch, ...a); },
  on: (ch, cb) => { if (ON.includes(ch)) ipcRenderer.on(ch, (_e, d) => cb(d)); },
  mediaURL: (p) => 'media://file/' + encodeURIComponent(p),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch (e) { return f.path || ''; } },
  basename: (p) => path.basename(p || ''),
  extname: (p) => path.extname(p || '').toLowerCase(),
  platform: process.platform
});
