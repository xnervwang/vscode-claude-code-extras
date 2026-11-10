// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/build/pack-vsix.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * Builds build/<publisher>.<name>-<version>.vsix without npm. A .vsix is a zip holding the extension under extension/
 * plus two descriptor files; vsce adds nothing else that VS Code requires for a local install.
 *
 *   node pack-vsix.js <repository> <path>...
 *
 * The paths are files and folders of the repository. Files under them that its .vscodeignore excludes, by vsce's
 * rules, are skipped, so a local package has the same files as a published one.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const manifest = require('./make-manifest.js');

/** A .vscodeignore pattern as a regular expression over a forward-slash path relative to the repository. */
function globRe(glob) {
  if (/[{}]/.test(glob)) throw new Error(`.vscodeignore: braces are not understood here: ${glob}`);
  const segs = glob.split('/');
  let re = '';
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === '**') { re += last ? '.*' : '(?:[^/]*/)*'; return; }
    re += seg.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    if (!last) re += '/';
  });
  return new RegExp('^' + re + '$');
}

/*
 * vsce's rules: blank lines and lines starting with # are dropped, a pattern whose last part has no * also matches a
 * folder of that name, and a line starting with ! re-includes what another line excluded. package.json and README.md
 * are never excluded.
 */
function ignoreRules(root) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8'); } catch (_) { /* nothing left out */ }
  const lines = text.split(/[\n\r]/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const all = [...lines, ...lines.filter((l) => !/(^|\/)[^/]*\*[^/]*$/.test(l)).map((l) => (l.endsWith('/') ? l + '**' : l + '/**'))];
  const rules = { ignore: [], negate: [] };
  for (const l of all) {
    if (l.startsWith('!')) rules.negate.push(globRe(l.slice(1)));
    else rules.ignore.push(globRe(l));
  }
  return rules;
}

const ALWAYS = new Set(['package.json', 'README.md']);
const ignored = (rules, rel) => !ALWAYS.has(rel) && rules.ignore.some((r) => r.test(rel)) && !rules.negate.some((r) => r.test(rel));

/*
 * Copies the paths into <dir>/extension. Python's __pycache__ folders are skipped; running the plugin's hooks locally
 * leaves them in the tree. LICENSE goes in as LICENSE.txt, because the marketplace finds a package part by its file
 * extension.
 */
function stage(root, dir, paths) {
  const rules = ignoreRules(root);
  const into = path.join(dir, 'extension');
  fs.mkdirSync(into, { recursive: true });
  const copy = (rel) => {
    const from = path.join(root, rel);
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      if (path.basename(rel) === '__pycache__') return;
      for (const name of fs.readdirSync(from).sort()) copy(rel + '/' + name);
    } else if (!ignored(rules, rel)) {
      fs.mkdirSync(path.dirname(path.join(into, rel)), { recursive: true });
      fs.copyFileSync(from, path.join(into, rel));
    }
  };
  for (const p of paths) {
    const rel = p.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!fs.existsSync(path.join(root, rel))) throw new Error(`no ${rel} in ${root}`);
    copy(rel);
  }
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(into, 'LICENSE.txt'));
}

/** The paths a repository's build/pack.sh hands to this script, read from the line that runs it. */
function listedIn(root) {
  const m = fs.readFileSync(path.join(root, 'build', 'pack.sh'), 'utf8').match(/pack-vsix\.js" "\$root" (.+)$/m);
  return m ? m[1].trim().split(/\s+/) : [];
}

module.exports = { globRe, ignoreRules, ignored, stage, listedIn };

if (require.main === module) {
  const [root, ...paths] = process.argv.slice(2).map((a, i) => (i ? a : path.resolve(a)));
  if (!root || !paths.length) { console.error('usage: node pack-vsix.js <repository> <path>...'); process.exit(2); }
  const check = cp.spawnSync(process.execPath, [path.join(root, 'test', 'check.js')], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (check.status !== 0) { console.error('pack.sh: test/check.js failed; run it to see why'); process.exit(1); }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = path.join(root, 'build', `${pkg.publisher}.${pkg.name}-${pkg.version}.vsix`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-vsix-'));
  let status = 1;
  try {
    stage(root, dir, paths);
    manifest.write(dir);
    fs.rmSync(out, { force: true });
    const zip = cp.spawnSync('zip', ['-q', '-r', '-X', out, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { cwd: dir, stdio: 'inherit' });
    if (zip.status === 0) { console.log(out); status = 0; } else console.error('pack.sh: zip failed');
  } catch (e) {
    console.error(`pack.sh: ${e.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(status);
}
