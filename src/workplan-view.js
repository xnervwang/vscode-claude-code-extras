// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The work plan as a native VS Code tree view.
 *
 * Native rather than a webview of our own making, because everything a tree needs - collapsing, icons, keyboard
 * navigation, hover, the platform's own look in either theme - already exists here and would otherwise be rewritten in
 * HTML. The cost is that the data has to arrive as nodes rather than as markup, which is also what makes it checkable.
 *
 * The view owns nothing on disk. It reads (see src/workplan.js) and offers the file for editing, which is what lets the
 * plan be corrected by hand: the file is the single copy both halves look at, so a correction cannot diverge from what
 * the conversation reads back.
 */
const vscode = require('vscode');
const { readPlan, openFirst, OPEN_STATES } = require('./workplan');
const { keyPart } = require('./sources');

/*
 * `clockface` is in the editor's icon font from VS Code 1.111 on. An older editor, or a fork built on one, draws nothing
 * at all for a name it does not have, so there the watch stands in: a weaker shape, but a shape. A version that cannot
 * be read gets the watch too.
 */
function waitingIcon(version) {
  const have = String(version || '').split(/[.-]/).slice(0, 2).map(Number);
  if (have.length < 2 || have.some((n) => !Number.isFinite(n))) return 'watch';
  return have[0] > 1 || (have[0] === 1 && have[1] >= 111) ? 'clockface' : 'watch';
}

/*
 * Icons say the state, and they are told apart by shape rather than by colour: colour alone disappears for a reader who
 * cannot separate these hues, and the panel is read in both light and dark themes.
 */
const LOOK = {
  discussing: { icon: 'comment-discussion', color: 'charts.yellow', word: 'discussing' },
  /* Purple, which is the slot left once every other meaning is taken. Blue is the row being worked on, green is finished,
     yellow is a row still being talked over, orange is a row held up by somebody, and grey is the two that are not going
     to happen - and an agreed row that has simply not started belongs to none of those. Orange would be wrong here: it
     is a warning in this palette and most others, a queue is not a problem, and `todo` is usually the state with the
     most rows in it, so the tree would light up in the colour meant for trouble and drown the rows that want attention. */
  todo: { icon: 'circle-large-outline', color: 'charts.purple', word: 'to do' },
  /* A filled triangle in blue. Nothing else here is a triangle, so it reads as its own thing at sixteen pixels, and it
     is the shape everything else uses for running. */
  doing: { icon: 'debug-start', color: 'charts.blue', word: 'doing' },
  /* Started, and now held up by someone outside the conversation - the user, another team, a job running elsewhere.
     A clock face in orange. The shape says time is passing, which is the whole of what this state means; the watch it
     replaced was a rounded box at sixteen pixels and said nothing. Orange because there are few of these rows and each
     one wants a look, and because sharing yellow with `discussing` left the colour unable to tell them apart. It is its
     own state because `doing` was being used for it: four of the six rows `doing` on the machine this was written on
     said in their notes that they were waiting, and a tree that shows those as being worked on gets wrong the one thing
     it is watched for. */
  waiting: { icon: waitingIcon(vscode.version), color: 'charts.orange', word: 'waiting' },
  parked: { icon: 'debug-pause', color: 'descriptionForeground', word: 'parked' },
  done: { icon: 'pass-filled', color: 'charts.green', word: 'done' },
  dropped: { icon: 'circle-slash', color: 'descriptionForeground', word: 'dropped' },
};
const unknownLook = (state) => ({ icon: 'question', color: 'descriptionForeground', word: String(state || '') });
/* hasOwnProperty, so a state named toString or __proto__ is unknown rather than an Object.prototype member. */
const lookOf = (state) => (Object.prototype.hasOwnProperty.call(LOOK, state) ? LOOK[state] : unknownLook(state));

/*
 * How long a row has been in a state it is meant to leave soon, or nothing.
 *
 * Only `doing` and `waiting`, and only from `since`, which the plugin's row command writes on every change of state. A
 * row `doing` for three days is not being done, and the time is the one thing on the row that can say so. The steps are
 * the same as the injected block's (age() in inject-work-plan.py), so the tree and the model read the same figure.
 */
