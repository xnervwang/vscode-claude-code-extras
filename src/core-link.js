// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Registering Claude Code's conversation source (src/claude-source.js) with Agent Work Plan (xnervwang.agent-work-plan),
 * which draws the work plan, Conversations and Answer views; its docs/protocol.md is the contract.
 *
 * Agent Work Plan is in extensionDependencies, so VS Code activates it before this extension and its exports are there
 * at once. When it does not take the source, one line is logged and nothing is shown: when the protocol majors differ,
 * Agent Work Plan itself tells the user which extension to update, since it knows its own versions and the gallery's.
 */
const CORE_ID = 'xnervwang.agent-work-plan';

const message = (e) => String((e && e.message) || e);

/* Resolves to the registration (a Disposable), or null with the reason logged. */
async function register(vscode, source, log = () => {}) {
  const ext = vscode.extensions.getExtension(CORE_ID);
  if (!ext) { log('not registered with Agent Work Plan: it is not installed or not enabled'); return null; }
  let api;
  try { api = ext.isActive ? ext.exports : await ext.activate(); } catch (e) {
    log(`not registered with Agent Work Plan: it did not start: ${message(e)}`);
    return null;
  }
  const core = api && api.agentWorkPlan;
  if (!core || typeof core.registerSource !== 'function') { log('not registered with Agent Work Plan: it has no agentWorkPlan interface'); return null; }
  let r;
  try { r = core.registerSource(source); } catch (e) { r = { accepted: false, code: 'failed', reason: message(e) }; }
  if (r && r.accepted === true && r.registration && typeof r.registration.dispose === 'function') {
    log(`registered with Agent Work Plan ${core.version || ''}`.trim());
    return r.registration;
  }
  log(`Agent Work Plan did not take the Claude Code source (${(r && r.code) || 'failed'}): ${(r && r.reason) || 'no reason given'}`);
  return null;
}

module.exports = { CORE_ID, register };
