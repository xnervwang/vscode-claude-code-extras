#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/hooks/nudge-work-plan.py; sync-shared.js copies it, so edit it there.

"""Say something when a turn did real work and left the work plan untouched.

The skill says when to update the plan. This exists because a rule about noticing a state change is the kind that fails
in the moment it is needed - the same reason the injection hook exists rather than trusting the skill to be loaded.

It is deliberately hard to trigger. A reminder that fires when nothing was owed teaches the reader to skip it, and a
skipped reminder is worse than none: it costs attention on every turn and buys nothing on the turn that matters. So it
speaks only when the turn changed something, the plan is older than the turn, the turn never went to the plan at all,
AND this has not already been said about a plan in exactly this state.

"Changed something" is counted as things altered, not tool calls made. That distinction is the whole difference between
a reminder worth reading and one worth skipping: a turn spent reading, searching and measuring makes plenty of calls and
owes the plan nothing, and 18 of 29 reminders in the conversation that prompted this went to turns of exactly that kind.

That last condition is what lets the reminder be answered. Reading the plan and finding nothing owed is a complete
reconciliation, but it leaves no mark on the file - so judging by the file's age alone, a turn that had looked and a
turn that had forgotten were the same turn. The reminder then repeated on every working turn for the rest of a
conversation whose plan was already correct, and each repeat cost a round of explaining that nothing was owed. Three in
a row is what prompted this.

Where no plan exists at all it speaks once, and then never again in that conversation. This is the harder case, because
until something writes a plan the injection hook has nothing to inject and the skill is only found when its description
happens to match - so a conversation can run to its end without the facility ever being mentioned. Measured across 1835
transcripts on the machine this was written on, 4 of them had a plan. A hook staying quiet to cost nothing is how that
happens, so the cost is now one sentence, once, after a turn big enough to have needed it.

WHICH SESSIONS THIS REACHES, and why detached agents are not a cost worth engineering against.

A sub-agent started in-process shares the main session's id, and these hooks do not run for it at all: measured over
three of them in one conversation, zero injections against the main session's 330. So a sub-agent neither sees the plan
nor is reminded of it, and whatever it did has to be recorded by the session that dispatched it.

A detached agent - one started as its own process - does get the hooks, because it has a session id of its own. It
therefore has no plan file, which puts it on the branch above, and that was briefly expensive: 53 of them were offered a
plan inside half an hour. What stopped it was not a check for detached agents but the requirement that the user have
spoken several times, added three hours later. A detached agent is handed one task and nothing else, so it counts one
user turn against a threshold of three and is silent for the rest of its life. No measured offer to one has happened
since, and nothing here identifies such a session or needs to.

Which is the part worth keeping: the question "can this conversation branch" subsumes "is this a detached worker", so
there is no second mechanism to maintain. Tightening the first threshold is what to reach for if these ever turn up
again, rather than adding a way to recognise them - there is no payload field verified to distinguish one, and looking
for a signal that happens to correlate is how a check starts passing for the wrong reason.
"""
import json
import os
import re
import sys

# Set before the import below: see inject-work-plan.py. A hook that runs on every turn leaves no bytecode behind in the
# installed plugin directory.
sys.dont_write_bytecode = True
# The script's folder on the import path: see inject-work-plan.py.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from changes import changes
from changes import shell_command  # noqa: F401  (kept beside changes so both read a call the same way)
from plan_path import (AFTER_OFFER, BRIEF_WIDTH, BRIEFED_SUFFIX, CLOSED_STATES, COMPACTED_SUFFIX, MAYBE_CALL, MAYBE_USER,
                       NOTE_WORD, NUDGED_SUFFIX, OFFERED_SUFFIX, QUESTION_WORD, SETTLED_SUFFIX, STOP_REENTERS,
                       WAITING_ON_WORD, ask_how, brief_how, brief_of, children, epoch, listed, offer_how, open_tail,
                       plan_file, read_payload, settings, settle_how, side_file, spoke, stop_output, tool_calls,
                       turn_began, write_quietly)

# Every threshold this uses is in plan_path.DEFAULTS, where the editor's settings can override it.

# How far back from the end of the transcript the turn, and the user's turns before it, are looked for.
TURN_TAIL = 2 * 1024 * 1024


def spellings(path):
    """Spellings of `path` in a raw transcript line. JSON doubles a Windows path's backslashes, and a model may write the
    path with forward slashes."""
    return {s for s in (path, json.dumps(path, ensure_ascii=False)[1:-1], path.replace("\\", "/")) if s}


