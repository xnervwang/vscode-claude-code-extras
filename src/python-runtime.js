// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/host/python-runtime.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * Choosing the Python that runs the work plan plugin's hooks, and fetching one where there is none.
 *
 * The hooks and the plugin's MCP server are Python, and they ship as `python3 <script>`. That name is not on every
 * machine: macOS and Linux have it, the python.org installer for Windows provides `python` and the `py` launcher but no
 * `python3`, and a clean Windows has no Python at all. So the names are tried in turn (findPython), and for a machine
 * with none, python.org's embeddable build is offered - a zip of a complete interpreter that needs no installer and no
 * administrator, unpacked into the folder Agent Plus and its extensions share (src/files.js sharedHome), so that with
 * both extensions installed it is fetched once.
 *
 * The plugin is already written for this: plan_path.py reads the launcher command out of hooks/launcher.json, and
 * falls back to python3 when that file is absent. Writing that file is plugin-install.fitHooks' job; this module only
 * finds or fetches the interpreter.
 *
 * Nothing is fetched unless the user asks for it. download() is reached from a command, never from activation, since
 * it is eleven megabytes over the public internet on a machine whose network this extension knows nothing about.
 *
 * A download whose digest does not match is thrown away whole rather than unpacked, since this interpreter goes on to
 * run with the user's own privileges.
 */
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { sharedHome } = require('./files');

const VERSION = '3.12.7';
/* By process.arch: python.org's build name, zip SHA-256, zip size. */
const BUILDS = {
  x64: ['amd64', '0d57bb6cb078b74d23dbfe91f77d6780d45bed328911609f1f7ee2ba1606bf44', 11062583],
  arm64: ['arm64', 'f4217333d32cecf723d81c0cede4778ccff391f5b71b9404cfbb2d0788ef1c12', 10318404],
  ia32: ['win32', '7f36ca8ebcb493b859be4c1ecde466eaffa4394a8b2487e645ee0e60b57ba5ca', 9899864],
};

/*
 * Names to try, in order. `py -3` first on Windows: it is the launcher the python.org installer registers, and it
 * finds a real interpreter even when `python` is the Microsoft Store's stand-in that only offers to install one.
 */
const PYTHONS = process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
const PYTHON_MIN = [3, 7];
const ASK_PYTHON = 'import sys; print(sys.version_info[0], sys.version_info[1]); print(sys.executable)';

/**
 * The first Python 3.7 or later that runs, as `{ launcher, executable, version }`, or null.
 *
 * Each candidate is asked for both its version and its own path, rather than just being run. Asking for the version
 * is what passes over a name that resolves to something which is not an interpreter, and the path is what ends up in
 * the hooks, since a hook is started without a shell and cannot rely on PATH being the same one.
 */
async function findPython(run = cp.execFile, candidates = PYTHONS) {
  for (const launcher of candidates) {
    const said = await new Promise((resolve) => {
      try {
        run(launcher[0], launcher.slice(1).concat(['-c', ASK_PYTHON]), { timeout: 15000, windowsHide: true },
          (err, stdout) => resolve(err ? '' : String(stdout || '')));
      } catch (_) { resolve(''); }
    });
    const m = /^(\d+) (\d+)\s*\n\s*(\S.*?)\s*$/.exec(said.replace(/\r/g, '').trim());
    if (!m) continue;
    const major = Number(m[1]), minor = Number(m[2]);
    if (major > PYTHON_MIN[0] || (major === PYTHON_MIN[0] && minor >= PYTHON_MIN[1])) {
      return { launcher, executable: m[3], version: `${major}.${minor}` };
    }
  }
  return null;
}

/** python.org's build for this machine, or null where there is no embeddable one - which is everywhere but Windows. */
function build(platform = process.platform, arch = process.arch) {
  const b = platform === 'win32' && BUILDS[arch];
  if (!b) return null;
  return { name: b[0], sha256: b[1], size: b[2],
    url: `https://www.python.org/ftp/python/${VERSION}/python-${VERSION}-embed-${b[0]}.zip` };
}

