"use strict";
const assert = require("assert");
const crypto = require("crypto");
const luau = require("../src/Toolchain/luaucli");
const { obfuscate } = require("../src/Core/obfuscate");
const wrap = require("../src/Envelope/wrap");
assert(luau.available(), "luau-compile is required for this test");
const compile = luau.fullCompile;
const rand = crypto.randomBytes;
try {
  let calls = 0, seedsDrawn = 0;
  crypto.randomBytes = (n) => { assert.strictEqual(n, 4); seedsDrawn++; return Buffer.from([7, 0, 0, 0]); };
  luau.fullCompile = (code, options) => {
    calls++;
    if (calls === 1) return { ok: false, error: "CompileError: Out of local registers: exceeded limit 200" };
    return compile(code, options);
  };
  const artifact = obfuscate('print("Hello, World!")', { seed: "random", bulk: false });
  assert.strictEqual(seedsDrawn, 1, "retry must reuse the same random seed");
  assert(calls >= 2, "retry was not reached");
  assert(/==nil then break end/.test(wrap.loaderText()), "flattening was silently disabled");
  const run = luau.run(artifact, { timeout: 60000 });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.strictEqual(run.stdout.trim(), "Hello, World!");
  calls = 0;
  const same = obfuscate('print("Hello, World!")', { seed: 7, bulk: false });
  assert.strictEqual(artifact, same, "replaying the printed seed must reproduce retries");
  // Non-register failures should not be hidden by retries.
  calls = 0;
  luau.fullCompile = () => { calls++; return { ok: false, error: "syntax error marker" }; };
  assert.throws(() => obfuscate('print("x")', { seed: 7, bulk: false }), /syntax error marker/);
  assert.strictEqual(calls, 1);
  console.log("compile guard: seed retention, retry, flattening, output and error handling passed");
} finally {
  luau.fullCompile = compile;
  crypto.randomBytes = rand;
}
