"use strict";
// Models of replaced builtins; not a test of any real logger.
const assert=require('assert');
const {obfuscate}=require('../src/Core/obfuscate');
const luau=require('../src/Toolchain/luaucli');
const variants={
 clean:'',
 rawlen:'rawlen=function() return 2 end',
 byteswap:'local t=table.clone(bit32) t.byteswap=function() return 0 end bit32=t',
 isnan:'local t=table.clone(math) t.isnan=function() return false end math=t',
 foreachi:'local t=table.clone(table) t.foreachi=function() return 99 end table=t',
 yieldable:'local t=table.clone(coroutine) t.isyieldable=function() return false end coroutine=t',
 // Removing one optional API must no longer suppress unrelated checks.
 absent:'local t=table.clone(table) t.foreachi=nil table=t rawlen=function() return 2 end',
 missing_only:'local t=table.clone(table) t.foreachi=nil table=t',
};
for(const seed of [0,5,13,99]){
 const a=obfuscate('print("BUILTIN_OK")',{seed,bulk:false});
 for(const [name,mutation] of Object.entries(variants)){
  const r=luau.runFile(luau.robloxShim()+'\n'+mutation+'\n'+a,{timeout:30000});
  const passes=name==='clean'||name==='missing_only';
  assert.strictEqual(r.status===0&&r.stdout.includes('BUILTIN_OK'),passes,`${seed} ${name}: ${r.status} ${r.stderr}`);
 }
}
console.log('builtin semantics: four seeds; modeled replacements stopped even with unrelated optional API missing; missing-only compatibility passed');
