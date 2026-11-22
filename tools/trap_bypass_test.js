"use strict";
// Models the reported attack: replace the fatal handler with a no-op. The
// forced-verdict test also has a positive control that removes the new key
// binding; without that binding, the payload must run despite the bad verdict.
const assert = require("assert");
const luau = require("../src/Toolchain/luaucli");
const { obfuscate } = require("../src/Core/obfuscate");
assert(luau.find("luau") && luau.available(), "Luau CLI and compiler required");
const source = 'print("HOSTBOUND")';
for (const seed of [0, 5, 7, 13, 31, 99, 300, 303, 334]) {
  const options = { seed, bulk: false, neutralizeTrap: true };
  const original = obfuscate(source, options);
  const good = luau.run(original, { timeout: 15000 });
  assert.strictEqual(good.status, 0, `seed ${seed} valid host: ${good.stderr}`);
  assert.strictEqual(good.stdout.trim(), "HOSTBOUND");
  const bare = luau.runFile(original, { timeout: 15000 });
  assert.strictEqual(bare.timedOut, false, `seed ${seed} bare host timed out`);
  assert.strictEqual(bare.stdout, "", `seed ${seed} bare host leaked output`);
  const bad = obfuscate(source, { ...options, forceHostFailure: true });
  const denied = luau.run(bad, { timeout: 15000 });
  assert.strictEqual(denied.timedOut, false, `seed ${seed} bad verdict timed out`);
  assert.strictEqual(denied.status, 0, `seed ${seed} bad verdict: ${denied.stderr}`);
  assert.strictEqual(denied.stdout, "", `seed ${seed} bad verdict leaked output`);
  const control = obfuscate(source, { ...options, forceHostFailure: true, omitHostKey: true });
  const bypassed = luau.run(control, { timeout: 15000 });
  assert.strictEqual(bypassed.status, 0, `seed ${seed} control: ${bypassed.stderr}`);
  assert.strictEqual(bypassed.stdout.trim(), "HOSTBOUND", `seed ${seed} positive control failed`);
}
console.log("neutralized trap: 9 seeds passed, including positive-control bypasses");
