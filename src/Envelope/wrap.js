"use strict";

/**
 * Eatfuscator wrap engine — dsc.gg/eatfuscator
 *
 * Output is exactly one line:
 *   ([[dsc.gg/eatfuscator]]):gsub('.+',(function(...)<body>end)(...))
 *
 * Pipeline:
 *   source -> (optional minify) -> LZSS compress -> layered affine cipher
 *          -> 12-bit CJK packing -> shuffled payload bank (+ decoy banks)
 *   runtime -> VM dispatch decodes chunks -> LZSS inflate -> integrity gate
 *          -> char-code resolved loader
 *
 * Hard rules enforced on every build (validate() throws otherwise):
 *   no XOR / no bitwise operator, no byte-array literals, no literal
 *   loadstring/load(, keys are 0x<hex>, identifiers are 2..5 shape-confusable
 *   glyphs from Envelope/idents.js
 *   with letters and digits, single line, no version strings, Lua 5.1 syntax.
 */

const fs = require("fs");
const path = require("path");
const lzss = require("../Codec/lzss");
const { minifyLua, checkSyntax } = require("../Steps/Minify");
const { compileToImage, vmSource, lowerLuau } = require("../Vm/backend");
const { flattenLoader } = require("../Steps/Flatten");
const { shapeArtifact } = require("../Steps/Shape");
const macros = require("../Steps/Macro");
const { fold } = require("../Steps/Macro/fold");
const luauCli = require("../Toolchain/luaucli");
const { luauCompress } = require("../Steps/Luau/sugar");
const { trapSource } = require("./traps");
const { remap } = require("../Vm/Image/opcodes");

const BRAND = "dsc.gg/eatfuscator";
const HEX = "0123456789ABCDEF";
const { makeNameFactory, NAME_SRC, NAME_RE } = require("./idents");
const { multFor, digestWords } = require("../Vm/Image/cipher");
const perm = require("../Vm/Image/perm");
const {
  createRNG,
  createKeyring,
  instructionCipher,
  addendOf,
} = require("../Core/rng");
const WATERMARK_LINE = "-- Protected By Eatfuscator | dsc.gg/eatfuscator";
const WRAPPER_SUFFIX = "end})[1]({...})";
// `[1]` is rewritten to `[0x1]` by the number pass, so the tail is matched loosely
const WRAPPER_SUFFIX_RE = /end\}\)\[(?:0x)?1\]\(\{\.\.\.\}\)$/;

/* ---------------- seeded RNG ---------------- */


/* ---------------- identifiers / keys ---------------- */

function makeKeyFactory(rng) {
  const used = new Set();
  return function key() {
    for (let i = 0; i < 4096; i++) {
      let hex = HEX[1 + ((rng() * 15) | 0)]; // avoid leading zero
      for (let k = 0; k < 12; k++) hex += HEX[(rng() * 16) | 0];
      if (!used.has(hex)) {
        used.add(hex);
        return hex;
      }
    }
    throw new Error("key space exhausted");
  };
}

/* ---------------- affine codec (mod 256, exact) ---------------- */

function modInverse256(m) {
  for (let x = 1; x < 256; x += 2) if (((m * x) & 255) === 1) return x;
  return 1;
}

function affineParams(rng) {
  const m = ((rng() * 127) | 0) * 2 + 1;
  const inv = modInverse256(m);
  // generation-time invariant: must hold exactly or the artifact would trap itself
  if ((m * inv) % 256 !== 1) throw new Error("invalid affine layer: m*inv != 1 mod 256");
  return { m, inv, a: (rng() * 256) | 0, step: (rng() * 256) | 0, sw: rng() < 0.5 ? 1 : 0 };
}

function affineEncodeBytes(bytes, p) {
  const n = bytes.length;
  const out = new Array(n);
  for (let k = 1; k <= n; k++) {
    const pos = p.sw === 1 ? n - k + 1 : k;
    out[k - 1] = (((bytes[k - 1] * p.m + p.a + (pos - 1) * p.step) % 256) + 256) % 256;
  }
  return out;
}

function affineDecodeBytes(bytes, p) {
  const n = bytes.length;
  const out = new Array(n);
  for (let k = 1; k <= n; k++) {
    const pos = p.sw === 1 ? n - k + 1 : k;
    const u = (((bytes[k - 1] - p.a - (pos - 1) * p.step) % 256) + 256) % 256;
    out[k - 1] = (u * p.inv) % 256;
  }
  return out;
}

/* ---------------- CJK packing: 12 bits per char, 2 chars per 3 bytes ---------------- */

function packBlob(bytes) {
  const arr = Array.isArray(bytes) ? bytes : Array.from(bytes);
  const codes = [];
  for (let i = 0; i < arr.length; i += 3) {
    const b0 = arr[i] || 0;
    const b1 = arr[i + 1] || 0;
    const b2 = arr[i + 2] || 0;
    const v = (b0 << 16) | (b1 << 8) | b2;
    codes.push(0x4e00 + (v >>> 12), 0x4e00 + (v & 0xfff));
  }
  let out = "";
  for (let i = 0; i < codes.length; i += 2048) out += String.fromCharCode.apply(null, codes.slice(i, i + 2048));
  return out;
}

