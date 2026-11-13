// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Passes a message from a steward into a conversation it manages.
 * A message between sessions never counts as the user's consent in the conversation that receives it; text typed into
 * that conversation's message input does. The steward speaks for the user: it words each message for the conversation
 * it goes to, and what it sends counts there as the user's own message, approvals included. So the steward does not
 * send it itself: the plugin's hooks/steward-relay.py leaves a request in RELAY_DIR of the plan directory, and the
 * window that shows the conversation checks the request and types the text into its input (src/page/91-answer.js).
 *
 * Any process can write a request file, so a request is carried out only if the steward conversation sent it: the
 * steward the user ticked the conversation for in the Steward panel ran steward-relay.py itself, in the last RAN_MS,
 * with a command that names the conversation and holds the text (ranBy). Each such tool call is carried out once.
 *
 *   <plan dir>/relay/<id>.json          { id, steward, to, text, at }    written by steward-relay.py
 *   <plan dir>/relay/<id>.taken-<pid>   the request, claimed by window <pid> with a rename
 *   <plan dir>/relay/<id>.result.json   { outcome, reason }              read and removed by steward-relay.py
 *   <plan dir>/relay/sent.json          { "<steward> <to> <tool call id>": <ms> }
 */
const fs = require('fs');
const path = require('path');
const { SESSION, writeAtomic } = require('./claude-files');

const RELAY_DIR = 'relay';
const REQUEST = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
/* Requests older than this are dropped; steward-relay.py stops waiting before then. */
const MAX_AGE_MS = 60000;
/* How long before a request the steward's call of steward-relay.py may have been made. */
const RAN_MS = 5 * 60000;
/* Bytes read from the end of the steward's transcript to find that call. */
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 4000;
const SENT_FILE = 'sent.json';
const SENT_KEEP_MS = 24 * 3600000;
const SCRIPT = 'steward-relay.py';

/*
 * The steward's own call of steward-relay.py that sent `text` to conversation `to`, from the end of its transcript:
 * { id, at } of the newest tool call by the steward itself, not by a subagent, made in the last RAN_MS, whose command
 * names the conversation and holds the text, or null. Claude Code writes a tool call to the transcript before it runs
 * it, so the call is there while the script waits for an answer.
 */
function ranBy(file, to, text, now = Date.now()) {
  let tail = '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - from);
    const got = fs.readSync(fd, buf, 0, buf.length, from);
    tail = buf.toString('utf8', 0, got);
    if (from > 0) tail = tail.slice(tail.indexOf('\n') + 1);
  } catch (_) { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* closed */ } }
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.indexOf('"tool_use"') === -1 || line.indexOf(SCRIPT) === -1) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || r.type !== 'assistant' || r.isSidechain || !r.message || !Array.isArray(r.message.content)) continue;
    const at = Date.parse(r.timestamp);
    if (!(now - at <= RAN_MS) || at > now + 60000) continue;
    for (const b of r.message.content) {
      const c = b && b.type === 'tool_use' && b.input && typeof b.input.command === 'string' ? b.input.command.replace(/\r\n/g, '\n') : '';
      if (c.includes(SCRIPT) && c.toLowerCase().includes(to) && c.includes(text)) return { id: String(b.id || r.uuid || ''), at };
    }
  }
  return null;
}

function readSent(dir, now) {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(path.join(dir, SENT_FILE), 'utf8')) || {}; } catch (_) { /* none yet */ }
  for (const [k, at] of Object.entries(d)) if (!(typeof at === 'number' && now - at < SENT_KEEP_MS)) delete d[k];
  return d;
}

/*
 * Carries out the requests in `planDir` for conversations this window shows. deps: shownHere(id), stewards() -> the
 * stewards table (src/stewards.js), transcriptOf(id), deliver(id, text) -> Promise<{ outcome, reason }> (the Answer
 * view's delivery, src/claude-source.js), pid, now(). Returns the results it wrote.
 */
async function take(planDir, deps) {
  const dir = path.join(planDir, RELAY_DIR);
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const now = deps.now ? deps.now() : Date.now();
  const done = [];
  for (const name of names) {
    const m = REQUEST.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    let req;
    try { req = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
    if (!req || typeof req.to !== 'string' || !(now - req.at < MAX_AGE_MS)) {
      if (req && now - req.at >= MAX_AGE_MS) { try { fs.unlinkSync(file); } catch (_) { /* taken meanwhile */ } }
      continue;
    }
    const to = req.to.toLowerCase();
    if (!SESSION.test(to) || !deps.shownHere(to)) continue;
    const taken = path.join(dir, `${m[1]}.taken-${deps.pid}`);
    try { fs.renameSync(file, taken); } catch (_) { continue; }
    const result = await carryOut(req, to, dir, deps, now);
    try { writeAtomic(path.join(dir, m[1] + '.result.json'), JSON.stringify(result) + '\n'); } catch (_) { /* the script reports no answer */ }
    try { fs.unlinkSync(taken); } catch (_) { /* gone */ }
    done.push(Object.assign({ id: m[1], to }, result));
  }
  return done;
}

async function carryOut(req, to, dir, deps, now) {
  const steward = String(req.steward || '').toLowerCase();
  if (!SESSION.test(steward)) return { outcome: 'refused', reason: 'the request does not say which steward sent it' };
  const t = (deps.stewards() || {})[steward];
  if (!t || !t.manages.includes(to)) return { outcome: 'refused', reason: 'that conversation is not one this steward manages' };
  const text = String(req.text || '').trim();
  if (!text || text.length > MAX_TEXT) return { outcome: 'refused', reason: `there is no text, or it is longer than ${MAX_TEXT} characters` };
  const file = deps.transcriptOf(steward);
  const call = file ? ranBy(file, to, text, now) : null;
  if (!call) {
    return { outcome: 'refused', reason: `the steward conversation has not run ${SCRIPT} for that conversation with this text `
      + 'in its command in the last 5 minutes; give the text in a here-document in the command itself' };
  }
  const key = [steward, to, call.id].join(' ');
  const sent = readSent(dir, now);
  if (sent[key]) return { outcome: 'refused', reason: 'that call already passed this text to that conversation' };
  const r = await deps.deliver(to, text);
  if (r && r.outcome === 'submitted') {
    sent[key] = now;
    try { writeAtomic(path.join(dir, SENT_FILE), JSON.stringify(sent) + '\n'); } catch (_) { /* a repeat is then not caught */ }
  }
  return { outcome: (r && r.outcome) || 'uncertain', reason: (r && r.reason) || '' };
}

module.exports = { take, ranBy, RELAY_DIR, MAX_AGE_MS, RAN_MS, SENT_FILE };
