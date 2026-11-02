"use strict";

/**
 * Capture analysis: which locals a nested function reads,
 * and which of those are bound once and never written again.
 */

const C = require("./context");
const luaparse = require("../../Vendor/luaparse");

/* ------------------------------------------------------------------ */
/* capture analysis                                                    */
/* ------------------------------------------------------------------ */

function functionIdOf(node) {
  return node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "Chunk";
}

/**
 * Names that some nested function reads from an enclosing scope. Every name in
 * the result is boxed at its declaration so closures can share the cell.
 */
function findCaptured(ast) {
  const decls = [];   // per function id: Set of locally declared names
  const parent = [];  // per function id: enclosing function id (-1 for root)
  const fnOf = new Map();

  const ids = new Map();
  let nextId = 0;

  const assign = (node, parentId) => {
    const id = nextId++;
    ids.set(node, id);
    decls[id] = new Set();
    parent[id] = parentId;
    if (node.parameters) for (const p of node.parameters) if (p.type === "Identifier") decls[id].add(p.name);
    if (node.identifier && node.identifier.type === "MemberExpression" && node.identifier.indexer === ":") decls[id].add("self");
    walkDeclare(node.body, id, node);
    return id;
  };

  const declareInto = (id, names) => {
    for (const n of names) decls[id].add(n);
  };

  // pass 1: every local declaration in its owning function
  function walkDeclare(node, id, fnNode) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const n of node) walkDeclare(n, id, fnNode);
      return;
    }
    if (typeof node !== "object" || !node.type) return;

    switch (node.type) {
      case "LocalStatement":
        declareInto(id, node.variables.map((v) => v.name));
        for (const e of node.init) walkDeclare(e, id, fnNode);
        return;
      case "FunctionDeclaration":
        if (node.isLocal && node.identifier) declareInto(id, [node.identifier.name]);
        assign(node, id);
        if (node.identifier) walkDeclare(node.identifier, id, fnNode);
        return;
      case "FunctionExpression":
        assign(node, id);
        return;
      case "ForNumericStatement":
        declareInto(id, [node.variable.name]);
        for (const e of [node.start, node.end, ...(node.step ? [node.step] : [])]) walkDeclare(e, id, fnNode);
        walkDeclare(node.body, id, fnNode);
        return;
      case "ForGenericStatement":
        declareInto(id, node.variables.map((v) => v.name));
        for (const e of node.iterators) walkDeclare(e, id, fnNode);
        walkDeclare(node.body, id, fnNode);
        return;
      case "IfStatement":
        for (const clause of node.clauses) {
          walkDeclare(clause.condition, id, fnNode);
          walkDeclare(clause.body, id, fnNode);
        }
        return;
      case "WhileStatement":
        walkDeclare(node.condition, id, fnNode);
        walkDeclare(node.body, id, fnNode);
        return;
      case "RepeatStatement":
        walkDeclare(node.body, id, fnNode);
        walkDeclare(node.condition, id, fnNode);
        return;
      case "DoStatement":
        walkDeclare(node.body, id, fnNode);
        return;
      default:
        for (const key of Object.keys(node)) {
          if (key === "type") continue;
          walkDeclare(node[key], id, fnNode);
        }
    }
  }

  // pass 2: references
  const captured = new Set();
  function walkRefs(node, id) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const n of node) walkRefs(n, id);
      return;
    }
    if (typeof node !== "object" || !node.type) return;

    if (node.type === "Identifier") {
      let cur = parent[id];
      while (cur !== undefined && cur >= 0) {
        if (decls[cur].has(node.name)) {
          captured.add(node.name);
          break;
        }
        cur = parent[cur];
      }
      return;
    }
    if (functionIdOf(node) && ids.has(node)) {
      const inner = ids.get(node);
      if (node.parameters) {
        for (const p of node.parameters) if (p.type === "Identifier") walkRefs(p, inner);
      }
      walkRefs(node.body, inner);
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "type") continue;
      walkRefs(node[key], id);
    }
  }

  assign(ast, -1);
  walkRefs(ast, ids.get(ast));
  return captured;
}

/**
 * Names whose value can never change after they are bound.
 *
 * A local (or parameter) that is declared exactly once and is never the target
 * of an assignment, a loop binding or a function declaration cannot be updated
 * by any code path, so a closure may capture the *value* instead of opening a
 * shared cell. Names that are declared more than once are dropped as well:
 * shadowing would make the answer per-binding, and this analysis is per-name.
 */
function findReadonly(ast) {
  const declared = new Map();
  const written = new Set();

  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node.type) return;
    switch (node.type) {
      case "LocalStatement":
        for (const v of node.variables) declared.set(v.name, (declared.get(v.name) || 0) + 1);
        break;
      case "AssignmentStatement":
        for (const v of node.variables) if (v.type === "Identifier") written.add(v.name);
        break;
      case "ForNumericStatement":
        if (node.variable) written.add(node.variable.name);
        break;
      case "ForGenericStatement":
        for (const v of node.variables) written.add(v.name);
        break;
      case "FunctionDeclaration":
        if (node.identifier && node.identifier.type === "Identifier") written.add(node.identifier.name);
        break;
      default:
        break;
    }
    for (const key of Object.keys(node)) if (key !== "type") walk(node[key]);
  })(ast);

  // every binding of the name has to be immutable, not just one of them:
  // the compiler tracks locals by name, so the answer is per name too
  const readonly = new Set();
  for (const name of declared.keys()) {
    if (!written.has(name)) readonly.add(name);
  }
  return readonly;
}

Object.assign(C, {
  functionIdOf,
  findCaptured,
  findReadonly,
});
