// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Checks, from inside the VS Code that run.js started, what the extension did to fresh installs on this platform.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, ms) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = test(); } catch (_) { v = false; }
    if (v || Date.now() > end) return v;
    await sleep(1000);
  }
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };

async function run() {
  const results = [];
  const ok = (cond, msg, detail) => {
    results.push(cond);
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}${cond || !detail ? '' : ': ' + detail}`);
  };
  console.log(`\nin VS Code ${vscode.version} on ${process.platform}-${process.arch}`);

  const mine = vscode.extensions.getExtension('xnervwang.claude-code-extras');
  const claude = vscode.extensions.getExtension('anthropic.claude-code');
  const core = vscode.extensions.getExtension('xnervwang.agent-plus');
  ok(!!mine, 'this extension is installed');
  ok(!!claude, 'Claude Code is installed', claude ? '' : 'not found');
  ok(!!core, 'Agent Plus is installed', core ? '' : 'not found');
  if (!mine || !claude || !core) throw new Error('an extension is missing');
  // The installed copy's modules: that copy did the patching.
  const from = (name) => require(path.join(mine.extensionPath, 'src', name));
  const ADAPTERS = from('adapters'), plugin = from('plugin-install');
  console.log(`  Claude Code ${claude.packageJSON.version} at ${claude.extensionPath}`);
  let activated = '';
  try { await mine.activate(); } catch (e) { activated = e && e.message; }
  ok(!activated && mine.isActive, 'this extension activates', activated);

  for (const a of ADAPTERS) {
    const file = a.targetFile(claude.extensionPath);
    const patched = await until(() => read(file).includes(a.ANY_MARK), 120000);
    ok(patched, `${a.name}: patched`, file);
    ok(fs.existsSync(file + a.BACKUP_SUFFIX), `${a.name}: the unpatched file is kept beside it`);
  }
  const live = path.join(claude.extensionPath, 'webview', 'claude-code-extras.css');
  ok(await until(() => fs.existsSync(live), 30000), 'the live stylesheet is written', live);
  ok(ADAPTERS[0].status(claude.extensionPath) === 'patched', 'the panel bundle carries this version of the patch');

  const records = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  ok(await until(() => read(records).includes(plugin.REF), 180000), `${plugin.REF} is registered with Claude Code`,
    read(records).slice(0, 400) || 'no ' + records);

  const failures = results.filter((r) => !r).length;
  console.log(`\nin VS Code: ${results.length - failures} passed, ${failures} failed`);
  if (failures) throw new Error(`${failures} check(s) failed`);
}

module.exports = { run };
