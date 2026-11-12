// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// The session id, the Claude process id, the directory the conversation started in, where its transcripts are kept,
// their size, and the token mode.
// Fragment of the in-page script - see README.md in this folder.

  var INFO = null, INFOBOX = null, infoWired = false;
  /*
   * Process ids by session id, from `claude agents` (pidsOf in src/waiting.js). Claude Code does not give the page
   * these, so the box asks this extension for them each time it opens. With an older host patch nothing answers, and
   * the row says unknown.
   */
  var PROCS = {}, procsWired = false;
  /* Per session id: the work plan's figures, the token mode, and when they arrived. This extension sends them each time
     the box or the context meter's hover (src/page/55-context-detail.js) asks for the process id. */
  var PLANS = {};
  var PROC_WAIT_MS = 20000;

  var bytesFmt = function(n){
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? String(Math.round(n)) : n.toFixed(n < 10 ? 1 : 0)) + ' ' + units[i];
  };

  var sigValue = function(name){
    var s = sessionRef && sessionRef[name];
    return s ? s.value : undefined;
  };

  /*
   * Session, Project and On disk are values the panel is handed. Transcripts is derived. It is labelled with the word
   * this project uses for those files everywhere else - the README, the size row's own description, the checks - so
   * that the panel and the documentation can be read against each other without translating between two vocabularies.
   *
   * The host keeps every conversation started in one directory together, under a name made by replacing each character
   * of that directory that is not a letter or a digit with a hyphen. Worth showing because the substitution cannot be
   * run in the head and cannot be read back: a dot collapses the same way a slash does, and anything outside ASCII
   * collapses too, so a path with non-Latin names arrives as a row of hyphens with nothing left to recover it from. The
   * tilde is left unexpanded, since the panel is not told the home directory and a shell will take it as it stands.
   *
   * Project is the directory the conversation was started in, which is fixed for its whole life. It is not the working
   * directory of the moment - commands move that around, and the transcript records wherever each one ran.
   */
  var bucketName = function(cwd){ return String(cwd).replace(/[^a-zA-Z0-9]/g, '-'); };

  var procText = function(sid){
    var p = sid && PROCS[sid];
    if (!p) return '';
    if (p.pids === undefined) return Date.now() - p.at > PROC_WAIT_MS ? 'unknown' : 'looking it up';
    if (p.pids === null) return 'unknown';
    return p.pids.length ? p.pids.join(', ') : 'none running';
  };

  var infoRows = function(){
    var sid = sigValue('sessionId');
    var rows = [['Session', sid || 'no session id yet']];
    var proc = procText(sid);
    if (proc) rows.push(['Process', proc]);
    var cwd = sigValue('cwd');
    if (cwd) {
      rows.push(['Project', String(cwd)]);
      rows.push(['Transcripts', '~/.claude/projects/' + bucketName(cwd)]);
    }
    var size = sigValue('fileSize');
    if (typeof size === 'number') rows.push(['On disk', bytesFmt(size)]);
    var plan = sid && PLANS[sid];
    if (plan && plan.mode) rows.push(['Token mode', plan.mode]);
    return rows;
  };

  // Clicking a value copies it: the session id is what one needs to resume this conversation elsewhere, and it is not
  // something to retype. Selecting the text is the fallback where the clipboard is not available to scripts.
  var copyValue = function(el, text){
    var done = function(){
      var was = el.textContent;
      el.textContent = 'copied';
      el.style.opacity = '0.6';
      setTimeout(function(){
        if (!el.isConnected) return;
        el.textContent = was;
        el.style.opacity = '';
      }, 900);
    };
    var select = function(){
      try {
        var r = document.createRange();
        r.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      } catch (e) {}
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, select);
      else select();
    } catch (e) { select(); }
  };

  var infoOpen = function(){ return !!(INFOBOX && INFOBOX.style.display === 'block'); };

  var wireReplies = function(){
    if (procsWired) return;
    procsWired = true;
    window.addEventListener('message', function(ev){
      var d = ev && ev.data, m = d && d.type === 'from-extension' ? d.message : null;
      if (m && m.type === 'cce_plan' && typeof m.sessionId === 'string') {
        var f = m.plan && typeof m.plan === 'object' && typeof m.plan.tokens === 'number' ? m.plan : null;
        PLANS[m.sessionId] = { plan: f, text: typeof m.text === 'string' ? m.text : '', mode: typeof m.mode === 'string' ? m.mode : '',
          at: Date.now() };
        if (infoOpen() && sigValue('sessionId') === m.sessionId) renderInfo();
        try { planArrived(m.sessionId); } catch (e) {}
        return;
      }
      if (!m || m.type !== 'cce_process' || typeof m.sessionId !== 'string' || !PROCS[m.sessionId]) return;
      var pids = Array.isArray(m.pids) ? m.pids.filter(function(n){ return typeof n === 'number'; }) : null;
      PROCS[m.sessionId] = { at: Date.now(), pids: pids };
      if (infoOpen() && sigValue('sessionId') === m.sessionId) renderInfo();
    });
  };
  /* The context meter's hover sends the same request to get the work plan's figures, and ignores the process id. */
  var askPlan = function(sid){
    wireReplies();
    try { acquireVsCodeApi().postMessage({ type: 'cce_process_ask', sessionId: sid }); } catch (e) {}
  };

  var askProcess = function(){
    var sid = sigValue('sessionId');
    if (typeof sid !== 'string' || !sid) return;
    PROCS[sid] = { at: Date.now() };
    wireReplies();
    try { acquireVsCodeApi().postMessage({ type: 'cce_process_ask', sessionId: sid }); }
    catch (e) { PROCS[sid].pids = null; return; }
    setTimeout(function(){
      var p = PROCS[sid];
      if (p && p.pids === undefined && infoOpen() && sigValue('sessionId') === sid) renderInfo();
    }, PROC_WAIT_MS + 100);
  };
  var closeInfo = function(){ if (INFOBOX) INFOBOX.style.display = 'none'; };

  var renderInfo = function(){
    INFOBOX.textContent = '';
    var rows = infoRows();
    for (var i = 0; i < rows.length; i++) {
      var line = document.createElement('div');
      line.style.display = 'flex'; line.style.alignItems = 'baseline';
      line.style.gap = '10px'; line.style.padding = '2px 0';
      var k = document.createElement('span');
      k.textContent = rows[i][0];
      k.style.flex = '0 0 72px';
      k.style.opacity = '0.6';
      var v = document.createElement('span');
      v.textContent = rows[i][1];
      v.style.flex = '1 1 auto'; v.style.minWidth = '0';
      v.style.wordBreak = 'break-all';
      v.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
      v.style.cursor = 'pointer';
      v.title = 'Click to copy';
      (function(el, text){
        el.addEventListener('click', function(ev){ ev.stopPropagation(); copyValue(el, text); });
      })(v, rows[i][1]);
      line.appendChild(k); line.appendChild(v);
      INFOBOX.appendChild(line);
    }
  };

  var ensureInfoBox = function(){
    if (INFOBOX && INFOBOX.isConnected) return;
    INFOBOX = document.createElement('div');
    INFOBOX.id = 'cce-info';
    var s = INFOBOX.style;
    s.position = 'fixed'; s.zIndex = '33'; s.display = 'none';
    s.width = '400px'; s.maxWidth = 'calc(100vw - 32px)';
    s.padding = '8px 10px'; s.borderRadius = '5px';
    s.fontSize = '11px'; s.lineHeight = '1.5';
    s.background = 'var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.99))';
    s.color = 'var(--vscode-editorHoverWidget-foreground, #ddd)';
    s.border = '1px solid var(--vscode-editorHoverWidget-border, rgba(255,255,255,0.18))';
    s.boxShadow = '0 4px 14px rgba(0,0,0,0.5)';
    document.body.appendChild(INFOBOX);
    if (!infoWired) {
      infoWired = true;
      // An outside click dismisses it; clicks on the box itself are for copying, so they must not close it.
      document.addEventListener('click', function(ev){
        if (!infoOpen()) return;
        if ((INFOBOX && INFOBOX.contains(ev.target)) || (INFO && INFO.contains(ev.target))) return;
        closeInfo();
      });
    }
  };

  var ensureInfo = function(){
    if (isOff('footerInfo')) { INFO = dropControl(INFO); closeInfo(); return; }
    if (INFO && INFO.isConnected) return;
    var send = document.querySelector(SEND);
    if (!send) return;
    var mode = send.previousElementSibling;
    if (!mode || !mode.parentElement) return;
    INFO = document.createElement('button');
    INFO.type = 'button';
    INFO.setAttribute('data-cce-info', '1');
    INFO.textContent = String.fromCharCode(8505);   // information source
    setLabel(INFO, 'About this conversation: its session id, process id, the directory it started in, where its '
      + 'transcripts are kept, their size, and the token mode');
    var proto = document.querySelector('button[class*="menuButton"]');
    if (proto) INFO.className = proto.className;
    else {
      INFO.style.background = 'transparent';
      INFO.style.border = 'none';
      INFO.style.color = 'var(--vscode-foreground, #ccc)';
      INFO.style.cursor = 'pointer';
    }
    INFO.addEventListener('click', function(ev){
      ev.preventDefault(); ev.stopPropagation();
      if (infoOpen()) { closeInfo(); return; }
      ensureInfoBox();
      askProcess();
      renderInfo();
      var r = INFO.getBoundingClientRect();
      INFOBOX.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + 'px';
      INFOBOX.style.display = 'block';
      INFOBOX.style.left = Math.max(8, Math.min(r.left, window.innerWidth - INFOBOX.offsetWidth - 8)) + 'px';
    });
    // Leftmost of the controls this extension adds, so it sits as far as possible from the send button.
    var before = (VIEWBTN && VIEWBTN.isConnected && VIEWBTN.parentElement === mode.parentElement) ? VIEWBTN
               : (MUTE && MUTE.isConnected && MUTE.parentElement === mode.parentElement) ? MUTE : mode;
    mode.parentElement.insertBefore(INFO, before);
  };
