// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Usage: node test/vscode/run.js <path to the .vsix> [<path to Agent Plus's .vsix>]. Downloads the newest stable
 * VS Code, installs the newest Claude Code, Agent Plus and the .vsix into it, and runs ./suite inside it; then runs
 * test/check.js against those installs. Exits non-zero if either fails. Agent Plus is installed from its .vsix when
 * one is given, and from the marketplace otherwise; it has to be there before the .vsix, which depends on it.
 *
 * Needs @vscode/test-electron, which the workflow installs. On Linux it needs a display: run it under xvfb-run.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadAndUnzipVSCode, runVSCodeCommand, runTests } = require('@vscode/test-electron');

const ROOT = path.join(__dirname, '..', '..');

function settingsFor(user) {
  const dir = path.join(user, 'User');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    'claudeCode.disableLoginPrompt': true,
    'extensions.autoUpdate': false,
    'telemetry.telemetryLevel': 'off',
  }, null, 2));
}

/* The extension's own log, from the logs VS Code wrote under the user data folder. */
function printLog(user) {
  const found = [];
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (/Work Plan for Claude Code\.log$/.test(n.name)) found.push(p);
    }
  };
  walk(path.join(user, 'logs'));
  for (const f of found) {
    console.log(`\n--- ${path.relative(user, f)}`);
    console.log(fs.readFileSync(f, 'utf8'));
  }
}

async function main() {
  // The extension registers its plugin in ~/.claude of whoever runs this, so it runs only on a throwaway machine.
  if (process.env.CI !== 'true') throw new Error('runs only where CI=true: it registers a plugin in your ~/.claude');
  const vsix = path.resolve(process.argv[2] || '');
  if (!process.argv[2] || !fs.existsSync(vsix)) throw new Error('usage: node test/vscode/run.js <path to the .vsix> [<Agent Plus .vsix>]');
  const core = process.argv[3] ? path.resolve(process.argv[3]) : 'xnervwang.agent-plus';
  if (process.argv[3] && !fs.existsSync(core)) throw new Error(`no Agent Plus .vsix at ${core}`);
  const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'cce-vscode-'));
  const exts = path.join(work, 'extensions');
  const user = path.join(work, 'user');
  const folder = path.join(work, 'workspace');
  fs.mkdirSync(exts, { recursive: true });
  fs.mkdirSync(folder, { recursive: true });
  settingsFor(user);

  const exe = await downloadAndUnzipVSCode('stable');
  const profile = [`--extensions-dir=${exts}`, `--user-data-dir=${user}`];
  for (const ext of ['anthropic.claude-code', core, vsix]) {
    const r = await runVSCodeCommand(['--install-extension', ext, ...profile], { version: 'stable' });
    console.log(r.stdout.trim());
  }
  const listed = await runVSCodeCommand(['--list-extensions', '--show-versions', ...profile], { version: 'stable' });
  console.log('installed:\n' + listed.stdout.trim());

  let failed = false;
  try {
    await runTests({
      vscodeExecutablePath: exe,
      extensionDevelopmentPath: path.join(__dirname, 'suite'),
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      launchArgs: [folder, ...profile],
    });
  } catch (e) {
    failed = true;
    console.log('the suite in VS Code failed: ' + e.message);
  }
  printLog(user);

  // Only a development machine has every build the version record lists.
  const check = cp.spawnSync(process.execPath, [path.join(ROOT, 'test', 'check.js'), '--without-version-record'], {
    env: Object.assign({}, process.env, { VSCODE_EXTENSIONS: exts }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(check.stdout || '');
  process.stderr.write(check.stderr || '');
  if (check.status !== 0) failed = true;
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
