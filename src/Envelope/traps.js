"use strict";

/**
 * Hidden trip-wires.
 *
 * The old trap was a literal `while true do error("...") end`: two lines into
 * the file anyone could see the anti-tamper, delete it, and the artifact would
 * run with the payload patched. The message string was plaintext on top of
 * that.
 *
 * A trap is now a *bounded-looking checksum walk* that is never expected to be
 * called: no `while`, no `repeat`, no string literal, no message, no obvious
 * `true`. It reads as one more fingerprint loop sitting next to the real ones,
 * but its bounds are astronomically large, so a tripped build stalls forever
 * and never prints anything. (Luau has no proper tail calls — a recursive
 * trip-wire dies with a stack overflow instead of hanging, which is why this
 * shape is a loop rather than self-recursion.)
 *
 * Names are emitted as `__V####__` tokens so the normal identifier pass renames
 * them exactly like the rest of the template.
 */

const TOKEN_MIN = 410;
const TOKEN_MAX = 879;

function pick(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function hex(rng, digits) {
  const v = 0x1000 + Math.floor(rng() * 0xefff);
  return "0x" + v.toString(16).toUpperCase().padStart(digits, "0");
}

function freshTokens(rng, count, used) {
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < 500) {
    const t = `__V${pick(rng, TOKEN_MIN, TOKEN_MAX)}__`;
    if (used.has(t)) continue;
    used.add(t);
    out.push(t);
  }
  if (out.length < count) throw new Error("trap generator ran out of token names");
  return out;
}

const HUGE = ["0x5FFFFFFFFFFFF", "0x2FFFFFFFFFFFF", "0x7FFFFFFFFFFF", "0x3FFFFFFFFFFFF"];

function huge(rng) {
  return HUGE[Math.floor(rng() * HUGE.length)];
}

/** single bounded-looking walk with an unreachable exit */
function walk(rng, trapName) {
  const [a, b, c, i] = freshTokens(rng, 4, new Set([trapName]));
  const mod = hex(rng, 6);
  const key = hex(rng, 5);
  const seed = hex(rng, 3);
  const span = huge(rng);
  return [
    `local ${trapName}`,
    `${trapName}=function(${a},${b})`,
    `${a},${b}=${seed},${key}`,
    `for ${i}=${a},${span} do`,
    `local ${c}=(${a}+${b})%${mod}`,
    `${b}=(${c}+${i}%${key})%${mod}`,
    `${a}=${c}+${b}-${b}`,
    `end`,
    `return ${trapName}(${a},${b})`,
    `end`,
  ].join(" ");
}

/** nested walks: the inner bound is recomputed so it never runs out */
function nested(rng, trapName) {
  const [a, b, c, i, j] = freshTokens(rng, 5, new Set([trapName]));
  const mod = hex(rng, 6);
  const key = hex(rng, 5);
  const seed = hex(rng, 3);
  const span = huge(rng);
  return [
    `local ${trapName}`,
    `${trapName}=function(${a},${b})`,
    `${a},${b}=${seed},${key}`,
    `for ${i}=${a},${span} do`,
    `local ${c}=(${a}+${b})%${mod}`,
    `for ${j}=${c},${span} do`,
    `${b}=(${c}+${j}%${key})%${mod}`,
    `end`,
    `${a}=${c}+${b}-${b}`,
    `end`,
    `return ${trapName}(${a},${b})`,
    `end`,
  ].join(" ");
}

/**
 * Definition of `trapName`: a callable that never returns and never raises.
 * `rng` is the build's deterministic RNG so a seed reproduces the artifact.
 */
function trapSource(rng, trapName) {
  return rng() < 0.5 ? walk(rng, trapName) : nested(rng, trapName);
}

module.exports = { trapSource };
