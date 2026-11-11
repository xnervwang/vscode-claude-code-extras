---
name: maintain
description: Keep this conversation's work plan up to date - the tree of what it still has to do, with a state on every row. Use it when the user raises something new to be done, when they approve something, when you start work on a row, when a row comes to wait on someone else, when a piece of work is finished or abandoned, when doing one thing turns out to require finishing another first, and when a hook reports that the context has passed a water mark before a compaction. Also use it before ending a turn that changed the shape of the work, which is what the Stop hook asks for.
version: 1.0.0
tags: [work-plan, task-tracking, long-conversation, handoff]
---
<!-- Source: vscode-agent-plus shared/plugin/skills/maintain/SKILL.md; sync-shared.js copies it, so edit it there. -->

# Maintain this conversation's work plan

A long conversation branches. Something is raised, it turns out to need something else first, that opens a third
question, and by the time the third is answered the main line is out of sight. The plan is the record of that stack: one
file per conversation, holding what is still to do and where each thing sits.

It is not a summary and not a design document. Every row is a piece of work. A constraint, an exclusion, a decision or a
piece of reasoning is not a piece of work and does not belong here - it goes wherever that conversation keeps such
things.

## Where the file is

Once a plan exists, its full path arrives at the start of every turn, in the same block as the open rows. Use that one.

Before one exists nothing is injected at all, so for the first row the path has to be built:

```bash
echo "$HOME/.claude/plugins/data/agent-work-plan-claude-code-extras/$CLAUDE_CODE_SESSION_ID.json"
```

In PowerShell:

```powershell
"$HOME\.claude\plugins\data\agent-work-plan-claude-code-extras\$env:CLAUDE_CODE_SESSION_ID.json"
```

One file per conversation, named by its session id, in the directory the platform gives this plugin. That directory's
name comes from the plugin and the marketplace it was installed from, so if the injected path ever disagrees with what
the command prints, **the injected one is right** - it came from the platform rather than from this document.

A conversation joins in wherever it happens to be: an existing one that has never had a plan simply starts with an empty
one, and nothing is reconstructed from what was said before. Start the file when there is something to put in it, not
before. A conversation that is one question and one answer does not need a plan, and an empty one is noise on every turn
that follows.

## The number in front of a row

Every injected row carries one - `1.`, `2.`, then `2.1.` and `2.1.1.` beneath it - and the tree view shows the same.
It is how someone names a row out loud instead of quoting its title, so `close 3` and `put 2.1 back to todo` are ordinary
instructions and mean a specific row.

**The number is not in the file, and it does not have to be looked up.** Every open row arrives with its own number in
front of it at the start of the turn, so the number and the row reach you together and there is nothing to work out. That
covers the rows anyone is likely to name, since those are the ones they can see.

For a row that is not in that block - a closed one - the number is an index into the file and resolving it is arithmetic
rather than a search: `3` is `nodes[2]`, and `2.1.1` is `nodes[1].children[0].children[0]`. Never search the file for the
digits; they are not written in it.

**Closed rows are counted.** They are skipped when the open rows are drawn, so the fifth row you were handed this turn is
not row 5 - it might be row 44. Counting what you can see is the one mistake here that silently closes the wrong task.
That is also what makes a number worth quoting: finishing something leaves a gap rather than moving every number after
it, so a number said an hour ago still points where it pointed then.

Do not write numbers into a title. A number stored in the text stops agreeing with the position it claims the moment
anything is inserted, and then the file contradicts itself.

## The file

```json
{
  "title": "what this conversation is about",
  "nodes": [
    {
      "title": "one piece of work, in a line",
      "state": "discussing",
      "note": "optional: a commit, why it is parked, who asked",
      "detail": "optional: several lines. What the row cannot say in its width - the user's own words, what was\nalready established, what to watch out for when this is picked up.",
      "opened": "2026-09-28T23:45:12+00:00",
      "since": "2026-09-29T00:00:00+00:00",
      "closed": "2026-09-29T01:10:03+00:00",
      "waitingOn": "user",
      "question": "optional: with waitingOn user, the one question the user has to answer",
      "children": []
    }
  ]
}
```

**`detail` is limited to 12 lines and 900 characters, and the view cuts it there.** Past that it says the description is
too long, on the row, where it is read.

