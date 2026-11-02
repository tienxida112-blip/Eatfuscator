"use strict";

/**
 * Shared registry for the compiler phases.
 *
 * The compiler is one mutually recursive pass: statements emit expressions,
 * expressions open closures, closures emit statements. Node cannot require in
 * a cycle, so every phase publishes its functions here and calls its siblings
 * through this object. `index.js` loads the phases in order; nothing calls
 * into the registry before that has happened.
 */

module.exports = {};
