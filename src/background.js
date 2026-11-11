// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The `claude --bg` sessions a conversation started, for the panel's agent map.
 *
 * A detached session's own record names nobody but itself, so who launched it is read from the other side: the Bash call
 * that started it printed `backgrounded · <id>` into the launching conversation's transcript - a fixed template in the
 * CLI, followed by the attach, logs and stop hints, each of which names the id again. This host reads those from the
 * transcript of the conversation in front of the reader, and writes what it found to a small file beside that
 * conversation's plan.
 *
 * Those files are the shared state, not each host's memory. Every window builds the stylesheet from all of them, so two
 * windows looking at different conversations still write the same bytes; building it from what one window had scanned
 * would differ between windows, and the stylesheet is one file they all write - which is how settings once flickered.
 *
 * Reading is incremental (src/claude-files.js). The file records the transcript read offset for every conversation
 * scanned, including ones that launched no background session, so that a window starting up resumes from there instead
 * of the first byte; the first pass over a large conversation reads all of it once.
 *
 * A detached session is never opened from here. The panel launches Claude on whatever conversation it opens, so opening
 * one that a daemon is still writing would put a second process on it.
 */
const fs = require('fs');
const path = require('path');
const { claudeDir, planDir, SESSION, transcriptOf, readLines, oneAtATime, writeAtomic } = require('./claude-files');

const jobsDir = () => path.join(claudeDir(), 'jobs');
const SUFFIX = '.background';
const LINK_FILE = /^[0-9a-f][0-9a-f-]{7,}\.background$/i;
const SHORT_ID = /^[0-9a-f]{8}$/;
/* The CLI's own words, middle dot and all, at the start of a line. When the output went to a terminal the id is wrapped
   in colour codes. */
const MARK = Buffer.from('backgrounded · ', 'utf8');
const ID_AFTER = /^[ \t]*backgrounded · (?:\x1b\[[0-9;]*m)*([0-9a-f]{8})(?![0-9a-f])/gm;
/* The hints the CLI prints under that line, the command padded and followed by what it does. A launch piped through
   `tail` keeps only these, so each one is a launch in its own right. When the output went to a terminal the whole
   line is dimmed. */
const HINTS = ['open in this terminal', 'show recent output', 'stop this session'];
const HINT_NEEDLES = HINTS.map((h) => Buffer.from(h, 'utf8'));
const ID_IN_HINT = new RegExp('^(?:\\x1b\\[[0-9;]*m)*[ \\t]*claude (?:attach|logs|stop) ([0-9a-f]{8})[ \\t]+(?:'
  + HINTS.join('|') + ')', 'gm');
/* One of those commands alone on its line, which is all a launch piped through `grep -o 'claude attach [0-9a-f]*'`
   keeps. An `echo` leaves the same line, so it counts only for a session created while the call ran. */
const ID_ALONE = /^(?:\x1b\[[0-9;]*m)*[ \t]*claude (?:attach|logs|stop) ([0-9a-f]{8})(?:\x1b\[[0-9;]*m)*[ \t\r]*$/gm;
const ALONE_NEEDLES = ['claude attach ', 'claude logs ', 'claude stop '].map((s) => Buffer.from(s, 'utf8'));
/* Leeway on both sides of the call: the rows and the record are stamped by different processes. */
const DURING_SLACK_MS = 5000;
/* How much of a session's first prompt the launching command must contain, and the shortest prompt that is matched. */
const INTENT_CHARS = 80;
const MIN_INTENT = 12;
/* The flag that starts one, found in the command a tool result answers. */
const BG_FLAG = Buffer.from('--bg', 'utf8');
const NEEDLES = [BG_FLAG, MARK, ...HINT_NEEDLES, ...ALONE_NEEDLES];
/* Bump this when the scan starts recognising a launch it used to miss: link files written by an older version are then
   read again from the start, once. */
const READER = 3;
/* The stylesheet carries all of this to every panel on every change, so the caps are about its size, not about how
   many sessions anyone starts. */
const MAX_SESSIONS = 10;
const MAX_PER_SESSION = 20;
const MAX_ENTRIES = 40;
/* How far a scan may get ahead of what is on disk before the position is written down. It is only a starting point for
   the next window or the next start, so it does not have to be exact - only not so stale that a restart reads it all. */
const PERSIST_EVERY = 1 << 20;

const textOf = (b) => (typeof b.content === 'string' ? b.content
  : Array.isArray(b.content) ? b.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('') : '');

/*
 * One transcript line, read for launches. Every condition below has been met on its own by something that was not one.
 *
 * The output has to answer a command that ran `--bg`: a command that printed an earlier launch back - a grep over
 * another transcript, say - produced the very same line, at the start of it, for an id that was real and still had a
 * record, so nothing in the text could tell the two apart. The words have to open a line - indentation allowed, since a
 * command that indents its own output is common and was how the first live launch here went unseen - which keeps out
 * a launch quoted in passing; be followed by exactly eight hex digits, which keeps out a document describing the format; and
 * name a session that has a record. Either end of the CLI's output is enough: a launch whose output lost its hints is an
 * ordinary launch, and so is one whose output kept only the hints - `| tail -3` keeps the last three, and that is how a
 * live launch went unseen. A hint counts only with the words after it, so a command that echoes `claude stop <id>` is
 * not one. Without them, the command alone counts only if the session's record was created between the call and its
 * result; an echo of an older session's id fails that.
 *
 * `ran` carries the commands, and when each was made, across lines and passes, since a call and its result are
 * separate rows.
 */
function readLine(line, ran, jobs, seen) {
  let row;
  try { row = JSON.parse(line); } catch (_) { return; }
  const blocks = row && row.message && Array.isArray(row.message.content) ? row.message.content : [];
  const at = Date.parse(row && row.timestamp);
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'tool_use' && b.input && typeof b.input.command === 'string' && b.input.command.includes('--bg')) {
      ran.set(b.id, { at, command: b.input.command });
      if (ran.size > 500) ran.delete(ran.keys().next().value);
      continue;
    }
    if (b.type !== 'tool_result' || !ran.has(b.tool_use_id)) continue;
    const call = ran.get(b.tool_use_id);
    const text = textOf(b);
    let m, named = false;
    for (const re of [ID_AFTER, ID_IN_HINT]) {
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        named = true;
        if (!seen.has(m[1]) && fs.existsSync(path.join(jobs, m[1], 'state.json'))) seen.add(m[1]);
      }
    }
    ID_ALONE.lastIndex = 0;
    while ((m = ID_ALONE.exec(text))) {
      named = true;
      if (!seen.has(m[1]) && createdBetween(path.join(jobs, m[1], 'state.json'), call.at, at)) seen.add(m[1]);
    }
    if (!named) launchedBy(jobs, call, at, seen);
  }
}

