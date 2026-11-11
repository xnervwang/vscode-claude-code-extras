// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus src/token-mode.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * The token mode, agentPlus.tokenMode: one setting in Agent Plus that decides which of the features that add text to an
 * agent's context run, in Claude Code Plus and Codex Plus alike. Each extension reads such a feature through effective()
 * below, so the table of what each mode turns on is written once. Agent Plus's package.json repeats the labels and the
 * descriptions for the Settings editor, and its tests check that the two agree.
 *
 * No mode writes a feature's own setting. In Custom each feature follows it; in the other modes the table decides, and
 * the setting keeps its value for when the mode is Custom again.
 */
const SECTION = 'agentPlus';
const NAME = 'tokenMode';
const SETTING = `${SECTION}.${NAME}`;
const DEFAULT_MODE = 'all';
const CUSTOM = 'custom';

/* In the order they are shown. `note` and `detail` are what the status bar's list shows beside and under each name;
   `detail` is also the setting's enumDescription. */
const MODES = Object.freeze([
  { id: 'interface', label: 'Interface features', short: 'Interface', note: 'no tokens',
    detail: 'Adds nothing to the agent\'s context, and unloads the work plan plugin.' },
  { id: 'essential', label: 'Essential features', short: 'Essential', note: '',
    detail: 'Adds the work plan and the time-zone note, nothing else.' },
  { id: 'all', label: 'All features', short: 'All', note: 'default',
    detail: 'Adds every feature, including the brief, skill suggestions and wake-ups.' },
  { id: CUSTOM, label: 'Custom', short: 'Custom', note: '',
    detail: 'Each feature follows its own setting; all are on until you turn one off.' },
].map((m) => Object.freeze(m)));

/* The features that add to an agent's context, and the modes other than Custom that turn each one on. */
const FEATURES = Object.freeze([
  { id: 'workPlan', name: 'work plan', modes: ['essential', 'all'] },
  { id: 'timeZone', name: 'time-zone note', modes: ['essential', 'all'] },
  { id: 'conversationBrief', name: 'conversation brief', modes: ['all'] },
  { id: 'skillRouting', name: 'skill suggestions', modes: ['all'] },
  { id: 'wakeUps', name: 'wake-ups', modes: ['all'] },
].map((f) => Object.freeze(f)));

/* Each extension's own setting for each of those features. Agent Plus reads this list to carry an earlier install's
   choices over, so a setting added to a feature extension is added here too. */
const SWITCHES = Object.freeze([
  { key: 'claudeCodePlus.workPlan', feature: 'workPlan', extension: 'xnervwang.claude-code-plus', default: true },
  { key: 'claudeCodePlus.tellClaudeYourTimeZone', feature: 'timeZone', extension: 'xnervwang.claude-code-plus', default: true },
  { key: 'claudeCodePlus.conversationBrief', feature: 'conversationBrief', extension: 'xnervwang.claude-code-plus', default: true },
  { key: 'codexPlus.workPlan', feature: 'workPlan', extension: 'xnervwang.codex-plus', default: true },
  { key: 'codexPlus.tellCodexYourTimeZone', feature: 'timeZone', extension: 'xnervwang.codex-plus', default: true },
  { key: 'codexPlus.conversationBrief', feature: 'conversationBrief', extension: 'xnervwang.codex-plus', default: true },
  { key: 'codexPlus.skillRouting', feature: 'skillRouting', extension: 'xnervwang.codex-plus', default: true },
  { key: 'codexPlus.wakeUps', feature: 'wakeUps', extension: 'xnervwang.codex-plus', default: true },
].map((s) => Object.freeze(s)));

/* The sentence each of those settings ends its description with. */
const ONLY_IN_CUSTOM = 'Used only while `#agentPlus.tokenMode#` is Custom.';
const SWITCH_BUTTON = 'Switch to Custom';

const split = (key) => { const i = key.indexOf('.'); return [key.slice(0, i), key.slice(i + 1)]; };
function read(vscode, key, fallback) {
  const [section, name] = split(key);
  try { return vscode.workspace.getConfiguration(section).get(name, fallback); } catch (_) { return fallback; }
}

const modeById = (id) => MODES.find((m) => m.id === id) || null;
/* A value no mode has, which only a hand edit of settings.json can give, counts as the default. */
const modeOf = (value) => (modeById(value) ? value : DEFAULT_MODE);
const modeNow = (vscode) => modeOf(read(vscode, SETTING, DEFAULT_MODE));
const labelOf = (mode) => (modeById(modeOf(mode)) || {}).label;
const switchOf = (key) => SWITCHES.find((s) => s.key === key) || null;
const featureOf = (id) => FEATURES.find((f) => f.id === id) || null;

/* Whether `mode` turns on feature `id`: true or false, or null in Custom, where the feature's own setting decides. */
function onIn(mode, id) {
  const m = modeOf(mode);
  if (m === CUSTOM) return null;
  const f = featureOf(id);
  return !!f && f.modes.includes(m);
}

/* Whether the feature behind setting `key` runs now. A key not in SWITCHES is not the mode's to decide, and reads as
   set. */
function effective(vscode, key) {
  const s = switchOf(key);
  if (!s) return read(vscode, key, undefined);
  const by = onIn(modeNow(vscode), s.feature);
  if (by !== null) return by;
  const v = read(vscode, key, s.default);
  return v === undefined ? s.default : !!v;
}

/* In Interface features the work plan plugin is taken out of the agent, not only silenced. */
const unloadsPlugin = (mode) => modeOf(mode) === 'interface';

/* Says, once per setting and window, that a change to one of `keys` has no effect in the current mode, with a Switch to
   Custom button. `who` is the extension's name, put first in the message. */
function warnOutsideCustom(vscode, keys, { who = '', log = () => {} } = {}) {
  const told = new Set();
  return vscode.workspace.onDidChangeConfiguration((e) => {
    const mode = modeNow(vscode);
    if (mode === CUSTOM) return;
    for (const key of keys) {
      if (told.has(key) || !e.affectsConfiguration(key)) continue;
      told.add(key);
      const text = `${who ? `${who}: ` : ''}the token mode is ${labelOf(mode)}, so ${key} has no effect until the mode is Custom.`;
      Promise.resolve(vscode.window.showInformationMessage(text, SWITCH_BUTTON)).then((pick) => {
        if (pick !== SWITCH_BUTTON) return undefined;
        return vscode.workspace.getConfiguration(SECTION).update(NAME, CUSTOM, vscode.ConfigurationTarget.Global);
      }).catch((err) => log(`switching the token mode to Custom: ${(err && err.message) || err}`));
    }
  });
}

module.exports = { SECTION, NAME, SETTING, DEFAULT_MODE, CUSTOM, MODES, FEATURES, SWITCHES, ONLY_IN_CUSTOM, SWITCH_BUTTON,
  modeOf, modeNow, modeById, labelOf, switchOf, featureOf, onIn, effective, unloadsPlugin, warnOutsideCustom };
