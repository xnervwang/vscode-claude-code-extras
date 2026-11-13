// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// The context breakdown shown on hovering the usage meter, and what the work plan has added to the context.
// Fragment of the in-page script - see README.md in this folder.

  // Context usage breakdown on hover. The CLI recomputes per-part token counts for each request, so it is never polled:
  // it is requested only after the pointer rests on the meter, and cached until the used-token count changes, at most
  // once per turn. ctxBusy is the session with a request in flight, so one pending for a conversation the panel has
  // left does not block the current one.
  var CTX = null, ctxCache = null, ctxKey = '', ctxAt = 0, ctxOpenTimer = null, ctxHideTimer = null, ctxBusy = null;
  var ctxBtn = null, ctxOver = false;
  var CTX_TTL = 20000;  // even with an unchanged token count, the breakdown can shift when CLAUDE.md, skills or memory files change between turns
  var ctxWired = (typeof WeakSet === 'function') ? new WeakSet() : null;

  var kfmt = agentPlusKit.kfmt;
  // Laid out like the /context view, and coloured from the same eight chart variables the panel uses there, so the
  // two read as one thing. The class names in that view carry a per-build hash, so the look is rebuilt here from
  // plain styles rather than borrowed by name.
  var CHART_FALLBACK = ['#7aa2f7', '#7dcfff', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#2ac3de', '#c0caf5'];
  var chartColor = function(i){
    var k = i % CHART_FALLBACK.length;
    return 'var(--app-chart-' + (k + 1) + ', ' + CHART_FALLBACK[k] + ')';
  };
  var pctText = agentPlusKit.pct;
  // Home directories are shown as ~ the way the panel does it, so a long path leaves room for the figure. Written
  // with plain string work on purpose: this whole script is a template literal, and a regex containing a slash needs
  // an escape level that is easy to get wrong and fails only at runtime.
  var HOME_PREFIX = ['/Users/', '/home/'];
  var shortPath = function(path){
    var p = String(path || '');
    for (var i = 0; i < HOME_PREFIX.length; i++) {
      if (p.indexOf(HOME_PREFIX[i]) !== 0) continue;
      var rest = p.slice(HOME_PREFIX[i].length), cut = rest.indexOf('/');
      return cut === -1 ? '~' : '~' + rest.slice(cut);
    }
    if (p.indexOf('/root') === 0) return '~' + p.slice(5);
    return p;
  };
  var swatch = function(color){
    var s = document.createElement('span');
    s.style.flex = '0 0 auto'; s.style.width = '8px'; s.style.height = '8px';
    s.style.borderRadius = '2px'; s.style.marginRight = '6px';
    if (color) s.style.background = color;
    return s;
  };
  var ctxRow = function(name, tokens, pct, color, dim){
    var row = document.createElement('div');
    row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.padding = '1px 0';
    if (dim) row.style.opacity = '0.65';
    row.appendChild(swatch(color));
    var a = document.createElement('span');
    a.textContent = name;
    a.title = name;
    a.style.flex = '1 1 auto'; a.style.minWidth = '0';
    a.style.overflow = 'hidden'; a.style.textOverflow = 'ellipsis'; a.style.whiteSpace = 'nowrap';
    var b = document.createElement('span');
    b.textContent = kfmt(tokens);
    b.style.flex = '0 0 auto'; b.style.width = '54px'; b.style.textAlign = 'right';
    b.style.fontVariantNumeric = 'tabular-nums';
    var c = document.createElement('span');
    c.textContent = pct || '';
    c.style.flex = '0 0 auto'; c.style.width = '48px'; c.style.textAlign = 'right';
    c.style.opacity = '0.75'; c.style.fontVariantNumeric = 'tabular-nums';
    row.appendChild(a); row.appendChild(b); row.appendChild(c);
    return row;
  };
  var ctxHead = function(title, hint){
    var d = document.createElement('div');
    d.style.display = 'flex'; d.style.alignItems = 'baseline'; d.style.gap = '6px';
    d.style.marginTop = '8px'; d.style.paddingTop = '5px';
    d.style.borderTop = '1px solid var(--vscode-widget-border, rgba(255,255,255,0.12))';
    var t = document.createElement('span');
    t.textContent = title;
    t.style.fontWeight = '600';
    d.appendChild(t);
    if (hint) {
      var h = document.createElement('span');
      h.textContent = hint;
      h.style.opacity = '0.55';
      d.appendChild(h);
    }
    return d;
  };
  var renderCtx = function(u){
    CTX.textContent = '';
    // The tooltip is hidden while the breakdown is open, so its text goes at the top.
    var said = tipLines();
    if (said) {
      var top = document.createElement('div');
      top.textContent = said;
      top.style.whiteSpace = 'pre-wrap'; top.style.opacity = '0.8'; top.style.marginBottom = '6px';
      CTX.appendChild(top);
    }
    if (u.status) {
      var st = document.createElement('div');
      st.textContent = u.status;
      CTX.appendChild(st);
      return;
    }
    var cats = (u.categories || []).filter(function(c){ return c && c.tokens > 0 && !c.isDeferred; });
    var head = document.createElement('div');
    head.style.display = 'flex'; head.style.justifyContent = 'space-between';
    head.style.gap = '10px'; head.style.fontWeight = '600'; head.style.marginBottom = '6px';
    var model = document.createElement('span');
    model.textContent = u.model || '';
    model.style.overflow = 'hidden'; model.style.textOverflow = 'ellipsis'; model.style.whiteSpace = 'nowrap';
    var figures = document.createElement('span');
    figures.textContent = kfmt(u.totalTokens) + ' / ' + kfmt(u.rawMaxTokens) + ' tokens (' + u.percentage + '%)';
    figures.style.flex = '0 0 auto'; figures.style.fontVariantNumeric = 'tabular-nums';
    head.appendChild(model); head.appendChild(figures);
    CTX.appendChild(head);
    // One bar across the window, a segment per category. Free space is left out so the bar shows what is taken.
    var track = document.createElement('div');
    track.style.display = 'flex'; track.style.height = '6px'; track.style.borderRadius = '3px';
    track.style.overflow = 'hidden'; track.style.marginBottom = '8px';
    track.style.background = 'var(--vscode-widget-border, rgba(255,255,255,0.10))';
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].name === 'Free space') continue;
      var seg = document.createElement('div');
      seg.style.background = chartColor(i);
      seg.style.width = (u.rawMaxTokens > 0 ? cats[i].tokens / u.rawMaxTokens * 100 : 0) + '%';
      seg.title = cats[i].name + ': ' + kfmt(cats[i].tokens);
      track.appendChild(seg);
    }
    CTX.appendChild(track);
    var sorted = cats.slice().sort(function(a, b){ return b.tokens - a.tokens; });
    for (var j = 0; j < sorted.length; j++) {
      var free = sorted[j].name === 'Free space';
      CTX.appendChild(ctxRow(sorted[j].name, sorted[j].tokens, pctText(sorted[j].tokens, u.rawMaxTokens),
                             free ? null : chartColor(cats.indexOf(sorted[j])), free));
    }
    var mem = (u.memoryFiles || []).slice().sort(function(a, b){ return b.tokens - a.tokens; }).slice(0, 5);
    if (mem.length) {
      CTX.appendChild(ctxHead('Memory files', '/memory'));
      for (var k = 0; k < mem.length; k++) CTX.appendChild(ctxRow(shortPath(mem[k].path), mem[k].tokens, '', null));
    }
    var ags = (u.agents || []).slice().sort(function(a, b){ return b.tokens - a.tokens; }).slice(0, 5);
    if (ags.length) {
      CTX.appendChild(ctxHead('Custom agents', '/agents'));
      for (var q = 0; q < ags.length; q++) CTX.appendChild(ctxRow(ags[q].agentType, ags[q].tokens, '', null));
    }
    var f = planNow() && planNow().plan;
    if (f) {
      CTX.appendChild(ctxHead('Work plan', f.since));
      CTX.appendChild(ctxRow('Injected ' + f.count + (f.count === 1 ? ' time' : ' times'), f.tokens,
                             pctText(f.tokens, u.rawMaxTokens), null));
    }
  };
  var ensureCtx = function(){
    if (CTX && CTX.isConnected) return;
    CTX = document.createElement('div');
    CTX.id = 'cce-ctx';
    var s = CTX.style;
    s.position = 'fixed'; s.zIndex = '32'; s.display = 'none';
    s.width = '352px'; s.boxSizing = 'border-box'; s.maxHeight = '60vh'; s.overflowY = 'auto';
    s.padding = '8px 10px'; s.borderRadius = '5px';
    s.fontSize = '11px'; s.lineHeight = '1.5';
    s.background = 'var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.99))';
    s.color = 'var(--vscode-editorHoverWidget-foreground, #ddd)';
    s.border = '1px solid var(--vscode-editorHoverWidget-border, rgba(255,255,255,0.18))';
    s.boxShadow = '0 4px 14px rgba(0,0,0,0.5)';
    CTX.addEventListener('mouseenter', function(){
      ctxOver = true;
      if (ctxHideTimer) { clearTimeout(ctxHideTimer); ctxHideTimer = null; }
    });
    CTX.addEventListener('mouseleave', function(){ ctxOver = false; hideCtx(); });
    document.body.appendChild(CTX);
  };
  // The panel draws its own tooltip for this button, with the summary figure. This script leaves it alone until the
  // breakdown opens, then hides it with an inline style (the panel's rendering keeps inline styles) and puts its text
  // at the top of the breakdown. No node is ever added inside it: one added inside a node the panel renders can break
  // that rendering, and then the page stops taking clicks and keys.
  var nativeTip = function(){
    if (!ctxBtn || !ctxBtn.parentElement) return null;
    var kids = ctxBtn.parentElement.children;
    for (var i = 0; i < kids.length; i++) if (kids[i] !== ctxBtn) return kids[i];
    return null;
  };
  /* The work plan's figures for this panel's conversation, as last received (src/page/80-session-info.js). */
  var planNow = function(){
    var sid = sigValue('sessionId'), p = sid && PLANS[sid];
    return p && p.plan ? p : null;
  };
  var PLAN_ASKED = {};
  var askPlanSoon = function(){
    var sid = sigValue('sessionId');
    if (typeof sid !== 'string' || !sid) return;
    var p = PLANS[sid], now = Date.now();
    if ((p && now - p.at < CTX_TTL) || (PLAN_ASKED[sid] && now - PLAN_ASKED[sid] < CTX_TTL)) return;
    PLAN_ASKED[sid] = now;
    askPlan(sid);
  };
  /* The tooltip's text, one line per child element. */
  var tipText = function(el){
    var kids = el.children || [];
    if (kids.length === 1 && kids[0].children && kids[0].children.length) return tipText(kids[0]);
    if (!kids.length) return String(el.textContent || '').trim();
    var out = [];
    for (var i = 0; i < kids.length; i++) { var t = String(kids[i].textContent || '').trim(); if (t) out.push(t); }
    return out.join('\n');
  };
  // Not named showTip and hideTip: 45-toc.js has those, and all fragments are concatenated into one closure.
  var hiddenTip = null, hiddenText = '', ctxShown = null;
  var uncoverTip = function(){
    if (hiddenTip) { try { hiddenTip.style.visibility = ''; } catch (e) {} hiddenTip = null; }
  };
  var coverTip = function(tip){
    if (tip === hiddenTip) return;
    uncoverTip();
    hiddenText = tipText(tip);
    try { tip.style.visibility = 'hidden'; hiddenTip = tip; } catch (e) {}
  };
  /* The tooltip's text, or the copy saved when it was hidden, since the panel may have removed it by now. */
  var tipLines = function(){
    var tip = nativeTip();
    return tip && tip !== hiddenTip ? tipText(tip) : hiddenTip ? hiddenText : '';
  };
  /* A tooltip the panel adds while the breakdown is open is hidden as well, and the breakdown redrawn with its text. */
  var coverLateTip = function(){
    var tip = nativeTip();
    if (!tip || !ctxOver || !ctxShown || !CTX || CTX.style.display !== 'block') return;
    var was = hiddenTip;
    coverTip(tip);
    if (was !== tip && ctxBtn) { renderCtx(ctxShown); placeCtx(ctxBtn); }
  };
  /* Aligns the box's right edge with `right`, then shifts it right if its left edge would be less than 8 px from the page edge. */
  var inPage = function(el, right){
    var at = Math.max(8, window.innerWidth - right);
    el.style.right = at + 'px';
    var bb = el.getBoundingClientRect();
    if (bb && bb.left < 8) el.style.right = Math.max(8, at - (8 - bb.left)) + 'px';
  };
  /* The breakdown's bottom goes where the tooltip's bottom is, or just above the button when there is no tooltip. */
  var placeCtx = function(btn){
    var tip = nativeTip(), r = tip ? tip.getBoundingClientRect() : null;
    var b = btn.getBoundingClientRect();
    CTX.style.bottom = Math.max(8, window.innerHeight - (r ? r.bottom : b.top - 6)) + 'px';
    CTX.style.width = Math.max(160, Math.min(352, window.innerWidth - 16)) + 'px';
    inPage(CTX, (r || b).right);
  };
  var hideCtx = function(){
    if (ctxHideTimer) clearTimeout(ctxHideTimer);
    ctxHideTimer = setTimeout(function(){
      ctxHideTimer = null;
      if (CTX) CTX.style.display = 'none';
      ctxShown = null;
      uncoverTip();
    }, 200);
  };
  var ctxUsedKey = function(){
    var u = sessionRef && sessionRef.usageData && sessionRef.usageData.value;
    return u ? String(u.totalTokens) : '';
  };
  var ctxFresh = function(){
    return ctxCache !== null && ctxUsedKey() === ctxKey && (Date.now() - ctxAt) < CTX_TTL;
  };
  /* `shown` is a breakdown, or { status } when there is none to show. */
  var showCtx = function(shown){
    if (!ctxOver || !ctxBtn) return;
    ensureCtx();
    var tip = nativeTip();
    if (tip) coverTip(tip);
    ctxShown = shown;
    renderCtx(shown);
    CTX.style.display = 'block';
    // Positioned after showing it: a box with display:none has no width to measure.
    placeCtx(ctxBtn);
  };
  // The breakdown crosses into the command-line side and is recomputed there, so it is requested only after the
  // pointer settles. Until it arrives the panel's own tooltip stands alone.
  var canAskCtx = function(){ return !!sessionRef && typeof sessionRef.getContextUsage === 'function'; };
  var fetchCtx = function(){
    var asked = sessionRef;
    if (ctxBusy === asked || ctxFresh() || !canAskCtx()) return;
    var key = ctxUsedKey();
    ctxBusy = asked;
    asked.getContextUsage().then(function(res){
      if (ctxBusy === asked) ctxBusy = null;
      // An answer for a conversation the panel has since left, or one nobody is hovering any more, says nothing.
      if (sessionRef !== asked || !ctxOver) return;
      if (!res || !res.usage) { showCtx({ status: 'Breakdown unavailable' + (res && res.error ? ': ' + res.error : '') }); return; }
      ctxCache = res.usage; ctxKey = key; ctxAt = Date.now();
      showCtx(res.usage);
    }, function(){
      if (ctxBusy === asked) ctxBusy = null;
      if (sessionRef === asked && ctxOver) showCtx({ status: 'Breakdown request failed' });
    });
  };
  /* Called when the work plan's figures arrive. Redraws the breakdown if it is open on that conversation's meter. */
  var planArrived = function(sid){
    if (!ctxOver || sigValue('sessionId') !== sid) return;
    if (CTX && CTX.style.display === 'block' && ctxShown && !ctxShown.status) renderCtx(ctxShown);
  };
  /* The breakdown shown and kept belongs to the conversation it was asked for. */
  var forgetCtx = function(){
    ctxCache = null; ctxKey = ''; ctxAt = 0; ctxShown = null;
    if (CTX) CTX.style.display = 'none';
    uncoverTip();
  };
  var wireCtxButton = function(){
    var btn = document.querySelector('button[class*="usageButtonV2"]');
    if (!btn) return;
    if (ctxWired) { if (ctxWired.has(btn)) return; ctxWired.add(btn); }
    else if (btn.getAttribute('data-cce-ctx') === '1') return;
    else btn.setAttribute('data-cce-ctx', '1');
    ctxBtn = btn;
    btn.addEventListener('mouseenter', function(){
      ctxOver = true;
      if (ctxHideTimer) { clearTimeout(ctxHideTimer); ctxHideTimer = null; }
      askPlanSoon();
      if (ctxOpenTimer) clearTimeout(ctxOpenTimer);
      // Nothing of ours appears until the pointer has rested on the button for two seconds, so a quick look at the
      // panel's tooltip, or passing over the button, sends no request.
      ctxOpenTimer = setTimeout(function(){
        ctxOpenTimer = null;
        if (!ctxOver) return;
        if (ctxFresh()) showCtx(ctxCache);
        else fetchCtx();
      }, 2000);
    });
    btn.addEventListener('mouseleave', function(){
      ctxOver = false;
      if (ctxOpenTimer) { clearTimeout(ctxOpenTimer); ctxOpenTimer = null; }
      hideCtx();
    });
  };
  /* Called with each batch of records from the document observer (src/page/99-sweep.js). Mutation callbacks run before
     the next paint, so a tooltip added while the breakdown is open is hidden before it is ever drawn. */
  var ctxTipWatch = function(records){
    if (!ctxOver || !ctxShown || !ctxBtn || !ctxBtn.parentElement) return;
    for (var i = 0; i < records.length; i++) {
      if (records[i].target === ctxBtn.parentElement && records[i].addedNodes && records[i].addedNodes.length) {
        coverLateTip();
        return;
      }
    }
  };