const TIMED = ['doing', 'waiting'];
function held(node, now = Date.now()) {
  if (!node || !TIMED.includes(node.state)) return '';
  return ageSince(node.since, now);
}
/* The age of `since` in those steps, or '' when it is not known or is in the future. */
function ageSince(since, now = Date.now()) {
  if (!since || now < since) return '';
  const s = Math.floor((now - since) / 1000);
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm';
  if (s < 48 * 3600) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

/*
 * Who a held-up row waits on, in the words the tooltip and the dialog use. A `waiting` row written before the field
 * existed says it only in its note. The view shows it as unknown and does not read the note: the list of what waits on
 * the reader is built from the field, so a guess here would disagree with that list.
 */
const WHO = { user: 'you', build: 'a build or CI', someone: 'someone else', session: 'another conversation',
  other: 'something else' };
function waitsOn(node) {
  if (node && WHO[node.waitingOn]) return { known: true, words: 'on ' + WHO[node.waitingOn] };
  return node && node.state === 'waiting' ? { known: false, words: 'on: unknown' } : null;
}

/* Every such figure in a tree, in file order. Part of what decides whether the tree is redrawn, since the figure goes
   stale with nothing in the file changing. */
function heldAll(nodes, now = Date.now(), out = []) {
  for (const n of nodes || []) {
    out.push(held(n, now));
    heldAll(n.children, now, out);
  }
  return out;
}

const p2 = (n) => (n < 10 ? '0' : '') + n;

/*
 * A moment's calendar fields in the reader's time zone.
 *
 * This file runs in the extension host, which in a remote window is on the remote machine, so its own clock is in that
 * machine's zone while the conversation beside the tree is drawn in the reader's. The panel reports the reader's zone
 * (src/panel-tz.js); until it has, or when the name is not one this runtime knows, the host's own zone is used.
 */
const ZONES = new Map();
function zoned(timeZone) {
  if (!timeZone) return null;
  if (!ZONES.has(timeZone)) {
    let f = null;
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    } catch (_) { f = null; }
    ZONES.set(timeZone, f);
  }
  return ZONES.get(timeZone);
}
function fields(ms, timeZone) {
  const f = zoned(timeZone);
  if (!f) {
    const d = new Date(ms);
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  }
  const out = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { y: out.year, mo: out.month, d: out.day, h: out.hour % 24, mi: out.minute };
}

/*
 * When a row was opened, and for a closed one the range up to when it ended.
 *
 * The shape follows the session list this extension already draws in the panel: month before day, an arrow between the
 * ends of a range, and the year written only when it is not the current one. A second convention for the same kind of
 * value would be read as a different kind of value.
 *
 * Minutes rather than the date alone, because a day's worth of rows all carrying one date says nothing about their
 * order - which is the only reason the time is on the row at all. For the same reason the date is not repeated on the
 * far end of a range that begins and ends on one day; the clock is the part that distinguishes them.
 */
function stamp(opened, closed, timeZone = '', now = Date.now()) {
  if (!opened && !closed) return '';
  const thisYear = fields(now, timeZone).y;
  const part = (ms, withDate) => {
    const t = fields(ms, timeZone);
    const clock = p2(t.h) + ':' + p2(t.mi);
    if (!withDate) return clock;
    const md = p2(t.mo) + '/' + p2(t.d);
    return (t.y === thisYear ? md : t.y + '/' + md) + ' ' + clock;
  };
  if (!closed) return part(opened, true);
  if (!opened) return part(closed, true);
  const a = fields(opened, timeZone), b = fields(closed, timeZone);
  const sameDay = a.y === b.y && a.mo === b.mo && a.d === b.d;
  return part(opened, true) + ' → ' + part(closed, !sameDay);
}

/** Whether anything under here still needs doing, which is what decides if a branch opens by itself. */
function hasOpen(node) {
  if (OPEN_STATES.includes(node.state)) return true;
  return (node.children || []).some(hasOpen);
}

class WorkPlanProvider {
  constructor({ read } = {}) {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.read = typeof read === 'function' ? read : (session) => readPlan(session);
    /* The plan shown, or null. */
    this.plan = null;
    this.signature = '';
    /* The session id of the conversation whose plan is shown. Empty when no source has reported one (no conversation
       open yet, or a Claude Code build this extension could not patch); the view then shows its welcome text. */
    this.focus = '';
    this.source = '';
    this.scoped = false;
    /* The reader's time zone as the panel reports it, or empty for the host's own. */
    this.timeZone = '';
    /* What went wrong installing the plugin that writes the plans, if anything. It is shown as a row rather than in the
       view's welcome text because the welcome text is fixed in the manifest and cannot carry what a command said - and
       a failure that cannot say what failed leaves the reader nothing to act on. */
    this.problem = null;
  }