const squash = (s) => (typeof s === 'string' ? s.replace(/[\\"'`]/g, '').replace(/\s+/g, ' ').trim() : '');

/*
 * When `| head -1` leaves only "Starting background service…", the output names no session, so the launch is matched by
 * its prompt: a session created while the call ran, whose first prompt appears in the command. Quotes and backslashes
 * are left out of both, since the shell takes them off the prompt it passes on.
 */
function launchedBy(jobs, call, to, seen) {
  if (!isFinite(call.at) || !isFinite(to)) return;
  const command = squash(call.command);
  let names;
  try { names = fs.readdirSync(jobs); } catch (_) { return; }
  for (const id of names) {
    if (!SHORT_ID.test(id) || seen.has(id)) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(jobs, id, 'state.json'), 'utf8')); } catch (_) { continue; }
    const t = Date.parse(d && d.createdAt);
    if (!isFinite(t) || t < call.at - DURING_SLACK_MS || t > to + DURING_SLACK_MS) continue;
    const intent = squash(d.intent).slice(0, INTENT_CHARS);
    if (intent.length >= MIN_INTENT && command.includes(intent)) seen.add(id);
  }
}

function createdBetween(file, from, to) {
  if (!isFinite(from) || !isFinite(to)) return false;
  let t;
  try { t = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).createdAt); } catch (_) { return false; }
  return isFinite(t) && t >= from - DURING_SLACK_MS && t <= to + DURING_SLACK_MS;
}

/*
 * `exists` says whether there was a link file at all.
 *
 * Parsed files are cached by modification time and size, so a pass rereads only the files that changed, and a pass over
 * a conversation whose transcript has not grown reads nothing.
 */
const links = new Map();
function readLink(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) {
    links.delete(file);
    return { ids: [], scannedTo: 0, launched: 0, exists: !(e && e.code === 'ENOENT') };
  }
  const was = links.get(file);
  if (was && was.mtimeMs === st.mtimeMs && was.size === st.size) return was.link;
  let d = null;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* caught mid-write, or not ours */ }
  const ids = d && Array.isArray(d.ids) ? d.ids.filter((x) => typeof x === 'string' && SHORT_ID.test(x)) : [];
  const scannedTo = d && d.reader === READER && typeof d.scannedTo === 'number' && d.scannedTo >= 0 ? d.scannedTo : 0;
  const launched = d && typeof d.launched === 'number' && isFinite(d.launched) ? d.launched : 0;
  const link = { ids, scannedTo, launched, exists: true };
  links.set(file, { mtimeMs: st.mtimeMs, size: st.size, link });
  return link;
}

