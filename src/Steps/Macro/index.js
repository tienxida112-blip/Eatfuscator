"use strict";

/**
 * Macros — dsc.gg/eatfuscator
 *
 * Four call macros, and nothing else. Each replaces a call site with code that
 * rebuilds the same value at run time, so the value never reaches the compiler
 * as a literal:
 *
 *   EAT_STRING("s")     bytes are carried as `byte + key` and reassembled with
 *                       string.char + table.concat at the call site
 *   EAT_NUMBER(n)       split into `(q * k + r) * sign (+ fraction)` and added
 *                       back together at run time, exactly
 *   EAT_FUNCTION(fn)    a function literal whose every literal inside gets the
 *                       two treatments above, handed out of a keyed table
 *   EAT_RAGEBAIT([msg]) prints the taunt, then parks the thread for good
 *
 * The scan is a lexer, not a text replace: names inside strings, comments and
 * long brackets are never touched, call arguments are matched by paren balance
 * so a call written across lines still expands, and a nested call is expanded
 * before its parent sees it. Every key is drawn per site from the build seed.
 */

const luaparse = require("../../Vendor/luaparse");

const CALLS = new Set(["EAT_STRING", "EAT_NUMBER", "EAT_FUNCTION", "EAT_RAGEBAIT"]);
const TAUNT = "eatfuscator said no skid";

const isIdentStart = (c) => c !== undefined && /[A-Za-z_]/.test(c);
const isIdentChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);

/* ------------------------------------------------------------------ */
/* lexing helpers                                                      */
/* ------------------------------------------------------------------ */

/** end index (exclusive) of the string literal starting at `i` */
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
  // long bracket: [[ ... ]] or [==[ ... ]==]
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

/** end index (exclusive) of the comment starting at `i` (which is `--`) */
function commentEnd(text, i) {
  if (text[i + 2] === "[" && (text[i + 3] === "[" || text[i + 3] === "=")) return stringEnd(text, i + 2);
  const nl = text.indexOf("\n", i);
  return nl < 0 ? text.length : nl;
}

/** end index (exclusive) of a number literal starting at `i` */
function numberEnd(text, i) {
  let j = i;
  if (text[j] === "0" && /[xX]/.test(text[j + 1] || "")) {
    j += 2;
    while (j < text.length && /[0-9a-fA-F]/.test(text[j])) j++;
    return j;
  }
  while (j < text.length && /[0-9]/.test(text[j])) j++;
  if (text[j] === "." && /[0-9]/.test(text[j + 1] || "")) {
    j++;
    while (j < text.length && /[0-9]/.test(text[j])) j++;
  }
  if (/[eE]/.test(text[j] || "")) {
    let e = j + 1;
    if (/[+-]/.test(text[e] || "")) e++;
    if (/[0-9]/.test(text[e] || "")) {
      j = e;
      while (j < text.length && /[0-9]/.test(text[j])) j++;
    }
  }
  return j;
}

/** end index (exclusive) of the `(`…`)` group whose `(` is at `open` */
function parenEnd(text, open) {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === "-" && text[i + 1] === "-") {
      i = commentEnd(text, i);
      continue;
    }
    if (c === '"' || c === "'" || c === "`" || (c === "[" && (text[i + 1] === "[" || text[i + 1] === "="))) {
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

const countNewlines = (text, from, to) => {
  let k = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) k++;
  return k;
};

/** parse one argument as a Lua expression; anything else is a build error */
function parseExpr(text, macro, line) {
  try {
    const ast = luaparse.parse(`return ${text}`, {
      luaVersion: "5.1",
      comments: false,
      locations: false,
      ranges: false,
      encodingMode: "pseudo-latin1",
    });
    return ast.body[0].arguments[0];
  } catch {
    throw new Error(`${macro} on line ${line}: cannot read the argument`);
  }
}

const bytesOf = (value) => {
  const out = [];
  for (let i = 0; i < value.length; i++) out.push(value.charCodeAt(i) & 0xff);
  return out;
};

/* ------------------------------------------------------------------ */
/* EAT_STRING                                                          */
/* ------------------------------------------------------------------ */

const CHUNK = 64; // arguments per string.char call, so long strings stay sane

function eatString(argText, ctx) {
  const node = parseExpr(argText.trim(), "EAT_STRING", ctx.line);
  if (node.type !== "StringLiteral") throw new Error(`EAT_STRING on line ${ctx.line} expects a string literal`);
  const bytes = bytesOf(node.value);
  if (!bytes.length) return 'string.char()';

  const parts = [];
  // the chunk width is drawn per site as well, so two strings of the same
  // length do not even break at the same places
  const width = 16 + Math.floor(ctx.rng() * (CHUNK - 16 + 1));
  for (let i = 0; i < bytes.length; i += width) {
    const key = 1 + Math.floor(ctx.rng() * 251); // one mask per chunk, never 0
    // half the sites add the mask first and half subtract it first, so the
    // sign of every offset in the image is not the same either
    const addFirst = ctx.rng() < 0.5;
    const slice = bytes.slice(i, i + width).map((b) => (addFirst ? `${b + key}-${key}` : `${b - key}+${key}`));
    parts.push(`string.char(${slice.join(",")})`);
  }
  return parts.join("..");
}

