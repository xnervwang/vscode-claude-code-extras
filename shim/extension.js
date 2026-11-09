// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The last version of xnervwang.claude-code-extras, the id Claude Code Plus was published under before. It depends on
 * xnervwang.claude-code-plus, so updating to it installs that, and it touches nothing of Claude Code: the patch and the
 * plugin belong to Claude Code Plus now, and uninstalling this one, as its notice suggests, must not take them out. So
 * it has no uninstall hook and deactivate does nothing.
 *
 * Claude Code Plus cannot read another extension's state, and two entries of this id's are of use to it: whether the
 * extension was removed from Claude Code, and the folders remembered for scheduled prompts. They are written to
 * export.json in this id's global storage, beside Claude Code Plus's own, on every activation. The editor activates
 * this only after Claude Code Plus, which waits for the file.
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const SELF = 'xnervwang.claude-code-extras';
const EXPORT_FILE = 'export.json';
const EXPORTED_KEYS = ['claudeCodeExtras.removed', 'claudeCodeExtras.projectDirDays'];
const TOLD_KEY = 'claudeCodeExtras.toldRenamed';

/* Written under another name and renamed into place, since Claude Code Plus reads it as soon as it exists. */
function writeExport(context) {
  const dir = context.globalStorageUri.fsPath;
  const data = {};
  for (const k of EXPORTED_KEYS) {
    const v = context.globalState.get(k);
    if (v !== undefined) data[k] = v;
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, EXPORT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

function activate(context) {
  try { writeExport(context); } catch (_) { /* Claude Code Plus starts without it */ }
  if (context.globalState.get(TOLD_KEY)) return;
  Promise.resolve(context.globalState.update(TOLD_KEY, true)).catch(() => {});
  vscode.window.showInformationMessage(
    'Claude Code Plus is installed. You can uninstall Work Plan for Claude Code.', 'Uninstall',
  ).then((pick) => {
    if (pick === 'Uninstall') vscode.commands.executeCommand('workbench.extensions.uninstallExtension', SELF).then(undefined, () => {});
  }, () => {});
}

function deactivate() {}

module.exports = { activate, deactivate, EXPORT_FILE, EXPORTED_KEYS };
