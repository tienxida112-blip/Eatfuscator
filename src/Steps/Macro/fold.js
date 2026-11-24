"use strict";

const luaparse = require("../../Vendor/luaparse");

function constEval(node) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "BooleanLiteral") return !!node.value;
  if (node.type === "NilLiteral") return false;
  if (node.type === "UnaryExpression" && node.operator === "not") {
    const inner = constEval(node.argument);
    return inner === null ? null : !inner;
  }
  if (node.type === "BinaryExpression" && (node.operator === "and" || node.operator === "or")) {
    const left = constEval(node.left);
    if (left === null) return null;
    if (node.operator === "and") return left ? null : false;
    return left ? true : null;
  }
  return null;
}

function declaresAtTop(block) {
  for (const s of block || []) {
    if (!s) continue;
    if (s.type === "LocalStatement") return true;
    if (s.type === "FunctionDeclaration" && s.isLocal) return true;
    if (s.type === "ForNumericStatement" || s.type === "ForGenericStatement" || s.type === "LocalStatement") return true;
  }
  return false;
}

const textOf = (src, block) => (block || []).map((s) => src.slice(s.range[0], s.range[1])).join(" ");

function fold(source) {
  let ast;
  try {
    ast = luaparse.parse(source, { luaVersion: "5.1", comments: false, locations: false, ranges: true });
  } catch (e) {
    return { code: source, folded: 0, reason: String(e.message).split("\n")[0] };
  }

  const edits = [];

  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);

    if (node.type === "IfStatement") {

      let taken = [];
      let decided = true;
      for (const clause of node.clauses) {
        if (clause.type === "ElseClause") {
          taken = clause.body;
          decided = true;
          break;
        }
        const value = constEval(clause.condition);
        if (value === null) {
          decided = false;
          break;
        }
        if (value) {
          taken = clause.body;
          decided = true;
          break;
        }
      }
      if (decided && !(taken.length && declaresAtTop(taken))) {
        edits.push({ start: node.range[0], end: node.range[1], text: textOf(source, taken) });
      }

      for (const clause of node.clauses) clause.body.forEach(walk);
      return;
    }

    if (node.type === "WhileStatement" && constEval(node.condition) === false) {
      edits.push({ start: node.range[0], end: node.range[1], text: "" });
      return;
    }

    for (const k in node) {
      if (k === "loc" || k === "range") continue;
      const v = node[k];
      if (v && typeof v === "object") walk(v);
    }
  })(ast);

  if (!edits.length) return { code: source, folded: 0, reason: null };

  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of edits) out = out.slice(0, e.start) + e.text + " " + out.slice(e.end);
  return { code: out, folded: edits.length, reason: null };
}

module.exports = { fold, constEval };
