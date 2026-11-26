"use strict";
// Regression: real Roblox reports Enums and Enum rather than table for these values.
const assert = require("assert");
const { obfuscate } = require("../src/Core/obfuscate");
const luau = require("../src/Toolchain/luaucli");
const shim = luau.robloxShim();
const marker = '    return raw_typeof(value)\n  end\n\n  -- Enum:';
assert(shim.includes(marker), 'shim marker changed');
const realistic = shim.replace(marker, '    if Enum and value == Enum then return "Enums" end\n    if Enum and value == Enum.PartType then return "Enum" end\n' + marker);
for (const seed of [0, 5, 7, 13, 31, 99]) {
  const artifact = obfuscate('print("ENUM_GATE_OK")', { seed, bulk: false });
  for (const [name, host] of [["realistic enum types", realistic], ["table fixture", shim]]) {
    const result = luau.runFile(host + '\n' + artifact, { timeout: 30000 });
    assert.strictEqual(result.status, 0, `seed ${seed} ${name}: ${result.stderr}`);
    assert(result.stdout.includes('ENUM_GATE_OK'), `seed ${seed} ${name}: ${result.stdout}`);
  }
}
console.log('enum gate: six seeds, Roblox enum types and existing table fixtures passed');
