"use strict";

const { numText } = require("./encoder");
const { fieldOf, setField } = require("./opcodes");
const feistel = require("./feistel");

const P24 = feistel.P24;
const P32 = feistel.P32;

function keyPair(keys) {
  return {
    kA: feistel.mod(keys.k1 >>> 0, P24),
    kB: feistel.mod(keys.k2 >>> 0, P24),
  };
}

function wordBytes(w) {
  return [
    Math.floor(w / 16777216) % 256,
    Math.floor(w / 65536) % 256,
    Math.floor(w / 256) % 256,
    w % 256,
  ];
}

function keystreamApply(bytes, sch, sign, salt = 0, protoIndex = 0, constIndex = 0) {
  const out = bytes.slice();
  let state = sch.iv;
  const factor = 1 + 2 * (salt % 4);
  const stride = 13 + 2 * (salt % 7);
  const domain = (protoIndex * 3 + constIndex * 5) % 256;
  let previous = 0;
  for (let i = 0; i < out.length; i += 4) {
    state = feistel.encryptWord(state, sch);
    const kb = wordBytes(state);
    for (let j = 0; j < 4 && i + j < out.length; j++) {
      const index = i + j;
      const input = out[index];
      const mask = kb[j] + previous * factor + (index + 1) * stride + domain;
      const value = feistel.mod(input + sign * mask, 256);
      out[index] = value;
      previous = sign > 0 ? value : input;
    }
  }
  return out;
}

function buildBox(keys) {
  const { kA, kB } = keyPair(keys);
  return feistel.sbox(kA, kB, feistel.mod(keys.salt >>> 0, P24));
}

function constantSchedule(box, protoIndex, constIndex) {
  return feistel.schedule(box, feistel.DOMAIN_STR, protoIndex, constIndex, feistel.ROUNDS);
}

function encryptBytes(bytes, keys, protoIndex, constIndex) {
  return keystreamApply(bytes, constantSchedule(buildBox(keys), protoIndex, constIndex), 1, keys.salt >>> 0, protoIndex, constIndex);
}

function decryptBytes(bytes, keys, protoIndex, constIndex) {
  return keystreamApply(bytes, constantSchedule(buildBox(keys), protoIndex, constIndex), -1, keys.salt >>> 0, protoIndex, constIndex);
}

function encryptConstants(root, keys) {
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

  const box = buildBox(keys);
  let strings = 0;
  let numbers = 0;
  for (let i = 0; i < order.length; i++) {
    const proto = order[i];
    for (let k = 0; k < proto.k.length; k++) {
      const entry = proto.k[k];
      if (entry.t === "string") {
        const bytes = Array.from(Buffer.from(String(entry.v), "latin1"));
        entry.v = Buffer.from(keystreamApply(bytes, constantSchedule(box, i + 1, k + 1), 1, keys.salt >>> 0, i + 1, k + 1)).toString("latin1");
        strings += 1;
      } else if (entry.t === "number") {
        const text = typeof entry.v === "number" ? numText(entry.v) : String(entry.v);
        const bytes = Array.from(Buffer.from(text, "latin1"));
        entry.v = Buffer.from(keystreamApply(bytes, constantSchedule(box, i + 1, k + 1), 1, keys.salt >>> 0, i + 1, k + 1)).toString("latin1");
        entry.enc = true;
        numbers += 1;
      }
    }
  }
  return { protos: order.length, strings, numbers };
}

const OPCODE_FLIP_STRIDE = 37;
const P32MOD = 4294967296;

function chainSeed(iv, protoIndex) {
  return feistel.mod(feistel.mod(iv, 65536) * 65537 + protoIndex, P32MOD);
}

function chainStep(chain, plain) {
  return feistel.mod(feistel.mod(chain, 65536) * 65537 + plain, P32MOD);
}

function opcodeFlip(box, protoIndex, position) {
  const j = position;
  return 1 + (box[(protoIndex * OPCODE_FLIP_STRIDE + j * 53) % 256] + j * 17 + protoIndex * 11) % 255;
}

