// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The work plan: what each conversation still has to do, read from a file the conversation itself maintains.
 *
 * One file per conversation, in the data directory the platform gives the companion Claude Code plugin:
 *
 *   ~/.claude/plugins/data/agent-work-plan-claude-code-extras/<session id>.json
 *
 * That location is not a choice of ours - it is what a plugin is given, created when the plugin is installed. The two
 * nearby places are both wrong for it: ~/.claude/scratch is one person's own convention and means nothing on another
 * machine, and ~/.claude/projects is Claude Code's own namespace, where a file of ours would sooner or later collide
 * with something official.
 *
 * A session id is unique across every project on a machine, so it is the whole name and no grouping directory is needed.
 *
 * Agent Plus draws them.
 *
 * Nothing here writes those files. The shape below is the whole contract between the two halves:
 *
 *   { "title": "optional name for this conversation",
 *     "nodes": [ { "title": "...", "state": "discussing|todo|doing|waiting|parked|done|dropped",
 *                  "note": "optional, read in the dialog and the hover rather than on the row",
 *                  "detail": "optional, several lines; what the row cannot say in its width",
 *                  "opened": "optional ISO 8601; when this row was added",
 *                  "since": "optional ISO 8601; when it entered the state it is in",
 *                  "closed": "optional ISO 8601; when it reached done or dropped",
 *                  "waitingOn": "optional, on a waiting or discussing row: user|build|someone|session|other",
 *                  "question": "optional, with waitingOn user: the one question the user has to answer",
 *                  "asked": "optional ISO 8601; when that question was put",
 *                  "children": [ ... ] } ] }
 *
 * A child is something that has to be finished before its parent can be, whether that was planned or discovered on the
 * way. Nesting means exactly that and nothing else - not the order topics came up in.
 *
 * Reading is forgiving about a file that is absent or half-written, since it is written by another process and may be
 * caught mid-write. It is NOT forgiving quietly: a file that exists and cannot be parsed comes back as an entry with an
 * error on it, so the view can say so. A plan that silently shows nothing is indistinguishable from no work left.
 */
const fs = require('fs');
const path = require('path');
/* The plan directory and the list of live transcripts come from src/claude-files.js; the directory name derives from
   the plugin and marketplace names. */
const { dataRoot, PLAN_DIR, planDir, projectsDir, liveSessions } = require('./claude-files');
const { readBounded } = require('./bounded');

/*
 * Per-conversation files in the plan directory, deleted with their conversation: each is named by session id plus one
 * of these suffixes, and other files there are left alone.
 *
 *   .json        the plan itself
 *   .offered     the Stop hook offered once to start a plan where none existed; otherwise the only trace of a
 *                conversation that declined would accumulate for ever
 *   .nudged      the Stop hook has reminded the conversation to reconcile its plan, so it does not say it again
 *   .settled     which `doing` rows the Stop hook last asked to move on, so it does not ask about them again
 *   .background  which detached sessions the conversation started (src/background.js)
 *   .turn        which turn the conversation is in and how far it has got, left by the injection hook
 *   .watermark   which context marks have asked it to bring the plan up to date before a compaction
 *   .tz          what the time-zone hook last told it
 *   .effort      where each reply's effort changed (src/efforts.js)
 */
const SIDE_SUFFIXES = ['.json', '.offered', '.nudged', '.settled', require('./background').SUFFIX, '.turn', '.watermark', '.tz',
  require('./efforts').SUFFIX];
const SIDE_FILE = new RegExp('^[0-9a-f][0-9a-f-]{7,}(?:' + SIDE_SUFFIXES.map((s) => s.replace('.', '\\.')).join('|') + ')$', 'i');
const PLAN_FILE = /^[0-9a-f][0-9a-f-]{7,}\.json$/i;
/* Plan lock directories (<plan>.lock), made with mkdir around a read-change-write. Writers give up on one older than
   ten seconds (LOCK_STALE in plan_path.py), so the sweep can remove any older than LOCK_STALE_MS, a day. */
