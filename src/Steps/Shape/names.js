"use strict";

const { NAME_RE, NAME_SRC, KEYWORDS: SHARED_KEYWORDS, GLOBALS } = require("../../Envelope/idents");
const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in",
  "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while", "continue",
]);

const RUNTIME = new Set([
  "_ENV", "_G", "self",
  "table", "string", "math", "coroutine", "os", "io", "debug", "bit32", "utf8",
  "unpack", "pack", "insert", "remove", "concat", "sort", "rep", "sub", "byte", "char", "format", "gsub", "gmatch", "find", "len",
  "floor", "ceil", "abs", "max", "min", "huge", "random", "randomseed", "fmod", "modf", "sqrt", "sin", "cos", "tan",
  "type", "pcall", "xpcall", "select", "tonumber", "tostring", "error", "assert", "print", "warn", "next", "pairs", "ipairs",
  "rawget", "rawset", "rawequal", "getmetatable", "setmetatable", "getfenv", "setfenv", "loadstring", "load", "require",
]);

function tailOfNumber(code, index, name) {
  return index > 0 && code[index - 1] === "0" && /^x[0-9A-Fa-f]+$/.test(name);
}

function isOpaque(name) {
  return NAME_RE.test(name);
}

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

function strongNameRatio(code) {
  const weak = weakNames(code).length;
  let opaque = 0;
  const re = new RegExp("(?<![A-Za-z0-9_])" + NAME_SRC + "(?![A-Za-z0-9_])", "g");
  let m;
  while ((m = re.exec(code)) !== null) {
    const word = m[0];
    if (SHARED_KEYWORDS.has(word) || GLOBALS.has(word)) continue;
    opaque++;
  }
  const total = opaque + weak;
  return total ? Number((opaque / total).toFixed(4)) : 1;
}

module.exports = { NAME_RE, RUNTIME, isOpaque, weakNames, strongNameRatio };
