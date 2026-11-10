// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/host/core-link.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * Registering an extension's conversation source with Agent Plus (xnervwang.agent-plus), which draws the work plan,
 * Conversations and Answer views; its docs/protocol.md is the contract.
 *
 * Agent Plus is in extensionDependencies, so VS Code activates it before the extension and its exports are there at
 * once. When the protocol majors do not match, Agent Plus itself tells the user which extension to update; the caller
 * says something only when there is no interface to register with at all, once per reason.
 */
const CORE_ID = 'xnervwang.agent-plus';

const message = (e) => String((e && e.message) || e);

/** The agentPlus interface, or null with the reason. */
async function findCore(vscode) {
  const ext = vscode.extensions.getExtension(CORE_ID);
  if (!ext) return { core: null, why: 'Agent Plus is not installed or not enabled' };
  let api;
  try { api = ext.isActive ? ext.exports : await ext.activate(); } catch (e) { return { core: null, why: `Agent Plus did not start: ${message(e)}` }; }
  const core = api && api.agentPlus;
  if (!core || typeof core.registerSource !== 'function') return { core: null, why: 'Agent Plus has no agentPlus interface' };
  return { core, why: '' };
}

/** Whether the host offers an optional capability by name (protocol, "Adding to the protocol"). */
const coreHas = (core, name) => !!(core && Array.isArray(core.features) && core.features.includes(name));

/*
 * Registers `source`. Resolves to { registered, registration, code, reason, core }. `contextKey`, when given, is set to
 * true when the source is registered and to false otherwise. With `memento`, `toldKey` and `tell`, a missing interface
 * is reported once per reason: `tell(why)` shows the notice and the memento records it under `toldKey`.
 */
async function link(vscode, source, { name = 'the source', log = () => {}, contextKey = '', memento = null, toldKey = '', tell = null } = {}) {
  const setKey = (on) => (contextKey ? Promise.resolve(vscode.commands.executeCommand('setContext', contextKey, on)).catch(() => {}) : Promise.resolve());
  const { core, why } = await findCore(vscode);
  if (!core) {
    log(`not registered with Agent Plus: ${why}`);
    await setKey(false);
    const key = `${toldKey}:${why}`;
    if (memento && tell && toldKey && !memento.get(key)) {
      await memento.update(key, true);
      try { tell(why); } catch (e) { log(`telling about Agent Plus failed: ${message(e)}`); }
    }
    return { registered: false, registration: null, code: 'no-core', reason: why, core: null };
  }
  let r;
  try { r = core.registerSource(source); } catch (e) { r = { accepted: false, code: 'failed', reason: message(e) }; }
  if (r && r.accepted === true && r.registration && typeof r.registration.dispose === 'function') {
    await setKey(true);
    return { registered: true, registration: r.registration, code: '', reason: '', core };
  }
  const code = (r && r.code) || 'failed', reason = (r && r.reason) || 'no reason given';
  log(`Agent Plus did not take ${name} (${code}): ${reason}`);
  await setKey(false);
  return { registered: false, registration: null, code, reason, core };
}

/*
 * deliverAnswer wrapped so that one delivery id is typed once (protocol, Answers): a call with an id that was already
 * asked gets the promise of the first call, even while that one is still running. If the delivery returns notReceived,
 * the id is forgotten so that a retry can type it.
 */
function oncePerDelivery(deliver) {
  const asked = new Map();
  return (sessionId, text, opts) => {
    const id = opts && typeof opts.deliveryId === 'string' ? opts.deliveryId : '';
    if (!id) return Promise.resolve().then(() => deliver(sessionId, text, opts));
    if (asked.has(id)) return asked.get(id);
    const p = Promise.resolve().then(() => deliver(sessionId, text, opts));
    asked.set(id, p);
    const forget = () => { if (asked.get(id) === p) asked.delete(id); };
    p.then((r) => { if (!r || r.outcome === 'notReceived') forget(); }, forget);
    return p;
  };
}

module.exports = { CORE_ID, findCore, coreHas, link, oncePerDelivery };
