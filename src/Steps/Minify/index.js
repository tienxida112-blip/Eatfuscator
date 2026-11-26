"use strict";

let luaparse = null;
try {
  luaparse = require("../../Vendor/luaparse");
} catch {

}
if (!luaparse) {
  try {
    luaparse = require("luaparse");
  } catch {
    luaparse = null;
  }
}

const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
  "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then",
  "true", "until", "while", "continue", "export", "type", "typeof",
]);

function tokenize(src) {
  const s = String(src);
  const n = s.length;
  const out = [];
  let i = 0;

  const isNameStart = (c) => /[A-Za-z_]/.test(c);
  const isName = (c) => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c) => c >= "0" && c <= "9";

  function longBracket(i) {
    if (s[i] !== "[") return -1;
    let j = i + 1;
    let eq = 0;
    while (s[j] === "=") {
      eq++;
      j++;
    }
    if (s[j] !== "[") return -1;
    const close = "]" + "=".repeat(eq) + "]";
    const end = s.indexOf(close, j + 1);
    if (end === -1) return -1;
    return end + close.length;
  }

  while (i < n) {
    const c = s[i];

    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\v" || c === "\f") {
      i++;
      continue;
    }

    if (i === 0 && c === "#") {
      const e = s.indexOf("\n", i);
      i = e === -1 ? n : e + 1;
      continue;
    }

    if (c === "-" && s[i + 1] === "-") {
      const lb = longBracket(i + 2);
      if (lb !== -1) {
        i = lb;
        continue;
      }
      const e = s.indexOf("\n", i);
      i = e === -1 ? n : e + 1;
      continue;
    }

    if (c === "[") {
      const lb = longBracket(i);
      if (lb !== -1) {
        out.push({ t: "str", v: s.slice(i, lb) });
        i = lb;
        continue;
      }
    }

    if (c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        const d = s[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "{") depth++;
        else if (d === "}") depth--;
        else if (d === "`" && depth <= 0) {
          j++;
          break;
        }
        j++;
      }
      out.push({ t: "str", v: s.slice(i, j) });
      i = j;
      continue;
    }

    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        const d = s[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === q) {
          j++;
          break;
        }
        if (d === "\n") break;
        j++;
      }
      out.push({ t: "str", v: s.slice(i, j) });
      i = j;
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(s[i + 1]))) {
      let j = i;
      if (s[j] === "0" && (s[j + 1] === "b" || s[j + 1] === "B")) {
        j += 2;
        while (j < n && /[01_]/.test(s[j])) j++;
      } else if (s[j] === "0" && (s[j + 1] === "x" || s[j + 1] === "X")) {
        j += 2;
        while (j < n && /[0-9a-fA-F._]/.test(s[j])) j++;
        if (s[j] === "p" || s[j] === "P") {
          j++;
          if (s[j] === "+" || s[j] === "-") j++;
          while (j < n && isDigit(s[j])) j++;
        }
      } else {
        while (j < n && /[0-9_]/.test(s[j])) j++;
        if (s[j] === "." && s[j + 1] !== ".") {
          j++;
          while (j < n && /[0-9_]/.test(s[j])) j++;
        }
        if (s[j] === "e" || s[j] === "E") {
          j++;
          if (s[j] === "+" || s[j] === "-") j++;
          while (j < n && isDigit(s[j])) j++;
        }
      }
      out.push({ t: "num", v: s.slice(i, j) });
      i = j;
      continue;
    }

    if (isNameStart(c)) {
      let j = i + 1;
      while (j < n && isName(s[j])) j++;
      const v = s.slice(i, j);
      out.push({ t: KEYWORDS.has(v) ? "kw" : "name", v });
      i = j;
      continue;
    }

    const ops = [
      "...", "..=", "//=", "<<=", ">>=", "->", "::", "+=", "-=", "*=", "/=", "%=", "^=", "..",
      "==", "~=", "<=", ">=", "//", "<<", ">>", "~",
    ];
    let matched = null;
    for (const op of ops) {
      if (s.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      out.push({ t: "op", v: matched });
      i += matched.length;
      continue;
    }

    out.push({ t: "op", v: c });
    i++;
  }

  return out;
}

const WORD = new Set(["name", "num", "kw"]);

function needsSpace(prev, cur) {
  if (!prev) return false;
  const a = prev.v;
  const b = cur.v;

  if (WORD.has(prev.t) && WORD.has(cur.t)) return true;

  if (a.endsWith("-") && b.startsWith("-")) return true;

  if (prev.t === "num" && (b[0] === "." || b[0] === "e" || b[0] === "E")) return true;

  if (prev.t === "op" && cur.t === "op") {
    const glue = a + b;
    if (glue === "--" || glue === "::" || glue === ".." && a === ".") return true;
    if (a === "." && b === ".") return true;
    if ((a === "<" || a === ">" || a === "=" || a === "~" || a === "/") && (b === "=" || b === ">")) return true;
    if (a === ":" && b === ":") return true;
    if (a === "-" && b[0] === "-") return true;
    if (a === "<" && b === "<") return true;
    if (a === ">" && b === ">") return true;
  }

  return false;
}

function emit(tokens) {
  let out = "";
  let prev = null;
  for (const tok of tokens) {
    if (needsSpace(prev, tok)) out += " ";
    out += tok.v;
    prev = tok;
  }
  return out;
}

function sameTokens(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].t !== b[i].t) {

      if (a[i].v !== b[i].v) return false;
      continue;
    }
    if (a[i].v !== b[i].v) return false;
  }
  return true;
}

function checkSyntax(src, luaVersion = "5.1") {
  if (!luaparse) return { ok: true, skipped: true, error: null };
  const dialect = String(luaVersion).toLowerCase();
  try {
    if (dialect === "luau") {

      const { lowerLuau, normalizeLuauOperators } = require("../../Parser/Luau");
      const opts = { luaVersion: "5.1", comments: false, locations: false, ranges: false };
      let normalisedError = null;
      try {
        luaparse.parse(normalizeLuauOperators(String(src)), opts);
        return { ok: true, dialect: "luau", via: "operators" };
      } catch (e) {
        normalisedError = e && e.message ? e.message : String(e);
      }
      try {
        luaparse.parse(lowerLuau(String(src)), opts);
        return { ok: true, dialect: "luau", via: "lowering" };
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        return { ok: false, dialect: "luau", error: msg === normalisedError ? msg : `${msg} (normalised: ${normalisedError})` };
      }
    }
    luaparse.parse(String(src), { luaVersion, comments: false, locations: false, ranges: false });
    return { ok: true, dialect: String(luaVersion) };
  } catch (e) {
    return { ok: false, dialect, error: e && e.message ? e.message : String(e) };
  }
}

function minifyLua(src, mode = "Normal") {
  const text = String(src == null ? "" : src);
  const m = String(mode || "Normal").toLowerCase();
  if (m === "false" || m === "off" || m === "none") return text;
  if (!text.trim()) return text;

  let inTokens;
  let outTokens;
  let out;

  try {
    inTokens = tokenize(text);
    out = emit(inTokens);
    outTokens = tokenize(out);
  } catch {
    return text;
  }

  if (!sameTokens(inTokens, outTokens)) return text;

  const before = checkSyntax(text);
  if (!before.skipped) {
    if (!before.ok) return out;
    const after = checkSyntax(out);
    if (!after.ok) return text;
  }

  return out;
}

function verifyMinify(original, minified) {
  try {
    return sameTokens(tokenize(original), tokenize(minified));
  } catch {
    return false;
  }
}

module.exports = { tokenize, minifyLua, checkSyntax, verifyMinify, sameTokens };
