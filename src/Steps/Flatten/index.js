"use strict";

/**
 * Control-flow flattening for the loader body.
 *
 * The wrapper's body is a straight line of statements: read the banks, decode
 * the payload, run it. That shape is the easiest part of an artifact to read,
 * so the build rewrites it into a state machine before shipping:
 *
 *   local <S>={[state]=next,...}          -- the edge list, not the order
 *   local <N>=<entry>
 *   while true do
 *     if <N>==nil then break end
 *     if <N>==<s0> then <advance> <chunk0>
 *     elseif <N>==<s1> then <advance> <chunk1>
 *     ...
 *     else <trap> end
 *   end
 *
 * Chunks are emitted in shuffled order, so source order says nothing about
 * execution order; the transition table is the only place the order survives
 * and it is keyed by non-sequential constants. The reachable set is also
 * guarded: entering a block consumes its edge, so replaying a state is a no-op.
 *
 * Locals that are read by a later chunk are hoisted to the body head (an
 * assignment keeps the same semantics); everything else stays where it was, so
 * the function never approaches the 200 local limit.
 */

const luaparse = require("../../Vendor/luaparse");

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

/** biggest non-local function in the artifact is the loader body */
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

/** non-sequential state constants, unique per build */
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

/**
 * Rewrite the loader body of `src` into a dispatched state machine.
 * Returns { applied:false, code:src, reason } when the shape is not found.
 */
function flattenLoader(src, options = {}) {
  const rng = options.rng || Math.random;
  const name = options.name || require("../../Envelope/idents").makeNameFactory(rng);
  const target = options.blocks || 26;
  const maxHoist = options.maxHoist || 180;
  const trap = options.trap || "";

  let ast;
  try {
    ast = parseLua(src);
  } catch (e) {
    return { applied: false, code: src, reason: "parse: " + e.message };
  }

  const loader = findLoader(ast);
  if (!loader) return { applied: false, code: src, reason: "no loader body" };

  const stmts = loader.body.filter((s) => s.type !== "EmptyStatement" && s.range);
  if (stmts.length < 8) return { applied: false, code: src, reason: "loader body too small" };

  const chunks = chunkStatements(stmts, rng, target);
  if (chunks.length < 6) return { applied: false, code: src, reason: "too few blocks" };

  const textOf = (st) => src.slice(st.range[0], st.range[1]);
  const chunkTexts = chunks.map((c) => c.map(textOf).join("\n"));

  // ---- hoisting: a name read by another chunk must live in the body scope ----
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

  const crossChunk = new Set();
  for (const [n, ci] of owner) {
    if ((declCount.get(n) || 0) > 1) continue; // duplicated name stays local
    const re = new RegExp("\\b" + escapeRe(n) + "\\b");
    for (let cj = 0; cj < chunks.length; cj++) {
      if (cj === ci) continue;
      if (re.test(chunkTexts[cj])) {
        crossChunk.add(n);
        break;
      }
    }
  }

  const hoist = new Set();
  for (const st of stmts) {
    const names = declaredNamesOf(st);
    if (!names.length) continue;
    if (!names.some((n) => crossChunk.has(n))) continue;
    // a statement is hoisted whole or not at all: splitting it would change
    // which results land in which name
    if (names.some((n) => (declCount.get(n) || 0) > 1)) continue;
    for (const n of names) hoist.add(n);
  }
  if (hoist.size > maxHoist) return { applied: false, code: src, reason: "hoist budget exceeded" };

  // ---- emission ----
  const usedStates = new Set();
  const freshState = stateFactory(rng, usedStates);
  const states = chunks.map(() => freshState());
  let order = shuffle(rng, chunks.map((_, i) => i));
  // an identity shuffle would leave execution order readable top-to-bottom
  if (order.every((v, i) => v === i)) order = order.slice(1).concat(order[0]);

  const S = name();
  const N = name();
  const T = name();
  const C = name();

  const head = [];
  if (hoist.size) {
    const names = [...hoist];
    // a bare batch: Lua already binds every name to nil, so the trailing
    // "=nil" was six bytes of noise per batch that only made the head of the
    // artifact read like a wall of repetition. Width stays at the seven the
    // template uses everywhere else.
    for (let i = 0; i < names.length; i += 7) head.push(`local ${names.slice(i, i + 7).join(",")}`);
  }
  const edges = [];
  for (let k = 0; k < states.length - 1; k++) edges.push(`[${HEX(states[k])}]=${HEX(states[k + 1])}`);
  head.push(`local ${S}={${edges.join(",")}}`);
  head.push(`local ${N},${T},${C}=${HEX(states[0])},nil,0x0`);

  const stmtText = (st) => {
    const names = declaredNamesOf(st);
    const txt = textOf(st);
    if (!names.length || !names.every((n) => hoist.has(n))) return txt;
    if (st.type === "LocalStatement") {
      if (!st.init || !st.init.length) return ""; // bare declaration, already hoisted
      return txt.replace(/^local\s+/, "");
    }
    return txt.replace(/^local\s+function\s+/, "function ");
  };

  const expected = chunks.length;
  const blocks = order.map((k, i) => {
    const body = chunks[k]
      .map(stmtText)
      .filter((t) => t.length)
      .join(";");
    const advance = `${T}=${N} ${N}=${S}[${T}] ${S}[${T}]=nil ${C}=${C}+1`;
    // the last block in *execution* order is the one that carries the loader's
    // own tail, so the traversal audit has to happen before it runs
    const audit = k === chunks.length - 1 ? `if ${C}~=${HEX(expected)} then ${trap} end` : "";
    return `${i === 0 ? "if" : "elseif"} ${N}==${HEX(states[k])} then ${advance} ${audit} ${body}`;
  });

  // The dispatcher bound is a computed, always-true guard: `while true do`
  // advertises "this is a control-flow machine", `#S+C>-1` reads like a
  // progress check and survives a casual read.
  const machine = `while #${S}+${C}>-0x1 do if ${N}==nil then break end ${blocks.join(" ")} else ${trap} end end`;

  const bodyStart = stmts[0].range[0];
  const bodyEnd = stmts[stmts.length - 1].range[1];
  const replacement = head.join(" ") + " " + machine + " ";
  const code = src.slice(0, bodyStart) + replacement + src.slice(bodyEnd);

  return {
    applied: true,
    code,
    stats: {
      blocks: chunks.length,
      statements: stmts.length,
      hoisted: hoist.size,
      states: states.length,
      before: bodyEnd - bodyStart,
      after: replacement.length,
    },
  };
}

module.exports = { flattenLoader, parseLua, findLoader, declaredNamesOf };
