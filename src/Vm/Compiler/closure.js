"use strict";

/**
 * Closures: capture inventory and the child proto.
 */

const C = require("./context");

/* ------------------------------------------------------------------ */
/* closures                                                            */
/* ------------------------------------------------------------------ */

function closureInto(fs, node, dst) {
  const params = node.parameters.slice();
  const isMethod = node.identifier && node.identifier.type === "MemberExpression" && node.identifier.indexer === ":";
  if (isMethod) params.unshift({ type: "Identifier", name: "self" });

  const child = C.newFunc(fs, fs.ops, fs.boxed, fs.dedupe, fs.readonly);
  const idx = fs.proto.child.length;
  fs.proto.child.push(child.proto);

  child.proto.isVararg = false;
  let reg = 1;
  for (const p of params) {
    if (p.type === "VarargLiteral") {
      child.proto.isVararg = true;
      continue;
    }
    child.proto.numParams++;
    const boxed = child.boxed.has(p.name);
    C.declareLocal(child, p.name, reg, boxed);
    if (boxed) C.emitABC(child, "BOX", reg, 0, 0);
    reg++;
  }
  child.free = reg;
  C.enterBlock(child);
  C.compileBlock(node.body, child);
  C.leaveBlock(child);
  C.emitABC(child, "RETURN", 1, 1, 0);

  C.emitAD(fs, "CLOSURE", dst, idx);
}

Object.assign(C, {
  closureInto,
});
