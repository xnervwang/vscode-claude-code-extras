// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Compares element screenshots with an approved copy per platform, in test/vscode/baseline/<platform>/<name>.png. Only
 * what this extension draws is cropped, never Claude Code's or VS Code's own parts, which change with their releases.
 *
 * Every crop is written to <out>/actual/<platform>/<name>.png. With no approved copy for this platform the crop is only
 * saved, and the run prints a note saying so; update-baseline.js turns a run's crops into the approved copies. With one,
 * the two are compared pixel by pixel: a pixel differs when one of its channels is off by more than TOLERANCE.channel,
 * and the crop fails when more than TOLERANCE.share of its pixels differ. A failure writes
 * <out>/diff/<platform>/<name>.png, the approved copy dimmed with the differing pixels in red.
 *
 * Two runs on one machine drew every crop the same, pixel for pixel, but for the times the masks leave out. Another
 * machine of the same platform can place anti-aliasing a little differently. A channel off by more than 32 of 255 is
 * past that and short of any change of colour a reader would see; 0.2 per cent of the 142 by 259 px Text color submenu
 * is 73 px, about one letter. A crop of another size than the approved copy fails on its own,
 * unless it is one pixel off: an element 258.5 px tall is drawn 259 px tall where its top lands on a whole pixel and
 * 258 px where it lands on a half, and how far down a menu opens moves by half pixels from run to run. A crop whose
 * width or height differs from the approved copy's by one pixel is compared on the part both have, from the top left.
 *
 * `masks` are rectangles of the crop, { x, y, w, h }, that are not compared: time stamps.
 */
const fs = require('fs');
const path = require('path');
const pixels = require('./pixels');

const ROOT = path.join(__dirname, '..', 'baseline');
const TOLERANCE = { channel: 32, share: 0.002 };

/* The top left `w` by `h` pixels of `img`. */
function topLeft(img, w, h) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) img.data.copy(data, y * w * 4, y * img.width * 4, y * img.width * 4 + w * 4);
  return { width: w, height: h, data };
}

function masked(masks, x, y) {
  return masks.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
}

/* { differ, compared } for two images of the same size, and the diff image. */
function diff(a, b, masks = []) {
  const out = Buffer.alloc(a.data.length);
  let differ = 0, compared = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      const grey = Math.round((a.data[i] + a.data[i + 1] + a.data[i + 2]) / 9);
      out[i + 3] = 255;
      if (masked(masks, x, y)) { out[i] = grey; out[i + 1] = grey; out[i + 2] = grey + 80; continue; }
      compared++;
      const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
      if (d > TOLERANCE.channel) { differ++; out[i] = 255; out[i + 1] = 0; out[i + 2] = 0; } else { out[i] = grey; out[i + 1] = grey; out[i + 2] = grey; }
    }
  }
  return { differ, compared, image: { width: a.width, height: a.height, data: out } };
}

function baselines({ out, check, note, platform = process.platform }) {
  const dir = (kind) => { const d = path.join(out, kind, platform); fs.mkdirSync(d, { recursive: true }); return d; };
  const results = [];
  /* `png` is the crop as a PNG buffer. */
  function compare(name, png, { masks = [] } = {}) {
    fs.writeFileSync(path.join(dir('actual'), `${name}.png`), png);
    const approved = path.join(ROOT, platform, `${name}.png`);
    if (!fs.existsSync(approved)) {
      note(`no approved ${platform}/${name}.png yet: the crop is kept as actual/${platform}/${name}.png and not compared`);
      results.push({ name, state: 'new' });
      return;
    }
    let a = pixels.decode(fs.readFileSync(approved)), b = pixels.decode(png);
    const off = Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1 && (a.width !== b.width || a.height !== b.height);
    if (off) { const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height); a = topLeft(a, w, h); b = topLeft(b, w, h); }
    if (a.width !== b.width || a.height !== b.height) {
      check(false, `${name} is drawn as approved for ${platform}`, `it is ${b.width}x${b.height} px, the approved copy ${a.width}x${a.height}`);
      results.push({ name, state: 'size', size: [b.width, b.height], approved: [a.width, a.height] });
      return;
    }
    const d = diff(a, b, masks);
    const allowed = Math.floor(d.compared * TOLERANCE.share);
    const ok = d.differ <= allowed;
    if (!ok) fs.writeFileSync(path.join(dir('diff'), `${name}.png`), pixels.encode(d.image));
    const left = a.width * a.height - d.compared;
    check(ok, `${name} is drawn as approved for ${platform} (${d.differ} of ${d.compared} px differ, ${allowed} allowed${left ? `, ${left} masked` : ''}`
      + `${off ? ', one pixel off in size and compared on the part both have' : ''})`,
      ok ? undefined : `see diff/${platform}/${name}.png`);
    results.push({ name, state: ok ? 'same' : 'differs', differ: d.differ, compared: d.compared, allowed });
  }
  return { compare, results };
}

module.exports = { baselines, diff, ROOT, TOLERANCE };
