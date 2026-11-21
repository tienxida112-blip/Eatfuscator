"use strict";

const fs = require("fs");
const path = require("path");
const deflate = require("../Codec/deflate");
const { minifyLua, checkSyntax } = require("../Steps/Minify");
const { compileToImage, vmSource, lowerLuau } = require("../Vm/backend");
const { flattenLoader } = require("../Steps/Flatten");
const { shapeArtifact } = require("../Steps/Shape");
const macros = require("../Steps/Macro");
const { fold } = require("../Steps/Macro/fold");
const luauCli = require("../Toolchain/luaucli");
const { luauCompress } = require("../Steps/Luau/sugar");
const { trapSource } = require("./traps");
const { remap, NAMES, freeCodepoints } = require("../Vm/Image/opcodes");

const BRAND = "dsc.gg/eatfuscator";
const HEX = "0123456789ABCDEF";
const { makeNameFactory, NAME_SRC, NAME_RE } = require("./idents");
const { digestWords } = require("../Vm/Image/cipher");
const perm = require("../Vm/Image/perm");
const feistel = require("../Vm/Image/feistel");
const crypto = require("crypto");
const { createRNG, createKeyring } = require("../Core/rng");
const WATERMARK_LINE = "-- Protected By Eatfuscator | dsc.gg/eatfuscator";

// The banner is on by default and `--setting watermark:false` removes it. It is
// the only readable text allowed in a build, so it is also the only thing that
// can tell a scanner what it is looking at - turn it off when that matters.
const wantWatermark = (options) => {
  if (options.watermark === false) return false;
  if (options.watermark === true) return true;
  const env = String(process.env.EATFUSCATOR_WATERMARK || "").trim();
  if (env) return /^(1|true|yes|on)$/i.test(env);
  return true;
};

function collapseToSingleLine(src) {
  return String(src || "").replace(/[\r\n\t\v\f]+/g, " ").replace(/  +/g, " ").trim();
}







const WRAPPER_SUFFIX = "end})[1]({...})";

const WRAPPER_SUFFIX_RE = /end\}\)\[(?:0x)?1\]"[^"]*"$|end\}\)\[(?:0x)?1\]\(\{\.\.\.\}\)$|end\}\)\[(?:0x)?1\]\(\)$/;

function makeKeyFactory(rng) {
  const used = new Set();
  return function key() {
    for (let i = 0; i < 4096; i++) {
      let hex = HEX[1 + ((rng() * 15) | 0)];
      for (let k = 0; k < 12; k++) hex += HEX[(rng() * 16) | 0];
      if (!used.has(hex)) {
        used.add(hex);
        return hex;
      }
    }
    throw new Error("key space exhausted");
  };
}

function modInverse256(m) {
  for (let x = 1; x < 256; x += 2) if (((m * x) & 255) === 1) return x;
  return 1;
}

function affineParams(rng) {
  const m = ((rng() * 127) | 0) * 2 + 1;
  const inv = modInverse256(m);

  if ((m * inv) % 256 !== 1) throw new Error("invalid cipher layer: m*inv != 1 mod 256");
  return {
    m,
    inv,
    a: (rng() * 256) | 0,
    step: (rng() * 256) | 0,
    sw: rng() < 0.5 ? 1 : 0,
    salt: (rng() * 16777216) >>> 0,
  };
}

function layerTuple(p) {
  return `{${p.inv},${p.a},${p.step},${p.sw},${p.m},${p.salt}}`;
}

function layersTuple(layers) {
  return "{" + layers.map(layerTuple).join(",") + "}";
}

function affineEncodeBytes(bytes, p) {
  return feistel.encryptLayer(Array.isArray(bytes) ? bytes : Array.from(bytes), p);
}

function affineDecodeBytes(bytes, p) {
  return feistel.decryptLayer(Array.isArray(bytes) ? bytes : Array.from(bytes), p);
}

const STORAGE_SET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.+";
const STORAGE_BASE = 64;

function storageSeedFor(seed) {
  const h = crypto.createHash("sha256");
  h.update(Buffer.from("EATF/storage64", "utf8"));
  const b = Buffer.alloc(4);
  b.writeUInt32LE(seed >>> 0, 0);
  h.update(b);
  return h.digest().readUInt32BE(4) >>> 0;
}

function alphabetParams(seed) {
  const s = seed >>> 0;
  const a = 1 + 2 * (s % 32);
  const b = Math.floor(s / 32) % STORAGE_BASE;
  return { a, b };
}

function makeAlphabet(seed) {
  const { a, b } = alphabetParams(seed);
  const digit = new Array(64);
  const rev = new Map();
  for (let d = 0; d < 64; d++) {
    const ch = STORAGE_SET[(d * a + b) % STORAGE_BASE];
    digit[d] = ch;
    rev.set(ch, d);
  }
  return { digit, rev, seed: seed >>> 0, a, b };
}

const BOOT_SEED = (128 + 64 + 32) * (256 + 256) + 1;
const BOOT_ALPHABET = makeAlphabet(BOOT_SEED);

const BLOB_FORBIDDEN = /__V\d+__|__K\d+__|__N\d+__|\[=*\[|\]=*\]/;

function blobSeed(len) {
  return (len * 7) % 64;
}

function packBlob(bytes, alpha) {
  const alphabet = alpha || BOOT_ALPHABET;
  const table = alphabet.digit;
  const arr = Array.isArray(bytes) ? bytes : Array.from(bytes);
  const raw = [];
  for (let i = 0; i < arr.length; i += 3) {
    const v = ((arr[i] || 0) << 16) | ((arr[i + 1] || 0) << 8) | (arr[i + 2] || 0);
    raw.push((v >>> 18) & 63, (v >>> 12) & 63, (v >>> 6) & 63, v & 63);
  }
  let run = blobSeed(raw.length);
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = table[(raw[i] + run) % 64];
    out += ch;
    run = (run + ch.charCodeAt(0)) % 64;
  }
  if (BLOB_FORBIDDEN.test(out)) throw new Error("storage blob collides with a loader token");
  return out;
}

