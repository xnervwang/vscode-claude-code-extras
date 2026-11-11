// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Claude Code as a conversation source of Agent Plus (xnervwang.agent-plus, protocol 1; its docs/protocol.md).
 *
 *   conversations    `claude agents --json` for the running ones (src/waiting.js), recent plans with open rows for the
 *                    stopped ones (src/conversations.js), states from the patched host (src/host.js)
 *   plans            <session id>.json in the companion plugin's data directory (src/workplan.js)
 *   focus            a change of the host's activeSessionId; a panel's onDidChangeViewState; sessionForTab(); and the
 *                    page getting focus (src/page/92-focus.js), the only signal a sidebar conversation gives
 *   answers          typed into the panel showing the conversation (src/page/91-answer.js)
 *   plan notice      the plugin that writes plans failed to install, or there is no Python 3 to run the hooks
 *
 * The host also writes activeSessionId back unchanged, for example when a background panel's state changes, so only a
 * change counts; otherwise the view would jump away from a Codex tab. Switching back to the same Claude Code tab from a
 * Codex tab leaves activeSessionId unchanged, which is why the panel's view state is followed too.
 */
const vscode = require('vscode');
const path = require('path');
const waiting = require('./waiting');
const conversations = require('./conversations');
const { SESSION } = require('./claude-files');
const { oncePerDelivery } = require('./core-link');

/* The protocol major this source implements; package.json repeats it under "agentPlus". */
const PROTOCOL = 1;
const ID = 'claude-code';
const EXTENSION_ID = 'xnervwang.claude-code-plus';
const AGENTS_FRESH_MS = 30000;
/* Shorter than Agent Plus's 20-second wait, after which it reports the answer as uncertain and drops a late
   "not received". */
const ANSWER_WAIT_MS = 15000;

/*
 * The reasons the panel script (src/page/91-answer.js) gives for not sending. In each of these the answer is not in the
 * message input. Any other reason, such as 'error', maps to uncertain, since the input may still hold the answer.
 */
const NOT_RECEIVED = {
  'not-shown': 'the panel had switched to another conversation',
  'no-input': 'the panel has no message input',
  draft: 'the message input already had text in it',
  insert: 'the answer could not be typed into the message input',
  'left-in-input': 'Enter did not send it, so it was taken back out of the message input',
};
function outcomeOf(sent, reason) {
  if (sent === true) return { outcome: 'submitted' };
  if (Object.prototype.hasOwnProperty.call(NOT_RECEIVED, reason)) return { outcome: 'notReceived', reason: NOT_RECEIVED[reason] };
  return { outcome: 'uncertain', reason: reason ? `the panel reported "${reason}"` : 'the panel gave no reason' };
}

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

/* VS Code prefixes a webview panel's viewType (mainThreadWebview-...), so only the end is compared. */
const isPanelTab = (tab) => !!tab && tab.input instanceof vscode.TabInputWebview && String(tab.input.viewType).endsWith('claudeVSCodePanel');

/*
 * `deps`:
 *   planDir()                       the companion plugin's data directory
 *   enabled()                       claudeCodePlus.workPlan: off, no conversation has a plan
 *   listAgents()                    `claude agents --json`, as { records, error }
 *   readPlan(sessionId)             for titles taken from the plan, and for stopped conversations
 *   titles(s), since(s)             from waiting.reader()
 *   live(), unread()                the host's latest states by session id; ids with an unread reply
 *   activeChat()                    the host's activeSessionId, or ''
 *   canDeliver(sessionId)           whether a panel in this window shows it
 *   hand(sessionId, text, key)      gives the answer to the panel; its result comes back through answered()
 *   reveal(sessionId)               Promise<boolean>
 *   logo()                          { light, dark } Uris, or null
 *   timeZone()                      the zone a panel reported, or ''
 *   isBackground(id, cwd)           optional, for tests
 */
