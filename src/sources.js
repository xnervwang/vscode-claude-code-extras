// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Conversation sources: Claude Code's own (src/claude-source.js) and any registered by another extension through
 * `workPlanHost.registerSource()`. A source object belongs to another extension but runs in this process, so every read
 * and call on it goes through get() or call().
 *
 *   { protocol: 3, features: [],              protocol major; names of the optional methods it implements
 *     id, label, logo: { light, dark },       a conversation is identified by (id, sessionId)
 *     planPath(sessionId), planDir(),         plan files use the format described in src/workplan.js
 *     sessionForTab(tab), onDidFocus,         see Focus below
 *     listConversations(), onDidChangeConversations,
 *     reveal(sessionId), canDeliver(sessionId), deliverAnswer(sessionId, text) }
 *
 * A source is accepted when `protocol` is in MAJORS. Methods added to the interface later are called only if the source
 * lists them in `features` (optional()). No editor API here: test/check.js loads this file directly.
 */

const PROTOCOL = 3;
const MAJORS = [3];
const FEATURES = [];
/* Answer files written before answers carried a source id belong to this source. */
const BUILTIN = 'claude-code';
/* A source never reports `needs`; the host derives it from the questions in the plan. */
const STATES = ['prompt', 'working', 'unread', 'idle'];
const MAX_ID = 200;
/* Applies to other extensions' sources only. */
const MAX_CONVERSATIONS = 2000;

/* A getter can throw or return a different value on each read, so each property is read once and that value is used. */
const get = (o, key) => { try { return o == null ? undefined : o[key]; } catch (_) { return undefined; } };
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/* Ids are used exactly as given, so one that would need changing is rejected. encodeURIComponent() throws on an
   unpaired surrogate. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const usableId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID && v === v.trim() && !LONE_SURROGATE.test(v);
/* encodeURIComponent() never produces "%u", so the fallback output cannot collide with it. */
const keyPart = (v) => {
  const str = String(v);
  try { return encodeURIComponent(str); } catch (_) {
    let out = '';
    for (let i = 0; i < str.length; i++) out += '%u' + str.charCodeAt(i).toString(16).padStart(4, '0');
    return out;
  }
};
/* String() throws for a symbol, or for an object whose toString() throws. */
const say = (v) => {
  try { return typeof v === 'string' ? JSON.stringify(v) : typeof v === 'bigint' ? String(v) + 'n' : String(v); } catch (_) { return 'that value'; }
};

/* Same shape as vscode.Event. */
function emitter() {
  const listeners = new Set();
  return {
    event(listener, thisArgs, disposables) {
      const fn = (v) => listener.call(thisArgs, v);
      listeners.add(fn);
      const d = { dispose: () => { listeners.delete(fn); } };
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    },
    fire(v) {
      for (const fn of [...listeners]) { try { fn(v); } catch (_) { /* the other listeners still run */ } }
    },
    dispose() { listeners.clear(); },
  };
}

function idOf(source) {
  const id = get(source, 'id');
  return usableId(id) ? id : '';
}

function refusal(source, majors = MAJORS, id = idOf(source)) {
  if (!source || (typeof source !== 'object' && typeof source !== 'function')) return 'a source is an object';
  const protocol = get(source, 'protocol');
  if (!majors.includes(protocol)) return `protocol ${say(protocol)} is not one this host accepts (${majors.join(', ')})`;
  if (!id) return `a source needs an id: a string of 1 to ${MAX_ID} characters with no space at either end`;
  return '';
}

function supports(source, name) {
  const features = get(source, 'features');
  try { return Array.isArray(features) && features.includes(name); } catch (_) { return false; }
}

function optional(source, name) {
  if (!supports(source, name)) return null;
  const fn = get(source, name);
  return typeof fn === 'function' ? (...args) => fn.apply(source, args) : null;
}

function call(source, name, args, fallback) {
  const fn = get(source, name);
  if (typeof fn !== 'function') return fallback;
  try { return fn.apply(source, args || []); } catch (_) { return fallback; }
}

function listen(source, name, listener) {
  const ev = get(source, name);
  if (typeof ev !== 'function') return null;
  try {
    const d = ev.call(source, listener);
    const dispose = get(d, 'dispose');
    return typeof dispose === 'function' ? { dispose: () => { try { dispose.call(d); } catch (_) { /* already disposed */ } } } : null;
  } catch (_) { return null; }
}

function labelOf(source) {
  return text(get(source, 'label'), 80) || idOf(source);
}

function logoOf(source) {
  const logo = get(source, 'logo');
  const file = (u) => { const f = get(u, 'fsPath'); return typeof f === 'string' && f ? f : ''; };
  const light = file(get(logo, 'light')), dark = file(get(logo, 'dark'));
  if (!light && !dark) return null;
  return { light: light || dark, dark: dark || light };
}

function planFileOf(source, sessionId) {
  const f = call(source, 'planPath', [sessionId], null);
  return typeof f === 'string' && f ? f : '';
}

function planDirOf(source) {
  const d = call(source, 'planDir', [], null);
  return typeof d === 'string' && d ? d : '';
}

