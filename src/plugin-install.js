// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Registering the companion Claude Code plugin, once.
 *
 * The plugin is carried inside this extension rather than fetched, so that installing one thing is enough. What is left
 * to do is tell Claude Code about it, which is two commands against the `claude` binary - and that binary ships inside
 * the Claude Code extension, the same directory this extension already has to find in order to patch it.
 *
 * A directory marketplace loads a plugin IN PLACE rather than copying it ("it loads in place from <path>, so edits
 * there take effect at the next session start"). So the path registered has to outlive an upgrade of this extension,
 * and this extension's own install directory does not: it carries a version number and is replaced every upgrade. The
 * plugin is therefore copied into global storage, which the editor keeps across versions, and that copy is registered.
 *
 * Registration happens silently and exactly once. Silently because there is nothing for a reader to decide - the thing
 * being installed is the other half of what they just installed, and it reaches nothing but this machine. Exactly once
 * because re-asserting it on every start is how an installer overwrites what somebody changed by hand: a person who
 * uninstalls the plugin on purpose must not find it back the next morning.
 *
 * The staged copy is refreshed when this extension's version changes, which is a different thing from re-asserting the
 * registration: the registered path does not move, and refreshing the files under it is the only way the plugin half
 * stays on the same version as the half that reads what it writes. It leaves the registration alone, so a deliberate
 * uninstall still stands.
 *
 * Failure is recorded rather than swallowed. An install that runs by itself can fail by itself, and a feature that is
 * quietly missing reads as a broken feature - so the view shows what failed and offers to try again.
 */
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MARKETPLACE = 'claude-code-extras';
const PLUGIN = 'agent-work-plan';
/** How the plugin is named once it is installed: <plugin>@<marketplace>. */
const REF = PLUGIN + '@' + MARKETPLACE;
/** The directory the platform gives the plugin for its own data, named from those two. */
const DATA_DIR = PLUGIN + '-' + MARKETPLACE;
/* Claude Code's own directory. Required when called, since src/claude-files.js requires this module for DATA_DIR. */
const configDir = () => require('./claude-files').claudeDir();
const dataPath = () => path.join(configDir(), 'plugins', 'data', DATA_DIR);
/** Where an uninstall copies the plans first, in Claude Code's own directory, followed by a time stamp. */
const RESCUE_PREFIX = PLUGIN + '-plans-';
/** Where Claude Code keeps the command-line binary inside its own extension directory; the Windows build names it
    claude.exe. */
const BINARY = path.join('resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
/* Generous, because this binary is a 241 MB single file: a cold start of it is slow on a machine that has just booted,
   and a timeout here would be reported as a failure that is really only a wait. */
const TIMEOUT_MS = 60000;

/* One of Claude Code's records of installed plugins and known marketplaces, or null when it cannot be read. */
const readRecord = (dir, name) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'plugins', name), 'utf8')); } catch (_) { return null; }
};

/**
 * Whether Claude Code's own records have lost both the plugin and the marketplace it came from - which is exactly what
 * uninstalling this extension leaves, since the uninstall removes the two together.
 *
 * Asked because this extension's memory of having registered the plugin is kept by the editor and survives an uninstall
 * of this extension, so after a reinstall it says "registered" about a plugin that no longer is. Only the plugin gone,
 * with its marketplace still known, is what removing the plugin on purpose leaves, and that is not this. False whenever
 * the records cannot be read: not knowing is no reason to register anything.
 */
function registrationGone(dir = configDir()) {
  const read = (name) => readRecord(dir, name);
  const plugins = read('installed_plugins.json');
  const markets = read('known_marketplaces.json');
  if (!plugins || typeof plugins !== 'object' || !markets || typeof markets !== 'object') return false;
  const listed = plugins.plugins && typeof plugins.plugins === 'object' ? plugins.plugins : {};
  return !Object.prototype.hasOwnProperty.call(listed, REF) && !Object.prototype.hasOwnProperty.call(markets, MARKETPLACE);
}

/* src/python-runtime.js, shared with Codex Plus, finds the Python 3 that runs the hooks; fitHooks fits the staged copy
   to it. */
const { PYTHONS, findPython } = require('./python-runtime');

