// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Extra lines for a steward's notices (src/steward-view.js): the tool call that keeps a conversation waiting for the
 * user, and the background sessions and `claude -p` workers it started that ended without finishing. Also, per
 * steward, what it has been told, in NOTICES_DIR of the plan directory, so that a reload does not repeat it.
 */
const fs = require('fs');
const path = require('path');
const background = require('./background');
const { writeAtomic, SESSION } = require('./claude-files');

const NOTICES_DIR = 'steward-notices';
/* Bytes read from the end of a transcript to find its latest tool calls. */
const TAIL_BYTES = 512 * 1024;
const MAX_SUMMARY = 300;
/* Tools that run a subagent; the subagent's own calls are in its own transcript. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/* The state of a `claude --bg` session that finished. One whose process is gone while it is still "blocked" (waiting
   for an answer) or "working" died: a 429 or a killed daemon leaves it like that. */
const DONE = 'done';

function tailRecords(file, bytes = TAIL_BYTES) {
  let text = '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, from = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - from);
    const got = fs.readSync(fd, buf, 0, buf.length, from);
    text = buf.toString('utf8', 0, got);
    if (from > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch (_) { return []; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* closed */ } }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || (line.indexOf('"assistant"') === -1 && line.indexOf('"user"') === -1)) continue;
    try { const r = JSON.parse(line); if (r && !r.isSidechain && (r.type === 'assistant' || r.type === 'user')) out.push(r); } catch (_) { /* cut */ }
  }
  return out;
}

const blocks = (r) => (r.message && Array.isArray(r.message.content) ? r.message.content : []);

/*
 * The tool call a conversation is waiting on: of the calls made since the user's latest message, the earliest that has
 * no result yet, as { name, input }, or null. Claude Code writes a call to the transcript before it asks for permission
 * to run it.
 */
function pendingCall(file) {
  const answered = new Set();
  let call = null;
  const records = tailRecords(file);
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i], bs = blocks(r);
    if (r.type === 'user') {
      if (bs.some((b) => b && b.type === 'tool_result')) { for (const b of bs) if (b && b.tool_use_id) answered.add(b.tool_use_id); continue; }
      if (!r.isMeta) break;
      continue;
    }
    for (let j = bs.length - 1; j >= 0; j--) {
      const b = bs[j];
      if (b && b.type === 'tool_use' && !answered.has(b.id)) call = { name: String(b.name || ''), input: b.input || {} };
    }
  }
  if (!call || !SUBAGENT_TOOLS.has(call.name)) return call;
  // A subagent asking for permission: its own transcript, the newest under <session>/subagents/, has the call.
  const dir = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  let newest = '', at = 0;
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.jsonl')) continue;
      const t = fs.statSync(path.join(dir, n)).mtimeMs;
      if (t > at) { at = t; newest = path.join(dir, n); }
    }
  } catch (_) { return call; }
  const inner = newest ? pendingCall(newest) : null;
  return inner ? Object.assign({ subagent: true }, inner) : call;
}

const oneLine = (s, n = MAX_SUMMARY) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function waitingOn(file) {
  const c = file ? pendingCall(file) : null;
  if (!c) return '';
  const i = c.input;
  if (c.name === 'AskUserQuestion') {
    const q = Array.isArray(i.questions) && i.questions[0] ? i.questions[0].question : '';
    return 'an answer to a question it asked the user' + (q ? ': ' + oneLine(q) : '');
  }
  if (c.name === 'ExitPlanMode') return 'the user\'s approval of its plan';
  const what = i.command || i.file_path || i.notebook_path || i.url || i.pattern || i.description || '';
  return `the user's answer to a permission prompt for ${c.subagent ? 'a subagent\'s ' : ''}${c.name}${what ? ': ' + oneLine(what) : ''}`;
}

/*
 * Keys of the background work started by `session` that is still running: "job:<id>" for a `claude --bg` session and
 * "worker:<session id>" for a `claude -p` worker, from the link file src/background.js keeps beside the plan.
 * `records` are the live session records (src/background.js liveRecords).
 */
