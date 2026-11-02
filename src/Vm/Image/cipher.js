"use strict";

/**
 * Image ciphers — dsc.gg/eatfuscator
 *
 * Two independent transforms are applied to a compiled proto tree before it is
 * serialised, both keyed from the build's keyring and both undone by the
 * interpreter while it is reading the image back:
 *
 *   instructions  every 32-bit word is mapped through
 *                 `w' = (w * m + s) mod 2^32` (m odd, so the map is a
 *                 bijection). `m` and `s` come from the k2 stream; the
 *                 artifact carries m's inverse and derives s from k2, so the
 *                 word stream is meaningless without the build's key even if
 *                 the whole image is dumped in the clear.
 *
 *   strings       each string constant is offset byte by byte with a Lehmer
 *                 (minstd) keystream seeded from the k1 key, the proto index,
 *                 the constant index and the pass number. The build picks the
 *                 generator (one of four Lehmer multipliers) and the number of
 *                 passes is derived per prototype, so a prototype's strings and
 *                 its neighbour's are not even the same cipher. Two prototypes
 *                 holding the same literal do not hold the same bytes, and a
 *                 decoded image no longer hands out the payload's strings.
 *
 * Both steps are load-time only: the interpreter pays one multiply per
 * instruction word once, not per dispatch, and one keystream step per string
 * byte once.
 */

const { numText } = require("./encoder");

const MOD = 2147483647; // 2^31 - 1, Lehmer prime

// Every valid multiplier of the 2^31-1 Lehmer generator is a primitive root;
// these four are the ones used in the wild. The build picks one from the
// string key, so two artifacts do not merely carry different keys — they run
// a different generator.
const MULT = [16807, 48271, 69621, 40692];

/** the generator this build runs on */
function multFor(key) {
  return MULT[key % MULT.length];
}

/**
 * how many offset passes one constant takes (1..3). Drawn per constant, not
 * per build, so a dumped function cannot even assume its literals all took the
 * same number of passes as each other.
 */
function roundsFor(key, protoIndex, constIndex) {
  return 1 + ((key * 65521 + protoIndex * 4093 + constIndex * 97) % 3);
}

/**
 * the exact stream the interpreter reproduces in Lua: same multiplier, same
 * round salt, and every product stays below 2^53 so a double is exact
 */
function keystream(key, protoIndex, constIndex, length, round, mult) {
  const step = mult || multFor(key);
  let seed = (key * 65537 + protoIndex * 7919 + constIndex * 104729 + round * 15485863) % MOD;
  if (seed < 0) seed += MOD;
  if (seed === 0) seed = 12345;
  const out = new Array(length);
  for (let i = 0; i < length; i++) {
    seed = (seed * step) % MOD;
    out[i] = seed % 256;
  }
  return out;
}

function encryptBytes(bytes, key, protoIndex, constIndex) {
  const mult = multFor(key);
  const rounds = roundsFor(key, protoIndex, constIndex);
  const out = bytes.slice();
  for (let r = 1; r <= rounds; r++) {
    const ks = keystream(key, protoIndex, constIndex, out.length, r, mult);
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - ks[i] + 256) % 256;
  }
  return out;
}

function decryptBytes(bytes, key, protoIndex, constIndex) {
  const mult = multFor(key);
  const rounds = roundsFor(key, protoIndex, constIndex);
  const out = bytes.slice();
  for (let r = 1; r <= rounds; r++) {
    const ks = keystream(key, protoIndex, constIndex, out.length, r, mult);
    for (let i = 0; i < out.length; i++) out[i] = (out[i] + ks[i]) % 256;
  }
  return out;
}

/**
 * Walk the proto tree in serialisation order (root first, children after, the
 * same order encoder.js indexes them in) and encipher every string constant.
 */
function encryptConstants(root, key) {
  // children are indexed in the order encoder.js visits them, so number the
  // tree the same way before touching a single constant
  const order = [];
  const seen = new Map();
  const visit = (p) => {
    if (seen.has(p)) return seen.get(p);
    const idx = order.length;
    seen.set(p, idx);
    order.push(p);
    for (const c of p.child) visit(c);
    return idx;
  };
  visit(root);

  let strings = 0;
  let numbers = 0;
  for (let i = 0; i < order.length; i++) {
    const proto = order[i];
    for (let k = 0; k < proto.k.length; k++) {
      const entry = proto.k[k];
      if (entry.t === "string") {
        const bytes = Array.from(Buffer.from(String(entry.v), "latin1"));
        entry.v = Buffer.from(encryptBytes(bytes, key, i + 1, k + 1)).toString("latin1");
        strings += 1;
      } else if (entry.t === "number") {
        // numbers travel as ciphertext of their decimal spelling: the digits a
        // reader would use to type the constant back are not in the image
        const text = typeof entry.v === "number" ? numText(entry.v) : String(entry.v);
        const bytes = Array.from(Buffer.from(text, "latin1"));
        entry.v = Buffer.from(encryptBytes(bytes, key, i + 1, k + 1)).toString("latin1");
        entry.enc = true;
        numbers += 1;
      }
    }
  }
  return { protos: order.length, strings, numbers };
}

/** encipher every instruction word of every proto */
function cipherCode(root, cipher) {
  let words = 0;
  const walk = (proto) => {
    for (let i = 0; i < proto.code.length; i++) {
      proto.code[i] = (Math.imul(proto.code[i] >>> 0, cipher.m) + cipher.s) >>> 0;
      words += 1;
    }
    for (const child of proto.child) walk(child);
  };
  walk(root);
  return { words };
}

/**
 * 16-word rolling digest of a decoded image (512 bits of state, two words
 * stored). Pure integer arithmetic under 2^53, so the Lua side can reproduce
 * it digit for digit without bit32 — portable to every 5.1 host. Both keys are
 * folded into the mix, so the stored tag cannot be checked without them.
 */
const DIGEST_MOD = 16777216; // 2^24
const DIGEST_STEPS = 16;

function digestWords(bytes, key1, key2) {
  const H = new Array(DIGEST_STEPS).fill(0);
  const k1 = key1 % 251;
  const k2 = key2 % 4093;
  for (let i = 0; i < bytes.length; i++) {
    const w = i % DIGEST_STEPS;
    H[w] = (H[w] * 40961 + bytes[i] * (2 * w + 3) + ((i + 1) % 251) + k1 * (w + 2) + k2) % DIGEST_MOD;
  }
  return H;
}

module.exports = {
  encryptConstants,
  decryptBytes,
  encryptBytes,
  keystream,
  multFor,
  roundsFor,
  digestWords,
  MULT,
  DIGEST_STEPS,
  cipherCode,
};