// Bind every operand byte to its prototype, instruction position and preceding
// fields. These masks diversify the resident representation, not the runtime
// semantics: an observer who instruments dispatch can still see decoded values.
function operandMask(box, protoIndex, position, field, prior) {
  const page = Math.floor(position / 256);
  const region = Math.floor(protoIndex / 256);
  const index = (protoIndex * 41 + position * 67 + field * 79 + prior * 3 + page * 19 + region * 23) % 256;
  const first = box[index];
  const second = box[(first + prior * 7 + position + page * 31 + field * 43) % 256];
  return (first + second + protoIndex * 13 + position * 29 + field * 47 + prior * 5 + page * 17 + region * 37) % 256;
}

function maskOperands(word, box, protoIndex, position) {
  const a = fieldOf(word, "a"), b = fieldOf(word, "b"), c = fieldOf(word, "c");
  const o = fieldOf(word, "op");
  word = setField(word, "a", a + operandMask(box, protoIndex, position, 1, o));
  word = setField(word, "b", b + operandMask(box, protoIndex, position, 2, a));
  word = setField(word, "c", c + operandMask(box, protoIndex, position, 3, b));
  return word >>> 0;
}

function unmaskOperands(word, box, protoIndex, position) {
  const o = fieldOf(word, "op");
  const a = (fieldOf(word, "a") - operandMask(box, protoIndex, position, 1, o) + 256) % 256;
  const b = (fieldOf(word, "b") - operandMask(box, protoIndex, position, 2, a) + 256) % 256;
  const c = (fieldOf(word, "c") - operandMask(box, protoIndex, position, 3, b) + 256) % 256;
  word = setField(word, "a", a);
  word = setField(word, "b", b);
  return setField(word, "c", c) >>> 0;
}

function cipherCode(root, keys) {
  const box = buildBox(keys);
  const sch = feistel.schedule(box, feistel.DOMAIN_CODE, 0, 0, feistel.ROUNDS);

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

  let words = 0;
  for (let i = 0; i < order.length; i++) {
    const proto = order[i];
    let chain = chainSeed(sch.iv, i + 1);
    // Integrity covers the position-masked words before they enter the resident
    // cache. Opcode unmasking happens only at execution, using proto and PC.
    let digest = 0;
    for (let j = 0; j < proto.code.length; j++) {
      const w = proto.code[j] >>> 0;
      const opField = fieldOf(w, "op");
      const renumbered = maskOperands(setField(w, "op", opField + opcodeFlip(box, i + 1, j + 1)), box, i + 1, j + 1);
      digest = (digest * 31 + renumbered) % 4294967296;
      const mixed = feistel.mod(renumbered + feistel.counterAt(j + 1, i + 1), 4294967296);
      const sealed = feistel.mod(feistel.encryptWord(mixed, sch) + chain, 4294967296);
      proto.code[j] = sealed >>> 0;
      chain = chainStep(chain, renumbered);
      words += 1;
    }
    proto.codeDigest = digest;
  }
  return { words };
}

const DIGEST_MOD = 16777216;
const DIGEST_STEPS = 16;

function digestWords(bytes, key1, key2) {
  const H = new Array(DIGEST_STEPS).fill(0);
  const k1 = key1 % 8191;
  const k2 = key2 % 4093;

  const MUL = 0x8001 + 2 * (k2 % 4096);
  const WSTEP = 3 + (k1 % 11);
  const STRIDE = 251 - (k1 % 7);
  for (let i = 0; i < bytes.length; i++) {
    const w = i % DIGEST_STEPS;
    H[w] = (H[w] * MUL + bytes[i] * (2 * w + WSTEP) + ((i + 1) % STRIDE) + k1 * (w + 2) + k2) % DIGEST_MOD;
  }
  return H;
}

module.exports = {
  encryptConstants,
  buildBox,
  decryptBytes,
  encryptBytes,
  constantSchedule,
  keystreamApply,
  digestWords,
  chainSeed,
  chainStep,
  opcodeFlip,
  operandMask,
  maskOperands,
  unmaskOperands,
  OPCODE_FLIP_STRIDE,
  DIGEST_STEPS,
  cipherCode,
  keyPair,
};
