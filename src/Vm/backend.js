"use strict";

const fs = require("fs");
const path = require("path");
const luaparse = require("../Vendor/luaparse");
const { compile } = require("./Compiler");
const { lowerLuau } = require("../Parser/Luau");
const { serialize } = require("./Image/encoder");
const { shufflePool } = require("./Image/pool");
const { encryptConstants, cipherCode } = require("./Image/cipher");
const { forgeTree } = require("./Image/stackvm");
const { remap, BASE } = require("./Image/opcodes");
const { reorder, inject, tree, varyBodies } = require("./Image/dispatch");

const VM_PATH = path.join(__dirname, "Template", "vm.lua");

function createForgeRng(seed) {
  // The forge layout is per-build like everything else; a fixed fallback keeps
  // direct callers (tests, tools) deterministic without threading an RNG in.
  try {
    const { createRNG } = require("../Core/rng");
    return createRNG(((Number(seed) || 1) ^ 0x2f6b1d3) >>> 0);
  } catch (e) {
    let state = 0x9e3779b9;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }
}

const ALIASES = {
  al_p2: "__V004__",
  al_byte: "__V001__",
  al_sub: "__V003__",
  al_floor: "__V0120__",
  al_unpack: "__V0121__",
  al_select: "__V0106__",
  al_tonum: "__V0122__",
  al_env: "__V000__",
  al_getfenv: "__V0113__",
  al_typekey: "__V0140__",
  al_type: "__V0103__",
  al_next: "__V0109__",
  al_pcall: "__V0107__",
  al_char: "__V002__",
  al_concat: "__V0119__",
  al_code_salt: "__V0160__",
  al_ik2: "__V0161__",
  al_isk: "__V0162__",
  al_str_salt: "__V0163__",
  al_sboxfn: "__V1010__",
  al_schedfn: "__V1020__",
  al_wordenc: "__V1040__",
  al_worddec: "__V1050__",
  al_setmeta: "__V0111__",
  al_index: "__V0130__",
  al_bank: "__V068__",
  al_attest: "__V0880__",
  al_atlas: "__V0882__",
  al_recheck: "__V0881__",
  al_trap: "__V0709__",
};

const RUN_TOKEN = "__V0899__";

function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      out += ch;
      i++;
      while (i < n) {
        out += src[i];
        if (src[i] === "\\") {
          i++;
          if (i < n) out += src[i];
        } else if (src[i] === ch) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "-" && src[i + 1] === "-") {
      const long = /^--\[(=*)\[/.exec(src.slice(i, i + 32));
      if (long) {
        const close = "]" + long[1] + "]";
        const end = src.indexOf(close, i + long[0].length);
        i = end === -1 ? n : end + close.length;
        continue;
      }
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function parseLua(src) {
  return luaparse.parse(src, { luaVersion: "5.1", comments: false, locations: false, ranges: false });
}

function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, fn);
    return;
  }
  if (typeof node.type !== "string") return;
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "loc" || key === "range") continue;
    walk(node[key], fn);
  }
}

function collectDeclared(ast) {
  const names = [];
  const seen = new Set();
  const add = (name) => {
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };
  walk(ast, (node) => {
    if (node.type === "LocalStatement") for (const v of node.variables) add(v.name);
    if (node.type === "FunctionDeclaration") {
      if (node.isLocal && node.identifier && node.identifier.type === "Identifier") add(node.identifier.name);
      for (const p of node.parameters) if (p.type === "Identifier") add(p.name);
    }
    if (node.type === "FunctionExpression") {
      for (const p of node.parameters) if (p.type === "Identifier") add(p.name);
    }
    if (node.type === "ForNumericStatement" && node.variable) add(node.variable.name);
    if (node.type === "ForGenericStatement") for (const v of node.variables) add(v.name);
  });
  return names;
}

function collectIdentifiers(ast) {
  const names = new Map();
  walk(ast, (node) => {
    if (node.type === "Identifier") names.set(node.name, true);
  });
  return [...names.keys()];
}

