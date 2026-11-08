// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Claude Code's conversation source (src/sources.js).
 *
 *   conversations    `claude agents --json` for the running ones (src/waiting.js), recent plans with open rows for the
 *                    stopped ones (src/conversations.js), states from the patched host (src/host.js)
 *   plans            <session id>.json in the companion plugin's data directory (src/workplan.js)
 *   focus            a change of the host's activeSessionId; a panel's onDidChangeViewState; sessionForTab(); and the
 *                    page getting focus (src/page/92-focus.js), the only signal a sidebar conversation gives
 *   answers          typed into the panel showing the conversation (src/page/91-answer.js)
 *
 * The host also writes activeSessionId back unchanged, for example when a background panel's state changes, so only a
 * change counts; otherwise the view would jump away from a Codex tab. Switching back to the same Claude Code tab from a
 * Codex tab leaves activeSessionId unchanged, which is why the panel's view state is followed too.
 */
const vscode = require('vscode');
const path = require('path');
const waiting = require('./waiting');
const conversations = require('./conversations');
const { emitter, PROTOCOL, BUILTIN } = require('./sources');

const AGENTS_FRESH_MS = 30000;
const ANSWER_WAIT_MS = 20000;
const REMEMBERED = 500;

/* VS Code prefixes a webview panel's viewType (mainThreadWebview-...), so only the end is compared. */
const isPanelTab = (tab) => !!tab && tab.input instanceof vscode.TabInputWebview && String(tab.input.viewType).endsWith('claudeVSCodePanel');

/*
 * `deps`:
 *   listAgents()                    `claude agents --json`, as { records, error }
 *   readPlan(sessionId)             for titles taken from the plan, and for stopped conversations
 *   titles(s), since(s)             from waiting.reader()
 *   live(), unread()                the host's latest states by session id; ids with an unread reply
 *   activeChat()                    the host's activeSessionId, or ''
 *   hand(sessionId, text, key)      gives the answer to the panel; its result comes back through answered()
 *   reveal(sessionId, title, cwd)   Promise<boolean>
 *   isBackground(id, cwd)           optional, for tests
 */
