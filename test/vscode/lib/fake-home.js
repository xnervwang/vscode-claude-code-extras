// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The ~/.claude the window runs against: a transcript for each entry of THREADS under
 * projects/<the opened folder, as Claude Code names it>/<session>.jsonl, written as Claude Code's VS Code panel writes
 * one, with the folder the window opens as each record's cwd, since the session list shows only conversations started
 * in the workspace. The entry point is claude-vscode: a transcript whose first record says sdk-cli, as one written by
 * `claude -p` does, is a background session, and this extension takes those out of the list.
 *
 * Claude Code has no account here. run.js turns its login prompt off and points its CLI at fake-model.js with KEY, a
 * fake key. Started from the panel, the CLI uses an ANTHROPIC_API_KEY only once its last 20
 * characters are among the approved ones in ~/.claude.json, as they are after someone accepts the key when asked; without
 * that every turn ends in "Not logged in". So that file is written here too, with the key approved.
 */
const fs = require('fs');
const path = require('path');

const KEY = 'sk-ant-made-up-for-the-ui-tests-0000';
const VERSION = '2.1.322';
const MODEL = 'claude-sonnet-5-5';
const THREADS = [
  { id: '7d1f3c2a-4b5e-4f60-8a71-92b3c4d5e6f1', title: 'Find where the retry delay for the inventory sync is set', days: 0,
    turns: [
      ['Where is the retry delay for the inventory sync set?', 'It is read from `sync.retryDelayMs` in config/sync.yml, 5000 by default.'],
      ['Is it the same in the staging config?', 'No: config/staging/sync.yml sets it to 1000, so staging retries five times as often.'],
      ['Which code reads it?', 'src/sync/scheduler.js reads it once at start-up, in `loadSchedule()`.'],
      ['Can it be changed without a restart?', 'Not today. The scheduler copies the value when it starts and never reads it again.'],
    ] },
  { id: '7d1f3c2a-4b5e-4f60-8a71-92b3c4d5e6f2', title: 'Why does the nightly export skip archived rows?', days: 1,
    turns: [
      ['Why does the nightly export skip archived rows?', 'The query in export/nightly.sql filters on `archived = false`.'],
      ['Was that always so?', 'The filter came with the archive feature; before it there was no archived column.'],
    ] },
  { id: '7d1f3c2a-4b5e-4f60-8a71-92b3c4d5e6f3', title: 'Add a dry-run flag to the cleanup script', days: 2,
    turns: [
      ['Add a dry-run flag to the cleanup script.', 'Added `--dry-run` to scripts/cleanup.sh: it prints each path it would remove.'],
    ] },
];

/* Claude Code's folder name for a working directory (folderName in src/bgsessions.js). */
const folderName = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

const uuid = (thread, n) => `${thread.id.slice(0, 24)}${String(n).padStart(12, '0')}`;

function transcript(thread, cwd, now) {
  const lines = [];
  const base = { isSidechain: false, userType: 'external', entrypoint: 'claude-vscode', cwd, sessionId: thread.id, version: VERSION, gitBranch: 'main' };
  let parent = null, n = 0;
  /* Each conversation ran on its own day, a turn every few minutes, each reply 40 s after its question. Today's ends a
     minute ago and starts no earlier than midnight, closer together just after midnight: a time from another day is
     drawn with its date, which would change the width of every crop that shows it. */
  let gap = 6 * 60000;
  let start = now - thread.days * 86400000 - (thread.turns.length * 6 + 30) * 60000;
  if (thread.days === 0) {
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    if (start < midnight + 1000) {
      gap = Math.max(1000, Math.floor((now - 60000 - midnight) / (thread.turns.length + 1)));
      start = midnight + 1000;
    }
  }
  thread.turns.forEach(([ask, answer], i) => {
    const at = start + i * gap;
    const u = uuid(thread, ++n), a = uuid(thread, ++n);
    lines.push({ parentUuid: parent, ...base, type: 'user', message: { role: 'user', content: ask }, uuid: u,
      timestamp: new Date(at).toISOString(), permissionMode: 'default', promptSource: 'user' });
    lines.push({ parentUuid: u, ...base, type: 'assistant', uuid: a, timestamp: new Date(at + Math.min(40000, gap / 2)).toISOString(), requestId: `req_fake_${n}`,
      message: { id: `msg_fake_${thread.id.slice(-4)}_${n}`, type: 'message', role: 'assistant', model: MODEL,
        content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1200 + i * 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 18000 + i * 2000, output_tokens: 120, service_tier: 'standard' } } });
    parent = a;
  });
  lines.push({ type: 'ai-title', aiTitle: thread.title, sessionId: thread.id });
  lines.push({ type: 'last-prompt', lastPrompt: thread.turns[thread.turns.length - 1][0], leafUuid: parent, sessionId: thread.id });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/* `folder` as given, and on Windows also with either case of drive letter and with forward slashes. */
function trustKeys(folder) {
  const keys = new Set([folder]);
  if (/^[a-z]:/i.test(folder)) {
    for (const f of [folder, folder.replace(/\\/g, '/')]) {
      keys.add(f);
      keys.add(f[0].toLowerCase() + f.slice(1));
      keys.add(f[0].toUpperCase() + f.slice(1));
    }
  }
  return [...keys];
}

/* Writes ~/.claude.json and the transcripts under `home`/.claude for conversations started in `folder`. */
function write(home, { folder, now = Date.now() }) {
  // The folder is trusted already, as after someone answered Claude Code's question about it (asked from 2.1.323 on).
  // On Windows the folder is written several ways, since which form Claude Code keys it by is not documented.
  const projects = {};
  for (const key of trustKeys(folder)) projects[key] = { hasTrustDialogAccepted: true };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [KEY.trim().slice(-20)], rejected: [] }, projects }, null, 2));
  const dir = path.join(home, '.claude', 'projects', folderName(folder));
  fs.mkdirSync(dir, { recursive: true });
  const files = THREADS.map((t) => {
    const file = path.join(dir, `${t.id}.jsonl`);
    fs.writeFileSync(file, transcript(t, folder, now));
    const at = new Date(now - t.days * 86400000);
    fs.utimesSync(file, at, at);
    return file;
  });
  return { dir, files, threads: THREADS };
}

module.exports = { trustKeys, write, folderName, THREADS, MODEL, KEY };
