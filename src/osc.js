// Minimal OSC 1.0 encoder/decoder (no dependencies).

function pad4(n) { return Math.ceil(n / 4) * 4; }

function readString(buf, off) {
  let end = buf.indexOf(0, off);
  if (end < 0) end = buf.length;
  const s = buf.toString('utf8', off, end);
  return [s, off + pad4(end - off + 1)];
}

function decodeMessage(buf) {
  let [address, off] = readString(buf, 0);
  const args = [];
  if (off >= buf.length) return { address, args };
  let tags;
  [tags, off] = readString(buf, off);
  if (!tags.startsWith(',')) return { address, args };
  for (const t of tags.slice(1)) {
    switch (t) {
      case 'i': args.push(buf.readInt32BE(off)); off += 4; break;
      case 'f': args.push(buf.readFloatBE(off)); off += 4; break;
      case 'd': args.push(buf.readDoubleBE(off)); off += 8; break;
      case 'h': args.push(Number(buf.readBigInt64BE(off))); off += 8; break;
      case 's': case 'S': { let s; [s, off] = readString(buf, off); args.push(s); break; }
      case 'b': { const n = buf.readInt32BE(off); off += 4; args.push(buf.subarray(off, off + n)); off += pad4(n); break; }
      case 'T': args.push(true); break;
      case 'F': args.push(false); break;
      case 'N': args.push(null); break;
      case 'I': args.push(Infinity); break;
      default: return { address, args }; // unknown tag: stop parsing
    }
  }
  return { address, args };
}

function decode(buf) {
  if (buf.length >= 8 && buf.toString('utf8', 0, 7) === '#bundle') {
    const out = [];
    let off = 16; // "#bundle\0" + 8-byte timetag
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off); off += 4;
      out.push(...decode(buf.subarray(off, off + size)));
      off += size;
    }
    return out;
  }
  return [decodeMessage(buf)];
}

function strBuf(s) {
  const b = Buffer.from(String(s), 'utf8');
  const out = Buffer.alloc(pad4(b.length + 1));
  b.copy(out);
  return out;
}

function encode(address, args) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    if (typeof a === 'number') {
      if (Number.isInteger(a) && Math.abs(a) < 2147483648) {
        tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); parts.push(b);
      } else {
        tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); parts.push(b);
      }
    } else if (typeof a === 'boolean') {
      tags += a ? 'T' : 'F';
    } else if (a === null || a === undefined) {
      tags += 'N';
    } else {
      tags += 's'; parts.push(strBuf(a));
    }
  }
  return Buffer.concat([strBuf(address), strBuf(tags), ...parts]);
}

module.exports = { encode, decode };
