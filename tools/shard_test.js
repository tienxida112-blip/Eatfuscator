"use strict";
const fs = require("fs"), assert = require("assert"), path = require("path");
const luau = require("../src/Toolchain/luaucli");
const vm = fs.readFileSync(path.join(__dirname,"../src/Vm/Template/vm.lua"),"utf8");
const helpers = vm.slice(vm.indexOf("local function vm_laneoffset"), vm.indexOf("-- The stack machine's two slots."));
assert(helpers.includes("vm_shardget"));
const source = `local T_ONE,T_FOUR=1,4\nlocal al_floor=math.floor\nlocal T_SBOX_CODE={} for i=1,256 do T_SBOX_CODE[i]=(i*73+19)%256 end\n${helpers}\n` + `
for pi=1,31 do
  for n=0,257 do
    local code={} for i=1,n do code[i]=(i*1234567+pi)%4294967296 end
    local shards=vm_shard(code,pi)
    assert(#shards==4)
    local offset=vm_laneoffset(pi)
    for lane=1,4 do
      local first=(lane-1-offset)%4+1
      local expected=first<=n and (math.floor((n-first)/4)+1) or 0
      assert(#shards[lane]==expected)
    end
    for i=1,n do assert(vm_shardget(shards,i,pi)==code[i]) end
    if n>0 then
      local i=math.floor((n+1)/2) local lane=(i-1+offset)%4+1 local row=math.floor((i-1)/4)+1
      shards[lane][row]=shards[lane][row]+1
      assert(vm_shardget(shards,i,pi)~=code[i])
    end
  end
end
print("shard cases",31*258)
`;
const r=luau.runFile(source,{timeout:60000});assert.strictEqual(r.status,0,r.stderr);console.log(r.stdout.trim());
