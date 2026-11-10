# Contributing

## Layout

Agent Plus (`xnervwang.agent-plus`) provides the work plan view, the Conversations tab with its Answer view, and
the status bar entry. This extension lists Agent Plus in `extensionDependencies` and registers Claude Code with it as a
conversation source. Agent Plus's `docs/protocol.md` describes the interface.

- `extension.js` handles activation, settings, commands, and the status bar toggle.
- `src/adapters.js` lists patch targets for both the entry point and the uninstall hook.
- `src/webview.js` holds the panel edits, live stylesheet, and in-page script assembly.
- `src/host.js` holds the extension-host edit.
- `src/page/*.js` holds the in-page script, one subject per file. The files are concatenated in file-name order.
- `src/claude-files.js` locates Claude Code's directory, its transcripts and the plan directory, and reads a transcript as it grows. Code that reads Claude Code's files goes through it.
- `src/workplan.js` reads plan files. Its header defines the contract between the two halves.
- `src/plugin-install.js` registers the companion Claude Code plugin and unregisters it on uninstall.
- `src/carryover.js` copies what the earlier id, `xnervwang.claude-code-extras`, kept and this extension still uses: the session pins and colors, two saved values, and the work plans an uninstall moved aside. It also tells whether an earlier version of that id is installed.
- `src/removal.js` notices an uninstall when VS Code restarts its extensions, and restores Claude Code then rather than when VS Code deletes the folder.
- `src/openlatency.js` pairs panel-opening times from the official extension's log.
- `src/background.js` finds the `claude --bg` sessions a conversation started, in its transcript, and reads their state for the agent map.
- `src/efforts.js` reads, from a conversation's transcripts, where the effort its replies were sent with changed, for the reply figures.
- `src/sessionpins.js` keeps the conversations pinned in the session list from Claude Code's transcript cleanup, by giving their files a later modification time before they reach its age, and records when each was really last active.
- `src/sessioncolors.js` stores the text color picked for each conversation in the session list.
- `src/bgsessions.js` tells which sessions in the session list are background sessions, so they can be left out.
- `src/claude-source.js` is Claude Code's conversation source for Agent Plus, and `src/core-link.js` registers it.
- `src/waiting.js` lists the running conversations with `claude agents --json`, merged by session.
- `src/conversations.js` adds the stopped conversations whose plans have open rows, and gives each its title and state.
- `src/page/91-answer.js` types an answer from Agent Plus into the conversation's message input.
- `src/bounded.js` reads a plan file only if it is a regular file under a size limit.
- `build/plan-health.js` counts how current the plans on this machine are: stale `doing` rows, `waiting` rows that name nobody.
- `src/python-runtime.js` downloads Python from python.org for a Windows machine that has none.
- `claude-plugin/` holds the companion plugin: the skill that maintains a plan and the hooks that keep it honest.
- `test/check.js` is the whole suite. It parses everything and checks every edit against an unpatched bundle. How
  many checks it runs depends on how many Claude Code builds are installed, so the count is not quoted here.
- `test/against-latest.js` checks the same edits against the current marketplace build.
- `test/page-harness.js` runs the injected script in a headless browser against a stand-in panel, for the checks on what the page costs.
- `test/reply-shape.js` reads what a reply element holds out of a real bundle, which the stand-in panel cannot contradict.
- `test/with-core.js` runs this extension with Agent Plus from its checkout beside this one, in Agent Plus's
  fake VS Code (`test/fake-vscode.js`). Without that checkout its checks are skipped.
- `build/pack.sh` produces the `.vsix` without npm.
- `shared.json` lists the files copied from Agent Plus, each with the Agent Plus file it comes from. Besides the packing scripts and two checks, they are, in `src/`: the steps every patch target shares (`patch-target.js`, `edits.js`, `files.js`), finding the installed copies for the uninstall (`installed-copies.js`), writing the hooks' settings (`hook-settings.js`), registering with Agent Plus (`core-link.js`), and the workspace folder test (`folders.js`). Change them in Agent Plus and run `node build/sync-shared.js`; `test/shared-copies.js` fails on a copy changed here.
- `shim/` is the last version of the earlier id. It depends on Claude Code Plus, so updating the old extension installs Claude Code Plus. It writes `export.json`, which Claude Code Plus imports, and does nothing else. `bash build/pack-shim.sh` builds its `.vsix`.
- `build/supported.js`, `build/update-versions.js`, and `supported-versions.json` maintain the record of verified Claude Code builds.

