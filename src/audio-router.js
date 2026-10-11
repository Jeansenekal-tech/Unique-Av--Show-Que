// Shared audio routing: one AudioContext per output device, with each cue
// routed to a stereo pair or a single channel of that device.
(function () {
  const ctxs = new Map();
  let devices = []; // [{deviceId,label}]

  async function refreshDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      devices = all.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'communications');
    } catch (e) { devices = []; }
    return devices;
  }

  async function unlockLabels() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
    } catch (e) { /* no microphone or permission denied; labels may stay generic */ }
    return refreshDevices();
  }

  function idForLabel(label) {
    if (!label) return '';
    const d = devices.find(x => x.label === label);
    return d ? d.deviceId : null; // null = device not present
  }

  async function ctxFor(deviceId) {
    const key = deviceId || 'default';
    let c = ctxs.get(key);
    if (!c) {
      const opts = { latencyHint: 'interactive' };
      if (deviceId && deviceId !== 'default') opts.sinkId = deviceId;
      try { c = new AudioContext(opts); } catch (e) {
        c = new AudioContext({ latencyHint: 'interactive' });
        if (deviceId && c.setSinkId) { try { await c.setSinkId(deviceId); } catch (e2) {} }
      }
      const d = c.destination;
      d.channelCount = d.maxChannelCount;
      d.channelCountMode = 'explicit';
      d.channelInterpretation = 'discrete';
      ctxs.set(key, c);
    }
    if (c.state === 'suspended') { try { await c.resume(); } catch (e) {} }
    return c;
  }

  async function channelCount(label) {
    const id = idForLabel(label);
    if (id === null) return 0;
    const c = await ctxFor(id);
    return c.destination.maxChannelCount;
  }

  // route: "1-2", "3-4" … (stereo pair) or "m3" (mono on channel 3)
  function parseRoute(route) {
    if (!route) return { mono: false, start: 0 };
    if (route[0] === 'm') return { mono: true, start: Math.max(0, parseInt(route.slice(1), 10) - 1) };
    return { mono: false, start: Math.max(0, parseInt(route.split('-')[0], 10) - 1) };
  }

  // Connects a media element. Returns { fade, vol, ctx, warning, disconnect }.
  async function connect(el, deviceLabel, route) {
    let warning = '';
    let id = idForLabel(deviceLabel);
    if (id === null) { warning = `Output "${deviceLabel}" not found – using default output`; id = ''; }
    const ctx = await ctxFor(id);
    const n = ctx.destination.channelCount;
    let { mono, start } = parseRoute(route);
    const needed = mono ? start + 1 : start + 2;
    if (needed > n) {
      warning = warning || `Channels ${route} not available on this output (${n} ch) – using 1-2`;
      start = 0; mono = false;
    }

    const src = ctx.createMediaElementSource(el);
    const fade = ctx.createGain();
    const vol = ctx.createGain();
    // Force stereo so mono files play on both sides of a pair.
    fade.channelCount = 2; fade.channelCountMode = 'explicit'; fade.channelInterpretation = 'speakers';
    src.connect(fade); fade.connect(vol);
    const merger = ctx.createChannelMerger(n);
    const nodes = [src, fade, vol, merger];

    if (mono) {
      const down = ctx.createGain();
      down.channelCount = 1; down.channelCountMode = 'explicit'; down.channelInterpretation = 'speakers';
      vol.connect(down); down.connect(merger, 0, start);
      nodes.push(down);
    } else if (n === 1) {
      const down = ctx.createGain();
      down.channelCount = 1; down.channelCountMode = 'explicit'; down.channelInterpretation = 'speakers';
      vol.connect(down); down.connect(merger, 0, 0);
      nodes.push(down);
    } else {
      const split = ctx.createChannelSplitter(2);
      vol.connect(split);
      split.connect(merger, 0, start);
      split.connect(merger, 1, start + 1);
      nodes.push(split);
    }
    merger.connect(ctx.destination);

    return {
      ctx, fade, vol, warning,
      disconnect() { nodes.forEach(nd => { try { nd.disconnect(); } catch (e) {} }); }
    };
  }

  function ramp(param, ctx, target, seconds) {
    const now = ctx.currentTime;
    const cur = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(cur, now);
    if (seconds > 0) param.linearRampToValueAtTime(target, now + seconds);
    else param.setValueAtTime(target, now);
  }

  function routeOptions(maxCh) {
    const opts = [];
    const n = Math.max(2, maxCh || 16);
    for (let i = 1; i < n; i += 2) opts.push({ value: `${i}-${i + 1}`, label: `Ch ${i}-${i + 1} (stereo)` });
    for (let i = 1; i <= n; i++) opts.push({ value: `m${i}`, label: `Ch ${i} (mono)` });
    return opts;
  }

  window.AudioRouter = { refreshDevices, unlockLabels, idForLabel, connect, ramp, channelCount, routeOptions, get devices() { return devices; } };
})();
