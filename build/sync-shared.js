// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/build/sync-shared.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * Code shared by Claude Code Plus and Codex Plus lives in Agent Plus's shared/ folder, and each extension ships a copy
 * at the path it requires it from. shared.json at the repository root lists each copy (path, source path, sha256) and
 * the Agent Plus commit of the last sync. An entry with a `fill` is generated instead of copied: the file at `from` is a
 * template, and every line that is exactly {{name}} is replaced by the block of that name in the fill, another file in
 * Agent Plus. A block runs from its "=== name" line to the blank line before the next one.
 *
 *   node build/sync-shared.js           copy every listed file from Agent Plus and rewrite shared.json
 *   node build/sync-shared.js --check   compare only; exit 1 if a copy is not what shared.json records
 *
 * Agent Plus is read from AGENT_WORK_PLAN_DIR, or from vscode-agent-plus beside this repository. When it is there, the
 * command runs Agent Plus's own copy of this script rather than this one, so a copy left by an earlier sync never
 * applies rules the source has since changed.
 */
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST = 'shared.json';
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const coreDir = (root) => process.env.AGENT_WORK_PLAN_DIR || path.join(root, '..', 'vscode-agent-plus');
const readManifest = (root) => JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
/** The line every shared file carries, naming its source; a copy is byte for byte the source, so it carries it too. */
const sourceLine = (from) => `Source: vscode-agent-plus ${from}; sync-shared.js copies it, so edit it there.`;
/* Whether `text` names `from` as its source. Only the start of the line counts, so a file still carrying the line in an
   earlier wording is recognised. */
const namesSource = (text, from) => new RegExp(`Source: vscode-agent-plus ${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[;,]`).test(text);

function writeAtomic(file, data, mode) {
  const tmp = `${file}.${process.pid}.sync`;
  try {
    fs.writeFileSync(tmp, data, mode == null ? undefined : { mode });
    if (mode != null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    throw e;
  }
}

/** The text of a made file: `template` with each {{name}} line replaced by the lines of that block of `fill`. */
function render(template, fill) {
  const blocks = new Map();
  let name = null, lines = [];
  const close = () => { if (name !== null) { if (lines[lines.length - 1] === '') lines.pop(); blocks.set(name, lines); } };
  for (const line of fill.split('\n')) {
    const m = /^=== ([\w-]+)$/.exec(line);
    if (m) { close(); name = m[1]; lines = []; } else if (name !== null) lines.push(line);
  }
  close();
  const used = new Set();
  const out = template.split('\n').flatMap((line) => {
    const m = /^\{\{([\w-]+)\}\}$/.exec(line);
    if (!m) return [line];
    if (!blocks.has(m[1])) throw new Error(`the fill has no block named ${m[1]}`);
    used.add(m[1]);
    return blocks.get(m[1]);
  });
  const unused = [...blocks.keys()].filter((k) => !used.has(k));
  if (unused.length) throw new Error(`the template has no line for ${unused.join(', ')}`);
  return out.join('\n');
}

/** The content an entry's copy should have, from the Agent Plus checkout at `core`. */
const made = (core, f) => (f.fill
  ? Buffer.from(render(fs.readFileSync(path.join(core, f.from), 'utf8'), fs.readFileSync(path.join(core, f.fill), 'utf8')))
  : fs.readFileSync(path.join(core, f.from)));
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Copies that differ from the hash shared.json records for them, or are missing. */
function checkCopies(root) {
  const off = [];
  for (const f of readManifest(root).files) {
    const file = path.join(root, f.path);
    if (!fs.existsSync(file)) off.push(`${f.path} is missing`);
    else if (sha256(file) !== f.sha256) off.push(`${f.path} was changed here; change ${f.from} in Agent Plus and sync`);
  }
  return off;
}

/** Sources in the Agent Plus checkout that are no longer what was last copied from them. */
function checkCore(root, core) {
  const ahead = [];
  for (const f of readManifest(root).files) {
    const gone = [f.from, f.fill].filter((x) => x && !fs.existsSync(path.join(core, x)));
    if (gone.length) ahead.push(`${gone.join(' and ')} ${gone.length > 1 ? 'are' : 'is'} gone from Agent Plus`);
    else if (hash(made(core, f)) !== f.sha256) ahead.push(`${f.fill ? `${f.from} with ${f.fill}` : f.from} has changed in Agent Plus`);
  }
  return ahead;
}

/** The commit the checkout is at, marked when the shared/ folder has changes not committed yet. */
function coreCommit(core) {
  const git = (...args) => cp.spawnSync('git', ['-C', core, ...args], { encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD');
  if (head.status !== 0) return 'unknown';
  const dirty = git('status', '--porcelain', '--', 'shared').stdout.trim();
  return head.stdout.trim() + (dirty ? '-dirty' : '');
}

/** Copies every listed file from `core` into `root` and rewrites shared.json; returns the paths whose content changed. */
function sync(root, core) {
  const m = readManifest(root);
  const changed = [];
  for (const f of m.files) {
    const from = path.join(core, f.from);
    for (const x of [f.from, f.fill]) if (x && !fs.existsSync(path.join(core, x))) throw new Error(`${x} is not in ${core}`);
    if (!namesSource(fs.readFileSync(from, 'utf8'), f.from)) throw new Error(`${f.from} does not carry the line naming its source`);
    const data = made(core, f);
    const to = path.join(root, f.path);
    const sum = hash(data);
    if (!fs.existsSync(to) || sha256(to) !== sum) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      writeAtomic(to, data, fs.statSync(from).mode & 0o777);
      changed.push(f.path);
    }
    f.sha256 = sum;
  }
  m.core = coreCommit(core);
  writeAtomic(path.join(root, MANIFEST), JSON.stringify(m, null, 2) + '\n');
  return changed;
}

module.exports = { MANIFEST, sha256, coreDir, readManifest, sourceLine, namesSource, render, checkCopies, checkCore, coreCommit, sync };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const core = coreDir(root);
  const own = path.join(core, 'shared', 'build', 'sync-shared.js');
  const { checkCopies, checkCore, sync } = fs.existsSync(own) ? require(own) : module.exports;
  if (process.argv.includes('--check')) {
    const off = checkCopies(root);
    for (const l of off) console.log('copy: ' + l);
    if (fs.existsSync(path.join(core, 'shared'))) for (const l of checkCore(root, core)) console.log('core: ' + l);
    process.exit(off.length ? 1 : 0);
  }
  try {
    const changed = sync(root, core);
    console.log(changed.length ? `copied ${changed.join(', ')}` : 'every copy already matched');
  } catch (e) {
    console.error(`sync-shared.js: ${e.message}`);
    process.exit(1);
  }
}
