// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Finds conversations that two Claude Code editor processes run at once. This happens when a window goes away but its
 * extension host stays, waiting for the window to reconnect (up to the server's reconnection grace time). Its claude
 * processes keep going while the reopened window runs the same conversation in a new host. Both write the same
 * transcript, and nobody sees the old one's replies.
 *
 * Only processes under a VS Code extension host count. A `claude -p --resume <id>` that carries a conversation on runs
 * under a shell or init, and a `claude --bg` session has its own record kind, so neither is a second process here.
 *
 * The page of each Claude Code panel messages its host every ALIVE_MS (src/page/99-sweep.js), and the host writes the
 * time it last heard into its window entry as pageAt (src/steward-view.js). A host that has heard nothing for NO_PAGE_MS
 * has no window. An entry without pageAt, as older builds write, counts as having one.
 */
const fs = require('fs');
const path = require('path');
const { transcriptOf, writeAtomic } = require('./claude-files');

const ALIVE_MS = 60000;
/* Chromium runs the timers of a page that has been hidden a while once a minute at most. */
const NO_PAGE_MS = 5 * 60000;
/* A process counts as idle once neither its transcript nor its status has changed for this long. */
const IDLE_MS = 2 * 60000;
const HOST_ARG = '--type=extensionHost';
const MAX_HOPS = 6;
const STOPPED_DIR = 'stopped';
const STOPPED_KEEP_MS = 24 * 3600000;

function stat(proc, pid) {
  try {
    const s = fs.readFileSync(path.join(proc, String(pid), 'stat'), 'latin1');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(f[1]), start: f[19] };
  } catch (_) { return null; }
}
function args(proc, pid) {
  try { return fs.readFileSync(path.join(proc, String(pid), 'cmdline'), 'latin1').split('\0').join(' '); } catch (_) { return ''; }
}

/* The pid of the extension host above `pid`, or 0. */
function hostOf(pid, proc) {
  let p = pid;
  for (let i = 0; i < MAX_HOPS; i++) {
    const st = stat(proc, p);
    if (!st || st.ppid <= 1) return 0;
    p = st.ppid;
    if (args(proc, p).includes(HOST_ARG)) return p;
  }
  return 0;
}

/* The window entries of src/steward-view.js, by host pid. */
function windowsIn(dir) {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'windows')).filter((n) => /^\d+\.json$/.test(n)); } catch (_) { return out; }
  for (const n of names) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, 'windows', n), 'utf8'));
      if (d && typeof d === 'object') out.set(Number(n.slice(0, -5)), d);
    } catch (_) { /* being written */ }
  }
  return out;
}

const windowName = (w) => String((w && w.name) || '').replace(/\s*\[[^\]]*\]\s*$/, '');

/*
 * Session id -> the processes running it, for each conversation run by several editor processes: [{ pid, procStart,
 * startedAt, host, window, windowless, idle }], oldest first. `records` are the live session records
 * (src/background.js liveRecords).
 */
function find({ records, dir, proc = '/proc', now = Date.now(), transcript = transcriptOf }) {
  const by = new Map();
  for (const r of records || []) {
    if (!r || r.kind === 'bg' || !Number.isInteger(r.pid) || typeof r.sessionId !== 'string') continue;
    const id = r.sessionId.toLowerCase();
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(r);
  }
  const out = new Map();
  let wins = null;
  for (const [id, rs] of by) {
    if (rs.length < 2) continue;
    const procs = [];
    for (const r of rs) {
      const host = hostOf(r.pid, proc);
      if (host) procs.push({ r, host });
    }
    if (procs.length < 2) continue;
    if (!wins) wins = windowsIn(dir);
    let written = 0;
    try { written = fs.statSync(transcript(id)).mtimeMs; } catch (_) { /* none yet */ }
    out.set(id, procs.map(({ r, host }) => {
      const w = wins.get(host);
      return {
        pid: r.pid, procStart: typeof r.procStart === 'string' ? r.procStart : '', startedAt: Number(r.startedAt) || 0, host,
        window: windowName(w),
        windowless: !!(w && typeof w.pageAt === 'number' && now - w.pageAt > NO_PAGE_MS),
        idle: r.status === 'idle' && now - (Number(r.statusUpdatedAt) || 0) > IDLE_MS && now - written > IDLE_MS,
      };
    }).sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid));
  }
  return out;
}

/* A process's pid, start time and window, as the Steward panel and a steward's notice put it. */
function describe(p) {
  const at = p.startedAt ? new Date(p.startedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'at an unknown time';
  const where = p.windowless ? 'in an extension host whose window is gone' : p.window ? `in window "${p.window}"` : 'in a window not known here';
  return `pid ${p.pid}, started ${at}, ${where}`;
}

/* The idle processes in hosts with no window, to be stopped without asking; none unless another process has a window. */
function autoStops(group) {
  return group.some((p) => !p.windowless) ? group.filter((p) => p.windowless && p.idle) : [];
}
/* The one the Stop button stops: one in a host with no window, otherwise the oldest. */
function oldOne(group) {
  return group.find((p) => p.windowless) || group[0];
}

/*
 * Stops process `p` of conversation `id`, unless its pid now belongs to another process, and records the stop in
 * STOPPED_DIR for the steward's notices. Returns whether it was stopped.
 */
function stop(id, p, how, { dir, proc = '/proc', kill = (pid) => process.kill(pid, 'SIGTERM'), now = Date.now() } = {}) {
  const st = stat(proc, p.pid);
  if (!st || (p.procStart && st.start !== p.procStart)) return false;
  try { kill(p.pid); } catch (_) { return false; }
  try {
    fs.mkdirSync(path.join(dir, STOPPED_DIR), { recursive: true });
    const file = path.join(dir, STOPPED_DIR, `${p.pid}-${p.procStart || 0}.json`);
    if (!fs.existsSync(file)) writeAtomic(file, JSON.stringify({ session: id, pid: p.pid, startedAt: p.startedAt, window: p.window,
      windowless: p.windowless, how, at: now }) + '\n');
  } catch (_) { /* stopped, but the steward is not told */ }
  return true;
}

/* The stops recorded since `since`, newest last, pruning those older than STOPPED_KEEP_MS. */
function stopped(dir, since, now = Date.now()) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(path.join(dir, STOPPED_DIR)).filter((n) => n.endsWith('.json')); } catch (_) { return out; }
  for (const n of names) {
    const file = path.join(dir, STOPPED_DIR, n);
    let d = null;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
    if (!d || !(now - d.at < STOPPED_KEEP_MS)) { try { fs.unlinkSync(file); } catch (_) { /* gone */ } continue; }
    if (d.at > since) out.push(d);
  }
  return out.sort((a, b) => a.at - b.at);
}

module.exports = { find, autoStops, oldOne, stop, stopped, describe, hostOf, ALIVE_MS, NO_PAGE_MS, IDLE_MS, STOPPED_DIR };
