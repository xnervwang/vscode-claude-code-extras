// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Plan and logo paths can come from another extension. Reading a FIFO or a device would block the extension host's only
 * thread, and a huge file would be read into memory whole, so only a regular file within `max` bytes is read.
 *
 * A file swapped for a FIFO, or grown, between statSync() and the read is not caught. Only a deliberately hostile
 * extension would do that, and it runs in the same process and can block the host anyway.
 */
const fs = require('fs');

function readBounded(file, max) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return null; }
  if (!st.isFile() || st.size > max) return null;
  let body;
  try { body = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  return Buffer.byteLength(body) > max ? null : body;
}

module.exports = { readBounded };