/* What was written is kept as read, so the next pass does not read back the file it wrote itself. */
function writeLink(file, link) {
  writeAtomic(file, JSON.stringify(link) + '\n');
  try {
    const st = fs.statSync(file);
    links.set(file, { mtimeMs: st.mtimeMs, size: st.size,
      link: { ids: link.ids.slice(), scannedTo: link.reader === READER ? link.scannedTo : 0, launched: link.launched || 0,
        exists: true } });
  } catch (_) { /* read again next time */ }
}

/* Launch time of the newest of these sessions, from each session's own state.json, so that every window computes the
   same value; 0 when no record has one. */
function launchOf(ids, jobs) {
  let newest = 0;
  for (const id of ids) {
    try {
      const t = Date.parse(JSON.parse(fs.readFileSync(path.join(jobs, id, 'state.json'), 'utf8')).createdAt);
      if (isFinite(t) && t > newest) newest = t;
    } catch (_) { /* no record, or one being written */ }
  }
  return newest;
}

/**
 * Read what one conversation's transcript has added since last time.
 *
 * One pass runs at a time per conversation (oneAtATime in src/claude-files.js).
 */
function scan(session, opts = {}) {
  if (!SESSION.test(String(session || ''))) return Promise.resolve({ added: 0, scannedTo: 0 });
  return scanQueued(session, opts);
}

/* What this host has found per conversation, kept so that a write which lost a race with another window's write puts
   back what the other one did not know about, the next time this host writes. */
const known = new Map();
const commands = new Map();
/* How far this host has read each transcript, ahead of the file, which is written only every PERSIST_EVERY bytes. */
const readTo = new Map();

/*
 * Only lines containing a needle are parsed, in file order, so a call is seen before the result that answers it. Any
 * other tool result is parsed only when its tool_use_id belongs to a call that ran `--bg`: `head -1` can leave none of
 * the CLI's words in it.
 */
const RESULT_ID = Buffer.from('"tool_use_id":"', 'utf8');
function readChunk(data, ran, jobs, seen) {
  const last = data.length - 1;
  const starts = new Set(), results = new Map();
  for (const needle of NEEDLES) {
    let at = 0;
    while ((at = data.indexOf(needle, at)) !== -1 && at < last) {
      starts.add(data.lastIndexOf(0x0a, at) + 1);
      at = data.indexOf(0x0a, at) + 1;
    }
  }
  for (let at = 0; (at = data.indexOf(RESULT_ID, at)) !== -1 && at < last;) {
    const ls = data.lastIndexOf(0x0a, at) + 1, from = at + RESULT_ID.length;
    if (!starts.has(ls) && !results.has(ls)) results.set(ls, data.toString('utf8', from, data.indexOf(0x22, from)));
    at = data.indexOf(0x0a, at) + 1;
    if (at === 0) break;
  }
  for (const ls of [...starts, ...results.keys()].sort((a, b) => a - b)) {
    if (results.has(ls) && !ran.has(results.get(ls))) continue;
    readLine(data.subarray(ls, data.indexOf(0x0a, ls)).toString('utf8'), ran, jobs, seen);
  }
}

async function scanOnce(session, opts) {
  const dir = opts.dir || planDir();
  const jobs = opts.jobs || jobsDir();
  const transcript = opts.transcript || transcriptOf(session, opts.projects);
  if (!transcript) return { added: 0, scannedTo: 0 };
  const file = path.join(dir, session + SUFFIX);
  const link = readLink(file);
  const seen = new Set(link.ids);
  for (const id of known.get(session) || []) seen.add(id);
  if (!commands.has(session)) commands.set(session, new Map());
  const ran = commands.get(session);
  // A position past the end means the transcript was replaced rather than appended to, so it is read again in full.
  const reader = { pos: Math.max(link.scannedTo, readTo.get(session) || 0), take: (data) => readChunk(data, ran, jobs, seen) };
  if (!(await readLines(transcript, reader))) return { added: 0, scannedTo: 0 };
  const consumed = reader.pos;
  const ids = [...seen];
  known.set(session, ids);
  readTo.set(session, consumed);
  const fresh = ids.filter((id) => !link.ids.includes(id));
  /* Written even when nothing was launched (see the top of this file); collect() skips such files. */
  if (fresh.length || !link.exists || consumed - link.scannedTo >= PERSIST_EVERY) {
    const launched = Math.max(link.launched, launchOf(link.launched ? fresh : ids, jobs));
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeLink(file, Object.assign({ ids, scannedTo: consumed, reader: READER }, launched ? { launched } : {}));
    } catch (_) { /* the next pass writes it */ }
  }
  return { added: fresh.length, scannedTo: consumed };
}
const scanQueued = oneAtATime(scanOnce);

