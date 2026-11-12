// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Runs the real injected script in a headless browser against a stand-in panel, and hands back what it counted.
 *
 * What is measured is counts, never milliseconds: how many sweeps an idle page ran, how many order comparisons and
 * queries a sweep made, how many DOM changes the script caused when nothing was happening. A count is the same on every
 * machine, so a threshold on it can be tight; a time is not, and a test that fails on a slow runner is soon ignored.
 *
 * The stand-in is built to the script's own assumptions - class-name fragments, and the props React hangs on each
 * element - so it tests this code against what it expects of the panel, not the panel itself. A change upstream is the
 * runtime self-check's to report, and test/against-latest.js's.
 *
 * Two things about the browser that make a broken measurement look like a clean one, both met while writing this:
 * - Under a virtual time budget an animation frame fires once and never again, and sweeps run in one. Without the shim
 *   below every page measures a single sweep, loop or no loop.
 * - The result is read out of the dumped DOM, and the scripts are part of that DOM, so the marker is assembled at run
 *   time and never appears in the source as one string.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARK = 'CCE-RESULT:';

function onPath(name) {
  const r = cp.spawnSync('sh', ['-c', 'command -v ' + name], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return r.status === 0 && p ? p : '';
}

/** A Chrome or Chromium to run, or ''. CCE_BROWSER names one outright. */
function findBrowser() {
  if (process.env.CCE_BROWSER) return fs.existsSync(process.env.CCE_BROWSER) ? process.env.CCE_BROWSER : '';
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const p = onPath(name);
    if (p) return p;
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  let dirs = [];
  try { dirs = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort(); } catch (_) { /* none */ }
  for (const d of dirs.reverse()) {
    const p = path.join(cache, d, 'chrome-linux64', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return '';
}

/* Runs before the injected script: the frame shim, the counters, and the stand-in panel with the object Claude Code's
   Focus view is read and set through.
   The counters wrap browser methods rather than anything of ours, so the script under test is byte for byte the one
   that ships. */
const SETUP = String.raw`
  window.requestAnimationFrame = function(cb){ return setTimeout(function(){ cb(performance.now()); }, 16); };
  var COUNT = { cdp: 0, qsa: 0, text: 0, dates: 0, gcs: 0 };
  var OBSERVED = [];
  /* Counts Date objects created (formatting a time creates one), to tell a sweep that formats only new messages from
     one that reformats every message. */
  (function(){
    var RealDate = window.Date;
    window.Date = class extends RealDate { constructor(...a) { super(...a); COUNT.dates++; } };
  })();
  /* Every request the revision poll starts, and every one it gives up on. With stallProbe the request is never answered,
     which is what a stalled webview resource looks like to the page; without it the real load goes ahead and only the
     count is taken, which is how the slower rate for a backgrounded window is measured. */
  var PROBES = { made: 0, cancelled: 0 };
  (function(){
    var Real = window.Image;
    window.Image = function(){
      if (CFG.stallProbe) {
        var el = { onload: null, onerror: null, naturalWidth: 0, naturalHeight: 0 }, src = '';
        Object.defineProperty(el, 'src', { get: function(){ return src; },
          set: function(v){ if (v === '') PROBES.cancelled++; else PROBES.made++; src = v; } });
        return el;
      }
      var img = new Real();
      var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      Object.defineProperty(img, 'src', { get: function(){ return d.get.call(img); },
        set: function(v){ if (v === '') PROBES.cancelled++; else PROBES.made++; d.set.call(img, v); } });
      // The revision the probe reads, moved by a flip as the extension moves it when it rewrites the live stylesheet.
      if (CFG.flip) {
        var w = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');
        Object.defineProperty(img, 'naturalWidth', { get: function(){ return window.__cceTestRev || w.get.call(img); } });
      }
      return img;
    };
  })();
  // A window nobody is looking at. The page reads document.hidden, which in a webview follows the editor window.
  if (CFG.windowHidden) {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: function(){ return true; } });
  }
  (function(){
    var cdp = Node.prototype.compareDocumentPosition;
    Node.prototype.compareDocumentPosition = function(o){ COUNT.cdp++; return cdp.call(this, o); };
    var dq = Document.prototype.querySelectorAll, eq = Element.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function(s){ COUNT.qsa++; return dq.call(this, s); };
    Element.prototype.querySelectorAll = function(s){ COUNT.qsa++; return eq.call(this, s); };
    var tc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    Object.defineProperty(Node.prototype, 'textContent', { configurable: true, enumerable: tc.enumerable, get: tc.get,
      set: function(v){ COUNT.text++; if (CFG.busyClock) clockWrite(this); tc.set.call(this, v); } });
    // Every read of the computed style, which makes the browser work the page's styles out.
    var gcs = window.getComputedStyle;
    window.getComputedStyle = function(){ COUNT.gcs++; return gcs.apply(window, arguments); };
    // The options every observer is started with, so a run can say what each one watches.
    var obs = MutationObserver.prototype.observe;
    MutationObserver.prototype.observe = function(target, opts){ OBSERVED.push(opts || {}); return obs.call(this, target, opts); };
  })();
  /* The tool clock's own text writes and the layouts its size reads force: a read after a write lays the page out. */
  var CLOCK = { writes: 0, layouts: 0, dirty: false };
  var inClock = function(el){ return !!(el && el.nodeType === 1 && el.closest && el.closest('[data-cce-toolclock]')); };
  var clockWrite = function(el){ if (inClock(el)) { CLOCK.writes++; CLOCK.dirty = true; } };
  if (CFG.busyClock) {
    ['offsetWidth', 'offsetHeight'].forEach(function(k){
      var d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
      Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: function(){
        if (CLOCK.dirty && inClock(this)) { CLOCK.layouts++; CLOCK.dirty = false; }
        return d.get.call(this);
      } });
    });
  }

  var FIBER = '__reactFiber$ccetest';
  var SUB = 'toolu_sub1';
  var session = {
    agentMapAgents: { value: new Map(CFG.subagent ? [[SUB, { toolUseId: SUB, description: 'Survey the hooks' }]] : []) },
    subagentTasks: { value: new Map() },
    sessionId: { value: CFG.efforts && !CFG.efforts.sidAfterMs ? CFG.efforts.sid : '' },
  };
  // A context window size and a token count, so the newest reply's figures show which conversation they belong to: 10%
  // here and 50% in the conversation switched to.
  if (CFG.switchSession) session.usageData = { value: { totalTokens: 100000, contextWindow: 1000000 } };
  /* A Focus view turn waiting on a tool call: the working line is drawn with the tool clock counting at its end, in a
     line narrow enough that only the clock's short form fits. */
  if (CFG.busyClock) {
    session.visiblyBusy = { value: true };
    session.messages = { value: [
      { type: 'user', timestamp: Date.now() - 5000, content: [{ content: { type: 'text' } }] },
      { type: 'assistant', timestamp: Date.now() - 4000, content: [{ content: { type: 'tool_use', name: 'Bash' } }] },
    ] };
    var working = document.createElement('div');
    working.className = 'spinnerRow_s1';
    working.style.cssText = 'width:300px;height:20px;font-size:11px';
    working.innerHTML = '<span style="display:inline-block"><span class="visuallyHidden_v1">Claude is working</span>Working</span>';
    document.body.insertBefore(working, document.body.firstChild);
  }
  // A panel learns which conversation it shows only once the bundle has asked, which can be after the first probe; the
  // efforts then come with the next one, inside what would otherwise have been the idle spell.
  if (CFG.efforts && CFG.efforts.sidAfterMs) setTimeout(function(){ session.sessionId.value = CFG.efforts.sid; }, CFG.efforts.sidAfterMs);
  // What the panel hands its components as \`context\`, reduced to the part the button uses. A build without Focus view
  // has none, which is what \`focusCtx: false\` stands for.
  var focusCtx = { on: !!CFG.focus, calls: [], get focusViewEnabled(){ return this.on; },
    setFocusView: function(v){ this.calls.push(v); this.on = v; return Promise.resolve(); } };
  // Not 'top': that is the window's own read-only property, and a global of that name is silently left as the window.
  var sessionFiber = { memoizedProps: CFG.focusCtx === false ? { session: session } : { session: session, context: focusCtx },
    return: null };
  // The send button is React's too, so the walk up from it reaches the same props the messages do.
  document.querySelector('button[type="submit"]')[FIBER] = { memoizedProps: {}, return: sessionFiber };
  var list = document.getElementById('list'), uuid = 0, replies = 0, lastRow = null, compactions = 0;
  // Replies get uuids of the real shape, numbered from 1, so a run can name one.
  var replyId = function(n){ var d = String(n); while (d.length < 12) d = '0' + d; return '00000000-0000-4000-8000-' + d; };
  var hang = function(el, block, message){
    el[FIBER] = { memoizedProps: { content: block }, return: { memoizedProps: { message: message }, return: sessionFiber } };
  };
  var user = function(i, ts){
    var u = document.createElement('div');
    u.className = 'userMessage_k3j2';
    u.innerHTML = '<div class="content_c1"><span>question ' + i + ' about the hooks</span></div>';
    hang(u, { content: { type: 'text', text: 'question ' + i } }, { uuid: 'u' + (++uuid), timestamp: ts });
    // Claude Code's own time on a prompt sits in the message's container, ahead of the box this script marks.
    if (CFG.panelStamp === 'time') {
      var holder = document.createElement('div');
      holder.setAttribute('data-transcript-message', '');
      holder.innerHTML = '<div data-message-stamp=""><time>12:13 PM</time></div>';
      holder.appendChild(u);
      list.appendChild(holder);
    } else list.appendChild(u);
  };
  var KINDS = ['thinking', 'tool_use', 'text'];
  var reply = function(ts, owner){
    var m = document.createElement('div');
    m.setAttribute('data-testid', 'assistant-message');
    var message = { uuid: replyId(++replies), timestamp: ts, model: 'claude-opus-5-5' };
    if (owner) message.parentToolUseId = owner;
    // Claude Code's own time line, drawn ahead of the blocks and carrying none of them.
    // 'time' is the stamp as drawn once Claude Code has a time to show; otherwise it is the empty line it holds meanwhile.
    var stampLine = function(){
      var st = document.createElement('div');
      st.setAttribute('data-message-stamp', '');
      if (CFG.panelStamp === 'time') st.innerHTML = '<time>12:13 PM</time>';
      return st;
    };
    if (CFG.panelStamp) m.appendChild(stampLine());
    // What a Claude Code mod draws for a reply, as 2.1.300 does: a row under the reply's message that holds no block.
    if (CFG.modRow) {
      var mod = document.createElement('div');
      mod.setAttribute('data-engine-site', 'AssistantMessage');
      mod.innerHTML = '<span>Edited by a mod</span>';
      mod[FIBER] = { memoizedProps: { plugins: [], lead: 'Edited by' }, return: { memoizedProps: { message: message }, return: sessionFiber } };
      m.appendChild(mod);
    }
    for (var r = 0; r < KINDS.length; r++) {
      var row = document.createElement('div');
      row.className = 'timelineMessage_ab12';
      row.innerHTML = '<div class="markdown_m1"><p><span>a</span><code>b</code><span>c</span></p><p><span>d</span></p></div>';
      // With quietReply, the newest reply's text is a lone dash, which the page does not show.
      var quiet = CFG.quietReply && replies === CFG.turns * 3 && KINDS[r] === 'text';
      var block = KINDS[r] === 'tool_use'
        ? { content: { type: 'tool_use', name: 'Bash', input: { command: 'ls' } } }
        : { content: { type: KINDS[r], text: quiet ? '\u2014' : 'x' } };
      hang(row, block, message);
      m.appendChild(row);
      lastRow = row.firstChild;
    }
    list.appendChild(m);
  };
  var compaction = function(){
    var d = document.createElement('details');
    d.className = 'compactSummary_c9';
    d.innerHTML = '<summary>Conversation compacted</summary><div>summary</div>';
    list.appendChild(d);
    compactions++;
  };
  var t0 = Date.now() - (CFG.turns + 2) * 600000;
  var turn = function(i){
    if (i && i % CFG.compactEvery === 0) compaction();
    var ts = t0 + i * 600000;
    user(i, ts);
    var agentAt = typeof CFG.subagentTurn === 'number' ? CFG.subagentTurn : CFG.turns - 2;
    for (var k = 0; k < 3; k++) reply(ts + 1000 * (k + 1), CFG.subagent && i === agentAt && k === 1 ? SUB : '');
  };
  for (var i = 0; i < CFG.turns; i++) turn(i);
  var addTurn = function(){ turn(CFG.turns); };
  /* Switch conversations in place, as New and Resume do: a new session object, its own messages, and the footer given
     the new session. */
  var NEXT_SID = '11111111-2222-4333-8444-555555555555';
  var switchSession = function(){
    var next = { agentMapAgents: { value: new Map() }, subagentTasks: { value: new Map() }, sessionId: { value: NEXT_SID },
      usageData: { value: { totalTokens: 500000, contextWindow: 1000000 } } };
    sessionFiber = { memoizedProps: CFG.focusCtx === false ? { session: next } : { session: next, context: focusCtx }, return: null };
    document.querySelector('button[type="submit"]')[FIBER].return = sessionFiber;
    while (list.firstChild) list.removeChild(list.firstChild);
    for (var n = 0; n < 3; n++) turn(n);
  };
`;

/* Runs after it: three phases on the page's own clock, then the readout. Idle first - the page has booted and nothing
   happens; then a reply growing, which is what drives sweeps in use; then a new prompt, which rebuilds the contents
   list. */
const PHASES = String.raw`
  var R = { script: !!window.__cceStats };
  var stats = function(){ return window.__cceStats ? window.__cceStats() : null; };
  var snap = function(){ var s = stats(); return { n: s ? s.n : -1, cdp: COUNT.cdp, qsa: COUNT.qsa, text: COUNT.text, dates: COUNT.dates, gcs: COUNT.gcs }; };
  var finish = function(){ document.getElementById('out').textContent = 'CCE-' + 'RESULT:' + JSON.stringify(R); };
  var later = function(ms, f){
    setTimeout(function(){ try { f(); } catch (e) { R.error = String(e && e.stack || e); finish(); } }, ms);
  };
  var mut = { on: false, child: 0, attr: 0, chars: 0 };
  new MutationObserver(function(rs){
    if (!mut.on) return;
    for (var i = 0; i < rs.length; i++) {
      if (rs[i].type === 'childList') mut.child++; else if (rs[i].type === 'attributes') mut.attr++; else mut.chars++;
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  var a, b;
  /* Which rows show a time of this script's own: every reply's text row and first block, and every prompt. */
  var TIME = /\d\d:\d\d:\d\d/;
  var labelOf = function(el){ var l = el && (el.hasAttribute('data-cce-ts') ? el : el.querySelector('[data-cce-ts]')); return l ? l.getAttribute('data-cce-ts') : ''; };
  var readTimes = function(suffix){
    var rs = document.querySelectorAll('[data-testid="assistant-message"]'), text = 0, first = 0, firstFigures = 0;
    for (var i = 0; i < rs.length; i++) {
      var kids = rs[i].children, firstBlock = kids[CFG.panelStamp ? 1 : 0];
      if (TIME.test(labelOf(kids[kids.length - 1]))) text++;
      if (TIME.test(labelOf(firstBlock))) first++;
      if (/\u00b7|opus/.test(labelOf(firstBlock))) firstFigures++;
    }
    var us = document.querySelectorAll('[class*="userMessage_"]'), prompt = 0;
    for (var k = 0; k < us.length; k++) if (TIME.test(labelOf(us[k]))) prompt++;
    R['times' + suffix] = { replies: rs.length, text: text, first: first, firstFigures: firstFigures, prompts: us.length, prompt: prompt };
  };
  /* Idle starts once the boot has finished, judged by the sweep count holding still for a second after the first sweep
     - a fixed moment would sometimes land before the script had put its controls in, and a count still at zero is a
     script that has not started rather than one that has stopped. A page that never holds still starts at the cap
     instead, and is counted as it is. */
  /* With efforts, the quiet spell counts only once they are in. They arrive by way of the revision probe, and when that
     answers is the browser's business: on a slow runner it answered after a second of quiet had already been counted,
     and the sweeps that applied them were then read as a page that never went idle. */
  var effortsIn = function(){
    if (!CFG.efforts) return true;
    var c = document.getElementById('cce-effort');
    return !!c && String(getComputedStyle(c).getPropertyValue('--cce-effort')).length > 0;
  };
  var settle = function(lastN, quiet, waited){
    var n = snap().n, ready = effortsIn();
    if (ready && CFG.efforts && R.effortsAt === undefined) R.effortsAt = waited;
    quiet = n > 0 && n === lastN && ready ? quiet + 1 : 0;
    if (quiet >= 5 || waited >= CFG.settleCapMs) { R.settledAfter = waited; R.bootSweeps = n; return idle(); }
    later(200, function(){ settle(n, quiet, waited + 200); });
  };
  var idle = function(){
    a = snap(); mut.on = true;
    /* Stylesheets coming and going in the head while the page is otherwise idle, as reloading one does. */
    if (CFG.headChurn) {
      for (var c = 0; c < 6; c++) later(200 + c * 400, function(){
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = 'data:text/css,';
        document.head.appendChild(l);
        later(100, function(){ if (l.parentNode) l.parentNode.removeChild(l); });
      });
    }
    later(CFG.idleMs, function(){
      b = snap(); mut.on = false;
      R.idleSweeps = b.n - a.n;
      R.idleChild = mut.child; R.idleAttr = mut.attr; R.idleChars = mut.chars; R.idleText = b.text - a.text;
      R.probesMade = PROBES.made; R.probesCancelled = PROBES.cancelled;
      // The page's own observers; the harness's, the one that watches attributes, is left out.
      R.observed = OBSERVED.filter(function(o){ return !o.attributes; });
      var clock = document.querySelector('[data-cce-toolclock]');
      R.clockText = clock && clock.style.display === 'block' ? clock.innerText : '';
      R.clockWrites = CLOCK.writes; R.clockLayouts = CLOCK.layouts;
      /* For each reply, which child carries the figures - the reply's duration is the one figure every reply has. */
      R.quietRows = Array.prototype.map.call(document.querySelectorAll('[data-cce-quiet="1"]'), function(e){ return e.style.display; });
      R.figuresAt = [];
      var replyEls = document.querySelectorAll('[data-testid="assistant-message"]');
      for (var fi = 0; fi < replyEls.length; fi++) {
        var kids = replyEls[fi].children, at = -1;
        for (var fk = 0; fk < kids.length && at < 0; fk++) {
          var lab = kids[fk].querySelector('[data-cce-ts]') || (kids[fk].hasAttribute('data-cce-ts') ? kids[fk] : null);
          if (lab && /\d+s|\d+m/.test(lab.getAttribute('data-cce-ts') || '') && /\u00b7|opus/.test(lab.getAttribute('data-cce-ts'))) at = fk;
        }
        R.figuresAt.push(at);
      }
      readTimes('');
      R.viewButton = !!document.querySelector('[data-cce-view]');
      var fb = document.querySelector('[data-cce-focus-btn]');
      R.focusButton = !!fb;
      R.focusLabel = fb ? fb.getAttribute('aria-label') : '';
      if (CFG.efforts) {
        var effLinks = document.querySelectorAll('link[href*="effort"]'), carrier = document.getElementById('cce-effort');
        R.effortLinks = effLinks.length;
        R.effortHref = effLinks.length ? effLinks[0].getAttribute('href') : '';
        R.carrierValue = carrier ? String(getComputedStyle(carrier).getPropertyValue('--cce-effort')).length : -1;
        R.base = (document.querySelector('link[href*="index.css"]') || {}).href || '';
        if (window.__cceDebug) R.debug = window.__cceDebug;
        R.labels = [];
        var all = document.querySelectorAll('[data-testid="assistant-message"]');
        for (var q = 0; q < all.length; q++) {
          var marked = all[q].querySelector('[data-cce-ts]');
          R.labels.push(marked ? marked.getAttribute('data-cce-ts') : null);
        }
      }
      a = snap();
      grow(0);
    });
  };
  /* A reply growing, which is what drives sweeps in use. */
  var grow = function(k){
    if (k === CFG.grows) return later(400, grown);
    var s = document.createElement('span');
    s.appendChild(document.createTextNode(' more'));
    lastRow.appendChild(s);
    later(300, function(){ grow(k + 1); });
  };
  var grown = function(){
    b = snap();
    var s = stats(), last = s && s.last;
    R.growSweeps = b.n - a.n; R.growCdp = b.cdp - a.cdp; R.growQsa = b.qsa - a.qsa; R.growText = b.text - a.text;
    R.growDates = b.dates - a.dates; R.growGcs = b.gcs - a.gcs;
    R.fiber = last ? last.fiber : -1; R.full = last ? last.full : -1;
    R.msgs = last ? last.msgs : -1; R.bubbles = last ? last.bubbles : -1;
    a = snap();
    addTurn();
    later(800, rebuilt);
  };
  /* A new prompt, which is what rebuilds the contents list. */
  var rebuilt = function(){
    b = snap();
    R.rebuildSweeps = b.n - a.n; R.rebuildCdp = b.cdp - a.cdp;
    R.prompts = CFG.turns + 1; R.compactions = compactions;
    next();
  };
  /* What a run asks for beyond the three phases, one step after another; each calls next() when it is done. */
  var STEPS = [];
  var next = function(){ var s = STEPS.shift(); if (s) s(); else finish(); };
  /* The button pressed once: what it asked of the panel, and what it says afterwards. */
  var clickFocus = function(){
    var fb = document.querySelector('[data-cce-focus-btn]');
    if (!fb) { R.clicked = false; return next(); }
    fb.click();
    later(900, function(){
      R.clicked = true; R.focusCalls = focusCtx.calls.slice(); R.focusAfter = focusCtx.on;
      R.focusLabelAfter = fb.getAttribute('aria-label');
      next();
    });
  };
  /* Switch, then read the newest reply's figures and the info box. */
  var newestBlock = function(){
    var rs = document.querySelectorAll('[data-testid="assistant-message"]'), last = rs[rs.length - 1];
    return last && last.children[CFG.panelStamp ? 1 : 0];
  };
  var switched = function(){
    R.labelBeforeSwitch = labelOf(newestBlock());
    switchSession();
    later(1500, function(){
      R.labelAfterSwitch = labelOf(newestBlock());
      var info = document.querySelector('[data-cce-info]');
      if (info) info.click();
      later(300, function(){
        var box = document.getElementById('cce-info');
        R.infoAfterSwitch = box ? box.textContent : '';
        next();
      });
    });
  };
  var countHidden = function(){
    var all = document.querySelectorAll('[data-testid="assistant-message"], [class*="userMessage_"]'), n = 0;
    for (var i = 0; i < all.length; i++) if (all[i].style.display === 'none') n++;
    return n;
  };
  var railShown = function(){ var r = document.getElementById('cce-toc-rail'); return !!r && r.style.display !== 'none'; };
  var tocRows = function(){
    var p = document.getElementById('cce-toc'), l = p && p.children[1];
    return l ? Array.prototype.map.call(l.children, function(r){ return r.textContent; }) : [];
  };
  /* One sub-agent picked in the view filter as a person does it: the button, then the agent's row in its menu. */
  var pickView = function(){
    var btn = document.querySelector('[data-cce-view]');
    if (btn) btn.click();
    var rows = document.querySelectorAll('#cce-view-menu > div'), row = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].textContent === 'Survey the hooks') row = rows[i];
    R.picked = !!row;
    if (row) row.click();
    later(600, function(){
      R.hiddenInView = countHidden(); R.railInView = railShown(); R.tocInView = tocRows();
      next();
    });
  };
  /* Switches turned off while the page is open, as the extension does it (a new live stylesheet and revision number),
     then a check of what remains: the times, what the view hid, the contents rail and its keys, and the footer
     controls. */
  var controls = function(){
    return ['info', 'mute', 'focus-btn', 'view'].filter(function(k){ return !!document.querySelector('[data-cce-' + k + ']'); });
  };
  /* The next-message key, pressed with the conversation scrolled to the top. */
  var pressNext = function(done){
    var sc = document.getElementById('list');
    sc.scrollTop = 0;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '.', bubbles: true }));
    later(400, function(){ done(sc.scrollTop !== 0); });
  };
  var tags = function(){
    var ls = document.querySelectorAll('[data-cce-ts]'), n = 0;
    for (var i = 0; i < ls.length; i++) if (ls[i].getAttribute('data-cce-ts').indexOf('#') >= 0) n++;
    return n;
  };
  var flipped = function(){
    R.railBeforeFlip = railShown(); R.controlsBeforeFlip = controls();
    readTimes('BeforeFlip'); R.tagsBeforeFlip = tags();
    pressNext(function(moved){
      R.keyMovedBeforeFlip = moved;
      later(1500, function(){
        document.documentElement.setAttribute('data-cce-test-flip', '');
        window.__cceTestRev = 2;
        later(4500, function(){
          readTimes('AfterFlip'); R.tagsAfterFlip = tags();
          R.hiddenAfterFlip = countHidden(); R.railAfterFlip = railShown(); R.controlsAfterFlip = controls();
          pressNext(function(movedAfter){ R.keyMovedAfterFlip = movedAfter; next(); });
        });
      });
    });
  };
  if (CFG.clickFocus) STEPS.push(clickFocus);
  if (CFG.switchSession) STEPS.push(switched);
  if (CFG.pickView) STEPS.push(pickView);
  if (CFG.flip) STEPS.push(flipped);
  later(500, function(){ settle(-1, 0, 500); });
`;

/* Custom properties for the switches a run turns off: either in a page style from the start, or in the live stylesheet
   behind an attribute that a flip adds to the root. */
const offRules = (keys) => (keys || []).map((k) => `--cce-off-${k}:1;`).join('');

function page(cfg, script) {
  // With efforts or a flip, the page is pointed at its own folder as the panel's, which is where they are read from.
  return '<!doctype html><html><head>' + (cfg.efforts || cfg.flip ? '<link rel="stylesheet" href="index.css">' : '')
    + (cfg.offSwitches ? '<style>:root{' + offRules(cfg.offSwitches) + '}</style>' : '')
    + '</head><body><pre id="out"></pre>'
    + '<div id="list" style="overflow-y:auto;height:600px"></div>'
    + '<form><div class="inputRow_r1">'
    + '<button type="button" class="menuButton_x1">m</button>'
    + '<button type="button" class="usageButtonV2_u7" aria-label="40% of context used">40%</button>'
    + '<div class="mode_m2">mode</div><button type="submit" data-permission-mode="default">send</button>'
    + '</div></form>'
    + '<script>var CFG = ' + JSON.stringify(cfg) + ';' + SETUP + '</script>'
    + '<script>' + script + '</script>'
    + '<script>' + PHASES + '</script>'
    + '</body></html>';
}

/**
 * Run one simulated panel to completion. `cfg`: turns, compactEvery, focus, focusCtx, clickFocus, subagent,
 * subagentTurn, switchSession, offSwitches (off from the start), pickView, flip (switches turned off later), and the
 * phase lengths. Resolves to the page's counts or { error }.
 */
const DEFAULTS = { turns: 100, compactEvery: 20, focus: true, subagent: true, settleCapMs: 6000, idleMs: 3000, grows: 8 };

function run(browser, cfg, script) {
  const full = Object.assign({}, DEFAULTS, cfg);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-page-'));
  try {
    const file = path.join(dir, 'panel.html');
    fs.writeFileSync(file, page(full, script || require('../src/webview').SCRIPT));
    if (full.efforts) {
      const wv = require('../src/webview');
      fs.writeFileSync(path.join(dir, 'index.css'), '');
      fs.writeFileSync(path.join(dir, 'claude-code-extras.rev.svg'),
        `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="${full.efforts.height || 7}"></svg>`);
      fs.writeFileSync(path.join(dir, wv.EFFORT_PREFIX + full.efforts.sid + '.css'), full.efforts.css);
    }
    if (full.flip) {
      const wv = require('../src/webview');
      fs.writeFileSync(path.join(dir, 'index.css'), '');
      if (!full.efforts) {
        fs.writeFileSync(path.join(dir, 'claude-code-extras.rev.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="7"></svg>');
      }
      fs.writeFileSync(path.join(dir, 'claude-code-extras.css'), `:root[data-cce-test-flip]{${offRules(full.flip)}}\n` + wv.liveCss({ enabled: true }));
    }
    const steps = (full.clickFocus ? 1000 : 0) + (full.switchSession ? 2000 : 0) + (full.pickView ? 1000 : 0)
      + (full.flip ? 8500 : 0);
    const budget = full.settleCapMs + full.idleMs + full.grows * 300 + 3000 + steps;
    /* No --user-data-dir. Headless already starts from a temporary profile of its own, which is what keeps it apart
       from a browser the person is using; naming a directory instead makes it set that up as a lasting profile, and
       that first-run setup held every run here until the process was killed. */
    const r = cp.spawnSync(browser, ['--headless=new', '--no-sandbox', '--disable-gpu',
      '--virtual-time-budget=' + budget, '--dump-dom', 'file://' + file], { encoding: 'utf8', timeout: 120000 });
    const at = (r.stdout || '').indexOf(MARK);
    if (at === -1) return { error: 'no result in the page (exit ' + r.status + (r.error ? ', ' + r.error.message : '') + ')' };
    const json = r.stdout.slice(at + MARK.length, r.stdout.indexOf('<', at));
    return JSON.parse(json.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&'));
  } catch (e) {
    return { error: e.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { findBrowser, run, DEFAULTS };
