"use strict";
// Post-load word modification and a deliberate coordinated bypass control.
const assert = require("assert");
const {obfuscate} = require("../src/Core/obfuscate");
const luau = require("../src/Toolchain/luaucli");
const source = 'print("RESIDENT_PAYLOAD") return 42';
for (const seed of [0,1,5,7,13,31,99,300,303,334]) {
  const opts = {seed,bulk:false};
  const clean=luau.run(obfuscate(source,opts),{timeout:20000});
  assert.strictEqual(clean.status,0,`seed ${seed}: ${clean.stderr}`);
  assert(clean.stdout.includes("RESIDENT_PAYLOAD"));
  const changed=luau.run(obfuscate(source,{...opts,wordProbe:"word"}),{timeout:20000});
  assert.notStrictEqual(changed.status,0,`seed ${seed}: changed instruction was not rejected`);
  assert(!changed.stdout.includes("RESIDENT_PAYLOAD"));
  const bypass=luau.run(obfuscate(source,{...opts,wordProbe:"coordinated"}),{timeout:20000});
  assert.strictEqual(bypass.status,0,`seed ${seed}: coordinated positive control: ${bypass.stderr}`);
  assert(!bypass.stdout.includes("RESIDENT_PAYLOAD"),`seed ${seed}: control did not execute patched return`);
  const failed=luau.run(obfuscate(source,{...opts,guardProbe:true}),{timeout:20000});
  assert.notStrictEqual(failed.status,0,`seed ${seed}: length failure didn't raise`);
  assert(!failed.stdout.includes("RESIDENT_PAYLOAD"),`seed ${seed}: instruction ran after guard failure`);
}
// A child-frame failure caught by the payload's pcall must poison the parent
// before it can execute another VM instruction. The control disables the sticky
// state and demonstrates the parent would otherwise continue after pcall.
const nested='local ok=pcall(function() print("CHILD") end) print("AFTER",ok)';
for (const seed of [0,5,7,13,31,99]) {
  const opts={seed,bulk:false};
  const fail=luau.run(obfuscate(nested,{...opts,wordProbe:"child"}),{timeout:20000});
  assert.notStrictEqual(fail.status,0,`seed ${seed}: parent resumed after caught child failure`);
  assert(!fail.stdout.includes("AFTER"));
  const control=luau.run(obfuscate(nested,{...opts,wordProbe:"child-clear"}),{timeout:20000});
  assert.strictEqual(control.status,0,`seed ${seed}: sticky-state positive control: ${control.stderr}`);
  assert(control.stdout.includes("AFTER\tfalse"),`seed ${seed}: positive control did not resume`);
}
console.log('sticky failure: six child-frame tests plus controls');
console.log('resident guard: 10 seeds; word edits rejected before execution; coordinated-tag bypass controls succeeded');
