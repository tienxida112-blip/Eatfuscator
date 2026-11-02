"use strict";

/**
 * Eatfuscator bytecode backend — dsc.gg/eatfuscator
 *
 * compileToImage(source, { opmap, dedupe }) -> { image, protos, code }
 * vmSource({ opmap, resolve })              -> interpreter text with every
 *                                              identifier rewritten to a token
 *
 * The image is what the existing cipher / LZSS / CJK pipeline carries, so the
 * program never exists as Lua text and no host loader is used at run time.
 */

const fs = require("fs");
const path = require("path");
const luaparse = require("../Vendor/luaparse");
const { compile } = require("./Compiler");
const { lowerLuau } = require("../Parser/Luau");
const { serialize } = require("./Image/encoder");
const { shufflePool } = require("./Image/pool");
const { encryptConstants, cipherCode } = require("./Image/cipher");
const { remap, BASE } = require("./Image/opcodes");

const VM_PATH = path.join(__dirname, "Template", "vm.lua");

/** interpreter name -> runtime local that already holds it */
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
  al_char: "__V002__",
  al_concat: "__V0119__",
  al_iminv: "__V0160__", // instruction-cipher inverse multiplier
  al_ik2: "__V0161__",   // instruction key (the additive half derives from it)
  al_isk: "__V0162__",   // constant-string key (k1)
  al_smult: "__V0163__", // constant-string keystream multiplier
  al_setmeta: "__V0111__", // setmetatable (declared by the envelope)
  al_index: "__V0130__",   // the "__index" metamethod name, from the pool
  al_bank: "__V068__",     // the decoded constant bank
};

/** token for the interpreter entry point (reserved in wrap.js) */
const RUN_TOKEN = "__V0899__";

/* ------------------------------------------------------------------ */
/* source helpers                                                      */
/* ------------------------------------------------------------------ */

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

/** every name the interpreter declares (locals, params, loop vars, functions) */
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

/* ------------------------------------------------------------------ */
/* interpreter text                                                    */
/* ------------------------------------------------------------------ */

/**
 * Rewrite the interpreter template into artifact-safe Lua:
 *   - opcode tokens become this build's numbers
 *   - runtime aliases become the tokens wrap.js already mangles
 *   - every declared name becomes a unique token
 */
function vmSource({ opmap, resolve, source }) {
  let src = stripComments(source || fs.readFileSync(VM_PATH, "utf8"));

  src = src.replace(/__OP_([A-Z]+)__/g, (m, name) => {
    if (!(name in opmap)) throw new Error("unknown opcode token " + name);
    return "0x" + opmap[name].toString(16).toUpperCase();
  });

  const declared = collectDeclared(parseLua(src));
  const toToken = new Map();
  let counter = 0;
  for (const name of declared) {
    toToken.set(name, name === "vm_run" ? RUN_TOKEN : `__V0${900 + counter++}__`);
  }
  for (const [name, tok] of Object.entries(ALIASES)) {
    if (declared.includes(name)) throw new Error("interpreter redeclares runtime alias " + name);
    toToken.set(name, tok);
  }

  // longest first so a prefix never clips a longer identifier
  const names = [...toToken.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    src = src.replace(new RegExp(`\\b${name}\\b`, "g"), toToken.get(name));
  }

  // every remaining identifier must be a token we own
  const leftover = collectIdentifiers(parseLua(src));
  const stray = leftover.filter((n) => !/^__V\d+__$/.test(n));
  if (stray.length) throw new Error("interpreter leaks identifiers: " + stray.slice(0, 6).join(", "));

  if (typeof resolve === "function") src = src.replace(/__V\d+__/g, (t) => resolve(t) || t);
  return src;
}

/* ------------------------------------------------------------------ */
/* public api                                                          */
/* ------------------------------------------------------------------ */

/**
 * Dead prototypes.
 *
 * A dump of the image is a list of prototypes, and every prototype in it is a
 * function somebody wrote. These are not: they carry plausible code words and
 * plausible constants, are reachable through the root's child array like any
 * other, and are never referenced by a single CLOSURE — so they are parsed on
 * load and never run. They cost the reader the same attention as the real
 * functions and give back nothing, and because their bodies are drawn from the
 * build stream, two builds of the same file do not even agree on how many
 * there are.
 */
function addDecoyProtos(root, rng, count) {
  const n = typeof count === "number" ? count : 2 + ((rng() * 3) | 0); // 2..4
  const word = () => (rng() * 4294967296) >>> 0;
  for (let d = 0; d < n; d++) {
    const code = [];
    const len = 4 + ((rng() * 18) | 0);
    for (let i = 0; i < len; i++) code.push(word());
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

function compileToImage(source, options = {}) {
  const text = lowerLuau(Buffer.from(String(source), "utf8").toString("latin1"));
  const opmap = options.opmap || remap(options.rng || Math.random);
  const proto = compile(text, { ops: opmap, dedupe: options.dedupe !== false });
  // the pool grows in source order, which is a reading aid nobody should get:
  // permute it per build and rewrite the operands that name it
  const pool = options.poolRng ? shufflePool(proto, opmap, options.poolRng) : { protos: 0, constants: 0 };
  // 1b. dead prototypes ride along in the root's child list (never closed over)
  const decoys = options.poolRng && options.decoys !== false ? addDecoyProtos(proto, options.poolRng, options.decoys) : 0;
  // 2. constant strings leave the compiler enciphered (see Image/strings.js)
  const strings = options.streamKey ? encryptConstants(proto, options.streamKey) : { strings: 0 };
  // 3. every instruction word is mapped through the build's affine cipher
  //    after the pool shuffle has rewritten its constant operands
  const instr = options.instr || null;
  if (instr) cipherCode(proto, instr);
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
