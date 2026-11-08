// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// An answer from the Conversations tab (src/answers.js), sent from this panel as if typed here: the text goes into
// the message input and Enter sends it, so it reaches the conversation as the user's own message and is queued like
// one when a turn is running. The host only hands it to the panel showing that conversation.
// Fragment of the in-page script - see README.md in this folder.

  var ANSWER_INPUT = '[role="textbox"][aria-label="Message input"]';
  var answerResult = function(id, sent, reason){
    /* The handle the panel's own bundle asked for, which src/panel-tz.js hands out again rather than asking twice. */
    try { acquireVsCodeApi().postMessage({ type: 'cce_answer_result', id: id, sent: sent, reason: reason || '' }); }
    catch (e) { /* the sender reports it as not sent when its wait runs out */ }
  };
  var inputText = function(box){ return String(box.textContent || '').replace(/\u200b/g, '').trim(); };
  /* Line breaks typed into the input can become elements rather than characters, so text is compared without spaces. */
  var squash = function(s){ return String(s || '').replace(/[\s\u200b]+/g, ''); };
  /* The input was empty before the answer went in, so clearing it removes only the answer. */
  var emptyInput = function(box){
    try {
      var range = document.createRange();
      range.selectNodeContents(box);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false);
    } catch (e) { /* left as it is */ }
    if (inputText(box)) box.textContent = '';
  };
  /* The sidebar may have switched conversations since the host checked which one it shows. */
  var showsOther = function(m){
    var now = sigValue('sessionId');
    return typeof now === 'string' && !!now && typeof m.sessionId === 'string' && !!m.sessionId && now !== m.sessionId;
  };
  var sendAnswer = function(m){
    if (showsOther(m)) { answerResult(m.id, false, 'not-shown'); return; }
    var box = document.querySelector(ANSWER_INPUT);
    if (!box) { answerResult(m.id, false, 'no-input'); return; }
    /* Text already in the input would be sent along with the answer. */
    if (inputText(box)) { answerResult(m.id, false, 'draft'); return; }
    try {
      box.focus();
      var range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      /* insertText goes through the browser's own editing, so the input's handlers see it as typing. */
      document.execCommand('insertText', false, m.text);
    } catch (e) { /* checked below */ }
    if (squash(box.textContent) !== squash(m.text)) {
      emptyInput(box);
      answerResult(m.id, false, 'insert');
      return;
    }
    setTimeout(function(){
      if (showsOther(m)) { emptyInput(box); answerResult(m.id, false, 'not-shown'); return; }
      /* With Ctrl, Enter sends whether or not Claude Code is set to send on Ctrl+Enter; Shift+Enter would be a new line. */
      try {
        box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      } catch (e) { /* checked below */ }
      setTimeout(function(){
        if (!inputText(box)) { answerResult(m.id, true, ''); return; }
        emptyInput(box);
        answerResult(m.id, false, 'left-in-input');
      }, 800);
    }, 60);
  };
  var listenForAnswers = function(){
    window.addEventListener('message', function(ev){
      var d = ev && ev.data, m = d && d.type === 'from-extension' ? d.message : null;
      if (!m || m.type !== 'cce_answer' || typeof m.text !== 'string' || typeof m.id !== 'string') return;
      try { sendAnswer(m); } catch (e) { answerResult(m.id, false, 'error'); }
    });
  };
