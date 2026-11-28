"use strict";
const assert=require('assert');
const {expand}=require('../src/Steps/Macro');
const {createRNG}=require('../src/Core/rng');
const {obfuscate}=require('../src/Core/obfuscate');
const luau=require('../src/Toolchain/luaucli');
const exact=`--print("Hello, World!")
if EAT_OBFUSCATED then
    print("THIS IS OBFUSCATED WITH EATFUSCATOR")
    print(EAT_STRING("Hello, World!"))
    print(EAT_NUMBER(67))
end`;
const expected='THIS IS OBFUSCATED WITH EATFUSCATOR\nHello, World!\n67';
const sources=[
 [exact,expected],
 ['if not EAT_OBFUSCATED then function EAT_STRING(s) return s end else print(EAT_STRING("else branch")) end','else branch'],
 ['if not EAT_OBFUSCATED then function EAT_NUMBER(n) return n end elseif EAT_OBFUSCATED then print(EAT_NUMBER(67)) end','67'],
 ['local f=EAT_FUNCTION(function() if EAT_OBFUSCATED then return EAT_STRING("nested") end end) print(f())','nested'],
 ['print(`flag={EAT_OBFUSCATED} value={EAT_NUMBER(67)}`)','flag=true value=67'],
 ['local t={EAT_OBFUSCATED="field"} print(t.EAT_OBFUSCATED,t . EAT_OBFUSCATED,"EAT_OBFUSCATED",EAT_OBFUSCATED)','field\tfield\tEAT_OBFUSCATED\ttrue'],
];
for(const seed of [0,5,13,99]) for(const [source,out] of sources) {
 const artifact=obfuscate(source,{seed,bulk:false});
 const r=luau.run(artifact,{timeout:30000});
 assert.strictEqual(r.status,0,`seed ${seed}: ${r.stderr}`);
 assert.strictEqual(r.stdout.trim(),out,`seed ${seed} source ${source}`);
}
const exp=expand('-- EAT_OBFUSCATED\nprint("EAT_OBFUSCATED", EAT_OBFUSCATED)',{rng:createRNG(5)}).code;
assert(exp.includes('-- EAT_OBFUSCATED'));assert(exp.includes('"EAT_OBFUSCATED", true'));
assert.throws(()=>expand('local EAT_OBFUSCATED = false',{rng:createRNG(0)}),/cannot be declared local/);
console.log('macro flag: exact user input, else/elseif, nested calls, strings and member keys passed across four seeds');
