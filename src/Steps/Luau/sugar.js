"use strict";

const COMPOUND_OPS = ["//", "..", "+", "-", "*", "/", "%", "^"];

function isIdentChar(c) {
  return c !== undefined && /[0-9A-Za-z_]/.test(c);
}

function inForHeader(src, at) {
  const back = src.slice(Math.max(0, at - 24), at);
  return /\bfor\s+$/.test(back);
}

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

    if (isIdentChar(before) || before === "." || before === ":") continue;
    if (inForHeader(text, start)) continue;

    const rest = text.slice(re.lastIndex);
    const op = COMPOUND_OPS.find((o) => rest.startsWith(o));
    if (!op) continue;

    if (/^\s*-/.test(rest.slice(op.length))) continue;

    out += text.slice(last, start) + name + op + "=";
    last = re.lastIndex + op.length;
    re.lastIndex = last;
    count++;
  }

  out += text.slice(last);
  return { code: count ? out : text, count };
}

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

function luauCompress(src) {
  const first = compoundAssign(src);
  const second = floorDiv(first.code);
  return {
    code: second.code,
    stats: { compound: first.count, floorDiv: second.count, saved: String(src).length - second.code.length },
  };
}

module.exports = { luauCompress, compoundAssign, floorDiv };
