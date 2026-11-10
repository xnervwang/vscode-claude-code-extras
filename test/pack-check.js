// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/test/pack-check.js, copied by sync-shared.js; edit it there, not in a copy.

'use strict';
/*
 * Runs build/pack-vsix.js on the paths build/pack.sh lists and compares the result with what vsce would publish.
 * Every tracked file that vsce would publish must be in the local package, and no image the README links may be in
 * either. The descriptor files must give every file extension a content type and name the license.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const pack = require('../build/pack-vsix.js');
const manifest = require('../build/make-manifest.js');

module.exports = async ({ ok, bad, eq, note, tmp }, root) => {
  const paths = pack.listedIn(root);
  if (!paths.length) { bad('build/pack.sh does not run pack-vsix.js with a list of paths'); return; }
  const stage = tmp('pack-stage');
  try { pack.stage(root, stage, paths); manifest.write(stage); } catch (e) { bad(`the package could not be staged: ${e.message}`); return; }
  const staged = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else staged.push(path.relative(path.join(stage, 'extension'), path.join(d, e.name)).split(path.sep).join('/')); } };
  walk(path.join(stage, 'extension'));

  const types = fs.readFileSync(path.join(stage, '[Content_Types].xml'), 'utf8');
  const listed = new Set([...types.matchAll(/Extension="([^"]+)"/g)].map((x) => x[1]));
  eq([...new Set(staged.map((f) => path.extname(f).toLowerCase()))].filter((x) => !listed.has(x)), [],
    'every file extension in the package has a content type in [Content_Types].xml');
  const vsix = fs.readFileSync(path.join(stage, 'extension.vsixmanifest'), 'utf8');
  eq([/Content\.License" Path="extension\/LICENSE\.txt"/.test(vsix), staged.includes('LICENSE.txt')], [true, true],
    'and the manifest names LICENSE.txt, which the package holds, as the license');
  eq(staged.filter((f) => f.split('/').includes('__pycache__')), [], 'and it holds no __pycache__ folder');

  const rules = pack.ignoreRules(root);
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const shots = [...readme.matchAll(/\]\((images\/[^)\s]+)\)/g)].map((x) => x[1]);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  eq(shots.filter((f) => !pack.ignored(rules, f) || staged.includes(f)), [],
    'the images the README links are left out by .vscodeignore and out of the local package');
  if (pkg.icon) eq([pack.ignored(rules, pkg.icon), staged.includes(pkg.icon)], [false, true], 'while the icon ships');

  const git = cp.spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
  if (git.status !== 0) { note('not a git checkout: the package was not compared with what vsce would publish'); return; }
  const under = (f) => paths.some((p) => f === p || f.startsWith(p.replace(/\/+$/, '') + '/'));
  const vsceOnly = [];
  for (const f of git.stdout.split('\0').filter(Boolean)) {
    if (f === 'LICENSE' || f === '.vscodeignore' || pack.ignored(rules, f)) continue;
    if (!under(f)) vsceOnly.push(f);
    else if (!staged.includes(f)) bad(`${f} should be in the local package`);
  }
  eq(vsceOnly, [], 'each file the repository tracks that vsce would publish is in the local package too (a path missing from build/pack.sh or from .vscodeignore shows here)');
};
