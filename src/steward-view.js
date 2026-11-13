// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Steward panel, in VS Code's bottom panel. It is about the conversation in the active Claude Code panel: it lists
 * every other Claude Code conversation open in a VS Code window on this machine, grouped by window, and the ticked rows
 * are what that conversation manages (src/stewards.js). A conversation open in no window is not listed, since a
 * steward has no way to reach it; ticked ones among them are counted, with a button to untick them.
 *
 * The candidates are the conversations `claude agents --json` reports, less `claude --bg` sessions and `claude -p`
 * workers, which belong to the conversation that started them; and the stopped conversations whose plans still have
 * open rows, as Agent Plus's Conversations view shows them. The managed ones come first, with what each is doing, how
 * many questions it has for the user, and when it was last active.
 *
 * The same pass tells a steward when one of its conversations stops (src/stewards.js changes), by a line posted to the
 * steward's inbox socket. Only the window that has the steward conversation open sends it.
 */
const fs = require('fs');
const path = require('path');
const stewards = require('./stewards');
const waiting = require('./waiting');
const conversations = require('./conversations');
const bgSessions = require('./bgsessions');
const { planQuestions } = require('./folders');
const { writeAtomic, SESSION } = require('./claude-files');
const { liveRecords } = require('./background');
const { OPEN_STATES } = require('./workplan');

const VIEW = 'claudeCodePlus.steward';
/* How often the list and the notices are refreshed. `claude agents --json` is asked at most every half minute
   (freshAgents in src/claude-source.js), so most passes only reread plans. */
const REFRESH_MS = 5000;
const NOTICE_GAP_MS = 60000;
/* <plan dir>/windows/<pid>.json: what each window shows, ignored once older than this or once its process is gone. */
const WINDOWS_DIR = 'windows';
const WINDOW_STALE_MS = 120000;
/* <plan dir>/windows/<pid>.open.json asks window <pid> to show a conversation. Requests older than OPEN_FRESH_MS are
   ignored, so a window that was busy or closing does not act on one much later. */
const OPEN_SUFFIX = '.open.json';
const OPEN_FRESH_MS = 30000;
const MAX_DOING = 2;
/* The questions a notice quotes for each conversation, and how much of each. */
const MAX_ASKS = 3;
const MAX_ASK = 300;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* The titles of a plan's rows in progress, depth first. */
function doingRows(nodes, out = []) {
  for (const n of nodes || []) {
    if (out.length >= MAX_DOING) break;
    if (n.state === 'doing') out.push(n.title);
    doingRows(n.children, out);
  }
  return out.slice(0, MAX_DOING);
}

/*
 * Every conversation the panel can list, by session id: { sessionId, title, cwd, state, running, lastActiveAt, doing,
 * questions }. `deps` are those of create() below.
 */
function gather(records, deps) {
  const all = records ? waiting.merge(records) : new Map();
  const running = new Map();
  for (const [id, s] of all) {
    if (s.kind === 'background' || !s.cwd || deps.isBackground(id, s.cwd)) continue;
    running.set(id, s);
  }
  const roots = [...new Set([...running.values()].map((s) => path.parse(s.cwd).root).concat(path.parse(deps.home).root))];
  const stopped = conversations.stoppedWithOpenRows(roots, new Set(all.keys()), { dir: deps.dir, readPlan: deps.readPlan });
  const live = deps.live(), unread = deps.unread();
  const out = new Map();
  const add = (s, on) => {
    const plan = deps.readPlan(s.sessionId);
    const nodes = plan && plan.nodes;
    const qs = planQuestions(nodes);
    out.set(s.sessionId, {
      sessionId: s.sessionId,
      title: conversations.claudeTitle(s, deps.titles(s), () => plan),
      cwd: s.cwd,
      state: on ? conversations.stateOf(s, live, unread) : 'idle',
      running: on,
      lastActiveAt: deps.since(s) || 0,
      doing: doingRows(nodes),
      questions: qs.length,
      asks: qs.slice(0, MAX_ASKS).map((q) => String(q.question || '').slice(0, MAX_ASK)),
    });
  };
  for (const s of running.values()) add(s, true);
  for (const s of stopped.values()) add(s, false);
  return out;
}

