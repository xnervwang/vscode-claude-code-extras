// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The work plan's part of the context, shown on hovering the context meter (src/page/55-context-detail.js): how often
 * the plan was put in front of Claude since the conversation's last compaction, and their total length in characters.
 * Read from the end of the conversation's own transcript.
 *
 * An injection is an attachment record of type hook_additional_context for UserPromptSubmit whose text starts with the
 * plan's opening words. The time-zone hook writes the same kind of record; the opening words tell them apart.
 * Claude Code saves an output over 10,000 characters to a file and gives the model a <persisted-output> preview
 * instead; that preview is what is counted. The current context is the input, cache-read and cache-creation tokens of the
 * latest main-thread reply, as in the shared hooks (usage_of in plan_agent.py).
 */
const fs = require('fs');

const MARK = "This conversation's work plan";
const PERSISTED = '<persisted-output>';
const MAX_BYTES = 64 << 20;
const CHUNK = 1 << 20;

const COMPACT = Buffer.from('"compact_boundary"'), USAGE = Buffer.from('"usage"'), HOOK = Buffer.from('"hook_additional_context"');
const injected = (s) => typeof s === 'string' && (s.startsWith(MARK) || (s.startsWith(PERSISTED) && s.includes('\n' + MARK)));

/**
 * Reads `file` backwards to its latest compaction, or to its start, but no more than `maxBytes`. Resolves to
 * { count, chars, context, since } - since is 'compaction', 'start' or 'limit', and context is 0 when no reply carried a
 * usage - or null when the file cannot be read.
 */
async function measure(file, maxBytes = MAX_BYTES) {
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch (_) { return null; }
  const out = { count: 0, chars: 0, context: 0, since: 'start' };
  const seen = new Set();
  /* True at the compaction record. Each line is searched for the markers as bytes first, since most lines have none. */
  const line = (buf) => {
    if (buf.indexOf(COMPACT) === -1 && buf.indexOf(HOOK) === -1 && (out.context || buf.indexOf(USAGE) === -1)) return false;
    let r;
    try { r = JSON.parse(buf.toString('utf8')); } catch (_) { return false; }
    if (!r || typeof r !== 'object') return false;
    if (r.type === 'system' && r.subtype === 'compact_boundary') return true;
    if (r.type === 'assistant' && !r.isSidechain && !out.context) {
      const u = r.message && r.message.usage;
      if (u) out.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    const a = r.type === 'attachment' ? r.attachment : null;
    if (a && a.type === 'hook_additional_context' && a.hookEvent === 'UserPromptSubmit' && Array.isArray(a.content)) {
      if (r.uuid && seen.has(r.uuid)) return false;
      if (r.uuid) seen.add(r.uuid);
      for (const s of a.content) if (injected(s)) { out.count++; out.chars += s.length; }
    }
    return false;
  };
  try {
    const size = (await fh.stat()).size;
    const floor = Math.max(0, size - maxBytes);
    let pos = size, tail = Buffer.alloc(0);
    while (pos > floor) {
      const n = Math.min(CHUNK, pos - floor);
      pos -= n;
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      let data = tail.length ? Buffer.concat([buf.subarray(0, bytesRead), tail]) : buf.subarray(0, bytesRead);
      let end = data.length;
      for (let i = data.lastIndexOf(0x0a, end - 1); i !== -1; i = data.lastIndexOf(0x0a, end - 1)) {
        if (end > i + 1 && line(data.subarray(i + 1, end))) { out.since = 'compaction'; return out; }
        end = i;
        if (i === 0) break;
      }
      tail = Buffer.from(data.subarray(0, end));
      data = null;
    }
    if (floor > 0) out.since = 'limit';
    else if (tail.length && line(tail)) out.since = 'compaction';
    return out;
  } catch (_) {
    return null;
  } finally {
    await fh.close();
  }
}

/** The numbers behind describe(), for the context meter's hover; null when nothing was injected. */
function figures(m, maxBytes = MAX_BYTES) {
  if (!m || !m.count) return null;
  const since = m.since === 'compaction' ? 'since the last compaction'
    : m.since === 'limit' ? `in the last ${Math.round(maxBytes / (1 << 20))} MB of the transcript` : 'since the conversation began';
  return { count: m.count, chars: m.chars, tokens: Math.round(m.chars / 4), context: m.context, since };
}

/** The line shown for a measurement, or '' when there is nothing to show. */
function describe(m, maxBytes = MAX_BYTES) {
  const f = figures(m, maxBytes);
  if (!f) return '';
  const tokens = f.tokens;
  let text = `injected ${m.count} time${m.count === 1 ? '' : 's'} ${f.since}: ${m.chars} characters, about ${tokens} tokens`;
  if (m.context > 0) {
    const share = Math.round(100 * tokens / m.context);
    text += `, ${share ? share + '%' : 'under 1%'} of the ${m.context} in context`;
  }
  return text;
}

module.exports = { measure, describe, figures, MARK, MAX_BYTES };