// Field extraction, generated per build. The four logical fields (opcode, A, B,
// C) sit at four multipliers the build chose; the same extraction written in a
// different order is the same program, so the order is a build decision too.
function emitFields(rngFn) {
  // The bytes are peeled off in order - the cheap shape, one modulo and one
  // subtraction each - and then *named* according to where this build put each
  // field. The layout costs nothing at run time; it only changes which of the
  // four locals the dispatch reads an opcode out of.
  const { getLayout } = require("./Image/opcodes");
  const lay = getLayout();
  const posOf = (m) => ({ 1: 0, 256: 1, 65536: 2, 16777216: 3 })[m];
  const q = (i) => `q${i}`;
  const lines = [
    "    st[T_ONE] = ins % T_B8",
    "    st[T_TWO] = (ins - st[T_ONE]) / T_B8",
    `    local ${q(0)} = st[T_ONE]`,
    "    st[T_ONE] = st[T_TWO] % T_B8",
    "    st[T_TWO] = (st[T_TWO] - st[T_ONE]) / T_B8",
    `    local ${q(1)} = st[T_ONE]`,
    `    local ${q(2)} = st[T_TWO] % T_B8`,
    `    local ${q(3)} = ((st[T_TWO] - ${q(2)}) / T_B8) % T_B8`,
  ];
  const bind = [
    ["o", lay.op],
    ["a", lay.a],
    ["b", lay.b],
    ["c", lay.c],
  ];
  // Bind them in a build-chosen order; the names are still what the handlers read.
  for (let i = bind.length - 1; i > 0; i--) {
    const j = Math.floor(rngFn() * (i + 1));
    const tmp = bind[i];
    bind[i] = bind[j];
    bind[j] = tmp;
  }
  for (const [name, m] of bind) lines.push(`    local ${name} = ${q(posOf(m))}`);
  lines.push("    local ds = b + c * T_B8 - T_BIAS");
  return lines.join("\n");
}

function emitFlip() {
  const { getLayout } = require("./Image/opcodes");
  const m = getLayout().op;
  return [
    `      local opf = (w - w % ${m}) / ${m} % T_B8`,
    `      code[j] = (w - opf * ${m}) + (opf - d[T_DFLIP]) % T_B8 * ${m}`,
  ].join("\n");
}

function vmSource({ opmap, resolve, source, order, decoys, rng, hot, guardProbe }) {
  let src = stripComments(source || fs.readFileSync(VM_PATH, "utf8"));
  // Test hook: break the program's length pin after the digest and the slice
  // marks are computed, which is what a patch made *after* the load looks like.
  // Substituted here, before the identifiers are renamed, so the probe uses the
  // same names the guard does.
  src = src.replace("__GUARDPROBE__ = 0", () => (guardProbe ? "pr[T_MARK + T_ONE] = n + T_ONE" : "do end"));
  if (order && order.length) src = reorder(src, order);
  if (decoys && decoys.length) src = inject(src, decoys);

  // The instruction layout is this build's, so the code that reads it is this
  // build's too: the field extraction and the opcode flip are generated from the
  // same four multipliers the compiler packed the words with.
  {
    const rngFn = typeof rng === "function" ? rng : rng && typeof rng.word === "function" ? () => rng.word() / 4294967296 : Math.random;
    src = src.replace(/^\s*__FIELDS__ = 0\s*$/m, () => emitFields(rngFn));
    src = src.replace(/^\s*__FLIP__ = 0\s*$/m, () => emitFlip());
  }

  src = src.replace(/__OP_([A-Z]+)__/g, (m, name) => {
    if (!(name in opmap)) throw new Error("unknown opcode token " + name);
    return "0x" + opmap[name].toString(16).toUpperCase();
  });

  let variantStats = [];
  {
    const rngFn = typeof rng === "function" ? rng : rng && typeof rng.word === "function" ? () => rng.word() / 4294967296 : Math.random;
    const varied = varyBodies(src, rngFn);
    src = varied.code;
    variantStats = varied.applied;
  }

  let treeStats = null;
  if (!process.env.EAT_CHAIN) {
    const rank = new Map();
    (hot || order || []).forEach((name, i) => {
      const v = opmap[name];
      if (typeof v === "number" && !rank.has(v)) rank.set(v, i);
    });
    const weight = (value) => {
      if (!rank.has(value)) return 1;
      const i = rank.get(value);
      return i < 8 ? 24 : i < 16 ? 6 : 2;
    };
    const built = tree(src, {
      onMiss: "pc = pc - T_ONE",
      weight,
      rng: typeof rng === "function" ? rng : rng && typeof rng.word === "function" ? () => rng.word() / 4294967296 : Math.random,
    });
    if (built.applied) {
      src = built.code;
      treeStats = built.stats;
    }
  }

  const declared = collectDeclared(parseLua(src));
  const toToken = new Map();
  let counter = 0;

  for (const name of declared) {
    toToken.set(name, name === "vm_run" ? RUN_TOKEN : `__V9${600 + counter++}__`);
  }
  for (const [name, tok] of Object.entries(ALIASES)) {
    if (declared.includes(name)) throw new Error("interpreter redeclares runtime alias " + name);
    toToken.set(name, tok);
  }

  const names = [...toToken.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    src = src.replace(new RegExp(`\\b${name}\\b`, "g"), toToken.get(name));
  }

  const leftover = collectIdentifiers(parseLua(src));
  const stray = leftover.filter((n) => !/^__V\d+__$/.test(n));
  const allowed = String(process.env.EAT_ALLOW_IDENTS || "").split(",").filter(Boolean);
  const strayAllowed = allowed.length ? stray.filter((n) => !allowed.includes(n)) : stray;
  if (strayAllowed.length && !process.env.EAT_NOVALIDATE) throw new Error("interpreter leaks identifiers: " + strayAllowed.slice(0, 6).join(", "));

  if (typeof resolve === "function") src = src.replace(/__V\d+__/g, (t) => resolve(t) || t);
  if (process.env.EAT_DUMP_VM) require("fs").writeFileSync(process.env.EAT_DUMP_VM, src);
  vmSource.tree = treeStats;
  vmSource.variants = variantStats;
  return src;
}

