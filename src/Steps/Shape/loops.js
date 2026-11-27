"use strict";

const luaparse = require("../../Vendor/luaparse");

function namesIn(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) namesIn(n, out);
    return out;
  }
  if (node.type === "Identifier") out.add(node.name);
  if (node.type === "GotoStatement" || node.type === "LabelStatement") out.add("\0jump");
  for (const k in node) {
    if (k === "loc" || k === "range") continue;
    const v = node[k];
    if (v && typeof v === "object") namesIn(v, out);
  }
  return out;
}

function declaredIn(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) declaredIn(n, out);
    return out;
  }
  if (node.type === "LocalStatement") for (const id of node.variables) if (id.type === "Identifier") out.add(id.name);
  if (node.type === "ForNumericStatement" && node.variable) out.add(node.variable.name);
  if (node.type === "ForGenericStatement") for (const v of node.variables) if (v.type === "Identifier") out.add(v.name);
  if (node.type === "FunctionDeclaration" && node.identifier && node.identifier.type === "Identifier") out.add(node.identifier.name);
  for (const k in node) {
    if (k === "loc" || k === "range") continue;
    const v = node[k];
    if (v && typeof v === "object") declaredIn(v, out);
  }
  return out;
}

const FLIP = { "==": "~=", "<": ">=", ">": "<", "<=": ">", ">": "<=" };

function negate(src, cond) {
  if (cond.type === "BinaryExpression" && FLIP[cond.operator]) {
    const left = src.slice(cond.left.range[0], cond.left.range[1]);
    const right = src.slice(cond.right.range[0], cond.right.range[1]);
    const op = FLIP[cond.operator];

    const wrapLeft = cond.left.type === "BinaryExpression" || cond.left.type === "LogicalExpression";
    const wrapRight = cond.right.type === "BinaryExpression" || cond.right.type === "LogicalExpression";
    return `${wrapLeft ? `(${left})` : left} ${op} ${wrapRight ? `(${right})` : right}`;
  }
  if (cond.type === "UnaryExpression" && cond.operator === "not") {
    const inner = src.slice(cond.argument.range[0], cond.argument.range[1]);
    return cond.argument.type === "BinaryExpression" || cond.argument.type === "LogicalExpression" ? `(${inner})` : inner;
  }
  return `not (${src.slice(cond.range[0], cond.range[1])})`;
}

function describe(src, node) {
  const cond = node.condition;
  const body = node.body || [];
  const bodyStart = body.length ? body[0].range[0] : node.range[1];
  const bodyEnd = body.length ? body[body.length - 1].range[1] : bodyStart;
  return {
    cond,
    start: node.range[0],
    end: node.range[1],
    condStart: cond.range[0],
    condEnd: cond.range[1],
    bodyStart,
    bodyEnd,
    always: cond.type === "BooleanLiteral" && cond.value === true,
    safe:
      (cond.type === "BooleanLiteral" && cond.value === true) ||
      (() => {
        const used = namesIn(cond);
        if (used.has("\0jump")) return false;
        const inner = declaredIn(body);
        for (const n of used) if (inner.has(n)) return false;
        return true;
      })(),
  };
}

function buildTree(nodes) {
  const sorted = [...nodes].sort((a, b) => a.start - b.start || b.end - a.end);
  const roots = [];
  const stack = [];
  for (const n of sorted) {
    while (stack.length && !(n.start >= stack[stack.length - 1].bodyStart && n.end <= stack[stack.length - 1].bodyEnd)) stack.pop();
    if (stack.length) {
      const parent = stack[stack.length - 1];
      (parent.children || (parent.children = [])).push(n);
    } else roots.push(n);
    stack.push(n);
  }
  return roots;
}

function render(src, start, end, nodes) {
  let out = "";
  let pos = start;
  for (const n of nodes) {
    out += src.slice(pos, n.start) + renderOne(src, n);
    pos = n.end;
  }
  return out + src.slice(pos, end);
}

function renderOne(src, n) {
  const body = render(src, n.bodyStart, n.bodyEnd, n.children || []);

  if (n.opaque) return src.slice(n.start, n.bodyStart) + body + src.slice(n.bodyEnd, n.end);
  const test = n.always ? "false" : negate(src, n.cond);
  const head = n.always ? "" : `if ${src.slice(n.condStart, n.condEnd)} then `;
  const tail = n.always ? "" : " end";
  return `${head}repeat ${body} until ${test}${tail}`;
}

function whileToRepeat(source) {
  let ast;
  try {
    ast = luaparse.parse(source, { luaVersion: "5.1", comments: false, locations: false, ranges: true });
  } catch (e) {
    return { code: source, rewritten: 0, skipped: 0, reason: String(e.message).split("\n")[0] };
  }

  const found = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === "WhileStatement") found.push(describe(source, node));
    for (const k in node) {
      if (k === "loc" || k === "range") continue;
      const v = node[k];
      if (v && typeof v === "object") walk(v);
    }
  })(ast);

  if (!found.length) return { code: source, rewritten: 0, skipped: 0, reason: null };

  for (const n of found) if (!n.safe) n.opaque = true;
  const out = render(source, 0, source.length, buildTree(found));

  const rewritten = found.filter((n) => n.safe).length;
  return { code: out, rewritten, skipped: found.length - rewritten, reason: null };
}

function shapeCensus(source) {
  const census = { while: 0, repeat: 0, forNumeric: 0, forGeneric: 0, ifStmt: 0, doBlock: 0, functions: 0, parseError: null };
  let ast;
  try {
    ast = luaparse.parse(source, { luaVersion: "5.1", comments: false, locations: false, ranges: true });
  } catch (e) {
    census.parseError = String(e.message).split("\n")[0];
    census.while = (source.match(/(^|[^A-Za-z0-9_])while([^A-Za-z0-9_]|$)/g) || []).length;
    return census;
  }
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "WhileStatement") census.while++;
    else if (n.type === "RepeatStatement") census.repeat++;
    else if (n.type === "ForNumericStatement") census.forNumeric++;
    else if (n.type === "ForGenericStatement") census.forGeneric++;
    else if (n.type === "IfStatement") census.ifStmt++;
    else if (n.type === "DoStatement") census.doBlock++;
    else if (n.type === "FunctionDeclaration") census.functions++;
    for (const k in n) {
      if (k === "loc" || k === "range") continue;
      const v = n[k];
      if (v && typeof v === "object") walk(v);
    }
  })(ast);
  return census;
}

module.exports = { whileToRepeat, shapeCensus };
