"use strict";

/**
 * Statements: blocks, locals, assignment, branches, loops, returns.
 */

const C = require("./context");
const { MARK_CONTINUE } = require("../../Parser/Luau");

/* ------------------------------------------------------------------ */
/* statements                                                          */
/* ------------------------------------------------------------------ */

function compileBlock(stmts, fs) {
  for (const s of stmts) compileStat(s, fs);
}

function compileStat(node, fs) {
  switch (node.type) {
    case "LocalStatement":
      localStat(node, fs);
      break;
    case "AssignmentStatement":
      assignStat(node, fs);
      break;
    case "CallStatement": {
      const expr = node.expression;
      const isContinue = expr.type === "CallExpression" &&
        expr.base.type === "Identifier" && expr.base.name === MARK_CONTINUE &&
        expr.arguments.length === 0;
      if (isContinue) {
        if (!fs.loops.length) throw new Error("continue outside loop");
        fs.loops[fs.loops.length - 1].cont.push(C.emitAD(fs, "JMP", 0, 0));
        break;
      }
      C.callInto(fs, expr, fs.free, 1);
      break;
    }
    case "IfStatement":
      ifStat(node, fs);
      break;
    case "WhileStatement":
      whileStat(node, fs);
      break;
    case "RepeatStatement":
      repeatStat(node, fs);
      break;
    case "DoStatement":
      C.enterBlock(fs);
      compileBlock(node.body, fs);
      C.leaveBlock(fs);
      break;
    case "ForNumericStatement":
      forNumeric(node, fs);
      break;
    case "ForGenericStatement":
      forGeneric(node, fs);
      break;
    case "FunctionDeclaration":
      funcDecl(node, fs);
      break;
    case "ReturnStatement":
      returnStat(node, fs);
      break;
    case "BreakStatement": {
      if (!fs.loops.length) throw new Error("break outside loop");
      fs.loops[fs.loops.length - 1].breaks.push(C.emitAD(fs, "JMP", 0, 0));
      break;
    }
    case "EmptyStatement":
      break;
    default:
      throw new Error("unsupported statement " + node.type);
  }
}

function localStat(node, fs) {
  const names = node.variables;
  const init = node.init;
  if (!init.length) {
    for (const v of names) {
      const reg = fs.free++;
      C.emitAD(fs, "LOADNIL", reg, 0);
      C.declareLocal(fs, v.name, reg, fs.boxed.has(v.name));
      if (fs.boxed.has(v.name)) C.emitABC(fs, "BOX", reg, 0, 0);
    }
    return;
  }

  const base = fs.free;
  if (init.length === 1 && C.lastIsMulti(init[0]) && names.length !== 1) {
    fs.free = base;
    if (init[0].type === "VarargLiteral") C.emitABC(fs, "VARARG", base, names.length + 1, 0);
    else C.callInto(fs, init[0], base, names.length + 1);
    for (let i = 0; i < names.length; i++) {
      const reg = base + i;
      C.declareLocal(fs, names[i].name, reg, fs.boxed.has(names[i].name));
      if (fs.boxed.has(names[i].name)) C.emitABC(fs, "BOX", reg, 0, 0);
    }
    fs.free = base + names.length;
    return;
  }

  fs.free = base + names.length;
  for (let i = 0; i < names.length; i++) {
    const reg = base + i;
    if (i < init.length) C.exp2reg(fs, init[i], reg);
    else C.emitAD(fs, "LOADNIL", reg, 0);
  }
  for (let i = 0; i < names.length; i++) {
    const reg = base + i;
    C.declareLocal(fs, names[i].name, reg, fs.boxed.has(names[i].name));
    if (fs.boxed.has(names[i].name)) C.emitABC(fs, "BOX", reg, 0, 0);
  }
  fs.free = base + names.length;
}

function assignTarget(fs, target, valueReg) {
  if (target.type === "Identifier") {
    const loc = C.findLocal(fs, target.name);
    if (loc) {
      if (loc.boxed) C.emitABC(fs, "BOXSET", loc.reg, valueReg, 0);
      else C.emitABC(fs, "MOVE", loc.reg, valueReg, 0);
      return;
    }
    const up = C.resolveUpval(fs, target.name);
    if (up >= 0) {
      C.emitABC(fs, "SETUPVAL", valueReg, up, 0);
      return;
    }
    C.emitAD(fs, "SETGLOBAL", valueReg, C.konst(fs, target.name));
    return;
  }
  if (target.type === "IndexExpression") {
    const obj = fs.free++;
    C.exp2reg(fs, target.base, obj);
    const k = C.constIndexOf(fs, target.index);
    if (k >= 0) {
      C.emitABC(fs, "SETTABLEC", obj, valueReg, k);
      fs.free -= 1;
      return;
    }
    const key = fs.free++;
    C.exp2reg(fs, target.index, key);
    C.emitABC(fs, "SETTABLE", obj, key, valueReg);
    fs.free -= 2;
    return;
  }
  if (target.type === "MemberExpression") {
    const obj = fs.free++;
    C.exp2reg(fs, target.base, obj);
    const k = C.konst(fs, target.identifier.name);
    if (k < 256) {
      C.emitABC(fs, "SETTABLEC", obj, valueReg, k);
      fs.free -= 1;
      return;
    }
    const key = fs.free++;
    C.emitAD(fs, "LOADK", key, k);
    C.emitABC(fs, "SETTABLE", obj, key, valueReg);
    fs.free -= 2;
    return;
  }
  throw new Error("unsupported assignment target " + target.type);
}

