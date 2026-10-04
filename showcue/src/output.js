// Output window: plays video and image cues full screen.
(function () {
  const stage = document.getElementById('stage');
  const layers = new Map(); // id -> layer
  let master = 1;
  let z = 1;

  const emit = (evt) => window.api.send('output-event', evt);

  function setOpacity(el, value, seconds) {
    el.style.transition = `opacity ${Math.max(0, seconds)}s linear`;
    // force style flush so the transition runs
    void el.offsetWidth;
    el.style.opacity = String(value);
  }

  function removeLayer(L, reason) {
    if (!layers.has(L.id)) return;
    layers.delete(L.id);
    clearTimeout(L.holdTimer);
    clearTimeout(L.removeTimer);
    if (L.video) { try { L.video.pause(); } catch (e) {} L.video.removeAttribute('src'); L.video.load(); }
    if (L.audio) L.audio.disconnect();
    L.el.remove();
    emit({ evt: 'stopped', id: L.id, reason });
  }

  function stopLayer(L, fade) {
    if (!L || L.stopping) return;
    L.stopping = true;
    const f = fade == null ? L.fadeOut : fade;
    setOpacity(L.el, 0, f);
    if (L.audio) window.AudioRouter.ramp(L.audio.fade.gain, L.audio.ctx, 0, f);
    L.removeTimer = setTimeout(() => removeLayer(L, 'stopped'), f * 1000 + 60);
  }

  async function play(c) {
    // c: { id, cueId, type, url, volume, fadeIn, fadeOut, loop, startAt, endAt, device, route, fit, hold, replace, holdLast }
    if (layers.has(c.id)) removeLayer(layers.get(c.id), 'replaced');
    if (c.replace !== false) {
      for (const L of layers.values()) stopLayer(L, Math.max(c.fadeIn || 0, 0.05));
    }
    const L = { id: c.id, cueId: c.cueId, type: c.type, fadeOut: c.fadeOut || 0, cfg: c, stopping: false };
    let el;
    if (c.type === 'image') {
      el = document.createElement('img');
      el.src = c.url;
    } else {
      el = document.createElement('video');
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.playsInline = true;
      el.src = c.url;
      L.video = el;
    }
    el.className = 'layer';
    el.style.objectFit = c.fit || 'contain';
    el.style.zIndex = String(++z);
    stage.appendChild(el);
    layers.set(c.id, L);
    L.el = el;

    try {
      if (L.video) {
        await new Promise((res, rej) => {
          el.addEventListener('loadedmetadata', res, { once: true });
          el.addEventListener('error', () => rej(new Error('Cannot play this video file (codec not supported?)')), { once: true });
        });
        if (c.startAt > 0) el.currentTime = c.startAt;
        L.audio = await window.AudioRouter.connect(el, c.device, c.route);
        if (L.audio.warning) emit({ evt: 'warning', id: c.id, message: L.audio.warning });
        L.audio.vol.gain.value = (c.volume / 100) * master;
        L.audio.fade.gain.value = c.fadeIn > 0 ? 0 : 1;
        el.addEventListener('ended', () => onEnd(L));
        await el.play();
        if (c.fadeIn > 0) window.AudioRouter.ramp(L.audio.fade.gain, L.audio.ctx, 1, c.fadeIn);
      } else {
        await new Promise((res, rej) => {
          if (el.complete && el.naturalWidth) return res();
          el.addEventListener('load', res, { once: true });
          el.addEventListener('error', () => rej(new Error('Cannot load this image')), { once: true });
        });
        if (c.hold > 0) L.holdTimer = setTimeout(() => { stopLayer(L); emit({ evt: 'ended', id: c.id }); }, c.hold * 1000);
      }
      if (!layers.has(c.id)) return; // stopped while loading
      setOpacity(el, 1, c.fadeIn || 0);
      L.started = performance.now();
      emit({ evt: 'started', id: c.id, duration: L.video ? el.duration : (c.hold || 0) });
    } catch (e) {
      emit({ evt: 'error', id: c.id, message: e.message });
      removeLayer(L, 'error');
    }
  }

  function onEnd(L) {
    if (!layers.has(L.id) || L.stopping) return;
    const c = L.cfg;
    if (c.loop) {
      L.video.currentTime = c.startAt || 0;
      L.video.play().catch(() => {});
      return;
    }
    emit({ evt: 'ended', id: L.id });
    if (c.holdLast) return; // keep last frame on screen until stopped
    stopLayer(L);
  }

  // Progress + end-point checks
  setInterval(() => {
    for (const L of layers.values()) {
      if (L.video) {
        const v = L.video;
        if (L.cfg.endAt > 0 && v.currentTime >= L.cfg.endAt && !L.stopping) {
          if (L.cfg.loop) { v.currentTime = L.cfg.startAt || 0; }
          else { v.pause(); onEnd(L); }
        }
        emit({ evt: 'progress', id: L.id, t: v.currentTime, dur: L.cfg.endAt > 0 ? L.cfg.endAt : v.duration, paused: v.paused });
      } else if (L.started) {
        emit({ evt: 'progress', id: L.id, t: (performance.now() - L.started) / 1000, dur: L.cfg.hold || 0, paused: false });
      }
    }
  }, 200);

  window.api.on('output-cmd', (c) => {
    switch (c.cmd) {
      case 'play': play(c); break;
      case 'stop': stopLayer(layers.get(c.id), c.fade); break;
      case 'stopAll':
        for (const L of layers.values()) {
          if (c.only === 'video' && L.type !== 'video') continue;
          if (c.only === 'image' && L.type !== 'image') continue;
          if (c.instant) removeLayer(L, 'stopped'); else stopLayer(L, c.fade);
        }
        break;
      case 'clear': for (const L of layers.values()) stopLayer(L, c.fade || 0); break;
      case 'pause': { const L = layers.get(c.id); if (L && L.video) L.video.pause(); break; }
      case 'resume': { const L = layers.get(c.id); if (L && L.video) L.video.play().catch(() => {}); break; }
      case 'pauseAll': for (const L of layers.values()) if (L.video) L.video.pause(); break;
      case 'resumeAll': for (const L of layers.values()) if (L.video && !L.stopping) L.video.play().catch(() => {}); break;
      case 'volume': { const L = layers.get(c.id); if (L && L.audio) { L.cfg.volume = c.volume; L.audio.vol.gain.value = (c.volume / 100) * master; } break; }
      case 'master':
        master = c.value / 100;
        for (const L of layers.values()) if (L.audio) L.audio.vol.gain.value = (L.cfg.volume / 100) * master;
        break;
      case 'identify': {
        const id = document.getElementById('ident');
        id.style.display = 'flex';
        setTimeout(() => { id.style.display = 'none'; }, 2500);
        break;
      }
    }
  });

  document.addEventListener('dblclick', () => {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
  });
})();
