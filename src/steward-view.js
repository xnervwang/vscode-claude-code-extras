// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Steward panel, in VS Code's bottom panel. It is about the conversation in the active Claude Code panel: it lists
 * every other Claude Code conversation on this machine, from every window, and the ticked rows are what that
 * conversation manages (src/stewards.js).
 *
 * It lists the conversations `claude agents --json` reports, wherever they were started, less `claude --bg` sessions
 * and `claude -p` workers, which belong to the conversation that started them; and the stopped conversations whose
 * plans still have open rows, as Agent Plus's Conversations view shows them. The managed ones come first, with what
 * each is doing, how many questions it has for the user, and when it was last active.
 *
 * The same pass tells a steward when one of its conversations stops (src/stewards.js changes), by a line posted to the
 * steward's inbox socket. Only the window that has the steward conversation open sends it.
 */
const path = require('path');
const stewards = require('./stewards');
const waiting = require('./waiting');
const conversations = require('./conversations');
const bgSessions = require('./bgsessions');
const { planQuestions } = require('./folders');
const { liveRecords } = require('./background');

const VIEW = 'claudeCodePlus.steward';
/* How often the list and the notices are refreshed. `claude agents --json` is asked at most every half minute
   (freshAgents in src/claude-source.js), so most passes only reread plans. */
const REFRESH_MS = 5000;
const NOTICE_GAP_MS = 60000;
const MAX_DOING = 2;

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
    out.set(s.sessionId, {
      sessionId: s.sessionId,
      title: conversations.claudeTitle(s, deps.titles(s), () => plan),
      cwd: s.cwd,
      state: on ? conversations.stateOf(s, live, unread) : 'idle',
      running: on,
      lastActiveAt: deps.since(s) || 0,
      doing: doingRows(nodes),
      questions: planQuestions(nodes).length,
    });
  };
  for (const s of running.values()) add(s, true);
  for (const s of stopped.values()) add(s, false);
  return out;
}

const STATE_TEXT = { working: 'working', prompt: 'waiting for you', unread: 'finished, not read yet', idle: 'idle' };

