"use strict";

const luaparse = require("../../Vendor/luaparse");

/**
 * Scope-safe identifier renaming on Lua source, driven by the parser instead of
 * by text search.
 *
 * A plain global search-and-replace is not good enough here: the loader embeds
 * long-bracket blobs full of random text that contains every short name, and
 * `{V7=1}` / `t.V7` / `t:V7()` are *field* names, not variables. Renaming those
 * would corrupt table keys and member lookups. So the parser is asked for real
 * identifiers, and member properties and table keys are dropped from the hit
 * list.
 *
 * Renaming only touches positions at or after `fromOffset`, which is what makes
 * it safe for shadowing: everything before the second declaration keeps
 * referring to the first binding, exactly as the original program did.
 */

function collectSkip(ast) {
  const skip = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.type === "MemberExpression") {
      // luaparse names the member side `identifier` for both t.X and t:X.
      const member = node.identifier;
      if (member && typeof member === "object" && member.range) skip.add(member.range[0]);
    } else if (node.type === "TableKeyString" || node.type === "TableKey") {
      if (node.key && node.key.range) skip.add(node.key.range[0]);
    }
    for (const key in node) {
      if (key === "range" || key === "loc" || key === "type") continue;
      visit(node[key]);
    }
  };
  visit(ast);
  return skip;
}

function renameFrom(text, from, to, fromOffset = 0) {
  if (from === to) return { ok: true, code: text, hits: 0 };
  let ast;
  try {
    ast = luaparse.parse(text, { luaVersion: "5.1", ranges: true, comments: false, locations: false, scope: false });
  } catch {
    return { ok: false, code: text, hits: 0, reason: "parse failed" };
  }
  const skip = collectSkip(ast);
  const hits = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.type === "Identifier" && node.name === from && node.range) {
      const at = node.range[0];
      if (at >= fromOffset && !skip.has(at)) hits.push(node.range);
    }
    for (const key in node) {
      if (key === "range" || key === "loc" || key === "type") continue;
      visit(node[key]);
    }
  };
  visit(ast);
  if (!hits.length) return { ok: true, code: text, hits: 0 };
  hits.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [s, e] of hits) {
    if (s < cursor) continue;
    out += text.slice(cursor, s) + to;
    cursor = e;
  }
  out += text.slice(cursor);
  return { ok: true, code: out, hits: hits.length };
}

/** Names declared more than once at the given statement level. */
function duplicateDeclarations(stmts, declaredNamesOf) {
  const count = new Map();
  for (const st of stmts) for (const n of declaredNamesOf(st)) count.set(n, (count.get(n) || 0) + 1);
  return [...count].filter(([, c]) => c > 1).map(([n]) => n);
}

module.exports = { renameFrom, duplicateDeclarations };
