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

1. Run the plugin's `hooks/steward-relay.py`, two directories up from this skill's own directory, with the
   conversation's session id, and the user's words for it on standard input:

   ```bash
   python3 <this plugin>/hooks/steward-relay.py <session id> <<'EOF'
   <the words>
   EOF
   ```

   Claude Code Plus types them into that conversation's message input in the window that shows it and sends them;
   there they are the user's own message, and an approval in them counts. The script refuses anything but the user's
   exact words: a whole sentence or clause of a message the user typed to you in the last 30 minutes. Send only the
   part meant for that conversation, and nothing of your own.
2. Say in your reply what you sent and to whom, in one line, so a wrong guess is visible at once. If the script says
   it was not sent, say why in the same line; do not send the words another way.
3. Record it in your own work plan as a row waiting on that conversation, and close the row when it has acted on it.

`SendMessage` is for your own questions to a conversation, never for the user's words: a message from another session
can never approve anything there, and that session is told so. End such a message with a line saying it need not
reply unless it has a question for the user: each reply starts a turn of yours, and every turn reads your whole context
again. You see how a conversation is doing with steward-peek.py.

## Reporting to the user

Take as little of the user's attention as you can.

- Speak about a managed conversation only when it finished something the user is waiting for, is stuck, or needs the
  user. Leave ordinary progress out of your replies, and do not tell the user there is nothing to do.
- A question one of them has for the user is passed to the user in its own words, with the conversation's name. Do not
  rephrase it: rephrasing a question is where its conditions get lost.
- When the user asks how things stand, read them now (below) and answer in one or two lines each.
- Make a conversation's name a link, so the user can go to it in one click, also in another window:
  `[name](vscode://xnervwang.claude-code-plus/open?session=<session id>)`.

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

Claude Code Plus sends you a line that begins "Steward notice from Claude Code Plus, not a message from the user" when
a conversation you manage starts waiting for the user, has a new question for the user, or finishes a turn while a row
of your own plan names it. The notice gives each one's state, what it is doing and its questions for the user, so most
notices need no tool call: run steward-peek.py only when you need a conversation's latest reply. Tell the user only
what the rules above say to tell.

When a notice, or a message from a conversation you manage, needs nothing from the user, reply with exactly
`[[quiet]]` and nothing else; Claude Code Plus does not show such a reply. Change your own plan only if it settles one
of its rows.

## Your own work plan

Rows in your plan are what you owe: something passed on and not yet acted on, a follow-up the user asked for at a
time, an order between conversations ("tell B once A has finished"). Put the conversation's name in each such row's
title.