def turn_shape(tail, plan="", began=None):
    """Shape of the current turn: (start time in epoch seconds, tool calls, changes, user turns, whether a tool call
    went to the plan).

    With a plan, `began` (plan_path.turn_began) marks the turn's start and the backward walk stops at the first older
    line, without counting turns; otherwise the turn starts at the user's last message. Only the tail is read, so the
    count of turns is a lower bound, which can only make this quieter.

    Going to the plan is looked for only in the calls the model made, never anywhere else in the turn: the path is also
    in the text this plugin injects at the start of every turn, so a search across whole rows would always find it. A
    call to the plan's tools carries the plan's path, which they require; Codex records such a call by the tool's own
    name (set_row) with the server in a field of its own, so the name says nothing about the server.

    Only lines holding one of plan_agent's MAYBE_CALL or MAYBE_USER strings are parsed. A line with several calls on it
    counts as one tool call, and each of its calls is judged for a change.
    """
    started, tools, changes_made, turns, reached = began, 0, 0, 0, False
    names = spellings(plan) if plan else set()
    in_turn = True
    for line in tail.lines(TURN_TAIL):
        maybe_call = any(m in line for m in MAYBE_CALL)
        if not maybe_call and not any(m in line for m in MAYBE_USER):
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if not isinstance(row, dict):
            continue
        if began is not None:
            at = epoch(row.get("timestamp"))
            if at is not None and at < began:
                break
        elif spoke(row):
            turns += 1
            if in_turn:
                in_turn, started = False, epoch(row.get("timestamp"))
            continue
        calls = tool_calls(row) if in_turn and maybe_call else []
        if calls:
            tools += 1
            changes_made += sum(1 for name, given in calls if changes(name, given))
            if any(n in line for n in names):
                reached = True
    return started, tools, changes_made, turns, reached


def speak(payload, text):
    """Every caller has already made sure the same thing is said at most once (plan_agent.stop_output says how)."""
    print(json.dumps(stop_output(payload, text)))
    return 0


def offer_once(payload, path, tools, turns, limits):
    """Tell a conversation that has no plan that it could keep one, at most one time.

    Having offered is remembered as an empty file beside where the plan would go: this is a new process on every turn
    and has nowhere else to put it. If the marker cannot be written the offer is not made at all - saying it on every
    turn instead is the one outcome worth avoiding, and a directory that refuses the marker would refuse the plan too.
    """
    if tools < limits["offerMinToolCalls"] or turns < limits["offerMinTurns"]:
        return 0
    marker = side_file(path, OFFERED_SUFFIX)
    if os.path.exists(marker):
        return 0
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except Exception:
        return 0
    if not write_quietly(marker, ""):
        return 0
    return speak(payload, (
        "This conversation is keeping no work plan. You have spoken %d times and this turn used %d tools, which is "
        "long enough for the thread it started on to be out of sight. If the work has more than one strand to come "
        "back to, %s - the skill agent-work-plan:maintain says what a row holds and what the states mean.%s This is "
        "said once per conversation and will not be raised again." % (turns, tools, offer_how(path), AFTER_OFFER)))


def said_already(path, touched):
    """True when this was already said about a plan in exactly this state, and saying it again would add nothing.

    What is remembered is the plan's modification time at the moment of speaking. If the plan has not been written to
    since, the reminder would be the same sentence about the same unrecorded state - and a reminder that did not work
    the first time does not work on the fifth. Measured over one conversation, the reminder fired 29 times and ten of
    those were runs of it repeating within a few turns; not one of the repeats produced an entry that the first had not.

    A plan that HAS been written to since resets this, so forgetting again is caught again.

    Counting turns instead would be the obvious shape and does not work: the turn count comes from the tail of the
    transcript rather than the whole of it, so it stops being monotonic once a conversation outgrows that window, and a
    counter that can go down cannot express a cooldown. A modification time only moves forward.

    Failing to read or write the marker means speaking. Silence is the outcome worth being sure about.
    """
    marker = side_file(path, NUDGED_SUFFIX)
    try:
        with open(marker) as fh:
            if fh.read().strip() == repr(touched):
                return True
    except Exception:
        pass
    write_quietly(marker, repr(touched))
    return False


