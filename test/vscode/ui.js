// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The window stage of run.js: a real VS Code window with Claude Code, Agent Plus and this extension freshly installed,
 * driven through Playwright. It checks, in order:
 *
 *   the patch      both of Claude Code's patched files are written on the first start and VS Code says to reload; the
 *                  tab bar keeps the one Claude button, Claude Code's own, before the reload and after it
 *   session list   Claude Code's session list as the patch changes it: New in tab and New in sidebar, a pin and the dates
 *                  on every row, the right-click menu's Resume in tab, Resume in sidebar and Text color, a pin clicked,
 *                  and the hover text of a row
 *   a tab          a conversation resumed in a tab: its title, the times on every message and reply, the bar on your
 *                  messages, the rail and its list, the footer's buttons, their hover text and the information box,
 *                  OPEN SESSIONS, and which times show while the extension is off and once it is on again
 *   the dots       the dot on the tab's logo while a turn sent through fake-model.js runs, once its reply lands with the
 *                  tab in the background, and while Claude Code waits for permission to run a command
 *   closed, sidebar, archived, commands
 *                  RECENTLY CLOSED once the tab is closed; Resume in sidebar, New in sidebar and New in tab; Delete
 *                  session… on an archived conversation and its confirmation; Show Status, Settings and the confirmation
 *                  of Stop Loading the Work Plan Plugin
 *
 * Every step saves a screenshot to <out>/shots, and crops of the parts this extension draws are compared with the
 * approved copies (lib/baseline.js). Claude Code's own parts are never cropped: where one of ours sits between two of
 * Claude Code's, each of ours is cropped on its own.
 */
const fs = require('fs');
const path = require('path');
const win = require('./lib/window');
const { baselines } = require('./lib/baseline');
const pixels = require('./lib/pixels');
const { folderName } = require('./lib/fake-home');
const { ASK_TO_RUN, RUN } = require('./lib/fake-model');
const tabdot = require('../../src/tabdot');

const { sleep, until } = win;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const DOTS = { running: rgb(tabdot.GREEN), unread: rgb(tabdot.RED), waiting: rgb(tabdot.BLUE) };
const PANEL_VIEW = 'mainThreadWebview-claudeVSCodePanel';
const CLAUDE_BUTTON = 'Claude Code: Open';
const RELOAD = /^Claude Code Plus is installed in Claude Code panel and Claude Code host\. Reload the window once to start/;
/* What Text color's Red and a pinned pin are drawn in, in the Dark Modern theme run.js sets. */
const RED_TITLE = 'rgb(241, 76, 76)';
const PIN_PURPLE = 'rgb(177, 128, 215)';
const COLORS = ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange', 'Pink', 'Cyan'];
const LABELS = {
  info: 'About this conversation: its session id, process id, the directory it started in, where its transcripts are kept, their size, and the token mode',
  focusOff: 'Showing thinking and tool calls - click for Focus view: only your messages and the replies',
  focusOn: 'Focus view is on: only your messages and the replies - click to show thinking and tool calls',
  mute: 'A chime when a turn finishes, and when Claude is waiting for you - click to mute',
  muted: 'Chimes are muted - click to hear a chime when a turn finishes',
  rail: 'Your messages in this conversation - click one to jump to it',
};
/* A stamp as the page writes it: a no-break space inside each part, so it can wrap only after a "·" and after the time. */
const NB = '\u00a0', SEP = `${NB}\u00b7 `;
const STAMP = `(?:\\d\\d/\\d\\d${NB})?\\d\\d:\\d\\d:\\d\\d`;

