// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What this extension takes over from xnervwang.claude-code-extras, the id it was published under before it became
 * Claude Code Plus.
 *
 * The editor keys an extension's storage by its id, so nothing kept under the old id is visible to this one. The global
 * storage folders sit side by side, named after the ids, which is how the old one is found. Only what the reader chose
 * is carried over - the pins and the colors of the session list. The rest of that folder is rebuilt here on its own or
 * asked for again: the panel-opening records, the tab icons, the staged plugin and a downloaded Python.
 *
 * Uninstalling the old extension also unregisters the plugin, which empties the plan directory; its uninstall hook copies
 * the plans aside first, and they are copied back from there (restoreRescued).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SESSION } = require('./claude-files');
const { RESCUE_PREFIX } = require('./plugin-install');

const LEGACY_ID = 'xnervwang.claude-code-extras';
const PLUS_ID = 'xnervwang.claude-code-plus';

/** Whether a manifest of the old id is its last version, shim/ in this repository: it depends on this extension and
    patches nothing. */
function handsOver(pkg) {
  const deps = pkg && pkg.extensionDependencies;
  return Array.isArray(deps) && deps.some((d) => typeof d === 'string' && d.toLowerCase() === PLUS_ID);
}

/** The version of the old extension when the editor runs it as itself, from its description; '' when it is not here
    or is the last version. */
function earlierBuild(ext) {
  if (!ext) return '';
  const pkg = ext.packageJSON || {};
  return handsOver(pkg) ? '' : String(pkg.version || '?');
}

/* What the old id's last version exports from its state (shim/extension.js), named as they are stored there and here. */
const EXPORT_FILE = 'export.json';
const EXPORTED_KEYS = ['claudeCodeExtras.removed', 'claudeCodeExtras.projectDirDays'];

/** The old extension's global storage folder, beside `storage`, this extension's. */
const legacyStorage = (storage) => path.join(path.dirname(storage), LEGACY_ID);

/*
 * Copy one file to `to` unless a file is there: 'copied', 'there' or 'failed'. The copy is written under a temporary name
 * and linked into place, so another window never reads half a file, and one that wrote its own meanwhile keeps it. It
 * keeps the original's modification time, which for a plan is how recent its conversation is taken to be.
 */
function copyNew(from, to) {
  if (fs.existsSync(to)) return 'there';
  const tmp = `${to}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, tmp);
    const st = fs.statSync(from);
    fs.utimesSync(tmp, st.atime, st.mtime);
    try { fs.linkSync(tmp, to); return 'copied'; } catch (e) { if (e.code === 'EEXIST') return 'there'; throw e; }
  } catch (_) {
    return 'failed';
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
  }
}

/**
 * Copy each file of `names` from the old extension's storage into `storage`, unless `storage` has a file of that name.
 * Copied, not moved: the old extension can still be installed and reading its own.
 *
 * Returns { copied, failed }, file names.
 */
function copyFiles(storage, names) {
  const from = legacyStorage(storage);
  const out = { copied: [], failed: [] };
  for (const name of names) {
    if (!fs.existsSync(path.join(from, name))) continue;
    const r = copyNew(path.join(from, name), path.join(storage, name));
    if (r === 'copied') out.copied.push(name);
    else if (r === 'failed') out.failed.push(name);
  }
  return out;
}

/* Left in a rescue folder once its plans have been copied back, so it is not read again. */
const COPIED_BACK = 'COPIED-BACK.txt';
/*
 * How long a rescue folder has to have been left alone before it is read. The uninstall that writes it unregisters the
 * plugin straight after, running Claude Code's binary twice with a minute's timeout each, and Claude Code deletes the
 * plan directory then, with anything copied back into it in the meantime.
 */
const RESCUE_SETTLE_MS = 3 * 60000;

const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; } };

/**
 * Copy the plans in every rescue folder (~/.claude/<RESCUE_PREFIX><stamp>/, src/plugin-install.js) back into `planDir`:
 * only <session id>.json files, never over a plan already there, newest folder first, so that of two copies of one plan
 * the later wins. A folder whose plans were all dealt with gets COPIED_BACK; one written within RESCUE_SETTLE_MS is left
 * for later, and waitMs says how long until the first of those can be read.
 *
 * Returns { copied, dirs, waitMs }: plan file names copied, folders finished.
 */
function restoreRescued({ home = os.homedir(), planDir, now = Date.now(), settleMs = RESCUE_SETTLE_MS } = {}) {
  const out = { copied: [], dirs: 0, waitMs: 0 };
  const root = path.join(home, '.claude');
  let names;
  try { names = fs.readdirSync(root); } catch (_) { return out; }
  for (const name of names.filter((n) => n.startsWith(RESCUE_PREFIX)).sort().reverse()) {
    const dir = path.join(root, name);
    let entries;
    try { if (!fs.statSync(dir).isDirectory()) continue; entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    if (entries.some((e) => e.name === COPIED_BACK)) continue;
    const age = now - Math.max(mtimeOf(dir), ...entries.map((e) => mtimeOf(path.join(dir, e.name))));
    if (age < settleMs) {
      out.waitMs = out.waitMs ? Math.min(out.waitMs, settleMs - age) : settleMs - age;
      continue;
    }
    const plans = entries.filter((e) => e.isFile() && e.name.endsWith('.json') && SESSION.test(e.name.slice(0, -5))).map((e) => e.name);
    const copied = [];
    let there = 0, failed = false;
    for (const p of plans) {
      const r = copyNew(path.join(dir, p), path.join(planDir, p));
      if (r === 'copied') copied.push(p);
      else if (r === 'there') there++;
      else failed = true;
    }
    out.copied.push(...copied);
    if (failed) continue;
    try {
      fs.writeFileSync(path.join(dir, COPIED_BACK), `Claude Code Plus copied ${copied.length} of the ${plans.length} plans in this folder back into `
        + `${planDir} on ${new Date(now).toISOString()}; ${there} were there already. This folder is not read again.\n`);
      out.dirs++;
    } catch (_) { /* read again next time, which copies nothing twice */ }
  }
  return out;
}

/**
 * Take the entries of the old id's export.json into `state` (a Memento) where it has no value of its own: this
 * extension's own value is newer than anything the old one kept. Returns the keys taken.
 */
async function importState(state, storage) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(legacyStorage(storage), EXPORT_FILE), 'utf8')); } catch (_) { return []; }
  const taken = [];
  for (const k of EXPORTED_KEYS) {
    if (!data || typeof data !== 'object' || data[k] === undefined || state.get(k) !== undefined) continue;
    await state.update(k, data[k]);
    taken.push(k);
  }
  return taken;
}

/** Resolves true once `file` exists, or false after `ms`. */
function waitFor(file, ms, every = 200) {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const look = () => {
      if (fs.existsSync(file)) resolve(true);
      else if (Date.now() >= end) resolve(false);
      else setTimeout(look, every);
    };
    look();
  });
}

module.exports = {
  LEGACY_ID, PLUS_ID, EXPORT_FILE, EXPORTED_KEYS, COPIED_BACK, RESCUE_SETTLE_MS, handsOver, earlierBuild, legacyStorage, copyFiles,
  restoreRescued, importState, waitFor,
};
