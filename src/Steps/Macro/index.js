"use strict";

/** Reserved global macro calls are expanded before compilation. Number
 * macros use the same VM constant cipher as string literals. */

const luaparse = require("../../Vendor/luaparse");

// The four call macros that have been here since 0.9 (they rewrite a literal into
// an equivalent form) plus the three added in 0.29, which are the Luraph-shaped
// half of the system: calls that *tell the build something* instead of asking it
// for a weaker build. Everything under EAT_ is reserved.
const CALLS = new Set([
  "EAT_STRING", "EAT_NUMBER", "EAT_FUNCTION", "EAT_RAGEBAIT",
  "EAT_ASSUME", "EAT_OPAQUE", "EAT_SECRET",
]);
const OBFUSCATED_FLAG = "EAT_OBFUSCATED";
const TAUNT = "eatfuscator said no skid";
const STRING_CHUNK = 48;

function stringEnd(text, i) {
  const q = text[i];
  if (q === "`") {
    let j = i + 1;
    while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
    return Math.min(j + 1, text.length);
  }
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < text.length && text[j] !== q) j += text[j] === "\\" ? 2 : 1;
    return Math.min(j + 1, text.length);
  }
  let eq = 0;
  let j = i + 1;
  while (text[j] === "=") {
    eq++;
    j++;
  }
  const close = "]" + "=".repeat(eq) + "]";
  const at = text.indexOf(close, j + 1);
  return at < 0 ? text.length : at + close.length;
}

function commentEnd(text, i) {
  if (text[i + 2] === "[" && (text[i + 3] === "[" || text[i + 3] === "=")) return stringEnd(text, i + 2);
  const nl = text.indexOf("\n", i);
  return nl < 0 ? text.length : nl;
}

function isLongOpen(text, i) {
  return text[i] === "[" && (text[i + 1] === "[" || text[i + 1] === "=");
}

function parenEnd(text, open) {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === "-" && text[i + 1] === "-") {
      i = commentEnd(text, i);
      continue;
    }
    if (c === '"' || c === "'" || c === "`" || isLongOpen(text, i)) {
      i = stringEnd(text, i);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

function countNewlines(text, from, to) {
  let k = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) k++;
  return k;
}

// Split an argument list at top-level commas, skipping strings and comments.
function splitArgs(argText) {
  const src = String(argText);
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "-" && src[i + 1] === "-") { i = commentEnd(src, i); continue; }
    if (c === '"' || c === "'" || c === "`" || isLongOpen(src, i)) { i = stringEnd(src, i); continue; }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) { parts.push(src.slice(start, i)); start = i + 1; }
    i++;
  }
  parts.push(src.slice(start));
  return parts.filter((p) => p.trim().length);
}

function parseExpr(text, macro, line) {
  try {
    const ast = luaparse.parse("return " + text, { luaVersion: "5.1", comments: false, locations: false, ranges: false });
    return ast.body[0].arguments[0];
  } catch {
    throw new Error(`${macro} on line ${line}: cannot read the argument`);
  }
}

/**
 * Bytes of a literal, exactly as the pipeline sees the source (latin1 view).
 * The vendored luaparse leaves StringLiteral.value null, so the literal is
 * decoded from its raw text instead of trusted to a parser field.
 */
function bytesOf(value) {
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0xff) throw new Error("EAT_STRING: literal contains a character above U+00FF; escape it as \\xNN");
    out.push(code);
  }
  return out;
}

const SIMPLE_ESCAPES = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  "\\": 92,
  '"': 34,
  "'": 39,
  "\n": 10,
};

function utf8Bytes(cp) {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
}

