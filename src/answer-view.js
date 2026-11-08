// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Answer view, beside the Conversations tree in the same panel tab: the question clicked in the tree, the row it is
 * on, and a box to answer it in, several lines long. Sending hands the answer to src/answers.js, which gets it to the
 * window showing that conversation. What was typed and not sent is kept for each question while the window is open.
 */
const crypto = require('crypto');
const { textFor } = require('./conversations-text');
const { keyPart } = require('./sources');

class AnswerView {
  /** `send(question, text)` sends an answer, `open(target)` goes to a conversation, `age(ms)` says how long ago and
      `clock(ms)` gives the reader's local time. */
  constructor({ send, open, age, clock }) {
    this.send = send;
    this.open = open;
    this.age = age;
    this.clock = clock;
    this.view = null;
    this.lang = 'en';
    this.current = null;
    this.drafts = new Map();
    this.states = new Map();
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((m) => this.receive(m));
    view.onDidDispose(() => { if (this.view === view) this.view = null; });
    this.paint();
  }

  receive(m) {
    if (!m || !this.current || m.key !== this.current.key) return;
    if (m.type === 'draft' && typeof m.text === 'string') {
      this.drafts.set(m.key, m.text);
    } else if (m.type === 'send' && typeof m.text === 'string' && m.text.trim() && this.current.running) {
      this.drafts.set(m.key, m.text);
      this.send(this.current, m.text);
    } else if (m.type === 'open' && this.current.open) {
      this.open(this.current.open);
    }
  }

  /** Shows `q`, a question from the Conversations tree, ready to be answered. */
  show(q) {
    if (!q || !q.sessionId || !q.row) return;
    const key = q.sourceId ? keyPart(q.sourceId) + '/' + keyPart(q.sessionId) + '/' + q.row
      : q.sessionId + '/' + q.row;
    this.current = Object.assign({}, q, { key });
    this.paint(true);
  }

  setLanguage(lang) {
    if (lang === this.lang) return;
    this.lang = lang;
    if (this.view) this.view.webview.html = this.html();
    this.paint();
  }

  /** Shows the outcome of the answer to question `key`, and clears its draft once it was sent. */
  setState(key, state) {
    this.states.set(key, Object.assign({ at: Date.now() }, state));
    if (state.kind === 'sent') {
      this.drafts.delete(key);
      if (this.view && this.current && this.current.key === key) this.view.webview.postMessage({ type: 'clear', key });
    }
    if (this.current && this.current.key === key) this.paint();
  }

  paint(focus) {
    if (!this.view) return;
    const t = textFor(this.lang);
    const q = this.current;
    if (!q) { this.view.webview.postMessage({ type: 'empty', text: t.answerEmpty }); return; }
    const state = this.states.get(q.key);
    const ago = this.age(q.since);
    this.view.webview.postMessage({
      type: 'show',
      key: q.key,
      focus: !!focus,
      conversation: q.conversation || '',
      row: t.answerRow(q.row, q.rowTitle || '', ago),
      question: q.question || '',
      note: q.note || '',
      detail: q.detail || '',
      draft: this.drafts.get(q.key) || '',
      running: !!q.running,
      notRunning: t.answerNotRunning,
      status: state ? t.answerState(state.kind, this.clock(state.at)) : '',
      failed: !!(state && state.kind !== 'sent' && state.kind !== 'waiting'),
    });
  }

  html() {
    const t = textFor(this.lang);
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { height: 100%; margin: 0; }
  body { box-sizing: border-box; padding: 6px 10px; display: flex; flex-direction: column; gap: 6px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  #empty { color: var(--vscode-descriptionForeground); margin-top: 4px; }
  #main { display: none; flex-direction: column; gap: 6px; flex: 1; min-height: 0; }
  #conversation { font-weight: 600; }
  #row { color: var(--vscode-descriptionForeground); }
  #question { white-space: pre-wrap; }
  details { color: var(--vscode-descriptionForeground); }
  details div { white-space: pre-wrap; max-height: 8em; overflow: auto; }
  textarea { flex: 1; min-height: 4em; resize: none; box-sizing: border-box; width: 100%; padding: 4px 6px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #bar { display: flex; align-items: center; gap: 8px; }
  #status { flex: 1; color: var(--vscode-descriptionForeground); }
  #status.failed { color: var(--vscode-errorForeground); }
  button { font-family: inherit; font-size: inherit; padding: 3px 10px; border: none; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
</style></head><body>
<div id="empty">${attr(t.answerEmpty)}</div>
<div id="main">
  <div id="conversation"></div>
  <div id="row"></div>
  <div id="question"></div>
  <details id="more"><summary>${attr(t.answerMore)}</summary><div id="detail"></div></details>
  <textarea id="text" placeholder="${attr(t.answerPlaceholder)}"></textarea>
  <div id="bar"><span id="status"></span>
    <button id="open" class="secondary">${attr(t.answerOpen)}</button>
    <button id="send">${attr(t.answerSend)}</button></div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let key = '', running = false;
  const ready = () => { $('send').disabled = !running || !$('text').value.trim(); };
  const send = () => { if (!$('send').disabled) vscode.postMessage({ type: 'send', key, text: $('text').value }); };
  $('text').addEventListener('input', () => { ready(); vscode.postMessage({ type: 'draft', key, text: $('text').value }); });
  $('text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  $('send').addEventListener('click', send);
  $('open').addEventListener('click', () => vscode.postMessage({ type: 'open', key }));
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'clear') { if (m.key === key) { $('text').value = ''; ready(); } return; }
    if (m.type === 'empty') { $('main').style.display = 'none'; $('empty').style.display = ''; $('empty').textContent = m.text; return; }
    if (m.type !== 'show') return;
    $('empty').style.display = 'none';
    $('main').style.display = 'flex';
    const fresh = m.key !== key;
    key = m.key;
    running = m.running;
    $('conversation').textContent = m.conversation;
    $('row').textContent = m.row;
    $('question').textContent = m.question;
    const more = [m.note, m.detail].filter(Boolean).join('\\n\\n');
    $('more').style.display = more ? '' : 'none';
    $('detail').textContent = more;
    if (fresh) { $('text').value = m.draft; $('more').open = false; }
    $('text').disabled = !running;
    $('status').textContent = running ? m.status : m.notRunning;
    $('status').className = m.failed ? 'failed' : '';
    ready();
    if (m.focus && running) $('text').focus();
  });
</script></body></html>`;
  }
}

module.exports = { AnswerView };
