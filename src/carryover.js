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
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

/**
 * Copy each file of `names` from the old extension's storage into `storage`, unless `storage` has a file of that name.
 *
 * Copied, not moved: the old extension can still be installed and reading its own. The copy is written under a temporary
 * name and linked into place, so another window never reads half a file, and one that wrote its own meanwhile keeps it.
 *
 * Returns { copied, failed }, file names.
 */
function copyFiles(storage, names) {
  const from = legacyStorage(storage);
  const out = { copied: [], failed: [] };
  for (const name of names) {
    const to = path.join(storage, name);
    if (fs.existsSync(to) || !fs.existsSync(path.join(from, name))) continue;
    const tmp = `${to}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(storage, { recursive: true });
      fs.copyFileSync(path.join(from, name), tmp);
      try { fs.linkSync(tmp, to); out.copied.push(name); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    } catch (_) {
      out.failed.push(name);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    }
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
  LEGACY_ID, PLUS_ID, EXPORT_FILE, EXPORTED_KEYS, handsOver, earlierBuild, legacyStorage, copyFiles, importState, waitFor,
};
