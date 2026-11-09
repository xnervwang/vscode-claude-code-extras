#!/bin/bash
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

# Build a .vsix without npm. A .vsix is a zip holding the extension under extension/ plus two descriptor files;
# vsce adds nothing else that VS Code requires for a local install.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
id=$(node -p "const p=require('$root/package.json'); p.publisher+'.'+p.name+'-'+p.version")
out="$root/build/$id.vsix"

node "$root/test/check.js" >/dev/null || { echo "pack.sh: test/check.js failed; run it to see why" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/extension"

cd "$root"
# claude-plugin/ is the companion Claude Code plugin. It ships inside the extension so the two always match.
cp -r package.json extension.js uninstall.js src images claude-plugin README.md "$stage/extension/"
# The package format needs a file extension on every file, which is how vsce ships the license too.
cp LICENSE "$stage/extension/LICENSE.txt"
# Python leaves compiled bytecode beside a module it imports, so running the plugin's hooks locally seeds __pycache__
# inside the tree that is copied above. It is a build artifact of whoever last ran them, and it has no business in a
# file other people install.
find "$stage/extension" -name __pycache__ -type d -prune -exec rm -rf {} +
node build/make-manifest.js "$stage"

rm -f "$out"
(cd "$stage" && zip -q -r -X "$out" '[Content_Types].xml' extension.vsixmanifest extension)
echo "$out"