## Working on it

Run `node test/check.js` for the full suite. No npm install or dependencies are needed. The checks on what the page costs also need Chrome or Chromium; without one they report themselves as skipped, except in CI, which requires one. Run `bash build/pack.sh` to produce a `.vsix` for installing locally; the package the marketplaces get is described under Publishing.

The in-page script stays in ordinary `.js` files rather than one large template literal. In a literal, every backslash needed doubling. A missed backslash failed only at runtime: `/\s+/` became `/s+/` and replaced the letter *s* in every label it passed through.

Reload the window twice to see a code change: once for the extension to rewrite the file, then once for the panel to load it.

Neither patch needs a manual version bump. Each marker includes a digest of the scripts and edits that patch writes, so a patched file that differs from this tree is recognised as outdated.

Two rules the in-page script keeps, each adopted after the failure it prevents. Never put a node of your own inside one the panel owns - read positions, add siblings, set attributes and inline styles, but nothing goes inside. When the panel's own rendering collided with such a node it threw, and from then on the page stopped handling clicks and keys at all: a dead stop button and a dead Escape, with nothing visible to say why. And never do anything before the panel has painted - the script is appended to the panel's own bundle, so whatever it does there is work the panel must finish before it can show anything. Everything that reads or watches the page waits for the browser to report itself idle.

Keep the early exit in the injected script's React fiber tree loop. It runs for every visible row on every refresh. Searching for more than one thing at a time measured 8–10× slower. `test/check.js` checks that the early exit remains.

## Publishing

- Package for the marketplaces with vsce, not `build/pack.sh`. `pack.sh` copies `images/` whole, so the README screenshots (about 1.2 MB) ship too, and it leaves the README's relative links as they are. Nothing reports either difference.
- Commit and push first, then package against that commit so the README's images and links point at it:

  ```sh
  SHA=$(git rev-parse HEAD)
  npx --yes @vscode/vsce@latest package --out xnervwang.claude-code-plus-<version>.vsix \
    --baseImagesUrl "https://github.com/xnervwang/vscode-claude-code-plus/raw/$SHA/" \
    --baseContentUrl "https://github.com/xnervwang/vscode-claude-code-plus/blob/$SHA/"
  ```

- On Node 22.11, vsce needs `NODE_OPTIONS=--experimental-require-module`.
- Raise `version` before every upload. Neither the Visual Studio Marketplace nor Open VSX accepts a version that was already published, even after it was removed.
- Upload the same `.vsix` to both. For Open VSX: `npx ovsx publish <file> -p <token>`.

## Watching for upstream changes

Claude Code ships roughly once per working weekday. If a release reshapes patched code, the panel can lose every addition at once. On a user's machine, that may become apparent only after the update is installed.

Run `node test/against-latest.js` to fetch the current marketplace build and check every edit against it. `.github/workflows/upstream-check.yml` runs that check four times a day. It files one issue per build when an edit stops matching or a reply holds a child not seen before, and puts the report in the run summary either way.

These checks cannot catch changes to class names or test ids used by the in-page script. Every edit can still match exactly once while those lookups break. That failure appears at runtime through a marker the script raises in the panel.

## The record of verified builds

`supported-versions.json` records the Claude Code builds **this commit** was verified to patch. Someone using an older build can use the record to find a commit that works with it.

Record only builds verified against the current code. Leave out a build that is not installed on the machine writing the commit, even if an earlier commit verified it. To find that earlier commit, ask git:

```sh
git log -S2.1.283 -- supported-versions.json
```

Nothing is written unless the full suite passes. `node build/update-versions.js` shows what would change. `node build/update-versions.js -w` runs the suite and then writes the record.

The suite fails if the record differs in either direction from the builds the machine just verified. Listing more makes a false claim. Listing fewer can leave an upgrade unrecorded forever, because a conservative record would not otherwise fail a check.

This check needs the installed bundles, so it cannot run in CI. A runner has no Claude Code installed, and the section reports itself as skipped. Enforcement is local. To enable the pre-commit hook, run:

```sh
git config core.hooksPath build/git-hooks
```

Git does not install repository hooks automatically. The hook runs the same suite; it reports a mismatch and stops rather than writing the record for you.
