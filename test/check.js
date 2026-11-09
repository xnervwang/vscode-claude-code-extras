// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Pre-flight check. Run it after every change to the patchers, before installing.
 *
 * It answers the two questions that decide whether this extension still works:
 *
 *   1. Does everything we ship parse?  Including the injected script, which is a string inside webview.js and so is
 *      invisible to `node --check` on the file itself.
 *   2. Does every edit still match exactly once, on a pristine Claude Code bundle?  A patched file cannot answer this,
 *      so the pristine source is the untouched backup when one exists, or the file itself when it carries no marker.
 *
 * Usage:
 *   node test/check.js                       find Claude Code installs and check against each
 *   node test/check.js <bundle> [<bundle>]   check against bundles named explicitly (index.js / extension.js, or a
 *                                            backup of either — useful while an older patch still owns the live files)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const vm = require('vm');

const webview = require('../src/webview');
const host = require('../src/host');
const ADAPTERS = require('../src/adapters');
const supported = require('../build/supported');
const { pickShape } = require('../src/edits');

let failures = 0;
/* Checks that could not run, as against ones that ran and passed. Two whole sections need a real Claude Code install and
   an installed copy of this extension, so on a machine that has neither - a CI runner - thirty-odd checks quietly do not
   happen. Counted and printed with the total, because a green run that verified less than the last green run is the one
   result nobody would otherwise notice. */
let skipped = 0;
let passed = 0;
const ok = (msg) => { passed++; console.log('  ok    ' + msg); };
const bad = (msg) => { failures++; console.log('  FAIL  ' + msg); };
const note = (msg) => { skipped++; console.log('  note  ' + msg); };
/* One argument of a command line the hooks print. shlex.quote puts it in ' when it needs quoting, as a Windows path always
   does. */
const ARG = "('[^']*'|\\S+)";
const unquote = (s) => (/^'.*'$/.test(s) ? s.slice(1, -1).replace(/'"'"'/g, "'") : s);
/* chmod 0 does not lock a folder for root, and on Windows it only sets the read-only flag. */
const CANNOT_LOCK = process.platform === 'win32' || !!(process.getuid && process.getuid() === 0);

/* ── 1. everything parses ── */
// Discovered rather than listed, so a new fragment is covered the moment it is added.
function sourceFiles() {
  const root = path.join(__dirname, '..');
  const out = ['extension.js', 'uninstall.js'];
  for (const dir of ['src', path.join('src', 'page')]) {
    for (const f of fs.readdirSync(path.join(root, dir)).sort()) {
      if (f.endsWith('.js')) out.push(path.join(dir, f));
    }
  }
  return out;
}

console.log('parse');
for (const f of sourceFiles()) {
  const abs = path.join(__dirname, '..', f);
  try { new vm.Script(fs.readFileSync(abs, 'utf8'), { filename: f }); ok(f); }
  catch (e) { bad(`${f}: ${e.message}`); }
}
try {
  new vm.Script(webview.SCRIPT, { filename: 'injected.js' });
  const fragments = fs.readdirSync(path.join(__dirname, '..', 'src', 'page')).filter((f) => f.endsWith('.js')).length;
  ok(`assembled script (${webview.SCRIPT.split('\n').length} lines from ${fragments} fragments)`);
} catch (e) {
  bad('assembled script: ' + e.message);
}

/* ── 1b. every function the injected script calls has to exist ──
   The script is one closure, so calling a name nobody declares is a ReferenceError when that line runs - not a syntax
   error. `new vm.Script` accepts it, and packaging, installing and reloading all report success, so the only evidence
   is the feature quietly not working. One such name survived eleven releases: a commit that reshaped the chimes
   deleted the two accessors for the stored mute preference and left their three call sites behind. The button was
   still inserted, then threw before it could set its own tooltip, and the sweep's catch swallowed that on every pass.
   The whole visible symptom was an icon with no hover text.

   Heuristic by necessity - regex, not a parser - so it errs toward silence: it only looks at `name(` calls that are
   not property accesses, and it treats everything declared anywhere in the closure as in scope. That is weaker than
   real scope analysis and would miss a name declared in one function and called from another. It still catches the
   only failure that has actually happened, which is a name declared nowhere at all. */
const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'delete',
  'void', 'in', 'of', 'do', 'else', 'try', 'case', 'throw', 'yield', 'await', 'instanceof']);
// Everything the page may legitimately reach without declaring it. Adding to this list is the correct fix when a check
// failure names a real browser or language global; declaring the missing function is the fix for anything else.
const PAGE_GLOBALS = new Set(['window', 'document', 'console', 'navigator', 'performance', 'localStorage',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'requestIdleCallback',
  'getComputedStyle', 'fetch', 'atob', 'btoa', 'encodeURIComponent', 'decodeURIComponent', 'isFinite', 'isNaN',
  'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'RegExp',
  'Error', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'Image', 'MutationObserver', 'AudioContext',
  'TextDecoder', 'TextEncoder', 'Range', 'Node', 'Element', 'HTMLElement', 'CustomEvent', 'Event', 'URL',
  'structuredClone', 'queueMicrotask', 'Uint8Array', 'Uint16Array', 'Float32Array', 'ArrayBuffer', 'acquireVsCodeApi']);

/* Comments and string literals have to go first, or the scan reports the prose and the CSS: `content:attr(...)` and
   `rgba(...)` and `var(--vscode-…)` are stylesheet text, and a sentence like "call __cceStats() any time" is a hint
   printed to a console. Comments are stripped before strings so an apostrophe in English prose cannot open a string
   and swallow the code after it. */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function undeclaredCalls(source) {
  const src = stripCommentsAndStrings(source);
  const declared = new Set();
  const add = (n) => { if (n) declared.add(n); };
  for (const m of src.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/[,(]\s*([A-Za-z_$][\w$]*)\s*=[^=]/g)) add(m[1]);      // second declarator, or a param default
  for (const m of src.matchAll(/function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    add(m[1]);
    for (const p of (m[2] || '').split(',')) add(p.trim().replace(/[=.].*$/, '').trim());
  }
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/g)) add(m[1]);     // arrow parameters
  const missing = new Set();
  for (const m of src.matchAll(/(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const n = m[2];
    if (!JS_KEYWORDS.has(n) && !PAGE_GLOBALS.has(n) && !declared.has(n)) missing.add(n);
  }
  return [...missing].sort();
}

const undeclared = undeclaredCalls(webview.SCRIPT);
if (!undeclared.length) ok('every function the injected script calls is declared in it');
else bad(`the injected script calls ${undeclared.length} name(s) it never declares, which throw when reached: ${undeclared.join(', ')}`);

/* ── 2. the injected script must keep its early exit ──
   The loop that walks up the React fiber tree runs for every visible row on every refresh. Dropping the
   `!out.message` condition makes each element walk the full depth instead of three or four levels, which measured
   eight to ten times slower. It has been broken this way once, so it is asserted here. */
if (webview.SCRIPT.includes('!out.message; f = f.return')) ok('hot loop keeps its early exit');
else bad('hot loop lost its early exit — the fiber walk will run to full depth on every element');

/* Diagnostics for one investigation are marked TEMPORARY; the injected script runs in every panel, so none may be
   left. */
if (!/TEMPORARY/.test(webview.SCRIPT)) ok('the injected script carries nothing marked temporary');
else bad('the injected script carries code marked TEMPORARY, which belongs to an investigation that should be over');

/* What the page writes on every sweep or every tick has to be skipped when it would not change. Writing text is a
   mutation, the page's own observer answers a mutation with a sweep, and the sweep reaches these writes again - so one
   unconditional write keeps the page sweeping four times a second with nothing happening on it. Measured with the real
   script on an idle page: 19 sweeps in five seconds against 3, from one stylesheet rule rewritten on every tick. */
{
  const page = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'page', f), 'utf8');
  const focus = page('87-focus-view.js'), view = page('85-view-filter.js');
  if (focus.includes("if (FOCUSBTN.getAttribute('data-cce-fold') !== want) {")) {
    ok('the Focus view button rebuilds its icon only when the state turns over');
  } else bad('the Focus view button rebuilds its icon on every tick, which keeps an idle page sweeping');
  if (view.includes('if (VIEWBTN.textContent !== label) VIEWBTN.textContent = label;')) {
    ok('the view button writes its label only when the label changes');
  } else bad('the view button rewrites its label on every sweep, which keeps an idle page sweeping');
  /* Ordering two siblings costs the browser a walk along the siblings between them, and every message is a sibling of
     every other, so placing the compaction rules against each prompt on every sweep took tens of milliseconds a sweep
     on a long conversation. */
  const toc = page('45-toc.js');
  const sync = toc.slice(toc.indexOf('var syncMap = function'));
  const settled = sync.indexOf('if (sig === SIG && sameEntries(nodes, texts, whens)) return;'), compared = sync.indexOf('compareDocumentPosition');
  if (settled > 0 && compared > settled && sync.includes('while (lo < hi)')) {
    ok('compaction rules are placed only when the contents list is rebuilt, by halving');
  } else bad('compaction rules are placed before the signature check, or by walking every prompt');
}

/* ── 2b. what the page costs, run in a browser ──
   The real injected script against a stand-in panel (test/page-harness.js), counted rather than timed, so a threshold
   can be exact without depending on the machine. The same conversation at two lengths, so that work growing with the
   conversation shows up as a ratio. A runner with no browser would let every regression here through while reporting
   green, so CI sets CCE_REQUIRE_BROWSER and a missing browser fails there; elsewhere it is reported as skipped. */
console.log('\nwhat the page costs, in a browser');
{
  const harness = require('./page-harness');
  const browser = harness.findBrowser();
  if (!browser) {
    if (process.env.CCE_REQUIRE_BROWSER) bad('no Chrome or Chromium found, and this run requires one (CCE_REQUIRE_BROWSER)');
    else note('skipped: no Chrome or Chromium here - set CCE_BROWSER to one to run these');
  } else {
    const SHORT = 100, LONG = 400;
    const runs = [
      ['Focus view on', harness.run(browser, { turns: SHORT, focus: true })],
      ['Focus view on, four times as long', harness.run(browser, { turns: LONG, focus: true })],
      ['Focus view off', harness.run(browser, { turns: SHORT, focus: false })],
    ];
    const [short, long, off] = runs.map(([, r]) => r);
    const failed = runs.filter(([, r]) => r.error || !r.script);
    if (failed.length) {
      bad('the stand-in panel did not run: ' + failed.map(([what, r]) => `${what}: ${r.error || 'the script did not load'}`).join('; '));
    } else {
      /* What follows is only evidence if the stand-in reached the code those costs were found in. */
      if (runs.every(([, r]) => r.viewButton && r.focusButton)) {
        ok('the stand-in panel brings up the view button and the Focus view button');
      } else bad('the stand-in panel did not reach the code under test: '
        + JSON.stringify(runs.map(([what, r]) => [what, r.viewButton, r.focusButton])));
      /* The button is only a control for Claude Code's Focus view, so what it says has to come from there, and a press has
         to go there - nothing of its own to fall out of step with another page. */
      if (/^Focus view is on/.test(short.focusLabel) && /^Showing thinking and tool calls/.test(off.focusLabel)) {
        ok('the button says what Claude Code\'s Focus view is set to, on and off');
      } else bad(`the button's label did not follow the setting: on "${short.focusLabel}", off "${off.focusLabel}"`);
      const pressed = harness.run(browser, { turns: 10, focus: false, clickFocus: true });
      if (!pressed.error && pressed.clicked && JSON.stringify(pressed.focusCalls) === '[true]' && pressed.focusAfter === true
          && /^Focus view is on/.test(pressed.focusLabelAfter)) {
        ok('a press turns Focus view on through the panel\'s own object, and the label follows');
      } else bad('a press of the Focus view button: ' + (pressed.error || JSON.stringify(
        { clicked: pressed.clicked, calls: pressed.focusCalls, after: pressed.focusAfter, label: pressed.focusLabelAfter })));
      /* Each reply's figures belong on its first block. Claude Code may draw a row of its own ahead of the blocks - since
         2.1.284, on by default from 2.1.290, a time line on every reply that has text - and that row carries no block. */
      const stamped = harness.run(browser, { turns: 10, panelStamp: true });
      if (!short.error && short.figuresAt.length && short.figuresAt.every((i) => i === 0)
          && !stamped.error && stamped.figuresAt.length && stamped.figuresAt.every((i) => i === 1)) {
        ok('each reply\'s figures go on its first block, also behind a time line Claude Code draws ahead of the blocks');
      } else bad('where the figures went, by child of each reply: plain ' + JSON.stringify(short.figuresAt).slice(0, 80)
        + ', behind a time line ' + (stamped.error || JSON.stringify(stamped.figuresAt).slice(0, 80)));
      /* From 2.1.300 a mod can draw rows of its own between the time line and the blocks; they sit under the reply's
         message like the blocks do, but hold none. */
      const modded = harness.run(browser, { turns: 10, panelStamp: true, modRow: true });
      if (!modded.error && modded.figuresAt.length && modded.figuresAt.every((i) => i === 2)) {
        ok('and behind the rows a Claude Code mod draws for the reply');
      } else bad('where the figures went behind a mod\'s rows: ' + (modded.error || JSON.stringify(modded.figuresAt).slice(0, 80)));
      /* Claude Code's own times are hidden by the live stylesheet, not by leaving ours out: with them on the page, every
         prompt and every reply still carries a time of this script's, in one place and one format. */
      const own = harness.run(browser, { turns: 30, panelStamp: 'time' });
      const ti = own.times || {};
      if (!own.error && ti.replies === 90 && ti.text === ti.replies && ti.prompt === ti.prompts && ti.first === ti.replies
          && ti.firstFigures === ti.replies) {
        ok('with Claude Code\'s own times on the page, every prompt and reply still carries ours, figures on the first block');
      } else bad('with Claude Code\'s own times on the page: ' + (own.error || JSON.stringify(ti)));
      if (!stamped.error && stamped.times && stamped.times.text === stamped.times.replies) {
        ok('an empty stamp line, as held while a reply streams, leaves our time in place');
      } else bad('with an empty stamp line: ' + (stamped.error || JSON.stringify(stamped.times)));
      const older = harness.run(browser, { turns: 10, focusCtx: false });
      if (!older.error && older.viewButton && !older.focusButton) ok('a Claude Code build without Focus view gets no button');
      else bad('without Focus view in the panel: ' + (older.error || `the button was ${older.focusButton ? 'shown' : 'missing, and so was the view button'}`));
      /* Panels switch conversations in place (New and Resume in the sidebar); what the page reads from the session must
         follow. */
      const moved = harness.run(browser, { turns: 30, switchSession: true });
      if (!moved.error && /ctx 10%/.test(moved.labelBeforeSwitch) && /ctx 50%/.test(moved.labelAfterSwitch)
          && /Session11111111-2222-4333-8444-555555555555/.test(moved.infoAfterSwitch)) {
        ok('after the panel moves to another conversation, the newest reply\'s figures and the info box are that conversation\'s');
      } else bad('after the panel moved to another conversation: ' + (moved.error || JSON.stringify(
        { before: moved.labelBeforeSwitch, after: moved.labelAfterSwitch, info: moved.infoAfterSwitch })));
      /* View filter off from the start: owners are still recorded, so older replies settle, and there is no button. */
      const noFilter = harness.run(browser, { turns: SHORT, offSwitches: ['footerViewFilter'] });
      if (!noFilter.error && noFilter.msgs === 300 && noFilter.full <= 64 && !noFilter.viewButton) {
        ok(`with the view filter off, ${noFilter.full} of ${noFilter.msgs} replies are worked out each sweep and there is no button`);
      } else bad('with the view filter off: ' + (noFilter.error || `${noFilter.full} of ${noFilter.msgs} replies worked out, button ${noFilter.viewButton}`));
      /* Turned off while the page is open, as the extension does it (a new live stylesheet the revision probe notices):
         the elements each addition already put on the page must be removed. */
      const offLive = harness.run(browser, { turns: SHORT, pickView: true,
        flip: ['footerViewFilter', 'footerInfo', 'footerMute', 'footerPlainView'] });
      if (!offLive.error && offLive.picked && offLive.hiddenInView > 0 && offLive.controlsBeforeFlip.length === 4
          && offLive.hiddenAfterFlip === 0 && !offLive.controlsAfterFlip.length) {
        ok(`switched off while open, a sub-agent view shows again the ${offLive.hiddenInView} messages it hid, and the info, mute, Focus view and view buttons go`);
      } else bad('switching the footer additions off while open: ' + (offLive.error || JSON.stringify({ picked: offLive.picked,
        hidden: [offLive.hiddenInView, offLive.hiddenAfterFlip], controls: [offLive.controlsBeforeFlip, offLive.controlsAfterFlip] })));
      /* Marks are cached, so a switch that changes their content must update every message and reply, not only the
         newest and the last sixty. */
      const marksLive = harness.run(browser, { turns: SHORT, subagentTurn: 5, flip: ['timestamps', 'subAgentTags'] });
      const tb = marksLive.timesBeforeFlip || {}, ta = marksLive.timesAfterFlip || {};
      if (!marksLive.error && tb.text === tb.replies && tb.prompt === tb.prompts && marksLive.tagsBeforeFlip > 0
          && ta.text === 0 && ta.first === 0 && ta.prompt === 0 && ta.firstFigures === ta.replies && marksLive.tagsAfterFlip === 0) {
        ok(`the time and the sub-agent tags switched off while open leave all ${ta.replies} replies and ${ta.prompts} messages, figures kept`);
      } else bad('switching the time and the sub-agent tags off while open: ' + (marksLive.error || JSON.stringify(
        { before: tb, after: ta, tags: [marksLive.tagsBeforeFlip, marksLive.tagsAfterFlip] })));
      const tocLive = harness.run(browser, { turns: SHORT, flip: ['toc'] });
      if (!tocLive.error && tocLive.railBeforeFlip && tocLive.keyMovedBeforeFlip && !tocLive.railAfterFlip && !tocLive.keyMovedAfterFlip) {
        ok('the contents list switched off while open takes its rail away, and the , and . keys stop stepping');
      } else bad('switching the contents list off while open: ' + (tocLive.error || JSON.stringify({ rail: [tocLive.railBeforeFlip,
        tocLive.railAfterFlip], key: [tocLive.keyMovedBeforeFlip, tocLive.keyMovedAfterFlip] })));
      /* A write the page answers with a sweep that makes the write again keeps an idle page sweeping four times a second.
         Such a page never holds still long enough to count as settled, and changes things while idle. */
      const restless = runs.filter(([, r]) => !(r.settledAfter < harness.DEFAULTS.settleCapMs && r.idleSweeps === 0
        && r.idleChild + r.idleAttr + r.idleChars === 0));
      if (!restless.length) ok('an idle page stops sweeping once it has booted, and changes nothing while it waits');
      else bad('an idle page kept itself busy: ' + restless.map(([what, r]) =>
        `${what}: ${r.idleSweeps} sweeps and ${r.idleChild + r.idleAttr + r.idleChars} changes in ${harness.DEFAULTS.idleMs}ms`).join('; '));
      /* Reloading a stylesheet puts a link into the head and takes the old one out. A page that answered that with a
         sweep would sweep every time any conversation's efforts changed, in every panel open. */
      const churn = harness.run(browser, { turns: SHORT, focus: true, headChurn: true });
      if (!churn.error && churn.idleSweeps === 0 && churn.idleChild > 0) {
        ok(`stylesheets coming and going in the head start no sweep (${churn.idleChild} changes, 0 sweeps)`);
      } else bad(`with stylesheets coming and going in the head: ${churn.error || churn.idleSweeps + ' sweeps for ' + churn.idleChild + ' changes'}`);
      /* The poll asks for one small file over and over, and a webview resource is fetched through the editor's service
         worker. One fetch that never answers used to leave a request in flight for the life of the panel while the poll
         started another every three seconds: 25 were outstanding at once on a real stalled panel. Each one also holds one
         of the desktop service worker's 32 host-resource permits, so the pile can exhaust that budget for every panel in
         every window. Measured against the code before the guard: 5 started and none given up on. */
      const stalled = harness.run(browser, { turns: SHORT, focus: true, grows: 1, idleMs: 13000, stallProbe: true,
        efforts: { sid: '00000000-0000-4000-8000-00000000abcd', css: '#cce-effort{--cce-effort:""}\n' } });
      if (!stalled.error && stalled.probesMade <= 3 && stalled.probesCancelled >= 1) {
        ok(`a poll whose request never answers keeps one in flight and drops it (${stalled.probesMade} started, `
          + `${stalled.probesCancelled} given up on in 13s)`);
      } else {
        bad('a stalled poll piles up requests, each holding a service-worker permit: '
          + (stalled.error || `${stalled.probesMade} started, ${stalled.probesCancelled} given up on`));
      }
      /* Nobody is reading a panel in a window that is not on screen, and several editor windows at once is the ordinary
         case, so the poll drops to a crawl for a backgrounded window. Measured over the same 13 seconds. */
      const probeRate = (opts) => harness.run(browser, Object.assign({ turns: SHORT, focus: true, grows: 1,
        idleMs: 13000, efforts: { sid: '00000000-0000-4000-8000-00000000abcd', css: '#cce-effort{--cce-effort:""}\n' } },
        opts));
      const seen = probeRate({}), unseen = probeRate({ windowHidden: true });
      if (!seen.error && !unseen.error && seen.probesMade >= 4 && unseen.probesMade <= 1) {
        ok(`a window in the background is polled at a crawl (${seen.probesMade} requests on screen, `
          + `${unseen.probesMade} off it, in 13s)`);
      } else {
        bad('the poll does not slow down for a window nobody is looking at: '
          + (seen.error || unseen.error || `${seen.probesMade} on screen, ${unseen.probesMade} off it`));
      }
      /* A reply growing is what drives sweeps in use. Ordering two messages costs the browser a walk along every message
         between them, so a sweep that compares at all costs in proportion to the conversation squared. */
      /* The text observer keeps its scroller while the messages are still in it; finding it again reads every
         ancestor's style and forces a style pass mid-sweep. */
      const styled = runs.filter(([, r]) => r.growGcs !== 0);
      if (!styled.length) ok('while a reply grows, a sweep reads no computed style');
      else bad('while a reply grew, sweeps read the computed style: ' + styled.map(([what, r]) => `${what}: ${r.growGcs} reads in ${r.growSweeps} sweeps`).join('; '));
      /* One childList observer on the whole document; the message list's observer watches text only, or changes inside
         the list would arrive twice. */
      const watchers = runs.filter(([, r]) => !((r.observed || []).filter((o) => o.childList).length === 1
        && (r.observed || []).some((o) => o.characterData && !o.childList)));
      if (!watchers.length) ok('one observer watches for children coming and going, and the message list\'s watches text alone');
      else bad('what the page\'s observers watch: ' + watchers.map(([what, r]) => `${what}: ${JSON.stringify(r.observed)}`).join('; '));
      /* The Focus view tool clock's own text updates start no sweep, and its two forms are measured together: one
         layout per text change. */
      const clocked = harness.run(browser, { turns: 20, focus: true, busyClock: true });
      // Either form: which one shows depends on how wide the window is.
      if (!clocked.error && /^Bash (\d+s|running for \d+s \(since [\d:]+\))$/.test(clocked.clockText) && clocked.idleSweeps === 0
          && clocked.clockWrites > 0 && clocked.clockLayouts * 2 <= clocked.clockWrites) {
        ok(`the tool clock counting seconds starts no sweep, and lays the page out once per change (${clocked.clockLayouts} for ${clocked.clockWrites} text writes)`);
      } else bad('the tool clock while it counts: ' + (clocked.error || JSON.stringify({ text: clocked.clockText, sweeps: clocked.idleSweeps,
        writes: clocked.clockWrites, layouts: clocked.clockLayouts })));
      const busy = runs.filter(([, r]) => !(r.growSweeps >= 4 && r.growCdp === 0 && r.growText === 0));
      if (!busy.length) ok('while a reply grows, a sweep compares no positions and writes no text');
      else bad('while a reply grew: ' + busy.map(([what, r]) =>
        `${what}: ${r.growSweeps} sweeps, ${r.growCdp} order comparisons, ${r.growText} text writes`).join('; '));
      /* Four times the conversation may cost up to four times the walking, no more; the queries and the messages worked
         out in full do not grow at all. */
      const ratio = LONG / SHORT;
      const perSweep = (r) => r.growQsa / Math.max(1, r.growSweeps);
      if (long.fiber <= short.fiber * ratio * 1.5 && perSweep(long) <= perSweep(short) * 1.25 && long.full <= 64 && short.full <= 64) {
        ok(`four times the conversation: ${(long.fiber / short.fiber).toFixed(1)}x the walking, the same queries, at most 64 replies worked out`);
      } else bad(`four times the conversation: walking ${short.fiber} -> ${long.fiber}, queries per sweep ${perSweep(short)} -> `
        + `${perSweep(long)}, replies worked out ${short.full} -> ${long.full}`);
      /* Each of your messages costs one walk up the React tree and one time format; later sweeps reuse the cached
         result, so neither grows with the conversation. Formatting is counted by Date objects created. */
      const datesPer = (r) => r.growDates / Math.max(1, r.growSweeps);
      if (long.fiber <= short.fiber * 1.1 && datesPer(long) <= datesPer(short) * 1.1) {
        ok(`your messages are walked and timed once each: four times as many leave ${long.fiber} steps and ${datesPer(long)} dates a sweep`);
      } else bad(`with four times as many messages, the steps up React trees went ${short.fiber} -> ${long.fiber} and the dates `
        + `made per sweep ${datesPer(short)} -> ${datesPer(long)}`);
      /* In a sub-agent's view the contents list shows that agent's tool calls, including those in replies far behind
         the newest. */
      const early = harness.run(browser, { turns: SHORT, subagentTurn: 5, pickView: true });
      if (!early.error && early.picked && early.railInView && early.tocInView.length === 1 && /Bash ls$/.test(early.tocInView[0])) {
        ok('in the view of a sub-agent whose reply is far behind the newest, the contents list holds its tool call');
      } else bad('the contents list in the view of an early sub-agent: ' + (early.error || JSON.stringify(
        { picked: early.picked, rail: early.railInView, rows: (early.tocInView || []).slice(0, 3) })));
      /* A new prompt rebuilds the contents list, and placing each compaction rule may take one halving of the prompts. */
      const bound = (r) => r.compactions * (Math.ceil(Math.log2(r.prompts + 1)) + 1);
      if (short.rebuildCdp > 0 && short.rebuildCdp <= bound(short) && long.rebuildCdp <= bound(long)) {
        ok(`rebuilding the contents list places compaction rules by halving: ${long.rebuildCdp} comparisons for `
          + `${long.compactions} rules among ${long.prompts} prompts`);
      } else bad(`rebuilding the contents list took ${short.rebuildCdp} and ${long.rebuildCdp} comparisons, against bounds of `
        + `${bound(short)} and ${bound(long)}`);
    }
  }
}

/* ── 2c. what the periodic work reads ──
   Each of these runs on a timer for as long as a window is open, against files that only grow. Counted in bytes, in a
   child process with the file functions wrapped, so what is measured is the module's own reads. A pass over a file that
   has not changed reads nothing, and a pass after an append reads the append. */
console.log('\nwhat the periodic work reads');
{
  const src = path.join(__dirname, '..', 'src');
  const counting = `
    const fs = require('fs'), os = require('os'), path = require('path');
    const seen = { bytes: 0, files: [] };
    const orig = { readFileSync: fs.readFileSync, readSync: fs.readSync, open: fs.promises.open };
    fs.readFileSync = function (file, ...rest) {
      const out = orig.readFileSync.call(fs, file, ...rest);
      seen.bytes += typeof out === 'string' ? Buffer.byteLength(out) : out.length;
      seen.files.push(String(file));
      return out;
    };
    fs.readSync = function (fd, ...rest) { const n = orig.readSync.call(fs, fd, ...rest); seen.bytes += n; return n; };
    fs.promises.open = async function (file, ...rest) {
      const fh = await orig.open.call(fs.promises, file, ...rest), read = fh.read.bind(fh);
      fh.read = async (...a) => { const r = await read(...a); seen.bytes += r.bytesRead; return r; };
      seen.files.push(String(file));
      return fh;
    };
    const measure = async (f) => {
      const b = seen.bytes, n = seen.files.length;
      await f();
      return { bytes: seen.bytes - b, files: seen.files.slice(n) };
    };`;
  const script = counting + `
    const bg = require(${JSON.stringify(path.join(src, 'background.js'))});
    const L = require(${JSON.stringify(path.join(src, 'openlatency.js'))});
    const E = require(${JSON.stringify(path.join(src, 'efforts.js'))});
    (async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-reads-'));
      try {
        const jobs = path.join(root, 'jobs'), plans = path.join(root, 'plans');
        fs.mkdirSync(path.join(jobs, '1a2b3c4d'), { recursive: true });
        fs.mkdirSync(plans);
        fs.writeFileSync(path.join(jobs, '1a2b3c4d', 'state.json'), JSON.stringify({ state: 'working', name: 'x' }));
        const SID = 'cccccccc-1111-2222-3333-444444444444';
        const transcript = path.join(root, SID + '.jsonl');
        const row = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(900) }] } }) + '\\n';
        fs.writeFileSync(transcript, row.repeat(4096));
        const before = fs.statSync(transcript).size;
        const opts = { dir: plans, jobs, transcript };
        const scan1 = await measure(() => bg.scan(SID, opts));
        const eff1 = await measure(() => E.scan(SID, { dir: plans, transcript }));
        const more = row.repeat(20);
        fs.appendFileSync(transcript, more);
        const scan2 = await measure(() => bg.scan(SID, opts));
        const scan3 = await measure(() => bg.scan(SID, opts));
        const eff2 = await measure(() => E.scan(SID, { dir: plans, transcript }));
        const eff3 = await measure(() => E.scan(SID, { dir: plans, transcript }));
        // Both started together, as a refresh and a switch of conversation start them, on a conversation neither has read.
        const SID2 = 'cccccccc-1111-2222-3333-555555555555', fresh = path.join(root, SID2 + '.jsonl');
        fs.writeFileSync(fresh, row.repeat(4096));
        const both = await measure(() => Promise.all([bg.scan(SID2, { dir: plans, jobs, transcript: fresh }), E.scan(SID2, { dir: plans, transcript: fresh })]));
        fs.writeFileSync(path.join(plans, 'dddddddd-1111-2222-3333-444444444444.background'),
          JSON.stringify({ ids: ['1a2b3c4d'], scannedTo: 10 }));
        const collect = await measure(() => bg.collect({ dir: plans, jobs }));
        const log = path.join(root, 'Anthropic.claude-code.log');
        const line = '2026-10-05 00:00:00.000 [info] nothing to pair here ' + 'y'.repeat(80) + '\\n';
        fs.writeFileSync(log, line.repeat(16384));
        const logBefore = fs.statSync(log).size;
        let state = {};
        const sample = () => { state = L.sample({ log, dir: root, state, version: 'v', pid: 7 }).state; };
        const log1 = await measure(sample);
        const logMore = line.repeat(10);
        fs.appendFileSync(log, logMore);
        const log2 = await measure(sample);
        const log3 = await measure(sample);
        process.stdout.write(JSON.stringify({
          transcript: before, appended: Buffer.byteLength(more),
          scan: [scan1.bytes, scan2.bytes, scan3.bytes], efforts: [eff1.bytes, eff2.bytes, eff3.bytes], collectFiles: collect.files,
          both: both.bytes,
          log: logBefore, logAppended: Buffer.byteLength(logMore), logReads: [log1.bytes, log2.bytes, log3.bytes] }));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    })().catch((e) => process.stdout.write(JSON.stringify({ error: e.message })));`;
  let r;
  try { r = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })); }
  catch (e) { r = { error: e.message }; }
  if (r.error) bad('measuring the periodic reads failed: ' + r.error);
  else {
    const [s1, s2, s3] = r.scan;
    if (s1 >= r.transcript && s2 <= r.appended && s3 === 0) {
      ok(`the background-session scan reads a transcript once, then only what was added: ${s1}, ${s2}, ${s3} bytes`);
    } else bad(`the background-session scan read ${s1}, ${s2} and ${s3} bytes of a ${r.transcript}-byte transcript `
      + `with ${r.appended} appended between the first two passes`);
    const [e1, e2, e3] = r.efforts;
    if (e1 >= r.transcript && e2 <= r.appended && e3 === 0) {
      ok(`the reply-effort scan reads a transcript once, then only what was added: ${e1}, ${e2}, ${e3} bytes`);
    } else bad(`the reply-effort scan read ${e1}, ${e2} and ${e3} bytes of a ${r.transcript}-byte transcript `
      + `with ${r.appended} appended between the first two passes`);
    if (r.both >= r.transcript && r.both < r.transcript * 1.5) {
      ok(`the two scans started together on an unread transcript share one pass over it: ${r.both} bytes for a ${r.transcript}-byte file`);
    } else bad(`the two scans started together read ${r.both} bytes of a ${r.transcript}-byte transcript`);
    if (r.collectFiles.length && !r.collectFiles.some((f) => f.endsWith('.jsonl'))) {
      ok('collecting what the background sessions are doing opens no transcript');
    } else bad('collecting the background sessions read: ' + JSON.stringify(r.collectFiles));
    const [l1, l2, l3] = r.logReads;
    // One byte before the offset comes too: it says whether the offset sat on a line boundary.
    if (l1 >= r.log && l2 <= r.logAppended + 1 && l3 === 0) {
      ok(`the open-latency sampler reads the log once, then only what was added: ${l1}, ${l2}, ${l3} bytes`);
    } else bad(`the open-latency sampler read ${l1}, ${l2} and ${l3} bytes of a ${r.log}-byte log with ${r.logAppended} appended`);
  }

}

/* ── 2d. what the hooks read of a transcript ──
   Every hook is handed the transcript's path, and a transcript runs to hundreds of megabytes. A hook that reads it
   whole is a hook that costs seconds on every turn, so each one is run against a small transcript and a 48 MB one and
   the difference in what it read is the part of the transcript it took. The count is the kernel's, from /proc/self/io
   as the process exits, so it is exact and there is no timing in it. The control - a script that does read the whole
   transcript - is what shows the count can see a read at all. */
console.log('\nwhat the hooks read of a transcript');
{
  if (!fs.existsSync('/proc/self/io')) note('skipped: no /proc/self/io here, which is how a process says how much it read');
  else {
    const hooksDir = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-hook-reads-'));
    try {
      const SID = '46000000-0000-0000-0000-000000000000';
      const data = path.join(dir, 'data');
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, SID + '.json'), JSON.stringify({ nodes: [{ title: 'a', state: 'todo' }] }));
      // A zone no machine running this is likely to be in, so the time-zone hook goes on to read the context size.
      fs.writeFileSync(path.join(data, 'client-time-zone.json'), JSON.stringify({ timeZone: 'Pacific/Kiritimati' }));
      const prompt = JSON.stringify({ type: 'user', message: { content: 'go on' }, timestamp: '2026-10-05T00:00:00.000Z' }) + '\n';
      const row = JSON.stringify({ type: 'assistant', timestamp: '2026-10-05T00:00:01.000Z',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls ' + 'q'.repeat(900) } }] } }) + '\n';
      const tiny = path.join(dir, 'tiny.jsonl'), big = path.join(dir, 'big.jsonl');
      fs.writeFileSync(tiny, prompt + row);
      const fd = fs.openSync(big, 'w');
      try {
        const chunk = row.repeat(1024);
        for (let written = 0; written < 48 << 20; written += Buffer.byteLength(chunk)) fs.writeSync(fd, chunk);
        fs.writeSync(fd, prompt + row);
      } finally { fs.closeSync(fd); }
      const wrapper = path.join(dir, 'reads.py');
      fs.writeFileSync(wrapper, [
        'import atexit, os, runpy, sys',
        'def report():',
        '    with open("/proc/self/io") as fh:',
        '        for line in fh:',
        '            if line.startswith("rchar:"):',
        '                sys.stderr.write("CCE-RCHAR " + line.split()[1] + "\\n")',
        'atexit.register(report)',
        'script = sys.argv[1]',
        'sys.argv = sys.argv[1:]',
        'sys.path.insert(0, os.path.dirname(os.path.abspath(script)))',
        'sys.dont_write_bytecode = True',
        'runpy.run_path(script, run_name="__main__")',
      ].join('\n') + '\n');
      const control = path.join(dir, 'whole.py');
      fs.writeFileSync(control, 'import json, sys\npath = json.load(sys.stdin)["transcript_path"]\nwith open(path, "rb") as fh:\n    fh.read()\n');
      const readOf = (script, payload) => {
        const r = cp.spawnSync('python3', [wrapper, script, data], { input: JSON.stringify(payload), encoding: 'utf8' });
        const m = /CCE-RCHAR (\d+)/.exec(r.stderr || '');
        return m ? Number(m[1]) : NaN;
      };
      const hooks = [
        ['inject-work-plan.py', { hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }],
        ['remind-work-plan.py', { hook_event_name: 'PostToolBatch', prompt_id: 'p1',
          tool_calls: [{ tool_name: 'Read', tool_input: { file_path: '/elsewhere/a.js' } }] }],
        ['guard-work-plan.py', { hook_event_name: 'PreToolUse', tool_name: 'Edit',
          tool_input: { file_path: '/elsewhere/a.js', old_string: 'a', new_string: 'b' } }],
        ['nudge-work-plan.py', { hook_event_name: 'Stop' }],
        ['refresh-work-plan.py', { hook_event_name: 'Stop' }],
        ['resume-work-plan.py', { hook_event_name: 'SessionStart', source: 'compact' }],
        ['tell-time-zone.py', { hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }],
      ];
      const took = (script, extra) => {
        const payload = (t) => Object.assign({ session_id: SID, transcript_path: t }, extra);
        return readOf(script, payload(big)) - readOf(script, payload(tiny));
      };
      const whole = took(control, {});
      const size = fs.statSync(big).size;
      const results = hooks.map(([name, extra]) => [name, took(path.join(hooksDir, name), extra)]);
      const LIMIT = 8 << 20;
      if (!(whole >= size * 0.95)) bad(`the control read ${whole} more bytes of a ${size}-byte transcript, so the count cannot see a whole read`);
      else if (results.every(([, n]) => Number.isFinite(n) && n <= LIMIT)) {
        ok(`no hook reads a transcript whole: of ${size >> 20} MB, ` + results.map(([name, n]) =>
          `${name.replace('-work-plan.py', '')} ${(n / 1048576).toFixed(1)} MB`).join(', '));
      } else bad(`a hook read more than ${LIMIT >> 20} MB of a ${size >> 20} MB transcript: `
        + results.map(([name, n]) => `${name} ${n}`).join(', '));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/* Every mutation observer has to go through the callback that labels a new block before the browser paints it. There are
   two of them watching different roots, and wiring only one leaves half the blocks appearing at full height and then
   collapsing - the symptom this was written to remove, at half the rate, which reads as the fix not having worked rather
   than as a missed line. Nearly happened while writing it. */
{
  const observers = [...webview.SCRIPT.matchAll(/new MutationObserver\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const direct = observers.filter((n) => n !== 'onMutations');
  if (observers.length >= 2 && !direct.length) ok(`all ${observers.length} mutation observers label a new block before it paints`);
  else if (!observers.length) bad('no mutation observer found in the injected script');
  else bad(`mutation observer(s) bypass the labelling callback: ${direct.join(', ')}`);
}

/* ── 3. shape selection itself ──
   An edit may carry several alternative shapes for builds that differ. The rule is that exactly one shape must match
   exactly once: a shape matching twice is as unusable as one matching never, since neither identifies a single site.
   Checked on synthetic input, because the real bundles only exercise whichever shape they happen to carry. */
console.log('\nshape selection');
{
  const shape = (re, note) => ({ re, to: () => 'X', note });
  const cases = [
    ['first shape wins when it fits', 'aaa bbb', [shape(/aaa/g, 'new'), shape(/bbb/g, 'old')], 0],
    ['falls through to the shape that fits', 'only bbb here', [shape(/aaa/g, 'new'), shape(/bbb/g, 'old')], 1],
    ['a shape matching twice is skipped', 'bbb aaa aaa', [shape(/aaa/g, 'new'), shape(/bbb/g, 'old')], 1],
    ['no shape fits', 'nothing', [shape(/aaa/g, 'new'), shape(/bbb/g, 'old')], null],
  ];
  for (const [what, src, shapes, want] of cases) {
    const got = pickShape(src, { name: 'synthetic', shapes });
    if (want === null) {
      if (got.error && got.error.includes('2 known shapes')) ok(what);
      else bad(`${what}: expected a refusal naming both shapes, got ${JSON.stringify(got.error || got.index)}`);
    } else if (got.index === want) ok(what);
    else bad(`${what}: expected shape ${want + 1}, got ${got.error || 'shape ' + (got.index + 1)}`);
  }
  /* Without the g flag two matching places would count as one, and the edit would go to the first. */
  const lone = pickShape('aaa then aaa', { name: 'no flag', re: /aaa/, to: () => 'X' });
  if (lone.error && /g flag/.test(lone.error)) ok('a pattern without the g flag is refused rather than counted wrong');
  else bad(`a pattern without the g flag gave ${JSON.stringify(lone)}`);
  /* Several megabytes, on the extension host: each shape is scanned once, and the replacement goes at the offset the
     count found, without a second pass. */
  {
    const { applyEdits } = require('../src/edits');
    let passes = 0;
    class Counting extends RegExp {
      [Symbol.match](s) { passes++; return super[Symbol.match](s); }
      [Symbol.matchAll](s) { passes++; return super[Symbol.matchAll](s); }
      [Symbol.replace](s, r) { passes++; return super[Symbol.replace](s, r); }
    }
    const src = 'k1 (?) k2 a=1;b=2 k3';
    const r = applyEdits(src, [
      { name: 'function', re: new Counting('(?<=k2 )a=(\\d);b=(\\d)', 'g'), to: (m, x, y, at, whole) => `b=${y};a=${x}@${at}/${whole.length}` },
      { name: 'string', re: /k(3)/g, to: 'K$1' },
    ]);
    const want = src.replace(/(?<=k2 )a=(\d);b=(\d)/g, (m, x, y, at, whole) => `b=${y};a=${x}@${at}/${whole.length}`).replace(/k(3)/g, 'K$1');
    if (r.out === want && passes === 1) ok('each edit scans the bundle once and is made where that scan found it, as a replace would make it');
    else bad(`applying edits gave ${JSON.stringify(r.out)} (expected ${JSON.stringify(want)}) after ${passes} pass(es) over the source`);
  }
}

/* ── 4. the edits, against a pristine bundle ──
   Finding a bundle and getting its unpatched source come from build/supported.js, which needs exactly the same two
   things to decide which builds go into the record of verified versions. They were written out twice here first, and
   two copies of "where does an unpatched bundle come from" is the kind of pair that drifts without anything failing:
   the record would then attest to something the checks never looked at. */
const { pristine, extensionsDirs } = supported;

/* How often each alternative shape was the one that fitted. A shape no checked build reaches any more cannot be
   verified by anything, and would sit there rotting silently, so it is reported at the end. */
const shapeUse = new Map();
const shapeKey = (adapter, edit, i) => [adapter.name, edit.name, i].join('\u0000');

function checkEdits(adapter, src, label) {
  for (const e of adapter.EDITS) {
    const picked = pickShape(src, e);
    if (picked.error) { bad(`${label}: ${picked.error}`); continue; }
    for (let i = 0; i < picked.total; i++) {
      const k = shapeKey(adapter, e, i);
      if (!shapeUse.has(k)) shapeUse.set(k, { adapter, edit: e, index: i, hits: 0 });
    }
    shapeUse.get(shapeKey(adapter, e, picked.index)).hits++;
    const which = picked.total > 1
      ? ` (shape ${picked.index + 1} of ${picked.total}${picked.note ? ': ' + picked.note : ''})`
      : '';
    ok(`${label}: "${e.name}" matches once${which}`);
  }
  const r = adapter.patchSource(src);
  if (r.error) bad(`${label}: patchSource refused: ${r.error}`);
  else if (!r.out.includes(adapter.MARK)) bad(`${label}: patched output carries no marker`);
  else ok(`${label}: patched output parses and is marked`);
  if (adapter.name === 'Claude Code panel') { checkReplyShape(src, label); checkRowIds(src, label); }
}

/* Text colors find a conversation's rows by the end of their id (84-session-colors.js). No edit covers how the list
   builds that id, so it is checked here. */
function checkRowIds(src, label) {
  const n = [...src.matchAll(/function [\w$]+\(([\w$]+),([\w$]+)\)\{return`\$\{[\w$]+\}-row-\$\{\1\.sessionId\.value\?\?\2\}`\}/g)].length;
  if (n === 1) ok(`${label}: a session list row's id ends in its session ID`);
  else bad(`${label}: the session list's row id was built in ${n} places (expected 1); text colors find rows by it`);
}

/* What a reply holds, read out of the real bundle (test/reply-shape.js says why the stand-in panel cannot tell). The
   page script puts a reply's figures on its first block, behind any row of the panel's own; a child of a kind not seen
   before is a change in the panel nobody has checked that against, so it fails here - before the version record can
   call the build verified, and in the scheduled run against the marketplace before the update arrives. */
const replyShape = require('./reply-shape');
// Refusal rows render only for a gateway refusal, in place of the blocks.
const KNOWN_REPLY_CHILDREN = ['time line', 'mod rows', 'refusal', 'blocks', 'actions'];
function checkReplyShape(src, label) {
  const r = replyShape.replyChildren(src);
  if (r.error) { bad(`${label}: what a reply holds could not be read: ${r.error}`); return; }
  const kinds = r.children.map((c) => c.kind);
  const strange = r.children.filter((c) => !KNOWN_REPLY_CHILDREN.includes(c.kind));
  if (kinds.filter((k) => k === 'blocks').length !== 1) bad(`${label}: a reply's blocks are not one child of it any more (${kinds.join(', ')})`);
  else if (strange.length) bad(`${label}: a reply holds a child not seen before - check where the figures land: `
    + strange.map((c) => c.code.slice(0, 120)).join(' | '));
  else ok(`${label}: a reply holds ${kinds.join(', ')}, all of them known`);
}

/* Not a failure: a shape kept for older builds is expected to go unused once those builds are gone from this machine.
   It is worth saying out loud, because from then on nothing here can tell whether it still works. */
function reportUnusedShapes() {
  const idle = [...shapeUse.values()].filter((s) => s.hits === 0);
  if (!idle.length) return;
  console.log('\nshapes no checked build needed');
  for (const s of idle) {
    const note = s.edit.shapes && s.edit.shapes[s.index] && s.edit.shapes[s.index].note;
    console.log(`  note  ${s.adapter.name}: "${s.edit.name}" shape ${s.index + 1}${note ? ' (' + note + ')' : ''}`);
  }
}

console.log('\nwhat a reply holds, read from a bundle');
{
  const rs = require('./reply-shape');
  const stamp = 'function sA({message:$,context:J,placement:Z,busy:X}){if(!J.on)return null;return F(sB,{at:1})}'
    + 'function sB({at:$}){return F("div",{"data-message-stamp":"",children:$})}';
  const reply = (kids) => stamp + 'var M=function({message:Z,context:X}){return R("div",{"data-testid":"assistant-message",role:"article",'
    + 'children:[' + kids + ']})};';
  const known = rs.replyChildren(reply('F(sA,{message:Z,context:X,placement:"response",busy:J.busy}),Z.content.map((W)=>F(B,{content:W,s:"a,]b"})),'
    + 'H&&R("div",{className:k0.assistantActions,children:[1]})'));
  const extra = rs.replyChildren(reply('F(sA,{message:Z,context:X,placement:"response",busy:J.busy}),F(Q9,{message:Z}),Z.content.map((W)=>F(B,{content:W}))'));
  const kinds = (r) => (r.children || []).map((c) => c.kind).join(', ');
  if (kinds(known) === 'time line, blocks, actions') ok('a time line ahead of the blocks and an action bar after them are each named, past a bracket inside a string');
  else bad(`the known shape read as "${kinds(known)}"${known.error ? ' - ' + known.error : ''}`);
  if (kinds(extra) === 'time line, unknown, blocks') ok('a child of a kind not seen before is named unknown');
  else bad(`an unseen child read as "${kinds(extra)}"`);
  const modded = (prop) => stamp + 'var M=function({message:Z,context:X,engineRow:V}){return R("div",{"data-testid":"assistant-message",'
    + 'children:[F(sA,{message:Z,context:X,placement:"response",busy:J.busy}),' + prop + '?.ink(!1),Z.content.map((W)=>F(B,{content:W}))]})};';
  if (kinds(rs.replyChildren(modded('V'))) === 'time line, mod rows, blocks') ok('the rows a mod draws for the reply are named');
  else bad(`a mod's rows read as "${kinds(rs.replyChildren(modded('V')))}"`);
  if (kinds(rs.replyChildren(modded('U'))) === 'time line, unknown, blocks') ok('but only when they come from the engineRow prop');
  else bad(`an ink call on another prop read as "${kinds(rs.replyChildren(modded('U')))}"`);
  const refused = stamp + 'var M=function({message:Z,context:X,gatewayRefusal:L}){let G=L?.sentence===void 0?Z.content:[];'
    + 'return R("div",{"data-testid":"assistant-message",children:[F(sA,{message:Z,context:X,placement:"response",busy:J.busy}),'
    + 'L?.sentence!==void 0&&F(oc,{content:L.sentence}),L?.signInLabel!==void 0&&F(Ys,{children:L.signInLabel}),'
    + 'G.map((W)=>F(B,{content:W})),Q.map((W)=>F(B,{content:W}))]})};';
  if (kinds(rs.replyChildren(refused)) === 'time line, refusal, refusal, blocks, unknown') {
    ok('a gateway refusal\'s rows are recognised, and so are the blocks it empties');
  } else bad(`a reply with a refusal read as "${kinds(rs.replyChildren(refused))}"`);
}

console.log('\nedits');
// Bundle paths to check instead of the installed ones. Options are not paths: passing one used to be reported as
// "no patch target is named --without-version-record", which reads as a broken suite rather than a misread flag.
const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (explicit.length) {
  for (const arg of explicit) {
    const base = path.basename(arg).replace(/\.[^.]*\.bak$/, '');
    const adapter = ADAPTERS.find((a) => base === path.basename(a.targetFile('')));
    if (!adapter) { bad(`${arg}: no patch target is named ${base}`); continue; }
    if (!fs.existsSync(arg)) { bad(`${arg}: not found`); continue; }
    const src = fs.readFileSync(arg, 'utf8');
    if (src.includes(adapter.ANY_MARK)) { bad(`${arg}: already carries our marker, so it is not pristine`); continue; }
    checkEdits(adapter, src, `${adapter.name} <- ${arg}`);
  }
} else {
  let seen = 0;
  for (const dir of Array.from(new Set(extensionsDirs()))) {
    for (const install of webview.findInstalls(dir)) {
      seen++;
      for (const adapter of ADAPTERS) {
        const file = adapter.targetFile(install);
        const p = pristine(file, adapter);
        const where = `${adapter.name} (${path.basename(install)})`;
        if (!p) { bad(`${where}: no pristine source available (patched, and no backup)`); continue; }
        if (p.foreign) { console.log(`  skip  ${where}: another patcher owns this file (${p.foreign})`); continue; }
        checkEdits(adapter, p.src, `${where}, from ${p.from}`);
      }
    }
  }
  if (!seen) note('no Claude Code install found; pass a bundle path to check the edits');
}

reportUnusedShapes();

/* ── 3b. what the model-pill rule actually decides ──
   Matching once says the rule found its place, not that the comparison it leaves behind is right. This runs the
   rewritten comparison itself on the cases that matter: the Bedrock pair that differed only by provider prefix and made
   every reply look like a fallback; a reply from a genuinely different model, which must still count as one, since that
   is the pill's whole reason for comparing; and a 200K pick, which must not be swept into looking like 1M. `strip` is
   the panel's own helper - it removes the 1M marker and nothing else. */
/* ── 3c. the table of contents' top and bottom buttons ──
   Run against a stand-in scroller, since what can go wrong is arithmetic rather than layout: landing short of the end,
   or chasing an end that has moved. A reply still streaming makes the conversation longer while the view is on its way
   down, so the bottom is asserted to be re-measured on the next attempt rather than fixed at the click. */
console.log('\nthe top and bottom buttons');
{
  const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '45-toc.js'), 'utf8');
  const scroller = {
    scrollTop: 1200, scrollHeight: 5000, clientHeight: 500, parentElement: null,
    scrollTo(o) { this.scrollTop = Math.max(0, Math.min(o.top, this.scrollHeight - this.clientHeight)); },
    getBoundingClientRect() { return { top: 0 }; }, addEventListener() {}, removeEventListener() {},
  };
  const message = {
    isConnected: true, parentElement: scroller,
    getBoundingClientRect() { return { top: 100, height: 40, width: 200 }; },
  };
  const ticks = [];
  const box = {
    out: {}, message, ASSIST: 'x', USER: 'y', SEND: 'z',
    document: { querySelector: () => null, documentElement: { scrollHeight: 0 } },
    window: { scrollY: 0, innerHeight: 0, addEventListener() {}, removeEventListener() {} },
    getComputedStyle: (el) => ({ overflowY: el === scroller ? 'auto' : 'visible' }),
    setInterval: (f) => { ticks.push(f); return ticks.length; },
    clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
  };
  new vm.Script(`(function(){${fragment}\n;PROMPT_EL.push(message); out.jumpEdge = jumpEdge;})()`, { filename: '45-toc.js' })
    .runInNewContext(box);
  box.out.jumpEdge(true);
  if (scroller.scrollTop === 4500) ok('to the bottom lands at the very end');
  else bad(`to the bottom left the view at ${scroller.scrollTop}, expected 4500`);
  scroller.scrollHeight = 6000;           // a reply grows while the view is held at the end
  ticks[ticks.length - 1]();
  if (scroller.scrollTop === 5500) ok('and follows the end when the conversation grows meanwhile');
  else bad(`the hold did not follow a longer conversation: ${scroller.scrollTop}, expected 5500`);
  box.out.jumpEdge(false);
  if (scroller.scrollTop === 0) ok('to the top lands at the very start');
  else bad(`to the top left the view at ${scroller.scrollTop}`);

  /* One hold at a time, and the keydown that starts a hold must not stop it. The , and . keys start one from a document
     keydown listener, and that keydown then reaches the window, where a listener added during the dispatch also
     runs. */
  {
    const live = new Set(), soon = new Map(), heard = [];
    let iv = 0, to = 0;
    const env = Object.assign({}, box, { out: {},
      window: { scrollY: 0, innerHeight: 0, removeEventListener: (t, f) => { const i = heard.indexOf(f); if (i >= 0) heard.splice(i, 1); },
        addEventListener: (t, f) => { if (t === 'keydown') heard.push(f); } },
      setInterval: () => { live.add(++iv); return iv; }, clearInterval: (id) => { live.delete(id); },
      setTimeout: (f) => { soon.set(++to, f); return to; }, clearTimeout: (id) => { soon.delete(id); } });
    new vm.Script(`(function(){${fragment}\n;PROMPT_EL.push(message); out.jumpEdge = jumpEdge;})()`, { filename: '45-toc.js' })
      .runInNewContext(env);
    const nextTurn = () => { const due = [...soon.values()]; soon.clear(); due.forEach((f) => f()); };
    const key = (k) => heard.slice().forEach((f) => f({ key: k }));
    env.out.jumpEdge(true); env.out.jumpEdge(false);
    const one = live.size;
    nextTurn(); key('x');
    const stoppedByKey = live.size === 0;
    env.out.jumpEdge(true);
    key('.');
    const outlived = live.size;
    if (one === 1 && stoppedByKey && outlived === 1) {
      ok('a second jump stops the first one\'s hold, a key pressed afterwards stops a hold, and the key that began one does not');
    } else bad(`holds: ${one} running after two jumps, stopped by a later key ${stoppedByKey}, ${outlived} left after the key that began it`);
  }
}

console.log('\nthe model pill comparison');
{
  const rule = webview.EDITS.find((e) => e.name === 'model pill ignores provider prefix');
  const original = 'h(J)!==h($.resolvedModel??"")';
  const rewritten = original.replace(rule.re, rule.to);
  rule.re.lastIndex = 0;
  const differs = (expr) => new Function('h', 'J', '$', 'return ' + expr);
  const strip = (s) => s.replace(/\[1m\]$/i, '');
  const before = differs(original), after = differs(rewritten);
  const cases = [
    ['a 1M pick on Bedrock, answered by that same model', 'claude-opus-5-5', 'global.anthropic.claude-opus-5-5[1m]', false],
    ['a 200K pick on Bedrock, answered by that same model', 'claude-opus-5-5', 'global.anthropic.claude-opus-5-5', false],
    ['a regional prefix on the reply instead of the pick', 'us.anthropic.claude-opus-5-5', 'claude-opus-5-5[1m]', false],
    ['a reply from a different model than the one picked', 'claude-opus-5', 'global.anthropic.claude-opus-5-5[1m]', true],
  ];
  if (before(strip, cases[0][1], { resolvedModel: cases[0][2] }) === true) {
    ok('the unpatched comparison does call the Bedrock pair different, which is the bug being fixed');
  } else bad('the unpatched comparison no longer shows the bug, so this rule may be fixing nothing');
  for (const [what, served, pick, want] of cases) {
    const got = after(strip, served, { resolvedModel: pick });
    if (got === want) ok(`${what}: ${want ? 'still counts as a different model' : 'counts as the same model'}`);
    else bad(`${what}: the rewritten comparison said ${got ? 'different' : 'same'}`);
  }

  /* Our own per-reply line has the same fault - it shows the name the reply carries, which on Bedrock never says 1M -
     and puts the marker back from the pick. Same cases, plus the one that only it has: no pick known at all. */
  const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '75-turn-stats.js'), 'utf8');
  const box = { out: {} };
  new vm.Script(`(function(){${fragment}\n;out.withOneMillion = withOneMillion;})()`, { filename: '75-turn-stats.js' })
    .runInNewContext(box);
  const label = (served, pick) => box.out.withOneMillion(served,
    pick === undefined ? {} : { currentModelInfo: { value: { resolvedModel: pick } } });
  const shown = [
    ['a 1M pick answered by that model', 'claude-opus-5-5', 'global.anthropic.claude-opus-5-5[1m]', 'claude-opus-5-5[1m]'],
    ['a 200K pick answered by that model', 'claude-opus-5-5', 'global.anthropic.claude-opus-5-5', 'claude-opus-5-5'],
    ['a 1M pick answered by another model', 'claude-opus-5', 'global.anthropic.claude-opus-5-5[1m]', 'claude-opus-5'],
    ['no pick known yet', 'claude-opus-5-5', undefined, 'claude-opus-5-5'],
  ];
  for (const [what, served, pick, want] of shown) {
    const got = label(served, pick);
    if (got === want) ok(`our per-reply line, ${what}: shows ${want}`);
    else bad(`our per-reply line, ${what}: showed ${got}, expected ${want}`);
  }
}

/* ── 4a. the record of verified Claude Code builds ──
   One equality: the builds the record claims are exactly the builds this machine just verified. Both directions matter
   and for different reasons. A build claimed but not verifiable here means the commit asserts something nothing
   established - which happened, silently, while the record carried builds forward. A build verified here but missing
   from the record means an upgrade goes unrecorded for ever, because a record that is merely conservative never fails
   anything and so nothing ever asks for it to be written again.

   It can only be checked where the bundles are, so a runner with no Claude Code gets a skip rather than a pass, and
   enforcement is local. The place it reaches whoever is working here is this suite, which is the first step of finishing
   any change rather than a separate thing to remember.

   Skipped only by `--without-version-record`, which the one command that writes the record passes when it runs this
   suite first. That is not a way around the gate: this section fails in exactly the state that command exists to
   correct, so leaving it in would block the fix with the defect it fixes. */
/* ── a reopened conversation's window, and what its history is shown ──
   Reopened, the panel has the token count but no window: that arrives only on the message that closes a turn, which the
   transcript never records. These pin down when the page fills the window in, and that the history it replays does not
   pick up the current figures as if they were its own. */
console.log('\na reopened conversation');
{
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'page', f), 'utf8');
  const box = { out: {}, window: {}, sessionRef: null, isOn: () => true, isOff: () => false };
  new vm.Script(`(function(){${read('70-meter.js')}\n${read('75-turn-stats.js')}\n;` +
    'out.fillWindow = fillWindow; out.statAt = statAt;})()', { filename: 'reopened' }).runInNewContext(box);
  const session = (usage, pick) => ({
    usageData: { value: Object.assign({ totalTokens: 0, totalCost: 0, contextWindow: 0, maxOutputTokens: 0 }, usage) },
    currentModelInfo: { value: pick === undefined ? undefined : { resolvedModel: pick } },
    lastServedModel: { value: 'claude-opus-5-5' },
  });
  const fill = (usage, pick) => { box.sessionRef = session(usage, pick); box.out.fillWindow(); return box.sessionRef.usageData.value; };

  const cases = [
    ['a 1M pick with 957,707 tokens', { totalTokens: 957707 }, 'global.anthropic.claude-opus-5-5[1m]', 1000000],
    ['a standard pick with 150,000 tokens', { totalTokens: 150000 }, 'global.anthropic.claude-opus-5-5', 200000],
    ['a standard-looking pick holding 300,000 tokens', { totalTokens: 300000 }, 'claude-opus-5-5', 1000000],
    ['no pick known yet, 300,000 tokens', { totalTokens: 300000 }, undefined, 1000000],
    ['no pick known yet, 150,000 tokens', { totalTokens: 150000 }, undefined, 0],
    ['a token count of 0', { totalTokens: 0 }, 'global.anthropic.claude-opus-5-5[1m]', 0],
  ];
  for (const [what, usage, pick, want] of cases) {
    const got = fill(usage, pick).contextWindow;
    if (got === want) ok(want ? `${what}: the window is filled in as ${want}` : `${what}: nothing is filled in`);
    else bad(`${what}: the window came out ${got}, not ${want}`);
  }

  // The meter divides by the window less min(reserve, cap): a filled reserve must sit at or above any plausible cap,
  // and a real one must be left alone.
  const r0 = fill({ totalTokens: 957707 }, 'x[1m]').maxOutputTokens;
  const r1 = fill({ totalTokens: 957707, maxOutputTokens: 32000 }, 'x[1m]').maxOutputTokens;
  if (r0 >= 1e6 && r1 === 32000) ok('a missing reserve is filled above any cap, and a real one is kept');
  else bad(`the reserve came out ${r0} when missing and ${r1} when it was 32000`);

  box.sessionRef = session({ totalTokens: 500000, contextWindow: 1000000 }, 'x[1m]');
  const had = box.sessionRef.usageData.value;
  box.out.fillWindow();
  if (box.sessionRef.usageData.value === had) ok('a window the panel already has is left alone, object and all');
  else bad('fillWindow replaced a window the panel already had');

  box.sessionRef = session({ totalTokens: 500000 }, 'x[1m]');
  box.isOn = () => false;
  box.out.fillWindow();
  const offWin = box.sessionRef.usageData.value.contextWindow;
  box.isOn = () => true;
  if (offWin === 0) ok('with the extension switched off the panel is not touched');
  else bad('fillWindow wrote into the panel with the extension switched off');

  // The history: the newest reply shows the current share, an older one first seen afterwards shows only its model and
  // effort. Messages carry the model that served them, as the panel's do.
  box.sessionRef = session({ totalTokens: 957707, totalCost: 3.2 }, 'global.anthropic.claude-opus-5-5[1m]');
  box.out.fillWindow();
  const older = { id: 'older', model: 'claude-opus-5-5' }, newest = { id: 'newest', model: 'claude-opus-5-5' };
  const nowLine = box.out.statAt(newest, true, 'xhigh'), oldLine = box.out.statAt(older, false, 'max');
  if (/ctx 96%/.test(nowLine) && /cost \$3\.20/.test(nowLine) && / opus-5-5\[1m\] xhigh$/.test(nowLine)) {
    ok(`the newest reply shows the current figures, its model and its effort (${nowLine})`);
  } else bad(`the newest reply showed "${nowLine}"`);
  if (!/ctx|cost/.test(oldLine) && oldLine === 'opus-5-5[1m] max') ok(`a reply from before the page loaded shows its model and effort only (${oldLine})`);
  else bad(`a reply from before the page loaded showed "${oldLine}", taking figures that are not its own`);

  /* The model and effort are the reply's own. The session's values describe the next request - what the menu says, or
     what served the latest reply - and putting them under every reply is the fault this replaced. */
  box.sessionRef.lastServedModel = { value: 'claude-haiku-4-5' };
  box.sessionRef.currentMainLoopModel = { value: 'claude-haiku-4-5' };
  box.sessionRef.effortLevel = { value: 'low' };
  const own = box.out.statAt({ id: 'own', model: 'claude-opus-5' }, false, 'high');
  const unknown = box.out.statAt({ id: 'unknown', model: 'claude-opus-5' }, false, '');
  const synthetic = box.out.statAt({ id: 'synthetic' }, false, 'high');
  if (own === 'opus-5 high' && unknown === 'opus-5' && synthetic === '') {
    ok('a reply shows the model that served it and the effort it was sent with, never the session\'s current ones');
  } else bad(`with the session saying haiku and low: a reply showed "${own}", one of unknown effort "${unknown}", `
    + `one with no model "${synthetic}"`);

  // A reply that was the newest once keeps what it showed then, after a later one takes over.
  const first = { id: 'first', model: 'claude-opus-5-5' };
  box.out.statAt(first, true);
  box.sessionRef.usageData.value = Object.assign({}, box.sessionRef.usageData.value, { totalTokens: 980000 });
  const kept = box.out.statAt(first, false);
  if (/ctx 96%/.test(kept)) ok('a reply that was once the newest keeps its own figures afterwards');
  else bad(`a reply that was once the newest later showed "${kept}"`);
  // ...each of them shown by its switch as it is now: the share switched off afterwards leaves that reply too.
  box.isOff = (k) => k === 'contextShare';
  const keptShareOff = box.out.statAt(first, false);
  box.isOff = () => false;
  if (!/ctx/.test(keptShareOff) && /cost \$3\.20/.test(keptShareOff)) ok(`and a switch turned off later reaches those figures too (${keptShareOff})`);
  else bad(`with the context share switched off later, that reply showed "${keptShareOff}"`);
}

/* With the usage meter switch off the meter is Claude Code's own again (hidden while more than half the window is free,
   Claude Code's thresholds), and this script's arc trim and outline are removed. */
console.log('\nthe usage meter, kept on screen or left to Claude Code');
{
  const { applyEdits } = require('../src/edits');
  const pick = (name) => webview.EDITS.find((e) => e.name === name);
  const code = 'function Yy5($){if($<62.5)return 50;if($<87)return 75;return 99}var AI1=null;'
    + 'function vy0({usedTokens:$,contextWindow:J}){let Y=J>0?Math.min($/J*100,100):0,Q=AI1!==null?AI1:Y,z=100-Q;'
    + 'if(AI1===null){if(J===0)return null;if(z>=50)return null}return"meter"}';
  const r = applyEdits(code, [pick('context meter state thresholds'), pick('context meter always visible')]);
  if (r.error) bad('the meter edits did not apply to the meter\'s shape: ' + r.error);
  else {
    const meter = (kept) => {
      const env = { window: {} };
      if (kept !== undefined) env.window.__cceMeterKept = () => kept;
      vm.createContext(env);
      vm.runInContext(r.out, env);
      return JSON.stringify([env.Yy5(55), env.Yy5(80), env.vy0({ usedTokens: 10, contextWindow: 100 }), env.vy0({ usedTokens: 60, contextWindow: 100 })]);
    };
    const got = [meter(true), meter(false), meter(undefined)];
    const want = [JSON.stringify([75, 99, 'meter', 'meter']), JSON.stringify([50, 75, null, 'meter']), JSON.stringify([50, 75, null, 'meter'])];
    if (JSON.stringify(got) === JSON.stringify(want)) {
      ok('kept, the meter shows at 10% used with its states at their own extents; not kept, or with no page to ask, it is Claude Code\'s own');
    } else bad(`the meter kept, not kept and with no page to ask gave ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  let off = false;
  const arc = { style: {}, getTotalLength: () => 100 };
  const btn = { style: {}, getAttribute: () => '90% of context used', querySelector: () => arc, querySelectorAll: () => [arc] };
  const env = { window: {}, isOff: (k) => off && k === 'contextMeter', isOn: () => true, fiber: () => null,
    document: { querySelector: () => btn }, sessionRef: null };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '70-meter.js'), 'utf8'), env);
  const kept = () => (typeof env.window.__cceMeterKept === 'function' ? env.window.__cceMeterKept() : 'not asked');
  vm.runInContext('markCtxLow()', env);
  const drawn = [arc.style.strokeDasharray, btn.style.outline, kept()];
  off = true;
  vm.runInContext('markCtxLow()', env);
  const left = [arc.style.strokeDasharray, btn.style.outline, kept()];
  if (drawn[0] && drawn[1] && drawn[2] === true && !left[0] && !left[1] && left[2] === false) {
    ok('switched off, the page says the meter is not kept and takes off the trim and outline it drew');
  } else bad(`the meter on and then off: ${JSON.stringify(drawn)} -> ${JSON.stringify(left)}`);
}

/* The breakdown's loading note appears only while a request is in flight; only a reply removes it, so a note with
   nothing pending would stay as long as the pointer does. */
console.log('\nthe context breakdown on the usage meter');
{
  const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '55-context-detail.js'), 'utf8');
  const made = [], timers = [];
  const el = () => {
    const e = { style: {}, children: [], textContent: '', isConnected: true, parentElement: null,
      appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
      addEventListener(t, f) { (this.on = this.on || {})[t] = f; },
      getBoundingClientRect: () => ({ top: 500, bottom: 520, left: 280, right: 300 }) };
    made.push(e);
    return e;
  };
  const btn = el();
  btn.parentElement = { children: [btn] };
  const env = { out: {}, sessionRef: null, WeakSet, Date, window: { innerHeight: 800, innerWidth: 400 },
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: () => {},
    document: { querySelector: () => btn, createElement: el, body: { appendChild() {} } } };
  new vm.Script(`(function(){${fragment}\n;out.wire = wireCtxButton;`
    + 'out.keep = function(u, k){ ctxCache = u; ctxKey = k; ctxAt = Date.now(); };})()', { filename: '55-context-detail.js' })
    .runInNewContext(env);
  env.out.wire();
  const run = () => { const due = timers.splice(0); due.forEach((f) => f()); };
  const hover = () => { btn.on.mouseenter(); run(); };
  const leave = () => { btn.on.mouseleave(); run(); };
  const loading = () => made.some((e) => e.id === 'cce-ctx-note' && e.style.display === 'block' && e.textContent === 'Loading breakdown...');
  const usage = { totalTokens: 5 };
  const usageFigures = { categories: [], totalTokens: 5, rawMaxTokens: 100, percentage: 5, model: 'opus' };

  env.sessionRef = { usageData: { value: usage } };
  hover();
  const unaskable = loading();
  leave();
  env.sessionRef = { usageData: { value: usage }, getContextUsage: () => new Promise(() => {}) };
  env.out.keep(usageFigures, '5');
  hover();
  const inHand = loading();
  leave();
  env.out.keep(null, '');
  hover();
  const onItsWay = loading();
  if (!unaskable && !inHand && onItsWay) {
    ok('no loading note with no way to ask or with the breakdown already in hand, and one while it is being asked for');
  } else bad(`the loading note: with no way to ask ${unaskable}, with the breakdown in hand ${inHand}, while asking ${onItsWay}`);
}

/* ── the effort each reply was sent with ──
   Read by the extension from the transcripts (src/efforts.js) as the replies where it changed, handed to the page in a
   stylesheet per conversation, and carried forward by the page through its replies in order (76-effort.js). */
console.log('\nreply efforts');
{
  const U = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const H = (n) => U(n).replace(/-/g, '');

  /* The page's half: runs carried through the replies in order, owner by owner, and nothing past the last one read. */
  const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '76-effort.js'), 'utf8');
  const box = { out: {} };
  new vm.Script(`(function(){${fragment}\n;out.effortAt = effortAt;`
    + 'out.set = function(raw){ var g = parseEfforts(raw); EFFORT_RUNS = g.runs; EFFORT_LASTS = g.lasts; };})()',
  { filename: '76-effort.js' }).runInNewContext(box);
  box.out.set(`${H(1)}=max,${H(3)}=high!${H(4)};${H(11)}=low!${H(12)}`);
  {
    /* Most loads bring back what the page already has, since the revision moves for any conversation. */
    let sweeps = 0, raw = '"a=max!a"';
    const stub = { out: {}, schedule: () => { sweeps++; }, ASSIST: 'x', OWNER_ATTR: 'o', SETTLED_ATTR: 's',
      getComputedStyle: () => ({ getPropertyValue: () => raw }),
      document: { createElement: () => ({ style: {}, isConnected: true }), body: { appendChild() {} }, querySelectorAll: () => [] } };
    new vm.Script(`(function(){${fragment}\n;out.read = readEfforts;})()`, { filename: '76-effort.js' }).runInNewContext(stub);
    stub.out.read(); stub.out.read();
    raw = '"a=max,b=high!b"';
    stub.out.read();
    if (sweeps === 2) ok('a table that comes back unchanged starts no sweep, and a changed one does');
    else bad(`three reads, the middle one unchanged, scheduled ${sweeps} sweeps`);
  }
  {
    /* One load at a time: a pending load is dropped when the next revision arrives, so an unanswered load does not hold
       a service-worker permit forever and an older one finishing late cannot replace a newer one. */
    const links = [];
    const headStub = { appendChild(n) { n.parentNode = headStub; links.push(n); },
      removeChild(n) { n.parentNode = null; links.splice(links.indexOf(n), 1); } };
    const stub = { out: {}, base: 'https://x/webview/', EFFORT_PREFIX: webview.EFFORT_PREFIX, head: headStub,
      sigValue: () => 'dddddddd-2222-4333-8444-555555555555', forget() {}, schedule() {}, ASSIST: 'x', OWNER_ATTR: 'o', SETTLED_ATTR: 's',
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      document: { createElement: () => ({ style: {}, isConnected: true }), body: { appendChild() {} }, querySelectorAll: () => [] } };
    new vm.Script(`(function(){${fragment}\n;out.load = loadEfforts; out.shown = function(){ return effortLink; };})()`,
      { filename: '76-effort.js' }).runInNewContext(stub);
    stub.out.load(1);
    const first = links[0];
    stub.out.load(2);
    const second = links[links.length - 1];
    second.onload();
    if (typeof first.onload === 'function') first.onload();
    if (links.length === 1 && links[0] === second && stub.out.shown() === second && first.parentNode === null) {
      ok('a load still out when the next revision arrives is dropped, and cannot replace the newer one by answering late');
    } else bad(`after two loads, the first answering last: ${links.length} link(s) in the head, the newer one shown: ${stub.out.shown() === second}`);
  }
  const state = {};
  const walk = [['main', 1], ['sub', 11], ['main', 2], ['main', 3], ['sub', 12], ['main', 4], ['sub', 13], ['main', 5]]
    .map(([owner, n]) => box.out.effortAt(state, owner, U(n)));
  if (walk.join() === 'max,low,max,high,low,high,,') {
    ok('each owner carries its own runs through interleaved replies, and nothing is given past the last one read');
  } else bad(`walking the replies gave ${JSON.stringify(walk)}`);

  /* The extension's half, against a transcript holding every shape a row comes in. Run in a child process because the
     reads are asynchronous, and twice more after it to check what a restart keeps. */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-efforts-'));
  try {
    const sid = 'aaaaaaaa-2222-4333-8444-555555555555';
    const transcript = path.join(root, sid + '.jsonl');
    const reply = (n, effort, extra = {}) => JSON.stringify(Object.assign({ parentUuid: null, isSidechain: false,
      message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'reply ' + n }] }, requestId: 'r' + n,
      type: 'assistant', uuid: U(n), timestamp: '2026-10-05T00:00:0' + (n % 10) + '.000Z', effort, perTurnEffort: null,
      cwd: '/work' }, extra)) + '\n';
    const rows = [
      reply(1, 'max'),
      // A row that quotes a reply, as a tool result printing a transcript does.
      JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { content: [{ type: 'tool_result',
        content: reply(90, 'low') }] }, uuid: U(91), timestamp: '2026-10-05T00:00:01.000Z' }) + '\n',
      reply(2, 'max'),
      // A synthetic reply: its fields in another order, and no effort.
      JSON.stringify({ parentUuid: null, isSidechain: false, type: 'assistant', uuid: U(92), timestamp: 'x',
        message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } }) + '\n',
      // A sub-agent's row in the conversation's own transcript, as an older client wrote them.
      reply(93, 'low', { isSidechain: true }),
      reply(3, 'max', { perTurnEffort: 'high' }),
      reply(4, 'xhigh', { cwd: '/work/[draft]' }),
    ];
    fs.writeFileSync(transcript, rows.join(''));
    fs.mkdirSync(path.join(root, sid, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(root, sid, 'subagents', 'agent-a1.jsonl'),
      reply(11, 'low', { isSidechain: true }) + reply(12, 'low', { isSidechain: true }));
    const plans = path.join(root, 'plans');
    const run = (steps) => JSON.parse(cp.execFileSync(process.execPath, ['-e', `
      const e = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'efforts.js'))});
      const fs = require('fs');
      (async () => {
        const out = [];
        for (const step of ${JSON.stringify(steps)}) {
          if (step.append) fs.appendFileSync(${JSON.stringify(transcript)}, step.append);
          if (step.write) fs.writeFileSync(${JSON.stringify(transcript)}, step.write);
          if (step.appendSub) fs.appendFileSync(${JSON.stringify(path.join(root, sid, 'subagents', 'agent-a1.jsonl'))}, step.appendSub);
          out.push(await e.scan(${JSON.stringify(sid)}, Object.assign(${JSON.stringify({ dir: plans, transcript })}, step.opts || {})));
        }
        process.stdout.write(JSON.stringify(out));
      })().catch((err) => process.stdout.write(JSON.stringify([{ error: err.message }])));`], { encoding: 'utf8' }));
    const rule = (main, sub) => `#cce-effort{--cce-effort:"${main};${sub}"}\n`;
    const sub = `${H(11)}=low!${H(12)}`;
    const [a, b, c] = run([{}, { append: reply(5, 'xhigh') }, {}]);
    if (a.css === rule(`${H(1)}=max,${H(3)}=high,${H(4)}=xhigh!${H(4)}`, sub)) {
      ok('read from a transcript: run starts and the last reply, with quoted, synthetic and sub-agent rows kept out');
    } else bad(`the first read gave ${JSON.stringify(a)}`);
    if (b.changed && b.css === rule(`${H(1)}=max,${H(3)}=high,${H(4)}=xhigh!${H(5)}`, sub) && !c.changed) {
      ok('an appended reply moves the last one read without starting a run, and an unchanged transcript changes nothing');
    } else bad(`after an append: ${JSON.stringify(b)}, then ${JSON.stringify(c)}`);
    // A restart carries on from what was kept: the part already read is rewritten, which only a pass from the first byte
    // would see.
    const size = fs.statSync(transcript).size, text = fs.readFileSync(transcript, 'utf8');
    fs.writeFileSync(transcript, text.replace('"effort":"max"', '"effort":"low"'));
    const [d] = run([{ append: reply(6, 'low') }]);
    if (fs.statSync(transcript).size > size && d.css === rule(`${H(1)}=max,${H(3)}=high,${H(4)}=xhigh,${H(6)}=low!${H(6)}`, sub)) {
      ok('a restart reads on from where the last process stopped');
    } else bad(`after a restart: ${JSON.stringify(d)}`);
    const [e] = run([{ write: reply(7, 'medium') }]);
    if (e.css === rule(`${H(7)}=medium!${H(7)}`, sub)) ok('a transcript replaced by a shorter one is read again from the start');
    else bad(`after the transcript was replaced: ${JSON.stringify(e)}`);
    /* A pass started by the conversation's own transcript leaves the sub-agents' alone; a full one reads them. */
    const [f, g] = run([{ appendSub: reply(13, 'high', { isSidechain: true }), opts: { subagents: false } }, {}]);
    if (f.css === rule(`${H(7)}=medium!${H(7)}`, sub) && g.css === rule(`${H(7)}=medium!${H(7)}`, `${H(11)}=low,${H(13)}=high!${H(13)}`)) {
      ok('a pass for the conversation alone leaves the sub-agents unread, and a full pass reads what they added');
    } else bad(`for the conversation alone: ${JSON.stringify(f)}; then in full: ${JSON.stringify(g)}`);
    /* A full pass requested while a conversation-only one runs waits for the next, which reads the sub-agents. */
    {
      const subFile = path.join(root, sid, 'subagents', 'agent-a1.jsonl');
      const script = `
        const fs = require('fs');
        const e = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'efforts.js'))});
        const opts = ${JSON.stringify({ dir: plans, transcript })};
        const open = fs.promises.open;
        let full = null;
        fs.promises.open = async function (...a) {
          const fh = await open.apply(this, a);
          if (!full) { fs.appendFileSync(${JSON.stringify(subFile)}, ${JSON.stringify(reply(14, 'max', { isSidechain: true }))}); full = e.scan(${JSON.stringify(sid)}, opts); }
          return fh;
        };
        (async () => {
          fs.appendFileSync(opts.transcript, ${JSON.stringify(reply(15, 'medium'))});
          const alone = await e.scan(${JSON.stringify(sid)}, Object.assign({ subagents: false }, opts));
          process.stdout.write(JSON.stringify({ alone, full: await full }));
        })().catch((err) => process.stdout.write(JSON.stringify({ error: err.message })));`;
      let q;
      try { q = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })); } catch (err) { q = { error: err.message }; }
      if (!q.error && q.full && q.full.css === rule(`${H(7)}=medium!${H(15)}`, `${H(11)}=low,${H(13)}=high,${H(14)}=max!${H(14)}`)) {
        ok('a full pass asked for while a pass for the conversation alone runs gets a pass after it that reads the sub-agents');
      } else bad(`a full pass asked for during a partial one gave ${JSON.stringify(q)}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* Where it is written: beside the panel, one file per conversation, its change carried by the revision image's height
     while the width stays the live stylesheet's. */
  const inst = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-effort-install-'));
  try {
    fs.mkdirSync(path.join(inst, 'webview'));
    const rev = () => {
      const t = fs.readFileSync(path.join(inst, 'webview', 'claude-code-extras.rev.svg'), 'utf8');
      return [Number(/width="(\d+)"/.exec(t)[1]), Number(/height="(\d+)"/.exec(t)[1])];
    };
    const sid = 'bbbbbbbb-2222-4333-8444-555555555555', other = 'cccccccc-2222-4333-8444-555555555555';
    webview.writeLive(inst, { enabled: true });
    const r0 = rev();
    const wrote = webview.writeEffort(inst, sid, '#cce-effort{--cce-effort:"x"}\n');
    const r1 = rev();
    const again = webview.writeEffort(inst, sid, '#cce-effort{--cce-effort:"x"}\n');
    const r2 = rev();
    webview.writeLive(inst, { enabled: true, userColor: '#90EE90' });
    const r3 = rev();
    if (wrote && !again && r1[0] === r0[0] && r1[1] === r0[1] + 1 && r2.join() === r1.join() && r3[0] === r1[0] + 1 && r3[1] === r1[1]) {
      ok('the efforts move the revision image\'s height, the live stylesheet its width, and neither undoes the other');
    } else bad(`revisions went ${JSON.stringify([r0, r1, r2, r3])}, wrote ${wrote}, rewrote unchanged ${again}`);
    webview.writeEffort(inst, other, '#cce-effort{--cce-effort:"y"}\n');
    const kept = webview.pruneEfforts(inst, new Set([sid]));
    const left = fs.readdirSync(path.join(inst, 'webview')).filter((n) => n.startsWith(webview.EFFORT_PREFIX));
    webview.restore(inst);
    const afterRestore = fs.readdirSync(path.join(inst, 'webview')).filter((n) => n.startsWith(webview.EFFORT_PREFIX));
    if (kept === 1 && left.length === 1 && left[0].includes(sid) && afterRestore.length === 0) {
      ok('a conversation that is gone loses its efforts, and restoring Claude Code removes them all');
    } else bad(`pruning removed ${kept} and left ${JSON.stringify(left)}; after restoring: ${JSON.stringify(afterRestore)}`);
  } finally {
    fs.rmSync(inst, { recursive: true, force: true });
  }

  /* The whole way through, in a browser: the revision probe sees the height, the page loads its conversation's file,
     and every reply shows the effort of the run it falls in - the ones settled before the file arrived included, and
     none past the last reply read. */
  const harness = require('./page-harness');
  const browser = harness.findBrowser();
  if (!browser) {
    if (process.env.CCE_REQUIRE_BROWSER) bad('no Chrome or Chromium found, and this run requires one (CCE_REQUIRE_BROWSER)');
    else note('skipped: no Chrome or Chromium here - set CCE_BROWSER to one to run the efforts in a page');
  } else {
    const sid = 'dddddddd-2222-4333-8444-555555555555';
    // A longer cap than the default: the quiet spell waits for the efforts to arrive (page-harness.js), and the time is
    // virtual, so the wait costs nothing unless they never come.
    const r = harness.run(browser, { turns: 30, focus: false, subagent: false, settleCapMs: 15000,
      efforts: { sid, css: `#cce-effort{--cce-effort:"${H(1)}=max,${H(40)}=high!${H(80)}"}\n` } });
    const shown = (r.labels || []).map((l) => String(l || '').split('  ').pop().replace(/^\d+s · /, ''));
    const want = shown.map((_, i) => (i + 1 < 40 ? 'opus-5-5 max' : i + 1 <= 80 ? 'opus-5-5 high' : 'opus-5-5'));
    if (r.error) bad('the page with efforts did not run: ' + r.error);
    else if (shown.length === 90 && shown.join('|') === want.join('|') && r.idleSweeps === 0) {
      ok('in a page: 39 replies at max, 41 at high, the 10 past the last one read with no effort, and the page idle after');
    } else bad(`in a page the replies showed ${JSON.stringify([...new Set(shown)])} over ${shown.length} replies, `
      + `${r.idleSweeps} idle sweeps; efforts in at ${r.effortsAt} ms, settled at ${r.settledAfter} ms after ${r.bootSweeps} sweeps`);
    /* The same, with the conversation's id known only after the first probe, so the efforts come with the second one, three
       seconds in: past the point a fixed quiet spell would have closed. This is how the check above failed on slower
       runners, and it must neither miss the efforts nor count the sweeps that apply them as the page failing to rest. */
    const late = harness.run(browser, { turns: 30, focus: false, subagent: false, settleCapMs: 15000,
      efforts: { sid, sidAfterMs: 2500, css: `#cce-effort{--cce-effort:"${H(1)}=max,${H(40)}=high!${H(80)}"}\n` } });
    const lateShown = (late.labels || []).map((l) => String(l || '').split('  ').pop().replace(/^\d+s · /, ''));
    if (late.error) bad('the page with late efforts did not run: ' + late.error);
    else if (lateShown.join('|') === want.join('|') && late.idleSweeps === 0 && late.effortsAt >= 2500) {
      ok(`efforts that come with a later probe are waited for, and the page rests after them (in at ${late.effortsAt} ms)`);
    } else bad(`with late efforts the replies showed ${JSON.stringify([...new Set(lateShown)])}, ${late.idleSweeps} idle sweeps, `
      + `efforts in at ${late.effortsAt} ms`);
  }

  /* The page learns of a change from the request it already makes: no timer and no image of its own. */
  const setup = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '05-page-setup.js'), 'utf8');
  if (!/setInterval|setTimeout|new Image/.test(fragment) && setup.includes('effortProbe(img.naturalHeight)')) {
    ok('the efforts ride the revision probe the page already runs, with no request of their own');
  } else bad('the effort code polls on its own, or the revision probe no longer hands it the height');
}

console.log('\nverified builds');
/* With no verified builds the list would read "Verified against Claude Code no build." and be parsed back as a build
   named "no build", so an empty list writes nothing and the no-build sentence parses as no builds. */
{
  const was = fs.readFileSync(supported.README_FILE, 'utf8');
  const wrote = supported.syncReadme([]);
  const same = fs.readFileSync(supported.README_FILE, 'utf8') === was;
  const none = supported.readmeClaims('Verified against Claude Code no build.\n');
  if (!wrote && same && Array.isArray(none) && !none.length) ok('an empty record is not written into the README, and the sentence for none reads back as none');
  else bad(`with nothing verified: wrote ${wrote}, README unchanged ${same}, the sentence for none read as ${JSON.stringify(none)}`);
  if (!same) fs.writeFileSync(supported.README_FILE, was);
}
if (process.argv.includes('--without-version-record')) {
  note('asked to skip the record check, which is what writing the record does while it runs this suite');
} else {
  const { verified, problems } = supported.verifyHere();
  const claimed = Object.keys(supported.read().claudeCode).sort(supported.cmpVersion);
  const names = Object.keys(verified).sort(supported.cmpVersion);
  for (const [version, list] of Object.entries(problems)) {
    bad(`Claude Code ${version} is installed here and the rules do not fit it: ${list.join('; ')}`);
  }
  const over = claimed.filter((v) => !verified[v]);
  const under = names.filter((v) => !claimed.includes(v));
  const fix = ' - run: node build/update-versions.js -w';
  if (!names.length && !Object.keys(problems).length) {
    note('no Claude Code install found, so what the record claims cannot be checked here');
  } else if (over.length) {
    bad(`the record claims ${over.join(', ')}, which this machine cannot verify${fix}`);
  } else if (under.length) {
    bad(`${under.join(', ')} verified here but not claimed by the record${fix}`);
  } else if (supported.format(supported.record(verified)) !== fs.readFileSync(supported.SUPPORTED_FILE, 'utf8')) {
    // Same builds, different contents: a rule's shape changed under one of them, which is the detail worth keeping.
    bad(`the record names the right builds but not what they needed${fix}`);
  } else {
    ok(`the record claims exactly what this machine verifies (${names.join(', ')})`);
  }

  /* The README's compatibility sentence against the record. Nothing guarded it before, and it drifted: it named two
     builds while the record named three, on a line people read to decide whether to install. */
  /* The counts the README quotes, against the manifest. Same reasoning as the sentence below: a number in a
     published document that nothing derives it from goes stale at the first change that moves it. */
  {
    const text = fs.readFileSync(supported.README_FILE, 'utf8');
    const c = require('../package.json').contributes;
    const want = [Object.keys(c.configuration.properties).length, c.commands.length];
    const settings = /for all (\d+) settings/.exec(text), commands = /(\d+) commands\b/.exec(text);
    if (!settings) bad('README.md does not say "for all N settings", so that number cannot be kept in step');
    else if (Number(settings[1]) !== want[0] || (commands && Number(commands[1]) !== want[1])) {
      bad(`the manifest has ${want[0]} settings and ${want[1]} commands; README.md says ${settings[1]}`
        + (commands ? ` and ${commands[1]}` : ''));
    } else ok(`README.md counts the settings the manifest has (${want[0]})` + (commands ? ` and its ${want[1]} commands` : ''));
  }

  const sentence = supported.readmeClaims();
  if (!sentence) bad('README.md has no "Verified against Claude Code ..." line to keep in step');
  else if (sentence.join(', ') !== claimed.join(', ')) {
    bad(`the record names ${claimed.join(', ')} and README.md names ${sentence.join(', ')}${fix}`);
  } else ok(`README.md names the builds the record does (${supported.listed(claimed)})`);
}

/* ── 4b. the scheduled-prompt section, host to page ──
   The host encodes the tasks into the stylesheet and the page decodes them and builds an element tree, which the panel
   then renders. A mistake in that tree is NOT caught by the try around it - the panel renders it after our code has
   returned - so the whole chain is exercised here against a stand-in element factory. */
console.log('\nscheduled prompts');
{
  const task = {
    id: 'abc12345', cron: '*/7 * * * *', recurring: true,
    createdAt: Date.now() - 86400000, lastFiredAt: Date.now() - 200000,
    session: 'sess-1', project: '/tmp/p', prompt: 'line one\nline "two" with quotes\n中文也要过去',
  };
  const css = webview.liveCss({ enabled: true, userColor: '', tasks: [task] });
  const packed = (css.match(/--cce-schedule:"([^"]+)"/) || [])[1];
  if (!packed) bad('the host did not put the tasks into the stylesheet');
  else if (/[^A-Za-z0-9+/=]/.test(packed)) bad('the encoded value is not safe inside a CSS string');
  else ok('host encodes the tasks into a stylesheet-safe value');

  const calls = [];
  const h = (type, props) => { calls.push({ type, props }); return { type, props }; };
  const sandbox = {
    window: {},
    document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => `"${packed}"` }),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    // Present in any browser this runs in; a fresh vm context does not have Node's globals.
    TextDecoder,
    sigValue: (name) => (name === 'sessionId' ? 'sess-1' : undefined),
    // The assembled script always has it; the fragment reads one switch of its own.
    isOff: () => false,
    console,
  };
  const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '82-scheduled-tasks.js'), 'utf8');
  try {
    new vm.Script(`(function(){${fragment}})()`, { filename: '82-scheduled-tasks.js' }).runInNewContext(sandbox);
  } catch (e) {
    bad('the fragment threw while defining itself: ' + e.message);
  }

  const api = sandbox.window;
  if (typeof api.__cceSchedule !== 'function') bad('__cceSchedule was not defined');
  else {
    const tree = api.__cceSchedule(h);
    if (!tree) bad('the section was empty for a task belonging to this session');
    else {
      const tags = calls.map((c) => c.type);
      for (const want of ['div', 'details', 'summary', 'pre', 'span']) {
        if (!tags.includes(want)) bad(`the tree has no <${want}>`);
      }
      const flat = JSON.stringify(calls);
      if (!flat.includes('every 7 min')) bad('the interval was not rendered in plain English');
      if (!flat.includes('中文也要过去')) bad('a non-ASCII prompt did not survive the round trip');
      const badChildren = calls.filter((c) => c.props && 'children' in c.props && !Array.isArray(c.props.children));
      if (badChildren.length) bad(`${badChildren.length} element(s) pass children as a bare value, not an array`);
      if (!failures) ok(`section builds ${calls.length} elements, prompt round-trips intact`);
    }
    // A task belonging to another session must not show up in this one.
    sandbox.sigValue = (name) => (name === 'sessionId' ? 'someone-else' : undefined);
    if (api.__cceSchedule(h) !== null) bad("another session's task leaked into this panel");
    else ok("another session's task is not shown here");

  }
  /* Cached per stylesheet, because the agent map reads it on every render and getComputedStyle forces a style
     recalculation; every stylesheet load clears the cache (05-page-setup.js). */
  {
    let reads = 0;
    const sb = Object.assign({}, sandbox, { window: {},
      getComputedStyle: () => { reads++; return { getPropertyValue: () => `"${packed}"` }; } });
    new vm.Script(`(function(){${fragment}})()`, { filename: '82-scheduled-tasks.js' }).runInNewContext(sb);
    for (let i = 0; i < 5; i++) sb.window.__cceSchedule(h);
    const setup = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '05-page-setup.js'), 'utf8');
    const cleared = (setup.match(/pinsCache = null; propCache = \{\};/g) || []).length;
    if (reads === 2 && cleared === 2) ok('five renders of the agent map read each of its two properties once, and a stylesheet arriving clears them');
    else bad(`five renders read the computed style ${reads} times; the two ways a stylesheet arrives clear the reads ${cleared} time(s)`);
  }

  /* How each schedule reads, taken off the rendered row rather than from the function, which lives inside the closure.
     The pairs that must NOT be read as an interval carry the whole point: an expression this cannot read is shown
     verbatim, because a reader has no way to tell a wrong reading from a right one. `0,30 9 * * *` fires twice a day
     rather than every thirty minutes, and `5,25,40` is evenly spaced inside an hour but not across the wrap into the
     next one. */
  {
    const READINGS = [
      ['7,27,47 * * * *', 'every 20 min'],       // a repeating gap moved off the hour, which */20 cannot express
      ['0,30 * * * *', 'every 30 min'],
      ['0,15,30,45 * * * *', 'every 15 min'],
      ['*/4 * * * *', 'every 4 min'],
      ['7 * * * *', 'hourly at :07'],
      ['30 9 * * *', 'daily at 9:30'],
      ['0,15,45 * * * *', 'hourly at :00, :15, :45'],   // faithful, since the gaps differ
      ['5,25,40 * * * *', 'hourly at :05, :25, :40'],   // even inside the hour, uneven across it
      ['0,30 9 * * *', '0,30 9 * * *'],                 // an hour is pinned, so it is not an interval at all
      ['7,7 * * * *', '7,7 * * * *'],
      ['7,99 * * * *', '7,99 * * * *'],
      ['7-9 * * * *', '7-9 * * * *'],
      ['0 9 * * 1', '0 9 * * 1'],
      ['', 'unknown interval'],
    ];
    const tasks = READINGS.map(([cron], i) => ({
      id: 'r' + i, cron, recurring: true, session: 'sess-1', project: '/tmp/p', prompt: 'p' + i,
    }));
    const packed = (webview.liveCss({ enabled: true, userColor: '', tasks }).match(/--cce-schedule:"([^"]+)"/) || [])[1];
    const calls = [];
    const h = (type, props) => { calls.push({ type, props }); return { type, props }; };
    const sandbox = {
      window: {},
      document: { documentElement: {} },
      getComputedStyle: () => ({ getPropertyValue: () => `"${packed}"` }),
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      TextDecoder,
      sigValue: (name) => (name === 'sessionId' ? 'sess-1' : undefined),
      // The assembled script always has it; the fragment reads one switch of its own.
      isOff: () => false,
      console,
    };
    const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '82-scheduled-tasks.js'), 'utf8');
    new vm.Script(`(function(){${fragment}})()`, { filename: '82-scheduled-tasks.js' }).runInNewContext(sandbox);
    sandbox.window.__cceSchedule(h);
    // One span per row carries the reading and nothing else; the two beside it are styled.
    const read = calls.filter((c) => c.type === 'span' && !(c.props && c.props.style)).map((c) => c.props.children[0]);
    const wrong = [];
    READINGS.forEach(([expr, want], i) => {
      if (read[i] !== want) wrong.push(`${JSON.stringify(expr)} read as ${JSON.stringify(read[i])}, expected ${JSON.stringify(want)}`);
    });
    if (read.length !== READINGS.length) bad(`${READINGS.length} schedules went in, ${read.length} readings came out`);
    else if (wrong.length) bad(`${wrong.length} schedule(s) read wrongly: ${wrong.join('; ')}`);
    else ok(`all ${READINGS.length} schedule shapes read as intended`);
  }

  if (typeof api.__cceAgentsLabel !== 'function') bad('__cceAgentsLabel was not defined');
  else {
    const passthrough = api.__cceAgentsLabel('3 agents', 3);
    if (typeof passthrough === 'string') ok('the button label stays a string');
    else bad('the button label came back as ' + typeof passthrough);
  }
}

/* ── Claude Code's directory, read the same way everywhere ──
   Claude Code's directory, the project folder holding a transcript, and which conversations still have one are
   computed once, in src/claude-files.js; separate copies drift apart, one ignoring CLAUDE_CONFIG_DIR or skipping an
   unreadable project folder where another stops. */
console.log("\nClaude Code's directory, read the same way everywhere");
{
  const cf = require('../src/claude-files');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-files-'));
  try {
    const SID = 'abababab-1111-4222-8333-444444444444';
    const cfg = path.join(root, 'cfg');
    fs.mkdirSync(path.join(cfg, 'projects', '-p'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'jobs', '1a2b3c4d'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'jobs', '1a2b3c4d', 'state.json'), JSON.stringify({ state: 'working', createdAt: '2026-10-02T10:00:00.000Z' }));
    const id = 'toolu_1';
    fs.writeFileSync(path.join(cfg, 'projects', '-p', SID + '.jsonl'),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, input: { command: 'claude --bg x' } }] } }) + '\n'
      + JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'backgrounded · 1a2b3c4d\n' }] } }) + '\n');
    const script = `
      const path = require('path');
      const cf = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'claude-files.js'))});
      const bg = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'background.js'))});
      (async () => {
        const live = cf.liveSessions();
        const scanned = await bg.scan(${JSON.stringify(SID)}, { dir: ${JSON.stringify(path.join(root, 'plans'))} });
        process.stdout.write(JSON.stringify({ dir: cf.claudeDir(), transcript: cf.transcriptOf(${JSON.stringify(SID)}), live: live ? [...live] : null, scanned }));
      })().catch((e) => process.stdout.write(JSON.stringify({ error: e.message })));`;
    let r;
    try { r = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cfg }) })); }
    catch (e) { r = { error: e.message }; }
    if (!r.error && r.dir === cfg && r.transcript.startsWith(cfg) && JSON.stringify(r.live) === JSON.stringify([SID]) && r.scanned.added === 1) {
      ok('CLAUDE_CONFIG_DIR moves where transcripts, the conversations still on disk and the background sessions are looked for, alike');
    } else bad(`with CLAUDE_CONFIG_DIR set: ${JSON.stringify(r)}`);

    /* A transcript not written yet is looked up by several callers at once and on every refresh, and each search stats
       a file in every project folder. */
    const projects = path.join(cfg, 'projects');
    const missing = 'cdcdcdcd-1111-4222-8333-444444444444';
    let walks = 0;
    const realReaddir = fs.readdirSync;
    fs.readdirSync = function (p, ...rest) { if (String(p) === projects) walks++; return realReaddir.call(fs, p, ...rest); };
    let got;
    try {
      const t0 = Date.now();
      got = [cf.transcriptOf(missing, projects, t0), cf.transcriptOf(missing, projects, t0 + 1000), walks,
        cf.transcriptOf(missing, projects, t0 + cf.MISS_MS + 1), walks];
    } finally { fs.readdirSync = realReaddir; }
    if (JSON.stringify(got) === JSON.stringify(['', '', 1, '', 2])) ok('a transcript not found is looked for again only once a short while has passed');
    else bad(`looking for a missing transcript gave ${JSON.stringify(got)}`);

    /* One project folder that cannot be listed would make every conversation in it look gone, and their plans would be
       deleted as abandoned. */
    const locked = path.join(projects, '-locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'efefefef-1111-4222-8333-444444444444.jsonl'), '{}\n');
    fs.chmodSync(locked, 0);
    const blind = cf.liveSessions(projects);
    fs.chmodSync(locked, 0o755);
    if (CANNOT_LOCK) note('chmod cannot make a folder unreadable for root or on Windows');
    else if (blind === null) ok('a project folder that cannot be listed makes the conversations still on disk unknown, not fewer');
    else bad(`with a project folder unreadable the live set was ${JSON.stringify([...blind])}`);

    /* Several windows write the same files beside the plans. */
    const file = path.join(root, 'shared.json');
    const renames = [];
    const realRename = fs.renameSync;
    let threw = '';
    try {
      fs.renameSync = (from, to) => { renames.push(from); return realRename.call(fs, from, to); };
      cf.writeAtomic(file, 'one'); cf.writeAtomic(file, 'two');
      fs.renameSync = () => { throw new Error('rename failed'); };
      try { cf.writeAtomic(file, 'three'); } catch (e) { threw = e.message; }
    } finally { fs.renameSync = realRename; }
    const leftover = fs.readdirSync(root).filter((n) => n.startsWith('shared.json.'));
    if (renames.length === 2 && renames[0] !== renames[1] && renames.every((t) => t.includes('.' + process.pid + '.'))
      && fs.readFileSync(file, 'utf8') === 'two' && threw === 'rename failed' && !leftover.length) {
      ok('a shared file is replaced through a temporary copy of this process\'s own, removed again when it cannot be put in place');
    } else bad(`writing a shared file: renames ${JSON.stringify(renames.map((t) => path.basename(t)))}, left ${JSON.stringify(leftover)}, threw ${JSON.stringify(threw)}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  /* One pass per key at a time, and every request made during a pass shares the one after it, with the options merged. */
  const script = `
    const cf = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'claude-files.js'))});
    const runs = [];
    let release;
    const run = (key, opts) => new Promise((resolve) => {
      runs.push(opts);
      if (runs.length === 1) release = () => resolve('first'); else resolve('again ' + runs.length);
    });
    const go = cf.oneAtATime(run, (a, b) => ({ tags: a.tags.concat(b.tags) }));
    const a = go('k', { tags: ['a'] }), b = go('k', { tags: ['b'] }), c = go('k', { tags: ['c'] }), other = go('j', { tags: ['j'] });
    setTimeout(() => release(), 10);
    Promise.all([a, b, c, other]).then((got) => process.stdout.write(JSON.stringify({ got, runs })));`;
  let q;
  try { q = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })); } catch (e) { q = { error: e.message }; }
  if (q && !q.error && JSON.stringify(q.got) === JSON.stringify(['first', 'again 3', 'again 3', 'again 2'])
    && JSON.stringify(q.runs.map((o) => o.tags)) === JSON.stringify([['a'], ['j'], ['b', 'c']])) {
    ok('a request made during a pass waits for one more pass, shared by every such request, with their options together');
  } else bad(`one pass at a time gave ${JSON.stringify(q)}`);
}

/* ── 5. the installed copy must match this working tree ──
   The extension host loads the installed copy, not this tree. A source file added here but missing there makes the
   extension fail to activate on the next reload - it cannot require what was never packaged - and the only symptom is
   that every addition silently disappears. Skipped where nothing is installed, as in CI. */
/* ── the detached sessions a conversation started ──
   Found in the launching conversation's transcript, kept in a small file beside its plan, shown in the agent map. The
   false positives below are real ones: a document describing the output format matched the words, and so did a
   conversation printing an id it had just looked up. The scanning half is asynchronous, so it runs in a child process
   that waits for it and prints what it saw - this suite is synchronous to the end. */
console.log('\nbackground sessions');
{
  const bg = require('../src/background');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-bg-'));
  const jobs = path.join(root, 'jobs'), plans = path.join(root, 'plans'), proj = path.join(root, 'projects', '-p');
  fs.mkdirSync(plans, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
  const transcript = path.join(proj, SID + '.jsonl');
  const job = (id, fields) => {
    fs.mkdirSync(path.join(jobs, id), { recursive: true });
    fs.writeFileSync(path.join(jobs, id, 'state.json'), JSON.stringify(Object.assign({
      state: 'working', name: 'task ' + id, detail: 'reading files', tokens: 12000,
      createdAt: '2026-10-02T10:00:00.000Z', output: null,
      intent: '<!-- WRITING-CONTRACT\nscope: what this is for\n-->\n\n# Do the thing\nthen stop',
    }, fields || {})));
  };
  let callNo = 0;
  // A call and the result that answers it: two rows, as a transcript records them.
  const ran = (command, text) => {
    const id = 'toolu_' + (++callNo);
    return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id, name: 'Bash', input: { command } }] } }) + '\n'
      + JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: id, content: text }] } }) + '\n';
  };
  const prose = (text) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text }] } }) + '\n';
  const launched = (id) => `backgrounded · ${id}\n  claude agents             list sessions\n  claude attach ${id}    open in this terminal\n`;
  job('1a2b3c4d');
  job('5e6f7a8b', { state: 'blocked', needs: 'decide which of the two copies to keep' });
  job('0badc0de');
  job('cafef00d');   // a real session, only printed back by another command
  job('deadbea7');
  job('0ddba115');
  job('77777777', { state: 'done', lastTerminalAt: '2026-10-02T11:00:00.000Z', output: { result: 'all 11 ids kept' } });
  job('0a0b0c0d');
  job('0e0f0a0b');
  job('13579bdf');   // only echoed by a script, never with the hint's words
  job('2468ace0');   // its hints printed back by a command that launched nothing
  fs.writeFileSync(transcript,
    prose('the output looks like backgrounded · 0badc0de, for example') +           // a mention, not a launch
    ran('claude --bg "task one"', launched('1a2b3c4d') + 'note: backgrounded · cafef00d is older\n') + // and one in passing
    ran('cat notes.md', 'the format is backgrounded · [0-9a-f]{8} followed by hints') + // a document describing it
    ran('claude --bg "task two"', 'backgrounded · \x1b[36m5e6f7a8b\x1b[39m\n') +        // the id coloured
    ran('grep -h backgrounded old.jsonl', launched('cafef00d')) +                     // an earlier launch printed back
    ran('claude --bg "task three"', 'Starting background service…\nbackgrounded · deadbea7') + // hints cut off
    ran('claude --bg "task four"', launched('99999999')) +                           // no record of that one
    ran('claude --bg "task six" | sed \'s/^/  /\'', '  ' + launched('0ddba115').split('\n').join('\n  ')));  // output indented

  const scanAll = (steps) => {
    const script = `
      const bg = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'background.js'))});
      const fs = require('fs');
      const opts = ${JSON.stringify({ dir: plans, jobs, transcript })};
      (async () => {
        const out = [];
        for (const step of ${JSON.stringify(steps)}) {
          if (step.append) fs.appendFileSync(opts.transcript, step.append);
          const r = await bg.scan(${JSON.stringify(SID)}, opts);
          let link = null;
          try { link = JSON.parse(fs.readFileSync(opts.dir + '/' + ${JSON.stringify(SID)} + '.background', 'utf8')); } catch (_) {}
          out.push({ r, link });
        }
        process.stdout.write(JSON.stringify(out));
      })().catch((e) => { process.stdout.write(JSON.stringify({ error: e.message })); });`;
    return JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
  };

  const half = ran('claude --bg "task five"', launched('77777777'));
  const filler = prose('still working on it');
  const steps = scanAll([
    {},
    { append: filler + half.slice(0, 40) },   // a whole line, then one still being written
    { append: half.slice(40) },                // and then finished
  ]);
  if (steps.error) bad('the scan threw: ' + steps.error);
  else {
    const [first, partial, whole] = steps;
    const ids = (first.link && first.link.ids) || [];
    if (ids.join() === '1a2b3c4d,5e6f7a8b,deadbea7,0ddba115') ok('four launches are found: coloured, with the hints cut off, and indented');
    else bad(`the first scan recorded ${JSON.stringify(ids)}`);
    if (!ids.includes('0badc0de') && !ids.includes('99999999') && !ids.includes('cafef00d')) {
      ok('a mention in prose or in passing, the format written out, a launch printed back by grep, and a session with no record are all left out');
    } else bad(`something that was not a launch was recorded: ${JSON.stringify(ids)}`);
    // In bytes: the middle dot in the CLI's words is two of them, so a string's length is not the file's.
    const size0 = fs.statSync(transcript).size - Buffer.byteLength(filler) - Buffer.byteLength(half);
    const size1 = size0 + Buffer.byteLength(filler);
    if (first.link && first.link.scannedTo === size0) ok('the file records how far the transcript was read');
    else bad(`the recorded position was ${first.link && first.link.scannedTo}, the transcript was ${size0} bytes`);
    if (partial.r.added === 0 && partial.r.scannedTo === size1) ok('a line still being written is not consumed');
    else bad(`a half-written line moved the position to ${partial.r.scannedTo} with ${partial.r.added} added`);
    if (whole.r.added === 1 && whole.link.ids.includes('77777777') && whole.link.scannedTo === size1 + Buffer.byteLength(half)) {
      ok('once the line is whole it is read, from where the last pass stopped');
    } else bad(`after the line was finished: ${JSON.stringify(whole)}`);
  }

  // A launch whose output kept only the hints: `| tail -3` drops the first line, and that is how a live one went unseen.
  // Its own folder of link files, so that what it finds does not join the list the checks further down count.
  {
    const SID3 = 'cccccccc-1111-2222-3333-444444444444';
    const t3 = path.join(proj, SID3 + '.jsonl');
    const plans3 = path.join(root, 'plans3');
    fs.writeFileSync(t3,
      ran('claude --bg "task seven" 2>&1 | tail -3', '  claude attach 0a0b0c0d    open in this terminal\n'
        + '  claude logs 0a0b0c0d      show recent output\n  claude stop 0a0b0c0d      stop this session') +
      ran('claude --bg "task eight" | tail -1', '\x1b[2m  claude stop 0e0f0a0b      stop this session\x1b[22m') + // dimmed
      // Echoed beside a real hint, so that only the missing words keep it out.
      ran('claude --bg "task nine" | tail -1; echo claude stop 13579bdf',
        '  claude stop 0e0f0a0b      stop this session\nclaude stop 13579bdf\n') +
      ran('cat launch.log', '  claude attach 2468ace0    open in this terminal\n'));                      // printed back
    const script = `
      const bg = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'background.js'))});
      const fs = require('fs');
      const opts = ${JSON.stringify({ dir: plans3, jobs, transcript: t3 })};
      bg.scan(${JSON.stringify(SID3)}, opts).then(() => {
        let ids = [];
        try { ids = JSON.parse(fs.readFileSync(opts.dir + '/' + ${JSON.stringify(SID3)} + '.background', 'utf8')).ids; } catch (_) {}
        process.stdout.write(JSON.stringify(ids));
      }).catch((e) => { process.stdout.write(JSON.stringify({ error: e.message })); });`;
    const ids = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
    if (Array.isArray(ids) && ids.join() === '0a0b0c0d,0e0f0a0b') {
      ok('a launch is found from its hints alone, plain or dimmed, when the line above them was cut off');
    } else bad(`from the hints alone the scan recorded ${JSON.stringify(ids)}`);
    if (Array.isArray(ids) && !ids.includes('13579bdf') && !ids.includes('2468ace0')) {
      ok('a stop command echoed without the hint\'s words, and hints printed back by a command that launched nothing, are left out');
    } else bad(`a hint that was not a launch was recorded: ${JSON.stringify(ids)}`);
  }

  // A launch cut down to `claude attach <id>` by `grep -o`: the bare line counts for a session created while the call
  // ran, and not for an older one echoed the same way.
  {
    const SID5 = 'eeeeeeee-1111-2222-3333-444444444444';
    const t5 = path.join(proj, SID5 + '.jsonl');
    const plans5 = path.join(root, 'plans5');
    const timed = (command, text, from, to) => {
      const id = 'toolu_' + (++callNo);
      return JSON.stringify({ type: 'assistant', timestamp: from, message: { role: 'assistant', content: [
        { type: 'tool_use', id, name: 'Bash', input: { command } }] } }) + '\n'
        + JSON.stringify({ type: 'user', timestamp: to, message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: id, content: text }] } }) + '\n';
    };
    job('a1a1a1a1', { createdAt: '2026-11-07T23:27:52.257Z' });
    job('b2b2b2b2', { createdAt: '2026-11-07T18:31:50.000Z' });
    job('c3c3c3c3', { createdAt: '2026-11-07T20:00:05.000Z' });
    fs.writeFileSync(t5,
      timed("claude --bg \"odb\" 2>&1 | grep -oE 'claude attach [0-9a-f]+' | head -1", 'claude attach a1a1a1a1',
        '2026-11-07T23:27:41.416Z', '2026-11-07T23:27:53.168Z')
      + timed('wc -l a b c; claude --bg "tests" | grep -o "claude attach [0-9a-f]*"', '121\n12\n3\nclaude attach b2b2b2b2\n',
        '2026-11-07T18:31:41.913Z', '2026-11-07T18:31:53.859Z')
      + timed('claude --bg "later" | tail -1; echo claude attach 13579bdf', 'claude attach 13579bdf\n',
        '2026-11-07T19:00:00.000Z', '2026-11-07T19:00:09.000Z')                       // an older session echoed
      + ran('claude --bg "untimed" | grep -o "claude attach [0-9a-f]*"', 'claude attach c3c3c3c3'));  // no times recorded
    const once5 = () => JSON.parse(cp.execFileSync(process.execPath, ['-e', `
      const bg = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'background.js'))});
      const fs = require('fs');
      const opts = ${JSON.stringify({ dir: plans5, jobs, transcript: t5 })};
      bg.scan(${JSON.stringify(SID5)}, opts).then(() => {
        process.stdout.write(fs.readFileSync(opts.dir + '/' + ${JSON.stringify(SID5)} + '.background', 'utf8'));
      }).catch((e) => { process.stdout.write(JSON.stringify({ error: e.message })); });`], { encoding: 'utf8' }));
    const r5 = once5();
    if (Array.isArray(r5.ids) && r5.ids.join() === 'a1a1a1a1,b2b2b2b2') {
      ok('a launch cut down to its attach line is found, even after other output');
    } else bad(`from the attach command alone the scan recorded ${JSON.stringify(r5)}`);
    if (Array.isArray(r5.ids) && !r5.ids.includes('13579bdf') && !r5.ids.includes('c3c3c3c3')) {
      ok('an attach line for an older session, or from a call without times, is left out');
    } else bad(`a bare attach command that was not a launch was recorded: ${JSON.stringify(r5.ids)}`);
    // As an older version left it: the whole transcript read, the two launches above missed.
    fs.writeFileSync(path.join(plans5, SID5 + '.background'),
      JSON.stringify({ ids: ['0a0b0c0d'], scannedTo: fs.statSync(t5).size }) + '\n');
    const again = once5();
    if (again.reader === r5.reader && Array.isArray(again.ids) && again.ids.join() === '0a0b0c0d,a1a1a1a1,b2b2b2b2') {
      ok('an older version\'s link file is rescanned and keeps its sessions');
    } else bad(`over an older version's link file the scan wrote ${JSON.stringify(again)}`);
  }

  // A conversation that launched nothing still gets an empty link file, which tells the next window, or the extension
  // after a restart, how far its transcript was read. Below, the already-read part is rewritten to contain a launch
  // that only a pass from byte 0 would find; the second pass runs in a separate process, like a starting window.
  {
    const SID2 = 'bbbbbbbb-1111-2222-3333-444444444444';
    const t2 = path.join(proj, SID2 + '.jsonl');
    const before = prose('nothing launched here') + ran('ls -la', 'total 0')
      + [1, 2, 3, 4, 5, 6].map((n) => prose('still nothing, line ' + n)).join('');
    const rewritten = ran('claude --bg "late"', launched('1a2b3c4d')) + before;
    fs.writeFileSync(t2, before);
    const once = () => JSON.parse(cp.execFileSync(process.execPath, ['-e', `
      const bg = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'background.js'))});
      bg.scan(${JSON.stringify(SID2)}, ${JSON.stringify({ dir: plans, jobs, transcript: t2 })})
        .then((r) => process.stdout.write(JSON.stringify(r)), (e) => process.stdout.write(JSON.stringify({ error: e.message })));`],
    { encoding: 'utf8' }));
    const first = once();
    let link = null;
    try { link = JSON.parse(fs.readFileSync(path.join(plans, SID2 + '.background'), 'utf8')); } catch (_) { /* none */ }
    fs.writeFileSync(t2, rewritten);
    const second = once();
    if (link && Array.isArray(link.ids) && !link.ids.length && link.scannedTo === Buffer.byteLength(before)) {
      ok('a conversation that started nothing gets a file saying how far it was read, and naming no session');
    } else bad(`for a conversation that started nothing the file held ${JSON.stringify(link)}`);
    if (!first.error && first.added === 0 && second.added === 0 && second.scannedTo === Buffer.byteLength(rewritten)) {
      ok('and a new process reads on from that point rather than from the first byte');
    } else bad(`two processes over a conversation that started nothing gave ${JSON.stringify([first, second])}`);
  }

  // What the stylesheet carries.
  const list = bg.collect({ dir: plans, jobs });
  const byId = Object.fromEntries(list.map((e) => [e.id, e]));
  const e1 = byId['1a2b3c4d'], e2 = byId['5e6f7a8b'], e3 = byId['77777777'];
  if (list.length === 5 && e1 && e1.session === SID && e1.detail === 'reading files' && e1.tokens === 12000) {
    ok('each recorded session is read from its own state, under the conversation that started it');
  } else bad(`collect gave ${JSON.stringify(list)}`);
  if (e1 && e1.task.startsWith('# Do the thing')) ok('the task is shown without the comment block it opens with');
  else bad(`the task came out as ${JSON.stringify(e1 && e1.task)}`);
  if (e2 && e2.needs === 'decide which of the two copies to keep' && e3 && e3.result === 'all 11 ids kept' && e3.endedAt) {
    ok('what a waiting session needs, and what a finished one concluded, both come through');
  } else bad(`the blocked and done entries were ${JSON.stringify([e2, e3])}`);
  if (JSON.stringify(bg.collect({ dir: plans, jobs })) === JSON.stringify(list)) {
    ok('two windows reading the same files produce the same list');
  } else bad('collect gave a different answer the second time');

  fs.writeFileSync(path.join(jobs, '1a2b3c4d', 'state.json'), '{"state":"work');   // caught mid-write
  const again = bg.collect({ dir: plans, jobs }).find((e) => e.id === '1a2b3c4d');
  if (again && again.detail === 'reading files') ok('a state file caught half-written keeps the last reading');
  else bad(`a half-written state file gave ${JSON.stringify(again)}`);
  fs.rmSync(path.join(jobs, '77777777'), { recursive: true });
  if (!bg.collect({ dir: plans, jobs }).some((e) => e.id === '77777777')) ok('a session whose record is gone drops out');
  else bad('a session with no record left was still listed');

  /* Ordered by last launch time, which every window reads the same. Link files are rewritten as transcripts are read,
     so ordering by modification time would reshuffle the list, push sessions past MAX_SESSIONS in and out, and rewrite
     the stylesheet every panel reloads. Files from before the launch time was stored are ordered by their sessions' own
     records. */
  {
    const order = path.join(root, 'plans-order');
    fs.mkdirSync(order);
    job('aaaa0001', { createdAt: '2026-10-03T10:00:00.000Z' });
    job('aaaa0002', { createdAt: '2026-10-01T10:00:00.000Z' });
    job('aaaa0003', { createdAt: '2026-10-02T10:00:00.000Z' });
    const S = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-2222-3333-444444444444`;
    const put = (n, link, ageMin) => {
      const f = path.join(order, S(n) + '.background');
      fs.writeFileSync(f, JSON.stringify(link));
      const t = new Date(Date.now() - ageMin * 60000);
      fs.utimesSync(f, t, t);
    };
    put(1, { ids: ['aaaa0001'], scannedTo: 5, launched: Date.parse('2026-10-03T10:00:00.000Z') }, 30);
    put(2, { ids: ['aaaa0002'], scannedTo: 5, launched: Date.parse('2026-10-01T10:00:00.000Z') }, 20);
    put(3, { ids: ['aaaa0003'], scannedTo: 5 }, 10);
    const first = bg.collect({ dir: order, jobs }).map((e) => e.session);
    // A pass reads on through the oldest launcher's transcript and writes down how far, which makes its file the newest.
    put(2, { ids: ['aaaa0002'], scannedTo: 5 + bg.PERSIST_EVERY, launched: Date.parse('2026-10-01T10:00:00.000Z') }, 0);
    const second = bg.collect({ dir: order, jobs }).map((e) => e.session);
    const want = [S(1), S(3), S(2)];
    if (JSON.stringify(first) === JSON.stringify(want) && JSON.stringify(second) === JSON.stringify(want)) {
      ok('the agent map lists conversations newest launch first, and a file rewritten as its transcript is read does not move');
    } else bad(`ordered ${JSON.stringify(first)}, then after a rewrite ${JSON.stringify(second)}, expected ${JSON.stringify(want)}`);
  }

  /* A request made during a pass waits for the next one: the running pass took the transcript size before the request
     and would miss a launch appended since. */
  {
    const SID4 = 'dddddddd-1111-2222-3333-444444444444';
    const t4 = path.join(proj, SID4 + '.jsonl');
    const plans4 = path.join(root, 'plans4');
    job('0f0f0f0f');
    fs.writeFileSync(t4, ran('claude --bg "first"', launched('0a0b0c0d')));
    const late = ran('claude --bg "second"', launched('0f0f0f0f'));
    const script = `
      const fs = require('fs');
      const bg = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'background.js'))});
      const opts = ${JSON.stringify({ dir: plans4, jobs, transcript: t4 })};
      const open = fs.promises.open;
      let second = null;
      fs.promises.open = async function (...a) {
        const fh = await open.apply(this, a);
        if (!second) { fs.appendFileSync(opts.transcript, ${JSON.stringify(late)}); second = bg.scan(${JSON.stringify(SID4)}, opts); }
        return fh;
      };
      (async () => {
        const first = await bg.scan(${JSON.stringify(SID4)}, opts);
        const then = await second;
        const link = JSON.parse(fs.readFileSync(opts.dir + '/' + ${JSON.stringify(SID4)} + '.background', 'utf8'));
        process.stdout.write(JSON.stringify({ first, then, ids: link.ids }));
      })().catch((e) => process.stdout.write(JSON.stringify({ error: e.message })));`;
    let r;
    try { r = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })); } catch (e) { r = { error: e.message }; }
    if (!r.error && r.first.added === 1 && r.then.added === 1 && r.ids.join() === '0a0b0c0d,0f0f0f0f') {
      ok('a scan asked for while one runs gets a pass of its own after it, which reads what was appended meanwhile');
    } else bad(`a scan asked for during another gave ${JSON.stringify(r)}`);
  }

  {
    const HIDE = '[data-message-stamp] time{display:none !important;}';
    const dflt = webview.liveCss({ enabled: true }), noTimes = webview.liveCss({ enabled: true, off: ['timestamps'] });
    const allOff = webview.liveCss({ enabled: false });
    if (dflt.includes(HIDE) && !noTimes.includes(HIDE) && !allOff.includes(HIDE)) {
      ok('Claude Code\'s own message times are hidden while ours are on, and come back when ours or the whole extension is off');
    } else bad(`the rule hiding Claude Code's times: on ${dflt.includes(HIDE)}, times off ${noTimes.includes(HIDE)}, all off ${allOff.includes(HIDE)}`);
  }
  const css = webview.liveCss({ enabled: true, background: list });
  const off = webview.liveCss({ enabled: true, background: list, off: ['backgroundSessions'] });
  if (/--cce-background:"[A-Za-z0-9+/=]+"/.test(css) && !off.includes('--cce-background')) {
    ok('the list rides in the stylesheet, and the switch keeps it out');
  } else bad('the background property was missing, or present with the switch off');

  // The page: the section, the button's label, and the switch.
  const packed = (css.match(/--cce-background:"([^"]+)"/) || [])[1] || '';
  const calls = [];
  const h = (type, props) => { calls.push({ type, props }); return { type, props }; };
  const off2 = { on: false };
  const sandbox = {
    window: {}, document: { documentElement: {} }, navigator: {},
    getComputedStyle: () => ({ getPropertyValue: (name) => (name === '--cce-background' ? `"${packed}"` : '') }),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextDecoder, console,
    sigValue: (name) => (name === 'sessionId' ? SID : undefined),
    isOff: (k) => off2.on && k === 'backgroundSessions',
  };
  new vm.Script(`(function(){${fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '82-scheduled-tasks.js'), 'utf8')}})()`,
    { filename: '82-scheduled-tasks.js' }).runInNewContext(sandbox);
  const api = sandbox.window;
  const tree = api.__cceSchedule(h);
  const flat = JSON.stringify(calls);
  if (tree && flat.includes('5 background sessions') && flat.includes('Waiting for you: decide which of the two copies')) {
    ok('the agent map lists this conversation\'s sessions, a waiting one saying what it waits for');
  } else bad('the section did not render the sessions as expected');
  {
    const spans = calls.filter((c) => c.type === 'span' && c.props && c.props.style && c.props.style.color
      && Array.isArray(c.props.children) && typeof c.props.children[0] === 'string');
    const tone = (re) => spans.filter((c) => re.test(c.props.children[0])).map((c) => c.props.style.color);
    const states = { running: 'charts-green', 'waiting for you': 'editorWarning', done: 'charts-blue', stopped: 'descriptionForeground', failed: 'errorForeground' };
    const rows = Object.entries(states).filter(([word]) => tone(new RegExp('^' + word + '$')).length);
    const rowsRight = rows.every(([word, v]) => tone(new RegExp('^' + word + '$')).every((c) => c.includes(v)));
    const heads = Object.entries(states).filter(([word, v]) => tone(new RegExp('^\\d+ ' + word + '$')).some((c) => c.includes(v)));
    if (["running", "waiting for you", "done"].every((w) => rows.some(([r]) => r === w)) && rowsRight && heads.length === rows.length) {
      ok(`each state has its own colour, on its row and counted in the heading (${rows.map(([w]) => w).join(', ')})`);
    } else bad(`state colours: rows ${JSON.stringify(rows.map(([w]) => [w, tone(new RegExp('^' + w + '$'))]))}, heading counts for ${heads.map(([w]) => w)}`);
  }
  if (flat.includes('claude attach 1a2b3c4d') && flat.includes('claude logs 5e6f7a8b')) {
    ok('each session offers the commands to reach it, and nothing that opens it in this panel');
  } else bad('the attach and logs commands were missing');
  const bare = calls.filter((c) => c.props && 'children' in c.props && !Array.isArray(c.props.children));
  if (!bare.length) ok('every element passes its children as an array');
  else bad(`${bare.length} element(s) pass children as a bare value`);
  const label = api.__cceAgentsLabel('3 agents', 3);
  if (label === '3 agents · 4 bg (1 waiting)') ok(`the button counts the sessions still running or waiting (${label})`);
  else bad(`the button read "${label}"`);
  if (api.__cceScheduleCount() >= 2) ok('the sessions open the button even with no agent running');
  else bad('the button would stay hidden with only background sessions');

  /* A command running in the background opens the button as well, and is named on it: the official map lists such
     commands, but its button waits for an agent. Each case gets a fresh copy, since the counts are held briefly. */
  {
    const frag = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '82-scheduled-tasks.js'), 'utf8');
    const withTasks = (n) => {
      const tasks = new Map();
      for (let i = 0; i < n; i++) tasks.set('t' + i, { taskId: 't' + i, taskType: 'local_bash', description: 'sleep 1230' });
      const env = Object.assign({}, sandbox, { window: {},
        sigValue: (name) => (name === 'sessionId' ? 'nobody' : name === 'backgroundTasks' ? tasks : undefined) });
      new vm.Script(`(function(){${frag}})()`, { filename: '82-scheduled-tasks.js' }).runInNewContext(env);
      return env.window;
    };
    const one = withTasks(1), two = withTasks(2), none = withTasks(0), mixed = withTasks(1);
    const got = [one.__cceScheduleCount(), one.__cceAgentsLabel('0 agents', 0), two.__cceAgentsLabel('0 agents', 0),
      none.__cceScheduleCount(), none.__cceAgentsLabel('0 agents', 0), mixed.__cceAgentsLabel('2 agents', 2)];
    const want = [1, '1 task', '2 tasks', 0, '0 agents', '2 agents · 1 task'];
    if (JSON.stringify(got) === JSON.stringify(want)) {
      ok('a running background command opens the button and is named on it, beside any agents');
    } else bad(`background commands: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }

  sandbox.sigValue = (name) => (name === 'sessionId' ? 'someone-else' : undefined);
  calls.length = 0;
  if (api.__cceSchedule(h) === null) ok("another conversation's sessions are not shown here");
  else bad("another conversation's sessions leaked into this panel");

  sandbox.sigValue = (name) => (name === 'sessionId' ? SID : undefined);
  off2.on = true;
  calls.length = 0;
  const offTree = api.__cceSchedule(h);
  // The counts are held for half a second, so wait that out before asking the label again.
  const until = Date.now() + 600; while (Date.now() < until) { /* spin */ }
  if (offTree === null && api.__cceAgentsLabel('3 agents', 3) === '3 agents') ok('switched off, nothing is drawn or counted');
  else bad('the switch left the section or the count in place');

  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\ninstalled copy');
if (explicit.length) {
  /* Named bundles mean someone is asking about a build, not about this machine - the upstream check does exactly that.
     Counting a stale install as a failure there would report "an edit no longer matches" when every edit matched. */
  note('skipped: checking named bundles, not this machine');
} else {
  // The directory name VS Code gives an install, built from the manifest so a rename cannot leave this looking in the
  // wrong place - which would read as "not installed here" however many times the extension was installed.
  const mine = require('../package.json');
  const installed = extensionsDirs()
    .map((d) => path.join(d, `${mine.publisher}.${mine.name}-${mine.version}`))
    .find((d) => fs.existsSync(d));
  if (!installed) {
    note('this extension is not installed here; nothing to compare');
  } else {
    /* Reported, never counted. Packaging runs this check, and until the new package is installed the copy is behind by
       definition - failing here would make the build refuse to produce the very thing that fixes it. What matters is
       that a missing file is named out loud, because the extension cannot require what was never packaged and the only
       symptom on the next reload is that every addition silently disappears. */
    // The same list the parse check walks, so the two cannot drift apart - and it covers the entry point, without which
    // the extension does not activate at all.
    const here = sourceFiles();
    const missing = [], stale = [];
    for (const f of here) {
      const b = path.join(installed, f);
      if (!fs.existsSync(b)) missing.push(f);
      else if (fs.readFileSync(path.join(__dirname, '..', f), 'utf8') !== fs.readFileSync(b, 'utf8')) stale.push(f);
    }
    if (!missing.length && !stale.length) ok(`installed copy matches all ${here.length} source files`);
    if (missing.length) console.log(`  note  NOT INSTALLED YET: ${missing.join(', ')} - reinstall before reloading, or the extension will fail to activate`);
    if (stale.length) console.log(`  note  ${stale.length} of ${here.length} source files differ from the installed copy; reinstall to pick them up`);
  }
}

/* ── 6. everything shipped is written in English ──
   The .vsix goes to other people, so a string in the interface cannot end up in the language of whichever conversation
   happened to add it - and that is exactly the mistake nothing else here catches, because such a string works perfectly
   for the person who wrote it.

   Content is exempt by construction rather than by rule: a work plan's own words live in a file this extension only
   reads, so they never enter these files. The scan covers what build/pack.sh copies and nothing else - test/ is not
   shipped, and its fixtures carry non-ASCII on purpose to prove the encoding survives a round trip.

   Translations are the one place another language belongs, and they are kept where the scan can tell them apart:
   package.nls.<language>.json and src/l10n/. Each must carry exactly the entries its English does. */
console.log('\nshipped text');
{
  const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯！-｠]/;
  const TEXT = /\.(js|json|md|svg|py|sh|ya?ml|txt)$/;
  const root = path.join(__dirname, '..');
  /* What ships is read out of pack.sh rather than repeated here, so adding a path there cannot leave it unscanned.
     A second copy of that list is exactly the kind that drifts with nothing saying so. */
  const line = (fs.readFileSync(path.join(root, 'build', 'pack.sh'), 'utf8')
    .match(/^cp -r (.+) "\$stage\/extension\/"$/m) || [])[1];
  if (!line) bad('build/pack.sh no longer has a recognisable copy line, so what ships cannot be determined');
  else {
    const walk = (rel) => {
      if (rel.includes('*')) {
        const glob = new RegExp('^' + rel.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*') + '$');
        return fs.readdirSync(root).filter((f) => glob.test(f)).sort().flatMap(walk);
      }
      if (!fs.statSync(path.join(root, rel)).isDirectory()) return TEXT.test(rel) ? [rel] : [];
      return fs.readdirSync(path.join(root, rel)).sort().flatMap((f) => walk(path.join(rel, f)));
    };
    const TRANSLATION = /^(package\.nls\.[a-z]{2}(-[a-z]+)?\.json|src\/l10n\/.+)$/i;
    const files = line.trim().split(/\s+/).flatMap(walk);
    const hits = [];
    for (const rel of files.filter((f) => !TRANSLATION.test(f.split(path.sep).join('/')))) {
      fs.readFileSync(path.join(root, rel), 'utf8').split('\n')
        .forEach((l, i) => { if (CJK.test(l)) hits.push(`${rel}:${i + 1}`); });
    }
    if (!hits.length) ok(`no CJK in any of the ${files.length} text files build/pack.sh ships, translations aside`);
    else bad(`shipped files carry CJK, which reaches whoever installs this: ${hits.slice(0, 8).join(', ')}`);
    const shape = (o) => Object.keys(o).sort().map((k) => (o[k] && typeof o[k] === 'object' ? k + '{' + shape(o[k]) + '}' : k)).join();
    const used = (fs.readFileSync(path.join(root, 'package.json'), 'utf8').match(/"%([\w.]+)%"/g) || []).map((k) => k.slice(2, -2));
    const nlsFiles = fs.readdirSync(root).filter((f) => /^package\.nls(\.[a-z]{2}(-[a-z]+)?)?\.json$/i.test(f));
    const nlsOf = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    const english = nlsFiles.includes('package.nls.json') ? nlsOf('package.nls.json') : {};
    const off = nlsFiles.filter((f) => shape(nlsOf(f)) !== shape(english));
    if (!off.length && used.every((k) => k in english) && Object.keys(english).every((k) => used.includes(k))
      && (used.length > 0 || !nlsFiles.length)) {
      ok(used.length ? 'each translation carries exactly the entries of its English, and every label the manifest names has one'
        : 'the manifest names no translated label, and no translation file is shipped');
    } else bad(`translation entries: ${JSON.stringify({ files: nlsFiles, off, used })}`);
  }

  /* Commit messages are not in the .vsix, so the scan above never sees them - and they travel anyway, because history
     goes with the repository. This is the only part of what gets published that nothing else guards.

     It runs over the whole history rather than the newest commit, since what is published is all of it. A message is
     worth catching BEFORE it is pushed: amending is a local edit, while rewriting pushed history is not, so the value
     of this check is entirely in running before the push. */
  const git = cp.spawnSync('git', ['-C', root, 'log', '--format=%B%x00'], { encoding: 'utf8' });
  if (git.error || git.status !== 0) {
    note('no git history to read here, so commit messages were not scanned');
  } else {
    const messages = git.stdout.split('\0').map((m) => m.trim()).filter(Boolean);
    const bads = messages.filter((m) => CJK.test(m))
      .map((m) => JSON.stringify(m.split('\n')[0].slice(0, 60)));
    if (!bads.length) ok(`no CJK in any of the ${messages.length} commit messages`);
    else bad(`commit messages carry CJK, and history travels with the repository: ${bads.slice(0, 4).join(', ')}`);
  }
}

/* ── 7. one limit on a description, spelled out in three places ──
   The view cuts a description at this length, a plugin hook refuses a write past it, and the skill quotes it to whoever
   is writing one. The three cannot import from each other - one is the extension, one is Python, one is prose - so the
   only thing that can hold them together is this.

   Drifting apart has a specific shape worth naming: a gate that refuses at one length while the view cuts at another is
   a gate nobody can satisfy, and the message it prints would state a number that is not the one being enforced. */
console.log('\none limit on a description');
{
  const root = path.join(__dirname, '..');
  const plan = require('../src/workplan');
  const hook = fs.readFileSync(
    path.join(root, 'claude-plugin', 'agent-work-plan', 'hooks', 'plan_path.py'), 'utf8');
  const skill = fs.readFileSync(
    path.join(root, 'claude-plugin', 'agent-work-plan', 'skills', 'maintain', 'SKILL.md'), 'utf8');
  const num = (src, name) => {
    const m = new RegExp('^' + name + ' = (\\d+)$', 'm').exec(src);
    return m ? Number(m[1]) : null;
  };
  const quoted = /limited to (\d+) lines and (\d+) characters/.exec(skill);
  const want = [plan.MAX_DETAIL_LINES, plan.MAX_DETAIL_CHARS];
  const saw = {
    'the hooks and the row command (plan_path.py)': [num(hook, 'MAX_DETAIL_LINES'), num(hook, 'MAX_DETAIL_CHARS')],
    'the skill that asks for it': quoted ? [Number(quoted[1]), Number(quoted[2])] : [null, null],
  };
  const off = Object.entries(saw)
    .filter(([, got]) => got[0] !== want[0] || got[1] !== want[1])
    .map(([who, got]) => `${who} says ${got[0]}/${got[1]}`);
  if (!off.length) ok(`all three say ${want[0]} lines and ${want[1]} characters`);
  else bad(`the view cuts at ${want[0]}/${want[1]} but ${off.join(', ')}`);
}

/* ── 8. deleting the plans of conversations that no longer exist ──
   The only code here that removes a file somebody wrote, so the cases that must NOT delete matter more than the one that
   must. Everything below runs against a directory made for the purpose; the real one is never named. */
console.log('\nabandoned work plans');
{
  const plan = require('../src/workplan');
  const OLD = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const NEW = Date.now();
  const id = (n) => `${n}${'0'.repeat(7)}-0000-0000-0000-000000000000`;

  /* A tree holding the transcripts named in `live`, a plan for each id in `plans`, and an offered-mark for each id in
     `marks` - all with the age given beside them. */
  const build = (live, plans, marks) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-sweep-'));
    const projects = path.join(root, 'projects');
    const dir = path.join(root, 'plans');
    fs.mkdirSync(path.join(projects, '-some-project'), { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const s of live) fs.writeFileSync(path.join(projects, '-some-project', s + '.jsonl'), '{}\n');
    const age = (f, at) => fs.utimesSync(f, at / 1000, at / 1000);
    for (const [s, at] of plans) {
      const f = path.join(dir, s + '.json');
      fs.writeFileSync(f, '{"nodes":[]}');
      age(f, at);
    }
    for (const [s, at] of marks || []) {
      const f = path.join(dir, s + '.offered');
      fs.writeFileSync(f, '');
      age(f, at);
    }
    return { root, projects, dir };
  };
  const left = (dir) => fs.readdirSync(dir).sort();

  const cases = [
    ['an abandoned plan that has settled is deleted',
      () => build([id(1)], [[id(1), OLD], [id(2), OLD]]),
      (t, r) => r.deleted === 1 && r.kept === 1 && left(t.dir).join() === id(1) + '.json'],
    ['a plan whose conversation is still there is kept',
      () => build([id(1), id(2)], [[id(1), OLD], [id(2), OLD]]),
      (t, r) => r.deleted === 0 && r.kept === 2 && left(t.dir).length === 2],
    ['an abandoned plan written this week is kept',
      () => build([id(1)], [[id(2), NEW]]),
      (t, r) => r.deleted === 0 && r.kept === 1 && left(t.dir).length === 1],
    ['nothing is deleted when no transcript can be read',
      () => { const t = build([], [[id(1), OLD], [id(2), OLD]]); return t; },
      (t, r) => r.deleted === 0 && !!r.why && left(t.dir).length === 2],
    ['nothing is deleted when the transcript directory is missing',
      () => { const t = build([id(1)], [[id(2), OLD]]); fs.rmSync(t.projects, { recursive: true }); return t; },
      (t, r) => r.deleted === 0 && !!r.why && left(t.dir).length === 1],
    ['a sub-agent transcript does not count as a conversation',
      () => {
        const t = build([id(1)], [[id(2), OLD]]);
        const deep = path.join(t.projects, '-some-project', id(2), 'subagents');
        fs.mkdirSync(deep, { recursive: true });
        fs.writeFileSync(path.join(deep, 'agent-abc.jsonl'), '{}\n');
        return t;
      },
      (t, r) => r.deleted === 1 && left(t.dir).length === 0],
    ['a file that is not a plan is left where it is',
      () => {
        const t = build([id(1)], []);
        fs.writeFileSync(path.join(t.dir, 'notes.txt'), 'mine');
        fs.mkdirSync(path.join(t.dir, 'archive'));
        return t;
      },
      (t, r) => r.deleted === 0 && left(t.dir).join() === 'archive,notes.txt'],
    /* The Stop hook leaves one of these behind for a conversation it offered a plan to and that never wrote one. It is
       the only trace such a conversation leaves, so nothing else would ever remove it. */
    ['the mark saying a plan was offered goes when its conversation does',
      () => build([id(1)], [], [[id(2), OLD]]),
      (t, r) => r.deleted === 1 && left(t.dir).length === 0],
    ['that mark is kept while the conversation is still there',
      () => build([id(2)], [], [[id(2), OLD]]),
      (t, r) => r.deleted === 0 && r.kept === 1 && left(t.dir).join() === id(2) + '.offered'],
    ['and kept while it is younger than the settling time, like a plan',
      () => build([id(1)], [], [[id(2), NEW]]),
      (t, r) => r.deleted === 0 && r.kept === 1 && left(t.dir).length === 1],
    /* The list of detached sessions a conversation started describes that conversation, so it follows it out. */
    ['the list of sessions a conversation started goes when the conversation does',
      () => {
        const t = build([id(1)], []);
        const f = path.join(t.dir, id(2) + '.background');
        fs.writeFileSync(f, '{"ids":["1a2b3c4d"],"scannedTo":10}');
        fs.utimesSync(f, OLD / 1000, OLD / 1000);
        return t;
      },
      (t, r) => r.deleted === 1 && left(t.dir).length === 0],
    ['and is kept while the conversation is still there',
      () => {
        const t = build([id(2)], []);
        const f = path.join(t.dir, id(2) + '.background');
        fs.writeFileSync(f, '{"ids":["1a2b3c4d"],"scannedTo":10}');
        fs.utimesSync(f, OLD / 1000, OLD / 1000);
        return t;
      },
      (t, r) => r.deleted === 0 && left(t.dir).join() === id(2) + '.background'],
    /* The mark saying which turn a conversation is in. Rewritten every turn, so a live conversation's is always young;
       one that outlived its conversation is the only kind that gets old. */
    ['the mark of a conversation\'s current turn goes when the conversation does',
      () => {
        const t = build([id(1)], []);
        const f = path.join(t.dir, id(2) + '.turn');
        fs.writeFileSync(f, '{"prompt":"p","began":1}');
        fs.utimesSync(f, OLD / 1000, OLD / 1000);
        return t;
      },
      (t, r) => r.deleted === 1 && left(t.dir).length === 0],
    ['and is kept while the conversation is still there',
      () => {
        const t = build([id(2)], []);
        const f = path.join(t.dir, id(2) + '.turn');
        fs.writeFileSync(f, '{"prompt":"p","began":1}');
        fs.utimesSync(f, OLD / 1000, OLD / 1000);
        return t;
      },
      (t, r) => r.deleted === 0 && left(t.dir).join() === id(2) + '.turn'],
    /* Which context marks have already asked a conversation to bring its plan up to date. */
    ['the water-mark state of a conversation goes when the conversation does',
      () => {
        const t = build([id(1)], []);
        const f = path.join(t.dir, id(2) + '.watermark');
        fs.writeFileSync(f, '- fired: 170000\n');
        fs.utimesSync(f, OLD / 1000, OLD / 1000);
        return t;
      },
      (t, r) => r.deleted === 1 && left(t.dir).length === 0],
    ['and is kept while the conversation is still there',
      () => {
        const t = build([id(2)], []);
        const f = path.join(t.dir, id(2) + '.watermark');
        fs.writeFileSync(f, '- fired: 170000\n');
        fs.utimesSync(f, OLD / 1000, OLD / 1000);
        return t;
      },
      (t, r) => r.deleted === 0 && left(t.dir).join() === id(2) + '.watermark'],
    /* What the time-zone hook last told a conversation; the reader's zone itself belongs to no conversation. */
    ['what a conversation was last told about the time zone goes with it, and the zone the panel reported stays',
      () => {
        const t = build([id(1)], []);
        for (const name of [id(2) + '.tz', 'client-time-zone.json', 'config.json']) {
          const f = path.join(t.dir, name);
          fs.writeFileSync(f, '{}');
          fs.utimesSync(f, OLD / 1000, OLD / 1000);
        }
        return t;
      },
      (t, r) => r.deleted === 1 && left(t.dir).sort().join() === 'client-time-zone.json,config.json'],
    /* A plan lock is a directory held for milliseconds. A day-old one is abandoned and would delay every writer until
       it times out, so it is removed; a younger one may be in use and is kept, whatever the transcripts say. */
    ['a plan\'s lock a day old is removed, and a younger one is left to whoever holds it',
      () => {
        const t = build([id(1), id(2)], [[id(1), NEW], [id(2), NEW]]);
        fs.mkdirSync(path.join(t.dir, id(1) + '.json.lock'));
        fs.utimesSync(path.join(t.dir, id(1) + '.json.lock'), OLD / 1000, OLD / 1000);
        fs.mkdirSync(path.join(t.dir, id(2) + '.json.lock'));
        return t;
      },
      (t, r) => r.deleted === 0 && left(t.dir).join() === [id(1) + '.json', id(2) + '.json', id(2) + '.json.lock'].join()],
    ['what the sweep read of the transcripts comes back with it, for the efforts beside the panel',
      () => build([id(1), id(2)], []),
      (t, r) => r.live instanceof Set && r.live.size === 2 && r.live.has(id(1))],
    /* A project folder that cannot be listed hides its conversations; taking them for gone deletes their plans. */
    ['nothing is deleted when one project folder cannot be read',
      () => {
        const t = build([id(1)], [[id(2), OLD]]);
        const locked = path.join(t.projects, '-locked');
        fs.mkdirSync(locked);
        fs.writeFileSync(path.join(locked, id(2) + '.jsonl'), '{}\n');
        fs.chmodSync(locked, 0);
        t.restore = () => fs.chmodSync(locked, 0o755);
        return t;
      },
      (t, r) => CANNOT_LOCK || (r.deleted === 0 && !!r.why && left(t.dir).length === 1)],
  ];

  for (const [what, make, want] of cases) {
    const t = make();
    let r;
    try { r = plan.sweepOrphans({ dir: t.dir, projects: t.projects }); }
    catch (e) { bad(`${what}: threw ${e.message}`); fs.rmSync(t.root, { recursive: true, force: true }); continue; }
    finally { if (t.restore) t.restore(); }
    if (want(t, r)) ok(what);
    else bad(`${what}: got ${JSON.stringify(r)} leaving ${JSON.stringify(left(t.dir))}`);
    fs.rmSync(t.root, { recursive: true, force: true });
  }
}

/* ── 9. one live stylesheet, several windows ──
   The file belongs to the Claude Code install; an extension host belongs to a window, and every one of them writes it.
   Two windows that disagree about its content put their own version back in turn, and the panel reloads the stylesheet
   each time - which is a setting that appears and disappears on a timer. A regression here is silent, hence these. */
console.log('\none live stylesheet, several windows');
{
  const tasks = require('../src/tasks');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-live-'));
  const project = (name, n, tag) => {
    const d = path.join(root, name);
    fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
    const list = [];
    for (let i = 0; i < n; i++) list.push({ id: tag + i, cron: '* * * * *', createdBySessionId: 's-' + tag });
    fs.writeFileSync(path.join(d, '.claude', 'scheduled_tasks.json'), JSON.stringify({ tasks: list }));
    return d;
  };

  /* The directories reach this most recently opened first, so their order differs per window. */
  const a = project('alpha', 1, 'a'), b = project('beta', 1, 'b');
  if (JSON.stringify(tasks.readTasks([a, b])) === JSON.stringify(tasks.readTasks([b, a]))) {
    ok('two windows listing the same projects in a different order agree');
  } else bad('the task list still follows the order the directories arrived in');

  /* Stronger: with more tasks than the cap, WHICH of them survive must not depend on that order either. */
  const c = project('gamma', tasks.MAX_TASKS - 5, 'g'), e = project('delta', tasks.MAX_TASKS - 5, 'd');
  if (JSON.stringify(tasks.readTasks([c, e])) === JSON.stringify(tasks.readTasks([e, c]))) {
    ok(`at the cap of ${tasks.MAX_TASKS}, which tasks survive does not depend on that order either`);
  } else bad('at the cap, the surviving tasks still depend on the order the directories arrived in');

  /* Directories to read, kept in a store shared by all windows. If each window put its own folders first, two windows
     with different folders would rewrite the store on every refresh and, past the cap, keep different sets. Two windows
     taking turns: */
  {
    const day = 86400000, t0 = Date.UTC(2026, 9, 29, 12);
    const isDir = () => true;
    const many = Array.from({ length: tasks.MAX_DIRS + 8 }, (_, i) => '/p/' + String(i).padStart(2, '0'));
    const windowA = ['/p/a', ...many.slice(0, 20)], windowB = ['/p/b', ...many.slice(20)];
    let store = ['/p/old-list', '/p/a'];
    const writes = [], lists = [];
    for (let round = 0; round < 4; round++) {
      for (const [name, open] of [['A', windowA], ['B', windowB]]) {
        const r = tasks.rememberDirs(store, open, { now: t0 + round * 60000, isDir });
        if (r.changed) { writes.push(name + round); store = r.store; }
        lists.push(JSON.stringify(r.dirs));
      }
    }
    const settled = lists.slice(-4);
    if (writes.length <= 2 && new Set(settled).size === 1 && JSON.parse(settled[0]).length === tasks.MAX_DIRS) {
      ok(`two windows with different folders open settle on one list of ${tasks.MAX_DIRS} directories and stop rewriting the store`);
    } else bad(`two windows taking turns wrote ${JSON.stringify(writes)} and read ${settled.map((l) => JSON.parse(l).length).join('/')} directories`);
    const later = tasks.rememberDirs(store, windowA, { now: t0 + day, isDir });
    const gone = tasks.rememberDirs({ '/p/a': 1, '/nowhere': 1 }, [], { now: t0, isDir: (d) => d !== '/nowhere' });
    const legacy = tasks.rememberDirs(['/p/x', '/p/y'], [], { now: t0, isDir });
    if (later.changed && gone.dirs.join() === '/p/a' && legacy.dirs.join() === '/p/x,/p/y' && legacy.changed) {
      ok('the store changes again when a day turns, drops a directory that is gone, and reads the list an earlier build kept');
    } else bad(`a day on changed ${later.changed}; with one gone ${JSON.stringify(gone.dirs)}; from a list ${JSON.stringify(legacy.dirs)}`);
    /* Windows on an earlier build keep a plain list under the old key; both formats in one key would make the two
       builds rewrite it in turn. */
    const extDirs = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    if (/const DIRS_KEY = 'claudeCodeExtras\.projectDirDays';/.test(extDirs) && /const OLD_DIRS_KEY = 'claudeCodeExtras\.projectDirs';/.test(extDirs)
      && /context\.globalState\.update\(DIRS_KEY, r\.store\)/.test(extDirs) && !/update\(OLD_DIRS_KEY/.test(extDirs)) {
      ok('the folders and their days are kept under a key of their own, started from the list an earlier build keeps');
    } else bad('the remembered folders share a key with the list an earlier build writes');
  }

  const wv = path.join(root, 'webview');
  fs.mkdirSync(wv, { recursive: true });
  const css = path.join(wv, 'claude-code-extras.css');
  const ours = require('../package.json').version;
  const head = () => fs.readFileSync(css, 'utf8').split('\n')[0];
  const opts = { enabled: true, userEdge: true };

  if (webview.writeLive(root, opts) && head().includes(ours)) ok('the stylesheet records which build wrote it');
  else bad('the stylesheet does not carry the writing build, so nothing can tell two of them apart');

  if (webview.writeLive(root, opts) === false) ok('the same settings again writes nothing');
  else bad('an unchanged stylesheet is rewritten, which reloads it in every panel');

  fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace('Extras ' + ours, 'Extras 9.9.9'));
  if (webview.writeLive(root, { enabled: true, userEdge: false }) === false && head().includes('9.9.9')) {
    ok('what a newer build wrote is left alone');
  } else bad('an older build overwrites a newer one, which is the flicker this prevents');

  /* Yielding to a newer stamp lasts only as long as that build is installed. A version number can go down - a build
     that shipped, then was withdrawn in favour of a lower number - and then no host anywhere can rewrite the file: every
     one of them reads a version above its own and backs off, which froze a real stylesheet for two days with nothing
     reporting an error. The registry beside the install is what settles it, because the folder of a replaced version
     stays on disk and so a name scan still answers yes. */
  const registry = path.join(path.dirname(root), 'extensions.json');
  const id = require('../package.json').publisher + '.' + require('../package.json').name;
  const hadRegistry = fs.existsSync(registry);
  const savedRegistry = hadRegistry ? fs.readFileSync(registry, 'utf8') : null;
  fs.writeFileSync(registry, JSON.stringify([{ identifier: { id }, version: '9.9.9' }]));
  if (webview.writeLive(root, { enabled: true, userEdge: false }) === false && head().includes('9.9.9')) {
    ok('a newer stamp is honoured while that build is still installed');
  } else bad('a newer build that is still installed gets overwritten, which is the flicker this prevents');

  fs.writeFileSync(registry, JSON.stringify([{ identifier: { id }, version: ours }]));
  if (webview.writeLive(root, opts) === true && head().includes(ours)) {
    ok('a stamp from a build no longer installed is taken over, so a withdrawn version cannot freeze the file');
  } else bad('a withdrawn build keeps the stylesheet for good, and the panel silently stops being updated');
  if (hadRegistry) fs.writeFileSync(registry, savedRegistry); else fs.unlinkSync(registry);

  fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace('Extras ' + ours, 'Extras 0.0.1'));
  if (webview.writeLive(root, opts) === true && head().includes(ours)) ok('what an older build wrote is taken over');
  else bad('an older build keeps the file, so an upgrade never reaches the panel');

  fs.writeFileSync(css, '/* Claude Code Extras live settings - written by the extension */\n');
  if (webview.writeLive(root, opts) === true) ok('a file from before this rule is taken over');
  else bad('a stylesheet carrying no version is never replaced');

  /* And the part that does not depend on winning that race at all. A build old enough to predate the version rule
     overwrites the file without knowing what it dropped, and nothing written today stops a host that is already running
     - so the bar on your own messages is carried by the injected script, switched by a property that counts as on when
     it is absent. That is what makes an older build unable to turn it off. */
  const edge = webview.SCRIPT.includes('var EDGE_CSS =');
  const onByDefault = /var\(--cce-edge,\s*1\)/.test(webview.SCRIPT);
  const notInSheet = !webview.liveCss({ enabled: true, userEdge: true }).includes('--cce-edge');
  const offWhenAsked = webview.liveCss({ enabled: true, userEdge: false }).includes('--cce-edge:0');
  if (edge && onByDefault && notInSheet && offWhenAsked) {
    ok('the bar is in the injected script and defaults to on, so an older build cannot drop it');
  } else {
    bad('the bar depends on the shared stylesheet again'
      + ` (in script: ${edge}, defaults on: ${onByDefault}, absent when on: ${notInSheet}, off when asked: ${offWhenAsked})`);
  }

  /* Two windows at once: one writes the stylesheet while the other writes efforts between that write and the
     revision-image update. Each updates only its own counter, so neither restores the other's old value. */
  {
    const inst = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-rev-race-'));
    const wv = path.join(inst, 'webview');
    fs.mkdirSync(wv);
    const revOf = () => {
      const t = fs.readFileSync(path.join(wv, 'claude-code-extras.rev.svg'), 'utf8');
      return [Number(/width="(\d+)"/.exec(t)[1]), Number(/height="(\d+)"/.exec(t)[1])];
    };
    const sid = 'eeeeeeee-2222-4333-8444-555555555555';
    const effort = path.join(wv, webview.EFFORT_PREFIX + sid + '.css');
    const realWrite = fs.writeFileSync, realRename = fs.renameSync;
    /* Runs `other` once, the moment the first temporary file for `file` has been written. */
    const meanwhile = (file, other) => {
      let done = false;
      fs.writeFileSync = function (f, ...rest) {
        const out = realWrite.call(fs, f, ...rest);
        if (!done && String(f).startsWith(file + '.')) { done = true; other(); }
        return out;
      };
      return () => done;
    };
    try {
      webview.writeLive(inst, { enabled: true });
      const before = revOf();
      const raced = meanwhile(path.join(wv, 'claude-code-extras.css'), () => webview.writeEffort(inst, sid, 'first'));
      webview.writeLive(inst, { enabled: true, userColor: '#90EE90' });
      fs.writeFileSync = realWrite;
      const after = revOf();
      if (raced() && after[0] === before[0] + 1 && after[1] === before[1] + 1) {
        ok('an efforts write landing during a stylesheet write keeps its move of the revision image, and the stylesheet keeps its own');
      } else bad(`revisions went ${JSON.stringify(before)} -> ${JSON.stringify(after)} with an efforts write in between (raced ${raced()})`);

      /* Two windows replacing the same file at once each use their own temporary file, so both renames succeed. */
      let threw = null;
      const nested = meanwhile(effort, () => webview.writeEffort(inst, sid, 'second'));
      try { webview.writeEffort(inst, sid, 'third'); } catch (e) { threw = e.message; }
      fs.writeFileSync = realWrite;
      const leftover = () => fs.readdirSync(wv).filter((n) => n.endsWith('.tmp'));
      if (nested() && !threw && fs.readFileSync(effort, 'utf8') === 'third' && !leftover().length) {
        ok('two windows writing one file at the same moment both succeed, and no temporary file is left behind');
      } else bad(`two writes at once: threw ${threw}, the file holds ${JSON.stringify(fs.readFileSync(effort, 'utf8'))}, left ${JSON.stringify(leftover())}`);

      let refused = 0;
      fs.renameSync = function (from, to) {
        if (to === effort && !refused) { refused++; const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; }
        return realRename.call(fs, from, to);
      };
      let failed = null;
      try { webview.writeEffort(inst, sid, 'fourth'); } catch (e) { failed = e.message; }
      fs.renameSync = realRename;
      if (refused === 1 && !failed && fs.readFileSync(effort, 'utf8') === 'fourth' && !leftover().length) {
        ok('a rename refused once is tried again, and the write still lands');
      } else bad(`with one rename refused: ${failed || 'no error'}, the file holds ${JSON.stringify(fs.readFileSync(effort, 'utf8'))}, left ${JSON.stringify(leftover())}`);
    } finally {
      fs.writeFileSync = realWrite; fs.renameSync = realRename;
      fs.rmSync(inst, { recursive: true, force: true });
    }
  }

  fs.rmSync(root, { recursive: true, force: true });
}

/* ── 10. what is left to do, drawn first ──
   A plan only grows, so in the file's own order the few rows that still need doing scatter among the many that are done.
   The block injected every turn draws the open ones first; the number a person says has to survive that. */
console.log('\nwhat is left to do, drawn first');
{
  const plan = require('../src/workplan');
  const N = (title, state) => ({ title, state });

  if (plan.OPEN_STATES.includes('doing') && plan.OPEN_STATES.includes('waiting')) {
    ok('doing and waiting rows count as open');
  } else bad(`open states ${plan.OPEN_STATES.join()}`);

  if (plan.STATES.length === 7 && plan.STATES.includes('doing') && plan.STATES.includes('waiting')) {
    ok('seven states, doing and waiting among them');
  } else bad(`the states are ${plan.STATES.join()}`);

  /* The number a person says out loud, which the tree and the injected rows both show. It comes from the file, so
     finishing something does not renumber what is left - dense numbering over the visible rows alone would mean a number
     quoted an hour ago points at a different row now. */
  const cp = require('child_process');
  const hook = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks', 'inject-work-plan.py');
  const numbersRaw = (nodes) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-raw-'));
    const session = '41000000-0000-0000-0000-000000000000';
    fs.writeFileSync(path.join(dir, session + '.json'), JSON.stringify({ nodes }));
    const r = cp.spawnSync('python3', [hook, dir], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit' }),
    });
    fs.rmSync(dir, { recursive: true, force: true });
    try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) { return ''; }
  };
  const numbers = (nodes) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-num-'));
    const session = '40000000-0000-0000-0000-000000000000';
    fs.writeFileSync(path.join(dir, session + '.json'), JSON.stringify({ nodes }));
    const r = cp.spawnSync('python3', [hook, dir], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit' }),
    });
    fs.rmSync(dir, { recursive: true, force: true });
    let said = '';
    try { said = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) { return []; }
    /* The dot after the number is part of what is drawn, so it is matched and kept out of the capture. */
    return said.split('\n').map((l) => (/^\s*[?o=+x] ([0-9.]+)\. /.exec(l) || [])[1]).filter(Boolean);
  };
  {
    const got = numbers([
      N('one', 'todo'),
      Object.assign(N('two', 'todo'), { children: [N('two-a', 'todo'), N('two-b', 'todo')] }),
      N('three', 'todo'),
    ]);
    if (got.join(',') === '3,2,2.2,2.1,1') ok('numbers come from the file while the rows are drawn newest first');
    else bad(`the numbering came out ${JSON.stringify(got)}`);
  }
  {
    /* The one instruction that has to arrive before the work rather than after it. Left to the skill alone it reaches an
       agent only when the description happens to match; here it arrives every turn, which is the difference between the
       state being used and being decoration. */
    const said = numbersRaw([N('one', 'todo')]);
    if (said.includes('`doing` as you start on it')) ok('the injected block asks for doing before the work, every turn');
    else bad(`the injected block does not mention doing: ${JSON.stringify(said.slice(0, 160))}`);
  }
  {
    /* Closing the first row must not move the numbers of the rest. */
    const open = numbers([N('one', 'todo'), N('two', 'todo'), N('three', 'todo')]);
    const closed = numbers([N('one', 'done'), N('two', 'todo'), N('three', 'todo')]);
    if (open.join(',') === '3,2,1' && closed.join(',') === '3,2') {
      ok('a row that closes leaves a gap rather than renumbering what follows');
    } else bad(`before ${JSON.stringify(open)}, after closing the first ${JSON.stringify(closed)}`);
  }
}

/* ── 11. what the Stop hook says, and how often ──
   The hook is the only part of the plugin that can start a plan existing, because until one does the injection has
   nothing to inject and the skill is found only when its description happens to match. Both halves of that are worth
   a test: it has to speak on a conversation keeping no plan, and it has to do so exactly once. Run as a process, since
   the thing under test is the whole script including the marker it writes. */
console.log('\nwhat the Stop hook says, and how often');
{
  const hook = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks', 'nudge-work-plan.py');
  const session = '30000000-0000-0000-0000-000000000000';

  /* `turns` messages from the user, the last of them followed by `tools` calls. The hook walks the transcript backwards
     to that last message for the turn, and over the whole tail for how many times the user has spoken. */
  const stage = (tools, plan, turns = 3, limits) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-nudge-'));
    const data = path.join(dir, 'data');
    fs.mkdirSync(data);
    const transcript = path.join(dir, 'transcript.jsonl');
    const lines = [];
    for (let t = 0; t < turns; t++) {
      lines.push(JSON.stringify({
        type: 'user', timestamp: `2026-01-01T00:0${t}:00.000Z`, message: { content: 'go' },
      }));
      if (t < turns - 1) lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }));
    }
    for (let i = 0; i < tools; i++) {
      // Write rather than Read: the reminder counts what a turn CHANGED, so a turn of reads owes the plan nothing.
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } }));
    }
    fs.writeFileSync(transcript, lines.join('\n') + '\n');
    if (plan) {
      const f = path.join(data, session + '.json');
      fs.writeFileSync(f, JSON.stringify(plan));
      const back = Date.parse('2025-01-01T00:00:00Z') / 1000;
      fs.utimesSync(f, back, back);
    }
    if (limits) fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(limits));
    return { dir, data, transcript };
  };
  const run = (t) => {
    const r = cp.spawnSync('python3', [hook, t.data], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: session, transcript_path: t.transcript, hook_event_name: 'Stop' }),
    });
    const said = (r.stdout || '').trim();
    return { said, marked: fs.existsSync(path.join(t.data, session + '.offered')), status: r.status };
  };

  {
    const t = stage(30, null);
    const first = run(t), second = run(t);
    if (first.said.includes('keeping no work plan') && first.marked) ok('a busy turn with no plan at all is told it could keep one');
    else bad(`a busy turn with no plan said ${JSON.stringify(first.said.slice(0, 80))}, marked ${first.marked}`);
    if (!second.said) ok('and is not told a second time');
    else bad(`the offer repeats: ${JSON.stringify(second.said.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    const t = stage(5, null);
    const r = run(t);
    if (!r.said && !r.marked) ok('a small turn with no plan is left alone, and no mark is spent on it');
    else bad(`a 5-tool turn was spoken to: ${JSON.stringify(r.said.slice(0, 80))}, marked ${r.marked}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    const t = stage(10, { nodes: [{ title: 'x', state: 'todo' }] });
    const r = run(t);
    if (r.said.includes('neither read nor updated')) ok('a plan left untouched by the turn is still the other message');
    else bad(`an untouched plan said ${JSON.stringify(r.said.slice(0, 80))}`);
    /* Stop fires more than once in a single exchange - eight times in one, in the conversation this was measured in -
       so without this the reminder arrives in bursts, and a burst is what taught the reader to skip it. Saying it again
       about a plan in the same state adds nothing: a reminder that did not work the first time does not work fifth. */
    const again = [run(t), run(t), run(t)].filter((x) => x.said).length;
    if (!again) ok('and is not repeated while the plan stays in that state');
    else bad(`the reminder repeated ${again} more times in the same turn`);
    /* Once the plan has moved on, forgetting again has to be catchable again. */
    const at = path.join(t.data, session + '.json');
    // Later than when the reminder last spoke, still earlier than the turn - a plan newer than the turn is already left
    // alone by the condition above, so testing against a current timestamp would prove nothing about this one.
    const moved = Date.parse('2025-06-01T00:00:00Z') / 1000;
    fs.utimesSync(at, moved, moved);
    if (run(t).said) ok('and comes back once the plan has been written to since');
    else bad('the reminder stayed silent after the plan changed');
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  /* What the threshold is really asking is whether the turn changed anything, not how busy it looked. A turn of reading
     and measuring makes plenty of calls and owes the plan nothing - 18 of 29 reminders went to turns like this one. */
  {
    const t = stage(0, { nodes: [{ title: 'x', state: 'todo' }] });
    for (let i = 0; i < 20; i++) {
      fs.appendFileSync(t.transcript, JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: "grep -rn foo . | sed 's/^/  /'" } }] },
      }) + '\n');
    }
    const r = run(t);
    if (!r.said) ok('a turn of twenty read-only commands is not reminded of anything');
    else bad(`a read-only turn said ${JSON.stringify(r.said.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  /* Which shell commands count as changing something, by example. `>` means a redirect to a shell and a comparison to
     everything else, and a heredoc script arrives as one argument so both meanings sit in the same string - a `count >= 4`
     inside an embedded script read as a write and put the reminder back on turns that had changed nothing. Only examples
     hold a judgement like this; a description of the pattern would have looked correct in that state too. */
  {
    const reads = [
      'python3 -c "if n >= 4: print(1)"',
      'python3 -c "if a <= b and c => d: pass"',
      "grep -c foo bar | sed 's/^/  /'",
      'node test/check.js 2>&1 | tail -1',
      'ls -d ~/x > /dev/null 2>&1; echo ok',
      'git log --format="%h" -S "foo" | tail -3',
      'git status --short',
      "awk '$3 > 5' f",
      "grep -n 'p->next' x.c",
      "jq '.items | length > 3' f",
      'python3 -c "open(\'agents.json\').read()"',
      "git log | grep 'rm '",
    ];
    const writes = [
      'echo hi > /tmp/a', 'echo hi >> notes.txt', 'git commit -m x', 'git add .',
      'cp a b', 'rm -rf build', 'sed -i "s/a/b/" f', 'mkdir -p out && touch out/x',
    ];
    const judge = (command) => {
      const t = stage(0, { nodes: [{ title: 'x', state: 'todo' }] });
      for (let i = 0; i < 3; i++) {
        fs.appendFileSync(t.transcript, JSON.stringify({
          type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
        }) + '\n');
      }
      const said = !!run(t).said;
      fs.rmSync(t.dir, { recursive: true, force: true });
      return said;
    };
    const wrongly = reads.filter(judge);
    const missed = writes.filter((c) => !judge(c));
    if (!wrongly.length) ok(`${reads.length} read-only commands are all seen as changing nothing`);
    else bad(`read-only commands counted as changes: ${JSON.stringify(wrongly)}`);
    if (!missed.length) ok(`${writes.length} writing commands are all seen as changes`);
    else bad(`writing commands counted as read-only: ${JSON.stringify(missed)}`);
    /* The longer list, quoted text and here-documents included, is the judgement's own. */
    const own = cp.spawnSync('python3', [path.join(path.dirname(hook), 'changes.py'), '--selftest'], { encoding: 'utf8' });
    const out = (own.stdout || '') + (own.stderr || '');
    if (own.status === 0 && /all checks pass/.test(out)) ok(`changes.py: ${out.split('\n').filter((l) => /^PASS /.test(l)).join(', ').replace(/PASS /g, '')}`);
    else bad(`changes.py: ${out.split('\n').filter((l) => /^FAIL|Error|Traceback/.test(l)).join(' | ') || out.slice(-300)}`);
  }
  /* Reading the plan has to count, or the reminder cannot be answered at all: reading leaves no mark on the file, so a
     turn that looked and a turn that forgot look identical from the file's age, and the reminder repeats for the rest of
     a conversation whose plan is already correct. */
  {
    const t = stage(10, { nodes: [{ title: 'x', state: 'todo' }] });
    const at = path.join(t.data, session + '.json');
    fs.appendFileSync(t.transcript, JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: at } }] },
    }) + '\n');
    const r = run(t);
    if (!r.said) ok('a turn that read the plan and changed nothing is left alone');
    else bad(`reading the plan still drew ${JSON.stringify(r.said.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  /* The trap in counting a read: this plugin injects the plan's own path at the top of every turn, so looking for the
     path anywhere in the turn would find it every time and the reminder could never fire. Only the calls the assistant
     made are searched. */
  {
    const t = stage(10, { nodes: [{ title: 'x', state: 'todo' }] });
    const at = path.join(t.data, session + '.json');
    const lines = fs.readFileSync(t.transcript, 'utf8').trimEnd().split('\n');
    lines[0] = JSON.stringify({
      type: 'user', timestamp: '2026-01-01T00:00:00.000Z',
      message: { content: `the file is ${at}\ngo` },
    });
    fs.writeFileSync(t.transcript, lines.join('\n') + '\n');
    const r = run(t);
    if (r.said.includes('neither read nor updated')) ok('the path appearing in injected context is not mistaken for a read');
    else bad(`injected context silenced the reminder: ${JSON.stringify(r.said.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    /* The case this gate exists for. A session handed one task and left to do it burns tool calls on a single strand and
       cannot branch, so a plan has nothing to hold - and 53 of 61 offers went to exactly that. Offering anyway costs the
       sentence and teaches whoever reads it that the sentence can be skipped, which is what the offer had left to lose. */
    const t = stage(40, null, 1);
    const r = run(t);
    if (!r.said && !r.marked) ok('a busy single-turn worker is not offered a plan, and no mark is spent on it');
    else bad(`a single-turn worker was offered one: ${JSON.stringify(r.said.slice(0, 80))}, marked ${r.marked}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    /* Both thresholds come from the file the extension writes, and the editor's settings are the only place to edit it. */
    const t = stage(40, null, 2, { offerMinTurns: 9 });
    const r = run(t);
    const u = stage(40, null, 2, { offerMinTurns: 2 });
    const ru = run(u);
    if (!r.said && ru.said.includes('keeping no work plan')) ok('the turn threshold is read from the settings file, either way');
    else bad(`raising it said ${JSON.stringify(r.said.slice(0, 60))}, lowering it said ${JSON.stringify(ru.said.slice(0, 60))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
    fs.rmSync(u.dir, { recursive: true, force: true });
  }
  {
    /* A session that keeps no transcript - `claude -p --no-session-persistence` is one - still runs this hook, with a
       path to a file that was never written. A traceback here is drawn in the panel as a failed Stop hook. */
    const t = stage(10, { nodes: [{ title: 'x', state: 'todo' }] });
    fs.rmSync(t.transcript);
    const r = run(t);
    if (r.status === 0 && !r.said) ok('a transcript that cannot be read leaves the hook silent, not failing');
    else bad(`with no transcript the hook exited ${r.status} and said ${JSON.stringify(r.said.slice(0, 120))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  /* The client also writes rows as the user: skill text and scheduled wake-ups (isMeta), compaction summaries
     (isCompactSummary) and interruption lines. Counted as the user, a skill loaded at the end of a turn would move the
     turn start past all its work, and summaries would make a worker addressed once look addressed three times. */
  {
    const said = [
      { type: 'user', isMeta: true, sourceToolUseID: 't1', message: { content: [{ type: 'text', text: 'Base directory for this skill: /x' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation.' } },
    ].map((row) => {
      const t = stage(10, { nodes: [{ title: 'x', state: 'todo' }] });
      fs.appendFileSync(t.transcript, JSON.stringify(Object.assign({ timestamp: '2026-01-01T00:09:00.000Z' }, row)) + '\n');
      const r = run(t);
      fs.rmSync(t.dir, { recursive: true, force: true });
      return r.said.includes('neither read nor updated');
    });
    if (said.every(Boolean)) ok('a skill loaded, an interruption or a summary at the end of a turn does not restart it');
    else bad(`after a skill, an interruption and a summary the reminder spoke ${JSON.stringify(said)}`);
  }
  {
    const t = stage(40, null, 1);
    const lines = fs.readFileSync(t.transcript, 'utf8').trimEnd().split('\n');
    const summary = (n) => JSON.stringify({ type: 'user', isCompactSummary: true, timestamp: `2025-12-31T00:0${n}:00.000Z`,
      message: { content: 'This session is being continued from a previous conversation.' } });
    fs.writeFileSync(t.transcript, [summary(1), summary(2)].concat(lines).join('\n') + '\n');
    const r = run(t);
    if (!r.said && !r.marked) ok('a worker spoken to once is not counted as spoken to again by two compactions');
    else bad(`two summaries and one message drew an offer: ${JSON.stringify(r.said.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    /* With a plan, the injection hook's mark sets the turn start, and client-written user rows cannot move it; earlier
       calls belong to the previous turn. */
    const t = stage(0, { nodes: [{ title: 'x', state: 'todo' }] });
    const call = (at) => JSON.stringify({ type: 'assistant', timestamp: at,
      message: { content: [{ type: 'tool_use', name: 'Write', input: {} }] } });
    for (let i = 0; i < 10; i++) fs.appendFileSync(t.transcript, call(`2026-01-01T00:02:1${i}.000Z`) + '\n');
    fs.appendFileSync(t.transcript, call('2026-01-01T00:05:00.000Z') + '\n');
    fs.writeFileSync(path.join(t.data, session + '.turn'), JSON.stringify({ prompt: 'p-mark', began: Date.parse('2026-01-01T00:04:00Z') / 1000 }));
    const marked = cp.spawnSync('python3', [hook, t.data], { encoding: 'utf8', input: JSON.stringify({ session_id: session,
      transcript_path: t.transcript, hook_event_name: 'Stop', prompt_id: 'p-mark' }) }).stdout.trim();
    const other = run(t).said;
    if (!marked && other.includes('neither read nor updated')) ok('the turn starts where the injection hook marked it, when the mark is for this turn');
    else bad(`with the mark: ${JSON.stringify(marked.slice(0, 80))}; without it: ${JSON.stringify(other.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    /* A file that is not there, or is nonsense, leaves the plugin on its own defaults - it ships without this extension. */
    const t = stage(40, null, 3, { offerMinTurns: 'lots', offerMinToolCalls: 0 });
    const r = run(t);
    if (r.said.includes('keeping no work plan')) ok('a nonsense settings file is ignored rather than obeyed');
    else bad(`nonsense settings changed the outcome: ${JSON.stringify(r.said.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
}

/* ── 12. the waiting, paired out of the official extension's log ──
   Every figure this produces is a subtraction between two lines that are far apart, so the risk is not arithmetic: it
   is pairing the wrong two. A trigger that never matches reports nothing and looks like a fast machine, and a gap that
   is really someone leaving the window alone reports minutes that nobody waited. Both are tested here. */
console.log('\nthe waiting, paired out of the official log');
{
  const L = require('../src/openlatency');
  const at = (clock, msg) => `2026-09-29 21:0${clock} [info] ${msg}`;
  const clicked = 'Received message from webview: {"type":"request","requestId":"a","request":{"type":"open_in_editor","sessionId":"s"}}';
  const up = 'Received message from webview: {"type":"request","requestId":"b","request":{"type":"init"}}';

  const one = (text) => L.readOut(text).waits;
  const only = (text, what) => one(text).filter((r) => r.what === what);

  {
    const got = only([at('0:00.000', clicked), at('0:30.000', up)].join('\n'), 'panel');
    if (got.length === 1 && got[0].waited === 30000 && got[0].trigger === 'click') ok('a panel asked for and slow to answer is 30s under "click"');
    else bad(`a clicked panel measured ${JSON.stringify(got)}`);
  }
  {
    const text = [at('0:00.000', 'Claude code extension is now active?'), at('0:20.000', up)].join('\n');
    const got = only(text, 'panel');
    if (got.length === 1 && got[0].waited === 20000 && got[0].trigger === 'window') ok('a panel the window restored is timed from activation');
    else bad(`a restored panel measured ${JSON.stringify(got)}`);
  }
  {
    /* A fast open still has to come out of readOut - it is the denominator - and then be counted rather than recorded. */
    const waits = one([at('0:00.000', clicked), at('0:00.900', up)].join('\n'));
    const { slow, fast } = L.split(waits, 10000);
    if (waits.length === 1 && !slow.length && fast['panel/click'] === 1) {
      ok('a fast open is counted, not recorded, so an ordinary day does not fill the file');
    } else bad(`a 0.9s open gave slow ${JSON.stringify(slow)} fast ${JSON.stringify(fast)}`);
  }
  {
    /* The threshold decides which side a wait falls on, and nothing else about it. */
    const waits = [
      { what: 'panel', trigger: 'click', waited: 9999 },
      { what: 'panel', trigger: 'click', waited: 10000 },
      { what: 'host', trigger: 'x', waited: 3000 },
    ];
    const { slow, fast } = L.split(waits, 10000);
    if (slow.length === 1 && slow[0].waited === 10000 && fast['panel/click'] === 1 && !fast['host/x']) {
      ok('the threshold is inclusive, and a short host gap is dropped rather than counted');
    } else bad(`split gave slow ${JSON.stringify(slow)} fast ${JSON.stringify(fast)}`);
  }
  {
    /* The day's count must reach the file, and as one line rather than one per open. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat5-'));
    const log = path.join(root, 'Claude VSCode.log');
    const dir = path.join(root, 'rec');
    const fastPair = (m) => [at(`${m}:00.000`, clicked), at(`${m}:00.500`, up)].join('\n');
    fs.writeFileSync(log, [fastPair(0), fastPair(1), fastPair(2)].join('\n') + '\n');
    const day1 = Date.parse('2026-09-29T12:00:00Z');
    const r1 = L.sample({ log, dir, state: {}, version: 'v1', now: day1, pid: 606, thresholdMs: 10000 });
    if (!r1.added.length && r1.state.counts['panel/click'] === 3 && !fs.existsSync(L.recordFile(dir, 606))) {
      ok('three fast opens write nothing yet and are held as a count of three');
    } else bad(`fast opens gave added ${r1.added.length}, counts ${JSON.stringify(r1.state.counts)}`);

    /* The next day, the finished one goes out. */
    fs.appendFileSync(log, [at('5:00.000', clicked), at('5:20.000', up)].join('\n') + '\n');
    const r2 = L.sample({
      log, dir, state: r1.state, version: 'v1', now: day1 + 24 * 3600 * 1000, pid: 606, thresholdMs: 10000,
    });
    const recs = L.readRecords(L.recordFile(dir, 606));
    const tally = recs.filter((x) => x.what === 'tally');
    if (tally.length === 1 && tally[0].day === '2026-09-29' && tally[0].counts['panel/click'] === 3
        && r2.added.length === 1 && r2.added[0].waited === 20000) {
      ok('when the day turns its count goes out as one line, beside the slow wait itself');
    } else bad(`day turn left ${JSON.stringify(recs)}`);

    const rows = L.summarise(recs);
    const click = rows.find((x) => x.what === 'panel' && x.trigger === 'click');
    if (click && click.n === 1 && click.fast === 3) ok('the summary shows one slow open against three fast ones');
    else bad(`summarise gave ${JSON.stringify(rows)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  /* The host-busy watcher and the patch-write log were diagnostics for one investigation (the slow first message,
     traced to the editor's webview service-worker cache). A per-second timer in every window is not worth keeping, so
     the code, its call sites and its report lines must be gone. */
  {
    const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    const lat = fs.readFileSync(path.join(__dirname, '..', 'src', 'openlatency.js'), 'utf8');
    const left = [
      ['lagWatcher in src/openlatency.js', /lagWatcher|INTERVAL_MS|LAG_FLOOR_MS/.test(lat)],
      ['patchRecord in src/openlatency.js', /patchRecord/.test(lat)],
      ['their report lines', /hostbusy|into startup/.test(lat)],
      ['their call sites in extension.js', /lagWatcher|patchRecord|lagTimer|startedAt|intoStartup/.test(ext)],
    ].filter(([, there]) => there).map(([what]) => what);
    const said = L.report([{ what: 'panel', trigger: 'window', waited: 94297, version: 'v1', at: 'x' }]).join('\n');
    if (!left.length && !/busy|patched file/.test(said)) ok('the temporary host-busy watcher and patch-write record are gone, call sites and report lines included');
    else bad('still there: ' + left.concat(/busy|patched file/.test(said) ? ['the report still talks about them'] : []).join(', '));
  }
  {
    /* Closing the window is the other moment the count is complete; losing it would lose the denominator. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat6-'));
    const n = L.flush({ dir, state: { day: '2026-09-29', version: 'v1', counts: { 'panel/click': 5 } }, pid: 707 });
    const recs = L.readRecords(L.recordFile(dir, 707));
    if (n === 5 && recs.length === 1 && recs[0].counts['panel/click'] === 5) ok('closing the window writes the day\'s count out');
    else bad(`flush returned ${n} leaving ${JSON.stringify(recs)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const text = ['2026-09-29 20:00:00.000 [info] ' + clicked, '2026-09-29 21:00:00.000 [info] ' + up].join('\n');
    if (!only(text, 'panel').length) ok('an hour of silence is treated as a window left alone, not as an hour of waiting');
    else bad('an hour-long gap was recorded as a wait');
  }
  {
    /* Two panels coming up after one click: the second must not be credited with the first one's wait. */
    const got = only([at('0:00.000', clicked), at('0:30.000', up), at('1:10.000', up)].join('\n'), 'panel');
    if (got.length === 1 && got[0].waited === 30000) ok('a second panel is not credited with the first one\'s wait');
    else bad(`two panels after one click measured ${JSON.stringify(got)}`);
  }
  {
    /* A gap that ends at a webview message belongs to the pairing above; counting it as host silence too would double it. */
    const got = one([at('0:00.000', clicked), at('0:30.000', up)].join('\n')).filter((r) => r.what === 'host');
    if (!got.length) ok('the same silence is not also counted as the host being idle');
    else bad(`the gap was double-counted: ${JSON.stringify(got)}`);
  }
  {
    const spawn = 'Spawning Claude with SDK query function - cwd: /x, permission mode: default, version: 2.1.1, /bin/claude, resume: undefined';
    const said = 'From claude: 2026-09-29T21:00:05.000Z [DEBUG] hello';
    const got = only([at('0:00.000', spawn), at('0:05.000', said)].join('\n'), 'cli');
    if (got.length === 1 && got[0].waited === 5000 && got[0].trigger === 'new') ok('a CLI slow to print its first line is timed as "new"');
    else bad(`a slow CLI spawn measured ${JSON.stringify(got)}`);
  }
  {
    const dir = path.join('/a', 'logs', '20260101T000000', 'exthost7', 'xnervwang.claude-code-plus');
    const want = path.join('/a', 'logs', '20260101T000000', 'exthost7', 'Anthropic.claude-code', 'Claude VSCode.log');
    if (L.logFile(dir) === want) ok('their log is found as a sibling of ours, not by taking the newest directory');
    else bad(`logFile gave ${L.logFile(dir)}`);
  }
  {
    /* Sampling twice must not count the same wait twice, and the second read starts mid-line. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat-'));
    const log = path.join(root, 'Claude VSCode.log');
    const dir = path.join(root, 'rec');
    fs.writeFileSync(log, [at('0:00.000', clicked), at('0:30.000', up)].join('\n') + '\n');
    const first = L.sample({ log, dir, state: {}, version: 'v1', pid: 11 });
    fs.appendFileSync(log, [at('2:00.000', clicked), at('2:40.000', up)].join('\n') + '\n');
    const second = L.sample({ log, dir, state: first.state, version: 'v1', pid: 11 });
    const waits = L.readAll(dir).filter((r) => r.what === 'panel').map((r) => r.waited).sort((a, b) => a - b);
    if (first.added.length === 1 && second.added.length === 1 && waits.join() === '30000,40000') {
      ok('a second pass reads only what was appended, and the records are the union');
    } else bad(`two passes gave ${first.added.length} then ${second.added.length}, records ${JSON.stringify(waits)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    /* Two windows, each with its own log, writing at the same time. Sharing one record file loses whichever wrote
       first, so this is the check that says they are not sharing it. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat2-'));
    const dir = path.join(root, 'rec');
    const one = path.join(root, 'a.log'), two = path.join(root, 'b.log');
    fs.writeFileSync(one, [at('0:00.000', clicked), at('0:30.000', up)].join('\n') + '\n');
    fs.writeFileSync(two, [at('1:00.000', clicked), at('1:50.000', up)].join('\n') + '\n');
    L.sample({ log: one, dir, state: {}, version: 'v1', pid: 101 });
    L.sample({ log: two, dir, state: {}, version: 'v1', pid: 202 });
    const waits = L.readAll(dir).filter((r) => r.what === 'panel').map((r) => r.waited).sort((a, b) => a - b);
    const files = fs.readdirSync(dir).sort();
    if (waits.join() === '30000,50000' && files.join() === 'open-latency-101.jsonl,open-latency-202.jsonl') {
      ok('two windows keep both sets of records, in a file each');
    } else bad(`two windows left ${JSON.stringify(files)} holding ${JSON.stringify(waits)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    /* A window that is gone leaves its file behind; without pruning a machine collects one per host it ever ran. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat3-'));
    const old = L.recordFile(dir, 303), mine = L.recordFile(dir, 404);
    for (const f of [old, mine]) fs.writeFileSync(f, JSON.stringify({ what: 'panel', waited: 2000, at: 'x' }) + '\n');
    const back = (Date.now() - L.STALE_MS - 60000) / 1000;
    fs.utimesSync(old, back, back);
    const gone = L.prune(dir, Date.now(), mine);
    const left = fs.readdirSync(dir);
    if (gone === 1 && left.join() === path.basename(mine)) ok('a long-dead window\'s file is removed and this one\'s is not');
    else bad(`prune removed ${gone}, leaving ${JSON.stringify(left)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    /* Trimming must not throw away the newest records, which is the only thing it could get wrong. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat4-'));
    const f = L.recordFile(dir, 505);
    const rows = [];
    for (let i = 0; i < L.TRIM_AT + 10; i++) rows.push(JSON.stringify({ what: 'panel', waited: i, at: String(i) }));
    fs.writeFileSync(f, rows.join('\n') + '\n');
    const dropped = L.trim(f);
    const kept = L.readRecords(f);
    if (kept.length === L.KEEP && kept[kept.length - 1].waited === L.TRIM_AT + 9 && dropped === rows.length - L.KEEP) {
      ok('trimming keeps the newest and says how many it dropped');
    } else bad(`trim left ${kept.length} ending at ${kept.length && kept[kept.length - 1].waited}, dropped ${dropped}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    /* The failure this whole design turns on: a wait longer than the gap between two reads has its start in one piece of
       log and its end in another. Pairing that only lived inside one read dropped every one of them, which meant it
       dropped exactly the waits worth recording and kept the short ones. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat7-'));
    const log = path.join(root, 'Claude VSCode.log');
    const dir = path.join(root, 'rec');
    /* `now` has to sit near the log's own clock, or the pending request is older than the ceiling and gets written off
       as one that never arrived - which is the other new behaviour, not this one. */
    const t0 = new Date(2026, 8, 29, 21, 0, 5).getTime();
    fs.writeFileSync(log, at('0:00.000', clicked) + '\n');
    const first = L.sample({ log, dir, state: {}, version: 'v1', now: t0, pid: 808, thresholdMs: 10000 });
    fs.appendFileSync(log, at('1:30.000', up) + '\n');
    const second = L.sample({
      log, dir, state: first.state, version: 'v1', now: t0 + 95000, pid: 808, thresholdMs: 10000,
    });
    if (!first.added.length && first.state.pending.asked
        && second.added.length === 1 && second.added[0].waited === 90000) {
      ok('a wait split across two reads is still paired, and measures 90s');
    } else bad(`split across reads gave ${first.added.length} then ${JSON.stringify(second.added)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    /* Clicking again long after the first attempt never opened: the abandoned one has to be recorded, and the new one
       timed from the new click rather than the old. Without this the total someone actually sat through is nowhere. */
    const waits = one([at('0:00.000', clicked), at('1:30.000', clicked), at('1:40.000', up)].join('\n'));
    const gone = waits.find((w) => w.what === 'abandoned');
    const got = waits.find((w) => w.what === 'panel');
    if (gone && gone.waited === 90000 && got && got.waited === 10000) {
      ok('a panel given up on is recorded at 90s, and the retry at 10s from its own click');
    } else bad(`retry after abandoning gave ${JSON.stringify(waits)}`);
  }
  {
    /* Two panels opened one after the other is not an abandonment, and must not be reported as one. */
    const waits = one([at('0:00.000', clicked), at('0:00.400', clicked), at('0:05.000', up)].join('\n'));
    if (!waits.some((w) => w.what === 'abandoned')) ok('two clicks in quick succession are not called an abandonment');
    else bad(`a quick second click was reported as abandoned: ${JSON.stringify(waits)}`);
  }
  {
    /* A panel that never opens at all: the ceiling is what decides it, and it leaves a record rather than silence. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat8-'));
    const log = path.join(root, 'Claude VSCode.log');
    const dir = path.join(root, 'rec');
    const t0 = new Date(2026, 8, 29, 21, 0, 0).getTime();
    fs.writeFileSync(log, at('0:00.000', clicked) + '\n');
    const first = L.sample({ log, dir, state: {}, version: 'v1', now: t0, pid: 909, thresholdMs: 10000 });
    fs.appendFileSync(log, at('0:30.000', 'AuthManager initialized') + '\n');
    const late = L.sample({
      log, dir, state: first.state, version: 'v1', now: t0 + L.CEILING_MS + 1000, pid: 909, thresholdMs: 10000,
    });
    const gone = late.added.find((w) => w.what === 'abandoned');
    if (gone && gone.open === true && !late.state.pending.asked) {
      ok('a panel that never opens is written off at the ceiling, marked as still open');
    } else bad(`a never-opening panel gave ${JSON.stringify(late.added)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    /* A read that returns short must not turn the rest of an unsafely allocated buffer into records. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat9-'));
    const log = path.join(root, 'Claude VSCode.log');
    const dir = path.join(root, 'rec');
    fs.writeFileSync(log, [at('0:00.000', clicked), at('0:30.000', up)].join('\n') + '\n');
    const r = L.sample({ log, dir, state: {}, version: 'v1', pid: 1010, thresholdMs: 10000 });
    const junk = L.readRecords(L.recordFile(dir, 1010)).filter((x) => x.what !== 'panel' && x.what !== 'tally');
    if (r.added.length === 1 && !junk.length) ok('nothing but real records reaches the file');
    else bad(`the file also holds ${JSON.stringify(junk)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    const rows = L.summarise([
      { what: 'panel', trigger: 'click', version: 'a', waited: 1000 },
      { what: 'panel', trigger: 'click', version: 'a', waited: 3000 },
      { what: 'panel', trigger: 'click', version: 'b', waited: 90000 },
    ]);
    const worst = rows[0];
    if (rows.length === 2 && worst.version === 'b' && worst.n === 1 && rows[1].n === 2) {
      ok('versions are summarised apart, worst first, which is what shows a regression');
    } else bad(`summarise gave ${JSON.stringify(rows)}`);
  }
  /* The log's times are local to the extension host, with no zone. Parsed as UTC, a five-second-old click in Los
     Angeles would look seven hours old and count as a panel that never opened. Runs in a zone other than UTC, since
     this machine may be on UTC. */
  {
    const script = `
      const fs = require('fs'), os = require('os'), path = require('path');
      const L = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'openlatency.js'))});
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lattz-'));
      try {
        const now = Date.now(), d = new Date(now - 5000), p = (n, w = 2) => String(n).padStart(w, '0');
        const local = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':'
          + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
        const log = path.join(root, 'Claude VSCode.log');
        fs.writeFileSync(log, local + ' [info] ' + ${JSON.stringify(clicked)} + '\\n');
        const r = L.sample({ log, dir: path.join(root, 'rec'), state: {}, version: 'v', now, pid: 1, thresholdMs: 10000 });
        process.stdout.write(JSON.stringify({ added: r.added, waiting: !!(r.state.pending && r.state.pending.asked),
          parsed: L.lines(local + ' [info] x')[0].ms, want: d.getTime(), offset: d.getTimezoneOffset() }));
      } finally { fs.rmSync(root, { recursive: true, force: true }); }`;
    let z;
    try { z = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: Object.assign({}, process.env, { TZ: 'America/Los_Angeles' }) })); }
    catch (e) { z = { error: e.message }; }
    if (z.error) bad('reading the log in another time zone failed: ' + z.error);
    else if (!z.offset) note('no time zone data here to run in America/Los_Angeles, so the local reading was not tried away from UTC');
    else if (z.parsed === z.want && !z.added.length && z.waiting) ok('the log\'s times are read as local time, so a click five seconds ago is still waiting rather than hours old');
    else bad(`in America/Los_Angeles a click 5s old read as ${z.parsed} (want ${z.want}) and gave ${JSON.stringify(z.added)}`);
  }
  /* Each window has its own log and a reload starts a new one; a panel coming up in another window's log answers a
     different request. */
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat10-'));
    const one = path.join(root, 'exthost1', 'Claude VSCode.log'), two = path.join(root, 'exthost2', 'Claude VSCode.log');
    fs.mkdirSync(path.dirname(one)); fs.mkdirSync(path.dirname(two));
    const t0 = new Date(2026, 8, 29, 21, 0, 5).getTime();
    fs.writeFileSync(one, at('0:00.000', clicked) + '\n');
    fs.writeFileSync(two, at('0:20.000', up) + '\n');
    const first = L.sample({ log: one, dir: path.join(root, 'rec'), state: {}, version: 'v1', now: t0, pid: 1111, thresholdMs: 10000 });
    const second = L.sample({ log: two, dir: path.join(root, 'rec'), state: first.state, version: 'v1', now: t0 + 20000, pid: 1111, thresholdMs: 10000 });
    if (first.state.pending.asked && !second.added.length && !second.state.pending.asked) {
      ok('a request still open in one window\'s log is dropped rather than paired with a panel in another log');
    } else bad(`a request carried into another log gave ${JSON.stringify(second.added)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    /* A request replaced twenty minutes later is not a twenty-minute wait: past the ceiling it counts as a window left
       alone, as for a panel that comes up that late. */
    const line = (clock, msg) => `2026-09-29 21:${clock} [info] ${msg}`;
    const waits = one([line('00:00.000', clicked), line('20:00.000', clicked), line('20:05.000', up)].join('\n'));
    if (!waits.some((w) => w.what === 'abandoned') && waits.some((w) => w.what === 'panel' && w.waited === 5000)) {
      ok('a request replaced by another past the ceiling is a window left alone, not a twenty-minute abandonment');
    } else bad(`a request replaced twenty minutes later gave ${JSON.stringify(waits)}`);
  }
  {
    /* The host's own silence can start in one read and end in the next, like any other wait. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat11-'));
    const log = path.join(root, 'Claude VSCode.log'), dir = path.join(root, 'rec');
    const t0 = new Date(2026, 8, 29, 21, 0, 1).getTime();
    fs.writeFileSync(log, at('0:00.000', 'AuthManager initialized') + '\n');
    const first = L.sample({ log, dir, state: {}, version: 'v1', now: t0, pid: 1212, thresholdMs: 1000 });
    fs.appendFileSync(log, at('0:05.000', 'Something else entirely') + '\n');
    const second = L.sample({ log, dir, state: first.state, version: 'v1', now: t0 + 5000, pid: 1212, thresholdMs: 1000 });
    if (second.added.length === 1 && second.added[0].what === 'host' && second.added[0].waited === 5000) {
      ok('a silence of the host\'s that spans two reads is measured, from the last line of the first');
    } else bad(`a silence across two reads gave ${JSON.stringify(second.added)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    /* The last line may be mid-write when read; taken as is it would be classified on half its text and the rest would
       not parse as a line. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat12-'));
    const log = path.join(root, 'Claude VSCode.log'), dir = path.join(root, 'rec');
    const t0 = new Date(2026, 8, 29, 21, 0, 31).getTime();
    const head = at('0:00.000', clicked) + '\n', tail = at('0:30.000', up) + '\n';
    fs.writeFileSync(log, head + tail.slice(0, 70));
    const first = L.sample({ log, dir, state: {}, version: 'v1', now: t0, pid: 1313, thresholdMs: 10000 });
    fs.appendFileSync(log, tail.slice(70));
    const second = L.sample({ log, dir, state: first.state, version: 'v1', now: t0, pid: 1313, thresholdMs: 10000 });
    if (first.state.size === Buffer.byteLength(head) && second.added.length === 1 && second.added[0].waited === 30000) {
      ok('a line still being written is left for the next read, and pairs once it is whole');
    } else bad(`a half-written line: read to ${first.state.size} of ${Buffer.byteLength(head)}, then ${JSON.stringify(second.added)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    /* At its size limit the editor moves the log to `.1.log` and starts a new one. Lines written to the old log since
       the last read are taken from there first, then the new log from its start, whether it is still shorter than the
       old offset or already past it. */
    const rotated = (grown) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat13-'));
      const log = path.join(root, 'Claude VSCode.log'), dir = path.join(root, 'rec');
      const t0 = new Date(2026, 8, 29, 21, 0, 1).getTime();
      fs.writeFileSync(log, at('0:00.000', clicked) + '\n');
      const first = L.sample({ log, dir, state: {}, version: 'v1', now: t0, pid: 1414, thresholdMs: 10000 });
      fs.appendFileSync(log, at('0:30.000', up) + '\n');
      fs.renameSync(log, path.join(root, 'Claude VSCode.1.log'));
      const fresh = (at('0:40.000', 'a new log begins') + '\n').repeat(grown ? 20 : 1);
      fs.writeFileSync(log, fresh);
      const second = L.sample({ log, dir, state: first.state, version: 'v1', now: t0 + 40000, pid: 1414, thresholdMs: 10000 });
      fs.rmSync(root, { recursive: true, force: true });
      return second.added.some((w) => w.what === 'panel' && w.waited === 30000) && second.state.size === Buffer.byteLength(fresh);
    };
    if (rotated(false) && rotated(true)) ok('a log moved aside at its size limit is finished before the new one is read from its start');
    else bad(`after the log was moved aside: new log shorter ${rotated(false)}, longer ${rotated(true)}`);
  }
}

/* ── 13. one switch per addition, and each one wired at both ends ──
   A switch is three things that have to agree: a setting a person can see, a property written into the live stylesheet,
   and a place in the injected script that reads it and skips the work. Any one of them missing leaves a switch that
   looks real and does nothing - the failure this section exists to catch, since nothing else would. */
console.log('\none switch per addition, wired at both ends');
{
  const webview = require('../src/webview');
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const settings = manifest.contributes.configuration.properties;
  const script = fs.readdirSync(path.join(root, 'src', 'page'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(root, 'src', 'page', f), 'utf8')).join('\n');

  const noSetting = webview.SWITCHES.filter((k) => !settings['claudeCodePlus.show.' + k]);
  if (!noSetting.length) ok(`all ${webview.SWITCHES.length} switches have a setting a person can find`);
  else bad(`no setting for ${noSetting.join(', ')}`);

  const onByDefault = webview.SWITCHES.every((k) => settings['claudeCodePlus.show.' + k].default === true);
  if (onByDefault) ok('every switch defaults to on, so an upgrade turns nothing off');
  else bad('a switch does not default to on');

  const unread = webview.SWITCHES.filter((k) => !script.includes(`isOff('${k}')`));
  if (!unread.length) ok('every switch is read by the injected script, so none is decoration');
  else bad(`nothing reads ${unread.join(', ')}`);

  /* Off has to be the thing that is written, so a build that never heard of a switch treats it as on. */
  const allOn = webview.liveCss({ enabled: true });
  const someOff = webview.liveCss({ enabled: true, off: ['cost', 'chime'] });
  if (!allOn.includes('--cce-off') && someOff.includes('--cce-off-cost:1')
      && someOff.includes('--cce-off-chime:1')) {
    ok('defaults write nothing, and only what is off appears in the stylesheet');
  } else bad(`all on wrote ${JSON.stringify(allOn.slice(0, 80))}`);

  /* Several windows write this one file, so the same settings have to produce the same bytes whatever order they arrive in. */
  const a = webview.liveCss({ enabled: true, off: ['chime', 'cost', 'toc'] });
  const b = webview.liveCss({ enabled: true, off: ['toc', 'chime', 'cost'] });
  if (a === b) ok('the order the switches arrive in does not change the bytes written');
  else bad('two orderings of the same switches write different stylesheets');

  /* A name that is not a switch must not become a property, or a typo in settings would write arbitrary CSS. */
  const junk = webview.liveCss({ enabled: true, off: ['cost', 'nonsense; }*{display:none'] });
  if (junk.includes('--cce-off-cost:1') && !junk.includes('nonsense')) {
    ok('a name that is not a switch is dropped rather than written into the stylesheet');
  } else bad(`an unknown switch reached the stylesheet: ${JSON.stringify(junk.slice(0, 120))}`);

  /* The rule that draws the annotation carries four switchable things, so it cannot go when one of them does. */
  const noStamps = webview.liveCss({ enabled: true, off: ['timestamps'] });
  if (noStamps.includes('::before') && noStamps.includes('--cce-off-timestamps:1')) {
    ok('switching the time off leaves the rule that also draws the duration and figures');
  } else bad('turning off timestamps dropped the rule the other three need');

  /* The main switch removes only the marks: additions switched off individually stay off, and the agent map keeps its
     scheduled prompts and background sessions. */
  const marksOff = webview.liveCss({ enabled: false, off: ['cost', 'toc'], tasks: [{ id: 't1' }], background: [{ id: 'b1' }] });
  if (marksOff.includes('--cce-off-cost:1;--cce-off-toc:1;') && /--cce-schedule:"/.test(marksOff)
      && /--cce-background:"/.test(marksOff) && !marksOff.includes('::before') && marksOff.includes('--cce-on:0')) {
    ok('with the marks off, the switches, the scheduled prompts and the background sessions are still written');
  } else bad(`with the marks off the stylesheet was ${JSON.stringify(marksOff)}`);
}

/* ── 14. switched off, the work plan costs nothing and keeps nothing ──
   Hiding the view alone would be the worst of both: every turn still pays for the rows in front of the model and the
   reminder at the end of one, with nothing on screen to show for it. So off has to reach the plugin, and the checks here
   are one per hook, because each falls silent for its own reason and any one of them still speaking gives the cost back. */
console.log('\nswitched off, the work plan costs nothing and keeps nothing');
{
  const hooks = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks');
  const session = '42000000-0000-0000-0000-000000000000';

  const stage = (enabled) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-off-'));
    fs.writeFileSync(path.join(dir, session + '.json'),
      JSON.stringify({ title: 'demo', nodes: [{ title: 'a row', state: 'todo' }] }));
    if (enabled !== undefined) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ enabled }));
    /* One turn that just started, against a plan last written an hour ago - the shape the reminder asks for. */
    const now = new Date();
    const lines = [JSON.stringify({ type: 'user', timestamp: now.toISOString(), message: { content: 'go' } })];
    for (let i = 0; i < 10; i++) {
      // Write rather than Read: the reminder counts what a turn CHANGED, so a turn of reads owes the plan nothing.
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } }));
    }
    const transcript = path.join(dir, 't.jsonl');
    fs.writeFileSync(transcript, lines.join('\n') + '\n');
    const back = (now.getTime() - 3600e3) / 1000;
    fs.utimesSync(path.join(dir, session + '.json'), back, back);
    return { dir, transcript };
  };
  const run = (script, dir, payload, env) => (cp.spawnSync('python3', [path.join(hooks, script), dir], {
    encoding: 'utf8', input: JSON.stringify(payload), env: env && Object.assign({}, process.env, env),
  }).stdout || '').trim();

  /* Two changes in one batch, which is enough for the reminder at the start of the work to say something. */
  const working = { session_id: session, prompt_id: 'p-switch', hook_event_name: 'PostToolBatch',
    tool_calls: [{ tool_name: 'Edit', tool_input: {} }, { tool_name: 'Write', tool_input: {} }] };
  for (const [what, enabled] of [['on by default', undefined], ['on', true]]) {
    const t = stage(enabled);
    const injected = run('inject-work-plan.py', t.dir,
      { session_id: session, prompt_id: 'p-switch', hook_event_name: 'UserPromptSubmit' });
    const nudged = run('nudge-work-plan.py', t.dir,
      { session_id: session, transcript_path: t.transcript, hook_event_name: 'Stop' });
    const reminded = run('remind-work-plan.py', t.dir, working);
    if (injected.includes('a row') && nudged.includes('neither read nor updated') && reminded.includes('no row of the work plan is `doing`')) {
      ok(`${what}: the rows arrive, and both reminders speak`);
    } else bad(`${what}: injected ${injected.length} bytes, nudge ${nudged.length} bytes, start-of-work ${reminded.length} bytes`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    const t = stage(false);
    const injected = run('inject-work-plan.py', t.dir,
      { session_id: session, prompt_id: 'p-switch', hook_event_name: 'UserPromptSubmit' });
    if (!injected) ok('off: nothing is put in front of the model, which is where the tokens went');
    else bad(`off: still injected ${injected.length} bytes`);

    const nudged = run('nudge-work-plan.py', t.dir,
      { session_id: session, transcript_path: t.transcript, hook_event_name: 'Stop' });
    if (!nudged) ok('off: the end of a turn says nothing');
    else bad(`off: still nudged ${JSON.stringify(nudged.slice(0, 80))}`);

    /* Off leaves no mark of the turn, and the reminder at the start of the work is silent even where a mark is left over
       from before the switch, since it checks for itself. */
    const left = fs.existsSync(path.join(t.dir, session + '.turn'));
    fs.writeFileSync(path.join(t.dir, session + '.turn'),
      JSON.stringify({ prompt: 'p-switch', began: Date.now() / 1000, changes: 5, reminded: false }));
    const reminded = run('remind-work-plan.py', t.dir, working);
    if (!left && !reminded) ok('off: no mark of the turn is left, and the start of the work says nothing');
    else bad(`off: mark left ${left}, start-of-work said ${JSON.stringify(reminded.slice(0, 80))}`);

    /* The description of the skill stays in context while the plugin is loaded, so an agent can decide to keep a plan on
       its own. This is the only thing left that can stop one being kept where nobody can see it. */
    const denied = run('guard-work-plan.py', t.dir, {
      tool_name: 'Write', hook_event_name: 'PreToolUse',
      tool_input: { file_path: path.join(t.dir, session + '.json'), content: '{}' },
    });
    let decision = '';
    try { decision = JSON.parse(denied).hookSpecificOutput.permissionDecision; } catch (_) {}
    if (decision === 'deny' && denied.includes('switched off')) ok('off: a write to a plan is refused, and says why');
    else bad(`off: the guard said ${JSON.stringify(denied.slice(0, 80))}`);

    /* A turn that ends with rows still `doing` is asked once to move them on; the same rows again, or a Stop that
       follows one that kept the turn going, say nothing. */
    {
      const d = stage(true);
      const planPath = path.join(d.dir, session + '.json');
      const writePlan = (nodes) => fs.writeFileSync(planPath, JSON.stringify({ nodes }));
      const stop = (extra) => run('nudge-work-plan.py', d.dir,
        Object.assign({ session_id: session, transcript_path: d.transcript, hook_event_name: 'Stop' }, extra || {}));
      const text = (out) => { try { return JSON.parse(out).hookSpecificOutput.additionalContext; } catch (_) { return ''; } };
      writePlan([{ title: 'ship', state: 'todo', children: [{ title: 'build it', state: 'doing', since: '2026-11-01T00:00:00Z' }] }]);
      const back = (Date.now() - 3600e3) / 1000;
      fs.utimesSync(planPath, back, back);
      const first = text(stop()), again = text(stop());
      writePlan([{ title: 'ship', state: 'doing', since: '2026-11-02T00:00:00Z' }]);
      const looped = text(stop({ stop_hook_active: true }));
      writePlan([{ title: 'ship', state: 'done' }]);
      const none = text(stop());
      if (first.includes('1 row still `doing`: 1.1. build it') && first.includes('plan-row.py') && first.includes('neither read nor updated')
        && !again.includes('still `doing`') && !looped.includes('still `doing`') && !none.includes('still `doing`')) {
        ok('the end of a turn asks once to move on the rows it leaves doing, beside the reconcile reminder, and not in a loop');
      } else bad(`settle: first ${JSON.stringify(first.slice(0, 160))}, again ${JSON.stringify(again.slice(0, 80))}, looped ${JSON.stringify(looped.slice(0, 80))}`);
      fs.rmSync(d.dir, { recursive: true, force: true });
    }

    /* A turn whose reply asks the user something gets one reminder, unless the turn wrote a question to a row. */
    {
      const d = stage(true);
      const planPath = path.join(d.dir, session + '.json');
      const writePlan = (nodes) => fs.writeFileSync(planPath, JSON.stringify({ nodes }));
      const stop = (reply, extra, env) => run('nudge-work-plan.py', d.dir, Object.assign({
        session_id: session, transcript_path: d.transcript, hook_event_name: 'Stop', last_assistant_message: reply,
      }, extra || {}), env);
      const reminder = (out) => { try { return JSON.parse(out).hookSpecificOutput.additionalContext; } catch (_) { return ''; } };
      const asks = (out) => reminder(out).includes('may be asking the user something');
      const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '+00:00');
      const question = 'Built and tested.\n\nShip it to both markets now?';
      writePlan([{ title: 'ship', state: 'discussing' }]);
      const first = reminder(stop(question));
      const cases = {
        statement: asks(stop('Built and tested.\n\nNext I will list what you need to decide.')),
        code: asks(stop('Run this:\n\n```\nwhy?\n```')),
        mention: asks(stop('到时把要你定的事一起列出来。')),
        handOver: asks(stop('JIRA 要不要改到 Accepted，还等你一句话。')),
        // What Python on Windows reads from a pipe unless told otherwise.
        codePage: asks(stop('JIRA 要不要改到 Accepted，还等你一句话。', undefined, { PYTHONIOENCODING: 'cp1252' })),
        looped: asks(stop(question, { stop_hook_active: true })),
        noReply: asks(stop(undefined)),
      };
      writePlan([{ title: 'ship', state: 'discussing', waitingOn: 'user', question: 'Ship it now?', asked: stamp(Date.now()) }]);
      cases.recorded = asks(stop(question));
      writePlan([{ title: 'ship', state: 'discussing', waitingOn: 'user', question: 'Ship it now?', asked: stamp(Date.now() - 86400e3) }]);
      cases.earlier = asks(stop(question));
      const want = { statement: false, code: false, mention: false, handOver: true, codePage: true, looped: false, noReply: false,
        recorded: false, earlier: true };
      const wrong = Object.keys(want).filter((k) => cases[k] !== want[k]);
      if (first.includes('may be asking the user') && first.includes('plan-row.py') && !wrong.length) {
        ok('a reply that ends by asking the user, in a turn that recorded no question, is reminded to record it');
      } else bad(`unrecorded question: first ${JSON.stringify(first.slice(0, 120))}, wrong for ${wrong.join(', ')}`);
      fs.rmSync(d.dir, { recursive: true, force: true });
    }

    /* Switched on, a direct write gets the same limits as the row command: one question to a row, and a description
       the view can show whole. */
    const on = stage(true);
    const write = (nodes) => run('guard-work-plan.py', on.dir, {
      tool_name: 'Write', hook_event_name: 'PreToolUse',
      tool_input: { file_path: path.join(on.dir, session + '.json'), content: JSON.stringify({ nodes }) },
    });
    const two = write([{ title: 'ask', state: 'waiting', waitingOn: 'user', question: 'Ship it? Tag it?' }]);
    const one = write([{ title: 'ask', state: 'waiting', waitingOn: 'user', question: 'Ship it now?' }]);
    const long = write([{ title: 'long', state: 'todo', detail: 'x'.repeat(901) }]);
    const says = (out, what) => { try { const o = JSON.parse(out).hookSpecificOutput; return o.permissionDecision === 'deny' && o.permissionDecisionReason.includes(what); } catch (_) { return false; } };
    if (says(two, 'Each question needs a row of its own') && says(two, '2 questions in one') && !one && says(long, 'limited to 12 lines')
      && !says(long, 'needs a row of its own')) {
      ok('a direct write is refused for a row that asks several questions, as for an over-long description, and each says why');
    } else bad(`guard: two ${JSON.stringify(two.slice(0, 120))}, one ${JSON.stringify(one)}, long ${JSON.stringify(long.slice(0, 120))}`);
    fs.rmSync(on.dir, { recursive: true, force: true });

    /* A write somewhere else is none of this plugin's business, switched off or on. */
    const other = run('guard-work-plan.py', t.dir, {
      tool_name: 'Write', hook_event_name: 'PreToolUse',
      tool_input: { file_path: path.join(t.dir, 'notes.txt'), content: 'hello' },
    });
    if (!other) ok('off: a write to anything else is left alone');
    else bad(`off: the guard interfered with an unrelated write: ${JSON.stringify(other.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    /* The setting has to reach the plugin. The views are Agent Plus's; with the setting off the source gives no plan
       path, so they show no plan either. */
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const setting = manifest.contributes.configuration.properties['claudeCodePlus.workPlan'];
    const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    if (setting && setting.default === true && /enabled: WORK_PLAN_SETTING,/.test(ext)
      && /enabled: \(\) => cfg\(\)\.get\(WORK_PLAN_SETTING, true\) !== false,/.test(ext)) {
      ok('the hooks and the source read the same work plan switch, on by default');
    } else bad(`setting ${JSON.stringify(setting && setting.default)}, or extension.js reads another switch`);
  }
}

/* ── 16. one list of states, in three places ──
   The view draws a state, the plugin's scripts write and read it, and the skill tells the model what each one means.
   The three cannot import from each other - JavaScript, Python and prose - so this is what holds them together. A state
   one of them does not know is drawn as `todo`, refused by the row command, or never explained, and none of those says
   anything when it happens. */
console.log('\none list of states, in three places');
{
  const root = path.join(__dirname, '..');
  const plan = require('../src/workplan');
  const py = fs.readFileSync(path.join(root, 'claude-plugin', 'agent-work-plan', 'hooks', 'plan_path.py'), 'utf8');
  const skill = fs.readFileSync(path.join(root, 'claude-plugin', 'agent-work-plan', 'skills', 'maintain', 'SKILL.md'), 'utf8');
  const tuple = /^STATES = \(([^)]*)\)/m.exec(py);
  const inPython = tuple ? (tuple[1].match(/"([a-z]+)"/g) || []).map((s) => s.slice(1, -1)) : [];
  /* The keywords in the skill's table headed by `header`: its rows run from that header to the first line that is not
     part of a table. */
  const tableOf = (header) => {
    const out = [];
    let inside = false;
    for (const line of skill.split('\n')) {
      if (new RegExp('^\\| `' + header + '` \\|').test(line)) { inside = true; continue; }
      if (!inside) continue;
      if (!line.startsWith('|')) break;
      const m = /^\| `([a-z]+)` \|/.exec(line);
      if (m && !out.includes(m[1])) out.push(m[1]);
    }
    return out;
  };
  const inSkill = tableOf('state');
  const want = plan.STATES.join();
  if (inPython.join() === want) ok(`the plugin's scripts and the view list the same ${plan.STATES.length} states, in one order`);
  else bad(`the view lists ${want}, plan_path.py ${inPython.join()}`);
  if (inSkill.slice().sort().join() === plan.STATES.slice().sort().join()) ok('the skill explains every one of them, and no other');
  else bad(`the skill's table has ${inSkill.join()}, the view ${want}`);
  /* The parties a row can wait on are kept in the same three places: the row command refuses a value the view does not
     know, and the list across conversations is built from it. */
  const whoTuple = /^WAITING_ON = \(([^)]*)\)/m.exec(py);
  const whoPython = whoTuple ? (whoTuple[1].match(/"([a-z]+)"/g) || []).map((s) => s.slice(1, -1)) : [];
  const whoSkill = tableOf('waitingOn');
  if (whoPython.join() === plan.WAITING_ON.join() && whoSkill.join() === plan.WAITING_ON.join()) {
    ok(`the plugin's scripts, the view and the skill list the same ${plan.WAITING_ON.length} parties a row can wait on`);
  } else bad(`waiting on: view ${plan.WAITING_ON.join()}, plan_path.py ${whoPython.join()}, skill ${whoSkill.join()}`);
  const qPython = /^MAX_QUESTION_CHARS = (\d+)/m.exec(py);
  if (qPython && Number(qPython[1]) === plan.MAX_QUESTION_CHARS && skill.includes('at most ' + plan.MAX_QUESTION_CHARS + ' characters')) {
    ok(`a question is held to ${plan.MAX_QUESTION_CHARS} characters by the row command, the view and the skill alike`);
  } else bad(`question limit: view ${plan.MAX_QUESTION_CHARS}, plan_path.py ${qPython && qPython[1]}`);
}

/* ── 17. what the injected block says about the work in hand ──
   The block is the one thing said before the work rather than after it, so what it says about `doing` is checked here
   word for word: whether anything is `doing` changes the sentence, how long a row has been `doing` or `waiting` is on the
   row, and the command that changes a row is given with a path that exists. */
console.log('\nwhat the injected block says about the work in hand');
{
  const hooks = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks');
  const session = '43000000-0000-0000-0000-000000000000';
  const inject = (nodes, extra = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-inj-'));
    fs.writeFileSync(path.join(dir, session + '.json'), JSON.stringify({ nodes }));
    const r = cp.spawnSync('python3', [path.join(hooks, 'inject-work-plan.py'), dir], {
      encoding: 'utf8',
      input: JSON.stringify(Object.assign({ session_id: session, hook_event_name: 'UserPromptSubmit' }, extra)),
    });
    let text = '', mark = null;
    try { text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) {}
    try { mark = JSON.parse(fs.readFileSync(path.join(dir, session + '.turn'), 'utf8')); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
    return { text, mark };
  };
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  const rowOf = (text, title) => text.split('\n').find((l) => l.includes('. ' + title + '   [')) || '';

  {
    const idle = inject([{ title: 'a', state: 'todo' }]).text;
    const busy = inject([{ title: 'a', state: 'doing' }]).text;
    if (idle.includes('Nothing is `doing` right now.') && !idle.includes('earlier turn')) ok('with nothing doing, it says so');
    else bad(`with nothing doing it said ${JSON.stringify(idle.slice(0, 200))}`);
    if (busy.includes('left that way by an earlier turn') && !busy.includes('Nothing is `doing`')) {
      ok('with a row doing, it says that row was left by an earlier turn');
    } else bad(`with a row doing it said ${JSON.stringify(busy.slice(0, 200))}`);
  }
  {
    const text = inject([
      { title: 'working', state: 'doing', since: ago(2 * 3600 + 60) },
      { title: 'held', state: 'waiting', since: ago(3 * 86400 + 60), note: 'on the user' },
      { title: 'untimed', state: 'doing' },
      { title: 'queued', state: 'todo', since: ago(5 * 3600) },
      { title: 'colonless', state: 'doing', since: ago(5 * 3600 + 60).replace(/\.\d+Z$/, '+0000') },
      { title: 'asked', state: 'waiting', since: ago(3600 + 60), waitingOn: 'user', question: 'Ship 2.0 now?' },
      { title: 'built', state: 'waiting', since: ago(120), waitingOn: 'build' },
      { title: 'decide', state: 'discussing', waitingOn: 'user', question: 'A or B?' },
    ]).text;
    const titles = ['working', 'held', 'untimed', 'queued', 'colonless', 'asked', 'built', 'decide'];
    const got = titles.map((t) => rowOf(text, t).replace(/^.*\[/, '['));
    const want = ['[doing for 2h]', '[waiting on ? for 3d · on the user]', '[doing]', '[todo]', '[doing for 5h]',
      '[waiting on user for 1h · asks: Ship 2.0 now?]', '[waiting on build for 2m]', '[discussing on user · asks: A or B?]'];
    if (got.join('|') === want.join('|')) {
      ok('a row doing or waiting says for how long, and a held row who it waits on and what it asks the user');
    } else bad(`the rows came out ${JSON.stringify(got)}`);
    if (/^1 waiting row does not say who it waits for \(shown `on \?`\)/m.test(text)) {
      ok('a waiting row from before the field is counted, so the conversation gives it one');
    } else bad(`no line about the waiting row without a party: ${JSON.stringify(text.slice(0, 900))}`);
  }
  {
    const text = inject([{ title: 'a', state: 'todo' }]).text;
    const m = new RegExp(`To change a row: python3 ${ARG} ${ARG} set <row> <state>`).exec(text);
    if (m && fs.existsSync(unquote(m[1])) && path.basename(unquote(m[1])) === 'plan-row.py' && unquote(m[2]).endsWith(session + '.json')) {
      ok('the command that changes a row is given with a path that exists, against this plan');
    } else bad(`the command line is ${JSON.stringify(m && m[0])}`);
  }
  {
    const before = Date.now() / 1000;
    const marked = inject([{ title: 'a', state: 'todo' }], { prompt_id: 'p-17' }).mark;
    const unnamed = inject([{ title: 'a', state: 'todo' }]).mark;
    const allClosed = inject([{ title: 'a', state: 'done' }], { prompt_id: 'p-17b' });
    if (marked && marked.prompt === 'p-17' && marked.began >= before - 1 && marked.reminded === false && marked.changes === 0) {
      ok('a turn leaves a mark naming its prompt and when it began');
    } else bad(`the mark was ${JSON.stringify(marked)}`);
    if (!unnamed) ok('a turn without a prompt id leaves no mark, since nothing could match it');
    else bad(`a turn with no prompt id left ${JSON.stringify(unnamed)}`);
    /* Nothing open means nothing to inject - and new work started in that turn is exactly what the mark is for. */
    if (!allClosed.text && allClosed.mark && allClosed.mark.prompt === 'p-17b') ok('a plan with nothing open injects nothing, and still marks the turn');
    else bad(`with nothing open: injected ${allClosed.text.length} bytes, mark ${JSON.stringify(allClosed.mark)}`);
  }
  {
    /* Cutting newest first and depth first would give the newest row's subtree every line and silently hide the other
       open top-level rows. */
    const kids = Array.from({ length: 60 }, (_, i) => ({ title: 'kid' + i, state: 'todo' }));
    const text = inject([{ title: 'older', state: 'todo' }, { title: 'old', state: 'waiting' },
      { title: 'newest', state: 'doing', children: kids }]).text;
    const drawn = text.split('\n').filter((l) => /^\s*[?o>~=+x] [0-9.]+\. /.test(l)).length;
    if (rowOf(text, 'older') && rowOf(text, 'old') && rowOf(text, 'newest') && drawn === 40
      && /^\.\.\. 23 more open rows in the file$/m.test(text)) {
      ok('every open row at the top is drawn, rows under them are cut to fit, and the block says how many were left out');
    } else bad(`with 60 rows under the newest of three: ${drawn} drawn, top rows ${['older', 'old', 'newest'].map((t) => !!rowOf(text, t))}, `
      + `last line ${JSON.stringify(text.split('\n').pop())}`);
  }
  {
    /* The file is hand-edited, so anything can be where a row's children belong; a walk that trusted it would raise on
       every prompt until the file was fixed. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-inj-'));
    fs.writeFileSync(path.join(dir, session + '.json'), JSON.stringify({ nodes: [
      { title: 'numbered', state: 'todo', children: 5 }, { title: 'keyed', state: 'doing', children: { a: 1 } }] }));
    const r = cp.spawnSync('python3', [path.join(hooks, 'inject-work-plan.py'), dir], {
      encoding: 'utf8', input: JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit' }),
    });
    fs.rmSync(dir, { recursive: true, force: true });
    let text = '';
    try { text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) {}
    if (r.status === 0 && rowOf(text, 'numbered') && rowOf(text, 'keyed')) ok('rows whose children are not a list are drawn, and the hook does not fail');
    else bad(`children that are not a list: status ${r.status}, ${JSON.stringify(((r.stderr || '') + text).slice(-200))}`);
  }
}

/* ── 18. the reminder when a turn starts working ──
   It speaks at most once a turn and only when it is owed, and most of what is tested here is the silence: a reminder
   that fires where nothing was owed teaches the reader to skip it, which costs the one time it is needed. */
console.log('\nthe reminder when a turn starts working');
{
  const hooks = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks');
  const session = '44000000-0000-0000-0000-000000000000';
  const stage = (nodes, limits) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-remind-'));
    const plan = path.join(dir, session + '.json');
    fs.writeFileSync(plan, JSON.stringify({ nodes }));
    const back = Date.now() / 1000 - 3600;
    fs.utimesSync(plan, back, back);
    if (limits) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(limits));
    return { dir, plan };
  };
  const begin = (t, prompt) => cp.spawnSync('python3', [path.join(hooks, 'inject-work-plan.py'), t.dir], {
    encoding: 'utf8', input: JSON.stringify({ session_id: session, prompt_id: prompt, hook_event_name: 'UserPromptSubmit' }),
  });
  const batch = (t, prompt, calls, extra = {}) => (cp.spawnSync('python3', [path.join(hooks, 'remind-work-plan.py'), t.dir], {
    encoding: 'utf8',
    input: JSON.stringify(Object.assign({ session_id: session, prompt_id: prompt, hook_event_name: 'PostToolBatch',
      tool_calls: calls }, extra)),
  }).stdout || '').trim();
  const spoke = (s) => s.includes('no row of the work plan is `doing`');
  const E = { tool_name: 'Edit', tool_input: { file_path: '/elsewhere/a.js' } };
  const R = { tool_name: 'Read', tool_input: { file_path: '/elsewhere/a.js' } };
  const todo = [{ title: 'a', state: 'todo' }];
  const done = (t) => fs.rmSync(t.dir, { recursive: true, force: true });

  {
    const t = stage(todo);
    begin(t, 'p1');
    const said = [batch(t, 'p1', [R]), batch(t, 'p1', [E]), batch(t, 'p1', [E]), batch(t, 'p1', [E])].map(spoke);
    if (said.join() === 'false,false,true,false') ok('silent for two calls, speaks at the third, and only once');
    else bad(`a read, then three changes, spoke ${JSON.stringify(said)}`);
    begin(t, 'p2');
    if (spoke(batch(t, 'p2', [E, E]))) ok('the next turn can be told again, and two changes in one batch are enough');
    else bad('a new turn with two changes in one batch said nothing');
    done(t);
  }
  {
    /* A sub-agent shares the session id, and its work is recorded by the thread that sent it. Its calls must not count
       towards the main thread's turn either, or the main thread would be told on its first change of its own. */
    const t = stage(todo);
    begin(t, 'p1');
    const sub = batch(t, 'p1', [E, E], { agent_id: 'agent-1' });
    const main = batch(t, 'p1', [E]);
    if (!sub && !main) ok('a sub-agent is not told, and what it changed does not count towards the turn');
    else bad(`sub-agent said ${JSON.stringify(sub.slice(0, 60))}, main thread after it ${JSON.stringify(main.slice(0, 60))}`);
    done(t);
  }
  {
    const t = stage(todo);
    begin(t, 'p1');
    if (!batch(t, 'p0', [E, E])) ok('a batch from a turn that left no mark says nothing');
    else bad('a batch whose prompt id matches no mark was spoken to');
    done(t);
  }
  {
    /* Looking into something is work to mark, so a turn that only reads is told like one that edits. */
    const t = stage(todo);
    begin(t, 'p1');
    const said = [batch(t, 'p1', [R]), batch(t, 'p1', [R]), batch(t, 'p1', [R])].map(spoke);
    if (said.join() === 'false,false,true') ok('a turn that only reads is told at its third call');
    else bad(`three reads spoke ${JSON.stringify(said)}`);
    done(t);
  }
  {
    /* Closing the last row and starting on the next writes the plan and still leaves nothing `doing`. */
    const t = stage(todo);
    begin(t, 'p1');
    const now = Date.now() / 1000 + 1;
    fs.utimesSync(t.plan, now, now);
    if (spoke(batch(t, 'p1', [E, E]))) ok('a turn that has written to the plan with nothing `doing` is still told');
    else bad('a turn that had written to the plan, with no row doing, was left alone');
    done(t);
  }
  {
    const t = stage([{ title: 'a', state: 'todo', children: [{ title: 'b', state: 'doing' }] }]);
    begin(t, 'p1');
    if (!batch(t, 'p1', [E, E])) ok('a row doing anywhere in the tree is enough to say nothing');
    else bad('a plan with a nested doing row was still told');
    done(t);
  }
  {
    /* Keeping the plan is not the work the plan is about. */
    const t = stage(todo);
    begin(t, 'p1');
    const keep = { tool_name: 'Bash', tool_input: { command: `python3 fix.py > ${t.plan}` } };
    const kept = batch(t, 'p1', [keep, keep]);
    const after = batch(t, 'p1', [E]);
    if (!kept && !after) ok('calls that only keep the plan neither count nor speak');
    else bad(`keeping the plan said ${JSON.stringify(kept.slice(0, 60))}, one change after it ${JSON.stringify(after.slice(0, 60))}`);
    done(t);
  }
  {
    const t = stage(todo, { nudgeMinChanges: 1 });
    begin(t, 'p1');
    if (spoke(batch(t, 'p1', [E]))) ok('how many changes it waits for is read from the settings file');
    else bad('with the threshold at one, the first change said nothing');
    done(t);
  }
  {
    const t = stage(todo, { remindMinCalls: 5 });
    begin(t, 'p1');
    const four = batch(t, 'p1', [R, R, R, R]);
    const fifth = batch(t, 'p1', [R]);
    if (!four && spoke(fifth)) ok('how many calls it waits for is read from the settings file');
    else bad(`with the threshold at five, four calls said ${JSON.stringify(four.slice(0, 60))} and the fifth ${JSON.stringify(fifth.slice(0, 60))}`);
    done(t);
  }
  {
    const t = stage(todo);
    begin(t, 'p1');
    let said = '';
    try { said = JSON.parse(batch(t, 'p1', [E, E])).hookSpecificOutput.additionalContext; } catch (_) {}
    const m = new RegExp(`\n {2}python3 ${ARG} ${ARG} set <row> doing\n`).exec(said);
    if (m && fs.existsSync(unquote(m[1])) && unquote(m[2]) === t.plan) ok('what it says names the row command with its full path');
    else bad(`it said ${JSON.stringify(said.slice(0, 300))}`);
    done(t);
  }
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-remind-'));
    if (!batch({ dir }, 'p1', [E, E])) ok('a conversation with no plan is not told anything');
    else bad('a conversation with no plan was told to mark a row');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const t = stage([{ title: 'a', state: 'todo', children: 5 }]);
    begin(t, 'p1');
    const r = cp.spawnSync('python3', [path.join(hooks, 'remind-work-plan.py'), t.dir], {
      encoding: 'utf8', input: JSON.stringify({ session_id: session, prompt_id: 'p1', hook_event_name: 'PostToolBatch',
        tool_calls: [E, E] }),
    });
    if (r.status === 0 && spoke(r.stdout)) ok('a row whose children are not a list is walked past, and the reminder still speaks');
    else bad(`children that are not a list: status ${r.status}, ${JSON.stringify(((r.stderr || '') + r.stdout).slice(-200))}`);
    done(t);
  }
}

/* ── 19. the row command ──
   The one script here that writes a plan, so what it must leave alone matters as much as what it changes: every other
   row, every other field, and a correction the user made by hand a moment ago. */
console.log('\nthe row command');
{
  const tool = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks', 'plan-row.py');
  const session = '45000000-0000-0000-0000-000000000000';
  const stage = (body, name = session + '.json') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-row-'));
    const file = path.join(dir, name);
    if (body !== undefined) fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    return { dir, file };
  };
  const row = (t, ...args) => cp.spawnSync('python3', [tool, t.file, ...args], { encoding: 'utf8' });
  const read = (t) => JSON.parse(fs.readFileSync(t.file, 'utf8'));
  const recent = (stamp) => typeof stamp === 'string' && Math.abs(Date.parse(stamp) - Date.now()) < 120000;
  const plan = () => ({
    title: 'demo',
    nodes: [
      { title: 'one', state: 'todo', detail: 'kept as it is', opened: '2026-01-01T00:00:00+00:00' },
      { title: 'two', state: 'todo', handEdited: true, children: [{ title: 'two-a', state: 'todo', note: 'n' }] },
    ],
  });
  const done = (t) => fs.rmSync(t.dir, { recursive: true, force: true });

  {
    const t = stage(plan());
    const r = row(t, 'set', '2.1', 'doing');
    const d = read(t);
    const kid = d.nodes[1].children[0];
    const rest = JSON.stringify([d.title, d.nodes[0], d.nodes[1].handEdited, d.nodes[1].title, kid.note]);
    if (r.status === 0 && r.stdout.trim() === 'row 2.1: todo -> doing' && kid.state === 'doing' && recent(kid.since)) {
      ok('a row is set by its number, with the time it entered the state');
    } else bad(`set 2.1 doing: status ${r.status}, said ${JSON.stringify(r.stdout + r.stderr)}, row ${JSON.stringify(kid)}`);
    if (rest === JSON.stringify(['demo', plan().nodes[0], true, 'two', 'n'])) ok('and every other row and field is left as it was');
    else bad(`other content moved: ${rest}`);
    done(t);
  }
  {
    const t = stage(plan());
    row(t, 'set', '1', 'done');
    const closed = read(t).nodes[0];
    row(t, 'set', '1', 'todo');
    const reopened = read(t).nodes[0];
    if (closed.closed && closed.closed === closed.since && !('closed' in reopened) && reopened.opened === '2026-01-01T00:00:00+00:00') {
      ok('closing a row stamps when, and reopening it takes the stamp away again');
    } else bad(`closed ${JSON.stringify(closed)}, reopened ${JSON.stringify(reopened)}`);
    done(t);
  }
  {
    const t = stage(plan());
    row(t, 'set', '1', 'waiting', '--note', 'on the user', '--waiting-on', 'user', '--question', 'Ship it?');
    const held = read(t).nodes[0];
    row(t, 'set', '1', 'doing', '--note', '');
    const cleared = read(t).nodes[0];
    if (held.note === 'on the user' && !('note' in cleared)) ok('a note is set with the state, and an empty one removes it');
    else bad(`note was ${JSON.stringify(held.note)}, then ${JSON.stringify(cleared.note)}`);
    if (held.waitingOn === 'user' && held.question === 'Ship it?' && !('waitingOn' in cleared) && !('question' in cleared)
      && held.asked && !('asked' in cleared)) {
      ok('who a row waits on and its question are set with the state, and leaving the state takes both away');
    } else bad(`held ${JSON.stringify(held)}, then ${JSON.stringify(cleared)}`);
    done(t);
  }
  {
    /* `asked` is the age of the question, not of the waiting: a new question restarts it, the same one does not. */
    const t = stage({ nodes: [{ title: 'w', state: 'waiting', since: '2026-10-01T00:00:00Z', waitingOn: 'user',
      question: 'Old?', asked: '2026-10-01T00:00:00Z' }] });
    row(t, 'set', '1', '--question', 'Old?', '--note', 'n');
    const same = read(t).nodes[0];
    row(t, 'set', '1', '--question', 'New?');
    const fresh = read(t).nodes[0];
    if (same.asked === '2026-10-01T00:00:00Z' && fresh.question === 'New?' && fresh.asked !== same.asked
      && Date.now() - Date.parse(fresh.asked) < 60e3 && fresh.since === '2026-10-01T00:00:00Z') {
      ok('a new question on a waiting row gets its own time, and the time the row has waited is left alone');
    } else bad(`asked: same ${JSON.stringify(same)}, new ${JSON.stringify(fresh)}`);
    done(t);
  }
  {
    const cases = [
      ['waiting with nobody named', ['set', '1', 'waiting']],
      ['waiting on the user with no question', ['set', '1', 'waiting', '--waiting-on', 'user']],
      ['a party that is not one of the five', ['set', '1', 'waiting', '--waiting-on', 'robots']],
      ['a question for anyone but the user', ['set', '1', 'waiting', '--waiting-on', 'build', '--question', 'x']],
      ['a question past the limit', ['set', '1', 'waiting', '--waiting-on', 'user', '--question', 'q'.repeat(201)]],
      ['a question that asks two things', ['set', '1', 'waiting', '--waiting-on', 'user', '--question', 'Ship it? Tag it too?']],
      ['two questions with full-width marks', ['set', '1', 'waiting', '--waiting-on', 'user', '--question', '发吗？打标签吗？']],
      ['a todo row waiting on someone', ['set', '1', '--waiting-on', 'user', '--question', 'x']],
      ['a discussing row waiting on a build', ['add', 'discussing', 'z', '--waiting-on', 'build']],
    ];
    for (const [what, args] of cases) {
      const t = stage(plan());
      const before = fs.readFileSync(t.file, 'utf8');
      const r = row(t, ...args);
      if (r.status === 1 && r.stderr.trim() && fs.readFileSync(t.file, 'utf8') === before) ok(`refused: ${what}`);
      else bad(`${what}: status ${r.status}, said ${JSON.stringify(r.stdout + r.stderr)}`);
      done(t);
    }
    const t = stage({ nodes: [{ title: 'old', state: 'waiting', note: 'n' }] });
    const r = row(t, 'set', '1', '--note', 'still');
    const d = read(t).nodes[0];
    if (r.status === 0 && d.note === 'still' && !('waitingOn' in d)) {
      ok('a waiting row written before the field can still have its note changed without naming anyone');
    } else bad(`changing an old waiting row: status ${r.status}, ${JSON.stringify(r.stderr)}, row ${JSON.stringify(d)}`);
    const q = row(t, 'set', '1', '--waiting-on', 'user', '--question', 'Line one\n  line two?');
    if (q.status === 0 && read(t).nodes[0].question === 'Line one line two?') ok('a question is kept to one line');
    else bad(`question with a newline: ${JSON.stringify(q.stderr)}, ${JSON.stringify(read(t).nodes[0])}`);
    const onSession = row(t, 'set', '1', '--waiting-on', 'session', '--question', '');
    const onSomeone = row(t, 'set', '1', '--waiting-on', 'someone');
    if (onSession.status === 0 && /claude --bg.*set the row to doing/.test(onSession.stdout)
        && onSomeone.status === 0 && !/claude --bg/.test(onSomeone.stdout)) {
      ok('only waiting on a session prints the hint about background agents');
    } else bad(`waiting on a session said ${JSON.stringify(onSession.stdout)}, on someone ${JSON.stringify(onSomeone.stdout)}`);
    done(t);
  }
  {
    const t = stage(plan());
    const top = row(t, 'add', 'doing', '修一下标题');
    const under = row(t, 'add', 'todo', 'two-b', '--under', '2');
    const d = read(t);
    const added = d.nodes[2];
    if (top.stdout.trim() === 'row 3 added: doing' && added.title === '修一下标题' && added.state === 'doing'
      && recent(added.opened) && added.opened === added.since && Array.isArray(added.children)
      && under.stdout.trim() === 'row 2.2 added: todo' && d.nodes[1].children[1].title === 'two-b') {
      ok('a row is added at the end or under another, and says the number it got');
    } else bad(`added ${JSON.stringify(top.stdout + top.stderr)} and ${JSON.stringify(under.stdout + under.stderr)}`);
    if (fs.readFileSync(t.file, 'utf8').includes('修一下标题')) ok('a title in the conversation\'s own language is written as it is, not escaped');
    else bad('a non-ASCII title was written as escapes');
    done(t);
  }
  {
    const t = stage(undefined);
    const r = row(t, 'add', 'doing', 'first');
    if (r.status === 0 && read(t).nodes.length === 1) ok('adding a row to a plan that does not exist yet starts one');
    else bad(`adding to no plan: status ${r.status}, ${JSON.stringify(r.stderr)}`);
    done(t);
  }
  {
    /* Every refusal leaves the file exactly as it was. */
    const refusals = [
      ['a row that is not there', () => stage(plan()), (t) => row(t, 'set', '9', 'doing'), 1],
      ['a state that is not one of the seven', () => stage(plan()), (t) => row(t, 'set', '1', 'started'), 2],
      ['a file that does not parse', () => stage('{"nodes": [}'), (t) => row(t, 'set', '1', 'doing'), 1],
      ['a file that is not a plan', () => stage(plan(), 'notes.json'), (t) => row(t, 'set', '1', 'doing'), 1],
      ['plans switched off', () => {
        const t = stage(plan());
        fs.writeFileSync(path.join(t.dir, 'config.json'), '{"enabled": false}');
        return t;
      }, (t) => row(t, 'set', '1', 'doing'), 1],
    ];
    for (const [what, make, act, code] of refusals) {
      const t = make();
      const before = fs.readFileSync(t.file, 'utf8');
      const r = act(t);
      const after = fs.readFileSync(t.file, 'utf8');
      const strays = fs.readdirSync(t.dir).filter((n) => n.endsWith('.tmp'));
      if (r.status === code && before === after && !strays.length) ok(`refused, and nothing touched: ${what}`);
      else bad(`${what}: status ${r.status}, file changed ${before !== after}, left ${JSON.stringify(strays)}`);
      done(t);
    }
    const t = stage(undefined);
    const r = row(t, 'set', '1', 'doing');
    if (r.status === 1 && !fs.existsSync(t.file)) ok('setting a row in a plan that does not exist creates nothing');
    else bad(`set on no plan: status ${r.status}, file made ${fs.existsSync(t.file)}`);
    done(t);
  }

  /* The description is what the hook before a compaction asks to be brought up to date, one command per row, so it
     has to be settable without rewriting the file - and without restarting the clock of the state the row is in. */
  {
    const t = stage(plan());
    const before = read(t).nodes[0];
    const r = row(t, 'set', '1', '--detail', 'next: run the build');
    const d = read(t).nodes[0];
    if (r.status === 0 && d.detail === 'next: run the build' && d.state === before.state && !('since' in d)) {
      ok('a description is set on its own, leaving the state and its time as they were');
    } else bad(`set 1 --detail: status ${r.status}, said ${JSON.stringify(r.stdout + r.stderr)}, row ${JSON.stringify(d)}`);
    row(t, 'set', '1', 'doing');
    const since = read(t).nodes[0].since;
    row(t, 'set', '1', 'doing', '--detail', 'later step');
    const again = read(t).nodes[0];
    if (again.since === since && again.detail === 'later step') ok('naming the state a row is already in does not restart its clock');
    else bad(`same state again moved since from ${since} to ${again.since}`);
    row(t, 'set', '1', '--detail', '');
    if (!('detail' in read(t).nodes[0])) ok('an empty description removes it');
    else bad('an empty --detail left a description behind');
    done(t);
  }
  {
    const t = stage(plan());
    const before = fs.readFileSync(t.file, 'utf8');
    const long = row(t, 'set', '1', '--detail', 'x'.repeat(901));
    const tall = row(t, 'set', '1', '--detail', Array(14).fill('line').join('\n'));
    const none = row(t, 'set', '1');
    if ([long, tall, none].every((r) => r.status === 1) && fs.readFileSync(t.file, 'utf8') === before) {
      ok('a description past the limit, or a set with nothing to change, is refused and touches nothing');
    } else bad(`refusals: ${[long, tall, none].map((r) => r.status).join(',')}, file changed ${fs.readFileSync(t.file, 'utf8') !== before}`);
    done(t);
  }
  {
    /* Without a lock, two runs that each read, change and rewrite the whole file lose one change; measured with two
       runs, 14 times in 20. */
    const t = stage(plan());
    const n = 16;
    const r = cp.spawnSync('python3', ['-c', [
      'import subprocess, sys',
      'ps = [subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2], "add", "todo", "r%d" % i]) for i in range(int(sys.argv[3]))]',
      'sys.exit(max(p.wait() for p in ps))',
    ].join('\n'), tool, t.file, String(n)], { encoding: 'utf8' });
    const kept = read(t).nodes.length - plan().nodes.length;
    const strays = fs.readdirSync(t.dir).filter((f) => /\.(lock|tmp)$/.test(f));
    if (r.status === 0 && kept === n && !strays.length) ok(`${n} runs at once each keep their row, and leave no lock or temporary file behind`);
    else bad(`${n} runs at once: status ${r.status}, ${kept} rows kept, left ${JSON.stringify(strays)}`);
    done(t);
  }
  {
    /* A dead run's lock is taken over, at once or when it turns ten seconds old during the wait. A lock kept fresh
       makes the run refuse, and stays where it is. */
    const t = stage(plan());
    const lock = t.file + '.lock';
    fs.mkdirSync(lock);
    const old = Date.now() / 1000 - 60;
    fs.utimesSync(lock, old, old);
    let at = Date.now();
    const stale = row(t, 'set', '1', 'doing');
    const staleMs = Date.now() - at;
    const staleGone = !fs.existsSync(lock);
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
    const nearly = Date.now() / 1000 - 9;
    fs.utimesSync(lock, nearly, nearly);
    at = Date.now();
    const aging = row(t, 'set', '1', 'waiting', '--waiting-on', 'build');
    const agingMs = Date.now() - at;
    const agingGone = !fs.existsSync(lock);
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
    const ahead = Date.now() / 1000 + 60;
    fs.utimesSync(lock, ahead, ahead);
    at = Date.now();
    const held = row(t, 'set', '1', 'done');
    const heldMs = Date.now() - at;
    if (stale.status === 0 && staleGone && staleMs < 1500 && aging.status === 0 && agingGone && agingMs < 4000
      && held.status !== 0 && heldMs >= 10500 && read(t).nodes[0].state === 'waiting' && fs.existsSync(lock)
      && /could not be taken/.test(held.stderr + held.stdout)) {
      ok('a lock left behind is taken over, and one still held after the wait stops the write');
    } else bad(`left-behind lock: status ${stale.status} in ${staleMs} ms, removed ${staleGone}; aging lock: status `
      + `${aging.status} in ${agingMs} ms, removed ${agingGone}; held lock: status ${held.status} in ${heldMs} ms, `
      + `state ${read(t).nodes[0].state}, said ${JSON.stringify(held.stderr + held.stdout)}`);
    fs.rmSync(lock, { recursive: true, force: true });
    done(t);
  }
  {
    /* The first row of a conversation can come before anything has made the plugin's data directory. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-row-'));
    const file = path.join(dir, 'data', session + '.json');
    const r = cp.spawnSync('python3', [tool, file, 'add', 'doing', 'first'], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(file)) ok('the first row, added where the data directory does not exist yet, makes it');
    else bad(`add with no data directory: status ${r.status}, ${JSON.stringify((r.stderr || '').slice(-200))}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 19a. where the hook settings are written ──
   The hooks read config.json from the plugin's data directory, and nothing reports a settings file written anywhere
   else: the hooks just keep their defaults, so every setting the editor offers for them silently does nothing. */
console.log('\nwhere the hook settings are written');
{
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const body = (/function writeHookSettings\(\) \{[\s\S]*?\n  \}\n/.exec(ext) || [''])[0];
  if (/const dir = planDir\(\);/.test(body) && /path\.join\(dir, 'config\.json'\)/.test(body)
      && !/(path\.join|mkdirSync)\(PLAN_DIR\b/.test(body)) {
    ok('config.json is written into the data directory the hooks read, by its full path');
  } else bad('writeHookSettings does not write config.json under planDir(), so the hooks would never see it');
  /* A hook can read either file at any moment, and one written in place is caught half-written. */
  const zone = (/const writeClientZone = \(\) => \{[\s\S]*?\n  \};\n/.exec(ext) || [''])[0];
  if (/writeAtomic\(file, next\)/.test(body) && /writeAtomic\(file, next\)/.test(zone) && !/writeFileSync\(file/.test(body + zone)) {
    ok('config.json and the reader\'s time zone are replaced whole, never written in place where a hook could read half');
  } else bad('config.json or client-time-zone.json is still written in place');
}

/* ── 19b. the hooks around a compaction ──
   One asks for the rows being worked on to be brought up to date as the context nears the compaction line, the other
   points the turn that resumes after it at the plan. Both carry their own checks, against transcripts built for the
   purpose: which marks ask and when, how the window is told, the quiet pattern, a plan switched off. */
console.log('\nthe hooks around a compaction');
{
  const hooks = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks');
  for (const name of ['refresh-work-plan.py', 'resume-work-plan.py']) {
    const r = cp.spawnSync('python3', [path.join(hooks, name), '--selftest'], { encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const passed = (out.match(/^PASS /gm) || []).length;
    if (r.status === 0 && /all checks pass/.test(out)) ok(`${name}: ${passed} checks of its own pass`);
    else bad(`${name}: ${out.split('\n').filter((l) => /^FAIL|Error|Traceback/.test(l)).join(' | ') || out.slice(-400)}`);
  }
}

/* ── 19c. the reader's time zone, told to the model ──
   The panel reports its zone, the extension leaves it in the data directory, and a hook says it on every message and
   after a compaction when it is not this machine's. Each link fails silently - a zone written where the hook does not
   look, a hook left out of hooks.json, a switch the hook does not read - and the model just goes on giving the machine's
   times, which is the complaint this was written for. */
console.log("\nthe reader's time zone, told to the model");
{
  const hooks = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks');
  const hook = path.join(hooks, 'tell-time-zone.py');
  const own = cp.spawnSync('python3', [hook, '--selftest'], { encoding: 'utf8' });
  const said = (own.stdout || '') + (own.stderr || '');
  if (own.status === 0 && /all checks pass/.test(said)) ok(`tell-time-zone.py: ${(said.match(/^PASS /gm) || []).length} checks of its own pass`);
  else bad(`tell-time-zone.py: ${said.split('\n').filter((l) => /^FAIL|Error|Traceback/.test(l)).join(' | ') || said.slice(-400)}`);

  const registered = JSON.parse(fs.readFileSync(path.join(hooks, 'hooks.json'), 'utf8')).hooks;
  const runs = (event, matcher) => (registered[event] || []).some((g) => (matcher === undefined || g.matcher === matcher)
    && (g.hooks || []).some((h) => /\/hooks\/tell-time-zone\.py" "\$\{CLAUDE_PLUGIN_DATA\}"$/.test(h.command)));
  if (runs('UserPromptSubmit') && runs('SessionStart', 'compact')) ok('it runs on every message and after a compaction, handed the data directory');
  else bad('hooks.json does not run tell-time-zone.py on UserPromptSubmit and on SessionStart after a compaction');

  if (process.platform === 'win32') note('no time.tzset in Python on Windows, and the zone checks need it');
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-tz-'));
    try {
      const run = (tz, payload) => {
        const r = cp.spawnSync('python3', [hook, dir], { input: JSON.stringify(payload), encoding: 'utf8',
          env: Object.assign({}, process.env, { TZ: tz }) });
        try { return JSON.parse(r.stdout).hookSpecificOutput; } catch (e) { return r.stdout.trim() || null; }
      };
      const prompt = { hook_event_name: 'UserPromptSubmit', session_id: '19c00000-0000-0000-0000-000000000000' };
      const none = run('UTC', prompt);
      fs.writeFileSync(path.join(dir, 'client-time-zone.json'), JSON.stringify({ timeZone: 'Asia/Tokyo' }) + '\n');
      const told = run('UTC', prompt);
      const again = run('UTC', prompt);
      const same = run('Asia/Tokyo', Object.assign({}, prompt, { session_id: '19c00000-0000-0000-0000-000000000001' }));
      const transcript = path.join(dir, 't.jsonl');
      fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant',
        content: [{ type: 'text', text: '[relayed] hello' }] } }) + '\n');
      const compacted = run('UTC', { hook_event_name: 'SessionStart', source: 'compact', transcript_path: transcript });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ quietWhenReplyMatches: '^\\[relayed\\]' }));
      const relayed = run('UTC', { hook_event_name: 'SessionStart', source: 'compact', transcript_path: transcript });
      const stillPrompt = run('UTC', Object.assign({}, prompt, { session_id: '19c00000-0000-0000-0000-000000000002' }));
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ tellTimeZone: false }));
      const off = run('UTC', Object.assign({}, prompt, { session_id: '19c00000-0000-0000-0000-000000000003' }));
      const text = told && told.additionalContext || '';
      if (none === null && told && told.hookEventName === 'UserPromptSubmit'
          && /^The user is in Asia\/Tokyo \(JST, UTC\+09:00\), where it is now \w{3} \d{4}-\d\d-\d\d \d\d:\d\d\. This machine runs on UTC \(UTC\+00:00\)/.test(text)
          && again === null && same === null && fs.existsSync(path.join(dir, '19c00000-0000-0000-0000-000000000000.tz'))) {
        ok('with a zone reported and the machine elsewhere, a conversation is told both once; with none reported, or the same zone, nothing');
      } else bad(`none: ${JSON.stringify(none)}, told: ${JSON.stringify(told)}, again: ${JSON.stringify(again)}, same zone: ${JSON.stringify(same)}`);
      if (compacted && compacted.hookEventName === 'SessionStart' && relayed === null && stillPrompt && off === null) {
        ok('after a compaction too, unless the conversation is relaying; and nothing at all once the setting is off');
      } else bad(`after compaction: ${JSON.stringify(compacted)}, relaying: ${JSON.stringify(relayed)}, `
        + `message while relaying: ${JSON.stringify(stillPrompt)}, off: ${JSON.stringify(off)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const writer = (/const writeClientZone = \(\) => \{[\s\S]*?\n  \};\n/.exec(ext) || [''])[0];
  const defaults = fs.readFileSync(path.join(hooks, 'plan_path.py'), 'utf8');
  if (/path\.join\(planDir\(\), 'client-time-zone\.json'\)/.test(writer) && /if \(!zone\) return;/.test(writer)
      && /globalThis\.__cceTzHook = \(\) => \{[\s\S]*?writeClientZone\(\);[\s\S]*?\};\n[\s\S]*?\n  writeClientZone\(\);/.test(ext)
      && /tellTimeZone: PREFIX \+ 'tellClaudeYourTimeZone'/.test(ext) && /"tellTimeZone": True/.test(defaults)) {
    ok('a reported zone is written where the hook reads it, never as empty, and the setting reaches the hook');
  } else bad('extension.js does not write client-time-zone.json into planDir() on a report, or does not pass tellClaudeYourTimeZone to the hooks');
}

/* ── 19d. one copy of what the hooks share ── The transcript tail, the atomic write, the plan's file name, the
   side-file names, the row walk and the row command line exist once, in plan_path.py. Copies can drift, for example: a
   fixed temporary name two processes can collide on, marker files written in place, a plan-name check missing from the
   function that builds the name. */
console.log('\none copy of what the hooks share');
{
  const hooks = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks');
  const scripts = fs.readdirSync(hooks).filter((f) => f.endsWith('.py') && f !== 'plan_path.py');
  const copies = [
    ['reads a transcript from its end', /\.seek\(/],
    ['writes a file and renames it into place', /os\.replace\(/],
    ['spells the session id pattern', /\[0-9A-Fa-f\]\[0-9A-Fa-f-\]\{7,\}/],
    ['spells a side file suffix', /["']\.(turn|nudged|offered|watermark|tz|lock)["']/],
    ['builds the row command path', /join\([^)]*["']plan-row\.py["']/],
    ['walks children with a guard of its own', /def any_(doing|in)\(/],
    ['parses a time of its own', /strptime\(/],
  ];
  const found = [];
  for (const f of scripts) {
    const src = fs.readFileSync(path.join(hooks, f), 'utf8');
    for (const [what, re] of copies) if (re.test(src)) found.push(`${f} ${what}`);
  }
  if (!found.length) ok(`none of the ${scripts.length} other scripts keeps its own copy of what plan_path.py shares`);
  else bad(`copies outside plan_path.py: ${found.join('; ')}`);
}

/* ── 21. an uninstall puts Claude Code back at once ──
   The editor runs the uninstall hook only when it deletes this extension's folder, which in remote development once
   came eight hours after the uninstall. deactivate runs at the restart that follows an uninstall - and at every reload
   and every window closing too, so what decides everything is the test for "this copy is being uninstalled". Most of
   the cases below are the ones that must not count as one. */
console.log('\nan uninstall puts Claude Code back at once');
{
  const removal = require('../src/removal');
  const ID = 'xnervwang.claude-code-plus';
  const me = ID + '-1.0.5';
  const stage = (folders, marked, body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-uninst-'));
    for (const f of folders) fs.mkdirSync(path.join(dir, f));
    if (body !== undefined) fs.writeFileSync(path.join(dir, '.obsolete'), body);
    else if (marked) fs.writeFileSync(path.join(dir, '.obsolete'), JSON.stringify(Object.fromEntries(marked.map((m) => [m, true]))));
    return dir;
  };
  const cases = [
    ['this copy marked for deletion and nothing else left: an uninstall', [me], [me], true],
    ['this copy marked while a newer version is not: an update, not an uninstall', [me, ID + '-1.0.6'], [me], false],
    ['this copy not marked: an ordinary reload or a window closing', [me], [], false],
    ['every version marked: an uninstall', [me, ID + '-1.0.4'], [me, ID + '-1.0.4'], true],
    ['an extension whose name merely starts with ours is not a version of it', [me, ID + '-helper-1.0.0'], [me], true],
  ];
  for (const [what, folders, marked, want] of cases) {
    const dir = stage(folders, marked);
    const got = removal.beingUninstalled(path.join(dir, me), ID);
    if (got === want) ok(what);
    else bad(`${what}: said ${got}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const none = stage([me]);
    const junk = stage([me], null, '{not json');
    if (!removal.beingUninstalled(path.join(none, me), ID) && !removal.beingUninstalled(path.join(junk, me), ID)) {
      ok('no record at all, or one that does not parse, is never read as an uninstall');
    } else bad('a missing or broken .obsolete was read as an uninstall');
    fs.rmSync(none, { recursive: true, force: true });
    fs.rmSync(junk, { recursive: true, force: true });
  }

  /* The restore itself, on a copy of a real Claude Code install: patched by the same code that patches it in use, then
     put back by the code deactivate calls. Only the files we patch are copied. */
  const source = (() => {
    for (const d of Array.from(new Set(extensionsDirs()))) {
      for (const install of webview.findInstalls(d)) {
        const files = ADAPTERS.map((a) => pristine(a.targetFile(install), a));
        if (files.every((f) => f && !f.foreign)) return { install, files };
      }
    }
    return null;
  })();
  if (!source) note('no pristine Claude Code install here to try a restore on');
  else {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-restore-'));
    const copy = path.join(root, 'anthropic.claude-code-9.9.9-linux-x64');
    ADAPTERS.forEach((a, i) => {
      const f = a.targetFile(copy);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, source.files[i].src);
    });
    const applied = ADAPTERS.map((a) => a.apply(copy, { enabled: true }));
    const patched = ADAPTERS.every((a) => a.status(copy) === 'patched');
    const done = removal.restoreAll([root]);
    const same = ADAPTERS.every((a, i) => fs.readFileSync(a.targetFile(copy), 'utf8') === source.files[i].src);
    const left = [];
    for (const a of ADAPTERS) {
      const b = a.targetFile(copy) + a.BACKUP_SUFFIX;
      if (fs.existsSync(b)) left.push(path.basename(b));
    }
    for (const n of fs.readdirSync(path.join(copy, 'webview'))) if (n.startsWith('claude-code-extras')) left.push(n);
    if (patched && done.filter((r) => r.changed).length === ADAPTERS.length && same && !left.length) {
      ok(`a patched copy of ${path.basename(source.install)} comes back byte for byte, with no backup or stylesheet left`);
    } else {
      bad(`patched ${patched}, restored ${JSON.stringify(done.map((r) => r.message))}, identical ${same}, `
        + `left ${JSON.stringify(left)}, applied ${JSON.stringify(applied.map((r) => r.message))}`);
    }
    const again = removal.restoreAll([root]);
    if (again.every((r) => !r.changed)) ok('a second restore changes nothing, so the editor running the hook later is harmless');
    else bad(`a second restore changed something: ${JSON.stringify(again)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* The rest goes to a process that outlives the host: the same uninstall.js, run as plain Node, detached. */
  {
    const calls = [];
    const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { calls.push('unref'); } }; };
    const where = path.join(os.tmpdir(), me);
    removal.finishLater(where, fake);
    const c = calls[0] || {};
    if (c.cmd === process.execPath && c.args && c.args[0] === path.join(where, 'uninstall.js') && c.opts.detached === true
      && c.opts.stdio === 'ignore' && c.opts.env.ELECTRON_RUN_AS_NODE === '1' && calls[1] === 'unref') {
      ok('the plugin is unregistered by uninstall.js in a detached process, run as plain Node');
    } else bad(`finishLater spawned ${JSON.stringify(calls)}`);
  }

  /* The wiring, read from the source, since it is what makes any of the above happen in the editor. */
  {
    const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    const un = fs.readFileSync(path.join(__dirname, '..', 'uninstall.js'), 'utf8');
    const deact = (/function deactivate\(\) \{([\s\S]*?)\n\}/.exec(ext) || [])[1] || '';
    const checks = [
      ['deactivate restores and hands the rest on, and only for an uninstall',
        /beingUninstalled\(selfPath, ID\)/.test(deact) && /restoreAll/.test(deact) && /finishLater/.test(deact)],
      /* Another editor on this machine can be running this extension, and sweeping its folder from here would pull its
         patch out from under it. */
      ['deactivate restores only this editor\'s extensions folder', /removal\.restoreAll\(\[path\.dirname\(selfPath\)\]\)/.test(deact) && !/roots\(/.test(deact)],
      ['a window that has not restarted yet restores rather than patching again',
        /const restoring = removed\(\) \|\| leaving;/.test(ext) && /if \(restoring\) \{\s*const r = adapter\.restore\(dir\);/.test(ext)],
      ['and writes no stylesheet back',
        /const writeLiveNow = \(\) => \{\s*if \(removed\(\) \|\| uninstalling\(\) \|\| replaced\(\)\) return;/.test(ext)
        && /if \(removed\(\) \|\| !enabled\(\) \|\| uninstalling\(\) \|\| replaced\(\)\) \{ unwatchEffort\(\); return; \}/.test(ext)],
      ['the uninstall hook restores through the same code, in the folders uninstallPlan gives',
        /removal\.uninstallPlan\(path\.dirname\(__dirname\), id\)/.test(un) && /removal\.restoreAll\(plan\.restore\)/.test(un)
        && !/adapter\.restore\(/.test(un) && !/roots\(/.test(un)],
      ['and leaves the plugin to another editor\'s copy', /const claudeBin = plan\.lastCopy \? pluginInstall\.findClaude\(found\) : '';/.test(un)],
    ];
    for (const [what, pass] of checks) {
      if (pass) ok(what);
      else bad(what);
    }
  }
}

console.log('\nthe uninstall hook with another editor on the machine');
{
  const removal = require('../src/removal');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-two-editors-'));
  const realHome = process.env.HOME, realExt = process.env.VSCODE_EXTENSIONS;
  const ID = 'xnervwang.claude-code-plus';
  const dirOf = (p) => { const d = path.join(home, p, 'extensions'); fs.mkdirSync(d, { recursive: true }); return d; };
  try {
    process.env.HOME = home;
    delete process.env.VSCODE_EXTENSIONS;
    const server = dirOf('.vscode-server'), stable = dirOf('.vscode'), insiders = dirOf('.vscode-insiders');
    fs.mkdirSync(path.join(server, ID + '-1.0.22'));
    fs.writeFileSync(path.join(server, '.obsolete'), JSON.stringify({ [ID + '-1.0.22']: true }));
    fs.mkdirSync(path.join(stable, ID + '-1.0.21'));
    fs.mkdirSync(path.join(insiders, ID + '-1.0.20'));
    fs.writeFileSync(path.join(insiders, '.obsolete'), JSON.stringify({ [ID + '-1.0.20']: true }));
    fs.mkdirSync(path.join(insiders, ID + 'x-1.0.0'));
    const plan = removal.uninstallPlan(server, ID);
    if (JSON.stringify(plan.restore) === JSON.stringify([server, insiders]) && plan.lastCopy === false
      && JSON.stringify(plan.owned) === JSON.stringify([stable])) {
      ok('another editor\'s folder with a copy still installed is left to it, and the plugin with it');
    } else bad(`uninstall plan ${JSON.stringify(plan)}`);
    fs.writeFileSync(path.join(stable, '.obsolete'), JSON.stringify({ [ID + '-1.0.21']: true }));
    const last = removal.uninstallPlan(server, ID);
    if (JSON.stringify(last.restore) === JSON.stringify([server, stable, insiders]) && last.lastCopy === true) {
      ok('with no copy left in any editor, every folder is cleaned up and the plugin is unregistered');
    } else bad(`uninstall plan with no copy left ${JSON.stringify(last)}`);
  } finally {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realExt !== undefined) process.env.VSCODE_EXTENSIONS = realExt;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/* ── 22. the work plan plugin after an uninstall and a reinstall ──
   The memory of having registered the plugin is kept by the editor and outlives an uninstall of this extension, which
   unregisters the plugin; a reinstall then read "registered" and never registered it again. The cases that must NOT
   bring it back matter as much: removing the plugin on purpose leaves its marketplace known, and that has to stick. */
console.log('\nthe work plan plugin after an uninstall and a reinstall');
{
  const pi = require('../src/plugin-install');
  const home = (plugins, markets) => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-reg-'));
    fs.mkdirSync(path.join(h, '.claude', 'plugins'), { recursive: true });
    if (plugins !== undefined) fs.writeFileSync(path.join(h, '.claude', 'plugins', 'installed_plugins.json'), plugins);
    if (markets !== undefined) fs.writeFileSync(path.join(h, '.claude', 'plugins', 'known_marketplaces.json'), markets);
    return h;
  };
  const listed = JSON.stringify({ version: 2, plugins: { [pi.REF]: [{ scope: 'user' }] } });
  const none = JSON.stringify({ version: 2, plugins: { 'other@elsewhere': [] } });
  const market = JSON.stringify({ [pi.MARKETPLACE]: { source: { source: 'directory' } } });
  const noMarket = JSON.stringify({ elsewhere: {} });
  const cases = [
    ['plugin and marketplace both gone, as an uninstall of this extension leaves them: register again', none, noMarket, true],
    ['the plugin gone while its marketplace is still known, as removing it on purpose leaves it: leave it', none, market, false],
    ['the plugin still listed: nothing to do', listed, market, false],
    ['records that cannot be read: do nothing', '{oops', noMarket, false],
    ['no records at all: do nothing', undefined, undefined, false],
  ];
  for (const [what, plugins, markets, want] of cases) {
    const h = home(plugins, markets);
    const got = pi.registrationGone(h);
    if (got === want) ok(what);
    else bad(`${what}: said ${got}`);
    fs.rmSync(h, { recursive: true, force: true });
  }
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const body = (/const syncPlugin = async \(retry\) => \{([\s\S]*?)\n  \};/.exec(ext) || [])[1] || '';
  if (/registrationGone\(\)/.test(body) && /!undone/.test(body) && /&& staged\) return;/.test(body)) {
    ok('registering consults Claude Code\'s records and the staged copy, not only its own memory');
  } else bad('syncPlugin still trusts only its remembered state');
  /* The staged copy is there or not by its contents: one cut short, or being replaced by another window, is there. Its
     contents are the fitted copy, so they are compared with what was recorded when it was staged. */
  if (/const staged = !!state\.staged && pluginInstall\.digest\(to\) === state\.staged;/.test(body)
    && /staged: pluginInstall\.digest\(to\)/.test(body) && /findPython\(/.test(body)) {
    ok('the staged copy counts as in place only when its contents are what was staged for the Python found here');
  } else bad('the staged copy is still taken as in place because its folder exists');

  /* The hooks are Python started by name, and Windows has no python3 even with Python installed from python.org. */
  {
    const replies = {
      'py -3': [new Error('not found'), ''],
      python: [null, '2 7\nC:\\Python27\\python.exe\n'],
      python3: [null, '3 12\r\nC:\\Program Files\\Python312\\python.exe\r\n'],
    };
    const script = `const pi = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'plugin-install.js'))});
      const replies = ${JSON.stringify(replies, (k, v) => (v instanceof Error ? { err: v.message } : v))};
      const asked = [];
      const fake = (cmd, args, opts, cb) => { const key = [cmd].concat(args.slice(0, -2)).join(' '); asked.push(key);
        const r = replies[key] || [{ err: 'x' }, '']; cb(r[0] && r[0].err ? new Error(r[0].err) : null, r[1], ''); };
      Promise.all([pi.findPython(fake, [['py', '-3'], ['python'], ['python3']]), pi.findPython(fake, [['py', '-3']])])
        .then((r) => console.log(JSON.stringify({ found: r[0], none: r[1], asked })));`;
    const r = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    let got = null;
    try { got = JSON.parse(r.stdout); } catch (_) { got = null; }
    if (got && got.found && got.found.launcher.join(' ') === 'python3' && got.found.executable === 'C:\\Program Files\\Python312\\python.exe'
      && got.found.version === '3.12' && got.none === null) {
      ok('the first Python 3 that answers is used, with its own path; one that fails to start or answers as Python 2 is passed over');
    } else bad(`findPython: ${r.stdout} ${r.stderr}`);
  }
  {
    const src = path.join(__dirname, '..', 'claude-plugin');
    const copy = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-fit-')); fs.cpSync(src, d, { recursive: true }); return d; };
    const hooksOf = (d) => JSON.parse(fs.readFileSync(path.join(d, pi.PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
    const all = (cfg) => Object.values(cfg.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
    const original = fs.readFileSync(path.join(src, pi.PLUGIN, 'hooks', 'hooks.json'), 'utf8');
    const a = copy(), b = copy(), c = copy();
    pi.fitHooks(a, { launcher: ['py', '-3'], executable: 'C:\\Program Files\\Python312\\python.exe', version: '3.12' });
    pi.fitHooks(b, null);
    pi.fitHooks(c, { launcher: ['python3'], executable: '/usr/bin/python3', version: '3.7' });
    const fitted = all(hooksOf(a));
    const launcher = JSON.parse(fs.readFileSync(path.join(a, pi.PLUGIN, 'hooks', 'launcher.json'), 'utf8'));
    if (fitted.length === all(JSON.parse(original)).length && fitted.every((h) => h.command === 'C:\\Program Files\\Python312\\python.exe'
      && h.args.length === 2 && /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[\w-]+\.py$/.test(h.args[0]) && h.args[1] === '${CLAUDE_PLUGIN_DATA}')
      && launcher.row.join(' ') === 'py -3') {
      ok('with another Python each hook is started as that executable with its arguments, and the row command is told how to start it');
    } else bad(`fitted hooks ${JSON.stringify(fitted.slice(0, 2))}, launcher ${JSON.stringify(launcher)}`);
    if (JSON.stringify(hooksOf(b)) === JSON.stringify({ hooks: {} }) && !fs.existsSync(path.join(b, pi.PLUGIN, 'skills'))) {
      ok('with no Python 3 the staged plugin has neither hooks nor skill');
    } else bad('without Python the staged plugin still has hooks or its skill');
    if (fs.readFileSync(path.join(c, pi.PLUGIN, 'hooks', 'hooks.json'), 'utf8') === original
      && !fs.existsSync(path.join(c, pi.PLUGIN, 'hooks', 'launcher.json'))) ok('with python3 the staged plugin is left as it ships');
    else bad('python3 changed the staged plugin');
    /* The block the model reads names the same launcher in the row command it gives. */
    const sess = '47000000-0000-0000-0000-000000000000';
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-fit-data-'));
    fs.writeFileSync(path.join(data, sess + '.json'), JSON.stringify({ nodes: [{ title: 'a', state: 'todo' }] }));
    const r = cp.spawnSync('python3', [path.join(a, pi.PLUGIN, 'hooks', 'inject-work-plan.py'), data], {
      encoding: 'utf8', input: JSON.stringify({ session_id: sess, hook_event_name: 'UserPromptSubmit' }) });
    let text = '';
    try { text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) { text = r.stdout + r.stderr; }
    if (/To change a row: py -3 ('[^']*plan-row\.py'|\S+plan-row\.py) ('[^']*'|\S+) set <row>/.test(text)) ok('the row command in the block starts Python the same way the hooks found it');
    else bad(`row command with a launcher: ${JSON.stringify(text.slice(0, 400))}`);
    /* The first row is written before any hook has run, so the skill itself names the launcher. */
    const skillOf = (d) => fs.readFileSync(path.join(d, pi.PLUGIN, 'skills', 'maintain', 'SKILL.md'), 'utf8');
    const shipped = fs.readFileSync(path.join(src, pi.PLUGIN, 'skills', 'maintain', 'SKILL.md'), 'utf8');
    const spaced = copy();
    pi.fitHooks(spaced, { launcher: ['C:/Users/a b/python.exe'], executable: 'C:\\Users\\a b\\python.exe', version: '3.12' });
    if (shipped.split(pi.SKILL_RUN).length === 2 && skillOf(c) === shipped && skillOf(a).includes('run with `py -3`.')
      && !skillOf(a).includes(pi.SKILL_RUN)
      && skillOf(spaced).includes("run with `'C:/Users/a b/python.exe'` (in PowerShell, put `&` and a space in front)."))
      ok('the skill names the same launcher for the first row, quoted as the row command quotes it');
    else bad(`skill launcher: ${JSON.stringify((skillOf(a).match(/run with [^\n]*/) || [''])[0])}`);
    for (const d of [a, b, c, data, spaced]) fs.rmSync(d, { recursive: true, force: true });
  }

  /* Without any Python on Windows, Python is downloaded from python.org at a pinned version and checked against its hash. */
  {
    const rt = require('../src/python-runtime');
    const b = rt.build('win32', 'x64');
    if (b && /python-\d+\.\d+\.\d+-embed-amd64\.zip$/.test(b.url) && b.url.startsWith('https://www.python.org/ftp/python/')
      && /^[0-9a-f]{64}$/.test(b.sha256) && rt.build('win32', 'arm64').name === 'arm64' && rt.build('linux', 'x64') === null
      && rt.build('darwin', 'arm64') === null) {
      ok('Python is offered for download only on Windows, from python.org, with a recorded SHA-256 for each processor');
    } else bad(`python builds: ${JSON.stringify(b)}`);
    const script = `const rt = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'python-runtime.js'))});
      const fs = require('fs'), path = require('path'), os = require('os');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-pyrt-'));
      const sha = rt.build().sha256;
      const fetchOk = async (url, file) => { fs.writeFileSync(file, 'zip'); return sha; };
      const fetchBad = async (url, file) => { fs.writeFileSync(file, 'zip'); return '0'.repeat(64); };
      const extract = async (zip, dir) => { fs.writeFileSync(path.join(dir, 'python.exe'), 'x'); return true; };
      (async () => {
        const bad = await rt.download(store, { fetch: fetchBad, extract });
        const leftAfterBad = fs.readdirSync(path.join(store, 'python'));
        const good = await rt.download(store, { fetch: fetchOk, extract });
        const leftAfterGood = fs.readdirSync(path.join(store, 'python'));
        console.log(JSON.stringify({ bad, good, leftAfterBad, leftAfterGood, exe: fs.existsSync(rt.executable(store)) }));
        fs.rmSync(store, { recursive: true, force: true });
      })();`;
    const r = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    let got = null;
    try { got = JSON.parse(r.stdout); } catch (_) { got = null; }
    if (got && !got.bad.ok && /SHA-256/.test(got.bad.said) && got.leftAfterBad.length === 0 && got.good.ok && got.exe
      && got.leftAfterGood.length === 1) {
      ok('a download that does not match its SHA-256 is thrown away whole, and a matching one is put in place only once unpacked');
    } else bad(`python download: ${r.stdout} ${r.stderr}`);
  }
  {
    /* The embeddable build runs from a ._pth file, which keeps the script's folder off the import path, as -I does. */
    const sess = '48000000-0000-0000-0000-000000000000';
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-iso-'));
    fs.writeFileSync(path.join(data, sess + '.json'), JSON.stringify({ nodes: [{ title: 'a', state: 'todo' }] }));
    const hooks = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks');
    const r = cp.spawnSync('python3', ['-I', path.join(hooks, 'inject-work-plan.py'), data], {
      encoding: 'utf8', input: JSON.stringify({ session_id: sess, hook_event_name: 'UserPromptSubmit' }) });
    if (r.status === 0 && r.stdout.includes('To change a row:')) ok('a hook still finds its own modules when Python leaves its folder off the import path');
    else bad(`hook under python -I: ${r.status} ${r.stderr.slice(0, 300)}`);
    /* A launcher whose path needs quoting runs in Bash as written, and in PowerShell only after &. */
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-amp-'));
    fs.cpSync(hooks, copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'launcher.json'), JSON.stringify({ row: ['C:/Users/Jo Ann/py/python.exe'] }));
    const q = cp.spawnSync('python3', [path.join(copy, 'inject-work-plan.py'), data], {
      encoding: 'utf8', input: JSON.stringify({ session_id: sess, hook_event_name: 'UserPromptSubmit' }) });
    let text = '';
    try { text = JSON.parse(q.stdout).hookSpecificOutput.additionalContext; } catch (_) { text = q.stdout + q.stderr; }
    if (text.includes("To change a row: 'C:/Users/Jo Ann/py/python.exe' ") && text.includes('In PowerShell, put & and a space in front')) {
      ok('a launcher path with a space is quoted, and the block says PowerShell needs & before it');
    } else bad(`quoted launcher: ${JSON.stringify(text.slice(0, 600))}`);
    for (const d of [data, copy]) fs.rmSync(d, { recursive: true, force: true });
  }

  /* All windows stage into the same folder; with one shared name for the copy in progress, two windows would delete
     each other's half-made copy. Finding the same plugin already in place counts as success. */
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-stage-'));
    const from = path.join(root, 'from'), to = path.join(root, 'storage', 'claude-plugin');
    fs.mkdirSync(path.join(from, 'agent-work-plan'), { recursive: true });
    fs.writeFileSync(path.join(from, 'agent-work-plan', 'a.txt'), 'plugin');
    const copies = [];
    const realCp = fs.cpSync, realRename = fs.renameSync;
    let threw = '';
    try {
      fs.cpSync = (a, b, o) => { copies.push(String(b)); return realCp.call(fs, a, b, o); };
      pi.stage(from, to);
      pi.stage(from, to);
      // Another window puts the same plugin in place between this one's copy and its rename.
      fs.renameSync = (a, b) => { realCp.call(fs, from, b, { recursive: true }); return realRename.call(fs, a, b); };
      try { pi.stage(from, to); } catch (e) { threw = e.message; }
    } finally { fs.cpSync = realCp; fs.renameSync = realRename; }
    const left = fs.readdirSync(path.dirname(to));
    if (copies.length === 3 && new Set(copies).size === 3 && copies.every((c) => c.includes('.' + process.pid + '.'))
      && !threw && left.join() === 'claude-plugin' && pi.digest(to) === pi.digest(from)) {
      ok('the plugin is staged through a folder of this process\'s own, and finding the same plugin already in place is not a failure');
    } else bad(`staging: copies ${JSON.stringify(copies.map((c) => path.basename(c)))}, threw ${JSON.stringify(threw)}, left ${JSON.stringify(left)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* The disable command must be given the Claude Code installs to find the binary; without them it finds none and does
     nothing. A stand-in binary records the command. */
  if (process.platform === 'win32') note('the stand-in binary is a shell script, which Windows cannot run as claude.exe');
  else {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-disable-'));
    const bin = path.join(root, 'install', pi.BINARY);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\necho "$@" > "$(dirname "$0")/told"\necho done\n');
    fs.chmodSync(bin, 0o755);
    const script = `
      const pi = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'plugin-install.js'))});
      pi.disable([${JSON.stringify(path.join(root, 'install'))}]).then((r) => process.stdout.write(JSON.stringify(r)));`;
    let r;
    try { r = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })); } catch (e) { r = { error: e.message }; }
    let told = '';
    try { told = fs.readFileSync(path.join(path.dirname(bin), 'told'), 'utf8').trim(); } catch (_) { /* never run */ }
    if (r.ok && told === `plugin disable ${pi.REF}` && /pluginInstall\.disable\(claudeFolders\(\)\)/.test(ext)) {
      ok('stopping the plugin loading finds Claude Code\'s binary in its installs and tells it to disable the plugin');
    } else bad(`disabling the plugin gave ${JSON.stringify(r)}, the binary was told ${JSON.stringify(told)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* Unregistering deletes the plugin's data directory, so the uninstall hook unregisters only after the plans are copied
     out. When the copy fails, nothing is unregistered and the plans stay where they are. */
  if (process.platform === 'win32') note('the stand-in binary is a shell script, which Windows cannot run as claude.exe');
  else {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-rescue-'));
    const bin = path.join(home, 'install', pi.BINARY);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\necho "$@" >> "$(dirname "$0")/told"\n');
    fs.chmodSync(bin, 0o755);
    const data = path.join(home, '.claude', 'plugins', 'data', pi.DATA_DIR);
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'aaaaaaaa-1111-2222-3333-444444444444.json'), '{"nodes":[]}');
    // Blocks the folder the copy goes to.
    fs.writeFileSync(path.join(home, '.claude', 'agent-work-plan-plans-blocked'), '');
    const script = `
      const pi = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'plugin-install.js'))});
      const out = { blocked: pi.removeSync(${JSON.stringify(bin)}, 'blocked') };
      out.toldAfterBlocked = require('fs').existsSync(${JSON.stringify(path.join(path.dirname(bin), 'told'))});
      out.copied = pi.removeSync(${JSON.stringify(bin)}, 'free');
      process.stdout.write(JSON.stringify(out));`;
    let r;
    try {
      r = JSON.parse(cp.execFileSync(process.execPath, ['-e', script],
        { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }) }));
    } catch (e) { r = { error: e.message }; }
    let told = '';
    try { told = fs.readFileSync(path.join(path.dirname(bin), 'told'), 'utf8'); } catch (_) { /* never run */ }
    const copy = path.join(home, '.claude', 'agent-work-plan-plans-free');
    if (r.blocked === '' && r.toldAfterBlocked === false && r.copied === copy
      && fs.existsSync(path.join(copy, 'aaaaaaaa-1111-2222-3333-444444444444.json'))
      && told.includes(`plugin uninstall ${pi.REF}`) && told.includes(`plugin marketplace remove ${pi.MARKETPLACE}`)) {
      ok('uninstalling leaves the plugin registered when its plans cannot be copied out');
    } else bad(`plan rescue: ${JSON.stringify(r)}, the binary was told ${JSON.stringify(told)}`);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/* ── 23. the sweep of abandoned plans is the module's ──
   extension.js once called a module function on a variable of another kind: the daily sweep of abandoned plans threw
   "is not a function" every time it ran, and nothing showed it but one line in the output channel. */
console.log('\nthe sweep of abandoned plans');
{
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  if (/\bsweepOrphans\b[^\n]*require\('\.\/src\/workplan'\)/.test(ext) && /const r = sweepOrphans\(\);/.test(ext)) {
    ok('the sweep of abandoned plans is the module\'s function, imported as such');
  } else bad('the sweep of abandoned plans is not called through the module');
}

/* Settings were named claudeCodeExtras.* and then claudeCodeWorkPlan.*. Moving them is the one part of a rename that can
   lose what a person set, so it is run against a stand-in for the editor's settings: what is copied and from which of
   the two old names, what is never overwritten, what is left when the editor refuses to clear a name nobody declares,
   and that a scope is done only once. */
console.log('\nsettings moved from their old names');
{
  // A real path: on macOS the temporary folder is reached through a symbolic link, and a module required by two spellings
  // of its path is loaded twice, leaving this test and the extension with two different stand-ins.
  const stub = path.join(fs.realpathSync(os.tmpdir()), 'cce-vscode-rename-stub.js');
  fs.writeFileSync(stub, `
    class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
    const store = { values: {}, refuseLegacyClear: false, refuseWrite: false, folders: [{ name: 'f', uri: {} }] };
    const FIELD = { 1: 'globalValue', 2: 'workspaceValue', 3: 'workspaceFolderValue' };
    const legacy = (k) => k.startsWith('claudeCodeExtras.') || k.startsWith('claudeCodeWorkPlan.');
    const conf = {
      inspect: (k) => ({ key: k, globalValue: (store.values.globalValue || {})[k], workspaceValue: (store.values.workspaceValue || {})[k],
        workspaceFolderValue: (store.values.workspaceFolderValue || {})[k] }),
      update: async (k, v, target) => {
        if (store.refuseWrite && !legacy(k)) throw new Error('refused');
        if (store.refuseLegacyClear && legacy(k)) throw new Error('not a registered configuration');
        const f = FIELD[target], bag = store.values[f] || (store.values[f] = {});
        if (v === undefined) delete bag[k]; else bag[k] = v;
      },
    };
    module.exports = {
      store, TreeItem,
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      ThemeIcon: class {}, ThemeColor: class {}, MarkdownString: class {}, EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
      Uri: { file: (p) => ({ fsPath: p }) },
      ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
      workspace: { getConfiguration: () => conf, get workspaceFolders() { return store.folders; } },
      window: {}, commands: {}, extensions: {},
    };
  `);
  const script = `
    const Module = require('module'), realResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) { return request === 'vscode' ? ${JSON.stringify(stub)} : realResolve.call(this, request, ...rest); };
    const path = require('path'), fs = require('fs');
    const vs = require(${JSON.stringify(stub)});
    const ext = require(${JSON.stringify(path.join(__dirname, '..', 'extension.js'))});
    const __dirname2 = ${JSON.stringify(path.join(__dirname))};
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname2, '..', 'package.json'), 'utf8'));
  const memo = () => { const m = new Map(); return { get: (k) => m.get(k), update: async (k, v) => { m.set(k, v); } }; };
  const context = () => ({ extension: { packageJSON: manifest }, globalState: memo(), workspaceState: memo() });
  const at = (field, k) => (vs.store.values[field] || {})[k];
  const run = async () => {
    const results = [];
    const reset = (values) => { vs.store.values = JSON.parse(JSON.stringify(values)); vs.store.refuseLegacyClear = false; vs.store.refuseWrite = false; };

    reset({ globalValue: { 'claudeCodeExtras.enabled': false, 'claudeCodeExtras.userMessageColor': 'blue', 'claudeCodePlus.userMessageColor': 'red',
      'claudeCodeWorkPlan.show.chime': false, 'claudeCodeWorkPlan.sessionPins': false, 'claudeCodeExtras.sessionPins': true },
      workspaceValue: { 'claudeCodeWorkPlan.workPlan': false } });
    const c1 = context();
    const said = await ext.renameSettings(c1);
    results.push([at('globalValue', 'claudeCodePlus.enabled') === false && at('globalValue', 'claudeCodeExtras.enabled') === undefined,
      'a value under the oldest name, claudeCodeExtras, is copied to its new name and cleared from the old one']);
    results.push([at('globalValue', 'claudeCodePlus.show.chime') === false && at('globalValue', 'claudeCodeWorkPlan.show.chime') === undefined,
      'a value under the later name, claudeCodeWorkPlan, is copied to its new name and cleared from the old one']);
    results.push([at('globalValue', 'claudeCodePlus.sessionPins') === false && at('globalValue', 'claudeCodeWorkPlan.sessionPins') === undefined
      && at('globalValue', 'claudeCodeExtras.sessionPins') === undefined,
      'with a value under both old names, the later one is copied and both are cleared']);
    results.push([at('globalValue', 'claudeCodePlus.userMessageColor') === 'red' && at('globalValue', 'claudeCodeExtras.userMessageColor') === undefined,
      'a value already set under the new name is not overwritten']);
    results.push([at('workspaceValue', 'claudeCodePlus.workPlan') === false && at('globalValue', 'claudeCodePlus.workPlan') === undefined,
      'a workspace value stays a workspace value']);
    results.push([/4 in user/.test(said) && /1 in workspace/.test(said) && c1.globalState.get('claudeCodePlus.settingsRenamed') === true,
      \`what was moved is said, per scope, and the scope is recorded under the new prefix ("\${said}")\`]);

    delete vs.store.values.globalValue['claudeCodePlus.enabled'];
    vs.store.values.globalValue['claudeCodeExtras.enabled'] = false;
    vs.store.values.globalValue['claudeCodeWorkPlan.enabled'] = false;
    await ext.renameSettings(c1);
    results.push([at('globalValue', 'claudeCodePlus.enabled') === undefined,
      'a scope is moved once: a new name put back to its default does not get an old value again']);

    reset({ globalValue: { 'claudeCodeWorkPlan.show.chime': false } });
    vs.store.refuseLegacyClear = true;
    const c2 = context();
    const said2 = await ext.renameSettings(c2);
    results.push([at('globalValue', 'claudeCodePlus.show.chime') === false && at('globalValue', 'claudeCodeWorkPlan.show.chime') === false
      && c2.globalState.get('claudeCodePlus.settingsRenamed') === true && /left in place/.test(said2),
      'when the editor will not clear an old name, the value is still moved and the old line is left, as said']);

    reset({ globalValue: { 'claudeCodeWorkPlan.enabled': false } });
    vs.store.refuseWrite = true;
    const c3 = context();
    await ext.renameSettings(c3);
    results.push([c3.globalState.get('claudeCodePlus.settingsRenamed') !== true && at('globalValue', 'claudeCodeWorkPlan.enabled') === false,
      'a copy that fails leaves the old value and the scope not done, so the next start tries again']);
    return results;
  };
    run().then((r) => process.stdout.write(JSON.stringify(r)), (e) => process.stdout.write(JSON.stringify({ error: String(e && e.stack || e) })));
  `;
  let results;
  try { results = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })); }
  catch (e) { results = { error: e.message }; }
  if (results.error) bad('moving settings threw: ' + results.error);
  else for (const [cond, label] of results) (cond ? ok : bad)(label);
  fs.rmSync(stub, { force: true });
}

/* The extension is xnervwang.claude-code-plus, and everything a person reads or types says Claude Code Plus; the names it
   keeps its own state and files under are older and stay. A name left behind in one of these places is an old one coming
   back. */
console.log('\nthe name a person sees');
{
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const c = manifest.contributes;
  const keys = [].concat(c.configuration).flatMap((x) => Object.keys(x.properties));
  const stray = keys.filter((k) => !k.startsWith('claudeCodePlus.'))
    .concat(c.commands.filter((x) => !x.command.startsWith('claudeCodePlus.')).map((x) => x.command));
  const shown = JSON.stringify([manifest.displayName, manifest.description, c.commands.map((x) => x.title), c.viewsContainers,
    [].concat(c.configuration).map((x) => x.title), keys.map((k) => [].concat(c.configuration).map((x) => x.properties[k]).find(Boolean).markdownDescription)]);
  const oldTitle = /Extras for Claude Code|Work Plan for Claude Code|claudeCodeWorkPlan\.|claudeCodeExtras\./.test(shown);
  const titled = c.commands.every((x) => x.title.startsWith('Claude Code Plus: ')) && [].concat(c.configuration).every((x) => x.title === 'Claude Code Plus');
  if (manifest.name === 'claude-code-plus' && manifest.publisher === 'xnervwang' && manifest.displayName === 'Claude Code Plus'
    && manifest.repository.url === 'https://github.com/xnervwang/vscode-claude-code-plus' && !stray.length && !oldTitle && titled) {
    ok('the manifest is xnervwang.claude-code-plus, every setting and command is named under claudeCodePlus, and every title says Claude Code Plus');
  } else bad('old names in the manifest: ' + JSON.stringify([manifest.name, manifest.displayName, manifest.repository, stray, oldTitle, titled]));
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').split('\n');
  const old = readme.filter((l) => /Extras for Claude Code|Work Plan for Claude Code|claudeCodeWorkPlan\.|claudeCodeExtras\.|xnervwang\.claude-code-extras/.test(l)
    && !/used to be|are copied to the same names under/.test(l));
  if (!old.length && readme[0] === '# Claude Code Plus') ok('the README is titled Claude Code Plus and names nothing by an old name, apart from saying what it used to be and where old settings went');
  else bad('the README still uses an old name: ' + [readme[0]].concat(old).map((l) => l.trim().slice(0, 80)).join(' | '));
}

/* ── the rename to Claude Code Plus ──
   The extension was published as xnervwang.claude-code-extras and is now xnervwang.claude-code-plus. Everything below
   runs extension.js against a stand-in editor in a child process with its own home folder, so what is checked is what
   activation does: which commands it registers, what it carries over from the old extension's storage, and what it leaves
   alone while the old extension still patches Claude Code itself. */
const LEGACY_ID = 'xnervwang.claude-code-extras';
/*
 * opts.extensions   id -> { packageJSON, extensionPath } the stand-in's getExtension answers for, $HOME in it standing for the
 *                   home folder
 * opts.taken        command ids another extension has registered already, which registerCommand refuses
 * opts.state        what this extension's globalState holds before it starts
 * opts.files        relative path under the home folder -> content, written before activation
 * opts.later        like opts.files, written once activate has resolved
 * opts.after(ms)    how long to let it run after activate resolves
 * Returns { threw, commands, looked, hooks, said, executed, logs, state, files, activateMs } - files being every file
 * under the home folder afterwards, relative, with its content when it is JSON.
 */
const activateStub = (opts = {}) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-plus-')));
  try {
    for (const [rel, body] of Object.entries(opts.files || {})) {
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, rel), body);
    }
    const stub = path.join(home, 'vscode-stub.js');
    fs.writeFileSync(stub, `
      const disposable = { dispose() {} };
      const rec = { commands: [], looked: [], said: [], executed: [], logs: [] };
      const taken = new Set(${JSON.stringify(opts.taken || [])});
      const exts = JSON.parse(${JSON.stringify(JSON.stringify(opts.extensions || {}))}.split('$HOME').join(${JSON.stringify(home)}));
      const say = async (text, ...items) => { rec.said.push([text].concat(items.filter((i) => typeof i === 'string'))); return ${JSON.stringify(opts.answer || null)} || undefined; };
      class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
      module.exports = { rec, TreeItem, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        ThemeIcon: class {}, ThemeColor: class {}, MarkdownString: class {}, TabInputWebview: class {}, version: '1.120.0',
        StatusBarAlignment: { Left: 1, Right: 2 }, env: { language: 'en' }, ProgressLocation: { Notification: 15 },
        EventEmitter: class { constructor() { this.event = () => disposable; } fire() {} },
        Uri: { file: (p) => ({ fsPath: p }) }, RelativePattern: class {}, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        workspace: { workspaceFolders: [], isTrusted: true, createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
          getConfiguration: () => ({ get: (k, d) => d, inspect: () => undefined, update: async () => {} }),
          onDidChangeConfiguration: () => disposable, onDidChangeWorkspaceFolders: () => disposable, onDidGrantWorkspaceTrust: () => disposable },
        window: { createOutputChannel: () => ({ appendLine(l) { rec.logs.push(l); }, show() {}, dispose() {} }), createTreeView: () => ({ dispose() {} }),
          createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }), registerWebviewViewProvider: () => disposable,
          showInformationMessage: say, showWarningMessage: say, showErrorMessage: say, setStatusBarMessage() {},
          tabGroups: { all: [], activeTabGroup: null }, showTextDocument: async () => {} },
        commands: {
          registerCommand: (id) => { if (taken.has(id)) throw new Error("command '" + id + "' already exists"); rec.commands.push(id); return disposable; },
          executeCommand: async (...a) => { rec.executed.push(a); } },
        extensions: { getExtension: (id) => { rec.looked.push(id); return exts[id]; }, onDidChange: () => disposable } };`);
    const root = path.join(__dirname, '..');
    const script = `
      const Module = require('module'), realResolve = Module._resolveFilename, path = require('path'), fs = require('fs');
      Module._resolveFilename = function (request, ...rest) { return request === 'vscode' ? ${JSON.stringify(stub)} : realResolve.call(this, request, ...rest); };
      const vs = require(${JSON.stringify(stub)});
      const ext = require(${JSON.stringify(path.join(root, 'extension.js'))});
      const home = ${JSON.stringify(home)};
      const storage = path.join(home, 'User', 'globalStorage', 'xnervwang.claude-code-plus');
      const memo = (init) => { const m = new Map(Object.entries(init || {})); return { m, get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); } }; };
      const subs = [], keep = setInterval;
      global.setInterval = (fn, ms) => keep(() => {}, 1 << 30);
      const globalState = memo(${JSON.stringify(opts.state || {})});
      (async () => {
        const out = { threw: '' };
        try {
          const t0 = Date.now();
          await ext.activate({ subscriptions: subs, extensionPath: ${JSON.stringify(root)}, globalState, workspaceState: memo(),
            extension: { id: 'xnervwang.claude-code-plus', packageJSON: require(${JSON.stringify(path.join(root, 'package.json'))}) },
            globalStorageUri: { fsPath: storage }, logUri: { fsPath: path.join(home, 'logs', 'exthost1', 'xnervwang.claude-code-plus') } });
          out.activateMs = Date.now() - t0;
          for (const [rel, body] of Object.entries(${JSON.stringify(opts.later || {})})) {
            fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
            fs.writeFileSync(path.join(home, rel), body);
          }
          await new Promise((r) => setTimeout(r, ${Number(opts.after) || 300}));
          out.hooks = typeof globalThis.__cceChatHook === 'function';
        } catch (e) { out.threw = String(e && e.stack); }
        out.state = Object.fromEntries(globalState.m);
        for (const s of subs) { try { s.dispose(); } catch (e) { out.threw = out.threw || 'dispose: ' + e.message; } }
        Object.assign(out, vs.rec);
        process.stdout.write(JSON.stringify(out));
        process.exit(0);
      })();
      process.on('unhandledRejection', (e) => { process.stdout.write(JSON.stringify({ threw: 'unhandled: ' + (e && e.stack) })); process.exit(0); });`;
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
    delete env.CLAUDE_CONFIG_DIR;
    let r;
    try { r = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000, env })); }
    catch (e) { r = { threw: e.message }; }
    r.files = {};
    const walk = (dir) => {
      for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, n.name);
        if (n.isDirectory()) walk(p);
        else if (n.name !== 'vscode-stub.js') {
          const body = fs.readFileSync(p, 'utf8');
          try { r.files[path.relative(home, p)] = JSON.parse(body); } catch (_) { r.files[path.relative(home, p)] = body; }
        }
      }
    };
    walk(home);
    return r;
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
};

/* A keybinding someone made under either old prefix names the command that way, so both old names stay registered,
   unlisted. When another extension in the same host holds one of them - the old extension itself, in a window that has
   not restarted its extensions since an update - the editor refuses it, and that must not stop the rest. */
console.log('\ncommands under both old names');
{
  const declared = require('../package.json').contributes.commands.map((x) => x.command.replace(/^[^.]+\./, ''));
  const r = activateStub({ taken: ['claudeCodeExtras.status'] });
  const has = new Set(r.commands || []);
  const missing = [];
  for (const n of declared) {
    for (const p of ['claudeCodePlus.', 'claudeCodeWorkPlan.', 'claudeCodeExtras.']) if (!has.has(p + n) && p + n !== 'claudeCodeExtras.status') missing.push(p + n);
  }
  if (!r.threw && declared.length && !missing.length) ok(`each of the ${declared.length} commands is registered as claudeCodePlus.*, claudeCodeWorkPlan.* and claudeCodeExtras.*`);
  else bad(`commands not registered: ${JSON.stringify(missing)}${r.threw ? ' - threw ' + r.threw.slice(0, 300) : ''}`);
  if (!r.threw && has.has('claudeCodePlus.status') && !has.has('claudeCodeExtras.status') && has.has('claudeCodePlus.toggle')) {
    ok('an old command name another extension already holds is skipped, and activation carries on');
  } else bad(`with claudeCodeExtras.status taken: threw ${JSON.stringify((r.threw || '').slice(0, 300))}`);
}

/* The editor gives each extension id its own global storage folder, so the pins and colors chosen under the old id are in
   a sibling folder this extension would never read. Those two are the reader's own choices and are copied - copied, since
   the old extension can still be installed - when this extension has none of its own; everything else in that folder is
   rebuilt or asked for again, and stays where it is. */
console.log('\npins and colors from the old extension\'s storage');
{
  const OLD = 'User/globalStorage/' + LEGACY_ID + '/', NEW = 'User/globalStorage/xnervwang.claude-code-plus/';
  const sid = 'abababab-1111-4222-8333-444444444444';
  const pins = { pinned: [sid], times: {} }, colors = { colors: { [sid]: 'green' } }, mine = { colors: { [sid]: 'red' } };
  const files = { [OLD + 'session-pins.json']: JSON.stringify(pins), [OLD + 'session-colors.json']: JSON.stringify(colors),
    [OLD + 'open-latency-1.jsonl']: '{}\n', [OLD + 'tab-icons/idle.svg']: '<svg/>', [OLD + 'claude-plugin/x.txt']: 'x' };
  const r = activateStub({ files });
  const f = r.files || {};
  if (!r.threw && JSON.stringify(f[NEW + 'session-pins.json']) === JSON.stringify(pins) && JSON.stringify(f[NEW + 'session-colors.json']) === JSON.stringify(colors)
    && JSON.stringify(f[OLD + 'session-pins.json']) === JSON.stringify(pins) && JSON.stringify(f[OLD + 'session-colors.json']) === JSON.stringify(colors)) {
    ok('the pins and colors are copied into this extension\'s storage, and the old copies stay');
  } else bad(`pins and colors after the first start: ${JSON.stringify({ threw: (r.threw || '').slice(0, 300), pins: f[NEW + 'session-pins.json'], colors: f[NEW + 'session-colors.json'] })}`);
  const carried = Object.keys(f).filter((k) => k.startsWith(NEW) && /open-latency-1|tab-icons\/idle|claude-plugin\/x\.txt/.test(k));
  if (!carried.length) ok('nothing else in the old storage is copied');
  else bad(`copied from the old storage as well: ${JSON.stringify(carried)}`);
  const r2 = activateStub({ files: Object.assign({}, files, { [NEW + 'session-colors.json']: JSON.stringify(mine) }) });
  const f2 = r2.files || {};
  if (!r2.threw && JSON.stringify(f2[NEW + 'session-colors.json']) === JSON.stringify(mine) && JSON.stringify(f2[NEW + 'session-pins.json']) === JSON.stringify(pins)) {
    ok('a file this extension already has is not overwritten, while the one it lacks is still copied');
  } else bad(`with colors of its own: ${JSON.stringify({ threw: (r2.threw || '').slice(0, 300), colors: f2[NEW + 'session-colors.json'], pins: f2[NEW + 'session-pins.json'] })}`);
}

/* The old extension installed as itself patches Claude Code with its own build, and two extensions doing that take turns
   rewriting the same files. So while it is, this one writes nothing anyone else reads, and says why once per version of
   the old one. The last version of the old id hands over instead - it depends on this extension and patches nothing - and
   with that one installed everything runs as usual. */
console.log('\nwhile the old extension is still installed');
{
  const cc = '$HOME/ext/anthropic.claude-code-2.1.999-linux-x64';
  const base = { files: { 'ext/anthropic.claude-code-2.1.999-linux-x64/webview/index.js': '', 'ext/anthropic.claude-code-2.1.999-linux-x64/extension.js': '',
    [`User/globalStorage/${LEGACY_ID}/session-pins.json`]: '{"pinned":[],"times":{}}' } };
  const claude = { packageJSON: { name: 'claude-code', version: '2.1.999' }, extensionPath: cc };
  const real = { packageJSON: { name: 'claude-code-extras', publisher: 'xnervwang', version: '1.0.21', extensionDependencies: ['anthropic.claude-code', 'xnervwang.agent-work-plan'] }, extensionPath: '/x/' + LEGACY_ID + '-1.0.21' };
  const shim = { packageJSON: { name: 'claude-code-extras', publisher: 'xnervwang', version: '1.0.22', extensionDependencies: ['xnervwang.claude-code-plus'] }, extensionPath: '/x/' + LEGACY_ID + '-1.0.22' };
  const run = (legacy, more = {}) => activateStub(Object.assign({}, base, more, { extensions: Object.assign({ 'anthropic.claude-code': claude }, legacy ? { [LEGACY_ID]: legacy } : {}) }));
  const touched = (r) => ({
    patching: (r.looked || []).includes('anthropic.claude-code'),
    core: (r.looked || []).includes('xnervwang.agent-plus'),
    hooks: r.hooks === true,
    oldCommands: (r.commands || []).filter((c) => !c.startsWith('claudeCodePlus.')).length,
    shared: Object.keys(r.files || {}).filter((k) => k.startsWith('.claude/') || /claude-code-extras\.(css|rev\.svg)$/.test(k) || k.startsWith('User/globalStorage/xnervwang.claude-code-plus/')),
    renamed: !!(r.state || {})['claudeCodePlus.settingsRenamed'],
  });
  const aside = run(real, { answer: 'Show It' });
  const t = touched(aside);
  if (!aside.threw && !t.patching && !t.core && !t.hooks && !t.oldCommands && !t.shared.length && !t.renamed) {
    ok('with the old extension installed as itself: no patch, no stylesheet, no plugin, no source, no hooks, no old command names, no settings moved, nothing copied');
  } else bad(`with the old extension installed: ${JSON.stringify(t)}${aside.threw ? ' threw ' + aside.threw.slice(0, 300) : ''}`);
  const warned = (aside.said || []).filter((s) => /Work Plan for Claude Code/.test(s[0]) && /update|uninstall/i.test(s[0]));
  const opened = (aside.executed || []).some((a) => a[0] === 'workbench.extensions.search' && a[1] === '@id:' + LEGACY_ID);
  if (warned.length === 1 && warned[0].includes('Show It') && opened && (aside.logs || []).some((l) => l.includes(LEGACY_ID) && l.includes('1.0.21'))
    && (aside.state || {})['claudeCodePlus.toldEarlierBuild'] === '1.0.21') {
    ok('it says so in the output and once in a notification, whose button searches the Extensions view for the old id');
  } else bad(`what it said: ${JSON.stringify({ said: aside.said, executed: aside.executed, logs: (aside.logs || []).slice(0, 4), told: (aside.state || {})['claudeCodePlus.toldEarlierBuild'] })}`);
  const again = run(real, { state: { 'claudeCodePlus.toldEarlierBuild': '1.0.21' } });
  const newer = run(Object.assign({}, real, { packageJSON: Object.assign({}, real.packageJSON, { version: '1.0.22' }) }), { state: { 'claudeCodePlus.toldEarlierBuild': '1.0.21' } });
  if (!(again.said || []).length && (again.logs || []).some((l) => l.includes(LEGACY_ID)) && (newer.said || []).length === 1) {
    ok('the notification is not repeated for the same version of the old extension, and is for another one');
  } else bad(`told again: ${JSON.stringify([again.said, newer.said])}`);
  const asideCommands = (aside.commands || []).filter((c) => c.startsWith('claudeCodePlus.'));
  if (asideCommands.length === require('../package.json').contributes.commands.length) ok('its own commands are still there, each saying why nothing happens');
  else bad(`commands while standing aside: ${JSON.stringify(aside.commands)}`);

  // What the last version writes as it activates, here already written by an earlier start.
  const handed = run(shim, { files: Object.assign({ [`User/globalStorage/${LEGACY_ID}/export.json`]: '{}' }, base.files) });
  const h = touched(handed);
  if (!handed.threw && h.patching && h.core && h.hooks && h.oldCommands && h.renamed
    && !(handed.said || []).some((s) => /Work Plan for Claude Code/.test(s[0]))) {
    ok('with the old id\'s last version installed, the one that hands over, everything runs as usual');
  } else bad(`with the old id's last version: ${JSON.stringify(h)}${handed.threw ? ' threw ' + handed.threw.slice(0, 300) : ''}`);
}

/* Uninstalling this extension puts Claude Code back and unregisters the plugin. With the old extension installed as
   itself in the same folder, that would take the patch and the plugin out from under it, so the folder is left to it; in
   another editor's folder an old copy counts the same as a copy of this one. */
console.log('\nan uninstall while the old extension is still installed');
{
  const removal = require('../src/removal');
  const ID = 'xnervwang.claude-code-plus';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-uninst-old-'));
  const realHome = process.env.HOME, realExt = process.env.VSCODE_EXTENSIONS;
  const put = (dir, folder, pkg) => { fs.mkdirSync(path.join(dir, folder), { recursive: true }); if (pkg) fs.writeFileSync(path.join(dir, folder, 'package.json'), JSON.stringify(pkg)); };
  const realPkg = { name: 'claude-code-extras', publisher: 'xnervwang', version: '1.0.21', extensionDependencies: ['anthropic.claude-code'] };
  const shimPkg = { name: 'claude-code-extras', publisher: 'xnervwang', version: '1.0.22', extensionDependencies: [ID] };
  try {
    process.env.HOME = home;
    delete process.env.VSCODE_EXTENSIONS;
    const server = path.join(home, '.vscode-server', 'extensions'), stable = path.join(home, '.vscode', 'extensions');
    put(server, ID + '-1.0.23', { name: 'claude-code-plus' });
    fs.writeFileSync(path.join(server, '.obsolete'), JSON.stringify({ [ID + '-1.0.23']: true }));
    put(server, LEGACY_ID + '-1.0.21', realPkg);
    fs.mkdirSync(stable, { recursive: true });
    const withOld = removal.uninstallPlan(server, ID);
    if (!withOld.restore.includes(server) && withOld.lastCopy === false) ok('the old extension in this folder keeps its patch and the plugin');
    else bad(`uninstall plan beside the old extension: ${JSON.stringify(withOld)}`);
    const earlier = (d) => (typeof removal.earlierCopies === 'function' ? removal.earlierCopies(d).length : -1);
    if (earlier(server) === 1 && earlier(stable) === 0) ok('a folder with the old extension installed as itself is told apart from one without');
    else bad(`earlier copies: ${JSON.stringify([earlier(server), earlier(stable)])}`);
    fs.rmSync(path.join(server, LEGACY_ID + '-1.0.21'), { recursive: true });
    put(server, LEGACY_ID + '-1.0.22', shimPkg);
    const withShim = removal.uninstallPlan(server, ID);
    if (withShim.restore[0] === server && withShim.lastCopy === true) ok('the old id\'s last version, which patches nothing, does not count');
    else bad(`uninstall plan beside the last version: ${JSON.stringify(withShim)}`);
    put(stable, LEGACY_ID + '-1.0.21', realPkg);
    const other = removal.uninstallPlan(server, ID);
    if (other.restore[0] === server && !other.restore.includes(stable) && other.lastCopy === false) ok('another editor with the old extension keeps its folder and the plugin');
    else bad(`uninstall plan with the old extension in another editor: ${JSON.stringify(other)}`);
  } finally {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realExt !== undefined) process.env.VSCODE_EXTENSIONS = realExt;
    fs.rmSync(home, { recursive: true, force: true });
  }
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const deact = (/function deactivate\(\) \{([\s\S]*?)\n\}/.exec(ext) || [])[1] || '';
  if (/removal\.earlierCopies\(path\.dirname\(selfPath\)\)\.length/.test(deact)) ok('deactivate leaves the folder alone the same way');
  else bad('deactivate restores Claude Code even beside the old extension');
}

/* shim/ is the last version of the old id. Auto-update brings it to everyone who has the old extension, and the editor
   installs what it depends on, which is how they get this one. It must never touch Claude Code: the patch and the plugin
   belong to this extension by then, and uninstalling the shim is exactly what it asks people to do. */
console.log('\nthe old id\'s last version, shim/');
{
  const dir = path.join(__dirname, '..', 'shim');
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
  let pkg = {};
  try { pkg = JSON.parse(read('package.json')); } catch (_) { pkg = {}; }
  const plus = require('../package.json');
  if (pkg.name === 'claude-code-extras' && pkg.publisher === 'xnervwang' && pkg.displayName === 'Work Plan for Claude Code (now Claude Code Plus)'
    && JSON.stringify(pkg.extensionDependencies) === JSON.stringify(['xnervwang.claude-code-plus'])
    && JSON.stringify(pkg.extensionKind) === JSON.stringify(plus.extensionKind) && pkg.engines && pkg.engines.vscode === plus.engines.vscode
    && pkg.main === './extension.js' && /^\d+\.\d+\.\d+$/.test(pkg.version || '')) {
    ok('its manifest is xnervwang.claude-code-extras, depends on xnervwang.claude-code-plus alone, and runs where this extension runs');
  } else bad(`shim manifest: ${JSON.stringify([pkg.name, pkg.publisher, pkg.displayName, pkg.extensionDependencies, pkg.extensionKind, pkg.engines, pkg.main, pkg.version])}`);
  if (pkg.name && !(pkg.scripts && pkg.scripts['vscode:uninstall']) && !pkg.contributes) ok('it has no uninstall hook and contributes nothing');
  else bad(`shim scripts and contributions: ${JSON.stringify([pkg.scripts, pkg.contributes])}`);
  const code = read('extension.js');
  const required = Array.from(code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map((m) => m[1]);
  const deact = (/function deactivate\(\) \{([\s\S]*?)\}/.exec(code) || [])[1];
  if (code && required.every((m) => ['vscode', 'fs', 'path'].includes(m)) && deact !== undefined && !deact.trim()) {
    ok('it requires nothing but vscode, fs and path, and deactivate does nothing');
  } else bad(`shim requires ${JSON.stringify(required)}, deactivate ${JSON.stringify(deact)}`);
  const ascii = ['package.json', 'extension.js', 'README.md'].filter((f) => !read(f) || /[^\x00-\x7f]/.test(read(f)));
  if (!ascii.length && read('LICENSE') === fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8')) ok('its files are ASCII and its LICENSE is this one');
  else bad(`shim files missing or not ASCII: ${JSON.stringify(ascii)}, LICENSE same ${read('LICENSE') === fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8')}`);
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8').split('\n');
  if (ignore.includes('shim/**') && !/\bshim\b/.test((fs.readFileSync(path.join(__dirname, '..', 'build', 'pack.sh'), 'utf8').match(/^cp -r .*$/m) || [''])[0])) {
    ok('this extension\'s own package leaves shim/ out');
  } else bad('shim/ would ship inside this extension');
  let carry = {};
  try { carry = require('../src/carryover'); } catch (_) { carry = {}; }

  /* Its activation, against a stand-in editor: the two state entries this extension imports are written to export.json,
     and the notice is shown once, its button uninstalling this id. */
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-shim-')));
  try {
    const stub = path.join(home, 'vscode-stub.js');
    fs.writeFileSync(stub, `
      const rec = { said: [], executed: [] };
      module.exports = { rec,
        window: { showInformationMessage: async (text, ...items) => { rec.said.push([text].concat(items)); return 'Uninstall'; } },
        commands: { executeCommand: async (...a) => { rec.executed.push(a); } } };`);
    const script = `
      const Module = require('module'), realResolve = Module._resolveFilename, path = require('path'), fs = require('fs');
      Module._resolveFilename = function (request, ...rest) { return request === 'vscode' ? ${JSON.stringify(stub)} : realResolve.call(this, request, ...rest); };
      const vs = require(${JSON.stringify(stub)});
      const shim = require(${JSON.stringify(path.join(dir, 'extension.js'))});
      const memo = (init) => { const m = new Map(Object.entries(init)); return { m, get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); } }; };
      const storage = path.join(${JSON.stringify(home)}, 'User', 'globalStorage', 'xnervwang.claude-code-extras');
      const state = memo({ 'claudeCodeExtras.removed': true, 'claudeCodeExtras.projectDirDays': { '/w': 20000 }, 'claudeCodeExtras.workPlanPlugin': { registered: true } });
      (async () => {
        const out = {};
        try {
          await shim.activate({ subscriptions: [], globalState: state, globalStorageUri: { fsPath: storage } });
          await new Promise((r) => setTimeout(r, 100));
          out.first = JSON.parse(fs.readFileSync(path.join(storage, 'export.json'), 'utf8'));
          out.said = vs.rec.said.length; out.executed = vs.rec.executed;
          fs.rmSync(path.join(storage, 'export.json'));
          await shim.activate({ subscriptions: [], globalState: state, globalStorageUri: { fsPath: storage } });
          await new Promise((r) => setTimeout(r, 100));
          out.again = fs.existsSync(path.join(storage, 'export.json'));
          out.saidAgain = vs.rec.said.length;
          out.left = fs.readdirSync(storage);
          out.deactivated = shim.deactivate();
        } catch (e) { out.threw = String(e && e.stack); }
        process.stdout.write(JSON.stringify(out));
      })();`;
    let r;
    try { r = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 })); }
    catch (e) { r = { threw: e.message }; }
    if (!r.threw && JSON.stringify(r.first) === JSON.stringify({ 'claudeCodeExtras.removed': true, 'claudeCodeExtras.projectDirDays': { '/w': 20000 } })
      && r.again === true && JSON.stringify(r.left) === JSON.stringify(['export.json'])) {
      ok('it writes the removed mark and the remembered folders to export.json on every activation, and nothing else');
    } else bad(`shim export: ${JSON.stringify(r).slice(0, 500)}`);
    if (!r.threw && r.said === 1 && r.saidAgain === 1
      && JSON.stringify(r.executed) === JSON.stringify([['workbench.extensions.uninstallExtension', 'xnervwang.claude-code-extras']])) {
      ok('its notice is shown once, and the Uninstall button uninstalls the old id');
    } else bad(`shim notice: ${JSON.stringify([r.said, r.saidAgain, r.executed])}`);
    const names = {};
    try {
      names.EXPORT_FILE = /const EXPORT_FILE = '([^']+)';/.exec(code)[1];
      names.EXPORTED_KEYS = JSON.parse(/const EXPORTED_KEYS = (\[[^\]]*\]);/.exec(code)[1].replace(/'/g, '"'));
    } catch (_) { /* reported below */ }
    if (carry.EXPORT_FILE && JSON.stringify([names.EXPORT_FILE, names.EXPORTED_KEYS]) === JSON.stringify([carry.EXPORT_FILE, carry.EXPORTED_KEYS])) {
      ok('the shim and this extension name the same file and the same entries');
    } else bad(`export names: ${JSON.stringify([names.EXPORT_FILE, names.EXPORTED_KEYS, carry.EXPORT_FILE, carry.EXPORTED_KEYS])}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }

  /* This extension's side: export.json is read, each entry imported only where this extension has no value of its own,
     and a removed mark means what running Remove would - nothing is patched and no plugin is registered. The shim
     activates only after this extension, which depends on it the other way, so the file can appear after this
     activation has returned; activation must not wait for it, and the start waits instead. */
  const OLD = 'User/globalStorage/' + LEGACY_ID + '/';
  const shimDesc = { packageJSON: pkg, extensionPath: '/x/' + LEGACY_ID + '-' + pkg.version };
  const cc = { packageJSON: { name: 'claude-code', version: '2.1.999' }, extensionPath: '$HOME/ext/anthropic.claude-code-2.1.999-linux-x64' };
  const ccFiles = { 'ext/anthropic.claude-code-2.1.999-linux-x64/webview/index.js': '', 'ext/anthropic.claude-code-2.1.999-linux-x64/extension.js': '' };
  const exported = JSON.stringify({ 'claudeCodeExtras.removed': true, 'claudeCodeExtras.projectDirDays': { '/w': 20000 } });
  const imp = activateStub({ extensions: { [LEGACY_ID]: shimDesc, 'anthropic.claude-code': cc }, files: Object.assign({ [OLD + 'export.json']: exported }, ccFiles) });
  const st = imp.state || {};
  if (!imp.threw && st['claudeCodeExtras.removed'] === true && st['claudeCodeExtras.projectDirDays'] && st['claudeCodeExtras.projectDirDays']['/w'] === 20000
    && !(imp.logs || []).some((l) => l.startsWith('work plan plugin:')) && !Object.keys(imp.files || {}).some((k) => /claude-code-extras\.css$/.test(k))) {
    ok('the removed mark and the folders are imported, and with the mark nothing is patched and no plugin is registered');
  } else bad(`import: ${JSON.stringify({ threw: (imp.threw || '').slice(0, 300), state: st, logs: (imp.logs || []).slice(0, 6) })}`);
  const own = activateStub({ extensions: { [LEGACY_ID]: shimDesc }, files: { [OLD + 'export.json']: exported }, state: { 'claudeCodeExtras.removed': false } });
  if (!own.threw && (own.state || {})['claudeCodeExtras.removed'] === false) ok('an entry this extension already has is not imported over');
  else bad(`with a value of its own: ${JSON.stringify((own.state || {})['claudeCodeExtras.removed'])}`);
  const late = activateStub({ extensions: { [LEGACY_ID]: shimDesc }, later: { [OLD + 'export.json']: exported }, after: 1500 });
  if (!late.threw && late.activateMs < 1000 && (late.state || {})['claudeCodeExtras.removed'] === true && late.hooks === true) {
    ok('with the shim installed and no export.json yet, activation returns at once, and the start waits for the file and imports it');
  } else bad(`export.json written after activation: ${JSON.stringify({ threw: (late.threw || '').slice(0, 300), ms: late.activateMs, removed: (late.state || {})['claudeCodeExtras.removed'], hooks: late.hooks })}`);
}

/* What the rename leaves alone, because installed machines already have it: a marker or a backup suffix renamed would no
   longer be recognized in a Claude Code install patched by an earlier build, the marketplace and plugin names are what
   Claude Code registered and named the plan directory after, and the state keys are what the last version of the old
   extension exports for this one to read. */
console.log('\nnames the rename leaves alone');
{
  const pi = require('../src/plugin-install');
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const wv = src('src/webview.js'), hs = src('src/host.js'), ext = src('extension.js');
  const market = JSON.parse(src('claude-plugin/.claude-plugin/marketplace.json'));
  const checks = [
    ['the patch markers', webview.ANY_MARK === '/* CLAUDE-CODE-EXTRAS-WEBVIEW ' && host.ANY_MARK === '/* CLAUDE-CODE-EXTRAS-HOST v'
      && webview.MARK.startsWith(webview.ANY_MARK) && host.MARK.startsWith(host.ANY_MARK)],
    ['the backup and temporary-file suffixes', webview.BACKUP_SUFFIX === '.claude-code-extras-webview.bak' && host.BACKUP_SUFFIX === '.claude-code-extras-host.bak'
      && /const TMP_SUFFIX = '\.claude-code-extras-host\.tmp';/.test(hs) && /\$\{file\}\.claude-code-extras-webview\./.test(wv)],
    ['the files written beside the panel', /const LIVE_CSS = 'claude-code-extras\.css';/.test(wv) && /const LIVE_REV = 'claude-code-extras\.rev\.svg';/.test(wv)
      && webview.EFFORT_PREFIX === 'claude-code-extras.effort.' && /var OURS = '\/webview\/claude-code-extras\.';/.test(src('src/page/05-page-setup.js'))],
    ['the page\'s console tag', /\[claude-code-extras\] /.test(src('src/page/99-sweep.js'))],
    ['the marketplace, the plugin and the plan directory', pi.MARKETPLACE === 'claude-code-extras' && market.name === 'claude-code-extras'
      && pi.PLUGIN === 'agent-work-plan' && pi.DATA_DIR === 'agent-work-plan-claude-code-extras'
      && /"agent-work-plan-claude-code-extras"\)/.test(src('claude-plugin/agent-work-plan/hooks/plan_path.py'))],
    ['the state keys the old extension\'s last version exports', /const REMOVED_KEY = 'claudeCodeExtras\.removed';/.test(ext)
      && /DIRS_KEY = 'claudeCodeExtras\.projectDirDays'/.test(ext)],
  ];
  for (const [what, pass] of checks) (pass ? ok : bad)(pass ? what + ' keep their earlier names' : what + ' were renamed');
}

console.log('\nthe latest tool call, on the working line while Focus view folds the tool calls');
{
  const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '88-tool-clock.js'), 'utf8');
  let searches = 0, busy = false, prompts = 0, focusOn = true, off = false;
  const session = { messages: { value: [] } };
  const box = {
    out: {},
    isOff: () => off,
    fmt: (ms) => 'T' + ms,
    dur: (ms) => (ms > 0 ? Math.round(ms / 1000) + 's' : ''),
    agentOf: (m) => m.parentToolUseId || '',
    setStyle() {},
    sigOn: (name) => name === 'visiblyBusy' && busy,
    sigLen: (name) => (name === 'permissionRequests' ? prompts : 0),
    panelContext: () => ({ focusViewEnabled: focusOn }),
    sessionRef: session,
    window: { innerHeight: 800 },
    document: { querySelector: () => null, querySelectorAll: () => { searches++; return []; } },
  };
  new vm.Script(`(function(){${fragment}\n;out.state = toolState; out.text = toolClockText; out.paint = paintToolClock;})()`,
    { filename: '88-tool-clock.js' }).runInNewContext(box);
  const o = box.out, T = 1000000;
  const prompt = (at, extra) => Object.assign({ type: 'user', timestamp: at, content: [{ content: { type: 'text' } }] }, extra);
  const results = (at, extra) => Object.assign({ type: 'user', timestamp: at, content: [{ content: { type: 'tool_result' } }] }, extra);
  const call = (at, name, doneAt, type = 'tool_use', returned) => ({ type: 'assistant', timestamp: at,
    content: [{ content: { type, name }, cceResultAt: doneAt, toolResult: { value: returned } }] });
  const expect = (got, want, label) => (got === want ? ok(label) : bad(`${label}: got "${got}", expected "${want}"`));
  const says = (msgs, now, short) => o.text(o.state(msgs), now, !!short);

  const turn = [prompt(T), call(T + 1000, 'Read', T + 2000), results(T + 2000), call(T + 3000, 'Bash')];
  expect(says(turn, T + 8000), `Bash running for 5s (since T${T + 3000})`, 'a call with no result yet reads as running, with its start');
  expect(says(turn, T + 8000, true), 'Bash 5s', 'and has a short form for a narrow panel');
  expect(says([prompt(T), call(T + 1000, 'Read', T + 2000), call(T + 3000, 'Bash', T + 9000)], T + 12000),
    `last tool Bash finished 3s ago (T${T + 9000})`, 'once it is back, how long ago it finished');
  expect(says([prompt(T), call(T + 3000, 'Bash'), prompt(T + 20000)], T + 25000),
    'no tool call yet this turn (5s since your message)', 'a new turn with no call says so, timed from your message');
  expect(o.state([call(T + 3000, 'Bash'), prompt(T + 20000)]).open, 0, 'a call from an earlier turn that never came back is not running');
  expect(says([prompt(T), call(T + 1000, 'Read'), call(T + 2000, 'Grep')], T + 6000),
    `2 tools running for 5s (since T${T + 1000})`, 'two open calls are counted, timed from the first');
  expect(o.state([prompt(T), call(T + 1000, 'web_search', undefined, 'server_tool_use')]).open, 0,
    'a server tool, whose result time is not recorded, is never counted as running');
  expect(o.state([prompt(T), call(T + 1000, 'Read', undefined, 'tool_use', { content: 'x' })]).open, 0,
    'a call whose result has arrived is not running, even with no time recorded for it');
  const nested = [prompt(T), call(T + 1000, 'Agent'), prompt(T + 2000, { parentToolUseId: 'a1' }), call(T + 3000, 'Grep', T + 4000)];
  expect(o.state(nested).turnAt, T, "a sub-agent's prompt does not start a new turn");
  expect(o.state(nested).open, 1, 'so the call that started the sub-agent is still running');
  expect(o.state(turn).turnAt, T, 'tool results do not start a new turn either');

  // When it looks at the page at all.
  busy = false; o.paint(); o.paint();
  expect(searches, 0, 'not busy: the page is not searched at all');
  busy = true; prompts = 1; o.paint();
  expect(searches, 0, 'busy but waiting on a permission prompt, which hides the indicator: not searched either');
  prompts = 0; focusOn = false; o.paint();
  expect(searches, 0, 'busy with the tool calls on screen: nothing to add, not searched');
  focusOn = true; off = true; o.paint();
  expect(searches, 0, 'switched off: not searched');
  off = false; o.paint(); o.paint(); o.paint();
  expect(searches, 1, 'busy in Focus view with no indicator found: searched once, then not again within a few seconds');

  // Where the indicator is drawn: two rows the panel can draw it in, found by the words a screen reader hears.
  let clock = 1e6, pageRows = [];
  const span = (b) => ({ textContent: 'Claude is working', parentElement: b });
  const row = (getSpans) => ({ isConnected: true, querySelectorAll: () => getSpans(), contains: (x) => getSpans().some((s) => s.parentElement === x) });
  let boxB = { isConnected: true }, spansB = [span(boxB)];
  const rowA = row(() => []), rowB = row(() => spansB);
  const box2 = Object.assign({}, box, { out: {}, Date: { now: () => clock },
    document: { querySelector: () => null, querySelectorAll: () => { searches++; return pageRows; } } });
  searches = 0;
  new vm.Script(`(function(){${fragment}\n;out.find = findWorking;})()`, { filename: '88-tool-clock.js' }).runInNewContext(box2);
  const find = box2.out.find;
  pageRows = [rowA];
  expect(find(), null, 'an indicator not yet drawn is not found');
  pageRows = [rowA, rowB]; clock += 1000;
  expect(find() === null && searches === 1, true, 'and the page is not searched again within a few seconds');
  clock += 3000;
  expect(find(), rowB, 'after that it is found in whichever row it is drawn');
  expect(find() === rowB && searches === 2, true, 'and kept: finding it again searches nothing');
  boxB.isConnected = false; boxB = { isConnected: true }; spansB = [span(boxB)];
  expect(find() === rowB && searches === 2, true, 'a new turn draws a new indicator in the same row, found without searching the page');

  const sweep = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '99-sweep.js'), 'utf8');
  if (/setInterval\(function\(\)\{[^\n]*try \{ paintToolClock\(\); \} catch \(e\) \{\}[^\n]*\}, 700\)/.test(sweep)) ok('the label is repainted on the 700ms timer');
  else bad('99-sweep.js no longer calls paintToolClock from its timer, so the label is never drawn');
}

console.log('\na window whose install was replaced by a rebuild of the same version');
{
  const removal = require('../src/removal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-replaced-'));
  const write = (meta) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.8', ...(meta ? { __metadata: meta } : {}) }));
  write({ installedTimestamp: 1000 });
  const loaded = removal.installStamp(dir);
  const cases = [
    [loaded === 1000 && removal.replacedSince(dir, loaded) === false, 'the same install: not replaced'],
    [(write({ installedTimestamp: 2000 }), removal.replacedSince(dir, loaded) === true), 'installed again over itself: replaced'],
    [removal.replacedSince(dir, 0) === false, 'no stamp read at start: never counted as replaced'],
    [(write(null), removal.replacedSince(dir, loaded) === false), 'a manifest without install metadata: not replaced'],
    [removal.replacedSince(path.join(dir, 'gone'), loaded) === false && removal.installStamp(path.join(dir, 'gone')) === 0,
      'a manifest that cannot be read: not replaced, and no stamp'],
  ];
  for (const [good, label] of cases) (good ? ok : bad)(label);
  fs.rmSync(dir, { recursive: true, force: true });
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const guarded = [
    ['writing the live stylesheet', /const writeLiveNow = \(\) => \{\s*if \(removed\(\) \|\| uninstalling\(\) \|\| replaced\(\)\) return;/],
    ['patching or restoring', /async function sync\([^)]*\) \{\s*if \(replaced\(\)\) \{/],
    ['the timed refresh', /if \(removed\(\) \|\| !enabled\(\) \|\| uninstalling\(\) \|\| replaced\(\)\) \{ unwatchEffort\(\); return; \}\s*scanBackground\(\);/],
    ['the efforts beside the panel', /if \(!r \|\| !r\.css \|\| removed\(\) \|\| uninstalling\(\) \|\| replaced\(\)\) return;\s*for \(const dir of installs\(webview\)\) webview\.writeEffort/],
    ['the record of background sessions', /const scanBackground = \(\) => \{\s*if \(removed\(\) \|\| !enabled\(\) \|\| uninstalling\(\) \|\| replaced\(\) \|\|/],
  ];
  const missing = guarded.filter(([, re]) => !re.test(ext)).map(([what]) => what);
  if (!missing.length) ok('a replaced window writes nothing shared: ' + guarded.map(([what]) => what).join(', '));
  else bad('not guarded against a replaced install: ' + missing.join(', '));
}

/* A window still running an older version after a newer one was installed beside it: its folder is marked for deletion
   and the other version's is not. It is neither uninstalling nor reinstalled over, and if it kept syncing it would
   treat the newer marker as outdated, patch both bundles back to its own edits on any settings or extensions change,
   and fight every reloaded window. It counts as replaced. */
console.log('\na window still running a version that another one has replaced');
{
  const removal = require('../src/removal');
  const ID = 'xnervwang.claude-code-plus';
  const old = ID + '-1.0.17', next = ID + '-1.0.18';
  const stage = (folders, marked, stamp) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-standing-'));
    for (const f of folders) {
      fs.mkdirSync(path.join(dir, f));
      fs.writeFileSync(path.join(dir, f, 'package.json'), JSON.stringify({ name: 'x', __metadata: { installedTimestamp: stamp || 1000 } }));
    }
    fs.writeFileSync(path.join(dir, '.obsolete'), JSON.stringify(Object.fromEntries(marked.map((m) => [m, true]))));
    return dir;
  };
  const cases = [
    ['a newer version installed beside it, its own folder marked: replaced', [old, next], [old], 1000, 'replaced'],
    ['an older version installed in its place, its own folder marked: replaced', [next, old], [next], 1000, 'replaced', next],
    ['its own folder marked and no other version left: being uninstalled', [old], [old], 1000, 'uninstalling'],
    ['the same version installed again over it: replaced', [old], [], 2000, 'replaced'],
    ['nothing marked and the same install: neither', [old, next], [], 1000, ''],
  ];
  for (const [what, folders, marked, stamp, want, mine] of cases) {
    const dir = stage(folders, marked, stamp);
    const got = removal.standing(path.join(dir, mine || old), ID, 1000);
    (got === want ? ok : bad)(got === want ? what : `${what}: said ${JSON.stringify(got)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  /* Claude Code's folders: a sibling marked for deletion is not patched, since nobody runs it, but the folder this
     window runs from is, whatever its mark; removing the patch still covers every folder. */
  const dirs = ['/x/anthropic.claude-code-2.1.311', '/x/anthropic.claude-code-2.1.312', '/x/anthropic.claude-code-2.1.313'];
  const marked = { 'anthropic.claude-code-2.1.311': true, 'anthropic.claude-code-2.1.312': true };
  const got = removal.unmarked(dirs, dirs[1], marked);
  if (JSON.stringify(got) === JSON.stringify(dirs.slice(1))) ok('a Claude Code folder marked for deletion is left unpatched, unless it is the one this window runs');
  else bad(`the installs to patch were ${JSON.stringify(got)}`);
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  if (/const replaced = \(\) => standing\(\) === 'replaced';/.test(ext) && /removal\.standing\(context\.extensionPath, ID, loadedStamp/.test(ext)
    && /return all \? found : removal\.unmarked\(found, ext\.extensionPath, markedIn\(root\)\);/.test(ext)
    && /for \(const dir of installs\(adapter, restoring\)\)/.test(ext)) {
    ok('the extension takes a replaced build from that one reading, patches no marked sibling, and restores every one');
  } else bad('extension.js does not take replaced from removal.standing, or still patches the marked siblings');
}

/* Costs of a tick and of a settings change, checked against the source since measuring them needs the editor. Each is
   small but adds up: two half-minute timers doing similar work, four settings listeners, the marks and the manifest
   reread three or four times per tick, a couple of dozen settings copies per tick, the live stylesheet's options
   computed per bundle though only the panel's uses them, and a colour change rereading ten megabytes of bundles. */
console.log('\nwhat a tick and a change of setting cost');
{
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const count = (re) => (ext.match(re) || []).length;
  const listener = (/context\.subscriptions\.push\(vscode\.workspace\.onDidChangeConfiguration\(\(e\) => \{([\s\S]*?)\n  \}\)\);/.exec(ext) || [])[1] || '';
  const checks = [
    ['one listener on the settings', count(/onDidChangeConfiguration\(/g) === 1],
    ['one half-minute timer', count(/setInterval\([^\n]*REFRESH_MS\)|\}, REFRESH_MS\);/g) === 1],
    ['the settings read once until they change', /const cfg = \(\) => settings \|\| \(settings = vscode\.workspace\.getConfiguration\(\)\);/.test(ext)
      && /^\s*settings = null;/.test(listener)],
    ['where this build stands read once per turn', /const standing = perTick\(/.test(ext) && !/removal\.(beingUninstalled|replacedSince)\(context/.test(ext)],
    ['the live options worked out once per sync, for the panel only', /adapter\.apply\(dir, adapter === webview \? \(opts \|\| \(opts = options\(\)\)\) : undefined\)/.test(ext)],
    ['a setting of the panel\'s writes the stylesheet and nothing more', /writeLiveNow\(\);\s*$/.test(listener) && !/sync\(/.test(listener)],
    ['a patch already in is told by the adapter\'s answer, not its words', /else if \(!r\.changed && !r\.current\)/.test(ext) && !/'already patched'/.test(ext)],
  ];
  for (const [what, pass] of checks) (pass ? ok : bad)(what);

  /* Host side: a backup carrying its own patch is reported as such, not as "already patched", which would leave the
     bundle outdated without a warning. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-current-'));
  try {
    fs.writeFileSync(host.hostFile(dir), host.ANY_MARK + '1-000000000000 */\nold');
    fs.writeFileSync(host.hostFile(dir) + host.BACKUP_SUFFIX, host.ANY_MARK + '0-000000000000 */\nolder');
    const both = host.apply(dir);
    fs.writeFileSync(host.hostFile(dir), host.MARK + '\nnew');
    const now = host.apply(dir);
    if (!both.changed && both.current === false && both.message !== 'already patched' && now.current === true && !now.changed) {
      ok('a host bundle whose backup is patched too is reported, and one already carrying this patch says so in a field');
    } else bad(`with both patched: ${JSON.stringify(both)}; with this patch in: ${JSON.stringify(now)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // The panel's adapter answers the same way.
  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-current-panel-'));
  try {
    const file = webview.webviewFile(wdir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, webview.ANY_MARK + '1-000000000000 */\nold');
    fs.writeFileSync(file + webview.BACKUP_SUFFIX, webview.ANY_MARK + '0-000000000000 */\nolder');
    const both = webview.apply(wdir, {});
    fs.writeFileSync(file, 'x\n' + webview.MARK + '\nnew');
    const now = webview.apply(wdir, {});
    if (!both.changed && both.current === false && both.message !== 'already patched' && now.current === true && !now.changed) {
      ok('a panel bundle whose backup is patched too is reported, and one already carrying this patch says so in a field');
    } else bad(`panel with both patched: ${JSON.stringify(both)}; with this patch in: ${JSON.stringify(now)}`);
  } finally { fs.rmSync(wdir, { recursive: true, force: true }); }

  /* Nothing else runs extension.js itself, so a name used before its declaration or a throwing hook would only show in
     the editor. This runs it against a stand-in editor API, with a temporary home folder, through activation, a
     settings change, each timer once, the hooks the patched bundles call, an extensions change, and deactivation. */
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-activate-')));
  try {
    const stub = path.join(home, 'vscode-stub.js');
    fs.writeFileSync(stub, `
      const listeners = { config: [], ext: [] }, values = {}, disposable = { dispose() {} };
      class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
      module.exports = { listeners, values, TreeItem, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        ThemeIcon: class {}, ThemeColor: class {}, MarkdownString: class {}, TabInputWebview: class {}, version: '1.120.0',
        StatusBarAlignment: { Left: 1, Right: 2 }, env: { language: 'en' },
        EventEmitter: class { constructor() { this.event = () => disposable; } fire() {} },
        Uri: { file: (p) => ({ fsPath: p }) }, RelativePattern: class {}, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        workspace: { workspaceFolders: [], createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
          getConfiguration: () => ({ get: (k, d) => (k in values ? values[k] : d), inspect: () => undefined, update: async (k, v) => { values[k] = v; } }),
          onDidChangeConfiguration: (fn) => { listeners.config.push(fn); return disposable; },
          onDidChangeWorkspaceFolders: () => disposable },
        window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }), createTreeView: () => ({ dispose() {} }),
          createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }), registerWebviewViewProvider: () => disposable,
          showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, setStatusBarMessage() {},
          tabGroups: { all: [], activeTabGroup: null }, showTextDocument: async () => {} },
        commands: { registerCommand: () => disposable, executeCommand: async () => {} },
        extensions: { getExtension: () => undefined, onDidChange: (fn) => { listeners.ext.push(fn); return disposable; } } };`);
    const root = path.join(__dirname, '..');
    const script = `
      const Module = require('module'), realResolve = Module._resolveFilename, path = require('path'), fs = require('fs');
      Module._resolveFilename = function (request, ...rest) { return request === 'vscode' ? ${JSON.stringify(stub)} : realResolve.call(this, request, ...rest); };
      const vs = require(${JSON.stringify(stub)});
      const ext = require(${JSON.stringify(path.join(root, 'extension.js'))});
      const store = path.join(${JSON.stringify(home)}, 'storage');
      fs.mkdirSync(store, { recursive: true });
      const memo = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); } }; };
      const subs = [], timers = [], keep = setInterval;
      global.setInterval = (fn, ms) => { timers.push({ fn, ms }); return keep(() => {}, 1 << 30); };
      const SID = 'abababab-1111-4222-8333-444444444444';
      (async () => {
        const out = { threw: '' };
        try {
          await ext.activate({ subscriptions: subs, extensionPath: ${JSON.stringify(root)}, globalState: memo(), workspaceState: memo(),
            extension: { id: 'x.y', packageJSON: require(${JSON.stringify(path.join(root, 'package.json'))}) },
            globalStorageUri: { fsPath: store }, logUri: { fsPath: path.join(store, 'logs', 'exthost1', 'x.y') } });
          out.listeners = vs.listeners.config.length;
          out.timers = timers.map((t) => t.ms).sort((a, b) => a - b);
          for (const fn of vs.listeners.config) fn({ affectsConfiguration: () => true });
          for (const t of timers) t.fn();
          globalThis.__cceActiveChat = SID;
          globalThis.__cceChatHook();
          globalThis.__ccePinHook(SID, true);
          globalThis.__cceDeleteHook([{ id: SID, title: 't' }]);
          globalThis.__cceClosedHook(SID);
          out.recent = globalThis.__cceRecentClosed().ids;
          await new Promise((r) => setTimeout(r, 200));
          for (const fn of vs.listeners.ext) await fn();
          ext.deactivate();
        } catch (e) { out.threw = String(e && e.stack); }
        for (const s of subs) { try { s.dispose(); } catch (e) { out.threw = out.threw || 'dispose: ' + e.message; } }
        process.stdout.write(JSON.stringify(out));
        process.exit(0);
      })();
      process.on('unhandledRejection', (e) => { process.stdout.write(JSON.stringify({ threw: 'unhandled: ' + (e && e.stack) })); process.exit(0); });`;
    let r;
    const env = Object.assign({}, process.env, { HOME: home });
    delete env.CLAUDE_CONFIG_DIR;
    try { r = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000, env })); }
    catch (e) { r = { threw: e.message }; }
    if (!r.threw && r.listeners === 1 && JSON.stringify(r.timers) === JSON.stringify([1000, 10000, 30000, 1800000]) && JSON.stringify(r.recent) === JSON.stringify(['abababab-1111-4222-8333-444444444444'])) {
      ok('activation, a change of setting, every timer, the hooks and deactivation run against a stand-in editor without throwing');
    } else bad(`against a stand-in editor: ${JSON.stringify(r).slice(0, 600)}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

/* ── 24. a panel whose bundle never arrives says so ──
   The watch runs inline in the panel's HTML, ahead of the panel's stylesheet (src/panel-load-watch.js says why). Two
   things are checked against a fake page whose clock the test drives. It must never break the panel it watches: the
   bundle asks for its message handle as it starts, and the editor throws on a second request. And it has to speak only
   when there is something to say, in a form Claude Code writes into its log verbatim. */
console.log('\na panel whose bundle never arrives says so');
{
  const { applyEdits } = require('../src/edits');
  const JS = 'https://file+.vscode-resource.vscode-cdn.net/x/webview/index.js?v=1';
  const CSS = 'https://file+.vscode-resource.vscode-cdn.net/x/webview/index.css';
  /* opts.answers: the panel's service worker carries the diagnostic edit and answers what it has in hand. */
  const page = (opts = {}) => {
    let now = 1000000;
    const timers = [], sent = [], images = [], swListeners = [];
    const listeners = { load: [], error: [] };
    let acquired = 0;
    const handle = { postMessage: (m) => sent.push(m) };
    const controller = 'controller' in opts ? opts.controller : {
      state: 'activated',
      postMessage: (m) => {
        if (!opts.answers || !m || m.channel !== 'cce-status') return;
        const reply = { data: { channel: 'cce-status', nonce: m.nonce, data: 'self=activated@x inflight=1' } };
        swListeners.slice().forEach((fn) => fn(reply));
      },
    };
    const env = {
      Date: { now: () => now },
      setTimeout: (fn, ms) => { timers.push({ due: now + ms, fn, live: true }); return timers.length; },
      clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
      performance: { getEntriesByType: () => (opts.entries || []), now: () => 42 },
      navigator: { serviceWorker: {
        controller,
        ready: new Promise(() => {}),
        startMessages: () => {},
        addEventListener: (type, fn) => { if (type === 'message') swListeners.push(fn); },
        removeEventListener: (type, fn) => { const i = swListeners.indexOf(fn); if (i >= 0) swListeners.splice(i, 1); },
      } },
      document: {
        hidden: false,
        addEventListener: (type, fn, capture) => { if (capture && listeners[type]) listeners[type].push(fn); },
        querySelector: () => ({ href: CSS }),
      },
      Image: function () { images.push(this); },
      acquireVsCodeApi: () => {
        if (acquired++) throw new Error('An instance of the VS Code API has already been acquired');
        return handle;
      },
    };
    env.window = env;
    vm.createContext(env);
    vm.runInContext(host.LOAD_WATCH, env, { filename: 'panel-load-watch.js' });
    // The placement flags, as the panel's own script further down sets them once it gets to run.
    if (opts.flags !== false) env.IS_SIDEBAR = false;
    const fire = (type, url) => listeners[type].forEach((fn) => fn({ target: { src: url } }));
    const advance = (ms) => {
      const end = now + ms;
      for (;;) {
        const t = timers.filter((x) => x.live && x.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!t) break;
        now = t.due; t.live = false; t.fn();
      }
      now = end;
    };
    /* The bundle's own request for the handle, as it makes it when it starts. */
    const bundleAcquires = () => { try { return env.acquireVsCodeApi() === handle; } catch (e) { return false; } };
    return { sent, images, fire, advance, bundleAcquires, env, swListeners };
  };
  const texts = (p) => p.sent.map((m) => m.requestId).filter((t) => !/^start /.test(t));

  {
    /* The one line every panel sends, as soon as it runs: the time it is logged at is the measurement. The flags it
       reports come from a later script, which may not have run yet. */
    const early = page({ flags: false });
    early.advance(0);
    const p = page();
    p.env.IS_SIDEBAR = true;
    p.advance(0);
    const a = early.sent.map((m) => m.requestId), b = p.sent.map((m) => m.requestId);
    if (a.length === 1 && /^start frame=42ms after=0ms in=\? js=pending /.test(a[0])
      && b.length === 1 && / in=sidebar /.test(b[0]) && !/worker\{/.test(b[0])) {
      ok('a panel reports once as it starts, without waiting on the worker, and says when it cannot tell where it is');
    } else bad(`the start report: ${JSON.stringify([a, b])}`);
  }
  {
    const p = page();
    p.advance(500); p.fire('load', CSS); p.fire('load', JS); p.advance(700000);
    if (!texts(p).length && p.sent.length === 1 && !p.images.length && !p.swListeners.length) {
      ok('a panel that opens in time sends nothing beyond that, asks the worker nothing and asks for nothing extra');
    } else bad(`a panel that opened in 0.5 s still reported: ${JSON.stringify(p.sent.map((m) => m.requestId))}`);
    if (p.bundleAcquires() && p.bundleAcquires()) ok('the bundle gets its handle, and asking again does not throw');
    else bad('the bundle could not get its message handle with the watch in place');
  }
  {
    const p = page();
    p.advance(4000); p.fire('load', JS); p.advance(700000);
    const t = texts(p);
    if (t.length === 1 && /^slow js\[/.test(t[0]) && / js=ok@4000ms /.test(t[0])) ok('a bundle 4 s late is reported once, as slow');
    else bad(`a 4 s bundle reported as ${JSON.stringify(t)}`);
  }
  {
    /* A stock worker ignores the question, so each report goes two seconds later and says it got no answer - but it is
       dated when the check fired. */
    const p = page();
    p.advance(15000);
    if (texts(p).length === 0) ok('a report waits for the worker\'s answer rather than going without it');
    else bad(`reported before the worker had its two seconds: ${JSON.stringify(texts(p))}`);
    p.advance(2000);
    let t = texts(p);
    if (t.length === 1 && /^stuck after=15000ms in=tab js=pending css=pending sw=activated /.test(t[0])
      && / fresh=pending worker\{no-answer\}$/.test(t[0])) {
      ok('a bundle still missing at 15 s is reported, with a fresh request unanswered and a worker that does not answer');
    } else bad(`at 17 s: ${JSON.stringify(t)}`);
    if (p.images.length === 1 && /\/webview\/index\.css\?cce-fresh=\d+$/.test(p.images[0].src)) ok('the fresh request is one, for the stylesheet, made from scratch');
    else bad(`fresh requests: ${JSON.stringify(p.images.map((i) => i.src))}`);
    p.advance(700000 - 17000);
    t = texts(p);
    const at = t.map((x) => (x.match(/after=(\d+)ms/) || [])[1]);
    if (JSON.stringify(at) === JSON.stringify(['15000', '60000', '300000', '600000'])) ok('a bundle that never comes is reported at 15 s, 1, 5 and 10 minutes, and then no more');
    else bad(`a missing bundle was reported at ${JSON.stringify(at)}`);
    p.fire('load', JS); p.advance(2000);
    t = texts(p);
    if (t.length === 5 && /^arrived js\[/.test(t[4])) ok('when it does come after all, that is reported too');
    else bad(`after arriving at last: ${JSON.stringify(t.slice(4))}`);
    if (p.bundleAcquires()) ok('a bundle that starts after the watch has reported still gets the same handle');
    else bad('the watch took the handle the late bundle needed');
    if (!p.swListeners.length) ok('every question to the worker is withdrawn once answered or given up on');
    else bad(`${p.swListeners.length} listeners for the worker's answer left behind`);
  }
  {
    /* The request made from scratch is for the stylesheet as well; its timing entry must not pass for the panel's own. */
    const p = page({ entries: [{ name: CSS + '?cce-fresh=1', startTime: 10000, responseStart: 10002, responseEnd: 10003 }] });
    p.advance(17000);
    const t = texts(p);
    if (t.length === 1 && / css=pending /.test(t[0])) ok('the fresh request\'s answer is not taken for the stylesheet arriving');
    else bad(`with only the fresh request answered: ${JSON.stringify(t)}`);
  }
  {
    const p = page({ answers: true });
    p.advance(15000);
    const t = texts(p);
    if (t.length === 1 && / worker\{self=activated@x inflight=1\}$/.test(t[0])) ok('a worker carrying the diagnostic edit has its answer in the report at once');
    else bad(`with an answering worker: ${JSON.stringify(t)}`);
  }
  {
    const p = page();
    p.advance(12000); p.images[0].onerror(); p.advance(5000);
    const t = texts(p);
    if (t.length === 1 && / fresh=answered@2000ms /.test(t[0])) ok('a fresh request that is answered says so, with how long it took');
    else bad(`with the fresh request answered: ${JSON.stringify(t)}`);
  }
  {
    const p = page({ entries: [{ name: CSS, startTime: 10, responseStart: 14, responseEnd: 15 }] });
    p.advance(17000);
    const t = texts(p);
    if (t.length === 1 && / css=ok@before-watch /.test(t[0])) ok('a stylesheet whose load was missed is still not reported as pending');
    else bad(`with the stylesheet already in: ${JSON.stringify(t)}`);
  }
  {
    const p = page({ controller: null });
    p.advance(2000); p.fire('error', JS); p.advance(700000);
    const t = texts(p);
    if (t.length === 1 && /^failed js\[/.test(t[0]) && / sw=none /.test(t[0]) && / worker\{-\}$/.test(t[0])) {
      ok('a bundle that fails is reported once, and a page no service worker controls says so');
    } else bad(`a failed bundle on an uncontrolled page: ${JSON.stringify(t)}`);
  }
  {
    /* Claude Code logs a message's type when it is a short lowercase name and its requestId as it is, and reduces every
       other field to a type name - so the whole report has to be the request id. */
    const p = page();
    p.advance(17000);
    const m = p.sent[1] || {};
    if (/^[a-z][a-z0-9_]{0,63}$/.test(m.type) && typeof m.requestId === 'string' && Object.keys(m).length === 2) {
      ok('the report is a known-safe type and a string request id, the two fields Claude Code logs verbatim');
    } else bad(`report shape: ${JSON.stringify(m)}`);
  }

  /* Where the edit puts it, and the setting that keeps it out. */
  const edit = host.EDITS.find((e) => e.name === 'panel load watch');
  const tpl = 'return`<head>\n        <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-${U}\'; ${j};">\n\n'
    + '        <meta name="viewport" content="width=device-width, initial-scale=1.0">\n        <link href="${K}" rel="stylesheet">\n'
    + '      </head><body>\n        <script nonce="${U}">\n          window.IS_SIDEBAR = ${X?"true":"false"}\n        </script>\n      </body>`';
  const r = edit ? applyEdits(tpl, [edit]) : { error: 'no such edit' };
  if (r.error) bad('the panel load watch edit did not apply to the template shape: ' + r.error);
  else {
    const html = new Function('U', 'K', 'X', 'j', r.out);
    delete globalThis[host.LOAD_WATCH_OFF];
    const on = html('n0nce', 'style.css', false, 'worker-src x');
    const watch = '<script nonce="n0nce">' + host.LOAD_WATCH + '</script>';
    const i = on.indexOf(watch), csp = on.indexOf('Content-Security-Policy'), link = on.indexOf('<link href="style.css"');
    if (i > csp && csp >= 0 && on.slice(i + watch.length).startsWith('<link href="style.css" rel="stylesheet">') && link > i) {
      ok('the watch goes into the panel\'s HTML word for word, with its nonce, after the policy and just ahead of the stylesheet');
    } else bad('the watch is not where it should be in the generated HTML');
    const zone = '<script nonce="n0nce">' + host.PANEL_TZ + '</script>';
    const z = on.indexOf(zone);
    if (z > csp && z < i) ok('the time zone report goes in after the policy and ahead of the watch, with the same nonce');
    else bad('the time zone report is not between the policy and the watch in the generated HTML');
    /* The resource-cache clearing that builds up to 1.0.8 needed is gone with them; none of it runs in any panel. */
    if (!/resourceCacheCleared|caches\.keys/.test(on) && !('CACHE_CLEAR' in host)
      && !fs.existsSync(path.join(__dirname, '..', 'src', 'panel-cache-clear.js'))) {
      ok('the panel\'s HTML no longer carries the one-off clearing of the resource cache');
    } else bad('the one-off clearing of the resource cache is still put into every panel');
    globalThis[host.LOAD_WATCH_OFF] = true;
    const off = html('n0nce', 'style.css', false, 'worker-src x');
    delete globalThis[host.LOAD_WATCH_OFF];
    const own = new Function('U', 'K', 'X', 'j', tpl)('n0nce', 'style.css', false, 'worker-src x');
    if (off.replace(zone, '') === own && off.includes(zone)) {
      ok('with the recording turned off the HTML is Claude Code\'s own plus the time zone report, which is not behind that setting');
    } else bad('with the recording turned off the HTML is not Claude Code\'s own plus the time zone report');
  }
  /* The panel's time zone: sent once from the panel, kept by the patched host, read by this extension. */
  {
    const posted = [];
    let made = 0;
    const handle = { postMessage: (m) => posted.push(m) };
    const env = { acquireVsCodeApi: () => { made++; return handle; } };
    env.globalThis = env;
    vm.createContext(env);
    vm.runInContext(host.PANEL_TZ, env, { filename: 'panel-tz.js' });
    const later = env.acquireVsCodeApi();
    const m = posted[0] || {};
    if (posted.length === 1 && m.type === 'cce_client_tz' && typeof m.timeZone === 'string' && m.timeZone) {
      ok('the panel sends its time zone once, as it starts');
    } else bad(`the panel sent ${JSON.stringify(posted)}`);
    if (later === handle && made === 1) ok('and the panel\'s own bundle still gets the one handle the editor allows');
    else bad(`the bundle got ${later === handle ? 'the same' : 'another'} handle, the editor was asked ${made} time(s)`);
  }
  {
    const edit = host.EDITS.find((e) => e.name === 'panel messages');
    const fn = 'function eT($,J){let Q=`Received message from webview: ${bl0(J)}`;$.info(Q)}';
    const r = edit ? applyEdits(fn, [edit]) : { error: 'no such edit' };
    if (r.error) bad('the panel messages edit did not apply to the logging function\'s shape: ' + r.error);
    else {
      const heard = [], pins = [];
      const env = { bl0: (m) => JSON.stringify(m), out: null };
      env.globalThis = env;
      env.__cceTzHook = (z) => heard.push(z);
      vm.createContext(env);
      vm.runInContext(r.out + ';eT({info:(q)=>out=q},{type:"other"});var a=globalThis.__cceClientTimeZone;'
        + 'eT({info:(q)=>out=q},{type:"cce_client_tz",timeZone:"America/Los_Angeles"});', env);
      if (env.a === undefined && env.__cceClientTimeZone === 'America/Los_Angeles' && JSON.stringify(heard) === '["America/Los_Angeles"]'
        && /^Received message from webview: /.test(env.out)) {
        ok('the patched host keeps the zone a panel reports, calls this extension, and still logs the message');
      } else bad(`after the time zone message: kept ${env.__cceClientTimeZone}, heard ${JSON.stringify(heard)}, logged ${env.out}`);
      env.out = null;
      vm.runInContext('eT({info:(q)=>out=q},{type:"cce_session_pin",sessionId:"s1",pinned:true});', env);
      const unheard = env.out;
      env.__ccePinHook = (id, on) => pins.push([id, on]);
      vm.runInContext('eT({info:(q)=>out=q},{type:"cce_session_pin",sessionId:"s1",pinned:true});'
        + 'eT({info:(q)=>out=q},{type:"cce_session_pin",sessionId:"s2",pinned:"yes"});'
        + 'eT({info:(q)=>out=q},{type:"cce_session_pin",sessionId:7,pinned:true});'
        + 'eT({info:(q)=>out=q},{type:"cce_client_tz",timeZone:"Asia/Tokyo"});', env);
      if (JSON.stringify(pins) === '[["s1",true],["s2",false]]' && /^Received message from webview: /.test(unheard)
        && JSON.stringify(heard) === '["America/Los_Angeles","Asia/Tokyo"]') {
        ok('a pin from the session list reaches this extension as an id and a yes or no, and the zone is still kept');
      } else bad(`after the pin messages: heard pins ${JSON.stringify(pins)}, zones ${JSON.stringify(heard)}, logged without a hook: ${unheard}`);
    }
  }
  /* The colour of a tab's icon: the host hands over the state it picked the icon for and the conversation's state, and
     this extension swaps the icon for the logo in that state's colour, made from the logo the host just set. */
  {
    const tabdot = require('../src/tabdot');
    const states = [['pending', 'running'], ['pending', 'idle'], ['plain', 'running'], ['done', 'idle'], ['plain', 'idle'],
      ['plain', undefined], ['done', 'waiting_input']].map(([i, r]) => tabdot.stateOf(i, r));
    if (JSON.stringify(states) === JSON.stringify(['waiting', 'waiting', 'running', 'unread', 'idle', 'idle', 'unread'])) {
      ok('stateOf maps the icon key and session state to waiting, running, unread or idle');
    } else bad(`tab states: ${JSON.stringify(states)}`);

    const waiting = '<svg viewBox="0 0 24 24"><defs><mask id="m"><rect width="24" height="24" fill="white"/>'
      + '<circle cx="19.5" cy="4.5" r="6.5" fill="black"/></mask></defs><path mask="url(#m)" d="M4 4h16v16z" fill="#D97757"/>'
      + '<circle cx="19.5" cy="4.5" r="4.5" fill="#3B82F6"/></svg>';
    const blue = tabdot.withDot(waiting, tabdot.BLUE), green = tabdot.withDot(waiting, tabdot.GREEN), red = tabdot.withDot(waiting, tabdot.RED);
    const grown = (c) => waiting.replace('<circle cx="19.5" cy="4.5" r="6.5" fill="black"/>', '<circle cx="18.5" cy="5.5" r="6.5" fill="black"/>')
      .replace('<circle cx="19.5" cy="4.5" r="4.5" fill="#3B82F6"/>', `<circle cx="18.5" cy="5.5" r="5.5" fill="${c}"/>`);
    if (blue === grown('#3b82f6') && green === grown('#22c55e') && red === grown('#ef4444')
        && tabdot.withDot(waiting.replace('</svg>', '<circle cx="1" cy="1" r="1" fill="#3B82F6"/></svg>'), tabdot.GREEN) === ''
        && tabdot.withDot('<svg/>', tabdot.RED) === '') {
      ok('withDot draws a larger dot in the given colour');
    } else bad(`dots: ${JSON.stringify([blue, green, red])}`);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-tabicon-'));
    const res = path.join(root, 'resources'), out = path.join(root, 'icons');
    fs.mkdirSync(res);
    for (const name of Object.values(tabdot.FILES)) fs.writeFileSync(path.join(res, name), name === tabdot.FILES.waiting ? waiting : '<svg/>');
    const cache = new Map();
    const icons = tabdot.iconsFor(res, out, cache);
    const again = tabdot.iconsFor(res, out, cache);
    if (icons && again === icons && icons.idle === path.join(res, tabdot.FILES.idle)
        && [['waiting', blue], ['running', green], ['unread', red]].every(([st, svg]) => path.dirname(icons[st]) === out
          && fs.readFileSync(icons[st], 'utf8') === svg)
        && tabdot.iconsFor(path.join(root, 'missing'), out, new Map()) === null) {
      ok('iconsFor writes the three dotted icons once');
    } else bad(`tab icons: ${JSON.stringify(icons)}`);
    fs.rmSync(root, { recursive: true, force: true });

    const live = require('../src/webview').liveCss({}), off = require('../src/webview').liveCss({ enabled: false });
    if (live.includes('[class*="sessionItem_"]{--app-status-busy:#22c55e;--app-status-unread:#ef4444;}') && !off.includes('sessionItem_')) {
      ok('the session list\'s running and unread dots turn green and red');
    } else bad('the live stylesheet does not colour the list\'s dots as expected');

    const T = 'Fix the build';
    const titles = tabdot.MARKS.map((m) => tabdot.withoutMark(T + m)).concat([tabdot.withoutMark(T), tabdot.withoutMark(undefined)]);
    if (titles.every((t, i) => t === (i === titles.length - 1 ? '' : T))) {
      ok('withoutMark strips an old mark from a tab title');
    } else bad(`titles: ${JSON.stringify(titles)}`);

    const edit = host.EDITS.find((e) => e.name === 'tab dot');
    const method = 'class T{applyTabIcon(){if(!this.panelTab)return;let $=pick(this.lastRenameTabFlags,this.badge1,'
      + '{isSessionUnread:this.isSessionUnread});'
      + 'this.panelTab.iconPath=N1.Uri.file(z5.join(this.context.extensionPath,"resources",Pa1[$]))}}';
    const r = edit ? applyEdits(method, [edit]) : { error: 'no such edit' };
    if (r.error) bad('the tab dot edit did not apply to the icon method\'s shape: ' + r.error);
    else {
      const heard = [], ours = { f: '/ours/green.svg' };
      const env = { pick: () => 'done', Pa1: { done: 'd.svg' }, N1: { Uri: { file: (f) => ({ f }) } }, z5: { join: (a, b, c) => [a, b, c].join('/') } };
      env.globalThis = env;
      env.__cceTabIcon = (panel, state, run, home, sid) => { heard.push([panel.title, state, run, home, sid]); return run === 'running' ? ours : undefined; };
      vm.createContext(env);
      vm.runInContext(r.out + ';var t=new T();t.panelTab={title:"Fix the build"};t.context={extensionPath:"/x"};t.applyTabIcon();'
        + 'var first=t.panelTab.iconPath.f;t.badge1={state:"running",sessionId:"S1"};t.applyTabIcon();var second=t.panelTab.iconPath;'
        + 'globalThis.__cceTabIcon=function(){throw new Error("x")};t.applyTabIcon();var third=t.panelTab.iconPath.f;', env);
      if (JSON.stringify(heard) === '[["Fix the build","done",null,"/x",null],["Fix the build","done","running","/x","S1"]]'
          && env.first === '/x/resources/d.svg' && env.second === ours && env.third === '/x/resources/d.svg') {
        ok('applyTabIcon falls back to its own icon when the hook gives none');
      } else bad(`after the icon update: heard ${JSON.stringify(heard)}, icons ${env.first} ${JSON.stringify(env.second)} ${env.third}`);
    }
  }
  {
    const edit = host.EDITS.find((e) => e.name === 'tab icon at setup');
    const method = 'class S{setupPanel(e){let a=1,l=V1.Uri.joinPath(this.extensionUri,"resources","claude-logo.svg");'
      + 'e.iconPath={light:l,dark:l},e.ready=!0}}';
    const r = edit ? applyEdits(method, [edit]) : { error: 'no such edit' };
    if (r.error) bad('the tab icon at setup edit did not apply: ' + r.error);
    else {
      const asked = [], ours = { f: '/ours/idle.svg' };
      const env = { V1: { Uri: { joinPath: (u, a, b) => ({ f: [u.fsPath, a, b].join('/') }) } } };
      env.globalThis = env;
      vm.createContext(env);
      vm.runInContext(r.out + ';var s=new S();s.extensionUri={fsPath:"/x"};var p1={};s.setupPanel(p1);'
        + 'globalThis.__cceTabIcon=function(p,st,run,home){asked.push([st,run,home]);return ours};var p2={};s.setupPanel(p2);', Object.assign(env, { asked, ours }));
      if (env.p1.iconPath.light.f === '/x/resources/claude-logo.svg' && env.p1.ready && env.p2.iconPath === ours && env.p2.ready
          && JSON.stringify(asked) === '[["plain",null,"/x"]]') {
        ok('setupPanel starts a tab with the hook\'s idle icon');
      } else bad(`setup icons: ${JSON.stringify([env.p1, env.p2, asked])}`);
    }
  }
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  if (/globalThis\.__cceTzHook = /.test(ext) && /timeZone: \(\) => clientZone\(\),/.test(ext)) {
    ok('the panel\'s time zone reaches both the hooks and timeZone()');
  } else bad('extension.js does not pass on the reported time zone');
  if (/globalThis\.__cceTabIcon = \(panel, state, run, home, sessionId\) =>/.test(ext)
      && /if \(run !== 'running' && bgWorking\.has\(sessionId\)\) run = 'running';/.test(ext)
      && /if \(!enabled\(\) \|\| removed\(\) \|\| typeof home !== 'string'\) return undefined;/.test(ext)
      && /icons\[tabdot\.stateOf\(state, run\)\]/.test(ext) && /panel\.title = title/.test(ext)
      && /if \(!tabIconUris\.has\(file\)\) tabIconUris\.set\(file, vscode\.Uri\.file\(file\)\);/.test(ext)) {
    ok('the hook reuses one Uri per icon file');
  } else bad('extension.js does not handle the tab icon');
  if (/globalThis\[host\.LOAD_WATCH_OFF\] = !cfg\(\)\.get\(LATENCY_ON_SETTING, true\)/.test(ext)
    && /affectsConfiguration\(LATENCY_ON_SETTING\)\) loadWatchOff\(\)/.test(ext)) {
    ok('the latency setting drives the watch, at activation and whenever it changes');
  } else bad('extension.js does not set the watch flag from the latency setting');
}

console.log('\nconversations pinned in the session list');
{
  const { applyEdits } = require('../src/edits');
  const pins = require('../src/sessionpins');
  const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';

  /* The automatic archive skips a session the host counts as in use, and the pinned ones join the set the grouped ones
     are in. Run on the shape of the code that builds the set and the test that reads it. */
  {
    const edit = host.EDITS.find((e) => e.name === 'pinned conversations not archived');
    const code = 'function uG($,J){return J.openSessionIds.has($)||J.groupedSessionKeys.has($)}'
      + 'class S{constructor(g){this.settings={getSessionGroups:()=>g}}arm(){let Y={openSessionIds:new Set(["o"]),'
      + 'groupedSessionKeys:new Set(this.settings.getSessionGroups().flatMap((W)=>W.sessionIds)),liveElsewhereSessionIds:new Set};'
      + 'return(W)=>uG(W,Y)}}';
    const r = edit ? applyEdits(code, [edit]) : { error: 'no such edit' };
    if (r.error) bad('the archive edit did not apply to the shape of the in-use set: ' + r.error);
    else {
      const run = (pinned) => {
        const env = {};
        env.globalThis = env;
        if (pinned !== undefined) env.__ccePinnedIds = pinned;
        vm.createContext(env);
        vm.runInContext(r.out + `;var inUse=new S([{sessionIds:["${B}"]}]).arm();`
          + `var got=["${A}","${B}","${C}","o"].map((x)=>inUse(x));`, env);
        return JSON.stringify(env.got);
      };
      const got = [run(() => [A]), run(undefined), run(() => { throw new Error('x'); }), run(() => 'not a list'), run(() => [A, 5])];
      const want = ['[true,true,false,true]', '[false,true,false,true]', '[false,true,false,true]', '[false,true,false,true]', '[true,true,false,true]'];
      if (JSON.stringify(got) === JSON.stringify(want)) {
        ok('a pinned conversation counts as in use and is not archived; a grouped one still is in use, and one neither pinned nor grouped is not');
        ok('with no pins to read, or a list that throws or is not a list, the set is what Claude Code built');
      } else bad(`in use after the archive edit: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
  }

  /* The pin goes into every row right after the title, where the factory and the row are named, and the title itself is
     left as it was; the time gets the row's id and the panel's relative-time function. */
  {
    const editPin = webview.EDITS.find((e) => e.name === 'session list pin');
    const editTime = webview.EDITS.find((e) => e.name === 'session list time render');
    const row = 'L("button",{className:B5.sessionItem,children:[R&&F(xQ,{state:R}),z?F("span",{ref:b,children:db(J)},"edit")'
      + ':F("span",{className:B5.sessionName,children:vE0(db(J),G)},"view"),w&&J.worktree.value&&F("span",{}),'
      + 'L("span",{className:B5.sessionMeta,children:[F("span",{className:B5.sessionTime,children:O_5(J.lastModifiedTime.value)})]})]})';
    const r = editPin && editTime ? applyEdits(row, [editTime, editPin]) : { error: 'no such edit' };
    if (r.error) bad('the pin and time edits did not both apply to the shape of a row: ' + r.error);
    else if (r.out.includes(':F("span",{className:B5.sessionName,children:vE0(db(J),G)},"view"),'
        + '(typeof window.__ccePin==="function"?window.__ccePin(F,J):null),w&&J.worktree.value')
      && /window\.__cceSpan\(O_5\(J\.lastModifiedTime\.value\),J\.lastModifiedTime\.value,J\.cceCreatedAt,J\.sessionId&&J\.sessionId\.value,O_5\)/.test(r.out)) {
      ok('the pin goes into every row after its title, with the panel\'s own factory, and the time gets the row\'s id and the relative-time function');
    } else bad('after the pin and time edits the row reads: ' + r.out);
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '83-session-pins.js'), 'utf8');
    if (/span\[data-cce-pin\]\{order:-1;/.test(css) && !/sessionActions_/.test(css)) ok('and the page\'s stylesheet moves it to the front of the row, not among the hover buttons');
    else bad('the pin is not moved to the front of the row by the page\'s stylesheet');
  }

  /* The page's half, run on a stand-in for the panel: what a pin is, what clicking it does, and the real time of a
     pinned row. */
  {
    const frag = (n) => fs.readFileSync(path.join(__dirname, '..', 'src', 'page', n), 'utf8');
    const NOW = new Date(2026, 9, 16, 12, 0, 0).getTime(), DAY = 86400000;
    class FixedDate extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
    const pack = (v) => '"' + Buffer.from(JSON.stringify(v), 'utf8').toString('base64') + '"';
    const real = NOW - 120 * DAY, given = NOW - 76 * DAY;
    const env = {
      Date: FixedDate, window: {}, console, Buffer, TextDecoder,
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      prop: '', posted: [], hidden: 0, shown: 0, timers: [], appended: [],
      sessionDates: false,
    };
    env.getComputedStyle = () => ({ getPropertyValue: (n) => (n === '--cce-pins' ? env.prop : '') });
    env.document = { documentElement: {}, createElement: (t) => ({ tag: t, setAttribute() {} }), querySelectorAll: () => env.rows || [] };
    env.head = { appendChild: (el) => env.appended.push(el) };
    env.acquireVsCodeApi = () => ({ postMessage: (m) => env.posted.push(m) });
    env.setTimeout = (f, ms) => { env.timers.push([f, ms]); return env.timers.length; };
    env.showLabel = () => { env.shown++; };
    env.hideLabel = () => { env.hidden++; };
    env.isOff = (k) => (k === 'sessionDates' ? !env.sessionDates : false);
    vm.createContext(env);
    vm.runInContext('var pinsCache = null;' + frag('15-format.js') + frag('82-scheduled-tasks.js') + frag('83-session-pins.js')
      + ';this.reset = function(){ pinsCache = null; propCache = {}; };', env);
    const h = (type, props, key) => ({ type, props, key });
    const rowOf = (id, onDisk = true) => ({ sessionId: { value: id }, transcriptOnDisk: onDisk });
    const draw = (id, onDisk) => env.window.__ccePin(h, rowOf(id, onDisk));
    const set = (v) => { env.prop = v === null ? '' : pack(v); env.reset(); };

    set(null);
    const early = draw(A);
    if (early && early.props['data-cce-pin-off'] === '1') ok('before the stylesheet says pinning is on, a row gets a pin that is hidden, to be shown when it does');
    else bad(`with no pins in the stylesheet the row got ${JSON.stringify(early && early.props)}`);

    set([[A], { [A]: [real, given] }, 14]);
    const pinned = draw(A), plain = draw(B);
    const p = pinned && pinned.props, q = plain && plain.props;
    const okShape = p && q && p.role === 'button' && p.tabIndex === 0
      && p['data-cce-pin'] === A && p['data-cce-pin-off'] === undefined && pinned.key === 'cce-pin'
      && p.children[0].type === 'svg' && p.children[0].props.children[0].props['data-cce-pin-body'] === '1';
    if (okShape) ok('a pin is a keyed button with its icon inside, the part that fills when pinned marked');
    else bad(`the pin was drawn as ${JSON.stringify(p)}`);
    if (p && q && p['data-cce-pinned'] === '1' && p['aria-pressed'] === 'true' && q['data-cce-pinned'] === '0' && q['aria-pressed'] === 'false') {
      ok('a pinned row and an unpinned one carry different states');
    } else bad(`pinned state ${p && p['data-cce-pinned']}, unpinned state ${q && q['data-cce-pinned']}`);
    const label = (p && p['aria-label']) || '', other = (q && q['aria-label']) || '';
    if (/^Pin this conversation/.test(other) && /transcript cleanup will then not delete it/.test(other) && /Archived sessions/.test(other)
      && !/Unpin|within/.test(other)) {
      ok('over a pin not yet pinned, the hover text says what pinning does: not deleted by the cleanup, not moved to Archived sessions');
    } else bad(`hover text before pinning: "${other}"`);
    if (/^Unpin this conversation/.test(label) && /cleaned up and archived as usual again/.test(label)
      && /moved to Archived sessions straight away and deleted within about 14 days/.test(label) && !/^Pin /.test(label)) {
      ok('over a pinned one already kept past its age, it says what unpinning does: archived at once and deleted within about 14 days unless used');
    } else bad(`hover text of a pinned row kept past its age: "${label}"`);
    if (draw(C, false) === null && env.window.__ccePin(h, { sessionId: { value: 'remote:1' }, transcriptOnDisk: true }) === null) {
      ok('no pin on a row with no transcript on disk, or one whose id is not a session id');
    } else bad('a row with nothing on disk to keep got a pin');

    let stopped = 0;
    const target = { attrs: {}, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, hasAttribute(k) { return k in this.attrs; }, removeAttribute(k) { delete this.attrs[k]; } };
    const copyOf = (id) => ({ attrs: { 'data-cce-pin': id, 'data-cce-pinned': '0' }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, hasAttribute(k) { return k in this.attrs; }, removeAttribute(k) { delete this.attrs[k]; } });
    const sameB = copyOf(B), otherA = copyOf(A);
    env.rows = [sameB, otherA];
    q.onClick({ stopPropagation: () => { stopped++; }, currentTarget: target });
    env.rows = undefined;
    if (sameB.attrs['data-cce-pinned'] === '1' && otherA.attrs['data-cce-pinned'] === '0') {
      ok('a click repaints every copy of that conversation\'s pin, as OPEN SESSIONS draws the same row as the list, and leaves the others alone');
    } else bad(`after the click, the other copy of the pin read ${sameB.attrs['data-cce-pinned']} and another conversation's ${otherA.attrs['data-cce-pinned']}`);
    const sent = env.posted[0] || {};
    if (stopped === 1 && sent.type === 'cce_session_pin' && sent.sessionId === B && sent.pinned === true && target.attrs['data-cce-pinned'] === '1'
      && /^Unpin this conversation/.test(target.attrs['aria-label'] || '') && env.hidden > 0) {
      ok('clicking a pin stops the click reaching the row, tells the host, and shows it pinned at once, its hover text now about unpinning');
    } else bad(`after clicking: stopped ${stopped}, sent ${JSON.stringify(env.posted)}, attributes ${JSON.stringify(target.attrs)}`);
    const again = draw(B);
    if (again && again.props['data-cce-pinned'] === '1') ok('until the host answers, the row is drawn as the click left it');
    else bad('drawn again before the host answered, the row lost the click');
    let keyed = 0;
    p.onKeyDown({ key: 'Enter', preventDefault: () => { keyed++; }, stopPropagation: () => { keyed++; }, currentTarget: target });
    const sent2 = env.posted[1] || {};
    if (keyed === 2 && sent2.sessionId === A && sent2.pinned === false) ok('Enter on a pin unpins it, and goes no further than the pin');
    else bad(`after Enter: ${keyed} calls stopped, sent ${JSON.stringify(env.posted)}`);

    const spanOf = (last, id) => env.window.__cceSpan('rel', last, real - DAY, id, (ms) => 'rel(' + Math.round((NOW - ms) / DAY) + 'd)');
    env.sessionDates = true;
    const withDates = spanOf(given + 500, A);
    env.sessionDates = false;
    const without = spanOf(given + 500, A);
    const written = spanOf(NOW - 60000, A);
    const unrecorded = spanOf(given, B);
    const md = (ms) => { const d = new Date(ms); return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0'); };
    if (withDates === `rel(120d) · ${md(real - DAY)}→${md(real)}` && without === 'rel(120d)') {
      ok('a pinned row whose file was given a later time shows when it was really last active, with the dates on and with them off');
    } else bad(`a pinned row's time read "${withDates}" with the dates on and "${without}" with them off`);
    if (written === 'rel' && unrecorded === 'rel') ok('once somebody writes to it, or for a row with no record, the list\'s own time stands');
    else bad(`after a write the row read "${written}", and one without a record "${unrecorded}"`);

    const rows = [target];
    target.attrs['data-cce-pin'] = B;
    env.rows = rows;
    set(null);
    vm.runInContext('repaintPins()', env);
    if (target.attrs['data-cce-pin-off'] === '1') ok('a stylesheet with pinning off hides the pins already drawn');
    else bad('pinning was turned off and the pins drawn stayed');
    set([[A, B], {}, 5]);
    vm.runInContext('repaintPins()', env);
    const fresh = target.attrs['aria-label'];
    set([[A, B], { [B]: [real, given] }, 5]);
    vm.runInContext('repaintPins()', env);
    if (!('data-cce-pin-off' in target.attrs) && target.attrs['data-cce-pinned'] === '1'
      && /once it has been left unused long enough\.$/.test(fresh) && /within about 5 days\.$/.test(target.attrs['aria-label'])) {
      ok('and turning it on again shows them, in the state the stylesheet carries; unpinning one never kept past its age is said to change nothing yet, and one that was, with the margin carried');
    } else bad(`after pinning came back the pin read ${JSON.stringify(target.attrs)}, before its record "${fresh}"`);
  }

  /* The host's half: the file of pins, the margin, and what goes into the stylesheet. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-pins-'));
  try {
    const f = (name, v) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(v)); return p; };
    const days = [pins.retentionDays([f('u.json', { cleanupPeriodDays: 90 }), f('m.json', { cleanupPeriodDays: 60 })]),
      pins.retentionDays([path.join(tmp, 'missing.json')]),
      pins.retentionDays([f('z.json', { cleanupPeriodDays: 0 }), f('s.json', { cleanupPeriodDays: '7' }), f('k.json', { cleanupPeriodDays: 45 })])];
    if (JSON.stringify(days) === '[60,30,45]') ok('the retention is the smallest one set, 30 days when none is, and only a whole number of days counts');
    else bad(`retention read as ${JSON.stringify(days)}`);

    const file = path.join(tmp, 'store', pins.FILE);
    const steps = [pins.setPinned(file, A, true), pins.setPinned(file, A, true), pins.setPinned(file, B, true),
      pins.setPinned(file, 'not-a-session', true), pins.setPinned(file, A, false)];
    const after = pins.read(file);
    if (JSON.stringify(steps) === '[true,false,true,false,true]' && JSON.stringify(after.pinned) === JSON.stringify([B])
      && !fs.readdirSync(path.dirname(file)).some((n) => n.endsWith('.tmp'))) {
      ok('pinning and unpinning are written to the file at once, a repeat changes nothing, and only session ids are pinned');
    } else bad(`pins after the steps: ${JSON.stringify(steps)} -> ${JSON.stringify(after)}`);
    fs.writeFileSync(file, JSON.stringify({ pinned: [A, A, 'x', 3], times: { [A]: { real: 1, set: 2 }, [B]: { real: 'x', set: 2 }, y: { real: 1, set: 2 } } }));
    const messy = pins.read(file);
    fs.writeFileSync(file, '{ not json');
    const broken = pins.read(file);
    if (JSON.stringify(messy) === JSON.stringify({ pinned: [A], times: { [A]: { real: 1, set: 2 } } })
      && JSON.stringify(broken) === '{"pinned":[],"times":{}}') {
      ok('a pins file with duplicates or malformed entries keeps only what is sound, and an unreadable one reads as no pins');
    } else bad(`read back ${JSON.stringify(messy)} and ${JSON.stringify(broken)}`);

    fs.writeFileSync(file, JSON.stringify({ pinned: [A, B, C], times: { [A]: { real: 1, set: 2 }, [D]: { real: 3, set: 4 } } }));
    const changed = pins.applyPass(file, { updates: { [B]: { real: 10, set: 20 }, [D]: null }, gone: [C] });
    const unchanged = pins.applyPass(file, { updates: { [B]: { real: 10, set: 20 } }, gone: [] });
    if (changed && !unchanged && JSON.stringify(pins.read(file)) === JSON.stringify({ pinned: [A, B], times: { [A]: { real: 1, set: 2 }, [B]: { real: 10, set: 20 } } })) {
      ok('a pass\'s findings are folded into the file as it is then: records set and dropped, conversations no longer on disk unpinned');
    } else bad(`after folding in a pass: ${JSON.stringify(pins.read(file))}, changed ${changed}/${unchanged}`);

    const data = pins.pageData({ pinned: [B, A], times: { [B]: { real: 10.4, set: 20 }, [A]: { real: 1, set: 2 } } }, 90);
    const css = webview.liveCss({ enabled: false, pins: data });
    const packed = (css.match(/--cce-pins:"([^"]+)"/) || [])[1];
    const back = packed ? JSON.parse(Buffer.from(packed, 'base64').toString('utf8')) : null;
    const none = webview.liveCss({ enabled: true, pins: null });
    const empty = webview.liveCss({ enabled: true, pins: pins.pageData({ pinned: [], times: {} }, 10) });
    if (JSON.stringify(back) === JSON.stringify([[A, B], { [A]: [1, 2], [B]: [10, 20] }, 14]) && !/--cce-pins/.test(none) && /--cce-pins:"/.test(empty)
      && pins.marginDays(10) === 5) {
      ok('the stylesheet carries the pins, sorted, while pinning is on - with nothing pinned and with the other additions off - and nothing while it is off');
    } else bad(`pins in the stylesheet: ${JSON.stringify(back)}; off: ${/--cce-pins/.test(none)}; empty: ${/--cce-pins/.test(empty)}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  /* Keeping the files: in a child process, since the pass is asynchronous and this suite is not. */
  const script = `
    const fs = require('fs'), os = require('os'), path = require('path');
    const pins = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'sessionpins.js'))});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-keep-'));
    const DAY = 86400000, now = Date.UTC(2026, 9, 16, 12);
    const put = (rel, ageDays) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'x'); const t = new Date(now - ageDays * DAY); fs.utimesSync(p, t, t); return p; };
    const age = (rel) => Math.round((now - fs.statSync(path.join(root, rel)).mtimeMs) / DAY * 10) / 10;
    (async () => {
      try {
        put('p/p1/${A}.jsonl', 100); put('p/p1/${A}/tool-results/a.txt', 100); put('p/p1/${A}/tool-results/s/b.txt', 85);
        put('p/p1/${A}/tool-results/s/d/c.txt', 100); put('p/p1/${A}/subagents/agent-1.jsonl', 100);
        put('p/p2/${B}.jsonl', 10); put('p/p2/${D}.jsonl', 100);
        const first = await pins.keep({ ids: new Set(['${A}', '${B}', '${C}']), days: 90, projectsDir: path.join(root, 'p'), now });
        const ages = ['p/p1/${A}.jsonl', 'p/p1/${A}/tool-results/a.txt', 'p/p1/${A}/tool-results/s/b.txt', 'p/p1/${A}/tool-results/s/d/c.txt',
          'p/p1/${A}/subagents/agent-1.jsonl', 'p/p2/${B}.jsonl', 'p/p2/${D}.jsonl'].map(age);
        const times = { '${A}': first.updates['${A}'] };
        // The next pass, half an hour later in any window: the files are already past the floor, so nothing moves.
        const soon = await pins.keep({ ids: new Set(['${A}']), times, days: 90, projectsDir: path.join(root, 'p'), now: now + 30 * 60000 });
        // Another window's pass moved the file between this window reading the record and checking the file, so the
        // record this window has is the older one.
        const stale = await pins.keep({ ids: new Set(['${A}']), times: { '${A}': { real: times['${A}'].real, set: times['${A}'].set - 2 * DAY } },
          days: 90, projectsDir: path.join(root, 'p'), now: now + 30 * 60000 });
        const later = now + 2 * DAY;
        const second = await pins.keep({ ids: new Set(['${A}']), times, days: 90, projectsDir: path.join(root, 'p'), now: later });
        put('p/p1/${A}.jsonl', 0);
        const written = await pins.keep({ ids: new Set(), times: { '${A}': second.updates['${A}'] }, days: 90, projectsDir: path.join(root, 'p'), now: later });
        put('q/one/${A}.jsonl', 100);
        const short = await pins.keep({ ids: new Set(['${A}']), days: 10, projectsDir: path.join(root, 'q'), now });
        const empty = await pins.keep({ ids: new Set(['${A}']), days: 90, projectsDir: path.join(root, 'none'), now });
        fs.mkdirSync(path.join(root, 'r', 'locked'), { recursive: true }); put('r/open/${B}.jsonl', 1);
        fs.chmodSync(path.join(root, 'r', 'locked'), 0);
        const partial = await pins.keep({ ids: new Set(['${A}']), days: 90, projectsDir: path.join(root, 'r'), now });
        fs.chmodSync(path.join(root, 'r', 'locked'), 0o755);
        process.stdout.write(JSON.stringify({ first, ages, soon, stale, second, written, short: age('q/one/${A}.jsonl'), empty, partial,
          root: ${CANNOT_LOCK} }));
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    })().catch((e) => process.stdout.write(JSON.stringify({ error: e.message })));`;
  let k;
  try { k = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })); }
  catch (e) { k = { error: e.message }; }
  if (k.error) bad('keeping pinned conversations failed: ' + k.error);
  else {
    const NOW = Date.UTC(2026, 9, 16, 12), DAY = 86400000;
    const want = [75, 75, 75, 100, 100, 10, 100];
    if (JSON.stringify(k.ages) === JSON.stringify(want) && k.first.found === 2 && k.first.touched === 3 && k.first.errors === 0) {
      ok('a pinned transcript and its tool outputs past the margin are set to a day inside 14 days of a 90-day cleanup; '
        + 'fresh ones, other conversations, and what the cleanup does not reach are left alone');
    } else bad(`ages after keeping: ${JSON.stringify(k.ages)} (expected ${JSON.stringify(want)}), counts ${JSON.stringify(k.first)}`);
    const rec = k.first.updates[A] || {}, rec2 = (k.second.updates || {})[A] || {};
    if (Math.round((NOW - rec.real) / DAY) === 100 && rec.set === NOW - 75 * DAY && !(B in k.first.updates)
      && rec2.real === rec.real && rec2.set === NOW + 2 * DAY - 75 * DAY) {
      ok('the first move records the time the transcript had, and the next keeps that time while recording the new one');
    } else bad(`records: first ${JSON.stringify(k.first.updates)}, second ${JSON.stringify(k.second.updates)}`);
    /* Passes run every half hour in every window; files moved to exactly the floor would be found half an hour behind
       and moved again each time, rewriting the record and the stylesheet every panel reloads. */
    if (k.soon.touched === 0 && !Object.keys(k.soon.updates).length) ok('a pass half an hour after another moves no file and changes no record');
    else bad(`a pass half an hour on touched ${k.soon.touched} file(s) and gave ${JSON.stringify(k.soon.updates)}`);
    if (!(A in k.stale.updates)) ok('a file another window\'s pass has just moved is not taken for one written to, so its real time is kept');
    else bad(`with a record from before another window's pass the record became ${JSON.stringify(k.stale.updates[A])}`);
    if (k.written.updates[A] === null && k.written.touched === 0) ok('once the transcript is written to, its record goes');
    else bad(`after a write the pass returned ${JSON.stringify(k.written)}`);
    if (JSON.stringify(k.first.gone) === JSON.stringify([C])) ok('a pinned conversation with no transcript left is reported gone');
    else bad(`gone after the first pass: ${JSON.stringify(k.first.gone)}`);
    if (k.short === 4) ok('with a 10-day cleanup, the margin is half of it');
    else bad(`with a 10-day cleanup the transcript was left ${k.short} days old`);
    if (!k.empty.gone.length && (k.root || !k.partial.gone.length)) {
      ok('nothing is reported gone when no transcript at all was found, or a project folder could not be read');
    } else bad(`gone with nothing found: ${JSON.stringify(k.empty.gone)}; with a folder unreadable: ${JSON.stringify(k.partial.gone)}`);
  }
  const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const manifest = require('../package.json').contributes.configuration.properties;
  if (/const pinsOn = \(\) => !removed\(\) && cfg\(\)\.get\(PINS_SETTING, true\) !== false;/.test(extSrc)
    && /globalThis\.__ccePinHook = /.test(extSrc) && /globalThis\.__ccePinnedIds = \(\) => \{\s*try \{ return pinsOn\(\) \?/.test(extSrc)
    && /if \(keeping \|\| !pinsOn\(\)\) return;/.test(extSrc) && /pins: pinsOn\(\) \?/.test(extSrc)
    && /if \(replaced\(\) && !toldStale\) \{[\s\S]{0,80}offerReload\('The pin is saved/.test(extSrc)
    && /fs\.watch\(dir, \{ persistent: false \}, \(event, name\) => \{\s*if \(name && name !== sessionPins\.FILE && name !== sessionColors\.FILE\) return;/.test(extSrc)
    && manifest['claudeCodePlus.sessionPins'] && manifest['claudeCodePlus.sessionPins'].default === true
    && !manifest['claudeCodePlus.keepGroupedSessions']) {
    ok('one setting, on by default, decides whether pins are drawn, files are kept and pinned conversations escape the archive');
    ok('a pin made in a window that can no longer write the stylesheet is saved and the reader told to reload, and every window redraws when the pins or the text colors change');
  } else bad('extension.js or the manifest does not wire the pins to their setting');
}

console.log('\nthe date on a message or reply from before today');
{
  /* The same order as the session list and the plan tree: month before day, the year only when it is not this one. */
  const FIXED = new Date(2026, 9, 16, 12, 0, 0).getTime();
  class FixedDate extends Date { constructor(...a) { if (a.length) super(...a); else super(FIXED); } }
  const env = { Date: FixedDate, window: {}, isOff: () => false };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '15-format.js'), 'utf8') + ';this.fmt = fmt;', env);
  const at = (...a) => new Date(...a).getTime();
  const want = [
    [at(2026, 9, 16, 9, 5, 7), '09:05:07', 'today: the clock alone'],
    [at(2026, 9, 1, 21, 9, 33), '10/01 21:09:33', 'an earlier day this year: month, then day'],
    [at(2026, 0, 10, 8, 0, 0), '01/10 08:00:00', 'so 10 January is 01/10'],
    [at(2025, 11, 31, 23, 30, 0), '2025/12/31 23:30:00', 'another year: the year in front'],
  ];
  for (const [ms, exp, label] of want) {
    const got = env.fmt(ms);
    if (got === exp) ok('message dates: ' + label);
    else bad(`message dates, ${label}: got "${got}", expected "${exp}"`);
  }
  const sweep = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '99-sweep.js'), 'utf8');
  const lit = /fmt\(cx\.block\.cceResultAt\)\.replace\((\/.+?\/), ''\)/.exec(sweep);
  const strip = lit ? new Function('return ' + lit[1])() : null;
  const ends = ['10/01 21:09:33', '2025/12/31 23:30:00'].map((s) => strip ? s.replace(strip, '') : null);
  if (ends[0] === '21:09:33' && ends[1] === '23:30:00') ok('a tool call\'s result time drops the date in either form');
  else bad(`the result time kept ${JSON.stringify(ends)}`);
}

/* OPEN SESSIONS: the edits hand over what the session list reads and draws with, and the page lists this window's open
   conversations from it. The edits are also checked against every installed build, in the section on matching. */
console.log('\nopen sessions on the session list');
{
  const { applyEdits } = require('../src/edits');
  const pick = (name) => webview.EDITS.find((e) => e.name === name);
  const shapes = [
    ['session list sources for open sessions',
      'F(Ch0,{sessions:V,context:U,sessionStates:q.sessionStates,openSessionIds:q.openSessionIds,unreadSessionKeys:q.unreadSessionKeys})',
      'F(Ch0,{sessions:(window.__cceSessionList={sessions:V,context:U,comms:q},V),context:U,sessionStates:q.sessionStates,openSessionIds:q.openSessionIds,'],
    ['open sessions section',
      'children:[F(Lh5,{collapsed:i1,onViewUsage:R0}),F("div",{className:e7.sectionHeader,children:w("button",{className:e7.sectionToggle,onClick:()=>W0("sessions",!z0),"aria-expanded":!z0,title:z0?"Expand session manager":"Collapse session manager",children:[F(Va,{className:e7.sectionChevron}),F("span",{children:"Session manager"})]})})]',
      'onViewUsage:R0}),(typeof window.__cceRecentClosedSection==="function"?window.__cceRecentClosedSection({jsx:F,jsxs:w,cls:e7,Chevron:Va}):null),(typeof window.__cceOpenSessions==="function"?window.__cceOpenSessions({jsx:F,jsxs:w,cls:e7,Chevron:Va}):null),F("div",{className:e7.sectionHeader,'],
    ['status dot for open sessions',
      ';function qY({state:$,ring:J=!1,title:Z,className:X}){return 1}',
      ';window.__cceStatusDot=qY;function qY({state:$,ring:J=!1,title:Z,className:X}){'],
    ['session row component for open sessions',
      'var Xh5=u0(function({session:J,id:Z,isActive:X}){return 1});',
      'var Xh5=window.__cceSessionRow=u0(function({session:J,id:Z,isActive:'],
    ['signal constructor for open sessions',
      'class C{activeSessionId=y1(void 0);sessionStates=y1([]);sessionArchiveChanged=y1(void 0)}',
      'sessionStates=(window.__cceSignal=y1,y1([]));sessionArchiveChanged='],
    ['session list keeps its place after a switch from open sessions',
      'i(()=>{if(F8.current!==null)return;let W1=m7.findIndex((f0)=>f0===G);if(W1<0||G===null)return;c.anchor(G),V1(W1)},[G])',
      'if(F8.current!==null)return;if(typeof window.__cceSkipFollow==="function"&&window.__cceSkipFollow(G))return;let W1=m7.findIndex((f0)=>f0===G);'],
    ['session list row classes',
      'var b5={root:"root_x",sessionListOnly:"sessionListOnly_x",sessionItem:"sessionItem_x"};',
      'var b5=(window.__cceListCls={root:"root_x",sessionListOnly:"sessionListOnly_x",sessionItem:"sessionItem_x"});'],
  ];
  for (const [name, src, want] of shapes) {
    const e = pick(name);
    const r = e ? applyEdits(src, [e]) : { error: 'no such edit' };
    if (!r.error && r.out.includes(want)) ok(`"${name}" hands over what OPEN SESSIONS needs`);
    else bad(`"${name}": ${r.error || r.out}`);
  }

  const now = Date.now(), MIN = 60000;
  const sig = (v) => ({ value: v });
  const item = (id, title, ago, remote) => ({ sessionId: sig(id), summary: sig(title), lastModifiedTime: sig(now - ago), isRemote: sig(!!remote) });
  const opened = [];
  const store = { getItem: (k) => store.data[k] ?? null, setItem: (k, v) => { store.data[k] = String(v); }, data: {} };
  const env = {
    window: {}, isOff: (k) => env.offKey === k, offKey: '', localStorage: store, Date, Array, String, Math, isFinite,
    head: { appendChild() {} },
    document: { createElement: () => ({ setAttribute() {}, textContent: '' }) },
  };
  env.window.__cceListCls = { sessionItem: 'sessionItem_x', active: 'active_x', sessionName: 'sessionName_x', sessionMeta: 'sessionMeta_x', sessionTime: 'sessionTime_x' };
  env.window.__cceStatusDot = function Dot() {};
  env.window.__cceSessionList = {
    sessions: { sessions: sig([item('A', 'Alpha', 10 * MIN), item('B', 'Beta', 120 * MIN), item('C', 'Gamma', 1440 * MIN),
      item('S', 'Side', 5 * MIN), item('R', 'Remote', 1 * MIN, true)]) },
    context: { openInEditor: (...a) => opened.push(a) },
    comms: {
      openSessionIds: sig(['B', 'A', 'N', 'X', 'R']), sidebarSessionIds: sig(['S', 'A']),
      sessionStates: sig([{ sessionId: 'A', state: 'running' }, { sessionId: 'B', state: 'idle' }, { sessionId: 'N', state: 'waiting', title: 'Fresh' }]),
      unreadSessionKeys: sig(['B']), activeSessionId: sig('A'),
    },
  };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '84-open-sessions.js'), 'utf8'), env);
  const h = (type, props, key) => ({ type, props: props || {}, key });
  const ui = { jsx: h, jsxs: h, cls: { sectionHeader: 'sh', sectionToggle: 'st', sectionChevron: 'sc', sectionChevronExpanded: 'sce', sectionLabel: 'sl' }, Chevron: function Chev() {} };
  const walk = (n, f, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((c) => walk(c, f, out)); return out; } if (f(n)) out.push(n); walk(n.props && n.props.children, f, out); return out; };
  const text = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join('') : n && n.props ? text(n.props.children) : '');
  const tree = env.window.__cceOpenSessions(ui);
  const rows = walk(tree, (n) => n.props && n.props['data-cce-open-row']);
  const got = rows.map((r) => {
    const dot = walk(r, (n) => n.type === env.window.__cceStatusDot)[0];
    return [r.props['data-cce-open-row'], dot && dot.props.state, /active_x/.test(r.props.className) ? 'active' : '', text(r).replace(/^\s+|\s+$/g, '')];
  });
  const want = [['N', 'waiting', '', 'Freshnow'], ['S', 'idle', '', 'Side5m · sidebar'], ['A', 'running', 'active', 'Alpha10m'], ['B', 'unread', '', 'Beta2h']];
  if (JSON.stringify(got) === JSON.stringify(want)) {
    ok('the open conversations, newest first: one just started counts as now, the sidebar one is marked, a remote one and one the list knows nothing of are left out');
  } else bad(`the rows were ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  const header = walk(tree, (n) => n.props && n.props['data-cce-section-count'])[0];
  if (header && text(header) === '4' && walk(tree, (n) => n.props && n.props.className === 'sl').some((n) => text(n) === 'Open sessions')) {
    ok('the header is the list\'s own section header, labelled Open sessions, with the count');
  } else bad('the header was not the list\'s section header with a count of 4');
  rows[3].props.onClick();
  if (opened.length === 1 && opened[0][0] === 'B' && opened[0][1] === undefined && opened[0][2].openState === 'unread' && opened[0][2].isRemote === false) {
    ok('a click opens the conversation the way a click on its row in the list does');
  } else bad(`a click opened ${JSON.stringify(opened)}`);
  const follow = env.window.__cceSkipFollow;
  const after = [follow({ sessionId: sig('B') }), follow({ sessionId: sig('B') }), follow({ sessionId: sig('A') }), follow({ sessionId: sig('B') })];
  if (JSON.stringify(after) === '[true,true,false,false]') {
    ok('after a switch from here the list keeps its place, until something else makes another conversation active');
  } else bad(`the list was told to keep its place: ${JSON.stringify(after)}`);

  /* With the list's own row component handed over, the rows the list knows are drawn with it; a conversation it does not
     list yet keeps the plain row. Renaming goes through a panel signal and the store, archiving through the store. */
  const renamed = [], archived = [];
  env.window.__cceSessionRow = function Row() {};
  env.window.__cceSignal = (v) => ({ value: v });
  const srcs = env.window.__cceSessionList;
  srcs.sessions.renameSession = (...a) => renamed.push(a);
  srcs.sessions.archiveSession = (it) => archived.push(it.sessionId.value);
  srcs.context.defaultCwd = sig('/work');
  const drawn = () => walk(env.window.__cceOpenSessions(ui), (n) => n.type === env.window.__cceSessionRow || (n.props && n.props['data-cce-open-row']));
  let list = drawn();
  const kinds = list.map((n) => (n.type === env.window.__cceSessionRow ? 'row:' + n.props.session.sessionId.value : 'plain:' + n.props['data-cce-open-row']));
  const a = list.find((n) => n.type === env.window.__cceSessionRow && n.props.session.sessionId.value === 'A');
  if (JSON.stringify(kinds) === JSON.stringify(['plain:N', 'row:S', 'row:A', 'row:B']) && a && a.props.isActive === true
      && a.props.openState === 'running' && a.props.currentCwd === '/work' && a.props.id === 'cce-open-A' && a.props.isRenaming === false) {
    ok('the rows the list knows are its own row component, active and state set, with an id of their own; one it does not list yet is a plain row');
  } else bad(`the rows drawn were ${JSON.stringify(kinds)}, A: ${a && JSON.stringify({ isActive: a.props.isActive, openState: a.props.openState, cwd: a.props.currentCwd, id: a.props.id })}`);
  a.props.onStartRename();
  list = drawn();
  const a2 = list.find((n) => n.type === env.window.__cceSessionRow && n.props.session.sessionId.value === 'A');
  a2.props.onFinishRename(a2.props.session, '  Alpha two ');
  a2.props.onArchive(a2.props.session);
  const a3 = drawn().find((n) => n.type === env.window.__cceSessionRow && n.props.session.sessionId.value === 'A');
  if (a2.props.isRenaming === true && a3.props.isRenaming === false && JSON.stringify(renamed) === '[["A","Alpha two"]]' && JSON.stringify(archived) === '["A"]') {
    ok('rename and archive work on a row here as on the list, rename saved through the store');
  } else bad(`rename and archive: renaming ${a2.props.isRenaming}→${a3.props.isRenaming}, renamed ${JSON.stringify(renamed)}, archived ${JSON.stringify(archived)}`);
  const unarchived = [];
  srcs.sessions.unarchiveSession = (it) => unarchived.push(it.sessionId.value);
  srcs.sessions.sessions.value.find((it) => it.sessionId.value === 'B').archived = sig(true);
  const b = drawn().find((n) => n.type === env.window.__cceSessionRow && n.props.session.sessionId.value === 'B');
  const a4 = drawn().find((n) => n.type === env.window.__cceSessionRow && n.props.session.sessionId.value === 'A');
  if (b && b.props.onArchive === undefined && typeof b.props.onUnarchive === 'function' && a4.props.onUnarchive === undefined) {
    b.props.onUnarchive(b.props.session);
    if (JSON.stringify(unarchived) === '["B"]') ok('an archived conversation gets unarchive and no archive, as on the list');
    else bad(`unarchiving called ${JSON.stringify(unarchived)}`);
  } else bad('an archived conversation still got the archive button, or a live one got unarchive');

  /* The props the list gives its row component, read out of the real bundles: each is either passed here or left out on
     purpose. A new one is a behaviour of the list's rows that OPEN SESSIONS would not have, so it fails until reviewed. */
  const PASSED = ['id', 'session', 'isActive', 'isHighlighted', 'isSelected', 'isRenaming', 'searchQuery', 'onClick', 'onFocus', 'onKeyDown',
    'draggable', 'onMouseMove', 'onStartRename', 'onFinishRename', 'onCancelRename', 'onArchive', 'onUnarchive', 'currentCwd', 'openState'];
  const LEFT_OUT = ['ref', 'onContextMenu', 'onDragStart', 'onDragEnd', 'onOpenInNewWindow', 'liveElsewhere'];
  const rowKeys = (src) => {
    const m = /([\w$]+)=[\w$]+\(function\(\{session:[\w$]+,id:[\w$]+,isActive:/.exec(src);
    if (!m) return null;
    const at = src.indexOf('(' + m[1] + ',{');
    if (at < 0) return null;
    // A key is the name that opens a property: right after the brace or after a comma at the object's own depth.
    let i = at + m[1].length + 2, depth = 0, keys = [], key = '', quote = '', expect = false;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; expect = false; continue; }
      if (ch === '{' || ch === '(' || ch === '[') { depth++; expect = depth === 1; key = ''; continue; }
      if (ch === '}' || ch === ')' || ch === ']') { if (depth === 1 && ch === '}') break; depth--; expect = false; continue; }
      if (depth !== 1) continue;
      if (ch === ',') { expect = true; key = ''; continue; }
      if (expect && /[\w$]/.test(ch)) { key += ch; continue; }
      if (expect && ch === ':' && key) keys.push(key);
      expect = false; key = '';
    }
    return keys;
  };
  for (const ext of extensionsDirs ? [].concat(...extensionsDirs().map((d) => { try { return fs.readdirSync(d).filter((n) => /^anthropic\.claude-code-/.test(n)).map((n) => path.join(d, n)); } catch (e) { return []; } })) : []) {
    const bak = path.join(ext, 'webview', 'index.js.claude-code-extras-webview.bak');
    const file = fs.existsSync(bak) ? bak : path.join(ext, 'webview', 'index.js');
    if (!fs.existsSync(file)) continue;
    const keys = rowKeys(fs.readFileSync(file, 'utf8'));
    const unknown = keys ? keys.filter((k) => !PASSED.includes(k) && !LEFT_OUT.includes(k)) : null;
    if (keys && !unknown.length) ok(`${path.basename(ext)}: every prop the list gives its rows is passed by OPEN SESSIONS or left out on purpose`);
    else bad(`${path.basename(ext)}: ${keys ? 'the list gives its rows props OPEN SESSIONS has not been reviewed for: ' + unknown.join(', ') : 'the row call could not be read'}`);
  }
  store.data['cce.openSessionsCollapsed'] = '1';
  const shut = env.window.__cceOpenSessions(ui);
  const toggle = walk(shut, (n) => n.props && n.props.className === 'st')[0];
  if (shut && shut.props['data-cce-collapsed'] === '1' && toggle && toggle.props['aria-expanded'] === 'false') ok('a collapsed section stays collapsed the next time the list draws it');
  else bad('the collapsed state was not kept');
  env.offKey = 'openSessions';
  const off = env.window.__cceOpenSessions(ui);
  env.offKey = '';
  env.window.__cceSessionList.comms.openSessionIds = sig([]); env.window.__cceSessionList.comms.sidebarSessionIds = sig(undefined);
  const none = env.window.__cceOpenSessions(ui);
  if (off === null && none === null) ok('nothing is drawn with the switch off, or with no conversation open');
  else bad('the section was drawn with the switch off or with nothing open');
  if (webview.SWITCHES.includes('openSessions') && require('../package.json').contributes.configuration.properties['claudeCodePlus.show.openSessions']) {
    ok('the switch is a setting of its own');
  } else bad('the openSessions switch has no setting');
}

console.log('\nopening in a tab or the sidebar from the session list');
{
  const { applyEdits } = require('../src/edits');
  const pick = (name) => webview.EDITS.find((e) => e.name === name);
  const ID = '0b6f0c2e-5d1a-4c3b-9e8f-1a2b3c4d5e6f';
  const env = { window: {}, isOff: (k) => env.offKey === k, offKey: '' };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '86-open-in-tab-or-sidebar.js'), 'utf8'), env);
  const h = (type, props, key) => ({ type, props: props || {}, key });
  const walk = (n, f, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((c) => walk(c, f, out)); return out; } if (f(n)) out.push(n); walk(n.props && n.props.children, f, out); return out; };
  const text = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join('') : n && n.props ? text(n.props.children) : '');
  const Icon = function Plus() {};
  const opens = [];
  const ctx = { openInEditor: (...a) => opens.push([env.window.__cceOpenWhere, a.length]) };
  const ui = { jsx: h, jsxs: h, cls: { newSessionButton: 'nsb', newSessionIcon: 'nsi' }, Icon, ctx };

  // The button edit, on the official button's own shape: the page's two buttons, or the official one when it returns null.
  const button = 'w("button",{className:e7.newSessionButton,onClick:()=>{J.openInEditor()},children:[F(zQ1,{className:e7.newSessionIcon}),"New session"]})';
  const be = pick('new session in a tab or the sidebar');
  const br = be ? applyEdits('children:[' + button + ',null]', [be]) : { error: 'no such edit' };
  if (!br.error && br.out.includes('window.__cceNewSessionButtons({jsx:F,jsxs:w,cls:e7,Icon:zQ1,ctx:J})||' + button)) {
    ok('New session hands the panel\'s factories, classes, icon and context to the page, and keeps the official button as the fallback');
  } else bad(`the New session edit gave ${br.error || br.out}`);
  const pair = env.window.__cceNewSessionButtons(ui);
  const buttons = walk(pair, (n) => n.type === 'button');
  const labels = buttons.map((b) => [b.props['data-cce-new-session'], b.props.className, text(b), walk(b, (n) => n.type === Icon).length]);
  if (JSON.stringify(labels) === JSON.stringify([['tab', 'nsb', 'New in tab', 1], ['sidebar', 'nsb', 'New in sidebar', 1]])) {
    ok('two buttons in the official button\'s style: New in tab and New in sidebar');
  } else bad(`the buttons were ${JSON.stringify(labels)}`);
  buttons[0].props.onClick(); buttons[1].props.onClick();
  if (JSON.stringify(opens) === JSON.stringify([['tab', 0], ['sidebar', 0]]) && env.window.__cceOpenWhere === undefined) {
    ok('each does what New session does, with where to open it set only for that call');
  } else bad(`the buttons opened ${JSON.stringify(opens)}, leaving ${env.window.__cceOpenWhere}`);

  // The two menus, each run as a function: the live list's takes one more argument than the archived list's.
  const menus = [
    ['resume in a tab or the sidebar, live list', 'function Uh0($,J,Z,X){let Y=[];if($.length===1)Y.push({label:X?.sessionIsOpen?"Switch to session":"Resume session",onSelect:Z.resumeSession});return Y}', (keys, info) => `Uh0(${keys},null,act,${info})`],
    ['resume in a tab or the sidebar, archived list', 'function Hh0($,J,Z){let X=[];if($.length===1)X.push({label:Z?.sessionIsOpen?"Switch to session":"Resume session",onSelect:J.resumeSession});return X}', (keys, info) => `Hh0(${keys},act,${info})`],
  ];
  for (const [name, fn, call] of menus) {
    const e = pick(name);
    const r = e ? applyEdits(fn, [e]) : { error: 'no such edit' };
    if (r.error) { bad(`"${name}" did not apply: ${r.error}`); continue; }
    const resumed = [];
    const menv = { window: env.window, act: { resumeSession: () => resumed.push(env.window.__cceOpenWhere || 'as set') }, out: null, items: null };
    vm.createContext(menv);
    const run = (keys, info) => { vm.runInContext(r.out + `;items=${call(keys, info)};out=items.map((i)=>i.label);`, menv); return menv.out; };
    const closed = run(`["${ID}"]`, '{sessionIsOpen:false}');
    menv.items.forEach((i) => i.onSelect());
    const open = run(`["${ID}"]`, '{sessionIsOpen:true}');
    const remote = run('["remote:abc"]', '{sessionIsOpen:false}');
    const many = run(`["${ID}","x"]`, '{sessionIsOpen:false}');
    const saved = env.window.__cceResumeItems; delete env.window.__cceResumeItems;
    const bare = run(`["${ID}"]`, '{sessionIsOpen:false}');
    env.window.__cceResumeItems = saved;
    const got = JSON.stringify([closed, open, remote, many, bare]);
    const want = JSON.stringify([['Resume in tab', 'Resume in sidebar'], ['Switch to session'], ['Resume session'], [], ['Resume session']]);
    if (got === want) ok(`"${name}": a closed conversation gets Resume in tab and Resume in sidebar; an open one, a remote one and a page without the script keep the official item`);
    else bad(`"${name}" gave ${got}, expected ${want}`);
    if (JSON.stringify(resumed) === '["tab","sidebar"]' && env.window.__cceOpenWhere === undefined) {
      ok(`"${name}": each Resume item runs the list's own resume, which clears the list's selection, with where to open it`);
    } else bad(`"${name}": the Resume items resumed ${JSON.stringify(resumed)}`);
  }
  env.offKey = 'openInTabOrSidebar';
  const offButtons = env.window.__cceNewSessionButtons(ui), offItems = env.window.__cceResumeItems(ID, () => {});
  env.offKey = '';
  if (offButtons === null && offItems === null && env.window.__cceResumeItems(ID) === null) {
    ok('with the switch off, or without the list\'s own resume, New session and Resume session are the official ones');
  } else bad('the switch off still drew the two buttons or the two Resume items');

  // The panel's open request carries where, once; the host opens it there, and a request that does not say as before.
  const re = pick('open request says where');
  const rr = re ? applyEdits('class K{sendRequest(m){return m}openInEditor($,J,Z){return this.sendRequest({type:"open_in_editor",sessionId:$,newSessionGroupId:J,usage:Z})}}', [re]) : { error: 'no such edit' };
  if (rr.error) bad('the open request edit did not apply: ' + rr.error);
  else {
    const kenv = { window: { __cceOpenWhere: 'sidebar' } };
    vm.createContext(kenv);
    vm.runInContext(rr.out + ';var k=new K();var first=k.openInEditor("s1");var second=k.openInEditor("s1");', kenv);
    if (kenv.first.cceWhere === 'sidebar' && kenv.first.sessionId === 's1' && kenv.second.cceWhere === undefined) ok('the panel\'s open request carries where it was asked to open, for that one request');
    else bad(`the open requests were ${JSON.stringify([kenv.first, kenv.second])}`);
  }
  const he = host.EDITS.find((e) => e.name === 'session list open says where');
  const hsrc = 'async function o($){await D1.commands.executeCommand("claude-vscode.editor.open",$.request.sessionId,void 0,void 0,$.request.newSessionGroupId,!0,{programmatic:$.request.newSessionGroupId&&!$.request.sessionId?"pin-to-panel":"honor-preferred-location"})}';
  const hr = he ? applyEdits(hsrc, [he]) : { error: 'no such edit' };
  if (hr.error) bad('the host open edit did not apply: ' + hr.error);
  else {
    const calls = [];
    const henv = { D1: { commands: { executeCommand: (...a) => { calls.push(a[6].programmatic); } } } };
    vm.createContext(henv);
    vm.runInContext(hr.out + ';o({request:{cceWhere:"sidebar"}});o({request:{cceWhere:"tab",sessionId:"s"}});o({request:{}});o({request:{newSessionGroupId:"g"}});o({request:{cceWhere:"window"}});', henv);
    if (JSON.stringify(calls) === JSON.stringify(['cce-pin-to-sidebar', 'pin-to-panel', 'honor-preferred-location', 'pin-to-panel', 'honor-preferred-location'])) {
      ok('the patched host opens a session-list request where it says, and one that does not say as before');
    } else bad(`the host asked for ${JSON.stringify(calls)}`);
  }
  const ci = 'function CI1({programmatic:$,preferredLocation:J,sessionAlreadyOpenInPanel:Q,fullEditor:X}){if($)return{target:$==="honor-preferred-location"&&J==="sidebar"&&!Q?"sidebar":"panel",updatePreferredLocationToPanel:!1,focusInput:!1};return{target:"panel",updatePreferredLocationToPanel:!X,focusInput:!0}}';
  const cr = applyEdits(ci, [host.EDITS.find((e) => e.name === 'open in the sidebar on request')]);
  if (cr.error) bad('the location chooser edit did not apply: ' + cr.error);
  else {
    const cenv = {};
    vm.createContext(cenv);
    vm.runInContext(cr.out, cenv);
    const t = (how, loc, open) => { const v = cenv.CI1({ programmatic: how, preferredLocation: loc, sessionAlreadyOpenInPanel: open }); return v.target + (v.updatePreferredLocationToPanel ? '+set' : ''); };
    const got = [t('cce-pin-to-sidebar', 'panel', false), t('cce-pin-to-sidebar', 'sidebar', false), t('cce-pin-to-sidebar', 'panel', true),
      t('pin-to-panel', 'sidebar', false), t('honor-preferred-location', 'sidebar', false), t('honor-preferred-location', 'panel', false), t(undefined, 'sidebar', false)];
    const want = ['sidebar', 'sidebar', 'panel', 'panel', 'sidebar', 'panel', 'panel+set'];
    if (JSON.stringify(got) === JSON.stringify(want)) {
      ok('the sidebar request opens in the sidebar whatever the setting says, unless the conversation is open in a tab; the official requests choose as before');
    } else bad(`the location chooser gave ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  if (webview.SWITCHES.includes('openInTabOrSidebar') && require('../package.json').contributes.configuration.properties['claudeCodePlus.show.openInTabOrSidebar']) {
    ok('the switch is a setting of its own');
  } else bad('the openInTabOrSidebar switch has no setting');
}

console.log('\nhover text on the session list rows');
{
  const sig = (v) => ({ value: v });
  const shown = [], timers = [];
  const env = { window: {}, isOff: (k) => env.offKey === k, offKey: '',
    showLabel: (el, text) => shown.push(text), hideLabel: () => {},
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: () => {} };
  env.window.__cceSessionList = { sessions: { sessionGroups: sig([{ id: 'g1', name: 'Release', sessionIds: ['A', 'C', 'R'] }, { id: 'g2', name: 'Docs', sessionIds: ['C', 'Z'] }]) } };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '84-row-hover.js'), 'utf8'), env);
  const el = () => ({ isConnected: true, addEventListener() {} });
  const session = (id, extra) => ({ sessionId: sig(id), ...(extra || {}) });
  const hover = (id, extra) => { timers.length = 0; shown.length = 0; env.window.__cceRowHover(session(id, extra), el(), true); timers.forEach((f) => f()); return shown.slice(); };
  const got = [hover('A'), hover('B'), hover('C'), hover('Z', { archived: sig(true) }), hover('R', { isRemote: sig(true) })];
  const want = [['Group: Release\nSession ID: A'], ['Group: Ungrouped\nSession ID: B'], ['Group: Docs\nSession ID: C'],
    ['Group: Archived sessions\nSession ID: Z'], ['Session ID: R']];
  if (JSON.stringify(got) === JSON.stringify(want)) {
    ok('hovering a row shows the section the list puts it under - its group, Ungrouped or Archived sessions - and its session ID');
  } else bad(`the hover text was ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  timers.length = 0; shown.length = 0;
  env.window.__cceRowHover(session('A'), el(), true);
  env.window.__cceRowHover(session('A'), el(), false);
  const afterLeave = shown.length;
  env.offKey = 'sessionHoverDetails';
  const off = hover('A');
  env.offKey = '';
  if (afterLeave === 0 && timers.length === 0 && off.length === 0) ok('leaving the row before the delay shows nothing, and the switch off shows nothing');
  else bad(`after leaving ${afterLeave} box(es) were shown; with the switch off ${JSON.stringify(off)}`);
  /* The row pin shares the tooltip box: the row's tooltip is held back while the pointer is on the pin and returns when
     it is back on the row. */
  {
    const PIN = '0ccccccc-2222-4333-8444-555555555555';
    let current = null, tn = 0;
    const due = new Map();
    const penv = { window: {}, isOff: () => false, pinsCache: null, readProp: () => [[], {}, 14],
      showLabel: (target, text) => { current = typeof text === 'string' ? text : target.getAttribute('aria-label'); },
      hideLabel: () => { current = null; },
      setTimeout: (f) => { due.set(++tn, f); return tn; }, clearTimeout: (t) => { due.delete(t); },
      head: { appendChild() {} }, document: { createElement: () => ({ setAttribute() {} }) } };
    vm.createContext(penv);
    vm.runInContext(['83-session-pins.js', '84-row-hover.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'page', f), 'utf8')).join('\n'), penv);
    const fire = () => { const now = [...due.values()]; due.clear(); now.forEach((f) => f()); };
    const pin = penv.window.__ccePin((type, props, key) => ({ type, props, key }), { sessionId: { value: PIN }, transcriptOnDisk: true });
    const pinEl = { getAttribute: (k) => (k === 'aria-label' ? pin.props['aria-label'] : null) };
    penv.window.__cceRowHover({ sessionId: { value: PIN } }, { isConnected: true, addEventListener() {} }, true);
    pin.props.onMouseEnter({ currentTarget: pinEl });
    fire();
    const onPin = current;
    pin.props.onMouseLeave();
    fire();
    const backOnRow = current;
    if (/^Pin this conversation/.test(onPin || '') && backOnRow === 'Group: Ungrouped\nSession ID: ' + PIN) {
      ok('on the pin its own hover text stays, the row\'s waiting, and back on the row the row\'s text comes up');
    } else bad(`hover text on the pin was ${JSON.stringify(onPin)}, and back on the row ${JSON.stringify(backOnRow)}`);
  }
  const { applyEdits } = require('../src/edits');
  const e = webview.EDITS.find((x) => x.name === 'session row hover');
  const row = 'var Xh5=u0(function({session:J,id:Z,isActive:X},E){let g=1;return w("button",{ref:E,id:Z,className:`${b5.sessionItem} ${X?b5.active:""}`,onMouseMove:W})});';
  const r = e ? applyEdits(row, [e]) : { error: 'no such edit' };
  if (!r.error && r.out.includes('return w("button",{ref:E,id:Z,onMouseEnter:(cceE)=>{typeof window.__cceRowHover==="function"&&window.__cceRowHover(J,cceE.currentTarget,!0)},onMouseLeave:(cceE)=>{typeof window.__cceRowHover==="function"&&window.__cceRowHover(J,cceE.currentTarget,!1)},className:')) {
    ok('the list\'s row component tells the page as the pointer enters and leaves a row, with the row\'s conversation');
  } else bad(`the row hover edit gave ${r.error || r.out}`);
  if (webview.SWITCHES.includes('sessionHoverDetails') && require('../package.json').contributes.configuration.properties['claudeCodePlus.show.sessionHoverDetails']) ok('the switch is a setting of its own');
  else bad('the sessionHoverDetails switch has no setting');
}
console.log('\nsearching the session list by session id');
{
  const sig = (v) => ({ value: v });
  const env = { window: {}, isOff: (k) => env.offKey === k, offKey: '' };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '84-search-by-id.js'), 'utf8'), env);
  const one = { sessionId: sig('69f92b14-1833-4321-8d21-58c2b8ca27a7') };
  const m = (q) => env.window.__cceIdMatch(one, q);
  const got = ['69f92b14', '69F92B14', ' 1833-4321 ', '58c2b8ca27a7', 'de', 'add', 'adv-design', '0000', ''].map(m);
  const want = [true, true, true, true, false, false, false, false, false];
  if (JSON.stringify(got) === JSON.stringify(want)) {
    ok('part of a session ID finds its conversation; a query shorter than four characters, or one that cannot be part of an ID, does not test the ID');
  } else bad(`ID matching gave ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  env.offKey = 'sessionIdSearch';
  if (m('69f92b14') === false) ok('the switch off leaves the search to the title and the branch');
  else bad('the switch off still matched the session ID');
  env.offKey = '';
  const { applyEdits } = require('../src/edits');
  const e = webview.EDITS.find((x) => x.name === 'session search by id');
  const src = 'var f=(M4,u1,mk)=>{let g0=u1.toLowerCase(),Y5=u1?M4.filter((W1)=>mk(W1).toLowerCase().includes(g0)||(W1.gitBranch.value?.toLowerCase().includes(g0)??!1)):M4;return Y5.map((W1)=>W1.sessionId.value)};';
  const r = e ? applyEdits(src, [e]) : { error: 'no such edit' };
  if (r.error) bad('the search edit did not apply: ' + r.error);
  else {
    vm.runInContext(r.out, env);
    const rows = [
      { sessionId: sig('69f92b14-1833-4321-8d21-58c2b8ca27a7'), gitBranch: sig('main'), t: 'Media skills' },
      { sessionId: sig('183f7e74-ec1e-408a-b4cd-da3791f683cb'), gitBranch: sig('feature/adv'), t: 'Extension source' },
    ];
    const run = (q) => JSON.stringify(env.f(rows, q, (x) => x.t));
    const got2 = [run('69f9'), run('media'), run('adv'), run('xyz')];
    const want2 = [JSON.stringify(['69f92b14-1833-4321-8d21-58c2b8ca27a7']), JSON.stringify(['69f92b14-1833-4321-8d21-58c2b8ca27a7']),
      JSON.stringify(['183f7e74-ec1e-408a-b4cd-da3791f683cb']), '[]'];
    if (JSON.stringify(got2) === JSON.stringify(want2)) ok('the list\'s filter keeps its title and branch matches and adds the ID test');
    else bad(`the patched filter gave ${JSON.stringify(got2)}, expected ${JSON.stringify(want2)}`);
  }
  if (webview.SWITCHES.includes('sessionIdSearch') && require('../package.json').contributes.configuration.properties['claudeCodePlus.show.sessionIdSearch']) ok('the switch is a setting of its own');
  else bad('the sessionIdSearch switch has no setting');
}
console.log('\na hidden sidebar in open sessions');
{
  const { applyEdits } = require('../src/edits');
  const hedit = (name) => host.EDITS.find((e) => e.name === name);
  // The host: every update of the open conversations says whether the sidebar's conversation can be seen.
  const loop = 'function b(){let z=this.sidebarComms,G=["S"];for(let K of this.allComms)K.sendSessionStates([{sessionId:"A",state:"idle"}],this.activeSessionId,["A"],[],[],K===z?void 0:G);return 1}';
  const send = 'class C{constructor(){this.sent=[]}send(m){this.sent.push(m)}sendSessionStates($,J,Q,X,Y,W){let z={type:"request",channelId:"",requestId:l$(),request:{type:"session_states_update",sessions:$,activeSessionId:J,openSessionIds:Q,unreadSessionKeys:X,liveElsewhereSessions:Y,sidebarSessionIds:W}};this.send(z)}}';
  const vis = 'function r($,G){$.onDidChangeVisibility(()=>{G.notifyVisibilityChange($.visible),this.updateSidebarActiveState()},null,this.disposables)}';
  const lr = applyEdits(loop, [hedit('session states say whether the sidebar is shown')]);
  const sr = applyEdits(send, [hedit('session states message carries whether the sidebar is shown')]);
  const vr = applyEdits(vis, [hedit('sidebar showing or hiding updates the open conversations')]);
  if (lr.error || sr.error || vr.error) bad(`the sidebar edits did not apply: ${lr.error || sr.error || vr.error}`);
  else {
    const env = { l$: () => 'id' };
    vm.createContext(env);
    vm.runInContext(lr.out + ';' + sr.out + ';this.b=b;this.C=C;' + vr.out + ';this.r=r;', env);
    const sidebar = new env.C(), list = new env.C();
    const shown = { v: true };
    const mgr = { sidebarComms: sidebar, allComms: [sidebar, list], activeSessionId: 'A',
      webviews: new Set([{ comms: sidebar, isVisible: () => shown.v }, { comms: list, isVisible: () => true }]) };
    env.b.call(mgr); shown.v = false; env.b.call(mgr); mgr.sidebarComms = undefined; env.b.call(mgr);
    const got = list.sent.map((m) => [m.request.sidebarSessionIds, m.request.cceSidebarShown]);
    if (JSON.stringify(got) === JSON.stringify([[['S'], true], [['S'], false], [['S'], false]]) && sidebar.sent[0].request.sidebarSessionIds === undefined) {
      ok('the patched host sends whether the sidebar is shown with each update, false with no sidebar, and leaves the sidebar ids as they were');
    } else bad(`the session list was sent ${JSON.stringify(got)}`);
    const hooked = [];
    env.__cceStatesHook = (st) => hooked.push(st[0].state);
    env.__cceWithBackground = (st) => st.map((x) => Object.assign({}, x, { state: 'running' }));
    env.b.call(mgr);
    env.__cceWithBackground = () => { throw new Error('x'); };
    env.b.call(mgr);
    const states = list.sent.slice(-2).map((m) => m.request.sessions[0].state);
    if (JSON.stringify(states) === '["running","idle"]' && JSON.stringify(hooked) === '["running","idle"]') {
      ok('session states go through __cceWithBackground, and are sent unchanged if it throws');
    } else bad(`states sent ${JSON.stringify(states)}, heard ${JSON.stringify(hooked)}`);
    let handler = null, broadcasts = 0;
    env.r.call({ updateSidebarActiveState() {}, broadcastSessionStates() { broadcasts++; }, disposables: [] },
      { onDidChangeVisibility: (f) => { handler = f; }, visible: false }, { notifyVisibilityChange() {} });
    handler && handler();
    if (broadcasts === 1) ok('the sidebar showing or hiding sends an update');
    else bad(`the sidebar's visibility change sent ${broadcasts} update(s)`);
  }

  // The panel keeps what the host said, ahead of the signals that make the list draw again.
  const we = webview.EDITS.find((e) => e.name === 'sidebar shown for open sessions');
  const hsrc = 'function h($){switch($.request.type){case"session_states_update":if(this.sessionStates.value=$.request.sessions,this.activeSessionId.value=$.request.activeSessionId,$.request.openSessionIds!==void 0)this.openSessionIds.value=$.request.openSessionIds;break}}';
  const wr = we ? applyEdits(hsrc, [we]) : { error: 'no such edit' };
  if (wr.error) bad('the panel edit did not apply: ' + wr.error);
  else {
    const penv = { window: {}, seen: [] };
    vm.createContext(penv);
    vm.runInContext(wr.out + ';const o={sessionStates:{set value(v){seen.push(window.__cceSidebarShown)}},activeSessionId:{},openSessionIds:{}};'
      + 'h.call(o,{request:{type:"session_states_update",sessions:[],cceSidebarShown:false}});h.call(o,{request:{type:"session_states_update",sessions:[]}});', penv);
    if (JSON.stringify(penv.seen) === '[false,null]' || (penv.seen[0] === false && penv.seen[1] === undefined)) {
      ok('the panel keeps whether the sidebar is shown before the list is told to draw');
    } else bad(`the panel kept ${JSON.stringify(penv.seen)}`);
  }

  // OPEN SESSIONS: the sidebar's conversation is listed while the sidebar is shown, or when the host does not say.
  const sig = (v) => ({ value: v });
  const env = { window: {}, isOff: () => false, localStorage: { getItem: () => null, setItem() {} }, Date, Array, String, Math, isFinite,
    head: { appendChild() {} }, document: { createElement: () => ({ setAttribute() {}, textContent: '' }) } };
  const item = (id) => ({ sessionId: sig(id), summary: sig(id), lastModifiedTime: sig(Date.now()), isRemote: sig(false) });
  env.window.__cceSessionList = {
    sessions: { sessions: sig([item('A'), item('S')]) }, context: { openInEditor() {} },
    comms: { openSessionIds: sig(['A']), sidebarSessionIds: sig(['S']), sessionStates: sig([]), unreadSessionKeys: sig([]), activeSessionId: sig('A') },
  };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '84-open-sessions.js'), 'utf8'), env);
  const h = (type, props, key) => ({ type, props: props || {}, key });
  const walk = (n, f, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((c) => walk(c, f, out)); return out; } if (f(n)) out.push(n); walk(n.props && n.props.children, f, out); return out; };
  const ids = () => walk(env.window.__cceOpenSessions({ jsx: h, jsxs: h, cls: {} }), (n) => n.props && n.props['data-cce-open-row']).map((n) => n.props['data-cce-open-row']).sort().join(',');
  const got = [];
  for (const v of [true, false, undefined]) { env.window.__cceSidebarShown = v; got.push(ids()); }
  if (JSON.stringify(got) === JSON.stringify(['A,S', 'A', 'A,S'])) ok('a hidden sidebar\'s conversation leaves OPEN SESSIONS, and comes back when the sidebar is shown');
  else bad(`with the sidebar shown, hidden and unsaid the rows were ${JSON.stringify(got)}`);
}

console.log('\ntabs VS Code did not restore');
{
  const dropped = require('../src/droppedtabs');
  const { applyEdits } = require('../src/edits');
  const id = (n) => `0000000${n}-0000-4000-8000-000000000000`;
  const strip = (t) => require('../src/tabdot').withoutMark(t);
  const record = [
    { sessionId: id(1), title: 'Shown in a tab' },
    { sessionId: id(2), title: 'Restored, not yet matched' },
    { sessionId: id(3), title: 'Twin' },
    { sessionId: id(4), title: 'Twin' },
    { sessionId: id(5), title: 'Guessed', inferred: true },
    { sessionId: id(6), title: 'Transcript gone' },
    { sessionId: 'not-a-session', title: 'Bad id' },
    { sessionId: id(7), title: 'Dropped', fullEditor: true },
    { sessionId: id(7), title: 'Dropped' },
  ];
  const got = dropped.find({ record, shown: [id(1)], labels: ['Restored, not yet matched \u{1F538}', 'Twin'], strip, exists: (s) => s !== id(6) });
  const want = [{ sessionId: id(4), title: 'Twin', fullEditor: false }, { sessionId: id(7), title: 'Dropped', fullEditor: true }];
  if (JSON.stringify(got) === JSON.stringify(want)) {
    ok('a recorded conversation is reopened only when it is shown nowhere, no restored tab carries its title, it was not guessed, and its transcript is there');
  } else bad(`the tabs to reopen were ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  // A conversation running in another window waits; it is reopened once it runs nowhere and is not shown here.
  const rec2 = [{ sessionId: id(1), title: 'Gone' }, { sessionId: id(2), title: 'Running in the old window' }, { sessionId: id(3), title: 'Open here' }];
  const sp2 = dropped.split({ record: rec2, shown: [id(3), id(2)], elsewhere: [id(2)], labels: [], exists: () => true });
  const ids = (l) => l.map((t) => t.sessionId);
  const st1 = dropped.settle({ waiting: sp2.later, shown: [id(3), id(2)], elsewhere: [id(2)], labels: [] });
  const st2 = dropped.settle({ waiting: st1.waiting, shown: [id(3)], elsewhere: [], labels: [] });
  const st3 = dropped.settle({ waiting: sp2.later, shown: [id(3), id(2)], elsewhere: [], labels: [] });
  if (JSON.stringify([ids(sp2.now), ids(sp2.later), ids(st1.ready), ids(st1.waiting), ids(st2.ready), ids(st3.ready), ids(st3.waiting)])
      === JSON.stringify([[id(1)], [id(2)], [], [id(2)], [id(2)], [], []])) {
    ok('a dropped tab whose conversation runs in another window waits, is reopened once it runs nowhere, and is let go if it gets shown here meanwhile');
  } else bad(`the waiting tabs went ${JSON.stringify([ids(sp2.now), ids(sp2.later), ids(st1.ready), ids(st1.waiting), ids(st2.ready), ids(st3.ready), ids(st3.waiting)])}`);
  /* Same title, one restored in a tab and one dropped: the restored tab belongs to the shown conversation, so the
     dropped one is still reopened. */
  {
    const twins = [{ sessionId: id(1), title: 'Same title' }, { sessionId: id(2), title: 'Same title' }];
    const back = dropped.find({ record: twins, shown: [id(1)], labels: ['Same title'], strip, exists: () => true });
    if (JSON.stringify(back.map((t) => t.sessionId)) === JSON.stringify([id(2)])) {
      ok('a dropped tab sharing its title with a restored one is reopened, the restored tab counted for its own conversation');
    } else bad(`with two of one title, one restored and one dropped, reopened ${JSON.stringify(back)}`);
  }
  const many = Array.from({ length: 30 }, (_, i) => ({ sessionId: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, title: 't' + i }));
  if (dropped.find({ record: many, shown: [], labels: [], exists: () => true }).length === dropped.LIMIT) ok(`no more than ${dropped.LIMIT} are reopened at once`);
  else bad('the limit on reopened tabs did not hold');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cce-dropped-'));
  try {
    fs.mkdirSync(path.join(tmp, '-work-a')); fs.mkdirSync(path.join(tmp, '-work-b'));
    fs.writeFileSync(path.join(tmp, '-work-b', id(8) + '.jsonl'), '{}\n');
    if (dropped.transcriptExists(id(8), tmp) && !dropped.transcriptExists(id(9), tmp) && !dropped.transcriptExists(id(8), path.join(tmp, 'none'))) {
      ok('a transcript is found in any project folder');
    } else bad('the transcript check was wrong');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  const edit = host.EDITS.find((e) => e.name === 'tab record at start');
  const src = 'class V{constructor(X){this.sessionPanels=new Map([["p",{}]]);this.liveElsewhereSessions=[{sessionId:"w"}];'
    + 'this.rememberedTabSessions=X.getPanelTabSessions?.()??[],this.reconcileRememberedTabSessions()}'
    + 'reconcileRememberedTabSessions(){this.rememberedTabSessions=this.rememberedTabSessions.slice(0,1)}'
    + 'reportableRememberedTabSessions(){return this.rememberedTabSessions}sidebarChatSessionIds(){return["s"]}}';
  const r = edit ? applyEdits(src, [edit]) : { error: 'no such edit' };
  if (r.error) bad('the tab record edit did not apply: ' + r.error);
  else {
    const env = {};
    env.globalThis = env;
    vm.createContext(env);
    vm.runInContext(r.out + ';new V({getPanelTabSessions:()=>[{sessionId:"a"},{sessionId:"b"}]});', env);
    if (JSON.stringify(env.__cceTabsAtStart) === '[{"sessionId":"a"},{"sessionId":"b"}]' && JSON.stringify(env.__cceSessionsShown()) === '["p","a","w","s"]'
        && JSON.stringify(env.__cceSessionsElsewhere()) === '["w"]') {
      ok('the patched host hands over its tab record as read, before dropping missing tabs, and what is shown now in tabs, restored tabs, other windows and the sidebar');
    } else bad(`the host handed over ${JSON.stringify(env.__cceTabsAtStart)} and ${env.__cceSessionsShown && JSON.stringify(env.__cceSessionsShown())}`);
    const asked = [];
    vm.runInContext('var v=new V({});v.allComms=[{refreshTabIcon(){asked.push(1)}},{refreshTabIcon(){throw new Error("x")}},{refreshTabIcon(){asked.push(3)}}];'
      + 'v.constructor;', Object.assign(env, { asked }));
    try { env.__cceRefreshTabIcons(); } catch (_) { /* reported below */ }
    if (JSON.stringify(asked) === '[1,3]') ok('__cceRefreshTabIcons refreshes every tab icon, even after one panel throws');
    else bad(`refreshing tab icons reached ${JSON.stringify(asked)}`);
  }
  const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  if (/executeCommand\('claude-vscode\.editor\.open', t\.sessionId, undefined, undefined, undefined, t\.fullEditor,\s*\{ programmatic: 'pin-to-panel' \}\)/.test(extSrc)
      && /cfg\(\)\.get\(REOPEN_SETTING, true\) === false/.test(extSrc)
      && require('../package.json').contributes.configuration.properties['claudeCodePlus.reopenDroppedTabs']) {
    ok('the dropped tabs are reopened with Claude Code\'s own open command, without changing the preferred location, behind a setting of their own');
  } else bad('the reopening is not wired as expected');
}

console.log('\ndeleting an archived conversation');
{
  const del = require('../src/deletesession');
  const { applyEdits } = require('../src/edits');
  const A = '0aaaaaaa-0000-4000-8000-000000000000', B = '0bbbbbbb-0000-4000-8000-000000000000';
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cce-delete-'));
  const put = (rel, text = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  try {
    put(`projects/-a/${A}.jsonl`, '0123456789'); put(`projects/-b/${A}.jsonl`);
    put(`projects/-a/${A}/subagents/agent-1.jsonl`); put(`projects/-a/${A}/subagents/agent-1.meta.json`); put(`projects/-a/${A}/subagents/agent-2.jsonl`);
    put(`projects/-a/${A}/tool-results/t1.txt`); put(`projects/-a/${A}/tool-results/t2.txt`); put(`projects/-a/${A}/workflows/w.json`);
    put(`file-history/${A}/f@v1`); put(`session-env/${A}/env`); put(`debug/${A}.txt`); put(`todos/${A}-agent-${A}.json`);
    put(`plans/${A}.json`); put(`plans/${A}.tz`); put(`ext/claude-code-extras.effort.${A}.css`);
    put(`projects/-a/${B}.jsonl`); put(`projects/-a/${B}/subagents/agent-9.jsonl`); put(`file-history/${B}/f@v1`); put(`plans/${B}.json`); put(`debug/${B}.txt`);
    const opts = { root, planDir: path.join(root, 'plans'), extra: [path.join(root, 'ext', `claude-code-extras.effort.${A}.css`)] };
    const found = del.find(A, opts);
    const text = del.describe(found);
    if (/^2 transcripts, 2 sub-agent conversations, 2 saved tool outputs, 1 file checkpoint, the work plan, the debug log \(\d+ B\)$/.test(text)) {
      ok('the confirmation names what of the conversation is on disk: transcripts, sub-agent conversations, tool outputs, checkpoints, work plan, debug log, and the size');
    } else bad(`the description was "${text}"`);
    const failed = del.remove(found);
    const left = [];
    const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else left.push(path.relative(root, p).split(path.sep).join('/')); } };
    walk(root);
    const want = [`debug/${B}.txt`, `file-history/${B}/f@v1`, `plans/${B}.json`, `projects/-a/${B}.jsonl`, `projects/-a/${B}/subagents/agent-9.jsonl`].sort();
    if (!failed.length && JSON.stringify(left.sort()) === JSON.stringify(want) && !fs.existsSync(path.join(root, 'projects', '-a', A))) {
      ok('everything named after the conversation goes, in every project folder, and nothing of another conversation is touched');
    } else bad(`after the delete ${JSON.stringify(left)} were left, failures ${JSON.stringify(failed)}`);
    if (del.find('../projects', opts).length === 0 && del.find(A + '/..', opts).length === 0) ok('an ID that is not a session ID names nothing');
    else bad('a path-like ID found something to delete');
    put('sessions/1.json', JSON.stringify({ pid: process.pid, sessionId: A }));
    put('sessions/2.json', JSON.stringify({ pid: 2147483646, sessionId: B }));
    const live = del.runningSessions(root);
    if (live.has(A) && !live.has(B)) ok('a conversation with a live process in Claude Code\'s register counts as running, one whose process is gone does not');
    else bad(`the running check gave ${JSON.stringify([...live])}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  /* A session folder that is a symlink is deleted as a link; following it would add the target, which could be
     anywhere, to the confirmation and the deletion. */
  {
    const base = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cce-delete-link-'));
    const root2 = path.join(base, 'claude'), outside = path.join(base, 'elsewhere');
    try {
      fs.mkdirSync(path.join(root2, 'projects', '-a'), { recursive: true });
      fs.mkdirSync(path.join(outside, 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'subagents', 'agent-1.jsonl'), 'keep me');
      fs.writeFileSync(path.join(root2, 'projects', '-a', A + '.jsonl'), 'x');
      fs.symlinkSync(outside, path.join(root2, 'projects', '-a', A));
      const found = del.find(A, { root: root2 });
      const failed = del.remove(found);
      const linkGone = !fs.existsSync(path.join(root2, 'projects', '-a', A)) && (() => { try { fs.lstatSync(path.join(root2, 'projects', '-a', A)); return false; } catch (_) { return true; } })();
      if (!found.some((f) => f.path.startsWith(path.join(root2, 'projects', '-a', A) + path.sep)) && !failed.length && linkGone
        && fs.readFileSync(path.join(outside, 'subagents', 'agent-1.jsonl'), 'utf8') === 'keep me') {
        ok('a session folder that is a symbolic link is removed as a link, and nothing it points at is listed or deleted');
      } else bad(`with the session folder a link: found ${JSON.stringify(found.map((f) => path.relative(base, f.path)))}, failures ${JSON.stringify(failed)}`);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }

  /* One walk of the project folders finds several conversations at once, and a plan's lock directory is deleted with
     the plan. */
  {
    const root3 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cce-delete-many-'));
    try {
      for (const p of ['-a', '-b', '-c']) fs.mkdirSync(path.join(root3, 'projects', p), { recursive: true });
      fs.writeFileSync(path.join(root3, 'projects', '-a', A + '.jsonl'), 'x');
      fs.writeFileSync(path.join(root3, 'projects', '-c', B + '.jsonl'), 'x');
      fs.mkdirSync(path.join(root3, 'plans', A + '.json.lock'), { recursive: true });
      const realReaddir = fs.readdirSync;
      const listed = [];
      fs.readdirSync = function (p, ...rest) { listed.push(String(p)); return realReaddir.call(fs, p, ...rest); };
      let all;
      try { all = del.findAll([A, B, 'not-an-id'], { root: root3, planDir: path.join(root3, 'plans') }); }
      finally { fs.readdirSync = realReaddir; }
      const walked = listed.filter((p) => p.startsWith(path.join(root3, 'projects')));
      const kinds = (id) => all.get(id).map((f) => path.relative(root3, f.path).split(path.sep).join('/')).sort();
      if (all.size === 2 && walked.length === 4 && new Set(walked).size === 4
        && JSON.stringify(kinds(A)) === JSON.stringify([`plans/${A}.json.lock`, `projects/-a/${A}.jsonl`])
        && JSON.stringify(kinds(B)) === JSON.stringify([`projects/-c/${B}.jsonl`])) {
        ok('several conversations are found in one walk of the project folders, a plan\'s lock with its plan');
      } else bad(`finding two at once listed ${JSON.stringify(walked.map((p) => path.relative(root3, p)))} and found ${JSON.stringify([...all].map(([k, v]) => [k, v.map((f) => path.relative(root3, f.path))]))}`);
    } finally { fs.rmSync(root3, { recursive: true, force: true }); }
  }

  // The menu: Delete after Unarchive, for local conversations only, and it only asks this extension.
  const posted = [];
  const penv = { window: { __cceSessionList: { sessions: { sessions: { value: [{ sessionId: { value: A }, summary: { value: 'Alpha' } }] } } } },
    isOff: (k) => penv.offKey === k, offKey: '', acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }) };
  vm.createContext(penv);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '89-delete-archived.js'), 'utf8'), penv);
  const e = webview.EDITS.find((x) => x.name === 'delete in the archived list');
  const menu = 'function Hh0($,J,Z){let X=[];if($.length===1)X.push({label:"Resume session",onSelect:J.resumeSession});if(J.unarchiveSelection)X.push({label:$.length>1?`Unarchive ${$.length} sessions`:"Unarchive session",separatorBefore:X.length>0,onSelect:J.unarchiveSelection});return X}';
  const mr = e ? applyEdits(menu, [e]) : { error: 'no such edit' };
  if (mr.error) bad('the delete edit did not apply: ' + mr.error);
  else {
    const menv = { window: penv.window, out: null, items: null };
    vm.createContext(menv);
    const run = (keys) => { vm.runInContext(mr.out + `;items=Hh0(${keys},{resumeSession(){},unarchiveSelection(){}},{});out=items.map((i)=>i.label+(i.separatorBefore?"|":""));`, menv); return menv.out; };
    const one = run(`["${A}"]`), two = run(`["${A}","${B}"]`), remote = run('["remote:x"]');
    menv.items = null; run(`["${A}"]`); menv.items[2].onSelect();
    penv.offKey = 'deleteArchived'; const off = run(`["${A}"]`); penv.offKey = '';
    const got = JSON.stringify([one, two, remote, off]);
    const want = JSON.stringify([['Resume session', 'Unarchive session|', 'Delete session…|'], ['Unarchive 2 sessions', 'Delete 2 sessions…|'],
      ['Resume session', 'Unarchive session|'], ['Resume session', 'Unarchive session|']]);
    if (got === want) ok('Archived sessions gets Delete after Unarchive, for one or several, not for a remote conversation, and not with the switch off');
    else bad(`the archived menu was ${got}, expected ${want}`);
    if (JSON.stringify(posted) === JSON.stringify([{ type: 'cce_delete_sessions', sessions: [{ id: A, title: 'Alpha' }] }])) ok('choosing it only asks this extension, with each conversation\'s ID and title');
    else bad(`Delete sent ${JSON.stringify(posted)}`);
  }
  // The host: the request reaches this extension; and a delete can tell every panel to read the conversations again.
  const me = host.EDITS.find((x) => x.name === 'panel messages');
  const hr = applyEdits('function eT($,J){let Q=`Received message from webview: ${bl0(J)}`;$.info(Q)}', [me]);
  const asked = [];
  const henv = { bl0: (m) => JSON.stringify(m), __cceDeleteHook: (l) => asked.push(l) };
  henv.globalThis = henv;
  vm.createContext(henv);
  vm.runInContext(hr.out + ';const L={info(){}};eT(L,{type:"cce_delete_sessions",sessions:[{id:"a"}]});eT(L,{type:"cce_delete_sessions",sessions:"a"});', henv);
  const te = host.EDITS.find((x) => x.name === 'tab record at start');
  const tr = applyEdits('class V{constructor(X){this.allComms=new Set([{n:0,sendSessionStoreChanged(){this.n++}},{n:0,sendSessionStoreChanged(){throw new Error("gone")}}]);this.sessionPanels=new Map;this.liveElsewhereSessions=[];this.rememberedTabSessions=X.getPanelTabSessions?.()??[],this.reconcileRememberedTabSessions()}reconcileRememberedTabSessions(){}reportableRememberedTabSessions(){return[]}sidebarChatSessionIds(){return[]}}', [te]);
  const tenv = {};
  tenv.globalThis = tenv;
  vm.createContext(tenv);
  vm.runInContext(tr.out + ';var v=new V({getPanelTabSessions:()=>[]});globalThis.__cceSessionsChanged();var n=[...v.allComms][0].n;', tenv);
  if (JSON.stringify(asked) === '[[{"id":"a"}]]' && tenv.n === 1) ok('the patched host passes a delete request on, and can tell every panel to read the conversations on disk again');
  else bad(`the host passed on ${JSON.stringify(asked)}, panels told ${tenv.n}`);
  const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  if (/showWarningMessage\([\s\S]{0,200}\{ modal: true, detail: lines\.join\('\\n'\) \}, 'Delete'\);\s*if \(pick !== 'Delete'\) return;/.test(extSrc)
      && /shown\.includes\(w\.id\) \|\| running\.has\(w\.id\)/.test(extSrc) && /const running = deleteSession\.runningSessions\(\);/.test(extSrc)
      && webview.SWITCHES.includes('deleteArchived') && require('../package.json').contributes.configuration.properties['claudeCodePlus.show.deleteArchived']) {
    ok('nothing is deleted before a modal confirmation is accepted, an open or running conversation is left alone, and the switch is a setting of its own');
  } else bad('the delete is not guarded as expected');
  /* The hook runs inside Claude Code's message handling and finding the files walks every project folder, so the work
     is deferred. If the open conversations cannot be read, nothing is deleted; treating them as none would allow
     deleting an open one. */
  const hook = (/globalThis\.__cceDeleteHook = \(asked\) => \{([\s\S]*?)\n  \};/.exec(extSrc) || [])[1] || '';
  const work = (/const deleteArchived = async \(asked\) => \{([\s\S]*?)\n  \};/.exec(extSrc) || [])[1] || '';
  if (/^\s*setTimeout\(\(\) => deleteArchived\(asked\)[\s\S]*, 0\);\s*$/.test(hook)
      && /if \(!Array\.isArray\(shown\)\) \{[\s\S]{0,200}return;/.test(work) && /deleteSession\.findAll\(/.test(work) && !/deleteSession\.find\(/.test(work)) {
    ok('a delete is worked out after Claude Code\'s message handling, in one walk, and refused when the open conversations cannot be told');
  } else bad('the delete hook runs inside Claude Code\'s message handling, walks per conversation, or deletes when it cannot tell what is open');
}

console.log('\nthe pins\' margin setting');
{
  const sp = require('../src/sessionpins');
  const got = [sp.marginDays(90), sp.marginDays(90, 30), sp.marginDays(90, 60), sp.marginDays(20, 14), sp.marginDays(90, 0), sp.marginDays(90, 'x')];
  if (JSON.stringify(got) === JSON.stringify([14, 30, 45, 10, 14, 14])) ok('the margin is the setting, 14 by default, never more than half the retention, and a value below one day falls back to 14');
  else bad(`the margins were ${JSON.stringify(got)}`);
  // The pass is asynchronous and this suite is not, so it runs in a child process, as the other pin passes do.
  const script = `
    const fs = require('fs'), os = require('os'), path = require('path');
    const sp = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'sessionpins.js'))});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-margin-'));
    const id = '0ccccccc-0000-4000-8000-000000000000', DAY = 86400000, now = Date.UTC(2026, 9, 26);
    (async () => {
      try {
        fs.mkdirSync(path.join(root, '-p'));
        const f = path.join(root, '-p', id + '.jsonl');
        fs.writeFileSync(f, '{}');
        const old = new Date(now - 80 * DAY);
        fs.utimesSync(f, old, old);
        await sp.keep({ ids: new Set([id]), days: 90, margin: 30, projectsDir: root, now });
        process.stdout.write(JSON.stringify({ age: Math.round((now - fs.statSync(f).mtimeMs) / DAY) }));
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    })().catch((e) => process.stdout.write(JSON.stringify({ error: e.message })));`;
  let m;
  try { m = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })); }
  catch (e) { m = { error: e.message }; }
  if (m.age === 59) ok('a pass with a 30-day margin under a 90-day retention gives an 80-day-old pinned file the age of 59 days, a day inside the margin');
  else bad(`the margin pass gave ${JSON.stringify(m)}`);
  if (sp.pageData({ pinned: [], times: {} }, 90, 30)[2] === 30) ok('the page is told the same margin, for the pin\'s hover text');
  else bad('the page was not told the margin');
  const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const setting = require('../package.json').contributes.configuration.properties['claudeCodePlus.sessionPinsMarginDays'];
  if (setting && setting.default === 14 && setting.minimum === 1 && /margin: pinMargin\(\)/.test(extSrc) && /retentionDays\(\), pinMargin\(\)\)/.test(extSrc)) {
    ok('the setting, 14 by default, reaches both the pass and the page');
  } else bad('the margin setting is not wired as expected');
}

console.log('\nrecently closed sessions');
{
  const rc = require('../src/recentclosed');
  const { applyEdits } = require('../src/edits');
  const id = (n) => `0000000${n}-0000-4000-8000-000000000000`;
  let list = [];
  list = rc.record(list, id(1), 100); list = rc.record(list, id(2), 200); list = rc.record(list, id(1), 300); list = rc.record(list, 'not-an-id', 400);
  const page = rc.pageData(list, 10), none = rc.pageData(list, 0), big = rc.pageData(list, 999);
  if (JSON.stringify(page) === JSON.stringify({ max: 10, ids: [id(1), id(2)] }) && none.max === 0 && big.max === rc.KEEP) {
    ok('a closed tab goes first and only once, a malformed ID is ignored, and the page is told how many to show, 0 hiding the section');
  } else bad(`the closed list was ${JSON.stringify(page)}, ${JSON.stringify(none)}, ${JSON.stringify(big)}`);
  let many = [];
  for (let i = 0; i < 70; i++) many = rc.record(many, `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, i);
  if (many.length === rc.KEEP && many[0].id.startsWith('00000069')) ok(`no more than ${rc.KEEP} closings are kept`);
  else bad(`${many.length} closings were kept`);

  // The host: a closing reaches this extension; the list rides along with every update of the open conversations.
  const he = host.EDITS.find((e) => e.name === 'closed tab reaches this extension');
  const hsrc = 'function d($,Z,q,X){if(!this.discardedReplacements.has($))this.pushRecentlyClosedSession(Z,q,!!X)}';
  const hr = he ? applyEdits(hsrc, [he]) : { error: 'no such edit' };
  const henv = { closed: [], pushed: [] };
  henv.globalThis = henv;
  henv.__cceClosedHook = (x) => henv.closed.push(x);
  if (hr.error) bad('the closed-tab edit did not apply: ' + hr.error);
  else {
    vm.createContext(henv);
    vm.runInContext(hr.out + ';var o={discardedReplacements:new Set(["p2"]),pushRecentlyClosedSession(z){pushed.push(z)}};d.call(o,"p1","S1",1,0);d.call(o,"p2","S2",1,0);', henv);
    if (JSON.stringify(henv.closed) === '["S1"]' && JSON.stringify(henv.pushed) === '["S1"]') ok('a tab the person closed reaches this extension as Claude Code notes it, and a replaced tab does not');
    else bad(`closings reported ${JSON.stringify(henv.closed)}, noted ${JSON.stringify(henv.pushed)}`);
  }
  /* In the bundle the close hook runs in a loop in Claude Code's onDidDispose, before the open-conversation broadcast
     and the listener disposal, so a throwing hook must not skip those. */
  {
    const loop = 'function d($,Z,q,X){for(let F of [1]){if(!this.discardedReplacements.has($))this.pushRecentlyClosedSession(Z,q,!!X)}this.after.push(Z)}';
    const lr = he ? applyEdits(loop, [he]) : { error: 'no such edit' };
    const lenv = { pushed: [], after: [], threw: '' };
    lenv.globalThis = lenv;
    lenv.__cceClosedHook = () => { throw new Error('broken hook'); };
    if (lr.error) bad('the closed-tab edit did not apply inside a loop: ' + lr.error);
    else {
      vm.createContext(lenv);
      vm.runInContext(lr.out + ';try{d.call({discardedReplacements:new Set,pushRecentlyClosedSession(z){pushed.push(z)},after},"p","S3",1,0)}catch(e){threw=e.message}', lenv);
      if (!lenv.threw && JSON.stringify(lenv.after) === '["S3"]' && JSON.stringify(lenv.pushed) === '["S3"]') {
        ok('a closed-tab hook that throws leaves the rest of Claude Code\'s tab disposal running');
      } else bad(`with a throwing hook: threw ${JSON.stringify(lenv.threw)}, then ran ${JSON.stringify(lenv.after)}`);
    }
  }
  const se = host.EDITS.find((e) => e.name === 'session states message carries whether the sidebar is shown');
  const sr = applyEdits('class C{send(m){this.m=m}sendSessionStates($,J,Q,X,Y,W){let z={type:"request",channelId:"",requestId:l$(),request:{type:"session_states_update",sessions:$,activeSessionId:J,openSessionIds:Q,unreadSessionKeys:X,liveElsewhereSessions:Y,sidebarSessionIds:W}};this.send(z)}}', [se]);
  const senv = { l$: () => 'i' };
  senv.globalThis = senv;
  vm.createContext(senv);
  vm.runInContext(sr.out + ';var c=new C();globalThis.__cceRecentClosed=()=>({max:3,ids:["a"]});c.sendSessionStates([],1,[],[],[],[],true);var one=c.m.request.cceRecentClosed;'
    + 'globalThis.__cceRecentClosed=()=>{throw new Error("x")};c.sendSessionStates([],1,[],[],[],[],true);var two=c.m.request.cceRecentClosed;', senv);
  if (JSON.stringify(senv.one) === '{"max":3,"ids":["a"]}' && senv.two === undefined) ok('every update of the open conversations carries the closed list, and a failing list leaves the update as it was');
  else bad(`the update carried ${JSON.stringify(senv.one)} and ${JSON.stringify(senv.two)}`);

  // The panel: the section goes right before OPEN SESSIONS, and the closed list is kept as updates arrive.
  const we = webview.EDITS.find((e) => e.name === 'open sessions section');
  const wr = we ? applyEdits('children:[F(Lh5,{collapsed:i1,onViewUsage:R0}),F("div",{className:e7.sectionHeader,children:w("button",{className:e7.sectionToggle,onClick:()=>W0("sessions",!z0),"aria-expanded":!z0,title:z0?"Expand session manager":"Collapse session manager",children:[F(Va,{className:e7.sectionChevron}),F("span",{children:"Session manager"})]})})]', [we]) : { error: 'no such edit' };
  const at = (s) => (wr.out || '').indexOf(s);
  if (!wr.error && at('__cceRecentClosedSection({jsx:F,') >= 0 && at('__cceRecentClosedSection({jsx:F,') < at('__cceOpenSessions(') && at('__cceOpenSessions(') < at('className:e7.sectionHeader')
    && !webview.EDITS.some((e) => e.name === 'recently closed section')) {
    ok('Recently closed is drawn right before OPEN SESSIONS, handed the list\'s own factories, and nowhere else');
  } else bad(`the section edit gave ${wr.error || wr.out}`);
  const ke = webview.EDITS.find((e) => e.name === 'sidebar shown for open sessions');
  const kr = applyEdits('function h($){switch($.request.type){case"session_states_update":if(this.sessionStates.value=$.request.sessions,this.activeSessionId.value=1,$.request.openSessionIds!==void 0)this.openSessionIds.value=$.request.openSessionIds;break}}', [ke]);
  const kenv = { window: {} };
  vm.createContext(kenv);
  vm.runInContext(kr.out + ';const o={sessionStates:{},activeSessionId:{},openSessionIds:{}};h.call(o,{request:{type:"session_states_update",sessions:[],cceRecentClosed:{max:2,ids:["a"]}}});', kenv);
  if (JSON.stringify(kenv.window.__cceRecentClosed) === '{"max":2,"ids":["a"]}') ok('the panel keeps the closed list each update brings');
  else bad(`the panel kept ${JSON.stringify(kenv.window.__cceRecentClosed)}`);

  // The section itself, drawn from the two fragments it shares code with.
  const sig = (v) => ({ value: v });
  const store = { data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = String(v); } };
  const env = { window: {}, isOff: () => false, localStorage: store, Date, Array, String, Math, isFinite, Number,
    head: { appendChild() {} }, document: { createElement: () => ({ setAttribute() {}, textContent: '' }) } };
  const item = (n, extra) => ({ sessionId: sig(id(n)), summary: sig('t' + n), lastModifiedTime: sig(Date.now()), isRemote: sig(false), ...(extra || {}) });
  env.window.__cceSessionRow = function Row() {};
  env.window.__cceSessionList = {
    sessions: { sessions: sig([item(1), item(2), item(3), item(4), item(5, { isRemote: sig(true) })]) }, context: { openInEditor: (...a) => env.opened.push(a) },
    comms: { openSessionIds: sig([id(2)]), sidebarSessionIds: sig([id(3)]), sessionStates: sig([]), unreadSessionKeys: sig([]), activeSessionId: sig(id(2)) },
  };
  env.opened = [];
  vm.createContext(env);
  for (const f of ['84-open-sessions.js', '84-recent-closed.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'page', f), 'utf8'), env);
  const h = (type, props, key) => ({ type, props: props || {}, key });
  const ui = { jsx: h, jsxs: h, cls: { sectionToggle: 'st' } };
  const walk = (n, f, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((c) => walk(c, f, out)); return out; } if (f(n)) out.push(n); walk(n.props && n.props.children, f, out); return out; };
  const draw = (data, shown) => { env.window.__cceRecentClosed = data; env.window.__cceSidebarShown = shown; return env.window.__cceRecentClosedSection(ui); };
  const rowsOf = (t) => walk(t, (n) => n.type === env.window.__cceSessionRow).map((n) => n.props.session.sessionId.value.slice(7, 8));
  const t1 = draw({ max: 10, ids: [id(4), id(3), id(2), id(9), id(5), id(1)] }, true);
  const t2 = draw({ max: 1, ids: [id(4), id(1)] }, true);
  const t3 = draw({ max: 10, ids: [id(3), id(1)] }, false);
  const t0 = draw({ max: 0, ids: [id(1)] }, true), tNone = draw({ max: 10, ids: [id(2)] }, true);
  const got = JSON.stringify([rowsOf(t1), rowsOf(t2), rowsOf(t3), t0, tNone, t1 && t1.props['data-cce-collapsed']]);
  const want = JSON.stringify([['4', '1'], ['4'], ['3', '1'], null, null, '1']);
  if (got === want) {
    ok('Recently closed lists closed conversations most recent first, not those open in a tab or the shown sidebar, not unknown or remote ones, as many as asked, collapsed at first, and nothing when there is none or the count is 0');
  } else bad(`Recently closed drew ${got}, expected ${want}`);
  const r1 = walk(t1, (n) => n.type === env.window.__cceSessionRow)[0];
  r1.props.onClick();
  const toggle = walk(t1, (n) => n.props && n.props.className === 'st')[0];
  const root = { attrs: { 'data-cce-collapsed': '1' }, getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; } };
  toggle.props.onClick({ currentTarget: { closest: () => root, setAttribute() {}, querySelector: () => null } });
  const reopened = draw({ max: 10, ids: [id(4)] }, true);
  if (env.opened.length === 1 && env.opened[0][0] === id(4) && store.data['cce.recentClosedExpanded'] === '1' && reopened.props['data-cce-collapsed'] === '0') {
    ok('a click opens the conversation, and the section opened stays open the next time it is drawn');
  } else bad(`clicking opened ${JSON.stringify(env.opened)}; expanded ${store.data['cce.recentClosedExpanded']}`);
  const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const setting = require('../package.json').contributes.configuration.properties['claudeCodePlus.recentClosedSessions'];
  if (setting && setting.default === 10 && setting.minimum === 0 && /context\.workspaceState\.update\(recentClosed\.KEY, recentList\)/.test(extSrc)
      && /recentClosed\.pageData\(recentList, enabled\(\) && !removed\(\) \? cfg\(\)\.get\(RECENT_SETTING, 10\) : 0\)/.test(extSrc)) {
    ok('the closed list is kept per workspace, and the setting, 10 by default, says how many to show');
  } else bad('the closed list is not wired as expected');

  /* Both sections use one index of the list's conversations. It is kept while the list holds the same array, so a
     redraw touches only the conversations it looks up, and a conversation that gets its id after joining the array is
     still found. */
  {
    let reads = 0;
    const counted = (sid) => {
      const it = { summary: sig('t'), lastModifiedTime: sig(Date.now()), isRemote: sig(false) };
      Object.defineProperty(it, 'sessionId', { get() { reads++; return sid; } });
      return it;
    };
    const many = [], LATE = '0aaaaaaa-1111-4000-8000-000000000000', lateId = sig('');
    for (let n = 0; n < 200; n++) many.push(counted(sig(`${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`)));
    many.push(counted(lateId));
    const src = env.window.__cceSessionList;
    src.sessions.sessions = sig(many);
    src.comms.openSessionIds = sig([id(1), id(2)]);
    src.comms.sidebarSessionIds = sig([]);
    const both = () => [env.window.__cceOpenSessions(ui), draw({ max: 3, ids: [id(5), id(6), id(7)] }, true)];
    both();
    reads = 0;
    const [openAgain, closedAgain] = both();
    const again = reads;
    lateId.value = LATE;
    src.comms.openSessionIds = sig([LATE]);
    const late = walk(env.window.__cceOpenSessions(ui), (n) => n.type === env.window.__cceSessionRow);
    const drewBoth = walk(openAgain, (n) => n.type === env.window.__cceSessionRow).length === 2
      && walk(closedAgain, (n) => n.type === env.window.__cceSessionRow).length === 3;
    // Five conversations are asked for, each looked at once; a single pass over the list would be 201.
    if (drewBoth && again <= 20 && late.length === 1 && late[0].props.id === 'cce-open-' + LATE) {
      ok(`drawn again over 201 conversations, the two sections read an id ${again} times for the five they show, and one given its id later is still found`);
    } else bad(`drawn again over 201 conversations the two sections read a conversation's id ${again} times (drew both: ${drewBoth}); `
      + `the one given its id later was drawn ${late.length} time(s)`);
  }
}

/* Every window writes the same patched file, so each needs its own temporary name; with a shared one they truncate each
   other's copy and a rename fails. */
console.log('\na patched file written by several windows at once');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-atomic-'));
  const file = host.hostFile(dir);
  const renames = [];
  const realRename = fs.renameSync;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.renameSync = (from, to) => { renames.push(from); return realRename.call(fs, from, to); };
    host.writeAtomic(file, 'patched');
    host.writeAtomic(file, 'patched again');
    fs.renameSync = () => { throw Object.assign(new Error('rename failed'), { code: 'ENOENT' }); };
    let threw = '';
    try { host.writeAtomic(file, 'third'); } catch (e) { threw = e.message; }
    fs.renameSync = realRename;
    const left = fs.readdirSync(path.dirname(file)).filter((n) => n !== path.basename(file));
    if (renames.length === 2 && renames[0] !== renames[1] && renames.every((t) => t.includes('.' + process.pid + '.'))) {
      ok('each write goes through a temporary copy named for this process, never the same name twice');
    } else bad(`the temporary copies were ${JSON.stringify(renames.map((t) => path.basename(t)))}`);
    if (threw === 'rename failed' && !left.length) ok('a copy that could not be renamed into place is removed, and the failure still reported');
    else bad(`a failed rename threw ${JSON.stringify(threw)} and left ${JSON.stringify(left)}`);
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* A restore in one window and a patch in another at the same moment: whatever order their steps fall in, a patched file
   keeps a backup. The other window's patch is run from inside the restore's rename, right after it lands. */
console.log('\na restore and a patch in two windows at once');
{
  for (const [name, adapter] of [['the panel', webview], ['the host', host]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-race-'));
    const file = adapter.targetFile(dir);
    const backup = file + adapter.BACKUP_SUFFIX;
    const realRename = fs.renameSync;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'patched ' + adapter.MARK);
      fs.writeFileSync(backup, 'original');
      let other = null;
      fs.renameSync = (from, to) => {
        realRename.call(fs, from, to);
        if (to === file && !other) {
          other = 'clean';
          if (fs.readFileSync(file, 'utf8') === 'original') {
            fs.writeFileSync(backup, 'original');
            fs.writeFileSync(file, 'patched ' + adapter.MARK);
            other = 'patched';
          }
        }
      };
      adapter.restore(dir);
      fs.renameSync = realRename;
      const now = fs.readFileSync(file, 'utf8');
      const consistent = now === 'original' ? !fs.existsSync(backup) : fs.existsSync(backup) && fs.readFileSync(backup, 'utf8') === 'original';
      if (other === 'patched' && consistent) ok(`${name}: a patch landing just after a restore still has its backup`);
      else bad(`${name}: the other window ${other}; file ${JSON.stringify(now.slice(0, 20))}, backup ${fs.existsSync(backup)}`);
    } finally {
      fs.renameSync = realRename;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log('\ntext colors in the session list');
{
  const colors = require('../src/sessioncolors');
  const { applyEdits } = require('../src/edits');
  const frag = (n) => fs.readFileSync(path.join(__dirname, '..', 'src', 'page', n), 'utf8');
  const A = '69f92b14-1833-4321-8d21-58c2b8ca27a7', B = '183f7e74-ec1e-408a-b4cd-da3791f683cb', C = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cce-colors-'));
  const file = path.join(dir, colors.FILE);
  try {
    const steps = [
      colors.setColor(file, [A], 'red'), colors.setColor(file, [A], 'red'),
      colors.setColor(file, [B, A, 'remote:x'], 'blue'), colors.setColor(file, [C], 'magenta'),
      colors.setColor(file, ['not-an-id'], 'green'), colors.setColor(file, [B], null), colors.setColor(file, [B], null),
    ];
    const after = colors.read(file);
    if (JSON.stringify(steps) === JSON.stringify([true, false, true, false, false, true, false]) && JSON.stringify(after) === JSON.stringify({ [A]: 'blue' })) {
      ok('a color is set for one conversation or several and taken away with Default; an unknown name or a remote conversation changes nothing, and repeating a choice writes nothing');
    } else bad(`setting colors gave ${JSON.stringify(steps)} and left ${JSON.stringify(after)}`);
    colors.setColor(file, [C], 'green');
    const one = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, JSON.stringify({ colors: { [C]: 'green', x: 'red', [A]: 'blue', [B]: 'teal' } }));
    colors.write(file, colors.read(file));
    if (fs.readFileSync(file, 'utf8') === one) ok('the file is written in session ID order, so windows writing the same colors write the same bytes, and an entry that is not a session ID with one of the eight names is dropped');
    else bad(`the colors file read back as ${fs.readFileSync(file, 'utf8')}, expected ${one}`);
    const kept = colors.prune(file, null), pruned = colors.prune(file, new Set([A, B]));
    if (!kept && pruned && JSON.stringify(colors.read(file)) === JSON.stringify({ [A]: 'blue' })) ok('the colors of conversations no longer on disk are dropped, and none when the transcripts could not all be read');
    else bad(`pruning gave ${kept}/${pruned} and left ${JSON.stringify(colors.read(file))}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const unpack = (css) => { const m = /--cce-colors:"([^"]+)"/.exec(css); return m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : null; };
  const full = unpack(webview.liveCss({ colors: { [A]: 'cyan', [B]: 'red' } })), empty = unpack(webview.liveCss({ colors: {} }));
  const none = unpack(webview.liveCss({})), off = unpack(webview.liveCss({ colors: { [A]: 'red' }, off: ['sessionColors'] }));
  if (JSON.stringify(full) === JSON.stringify([1, [[B, 'red'], [A, 'cyan']]]) && JSON.stringify(empty) === '[1,[]]' && none === null && off === null) {
    ok('the stylesheet carries the colors in session ID order, and says the host acts on a choice even with nothing colored; with the switch off it carries nothing');
  } else bad(`the stylesheet carried ${JSON.stringify([full, empty, none, off])}`);

  const pack = (v) => '"' + Buffer.from(JSON.stringify(v), 'utf8').toString('base64') + '"';
  const env = { window: {}, Buffer, TextDecoder, atob: (x) => Buffer.from(x, 'base64').toString('binary'), prop: '', posted: [], timers: [], appended: [], offKey: '' };
  env.getComputedStyle = () => ({ getPropertyValue: (n) => (n === '--cce-colors' ? env.prop : '') });
  env.document = { documentElement: {}, createElement: (t) => ({ tag: t, textContent: '', setAttribute() {} }) };
  env.head = { appendChild: (el) => env.appended.push(el) };
  env.acquireVsCodeApi = () => ({ postMessage: (m) => env.posted.push(m) });
  env.setTimeout = (f, ms) => { env.timers.push([f, ms]); return env.timers.length; };
  env.isOff = (k) => env.offKey === k;
  vm.createContext(env);
  vm.runInContext(frag('82-scheduled-tasks.js') + frag('84-session-colors.js')
    + ';this.reset = function(){ propCache = {}; };this.paint = function(){ paintColors(); };', env);
  const item = (keys, after) => env.window.__cceColorItem(keys, after);
  const labels = (it) => it ? [it.label + (it.separatorBefore ? '|' : ''), it.submenu.map((x) => (x.separatorBefore ? '|' : '') + x.label)] : null;
  const missing = item([A], true);
  env.prop = pack([1, [[A, 'red']]]); env.reset();
  const red = labels(item([A], true)), mixed = labels(item([A, B], false)), plain = labels(item([B], true));
  const remote = item(['remote:x'], true);
  env.offKey = 'sessionColors'; const switched = item([A], true); env.offKey = '';
  const names = ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange', 'Pink', 'Cyan'];
  const sub = (mark) => ['Default' + (mark === 'Default' ? ' ✓' : '')].concat(names.map((n, i) => (i === 0 ? '|' : '') + n + (mark === n ? ' ✓' : '')));
  const want = [['Text color|', sub('Red')], ['Text color', sub('')], ['Text color|', sub('Default')]];
  if (missing === null && remote === null && switched === null && JSON.stringify([red, mixed, plain]) === JSON.stringify(want)) {
    ok('Text color offers Default and the eight /color colors and marks the one the selection has; nothing for a remote conversation, with the switch off, or from a host that would not act on it');
  } else bad(`the Text color item was ${JSON.stringify({ missing, red, mixed, plain, remote, switched })}`);
  env.listJsx = (type, props) => ({ type, props });
  const drawn = item([A], true).submenu[1].label;
  env.listJsx = null;
  if (drawn && drawn.props.children[0].props.style.background === 'var(--vscode-charts-red,#f14c4c)' && drawn.props.children[1] === 'Red ✓') {
    ok('with the list\'s element factory each color is shown with a swatch in the theme\'s own color');
  } else bad(`a color entry was drawn as ${JSON.stringify(drawn)}`);
  env.paint();
  const style = env.appended[0];
  const ruled = style && style.textContent;
  if (env.appended.length === 1 && ruled === `[class*="sessionItem_"][id$="${A}"] span[class*="sessionName_"]{color:var(--vscode-charts-red,#f14c4c)}`) {
    ok('a colored conversation gets one rule, for its title in every row whose id ends in its session ID, the open conversation\'s row included');
  } else bad(`the colors were drawn as ${JSON.stringify(ruled)}`);
  item([A], true).submenu[2].onSelect();
  const chosen = style.textContent;
  item([A], true).submenu[0].onSelect();
  const cleared = style.textContent;
  if (JSON.stringify(env.posted) === JSON.stringify([{ type: 'cce_session_color', sessionIds: [A], color: 'blue' }, { type: 'cce_session_color', sessionIds: [A], color: null }])
      && /charts-blue/.test(chosen) && !/charts-red/.test(chosen) && cleared === '' && env.timers.some(([, ms]) => ms > 15000)) {
    ok('choosing a color asks this extension and shows it at once; Default takes it away; the stylesheet decides again after a while');
  } else bad(`choosing sent ${JSON.stringify(env.posted)} and drew ${JSON.stringify([chosen, cleared])}`);
  env.prop = pack([1, [[A, 'red']]]); env.reset(); env.offKey = 'sessionColors'; env.paint(); env.offKey = '';
  if (style.textContent === '') ok('with the switch off no title is colored');
  else bad(`with the switch off the colors were ${JSON.stringify(style.textContent)}`);

  const live = webview.EDITS.find((x) => x.name === 'text color in the session list menu');
  const archived = webview.EDITS.find((x) => x.name === 'text color in the archived list menu');
  const del = webview.EDITS.find((x) => x.name === 'delete in the archived list');
  const menus = 'function dF(e,t,n,i){let o=[];if(e.length===1)o.push({label:"Resume session",onSelect:n.resumeSession});o.push({label:"New group from session",separatorBefore:o.length>0,onSelect:n.createGroupFromSelection});'
    + 'if(n.archiveSelection)o.push({label:e.length>1?`Archive ${e.length} sessions`:"Archive session",separatorBefore:!0,onSelect:n.archiveSelection});return o}'
    + 'function uF(e,t,n){let i=[];if(e.length===1)i.push({label:"Resume session",onSelect:t.resumeSession});if(t.unarchiveSelection)i.push({label:e.length>1?`Unarchive ${e.length} sessions`:"Unarchive session",separatorBefore:i.length>0,onSelect:t.unarchiveSelection});return i}';
  const mr = live && archived && del ? applyEdits(menus, [live, archived, del]) : { error: 'no such edit' };
  if (mr.error) bad('the text color edits did not apply: ' + mr.error);
  else {
    const menv = { window: env.window, out: null };
    vm.createContext(menv);
    const act = '{resumeSession(){},createGroupFromSelection(){},archiveSelection(){},unarchiveSelection(){}}';
    const run = (call) => { vm.runInContext(mr.out + `;out=${call}.map((x)=>x.label+(x.separatorBefore?"|":""));`, menv); return menv.out; };
    const got = [run(`dF(["${A}"],[],${act},{})`), run(`uF(["${A}"],${act},{})`), run(`uF(["${A}","${B}"],${act},{})`)];
    env.offKey = 'sessionColors'; got.push(run(`dF(["${A}"],[],${act},{})`)); env.offKey = '';
    const wantM = [['Resume session', 'New group from session|', 'Text color|', 'Archive session|'], ['Resume session', 'Text color|', 'Unarchive session|'],
      ['Text color', 'Unarchive 2 sessions|'], ['Resume session', 'New group from session|', 'Archive session|']];
    if (JSON.stringify(got) === JSON.stringify(wantM)) ok('Text color comes before Archive in a conversation\'s menu and before Unarchive in Archived sessions, with Delete still after it, and goes with the switch off');
    else bad(`the menus were ${JSON.stringify(got)}, expected ${JSON.stringify(wantM)}`);
  }
  const me = host.EDITS.find((x) => x.name === 'panel messages');
  const hr = applyEdits('function eT($,J){let Q=`Received message from webview: ${bl0(J)}`;$.info(Q)}', [me]);
  const asked = [];
  const henv = { bl0: (m) => JSON.stringify(m), __cceColorHook: (ids, c) => asked.push([ids, c]) };
  henv.globalThis = henv;
  vm.createContext(henv);
  vm.runInContext(hr.out + `;const L={info(){}};eT(L,{type:"cce_session_color",sessionIds:["${A}"],color:"red"});`
    + `eT(L,{type:"cce_session_color",sessionIds:["${A}"],color:7});eT(L,{type:"cce_session_color",sessionIds:"${A}",color:"red"});`, henv);
  if (JSON.stringify(asked) === JSON.stringify([[[A], 'red'], [[A], null]])) ok('the patched host passes a color choice on, reading anything but a name as Default');
  else bad(`the host passed on ${JSON.stringify(asked)}`);
  const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  if (/globalThis\.__cceColorHook = \(ids, name\) => \{\s*setTimeout\(/.test(extSrc)
      && /sessionColors\.setColor\(colorsFile\(\), \[g\.id\], null\)/.test(extSrc)
      && /r\.live && sessionColors\.prune\(colorsFile\(\), r\.live\)/.test(extSrc)
      && webview.SWITCHES.includes('sessionColors') && require('../package.json').contributes.configuration.properties['claudeCodePlus.show.sessionColors']) {
    ok('a choice is handled outside the host\'s message handling, a deleted or vanished conversation loses its color, and the switch is a setting of its own');
  } else bad('the text colors are not wired into the extension as expected');
}
console.log('\nbackground sessions left out of the session list');
{
  const bg = require('../src/bgsessions');
  const { applyEdits } = require('../src/edits');
  const A = '13758ed9-0b76-42b7-9685-534451164c72', B = '183f7e74-ec1e-408a-b4cd-da3791f683cb', C = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const D = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee', E = 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee';
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cce-bg-'));
  try {
    const cwd = '/work/my project';
    const dir = path.join(root, bg.folderName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const rec = (o) => JSON.stringify(o) + '\n';
    fs.writeFileSync(path.join(dir, A + '.jsonl'), rec({ type: 'agent-name', agentName: 'x' })
      + rec({ parentUuid: null, type: 'user', entrypoint: 'cli', sessionKind: 'bg', message: { content: 'go' } }));
    fs.writeFileSync(path.join(dir, B + '.jsonl'), rec({ parentUuid: null, type: 'user', entrypoint: 'claude-vscode',
      message: { content: 'why does "sessionKind":"bg" show up in the list?' } }));
    fs.writeFileSync(path.join(dir, C + '.jsonl'), rec({ type: 'agent-name', agentName: 'starting' }));
    const F = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee', G = '99999999-bbbb-cccc-dddd-eeeeeeeeeeee';
    fs.writeFileSync(path.join(dir, F + '.jsonl'), rec({ type: 'queue-operation', content: 'read the brief' })
      + rec({ parentUuid: null, type: 'user', entrypoint: 'sdk-cli', message: { content: 'read the brief' } }));
    fs.writeFileSync(path.join(dir, G + '.jsonl'), rec({ type: 'cost-state', totalCostUSD: 3 })
      + rec({ type: 'last-prompt', lastPrompt: 'read the brief' }) + rec({ type: 'ai-title', aiTitle: 'brief' }));
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, E + '.jsonl'), rec({ parentUuid: null, type: 'user', sessionKind: 'bg' }));
    const ids = (list) => list.map((e) => e.id);
    const entries = [{ id: A }, { id: B }, { id: C }, { id: D }, { id: 'remote:x' }];
    const first = ids(bg.withoutBackground(entries, cwd, root));
    fs.appendFileSync(path.join(dir, C + '.jsonl'), rec({ parentUuid: null, type: 'user', sessionKind: 'bg' }));
    const later = ids(bg.withoutBackground(entries, cwd, root));
    const long = ids(bg.withoutBackground([{ id: E }, { id: B }], '/' + 'x'.repeat(240), root));
    const more = ids(bg.withoutBackground([{ id: F }, { id: G }, { id: B }], cwd, root));
    if (JSON.stringify([first, later, long]) === JSON.stringify([[B, C, D, 'remote:x'], [B, D, 'remote:x'], [B]])) {
      ok('a session whose first record says sessionKind "bg" is left out; text quoting it in a message is not that field; one not yet started is read again later; a missing transcript keeps its row; a folder name past 200 characters falls back to a search');
    } else bad(`left in ${JSON.stringify([first, later, long])}`);
    if (JSON.stringify(more) === JSON.stringify([B])) ok('claude -p sessions and transcripts with no messages are left out');
    else bad(`with an SDK session and an empty transcript, left in ${JSON.stringify(more)}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  const he = host.EDITS.find((x) => x.name === 'session list leaves out background sessions');
  const src = 'class S{cwd="/w";async attachSessionPermissionModes(e){}async buildSessionList(){let n=[{id:"a"},{id:"b"}];return this.onSessionsListed?.([]),await this.attachSessionPermissionModes(n),n}}';
  const r = he ? applyEdits(src, [he]) : { error: 'no such edit' };
  if (r.error) bad('the background-session edit did not apply: ' + r.error);
  else {
    // The patched function is async, and this suite is not, so it runs in a child process.
    const script = r.out + `;(async()=>{let seen=null;const run=async(h)=>{globalThis.__cceListedSessions=h;`
      + `return(await new S().buildSessionList()).map((x)=>x.id).join(",")};`
      + `const kept=await run((l,c)=>{seen=c;return l.filter((x)=>x.id!=="a")});`
      + `const none=await run(undefined),broken=await run(()=>{throw new Error("x")}),odd=await run(()=>"not a list");`
      + `process.stdout.write(JSON.stringify([kept,seen,none,broken,odd]))})()`;
    const child = require('child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    if (child.stdout === JSON.stringify(['b', '/w', 'a,b', 'a,b', 'a,b'])) {
      ok('the patched host hands its finished list and its folder to this extension, and keeps the list as it was when that fails or is missing');
    } else bad(`the patched list was ${child.stdout || child.stderr}`);
  }
  const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const setting = require('../package.json').contributes.configuration.properties['claudeCodePlus.hideBackgroundSessions'];
  if (/globalThis\.__cceListedSessions = \(entries, cwd\) => \{\s*if \(removed\(\) \|\| cfg\(\)\.get\(HIDE_BG_SETTING, true\) === false\) return entries;/.test(extSrc)
      && /if \(e\.affectsConfiguration\(HIDE_BG_SETTING\)\) \{\s*try \{ if \(typeof globalThis\.__cceSessionsChanged === 'function'\) globalThis\.__cceSessionsChanged\(\);/.test(extSrc)
      && setting && setting.default === true) {
    ok('background sessions are left out by default, a setting turns that off, and flipping it makes every panel read the list again');
  } else bad('the background-session setting is not wired as expected');
}
console.log('\nconversations whose background sessions are busy');
{
  const bgr = require('../src/background');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-busy-'));
  try {
    const sessions = path.join(root, 'sessions'), plans = path.join(root, 'plans');
    fs.mkdirSync(sessions); fs.mkdirSync(plans);
    const rec = (pid, o) => fs.writeFileSync(path.join(sessions, pid + '.json'), JSON.stringify(Object.assign({ pid }, o)));
    rec(11, { kind: 'bg', jobId: 'aaaa1111', status: 'busy' });
    rec(12, { kind: 'bg', jobId: 'bbbb2222', status: 'shell' });
    rec(13, { kind: 'bg', jobId: 'cccc3333', status: 'idle' });
    rec(14, { kind: 'interactive', jobId: 'dddd4444', status: 'busy' });
    rec(15, { kind: 'bg', jobId: 'eeee5555', status: 'busy' });
    fs.writeFileSync(path.join(sessions, 'notes.txt'), 'x');
    const busy = bgr.busyJobs(sessions, (pid) => pid !== 15);
    const S1 = '11111111-1111-4111-8111-111111111111', S2 = '22222222-2222-4222-8222-222222222222';
    fs.writeFileSync(path.join(plans, S1 + bgr.SUFFIX), JSON.stringify({ ids: ['cccc3333', 'bbbb2222'], scannedTo: 1 }));
    fs.writeFileSync(path.join(plans, S2 + bgr.SUFFIX), JSON.stringify({ ids: ['cccc3333', 'eeee5555'], scannedTo: 1 }));
    const conv = bgr.working({ dir: plans, busy });
    if (JSON.stringify([...busy].sort()) === '["aaaa1111","bbbb2222"]' && JSON.stringify([...conv]) === JSON.stringify([S1])) {
      ok('busy bg sessions are found and mapped to the conversation that started them');
    } else bad(`busy ${JSON.stringify([...busy])}, conversations ${JSON.stringify([...conv])}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  if (/i && i\.state === 'idle' && bgWorking\.has\(i\.sessionId\) \? Object\.assign\(\{\}, i, \{ state: 'running' \}\)/.test(ext)
      && /globalThis\.__cceRefreshTabIcons\(\)/.test(ext) && /globalThis\.__cceSendSessionStates\(\)/.test(ext)) {
    ok('an idle conversation with a busy bg session is reported as running');
  } else bad('extension.js does not mark conversations whose background sessions are busy');
}

console.log('\nthe patch markers follow the code');
{
  /* A marker that stays the same while what patching writes changes leaves the old patch in place, and every step
     after it - packaging, installing, reloading - reports success. Each module is loaded again with one replacement
     changed and nothing else; its marker has to change. */
  const Module = require('module');
  const reload = (file, edit) => {
    const full = path.join(__dirname, '..', 'src', file);
    const src = fs.readFileSync(full, 'utf8');
    const changed = edit(src);
    if (changed === src) return null;
    const m = new Module(full, null);
    m.filename = full; m.paths = Module._nodeModulePaths(path.dirname(full));
    m._compile(changed, full);
    return m.exports.MARK;
  };
  const cases = [
    ['src/host.js', 'host.js', require('../src/host').MARK, (src) => src.replace('?"cce-pin-to-sidebar":', '?"cce-pin-to-sidebar-x":')],
    ['src/webview.js', 'webview.js', require('../src/webview').MARK, (src) => src.replace('cceWhere:cceW})}`', 'cceWhere:cceW,x:1})}`')],
    // An edit with several shapes has no pattern or replacement of its own; one of its shapes changing counts all the same.
    ['src/webview.js, one shape of an edit with several', 'webview.js', require('../src/webview').MARK,
      (src) => src.replace('${row}.setToolResult(${item},${opts});', '${row}.setToolResult(${item},${opts}) ;')],
  ];
  for (const [label, file, now, edit] of cases) {
    const other = reload(file, edit);
    if (other === null) bad(`${label}: the replacement to change was not found`);
    else if (other !== now && other.startsWith(now.slice(0, now.indexOf('-')))) ok(`${label}: changing one edit's replacement changes the marker, without the number being raised`);
    else bad(`${label}: the marker stayed ${now} after a replacement changed`);
  }
}

/* ── conversations ──
   What Claude Code's source lists: this workspace's running conversations from `claude agents --json` with their state
   as Claude Code reports it, and the stopped ones whose plans still have open rows. */
console.log('\nconversations');
{
  const w = require('../src/waiting');
  const conv = require('../src/conversations');
  const bgs = require('../src/bgsessions');
  /* Ages are drawn against the clock, so the times are set against it too. */
  const DAY = 24 * 3600 * 1000, now = Date.now();
  const S = (n) => '9' + String(n).padStart(7, '0') + '-0000-0000-0000-000000000000';

  if (w.isDefaultName('claude-code-extras-92', '/x/claude-code-extras') && w.isDefaultName('manfredstoredevtool-dev-db', '/a/ManfredStoreDevTool-dev')
    && !w.isDefaultName('ADV returns N dbs', '/x/claude-code-extras') && !w.isDefaultName('claude-code-extras', '/x/claude-code-extras')) {
    ok('a name Claude Code made up from the folder is told apart from one somebody gave');
  } else bad('isDefaultName misjudged a name');

  const merged = w.merge([
    { sessionId: S(1), id: 'aaaa1111', kind: 'interactive', cwd: '/x/c', name: 'c-92', status: 'idle' },
    { sessionId: S(1), id: 'aaaa1111', kind: 'interactive', cwd: '/x/c', name: 'Release work', status: 'waiting', waitingFor: 'permission prompt' },
    { sessionId: S(2), id: 'bbbb2222', kind: 'interactive', cwd: '/x/c', name: 'asks', status: 'idle' },
    { sessionId: S(3), id: 'cccc3333', kind: 'interactive', cwd: '/x/c', name: 'busy one', status: 'busy' },
    { sessionId: S(4), id: 'dddd4444', kind: 'interactive', cwd: '/x/c', name: 'unread one', status: 'idle' },
    { sessionId: S(5), id: 'eeee5555', kind: 'interactive', cwd: '/x/c', name: 'c-5f', status: 'idle' },
    { nope: true },
  ]);
  const one = merged.get(S(1));
  if (merged.size === 5 && one.processes === 2 && one.name === 'Release work' && one.waitingFor === 'permission prompt'
    && merged.get(S(3)).busy === true && merged.get(S(2)).busy === false) {
    ok('two processes holding one conversation are one conversation, waiting if either is, busy if either is running a turn');
  } else bad(`merged ${JSON.stringify([...merged.values()])}`);

  const pids = w.pidsOf([
    { sessionId: S(1), pid: 4321 }, { sessionId: S(1), pid: 812 }, { sessionId: S(1), pid: 812 },
    { sessionId: S(1), pid: '99' }, { sessionId: S(1), pid: -3 }, { sessionId: S(2), pid: 77 }, null,
  ], S(1));
  if (JSON.stringify(pids) === '[812,4321]' && JSON.stringify(w.pidsOf([{ sessionId: S(2), pid: 77 }], S(1))) === '[]') {
    ok('pidsOf drops duplicates and other sessions, and sorts');
  } else bad(`pidsOf ${JSON.stringify(pids)}`);

  {
    const live = new Map([[S(5), 'running'], [S(6), 'waiting']]), unread = new Set([S(4)]);
    const states = [S(1), S(2), S(3), S(4), S(5)].map((id) => conv.stateOf(merged.get(id), live, unread));
    const asked = conv.stateOf({ sessionId: S(6) }, live, unread);
    if (states.join() === 'prompt,idle,working,unread,working' && asked === 'prompt') {
      ok('a conversation\'s state comes from Claude Code');
    } else bad(`states ${states.join()}, ${asked}`);
  }

  {
    /* Stopped conversations: listed when the plan was written in the last week, still has open rows, and the transcript
       was started in a workspace folder; never when the conversation is still running. */
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-stopped-')));
    const dir = path.join(root, 'plans'), ws = path.join(root, 'ws'), elsewhere = path.join(root, 'other');
    for (const d of [dir, ws, elsewhere]) fs.mkdirSync(d);
    const transcripts = {};
    const put = (n, cwd, nodes, age) => {
      fs.writeFileSync(path.join(dir, S(n) + '.json'), JSON.stringify({ nodes }));
      const back = (Date.now() - age) / 1000;
      fs.utimesSync(path.join(dir, S(n) + '.json'), back, back);
      const t = path.join(root, S(n) + '.jsonl');
      fs.writeFileSync(t, JSON.stringify({ type: 'user', cwd, sessionId: S(n) }) + '\n');
      transcripts[S(n)] = t;
    };
    const openRow = [{ title: 'x', state: 'todo' }];
    put(21, ws, openRow, DAY);
    put(22, elsewhere, openRow, DAY);
    put(23, ws, openRow, 9 * DAY);
    put(24, ws, [{ title: 'x', state: 'done' }], DAY);
    put(25, ws, openRow, DAY);
    const readPlan = (id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); } catch (_) { return null; } };
    const got = conv.stoppedWithOpenRows([ws], new Set([S(25)]), { dir, readPlan, find: (id) => transcripts[id] || '' });
    if ([...got.keys()].join() === S(21) && conv.transcriptCwd(transcripts[S(21)]) === ws) {
      ok('a stopped conversation is listed when its plan is recent, has open rows and it was started in this workspace');
    } else bad(`stopped ${[...got.keys()]}`);
    fs.rmSync(root, { recursive: true, force: true });
  }


  {
    /* Only this workspace's conversations, by real path, and never a background session. */
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-ws-')));
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-ws-other-')));
    fs.mkdirSync(path.join(root, 'sub'));
    fs.mkdirSync(root + '-sibling');
    const link = path.join(other, 'link');
    fs.symlinkSync(root, link);
    const sessions = w.merge([
      { sessionId: S(11), kind: 'interactive', cwd: root, status: 'waiting' },
      { sessionId: S(12), kind: 'interactive', cwd: path.join(root, 'sub'), status: 'idle' },
      { sessionId: S(13), kind: 'interactive', cwd: other, status: 'waiting' },
      { sessionId: S(14), kind: 'background', cwd: root, state: 'blocked' },
      { sessionId: S(15), kind: 'interactive', cwd: path.join(link, 'sub'), status: 'idle' },
      { sessionId: S(16), kind: 'interactive', cwd: root + '-sibling', status: 'waiting' },
    ]);
    const kept = [...w.inFolders(sessions, [root]).keys()].sort().join();
    if (kept === [S(11), S(12), S(15)].sort().join() && w.inFolders(sessions, []).size === 0) {
      ok('Waiting on you takes the conversations started in a workspace folder or under one, through links, and no background session');
    } else bad(`inFolders kept ${kept}`);
    /* claude agents calls both of these interactive; only S(17)'s transcript says bg. */
    const projects = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-ws-projects-')));
    const resumed = w.merge([
      { sessionId: S(17), kind: 'interactive', cwd: root, status: 'busy' },
      { sessionId: S(18), kind: 'interactive', cwd: root, status: 'busy' },
    ]);
    for (const [n, kind] of [[17, 'bg'], [18, '']]) {
      const dir = path.join(projects, bgs.folderName(root));
      fs.mkdirSync(dir, { recursive: true });
      const first = { parentUuid: null, type: 'user', cwd: root, sessionId: S(n), entrypoint: 'cli' };
      if (kind) first.sessionKind = kind;
      fs.writeFileSync(path.join(dir, S(n) + '.jsonl'), JSON.stringify({ type: 'mode' }) + '\n' + JSON.stringify(first) + '\n');
    }
    const isBackground = (id, cwd) => bgs.isBackground(id, cwd, projects);
    const left = [...w.inFolders(resumed, [root], { isBackground }).keys()].join();
    if (left === S(18)) ok('a background session resumed with claude -p is left out, by the kind its transcript records');
    else bad(`inFolders kept ${left} of the resumed sessions`);
    for (const d of [root, other, root + '-sibling', projects]) fs.rmSync(d, { recursive: true, force: true });
  }

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-wait-'));
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, [
      '{"type":"custom-title","customTitle":"First name","sessionId":"x"}',
      '{"type":"ai-title","aiTitle":"Old AI","sessionId":"x"}',
      '{"type":"user","message":"..."}',
      '{"type":"custom-title","customTitle":"Second name","sessionId":"x"}',
      '{"type":"ai-title","aiTitle":"New AI","sessionId":"x"}',
      '{"type":"assistant"}',
    ].join('\n') + '\n');
    const t = w.transcriptTitles(file);
    if (t.custom === 'Second name' && t.ai === 'New AI') ok('a conversation is titled from the last titles its transcript carries');
    else bad(`titles ${JSON.stringify(t)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    /* In a child process, because this script ends synchronously and a result that arrives later would never be counted. */
    const script = `const w = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'waiting.js'))});
      let got = null;
      const fake = (out) => (bin, args, opts, cb) => { got = args; cb(null, out, ''); };
      Promise.all([w.listAgents('claude', fake('[{"sessionId":"s","status":"idle"}]')), w.listAgents('claude', fake('not json')),
        w.listAgents('')]).then((r) => console.log(JSON.stringify([got].concat(r))));`;
    const r = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    let got, good, broken, none;
    try { [got, good, broken, none] = JSON.parse(r.stdout); } catch (_) { got = null; }
    if (got && got.join(' ') === 'agents --json' && good.records.length === 1 && broken.records === null && broken.error
      && none.records === null && none.error) {
      ok('the running conversations come from `claude agents --json`, and an answer that is not a list is reported, not shown as nothing');
    } else bad(`listAgents: ${r.stdout} ${r.stderr}`);
  }
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-wait-home-'));
    const id = S(9);
    const dir = path.join(home, '.claude', 'plugins', 'data', require('../src/plugin-install').DATA_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ nodes: [
      { title: 'legacy', state: 'waiting', note: 'on the user' },
      { title: 'odd', state: 'waiting', waitingOn: 'robots', question: 'x' },
      { title: 'asks', state: 'waiting', waitingOn: 'user', question: 'Line one\n line two?' },
      { title: 'build', state: 'waiting', waitingOn: 'build', question: 'not for the user' },
    ] }));
    const script = `const p = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'workplan.js'))}).readPlan(${JSON.stringify(id)});`
      + 'console.log(JSON.stringify(p.nodes.map((n) => [n.waitingOn, n.question])))';
    let r = null;
    try { r = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }) })); }
    catch (e) { r = String(e); }
    if (JSON.stringify(r) === JSON.stringify([['', ''], ['', ''], ['user', 'Line one line two?'], ['build', '']])) {
      ok('a plan written before the field, or with a party the view does not know, reads as unknown rather than failing');
    } else bad(`read back ${JSON.stringify(r)}`);
    fs.rmSync(home, { recursive: true, force: true });
  }

}

console.log('\nanswering from the Conversations tab');
{
  /* The host hands an answer only to the panel showing that conversation, and asked without text only says whether it has one. */
  {
    const host = require('../src/host');
    const edit = host.EDITS.find((e) => e.name === 'tab record at start');
    const code = edit.to('', 'settings');
    const m = /globalThis\.__cceAnswer=(\(cceId,cceText,cceKey\)=>\{.*?return!0\}),/.exec(code);
    const sentTo = [];
    const comm = (name) => ({ send: (msg) => sentTo.push([name, msg]) });
    const tab = {}, fake = { sessionPanels: new Map([['A', tab]]), panelComms: new Map([[tab, comm('tab')]]), sidebarComms: comm('sidebar'),
      sidebarChatShows: () => 'B' };
    let fn = null;
    try { fn = m && new Function('return function(){ return ' + m[1] + '; }')().call(fake); } catch (_) { fn = null; }
    const results = fn ? [fn('A'), fn('B'), fn('C'), fn('A', 'hi', 'k1'), fn('B', 'yo', 'k2'), fn('C', 'no', 'k3')] : [];
    if (fn && JSON.stringify(results) === JSON.stringify([true, true, false, true, true, false])
      && JSON.stringify(sentTo) === JSON.stringify([['tab', { type: 'cce_answer', sessionId: 'A', text: 'hi', id: 'k1' }],
        ['sidebar', { type: 'cce_answer', sessionId: 'B', text: 'yo', id: 'k2' }]])) {
      ok('the host gives an answer to the tab or the sidebar showing that conversation, and to nothing else');
    } else bad(`host answer hand-off: ${JSON.stringify([!!m, results, sentTo])}`);

    const p = /globalThis\.__cceToPanel=(\(cceId,cceMsg\)=>\{.*?return!0\}),/.exec(code);
    sentTo.length = 0;
    let toPanel = null;
    try { toPanel = p && new Function('return function(){ return ' + p[1] + '; }')().call(fake); } catch (_) { toPanel = null; }
    const said = toPanel ? [toPanel('A', { type: 'cce_process', pids: [1] }), toPanel('B', { type: 'cce_process', pids: [] }),
      toPanel('C', { type: 'cce_process', pids: null })] : [];
    if (toPanel && JSON.stringify(said) === '[true,true,false]'
      && JSON.stringify(sentTo) === JSON.stringify([['tab', { type: 'cce_process', pids: [1] }], ['sidebar', { type: 'cce_process', pids: [] }]])) {
      ok('__cceToPanel sends only to the tab or sidebar showing the conversation');
    } else bad(`host process hand-off: ${JSON.stringify([!!p, said, sentTo])}`);
  }

  {
    const host = require('../src/host');
    const edit = host.EDITS.find((e) => e.name === 'panel messages');
    const fn = 'function eT($,J){let Q=`Received message from webview: ${bl0(J)}`;$.info(Q)}';
    const r = require('../src/edits').applyEdits(fn, [edit]);
    const asked = [];
    const env = { bl0: (m) => JSON.stringify(m), out: null, __cceProcessHook: (id) => asked.push(id) };
    env.globalThis = env;
    vm.createContext(env);
    if (!r.error) {
      vm.runInContext(r.out + ';eT({info:(q)=>out=q},{type:"cce_process_ask",sessionId:"s1"});'
        + 'eT({info:(q)=>out=q},{type:"cce_process_ask",sessionId:7});', env);
    }
    if (!r.error && JSON.stringify(asked) === '["s1"]' && /^Received message from webview: /.test(env.out)) {
      ok('a cce_process_ask message reaches __cceProcessHook and is still logged');
    } else bad(`process question: ${r.error || JSON.stringify([asked, env.out])}`);
  }

  /* In a browser, against an input built like Claude Code's: an editable box whose Enter sends, or with Ctrl+Enter
     only when set so, and Shift+Enter a new line. The script under test is the one that ships. */
  {
    const harness = require('./page-harness');
    const browser = harness.findBrowser();
    if (!browser) {
      if (process.env.CCE_REQUIRE_BROWSER) bad('no Chrome or Chromium found, and this run requires one (CCE_REQUIRE_BROWSER)');
      else note('skipped: no Chrome or Chromium here for the answer test');
    } else {
      const mark = ['CCE', 'ANSWER:'].join('-');
      const html = '<!doctype html><html><body><pre id="out"></pre>'
        + '<div id="box" role="textbox" aria-label="Message input" contenteditable="plaintext-only"></div><script>'
        + 'var posted = [], sent = [], ctrlOnly = false, deaf = false, leftover = null;'
        + 'window.acquireVsCodeApi = function(){ return { postMessage: function(m){ posted.push(m); } }; };'
        + 'document.getElementById("box").addEventListener("keydown", function(e){'
        + '  if (deaf || e.key !== "Enter" || e.shiftKey) return;'
        + '  if (ctrlOnly && !(e.ctrlKey || e.metaKey)) return;'
        + '  e.preventDefault(); sent.push(this.innerText); this.textContent = ""; });'
        + '</script><script>' + require('../src/webview').SCRIPT + '</script><script>'
        + 'var host = function(text, id){ window.postMessage({ type: "from-extension", message: { type: "cce_answer", sessionId: "S", text: text, id: id } }, "*"); };'
        + 'setTimeout(function(){ host("Row 1, my answer:\\nline two", "a1"); }, 2500);'
        + 'setTimeout(function(){ document.getElementById("box").textContent = "mine"; host("not now", "a2"); }, 4500);'
        + 'setTimeout(function(){ document.getElementById("box").textContent = ""; ctrlOnly = true; host("with ctrl", "a3"); }, 6500);'
        + 'setTimeout(function(){ deaf = true; host("ignored", "a4"); }, 8500);'
        + 'setTimeout(function(){ var b = document.getElementById("box"); leftover = b.textContent; b.remove(); host("nowhere", "a5");'
        + '  setTimeout(function(){ document.getElementById("out").textContent = "' + mark + '" + JSON.stringify({ posted: posted, sent: sent, leftover: leftover }); }, 1500); }, 10500);'
        + '</script></body></html>';
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-answer-page-'));
      const file = path.join(dir, 'panel.html');
      fs.writeFileSync(file, html);
      const r = cp.spawnSync(browser, ['--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=16000', '--dump-dom',
        'file://' + file], { encoding: 'utf8', timeout: 120000 });
      fs.rmSync(dir, { recursive: true, force: true });
      const at = (r.stdout || '').indexOf(mark);
      let got = null;
      try {
        got = JSON.parse(r.stdout.slice(at + mark.length, r.stdout.indexOf('<', at)).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
      } catch (_) { got = null; }
      const results = got ? got.posted.filter((m) => m.type === 'cce_answer_result').map((m) => [m.id, m.sent, m.reason]) : [];
      if (got && JSON.stringify(results) === JSON.stringify([['a1', true, ''], ['a2', false, 'draft'], ['a3', true, ''],
        ['a4', false, 'left-in-input'], ['a5', false, 'no-input']]) && got.leftover === ''
        && got.sent.length === 2 && got.sent[0].replace(/\s+/g, ' ').trim() === 'Row 1, my answer: line two' && got.sent[1].trim() === 'with ctrl') {
        ok('in a browser the panel types an answer into an empty input and sends it, Ctrl+Enter mode included, leaves text of yours alone, and takes back one it could not send');
      } else bad(`answer in the page: ${at === -1 ? 'no result (exit ' + r.status + ')' : JSON.stringify(got)}`);
    }
  }

  {
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'page', f), 'utf8');
    const posted = [];
    const box = { out: {}, window: { addEventListener() {} }, document: { querySelector: () => null }, setTimeout,
      sessionRef: { sessionId: { value: 'B' } }, acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }) };
    new vm.Script('(function(){var sigValue = function(n){ var s = sessionRef && sessionRef[n]; return s ? s.value : undefined; };'
      + read('91-answer.js') + '\n;out.sendAnswer = sendAnswer;})()', { filename: 'answer-switch' }).runInNewContext(box);
    box.out.sendAnswer({ type: 'cce_answer', sessionId: 'A', text: 'hi', id: 'k1' });
    box.out.sendAnswer({ type: 'cce_answer', sessionId: 'B', text: 'hi', id: 'k2' });
    const got = posted.map((m) => [m.id, m.sent, m.reason]);
    if (JSON.stringify(got) === JSON.stringify([['k1', false, 'not-shown'], ['k2', false, 'no-input']])) {
      ok('an answer for another conversation is not typed into the panel');
    } else bad(`answer to a switched panel: ${JSON.stringify(got)}`);
  }
}

/* The to-do tools gate (test/todo-gate.js), on stand-ins shaped like the 2.1.318 CLI and on any CLI installed here. */
console.log('\nthe built-in to-do tools');
{
  const gate = require('./todo-gate');
  const cli = (models) => Buffer.from('x'.repeat(5000) + `var Q=new Set([${models.map((m) => `"${m}"`).join(',')}]);`
    + 'function f(e){return Q.has(e)}function a8(){let e=g();if(e===void 0||f(e))return!0;'
    + 'return i.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0}', 'latin1');
  const old = gate.gateOf(cli(['claude-3-opus', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5']));
  const back = gate.gateOf(cli(['claude-opus-4-7', 'claude-opus-5', 'claude-sonnet-5-5']));
  const gone = gate.gateOf(Buffer.from('var Q=new Set(["claude-opus-4-7"]);function a8(){return!0}'));
  if (old.models && old.models.length === 4 && !gate.currentOn(old.models).length) ok('gateOf finds the model list before the switch');
  else bad(`to-do gate on the 2.1.318 shape: ${JSON.stringify(old)}`);
  if (JSON.stringify(gate.currentOn(back.models || [])) === '["claude-opus-5","claude-sonnet-5-5"]') ok('currentOn flags 5.x models');
  else bad(`to-do gate with 5.x models listed: ${JSON.stringify(back)}`);
  if (gone.error) ok('gateOf reports a missing switch');
  else bad(`to-do gate without the switch: ${JSON.stringify(gone)}`);
  const real = Array.from(new Set(extensionsDirs())).flatMap((d) => webview.findInstalls(d))
    .map((d) => path.join(d, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude'))
    .filter((f) => fs.existsSync(f));
  if (!real.length) note('no Claude Code CLI installed here to read the to-do tools list from');
  else {
    const lists = real.map((f) => gate.gateOf(fs.readFileSync(f)));
    const wrong = lists.filter((r) => r.error || gate.currentOn(r.models).length);
    if (!wrong.length) ok(`in the ${real.length} installed CLI(s) no current model gets the built-in to-do tools`);
    else bad(`installed CLI: ${JSON.stringify(wrong)}`);
  }
}

console.log('\nthe workflows');
{
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  const bare = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
    fs.readFileSync(path.join(dir, name), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*if:/.test(line) && /steps\./.test(line) && !/(always|failure|success|cancelled)\(\)/.test(line)) bare.push(`${name}:${i + 1}`);
    });
  }
  if (!bare.length) ok('every workflow if: that reads a step output names failure() or always()');
  else bad(`a step condition that skips after a failure: ${bare.join(', ')}`);
}

console.log('\nplan rows in unknown states');
{
  const plan = require('../src/workplan');
  const conv = require('../src/conversations');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-plan-at-'));
  try {
    const file = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(file, JSON.stringify({ title: 'here', nodes: [
      { title: 'known', state: 'todo' },
      { title: 'newer', state: 'blocked', waitingOn: 'user', question: 'Is this asked?' },
      { title: 'no state' },
      { title: 'parent', state: 'doing', children: [{ title: 'odd child', state: 'snoozed' }] },
    ] }));
    const p = plan.readPlanAt(file, 'abc12345');
    const states = p && p.nodes.map((n) => n.state).concat(p.nodes[3].children.map((n) => n.state));
    if (p && p.file === file && p.session === 'abc12345' && p.title === 'here'
      && JSON.stringify(states) === JSON.stringify(['todo', 'blocked', 'todo', 'doing', 'snoozed'])
      && plan.readPlanAt(path.join(dir, 'missing.json'), 'abc12345') === null && plan.readPlanAt(file, '') === null) {
      ok('readPlanAt() reads the given path and keeps unknown states');
    } else bad(`readPlanAt: ${JSON.stringify(p)}`);
    if (conv.openCount(p.nodes) === 3) ok('openCount() leaves out rows in unknown states');
    else bad(`open rows counted: ${conv.openCount(p.nodes)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/* ── Claude Code as a source of Agent Plus ──
   Agent Plus (xnervwang.agent-plus) draws the work plan, Conversations and Answer views; this extension gives
   it Claude Code's conversations through registerSource(), protocol 1 (its docs/protocol.md). */
console.log('\nwhat the manifest declares for Agent Plus');
{
  const pkg = require('../package.json');
  const c = pkg.contributes;
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'claude-source.js'), 'utf8');
  const protocol = Number((/^const PROTOCOL = (\d+);$/m.exec(source) || [])[1]);
  const trust = (pkg.capabilities || {}).untrustedWorkspaces || {};
  if ((pkg.extensionDependencies || []).includes('xnervwang.agent-plus') && pkg.agentPlus && pkg.agentPlus.protocol === protocol
    && JSON.stringify(pkg.extensionKind) === '["workspace"]' && trust.supported === 'limited' && typeof trust.description === 'string'
    && trust.description.length > 40) {
    ok('the manifest has what Agent Plus requires of a source');
  } else bad(`manifest for Agent Plus: ${JSON.stringify([pkg.extensionDependencies, pkg.agentPlus, pkg.extensionKind, trust, protocol])}`);
  const props = Object.keys(c.configuration.properties);
  if (!c.views && !c.viewsContainers && !c.viewsWelcome && !c.menus
    && !props.some((k) => /\.(conversations|webviewRequestLimit)$/.test(k)) && props.includes('claudeCodePlus.workPlan')) {
    ok('the manifest has no views, menus or view settings left');
  } else bad(`left over in the manifest: ${JSON.stringify({ views: c.views, containers: c.viewsContainers, menus: c.menus, props })}`);
  const declared = c.commands.map((x) => x.command.replace(/^claudeCodePlus\./, ''));
  const missing = declared.filter((n) => !ext.includes(`registerCommand('${n}'`));
  if (!missing.length) ok(`each of the ${declared.length} commands it declares is registered`);
  else bad(`declared but not registered: ${missing.join(', ')}`);
}

console.log('\nClaude Code\'s own source');
{
  /* Runs in a child process because deliveries resolve later. The panel's wait is cut short by a setTimeout that runs
     anything of the source's length at once. */
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-claude-source-')));
  try {
    const stub = path.join(home, 'vscode-stub.js');
    fs.writeFileSync(stub, `module.exports = { TabInputWebview: class { constructor(v) { this.viewType = v; } } };`);
    const script = `
      const Module = require('module'), realResolve = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) { return request === 'vscode' ? ${JSON.stringify(stub)} : realResolve.call(this, request, ...rest); };
      const vs = require(${JSON.stringify(stub)});
      const C = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'claude-source.js'))});
      const realTimeout = setTimeout;
      global.setTimeout = (fn, ms, ...a) => realTimeout(fn, ms === C.ANSWER_WAIT_MS ? 20 : ms, ...a);
      const SID = 'abababab-1111-4222-8333-444444444444';
      let chat = '', handed = [], shown = [], on = true;
      const c = C.createClaudeSource({ planDir: () => '/plans', enabled: () => on, timeZone: () => 'Asia/Tokyo',
        listAgents: async () => ({ records: null, error: 'no cli' }), folders: () => [],
        readPlan: () => null, titles: () => ({ custom: '', ai: '' }), since: () => 0, live: () => new Map(), unread: () => new Set(),
        activeChat: () => chat, logo: () => null, canDeliver: (id) => id === 'A',
        hand: (id, text, key) => { handed.push([id, text, key]); return id === 'A'; },
        reveal: async (...a) => { shown.push(a); return false; } });
      const heard = [], notices = [];
      c.source.onDidFocus((e) => heard.push(e.sessionId));
      c.source.onDidChangePlanNotice(() => notices.push(c.source.planNotice()));
      const out = {};
      out.shape = [c.source.protocol, c.source.id, c.source.label, JSON.stringify(c.source.features), c.source.extensionId,
        c.source.planPath(SID), c.source.planPath('S'), c.source.planDir(), c.source.logo, c.source.timeZone()];
      on = false; out.planOff = c.source.planPath(SID); on = true;
      const panel = (column, visible, active) => {
        const p = { viewColumn: column, visible, active, l: [], d: [] };
        p.onDidChangeViewState = (fn) => { p.l.push(fn); return { dispose() {} }; };
        p.onDidDispose = (fn) => { p.d.push(fn); return { dispose() {} }; };
        return p;
      };
      const p1 = panel(2, true, false), p2 = panel(2, false, false), p3 = panel(1, true, true), p4 = panel(4, true, true);
      c.track(p1, 'A'); c.track(p2, 'B'); c.track(p3, 'C'); c.track(p1, 'A'); c.track(p4, '');
      const tab = (viewType, column) => ({ input: new vs.TabInputWebview(viewType), group: { viewColumn: column } });
      out.claims = [c.source.sessionForTab(tab('mainThreadWebview-claudeVSCodePanel', 2)), c.source.sessionForTab(tab('mainThreadWebview-claudeVSCodePanel', 1)),
        c.source.sessionForTab(tab('mainThreadWebview-markdown.preview', 2)), c.source.sessionForTab({ input: { viewType: 'claudeVSCodePanel' }, group: { viewColumn: 2 } }),
        c.source.sessionForTab(tab('mainThreadWebview-claudeVSCodePanel', 3)), c.source.sessionForTab(tab('mainThreadWebview-claudeVSCodePanel', 4)), C.isPanelTab(null)];
      out.listeners = p1.l.length;
      p1.active = true; p1.l.forEach((f) => f({})); p2.l.forEach((f) => f({}));
      c.track(p1, 'A2');
      out.focusedA2 = c.source.isFocused('A2');
      p1.d.forEach((f) => f());
      out.afterDispose = c.source.sessionForTab(tab('mainThreadWebview-claudeVSCodePanel', 2));
      chat = 'X'; out.follow = [c.followChat(), c.followChat()]; chat = ''; out.follow.push(c.followChat());
      c.pageFocus('Y'); c.pageFocus(''); c.pageFocus(42);
      out.focused = [c.source.isFocused('Y'), c.source.isFocused('C'), c.source.isFocused('A2'), c.source.isFocused('Q'), c.source.isFocused('')];
      const codexTab = { input: { viewType: 'chatgpt.conversationEditor' }, group: { viewColumn: 1 } };
      const claudeTab = tab('mainThreadWebview-claudeVSCodePanel', 1);
      c.tabsChanged(claudeTab); out.afterClaudeTab = c.source.isFocused('Y');
      c.tabsChanged(codexTab); out.afterCodexTab = c.source.isFocused('Y');
      c.pageFocus('Y'); c.tabsChanged(codexTab); out.sameTabAgain = c.source.isFocused('Y');
      c.refocus();
      out.heard = heard.slice();
      const notice = { title: 'T', description: 'd', detail: 'x', command: 'c', arguments: [] };
      c.setNotice(notice); c.setNotice(Object.assign({}, notice)); c.setNotice(null);
      out.notices = notices;
      (async () => {
        const last = () => handed[handed.length - 1][2];
        out.notShown = await c.source.deliverAnswer('B', 'hi', { deliveryId: 'd0' });
        const p = c.source.deliverAnswer('A', 'yes', { deliveryId: 'd1' });
        c.answered('no-such-key', true, '');
        c.answered(last(), false, 'draft');
        out.draft = await p;
        const retry = c.source.deliverAnswer('A', 'yes', { deliveryId: 'd1' });
        out.retried = handed.length;
        c.answered(last(), true, '');
        out.sent = await retry;
        out.again = await c.source.deliverAnswer('A', 'yes', { deliveryId: 'd1' });
        out.handedForD1 = handed.filter((h) => h[1] === 'yes').length;
        const odd = c.source.deliverAnswer('A', 'odd', { deliveryId: 'd2' });
        c.answered(last(), false, 'error');
        out.error = await odd;
        out.silent = await c.source.deliverAnswer('A', 'nobody answers', { deliveryId: 'd3' });
        for (let i = 0; i < 300; i++) c.source.deliverAnswer('B', 'other', { deliveryId: 'o' + i });
        await c.source.deliverAnswer('A', 'yes', { deliveryId: 'd1' });
        out.handedForD1Later = handed.filter((h) => h[1] === 'yes').length;
        const reasons = {};
        for (const r of ['not-shown', 'no-input', 'insert', 'left-in-input', 'something new']) reasons[r] = C.outcomeOf(false, r).outcome;
        out.reasons = reasons;
        out.canDeliver = [c.source.canDeliver('A'), c.source.canDeliver('B')];
        out.list = await c.source.listConversations();
        out.problem = out.list.problem;
        out.revealed = await c.source.reveal('Z');
        out.shown = shown;
        process.stdout.write(JSON.stringify(out));
      })().catch((e) => process.stdout.write(JSON.stringify({ threw: String(e && e.stack) })));`;
    const r = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
    let o = {};
    try { o = JSON.parse(r.stdout); } catch (_) { o = { threw: r.stdout + r.stderr }; }
    const SID = 'abababab-1111-4222-8333-444444444444';
    if (JSON.stringify(o.shape) === JSON.stringify([1, 'claude-code', 'Claude Code', '[]', 'xnervwang.claude-code-plus',
      path.join('/plans', SID + '.json'), null, '/plans', null, 'Asia/Tokyo']) && o.planOff === null) {
      ok('Claude Code\'s source has the protocol 1 members and plan paths');
    } else bad(`claude source shape ${JSON.stringify(o.shape || o)}, with the plan off ${JSON.stringify(o.planOff)}`);
    if (JSON.stringify(o.claims) === JSON.stringify(['A', 'C', null, null, '', '', false]) && o.listeners === 1 && o.afterDispose === '') {
      ok('sessionForTab() claims only Claude Code tabs');
    } else bad(`claims ${JSON.stringify([o.claims, o.listeners, o.afterDispose])}`);
    if (JSON.stringify(o.heard) === JSON.stringify(['C', 'A', 'A2', 'X', '', 'Y', 'Y', 'Y']) && JSON.stringify(o.follow) === '[true,false,true]') {
      ok('every Claude Code focus signal fires onDidFocus, including a front panel getting its session id');
    } else bad(`focus heard ${JSON.stringify([o.heard, o.follow])}`);
    if (o.focusedA2 === true && JSON.stringify(o.focused) === '[true,true,false,false,false]') {
      ok('isFocused() is true only for the latest signal or an active panel');
    } else bad(`isFocused ${JSON.stringify([o.focusedA2, o.focused])}`);
    if (o.afterClaudeTab === true && o.afterCodexTab === false && o.sameTabAgain === true) {
      ok('a focus signal is dropped once another agent\'s tab becomes active');
    } else bad(`focus after a tab change ${JSON.stringify([o.afterClaudeTab, o.afterCodexTab, o.sameTabAgain])}`);
    if (JSON.stringify(o.notices) === JSON.stringify([{ title: 'T', description: 'd', detail: 'x', command: 'c', arguments: [] }, null])) {
      ok('the plan notice fires only when it changes');
    } else bad(`plan notices ${JSON.stringify(o.notices)}`);
    const is = (x, outcome) => !!x && x.outcome === outcome && (outcome === 'submitted' || (typeof x.reason === 'string' && x.reason.length > 0));
    if (is(o.notShown, 'notReceived') && is(o.draft, 'notReceived') && o.retried === 3 && is(o.sent, 'submitted') && is(o.again, 'submitted')
      && o.handedForD1 === 2 && is(o.error, 'uncertain') && is(o.silent, 'uncertain')
      && JSON.stringify(o.reasons) === JSON.stringify({ 'not-shown': 'notReceived', 'no-input': 'notReceived', insert: 'notReceived',
        'left-in-input': 'notReceived', 'something new': 'uncertain' }) && JSON.stringify(o.canDeliver) === '[true,false]') {
      ok('deliverAnswer() outcomes and retries follow the protocol');
    } else bad(`claude delivery ${JSON.stringify(o).slice(0, 700)}`);
    if (o.handedForD1Later === 2) {
      ok('a delivery id is still recognized after 300 other deliveries');
    } else bad(`answer d1 typed ${o.handedForD1Later} times`);
    if (Array.isArray(o.list) && o.problem === 'no cli') {
      ok('listConversations() reports a failed `claude agents` as its problem');
    } else bad(`claude list ${JSON.stringify([o.list, o.problem])}`);
    if (o.revealed === false && JSON.stringify(o.shown) === JSON.stringify([['Z']])) {
      ok('reveal() passes the session id to the extension and returns its answer');
    } else bad(`reveal ${JSON.stringify([o.revealed, o.shown])}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

console.log('\nClaude Code\'s source and closed panels');
{

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-claude-review-')));
  try {
    const stub = path.join(home, 'vscode-stub.js');
    fs.writeFileSync(stub, `module.exports = { TabInputWebview: class { constructor(v) { this.viewType = v; } } };`);
    const cscript = `
      const Module = require('module'), realResolve = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) { return request === 'vscode' ? ${JSON.stringify(stub)} : realResolve.call(this, request, ...rest); };
      const vs = require(${JSON.stringify(stub)});
      const { createClaudeSource } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'claude-source.js'))});
      const c = createClaudeSource({ planDir: () => '/plans', listAgents: async () => ({ records: [], error: '' }), folders: () => [],
        readPlan: () => null, titles: () => ({ custom: 'Alpha', ai: '' }), since: () => 0, live: () => new Map(), unread: () => new Set(),
        activeChat: () => '', logo: () => null, canDeliver: () => false, hand: () => false, isBackground: () => false,
        reveal: async () => false });
      const panel = (column) => {
        const p = { viewColumn: column, visible: true, active: true, subs: [] };
        const sub = (fn) => { const d = { fn, disposed: false, dispose() { this.disposed = true; } }; p.subs.push(d); return d; };
        p.onDidChangeViewState = (fn) => sub(fn);
        p.onDidDispose = (fn) => sub(fn);
        return p;
      };
      (async () => {
        const out = {};
        const p1 = panel(1), p2 = panel(2);
        c.track(p1, 'P1'); c.track(p2, 'P2');
        const tab = (column) => ({ input: new vs.TabInputWebview('mainThreadWebview-claudeVSCodePanel'), group: { viewColumn: column } });
        p1.subs[1].fn();
        out.afterClose = [p1.subs.map((d) => d.disposed), c.source.sessionForTab(tab(1)), c.source.sessionForTab(tab(2))];
        c.dispose();
        out.afterDispose = [p2.subs.map((d) => d.disposed), c.source.sessionForTab(tab(2))];
        process.stdout.write(JSON.stringify(out));
      })().catch((e) => process.stdout.write(JSON.stringify({ threw: String(e && e.stack) })));`;
    const cr = cp.spawnSync(process.execPath, ['-e', cscript], { encoding: 'utf8', timeout: 30000 });
    let co = {};
    try { co = JSON.parse(cr.stdout); } catch (_) { co = { threw: cr.stdout + cr.stderr }; }
    if (JSON.stringify(co.afterClose) === JSON.stringify([[true, true], '', 'P2']) && JSON.stringify(co.afterDispose) === JSON.stringify([[true, true], ''])) {
      ok('panel subscriptions are disposed');
    } else bad(`panel subscriptions: ${JSON.stringify([co.afterClose, co.afterDispose, co.threw])}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

console.log('\na panel\'s page getting the focus');
{
  const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '92-focus.js'), 'utf8');
  const posted = [], listeners = {};
  const page = { sid: undefined, focused: false };
  const env = {
    out: {}, posted,
    window: { addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); } },
    document: { hasFocus: () => page.focused },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }),
    sigValue: (name) => (name === 'sessionId' ? page.sid : undefined),
  };
  vm.createContext(env);
  vm.runInContext(`(function(){${fragment}\n;out.listen = listenForFocus; out.ifFocused = sayFocusIfFocused;})()`, env, { filename: '92-focus.js' });
  env.out.listen();
  const fire = () => (listeners.focus || []).forEach((fn) => fn({}));
  fire();
  page.sid = 'S1'; fire();
  page.focused = false; env.out.ifFocused();
  page.focused = true; page.sid = 'S2'; env.out.ifFocused();
  if (JSON.stringify(posted) === JSON.stringify([{ type: 'cce_page_focus', sessionId: 'S1' }, { type: 'cce_page_focus', sessionId: 'S2' }])
    && (listeners.focus || []).length === 1) {
    ok('the page posts cce_page_focus when it gets focus');
  } else bad(`page focus posted ${JSON.stringify(posted)}`);
  const sweep = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '99-sweep.js'), 'utf8');
  const session = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '25-session.js'), 'utf8');
  if (/var boot = function\(\)\{[\s\S]*?try \{ listenForFocus\(\); \} catch \(e\) \{\}[\s\S]*?\};/.test(sweep)
    && /sessionRef = s;\s*try \{ sayFocusIfFocused\(\); \} catch \(e\) \{\}/.test(session) && webview.SCRIPT.includes('cce_page_focus')) {
    ok('the page focus listener is added at boot and on session switch');
  } else bad('the page focus is not wired into boot and the session switch');

  const edit = host.EDITS.find((e) => e.name === 'panel messages');
  const fn = 'function eT($,J){let Q=`Received message from webview: ${bl0(J)}`;$.info(Q)}';
  const r = require('../src/edits').applyEdits(fn, [edit]);
  const heard = [];
  const henv = { bl0: (m) => JSON.stringify(m), out: null, __cceFocusHook: (id) => heard.push(id) };
  henv.globalThis = henv;
  vm.createContext(henv);
  if (!r.error) {
    vm.runInContext(r.out + ';eT({info:(q)=>out=q},{type:"cce_page_focus",sessionId:"s1"});'
      + 'eT({info:(q)=>out=q},{type:"cce_page_focus",sessionId:7});eT({info:(q)=>out=q},{type:"cce_page_focus"});', henv);
  }
  if (!r.error && JSON.stringify(heard) === '["s1"]' && /^Received message from webview: /.test(henv.out)) {
    ok('a cce_page_focus message reaches __cceFocusHook and is still logged');
  } else bad(`page focus in the host: ${r.error || JSON.stringify([heard, henv.out])}`);
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  if (/globalThis\.__cceFocusHook = \(sessionId\) => \{\s*try \{ claude\.pageFocus\(sessionId\); \}/.test(ext)
    && /delete globalThis\.__cceFocusHook/.test(ext)) {
    ok('extension.js passes page focus to Claude Code\'s source');
  } else bad('extension.js does not pass the page focus on');
}

console.log('\nRestricted Mode');
{
  /* In a workspace that is not trusted, activation starts nothing: no timer, no hook for the patched host, no registration
     with Agent Plus, and nothing written under the home folder. Trusting the workspace starts all of it. */
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-restricted-')));
  try {
    const stub = path.join(home, 'vscode-stub.js');
    fs.writeFileSync(stub, `
      const disposable = { dispose() {} }, state = { trusted: false, grant: [], registered: 0 };
      const core = { isActive: true, exports: { agentPlus: { version: '1.0.0',
        registerSource: () => { state.registered++; return { accepted: true, code: '', reason: '', registration: disposable }; } } } };
      module.exports = { state, TabInputWebview: class {}, version: '1.120.0', env: { language: 'en' },
        Uri: { file: (p) => ({ fsPath: p }) }, RelativePattern: class {}, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        workspace: { get isTrusted() { return state.trusted; }, onDidGrantWorkspaceTrust: (fn) => { state.grant.push(fn); return disposable; },
          workspaceFolders: [], getConfiguration: () => ({ get: (k, d) => d, inspect: () => undefined, update: async () => {} }),
          onDidChangeConfiguration: () => disposable, onDidChangeWorkspaceFolders: () => disposable },
        window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }), showInformationMessage: async () => undefined,
          showWarningMessage: async () => undefined, setStatusBarMessage() {}, tabGroups: { all: [], activeTabGroup: null } },
        commands: { registerCommand: () => disposable, executeCommand: async () => {} },
        extensions: { getExtension: (id) => (id === 'xnervwang.agent-plus' ? core : undefined), onDidChange: () => disposable } };`);
    const root = path.join(__dirname, '..');
    const script = `
      const Module = require('module'), realResolve = Module._resolveFilename, path = require('path'), fs = require('fs');
      Module._resolveFilename = function (request, ...rest) { return request === 'vscode' ? ${JSON.stringify(stub)} : realResolve.call(this, request, ...rest); };
      const vs = require(${JSON.stringify(stub)});
      const ext = require(${JSON.stringify(path.join(root, 'extension.js'))});
      const store = path.join(${JSON.stringify(home)}, 'storage');
      const memo = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); } }; };
      const subs = [], timers = [], keep = setInterval;
      global.setInterval = (fn, ms) => { timers.push(ms); return keep(() => {}, 1 << 30); };
      const look = () => ({ timers: timers.slice().sort((a, b) => a - b), hooks: ['__cceTabIcon', '__cceChatHook', '__cceAnswerHook'].filter((n) => n in globalThis),
        registered: vs.state.registered, written: fs.readdirSync(${JSON.stringify(home)}).filter((f) => f !== 'vscode-stub.js').sort() });
      (async () => {
        const out = { threw: '' };
        try {
          await ext.activate({ subscriptions: subs, extensionPath: ${JSON.stringify(root)}, globalState: memo(), workspaceState: memo(),
            extension: { id: 'x.y', packageJSON: require(${JSON.stringify(path.join(root, 'package.json'))}) },
            globalStorageUri: { fsPath: store }, logUri: { fsPath: path.join(store, 'logs', 'exthost1', 'x.y') } });
          await new Promise((r) => setTimeout(r, 100));
          out.before = look();
          vs.state.trusted = true;
          for (const fn of vs.state.grant) fn();
          for (const fn of vs.state.grant) fn();
          await new Promise((r) => setTimeout(r, 300));
          out.after = look();
        } catch (e) { out.threw = String(e && e.stack); }
        for (const s of subs) { try { s.dispose(); } catch (e) { out.threw = out.threw || 'dispose: ' + e.message; } }
        process.stdout.write(JSON.stringify(out));
        process.exit(0);
      })();`;
    let r;
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
    delete env.CLAUDE_CONFIG_DIR;
    try { r = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000, env })); }
    catch (e) { r = { threw: e.message }; }
    const b = r.before || {}, a = r.after || {};
    if (!r.threw && JSON.stringify(b) === JSON.stringify({ timers: [], hooks: [], registered: 0, written: [] })) {
      ok('nothing starts in Restricted Mode');
    } else bad(`before the workspace is trusted: ${JSON.stringify(r).slice(0, 500)}`);
    if (!r.threw && a.timers.includes(30000) && a.hooks.length === 3 && a.registered === 1) {
      ok('trusting the workspace starts it once and registers the source');
    } else bad(`after the workspace is trusted: ${JSON.stringify(r).slice(0, 500)}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

/* ── with Agent Plus ──
   test/with-core.js activates Agent Plus from its checkout beside this one, then this extension, in Agent
   Plus's stand-in VS Code. It runs as a child with an empty home folder, since both extensions write under it. Without
   that checkout it notes so, which is not a failure. */
console.log('\nwith Agent Plus');
{
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-with-core-')));
  try {
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, AGENT_WORK_PLAN_HOME: path.join(home, 'shared') });
    delete env.CLAUDE_CONFIG_DIR;
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'with-core.js')], { encoding: 'utf8', timeout: 120000, env, cwd: home });
    let verdicts = null;
    try { verdicts = JSON.parse(r.stdout); } catch (_) { verdicts = null; }
    if (!Array.isArray(verdicts) || !verdicts.length) bad(`the run with Agent Plus did not report: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
    else for (const [kind, msg] of verdicts) (kind === 'ok' ? ok : kind === 'note' ? note : bad)(msg);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

const ran = `${passed} passed` + (skipped ? `, ${skipped} skipped for want of an install here` : '');
console.log(failures ? `\n${failures} check(s) failed (${ran})` : `\nall checks passed (${ran})`);
process.exit(failures ? 1 : 0);
