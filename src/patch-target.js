// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/host/patch-target.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * Builds status(), apply() and restore() for one patched file in the agent's extension, each taking the folder the
 * agent is installed in. The caller gives the marks, the backup suffix, a pure transform and the hooks below; the steps
 * are the same for every target:
 *
 *   status    'missing', 'patched' (this version's mark), 'outdated' (another version's) or 'clean'
 *   apply     an outdated file is patched again from its backup, which must not carry a mark itself; a clean file has
 *             its backup written first, through a temporary file, because a backup cut short would be put back over the
 *             agent's file by the next restore. If a restore in another window moved the backup over the file since it
 *             was read, the backup is written again from the original that was patched.
 *   restore   the backup must carry no mark and pass the target's check before it is moved over the file in one step
 *
 * Callers keep their marks and backup suffix the same from one version to the next, so that every version of the
 * extension recognises a patch another version wrote.
 */
const fs = require('fs');
const { writeAtomic, moveBack } = require('./files');

/**
 * spec:
 *   file(dir)                 the patched file
 *   mark                      this version's mark, or a function returning it
 *   anyMark                   what every version's mark starts with
 *   backupSuffix              appended to the file's name for its backup
 *   tmpTag, tries             passed to writeAtomic for every write (src/files.js)
 *   transform(original)       { out, chosen } or { error }; never writes
 *   usableBackup(text)        whether a backup can stand for the agent's file
 *   ready(dir)                for 'patched', anything besides the mark that has to be there
 *   beforeWrite(dir)          runs after the backup is written and before the patched file
 *   beforeRestore(dir), afterRestore(dir, result)
 *   say                       the messages, each with a default: missing, noBackup, markedBackup, badBackup
 */
function patchTarget(spec) {
  const mark = typeof spec.mark === 'function' ? spec.mark : () => spec.mark;
  const write = (file, text) => writeAtomic(file, text, undefined, { tag: spec.tmpTag || '', tries: spec.tries || 1 });
  const say = {
    missing: (file) => `not found at ${file}`,
    noBackup: 'an older patch is present but its backup is missing',
    markedBackup: 'an older patch is present and its backup carries one too',
    badBackup: 'backup is unusable; not restored',
    ...spec.say,
  };
  const at = (text, file) => (typeof text === 'function' ? text(file) : text);

  function status(dir) {
    const file = spec.file(dir);
    if (!fs.existsSync(file)) return 'missing';
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(mark()) && (!spec.ready || spec.ready(dir))) return 'patched';
    if (text.includes(spec.anyMark)) return 'outdated';
    return 'clean';
  }

  /** Returns { changed, current, message }; `current` means the file carries this version's patch. */
  function apply(dir) {
    const file = spec.file(dir);
    const backup = file + spec.backupSuffix;
    const state = status(dir);
    const no = (message) => ({ changed: false, current: false, message });
    if (state === 'missing') return no(at(say.missing, file));
    if (state === 'patched') return { changed: false, current: true, message: 'already patched' };
    let original;
    if (state === 'outdated') {
      if (!fs.existsSync(backup)) return no(say.noBackup);
      original = fs.readFileSync(backup, 'utf8');
      if (original.includes(spec.anyMark)) return no(say.markedBackup);
    } else {
      original = fs.readFileSync(file, 'utf8');
    }
    const r = spec.transform(original);
    if (r.error) return no(r.error);
    if (state === 'clean') write(backup, original);
    if (spec.beforeWrite) spec.beforeWrite(dir);
    write(file, r.out);
    if (!fs.existsSync(backup)) write(backup, original);
    return { changed: true, current: true, message: 'patched' };
  }

  /** Puts the original back and removes the backup. Returns { changed, message }. */
  function restore(dir) {
    if (spec.beforeRestore) spec.beforeRestore(dir);
    const file = spec.file(dir);
    const backup = file + spec.backupSuffix;
    if (!fs.existsSync(backup)) return { changed: false, message: 'nothing to restore' };
    const original = fs.readFileSync(backup, 'utf8');
    if (original.includes(spec.anyMark)) return { changed: false, message: 'backup is itself patched; not restored' };
    if (!spec.usableBackup(original)) return { changed: false, message: say.badBackup };
    const r = moveBack(backup, file);
    if (spec.afterRestore) spec.afterRestore(dir, r);
    return r;
  }

  return { status, apply, restore, mark };
}

/*
 * Applies every target in order and returns [name, result] pairs. With allOrNothing, one target that does not end up
 * patched has every target restored: Codex's page patch posts to nothing without its host patch. Claude Code's two
 * targets stand alone, each with its own mark and backup.
 */
function applyAll(targets, dir, { allOrNothing = false } = {}) {
  const results = [];
  for (const t of targets) {
    try { results.push([t.name, t.apply(dir)]); } catch (e) { results.push([t.name, { changed: false, current: false, message: e.message }]); }
  }
  if (allOrNothing && results.some(([, r]) => !r.current)) {
    for (const t of targets) { try { t.restore(dir); } catch (_) { /* nothing to restore */ } }
  }
  return results;
}

module.exports = { patchTarget, applyAll };
