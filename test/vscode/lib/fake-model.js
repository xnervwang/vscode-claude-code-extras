// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A stand-in for the model behind Claude Code: an HTTP server on 127.0.0.1 that answers the Messages API's POST
 * /v1/messages with a canned reply, streamed or not as the request asks, and POST /v1/messages/count_tokens with a
 * count. Claude Code's CLI sends each turn here when ANTHROPIC_BASE_URL names this server (run.js passes it through
 * claudeCode.environmentVariables); the key it sends is fake and nothing checks it.
 *
 * A turn whose message contains ASK_TO_RUN is answered with a Bash tool call of RUN instead of text, so that Claude Code
 * stops to ask for permission to run it; the turn that carries the tool's result is answered with text again.
 *
 * hold() keeps the next turns' replies back until release() is called, so a turn can be watched while it runs.
 */
const http = require('http');

const ASK_TO_RUN = 'run the test suite';
const RUN = 'npm test';

function sse(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

/* Whether the last user message of a request is a plain question containing ASK_TO_RUN, rather than a tool's result. The
   CLI can send a system message after it. */
function asksToRun(ask) {
  const last = (ask.messages || []).filter((m) => m && m.role === 'user').pop();
  if (!last) return false;
  const parts = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content || [];
  if (parts.some((p) => p && p.type === 'tool_result')) return false;
  return parts.some((p) => p && p.type === 'text' && String(p.text).toLowerCase().includes(ASK_TO_RUN));
}

async function start({ reply = 'Done. The retry delay is set in config/sync.yml.' } = {}) {
  const seen = [];
  let gate = null;
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const url = req.url.replace(/\?.*/, '');
      let ask = {};
      try { ask = JSON.parse(body || '{}'); } catch (_) { ask = {}; }
      const tool = asksToRun(ask);
      seen.push({ method: req.method, url: req.url, bytes: body.length, stream: !!ask.stream, model: ask.model || '', tool });
      if (req.method === 'POST' && /\/v1\/messages\/count_tokens$/.test(url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1200 }));
        return;
      }
      if (req.method !== 'POST' || !/\/v1\/messages$/.test(url)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"not served here"}}');
        return;
      }
      const id = `msg_fake_${++n}`, model = ask.model || 'claude-sonnet-5-5';
      /* About a fifth of a 200k window, so the context share a reply shows is a number worth checking. */
      const usage = { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 40000, output_tokens: 40 };
      const block = tool ? { type: 'tool_use', id: `toolu_fake_${n}`, name: 'Bash', input: { command: RUN, description: 'Run the test suite' } }
        : { type: 'text', text: reply };
      const stop = tool ? 'tool_use' : 'end_turn';
      if (!ask.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [block], stop_reason: stop, stop_sequence: null, usage }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      sse(res, 'message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null,
        stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
      if (gate) await gate.promise;
      if (tool) {
        sse(res, 'content_block_start', { index: 0, content_block: { ...block, input: {} } });
        sse(res, 'content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      } else {
        sse(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } });
      }
      sse(res, 'content_block_stop', { index: 0 });
      sse(res, 'message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      sse(res, 'message_stop', {});
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hold = () => { if (!gate) { let open; const promise = new Promise((r) => { open = r; }); gate = { promise, open }; } };
  const release = () => { if (gate) { gate.open(); gate = null; } };
  const close = () => new Promise((r) => { release(); server.close(() => r()); server.closeAllConnections(); setTimeout(r, 2000); });
  return { port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, seen, hold, release, close,
    turns: () => seen.filter((s) => s.method === 'POST' && s.stream && /\/v1\/messages(\?|$)/.test(s.url)).length };
}

module.exports = { start, ASK_TO_RUN, RUN };
