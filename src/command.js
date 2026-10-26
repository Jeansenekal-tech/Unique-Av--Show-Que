// Turns an OSC address (+ arguments) or a web-control path into a show command.
// Shared by the main process (web control) and the window (OSC and web control).
//
// Accepted forms, all case-insensitive, with or without the /showcue prefix:
//   /showcue/cue 3        (number as an OSC argument)
//   /showcue/cue/3        (number in the address – easiest in Companion)
//   "/showcue/cue 3"      (number after a space in the address)
//   /showcue/cue/3/stop   /cue/3/pause   /cue/3/resume   /cue/3/volume 80
//   /showcue/stop         (all)   /showcue/stop/3 (one cue)   – same for pause / resume
//   /showcue/master 80    /showcue/master 0.8 (0–1 floats are scaled to 0–100)
//   Companion-style buttons: /showcue/cue/3 + 1 plays, + 0 (release) is ignored
(function (root) {
  const PREFIXES = ['showcue', 'mix16showcue', 'mix16apps', 'playlist'];
  const CUE_ACTIONS = { play: 'play', start: 'play', go: 'play', fire: 'play', stop: 'stop', pause: 'pause', resume: 'resume', volume: 'volume', vol: 'volume' };
  const SIMPLE = {
    next: 'next', setnext: 'next', prev: 'prev', previous: 'prev', setprev: 'prev',
    playnext: 'go', stopall: 'stopall', panic: 'panic', pauseall: 'pauseall', resumeall: 'resumeall'
  };

  const isBlank = (v) => v === undefined || v === null || v === '' || typeof v === 'boolean';
  const asNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(v) ? Number(v) : NaN);
  // Volumes: 0–100, or 0–1 when sent as a float / decimal text.
  function level(v, type) {
    const n = asNumber(v);
    if (isNaN(n)) return null;
    const unit = (type === 'f' || type === 'd' || (typeof v === 'string' && v.includes('.'))) && n >= 0 && n <= 1;
    return Math.max(0, Math.min(100, unit ? n * 100 : n));
  }

  // Button controllers (Companion, TouchOSC…) send 1 on press and 0 on release
  // as an OSC argument: a 0/1 (or true/false) argument is read as that press,
  // unless the command still needs a number (a cue or a volume).
  const pressLike = (v) => typeof v === 'boolean' || v === 0 || v === 1;
  const released = (v) => v === 0 || v === false;

  function parse(address, args, types) {
    const raw = String(address || '').trim();
    if (!raw) return null;
    const words = raw.split(/\s+/);
    const parts = words[0].toLowerCase().split('/').filter(Boolean);
    while (parts.length && PREFIXES.includes(parts[0])) parts.shift();
    if (parts[0] === 'set' && parts[1]) parts.splice(0, 2, 'set' + parts[1]);
    if (!parts.length) return null;
    const head = parts[0];
    // Numbers and words in the address (after "/" or a space) …
    const pv = [...parts.slice(1), ...words.slice(1)];
    // … and the OSC arguments, kept separate so 0/1 can mean released/pressed.
    const av = (args || []).filter(v => v !== null && v !== undefined && v !== '');
    const at = (types || '').split('').filter(t => t !== 'N');
    const RELEASE = { cmd: 'release' };

    const volume = (cue, v, t) => {
      const lv = level(v, t);
      return lv === null || isBlank(cue) ? null : { cmd: 'cue', cue: String(cue), action: 'volume', value: lv };
    };

    if (SIMPLE[head]) return av.length && released(av[0]) ? RELEASE : { cmd: SIMPLE[head] };
    switch (head) {
      case 'go': {
        if (!isBlank(pv[0])) return av.length && released(av[0]) ? RELEASE : { cmd: 'go', cue: String(pv[0]) };
        if (!av.length || pressLike(av[0])) return av.length && released(av[0]) ? RELEASE : { cmd: 'go' };
        return { cmd: 'go', cue: String(av[0]) };
      }
      case 'cue': case 'fire': case 'play': {
        // The cue number: from the address, else the first argument.
        let cue = pv[0], rest = pv.slice(1), arg = av, argT = at;
        if (isBlank(cue)) { cue = av[0]; arg = av.slice(1); argT = at.slice(1); }
        if (isBlank(cue)) return null;
        const word = rest.length ? String(rest[0]).toLowerCase() : 'play';
        const action = CUE_ACTIONS[word];
        if (!action) return null;
        if (action === 'volume') return rest.length > 1 ? volume(cue, rest[1], 's') : volume(cue, arg[0], argT[0]);
        if (arg.length && released(arg[0])) return RELEASE;
        return { cmd: 'cue', cue: String(cue), action };
      }
      case 'stop': case 'pause': case 'resume': {
        if (!isBlank(pv[0])) return av.length && released(av[0]) ? RELEASE : { cmd: 'cue', cue: String(pv[0]), action: head };
        if (!av.length || pressLike(av[0])) return av.length && released(av[0]) ? RELEASE : { cmd: head + 'all' };
        return { cmd: 'cue', cue: String(av[0]), action: head };
      }
      case 'volume': {
        if (!isBlank(pv[0])) return pv.length > 1 ? volume(pv[0], pv[1], 's') : volume(pv[0], av[0], at[0]);
        return volume(av[0], av[1], at[1]);
      }
      case 'setgo': case 'standby': {
        if (!isBlank(pv[0])) return av.length && released(av[0]) ? RELEASE : { cmd: 'standby', cue: String(pv[0]) };
        return isBlank(av[0]) ? null : { cmd: 'standby', cue: String(av[0]) };
      }
      case 'master': case 'setmaster': {
        const v = !isBlank(pv[0]) ? level(pv[0], 's') : level(av[0], at[0]);
        return v === null ? null : { cmd: 'master', value: v };
      }
      default: return null;
    }
  }

  function describe(c) {
    if (!c) return '';
    switch (c.cmd) {
      case 'release': return 'button released (ignored)';
      case 'go': return c.cue ? `GO from cue ${c.cue}` : 'GO';
      case 'cue': return c.action === 'volume' ? `Cue ${c.cue} volume ${Math.round(c.value)}` : `Cue ${c.cue} ${c.action}`;
      case 'standby': return `Standby cue ${c.cue}`;
      case 'master': return `Master ${Math.round(c.value)}`;
      default: return { next: 'Next', prev: 'Previous', stopall: 'Stop all', panic: 'Panic', pauseall: 'Pause all', resumeall: 'Resume all' }[c.cmd] || c.cmd;
    }
  }

  const api = { parse, describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShowCommand = api;
})(typeof window !== 'undefined' ? window : this);
