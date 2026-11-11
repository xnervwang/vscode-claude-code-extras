// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Claude Code Plus - user interface additions for the Claude Code panel in VS Code.
 *
 * This extension owns no user interface of its own. It patches the Claude Code extension's own files at rest, one
 * adapter per target file (see src/adapters.js), and every write is guarded the same way: match the expected code
 * shape exactly once or write nothing, keep the untouched original beside the file, replace atomically, and put the
 * original back on Remove or uninstall. A Claude Code build whose shape does not match is reported and left alone.
 *
 * Because the patch lives in files the editor has already loaded, installing or upgrading it asks for one reload.
 * After that, turning the marks off and changing the message color take effect live, through the stylesheet written
 * next to the panel (see src/live.js).
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const webview = require('./src/webview');
const host = require('./src/host');
const { safeColor } = webview;
const { readTasks, rememberDirs } = require('./src/tasks');
const background = require('./src/background');
const efforts = require('./src/efforts');
const { sweepOrphans, planDir, readPlan } = require('./src/workplan');
const { transcriptOf } = require('./src/claude-files');
const planInjections = require('./src/plan-injections');
const waiting = require('./src/waiting');
const { createClaudeSource } = require('./src/claude-source');
const coreLink = require('./src/core-link');
const hookSettings = require('./src/hook-settings');
const pluginInstall = require('./src/plugin-install');
const pythonRuntime = require('./src/python-runtime');
const pythonOffer = require('./src/python-offer');
const latency = require('./src/openlatency');
const tabdot = require('./src/tabdot');
const sessionPins = require('./src/sessionpins');
const sessionColors = require('./src/sessioncolors');
const bgSessions = require('./src/bgsessions');
const droppedTabs = require('./src/droppedtabs');
const deleteSession = require('./src/deletesession');
const recentClosed = require('./src/recentclosed');
const ADAPTERS = require('./src/adapters');
const removal = require('./src/removal');
const carryover = require('./src/carryover');
const PACKAGE = require('./package.json');

/* <publisher>.<name>, which is also how the editor names this extension's folders. Read from the manifest rather than
   from the editor's API because deactivate needs it, and by then that API is gone. */
const ID = PACKAGE.publisher + '.' + PACKAGE.name;
/* Where this copy is installed, kept for deactivate for the same reason. */
let selfPath = '';

/* Settings and commands are named under this prefix. The keys this extension keeps in its own state are not settings,
   are not seen by anyone, and keep the names they were first stored under. */
const PREFIX = 'claudeCodePlus.';
/* Earlier prefixes of settings and commands, newest first. */
const LEGACY_PREFIXES = ['claudeCodeWorkPlan.', 'claudeCodeExtras.'];
const SETTING = PREFIX + 'enabled';
const COLOR_SETTING = PREFIX + 'userMessageColor';
const EDGE_SETTING = PREFIX + 'userMessageEdge';
const REMOVED_KEY = 'claudeCodeExtras.removed';
const PLUGIN_KEY = 'claudeCodeExtras.workPlanPlugin';
const SWEEP_KEY = 'claudeCodeExtras.lastOrphanSweep';
const LATENCY_KEY = 'claudeCodeExtras.latencyOffset';
const THRESHOLD_SETTING = PREFIX + 'latencyThresholdSeconds';
const LATENCY_ON_SETTING = PREFIX + 'recordOpenLatency';
const PINS_SETTING = PREFIX + 'sessionPins';
const PIN_MARGIN_SETTING = PREFIX + 'sessionPinsMarginDays';
const REOPEN_SETTING = PREFIX + 'reopenDroppedTabs';
const RECENT_SETTING = PREFIX + 'recentClosedSessions';
const HIDE_BG_SETTING = PREFIX + 'hideBackgroundSessions';
const WORK_PLAN_SETTING = PREFIX + 'workPlan';
const BRIEF_SETTING = PREFIX + 'conversationBrief';
/* Read by the plugin's hooks, which are separate processes and cannot see editor settings. Keys match plan_path.py.
   package.json makes them application settings, since they go into one file that every conversation on the machine
   reads. */
const HOOK_SETTINGS = {
  enabled: WORK_PLAN_SETTING,
  offerMinTurns: PREFIX + 'workPlanOfferMinTurns',
  offerMinToolCalls: PREFIX + 'workPlanOfferMinToolCalls',
  quietWhenReplyMatches: PREFIX + 'workPlanQuietWhenReplyMatches',
  tellTimeZone: PREFIX + 'tellClaudeYourTimeZone',
  brief: BRIEF_SETTING,
};

/*
 * Memoize `read()` for the current turn of the event loop. A timer or event handler asks for the same value several
 * times while it runs, and it is computed once per turn.
 */
function perTick(read) {
  let value, have = false;
  return () => {
    if (!have) { value = read(); have = true; setImmediate(() => { have = false; }); }
    return value;
  };
}

/* Which folders of an extensions directory the editor has marked for deletion, read once per turn of the event loop. */
const marks = new Map();
function markedIn(root) {
  if (!marks.size) setImmediate(() => marks.clear());
  if (!marks.has(root)) marks.set(root, removal.obsolete(root));
  return marks.get(root);
}

/*
 * Every install of Claude Code this adapter can see: the one this window runs plus sibling versions in the same folder,
 * less the siblings the editor has marked for deletion, which nobody will run again. `all` keeps those too, for taking
 * our changes back out: a marked folder can still carry them until the editor deletes it.
 */
function installs(adapter, all = false) {
  const ext = vscode.extensions.getExtension(adapter.id);
  if (!ext) return [];
  const root = path.dirname(ext.extensionPath);
  const found = Array.from(new Set([ext.extensionPath, ...adapter.findInstalls(root)]));
  return all ? found : removal.unmarked(found, ext.extensionPath, markedIn(root));
}

/* The editor's settings as last read. Reading them builds a merged copy of every scope, and a tick asks for a couple of
   dozen values, so the copy is kept until the editor reports a change, when start() drops it. */
let settings = null;
const cfg = () => settings || (settings = vscode.workspace.getConfiguration());
function enabled() { return cfg().get(SETTING, true); }

/** Folders this window has open, which is where a session started here keeps its scheduled-prompt file. */
function openDirs() {
  return (vscode.workspace.workspaceFolders || [])
    .filter((f) => f.uri && f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
}

async function offerReload(text) {
  const pick = await vscode.window.showInformationMessage(text, 'Reload Window');
  if (pick === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/* A keybinding made before a rename names a command under an old prefix, so the old names stay registered, unlisted.
   The editor refuses a name that another extension in this host holds already, as the old extension does until the host
   restarts after it was updated, and that name is left to it. */
function registerCommand(name, fn) {
  const all = [vscode.commands.registerCommand(PREFIX + name, fn)];
  for (const p of LEGACY_PREFIXES) {
    try { all.push(vscode.commands.registerCommand(p + name, fn)); } catch (_) { /* held by another extension */ }
  }
  return { dispose() { for (const d of all) d.dispose(); } };
}

/*
 * Settings were once named under the old prefixes. A value set under an old name is copied to its new name, in the same
 * scope, from the more recent prefix when both have one. The old ones are then cleared where the editor allows that;
 * it may refuse to write a name no extension declares any more, and then the old line is left in place.
 *
 * A copy is made only where the new name has no value of its own, so nothing set under the new name is overwritten; and
 * each scope is done once, so putting a new name back to its default later does not bring the old value back.
 */
const RENAMED_KEY = PREFIX + 'settingsRenamed';
async function renameSettings(context) {
  const contrib = (context.extension.packageJSON.contributes || {}).configuration || {};
  const names = [].concat(contrib).flatMap((c) => Object.keys((c && c.properties) || {}))
    .filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));
  /* An application setting cannot be written to a workspace or folder, so those scopes skip it. An old name's value
     there is left alone and does nothing. */
  const userOnly = new Set([].concat(contrib).flatMap((c) => Object.entries((c && c.properties) || {}))
    .filter(([, v]) => v && v.scope === 'application').map(([k]) => k.slice(PREFIX.length)));
  const T = vscode.ConfigurationTarget;
  const groups = [];
  const all = () => vscode.workspace.getConfiguration();
  if (!context.globalState.get(RENAMED_KEY)) {
    groups.push({ state: context.globalState,
      scopes: [{ where: 'user', target: T.Global, field: 'globalValue', conf: all }] });
  }
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length && !context.workspaceState.get(RENAMED_KEY)) {
    const inFolder = (f) => ({ where: 'folder ' + f.name, target: T.WorkspaceFolder, field: 'workspaceFolderValue',
      conf: () => vscode.workspace.getConfiguration(undefined, f.uri) });
    groups.push({ state: context.workspaceState,
      scopes: [{ where: 'workspace', target: T.Workspace, field: 'workspaceValue', conf: all }].concat(folders.map(inFolder)) });
  }
  const done = [];
  for (const g of groups) {
    let complete = true;
    for (const sc of g.scopes) {
      const conf = sc.conf();
      let moved = 0, left = 0;
      for (const name of names) {
        if (sc.target !== T.Global && userOnly.has(name)) continue;
        const found = LEGACY_PREFIXES.map((p) => {
          const old = conf.inspect(p + name);
          return { key: p + name, value: old ? old[sc.field] : undefined };
        }).filter((o) => o.value !== undefined);
        if (!found.length) continue;
        const now = conf.inspect(PREFIX + name);
        try {
          if (!now || now[sc.field] === undefined) await conf.update(PREFIX + name, found[0].value, sc.target);
          moved++;
        } catch (_) { complete = false; continue; }
        for (const o of found) { try { await conf.update(o.key, undefined, sc.target); } catch (_) { left++; } }
      }
      if (moved) done.push(`${moved} in ${sc.where}` + (left ? ` (${left} old line${left > 1 ? 's' : ''} left in place)` : ''));
    }
    if (complete) await g.state.update(RENAMED_KEY, true);
  }
  return done.join(', ');
}

