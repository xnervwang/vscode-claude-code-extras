// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// The sweep itself, and what starts it. Runs last, so every function it calls is assigned.
// Fragment of the in-page script - see README.md in this folder.

  /*
   * The directory row already built for a message of yours, kept against the block it was read from.
   *
   * A message that is not the newest cannot change its text, its time or its place again, so building its row a second
   * time can only produce the same answer. Keeping it removes a closure, a walk for its text and an object from every
   * sweep for every message you have ever sent - which at four sweeps a second is the part that grew with the length of
   * the conversation. Weak, so nothing is held after the panel drops the block.
   */
  var PROMPT_OF = new WeakMap();
  /* Contents-list entries for a sub-agent reply's tool calls, saved when the reply is fully processed so that a settled
     reply keeps its calls listed (as UUIDS_OF does for efforts). */
  var ACTS_OF = new WeakMap();

  // A line that begins with what used to follow the time: the tag's or the figures' own leading space goes with it.
  var lead = function(v){ return v ? v.replace(/^\s+/, '') : v; };

  /*
   * Clear every cached result so that it is recomputed: the rows for your messages, the owner and settled marks on
   * replies, and the marks inside those replies. The existing marks go back into `marked`, so any the sweep does not
   * produce again are removed at its end.
   */
  var resetMarks = function(){
    PROMPT_OF = new WeakMap();
    var owned = document.querySelectorAll('[' + OWNER_ATTR + ']');
    for (var i = 0; i < owned.length; i++) { owned[i].removeAttribute(OWNER_ATTR); owned[i].removeAttribute(SETTLED_ATTR); }
    var held = document.querySelectorAll('[' + ATTR + ']');
    for (var k = 0; k < held.length; k++) marked.add(held[k]);
  };
  /* Switches that affect a mark's content. Marks are cached, so a change to one of these, or to the marks switch
     itself, recomputes everything on that sweep; otherwise only the newest message and the last LIVE_TAIL replies would
     update. */
  var MARK_SWITCHES = ['timestamps', 'subAgentTags', 'replyDuration', 'contextShare', 'cost', 'modelName'];
  var markSig = '';
  var marksFollowSwitches = function(){
    var s = isOn() ? '1' : '0';
    for (var i = 0; i < MARK_SWITCHES.length; i++) s += isOff(MARK_SWITCHES[i]) ? '1' : '0';
    if (s === markSig) return;
    if (markSig) resetMarks();
    markSig = s;
  };

  var stamp = function(){
    var tA = clock(), wF = WALK.fiber, wT = WALK.text;
    var bubbles = document.querySelectorAll(USER), groups = new Map();
    // Look the session up on every sweep, marks on or off, with one walk up from the first of these nodes found
    // (useSession, 25-session.js); the chimes, the figures and the footer use it too. The footer toolbar also has the
    // session as a prop and is the only seed in an empty conversation; without it the info button and the chimes would
    // have no session until the first message.
    var seed = bubbles[0] || document.querySelector(ASSIST) || document.querySelector(SEND);
    var found = seed ? findSession(seed) : null;
    if (found && found !== sessionRef) useSession(found);
    viewFilterOff();
    marksFollowSwitches();
    if (!isOn()) { sweep(); return; }
    if (sessionRef) indexTitles(sessionRef);
    for (var i = 0; i < bubbles.length; i++) {
      // A row already built for a block carries the block's message, so only the blocks without one are walked up to it.
      var b = bubbles[i], kept = PROMPT_OF.get(b), msg = kept ? kept.message : ctxOf(b).message;
      if (!msg) continue;
      var g = groups.get(msg); if (!g) { g = []; groups.set(msg, g); }
      g.push(b);
    }
    var tB = clock();
    var prompts = [], lastBubble = bubbles.length ? bubbles[bubbles.length - 1] : null;
    groups.forEach(function(list, m){
      /*
       * One row for each thing you said, not one for each message you sent.
       *
       * Send two lines in quick succession and they arrive as a single message carrying two blocks of text - the panel
       * draws a box for each, so two appear on screen. Marking the message rather than the blocks then gave the first
       * box a time and left the second without one, and put a single row in the list of your messages for the two. The
       * replies have always been marked per block, so this is the side that was out of step.
       *
       * Only the newest message is built; the rest are recalled against the block they were read from. What still
       * happens for every block on every sweep is the mark and the owner, and neither is optional: the set of marked
       * elements is rebuilt each sweep and anything missing from it has its mark stripped, and a view switch reaches a
       * message only through applyOwner.
       */
      var live = list.indexOf(lastBubble) >= 0, mark = '';
      for (var bi = 0; bi < list.length; bi++) {
        var b = list[bi];
        applyOwner(b, 'main');
        var row = live ? null : PROMPT_OF.get(b);
        if (!row) {
          var line = textOf(b, b === lastBubble);
          // An attachment or image has no text line and gets no row; a message that is only an attachment still gets
          // its mark from the block below. `null` until built, since an empty mark is valid and must not be rebuilt
          // every sweep. The message is kept for grouping the blocks; syncMap adds the time shown in the contents list.
          row = { node: b, top: b, ts: m.timestamp, text: line, mark: null, message: m, when: null };
          if (!live) PROMPT_OF.set(b, row);
        }
        if (live || row.mark === null) {
          if (mark === '') {
            mark = isOff('timestamps') ? '' : fmt(m.timestamp);
            if (!isOff('subAgentTags')) mark += agentTag(agentOf(m));
            mark = lead(mark);
          }
          row.mark = mark;
        }
        set(b, row.mark);
        if (row.text) prompts.push(row);
      }
    });
    var promptTs = [], ordered = true;
    for (var pi = 0; pi < prompts.length; pi++) {
      var pts = prompts[pi].ts;
      if (typeof pts !== 'number') continue;
      if (promptTs.length && pts < promptTs[promptTs.length - 1]) ordered = false;
      promptTs.push(pts);
    }
    /* Document order is the order they were sent in, so this is sorted already and the sort was work with no result.
       The check stays because the binary search in turnStartFor depends on the order: an assumption that quietly stopped
       holding would hand every reply the wrong turn start, with nothing to show it had. */
    if (!ordered) promptTs.sort(function(a, b){ return a - b; });
    var tC = clock();
    var msgs = document.querySelectorAll(ASSIST);
    // While the text observer is still on these messages' scroller, aiming it costs only a containment check.
    aimText(bubbles[0] || msgs[0]);
    // When this sweep records the owner of an older reply, that reply settles on the next sweep, so the next sweep is
    // scheduled explicitly: the page may not change again until a reply grows.
    var seen = [], seenSet = {}, shownRows = 0, fullMsgs = 0, settledMsgs = 0, blocks = 0, settleNext = false;
    var agentView = (VIEW !== 'all' && VIEW !== 'main'), acts = [];
    // Each owner's effort run, carried through the replies in document order (76-effort.js).
    var effState = {};
    for (var j = 0; j < msgs.length; j++) {
      // A reply well behind the newest one cannot change again: its time, duration and figures are fixed, and its
      // owner is already recorded on the element. Re-deriving all of that on every sweep is the one cost that would
      // grow with the length of the conversation, so such a message is handed its marks once and from then on only
      // has its visibility refreshed - which is all a view switch needs.
      if (j < msgs.length - LIVE_TAIL) {
        var own0 = msgs[j].getAttribute(OWNER_ATTR);
        if (own0) {
          var held0 = UUIDS_OF.get(msgs[j]);
          if (held0) for (var hu = 0; hu < held0.length; hu++) effortAt(effState, own0, held0[hu]);
          applyOwner(msgs[j], own0);
          if (own0 !== 'main' && !seenSet[own0]) { seenSet[own0] = 1; seen.push(own0); }
          if (ownerVisible(own0)) shownRows++;
          if (agentView && own0 === VIEW) { var tools0 = ACTS_OF.get(msgs[j]); if (tools0) acts.push.apply(acts, tools0); }
          if (msgs[j].getAttribute(SETTLED_ATTR) !== '1') {
            var held = msgs[j].querySelectorAll('[' + ATTR + ']');
            for (var q = 0; q < held.length; q++) marked.delete(held[q]);
            msgs[j].setAttribute(SETTLED_ATTR, '1');
          }
          settledMsgs++;
          continue;
        }
      }
      fullMsgs++;
      var rows = msgs[j].children, ownerDone = false, own = 'main', uus = [], effHere = '', figured = false, tools = null;
      var quietN = 0, loudN = 0;
      blocks += rows.length;
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r], cx = ctxOf(row), v = '';
        var blk = cx.block && cx.block.content;
        var hush = !!(blk && blk.type === 'text' && QUIET_REPLY.test(String(blk.text || '')));
        quietRow(row, hush);
        if (hush) quietN++;
        else if (blk && blk.type !== 'thinking' && blk.type !== 'redacted_thinking') loudN++;
        if (!ownerDone && cx.message) {
          own = agentOf(cx.message) || 'main';
          applyOwner(msgs[j], own);
          if (own !== 'main' && !seenSet[own]) { seenSet[own] = 1; seen.push(own); }
          if (ownerVisible(own)) shownRows++;
          ownerDone = true;
        }
        if (cx.message && cx.message.uuid) {
          var effRow = effortAt(effState, own, cx.message.uuid);
          if (!uus.length) effHere = effRow;
          uus.push(cx.message.uuid);
        }
        /* Whether this row gets an annotation at all, which used to be read off `v` being non-empty. With the time
           itself switchable that test would have made one switch turn four things off, so it is now asked directly. */
        var annot = !!(cx.block && cx.message && cx.message.uuid);
        if (annot) {
          var t = cx.block.content && cx.block.content.type;
          v = isOff('timestamps') ? '' : fmt(cx.message.timestamp);
          if (own !== 'main' && (t === 'tool_use' || t === 'server_tool_use')) {
            (tools || (tools = [])).push({ node: row, ts: cx.message.timestamp, text: toolLabel(cx.block.content), when: null });
          }
          if (v && (t === 'tool_use' || t === 'server_tool_use') && typeof cx.block.cceResultAt === 'number') v += '\u2192' + fmt(cx.block.cceResultAt).replace(/^(\d{4}\/)?\d\d\/\d\d /, '');
        }
        if (annot && !isOff('subAgentTags')) v += agentTag(agentOf(cx.message));
        /* The figures go on the first row that is a block, not on the first child: Claude Code puts a time line of its own
           ahead of the blocks of a reply that has text, and that row carries no block, so "the first child" left a
           reply with text without its figures while every tool call kept them. */
        if (annot && !figured) {
          figured = true;
          var bits = [];
          var t0 = turnStartFor(promptTs, cx.message.timestamp);
          if (t0 !== null && !isOff('replyDuration')) { var d = dur(cx.message.timestamp - t0); if (d) bits.push(d); }
          var st = statAt(cx.message, j === msgs.length - 1, effHere);
          if (st) bits.push(st);
          if (!effHere && cx.message.model) effortPending.add(msgs[j]);
          if (bits.length) v += '  ' + bits.join(' ' + String.fromCharCode(183) + ' ');
        }
        set(row, lead(v), annot && (t === 'tool_use' || t === 'server_tool_use'));
      }
      quietFold(msgs[j], quietN > 0 && loudN === 0);
      if (uus.length) UUIDS_OF.set(msgs[j], uus);
      if (ownerDone && j < msgs.length - LIVE_TAIL) settleNext = true;
      if (tools) {
        ACTS_OF.set(msgs[j], tools);
        if (agentView && own === VIEW) acts.push.apply(acts, tools);
      }
    }
    // Compaction blocks belong to the main thread, so a sub-agent view hides them too.
    var cps = document.querySelectorAll(COMPACT);
    for (var cq = 0; cq < cps.length; cq++) applyOwner(cps[cq], 'main');
    SEEN = seen;
    showNote(VIEW !== 'all' && VIEW !== 'main' && shownRows === 0);
    sweptElements = bubbles.length + msgs.length;
    try { healthCheck(sweptElements); } catch (e) {}
    var tD = clock();
    sweep();
    var tE = clock();
    try { syncMap(agentView ? acts : prompts, cps); } catch (e) {}
    var tF = clock();
    try { ensureViewControl(); } catch (e) {}
    try { ensureFocusControl(); } catch (e) {}
    try { ensureInfo(); } catch (e) {}
    try { orderControls(); } catch (e) {}
    try { wireCtxButton(); } catch (e) {}
    try { watchIdle(); } catch (e) {}
    try { fillWindow(); } catch (e) {}
    try { markCtxLow(); } catch (e) {}
    record({ users: tB - tA, prompts: tC - tB, replies: tD - tC, marks: tE - tD, toc: tF - tE,
             controls: clock() - tF, total: clock() - tA,
             bubbles: bubbles.length, msgs: msgs.length, full: fullMsgs, settled: settledMsgs, blocks: blocks,
             fiber: WALK.fiber - wF, text: WALK.text - wT });
    if (settleNext) schedule();
  };
  var queued = false, last = 0;
  var sweptElements = 0, firstSweepMs = 0, sweeps = 0, bootAt = 0;
  var clock = function(){ try { return performance.now(); } catch (e) { return 0; } };

  /*
   * What each sweep cost, and where.
   *
   * A sweep runs four times a second for as long as the panel is open, so the question that matters is not how long
   * one took but how much of the main thread all of them together have taken - a figure nothing in the browser's own
   * tools attributes to us, since this code lives inside the panel's bundle. The phases are timed separately because
   * each has a different reason to grow, and a total alone cannot say which one did.
   */
  var PHASES = ['users', 'prompts', 'replies', 'marks', 'toc', 'controls'];
  var LEGEND = {
    users: 'reading your own messages',
    prompts: 'marking them and ordering the turn starts',
    replies: 'reply rows',
    marks: 'taking stale marks off',
    toc: 'the contents list',
    controls: 'the toolbar additions',
  };
  var SLOW_MS = 60;         // a sweep longer than this is a visible stutter, so say so
  var QUIET_MS = 5000;      // ...but at most one complaint per this long, or a freeze prints thousands
  var stats = { n: 0, sum: 0, max: 0, worst: null, last: null, sum_: {}, max_: {} };
  var lastMoan = 0;
  var record = function(s) {
    stats.n++; stats.sum += s.total; stats.last = s;
    for (var i = 0; i < PHASES.length; i++) {
      var k = PHASES[i], v = s[k] || 0;
      stats.sum_[k] = (stats.sum_[k] || 0) + v;
      if (v > (stats.max_[k] || 0)) stats.max_[k] = v;
    }
    if (s.total > stats.max) { stats.max = s.total; stats.worst = s; }
    if (s.total > SLOW_MS && clock() - lastMoan > QUIET_MS) {
      lastMoan = clock();
      try { console.warn('[claude-code-extras] slow sweep ' + Math.round(s.total) + 'ms - ' + where(s)); } catch (e) {}
    }
  };
  /** The phases of one sweep, worst first, so the line names its own culprit. */
  var where = function(s) {
    var out = [];
    for (var i = 0; i < PHASES.length; i++) if ((s[PHASES[i]] || 0) >= 1) out.push({ k: PHASES[i], v: s[PHASES[i]] });
    out.sort(function(a, b){ return b.v - a.v; });
    var bits = out.map(function(p){ return LEGEND[p.k] + ' ' + Math.round(p.v) + 'ms'; });
    bits.push(s.bubbles + ' of your messages, ' + s.msgs + ' replies (' + s.full + ' worked out fully, ' + s.settled + ' already settled)');
    bits.push('steps taken: ' + s.text + ' looking for text lines, ' + s.fiber + ' up React trees');
    return bits.join('; ');
  };
  /*
   * Printed on demand from the panel's devtools console: __cceStats(). The one-line startup report cannot answer
   * "where is the time going" for a conversation that is already open, and this is the only channel a page script
   * has - it has no file system, and the channel to the extension side runs one way.
   */
  window.__cceStats = function() {
    try {
      var up = clock() - T0, rows = [];
      for (var i = 0; i < PHASES.length; i++) {
        var k = PHASES[i];
        rows.push('  ' + LEGEND[k] + ': ' + Math.round(stats.sum_[k] || 0) + 'ms total, worst sweep '
                  + Math.round(stats.max_[k] || 0) + 'ms');
      }
      console.log('[claude-code-extras] ' + stats.n + ' sweeps over ' + (up / 1000).toFixed(1) + 's of panel life\n'
        + '  main thread spent in them: ' + Math.round(stats.sum) + 'ms ('
        + (stats.sum / Math.max(1, up) * 100).toFixed(1) + '% of that time)\n'
        + '  slowest single sweep: ' + Math.round(stats.max) + 'ms\n'
        + '  steps taken in all: ' + WALK.text + ' looking for text lines, ' + WALK.fiber + ' up React trees\n'
        + rows.join('\n')
        + (stats.last ? '\n  latest sweep: ' + where(stats.last) : '')
        + (stats.worst ? '\n  slowest sweep: ' + where(stats.worst) : ''));
      return stats;
    } catch (e) { return null; }
  };
  var run = function(){
    queued = false; last = Date.now();
    var t = clock();
    try { stamp(); } catch (e) {}
    if (sweeps++ === 0) firstSweepMs = clock() - t;
  };
  var schedule = function(){
    if (queued) return; queued = true;
    setTimeout(function(){ requestAnimationFrame(run); }, Math.max(0, 250 - (Date.now() - last)));
  };

  /*
   * Watch for changing text only inside the list the messages are in.
   *
   * It used to be watched on the whole document, which made a sweep out of every character typed into the composer as
   * well as every character streamed into a reply - and a character in the composer cannot change anything about a
   * message that has already been sent. At four sweeps a second against work that grows with the conversation, that is
   * the multiplier rather than any one line inside a sweep.
   *
   * Re-aimed from the sweep rather than bound once, because at boot the list does not exist yet - an empty conversation
   * has no messages at all - and the panel may replace it. The element passed in is one already in hand, so finding the
   * list costs nothing beyond walking up to the scrolling ancestor.
   */
  /*
   * The controls this script adds, in one fixed left-to-right order.
   *
   * Each of them puts itself immediately before the permission-mode selector, so without this their order is whichever
   * was created first - and that changes with what the conversation holds, since the view filter only appears once there
   * is a sub-agent to switch between. The reader would find them somewhere different in each conversation.
   *
   * Nothing is moved while they are already in this order: rearranging the row on a timer would pull a button out from
   * under the pointer, and a click that lands on the wrong control is worse than an order nobody chose.
   */
  var ORDER = ['[data-cce-info]', '[data-cce-focus-btn]', '[data-cce-mute]', '[data-cce-view]'];
  var orderControls = function(){
    var send = document.querySelector(SEND);
    if (!send) return;
    var mode = send.previousElementSibling;
    if (!mode || !mode.parentElement) return;
    var want = [];
    for (var i = 0; i < ORDER.length; i++) {
      var el = document.querySelector(ORDER[i]);
      if (el && el.parentElement === mode.parentElement) want.push(el);
    }
    if (!want.length) return;
    var placed = true;
    for (var j = 0; j < want.length && placed; j++) {
      placed = (j + 1 < want.length) ? want[j].nextElementSibling === want[j + 1] : want[j].nextElementSibling === mode;
    }
    if (placed) return;
    for (var k = 0; k < want.length; k++) mode.parentElement.insertBefore(want[k], mode);
  };

  /* Nodes this script adds (labels, lists, menus, boxes, footer buttons): their children change constantly, the tool
     clock's every second, and none of them holds a message. */
  var OWN_NODES = '[data-cce-toolclock],[data-cce-label],[data-cce-info],[data-cce-mute],[data-cce-view],[data-cce-focus-btn],[id^="cce-"]';
  var ours = function(n){
    var el = n && (n.nodeType === 1 ? n : n.parentElement);
    return !!(el && el.closest && el.closest(OWN_NODES));
  };
  var oursOnly = function(rec){
    if (ours(rec.target)) return true;
    // One of ours put into a node of the panel's, or taken out of one.
    if (rec.type !== 'childList' || !(rec.addedNodes.length + rec.removedNodes.length)) return false;
    for (var a = 0; a < rec.addedNodes.length; a++) if (!ours(rec.addedNodes[a])) return false;
    for (var d = 0; d < rec.removedNodes.length; d++) if (!ours(rec.removedNodes[d])) return false;
    return true;
  };
  /* Replies that are empty, a single dash, or [[quiet]] (what a steward writes for a notice that needed nothing from
     the user) are hidden. Rows are checked again on every sweep, so a reply still streaming shows once it has text. */
  var QUIET_REPLY = /^\s*(?:[-\u2013\u2014\u00b7\u2022]|\[\[quiet\]\])?\s*$/;
  var quietRow = function(row, quiet){
    if (quiet) {
      if (row.getAttribute('data-cce-quiet') !== '1') { row.setAttribute('data-cce-quiet', '1'); row.style.display = 'none'; }
    } else if (row.getAttribute('data-cce-quiet') === '1') { row.removeAttribute('data-cce-quiet'); row.style.display = ''; }
  };
  /* A message from another conversation, or a notice, is not shown as a prompt: Claude Code folds it, with whatever was
     done in answer, into a row that reads "1 hidden step" or "2 tool calls". When the answer is only a quiet reply,
     that row is hidden too. A fold that starts with an assistant message belongs to a turn the user began, and stays. */
  var FOLD_ROW = '[data-testid="focus-fold-row"]';
  var foldBefore = function(msg){
    for (var a = msg, i = 0; a && i < 4; a = a.parentElement, i++) {
      var p = a.previousElementSibling;
      if (p) return p.matches && p.matches(FOLD_ROW) ? p : null;
    }
    return null;
  };
  var foldOf = function(el){
    for (var f = fiber(el), i = 0; f && i < 8; f = f.return, i++) {
      var pr = f.memoizedProps;
      if (pr && pr.fold && Array.isArray(pr.fold.messages)) return pr.fold;
    }
    return null;
  };
  var quietFold = function(msg, quiet){
    var row = foldBefore(msg);
    if (!row) return;
    var fold = quiet ? foldOf(row) : null, first = fold && fold.messages[0];
    quietRow(row, !!(fold && fold.progress === 'settled' && first && first.msg && first.msg.type === 'user'));
  };

  var onMutations = function(records){
    try { if (typeof ctxTipWatch === 'function') ctxTipWatch(records); } catch (e) {}
    /* Changes inside the document's head are stylesheets coming and going - this script's own reloads among them - and
       none of them can change a message. A panel that mounts something there changes the body as well, which is what
       gets swept. Without this, every reload of a stylesheet was a sweep of its own. The same goes for our own nodes. */
    for (var r = 0; r < records.length; r++) {
      var t = records[r].target;
      if (t === head || (t && t.parentNode === head) || oursOnly(records[r])) continue;
      schedule();
      return;
    }
  };

  var aimed = null, aimer = null, aimedAtScroller = false;
  var aimText = function(anyMessage){
    if (!anyMessage) return;
    /* Reuse the scroller while it still contains the messages: finding it again reads the style and size of every
       ancestor, which forces a style and layout pass in the middle of the sweep's writes. */
    if (aimedAtScroller && aimed.isConnected && aimed.contains(anyMessage)) return;
    var sc = scrollerOf(anyMessage), root = sc || anyMessage.parentElement;
    aimedAtScroller = !!sc;
    if (!root || root === aimed) return;
    if (aimer) aimer.disconnect();
    aimer = new MutationObserver(onMutations);
    // Text only: the document's observer already reports every child added or taken away, these included.
    aimer.observe(root, { characterData: true, subtree: true });
    aimed = root;
  };

  /*
   * One line, once, after the first sweep, into the panel's devtools console. That console is the only place a page
   * script can write - the panel has no file system, and the channel to the extension runs one way - so a question
   * like "why was opening this slow" has to be answered from here. The resource timings are the browser's own, which
   * is what makes the stylesheet's real cost visible rather than guessed at.
   */
  var report = function(){
    try {
      var css, rev, all = performance.getEntriesByType('resource') || [];
      for (var i = 0; i < all.length; i++) {
        var n = String(all[i].name || '');
        if (n.indexOf(LIVE_CSS) !== -1) css = Math.round(all[i].duration);
        else if (n.indexOf(LIVE_REV) !== -1) rev = Math.round(all[i].duration);
      }
      var bits = ['script ran at ' + Math.round(T0) + 'ms', 'started work at ' + Math.round(bootAt) + 'ms',
        'first sweep ' + Math.round(firstSweepMs) + 'ms over ' + sweptElements + ' elements'];
      if (css !== undefined) bits.push('stylesheet ' + css + 'ms');
      if (rev !== undefined) bits.push('revision probe ' + rev + 'ms');
      console.log('[claude-code-extras] ' + bits.join(' | ')
        + '\n  first sweep: ' + (stats.last ? where(stats.last) : 'nothing on the page yet')
        + '\n  call __cceStats() at any time for where the sweeps have spent the main thread since.');
    } catch (e) {}
  };

  /*
   * Startup order. The panel is still laying itself out when this script runs, so everything that reads or watches the
   * page waits for the browser to report itself idle; only the stylesheet goes in straight away, and it no longer
   * blocks painting. Before this, the mutation observer and an immediate first sweep both ran while the first paint was
   * still pending - work the panel had to get through before it could show anything at all.
   */
  reloadCss();
  var booted = false;
  var boot = function(){
    if (booted) return;
    booted = true;
    bootAt = clock();
    /* Structure anywhere on the page, which is what tells us a message arrived, a block opened, or the list itself was
       replaced. Deliberately without characterData: see aimText below. */
    new MutationObserver(onMutations).observe(document.documentElement, { childList: true, subtree: true });
    probe();
    setInterval(probe, POLL_MS);
    // Leftovers in the editor's resource cache (05-page-setup.js): once the panel has settled, then now and again.
    setTimeout(function(){ try { sweepCaches(); } catch (e) {} }, 30000);
    setInterval(function(){ try { sweepCaches(); } catch (e) {} }, SWEEP_MS);
    try { window.addEventListener('pagehide', function(){ forget(lastProbeUrl); }); } catch (e) {}
    try { listenForAnswers(); } catch (e) {}
    try { listenForFocus(); } catch (e) {}
    // The chime and the low-context outline must not depend on DOM churn: a turn can end without
    // any further mutation, which would leave the last sweep observing a still-busy state.
    setInterval(function(){ try { watchIdle(); } catch (e) {} try { fillWindow(); } catch (e) {} try { markCtxLow(); } catch (e) {} try { ensureMute(); } catch (e) {} try { ensureInfo(); } catch (e) {} try { ensureFocusControl(); } catch (e) {} try { paintToolClock(); } catch (e) {} try { orderControls(); } catch (e) {} }, 700);
    run();
    report();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(boot, { timeout: 1500 });
  else setTimeout(boot, 150);