function ago(ms, now) {
  if (!ms) return '';
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/* The panel's list, as HTML. */
function body(model) {
  const now = Date.now();
  const row = (c) => `
    <li class="row ${c.managed ? 'managed' : ''}">
      <input type="checkbox" data-id="${esc(c.sessionId)}" ${c.managed ? 'checked' : ''} title="Managed by this conversation">
      <span class="dot ${esc(c.state)}" title="${esc(STATE_TEXT[c.state] || c.state)}"></span>
      <a href="#" class="name" data-open="${esc(c.sessionId)}" title="${esc(c.cwd)}">${esc(c.title)}</a>
      ${c.managed ? `<span class="doing">${esc(c.doing.join(' · ') || (c.running ? STATE_TEXT[c.state] : 'stopped'))}</span>
      ${c.questions ? `<span class="questions">${c.questions} question${c.questions === 1 ? '' : 's'} for you</span>` : ''}
      <span class="when">${esc(ago(c.lastActiveAt, now))}</span>` : `<span class="when">${esc(ago(c.lastActiveAt, now))}</span>`}
    </li>`;
  return !model.front
    ? '<p class="empty">Open a Claude Code conversation. The conversations ticked here are the ones it manages.</p>'
    : `<div class="head"><span>Managed by <b>${esc(model.front.title)}</b>: ${model.managed}</span>
         <button data-act="all">Select all</button><button data-act="none">Clear</button></div>
       ${model.rows.length ? `<ul>${model.rows.map(row).join('')}</ul>` : '<p class="empty">No other Claude Code conversation is open.</p>'}`;
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
  ul { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; align-items: center; gap: 6px; padding: 2px 0; white-space: nowrap; }
  .row:not(.managed) { opacity: 0.7; }
  .name { color: var(--vscode-textLink-foreground); text-decoration: none; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
  .doing { overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; min-width: 0; opacity: 0.85; }
  .questions { color: var(--vscode-editorWarning-foreground, #cca700); }
  .when { opacity: 0.6; margin-left: auto; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--vscode-disabledForeground, #888); }
  .dot.working { background: #22c55e; } .dot.unread { background: #ef4444; } .dot.prompt { background: #3b82f6; }
  .empty { opacity: 0.7; }
</style></head><body><div id="root">${list}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m && m.type === 'body' && typeof m.html === 'string') document.getElementById('root').innerHTML = m.html;
  });
  vscode.postMessage({ type: 'ready' });
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.matches('input[type=checkbox]')) vscode.postMessage({ type: 'toggle', id: t.dataset.id, on: t.checked });
    else if (t.dataset.open) { e.preventDefault(); vscode.postMessage({ type: 'open', id: t.dataset.open }); }
    else if (t.dataset.act) vscode.postMessage({ type: t.dataset.act });
  });
</script></body></html>`;
}

/*
 * deps: activeChat(), freshAgents() -> { records }, readPlan(id), titles(s), since(s), live(), unread(), reveal(id),
 * shownHere(id) -> whether this window shows that conversation's panel, canWrite() -> whether this window may write
 * shared files, enabled(), log(message), home, dir (the plan directory), and optionally isBackground(id, cwd),
 * records() -> the live session records, and post(address, text) in place of stewards.post.
 */
function create(vscode, deps) {
  deps = Object.assign({ isBackground: bgSessions.isBackground, records: () => liveRecords(), post: stewards.post }, deps);
  let view = null, timer = 0, busy = false, last = new Map(), lastFront = '', shown = null;
  const states = new Map();

  const model = (all, front) => {
    const table = stewards.read(deps.dir);
    const mine = new Set(front && table[front] ? table[front].manages : []);
    const rows = [...all.values()].filter((c) => c.sessionId !== front)
      .map((c) => Object.assign({ managed: mine.has(c.sessionId) }, c));
    rows.sort((a, b) => (b.managed - a.managed) || (b.lastActiveAt - a.lastActiveAt));
    const self = front && all.get(front);
    // The conversation in front may not be in the list yet: `claude agents --json` is read at most every half minute.
    const title = self ? self.title : front ? conversations.claudeTitle({ sessionId: front, name: '', cwd: '' },
      deps.titles({ sessionId: front }), () => deps.readPlan(front)) : '';
    return { front: front ? { id: front, title } : null, rows, managed: mine.size };
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
   * Notices for the stewards whose panel this window shows. Changes are gathered and sent at most once every
   * NOTICE_GAP_MS per steward: each notice starts a turn in an idle steward, and several conversations often stop
   * within a minute of each other.
   */
  const pending = new Map(), sentAt = new Map();
  const notify = async (now = Date.now()) => {
    const table = stewards.read(deps.dir);
    const after = new Map([...last].map(([id, c]) => [id, c.state]));
    for (const steward of Object.keys(table)) {
      if (!deps.shownHere(steward)) { pending.delete(steward); continue; }
      const list = stewards.changes(states, after, table[steward].manages);
      if (list.length) pending.set(steward, (pending.get(steward) || []).filter((c) => !list.some((x) => x.id === c.id)).concat(list));
    }
    states.clear();
    for (const [id, s] of after) states.set(id, s);
    let records = null;
    for (const [steward, list] of pending) {
      if (!table[steward] || now - (sentAt.get(steward) || 0) < NOTICE_GAP_MS) continue;
      if (!records) records = deps.records();
      const rec = records.find((r) => r && r.sessionId === steward && typeof r.messagingSocketPath === 'string');
      const names = Object.assign({}, table[steward].names);
      for (const c of list) if (last.get(c.id)) names[c.id] = last.get(c.id).title;
      const sent = rec ? await deps.post(rec.messagingSocketPath, stewards.noticeText(list, names)) : false;
      pending.delete(steward);
      sentAt.set(steward, now);
      deps.log(`steward ${steward}: ${list.length} change(s) ${sent ? 'sent' : 'not sent, no inbox reached'}`);
    }
  };

  /* Skipped while the panel is hidden and no steward here needs notices: a pass reads every plan and transcript end. */
  const pass = async () => {
    if (busy || !deps.enabled()) return;
    if (!(view && view.visible) && !Object.keys(stewards.read(deps.dir)).some((id) => deps.shownHere(id))) return;
    busy = true;
    try {
      const r = await deps.freshAgents();
      last = gather(r && r.records, deps);
      if (deps.canWrite()) {
        const names = {};
        for (const [id, c] of last) names[id] = c.title;
        stewards.rename(names, { dir: deps.dir });
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
    if (!m || !front || !deps.canWrite()) return;
    const table = stewards.read(deps.dir);
    const mine = new Set(table[front] ? table[front].manages : []);
    if (m.type === 'toggle' && typeof m.id === 'string') { if (m.on) mine.add(m.id); else mine.delete(m.id); }
    else if (m.type === 'all') for (const id of last.keys()) { if (id !== front) mine.add(id); }
    else if (m.type === 'none') mine.clear();
    else if (m.type === 'open' && typeof m.id === 'string') {
      const shown = await deps.reveal(m.id);
      if (!shown) vscode.window.showInformationMessage('That conversation is not open in this window. Open it from the session list of the window it runs in.');
      return;
    } else return;
    const names = {};
    for (const id of mine) if (last.get(id)) names[id] = last.get(id).title;
    stewards.setManaged(front, [...mine], names, { dir: deps.dir });
    render();
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
    dispose() { clearInterval(timer); reg.dispose(); },
    refresh() { render(); },
    _gather: gather, _model: model, _notify: notify, _pass: pass, _onMessage: onMessage,
  };
}

module.exports = { create, gather, doingRows, body, shell, VIEW, REFRESH_MS, NOTICE_GAP_MS };
