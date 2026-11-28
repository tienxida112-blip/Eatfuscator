"use strict";
const assert=require("assert");
const {obfuscate}=require("../src/Core/obfuscate");
const luau=require("../src/Toolchain/luaucli");
const source='local x="resident constant" print(x)';
for(const seed of [0,5,13,99]) {
 const normal=luau.run(obfuscate(source,{seed,bulk:false}),{timeout:30000});
 assert.strictEqual(normal.status,0,`${seed} baseline: ${normal.stderr}`);
 assert.strictEqual(normal.stdout.trim(),'resident constant');
 const bad=luau.run(obfuscate(source,{seed,bulk:false,constProbe:'edit'}),{timeout:30000});
 assert(!bad.timedOut,`seed ${seed} timed out`);
 assert(!bad.stdout.includes('resident constant'),`seed ${seed} changed resident constant was accepted`);
 assert.notStrictEqual(bad.status,0,`seed ${seed} did not fail closed`);
}
console.log('constant guard: four seeds; resident ciphertext edits fail before use');
