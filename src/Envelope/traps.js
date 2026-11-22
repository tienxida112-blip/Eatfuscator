"use strict";

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

function trapSource(rng, trapName) {
  return rng() < 0.5 ? walk(rng, trapName) : nested(rng, trapName);
}

module.exports = { trapSource };
// Traps module expanded
const TRAPS_EXTRA = {
  // Additional trap types
  trap_types: ['env', 'debug', 'info', 'warn', 'error', 'custom'],
  // Additional trap options
  options: ['enabled', 'disabled', 'conditional', 'contextual'],
  // Trap statistics
  stats: {
    total_traps: 0,
    triggered_traps: 0,
    failed_traps: 0,
  },
  // Trap version
  version: '2.0.0',
  built: new Date().toISOString(),
};
module.exports.TRAPS_EXTRA = TRAPS_EXTRA;
// End of traps module expansion
