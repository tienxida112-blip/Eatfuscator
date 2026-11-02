"use strict";

/**
 * Name space audit — dsc.gg/eatfuscator
 *
 * Every identifier the build emits is drawn from one opaque family
 * (2-5 shape-confusable glyphs (`l I O 0 o i 1 _`)), so no local ever spells a word. This module is
 * the guard that keeps it true: it lexes the emitted text and reports anything
 * that is short, readable or outside the family — the leftovers a reader would
 * actually notice.
 */

const { NAME_RE, NAME_SRC } = require("../../Envelope/idents");
const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in",
  "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while", "continue",
]);

/**
 * Identifiers that are part of the language or the host, not of the build's
 * own naming: `_ENV`/`_G` are how Lua spells its environment, and the loader
 * has to name the fields it reads off the real standard library.
 */
const RUNTIME = new Set([
  "_ENV", "_G", "self",
  "table", "string", "math", "coroutine", "os", "io", "debug", "bit32", "utf8",
  "unpack", "pack", "insert", "remove", "concat", "sort", "rep", "sub", "byte", "char", "format", "gsub", "gmatch", "find", "len",
  "floor", "ceil", "abs", "max", "min", "huge", "random", "randomseed", "fmod", "modf", "sqrt", "sin", "cos", "tan",
  "type", "pcall", "xpcall", "select", "tonumber", "tostring", "error", "assert", "print", "warn", "next", "pairs", "ipairs",
  "rawget", "rawset", "rawequal", "getmetatable", "setmetatable", "getfenv", "setfenv", "loadstring", "load", "require",
]);

/** a match that is really the tail of a `0x…` numeral, not an identifier */
function tailOfNumber(code, index, name) {
  return index > 0 && code[index - 1] === "0" && /^x[0-9A-Fa-f]+$/.test(name);
}

/** true when `name` belongs to the build's opaque family */
function isOpaque(name) {
  return NAME_RE.test(name);
}

/**
 * Every identifier in `code` that is not a keyword, not opaque, and not a
 * language or host name. String literals and comments are skipped, so a URL or
 * a field name spelled inside quotes never shows up here.
 * @returns {string[]} unique offenders, longest first
 */
function weakNames(code) {
  const seen = new Set();
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    if (c === "-" && code[i + 1] === "-") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && code[i] !== c) i += code[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "[" && (code[i + 1] === "[" || code[i + 1] === "=")) {
      const close = code.indexOf("]", i);
      if (close > 0) { i = close + 1; continue; }
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
      const name = code.slice(i, j);
      i = j;
      if (KEYWORDS.has(name) || isOpaque(name) || RUNTIME.has(name)) continue;
      if (tailOfNumber(code, j - name.length, name)) continue;
      seen.add(name);
      continue;
    }
    i++;
  }
  return [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** share of the build's own identifiers that are opaque, 0..1 */
function strongNameRatio(code) {
  const weak = weakNames(code).length;
  let opaque = 0;
  const re = new RegExp(NAME_SRC, "g");
  while (re.exec(code)) opaque++;
  const total = opaque + weak;
  return total ? Number((opaque / total).toFixed(4)) : 1;
}

module.exports = { NAME_RE, RUNTIME, isOpaque, weakNames, strongNameRatio };
