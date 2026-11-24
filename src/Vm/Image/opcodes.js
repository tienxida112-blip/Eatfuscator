"use strict";

const NAMES = [
  "MOVE", "LOADK", "LOADBOOL", "LOADNIL", "BOX", "BOXGET", "BOXSET",
  "GETUPVAL", "GETUPVALV", "SETUPVAL", "GETGLOBAL", "SETGLOBAL",
  "GETTABLE", "GETTABLEC", "SETTABLE", "SETTABLEC", "SETLIST", "NEWTABLE", "SELF",
  "ADD", "SUB", "MUL", "DIV", "MOD", "POW", "UNM", "NOT", "LEN", "CONCAT",
  "ADDK", "SUBK", "MULK", "DIVK", "MODK",
  "EQ", "NE", "LT", "LE", "GT", "GE", "TEST", "TESTSET", "JMP",
  "CALL", "TAILCALL", "RETURN", "CLOSURE", "VARARG",
  "FORPREP", "FORLOOP", "TFORPREP", "TFORCALL", "TFORLOOP",
];

const BASE = Object.freeze(
  NAMES.reduce((acc, name, i) => {
    acc[name] = i + 1;
    return acc;
  }, {})
);

function remap(rng) {
  const pool = [];
  for (let v = 1; v < 256; v++) pool.push(v);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }
  const map = {};
  NAMES.forEach((n, i) => {
    map[n] = pool[i];
  });
  return map;
}

function freeCodepoints(opmap, count) {
  const used = new Set(Object.values(opmap));
  const free = [];
  for (let v = 1; v < 256; v++) if (!used.has(v)) free.push(v);
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = free[i];
    free[i] = free[j];
    free[j] = t;
  }
  return free.slice(0, count);
}

// The instruction word is four bytes, and which byte holds what is a decision
// this build makes, not a constant of the format. The interpreter's field
// extraction is generated from the same layout, so two builds do not share an
// instruction encoding even when they share an opcode numbering.
const MULTS = [1, 256, 65536, 16777216];
const FIELDS = ["op", "a", "b", "c"];
let LAYOUT = { op: 1, a: 256, b: 65536, c: 16777216 };

function setLayout(perm) {
  const next = {};
  for (let i = 0; i < FIELDS.length; i++) next[FIELDS[i]] = MULTS[perm[i]];
  LAYOUT = next;
  return { ...LAYOUT };
}

function getLayout() {
  return { ...LAYOUT };
}

function fieldOf(word, name) {
  const m = LAYOUT[name];
  return ((word - word % m) / m) % 256;
}

function setField(word, name, value) {
  const m = LAYOUT[name];
  return (word - fieldOf(word, name) * m + ((value % 256) + 256) % 256 * m) % 4294967296;
}

function iABC(op, a, b, c) {
  return (op * LAYOUT.op + a * LAYOUT.a + b * LAYOUT.b + c * LAYOUT.c) % 4294967296;
}

function iAD(op, a, d) {
  const dd = ((d + 32768) % 65536 + 65536) % 65536;
  const lo = dd % 256;
  const hi = (dd - lo) / 256;
  return (op * LAYOUT.op + a * LAYOUT.a + lo * LAYOUT.b + hi * LAYOUT.c) % 4294967296;
}

module.exports = { NAMES, BASE, remap, iABC, iAD, freeCodepoints, setLayout, getLayout, fieldOf, setField };
