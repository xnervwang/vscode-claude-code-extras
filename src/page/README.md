# src/page — the script that runs inside the Claude Code panel

These files are concatenated, in file-name order, into one closure and appended to the panel's bundle by
`src/webview.js`. They are **fragments, not modules**: no `require`, no `module.exports`, and every binding a fragment
declares is visible to all the others. The one exception is `03-kit.js`, Agent Plus's page helpers (`agentPlusKit`),
copied in through `shared.json`: its last line exports the object when it is loaded under Node, and does nothing here.

## Why files and not one string

This script used to be a single template literal inside `src/webview.js`. Two costs made that untenable:

- **Every backslash needed doubling**, and getting it wrong failed only at runtime. `/\s+/` written the obvious way
  evaluated to `/s+/`, which replaced the letter *s* in every label it touched for weeks before anyone noticed.
- **No tool could read it.** No syntax highlighting, no linting, and `node --check` on the containing file said
  nothing about the code inside the string.

As files, all of that works normally. Anything a fragment needs from the extension side is declared for it in the
generated config block instead of interpolated: `ATTR`, `STAMP_CSS`, `LIVE_CSS`, `LIVE_REV`, `POLL_MS`.

## Order matters in one specific way

File-name order is load order. A fragment may *call* a function declared in a later fragment, because calls happen
after the whole closure has run — but it may not call one **while loading**. Everything that runs on load therefore
lives in the last fragment (`99-sweep.js`).

## Adding a fragment

Pick a number that puts it in a sensible place, keep it to one subject, and start it with a line saying what that
subject is. Then run `node test/check.js`: it parses the assembled script as a whole, which is the only thing that
catches a fragment breaking another one.

## What stays out

- **No writes into nodes the panel owns.** Read their position, add siblings of your own, set attributes and inline
  styles on rows — but never put a node of ours inside one of theirs. When the panel's rendering collides with such a
  node it throws, and after that the page stops processing clicks and keys entirely.
- **No expensive work per row per sweep.** The sweep runs every 250 ms over every message on the page, and the panel
  keeps every loaded message in the DOM. Cache per element, keyed weakly, and let settled rows alone.
- **Nothing at load time.** This script runs while the panel is still laying itself out, so anything that reads or
  watches the page goes inside `boot()` in `99-sweep.js`, which the browser calls when it is idle — not at load time.
  A resource a fragment loads must not block painting either. Four omissions of exactly this once left every panel
  blank for a remote round trip on every open; the full account is the fourth constraint in the top-level `README.md`.
