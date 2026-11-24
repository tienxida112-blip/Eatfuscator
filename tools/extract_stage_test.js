"use strict";
const assert = require("assert");
const { obfuscate } = require("../src/Core/obfuscate");
const { loaderText } = require("../src/Envelope/wrap");
const { extract } = require("./extract_stage");
for (const seed of [0, 1, 5, 7, 8, 13, 31, 99, 300, 334]) {
  const artifact = obfuscate('print("Hello, World!")', { seed });
  const expected = Buffer.from(loaderText(), "latin1");
  const recovered = extract(artifact);
  assert(recovered.equals(expected), `seed ${seed}: extracted loader mismatch`);
  assert(recovered.length > 1024 * 1024, `seed ${seed}: loader too small`);
  assert(!/loadstring|load\(/.test(artifact), `seed ${seed}: forbidden literal`);
}
assert.throws(() => extract("not an artifact"), /not found/);
console.log("outer extraction: 10 padded builds recovered exactly");
