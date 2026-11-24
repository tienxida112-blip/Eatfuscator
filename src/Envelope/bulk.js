"use strict";

// Decoy bulk.
//
// The artifact used to be as small as the payload allowed, and small is what a
// reader wants: less to diff, fewer bytes to fingerprint. The balance asked for
// now is the other way round - a shipped file around a hundred kilobytes that
// unpacks into more than a megabyte of code. That changes what an analyst has to
// work through by an order of magnitude, and it adds load-time overhead even though
// none of it is executed: it is a closure the loader builds and never calls.
//
// Two textures, mixed:
//   dense - decoy statements built from a small pool of names and a couple of
//           shapes, so it looks like the rest of the loader and deflates very
//           well (~165:1 on its own);
//   noisy - numeric banks, which is what the real artifact is full of and which
//           deflate badly (~2.5:1).
//
// The mix is what decides the ratio, and the ratio is what decides whether a
// hundred-kilobyte file can unpack into more than a megabyte. `tune` measures the
// real deflate result and walks the mix and the size until both targets are met,
// instead of hard-coding a constant that goes stale the next time the loader
// grows.

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function denseBlock(rng, chars) {
  const names = [];
  for (let i = 0; i < 28; i++) {
    names.push(safeName(rng, 3));
  }
  // Every shape is scoped: a function may hold two hundred locals in Luau, and a
  // megabyte of `local` lines in one scope would not compile at all. Inside `do`
  // blocks the registers are reused, and the whole thing is a closure the loader
  // never calls anyway - it is there to be read, diffed and stepped through.
  const shapes = [
    (a, b, c) => `do local ${a}=${b} local ${c}=${a}*3+${b} if ${c}>${b} then ${a}=${c} else ${a}=${b} end end `,
    (a, b, c) => `do local ${b},${c}=${a}+1,${a}-1 while ${c}<${b} do ${c}=${c}+2 end end `,
    (a, b, c) => `do local ${a}={${b},${c},${b},${c}} ${c}=#${a} if ${c}==4 then ${b}=${a}[1] end end `,
    (a, b, c) => `do local ${a}=${b} repeat ${a}=${a}+${c} until ${a}>${b} end `,
  ];
  const out = [];
  let len = 0;
  let i = 0;
  while (len < chars) {
    const a = names[i % names.length];
    const b = names[(i * 7 + 3) % names.length];
    const c = names[(i * 13 + 5) % names.length];
    const line = shapes[i % shapes.length](a, b, c);
    out.push(line);
    len += line.length;
    i++;
  }
  return out.join("");
}

// Two-letter names drawn at random are not safe as identifiers: "do", "if" and
// "or" are all two letters, and `local do={...}` is a syntax error. (It was, in
// the first build of this file.)
const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto",
  "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
]);

function safeName(rng, len) {
  for (let attempt = 0; attempt < 200; attempt++) {
    let n = LETTERS[(rng() * 26) | 0];
    for (let k = 1; k < len; k++) n += LETTERS[(rng() * 26) | 0];
    if (!KEYWORDS.has(n)) return n;
  }
  return "zq";
}

function noisyBlock(rng, chars) {
  const names = [];
  for (let i = 0; i < 26; i++) names.push(safeName(rng, 2));
  const out = [];
  let len = 0;
  const word = () => String(((rng() * 16777216) | 0));
  while (len < chars) {
    // An assignment, not a bare constructor: this has to parse as a statement.
    const line = `do local ${names[(len / 97) | 0] || "b"}={${word()},${word()},${word()},${word()}} end `;
    out.push(line);
    len += line.length;
  }
  return out.join("");
}

function build(rng, { chars, denseFraction }) {
  const dense = Math.floor(chars * denseFraction);
  const noisy = Math.max(0, Math.floor(chars) - dense);
  // Both textures are emitted as scoped statements.
  const denseText = denseBlock(rng, dense);
  const noisyText = noisyBlock(rng, noisy);
  return denseText + noisyText;
}

// Walk the mix and the size until the deflated payload lands near
// `targetCompressed` and the source-form payload is at least `minUncompressed`.
// Both targets pull in opposite directions - more bulk means a bigger packed file,
// a denser mix means a smaller one - so the loop moves whichever is out of range.
function tune({ make, deflate, loaderText, targetCompressed, minUncompressed, maxRounds = 12 }) {
  // Keep the expanded size above the floor, then binary-search the entropy mix.
  // For very large inputs the original loader alone may exceed the size budget.
  const chars = Math.max(32 * 1024, minUncompressed - loaderText.length + 20000);
  let low = 0, high = 1, best = null;
  for (let round = 0; round < maxRounds; round++) {
    const denseFraction = (low + high) / 2;
    const bulk = make(chars, denseFraction);
    const inner = loaderText + bulk;
    const packed = deflate(Buffer.from(inner, "utf8")).length;
    const score = Math.abs(packed - targetCompressed) / targetCompressed;
    if (!best || score < best.score) best = { bulk, inner, packed, score, denseFraction, chars };
    if (score < 0.012) break;
    if (packed > targetCompressed) low = denseFraction; else high = denseFraction;
  }
  return best;
}

// Always tune from the actual loader. Sharing a cached plan across different
// builds makes output depend on build history rather than just the seed.
function forLoader({ make, deflate, loaderText, targetCompressed, minUncompressed }) {
  const plan = tune({ make, deflate, loaderText, targetCompressed, minUncompressed });
  if (!plan || plan.inner.length < minUncompressed)
    throw new Error("bulk: could not meet size targets");
  return { bulk: plan.bulk, packed: plan.packed };
}

module.exports = { build, tune, forLoader, denseBlock, noisyBlock, safeName };
