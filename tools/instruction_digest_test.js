"use strict";
// The old 24-bit polynomial could not see any instruction delta of 2^24.
// Check all bits in every position and verify the exact JS/Luau calculation.
const assert = require("assert"), luau = require("../src/Toolchain/luaucli"), {createRNG} = require("../src/Core/rng");
const P = 4294967296;
const digest = a => a.reduce((h,w)=>(h*31+(w>>>0))%P,0);
const lines=[]; let checks=0;
for (let seed=0;seed<24;seed++) {
  const rng=createRNG(seed), code=Array.from({length:32},()=>rng.word());
  const orig=digest(code);
  lines.push(`assert(d({${code.join(',')}})==${orig})`);
  for(let i=0;i<code.length;i++) for(let bit=0;bit<32;bit++) {
    const changed=code.slice();changed[i]=(changed[i]^(1<<bit))>>>0;
    assert.notStrictEqual(digest(changed),orig,`seed ${seed}, index ${i}, bit ${bit}`); checks++;
  }
}
const lua=`local function d(t) local h=0 for i=1,#t do h=(h*31+t[i])%4294967296 end return h end\n${lines.join('\n')}\nprint("digest runtime ok")`;
const r=luau.runFile(lua,{timeout:10000});assert.strictEqual(r.status,0,r.stderr);assert(r.stdout.includes('digest runtime ok'));
console.log(`instruction digest: ${checks} single-bit mutations detected; JS/Luau parity on 24 streams`);
