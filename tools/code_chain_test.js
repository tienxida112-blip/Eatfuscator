"use strict";
const assert=require('assert');
const cipher=require('../src/Vm/Image/cipher'),f=require('../src/Vm/Image/feistel'),op=require('../src/Vm/Image/opcodes');
let cases=0;
for(let seed=0;seed<24;seed++) {
 const keys={k1:12345+seed*137,k2:98765+seed*151,salt:3579+seed*31};
 const words=Array.from({length:48},(_,i)=>op.iABC(op.BASE.MOVE,(i*7)%256,(i*13)%256,(i*19)%256));
 const build=a=>{const p={code:a.slice(),child:[]};cipher.cipherCode(p,keys);return p;};
 const original=build(words), altered=words.slice();
 altered[3]=op.setField(altered[3],'a',(op.fieldOf(altered[3],'a')+1)%256);
 const changed=build(altered);
 assert.notStrictEqual(original.code[3],changed.code[3]);
 for(let i=4;i<words.length;i++) assert.notStrictEqual(original.code[i],changed.code[i],`seed ${seed} chain did not propagate at ${i}`);
 assert.notStrictEqual(original.codeDigest,changed.codeDigest);
 const box=cipher.buildBox(keys),sch=f.schedule(box,f.DOMAIN_CODE,0,0,f.ROUNDS);
 let chain=cipher.chainSeed(sch.iv,1);
 for(let i=0;i<words.length;i++) {
  const mixed=f.decryptWord(f.mod(original.code[i]-chain,f.P32),sch);
  const masked=f.mod(mixed-f.counterAt(i+1,1),f.P32);
  const decoded=cipher.unmaskOperands(masked,box,1,i+1);
  assert.strictEqual(op.setField(decoded,'op',op.fieldOf(decoded,'op')-cipher.opcodeFlip(box,1,i+1)),words[i]);
  chain=cipher.chainStep(chain,masked,sch,1,i+1);cases++;
 }
}
console.log(`code chain: ${cases} decoded words; changed word propagates across all later words in 24 builds`);
