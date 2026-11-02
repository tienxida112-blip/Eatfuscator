"use strict";

/**
 * Identifier family — dsc.gg/eatfuscator
 *
 * Every name the build emits (template tokens, flattened blocks, hoisted
 * locals) is drawn from one alphabet of shape-confusable ASCII glyphs:
 *
 *   l  I  O  0  o  i  1  _
 *
 * These are the characters that already look like each other in a monospace
 * font, so a name reads as texture instead of as a word, and two different
 * names in the same expression give the eye nothing to hold on to. They are
 * also plain ASCII, which matters: the artifact still has to lex in every Lua
 * 5.1 / Luau host, and both treat bytes outside ASCII as either letters or
 * errors depending on locale. A single `l`/`I`/`1` alphabet keeps that
 * question from ever being asked.
 *
 * No keyword can be built out of this set, and no English word can either —
 * the only letters are l, i and o (upper and lower).
 *
 * Names are 2..5 characters and unique per build, which is what makes the
 * other obfuscators this one is measured against look the way they do: dense,
 * short, and impossible to skim. It also shrinks the artifact by a wide margin
 * against the `_0x` + hex family it replaces, because a token like `Il0` is
 * paid for in every one of its uses.
 */

const ALPHABET = "lIO0oi1_";
const LEAD = "lIOoi_"; // never open a name with a digit
const NAME_SRC = "[lIOoi_][lIO0oi1_]{1,4}";
const NAME_RE = new RegExp("^" + NAME_SRC + "$");

// names that would shadow something a host actually exposes as a global
const BLOCKED = new Set(["io"]);

/**
 * Unique name generator for one build. Length is drawn per name so the family
 * has no recognisable width: 2 to 5 glyphs, most of them 3 or 4.
 */
function makeNameFactory(rng) {
  const used = new Set();
  return function name() {
    for (let attempt = 0; attempt < 65536; attempt++) {
      const r = rng();
      const len = r < 0.22 ? 2 : r < 0.62 ? 3 : r < 0.92 ? 4 : 5;
      let n = LEAD[(rng() * LEAD.length) | 0];
      for (let k = 1; k < len; k++) n += ALPHABET[(rng() * ALPHABET.length) | 0];
      if (BLOCKED.has(n) || used.has(n)) continue;
      used.add(n);
      return n;
    }
    throw new Error("identifier space exhausted");
  };
}

function isFamily(name) {
  return NAME_RE.test(name);
}

module.exports = { ALPHABET, LEAD, NAME_SRC, NAME_RE, makeNameFactory, isFamily };
