// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/test/shared-copies.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * The copies of Agent Plus's shared files in an extension (build/sync-shared.js). A copy that differs from the hash in
 * shared.json fails: it was edited here, where the next sync would overwrite it. A source in the Agent Plus checkout
 * that has moved on is only noted, so that Agent Plus changing first does not turn every extension's suite red.
 *
 * It is async: the caller awaits it before printing its totals and exiting, or a check that fails after the exit is lost.
 */
const fs = require('fs');
const path = require('path');
const sync = require('../build/sync-shared.js');

module.exports = async ({ ok, bad, eq, note }, root, core = sync.coreDir(root)) => {
  const m = sync.readManifest(root);
  eq(sync.checkCopies(root), [], `the ${m.files.length} files copied from Agent Plus are as shared.json records them`);
  const unnamed = m.files.filter((f) => fs.existsSync(path.join(root, f.path))
    && !sync.namesSource(fs.readFileSync(path.join(root, f.path), 'utf8'), f.from)).map((f) => f.path);
  eq(unnamed, [], 'and each names the Agent Plus file it is copied from');
  if (!/^[0-9a-f]{40}$/.test(m.core)) bad(`shared.json names no committed Agent Plus state to copy from: ${m.core}`);
  if (!fs.existsSync(path.join(core, 'shared'))) { note(`no Agent Plus checkout at ${core}: the copies were not compared with it`); return; }
  const ahead = sync.checkCore(root, core);
  if (ahead.length) note(`Agent Plus has moved on (${ahead.join('; ')}): run node build/sync-shared.js`);
  else ok(`and each is the same as in the Agent Plus checkout at ${core}`);
};
