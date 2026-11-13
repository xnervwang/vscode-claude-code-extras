// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Relays the user's own words from a steward into a conversation it manages.
 * A message between sessions never counts as the user's consent in the conversation that receives it; text typed into
 * that conversation's message input does. So the steward does not send the words itself: the plugin's
 * hooks/steward-relay.py leaves a request in RELAY_DIR of the plan directory, and the window that shows the
 * conversation checks the request and types the words into its input (src/page/91-answer.js).
 *
 * A request is carried out only if its text is the user's, word for word: a whole sentence or clause of a message the
 * user typed in the steward conversation in the last RECENT_MS. Whole: it begins at the start of that message or right
 * after punctuation or a line break, and ends the same way (see edge), so a clause is not cut out of a longer one: a
 * Chinese negation is written straight before the verb, and without this rule "may change" could be taken out of
 * "may not change". A repeat of a relay already sent (same words, same message, same conversation) is refused.
 *
 *   <plan dir>/relay/<id>.json          { id, steward, to, text, at }       written by steward-relay.py
 *   <plan dir>/relay/<id>.taken-<pid>   the request, claimed by window <pid> with a rename
 *   <plan dir>/relay/<id>.result.json   { outcome, reason }                 read and removed by steward-relay.py
 *   <plan dir>/relay/sent.json          { "<steward> <to> <message uuid> <text>": <ms> }
 */
const fs = require('fs');
const path = require('path');
const { SESSION, writeAtomic } = require('./claude-files');

const RELAY_DIR = 'relay';
const REQUEST = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
/* Requests older than this are dropped; steward-relay.py stops waiting before then. */
const MAX_AGE_MS = 60000;
/* Only messages the user typed within this window count. */
const RECENT_MS = 30 * 60000;
/* Bytes read from the end of the steward's transcript to find those messages. */
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 4000;
const SENT_FILE = 'sent.json';
const SENT_KEEP_MS = 24 * 3600000;
/* How Claude Code starts a message it received from another session. */
const NOT_TYPED = /^(?:Another Claude session sent a message|A peer session sent a message|<cross-session-message|<task-notification)/;

/* Characters a sentence or clause can start or end next to: ASCII and CJK punctuation, quotes, brackets and dashes.
   A space counts only beside words that are not English letters or digits, so in "don't push" it is not an edge,
   while between an English name and the Chinese words after it, it is. */
const PUNCT = new RegExp('[\\r\\n.!?;:,"\'()<>\\[\\]\\-~\\u3001\\u3002\\uFF0E\\uFF01\\uFF1F\\uFF1B\\uFF1A\\uFF0C'
  + '\\u3008-\\u3011\\u2018\\u2019\\u201C\\u201D\\uFF08\\uFF09\\u2013\\u2014\\u2026\\uFF5E]');
const SPACE = /[ \t\u3000]/;
const LATIN = /[A-Za-z0-9]/;
/* Whether text[i], with i stepping away from the clause by `step`, is a clause edge for the clause's end char `inside`.
   Spaces next to punctuation count with it, as in "Tell it: Go ahead". */
const edge = (text, i, step, inside) => {
  if (i < 0 || i >= text.length || PUNCT.test(text[i]) || PUNCT.test(inside)) return true;
  if (!SPACE.test(text[i])) return false;
  if (!LATIN.test(inside)) return true;
  while (i >= 0 && i < text.length && SPACE.test(text[i])) i += step;
  return i < 0 || i >= text.length || PUNCT.test(text[i]);
};

/* The messages the user typed in a transcript in the last RECENT_MS, newest first: [{ uuid, text, at }]. */
function userMessages(file, now = Date.now()) {
  let text = '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    text = buf.toString('utf8');
    if (from > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch (_) { return []; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* closed */ } }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"type":"user"') === -1) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || r.type !== 'user' || r.isMeta || r.isSidechain || (r.origin && r.origin.kind !== 'human')) continue;
    const at = Date.parse(r.timestamp);
    if (!(now - at <= RECENT_MS) || at > now + 60000) continue;
    const c = r.message && r.message.content;
    const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).filter((t) => !/^\s*</.test(t)) : [];
    const said = parts.join('\n').trim();
    // A transcript written by a Claude Code build that records no `origin`: a message from another session is then
    // known by its first line.
    if (!r.origin && (!said || NOT_TYPED.test(said))) continue;
    if (said) out.push({ uuid: String(r.uuid || ''), text: said, at });
  }
  return out.reverse();
}

/* The first message in `messages` that holds `words` as a whole sentence or clause, or null. */
function saidBy(words, messages) {
  const w = String(words || '').trim();
  if (w.length < 2 || w.length > MAX_TEXT) return null;
  for (const m of messages) {
    for (let at = m.text.indexOf(w); at !== -1; at = m.text.indexOf(w, at + 1)) {
      if (edge(m.text, at - 1, -1, w[0]) && edge(m.text, at + w.length, 1, w[w.length - 1])) return m;
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
  const file = deps.transcriptOf(steward);
  const said = file ? saidBy(req.text, userMessages(file, now)) : null;
  if (!said) {
    return { outcome: 'refused', reason: 'the text is not a whole sentence or clause, word for word, of a message the user typed here in the last 30 minutes' };
  }
  const text = String(req.text).trim();
  const key = [steward, to, said.uuid, text].join(' ');
  const sent = readSent(dir, now);
  if (sent[key]) return { outcome: 'refused', reason: 'these words from that message were already passed to that conversation' };
  const r = await deps.deliver(to, text);
  if (r && r.outcome === 'submitted') {
    sent[key] = now;
    try { writeAtomic(path.join(dir, SENT_FILE), JSON.stringify(sent) + '\n'); } catch (_) { /* a repeat is then not caught */ }
  }
  return { outcome: (r && r.outcome) || 'uncertain', reason: (r && r.reason) || '' };
}

module.exports = { take, userMessages, saidBy, RELAY_DIR, MAX_AGE_MS, RECENT_MS, SENT_FILE };
