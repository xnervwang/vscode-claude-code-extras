// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Finds, in /proc, the commands a conversation started that are still running after its turn ended. Without /proc it
 * finds nothing, and only the `claude --bg` sessions and the transcript links of src/background.js remain.
 *
 * The Bash tool gives each command CLAUDE_CODE_SESSION_ID and CLAUDE_PID, the conversation and its claude process, and
 * a process keeps the environment it started with in /proc/<pid>/environ. A command started with `setsid`, or with
 * `nohup ... &` from a shell that has since exited, is under no claude process any more but still carries both.
 *
 * Only shells and `timeout` are counted, going by argv[0] rather than the name in stat: `setsid nohup bash -c '...'`,
 * a script, a Bash tool shell whose claude process has gone. Programs that detach themselves, such as Brazil's Java
 * server, the OpenTelemetry server Codex starts, Xvfb, a database server or a `tail -F` nobody stopped, stay running
 * long after the work that started them, and mfns names its namespace holders mfns-holder rather than bash.
 *
 * Nothing below a claude process is counted. That is where its MCP servers and hooks run, the command of the current
 * turn, and the background commands Claude Code already shows as running. A `claude -p` worker is found from its own
 * session record instead.
 */
const fs = require('fs');
const path = require('path');
const { SESSION } = require('./claude-files');

const SESSION_KEY = Buffer.from('CLAUDE_CODE_SESSION_ID=', 'latin1');
const PID_KEY = Buffer.from('CLAUDE_PID=', 'latin1');
const STARTERS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh', 'timeout']);
const MAX_DEPTH = 64;
/* How many /proc files are read at once. */
const BATCH = 128;

async function inBatches(items, fn) {
  for (let i = 0; i < items.length; i += BATCH) await Promise.all(items.slice(i, i + BATCH).map(fn));
}
const read = (file, enc) => fs.promises.readFile(file, enc).catch(() => null);

/* pid -> { comm, state, ppid, start } for every process whose stat can be read; start is in clock ticks since boot. */
async function processes(proc) {
  const out = new Map();
  let names;
  try { names = (await fs.promises.readdir(proc)).filter((n) => /^\d+$/.test(n)); } catch (_) { return out; }
  await inBatches(names, async (n) => {
    const s = await read(path.join(proc, n, 'stat'), 'latin1');
    if (!s) return;
    const open = s.indexOf('('), close = s.lastIndexOf(')');
    if (open < 0 || close < open) return;
    const f = s.slice(close + 2).split(' ');
    out.set(Number(n), { comm: s.slice(open + 1, close), state: f[0], ppid: Number(f[1]), start: f[19] });
  });
  return out;
}

/* The value of `key` in an environment block, or ''. */
function envValue(env, key) {
  if (!env) return '';
  for (let at = env.indexOf(key); at !== -1; at = env.indexOf(key, at + 1)) {
    if (at > 0 && env[at - 1] !== 0) continue;
    const end = env.indexOf(0, at);
    return env.toString('latin1', at + key.length, end === -1 ? env.length : end);
  }
  return '';
}

/* Whether a process is a claude process, named claude or holding a session record (a claude installed through npm runs
   as node), and whether one is among its ancestors or itself. */
function claudeTest(procs, claudePids) {
  const memo = new Map();
  const isClaude = (pid) => claudePids.has(pid) || (procs.get(pid) || {}).comm === 'claude';
  const under = (pid) => {
    const trail = [];
    let found = false;
    for (let p = pid, hops = 0; p > 1 && hops < MAX_DEPTH; hops++) {
      if (memo.has(p)) { found = memo.get(p); break; }
      trail.push(p);
      if (isClaude(p)) { found = true; break; }
      const info = procs.get(p);
      if (!info) break;
      p = info.ppid;
    }
    for (const p of trail) memo.set(p, found);
    return found;
  };
  return { isClaude, under };
}

/*
 * What is running now, given the live session records (src/background.js):
 * - outside: session ids of the conversations with a shell or `timeout` running outside every claude process;
 * - launchers: worker session id -> launching session id, for the live `claude -p` workers whose launcher still runs.
 *   A worker's CLAUDE_PID names the claude process whose Bash tool started it. A pid can be reused, so the process now
 *   holding it counts only if it started before the worker.
 */
async function snapshot({ proc = '/proc', records = [] } = {}) {
  const outside = new Set(), launchers = new Map();
  const procs = await processes(proc);
  if (!procs.size) return { outside, launchers };
  const { isClaude, under } = claudeTest(procs, new Set(records.map((r) => r.pid)));
  const candidates = [...procs].filter(([pid, p]) => p.state !== 'Z' && p.state !== 'X' && !isClaude(pid) && !under(p.ppid));
  await inBatches(candidates, async ([pid]) => {
    const env = await read(path.join(proc, String(pid), 'environ'));
    const id = envValue(env, SESSION_KEY);
    if (!SESSION.test(id)) return;
    const args = await read(path.join(proc, String(pid), 'cmdline'), 'latin1');
    const first = args ? args.split('\0')[0] : '';
    if (STARTERS.has(path.basename(first))) outside.add(id.toLowerCase());
  });
  const byPid = new Map(records.map((r) => [r.pid, r]));
  await inBatches(records, async (r) => {
    if (!/^sdk-/.test(r.entrypoint || '') || r.kind === 'bg' || !SESSION.test(r.sessionId || '')) return;
    const launcher = byPid.get(Number(envValue(await read(path.join(proc, String(r.pid), 'environ')), PID_KEY)));
    if (!launcher || launcher === r || !SESSION.test(launcher.sessionId || '')) return;
    const a = procs.get(launcher.pid), b = procs.get(r.pid);
    if (!a || !b || !(Number(a.start) <= Number(b.start))) return;
    launchers.set(r.sessionId.toLowerCase(), launcher.sessionId.toLowerCase());
  });
  return { outside, launchers };
}

module.exports = { snapshot, processes, STARTERS };
