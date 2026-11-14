// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Selectors, the live stylesheet, and its revision probe.
// Fragment of the in-page script - see README.md in this folder.

  // When this script started, for the one-line startup timing printed after the first sweep.
  var T0 = (function(){ try { return performance.now(); } catch (e) { return 0; } })();

  /*
   * The two searches whose cost no element count can express: walking up React's own tree to find the message a row
   * belongs to, and walking down a row's tree to find the element holding its first line of text. Both are bounded
   * per call and cached afterwards, so they vanish from a total - yet on a first sweep across a long conversation
   * they are where the time goes. Each adds the steps it took, once per call, so a report can name them.
   */
  var WALK = { fiber: 0, text: 0 };

  var USER = '[class*="userMessage_"]', ASSIST = '[data-testid="assistant-message"]';
  var COMPACT = 'details[class*="compact"]';
  // The send button is the footer toolbar's stable anchor: the permission-mode selector is its previous sibling, every
  // control this extension adds is placed against it, and it is the one element of the panel that is present before
  // the conversation has anything in it.
  var SEND = 'button[type="submit"][data-permission-mode]';
  var head = document.head || document.documentElement;

  /* The bar on your own messages, put in once and never touched again. It is here rather than in the live stylesheet
     because that file is shared by every window: a window running an older build rewrites it without knowing the rule
     exists, which made the bar blink. Its switch is a custom property the stylesheet may set, and an absent property
     counts as on - so a stylesheet that knows nothing about it leaves the bar alone. */
  (function(){
    var edge = document.createElement('style');
    edge.setAttribute('data-cce-edge', '1');
    edge.textContent = EDGE_CSS;
    head.appendChild(edge);
  })();

  /*
   * Hover text for the controls this script adds, drawn rather than left to the browser.
   *
   * The native `title` attribute does not surface in this panel. Its own footer hints are a component it renders on
   * mouseenter - the context meter's is one of them - and not one control in that row carries a `title` that a reader
   * ever sees. So relying on the attribute meant these buttons had no hover text at all, however carefully it was set.
   *
   * The box is styled from the same theme variables the panel's own hint uses, rather than by borrowing its class: the
   * build hashes the suffix of every class name, and matching `popup_` by pattern would just as happily find some other
   * component's popup. `aria-label` carries the text, which is what the panel's own buttons use for it, and is what the
   * handler reads - so changing the label needs no rewiring. The box itself comes from agentPlusKit.labels.
   */
  var tips = agentPlusKit.labels({ mark: ['data-cce-label', '1'], css: 'z-index:1000;padding:8px;'
    + 'background:var(--app-menu-background, var(--vscode-editorWidget-background, #252526));'
    + 'border:1px solid var(--app-input-border, var(--vscode-widget-border, #454545));border-radius:var(--corner-radius-large, 6px);'
    + 'color:var(--app-primary-foreground, var(--vscode-foreground, #ccc));font-size:.9em;' });
  var hideLabel = tips.hide, showLabel = tips.show;
  var setLabel = function(el, text){ tips.wire(el, text, 'data-cce-labelled'); };
  /* The repaints call this often and most calls change nothing, so a style property is written only when its value
     differs. */
  var setStyle = function(el, prop, value){
    if (el && el.style[prop] !== value) el.style[prop] = value;
  };
  /* Remove a control whose switch was turned off; not redrawing it would leave the existing one on the page and
     working. Also hide its hover label, since a removed control gets no pointer-leave event. */
  var dropControl = function(el){
    if (el && el.parentNode) { el.parentNode.removeChild(el); hideLabel(); }
    return null;
  };

  // ── live settings: stylesheet + revision probe from the panel's own folder ──
  var fallback = null, sheet = null, loadedOnce = false, lastRev = -1;
  var base = (function(){
    var l = document.querySelector('link[rel="stylesheet"][href*="index.css"]');
    return l ? String(l.href).replace(/index\.css([?#].*)?$/, '') : null;
  })();
  var useFallback = function(){
    if (fallback || loadedOnce) return;
    fallback = document.createElement('style');
    fallback.textContent = STAMP_CSS;
    head.appendChild(fallback);
  };
  /*
   * Load the settings stylesheet WITHOUT blocking the first paint.
   *
   * A plain <link rel="stylesheet"> stops the browser painting until the file has arrived, and on a remote host that
   * file is a round trip away - so an ordinary insert here held the panel blank for as long as the round trip took,
   * on every open, whether or not the conversation had anything in it. `media="print"` makes it a non-blocking load;
   * the media attribute is switched to all once it is in, which applies it in one go.
   *
   * The address carries the revision rather than the clock: a new address on every load meant the browser could never
   * reuse what it already had, so every panel re-fetched a file that had not changed. With the revision in it, the
   * address only changes when the content does - which is exactly when a re-fetch is wanted.
   */
  var cssUrl = function(){ return base + LIVE_CSS + (lastRev >= 0 ? '?v=' + lastRev : ''); };
  /*
   * Every address this script fetches has to be taken back out of the editor's cache once it is done with.
   *
   * The editor's webview service worker keeps each response that carries an ETag in a Cache Storage cache named
   * vscode-resource-cache-<n>, keyed on the full address, and never trims it. The revision poll changes its address
   * every time and the stylesheets change theirs with every revision, so each request used to leave one entry behind for
   * good. Over weeks one panel origin's cache grew to millions of entries and close to ten gigabytes, and a lookup in it
   * stopped returning: every panel of that origin then stayed blank, in every window, across restarts.
   *
   * The cache belongs to the panel's own origin, so the page can delete from it. The cache names are looked up once in
   * a while rather than on every call, since the poll would otherwise ask for them every three seconds.
   */
  var RESOURCE_CACHE = 'vscode-resource-cache-';
  var cacheNames = null, cacheNamesAt = 0;
  var withCaches = function(fn){
    try {
      if (typeof caches === 'undefined' || !caches || !caches.keys) return;
      var now = Date.now();
      var ready = cacheNames && now - cacheNamesAt < 600000 ? Promise.resolve(cacheNames)
        : caches.keys().then(function(names){
          cacheNames = names.filter(function(n){ return String(n).indexOf(RESOURCE_CACHE) === 0; });
          cacheNamesAt = now;
          return cacheNames;
        });
      ready.then(function(names){
        names.forEach(function(n){ caches.open(n).then(fn).then(null, function(){}); });
      }, function(){});
    } catch (e) { /* no Cache Storage here, so nothing was kept either */ }
  };
  var forget = function(url){
    if (!url) return;
    withCaches(function(cache){ return cache['delete'](url); });
  };
  /* What single deletes miss: an answer that arrived after its request was given up on, and whatever a panel held when it
     closed. Everything this script fetched with a query goes, apart from what this page still uses; another panel losing
     its entry only costs it a fresh fetch the next time it asks. */
  var OURS = '/webview/claude-code-extras.';
  var SWEEP_MS = 600000;
  var sweepCaches = function(){
    var keep = {};
    if (sheet && sheet.href) keep[sheet.href] = true;
    if (loading && loading.href) keep[loading.href] = true;
    if (inFlight && inFlight.src) keep[inFlight.src] = true;
    if (typeof effortLink !== 'undefined' && effortLink && effortLink.href) keep[effortLink.href] = true;
    if (typeof effortLoading !== 'undefined' && effortLoading && effortLoading.href) keep[effortLoading.href] = true;
    withCaches(function(cache){
      return cache.keys().then(function(requests){
        requests.forEach(function(r){
          var u = String(r && r.url || '');
          if (u.indexOf(OURS) >= 0 && u.indexOf('?') >= 0 && !keep[u]) cache['delete'](r).then(null, function(){});
        });
      });
    });
  };
  /* The one still loading when another revision arrives, dropped rather than left in the head for the same reason the
     poll drops its own request: a fetch the service worker never answers would otherwise sit there holding one of its
     host-resource permits, and every further revision would add one more. Dropping it rather than skipping the new one
     keeps a stalled load from holding back an update. */
  var loading = null;
  var reloadCss = function(){
    if (!base) { useFallback(); return; }
    if (loading) {
      loading.onload = loading.onerror = null;
      if (loading.parentNode) loading.parentNode.removeChild(loading);
      loading = null;
    }
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.media = 'print';
    l.href = cssUrl();
    l.onload = function(){
      if (loading === l) loading = null;
      l.media = 'all';
      if (sheet && sheet !== l) {
        if (sheet.href !== l.href) forget(sheet.href);
        if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      }
      sheet = l; loadedOnce = true; onCache = null; offCache = {}; pinsCache = null; propCache = {};
      if (fallback && fallback.parentNode) { fallback.parentNode.removeChild(fallback); fallback = null; }
      try { repaintPins(); } catch (e) { /* the next render of the list draws them anyway */ }
      try { paintColors(); } catch (e) { /* the next stylesheet draws them */ }
      try { paintTwice(); } catch (e) { /* the next stylesheet draws them */ }
      schedule();
    };
    l.onerror = function(){
      if (loading === l) loading = null;
      if (l.parentNode) l.parentNode.removeChild(l);
      useFallback(); onCache = null; offCache = {}; pinsCache = null; propCache = {}; schedule();
    };
    loading = l;
    head.appendChild(l);
  };
  /*
   * One request at a time, and the one before it is dropped rather than left hanging.
   *
   * A webview resource is fetched through the editor's service worker, and a fetch that never answers leaves this
   * request in flight for as long as the panel lives. Starting another one every POLL_MS regardless then turns one
   * stalled fetch into a growing pile: measured on a stalled panel, 25 of these were outstanding at once after 99
   * seconds, none of them finished, and the panel had no way back. Worse, the desktop service worker holds one of its 32
   * host-resource permits for each body that is neither read to the end nor cancelled, so a pile of these can exhaust
   * that budget for every webview of this extension in every window - this poll taking the editor's own panels down with
   * it.
   *
   * Clearing `src` is what cancels a request that Chromium has not answered, which both returns the permit and lets the
   * next poll start clean. The handlers are detached first, because clearing `src` fires `error` on some builds and the
   * poll must not act on the answer to a request it has given up on.
   */
  var inFlight = null, sentAt = 0;
  /* The address of the request before this one, taken out of the cache when the next is sent: by then the worker has long
     finished storing it, which a delete right after the answer could not be sure of. */
  var lastProbeUrl = '';
  var drop = function(){
    if (!inFlight) return;
    inFlight.onload = inFlight.onerror = null;
    try { inFlight.src = ''; } catch (e) { /* nothing more to do than let it go */ }
    inFlight = null;
  };
  /*
   * How often to ask, which is not the same as how often this is called.
   *
   * Nobody is reading a panel in a window that is not on screen, so there is nothing for a new revision to be in time
   * for: ten minutes of a backgrounded window cost 200 requests at the quick rate and 20 at the slow one. Several editor
   * windows at once is the ordinary case here, and all but one of them are in the background.
   *
   * `document.hidden` in a webview follows the editor window, not the tab the panel sits in - an iframe that is not
   * displayed still reports itself visible. So this slows down for a window nobody is looking at, and leaves a panel
   * behind another tab of a window in use at the quick rate, which is the right way round: that panel is one click from
   * being read.
   *
   * Focus is deliberately not part of it. A visible panel loses focus the moment someone types in the editor beside it,
   * and a settings change taking half a minute to show up there would be a plain regression.
   */
  var SLOW_POLL_MS = 30000;
  var windowHidden = function(){
    try { return document.hidden === true; } catch (e) { return false; }
  };
  /* Coming back to the window asks at once rather than at the end of a slow interval. */
  try {
    document.addEventListener('visibilitychange', function(){
      if (windowHidden()) return;
      sentAt = 0;
      try { probe(); } catch (e) { /* the interval will come round anyway */ }
    });
  } catch (e) { /* no visibility events: the interval alone then */ }
  var probe = function(){
    if (!base) return;
    var now = Date.now();
    /* A quarter second of slack, because a timer that fires a hair early would otherwise skip the turn and halve the
       rate. */
    if (sentAt && now - sentAt < (windowHidden() ? SLOW_POLL_MS : POLL_MS) - 250) return;
    // Give the one in flight a few polls to answer; past that it is not going to, and holding the slot costs more.
    if (inFlight && now - sentAt < POLL_MS * 3) return;
    drop();
    var img = new Image();
    inFlight = img;
    sentAt = Date.now();
    var done = function(){ if (inFlight === img) inFlight = null; };
    img.onload = function(){
      done();
      var w = img.naturalWidth;
      if (w !== lastRev) { var first = lastRev === -1; lastRev = w; if (!first) reloadCss(); }
      // The height is the efforts' own revision (76-effort.js), carried by the same request.
      try { effortProbe(img.naturalHeight); } catch (e) {}
    };
    img.onerror = done;
    forget(lastProbeUrl);
    lastProbeUrl = base + LIVE_REV + '?t=' + sentAt;
    img.src = lastProbeUrl;
  };
  /*
   * Held between stylesheet loads. getComputedStyle is a synchronous read that forces style resolution, and while a
   * stylesheet is still in flight the browser blocks on it - so asking four times a second turned a setting nobody
   * changes into repeated stalls during startup. The answer can only change when the stylesheet is replaced, and both
   * paths that replace it clear this.
   */
  var onCache = null;
  var isOn = function(){
    if (onCache !== null) return onCache;
    try {
      var v = String(getComputedStyle(document.documentElement).getPropertyValue('--cce-on') || '').trim();
      onCache = v !== '0';
    } catch (e) { onCache = true; }
    return onCache;
  };
  /*
   * Whether one addition has been switched off, from the same stylesheet and with the same caching.
   *
   * A property is written only for the ones turned off, so absent means on: a stylesheet then carries no trace of a
   * setting left at its default, and a build that has never heard of a switch behaves as though it were on rather than
   * off. Every caller is expected to skip the work as well as the drawing - hiding the result with CSS while still
   * computing it every refresh is the one outcome a switch must not have.
   */
  var offCache = {};
  /* The pins the stylesheet carries (83-session-pins.js), decoded once per stylesheet like the two above. */
  var pinsCache = null;
  var isOff = function(key){
    if (Object.prototype.hasOwnProperty.call(offCache, key)) return offCache[key];
    var v = false;
    try {
      v = String(getComputedStyle(document.documentElement)
        .getPropertyValue('--cce-off-' + key) || '').trim() === '1';
    } catch (e) { v = false; }
    offCache[key] = v;
    return v;
  };

  // ── marks ──
