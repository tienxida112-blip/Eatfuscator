"use strict";
// Model only: verifies the gate's value cross-checks, not a real environment logger.
const assert=require('assert');
const {obfuscate}=require('../src/Core/obfuscate');
const luau=require('../src/Toolchain/luaucli');
const setup=`
do
 local env=getfenv(1)
 local oldtypeof=env.typeof
 env.typeof=function(v) if type(v)=="table" and v._kind then return v._kind end return oldtypeof(v) end
 env.Random={new=function(seed) return {_kind="Random",NextInteger=function() return 123 end} end}
 env.Vector3={new=function(x,y,z) return {_kind="Vector3",X=x,Y=y,Z=z} end}
 env.Vector2={new=function(x,y) return {_kind="Vector2",X=x,Y=y} end}
 env.UDim={new=function(s,o) return {_kind="UDim",Scale=s,Offset=o} end}
 env.UDim2={new=function(a,b,c,d) return {_kind="UDim2",X={Scale=a,Offset=b},Y={Scale=c,Offset=d}} end}
 local item={}; env.Enum.MouseBehavior={Default=item,FromName=function() return item end,FromValue=function() return item end}
 env.Ray={new=function(origin,direction) return {Distance=function() if direction.X==1 then return 3.605551275463989 end return 1.4142135623730951 end} end}
end
`;
const mutations={
 random:'Random.new=function() return {_kind="Random",NextInteger=function() return 0 end} end',
 vector:'Vector3.new=function() return {_kind="Vector3",X=0,Y=2,Z=3} end',
 enum:'Enum.MouseBehavior.FromValue=function() return {} end',
 ray:'Ray.new=function() return {Distance=function() return 7 end} end',
 // Secondary-probe exceptions are intentionally tolerated for compatibility.
 exception:'Ray.new=function() error("unavailable") end',
 absent:'Ray=nil',
};
for(const seed of [0,5,13,99]){
 const artifact=obfuscate('print("HOST_BEHAVIOR_OK")',{seed,bulk:false});
 for(const [name,change] of Object.entries({clean:'',...mutations})){
   const r=luau.runFile(luau.robloxShim()+setup+'\n'+change+'\n'+artifact,{timeout:30000});
   const passes=['clean','exception','absent'].includes(name);
   assert.strictEqual(r.status===0&&r.stdout.includes('HOST_BEHAVIOR_OK'),passes,`${seed} ${name}: ${r.status} ${r.stderr}`);
 }
}
console.log('host behavior: four seeds; four modeled wrong results rejected; missing API and thrown probe bypass controls passed');
