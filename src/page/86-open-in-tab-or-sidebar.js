// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Choosing where a conversation opens, from the session list: two buttons in place of New session, one for a new tab and
// one for the sidebar, and the same two choices in place of Resume session for a conversation that is not open.
// Fragment of the in-page script - see README.md in this folder.

  // Each does what New session or Resume session does - the list clears its selection, keeps its place and sends its own
  // open request - with where to open it added to that request (an edit in src/webview.js), and the patched host opens
  // it there in place of claudeCode.preferredLocation, which is not changed. The tab bar's Claude button is left alone
  // and keeps following that setting. A conversation that is open is shown where it is: the menu offers only Claude
  // Code's own Switch to session for it.
  var OPEN_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // The request is sent while the action runs, so where is set only for that call.
  var openIn = function(where, action){
    window.__cceOpenWhere = where;
    try { action(); } catch (e) { /* the list's own action failed; nothing more to do */ }
    finally { window.__cceOpenWhere = void 0; }
  };

  // The panel draws these with its own factories and classes, in place of its New session button; null leaves that
  // button as it is.
  window.__cceNewSessionButtons = function(ui){
    try {
      if (isOff('openInTabOrSidebar') || !ui || typeof ui.jsx !== 'function' || typeof ui.jsxs !== 'function'
          || !ui.ctx || typeof ui.ctx.openInEditor !== 'function') return null;
      var F = ui.jsx, W = ui.jsxs, c = ui.cls || {}, ctx = ui.ctx;
      // Two halves of the row the one button filled, parted by the row's own border colour. In a narrow list a label does
      // not fit its half, and the button's flex layout would shrink the icon instead; the icon keeps its size and the
      // label is cut with an ellipsis.
      var button = function(where, label, title, parted){
        var style = { flex: '1 1 0', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' };
        if (parted) style.borderLeft = '1px solid var(--app-primary-border-color)';
        return W('button', {
          className: c.newSessionButton || '', style: style, title: title,
          'data-cce-new-session': where,
          onClick: function(){ openIn(where, function(){ ctx.openInEditor(); }); },
          children: [
            ui.Icon ? F('span', { style: { display: 'inline-flex', flex: '0 0 auto' }, children: F(ui.Icon, { className: c.newSessionIcon || '' }) }) : null,
            F('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }, children: label }),
          ],
        }, where);
      };
      return W('div', { style: { display: 'flex', alignSelf: 'stretch', flex: '1 1 auto', minWidth: 0 }, children: [
        button('tab', 'New in tab', 'Start a conversation in a new editor tab', false),
        button('sidebar', 'New in sidebar', 'Start a conversation in the sidebar', true),
      ] });
    } catch (e) { return null; }
  };

  // The menu items for one conversation that is not open, in place of Resume session, each running the list's own
  // resume; null keeps Resume session. A remote conversation keeps it, since only a local one can be opened in the
  // sidebar this way.
  window.__cceResumeItems = function(key, resume){
    try {
      if (isOff('openInTabOrSidebar') || typeof key !== 'string' || !OPEN_SESSION_ID.test(key) || typeof resume !== 'function') return null;
      return [
        { label: 'Resume in tab', onSelect: function(){ openIn('tab', resume); } },
        { label: 'Resume in sidebar', onSelect: function(){ openIn('sidebar', resume); } },
      ];
    } catch (e) { return null; }
  };
