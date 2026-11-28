"use strict";
const assert=require('assert');
const {obfuscate}=require('../src/Core/obfuscate');
const luau=require('../src/Toolchain/luaucli');
const source='print("IMAGE_VALID")';
const probes=['zero-protos','huge-protos','truncated-header','forge-size','forge-head','bad-tag'];
for(const seed of [0,5,13,99]) {
 const good=luau.run(obfuscate(source,{seed,bulk:false}),{timeout:30000});
 assert.strictEqual(good.status,0,`${seed} baseline: ${good.stderr}`);
 assert.strictEqual(good.stdout.trim(),'IMAGE_VALID');
 for(const imageProbe of probes) {
  const bad=luau.run(obfuscate(source,{seed,bulk:false,imageProbe}),{timeout:30000});
  assert(!bad.timedOut,`${seed}/${imageProbe}: timed out`);
  assert.notStrictEqual(bad.status,0,`${seed}/${imageProbe}: malformed image accepted`);
  assert(!bad.stdout.includes('IMAGE_VALID'),`${seed}/${imageProbe}: payload ran`);
 }
}
console.log('image parser: 24 malformed images rejected before payload; four valid builds passed');
