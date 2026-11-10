#!/bin/bash
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

# Build build/<publisher>.<name>-<version>.vsix from the paths below, less what .vscodeignore leaves out. claude-plugin/
# is the companion Claude Code plugin; it ships inside the extension so the two always match.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
exec node "$root/build/pack-vsix.js" "$root" package.json extension.js uninstall.js src images claude-plugin README.md
