// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Background sessions left out of the session list.
 *
 * Claude Code's list already leaves out SDK and daemon sessions, by the entry point and the sessionKind on the first
 * record of a transcript, but not those whose sessionKind is "bg". Its own filter is also skipped altogether when
 * claudeCode.claudeProcessWrapper is set. So the patched host hands the finished list here instead, and this module
 * reads both fields as Claude Code does, leaving out `claude --bg`, `claude -p` and daemon sessions.
 *
 * A transcript with a cost or a last prompt but no message is left out as well: opening it shows nothing. Some
 * background sessions leave such files.
 *
 * A session's kind does not change, so each is read once.
 */
const fs = require('fs');
const path = require('path');
const { projectsDir, transcriptOf, SESSION } = require('./claude-files');

const HEAD_BYTES = 65536;
const KIND = /"sessionKind":"([^"]*)"/;
const SDK = /"entrypoint":"sdk-(?:cli|ts|py)"/;
const RAN = /"type":"(?:cost-state|last-prompt)"/;
const HIDDEN = new Set(['bg', 'daemon', 'daemon-worker', 'sdk', 'empty']);
const kinds = new Map();

/* Claude Code's folder name for a working directory; one longer than 200 characters gets a hash it computes itself. */
function folderName(cwd) {
  const name = String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
  return name && name.length <= 200 ? name : '';
}

/*
 * What the first record with a parent link says: its sessionKind ('' when it has none), or 'sdk' for an SDK entry point.
 * With no such record, 'empty' when the whole file shows the session ran, and null for a session not started yet or a
 * file that cannot be read.
 */
function kindOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const head = buf.toString('utf8', 0, read);
    const line = head.split('\n').find((l) => l.includes('"parentUuid":'));
    if (line === undefined) return read < HEAD_BYTES && RAN.test(head) ? 'empty' : null;
    if (SDK.test(line)) return 'sdk';
    const m = KIND.exec(line);
    return m ? m[1] : '';
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* closed */ }
  }
}

/* A session whose kind cannot be read yet is treated as an ordinary one, and read again next time. */
function isBackground(id, cwd, projects = projectsDir()) {
  if (kinds.has(id)) return HIDDEN.has(kinds.get(id));
  const dir = folderName(cwd);
  let file = dir ? path.join(projects, dir, id + '.jsonl') : '';
  if (!file || !fs.existsSync(file)) file = transcriptOf(id, projects);
  const kind = file ? kindOf(file) : null;
  if (kind === null) return false;
  kinds.set(id, kind);
  return HIDDEN.has(kind);
}

function withoutBackground(entries, cwd, projects = projectsDir()) {
  if (!Array.isArray(entries)) return entries;
  return entries.filter((e) => {
    const id = e && (e.id || e.sessionId);
    return !(typeof id === 'string' && SESSION.test(id) && isBackground(id, cwd, projects));
  });
}

module.exports = { withoutBackground, isBackground, kindOf, folderName };