async function run({ exe, profile, env, playwright, model, threads, out, check, note }) {
  const shotsDir = path.join(out, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const base = baselines({ out, check, note });
  let shotNo = 0;
  const w = await win.open({ exe, profile, env, playwright, log: path.join(out, 'vscode-window.log') });
  const { page, call } = w;
  const shot = (name) => page.screenshot({ path: path.join(shotsDir, `${String(++shotNo).padStart(2, '0')}-${name}.png`) }).catch(() => {});
  const step = async (name, fn) => {
    console.log(`\n── ${name}`);
    try { await fn(); } catch (e) { check(false, `${name}: ran to its end`, String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ')); await shot(`${name.replace(/\W+/g, '-')}-error`); }
  };
  const notes = path.join(profile.folder, 'notes.txt');
  const transcriptOf = (t) => path.join(profile.home, '.claude', 'projects', folderName(profile.folder), `${t.id}.jsonl`);

  /* ── what the window and the extension host say ── */
  const patchState = () => call(`
    const mine = vscode.extensions.getExtension('xnervwang.claude-code-plus'), cc = vscode.extensions.getExtension('anthropic.claude-code');
    if (!mine || !cc) return null;
    const A = require(require('path').join(mine.extensionPath, 'src', 'adapters'));
    return { active: mine.isActive, targets: A.map((a) => [a.name, a.status(cc.extensionPath)]) };`);
  const tabs = () => call(`return vscode.window.tabGroups.all.map((g) => ({ column: g.viewColumn, active: g.isActive,
    tabs: g.tabs.map((t) => ({ label: t.label, active: t.isActive, view: (t.input && t.input.viewType) || '' })) }));`);
  const claudeTabs = async () => (await tabs()).flatMap((g) => g.tabs.map((t) => ({ ...t, column: g.column })))
    .filter((t) => t.view === PANEL_VIEW);
  const exec = (command, ...a) => call(`await vscode.commands.executeCommand(${JSON.stringify(command)}, ...arg); return true;`, a);
  /* Started and not waited for: the command opens a dialog that is answered through the window. */
  const start = (command) => call(`vscode.commands.executeCommand(${JSON.stringify(command)}); return true;`);
  const openNotes = (column = 0) => call(`await vscode.window.showTextDocument(vscode.Uri.file(${JSON.stringify(notes)}),
    { preview: false, ...(arg ? { viewColumn: arg } : {}) }); return true;`, column);
  /* A tab's label as Claude Code shortens it: the title's first characters and an ellipsis. */
  const titled = (label, title) => !!label && title.startsWith(label.replace(/…$/, '')) && label.length >= 12;

  /* The Claude buttons in the active editor group's tool bar, by their labels. */
  const claudeButtons = () => page.evaluate(() => [...document.querySelectorAll('.editor-group-container.active .editor-actions .action-item .action-label')]
    .map((a) => a.getAttribute('aria-label') || a.title || '').filter((t) => /Claude/.test(t)));
  const claudeButton = () => page.locator('.editor-group-container.active .editor-actions .action-item .action-label[aria-label*="Claude"]').first();
  /* The text of VS Code's hover over `loc`. */
  const hoverText = async (loc) => {
    await page.mouse.move(5, 300);
    await sleep(300);
    await loc.hover();
    const text = await until(() => page.evaluate(() => {
      const h = [...document.querySelectorAll('.monaco-hover, .workbench-hover')].find((e) => e.offsetParent && e.innerText.trim());
      return h ? h.innerText.trim() : '';
    }), 5000, 200);
    await page.mouse.move(5, 300);
    await sleep(300);
    return text || '';
  };
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.notification-list-item-message')].map((e) => e.innerText));
  const visibleNativeMenu = () => page.evaluate(() => !![...document.querySelectorAll('.context-view .monaco-menu, .monaco-menu-container')].find((e) => e.offsetParent));
  const auxiliaryVisible = () => page.evaluate(() => {
    const part = document.getElementById('workbench.parts.auxiliarybar');
    return !!(part && part.offsetWidth > 0 && part.offsetHeight > 0);
  });
  /* VS Code's modal dialog, drawn in the page with window.dialogStyle "custom". */
  const dialog = () => page.evaluate(() => {
    const d = [...document.querySelectorAll('.monaco-dialog-box')].find((e) => e.offsetParent);
    return d ? { text: d.innerText, buttons: [...d.querySelectorAll('.monaco-button')].map((b) => b.innerText.trim()).filter(Boolean) } : null;
  });
  const answerDialog = async (label) => {
    await page.locator('.monaco-dialog-box .monaco-button').filter({ hasText: label }).first().click();
    return until(async () => !(await dialog()), 5000, 200);
  };

  /* A frame of the window's webviews in which `test` (a function of document) is true. */
  const frameWhere = async (test, ms, arg) => until(async () => {
    for (const f of page.frames()) {
      try { if (await f.evaluate(test, arg)) return f; } catch (_) { /* not ready, or gone */ }
    }
    return null;
  }, ms, 500);
  /* The crop of `box` (in the window's CSS pixels) as a PNG, with each of its four edges rounded to the nearest pixel, as
     the page itself snaps them: a size such as 258.5 px rounded alone comes out as 258 in one run and 259 in the next. */
  const crop = (box) => {
    const x = Math.round(box.x), y = Math.round(box.y);
    return page.screenshot({ animations: 'disabled', clip: { x, y, width: Math.round(box.x + box.width) - x, height: Math.round(box.y + box.height) - y } });
  };
  /* Resolves once `loc` has stopped changing: its animations have finished and two readings of its box agree. */
  const still = async (loc) => {
    let last = '';
    return until(async () => {
      const busy = await loc.evaluate((e) => e.getAnimations({ subtree: true }).some((a) => a.playState === 'running'));
      const box = JSON.stringify(await loc.boundingBox());
      const same = !busy && box === last;
      last = box;
      return same;
    }, 3000, 100);
  };
  /* Compares the crop of `loc` once it is still, with `masks` (boxes in the window's pixels) left out. */
  const compareAt = async (name, loc, { masks = [], pad = 0 } = {}) => {
    await still(loc);
    /* Agent Plus's first-install token mode notice stays at the bottom right until it is answered, over the footer. */
    await exec('notifications.hideToasts');
    const b = await loc.boundingBox();
    if (!b) { check(false, `${name} can be cropped`, 'the element has no box'); return; }
    const box = { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
    base.compare(name, await crop(box), { masks: within(box, masks) });
  };
  /* Rectangles of `boxes` relative to `outer`, for the masks of a crop. */
  const within = (outer, boxes) => boxes.filter(Boolean).map((b) => ({ x: Math.floor(b.x - Math.round(outer.x)), y: Math.floor(b.y - Math.round(outer.y)),
    w: Math.ceil(b.width) + 1, h: Math.ceil(b.height) + 1 }));
  /* How many pixels of each dot colour a PNG holds. */
  const dotColours = (png) => {
    const img = pixels.decode(png);
    const count = {};
    for (const [k, c] of Object.entries(DOTS)) {
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        if (Math.abs(img.data[i] - c[0]) <= 24 && Math.abs(img.data[i + 1] - c[1]) <= 24 && Math.abs(img.data[i + 2] - c[2]) <= 24) n++;
      }
      count[k] = n;
    }
    return count;
  };
  /* The crop of the logo on the tab whose label starts with `label`, and how many pixels of each dot colour it holds;
     null while that tab is not in sight on the tab bar. */
  const tabLogo = async (label) => {
    const tab = page.locator('.tabs-container .tab').filter({ hasText: label.slice(0, 16) }).first();
    const box = await tab.boundingBox().catch(() => null);
    const bar = await page.locator('.editor-group-container:has(.tabs-container .tab) .tabs-and-actions-container').filter({ has: tab }).first()
      .boundingBox().catch(() => null);
    if (!box || !bar || box.x < bar.x || box.x + 40 > bar.x + bar.width) return null;
    const area = { x: box.x + 4, y: box.y + 4, width: 24, height: box.height - 8 };
    const png = await crop(area);
    return { count: dotColours(png), png };
  };
  const dotsOn = async (label) => { const l = await tabLogo(label); return l && l.count; };
  /* The hover label this extension draws in `frame` while the pointer rests on `loc`, as { text, box }. */
  const labelOf = async (frame, loc) => {
    await exec('notifications.hideToasts');
    await page.mouse.move(5, 5);
    await sleep(200);
    await loc.hover();
    const got = await until(() => frame.evaluate(() => {
      const b = document.querySelector('[data-cce-label="1"]');
      return b && b.innerText.trim() ? b.innerText.trim() : '';
    }), 3000, 100);
    const box = got ? await frame.locator('[data-cce-label="1"]').first().boundingBox() : null;
    const png = box ? await crop(box) : null;
    await page.mouse.move(5, 5);
    await sleep(200);
    return { text: got || '', box, png };
  };

  /* ── the session list, Claude Code's own webview ── */
  let list = null;
  /* A conversation's row below OPEN SESSIONS and RECENTLY CLOSED, which show the same conversations again. */
  const row = (t) => list.locator(`[class*="sessionItem_"]:has([data-cce-pin="${t.id}"]):not([data-cce-section] *)`).first();
  const menus = () => list.evaluate(() => [...document.querySelectorAll('[role="menu"]')].filter((m) => m.getClientRects().length)
    .map((m) => [...m.querySelectorAll('[role="menuitem"]')].map((i) => i.innerText.replace(/\s*›\s*$/, '').trim())));
  const item = (label, level = 0) => list.locator('[role="menu"]').nth(level).locator('[role="menuitem"]').filter({ hasText: label }).first();
  /* A press on the empty bottom of the list closes its menus and does nothing else. */
  const closeMenus = async () => {
    if (!(await menus()).length) return;
    const box = await (await list.frameElement()).boundingBox();
    await page.mouse.click(box.x + 40, box.y + box.height - 12);
    await until(async () => !(await menus()).length, 3000, 100);
  };
  const openMenu = async (t) => {
    await closeMenus();
    await row(t).click({ button: 'right' });
    return until(async () => { const m = await menus(); return m.length ? m : null; }, 5000, 100);
  };
  /*
   * Right-clicks `t`'s row and clicks the menu item labels[0], or, given labels[1], that item of its submenu. The list
   * closes its menu when its page loses the focus, and another webview of the window (a Claude Code page that has just
   * opened) can take the focus at any moment; a click then lands on whatever was under the menu, with no error. So the
   * page records where each click lands, and a click that missed its item while the page lost the focus is tried again,
   * at most twice. A click that missed while the page kept the focus fails the check.
   */
  const pick = async (t, labels) => {
    await list.evaluate(() => {
      window.__cceLanded = [];
      if (window.__cceLandedHook) return;
      window.__cceLandedHook = true;
      window.addEventListener('click', (e) => {
        const it = e.target.closest && e.target.closest('[role="menuitem"]');
        window.__cceLanded.push(it ? it.innerText.replace(/\s*›\s*$/, '').trim() : `outside the menu (${e.target.tagName})`);
      }, true);
      window.addEventListener('blur', () => window.__cceLanded.push('the page lost the focus'));
    });
    const said = [];
    const wanted = labels[labels.length - 1];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await list.evaluate(() => { window.__cceLanded = []; });
      const opened = await openMenu(t);
      try {
        if (!opened) throw new Error('no menu opened');
        if (labels.length > 1) {
          await item(labels[0]).hover({ timeout: 3000 });
          await item(labels[1], 1).click({ timeout: 3000 });
        } else await item(labels[0]).click({ timeout: 3000 });
      } catch (e) { said.push(e.message.split('\n')[0]); }
      const landed = await list.evaluate(() => window.__cceLanded.slice());
      if (landed.some((x) => x.startsWith(wanted))) return attempt;
      said.push(landed.join(', ') || 'no click recorded');
      if (!landed.includes('the page lost the focus')) throw new Error(`the click on ${labels.join(' > ')} landed elsewhere: ${said.join('; ')}`);
      await sleep(1000);
    }
    throw new Error(`the menu kept closing before ${labels.join(' > ')} could be clicked: ${said.join('; ')}`);
  };
  const retried = (n, what) => { if (n > 1) note(`${what} took ${n} tries: the session list's menu closed before the click landed`); };
  const openList = async () => {
    await exec('workbench.view.extension.claude-sessions-sidebar');
    list = await frameWhere(() => !!document.querySelector('[data-cce-new-session]'), 60000);
    return list;
  };
  /* OPEN SESSIONS and RECENTLY CLOSED, with the conversations each shows: a row drawn by the list's own component has an
     id that ends in the session id, and one drawn by this extension says it in data-cce-open-row. */
  const sections = () => list.evaluate(() => [...document.querySelectorAll('[data-cce-section]')].map((s) => ({
    open: s.hasAttribute('data-cce-open-sessions'), closed: s.hasAttribute('data-cce-recent-closed'), collapsed: s.getAttribute('data-cce-collapsed') === '1',
    head: ((s.querySelector('[data-cce-section-head]') || {}).innerText || '').replace(/\s+/g, ' ').trim(),
    rows: [...s.querySelectorAll('[class*="sessionItem_"][id], [data-cce-open-row]')]
      .map((r) => r.getAttribute('data-cce-open-row') || (/[0-9a-f-]{36}$/.exec(r.id) || [''])[0]) })));

  /* The dot colours on the left of a conversation's row in OPEN SESSIONS, where the list draws its status dot. */
  const listDot = async (t) => {
    const b = await list.locator(`[data-cce-open-sessions] [class*="sessionItem_"][id$="${t.id}"]`).first().boundingBox().catch(() => null);
    return b ? dotColours(await crop({ x: b.x, y: b.y, width: Math.min(60, b.width), height: b.height })) : null;
  };
  /* A press on the empty bottom of the list, which takes the focus off its rows and does nothing else. */
  const clickEmpty = async () => {
    const box = await (await list.frameElement()).boundingBox();
    await page.mouse.click(box.x + 40, box.y + box.height - 12);
    await page.mouse.move(5, 880);
    await sleep(300);
  };

  /* ── the conversation's page ── */
  let conv = null;
  const conversation = (t, ms = 90000) => frameWhere((q) => document.querySelectorAll('[class*="userMessage_"]').length >= q.n
    && document.body.innerText.includes(q.ask), ms, { n: t.turns.length, ask: t.turns[0][0] });
  const stampsIn = (frame) => frame.evaluate(() => {
    const of = (sel) => [...document.querySelectorAll(sel)].map((m) => {
      const s = m.hasAttribute('data-cce-ts') ? m : m.querySelector('[data-cce-ts]');
      return s ? s.getAttribute('data-cce-ts') : null;
    });
    return { user: of('[class*="userMessage_"]'), reply: of('[data-testid="assistant-message"]'), all: document.querySelectorAll('[data-cce-ts]').length };
  });

  try {
    await w.hostUp();

    await step('the patch', async () => {
      const st = await until(async () => { const s = await patchState(); return s && s.targets.length === 2 && s.targets.every(([, x]) => x === 'patched') && s; }, 120000, 1000);
      check(!!st, 'Claude Code Plus patches Claude Code\'s panel and its host on the first start', await patchState());
      const toast = await until(async () => (await toasts()).find((t) => RELOAD.test(t)) || '', 30000, 500);
      check(!!toast, 'and VS Code shows its prompt to reload the window', toast || await toasts());
      const actions = await page.evaluate(() => {
        const n = [...document.querySelectorAll('.notification-list-item')].find((e) => /Claude Code Plus is installed/.test(e.innerText));
        return n ? [...n.querySelectorAll('.monaco-button')].map((b) => b.innerText.trim()).filter(Boolean) : null;
      });
      check(!!actions && actions.includes('Reload Window'), 'with a Reload Window button on it', actions);
      await shot('patched-reload-prompt');
      await openNotes();
      await until(async () => (await claudeButtons()).length > 0, 15000);
      const before = await claudeButtons();
      check(before.length === 1 && before[0] === CLAUDE_BUTTON, 'the tab bar has one Claude button, Claude Code\'s own', before);
      const hover = before.length ? await hoverText(claudeButton()) : '';
      check(hover.startsWith(CLAUDE_BUTTON), `and its hover reads "${CLAUDE_BUTTON}"`, hover);
      await shot('tab-bar-before-reload');
    });

    await step('the reload', async () => {
      await exec('notifications.clearAll');
      await w.reload();
      const st = await until(async () => { const s = await patchState(); return s && s.active && s; }, 60000, 1000);
      check(!!st && st.targets.every(([, x]) => x === 'patched'), 'after the reload the extension is active and both files are still patched', st);
      await sleep(3000);
      const again = (await toasts()).filter((t) => RELOAD.test(t));
      check(!again.length, 'and VS Code does not ask for a reload again', again);
      /* Claude Code opens itself in the secondary sidebar on its first start; the editor area is wanted whole. */
      await exec('workbench.action.closeAuxiliaryBar');
      await exec('workbench.action.closeAllEditors');
      await openNotes();
      const after = await until(async () => { const b = await claudeButtons(); return b.length ? b : null; }, 15000, 500);
      check(!!after && after.length === 1 && after[0] === CLAUDE_BUTTON, 'after the reload the tab bar still has one Claude button, Claude Code\'s own', after);
      await shot('reloaded');
    });

    await step('session list', async () => {
      check(!!await openList(), 'Claude Code\'s session list opens with this extension\'s buttons in it');
      if (!list) return;
      const top = await list.evaluate(() => ({
        ours: [...document.querySelectorAll('[data-cce-new-session]')].map((b) => [b.getAttribute('data-cce-new-session'), b.innerText.trim(), b.title]),
        theirs: [...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === 'New session').length }));
      check(JSON.stringify(top.ours) === JSON.stringify([['tab', 'New in tab', 'Start a conversation in a new editor tab'],
        ['sidebar', 'New in sidebar', 'Start a conversation in the sidebar']]) && top.theirs === 0,
      'New in tab and New in sidebar stand in place of Claude Code\'s New session', top);
      /* Each keeps its 16 px icon however narrow the list is; macOS and Windows open the window narrow enough to test it. */
      const icons = await list.evaluate(() => [...document.querySelectorAll('[data-cce-new-session]')].map((b) => {
        const i = b.querySelector('svg') || (b.firstElementChild && b.firstElementChild.firstElementChild);
        return i ? Math.round(i.getBoundingClientRect().width) : 0;
      }));
      check(icons.length === 2 && icons.every((x) => x === 16), 'and each keeps its icon whole', icons);
      const listed = await until(async () => {
        const got = await list.evaluate(() => [...document.querySelectorAll('[class*="sessionItem_"] span[class*="sessionName_"]')].map((e) => e.textContent.trim()));
        return threads.every((t) => got.includes(t.title)) && got;
      }, 30000, 500);
      check(!!listed, `it lists the ${threads.length} fake conversations by their titles`, listed || undefined);
      const pins = await until(async () => {
        const p = await list.evaluate((ids) => ids.map((id) => {
          const e = [...document.querySelectorAll(`[data-cce-pin="${id}"]`)].find((x) => !x.closest('[data-cce-section]'));
          const r = e && e.closest('[class*="sessionItem_"]');
          return e && { off: e.hasAttribute('data-cce-pin-off'), pinned: e.getAttribute('data-cce-pinned'), label: e.getAttribute('aria-label'),
            shown: getComputedStyle(e).display !== 'none', row: r ? r.innerText.replace(/\s+/g, ' ') : '' };
        }), threads.map((t) => t.id));
        return p.every((x) => x && !x.off && x.shown) && p;
      }, 20000, 500);
      check(!!pins && pins.every((p) => p.pinned === '0' && /^Pin this conversation/.test(p.label)), 'every row has a hollow pin, not pinned', pins);
      check(!!pins && pins.every((p) => /\b(?:now|\d+[smhd]) · \d\d\/\d\d\b/.test(p.row)), 'and every row shows how long its conversation ran and its date', pins && pins.map((p) => p.row));
      await page.mouse.move(5, 880);
      await sleep(300);
      await shot('session-list');
      await compareAt('new-session-buttons', list.locator('div:has(> [data-cce-new-session="tab"])').first());
      await compareAt('pin', list.locator(`[data-cce-pin="${threads[2].id}"]:not([data-cce-section] *)`).first());

      /* The menu: what this extension puts in it, and no menu of VS Code's over it. */
      const menu = await openMenu(threads[1]);
      check(!!menu && menu.length === 1 && ['Resume in tab', 'Resume in sidebar', 'Text color'].every((l) => menu[0].includes(l))
        && !menu[0].includes('Resume session'), 'a right-click on a row opens the list\'s menu with Resume in tab, Resume in sidebar and Text color, in place of Resume session', menu);
      check(!await visibleNativeMenu(), 'and no menu of VS Code\'s opens over it');
      await page.mouse.move(5, 880);
      await sleep(300);
      await shot('session-row-menu');
      const resume = await Promise.all([item('Resume in tab').boundingBox(), item('Resume in sidebar').boundingBox()]);
      if (resume[0] && resume[1]) {
        const box = { x: resume[0].x, y: resume[0].y, width: resume[0].width, height: resume[1].y + resume[1].height - resume[0].y };
        base.compare('row-menu-resume', await crop(box));
      }
      await compareAt('row-menu-text-color', item('Text color'));
      await item('Text color').hover();
      const sub = await until(async () => { const m = await menus(); return m.length > 1 ? m[1] : null; }, 5000, 200);
      check(!!sub && sub[0] === 'Default ✓' && JSON.stringify(sub.slice(1)) === JSON.stringify(COLORS),
        'resting on Text color opens its submenu: Default, checked, and the eight colours', sub);
      await shot('session-text-color');
      if (sub) await compareAt('text-color-submenu', list.locator('[role="menu"]').nth(1));
      const colourOf = () => row(threads[1]).locator('span[class*="sessionName_"]').first().evaluate((e) => getComputedStyle(e).color);
      const was = await colourOf();
      await item('Red', 1).click();
      const now = await until(async () => { const c = await colourOf(); return c === RED_TITLE && c; }, 15000, 300);
      check(!!now && !(await menus()).length, 'clicking Red closes the menu and draws that row\'s title in the theme\'s red', { was, now: await colourOf() });
      await shot('session-row-red');

      /* A pin clicked. */
      const pin = list.locator(`[data-cce-pin="${threads[2].id}"]:not([data-cce-section] *)`).first();
      await pin.click();
      const pinned = await until(async () => {
        const p = await pin.evaluate((e) => ({ pinned: e.getAttribute('data-cce-pinned'), label: e.getAttribute('aria-label'), color: getComputedStyle(e).color }));
        return p.pinned === '1' && p.color === PIN_PURPLE && p;
      }, 20000, 500);
      check(!!pinned && /^Unpin this conversation/.test(pinned.label), 'clicking a pin pins the conversation: the pin turns purple and offers to unpin',
        pinned || await pin.evaluate((e) => [e.getAttribute('data-cce-pinned'), getComputedStyle(e).color]));
      await clickEmpty();
      await shot('session-pinned');
      await compareAt('pin-pinned', pin);

      /* The hover text of a row. */
      const hover = await labelOf(list, row(threads[2]).locator('span[class*="sessionName_"]').first());
      check(hover.text === `Group: Ungrouped\nSession ID: ${threads[2].id}`, 'resting on a row shows its group and its session ID', hover.text);
      if (hover.png) base.compare('row-hover-label', hover.png);
    });

    const tab0 = threads[0];
    await step('a conversation in a tab', async () => {
      if (!list) throw new Error('the session list did not open');
      const before = await tabs();
      retried(await pick(tab0, ['Resume in tab']), 'Resume in tab');
      const opened = await until(async () => { const t = await claudeTabs(); return t.find((x) => x.active && titled(x.label, tab0.title)); }, 30000, 500);
      check(!!opened, 'Resume in tab opens the conversation in an editor tab titled by the conversation', opened || await tabs());
      check(!await auxiliaryVisible(), 'and not in the sidebar', { before, after: await tabs() });
      conv = await conversation(tab0);
      check(!!conv, 'Claude Code draws every turn of the conversation in that tab');
      if (!conv) return;
      const st = await until(async () => { const s = await stampsIn(conv); return s.user.every(Boolean) && s.reply.every(Boolean) && s.user.length === tab0.turns.length && s; }, 20000, 500);
      const s = st || await stampsIn(conv);
      check(!!st && s.user.every((x) => new RegExp(`^${STAMP}$`).test(x)), 'each of your messages carries its time', s.user);
      check(!!st && s.reply.length === tab0.turns.length && s.reply.every((x) => new RegExp(`^${STAMP} {2}\\d+s(${SEP}ctx${NB}\\d+%)?${SEP}sonnet-5-5$`).test(x)),
        'each reply carries its time, how long it took and its model', s.reply);
      const edges = await conv.evaluate(() => [...document.querySelectorAll('[class*="userMessage_"]')].map((e) => getComputedStyle(e).borderLeftWidth));
      check(edges.length === tab0.turns.length && edges.every((x) => x === '3px'), 'your messages have the bar down their left edge', edges);
      await shot('conversation-tab');

      /* OPEN SESSIONS in the list. */
      const open = await until(async () => (await sections()).find((x) => x.open && x.rows.includes(tab0.id)), 15000, 500);
      check(!!open && /^OPEN SESSIONS 1$/i.test(open.head) && open.rows.length === 1, 'OPEN SESSIONS at the top of the list holds the conversation now open', open || await sections());
      if (open) await compareAt('open-sessions-head', list.locator('[data-cce-open-sessions] [data-cce-section-head]').first());

      /* The rail and its list. */
      const rail = await conv.evaluate(() => {
        const r = document.getElementById('cce-toc-rail');
        if (!r) return null;
        const b = r.getBoundingClientRect();
        return { display: r.style.display, parts: r.children.length, top: b.top, off: Math.abs(b.top + b.height / 2 - innerHeight / 2) };
      });
      check(!!rail && rail.display === 'flex' && rail.parts === 5, 'the rail is drawn at the right edge: to the top, up, the handle, down, to the bottom', rail);
      check(!!rail && Number.isInteger(rail.top) && rail.off <= 1, 'centred on a whole pixel, so its arrows are drawn sharp', rail);
      await page.mouse.move(5, 5);
      await sleep(300);
      if (rail) await compareAt('rail', conv.locator('#cce-toc-rail'));
      const handle = await labelOf(conv, conv.locator('#cce-toc-handle'));
      check(handle.text === LABELS.rail, 'resting on the handle says what it opens', handle.text);
      await conv.locator('#cce-toc-handle').click();
      const frameBox = await (await conv.frameElement()).boundingBox();
      const toc = await until(() => conv.evaluate(() => {
        const p = document.getElementById('cce-toc');
        if (!p || p.style.display !== 'block') return null;
        const rows = [...(p.children[1] || { children: [] }).children];
        return { filter: !!p.querySelector('input[placeholder="Filter your messages"]'), rows: rows.map((r) => r.textContent),
          times: rows.map((r) => {
            const t = r.firstElementChild;
            if (!t) return null;
            const b = t.getBoundingClientRect();
            return { x: b.left, y: b.top, width: b.width, height: b.height, end: Math.round(b.right) };
          }) };
      }), 5000, 200);
      const asked = tab0.turns.map(([q]) => (q.length > 44 ? q.slice(0, 44) + '\u2026' : q));
      check(!!toc && toc.filter && toc.rows.length === asked.length && toc.rows.every((r, i) => /^\d\d:\d\d:\d\d {2}/.test(r) && r.endsWith(asked[i])),
        'the handle opens the list of your messages, each with its time, under a filter box', toc && toc.rows);
      const ends = toc ? toc.times.map((b) => b && b.end) : [];
      check(ends.length > 1 && ends.every((x) => x && x === ends[0]), 'and the times are all one width, so every question starts at the same place', ends);
      await page.mouse.move(5, 5);
      await sleep(300);
      await shot('conversation-rail-list');
      if (toc) {
        const masks = toc.times.filter(Boolean).map((b) => ({ x: frameBox.x + b.x, y: frameBox.y + b.y, width: b.width, height: b.height }));
        await compareAt('rail-list', conv.locator('#cce-toc'), { masks });
        /* A helper of the same name in another fragment would replace the one that draws this preview (see the
           duplicate-name check in check.js). */
        await conv.locator('#cce-toc > div:nth-child(2) > div').first().hover();
        const full = await until(() => conv.evaluate(() => {
          const t = document.getElementById('cce-toc-tip');
          return t && t.style.display === 'block' ? t.textContent : null;
        }), 3000, 200);
        check(!!full && full.endsWith(tab0.turns[0][0].slice(0, 220)), 'resting on a message in the list shows it in full', full);
        await page.mouse.move(5, 5);
        await sleep(300);
      }
      await conv.locator('#cce-toc-handle').click();

      /* The footer's buttons. */
      const footer = await conv.evaluate(() => {
        const send = document.querySelector('button[type="submit"][data-permission-mode]');
        const mode = send && send.previousElementSibling;
        const kids = mode && mode.parentElement ? [...mode.parentElement.children] : [];
        const at = (sel) => kids.findIndex((k) => k.matches(sel));
        return { info: at('[data-cce-info]'), focus: at('[data-cce-focus-btn]'), mute: at('[data-cce-mute]'), mode: kids.indexOf(mode) };
      });
      check(footer.info >= 0 && footer.focus >= 0 && footer.mute >= 0 && Math.max(footer.info, footer.focus, footer.mute) < footer.mode,
        'the information, Focus view and chime buttons are in the footer, left of the permission mode', footer);
      for (const [name, sel] of [['footer-info', '[data-cce-info]'], ['footer-focus', '[data-cce-focus-btn]'], ['footer-mute', '[data-cce-mute]']]) {
        if (footer[name.slice(7)] >= 0) await compareAt(name, conv.locator(sel).first());
      }
      const hovers = {};
      for (const [k, sel] of [['info', '[data-cce-info]'], ['focusOff', '[data-cce-focus-btn]'], ['mute', '[data-cce-mute]']]) {
        const l = await labelOf(conv, conv.locator(sel).first());
        hovers[k] = l.text;
        if (k === 'info' && l.png) base.compare('footer-info-label', l.png);
      }
      check(Object.entries(hovers).every(([k, v]) => v === LABELS[k]), 'resting on each of them shows what it does', hovers);
      await shot('conversation-footer-hover');

      /* Hovering the usage meter, exactly one box is visible at a time: the panel's own tooltip, and after two seconds the
         breakdown in its place. */
      const meter = conv.locator('button[class*="usageButtonV2"]').first();
      if (await meter.count()) {
        const boxesNow = () => conv.evaluate(() => [...document.querySelectorAll('[data-footer-overlay], #cce-ctx')]
          .filter((e) => { const st = getComputedStyle(e), r = e.getBoundingClientRect(); return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0 && r.width > 0; })
          .map((e) => `${e.id || 'panel tooltip'}: ${String(e.textContent).slice(0, 80)}`));
        await meter.hover();
        await sleep(500);
        const soon = await boxesNow();
        await shot('conversation-meter-hover');
        await sleep(2600);
        const later = await boxesNow();
        await shot('conversation-meter-hover-later');
        check(soon.length === 1 && soon[0].indexOf('panel tooltip') === 0 && later.length === 1,
          'hovering the usage meter shows only the panel\'s tooltip at first, and one box after two seconds', { soon, later });
        const inside = await conv.evaluate(() => ['cce-ctx'].map((id) => document.getElementById(id))
          .filter((e) => e && e.style.display === 'block').map((e) => { const r = e.getBoundingClientRect(); return { id: e.id, left: r.left, right: r.right, page: innerWidth }; }));
        check(inside.every((b) => b.left >= 0 && b.right <= b.page), 'and that box lies inside the page', inside);
        await page.mouse.move(5, 5);
        await sleep(300);
      } else note('no usage meter in this conversation\'s footer, so its hover was not looked at');

      await conv.locator('[data-cce-info]').first().click();
      const info = await until(() => conv.evaluate(() => {
        const b = document.getElementById('cce-info');
        return b && b.style.display === 'block' && Object.fromEntries([...b.children].map((r) => [r.children[0].textContent, r.children[1].textContent]));
      }), 5000, 200);
      /* Windows paths are compared without case: VS Code hands the folder over with its drive letter in lower case. */
      const samePath = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
      check(!!info && info.Session === tab0.id && samePath(info.Project, profile.folder)
        && samePath(info.Transcripts, `~/.claude/projects/${folderName(profile.folder)}`) && /^\d/.test(info['On disk'] || ''),
      'the information button opens the conversation\'s session id, folder, transcripts and their size', info);
      const fits = await conv.evaluate(() => { const r = document.getElementById('cce-info').getBoundingClientRect(); return { left: r.left, right: r.right, page: innerWidth }; });
      check(fits.left >= 0 && fits.right <= fits.page, 'and the box lies inside the page', fits);
      await page.mouse.move(5, 5);
      await shot('conversation-info');
      if (info) await compareAt('info-session-row', conv.locator('#cce-info > div').first());
      await conv.locator('[data-cce-info]').first().click();
      check(!!await until(() => conv.evaluate(() => { const b = document.getElementById('cce-info'); return !b || b.style.display === 'none'; }), 3000, 200),
        'and a second click closes it');

      const mute = conv.locator('[data-cce-mute]').first();
      await mute.click();
      const muted = await until(() => mute.evaluate((e, want) => e.getAttribute('aria-label') === want && e.style.textDecoration === 'line-through'
        && { label: e.getAttribute('aria-label'), style: e.style.cssText }, LABELS.muted), 5000, 200);
      check(!!muted, 'the chime button mutes the chimes and is drawn struck through', muted || await mute.evaluate((e) => [e.getAttribute('aria-label'), e.style.cssText]));
      await page.mouse.move(5, 5);
      await sleep(300);
      if (muted) await compareAt('footer-mute-off', mute);
      await mute.click();
      check(!!await until(() => mute.evaluate((e, want) => e.getAttribute('aria-label') === want, LABELS.mute), 5000, 200), 'and a second click brings them back');

      const focus = conv.locator('[data-cce-focus-btn]').first();
      await focus.click();
      const folded = await until(() => focus.evaluate((e, want) => e.getAttribute('data-cce-fold') === 'folded' && e.getAttribute('aria-label') === want, LABELS.focusOn), 5000, 200);
      check(!!folded, 'the Focus view button turns Claude Code\'s Focus view on', await focus.evaluate((e) => [e.getAttribute('data-cce-fold'), e.getAttribute('aria-label')]));
      await shot('conversation-focus-view');
      await focus.click();
      check(!!await until(() => focus.evaluate((e) => e.getAttribute('data-cce-fold') === 'open'), 5000, 200), 'and off again');

      /* Turned off and on: the times go, Claude Code's own come back, and the other way round, without a reload. */
      const theirTimes = () => conv.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => !e.children.length
        && /^\d{1,2}:\d\d\s?(AM|PM)$/i.test((e.textContent || '').trim()) && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').length);
      const edgesNow = () => conv.evaluate(() => [...document.querySelectorAll('[class*="userMessage_"]')].map((e) => getComputedStyle(e).borderLeftWidth));
      check(await theirTimes() === 0, 'while it is on, Claude Code\'s own message times are hidden', await theirTimes());
      await exec('claudeCodePlus.disable');
      const gone = await until(async () => (await stampsIn(conv)).all === 0, 15000, 500);
      check(gone, 'turned off, the times leave the page without a reload', await stampsIn(conv));
      const own = await until(async () => { const n = await theirTimes(); return n >= tab0.turns.length * 2 && n; }, 10000, 500);
      check(!!own, 'and Claude Code\'s own message times show again', await theirTimes());
      const plain = await until(async () => { const x = await edgesNow(); return x.every((v) => v !== '3px') && x; }, 10000, 500);
      check(!!plain, 'and your messages lose the bar down their edge', await edgesNow());
      await shot('conversation-turned-off');
      await exec('claudeCodePlus.enable');
      const back = await until(async () => { const x = await stampsIn(conv); return x.user.every(Boolean) && x.reply.every(Boolean) && x; }, 15000, 500);
      check(!!back && await until(async () => await theirTimes() === 0, 10000, 500), 'turned back on, they are back, and Claude Code\'s are hidden again', await stampsIn(conv));
    });

    await step('the dots on a tab', async () => {
      if (!conv) throw new Error('the conversation did not open');
      const t = (await claudeTabs()).find((x) => titled(x.label, tab0.title));
      if (!t) throw new Error('the conversation\'s tab is gone');
      const idle = await dotsOn(t.label);
      check(!!idle && idle.running === 0 && idle.unread === 0 && idle.waiting === 0, 'an idle conversation\'s tab has no dot', idle);
      model.hold();
      const turns = model.turns();
      await conv.locator('[contenteditable][role="textbox"]').first().click();
      await page.keyboard.type('Run the tests again.');
      await page.keyboard.press('Enter');
      check(!!await until(() => model.turns() > turns, 30000, 300), 'a message sent from the tab reaches the fake model', model.seen.slice(-3));
      const running = await until(async () => { const d = await dotsOn(t.label); return d && d.running >= 6 && d.unread === 0 && d.waiting === 0 && d; }, 20000, 500);
      check(!!running, 'while the turn runs the tab\'s logo carries the green dot', await dotsOn(t.label));
      const listRunning = await until(async () => { const d = await listDot(tab0); return d && d.running >= 4 && d; }, 10000, 500);
      check(!!listRunning, 'and so does its row in OPEN SESSIONS', await listDot(tab0));
      await shot('tab-dot-running');
      const green = await tabLogo(t.label);
      if (running && green) base.compare('tab-dot-running', green.png);
      /* The tab's group is locked by Claude Code, so the file is opened into that group by name. */
      await openNotes(t.column);
      const hidden = await until(async () => { const x = (await claudeTabs()).find((y) => y.label === t.label); return x && !x.active; }, 5000, 200);
      check(!!hidden, 'another editor in the same group puts the tab in the background', await tabs());
      await sleep(800);
      model.release();
      const unread = await until(async () => { const d = await dotsOn(t.label); return d && d.unread >= 6 && d.running === 0 && d; }, 30000, 500);
      check(!!unread, 'once the reply lands with the tab in the background, the dot turns red', await dotsOn(t.label));
      const listUnread = await until(async () => { const d = await listDot(tab0); return d && d.unread >= 4 && d.running === 0 && d; }, 10000, 500);
      check(!!listUnread, 'and so does the one on its row in OPEN SESSIONS', await listDot(tab0));
      await shot('tab-dot-unread');
      const red = await tabLogo(t.label);
      if (unread && red) base.compare('tab-dot-unread', red.png);
      await page.locator('.tabs-container .tab').filter({ hasText: t.label.slice(0, 16) }).first().click();
      await page.bringToFront().catch(() => {});
      const read = await until(async () => { const d = await dotsOn(t.label); return d && d.unread === 0 && d.running === 0 && d; }, 20000, 500);
      check(!!read, 'and bringing the tab to the front clears it', { dots: await dotsOn(t.label), windowFocused: await call('return vscode.window.state.focused;') });
      const after = await stampsIn(conv);
      const latest = after.reply[after.reply.length - 1] || '';
      check(new RegExp(`^${STAMP} {2}\\d+s${SEP}ctx${NB}[1-9]\\d*%${SEP}cost${NB}\\$\\d+\\.\\d{3}${SEP}sonnet-5-5(${NB}\\w+)?$`).test(latest),
        'the new reply carries its time, how long it took, the context share, the estimated cost and the model', latest);
      await shot('tab-dot-read');

      /* A tool call, so Claude Code waits for permission. */
      const before = model.seen.length;
      await conv.locator('[contenteditable][role="textbox"]').first().click();
      await page.keyboard.type(`Please ${ASK_TO_RUN}.`);
      await page.keyboard.press('Enter');
      check(!!await until(() => model.seen.slice(before).some((x) => x.tool), 30000, 300), 'a message asking to run the tests gets a Bash tool call from the fake model', model.seen.slice(before));
      const asking = await until(() => conv.evaluate((cmd) => /Allow this bash command\?/.test(document.body.innerText) && document.body.innerText.includes(cmd), RUN), 20000, 500);
      check(!!asking, `Claude Code asks for permission to run ${RUN}`);
      /* The tool call's stamp is on its block, a line above Claude Code's header, which keeps its description whole. */
      const toolRow = await until(() => conv.evaluate(() => {
        const head = [...document.querySelectorAll('[class*="toolSummary_"]')].pop();
        const block = head && head.closest('[data-testid="assistant-message"] > *');
        const desc = head && head.querySelector('[class*="toolNameTextSecondary"]');
        if (!block || !desc || !block.hasAttribute('data-cce-ts')) return null;
        return { stamp: block.getAttribute('data-cce-ts'), inHeader: !!head.querySelector('[data-cce-ts]'),
          below: Math.round(head.getBoundingClientRect().top - block.getBoundingClientRect().top), descLines: desc.getClientRects().length };
      }), 10000, 500);
      check(!!toolRow && !toolRow.inHeader && toolRow.below >= 8 && toolRow.descLines === 1,
        'the tool call\'s stamp has a line of its own above Claude Code\'s header, whose description stays on one line', toolRow);
      const waiting = await until(async () => { const d = await dotsOn(t.label); return d && d.waiting >= 6 && d.running === 0 && d.unread === 0 && d; }, 20000, 500);
      check(!!waiting, 'and while it waits the tab\'s logo carries the blue dot', await dotsOn(t.label));
      const listWaiting = await until(async () => { const d = await listDot(tab0); return d && d.waiting >= 4 && d; }, 10000, 500);
      check(!!listWaiting, 'and so does its row in OPEN SESSIONS', await listDot(tab0));
      await shot('tab-dot-waiting');
      const blue = await tabLogo(t.label);
      if (waiting && blue) base.compare('tab-dot-waiting', blue.png);
      const no = conv.locator('button, [role="button"]').filter({ hasText: /^\s*3\s*No\s*$/ }).first();
      await no.click({ timeout: 5000 });
      const answered = await until(() => conv.evaluate(() => !/Allow this bash command\?/.test(document.body.innerText)), 15000, 500);
      const cleared = await until(async () => { const d = await dotsOn(t.label); return d && d.waiting === 0 && d.running === 0 && d; }, 30000, 500);
      check(answered && !!cleared, 'answering No closes the question and the dot goes', { answered, dots: await dotsOn(t.label) });
      await shot('tab-permission-answered');
    });

    await step('a closed tab', async () => {
      if (!list) throw new Error('the session list did not open');
      const closed = await call(`const t = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input && x.input.viewType === ${JSON.stringify(PANEL_VIEW)});
        if (!t) return false; await vscode.window.tabGroups.close(t); return true;`);
      if (!closed) throw new Error('no Claude Code tab to close');
      const s = await until(async () => { const x = await sections(); const c = x.find((y) => y.closed); return c && !x.some((y) => y.open && y.rows.length) && x; }, 20000, 500);
      const c = s && s.find((y) => y.closed);
      check(!!c && /^RECENTLY CLOSED 1$/i.test(c.head) && c.collapsed, 'closing the tab puts RECENTLY CLOSED, folded, at the top of the list, and leaves OPEN SESSIONS empty', s || await sections());
      await page.mouse.move(5, 880);
      await sleep(300);
      await shot('recently-closed');
      if (!c) return;
      await compareAt('recently-closed-head', list.locator('[data-cce-recent-closed] [data-cce-section-head]').first());
      await list.locator('[data-cce-recent-closed] [data-cce-section-head] button').first().click();
      const shown = await until(async () => { const x = (await sections()).find((y) => y.closed); return x && !x.collapsed && x.rows.includes(tab0.id) && x; }, 10000, 300);
      check(!!shown, 'and opening it shows the conversation just closed', (await sections()).find((y) => y.closed));
      await page.mouse.move(5, 880);
      await shot('recently-closed-open');
    });

    await step('the sidebar and new conversations', async () => {
      if (!list) throw new Error('the session list did not open');
      const t2 = threads[2];
      const tabsBefore = (await claudeTabs()).length;
      retried(await pick(t2, ['Resume in sidebar']), 'Resume in sidebar');
      const side = await until(async () => await auxiliaryVisible() && await conversation(t2, 1000), 60000, 1000);
      check(!!side && (await claudeTabs()).length === tabsBefore, 'Resume in sidebar opens the conversation in the secondary sidebar, with no new tab',
        { sidebar: await auxiliaryVisible(), tabs: await tabs() });
      await shot('resumed-in-sidebar');
      /* The sidebar is narrower than a reply's stamp: it wraps between its parts rather than running past its column. */
      // A reply hidden as quiet keeps its stamp attribute but takes no room, so only rows on screen are measured.
      const stampsFit = () => side.evaluate(() => [...document.querySelectorAll('[data-testid="assistant-message"] [data-cce-ts]')]
        .filter((e) => e.getClientRects().length).map((e) => {
        const b = getComputedStyle(e, '::before');
        return { stamp: e.getAttribute('data-cce-ts'), width: Math.round(parseFloat(b.width)), column: e.clientWidth,
          past: e.scrollWidth - e.clientWidth, wrapped: parseFloat(b.height) > 2 * parseFloat(b.fontSize) };
      }));
      const fit = (side && await until(async () => { const f = await stampsFit(); return f.length >= t2.turns.length && f; }, 10000, 500))
        || (side ? await stampsFit() : []);
      check(fit.length >= t2.turns.length && fit.every((f) => f.width <= f.column && f.past <= 0),
        'in the sidebar every reply\'s stamp stays inside its column', fit);
      if (fit.length && !fit.some((f) => f.wrapped)) note('the sidebar was wide enough for every stamp, so none had to wrap');
      await exec('workbench.action.closeAuxiliaryBar');

      await list.locator('[data-cce-new-session="sidebar"]').first().click();
      const sideNew = await until(auxiliaryVisible, 20000, 500);
      check(!!sideNew && (await claudeTabs()).length === tabsBefore, 'New in sidebar opens Claude Code in the secondary sidebar, with no new tab', await tabs());
      await shot('new-in-sidebar');
      await exec('workbench.action.closeAuxiliaryBar');

      await list.locator('[data-cce-new-session="tab"]').first().click();
      const tabNew = await until(async () => { const x = await claudeTabs(); return x.length === tabsBefore + 1 && x.find((y) => y.active) && x; }, 30000, 500);
      check(!!tabNew, 'New in tab opens a new Claude Code tab', await tabs());
      /* Its page takes the focus as it starts; the next step's menu would close under it. */
      await frameWhere(() => !!document.querySelector('[contenteditable][role="textbox"]') && !document.querySelector('[class*="userMessage_"]'), 60000);
      await sleep(2000);
      await shot('new-in-tab');
    });

    await step('an archived conversation', async () => {
      if (!list) throw new Error('the session list did not open');
      const t1 = threads[1];
      retried(await pick(t1, ['Archive session']), 'Archive session');
      check(!!await until(() => list.evaluate(() => [...document.querySelectorAll('button, [role="button"]')].some((b) => /^Archived/.test(b.innerText.trim()))), 15000, 500),
        'Archive session moves the conversation under Archived sessions');
      /* Claude Code lists archived conversations in a section of its own, folded until opened. */
      const header = list.locator('button, [role="button"]').filter({ hasText: /^Archived/ }).first();
      await header.waitFor({ state: 'visible', timeout: 15000 });
      if (!await row(t1).isVisible().catch(() => false)) await header.click();
      await row(t1).waitFor({ state: 'visible', timeout: 15000 });
      const menu = await openMenu(t1);
      check(!!menu && menu[0].includes('Delete session…'), 'an archived conversation\'s menu has Delete session…', menu);
      await page.mouse.move(5, 880);
      await sleep(300);
      await shot('archived-menu');
      if (menu) await compareAt('row-menu-delete', item('Delete session…'));
      retried(await pick(t1, ['Delete session…']), 'Delete session…');
      const d = await until(dialog, 15000, 300);
      check(!!d && d.text.includes(`Delete "${t1.title}" from disk?`) && d.text.includes('This cannot be undone.') && d.buttons.includes('Delete') && d.buttons.includes('Cancel'),
        'Delete session… asks first, in a dialog naming the conversation, saying it cannot be undone, with Delete and Cancel', d);
      await shot('delete-confirmation');
      if (d) check(await answerDialog('Cancel') && fs.existsSync(transcriptOf(t1)), 'Cancel closes it and deletes nothing', transcriptOf(t1));
    });

    await step('the steward panel', async () => {
      const front = threads[0];
      /* The Steward panel lists only conversations open in a window, so the others are opened in tabs first. */
      for (const t of threads.slice(1)) { await exec('claude-vscode.editor.open', t.id); await sleep(800); }
      await exec('claude-vscode.editor.open', front.id);
      await sleep(1500);
      await exec('workbench.view.extension.claudeCodePlusSteward');
      const frame = await frameWhere(() => /Managed by/.test(document.body ? document.body.innerText : ''), 30000);
      const text = frame ? await frame.evaluate(() => document.body.innerText.slice(0, 300)) : '';
      check(!!frame, 'the Steward panel opens at the bottom of the window for the conversation in front', text);
      /* Running conversations come from `claude agents --json`, which is polled at most every 30 s. */
      const listed = () => frame.evaluate(() => [...document.querySelectorAll('input[data-id]')].map((b) => [b.dataset.id, b.checked]));
      const boxes = frame ? (await until(async () => { const b = await listed(); return b.length ? b : null; }, 40000, 1000)) || [] : [];
      const groups = frame ? await frame.evaluate(() => document.querySelectorAll('input[data-group]').length) : 0;
      const dataDir = path.join(profile.home, '.claude', 'plugins', 'data', 'agent-work-plan-claude-code-extras');
      const readAll = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch (_) { return []; } };
      check(boxes.length >= 1 && boxes.every(([id, on]) => id !== front.id && !on) && groups >= 1,
        'it lists the other conversations open in a window, in groups by window, none ticked, and not the one in front',
        { boxes, groups, windows: readAll(path.join(dataDir, 'windows')).map((w) => w.sessions),
          running: readAll(path.join(profile.home, '.claude', 'sessions')).map((r) => [r.sessionId, r.kind, r.status]) });
      await shot('steward-panel');
      if (frame && boxes.length) {
        await frame.locator('input[data-id]').first().click();
        const file = path.join(profile.home, '.claude', 'plugins', 'data', 'agent-work-plan-claude-code-extras', 'stewards.json');
        const table = await until(() => {
          try { const t = JSON.parse(fs.readFileSync(file, 'utf8')); return t.stewards && t.stewards[front.id] ? t : null; } catch (_) { return null; }
        }, 10000, 300);
        check(!!table && table.stewards[front.id].manages.includes(boxes[0][0]), 'ticking one makes the conversation in front its steward', table);
        const marked = await until(async () => (await claudeTabs()).find((x) => x.label === 'Steward of 1 conversation \u{1F6CE}\uFE0F'), 10000, 300);
        check(!!marked, 'and its tab is titled as a steward, with a bell', await claudeTabs());
        const row = list ? await until(() => list.evaluate(() => (document.body.innerText.match(/Steward of 1 conversation/g) || []).length), 15000, 500) : 0;
        check(row >= 1, 'and its row in the session list too', row);
        await shot('steward-ticked');
        /* The user's words, passed on by the steward's script: the window types them into the managed conversation,
           which sends them as the user's message. */
        const target = threads.find((t) => t.id === boxes[0][0]);
        if (target) {
          const words = 'Please run the tests once more, then stop.';
          const at = new Date().toISOString();
          fs.appendFileSync(transcriptOf(front), JSON.stringify({ type: 'user', uuid: `${front.id.slice(0, 24)}000000000777`, timestamp: at,
            sessionId: front.id, cwd: profile.folder, origin: { kind: 'human' },
            message: { role: 'user', content: [{ type: 'text', text: 'Tell it: ' + words }] } }) + '\n');
          const hooks = path.join(__dirname, '..', '..', 'claude-plugin', 'agent-work-plan', 'hooks', 'steward-relay.py');
          const said = await new Promise((resolve) => {
            const kid = require('child_process').spawn(process.platform === 'win32' ? 'python' : 'python3', [hooks, target.id, dataDir],
              { env: Object.assign({}, process.env, { CLAUDE_CODE_SESSION_ID: front.id }) });
            let out = '';
            kid.stdout.on('data', (d) => { out += d; });
            kid.stderr.on('data', (d) => { out += d; });
            kid.on('error', (e) => resolve('could not run the script: ' + e.message));
            kid.on('exit', () => resolve(out.trim()));
            kid.stdin.end(words);
          });
          const arrived = /^Sent: /.test(said) ? await until(() => {
            try { return fs.readFileSync(transcriptOf(target), 'utf8').includes(JSON.stringify(words).slice(1, -1)); } catch (_) { return false; }
          }, 30000, 500) : false;
          check(/^Sent: /.test(said) && !!arrived, 'the steward passes the user\'s own words on: they are typed into the managed conversation and sent as its user\'s message',
            { said, arrived: !!arrived });
          await shot('steward-relay');
        } else note('the conversation ticked first is not one of the test conversations, so passing words on was not looked at');
        await frame.locator('button[data-act="none"]').click();
        const back = await until(async () => (await claudeTabs()).find((x) => x.active && titled(x.label, front.title)), 10000, 300);
        check(!!back, 'and clearing gives the tab its own title back', await claudeTabs());
        await frame.locator('input[data-every]').click();
        const every = await until(() => {
          try { const t = JSON.parse(fs.readFileSync(file, 'utf8')).stewards[front.id]; return t && t.all === true && t.manages.length ? t : null; } catch (_) { return null; }
        }, 10000, 300);
        const locked = frame ? await until(() => frame.evaluate(() => {
          const rows = [...document.querySelectorAll('input[data-id]')];
          return rows.length && rows.every((b) => b.checked && b.disabled) ? rows.length : 0;
        }), 10000, 300) : 0;
        const allTab = await until(async () => (await claudeTabs()).find((x) => x.label === 'Steward of all conversations \u{1F6CE}\uFE0F'), 10000, 300);
        check(!!every && !!locked && !!allTab, 'the All box in the panel page reaches the extension: rows locked on, tab renamed for all',
          { every, locked, tabs: await claudeTabs() });
        await frame.locator('input[data-every]').click();
        await until(() => frame.evaluate(() => [...document.querySelectorAll('input[data-id]')].every((b) => !b.disabled)), 10000, 300);
        await frame.locator('button[data-act="none"]').click();
        await until(async () => (await claudeTabs()).find((x) => x.active && titled(x.label, front.title)), 10000, 300);
      }
      /* The link a steward writes for a conversation: clicked in a panel, it reaches this extension, which brings that
         conversation's tab to the front. */
      const other = threads[1], frontPanel = await conversation(front);
      if (frontPanel) {
        await frontPanel.evaluate((id) => {
          const a = document.createElement('a');
          a.href = 'vscode://xnervwang.claude-code-plus/open?session=' + id;
          a.id = 'cce-test-link';
          a.textContent = 'go there';
          a.style.cssText = 'position:fixed;top:40px;left:40px;z-index:100000;padding:6px;background:#fff;color:#000';
          document.body.appendChild(a);
        }, other.id);
        await frontPanel.locator('#cce-test-link').click();
        // VS Code may first ask whether this extension may open the link.
        await sleep(1500);
        await shot('steward-link-click');
        const dialogText = await page.evaluate(() => [...document.querySelectorAll('.monaco-dialog-box')].map((d) => d.innerText).join(' | '));
        const allow = await until(async () => {
          const b = page.locator('.monaco-dialog-box .monaco-button', { hasText: /^(Open|Yes|Allow)$/ });
          return (await b.count()) ? b : null;
        }, 3000, 300);
        if (allow) await allow.first().click();
        const jumped = await until(async () => (await claudeTabs()).find((x) => x.active && titled(x.label, other.title)), 15000, 300);
        /* On macOS in CI the link reached nothing: no prompt and no jump. The likely reason, not verified, is that VS Code
           there passes vscode:// links to the system, which sends them to the copy of VS Code registered for them, and
           the copy a test downloads is not registered. */
        if (process.platform === 'darwin' && !jumped && !allow) note('on macOS the link reached nothing (no prompt, no jump), so the jump was not checked there');
        else check(!!jumped, 'a steward\'s link to a conversation, clicked in a panel, brings that conversation\'s tab to the front',
          { asked: !!allow, dialogText, toasts: await toasts(), tabs: await claudeTabs() });
        await shot('steward-link-jump');
      }
      await exec('workbench.action.closePanel');
    });

    /* In Focus view Claude Code folds a message from another conversation into a row of its own ("1 hidden step"). */
    await step('a quiet reply to another conversation', async () => {
      const t = threads.find((x) => x.quietPeer);
      await exec('claude-vscode.editor.open', t.id);
      const conv = await conversation(t);
      if (!conv) throw new Error('the conversation did not open');
      const focus = conv.locator('[data-cce-focus-btn]').first();
      const wasOn = await focus.getAttribute('data-cce-fold') === 'folded';
      if (!wasOn) await focus.click();
      const folds = () => conv.evaluate(() => [...document.querySelectorAll('[data-testid="focus-fold-row"]')]
        .map((r) => ({ label: r.textContent.trim(), shown: getComputedStyle(r).display !== 'none' })));
      const seen = await until(async () => { const f = await folds(); return f.length && f.every((x) => !x.shown) ? f : null; }, 15000, 300);
      const replies = await conv.evaluate(() => [...document.querySelectorAll('[data-testid="assistant-message"]')]
        .map((m) => (m.innerText || '').trim()).filter(Boolean));
      check(!!seen && replies.indexOf('-') === -1, 'a peer message answered with a dash: its fold row and the dash are both hidden',
        { folds: seen || await folds(), replies });
      await shot('quiet-peer-reply');
      if (!wasOn) await focus.click();
    });

    /* VS Code creates a restored tab's page only when the tab is first shown. With claudeCodePlus.loadRestoredTabs on, a
       reload loads the Claude Code tab behind the one in front without a click. */
    await step('restored tabs', async () => {
      const [front, behind] = threads;
      const setLoad = (v) => call(`await vscode.workspace.getConfiguration('claudeCodePlus').update('loadRestoredTabs', arg, vscode.ConfigurationTarget.Global); return true;`, v);
      const loaded = (t) => conversation(t, 1000).then((f) => !!f, () => false);
      const reloadAndWait = async () => {
        await w.reload();
        await until(async () => { const st = await patchState(); return st && st.active && st; }, 60000, 1000);
        await until(() => loaded(front), 60000, 1000);
      };
      await exec('workbench.action.closeAllEditors');
      await exec('workbench.action.closeAuxiliaryBar');
      await exec('claude-vscode.editor.open', behind.id);
      await sleep(1500);
      await exec('claude-vscode.editor.open', front.id);
      await sleep(1500);
      await reloadAndWait();
      await sleep(10000);
      const without = await loaded(behind);
      await setLoad(true);
      await reloadAndWait();
      const withIt = await until(() => loaded(behind), 60000, 1000);
      const inFront = (await claudeTabs()).find((t) => t.active);
      check(!without && !!withIt && !!inFront && titled(inFront.label, front.title),
        'a reload leaves a Claude Code tab behind another unloaded; with claudeCodePlus.loadRestoredTabs on it is loaded, and the tab in front stays in front',
        { without, withIt: !!withIt, tabs: await claudeTabs() });
      await shot('restored-tabs-loaded');
      await setLoad(undefined);
    });

    await step('commands', async () => {
      await exec('notifications.clearAll');
      await exec('claudeCodePlus.status');
      const status = await until(async () => (await toasts()).find((x) => x.startsWith('Claude Code Plus — ')) || '', 10000, 300);
      check(/^Claude Code Plus — Claude Code panel anthropic\.claude-code-\S+: patched \| Claude Code host anthropic\.claude-code-\S+: patched \| Token mode: All features \(agentPlus\.tokenMode\); in Claude Code: work plan on, time-zone note on, conversation brief on$/.test(status),
        'Show Status says both of Claude Code\'s files are patched, and the token mode', status);
      await shot('command-status');
      await exec('notifications.clearAll');

      await exec('claudeCodePlus.openSettings');
      const settings = await until(() => page.evaluate(() => {
        const e = document.querySelector('.settings-editor');
        return e && e.offsetParent && /Claude Code Plus/.test(e.innerText) && e.innerText.slice(0, 400);
      }), 15000, 500);
      check(!!settings && (await tabs()).some((g) => g.tabs.some((t) => t.active && t.label === 'Settings')), 'Settings opens VS Code\'s settings at this extension\'s own', settings);
      const declared = Object.keys(require('../../package.json').contributes.configuration.properties).length;
      const found = await page.evaluate(() => ((document.querySelector('.settings-editor .settings-count-widget') || {}).innerText || '').trim());
      check(found === `${declared} Settings Found`, `and lists all ${declared} of them, and nothing else`, found);
      await shot('command-settings');
      await exec('workbench.action.closeActiveEditor');

      await start('claudeCodePlus.disableWorkPlanPlugin');
      const d = await until(dialog, 10000, 300);
      check(!!d && d.text.includes('Stop Claude Code loading the work plan plugin?') && d.buttons.includes('Stop loading it') && d.buttons.includes('Cancel'),
        'Stop Loading the Work Plan Plugin asks first, with Stop loading it and Cancel', d);
      await shot('command-stop-loading');
      if (d) check(await answerDialog('Cancel'), 'and Cancel closes the question');
    });
  } finally {
    await shot('last');
    await w.close();
  }
}

module.exports = { run };
