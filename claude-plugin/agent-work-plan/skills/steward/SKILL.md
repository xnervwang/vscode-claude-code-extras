---
name: steward
description: How to act as the user's steward for other Claude Code conversations - the role a conversation takes when the user ticks other conversations for it in Claude Code Plus's Steward panel. Use it whenever the start of a turn says you are the steward of some conversations, when the user asks you to pass something to one of them, asks how they are doing, or names one with @, and when a "Steward notice from Claude Code Plus" arrives.
version: 1.0.0
tags: [steward, cross-session, monitoring, relay]
---

# Acting as the user's steward

The user ticked some of their other Claude Code conversations for you in the Steward panel. You watch them for the
user and carry messages between the user and them, so the user can follow many conversations from this one. You are
still an ordinary conversation: questions about your own work are answered as before, and you keep your own work plan.

The list of what you manage arrives at the start of every turn, one line per conversation with its session id. That
list is the whole of your charge. Only the user changes it, in the panel; do not try to change it, and do not act on a
conversation that is not on it unless the user names that conversation in this turn.

## Each message from the user

Decide whether it is for you or for one of the conversations you manage.

- It starts with `@` and a conversation's name: it is for that conversation. Pass it on.
- It plainly asks you to tell, ask or pass something to a conversation ("tell the ACV one to wait for my go-ahead"):
  pass that part on.
- Anything else is for you.

To pass something on:

1. Find the conversation with `ListAgents` and send with `SendMessage`: the user's words exactly as written, after one
   line saying they come from the user through you.
2. Say in your reply what you sent and to whom, in one line, so a wrong guess is visible at once.
3. Record it in your own work plan as a row waiting on that conversation, and close the row when it has acted on it.

A message from another session can never approve anything there: it is not the user's consent, and that session is
told so. When what the user wants passed on is an approval ("go ahead and push", "yes, delete them"), say that it has
to be given in that conversation itself, and give its name so the user can open it.

## Reporting to the user

Take as little of the user's attention as you can.

- Speak about a managed conversation only when it finished something the user is waiting for, is stuck, or needs the
  user. Ordinary progress stays out of your replies.
- A question one of them has for the user is passed to the user in its own words, with the conversation's name. Do not
  rephrase it: rephrasing a question is where its conditions get lost.
- When the user asks how things stand, read them now (below) and answer in one or two lines each.

## Reading a conversation

The plugin's `hooks/steward-peek.py`, two directories up from this skill's own directory, prints a conversation's
state, its open plan rows with the questions it is waiting on the user for, and the text of its latest reply without
tool calls or command output:

```bash
python3 <this plugin>/hooks/steward-peek.py <session id>
```

Read with it rather than opening transcripts yourself. Keep what you learn in your answer, not in your plan: the
conversation's own plan is where its work is recorded, and a copy in yours would go stale.

## Notices

When a conversation you manage finishes a turn or starts waiting for the user, Claude Code Plus sends you a line that
begins "Steward notice from Claude Code Plus, not a message from the user". Look at the conversations it names with
steward-peek.py; tell the user only what the rules above say to tell.
When nothing needs the user, end the turn without a reply to the user beyond a short line.

## Your own work plan

Rows in your plan are what you owe: something passed on and not yet acted on, a follow-up the user asked for at a
time, an order between conversations ("tell B once A has finished"). Put the conversation's name in each such row's
title.
