// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The environment of the VS Code that run.js starts, which every process it starts inherits.
 *
 * Dropped: the variables a VS Code that runs this script sets (ELECTRON_RUN_AS_NODE would start VS Code as plain Node,
 * and VSCODE_IPC_HOOK_CLI would send an install to that other VS Code), LD_LIBRARY_PATH (VS Code brings its own
 * libraries), and those that steer Claude Code's CLI: run from inside a Claude Code session, as on a developer's machine,
 * they would send the window's turns to that session's provider and messaging socket. run.js's own CLAUDE_CODE_PLUS_UI_*
 * are kept. HOME and the folders derived from it go in the temporary root, and so does XDG_RUNTIME_DIR, where the CLI
 * makes its sockets.
 */
const path = require('path');

const DROPPED = /^(VSCODE_|ELECTRON_|CLAUDE|ANTHROPIC_|AWS_|OTEL_|XDG_)/;

function cleanEnv(root, extra = {}, { env: from = process.env, platform = process.platform } = {}) {
  const env = { ...from };
  for (const k of Object.keys(env)) {
    if ((DROPPED.test(k) && !k.startsWith('CLAUDE_CODE_PLUS_UI_')) || k === 'LD_LIBRARY_PATH') delete env[k];
  }
  const home = path.join(root, 'home');
  Object.assign(env, { HOME: home }, extra);
  if (platform === 'win32') Object.assign(env, { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
  if (platform === 'linux') {
    Object.assign(env, { XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_RUNTIME_DIR: path.join(root, 'run') });
  }
  return env;
}

module.exports = { cleanEnv };