function assignStat(node, fs) {
  const vars = node.variables;
  const init = node.init;
  const base = fs.free;

  if (init.length === 1 && C.lastIsMulti(init[0])) {
    if (init[0].type === "VarargLiteral") C.emitABC(fs, "VARARG", base, vars.length + 1, 0);
    else C.callInto(fs, init[0], base, vars.length + 1);
    for (let i = 0; i < vars.length; i++) {
      fs.free = base + vars.length;
      assignTarget(fs, vars[i], base + i);
    }
    fs.free = base;
    return;
  }

  fs.free = base + vars.length;
  for (let i = 0; i < vars.length; i++) {
    if (i < init.length) C.exp2reg(fs, init[i], base + i);
    else C.emitAD(fs, "LOADNIL", base + i, 0);
  }
  for (let i = 0; i < vars.length; i++) {
    fs.free = base + vars.length;
    assignTarget(fs, vars[i], base + i);
  }
  fs.free = base;
}

function ifStat(node, fs) {
  const exits = [];
  C.enterBlock(fs);
  for (let i = 0; i < node.clauses.length; i++) {
    const clause = node.clauses[i];
    const isElse = clause.type === "ElseClause";
    if (!isElse) {
      const r = fs.free++;
      C.exp2reg(fs, clause.condition, r);
      C.emitABC(fs, "TEST", r, 0, 0);
      fs.free--;
    }
    const skip = isElse ? -1 : C.emitAD(fs, "JMP", 0, 0);
    compileBlock(clause.body, fs);
    if (isElse) break;
    exits.push(C.emitAD(fs, "JMP", 0, 0));
    C.patchJump(fs, skip, fs.proto.code.length);
  }
  for (const e of exits) C.patchJump(fs, e, fs.proto.code.length);
  C.leaveBlock(fs);
}

function whileStat(node, fs) {
  const top = fs.proto.code.length;
  const r = fs.free++;
  C.exp2reg(fs, node.condition, r);
  fs.free--;
  C.emitABC(fs, "TEST", r, 0, 0);
  const exit = C.emitAD(fs, "JMP", 0, 0);
  fs.loops.push({ breaks: [], cont: [] });
  C.enterBlock(fs);
  compileBlock(node.body, fs);
  C.leaveBlock(fs);
  const back = C.emitAD(fs, "JMP", 0, 0);
  C.patchJump(fs, back, top);
  C.patchJump(fs, exit, fs.proto.code.length);
  const loopRec = fs.loops.pop();
  for (const b of loopRec.breaks) C.patchJump(fs, b, fs.proto.code.length);
  for (const c of loopRec.cont) C.patchJump(fs, c, top);
}

function repeatStat(node, fs) {
  const top = fs.proto.code.length;
  fs.loops.push({ breaks: [], cont: [] });
  C.enterBlock(fs);
  compileBlock(node.body, fs);
  const condAt = fs.proto.code.length;
  const r = fs.free++;
  C.exp2reg(fs, node.condition, r);
  fs.free--;
  C.emitABC(fs, "TEST", r, 0, 0); // truthy -> skip the back jump, falsy -> loop
  const back = C.emitAD(fs, "JMP", 0, 0);
  C.patchJump(fs, back, top);
  C.leaveBlock(fs);
  const loopRec = fs.loops.pop();
  for (const b of loopRec.breaks) C.patchJump(fs, b, fs.proto.code.length);
  for (const c of loopRec.cont) C.patchJump(fs, c, condAt);
}

