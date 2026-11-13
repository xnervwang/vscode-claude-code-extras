// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Usage: node test/shell-snapshot-shape.js <path to resources/native-binary/claude>. Checks that a Bash tool command
 * still begins by running a file from the shell-snapshots folder, which is how src/detached.js tells the shell holding
 * a background command apart from the MCP servers and hooks that also run under a claude process.
 *
 * Looks for the code that builds that path, and for the log line the CLI prints when the file is missing. Exits 1 if
 * either is gone, which means a background command no longer shows the conversation as working.
 */
const fs = require('fs');

const NEEDLES = [
  // let H = path.join(configDir(), "shell-snapshots"), X = path.join(H, `snapshot-${shell}-${now}-${rand}.sh`)
  'shell-snapshots',
  'snapshot-${',
  'Snapshot file missing, falling back to login shell:',
];

/** The needles not found in `bytes`. */
function missing(bytes) {
  return NEEDLES.filter((n) => bytes.indexOf(Buffer.from(n, 'latin1')) < 0);
}

function main(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (e) { console.log(`shell snapshot shape: cannot read ${file}: ${e.message}`); return 1; }
  const gone = missing(bytes);
  if (gone.length) {
    console.log(`shell snapshot shape: the CLI no longer has ${gone.map((n) => JSON.stringify(n)).join(', ')};`
      + ' check how a Bash command starts, which src/detached.js reads to find a background command');
    return 1;
  }
  console.log('shell snapshot shape: a Bash command still starts by running a file from the shell-snapshots folder');
  return 0;
}

if (require.main === module) process.exit(main(process.argv[2]));

module.exports = { missing, NEEDLES };
