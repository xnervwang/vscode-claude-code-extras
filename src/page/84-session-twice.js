// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// A mark on a conversation's rows in the session list while more than one Claude Code process runs it.
// Fragment of the in-page script - see README.md in this folder.

  // The host puts them in the live stylesheet as [[session ID, number of processes], ...] (src/duplicates.js). The mark
  // is a rule after the title, like a text color (84-session-colors.js), so no node of ours goes into the list's rows.
  var TWICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var twiceStyle = null;
  var paintTwice = function(){
    var d = readProp('--cce-dups'), css = '';
    for (var i = 0; i < (Array.isArray(d) ? d.length : 0); i++) {
      var p = d[i];
      if (!p || typeof p[0] !== 'string' || !TWICE_ID.test(p[0]) || !(p[1] > 1)) continue;
      css += '[class*="sessionItem_"][id$="' + p[0] + '"] span[class*="sessionName_"]::after{content:" \u00b7 ' + Math.floor(p[1])
        + ' processes";color:var(--vscode-errorForeground,#f14c4c);font-weight:normal}';
    }
    if (!css && !twiceStyle) return;
    if (!twiceStyle) {
      twiceStyle = document.createElement('style');
      twiceStyle.setAttribute('data-cce-twice', '1');
      head.appendChild(twiceStyle);
    }
    if (twiceStyle.textContent !== css) twiceStyle.textContent = css;
  };
