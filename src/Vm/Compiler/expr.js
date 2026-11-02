"use strict";

/**
 * Expressions: literals, arithmetic, tables, indexing and calls.
 */

const C = require("./context");

// arithmetic ops that have a constant-operand twin
const ARITH_K = { ADD: "ADDK", SUB: "SUBK", MUL: "MULK", DIV: "DIVK", MOD: "MODK" };

/** constant index for a literal node, or -1 when it must go through a register */
function constIndexOf(fs, node) {
  if (node.type === "NumericLiteral" || node.type === "NumberLiteral" || node.type === "StringLiteral") {
    const idx = C.konst(fs, node.value);
    return idx < 256 ? idx : -1;
  }
  return -1;
}

const ARITH = {
  "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "%": "MOD", "^": "POW", "..": "CONCAT",
};

const COMPARE = {
  "==": "EQ", "~=": "NE", "<": "LT", "<=": "LE", ">": "GT", ">=": "GE",
};

/* ------------------------------------------------------------------ */
/* expressions                                                         */
/* ------------------------------------------------------------------ */

function exp2reg(fs, node, dst) {
  const save = fs.free;
  // writing into a live local must not drag the scratch stack down onto the
  // registers above it: temps always start above every live value
  fs.free = Math.max(fs.free, dst + 1);

  switch (node.type) {
    case "NilLiteral":
      C.emitAD(fs, "LOADNIL", dst, 0);
      break;
    case "BooleanLiteral":
      C.emitABC(fs, "LOADBOOL", dst, node.value ? 1 : 0, 0);
      break;
    case "NumericLiteral":
    case "StringLiteral":
      C.emitAD(fs, "LOADK", dst, C.konst(fs, node.value));
      break;
    case "VarargLiteral":
      C.emitABC(fs, "VARARG", dst, 2, 0);
      break;
    case "Identifier":
      expIdent(fs, node.name, dst);
      break;
    case "IndexExpression": {
      const base = fs.free++;
      const key = fs.free++;
      exp2reg(fs, node.base, base === dst ? base : base);
      exp2reg(fs, node.index, key);
      C.emitABC(fs, "GETTABLE", dst, base, key);
      break;
    }
    case "MemberExpression": {
      const base = fs.free++;
      exp2reg(fs, node.base, base);
      const k = C.konst(fs, node.identifier.name);
      if (k < 256) {
        C.emitABC(fs, "GETTABLEC", dst, base, k);
        break;
      }
      const key = fs.free++;
      C.emitAD(fs, "LOADK", key, k);
      C.emitABC(fs, "GETTABLE", dst, base, key);
      break;
    }
    case "CallExpression":
    case "MethodCallExpression":
      callInto(fs, node, dst, 2); // exactly one result
      break;
    case "TableConstructorExpression":
      tableCtor(fs, node, dst);
      break;
    case "FunctionExpression":
    case "FunctionDeclaration":
      C.closureInto(fs, node, dst);
      break;
    case "LogicalExpression": {
      logical(fs, node, dst);
      break;
    }
    case "BinaryExpression": {
      const op = node.operator;
      if (op === "and" || op === "or") { logical(fs, node, dst); break; }
      if (COMPARE[op]) { compareInto(fs, node, dst); break; }
      if (ARITH[op]) { arithInto(fs, node, dst); break; }
      throw new Error("unsupported binary operator " + op);
    }
    case "UnaryExpression": {
      const r = fs.free++;
      exp2reg(fs, node.argument, r);
      if (node.operator === "-") C.emitABC(fs, "UNM", dst, r, 0);
      else if (node.operator === "not") C.emitABC(fs, "NOT", dst, r, 0);
      else if (node.operator === "#") C.emitABC(fs, "LEN", dst, r, 0);
      else throw new Error("unsupported unary operator " + node.operator);
      break;
    }
    default:
      throw new Error("unsupported expression " + node.type);
  }

  fs.free = Math.max(save, dst + 1);
  return dst;
}

function expIdent(fs, name, dst) {
  const loc = C.findLocal(fs, name);
  if (loc) {
    if (loc.boxed) C.emitABC(fs, "BOXGET", dst, loc.reg, 0);
    else C.emitABC(fs, "MOVE", dst, loc.reg, 0);
    return;
  }
  const up = C.resolveUpval(fs, name);
  if (up >= 0) {
    C.emitABC(fs, fs.uvKind[up] === "value" ? "GETUPVALV" : "GETUPVAL", dst, up, 0);
    return;
  }
  C.emitAD(fs, "GETGLOBAL", dst, C.konst(fs, name));
}

/**
 * Register holding `node`, without a copy when it already lives in one.
 *
 * A local no closure can see cannot change behind our back, so an arithmetic
 * operand may read it from its home register. Captured locals stay boxed and
 * are read into `scratch`, which also keeps Lua's read-before-call order.
 */
function srcReg(fs, node, scratch) {
  if (node.type === "Identifier") {
    const loc = C.findLocal(fs, node.name);
    if (loc && !loc.boxed) return loc.reg;
  }
  return exp2reg(fs, node, scratch);
}

