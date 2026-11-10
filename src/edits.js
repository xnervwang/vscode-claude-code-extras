// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/host/edits.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * Choosing which shape of an edit fits the build in front of us.
 *
 * An edit anchors on a shape rather than on a name, because the bundle is minified and every name in it changes from
 * one build to the next. The agent also reshapes the code an edit anchors on, without notice and often.
 *
 * Where the old and the new shape share a stable substring, widening the single pattern covers both, and that is the
 * cheaper answer. Where they do not, the alternative belongs here as a second shape, because the remaining options are
 * both bad: a pattern loose enough to match both usually matches a third place as well, which fails the
 * matches-exactly-once rule and refuses the build outright; and picking one shape abandons every build that still
 * carries the other.
 *
 * Shapes are listed most current first and tried in order. Exactly one of them must match exactly once. Nothing is
 * written unless every edit found its shape - a half-patched bundle is worse than an unpatched one, since the panel
 * would then be neither what the agent shipped nor what this extension expects.
 *
 * Every patch target shares this file, so that rule is stated once rather than copied. `agent` is the name the error
 * gives the program whose build did not fit ("Codex", "Claude Code").
 */

/** An edit's alternative shapes. A single-shape edit is written inline without the wrapper, and is the common case. */
function shapesOf(edit) {
  return edit.shapes || [{ re: edit.re, to: edit.to, note: edit.note }];
}

/*
 * Find the one shape that matches `src` exactly once.
 *
 * Patterns must have the g flag: without it a match returns only the first match and its groups, so the count would be
 * the number of groups, not of matching places.
 */
function pickShape(src, edit, agent = 'agent') {
  const shapes = shapesOf(edit);
  const counts = [];
  for (let i = 0; i < shapes.length; i++) {
    const re = shapes[i].re;
    if (!(re instanceof RegExp) || !re.global) return { error: `"${edit.name}" has a pattern without the g flag, so its matches cannot be counted` };
    let at = null, n = 0;
    for (const m of src.matchAll(re)) { if (!n) at = m; n++; }
    if (n === 1) return { shape: shapes[i], index: i, note: shapes[i].note, total: shapes.length, at: at.index };
    counts.push(n);
  }
  const detail = counts.length === 1
    ? `matched ${counts[0]} times (expected 1)`
    : `matched ${counts.join(' / ')} times across its ${counts.length} known shapes (expected one of them to match once)`;
  return { error: `"${edit.name}" ${detail} - this ${agent} build is not supported yet` };
}

/*
 * All edits or none; `chosen` says which shape each edit used.
 *
 * The replacement uses a sticky copy of the pattern at the offset the counting scan found, so the bundle (several
 * megabytes, on the editor's extension host) is not scanned a second time.
 */
function applyEdits(src, edits, agent = 'agent') {
  let out = src;
  const chosen = [];
  for (const e of edits) {
    const picked = pickShape(out, e, agent);
    if (picked.error) return { error: picked.error };
    const here = new RegExp(picked.shape.re.source, picked.shape.re.flags.replace(/[gy]/g, '') + 'y');
    here.lastIndex = picked.at;
    out = out.replace(here, picked.shape.to);
    chosen.push({ name: e.name, index: picked.index, note: picked.note, total: picked.total });
  }
  return { out, chosen };
}

module.exports = { shapesOf, pickShape, applyEdits };
