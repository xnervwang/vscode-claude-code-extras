#!/bin/bash
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

# Build the .vsix of shim/, the last version of xnervwang.claude-code-extras, the way build/pack.sh builds this
# extension. It carries shim/ and the extension's icon, nothing else.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
id=$(node -p "const p=require('$root/shim/package.json'); p.publisher+'.'+p.name+'-'+p.version")
out="$root/build/$id.vsix"

node "$root/test/check.js" >/dev/null || { echo "pack-shim.sh: test/check.js failed; run it to see why" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/extension/images"

cp "$root/shim/package.json" "$root/shim/extension.js" "$root/shim/README.md" "$stage/extension/"
cp "$root/shim/LICENSE" "$stage/extension/LICENSE.txt"
cp "$root/images/icon.png" "$stage/extension/images/"
node "$root/build/make-manifest.js" "$stage" "$root/shim/package.json"

rm -f "$out"
(cd "$stage" && zip -q -r -X "$out" '[Content_Types].xml' extension.vsixmanifest extension)
echo "$out"