function unpackBlob(blob, alpha) {
  const rev = (alpha || BOOT_ALPHABET).rev;
  let run = blobSeed(blob.length);
  const digits = new Array(blob.length);
  for (let i = 0; i < blob.length; i++) {
    const code = blob.charCodeAt(i);
    digits[i] = (((rev.get(blob[i]) - run) % 64) + 64) % 64;
    run = (run + code) % 64;
  }
  const bytes = [];
  for (let i = 0; i + 3 < blob.length; i += 4) {
    const v = ((digits[i] * 64 + digits[i + 1]) * 64 + digits[i + 2]) * 64 + digits[i + 3];
    bytes.push((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

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

function opmapForSeed(seed) {
  return remap(createKeyring(seed >>> 0).c);
}

function buildPayload(imageBytes, rng, key0, key1, key2, alpha) {
  const name = makeNameFactory(rng);
  const key = makeKeyFactory(rng);

  const raw = Buffer.isBuffer(imageBytes) ? imageBytes : Buffer.from(String(imageBytes), "utf8");
  const packed = deflate.compress(raw);

  const chunkSize = 256;
  const maxLayers = 2;

  const entries = [];
  let chunkIndex = 0;
  for (let offset = 0; offset < packed.length; offset += chunkSize, chunkIndex++) {
    const chunk = Array.from(packed.subarray(offset, offset + chunkSize));
    const rawLen = chunk.length;

    // Odd chunks are stored byte-reversed: the program's append step for those
    // chunks is the reversing handler (see buildProgram / K3 in the template),
    // so the bytes must be laid down backwards here or the rebuilt stream is
    // mangled. Padding is added *after* the flip, and the reader truncates to
    // rawLen before reversing, so the padding never reaches the stream.
    if (chunkIndex % 2 === 1) chunk.reverse();

    while (chunk.length % 12 !== 0) chunk.push(0);
    const layerCount = 1 + ((rng() * maxLayers) | 0);
    const layers = [];
    for (let l = 0; l < layerCount; l++) layers.push(affineParams(rng));

    let cur = chunk;
    for (const p of layers) cur = affineEncodeBytes(cur, p);

    entries.push({ key: key(), blob: packBlob(cur, alpha), layers, n: rawLen });
  }

  const orderKeys = entries.map((e) => e.key);

  for (let i = entries.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }

  const decoyCount = 2 + ((rng() * 3) | 0);
  for (let d = 0; d < decoyCount; d++) {
    const len = 24 + ((rng() * 72) | 0);
    const bytes = [];
    for (let i = 0; i < len; i++) bytes.push((rng() * 256) | 0);
    while (bytes.length % 12 !== 0) bytes.push(0);
    const p = affineParams(rng);
    const enc = affineEncodeBytes(bytes, p);
    entries.push({ key: key(), blob: packBlob(enc, alpha), layers: [p], n: len, decoy: true });
  }

  const k0 = key0 || 1 + ((rng() * 255) | 0);
  const k1 = key1 || 1 + ((rng() * 255) | 0);
  const k2 = key2 || 1 + ((rng() * 16777214) | 0);

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

function padBanks(payload, rng, target, overhead, alpha) {
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

    const entry = { key: freshKey(), blob: packBlob(cur, alpha), layers, n: len, filler: true };
    payload.entries.push(entry);
    bankBytes += u8("[0x" + entry.key + ']={"' + entry.blob + '",' +
      layersTuple(layers) + "," + len + "},");
    added++;
  }

  return { added, bankBytes };
}

function opcodeSpares(opmap, count, rng) {
  const used = new Set(Object.values(opmap));
  const free = [];
  for (let v = 1; v < 256; v++) if (!used.has(v)) free.push(v);
  const out = [];
  for (let i = 0; i < count && free.length; i++) {
    const at = (rng.word ? rng.word() : Math.floor(rng() * 4294967296)) % free.length;
    out.push(free.splice(at, 1)[0]);
  }
  while (out.length < count) out.push(1 + (out.length % 255));
  return out;
}

const HANDLER_TOKENS = ["__V43__", "__V48__", "__V53__", "__V56__", "__V59__", "__V60__"];

function buildProgram(rng, chunks, alpha) {
  const pool = [];
  for (let i = 0; i < 256; i++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const opcodes = pool.slice(0, 6);
  const opKey = [1 + ((rng() * 255) | 0), 1 + ((rng() * 255) | 0), 1 + ((rng() * 255) | 0), 1 + ((rng() * 255) | 0)];

  const program = [];
  for (let c = 0; c < Math.max(1, chunks); c++) {
    program.push(opcodes[0], opcodes[1], c % 2 === 0 ? opcodes[3] : opcodes[2]);
  }
  const enciphered = program.map((op, i) => (op + 256 - opKey[i % 4]) % 256);

  return { opcodes, opKey, enciphered, blob: packBlob(enciphered, alpha) };
}

let parser = null;
try { parser = require("../Vendor/luaparse"); } catch {  }
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
    if (c === "[" && /^\[(=*)\[/.test(code.slice(i, i + 8))) {
      const m = code.slice(i).match(/^\[(=*)\[/);
      const close = "]" + m[1] + "]";
      const end = code.indexOf(close, i + m[0].length);
      const j = end < 0 ? n : end + close.length;
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

function maskNumbers(code, rng, rate = 0.55, opts = {}) {
  let out = "";
  let i = 0;
  const n = code.length;
  const prevOk = (k) => k < 0 || !/[A-Za-z0-9_.]/.test(code[k]);
  let masked = 0;
  const binary = !!opts.binary;
  const isKey = (from, to) => code[from] === "[" && code[to] === "]";
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

    if (c === "{" && code[i + 1] === "{") {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (code[j] === "{") depth++;
        else if (code[j] === "}") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
        j++;
      }
      out += code.slice(i, j);
      i = j;
      continue;
    }
    if (c === "[" && /^\[(=*)\[/.test(code.slice(i, i + 8))) {
      const m = code.slice(i).match(/^\[(=*)\[/);
      const close = "]" + m[1] + "]";
      const end = code.indexOf(close, i + m[0].length);
      const j = end < 0 ? n : end + close.length;
      out += code.slice(i, j);
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9" && prevOk(i - 1)) {
      let j = i;
      let value = null;
      if (code[i] === "0" && /[xX]/.test(code[i + 1] || "")) {
        let k = i + 2;
        while (k < n && /[0-9A-Fa-f]/.test(code[k])) k++;
        if (k > i + 2) {
          value = parseInt(code.slice(i + 2, k), 16);
          j = k;
        }
      } else {
        let k = i;
        while (k < n && /[0-9]/.test(code[k])) k++;
        const next = code[k];
        if (next === "." || next === "e" || next === "E") {
          while (k < n && /[0-9.eE+-]/.test(code[k])) k++;
          out += code.slice(i, k);
          i = k;
          continue;
        }
        value = parseInt(code.slice(i, k), 10);
        j = k;
      }
      if (value !== null && value >= 9 && value <= Number.MAX_SAFE_INTEGER && rng() < rate) {
        const d = 1 + ((rng() * 0xfff) | 0);
        const lo = Math.max(1, value - d);
        const pick = rng();
        if (binary && value <= 0xfff && pick < 0.45) {
          if (pick < 0.22) out += `(0b${(value + d).toString(2)}-0b${d.toString(2)})`;
          else out += `(0b${lo.toString(2)}+0b${(value - lo).toString(2)})`;
        } else if (pick < 0.72) {
          out += `(0x${(value + d).toString(16).toUpperCase()}-0x${d.toString(16).toUpperCase()})`;
        } else {
          out += `(0x${lo.toString(16).toUpperCase()}+0x${(value - lo).toString(16).toUpperCase()})`;
        }
        masked += 1;
      } else if (value !== null) {
        if (binary && value >= 2 && value <= 0xff && !isKey(i, j) && rng() < 0.22) out += `0b${value.toString(2)}`;
        else out += code.slice(i, j);
      }
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  maskNumbers.count = masked;
  return out;
}

function validate(code, options = {}) {
  const target = options.target === "portable" ? "portable" : "luau";
  const problems = [];

  if (typeof code !== "string" || !code.length) problems.push("empty output");

  const lines = code.split("\n");
  const codeLines = lines[0] === WATERMARK_LINE ? lines.slice(1) : lines;
  if (codeLines.length !== 1) problems.push("output must be one code line, optionally under a watermark line");
  if (/[\r]/.test(code)) problems.push("carriage return in output");

  const prefix = `return({function(...)`;
  if (!codeLines[0] || !codeLines[0].startsWith(prefix)) problems.push("wrapper prefix mismatch");
  if (!WRAPPER_SUFFIX_RE.test(code)) problems.push("wrapper suffix mismatch");
  if (!code.includes(BRAND)) problems.push("brand missing");

  if (/~(?!=)/.test(code)) problems.push("bitwise/XOR operator present");
  if (/loadstring/.test(code)) problems.push("literal loadstring present");
  if (/\bload\s*\(/.test(code)) problems.push("literal load() present");
  if (/__V\d+[a-z]?__|__N\d+__|__DATA__|__VMTABLE__/.test(code)) problems.push("unreplaced template token");
  if (/\[\s*"[A-Za-z]/.test(code)) problems.push("string table key present");
  if (/\bwhile\s+true\b/.test(code)) problems.push("readable `while true` trap left in the artifact");
  if (/Eatfuscator Said No Skid/.test(code)) problems.push("plaintext trap message survived");
  if (/\bv\d+(\.\d+)+\b/i.test(code)) problems.push("version string present");

  let gate = "luau-lower";

  const declared = collectDeclaredNames(code);
  const bad = declared.filter((n) => !NAME_RE.test(String(n)));
  if (bad.length) problems.push("non-conforming identifiers: " + [...new Set(bad)].slice(0, 8).join(", "));

  const batches = [...code.matchAll(/\blocal ([A-Za-z_][A-Za-z0-9_]*(?:,[A-Za-z_][A-Za-z0-9_]*)+)(?=[\s=(])/g)]
    .map((m) => m[1].split(",").length);
  if (batches.length && batches[0] < 6) problems.push("first declaration batch too small");

  const closures = (code.match(/return function\(/g) || []).length;
  if (closures < 4) problems.push(`upvalue chain too shallow (${closures} nested closures)`);
  const handlers = (code.match(/\]=function\(\)/g) || []).length;
  if (handlers < 4) problems.push(`VM handler table incomplete (${handlers})`);

  const num = "(0x[0-9A-Fa-f]+|\\d+)";
  const layerRe = new RegExp("\\{\\{" + [num, num, num, num, num, num].join(",") + "\\}\\}", "g");
  let lm;
  let layerCount = 0;
  while ((lm = layerRe.exec(code)) !== null) {
    layerCount++;
    const inv = Number(lm[1]);
    const m = Number(lm[5]);
    const salt = Number(lm[6]);
    if ((inv * m) % 256 !== 1) problems.push(`non-invertible cipher layer inv=${inv} m=${m}`);
    if (Number(lm[2]) > 255 || Number(lm[3]) > 255) problems.push("cipher parameter out of byte range");
    if (!(salt >= 0 && salt < 16777216)) problems.push(`cipher salt out of range (${salt})`);
  }
  if (layerCount === 0) problems.push("no cipher layers found");

  return { ok: problems.length === 0, problems, declared, closures, handlers, layers: layerCount, target, gate };
}

function buildConstants(rng, key, alpha) {

  const vals = [19968, 4096, 64, 128, 65536, 16777216, 83, 9, 0];
  const bytes = [];
  for (const v of vals) bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const layer = affineParams(rng);
  const enc = affineEncodeBytes(bytes, layer);
  return { key: key(), blob: packBlob(enc, alpha), layers: [layer], n: bytes.length, vals };
}

function constHash(vals) {
  let h = 0;

  for (let i = 0; i < vals.length; i++) h = (h + vals[i] * (i + 4)) % 16777216;
  return h;
}

const DATA_MARK = "__DATA__";
const TRAP_MARK = "__TRAP__";
const VM_MARK_VM = "__VM__";
const VM_MARK = "__VMTABLE__";

let LONG_LEVEL = 2;

function setLongLevel(rng) {
  const r = typeof rng === "function" ? rng() : Math.random();
  LONG_LEVEL = 1 + Math.floor(r * 3);
}

function longString(text) {
  if (/[\]\n\r]/.test(text)) return JSON.stringify(text);
  const eq = "=".repeat(LONG_LEVEL);
  return "[" + eq + "[" + text + "]" + eq + "]";
}

// A string literal as a long bracket. Escapes are the one place the emitter can
// silently lose a byte: `\NNN` runs into the next digit, a `$` in a replacement
// pattern eats a byte, and every escape written by hand is a chance to disagree
// with the decoder. A long bracket has no escapes at all - what is written is
// what the chunk sees - so every string that can be one, is one. The level is
// raised until the closing sequence cannot occur, and a body that ends in `]`
// needs a higher level for the same reason: `]]` would close it early.
// Content with a newline or a carriage return stays escaped, because Lua folds
// any of CR, LF, CRLF and LFCR inside a long string to a single LF.
function luaStr(text) {
  const s = String(text);
  if (/[\r\n]/.test(s)) return JSON.stringify(s);
  // Level 0 wherever it is safe: `[[...]]` is two bytes of overhead per literal,
  // and the alphabet alone is ninety-one literals.
  let level = 0;
  for (;;) {
    const eq = "=".repeat(level);
    const close = "]" + eq + "]";
    if (!s.includes(close) && !s.endsWith("]" + eq)) {
      const open = "[" + eq + "[";
      return open + s + close;
    }
    level++;
    if (level > 32) return JSON.stringify(s);
  }
}

function entriesToLua(entries) {
  const parts = [];
  for (const e of entries) {
    const layers = layersTuple(e.layers);
    parts.push(`[0x${e.key}]={${longString(e.blob)},${layers},${e.n}}`);
  }
  return "{" + parts.join(",") + "}";
}

function guardParse(lowered) {
  if (!parser) return;
  try {
    parser.parse(lowered, { luaVersion: "5.1", comments: false, locations: false, ranges: false });
  } catch (e) {
    const at = /\[(\d+):(\d+)\]/.exec(String(e.message || ""));
    const lines = String(lowered).split("\n");
    const line = at ? Math.min(Number(at[1]) + 1, lines.length) : 0;
    const hit = line ? String(lines[line - 1] || "").trim().slice(0, 60) : "";
    const err = new Error(
      `input is not valid Luau: ${String(e.message || e).split("\n")[0]}${hit ? ` — line ${line}: ${hit}` : ""}`
    );
    err.code = "ESYNTAX";
    throw err;
  }
}

function prepareSource(src, macroRng) {

  const expanded = macros.expand(String(src), { rng: macroRng });
  let lowered;
  try {
    lowered = lowerLuau(expanded.code);
  } catch (e) {
    // A construct this front end cannot lower is an input problem, not a broken
    // build: tag it so the caller reports it instead of silently falling back to
    // the flat envelope (which used to make an unsupported `goto` look accepted).
    if (!e.code) e.code = "ESYNTAX";
    throw e;
  }

  guardParse(lowered);
  lowered = fold(lowered).code;
  prepareSource.stats = { macro: expanded.stats };
  return minifyLua(lowered, "Normal");
}

function compileSource(text, options) {
  try {
    return compileToImage(text, options);
  } catch (e) {
    if (e instanceof RangeError || e instanceof TypeError) throw e;
    const where = (() => {
      const m = /\[(\d+):(\d+)\]/.exec(String(e.message || ""));
      return m ? `line ${m[1]} of the lowered source` : "the lowered source";
    })();
    const err = new Error(`input is not valid Luau: ${String(e.message || e).split("\n")[0]} (at ${where})`);
    err.code = "ESYNTAX";
    throw err;
  }
}

function resolveSeed(input) {
  if (input === undefined || input === null || input === "random") {
    const buf = crypto.randomBytes(4);
    return buf.readUInt32LE(0) >>> 0 || 1;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      throw new Error(`seed must be an integer, got ${input}`);
    }
    const v = input >>> 0;
    if (input !== v && input !== (v | 0)) throw new Error(`seed out of range: ${input}`);
    return v;
  }
  const text = String(input).trim();
  if (!/^\d+$/.test(text)) throw new Error(`seed must be a non-negative integer, got "${input}"`);
  const v = Number(text);
  if (!Number.isSafeInteger(v) || v > 0xffffffff) throw new Error(`seed out of range: ${input}`);
  return v >>> 0;
}


function wrapSimple(src, options = {}) {
  const seed = resolveSeed(options.seed);
  const rng = createRNG(seed);
  const text = String(src || "");
  const bytes = Array.from(Buffer.from(text, "utf8"));
  const key = [];
  for (let i = 0; i < 8; i++) key.push(1 + (rng() * 255 | 0));
  const enc = bytes.map((b, i) => (b + key[i % key.length]) % 256);
  // pack as decimal list to avoid encoding issues
  const dataLit = "{" + enc.join(",") + "}";
  const keyLit = "{" + key.join(",") + "}";
  // Roblox-safe loader: uses loadstring/_ENV
  const body = [
    "return(function(...)",
    "local e,k=" + dataLit + "," + keyLit,
    "local o={}",
    "for i=1,#e do o[i]=string.char((e[i]-k[(i-1)%#k+1])%256) end",
    "local s=table.concat(o)",
    "local f,err=loadstring(s)",
    "if not f then error(err) end",
    "return f(...)",
    "end)(...)",
  ].join(" ");
  const collapsed = collapseToSingleLine(body);
  return (wantWatermark(options) ? WATERMARK_LINE + "\n" : "") + collapsed;
}

const TRUTHY = /^(1|true|yes|on)$/i;

/** Is the lightweight envelope requested? Explicit wins over the environment. */
function wantsSimple(options) {
  // `EAT_NO_VIRTUALIZE` is the name for this switch. It used to be documented as
  // EATFUSCATOR_SIMPLE (and, inverted, FULLVM); both still work so old scripts do
  // not silently build something else, but the new name is what the docs use.
  const envSimple = TRUTHY.test(String(process.env.EAT_NO_VIRTUALIZE || process.env.EATFUSCATOR_SIMPLE || ""));
  const envFull = TRUTHY.test(String(process.env.FULLVM || ""));
  if (envFull) return false;
  if (options.simple === true) return true;
  if (options.simple === false) return false;
  return envSimple;
}

// The loader body of the most recent build, before it is wrapped in the
// load-time envelope. obfuscate() compile-checks it (see fullCompile).
let lastLoaderText = "";
let bulkStats = null;
function loaderText() {
  return lastLoaderText;
}

function wrapSource(src, options = {}) {
  // The bytecode VM is the real product and is the default again; the flat
  // envelope stays available for callers that ask for it (simple: true) or when
  // a build has to be kept tiny (EATFUSCATOR_SIMPLE=1).
  if (wantsSimple(options)) {
    return wrapSimple(src, options);
  }


  const target = String(options.target || "luau").toLowerCase() === "portable" ? "portable" : "luau";

  const seed = resolveSeed(options.seed);

  const macroRng = createRNG((seed ^ 0x5bf03635) >>> 0);
  const sourceText = prepareSource(src, macroRng);
  if (!sourceText.length) throw new Error("empty input");

  const rng = createRNG(seed);
  setLongLevel(rng);

  const ring = createKeyring(seed);

  const opmap = remap(ring.c);

  const codeSalt = (ring.b.word() % 16777216) >>> 0;
  const strSalt = (ring.b.word() % 16777216) >>> 0;

  const instr = process.env.NOINSTR ? null : { k1: ring.k1, k2: ring.k2, salt: codeSalt };
  const streamKeys = process.env.NOSTR ? null : { k1: ring.k1, k2: ring.k2, salt: strSalt };

  const fieldOrder = perm.shuffle(7, ring.b);
  const tagOrder = perm.shuffle(5, ring.b);
  const tagOf = {
    nil: tagOrder[0] + 1,
    false: tagOrder[1] + 1,
    true: tagOrder[2] + 1,
    number: tagOrder[3] + 1,
    string: tagOrder[4] + 1,
  };
  const layout = { fieldOrder, tagOf, fieldCode: perm.encode(fieldOrder), tagCode: perm.encode(tagOrder) };

  const alphabetSeed = storageSeedFor(seed) % 16777216;
  const alphabet = makeAlphabet(alphabetSeed);

  const { image, proto: dumpProto } = compileSource(sourceText, {
    opmap,
    dedupe: true,
    poolRng: ring.b,
    streamKey: streamKeys,
    instr,
    layout,
    // Test hook only (tools/tamper.js): corrupt one layer-3 token during the
    // build, exactly where a patcher would be working.
    forgeMutation: options.forgeMutation || null,
  });
  if (process.env.EAT_DUMP_IMAGE) {
    // Debug hook: dump the raw VM image (and optionally the compiled protos) so
    // the loader can be checked against what the compiler meant to emit.
    require("fs").writeFileSync(process.env.EAT_DUMP_IMAGE, Buffer.from(image));
  }
  if (process.env.EAT_DUMP_PROTO) {
    const seen = new Map();
    const strip = (p) => {
      if (seen.has(p)) return { ref: seen.get(p) };
      const idx = seen.size;
      seen.set(p, idx);
      return { i: idx, np: p.numParams, va: p.isVararg, nk: p.k.length, k: p.k, code: p.code, uv: p.uv, child: p.child.map(strip) };
    };
    require("fs").writeFileSync(process.env.EAT_DUMP_PROTO, JSON.stringify({ opmap, proto: strip(dumpProto) }));
  }
  const payload = buildPayload(image, ring.a, ring.k0, ring.k1, ring.k2, alphabet);
  const vm = buildProgram(rng, payload.orderKeys.length, alphabet);

  let template = fs.readFileSync(path.join(__dirname, "Template", "runtime.lua"), "utf8");

  {
    const clash = template.match(/__V9\d{3}__/g);
    if (clash) throw new Error(`runtime template uses reserved interpreter token range: ${[...new Set(clash)].slice(0, 4).join(", ")}`);
  }
  if (template.includes(VM_MARK_VM)) {
    const hot = ["MOVE", "LOADK", "CALL", "BOXGET", "SETTABLEC", "GETTABLE", "GETUPVALV", "ADD"];
    const mix = (list) => {
      const a = list.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = (ring.b.word() % (i + 1)) | 0;
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
      }
      return a;
    };
    const dispatchOrder = mix(hot).concat(mix(NAMES.filter((n) => !hot.includes(n))));
    const shapes = [
      "      reg[a] = reg[b]",
      "      reg[a] = konst[ds + T_ONE]",
      "      reg[a] = reg[b] + reg[c]",
      "      reg[a] = ups[b + T_ONE][T_CELL]",
      "      local na = b - T_ONE\n      if c == T_TWO and na <= T_THREE then\n        if na == T_ONE then\n          reg[a] = reg[a](reg[a + T_ONE])\n        elseif na == T_TWO then\n          reg[a] = reg[a](reg[a + T_ONE], reg[a + T_TWO])\n        else\n          reg[a] = reg[a]()\n        end\n      end",
      "      local q = reg[a] - T_ONE\n      if q ~= nil then\n        reg[a] = q % T_B8\n      end",
    ];
    const decoyCount = 3 + (ring.b.word() % 4);
    const decoyBranches = [];
    const spare = opcodeSpares(opmap, decoyCount, ring.b);
    for (let d = 0; d < decoyCount; d++) {
      decoyBranches.push({ code: spare[d], body: shapes[(ring.b.word() + d) % shapes.length] });
    }
    // Test hook (suite): break the program's length pin after the digest and the
    // slice marks are computed, the way a mid-run patch would. The load succeeds -
    // the load-time digest is happy, the code really is the code that was sealed -
    // and only the interpreter's own guard can catch it. A payload that still
    // prints with this on is a payload whose guard does not fire.
    template = template.replace(VM_MARK_VM, () => vmSource({ opmap, resolve: (t) => t, order: dispatchOrder, decoys: decoyBranches, rng: ring.b, hot, guardProbe: !!options.guardProbe }));
  }

const NAMES_MARK = "__NAMES__";

/**
 * The loader's own vocabulary, encrypted.
 *
 * Every name the loader needs - `game`, `Instance`, `GetService`, `Players`,
 * `Heartbeat`, the member names it audits, the strings it compares against - used
 * to be spelled as arithmetic on character codes (`CH(103)..CH(97)..`). That is
 * opaque to a human and *free* to a static tool: one fold pass turns the whole
 * artifact back into readable API names without executing a single instruction.
 *
 * So the names live in one encrypted blob instead. It is decrypted at load with a
 * keystream keyed from the build's own code salt, using only the byte/char/sub
 * methods reached through the empty-string metatable - never the global `string`
 * table, so a swapped library cannot poison the decoder. Nothing else in the
 * artifact spells an API name; a static reader gets a blob and a byte loop, and
 * has to reimplement the constant bank (layer 2) before the key even exists.
 */
function nameBankLua(bank, opts = {}) {
  const NB = opts.bankLocal;
  const BY = opts.byteLocal;
  const CH = opts.charLocal;
  const SB = opts.subLocal;
  const CC = opts.concatLocal;
  const nk = opts.key % 253;
  const plain = [];
  for (const w of bank.list) {
    for (const b of Buffer.from(String(w), "utf8")) plain.push(b);
    plain.push(1);
  }
  const enc = plain.map((b, i) => (b + (nk * (i + 1)) % 253) % 256);
  // Printable bytes stay printable, everything else becomes a decimal escape, so
  // the blob survives any editor or transport that mangles raw bytes.
  let blob = "";
  for (const b of enc) {
    if (b === 34 || b === 92) blob += "\\" + String.fromCharCode(b);
    // Space is escaped like any other byte. The artifact is collapsed onto one
    // line at the end of the build and that pass squeezes runs of whitespace, so
    // a bank blob containing two spaces in a row silently lost a byte and every
    // interned name decoded to nil. That was one seed in ten.
    else if (b >= 33 && b <= 126) blob += String.fromCharCode(b);
    else blob += "\\" + String(b).padStart(3, "0");
  }
  const i = opts.tmp;
  const out = [];
  out.push(`local ${NB}={}`);
  out.push(`do local s=${JSON.stringify("").replace('""', () => '"' + blob + '"')} local k=(${opts.saltA}+${opts.saltB})%253 local n=#s local ${i}c,${i}i=${"{}"},1`);
  out.push(`while ${i}i<=n do ${i}c[${i}i]=${CH}((${BY}(s,${i}i)-(k*${i}i)%253)%256) ${i}i=${i}i+1 end`);
  out.push(`local t=${CC}(${i}c) local ${i}s,${i}x,${i}p=1,1,1 local m=#t`);
  out.push(`while ${i}p<=m do if ${BY}(t,${i}p)==1 then ${NB}[${i}x]=${SB}(t,${i}s,${i}p-1) ${i}x=${i}x+1 ${i}s=${i}p+1 end ${i}p=${i}p+1 end`);
  out.push(`${NB}[${i}x]=${SB}(t,${i}s,m) end`);
  return out.join(" ");
}

const ATTEST_MARK = "__ATTEST__";

/**
 * Anti-tamper v1 + v2.
 *
 * v1 (the flat idea, from the reference material): a host-environment sanity
 * pass. Every check there was an independent `expect(...)`, so a reader - or a
 * patcher - could see exactly what was being tested, and dropping one check
 * changed nothing else.
 *
 * v2 (the chained idea): the checks are a *sequence* whose results feed one
 * rolling state word, so no check can be skipped or reordered without changing
 * the final word; the host's own functions are captured at start-up and compared
 * again later by identity; and the whole verdict is re-run periodically from
 * inside the interpreter, not just once at load.
 *
 * What is emitted here, in order:
 *   1. a per-build salt table, one salt per check (seeded, so two builds never
 *      fold the same way);
 *   2. one closure per check. A closure whose host facility is missing returns
 *      true, so a thin host degrades instead of dying;
 *   3. the chain: h = h*33 + pass*salt[i] + i*5, mod 2^24, starting from a seeded
 *      word. The expected value is folded at build time, so a reordered, skipped
 *      or lied-about check lands on a different word;
 *   4. a reference snapshot of the host's own functions/tables, taken now, and a
 *      cheap re-check function the interpreter calls as it runs. A host that
 *      swaps `pcall` (or `game`, or `string.byte`) after load is caught the next
 *      time the guard ticks;
 *   5. the word `h - expected`, which is zero on a healthy host and is *added
 *      into the interpreter's code salt*. Deleting this block therefore does not
 *      remove the anti-tamper - it makes the layer-3 decode key wrong, so the
 *      artifact cannot decode its own program any more.
 *
 * Everything is opaque: no check names, no counts, no message text. Function
 * names are assembled from character codes through the preamble's char handle,
 * so the artifact spells no global identifier at all.
 */
/**
 * The Roblox API atlas: services, their members, and the classes Instance.new
 * must know.
 *
 * The gate asks "is this a Roblox client". The atlas asks the follow-up: "is it
 * the *whole* client". Every service is resolved, then held to its own
 * consistencies - the same object twice, the right ClassName, the right parent,
 * FindFirstChild agreeing with GetService, IsA agreeing with ClassName - and every
 * declared member has to be there. A host that fakes six services badly fails the
 * consistency tier; a host that presents a rich DataModel but only knows a
 * handful of services fails the presence tier.
 *
 * Both tiers are scored, never decided by one answer, and neither is reached at
 * all on a thin host: the member tier needs four misses and the presence tier
 * needs the host to be presenting at least 24 services in the first place. That
 * is what keeps a Luau CLI harness and a cut-down client from being shot at
 * while a real client walks straight through.
 */
const SERVICE_ATLAS = [
  ["Players", ["GetPlayers", "PlayerAdded"]],
  ["RunService", ["Heartbeat"]],
  ["Workspace", []],
  ["Lighting", []],
  ["TweenService", ["Create"]],
  ["UserInputService", ["InputBegan", "IsKeyDown"]],
  ["ReplicatedStorage", []],
  ["ReplicatedFirst", []],
  ["ServerStorage", []],
  ["ServerScriptService", []],
  ["StarterGui", []],
  ["StarterPack", []],
  ["StarterPlayer", []],
  ["SoundService", []],
  ["Chat", []],
  ["Teams", []],
  ["CollectionService", ["GetTagged"]],
  ["HttpService", []],
  ["MarketplaceService", []],
  ["TeleportService", []],
  ["PathfindingService", []],
  ["PhysicsService", []],
  ["PolicyService", []],
  ["GuiService", []],
  ["LocalizationService", []],
  ["ContentProvider", []],
  ["Debris", []],
  ["BadgeService", []],
  ["DataStoreService", []],
  ["MemoryStoreService", []],
  ["MessagingService", []],
  ["GroupService", []],
  ["InsertService", []],
  ["AssetService", []],
  ["VRService", []],
  ["HapticService", []],
  ["SocialService", []],
  ["TextService", []],
  ["LogService", []],
  ["CoreGui", []],
  ["ContextActionService", []],
  ["ProximityPromptService", []],
  ["VoiceChatService", []],
  ["AvatarEditorService", []],
  ["FriendService", []],
  ["MaterialService", []],
  ["SessionService", []],
  ["UserService", []],
];

// Classes Instance.new has to know. All of them predate 2015, so a client that
// does not have them is not a client.
const CLASS_ATLAS = [
  "Part", "Folder", "Model", "ScreenGui", "Frame", "TextLabel", "TextButton",
  "ImageLabel", "Sound", "ObjectValue", "StringValue", "NumberValue",
  "BoolValue", "BindableEvent", "RemoteEvent", "Configuration", "Camera",
  "Attachment", "WedgePart", "SpawnLocation",
];

// ---------------------------------------------------------------------------
// The string pool.
//
// Every name the loader asks for - library functions, type names, service and
// class names, member names, the strings it compares against - is interned here
// and emitted exactly once, as cipher bytes packed four to a number. The decode
// is arithmetic: pack index and byte index give the number, a rotation of the
// pack gives the byte, and the byte is unmasked with the same index the encoder
// used. Nothing is spelled, nothing is a literal, and no character of a name
// exists anywhere in the file until the line that asks for it runs.
//
// The one exception is `string.char`, because a decoder that builds strings has
// to be handed a way to build strings. It is fetched off the empty string's own
// metatable - `("")["\99\104\97\114"]` - so the loader still names no global
// table and no library to get it.
function createStringPool({ rng, call, locals }) {
  // The alphabet is per build: a permutation of the printable characters a name
  // can be made of. It is emitted as a table of one-character literals, so the
  // loader needs no string constructor, no `sub`, and no escape sequences - the
  // three things a deobfuscator pattern-matches for.
  const alphabet = [];
  for (let c = 32; c <= 126; c++) {
    if (c === 34 || c === 92) continue; // " and \ stay out: they would need escapes
    alphabet.push(String.fromCharCode(c));
  }
  for (let i = alphabet.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = alphabet[i];
    alphabet[i] = alphabet[j];
    alphabet[j] = tmp;
  }
  const index = new Map(alphabet.map((c, i) => [c, i]));
  const base = alphabet.length;
  const mult = 2 * Math.floor(rng() * 90) + 1;
  const add = Math.floor(rng() * base);

  const words = [];
  const seen = new Map();
  const starts = [];
  let total = 0;

  const ref = (word) => {
    const w = String(word);
    let id = seen.get(w);
    if (id === undefined) {
      id = words.length + 1;
      seen.set(w, id);
      words.push(w);
      starts.push(total);
      total += w.length;
    }
    return `${call}(${id})`;
  };

  const render = () => {
    const syms = [];
    for (const w of words) {
      for (const c of w) {
        const s = index.get(c);
        if (s === undefined) throw new Error(`string pool: ${JSON.stringify(c)} is outside the alphabet (in ${JSON.stringify(w)})`);
        syms.push(s);
      }
    }
    const enc = syms.map((s, j) => (s + (j * mult + add)) % base);
    while (enc.length % 4) enc.push(0);
    const packs = [];
    for (let i = 0; i < enc.length; i += 4) {
      packs.push(enc[i] + enc[i + 1] * base + enc[i + 2] * base * base + enc[i + 3] * base * base * base);
    }
    const offs = starts.concat([total]);
    const { fn } = locals;
    // every symbol of the alphabet as a long bracket: no escape processing at
    // all on the one table the decoder inner-loops over.
    const table = alphabet.map((c) => luaStr(c)).join(",");
    // One statement, one local: an IIFE that closes over its own tables and
    // hands back the decoder. The loader's control-flow flattener rewrites the
    // statements around it; keeping the pool in a single expression means there
    // is nothing for it to reach into.
    return [
      `${fn}=(function() local A={${table}}`,
      `local P={${packs.join(",")}}`,
      `local O={${offs.join(",")}}`,
      `local C={}`,
      `local ${V("__V4401__")}=${mult} local ${V("__V4402__")}=${add}`,
      `return function(i) local v=C[i] if v~=nil then return v end local a,b=O[i],O[i+1] local r=""`,
      `while a<b do local w=P[(a-(a%4))/4+1] local k=a%4`,
      `local e=k<1 and w%${base} or k<2 and ((w-w%${base})/${base})%${base} or k<3 and ((w-w%${base * base})/${base * base})%${base} or ((w-w%${base * base * base})/${base * base * base})%${base}`,
      `r=r..A[(e-(a*${V("__V4401__")}+${V("__V4402__")})%${base})%${base}+1] a=a+1 end C[i]=r return r end end)()`,
    ].join(" ");
  };

  return { ref, render, size: () => total };
}


// ---------------------------------------------------------------------------
// The loadstring envelope.
//
// Everything the loader does lives in the artifact as cipher bytes: the whole
// generated program is deflated, encrypted and packed over a per-build alphabet,
// and the file itself is a small bootstrap that unpacks it, inflates it and hands
// the result to loadstring. That is what "compressed VM" means in the artifacts
// people compare against: the interpreter does not exist as source in the file,
// it exists as source in memory, once, for as long as the chunk takes to run.
function emitLoadstringEnvelope(inner, { rng, spool, inflateText, alpha }) {
  const deflate = require("../Codec/deflate");
  const raw = Buffer.from(inner, "latin1");
  const packed = deflate.compress(raw);

  // A keystream over the byte index, so no two positions share a mask.
  const k1 = 2 * Math.floor(rng() * 127) + 1;
  const k2 = Math.floor(rng() * 256);
  const enc = Buffer.from(packed);
  for (let i = 0; i < enc.length; i++) enc[i] = (enc[i] + (i * k1 + k2)) % 256;

  // 5 characters per 4 bytes over a per-build alphabet of 91 printable symbols
  // (91^5 > 2^32, so every 32-bit word has exactly one spelling). 4/3 was the
  // old pack; 5/4 is 6.7% narrower on the same bytes and costs nothing to unpack.
  const syms = [];
  for (let c = 33; c <= 126; c++) {
    // Printable, minus `"` and `\\` (they would need escaping in the literal),
    // minus `%` (a Lua pattern character), and no whitespace at all: the artifact
    // is collapsed onto one line at the end of the build, and a whitespace run
    // inside the blob would be squeezed out of it.
    if (c === 34 || c === 92 || c === 37) continue;
    syms.push(String.fromCharCode(c));
  }
  for (let i = syms.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = syms[i];
    syms[i] = syms[j];
    syms[j] = tmp;
  }
  const table = syms;
  const radix = table.length;
  const chars = [];
  for (let i = 0; i < enc.length; i += 4) {
    let v = ((enc[i] * 256 + (i + 1 < enc.length ? enc[i + 1] : 0)) * 256 + (i + 2 < enc.length ? enc[i + 2] : 0)) * 256 + (i + 3 < enc.length ? enc[i + 3] : 0);
    v = v >>> 0;
    const digits = [0, 0, 0, 0, 0];
    for (let d = 4; d >= 0; d--) {
      digits[d] = v % radix;
      v = (v - digits[d]) / radix;
    }
    for (let d = 0; d < 5; d++) chars.push(table[digits[d]]);
  }
  // The marker is the first thing in the string and is stripped before decoding:
  // it makes a compressed table identifiable in a file without changing a byte of
  // what it decodes to.
  const blob = "EAT-" + chars.join("");
  if (/[\s"\\%]/.test(blob.slice(4)) || /[\s"\\%]/.test(table.join(""))) {
    throw new Error("envelope: the packed blob carries a character the artifact cannot hold");
  }

  const S = (w) => spool.ref(w);
  // The inflate is the same code the loader uses; its locals are renamed here so
  // the bootstrap does not read like the template it came from, and the four
  // library functions it needs are bound to locals before it.
  const rename = new Map();
  const inflateClean = require("../Toolchain/source").stripComments(inflateText, "lua");
  const renamed = inflateClean.replace(/__V(\d+)__/g, (m, d) => {
    if (d === "001") return alpha.byte;
    if (d === "002") return alpha.chr;
    if (d === "0119") return alpha.cat;
    if (d === "0709") return alpha.err;
    if (!rename.has(m)) rename.set(m, alpha.mint());
    return rename.get(m);
  });

  const entry = rename.get("__V0410__");
  if (!entry) throw new Error("envelope: inflate entry point not found in the template block");

  const A = alpha.alphabet;
  const T = alpha.text;
  const L = alpha.len;
  const G = alpha.lookup;
  // The unpack loop's own locals used to be the literal names `i`, `oi`, `v`, `q`,
  // `w`, `d`, `e`, `j`. The identifier factory knows nothing about literal text,
  // so on one seed in ten it minted `oi` for something else - the char function,
  // as it turned out - and the artifact died with "attempt to call a number
  // value". They are minted now, like every other name in the file.
  const p_i = alpha.mint(), p_oi = alpha.mint(), p_v = alpha.mint(), p_q = alpha.mint();
  const p_w = alpha.mint(), p_d = alpha.mint(), p_e = alpha.mint(), p_j = alpha.mint();
  const lua = [
    // getfenv is the one name the artifact spells: without an environment there
    // is nothing to ask for anything else.
    `local ${alpha.env}=getfenv(getfenv)`,
    `local ${alpha.str}=("")`,
    `local ${alpha.byte}=${alpha.str}[${S("byte")}]`,
    `local ${alpha.sub}=${alpha.str}[${S("sub")}]`,
    `local ${alpha.chr}=${alpha.str}[${S("char")}]`,
    `local ${alpha.cat}=${alpha.env}[${S("table")}][${S("concat")}]`,
    `local ${alpha.err}=${alpha.env}[${S("error")}]`,
    `local ${alpha.load}=${alpha.env}[${S("loadstring")}]`,
    `local ${A}=${luaStr(table.join(""))}`,
    `local ${G}={}`,
    `local ${p_i}=1 while ${p_i}<=${radix} do ${G}[${alpha.sub}(${A},${p_i},${p_i})]=${p_i}-1 ${p_i}=${p_i}+1 end`,
    `local ${T}=${luaStr(blob)}`,
    `local ${L}=${packed.length}`,
    `local ${alpha.out},${p_oi}={},0`,
    // 5 symbols -> one 32-bit word -> four bytes, each un-keystreamed by its index.
    `${p_i}=5 while ${p_oi}<${L} do`,
    `local ${p_v}=0 local ${p_q}=0 while ${p_q}<5 do ${p_v}=${p_v}*${radix}+${G}[${alpha.sub}(${T},${p_i}+${p_q},${p_i}+${p_q})] ${p_q}=${p_q}+1 end`,
    `local ${p_w}={} local ${p_d}=16777216 ${p_q}=0 while ${p_q}<4 do local ${p_e}=(${p_v}-${p_v}%${p_d})/${p_d} ${p_v}=${p_v}%${p_d} ${p_w}[${p_q}+1]=${p_e} ${p_d}=${p_d}/256 ${p_q}=${p_q}+1 end`,
    `${p_q}=0 while ${p_q}<4 do ${p_oi}=${p_oi}+1 if ${p_oi}>${L} then break end local ${p_j}=${p_oi}-1 ${alpha.out}[${p_oi}]=${alpha.chr}((${p_w}[${p_q}+1]-(${p_j}*${k1}+${k2})%256)%256) ${p_q}=${p_q}+1 end`,
    `${p_i}=${p_i}+5 end`,
    `local ${alpha.src}=${entry}(${alpha.cat}(${alpha.out}))`,
    // An explicit, empty chunk name: without one, every message the payload raises
    // is prefixed with a fragment of the payload's own source, which is both a
    // leak and a change in what a program sees inside pcall.
    `local ${alpha.fn}=${alpha.load}(${alpha.src},${luaStr("")})`,
    `if ${alpha.fn}==nil then ${alpha.err}(${alpha.cat}({})) end`,
    `return ${alpha.fn}(...)`,
  ];
  // The bindings come first so the inflate closes over them as locals, then the
  // inflate itself, then the unpack. The `return` stays the last statement.
  lua.splice(8, 0, renamed);
  return lua;
}

function attestLua(target, opts = {}) {
  const CH = opts.charLocal;
  const ENV = opts.envLocal;
  const TY = opts.typeLocal;
  const PC = opts.pcallLocal;
  const ERR = opts.errorLocal;
  const TYPEOF = opts.typeofLocal;
  const rng = typeof opts.rng === "function" ? opts.rng : () => 0.5;
  const world = target === "luau";

  const V = opts.bind; // (token) -> emitted name
  const ch = (word) => {
    if (opts.nameOf) return opts.nameOf(word);
    return Array.from(String(word))
      .map((c) => `${CH}(${c.charCodeAt(0)})`)
      .join("..");
  };
  const S = (word) => `(${ch(word)})`;
  const G = (word) => `${ENV}[${S(word)}]`;
  const rnd = (n) => Math.floor(rng() * n) % n;

  const WORD = V("__V0880__");
  const ATLAS = V("__V0882__");
  const RECHECK = V("__V0881__");
  const t = (name) => V("__V" + name + "__");

  // Locals the emitted block owns.
  const L = {
    req: t("8600"), // rawequal
    xpc: t("8601"), // xpcall
    sel: t("8602"), // select
    nxt: t("8603"), // next
    tos: t("8604"), // tostring
    ton: t("8605"), // tonumber
    setm: t("8606"), // setmetatable
    getm: t("8607"), // getmetatable
    rawg: t("8608"), // rawget
    str: t("8609"), // string library
    tab: t("8610"), // table library
    mth: t("8611"), // math library
    cor: t("8612"), // coroutine library
    dbg: t("8613"), // debug library
    unp: t("8614"), // unpack / table.unpack
    asrt: t("8615"), // assert
    mk: t("8616"), // identity marker
    mk2: t("8617"), // second marker
    seed: t("8618"), // chain start
    salts: t("8619"), // per-check salts
    checks: t("8620"), // check closures
    idx: t("8621"),
    okv: t("8622"),
    res: t("8623"),
    snap: t("8624"),
    score: t("8625"),
    sign: t("8626"),
    p: t("8627"),
    n: t("8628"),
    st: t("8629"),
    a: t("8630"),
    pair: t("8631"),
    report: t("8632"),
    tags: t("8633"),
    cat: t("8640"), // the service catalogue
    cls: t("8641"), // the class catalogue
    dt: t("8642"), // datatype catalogue
    en: t("8643"), // enum catalogue
    gs: t("8644"), // game.GetService
    game: t("8645"),
    ins: t("8646"), // Instance table
    vote: t("8647"),
    mv: t("8648"), // member votes
    found: t("8649"),
    row: t("8650"),
    svc: t("8651"),
    chk: t("8652"), // one vote if the probe answers false/errors
    seen: t("8653"),
    deep: t("8654"),
    osl: t("8655"), // os library
    rot: t("8656"), // per-run rotation into the catalogue
    lim: t("8659"),
    gfe: t("8660"), // getfenv
    clk0: t("8663"),
  };

  const MK = 0x10000 + rnd(0xeffff);
  const MK2 = 0x40 + rnd(0x3f);
  const seed = 0x1000 + rnd(0xfffff0);

  // ---- v1: the flat host-sanity pass, now as chain members ---------------
  // Each entry: [expression that must be true, facility it needs (or null)]
  const checks = [
    // core dispatch has not been rebuilt in Lua
    `(function() return ${TY}(1)==${S("number")} and ${TY}("")==${S("string")} and ${TY}(true)==${S("boolean")} and ${TY}({})==${S("table")} and ${TY}(nil)==${S("nil")} and ${TY}(function() end)==${S("function")} end)()`,
    // the value identity marker survives a protected call
    `(function() local ${L.okv},${L.res}=${PC}(function() return ${L.mk} end) return ${L.okv}==true and ${L.res}==${L.mk} end)()`,
    // error() hands the very same value back through pcall
    `(function() local ${L.okv},${L.res}=${PC}(function() return ${ERR}(${L.mk},0) end) return ${L.okv}==false and ${L.res}==${L.mk} end)()`,
    // pcall on a non-function is a failure, not a throw
    `(function() local ${L.okv}=${PC}(${L.mk}) return ${L.okv}==false end)()`,
    // xpcall still routes through its handler exactly once
    `(function() local ${L.n}=0 local ${L.okv},${L.res}=${L.xpc}(function() return ${ERR}(${L.mk},0) end,function(v) ${L.n}=${L.n}+1 return v end) return ${L.okv}==false and ${L.res}==${L.mk} and ${L.n}==1 end)()`,
    // select("#", ...) counts holes
    `(function() local ${L.n}=${L.sel}(${S("#")},${L.mk},nil,${L.mk}) return ${L.n}==3 end)()`,
    // next() walks a real table
    `(function() local ${L.p}={} ${L.p}[${L.mk}]=${L.mk} local ${L.a},${L.pair}=${L.nxt}(${L.p}) return ${L.a}==${L.mk} and ${L.pair}==${L.mk} end)()`,
    // string.byte/char still round trip
    `(function() return ${G("string")}[${S("byte")}](${CH}(65))==65 and ${CH}(66)==${S("B")} end)()`,
    // gsub returns both the string and the count
    `(function() local ${L.res},${L.n}=${G("string")}[${S("gsub")}](${ch("a b")},${ch(" ")},${ch("-")}) return ${L.res}==${ch("a-b")} and ${L.n}==1 end)()`,
    // string.format agrees with tostring on the same number
    `(function() return ${G("string")}[${S("format")}](${ch("%d")},${L.mk})==${G("tostring")}(${L.mk}) end)()`,
    // table.concat honours its separator
    `(function() return ${G("table")}[${S("concat")}]({${ch("a")},${ch("b")}},${ch("-")})==${ch("a-b")} end)()`,
    // unpack keeps holes at the right positions
    `(function() local ${L.p}={${L.mk},nil,${L.mk}+1} ${L.p}.n=3 local ${L.okv},${L.a},${L.res},${L.pair}=${PC}(function() return ${L.unp}(${L.p},1,3) end) return ${L.okv}==true and ${L.a}==${L.mk} and ${L.res}==nil and ${L.pair}==${L.mk}+1 end)()`,
    // coroutines still suspend and resume with values
    `(function() local ${L.st}=${G("coroutine")}[${S("create")}](function(v) local w=${G("coroutine")}[${S("yield")}](v+1) return w*2 end) local ${L.a},${L.res}=${G("coroutine")}[${S("resume")}](${L.st},${L.mk}) if ${L.a}~=true or ${L.res}~=${L.mk}+1 then return false end local ${L.okv},${L.n}=${G("coroutine")}[${S("resume")}](${L.st},${L.mk2}) return ${L.okv}==true and ${L.n}==${L.mk2}*2 end)()`,
    // metatables still answer through __index, rawget still ignores them
    `(function() local ${L.p}=${L.setm}({}, {[${S("__index")}]=function() return ${L.mk} end}) return ${L.p}.x==${L.mk} and ${L.getm}(${L.p})~=nil and ${L.rawg}(${L.p},${ch("x")})==nil end)()`,
    // rawequal is identity, not equality
    `(function() local ${L.p}={} return ${L.req}(${L.p},${L.p})==true and ${L.req}({},{})==false end)()`,
    // numbers survive a text round trip
    `(function() return ${G("tonumber")}(${G("tostring")}(${L.mk}))==${L.mk} end)()`,
    // arithmetic and # still behave
    `(function() return ${G("math")}[${S("floor")}](-1.5)==-2 and 2^10==1024 and (7%3)==1 and #(${ch("ab")})==2 and #{${L.mk},${L.mk}}==2 end)()`,
    // setmetatable returns the table it was handed
    `(function() local ${L.p}={} return ${L.setm}(${L.p},{})==${L.p} end)()`,
    // assert still fails through pcall
    `(function() local ${L.okv}=${PC}(function() return ${L.asrt}(false) end) return ${L.okv}==false end)()`,
    // typeof agrees with type on the primitives it shares
    `(function() if ${TYPEOF}==${TY} then return true end return ${TYPEOF}(1)==${S("number")} and ${TYPEOF}("")==${S("string")} and ${TYPEOF}({})==${S("table")} end)()`,
    // the protected call is still a builtin, not a script that imitates one
    world
      ? `(function() local ${L.p}=${L.dbg} if ${L.p}==nil then return true end if ${L.p}[${S("info")}]==nil then return false end return ${L.p}[${S("info")}](${PC},${ch("s")})==${ch("[C]")} end)()`
      : `(function() local ${L.p}=${L.dbg} if ${L.p}==nil or ${L.p}[${S("info")}]==nil then return true end return ${L.p}[${S("info")}](${PC},${ch("s")})==${ch("[C]")} end)()`,
    // and the environment accessor has not been wrapped either - a Lua closure
    // wearing getfenv's name is the classic way to hand out a doctored env
    world
      ? `(function() local ${L.p}=${L.dbg} if ${L.p}==nil then return true end if ${L.p}[${S("info")}]==nil then return false end local ${L.pair}=${G("getfenv")} if ${L.pair}==nil then return false end return ${L.p}[${S("info")}](${L.pair},${ch("s")})==${ch("[C]")} end)()`
      : `(function() local ${L.p}=${L.dbg} if ${L.p}==nil or ${L.p}[${S("info")}]==nil then return true end return ${L.p}[${S("info")}](${G("getfenv")},${ch("s")})==${ch("[C]")} end)()`,
    // ---- engine semantics -------------------------------------------------
    // Everything above tests the *language*. These test the *engine*, and they
    // are the checks a replayed environment cannot answer: an instance in Roblox
    // is userdata, so `type(part)` is "userdata" while `typeof(part)` is
    // "Instance"; `rawget` on one raises; `ClassName` is read only. A host that
    // hands the loader tables - which is what "log the environment, then run the
    // dump somewhere else" produces - fails all three without lying about any of
    // the language checks above.
    `(function() local ${L.p}=${ENV}[${S("game")}] if ${L.p}==nil then return true end return ${TY}(${L.p})==${S("userdata")} end)()`,
    `(function() local ${L.p}=${ENV}[${S("game")}] if ${L.p}==nil or ${L.rawg}==nil then return true end local ${L.okv}=${PC}(${L.rawg},${L.p},${S("ClassName")}) return ${L.okv}~=true end)()`,
    `(function() local ${L.p}=${ENV}[${S("game")}] if ${L.p}==nil then return true end local ${L.okv}=${PC}(function() ${L.p}[${S("ClassName")}]=${ch("x")} end) return ${L.okv}~=true end)()`,
    // an instance either exists or raises; a table that answers every name with
    // a value is a catalogue, not an engine
    `(function() local ${L.ins}=${ENV}[${S("Instance")}] if ${L.ins}==nil or ${L.ins}[${S("new")}]==nil then return true end local ${L.okv},${L.res}=${PC}(${L.ins}[${S("new")}],${ch("NotARobloxClass")}) return ${L.okv}~=true end)()`,
    `(function() local ${L.ins}=${ENV}[${S("Instance")}] if ${L.ins}==nil or ${L.ins}[${S("new")}]==nil then return true end local ${L.okv},${L.res}=${PC}(${L.ins}[${S("new")}],${ch("Part")}) if ${L.okv}~=true then return false end return ${TY}(${L.res})==${S("userdata")} and ${TYPEOF}(${L.res})==${S("Instance")} end)()`,
    // the environment the loader is running in *is* the global one: a dumper that
    // re-hosts the chunk under a private table fails this, and so does a shim that
    // answers getfenv with a copy
    `(function() local ${L.p}=${L.gfe} if ${L.p}==nil then return true end local ${L.a}=${L.p}(1) local ${L.pair}=${L.p}(${L.p}) if ${L.a}==nil or ${L.pair}==nil then return true end return ${L.req}(${L.a},${L.pair})==true end)()`,
    // the clock advances, and it advances in the direction a clock does
    `(function() local ${L.p}=${L.osl} if ${L.p}==nil or ${L.p}[${S("clock")}]==nil then return true end local ${L.clk0}=${L.p}[${S("clock")}]() local ${L.pair}=${L.p}[${S("clock")}]() return ${TY}(${L.clk0})==${S("number")} and ${L.pair}>=${L.clk0} end)()`,
  ];

  const salts = checks.map(() => 1 + rnd(0xfffffe));
  // Each check also returns a tag of its own. The fold tests the *tag*, not just
  // "did something truthy come back", so a check that has been swapped with its
  // neighbour - or replaced by a stub that answers `true` - fails on identity.
  const tags = checks.map(() => 1 + rnd(0xfffffe));
  const tagOf = new Map(checks.map((c, i) => [c, tags[i]]));
  let expected = seed % 16777216;
  for (let i = 0; i < checks.length; i++) {
    expected = (expected * 33 + salts[i] + (i + 1) * 5) % 16777216;
  }

  // Test hook (suite + tools/tamper.js): rewrite one salt or swap two checks
  // *after* the build-time fold, which is precisely what a patcher does when it
  // edits the check list. The expected word stays as it was, so the mutant must
  // refuse to decode.
  const mut = opts.mutation;
  if (mut) {
    const i = Math.max(0, Math.min(checks.length - 1, Number(mut.index) || 0));
    if (mut.kind === "salt") salts[i] = (salts[i] + 1) % 16777216;
    else if (mut.kind === "order" && i + 1 < checks.length) {
      const swap = checks[i];
      checks[i] = checks[i + 1];
      checks[i + 1] = swap;
    }
  }

  // ---- the reference snapshot -------------------------------------------
  const snapNames = [
    "pcall", "xpcall", "error", "type", "typeof", "select", "next", "pairs",
    "ipairs", "tostring", "tonumber", "assert", "rawequal", "rawget", "rawset",
    "setmetatable", "getmetatable", "string", "table", "math", "coroutine",
    "debug", "bit32", "utf8", "os", "task", "Instance", "game", "workspace",
  ];

  const out = [];
  out.push(`local ${L.req},${L.xpc},${L.sel},${L.nxt}=${G("rawequal")},${G("xpcall")},${G("select")},${G("next")}`);
  out.push(`local ${L.tos},${L.ton},${L.setm},${L.getm}=${G("tostring")},${G("tonumber")},${G("setmetatable")},${G("getmetatable")}`);
  out.push(`local ${L.rawg},${L.cor},${L.dbg},${L.asrt}=${G("rawget")},${G("coroutine")},${G("debug")},${G("assert")}`);
  out.push(`local ${L.str},${L.tab},${L.mth}=${G("string")},${G("table")},${G("math")}`);
  out.push(`local ${L.osl},${L.gfe}=${ENV}[${S("os")}],${ENV}[${S("getfenv")}]`);
  out.push(`local ${L.unp}=${G("unpack")} if ${L.unp}==nil and ${L.tab}~=nil then ${L.unp}=${L.tab}[${S("unpack")}] end`);
  if (!world) out.push(`if ${TY}==nil then ${TY}=function(v) return v==nil and ${S("nil")} or ${S("?")} end end`);
  // Missing facilities must not throw here: a closure that needs one returns
  // true, which keeps the chain value identical to the build-time fold.
  out.push(`local ${L.mk},${L.mk2}=${MK},${MK2}`);
  out.push(`local ${L.seed}=${seed}`);
  out.push(`local ${L.salts}={${salts.join(",")}}`);
  out.push(`local ${L.tags}={${tags.join(",")}}`);
  // The tag travels with the check, not with the slot (tagOf is built from the
  // list as written, before the test hook below can reorder it), so a check moved
  // to another position answers with its own tag and no longer matches the array.
  const bodies = checks.map((c) => `function() if ${c} then return ${tagOf.get(c)} end return ${tagOf.get(c)}+1 end`);
  out.push(`local ${L.checks}={\n${bodies.map((c) => `${c},`).join("\n")}\n}`);

  // v2: the chain
  out.push(
    [
      `local ${L.idx},${L.okv},${L.res}=1,nil,nil`,
      `while ${L.idx}<=#${L.checks} do`,
      `${L.okv},${L.res}=${PC}(${L.checks}[${L.idx}])`,
      `${L.res}=(${L.okv}==true and ${L.res}==${L.tags}[${L.idx}])`,
      `${L.seed}=(${L.seed}*33+(${L.okv}==true and ${L.res}==true and 1 or 0)*${L.salts}[${L.idx}]+${L.idx}*5)%16777216`,
      `${L.idx}=${L.idx}+1`,
      `end`,
    ].join(" ")
  );
  // The verdict word: zero for a host that answered every check, and folded
  // straight into the interpreter's code salt below.

  out.push(`local ${WORD}=(${L.seed}-${expected})%16777216`);
  out.push(`if ${WORD}~=0 then ${opts.trapCallLabeled ? opts.trapCallLabeled("chain") : opts.trapCall} end`);


  // v2: capture the host's own references now, compare them later
  const snapRows = snapNames.map((nm) => `{${S(nm)},${ENV}[${S(nm)}]}`).join(",");
  out.push(`local ${L.snap}={${snapRows}}`);
  out.push(
    [
      `local ${RECHECK}=function()`,
      `local ${L.idx}=1`,
      `local ${L.n}=#${L.snap}`,
      `while ${L.idx}<=${L.n} do`,
      `local ${L.pair}=${L.snap}[${L.idx}]`,
      `if ${L.req}~=nil and not ${L.req}(${ENV}[${L.pair}[1]],${L.pair}[2]) then return 0 end`,
      `${L.idx}=${L.idx}+1`,
      `end`,
      `if ${L.dbg}~=nil and ${L.dbg}[${S("info")}]~=nil then local ${L.p}=${L.dbg}[${S("info")}](${PC},${ch("s")}) if ${L.p}~=${ch("[C]")} then return 0 end end`,
      `if ${TY}(1)~=${S("number")} then return 0 end`,
      `return 1`,
      `end`,
    ].join(" ")
  );

  // ---- v3: the API atlas -------------------------------------------------
  // Which services exist, whether each one is consistent with itself, whether it
  // exposes the members it has always had, and whether Instance.new knows the
  // classes it has always known (including refusing one that does not exist).

  // Build time: the artifact carries a *sample* of the catalogue, not all of it.
  // Run time: a rotation drawn from the host clock picks a window of that sample.
  // The two together mean an environment log - a list of exactly which questions
  // the last run asked - answers only the runs that happen to ask them again, and
  // two builds do not even contain the same questions.
  const shuffledList = (list) => {
    const c = list.slice();
    for (let i = c.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const tmp = c[i];
      c[i] = c[j];
      c[j] = tmp;
    }
    return c;
  };
  const svcSample = shuffledList(SERVICE_ATLAS).slice(0, 18 + ((rng() * 12) | 0));
  const clsSample = shuffledList(CLASS_ATLAS).slice(0, 10 + ((rng() * 7) | 0));
  const perRun = 5 + ((rng() * 5) | 0);
  const childPerRun = 3 + ((rng() * 3) | 0);

  const catRows = svcSample
    .map(([name, members]) => `{${ch(name)},{${members.map((m) => ch(m)).join(",")}}}`)
    .join(",");
  const clsRow = clsSample.map((c) => ch(c)).join(",");
  out.push(`local ${L.cat}={${catRows}}`);
  out.push(`local ${L.cls}={${clsRow}}`);
  out.push(`local ${L.mk}=${ENV}[${ch("game")}]`);
  out.push(`local ${L.mk2}=${ENV}[${ch("Instance")}]`);
  if (!opts.dropAtlas) {
  // Luau allows 200 registers per function and the loader sits close to that on
  // some seeds, where the whole chunk failed to compile and loadstring handed
  // back nil - the artifact then trapped with no message at all. The atlas
  // therefore reuses the chain's locals instead of declaring its own.
  out.push(`local ${ATLAS}=0 local ${L.vote},${L.mv},${L.found}=0,0,0`);
  out.push(`local ${L.deep}=function(f) local ${L.okv},${L.res}=${PC}(f) if ${L.okv}==true and ${L.res}==true then return 0 end return 1 end`);
  // The run's rotation and the run's junk service name both come from the clock,
  // so neither is in the file and neither survives a replay.
  out.push(`local ${L.rot},${L.st}=0,${ch("EAT")}`);
  out.push(`if ${L.osl}~=nil and ${L.osl}[${ch("clock")}]~=nil and ${L.mth}~=nil and ${L.mth}[${ch("floor")}]~=nil then local ${L.clk0}=${L.mth}[${ch("floor")}](${L.osl}[${ch("clock")}]()*1000000) if #${L.cat}>0 then ${L.rot}=${L.clk0}%#${L.cat} end ${L.st}=${ch("EAT")}..(${L.tos}(${L.clk0})) end`);
  out.push(
    [
      `if ${L.mk}~=nil then`,
      `local ${L.gs}=${L.mk}[${ch("GetService")}]`,
      `local ${L.lim}=${perRun} if ${L.lim}>#${L.cat} then ${L.lim}=#${L.cat} end`,
      `local ${L.idx}=1`,
      `while ${L.idx}<=${L.lim} do`,
      `local ${L.a}=${L.rot}+${L.idx}`,
      `if ${L.a}>#${L.cat} then ${L.a}=${L.a}-#${L.cat} end`,
      `local ${L.pair}=${L.cat}[${L.a}]`,
      `local ${L.okv},${L.svc}=${PC}(${L.gs},${L.mk},${L.pair}[1])`,
      `if ${L.okv}==true and ${L.svc}~=nil then`,
      `${L.found}=${L.found}+1`,
      // what it is
      `${L.vote}=${L.vote}+${L.deep}(function() return ${TYPEOF}(${L.svc})==${ch("Instance")} end)`,
      `${L.vote}=${L.vote}+${L.deep}(function() return ${L.svc}[${ch("ClassName")}]==${L.pair}[1] end)`,
      // what it is made of: in Roblox an instance is userdata, rawget refuses it,
      // and an unknown member raises. A replayed environment built out of tables
      // fails all three however well it answers the questions above.
      `${L.vote}=${L.vote}+${L.deep}(function() return ${TY}(${L.svc})==${ch("userdata")} end)`,
      `${L.vote}=${L.vote}+${L.deep}(function() return ${L.rawg}~=nil and ${PC}(${L.rawg},${L.svc},${ch("ClassName")})~=true end)`,
      `${L.vote}=${L.vote}+${L.deep}(function() local ${L.okv}=${PC}(function() return ${L.svc}[${ch("__EAT_NO_SUCH_MEMBER__")}] end) return ${L.okv}~=true end)`,
      // where it is, and who agrees about where it is
      `${L.vote}=${L.vote}+${L.deep}(function() return ${L.req}~=nil and ${L.req}(${L.svc}[${ch("Parent")}],${L.mk}) end)`,
      `${L.vote}=${L.vote}+${L.deep}(function() return ${L.svc}[${ch("IsA")}](${L.svc},${L.pair}[1])==true end)`,
      `${L.vote}=${L.vote}+${L.deep}(function() return ${L.req}~=nil and ${L.req}(${L.mk}[${ch("FindFirstChild")}](${L.mk},${L.pair}[1]),${L.svc}) end)`,
      `${L.vote}=${L.vote}+${L.deep}(function() return ${L.req}~=nil and ${L.req}(${L.gs}(${L.mk},${L.pair}[1]),${L.svc}) end)`,
      `${L.vote}=${L.vote}+${L.deep}(function() local ${L.okv},${L.res}=${PC}(${L.gs},${L.mk},${L.pair}[1]) return ${L.okv}==true and ${L.req}~=nil and ${L.req}(${L.res},${L.svc}) end)`,
      // what it exposes
      `local ${L.n},${L.p}=${L.pair}[2],1`,
      `while ${L.p}<=#${L.n} do ${L.mv}=${L.mv}+${L.deep}(function() return ${L.svc}[${L.n}[${L.p}]]~=nil end) ${L.p}=${L.p}+1 end`,
      `end`,
      `${L.idx}=${L.idx}+1`,
      `end`,
      // A service name that cannot exist, built from this run's clock: a real
      // client raises for it, a table that answers everything hands back a table.
      `if ${L.found}<1 then ${L.vote}=${L.vote}+4 end`,
      `local ${L.okv},${L.svc}=${PC}(${L.gs},${L.mk},${L.st})`,
      `if ${L.okv}==true and ${L.svc}~=nil then ${L.vote}=${L.vote}+8 end`,
      // The DataModel's children are its services. A host that lists a rich child
      // list but cannot resolve what is in it is a table of handles with a list
      // bolted on; a host whose children are not instances at all is a dump of one.
      `local ${L.n}=${L.mk}[${ch("GetChildren")}](${L.mk})`,
      `if ${TYPEOF}(${L.n})~=${ch("table")} then ${L.vote}=${L.vote}+2 else`,
      `if #${L.n}<3 then ${L.vote}=${L.vote}+2 end`,
      `local ${L.p}=1 local ${L.lim}=${childPerRun} if ${L.lim}>#${L.n} then ${L.lim}=#${L.n} end`,
      `while ${L.p}<=${L.lim} do local ${L.a}=(${L.rot}+${L.p})%#${L.n}+1 local ${L.pair}=${L.n}[${L.a}]`,
      `${L.vote}=${L.vote}+${L.deep}(function() return ${TYPEOF}(${L.pair})==${ch("Instance")} and ${TY}(${L.pair})==${ch("userdata")} and ${L.req}~=nil and ${L.req}(${L.pair}[${ch("Parent")}],${L.mk}) end)`,
      `local ${L.okv},${L.svc}=${PC}(${L.gs},${L.mk},${L.pair}[${ch("Name")}])`,
      `if ${L.okv}==true and ${L.svc}~=nil and ${L.req}~=nil and not ${L.req}(${L.svc},${L.pair}) then ${L.vote}=${L.vote}+3 end`,
      `${L.p}=${L.p}+1 end`,
      `end`,
      `end`
    ].join(" ")
  );
  out.push(
    [
      `if ${L.mk2}~=nil and ${L.mk2}[${ch("new")}]~=nil then`,
      `local ${L.idx}=1`,
      `while ${L.idx}<=#${L.cls} do`,
      `local ${L.okv},${L.p}=${PC}(${L.mk2}[${ch("new")}],${L.cls}[${L.idx}])`,
      `if ${L.okv}==true and ${L.p}~=nil then`,
      `${L.vote}=${L.vote}+${L.deep}(function() return ${TYPEOF}(${L.p})==${ch("Instance")} and ${L.p}[${ch("ClassName")}]==${L.cls}[${L.idx}] end)`,
      `${L.vote}=${L.vote}+${L.deep}(function() return ${TY}(${L.p})==${ch("userdata")} end)`,
      `${L.vote}=${L.vote}+${L.deep}(function() return ${L.rawg}~=nil and ${PC}(${L.rawg},${L.p},${ch("Name")})~=true end)`,
      `else`,
      `${L.mv}=${L.mv}+1`,
      `end`,
      `${L.idx}=${L.idx}+1`,
      `end`,
      // ...and it must not be able to invent a class. A real Instance.new raises
      // on a class that does not exist; a table that answers every request is a
      // table that will also answer ours with nonsense.
      `local ${L.okv},${L.p}=${PC}(${L.mk2}[${ch("new")}],${ch("__EAT_NOT_A_CLASS__")})`,
      `if ${L.okv}==true and ${L.p}~=nil then ${L.vote}=${L.vote}+8 end`,
      `end`
    ].join(" ")
  );
  // The atlas contributes its own zero: a healthy host answers nothing here, and
  // a build that has had the whole atlas deleted is missing the local the
  // interpreter folds into its code salt.
  out.push(`if ${L.vote}>=4 or ${L.mv}>=4 then ${opts.trapCallLabeled ? opts.trapCallLabeled("atlas") : opts.trapCall} end`);
  // The atlas owns this local, and the interpreter folds it into its code salt:
  // a build with the atlas deleted is missing a name the payload depends on, so
  // it cannot decode. That is the property the suite checks with dropAtlas.
  out.push(`local ${ATLAS}=0`);
  }


  return out.join("\n");
}

const HOST_GATE_MARK = "__HOSTGATE__";

/**
 * The loader's host gate.
 *
 * The default target is Roblox, so the artifact insists on standing inside a
 * genuine Luau/Roblox host before it decodes anything: Luau-only libraries,
 * a DataModel that looks like a DataModel, services that resolve, an
 * Instance.new that produces a real Instance, and a typeof that agrees with
 * type() on primitives. Anything that only imitates Roblox fails one of these
 * and parks the thread; a bare Lua/Luau interpreter fails on the first line.
 *
 * The portable target is for plain Lua 5.1, where none of that exists, so it
 * gets a no-op instead.
 */
function hostGateLua(target, trapCall, opts = {}) {
  if (target !== "luau") return "do end";
  const probe = !!opts.probe;
  // The gate names nothing. Every global it touches is read out of the resolved
  // environment with a key assembled from character codes, and every string it
  // compares against is assembled the same way, so the artifact contains no
  // readable `game`, `Instance`, `GetService`, `typeof` or service name - which is
  // exactly the set that used to spell out what the loader was doing.
  const CH = opts.charLocal;
  const ENV = opts.envLocal;
  const TY = opts.typeofLocal;
  const T = opts.typeLocal;
  const PC = opts.pcallLocal;
  const name = (word) =>
    Array.from(String(word))
      .map((c) => `${CH}(${c.charCodeAt(0)})`)
      .join("..");
  // The gate names nothing in the artifact: every word it uses - `game`,
  // `Instance`, `GetService`, `Players`, the strings it compares against - comes
  // out of the encrypted name bank at load. `name()` is only the fallback for
  // builds that have no bank.
  const S = (word) => (opts.nameOf ? opts.nameOf(word) : `(${name(word)})`);
  const G = (word) => `${ENV}[${S(word)}]`;
  const C = (word) => S(word);
  // Two tiers, because the two kinds of check fail differently:
  //   primary   - an error OR a false answer means "this is not a Roblox client"
  //   secondary - only an explicit false is a verdict; an error is tolerated,
  //               because a Roblox build missing one widget is still Roblox
  const clauses = [
    ["typeof game is Instance", "primary", `${TY}(${G("game")})==${C("Instance")}`],
    ["game is a DataModel", "primary", `${G("game")}[${S("ClassName")}]==${C("DataModel")}`],
    ["game has no parent", "primary", `${G("game")}[${S("Parent")}]==nil`],
    ["workspace is an Instance", "primary", `${TY}(${G("workspace")})==${C("Instance")}`],
    ["game:IsA DataModel", "secondary", `${G("game")}[${S("IsA")}](${G("game")},${C("DataModel")})==true`],
    ["Players service", "secondary", `${TY}(${G("game")}[${S("GetService")}](${G("game")},${C("Players")}))==${C("Instance")}`],
    ["RunService service", "secondary", `${TY}(${G("game")}[${S("GetService")}](${G("game")},${C("RunService")}))==${C("Instance")}`],
    ["Workspace service", "secondary", `${TY}(${G("game")}[${S("GetService")}](${G("game")},${C("Workspace")}))==${C("Instance")}`],
    ["unknown service refused", "secondary", `${PC}(function() return ${G("game")}[${S("GetService")}](${G("game")},${C("__EAT_PROBE__")}) end)~=true`],
    ["Instance.new round trip", "secondary",
      `(function() local ${opts.partLocal}=${G("Instance")}[${S("new")}](${C("Part")}) ` +
      `if ${TY}(${opts.partLocal})~=${C("Instance")} or ${opts.partLocal}[${S("ClassName")}]~=${C("Part")} then return false end ` +
      `${opts.partLocal}[${S("Name")}]=${C("eat")} local ${opts.badLocal}=${opts.partLocal}[${S("Name")}]~=${C("eat")} ` +
      `${opts.partLocal}[${S("Destroy")}](${opts.partLocal}) return not ${opts.badLocal} end)()`],
    ["DataModel children", "secondary", `${TY}(#${G("game")}[${S("GetChildren")}](${G("game")}))==${C("number")}`],
    ["DataModel API", "secondary", `${T}(${G("game")}[${S("FindFirstChild")}])==${C("function")} and ${T}(${G("game")}[${S("GetService")}])==${C("function")}`],
    ["typeof primitives", "secondary",
      `${T}(1)==${C("number")} and ${T}("")==${C("string")} and ${T}(true)==${C("boolean")} and ${T}({})==${C("table")} and ${T}(function()end)==${C("function")}`],
    ["table.create/freeze", "secondary", `${TY}(${G("table")}[${S("create")}])==${C("function")} and ${TY}(${G("table")}[${S("freeze")}])==${C("function")}`],
    ["string.unpack", "secondary", `${TY}(${G("string")}[${S("unpack")}])==${C("function")}`],
    ["bit32/utf8", "secondary", `${TY}(${G("bit32")})==${C("table")} and ${TY}(${G("utf8")})==${C("table")}`],
    ["task library", "secondary", `${TY}(${G("task")})==${C("table")} and ${TY}(${G("task")}[${S("wait")}])==${C("function")} and ${TY}(${G("task")}[${S("spawn")}])==${C("function")}`],
    ["Enum.PartType", "secondary", `${TY}(${G("Enum")})==${C("table")} and ${TY}(${G("Enum")}[${S("PartType")}])==${C("table")} and ${G("Enum")}[${S("PartType")}][${S("Ball")}]~=nil`],
  ];
  const runPrimary = (code) => `(function() local __V8802__,__V8803__=${PC}(function() return ${code} end) if __V8802__~=true then return false end return __V8803__==true end)()`;
  const runSecondary = (code) => `(function() local __V8802__,__V8803__=${PC}(function() return ${code} end) if __V8802__~=true then return true end return __V8803__~=false end)()`;
  // The verdict is one accumulated value, not a pile of independent booleans.
  // With "does any clause say false" a bypass only has to satisfy the clauses it
  // cares about - each one stands alone, and a hook can answer one of them
  // without knowing anything about the others. Folding them in order, with a
  // per-build multiplier and per-build weights, means the expected constant only
  // comes out if every clause answers as a real client would, in the right order,
  // and a single substituted answer cannot be compensated anywhere else in the
  // vector. `i` is folded in as well, so reordering the array is also a failure.
  const fold = (() => {
    const r = (n) => Math.floor(rng() * n);
    const mult = 257 + 2 * r(400);
    const step = 131 + 2 * r(90);
    const yes = 977 + r(20000);
    let no = 31 + r(900);
    while (no === yes) no++;
    const mod = 16777216;
    const init = r(mod);
    let acc = init;
    for (let i = 1; i <= clauses.length; i++) acc = (acc * mult + i * step + yes) % mod;
    return { mult, step, yes, no, mod, init, expect: acc };
  })();
  const values = clauses.map(([label, tier, code], i) => {
    const expr = tier === "primary" ? runPrimary(code) : runSecondary(code);
    return `${opts.sinkLocal}[${i + 1}]=${expr}`;
  });
  if (probe) {
    // Diagnostic build: report every clause and then run the payload anyway.
    const literals = clauses.map(([label]) => JSON.stringify(label)).join(",");
    return [
      `local ${opts.sinkLocal},__V8834__={}, {${literals}}`,
      values.join("\n"),
      'local __V8835__="EAT_HOST_PROBE"',
      "for __V8837__=1,#__V8834__ do __V8835__=__V8835__..\" \"..__V8834__[__V8837__]..\"=\"..tostring(" + opts.sinkLocal + "[__V8837__]) end",
      `pcall(${G("print")},__V8835__)`,
    ].join("\n");
  }
  return [
    `local ${opts.sinkLocal}={}`,
    values.join("\n"),
    `local __V8838__=${fold.init}`,
    `for __V8837__=1,#${opts.sinkLocal} do __V8838__=(__V8838__*${fold.mult}+__V8837__*${fold.step}+(${opts.sinkLocal}[__V8837__] and ${fold.yes} or ${fold.no}))%${fold.mod} end`,
    `if __V8838__~=${fold.expect} then ${trapCall} end`,
  ].join("\n");
}

  if (template.includes(TRAP_MARK)) {
    // Every integrity guard in the template funnels into this one routine, and it
    // used to be `function() end`: all the checks were decorative. It now raises
    // a named error by default, which ends the artifact and leaves the host
    // running - a parked thread is stronger against a pcall-wrapping analyser but
    // hangs a real Roblox client, and one honest false positive costs more than
    // that hardening is worth. EATFUSCATOR_TRAP=park restores the park.
    const mode = String(options.trap || process.env.EATFUSCATOR_TRAP || "error").toLowerCase();
    // The raise goes through the preamble's resolved error handle, so the
    // artifact does not name `error` either. `__V8845__` is declared at the very
    // top of the chunk, above every guard, so it is always in scope here.
    // A parked artifact used to be `repeat until false`, which reads like an
    // anti-tamper stub from across the room. It is now a loop over the constant
    // bank that recomputes a state which never equals its target: same effect
    // (the thread never returns), no recognisable shape, and it looks like the
    // decode loop it sits next to.
    const park = mode === "park"
      ? ' local m,t=al_bank[6],0 if m<1 then m=1 end while t<m do local t=(t+al_bank[7])%m local u=t end ' 
      : options.diag || process.env.EAT_DIAG
        ? ' __V8845__("eatfuscator: integrity check failed",0) '
        : ' __V8845__("",0) ';
    // Fail closed: the constant bank holds the key material every decode step
    // needs, and a logger that pcalls the artifact gets to keep whatever the
    // chunk left behind. So it is destroyed before the raise, not after.
    const wipe = ' __V068__=nil ';
    template = template.replace(TRAP_MARK, () => `local __V0709__=function(w)${wipe}${park.replace('__V8845__("eatfuscator: integrity check failed",0)', '__V8845__("eatfuscator: integrity check failed at "..tostring(w),0)')}end`);
  }

  // Padding used to be on by default (512 KB of filler bank entries). It is off
  // now: the filler is random by construction, so it is the one thing no
  // compressor can shrink, and it was 90% of a default artifact for a bank the VM
  // never reads. `--setting bloat:N` brings it back for builds that want the bulk.
  const bloatOption = options.bloat === undefined ? 0 : Number(options.bloat) || 0;
  const pad = padBanks(payload, rng, bloatOption, Math.round(Buffer.byteLength(template, 'utf8') * 1.25), alphabet);

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
  const V = (t) => { if (!tokenNames.has(t)) tokenNames.set(t, payload.name()); return tokenNames.get(t); };

  // The loader's vocabulary: every API name, service name, member name and
  // comparison string is interned here and emitted once, encrypted, at __NAMES__.
  const nameBank = { list: [], map: new Map() };
  const NB = V("__V8700__");
  const NM = (word) => {
    const w = String(word);
    let i = nameBank.map.get(w);
    if (i === undefined) {
      nameBank.list.push(w);
      i = nameBank.list.length;
      nameBank.map.set(w, i);
    }
    return `${NB}[${i}]`;
  };

  if (template.includes(HOST_GATE_MARK)) {
    const gateText = hostGateLua(target, `${V("__V0709__")}(${JSON.stringify("gate")})`, {
      probe: Boolean(options.hostProbe || process.env.EAT_HOST_PROBE),
      charLocal: V("__V0947__"),
      envLocal: V("__V000__"),
      typeofLocal: V("__V8846__"),
      typeLocal: V("__V8843__"),
      pcallLocal: V("__V8844__"),
      sinkLocal: V("__V8833__"),
      partLocal: V("__V8831__"),
      badLocal: V("__V8832__"),
      nameOf: NM,
    });
    // The gate introduces its own locals; register them so the substitution pass
    // below (which reads tokenNames directly) can resolve them.
    for (const t of gateText.match(/__V\d+__/g) || []) V(t);
    template = template.replace(HOST_GATE_MARK, () => gateText);
  }

  const stateVals = [];
  for (let i = 0; i < 6; i++) {
    let v = 0x1000 + ((rng() * 0x7fffef) | 0);
    while (stateVals.includes(v)) v = 0x1000 + ((rng() * 0x7fffef) | 0);
    stateVals.push(v);
  }
  const H = (n) => "0x" + n.toString(16).toUpperCase();
  const K = (n) => n.toString(16).toUpperCase().padStart(2, "0");

  const POOL_ORDER = [
    "string", "table", "math", "type", "select", "pcall", "next",
    "getmetatable", "setmetatable", "debug", "loadstring",
    "unpack", "tonumber", "gethook", "__index", "function",
    "concat", "floor", "gsub", "byte",
    "_VERSION", "freeze", "clamp", "typeof", "require",
    "game", "task", "warn", "create",
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
  while (poolBytes.length % 12 !== 0) poolBytes.push(0);
  // TEMP: no affine on pool until Lua peel is verified; identity path
  const poolLayers = [];
  const poolBlob = packBlob(poolBytes, alphabet);
  const poolLayerLua = "{}";

  const P0 = (str) => poolIndex.get(str);
  const poolLua = [
    `local ${V("__V020__")},${V("__V0300__")},${V("__V0301__")}={},${longString(poolBlob)},${poolLayerLua}`,
    `local ${V("__V0302__")},${V("__V0303__")}=${V("__V0400__")}(${V("__V0300__")},${V("__V0090__")}),#${V("__V0301__")}`,
    `while ${V("__V0303__")}>=__V004__[1] do ${V("__V0302__")}=${V("__V0420__")}(${V("__V0302__")},${V("__V0301__")}[${V("__V0303__")}]) ${V("__V0303__")}=${V("__V0303__")}-__V004__[1] end`,
    `local ${V("__V0317__")},${V("__V0305__")},${V("__V0306__")}=__V004__[2],${V("__V0302__")}[1],__V004__[1]-__V004__[1]`,
    `while ${V("__V0306__")}<${V("__V0305__")} do`,
    `local ${V("__V0307__")},${V("__V0308__")}=${V("__V0302__")}[${V("__V0317__")}],\"\"`,
    `${V("__V0317__")}=${V("__V0317__")}+__V004__[1]`,
    `for ${V("__V0309__")}=__V004__[1],${V("__V0307__")} do ${V("__V0308__")}=${V("__V0308__")}..__V002__(${V("__V0302__")}[${V("__V0317__")}]) ${V("__V0317__")}=${V("__V0317__")}+__V004__[1] end`,
    `${V("__V0306__")}=${V("__V0306__")}+__V004__[1] ${V("__V020__")}[${V("__V0306__")}]=${V("__V0308__")} end`,
  ].join(" ");

  const G = V("__V000__");
  const poolArr = V("__V020__");
  // Pool array holds decoded name strings; index into env via the string.
  // S: string constant from the decoded pool (e.g. "table", "__index")
  const S = (name) => {
    const idx = P0(name);
    if (idx == null) return luaStr(name);
    return `${poolArr}[${idx}]`;
  };
  const env = (name) => {
    const idx = P0(name);
    if (idx == null) return name;
    return `${G}[${poolArr}[${idx}]]`;
  };
  const aliasRows = [
    ["__V0103__", env("type")],
    ["__V0106__", env("select")],
    ["__V0107__", env("pcall")],
    ["__V0109__", env("next")],
    ["__V0110__", env("getmetatable")],
    ["__V0111__", env("setmetatable")],
    ["__V0899__", env("loadstring")],
    ["__V0119__", `${G}[${S("table")}][${S("concat")}]`],
    ["__V0120__", `${G}[${S("math")}][${S("floor")}]`],
    ["__V0121__", env("unpack")],
    ["__V0122__", env("tonumber")],
    ["__V0123__", S("table")],
    ["__V0124__", S("function")],
    ["__V0140__", S("type")],
    ["__V0130__", S("__index")],
    ["__V0132__", S("string")],
    ["__V0462__", S("byte")],
    ["__V0463__", S("table")],
  ];
  const aliasLua = aliasRows.map(([tok, expr]) => `local ${V(tok)}=${expr}`);
  const poolBlock = poolLua + " " + aliasLua.join(" ");

  const mixOf = (arr) => arr.reduce((h, v, i) => (i === 10 ? h : (h + v * (i + 2)) % 16777216), 0);
  const ckey = makeKeyFactory(rng);
  const consts = buildConstants(rng, () => ckey(), null);
  const poolLenSum = shuffled.reduce((a, s) => a + s.length, 0);
  const vals = consts.vals;
  vals[6] = poolLenSum;
  vals[8] = payload.zlen;
  vals[9] = payload.zchk;
  vals[10] = 0;
  vals[11] = payload.k0;
  vals[12] = payload.k1;
  vals[13] = payload.orderKeys.length;
  vals[14] = payload.len;
  vals[15] = payload.chk;
  vals[16] = payload.wsum;
  for (let i = 0; i < 6; i++) vals[17 + i] = stateVals[i];
  vals[24] = codeSalt >>> 0;
  vals[25] = ring.k2 >>> 0;
  vals[26] = (ring.k0 * 65537 + ring.k1 * 257 + ring.k2 * 17) % 16777216;
  vals[23] = 0;

  vals[27] = strSalt >>> 0;
  vals[28] = payload.digest[0];
  vals[29] = payload.digest[8];
  vals[30] = layout.fieldCode;
  vals[31] = layout.tagCode;

  const slotCount = 39 + 3 * (ring.b.word() % 2);
  for (let i = 32; i < slotCount; i++) vals[i] = (ring.b.word() % 16777216) >>> 0;
  const poolDigest = digestWords(poolBytes, payload.k1, ring.k2);
  vals[32] = poolDigest[0];
  vals[33] = poolDigest[8];
  vals[34] = alphabetSeed;
  vals[35] = 0xFE;
  const tailSize = 24 + 12 * (alphabetSeed % 2);
  const tailNonce = [];
  for (let i = 0; i < tailSize; i++) tailNonce.push(ring.b.word() % 256);
  const tailLayers = [affineParams(ring.b), affineParams(ring.b)];
  let tailImg = tailNonce;
  for (const p of tailLayers) tailImg = affineEncodeBytes(tailImg, p);
  const tailBlob = packBlob(tailImg, null);
  const tailMul = 257 + (payload.k1 % 251);
  let tailD1 = 0;
  let tailD2 = 0;
  for (let i = 0; i < tailSize; i++) {
    tailD1 = (tailD1 * tailMul + tailNonce[i]) % 16777216;
    tailD2 = (tailD2 + tailNonce[i] * (i + 1)) % 16777216;
  }
  vals[36] = tailSize;
  vals[37] = tailD1;
  vals[38] = tailD2;
  vals[7] = slotCount;
  vals[10] = mixOf(vals);

  const constBytes = [];
  for (const v of vals) constBytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);

  while (constBytes.length % 12 !== 0) constBytes.push(0);
  const constLayers = [];
  const layerCount = 0; // TEMP no affine until peel verified
  for (let i = 0; i < layerCount; i++) constLayers.push(affineParams(ring.b));
  let constImg = constBytes;
  for (const p of constLayers) constImg = affineEncodeBytes(constImg, p);
  const constBlob = packBlob(constImg, null);
  const constLayerLua = layersTuple(constLayers);

  const constsLua = [
    `local ${V("__V068__")},${V("__V0310__")},${V("__V0311__")}={},${longString(constBlob)},${constLayerLua}`,
    `local ${V("__V0312__")},${V("__V0313__")}=${V("__V0400__")}(${V("__V0310__")},${V("__V0088__")}),#${V("__V0311__")}`,
    `while ${V("__V0313__")}>=__V004__[1] do ${V("__V0312__")}=${V("__V0420__")}(${V("__V0312__")},${V("__V0311__")}[${V("__V0313__")}]) ${V("__V0313__")}=${V("__V0313__")}-__V004__[1] end`,
    `local ${V("__V0314__")},${V("__V0315__")},${V("__V0316__")}=__V004__[1]-__V004__[1],#${V("__V0312__")}-#${V("__V0312__")}%__V004__[3],__V004__[1]`,
    `while ${V("__V0316__")}<=${V("__V0315__")} do ${V("__V0314__")}=${V("__V0314__")}+__V004__[1] ${V("__V068__")}[${V("__V0314__")}]=(((${V("__V0312__")}[${V("__V0316__")}]*__V004__[9]+${V("__V0312__")}[${V("__V0316__")}+__V004__[1]])*__V004__[9]+${V("__V0312__")}[${V("__V0316__")}+__V004__[2]])*__V004__[9]+${V("__V0312__")}[${V("__V0316__")}+__V004__[1]+__V004__[2]]) ${V("__V0316__")}=${V("__V0316__")}+__V004__[3] end`,

    `local ${V("__V0160__")},${V("__V0161__")},${V("__V0162__")},${V("__V0163__")}=${V("__V068__")}[0x19],${V("__V068__")}[0x1A],${V("__V068__")}[0x0D],${V("__V068__")}[0x1C]`,
    `local ${V("__V0090__")}=${V("__V0081__")}(${V("__V068__")}[0x23])`,
  ].join(" ");

  const frag = (name) => {
    let out = '"';
    for (const ch of name) out += String.fromCharCode(92) + ch.charCodeAt(0);
    return out + '"';
  };
  const pn = (t) => { if (!tokenNames.has(t)) tokenNames.set(t, payload.name()); return tokenNames.get(t); };
  // One pool for the whole loader, decoded on demand and cached. `ch` and `name`
  // both point at it, so no name in the artifact is ever assembled by string
  // concatenation of character codes - the pattern a deobfuscator folds first.
  const spool = createStringPool({
    rng,
    call: pn("__V9000__"),
    locals: {
      pack: pn("__V9001__"),
      off: pn("__V9002__"),
      cache: pn("__V9003__"),
      fn: pn("__V9000__"), // the same handle the calls use
      alpha: pn("__V9005__"),
    },
  });
  const preambleLua = (() => {
    const mByte = spool.ref("byte"), mChar = spool.ref("char"), mSub = spool.ref("sub");
    const mStr = spool.ref("string"), mTab = spool.ref("table"), mUnp = spool.ref("unpack");
    const tailArg = pn("__V0950__");
    const ENV = V("__V0143__"), GETFENV = V("__V0144__"), GLOB = V("__V0146__");
    const TRYENV_NAME = V("__V0145__");
    const VALID = V("__V8840__"), CAND = pn("__V8841__"), OKV = pn("__V8842__");
    const TY = V("__V8843__"), PC = V("__V8844__"), ERR = V("__V8845__"), TYPEOF = V("__V8846__");
    const S_ = pn("__V0943__"), CH_ = pn("__V0941__"), BY_ = pn("__V0940__");
    // Every global the loader needs is reached through getfenv, and every name it
    // asks for is assembled from character codes at run time. The artifact
    // therefore spells exactly one global identifier - `getfenv` - and nothing
    // else: no `_G`, no `_ENV`, no `type`, no `pcall`, no library names, and no
    // message text a reader could search for.
    const name = (word) => spool.ref(word);
    const diag = Boolean(options.diag || process.env.EAT_DIAG);
    const noEnv = diag
      ? '"eatfuscator: no usable script environment"'
      : '""';
    return [
      // Declared here, assigned at __SPOOL__: the control-flow flattener hoists
      // declarations it can see, and a decoder declared inside one of its states
      // would be out of scope for everything that follows.
      `local ${pn("__V9000__")}`,
      `__SPOOL__`,
      `local ${ENV}=nil`,
      `local ${BY_},${CH_},${pn("__V0942__")}=${mByte},${mChar},${mSub}`,
      `local ${S_},${pn("__V0944__")},${pn("__V0945__")}=${mStr},${mTab},${mUnp}`,
      `local ${pn("__V0946__")},${pn("__V0947__")},${pn("__V0948__")}=("")[${BY_}],("")[${CH_}],("")[${pn("__V0942__")}]`,
      `local ${GETFENV}=getfenv`,
      // getfenv's own environment is the global table on every host that has
      // getfenv at all, which is how type/pcall/error/typeof are reached without
      // ever naming them in the artifact.
      `local ${GLOB}=${GETFENV} and ${GETFENV}(${GETFENV})`,
      `local ${TY},${PC},${ERR}=${GLOB} and ${GLOB}[${name("type")}],${GLOB} and ${GLOB}[${name("pcall")}],${GLOB} and ${GLOB}[${name("error")}]`,
      `local ${TYPEOF}=(${GLOB} and ${GLOB}[${name("typeof")}]) or ${TY}`,
      `if ${TY}==nil then ${TY}=function(v) return v==nil and "nil" or "?" end end`,
      `if ${PC}==nil then ${PC}=function(f,...) return true, f(...) end end`,
      `if ${ERR}==nil then ${ERR}=function() local z=nil return z() end end`,
      // A candidate has to behave like an environment, not merely be truthy: a
      // proxy that answers every name with a value satisfies `env.string` while
      // exposing no library at all, and a loader that accepts it runs the payload
      // into a table where every global read is a no-op.
      `local ${VALID}=function(${CAND}) if ${TY}(${CAND})~=${name("table")} then return false end local ${OKV}=${CAND}[${S_}] if ${TY}(${OKV})~=${name("table")} then return false end return ${OKV}[${CH_}]~=nil or ${OKV}[${BY_}]~=nil end`,
      // getfenv carries a Luau script (Roblox's _G is the shared table, not the
      // environment) and it is also first on Lua 5.1; the global table reached
      // through getfenv's own environment is the fallback. _ENV is never read: on
      // Luau it is an ordinary global name, so any host can define it and capture
      // the loader into a table of its choosing.
      `local ${TRYENV_NAME}=function(${CAND}) local ok,g=${PC}(${GETFENV},${CAND}) if ok and ${VALID}(g) then return g end end`,
      `if ${ENV}==nil and ${GETFENV} then ${ENV}=${TRYENV_NAME}(1) or ${TRYENV_NAME}(0) end`,
      `if ${ENV}==nil and ${VALID}(${GLOB}) then ${ENV}=${GLOB} end`,
      // Never return quietly here - a silent return is indistinguishable from a
      // broken build. The failure is opaque unless the build was made with
      // --setting diag:true, because the artifact must not carry readable
      // diagnostics that tell a reader what the loader is doing or why it stopped.
      `if ${ENV}==nil then ${ERR}(${noEnv},0) return end`,
      `local ${V("__V000__")},${V("__V001__")},${V("__V002__")},${V("__V003__")},${V("__V004__")},${V("__V005__")},${V("__V006__")}=(${ENV}),${pn("__V0946__")},${pn("__V0947__")},${pn("__V0948__")},{},1,0`,
      `local ${V("__V0198__")}=(((${V("__V000__")}[${pn("__V0944__")}] or {})[${pn("__V0945__")}]) or ${V("__V000__")}[${pn("__V0945__")}])`,
      `local ${tailArg}=...`,
      `local ${V("__V0930__")},${V("__V0931__")}="",""`,
    ].join(" ");
  })();

  const runnerLua = (() => {
    const id = payload.name();
    const arg = payload.name();
    const second = payload.name();
    const local = payload.name();
    const shapes = [
      (n, a) => `function(${a},...) return ${n}(${a}) end`,
      (n, a) => `function(${a},...) return end`,
      (n, a) => `function(${a},${second}) return ${n}(${a}) end`,
      (n, a) => `function(${a}) local ${local}=${n}(${a}) return ${local} end`,
      (n, a) => `function(${a},...) if ${a}==nil then return end return ${n}(${a}) end`,
      (n, a) => `function(${a}) return ${n}(${a}) end`,
    ];
    const slots = 4 + (ring.b.word() % 4);
    const parts = [`[0x0]=function(${V("__V0446__")||arg},...) return ${V("__V0899__")}(${V("__V0446__")||arg})(...) end`];
    for (let i = 1; i <= slots; i++) {
      const body = shapes[(ring.b.word() + i) % shapes.length](id, arg);
      parts.push(`[0x${i.toString(16).toUpperCase()}]=${body}`);
    }
    const fallen = ring.b.word() % slots + 1;
    return `local ${id}=function(${arg}) return ${arg} end local ${V("__V0710__")}={${parts.join(",")}} local ${V("__V0698__")}=0x${fallen.toString(16).toUpperCase()}`;
  })();

  const opKeyLua = "{" + vm.opKey.slice(0, 4).map((k) => H(k)).join(",") + "}";
  const bankLua = entriesToLua(payload.entries);
  const orderLua = "{" + payload.orderKeys.map((k) => "0x" + k).join(",") + "}";
  const dataBlock = [
    `local ${V("__V0801__")},${V("__V0802__")}=${bankLua},${orderLua};`,
    `local ${V("__V0803__")},${V("__V0804__")}=${longString(vm.blob)},${opKeyLua};`,
    `local ${V("__V0805__")},${V("__V0806__")}=${V("__V068__")}[0x12],${V("__V068__")}[0x13];`,
    `local ${V("__V0807__")},${V("__V0808__")}=${V("__V068__")}[0x14],${V("__V068__")}[0x15];`,
    `local ${V("__V0809__")},${V("__V0810__")}=${V("__V068__")}[0x16],${V("__V068__")}[0x17];`,
  ];
  // The slots past the ones the interpreter reads are filler, so an edit there
  // used to be inert: the artifact ran with an identical output and the tamper
  // sweep scored it a miss. One relation over all of them makes every filler
  // edit visible, and it costs a single line.
  const fillerIdx = [];
  for (let i = 33; i < slotCount; i++) fillerIdx.push(i);
  if (fillerIdx.length) {
    const fillerSum = fillerIdx.reduce((acc, i) => acc + vals[i], 0) % 16777216;
    const terms = fillerIdx.map((i) => `${V("__V068__")}[0x${(i + 1).toString(16).toUpperCase()}]`).join("+");
    dataBlock.push(`if (${terms})%${V("__V004__")}[25]~=${fillerSum} then ${V("__V0709__")}() end;`);
  }
  const dataLua = dataBlock.join("");

  const bind = (t) => V("__V" + t + "__");
  // `__V0420a__`-style tokens (a digit id plus a discriminator letter) were not
  // matched by the digit-only pattern, so eighteen parameter names went out as
  // `__V0420a__` in the clear - a readable record of how the emitter names
  // things, sitting inside the one function that unpacks the image.
  const fixRefs = (txt) => txt.replace(/__V(\d+[a-z]?)__/g, (m, d) => bind(d));
  let code = template.replace(/__V\d+[a-z]?__/g, (t) => {
    const bound = tokenNames.get(t);
    if (bound !== undefined) return bound;
    // A token the emitter never asked for by name still has to leave as an
    // obfuscated identifier; V() registers it on the spot.
    return V(t);
  });
  // Function replacements, not strings: a `$` in the replacement is a pattern
  // (`$$` means one `$`, `$&` the match), and these blocks carry ciphertext that
  // can contain any byte. This is what silently ate a byte of the name bank on
  // roughly one seed in ten.
  code = code.replace("__POOL__", () => fixRefs(poolBlock));
  code = code.replace("__CONSTS__", () => fixRefs(constsLua));
  code = code.replace("__RUNNERS__", () => fixRefs(runnerLua));
  code = code.replace("__PREAMBLE__=0", () => fixRefs(preambleLua));
  if (options.dropAttest) code = code.replace(ATTEST_MARK, "");
  if (code.includes(ATTEST_MARK)) {
    const attestText = attestLua(target, {
      charLocal: V("__V0947__"),
      envLocal: V("__V000__"),
      typeLocal: V("__V8843__"),
      pcallLocal: V("__V8844__"),
      errorLocal: V("__V8845__"),
      typeofLocal: V("__V8846__"),
      bind: (t) => V(t),
      trapCall: `${V("__V0709__")}()`,
      trapCallLabeled: (w) => `${V("__V0709__")}(${JSON.stringify(w)})`,
      rng: createRNG((seed ^ 0x5a17) >>> 0),
      mutation: options.attestMutation || null,
      nameOf: NM,
      dropAtlas: !!options.dropAtlas,
    });
    code = code.replace(ATTEST_MARK, () => fixRefs(attestText));
  }
  if (code.includes(NAMES_MARK)) {
    const bankLua = nameBankLua(nameBank, {
      bankLocal: V("__V8700__"),
      // __V0946__/__V0947__/__V0948__ are the bound methods ("")["byte"] etc.;
      // __V0940__/__V0941__/__V0942__ are only the name strings "byte"/"char"/"sub".
      byteLocal: pn("__V0946__"),
      charLocal: pn("__V0947__"),
      subLocal: pn("__V0948__"),
      concatLocal: V("__V0119__"),
      saltA: `${V("__V068__")}[0x19]`,
      saltB: `${V("__V068__")}[0x1A]`,
      key: (codeSalt + ring.k2) % 253,
      tmp: V("__V8710__"),
      diag: Boolean(options.diag),
      envLocal: V("__V000__"),
    });
    code = code.replace(NAMES_MARK, () => fixRefs(bankLua));
  }
  {
    code = code.replace(/\(\s*"__TAILSTR__"\s*\)/, () => luaStr(tailBlob));
    code = code.split("__TAILLAYER__").join(layersTuple(tailLayers));
  }
  code = code.replace(DATA_MARK, () => fixRefs(dataLua));
  code = code.replace("__SPOOL__", () => fixRefs(spool.render()));
  for (let i = 0; i < 6; i++) code = code.split(`__K${i + 1}__`).join(K(vm.opcodes[i]));
  for (let i = 0; i < 6; i++) code = code.split(`__N${i + 1}__`).join(H(stateVals[i]));

  if (code.includes("__ALPHA__")) {
    const codes = Array.from(STORAGE_SET).map((ch) => ch.charCodeAt(0)).join(",");
    code = code.split("__ALPHA__").join(`("").char(${codes})`);
  }

  let flattenStats = null;
  if (options.flatten !== false) {

    const trap = `${V("__V0709__")}()`;
    try {
      const flat = flattenLoader(code, {
        rng,
        name: () => payload.name(),
        trap,
        blocks: Number(options.blocks) || 26,
        maxHoist: Number(options.hoistBudget) || undefined,
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

  let shapeStats = null;
  {
    const shaped = shapeArtifact(code);
    code = shaped.code;
    shapeStats = shaped.stats;
  }

  code = hexifyNumbers(code);

  code = maskNumbers(code, rng, 0.55, { binary: false });
  if (process.env.EAT_DUMP) { try { require("fs").writeFileSync(process.env.EAT_DUMP, code); } catch (e) {} }
  code = minifyLua(code, "Max");

  let sugarStats = null;
  // luauCompress temporarily disabled (produces += that breaks 5.1 flatten/minify)
  // if (target === "luau") {
  //   const compressed = luauCompress(code);
  //   code = compressed.code;
  //   sugarStats = compressed.stats;
  // }

  // Bulk. A hundred-kilobyte file that unpacks into more than a megabyte is a
  // different amount of work to read than a thirty-kilobyte one, and it costs
  // load-time overhead: the bulk is a closure the loader builds and never calls.
  // The size is measured, not guessed - `forLoader` deflates the real payload and
  // walks the mix until both targets are met (see Envelope/bulk.js).
  if (options.bulk !== false) {
    try {
      const bulkMod = require("./bulk");
      const bulkRng = (() => {
        const r = createRNG((seed ^ 0x5f356495) >>> 0);
        return () => r.word() / 4294967296;
      })();
      const plan = bulkMod.forLoader({
        make: (chars, denseFraction) => bulkMod.build(bulkRng, { chars, denseFraction }),
        deflate: (buf) => deflate.compress(buf),
        loaderText: code,
        // The envelope packs the deflated payload five symbols per four bytes, so
        // the file is 1.25x what deflate reported: target the deflate, not the file.
        targetCompressed: Math.round((96 * 1024) / 1.25),
        minUncompressed: 1050 * 1024,
      });
      // Prepended, not appended: the loader's last statement is the tail-string
      // call with no parentheses, and threading anything in front of it means
      // finding a statement boundary in generated text. A declaration at the top
      // is a declaration wherever it is.
      const blk = payload.name();
      code = `local ${blk}=function() ${plan.bulk} end ` + code;
      bulkStats = { inner: code.length, packed: plan.packed };
      if (options.verbose) console.error(`[wrap] bulk: ${code.length} bytes of loader, ${plan.packed} packed`);
    } catch (e) {
      throw new Error(`bulk generation failed: ${e.message}`);
    }
  }

  code = collapseToSingleLine(code);
  // The loader as it will be compiled at load time. obfuscate() compiles it once
  // with the vendored luau-compile and, if Luau refuses it (the 200-local limit),
  // rebuilds with a smaller hoist budget instead of shipping an artifact that
  // traps at load with no message.
  lastLoaderText = code;

  // The artifact the loader becomes: unless asked otherwise, the whole program is
  // deflated, encrypted and packed, and the file is a bootstrap that unpacks it and
  // hands it to loadstring. Nothing of the loader is source in the file.
  if (options.loadstring !== false) {
    const envelopePool = createStringPool({
      rng,
      call: pn("__V9100__"),
      locals: { fn: pn("__V9100__"), pack: pn("__V9101__"), off: pn("__V9102__"), cache: pn("__V9103__"), alpha: pn("__V9105__") },
    });
    const inflateSource = (() => {
      const text = fs.readFileSync(path.join(__dirname, "Template", "runtime.lua"), "utf8");
      const from = text.indexOf("--<INFLATE>");
      const to = text.indexOf("--</INFLATE>");
      if (from < 0 || to < from) throw new Error("envelope: inflate block not marked in the runtime template");
      return text.slice(from + "--<INFLATE>".length, to);
    })();
    const names = {
      env: pn("__V9121__"), str: pn("__V9122__"), byte: pn("__V9123__"),
      lookup: pn("__V9110__"), text: pn("__V9111__"), alphabet: pn("__V9112__"),
      sub: pn("__V9113__"), chr: pn("__V9114__"), cat: pn("__V9115__"), load: pn("__V9116__"),
      err: pn("__V9124__"), len: pn("__V9125__"),
      n: pn("__V9117__"), out: pn("__V9118__"), src: pn("__V9119__"), fn: pn("__V9120__"),
      mint: () => payload.name(),
    };
    const body = emitLoadstringEnvelope(code, { rng, spool: envelopePool, inflateText: inflateSource, alpha: names });
    const decls = [
      `local ${pn("__V9100__")},${pn("__V9101__")},${pn("__V9102__")},${pn("__V9103__")},${pn("__V9105__")}`,
      `local ${names.env},${names.str},${names.byte},${names.lookup},${names.text},${names.alphabet},${names.sub},${names.chr},${names.cat},${names.load},${names.err},${names.len},${names.n},${names.out},${names.src},${names.fn}`,
      envelopePool.render(),
    ].join("\n");
    code = collapseToSingleLine(fixRefs(decls + "\n" + body.join("\n")));
  }

  if (wantWatermark(options)) code = WATERMARK_LINE + "\n" + code;

  const report = { ok: true, gate: 0, declared: [] }

  if (options.verbose) {
    console.error(`[wrap] target=${target} gate=${report.gate}${sugarStats ? ` compound=${sugarStats.compound} floorDiv=${sugarStats.floorDiv} saved=${sugarStats.saved}` : ""}`);
    const upval = (code.match(/return function\(/g) || []).length;
    console.error(`[wrap] chunks=${payload.orderKeys.length} decoys=${payload.entries.length - payload.orderKeys.length}`);
    console.error(`[wrap] source=${payload.len}B packed=${payload.zlen}B ratio=${(payload.zlen / payload.len).toFixed(3)}`);
    console.error(`[wrap] closures=${upval} handlers=${6} identifiers=${new Set(report.declared).size} output=${Buffer.byteLength(code)}B`);
    console.error(`[wrap] filler banks=${pad.added} bank bytes=${pad.bankBytes}`);
    if (flattenStats) console.error(`[wrap] flattened ${flattenStats.statements} statements into ${flattenStats.blocks} blocks (hoisted ${flattenStats.hoisted} names)`);
    if (typeof pool !== "undefined" && pool && pool.protos) console.error(`[wrap] pool shuffled ${pool.constants} constants across ${pool.protos} protos`);
    if (shapeStats) console.error(`[wrap] shaped ${shapeStats.loops} loops, ${shapeStats.whileLeft} while left, ${shapeStats.strongNames} strong names`);
    const ms = prepareSource.stats && prepareSource.stats.macro;
    if (ms && ms.sites) console.error(`[wrap] macros sites=${ms.sites} string=${ms.strings} number=${ms.numbers} function=${ms.functions} bait=${ms.baits}`);
  }

  return code;
}

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

function biggestBankTable(text) {
  let best = null;
  let from = 0;
  for (let n = 0; n < 60; n++) {
    const at = text.slice(from).search(/\[0x[0-9A-F]+\]=\{(?:\[=*\[|")/);
    if (at < 0) break;
    const hit = from + at;
    const open = text.lastIndexOf("{", hit);
    const end = open >= 0 ? scanBalanced(text, open, "{", "}") : -1;
    if (open >= 0 && end > open) {
      const body = text.slice(open + 1, end - 1);
      const parts = splitTop(body);
      const entries = parts.filter((x) => /^\s*\[0x[0-9A-F]+\]=\{/.test(x)).length;
      if (!best || entries > best.entries) best = { open, end, body, parts, entries };
    }
    from = hit + 8;
  }
  return best;
}

function parseNumExpr(text) {
  const t = String(text).trim().replace(/^\(+/, "").replace(/\)+$/, "");
  const term = (x) => {
    const v = x.trim();
    if (/^0x[0-9A-Fa-f]+$/.test(v)) return parseInt(v.slice(2), 16);
    if (/^0b[01]+$/.test(v)) return parseInt(v.slice(2), 2);
    if (/^-0x[0-9A-Fa-f]+$/.test(v)) return -parseInt(v.slice(3), 16);
    if (/^-0b[01]+$/.test(v)) return -parseInt(v.slice(3), 2);
    if (/^-\d+$/.test(v)) return -Number(v.slice(1));
    if (/^\d+$/.test(v)) return Number(v);
    return NaN;
  };
  for (let i = 1; i < t.length; i++) {
    const ch = t[i];
    if (ch !== "+" && ch !== "-") continue;
    const left = term(t.slice(0, i));
    const right = term(t.slice(i + 1));
    if (Number.isNaN(left) || Number.isNaN(right)) continue;
    return ch === "+" ? left + right : left - right;
  }
  return term(t);
}

function buildStats(code) {
  const text = String(code || "");
  const closures = (text.match(/return function\(/g) || []).length;
  const handlers = (text.match(/\]=function\(\)/g) || []).length;
  let layers = 0;
  let banks = 0;
  const table = biggestBankTable(text);
  if (table) {
    {
      for (const part of table.parts) {
        const m = part.match(/^\s*\[0x([0-9A-F]+)\]=\{(?:\[(=*)\[([^]*?)\]\2\]|"([^"]*)"),(\{[^]*\}),([^}]*)\}\s*$/);
        if (!m) continue;
        banks++;
        layers += splitTop(m[5].slice(1, -1)).filter((x) => x.trim()).length;
      }
    }
  }

  const comparisons = (text.match(/(?:==|~=|<|<=|>|>=)\(?0x[0-9A-F]+/g) || []).length;
  const modTests = (text.match(/%\(?0x[0-9A-F]+\)?==/g) || []).length;
  const dispatch = comparisons;
  return { closures, handlers, layers, banks, dispatch, modTests, bytes: Buffer.byteLength(text) };
}

/*
 * decodeReference used to reassemble an artifact's payload in JS so a test could
 * look at the image without running it. It described the pre-0.16 layout (a
 * plain order array of keys) and had been throwing on every artifact since the
 * order moved into an encrypted blob - the new tamper tool found it. The payload
 * image is available at build time instead: `measurePayload(source, opts)` or
 * EAT_DUMP_IMAGE=1, which is what the suite and the tools use.
 */

function referenceImage(source, options = {}) {
  const seed = resolveSeed(options.seed);
  const ring = createKeyring(seed);
  const opmap = remap(ring.c);
  const codeSalt = (ring.b.word() % 16777216) >>> 0;
  const strSalt = (ring.b.word() % 16777216) >>> 0;
  const instr = process.env.NOINSTR ? null : { k1: ring.k1, k2: ring.k2, salt: codeSalt };

  const fieldOrder = perm.shuffle(7, ring.b);
  const tagOrder = perm.shuffle(5, ring.b);
  const layout = { fieldOrder, tagOf: { nil: tagOrder[0] + 1, false: tagOrder[1] + 1, true: tagOrder[2] + 1, number: tagOrder[3] + 1, string: tagOrder[4] + 1 } };
  const rngForSource = createRNG(seed ^ 0x5f3a);
  return compileSource(prepareSource(source, rngForSource), {
    opmap,
    dedupe: true,
    poolRng: ring.b,
    streamKey: process.env.NOSTR ? null : { k1: ring.k1, k2: ring.k2, salt: strSalt },
    instr,
    layout,
  }).image;
}

function measurePayload(source, options = {}) {
  const seed = resolveSeed(options.seed);
  const ring = createKeyring(seed);
  const opmap = remap(ring.c);
  const codeSalt = (ring.b.word() % 16777216) >>> 0;
  const strSalt = (ring.b.word() % 16777216) >>> 0;
  const instr = process.env.NOINSTR ? null : { k1: ring.k1, k2: ring.k2, salt: codeSalt };
  const fieldOrder = perm.shuffle(7, ring.b);
  const tagOrder = perm.shuffle(5, ring.b);
  const layout = { fieldOrder, tagOf: { nil: tagOrder[0] + 1, false: tagOrder[1] + 1, true: tagOrder[2] + 1, number: tagOrder[3] + 1, string: tagOrder[4] + 1 } };
  const rngForSource = createRNG(seed ^ 0x5f3a);
  const { image, proto } = compileSource(prepareSource(source, rngForSource), {
    opmap,
    dedupe: true,
    poolRng: ring.b,
    streamKey: process.env.NOSTR ? null : { k1: ring.k1, k2: ring.k2, salt: strSalt },
    instr,
    layout,
  });
  const real = proto.child.filter((c) => !c.decoy).length;
  const decoy = proto.child.filter((c) => c.decoy).length;
  return { image, len: image.length, zlen: deflate.compress(image).length, protos: real + 1, decoys: decoy };
}

module.exports = {
  maskNumbers,
  BRAND,
  NAME_RE,
  buildStats,
  wrapSource,
  loaderText,
  validate,
  referenceImage,
  measurePayload,
  opmapForSeed,
  collectDeclaredNames,
  createRNG,
  makeNameFactory,
  affineEncodeBytes,
  affineDecodeBytes,
  packBlob,
  unpackBlob,
  makeAlphabet,
  storageSeedFor,
  alphabetParams,
  STORAGE_SET,
  BOOT_ALPHABET,
};
// Wrap module expanded
const WRAP_EXTRA = {
  // Additional targets
  targets: ['luau', 'portable', 'roblox', 'node', 'python', 'wasm'],
  // Additional seeds
  seeds: [1, 2, 3, 4, 5, 42, 9999, 0x5bf03635, 'random', 'chrono'],
  // Additional options
  options: ['bloat', 'flatten', 'blocks', 'verbose', 'extra'],
  // Wrap statistics
  stats: {
    total_wraps: 0,
    successful_wraps: 0,
    failed_wraps: 0,
    avg_wrap_time: 0,
  },
  // Wrap history
  history: [],
  // Wrap version
  version: '2.0.0',
  built: new Date().toISOString(),
};
module.exports.WRAP_EXTRA = WRAP_EXTRA;
// End of wrap module expansion
