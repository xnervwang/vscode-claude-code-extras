// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/host/python-offer.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * Handles a machine with no Python for the work plan hooks: the notice above the plan, a one-time offer to download
 * python.org's build (src/python-runtime.js), and the download, which a window runs once at a time.
 *
 * The offer is made once per Python version on the machine, whichever extension and window gets there first: each
 * claims a file in the shared folder, created exclusively, and only the one that creates it asks. After "Not now" the
 * row is the way to get it.
 */
const fs = require('fs');
const path = require('path');
const runtime = require('./python-runtime');
const { sharedHome, privateDir } = require('./files');

/**
 * The row above the plan. `tried` is the list python-runtime.pythons() gave; `download` and `install` are the
 * extension's commands; `without` is the sentence saying what the plugin lacks until a Python is found.
 */
function notice(tried, { download, install, without }) {
  const canDownload = !!runtime.build();
  return {
    title: 'Work plans need Python 3',
    description: canDownload ? 'click to download it' : 'click to try again',
    detail: `Finding Python 3 failed. No Python 3.7 or later was found (tried ${tried.map((l) => l.join(' ')).join(', ')}). `
      + (canDownload ? 'Click to download it, or install Python and reload the window. '
        : 'Install it from python.org, then click this to install the plugin again. ') + without,
    command: canDownload ? download : install,
    arguments: [],
  };
}

/** Whether this window is the first on the machine to offer this version, claimed by creating a file exclusively. */
function claim(version = runtime.VERSION, home = sharedHome()) {
  const dir = path.join(home, 'asked');
  try { privateDir(dir); } catch (_) { return true; }
  try {
    fs.closeSync(fs.openSync(path.join(dir, `python-${encodeURIComponent(version)}`), 'wx', 0o600));
    return true;
  } catch (e) {
    return !e || e.code !== 'EEXIST';
  }
}

/** `fn` wrapped so that a call made while an earlier one runs gets the earlier one's promise. */
function single(fn) {
  let running = null;
  return (...args) => running || (running = Promise.resolve().then(() => fn(...args)).finally(() => { running = null; }));
}

/*
 * Offers the download once per version where python.org has a build for this machine. `ask` shows the question and
 * resolves to the button picked; `get` is the download (wrapped in single). Resolves to whether it was fetched.
 */
async function offer({ ask, get, home }) {
  if (!runtime.build() || !claim(runtime.VERSION, home)) return false;
  const pick = await ask('Work plans need Python 3. Download it from python.org (11 MB)?', 'Download', 'Not now');
  return pick === 'Download' ? !!(await get()) : false;
}

module.exports = { notice, claim, single, offer };
