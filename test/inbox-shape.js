// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Usage: node test/inbox-shape.js <path to resources/native-binary/claude>. Checks that the CLI still reads a line posted
 * to a session's inbox socket the way src/stewards.js post() writes it: {"type":"user","message":{"content":"..."}}.
 *
 * Claude Code's docs describe the socket but not the format of a line. This looks instead for the handler that reads a
 * user line's message.content and queues it: its check for a "user" line and its two log strings. Exits 1 if any is
 * missing.
 */
const fs = require('fs');

const NEEDLES = [
  // In the handler for a "user" line, after reading e.message?.content.
  '[uds-messaging] Ignoring user message with missing or non-string content',
  '[uds-messaging] Routed user message to queue',
  'e.type==="user"',
];

/** The needles not found in `bytes`. */
function missing(bytes) {
  return NEEDLES.filter((n) => bytes.indexOf(Buffer.from(n, 'latin1')) < 0);
}

function main(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (e) { console.log(`inbox shape: cannot read ${file}: ${e.message}`); return 1; }
  const gone = missing(bytes);
  if (gone.length) {
    console.log(`inbox shape: the CLI no longer has ${gone.map((n) => JSON.stringify(n)).join(', ')}; check how its inbox socket reads a user line`);
    return 1;
  }
  console.log('inbox shape: the CLI still takes {"type":"user","message":{"content":...}} on a session\'s inbox socket');
  return 0;
}

if (require.main === module) process.exit(main(process.argv[2]));

module.exports = { missing, NEEDLES };
