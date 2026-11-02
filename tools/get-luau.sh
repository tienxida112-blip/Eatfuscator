#!/bin/sh
# Fetch the official Luau CLI into ~/.eatfuscator/luau so the obfuscator can
# gate every artifact against the real compiler instead of its internal
# Lua 5.1 lowering shim.
#
#   sh tools/get-luau.sh            # latest release
#   sh tools/get-luau.sh 0.744      # pin a version
#
# Windows: download luau-windows.zip from the same release URL and unzip the
# three executables next to this script's vendor/ directory instead.
set -eu

version="${1:-latest}"
if [ "$version" = "latest" ]; then
  url="https://github.com/luau-lang/luau/releases/latest/download/luau-ubuntu.zip"
else
  url="https://github.com/luau-lang/luau/releases/download/${version}/luau-ubuntu.zip"
fi

dest="${HOME}/.eatfuscator/luau"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "fetching $url"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp/luau.zip"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$url" -O "$tmp/luau.zip"
else
  echo "need curl or wget to download the toolchain" >&2
  exit 1
fi

mkdir -p "$dest/bin"
unzip -q -o "$tmp/luau.zip" -d "$dest/bin"
chmod +x "$dest/bin"/luau "$dest/bin"/luau-compile 2>/dev/null || true

echo "installed into $dest/bin:"
ls -1 "$dest/bin"
echo
echo "verify with: node -e 'console.log(require(\"./obfuscator/luaucli\").describe())'"
