// Waveform trim editor: shows the selected audio/video cue and lets you set
// In/Out points and fades by dragging. Edits are non-destructive (the original
// file is never changed) – they set the cue's Start at / End at / fade times.
(function () {
  'use strict';
  const PEAK_RATE = 100;      // peaks per second
  const DECODE_RATE = 8000;   // decode at a low rate – only the shape is needed
  const MAX_BYTES = 600 * 1024 * 1024;
  const HANDLE_PX = 7;

  const cache = new Map();    // file path -> Promise<{min,max,duration}|{error}>

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
  }
  function parseTime(str) {
    str = String(str || '').trim();
    if (!str) return null;
    const parts = str.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    return parts.reduce((acc, v) => acc * 60 + v, 0);
  }

  async function loadPeaks(api, file) {
    if (cache.has(file)) return cache.get(file);
    const p = (async () => {
      try {
        const res = await fetch(api.mediaURL(file));
        if (!res.ok) throw new Error('File not readable');
        const len = Number(res.headers.get('content-length') || 0);
        if (len > MAX_BYTES) throw new Error('File too large to draw');
        const buf = await res.arrayBuffer();
        const ctx = new OfflineAudioContext(1, 1, DECODE_RATE);
        const audio = await ctx.decodeAudioData(buf);
        const n = Math.max(1, Math.ceil(audio.duration * PEAK_RATE));
        const min = new Float32Array(n), max = new Float32Array(n);
        const chans = [];
        for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
        const per = audio.length / n;
        for (let i = 0; i < n; i++) {
          const a = Math.floor(i * per), b = Math.min(audio.length, Math.floor((i + 1) * per));
          let lo = 0, hi = 0;
          for (const ch of chans) for (let j = a; j < b; j++) { const v = ch[j]; if (v < lo) lo = v; else if (v > hi) hi = v; }
          min[i] = lo; max[i] = hi;
          if (i % 20000 === 19999) await new Promise(r => setTimeout(r, 0)); // keep the UI responsive
        }
        return { min, max, duration: audio.duration };
      } catch (e) {
        cache.delete(file);
        return { error: e.message || 'Could not read audio' };
      }
    })();
    cache.set(file, p);
    return p;
  }

  function init(opts) {
    const { api, onChange, isLocked, getPlayhead, getVolume, toast, isMissing } = opts;
    const panel = document.getElementById('wavePanel');
    const canvas = document.getElementById('waveCanvas');
    const g = canvas.getContext('2d');
    const $ = (s) => panel.querySelector(s);

    let cue = null;
    let peaks = null;          // {min,max,duration}
    let status = '';
    let view = { start: 0, dur: 1 };
    let cursor = 0;
    let drag = null;
    let preview = null;        // {el, stopAt}
    let loadToken = 0;

    const duration = () => (peaks && peaks.duration) || (cue && cue.duration) || 0;
    const inPt = () => Math.max(0, cue.startAt || 0);
    const outPt = () => { const d = duration(); return cue.endAt > 0 ? Math.min(cue.endAt, d || cue.endAt) : d; };

    // ------------------------------------------------------------ show / hide
    async function show(c) {
      const isMedia = c && (c.type === 'audio' || c.type === 'video');
      if (!isMedia) { stopPreview(); cue = null; panel.classList.add('hidden'); document.body.classList.remove('has-wave'); return; }
      const sameFile = cue && cue.id === c.id && cue.file === c.file;
      if (cue && cue.id !== c.id) stopPreview();
      cue = c;
      panel.classList.remove('hidden');
      document.body.classList.add('has-wave');
      if (sameFile && peaks) { syncFields(); draw(); return; }
      peaks = null;
      cursor = inPt();
      fitAll();
      if (!c.file) { status = 'No file chosen'; syncFields(); draw(); return; }
      if (isMissing(c)) { status = 'File is missing'; syncFields(); draw(); return; }
      status = 'Reading waveform…';
      syncFields(); draw();
      const token = ++loadToken;
      const r = await loadPeaks(api, c.file);
      if (token !== loadToken || !cue || cue.id !== c.id) return;
      if (r.error) { status = `No waveform (${r.error}) – you can still set In/Out`; peaks = null; }
      else { status = ''; peaks = r; if (!cue.duration && r.duration) onChange(cue, { duration: r.duration }, false); }
      fitAll(); syncFields(); draw();
    }
    function hide() { show(null); }

    // ------------------------------------------------------------ view
    function fitAll() { const d = duration() || 1; view = { start: 0, dur: d }; }
    function fitCut() {
      const a = inPt(), b = outPt() || duration();
      const pad = Math.max(0.5, (b - a) * 0.04);
      view = { start: Math.max(0, a - pad), dur: Math.max(1, b - a + pad * 2) };
      clampView();
    }
    function clampView() {
      const d = duration() || 1;
      view.dur = Math.min(Math.max(view.dur, 0.5), Math.max(d, 0.5));
      view.start = Math.min(Math.max(0, view.start), Math.max(0, d - view.dur));
    }
    function zoom(factor, centerT) {
      const c = centerT == null ? view.start + view.dur / 2 : centerT;
      const rel = (c - view.start) / view.dur;
      view.dur *= factor;
      clampView();
      view.start = c - rel * view.dur;
      clampView();
      draw();
    }

    // ------------------------------------------------------------ geometry
    function size() {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }
    const RULER = 18;
    const tToX = (t, w) => ((t - view.start) / view.dur) * w;
    const xToT = (x, w) => view.start + (x / w) * view.dur;

    // ------------------------------------------------------------ drawing
    function draw() {
      if (!cue) return;
      const { w, h } = size();
      const top = RULER, wh = h - RULER, mid = top + wh / 2;
      g.clearRect(0, 0, w, h);
      g.fillStyle = '#0d0f13'; g.fillRect(0, 0, w, h);

      // ruler
      g.fillStyle = '#151820'; g.fillRect(0, 0, w, RULER);
      const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
      const step = steps.find(s => (s / view.dur) * w >= 70) || 600;
      g.font = '10px Consolas, monospace'; g.fillStyle = '#8c93a3'; g.strokeStyle = '#2a2f39'; g.lineWidth = 1;
      for (let t = Math.ceil(view.start / step) * step; t <= view.start + view.dur; t += step) {
        const x = Math.round(tToX(t, w)) + 0.5;
        g.beginPath(); g.moveTo(x, RULER - 6); g.lineTo(x, h); g.stroke();
        g.fillText(step < 1 ? fmt(t) : fmt(t).replace(/\.0$/, ''), x + 3, 12);
      }
      g.strokeStyle = '#2a2f39'; g.beginPath(); g.moveTo(0, mid + 0.5); g.lineTo(w, mid + 0.5); g.stroke();

      const a = inPt(), b = outPt();
      const xa = tToX(a, w), xb = tToX(b, w);

      // waveform
      if (peaks) {
        const n = peaks.min.length;
        for (let x = 0; x < w; x++) {
          const t0 = xToT(x, w), t1 = xToT(x + 1, w);
          let i0 = Math.floor(t0 * PEAK_RATE), i1 = Math.max(i0 + 1, Math.floor(t1 * PEAK_RATE));
          if (i0 >= n || i1 <= 0) continue;
          i0 = Math.max(0, i0); i1 = Math.min(n, i1);
          let lo = 0, hi = 0;
          for (let i = i0; i < i1; i++) { if (peaks.min[i] < lo) lo = peaks.min[i]; if (peaks.max[i] > hi) hi = peaks.max[i]; }
          const tm = (t0 + t1) / 2;
          g.fillStyle = tm >= a && tm <= b ? (cue.type === 'video' ? '#b07ce8' : '#4fa8ff') : '#2c3442';
          const y1 = mid - hi * (wh / 2 - 2), y2 = mid - lo * (wh / 2 - 2);
          g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
        }
      } else {
        g.fillStyle = '#8c93a3'; g.font = '13px Segoe UI, sans-serif';
        g.fillText(status || '', 12, mid - 8);
        if (duration()) { g.fillStyle = 'rgba(79,168,255,.12)'; g.fillRect(xa, top, xb - xa, wh); }
      }

      // dim outside the cut
      g.fillStyle = 'rgba(0,0,0,.55)';
      if (xa > 0) g.fillRect(0, top, xa, wh);
      if (xb < w) g.fillRect(xb, top, w - xb, wh);

      // fades
      const fi = cue.fadeIn || 0, fo = cue.fadeOut || 0;
      g.lineWidth = 1.5; g.strokeStyle = '#e5a12a';
      if (fi > 0) {
        g.beginPath(); g.moveTo(xa, top + wh); g.lineTo(tToX(a + fi, w), top + 2); g.stroke();
        handle(tToX(a + fi, w), top + 2, '#e5a12a');
      }
      if (fo > 0) {
        g.setLineDash(cue.fadeAtEnd ? [] : [4, 4]);
        g.beginPath(); g.moveTo(tToX(b - fo, w), top + 2); g.lineTo(xb, top + wh); g.stroke();
        g.setLineDash([]);
        handle(tToX(b - fo, w), top + 2, '#e5a12a');
      }

      // in / out markers
      marker(xa, '#27cf6d', 'IN', true);
      marker(xb, '#ff5a3c', 'OUT', false);

      // cursor
      const xc = tToX(cursor, w);
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(Math.round(xc) + 0.5, top); g.lineTo(Math.round(xc) + 0.5, h); g.stroke(); g.setLineDash([]);

      // live / preview playheads
      const live = getPlayhead(cue.id);
      if (live != null) playhead(tToX(live, w), '#ffffff');
      if (preview) playhead(tToX(preview.el.currentTime, w), '#e5a12a');

      function handle(x, y, col) { g.fillStyle = col; g.fillRect(x - 4, y, 8, 8); }
      function marker(x, col, label, left) {
        g.strokeStyle = col; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, top); g.lineTo(x, h); g.stroke();
        g.fillStyle = col;
        const lw = 26;
        g.fillRect(left ? x : x - lw, top, lw, 14);
        g.fillStyle = '#0d0f13'; g.font = 'bold 10px Segoe UI, sans-serif';
        g.fillText(label, (left ? x : x - lw) + 4, top + 11);
      }
      function playhead(x, col) {
        g.strokeStyle = col; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      }
    }

    // ------------------------------------------------------------ fields
    function syncFields() {
      if (!cue) return;
      const a = inPt(), b = outPt();
      const title = cue.name || api.basename(cue.file) || 'No file';
      $('#waveTitle').textContent = `${cue.number ? 'Cue ' + cue.number + ' · ' : ''}${title}`;
      if (document.activeElement !== $('#waveIn')) $('#waveIn').value = fmt(a);
      if (document.activeElement !== $('#waveOut')) $('#waveOut').value = fmt(b);
      $('#waveLen').textContent = duration() ? fmt(Math.max(0, b - a)) : '–';
      $('#waveFull').textContent = duration() ? fmt(duration()) : '–';
      $('#waveFadeEnd').checked = !!cue.fadeAtEnd;
      $('#wavePrev').textContent = preview ? '■ Stop' : '▶ Preview';
      panel.classList.toggle('locked', isLocked());
    }

    function setPoint(which, t, final) {
      if (!cue || isLocked()) return;
      const d = duration();
      t = Math.round(t * 100) / 100;
      if (which === 'in') {
        const max = (outPt() || d) - 0.1;
        const v = Math.max(0, Math.min(t, max));
        onChange(cue, { startAt: v }, final);
      } else if (which === 'out') {
        const v = Math.max(inPt() + 0.1, d ? Math.min(t, d) : t);
        onChange(cue, { endAt: d && v >= d - 0.01 ? 0 : v }, final);
      } else if (which === 'fadeIn') {
        const v = Math.max(0, Math.min(Math.round((t - inPt()) * 10) / 10, outPt() - inPt()));
        onChange(cue, { fadeIn: v }, final);
      } else if (which === 'fadeOut') {
        const v = Math.max(0, Math.min(Math.round((outPt() - t) * 10) / 10, outPt() - inPt()));
        const patch = { fadeOut: v };
        if (v > 0 && !cue.fadeAtEnd && final && which === 'fadeOut') patch.fadeAtEnd = true;
        onChange(cue, patch, final);
      }
      syncFields(); draw();
    }

    // ------------------------------------------------------------ preview (default output)
    function startPreview(from, to) {
      stopPreview();
      if (!cue || !cue.file || isMissing(cue)) return;
      const el = new Audio(api.mediaURL(cue.file));
      el.volume = Math.max(0, Math.min(1, getVolume(cue)));
      el.currentTime = Math.max(0, from);
      preview = { el, stopAt: to };
      el.addEventListener('ended', stopPreview);
      el.play().catch(e => { toast('Preview failed: ' + e.message, 'err'); stopPreview(); });
      syncFields();
    }
    function stopPreview() {
      if (!preview) return;
      try { preview.el.pause(); } catch (e) {}
      preview.el.removeAttribute('src'); preview.el.load();
      preview = null;
      if (cue) { syncFields(); draw(); }
    }
    function togglePreview() {
      if (preview) { stopPreview(); return; }
      const a = inPt(), b = outPt();
      const from = cursor > a + 0.05 && cursor < b - 0.2 ? cursor : a;
      startPreview(from, b);
    }

    // ------------------------------------------------------------ mouse
    function hit(x, y, w) {
      if (!cue || isLocked()) return null;
      const a = inPt(), b = outPt();
      const cand = [];
      if (y < RULER + 14) {
        if (cue.fadeIn > 0) cand.push(['fadeIn', tToX(a + cue.fadeIn, w)]);
        if (cue.fadeOut > 0) cand.push(['fadeOut', tToX(b - cue.fadeOut, w)]);
      }
      cand.push(['in', tToX(a, w)], ['out', tToX(b, w)]);
      let best = null;
      for (const [k, cx] of cand) { const d = Math.abs(cx - x); if (d <= HANDLE_PX && (!best || d < best.d)) best = { k, d }; }
      return best && best.k;
    }

    canvas.addEventListener('mousedown', (e) => {
      if (!cue) return;
      canvas.focus();
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top, w = r.width;
      const k = hit(x, y, w);
      if (k) drag = { k };
      else { drag = { k: 'cursor' }; cursor = Math.max(0, Math.min(duration(), xToT(x, w))); draw(); }
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, w = r.width;
      if (!drag) {
        if (cue && e.target === canvas) {
          const k = hit(x, e.clientY - r.top, w);
          canvas.style.cursor = k === 'in' || k === 'out' ? 'ew-resize' : k ? 'col-resize' : 'text';
        }
        return;
      }
      const t = Math.max(0, Math.min(duration() || Infinity, xToT(Math.max(0, Math.min(w, x)), w)));
      if (drag.k === 'cursor') { cursor = t; draw(); }
      else setPoint(drag.k, t, false);
    });
    window.addEventListener('mouseup', () => {
      if (drag && drag.k !== 'cursor') onChange(cue, {}, true);
      drag = null;
    });
    canvas.addEventListener('wheel', (e) => {
      if (!cue) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
        zoom(e.deltaY > 0 ? 1.25 : 0.8, xToT(e.clientX - r.left, r.width));
      } else {
        view.start += ((e.deltaX || e.deltaY) / r.width) * view.dur; clampView(); draw();
      }
    }, { passive: false });
    canvas.addEventListener('dblclick', () => { if (cue) startPreview(cursor, outPt()); });

    // ------------------------------------------------------------ buttons / fields
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !cue) return;
      switch (b.dataset.w) {
        case 'setIn': setPoint('in', cursor, true); break;
        case 'setOut': setPoint('out', cursor, true); break;
        case 'preview': togglePreview(); break;
        case 'checkIn': startPreview(inPt(), Math.min(outPt(), inPt() + 5)); break;
        case 'checkOut': startPreview(Math.max(inPt(), outPt() - 5), outPt()); break;
        case 'reset': if (!isLocked()) { onChange(cue, { startAt: 0, endAt: 0 }, true); syncFields(); draw(); } break;
        case 'zin': zoom(0.5); break;
        case 'zout': zoom(2); break;
        case 'fit': fitAll(); draw(); break;
        case 'fitCut': fitCut(); draw(); break;
      }
      b.blur();
    });
    const timeField = (sel, which) => {
      const el = $(sel);
      el.addEventListener('change', () => {
        const t = parseTime(el.value);
        if (t == null) { syncFields(); return; }
        setPoint(which, t, true);
        el.blur();
      });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.dispatchEvent(new Event('change')); });
    };
    timeField('#waveIn', 'in');
    timeField('#waveOut', 'out');
    $('#waveFadeEnd').addEventListener('change', (e) => {
      if (!cue || isLocked()) { syncFields(); return; }
      const patch = { fadeAtEnd: e.target.checked };
      if (e.target.checked && !(cue.fadeOut > 0)) patch.fadeOut = 2;
      onChange(cue, patch, true); syncFields(); draw();
      e.target.blur();
    });

    // Keys while the waveform has focus: I / O set points, ←/→ move cursor.
    function handleKey(e) {
      if (!cue || document.activeElement !== canvas) return false;
      const k = e.key.toLowerCase();
      if (k === 'i') { setPoint('in', cursor, true); return true; }
      if (k === 'o') { setPoint('out', cursor, true); return true; }
      if (k === 'arrowleft' || k === 'arrowright') {
        const step = e.shiftKey ? 1 : 0.1;
        cursor = Math.max(0, Math.min(duration(), cursor + (k === 'arrowleft' ? -step : step)));
        if (cursor < view.start || cursor > view.start + view.dur) { view.start = cursor - view.dur / 2; clampView(); }
        draw(); return true;
      }
      if (k === '+' || k === '=') { zoom(0.5, cursor); return true; }
      if (k === '-') { zoom(2, cursor); return true; }
      return false;
    }

    // ------------------------------------------------------------ loop
    function tick() {
      if (preview && preview.stopAt > 0 && preview.el.currentTime >= preview.stopAt) stopPreview();
      if (cue && (preview || getPlayhead(cue.id) != null || drag)) draw();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    new ResizeObserver(() => draw()).observe(canvas);

    return {
      show, hide, handleKey, stopPreview,
      refresh() { if (cue) { syncFields(); draw(); } },
      get cueId() { return cue && cue.id; }
    };
  }

  window.WaveEditor = { init, parseTime, fmt };
})();