const STATE_TEXT = { working: 'working', prompt: 'waiting for you', unread: 'finished, not read yet', idle: 'idle' };
/* STATE_TEXT for the steward's notices, which speak of the user in the third person. */
const NOTICE_STATE = { working: 'working', prompt: 'waiting for the user', unread: 'finished, not read by the user', idle: 'idle' };

function ago(ms, now) {
  if (!ms) return '';
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/* Returns the managed conversations named in an open row of the steward's plan, by title, session id, or the id's first
   eight characters. names: session id -> title. */
function waitedOn(plan, ids, names) {
  const texts = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n && OPEN_STATES.includes(n.state)) texts.push(String(n.title || '') + ' ' + String(n.note || ''));
      if (n) walk(n.children);
    }
  };
  walk(plan && plan.nodes);
  const all = texts.join('\n');
  // Skip an eight-character prefix that more than one of them has.
  const prefix = (id) => ids.filter((x) => x.slice(0, 8) === id.slice(0, 8)).length === 1 && all.includes(id.slice(0, 8));
  return new Set(ids.filter((id) => all.includes(id) || prefix(id) || (names[id] && names[id].trim().length >= 2 && all.includes(names[id].trim()))));
}

/* Signal 0 only checks; EPERM still means the process exists. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/* The window name without the " [SSH: host]" suffix VS Code adds for a remote window. */
const windowLabel = (w) => String(w.name || '').replace(/\s*\[[^\]]*\]\s*$/, '')
  || (w.folders[0] ? path.basename(w.folders[0]) : 'Window with no folder');

