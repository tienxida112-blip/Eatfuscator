"use strict";

/**
 * Shape — dsc.gg/eatfuscator
 *
 * The last source-level pass before the payload is frozen. Everything before
 * this point decides what the artifact *does*; this step decides what it still
 * *looks* like when someone opens it in an editor:
 *
 *   loops.js  every `while <cond> do … end` is re-spelled as a `repeat`, so the
 *             generated text stops advertising loop heads and their tests
 *   names.js  every identifier it lexes is checked against the build's opaque
 *             name space; anything short or readable is reported
 *
 * The pass is safe by construction: it works on a 5.1 parse of the generated
 * code, rewrites only loops whose meaning provably survives the rewrite, and
 * returns the text unchanged if it cannot parse at all.
 */

const { whileToRepeat, shapeCensus } = require("./loops");
const { weakNames, strongNameRatio } = require("./names");

/**
 * @param {string} code generated Lua (pre-Luau-sugar, pre-minify)
 * @returns {{code:string, stats:object}}
 */
function shapeArtifact(code) {
  const before = shapeCensus(code);
  const shaped = whileToRepeat(code);
  const after = shaped.reason ? before : shapeCensus(shaped.code);

  const weak = weakNames(shaped.code);

  return {
    code: shaped.code,
    stats: {
      loops: shaped.rewritten,
      skipped: shaped.skipped,
      whileLeft: after.while || 0,
      repeat: after.repeat || 0,
      forNumeric: after.forNumeric || 0,
      forGeneric: after.forGeneric || 0,
      strongNames: strongNameRatio(shaped.code),
      weakNames: weak.length,
      reason: shaped.reason,
    },
  };
}

module.exports = { shapeArtifact, whileToRepeat, shapeCensus, weakNames };
