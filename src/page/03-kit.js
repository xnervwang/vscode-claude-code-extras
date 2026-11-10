// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/page/kit.js; sync-shared.js copies it, so edit it there.

/*
 * Helpers shared by the Claude Code Plus and Codex Plus page scripts, exported as a single object, agentPlusKit, so
 * that its names cannot collide with names already in either page. Claude Code Plus adds this file to its page script
 * as a fragment; Codex Plus puts it in front of its page script, and each patch's marker is a digest of the combined
 * script. Under Node it is also a module, for the session list Codex Plus draws in the extension host. The source is
 * ASCII and ES5, like the page scripts.
 */
var agentPlusKit = (function () {
  'use strict';
  var ARROW = String.fromCharCode(8594);
  var p2 = function (n) { return (n < 10 ? '0' : '') + n; };

  /* HH:MM:SS, or HH:MM without seconds. A day other than today goes in front as MM/DD, with the year when it is not
     this one: month before day everywhere, so 01/10 never reads as two different days. */
  function stamp(ms, secs) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var d = new Date(ms), now = new Date();
    var t = p2(d.getHours()) + ':' + p2(d.getMinutes()) + (secs === false ? '' : ':' + p2(d.getSeconds()));
    if (d.toDateString() === now.toDateString()) return t;
    var md = p2(d.getMonth() + 1) + '/' + p2(d.getDate());
    return (d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '/' + md) + ' ' + t;
  }

  /* How long ago, as Claude Code's own session list writes it: now, then whole minutes, hours, days, months of 30 days
     and years. */
  function age(ms, now) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var s = Math.max(0, Math.floor(((now == null ? Date.now() : now) - ms) / 1000));
    var m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24), mo = Math.floor(d / 30), y = Math.floor(d / 365);
    return y > 0 ? y + 'y' : mo > 0 ? mo + 'mo' : d > 0 ? d + 'd' : h > 0 ? h + 'h' : m > 0 ? m + 'm' : 'now';
  }

  /* The days a conversation spans, from its first message to its last, or one day when both are the same: 11/05->11/09.
     A year other than the current one is written once, in front, for a span within that year. */
  function span(firstMs, lastMs, now) {
    if (typeof lastMs !== 'number' || !isFinite(lastMs) || !lastMs) return '';
    var year = new Date(now == null ? Date.now() : now).getFullYear();
    var ymd = function (ms) { var t = new Date(ms); return { y: t.getFullYear(), md: p2(t.getMonth() + 1) + '/' + p2(t.getDate()) }; };
    var one = function (v) { return v.y === year ? v.md : v.y + '/' + v.md; };
    var e = ymd(lastMs), s = typeof firstMs === 'number' && isFinite(firstMs) && firstMs ? ymd(firstMs) : null;
    if (!s || (s.y === e.y && s.md === e.md)) return one(e);
    return s.y === e.y && s.y !== year ? s.y + '/' + s.md + ARROW + e.md : one(s) + ARROW + one(e);
  }

  function kfmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '-';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function pct(n, of) {
    if (!(of > 0)) return '';
    var v = 100 * n / of;
    return v < 0.1 && v > 0 ? '<0.1%' : v.toFixed(1) + '%';
  }

  /* Each chime has its own pattern: rising for a finished turn, three equal notes when the agent waits for a
     permission, falling for a question. Each step is [Hz, start in s, length in s]. */
  var TONES = {
    done: [[880, 0, 0.09], [1174, 0.09, 0.16]],
    permission: [[880, 0, 0.07], [880, 0.13, 0.07], [880, 0.26, 0.11]],
    question: [[1174, 0, 0.09], [880, 0.10, 0.16]],
  };
  TONES.approval = TONES.permission;
  var GAIN = 0.05, RESUME_WAIT_MS = 300;
  var audio = null;
  function audioCtx() {
    var Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    if (!audio || audio.state === 'closed') { try { audio = new Ctor(); } catch (e) { audio = null; } }
    return audio;
  }
  /* A context made before anyone has clicked or typed in the page starts suspended under the browser's autoplay rule.
     The page calls this from its first click or key. */
  function unlockAudio() {
    var ac = audioCtx();
    if (ac && ac.state === 'suspended' && typeof ac.resume === 'function') { try { ac.resume(); } catch (e) { /* refused */ } }
  }
  /* Plays `kind` and calls tell(kind, state) with the context's state, 'unavailable' when there is none. A suspended
     context is resumed first; a refused resume() never settles, so the chime is dropped after RESUME_WAIT_MS rather
     than sounding at some later click. */
  function chime(kind, tell) {
    var say = typeof tell === 'function' ? tell : function () {};
    var ac = audioCtx();
    if (!ac) { say(kind, 'unavailable'); return; }
    var play = function () {
      try {
        var steps = TONES[kind] || TONES.done, t0 = ac.currentTime + 0.01;
        for (var i = 0; i < steps.length; i++) {
          var at = t0 + steps[i][1], dur = steps[i][2];
          var o = ac.createOscillator(), g = ac.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(steps[i][0], at);
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(GAIN, at + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
          o.connect(g); g.connect(ac.destination);
          o.start(at); o.stop(at + dur + 0.02);
        }
      } catch (e) { /* no audio here */ }
      say(kind, ac.state);
    };
    if (ac.state !== 'suspended' || typeof ac.resume !== 'function') { play(); return; }
    var settled = false;
    var go = function () {
      if (settled) return;
      settled = true;
      if (ac.state === 'running') play(); else say(kind, ac.state);
    };
    try { Promise.resolve(ac.resume()).then(go, go); } catch (e) { go(); }
    setTimeout(go, RESUME_WAIT_MS);
  }

  /*
   * A hover label drawn by the page, since neither panel shows a native title. `opts.mark` is [attribute, value] put on
   * the box, `opts.css` its look. The box is placed after it is in the document, because its height depends on how the
   * text wrapped: centred over the control and kept 8px inside the window, above it when there is room and below
   * otherwise. It is removed on leave and on click, since a label left over a control after it is clicked looks stuck.
   */
  function labels(opts) {
    var box = null;
    var rect = function (el) { try { return el.getBoundingClientRect(); } catch (e) { return null; } };
    function hide() { if (box) { try { box.parentNode && box.parentNode.removeChild(box); } catch (e) { /* gone */ } box = null; } }
    function show(el, text) {
      var said = typeof text === 'string' && text ? text : el && el.getAttribute && el.getAttribute('aria-label');
      if (!said || !document.body) return;
      hide();
      var b = document.createElement('div');
      if (opts.mark) b.setAttribute(opts.mark[0], opts.mark[1]);
      b.style.cssText = 'position:fixed;pointer-events:none;max-width:260px;line-height:1.35;white-space:pre-line;overflow-wrap:anywhere;'
        + (opts.css || '');
      b.textContent = said;
      document.body.appendChild(b);
      var r = rect(el), s = rect(b);
      if (r && s) {
        var vw = +globalThis.innerWidth || 0, w = s.width || 0, h = s.height || 0;
        var top = r.top || 0, bottom = r.bottom != null ? r.bottom : top + (r.height || 0);
        var left = (r.left || 0) + (r.width || 0) / 2 - w / 2;
        b.style.left = Math.round(Math.max(8, vw ? Math.min(vw - w - 8, left) : left)) + 'px';
        b.style.top = Math.round(top - h - 8 >= 8 ? top - h - 8 : bottom + 8) + 'px';
      }
      box = b;
    }
    /* Gives `el` its label text and, once, the listeners; `wired` is the attribute that says it has them. */
    function wire(el, text, wired) {
      if (!el) return;
      if (el.getAttribute('aria-label') !== text) el.setAttribute('aria-label', text);
      if (el.getAttribute(wired) !== null) return;
      el.setAttribute(wired, '1');
      el.addEventListener('mouseenter', function () { show(el); });
      el.addEventListener('mouseleave', hide);
      el.addEventListener('click', hide);
    }
    return { show: show, hide: hide, wire: wire, current: function () { return box; } };
  }

  return { p2: p2, stamp: stamp, age: age, span: span, kfmt: kfmt, pct: pct, TONES: TONES, chime: chime, unlockAudio: unlockAudio,
    labels: labels };
})();
if (typeof module === 'object' && module) module['exports'] = agentPlusKit;
