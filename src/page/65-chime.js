// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// The three chimes and the mute button.
// Fragment of the in-page script - see README.md in this folder.

  // A short synthesised chime when a turn finishes, so a long run does not need watching.
  // The mute button in the prompt panel toggles it; the choice survives reloads.
  // Three things are worth hearing, and they are told apart by shape rather than by volume, so the ear can name them
  // without looking: a turn finished, Claude is waiting for permission, Claude has asked something. Waiting is the one
  // that matters most - it has stopped and will not move again until you act.
  //
  // Synthesised, so the extension ships no audio files; and played in the page, which renders on your own machine, so it
  // is heard there even when the editor is attached to a remote host. agentPlusKit holds the tones and plays them, so
  // Codex Plus sounds the same for the same event. A context made before anyone has clicked or typed in the panel starts
  // suspended under the browser's autoplay rule, and the first click or key in the panel resumes it.
  try {
    document.addEventListener('pointerdown', agentPlusKit.unlockAudio, true);
    document.addEventListener('keydown', agentPlusKit.unlockAudio, true);
  } catch (e) {}
  // Claude Code logs the type and request id of every message a panel sends (src/panel-load-watch.js reports the same
  // way), so a chime leaves a line there with the context's state. Only a page's first chime and those that could not
  // play are sent.
  var toldChime = false;
  var tellChime = function(kind, state){
    if (toldChime && state === 'running') return;
    toldChime = true;
    try { acquireVsCodeApi().postMessage({ type: 'cce_chime', requestId: 'chime ' + kind + ' ' + state }); } catch (e) {}
  };
  // A suspended context is resumed first; a refused resume() never settles, so the chime is dropped after 300 ms rather
  // than sounding at the next click.
  var beep = function(kind){
    try { agentPlusKit.chime(kind, tellChime); } catch (e) {}
  };
  // Signals are read defensively: a build that renames or drops one of them should cost a chime, not the sweep.
  var sigLen = function(name){
    var s = sessionRef && sessionRef[name], v = s && s.value;
    return (v && typeof v.length === 'number') ? v.length : 0;
  };
  var sigOn = function(name){
    var s = sessionRef && sessionRef[name];
    return !!(s && s.value === true);
  };
  var wasBusy = false, hadPerm = 0, hadDialog = 0, wasWaiting = false;
  /* No chime here: a conversation switch is not a finished turn or a request for input. */
  var primeIdle = function(){
    hadPerm = sigLen('permissionRequests'); hadDialog = sigLen('userDialogRequests');
    wasWaiting = sigOn('pendingInput'); wasBusy = sigOn('busy');
  };
  // Whether the chimes sound at all, kept in the page's own storage so the choice outlives a reload. Absent means on,
  // so a first-time panel chimes without anything having been written. Both directions swallow their errors: storage
  // can be denied, and a denied read must not take the mute button's paint down with it.
  var CHIME_KEY = 'cce.chime';
  var chimeOn = function(){
    try { return window.localStorage.getItem(CHIME_KEY) !== '0'; } catch (e) { return true; }
  };
  var setChime = function(on){
    try { window.localStorage.setItem(CHIME_KEY, on ? '1' : '0'); } catch (e) {}
  };
  // The chime toggle belongs to the whole session, so it lives in the footer toolbar, immediately
  // left of the permission-mode selector. The send button is the stable anchor: the selector is its
  // previous sibling. React may replace the row, so this is re-checked on the timer below.
  var paintMute = function(){
    if (!MUTE) return;
    var on = chimeOn();
    setStyle(MUTE, 'opacity', on ? '1' : '0.4');
    setStyle(MUTE, 'textDecoration', on ? 'none' : 'line-through');
    setLabel(MUTE, on ? 'A chime when a turn finishes, and when Claude is waiting for you - click to mute'
                      : 'Chimes are muted - click to hear a chime when a turn finishes');
  };
  var ensureMute = function(){
    if (isOff('footerMute')) { MUTE = dropControl(MUTE); return; }
    if (MUTE && MUTE.isConnected) { paintMute(); return; }
    var send = document.querySelector(SEND);
    if (!send) return;
    var mode = send.previousElementSibling;
    if (!mode || !mode.parentElement) return;
    MUTE = document.createElement('button');
    MUTE.type = 'button';
    MUTE.setAttribute('data-cce-mute', '1');
    MUTE.textContent = String.fromCharCode(9834);
    var proto = document.querySelector('button[class*="menuButton"]');
    if (proto) MUTE.className = proto.className;
    else {
      MUTE.style.background = 'transparent';
      MUTE.style.border = 'none';
      MUTE.style.color = 'var(--vscode-foreground, #ccc)';
      MUTE.style.cursor = 'pointer';
    }
    MUTE.addEventListener('click', function(ev){
      ev.preventDefault(); ev.stopPropagation();
      setChime(!chimeOn());
      paintMute();
      // Turning the chimes on plays one.
      if (chimeOn()) beep('done');
    });
    mode.parentElement.insertBefore(MUTE, mode);
    paintMute();
  };
  var watchIdle = function(){
    if (isOff('chime')) return;
    if (!sessionRef) return;
    var on = chimeOn();
    var nPerm = sigLen('permissionRequests'), nDialog = sigLen('userDialogRequests'), waiting = sigOn('pendingInput');
    // A rising count is the arrival of something new; pendingInput is the fallback for a build that reports only that.
    if (on && nPerm > hadPerm) beep('permission');
    else if (on && nDialog > hadDialog) beep('question');
    else if (on && waiting && !wasWaiting) beep('question');
    hadPerm = nPerm; hadDialog = nDialog; wasWaiting = waiting;
    var b = sigOn('busy');
    if (on && wasBusy && !b) beep('done');
    wasBusy = b;
  };
