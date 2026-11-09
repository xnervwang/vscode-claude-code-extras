// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/**
 * Second patch target: the Claude Code extension host bundle.
 *
 * The host already parses each session's createdAt out of the transcript head, but the object it
 * posts to the webview drops that field, so the session list has no way to show when a session was
 * started. This adapter adds the one field back.
 *
 * Same discipline as the webview patcher: the edit must match exactly once, the result must parse,
 * the untouched original is saved next to the file first, and the replacement is atomic. A build
 * whose shape does not match is left alone with a warning rather than patched on a guess.
 *
 * The host bundle is far riskier to patch than the webview: a broken file means the extension fails
 * to activate. Hence a single, minimal edit and a separate marker and backup, so a failure here
 * cannot disturb the webview patch.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { applyEdits, shapesOf } = require('./edits');

const VERSION = 16;
const ANY_MARK = '/* CLAUDE-CODE-EXTRAS-HOST v';
const BACKUP_SUFFIX = '.claude-code-extras-host.bak';
const TMP_SUFFIX = '.claude-code-extras-host.tmp';

/* The script that reports a panel whose bundle does not arrive (src/panel-load-watch.js says why it has to be in the
   HTML). It goes into the host bundle as a JSON string, so nothing in it is read as template syntax; the one thing that
   could still break out is the end of a script element. */
const LOAD_WATCH = fs.readFileSync(path.join(__dirname, 'panel-load-watch.js'), 'utf8');
if (/<\/script/i.test(LOAD_WATCH)) throw new Error('panel-load-watch.js must not contain a closing script tag');
/* The panel's time zone, sent to the host so the work plan's tree can show the reader's local time
   (src/panel-tz.js says why). Not behind any setting: without it the tree's times are in the remote machine's zone. */
const PANEL_TZ = fs.readFileSync(path.join(__dirname, 'panel-tz.js'), 'utf8');
if (/<\/script/i.test(PANEL_TZ)) throw new Error('panel-tz.js must not contain a closing script tag');
/* Read by the host at the moment a panel's HTML is built, so the setting reaches every panel opened after it changes.
   Unset counts as on: a panel restored before this extension has activated still gets the watch. */
const LOAD_WATCH_OFF = '__cceNoLoadWatch';