function unpackBlob(blob) {
  const cp = Array.from(blob, (ch) => ch.codePointAt(0) - 0x4e00);
  const bytes = [];
  for (let i = 0; i < cp.length; i += 2) {
    const v = cp[i] * 4096 + cp[i + 1];
    bytes.push((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/* ---------------- payload construction ---------------- */

function checksums(bytes, k0, k1) {
  let chk = 0;
  let wsum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    chk = (chk + b * k0 + k1) % 16777216;
    wsum = (wsum + (i + 1) * b) % 16777216;
  }
  return { chk, wsum };
}

/** per-build opcode permutation; the first draws of the seed stream */
function opmapForSeed(seed) {
  return remap(createKeyring(seed >>> 0).c);
}

function buildPayload(imageBytes, mode, rng, key0, key1, key2) {
  const name = makeNameFactory(rng);
  const key = makeKeyFactory(rng);

  const raw = Buffer.isBuffer(imageBytes) ? imageBytes : Buffer.from(String(imageBytes), "utf8");
  const packed = lzss.compress(raw);

  const shrink = mode === "Max" || mode === "Both";
  const chunkSize = shrink ? 384 : 256;
  const maxLayers = mode === "Both" ? 4 : mode === "Max" ? 3 : 2;

  const entries = [];
  for (let offset = 0; offset < packed.length; offset += chunkSize) {
    const chunk = Array.from(packed.subarray(offset, offset + chunkSize));
    const rawLen = chunk.length;
    // pad before the positional affine layer so decode sees the same length
    while (chunk.length % 3 !== 0) chunk.push(0);
    const layerCount = 1 + ((rng() * maxLayers) | 0);
    const layers = [];
    for (let l = 0; l < layerCount; l++) layers.push(affineParams(rng));

    let cur = chunk;
    for (const p of layers) cur = affineEncodeBytes(cur, p);

    entries.push({ key: key(), blob: packBlob(cur), layers, n: rawLen });
  }

  const orderKeys = entries.map((e) => e.key);

  // bank shuffle: storage order != decode order
  for (let i = entries.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }

  // decoy banks — stored, never referenced by the order array
  const decoyCount = 2 + ((rng() * 3) | 0);
  for (let d = 0; d < decoyCount; d++) {
    const len = 24 + ((rng() * 72) | 0);
    const bytes = [];
    for (let i = 0; i < len; i++) bytes.push((rng() * 256) | 0);
    while (bytes.length % 3 !== 0) bytes.push(0);
    const p = affineParams(rng);
    const enc = affineEncodeBytes(bytes, p);
    entries.push({ key: key(), blob: packBlob(enc), layers: [p], n: len, decoy: true });
  }

  const k0 = key0 || 1 + ((rng() * 255) | 0);
  const k1 = key1 || 1 + ((rng() * 255) | 0);
  const k2 = key2 || 1 + ((rng() * 16777214) | 0);
  // 512 bits of rolling state over the decoded image; two words travel in the
  // constant bank and the loader re-walks the image to check them
  const digest = digestWords(raw, k1, k2);
  const { chk, wsum } = checksums(raw, k0, k1);
  const zchk = checksums(packed, 1, 0).wsum;

  return {
    entries,
    orderKeys,
    k0,
    k1,
    k2,
    digest,
    len: raw.length,
    chk,
    wsum,
    zlen: packed.length,
    zchk,
    name,
  };
}

/* ---------------- size padding (filler banks) ---------------- */

/**
 * Append filler bank entries until the serialised bank table reaches
 * `target` bytes. Fillers are structurally identical to real chunks
 * (blob + cipher layers + declared length) and are simply never
 * referenced by the order array, so they cost parse time only.
 */
function padBanks(payload, rng, target, overhead) {
  const u8 = (str) => Buffer.byteLength(str, "utf8");
  if (!(target > 0)) return { added: 0, bankBytes: u8(entriesToLua(payload.entries)) };

  const key = makeKeyFactory(rng);
  const used = new Set(payload.entries.map((e) => e.key));
  const freshKey = () => {
    let k = key();
    while (used.has(k)) k = key();
    used.add(k);
    return k;
  };

  let bankBytes = u8(entriesToLua(payload.entries));
  let added = 0;
  let guard = 0;

  while (bankBytes + overhead < target && guard++ < 20000) {
    const len = 96 + ((rng() * 320) | 0);
    const bytes = new Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (rng() * 256) | 0;
    const layers = [];
    const layerCount = 1 + ((rng() * 3) | 0);
    for (let l = 0; l < layerCount; l++) layers.push(affineParams(rng));
    let cur = bytes;
    for (const p of layers) cur = affineEncodeBytes(cur, p);

    const entry = { key: freshKey(), blob: packBlob(cur), layers, n: len, filler: true };
    payload.entries.push(entry);
    bankBytes += u8("[0x" + entry.key + ']={"' + entry.blob + '",' +
      "{" + layers.map((p) => `{${p.inv},${p.a},${p.step},${p.sw},${p.m}}`).join(",") + "}," + len + "},");
    added++;
  }

  return { added, bankBytes };
}

/* ---------------- VM program ---------------- */

/**
 * Handlers (template function tokens):
 *   H_LOAD  load entry for current pointer        -> pc 2
 *   H_UNPK  unpack blob + trim to declared length -> pc 3
 *   H_LAYR  undo cipher layers in reverse         -> pc 4
 *   H_APPD  append decoded chunk                  -> halt
 *   + 2 decoy handlers that are never reached
 */
const HANDLER_TOKENS = ["__V43__", "__V48__", "__V53__", "__V56__", "__V59__", "__V60__"];

function buildProgram(rng, chunks) {
  const pool = [];
  for (let i = 0; i < 256; i++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const opcodes = pool.slice(0, 6); // 4 real + 2 decoy
  const opKey = [1 + ((rng() * 255) | 0), 1 + ((rng() * 255) | 0), 1 + ((rng() * 255) | 0), 1 + ((rng() * 255) | 0)];

  // per chunk: fetch, decode, flush — the flush alternates between the two decoders
  const program = [];
  for (let c = 0; c < Math.max(1, chunks); c++) {
    program.push(opcodes[0], opcodes[1], c % 2 === 0 ? opcodes[3] : opcodes[2]);
  }
  const enciphered = program.map((op, i) => (op + 256 - opKey[i % 4]) % 256);

  return { opcodes, opKey, enciphered, blob: packBlob(enciphered) };
}

/* ---------------- output validation ---------------- */

let parser = null;
try { parser = require("../Vendor/luaparse"); } catch { /* ignore */ }
if (!parser) {
  try { parser = require("luaparse"); } catch { parser = null; }
}

function collectDeclaredNames(code) {
  const names = [];
  if (!parser) return names;

  let ast;
  try {
    ast = parser.parse(code, { luaVersion: "5.1", comments: false, locations: false, ranges: false });
  } catch {
    return names;
  }

  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }

    if (node.type === "LocalStatement") for (const v of node.variables || []) names.push(v.name);
    if (node.type === "FunctionDeclaration") {
      if (node.identifier && node.identifier.type === "Identifier") names.push(node.identifier.name);
      for (const p of node.parameters || []) if (p && p.type === "Identifier") names.push(p.name);
    }
    if (node.type === "ForNumericStatement" && node.variable) names.push(node.variable.name);
    if (node.type === "ForGenericStatement") for (const v of node.variables || []) names.push(v.name);

    for (const k of Object.keys(node)) {
      if (k === "type" || k === "loc" || k === "range") continue;
      visit(node[k]);
    }
  };

  visit(ast);
  return names;
}

/**
 * Every decimal literal the loader still spells out is rewritten as a hex
 * numeral. Structural constants then look like the bank keys around them and
 * no plain decimal survives the build.
 */
function hexifyNumbers(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  const prevOk = (k) => k < 0 || !/[A-Za-z0-9_.]/.test(code[k]);
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === c) { j++; break; }
        j++;
      }
      out += code.slice(i, j);
      i = j;
      continue;
    }
    if (c === "-" && code[i + 1] === "-") {
      let j = i;
      while (j < n && code[j] !== "\n") j++;
      out += code.slice(i, j);
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9" && prevOk(i - 1)) {
      let j = i;
      while (j < n && /[0-9]/.test(code[j])) j++;
      const next = code[j];
      if (next === "x" || next === "X") {
        let k = j + 1;
        while (k < n && /[0-9A-Fa-f]/.test(code[k])) k++;
        out += code.slice(i, k);
        i = k;
        continue;
      }
      if (next === "." || next === "e" || next === "E") {
        let k = j;
        while (k < n && /[0-9.eE+-]/.test(code[k])) k++;
        out += code.slice(i, k);
        i = k;
        continue;
      }
      out += "0x" + parseInt(code.slice(i, j), 10).toString(16).toUpperCase();
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function validate(code, options = {}) {
  const target = options.target === "portable" ? "portable" : "luau";
  const problems = [];

  if (typeof code !== "string" || !code.length) problems.push("empty output");

  // line 1 is the watermark comment, the payload itself is one line
  const lines = code.split("\n");
  if (lines.length !== 2) problems.push("output must be exactly the watermark line plus one code line");
  if (lines[0] !== WATERMARK_LINE) problems.push("watermark line mismatch");
  if (/[\r]/.test(code)) problems.push("carriage return in output");

  const prefix = `return({function(...)`;
  if (!lines[1] || !lines[1].startsWith(prefix)) problems.push("wrapper prefix mismatch");
  if (!WRAPPER_SUFFIX_RE.test(code)) problems.push("wrapper suffix mismatch");
  if (!code.includes(BRAND)) problems.push("brand missing");

  if (/~(?!=)/.test(code)) problems.push("bitwise/XOR operator present");
  if (/loadstring/.test(code)) problems.push("literal loadstring present");
  if (/\bload\s*\(/.test(code)) problems.push("literal load() present");
  if (/__V\d+__|__N\d+__|__DATA__|__VMTABLE__/.test(code)) problems.push("unreplaced template token");
  if (/\["/.test(code)) problems.push("string table key present");
  if (/\bwhile\s+true\b/.test(code)) problems.push("readable `while true` trap left in the artifact");
  if (/Eatfuscator Said No Skid/.test(code)) problems.push("plaintext trap message survived");
  if (/\bv\d+(\.\d+)+\b/i.test(code)) problems.push("version string present");

  // Luau is the reference grammar. When the official CLI is available the real
  // Luau front-end decides; otherwise the in-process Luau lowering + parser does.
  let gate = "luau-lower";
  const external = luauCli.compileCheck(code);
  if (!external.skipped) {
    gate = "luau-compile";
    if (!external.ok) problems.push("luau syntax: " + external.error);
  } else {
    const inproc = checkSyntax(code, "luau");
    if (!inproc.ok) problems.push("luau syntax: " + inproc.error);
  }

  // portable builds additionally have to stay inside the Lua 5.1 subset
  if (target === "portable") {
    const compat = checkSyntax(code, "5.1");
    if (!compat.ok) problems.push("lua 5.1 compat: " + compat.error);
  }

  const declared = collectDeclaredNames(code);
  const bad = declared.filter((n) => !NAME_RE.test(String(n)));
  if (bad.length) problems.push("non-conforming identifiers: " + [...new Set(bad)].slice(0, 8).join(", "));

  const batches = [...code.matchAll(/\blocal ([A-Za-z_][A-Za-z0-9_]*(?:,[A-Za-z_][A-Za-z0-9_]*)+)(?=[\s=(])/g)]
    .map((m) => m[1].split(",").length);
  if (batches.length && batches[0] < 6) problems.push("first declaration batch too small");

  // upvalue architecture must survive the build
  const closures = (code.match(/return function\(/g) || []).length;
  if (closures < 4) problems.push(`upvalue chain too shallow (${closures} nested closures)`);
  const handlers = (code.match(/\]=function\(\)/g) || []).length;
  if (handlers < 4) problems.push(`VM handler table incomplete (${handlers})`);

  // every cipher layer must satisfy m*inv = 1 (mod 256) or the build would trap itself
  // layers are emitted as `{{inv,a,step,sw,m}}` inside a bank entry; matching a
  // bare `{a,b,c,d,e}` group would also hit ordinary data tables in the payload
  const num = "(0x[0-9A-Fa-f]+|\\d+)";
  const layerRe = new RegExp("\\{\\{" + [num, num, num, num, num].join(",") + "\\}\\}", "g");
  let lm;
  let layerCount = 0;
  while ((lm = layerRe.exec(code)) !== null) {
    layerCount++;
    const inv = Number(lm[1]);
    const m = Number(lm[5]);
    if ((inv * m) % 256 !== 1) problems.push(`non-invertible cipher layer inv=${inv} m=${m}`);
    if (Number(lm[2]) > 255 || Number(lm[3]) > 255) problems.push("cipher parameter out of byte range");
  }
  if (layerCount === 0) problems.push("no cipher layers found");

  return { ok: problems.length === 0, problems, declared, closures, handlers, layers: layerCount, target, gate };
}

/* ---------------- main ---------------- */


function buildConstants(rng, key) {
  // 9 x 4 = 36 bytes: a multiple of 3 so the CJK packer never pads
  // 0x7 = env fingerprint, 0x8 = expected slot count, 0x9 = filler
  const vals = [19968, 4096, 64, 128, 65536, 16777216, 83, 9, 0];
  const bytes = [];
  for (const v of vals) bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const layer = affineParams(rng);
  const enc = affineEncodeBytes(bytes, layer);
  return { key: key(), blob: packBlob(enc), layers: [layer], n: bytes.length, vals };
}

function constHash(vals) {
  let h = 0;
  // 1-based weighting to match the Lua recomputation
  for (let i = 0; i < vals.length; i++) h = (h + vals[i] * (i + 4)) % 16777216;
  return h;
}

const DATA_MARK = "__DATA__";
const TRAP_MARK = "__TRAP__";
const VM_MARK_VM = "__VM__";
const VM_MARK = "__VMTABLE__";

/** packBlob output is CJK only: emit it as a long bracket when that is exact */
function longString(text) {
  if (/[\]\n\r]/.test(text)) return JSON.stringify(text);
  return `[==[${text}]==]`;
}

function entriesToLua(entries) {
  const parts = [];
  for (const e of entries) {
    const layers = "{" + e.layers.map((p) => `{${p.inv},${p.a},${p.step},${p.sw},${p.m}}`).join(",") + "}";
    parts.push(`[0x${e.key}]={${longString(e.blob)},${layers},${e.n}}`);
  }
  return "{" + parts.join(",") + "}";
}

function minifyLevel(mode) {
  const off = /^(false|off|none)$/i.test(mode);
  return off ? "false" : /^max$/i.test(mode) ? "Max" : /^both$/i.test(mode) ? "Both" : "Normal";
}

/**
 * Luau sugar is lowered before the minifier sees it: the preprocessor is the
 * only component that understands annotations / if-expressions / compound ops.
 */
function prepareSource(src, level, macroRng) {
  // macros first: EAT_STRING / EAT_NUMBER / EAT_FUNCTION / EAT_RAGEBAIT are
  // resolved against the file as written, before lowering or minifying sees it
  const expanded = macros.expand(String(src), { rng: macroRng });
  let lowered = lowerLuau(expanded.code);
  // then any branch that is provably dead (`if false then … end`) goes away
  lowered = fold(lowered).code;
  prepareSource.stats = { macro: expanded.stats };
  return level === "false" ? lowered : minifyLua(lowered, level);
}

function wrapSource(src, options = {}) {
  // Luau is the reference dialect: the artifact is allowed to use Luau surface
  // syntax (compound assignment, //) unless `target: "portable"` is asked for
  const target = String(options.target || "luau").toLowerCase() === "portable" ? "portable" : "luau";

  const mode = String(options.minify || "Normal");
  const off = /^(false|off|none)$/i.test(mode);
  const level = off ? "false" : /^max$/i.test(mode) ? "Max" : /^both$/i.test(mode) ? "Both" : "Normal";

  const seed = typeof options.seed === "number"
    ? options.seed >>> 0
    : options.seed === "random" || options.seed === undefined
      ? (Math.floor(Math.random() * 0xffffffff) >>> 0)
      : (parseInt(String(options.seed), 10) >>> 0) || 42;

  // a dedicated stream keeps macro keys stable per seed and independent of
  // how much randomness the rest of the envelope consumes
  const macroRng = createRNG((seed ^ 0x5bf03635) >>> 0);
  const sourceText = prepareSource(src, level, macroRng);
  if (!sourceText.length) throw new Error("empty input");

  const rng = createRNG(seed);
  // three independent key streams: payload / constants / instructions
  const ring = createKeyring(seed);

  // the payload is never host-compiled: it becomes a bytecode image for our
  // own interpreter, keyed by a per-build opcode permutation drawn from the
  // instruction stream, so the permutation and the word encoding share a key
  const opmap = remap(ring.c);
  // every instruction word leaves the compiler already enciphered
  const instr = process.env.NOINSTR ? null : instructionCipher(ring.c, ring.k2);
  // two permutations decide how the image is laid out; their mixed-radix codes
  // ride in the constant bank, so nothing can parse the image before the bank
  const fieldOrder = perm.shuffle(7, ring.b);
  const tagOrder = perm.shuffle(5, ring.b); // nil, false, true, number, string
  const tagOf = {
    nil: tagOrder[0] + 1,
    false: tagOrder[1] + 1,
    true: tagOrder[2] + 1,
    number: tagOrder[3] + 1,
    string: tagOrder[4] + 1,
  };
  const layout = { fieldOrder, tagOf, fieldCode: perm.encode(fieldOrder), tagCode: perm.encode(tagOrder) };
  // minify level controls the compiler's constant folding pass, so a
  // "no minify" build really is bigger than a minified one
  const { image } = compileToImage(sourceText, {
    opmap,
    dedupe: level !== "false",
    poolRng: ring.b,   // constant pool layout
    streamKey: process.env.NOSTR ? undefined : ring.k1,
    instr,              // per-build instruction cipher
    layout,             // per-build header order + constant tags
  });
  const payload = buildPayload(image, level, ring.a, ring.k0, ring.k1, ring.k2);
  const vm = buildProgram(rng, payload.orderKeys.length);

  let template = fs.readFileSync(path.join(__dirname, "Template", "runtime.lua"), "utf8");
  if (template.includes(VM_MARK_VM)) {
    template = template.replace(VM_MARK_VM, () => vmSource({ opmap, resolve: (t) => t }));
  }

  // trip-wire: a per-build generated walker, never a `while true do` loop
  if (template.includes(TRAP_MARK)) {
    template = template.replace(TRAP_MARK, () => trapSource(rng, "__V0709__"));
  }

  // padding target: explicit option wins, default pushes artifacts past 500 KB
  const bloatOption = options.bloat === undefined ? 512 * 1024 : Number(options.bloat) || 0;
  const pad = padBanks(payload, rng, bloatOption, Math.round(Buffer.byteLength(template, 'utf8') * 1.25));

  // every __Vn__ token becomes a unique long hex identifier
  const tokenNames = new Map();
  for (const t of template.match(/__V\d+__/g) || []) if (!tokenNames.has(t)) tokenNames.set(t, payload.name());
  {
    const extra = [];
    for (let i = 300; i <= 317; i++) extra.push(`__V0${i}__`);
    for (let i = 801; i <= 810; i++) extra.push(`__V0${i}__`);
    for (const t of ["__V020__", "__V021__", "__V022__", "__V068__", "__V000__", "__V0119__", "__V0120__", "__V0121__", "__V0122__", "__V0160__", "__V0161__", "__V0162__"]) extra.push(t);
    for (const i of [103,106,107,108,109,110,111,112,113,116,117,118,119,120,123,124,127,128,129,130,131,132]) extra.push(`__V0${i}__`);
    for (const t of extra) if (!tokenNames.has(t)) tokenNames.set(t, payload.name());
  }
  const V = (t) => tokenNames.get(t);

  // control-flow states: six distinct, non-sequential constants
  const stateVals = [];
  for (let i = 0; i < 6; i++) {
    let v = 0x1000 + ((rng() * 0x7fffef) | 0);
    while (stateVals.includes(v)) v = 0x1000 + ((rng() * 0x7fffef) | 0);
    stateVals.push(v);
  }
  const H = (n) => "0x" + n.toString(16).toUpperCase();
  const K = (n) => n.toString(16).toUpperCase().padStart(2, "0");

  // ---- encrypted string pool: every name the loader needs ----
  // plaintext never reaches the artifact; the decoder rebuilds them from CJK
  const POOL_ORDER = [
    "string", "table", "math", "type", "select", "pcall", "rawget", "next",
    "getmetatable", "setmetatable", "debug", "getfenv", "error", "print", "warn",
    "unpack", "tonumber", "gethook", "__index", "__newindex", "function",
    "concat", "floor", "gsub", "info",
  ];
  const shuffled = POOL_ORDER.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const poolIndex = new Map(shuffled.map((s, i) => [s, i + 1]));

  const poolBytes = [shuffled.length];
  for (const str of shuffled) {
    const bytes = Buffer.from(str, "utf8");
    poolBytes.push(bytes.length);
    for (const b of bytes) poolBytes.push(b);
  }
  while (poolBytes.length % 3 !== 0) poolBytes.push(0);
  const poolLayers = [affineParams(rng)];
  const poolBlob = packBlob(affineEncodeBytes(poolBytes, poolLayers[0]));
  const poolLayerLua = "{" + poolLayers.map((p) => `{${p.inv},${p.a},${p.step},${p.sw},${p.m}}`).join(",") + "}";

  const P0 = (str) => poolIndex.get(str);
  const poolLua = [
    `local ${V("__V020__")},${V("__V0300__")},${V("__V0301__")}={},${longString(poolBlob)},${poolLayerLua}`,
    `local ${V("__V0302__")},${V("__V0303__")}=${V("__V0400__")}(${V("__V0300__")}),#${V("__V0301__")}`,
    `while ${V("__V0303__")}>=__V004__[1] do ${V("__V0302__")}=${V("__V0420__")}(${V("__V0302__")},${V("__V0301__")}[${V("__V0303__")}]) ${V("__V0303__")}=${V("__V0303__")}-__V004__[1] end`,
    `local ${V("__V0317__")},${V("__V0305__")},${V("__V0306__")}=__V004__[2],${V("__V0302__")}[1],__V004__[1]-__V004__[1]`,
    `while ${V("__V0306__")}<${V("__V0305__")} do`,
    `local ${V("__V0307__")},${V("__V0308__")}=${V("__V0302__")}[${V("__V0317__")}],\"\"`,
    `${V("__V0317__")}=${V("__V0317__")}+__V004__[1]`,
    `for ${V("__V0309__")}=__V004__[1],${V("__V0307__")} do ${V("__V0308__")}=${V("__V0308__")}..__V002__(${V("__V0302__")}[${V("__V0317__")}]) ${V("__V0317__")}=${V("__V0317__")}+__V004__[1] end`,
    `${V("__V0306__")}=${V("__V0306__")}+__V004__[1] ${V("__V020__")}[${V("__V0306__")}]=${V("__V0308__")} end`,
  ].join(" ");

  const G = V("__V000__");
  const S = (x) => `${V("__V020__")}[${P0(x)}]`;
  const env = (x) => `${G}[${S(x)}]`;
  const aliasRows = [
    [["__V0103__", env("type")], ["__V0106__", env("select")], ["__V0107__", env("pcall")],
     ["__V0108__", env("rawget")], ["__V0109__", env("next")], ["__V0110__", env("getmetatable")],
     ["__V0111__", env("setmetatable")]],
    [["__V0112__", env("debug")], ["__V0113__", env("getfenv")], ["__V0116__", env("error")],
     ["__V0117__", env("print")], ["__V0118__", env("warn")], ["__V0123__", S("table")],
     ["__V0124__", S("function")]],
    [["__V0127__", env("string")], ["__V0128__", env("math")], ["__V0129__", S("gethook")],
     ["__V0133__", S("info")],
     ["__V0140__", S("type")],
     ["__V0130__", S("__index")], ["__V0131__", S("__newindex")], ["__V0132__", S("string")]],
  ];
  const aliasLua = aliasRows
    .map((row) => `local ${row.map(([n]) => V(n)).join(",")}=${row.map(([, e]) => e).join(",")}`);
  aliasLua.push(`local ${V("__V0119__")},${V("__V0120__")},${V("__V0121__")},${V("__V0122__")},${V("__V021__")},${V("__V022__")}=`+
    `${env("table")}[${S("concat")}],${env("math")}[${S("floor")}],${env("table")}[${S("unpack")}] or ${env("unpack")},${env("tonumber")},${S("table")},${S("math")}`);
  const poolBlock = poolLua + " " + aliasLua.join(" ");

  // ---- encrypted constant bank: 24 slots, every value < 2^24 ----
  const mixOf = (arr) => arr.reduce((h, v, i) => (i === 10 ? h : (h + v * (i + 2)) % 16777216), 0);
  const ckey = makeKeyFactory(rng);
  const consts = buildConstants(rng, () => ckey());
  const poolLenSum = shuffled.reduce((a, s) => a + s.length, 0);
  const vals = consts.vals;
  vals[6] = poolLenSum;                 // 0x07
  vals[8] = payload.zlen;               // 0x09
  vals[9] = payload.zchk;               // 0x0A
  vals[10] = 0;                         // 0x0B mix, filled below
  vals[11] = payload.k0;                // 0x0C
  vals[12] = payload.k1;                // 0x0D
  vals[13] = payload.orderKeys.length;  // 0x0E
  vals[14] = payload.len;               // 0x0F
  vals[15] = payload.chk;               // 0x10
  vals[16] = payload.wsum;              // 0x11
  for (let i = 0; i < 6; i++) vals[17 + i] = stateVals[i]; // 0x12..0x17
  vals[24] = instr.inv >>> 0;           // 0x18 instruction inverse multiplier
  vals[25] = ring.k2 >>> 0;             // 0x19 instruction key (addend derives from it)
  vals[26] = (ring.k0 * 65537 + ring.k1 * 257 + ring.k2 * 17) % 16777216; // 0x1A three-key gate
  vals[23] = 0;                         // 0x17 spare
  // slots 0x1B..0x23 carry build noise: they are read by the bank mixture
  // check like every other slot, so the bank always decodes to 36 values
  vals[27] = multFor(ring.k1);          // 0x1C constant-string keystream multiplier
  vals[28] = payload.digest[0];         // 0x1D image digest, first word
  vals[29] = payload.digest[8];         // 0x1E image digest, ninth word
  vals[30] = layout.fieldCode;          // 0x1F image header order (mixed radix)
  vals[31] = layout.tagCode;            // 0x20 constant tag map (mixed radix)
  // the bank is 38..42 slots, drawn per build: the count is checked against the
  // real length at run time, so a reader cannot even hardcode the layout
  const slotCount = 38 + (ring.b.word() % 5);
  for (let i = 32; i < slotCount; i++) vals[i] = (ring.b.word() % 16777216) >>> 0;
  vals[7] = slotCount;                  // 0x08 slot count
  vals[10] = mixOf(vals);

  const constBytes = [];
  for (const v of vals) constBytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  while (constBytes.length % 3 !== 0) constBytes.push(0);
  const constLayers = [];
  const layerCount = 1 + (ring.b.word() % 3); // 1..3 positional layers per build
  for (let i = 0; i < layerCount; i++) constLayers.push(affineParams(ring.b));
  let constImg = constBytes;
  for (const p of constLayers) constImg = affineEncodeBytes(constImg, p); // first layer first, decode walks back
  const constBlob = packBlob(constImg);
  const constLayerLua = "{" + constLayers.map((p) => `{${p.inv},${p.a},${p.step},${p.sw},${p.m}}`).join(",") + "}";

  const constsLua = [
    `local ${V("__V068__")},${V("__V0310__")},${V("__V0311__")}={},${longString(constBlob)},${constLayerLua}`,
    `local ${V("__V0312__")},${V("__V0313__")}=${V("__V0400__")}(${V("__V0310__")}),#${V("__V0311__")}`,
    `while ${V("__V0313__")}>=__V004__[1] do ${V("__V0312__")}=${V("__V0420__")}(${V("__V0312__")},${V("__V0311__")}[${V("__V0313__")}]) ${V("__V0313__")}=${V("__V0313__")}-__V004__[1] end`,
    `local ${V("__V0314__")},${V("__V0315__")},${V("__V0316__")}=__V004__[1]-__V004__[1],#${V("__V0312__")}-#${V("__V0312__")}%__V004__[3],__V004__[1]`,
    `while ${V("__V0316__")}<=${V("__V0315__")} do ${V("__V0314__")}=${V("__V0314__")}+__V004__[1] ${V("__V068__")}[${V("__V0314__")}]=(((${V("__V0312__")}[${V("__V0316__")}]*__V004__[9]+${V("__V0312__")}[${V("__V0316__")}+__V004__[1]])*__V004__[9]+${V("__V0312__")}[${V("__V0316__")}+__V004__[2]])*__V004__[9]+${V("__V0312__")}[${V("__V0316__")}+__V004__[1]+__V004__[2]]) ${V("__V0316__")}=${V("__V0316__")}+__V004__[3] end`,
    // the three keys the interpreter runs on, read straight out of the bank
    `local ${V("__V0160__")},${V("__V0161__")},${V("__V0162__")},${V("__V0163__")}=${V("__V068__")}[0x19],${V("__V068__")}[0x1A],${V("__V068__")}[0x0D],${V("__V068__")}[0x1C]`,
  ].join(" ");

  const opKeyLua = "{" + vm.opKey.slice(0, 4).map((k) => H(k)).join(",") + "}";
  const bankLua = entriesToLua(payload.entries);
  const orderLua = "{" + payload.orderKeys.map((k) => "0x" + k).join(",") + "}";
  const dataBlock = [
    `local ${V("__V0801__")},${V("__V0802__")}=${bankLua},${orderLua};`,
    `local ${V("__V0803__")},${V("__V0804__")}=${longString(vm.blob)},${opKeyLua};`,
    `local ${V("__V0805__")},${V("__V0806__")}=${V("__V068__")}[0x12],${V("__V068__")}[0x13];`,
    `local ${V("__V0807__")},${V("__V0808__")}=${V("__V068__")}[0x14],${V("__V068__")}[0x15];`,
    `local ${V("__V0809__")},${V("__V0810__")}=${V("__V068__")}[0x16],${V("__V068__")}[0x17];`,
  ].join("");

  const bind = (t) => V("__V" + t + "__");
  const fixRefs = (txt) => txt.replace(/__V(\d+)__/g, (m, d) => bind(d));
  let code = template.replace(/__V\d+__/g, (t) => tokenNames.get(t));
  code = code.replace("__POOL__", fixRefs(poolBlock));
  code = code.replace("__CONSTS__", fixRefs(constsLua));
  code = code.replace(DATA_MARK, fixRefs(dataBlock));
  for (let i = 0; i < 6; i++) code = code.split(`__K${i + 1}__`).join(K(vm.opcodes[i]));
  for (let i = 0; i < 6; i++) code = code.split(`__N${i + 1}__`).join(H(stateVals[i]));

  // control-flow flattening: the loader body becomes a state machine whose
  // transition table, not its source order, carries the execution order
  let flattenStats = null;
  if (options.flatten !== false) {
    // the audit hook is the same generated trip-wire the loader already
    // carries: one call, no inline loop, no message
    const trap = `${V("__V0709__")}()`;
    try {
      const flat = flattenLoader(code, {
        rng,
        name: () => payload.name(),
        trap,
        blocks: Number(options.blocks) || 26,
      });
      if (flat.applied) {
        code = flat.code;
        flattenStats = flat.stats;
      } else if (options.verbose) {
        console.error(`[wrap] flatten skipped: ${flat.reason}`);
      }
    } catch (e) {
      if (options.verbose) console.error(`[wrap] flatten failed: ${e.message}`);
    }
  }

  // loop shaping: the artifact is generated Lua, so `while <cond> do` is the
  // last control-flow shape an analyst still reads straight off the line. Every
  // while is re-spelled as a repeat, exactly, so the emitted text stops
  // announcing where the loops are
  let shapeStats = null;
  {
    const shaped = shapeArtifact(code);
    code = shaped.code;
    shapeStats = shaped.stats;
  }

  code = hexifyNumbers(code);
  code = minifyLua(code, "Max");

  let sugarStats = null;
  if (target === "luau") {
    const compressed = luauCompress(code);
    code = compressed.code;
    sugarStats = compressed.stats;
  }

  // the watermark goes on last: every earlier stage (minifier, CFF re-emitter)
  // drops comments
  code = WATERMARK_LINE + "\n" + code;

  const report = validate(code, { target });
  if (!report.ok) {
    const err = new Error("output validation failed:\n  - " + report.problems.join("\n  - "));
    err.code = code;
    throw err;
  }

  if (options.verbose) {
    console.error(`[wrap] target=${target} gate=${report.gate}${sugarStats ? ` compound=${sugarStats.compound} floorDiv=${sugarStats.floorDiv} saved=${sugarStats.saved}` : ""}`);
    const upval = (code.match(/return function\(/g) || []).length;
    console.error(`[wrap] chunks=${payload.orderKeys.length} decoys=${payload.entries.length - payload.orderKeys.length}`);
    console.error(`[wrap] source=${payload.len}B packed=${payload.zlen}B ratio=${(payload.zlen / payload.len).toFixed(3)}`);
    console.error(`[wrap] closures=${upval} handlers=${6} identifiers=${new Set(report.declared).size} output=${Buffer.byteLength(code)}B`);
    console.error(`[wrap] filler banks=${pad.added} bank bytes=${pad.bankBytes}`);
    if (flattenStats) console.error(`[wrap] flattened ${flattenStats.statements} statements into ${flattenStats.blocks} blocks (hoisted ${flattenStats.hoisted} names)`);
    if (pool && pool.protos) console.error(`[wrap] pool shuffled ${pool.constants} constants across ${pool.protos} protos`);
    if (shapeStats) console.error(`[wrap] shaped ${shapeStats.loops} loops, ${shapeStats.whileLeft} while left, ${shapeStats.strongNames} strong names`);
    const ms = prepareSource.stats && prepareSource.stats.macro;
    if (ms && ms.sites) console.error(`[wrap] macros sites=${ms.sites} string=${ms.strings} number=${ms.numbers} function=${ms.functions} bait=${ms.baits}`);
  }

  return code;
}

/* ---------------- reference decoder (tests) ---------------- */

function scanBalanced(code, i, open, close) {
  let depth = 0;
  let j = i;
  while (j < code.length) {
    const c = code[j];
    if (c === '"' || c === "'") {
      j++;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      j++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return -1;
}

/** split a table literal body on top-level commas */
function splitTop(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < body.length && body[j] !== c) j += body[j] === "\\" ? 2 : 1;
      cur += body.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** structural stats straight from the artifact, using the same scanner as the decoder */
function buildStats(code) {
  const text = String(code || "");
  const closures = (text.match(/return function\(/g) || []).length;
  const handlers = (text.match(/\]=function\(\)/g) || []).length;
  let layers = 0;
  let banks = 0;
  const firstKey = text.search(/\[0x[0-9A-F]+\]=\{"/);
  if (firstKey >= 0) {
    const open = text.lastIndexOf("{", firstKey);
    const end = scanBalanced(text, open, "{", "}");
    if (end > 0) {
      for (const part of splitTop(text.slice(open + 1, end - 1))) {
        const m = part.match(/^\s*\[0x([0-9A-F]+)\]=\{(?:\[==\[([^]*?)\]==\]|"([^"]*)"),(\{[^]*\}),([0-9A-Fa-fx]+)\}\s*$/);
        if (!m) continue;
        banks++;
        layers += splitTop(m[4].slice(1, -1)).filter((x) => x.trim()).length;
      }
    }
  }

  // flattened loader: one entry state plus a branch per emitted block
  let dispatch = 0;
  if (text.includes("==nil then break end")) {
    dispatch = 1 + (text.match(new RegExp(`elseif ${NAME_SRC}==0x[0-9A-F]+ then ${NAME_SRC}=${NAME_SRC} ${NAME_SRC}=${NAME_SRC}\\s*\\[`, "g")) || []).length;
  }

  return { closures, handlers, layers, banks, dispatch, bytes: Buffer.byteLength(text) };
}

function decodeReference(code) {
  if (typeof code !== "string") throw new Error("code required");
  if (!code.includes(BRAND)) throw new Error("brand missing");

  const firstKey = code.search(/\[0x[0-9A-F]+\]=\{(?:\[==\[|")/);
  if (firstKey < 0) throw new Error("bank not found");
  const bankOpen = code.lastIndexOf("{", firstKey);
  const bankEnd = scanBalanced(code, bankOpen, "{", "}");
  if (bankEnd < 0) throw new Error("bank not terminated");
  const bankBody = code.slice(bankOpen + 1, bankEnd - 1);

  const orderOpen = code.indexOf("{", bankEnd);
  const orderEnd = scanBalanced(code, orderOpen, "{", "}");
  if (orderOpen < 0 || orderEnd < 0) throw new Error("order array not found");
  const order = splitTop(code.slice(orderOpen + 1, orderEnd - 1)).map((x) => {
    const v = Number(x.trim());
    if (!Number.isFinite(v)) throw new Error("bad order entry " + x);
    return v.toString(16).toUpperCase();
  });

  const entries = new Map();
  for (const part of splitTop(bankBody)) {
    const m = part.match(/^\s*\[0x([0-9A-F]+)\]=\{(?:\[==\[([^]*?)\]==\]|"([^"]*)"),(\{[^]*\}),([0-9A-Fa-fx]+)\}\s*$/);
    if (!m) continue;
    const layers = splitTop(m[4].slice(1, -1)).map((layer) => {
      const p = splitTop(layer.slice(1, -1)).map((x) => Number(x));
      return { inv: p[0], a: p[1], step: p[2], sw: p[3], m: p[4] };
    });
    entries.set(m[1], { blob: m[2] !== undefined ? m[2] : m[3], layers, n: Number(m[5]) });
  }

  let packed = Buffer.alloc(0);
  for (const key of order) {
    const e = entries.get(key);
    if (!e) throw new Error("entry not found for key " + key);
    let bytes = unpackBlob(e.blob);
    for (let i = e.layers.length - 1; i >= 0; i--) bytes = affineDecodeBytes(bytes, e.layers[i]);
    packed = Buffer.concat([packed, Buffer.from(bytes.slice(0, e.n))]);
  }

  return lzss.decompress(packed);
}

/**
 * The image a given source compiles to for a given build seed. Tests use it as
 * the reference for decodeReference(): the payload *is* the bytecode image, so
 * equality is byte exact and the interpreter is the only thing that can read
 * it back.
 */
function referenceImage(source, options = {}) {
  const level = minifyLevel(String(options.minify || "Normal"));
  const seed = typeof options.seed === "number" ? options.seed >>> 0 : (parseInt(String(options.seed), 10) >>> 0) || 42;
  const ring = createKeyring(seed);
  const opmap = remap(ring.c);
  const instr = process.env.NOINSTR ? null : instructionCipher(ring.c, ring.k2);
  // the structural stream is consumed in wrapSource's order — two layout draws
  // first, then the pool shuffle — so one seed reproduces one image exactly
  const fieldOrder = perm.shuffle(7, ring.b);
  const tagOrder = perm.shuffle(5, ring.b);
  const layout = { fieldOrder, tagOf: { nil: tagOrder[0] + 1, false: tagOrder[1] + 1, true: tagOrder[2] + 1, number: tagOrder[3] + 1, string: tagOrder[4] + 1 } };
  return compileToImage(prepareSource(source, level), {
    opmap,
    dedupe: level !== "false",
    poolRng: ring.b,
    streamKey: ring.k1,
    instr,
    layout,
  }).image;
}

/** how big the compiled payload is before the cipher/CJK layers */
function measurePayload(source, options = {}) {
  const level = minifyLevel(String(options.minify || "Normal"));
  const seed = typeof options.seed === "number" ? options.seed >>> 0 : (parseInt(String(options.seed), 10) >>> 0) || 42;
  const ring = createKeyring(seed);
  const opmap = remap(ring.c);
  const instr = process.env.NOINSTR ? null : instructionCipher(ring.c, ring.k2);
  const fieldOrder = perm.shuffle(7, ring.b);
  const tagOrder = perm.shuffle(5, ring.b);
  const layout = { fieldOrder, tagOf: { nil: tagOrder[0] + 1, false: tagOrder[1] + 1, true: tagOrder[2] + 1, number: tagOrder[3] + 1, string: tagOrder[4] + 1 } };
  const { image, proto } = compileToImage(prepareSource(source, level), {
    opmap,
    dedupe: level !== "false",
    poolRng: ring.b,
    streamKey: ring.k1,
    instr,
    layout,
  });
  const real = proto.child.filter((c) => !c.decoy).length;
  const decoy = proto.child.filter((c) => c.decoy).length;
  return { image, len: image.length, zlen: lzss.compress(image).length, protos: real + 1, decoys: decoy };
}

function minifySource(src, mode) {
  return minifyLua(String(src == null ? "" : src), mode || "Normal");
}

module.exports = {
  BRAND,
  NAME_RE,
  buildStats,
  wrapSource,
  validate,
  decodeReference,
  referenceImage,
  measurePayload,
  opmapForSeed,
  minifySource,
  collectDeclaredNames,
  createRNG,
  makeNameFactory,
  affineEncodeBytes,
  affineDecodeBytes,
  packBlob,
  unpackBlob,
};