/** Decode a Lua/Luau string literal (raw source text) into its bytes. */
function literalBytes(raw, where) {
  const bad = (msg) => {
    throw new Error(`${where || "string literal"}: ${msg}`);
  };
  if (raw[0] === "[") {
    const m = /^\[(=*)\[/.exec(raw);
    if (!m) bad("bad long bracket");
    const close = "]" + m[1] + "]";
    let body = raw.slice(m[0].length, raw.length - close.length);
    if (body[0] === "\n") body = body.slice(1);
    else if (body[0] === "\r") body = body.slice(body[1] === "\n" ? 2 : 1);
    return bytesOf(body);
  }
  if (raw[0] !== '"' && raw[0] !== "'") bad("not a string literal");
  const quote = raw[0];
  const body = raw.slice(1, -1);
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      out.push(body.charCodeAt(i) & 0xff);
      continue;
    }
    const e = body[++i];
    if (e === undefined) bad("trailing backslash");
    if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, e)) {
      out.push(SIMPLE_ESCAPES[e]);
      continue;
    }
    if (e === "z") {
      while (i + 1 < body.length && /\s/.test(body[i + 1])) i++;
      continue;
    }
    if (e === "x") {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) bad("bad \\x escape");
      out.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    if (e === "u") {
      const m = /^\{([0-9a-fA-F]+)\}/.exec(body.slice(i + 1));
      if (!m) bad("bad \\u escape");
      const cp = parseInt(m[1], 16);
      if (!(cp <= 0x10ffff)) bad("\\u escape out of range");
      for (const b of utf8Bytes(cp)) out.push(b);
      i += m[0].length;
      continue;
    }
    if (/[0-9]/.test(e)) {
      let digits = e;
      while (digits.length < 3 && /[0-9]/.test(body[i + 1] || "")) digits += body[++i];
      const v = parseInt(digits, 10);
      if (v > 255) bad("decimal escape above 255");
      out.push(v);
      continue;
    }
    if (e === "\n" || e === "\r") {
      out.push(10);
      continue;
    }
    if (e === quote) {
      out.push(quote.charCodeAt(0));
      continue;
    }
    // Unknown escape: keep the character, like Lua's lenient fallback.
    out.push(e.charCodeAt(0) & 0xff);
  }
  return out;
}

function quoteLua(bytes) {
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += "\\\\";
    else if (b === 0x0a) out += "\\n";
    else if (b === 0x0d) out += "\\r";
    else if (b === 0x09) out += "\\t";
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += "\\" + b;
  }
  return out + '"';
}

function eatString(argText, ctx) {
  const node = parseExpr(argText.trim(), "EAT_STRING", ctx.line);
  if (node.type !== "StringLiteral") {
    throw new Error(`EAT_STRING on line ${ctx.line} expects a string literal`);
  }
  const bytes = literalBytes(node.raw, `EAT_STRING on line ${ctx.line}`);
  if (bytes.length <= STRING_CHUNK) return quoteLua(bytes);
  const parts = [];
  for (let i = 0; i < bytes.length; i += STRING_CHUNK) parts.push(quoteLua(bytes.slice(i, i + STRING_CHUNK)));
  return "(" + parts.join(" .. ") + ")";
}

function eatNumber(argText, ctx) {
  let node = parseExpr(argText.trim(), "EAT_NUMBER", ctx.line);
  let negative = false;
  while (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    if (node.operator === "-") negative = !negative;
    node = node.argument;
  }
  if (node.type !== "NumericLiteral") throw new Error(`EAT_NUMBER on line ${ctx.line} expects a number literal`);
  const value = negative ? -node.value : node.value;
  if (!Number.isFinite(value)) throw new Error(`EAT_NUMBER on line ${ctx.line}: ${value} cannot be encoded`);
  // Store the round-tripping text as a VM string constant, so it passes
  // through exactly the same per-prototype/per-constant cipher as EAT_STRING.
  const repr = Object.is(value, -0) ? "-0" : String(value);
  return `(tonumber(${eatString(quoteLua(Array.from(Buffer.from(repr, "ascii"))), ctx)}))`;
}

function eatFunction(argText, ctx) {
  const node = parseExpr(argText.trim(), "EAT_FUNCTION", ctx.line);
  if (node.type !== "FunctionDeclaration") {
    throw new Error(`EAT_FUNCTION on line ${ctx.line} expects a function literal`);
  }
  return "(" + argText.trim() + ")";
}

function eatRagebait(ctx) {
  // A bait site is meant to burn whoever lifts the code out and runs it: print
  // the taunt, then park the thread forever instead of returning a value.
  const msg = quoteLua(bytesOf(TAUNT));
  return `(function(...) print(${msg}) repeat until false return ... end)()`;
}

// EAT_ASSUME(value, expected): the source states a fact about a runtime value.
// The build believes it, so the call site becomes a constant and anything that
// consumes it can be specialised. The value expression is still evaluated, so a
// script that runs without obfuscation (where the macro is a shim) behaves the
// same way as the built one.
function eatAssume(argText, ctx) {
  const parts = splitArgs(argText);
  if (parts.length !== 2) throw new Error(`EAT_ASSUME on line ${ctx.line} takes (value, expected)`);
  const [value, expected] = parts;
  if (!/^-?(0x[0-9a-fA-F]+|\d+(\.\d+)?)$/.test(expected.trim())) {
    throw new Error(`EAT_ASSUME on line ${ctx.line}: expected must be a numeric literal, got ${JSON.stringify(expected.trim())}`);
  }
  return `((function() local _=${value.trim()} return ${expected.trim()} end)())`;
}

