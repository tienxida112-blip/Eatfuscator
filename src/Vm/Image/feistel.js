"use strict";

const P16 = 65536;
const P24 = 16777216;
const P32 = 4294967296;
const PM = 8388593;

const ROUNDS = 6;
const DOMAIN_LAYER = 7;
const DOMAIN_STR = 11;
const DOMAIN_CODE = 13;

const mod = (a, m) => ((a % m) + m) % m;

function sbox(kA, kB, salt) {
  const S = new Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  const a = mod(kA, PM);
  const b = mod(kB, PM);
  const c = mod(salt, PM);
  let x = (a + b + c) % PM;
  if (x === 0) x = 1;
  for (let i = 255; i >= 1; i--) {

    x = (x * 48271 + 1 + a * (i + 1) + b * (i + 7) + c * (i + 1)) % PM;
    const j = x % (i + 1);
    const t = S[i];
    S[i] = S[j];
    S[j] = t;
  }
  return S;
}

function schedule(S, domain, pi, ci, rounds) {
  const n = rounds || ROUNDS;
  let seed = (S[0] * 65521 + S[1] * 4099 + S[2] * 257 + S[3] * 17 + domain * 8191 + pi * 131 + ci * 7) % 2147483647;
  if (seed === 0) seed = 1;
  const A = new Array(n + 1);
  const B = new Array(n + 1);
  for (let r = 1; r <= n; r++) {
    seed = (seed * 40699 + 27183) % 2147483647;
    A[r] = (S[seed % 256] * 256 + S[Math.floor(seed / 256) % 256]) % P16;
    seed = (seed * 40699 + 27183) % 2147483647;
    B[r] = (S[seed % 256] * 256 + S[Math.floor(seed / 256) % 256]) % P16;
  }
  const iv = ((A[1] * P16 + B[1]) % P32) >>> 0;
  return { S, A, B, iv, rounds: n };
}

function scheduleFor(kA, kB, salt, domain, pi, ci, rounds) {
  return schedule(sbox(kA, kB, salt), domain, pi, ci, rounds);
}

function F(sch, x, r) {
  const lo = x % 256;
  const hi = Math.floor(x / 256) % 256;
  return (sch.S[(lo + sch.A[r]) % 256] * 256 + sch.S[(hi + sch.B[r]) % 256]) % P16;
}

function encryptWord(w, sch) {
  let L = Math.floor(w / P16) % P16;
  let R = w % P16;
  for (let r = 1; r <= sch.rounds; r++) {
    const f = F(sch, R, r);
    const next = (L + f) % P16;
    L = R;
    R = next;
  }
  return L * P16 + R;
}

function decryptWord(w, sch) {
  let L = Math.floor(w / P16) % P16;
  let R = w % P16;
  for (let r = sch.rounds; r >= 1; r--) {
    const f = F(sch, L, r);
    const prev = mod(R - f, P16);
    R = L;
    L = prev;
  }
  return L * P16 + R;
}

function counterAt(pos, pi) {
  return mod(pos * 40503 + 12345 + pi * 65521, P32);
}

function encryptWordAt(w, sch, pos, pi) {
  return encryptWord(mod(w + counterAt(pos, pi), P32), sch);
}

function decryptWordAt(c, sch, pos, pi) {
  return mod(decryptWord(c, sch) - counterAt(pos, pi), P32);
}

function layerKeys(p) {
  const kA = (mod(p.a | 0, 256) * 65536 + mod(p.step | 0, 256) * 256 + mod(p.m | 0, 256)) % P24;
  const kB = (mod(p.inv | 0, 256) * 65536 + mod(p.salt | 0, 65536)) % P24;
  return { kA, kB, salt: mod(p.salt | 0, P24) };
}

function layerSchedule(p, domain) {
  const { kA, kB, salt } = layerKeys(p);
  return scheduleFor(kA, kB, salt, domain || DOMAIN_LAYER, 0, 0, ROUNDS);
}

function readWord(bytes, i) {
  return (
    (bytes[i] || 0) * 16777216 + (bytes[i + 1] || 0) * 65536 + (bytes[i + 2] || 0) * 256 + (bytes[i + 3] || 0)
  );
}

function writeWord(out, i, w) {
  out[i] = Math.floor(w / 16777216) % 256;
  out[i + 1] = Math.floor(w / 65536) % 256;
  out[i + 2] = Math.floor(w / 256) % 256;
  out[i + 3] = w % 256;
}

function encryptLayer(bytes, p) {
  const sch = layerSchedule(p);
  const n = bytes.length;
  const words = Math.ceil(n / 4);
  let prev = sch.iv;
  const out = new Array(words * 4);
  for (let i = 0; i < words; i++) {
    const x = mod(readWord(bytes, i * 4) + prev, P32);
    const c = encryptWord(x, sch);
    writeWord(out, i * 4, c);
    prev = c;
  }
  if (p.sw === 1) out.reverse();
  return out;
}

function decryptLayer(bytes, p) {
  const sch = layerSchedule(p);
  const n = bytes.length;
  const src = p.sw === 1 ? bytes.slice().reverse() : bytes;
  const words = Math.ceil(n / 4);
  let prev = sch.iv;
  const out = new Array(words * 4);
  for (let i = 0; i < words; i++) {
    const c = readWord(src, i * 4);
    writeWord(out, i * 4, mod(decryptWord(c, sch) - prev, P32));
    prev = c;
  }
  return out;
}

module.exports = {
  ROUNDS,
  P16,
  P24,
  P32,
  PM,
  DOMAIN_LAYER,
  DOMAIN_STR,
  DOMAIN_CODE,
  sbox,
  schedule,
  scheduleFor,
  encryptWord,
  decryptWord,
  encryptWordAt,
  decryptWordAt,
  counterAt,
  layerKeys,
  layerSchedule,
  encryptLayer,
  decryptLayer,
  mod,
};