const LOCK = /\.lock$/i;
const LOCK_STALE_MS = 24 * 60 * 60 * 1000;
/* The same list as STATES in the plugin's plan_path.py, in the same order; test/check.js holds them together. */
const STATES = ['discussing', 'todo', 'doing', 'waiting', 'parked', 'done', 'dropped'];
/* Who a held-up row waits on: the same list as WAITING_ON in plan_path.py, held together by test/check.js. A value not
   in it, or none, reads as '' - not known - since a row written before the field existed says it only in its note. */
const WAITING_ON = ['user', 'build', 'someone', 'session', 'other'];
const MAX_QUESTION_CHARS = 200;
const MAX_STATE_CHARS = 40;
/* Depth and count are bounded because the file is written by another process: a cycle turned into JSON, or a runaway
   generator, would otherwise be rendered forever. Both are far above any plan a person reads. */
const MAX_DEPTH = 8;
const MAX_NODES = 2000;
/*
 * How much of a description the work plan view will show, in lines as well as characters - thirty short lines are as
 * unreadable as one long paragraph, so a character count alone would not hold.
 *
 * It is a real limit rather than a safety valve, and there is deliberately no roomier view to escape into. A description
 * is what the next person needs in order to pick the task up; somewhere comfortable to write at length is an invitation
 * to write the history of the task instead, and a plan of histories is one nobody reads. The file keeps whatever was
 * cut, so nothing is lost - it simply is not made pleasant.
 */
const MAX_DETAIL_LINES = 12;
const MAX_DETAIL_CHARS = 900;

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* Where the limit bites it says so, and says it is the description that is at fault rather than the view: a description
   that stopped mid-sentence with nothing marking the cut reads as one that was written that way. */
function detail(v) {
  const s = text(v, MAX_DETAIL_CHARS * 4);
  const lines = s.split('\n');
  let out = lines.slice(0, MAX_DETAIL_LINES).join('\n');
  let cut = lines.length > MAX_DETAIL_LINES;
  if (out.length > MAX_DETAIL_CHARS) {
    out = out.slice(0, MAX_DETAIL_CHARS);
    cut = true;
  }
  if (!cut) return out;
  return out.replace(/\s+$/, '')
    + `\n\n[too long: a description is kept to ${MAX_DETAIL_LINES} lines and ${MAX_DETAIL_CHARS} characters.`
    + ' The rest is in the file, and belongs somewhere other than a task.]';
}

/* A timestamp as milliseconds, or 0 for absent and for anything unparseable. Zero rather than null so a row that
   carries no time and a row that carries a broken one read the same to the view: in both cases there is nothing true to
   show, and drawing "Invalid Date" on a row would be worse than drawing nothing. */
function when(v) {
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : 0;
}

/** One node and its children, keeping only the fields the view draws. Returns null for anything unusable. */
function node(raw, depth, budget) {
  if (!raw || typeof raw !== 'object' || budget.left <= 0) return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  budget.left--;
  /* An unknown state from a newer writer is kept so the row can show it. A row with no state predates states: todo. */
  const named = typeof raw.state === 'string' ? raw.state.trim().slice(0, MAX_STATE_CHARS) : '';
  const state = STATES.includes(named) ? named : (named || 'todo');
  const children = [];
  if (depth < MAX_DEPTH && Array.isArray(raw.children)) {
    for (const child of raw.children) {
      const c = node(child, depth + 1, budget);
      if (c) children.push(c);
    }
  }
  const waitingOn = WAITING_ON.includes(raw.waitingOn) ? raw.waitingOn : '';
  const question = waitingOn === 'user' ? text(raw.question, MAX_QUESTION_CHARS * 2).replace(/\s+/g, ' ') : '';
  return {
    title, state, note: text(raw.note, 120), detail: detail(raw.detail),
    opened: when(raw.opened), since: when(raw.since), closed: when(raw.closed), waitingOn, question,
    asked: question ? when(raw.asked) : 0, children,
  };
}