That limit is not about the dialog's size. A description is what the next person needs in order to pick the task up: the
user's own words, what is already settled, the trap to avoid. It is not the story of how the task got here. Given room,
that story is what gets written - every turn adds the reasoning of that turn, and a plan of chronicles is a plan nobody
reads, which costs the plan the one thing it is for. So there is no roomier view to escape into, on purpose.

Where the rest belongs: reasoning in the commit message, a rule that came out of it in that rule, a measurement in
whatever document owns the thing measured.

`title` and `state` are required on a node; the rest may be left out.

**Write `title`, `note` and `detail` in the language the conversation is being held in.** The criterion is who chooses
the words: anything written as the conversation goes is written in its language, because the reader of the plan is the
reader of the conversation. Only text fixed in a shipped file has to be English — that file goes to people whose
conversations are in languages of their own, and no one can switch it per reader. So the `state` keywords below stay as
they are, and so does every word the extension and these hooks draw for themselves.

The seven `state` values are fixed keywords and are always these:

| `state` | what it means |
|---|---|
| `discussing` | raised, not yet agreed to be done |
| `todo` | agreed, not started |
| `doing` | agreed, and being worked on right now by this conversation or an agent it started with `claude --bg` |
| `waiting` | agreed and started, but held up by someone or something outside this conversation; who it waits on goes in `waitingOn` (see below) |
| `parked` | deliberately not being done now, with the reason in `note` |
| `done` | finished |
| `dropped` | decided against, with the reason in `detail` |

`doing` sits between `todo` and `done`, and it is a state rather than a mark alongside one: a row being worked on is
still agreed and still unfinished, which is what `todo` used to cover on its own. Several rows can be `doing` at once -
each row carries its own state, and one turn can have work going in more than one place. Who is doing it, when that is
worth saying, goes in `note`: the main thread, a sub-agent, a detached one. A row stays `doing` while an
agent this conversation started works on it, since the row is what the user watches.

**A `doing` row found at the start of a turn is stale unless this turn carries on with it or an agent this conversation
started with `claude --bg` is still working on it.** Between turns, nothing else in this conversation runs. Move a stale
row to `waiting` if it waits on someone or something outside this conversation, to `done` if it is finished, and otherwise
back to `todo` - and if it never got finished, that is worth a word in `note` rather than being silently reset. Nothing
else cleans these up: an agent that was killed did not get to, and no hook can tell which row it had been on.

## Who a held-up row waits on

A `waiting` row says who it waits on in `waitingOn`, one of five fixed keywords:

| `waitingOn` | who |
|---|---|
| `user` | the person in this conversation |
| `build` | CI or a build |
| `someone` | a reviewer, a colleague, anyone else |
| `session` | another conversation, not an agent this one started |
| `other` | anything that is none of these |

**When it is `user`, the row also carries `question`.** Write it as one sentence
they can answer as it stands, without scrolling back through this conversation. "Publish
1.0.20 to both marketplaces now, or wait for the colour fix?" can be answered; "Thoughts?", "Waiting for your
confirmation" and "See above" cannot. It is in the conversation's language, like the title, and at most 200 characters
on one line; anything longer belongs in `detail`.

**One question to a row.** If the user has three things to decide, add three rows under the row they belong to, each
waiting on the user with one question. The user can then answer each by its number. A question with more than one
question mark is refused.

These are fields rather than words in `note` because the extension's Conversations tab lists, for each conversation of
the workspace, what waits on the user, and it builds that list from these two fields only. Nothing reads `note` for it: a guess from free
text would get the list wrong. So a row with no
`waitingOn` is shown as waiting on someone unknown and is not listed, and one with `user` but no answerable question
gives the user nothing to act on.

The user can answer a question from that tab. The answer arrives as their own message, naming the row number and
repeating the question, and settles the row like any other answer: move it on.

When it is required:

- **Moving a row into `waiting`** needs `--waiting-on`; the row command refuses without it, and refuses `user` without
  `--question`.
- **A `discussing` row** may say `--waiting-on user` with its question when you have put a decision to the user and the
  work cannot go on without it. Leave it off a `discussing` row that is only an idea for later.
- **A change of state drops both** unless the same command gives them again, because they describe why the row is held
  where it is.