/* Under `base`, named by version and processor, so an upgrade lands beside the old one. `base` is the shared folder;
   an extension that fetched one before kept it under its own storage, in the same layout. */
const home = (base = sharedHome(), b = build()) => path.join(base, 'python', `${VERSION}-${b ? b.name : 'none'}`);
const executable = (base = sharedHome(), b = build()) => path.join(home(base, b), 'python.exe');

/**
 * Interpreters to try: the names on PATH first, then a downloaded python.exe in the shared folder, then one an earlier
 * version of the extension downloaded into `storage`.
 *
 * They go last so that an installed Python wins over a fetched one.
 */
function pythons(storage) {
  const b = build();
  if (!b) return PYTHONS;
  const got = [sharedHome(), storage].filter(Boolean).map((base) => executable(base, b)).filter((exe) => fs.existsSync(exe));
  return PYTHONS.concat(got.map((exe) => [exe.replace(/\\/g, '/')]));
}

function fetchTo(url, file, hops = 5, agent = 'agent-plus') {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': agent } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
        res.resume();
        resolve(fetchTo(new URL(res.headers.location, url).toString(), file, hops - 1, agent));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url} answered ${res.statusCode}`)); return; }
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(file);
      res.on('data', (chunk) => hash.update(chunk));
      res.pipe(out);
      out.on('finish', () => resolve(hash.digest('hex')));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.setTimeout(120000, () => req.destroy(new Error('the download stalled for two minutes')));
    req.on('error', reject);
  });
}

/* Windows 10 1803 and later have tar.exe; before that there is only Expand-Archive. */
function unzip(zip, dir, run = cp.execFile) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const go = (bin, args) => new Promise((resolve) => run(bin, args, { timeout: 120000, windowsHide: true },
    (err) => resolve(!err)));
  return go(tar, ['-xf', zip, '-C', dir]).then((ok) => ok || go('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`]));
}

/**
 * Fetch, check and unpack the interpreter. Resolves to `{ ok, said }`; `said` is shown to the user either way.
 *
 * It is built up beside the destination and moved into place only once there is a python.exe in it, so a failure at any
 * step leaves nothing that findPython could pick up and try to run. The temporary names carry the process id because
 * every window of the editor runs this code.
 */
async function download(base = sharedHome(), { fetch = fetchTo, extract = unzip, userAgent = 'agent-plus' } = {}) {
  const b = build();
  if (!b) return { ok: false, said: 'There is no embeddable Python for this machine.' };
  const target = home(base, b);
  const part = `${target}.${process.pid}.part`;
  const zip = `${target}.${process.pid}.zip`;
  const clean = () => {
    try { fs.rmSync(part, { recursive: true, force: true }); } catch (_) { /* gone */ }
    try { fs.rmSync(zip, { force: true }); } catch (_) { /* gone */ }
  };
  try {
    fs.mkdirSync(part, { recursive: true });
    const sha = await fetch(b.url, zip, 5, userAgent);
    if (sha !== b.sha256) { clean(); return { ok: false, said: `${b.url} did not match its recorded SHA-256, so it was not used.` }; }
    if (!(await extract(zip, part))) { clean(); return { ok: false, said: `Unpacking ${path.basename(b.url)} failed.` }; }
    if (!fs.existsSync(path.join(part, 'python.exe'))) { clean(); return { ok: false, said: 'The download had no python.exe in it.' }; }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(part, target);
    try { fs.rmSync(zip, { force: true }); } catch (_) { /* left for the next download to replace */ }
    return { ok: true, said: `Python ${VERSION} is in ${target}.` };
  } catch (e) {
    clean();
    return { ok: false, said: e && e.message ? e.message : String(e) };
  }
}

module.exports = { VERSION, BUILDS, PYTHONS, PYTHON_MIN, build, home, executable, pythons, findPython, download, unzip, fetchTo };
