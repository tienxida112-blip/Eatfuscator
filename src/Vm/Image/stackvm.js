"use strict";

/**
 * Layer 3: the stack forge.
 *
 * The register image used to sit in the file as one 32-bit word per instruction,
 * sealed. That is a single layer of defence: beat the envelope, read the words,
 * and the instruction stream is in your hands.
 *
 * With the forge, those bytes are not register words at all. They are a program
 * for a small stack machine that *builds* each sealed word at load time:
 *
 *     LIT lo          push the low 24 bits of the literal
 *     LIT_HI hi       add the top 8 bits (one value on the stack)
 *     MAD pair        value = (value * k + c) mod 2^32, k/c chosen per word
 *     STORE           pop it into the word table
 *
 * So the three layers are, from the outside in:
 *
 *   layer 1  source transforms   -- names, numeral masks, folded constants
 *   layer 2  register image      -- the payload as bytecode + sealed constant bank
 *   layer 3  stack forge         -- a stack-machine program that materialises
 *                                   layer 2 at load; layer 2 is never stored as
 *                                   such anywhere in the file
 *
 * An analyst who dumps the image gets a stack program and a table of (k, c)
 * pairs. Rebuilding the register words from it is the work the artifact does on
 * every run, which is exactly the work they have to reverse first.
 *
 * Arithmetic stays exact: k < 2^21 and the literals are under 2^32, so every
 * product is below 2^53 and IEEE doubles are integers throughout. `(x*k + c)
 * mod 2^32` is invertible for odd k, which is how the encoder picks x.
 */

const OP = Object.freeze({ HEAD: 1, PAIRS: 2, LIT: 3, LIT_HI: 4, MAD: 5, STORE: 6 });
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

function encodeProto(code, rng) {
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

  const body = [];
  for (let i = 0; i < words; i++) {
    const w = Number(code[i]) >>> 0;
    const pick = i % pairs.length;
    const [k, c] = pairs[pick];
    const inv = invMod32(k);
    // x such that (x * k + c) mod 2^32 == w
    const x = mulMod(((w - c) % MOD + MOD) % MOD, inv);
    const lo = x % LO24;
    const hi = Math.floor(x / LO24) % 256;
    body.push(pack(OP.LIT, lo));
    body.push(pack(OP.LIT_HI, hi));
    body.push(pack(OP.MAD, pick));
    body.push(pack(OP.STORE, 0));
  }

  const pairsBody = [pack(OP.PAIRS, pairCount)];
  for (const [k, c] of pairs) pairsBody.push(k, c);

  // out[1] carries the total token count so a reader that only wants to skip the
  // region does not have to interpret it.
  const total = 2 + pairsBody.length + body.length;
  return [pack(OP.HEAD, words), total >>> 0, ...pairsBody, ...body];
}

/** Replace every proto's sealed word array with its stack program.
 *
 *  `mutate` exists for tools/tamper.js: it corrupts one token in the middle of
 *  the stream, which is what a patcher editing the blob does to it. Doing the
 *  damage here rather than by editing the artifact text keeps the mutation
 *  surgical - everything else in the build is byte-identical to a clean one, so a
 *  mutant that survives tells you about the layer, not about a mangled file.
 */
function forgeTree(root, rng, mutate) {
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
    p.code = [...encodeProto(p.code, rng), (p.codeDigest || 0) >>> 0];
    if (mutate && !applied && seenTokens + p.code.length > mutate.token) {
      const at = mutate.token - seenTokens;
      const before = p.code[at];
      const { op, operand } = unpack(before);
      let next = before;
      if (mutate.kind === "op") next = pack(op === OP.STORE ? OP.LIT : OP.STORE, operand);
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

module.exports = { OP, pack, unpack, encodeProto, forgeTree, invMod32, mulMod, madMod, MOD, LO24 };