function arithInto(fs, node, dst) {
  const op = ARITH[node.operator];
  const base = fs.free;
  fs.free = base + 2;
  const ra = srcReg(fs, node.left, base);
  const k = constIndexOf(fs, node.right);
  if (ARITH_K[op] && k >= 0) {
    // `a + 1` is one instruction instead of LOADK + ADD; the literal has no
    // side effects, so folding it into the consumer cannot reorder anything
    C.emitABC(fs, ARITH_K[op], dst, ra, k);
    fs.free = base;
    return;
  }
  const rb = srcReg(fs, node.right, base + 1);
  C.emitABC(fs, op, dst, ra, rb);
  fs.free = base;
}

function compareInto(fs, node, dst) {
  const base = fs.free;
  fs.free = base + 2;
  const ra = srcReg(fs, node.left, base);
  const rb = srcReg(fs, node.right, base + 1);
  // A = 0: skip the false-load when the test holds
  C.emitABC(fs, COMPARE[node.operator], 0, ra, rb);
  C.emitABC(fs, "LOADBOOL", dst, 0, 1);
  C.emitABC(fs, "LOADBOOL", dst, 1, 0);
  fs.free = base;
}

function logical(fs, node, dst) {
  const isAnd = node.operator === "and";
  const base = fs.free++;
  exp2reg(fs, node.left, base);
  // and: falsy keeps the left value, or: truthy keeps the left value
  C.emitABC(fs, "TESTSET", base, base, isAnd ? 0 : 1);
  const jmp = C.emitAD(fs, "JMP", 0, 0);
  exp2reg(fs, node.right, base);
  C.patchJump(fs, jmp, fs.proto.code.length);
  if (dst !== base) C.emitABC(fs, "MOVE", dst, base, 0);
  fs.free = base;
}

function tableCtor(fs, node, dst) {
  const fields = node.fields;
  const save = fs.free;
  C.emitABC(fs, "NEWTABLE", dst, 0, 0);
  const base = dst + 1;
  const kslot = dst + 1;
  const vslot = dst + 2;
  let stored = 0;

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.type === "TableValue") {
      if (i === fields.length - 1 && lastIsMulti(f.value)) {
        fs.free = Math.max(save, base);
        if (f.value.type === "VarargLiteral") C.emitABC(fs, "VARARG", base, 0, 0);
        else callInto(fs, f.value, base, 0);
        C.emitABC(fs, "SETLIST", dst, 0, stored % 256);
        fs.free = save;
        return;
      }
      fs.free = Math.max(save, base + 1);
      exp2reg(fs, f.value, base);
      const kidx = C.konst(fs, stored + 1);
      if (kidx < 256) C.emitABC(fs, "SETTABLEC", dst, base, kidx);
      else {
        C.emitAD(fs, "LOADK", base + 1, kidx);
        C.emitABC(fs, "SETTABLE", dst, base + 1, base);
      }
      stored++;
      fs.free = save;
      continue;
    }
    fs.free = Math.max(save, vslot + 1);
    let constKey = -1;
    if (f.type === "TableKey") {
      constKey = constIndexOf(fs, f.key);
      if (constKey < 0) exp2reg(fs, f.key, kslot);
    } else constKey = C.konst(fs, f.key.name);
    exp2reg(fs, f.value, vslot);
    if (constKey >= 0 && constKey < 256) C.emitABC(fs, "SETTABLEC", dst, vslot, constKey);
    else C.emitABC(fs, "SETTABLE", dst, kslot, vslot);
    fs.free = save;
  }
  fs.free = save;
}

function isMethodCall(node) {
  if (node.type === "MethodCallExpression") return true;
  return !!(node.base && node.base.type === "MemberExpression" && node.base.indexer === ":");
}

function callInto(fs, node, base, nresults) {
  const save = fs.free;
  let firstArg = base + 1;
  const method = isMethodCall(node);

  if (method) {
    fs.free = Math.max(fs.free, base + 2);
    const obj = fs.free++;
    exp2reg(fs, node.base.base, obj);
    const key = fs.free++;
    C.emitAD(fs, "LOADK", key, C.konst(fs, node.base.identifier.name));
    C.emitABC(fs, "SELF", base, obj, key);
    fs.free = base + 2;
    firstArg = base + 2;
  } else {
    fs.free = Math.max(fs.free, base);
    exp2reg(fs, node.base, base);
    fs.free = base + 1;
  }

  const args = node.arguments;
  let nargs = 0;
  let multi = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const slot = firstArg + i;
    fs.free = Math.max(fs.free, slot);
    if (i === args.length - 1 && lastIsMulti(a)) {
      if (a.type === "VarargLiteral") C.emitABC(fs, "VARARG", slot, 0, 0);
      else callInto(fs, a, slot, 0);
      multi = true;
      nargs = i + 1;
      break;
    }
    exp2reg(fs, a, slot);
    nargs = i + 1;
  }

  const selfCount = method ? 1 : 0;
  C.emitABC(fs, "CALL", base, multi ? 0 : nargs + selfCount + 1, nresults);
  fs.free = save;
}

function lastIsMulti(node) {
  // `(f())` and `(…)` are single values even though the inner node could
  // expand: the parser marks the parentheses for exactly this decision
  if (node.parenthesized) return false;
  return node.type === "CallExpression" || node.type === "MethodCallExpression" || node.type === "VarargLiteral";
}

Object.assign(C, {
  constIndexOf,
  exp2reg,
  expIdent,
  srcReg,
  arithInto,
  compareInto,
  logical,
  tableCtor,
  isMethodCall,
  callInto,
  lastIsMulti,
});
