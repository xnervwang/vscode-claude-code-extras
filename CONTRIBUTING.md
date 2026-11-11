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
- `src/python-runtime.js` looks for a Python 3 to run the hooks and, on a Windows machine without one, downloads one from python.org; `src/python-offer.js` asks about that download once per Python version on each machine.
- `claude-plugin/` holds the companion plugin: the skill that maintains a plan and the hooks that keep it honest.
- `test/check.js` is the whole suite. It parses everything and checks every edit against an unpatched bundle. How
  many checks it runs depends on how many Claude Code builds are installed, so the count is not quoted here.
- `test/against-latest.js` checks the same edits against the current marketplace build.
- `test/page-harness.js` runs the injected script in a headless browser against a stand-in panel, for the checks on what the page costs.
- `test/reply-shape.js` reads what a reply element holds out of a real bundle, which the stand-in panel cannot contradict.
- `test/with-core.js` runs this extension with Agent Plus from its checkout beside this one, in Agent Plus's
  fake VS Code (`test/fake-vscode.js`). Without that checkout its checks are skipped.
- `test/vscode/` holds the real-window checks run by `.github/workflows/vscode.yml`: `run.js` starts the run; `ui.js` drives the window through Playwright; `suite/` runs checks inside VS Code; `helper/` is a development extension that makes VS Code API calls for `ui.js`; `lib/` starts the window, prepares the made-up model and `~/.claude`, sets the window's environment, reads PNGs, and compares crops with approved copies; `baseline/<platform>/` holds those copies; and `update-baseline.js` copies a run's crops over them.
- `build/pack.sh` produces the `.vsix` without npm.
- `shared.json` lists the files copied from Agent Plus and where each one comes from: the packing scripts, two checks, shared host and page code in `src/`, and the hooks the two plugins share. Claude Code's part of those hooks is `claude-plugin/agent-work-plan/hooks/plan_agent.py`, and `skills/maintain/SKILL.md` is generated from Agent Plus's template with this extension's text filled in. `guard-work-plan.py` and `refresh-work-plan.py` are not copied. To change a copied file, change it in Agent Plus and run `node build/sync-shared.js`; `test/shared-copies.js` fails when a copy is edited here.
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

## In a real VS Code window

`.github/workflows/vscode.yml` runs `test/vscode/run.js` on Linux, macOS, and Windows. It runs on pushes to `main` or a `ci/` branch, pull requests, once a day at 09:43 UTC, and by hand.

The runner downloads the newest stable VS Code. It installs the newest Claude Code from the marketplace, Agent Plus from a supplied `.vsix` or the marketplace, and this extension's `.vsix` into a separate profile. It then runs `ui.js` in the window, `suite/` inside VS Code, and `test/check.js` against the installed copies. Any failed stage makes the runner exit non-zero.

The window checks these steps in order:

- Both patched files are written on the first start, and VS Code asks for a reload. The tab bar then has exactly one Claude button: Claude Code's own.
- The session list has New in tab and New in sidebar, a pin and dates on each row, Resume in tab, Resume in sidebar and Text color in the right-click menu, and hover text for a row.
- A conversation resumed in a tab has times on every message and reply, a bar on your own messages, the rail and its list, footer buttons and their hover text, and the information box. At the top of the session list, OPEN SESSIONS lists the conversation while its tab is open, and RECENTLY CLOSED lists it once the tab is closed. The times disappear and return when this extension is turned off and on.
- The dot on the tab's logo is green while a turn runs, red when its reply lands while the tab is in the background, and blue while Claude Code waits for permission to run a command.
- Delete session… asks for confirmation on an archived conversation. The window also checks Show Status, Settings, and the confirmation for Stop Loading the Work Plan Plugin.
- Not covered by the window stage: the footer's filter for the main thread or one sub-agent, which only appears in a conversation that ran sub-agents; the sound of the chimes.

Claude Code is not signed in during the run. `claudeCode.disableLoginPrompt` turns off its login prompt. `claudeCode.environmentVariables` gives its CLI a made-up API key and sends every turn to the model on `127.0.0.1` in `test/vscode/lib/fake-model.js`. The temporary `~/.claude.json` marks that key as accepted. The CLI started from the panel uses an API key only after it has been accepted once; otherwise every turn answers "Not logged in". `test/vscode/lib/fake-home.js` writes the made-up transcripts under the temporary `~/.claude/projects/`.

Every home folder (`HOME`; `USERPROFILE` and the AppData folders on Windows; the XDG folders on Linux), along with VS Code's user data and extensions folders, sits under a new folder in `RUNNER_TEMP` or the system's temporary folder. The window's environment leaves out `VSCODE_*`, `ELECTRON_*`, `LD_LIBRARY_PATH`, `CLAUDE*`, `ANTHROPIC_*`, `AWS_*`, and `OTEL_*`. When the runner starts inside a Claude Code session or VS Code terminal, those variables could otherwise send installs to another VS Code or turns to that session's provider.

On Linux, the test stage runs in a network namespace with loopback only. It uses `unshare -rn`, then `test/vscode/as-user.py` to run as the caller rather than root. The workflow sets `CLAUDE_CODE_PLUS_UI_OFFLINE=require`, so it fails if it cannot make the namespace. On macOS and Windows, `HTTP_PROXY`, `HTTPS_PROXY`, and VS Code's `http.proxy` point at `127.0.0.1:9`, where no proxy is running.

The `--out` folder holds a screenshot of every step in `shots/`, crops in `actual/<platform>/`, a diff image for each failed crop in `diff/<platform>/`, and VS Code logs in `logs/`. The workflow uploads this folder as `vscode-<OS>` whether the run passes or fails. Only elements this extension draws are cropped, never Claude Code's or VS Code's own. If one of ours sits between two Claude Code elements, it gets its own crop.

Each crop is compared pixel by pixel with the approved copy for its platform. A pixel differs when any channel differs by more than 32 of 255. A crop fails when more than 0.2% of its pixels differ, or its width or height differs by more than one pixel. Times in crops are masked.

Only Linux has approved crops so far. They were made on a development machine under Xvfb with a 1600x1000 screen at 24 bits. macOS and Windows save their crops without comparing them until someone approves a set from a CI run. The first Linux CI run may fail because the runner's fonts differ. If `diff/linux/` shows only glyph differences, approve the runner's crops from the artifact.

The person merging into `main` approves new copies. Before copying them, inspect every crop to be copied and `diff/<platform>/` from the same run. Then run:

```sh
node test/vscode/update-baseline.js <results folder or unpacked artifact> [<platform>] [--only <name>[,<name>]]
```

The command copies `actual/<platform>/*.png` over `test/vscode/baseline/<platform>/`. Commit the new copies yourself, with an explanation of what changed in the drawing and why.

For a local run, install the test dependencies outside the repository and point `NODE_PATH` at that folder's `node_modules`:

```sh
npm install --no-save --no-package-lock --prefix <folder of your own> @vscode/test-electron@3 playwright-core@1
```

On Linux, start a display and run:

```sh
Xvfb :94 -screen 0 1600x1000x24 -nolisten tcp &
DISPLAY=:94 NODE_PATH=<folder>/node_modules node test/vscode/run.js <the .vsix> [<Agent Plus .vsix>] [--out <dir>] [--vscode <executable>] --local
```

The runner refuses to start outside CI unless given `--local`. `--vscode` uses an executable already on disk instead of downloading VS Code. `CLAUDE_CODE_PLUS_UI_KEEP=1` keeps the temporary root so you can open the same profile by hand. On a development machine, a run takes about 2.5 minutes, including the marketplace install of Claude Code.

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
