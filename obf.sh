#!/bin/bash
# Run the CLI with this Node's own module resolution. Nothing is unpacked next
# to this file: dependencies come from wherever Node already looks (a project
# install, a global `npm install -g`, or NODE_PATH).
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/cli.js" "$@"
