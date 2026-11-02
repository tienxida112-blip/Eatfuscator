"use strict";

/**
 * Scopes and name resolution, including upvalue descriptors.
 */

const C = require("./context");

/* ------------------------------------------------------------------ */
/* scopes                                                              */
/* ------------------------------------------------------------------ */

function enterBlock(fs) {
  fs.blocks.push({ free: fs.free, nlocals: fs.locals.length });
}

function leaveBlock(fs) {
  const b = fs.blocks.pop();
  fs.free = b.free;
  fs.locals.length = b.nlocals;
}

function declareLocal(fs, name, reg, boxed) {
  fs.locals.push({ name, reg, boxed: !!boxed });
  return fs.locals[fs.locals.length - 1];
}

function findLocal(fs, name) {
  for (let i = fs.locals.length - 1; i >= 0; i--) if (fs.locals[i].name === name) return fs.locals[i];
  return null;
}

function resolveUpval(fs, name) {
  if (fs.upmap.has(name)) return fs.upmap.get(name);
  const parent = fs.parent;
  if (!parent) return -1;
  const loc = findLocal(parent, name);
  if (loc) {
    const idx = fs.proto.uv.length;
    if (!loc.boxed && !fs.readonly.has(name)) {
      throw new Error("captured local '" + name + "' was not boxed");
    }
    // a cell when the value can still change, a copy when it cannot
    const value = !loc.boxed;
    fs.proto.uv.push({ kind: value ? 3 : 1, fromReg: true, idx: loc.reg });
    fs.uvKind[idx] = value ? "value" : "cell";
    fs.upmap.set(name, idx);
    return idx;
  }
  const up = resolveUpval(parent, name);
  if (up < 0) return -1;
  const idx = fs.proto.uv.length;
  const value = parent.uvKind[up] === "value";
  fs.proto.uv.push({ kind: value ? 4 : 2, fromReg: false, idx: up });
  fs.uvKind[idx] = value ? "value" : "cell";
  fs.upmap.set(name, idx);
  return idx;
}

Object.assign(C, {
  enterBlock,
  leaveBlock,
  declareLocal,
  findLocal,
  resolveUpval,
});
