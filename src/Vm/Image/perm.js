"use strict";

function encode(order) {
  const n = order.length;
  const remaining = [];
  for (let i = 0; i < n; i++) remaining.push(i);
  let code = 0;
  for (let i = 0; i < n; i++) {
    const at = remaining.indexOf(order[i]);
    if (at < 0) throw new Error("permutation: not a permutation");
    code = code * (n - i) + at;
    remaining.splice(at, 1);
  }
  return code;
}

function decode(code, n) {
  const digits = new Array(n);
  let c = code;
  for (let i = n - 1; i >= 0; i--) {
    const radix = n - i;
    digits[i] = c % radix;
    c = (c - digits[i]) / radix;
  }
  if (c !== 0) throw new Error("permutation: code out of range");
  const remaining = [];
  for (let i = 0; i < n; i++) remaining.push(i);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = remaining[digits[i]];
    remaining.splice(digits[i], 1);
  }
  return out;
}

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

function shuffle(n, rng) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

module.exports = { encode, decode, factorial, shuffle };
