// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Uninstall hook (package.json "vscode:uninstall"). VS Code runs this with plain Node when it deletes the extension's
 * folder, which in remote development is when the remote server next starts - possibly hours after the uninstall. The
 * extension's own deactivate therefore restores Claude Code as soon as the editor restarts its extensions, and starts
 * this script in a process of its own for the rest (src/removal.js). So this usually runs twice, and every step in it is
 * safe to repeat: a restore finds nothing left to restore, and unregistering a plugin that is gone changes nothing.
 *
 * Without it, uninstalling this extension would leave every patched Claude Code file behind — still carrying our
 * marker, still running our script, with nothing left installed that knows how to undo it. So this restores the installs
 * in this editor's extensions folder, and in any other editor's folder on this machine that has no copy of this extension
 * left to undo them (src/removal.js, uninstallPlan).
 *
 * The adapter list comes from src/adapters.js, the same list the entry point uses, so a target cannot be wired into
 * one and forgotten here.
 *
 * It also unregisters the companion Claude Code plugin, because one thing was installed and one thing has to be enough
 * to uninstall. Not while another editor on this machine still runs a copy, which goes on using the plugin and its plans.
 * Unregistering deletes the plugin's data directory, and the work plans live in it, so they are copied to
 * ~/.claude/agent-work-plan-plans-<timestamp>/ first, with a note in there saying what they are. They are somebody's own
 * writing; uninstalling an editor extension is not a request to delete it.
 *
 * The staged copy of the plugin in this extension's global storage is left where it is: that is the editor's own space
 * to reclaim, and nothing reads it once the marketplace entry is gone.
 */
const path = require('path');
const pluginInstall = require('./src/plugin-install');
const removal = require('./src/removal');

const manifest = (() => { try { return require('./package.json'); } catch (_) { return {}; } })();
const id = manifest.publisher && manifest.name ? `${manifest.publisher}.${manifest.name}` : '';
const plan = removal.uninstallPlan(path.dirname(__dirname), id);

// Leave anything that could not be restored; Claude Code's next update replaces the files anyway.
const found = Array.from(new Set(removal.restoreAll(plan.restore).map((r) => r.dir)));

/* No binary means Claude Code is already gone, and with it anything that would load the plugin or delete its data. Then
   there is nothing to unregister and nothing at risk, so the plans are left exactly where they are. */
const claudeBin = plan.lastCopy ? pluginInstall.findClaude(found) : '';
if (claudeBin) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  pluginInstall.removeSync(claudeBin, stamp);
}
