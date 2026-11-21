![Banner Repo](https://raw.githubusercontent.com/tienxida112-blip/Eatfuscator/refs/heads/main/Background.png)

[![AGPL v3](https://img.shields.io/badge/AGPL-v3-blue)](https://github.com/tienxida112-blip/Eatfuscator/blob/main/LICENSE.txt)
[![Roblox](https://img.shields.io/badge/Roblox-platform-red)](https://www.roblox.com)

# Eatfuscator

Lua / Luau source protection.

Eatfuscator turns source into a custom bytecode VM, then wraps and compresses the loader. It has host checks and anti-tamper checks, but it's still obfuscation, not a lock. Don't put secrets in code you ship.

## Usage

Requires Node.js. From the project directory:

```sh
npm install
node cli.js script.lua out.lua --setting seed:42
```

The output path is optional. Seed is the only build setting; the same input and seed give the same output. Omit the seed for a random one. Run `node cli.js --help` for the other input forms.

The default output targets a Roblox-shaped Luau environment. The compressed loader needs runtime compilation support, so check your host before using it; don't assume it works on every Roblox client. A fake host can be rejected, though rejection isn't guaranteed to be silent.

`EAT_NO_VIRTUALIZE=1` skips the VM. Btw, that means less protection, not a faster version of the same protection.

## Macros

Macros use the reserved `EAT_` prefix. Add shims in an `if not EAT_OBFUSCATED then ... end` block to run the source without obfuscating it; the build removes that block. Unknown macro names are errors.

See [docs/macros.md](docs/macros.md) and [Test/macros.lua](Test/macros.lua). `EAT_SECRET` isn't a safe place for passwords or keys.

## Tests

```sh
npm test
npm run verify
npm run hosts
npm run tamper -- --runs 40
```

The suite checks the loader without padding; verification exercises padded builds. The included Luau binaries are used by the test tools. Results on a simulated host don't prove compatibility with every Roblox environment.

## License

[GNU AGPL v3](LICENSE.txt).