// EAT_OPAQUE(true | false): a predicate that always has that value and never
// looks like one. Not `cond and true or false` - in Lua that is true whenever the
// condition holds, so the false case has to be an equality.
function eatOpaque(argText, ctx) {
  const want = argText.trim();
  if (want !== "true" && want !== "false") {
    throw new Error(`EAT_OPAQUE on line ${ctx.line} takes the literal true or false`);
  }
  const rnd = (n) => Math.floor(ctx.rng() * n);
  const a = 1024 + rnd(60000);
  const b = 1024 + rnd(60000);
  const k = 3 + rnd(97);
  return `((((((${a}*${k})+${b})%((${k}*${a})+${b}))==0))==${want})`;
}

// EAT_SECRET("text", expression, expected): the string comes back only when the
// expression equals the expected value at run time. Ordinary string constants are
// encrypted with a build key; this one is bound to a *runtime* fact, so a dump
// taken from a host where the fact does not hold yields bytes, not the string.
function eatSecret(argText, ctx) {
  const parts = splitArgs(argText);
  if (parts.length !== 3) throw new Error(`EAT_SECRET on line ${ctx.line} takes (string, expression, expected)`);
  const [literal, expr, expected] = parts.map((p) => p.trim());
  const node = parseExpr(literal, "EAT_SECRET", ctx.line);
  if (node.type !== "StringLiteral") {
    throw new Error(`EAT_SECRET on line ${ctx.line}: the first argument must be a string literal`);
  }
  if (!/^-?(0x[0-9a-fA-F]+|\d+)$/.test(expected)) {
    throw new Error(`EAT_SECRET on line ${ctx.line}: expected must be an integer literal`);
  }
  const bytes = literalBytes(literal);
  const k = 1 + Math.floor(ctx.rng() * 251);
  const enc = bytes.map((v, i) => (v + k * (i + 1)) % 256);
  return (
    `((function(_k) local t={${enc.join(",")}} local o={} ` +
    `for _i=1,#t do o[_i]=string.char((t[_i]-${k}*_i*_k)%256) end ` +
    `return table.concat(o) end)((1+((${expr})-(${expected})))%256))`
  );
}

function expandCall(name, argText, ctx) {
  if (name === "EAT_STRING") return eatString(argText, ctx);
  if (name === "EAT_NUMBER") return eatNumber(argText, ctx);
  if (name === "EAT_FUNCTION") return eatFunction(argText, ctx);
  if (name === "EAT_ASSUME") return eatAssume(argText, ctx);
  if (name === "EAT_OPAQUE") return eatOpaque(argText, ctx);
  if (name === "EAT_SECRET") return eatSecret(argText, ctx);
  return eatRagebait(ctx);
}

function isIdentStart(c) {
  return /[A-Za-z_]/.test(c);
}

function isIdentChar(c) {
  return /[A-Za-z0-9_]/.test(c);
}

