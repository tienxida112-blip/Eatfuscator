"use strict";
const assert=require("assert");
const {spawnSync}=require("child_process");
const path=require("path");
const cli=path.join(__dirname,"..","cli.js");
for (const args of [
 ["--setting"], ["--setting","seed:"], ["--setting","seed:1:2"],
 ["--setting","seed:no"], ["--setting","seed:1"], ["--input","file.lua"],
 ["in.lua","out.lua","extra.lua"], ["in.lua","--setting","mode:weak"],
]) {
 const r=spawnSync(process.execPath,[cli,...args],{encoding:"utf8",timeout:10000});
 assert.strictEqual(r.status,2,`${args.join(" ")}: ${r.status} ${r.stderr}`);
}
console.log("CLI: malformed seed, missing input, unsupported options and extra arguments rejected");