/* ------------------------------------------------------------------ */
/* EAT_NUMBER                                                          */
/* ------------------------------------------------------------------ */

/**
 * Rebuild a non-negative integer from a chain of hops: `q*k + r` undoes each
 * exact integer division, and every intermediate stays under 2^53 for any
 * value a Lua source can carry, so the arithmetic is bit-exact.
 */
function intHops(value, ctx) {
  let q = value;
  const hops = [];
  const depth = 1 + (ctx.rng() < 0.5 ? 1 : 0);
  for (let i = 0; i < depth && q > 1; i++) {
    const k = 2 + Math.floor(ctx.rng() * 96);
    const r = q % k;
    hops.push([(q - r) / k, k, r]);
    q = (q - r) / k;
  }
  let expr = String(q);
  // 0 and 1 need no hops at all; give them a spelling anyway so the expansion
  // is never the bare literal it replaced
  if (q < 2) expr = `(${1 + Math.floor(ctx.rng() * 251)}*0+${expr})`;
  for (let i = hops.length - 1; i >= 0; i--) {
    const mul = hops[i][1];
    const rem = hops[i][2];
    const lhs = ctx.rng() < 0.5 ? `${expr}*${mul}` : `${mul}*${expr}`;
    expr = `(${lhs}+${rem})`;
  }
  return expr;
}

function eatNumber(argText, ctx) {
  let node = parseExpr(argText.trim(), "EAT_NUMBER", ctx.line);
  // `-7` arrives as unary minus over a literal; that is still a number literal
  let negated = false;
  while (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    if (node.operator === "-") negated = !negated;
    node = node.argument;
  }
  if (node.type !== "NumericLiteral") throw new Error(`EAT_NUMBER on line ${ctx.line} expects a number literal`);
  const v = negated ? -node.value : node.value;
  if (!Number.isFinite(v)) throw new Error(`EAT_NUMBER on line ${ctx.line}: ${v} cannot be encoded`);

  const sign = v < 0 || Object.is(v, -0) ? -1 : 1;
  const abs = Math.abs(v);
  const whole = Math.trunc(abs);
  const frac = abs - whole;

  const expr = intHops(whole, ctx);

  // the sign is applied last and by one of two spellings, so a negative number
  // does not always resemble the positive one with a `*` glued on
  const core = sign < 0 ? (ctx.rng() < 0.5 ? `(0-${expr})` : `(${expr}*-1)`) : expr;
  if (frac === 0) return core;
  // the fractional tail has to stay a literal: it is the part a binary float
  // cannot be rebuilt into by integer arithmetic
  return sign < 0 ? `(${core}-${frac})` : `(${core}+${frac})`;
}

/* ------------------------------------------------------------------ */
/* EAT_FUNCTION                                                        */
/* ------------------------------------------------------------------ */

