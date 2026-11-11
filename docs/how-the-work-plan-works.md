# How the work plan works

## What runs

The extension registers a Claude Code plugin the first time it activates. Its `maintain` skill contains the rules Claude follows for the plan in `claude-plugin/agent-work-plan/skills/maintain/SKILL.md`.

| Hook | What it does |
| --- | --- |
| `UserPromptSubmit` | Puts the plan's open rows in front of Claude. The first message and the first after each compaction get the whole block, with what the states mean and the commands for changing and adding rows. Later messages get a short head, or one line when no row has changed; what was shown last is kept in `<session ID>.injected`. A `doing` row says how long it has been `doing`; a row that asks you something says who it waits on and the question; other rows show their title only. A finished row stays when a row under it is open. A line names the `waiting` rows that do not say who they wait on. Cut to fit 6,000 characters, with a closing line counting the rows left out. While `claudeCodePlus.conversationBrief` is on, also shows the conversation's brief and how long ago each part was written. Says nothing without a plan. |
| `PostToolBatch` | Once per turn, reminds Claude to mark the row it is working on if no row is `doing` and the main thread has made at least three tool calls or changed at least two things besides the plan. Also checks context size. |
| `PostToolBatch` and `Stop` | Read context size from the transcript. At 170k, 180k or 195k tokens in a 200K window, or 960k, 970k or 995k in a 1M window, ask Claude to write the exact next step, what not to do and anything you said that is written nowhere else into every `doing` row. Repeat at the end of each turn while context stays above the mark and the plan has not been written. The marks move down when `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` lowers the compaction line. |
| `Stop` | At the end of a turn that changed at least two things without touching the plan, says so once for a plan in that state. If the turn leaves rows `doing`, asks once to move each on: to `done`, to `waiting` with who it waits on, or to stay `doing` with a note on what is still running. It asks once for a given set of rows. If the reply that ends the turn seems to ask the user something and the turn recorded no question, it asks for the question to go on a row. Without a plan, says once that it could keep one after you have sent at least 3 messages and a turn made at least 25 tool calls. While `claudeCodePlus.conversationBrief` is on, asks once per turn for the brief's status after a turn that did work, and for its summary when there is none, after a top-level row was added, removed or closed, and after a compaction. |
| `SessionStart` after compaction | Tells Claude that context is at its smallest, gives the plan file's path and asks it to read the file before anything else, and says where the rows moved to `closed/<session ID>.json` are when there are any. Writes the time to `<session ID>.compacted`, so the next message gets the whole plan and the summary is asked for again. |
| `UserPromptSubmit`, and `SessionStart` after compaction | When the time zone the panel reported differs from this machine's, tells Claude the user's zone, its offset and the time there, and that `date`, file times and log lines here are in the machine's zone. Said on a conversation's first message and after every compaction, then again only when either side's date turns over, the offset changes, or the context has grown by 100k tokens since; what was said last is kept in `<session ID>.tz`. Says nothing when the zones agree or `claudeCodePlus.tellClaudeYourTimeZone` is off. |
| `PreToolUse` on file writes and edits | Refuses a write to a plan file when a row's description exceeds what the work plan view shows: 12 lines or 900 characters. Also refuses a question with more than one question mark. |

`claudeCodePlus.workPlanQuietWhenReplyMatches` silences only the compaction prompts: the context-size hook and the two `SessionStart` hooks.

## Changing a row

Claude uses `plan-row.py`, a small command shipped with the plugin, to add rows and to set a row's state, note, description, who it waits on and its question. It refuses a move to `waiting` that does not name who the row waits on or a row waiting on you that has no question. A question may hold only one question mark. Several questions go on separate rows under the row they belong to. The command reads the time from the clock itself. You can edit the file by hand too.

`plan-row.py summary TEXT` writes the conversation's summary. `plan-row.py status --doing TEXT --progress TEXT --next TEXT` writes where it stands now. Together they make up the conversation's brief, which Agent Plus shows when you click the conversation in its Conversations panel. The width limits are 400 for summary, 80 for doing, 100 for progress, and 60 for next. A CJK character counts as 2; any other character counts as 1. The command refuses text over the limit instead of cutting it. After each write, it moves every row whose whole subtree was closed more than a day ago to `closed/<session ID>.json` beside the plan. A placeholder with the row's state and a shortened title stays in the plan, so row numbers do not change. A command that names a moved row or adds a row under it moves it back first. Agent Plus's work plan view reads both files and shows the rows as before.

## The view

Agent Plus draws the plan. Row times use the time zone in which the Claude Code panel runs.

## Files and cleanup

Each conversation has one JSON plan file under `~/.claude/plugins/data/agent-work-plan-claude-code-extras/`, named by session ID. Its moved rows can be in `closed/<session ID>.json`. The hooks also keep small files beside each plan, named `<session ID>` with an extension. For example, `<session ID>.injected` records what the plan looked like when it was last put in front of Claude. `client-time-zone.json` beside the plans holds the time zone a panel last reported. Deleting an archived conversation from the session list deletes its plan, its `closed/` file, and its hook files. At most once a day, cleanup deletes those files if the conversation transcript no longer exists and the files have not been written for a week.

## What a turn costs

See [What it costs in tokens](../README.md#what-it-costs-in-tokens) in the README.
