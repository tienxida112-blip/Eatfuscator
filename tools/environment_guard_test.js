"use strict";
// A transparent wrapper installed after capture must stop; updating both the
// wrapper and expected reference is the positive-control bypass.
const assert = require("assert");
const {obfuscate} = require("../src/Core/obfuscate");
const luau = require("../src/Toolchain/luaucli");
for (const seed of [0, 1, 5, 7, 13, 31, 99, 303]) {
  const src = 'print("ENV_GUARD_PAYLOAD")';
  const options = {seed, bulk: false};
  const normal = luau.run(obfuscate(src, options), {timeout: 30000});
  assert.strictEqual(normal.status, 0, `normal ${seed}: ${normal.stderr}`);
  assert(normal.stdout.includes("ENV_GUARD_PAYLOAD"));
  const hooked = luau.run(obfuscate(src, {...options, dispatchProbe: "env-hook"}), {timeout: 30000});
  assert.notStrictEqual(hooked.status, 0, `hook accepted for ${seed}`);
  assert(!hooked.stdout.includes("ENV_GUARD_PAYLOAD"));
  const bypass = luau.run(obfuscate(src, {...options, dispatchProbe: "env-coordinated"}), {timeout: 30000});
  assert.strictEqual(bypass.status, 0, `coordinated ${seed}: ${bypass.stderr}`);
  assert(bypass.stdout.includes("ENV_GUARD_PAYLOAD"));
}
console.log("environment guard: 8 seeds; post-snapshot wrapper stopped, coordinated baseline patch passed");