/* Where SKILL.md says how to start plan-row.py; fitHooks puts the launcher found here in place of python3. */
const SKILL_RUN = 'run with `python3`.';
/* A hook as the plugin ships it: python3, then its script and the data directory, each quoted. */
const HOOK_COMMAND = /^python3 "([^"]+)" "([^"]+)"$/;

/**
 * Fit a staged copy of the plugin to the Python found here, in place.
 *
 * With python3 nothing changes. With another Python each hook is written as an executable and its arguments, which
 * Claude Code starts without a shell, so it runs the same whether its shell is Git Bash or PowerShell; and
 * launcher.json tells the hooks how to start Python in the row command they give Claude. SKILL.md too: the first row
 * comes before any hook has run.
 *
 * With no Python 3 the copy keeps neither hooks nor skill. Hooks that cannot start would put an error in the
 * conversation every turn, and the skill would have Claude run a command that cannot start; the view says what is
 * missing instead.
 */
function fitHooks(dir, python) {
  const plugin = path.join(dir, PLUGIN);
  const hooksFile = path.join(plugin, 'hooks', 'hooks.json');
  if (!python) {
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: {} }, null, 2) + '\n');
    fs.rmSync(path.join(plugin, 'skills'), { recursive: true, force: true });
    return;
  }
  if (python.launcher.length === 1 && python.launcher[0] === 'python3') return;
  const config = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  for (const groups of Object.values(config.hooks || {})) {
    for (const group of groups || []) {
      for (const hook of group.hooks || []) {
        const m = HOOK_COMMAND.exec(hook.command || '');
        if (m) { hook.command = python.executable; hook.args = [m[1], m[2]]; }
      }
    }
  }
  fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(path.join(plugin, 'hooks', 'launcher.json'), JSON.stringify({ row: python.launcher }) + '\n');
  const skillFile = path.join(plugin, 'skills', 'maintain', 'SKILL.md');
  const skill = fs.readFileSync(skillFile, 'utf8');
  /* shlex.quote's rules, as in plan_path.row_command. */
  const quote = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : "'" + w.replace(/'/g, "'\"'\"'") + "'");
  const shown = python.launcher.map(quote).join(' ');
  const amp = quote(python.launcher[0]) !== python.launcher[0] ? ' (in PowerShell, put `&` and a space in front)' : '';
  fs.writeFileSync(skillFile, skill.replace(SKILL_RUN, () => 'run with `' + shown + '`' + amp + '.'));
}

/** The first Claude Code install that carries a runnable binary. */
function findClaude(dirs) {
  for (const dir of dirs || []) {
    const bin = path.join(dir, BINARY);
    try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch (_) { /* try the next install */ }
  }
  return '';
}

/** The last line of what a command said, which is the part written for a person to read. */
function lastLine(stdout, stderr, err) {
  const text = (String(stdout || '') + String(stderr || '')).trim();
  if (text) return text.split('\n').pop().trim();
  return err ? err.message : '';
}

function run(bin, args) {
  return new Promise((resolve) => {
    cp.execFile(bin, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, said: lastLine(stdout, stderr, err) });
    });
  });
}

/*
 * A digest of the plugin tree - every file's path and its bytes.
 *
 * This is what decides whether the staged copy is out of date, in place of this extension's version string. A version
 * changes when a release is cut, not when a file changes, so a plugin file edited between releases was copied once and
 * never again: the registered plugin went on running the older file with nothing anywhere saying so. The patched panel
 * script is keyed on a digest for the same reason.
 *
 * Returns an empty string if the tree cannot be read, which reads as "not what is installed" and so stages it again.
 */
function digest(dir) {
  const h = crypto.createHash('sha256');
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const child = rel ? path.join(rel, name) : name;
      const full = path.join(dir, child);
      if (fs.statSync(full).isDirectory()) walk(child);
      else h.update(child).update('\0').update(fs.readFileSync(full));
    }
  };
  try { walk(''); } catch (_) { return ''; }
  return h.digest('hex').slice(0, 16);
}

/*
 * The staged copy is replaced as a whole, so a file removed in a newer version is not left behind. The registered path
 * is briefly missing during the swap; a session starting then sees no plugin until its next start.
 *
 * The copy is built in a per-process folder because every window stages into the same place. A rename that fails
 * because another window just installed the same plugin is not an error.
 *
 * The old copy is renamed aside, and renamed back if the new one cannot be moved in: on Windows a folder that a virus
 * scanner or the indexer has open cannot be renamed for a moment, and deleting the old copy first would leave none.
 */
