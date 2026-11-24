"use strict";

const { iABC, iAD, fieldOf } = require("./opcodes");

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

  const order = fisherYates(n, rng);
  const inv = new Array(n);
  for (let i = 0; i < n; i++) inv[order[i]] = i;

  const inD = new Set(CONST_IN_D.map((name) => opmap[name]));
  const inC = new Set(CONST_IN_C.map((name) => opmap[name]));

  const pinned = new Set();
  for (let i = 0; i < proto.code.length; i++) {
    const word = proto.code[i] >>> 0;
    if (inC.has(fieldOf(word, "op"))) pinned.add(fieldOf(word, "c"));
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
    const op = fieldOf(word, "op");
    const a = fieldOf(word, "a");
    if (inD.has(op)) {
      const dd = fieldOf(word, "b") + fieldOf(word, "c") * 256;
      const d = dd - 32768;
      const moved = inv[d];
      if (moved === undefined) throw new Error("constant index out of range: " + d);
      proto.code[i] = iAD(op, a, moved) >>> 0;
    } else if (inC.has(op)) {
      const b = fieldOf(word, "b");
      const c = fieldOf(word, "c");
      const moved = inv[c];
      if (moved === undefined) throw new Error("constant index out of range: " + c);
      proto.code[i] = iABC(op, a, b, moved) >>> 0;
    }
  }

  proto.k = order.map((old) => proto.k[old]);
  stats.protos += 1;
  stats.constants += n;
}

function shufflePool(root, opmap, rng) {
  const stats = { protos: 0, constants: 0 };
  shuffleProto(root, opmap, rng, stats);
  return stats;
}

module.exports = { shufflePool, CONST_IN_D, CONST_IN_C };
