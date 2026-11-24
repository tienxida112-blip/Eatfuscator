"use strict";
const assert = require("assert");
const {flattenLoader} = require("../src/Steps/Flatten");
const {createRNG} = require("../src/Core/rng");
const luau = require("../src/Toolchain/luaucli");
// Explicit markers let us see whether any block after an incorrect transition
// executes. The trap itself is a no-op, testing the independent fail-closed path.
const source = 'function driver()\n' + Array.from({length: 24}, (_, i) => `print("BLOCK_${i}")`).join('\n') + '\nend\ndriver()';
for (const seed of [0,1,5,7,13,31,99,303]) {
  for (const kind of ["clean", "broken", "coordinated"]) {
    const r = createRNG(seed);
    const result = flattenLoader(source, {rng:()=>r.word()/4294967296, blocks:8, trap:'(function() end)()', auditProbe:kind === 'clean' ? undefined : kind});
    assert(result.applied, result.reason);
    const run = luau.runFile(result.code, {timeout:10000});
    if (kind === 'broken') {
      assert.notStrictEqual(run.status, 0, `seed ${seed}: corrupted path continued`);
      assert(!run.stdout.includes('BLOCK_23'), `seed ${seed}: final block executed`);
    } else {
      assert.strictEqual(run.status, 0, `seed ${seed} ${kind}: ${run.stderr}`);
      assert(run.stdout.includes('BLOCK_23'));
    }
  }
}
console.log('CFF prefix checks: 8 seeds; wrong paths stopped even with no-op trap; coordinated audit edit bypasses');
