"use strict";

/**
 * Luau-only compression pass.
 *
 * Everything here is a *strict* rewrite: the artifact means exactly the same
 * thing, it just uses Luau's surface syntax instead of the Lua 5.1 spelling.
 * It is therefore only applied when the build targets Luau (`target: "luau"`,
 * the default); `target: "portable"` keeps the 5.1 spelling.
 *
 *   compound assignment   a = a + b        ->  a += b        (also -= *= /= %= ^= ..= //=)
 *   floor division        (a - a % b) / b  ->  a // b
 *
 * Both rewrites are text-identical in their operands, so the number of side
 * effects is unchanged:
 *   - `a = a <op> b` evaluates `a` twice in Lua 5.1 (once read, once written)
 *     and once in Luau, which is only observable for a table target.
 *     Therefore the target must be a plain name, never `t[k]` or `t.k`.
 *   - `(x - x % y) / y` reads `x` and `y` twice; `x // y` reads them once.
 *     Identical text on both sides keeps that legal.
 */

const COMPOUND_OPS = ["//", "..", "+", "-", "*", "/", "%", "^"];

function isIdentChar(c) {
  return c !== undefined && /[0-9A-Za-z_]/.test(c);
}

function inForHeader(src, at) {
  const back = src.slice(Math.max(0, at - 24), at);
  return /\bfor\s+$/.test(back);
}

/** a = a + b  ->  a += b */
function compoundAssign(src) {
  const text = String(src);
  const re = /([A-Za-z_][A-Za-z0-9_]*)=\1\s*/g;
  let out = "";
  let last = 0;
  let m;
  let count = 0;

  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const start = m.index;
    const before = start > 0 ? text[start - 1] : "";
    // `t.a = a + 1` and `x..a=a+1` must not be touched; neither must a for header
    if (isIdentChar(before) || before === "." || before === ":") continue;
    if (inForHeader(text, start)) continue;

    const rest = text.slice(re.lastIndex);
    const op = COMPOUND_OPS.find((o) => rest.startsWith(o));
    if (!op) continue;
    // `a = a - -1` would become `a -= -1`: legal, but the whitespace rules get
    // fragile, so leave anything that starts a second sign alone
    if (/^\s*-/.test(rest.slice(op.length))) continue;

    out += text.slice(last, start) + name + op + "=";
    last = re.lastIndex + op.length;
    re.lastIndex = last;
    count++;
  }

  out += text.slice(last);
  return { code: count ? out : text, count };
}

/** (x - x % y) / y  ->  x // y */
function floorDiv(src) {
  const text = String(src);
  const re = /\(((?:[A-Za-z_][A-Za-z0-9_]*)(?:\[(?:0x[0-9A-Fa-f]+|[0-9]+)\])?)-\1%((?:[A-Za-z_][A-Za-z0-9_]*)(?:\[(?:0x[0-9A-Fa-f]+|[0-9]+)\])?)\)\/\2/g;
  let count = 0;
  const code = text.replace(re, (match, a, b) => {
    count++;
    return `${a}//${b}`;
  });
  return { code: count ? code : text, count };
}

/** apply every Luau-only rewrite; returns { code, stats } */
function luauCompress(src) {
  const first = compoundAssign(src);
  const second = floorDiv(first.code);
  return {
    code: second.code,
    stats: { compound: first.count, floorDiv: second.count, saved: String(src).length - second.code.length },
  };
}

module.exports = { luauCompress, compoundAssign, floorDiv };
