// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/host/installed-copies.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * Finds the installed copies of an extension on this machine by reading the extensions folders directly, since the
 * uninstall hook runs in plain Node with no VS Code API to ask.
 *
 * An editor marks the folder it is about to delete in its extensions folder's .obsolete file, before the extension host
 * restarts; an uninstall and an update both do. So a marked folder is an uninstall only when no other copy of the
 * extension stays unmarked beside it, and a reload or a closing window marks nothing. `ids` is the extension's id or a
 * list of its current and former ids, since a copy under a former id patches the same agent.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDITORS = ['.vscode', '.vscode-server', '.vscode-insiders', '.vscode-server-insiders', '.cursor'];

/** The extensions folder of every editor this looks in, the given one first, each resolved. */
function roots(extensionsDir, home = os.homedir()) {
  return [...new Set([extensionsDir, process.env.VSCODE_EXTENSIONS, ...EDITORS.map((d) => path.join(home, d, 'extensions'))]
    .filter(Boolean).map((d) => path.resolve(d)))];
}

/** The folders an editor has marked for deletion, as it records them: folder name -> true. */
function obsolete(extensionsDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(extensionsDir, '.obsolete'), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) { return {}; }
}

/* A copy's folder is <id>-<version>, with the platform after the version for a platform build; the digit after the
   dash keeps an extension whose name merely starts with this one's from being taken for a copy of it. */
const folderOf = (id) => new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d`, 'i');
/* The editor renames a folder it is deleting to <folder>.<random>.vsctmp first, and one it failed to delete stays until
   its next start under that name, which still starts like a copy. */
const isCopy = (name, own) => own.some((re) => re.test(name)) && !/\.vsctmp$/i.test(name);
const listOf = (ids) => (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(folderOf);

/** The copies of the extension in one extensions folder that its editor has not marked for deletion. */
function liveCopies(extensionsDir, ids, marked = obsolete(extensionsDir)) {
  const own = listOf(ids);
  if (!own.length) return [];
  let names;
  try { names = fs.readdirSync(extensionsDir); } catch (_) { return []; }
  return names.filter((n) => isCopy(n, own) && marked[n] !== true).map((n) => path.join(extensionsDir, n));
}

/** Whether the editor is taking the copy at `extensionPath` away with no other copy staying in its folder. */
function beingUninstalled(extensionPath, ids, marked) {
  if (!extensionPath) return false;
  const dir = path.dirname(path.resolve(extensionPath));
  const mine = path.basename(extensionPath);
  const m = marked || obsolete(dir);
  if (m[mine] !== true) return false;
  return !liveCopies(dir, ids, m).some((d) => path.basename(d) !== mine);
}

/*
 * Which extensions folders the uninstall hook of the copy in `extensionsDir` restores, and whether that copy is the
 * last one. A folder that still holds a copy keeps its patch, since that copy applies it again at its next start.
 * `alsoOwned(dir)` marks a folder to keep for any other reason.
 */
function plan(extensionsDir, ids, { home = os.homedir(), alsoOwned = () => false } = {}) {
  const own = path.resolve(extensionsDir);
  const all = roots(own, home);
  const owned = all.filter((d) => (d !== own && liveCopies(d, ids).length) || alsoOwned(d));
  /* The copy's own folder counts for lastCopy too: after an update the new copy stays there, unmarked. */
  const lastCopy = !owned.length && !liveCopies(own, ids).length;
  return { restore: all.filter((d) => !owned.includes(d)), lastCopy, owned };
}

/** The install stamp VS Code wrote into the manifest of the copy at extensionPath, or 0 when there is none. */
function installStamp(extensionPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8')).__metadata;
    return (meta && meta.installedTimestamp) || 0;
  } catch (_) { return 0; }
}

/*
 * Whether the same version was installed again over this copy after it was loaded. A version number cannot tell two
 * builds of one version apart, but VS Code stamps every install into the manifest (__metadata.installedTimestamp).
 * False when either stamp is missing.
 */
function replacedSince(extensionPath, loadedStamp) {
  if (!extensionPath || !loadedStamp) return false;
  const now = installStamp(extensionPath);
  return !!now && now !== loadedStamp;
}

/*
 * 'uninstalling', 'replaced', or '' for neither. Replaced covers replacedSince and another version installed beside
 * this one, which marks this folder for deletion and leaves the new one unmarked. A replaced window leaves every shared
 * file to the windows running the installed build.
 */
function standing(extensionPath, ids, loadedStamp = 0, marked) {
  if (!extensionPath) return '';
  const own = path.resolve(extensionPath);
  const m = marked || obsolete(path.dirname(own));
  if (m[path.basename(own)] === true) return beingUninstalled(own, ids, m) ? 'uninstalling' : 'replaced';
  return replacedSince(own, loadedStamp) ? 'replaced' : '';
}

/* The installs in one extensions folder whose folder names start with `prefix`, less those its editor has marked for
   deletion. */
function unmarkedInstalls(extensionsDir, prefix) {
  const marked = obsolete(extensionsDir);
  let names;
  try { names = fs.readdirSync(extensionsDir); } catch (_) { return []; }
  return names.filter((n) => n.toLowerCase().startsWith(prefix) && marked[n] !== true).map((n) => path.join(extensionsDir, n));
}

/*
 * Starts the uninstall hook in a process of its own, which outlives this extension host and its five-second wait for
 * deactivate: VS Code runs the hook only when it deletes the folder, which in remote development is the next start of
 * the remote server. Every step of the hook has to be safe to run twice.
 */
function detachHook(extensionPath, spawn = require('child_process').spawn) {
  const child = spawn(process.execPath, [path.join(extensionPath, 'uninstall.js')], {
    detached: true, stdio: 'ignore', windowsHide: true,
    // On a desktop install the host's binary is Electron, which runs a script as plain Node only when told to.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (child && typeof child.unref === 'function') child.unref();
  return child;
}

module.exports = { EDITORS, roots, obsolete, liveCopies, beingUninstalled, plan, installStamp, replacedSince, standing,
  unmarkedInstalls, detachHook };