function rawWord(rng) {
  if (typeof rng.word === "function") return rng.word() >>> 0;
  return (((rng() * 256) | 0) + (((rng() * 256) | 0) * 256) + (((rng() * 256) | 0) * 65536) + (((rng() * 256) | 0) * 16777216)) >>> 0;
}

function shapedWord(rng, ops) {
  const pool = ops || null;
  const op = pool ? pool[(rng() * pool.length) | 0] : rawWord(rng) % 256;
  const a = (rng() * 24) | 0;
  const b = (rng() * 24) | 0;
  const c = (rng() * 24) | 0;
  return (op + a * 256 + b * 65536 + c * 16777216) % 4294967296;
}

function opcodeValues(opmap) {
  const out = [];
  for (const name of Object.keys(opmap)) {
    const v = opmap[name];
    if (typeof v === "number") out.push(v);
  }
  return out;
}

function safeOpcodes(opmap) {
  const pool = require("./Image/pool");
  const banned = new Set();
  for (const name of pool.CONST_IN_D.concat(pool.CONST_IN_C)) {
    if (typeof opmap[name] === "number") banned.add(opmap[name]);
  }
  return opcodeValues(opmap).filter((v) => !banned.has(v));
}

function addDecoyProtos(root, rng, count, opmap) {
  const n = typeof count === "number" ? count : 2 + ((rng() * 3) | 0);
  const pool = opmap ? safeOpcodes(opmap) : null;
  for (let d = 0; d < n; d++) {
    const code = [];
    const len = 4 + ((rng() * 18) | 0);
    for (let i = 0; i < len; i++) code.push(shapedWord(rng, pool));
    const k = [];
    const kn = 1 + ((rng() * 3) | 0);
    for (let i = 0; i < kn; i++) {
      if (rng() < 0.55) k.push({ t: "string", v: "d" + Math.floor(rng() * 1e9).toString(36) });
      else k.push({ t: "number", v: Math.floor(rng() * 1e6) });
    }
    root.child.push({
      numParams: (rng() * 3) | 0,
      isVararg: false,
      uv: [],
      child: [],
      k,
      code,
      decoy: true,
    });
  }
  return n;
}

