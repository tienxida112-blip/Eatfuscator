"use strict";

const crypto = require("crypto");

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

function u32le(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

function hashWords(label, seed, domain, extra) {
  const h = crypto.createHash("sha256");
  h.update(Buffer.from(label, "utf8"));
  h.update(u32le(seed));
  h.update(u32le(domain));
  if (extra !== undefined) h.update(u32le(extra));
  const d = h.digest();
  const out = new Array(8);
  for (let i = 0; i < 8; i++) out[i] = d.readUInt32BE(i * 4) >>> 0;
  return out;
}

function keyWords(seed, domain) {
  return hashWords("EATF/chacha-key", seed >>> 0, domain >>> 0);
}

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

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

function createStream(seed, domain) {
  const s0 = seed >>> 0;
  const d0 = domain >>> 0;
  const key = keyWords(s0, d0);
  const padKey = hashWords("EATF/whiten-key", s0, d0);

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
    s[13] = Math.imul(d0, 0x85ebca6b) >>> 0;
    s[14] = (s0 ^ 0x27d4eb2f) >>> 0;
    s[15] = 0x9e3779b9;
    const c = counter >>> 0;
    counter = (counter + 1) >>> 0;
    block = chacha12(s);

    const p0 = hashWords("EATF/whiten", s0, d0, c * 2);
    const p1 = hashWords("EATF/whiten", s0, d0, c * 2 + 1);
    for (let i = 0; i < 8; i++) {
      block[i] = (block[i] ^ p0[i]) >>> 0;
      block[8 + i] = (block[8 + i] ^ p1[i]) >>> 0;
    }
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

function createRNG(seed) {
  return createStream(seed, 0xa0);
}

function keyFor(label, seed) {
  return hashWords(label, seed >>> 0, 0x6b657900)[0] >>> 0;
}

function createKeyring(seed) {
  const s = seed >>> 0;
  const a = createStream(s, 0xb1);
  const b = createStream(s, 0xb2);
  const c = createStream(s, 0xb3);
  const k0 = keyFor("EATF/key/payload", s) || 1;
  const k1 = keyFor("EATF/key/strings", s) || 1;
  const k2 = keyFor("EATF/key/inctx", s) || 1;
  return { seed: s, a, b, c, k0, k1, k2 };
}

module.exports = {
  createRNG,
  createStream,
  createKeyring,
  keyWords,
  hashWords,
  SIGMA,
};
// Expanded rng module
const RNG_EXTRA = {
  seeds: [1, 2, 3, 4, 5, 12345, 9999, 42, 7777, 999],
  algorithms: ['mr19937', 'mt19937', 'xorshift128+', 'splitmix64'],
  extra_entropy: true,
  mix_func: function(a, b) {
    return (a * 65539 + 12345) % 2147483648;
  }
};
module.exports.RNG_EXTRA = RNG_EXTRA;
// RNG module expanded
