// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Conversations view, a tab of its own in the panel: one row per conversation of this workspace, and under it its
 * questions and its `doing` rows. src/conversations.js builds the list.
 *
 * With more than one source registered, the host sets `source` ({ id, label }) on each row, and `icon` when the logo can
 * be drawn (src/sourceicons.js). Rows without `source` look as they do with Claude Code alone.
 */
const vscode = require('vscode');
const { ageSince } = require('./workplan-view');
const { textFor } = require('./conversations-text');
const { keyPart } = require('./sources');

/* Shapes that differ, so the states can be told apart without colour. */
const LOOK = {
  prompt: ['shield', 'charts.orange'],
  needs: ['question', 'charts.orange'],
  working: ['sync~spin', 'charts.blue'],
  unread: ['circle-filled', 'charts.green'],
  idle: ['circle-outline', 'descriptionForeground'],
};

class ConversationsProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.data = { running: [], stopped: [], asks: 0 };
    this.problem = '';
    this.lang = 'en';
    this.signature = '';
  }

  /* Returns whether the tree changed; ages are part of the comparison. */
  set(data, problem = '', lang = 'en', now = Date.now()) {
    this.data = data || { running: [], stopped: [], asks: 0 };
    this.problem = problem || '';
    this.lang = lang;
    const ages = [];
    for (const c of this.data.running.concat(this.data.stopped)) {
      ages.push(ageSince(c.since, now));
      for (const r of c.doing.concat(c.questions)) ages.push(ageSince(r.since, now));
    }
    const signature = JSON.stringify([this.problem, lang, this.data.running, this.data.stopped, ages]);
    if (signature === this.signature) return false;
    this.signature = signature;
    this._emitter.fire();
    return true;
  }

  getChildren(element) {
    if (!element) {
      const rows = this.data.running.map((c) => ({ kind: 'conversation', c }));
      if (this.data.stopped.length) rows.push({ kind: 'stopped' });
      if (this.problem) rows.unshift({ kind: 'problem' });
      return rows;
    }
    if (element.kind === 'stopped') return this.data.stopped.map((c) => ({ kind: 'conversation', c }));
    if (element.kind === 'conversation') {
      const c = element.c;
      return c.questions.map((q) => ({ kind: 'question', c, q })).concat(c.doing.map((d) => ({ kind: 'doing', c, d })));
    }
    return [];
  }

  getTreeItem(element) {
    const t = textFor(this.lang);
    if (element.kind === 'problem') {
      const item = new vscode.TreeItem(t.problem);
      item.id = 'conversations/!problem';
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
      item.tooltip = this.problem;
      return item;
    }
    if (element.kind === 'stopped') {
      const item = new vscode.TreeItem(t.stopped(this.data.stopped.length), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'conversations/!stopped';
      item.iconPath = new vscode.ThemeIcon('history');
      return item;
    }
    const c = element.c;
    const from = c.source && c.source.id ? c.source : null;
    const target = { sessionId: c.sessionId, id: c.id, kind: c.kind, cwd: c.cwd, title: c.title };
    if (from) target.sourceId = from.id;
    const open = { command: 'claudeCodeWorkPlan.openWaitingConversation', title: 'Go to the conversation', arguments: [target] };
    /* Encoded so that ('a', 'b/c') and ('a/b', 'c') give different ids. */
    const where = (c.running ? '' : 'stopped/')
      + (from ? keyPart(from.id) + '/' + keyPart(c.sessionId) : c.sessionId);
    if (element.kind === 'conversation') {
      const kids = c.questions.length + c.doing.length;
      const expanded = c.running && (c.state === 'needs' || c.state === 'prompt' || c.state === 'working');
      const item = new vscode.TreeItem(c.title, !kids ? vscode.TreeItemCollapsibleState.None
        : expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'conversations/' + where;
      const [icon, color] = LOOK[c.state] || LOOK.idle;
      item.iconPath = (from && c.icon) || new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
      item.description = [t.state[c.state], c.questions.length ? t.questions(c.questions.length) : '',
        c.hasPlan ? t.open(c.open) : t.noPlan].filter(Boolean).join(' · ');
      item.tooltip = [c.title, from ? from.label : '', t.state[c.state], c.cwd ? t.folder(c.cwd) : ''].filter(Boolean).join('\n');
      item.command = open;
      return item;
    }
    if (element.kind === 'question') {
      const q = element.q;
      const item = new vscode.TreeItem(`${q.row}. ${q.question}`);
      item.id = `conversations/${where}/?${q.row}`;
      item.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.orange'));
      item.description = t.asked(ageSince(q.since));
      item.tooltip = `${q.question}\n\n${q.row}. ${q.title}`;
      item.command = {
        command: 'claudeCodeWorkPlan.answerQuestion', title: 'Answer it',
        arguments: [Object.assign({
          sessionId: c.sessionId, row: q.row, rowTitle: q.title, question: q.question, note: q.note, detail: q.detail,
          since: q.since, conversation: c.title, running: c.running, open: target,
        }, from ? { sourceId: from.id } : {})],
      };
      return item;
    }
    const d = element.d;
    const item = new vscode.TreeItem(`${d.row}. ${d.title}`);
    item.id = `conversations/${where}/>${d.row}`;
    const busy = c.state === 'working';
    item.iconPath = busy ? new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.blue'))
      : new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('descriptionForeground'));
    item.description = busy ? t.doing(ageSince(d.since)) : t.lastWorked(ageSince(c.since));
    item.tooltip = `${d.row}. ${d.title}\n\n${item.description}`;
    item.command = open;
    return item;
  }
}

module.exports = { ConversationsProvider, LOOK };
