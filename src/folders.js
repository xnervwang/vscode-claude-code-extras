// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus src/folders.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * Whether a conversation's folder is in this window's workspace, and which rows of a plan wait on the user. Agent Plus
 * filters Conversations with the first, and Claude Code Plus and Codex Plus each ship a copy.
 *
 * Paths are compared after resolving symbolic links, because VS Code can report a workspace folder as /home/<user>/...
 * while an agent records the same folder as /local/home/<user>/..., /home/<user> being a link. Compared as strings,
 * every conversation would fall outside the workspace.
 */
const fs = require('fs');
const path = require('path');

/* How far up the tree to look for an ancestor that exists. Deeper than any real checkout, and bounded so a path that
   never resolves cannot spin. */
const MAX_WALK_UP = 64;

const caseOf = process.platform === 'win32' || process.platform === 'darwin' ? (s) => s.toLowerCase() : (s) => s;

/** `p` with every symbolic link resolved; the nearest existing ancestor's real path with the rest put back, if it is gone. */
function realPath(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch (_) { /* gone, or not readable */ }
  let head = abs;
  const tail = [];
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
    try { return path.join(fs.realpathSync.native(head), ...tail); } catch (_) { /* keep going up */ }
  }
  return abs;
}

/*
 * A test for "is this directory one of `folders` or under one". With a `memo`, each path is resolved once: the test is
 * asked about the folder of every conversation on every pass, and resolving one is a system call per level of it. How
 * long a resolved answer stays good for is up to whoever passes the memo in.
 */
function folderTest(folders, memo) {
  const resolve = memo
    ? (p) => { if (!memo.has(p)) memo.set(p, caseOf(realPath(p))); return memo.get(p); }
    : (p) => caseOf(realPath(p));
  const roots = (folders || []).filter(Boolean).map(resolve);
  return (dir) => {
    if (!dir || !roots.length) return false;
    const cwd = resolve(dir);
    return roots.some((root) => {
      const rel = path.relative(root, cwd);
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
    });
  };
}

/** The rows of a plan that wait on the user, each with the number shown in front of it. */
function planQuestions(nodes, prefix = '', out = []) {
  (nodes || []).forEach((n, i) => {
    const num = (prefix ? prefix + '.' : '') + (i + 1);
    if (n.waitingOn === 'user' && (n.state === 'waiting' || n.state === 'discussing')) {
      out.push({ num, title: n.title, question: n.question || n.title, since: n.asked || n.since || 0, state: n.state,
        note: n.note || '', detail: n.detail || '' });
    }
    planQuestions(n.children, num, out);
  });
  return out;
}

module.exports = { folderTest, realPath, planQuestions, MAX_WALK_UP };
