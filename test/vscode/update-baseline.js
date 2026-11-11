// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Usage: node test/vscode/update-baseline.js <results folder> [<platform>] [--only <name>[,<name>]]
 *
 * Copies <results folder>/actual/<platform>/*.png over test/vscode/baseline/<platform>/, the approved copies. The results folder is run.js's --out, or a CI run's vscode-Linux, vscode-macOS or
 * vscode-Windows artifact, downloaded and unpacked. <platform> is linux, darwin or win32, by default every one the
 * folder has.
 *
 * The person who merges into main approves the new copies: before running this they look at each crop it will copy,
 * and at diff/<platform>/ of the same run for the ones that failed, and then commits the new copies on their own,
 * saying what changed in the drawing and why.
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./lib/baseline');

const args = process.argv.slice(2);
const at = args.indexOf('--only');
const only = at >= 0 ? args.splice(at, 2)[1].split(',') : null;
const [from, platform] = args;
if (!from) { console.error('usage: node test/vscode/update-baseline.js <results folder> [<platform>] [--only <name>[,<name>]]'); process.exit(2); }
const actual = path.join(path.resolve(from), 'actual');
if (!fs.existsSync(actual)) { console.error(`no actual/ folder in ${from}: give the --out folder of run.js, or an unpacked artifact`); process.exit(2); }
const platforms = platform ? [platform] : fs.readdirSync(actual);
let copied = 0;
for (const p of platforms) {
  const dir = path.join(actual, p);
  if (!fs.existsSync(dir)) { console.error(`no crops for ${p} in ${actual}`); process.exitCode = 2; continue; }
  const to = path.join(ROOT, p);
  fs.mkdirSync(to, { recursive: true });
  for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.png')).sort()) {
    if (only && !only.includes(n.replace(/\.png$/, ''))) continue;
    const target = path.join(to, n);
    const bytes = fs.readFileSync(path.join(dir, n));
    const was = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (was && was.equals(bytes)) { console.log(`  same     ${p}/${n}`); continue; }
    fs.writeFileSync(target, bytes);
    copied++;
    console.log(`  ${was ? 'replaced' : 'added   '} ${p}/${n}`);
  }
}
const shown = path.relative(process.cwd(), ROOT);
console.log(`${copied} approved cop${copied === 1 ? 'y' : 'ies'} written under ${shown && !shown.startsWith('..') ? shown : ROOT}`);