- **A `waiting` row from before the field** shows `on ?` in the injected block. Give it `--waiting-on` the next time you
  touch it; do not guess one for rows you are not otherwise touching.

## The three times

`opened` goes on a row when you add it. `since` is an ISO 8601 time for when the row entered its current state; the row
command writes it on every change of state. `closed` goes on when you move it to `done` or `dropped`, and only then - a
`parked` row is still open and has no end yet. Moving a closed row back to an open state removes `closed`. `asked` is
when the row's current question was put; the row command writes it whenever the question changes.

The injected rows and the tree view show how long a `doing` or `waiting` row has been in that state, using `since` -
for example, `doing for 2h`. A row without `since` shows no duration.

**Read the clock; never write a time from memory.** You do not know what time it is. A value you invent looks exactly
like a real one in the file and is only discovered when the rows sort into the wrong order:

```bash
date -Is
```

All three fields are optional, and a row that has none is fine - it simply shows no time. **Do not fill them in for rows
that predate them.** The date in an old row's `note` has no clock in it, so any time you supply for one is invented, and
the whole point of these fields is that they can be trusted.

Keep dates out of `note` from now on - that is what these fields are for, and a row carrying both shows the same day
twice. `note` is for what the time cannot say: a commit, who asked for it, why it is parked.

**A child is something that has to be finished before its parent can be.** That is the only thing nesting means. It
does not mean "came up while discussing", it does not mean "is related to", and it does not mean "is a sub-topic of".
Getting this wrong turns the plan into a transcript of the conversation's wandering, which is the thing it exists to
undo.

## When to write to it

| What just happened | What to do |
|---|---|
| The user raises something new to be done | Add a node with state `discussing` and an `opened` time |
| The user asks for work in this message and you start on it now | Add a node as `doing` straight away; it does not need to pass through `todo` |
| The user asks you to look into something | Add a row for looking into it, `doing` while you look and `done` when you have answered; add any work it turns up that might be worth doing as `discussing` |
| The user says to go ahead with it | Move that node to `todo` |
| You are about to start on it | Move it to `doing`, before the work rather than after |
| An agreed, started row is held up by someone or something outside this conversation | Move it to `waiting` when that happens, with `--waiting-on`, and `--question` when it waits on the user |
| You put a decision on a `discussing` row to the user and cannot go on without it | Give it `--waiting-on user` and the `--question` you asked |
| You pick up a `waiting` row again | Move it to `doing` when you resume work |
| The turn is ending and a row is still `doing` | Move it on: `done`, `waiting` with who it waits on, or keep it `doing` with a note saying what is still running for it |
| The work is finished, or the user says it is | Move it to `done` and set `closed` |
| The user decides against it | Move it to `dropped` and set `closed`, with the reason in `detail` |
| Doing A turns out to need B finished first | Add B as a child of A, with its own `opened` |
| A hook says the context has passed a water mark | For every `doing` row, `set <row> --detail TEXT`: the exact next step, anything not to do, and the user's own words written nowhere else |
| A turn did work and the brief's status is older than the turn | `plan-row.py <plan> status --doing TEXT --progress TEXT --next TEXT`: what you are doing, the latest progress, who it waits on or the next step (widths 80, 100, 60; `none` for an empty part) |
| The plan has rows and no summary, its top rows changed since the summary, or the context was compacted since | `plan-row.py <plan> summary TEXT`: what the conversation is for, its stage, decisions not to forget (width 400). Widths count a CJK character as 2; the conversation's own language; no names coined in it |
| A compaction has just happened | Read the plan file with a tool before anything else; the `detail` of each `doing` row holds the next step |
| The user says to leave something for later | Move it to `parked`, with the reason in `note` |

**Only the user's word moves a row to `todo`.** Anything you decide is worth doing goes in as `discussing` and stays
there until they agree. The plan is the user's picture of what is coming, so a row saying `todo` has to mean they said
so - otherwise reading it tells them what you intend rather than what was agreed, and they lose the one thing it was
for.

That gate is on `todo`, not on the ones after it. Moving a row you are already agreed on to `doing` and then to `done` is
reporting what happened, so it needs nobody's permission; what needs permission is calling something agreed in the first
place. Work the user asks for in this message and that you start now can go straight to `doing`: their request is the
word `todo` needs, so it does not need a separate `todo` step.