  /** The plan the view is drawing, or null. The badge counts its open rows. */
  shown() {
    return this.plan;
  }

  /* Records which conversation to read and says whether that moved; reading and redrawing is refresh()'s job. Doing both
     here made every caller read the file twice, since each one has to call refresh() anyway for the case where the
     conversation stayed put and its plan changed underneath. */
  setFocus(session, source = '') {
    const next = String(session || ''), from = String(source || '');
    if (next === this.focus && from === this.source) return false;
    this.focus = next;
    this.source = from;
    return true;
  }

  setScoped(on) {
    const next = !!on;
    if (next === this.scoped) return false;
    this.scoped = next;
    return true;
  }

  /* Records the zone the rows' times are written in and says whether it moved; refresh() redraws. */
  setTimeZone(zone) {
    const next = typeof zone === 'string' ? zone : '';
    if (next === this.timeZone) return false;
    this.timeZone = next;
    return true;
  }

  setProblem(problem) {
    const before = JSON.stringify(this.problem || null);
    this.problem = problem || null;
    if (JSON.stringify(this.problem) !== before) this._emitter.fire();
  }

  /*
   * Only announces a change when the content actually differs. Announcing one unconditionally on a timer is what makes
   * a tree fold itself back up while it is being read: the view re-asks for its children, and expansion is remembered
   * per item id rather than per item object.
   */
  refresh() {
    /* The conversation in front of the reader, or nothing. Anything else - no conversation open, or none reported yet -
       shows an empty tree, where the view's welcome text explains itself. Reading the whole directory here is what once
       drew every conversation on the machine into a window that had simply not been told which one it was looking at;
       a view whose only claim is "what THIS conversation has to do" has no business showing other people's leftovers. */
    const plan = this.focus ? this.read(this.focus, this.source) : null;
    /* The focus is part of the signature because two conversations can hold identical plans - most often two empty ones.
       Comparing only the content would then find no change and leave the previous conversation's tree on screen. Its
       agent and file are part of it for the same reason across agents, where two conversations can share an id. The
       time a row has been `doing` or `waiting` is part of it for the opposite reason: the figure changes while the file
       does not, and the periodic refresh is the only thing that will ever redraw it. Its steps are minutes at the finest,
       so this redraws at most once a minute. The time zone is part of it for the same reason: every row's time changes
       when the panel reports the reader's zone, and the file does not. */
    const now = Date.now();
    const signature = JSON.stringify([this.source, this.focus, this.scoped, this.timeZone,
      plan && [plan.session, plan.file, plan.title, plan.error, plan.nodes, heldAll(plan.nodes, now)]]);
    if (signature === this.signature) return false;
    this.plan = plan;
    this.signature = signature;
    this._emitter.fire();
    return true;
  }

  /* The conversation's own rows at the top level, with no heading above them: the first row is a task. */
  getChildren(element) {
    if (!element) {
      const first = this.problem ? [{ kind: 'problem', key: '!plugin' }] : [];
      return this.plan ? first.concat(this.rowsFor(this.plan)) : first;
    }
    if (element.kind === 'node') {
      return this.rowsOf(element.node.children, element.plan, element.key,
        element.path.concat(element.node.title), element.num);
    }
    return [];
  }

  rowsFor(plan) {
    /* With several sources two plans can share a session id and row titles, so the id root includes the source. */
    const root = this.scoped ? keyPart(this.source) + '/' + keyPart(plan.session) : plan.session;
    if (plan.error) return [{ kind: 'error', plan, key: root + '/!' }];
    return this.rowsOf(plan.nodes, plan, root, []);
  }

  /*
   * Each row carries a stable id, which is the only thing the view has to remember which branches were open. The index
   * is part of it because two siblings may legitimately share a title, and an id that repeats collapses both.
   *
   * The path is the titles above this row. A row shows only its own title, so for anything nested it is the one piece
   * of context the row cannot carry itself - which is what makes the dialog worth opening even where there is no
   * description to read.
   */
  rowsOf(nodes, plan, parentKey, path, prefix = '') {
    /* Numbered by where the row sits in the file rather than by where it is drawn. The number is part of the id, the id
       is all the view has to remember which branches were open, and the drawn order changes the moment a row closes - so
       numbering by position on screen would hand a row a new id for having been reordered, and the tree would fold
       itself up as work got done. */
    /* The number shown in front of a row comes from its place in the file, like the id above and for the same reason: it
       is what someone says out loud to point at a row, so it must not change because the row moved on screen or because
       another one closed. Numbering the display order would renumber half the tree every time something got done. */
    const rows = (nodes || []).map((n, i) => ({
      kind: 'node', node: n, plan, path, key: parentKey + '/' + i + ':' + n.title,
      num: (prefix ? prefix + '.' : '') + (i + 1),
    }));
    return openFirst(rows, (r) => r.node.state);
  }

