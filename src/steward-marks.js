// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Titles for a steward's tab and session list row (stewards are in src/stewards.js). If the user named the conversation,
 * the name stays; otherwise the title becomes "Steward of N conversations". The title Claude Code generates comes from
 * the first message, and a steward's first message is usually one it was asked to relay, so that title would describe
 * another conversation's work. A bell is appended in both cases.
 *
 * Nothing is written to the transcript. When it stops managing any conversation, its usual title is shown again.
 */
const fs = require('fs');
const path = require('path');
const stewards = require('./stewards');

const BELL = '\u{1F6CE}\uFE0F';
const ENDS = [' ' + BELL, ' \u{1F6CE}'];

function label(n) {
  return `Steward of ${n} conversation${n === 1 ? '' : 's'}`;
}

/** `title` without a bell this module put at its end. */
function withoutBell(title) {
  const text = String(title == null ? '' : title);
  const end = ENDS.find((e) => text.endsWith(e));
  return end ? text.slice(0, -end.length) : text;
}

/** A steward's title: the user's name for it if there is one, else "Steward of n conversations", then a bell. */
function stewardTitle(custom, n) {
  const own = withoutBell(String(custom || '').trim()).trim();
  return (own || label(n)) + ' ' + BELL;
}

/* After a conversation stops being a steward, its own title is sent for this long, so every panel restores it. */
const UNDO_MS = 10 * 60000;

/*
 * Returns the session list entries with steward titles applied. The panel replaces a row's title only when the new one
 * arrives as customTitle, so the steward title, and later the restored title, are sent in that field. `marks` maps each
 * marked conversation to the time it stopped being a steward (0 while it still is); this function updates it.
 * `named(id)` returns the name the user gave a conversation. The entry's customTitle cannot answer that, since it also
 * holds the title Claude Code generated.
 */
function marked(entries, table, marks = new Map(), now = Date.now(), named = () => '') {
  if (!Array.isArray(entries)) return entries;
  for (const [id, until] of marks) if (until && now - until > UNDO_MS) marks.delete(id);
  if (!Object.keys(table || {}).length && !marks.size) return entries;
  return entries.map((e) => {
    const raw = e && (e.sessionId || e.id);
    const id = typeof raw === 'string' ? raw.toLowerCase() : '';
    const t = id && table && table[id];
    if (t) {
      marks.set(id, 0);
      return Object.assign({}, e, { customTitle: stewardTitle(named(id), t.manages.length) });
    }
    if (!id || !marks.has(id)) return e;
    if (!marks.get(id)) marks.set(id, now);
    const own = e.customTitle || e.summary;
    return own ? Object.assign({}, e, { customTitle: own }) : e;
  });
}

/* stewards.read, cached until the file's size or modification time changes. */
function tableReader(dir) {
  let key = null, table = {};
  return () => {
    let st = null;
    try { st = fs.statSync(path.join(dir, stewards.FILE)); } catch (_) { /* none */ }
    const k = st ? st.size + ':' + st.mtimeMs : '';
    if (k !== key) { key = k; table = st ? stewards.read(dir) : {}; }
    return table;
  };
}

/*
 * Computes a tab's title. current: the title shown now. kept: what this function last set ({ original, shown }), or
 * null. custom: the user's name for the conversation. n: how many conversations it manages, 0 if none. own: the
 * conversation's own title. Returns { title, kept }. A current title other than the one last set came from Claude Code
 * and becomes the one to restore, unless it is a steward title itself: the panel can copy the list's title to the tab.
 */
function tabTitle(current, kept, custom, n, own) {
  let original = kept && kept.shown === current ? kept.original : current;
  if (withoutBell(original) !== original) original = own || withoutBell(original);
  if (!n) return { title: original, kept: null };
  const shown = stewardTitle(custom, n);
  return { title: shown, kept: { original, shown } };
}

module.exports = { BELL, label, withoutBell, stewardTitle, marked, tableReader, tabTitle };
