// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Claude Code's paths, and incremental reads of append-only files.
 *
 * Several parts of the extension need the same lookups: Claude Code's directory, the session id format, the project
 * folder holding a conversation's transcript, and which conversations still have one. They live here so that separate
 * copies cannot drift apart unnoticed, with one honouring CLAUDE_CONFIG_DIR and another not, or one walk skipping an
 * unreadable folder where another stops.
 *
 * Transcripts are append-only, so each reader keeps its offset and a pass reads only what was added since, in whole
 * lines (the last line may be mid-write). Readers of the same file that ask at the same moment share one pass, so a
 * transcript of several hundred megabytes is read only once.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
/* Re-exported for the modules that write files beside the plans; the one implementation is src/files.js. */
const { writeAtomic } = require('./files');

/** Claude Code's own directory: CLAUDE_CONFIG_DIR when set, as Claude Code reads it, and ~/.claude otherwise. */
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
/* One folder per starting directory, and in each one transcript per conversation, named by its session id. */
const projectsDir = () => path.join(claudeDir(), 'projects');

/* Where every plugin keeps its own data, and the name of the companion plugin's. The two are kept apart because a file
   watcher needs a base that already exists, and the plugin's is created when the plugin is installed, which may be
   after this extension has started. */
const dataRoot = () => path.join(claudeDir(), 'plugins', 'data');
const PLAN_DIR = require('./plugin-install').DATA_DIR;
const planDir = () => path.join(dataRoot(), PLAN_DIR);

/** A session id as Claude Code writes it. */
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * The project folders, or null when the projects folder itself cannot be read. A symbolic link to a directory counts,
 * since Claude Code reads and writes through it. A link whose target is missing now (a drive that is not mounted)
 * counts too, so listing it fails and nothing under it is treated as deleted.
 */
function projectFolders(projects = projectsDir()) {
  let entries;
  try { entries = fs.readdirSync(projects, { withFileTypes: true }); } catch (_) { return null; }
  const out = [];
  for (const e of entries) {
    const dir = path.join(projects, e.name);
    if (e.isDirectory()) out.push(dir);
    else if (e.isSymbolicLink()) {
      try { if (fs.statSync(dir).isDirectory()) out.push(dir); } catch (_) { out.push(dir); }
    }
  }
  return out;
}

/*
 * Transcript locations by session id, and when each search that found none may be tried again. Session ids are unique
 * across projects, so a location once found stays valid. A search stats a file in every project folder, of which there
 * can be thousands, so a miss is searched for again only after MISS_MS, then after twice as long each time, up to
 * MISS_MAX_MS: a conversation whose first message is not written yet turns up within seconds, and a plan whose
 * transcript was deleted would otherwise cost a full search on every pass.
 */
const MISS_MS = 10000;
const MISS_MAX_MS = 5 * 60000;
const found = new Map();
const missed = new Map();

/* projectFolders() for one projects folder, kept until that folder's modification time changes, which it does when a
   project folder is added or removed. */
let foldersKey = '', foldersList = null;
function knownFolders(projects) {
  let st;
  try { st = fs.statSync(projects); } catch (_) { return projectFolders(projects); }
  const key = projects + '\0' + st.mtimeMs;
  if (key !== foldersKey) {
    foldersList = projectFolders(projects);
    foldersKey = foldersList ? key : '';
  }
  return foldersList;
}

/** The transcript of one conversation, or '' when there is none. */
function transcriptOf(session, projects = projectsDir(), now = Date.now()) {
  if (!SESSION.test(String(session || ''))) return '';
  const key = projects + '\0' + session;
  const known = found.get(key);
  if (known && fs.existsSync(known)) return known;
  found.delete(key);
  const miss = missed.get(key);
  if (miss && now - miss.at < miss.wait) return '';
  for (const dir of knownFolders(projects) || []) {
    const file = path.join(dir, session + '.jsonl');
    if (fs.existsSync(file)) { missed.delete(key); found.set(key, file); return file; }
  }
  if (missed.size > 500) missed.clear();
  missed.set(key, { at: now, wait: miss ? Math.min(miss.wait * 2, MISS_MAX_MS) : MISS_MS });
  return '';
}

