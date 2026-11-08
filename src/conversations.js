// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Builds the list for the Conversations view (src/conversations-view.js).
 *
 * Running conversations come from `claude agents --json`, limited to this window's workspace folders and without
 * `claude --bg` sessions (src/waiting.js). Stopped ones are added when their plan, written in the last week, still has
 * open rows. assemble() builds the same list from every registered source (src/sources.js), including Claude Code's.
 *
 * A conversation's state (turn running, permission prompt, unread reply, idle) is Claude Code's. Its plan adds the
 * `doing` rows and the questions on rows waiting on the user; any question marks the conversation as needing the user.
 */
const fs = require('fs');
const path = require('path');
const waiting = require('./waiting');
const { planDir, transcriptOf } = require('./claude-files');
const { OPEN_STATES } = require('./workplan');

/* Stopped conversations are listed only while their plan was written within this many days. */
const CLOSED_DAYS = 7;
const HEAD_BYTES = 64 * 1024;

/* Sort order: what most needs the user comes first. */
const RANK = { prompt: 0, needs: 1, working: 2, unread: 3, idle: 4 };

/** State from Claude Code alone; build() then lets plan questions override it. */
function stateOf(s, live, unread) {
  const now = live && live.get(s.sessionId);
  if (now === 'waiting' || s.waitingFor) return 'prompt';
  if (now === 'running' || s.busy) return 'working';
  if (unread && unread.has(s.sessionId)) return 'unread';
  return 'idle';
}

function doingRows(nodes, prefix = '', out = []) {
  (nodes || []).forEach((n, i) => {
    const num = (prefix ? prefix + '.' : '') + (i + 1);
    if (n.state === 'doing') out.push({ row: num, title: n.title, since: n.since || 0 });
    doingRows(n.children, num, out);
  });
  return out;
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

/* A source that gives no plan path is believed about hasPlan. */
function entry(c, plan, located) {
  const nodes = plan && plan.nodes;
  const questions = waiting.planQuestions(nodes).map((q) => ({
    row: q.num, title: q.title, question: q.question, since: q.since, state: q.state, note: q.note, detail: q.detail }));
  let state = c.running ? c.state : 'idle';
  if (questions.length && state !== 'prompt') state = 'needs';
  const top = nodes && nodes.find((n) => OPEN_STATES.includes(n.state));
  return {
    sessionId: c.sessionId, id: c.id || '', kind: c.kind || '', cwd: c.cwd, running: c.running, state, questions,
    doing: doingRows(nodes), open: openCount(nodes), hasPlan: located || plan ? !!(plan && !plan.error) : c.hasPlan === true,
    title: c.title || (plan && plan.title) || (top && top.title) || c.sessionId,
    since: c.lastActiveAt || 0,
  };
}

const order = (a, b) => (RANK[a.state] - RANK[b.state]) || (b.since - a.since);

/**
 * Every conversation to show: { running: [...], stopped: [...], asks }, where asks counts the questions of the running
 * ones. `sessions` and `stopped` are maps as merge() makes them; `live` maps a session id to the state the host reports
 * and `unread` holds the ids with a reply not read yet.
 */
function build({ sessions, stopped = new Map(), readPlan, titles, since, live = new Map(), unread = new Set(), now = Date.now() }) {
  const one = (s, running) => {
    const plan = readPlan(s.sessionId);
    return entry({ sessionId: s.sessionId, id: s.id, kind: s.kind, cwd: s.cwd, running,
      state: running ? stateOf(s, live, unread) : 'idle', title: claudeTitle(s, titles(s), () => plan),
      lastActiveAt: since(s) || 0 }, plan, true);
  };
  const running = [...sessions.values()].map((s) => one(s, true)).sort(order);
  const stoppedList = [...stopped.values()].map((s) => one(s, false)).sort(order);
  return { running, stopped: stoppedList, asks: running.reduce((n, c) => n + c.questions.length, 0), at: now };
}

const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch (_) { return 0; } };

/*
 * build() for every registered source, with Claude Code's filters applied to all of them. Rows are keyed by (sourceId,
 * sessionId), since two sources can use the same session id.
 */
function assemble({ lists, folders, planOf, now = Date.now(), modified = mtimeOf, inFolder = waiting.folderTest(folders) }) {
  const running = [], stopped = [], seen = new Set();
  for (const { sourceId, conversations } of lists || []) {
    for (const c of conversations || []) {
      const key = JSON.stringify([sourceId, c.sessionId]);
      if (seen.has(key) || !c.cwd || !inFolder(c.cwd)) continue;
      const { plan, file } = planOf(sourceId, c.sessionId);
      if (!c.running) {
        if (!plan || !openCount(plan.nodes)) continue;
        const at = file ? modified(file) : 0;
        if (!at || now - at > CLOSED_DAYS * 86400e3) continue;
      }
      seen.add(key);
      (c.running ? running : stopped).push(Object.assign(entry(c, plan, !!file), { sourceId }));
    }
  }
  running.sort(order);
  stopped.sort(order);
  return { running, stopped, asks: running.reduce((n, c) => n + c.questions.length, 0), at: now };
}

module.exports = { build, assemble, entry, claudeTitle, stateOf, doingRows, openCount, transcriptCwd, stoppedWithOpenRows, RANK,
  CLOSED_DAYS };
