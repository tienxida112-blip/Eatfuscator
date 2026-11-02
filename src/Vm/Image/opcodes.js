"use strict";

/**
 * Eatfuscator bytecode VM — opcode set (dsc.gg/eatfuscator)
 *
 * The names below are only used at build time. Every build remaps them to a
 * fresh random permutation (see remap()), so the numeric opcodes baked into
 * the artifact differ from build to build while the compiler stays readable.
 */

// The *K forms fold a constant operand into the instruction: `ADDK d b k` is
// `d = b + K[k]`, `GETTABLEC d b k` is `d = b[K[k]]`. They exist because the
// compiler used to spend a whole LOADK on every literal that fed an operator or
// a field read; fusing the load into the consumer removes that instruction
// instead of executing it (the same trick IronBrew2 and Clyde call a
// superoperation, done at emit time rather than as a bytecode rewrite).
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

/** Build a per-build permutation of the opcode space. */
function remap(rng) {
  const values = NAMES.map((_, i) => i + 1);
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = values[i];
    values[i] = values[j];
    values[j] = t;
  }
  const map = {};
  NAMES.forEach((n, i) => {
    map[n] = values[i];
  });
  return map;
}

/* 32-bit instruction word:  op | A<<8 | B<<16 | C<<24   (B/C unsigned bytes)
 *                          op | A<<8 | D<<16           (D signed, biased)  */
function iABC(op, a, b, c) {
  return (op + a * 256 + b * 65536 + c * 16777216) % 4294967296;
}

function iAD(op, a, d) {
  const dd = ((d + 32768) % 65536 + 65536) % 65536;
  return (op + a * 256 + dd * 65536) % 4294967296;
}

module.exports = { NAMES, BASE, remap, iABC, iAD };