function expandOnce(source, rng) {
  const src = String(source);
  const out = [];
  const stats = { sites: 0, strings: 0, numbers: 0, functions: 0, baits: 0, assume: 0, opaque: 0, secret: 0 };
  const n = src.length;
  let i = 0;
  let line = 1;

  const copyTo = (to) => {
    out.push(src.slice(i, to));
    line += countNewlines(src, i, to);
    i = to;
  };

  while (i < n) {
    const c = src[i];

    if (c === "-" && src[i + 1] === "-") {
      const end = commentEnd(src, i);
      copyTo(end);
      continue;
    }
    if (c === '"' || c === "'" || c === "`" || isLongOpen(src, i)) {
      const end = stringEnd(src, i);
      copyTo(end);
      continue;
    }

    if (isIdentStart(c) && !(i > 0 && (isIdentChar(src[i - 1]) || src[i - 1] === "."))) {
      let j = i;
      while (j < n && isIdentChar(src[j])) j++;
      const name = src.slice(i, j);
      // Everything under EAT_ is reserved: an unknown name is a build error, not a
      // call that silently survives into the artifact, and a local shadow would
      // change what a call site means.
      if (name.startsWith("EAT_") && name !== OBFUSCATED_FLAG && !CALLS.has(name)) {
        throw new Error(`line ${line}: ${name} is not a macro - names starting with EAT_ are reserved (known: ${[...CALLS].join(", ")})`);
      }
      if (name.startsWith("EAT_") && /\blocal\s+$/.test(src.slice(Math.max(0, i - 12), i))) {
        throw new Error(`line ${line}: ${name} cannot be declared local - macro names are reserved`);
      }
      if (CALLS.has(name)) {
        let k = j;
        while (k < n && /\s/.test(src[k])) k++;
        if (src[k] === "(") {
          const close = parenEnd(src, k);
          if (close < 0) throw new Error(`${name} on line ${line}: unbalanced parentheses`);
          const argText = src.slice(k + 1, close - 1);
          const ctx = { rng, line };
          out.push(expandCall(name, argText, ctx));
          stats.sites++;
          if (name === "EAT_STRING") stats.strings++;
          else if (name === "EAT_NUMBER") stats.numbers++;
          else if (name === "EAT_FUNCTION") stats.functions++;
          else if (name === "EAT_ASSUME") stats.assume++;
          else if (name === "EAT_OPAQUE") stats.opaque++;
          else if (name === "EAT_SECRET") stats.secret++;
          else stats.baits++;
          line += countNewlines(src, i, close);
          i = close;
          continue;
        }
      }
      copyTo(j);
      continue;
    }

    out.push(c);
    i++;
  }

  return { code: out.join(""), stats };
}

// `if not EAT_OBFUSCATED then ... end` is the shim block: what a script carries so
// that it runs before it is obfuscated. The build deletes it, and only then does a
// call site mean the macro instead of the local stub.
function stripShims(source) {
  const src = String(source);
  const out = [];
  let removed = 0;
  let i = 0;
  const n = src.length;
  const copy = (to) => out.push(src.slice(i, to));
  while (i < n) {
    const c = src[i];
    if (c === "-" && src[i + 1] === "-") { const e = commentEnd(src, i); copy(e); i = e; continue; }
    if (c === '"' || c === "'" || c === "`" || isLongOpen(src, i)) { const e = stringEnd(src, i); copy(e); i = e; continue; }
    if (isIdentStart(c) && !(i > 0 && isIdentChar(src[i - 1]))) {
      let j = i;
      while (j < n && isIdentChar(src[j])) j++;
      const name = src.slice(i, j);
      if ((name === "if" || name === "while" || name === "elseif") ) {
        // look for `if not EAT_OBFUSCATED then` starting here
        const head = /^(?:if|while)\s+not\s+EAT_OBFUSCATED\s+then\b/.exec(src.slice(i));
        if (head) {
          let depth = 1;
          let k = i + head[0].length;
          while (k < n && depth > 0) {
            const d = src[k];
            if (d === "-" && src[k + 1] === "-") { k = commentEnd(src, k); continue; }
            if (d === '"' || d === "'" || d === "`" || isLongOpen(src, k)) { k = stringEnd(src, k); continue; }
            if (isIdentStart(d) && !(k > 0 && isIdentChar(src[k - 1]))) {
              let e = k;
              while (e < n && isIdentChar(src[e])) e++;
              const w = src.slice(k, e);
              if (w === "if" || w === "function" || w === "repeat" || w === "do") depth++;
              else if (w === "end" || w === "until") depth--;
              k = e;
              if (depth === 0) break;
              continue;
            }
            k++;
          }
          if (depth !== 0) throw new Error("macro shim: `if not EAT_OBFUSCATED then` is never closed");
          // drop everything from `if` through its `end`
          let stop = k;
          while (stop < n && isIdentChar(src[stop])) stop++;
          removed++;
          i = stop;
          continue;
        }
      }
      copy(j);
      i = j;
      continue;
    }
    out.push(c);
    i++;
  }
  return { code: out.join(""), removed };
}

function expand(source, options = {}) {
  const rng = options.rng;
  if (typeof rng !== "function") throw new Error("macro expand: a seeded rng is required");
  // Shims first: the stubs inside them are ordinary functions that would otherwise
  // shadow the macros the call sites expand to.
  const stripped = stripShims(source == null ? "" : source);
  const result = expandOnce(stripped.code, rng);
  result.stats.shims = stripped.removed;
  return result;
}

module.exports = { expand, expandOnce, stripShims, CALLS, TAUNT, quoteLua, bytesOf, literalBytes };