function forNumeric(node, fs) {
  const base = fs.free;
  C.exp2reg(fs, node.start, base);
  C.exp2reg(fs, node.end, base + 1);
  if (node.step) C.exp2reg(fs, node.step, base + 2);
  else C.emitAD(fs, "LOADK", base + 2, C.konst(fs, 1));
  fs.free = base + 3;

  const prep = C.emitAD(fs, "FORPREP", base, 0);
  const body = fs.proto.code.length;
  fs.loops.push({ breaks: [], cont: [] });
  C.enterBlock(fs);
  // the control variable only needs a cell when a closure can see it; boxing it
  // unconditionally costs one table per iteration of every numeric loop
  const varBoxed = fs.boxed.has(node.variable.name);
  C.declareLocal(fs, node.variable.name, base + 3, varBoxed);
  if (varBoxed) C.emitABC(fs, "BOX", base + 3, 0, 0);
  fs.free = base + 4;
  compileBlock(node.body, fs);
  C.leaveBlock(fs);
  const loop = C.emitAD(fs, "FORLOOP", base, 0);
  C.patchJump(fs, prep, loop);
  C.patchJump(fs, loop, body);
  const loopRec = fs.loops.pop();
  for (const b of loopRec.breaks) C.patchJump(fs, b, fs.proto.code.length);
  for (const c of loopRec.cont) C.patchJump(fs, c, loop);
  fs.free = base;
}

function forGeneric(node, fs) {
  const base = fs.free;
  const iters = node.iterators;
  let expanded = false;
  for (let i = 0; i < iters.length && i < 3; i++) {
    const slot = base + i;
    fs.free = Math.max(fs.free, slot + 1);
    if (i === iters.length - 1 && C.lastIsMulti(iters[i])) {
      // exactly three slots: the control variable must be cleared, not stale
      if (iters[i].type === "VarargLiteral") C.emitABC(fs, "VARARG", slot, 4, 0);
      else C.callInto(fs, iters[i], slot, 4);
      expanded = true;
    } else {
      C.exp2reg(fs, iters[i], slot);
    }
  }
  if (!expanded) {
    for (let i = Math.min(iters.length, 3); i < 3; i++) C.emitAD(fs, "LOADNIL", base + i, 0);
  }
  fs.free = base + 3;

  const call = fs.proto.code.length;
  C.emitABC(fs, "TFORCALL", base, node.variables.length, 0);
  const loop = C.emitAD(fs, "TFORLOOP", base, 0);
  const toEnd = C.emitAD(fs, "JMP", 0, 0);

  const body = fs.proto.code.length;
  fs.loops.push({ breaks: [], cont: [] });
  C.enterBlock(fs);
  for (let i = 0; i < node.variables.length; i++) {
    C.declareLocal(fs, node.variables[i].name, base + 3 + i, true);
  }
  fs.free = base + 3 + node.variables.length;
  compileBlock(node.body, fs);
  C.leaveBlock(fs);

  const back = C.emitAD(fs, "JMP", 0, 0);
  C.patchJump(fs, back, call);
  C.patchJump(fs, loop, body);
  C.patchJump(fs, toEnd, fs.proto.code.length);
  const loopRec = fs.loops.pop();
  for (const b of loopRec.breaks) C.patchJump(fs, b, fs.proto.code.length);
  for (const c of loopRec.cont) C.patchJump(fs, c, back);
  fs.free = base;
}

function funcDecl(node, fs) {
  const name = node.identifier.type === "Identifier" ? node.identifier.name : null;
  if (node.isLocal && name) {
    const reg = fs.free++;
    const boxed = fs.boxed.has(name);
    C.declareLocal(fs, name, reg, boxed);
    C.emitAD(fs, "LOADNIL", reg, 0);
    if (boxed) C.emitABC(fs, "BOX", reg, 0, 0);
    const tmp = fs.free++;
    C.closureInto(fs, node, tmp);
    assignTarget(fs, node.identifier, tmp);
    fs.free = reg + 1;
    return;
  }
  const tmp = fs.free++;
  C.closureInto(fs, node, tmp);
  assignTarget(fs, node.identifier, tmp);
  fs.free = tmp;
}

function returnStat(node, fs) {
  const args = node.arguments;
  if (!args.length) {
    C.emitABC(fs, "RETURN", 1, 1, 0);
    return;
  }
  const base = fs.free;
  if (args.length === 1 && C.lastIsMulti(args[0])) {
    if (args[0].type === "VarargLiteral") {
      C.emitABC(fs, "VARARG", base, 0, 0);
      C.emitABC(fs, "RETURN", base, 0, 0);
    } else {
      C.callInto(fs, args[0], base, 0);
      C.emitABC(fs, "RETURN", base, 0, 0);
    }
    return;
  }
  for (let i = 0; i < args.length; i++) C.exp2reg(fs, args[i], base + i);
  C.emitABC(fs, "RETURN", base, args.length + 1, 0);
}

Object.assign(C, {
  compileBlock,
  compileStat,
  localStat,
  assignTarget,
  assignStat,
  ifStat,
  whileStat,
  repeatStat,
  forNumeric,
  forGeneric,
  funcDecl,
  returnStat,
});
