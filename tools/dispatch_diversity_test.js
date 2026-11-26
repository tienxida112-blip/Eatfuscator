"use strict";
const assert=require('assert');
const {tree}=require('../src/Vm/Image/dispatch');
const {createRNG}=require('../src/Core/rng');
const luau=require('../src/Toolchain/luaucli');
// Sparse distributions deliberately include empty residue buckets. Check all
// 256 opcodes, not only valid ones, to catch unreachable handlers and bad misses.
const sets=[Array.from({length:30},(_,i)=>i*8),Array.from({length:80},(_,i)=>(i*37)%256)];
for(const strategy of ['bst','bucket','affine']) for(const seed of [0,1,5,13,31,99]) for(const values of sets){
 const valid=new Set(values);
 let source='local function dispatch(o)\n';
 values.forEach((v,i)=>{source+=`    ${i?'elseif':'if'} o == ${v} then\n      return ${v+1000}\n`;});
 source+='    else\n      return -1\n    end\nend\n';
 const rng=createRNG(seed);
 const built=tree(source,{strategy,onMiss:'return -1',rng:()=>rng.word()/4294967296});
 assert(built.applied);assert.strictEqual(built.stats.strategy,strategy);
 let test=built.code+'\n';
 for(let v=0;v<256;v++)test+=`assert(dispatch(${v})==${valid.has(v)?v+1000:-1},"opcode ${v}")\n`;
 const r=luau.runFile(test,{timeout:30000});
 assert.strictEqual(r.status,0,`${strategy} seed ${seed}: ${r.stderr}`);
}
console.log('dispatch diversity: three strategies, six seeds, two sparse sets, all 256 opcodes checked');