function conversation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = get(raw, 'sessionId');
  if (!usableId(sessionId)) return null;
  const title = get(raw, 'title'), cwd = get(raw, 'cwd'), state = get(raw, 'state'), running = get(raw, 'running');
  const hasPlan = get(raw, 'hasPlan'), id = get(raw, 'id'), kind = get(raw, 'kind');
  let at = get(raw, 'lastActiveAt');
  if (typeof at === 'string') at = Date.parse(at);
  return {
    sessionId,
    title: typeof title === 'string' ? title : '', // not trimmed: Claude Code's titles show exactly as reported
    cwd: typeof cwd === 'string' ? cwd : '',
    state: STATES.includes(state) ? state : 'idle',
    running: running !== false,
    lastActiveAt: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0,
    hasPlan: hasPlan === true,
    /* Set only by Claude Code's source; passed back to it in the row's command arguments. */
    id: typeof id === 'string' && id.length <= MAX_ID ? id : '',
    kind: typeof kind === 'string' && kind.length <= 40 ? kind : '',
  };
}

function conversations(list, max = Infinity) {
  const out = [];
  let n = 0;
  try { n = Array.isArray(list) ? Math.min(list.length, max) : 0; } catch (_) { n = 0; }
  for (let i = 0; i < n; i++) {
    let c = null;
    try { c = conversation(list[i]); } catch (_) { c = null; }
    if (c) out.push(c);
  }
  return out;
}

/*
 * Each registration gets its own entry object, so a result for an earlier registration of the same source can be told
 * apart. reserve() takes the id before the host calls into the source, so a source that registers itself again from one
 * of its own getters is rejected as a duplicate.
 */
class Registry {
  constructor({ majors = MAJORS } = {}) {
    this.majors = majors;
    this.entries = [];
    this.reserved = new Map();
    this.changes = emitter();
    this.onDidChange = this.changes.event;
  }

  reserve(source, id = idOf(source)) {
    const why = refusal(source, this.majors, id)
      || (this.get(id) || this.reserved.has(id) ? `a source with the id ${say(id)} is registered already` : '');
    if (why) return { ok: false, why, entry: null };
    const entry = { id, source, subs: [], list: null };
    this.reserved.set(id, entry);
    return { ok: true, why: '', entry };
  }

  release(entry) {
    if (this.reserved.get(entry.id) === entry) this.reserved.delete(entry.id);
  }

  commit(entry) {
    if (this.reserved.get(entry.id) !== entry) return () => {};
    this.reserved.delete(entry.id);
    this.entries.push(entry);
    this.changes.fire({ added: entry.id, entry });
    return () => {
      const i = this.entries.indexOf(entry);
      if (i < 0) return;
      this.entries.splice(i, 1);
      this.changes.fire({ removed: entry.id, entry });
    };
  }

  add(source, id = idOf(source)) {
    const r = this.reserve(source, id);
    if (!r.ok) return { ok: false, why: r.why, id: '', entry: null, remove() {} };
    return { ok: true, why: '', id, entry: r.entry, remove: this.commit(r.entry) };
  }

  clear() {
    this.entries = [];
    this.reserved.clear();
  }

  has(entry) {
    return this.entries.includes(entry);
  }

  get(id) {
    const e = this.entries.find((x) => x.id === id);
    return e ? e.source : null;
  }

  entry(id) {
    return this.entries.find((x) => x.id === id) || null;
  }

  all() {
    return this.entries.map((e) => e.source);
  }

  list() {
    return this.entries.slice();
  }

  get size() {
    return this.entries.length;
  }
}

/* The conversation the work plan view shows. The latest signal wins; a tab no source claims (a file, a terminal) leaves
   it unchanged. */
class Focus {
  constructor() {
    this.sourceId = '';
    this.sessionId = '';
    this.tab = undefined;
  }

  set(sourceId, sessionId) {
    const s = String(sourceId || ''), id = String(sessionId || '');
    if (s === this.sourceId && id === this.sessionId) return false;
    this.sourceId = s;
    this.sessionId = id;
    return true;
  }

  /* An empty session id means the source's front conversation went away. It clears the focus only if the focus belongs
     to that source: a Claude Code tab closing behind a Codex one leaves the Codex one in front. */
  report(sourceId, sessionId) {
    if (!sessionId && this.sourceId && this.sourceId !== sourceId) return false;
    return this.set(sourceId, sessionId);
  }

  /* VS Code fires onDidChangeTabs for every label and state change. Offering the same tab each time would pull the focus
     back to it after the user had switched to a sidebar conversation, so a tab is offered again only with `again`. */
  claim(tab, entries, again = false) {
    if (!again && tab === this.tab) return false;
    this.tab = tab;
    if (!tab) return false;
    for (const { id: sourceId, source } of entries) {
      const id = call(source, 'sessionForTab', [tab], null);
      if (usableId(id)) return this.set(sourceId, id);
    }
    return false;
  }

  drop(sourceId) {
    if (this.sourceId !== sourceId) return false;
    return this.set('', '');
  }
}

module.exports = {
  PROTOCOL, MAJORS, FEATURES, BUILTIN, STATES, MAX_ID, MAX_CONVERSATIONS,
  emitter, get, idOf, usableId, keyPart, refusal, supports, optional, call, listen, labelOf, logoOf, planFileOf, planDirOf, conversation, conversations,
  Registry, Focus,
};
