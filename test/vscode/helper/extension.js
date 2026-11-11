// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Loaded into the window test/vscode/ui.js drives, as a development extension. ui.js cannot reach the vscode API from
 * outside the window, so it writes a request file into the folder CLAUDE_CODE_PLUS_UI_CONTROL names and this extension
 * runs the request's body with `vscode` in scope and writes the result back. Files rather than a socket, because the
 * window is reloaded during the run: the extension host restarts, and the requests left in the folder wait for the next
 * one. Each extension host writes host-<pid>.json when it is up.
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function activate(context) {
  const dir = process.env.CLAUDE_CODE_PLUS_UI_CONTROL;
  if (!dir) return;
  const write = (name, value) => {
    const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, path.join(dir, name));
  };
  const busy = new Set();
  const take = async (name) => {
    const id = name.slice(0, -'.req.json'.length);
    const taken = path.join(dir, `${id}.taken-${process.pid}`);
    try { fs.renameSync(path.join(dir, name), taken); } catch (_) { return; }
    let reply;
    try {
      const { body, arg } = JSON.parse(fs.readFileSync(taken, 'utf8'));
      reply = { ok: true, value: await new AsyncFunction('vscode', 'require', 'arg', body)(vscode, require, arg) };
    } catch (e) {
      reply = { ok: false, error: String((e && e.stack) || e) };
    }
    try { write(`${id}.res.json`, reply); } catch (e) { write(`${id}.res.json`, { ok: false, error: `the result could not be sent: ${e.message}` }); }
    fs.rmSync(taken, { force: true });
  };
  const poll = () => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of names) {
      if (!n.endsWith('.req.json') || busy.has(n)) continue;
      busy.add(n);
      take(n).finally(() => busy.delete(n));
    }
  };
  const timer = setInterval(poll, 150);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  write(`host-${process.pid}.json`, { pid: process.pid, at: Date.now(), version: vscode.version, platform: process.platform });
}

module.exports = { activate, deactivate() {} };
