"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const root = path.join(__dirname, "..");
const { obfuscate } = require("../src/Core/obfuscate");
const luau = require("../src/Toolchain/luaucli");
const candidates = fs.readdirSync(path.join(root,"Test")).filter(n => n.startsWith("cases_") && n.endsWith(".lua"));
for (let i = candidates.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
const out = path.join(root,"Samples"); fs.mkdirSync(out,{recursive:true});
// Only remove files listed by our previous manifest, not unrelated user files.
const manifest = path.join(out, "manifest.json");
if (fs.existsSync(manifest)) {
  const old = JSON.parse(fs.readFileSync(manifest, "utf8"));
  for (const row of old) {
    if (/^Samples\/sample_[a-zA-Z0-9_-]+\.lua$/.test(row.output)) {
      const file = path.join(root, row.output);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  fs.unlinkSync(manifest);
}
const rows = [];
for (const name of candidates) {
  if (rows.length === 10) break;
  const source = fs.readFileSync(path.join(root,"Test",name),"utf8");
  const seed = crypto.randomBytes(4).readUInt32LE();
  const ref = luau.run(source,{timeout:30000});
  if (ref.status !== 0 || ref.timedOut) { console.log(`skip ${name}: source failed`); continue; }
  try {
    const artifact = obfuscate(source,{seed});
    const result = luau.run(artifact,{timeout:90000});
    if (result.status !== 0 || result.timedOut || result.stdout !== ref.stdout || /loadstring|load\(/.test(artifact)) { console.log(`skip ${name}: mismatch`); continue; }
    const file = name.replace(/^cases_/,"sample_");
    fs.writeFileSync(path.join(out,file),artifact);
    rows.push({input:`Test/${name}`,output:`Samples/${file}`,seed,bytes:Buffer.byteLength(artifact)});
    console.log(`${rows.length}/10 ${name} seed ${seed}`);
  } catch (err) { console.log(`skip ${name}: ${err.message}`); }
}
if (rows.length !== 10) throw new Error(`only ${rows.length} samples passed`);
fs.writeFileSync(path.join(out,"manifest.json"),JSON.stringify(rows,null,2)+"\n");
