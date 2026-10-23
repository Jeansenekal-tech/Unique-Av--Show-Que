// Unique AV Show Cue – control window
(function () {
  'use strict';
  const api = window.api;
  const AR = window.AudioRouter;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const TYPES = {
    audio: { tag: 'AUD', label: 'Audio' },
    video: { tag: 'VID', label: 'Video' },
    image: { tag: 'IMG', label: 'Image' },
    stop: { tag: 'STOP', label: 'Stop' },
    black: { tag: 'BLACK', label: 'Black screen' },
    osc: { tag: 'OSC', label: 'OSC message' },
    midi: { tag: 'MIDI', label: 'MIDI message' }
  };
  const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
  const COLOR_HEX = { '': '#3a404c', red: '#e0453a', orange: '#f08a24', yellow: '#e8c53a', green: '#2fbf5f', blue: '#3f8cff', purple: '#a35cff' };
  const EXT = {
    audio: ['.wav', '.wave', '.mp3', '.m4a', '.aac', '.aif', '.aiff', '.flac', '.ogg', '.oga', '.opus'],
    video: ['.mp4', '.mov', '.m4v', '.webm', '.mkv'],
    image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']
  };
  const MIDI_ACTIONS = [
    ['go', 'GO'], ['stop-all', 'Stop All'], ['panic', 'Panic'], ['pause-all', 'Pause / Resume'],
    ['prev', 'Standby previous'], ['next', 'Standby next'], ['master', 'Master volume (CC fader)']
  ];

  // ------------------------------------------------------------------ state
  let show = newShow();
  let showPath = null;
  let dirty = false;
  let standby = 0;
  let selectedId = null;
  let selectedFolderId = null;
  let renamingFolderId = null;
  let locked = false;
  let pausedAll = false;
  let lastGo = 0;
  const missing = new Set();
  const active = new Map();
  const followTimers = new Set();
  let instSeq = 0;
  let outputOpen = false;
  let midiAccess = null;
  let midiLearn = null;
  let padLearn = false; // pads view: clicking a pad arms MIDI learn instead of playing it
  const ccLast = {};
  let oscStatus = { ok: false };
  let httpStatus = { ok: false };
  let settings = loadSettings();
  let wave = null;
  let upd = { state: 'idle' };
  let appVersion = '';
  let announcedReady = null;

  function newShow() {
    return { app: 'Unique AV Show Cue', version: 1, name: 'Untitled Show', masterVolume: 100, mixer: {}, folders: [], cues: [] };
  }
  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3); }

  function loadSettings() {
    const def = {
      outputDisplay: null, defaultDevice: '', defaultRoute: '1-2', stopFade: 2, goProtect: 300,
      oscEnabled: true, oscPort: 53000, fbHost: '', fbPort: 53001,
      httpEnabled: true, httpPort: 53000,
      midiInput: 'all', midiMap: [], autoUpdate: true,
      view: 'list', padToggle: true, padSize: 100
    };
    try { return Object.assign(def, JSON.parse(localStorage.getItem('showcue.settings') || '{}')); } catch (e) { return def; }
  }
  function saveSettings() { try { localStorage.setItem('showcue.settings', JSON.stringify(settings)); } catch (e) {} }

  function defaultsFor(type) {
    const base = { id: uid(), number: '', name: '', type, notes: '', color: '', follow: 'off', followDelay: 0 };
    switch (type) {
      case 'audio': return { ...base, file: '', volume: 100, fadeIn: 0, fadeOut: 2, startAt: 0, endAt: 0, loop: false, fadeAtEnd: false, device: settings.defaultDevice || '', route: settings.defaultRoute || '1-2', duration: 0 };
      case 'video': return { ...base, file: '', volume: 100, fadeIn: 0, fadeOut: 1, startAt: 0, endAt: 0, loop: false, fadeAtEnd: false, device: settings.defaultDevice || '', route: settings.defaultRoute || '1-2', fit: 'contain', replace: true, holdLast: false, duration: 0 };
      case 'image': return { ...base, file: '', fadeIn: 1, fadeOut: 1, hold: 0, fit: 'contain', replace: true };
      case 'stop': return { ...base, name: 'Stop all', target: 'all', fade: 2 };
      case 'black': return { ...base, name: 'Black screen', fade: 1 };
      case 'osc': return { ...base, name: 'OSC', host: '127.0.0.1', port: 8000, address: '/', args: '' };
      case 'midi': return { ...base, name: 'MIDI', port: '', msg: 'note', channel: 1, data1: 60, data2: 127 };
    }
    return base;
  }

  const cues = () => show.cues;
  const cueById = (id) => show.cues.find(c => c.id === id);
  const indexOf = (id) => show.cues.findIndex(c => c.id === id);
  const master = () => (show.masterVolume == null ? 100 : show.masterVolume) / 100;
  // Cue volume (%) and gain (dB) as one linear level, before master.
  const cueLevel = (c) => ((c.volume == null ? 100 : c.volume) / 100) * Math.pow(10, (c.gain || 0) / 20);
  const fmtDb = (db) => (db > 0 ? '+' : '') + db.toFixed(1);

  // ------------------------------------------------------------------ folders
  // Folders (sets) group cues inside the one running order. show.cues stays a
  // flat list in GO order; each cue may carry a folderId. Cues not in a folder
  // sit at the top, then each folder's cues in folder order.
  const folderById = (id) => show.folders.find(f => f.id === id);
  const groupOf = (c) => c.folderId || '';
  const groupIds = () => [''].concat(show.folders.map(f => f.id));
  const groupRank = (id) => (id ? show.folders.findIndex(f => f.id === id) + 1 : 0);
  const folderCues = (id) => show.cues.filter(c => groupOf(c) === id);

  // Keeps each folder's cues together, in folder order, without changing the
  // order of cues inside a folder. The standby cue stays the standby cue.
  function normalizeFolders() {
    if (!Array.isArray(show.folders)) show.folders = [];
    show.cues.forEach(c => { if (c.folderId && !folderById(c.folderId)) c.folderId = ''; });
    const standbyId = show.cues[standby] ? show.cues[standby].id : null;
    const rank = {};
    groupIds().forEach((id, r) => { rank[id] = r; });
    show.cues = show.cues.map((c, i) => [c, i])
      .sort((a, b) => (rank[groupOf(a[0])] - rank[groupOf(b[0])]) || (a[1] - b[1]))
      .map(x => x[0]);
    if (standbyId) standby = indexOf(standbyId);
  }

  function folderLength(id) {
    return folderCues(id).reduce((t, c) => t + (cueLength(c) || 0), 0);
  }

  function newFolderName() {
    let n = show.folders.length + 1;
    while (show.folders.some(f => f.name === `Set ${n}`)) n++;
    return `Set ${n}`;
  }

  function addFolder() {
    if (locked) return;
    const f = { id: uid(), name: newFolderName(), collapsed: false };
    // New folder goes after the folder you're working in, otherwise at the end.
    const cur = selectedFolderId || (cueById(selectedId) ? groupOf(cueById(selectedId)) : '');
    const at = cur ? show.folders.findIndex(x => x.id === cur) + 1 : show.folders.length;
    show.folders.splice(at, 0, f);
    markDirty();
    selectFolder(f.id);
    renamingFolderId = f.id;
    renderList();
  }

  function selectFolder(id) {
    selectedFolderId = id;
    selectedId = null;
    $$('.cue-row.selected, .pad.selected').forEach(r => r.classList.remove('selected'));
    $$('.folder-row').forEach(r => r.classList.toggle('selected', r.dataset.folder === id));
    renderInspector();
  }

  function setFolderCollapsed(id, v) {
    const f = folderById(id);
    if (!f || !!f.collapsed === v) return;
    f.collapsed = v;
    markDirty(); renderList();
  }

  function renameFolder(id, name) {
    const f = folderById(id);
    renamingFolderId = null;
    if (f && name.trim() && name.trim() !== f.name) { f.name = name.trim(); markDirty(); }
    renderList();
    if (selectedFolderId === id) renderInspector();
  }

  function moveFolder(id, delta) {
    if (locked) return;
    const i = show.folders.findIndex(f => f.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= show.folders.length) return;
    const [f] = show.folders.splice(i, 1);
    show.folders.splice(j, 0, f);
    normalizeFolders(); markDirty(); renderList();
  }

  function standbyFolder(id) {
    const first = folderCues(id)[0];
    if (!first) { toast('This folder has no cues yet', 'warn'); return; }
    setStandby(indexOf(first.id), true);
  }

  async function deleteFolder(id) {
    if (locked) return;
    const f = folderById(id);
    if (!f) return;
    const inside = folderCues(id);
    let keep = true;
    if (inside.length) {
      const r = await api.invoke('confirm', {
        message: `Delete folder "${f.name}"?`,
        detail: `It has ${inside.length} cue${inside.length === 1 ? '' : 's'}. "Keep cues" leaves them where they are in the list.`,
        buttons: ['Keep cues', 'Delete cues too', 'Cancel']
      });
      if (r === 2 || r == null || r < 0) return;
      keep = r === 0;
    }
    const fi = show.folders.indexOf(f);
    // Kept cues join the group just above, so the running order doesn't change.
    const above = fi > 0 ? show.folders[fi - 1].id : '';
    if (keep) inside.forEach(c => { c.folderId = above; });
    else {
      const ids = new Set(inside.map(c => c.id));
      const standbyId = show.cues[standby] && !ids.has(show.cues[standby].id) ? show.cues[standby].id : null;
      const firstIdx = indexOf(inside[0].id);
      show.cues = show.cues.filter(c => !ids.has(c.id));
      standby = standbyId ? indexOf(standbyId) : Math.min(firstIdx, show.cues.length);
      settings.midiMap = settings.midiMap.filter(m => !ids.has(m.cueId));
      saveSettings();
    }
    show.folders.splice(fi, 1);
    selectedFolderId = null;
    normalizeFolders(); markDirty(); renderList(); renderInspector();
  }

  // Moves a cue into a folder ('' = no folder), before another cue or at the end.
  function moveCueToFolder(id, folderId, beforeId) {
    const c = cueById(id);
    if (!c || locked) return;
    const standbyId = show.cues[standby] ? show.cues[standby].id : null;
    show.cues.splice(indexOf(id), 1);
    c.folderId = folderId || '';
    const at = beforeId ? indexOf(beforeId) : -1;
    show.cues.splice(at >= 0 ? at : show.cues.length, 0, c);
    if (standbyId) standby = indexOf(standbyId);
    const f = folderById(c.folderId);
    if (f) f.collapsed = false;
    normalizeFolders(); markDirty(); renderList();
  }

  function nextNumber() {
    let max = 0;
    show.cues.forEach(c => { const n = parseFloat(c.number); if (!isNaN(n) && n > max) max = n; });
    return String(Math.floor(max) + 1);
  }

  function displayName(c) {
    if (c.name) return c.name;
    if (c.file) return api.basename(c.file);
    return TYPES[c.type].label;
  }

  // ------------------------------------------------------------------ util
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function fmtTenths(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    return `${fmt(sec)}.${Math.floor((sec * 10) % 10)}`;
  }
  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 7000 : 4000);
  }
  function mediaPath(c) { return c.file && !missing.has(c.id) ? c.file : null; }
  function typeForPath(p) {
    const e = api.extname(p);
    return Object.keys(EXT).find(k => EXT[k].includes(e)) || null;
  }
  function probeDuration(p, type) {
    return new Promise((res) => {
      if (type === 'image') return res(0);
      const el = document.createElement(type === 'video' ? 'video' : 'audio');
      el.preload = 'metadata';
      const done = (v) => { el.removeAttribute('src'); el.load(); res(v); };
      el.addEventListener('loadedmetadata', () => done(isFinite(el.duration) ? el.duration : 0), { once: true });
      el.addEventListener('error', () => done(0), { once: true });
      setTimeout(() => done(0), 8000);
      el.src = api.mediaURL(p);
    });
  }
  function cueLength(c) {
    if (c.type === 'image') return c.hold || 0;
    if (!c.duration) return 0;
    const end = c.endAt > 0 ? Math.min(c.endAt, c.duration) : c.duration;
    return Math.max(0, end - (c.startAt || 0));
  }

  // ------------------------------------------------------------------ dirty/title
  function markDirty() {
    if (!dirty) { dirty = true; api.send('set-dirty', true); }
    updateTitle();
  }
  function updateTitle() {
    api.send('set-title', `${dirty ? '• ' : ''}${show.name || 'Untitled Show'} — Unique AV Show Cue`);
  }

  // ------------------------------------------------------------------ renaming
  // Double-click rename: the label turns into a text box. Enter or clicking
  // away keeps the new name, Esc cancels. done() gets the text, or null on cancel.
  function inlineRename(el, value, done) {
    if (locked || !el || !el.isConnected) return;
    const inp = document.createElement('input');
    inp.className = 'inline-rename';
    inp.value = value;
    inp.spellcheck = false;
    inp.style.width = Math.max(90, el.offsetWidth) + 'px';
    const drag = el.closest('[draggable]');
    if (drag) drag.setAttribute('draggable', 'false');
    let finished = false;
    const finish = (v) => { if (finished) return; finished = true; inp.classList.remove('inline-rename'); done(v, inp); };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    });
    // Wait a tick: the blur can come from the label's row being redrawn.
    inp.addEventListener('blur', () => setTimeout(() => finish(inp.value)));
    inp.addEventListener('dblclick', (e) => e.stopPropagation());
    el.replaceWith(inp);
    inp.focus();
    inp.select();
  }

  function renameCue(c, el) {
    inlineRename(el, displayName(c), (v) => {
      if (v != null && v.trim() !== displayName(c)) {
        // An empty name goes back to showing the file name.
        c.name = v.trim();
        markDirty();
      }
      refreshRow(c);
      renderStandby();
      if (c.id === selectedId) renderInspector();
    });
  }

  function renameFolderInline(id, el) {
    const f = folderById(id);
    if (f) inlineRename(el, f.name, (v) => renameFolder(id, v == null ? f.name : v));
  }

  // The show file on disk, next to the show name. Double-click renames it.
  function renderShowFile() {
    const el = $('#showFile');
    el.textContent = showPath ? api.basename(showPath) : 'Not saved yet';
    el.classList.toggle('unsaved', !showPath);
    el.title = showPath
      ? `Show file: ${showPath}\nDouble-click to rename the file`
      : 'This show has not been saved yet. Double-click to save it';
  }

  function renameShowFile() {
    if (locked) return;
    if (!showPath) { save(true); return; }
    const el = $('#showFile');
    const old = api.basename(showPath).replace(/\.showcue$/i, '');
    inlineRename(el, old, async (v, inp) => {
      if (inp.isConnected) inp.replaceWith(el);
      if (v == null || !v.trim() || v.trim() === old) { renderShowFile(); return; }
      const r = await api.invoke('show-rename', { path: showPath, name: v.trim() });
      if (r && r.path) { showPath = r.path; toast(`Show file renamed to ${api.basename(r.path)}`); }
      else toast((r && r.error) || 'Could not rename the show file', 'err');
      renderShowFile();
    });
  }

  // ------------------------------------------------------------------ cue list rendering
  function outputLabel(c) {
    if (c.type === 'audio' || c.type === 'video') {
      const dev = c.device ? c.device.replace(/\s*\(.*?\)\s*$/, '') : 'Default';
      const r = c.route && c.route[0] === 'm' ? `ch ${c.route.slice(1)}` : `ch ${c.route || '1-2'}`;
      return `${c.type === 'video' ? 'Screen + ' : ''}${dev} · ${r}`;
    }
    if (c.type === 'image' || c.type === 'black') return 'Screen';
    if (c.type === 'osc') return `${c.host}:${c.port}`;
    if (c.type === 'midi') return c.port || 'First MIDI out';
    if (c.type === 'stop') {
      if (c.target === 'all') return 'Everything';
      if (c.target === 'audio') return 'All audio';
      if (c.target === 'visual') return 'All video/images';
      const t = cueById(c.target);
      return t ? `Cue ${t.number} ${displayName(t)}` : '(missing cue)';
    }
    return '';
  }
  function followLabel(c) {
    if (c.follow === 'start') return `↪ with${c.followDelay ? ' +' + c.followDelay + 's' : ''}`;
    if (c.follow === 'end') return `↓ after${c.followDelay ? ' +' + c.followDelay + 's' : ''}`;
    return '';
  }

  function rowHTML(c, i) {
    const len = cueLength(c);
    const hasFades = ['audio', 'video', 'image'].includes(c.type);
    const vol = (c.type === 'audio' || c.type === 'video') ? c.volume : '';
    const gain = vol !== '' && c.gain ? c.gain : 0;
    const isMissing = missing.has(c.id) || (hasFades && !c.file);
    const f = c.folderId ? folderById(c.folderId) : null;
    return `<div class="cue-row ${c.color ? 'c-' + c.color : ''} ${i === standby ? 'standby' : ''} ${c.id === selectedId ? 'selected' : ''} ${isMissing ? 'missing' : ''} ${f ? 'in-folder' : ''} ${f && f.collapsed ? 'folded' : ''}"
        data-id="${c.id}" draggable="${!locked}">
      <div class="prog"></div>
      <div class="num">${esc(c.number)}</div>
      <div><span class="tag ${c.type}">${TYPES[c.type].tag}</span></div>
      <div class="name" title="${esc(c.notes || displayName(c))}">${esc(displayName(c))}${isMissing && hasFades ? ' <small>⚠ file missing</small>' : ''}${c.loop ? ' <small>⟲ loop</small>' : ''}${c.notes ? `<small>${esc(c.notes)}</small>` : ''}</div>
      <div class="r mono">${len ? fmt(len) : (c.type === 'image' ? '<span class="dim">hold</span>' : '')}</div>
      <div class="r mono">${hasFades && c.fadeIn ? c.fadeIn + 's' : ''}</div>
      <div class="r mono">${hasFades && c.fadeOut ? c.fadeOut + 's' : (c.type === 'stop' || c.type === 'black') && c.fade ? c.fade + 's' : ''}</div>
      <div class="r mono${gain ? ' gained' : ''}"${gain ? ` title="Gain ${fmtDb(gain)} dB"` : ''}>${vol !== '' ? vol + '%' : ''}</div>
      <div class="dim">${esc(outputLabel(c))}</div>
      <div class="dim">${followLabel(c)}</div>
    </div>`;
  }

  function folderHTML(f) {
    const n = folderCues(f.id).length;
    const len = folderLength(f.id);
    const name = renamingFolderId === f.id
      ? `<input class="f-rename" value="${esc(f.name)}" spellcheck="false">`
      : `<span class="f-name" title="Double-click to rename">${esc(f.name)}</span>`;
    return `<div class="folder-row ${f.collapsed ? 'collapsed' : ''} ${f.id === selectedFolderId ? 'selected' : ''}" data-folder="${f.id}" draggable="${!locked}">
      <button class="f-caret" data-fact="toggle" title="${f.collapsed ? 'Open' : 'Close'} folder">${f.collapsed ? '▸' : '▾'}</button>
      ${name}
      <span class="f-meta">${n} cue${n === 1 ? '' : 's'}${len ? ' · ' + fmt(len) : ''}</span>
      <span class="f-standby">▶ standby inside</span>
      <span class="f-spacer"></span>
      <button class="f-btn" data-fact="standby" title="Put the first cue of this folder on standby">Standby</button>
      <button class="f-btn edit" data-fact="rename" title="Rename folder">Rename</button>
      <button class="f-btn edit" data-fact="up" title="Move folder up">↑</button>
      <button class="f-btn edit" data-fact="down" title="Move folder down">↓</button>
      <button class="f-btn edit danger" data-fact="delete" title="Delete folder">✕</button>
    </div>`;
  }

  // ------------------------------------------------------------------ pads view
  // The same cues as the list, drawn as MiX16-style channel strips: name,
  // volume fader, times, a big numbered play button, pause and stop. Folders
  // become tabs. A pad fires its cue without moving standby, like a MIDI trigger.
  const cueMidi = (id) => settings.midiMap.find(m => m.action === 'cue' && m.cueId === id);
  const padsView = () => settings.view === 'pads';
  const hasVolume = (c) => c.type === 'audio' || c.type === 'video';
  let padTab = 'all'; // 'all', '' (cues not in a folder) or a folder id

  function padHTML(c, i) {
    const len = cueLength(c);
    const hasFile = ['audio', 'video', 'image'].includes(c.type);
    const isMissing = missing.has(c.id) || (hasFile && !c.file);
    const map = cueMidi(c.id);
    const learning = midiLearn && midiLearn.cueId === c.id;
    const midi = learning ? 'Press a key…' : map ? sigLabel(map.sig) : (padLearn ? 'No key' : '');
    const vol = c.volume == null ? 100 : c.volume;
    return `<div class="pad ${i === standby ? 'pad-standby' : ''} ${c.id === selectedId ? 'selected' : ''} ${isMissing ? 'missing' : ''} ${learning ? 'learning' : ''}"
        data-id="${c.id}" style="--pc:${c.color ? COLOR_HEX[c.color] : '#ff8a80'}" title="${esc(c.notes || displayName(c))}">
      <div class="sp-name" title="Double-click to rename">${esc(displayName(c))}</div>
      <div class="sp-mid">
        <div class="sp-side"><span class="tag ${c.type}">${TYPES[c.type].tag}</span>${isMissing && hasFile ? '<span class="sp-warn" title="File missing">⚠</span>' : ''}</div>
        ${hasVolume(c)
          ? `<input type="range" class="sp-fader" min="0" max="100" step="1" value="${vol}" title="Cue volume (double-click: 100%)">`
          : '<div class="sp-nofader"></div>'}
        <div class="sp-side"></div>
      </div>
      <div class="sp-vol">${hasVolume(c) ? vol + '%' : '&nbsp;'}</div>
      <div class="sp-time"><span class="sp-el">${len ? '0:00.0' : ''}</span><span class="sp-tot">${len ? fmtTenths(len) : ''}</span></div>
      <button class="sp-play" data-pact="play" title="Play (click again to stop)">${esc(c.number) || '▶'}</button>
      <div class="sp-btns"><button data-pact="pause" title="Pause / resume">❚❚</button><button data-pact="stop" title="Stop with fade (Shift-click: stop now)">Stop</button></div>
      <div class="sp-foot">${c.type === 'audio' || c.type === 'video'
        ? `<button class="sp-loop ${c.loop ? 'on' : ''}" data-pact="loop" title="Loop">⟲</button>` : '<span></span>'}<span class="pad-midi ${map ? 'set' : ''}">${esc(midi)}</span></div>
      <div class="pad-fill"></div>
      ${padLearn && map && !learning ? '<button class="pad-x" data-pact="unlearn" title="Clear this pad\'s MIDI key">✕</button>' : ''}
    </div>`;
  }

  function renderPads() {
    const box = $('#padGrid');
    if (!padsView()) { box.innerHTML = ''; return; }
    const loose = show.cues.some(c => !groupOf(c));
    if (padTab !== 'all' && !(padTab === '' ? loose : folderById(padTab))) padTab = 'all';
    let tabs = '';
    if (show.folders.length) {
      const tab = (id, label, n) => `<button class="pad-tab ${padTab === id ? 'on' : ''}" data-tab="${esc(id)}"${id && id !== 'all' ? ' title="Double-click to rename this folder"' : ''}>${esc(label)} <small>${n}</small></button>`;
      tabs = tab('all', 'All cues', show.cues.length)
        + (loose ? tab('', 'No folder', folderCues('').length) : '')
        + show.folders.map(f => tab(f.id, f.name, folderCues(f.id).length)).join('');
    }
    let h = '';
    let i = 0;
    groupIds().forEach(gid => {
      const f = gid ? folderById(gid) : null;
      let pads = '';
      while (i < show.cues.length && groupOf(show.cues[i]) === gid) { pads += padHTML(show.cues[i], i); i++; }
      if (padTab !== 'all' && padTab !== gid) return;
      if (!f && !pads) return;
      if (f && padTab === 'all') h += `<div class="pad-folder" data-folder="${f.id}"><span class="f-name" title="Double-click to rename">${esc(f.name)}</span></div>`;
      h += `<div class="pads">${pads || '<div class="pad-empty">No cues in this folder yet</div>'}</div>`;
    });
    const mv = show.masterVolume == null ? 100 : show.masterVolume;
    box.innerHTML = `<div class="pad-main">${tabs ? `<div class="pad-tabs">${tabs}</div>` : ''}<div class="pad-scroll">${h}</div></div>
      <div class="pad-master"><div class="sp-name">Master</div>
        <input type="range" class="sp-fader" id="padMaster" min="0" max="100" step="1" value="${mv}" title="Master volume">
        <div class="sp-vol" id="padMasterVal">${mv}%</div></div>`;
    box.classList.toggle('learn', padLearn);
    updatePlayingRows();
  }

  const PAD_MIN = 60, PAD_MAX = 200;
  function setPadSize(v) {
    settings.padSize = Math.max(PAD_MIN, Math.min(PAD_MAX, Math.round(v / 10) * 10 || 100));
    saveSettings();
    applyPadSize();
  }
  function applyPadSize() {
    const s = settings.padSize || 100;
    $('#padGrid').style.setProperty('--ps', s / 100);
    $('#padSizeVal').textContent = s + '%';
    $('#padSmaller').disabled = s <= PAD_MIN;
    $('#padBigger').disabled = s >= PAD_MAX;
  }

  function setView(v) {
    settings.view = v === 'pads' ? 'pads' : 'list';
    saveSettings();
    if (!padsView()) setPadLearn(false);
    $('#cuelist').classList.toggle('pad-view', padsView());
    $$('.view-toggle button').forEach(b => b.classList.toggle('on', b.dataset.view === settings.view));
    renderPads();
  }

  function setPadLearn(v) {
    padLearn = v;
    if (!v && midiLearn && midiLearn.cueId) midiLearn = null;
    if (v && !midiAccess) toast('No MIDI devices found. Connect a MIDI controller first.', 'warn');
    $('#padLearnBtn').classList.toggle('learning', v);
    $('#padLearnBtn').textContent = v ? 'Done learning' : 'MIDI Learn';
    renderPads();
    renderInspector();
  }

  // Pad click or its MIDI key: play the cue, or stop it if it is already playing.
  function padPress(c) {
    const el = $(`.pad[data-id="${c.id}"]`);
    if (el) { el.classList.add('hit'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('hit'), 150); }
    const playing = [...active.values()].filter(i => i.cue.id === c.id && i.state !== 'stopping');
    if (playing.length && settings.padToggle) { playing.forEach(i => stopInst(i)); return; }
    fire(c, true);
  }

  function renderList() {
    const box = $('#cueRows');
    normalizeFolders();
    let h = '';
    let i = 0;
    groupIds().forEach(gid => {
      if (gid) h += folderHTML(folderById(gid));
      while (i < show.cues.length && groupOf(show.cues[i]) === gid) { h += rowHTML(show.cues[i], i); i++; }
    });
    box.innerHTML = h;
    const nf = show.folders.length;
    $('#emptyHint').style.display = show.cues.length || nf ? 'none' : 'block';
    $('#cueCount').textContent = `${show.cues.length} cue${show.cues.length === 1 ? '' : 's'}${nf ? ` · ${nf} folder${nf === 1 ? '' : 's'}` : ''}`;
    const ren = box.querySelector('.f-rename');
    if (ren) { ren.focus(); ren.select(); }
    renderPads();
    renderStandby();
    updatePlayingRows();
    renderMixer();
  }

  function renderStandby() {
    if (standby > show.cues.length) standby = show.cues.length;
    const c = show.cues[standby];
    $('#standbyNum').textContent = c ? c.number : '';
    $('#standbyName').textContent = c ? displayName(c) : (show.cues.length ? 'End of cue list' : '—');
    $('#standbyNotes').textContent = c ? (c.notes || '') : '';
    $('#goBtn').disabled = !c;
    $$('.cue-row').forEach((r, i) => r.classList.toggle('standby', i === standby));
    $$('.pad').forEach(p => p.classList.toggle('pad-standby', !!c && p.dataset.id === c.id));
    const sf = c && c.folderId;
    $$('.folder-row').forEach(r => r.classList.toggle('has-standby', r.dataset.folder === sf));
    sendFeedback();
  }

  function scrollToRow(i) {
    if (padsView()) {
      const p = show.cues[i] && $(`.pad[data-id="${show.cues[i].id}"]`);
      if (p) p.scrollIntoView({ block: 'nearest' });
      return;
    }
    let r = $$('.cue-row')[i];
    // A cue in a closed folder is hidden: show its folder instead.
    if (r && r.classList.contains('folded')) r = $(`.folder-row[data-folder="${show.cues[i].folderId}"]`);
    if (r) r.scrollIntoView({ block: 'nearest' });
  }

  function setStandby(i, alsoSelect) {
    standby = Math.max(0, Math.min(i, show.cues.length));
    if (alsoSelect && show.cues[standby]) select(show.cues[standby].id, false);
    renderStandby();
    scrollToRow(standby);
  }

  function select(id, rebuildList = true) {
    selectedId = id;
    selectedFolderId = null;
    $$('.folder-row.selected').forEach(r => r.classList.remove('selected'));
    $$('.cue-row').forEach(r => r.classList.toggle('selected', r.dataset.id === id));
    $$('.pad').forEach(p => p.classList.toggle('selected', p.dataset.id === id));
    renderInspector();
    if (rebuildList) { /* rows already updated */ }
  }

  function updatePlayingRows() {
    const prog = {};
    const left = {};
    const live = new Set(); // cues with an instance that is not fading out
    const paused = new Set();
    const elapsed = {};
    for (const inst of active.values()) {
      if (inst.state !== 'stopping') live.add(inst.cue.id);
      if (inst.state === 'paused') paused.add(inst.cue.id);
      const d = inst.dur || 0;
      const p = d > 0 ? Math.min(1, inst.t / d) : 0;
      if (!(inst.cue.id in prog) || p > prog[inst.cue.id]) {
        prog[inst.cue.id] = p;
        left[inst.cue.id] = d > 0 ? Math.max(0, d - Math.max(0, inst.t || 0)) : null;
        elapsed[inst.cue.id] = Math.max(0, inst.t || 0);
      }
    }
    $$('.pad').forEach(el => {
      const id = el.dataset.id;
      const on = id in prog;
      el.classList.toggle('playing', on);
      el.classList.toggle('fading', on && !live.has(id));
      el.classList.toggle('paused', paused.has(id));
      el.querySelector('.pad-fill').style.width = on ? (prog[id] * 100).toFixed(2) + '%' : '0';
      const c = cueById(id);
      const len = c ? cueLength(c) : 0;
      el.querySelector('.sp-el').textContent = on ? fmtTenths(elapsed[id] || 0) : (len ? '0:00.0' : '');
      el.querySelector('.sp-tot').textContent = on && left[id] != null ? '-' + fmtTenths(left[id]) : (len ? fmtTenths(len) : '');
    });
    $$('.cue-row').forEach(r => {
      const id = r.dataset.id;
      const on = id in prog;
      r.classList.toggle('playing', on);
      r.querySelector('.prog').style.width = on ? (prog[id] * 100).toFixed(2) + '%' : '0';
    });
  }

  // ------------------------------------------------------------------ inspector
  function fieldHTML(label, inner, hint) {
    return `<div class="field"><label>${label}</label>${inner}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  }
  const num = (key, val, step = 0.1, min = 0, max = '') =>
    `<input type="number" data-key="${key}" data-kind="num" value="${val == null ? '' : val}" step="${step}" min="${min}" ${max !== '' ? `max="${max}"` : ''}>`;
  const txt = (key, val, ph = '') => `<input type="text" data-key="${key}" value="${esc(val)}" placeholder="${esc(ph)}" spellcheck="false">`;
  const chk = (key, val, label) => `<label class="row" style="color:var(--text)"><input type="checkbox" data-key="${key}" data-kind="bool" ${val ? 'checked' : ''}> ${label}</label>`;
  const sel = (key, val, opts) => `<select data-key="${key}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  function deviceOptions(current) {
    const opts = [['', 'Default output']];
    AR.devices.filter(d => d.deviceId !== 'default').forEach(d => opts.push([d.label, d.label || 'Unnamed device']));
    if (current && !opts.some(o => o[0] === current)) opts.push([current, `${current} (not connected)`]);
    return opts;
  }

  function renderInspector() {
    renderInspectorInner();
    if (wave) wave.show(cueById(selectedId));
  }
  function renderInspectorInner() {
    const box = $('#inspector');
    const c = cueById(selectedId);
    const fo = !c && selectedFolderId ? folderById(selectedFolderId) : null;
    if (fo) {
      const n = folderCues(fo.id).length, len = folderLength(fo.id);
      let h = `<h3><span class="tag folder">SET</span> Folder</h3>`;
      h += fieldHTML('Name', `<input type="text" data-fkey="name" value="${esc(fo.name)}" spellcheck="false">`);
      h += fieldHTML('Cues', `<span>${n}${len ? ` · running time ${fmt(len)}` : ''}</span>`);
      h += `<div class="hint" style="margin:6px 0 0">Drag cues onto the folder bar to put them in it, or pick a folder in a cue's settings. Cues play straight through from one folder into the next.</div>`;
      h += `<div class="insp-actions"><button class="ibtn allow-locked" data-fact="standby">Standby first cue</button><button class="ibtn" data-fact="delete">Delete folder</button></div>`;
      box.innerHTML = h;
      return;
    }
    if (!c) {
      box.innerHTML = `<div class="insp-empty">Select a cue to edit it.<br><br>Drop media files onto the list, or use the Add buttons.</div>`;
      return;
    }
    let h = `<h3><span class="tag ${c.type}">${TYPES[c.type].tag}</span> ${TYPES[c.type].label} cue</h3>`;
    h += fieldHTML('Number', txt('number', c.number));
    h += fieldHTML('Name', txt('name', c.name, c.file ? api.basename(c.file) : ''));
    h += fieldHTML('Notes', `<textarea data-key="notes" spellcheck="true" placeholder="Shown under STANDBY">${esc(c.notes)}</textarea>`);
    if (show.folders.length) h += fieldHTML('Folder', sel('folderId', c.folderId || '', [['', '(no folder)']].concat(show.folders.map(f => [f.id, f.name]))));
    h += fieldHTML('Colour', `<div class="colors">${COLORS.map(col => `<button data-color="${col}" class="${c.color === col ? 'sel' : ''}" style="background:${COLOR_HEX[col]}" title="${col || 'none'}"></button>`).join('')}</div>`);

    if (['audio', 'video', 'image'].includes(c.type)) {
      const miss = missing.has(c.id) || !c.file;
      h += `<div class="group"><div class="group-title">Media</div>`;
      h += fieldHTML('File', `<div class="file"><span class="${miss ? 'missing' : ''}" title="${esc(c.file)}">${c.file ? esc(api.basename(c.file)) + (missing.has(c.id) ? ' (missing)' : '') : 'No file'}</span><button class="ibtn" data-act="pick">Choose…</button></div>`);
      if (c.type !== 'image') {
        h += fieldHTML('Volume', `<div class="row"><input type="range" min="0" max="100" step="1" data-key="volume" data-kind="num" value="${c.volume}"><span class="val" id="volVal">${c.volume}%</span></div>`);
      }
      h += fieldHTML('Fade in (s)', num('fadeIn', c.fadeIn));
      h += fieldHTML('Fade out (s)', num('fadeOut', c.fadeOut), 'Used when the cue is stopped');
      if (c.type !== 'image') {
        h += fieldHTML('Start at (s)', num('startAt', c.startAt));
        h += fieldHTML('End at (s)', num('endAt', c.endAt), `0 = play to the end${c.duration ? ` (file is ${fmtTenths(c.duration)})` : ''}`);
        h += fieldHTML('', chk('loop', c.loop, 'Loop'));
        h += fieldHTML('', chk('fadeAtEnd', c.fadeAtEnd, 'Fade out at end point'), 'Uses the fade-out time before End at / end of file');
      } else {
        h += fieldHTML('Hold (s)', num('hold', c.hold, 0.5), '0 = stay on screen until stopped');
      }
      if (c.type !== 'audio') {
        h += fieldHTML('Fit', sel('fit', c.fit, [['contain', 'Fit (letterbox)'], ['cover', 'Fill (crop)'], ['fill', 'Stretch']]));
        h += fieldHTML('', chk('replace', c.replace !== false, 'Crossfade out other visuals'));
        if (c.type === 'video') h += fieldHTML('', chk('holdLast', c.holdLast, 'Hold last frame at end'));
      }
      h += `</div>`;
      if (c.type !== 'image') {
        h += `<div class="group"><div class="group-title">Audio output</div>`;
        const hidden = namesHidden();
        h += fieldHTML('Device', sel('device', c.device, deviceOptions(c.device)), hidden ? `Device names are hidden. <button class="ibtn" data-act="unlock">Show device names</button>` : '');
        h += fieldHTML('Channels', `<select data-key="route" id="routeSel"></select>`, `<span id="chHint"></span>`);
        const inFolder = c.folderId && folderById(c.folderId);
        h += `<div class="insp-actions"><button class="ibtn" data-act="tone" title="Plays a short beep on this output and these channels">🔊 Test output</button>`;
        if (inFolder) h += `<button class="ibtn" data-act="routeFolder" title="Give every audio and video cue in this folder the same output and channels">Use for this folder</button>`;
        h += `<button class="ibtn" data-act="routeAll" title="Give every audio and video cue in the show the same output and channels">Use for all cues</button></div>`;
        h += `</div>`;
      }
    }

    if (c.type === 'stop') {
      const opts = [['all', 'Everything'], ['audio', 'All audio cues'], ['visual', 'All video & image cues']];
      show.cues.filter(x => x.id !== c.id && ['audio', 'video', 'image'].includes(x.type))
        .forEach(x => opts.push([x.id, `Cue ${x.number} – ${displayName(x)}`]));
      h += `<div class="group"><div class="group-title">Stop</div>`;
      h += fieldHTML('Stop', sel('target', c.target, opts));
      h += fieldHTML('Fade (s)', num('fade', c.fade));
      h += `</div>`;
    }
    if (c.type === 'black') {
      h += `<div class="group"><div class="group-title">Black screen</div>`;
      h += fieldHTML('Fade (s)', num('fade', c.fade), 'Fades all video and images off the output');
      h += `</div>`;
    }
    if (c.type === 'osc') {
      h += `<div class="group"><div class="group-title">OSC message</div>`;
      h += fieldHTML('Host', txt('host', c.host, '127.0.0.1'));
      h += fieldHTML('Port', num('port', c.port, 1, 1, 65535));
      h += fieldHTML('Address', txt('address', c.address, '/cue/1/go'));
      h += fieldHTML('Arguments', txt('args', c.args, '1 0.5 "text"'), 'Space separated. Numbers are sent as numbers, "quoted" as text.');
      h += `<div class="insp-actions"><button class="ibtn" data-act="test">Send now</button></div>`;
      h += `</div>`;
    }
    if (c.type === 'midi') {
      const outs = midiAccess ? Array.from(midiAccess.outputs.values()).map(o => [o.name, o.name]) : [];
      if (c.port && !outs.some(o => o[0] === c.port)) outs.push([c.port, `${c.port} (not connected)`]);
      h += `<div class="group"><div class="group-title">MIDI message</div>`;
      h += fieldHTML('Port', sel('port', c.port, [['', 'First available output'], ...outs]));
      h += fieldHTML('Message', sel('msg', c.msg, [['note', 'Note On'], ['noteoff', 'Note Off'], ['cc', 'Control Change'], ['pc', 'Program Change']]));
      h += fieldHTML('Channel', num('channel', c.channel, 1, 1, 16));
      h += fieldHTML(c.msg === 'pc' ? 'Program' : c.msg === 'cc' ? 'Controller' : 'Note', num('data1', c.data1, 1, 0, 127));
      if (c.msg !== 'pc') h += fieldHTML(c.msg === 'cc' ? 'Value' : 'Velocity', num('data2', c.data2, 1, 0, 127));
      h += `<div class="insp-actions"><button class="ibtn" data-act="test">Send now</button></div>`;
      h += `</div>`;
    }

    h += `<div class="group"><div class="group-title">Follow</div>`;
    h += fieldHTML('Then', sel('follow', c.follow, [['off', 'Wait for GO'], ['start', 'Start next cue with this one'], ['end', 'Start next cue when this ends']]));
    if (c.follow !== 'off') h += fieldHTML('Delay (s)', num('followDelay', c.followDelay));
    const map = settings.midiMap.find(m => m.action === 'cue' && m.cueId === c.id);
    h += fieldHTML('MIDI trigger', `<div class="row"><span class="sig">${map ? esc(sigLabel(map.sig)) : '—'}</span><button class="ibtn allow-locked ${midiLearn && midiLearn.cueId === c.id ? 'learning' : ''}" data-act="learn">${midiLearn && midiLearn.cueId === c.id ? 'Press a key…' : 'Learn'}</button>${map ? '<button class="ibtn" data-act="unlearn">Clear</button>' : ''}</div>`, 'Fires this cue directly (standby does not move)');
    h += `</div>`;
    h += `<div class="insp-actions"><button class="ibtn allow-locked" data-act="fire">▶ Fire this cue</button><button class="ibtn allow-locked" data-act="standby">Set as standby</button></div>`;

    box.innerHTML = h;
    if (c.type === 'audio' || c.type === 'video') fillRoutes(c);
  }

  const namesHidden = () => {
    const devs = AR.devices.filter(d => d.deviceId !== 'default');
    return devs.length > 0 && devs.every(d => !d.label);
  };

  // Fills a channel picker with the pairs and single outputs the device has.
  async function fillRouteSelect(selEl, hint, device, route) {
    const n = await AR.channelCount(device);
    const opts = AR.routeOptions(n || 2);
    if (route && !opts.some(o => o.value === route)) opts.push({ value: route, label: `${route} (not on this device)` });
    selEl.innerHTML = opts.map(o => `<option value="${o.value}" ${o.value === (route || '1-2') ? 'selected' : ''}>${o.label}</option>`).join('');
    if (hint) hint.textContent = n ? `This output has ${n} channel${n === 1 ? '' : 's'}` : 'Device not connected';
  }

  async function fillRoutes(c) {
    const selEl = $('#routeSel');
    if (selEl) await fillRouteSelect(selEl, $('#chHint'), c.device, c.route);
  }

  // Copies a cue's output and channels to other audio/video cues.
  async function copyRoute(c, cues, where) {
    if (locked) return;
    const targets = cues.filter(x => x.id !== c.id && (x.type === 'audio' || x.type === 'video'));
    if (!targets.length) { toast(`No other audio or video cues ${where}.`); return; }
    const dev = c.device || 'Default output';
    const r = await api.invoke('confirm', {
      message: `Send ${targets.length} cue${targets.length === 1 ? '' : 's'} ${where} to "${dev}", ${routeText(c.route)}?`,
      detail: 'Each cue keeps its own volume and fades. Only the output and channels change.',
      buttons: ['Change them', 'Cancel']
    });
    if (r !== 0) return;
    targets.forEach(x => { x.device = c.device || ''; x.route = c.route || '1-2'; refreshRow(x); });
    markDirty(); renderMixer();
    toast(`${targets.length} cue${targets.length === 1 ? '' : 's'} now use ${dev}, ${routeText(c.route)}.`);
  }

  function routeText(route) {
    const o = AR.routeOptions(64).find(x => x.value === (route || '1-2'));
    return o ? o.label.toLowerCase() : route;
  }

  function onInspectorInput(e) {
    const el = e.target;
    if (el.dataset.fkey === 'name' && !locked) {
      const f = folderById(selectedFolderId);
      if (!f) return;
      f.name = el.value;
      const n = $(`.folder-row[data-folder="${f.id}"] .f-name`);
      if (n) n.textContent = f.name;
      markDirty();
      return;
    }
    const key = el.dataset.key;
    const c = cueById(selectedId);
    if (!key || !c || locked) return;
    if (key === 'folderId') {
      if (e.type === 'change') { moveCueToFolder(c.id, el.value); select(c.id); scrollToRow(indexOf(c.id)); }
      return;
    }
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.kind === 'num') { v = parseFloat(v); if (isNaN(v)) v = 0; }
    c[key] = v;
    if (key === 'volume') {
      const vv = $('#volVal'); if (vv) vv.textContent = v + '%';
      for (const inst of active.values()) if (inst.cue.id === c.id) setInstVolume(inst);
    }
    markDirty();
    refreshRow(c);
    if (wave) wave.refresh();
    if (e.type === 'change' && ['follow', 'msg', 'device', 'type'].includes(key)) renderInspector();
    if (key === 'device') renderMixer();
    if (key === 'number' || key === 'name' || key === 'notes') renderStandby();
  }

  function refreshRow(c, keepPad) {
    const i = indexOf(c.id);
    const tmp = document.createElement('div');
    // A row or pad being renamed is redrawn when the rename finishes.
    const busy = (el) => el && el.querySelector('.inline-rename');
    const pad = !keepPad && $(`.pad[data-id="${c.id}"]`);
    if (pad && !busy(pad)) { tmp.innerHTML = padHTML(c, i); pad.replaceWith(tmp.firstElementChild); }
    const old = $(`.cue-row[data-id="${c.id}"]`);
    if (old && !busy(old)) { tmp.innerHTML = rowHTML(c, i); old.replaceWith(tmp.firstElementChild); }
    updatePlayingRows();
  }

  async function onInspectorClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.fact && selectedFolderId) {
      if (b.dataset.fact === 'standby') standbyFolder(selectedFolderId);
      if (b.dataset.fact === 'delete') deleteFolder(selectedFolderId);
      return;
    }
    const c = cueById(selectedId);
    if (!c) return;
    if (b.dataset.color !== undefined) {
      c.color = b.dataset.color; markDirty(); refreshRow(c); renderInspector(); return;
    }
    switch (b.dataset.act) {
      case 'pick': {
        const files = await api.invoke('pick-media', c.type);
        if (!files[0]) return;
        await setCueFile(c, files[0]);
        renderInspector(); refreshRow(c); markDirty();
        break;
      }
      case 'test': fire(c, false); break;
      case 'tone': {
        const w = await AR.testTone(c.device, c.route);
        if (w) toast(w, 'warn');
        break;
      }
      case 'unlock': await AR.unlockLabels(); renderInspector(); renderMixer(); break;
      case 'routeFolder': copyRoute(c, folderCues(c.folderId), 'in this folder'); break;
      case 'routeAll': copyRoute(c, show.cues, 'in the show'); break;
      case 'fire': fire(c, true); break;
      case 'standby': setStandby(indexOf(c.id)); break;
      case 'learn':
        midiLearn = midiLearn && midiLearn.cueId === c.id ? null : { action: 'cue', cueId: c.id };
        if (midiLearn && !midiAccess) toast('No MIDI devices found. Connect a MIDI controller first.', 'warn');
        renderInspector(); break;
      case 'unlearn':
        settings.midiMap = settings.midiMap.filter(m => !(m.action === 'cue' && m.cueId === c.id));
        saveSettings(); renderInspector(); break;
    }
  }

  async function setCueFile(c, p) {
    c.file = p;
    missing.delete(c.id);
    c.duration = await probeDuration(p, c.type);
  }

  // ------------------------------------------------------------------ editing
  function insertCue(c, at) {
    if (!c.number) c.number = nextNumber();
    if (c.folderId === undefined) c.folderId = insertFolder();
    const pos = at == null ? show.cues.length : at;
    show.cues.splice(pos, 0, c);
    if (pos < standby) standby++;
    markDirty();
    return c;
  }

  // New cues go after the selected cue (in its folder), at the end of the
  // selected folder, or at the end of the list.
  function insertFolder() {
    if (selectedFolderId && folderById(selectedFolderId)) return selectedFolderId;
    const c = cueById(selectedId);
    if (c) return groupOf(c);
    return show.folders.length ? show.folders[show.folders.length - 1].id : '';
  }

  function insertPos() {
    if (selectedFolderId && folderById(selectedFolderId)) {
      const r = groupRank(selectedFolderId);
      let pos = 0;
      show.cues.forEach((c, i) => { if (groupRank(groupOf(c)) <= r) pos = i + 1; });
      return pos;
    }
    const i = indexOf(selectedId);
    return i >= 0 ? i + 1 : show.cues.length;
  }

  async function addCue(type) {
    if (locked) return;
    if (['audio', 'video', 'image'].includes(type)) {
      const files = await api.invoke('pick-media', type);
      if (!files.length) return;
      await addFiles(files, type);
      return;
    }
    const c = insertCue(defaultsFor(type), insertPos());
    const f = folderById(c.folderId);
    if (f) f.collapsed = false;
    renderList(); select(c.id);
    scrollToRow(indexOf(c.id));
  }

  async function addFiles(paths, forceType) {
    let pos = insertPos();
    const folderId = insertFolder();
    const f = folderById(folderId);
    if (f) f.collapsed = false;
    let last = null;
    let skipped = 0;
    for (const p of paths) {
      const type = forceType || typeForPath(p);
      if (!type) { skipped++; continue; }
      const c = defaultsFor(type);
      c.file = p;
      c.folderId = folderId;
      c.duration = await probeDuration(p, type);
      insertCue(c, pos++);
      last = c;
    }
    if (skipped) toast(`${skipped} file${skipped > 1 ? 's' : ''} skipped (not audio, video or image)`, 'warn');
    renderList();
    if (last) { select(last.id); scrollToRow(indexOf(last.id)); }
  }

  function moveSelected(delta) {
    if (locked) return;
    if (selectedFolderId) { moveFolder(selectedFolderId, delta); return; }
    const i = indexOf(selectedId);
    if (i < 0) return;
    const c = show.cues[i];
    const nb = show.cues[i + delta];
    if (nb && groupOf(nb) === groupOf(c)) { moveCue(i, i + delta); return; }
    // At the edge of a folder: step into the folder above / below.
    const groups = groupIds();
    const g = groups.indexOf(groupOf(c)) + delta;
    if (g < 0 || g >= groups.length) return;
    c.folderId = groups[g];
    const f = folderById(c.folderId);
    if (f) f.collapsed = false;
    normalizeFolders(); markDirty(); renderList();
    scrollToRow(indexOf(c.id));
  }

  function moveCue(from, to) {
    if (from === to) return;
    const standbyId = show.cues[standby] ? show.cues[standby].id : null;
    const [c] = show.cues.splice(from, 1);
    show.cues.splice(to, 0, c);
    if (standbyId) standby = indexOf(standbyId);
    markDirty(); renderList();
  }

  function duplicateSelected() {
    if (locked) return;
    const c = cueById(selectedId);
    if (!c) return;
    const d = JSON.parse(JSON.stringify(c));
    d.id = uid();
    d.number = nextNumber();
    insertCue(d, indexOf(c.id) + 1);
    renderList(); select(d.id);
  }

  async function deleteSelected() {
    if (locked) return;
    if (selectedFolderId) { deleteFolder(selectedFolderId); return; }
    const c = cueById(selectedId);
    if (!c) return;
    const r = await api.invoke('confirm', { message: `Delete cue ${c.number} "${displayName(c)}"?`, buttons: ['Delete', 'Cancel'] });
    if (r !== 0) return;
    const i = indexOf(c.id);
    show.cues.splice(i, 1);
    if (i < standby) standby--;
    settings.midiMap = settings.midiMap.filter(m => m.cueId !== c.id);
    saveSettings();
    const next = show.cues[Math.min(i, show.cues.length - 1)];
    selectedId = next ? next.id : null;
    markDirty(); renderList(); renderInspector();
  }

  function renumber() {
    if (locked) return;
    show.cues.forEach((c, i) => { c.number = String(i + 1); });
    markDirty(); renderList(); renderInspector();
  }

  // ------------------------------------------------------------------ playback engine
  function go() {
    const now = performance.now();
    if (now - lastGo < (settings.goProtect || 0)) return;
    lastGo = now;
    const btn = $('#goBtn');
    btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 120);
    const c = show.cues[standby];
    if (!c) { toast('End of cue list'); return; }
    const idx = standby;
    setStandby(idx + 1, true);
    fireIndex(idx);
  }

  function fireIndex(idx) {
    const c = show.cues[idx];
    if (c) fire(c, true);
  }

  async function fire(c, withFollow) {
    let inst = null;
    switch (c.type) {
      case 'audio': inst = await playAudio(c); break;
      case 'video': case 'image': inst = playVisual(c); break;
      case 'stop': stopTarget(c.target, c.fade); break;
      case 'black':
        for (const i of active.values()) if (i.kind === 'visual') i.state = 'stopping';
        api.send('output-cmd', { cmd: { cmd: 'clear', fade: c.fade } });
        renderActive();
        break;
      case 'osc': sendOscCue(c); break;
      case 'midi': sendMidiCue(c); break;
    }
    const instant = ['stop', 'black', 'osc', 'midi'].includes(c.type);
    if (!withFollow || c.follow === 'off') return;
    if (!instant && !inst) return; // failed to start
    if (c.follow === 'start' || instant) scheduleFollow(c, c.followDelay);
    else if (inst) inst.followOnEnd = true;
  }

  function scheduleFollow(c, delay) {
    const fromIdx = indexOf(c.id);
    if (fromIdx < 0) return;
    const run = () => {
      const target = show.cues[fromIdx + 1];
      if (!target) return;
      if (standby <= fromIdx + 1) setStandby(fromIdx + 2, true);
      fire(target, true);
    };
    if (!delay) { run(); return; }
    const t = setTimeout(() => { followTimers.delete(t); run(); }, delay * 1000);
    followTimers.add(t);
  }

  function cancelFollows() { followTimers.forEach(t => clearTimeout(t)); followTimers.clear(); }

  function waitMeta(el) {
    return new Promise((res, rej) => {
      if (el.readyState >= 1) return res();
      el.addEventListener('loadedmetadata', res, { once: true });
      el.addEventListener('error', () => rej(new Error('Cannot play this file (unsupported format?)')), { once: true });
    });
  }

  function setInstVolume(inst) {
    if (inst.kind === 'audio' && inst.audio) inst.audio.vol.gain.value = cueLevel(inst.cue) * master();
    if (inst.kind === 'visual') api.send('output-cmd', { cmd: { cmd: 'volume', id: inst.id, volume: inst.cue.volume, gain: inst.cue.gain || 0 } });
  }

  async function playAudio(c) {
    const p = mediaPath(c);
    if (!p) { toast(`Cue ${c.number}: ${c.file ? 'file is missing' : 'no file chosen'}`, 'err'); return null; }
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = api.mediaURL(p);
    const inst = { id: 'a' + (++instSeq), cue: c, kind: 'audio', el, state: 'loading', t: 0, dur: cueLength(c) };
    active.set(inst.id, inst);
    renderActive();
    try {
      await waitMeta(el);
      if (c.startAt > 0) el.currentTime = c.startAt;
      inst.audio = await AR.connect(el, c.device, c.route);
      if (inst.audio.warning) toast(`Cue ${c.number}: ${inst.audio.warning}`, 'warn');
      setInstVolume(inst);
      inst.audio.fade.gain.value = c.fadeIn > 0 ? 0 : 1;
      el.addEventListener('ended', () => audioEnded(inst));
      if (!active.has(inst.id) || inst.state === 'stopping') { cleanupAudio(inst); return null; }
      await el.play();
      if (pausedAll) el.pause();
      inst.state = pausedAll ? 'paused' : 'playing';
      if (c.fadeIn > 0) AR.ramp(inst.audio.fade.gain, inst.audio.ctx, 1, c.fadeIn);
      inst.dur = cueLength(c) || ((c.endAt > 0 ? c.endAt : el.duration) - (c.startAt || 0));
      renderActive();
      return inst;
    } catch (e) {
      toast(`Cue ${c.number}: ${e.message}`, 'err');
      cleanupAudio(inst);
      return null;
    }
  }

  function audioEnded(inst) {
    if (!active.has(inst.id) || inst.state === 'stopping') return;
    if (inst.cue.loop) {
      inst.el.currentTime = inst.cue.startAt || 0;
      inst.el.play().catch(() => {});
      restartFade(inst);
      return;
    }
    finishInst(inst);
  }

  function restartFade(inst) {
    if (!inst.endFading || !inst.audio) return;
    inst.endFading = false;
    AR.ramp(inst.audio.fade.gain, inst.audio.ctx, 1, Math.max(0.05, inst.cue.fadeIn || 0));
  }

  function finishInst(inst) {
    if (inst.kind === 'audio') cleanupAudio(inst);
    else { active.delete(inst.id); renderActive(); }
    if (inst.followOnEnd) { inst.followOnEnd = false; scheduleFollow(inst.cue, inst.cue.followDelay); }
  }

  function cleanupAudio(inst) {
    clearTimeout(inst.stopTimer);
    try { inst.el.pause(); } catch (e) {}
    if (inst.audio) inst.audio.disconnect();
    inst.el.removeAttribute('src');
    inst.el.load();
    active.delete(inst.id);
    renderActive();
  }

  function playVisual(c) {
    const p = mediaPath(c);
    if (!p) { toast(`Cue ${c.number}: ${c.file ? 'file is missing' : 'no file chosen'}`, 'err'); return null; }
    if (c.replace !== false) for (const i of active.values()) if (i.kind === 'visual') i.state = 'stopping';
    const inst = { id: 'v' + (++instSeq), cue: c, kind: 'visual', state: 'loading', t: 0, dur: cueLength(c) };
    active.set(inst.id, inst);
    api.send('output-cmd', {
      displayId: settings.outputDisplay,
      cmd: {
        cmd: 'play', id: inst.id, cueId: c.id, type: c.type, url: api.mediaURL(p),
        volume: c.volume == null ? 100 : c.volume, gain: c.gain || 0, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
        loop: !!c.loop, fadeAtEnd: !!c.fadeAtEnd, startAt: c.startAt || 0, endAt: c.endAt || 0, device: c.device || '', route: c.route || '1-2',
        fit: c.fit || 'contain', hold: c.hold || 0, replace: c.replace !== false, holdLast: !!c.holdLast
      }
    });
    if (master() !== 1) api.send('output-cmd', { cmd: { cmd: 'master', value: show.masterVolume } });
    sendMixer();
    renderActive();
    return inst;
  }

  function stopInst(inst, fade) {
    if (!inst) return;
    const f = fade == null ? (inst.cue.fadeOut || 0) : fade;
    inst.followOnEnd = false;
    if (inst.kind === 'audio') {
      if (inst.state === 'stopping' && f > 0) return;
      inst.state = 'stopping';
      clearTimeout(inst.stopTimer);
      if (!inst.audio || f <= 0) { cleanupAudio(inst); return; }
      if (inst.el.paused) { cleanupAudio(inst); return; }
      AR.ramp(inst.audio.fade.gain, inst.audio.ctx, 0, f);
      inst.stopTimer = setTimeout(() => cleanupAudio(inst), f * 1000 + 50);
    } else {
      inst.state = 'stopping';
      api.send('output-cmd', { cmd: { cmd: 'stop', id: inst.id, fade: f } });
      // safety net if the output window is gone
      setTimeout(() => { if (active.has(inst.id) && !outputOpen) { active.delete(inst.id); renderActive(); } }, f * 1000 + 500);
    }
    renderActive();
  }

  function stopTarget(target, fade) {
    if (target === 'all') { stopAll(fade); return; }
    for (const inst of [...active.values()]) {
      if (target === 'audio' && inst.kind !== 'audio') continue;
      if (target === 'visual' && inst.kind !== 'visual') continue;
      if (target !== 'audio' && target !== 'visual' && inst.cue.id !== target) continue;
      stopInst(inst, fade);
    }
  }

  function stopAll(fade, instant) {
    cancelFollows();
    const f = instant ? 0 : (fade == null ? settings.stopFade : fade);
    for (const inst of [...active.values()]) stopInst(inst, f);
    api.send('output-cmd', { cmd: { cmd: 'stopAll', fade: f, instant: !!instant } });
    if (pausedAll) setPausedAll(false);
  }

  function setPausedAll(v) {
    pausedAll = v;
    for (const inst of active.values()) {
      if (inst.kind === 'audio' && inst.state !== 'stopping' && inst.state !== 'loading') {
        if (v) { inst.el.pause(); inst.state = 'paused'; } else { inst.el.play().catch(() => {}); inst.state = 'playing'; }
      }
    }
    api.send('output-cmd', { cmd: { cmd: v ? 'pauseAll' : 'resumeAll' } });
    $('#pauseBtn').classList.toggle('active', v);
    $('#pauseBtn').textContent = v ? '▶ Resume' : '❚❚ Pause';
    renderActive();
  }

  function toggleInstPause(inst) {
    if (inst.kind === 'audio') {
      if (inst.el.paused) { inst.el.play().catch(() => {}); inst.state = 'playing'; }
      else { inst.el.pause(); inst.state = 'paused'; }
    } else {
      api.send('output-cmd', { cmd: { cmd: inst.paused ? 'resume' : 'pause', id: inst.id } });
    }
    renderActive();
  }

  function setMaster(v) {
    show.masterVolume = Math.max(0, Math.min(100, Math.round(v)));
    $('#masterVol').value = show.masterVolume;
    $('#masterVal').textContent = show.masterVolume;
    const mf = $('#mixStrips .strip.master .fader');
    if (mf) { mf.value = show.masterVolume; mf.closest('.strip').querySelector('.st-db').textContent = show.masterVolume; }
    const pm = $('#padMaster');
    if (pm) { pm.value = show.masterVolume; $('#padMasterVal').textContent = show.masterVolume + '%'; }
    for (const inst of active.values()) if (inst.kind === 'audio') setInstVolume(inst);
    api.send('output-cmd', { cmd: { cmd: 'master', value: show.masterVolume } });
  }

  // tick: progress, end points
  function tick() {
    for (const inst of active.values()) {
      if (inst.kind !== 'audio' || !inst.audio) continue;
      const c = inst.cue, el = inst.el;
      const endT = c.endAt > 0 ? c.endAt : el.duration;
      if (c.fadeAtEnd && c.fadeOut > 0 && inst.state === 'playing' && !inst.endFading && isFinite(endT) && endT - el.currentTime <= c.fadeOut) {
        inst.endFading = true;
        AR.ramp(inst.audio.fade.gain, inst.audio.ctx, 0, Math.max(0.05, endT - el.currentTime));
      }
      if (c.endAt > 0 && el.currentTime >= c.endAt && inst.state === 'playing') {
        if (c.loop) { el.currentTime = c.startAt || 0; restartFade(inst); }
        else { el.pause(); finishInst(inst); continue; }
      }
      inst.t = el.currentTime - (c.startAt || 0);
    }
    updateActiveProgress();
    updatePlayingRows();
  }
  setInterval(tick, 100);

  // output window events
  api.on('output-event', (e) => {
    const inst = active.get(e.id);
    switch (e.evt) {
      case 'started':
        if (inst) { if (inst.state !== 'stopping') inst.state = 'playing'; if (e.duration && isFinite(e.duration)) inst.dur = Math.max(0, (inst.cue.endAt > 0 ? inst.cue.endAt : e.duration) - (inst.cue.startAt || 0)) || inst.dur; renderActive(); }
        break;
      case 'progress':
        if (inst) {
          inst.rawT = e.t;
          inst.t = e.t - (inst.cue.type === 'video' ? (inst.cue.startAt || 0) : 0);
          inst.paused = e.paused;
          if (inst.state !== 'stopping' && inst.state !== 'loading') inst.state = e.paused ? 'paused' : 'playing';
        }
        break;
      case 'ended':
        if (inst && inst.followOnEnd) { inst.followOnEnd = false; scheduleFollow(inst.cue, inst.cue.followDelay); }
        break;
      case 'stopped':
        if (inst) { active.delete(e.id); renderActive(); }
        break;
      case 'error':
        if (inst) { toast(`Cue ${inst.cue.number}: ${e.message}`, 'err'); active.delete(e.id); renderActive(); }
        break;
      case 'warning':
        toast(inst ? `Cue ${inst.cue.number}: ${e.message}` : e.message, 'warn');
        break;
      case 'levels':
        outLevels = { l: e.l, r: e.r, outs: e.outs || {}, at: performance.now() };
        break;
    }
  });

  // ------------------------------------------------------------------ meters + mixer
  // Peak meters for everything going out (this window's audio cues plus the
  // output window's video audio), after cue volume, master and mixer faders.
  let outLevels = { l: 0, r: 0, outs: {}, at: 0 };
  const METER_FLOOR = -60;
  const FADER_OFF = -40; // mixer fader at the bottom = off
  let clipped = false;
  const toDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
  const meterPos = (db) => Math.max(0, Math.min(1, (db - METER_FLOOR) / -METER_FLOOR));
  const meterChan = (ch) => ({ ch, bar: ch.querySelector('i'), hold: ch.querySelector('b'), shown: METER_FLOOR, peak: METER_FLOOR, peakAt: 0 });
  const topMeter = ['#meterL', '#meterR'].map(sel => meterChan($(sel)));
  let strips = []; // [{ el, label, master, chans: [L, R] }]

  // Moves one meter channel to level v (linear); vertical meters fill upwards.
  function stepChan(m, v, now, vertical) {
    const db = toDb(v);
    // fast attack, ~20 dB/s release
    m.shown = db >= m.shown ? db : Math.max(db, m.shown - 0.35);
    if (!isFinite(m.shown)) m.shown = METER_FLOOR;
    const rest = (1 - meterPos(m.shown)) * 100;
    m.bar.style.clipPath = vertical ? `inset(${rest}% 0 0 0)` : `inset(0 ${rest}% 0 0)`;
    if (db >= m.peak || now - m.peakAt > 1500) { m.peak = Math.max(db, METER_FLOOR); m.peakAt = now; }
    if (vertical) m.hold.style.bottom = `calc(${meterPos(m.peak) * 100}% - 2px)`;
    else m.hold.style.left = `calc(${meterPos(m.peak) * 100}% - 2px)`;
    m.hold.style.opacity = m.peak > METER_FLOOR ? '1' : '0';
    if (v >= 0.999) { clipped = true; m.ch.classList.add('clip'); }
    return db;
  }

  function drawMeter() {
    const now = performance.now();
    const local = AR.levelsByLabel();
    const remote = outputOpen && now - outLevels.at < 250 ? (outLevels.outs || {}) : {};
    const at = (label) => {
      const a = local[label] || { l: 0, r: 0 }, b = remote[label] || { l: 0, r: 0 };
      return [Math.max(a.l, b.l), Math.max(a.r, b.r)];
    };
    const total = [0, 0];
    for (const label of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const [l, r] = at(label);
      total[0] = Math.max(total[0], l); total[1] = Math.max(total[1], r);
    }
    let top = -Infinity;
    total.forEach((v, i) => { top = Math.max(top, stepChan(topMeter[i], v, now, false)); });
    const read = $('#meterDb');
    read.textContent = isFinite(top) && top > METER_FLOOR ? `${top.toFixed(1)} dB` : '-∞ dB';
    read.classList.toggle('clip', clipped);
    read.classList.toggle('hot', !clipped && top > -6);
    for (const st of strips) {
      const vals = st.master ? total : at(st.label);
      st.chans.forEach((m, i) => stepChan(m, vals[i], now, true));
    }
    requestAnimationFrame(drawMeter);
  }
  function resetClip() {
    clipped = false;
    [...topMeter, ...strips.flatMap(st => st.chans)].forEach(m => m.ch.classList.remove('clip'));
  }
  $('#meterDb').addEventListener('click', resetClip);

  // Outputs shown in the mixer: the default output plus every device a cue uses.
  function mixerOutputs() {
    const set = new Set(['']);
    if (settings.defaultDevice) set.add(settings.defaultDevice);
    show.cues.forEach(c => { if ((c.type === 'audio' || c.type === 'video') && c.device) set.add(c.device); });
    return [...set];
  }
  const mixOf = (label) => Object.assign({ gain: 0, mute: false }, show.mixer && show.mixer[label]);
  const faderText = (g) => (g <= FADER_OFF ? '-∞' : fmtDb(g));
  const masterVal = () => (show.masterVolume == null ? 100 : show.masterVolume);

  function sendMixer() {
    AR.setMixer(show.mixer);
    api.send('output-cmd', { cmd: { cmd: 'mixer', mixer: show.mixer || {} } });
  }

  function stripHTML(label) {
    const m = mixOf(label);
    const gone = AR.idForLabel(label) === null;
    const name = label || 'Default';
    return `<div class="strip${m.mute ? ' muted' : ''}${gone ? ' gone' : ''}" data-out="${esc(label)}">
        <div class="st-name" title="${esc(name)}${gone ? ' – not connected, plays on the default output' : ''}">${esc(name)}</div>
        <div class="st-body">
          <div class="vmeter" title="Level going out of this output"><div class="vch"><i></i><b></b></div><div class="vch"><i></i><b></b></div></div>
          <input type="range" class="fader" min="${FADER_OFF}" max="6" step="0.5" value="${m.gain}" title="Output level in dB (double-click for 0 dB)">
        </div>
        <div class="st-foot"><span class="st-db">${faderText(m.gain)}</span><button class="st-mute" title="Mute this output">M</button></div>
      </div>`;
  }

  let mixKey = null;
  function renderMixer(force) {
    const outs = mixerOutputs();
    const key = outs.map(l => l + (AR.idForLabel(l) === null ? '!' : '')).join('|');
    if (key === mixKey && !force) return;
    mixKey = key;
    $('#mixStrips').innerHTML = outs.map(stripHTML).join('') + `<div class="strip master" data-out="*master">
        <div class="st-name">Master</div>
        <div class="st-body">
          <div class="vmeter" title="Level going out of all outputs"><div class="vch"><i></i><b></b></div><div class="vch"><i></i><b></b></div></div>
          <input type="range" class="fader" min="0" max="100" step="1" value="${masterVal()}" title="Master volume (double-click for 100)">
        </div>
        <div class="st-foot"><span class="st-db">${masterVal()}</span><button class="st-mute" disabled tabindex="-1">&nbsp;</button></div>
      </div>`;
    strips = $$('#mixStrips .strip').map(el => ({
      el, label: el.dataset.out, master: el.classList.contains('master'),
      chans: $$('.vch', el).map(meterChan)
    }));
  }

  function setOutLevel(label, patch) {
    show.mixer = show.mixer || {};
    const m = Object.assign(mixOf(label), patch);
    if (!m.mute && !m.gain) delete show.mixer[label]; else show.mixer[label] = m;
    const st = strips.find(x => x.label === label);
    if (st) {
      st.el.querySelector('.fader').value = m.gain;
      st.el.querySelector('.st-db').textContent = faderText(m.gain);
      st.el.classList.toggle('muted', !!m.mute);
    }
    sendMixer();
    markDirty();
  }

  const stripOf = (e) => { const el = e.target.closest('.strip'); return el && el.dataset.out; };
  $('#mixStrips').addEventListener('input', (e) => {
    if (!e.target.classList.contains('fader')) return;
    const label = stripOf(e), v = parseFloat(e.target.value);
    if (label === '*master') { setMaster(v); markDirty(); } else setOutLevel(label, { gain: v });
  });
  $('#mixStrips').addEventListener('dblclick', (e) => {
    if (!e.target.classList.contains('fader')) return;
    const label = stripOf(e);
    if (label === '*master') { setMaster(100); markDirty(); } else setOutLevel(label, { gain: 0 });
  });
  $('#mixStrips').addEventListener('click', (e) => {
    const b = e.target.closest('.st-mute');
    if (b && !b.disabled) { const label = stripOf(e); setOutLevel(label, { mute: !mixOf(label).mute }); b.blur(); }
    if (e.target.closest('.vmeter')) resetClip();
  });
  $('#mixStrips').addEventListener('change', (e) => { if (e.target.classList.contains('fader')) e.target.blur(); });

  renderMixer(true);
  requestAnimationFrame(drawMeter);

  api.on('output-state', (s) => {
    outputOpen = !!s.open;
    if (outputOpen) sendMixer();
    $('#outBtn').classList.toggle('on', outputOpen);
    if (!outputOpen) {
      for (const inst of [...active.values()]) if (inst.kind === 'visual') active.delete(inst.id);
      renderActive();
    }
  });

  // ------------------------------------------------------------------ active panel
  function renderActive() {
    const list = $('#activeList');
    const items = [...active.values()];
    $('#activeCount').textContent = items.length ? `${items.length} active` : '';
    if (!items.length) { list.innerHTML = `<div class="active-empty">Nothing playing</div>`; return; }
    list.innerHTML = items.map(i => `
      <div class="act ${i.state}" data-inst="${i.id}">
        <div class="n">${esc(i.cue.number)}</div>
        <div><span class="tag ${i.cue.type}">${TYPES[i.cue.type].tag}</span></div>
        <div class="nm">${esc(displayName(i.cue))}${i.state === 'loading' ? ' <span class="muted">loading…</span>' : ''}${i.state === 'stopping' ? ' <span class="muted">fading out…</span>' : ''}</div>
        <div class="bar"><i></i></div>
        <div class="tm"></div>
        <div class="btns"><button data-a="pause">${i.state === 'paused' ? '▶' : '❚❚'}</button><button data-a="stop" title="Stop with fade (Shift-click: stop now)">■</button></div>
      </div>`).join('');
    updateActiveProgress();
  }

  function updateActiveProgress() {
    $$('.act').forEach(row => {
      const inst = active.get(row.dataset.inst);
      if (!inst) return;
      const d = inst.dur || 0;
      const t = Math.max(0, inst.t || 0);
      row.querySelector('.bar i').style.width = d > 0 ? Math.min(100, (t / d) * 100) + '%' : (inst.cue.type === 'image' ? '100%' : '0');
      const rem = d > 0 ? d - t : 0;
      row.querySelector('.tm').innerHTML = d > 0
        ? `${fmt(t)} / <b>-${fmtTenths(rem)}</b>${inst.cue.loop ? ' ⟲' : ''}`
        : `${fmt(t)}${inst.cue.type === 'image' ? ' · hold' : ''}`;
      row.classList.toggle('paused', inst.state === 'paused');
    });
  }

  $('#activeList').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const inst = active.get(b.closest('.act').dataset.inst);
    if (!inst) return;
    if (b.dataset.a === 'stop') stopInst(inst, e.shiftKey ? 0 : undefined);
    if (b.dataset.a === 'pause') toggleInstPause(inst);
    b.blur();
  });

  // ------------------------------------------------------------------ OSC
  function parseArgs(s) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(s || ''))) {
      if (m[1] !== undefined) out.push(m[1]);
      else if (m[2] !== undefined) out.push(m[2]);
      else {
        const t = m[3];
        if (t === 'true') out.push(true); else if (t === 'false') out.push(false);
        else if (/^-?\d+$/.test(t)) out.push(parseInt(t, 10));
        else if (/^-?\d*\.\d+$/.test(t)) out.push(parseFloat(t));
        else out.push(t);
      }
    }
    return out;
  }

  function sendOscCue(c) {
    if (!c.address || c.address === '/') { toast(`Cue ${c.number}: no OSC address`, 'warn'); return; }
    api.send('osc-send', { host: c.host || '127.0.0.1', port: c.port || 8000, address: c.address, args: parseArgs(c.args) });
  }

  function findCueByNumber(n) {
    const s = String(n).trim();
    let i = show.cues.findIndex(c => String(c.number).trim() === s);
    if (i < 0) { const k = parseInt(s, 10); if (!isNaN(k) && k >= 1 && k <= show.cues.length) i = k - 1; }
    return i;
  }

  function handleOsc(m) {
    flash('#oscPill');
    let a = (m.address || '').toLowerCase();
    a = a.replace(/^\/(showcue|mix16showcue|mix16apps\/playlist|mix16apps)\//, '');
    const arg = m.args && m.args.length ? m.args[0] : undefined;
    const noCue = () => toast(`${m.from === 'http' ? 'Stream Deck' : 'OSC'}: no cue ${arg}`, 'warn');
    switch (a) {
      case 'go':
        if (arg !== undefined && typeof arg !== 'boolean') { const i = findCueByNumber(arg); if (i < 0) return noCue(); setStandby(i, true); }
        go(); break;
      case 'cue': case 'fire': { const i = findCueByNumber(arg); if (i >= 0) fire(show.cues[i], true); else noCue(); break; }
      case 'setgo': case 'standby': case 'set/go': { const i = findCueByNumber(arg); if (i >= 0) setStandby(i, true); else noCue(); break; }
      case 'next': case 'setnext': case 'set/next': setStandby(standby + 1, true); break;
      case 'prev': case 'setprev': case 'set/prev': setStandby(standby - 1, true); break;
      case 'playnext': go(); break;
      case 'stopall': stopAll(); break;
      case 'panic': stopAll(0, true); break;
      case 'pauseall': setPausedAll(true); break;
      case 'resumeall': setPausedAll(false); break;
      case 'master': case 'setmaster': if (typeof arg === 'number') setMaster(arg <= 1 && arg % 1 !== 0 ? arg * 100 : arg); break;
      default: break;
    }
  }
  api.on('osc-in', handleOsc);

  let lastFb = null;
  function sendFeedback() {
    if (!settings.fbHost) return;
    const c = show.cues[standby];
    const key = c ? c.id + c.number + displayName(c) : 'end';
    if (key === lastFb) return;
    lastFb = key;
    api.send('osc-send', { host: settings.fbHost, port: settings.fbPort || 53001, address: '/showcue/standby', args: c ? [String(c.number), displayName(c)] : ['', 'End of cue list'] });
  }

  async function applyOsc() {
    if (settings.oscEnabled) oscStatus = await api.invoke('osc-start', settings.oscPort);
    else { await api.invoke('osc-stop'); oscStatus = { ok: false, off: true }; }
    const pill = $('#oscPill');
    pill.classList.toggle('on', !!oscStatus.ok);
    pill.classList.toggle('err', !oscStatus.ok && !oscStatus.off);
    pill.title = oscStatus.ok ? `OSC listening on UDP ${settings.oscPort}` : oscStatus.off ? 'OSC input off' : `OSC error: ${oscStatus.error}`;
    if (!oscStatus.ok && !oscStatus.off) toast(`OSC could not listen on port ${settings.oscPort}: ${oscStatus.error}`, 'warn');
  }

  async function applyHttp() {
    if (settings.httpEnabled) httpStatus = await api.invoke('http-start', settings.httpPort);
    else { await api.invoke('http-stop'); httpStatus = { ok: false, off: true }; }
    if (!httpStatus.ok && !httpStatus.off) toast(`Web control could not use port ${settings.httpPort}: ${httpStatus.error}`, 'warn');
  }

  // ------------------------------------------------------------------ MIDI
  function sigLabel(sig) {
    if (!sig) return '—';
    const [t, ch, n] = sig.split(':');
    const names = { note: 'Note', cc: 'CC', pc: 'Prog' };
    return `${names[t] || t} ${n} · ch ${ch}`;
  }

  async function initMidi() {
    try {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      midiAccess.onstatechange = () => { bindMidi(); updateMidiPill(); if (!$('#settingsModal').classList.contains('hidden')) renderSettings(); };
      bindMidi();
    } catch (e) { midiAccess = null; }
    updateMidiPill();
  }

  function bindMidi() {
    if (!midiAccess) return;
    for (const inp of midiAccess.inputs.values()) {
      const on = settings.midiInput === 'all' || settings.midiInput === inp.name;
      inp.onmidimessage = on ? onMidi : null;
    }
  }

  function updateMidiPill() {
    const pill = $('#midiPill');
    const n = midiAccess ? Array.from(midiAccess.inputs.values()).length : 0;
    pill.classList.toggle('on', n > 0 && settings.midiInput !== 'none');
    pill.title = !midiAccess ? 'MIDI not available' : n ? `MIDI inputs: ${Array.from(midiAccess.inputs.values()).map(i => i.name).join(', ')}` : 'No MIDI inputs connected';
  }

  function onMidi(e) {
    const d = e.data;
    if (!d || d.length < 2) return;
    const st = d[0] & 0xf0, ch = (d[0] & 0x0f) + 1;
    let sig = null, val = null, trigger = false;
    if (st === 0x90 && d[2] > 0) { sig = `note:${ch}:${d[1]}`; trigger = true; }
    else if (st === 0xB0) {
      sig = `cc:${ch}:${d[1]}`; val = d[2];
      const prev = ccLast[sig] == null ? 0 : ccLast[sig];
      trigger = prev < 64 && val >= 64;
      ccLast[sig] = val;
    } else if (st === 0xC0) { sig = `pc:${ch}:${d[1]}`; trigger = true; }
    if (!sig) return;
    flash('#midiPill');

    if (midiLearn) {
      if (midiLearn.action === 'master' && !sig.startsWith('cc:')) { toast('Master volume needs a CC fader or knob', 'warn'); return; }
      settings.midiMap = settings.midiMap.filter(m => !(m.action === midiLearn.action && (m.cueId || null) === (midiLearn.cueId || null)));
      let note = '';
      if (midiLearn.action === 'cue') {
        // One key per pad: a key learned for this cue is taken off any other cue.
        const taken = settings.midiMap.filter(m => m.action === 'cue' && m.sig === sig).map(m => cueById(m.cueId)).filter(Boolean);
        settings.midiMap = settings.midiMap.filter(m => !(m.action === 'cue' && m.sig === sig));
        if (taken.length) note = ` (moved from cue ${taken.map(t => t.number).join(', ')})`;
        const g = settings.midiMap.find(m => m.action !== 'cue' && m.sig === sig);
        if (g) note += ` – note: this key also does ${MIDI_ACTIONS.find(a => a[0] === g.action)[1]}`;
      }
      settings.midiMap.push({ sig, action: midiLearn.action, cueId: midiLearn.cueId || null });
      saveSettings();
      toast(`Learned ${sigLabel(sig)}${note}`);
      midiLearn = null;
      renderPads();
      renderInspector();
      if (!$('#settingsModal').classList.contains('hidden')) renderSettings();
      return;
    }

    for (const m of settings.midiMap) {
      if (m.sig !== sig) continue;
      if (m.action === 'master') { if (val != null) setMaster((val / 127) * 100); continue; }
      if (!trigger) continue;
      runAction(m.action, m.cueId);
    }
  }

  function runAction(action, cueId) {
    switch (action) {
      case 'go': go(); break;
      case 'stop-all': stopAll(); break;
      case 'panic': stopAll(0, true); break;
      case 'pause-all': setPausedAll(!pausedAll); break;
      case 'prev': setStandby(standby - 1, true); break;
      case 'next': setStandby(standby + 1, true); break;
      case 'cue': { const c = cueById(cueId); if (c) padPress(c); break; }
    }
  }

  function sendMidiCue(c) {
    if (!midiAccess) { toast('No MIDI available', 'warn'); return; }
    const outs = Array.from(midiAccess.outputs.values());
    const out = c.port ? outs.find(o => o.name === c.port) : outs[0];
    if (!out) { toast(`Cue ${c.number}: MIDI output ${c.port ? `"${c.port}" ` : ''}not found`, 'warn'); return; }
    const ch = Math.max(1, Math.min(16, c.channel || 1)) - 1;
    const d1 = Math.max(0, Math.min(127, c.data1 | 0)), d2 = Math.max(0, Math.min(127, c.data2 | 0));
    const msg = { note: [0x90 | ch, d1, d2], noteoff: [0x80 | ch, d1, 0], cc: [0xB0 | ch, d1, d2], pc: [0xC0 | ch, d1] }[c.msg];
    try { out.send(msg); } catch (e) { toast(`MIDI send failed: ${e.message}`, 'err'); }
  }

  function flash(sel) {
    const el = $(sel);
    el.classList.add('blink');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('blink'), 120);
  }

  // ------------------------------------------------------------------ settings
  async function renderSettings() {
    const displays = await api.invoke('get-displays');
    const inputs = midiAccess ? Array.from(midiAccess.inputs.values()).map(i => i.name) : [];
    const devs = AR.devices.filter(d => d.deviceId !== 'default');
    const noLabels = devs.length && devs.every(d => !d.label);
    const b = $('#settingsBody');
    b.innerHTML = `
      <h3>Video output</h3>
      <div class="settings-grid">
        <label>Output screen</label>
        <div class="row">
          <select id="sDisplay">${[['', 'Automatic (second screen if connected)'], ...displays.map(d => [d.id, d.label])].map(([v, l]) => `<option value="${v}" ${String(settings.outputDisplay || '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
          <button class="ibtn" id="sOpenOut">${outputOpen ? 'Reopen' : 'Open'}</button>
          <button class="ibtn" id="sIdent">Identify</button>
        </div>
      </div>
      <h3>Audio</h3>
      <div class="settings-grid">
        <label>Default output for new cues</label>
        <select id="sDefDev">${deviceOptions(settings.defaultDevice).map(([v, l]) => `<option value="${esc(v)}" ${v === settings.defaultDevice ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <label>Default channels for new cues</label>
        <div class="row"><select id="sDefRoute"></select><button class="ibtn" id="sTone" title="Plays a short beep on this output and these channels">🔊 Test</button></div>
        <label>Output devices</label>
        <div class="row"><span class="muted">${devs.length} found${noLabels ? ' (names hidden)' : ''}</span><button class="ibtn" id="sUnlock">${noLabels ? 'Show device names' : 'Refresh'}</button></div>
        <label>Stop All fade (s)</label><input type="number" id="sStopFade" min="0" step="0.5" value="${settings.stopFade}">
        <label>Double-GO protection (ms)</label><input type="number" id="sGoProt" min="0" step="50" value="${settings.goProtect}">
      </div>
      <p class="muted">${api.platform === 'darwin'
        ? 'For multichannel interfaces, set the interface up in Audio MIDI Setup (Configure Speakers) so all its outputs are available, then choose channels per cue.'
        : "For multichannel interfaces, set the interface's speaker configuration in Windows Sound settings (e.g. 7.1) so all its outputs are available, then choose channels per cue."}</p>
      <h3>OSC</h3>
      <div class="settings-grid">
        <label>OSC input</label><label class="row" style="color:var(--text)"><input type="checkbox" id="sOscOn" ${settings.oscEnabled ? 'checked' : ''}> Listen for OSC on UDP port <input type="number" id="sOscPort" style="width:90px" min="1" max="65535" value="${settings.oscPort}"></label>
        <label>Status</label><span class="${oscStatus.ok ? '' : 'muted'}">${oscStatus.ok ? `Listening on port ${settings.oscPort}` : oscStatus.off ? 'Off' : `Not listening: ${esc(oscStatus.error || '')}`}</span>
        <label>Feedback to</label><div class="row"><input type="text" id="sFbHost" placeholder="IP address (blank = off)" value="${esc(settings.fbHost)}"><input type="number" id="sFbPort" style="width:90px" value="${settings.fbPort}"></div>
      </div>
      <h3>Stream Deck / web control</h3>
      <div class="settings-grid">
        <label>Web control</label><label class="row" style="color:var(--text)"><input type="checkbox" id="sHttpOn" ${settings.httpEnabled ? 'checked' : ''}> Accept commands on port <input type="number" id="sHttpPort" style="width:90px" min="1" max="65535" value="${settings.httpPort}"></label>
        <label>Status</label><span class="${httpStatus.ok ? '' : 'muted'}">${httpStatus.ok ? `On: http://localhost:${settings.httpPort}/go` : httpStatus.off ? 'Off' : `Not working: ${esc(httpStatus.error || '')}`}</span>
      </div>
      <p class="muted">On a Stream Deck, use the <b>Website</b> action with <b>Access in background</b> ticked. Addresses: <code>/go</code>, <code>/cue/3</code> (play cue 3), <code>/go/3</code>, <code>/stop</code>, <code>/panic</code>, <code>/pause</code>, <code>/resume</code>, <code>/next</code>, <code>/prev</code>, <code>/master/80</code>. Only this computer can send them.</p>
      <h3>MIDI control</h3>
      <div class="settings-grid">
        <label>Listen to</label>
        <select id="sMidiIn">${[['all', 'All MIDI inputs'], ['none', 'Off'], ...inputs.map(n => [n, n])].map(([v, l]) => `<option value="${esc(v)}" ${v === settings.midiInput ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <label>Inputs found</label><span class="muted">${midiAccess ? (inputs.length ? esc(inputs.join(', ')) : 'None connected') : 'MIDI not available'}</span>
      </div>
      <table style="margin-top:10px">
        ${MIDI_ACTIONS.map(([a, l]) => {
          const m = settings.midiMap.find(x => x.action === a);
          const learning = midiLearn && midiLearn.action === a;
          return `<tr><td>${l}</td><td class="sig">${m ? esc(sigLabel(m.sig)) : '<span class="muted">—</span>'}</td>
            <td style="text-align:right"><button class="ibtn ${learning ? 'learning' : ''}" data-learn="${a}">${learning ? 'Press a key…' : 'Learn'}</button> ${m ? `<button class="ibtn" data-unlearn="${a}">Clear</button>` : ''}</td></tr>`;
        }).join('')}
        ${settings.midiMap.filter(m => m.action === 'cue').map(m => {
          const c = cueById(m.cueId);
          return c ? `<tr><td>Fire cue ${esc(c.number)} – ${esc(displayName(c))}</td><td class="sig">${esc(sigLabel(m.sig))}</td><td style="text-align:right"><button class="ibtn" data-unlearn-cue="${m.cueId}">Clear</button></td></tr>` : '';
        }).join('')}
      </table>
      <div class="settings-grid" style="margin-top:10px">
        <label>Pressing a playing pad</label>
        <select id="sPadToggle"><option value="1" ${settings.padToggle ? 'selected' : ''}>Stops it (fades out)</option><option value="0" ${settings.padToggle ? '' : 'selected'}>Plays it again on top</option></select>
      </div>
      <p class="muted">MIDI mappings are saved on this computer and work with any show. Per-cue triggers are set in the cue's Follow section, or with MIDI Learn in the Pads view. The pad setting also applies to a cue's MIDI key.</p>
      <h3>Updates</h3>
      <div class="settings-grid">
        <label>Installed version</label><span>${esc(appVersion || '–')}</span>
        <label>Automatic updates</label><label class="row" style="color:var(--text)"><input type="checkbox" id="sAutoUpd" ${settings.autoUpdate ? 'checked' : ''}> Check for new versions when the app starts and every few hours</label>
        <label>Status</label><div class="row"><span id="updStatus" class="upd-status"></span></div>
        <label></label><div class="row"><button class="ibtn" id="sUpdCheck">Check now</button><button class="ibtn" id="sUpdInstall" style="display:none">Restart &amp; update</button></div>
      </div>
      <p class="muted">Updates download in the background and install when you close the app, or straight away with Restart &amp; update. The app never restarts by itself during a show.</p>`;
    renderUpdate();
    fillRouteSelect($('#sDefRoute'), null, settings.defaultDevice, settings.defaultRoute);
  }

  $('#settingsBody').addEventListener('change', async (e) => {
    const t = e.target;
    switch (t.id) {
      case 'sDisplay': settings.outputDisplay = t.value ? Number(t.value) : null; break;
      case 'sDefDev': settings.defaultDevice = t.value; renderMixer(); fillRouteSelect($('#sDefRoute'), null, settings.defaultDevice, settings.defaultRoute); break;
      case 'sDefRoute': settings.defaultRoute = t.value; break;
      case 'sStopFade': settings.stopFade = Math.max(0, parseFloat(t.value) || 0); break;
      case 'sGoProt': settings.goProtect = Math.max(0, parseInt(t.value, 10) || 0); break;
      case 'sOscOn': settings.oscEnabled = t.checked; saveSettings(); await applyOsc(); renderSettings(); return;
      case 'sOscPort': settings.oscPort = parseInt(t.value, 10) || 53000; saveSettings(); await applyOsc(); renderSettings(); return;
      case 'sHttpOn': settings.httpEnabled = t.checked; saveSettings(); await applyHttp(); renderSettings(); return;
      case 'sHttpPort': settings.httpPort = parseInt(t.value, 10) || 53000; saveSettings(); await applyHttp(); renderSettings(); return;
      case 'sFbHost': settings.fbHost = t.value.trim(); lastFb = null; sendFeedback(); break;
      case 'sFbPort': settings.fbPort = parseInt(t.value, 10) || 53001; lastFb = null; sendFeedback(); break;
      case 'sMidiIn': settings.midiInput = t.value; bindMidi(); updateMidiPill(); break;
      case 'sPadToggle': settings.padToggle = t.value === '1'; break;
      case 'sAutoUpd': settings.autoUpdate = t.checked; saveSettings(); api.send('update-config', { auto: t.checked }); break;
    }
    saveSettings();
  });

  $('#settingsBody').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'sOpenOut') { api.send('output-open', settings.outputDisplay); return; }
    if (b.id === 'sIdent') {
      if (!outputOpen) api.send('output-open', settings.outputDisplay);
      setTimeout(() => api.send('output-cmd', { cmd: { cmd: 'identify' } }), outputOpen ? 0 : 900);
      return;
    }
    if (b.id === 'sUpdCheck') { checkUpdates(); return; }
    if (b.id === 'sUpdInstall') { installUpdate(); return; }
    if (b.id === 'sTone') { const w = await AR.testTone(settings.defaultDevice, settings.defaultRoute); if (w) toast(w, 'warn'); return; }
    if (b.id === 'sUnlock') { await AR.unlockLabels(); renderSettings(); renderInspector(); return; }
    if (b.dataset.learn) {
      midiLearn = midiLearn && midiLearn.action === b.dataset.learn ? null : { action: b.dataset.learn };
      if (midiLearn && !midiAccess) toast('No MIDI available', 'warn');
      renderSettings(); return;
    }
    if (b.dataset.unlearn) { settings.midiMap = settings.midiMap.filter(m => m.action !== b.dataset.unlearn); saveSettings(); renderSettings(); return; }
    if (b.dataset.unlearnCue) { settings.midiMap = settings.midiMap.filter(m => !(m.action === 'cue' && m.cueId === b.dataset.unlearnCue)); saveSettings(); renderSettings(); renderInspector(); }
  });

  function openModal(id) { $(id).classList.remove('hidden'); if (id === '#settingsModal') renderSettings(); }
  function closeModals() { $$('.modal').forEach(m => m.classList.add('hidden')); if (midiLearn && !midiLearn.cueId) midiLearn = null; }
  $$('.modal').forEach(m => m.addEventListener('mousedown', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModals(); }));

  // ------------------------------------------------------------------ files
  function serialize() {
    return JSON.parse(JSON.stringify({ ...show, savedAt: new Date().toISOString() }));
  }

  async function save(saveAs) {
    const p = await api.invoke('show-save', { path: showPath, data: serialize(), saveAs });
    if (!p) return false;
    showPath = p;
    dirty = false;
    api.send('set-dirty', false);
    updateTitle();
    renderShowFile();
    toast('Show saved');
    return true;
  }

  async function confirmDiscard() {
    if (!dirty) return true;
    const r = await api.invoke('confirm', { message: 'Save changes to the current show?', buttons: ['Save', "Don't Save", 'Cancel'] });
    if (r === 2) return false;
    if (r === 0) return save(false);
    return true;
  }

  async function loadShow(p, data) {
    if (!data || !Array.isArray(data.cues)) { toast('That file is not a show file', 'err'); return; }
    stopAll(0, true);
    show = Object.assign(newShow(), data);
    show.cues = data.cues.map(c => Object.assign(defaultsFor(c.type || 'audio'), c));
    if (!Array.isArray(show.folders)) show.folders = [];
    standby = 0;
    normalizeFolders();
    showPath = p;
    missing.clear();
    const resolved = await api.invoke('resolve-media', { showPath: p, cues: show.cues });
    show.cues.forEach(c => {
      if (!(c.id in resolved)) return;
      if (resolved[c.id]) c.file = resolved[c.id]; else missing.add(c.id);
    });
    standby = 0;
    selectedId = show.cues[0] ? show.cues[0].id : null;
    selectedFolderId = null; renamingFolderId = null;
    dirty = false;
    api.send('set-dirty', false);
    $('#showName').value = show.name;
    if (!show.mixer || typeof show.mixer !== 'object') show.mixer = {};
    setMaster(show.masterVolume == null ? 100 : show.masterVolume);
    renderList(); renderInspector(); updateTitle(); renderShowFile();
    renderMixer(true); sendMixer();
    if (missing.size) toast(`${missing.size} media file${missing.size > 1 ? 's are' : ' is'} missing – choose them again in the cue inspector`, 'warn');
  }

  async function newShowCmd() {
    if (!(await confirmDiscard())) return;
    stopAll(0, true);
    show = newShow(); showPath = null; missing.clear(); standby = 0; selectedId = null; selectedFolderId = null;
    dirty = false; api.send('set-dirty', false);
    $('#showName').value = show.name;
    setMaster(100); renderList(); renderInspector(); updateTitle(); renderShowFile();
    renderMixer(true); sendMixer();
  }

  async function openCmd() {
    if (!(await confirmDiscard())) return;
    const r = await api.invoke('show-open-dialog');
    if (r) loadShow(r.path, r.data);
  }

  api.on('show-opened', async ({ path, data }) => {
    if (!(await confirmDiscard())) return;
    loadShow(path, data);
  });

  // ------------------------------------------------------------------ lock
  function setLocked(v) {
    locked = v;
    document.body.classList.toggle('locked', v);
    const b = $('#lockBtn');
    b.classList.toggle('locked', v);
    b.innerHTML = `<i></i>${v ? 'Locked' : 'Edit'}`;
    $('#showName').readOnly = v;
    $$('.cue-row, .folder-row').forEach(r => r.setAttribute('draggable', String(!v)));
    if (wave) wave.refresh();
  }

  // ------------------------------------------------------------------ menu / buttons / keys
  api.on('menu', async (cmd) => {
    switch (cmd) {
      case 'new': newShowCmd(); break;
      case 'open': openCmd(); break;
      case 'save': save(false); break;
      case 'save-as': save(true); break;
      case 'save-and-quit': if (await save(false)) api.send('quit-now'); break;
      case 'add-media': if (!locked) { const f = await api.invoke('pick-media', 'any'); if (f.length) addFiles(f); } break;
      case 'duplicate': duplicateSelected(); break;
      case 'renumber': renumber(); break;
      case 'go': go(); break;
      case 'stop-all': stopAll(); break;
      case 'panic': stopAll(0, true); break;
      case 'pause-all': setPausedAll(!pausedAll); break;
      case 'toggle-lock': setLocked(!locked); break;
      case 'output-open': api.send('output-open', settings.outputDisplay); break;
      case 'output-close': api.send('output-close'); break;
      case 'settings': openModal('#settingsModal'); break;
      case 'help': openModal('#helpModal'); break;
      case 'check-updates': openModal('#settingsModal'); checkUpdates(); break;
    }
  });
  api.on('toast', (m) => toast(m, 'warn'));
  api.on('displays-changed', () => { if (!$('#settingsModal').classList.contains('hidden')) renderSettings(); });

  const blurAfter = (fn) => (e) => { fn(e); e.currentTarget.blur(); };
  $('#goBtn').addEventListener('click', blurAfter(go));
  $('#prevBtn').addEventListener('click', blurAfter(() => setStandby(standby - 1, true)));
  $('#nextBtn').addEventListener('click', blurAfter(() => setStandby(standby + 1, true)));
  $('#pauseBtn').addEventListener('click', blurAfter(() => setPausedAll(!pausedAll)));
  $('#stopBtn').addEventListener('click', blurAfter(() => stopAll()));
  $('#panicBtn').addEventListener('click', blurAfter(() => stopAll(0, true)));
  $('#outBtn').addEventListener('click', blurAfter(() => outputOpen ? api.send('output-close') : api.send('output-open', settings.outputDisplay)));
  $('#lockBtn').addEventListener('click', blurAfter(() => setLocked(!locked)));
  $('#settingsBtn').addEventListener('click', blurAfter(() => openModal('#settingsModal')));
  $('#updPill').addEventListener('click', blurAfter(() => { if (upd.state === 'ready' || upd.state === 'available') installUpdate(); else openModal('#settingsModal'); }));
  $('#upBtn').addEventListener('click', blurAfter(() => moveSelected(-1)));
  $('#downBtn').addEventListener('click', blurAfter(() => moveSelected(1)));
  $('#dupBtn').addEventListener('click', blurAfter(duplicateSelected));
  $('#delBtn').addEventListener('click', blurAfter(deleteSelected));
  $('#folderBtn').addEventListener('click', blurAfter(addFolder));
  $$('.add').forEach(b => b.addEventListener('click', blurAfter(() => addCue(b.dataset.type))));
  $('#masterVol').addEventListener('input', (e) => { setMaster(parseFloat(e.target.value)); markDirty(); });
  $('#masterVol').addEventListener('change', (e) => e.target.blur());
  $('#showName').addEventListener('input', (e) => { show.name = e.target.value; markDirty(); });
  $('#showName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  const insp = $('#inspector');
  insp.addEventListener('input', onInspectorInput);
  insp.addEventListener('change', onInspectorInput);
  insp.addEventListener('click', onInspectorClick);

  // cue list clicks
  const rows = $('#cueRows');
  rows.addEventListener('mousedown', (e) => {
    const fr = e.target.closest('.folder-row');
    if (fr) {
      if (e.target.closest('button, input')) return;
      selectFolder(fr.dataset.folder);
      return;
    }
    const r = e.target.closest('.cue-row');
    if (!r) return;
    const i = indexOf(r.dataset.id);
    select(r.dataset.id);
    setStandby(i);
  });
  rows.addEventListener('click', (e) => {
    const b = e.target.closest('.folder-row button');
    if (!b) return;
    const id = b.closest('.folder-row').dataset.folder;
    b.blur();
    switch (b.dataset.fact) {
      case 'toggle': setFolderCollapsed(id, !folderById(id).collapsed); break;
      case 'standby': standbyFolder(id); break;
      case 'rename': if (!locked) { renamingFolderId = id; renderList(); } break;
      case 'up': moveFolder(id, -1); break;
      case 'down': moveFolder(id, 1); break;
      case 'delete': deleteFolder(id); break;
    }
  });
  rows.addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('f-rename')) return;
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renamingFolderId = null; renderList(); }
  });
  rows.addEventListener('focusout', (e) => {
    if (!e.target.classList.contains('f-rename') || renamingFolderId == null) return;
    renameFolder(e.target.closest('.folder-row').dataset.folder, e.target.value);
  });
  rows.addEventListener('dblclick', (e) => {
    const fr = e.target.closest('.folder-row');
    if (fr) {
      if (!locked && e.target.closest('.f-name')) { renamingFolderId = fr.dataset.folder; renderList(); }
      return;
    }
    const r = e.target.closest('.cue-row');
    if (!r || locked) return;
    const c = cueById(r.dataset.id);
    if (c) renameCue(c, r.querySelector('.name'));
  });

  // pads view
  const padGrid = $('#padGrid');
  const padCue = (el) => { const p = el.closest('.pad'); return p ? cueById(p.dataset.id) : null; };
  const liveInsts = (c) => [...active.values()].filter(i => i.cue.id === c.id && i.state !== 'stopping');
  function setCueVolume(c, v, final) {
    c.volume = Math.max(0, Math.min(100, Math.round(v)));
    const pad = $(`.pad[data-id="${c.id}"]`);
    if (pad) { pad.querySelector('.sp-vol').textContent = c.volume + '%'; pad.querySelector('.sp-fader').value = c.volume; }
    for (const inst of active.values()) if (inst.cue.id === c.id) setInstVolume(inst);
    markDirty();
    refreshRow(c, true);
    if (wave) wave.refresh();
    if (final && c.id === selectedId) renderInspectorInner();
  }
  padGrid.addEventListener('mousedown', (e) => {
    const p = e.target.closest('.pad');
    if (p && !e.target.closest('button')) select(p.dataset.id);
  });
  padGrid.addEventListener('input', (e) => {
    if (e.target.id === 'padMaster') { setMaster(parseFloat(e.target.value)); markDirty(); return; }
    const c = e.target.classList.contains('sp-fader') && padCue(e.target);
    if (c) setCueVolume(c, parseFloat(e.target.value), false);
  });
  padGrid.addEventListener('change', (e) => {
    if (!e.target.classList.contains('sp-fader')) return;
    const c = padCue(e.target);
    if (c) setCueVolume(c, parseFloat(e.target.value), true);
    e.target.blur();
  });
  padGrid.addEventListener('dblclick', (e) => {
    if (e.target.id === 'padMaster') { setMaster(100); markDirty(); return; }
    const tab = e.target.closest('.pad-tab');
    if (tab) { if (folderById(tab.dataset.tab)) renameFolderInline(tab.dataset.tab, tab); return; }
    const fh = e.target.closest('.pad-folder');
    if (fh) { renameFolderInline(fh.dataset.folder, fh.querySelector('.f-name')); return; }
    const nm = e.target.closest('.sp-name');
    if (nm && padCue(nm)) { renameCue(padCue(nm), nm); return; }
    const c = e.target.classList.contains('sp-fader') && padCue(e.target);
    if (c) setCueVolume(c, 100, true);
  });
  padGrid.addEventListener('click', (e) => {
    const tab = e.target.closest('.pad-tab');
    if (tab) { if (padTab !== tab.dataset.tab) { padTab = tab.dataset.tab; renderPads(); } else tab.blur(); return; }
    const c = padCue(e.target);
    if (!c) return;
    const b = e.target.closest('button');
    if (b) b.blur();
    if (b && b.dataset.pact === 'unlearn') {
      settings.midiMap = settings.midiMap.filter(m => !(m.action === 'cue' && m.cueId === c.id));
      saveSettings(); renderPads(); renderInspector();
      return;
    }
    if (padLearn) {
      if (e.target.closest('.sp-fader')) return;
      midiLearn = midiLearn && midiLearn.cueId === c.id ? null : { action: 'cue', cueId: c.id };
      renderPads(); renderInspector();
      return;
    }
    if (!b) return;
    switch (b.dataset.pact) {
      case 'play': padPress(c); break;
      case 'pause': liveInsts(c).forEach(toggleInstPause); break;
      case 'stop': [...active.values()].filter(i => i.cue.id === c.id).forEach(i => stopInst(i, e.shiftKey ? 0 : undefined)); break;
      case 'loop':
        if (locked) return;
        c.loop = !c.loop;
        markDirty(); refreshRow(c);
        if (c.id === selectedId) renderInspectorInner();
        break;
    }
  });
  $$('.view-toggle button').forEach(b => b.addEventListener('click', blurAfter(() => setView(b.dataset.view))));
  $('#padLearnBtn').addEventListener('click', blurAfter(() => setPadLearn(!padLearn)));
  $('#padSmaller').addEventListener('click', blurAfter(() => setPadSize((settings.padSize || 100) - 10)));
  $('#padBigger').addEventListener('click', blurAfter(() => setPadSize((settings.padSize || 100) + 10)));
  $('#padSizeVal').addEventListener('dblclick', () => setPadSize(100));
  // Ctrl (Cmd on Mac) + mouse wheel over the pads also resizes them.
  padGrid.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setPadSize((settings.padSize || 100) + (e.deltaY < 0 ? 10 : -10));
  }, { passive: false });
  $('#showFile').addEventListener('dblclick', renameShowFile);

  // drag to reorder
  let dragId = null;
  let dragFolder = null;
  const clearDragMarks = () => $$('.cue-row.dragover, .folder-row.dragover').forEach(x => x.classList.remove('dragover'));
  rows.addEventListener('dragstart', (e) => {
    const fr = e.target.closest('.folder-row');
    if (fr && !locked && !e.target.closest('input')) {
      dragFolder = fr.dataset.folder;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-folder', dragFolder);
      return;
    }
    const r = e.target.closest('.cue-row');
    if (!r || locked) { e.preventDefault(); return; }
    dragId = r.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-cue', dragId);
  });
  rows.addEventListener('dragover', (e) => {
    if (!dragId && !dragFolder) return;
    e.preventDefault();
    clearDragMarks();
    const r = e.target.closest(dragFolder ? '.folder-row' : '.cue-row, .folder-row');
    if (r) r.classList.add('dragover');
  });
  rows.addEventListener('drop', (e) => {
    if (!dragId && !dragFolder) return;
    e.preventDefault();
    e.stopPropagation();
    clearDragMarks();
    const fr = e.target.closest('.folder-row');
    if (dragFolder) {
      // Dropping a folder onto another folder places it before that one; empty space = end.
      const id = dragFolder; dragFolder = null;
      const from = show.folders.findIndex(f => f.id === id);
      const [f] = show.folders.splice(from, 1);
      const at = fr ? show.folders.findIndex(x => x.id === fr.dataset.folder) : -1;
      show.folders.splice(at >= 0 ? at : show.folders.length, 0, f);
      normalizeFolders(); markDirty(); renderList();
      return;
    }
    const id = dragId; dragId = null;
    // Dropping onto a folder bar puts the cue at the end of that folder.
    if (fr) { moveCueToFolder(id, fr.dataset.folder); return; }
    const r = e.target.closest('.cue-row');
    if (r) {
      const t = cueById(r.dataset.id);
      if (groupOf(t) !== groupOf(cueById(id))) { moveCueToFolder(id, groupOf(t), t.id); return; }
    }
    const from = indexOf(id);
    // Dropping onto a row places the cue before that row; empty space = end of list.
    if (!r && show.folders.length) { moveCueToFolder(id, show.folders[show.folders.length - 1].id); return; }
    const before = r ? indexOf(r.dataset.id) : show.cues.length;
    const to = Math.min(show.cues.length - 1, before > from ? before - 1 : before);
    if (from >= 0) moveCue(from, Math.max(0, to));
  });
  rows.addEventListener('dragend', () => { dragId = null; dragFolder = null; clearDragMarks(); });

  // file drop from Explorer
  const list = $('#cuelist');
  let dropDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  list.addEventListener('dragenter', (e) => { if (!hasFiles(e) || locked) return; dropDepth++; list.classList.add('drop'); });
  list.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dropDepth = Math.max(0, dropDepth - 1); if (!dropDepth) list.classList.remove('drop'); });
  list.addEventListener('dragover', (e) => { if (hasFiles(e) && !locked) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  list.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropDepth = 0; list.classList.remove('drop');
    if (locked) return;
    const paths = Array.from(e.dataTransfer.files).map(f => api.pathForFile(f)).filter(Boolean);
    if (paths.length) addFiles(paths);
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (wave && !e.ctrlKey && !e.metaKey && !e.altKey && wave.handleKey(e)) { e.preventDefault(); return; }
    const t = e.target;
    const typing = t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['checkbox', 'range', 'button'].includes(t.type)) || t.tagName === 'SELECT');
    if (e.key === 'Escape' && !$$('.modal').every(m => m.classList.contains('hidden'))) { closeModals(); return; }
    if (e.key === 'Escape' && padLearn) { e.preventDefault(); setPadLearn(false); return; }
    if (typing) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case ' ': case 'Enter':
        e.preventDefault();
        if (!e.repeat) go();
        break;
      case 'Escape':
        e.preventDefault();
        if (e.shiftKey) stopAll(0, true); else stopAll();
        break;
      case 'ArrowDown': e.preventDefault(); setStandby(standby + 1, true); break;
      case 'ArrowUp': e.preventDefault(); setStandby(standby - 1, true); break;
      case 'p': case 'P': e.preventDefault(); setPausedAll(!pausedAll); break;
      case 'Delete': case 'Backspace': if (!locked) { e.preventDefault(); deleteSelected(); } break;
    }
  });

  // clock
  setInterval(() => {
    const d = new Date();
    $('#clock').textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  }, 500);

  // device changes
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', async () => { await AR.refreshDevices(); renderInspector(); renderMixer(); });

  // ------------------------------------------------------------------ start
  // ------------------------------------------------------------------ updates
  function updText() {
    switch (upd.state) {
      case 'checking': return 'Checking for updates…';
      case 'none': return `You have the latest version (${appVersion})`;
      case 'downloading': return `Downloading version ${upd.version || ''}… ${upd.percent || 0}%`;
      case 'ready': return `Version ${upd.version} is ready – installs when you close the app`;
      case 'available': return `Version ${upd.version} is available – click Download to get the new installer`;
      case 'error': return `Couldn't check for updates: ${upd.message}`;
      case 'unavailable': return upd.message;
      default: return settings.autoUpdate ? 'Waiting to check…' : 'Automatic checks are off';
    }
  }

  function renderUpdate() {
    const pill = $('#updPill');
    const showPill = upd.state === 'downloading' || upd.state === 'ready' || upd.state === 'available';
    pill.classList.toggle('hidden', !showPill);
    pill.classList.toggle('ready', upd.state === 'ready' || upd.state === 'available');
    pill.querySelector('span').textContent = upd.state === 'ready' ? 'Update ready' : upd.state === 'available' ? `Get ${upd.version}` : `Update ${upd.percent || 0}%`;
    pill.title = upd.state === 'ready' ? `Version ${upd.version} downloaded – click to restart and install` : `Downloading version ${upd.version || ''}`;
    const st = $('#updStatus');
    if (st) { st.textContent = updText(); st.classList.toggle('err', upd.state === 'error'); }
    const ib = $('#sUpdInstall');
    if (ib) { ib.style.display = upd.state === 'ready' || upd.state === 'available' ? '' : 'none'; ib.textContent = upd.state === 'available' ? 'Download' : 'Restart & update'; }
    const cb = $('#sUpdCheck');
    if (cb) cb.disabled = upd.state === 'checking' || upd.state === 'downloading';
  }

  function checkUpdates() {
    upd = { ...upd, state: upd.state === 'ready' ? 'ready' : 'checking' };
    renderUpdate();
    api.invoke('update-check').catch(() => {});
  }

  async function installUpdate() {
    if (upd.state === 'available') { api.invoke('update-install'); return; }
    if (upd.state !== 'ready') return;
    const playing = [...active.values()].some(i => i.state !== 'stopping');
    const msg = playing ? 'Cues are playing. Restart now to install the update? Playback will stop.' : `Restart now to install version ${upd.version}?`;
    const r = await api.invoke('confirm', { message: msg, detail: 'The app reopens by itself after updating (about 10–20 seconds).', buttons: ['Restart & update', 'Later'] });
    if (r !== 0) return;
    if (dirty) {
      const s = await api.invoke('confirm', { message: 'Save changes to this show first?', buttons: ['Save', "Don't Save", 'Cancel'] });
      if (s === 2) return;
      if (s === 0 && !(await save(false))) return;
      if (s === 1) { dirty = false; api.send('set-dirty', false); }
    }
    stopAll(0, true);
    await api.invoke('update-install');
  }

  api.on('update-status', (st) => {
    upd = st || { state: 'idle' };
    renderUpdate();
    if (upd.state === 'ready' && announcedReady !== upd.version) {
      announcedReady = upd.version;
      toast(`Update ${upd.version} downloaded – it installs when you close the app. Click “Update ready” to install now.`);
    }
    if (upd.state === 'available' && announcedReady !== upd.version) {
      announcedReady = upd.version;
      toast(`Version ${upd.version} is available. Click “Get ${upd.version}” to download it.`);
    }
    if (upd.manual && upd.state === 'none') toast(`You have the latest version (${appVersion})`);
    if (upd.manual && (upd.state === 'error' || upd.state === 'unavailable')) toast(updText(), 'warn');
  });

  function initWave() {
    if (!window.WaveEditor) return;
    wave = window.WaveEditor.init({
      api, toast,
      isLocked: () => locked,
      isMissing: (c) => missing.has(c.id),
      getVolume: (c) => cueLevel(c) * master(),
      getPlayhead: (cueId) => {
        let pos = null;
        for (const inst of active.values()) {
          if (inst.cue.id !== cueId || inst.state === 'stopping' || inst.state === 'loading') continue;
          pos = inst.kind === 'audio' ? inst.el.currentTime : (inst.rawT != null ? inst.rawT : null);
        }
        return pos;
      },
      onChange: (c, patch, final) => {
        const onlyDuration = Object.keys(patch).length === 1 && 'duration' in patch;
        Object.assign(c, patch);
        if (!onlyDuration && Object.keys(patch).length) markDirty();
        if ('gain' in patch) for (const inst of active.values()) if (inst.cue.id === c.id) setInstVolume(inst);
        refreshRow(c);
        if (c.id !== selectedId) return;
        for (const k of Object.keys(patch)) {
          const el = $(`#inspector [data-key="${k}"]`);
          if (!el) continue;
          if (el.type === 'checkbox') el.checked = !!patch[k]; else el.value = patch[k];
        }
        if (final && 'endAt' in patch) renderInspectorInner();
      }
    });
  }

  (async function init() {
    initWave();
    setView(settings.view);
    applyPadSize();
    renderShowFile();
    $('#showName').value = show.name;
    await AR.refreshDevices();
    renderList(); renderInspector(); renderActive(); updateTitle();
    renderMixer(true);
    initMidi();
    applyOsc();
    applyHttp();
    try { appVersion = await api.invoke('get-version'); } catch (e) {}
    api.send('update-config', { auto: settings.autoUpdate });
  })();
})();
