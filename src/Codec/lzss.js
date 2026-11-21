"use strict";

/**
 * LZSS codec — 12-bit offset / 4-bit length, 8 flags per control byte.
 * Stream layout per control byte: bit b set => literal byte; clear => match pair.
 *   match pair: b1 = off >> 4, b2 = ((off & 0xF) << 4) | (len - 3)
 *   off in 1..4095, len in 3..18
 * The Lua side mirrors this exactly (see obfuscator/runtime.lua).
 */

const WINDOW = 4095;
const MIN_MATCH = 3;
const MAX_MATCH = 18;

function key3(buf, p) {
  return (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2];
}

function compress(input) {
  const src = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const n = src.length;
  const out = [];
  const head = new Map();

  if (n === 0) return Buffer.alloc(0);

  function addPos(p) {
    if (p + MIN_MATCH > n) return;
    const k = key3(src, p);
    let list = head.get(k);
    if (!list) {
      list = [];
      head.set(k, list);
    }
    list.push(p);
    if (list.length > 96) list.splice(0, list.length - 96);
  }

  function findMatch(i) {
    if (i + MIN_MATCH > n) return null;
    const list = head.get(key3(src, i));
    if (!list) return null;
    const maxLen = Math.min(MAX_MATCH, n - i);
    let bestLen = 0;
    let bestOff = 0;
    for (let c = list.length - 1; c >= 0; c--) {
      const j = list[c];
      const off = i - j;
      if (off <= 0 || off > WINDOW) continue;
      let l = 0;
      while (l < maxLen && src[j + l] === src[i + l]) l++;
      if (l > bestLen) {
        bestLen = l;
        bestOff = off;
        if (l === maxLen) break;
      }
    }
    if (bestLen < MIN_MATCH) return null;
    return { len: bestLen, off: bestOff };
  }

  let i = 0;
  while (i < n) {
    const flagPos = out.length;
    out.push(0);
    let flags = 0;

    for (let bit = 0; bit < 8 && i < n; bit++) {
      let m = findMatch(i);
      // lazy matching: prefer a literal when the next position yields a longer match
      if (m && m.len < MAX_MATCH) {
        const nxt = findMatch(i + 1);
        if (nxt && nxt.len > m.len + 1) m = null;
      }
      if (m) {
        out.push((m.off >> 4) & 0xff);
        out.push(((m.off & 0xf) << 4) | (m.len - MIN_MATCH));
        for (let k = 0; k < m.len; k++) addPos(i + k);
        i += m.len;
      } else {
        flags |= 1 << bit;
        out.push(src[i]);
        addPos(i);
        i++;
      }
    }

    out[flagPos] = flags;
  }

  return Buffer.from(out);
}

function decompress(input) {
  const src = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const n = src.length;
  const out = Buffer.alloc(Math.max(0, n * 24));
  let oi = 0;
  let i = 0;

  while (i < n) {
    const flags = src[i++];
    for (let bit = 0; bit < 8 && i < n; bit++) {
      if (flags & (1 << bit)) {
        out[oi++] = src[i++];
      } else {
        const b1 = src[i++];
        const b2 = src[i++];
        if (b2 === undefined) break;
        const off = b1 * 16 + (b2 >> 4);
        const len = (b2 & 0xf) + MIN_MATCH;
        const start = oi - off;
        for (let k = 0; k < len; k++) {
          if (start + k < 0) continue;
          out[oi++] = out[start + k];
        }
      }
    }
  }

  return out.subarray(0, oi);
}

module.exports = { compress, decompress, WINDOW, MIN_MATCH, MAX_MATCH };
