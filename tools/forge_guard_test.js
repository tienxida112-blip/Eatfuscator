"use strict";
// Exercise the exact Lua forge with valid and malformed token streams.
const assert = require("assert"), fs = require("fs"), path = require("path");
const f = require("../src/Vm/Image/stackvm"), {createRNG} = require("../src/Core/rng");
const luau = require("../src/Toolchain/luaucli");
const vm = fs.readFileSync(path.join(__dirname,"../src/Vm/Template/vm.lua"),"utf8");
let fragment = vm.slice(vm.indexOf("  local vm_forge = function(expectedWords)"), vm.indexOf("\n  vm_load = function(pr)"));
assert(fragment.includes("used >= ntok"));
for (const seed of [0,5,7,13,31,99]) {
  const ops = f.createForgeMap(seed), words = [0,1,0xffffffff,0x12345678];
  const good = f.encodeProto(words,createRNG(seed),ops);
  let text = fragment.replace(/__FORGE_([A-Z_]+)__/g,(_,name) => String(ops[name]));
  const firstBody = 3 + f.unpack(good[2]).operand*2;
  const variants = [];
  function variant(name, fn, expected=words.length) { let a=good.slice(); fn(a); variants.push({name,a,expected}); }
  variant("head", a=>a[0]=f.pack(0,words.length));
  variant("pair header", a=>a[2]=f.pack(0,f.unpack(a[2]).operand));
  variant("pair count", a=>a[2]=f.pack(ops.PAIRS,255));
  variant("wrong words", a=>{},words.length+1);
  variant("short budget", a=>a[1]=firstBody);
  variant("unknown", a=>a[firstBody]=f.pack(0,0));
  variant("store before push", a=>a[firstBody]=f.pack(ops.STORE,0));
  variant("invalid high", a=>a[firstBody+1]=f.pack(ops.LIT_HI,256));
  variant("invalid pair", a=>a[firstBody+2]=f.pack(ops.MAD,999));
  variant("repeated high", a=>a[firstBody+2]=f.pack(ops.LIT_HI,0));
  variant("missing high", a=>a[firstBody+1]=f.pack(ops.ADD,0));
  variant("even multiplier", a=>a[3]=2);
  variant("early store", a=>a[firstBody+2]=f.pack(ops.STORE,0));
  variant("extra declared token", a=>a[1]++);
  let code=`local T_ZERO,T_ONE,T_TWO,T_FOUR=0,1,2,4\nlocal input,pos,reads\nlocal function u32() reads=reads+1 local v=input[pos] pos=pos+1 assert(v~=nil,"read past test stream") return v end\n${text}\n`;
  code += `input={${good.join(',')}} pos=1 reads=0 local out=vm_forge(${words.length}) assert(out and #out==${words.length})\n`;
  words.forEach((w,i)=>code+=`assert(out[${i+1}]==${w})\n`);
  for (const v of variants) code+=`input={${v.a.join(',')}} pos=1 reads=0 out=vm_forge(${v.expected}) assert(out==nil,${JSON.stringify(v.name)}) assert(reads<=#input)\n`;
  code += 'print("forge guards ok")';
  const res=luau.runFile(code,{timeout:10000});
  assert.strictEqual(res.status,0,`seed ${seed}: ${res.stderr}`);
  assert(res.stdout.includes('forge guards ok'));
}
console.log('forge stream guard: valid streams and 84 malformed streams across six mappings');
