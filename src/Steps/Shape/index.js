"use strict";

const { whileToRepeat, shapeCensus } = require("./loops");
const { weakNames, strongNameRatio } = require("./names");

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