function injectNoise(proto, rng, ops, pool) {
  for (const child of proto.child) injectNoise(child, rng, ops, pool);
  const extra = 2 + ((rng() * 5) | 0);
  for (let i = 0; i < extra; i++) {
    if (rng() < 0.55) {
      const word = Math.floor(rng() * 1e9).toString(36);
      const tail = String.fromCharCode(97 + Math.floor(rng() * 26)) + Math.floor(rng() * 100).toString(36);
      proto.k.push({ t: "string", v: "n" + word + tail });
    } else {
      proto.k.push({ t: "number", v: Math.floor(rng() * 1000000) });
    }
  }
  const last = proto.code.length ? proto.code[proto.code.length - 1] % 256 : -1;
  if (last === ops.RETURN) {
    const n = 1 + ((rng() * 3) | 0);
    for (let i = 0; i < n; i++) proto.code.push(shapedWord(rng, pool));
  }
}

function requireRng(rng, where) {
  if (typeof rng === "function") return rng;
  throw new Error(`${where}: a seeded rng is required (no Math.random fallback)`);
}

function compileToImage(source, options = {}) {
  const text = lowerLuau(Buffer.from(String(source), "utf8").toString("latin1"));

  const opmap = options.opmap || remap(requireRng(options.rng, "compileToImage"));

  // Layout first: the instruction encoding is decided before a single word is
  // packed, and the interpreter is generated from the same decision.
  {
    // No rng means the caller pinned the layout itself; identity is the default,
    // and either way the module state is set explicitly so two builds in one
    // process cannot inherit each other's encoding.
    const r = typeof options.rng === "function" ? options.rng : () => 0;
    const perm = options.layout === false ? [0, 1, 2, 3] : [0, 1, 2, 3];
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const tmp = perm[i];
      perm[i] = perm[j];
      perm[j] = tmp;
    }
    require("./Image/opcodes").setLayout(perm);
  }

  const proto = compile(text, { ops: opmap, dedupe: options.dedupe !== false });

  if (options.poolRng && options.noise !== false) injectNoise(proto, options.poolRng, opmap, safeOpcodes(opmap));
  const pool = options.poolRng ? shufflePool(proto, opmap, options.poolRng) : { protos: 0, constants: 0 };

  const decoys = options.poolRng && options.decoys !== false ? addDecoyProtos(proto, options.poolRng, options.decoys, opmap) : 0;

  const strings = options.streamKey ? encryptConstants(proto, options.streamKey) : { strings: 0 };

  const instr = options.instr || null;
  if (process.env.EAT_DUMP_BC) {
    // Debug hook: dump the proto tree as it is about to be ciphered.
    const seen = new Map();
    const strip = (p) => {
      if (seen.has(p)) return { ref: seen.get(p) };
      const idx = seen.size;
      seen.set(p, idx);
      return { i: idx, np: p.numParams, va: p.isVararg, nk: p.k.length, k: p.k, code: p.code, uv: p.uv, child: p.child.map(strip) };
    };
    require("fs").writeFileSync(process.env.EAT_DUMP_BC, JSON.stringify({ opmap, proto: strip(proto) }));
  }
  if (instr) {
    cipherCode(proto, instr);
    // Layer 3: rewrite every sealed word array as a stack program. This has to
    // happen after the cipher (the forge materialises sealed words) and before
    // serialization (the bytes on disk are the program, not the words).
    if (!process.env.EAT_NO_FORGE) {
      const forge = forgeTree(proto, options.forgeRng || createForgeRng(options.seed), options.forgeMutation);
      if (options.forgeMutation) proto.__forgeMutation = forge.applied;
    }
  }
  const image = serialize(proto, options.layout);
  return { image, proto, opmap, pool, strings, decoys, layout: options.layout || null };
}

module.exports = {
  compileToImage,
  vmSource,
  stripComments,
  lowerLuau,
  collectDeclared,
  collectIdentifiers,
  ALIASES,
  RUN_TOKEN,
  BASE,
};
// VM backend module expanded
const BACKEND_EXTRA = {
  // Additional backends
  backends: ['luau', 'portable', 'roblox', 'node', 'python', 'wasm'],
  // Backend options
  options: ['bloat', 'flatten', 'blocks', 'extra', 'extra2'],
  // Backend statistics
  stats: {
    total_runs: 0,
    successful_runs: 0,
    failed_runs: 0,
    avg_run_time: 0,
  },
  // Backend history
  history: [],
  // Backend version
  version: '2.0.0',
  built: new Date().toISOString(),
};
module.exports.BACKEND_EXTRA = BACKEND_EXTRA;
// End of backend module expansion