/**
 * Every session id that still has a transcript, or null when that could not be established.
 *
 * Null rather than a partial set: an unlistable project folder would make all its conversations look gone, and their
 * plans would be deleted. No transcripts at all also gives null; on such a machine skipping the cleanup loses nothing.
 *
 * Only the one level is read. Deeper down are the transcripts of sub-agents, which are not conversations.
 */
function liveSessions(projects = projectsDir()) {
  const folders = projectFolders(projects);
  if (!folders) return null;
  const live = new Set();
  for (const dir of folders) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return null; }
    for (const n of names) if (n.endsWith('.jsonl')) live.add(n.slice(0, -6));
  }
  return live.size ? live : null;
}

const CHUNK = 8 << 20;
/* The readers waiting for a pass over each file. A pass starts once the requests made at the same moment are in. */
const batches = new Map();

/**
 * Feed `reader` the complete lines of `file` after `reader.pos` and advance `reader.pos`. Resolves to false if the file
 * cannot be read.
 *
 * `reader.take(data, at)` is given a buffer of whole lines that starts at file offset `at`, in file order, and may be
 * called several times; the buffer is reused once it returns. A file shorter than `reader.pos` was replaced rather than
 * appended to, so it is read again from the start, after `reader.reset()` if the reader has one.
 */
function readLines(file, reader) {
  let batch = batches.get(file);
  if (!batch) {
    batch = { readers: [] };
    batches.set(file, batch);
    batch.done = new Promise((resolve) => setImmediate(resolve)).then(() => {
      batches.delete(file);
      return pass(file, batch.readers);
    });
  }
  batch.readers.push(reader);
  return batch.done;
}

async function pass(file, readers) {
  let size;
  try { size = (await fs.promises.stat(file)).size; } catch (_) { return false; }
  for (const r of readers) {
    if (r.pos > size) { r.pos = 0; if (r.reset) r.reset(); }
  }
  const from = Math.min(...readers.map((r) => r.pos));
  if (from >= size) return true;
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch (_) { return false; }
  try {
    const buf = Buffer.alloc(Math.min(CHUNK, size - from));
    let pos = from, carry = Buffer.alloc(0);
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (!bytesRead) break;
      const start = pos - carry.length;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const end = data.lastIndexOf(0x0a);
      if (end === -1) { carry = Buffer.from(data); continue; }
      const whole = data.subarray(0, end + 1), past = start + whole.length;
      for (const r of readers) {
        if (r.pos >= past) continue;
        const skip = Math.max(0, r.pos - start);
        r.take(whole.subarray(skip), start + skip);
        r.pos = past;
      }
      carry = Buffer.from(data.subarray(end + 1));
    }
  } finally {
    await fh.close();
  }
  return true;
}

/**
 * `run(key, opts)`, one at a time per key, with no request lost.
 *
 * A request made during a pass waits for the next one, because the running pass read the file before the request and
 * with another caller's options. All requests queued meanwhile share that next pass, with their options combined by
 * `merge`.
 */
function oneAtATime(run, merge = (a, b) => Object.assign({}, a, b)) {
  const running = new Map();
  const start = (key, opts) => {
    const slot = { next: null };
    running.set(key, slot);
    slot.done = Promise.resolve().then(() => run(key, opts)).finally(() => {
      if (running.get(key) === slot) running.delete(key);
      const next = slot.next;
      if (next) start(key, next.opts).done.then(next.resolve, next.reject);
    });
    return slot;
  };
  return (key, opts = {}) => {
    const slot = running.get(key);
    if (!slot) return start(key, opts).done;
    if (slot.next) { slot.next.opts = merge(slot.next.opts, opts); return slot.next.promise; }
    const next = { opts };
    next.promise = new Promise((resolve, reject) => { next.resolve = resolve; next.reject = reject; });
    slot.next = next;
    return next.promise;
  };
}

module.exports = {
  claudeDir, projectsDir, planDir, dataRoot, PLAN_DIR, SESSION, projectFolders, transcriptOf, liveSessions,
  readLines, oneAtATime, writeAtomic, MISS_MS, CHUNK,
};
