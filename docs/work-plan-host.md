# Work Plan Host Protocol

The Work Plan for Claude Code extension (`xnervwang.claude-code-extras`) hosts work plans and conversations from other VS Code extensions. The first external source is codex-extras (`xnervwang.codex-extras`) for OpenAI Codex.

When both extensions are installed, claude-code-extras draws the work plan view, Conversations panel, Answer view, and status bar entry, while the other extension registers a source for its agent. Installing only claude-code-extras leaves its behavior the same as before sources existed.

## Find the host

Look up `vscode.extensions.getExtension('xnervwang.claude-code-extras')`. If the extension is present, await its `activate()` call and read `exports.workPlanHost`. If `workPlanHost.majors` includes the protocol major your source implements, call `registerSource(source)`. Otherwise, draw your own views.

Do not list the host in `extensionDependencies`, and keep either extension working when installed alone.

Give each of your own views the `when` clause `"<yourExtension>.standalone"`. Set that context key to true only after finding there is no usable host. A `"hosted"` key would leave your views visible until your extension activates.

A view the host does not draw, such as a Codex session list, can appear in the host's activity bar container. Its container id is `claudeCodeExtras` and is part of the protocol. Register that view under a different view id from its copy in your own container, with the `when` clause `"<yourExtension>.hosted"`. VS Code rejects two views with the same id.

## Host API and source shape

Only `protocol` and `id` are required. A missing member, or one that throws when read or called, is treated as absent.

```javascript
const workPlanHost = {
  version: 3,
  majors: [3],
  features: [],
  registerSource(source)
};

const source = {
  protocol: 3,
  features: [],
  id: 'codex',
  label,
  logo: { light, dark },
  planPath(sessionId),
  planDir(),
  sessionForTab(tab),
  onDidFocus,
  listConversations(),
  onDidChangeConversations,
  reveal(sessionId, row),
  canDeliver(sessionId),
  deliverAnswer(sessionId, text)
};
```

| Host member | Meaning |
| --- | --- |
| `version` | Newest protocol major the host implements. |
| `majors` | Source protocol majors the host accepts. |
| `features` | Optional host capabilities by name. |
| `registerSource(source)` | Registers a source and returns a `vscode.Disposable`. Disposing it removes the source and its conversations. |

The host refuses a source and returns a no-op Disposable if:

- Its `protocol` is not in `majors`.
- Its `id` is not a non-empty well-formed string of at most 200 characters without surrounding whitespace.
- Another source with that id is registered.
- The host has shut down.

It also writes a line to its output channel.

| Source member | Meaning |
| --- | --- |
| `protocol` | Protocol major the source implements: `3`. |
| `features` | Optional capability names the source implements. None are currently defined. |
| `id` | Source id, such as `'codex'`. Claude Code's built-in source uses `'claude-code'`. |
| `label` | Text shown in tooltips and in the work plan view's description. |
| `logo` | `{ light, dark }` SVG `vscode.Uri` values from the agent vendor's installed extension. Claude Code uses `resources/claude-logo.svg` from `anthropic.claude-code`. Codex uses `resources/blossom-black.svg` and `resources/blossom-white.svg` from `openai.chatgpt`. |
| `planPath(sessionId)` | Absolute path of the conversation's plan JSON, or `null`. |
| `planDir()` | Directory holding the plans. The host watches it. |
| `sessionForTab(tab: vscode.Tab)` | Session id shown in that editor tab, or `null`. |
| `onDidFocus` | `vscode.Event<{ sessionId }>` fired when a conversation comes to front outside an editor tab, such as in a sidebar view or a page getting focus. |
| `listConversations()` | Returns `Promise<Conversation[]>`. The returned array may have a string property named `problem`; the host shows it as a line above the source's rows. |
| `onDidChangeConversations` | `vscode.Event<void>` reporting a change to the source's conversations. |
| `reveal(sessionId, row)` | Returns `Promise<boolean>`. `row` is `{ title, cwd }` for the clicked row. If it returns `false`, the host shows a notice that the conversation could not be brought to front. A source that shows its own message returns `true`. |
| `canDeliver(sessionId)` | Returns whether this window shows the conversation and can type into it. |
| `deliverAnswer(sessionId, text)` | Returns `Promise<{ delivered: boolean, reason?: string }>`. |

## Conversations and plans

`Conversation` has the fields below. A conversation is identified by `(source id, sessionId)`; a `sessionId` is unique only within its source.

