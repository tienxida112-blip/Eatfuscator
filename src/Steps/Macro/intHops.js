"use strict";

/**
 * intHops — rewrite one numeric literal as an arithmetic expression that
 * evaluates to *exactly* the same number.
 *
 * Rules that keep it lossless:
 *   - integers: (v * m) / m + k - k with integer m, k. v*m stays below 2^53 for
 *     every value the compiler can emit, and dividing by m is exact because
 *     v*m is an exact multiple of m.
 *   - non-integers: only powers of two are used, where scaling is exact in
 *     binary floating point (no rounding, no drift).
 *
 * Every draw comes from the injected seeded rng — Math.random() is never used,
 * so two builds of the same source with the same seed are byte-identical.
 */

const MAX_EXACT_INT = 0x1fffffffffff; // 2^45: v * 63 still fits in 2^53

function numText(n) {
  if (Object.is(n, -0)) return "-0";
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

function intHops(value, ctx) {
  const rng = ctx && ctx.rng;
  if (typeof rng !== "function") throw new Error("intHops: a seeded rng is required");
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`intHops: ${value} is not a finite number`);
  }

  const negative = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);
  let core;

  if (Number.isInteger(abs) && abs <= MAX_EXACT_INT) {
    const m = 2 + Math.floor(rng() * 62); // 2..63
    const k = 1 + Math.floor(rng() * 65000); // 1..65000
    switch (Math.floor(rng() * 3)) {
      case 0:
        core = `(((${numText(abs)} * ${m}) / ${m} + ${k}) - ${k})`;
        break;
      case 1:
        core = `(((${numText(abs)} + ${k}) - ${k}) * ${m} / ${m})`;
        break;
      default:
        core = `(((${numText(abs)} * ${m}) / ${m}) + (${k} - ${k}))`;
        break;
    }
  } else {
    const scales = [2, 4, 8, 16];
    const p = scales[Math.floor(rng() * scales.length)];
    core = `((${numText(abs)} * ${p}) / ${p})`;
  }

  return negative ? `(0 - ${core})` : core;
}

module.exports = { intHops, numText, MAX_EXACT_INT };