  getTreeItem(element) {
    if (element.kind === 'problem') {
      const item = new vscode.TreeItem(this.problem.title || 'The plugin that writes work plans is not installed');
      item.id = element.key;
      item.description = this.problem.description || 'click to try again';
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
      item.tooltip = new vscode.MarkdownString(
        `\`${this.problem.step}\` failed.\n\n${this.problem.said || 'It gave no reason.'}\n\n`
        + 'Until this succeeds nothing writes a work plan, so this view stays empty.');
      item.command = { command: this.problem.command || 'claudeCodeWorkPlan.installWorkPlanPlugin', title: 'Try again' };
      return item;
    }
    if (element.kind === 'error') {
      const item = new vscode.TreeItem('This work plan could not be read');
      item.id = element.key;
      item.description = 'click to open the file';
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
      item.tooltip = element.plan.file + '\n\n' + element.plan.error;
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(element.plan.file)] };
      return item;
    }
    const node = element.node;
    const look = lookOf(node.state);
    const kids = node.children || [];
    /* The dot is only in the label; element.num stays bare because children are numbered from it. */
    const item = new vscode.TreeItem(`${element.num}. ${node.title}`, kids.length
      ? (hasOpen(node) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None);
    item.id = element.key;
    const times = stamp(node.opened, node.closed, this.timeZone);
    const lasted = held(node);
    const on = waitsOn(node);
    const word = on && on.known
      ? `${look.word}${node.state === 'waiting' ? ' ' : ', '}${on.words}${lasted ? ' for ' + lasted : ''}`
      : look.word + (lasted ? ' for ' + lasted : '') + (on ? ' · ' + on.words : '');
    /*
     * The row carries its time and nothing else beside the title - and, on a row `doing` or `waiting`, how long it has
     * been so, since that is the one fact about such a row that cannot wait for the hover: a stale one looks exactly like
     * a live one otherwise.
     *
     * Not the state, because the icon already says it and a row should not say one thing twice. Not the note either: it
     * is the longest part of a row and the least urgent, so it pushes the title out of a narrow view to say something
     * that can wait for the hover or the dialog, where both already show it.
     *
     * A row with no time therefore shows only its title. That is deliberate rather than a gap - making the note appear
     * just for those rows would give two rows that look alike different behaviour, with nothing on either saying why.
     */
    item.description = [times, lasted ? 'for ' + lasted : ''].filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon(look.icon, new vscode.ThemeColor(look.color));
    item.contextValue = 'cceWorkPlanNode';
    const head = `**${node.title}**\n\n${word}${node.note ? ' — ' + node.note : ''}`
      + (node.question ? '\n\nQuestion: ' + node.question : '') + (times ? '\n\n' + times : '');
    item.tooltip = new vscode.MarkdownString(node.detail ? head + '\n\n' + node.detail : head);
    /*
     * EVERY row opens, including one with no description to show. Binding this only where there is something to read
     * makes two rows that look alike behave differently, with nothing on either saying which is which - and a click
     * that works occasionally reads as broken rather than as economical. A row with nothing further says so, and still
     * carries its state and its place in the plan, which the row itself cannot show.
     *
     * It deliberately does not open the file - clicking a task and being given a page of JSON is not what the click
     * looks like it will do. The file has a button in the title bar and an entry in the row's context menu.
     */
    item.command = {
      command: 'claudeCodeWorkPlan.showWorkPlanDetail',
      title: 'Show the description',
      arguments: [{
        title: node.title, state: word, note: node.note, detail: node.detail, question: node.question,
        path: element.path, children: kids.length, times,
      }],
    };
    return item;
  }
}

module.exports = { WorkPlanProvider, hasOpen, stamp, held, heldAll, ageSince, waitsOn, unknownLook, lookOf, LOOK, TIMED, WHO, waitingIcon };