function createClaudeSource(deps) {
  const focused = emitter(), changed = emitter(), noticeChanged = emitter();
  let stale = true, agentsAt = 0, agentsLast = { records: null, error: '' }, stoppedLast = new Map(), pidsAsk = null;
  let lastChat = null;
  /* The session id of the latest focus signal: Agent Plus asks isFocused() a moment after each one, and only the
     latest is still in front. It is cleared when another tab, such as a Codex one, becomes active after it. */
  let front = '';
  let frontTab;
  let notice = null;
  /* panel -> { sessionId, subs } */
  const panels = new Map();
  const unsubscribe = (subs) => { for (const d of subs) { try { d.dispose(); } catch (_) { /* already disposed */ } } };
  const pending = new Map();
  let keys = 0;
  const enabled = () => { try { return deps.enabled ? deps.enabled() !== false : true; } catch (_) { return true; } };
  const briefOn = () => { try { return deps.brief ? deps.brief() !== false : false; } catch (_) { return false; } };
  const say = (sessionId) => { front = sessionId; focused.fire({ sessionId }); };

  const ask = () => deps.listAgents().then((r) => { agentsLast = r; agentsAt = Date.now(); return r; });

  const deliver = (sessionId, text) => {
    const key = 'cc-' + Date.now().toString(36) + '-' + (++keys);
    let handed = false;
    try { handed = deps.hand(sessionId, text, key) === true; } catch (_) { handed = false; }
    if (!handed) return Promise.resolve({ outcome: 'notReceived', reason: 'no Claude Code panel in this window shows the conversation' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        resolve({ outcome: 'uncertain', reason: `the panel did not report within ${ANSWER_WAIT_MS / 1000} seconds` });
      }, ANSWER_WAIT_MS);
      pending.set(key, (sent, reason) => { clearTimeout(timer); resolve(outcomeOf(sent, reason)); });
    });
  };
  /* Agent Plus can hand over one answer twice under the same delivery id; it is typed once, even while the first try runs.
     An answer that never reached a panel can be handed over again (src/core-link.js). */
  const deliverOnce = oncePerDelivery(deliver);

  const source = {
    protocol: PROTOCOL,
    /* 'brief': Agent Plus shows the conversation's brief when its row is clicked. */
    get features() { return enabled() && briefOn() ? ['brief'] : []; },
    id: ID,
    label: 'Claude Code',
    extensionId: EXTENSION_ID,
    get logo() { try { return deps.logo(); } catch (_) { return null; } },
    planDir: () => deps.planDir(),
    planPath: (sessionId) => (enabled() && SESSION.test(String(sessionId || '')) ? path.join(deps.planDir(), sessionId + '.json') : null),
    onDidFocus: focused.event,
    onDidChangeConversations: changed.event,
    onDidChangePlanNotice: noticeChanged.event,

    /* The session of the visible panel in the tab's group; '' for a Claude Code tab with no conversation yet, or whose
       panel has not been reported yet; null for any other tab. */
    sessionForTab(tab) {
      if (!isPanelTab(tab)) return null;
      const column = tab.group && tab.group.viewColumn;
      let best = '';
      for (const [panel, { sessionId }] of panels) {
        if (!sessionId || !panel.visible || panel.viewColumn !== column) continue;
        if (!best || panel.active) best = sessionId;
      }
      return best;
    },

    isFocused(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return false;
      if (sessionId === front) return true;
      for (const [panel, entry] of panels) if (entry.sessionId === sessionId && panel.active) return true;
      return false;
    },

    async listConversations() {
      const fresh = stale || !agentsAt;
      stale = false;
      if (fresh) await ask();
      const { records, error } = agentsLast;
      const folders = deps.folders();
      const all = records ? waiting.merge(records) : new Map();
      const running = waiting.inFolders(all, folders, deps.isBackground ? { isBackground: deps.isBackground } : undefined);
      if (fresh) {
        stoppedLast = enabled() ? conversations.stoppedWithOpenRows(folders, new Set(all.keys()), { readPlan: deps.readPlan }) : new Map();
      }
      const live = deps.live(), unread = deps.unread();
      const one = (s, on) => ({
        sessionId: s.sessionId,
        title: conversations.claudeTitle(s, deps.titles(s), () => deps.readPlan(s.sessionId)),
        cwd: s.cwd,
        state: on ? conversations.stateOf(s, live, unread) : 'idle',
        running: on,
        lastActiveAt: deps.since(s) || 0,
        hasPlan: false,
      });
      const out = [...running.values()].map((s) => one(s, true)).concat([...stoppedLast.values()].map((s) => one(s, false)));
      if (!records) out.problem = error;
      return out;
    },

    reveal: (sessionId) => deps.reveal(sessionId),

    canDeliver: (sessionId) => deps.canDeliver(sessionId) === true,

    deliverAnswer(sessionId, text, opts) { return deliverOnce(sessionId, text, opts); },

    planNotice: () => notice,
    timeZone: () => { try { return deps.timeZone ? deps.timeZone() || '' : ''; } catch (_) { return ''; } },
  };

  return {
    source,
    invalidate() { stale = true; agentsAt = 0; },
    changed() { changed.fire(); },
    /* `next` is { title, description, detail, command, arguments } or null. */
    setNotice(next) {
      const was = JSON.stringify(notice);
      notice = next || null;
      if (JSON.stringify(notice) !== was) noticeChanged.fire();
    },
    answered(key, sent, reason) {
      const done = pending.get(key);
      if (!done) return;
      pending.delete(key);
      done(sent === true, typeof reason === 'string' ? reason : '');
    },
    /* Returns whether the host's active session moved. The move is reported as focus only while the active tab is a
       Claude Code panel or there is none: the host keeps that id while another agent's tab is in front, as it is at
       start-up after a reload, and a sidebar panel getting focus reports itself (pageFocus). */
    followChat() {
      const id = deps.activeChat() || '';
      if (id === lastChat) return false;
      lastChat = id;
      if (!frontTab || isPanelTab(frontTab)) say(id);
      return true;
    },
    pageFocus(sessionId) {
      if (typeof sessionId === 'string' && sessionId) say(sessionId);
    },
    /* Called with the active tab whenever tabs change. */
    tabsChanged(tab) {
      if (tab === frontTab) return;
      frontTab = tab;
      if (tab && !isPanelTab(tab)) front = '';
    },
    /* Fires onDidFocus again for the conversation in front; called once registration with Agent Plus completes, which
       can be after the first signal. */
    refocus() {
      if (front) focused.fire({ sessionId: front });
    },
    /* Called from the tab icon hook (src/host.js). When the active panel is first reported with a session id, or gets a new
       one as a new conversation does, that session is reported as the conversation in front. */
    track(panel, sessionId) {
      if (!panel || typeof panel !== 'object') return;
      const id = typeof sessionId === 'string' ? sessionId : '';
      const known = panels.get(panel);
      if (known) {
        if (known.sessionId === id) return;
        known.sessionId = id;
        if (id && panel.active) say(id);
        return;
      }
      const entry = { sessionId: id, subs: [] };
      panels.set(panel, entry);
      const keep = (d) => { if (d && typeof d.dispose === 'function') entry.subs.push(d); };
      try {
        if (typeof panel.onDidChangeViewState === 'function') {
          keep(panel.onDidChangeViewState(() => {
            if (panel.active && entry.sessionId) say(entry.sessionId);
          }));
        }
        if (typeof panel.onDidDispose === 'function') {
          keep(panel.onDidDispose(() => {
            if (panels.get(panel) === entry) panels.delete(panel);
            unsubscribe(entry.subs);
          }));
        }
      } catch (_) { /* focus then comes from the other signals */ }
      if (id && panel.active) say(id);
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
      noticeChanged.dispose();
      for (const done of pending.values()) done(false, '');
      pending.clear();
      for (const { subs } of panels.values()) unsubscribe(subs);
      panels.clear();
    },
  };
}

module.exports = { createClaudeSource, isPanelTab, outcomeOf, emitter, PROTOCOL, ID, EXTENSION_ID, ANSWER_WAIT_MS };