| Field | Meaning |
| --- | --- |
| `sessionId` | Session id within the source. |
| `title` | Conversation title. |
| `cwd` | Conversation working directory. |
| `state` | `'prompt'` for a permission or other prompt, `'working'`, `'unread'` for a reply nobody has seen, or `'idle'`. Any other value is treated as `'idle'`. |
| `running` | Whether the conversation is running. Defaults to `true`. |
| `lastActiveAt` | Epoch milliseconds or a date string. |
| `hasPlan` | Whether the conversation has a plan. |

The host works out "needs you" from questions in the plan; sources do not report it. Conversation rows sort as prompt, needs you, working, unread, idle.

`listConversations()` may include stopped conversations (`running: false`). The host keeps a stopped conversation only if its plan still has open rows, the plan was written in the last 7 days, and its `cwd` is inside a workspace folder.

The host reads and watches `planDir` to draw questions and doing rows from plan files. Each source cleans up its own old plans; the host never deletes or cleans anything in `planDir`.

Plan files use the format defined at the top of `src/workplan.js` and by `claude-plugin/agent-work-plan/` in this repository. Row states are `discussing`, `todo`, `doing`, `waiting`, `parked`, `done`, and `dropped`. `waitingOn` values are `user`, `build`, `someone`, `session`, and `other`. A row without a state reads as `todo`, while a row with an unknown state appears with its text as written and counts toward nothing.

## The active conversation

On every change of editor tabs, the host offers the active tab to each source's `sessionForTab`. A claimed tab moves the work plan view to that conversation. An unclaimed tab, such as a file, terminal, or settings tab, leaves the view where it was.

`onDidFocus` also moves the work plan view. Whatever happened last wins. An `onDidFocus` event with an empty `sessionId` clears the view only if the active conversation belongs to that source.

When more than one source is registered, each Conversations panel row shows its source's logo with a colored dot for the state. The row's tooltip shows the source label, and the work plan view's description shows the active conversation's source. A source whose logo cannot be read gets plain state icons.

## Answers across windows

Answers typed into the Answer view can belong to a conversation open in another VS Code window. The sending window writes the answer into a folder that every window on the machine reads. A window claims the answer when the conversation's source says `canDeliver(sessionId)` is true, then calls `deliverAnswer`.

If no window claims the answer within 15 seconds, or delivery reports `delivered: false`, the sending window copies the answer to the clipboard and says so. If `deliverAnswer` reports `delivered: false` with a `reason` equal to one of the host's own outcome names (`sent`, `waiting`, `lost`, `nobody`), the host records the reason as `error`.

Answer files carry `sourceId` and `format: 1`. A file without `format` is format 0 and belongs to Claude Code. A window does not claim a file whose format is newer than the format it supports or is not an integer. Answer files for sources other than Claude Code use a file name that older builds of this extension do not match, so those builds never claim them.

## Timing and limits

The host waits up to 3 seconds for an external source's `listConversations()` result. If it has not returned, the host draws that source's previous list and repaints when the result arrives. The host does not call `listConversations()` again while a call is outstanding. An `onDidChangeConversations` event during a call causes exactly one more call afterward. The host waits up to 20 seconds for Claude Code's own list.

These limits apply only to external sources:

| Item | Limit |
| --- | --- |
| Conversations per list | 2000 |
| Plan file | 8 MB |
| Logo file | 256 KB |

A plan or logo path that is not a regular file is ignored.

## Compatibility and releases

The protocol major is the integer in `majors` and `protocol`. It is unrelated to either extension's Marketplace version number. `extensionDependencies` cannot express a version, so the extensions decide compatibility at runtime.

Add a new field or method under a feature name and use it only when the other side lists that name, without a new major; removing a field or changing its meaning requires a new major. After such a change, the host keeps the previous major in `majors` for at least one release. A source keeps an implementation of the previous major and registers with the newest major the host accepts. Any pair one major apart then works without the two extensions shipping together.

When a source finds no major in common with the host, it draws its own views and shows one notice to update the other extension. Two work plan views remain visible until the user updates.

Both sides ignore fields they do not know. Plan files and `plan-row.py` change only by addition. Changing what an existing plan field means is a major change.

A capability that needs both sides ships in the host first. Before either extension is released, a test should fetch the other extension's latest Marketplace release and check that each accepts the other's major and that both read the shared files' formats. If the other extension is not published, or its published release has no host API yet, the test skips the check and says why.
