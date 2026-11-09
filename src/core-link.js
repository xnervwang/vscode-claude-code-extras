// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Registering Claude Code's conversation source (src/claude-source.js) with Agent Plus (xnervwang.agent-plus);
 * its docs/protocol.md is the contract.
 *
 * Agent Plus is in extensionDependencies, so VS Code activates it before this extension and its exports are there
 * at once. A refusal is only logged: when the protocol majors differ, Agent Plus itself tells the user which
 * extension to update.
 */
const CORE_ID = 'xnervwang.agent-plus';

const message = (e) => String((e && e.message) || e);

/* Resolves to the registration (a Disposable), or null with the reason logged. */
async function register(vscode, source, log = () => {}) {
  const ext = vscode.extensions.getExtension(CORE_ID);
  if (!ext) { log('not registered with Agent Plus: it is not installed or not enabled'); return null; }
  let api;
  try { api = ext.isActive ? ext.exports : await ext.activate(); } catch (e) {
    log(`not registered with Agent Plus: it did not start: ${message(e)}`);
    return null;
  }
  const core = api && api.agentPlus;
  if (!core || typeof core.registerSource !== 'function') { log('not registered with Agent Plus: it has no agentPlus interface'); return null; }
  let r;
  try { r = core.registerSource(source); } catch (e) { r = { accepted: false, code: 'failed', reason: message(e) }; }
  if (r && r.accepted === true && r.registration && typeof r.registration.dispose === 'function') {
    log(`registered with Agent Plus ${core.version || ''}`.trim());
    return r.registration;
  }
  log(`Agent Plus did not take the Claude Code source (${(r && r.code) || 'failed'}): ${(r && r.reason) || 'no reason given'}`);
  return null;
}

module.exports = { CORE_ID, register };