function stage(from, to, fit = () => {}) {
  const tag = `${to}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const next = tag + '.new', old = tag + '.old';
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let want = '', aside = false;
  try {
    fs.cpSync(from, next, { recursive: true });
    fit(next);
    want = digest(next);
    try { fs.renameSync(to, old); aside = true; } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
    fs.renameSync(next, to);
  } catch (e) {
    fs.rmSync(next, { recursive: true, force: true });
    if (aside && !fs.existsSync(to)) { try { fs.renameSync(old, to); aside = false; } catch (_) { /* left beside it */ } }
    if (!want || digest(to) !== want) throw e;
  } finally {
    if (aside && fs.existsSync(to)) fs.rmSync(old, { recursive: true, force: true });
  }
}

/**
 * Put the plugin where it will keep working, and register it. Returns what to record and what to show.
 *
 * Both commands are idempotent - a second marketplace add says "already on disk", a second install says "already
 * installed" - and both exit zero, so a retry after a partial failure needs no special case.
 */
async function install({ claudeBin, from, to, refreshOnly, python }) {
  try { stage(from, to, (dir) => fitHooks(dir, python)); }
  catch (e) { return { ok: false, step: 'copying the plugin to ' + to, said: e.message }; }
  if (refreshOnly) return { ok: true, step: '', said: 'refreshed the staged copy' };
  const added = await run(claudeBin, ['plugin', 'marketplace', 'add', to]);
  if (!added.ok) return { ok: false, step: 'claude plugin marketplace add', said: added.said };
  const installed = await run(claudeBin, ['plugin', 'install', REF]);
  if (!installed.ok) return { ok: false, step: 'claude plugin install ' + REF, said: installed.said };
  // So that the place plans go exists and can be looked at, rather than being a path that only appears once something
  // has already written there.
  try { fs.mkdirSync(dataPath(), { recursive: true }); } catch (_) { /* the first write will make it */ }
  return { ok: true, step: '', said: installed.said };
}

const RESCUE_NOTE = `These are the work plans kept by the agent-work-plan plugin for Claude Code: one file per
conversation, named by that conversation's session id, holding what it still had to do.

They were copied here because the Claude Code Plus extension was uninstalled. Unregistering a plugin makes
Claude Code delete the plugin's data directory along with it - "the removal also deletes their saved options, secrets and
data where it can" - and these are not the extension's to delete. Nothing reads this folder; it is yours to keep or
throw away.

To use them again: install the extension, which registers the plugin again, then copy these files and the closed folder back into
~/.claude/plugins/data/${DATA_DIR}/
`;

/**
 * Copy the plans somewhere the platform will not reach, and return where they went.
 *
 * Both ways of unregistering take the plugin's data directory with them: `marketplace remove` says so itself, and
 * `plugin uninstall` does the same without saying it. Verified, not assumed - a file left in that directory is gone
 * after either command. The plans are somebody's own writing, possibly months of it, and uninstalling a VS Code
 * extension is not a request to delete it.
 *
 * A copy rather than a move, so that a failure halfway leaves the original untouched; the platform removes it moments
 * later anyway.
 *
 * Returns { to, failed }: where they went ('' when there was nothing to copy), and whether any may be left uncopied.
 */
function rescuePlans(stamp) {
  const from = dataPath();
  let names;
  try { names = fs.readdirSync(from); } catch (e) { return { to: '', failed: !(e && e.code === 'ENOENT') }; }
  if (!names.length) return { to: '', failed: false };
  const to = path.join(configDir(), RESCUE_PREFIX + stamp);
  try {
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    fs.writeFileSync(path.join(to, 'WHAT-THIS-IS.txt'), RESCUE_NOTE, 'utf8');
  } catch (_) { return { to: '', failed: true }; }
  return { to, failed: false };
}

/**
 * Undo both halves of the registration, synchronously, for the uninstall hook - which runs as a plain Node script that
 * exits when it is done, so there is nothing for an asynchronous version to overlap with.
 *
 * The plans are copied out first, because unregistering deletes them. When the copy fails (a full disk, a permission),
 * nothing is unregistered. Returns where they went, or ''.
 */
function removeSync(claudeBin, stamp) {
  const saved = rescuePlans(stamp);
  if (saved.failed) return '';
  for (const args of [['plugin', 'uninstall', REF], ['plugin', 'marketplace', 'remove', MARKETPLACE]]) {
    try { cp.execFileSync(claudeBin, args, { timeout: TIMEOUT_MS, stdio: 'ignore', windowsHide: true }); }
    catch (_) { /* already gone, or the binary went with the extension it lived in; either way nothing is left to do */ }
  }
  return saved.to;
}

/**
 * Run `claude plugin disable` for the plugin, which stops its skill description being added to every session. `dirs`
 * are the Claude Code installs whose binary runs the command.
 *
 * `disable` rather than `uninstall`: uninstalling takes the plugin's data directory with it, and that is where every
 * conversation's plan lives. Disabling is a line in Claude Code's own settings and is undone by enabling again, so the
 * plans stay where they are and come back with it.
 */
async function disable(dirs) {
  const claudeBin = findClaude(dirs);
  if (!claudeBin) return { ok: false, said: 'the claude binary is not where this extension can see it' };
  const r = await run(claudeBin, ['plugin', 'disable', REF]);
  if (r.ok) return { ok: true, said: 'told Claude Code to stop loading ' + REF };
  /* Already disabled reads as a failure from the CLI and is the outcome asked for, so it is not reported as one. */
  if (/not enabled|already disabled|is disabled/i.test(r.said)) {
    return { ok: true, said: REF + ' was already not being loaded' };
  }
  return { ok: false, said: r.said };
}


/** Whether Claude Code's own records list the plugin as installed. */
function listed(dir = configDir()) {
  const plugins = readRecord(dir, 'installed_plugins.json');
  const all = plugins && typeof plugins === 'object' && plugins.plugins && typeof plugins.plugins === 'object' ? plugins.plugins : {};
  return Object.prototype.hasOwnProperty.call(all, REF);
}

module.exports = {
  install, disable, removeSync, rescuePlans, listed, RESCUE_PREFIX, findClaude, findPython, fitHooks, digest, stage, registrationGone, MARKETPLACE,
  PLUGIN, REF, BINARY, PYTHONS, SKILL_RUN,
  DATA_DIR,
};