| Move | Whose word |
|---|---|
| anything → `todo` | the user's, always |
| `todo` → `doing` → `done` | yours, as it happens |
| `doing` ↔ `waiting` | yours, as it happens |
| anything → `parked` or `dropped` | the user's, with the reason written down |

`doing` and `waiting` are exceptions to the timing below: write them when the work starts or becomes held up, not at the
end of the turn. A row marked at the end of a turn is already wrong, because by then the turn is over - and the tree is
watching the file, so a row marked as you begin appears there while you work, which is the only time anyone can act on
it. After each batch of tool calls, a hook can remind the main thread to mark the row it is working on. It does so once
per turn when the turn has made at least three tool calls or changed at least two things besides the plan, and no row is
`doing`. Reading counts, because looking into something is work to mark; writing the plan does not excuse a turn that
still has nothing `doing`. It refuses nothing.

When a turn ends with rows still `doing`, the Stop hook asks once to move them on, and not again about the same rows:
beside the conversation, `doing` means being worked on now.

When your last reply in a turn seems to ask the user something and no question was recorded, the Stop hook asks you to
record it. When nothing is owed, just end the turn.

**For other changes, do it before writing the last paragraph of the turn**, not after. Once the closing summary is written the turn feels
finished and the plan is what gets left out; and the turn that most needed recording is the one that wandered furthest,
which is exactly the turn with the longest summary to write.

## The row command

For a change of state, prefer the `plan-row.py` command shipped with the plugin. It is one short call. Changing state by
hand means reading the clock first and rewriting the whole file. The block put in front of you each turn gives the full
command line with both paths filled in. Its two forms are:

```bash
python3 <path>/plan-row.py <plan file> set <row> [<state>] [--note TEXT] [--detail TEXT] [--waiting-on WHO] [--question TEXT]
python3 <path>/plan-row.py <plan file> add <state> <title> [--under <row>] [--note TEXT] [--waiting-on WHO] [--question TEXT]
```

Use the command line from the block as given: it starts Python by the name that works on this machine, which is not
always `python3`. For the first row, before a plan exists, there is no block. The command is then `hooks/plan-row.py`
in this plugin, two folders above the base directory this skill was loaded from, run with `python3`. You can also write
the file directly.

`<row>` is the number in front of a row, such as `3` or `2.1`; closed rows count, and `--note ""` removes the note.
`--detail` replaces the row's description, `--detail ""` removes it, and a description past 12 lines or 900 characters
is refused without changing the file. Omitting `<state>` keeps the row's state; naming its current state does not reset
`since`. The command reads the plan file immediately before writing to keep hand edits, takes `opened`, `since`, and
`closed` from the clock, writes the whole file, and renames it into place; `add` creates a missing plan file, but `set`
does not.

`--waiting-on ""` removes who a row waits on, and its question with it; `--question ""` removes the question.

The command refuses a row number that does not exist, a state outside the seven fixed keywords, a file that does not
parse, a file that is not a plan, and plans switched off. It also refuses a move into `waiting` without `--waiting-on`,
`user` without a question, a question on a row not waiting on the user, a question past 200 characters, and
`--waiting-on` on a row that is neither `waiting` nor `discussing`. It leaves the file untouched in each case.

Change a title, or move a row, by editing the file directly under the two rules below: read the file
before writing it, and never delete a node. The row command satisfies both rules by itself.

## Two rules that do not bend

**Read the file before writing it.** Write the whole file at once, from what you just read - never from what you
remember of it. The user edits this file by hand to correct you, and that is the point of it; a write built from memory
silently reverts their correction, and nothing anywhere will say that it happened.

**Only change states. Never delete a node.** A finished piece of work becomes `done` and stays visible; something
decided against becomes `dropped` and stays visible with its reason. Deleting is how the plan loses the record of what
was already settled, and then the same question gets reopened weeks later with nobody able to say what was decided or
why. A closed row whose children are still open stays legible too, because that is the row that says where to return
to.

## What it costs to read

Only the open rows are put in front of you each turn, with a count of the closed ones. So a plan can hold the whole
history of a long conversation without the history being paid for on every turn - which is why closing a row is cheap
and deleting it is never necessary.
