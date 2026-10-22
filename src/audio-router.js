// Shared audio routing: one AudioContext per output device, with each cue
// routed to a stereo pair or a single channel of that device.
(function () {
  const ctxs = new Map();
  const meters = new Map(); // ctx -> { input, analysers: [AnalyserNode], buf }
  const buses = new Map();  // ctx -> { gain: GainNode, label }
  let mixer = {};           // device label ('' = default) -> { gain: dB, mute: bool }
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
      addBus(c, key === 'default' ? '' : labelFor(deviceId));
      addMeter(c);
    }
    if (c.state === 'suspended') { try { await c.resume(); } catch (e) {} }
    return c;
  }

  function labelFor(deviceId) {
    const d = devices.find(x => x.deviceId === deviceId);
    return d ? d.label : '';
  }

  // Output bus per device: every cue on that device goes through its mixer fader.
  function addBus(c, label) {
    const n = c.destination.channelCount;
    const gain = c.createGain();
    gain.channelCount = n; gain.channelCountMode = 'explicit'; gain.channelInterpretation = 'discrete';
    gain.connect(c.destination);
    buses.set(c, { gain, label });
    applyBus(c);
  }

  const dbToGain = (db) => (db <= -40 ? 0 : Math.pow(10, db / 20));

  function applyBus(c) {
    const b = buses.get(c);
    if (!b) return;
    const m = mixer[b.label] || {};
    const target = m.mute ? 0 : dbToGain(m.gain == null ? 0 : m.gain);
    const now = c.currentTime;
    b.gain.gain.cancelScheduledValues(now);
    b.gain.gain.setTargetAtTime(target, now, 0.015);
  }

  function setMixer(m) {
    mixer = m || {};
    for (const c of buses.keys()) applyBus(c);
  }

  // Level tap on everything sent to a device, after cue volume, master and the mixer fader.
  function addMeter(c) {
    const n = c.destination.channelCount;
    const input = buses.get(c).gain;
    const split = c.createChannelSplitter(n);
    input.connect(split);
    const analysers = [];
    for (let i = 0; i < n; i++) {
      const a = c.createAnalyser();
      a.fftSize = 1024;
      split.connect(a, i);
      analysers.push(a);
    }
    meters.set(c, { input, analysers, buf: new Float32Array(1024) });
  }

  // Peak level (linear 0..1+) per output device label. Odd channels count as
  // left, even channels as right; a single-channel device feeds both.
  function levelsByLabel() {
    const out = {};
    for (const [c, m] of meters) {
      if (c.state !== 'running') continue;
      const label = buses.get(c).label;
      const lv = out[label] || (out[label] = { l: 0, r: 0 });
      m.analysers.forEach((a, i) => {
        a.getFloatTimeDomainData(m.buf);
        let p = 0;
        for (let k = 0; k < m.buf.length; k++) { const v = Math.abs(m.buf[k]); if (v > p) p = v; }
        if (m.analysers.length === 1) { lv.l = Math.max(lv.l, p); lv.r = Math.max(lv.r, p); }
        else if (i % 2 === 0) lv.l = Math.max(lv.l, p);
        else lv.r = Math.max(lv.r, p);
      });
    }
    return out;
  }

  // Peak level across all outputs.
  function levels() {
    let l = 0, r = 0;
    for (const v of Object.values(levelsByLabel())) { l = Math.max(l, v.l); r = Math.max(r, v.r); }
    return { l, r };
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

  // Resolves a device label + route to a context and channel layout.
  async function target(deviceLabel, route) {
    let warning = '';
    let id = idForLabel(deviceLabel);
    if (id === null) { await refreshDevices(); id = idForLabel(deviceLabel); } // device list not read yet (output window)
    if (id === null) { warning = `Output "${deviceLabel}" not found – using default output`; id = ''; }
    const ctx = await ctxFor(id);
    const n = ctx.destination.channelCount;
    let { mono, start } = parseRoute(route);
    const needed = mono ? start + 1 : start + 2;
    if (needed > n) {
      warning = warning || `Channels ${route} not available on this output (${n} ch) – using 1-2`;
      start = 0; mono = false;
    }
    return { ctx, n, mono, start, warning };
  }

  // Sends a stereo node to the chosen channels of the device's output bus.
  // Returns the extra nodes created so they can be disconnected later.
  function routeInto(ctx, n, mono, start, node) {
    const merger = ctx.createChannelMerger(n);
    const nodes = [merger];
    if (mono || n === 1) {
      const down = ctx.createGain();
      down.channelCount = 1; down.channelCountMode = 'explicit'; down.channelInterpretation = 'speakers';
      node.connect(down); down.connect(merger, 0, n === 1 ? 0 : start);
      nodes.push(down);
    } else {
      const split = ctx.createChannelSplitter(2);
      node.connect(split);
      split.connect(merger, 0, start);
      split.connect(merger, 1, start + 1);
      nodes.push(split);
    }
    merger.connect(buses.get(ctx).gain);
    return nodes;
  }

  // Connects a media element. Returns { fade, vol, ctx, warning, disconnect }.
  async function connect(el, deviceLabel, route) {
    const { ctx, n, mono, start, warning } = await target(deviceLabel, route);
    const src = ctx.createMediaElementSource(el);
    const fade = ctx.createGain();
    const vol = ctx.createGain();
    // Force stereo so mono files play on both sides of a pair.
    fade.channelCount = 2; fade.channelCountMode = 'explicit'; fade.channelInterpretation = 'speakers';
    src.connect(fade); fade.connect(vol);
    const nodes = [src, fade, vol, ...routeInto(ctx, n, mono, start, vol)];

    return {
      ctx, fade, vol, warning,
      disconnect() { nodes.forEach(nd => { try { nd.disconnect(); } catch (e) {} }); }
    };
  }

  // Plays a short quiet beep on the chosen output and channels so the user can
  // hear which speakers they are. Returns a warning string ('' when fine).
  async function testTone(deviceLabel, route, seconds = 1) {
    const { ctx, n, mono, start, warning } = await target(deviceLabel, route);
    const osc = ctx.createOscillator();
    osc.frequency.value = 1000;
    const env = ctx.createGain();
    env.channelCount = 2; env.channelCountMode = 'explicit'; env.channelInterpretation = 'speakers';
    const t = ctx.currentTime;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.2, t + 0.02);
    env.gain.setValueAtTime(0.2, t + seconds - 0.05);
    env.gain.linearRampToValueAtTime(0, t + seconds);
    osc.connect(env);
    const nodes = [osc, env, ...routeInto(ctx, n, mono, start, env)];
    osc.start(t); osc.stop(t + seconds + 0.05);
    osc.onended = () => nodes.forEach(nd => { try { nd.disconnect(); } catch (e) {} });
    return warning;
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
    for (let i = 1; i < n; i += 2) opts.push({ value: `${i}-${i + 1}`, label: `Outputs ${i} + ${i + 1} (stereo)` });
    for (let i = 1; i <= n; i++) opts.push({ value: `m${i}`, label: `Output ${i} only (mono)` });
    return opts;
  }

  window.AudioRouter = { refreshDevices, unlockLabels, idForLabel, connect, testTone, ramp, channelCount, routeOptions, levels, levelsByLabel, setMixer, dbToGain, get devices() { return devices; } };
})();
