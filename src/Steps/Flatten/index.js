"use strict";

const luaparse = require("../../Vendor/luaparse");
const { renameFrom } = require("./rename");

function parseLua(src) {
  return luaparse.parse(src, {
    luaVersion: "5.1",
    ranges: true,
    comments: false,
    scope: false,
    locations: false,
  });
}

function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit);
    return;
  }
  visit(node);
  for (const key in node) {
    if (key === "range") continue;
    walkAst(node[key], visit);
  }
}

function findLoader(ast) {
  let best = null;
  walkAst(ast, (n) => {
    if (n.type !== "FunctionDeclaration" || n.isLocal || !Array.isArray(n.body)) return;
    if (n.body.length < 6) return;
    const span = n.range[1] - n.range[0];
    if (!best || span > best.span) best = { span, node: n };
  });
  return best ? best.node : null;
}

function declaredNamesOf(st) {
  if (st.type === "LocalStatement") return st.variables.map((v) => v.name);
  if (st.type === "FunctionDeclaration" && st.isLocal && st.identifier) return [st.identifier.name];
  return [];
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function stateFactory(rng, used) {
  return function fresh() {
    for (let i = 0; i < 4096; i++) {
      const v = 0x1000 + ((rng() * 0x7fff00) | 0);
      if (used.has(v)) continue;
      used.add(v);
      return v;
    }
    return 0x2000 + used.size;
  };
}

const HEX = (n) => "0x" + (n >>> 0).toString(16).toUpperCase();

function chunkStatements(stmts, rng, target) {
  const want = Math.max(6, Math.min(stmts.length, target));
  const per = stmts.length / want;
  const chunks = [];
  let i = 0;
  while (i < stmts.length) {
    let take = Math.max(1, Math.round(per));
    if (rng() < 0.35) take -= 1;
    if (rng() < 0.2) take += 1;
    take = Math.max(1, Math.min(take, stmts.length - i));
    chunks.push(stmts.slice(i, i + take));
    i += take;
  }
  return chunks;
}

function flattenLoader(src, options = {}) {

  if (typeof options.rng !== "function") {
    throw new Error("flattenLoader: a seeded rng is required (no Math.random fallback)");
  }
  const rng = options.rng;
  const name = options.name || require("../../Envelope/idents").makeNameFactory(rng);
  const target = options.blocks || 26;
  // The loader grew (sampled catalogue, engine-semantics checks), so the budget
  // for cross-block names grew with it: at 180 the flattener started skipping
  // whole builds, which is a silent loss of the strongest control-flow pass.
  const maxHoist = options.maxHoist || 260;
  const trap = options.trap || "";

  // The split below hoists cross-block locals to function scope, which is only
  // sound when each name has exactly one declaration at that level. The loader
  // generator does sometimes shadow a name (`local V7 = pool[26]` followed much
  // later by `local function V7`), and shadowing is legal Lua but fatal once the
  // blocks are separated. Rename the later bindings first (parser-driven, so
  // table keys, member names and blob text are untouched), then analyse.
  let work = src;
  const renames = [];
  for (let pass = 0; pass < 12; pass++) {
    let ast;
    try {
      ast = parseLua(work);
    } catch (e) {
      return { applied: false, code: src, reason: "parse: " + e.message };
    }
    const probe = findLoader(ast);
    if (!probe) return { applied: false, code: src, reason: "no loader body" };
    const level = probe.body.filter((s) => s.type !== "EmptyStatement" && s.range);
    const counts = new Map();
    const sites = new Map();
    for (const st of level) {
      for (const n of declaredNamesOf(st)) {
        counts.set(n, (counts.get(n) || 0) + 1);
        if (!sites.has(n)) sites.set(n, []);
        sites.get(n).push(st.range[0]);
      }
    }
    const dup = [...counts.keys()].find((n) => counts.get(n) > 1);
    if (!dup) break;
    const secondAt = sites.get(dup)[1];
    const fresh = name();
    const res = renameFrom(work, dup, fresh, secondAt);
    if (!res.ok || !res.hits) {
      return { applied: false, code: src, reason: `cannot de-shadow ${dup}` };
    }
    renames.push(`${dup}->${fresh}`);
    work = res.code;
  }

  let ast;
  try {
    ast = parseLua(work);
  } catch (e) {
    return { applied: false, code: src, reason: "parse: " + e.message };
  }

  const loader = findLoader(ast);
  if (!loader) return { applied: false, code: src, reason: "no loader body" };

  const stmts = loader.body.filter((s) => s.type !== "EmptyStatement" && s.range);
  if (stmts.length < 8) return { applied: false, code: src, reason: "loader body too small" };

  const chunks = chunkStatements(stmts, rng, target);
  if (chunks.length < 6) return { applied: false, code: src, reason: "too few blocks" };

  const textOf = (st) => work.slice(st.range[0], st.range[1]);
  const chunkTexts = chunks.map((c) => c.map(textOf).join("\n"));

  const owner = new Map();
  const declCount = new Map();
  for (let ci = 0; ci < chunks.length; ci++) {
    for (const st of chunks[ci]) {
      for (const n of declaredNamesOf(st)) {
        declCount.set(n, (declCount.get(n) || 0) + 1);
        if (!owner.has(n)) owner.set(n, ci);
      }
    }
  }

  // Which declared names are *read* by another block? Textual, therefore a
  // superset of the semantic answer, which is the safe direction: it can hoist
  // a name too many, never too few.
  const crossChunk = new Set();
  for (const [n, ci] of owner) {
    const re = new RegExp("\\b" + escapeRe(n) + "\\b");
    for (let cj = 0; cj < chunks.length; cj++) {
      if (cj === ci) continue;
      if (re.test(chunkTexts[cj])) {
        crossChunk.add(n);
        break;
      }
    }
  }

  // A name that other blocks read only survives the split if it is hoisted to
  // function scope. A name declared twice cannot be hoisted (both declaration
  // sites would collapse into one slot), so rather than emit a loader whose
  // later blocks silently read nil, refuse to flatten at all.
  const blocked = [...crossChunk].filter((n) => (declCount.get(n) || 0) > 1);
  if (blocked.length) {
    return {
      applied: false,
      code: src,
      reason: `unhoistable cross-block name${blocked.length > 1 ? "s" : ""}: ${blocked.slice(0, 4).join(", ")}`,
    };
  }

  const hoist = new Set();
  for (const st of stmts) {
    const names = declaredNamesOf(st);
    if (!names.length) continue;
    if (!names.some((n) => crossChunk.has(n))) continue;
    if (names.some((n) => (declCount.get(n) || 0) > 1)) continue;
    for (const n of names) hoist.add(n);
  }
  // Every cross-block read must be covered by the hoist set; anything left over
  // would resolve to a global (nil) once the blocks are separated.
  for (const n of crossChunk) {
    if (!hoist.has(n)) return { applied: false, code: src, reason: `cross-block name not hoisted: ${n}` };
  }
  if (hoist.size > maxHoist) return { applied: false, code: src, reason: "hoist budget exceeded" };

  const usedStates = new Set();
  const freshState = stateFactory(rng, usedStates);
  const states = chunks.map(() => freshState());
  let order = shuffle(rng, chunks.map((_, i) => i));

  if (order.every((v, i) => v === i)) order = order.slice(1).concat(order[0]);

  const S = name();
  const N = name();
  const C = name();
  const K = name();

  const head = [];
  if (hoist.size) {
    const names = [...hoist];

    for (let i = 0; i < names.length; i += 7) head.push(`local ${names.slice(i, i + 7).join(",")}`);
  }
  const T = name();
  head.push(`local ${S}={}`);
  head.push(`local ${N},${C},${K}=${HEX(states[0])},0x0,nil`);

  const stmtText = (st) => {
    const names = declaredNamesOf(st);
    const txt = textOf(st);
    if (!names.length || !names.every((n) => hoist.has(n))) return txt;
    if (st.type === "LocalStatement") {
      if (!st.init || !st.init.length) return "";
      return txt.replace(/^local\s+/, "");
    }
    return txt.replace(/^local\s+function\s+/, "function ");
  };

  // Fold the actual state path, rather than merely counting visits. Skipping or
  // reordering a block no longer preserves the final audit just by matching a count.
  let expected = 0;
  for (const state of states) expected = (expected * 33 + state) % 16777216;
  const regs = [N, K];
  const leaves = order.map((k) => {
    const body = chunks[k]
      .map(stmtText)
      .filter((t) => t.length)
      .join(";");

    const cur = regs[k % 2];
    const nxt = regs[(k + 1) % 2];
    let step;
    if (k + 1 >= states.length) {
      step = `${cur},${nxt}=nil,nil`;
    } else {
      const next = states[k + 1];
      const up = next - states[k];
      const down = states[k] - next;
      const pick = rng();
      let expr;
      if (pick < 0.4) expr = `${HEX(states[k] + next)}-${cur}`;
      else if (pick < 0.7 && up > 0) expr = `${cur}+${HEX(up)}`;
      else if (down > 0) expr = `${cur}-${HEX(down)}`;
      else expr = `${HEX(states[k] + next)}-${cur}`;
      step = `${cur},${nxt}=nil,${expr}`;
    }
    const advance = `${C}=(${C}*33+${cur})%16777216 ${step}`;
    const audit = k === chunks.length - 1 ? `if ${C}~=${HEX(expected)} then ${trap} end` : "";
    return { value: states[k], text: `${advance} ${audit} ${body}` };
  });

  leaves.sort((a, b) => a.value - b.value);

  const tree = (lo, hi, depth) => {
    if (hi - lo === 1) {
      const leaf = leaves[lo];
      return `if ${T}==${HEX(leaf.value)} then ${leaf.text} else ${trap} end`;
    }
    const mid = (lo + hi) >> 1;
    const pivot = leaves[mid - 1].value;
    const low = tree(lo, mid, depth + 1);
    const high = tree(mid, hi, depth + 1);
    const pick = rng();
    if (pick < 0.34) return `if ${T}>=${HEX(leaves[lo].value)} and ${T}<=${HEX(pivot)} then ${low} else ${high} end`;
    if (pick < 0.67) return `if ${T}<=${HEX(pivot)} then ${low} else ${high} end`;
    return `if ${T}>${HEX(pivot)} then ${high} else ${low} end`;
  };

  const machine = `while #${S}+${C}>-0x1 do local ${T}=${N} and ${N} or ${K} if ${T}==nil then break end ${tree(0, leaves.length, 0)} end`;

  const bodyStart = stmts[0].range[0];
  const bodyEnd = stmts[stmts.length - 1].range[1];
  const replacement = head.join(" ") + " " + machine + " ";
  const code = work.slice(0, bodyStart) + replacement + work.slice(bodyEnd);

  return {
    applied: true,
    code,
    stats: {
      blocks: chunks.length,
      statements: stmts.length,
      hoisted: hoist.size,
      states: states.length,
      deshadowed: renames.length,
      before: bodyEnd - bodyStart,
      after: replacement.length,
    },
  };
}

module.exports = { flattenLoader, parseLua, findLoader, declaredNamesOf };
