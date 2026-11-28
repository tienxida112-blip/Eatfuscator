"use strict";
const assert=require("assert"), fs=require("fs"), path=require("path");
const {reserved}=require("../src/Envelope/idents");
const {obfuscate}=require("../src/Core/obfuscate");
const luau=require("../src/Toolchain/luaucli");
const root=path.join(__dirname,"..");
const generator=fs.readFileSync(path.join(root,"src/Envelope/wrap.js"),"utf8");
const start=generator.indexOf("function hostGateLua(");
const end=generator.indexOf("\n  if (template.includes(TRAP_MARK))",start);
assert(start>=0&&end>start);
const words=new Set([...generator.slice(start,end).matchAll(/[A-Za-z_][A-Za-z0-9_]{0,10}/g)].map(x=>x[0]).filter(x=>!x.startsWith("__")));
for(const word of words) assert(reserved(word),`unreserved host gate literal ${word}`);
const source=fs.readFileSync(path.join(root,"Test/exec_heavy.lua"),"utf8");
const ref=luau.run(source,{timeout:30000});assert.strictEqual(ref.status,0);
for(const seed of [0,5,7,13,99,4242]) {
 const artifact=obfuscate(source,{seed,bloat:0});
 const result=luau.run(artifact,{timeout:30000});
 assert.strictEqual(result.status,0,`seed ${seed}: ${result.stderr}`);
 assert.strictEqual(result.stdout,ref.stdout,`seed ${seed} output mismatch`);
}
console.log(`host identifier safety: ${words.size} literal names reserved; six regression seeds passed`);
