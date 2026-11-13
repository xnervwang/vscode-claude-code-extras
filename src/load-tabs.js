// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The loadRestoredTabs setting. After a reload VS Code puts a window's webview tabs back, but it builds a tab's page
 * only when that tab is shown, so a conversation in a background tab stays blank until it is clicked. Bringing each
 * background Claude Code tab to the front once builds its page, and Claude Code keeps the page when the tab goes back.
 *
 * VS Code has no call that brings a tab to the front, so each editor group is focused with its focus command and its
 * tabs are shown by position with workbench.action.openEditorAtIndex. Afterwards each group shows the tab it showed
 * before, and the group that had the focus has it again.
 */

/* How long each tab stays in front, so VS Code has created its page before the next one is shown. */
const STEP_MS = 400;
const FOCUS_GROUP = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth']
  .map((n) => `workbench.action.focus${n}EditorGroup`);

/*
 * groups: vscode.window.tabGroups.all; front: the active group; isClaudeTab(tab); exec(command, ...args) -> Promise;
 * sleep(ms) -> Promise. Returns how many tabs were shown.
 */
async function loadAll({ groups, front, isClaudeTab, exec, sleep, stepMs = STEP_MS }) {
  let shown = 0;
  for (const g of groups || []) {
    const focus = FOCUS_GROUP[(g.viewColumn || 0) - 1];
    if (!focus) continue;
    const behind = g.tabs.map((t, i) => (isClaudeTab(t) && !t.isActive ? i : -1)).filter((i) => i >= 0);
    if (!behind.length) continue;
    const back = g.tabs.findIndex((t) => t.isActive);
    await exec(focus);
    for (const i of behind) {
      await exec('workbench.action.openEditorAtIndex', i);
      shown++;
      await sleep(stepMs);
    }
    if (back >= 0) await exec('workbench.action.openEditorAtIndex', back);
  }
  const home = front && FOCUS_GROUP[(front.viewColumn || 0) - 1];
  if (shown && home) await exec(home);
  return shown;
}

module.exports = { loadAll, FOCUS_GROUP, STEP_MS };
