"use strict";

/**
 * The forge emits a small per-build stack program for each encrypted VM word.
 * Each program has a varying sequence of reversible multiply/add and half-word
 * swaps. Opcode values are build-specific; decoding remains possible with the
 * interpreter and must not be mistaken for cryptographic secrecy.
 */

const OP = Object.freeze({ HEAD: 1, PAIRS: 2, LIT: 3, LIT_HI: 4, MAD: 5, STORE: 6, ADD: 7, SWAP: 8 });

function createForgeMap(seed) {
  const rng = require("../../Core/rng").createRNG(((Number(seed) || 0) ^ 0x3a7b91e5) >>> 0);
  const codes = Array.from({ length: 255 }, (_, i) => i + 1);
  for (let i = codes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [codes[i], codes[j]] = [codes[j], codes[i]];
  }
  return Object.fromEntries(Object.keys(OP).map((name, i) => [name, codes[i]]));
}
const MOD = 4294967296;
const LO24 = 16777216;

// A token is one u32: opcode in the low byte, operand in the top 24 bits. The
// stream therefore stays 4 bytes per step and the image layout does not move.
function pack(op, operand) {
  const v = Math.floor(Number(operand) || 0) % LO24;
  return ((v * 256 + op) % MOD + MOD) % MOD;
}

function unpack(token) {
  const op = ((token % 256) + 256) % 256;
  return { op, operand: (token - op) / 256 };
}

// Inverse of k modulo 2^32 for odd k. Newton's iteration on the 2-adic inverse
// doubles the number of correct bits each round (1 -> 32 in five), and every
// product goes through mulMod so nothing leaves exact-double range.
function invMod32(k) {
  let x = 1;
  for (let i = 0; i < 5; i++) {
    const kx = mulMod(k, x);
    const t = ((2 - kx) % MOD + MOD) % MOD;
    x = mulMod(x, t);
  }
  return x;
}

// Exact (a * b) mod 2^32 in doubles: split a so no product passes 2^53.
function mulMod(a, b) {
  const ah = Math.floor(a / 65536), al = a % 65536;
  return ((((ah * b) % MOD) * 65536) + al * b) % MOD;
}

function madMod(x, k, c) {
  return (mulMod(x % MOD, k % MOD) + (c % MOD)) % MOD;
}

function encodeProto(code, rng, ops = OP) {
  const words = code.length;

  const pairs = [];
  const pairCount = 4 + Math.floor(rng() * 5);
  for (let i = 0; i < pairCount; i++) {
    let k = 1 + Math.floor(rng() * 0x1fffff);
    if (k % 2 === 0) k += 1;
    if (k >= 0x200000) k -= 2;
    const c = Math.floor(rng() * MOD) >>> 0;
    pairs.push([k >>> 0, c >>> 0]);
  }

  const inverses = pairs.map(([k]) => invMod32(k));
  const swap = (v) => (v % 65536) * 65536 + Math.floor(v / 65536);
  const body = [];
  for (let i = 0; i < words; i++) {
    const plan = [{ op: "MAD", val: Math.floor(rng() * pairs.length) }];
    const extra = 1 + Math.floor(rng() * 3);
    for (let j = 0; j < extra; j++) {
      const kind = Math.floor(rng() * 3);
      plan.push(kind === 0 ? { op: "MAD", val: Math.floor(rng() * pairs.length) } :
        kind === 1 ? { op: "ADD", val: Math.floor(rng() * LO24) } : { op: "SWAP", val: 0 });
    }
    // Some recipes carry an executed reversible detour, rather than only
    // unreachable filler. Two half-word swaps cancel; a tracer can simplify it.
    if (rng() < 0.55) {
      const at = Math.floor(rng() * (plan.length + 1));
      plan.splice(at, 0, { op: "SWAP", val: 0 }, { op: "SWAP", val: 0 });
    }
    let x = Number(code[i]) >>> 0;
    for (let j = plan.length - 1; j >= 0; j--) {
      const step = plan[j];
      if (step.op === "MAD") {
        const [, c] = pairs[step.val];
        x = mulMod(((x - c) % MOD + MOD) % MOD, inverses[step.val]);
      } else if (step.op === "ADD") x = ((x - step.val) % MOD + MOD) % MOD;
      else x = swap(x);
    }
    body.push(pack(ops.LIT, x % LO24));
    body.push(pack(ops.LIT_HI, Math.floor(x / LO24) % 256));
    for (const step of plan) body.push(pack(ops[step.op], step.val));
    body.push(pack(ops.STORE, 0));
  }

  const pairsBody = [pack(ops.PAIRS, pairCount)];
  for (const [k, c] of pairs) pairsBody.push(k, c);

  // out[1] carries the total token count so a reader that only wants to skip the
  // region does not have to interpret it.
  const total = 2 + pairsBody.length + body.length;
  return [pack(ops.HEAD, words), total >>> 0, ...pairsBody, ...body];
}

/** Replace every proto's sealed word array with its stack program.
 *
 *  `mutate` exists for tools/tamper.js: it corrupts one token in the middle of
 *  the stream, which is what a patcher editing the blob does to it. Doing the
 *  damage here rather than by editing the artifact text keeps the mutation
 *  surgical - everything else in the build is byte-identical to a clean one, so a
 *  mutant that survives tells you about the layer, not about a mangled file.
 */
function forgeTree(root, rng, mutate, ops = OP) {
  const seen = new Set();
  let words = 0;
  let tokens = 0;
  let seenTokens = 0;
  let applied = null;
  const visit = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    words += p.code.length;
    p.wordCount = p.code.length;
    // The stream carries its integrity word as its last u32, right after the
    // tokens: the interpreter reads it back after forging and compares.
    p.code = [...encodeProto(p.code, rng, ops), (p.codeDigest || 0) >>> 0];
    if (mutate && !applied && seenTokens + p.code.length > mutate.token) {
      const at = mutate.token - seenTokens;
      const before = p.code[at];
      const { op, operand } = unpack(before);
      let next = before;
      if (mutate.kind === "op") next = pack(op === ops.STORE ? ops.LIT : ops.STORE, operand);
      else if (mutate.kind === "operand") next = pack(op, (operand + 0x40 + (mutate.delta || 0)) % LO24);
      else next = pack(op, operand) ^ 0; // unknown kind: leave it, reported below
      p.code[at] = next >>> 0;
      applied = { token: mutate.token, at, before, after: p.code[at], op };
    }
    tokens += p.code.length;
    seenTokens += p.code.length;
    for (const c of p.child) visit(c);
  };
  visit(root);
  return { words, tokens, applied };
}

module.exports = { OP, createForgeMap, pack, unpack, encodeProto, forgeTree, invMod32, mulMod, madMod, MOD, LO24 };