/* A state file is rewritten by the daemon while it runs, so a read can land on half of one. Then the last whole reading
   stands in for it rather than the session disappearing from the list for a refresh. */
const lastGood = new Map();
const CONTRACT = /^\s*<!--[\s\S]*?-->\s*/;
const clip = (v, n) => {
  const s = typeof v === 'string' ? v : '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const when = (v) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return isFinite(t) ? t : null;
};

function readState(id, jobs = jobsDir()) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(path.join(jobs, id, 'state.json'), 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') { lastGood.delete(id); return null; }
    return lastGood.get(id) || null;
  }
  if (!d || typeof d !== 'object') return lastGood.get(id) || null;
  const entry = {
    id,
    name: clip(d.name, 80),
    state: clip(d.state, 20),
    detail: clip(d.detail, 160),
    needs: clip(d.needs, 300),
    result: clip(d.output && typeof d.output === 'object' ? d.output.result : '', 400),
    // A task written to the conventions here opens with a comment block saying what the document is for; the task
    // itself is what comes after it.
    task: clip(String(typeof d.intent === 'string' ? d.intent : '').replace(CONTRACT, '').trim(), 300),
    tokens: typeof d.tokens === 'number' && isFinite(d.tokens) ? d.tokens : null,
    startedAt: when(d.createdAt),
    endedAt: when(d.lastTerminalAt) || when(d.firstTerminalAt),
  };
  lastGood.set(id, entry);
  return entry;
}

/* Sort key of the list: when the link file's conversation last launched a session. A file written before that was
   recorded falls back to its sessions' own records, computed once per version of the file. */
function launchedFor(file, link, jobs) {
  if (link.launched) return link.launched;
  const entry = links.get(file);
  if (!entry) return launchOf(link.ids, jobs);
  if (entry.order === undefined) entry.order = launchOf(link.ids, jobs);
  return entry.order;
}

/**
 * Every recorded session, trimmed to what the panel shows, for the stylesheet.
 *
 * Newest launch first, not by the files' modification times: a file is rewritten as its transcript is read, which says
 * nothing about its sessions, and every rewrite would reorder the list and with it the stylesheet every panel reloads.
 */
function collect(opts = {}) {
  const dir = opts.dir || planDir();
  const jobs = opts.jobs || jobsDir();
  let names;
  try { names = fs.readdirSync(dir).filter((n) => LINK_FILE.test(n)); } catch (_) { return []; }
  const files = [];
  for (const n of names) {
    const file = path.join(dir, n), link = readLink(file);
    if (link.ids.length) files.push({ n, t: launchedFor(file, link, jobs), ids: link.ids });
  }
  files.sort((a, b) => b.t - a.t || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
  const out = [];
  for (const { n, ids } of files.slice(0, MAX_SESSIONS)) {
    const session = n.slice(0, -SUFFIX.length);
    for (const id of ids.slice(-MAX_PER_SESSION)) {
      const entry = readState(id, jobs);
      if (entry) out.push(Object.assign({ session }, entry));
      if (out.length >= MAX_ENTRIES) return out;
    }
  }
  return out;
}

/* Signal 0 only checks; EPERM still means the process exists. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/*
 * Job ids of busy `claude --bg` sessions, read from ~/.claude/sessions/<pid>.json, the files `claude agents` lists.
 * Status "busy" is a turn in progress and "shell" a command still running. Records of dead processes are skipped.
 */
const BUSY = new Set(['busy', 'shell']);
function busyJobs(dir = path.join(claudeDir(), 'sessions'), isAlive = alive) {
  const out = new Set();
  let names;
  try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch (_) { return out; }
  for (const n of names) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { continue; }
    if (!d || d.kind !== 'bg' || !BUSY.has(d.status) || typeof d.jobId !== 'string' || !SHORT_ID.test(d.jobId)) continue;
    if (Number.isInteger(d.pid) && isAlive(d.pid)) out.add(d.jobId);
  }
  return out;
}

/* Session ids of the conversations with a busy `claude --bg` session. */
function working(opts = {}) {
  const dir = opts.dir || planDir();
  const busy = opts.busy || busyJobs(opts.sessions);
  const out = new Set();
  if (!busy.size) return out;
  let names;
  try { names = fs.readdirSync(dir).filter((n) => LINK_FILE.test(n)); } catch (_) { return out; }
  for (const n of names) {
    if (readLink(path.join(dir, n)).ids.some((id) => busy.has(id))) out.add(n.slice(0, -SUFFIX.length));
  }
  return out;
}

module.exports = {
  scan, collect, readState, busyJobs, working,
  SUFFIX, LINK_FILE, MAX_SESSIONS, MAX_PER_SESSION, MAX_ENTRIES, PERSIST_EVERY,
};