/** rewrite every string and number literal in `text`, leaving the rest alone */
function protectText(text, ctx) {
  const out = [];
  const n = text.length;
  let i = 0;
  let delta = 0; // lines consumed so far, for error messages

  while (i < n) {
    const c = text[i];
    const line = ctx.line + countNewlines(text, 0, i);

    if (c === "-" && text[i + 1] === "-") {
      const end = commentEnd(text, i);
      out.push(text.slice(i, end));
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`" || (c === "[" && (text[i + 1] === "[" || text[i + 1] === "="))) {
      const end = stringEnd(text, i);
      out.push(eatString(text.slice(i, end), { ...ctx, line }));
      i = end;
      continue;
    }

    const prev = i > 0 ? text[i - 1] : "";
    if (/[0-9]/.test(c) && !isIdentChar(prev) && prev !== "." ) {
      const end = numberEnd(text, i);
      out.push(eatNumber(text.slice(i, end), { ...ctx, line }));
      i = end;
      continue;
    }

    out.push(c);
    i++;
  }
  void delta;
  return out.join("");
}

function eatFunction(argText, ctx) {
  const body = argText.trim();
  const node = parseExpr(body, "EAT_FUNCTION", ctx.line);
  if (node.type !== "FunctionDeclaration") throw new Error(`EAT_FUNCTION on line ${ctx.line} expects a function literal`);
  const protectedBody = protectText(body, ctx);
  const key = 1 + Math.floor(ctx.rng() * 0x7ffffff);
  // the key is spelled twice on purpose and both spellings rebuild the same
  // number, so the constant never appears in the artifact even once
  const k = intHops(key, ctx);
  if (ctx.rng() < 0.5) return `({[${k}]=${protectedBody}})[${k}]`;
  return `(function(t,k)return t[k]end)({[${k}]=${protectedBody}},${k})`;
}

/* ------------------------------------------------------------------ */
/* EAT_RAGEBAIT                                                        */
/* ------------------------------------------------------------------ */

function eatRagebait(argText, ctx) {
  const trimmed = argText.trim();
  let message = TAUNT;
  if (trimmed.length) {
    const node = parseExpr(trimmed, "EAT_RAGEBAIT", ctx.line);
    if (node.type === "StringLiteral" && node.value.length) message = node.value;
  }
  const built = eatString(JSON.stringify(message), ctx);
  return `(function(m)print(m)while true do end end)(${built})`;
}

/* ------------------------------------------------------------------ */
/* expansion                                                           */
/* ------------------------------------------------------------------ */

const HANDLERS = {
  EAT_STRING: eatString,
  EAT_NUMBER: eatNumber,
  EAT_FUNCTION: eatFunction,
  EAT_RAGEBAIT: eatRagebait,
};

/**
 * True when the macro call is the first thing on its line (or follows a `;`).
 * An expansion that begins with `(` there has to be separated from the
 * statement above it, or Lua reads the parens as an argument list for the
 * previous statement's last call.
 */
function atStatementStart(src, i) {
  let p = i - 1;
  while (p >= 0 && /[ \t\r]/.test(src[p])) p--;
  if (p < 0) return true;
  if (src[p] === ";") return true;
  return src[p] === "\n";
}

/**
 * True when the statement above could still swallow a leading `(` — it ends
 * in a value rather than in a separator. `;` is not a statement of its own in
 * Lua 5.1, so it may only be inserted where a statement already ended: at the
 * top of the chunk or right after `do` / `then` / `else` it would be a syntax
 * error instead of a guard.
 */
function needsSemi(src, i) {
  let p = i - 1;
  while (p >= 0 && /[ \t\r\n]/.test(src[p])) p--;
  if (p < 0) return false;
  const c = src[p];
  if (c === "'" || c === '"') return true;
  if (!/[A-Za-z0-9_)\]]/.test(c)) return false;
  const word = (src.slice(0, p + 1).match(/([A-Za-z_][A-Za-z0-9_]*)$/) || [])[1] || "";
  return !/^(do|then|else|repeat|end|return|in)$/.test(word);
}

function expandOnce(source, rng, depth, stats) {
  const src = source;
  const out = [];
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
      copyTo(commentEnd(src, i));
      continue;
    }
    if (c === '"' || c === "'" || c === "`" || (c === "[" && (src[i + 1] === "[" || src[i + 1] === "="))) {
      copyTo(stringEnd(src, i));
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentChar(src[j])) j++;
      const name = src.slice(i, j);

      let k = j;
      while (k < n && /[ \t\r\n]/.test(src[k])) k++;
      const isCall = k < n && src[k] === "(";
      let prev = i - 1;
      while (prev >= 0 && /[ \t\r\n]/.test(src[prev])) prev--;
      const isField = prev >= 0 && (src[prev] === "." || src[prev] === ":");

      if (CALLS.has(name) && isCall && !isField) {
        const close = parenEnd(src, k);
        if (close < 0) throw new Error(`${name} on line ${line} is never closed`);
        const args = src.slice(k + 1, close - 1);
        const callLine = line;

        // a nested call inside the argument is expanded before this one runs
        const inner = depth < 6 ? expandOnce(args, rng, depth + 1, stats) : args;
        const innerLine = callLine + countNewlines(src, i, k + 1);

        const text = HANDLERS[name](inner, { src, pos: i, line: innerLine, rng });
        stats.sites++;
        if (name === "EAT_STRING") stats.strings++;
        else if (name === "EAT_NUMBER") stats.numbers++;
        else if (name === "EAT_FUNCTION") stats.functions++;
        else stats.baits++;

        // the call itself is replaced, not copied
        line += countNewlines(src, i, close);
        out.push(text[0] === "(" && atStatementStart(src, i) && needsSemi(src, i) ? ";" + text : text);
        i = close;
        continue;
      }

      copyTo(j);
      continue;
    }

    out.push(c);
    if (c === "\n") line++;
    i++;
  }

  return out.join("");
}

/**
 * Expand every `EAT_*` call in `source`.
 *
 * @param {string} source Lua / Luau text as written by the author
 * @param {{rng?: () => number}} [options] seeded source of per-site keys
 * @returns {{code:string, stats:object}}
 */
function expand(source, options = {}) {
  const stats = { sites: 0, strings: 0, numbers: 0, functions: 0, baits: 0 };
  const rng = options.rng || (() => 0.5);
  const code = expandOnce(String(source == null ? "" : source), rng, 0, stats);
  return { code, stats };
}

module.exports = { expand, CALLS, TAUNT };
