# How the work plan works

## What runs

The extension registers a Claude Code plugin the first time it activates. Its `maintain` skill contains the rules Claude follows for the plan in `claude-plugin/agent-work-plan/skills/maintain/SKILL.md`.

| Hook | What it does |
| --- | --- |
| `UserPromptSubmit` | Puts up to 40 open rows in front of Claude. A finished row stays when a row under it is open; each `doing` or `waiting` row says how long it has been in that state. A `waiting` row also says who it waits on, or `on ?` when the row does not name anyone, and the question it asks when it waits on you. A closing line counts the rows that show `on ?`. Includes the two command lines for changing and adding rows. Says nothing without a plan. |
| `PostToolBatch` | Once per turn, reminds Claude to mark the row it is working on if no row is `doing` and the main thread has made at least three tool calls or changed at least two things besides the plan. Also checks context size. |
| `PostToolBatch` and `Stop` | Read context size from the transcript. At 170k, 180k or 195k tokens in a 200K window, or 960k, 970k or 995k in a 1M window, ask Claude to write the exact next step, what not to do and anything you said that is written nowhere else into every `doing` row. Repeat at the end of each turn while context stays above the mark and the plan has not been written. The marks move down when `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` lowers the compaction line. |
| `Stop` | At the end of a turn that changed at least two things without touching the plan, says so once for a plan in that state. If the turn leaves rows `doing`, asks once to move each on: to `done`, to `waiting` with who it waits on, or to stay `doing` with a note on what is still running. It asks once for a given set of rows. If the reply that ends the turn seems to ask the user something and the turn recorded no question, it asks for the question to go on a row. Without a plan, says once that it could keep one after you have sent at least 3 messages and a turn made at least 25 tool calls. |
| `SessionStart` after compaction | Tells Claude that context is at its smallest, gives the plan file's path and asks it to read the file before anything else. |
| `UserPromptSubmit`, and `SessionStart` after compaction | When the time zone the panel reported differs from this machine's, tells Claude the user's zone, its offset and the time there, and that `date`, file times and log lines here are in the machine's zone. Said on a conversation's first message and after every compaction, then again only when either side's date turns over, the offset changes, or the context has grown by 100k tokens since; what was said last is kept in `<session ID>.tz`. Says nothing when the zones agree or `claudeCodeWorkPlan.tellClaudeYourTimeZone` is off. |
| `PreToolUse` on file writes and edits | Refuses a write to a plan file when a row's description exceeds what the work plan view shows: 12 lines or 900 characters. Also refuses a question with more than one question mark. |

`claudeCodeWorkPlan.workPlanQuietWhenReplyMatches` silences only the compaction prompts: the context-size hook and the two `SessionStart` hooks.

## Changing a row

Claude uses `plan-row.py`, a small command shipped with the plugin, to add rows and to set a row's state, note, description, who it waits on and its question. It refuses a move to `waiting` that does not name who the row waits on or a row waiting on you that has no question. A question may hold only one question mark. Several questions go on separate rows under the row they belong to. The command reads the time from the clock itself. You can edit the file by hand too.

## The view

Agent Work Plan draws the plan. Row times use the time zone in which the Claude Code panel runs.

## Files and cleanup

Each conversation has one JSON file under `~/.claude/plugins/data/agent-work-plan-claude-code-extras/`, named by session ID; `client-time-zone.json` beside them holds the time zone a panel last reported. At most once a day, plan files are deleted if their conversation transcripts no longer exist and the files have not been written for a week.

## What a turn costs

In one measured example, a plan with 19 open rows and notes mostly in Chinese added about 2,140 tokens to each turn. About 480 of those tokens were fixed instructions. The count used the Bedrock token-count API on the text printed by the `UserPromptSubmit` hook; English notes are usually fewer tokens per row.
