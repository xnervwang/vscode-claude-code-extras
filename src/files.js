// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus src/files.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * Writing files other processes and other windows read at any moment: always whole, through a temporary file renamed
 * into place, so a reader never sees half of one. Agent Plus uses this file itself, and Claude Code Plus and Codex
 * Plus each ship a copy.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * The temporary name carries this process and a random part: several windows write the same files, and with one shared
 * name a second writer would replace the first one's temporary file, whose rename would then fail. `tag` goes into that
 * name; `tries` above 1 starts a failed write over from scratch.
 */
function writeAtomic(file, text, mode, { tag = '', tries = 1 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const tmp = `${file}${tag}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* never written, or already moved */ }
      if (attempt >= tries) throw e;
    }
  }
}

/*
 * Puts a patched file's original back by moving its backup over it in one step, so no window can find a clean file
 * beside its backup: one patching in that moment would write a fresh backup for a separate delete to take, and leave a
 * patched file with nothing to restore it from. Of two restores at once, the one whose move finds no backup has nothing
 * left to do.
 */
function moveBack(backup, file) {
  try { fs.renameSync(backup, file); } catch (e) {
    if (e && e.code === 'ENOENT') return { changed: false, message: 'nothing to restore' };
    throw e;
  }
  return { changed: true, message: 'restored' };
}

/*
 * The folder every window of every VS Code product on this machine shares: answers in flight and the lock on VS Code's
 * request limit. It belongs to no editor, so VS Code Stable and Insiders, and the window of each, find the same one.
 * AGENT_WORK_PLAN_HOME moves it, for tests.
 */
function sharedHome() {
  return process.env.AGENT_WORK_PLAN_HOME || path.join(os.homedir(), '.agent-work-plan');
}

/* Creates `dir` and its parents readable by this user alone, and tightens one that exists with wider permissions. An
   answer is whatever the person typed, which can be anything. */
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return dir;
  const home = sharedHome();
  for (const d of [home, dir]) {
    if (d !== dir && !dir.startsWith(d + path.sep)) continue;
    try {
      const st = fs.statSync(d);
      if ((st.mode & 0o077) !== 0 && st.uid === process.getuid()) fs.chmodSync(d, 0o700);
    } catch (_) { /* checked again next time */ }
  }
  return dir;
}

module.exports = { writeAtomic, moveBack, sharedHome, privateDir };
