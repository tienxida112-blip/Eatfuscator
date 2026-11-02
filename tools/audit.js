"use strict";

/**
 * Fingerprint audit — dsc.gg/eatfuscator
 *
 * Reads an artifact (or a whole folder of them) and reports what a human eye
 * or a filter can still recognise: statement shapes, keyword counts, the
 * longest readable token runs and the strings that survived encoding.
 *
 *   node tools/audit.js out.lua
 *   node tools/audit.js Sample/
 */

const fs = require("fs");
const path = require("path");
const luaparse = require("../src/Vendor/luaparse");
const { lowerLuau } = require("../src/Vm/backend");
const { NAME_RE } = require("../src/Envelope/idents");

const SHAPES = [
  ["WhileStatement", "while <cond> do ... end"],
  ["RepeatStatement", "repeat ... until <cond>"],
  ["ForNumericStatement", "for <var> = a, b do ... end"],
  ["ForGenericStatement", "for k, v in ... do ... end"],
  ["IfStatement", "if <cond> then"],
  ["DoStatement", "do ... end"],
  ["FunctionDeclaration", "function / local function"],
  ["LocalStatement", "local x = ..."],
  ["AssignmentStatement", "x = ..."],
  ["CallStatement", "f(...)"],
  ["TableConstructorExpression", "{ ... }"],
  ["BinaryExpression", "a <op> b"],
  ["MemberExpression", "a.b / a[b]"],
];

const KEYWORDS = ["while", "repeat", "until", "for", "do", "end", "then", "elseif", "else", "function", "local", "return", "break", "goto", "not", "and", "or", "nil", "true", "false"];

function countNodes(ast) {
  const c = {};
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type) c[n.type] = (c[n.type] || 0) + 1;
    for (const k in n) {
      if (k === "loc" || k === "range") continue;
      const v = n[k];
      if (v && typeof v === "object") walk(v);
    }
  })(ast);
  return c;
}

function words(src) {
  // skip the tails of `0x…` numerals: `x1F` is not a name anyone can read
  const out = [];
  for (const m of src.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    if (src[m.index - 1] === "0" && /^x[0-9A-Fa-f]+$/.test(m[0])) continue;
    out.push(m[0]);
  }
  return out;
}

function auditFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const body = lines.length > 1 ? lines.slice(1).join("\n") : text;
  const out = { file: path.basename(file), bytes: Buffer.byteLength(text), lines: lines.length, line1: lines[0].slice(0, 64) };

  // keywords that survive as keywords (they must — they spell the language)
  out.keywords = {};
  for (const k of KEYWORDS) {
    const n = (body.match(new RegExp(`(^|[^A-Za-z0-9_])${k}([^A-Za-z0-9_]|$)`, "g")) || []).length;
    if (n) out.keywords[k] = n;
  }

  // free text an analyst can read straight off the artifact
  const w = words(body).filter((x) => !NAME_RE.test(x));
  const freq = new Map();
  for (const x of w) freq.set(x, (freq.get(x) || 0) + 1);
  out.readableTokens = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  // string literals that stayed literal
  const strings = (body.match(/"(?:[^"\\\n]|\\.){2,}"/g) || [])
    .filter((s) => !/[(){}\[\]=,;]/.test(s)) // a code span between two quotes, not a string
    .filter((s) => /[A-Za-z]{3}/.test(s))
    .filter((s) => s.length <= 40)
    .map((s) => (s.length > 48 ? s.slice(0, 45) + '..."' : s));
  out.readableStrings = [...new Set(strings)].slice(0, 6);

  let ast = null;
  try {
    ast = luaparse.parse(body, { luaVersion: "5.1", comments: false, locations: false, scope: false });
  } catch (e) {
    // the artifact is Luau: compound assignment, `continue` and type syntax
    // are not 5.1, so a plain parse stops early. Retry through the same
    // lowering pass the build uses, then the census is over the real tree
    // instead of a prefix.
    try {
      ast = luaparse.parse(lowerLuau(body), { luaVersion: "5.1", comments: false, locations: false, scope: false });
      out.parsedAs = "luau (lowered)";
    } catch (e2) {
      out.parseError = String(e.message).split("\n")[0];
    }
  }
  if (ast) {
    const c = countNodes(ast);
    out.shapes = SHAPES.filter(([t]) => c[t]).map(([t, label]) => [label, c[t]]);
  }
  return out;
}

function report(files) {
  const rows = files.map(auditFile);
  for (const r of rows) {
    console.log(`\n${r.file}  ${r.bytes} bytes, ${r.lines} line(s), first line: ${r.line1}`);
    if (r.parsedAs) console.log(`  parse: ${r.parsedAs}`);
    if (r.parseError) console.log(`  parse: ${r.parseError}`);
    if (r.shapes) console.log("  shapes : " + r.shapes.map(([l, n]) => `${l} x${n}`).join("  "));
    console.log("  keywords: " + Object.entries(r.keywords).map(([k, n]) => `${k} x${n}`).join("  "));
    console.log("  readable tokens: " + r.readableTokens.map(([t, n]) => `${t}(${n})`).join(" ") || "  none");
    console.log("  readable strings: " + (r.readableStrings.join(" ") || "none"));
  }
  return rows;
}

if (require.main === module) {
  const target = process.argv[2] || "Sample/Normal.lua";
  const files = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).filter((f) => f.endsWith(".lua")).map((f) => path.join(target, f))
    : [target];
  report(files);
}

module.exports = { auditFile, report };
