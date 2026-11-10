// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/host/hook-settings.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * The two files the work plan plugin's hooks read from the plugin's data directory, since they run as processes of
 * their own and cannot ask the editor: config.json (settings, read by plan_path.py) and client-time-zone.json (the
 * reader's zone, read by tell-time-zone.py). Every window writes them from the same settings, so a write is skipped
 * when the file already has the same content, and a changed file is replaced atomically because a hook can read it at
 * any moment. Both return whether they wrote.
 */
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./files');

function writeIfChanged(file, text) {
  try { if (fs.readFileSync(file, 'utf8') === text) return false; } catch (_) { /* not there yet */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, text);
  return true;
}

/*
 * `values` holds only keys the hooks know. `marker` is this editor's global storage directory for the extension. Each
 * editor that shares the data directory adds its own to extensionMarkers, and markers whose directory is gone are
 * dropped. VS Code deletes that directory when the extension is uninstalled from that editor, not on an update; when
 * every listed directory is gone, plan_path.py treats the extension as uninstalled everywhere.
 */
function writeHookSettings(dir, values, { marker = '' } = {}) {
  const file = path.join(dir, 'config.json');
  const out = { ...values };
  if (marker) {
    fs.mkdirSync(marker, { recursive: true });
    let before = [];
    try { const v = JSON.parse(fs.readFileSync(file, 'utf8')).extensionMarkers; if (Array.isArray(v)) before = v; } catch (_) { /* none yet */ }
    out.extensionMarkers = before.filter((d) => typeof d === 'string' && path.isAbsolute(d) && d !== marker && fs.existsSync(d))
      .concat(marker);
  }
  return writeIfChanged(file, JSON.stringify(out, null, 2) + '\n');
}

/* Nothing is written for an empty zone: a window that has not heard from a page yet leaves the last one in place. */
function writeClientZone(dir, zone) {
  if (!zone) return false;
  return writeIfChanged(path.join(dir, 'client-time-zone.json'), JSON.stringify({ timeZone: zone }) + '\n');
}

module.exports = { writeIfChanged, writeHookSettings, writeClientZone };