def doing_rows(nodes, prefix=""):
    """The plan's `doing` rows at any depth, as (number, title, since)."""
    out = []
    for i, node in enumerate(listed(nodes)):
        if not isinstance(node, dict):
            continue
        num = (prefix + "." if prefix else "") + str(i + 1)
        if node.get("state") == "doing":
            out.append((num, str(node.get("title") or ""), str(node.get("since") or "")))
        out.extend(doing_rows(children(node), num))
    return out


def settle(payload, path):
    """One reminder per set of rows still `doing` at the end of a turn; none when this Stop follows one that kept the
    turn going (stop_hook_active)."""
    if payload.get("stop_hook_active"):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except Exception:
        return None
    rows = doing_rows(plan.get("nodes") if isinstance(plan, dict) else None)
    if not rows:
        return None
    seen = repr(sorted(rows))
    marker = side_file(path, SETTLED_SUFFIX)
    try:
        with open(marker, encoding="utf-8") as fh:
            if fh.read().strip() == seen:
                return None
    except Exception:
        pass
    # If the marker cannot be written, say nothing; otherwise this would repeat at the end of every turn.
    if not write_quietly(marker, seen):
        return None
    shown = "; ".join("%s. %s" % (num, title[:60]) for num, title, _ in rows[:6]) + ("; ..." if len(rows) > 6 else "")
    return ("This turn is ending with %d row%s still `doing`: %s. `doing` is shown as work in progress, so move each one "
            "on now: `done` if finished; `waiting` with %s (and %s for the user) if it waits on someone; or keep it "
            "`doing` and say in %s what is still running for it. %s You will not be asked about these rows again."
            % (len(rows), "" if len(rows) == 1 else "s", shown, WAITING_ON_WORD, QUESTION_WORD, NOTE_WORD,
               settle_how(path)))


# A reply asks the user something when its last paragraph, without code and quoted lines, has a line ending in a
# question mark or one of the phrases below, which hand over a decision with no question mark. They are escapes because
# everything the plugin ships is in English. In order: "waiting for you to decide", "yours to decide", "you decide",
# "you decide", "still waiting for you", "waiting for you to say / answer / reply / confirm / give a word", "needs you
# to decide / confirm / sign off / judge", "only you can decide", "say ... and I will", "one word from you and". Words
# like "which" and "whether" are not on it: they turn up in statements as often as in questions.
CODE_BLOCK = re.compile(r"```.*?```", re.S)
INLINE_CODE = re.compile(r"`[^`\n]*`")
ENDS_IN_QUESTION = re.compile(u"[?\uff1f][)\uff09\u300d\"'*]*[ \t]*$", re.M)
HANDS_OVER = re.compile(
    u"\u7b49\u4f60\u5b9a|\u7531\u4f60\u5b9a|\u4f60\u6765\u5b9a|\u4f60\u5b9a\u5427|\u8fd8\u7b49\u4f60"
    u"|\u7b49\u4f60(?:\u8bf4|\u7b54|\u56de|\u786e\u8ba4|\u4e00\u53e5)"
    u"|\u9700\u8981\u4f60(?:\u51b3\u5b9a|\u786e\u8ba4|\u62cd\u677f|\u5224\u65ad)"
    u"|\u53ea\u6709\u4f60\u80fd\u5b9a"
    u"|\u4f60\u8bf4[^\u3002\n]{0,12}\u6211\u5c31|\u4f60\u4e00\u53e5\u8bdd\u5c31"
    u"|your call|you decide|let me know|waiting (?:for|on) you", re.I)


def asks_user(reply):
    text = INLINE_CODE.sub(" ", CODE_BLOCK.sub(" ", reply))
    text = "\n".join(line for line in text.split("\n") if not line.lstrip().startswith(">"))
    paragraphs = [p for p in re.split(r"\n[ \t]*\n", text) if p.strip()]
    last = paragraphs[-1] if paragraphs else ""
    return bool(ENDS_IN_QUESTION.search(last) or HANDS_OVER.search(last))


def asked_since(nodes, began):
    """Whether some row's `asked` is at or after `began` (epoch seconds). `asked` is written to the second, so the
    comparison is too."""
    for node in listed(nodes):
        if not isinstance(node, dict):
            continue
        at = epoch(node.get("asked")) if node.get("question") else None
        if at is not None and at >= int(began):
            return True
        if asked_since(children(node), began):
            return True
    return False


