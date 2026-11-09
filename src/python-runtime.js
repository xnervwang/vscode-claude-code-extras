// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* python.org's embeddable Python for Windows, for machines without one; fetched after the user agrees. */
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const VERSION = '3.12.7';
/* By process.arch: python.org's build name, zip SHA-256, zip size. */
const BUILDS = {
  x64: ['amd64', '0d57bb6cb078b74d23dbfe91f77d6780d45bed328911609f1f7ee2ba1606bf44', 11062583],
  arm64: ['arm64', 'f4217333d32cecf723d81c0cede4778ccff391f5b71b9404cfbb2d0788ef1c12', 10318404],
  ia32: ['win32', '7f36ca8ebcb493b859be4c1ecde466eaffa4394a8b2487e645ee0e60b57ba5ca', 9899864],
};

function build(platform = process.platform, arch = process.arch) {
  const b = platform === 'win32' && BUILDS[arch];
  if (!b) return null;
  return { name: b[0], sha256: b[1], size: b[2],
    url: `https://www.python.org/ftp/python/${VERSION}/python-${VERSION}-embed-${b[0]}.zip` };
}

const home = (storage, b = build()) => path.join(storage, 'python', `${VERSION}-${b ? b.name : 'none'}`);
const executable = (storage, b = build()) => path.join(home(storage, b), 'python.exe');

function fetchTo(url, file, hops = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'claude-code-plus' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
        res.resume();
        resolve(fetchTo(new URL(res.headers.location, url).toString(), file, hops - 1));
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

async function download(storage, { fetch = fetchTo, extract = unzip } = {}) {
  const b = build();
  if (!b) return { ok: false, said: 'There is no embeddable Python for this machine.' };
  const target = home(storage, b);
  const part = `${target}.${process.pid}.part`;
  const zip = `${target}.${process.pid}.zip`;
  const clean = () => {
    try { fs.rmSync(part, { recursive: true, force: true }); } catch (_) { /* gone */ }
    try { fs.rmSync(zip, { force: true }); } catch (_) { /* gone */ }
  };
  try {
    fs.mkdirSync(part, { recursive: true });
    const sha = await fetch(b.url, zip);
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

module.exports = { VERSION, BUILDS, build, home, executable, download, unzip, fetchTo };
