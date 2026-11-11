// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// The list of your own messages, and stepping between them.
// Fragment of the in-page script - see README.md in this folder.

  // Prompt table of contents. A small handle sits on the right edge; hovering it opens a list of
  // your own messages (time plus opening words). Clicking a row scrolls that message into view.
  // Built from the node list the stamper already gathered, so it adds no DOM query of its own.
  var HANDLE = null, PANEL = null, PLIST = null, PFILTER = null, TIP = null, SIG = '';
  // What the list was last built from, compared entry by entry on the next sweep instead of folded into one string.
  var SIG_NODES = [], SIG_TEXTS = [], SIG_WHENS = [];
  var outsideWired = false, MUTE = null, RAILBOX = null, PROMPT_EL = [];
  var ROWS = [];  // {row, hay} for the filter box
  /* The rail's sizes, and the gap the open list keeps from the right edge so that it never covers the rail. The glyph
     colour is the one the bar beside your own messages uses, so the two read as one feature and follow the theme
     together; only the glyphs take it, the buttons' background and border stay neutral. */
  var RAIL_W = 26, RAIL_BTN_H = 24, RAIL_HANDLE_H = 60;
  /* The glyph colour. `textLink-activeForeground` is the brighter of the theme's two link colours - the one meant to
     stand out against the editor's background - with the focus border, which the bar beside your own messages uses,
     as the fallback. The two are the same hue; this is the lighter of them, which is what a dark background needs. */
  var RAIL_INK = 'var(--vscode-textLink-activeForeground, var(--vscode-focusBorder))';
  var PANEL_W = 280, PANEL_GAP = RAIL_W + 2;
  /* While the rail shows, the message list gets extra right padding: the rail's width plus a small gap. The panel's own
     padding there is 20px, narrower than the rail with its border, so without this the rail sat over the right end of
     each user message and, in a narrow panel, over the last words of a reply's lines. */
  var RAIL_ROOM = RAIL_W + 1 + 8;
  var roomStyle = null;
  var keepRoom = function(on){
    if (on && !roomStyle) {
      roomStyle = document.createElement('style');
      roomStyle.setAttribute('data-cce-rail-room', '1');
      roomStyle.textContent = ':root[data-cce-rail] [class*="messagesContainer_"]{padding-right:' + RAIL_ROOM + 'px !important;}';
      head.appendChild(roomStyle);
    }
    if (on) document.documentElement.setAttribute('data-cce-rail', '1');
    else document.documentElement.removeAttribute('data-cce-rail');
  };

  var ensureTip = function(){
    if (TIP && TIP.isConnected) return;
    TIP = document.createElement('div');
    TIP.id = 'cce-toc-tip';
    var s = TIP.style;
    s.position = 'fixed'; s.zIndex = '31'; s.display = 'none';
    s.maxWidth = '360px'; s.maxHeight = '40vh'; s.overflow = 'hidden';
    s.padding = '6px 9px'; s.borderRadius = '4px';
    s.fontSize = '11px'; s.lineHeight = '1.45';
    s.whiteSpace = 'pre-wrap'; s.wordBreak = 'break-word';
    s.background = 'var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.98))';
    s.color = 'var(--vscode-editorHoverWidget-foreground, #ddd)';
    s.border = '1px solid var(--vscode-editorHoverWidget-border, rgba(255,255,255,0.18))';
    s.boxShadow = '0 2px 8px rgba(0,0,0,0.4)';
    s.pointerEvents = 'none';  // never steal hover from the row underneath
    document.body.appendChild(TIP);
  };
  var showTip = function(row, text){
    ensureTip();
    TIP.textContent = text;
    TIP.style.display = 'block';
    var r = row.getBoundingClientRect();
    var h = TIP.offsetHeight || 60;
    TIP.style.top = Math.min(Math.max(8, r.top - 6), Math.max(8, window.innerHeight - h - 8)) + 'px';
    TIP.style.right = (PANEL_GAP + PANEL_W + 8) + 'px';
  };
  var hideTip = function(){ if (TIP) TIP.style.display = 'none'; };

  var ARROW_SHUT = String.fromCharCode(8249), ARROW_OPEN = String.fromCharCode(8250);
  var panelOpen = function(){ return !!(PANEL && PANEL.style.display === 'block'); };
  // The list grows from the top of the window, so on a long conversation it would reach down over the composer row
  // and swallow clicks meant for the send - or stop - button. Its height is capped just above that row instead.
  var fitPanel = function(){
    if (!PANEL) return;
    var send = document.querySelector(SEND);
    var floor = send ? send.getBoundingClientRect().top - 12 : window.innerHeight - 16;
    PANEL.style.maxHeight = Math.max(120, floor - 8) + 'px';
  };
  var openPanel = function(){
    if (PANEL) PANEL.style.display = 'block';
    if (HANDLE) { HANDLE.textContent = ARROW_OPEN; }
    fitPanel();
    // The caret is deliberately left where it was: taking it for the filter box would mean Escape goes to that box
    // instead of to the panel, and Escape is how a running turn is stopped. Click the box to type in it.
    // open on the newest message, which is the one most likely wanted
    if (PANEL) PANEL.scrollTop = PANEL.scrollHeight;
  };
  var closePanel = function(){
    if (PANEL) PANEL.style.display = 'none';
    // Open or shut is said by which way the chevron points; dimming it as well only made it hard to see.
    if (HANDLE) { HANDLE.textContent = ARROW_SHUT; }
    hideTip();
  };

  // Step between your own messages. The list comes from the panel build, so this adds no scanning of its own;
  // rects are measured only on a click.
  //
  // The landing line is the TOP of a message rather than its centre: a message taller than the viewport, centred,
  // shows its middle, which reads as having stopped between two messages. The same line then decides which message
  // we are currently on, so the measurement that picks the next target and the place we scroll to agree - measuring
  // against a different line lets a click resolve to the message just left and appear to do nothing.
  var TOP_MARGIN = 12, LAND_TOL = 6, JUMP_HOLD = 600, SETTLE_MS = 80, SETTLE_TRIES = 14;
  var jumpIdx = -1, jumpAt = 0;
  var scrollerOf = function(el){
    for (var p = el.parentElement; p; p = p.parentElement) {
      var oy = '';
      try { oy = getComputedStyle(p).overflowY; } catch (e) {}
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return null;
  };
  var offsetIn = function(el, sc){
    return el.getBoundingClientRect().top - (sc ? sc.getBoundingClientRect().top : 0);
  };
  /*
   * The position is set at once and then held, rather than animated and checked once.
   *
   * The panel moves the conversation while we are moving it: three of its own effects call scrollIntoView, it keeps a
   * stick-to-bottom notion, and content above the target can still be settling. An animated scroll spends a few hundred
   * milliseconds inside that, and one correction at a fixed delay can read the position mid-animation or before the
   * last shift - which lands short of the line and reads as a jump that missed.
   *
   * The hold yields to the person at once: a wheel, a touch or a key means they are scrolling now, and pulling the view
   * back from under them would be the same defect seen from the other side.
   */
  // Scroll to a target and hold it there until it settles, because panel effects pull the view away after a jump
  // (message arrows, top and bottom buttons). `go` scrolls, `there` reports arrival, `alive` whether the target still
  // exists. A new jump cancels a hold that has not settled.
  var holdStop = null;
  var holdScroll = function(target, go, there, alive){
    if (holdStop) holdStop();
    go();
    var tries = 0, still = 0, tick = 0, arm = 0;
    var stop = function(){
      if (tick) clearInterval(tick);
      if (arm) clearTimeout(arm);
      tick = arm = 0;
      if (holdStop === stop) holdStop = null;
      target.removeEventListener('wheel', stop);
      target.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
    };
    holdStop = stop;
    tick = setInterval(function(){
      if ((alive && !alive()) || ++tries > SETTLE_TRIES) { stop(); return; }
      if (there()) {
        if (++still >= 2) stop();
        return;
      }
      still = 0;
      go();
    }, SETTLE_MS);
    target.addEventListener('wheel', stop, { passive: true });
    target.addEventListener('touchstart', stop, { passive: true });
    /* Add the window keydown listener on the next tick. A hold started by the , or . key begins while that keydown is
       still bubbling up to the window, and a listener added now would receive it and stop the hold immediately. */
    arm = setTimeout(function(){ arm = 0; window.addEventListener('keydown', stop); }, 0);
  };
  var landOn = function(el){
    if (!el || !el.isConnected) return;
    var r = el.getBoundingClientRect();
    // No box at all means hidden, or replaced by a re-render. Every number in its rect is zero, so a position computed
    // from it is arbitrary - and moving the view somewhere arbitrary is exactly what a missed jump looks like.
    if (!r.height && !r.width) return;
    var sc = scrollerOf(el);
    holdScroll(sc || window, function(){
      var delta = offsetIn(el, sc) - TOP_MARGIN;
      var opt = { top: (sc ? sc.scrollTop : window.scrollY) + delta, behavior: 'auto' };
      if (sc) sc.scrollTo(opt); else window.scrollTo(opt);
    }, function(){
      return Math.abs(offsetIn(el, sc) - TOP_MARGIN) <= LAND_TOL;
    }, function(){ return el.isConnected; });
  };
  /*
   * To the very top or the very bottom of the conversation.
   *
   * The scroller is found from a message rather than looked up by name, the way the arrows find it, so both act on the
   * same element whatever the panel calls it. The bottom is re-measured on every attempt: a reply still streaming makes
   * the conversation longer while the view is on its way there, and the end measured at the click would land short.
   *
   * The arrows' stepping cursor is dropped, so the next arrow press counts from where this left the view rather than
   * from a message picked before it.
   */
  var jumpEdge = function(toEnd){
    var any = null;
    for (var i = 0; i < PROMPT_EL.length && !any; i++) if (PROMPT_EL[i].isConnected) any = PROMPT_EL[i];
    if (!any) any = document.querySelector(ASSIST) || document.querySelector(USER);
    if (!any) return;
    var sc = scrollerOf(any);
    jumpIdx = -1; jumpAt = 0;
    var at = function(){ return sc ? sc.scrollTop : window.scrollY; };
    var end = function(){
      return sc ? sc.scrollHeight - sc.clientHeight : document.documentElement.scrollHeight - window.innerHeight;
    };
    holdScroll(sc || window, function(){
      var opt = { top: toEnd ? end() : 0, behavior: 'auto' };
      if (sc) sc.scrollTo(opt); else window.scrollTo(opt);
    }, function(){
      return toEnd ? end() - at() <= LAND_TOL : at() <= LAND_TOL;
    });
  };
  var jumpPrompt = function(dir){
    var alive = [];
    for (var i = 0; i < PROMPT_EL.length; i++) if (PROMPT_EL[i].isConnected) alive.push(PROMPT_EL[i]);
    if (!alive.length) return;
    var from;
    if (jumpIdx >= 0 && jumpIdx < alive.length && Date.now() - jumpAt < JUMP_HOLD) {
      from = jumpIdx;                   // the previous jump is still settling; count from its target
    } else {
      var sc = scrollerOf(alive[0]), best = 0, bestD = Infinity;
      for (var j = 0; j < alive.length; j++) {
        var d = Math.abs(offsetIn(alive[j], sc) - TOP_MARGIN);
        if (d < bestD) { bestD = d; best = j; }
      }
      from = best;
    }
    var t = from + dir;
    if (t < 0) t = 0;
    if (t > alive.length - 1) t = alive.length - 1;
    jumpIdx = t; jumpAt = Date.now();
    landOn(alive[t]);
  };
  var railButton = function(label, onClick){
    var b = document.createElement('div');
    b.title = label;
    var s = b.style;
    s.width = RAIL_W + 'px'; s.height = RAIL_BTN_H + 'px';
    s.display = 'flex'; s.alignItems = 'center'; s.justifyContent = 'center';
    /* Full opacity. Held at 0.55 the glyph was dimmed before it ever reached the screen, so no choice of colour could
       make it carry; the hover now shows in the background instead, which is what hover is for. */
    s.cursor = 'pointer'; s.opacity = '1'; s.fontSize = '13px';
    s.userSelect = 'none'; s.borderRadius = '3px 0 0 3px';
    s.background = 'var(--vscode-editorWidget-background, rgba(40,40,40,0.92))';
    s.border = '1px solid var(--vscode-widget-border, rgba(255,255,255,0.14))';
    s.borderRight = 'none';
    s.color = RAIL_INK;
    /* The theme's hover colour is translucent, so it is drawn over the button's own background. */
    var plain = s.background, tint = 'var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.12))';
    var lit = 'linear-gradient(' + tint + ',' + tint + '),' + plain;
    b.addEventListener('mouseenter', function(){ s.background = lit; });
    b.addEventListener('mouseleave', function(){ s.background = plain; });
    b.addEventListener('click', function(ev){ ev.stopPropagation(); onClick(); });
    return b;
  };
  var navButton = function(glyph, dir, label){
    var b = railButton(label, function(){ jumpPrompt(dir); });
    b.textContent = glyph;
    return b;
  };
  /*
   * A triangle against a bar - pointing at the edge it goes to, the sign media controls use for first and last. Drawn
   * rather than taken from a font: the panel's policy blocks the fonts that carry such arrows, and a glyph that is missing
   * draws an empty box with nothing to say why. Sized to sit beside the arrows above and below it without changing the
   * rail's width.
   */
  var edgeIcon = function(toEnd){
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.style.width = '13px'; svg.style.height = '13px';
    var bar = document.createElementNS(NS, 'path');
    bar.setAttribute('d', toEnd ? 'M1.5 8.5h7' : 'M1.5 1.5h7');
    bar.setAttribute('stroke', 'currentColor');
    bar.setAttribute('stroke-width', '1.4');
    bar.setAttribute('stroke-linecap', 'round');
    bar.setAttribute('fill', 'none');
    var tri = document.createElementNS(NS, 'path');
    tri.setAttribute('d', toEnd ? 'M2 2.5h6L5 6.5z' : 'M2 7.5h6L5 3.5z');
    tri.setAttribute('fill', 'currentColor');
    svg.appendChild(bar);
    svg.appendChild(tri);
    return svg;
  };
  var edgeButton = function(toEnd, label){
    var b = railButton(label, function(){ jumpEdge(toEnd); });
    b.appendChild(edgeIcon(toEnd));
    return b;
  };
  // ',' and '.' step between your messages, but only when the caret is not in an editable field.
  // The guard is deliberately broad: skipping a keystroke is harmless, swallowing one meant for the
  // composer is not. Modifier combinations are left alone so host shortcuts still work.
  var keysWired = false;
  var wireKeys = function(){
    if (keysWired) return;
    keysWired = true;
    document.addEventListener('keydown', function(ev){
      if (ev.key !== ',' && ev.key !== '.') return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
      if (isOff('toc')) return;
      var a = document.activeElement;
      if (a) {
        var tag = a.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (a.isContentEditable) return;
        if (typeof a.closest === 'function' &&
            a.closest('[contenteditable="true"], [contenteditable=""], input, textarea')) return;
      }
      if (!PROMPT_EL.length) return;
      ev.preventDefault();
      jumpPrompt(ev.key === ',' ? -1 : 1);
    });
  };
  var ensureUI = function(){
    if (isOff('toc')) return;
    if (RAILBOX && RAILBOX.isConnected && PANEL && PANEL.isConnected) return;
    SIG = '';  // rebuilt containers hold no rows
    HANDLE = document.createElement('div');
    HANDLE.id = 'cce-toc-handle';
    var h = HANDLE.style;
    h.width = RAIL_W + 'px'; h.height = RAIL_HANDLE_H + 'px';
    h.display = 'flex'; h.alignItems = 'center'; h.justifyContent = 'center';
    h.cursor = 'pointer'; h.opacity = '1'; h.transition = 'opacity 120ms';
    h.borderRadius = '4px 0 0 4px';
    h.background = 'var(--vscode-editorWidget-background, rgba(40,40,40,0.92))';
    h.border = '1px solid var(--vscode-widget-border, rgba(255,255,255,0.14))';
    h.borderRight = 'none';
    h.color = RAIL_INK;
    h.fontSize = '18px'; h.userSelect = 'none';
    HANDLE.textContent = ARROW_SHUT;
    setLabel(HANDLE, 'Your messages in this conversation - click one to jump to it');
    HANDLE.addEventListener('click', function(ev){
      ev.stopPropagation();
      if (panelOpen()) closePanel(); else openPanel();
    });
    // One vertical strip: to the top, up arrow, handle, down arrow, to the bottom - the outer pair going furthest. Its
    // layer sits under the panel so an open panel covers it rather than the other way round.
    RAILBOX = document.createElement('div');
    RAILBOX.id = 'cce-toc-rail';
    var rb = RAILBOX.style;
    rb.position = 'fixed'; rb.right = '0'; rb.top = '50%';
    rb.transform = 'translateY(-50%)'; rb.zIndex = '29';
    rb.display = 'flex'; rb.flexDirection = 'column'; rb.alignItems = 'flex-end';
    RAILBOX.appendChild(edgeButton(false, 'Top of the conversation'));
    RAILBOX.appendChild(navButton(String.fromCharCode(9652), -1, 'Previous message'));
    RAILBOX.appendChild(HANDLE);
    RAILBOX.appendChild(navButton(String.fromCharCode(9662), 1, 'Next message'));
    RAILBOX.appendChild(edgeButton(true, 'Bottom of the conversation'));
    document.body.appendChild(RAILBOX);
    wireKeys();

    PANEL = document.createElement('div');
    PANEL.id = 'cce-toc';
    var p = PANEL.style;
    p.position = 'fixed'; p.right = PANEL_GAP + 'px'; p.top = '8px';
    p.width = PANEL_W + 'px'; p.maxHeight = 'calc(100vh - 16px)';
    p.zIndex = '30'; p.display = 'none'; p.overflowY = 'auto';
    p.padding = '5px 0'; p.borderRadius = '5px'; p.boxSizing = 'border-box';
    p.background = 'var(--vscode-editorWidget-background, rgba(35,35,35,0.98))';
    p.border = '1px solid var(--vscode-widget-border, rgba(255,255,255,0.14))';
    p.boxShadow = '0 4px 14px rgba(0,0,0,0.45)';
    p.fontSize = '11px'; p.lineHeight = '1.4';
    if (!outsideWired) {
      outsideWired = true;
      // an outside click dismisses it; clicks inside the panel or on the handle do not
      document.addEventListener('click', function(ev){
        if (!panelOpen()) return;
        var t = ev.target;
        if ((PANEL && PANEL.contains(t)) || (HANDLE && HANDLE.contains(t))) return;
        closePanel();
      });
    }

    var head = document.createElement('div');
    head.style.display = 'flex'; head.style.alignItems = 'center';
    head.style.gap = '6px'; head.style.padding = '3px 8px 6px 8px';
    // sticky so the filter stays reachable after the list is scrolled to the newest entry
    head.style.position = 'sticky'; head.style.top = '0'; head.style.zIndex = '1';
    head.style.background = 'var(--vscode-editorWidget-background, rgba(35,35,35,0.98))';

    PFILTER = document.createElement('input');
    PFILTER.type = 'text';
    PFILTER.placeholder = 'Filter your messages';
    var fi = PFILTER.style;
    fi.flex = '1 1 auto'; fi.minWidth = '0'; fi.margin = '0'; fi.width = '100%';
    fi.padding = '3px 6px'; fi.boxSizing = 'border-box';
    fi.fontSize = '11px'; fi.borderRadius = '3px';
    fi.background = 'var(--vscode-input-background, rgba(0,0,0,0.3))';
    fi.color = 'var(--vscode-input-foreground, #ddd)';
    fi.border = '1px solid var(--vscode-input-border, rgba(255,255,255,0.16))';
    fi.outline = 'none';
    PFILTER.addEventListener('input', applyFilter);
    head.appendChild(PFILTER);

    PANEL.appendChild(head);
    PLIST = document.createElement('div');
    PANEL.appendChild(PLIST);
    document.body.appendChild(PANEL);
  };
  var applyFilter = function(){
    var q = (PFILTER && PFILTER.value || '').toLowerCase().trim();
    for (var i = 0; i < ROWS.length; i++) {
      ROWS[i].row.style.display = (!q || ROWS[i].hay.indexOf(q) !== -1) ? 'block' : 'none';
    }
  };

  // Label for one tool call, used as a table-of-contents entry inside a sub-agent view.
  var toolLabel = function(c){
    var name = (c && c.name) || 'tool', arg = '';
    var inp = c && c.input;
    if (inp && typeof inp === 'object') {
      var keys = ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'description'];
      for (var i = 0; i < keys.length; i++) {
        var v = inp[keys[i]];
        if (typeof v === 'string' && v) { arg = v.replace(/\s+/g, ' ').trim(); break; }
      }
    }
    if (arg.length > 34) arg = arg.slice(0, 34) + '..';
    return arg ? name + ' ' + arg : name;
  };
  /* Whether the entries are those the list was last built from. Compared from the end, where a new message lands. */
  var sameEntries = function(nodes, texts, whens){
    if (nodes.length !== SIG_NODES.length) return false;
    for (var k = nodes.length - 1; k >= 0; k--) {
      if (nodes[k] !== SIG_NODES[k] || texts[k] !== SIG_TEXTS[k] || whens[k] !== SIG_WHENS[k]) return false;
    }
    return true;
  };
  var syncMap = function(items, compEls){
    // Switched off, the rail and the list go and nothing is built; the keys stop with them.
    if (isOff('toc')) {
      RAILBOX = dropControl(RAILBOX); PANEL = dropControl(PANEL); hideTip(); keepRoom(false);
      PROMPT_EL = []; SIG = '';
      return;
    }
    var texts = [], nodes = [], whens = [];
    for (var i = 0; i < items.length; i++) {
      var t = items[i].text;
      if (!t) continue;
      // The time is formatted once and kept on the entry, which lives as long as its block for every message but the
      // newest.
      var when = items[i].when;
      if (typeof when !== 'string') when = items[i].when = fmt(items[i].ts);
      /* Landing goes to where the message starts, which is not always the block the text was read from. */
      texts.push(t); nodes.push(items[i].top || items[i].node); whens.push(when);
    }
    if (!texts.length) {
      if (RAILBOX) RAILBOX.style.display = 'none';
      if (PANEL) PANEL.style.display = 'none';
      keepRoom(false);
      return;
    }
    // Compaction rules belong to the conversation timeline, not to a single agent's tool trace.
    var comps = (VIEW === 'all' || VIEW === 'main') ? (compEls || []) : [];
    var sig = VIEW + '|' + comps.length;
    ensureUI();
    RAILBOX.style.display = 'flex';
    keepRoom(true);
    if (panelOpen()) fitPanel();
    PROMPT_EL = nodes;
    if (sig === SIG && sameEntries(nodes, texts, whens)) return;
    SIG = sig; SIG_NODES = nodes; SIG_TEXTS = texts; SIG_WHENS = whens;
    /*
     * Compaction points are timeline landmarks, so they get a rule in the list, placed by document order against the
     * prompts. Placed here, after the signature has said the list must be rebuilt, and by halving rather than walking:
     * ordering two siblings costs the browser a walk along the siblings between them, every message is a sibling of
     * every other, and doing it for each prompt on every sweep took tens of milliseconds a sweep on a long conversation.
     * The prompts are in document order, so "comes before this point" holds up to one index and not after it.
     */
    var marks = [];
    for (var q = 0; q < comps.length; q++) {
      var ce = comps[q], lo = 0, hi = nodes.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (nodes[mid].compareDocumentPosition(ce) & 4) lo = mid + 1; else hi = mid;
      }
      var head = ce.querySelector('summary') || ce;
      marks.push({ after: lo, label: ((head.textContent || 'Compacted').replace(/\s+/g, ' ').trim()) });
    }
    PLIST.textContent = '';
    ROWS = [];
    var rule = function(label){
      var d = document.createElement('div');
      d.style.display = 'flex'; d.style.alignItems = 'center'; d.style.gap = '6px';
      d.style.padding = '4px 10px'; d.style.opacity = '0.6';
      var line = function(){
        var l = document.createElement('div');
        l.style.flex = '1 1 auto'; l.style.height = '1px';
        l.style.background = 'var(--vscode-widget-border, rgba(255,255,255,0.22))';
        return l;
      };
      var t = document.createElement('span');
      t.textContent = label.slice(0, 34);
      t.style.flex = '0 0 auto'; t.style.whiteSpace = 'nowrap';
      t.style.fontSize = '10px';
      d.appendChild(line()); d.appendChild(t); d.appendChild(line());
      PLIST.appendChild(d);
      ROWS.push({ row: d, hay: label.toLowerCase() });
    };
    var placeMarks = function(upto){
      for (var mi = 0; mi < marks.length; mi++) if (marks[mi].after === upto) rule(marks[mi].label);
    };
    for (var j = 0; j < texts.length; j++) {
      placeMarks(j);
      (function(node, text, when){
        var row = document.createElement('div');
        var s = row.style;
        s.padding = '4px 10px'; s.cursor = 'pointer';
        s.whiteSpace = 'nowrap'; s.overflow = 'hidden'; s.textOverflow = 'ellipsis';
        s.color = 'var(--vscode-foreground, #ccc)';
        // Digits of one width, so the times line up and each question starts where the one above it does.
        if (when) {
          var at = document.createElement('span');
          at.style.fontVariantNumeric = 'tabular-nums'; at.style.fontKerning = 'none';
          at.textContent = when;
          row.appendChild(at);
        }
        row.appendChild(document.createTextNode((when ? '  ' : '') + (text.length > 44 ? text.slice(0, 44) + String.fromCharCode(8230) : text)));
        row.addEventListener('mouseenter', function(){
          row.style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.08))';
          showTip(row, (when ? when + String.fromCharCode(10) : '') + text.slice(0, 220));
        });
        row.addEventListener('mouseleave', function(){
          row.style.background = 'transparent';
          hideTip();
        });
        row.addEventListener('click', function(ev){
          ev.stopPropagation();
          hideTip();
          jumpAt = 0;        // drop the stepping cursor: the next arrow press re-reads the position
          landOn(node);
        });
        PLIST.appendChild(row);
        ROWS.push({ row: row, hay: (when + ' ' + text).toLowerCase() });
      })(nodes[j], texts[j], whens[j]);
    }
    placeMarks(texts.length);
    applyFilter();
  };