function readPlanAt(file, session, max = Infinity) {
  if (!file || !session) return null;
  const body = readBounded(file, max);
  if (!body) return null;
  const entry = { session, file, title: '', nodes: [], error: '' };
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (e) {
    // Half-written is the ordinary case for a file another process is replacing, and it fixes itself on the next read;
    // anything else is a real defect in what wrote it and has to be visible.
    entry.error = e.message;
    return entry;
  }
  entry.title = text(parsed && parsed.title, 120);
  const budget = { left: MAX_NODES };
  if (parsed && Array.isArray(parsed.nodes)) {
    for (const raw of parsed.nodes) {
      const n = node(raw, 0, budget);
      if (n) entry.nodes.push(n);
    }
  }
  return entry;
}

/** The plan for one session id, or null if that conversation has none. */
function readPlan(session) {
  return session ? readPlanAt(path.join(planDir(), session + '.json'), session) : null;
}

/* A plan younger than this is left alone whatever the transcripts say. Its real job is not to wait longer - a transcript
   survives months of silence before Claude Code removes it - but to be certain that nothing still being written is ever
   touched, whatever went wrong with the reading of the transcripts. */
const SETTLED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete the plans of conversations that no longer exist. Returns a summary for the log and `live`, the conversations
 * that still have a transcript, which is null when that is unknown and nothing was deleted.
 *
 * A conversation whose transcript is gone can never be resumed, so its plan is a file nothing can reach: not this view,
 * which reads only the conversation in front of the reader, and not Claude Code. Left alone they only accumulate - at the
 * rate this machine starts conversations, thousands within a year.
 *
 * It deletes rather than moving them aside. An archive was the first shape of this and it was the wrong one: it has no
 * bound, so the files it saves from deletion are the same files somebody has to deal with later.
 */
function sweepOrphans(opts = {}) {
  const now = opts.now || Date.now();
  const dir = opts.dir || planDir();
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { names = null; }
  /* Abandoned locks are removed regardless of the transcripts, since each one delays every writer of that plan until it
     times out. rmdir only removes an empty directory. */
  for (const name of names || []) {
    if (!LOCK.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.lstatSync(file);
      if (st.isDirectory() && now - st.mtimeMs > LOCK_STALE_MS) fs.rmdirSync(file);
    } catch (_) { /* released meanwhile, or not empty */ }
  }
  const live = liveSessions(opts.projects || projectsDir());
  if (!live) return { deleted: 0, kept: 0, live: null, why: 'the transcripts could not all be read, so nothing was treated as abandoned' };
  if (!names) return { deleted: 0, kept: 0, live, why: '' };
  let deleted = 0, kept = 0;
  for (const name of names) {
    if (!SIDE_FILE.test(name)) continue;
    // The session id is the name without its last extension, whichever of the side files it is.
    if (live.has(name.replace(/\.[^.]+$/, ''))) { kept++; continue; }
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch (_) { continue; }
    if (now - st.mtimeMs < SETTLED_MS) { kept++; continue; }
    // Already gone means another window got here first, which is the ordinary outcome of two of them starting on one
    // day rather than a fault: several extension hosts share this directory and nothing locks it.
    try { fs.unlinkSync(file); deleted++; }
    catch (e) { if (e.code !== 'ENOENT') kept++; }
  }
  return { deleted, kept, live, why: '' };
}

/** The states that mean a row still needs something done to it. */
const OPEN_STATES = ['discussing', 'todo', 'doing', 'waiting', 'parked'];

module.exports = {
  readPlan, readPlanAt, planDir, liveSessions, sweepOrphans,
  dataRoot, PLAN_DIR, PLAN_FILE, SIDE_SUFFIXES, SETTLED_MS, LOCK_STALE_MS, OPEN_STATES,
  STATES, MAX_DEPTH, MAX_NODES, MAX_DETAIL_LINES, MAX_DETAIL_CHARS, WAITING_ON, MAX_QUESTION_CHARS,
};
