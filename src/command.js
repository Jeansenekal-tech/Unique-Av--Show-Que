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

  function parse(address, args, types) {
    const raw = String(address || '').trim();
    if (!raw) return null;
    const words = raw.split(/\s+/);
    const parts = words[0].toLowerCase().split('/').filter(Boolean);
    while (parts.length && PREFIXES.includes(parts[0])) parts.shift();
    if (parts[0] === 'set' && parts[1]) parts.splice(0, 2, 'set' + parts[1]);
    if (!parts.length) return null;
    const head = parts[0];
    // Everything after the command: path parts, words after a space, then OSC arguments.
    const vals = [...parts.slice(1), ...words.slice(1), ...(args || [])];
    const vtypes = [...parts.slice(1).map(() => 's'), ...words.slice(1).map(() => 's'), ...((types || '').split(''))];
    while (vals.length && isBlank(vals[0])) { vals.shift(); vtypes.shift(); }

    const cueCmd = (cue, action, value, vtype) => {
      if (isBlank(cue)) return null;
      if (action === 'volume') {
        const v = level(value, vtype);
        if (v === null) return null;
        return { cmd: 'cue', cue: String(cue), action, value: v };
      }
      return { cmd: 'cue', cue: String(cue), action: action || 'play' };
    };

    if (SIMPLE[head]) return { cmd: SIMPLE[head] };
    switch (head) {
      case 'go': return isBlank(vals[0]) ? { cmd: 'go' } : { cmd: 'go', cue: String(vals[0]) };
      case 'cue': case 'fire': case 'play': {
        const action = CUE_ACTIONS[String(vals[1] || 'play').toLowerCase()];
        if (!action) return null;
        return cueCmd(vals[0], action, vals[2], vtypes[2]);
      }
      case 'stop': case 'pause': case 'resume':
        return isBlank(vals[0]) ? { cmd: head + 'all' } : cueCmd(vals[0], head);
      case 'volume': return cueCmd(vals[0], 'volume', vals[1], vtypes[1]);
      case 'setgo': case 'standby': return isBlank(vals[0]) ? null : { cmd: 'standby', cue: String(vals[0]) };
      case 'master': case 'setmaster': {
        const v = level(vals[0], vtypes[0]);
        return v === null ? null : { cmd: 'master', value: v };
      }
      default: return null;
    }
  }

  function describe(c) {
    if (!c) return '';
    switch (c.cmd) {
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
