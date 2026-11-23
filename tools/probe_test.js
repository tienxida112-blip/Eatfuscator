"use strict";
// Model a logger that records protected failures and spoofs the native-function
// identity check. It is a controlled model, not the user's actual logger.
const assert = require("assert");
const {obfuscate} = require("../src/Core/obfuscate");
const luau = require("../src/Toolchain/luaucli");
let shim = luau.robloxShim();
const needle = 'mt.__newindex = function(_, key, value)';
assert(shim.includes(needle));
shim = shim.replace(needle, needle + '\n      if key == "ClassName" then table.insert(__writes,self.ClassName) end');
for (const seed of [0,5,7,13,31,99]) {
  const art = obfuscate('print("PAYLOAD_OK")', {seed, bulk:false});
  let eq = ""; while (art.includes("]"+eq+"]")) eq += "=";
  const test = `local __writes={}\n${shim}\n` + `
local env=getfenv(0)
local realpc,realxp=pcall,xpcall
local logs={}
local function pp(fn,...) local r=table.pack(realpc(fn,...)) if not r[1] then table.insert(logs,"pcall "..tostring(r[2])) end return table.unpack(r,1,r.n) end
local function xx(fn,handler,...) local r=table.pack(realxp(fn,handler,...)) if not r[1] then table.insert(logs,"xpcall "..tostring(r[2])) end return table.unpack(r,1,r.n) end
env.pcall=pp env.xpcall=xx
local dbg=env.debug env.debug={info=function(f,opt) if f==pp then return "[C]" end return dbg.info(f,opt) end}
local f=loadstring([${eq}[${art}]${eq}])
local ok,e=realpc(f)
assert(ok,tostring(e))
assert(#__writes==1 and __writes[1]=="Part",table.concat(__writes,","))
local all=table.concat(logs,"\\n")
assert(string.find(all,"attempt to call a number value",1,true))
assert(string.find(all,"assertion failed",1,true))
assert(string.find(all,"ClassName",1,true))
assert(string.find(all,"xpcall ",1,true))
print("PROBES_OK")`;
  const r = luau.runFile(test,{timeout:30000});
  assert.strictEqual(r.status,0,`seed ${seed}: ${r.stderr}`);
  assert(r.stdout.includes('PAYLOAD_OK') && r.stdout.includes('PROBES_OK'),`seed ${seed}: ${r.stdout}`);
}
console.log("protected error probes: six seeds, payload runs and only disposable Part receives ClassName write");