/* The pins and colors chosen under the old id (src/carryover.js), copied before anything here reads its own. */
function carryOver(context, log) {
  try {
    const r = carryover.copyFiles(context.globalStorageUri.fsPath, [sessionPins.FILE, sessionColors.FILE]);
    if (r.copied.length) log.appendLine(`copied from ${carryover.LEGACY_ID}: ${r.copied.join(', ')}`);
    if (r.failed.length) log.appendLine(`could not copy from ${carryover.LEGACY_ID}: ${r.failed.join(', ')}`);
  } catch (e) { log.appendLine('copying from ' + carryover.LEGACY_ID + ': ' + e.message); }
}

/*
 * An earlier version of the old extension (src/carryover.js) patches Claude Code with its own build, and two extensions
 * doing that take turns rewriting the same files. Until it is updated or uninstalled nothing here starts, since the old
 * one still owns the patch, the plugin and the settings. Its commands share names with ours, and are left to it. The
 * first start after it is gone runs as usual.
 */
const TOLD_KEY = PREFIX + 'toldEarlierBuild';
/* How long the first start waits for export.json from the old id's last version. */
const EXPORT_WAIT_MS = 20000;
function standAside(context, log, version) {
  log.appendLine(`Work Plan for Claude Code ${version} (${carryover.LEGACY_ID}) is still installed and patches Claude Code itself; `
    + 'this extension does nothing until it is updated or uninstalled');
  const tell = () => vscode.window.showWarningMessage(
    'An earlier version of Work Plan for Claude Code is installed. Update or uninstall it to use Claude Code Plus; your work plans come back after uninstall.',
    'Show It',
  ).then((pick) => { if (pick === 'Show It') showOldExtension(); }, () => {});
  for (const c of (context.extension.packageJSON.contributes || {}).commands || []) {
    context.subscriptions.push(vscode.commands.registerCommand(c.command, tell));
  }
  if (context.globalState.get(TOLD_KEY) === version) return;
  Promise.resolve(context.globalState.update(TOLD_KEY, version)).catch(() => {});
  tell();
}

/* The old extension's page in the Extensions view, where it can be updated or uninstalled; a search for its id when the
   editor cannot open the page. */
function showOldExtension() {
  return Promise.resolve(vscode.commands.executeCommand('extension.open', carryover.LEGACY_ID))
    .catch(() => vscode.commands.executeCommand('workbench.extensions.search', '@id:' + carryover.LEGACY_ID))
    .then(undefined, () => {});
}

/*
 * The old id's last version does nothing, and once this extension runs in its place it can be uninstalled. The question
 * is not asked at a start that asks for a reload, so that reload comes first. It is asked again at later starts until
 * its button is used.
 */
const TOLD_OLD_KEY = PREFIX + 'toldUninstallOld';
function offerUninstallOld(context) {
  if (context.globalState.get(TOLD_OLD_KEY) === true) return;
  vscode.window.showInformationMessage(
    'Claude Code Plus is now running. Work Plan for Claude Code is still installed but no longer does anything; you can uninstall it from its Extensions page.',
    'Show Extension',
  ).then((pick) => {
    if (pick !== 'Show Extension') return;
    Promise.resolve(context.globalState.update(TOLD_OLD_KEY, true)).catch(() => {});
    showOldExtension();
  }, () => {});
}

/*
 * In Restricted Mode nothing starts until the workspace is trusted: everything this extension does writes files or runs
 * Claude Code's command line. deactivate() still restores Claude Code's files on an uninstall, in Restricted Mode too.
 */
async function activate(context) {
  selfPath = context.extensionPath;
  const log = vscode.window.createOutputChannel('Claude Code Plus');
  context.subscriptions.push(log);
  let earlier = '', handing = false;
  try {
    const old = vscode.extensions.getExtension(carryover.LEGACY_ID);
    earlier = carryover.earlierBuild(old);
    handing = !!old && !earlier;
  } catch (_) { /* not there */ }
  if (earlier) { standAside(context, log, earlier); return; }
  /* The old id's last version writes export.json when it activates, and the editor activates it only after this
     activation has returned, since it depends on this extension. So the start waits for the file, and activation does
     not wait for the start. */
  const storage = context.globalStorageUri.fsPath;
  const exported = path.join(carryover.legacyStorage(storage), carryover.EXPORT_FILE);
  const waiting = handing && !fs.existsSync(exported);
  const go = async () => {
    if (waiting && !(await carryover.waitFor(exported, EXPORT_WAIT_MS))) {
      log.appendLine(`${carryover.LEGACY_ID} wrote no ${carryover.EXPORT_FILE} within ${EXPORT_WAIT_MS / 1000}s; starting without it`);
    }
    try {
      const taken = await carryover.importState(context.globalState, storage);
      if (taken.length) log.appendLine(`taken from ${carryover.LEGACY_ID}: ${taken.join(', ')}`);
    } catch (e) { log.appendLine(`reading ${exported}: ${e && e.message}`); }
    carryOver(context, log);
    let renamed = '';
    try { renamed = await renameSettings(context); } catch (e) { renamed = 'failed: ' + (e && e.message); }
    await start(context, log, renamed, handing);
  };
  if (vscode.workspace.isTrusted !== false) {
    const started = go();
    if (waiting) started.catch((e) => log.appendLine('starting: ' + ((e && e.stack) || e)));
    else await started;
    return;
  }
  log.appendLine('Restricted Mode: nothing starts until this workspace is trusted');
  let started = false;
  const trusted = vscode.workspace.onDidGrantWorkspaceTrust(() => {
    if (started) return;
    started = true;
    go().catch((e) => log.appendLine('starting once trusted: ' + ((e && e.stack) || e)));
  });
  context.subscriptions.push(trusted);
}

