// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Renders the Conversations tab and the work plan view for a fixture of Claude Code conversations and prints the tree
 * items as JSON. test/check.js compares the output with test/golden/single-source-trees.json, which was recorded at the
 * commit before conversation sources were added; with Claude Code as the only source they must be identical.
 *
 *   node test/single-source-trees.js build     builds the list with conversations.build()
 *   node test/single-source-trees.js sources   builds it through src/claude-source.js and conversations.assemble(),
 *                                              as extension.js does
 *
 * test/check.js runs this as a child process with the clock fixed (CCE_FIXED_NOW), so ages and times are the same on
 * every run, and with HOME set to a temporary folder holding the fixture's plans.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXED = Number(process.env.CCE_FIXED_NOW);
if (!FIXED) throw new Error('CCE_FIXED_NOW is not set');
Date.now = () => FIXED;
const mode = process.argv[2];
const home = os.homedir();

const stub = path.join(home, 'vscode-stub.js');
fs.writeFileSync(stub, `
  class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
  class MarkdownString { constructor(v) { this.value = v || ''; } }
  class EventEmitter { constructor() { this.l = []; this.event = (fn) => { this.l.push(fn); return { dispose() {} }; }; } fire(v) { for (const f of this.l) f(v); } }
  module.exports = { version: '1.144.0', TreeItem, MarkdownString, EventEmitter,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    Disposable: class { constructor(fn) { this.fn = fn; } dispose() { if (this.fn) this.fn(); } },
    TabInputWebview: class {},
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) } };`);
const Module = require('module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { return request === 'vscode' ? stub : realResolve.call(this, request, ...rest); };

const root = path.join(__dirname, '..');
const conv = require(path.join(root, 'src/conversations'));
const w = require(path.join(root, 'src/waiting'));
const wp = require(path.join(root, 'src/workplan'));
const { ConversationsProvider } = require(path.join(root, 'src/conversations-view'));
const { WorkPlanProvider } = require(path.join(root, 'src/workplan-view'));
const sources = require(path.join(root, 'src/sources'));
const { createClaudeSource } = require(path.join(root, 'src/claude-source'));

/* Seven running conversations covering every drawn state (one outside the workspace), one stopped conversation with
   open rows, and their plans. */
const now = FIXED;
const S = (n) => '7' + String(n).padStart(7, '0') + '-1111-4222-8333-444444444444';
const H = 3600e3, M = 60e3, DAY = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const dir = wp.planDir();
fs.mkdirSync(dir, { recursive: true });
const plans = {
  [S(1)]: { nodes: [{ title: 'ask first', state: 'waiting', waitingOn: 'user', question: 'Go ahead?', since: iso(now - 2 * H - 5 * M), asked: iso(now - 2 * H - 5 * M) }] },
  [S(2)]: { title: 'plan two', nodes: [
    { title: 'publish', state: 'waiting', waitingOn: 'user', question: 'Publish 1.0.20 now?', note: 'n', detail: 'd', since: iso(now - 3 * DAY - H), asked: iso(now - H - 5 * M) },
    { title: 'old style', state: 'waiting', since: iso(now - 2 * H - 5 * M) },
    { title: 'parent', state: 'doing', since: iso(now - 2 * H - 5 * M), children: [
      { title: 'pick', state: 'discussing', waitingOn: 'user', question: 'A or B?', since: iso(now - 10 * M - 30e3) },
      { title: 'child done', state: 'done' },
    ] },
    { title: 'built', state: 'done' },
    { title: 'queued', state: 'todo' },
    { title: 'later', state: 'parked' },
    { title: 'not this', state: 'dropped' },
  ] },
  [S(3)]: { nodes: [{ title: 'build it', state: 'doing', since: iso(now - 10 * M - 30e3) }] },
  [S(6)]: { title: 'From the plan', nodes: [{ title: 'x', state: 'todo' }] },
  [S(8)]: { nodes: [{ title: 'left over', state: 'todo' }, { title: 'stuck', state: 'doing', since: iso(now - 3 * DAY - H) }] },
};
for (const [id, p] of Object.entries(plans)) fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(p));
const cwd = '/ws/proj';
const fx = {
  focus: S(2), problem: '',
  records: [
    { sessionId: S(1), id: 'aaaa1111', kind: 'interactive', cwd, name: 'proj-92', status: 'waiting', waitingFor: 'permission prompt' },
    { sessionId: S(2), id: 'bbbb2222', kind: 'interactive', cwd, name: 'asks', status: 'idle' },
    { sessionId: S(3), id: 'cccc3333', kind: 'interactive', cwd, name: 'busy one', status: 'busy' },
    { sessionId: S(4), id: 'dddd4444', kind: 'interactive', cwd, name: 'unread one', status: 'idle' },
    { sessionId: S(5), id: 'eeee5555', kind: 'interactive', cwd, name: 'proj-5f', status: 'idle' },
    { sessionId: S(6), id: 'ffff6666', kind: 'interactive', cwd, name: 'proj-6a', status: 'idle' },
    { sessionId: S(7), id: '77777777', kind: 'interactive', cwd: '/elsewhere', name: 'other', status: 'idle' },
  ],
  inFolder: [S(1), S(2), S(3), S(4), S(5), S(6)],
  stopped: [{ sessionId: S(8), id: '', kind: 'interactive', cwd, name: '', waitingFor: '', busy: false, processes: 0 }],
  titles: { [S(1)]: { custom: 'Release work', ai: '' }, [S(5)]: { custom: '', ai: 'AI title' } },
  since: { [S(1)]: now - 2 * M - 5e3, [S(2)]: now - 60e3, [S(3)]: now - 30e3, [S(4)]: now - 50 * M, [S(5)]: now - 2 * H - 5 * M,
    [S(6)]: now - 3 * DAY - H, [S(8)]: now - 2 * DAY - H },
  live: [[S(5), 'running']], unread: [S(4)],
};

