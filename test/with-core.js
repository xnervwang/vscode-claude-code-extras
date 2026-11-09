// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Both extensions together: Agent Plus from its own checkout (AGENT_WORK_PLAN_DIR, or vscode-agent-plus beside
 * this repository) activated first, as VS Code activates a dependency, then this one, in one stand-in VS Code: Agent
 * Plus's own test/fake-vscode.js. The Claude Code source has to be taken, its conversation drawn in the Conversations
 * tree, its tab followed by the work plan view with the plan notice on top, and answers to its questions handed to the
 * panel and reported back.
 *
 * test/check.js runs this as a child process with HOME pointed at an empty folder, since the extension writes beside
 * Claude Code's plans and Agent Plus writes its answers folder. It prints a JSON list of [kind, message], kind being
 * ok, bad or note; with no Agent Plus checkout there is one note and nothing else.
 *
 * Claude Code is a folder with a stand-in `claude` that answers `agents --json` with one conversation and fails anything
 * else, so installing the work plan plugin fails and leaves its notice above the plan. The patched host is played by
 * the globals it would set: __cceAnswer hands an answer over, and __cceAnswerHook carries the panel's report back.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const verdicts = [];
const ok = (m) => verdicts.push(['ok', m]);
const bad = (m) => verdicts.push(['bad', m]);
const note = (m) => verdicts.push(['note', m]);
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok(m); else bad(`${m}: got ${g}, want ${w}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = test(); } catch (_) { v = false; }
    if (v || Date.now() > end) return v;
    await wait(50);
  }
};

async function run() {
  const core = process.env.AGENT_WORK_PLAN_DIR || path.join(root, '..', 'vscode-agent-plus');
  if (!fs.existsSync(path.join(core, 'src', 'host.js')) || !fs.existsSync(path.join(core, 'test', 'fake-vscode.js'))) {
    note(`no Agent Plus checkout at ${core}: the two were not run together`);
    return;
  }
  /* The plugin's hooks are held to src/workplan.js by test/check.js; Agent Plus's reader is what draws the plans
     now, so the two readers have to agree on the states and the limits. */
  {
    const pick = (m) => [m.STATES, m.OPEN_STATES, m.WAITING_ON, m.MAX_DETAIL_LINES, m.MAX_DETAIL_CHARS, m.MAX_QUESTION_CHARS];
    eq(pick(require(path.join(core, 'src', 'workplan.js'))), pick(require(path.join(root, 'src', 'workplan.js'))),
      'Agent Plus and the plugin agree on plan states, waiting parties and description limits');
  }
  const home = os.homedir();
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(home, 'ws-')));
  const SID = 'abababab-1111-4222-8333-444444444444';

  /* Claude Code: the folder layout this extension looks for, with a `claude` of our own. */
  const claudeExt = path.join(home, 'extensions', 'anthropic.claude-code-2.1.999-linux-x64');
  const bin = path.join(claudeExt, 'resources', 'native-binary', 'claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(path.join(claudeExt, 'resources', 'claude-logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const agents = JSON.stringify([{ sessionId: SID, id: 'aaaa1111', kind: 'interactive', cwd: ws, name: 'Asks two questions', status: 'idle' }]);
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = agents ]; then printf '%s\\n' '${agents}'; exit 0; fi\nexit 1\n`, { mode: 0o755 });

  /* Its plan, with two questions for the user. */
  const plans = path.join(home, '.claude', 'plugins', 'data', 'agent-work-plan-claude-code-extras');
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(plans, SID + '.json'), JSON.stringify({ nodes: [
    { title: 'Merge', state: 'waiting', waitingOn: 'user', question: 'Merge it?' },
    { title: 'Tag', state: 'waiting', waitingOn: 'user', question: 'Tag it?' },
  ] }));

  const fake = require(path.join(core, 'test', 'fake-vscode.js'));
  const { vscode, control } = fake.create();
  vscode.window.withProgress = async (o, fn) => fn({ report() {} });
  const undo = fake.install(vscode);
  for (const dir of [root, core]) fake.fresh(dir);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: 'ws' }];
  Object.assign(control.state.config, { 'agentPlus.workPlanView': true, 'agentPlus.conversationsView': true });

  const corePkg = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8'));
  const selfPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const coreEntry = { id: 'xnervwang.agent-plus', packageJSON: corePkg, isActive: false, exports: undefined, extensionPath: core };
  control.state.extensions = [coreEntry, { id: 'xnervwang.claude-code-plus', packageJSON: selfPkg, extensionPath: root },
    { id: 'anthropic.claude-code', packageJSON: { version: '2.1.999' }, extensionPath: claudeExt }];
  const context = (name, at, id, pkg) => {
    const storage = path.join(home, 'storage', name);
    fs.mkdirSync(storage, { recursive: true });
    return { subscriptions: [], globalState: fake.memento(), workspaceState: fake.memento(), extensionPath: at,
      globalStorageUri: vscode.Uri.file(storage), logUri: vscode.Uri.file(path.join(storage, 'logs')),
      extension: { id, packageJSON: pkg } };
  };
  const coreContext = context('core', core, coreEntry.id, corePkg);
  const selfContext = context('self', root, 'xnervwang.claude-code-plus', selfPkg);
  const handed = [];
  let report = { sent: true, reason: '' };
  globalThis.__cceAnswer = (id, text, key) => {
    if (id !== SID) return false;
    if (text === undefined) return true;
    handed.push(text);
    const r = report;
    setTimeout(() => { if (typeof globalThis.__cceAnswerHook === 'function') globalThis.__cceAnswerHook(key, r.sent, r.reason); }, 20);
    return true;
  };
  const self = require(path.join(root, 'extension.js'));
  try {
    const exported = require(path.join(core, 'extension.js')).activate(coreContext);
    Object.assign(coreEntry, { isActive: true, exports: exported });
    eq([control.state.context['agentPlus.alone'] === true, exported.agentPlus.protocol], [false, selfPkg.agentPlus.protocol],
      'Agent Plus accepts this extension\'s protocol and does not report being installed alone');
    await self.activate(selfContext);
    const registered = await until(() => control.state.log.some((l) => /conversation source registered: Claude Code \(claude-code\)/.test(l)), 5000);
    eq(!!registered, true, 'the Claude Code source is registered with Agent Plus');

    const tree = control.state.views['agentPlus.conversations'].provider;
    const rowsNow = () => tree.getChildren().filter((e) => e.kind === 'conversation').map((e) => tree.getTreeItem(e));
    /* The list it drew at registration may predate `claude agents`; the source asks Agent Plus to list again. */
    globalThis.__cceStatesHook([], '', [], []);
    await until(() => rowsNow().length, 5000);
    const rows = rowsNow();
    const status = control.state.status.find((i) => i.id === 'agentPlus.conversations');
    eq([rows.map((r) => r.id), rows[0] && rows[0].label, rows[0] && rows[0].description.split(' · ')[0], !!status && status.text.endsWith('2 to decide')],
      [[`conversations/claude-code/${SID}`], 'Asks two questions', 'needs you', true],
      'the Claude Code conversation in this workspace shows in the Conversations tree with its two questions');

    /* The tab icon hook is how the patched host says which conversation a panel shows. */
    const panel = { title: 'Asks two questions', visible: true, active: true, viewColumn: 1,
      onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }) };
    globalThis.__cceTabIcon(panel, 'idle', 'idle', claudeExt, SID);
    control.setTabs([{ label: 'Asks two questions', input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel') }]);
    control.fireTabs();
    const plan = control.state.views['agentPlus.workPlan'];
    await until(() => plan.provider.shown(), 3000);
    eq([plan.provider.shown() && plan.provider.shown().file, plan.description], [path.join(plans, SID + '.json'), 'Claude Code'],
      'the work plan view follows the Claude Code tab to that conversation\'s plan');
    await until(() => plan.provider.getChildren()[0].kind === 'problem', 20000);
    const top = plan.provider.getChildren()[0];
    const item = top && plan.provider.getTreeItem(top);
    eq([top && top.kind, item && item.label, item && item.command && item.command.command],
      ['problem', 'The plugin that writes work plans is not installed', 'claudeCodePlus.installWorkPlanPlugin'],
      'the failed plugin install is shown as a notice above the plan');
    /* A new conversation's tab in the same group, which hides the first one's panel. */
    Object.assign(panel, { visible: false, active: false });
    control.setTabs([{ label: 'New', input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel') }]);
    control.fireTabs();
    await until(() => !plan.provider.shown(), 3000);
    eq(plan.provider.shown(), null, 'a Claude Code tab with no conversation yet shows no plan');

    /* A page reports focus and a Codex tab comes to front before Agent Plus takes the report. */
    const codexTab = { label: 'Codex', input: new vscode.TabInputCustom(vscode.Uri.file('/codex/thread'), 'chatgpt.conversationEditor') };
    globalThis.__cceFocusHook(SID);
    control.setTabs([codexTab]);
    control.fireTabs();
    await wait(200);
    eq(plan.provider.shown(), null, 'a focus report overtaken by another agent\'s tab leaves the view where it was');
    globalThis.__cceFocusHook(SID);
    await until(() => plan.provider.shown(), 3000);
    eq(plan.provider.shown() && plan.provider.shown().file, path.join(plans, SID + '.json'),
      'a sidebar conversation that gets focus while a Codex tab is open moves the view to its plan');

    /* Opening the conversation from its row: only one shown in this window is brought to front. */
    const open = () => control.state.handlers['agentPlus.openConversation']({ sourceId: 'claude-code', sessionId: SID, title: 'Asks two questions', cwd: ws });
    const said = control.state.said.length;
    await open();
    eq(control.state.said.slice(said).map((m) => /could not be brought to front/.test(m.message)), [true],
      'a conversation not shown in this window gets Agent Plus\'s message that it could not be brought to front');
    globalThis.__cceSessionsShown = () => [SID];
    await open();
    eq([control.state.said.length - said, control.state.commands.some((c) => c[0] === 'claude-vscode.editor.open' && c[1] === SID)], [1, true],
      'a conversation shown in this window is brought to front with no message');

    /* Answers: the first is sent by the panel, the second finds the input already holding text. */
    const conv = () => tree.getChildren().find((e) => e.kind === 'conversation');
    const view = control.state.webviews['agentPlus.answer'];
    const answer = async (row, text) => {
      const q = tree.getChildren(conv()).map((e) => tree.getTreeItem(e)).find((i) => i.command && i.command.arguments[0].row === row);
      await control.state.handlers['agentPlus.answerQuestion'](q.command.arguments[0]);
      view.receive({ type: 'send', key: view.current.key, text });
      const key = view.current.key;
      await until(() => { const st = view.states.get(key); return st && st.kind !== 'waiting'; }, 20000);
      return view.states.get(key) || {};
    };
    const first = await answer('1', 'Yes.');
    eq([first.kind, handed.length, /Merge it\?/.test(handed[0] || '') && /Yes\.$/.test(handed[0] || '')], ['submitted', 1, true],
      'an answer reaches the panel once and comes back submitted');
    report = { sent: false, reason: 'draft' };
    control.state.clipboard = '';
    const second = await answer('2', 'Not yet.');
    eq([second.kind, typeof second.reason === 'string' && second.reason.length > 0, /Not yet\.$/.test(control.state.clipboard)],
      ['notReceived', true, true], 'an answer the panel could not type comes back not received and goes to the clipboard');
  } finally {
    for (const c of [selfContext, coreContext]) for (const d of c.subscriptions.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } }
    try { self.deactivate(); } catch (_) { /* closing */ }
    delete globalThis.__cceAnswer;
    delete globalThis.__cceSessionsShown;
    undo();
  }
}

run().catch((e) => bad(`threw: ${(e && e.stack) || e}`)).finally(() => {
  process.stdout.write(JSON.stringify(verdicts));
  process.exit(0);
});
