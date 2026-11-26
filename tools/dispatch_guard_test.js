"use strict";
// Model narrow post-decode edits, plus a coordinated edit of the compared word.
const assert = require("assert");
const {obfuscate} = require("../src/Core/obfuscate");
const luau = require("../src/Toolchain/luaucli");
const source = 'print("DISPATCH_PAYLOAD")';
for (const seed of [0, 1, 5, 7, 13, 31, 99, 303]) {
  const opts = {seed, bulk: false};
  const clean = luau.run(obfuscate(source, opts), {timeout: 30000});
  assert.strictEqual(clean.status, 0, `seed ${seed} clean: ${clean.stderr}`);
  assert(clean.stdout.includes("DISPATCH_PAYLOAD"));
  for (const dispatchProbe of ["opcode", "operand", "fake-env"]) {
    const run = luau.run(obfuscate(source, {...opts, dispatchProbe}), {timeout: 30000});
    assert.notStrictEqual(run.status, 0, `seed ${seed} ${dispatchProbe}: was not stopped`);
    assert(!run.stdout.includes("DISPATCH_PAYLOAD"));
  }
  // Alter the opcode after the witness check and disable the optional trap:
  // unknown dispatch must still fail closed instead of executing or spinning.
  const unknown = luau.run(obfuscate(source, {...opts, dispatchProbe: "unknown", neutralizeTrap: true}), {timeout: 30000});
  assert.notStrictEqual(unknown.status, 0, `seed ${seed}: unknown opcode was not rejected`);
  assert(!unknown.timedOut, `seed ${seed}: unknown opcode hung`);
  assert(!unknown.stdout.includes("DISPATCH_PAYLOAD"));
  const coordinated = luau.run(obfuscate(source, {...opts, dispatchProbe: "coordinated"}), {timeout: 30000});
  assert(coordinated.stdout.includes("DISPATCH_CONTROL_PASSED"), `seed ${seed}: coordinated edit did not bypass comparison`);
}
console.log("dispatch guard: 8 seeds; opcode and operand edits and fake-env replacement stopped; coordinated comparison edits bypassed");