/* One group per window, the one in front first. `rows` are all open in one of `wins`. */
function grouped(rows, wins, front) {
  const groups = new Map();
  const frontWin = wins.find((w) => w.sessions.includes(front));
  for (const c of rows) {
    const w = wins.find((x) => x.sessions.includes(c.sessionId));
    if (!w) continue;
    const key = 'w:' + w.pid;
    if (!groups.has(key)) groups.set(key, { key, name: windowLabel(w), rank: w === frontWin ? 0 : 1, rows: [] });
    groups.get(key).rows.push(c);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/* The panel's list, as HTML. */
function body(model) {
  const now = Date.now();
  const row = (c) => `
    <li class="row ${c.managed ? 'managed' : ''}">
      <input type="checkbox" data-id="${esc(c.sessionId)}" ${c.managed ? 'checked' : ''} ${model.every ? 'disabled' : ''} title="Managed by this conversation">
      <span class="dot ${esc(c.state)}" title="${esc(STATE_TEXT[c.state] || c.state)}"></span>
      <a href="#" class="name" data-open="${esc(c.sessionId)}" title="${esc(c.cwd)}">${esc(c.title)}</a>
      ${c.managed ? `<span class="doing">${esc(c.doing.join(' · ') || (c.running ? STATE_TEXT[c.state] : 'stopped'))}</span>
      ${c.questions ? `<span class="questions">${c.questions} question${c.questions === 1 ? '' : 's'} for you</span>` : ''}
      <span class="when">${esc(ago(c.lastActiveAt, now))}</span>` : `<span class="when">${esc(ago(c.lastActiveAt, now))}</span>`}
    </li>`;
  const group = (g) => {
    const on = g.rows.filter((c) => c.managed).length;
    return `
    <div class="group">
      <label class="ghead"><input type="checkbox" data-group="${esc(g.key)}" ${on && on === g.rows.length ? 'checked' : ''} ${model.every ? 'disabled' : ''}
        ${on && on < g.rows.length ? 'data-mixed="1"' : ''} title="Every conversation in ${esc(g.name)}">
        <span class="gname">${esc(g.name)}</span><span class="count">${on}/${g.rows.length}</span></label>
      <ul>${g.rows.map(row).join('')}</ul>
    </div>`;
  };
  const away = model.hidden ? `<p class="away">${model.hidden} ticked conversation${model.hidden === 1 ? ' is' : 's are'} not open in any
      VS Code window, so the steward cannot send ${model.hidden === 1 ? 'it' : 'them'} anything; not listed.
      <button data-act="drop-hidden">Untick ${model.hidden === 1 ? 'it' : 'them'}</button></p>` : '';
  return !model.front
    ? '<p class="empty">Open a Claude Code conversation. The conversations ticked here are the ones it manages.</p>'
    : `<div class="head"><span>Managed by <b>${esc(model.front.title)}</b>: ${model.managed}</span>
         <label class="every" title="Also ticks conversations opened later. Other stewards are never ticked.">
           <input type="checkbox" data-every="1" ${model.every ? 'checked' : ''}> All, including new ones</label>
         <button data-act="all" ${model.every ? 'disabled' : ''}>Select all</button><button data-act="none" ${model.every ? 'disabled' : ''}>Clear</button></div>${away}
       ${model.groups.length ? model.groups.map(group).join('') : '<p class="empty">No other Claude Code conversation is open in a VS Code window.</p>'}`;
}

/*
 * The page, with `list` in it. It is set once per webview; later lists arrive as messages, since setting the page again
 * reloads it, which loses the scroll position and the focus.
 */
function shell(list, nonce) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 4px 8px; }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .head span { flex: 1 1 auto; opacity: 0.85; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 8px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .every { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  ul { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; align-items: center; gap: 6px; padding: 2px 0; white-space: nowrap; }
  .row:not(.managed) { opacity: 0.7; }
  .name { color: var(--vscode-textLink-foreground); text-decoration: none; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
  .doing { overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; min-width: 0; opacity: 0.85; }
  .questions { color: var(--vscode-editorWarning-foreground, #cca700); }
  .when { opacity: 0.6; margin-left: auto; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--vscode-disabledForeground, #888); }
  .dot.working { background: #22c55e; } .dot.unread { background: #ef4444; } .dot.prompt { background: #3b82f6; }
  .empty, .away { opacity: 0.7; }
  .away button { margin-left: 6px; }
  .group { margin-bottom: 6px; }
  .ghead { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-weight: 600; }
  .ghead .count { opacity: 0.6; font-weight: normal; }
  .group ul { padding-left: 18px; }
</style></head><body><div id="root">${list}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  // A group's box shows a part of its conversations ticked as neither ticked nor clear, which only a property can say.
  const mixed = () => { for (const b of document.querySelectorAll('input[data-mixed]')) b.indeterminate = true; };
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m && m.type === 'body' && typeof m.html === 'string') { document.getElementById('root').innerHTML = m.html; mixed(); }
  });
  mixed();
  vscode.postMessage({ type: 'ready' });
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.matches('input[data-every]')) vscode.postMessage({ type: 'every', on: t.checked });
    else if (t.matches('input[data-group]')) vscode.postMessage({ type: 'group', key: t.dataset.group, on: t.checked });
    else if (t.matches('input[type=checkbox]')) vscode.postMessage({ type: 'toggle', id: t.dataset.id, on: t.checked });
    else if (t.dataset.open) { e.preventDefault(); vscode.postMessage({ type: 'open', id: t.dataset.open }); }
    else if (t.dataset.act) vscode.postMessage({ type: t.dataset.act });
  });
</script></body></html>`;
}

/*
 * deps: activeChat(), freshAgents() -> { records }, readPlan(id), titles(s), since(s), live(), unread(), reveal(id),
 * shownHere(id) -> whether this window shows that conversation's panel, canWrite() -> whether this window may write
 * shared files, enabled(), log(message), home, dir (the plan directory), windowName(), windowFolders() and shownList()
 * for this window's name, folders and the conversations it shows, and optionally isBackground(id, cwd), records() ->
 * the live session records, alive(pid), post(address, text) in place of stewards.post, changed(), called once the
 * table of stewards has been rewritten here, and focusWindow(), which brings this window to the front.
 */
function create(vscode, deps) {
  deps = Object.assign({ isBackground: bgSessions.isBackground, records: () => liveRecords(), post: stewards.post, alive,
    windowName: () => '', windowFolders: () => [], shownList: () => [], changed: () => {}, focusWindow: () => {} }, deps);
  let view = null, timer = 0, busy = false, last = new Map(), lastFront = '', shown = null;
  const states = new Map();
  /* A pass reads the plan of every conversation listed, every REFRESH_MS. A plan whose file has the same size and
     modification time as at the last read is taken from here instead. */
  const planSeen = new Map();
  const readPlan = (id) => {
    let st;
    try { st = fs.statSync(path.join(deps.dir, id + '.json')); } catch (_) { planSeen.delete(id); return deps.readPlan(id); }
    const key = st.mtimeMs + ':' + st.size, hit = planSeen.get(id);
    if (hit && hit.key === key) return hit.plan;
    const plan = deps.readPlan(id);
    planSeen.set(id, { key, plan });
    return plan;
  };
  const cached = Object.assign({}, deps, { readPlan });

  const model = (all, front) => {
    const table = stewards.read(deps.dir);
    const mine = new Set(front && table[front] ? table[front].manages : []);
    const every = !!(front && table[front] && table[front].all);
    const wins = windows();
    const open = (id) => wins.some((w) => w.sessions.includes(id));
    const rows = [...all.values()].filter((c) => c.sessionId !== front && open(c.sessionId))
      .map((c) => Object.assign({ managed: mine.has(c.sessionId) }, c));
    rows.sort((a, b) => (b.managed - a.managed) || (b.lastActiveAt - a.lastActiveAt));
    const groups = grouped(rows, wins, front);
    const hidden = [...mine].filter((id) => !open(id));
    const self = front && all.get(front);
    // The conversation in front may not be in the list yet: `claude agents --json` is read at most every half minute.
    const title = self ? self.title : front ? conversations.claudeTitle({ sessionId: front, name: '', cwd: '' },
      deps.titles({ sessionId: front }), () => deps.readPlan(front)) : '';
    return { front: front ? { id: front, title } : null, rows, groups, managed: mine.size, hidden: hidden.length, hiddenIds: hidden,
      every };
  };

  /* This window's entry in the windows folder, written when what it shows changes and once a minute besides. */
  const own = path.join(deps.dir, WINDOWS_DIR, process.pid + '.json');
  let published = '', publishedAt = 0;
  const publish = (now = Date.now()) => {
    if (!deps.canWrite()) return;
    const entry = { pid: process.pid, name: deps.windowName(), folders: deps.windowFolders(), sessions: deps.shownList() };
    const text = JSON.stringify(entry);
    if (text === published && now - publishedAt < WINDOW_STALE_MS / 2) return;
    try {
      fs.mkdirSync(path.dirname(own), { recursive: true });
      writeAtomic(own, JSON.stringify(Object.assign({ at: now }, entry)) + '\n');
      published = text; publishedAt = now;
    } catch (e) { deps.log('steward panel: ' + ((e && e.message) || e)); }
  };
  /* The windows on this machine, this one included, from their entries. */
  const windows = (now = Date.now()) => {
    const out = [{ pid: process.pid, name: deps.windowName(), folders: deps.windowFolders(), sessions: deps.shownList() }];
    let names = [];
    try { names = fs.readdirSync(path.join(deps.dir, WINDOWS_DIR)).filter((n) => /^\d+\.json$/.test(n)); } catch (_) { return out; }
    for (const n of names) {
      const pid = Number(n.slice(0, -5));
      if (pid === process.pid) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(deps.dir, WINDOWS_DIR, n), 'utf8')); } catch (_) { continue; }
      if (!d || !(now - d.at < WINDOW_STALE_MS) || !deps.alive(pid)) continue;
      out.push({ pid, name: typeof d.name === 'string' ? d.name : '', folders: Array.isArray(d.folders) ? d.folders : [],
        sessions: Array.isArray(d.sessions) ? d.sessions : [] });
    }
    return out;
  };

  /* The list for a steward with "all" set: every conversation open in a window, except itself and other stewards. */
  const everyIds = (steward, table) => {
    const wins = windows();
    return [...last.keys()].filter((id) => id !== steward && !table[id] && wins.some((w) => w.sessions.includes(id)));
  };
  const titlesOf = (list) => {
    const names = {};
    for (const id of list) if (last.get(id)) names[id] = last.get(id).title;
    return names;
  };
  /* For each steward with "all" set whose conversation is open in this window, rewrites its list to match everyIds. */
  const syncEvery = () => {
    const table = stewards.read(deps.dir);
    let changed = false;
    for (const [steward, t] of Object.entries(table)) {
      if (!t.all || !deps.shownHere(steward)) continue;
      const want = everyIds(steward, table);
      if (want.length === t.manages.length && want.every((id) => t.manages.includes(id))) continue;
      stewards.setManaged(steward, want, titlesOf(want), { dir: deps.dir, every: true });
      changed = true;
    }
    if (changed) deps.changed();
  };

  /* `shown` is the list the page has, or null when it needs the whole page. */
  const render = () => {
    if (!view || !view.visible) return;
    const list = body(model(last, deps.activeChat()));
    if (shown === null) {
      view.webview.html = shell(list, Math.random().toString(36).slice(2) + Date.now().toString(36));
      shown = list;
    } else if (list !== shown) {
      shown = list;
      view.webview.postMessage({ type: 'body', html: list });
    }
  };

  /*
   * Notices for the stewards whose panel this window shows. A notice starts a turn in an idle steward, so it is sent
   * only if a conversation began waiting for the user, has more questions for the user than at the last pass, or ended
   * a turn while the steward's plan names it. A steward gets at most one notice per NOTICE_GAP_MS; conversations often
   * stop within a minute of each other.
   */
  const pending = new Map(), sentAt = new Map(), asked = new Map();
  const notify = async (now = Date.now()) => {
    const table = stewards.read(deps.dir);
    const after = new Map([...last].map(([id, c]) => [id, c.state]));
    for (const steward of Object.keys(table)) {
      if (!deps.shownHere(steward)) { pending.delete(steward); continue; }
      const manages = table[steward].manages;
      const more = (id) => last.get(id) && asked.has(id) && last.get(id).questions > asked.get(id);
      const waited = waitedOn(readPlan(steward), manages, table[steward].names);
      const list = stewards.changes(states, after, manages)
        .filter((c) => c.what === 'waiting' || more(c.id) || waited.has(c.id));
      if (list.length) pending.set(steward, (pending.get(steward) || []).filter((c) => !list.some((x) => x.id === c.id)).concat(list));
    }
    states.clear();
    for (const [id, s] of after) states.set(id, s);
    asked.clear();
    for (const [id, c] of last) asked.set(id, c.questions);
    let records = null;
    for (const [steward, list] of pending) {
      if (!table[steward] || now - (sentAt.get(steward) || 0) < NOTICE_GAP_MS) continue;
      if (!records) records = deps.records();
      const rec = records.find((r) => r && r.sessionId === steward && typeof r.messagingSocketPath === 'string');
      const names = Object.assign({}, table[steward].names), details = {};
      for (const c of list) {
        const now = last.get(c.id);
        if (!now) continue;
        names[c.id] = now.title;
        details[c.id] = { state: NOTICE_STATE[now.state] || now.state, doing: now.doing, asks: now.asks || [] };
      }
      const sent = rec ? await deps.post(rec.messagingSocketPath, stewards.noticeText(list, names, details)) : false;
      pending.delete(steward);
      sentAt.set(steward, now);
      deps.log(`steward ${steward}: ${list.length} change(s) ${sent ? 'sent' : 'not sent, no inbox reached'}`);
    }
  };

  /* Shows a conversation: here if this window has its tab, otherwise by writing a request file for the window that
     has it. Returns 'here', 'sent' or 'nowhere'. */
  const open = async (id) => {
    if (typeof id !== 'string' || !SESSION.test(id)) return 'nowhere';
    if (deps.shownHere(id) && await deps.reveal(id)) return 'here';
    const w = windows().find((x) => x.pid !== process.pid && x.sessions.includes(id));
    if (!w) return 'nowhere';
    try {
      writeAtomic(path.join(deps.dir, WINDOWS_DIR, w.pid + OPEN_SUFFIX), JSON.stringify({ session: id, at: Date.now() }) + '\n');
      return 'sent';
    } catch (e) {
      deps.log('steward panel: ' + ((e && e.message) || e));
      return 'nowhere';
    }
  };
  /* Requests from other windows to show one of this window's conversations. The watch handles them at once; each pass
     also checks, in case the watch missed one. */
  const request = path.join(deps.dir, WINDOWS_DIR, process.pid + OPEN_SUFFIX);
  let requestWatch = null;
  const takeRequest = async (now = Date.now()) => {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(request, 'utf8')); } catch (_) { return false; }
    try { fs.unlinkSync(request); } catch (_) { /* taken already */ }
    if (!d || typeof d.session !== 'string' || !(now - d.at < OPEN_FRESH_MS)) return false;
    if (!await deps.reveal(d.session)) return false;
    deps.focusWindow();
    return true;
  };
  const watchRequests = () => {
    if (requestWatch) return;
    try {
      requestWatch = fs.watch(path.join(deps.dir, WINDOWS_DIR), { persistent: false }, (event, name) => {
        if (name && name !== process.pid + OPEN_SUFFIX) return;
        takeRequest().catch((e) => deps.log('steward panel: ' + ((e && e.message) || e)));
      });
      requestWatch.on('error', () => { try { requestWatch.close(); } catch (_) { /* closed */ } requestWatch = null; });
    } catch (_) { requestWatch = null; }
  };

  /* Skipped while the panel is hidden and no steward here needs notices: a pass reads every plan and transcript end. */
  const pass = async () => {
    if (busy || !deps.enabled()) return;
    publish();
    watchRequests();
    await takeRequest();
    if (!(view && view.visible) && !Object.keys(stewards.read(deps.dir)).some((id) => deps.shownHere(id))) return;
    busy = true;
    try {
      const r = await deps.freshAgents();
      if (planSeen.size > 1000) planSeen.clear();
      last = gather(r && r.records, cached);
      if (deps.canWrite()) {
        const names = {};
        for (const [id, c] of last) names[id] = c.title;
        stewards.rename(names, { dir: deps.dir });
        syncEvery();
      }
      render();
      await notify();
    } catch (e) {
      deps.log('steward panel: ' + ((e && e.message) || e));
    } finally { busy = false; }
  };

  const onMessage = async (m) => {
    const front = deps.activeChat();
    if (m && m.type === 'ready') { if (view) view.webview.postMessage({ type: 'body', html: shown || '' }); return; }
    if (m && m.type === 'open' && typeof m.id === 'string') {
      if (await open(m.id) === 'nowhere') vscode.window.showInformationMessage('That conversation is not open in any VS Code window on this machine.');
      return;
    }
    if (!m || !front || !deps.canWrite()) return;
    const table = stewards.read(deps.dir);
    const mine = new Set(table[front] ? table[front].manages : []);
    if (m.type === 'every') {
      const list = m.on ? everyIds(front, table) : [...mine];
      stewards.setManaged(front, list, titlesOf(list), { dir: deps.dir, every: m.on === true });
      render();
      deps.changed();
      return;
    }
    // While it manages all, nothing can be unticked or ticked by hand.
    if (table[front] && table[front].all) return;
    if (m.type === 'toggle' && typeof m.id === 'string') { if (m.on) mine.add(m.id); else mine.delete(m.id); }
    else if (m.type === 'group' && typeof m.key === 'string') {
      const g = model(last, front).groups.find((x) => x.key === m.key);
      for (const c of g ? g.rows : []) { if (m.on) mine.add(c.sessionId); else mine.delete(c.sessionId); }
    }
    else if (m.type === 'all') for (const c of model(last, front).rows) mine.add(c.sessionId);
    else if (m.type === 'none') mine.clear();
    else if (m.type === 'drop-hidden') for (const id of model(last, front).hiddenIds) mine.delete(id);
    else return;
    stewards.setManaged(front, [...mine], titlesOf(mine), { dir: deps.dir });
    render();
    deps.changed();
  };

  const provider = {
    resolveWebviewView(v) {
      view = v;
      v.webview.options = { enableScripts: true };
      v.webview.onDidReceiveMessage((m) => { onMessage(m).catch((e) => deps.log('steward panel: ' + ((e && e.message) || e))); });
      v.onDidChangeVisibility(() => { shown = null; render(); });
      v.onDidDispose(() => { if (view === v) view = null; });
      shown = null;
      render();
      pass();
    },
  };
  const reg = vscode.window.registerWebviewViewProvider(VIEW, provider, { webviewOptions: { retainContextWhenHidden: false } });
  timer = setInterval(() => {
    if (deps.activeChat() !== lastFront) { lastFront = deps.activeChat(); render(); }
    pass();
  }, REFRESH_MS);
  return {
    dispose() {
      clearInterval(timer);
      reg.dispose();
      if (requestWatch) { try { requestWatch.close(); } catch (_) { /* closed */ } }
      if (published) { try { fs.unlinkSync(own); } catch (_) { /* gone already */ } }
    },
    refresh() { render(); },
    open,
    _gather: gather, _model: model, _notify: notify, _pass: pass, _onMessage: onMessage, _takeRequest: takeRequest, _syncEvery: syncEvery,
  };
}

module.exports = { create, gather, grouped, doingRows, waitedOn, body, shell, VIEW, REFRESH_MS, NOTICE_GAP_MS, WINDOWS_DIR };