function runningWork(session, records, dir) {
  const link = background.readLink(path.join(dir, session + background.SUFFIX));
  if (!link.ids.length && !link.workers.length) return [];
  const jobs = new Set(), sessions = new Set();
  for (const d of records || []) {
    if (d && d.kind === 'bg' && typeof d.jobId === 'string') jobs.add(d.jobId);
    if (d && typeof d.sessionId === 'string') sessions.add(d.sessionId.toLowerCase());
  }
  // A `claude --bg` session's id starts with its job id, and the link file can hold it among the workers too.
  return link.ids.filter((id) => jobs.has(id)).map((id) => 'job:' + id)
    .concat(link.workers.filter((w) => sessions.has(w) && !link.ids.includes(w.slice(0, 8))).map((w) => 'worker:' + w));
}

/*
 * Whether the conversation stopped or removed job `id` itself, as a tool call near the end of its transcript. The CLI
 * is often run through a variable ("$CC" stop <id>), and several jobs through a loop (for j in <id> ...; do "$CC" rm
 * $j), so the command is read for the subcommand and the id rather than for "claude stop".
 */
function stoppedBy(file, id) {
  const direct = new RegExp(`\\b(?:stop|rm)\\s+["']?${id}\\b`);
  const loop = new RegExp(`\\bfor\\s+(\\w+)\\s+in\\s+[^;\\n]*\\b${id}\\b[\\s\\S]*?\\b(?:stop|rm)\\s+["']?\\$\\{?\\1\\b`);
  for (const r of file ? tailRecords(file, 2 * 1024 * 1024) : []) {
    for (const b of blocks(r)) {
      const c = b && b.type === 'tool_use' && b.input && typeof b.input.command === 'string' ? b.input.command : '';
      if (c.includes(id) && (direct.test(c) || loop.test(c))) return true;
    }
  }
  return false;
}

/*
 * Returns '' for work that finished or that its own conversation stopped, null when the records do not say, and
 * otherwise the notice's words for it. `last` is the state the job had at the last look, which is all there is to go
 * by when its record has been removed since. deps: transcriptOf(id), readState(id) (src/background.js).
 */
function howEnded(key, session, deps, last = '') {
  if (key.startsWith('job:')) {
    const id = key.slice(4), st = deps.readState(id);
    if ((st ? st.state : last) === DONE) return '';
    if (stoppedBy(deps.transcriptOf(session), id)) return '';
    const name = st && st.name ? `"${st.name}" ` : '';
    return `background session ${name}(${id}) ended without finishing: ${st ? 'its state is ' + (st.state || 'not set') : 'it left no record'}`;
  }
  const id = key.slice(7);
  const records = SESSION.test(id) ? tailRecords(deps.transcriptOf(id)) : [];
  if (!records.length) return null;
  const end = records[records.length - 1];
  const finished = end.type === 'assistant' && !blocks(end).some((b) => b && b.type === 'tool_use');
  return finished ? '' : `\`claude -p\` worker (${id.slice(0, 8)}) ended in the middle of a turn`;
}

/*
 * What this steward has been told: { running: { <session>: { <key>: <state at the last look> } }, asked: { <session>:
 * [questions] }, twice: { <session>: <pids of the processes running it> }, stoppedAt: <time of the last stop told> }.
 * A file from the build before states were kept lists the keys alone.
 */
function load(dir, steward) {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(path.join(dir, NOTICES_DIR, steward + '.json'), 'utf8')); } catch (_) { /* none yet */ }
  const map = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const running = {};
  for (const [id, v] of Object.entries(map(d && d.running))) {
    running[id] = Array.isArray(v) ? Object.fromEntries(v.filter((k) => typeof k === 'string').map((k) => [k, ''])) : map(v);
  }
  return { running, asked: map(d && d.asked), twice: map(d && d.twice), stoppedAt: Number(d && d.stoppedAt) || 0 };
}

function save(dir, steward, state) {
  const file = path.join(dir, NOTICES_DIR, steward + '.json');
  const text = JSON.stringify(state) + '\n';
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch (_) { /* none yet */ }
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeAtomic(file, text); } catch (_) { /* told again after a reload */ }
}

module.exports = { pendingCall, waitingOn, runningWork, howEnded, stoppedBy, load, save, NOTICES_DIR };
