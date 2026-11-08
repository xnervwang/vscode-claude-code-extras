// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Reports to the extension that this panel's page got focus (src/claude-source.js).
// Fragment of the in-page script - see README.md in this folder.

  /*
   * VS Code has no focus event for a webview view, so a sidebar conversation can only report focus from its page; Claude
   * Code's own panel listens to the same window focus event. Also posted at startup and on a conversation switch if the
   * page already has focus.
   */
  var sayFocus = function(){
    var sid = sigValue('sessionId');
    if (typeof sid !== 'string' || !sid) return;
    try { acquireVsCodeApi().postMessage({ type: 'cce_page_focus', sessionId: sid }); }
    catch (e) { /* focus then comes from the tab and the host's activeSessionId */ }
  };
  var sayFocusIfFocused = function(){
    try { if (document.hasFocus()) sayFocus(); } catch (e) {}
  };
  var listenForFocus = function(){
    window.addEventListener('focus', function(){ try { sayFocus(); } catch (e) {} });
    sayFocusIfFocused();
  };
