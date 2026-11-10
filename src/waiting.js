// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The running conversations of this workspace, read from `claude agents --json` (src/claude-source.js lists them).
 *
 * `claude --bg` sessions are left out. Their questions go through the conversation that started them. `claude agents`
 * reports one resumed with `claude -p --resume` as interactive, so inFolders also reads the sessionKind in its transcript.
 *
 * The conversations come from `claude agents --json`, which Claude Code documents as the supported way for a script to
 * read session state. Its records are per process, and one conversation can be held by two processes at once - two
 * windows that both opened it - each under its own name, so they are merged by session id before anything is counted.
 *
 * Only the plans of those running conversations are read, so the cost follows how many conversations are open rather
 * than how many have ever existed.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { transcriptOf } = require('./claude-files');
const bgSessions = require('./bgsessions');
/* Real paths are compared, so a folder reached through a symbolic link still matches. */
const { folderTest } = require('./folders');

const AGENTS_TIMEOUT_MS = 15000;
/* The end of a transcript, where Claude Code appends the conversation's title again every turn. */
const TAIL_BYTES = 256 * 1024;

/** The records `claude agents --json` printed, or null when they cannot be read. */
function parseAgents(stdout) {
  let list;
  try { list = JSON.parse(String(stdout || '')); } catch (_) { return null; }
  if (!Array.isArray(list)) return null;
  return list.filter((r) => r && typeof r === 'object' && typeof r.sessionId === 'string' && r.sessionId);
}

/** Run `claude agents --json` with the given binary. Resolves to { records, error }; records is null on failure. */
function listAgents(bin, run = cp.execFile) {
  return new Promise((resolve) => {
    if (!bin) { resolve({ records: null, error: 'Claude Code\'s command line was not found' }); return; }
    run(bin, ['agents', '--json'], { timeout: AGENTS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const records = parseAgents(stdout);
        if (records) { resolve({ records, error: '' }); return; }
        const said = String(stderr || '').trim().split('\n').pop() || (err && err.message) || 'it printed no list';
        resolve({ records: null, error: '`claude agents --json`: ' + said });
      });
  });
}

/* Claude Code's default name for a conversation: the folder name and two hex digits. */
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function isDefaultName(name, cwd) {
  const m = /^(.*)-[0-9a-f]{2}$/.exec(String(name || ''));
  return !!m && slug(m[1]) === slug(path.basename(String(cwd || '')));
}

/**
 * The records merged into one per conversation. A conversation is waiting if any process holding it is, and keeps the
 * name somebody chose over a default one.
 */
function merge(records) {
  const by = new Map();
  for (const r of records || []) {
    if (!r || typeof r.sessionId !== 'string' || !r.sessionId) continue;
    let s = by.get(r.sessionId);
    if (!s) {
      s = { sessionId: r.sessionId, id: '', kind: '', cwd: '', name: '', waitingFor: '', busy: false, processes: 0 };
      by.set(r.sessionId, s);
    }
    s.processes++;
    if (!s.id && typeof r.id === 'string') s.id = r.id;
    if (r.kind === 'background') s.kind = 'background';
    else if (!s.kind && typeof r.kind === 'string') s.kind = r.kind;
    if (!s.cwd && typeof r.cwd === 'string') s.cwd = r.cwd;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (name && (!s.name || (isDefaultName(s.name, s.cwd) && !isDefaultName(name, s.cwd)))) s.name = name;
    if (r.status === 'waiting') s.waitingFor = String(r.waitingFor || '').trim() || s.waitingFor || 'input';
    if (r.status === 'busy') s.busy = true;
  }
  return by;
}

/**
 * A conversation's process ids from `claude agents`, in ascending order (two windows can hold one conversation). With
 * claudeCode.claudeProcessWrapper set, these are the claude processes, not the wrapper.
 */
function pidsOf(records, sessionId) {
  const out = new Set();
  for (const r of records || []) {
    if (r && r.sessionId === sessionId && Number.isInteger(r.pid) && r.pid > 0) out.add(r.pid);
  }
  return [...out].sort((a, b) => a - b);
}

/** Drops background sessions, and sessions started outside `folders`. */
function inFolders(sessions, folders, { isBackground = bgSessions.isBackground } = {}) {
  const inside = folderTest(folders);
  const out = new Map();
  for (const [id, s] of sessions) {
    if (s.kind === 'background' || !s.cwd) continue;
    if (inside(s.cwd) && !isBackground(id, s.cwd)) out.set(id, s);
  }
  return out;
}

/**
 * The titles a transcript carries near its end: the one the user gave, and the one Claude Code generated. Claude Code
 * writes both again every turn, so the last few hundred kilobytes hold the current ones however long the file is.
 */
function transcriptTitles(file) {
  const out = { custom: '', ai: '' };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && !(out.custom && out.ai); i--) {
      const l = lines[i];
      if (!out.custom && l.includes('"type":"custom-title"')) {
        try { out.custom = String(JSON.parse(l).customTitle || '').trim(); } catch (_) { /* cut at the start of the tail */ }
      } else if (!out.ai && l.includes('"type":"ai-title"')) {
        try { out.ai = String(JSON.parse(l).aiTitle || '').trim(); } catch (_) { /* cut at the start of the tail */ }
      }
    }
  } catch (_) { /* no transcript yet, or unreadable: the other names stand in */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* closed */ } }
  return out;
}

/**
 * Transcript lookups, kept between calls: a transcript's path, and the titles near its end, which are read again only
 * when the file has changed.
 */
function reader() {
  const paths = new Map(), seen = new Map();
  const fileOf = (sessionId) => {
    const known = paths.get(sessionId);
    if (known && fs.existsSync(known)) return known;
    const found = transcriptOf(sessionId) || '';
    if (found) paths.set(sessionId, found);
    return found;
  };
  const stat = (file) => { try { return fs.statSync(file); } catch (_) { return null; } };
  return {
    titles(s) {
      const file = fileOf(s.sessionId), st = file && stat(file);
      if (!st) return { custom: '', ai: '' };
      const key = st.size + ':' + st.mtimeMs, hit = seen.get(file);
      if (hit && hit.key === key) return hit.titles;
      const titles = transcriptTitles(file);
      seen.set(file, { key, titles });
      return titles;
    },
    /* Claude Code does not report when a wait began. A waiting session stops writing its transcript, so the transcript's
       modification time stands in for it. */
    since(s) {
      const file = fileOf(s.sessionId), st = file && stat(file);
      return st ? st.mtimeMs : 0;
    },
  };
}

module.exports = {
  parseAgents, listAgents, isDefaultName, merge, pidsOf, folderTest, inFolders, transcriptTitles, reader,
};
