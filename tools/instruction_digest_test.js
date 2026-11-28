"use strict";
// The digest is a rolling keyed permutation, not a cryptographic MAC. Test the
// old polynomial's two-word cancellation and single-bit changes in every word.
const assert = require('assert');
const {createRNG}=require('../src/Core/rng');
const {buildBox,codeDigestSeed,codeDigestStep}=require('../src/Vm/Image/cipher');
const f=require('../src/Vm/Image/feistel');
const {obfuscate}=require('../src/Core/obfuscate');
const luau=require('../src/Toolchain/luaucli');
let checked=0;
for(let seed=0;seed<6;seed++) {
 const rng=createRNG(seed),words=Array.from({length:16},()=>rng.word());
 const box=buildBox({k1:87123+seed,k2:93456+seed,salt:7531+seed});
 const sch=f.schedule(box,f.DOMAIN_CODE,0,0,f.ROUNDS), pi=1+seed;
 const digest=a=>a.reduce((h,w,i)=>codeDigestStep(h,w>>>0,sch,pi,i+1),codeDigestSeed(sch,pi,a.length));
 const orig=digest(words);
 for(let i=0;i<words.length;i++) for(let bit=0;bit<32;bit++) {
  const changed=words.slice();changed[i]=(changed[i]^(1<<bit))>>>0;
  assert.notStrictEqual(digest(changed),orig,`seed ${seed}, index ${i}, bit ${bit}`);checked++;
 }
 const altered=words.slice();altered[0]=(altered[0]+1)>>>0;altered[1]=(altered[1]-31)>>>0;
 const old=a=>a.reduce((h,w)=>(h*31+w)%4294967296,0);
 assert.strictEqual(old(altered),old(words));
 assert.notStrictEqual(digest(altered),orig,'old polynomial cancellation should not work on this case');
}
for(const seed of [0,5,13,99]) {
 const source='local t=0 for i=1,100 do t=t+i end print("digest",t)';
 const result=luau.run(obfuscate(source,{seed,bulk:false}),{timeout:30000});
 assert.strictEqual(result.status,0,`seed ${seed}: ${result.stderr}`);
 assert.strictEqual(result.stdout.trim(),'digest\t5050');
}
console.log(`instruction digest: ${checked} one-bit edits and six old-polynomial cancellation cases rejected; four runtime seeds passed`);
