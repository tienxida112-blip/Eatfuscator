"use strict";
const assert=require("assert");
const {encryptBytes,decryptBytes}=require("../src/Vm/Image/cipher");
const {obfuscate}=require("../src/Core/obfuscate");
const luau=require("../src/Toolchain/luaucli");
for(let n=0;n<300;n++) {
 const keys={k1:n*173+5,k2:n*31+7,salt:n*109+9};
 const input=Array.from({length:n},(_,i)=>(i*53+n*11)%256);
 const enc=encryptBytes(input,keys,1+n%9,1+n%13);
 assert.deepStrictEqual(decryptBytes(enc,keys,1+n%9,1+n%13),input);
 if(n>2){const changed=enc.slice();changed[0]=(changed[0]+1)%256;const p=decryptBytes(changed,keys,1+n%9,1+n%13);assert.notStrictEqual(p[1],input[1]);}
}
for(const seed of [0,5,13,99]) {
 const source='local x="hello\\000world\\255!" local y=123.75 print(#x,string.byte(x,6),string.byte(x,12),y,x:sub(1,5))';
 const a=obfuscate(source,{seed,bulk:false});
 const r=luau.runFile(luau.robloxShim()+'\n'+a,{timeout:30000});
 assert.strictEqual(r.status,0,`${seed} ${r.stderr}`);
 assert(r.stdout.includes('13\t0\t255\t123.75\thello'),`${seed} ${r.stdout}`);
}
console.log('constant cipher: 300 byte-array round trips and 4 seeded Luau runtime cases');