function start(context, log, renamed, handing = false) {
  if (renamed) log.appendLine(`settings moved from ${LEGACY_PREFIXES.map((p) => p + '*').join(' and ')} to ${PREFIX}*: ${renamed}`);
  const removed = () => context.globalState.get(REMOVED_KEY, false) === true;
  /*
   * Install state of the copy this window runs (src/removal.js), memoized per turn of the event loop.
   *
   * Uninstalling: the editor has marked it for deletion with no other version staying, and waits for this window to
   * restart its extensions. Until then it must not re-patch files another window has just restored.
   *
   * Replaced: another build of this extension is installed now (another version beside it, or the same version again
   * over it) while this window keeps running this one. It then leaves every shared file alone; the windows that reload
   * run the installed build and keep those files current.
   */
  const loadedStamp = removal.installStamp(context.extensionPath);
  const standing = perTick(() => removal.standing(context.extensionPath, ID, loadedStamp, markedIn(path.dirname(context.extensionPath))));
  const uninstalling = () => standing() === 'uninstalling';
  const replaced = () => standing() === 'replaced';

  /*
   * Which project directories to look for scheduled prompts in - remembered across windows, not taken from this one.
   *
   * The stylesheet the page reads sits in Claude Code's own folder, so every window writes the SAME file. If each wrote
   * only what its own open folders yielded, two windows would take turns adding and removing the section every refresh.
   * Remembering the union, merged and ordered the same way by every window (rememberDirs in src/tasks.js), makes every
   * window write the same content, so later writes change nothing.
   *
   * The known gap: a session started in a SUBdirectory of an open folder is not found, and its section simply does not
   * appear. Walking directories would trade a certain cost for an uncertain gain, so it waits for a real case.
   */
  /* A key of its own: windows still on an earlier build read and write a plain list under the old one, and two formats
     under one key would make the builds overwrite each other. The old list seeds the new key. */
  const DIRS_KEY = 'claudeCodeExtras.projectDirDays';
  const OLD_DIRS_KEY = 'claudeCodeExtras.projectDirs';
  const knownDirs = perTick(() => {
    const stored = context.globalState.get(DIRS_KEY);
    const r = rememberDirs(stored !== undefined ? stored : context.globalState.get(OLD_DIRS_KEY, []), openDirs());
    if (r.changed) context.globalState.update(DIRS_KEY, r.store);
    return r.dirs;
  });

  /* One setting per switchable addition, named after it. Reading them here rather than in src/webview.js keeps that
     file free of the editor's API, which is what lets the tests run it. */
  const switchedOff = () => webview.SWITCHES.filter((k) => cfg().get(PREFIX + 'show.' + k, true) === false);
  /* The conversations pinned in the session list (src/sessionpins.js). The file is in this extension's storage on the
     machine that holds the transcripts, and every window reads and writes the same one. */
  const pinsFile = () => path.join(context.globalStorageUri.fsPath, sessionPins.FILE);
  const pinsOn = () => !removed() && cfg().get(PINS_SETTING, true) !== false;
  const pinMargin = () => cfg().get(PIN_MARGIN_SETTING, sessionPins.MARGIN_DAYS);
  const colorsFile = () => path.join(context.globalStorageUri.fsPath, sessionColors.FILE);
  const colorsOn = () => !removed() && !switchedOff().includes('sessionColors');
  const options = () => {
    const off = switchedOff();
    return {
      enabled: enabled(), userColor: cfg().get(COLOR_SETTING, ''), userEdge: cfg().get(EDGE_SETTING, true) !== false,
      off,
      tasks: readTasks(knownDirs()),
      background: off.includes('backgroundSessions') ? [] : background.collect(),
      pins: pinsOn() ? sessionPins.pageData(sessionPins.read(pinsFile()), sessionPins.retentionDays(), pinMargin()) : null,
      colors: off.includes('sessionColors') || removed() ? null : sessionColors.read(colorsFile()),
    };
  };
  /* Never after Remove, which has just taken these files out of Claude Code's folder: a scan finishing afterwards would
     put them back. */
  const writeLiveNow = () => {
    if (removed() || uninstalling() || replaced()) return;
    try {
      const opts = options();
      for (const dir of installs(webview)) webview.writeLive(dir, opts);
    } catch (e) {
      log.appendLine('live refresh failed: ' + e.message);
    }
  };
  /* Reads what the conversation in front of the reader has added to its transcript since last time - the only one, since
     that is the one being looked at; the others were read when they were. A new session is written out at once rather
     than at the next refresh, so it appears in the agent map while the launch is still on screen. */
  /* Where each reply's effort changed, for the conversation in front of the reader, written beside the panel for it to
     read (src/efforts.js). Not read at all when the model is switched off, since the effort is shown with it. */
  const scanEffort = (opts) => {
    if (removed() || !enabled() || uninstalling() || replaced() || switchedOff().includes('modelName')) return;
    const id = activeChat();
    if (!id) return;
    efforts.scan(id, opts || {})
      .then((r) => {
        // Asked again: the scan may have finished after Remove, or once this window no longer runs the installed build.
        if (!r || !r.css || removed() || uninstalling() || replaced()) return;
        for (const dir of installs(webview)) webview.writeEffort(dir, id, r.css);
      })
      .catch((e) => log.appendLine('reply efforts: ' + e.message));
  };
  /* Where Claude Code's own command line can be found: its binary ships inside each install. */
  const claudeFolders = () => Array.from(new Set(ADAPTERS.flatMap((adapter) => installs(adapter))));
  const scanBackground = () => {
    if (removed() || !enabled() || uninstalling() || replaced() || switchedOff().includes('backgroundSessions')) return;
    const id = activeChat();
    if (!id) return;
    background.scan(id)
      .then((r) => { if (r && r.added) writeLiveNow(); })
      .catch((e) => log.appendLine('background sessions: ' + e.message));
  };

  /* Set when a sync here has patched or restored Claude Code's files; either asks for a reload. */
  let reloadOffered = false;
  /* Bring every install in line with the current settings. Only installing, upgrading or removing the patch itself
     asks for a reload; on and off and the color are picked up by an open panel within a couple of seconds. */
  async function sync({ interactive = false } = {}) {
    if (replaced()) {
      log.appendLine('sync: this window runs a build that has since been installed again; leaving the files to the windows running it');
      if (interactive) offerReload('This window is running an earlier build of Claude Code Plus than the one now installed. Reload the window to run it.');
      return;
    }
    const patched = [], restored = [], problems = [];
    const leaving = uninstalling();
    const restoring = removed() || leaving;
    /* The live stylesheet's options, computed once and only for the panel's bundle (the host bundle ignores them),
       since computing them reads the background sessions, the scheduled prompts and the pins. */
    let opts = null;
    let found = 0;
    for (const adapter of ADAPTERS) {
      for (const dir of installs(adapter, restoring)) {
        found++;
        const label = `${adapter.name} (${path.basename(dir)})`;
        try {
          if (restoring) {
            const r = adapter.restore(dir);
            log.appendLine(`${label}: ${r.message}`);
            if (r.changed && !restored.includes(adapter.name)) restored.push(adapter.name);
          } else {
            const r = adapter.apply(dir, adapter === webview ? (opts || (opts = options())) : undefined);
            log.appendLine(`${label}: ${r.message}${r.liveChanged ? ' (live settings updated)' : ''}`);
            if (r.changed && !patched.includes(adapter.name)) patched.push(adapter.name);
            else if (!r.changed && !r.current) problems.push(`${label}: ${r.message}`);
          }
        } catch (e) {
          problems.push(`${label}: ${e.message}`);
          log.appendLine(`${label}: error ${e.stack || e.message}`);
        }
      }
    }
    if (!found && interactive) vscode.window.showWarningMessage('Claude Code Plus: the Claude Code extension is not installed, so there is nothing to patch.');
    // A shape mismatch after a Claude Code update would otherwise be silent, so it is said out loud.
    if (problems.length) vscode.window.showWarningMessage('Claude Code Plus: ' + problems.join(' | '));
    if (patched.length) offerReload(`Claude Code Plus is installed in ${patched.join(' and ')}. Reload the window once to start; after that, On/Off and colors change live.`);
    if (patched.length || restored.length) reloadOffered = true;
    // An uninstall already has the editor asking for a restart of its extensions; a second prompt would only compete.
    if (restored.length && !leaving) offerReload(`Claude Code Plus was removed from ${restored.join(' and ')}. Reload the window to finish.`);
  }

  /* No status bar item for on and off.
   *
   * There was one, reading "Extras: On". It promised more than the setting behind it does: off stops the additions being
   * drawn, while the patch, the injected script, its poll and the hooks all stay - so a reader took it for a switch that
   * turns this extension off, which is the Remove command. It also sat one click away in the left status bar, where
   * hitting it by accident silently changed a global setting. The three commands remain for anyone who wants it.
   */
  const setEnabled = async (value) => {
    const unremoving = value && removed();
    if (unremoving) await context.globalState.update(REMOVED_KEY, false);
    if (enabled() === value) { await sync({ interactive: true }); return; }
    await cfg().update(SETTING, value, vscode.ConfigurationTarget.Global);
    // The setting reaches the live stylesheet only; coming back from Remove needs the patch put back in as well.
    if (unremoving) await sync({ interactive: true });
  };

  context.subscriptions.push(
    registerCommand('enable', () => setEnabled(true)),
    registerCommand('disable', () => setEnabled(false)),
    registerCommand('toggle', () => setEnabled(!(enabled() && !removed()))),
    registerCommand('remove', async () => {
      await context.globalState.update(REMOVED_KEY, true);
      await sync({ interactive: true });
    }),
    registerCommand('status', () => {
      const lines = [];
      for (const adapter of ADAPTERS) for (const d of installs(adapter, true)) lines.push(`${adapter.name} ${path.basename(d)}: ${adapter.status(d)}`);
      vscode.window.showInformationMessage('Claude Code Plus — ' + (lines.join(' | ') || 'Claude Code is not installed') + (removed() ? ' (removed)' : ''));
    }),
    /* Every setting this extension has, in the editor's own settings UI: search, per-workspace values, sync and a JSON
       view come with it, and none of it is ours to maintain. */
    /*
     * Take the plugin out of Claude Code's own settings, which is the only way to stop its skill description being
     * loaded - about a hundred tokens a session that the switch above cannot reach, because the switch only tells the
     * plugin's hooks to do nothing while the plugin itself stays registered.
     *
     * A command rather than something the switch does, because this writes Claude Code's configuration rather than ours,
     * and an extension that quietly edits another tool's settings is the behaviour nobody wants to discover later.
     * `disable` and not `uninstall`: uninstalling takes the plugin's data directory with it, and that is where every
     * conversation's plan lives.
     */
    registerCommand('disableWorkPlanPlugin', async () => {
      const yes = await vscode.window.showWarningMessage(
        'Stop Claude Code loading the work plan plugin? This edits Claude Code\'s own settings, and saves the skill '
        + 'description it loads every session. Your existing plans are left alone.',
        { modal: true }, 'Stop loading it');
      if (yes !== 'Stop loading it') return;
      const r = await pluginInstall.disable(claudeFolders());
      log.appendLine('work plan plugin: ' + r.said);
      log.show(true);
      if (r.ok) await offerReload('The work plan plugin will stop loading in conversations started after a reload.');
    }),
    registerCommand('openSettings',
      // Our own id, so a change of publisher or name cannot leave this pointing at an extension that is not here.
      () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + context.extension.id)),
    /* Reads the records rather than measuring anything, so it is also the way to see them after a window restart. */
    registerCommand('showOpenLatency', () => {
      sampleLatency();
      /* Every window's records, not just this one's - a regression shows up across windows, and the window you happen to
         run this from is rarely the one that was slow. */
      const records = latency.readAll(latencyDir());
      log.appendLine('');
      for (const line of latency.report(records, thresholdMs())) log.appendLine(line);
      log.appendLine(`  records: ${path.join(latencyDir(), 'open-latency-<pid>.jsonl')}, one per window`);
      log.show(true);
    }),
    // A Claude Code update arrives as a new folder, so patch it as soon as that folder appears.
    vscode.extensions.onDidChange(() => sync()),
  );

  const REFRESH_MS = 30000;

  /*
   * How long this window makes you wait, taken from the official extension's log rather than measured here - see
   * src/openlatency.js for what is paired with what. It rides the half-minute timer because it costs one stat of one
   * file when nothing has been written, and reads only the bytes appended since the last pass.
   *
   * It is deliberately not in the injected script. A readout added there once made reloading the window crash, and the
   * mechanism was never established; the panel is also the wrong side to measure from, since what is being timed is a
   * panel that has not started yet.
   */
  /* A directory rather than a file: each window writes only its own, since several of them share this folder and
     nothing locks it. src/openlatency.js says what goes wrong when they share one. */
  const latencyDir = () => context.globalStorageUri.fsPath;
  const stamp = () => {
    const ours = context.extension && context.extension.packageJSON && context.extension.packageJSON.version;
    const ext = vscode.extensions.getExtension(webview.id);
    const theirs = ext && ext.packageJSON && ext.packageJSON.version;
    return `${ours || '?'}/${theirs || '?'}`;
  };
  const thresholdMs = () => Math.max(1, cfg().get(THRESHOLD_SETTING, 10)) * 1000;
  /* Read offset, open pairings and the fast-open count for this window's log, kept in memory only: each window has its
     own log and a reload starts a new one, so shared storage would carry this state into the wrong log. */
  let latencyState = {};
  if (context.globalState.get(LATENCY_KEY) !== undefined) context.globalState.update(LATENCY_KEY, undefined);
  function sampleLatency() {
    /* Off means nothing is read either. Stopping only the writing would leave the log being opened and parsed every
       thirty seconds, which is most of what this costs. */
    if (!cfg().get(LATENCY_ON_SETTING, true)) return;
    try {
      const r = latency.sample({
        log: latency.logFile(context.logUri.fsPath),
        dir: latencyDir(),
        state: latencyState,
        version: stamp(),
        thresholdMs: thresholdMs(),
      });
      if (r.state) latencyState = r.state;
      /* Anything recorded is already past the threshold, so it is worth saying without being asked. */
      for (const w of r.added) {
        log.appendLine(`waited ${(w.waited / 1000).toFixed(1)}s for ${w.what} (${w.trigger}) at ${w.at}`);
      }
    } catch (e) {
      log.appendLine('open latency: ' + e.message);
    }
  }
  sampleLatency();

  /* The other half of the same recording runs in the panel itself (src/panel-load-watch.js), put there by the patched
     host bundle as each panel's HTML is built. That bundle runs in this process and reads this flag at that moment, so
     the setting reaches the next panel opened without a reload. */
  const loadWatchOff = () => { globalThis[host.LOAD_WATCH_OFF] = !cfg().get(LATENCY_ON_SETTING, true); };
  loadWatchOff();
  context.subscriptions.push({ dispose: () => { delete globalThis[host.LOAD_WATCH_OFF]; } });

  /*
   * Hand the hooks their thresholds.
   *
   * They run as their own processes, so the editor's settings cannot reach them directly; this is the one file they read
   * instead, which keeps the settings UI as the only place a person edits these. Written on activation and whenever one
   * of them changes, and never required to exist - the plugin ships its own defaults so it works without this extension.
   */
  function writeHookSettings() {
    const values = {};
    for (const [key, setting] of Object.entries(HOOK_SETTINGS)) {
      const v = cfg().get(setting);
      if (typeof v === 'boolean') values[key] = v;
      else if (typeof v === 'number' && v >= 1) values[key] = Math.floor(v);
      else if (typeof v === 'string' && v) values[key] = v;
    }
    /* planDir(), not PLAN_DIR: that one is only the directory's name, and joined on its own it resolves against the
       extension host's working directory - a config.json the hooks never read. Written only when it changes, and
       replaced whole (src/hook-settings.js). */
    try { hookSettings.writeHookSettings(planDir(), values); } catch (e) {
      log.appendLine('work plan hook settings: ' + e.message);
    }
  }
  writeHookSettings();

  /* The day's count is written out when the window closes, which is the other moment it is known to be complete. */
  context.subscriptions.push({
    dispose: () => {
      try { latency.flush({ dir: latencyDir(), state: latencyState }); } catch (_) { /* closing anyway */ }
    },
  });

  /* The id of the conversation in front of the reader, or empty. The patched field writes it on every change; before
     anything has, or when the panel has no conversation open, it is not a string and reads as empty, which Agent Plus
     shows as no plan rather than another conversation's. */
  const activeChat = () => {
    const v = globalThis.__cceActiveChat;
    return typeof v === 'string' ? v : '';
  };
  /*
   * Delete the plans of conversations that no longer exist, at most once a calendar day.
   *
   * There is no timer for this, deliberately. It is reached from activation and from the periodic refresh below noticing
   * that the day has changed - so opening a window is what triggers it, and a window left open for weeks still gets a
   * turn. On every other call the whole cost is one string compare.
   *
   * The day is recorded before the work, not after: several windows are separate extension hosts sharing one unlocked
   * directory, and a reading that keeps failing should not be retried twice a minute until midnight.
   */
  const sweepPlans = async () => {
    if (removed()) return;
    const day = new Date().toISOString().slice(0, 10);
    if (context.globalState.get(SWEEP_KEY, '') === day) return;
    await context.globalState.update(SWEEP_KEY, day);
    const r = sweepOrphans();
    if (r.why) log.appendLine('orphan work plans: ' + r.why);
    else if (r.deleted) log.appendLine(`orphan work plans: deleted ${r.deleted}, kept ${r.kept}`);
    /* Efforts files beside the panel are pruned with the live-session list from the sweep just made; when that list is
       unknown, nothing is removed. */
    if (r.live) for (const dir of installs(webview, true)) webview.pruneEfforts(dir, r.live);
    try { if (r.live && sessionColors.prune(colorsFile(), r.live)) writeLiveNow(); } catch (_) { /* tried again tomorrow */ }
  };
  /* The reader's time zone as a panel of this window last reported it (src/panel-tz.js), or empty until one has. */
  const clientZone = () => {
    const v = globalThis.__cceClientTimeZone;
    return typeof v === 'string' ? v : '';
  };
  /* The plugin's hooks tell the model this zone (tell-time-zone.py), and they run beside Claude Code with no way to ask
     a panel, so it is left for them in a file. The last panel to report wins: one person behind several windows reads
     them all in one zone. A window that has not heard from a panel yet writes nothing rather than an empty zone. */
  const writeClientZone = () => {
    try { hookSettings.writeClientZone(planDir(), clientZone()); } catch (e) {
      log.appendLine('client time zone: ' + e.message);
    }
  };
  let closing = false;
  context.subscriptions.push({ dispose: () => { closing = true; } });
  let liveStates = new Map(), unreadKeys = new Set(), statesTimer = 0;
  const readTitles = waiting.reader();
  globalThis.__cceStatesHook = (states, active, open, unread) => {
    try {
      liveStates = new Map((Array.isArray(states) ? states : [])
        .filter((s) => s && typeof s.sessionId === 'string').map((s) => [s.sessionId, s.state]));
      unreadKeys = new Set((Array.isArray(unread) ? unread : []).filter((k) => typeof k === 'string'));
      if (!statesTimer) statesTimer = setTimeout(() => { statesTimer = 0; claude.changed(); }, 300);
    } catch (_) { /* the next update */ }
  };
  /* The info box asks for its conversation's process id. `claude agents` is run for it unless the last run is under
     half a minute old. The Work plan line is sent separately, without waiting for `claude agents`. */
  globalThis.__cceProcessHook = (sessionId) => {
    if (removed() || !enabled() || switchedOff().includes('footerInfo')) return;
    const transcript = cfg().get(WORK_PLAN_SETTING, true) !== false ? transcriptOf(sessionId) : '';
    if (transcript) {
      planInjections.measure(transcript).then((m) => {
        const reply = { type: 'cce_plan', sessionId, text: planInjections.describe(m) };
        if (typeof globalThis.__cceToPanel === 'function') globalThis.__cceToPanel(sessionId, reply);
      }).catch((e) => log.appendLine('work plan line for the info box: ' + (e && e.message)));
    }
    claude.freshAgents().then((r) => {
      const reply = { type: 'cce_process', sessionId, pids: r.records ? waiting.pidsOf(r.records, sessionId) : null };
      if (typeof globalThis.__cceToPanel === 'function') globalThis.__cceToPanel(sessionId, reply);
    }).catch((e) => log.appendLine('process for the info box: ' + (e && e.message)));
  };
  context.subscriptions.push({ dispose: () => {
    if (statesTimer) clearTimeout(statesTimer);
    if (globalThis.__cceStatesHook) delete globalThis.__cceStatesHook;
    if (globalThis.__cceProcessHook) delete globalThis.__cceProcessHook;
  } });

  /* Created here because it reads globals the patched host sets in this process. */
  const claude = createClaudeSource({
    planDir,
    enabled: () => cfg().get(WORK_PLAN_SETTING, true) !== false,
    brief: () => cfg().get(BRIEF_SETTING, true) !== false,
    timeZone: () => clientZone(),
    listAgents: () => waiting.listAgents(pluginInstall.findClaude(claudeFolders())),
    folders: () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    readPlan,
    titles: readTitles.titles,
    since: readTitles.since,
    live: () => liveStates,
    unread: () => unreadKeys,
    activeChat: () => activeChat(),
    logo: () => {
      const ext = vscode.extensions.getExtension(webview.id);
      if (!ext || !ext.extensionPath) return null;
      const file = vscode.Uri.file(path.join(ext.extensionPath, 'resources', 'claude-logo.svg'));
      return { light: file, dark: file };
    },
    canDeliver: (sessionId) => {
      try { return typeof globalThis.__cceAnswer === 'function' && globalThis.__cceAnswer(sessionId) === true; } catch (_) { return false; }
    },
    hand: (sessionId, text, key) => globalThis.__cceAnswer(sessionId, text, key) === true,
    /* An extension cannot raise another window, and opening the conversation here as well would start a second process on
       it. */
    reveal: async (sessionId) => {
      const list = (name) => { try { const f = globalThis[name]; return typeof f === 'function' ? f() || [] : []; } catch (_) { return []; } };
      const elsewhere = list('__cceSessionsElsewhere');
      const here = list('__cceSessionsShown').filter((id) => !elsewhere.includes(id));
      if (!here.includes(sessionId)) return false;
      await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
      return true;
    },
  });
  context.subscriptions.push(claude);
  {
    const groups = vscode.window.tabGroups;
    const activeTab = () => { const g = groups && groups.activeTabGroup; return g ? g.activeTab : undefined; };
    claude.tabsChanged(activeTab());
    for (const name of ['onDidChangeTabs', 'onDidChangeTabGroups']) {
      if (groups && typeof groups[name] === 'function') context.subscriptions.push(groups[name](() => claude.tabsChanged(activeTab())));
    }
  }

  globalThis.__cceAnswerHook = (key, sent, reason) => claude.answered(key, sent, reason);
  context.subscriptions.push({ dispose: () => { if (globalThis.__cceAnswerHook) delete globalThis.__cceAnswerHook; } });
  coreLink.link(vscode, claude.source, { name: 'the Claude Code source', log: (m) => log.appendLine(m) }).then((r) => {
    if (!r.registered) return;
    const { registration } = r;
    log.appendLine(`registered with Agent Plus ${r.core.version || ''}`.trim());
    if (closing) { registration.dispose(); return; }
    context.subscriptions.push(registration);
    claude.refocus();
  }).catch((e) => log.appendLine('registering with Agent Plus: ' + ((e && e.message) || e)));
  /*
   * Following the conversation has to be immediate, so the patched field calls this the moment it is written. Waiting
   * for the periodic scan meant up to half a minute of showing the conversation you just left, which is not "follows
   * the conversation" - it is the same complaint with a delay.
   *
   * The fast tick beside it reads one property and nothing else. It is there because the callback depends on the host
   * patch being in, and a build whose shape did not match would otherwise leave the work plan view frozen with no sign
   * why.
   */
  /*
   * The transcripts of the conversation in front of the reader are watched, so a reply's effort is read within a second
   * of the reply being written rather than at the next thirty-second refresh - which is when the reader is looking at
   * it. A turn appends a row per block in a burst, so a change is scanned after a short pause and one pass reads the
   * burst. Nothing runs while nothing is written. The refresh still scans, and re-establishes a watch that has failed
   * or a sub-agents folder that did not exist yet.
   */
  const EFFORT_SETTLE_MS = 700;
  let effortWatch = { id: '', main: null, sub: null, timer: 0, subs: false };
  const unwatchEffort = () => {
    for (const w of [effortWatch.main, effortWatch.sub]) { if (w) { try { w.close(); } catch (_) { /* closed */ } } }
    if (effortWatch.timer) clearTimeout(effortWatch.timer);
    effortWatch = { id: '', main: null, sub: null, timer: 0, subs: false };
  };
  const watchEffort = () => {
    const id = activeChat();
    if (id !== effortWatch.id) unwatchEffort();
    if (!id || removed() || !enabled() || replaced() || switchedOff().includes('modelName')) { unwatchEffort(); return; }
    const transcript = transcriptOf(id);
    if (!transcript) return;
    effortWatch.id = id;
    /* Only the side that changed is read: the sub-agents are looked at when their folder changed, not on every row the
       conversation itself appends. */
    const soon = (slot) => () => {
      if (slot === 'sub') effortWatch.subs = true;
      if (effortWatch.timer) return;
      effortWatch.timer = setTimeout(() => {
        const subs = effortWatch.subs;
        effortWatch.timer = 0;
        effortWatch.subs = false;
        scanEffort({ subagents: subs });
      }, EFFORT_SETTLE_MS);
    };
    const open = (target, slot) => {
      if (effortWatch[slot]) return;
      try {
        const w = fs.watch(target, { persistent: false }, soon(slot));
        w.on('error', () => { try { w.close(); } catch (_) { /* closed */ } if (effortWatch[slot] === w) effortWatch[slot] = null; });
        effortWatch[slot] = w;
      } catch (_) { /* not there yet: the refresh tries again */ }
    };
    open(transcript, 'main');
    open(path.join(transcript.replace(/\.jsonl$/, ''), 'subagents'), 'sub');
  };
  context.subscriptions.push({ dispose: unwatchEffort });
  /* The background and effort scans are for Claude Code's own panel, so they follow activeSessionId even while the work
     plan view in Agent Plus shows another source's conversation. */
  const followChat = () => {
    if (!claude.followChat()) return;
    scanBackground();
    scanEffort();
    watchEffort();
  };
  let chatPoll = 0;
  const stopPolling = () => { if (chatPoll) { clearInterval(chatPoll); chatPoll = 0; } };
  globalThis.__cceChatHook = () => {
    // Being called at all proves the patch is in, so the fallback below has nothing left to do.
    stopPolling();
    try { followChat(); } catch (e) { /* never break the host's own setter */ }
  };
  /* The fallback, for a Claude Code build whose shape the patch could not match: without it the view would sit on one
     conversation with nothing saying why. A tick reads one property and compares a string - no files, no scanning - and
     it stops for good the first time the callback arrives. */
  chatPoll = setInterval(followChat, 1000);
  context.subscriptions.push({
    dispose: () => { stopPolling(); if (globalThis.__cceChatHook) delete globalThis.__cceChatHook; },
  });
  /* A Claude Code panel's page got focus (src/page/92-focus.js). */
  globalThis.__cceFocusHook = (sessionId) => {
    try { claude.pageFocus(sessionId); } catch (e) { log.appendLine('page focus: ' + (e && e.message)); }
  };
  context.subscriptions.push({ dispose: () => { if (globalThis.__cceFocusHook) delete globalThis.__cceFocusHook; } });
  /* A panel reports its time zone as it opens, which is usually after this has activated. */
  globalThis.__cceTzHook = () => {
    try { writeClientZone(); } catch (e) { /* never break the host's own message handling */ }
  };
  /* A panel can report before this activates, and then only the global above holds its zone. */
  writeClientZone();
  context.subscriptions.push({ dispose: () => { if (globalThis.__cceTzHook) delete globalThis.__cceTzHook; } });
  /* The patched host asks for each tab's icon here (src/tabdot.js). VS Code sends an icon to the editor only when the
     object changes, so each file keeps one Uri. */
  /*
   * Show a conversation as running while a `claude --bg` session it started is busy. Claude Code does the same for a
   * conversation's own background commands. Checked every ten seconds.
   */
  let bgWorking = new Set();
  const readBgWorking = () => {
    const next = removed() || !enabled() ? new Set() : background.working();
    if (next.size === bgWorking.size && [...next].every((id) => bgWorking.has(id))) return;
    bgWorking = next;
    try { if (typeof globalThis.__cceRefreshTabIcons === 'function') globalThis.__cceRefreshTabIcons(); } catch (_) { /* next change */ }
    try { if (typeof globalThis.__cceSendSessionStates === 'function') globalThis.__cceSendSessionStates(); } catch (_) { /* next change */ }
  };
  globalThis.__cceWithBackground = (infos) => (Array.isArray(infos) && bgWorking.size
    ? infos.map((i) => (i && i.state === 'idle' && bgWorking.has(i.sessionId) ? Object.assign({}, i, { state: 'running' }) : i))
    : infos);
  const bgTimer = setInterval(() => {
    try { readBgWorking(); } catch (e) { log.appendLine('busy background sessions: ' + (e && e.message)); }
  }, 10000);
  context.subscriptions.push({ dispose: () => {
    clearInterval(bgTimer);
    if (globalThis.__cceWithBackground) delete globalThis.__cceWithBackground;
  } });
  const tabIcons = new Map(), tabIconUris = new Map();
  globalThis.__cceTabIcon = (panel, state, run, home, sessionId) => {
    try {
      claude.track(panel, sessionId);
      const title = tabdot.withoutMark(panel.title);
      if (panel.title !== title) panel.title = title;
      if (!enabled() || removed() || typeof home !== 'string') return undefined;
      if (run !== 'running' && bgWorking.has(sessionId)) run = 'running';
      const icons = tabdot.iconsFor(path.join(home, 'resources'), path.join(context.globalStorageUri.fsPath, 'tab-icons'),
        tabIcons);
      const file = icons && icons[tabdot.stateOf(state, run)];
      if (!file) return undefined;
      if (!tabIconUris.has(file)) tabIconUris.set(file, vscode.Uri.file(file));
      return tabIconUris.get(file);
    } catch (e) { return undefined; /* the host sets its own icon */ }
  };
  context.subscriptions.push({ dispose: () => { if (globalThis.__cceTabIcon) delete globalThis.__cceTabIcon; } });
  /* Panels the editor restored before this extension started reported their icons and states before anything listened. */
  try { if (typeof globalThis.__cceRefreshTabIcons === 'function') globalThis.__cceRefreshTabIcons(); } catch (_) { /* next change */ }
  try { if (typeof globalThis.__cceSendSessionStates === 'function') globalThis.__cceSendSessionStates(); } catch (_) { /* next change */ }
  /*
   * Conversations pinned in the session list, kept from Claude Code's transcript cleanup (src/sessionpins.js). The
   * margin it keeps is days, so once every half hour is far more often than it needs; a pin gets a pass of its own a
   * few seconds later, so an old conversation pinned close to its age is not left waiting for the next one.
   */
  let keeping = false;
  const keepPinned = async () => {
    if (keeping || !pinsOn()) return;
    keeping = true;
    try {
      const file = pinsFile();
      const now = sessionPins.read(file);
      const r = await sessionPins.keep({ ids: new Set(now.pinned), times: now.times, days: sessionPins.retentionDays(), margin: pinMargin() });
      const changed = sessionPins.applyPass(file, r);
      if (r.touched || r.errors || r.gone.length) {
        log.appendLine(`pinned conversations: ${r.found} of ${r.pinned} found, ${r.touched} file(s) given a later `
          + `modification time to stay ahead of the transcript cleanup, ${r.gone.length} no longer on disk, ${r.errors} error(s)`);
      }
      if (changed) writeLiveNow();
    } catch (e) {
      log.appendLine('pinned conversations: ' + ((e && e.message) || e));
    } finally { keeping = false; }
  };
  let keepSoon = 0, toldStale = false;
  /*
   * Called by the patched host from inside its own message handling, so the work is put off rather than done there.
   *
   * A window whose copy of this extension has been installed again over itself still records the pin - keeping the files
   * and the exemption from the archive both read the record - but it leaves the shared stylesheet alone, and that is the
   * only way a pin reaches the panel. Without a word the pin would show as pinned for a few seconds and then go back, so
   * the first time this happens the reader is told why and offered the reload.
   */
  globalThis.__ccePinHook = (id, on) => {
    setTimeout(() => {
      try {
        if (!pinsOn()) return;
        if (!sessionPins.setPinned(pinsFile(), id, on)) return;
        log.appendLine(`pinned conversations: ${on ? 'pinned' : 'unpinned'} ${id}`);
        if (replaced() && !toldStale) {
          toldStale = true;
          offerReload('The pin is saved, but this window is running an earlier build of Claude Code Plus than '
            + 'the one now installed, so the session list here cannot show it. Reload the window to see it.');
        }
        writeLiveNow();
        if (on && !keepSoon) keepSoon = setTimeout(() => { keepSoon = 0; keepPinned(); }, 5000);
      } catch (e) { log.appendLine('pinned conversations: ' + ((e && e.message) || e)); }
    }, 0);
  };
  /* The patched host calls this from inside its own message handling, so it defers the work. */
  let toldColorStale = false;
  globalThis.__cceColorHook = (ids, name) => {
    setTimeout(() => {
      try {
        if (!colorsOn()) return;
        if (!sessionColors.setColor(colorsFile(), ids, name)) return;
        log.appendLine(`session colors: ${name || 'default'} for ${ids.length} conversation${ids.length === 1 ? '' : 's'}`);
        if (replaced() && !toldColorStale) {
          toldColorStale = true;
          offerReload('The color is saved, but this window is running an earlier build of Claude Code Plus than '
            + 'the one now installed, so the session list here cannot show it. Reload the window to see it.');
        }
        writeLiveNow();
      } catch (e) { log.appendLine('session colors: ' + ((e && e.message) || e)); }
    }, 0);
  };
  /* A pin or a color chosen in another window reaches this one's panels as soon as its file changes, rather than at the
     next periodic refresh, even when that window cannot write the stylesheet itself. The files are replaced rather than
     written in place, so the folder is what is watched. */
  let pinsWatch = null, pinsSettle = 0;
  try {
    const dir = context.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    pinsWatch = fs.watch(dir, { persistent: false }, (event, name) => {
      if (name && name !== sessionPins.FILE && name !== sessionColors.FILE) return;
      if (pinsSettle) clearTimeout(pinsSettle);
      pinsSettle = setTimeout(() => { pinsSettle = 0; if (pinsOn() || colorsOn()) writeLiveNow(); }, 300);
    });
    pinsWatch.on('error', () => { try { pinsWatch.close(); } catch (_) { /* closed */ } pinsWatch = null; });
  } catch (_) { /* the periodic refresh still carries a change across */ }
  /* Read by the patched host each time it builds the session list (src/bgsessions.js). */
  globalThis.__cceListedSessions = (entries, cwd) => {
    if (removed() || cfg().get(HIDE_BG_SETTING, true) === false) return entries;
    return bgSessions.withoutBackground(entries, cwd);
  };
  /* Read by the patched host each time it works out which conversations are in use and so not to be archived. */
  globalThis.__ccePinnedIds = () => {
    try { return pinsOn() ? sessionPins.read(pinsFile()).pinned : []; } catch (_) { return []; }
  };
  const keepFirst = setTimeout(keepPinned, 60000);
  const keepTimer = setInterval(keepPinned, 30 * 60000);
  context.subscriptions.push({ dispose: () => {
    clearTimeout(keepFirst); clearInterval(keepTimer); if (keepSoon) clearTimeout(keepSoon); if (pinsSettle) clearTimeout(pinsSettle);
    if (pinsWatch) { try { pinsWatch.close(); } catch (_) { /* closed */ } }
    if (globalThis.__ccePinHook) delete globalThis.__ccePinHook;
    if (globalThis.__cceColorHook) delete globalThis.__cceColorHook;
    if (globalThis.__cceListedSessions) delete globalThis.__cceListedSessions;
    if (globalThis.__ccePinnedIds) delete globalThis.__ccePinnedIds;
  } });
  /*
   * Claude Code tabs VS Code did not bring back (src/droppedtabs.js), looked for after Claude Code has started: by then
   * VS Code has put back the tabs it kept and Claude Code has matched them to their conversations. They open where Claude
   * Code opens a tab, and the tab that was in front is put back in front.
   *
   * A conversation still running in another window is not opened a second time. After a reload that window is often the
   * same window before it lost its connection: the dev desktop keeps its extension host, and the conversations running
   * in it, for five minutes once a new window connects, and then ends them. So such a tab is looked at again for a while,
   * and opened once its conversation is running nowhere.
   */
  const FOCUS_GROUP = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth']
    .map((n) => `workbench.action.focus${n}EditorGroup`);
  const DROPPED_WAIT_MS = 10 * 60000, DROPPED_RECHECK_MS = 15000;
  const isClaudeTab = (t) => t.input instanceof vscode.TabInputWebview && String(t.input.viewType).includes('claudeVSCodePanel');
  const claudeLabels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter(isClaudeTab).map((t) => t.label));
  const stripMark = (t) => tabdot.withoutMark(t);
  const reopenTabs = async (list, why) => {
    const group = vscode.window.tabGroups.activeTabGroup, front = group && group.activeTab;
    const at = front ? group.tabs.indexOf(front) : -1, column = group && group.viewColumn;
    let reopened = 0;
    for (const t of list) {
      try {
        await vscode.commands.executeCommand('claude-vscode.editor.open', t.sessionId, undefined, undefined, undefined, t.fullEditor,
          { programmatic: 'pin-to-panel' });
        reopened++;
      } catch (e) { log.appendLine(`reopening "${t.title}" (${t.sessionId}): ${e && e.message}`); }
    }
    log.appendLine(`Reopened ${reopened} Claude Code tab(s) VS Code did not restore${why}: ${list.map((t) => `"${t.title}"`).join(', ')}`);
    if (reopened) vscode.window.setStatusBarMessage(`Reopened ${reopened} Claude Code tab${reopened === 1 ? '' : 's'} VS Code did not restore`, 10000);
    if (at >= 0 && FOCUS_GROUP[column - 1]) {
      try {
        await vscode.commands.executeCommand(FOCUS_GROUP[column - 1]);
        await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', at);
      } catch (_) { /* the reopened tab stays in front */ }
    }
  };
  let droppedTries = 0, droppedTimer = setTimeout(function lookForDropped() {
    droppedTimer = undefined;
    const atStart = globalThis.__cceTabsAtStart, shown = globalThis.__cceSessionsShown;
    if (!Array.isArray(atStart) || typeof shown !== 'function') {
      if (++droppedTries < 45) droppedTimer = setTimeout(lookForDropped, 2000);
      return;
    }
    if (!enabled() || removed() || cfg().get(REOPEN_SETTING, true) === false) return;
    const elsewhere = () => { try { return typeof globalThis.__cceSessionsElsewhere === 'function' ? globalThis.__cceSessionsElsewhere() : []; } catch (_) { return []; } };
    let lost, waiting;
    try {
      ({ now: lost, later: waiting } = droppedTabs.split({ record: atStart, shown: shown(), elsewhere: elsewhere(), labels: claudeLabels(), strip: stripMark }));
    } catch (e) { log.appendLine('looking for Claude Code tabs VS Code did not restore: ' + (e && e.message)); return; }
    if (lost.length) reopenTabs(lost, '').catch(() => {});
    if (!waiting.length) return;
    log.appendLine(`Waiting to reopen ${waiting.length} Claude Code tab(s) VS Code did not restore, whose conversation is still running in `
      + `another window: ${waiting.map((t) => `"${t.title}"`).join(', ')}`);
    const until = Date.now() + DROPPED_WAIT_MS;
    droppedTimer = setTimeout(function recheck() {
      droppedTimer = undefined;
      let ready = [];
      try {
        ({ ready, waiting } = droppedTabs.settle({ waiting, shown: shown(), elsewhere: elsewhere(), labels: claudeLabels(), strip: stripMark }));
      } catch (_) { waiting = []; }
      if (ready.length) reopenTabs(ready, ' once its conversation stopped running elsewhere').catch(() => {});
      if (waiting.length && Date.now() < until) droppedTimer = setTimeout(recheck, DROPPED_RECHECK_MS);
      else if (waiting.length) log.appendLine(`Not reopened, still running in another window: ${waiting.map((t) => `"${t.title}"`).join(', ')}`);
    }, DROPPED_RECHECK_MS);
  }, 5000);
  context.subscriptions.push({ dispose: () => {
    if (droppedTimer) clearTimeout(droppedTimer);
    if (globalThis.__cceTabsAtStart) delete globalThis.__cceTabsAtStart;
    if (globalThis.__cceSessionsShown) delete globalThis.__cceSessionsShown;
    if (globalThis.__cceSessionsElsewhere) delete globalThis.__cceSessionsElsewhere;
  } });
  /*
   * Archived conversations deleted from disk, asked for from the Archived sessions menu (src/deletesession.js). Nothing
   * goes before the person accepts a confirmation that names each conversation and what of it is on disk. One that is
   * open in this window or running anywhere on this machine is left alone and named as such.
   *
   * Called by the patched host inside its own message handling, so the work is deferred, as the pin hook's is: finding
   * what is on disk walks every project folder.
   */
  globalThis.__cceDeleteHook = (asked) => {
    setTimeout(() => deleteArchived(asked).catch((e) => log.appendLine('deleting archived conversations: ' + (e && e.message))), 0);
  };
  const deleteArchived = async (asked) => {
    const seen = new Set(), want = [];
    for (const s of Array.isArray(asked) ? asked : []) {
      if (s && typeof s.id === 'string' && deleteSession.SESSION.test(s.id) && !seen.has(s.id)) {
        seen.add(s.id);
        want.push({ id: s.id, title: typeof s.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 120) : s.id });
      }
    }
    if (!want.length || !enabled() || removed()) return;
    /* Open conversations must never be deleted, so if their list cannot be read nothing is deleted; it is not treated
       as empty. */
    let shown;
    try { shown = typeof globalThis.__cceSessionsShown === 'function' ? globalThis.__cceSessionsShown() : null; } catch (_) { shown = null; }
    if (!Array.isArray(shown)) {
      vscode.window.showWarningMessage('Not deleted: this window could not tell which conversations are open, so none was deleted.');
      return;
    }
    const running = deleteSession.runningSessions();
    const busy = want.filter((w) => shown.includes(w.id) || running.has(w.id));
    const free = want.filter((w) => !busy.includes(w));
    const found = deleteSession.findAll(free.map((w) => w.id), {
      planDir: planDir(),
      extra: (id) => installs(webview, true).map((d) => path.join(d, 'webview', webview.EFFORT_PREFIX + id + '.css')),
    });
    const go = free.filter((w) => found.get(w.id).length).map((w) => ({ ...w, found: found.get(w.id) }));
    if (!go.length) {
      vscode.window.showInformationMessage(busy.length
        ? `Not deleted: ${busy.map((b) => `"${b.title}"`).join(', ')} ${busy.length === 1 ? 'is' : 'are'} open or running.`
        : 'Nothing of that conversation is left on disk.');
      return;
    }
    const lines = go.map((g) => `"${g.title}": ${deleteSession.describe(g.found)}`);
    if (busy.length) lines.push('', `Left alone, open or running: ${busy.map((b) => `"${b.title}"`).join(', ')}`);
    lines.push('', 'This cannot be undone.');
    const pick = await vscode.window.showWarningMessage(
      go.length === 1 ? `Delete "${go[0].title}" from disk?` : `Delete ${go.length} conversations from disk?`,
      { modal: true, detail: lines.join('\n') }, 'Delete');
    if (pick !== 'Delete') return;
    /* A conversation opened or resumed while the question was up is left alone, and so is everything when the list of
       open ones can no longer be read. */
    let shownNow;
    try { shownNow = typeof globalThis.__cceSessionsShown === 'function' ? globalThis.__cceSessionsShown() : null; } catch (_) { shownNow = null; }
    const runningNow = deleteSession.runningSessions();
    const late = go.filter((g) => !Array.isArray(shownNow) || shownNow.includes(g.id) || runningNow.has(g.id));
    if (late.length) {
      vscode.window.showWarningMessage(`Not deleted: ${late.map((g) => `"${g.title}"`).join(', ')} ${late.length === 1 ? 'was' : 'were'} opened or started meanwhile.`);
    }
    const failed = [];
    for (const g of go) {
      if (late.includes(g)) continue;
      failed.push(...deleteSession.remove(g.found));
      try { sessionPins.setPinned(pinsFile(), g.id, false); } catch (_) { /* not pinned */ }
      try { sessionColors.setColor(colorsFile(), [g.id], null); } catch (_) { /* not colored */ }
      log.appendLine(`Deleted "${g.title}" (${g.id}): ${deleteSession.describe(g.found)}`);
    }
    try { if (typeof globalThis.__cceSessionsChanged === 'function') globalThis.__cceSessionsChanged(); } catch (_) { /* the list catches up on its next read */ }
    if (failed.length) {
      log.appendLine('Could not delete:\n  ' + failed.join('\n  '));
      vscode.window.showWarningMessage(`${failed.length} file${failed.length === 1 ? '' : 's'} could not be deleted; the output "Claude Code Plus" lists them.`);
    }
  };
  context.subscriptions.push({ dispose: () => {
    if (globalThis.__cceDeleteHook) delete globalThis.__cceDeleteHook;
    if (globalThis.__cceSessionsChanged) delete globalThis.__cceSessionsChanged;
  } });
  /*
   * The tabs closed in this workspace, kept across reloads for Recently closed above OPEN SESSIONS
   * (src/recentclosed.js). The patched host reports each tab the person closes and asks for the list each time it tells
   * the panels which conversations are open, so a closing shows at once.
   */
  let recentList = context.workspaceState.get(recentClosed.KEY, []);
  globalThis.__cceClosedHook = (id) => {
    try {
      recentList = recentClosed.record(recentList, id);
      Promise.resolve(context.workspaceState.update(recentClosed.KEY, recentList)).catch(() => {});
    } catch (_) { /* the list stays as it was */ }
  };
  globalThis.__cceRecentClosed = () => recentClosed.pageData(recentList, enabled() && !removed() ? cfg().get(RECENT_SETTING, 10) : 0);
  context.subscriptions.push({ dispose: () => {
    if (globalThis.__cceClosedHook) delete globalThis.__cceClosedHook;
    if (globalThis.__cceRecentClosed) delete globalThis.__cceRecentClosed;
    if (globalThis.__cceSendSessionStates) delete globalThis.__cceSendSessionStates;
  } });
  claude.followChat();
  sweepPlans().catch((e) => log.appendLine('orphan work plans: ' + e.message));
  watchEffort();

  /*
   * The plugin that writes the plans travels inside this extension, so the only thing left is to register it with
   * Claude Code. That is done once and then recorded, and it is deliberately not awaited: activation must not sit and
   * wait on a 241 MB binary, and the outcome shows up above the plan either way.
   *
   * Skipped entirely for someone who asked this extension to leave Claude Code alone - that request is about all of it,
   * not only the patched files.
   */
  /*
   * Shown instead of the plan when no Python 3 runs; the plugin is then staged without its hooks and skill. On Windows,
   * clicking the row offers to download Python from python.org into the folder Agent Plus and its extensions share
   * (src/python-runtime.js); a downloaded python.exe comes after the ones on PATH, then one an earlier version of this
   * extension downloaded into its own storage.
   */
  const storage = context.globalStorageUri.fsPath;
  const pythons = () => pythonRuntime.pythons(storage);
  const noPython = () => pythonOffer.notice(pythons(), {
    download: PREFIX + 'downloadPython', install: PREFIX + 'installWorkPlanPlugin',
    without: 'Until this succeeds nothing writes a work plan, so the plan stays empty.',
  });
  const showProblem = (problem) => claude.setNotice(problem ? {
    title: 'The plugin that writes work plans is not installed',
    description: 'click to try again',
    detail: `${problem.step} failed. ${problem.said || 'It gave no reason.'} Until this succeeds nothing writes a work plan, `
      + 'so the plan stays empty.',
    command: PREFIX + 'installWorkPlanPlugin',
    arguments: [],
  } : null);
  /* One download at a time in this window; a second request while one runs waits for it. */
  const getPython = pythonOffer.single(() => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Downloading Python ${pythonRuntime.VERSION} from python.org` },
    async () => {
      const r = await pythonRuntime.download(undefined, { userAgent: 'claude-code-plus' });
      log.appendLine('python download: ' + r.said);
      if (!r.ok) {
        vscode.window.showErrorMessage('Claude Code Plus: downloading Python failed. ' + r.said);
        return false;
      }
      await syncPlugin(true);
      vscode.window.showInformationMessage('Claude Code Plus: Python is installed. Start a new conversation to get a work plan.');
      return true;
    }));
  /* Once per Python version on this machine, by whichever extension and window asks first. After "Not now" the row above
     the plan is the way to get it. */
  const offerPython = () => pythonOffer.offer({
    ask: (message, ...buttons) => vscode.window.showInformationMessage(message, ...buttons), get: getPython });
  const syncPlugin = async (retry) => {
    if (removed()) return;
    const state = context.globalState.get(PLUGIN_KEY, {});
    const from = path.join(context.extensionPath, 'claude-plugin');
    /* What is compared is the plugin's own contents, not this extension's version: the version changes when a release is
       cut, so a plugin file that changed without one was staged once and never again, and the registered plugin kept
       running the older file. Nothing said so, because the state recorded agreed with itself. */
    /* The staged copy is fitted to the Python found here (pluginInstall.fitHooks), so which one it was is part of what
       is compared: installing Python, or a different one, stages the copy again. */
    const python = await pluginInstall.findPython(undefined, pythons());
    /* Trying each Python candidate can take seconds, and Remove may have been pressed meanwhile. */
    if (removed() || uninstalling() || replaced()) return;
    const stamp = pluginInstall.digest(from) + '|' + (python ? python.launcher.join(' ') + '|' + python.executable : 'none');
    const to = path.join(context.globalStorageUri.fsPath, 'claude-plugin');
    /* The memory of having registered is kept by the editor and outlives an uninstall of this extension, while the
       uninstall unregisters the plugin and its marketplace together. Both missing from Claude Code's own records is
       that, and then the plugin is registered again; the plugin alone missing is somebody's deliberate removal, and is
       left alone (see registrationGone). */
    const undone = state.registered === true && pluginInstall.registrationGone();
    const registered = state.registered === true && !undone;
    /* The registration points at the copy in this extension's global storage, and the editor deletes that folder along
       with an uninstalled extension, so the registration can outlive the files it names. Check the copy's digest, not
       just that it exists: a partly written copy, or one another window is replacing, exists but is not this plugin. */
    const staged = !!state.staged && pluginInstall.digest(to) === state.staged;
    if (!retry && registered && state.stamp === stamp && staged) return;
    if (undone) log.appendLine('work plan plugin: registering again - Claude Code lists neither it nor its marketplace, which is what uninstalling this extension leaves');
    // A registered plugin on a new version of this extension needs its files refreshed, not registering again: the
    // path stays where it is, and re-running the install is what would undo a deliberate uninstall.
    const refreshOnly = !retry && registered;
    const dirs = claudeFolders();
    const claudeBin = pluginInstall.findClaude(dirs);
    if (!claudeBin && !refreshOnly) {
      const problem = { step: 'finding Claude Code\'s own command line', said: 'Looked for ' + pluginInstall.BINARY + ' in ' + (dirs.length || 'no') + ' install(s) of Claude Code.' };
      showProblem(problem);
      log.appendLine('work plan plugin: ' + problem.step + ': ' + problem.said);
      return;
    }
    const result = await pluginInstall.install({ claudeBin, from, to, refreshOnly, python });
    log.appendLine('work plan plugin: ' + (result.ok ? result.said : result.step + ' failed: ' + result.said));
    if (python) log.appendLine(`work plan plugin: hooks run with ${python.launcher.join(' ')} (Python ${python.version}, ${python.executable})`);
    if (result.ok) {
      await context.globalState.update(PLUGIN_KEY, { registered: true, stamp, staged: pluginInstall.digest(to), error: '' });
      if (python) showProblem(null);
      else {
        const notice = noPython();
        claude.setNotice(notice);
        log.appendLine('work plan plugin: ' + notice.detail);
        offerPython().catch((e) => log.appendLine('python offer: ' + e.message));
      }
      return undone;
    } else {
      await context.globalState.update(PLUGIN_KEY,
        { registered, stamp: state.stamp, error: result.step + ': ' + result.said });
      showProblem(result);
    }
  };
  /*
   * The plans an uninstall copied aside (restoreRescued in src/carryover.js) are copied back once the plugin is
   * registered again. A rescue folder written too recently is read again later. `unregistered` is what syncPlugin
   * returns: true when it registered the plugin again because the plugin and its marketplace were both gone. By then
   * the plan directory has already been emptied, so no folder needs to wait.
   */
  let rescueTimer = 0;
  const restorePlans = (unregistered) => {
    if (removed() || closing || context.globalState.get(PLUGIN_KEY, {}).registered !== true || !pluginInstall.listed()) return;
    let r;
    try { r = carryover.restoreRescued({ planDir: planDir(), settleMs: unregistered === true ? 0 : undefined }); }
    catch (e) { log.appendLine('copying rescued work plans back: ' + e.message); return; }
    if (r.copied.length) log.appendLine(`work plans copied back from a rescue folder: ${r.copied.length}`);
    if (r.waitMs && !rescueTimer) rescueTimer = setTimeout(() => { rescueTimer = 0; restorePlans(); }, r.waitMs + 1000);
  };
  context.subscriptions.push({ dispose: () => { if (rescueTimer) clearTimeout(rescueTimer); } });
  syncPlugin(false).then(restorePlans, (e) => log.appendLine('work plan plugin: ' + ((e && e.message) || e)));
  /*
   * The old extension's uninstall hook takes the patch out of Claude Code and unregisters the plugin, and the editor
   * runs it at its next start, when it deletes that extension's folder, which can happen after this extension is
   * running. When Claude Code lists neither the plugin nor its marketplace although this extension registered them,
   * that is what happened (see registrationGone): the patch and the plugin are put back and the plans copied back,
   * without waiting for the next start.
   */
  let recovering = false;
  const recover = () => {
    if (recovering || removed() || closing || uninstalling() || replaced()) return;
    if (context.globalState.get(PLUGIN_KEY, {}).registered !== true || !pluginInstall.registrationGone()) return;
    recovering = true;
    log.appendLine('work plan plugin: unregistered while this window was running; checking the patch and registering it again');
    Promise.resolve().then(() => sync()).then(() => syncPlugin(false)).then(restorePlans)
      .catch((e) => log.appendLine('putting the patch and the plugin back: ' + ((e && e.message) || e)))
      .finally(() => { recovering = false; });
  };

  /*
   * A single 30-second timer has the next list of conversations run `claude agents` again and sweeps abandoned plans,
   * and, while the additions are on and this window runs the installed build, re-checks the transcript, the live
   * stylesheet and the log. Task files are written by another process, so nothing else would notice them change. Only the live settings are rewritten, and the page's revision moves only when their
   * content changes. While the additions are off the transcript is not watched.
   */
  const tick = setInterval(() => {
    claude.invalidate();
    sweepPlans().catch((e) => log.appendLine('orphan work plans: ' + e.message));
    recover();
    if (removed() || !enabled() || uninstalling() || replaced()) { unwatchEffort(); return; }
    scanBackground();
    scanEffort();
    watchEffort();
    writeLiveNow();
    sampleLatency();
  }, REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });
  context.subscriptions.push(
    registerCommand('installWorkPlanPlugin', () => syncPlugin(true).then(restorePlans)),
    registerCommand('downloadPython', async () => {
      const pick = await vscode.window.showInformationMessage(
        `Download Python ${pythonRuntime.VERSION} from python.org?`,
        { modal: true, detail: `11 MB, saved in ${pythonRuntime.home()}.` },
        'Download');
      if (pick === 'Download') await getPython();
    }),
  );

  /*
   * Settings listener. The cached settings are dropped first, so the code below sees the new values. A setting that
   * only affects what the panel shows is applied through the live stylesheet alone; the patched bundles are not
   * checked, since that reads ten megabytes and these settings cannot change them.
   */
  const LIVE_SETTINGS = [SETTING, COLOR_SETTING, EDGE_SETTING, PINS_SETTING, PIN_MARGIN_SETTING]
    .concat(webview.SWITCHES.map((k) => PREFIX + 'show.' + k));
  const listAgain = () => { claude.invalidate(); claude.changed(); };
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(listAgain));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    settings = null;
    if (Object.values(HOOK_SETTINGS).some((k) => e.affectsConfiguration(k))) writeHookSettings();
    if (e.affectsConfiguration(LATENCY_ON_SETTING)) loadWatchOff();
    /* A wider margin moves pinned files forward on the next pass, so that pass is not left waiting half an hour. */
    if (e.affectsConfiguration(PIN_MARGIN_SETTING) && !keepSoon) keepSoon = setTimeout(() => { keepSoon = 0; keepPinned(); }, 5000);
    if (e.affectsConfiguration(RECENT_SETTING) || e.affectsConfiguration(SETTING)) {
      try { if (typeof globalThis.__cceSendSessionStates === 'function') globalThis.__cceSendSessionStates(); } catch (_) { /* next update */ }
    }
    if (e.affectsConfiguration(WORK_PLAN_SETTING)) listAgain();
    else if (e.affectsConfiguration(BRIEF_SETTING)) claude.changed();
    if (e.affectsConfiguration(HIDE_BG_SETTING)) {
      try { if (typeof globalThis.__cceSessionsChanged === 'function') globalThis.__cceSessionsChanged(); } catch (_) { /* the list catches up on its next read */ }
    }
    if (!LIVE_SETTINGS.some((k) => e.affectsConfiguration(k))) return;
    const c = cfg().get(COLOR_SETTING, '');
    if (c && !safeColor(c)) vscode.window.showWarningMessage(`Claude Code Plus: "${c}" is not a CSS color (use e.g. #90EE90, lightgreen or rgb(144,238,144)); your message color is left unchanged.`);
    /* A switch has to reach the panel the moment it is flipped, which is what writing the stylesheet does. */
    writeLiveNow();
  }));

  return sync().then(() => { if (handing && !reloadOffered) offerUninstallOld(context); });
}

/*
 * Runs on every reload and every window that closes, and acts only on an uninstall: then it puts Claude Code back at
 * once, rather than leaving the patched files in place until the editor deletes this folder (see src/removal.js).
 *
 * Synchronous and without the editor's API, both for the same reason: the host is shutting down. It gives deactivate five
 * seconds, and restoring takes well under one; unregistering the companion plugin can take longer, so that part is
 * handed to a process that outlives the host.
 */
function deactivate() {
  if (!selfPath || !removal.beingUninstalled(selfPath, ID)) return;
  /* An earlier version of the old extension in this folder still uses the patch and the plugin. */
  if (removal.earlierCopies(path.dirname(selfPath)).length) return;
  /* Only the Claude Code installs in this editor's extensions folder. Another editor on this machine can have this
     extension installed and running, and restoring its folder would take the patch out from under it; the uninstall
     hook, which runs when this folder is deleted, is what looks in every editor's folder. */
  try { removal.restoreAll([path.dirname(selfPath)]); } catch (_) { /* the editor's own hook runs later */ }
  try { removal.finishLater(selfPath); } catch (_) { /* likewise */ }
}

module.exports = { activate, deactivate, renameSettings };