def unrecorded_question(payload, path, tail):
    """Speaks when the last reply asks the user something and the plan has no record of it.

    The Conversations view lists only the questions written on rows. Measured over one day, conversations that had been
    told to put their questions there still left about four in ten in the reply only.

    The reply comes from the Stop event's `last_assistant_message`. A question counts as recorded when a row command or tool
    stamped its `asked` during the turn; one written straight into the file has no `asked`, so it draws the reminder
    once. It stays quiet on a Stop that follows one that kept the turn going (stop_hook_active), or it would ask again
    after its own reminder.
    """
    if payload.get("stop_hook_active"):
        return None
    reply = payload.get("last_assistant_message")
    if not isinstance(reply, str) or not asks_user(reply):
        return None
    began = turn_began(path, payload)
    if began is None:
        began = turn_shape(tail)[0]
    if began is None:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except Exception:
        return None
    if asked_since(plan.get("nodes") if isinstance(plan, dict) else None, began):
        return None
    return ("Your last reply may be asking the user something, but no row got a question this turn. Put each thing "
            "you need from the user on a row of its own: %s Offers to carry on do not count. If it is already on a row, "
            "or needs no answer, stop here without writing more." % ask_how(path))


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    # Where speaking keeps the turn going, the Stop that follows carries stop_hook_active; saying anything then would be
    # this hook talking to its own reminder.
    if not isinstance(payload, dict) or (STOP_REENTERS and payload.get("stop_hook_active")):
        return 0
    path = plan_file(payload)
    if not path:
        return 0
    limits = settings()
    if not limits["enabled"]:
        return 0
    tail = open_tail(payload.get("transcript_path"))
    if tail is None:
        return 0
    if not os.path.exists(path):
        # Offered once already: nothing left to say, and nothing worth reading the transcript for.
        if os.path.exists(side_file(path, OFFERED_SUFFIX)):
            return 0
        started, tools, _, turns, _ = turn_shape(tail)
        if started is None:
            return 0
        return offer_once(payload, path, tools, turns, limits)
    shape = turn_shape(tail, path, turn_began(path, payload))
    texts = [t for t in (reconcile(path, limits, shape), settle(payload, path), unrecorded_question(payload, path, tail),
                         brief_due(payload, path, shape, limits)) if t]
    return speak(payload, "\n\n".join(texts)) if texts else 0


def reconcile(path, limits, shape):
    started, tools, changed_count, turns, reached = shape
    if started is None:
        return None
    if changed_count < limits["nudgeMinChanges"]:
        return None
    # Reading the plan settles it as much as writing does. Reconciling begins by looking, and a turn that looked and
    # found nothing owed has reconciled - there is nothing else it could do. Without this the reminder had no way to
    # be answered: reading leaves no mark on the file, so it repeated on every working turn for the rest of a
    # conversation whose plan was already correct, which is precisely how a reminder stops being read.
    if reached:
        return None
    try:
        touched = os.stat(path).st_mtime
    except Exception:
        return None
    if touched >= started:
        return None
    if said_already(path, touched):
        return None
    return ((
        "This turn changed %d things and neither read nor updated the work plan (%s). Reconcile it before finishing: "
        "add what this turn opened, close what it finished, and leave the rest alone. Reading it and finding nothing "
        "owed is a complete answer, but read it in the turn so this can tell. Only the user's word moves a row to "
        "\"todo\". This will not be said again until the plan has been written to." % (changed_count, path)))


def status_owed(path, brief, shape, keep):
    """Whether to ask for a new status: the turn made a tool call or the plan was written during it, and the status was
    not, and no earlier Stop in this turn asked already.

    A status written during the turn counts even if rows changed after it. Otherwise a turn that wrote the status and
    then closed a row would be asked for it again.

    One exchange can end in several Stops, so the start time of the turn that was asked goes into `keep`
    (BRIEFED_SUFFIX), and a later Stop in the same turn does not ask again.
    """
    started, tools = shape[0], shape[1]
    if started is None:
        return False
    try:
        written = os.stat(path).st_mtime >= started
    except OSError:
        written = False
    # `statusAt` is written to the second, so the comparison is too.
    if not (tools or written) or (brief["statusAt"] is not None and brief["statusAt"] >= int(started)):
        return False
    if keep.get("statusTurn") == started:
        return False
    keep["statusTurn"] = started
    return True