const EDITS = [
  {
    name: 'session list transport',
    re: /return\{id:([\w$]+)\.sessionId,archived:/g,
    to: (m, u) => `return{id:${u}.sessionId,createdAt:${u}.createdAt,archived:`,
  },
  /*
   * Which conversation is in front of the reader.
   *
   * Nothing outside this bundle can answer that. Every conversation opens with one view type and one starting title, so
   * the tabs cannot be told apart by kind, and the lock files name a window's folders but no session. The host does
   * know: it keeps the active session in a field of its own. So the field is what this reads, and it reaches this
   * extension through a global the two share - both run in one extension host process.
   *
   * The field's declaration becomes a pair of accessors, which is one edit that catches every write to it. Hooking a
   * single place that happens to use the value would catch one moment out of eleven, and the moment a conversation is
   * switched to need not be that one.
   *
   * The alternative considered and dropped: read the title off the focused tab and match it against a plan. That joins
   * on text written for people to look at, which drifts, collides between conversations and lags behind a rename, and
   * it needs a fallback for each of those. This is an id or nothing.
   */
  {
    name: 'active conversation id',
    re: /;activeSessionId;/g,
    to: () => ';_cceChat;get activeSessionId(){return this._cceChat}'
      + 'set activeSessionId(v){this._cceChat=v;globalThis.__cceActiveChat=v;'
      + 'try{globalThis.__cceChatHook&&globalThis.__cceChatHook(v)}catch(e){}}',
  },
  /*
   * The panel load watch, in the head just ahead of the panel's stylesheet.
   *
   * Anchored on the stylesheet link and the policy before it, which is where the nonce comes from: the panel's policy
   * runs no script without it. Ahead of the stylesheet because a script after one waits for it, and the stylesheet's
   * request is one of those the watch is there to see stuck.
   */
  {
    name: 'panel load watch',
    re: /(script-src 'nonce-\$\{([\w$]+)\}';[\s\S]{0,600}?)(<link href="\$\{[\w$]+\}" rel="stylesheet">)/g,
    to: (m, before, nonce, link) => before
      + '${\'<script nonce="\'+' + nonce + '+\'">\'+' + JSON.stringify(PANEL_TZ) + '+\'</script>\'}'
      + '${globalThis.' + LOAD_WATCH_OFF + '?"":\'<script nonce="\'+' + nonce + '+\'">\'+'
      + JSON.stringify(LOAD_WATCH) + '+\'</script>\'}'
      + link,
  },
  /*
   * Messages from a panel meant for this extension: the panel's time zone, a conversation pinned or unpinned in the
   * session list, a text color chosen for conversations there, archived conversations to delete, whether an answer
   * from the Conversations tab was sent (src/page/91-answer.js), the info box asking for its conversation's
   * process id (src/page/80-session-info.js), and the panel's page getting focus (src/page/92-focus.js).
   *
   * Every message a panel sends passes through the one function that logs it, before anything decides what the message
   * is, and Claude Code itself ignores all of these types. A global is how each reaches this extension - both run in one
   * extension host process, the same way the active conversation does.
   */
  {
    name: 'panel messages',
    re: /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{(let [\w$]+=`Received message from webview: )/g,
    to: (m, fn, log, msg, rest) => `function ${fn}(${log},${msg}){try{if(${msg}&&${msg}.type==="cce_client_tz"`
      + `&&typeof ${msg}.timeZone==="string"){globalThis.__cceClientTimeZone=${msg}.timeZone;`
      + `globalThis.__cceTzHook&&globalThis.__cceTzHook(${msg}.timeZone)}`
      + `else if(${msg}&&${msg}.type==="cce_session_pin"&&typeof ${msg}.sessionId==="string"){`
      + `globalThis.__ccePinHook&&globalThis.__ccePinHook(${msg}.sessionId,${msg}.pinned===true)}`
      + `else if(${msg}&&${msg}.type==="cce_session_color"&&Array.isArray(${msg}.sessionIds)){`
      + `globalThis.__cceColorHook&&globalThis.__cceColorHook(${msg}.sessionIds,typeof ${msg}.color==="string"?${msg}.color:null)}`
      + `else if(${msg}&&${msg}.type==="cce_delete_sessions"&&Array.isArray(${msg}.sessions)){`
      + `globalThis.__cceDeleteHook&&globalThis.__cceDeleteHook(${msg}.sessions)}`
      + `else if(${msg}&&${msg}.type==="cce_answer_result"&&typeof ${msg}.id==="string"){`
      + `globalThis.__cceAnswerHook&&globalThis.__cceAnswerHook(${msg}.id,${msg}.sent===true,typeof ${msg}.reason==="string"?${msg}.reason:"")}`
      + `else if(${msg}&&${msg}.type==="cce_process_ask"&&typeof ${msg}.sessionId==="string"){`
      + `globalThis.__cceProcessHook&&globalThis.__cceProcessHook(${msg}.sessionId)}`
      + `else if(${msg}&&${msg}.type==="cce_page_focus"&&typeof ${msg}.sessionId==="string"){`
      + `globalThis.__cceFocusHook&&globalThis.__cceFocusHook(${msg}.sessionId)}}catch(e){}${rest}`,
  },
  /*
   * A conversation opened from the session list in the place asked for (src/page/86-open-in-tab-or-sidebar.js). The
   * list's own open request carries where, and the host passes it to the open command in place of the preferred
   * location; a request that does not say is opened as before.
   */
  {
    name: 'session list open says where',
    re: /programmatic:([\w$]+)\.request\.newSessionGroupId&&!\1\.request\.sessionId\?"pin-to-panel":"honor-preferred-location"\}/g,
    to: (m, msg) => `programmatic:${msg}.request.cceWhere==="sidebar"?"cce-pin-to-sidebar":${msg}.request.cceWhere==="tab"?"pin-to-panel":`
      + `${msg}.request.newSessionGroupId&&!${msg}.request.sessionId?"pin-to-panel":"honor-preferred-location"}`,
  },
  /*
   * Opening one is decided in one function: a programmatic open goes to the sidebar only when the preferred location is
   * the sidebar, and otherwise to a tab. One more request value sends it to the sidebar whatever that setting says,
   * unless the conversation is already open in a tab, where it is shown. The setting is not touched, as with the
   * official programmatic opens.
   */
  {
    name: 'open in the sidebar on request',
    re: /if\(([\w$]+)\)return\{target:\1==="honor-preferred-location"&&([\w$]+)==="sidebar"&&!([\w$]+)\?"sidebar":"panel",/g,
    to: (m, how, where, open) => `if(${how})return{target:(${how}==="cce-pin-to-sidebar"||${how}==="honor-preferred-location"&&${where}==="sidebar")&&!${open}?"sidebar":"panel",`,
  },
  /*
   * Claude Code's record of the conversations in its tabs, as it reads it at start and before it drops the entries whose
   * tab is missing, and a way to ask which conversations are shown now - in a tab, a restored tab, the sidebar or another
   * window - and which of them are running in another window. This extension reopens the tabs VS Code did not bring back (src/droppedtabs.js). Also a way to tell every
   * panel that the conversations on disk changed, which makes the session list read them again, used after a delete.
   * And a way to hand an answer to the panel showing a conversation, in a tab or in the sidebar (deliverAnswer in src/claude-source.js): asked
   * without text, it only says whether this window has such a panel. The same lookup sends the info box its process id
   * (__cceToPanel). And a way to have every tab pick its icon again (__cceRefreshTabIcons).
   */
  {
    name: 'tab record at start',
    re: /this\.rememberedTabSessions=([\w$]+)\.getPanelTabSessions\?\.\(\)\?\?\[\],this\.reconcileRememberedTabSessions\(\)/g,
    to: (m, settings) => `this.rememberedTabSessions=${settings}.getPanelTabSessions?.()??[],`
      + 'globalThis.__cceTabsAtStart=this.rememberedTabSessions.slice(),'
      + 'globalThis.__cceSessionsShown=()=>[...this.sessionPanels.keys(),...this.reportableRememberedTabSessions().map((cceR)=>cceR.sessionId),'
      + '...this.liveElsewhereSessions.map((cceL)=>cceL.sessionId),...this.sidebarChatSessionIds()],'
      + 'globalThis.__cceSessionsElsewhere=()=>this.liveElsewhereSessions.map((cceL)=>cceL.sessionId),'
      + 'globalThis.__cceSessionsChanged=()=>{for(let cceC of this.allComms)try{cceC.sendSessionStoreChanged()}catch(e){}},'
      + 'globalThis.__cceSendSessionStates=()=>{try{this.broadcastSessionStates()}catch(e){}},'
      + 'globalThis.__cceRefreshTabIcons=()=>{for(let cceC of this.allComms)try{cceC.refreshTabIcon()}catch(e){}},'
      + 'globalThis.__cceAnswer=(cceId,cceText,cceKey)=>{let cceP=this.sessionPanels.get(cceId),cceC=cceP?this.panelComms.get(cceP):void 0;'
      + 'if(!cceC&&this.sidebarComms&&this.sidebarChatShows?.()===cceId)cceC=this.sidebarComms;'
      + 'if(!cceC)return!1;if(cceText===void 0)return!0;'
      + 'cceC.send({type:"cce_answer",sessionId:cceId,text:cceText,id:cceKey});return!0},'
      + 'globalThis.__cceToPanel=(cceId,cceMsg)=>{let cceP=this.sessionPanels.get(cceId),cceC=cceP?this.panelComms.get(cceP):void 0;'
      + 'if(!cceC&&this.sidebarComms&&this.sidebarChatShows?.()===cceId)cceC=this.sidebarComms;'
      + 'if(!cceC)return!1;cceC.send(cceMsg);return!0},'
      + 'this.reconcileRememberedTabSessions()',
  },
  /*
   * Whether the sidebar's conversation can be seen, and the tabs closed recently in this workspace
   * (src/recentclosed.js), sent with the open conversations to every panel. A hidden sidebar
   * keeps its conversation loaded, so the host still lists it among the sidebar's; OPEN SESSIONS leaves it out while the
   * sidebar is hidden (src/page/84-open-sessions.js). The state goes out with every update of the open conversations,
   * and the sidebar showing or hiding sends one.
   *
   * The same update also reaches this extension: each conversation's state as the host knows it and the replies not read
   * yet, for the Conversations view. It comes the moment something changes, where `claude agents` is asked every half
   * minute. The states pass through this extension first, which may mark an idle conversation running
   * (__cceWithBackground in extension.js).
   */
  {
    name: 'session states say whether the sidebar is shown',
    re: /for\(let ([\w$]+) of this\.allComms\)\1\.sendSessionStates\(([^;]*?),\1===([\w$]+)\?void 0:([\w$]+)\)/g,
    to: (m, c, args, side, ids) => `let cceArgs=[${args}];try{let cceF=globalThis.__cceWithBackground;`
      + 'if(typeof cceF==="function")cceArgs[0]=cceF(cceArgs[0])}catch(cceE){}'
      + '(()=>{try{globalThis.__cceStatesHook&&globalThis.__cceStatesHook(...cceArgs)}catch(cceE){}})();'
      + `for(let ${c} of this.allComms)${c}.sendSessionStates(...cceArgs,${c}===${side}?void 0:${ids},`
      + `${side}!==void 0&&[...this.webviews].some((cceV)=>cceV.comms===${side}&&cceV.isVisible()))`,
  },
  {
    name: 'session states message carries whether the sidebar is shown',
    re: /sendSessionStates\(([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+)=\{type:"request",channelId:"",requestId:([\w$]+)\(\),request:\{type:"session_states_update",([^{}]*?),sidebarSessionIds:\6\}\}/g,
    to: (m, a, b, c, d, e, f, z, id, fields) => `sendSessionStates(${a},${b},${c},${d},${e},${f},cceShown){let ${z}={type:"request",channelId:"",`
      + `requestId:${id}(),request:{type:"session_states_update",${fields},sidebarSessionIds:${f},cceSidebarShown:cceShown,`
      + 'cceRecentClosed:(()=>{try{return typeof globalThis.__cceRecentClosed==="function"?globalThis.__cceRecentClosed():void 0}catch(e){return void 0}})()}}',
  },
  {
    // A tab the person closed, as Claude Code notes it for its own reopen-closed command, reaches this extension too.
    name: 'closed tab reaches this extension',
    re: /if\(!this\.discardedReplacements\.has\(([\w$]+)\)\)this\.pushRecentlyClosedSession\(([\w$]+),([\w$]+),!!([\w$]+)\)/g,
    to: (m, panel, id) => `${m},(()=>{try{globalThis.__cceClosedHook&&globalThis.__cceClosedHook(${id})}catch(e){}})()`,
  },
  {
    name: 'sidebar showing or hiding updates the open conversations',
    re: /onDidChangeVisibility\(\(\)=>\{([\w$]+)\.notifyVisibilityChange\(([\w$]+)\.visible\),this\.updateSidebarActiveState\(\)\}/g,
    to: (m, comms, view) => `onDidChangeVisibility(()=>{${comms}.notifyVisibilityChange(${view}.visible),this.updateSidebarActiveState(),this.broadcastSessionStates()}`,
  },
  /*
   * The colour of a tab's icon (src/tabdot.js says what it is for).
   *
   * applyTabIcon gets the icon from this extension through a global, passing the icon key, tabBadgeAnchor.state, the
   * host's folder and the tab's session id, and keeps its own only when none comes back. Setting the host's icon and then ours made the tab
   * show the host's for a moment.
   */
  {
    name: 'tab dot',
    re: /(let ([\w$]+)=[\w$]+\(this\.lastRenameTabFlags,this\.([\w$]+),[^;]*;)this\.panelTab\.iconPath=([\w$]+\.Uri\.file\([\w$]+\.join\(this\.context\.extensionPath,"resources",[\w$]+\[\2\]\)\))\}/g,
    to: (m, pick, state, anchor, icon) => `${pick}let cceIcon;try{cceIcon=globalThis.__cceTabIcon&&`
      + `globalThis.__cceTabIcon(this.panelTab,${state},this.${anchor}&&this.${anchor}.state,`
      + `this.context.extensionPath,this.${anchor}&&this.${anchor}.sessionId)}catch(cceE){}`
      + `this.panelTab.iconPath=cceIcon||${icon}}`,
  },
  /*
   * setupPanel sets the plain logo before applyTabIcon runs, so a new tab opened in full orange and dimmed a moment
   * later. It asks for the idle icon here as well.
   */
  {
    name: 'tab icon at setup',
    re: /([\w$]+)=([\w$]+)\.Uri\.joinPath\(this\.extensionUri,"resources","claude-logo\.svg"\);([\w$]+)\.iconPath=\{light:\1,dark:\1\}/g,
    to: (m, logo, vs, panel) => `${logo}=${vs}.Uri.joinPath(this.extensionUri,"resources","claude-logo.svg");let cceSetup;`
      + `try{cceSetup=globalThis.__cceTabIcon&&globalThis.__cceTabIcon(${panel},"plain",void 0,this.extensionUri.fsPath)}`
      + `catch(cceE){}${panel}.iconPath=cceSetup||{light:${logo},dark:${logo}}`,
  },
  /*
   * Pinned conversations are not archived for being inactive (src/sessionpins.js says how they are pinned).
   *
   * The automatic archive skips every session it counts as in use, and a session in a group of the list is one of them.
   * Pinned ones join that same set, so they are skipped for the same reason and by the same test; the ids come from this
   * extension through a global, read each time the set is built. Anything going wrong there leaves the set as it was.
   */
  {
    name: 'pinned conversations not archived',
    re: /groupedSessionKeys:new Set\(([\w$.]+\.getSessionGroups\(\)\.flatMap\(\(([\w$]+)\)=>\2\.sessionIds\))\)/g,
    to: (m, groups) => `groupedSessionKeys:new Set([...${groups},...(()=>{try{let p=globalThis.__ccePinnedIds,`
      + 'r=typeof p==="function"?p():[];return Array.isArray(r)?r.filter((x)=>typeof x==="string"):[]}catch(e){return[]}})()])',
  },
  /*
   * The finished session list passes through this extension, which leaves out background sessions (src/bgsessions.js).
   * It does so after every source has added to the list, so it covers both of Claude Code's listing paths and the
   * entries it adds for unreadable files.
   */
  {
    name: 'session list leaves out background sessions',
    re: /(await this\.attachSessionPermissionModes\(([\w$]+)\),)\2\}/g,
    to: (m, head, list) => `${head}await(async()=>{try{let h=globalThis.__cceListedSessions;`
      + `if(typeof h!=="function")return ${list};let r=await h(${list},this.cwd);return Array.isArray(r)?r:${list}}catch(e){return ${list}}})()}`,
  },
];

/* As in src/webview.js: the digest says whether the host runs the code this tree produces, so an edit changed without
   the number being raised still patches again. It covers each edit's pattern and replacement and the scripts the
   replacements put into the bundle. */
const MARK = `/* CLAUDE-CODE-EXTRAS-HOST v${VERSION}-` + crypto.createHash('sha256')
  .update(EDITS.map((e) => [e.name, ...shapesOf(e).map((s) => [String(s.re), String(s.to), s.note || ''].join('\0'))].join('\0')).join('\n'))
  .update('\n').update([LOAD_WATCH, LOAD_WATCH_OFF, PANEL_TZ].map(String).join('\0'))
  .digest('hex').slice(0, 12) + ' */';

function hostFile(claudeExtensionPath) { return path.join(claudeExtensionPath, 'extension.js'); }

/** Pure transform. Returns { out, chosen } or { error }. Never partially applies. */
function patchSource(src) {
  if (src.includes(ANY_MARK)) return { error: 'the source to patch already carries a host patch' };
  const r = applyEdits(src, EDITS);
  if (r.error) return { error: r.error };
  const out = MARK + '\n' + r.out;
  try { new vm.Script(out, { filename: 'extension.js' }); }
  catch (err) { return { error: `patched host code does not parse: ${err.message}` }; }
  return { out, chosen: r.chosen };
}

/** 'patched' (this version), 'outdated' (another version of this patch), 'clean', 'missing'. */
function status(claudeExtensionPath) {
  const file = hostFile(claudeExtensionPath);
  if (!fs.existsSync(file)) return 'missing';
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARK)) return 'patched';
  if (src.includes(ANY_MARK)) return 'outdated';
  return 'clean';
}

/* Per-process temporary name with a random part: every window patches the same file, and two windows sharing one
   temporary name truncate each other's half-written copy and then find it gone at the rename. */
function writeAtomic(file, text) {
  const tmp = `${file}${TMP_SUFFIX}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    throw e;
  }
}

/*
 * Apply (or upgrade) the host patch. Returns { changed, liveChanged, current, message }; `current` means the file
 * already carries this patch, which is not a failure.
 */
function apply(claudeExtensionPath) {
  const file = hostFile(claudeExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  const state = status(claudeExtensionPath);
  const no = (message) => ({ changed: false, liveChanged: false, current: false, message });
  if (state === 'missing') return no(`Claude Code host bundle not found at ${file}`);
  if (state === 'patched') return { changed: false, liveChanged: false, current: true, message: 'already patched' };
  let original;
  if (state === 'outdated') {
    if (!fs.existsSync(backup)) return no('an older host patch is present but its backup is missing; reinstall Claude Code');
    original = fs.readFileSync(backup, 'utf8');
    if (original.includes(ANY_MARK)) return no('an older host patch is present and its backup carries one too; reinstall Claude Code');
  } else {
    original = fs.readFileSync(file, 'utf8');
  }
  const r = patchSource(original);
  if (r.error) return no(r.error);
  if (state === 'clean') writeAtomic(backup, original);
  writeAtomic(file, r.out);
  return { changed: true, liveChanged: false, current: true, message: 'patched' };
}

/** Put the original host bundle back and remove the backup. Returns { changed, message }. */
function restore(claudeExtensionPath) {
  const file = hostFile(claudeExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) return { changed: false, message: 'nothing to restore' };
  const original = fs.readFileSync(backup, 'utf8');
  if (original.includes(ANY_MARK)) return { changed: false, message: 'backup is itself patched; not restored' };
  const { wholeScript, moveBack } = require('./webview');
  if (!wholeScript(original, 'extension.js')) return { changed: false, message: 'backup is empty or cut off; not restored' };
  return moveBack(backup, file);
}

module.exports = {
  id: 'anthropic.claude-code', name: 'Claude Code host',
  VERSION, MARK, ANY_MARK, BACKUP_SUFFIX, EDITS, LOAD_WATCH, LOAD_WATCH_OFF, PANEL_TZ,
  patchSource, status, apply, restore, writeAtomic, hostFile, targetFile: hostFile,
  findInstalls: require('./webview').findInstalls,
};
