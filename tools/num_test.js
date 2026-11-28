"use strict";
const assert = require("assert");
const { expand } = require("../src/Steps/Macro");
const { createRNG } = require("../src/Core/rng");
const { obfuscate } = require("../src/Core/obfuscate");
const cipher = require("../src/Vm/Image/cipher");
const luau = require("../src/Toolchain/luaucli");
const literals = ["0", "-0", "1", "-1", "1200", "0.1", "-2.5", "1e15", "1e-10", "0x1234", "9007199254740991", "1.7976931348623157e308", "5e-324"];
const source = `if not EAT_OBFUSCATED then function EAT_NUMBER(x) return x end end\n` + literals.map((n,i) => `local n${i} = EAT_NUMBER(${n})\nprint(${i}, string.format("%.17g", n${i}), 1/n${i})`).join("\n");
// At the same prototype and pool position, number text and string text use
// the identical constant cipher, rather than a separate arithmetic disguise.
for (const n of ["1200", "-2.5", "1e-10"]) {
  const keys = {k1: 1234567, k2: 7654321, salt: 998877};
  const make = (entry) => ({k:[entry],child:[]});
  const number = make({t:"number",v:n}), string = make({t:"string",v:n});
  cipher.encryptConstants(number, keys); cipher.encryptConstants(string, keys);
  assert.strictEqual(number.k[0].v, string.k[0].v);
  assert.notStrictEqual(number.k[0].v, n);
}
const ref = luau.run(source, {timeout:60000});
assert.strictEqual(ref.status,0,ref.stderr);
for (const seed of [0,1,5,7,13,31,99]) {
  const expanded = expand(source,{rng:createRNG(seed)}).code;
  assert(expanded.includes('tonumber("1200")'));
  assert.throws(() => expand('EAT_NUM(1)', {rng:createRNG(seed)}), /not a macro/i);
  const plain = luau.run(expanded,{timeout:60000});
  assert.strictEqual(plain.status,0,plain.stderr);
  assert.strictEqual(plain.stdout,ref.stdout,`expansion seed ${seed}`);
  const artifact = obfuscate(source,{seed,bulk:false});
  const actual = luau.run(artifact,{timeout:60000});
  assert.strictEqual(actual.status,0,actual.stderr);
  assert.strictEqual(actual.stdout,ref.stdout,`VM seed ${seed}`);
}
console.log(`number macro: ${literals.length} boundary values x 7 seeds, expanded and VM`);
