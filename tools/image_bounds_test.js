"use strict";
const assert = require("assert");
const {serialize, TAG_OF} = require("../src/Vm/Image/encoder");
const proto = () => ({numParams:0,isVararg:false,uv:[],code:[],k:[],child:[]});
assert(serialize(proto()).length > 0);
for (const order of [[0,0,2,3,4,5,6], [0,1,2,3,4,5,7], [0,1,2]]) {
  assert.throws(() => serialize(proto(),{fieldOrder:order}), /header order/);
}
assert.throws(() => serialize(proto(),{tagOf:{...TAG_OF,string:TAG_OF.number}}), /tags/);
for (const [field,value] of [["numParams",256],["wordCount",65536]]) {
  const p=proto();p[field]=value;assert.throws(()=>serialize(p),/out of range/);
}
for (const field of ["uv","k","child"]) {
  const p=proto(); const v=field==="uv"?{idx:0}:field==="k"?{t:"nil"}:proto();
  p[field]=Array(field==="uv"?256:65536).fill(v);
  assert.throws(()=>serialize(p),/out of range/);
}
const p=proto();p.uv=[{idx:256}];assert.throws(()=>serialize(p),/upvalue index/);
const q=proto();q.k=[{t:"number",enc:true,v:"1".repeat(65536)}];assert.throws(()=>serialize(q),/number text length/);
console.log("image bounds: invalid layouts, tags, counts and indices rejected before truncation");
