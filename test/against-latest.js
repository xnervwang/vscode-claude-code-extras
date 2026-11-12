// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Fetches whatever Claude Code build the marketplace is currently shipping and runs every edit against it.
 *
 * This is the early-warning half of the project. On a machine, a build whose shape no longer matches is noticed when
 * the extension refuses to patch it and says so - but by then the update is already installed and the panel has lost
 * the additions. Run on a schedule against the marketplace, the same check says so before the update arrives.
 *
 * What it cannot see: the in-page script finds elements by class name and test id, and those can change while every
 * edit still matches exactly once. That failure is caught at runtime instead, by the marker the script raises in the
 * panel when it can no longer find any message.
 *
 * Exits 1 when an edit does not match exactly once, when test/reply-shape.js finds a new child in a reply element, when
 * test/todo-gate.js finds the built-in to-do tools on for current models, or when test/inbox-shape.js finds the CLI no
 * longer reads a steward notice; the workflow opens an issue for any of them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const EXTENSION_ID = 'anthropic.claude-code';
// The edits are platform independent, but a package has to be picked; this is the one the author runs.
const PLATFORM = process.env.CCE_TARGET_PLATFORM || 'linux-x64';

/*
 * The gallery answers 5xx often enough that one blip would paint a scheduled run red, and the run that goes red carries
 * news about the edits - news that would be untrue. A transport error or a 5xx is worth another attempt; a 404 is an
 * answer and is returned as it stands.
 */
const ATTEMPTS = 3;
const WAIT_MS = [5000, 20000];

async function fetchRetrying(url, init) {
  let res, err;
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i) await new Promise((done) => setTimeout(done, WAIT_MS[i - 1]));
    try {
      res = await fetch(url, init);
      if (res.status < 500) return res;
      err = new Error(`status ${res.status}`);
    } catch (e) {
      res = undefined;
      err = e;
    }
    console.error(`attempt ${i + 1} of ${ATTEMPTS}: ${err.message}`);
  }
  // A 5xx on the last attempt is still an answer the caller can report against; never reaching the host is not.
  if (res) return res;
  throw err;
}

async function newestVersion() {
  const res = await fetchRetrying(QUERY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json;api-version=3.0-preview.1',
    },
    body: JSON.stringify({
      filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }], pageNumber: 1, pageSize: 1 }],
      flags: 950,
    }),
  });
  if (!res.ok) throw new Error(`marketplace query returned ${res.status}`);
  const body = await res.json();
  const ext = body.results && body.results[0] && body.results[0].extensions && body.results[0].extensions[0];
  if (!ext) throw new Error('the marketplace returned no such extension');
  const version = (ext.versions || []).find((v) => v.targetPlatform === PLATFORM);
  if (!version) throw new Error(`no ${PLATFORM} package among the published versions`);
  const asset = (version.files || []).find((f) => f.assetType.indexOf('VSIXPackage') !== -1);
  if (!asset) throw new Error(`the ${version.version} package carries no downloadable vsix`);
  return { version: version.version, url: asset.source };
}

async function fetchPackage(url, dest) {
  // fetch undoes the gallery's gzip transport encoding on its own, leaving the vsix - which is itself a zip.
  const res = await fetchRetrying(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`package download returned ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

(async () => {
  const { version, url } = await newestVersion();
  console.log(`marketplace is shipping Claude Code ${version} for ${PLATFORM}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-upstream-'));
  const vsix = path.join(work, 'claude-code.vsix');
  await fetchPackage(url, vsix);
  console.log(`package is ${(fs.statSync(vsix).size / 1e6).toFixed(1)} MB`);

  const cli = path.join(work, 'extension', 'resources', 'native-binary', 'claude');
  execFileSync('unzip', ['-q', vsix, 'extension/webview/index.js', 'extension/extension.js',
    'extension/resources/native-binary/claude', '-d', work], { stdio: ['ignore', 'ignore', 'inherit'] });

  const panel = path.join(work, 'extension', 'webview', 'index.js');
  const host = path.join(work, 'extension', 'extension.js');
  for (const f of [panel, host, cli]) {
    if (!fs.existsSync(f)) throw new Error(`the package does not contain ${path.relative(work, f)}`);
  }

  console.log('');
  let failed = false;
  try {
    execFileSync('node', [path.join(__dirname, 'check.js'), panel, host], { stdio: 'inherit' });
  } catch (_) {
    failed = true;
  }
  console.log('');
  try {
    execFileSync('node', [path.join(__dirname, 'todo-gate.js'), cli], { stdio: 'inherit' });
  } catch (_) {
    failed = true;
  }
  try {
    execFileSync('node', [path.join(__dirname, 'inbox-shape.js'), cli], { stdio: 'inherit' });
  } catch (_) {
    failed = true;
  }

  // Leaving the copy behind would fill a runner's disk over many runs, and it is of no use once checked.
  fs.rmSync(work, { recursive: true, force: true });

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  }
  if (failed) {
    console.log(`\nA check failed against Claude Code ${version}; the lines above say which.`);
    process.exit(1);
  }
  console.log(`\nAll checks pass against Claude Code ${version}.`);
})().catch((err) => {
  console.error(`upstream check could not run: ${err.message}`);
  process.exit(2);
});