function createClaudeSource(deps) {
  const focused = emitter(), changed = emitter();
  let stale = true, agentsAt = 0, agentsLast = { records: null, error: '' }, stoppedLast = new Map(), pidsAsk = null;
  let lastChat = null;
  /* Kept after a conversation leaves the list: a question in the Answer view can outlive its row, and reveal() still
     needs the title and folder for its message. */
  const listed = new Map();
  const remember = (c) => {
    listed.delete(c.sessionId);
    listed.set(c.sessionId, { title: c.title, cwd: c.cwd });
    if (listed.size > REMEMBERED) listed.delete(listed.keys().next().value);
  };
  /* panel -> { sessionId, subs } */
  const panels = new Map();
  const unsubscribe = (subs) => { for (const d of subs) { try { d.dispose(); } catch (_) { /* already disposed */ } } };
  const pending = new Map();
  let keys = 0;

  const ask = () => deps.listAgents().then((r) => { agentsLast = r; agentsAt = Date.now(); return r; });

  const source = {
    protocol: PROTOCOL,
    features: [],
    id: BUILTIN,
    label: 'Claude Code',
    get logo() { try { return deps.logo(); } catch (_) { return null; } },
    planDir: () => deps.planDir(),
    planPath: (sessionId) => (sessionId ? path.join(deps.planDir(), sessionId + '.json') : null),
    onDidFocus: focused.event,
    onDidChangeConversations: changed.event,

    sessionForTab(tab) {
      if (!isPanelTab(tab)) return null;
      const column = tab.group && tab.group.viewColumn;
      let best = null;
      for (const [panel, { sessionId }] of panels) {
        if (!sessionId || !panel.visible || panel.viewColumn !== column) continue;
        if (!best || panel.active) best = sessionId;
      }
      return best;
    },

    async listConversations() {
      const fresh = stale || !agentsAt;
      stale = false;
      if (fresh) await ask();
      const { records, error } = agentsLast;
      const folders = deps.folders();
      const all = records ? waiting.merge(records) : new Map();
      const running = waiting.inFolders(all, folders, deps.isBackground ? { isBackground: deps.isBackground } : undefined);
      if (fresh) stoppedLast = conversations.stoppedWithOpenRows(folders, new Set(all.keys()), { readPlan: deps.readPlan });
      const live = deps.live(), unread = deps.unread();
      const one = (s, on) => ({
        sessionId: s.sessionId, id: s.id, kind: s.kind, cwd: s.cwd, running: on,
        state: on ? conversations.stateOf(s, live, unread) : 'idle',
        title: conversations.claudeTitle(s, deps.titles(s), () => deps.readPlan(s.sessionId)),
        lastActiveAt: deps.since(s) || 0, hasPlan: false,
      });
      const out = [...running.values()].map((s) => one(s, true)).concat([...stoppedLast.values()].map((s) => one(s, false)));
      for (const c of out) remember(c);
      if (!records) out.problem = error;
      return out;
    },

    /* `row` is the clicked row's { title, cwd }, used when this conversation is no longer remembered. */
    async reveal(sessionId, row) {
      const c = listed.get(sessionId);
      const title = c ? c.title : row && typeof row.title === 'string' && row.title ? row.title : sessionId;
      const cwd = c ? c.cwd : row && typeof row.cwd === 'string' ? row.cwd : '';
      return deps.reveal(sessionId, title, cwd);
    },

    canDeliver: (sessionId) => deps.canDeliver(sessionId) === true,

    deliverAnswer(sessionId, text) {
      const key = 'cc-' + Date.now().toString(36) + '-' + (++keys);
      let handed = false;
      try { handed = deps.hand(sessionId, text, key) === true; } catch (_) { handed = false; }
      if (!handed) return Promise.resolve({ delivered: false, reason: 'not-shown' });
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(key); resolve({ delivered: false, reason: 'no-reply' }); }, ANSWER_WAIT_MS);
        pending.set(key, (sent, reason) => { clearTimeout(timer); resolve({ delivered: sent, reason: reason || '' }); });
      });
    },
  };

  return {
    source,
    invalidate() { stale = true; agentsAt = 0; },
    changed() { changed.fire(); },
    answered(key, sent, reason) {
      const done = pending.get(key);
      if (!done) return;
      pending.delete(key);
      done(sent === true, typeof reason === 'string' ? reason : '');
    },
    followChat() {
      const id = deps.activeChat() || '';
      if (id === lastChat) return false;
      lastChat = id;
      focused.fire({ sessionId: id });
      return true;
    },
    pageFocus(sessionId) {
      if (typeof sessionId === 'string' && sessionId) focused.fire({ sessionId });
    },
    /* Called from the tab icon hook (src/host.js). */
    track(panel, sessionId) {
      if (!panel || typeof panel !== 'object') return;
      const id = typeof sessionId === 'string' ? sessionId : '';
      const known = panels.get(panel);
      if (known) { known.sessionId = id; return; }
      const entry = { sessionId: id, subs: [] };
      panels.set(panel, entry);
      const keep = (d) => { if (d && typeof d.dispose === 'function') entry.subs.push(d); };
      try {
        if (typeof panel.onDidChangeViewState === 'function') {
          keep(panel.onDidChangeViewState(() => {
            if (panel.active && entry.sessionId) focused.fire({ sessionId: entry.sessionId });
          }));
        }
        if (typeof panel.onDidDispose === 'function') {
          keep(panel.onDidDispose(() => {
            if (panels.get(panel) === entry) panels.delete(panel);
            unsubscribe(entry.subs);
          }));
        }
      } catch (_) { /* focus then comes from the other signals */ }
    },
    freshAgents() {
      if (agentsLast.records && Date.now() - agentsAt < AGENTS_FRESH_MS) return Promise.resolve(agentsLast);
      if (!pidsAsk) pidsAsk = deps.listAgents().then((r) => { if (r.records) { agentsLast = r; agentsAt = Date.now(); } return r; })
        .finally(() => { pidsAsk = null; });
      return pidsAsk;
    },
    dispose() {
      focused.dispose();
      changed.dispose();
      for (const done of pending.values()) done(false, 'no-reply');
      pending.clear();
      for (const { subs } of panels.values()) unsubscribe(subs);
      panels.clear();
    },
  };
}

module.exports = { createClaudeSource, isPanelTab, ANSWER_WAIT_MS, REMEMBERED };
