"use strict";

/**
 * Instruction emitting: protos, the constant pool and jump patching.
 */

const C = require("./context");
const { BASE, iABC, iAD } = require("../Image/opcodes");

/* ------------------------------------------------------------------ */
/* function state                                                      */
/* ------------------------------------------------------------------ */


function newProto() {
  return { code: [], k: [], numParams: 0, isVararg: false, uv: [], child: [] };
}

function newFunc(parent, ops, boxed, dedupe, readonly) {
  return {
    proto: newProto(),
    parent,
    ops,
    boxed,
    readonly: readonly || (parent && parent.readonly) || new Set(),
    uvKind: [],
    dedupe: dedupe !== false,
    free: 1,
    locals: [],
    blocks: [],
    upmap: new Map(),
    kmap: new Map(),
    loops: [],
  };
}


function emit(fs, word) {
  fs.proto.code.push(word >>> 0);
  return fs.proto.code.length - 1;
}

function emitABC(fs, op, a, b, c) {
  return emit(fs, iABC(fs.ops[op], a || 0, b || 0, c || 0));
}

function emitAD(fs, op, a, d) {
  return emit(fs, iAD(fs.ops[op], a || 0, d || 0));
}

/** point a JMP/FORPREP style instruction at a code index */
function patchD(fs, at, target) {
  const d = target - at - 1;
  if (d < -32768 || d > 32767) {
    throw new Error(
      `jump out of range (${d}, limit +/-32767): one Lua function in the payload compiles past the 24-bit instruction field - split it into smaller functions`
    );
  }
  fs.proto.code[at] = iAD(fs.ops[opName(fs, at)], 0, d) >>> 0;
}

function opName(fs, at) {
  const word = fs.proto.code[at];
  const raw = word % 256;
  for (const name of Object.keys(fs.ops)) if (fs.ops[name] === raw) return name;
  throw new Error("unknown opcode " + raw);
}

/** rewrite only the D field, keeping the opcode */
function patchJump(fs, at, target) {
  const word = fs.proto.code[at];
  const op = word % 256;
  const a = Math.floor(word / 256) % 256;
  const d = target - at - 1;
  if (d < -32768 || d > 32767) {
    throw new Error(
      `jump out of range (${d}, limit +/-32767): one Lua function in the payload compiles past the 24-bit instruction field - split it into smaller functions`
    );
  }
  fs.proto.code[at] = iAD(op, a, d) >>> 0;
}

function konst(fs, value) {
  const key = typeof value + ":" + String(value);
  if (fs.dedupe && fs.kmap.has(key)) return fs.kmap.get(key);
  const idx = fs.proto.k.length;
  if (typeof value === "number") fs.proto.k.push({ t: "number", v: value });
  else if (typeof value === "boolean") fs.proto.k.push({ t: "boolean", v: value });
  else fs.proto.k.push({ t: "string", v: String(value) });
  fs.kmap.set(key, idx);
  return idx;
}

Object.assign(C, {
  newProto,
  newFunc,
  emit,
  emitABC,
  emitAD,
  patchD,
  opName,
  patchJump,
  konst,
});