def read_side(path, suffix):
    try:
        with open(side_file(path, suffix), encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return ""


def read_briefed(path):
    """What the end of a turn last asked about the brief (BRIEFED_SUFFIX), as a dict."""
    try:
        with open(side_file(path, BRIEFED_SUFFIX), encoding="utf-8") as fh:
            kept = json.load(fh)
    except Exception:
        kept = {}
    return kept if isinstance(kept, dict) else {}


def summary_owed(path, plan, brief, kept, keep):
    """Why the summary should be written again, or None.

    It is due when there is none and the plan has rows; when a top-level row was added, removed or closed after it was
    written; and at the end of the first turn after a compaction later than it (COMPACTED_SUFFIX, written by
    resume-work-plan.py), since after a compaction the summary is the main record of what the conversation is for.
    Changes below the top level do not count.

    A reason is not repeated until the plan or the summary changes; what was asked is recorded in `keep`, which the
    caller writes beside the plan (BRIEFED_SUFFIX), and `kept` is that record as it was read. A removed row has no
    timestamp, so removals are found by comparing the number of top-level rows with the number at the first turn to
    end after the summary was written.
    """
    top = [n for n in listed(plan.get("nodes")) if isinstance(n, dict)]
    stamp = brief["summaryStamp"] if isinstance(brief["summaryStamp"], str) else ""
    if keep.get("summaryAt") != stamp or not isinstance(keep.get("top"), int):
        keep["summaryAt"], keep["top"] = stamp, len(top)
    at = brief["summaryAt"]
    reasons, key = [], None
    if not brief["summary"]:
        if top:
            reasons.append("has not been written, and the plan has rows")
            key = ["none", len(top)]
    elif at is not None:
        after = lambda field: [i + 1 for i, n in enumerate(top) if (epoch(n.get(field)) or 0) > at]
        closed = [i for i in after("closed") if top[i - 1].get("state") in CLOSED_STATES]
        opened = after("opened")
        if closed:
            reasons.append("was written before row%s %s at the top of the plan %s closed" % (
                "" if len(closed) == 1 else "s", ", ".join(map(str, closed)), "was" if len(closed) == 1 else "were"))
        if opened or len(top) != keep["top"]:
            reasons.append("was written before rows were added to or taken out of the top of the plan")
        if reasons:
            key = [stamp, closed, opened, len(top)]
    if key is not None and keep.get("asked") == key:
        reasons, key = [], None
    marker = read_side(path, COMPACTED_SUFFIX)
    compacted = epoch(marker)
    if compacted is not None and (at is None or compacted > at) and kept.get("compacted") != marker and brief["summary"]:
        reasons.append("was written before the context was compacted")
        keep["compacted"] = marker
    if key is not None:
        keep["asked"] = key
    return "; it ".join(reasons) or None


def brief_due(payload, path, shape, limits):
    """One paragraph asking for whichever parts of the brief are out of date, or None.

    Nothing is asked when stop_hook_active is set, because that Stop follows this hook's own reminder.
    """
    if not limits["brief"] or payload.get("stop_hook_active"):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except Exception:
        return None
    if not isinstance(plan, dict):
        return None
    brief = brief_of(plan)
    kept = read_briefed(path)
    keep = dict(kept)
    summary = summary_owed(path, plan, brief, kept, keep)
    status = status_owed(path, brief, shape, keep)
    if keep != kept and not write_quietly(side_file(path, BRIEFED_SUFFIX), json.dumps(keep)):
        # Without the record, the same request would be made at the end of every turn, or at every Stop of one.
        return None
    if not summary and not status:
        return None
    said, parts = [], []
    if summary:
        parts.append("summary")
        said.append("The summary of this conversation %s. It says what the conversation is for, the stage it has "
                    "reached, and the decisions made that later work must not forget, at most %d wide."
                    % (summary, BRIEF_WIDTH["summary"]))
    if status:
        parts.append("status")
        said.append("This turn did work, and the status %s. It says in three parts what you are doing (at most %d wide), "
                    "the latest progress (%d), and who it waits on or the next step (%d); write none in a part with "
                    "nothing to say." % ("has not been written yet" if brief["statusAt"] is None
                                         else "was last written before the turn began",
                                         BRIEF_WIDTH["doing"], BRIEF_WIDTH["progress"], BRIEF_WIDTH["next"]))
    said.append("Write for someone who stepped away and has to pick up the moment they are back: in the language this "
                "conversation is held in, with no names coined during it, the gist and not the details. A width counts a "
                "CJK character as 2 and any other as 1. %s" % brief_how(path, parts))
    return " ".join(said)


if __name__ == "__main__":
    sys.exit(main())