const walk = (tree) => {
  const out = [];
  const visit = (el) => {
    out.push(JSON.parse(JSON.stringify(tree.getTreeItem(el))));
    for (const c of tree.getChildren(el) || []) visit(c);
  };
  for (const el of tree.getChildren() || []) visit(el);
  return out;
};

(async () => {
  let data, plan;
  if (mode === 'build') {
    const merged = w.merge(fx.records);
    const sessions = new Map([...merged].filter(([id]) => fx.inFolder.includes(id)));
    data = conv.build({ sessions, stopped: new Map(fx.stopped.map((s) => [s.sessionId, s])), now, readPlan: wp.readPlan,
      titles: (s) => fx.titles[s.sessionId] || { custom: '', ai: '' }, since: (s) => fx.since[s.sessionId] || 0,
      live: new Map(fx.live), unread: new Set(fx.unread) });
    plan = new WorkPlanProvider();
    plan.setFocus(fx.focus);
  } else if (mode === 'sources') {
    /* Claude Code's source finds a stopped conversation through a recent plan with open rows and a transcript whose cwd is
       in the workspace. */
    const projects = path.join(home, '.claude', 'projects', '-ws-proj');
    fs.mkdirSync(projects, { recursive: true });
    for (const s of fx.stopped) {
      fs.writeFileSync(path.join(projects, s.sessionId + '.jsonl'), JSON.stringify({ type: 'user', cwd, sessionId: s.sessionId }) + '\n');
    }
    const claude = createClaudeSource({
      planDir: wp.planDir, listAgents: async () => ({ records: fx.records, error: '' }), folders: () => [cwd],
      readPlan: wp.readPlan, titles: (s) => fx.titles[s.sessionId] || { custom: '', ai: '' }, since: (s) => fx.since[s.sessionId] || 0,
      live: () => new Map(fx.live), unread: () => new Set(fx.unread), activeChat: () => fx.focus, logo: () => null,
      canDeliver: () => false, hand: () => false, reveal: async () => false, isBackground: () => false,
    });
    const registry = new sources.Registry(), focus = new sources.Focus();
    registry.add(claude.source);
    claude.source.onDidFocus((e) => focus.report(sources.BUILTIN, e.sessionId));
    claude.followChat();
    const planOf = (sourceId, session) => {
      const source = registry.get(sourceId);
      const file = source ? sources.planFileOf(source, session) : '';
      return { file, plan: file ? wp.readPlanAt(file, session) : null };
    };
    const lists = [];
    for (const { id, source } of registry.list()) {
      lists.push({ sourceId: id, conversations: sources.conversations(await source.listConversations()) });
    }
    data = conv.assemble({ lists, folders: [cwd], planOf });
    plan = new WorkPlanProvider({ read: (session, sourceId) => planOf(sourceId, session).plan });
    plan.setFocus(focus.sessionId, focus.sourceId);
  } else throw new Error('unknown mode ' + mode);
  const result = {};
  for (const lang of ['en', 'zh-cn']) {
    const tree = new ConversationsProvider();
    tree.set(data, fx.problem, lang, now);
    result['conversations-' + lang] = walk(tree);
  }
  result.asks = data.asks; result.running = data.running.length; result.stopped = data.stopped.length;
  plan.setTimeZone('UTC');
  plan.refresh();
  result.workplan = walk(plan);
  const n = wp.countOpen(plan.shown().nodes);
  result.badge = (n.todo || 0) + (n.discussing || 0);
  process.stdout.write(JSON.stringify(result));
})().catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.stack) })); });
