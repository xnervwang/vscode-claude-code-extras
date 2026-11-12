// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Stewards: a conversation the user asked to watch other conversations. It becomes one when the user ticks another
 * conversation for it in the Steward panel (src/steward-view.js), and stops being one when nothing is ticked.
 *
 * Who manages whom is kept in stewards.json in the plan directory, so every window and the plugin's steward hook
 * (claude-plugin/agent-work-plan/hooks/steward.py) read the same answer. Only the panel writes it, so a steward cannot
 * change what it manages. One conversation can be managed by several stewards.
 *
 *   { "version": 1, "stewards": { "<steward session id>": { "manages": ["<session id>", ...],
 *                                                          "names": { "<session id>": "title" }, "at": <ms> } } }
 *
 * The titles are the ones the panel showed when the file was last written; the hook prints them, since it has no other
 * cheap way to name a conversation that is not running.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { planDir, SESSION, writeAtomic } = require('./claude-files');

const FILE = 'stewards.json';
const MAX_MANAGED = 100;
const MAX_NAME = 200;
/* How long to wait for a steward's inbox to accept a notice. */
const POST_TIMEOUT_MS = 3000;

const ids = (list, not) => [...new Set((Array.isArray(list) ? list : [])
  .filter((x) => typeof x === 'string' && SESSION.test(x) && x !== not).map((x) => x.toLowerCase()))].slice(0, MAX_MANAGED);

/** steward id -> { manages, names, at }, leaving out anything malformed and stewards that manage nothing. */
function read(dir = planDir()) {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')); } catch (_) { /* none yet, or caught mid-write */ }
  const out = {};
  const all = d && d.stewards && typeof d.stewards === 'object' ? d.stewards : {};
  for (const [id, v] of Object.entries(all)) {
    if (!SESSION.test(id) || !v || typeof v !== 'object') continue;
    const manages = ids(v.manages, id.toLowerCase());
    if (!manages.length) continue;
    const names = {};
    for (const m of manages) if (v.names && typeof v.names[m] === 'string') names[m] = v.names[m].slice(0, MAX_NAME);
    out[id.toLowerCase()] = { manages, names, at: typeof v.at === 'number' && isFinite(v.at) ? v.at : 0 };
  }
  return out;
}

function write(all, dir) {
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, FILE), JSON.stringify({ version: 1, stewards: all }, null, 1) + '\n');
}

/**
 * Sets what `steward` manages to `list`, with the titles in `names`; an empty list removes it from the table. Returns
 * the whole table as written.
 */
function setManaged(steward, list, names = {}, { dir = planDir(), now = Date.now() } = {}) {
  const all = read(dir);
  if (typeof steward !== 'string' || !SESSION.test(steward)) return all;
  const id = steward.toLowerCase();
  const manages = ids(list, id);
  if (manages.length) {
    const kept = {};
    for (const m of manages) {
      const t = names && typeof names[m] === 'string' ? names[m] : all[id] && all[id].names[m];
      if (typeof t === 'string' && t) kept[m] = t.slice(0, MAX_NAME);
    }
    all[id] = { manages, names: kept, at: now };
  } else delete all[id];
  write(all, dir);
  return all;
}

/** Refreshes the saved titles. Writes the file only if a title changed. */
function rename(names, { dir = planDir() } = {}) {
  const all = read(dir);
  let changed = false;
  for (const v of Object.values(all)) {
    for (const m of v.manages) {
      const t = typeof names[m] === 'string' ? names[m].slice(0, MAX_NAME) : '';
      if (t && v.names[m] !== t) { v.names[m] = t; changed = true; }
    }
  }
  if (changed) write(all, dir);
  return changed;
}

/*
 * The notices a steward is sent when one of its conversations stops: a turn that ended, or a conversation that started
 * waiting for the user. `before` and `after` map a session id to its state in the Conversations view's words
 * (working, prompt, unread, idle). A conversation seen for the first time sends nothing.
 */
function changes(before, after, manages) {
  const out = [];
  for (const id of manages) {
    const was = before.get(id), now = after.get(id);
    if (was === undefined || now === undefined || was === now) continue;
    if (now === 'prompt') out.push({ id, what: 'waiting' });
    else if (was === 'working' && (now === 'idle' || now === 'unread')) out.push({ id, what: 'done' });
  }
  return out;
}

/* Said to the steward, which reads it as a note from this extension rather than from the user. */
function noticeText(list, names) {
  const line = (c) => {
    const name = names[c.id] ? `"${names[c.id]}"` : 'a conversation';
    return c.what === 'waiting' ? `- ${name} (${c.id}) is waiting for the user.`
      : `- ${name} (${c.id}) finished its turn.`;
  };
  return 'Steward notice from Claude Code Plus, not a message from the user. Conversations you manage changed:\n'
    + list.map(line).join('\n')
    + '\nLook at them with the steward skill\'s steward-peek.py. If none of it needs the user, reply with a single "-" and nothing else.';
}

/*
 * Posts `text` to a session's inbox socket, which Claude Code documents for scripts posting into a session
 * (https://code.claude.com/docs/en/cross-session-messaging.md, "The session's inbox socket"). The line it reads is not
 * documented; this is the shape Claude Code 2.1.322 takes (test/against-latest.js checks the newest release still does).
 * An idle session starts a turn with it. Not on native Windows, where a connection must first authenticate with a token
 * only the session itself holds.
 */
function post(address, text, { from = 'claude-code-plus', timeoutMs = POST_TIMEOUT_MS, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    if (platform === 'win32' || typeof address !== 'string' || !address) { resolve(false); return; }
    const where = address.startsWith('uds:') ? address.slice(4) : address;
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    let sock;
    try { sock = net.connect(where); } catch (_) { finish(false); return; }
    const timer = setTimeout(() => { try { sock.destroy(); } catch (_) { /* gone */ } finish(false); }, timeoutMs);
    sock.on('error', () => { clearTimeout(timer); finish(false); });
    sock.on('connect', () => {
      sock.end(JSON.stringify({ type: 'user', message: { content: text }, from }) + '\n', () => { clearTimeout(timer); finish(true); });
    });
  });
}

module.exports = { read, setManaged, rename, changes, noticeText, post, FILE, MAX_MANAGED };
