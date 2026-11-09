// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Saying so when the selectors stop matching.
// Fragment of the in-page script - see README.md in this folder.

  // Runtime self-check. A successful patch says nothing about whether the selectors still match, so
  // that failure mode would otherwise be silent. If the panel clearly holds transcript messages but
  // neither of our message selectors finds anything, surface a marker instead of quietly doing
  // nothing. Costs no extra query in the normal case: the counts come from the sweep itself.
  var WARN = null, warnStreak = 0;
  var showWarn = function(on){
    if (!on) { if (WARN) WARN.style.display = 'none'; return; }
    if (!WARN || !WARN.isConnected) {
      WARN = document.createElement('div');
      WARN.id = 'cce-warn';
      WARN.textContent = '!';
      setLabel(WARN, 'Claude Code Plus: this Claude Code build no longer matches the message selectors, so the '
        + 'timestamps, agent tags and view filter are inactive. The patch itself applied; '
        + 'the page structure changed.');
      var s = WARN.style;
      s.position = 'fixed'; s.top = '4px'; s.right = '4px'; s.zIndex = '34';
      s.width = '16px'; s.height = '16px'; s.borderRadius = '50%';
      s.display = 'flex'; s.alignItems = 'center'; s.justifyContent = 'center';
      s.fontSize = '11px'; s.fontWeight = '700'; s.cursor = 'help';
      s.background = 'var(--vscode-editorWarning-foreground, #cca700)';
      s.color = 'var(--vscode-editor-background, #1e1e1e)';
      document.body.appendChild(WARN);
    }
    WARN.style.display = 'flex';
  };
  var healthCheck = function(mine){
    if (mine > 0) { warnStreak = 0; showWarn(false); return; }
    // no messages of ours - is that because the panel is empty, or because we stopped matching?
    if (document.querySelectorAll('[data-transcript-message]').length === 0) {
      warnStreak = 0; showWarn(false); return;
    }
    warnStreak++;
    showWarn(warnStreak >= 4);
  };
