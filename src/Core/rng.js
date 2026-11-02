"use strict";

/**
 * Build stream — dsc.gg/eatfuscator
 *
 * Everything random in a build comes out of here: names, layout, cipher
 * parameters, key material. It has to be reproducible from the seed alone
 * (two builds of one seed are byte identical) and it has to be unpredictable
 * from the outputs (a seed is not a secret, but the stream must not be
 * guessable from a handful of draws either).
 *
 * The generator is **ChaCha12**: four 32-bit words of state are mixed with the
 * key and a per-domain nonce, then twelve rounds of the ARX quarter-round run
 * over the state. Every output word depends on every key bit and every state
 * bit after two rounds, so nothing about the next draw can be read off the
 * previous one — unlike the splitmix/LCG step this replaced, whose whole state
 * is one 32-bit word and whose next value is a short arithmetic step away.
 *
 * `frac()` hands back the **top 24 bits** of the word, not the bottom ones.
 * The high bits are the ones every round of mixing reaches first, and the
 * loader's own arithmetic is all mod 2^24, so a draw and the value it drives
 * are the same 24 bits instead of being taken from two different ends.
 *
 * Keyring: one seed fans out into three independent streams (domains A, B, C)
 * plus three keys taken from those streams. The build never reuses a stream
 * across two different jobs, so the payload cipher, the constant bank and the
 * instruction encoding cannot be correlated with each other.
 */

const MASK32 = 0xffffffff;

function rotl(v, n) {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

function quarter(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotl(s[b] ^ s[c], 7);
}

/** expand a 32-bit seed into the eight key words, with a domain tag */
function keyWords(seed, domain) {
  const words = new Array(8);
  let x = (seed ^ Math.imul(domain, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < 8; i++) {
    // splitmix32, used only for key expansion (not for the stream itself)
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    words[i] = (t ^ (t >>> 14)) >>> 0;
  }
  return words;
}

/**
 * ChaCha12 block function. `state` is the working copy, `bias` the pre-round
 * snapshot; the output is the usual state + bias add.
 */
function chacha12(state) {
  const bias = state.slice();
  for (let round = 0; round < 6; round++) {
    quarter(state, 0, 4, 8, 12);
    quarter(state, 1, 5, 9, 13);
    quarter(state, 2, 6, 10, 14);
    quarter(state, 3, 7, 11, 15);
    quarter(state, 0, 5, 10, 15);
    quarter(state, 1, 6, 11, 12);
    quarter(state, 2, 7, 8, 13);
    quarter(state, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) state[i] = (state[i] + bias[i]) >>> 0;
  return state;
}

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]; // "expand 32-byte k"

/**
 * A ChaCha12 word stream. `next()` yields the next 32-bit word, `frac()`
 * yields its top 24 bits as a fraction in [0, 1).
 */
function createStream(seed, domain) {
  const key = keyWords(seed >>> 0, domain >>> 0);
  let counter = 0;
  let block = null;
  let idx = 16;

  function refill() {
    const s = new Array(16);
    s[0] = SIGMA[0];
    s[1] = SIGMA[1];
    s[2] = SIGMA[2];
    s[3] = SIGMA[3];
    for (let i = 0; i < 8; i++) s[4 + i] = key[i];
    s[12] = counter >>> 0;
    s[13] = Math.imul(domain, 0x85ebca6b) >>> 0;
    s[14] = (seed ^ 0x27d4eb2f) >>> 0;
    s[15] = 0x9e3779b9;
    counter = (counter + 1) >>> 0;
    block = chacha12(s);
    idx = 0;
  }

  function word() {
    if (idx >= 16) refill();
    return block[idx++];
  }

  function frac() {
    return (word() >>> 8) / 0x1000000;
  }

  frac.word = word;
  frac.stream = true;
  return frac;
}

/** the build's structure stream (names, sizes, shapes) */
function createRNG(seed) {
  return createStream(seed, 0xa0);
}

/**
 * Three independent key streams plus the three keys the artifact carries:
 *
 *   k0  payload chunking + payload cipher parameters
 *   k1  constant bank layers + the constant-string stream
 *   k2  opcode permutation + instruction-word encoding
 */
function createKeyring(seed) {
  const a = createStream(seed, 0xb1);
  const b = createStream(seed, 0xb2);
  const c = createStream(seed, 0xb3);
  const k0 = (a.word() % 251) + 1;
  const k1 = (b.word() % 251) + 1;
  const k2 = c.word() % 16777216;
  return { seed: seed >>> 0, a, b, c, k0, k1, k2 };
}

/* ------------------------------------------------------------------ */
/* instruction word encoding                                           */
/* ------------------------------------------------------------------ */

/**
 * `w' = (w * m + s) mod 2^32` with `m` odd — a bijection on the instruction
 * space. `m` and `s` are drawn from the k2 stream, so the mapping changes per
 * build; the artifact carries `m`'s modular inverse (and derives `s` from k2 at
 * run time), and un-maps each word once while the image is being loaded.
 */
function instructionCipher(stream, k2) {
  const m = ((stream.word() | 1) >>> 0) | 1; // odd
  // the additive half is a pure function of the key, so the bank never has to
  // carry it: both sides recompute it from k2
  const s = addendOf(k2);
  // Newton iteration: five steps double the number of correct bits, 1 -> 32
  let inv = 1;
  for (let i = 0; i < 5; i++) inv = Math.imul(inv, (2 - Math.imul(m, inv)) >>> 0) >>> 0;
  inv = inv >>> 0;
  if (Math.imul(m, inv) >>> 0 !== 1) throw new Error("instruction cipher: inverse failed");
  return { m, s, inv, k2: k2 >>> 0, addend: s };
}

/** the additive half is a pure function of k2, so it costs no bank slot */
function addendOf(k2) {
  return (Math.imul(k2 >>> 0, 40503) + 12345) >>> 0;
}

function encodeWord(w, cipher) {
  return (Math.imul(w >>> 0, cipher.m) + cipher.s) >>> 0;
}

function decodeWord(w, cipher) {
  return Math.imul((w - cipher.s) >>> 0, cipher.inv) >>> 0;
}

module.exports = {
  createRNG,
  createStream,
  createKeyring,
  instructionCipher,
  encodeWord,
  decodeWord,
  addendOf,
  SIGMA,
};
