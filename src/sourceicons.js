// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Row icons in the Conversations tab when more than one source is registered: the source's logo with a state dot at the
 * top right, where Claude Code's own pending icon has its dot. The logo is read from the agent's own extension, so none
 * is shipped here; the dotted copies are written to this extension's storage on first use, as src/tabdot.js does.
 * SVG files cannot use theme colours, so COLORS holds the default light and dark theme values.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./claude-files');
const { readBounded } = require('./bounded');

/* charts.orange, charts.blue, charts.green and descriptionForeground, as src/conversations-view.js colours the states. */
const COLORS = {
  prompt: { light: '#d18616', dark: '#d18616' },
  needs: { light: '#d18616', dark: '#d18616' },
  working: { light: '#1a85ff', dark: '#3794ff' },
  unread: { light: '#388a34', dark: '#89d185' },
  idle: { light: '#717171', dark: '#a0a0a0' },
};
const MAX_BYTES = 256 * 1024;
const MASK = 'cce-source-dot';
const PLACING = new Set(['width', 'height', 'x', 'y', 'style', 'class', 'id', 'xmlns']);

function withDot(svg, color) {
  const text = String(svg || '');
  const open = /<svg\b([^>]*)>/i.exec(text);
  if (!open || /\/\s*$/.test(open[1])) return '';
  const end = text.lastIndexOf('</svg>');
  if (end < open.index + open[0].length) return '';
  const inner = text.slice(open.index + open[0].length, end)
    .replace(/<title\b[\s\S]*?<\/title>/gi, '').replace(/<script\b[\s\S]*?<\/script>/gi, '');
  if (!inner.trim()) return '';
  const attrs = [];
  let viewBox = '', w = NaN, h = NaN;
  for (const m of open[1].matchAll(/([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/g)) {
    const name = m[1], value = m[2].slice(1, -1);
    if (name === 'viewBox') viewBox = value;
    else if (name === 'width') w = parseFloat(value);
    else if (name === 'height') h = parseFloat(value);
    if (name !== 'viewBox' && !PLACING.has(name) && !/^on/i.test(name)) attrs.push(`${name}=${m[2]}`);
  }
  if (!viewBox) viewBox = w > 0 && h > 0 ? `0 0 ${w} ${h}` : '0 0 24 24';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">'
    + `<defs><mask id="${MASK}"><rect width="24" height="24" fill="white"/><circle cx="19.5" cy="4.5" r="6.5" fill="black"/></mask></defs>`
    + `<g mask="url(#${MASK})"><svg x="0" y="0" width="24" height="24" viewBox="${viewBox}"${attrs.length ? ' ' + attrs.join(' ') : ''}>`
    + inner + '</svg></g>'
    + `<circle cx="19.5" cy="4.5" r="4.5" fill="${color}"/></svg>`;
}

/* The state becomes part of the file name, so only states in COLORS are accepted and the path must stay inside `dir`. */
function iconsFor(logo, state, dir, cache) {
  if (!Object.prototype.hasOwnProperty.call(COLORS, state)) return null;
  const colors = COLORS[state];
  const key = JSON.stringify([logo && logo.light, logo && logo.dark, state]);
  if (cache && cache.has(key)) return cache.get(key);
  let out = null;
  try {
    const made = {};
    const home = path.resolve(dir);
    for (const theme of ['light', 'dark']) {
      const file = logo && logo[theme];
      const body = typeof file === 'string' && file ? readBounded(file, MAX_BYTES) : null;
      if (body === null) throw new Error('no usable logo');
      const svg = withDot(body, colors[theme]);
      if (!svg) throw new Error('not an SVG');
      const target = path.join(home, `${crypto.createHash('sha256').update(svg).digest('hex').slice(0, 12)}-${state}-${theme}.svg`);
      if (path.dirname(target) !== home) throw new Error('outside the icons folder');
      let have = '';
      try { have = fs.readFileSync(target, 'utf8'); } catch (_) { /* not written yet */ }
      if (have !== svg) {
        fs.mkdirSync(dir, { recursive: true });
        writeAtomic(target, svg);
      }
      made[theme] = target;
    }
    out = made;
  } catch (_) { out = null; }
  if (cache) cache.set(key, out);
  return out;
}

module.exports = { COLORS, withDot, iconsFor };
