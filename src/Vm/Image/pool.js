"use strict";

/**
 * Constant-pool layout — dsc.gg/eatfuscator
 *
 * The compiler grows each proto's constant pool in source order: the first
 * string a function mentions is K[0], the second is K[1], and an analyst who
 * maps a pool index back through the loader gets the function's names back in
 * reading order. This pass breaks that: after a proto is fully emitted, its
 * pool is permuted with the build seed and every instruction that names a
 * constant is rewritten to the new index.
 *
 * Nothing else changes. The permutation is a bijection, so the code still
 * reads the same values — it only stops reading them in the order the author
 * wrote them. Same seed, same layout; different seed, different layout.
 *
 * Instructions that carry a constant index:
 *
 *   LOADK / GETGLOBAL / SETGLOBAL      index in D (16 bit, biased)
 *   GETTABLEC / SETTABLEC              index in C (8 bit)
 *   ADDK SUBK MULK DIVK MODK           index in C (8 bit)
 *
 * The numeric opcodes are already remapped per build, so the sets below are
 * built from the build's own opcode map rather than from the base numbering.
 */

const { iABC, iAD } = require("./opcodes");

const CONST_IN_D = ["LOADK", "GETGLOBAL", "SETGLOBAL"];
const CONST_IN_C = ["GETTABLEC", "SETTABLEC", "ADDK", "SUBK", "MULK", "DIVK", "MODK"];

function fisherYates(n, rng) {
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

function shuffleProto(proto, opmap, rng, stats) {
  for (const child of proto.child) shuffleProto(child, opmap, rng, stats);

  const n = proto.k.length;
  if (n < 2) return;

  // order[newIndex] = oldIndex, and inv goes the other way
  const order = fisherYates(n, rng);
  const inv = new Array(n);
  for (let i = 0; i < n; i++) inv[order[i]] = i;

  const inD = new Set(CONST_IN_D.map((name) => opmap[name]));
  const inC = new Set(CONST_IN_C.map((name) => opmap[name]));

  // A pool larger than 256 constants (a 256-entry lookup table is enough to
  // get there) cannot move every slot into the 8-bit operand of the *C forms,
  // so the entries those instructions name are pinned below 256 first. The
  // permutation stays a bijection — only which slots are off limits changes.
  const pinned = new Set();
  for (let i = 0; i < proto.code.length; i++) {
    const word = proto.code[i] >>> 0;
    if (inC.has(word % 256)) pinned.add((word >>> 24) % 256);
  }
  if (pinned.size > 256) throw new Error("constant pool needs more than 256 byte-operand slots");
  for (const p of pinned) {
    if (inv[p] < 256) continue;
    let slot = -1;
    for (let i = 0; i < 256; i++) {
      if (!pinned.has(order[i])) {
        slot = i;
        break;
      }
    }
    if (slot < 0) throw new Error("constant pool has no free byte-operand slot");
    const at = inv[p];
    const other = order[slot];
    order[at] = other;
    order[slot] = p;
    inv[other] = at;
    inv[p] = slot;
  }

  for (let i = 0; i < proto.code.length; i++) {
    const word = proto.code[i] >>> 0;
    const op = word % 256;
    const a = Math.floor(word / 256) % 256;
    if (inD.has(op)) {
      const d = (word >>> 16) - 32768;
      const moved = inv[d];
      if (moved === undefined) throw new Error("constant index out of range: " + d);
      proto.code[i] = iAD(op, a, moved) >>> 0;
    } else if (inC.has(op)) {
      const b = (word >>> 16) % 256;
      const c = (word >>> 24) % 256;
      const moved = inv[c];
      if (moved === undefined) throw new Error("constant index out of range: " + c);
      proto.code[i] = iABC(op, a, b, moved) >>> 0;
    }
  }

  proto.k = order.map((old) => proto.k[old]);
  stats.protos += 1;
  stats.constants += n;
}

/**
 * Permute every constant pool in the proto tree. `opmap` is the build's own
 * opcode map (BASE numbering is never assumed) and `rng` the build stream, so
 * the layout is reproducible from the seed alone.
 */
function shufflePool(root, opmap, rng) {
  const stats = { protos: 0, constants: 0 };
  shuffleProto(root, opmap, rng, stats);
  return stats;
}

module.exports = { shufflePool, CONST_IN_D, CONST_IN_C };
