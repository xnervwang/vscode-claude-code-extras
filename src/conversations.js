// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const fs = require('fs');
const path = require('path');
const waiting = require('./waiting');
const { planDir, transcriptOf } = require('./claude-files');
const { OPEN_STATES } = require('./workplan');

/* Stopped conversations are listed only while their plan was written within this many days. */
const CLOSED_DAYS = 7;
const HEAD_BYTES = 64 * 1024;

/** State from Claude Code alone. */
function stateOf(s, live, unread) {
  const now = live && live.get(s.sessionId);
  if (now === 'waiting' || s.waitingFor) return 'prompt';
  if (now === 'running' || s.busy) return 'working';
  if (unread && unread.has(s.sessionId)) return 'unread';
  return 'idle';
}

function openCount(nodes) {
  return (nodes || []).reduce((n, x) => n + (OPEN_STATES.includes(x.state) ? 1 : 0) + openCount(x.children), 0);
}

/* The folder a transcript was started in, from the `cwd` its first records carry. Kept per file: it does not change. */
const cwdSeen = new Map();
function transcriptCwd(file) {
  if (cwdSeen.has(file)) return cwdSeen.get(file);
  let cwd = '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
    if (m) cwd = JSON.parse('"' + m[1] + '"');
  } catch (_) { /* not readable: not listed */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* closed */ } }
  if (cwd) cwdSeen.set(file, cwd);
  return cwd;
}

/** Stopped conversations in `folders` with a plan written in the last CLOSED_DAYS that has open rows, as merge() records. */
function stoppedWithOpenRows(folders, running, { dir = planDir(), now = Date.now(), readPlan, find = transcriptOf } = {}) {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^[0-9a-f-]{36}\.json$/i.test(n)); } catch (_) { return out; }
  for (const name of names) {
    const id = name.slice(0, -5);
    if (running.has(id)) continue;
    try { if (now - fs.statSync(path.join(dir, name)).mtimeMs > CLOSED_DAYS * 86400e3) continue; } catch (_) { continue; }
    const plan = readPlan(id);
    if (!plan || !openCount(plan.nodes)) continue;
    const file = find(id);
    const cwd = file ? transcriptCwd(file) : '';
    if (!cwd) continue;
    const s = { sessionId: id, id: '', kind: 'interactive', cwd, name: '', waitingFor: '', busy: false, processes: 0 };
    if (waiting.inFolders(new Map([[id, s]]), folders).size) out.set(id, s);
  }
  return out;
}

/* planOf() is called only when the first three titles are missing, so a titled conversation does not read its plan. */
function claudeTitle(s, t, planOf) {
  const named = s.name && !waiting.isDefaultName(s.name, s.cwd) ? s.name : '';
  if (t.custom || named || t.ai) return t.custom || named || t.ai;
  const plan = planOf();
  const top = plan && plan.nodes && plan.nodes.find((n) => OPEN_STATES.includes(n.state));
  return (plan && plan.title) || (top && top.title) || s.name || s.id || s.sessionId;
}

module.exports = { claudeTitle, stateOf, openCount, transcriptCwd, stoppedWithOpenRows, CLOSED_DAYS };
