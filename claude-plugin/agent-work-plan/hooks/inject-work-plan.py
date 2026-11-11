#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/hooks/inject-work-plan.py; sync-shared.js copies it, so edit it there.

"""Put this conversation's work plan in front of the model, every turn.

This is the load-bearing half of the plugin, and the reason it is a hook rather than part of the skill: a skill is
loaded when its description matches the request, so it is absent on exactly the turn that wanders off - which is the
only turn where being reminded of the main line matters. Measured over 1324 turns that had a plan put in front of them,
the skill was loaded 12 times. So whatever a model has to know in order to keep the plan right is said here, and the
skill is where it is explained at length.

Only the open rows are injected. The closed ones are history; sending them every turn would cost context to say
nothing, and the file itself is there for anyone who wants the whole thing.

Every turn gets something, so that the plan stays in front of the model, but only what changed is said at length:

  - the whole block, with the explanation of the states and of the row command, on a conversation's first injection
    and on the first one after each compaction (COMPACTED_SUFFIX, written by resume-work-plan.py);
  - on other turns a short head in its place;
  - one line, with how many rows are doing and waiting and where the file is, when the rows are what they were at the
    last injection apart from how long they have been in their state. What was last shown is kept beside the plan
    (INJECTED_SUFFIX). The brief is not compared: the agent writes its status at the end of most turns that did work, so
    counting it would leave almost no plan unchanged.

A `doing` row and a row asking the user carry their note or question, cut at NOTED_CHARS; every other row is its title,
cut at TITLE_CHARS. The whole text stays within MAX_CHARS, the brief included, and says how many open rows it left
out. Claude Code saves a hook's output of more than 10,000 characters to a file and shows the model the first 2,000,
which for a long plan is a few of its rows.

Silence is the normal case. A conversation that keeps no plan gets nothing, so installing this plugin costs nothing
until something starts writing one.

It also leaves a mark beside the plan saying which turn this is and when it began, for the hooks that watch the turn:
remind-work-plan.py after tool calls, and nudge-work-plan.py at its end, which takes the turn's start from
it. The mark is written as soon as the plan has been read, before the check that may skip injecting: a plan whose rows
are all closed injects nothing, but those hooks still need the mark for new work started in that turn. A conversation
with no plan, or one whose plan does not parse, gets no mark.
"""
import hashlib
import json
import os
import sys
import time

# Set before the import below: importing a module next to this one otherwise leaves compiled bytecode in the installed
# plugin directory, and a hook that runs on every turn should leave nothing behind in a directory the platform manages.
sys.dont_write_bytecode = True
# A Python started from a ._pth file, as the embeddable build for Windows is, does not put the script's folder on
# the import path, and plan_path is in it.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import (COMPACTED_SUFFIX, INJECTED_SUFFIX, OPEN_STATES, QUESTION_WORD, STATUS_PARTS, TURN_FIELD,
                       WAITING_ON, WAITING_ON_WORD, any_in, brief_of, children, epoch, launcher_quoted, listed, plan_file,
                       read_payload, row_command, row_gist, row_help, settings, side_file, write_quietly, write_turn)

GLYPH = {"discussing": "?", "todo": "o", "doing": ">", "waiting": "~", "parked": "=", "done": "+", "dropped": "x"}
LEGEND = "> doing, ? discussing, o todo, ~ waiting, = parked"
# Row cap for the injected block. Top-level rows are always drawn; only the rows under them are cut (see rows).
MAX_ROWS = 40
# The longest the injected text may be, brief included.
MAX_CHARS = 6000
TITLE_CHARS = 80
NOTED_CHARS = 200
# The two states a row is meant to leave soon, so how long one has been in either is worth saying: a row `doing` for
# three days is not being done, and nothing else on the row shows that. Measured on the machine this was written on, the
# six rows then `doing` included two added four days earlier, and four whose own notes said they were waiting on someone.
TIMED = ("doing", "waiting")


def age(seconds):
    if seconds < 3600:
        return "%dm" % max(1, seconds // 60)
    if seconds < 48 * 3600:
        return "%dh" % (seconds // 3600)
    return "%dd" % (seconds // 86400)


def shown(node):
    """A row is drawn if it has a title and it or a descendant is open; a closed parent of open work is kept as its
    context."""
    return (isinstance(node, dict) and bool(str(node.get("title", "")).strip())
            and (node.get("state", "todo") in OPEN_STATES or any_open(children(node))))


def open_below(node):
    """How many open rows drawing `node` would show, itself included."""
    if not shown(node):
        return 0
    return int(node.get("state", "todo") in OPEN_STATES) + sum(open_below(k) for k in children(node))


def numbered(nodes, prefix):
    """The rows in reverse order, each with its number.

    Reversed like the tree view, numbered by file position: rows are only appended, so the end of the file is the
    current work, and when rows have to be cut the oldest go first.
    """
    return list(reversed([("%s%d" % (prefix + "." if prefix else "", i + 1), node)
                          for i, node in enumerate(listed(nodes))]))


def one_line(text):
    return " ".join(str(text).split())


def cut(text, limit):
    return text if len(text) <= limit else text[:limit - 1] + u"\u2026"


def asks(node):
    """Whether a row puts a question to the user."""
    return node.get("waitingOn") == "user" and bool(str(node.get("question", "")).strip())


def line(node, num, depth, now):
    """A row as one line. When `now` is None the time in the state is left out, which is how two injections are
    compared."""
    state = node.get("state", "todo")
    title = one_line(node.get("title", ""))
    # The dot is only in what is drawn; `num` stays bare because children are numbered from it.
    lead = "%s%s %s. " % ("  " * depth, GLYPH.get(state, "o"), num)
    if state != "doing" and not asks(node):
        return lead + cut(title, TITLE_CHARS)
    note = one_line(node.get("note", ""))
    said = str(state)
    on = node.get("waitingOn")
    if on in WAITING_ON:
        said += " on " + on
    if state in TIMED and now is not None:
        since = epoch(node.get("since"))
        if since is not None and now >= since:
            said += " for " + age(int(now - since))
    asked = one_line(node.get("question", "")) if on == "user" else ""
    return lead + cut("%s   [%s%s%s]" % (cut(title, TITLE_CHARS), said, " · asks: " + asked if asked else "",
                                         " · " + note if note else ""), NOTED_CHARS)


def unsaid(nodes, prefix=""):
    """The numbers of the `waiting` rows that do not say who they wait on."""
    out = []
    for i, node in enumerate(listed(nodes)):
        if isinstance(node, dict):
            num = "%s%d" % (prefix + "." if prefix else "", i + 1)
            if node.get("state") == "waiting" and node.get("waitingOn") not in WAITING_ON:
                out.append(num)
            out.extend(unsaid(children(node), num))
    return out


def rows(nodes, now, limit=MAX_ROWS):
    """The open rows as (line, the same line without how long the row has been in its state, whether the row is open),
    each numbered by where it sits in the file, and how many open rows did not fit.

    The number is what a person says to point at a row, so it comes from the file rather than from what is on screen:
    closed rows are skipped when drawing but still counted, or finishing one would renumber everything after it and a
    number quoted yesterday would mean a different row today. The same numbers appear in the tree view, computed the same
    way, because two places disagreeing about which row is 3 would be worse than neither showing a number.

    Every top-level row is drawn, and the rows under them share what is left of `limit`, newest first. Cutting depth
    first would let the newest row's subtree take every line and hide the other open work at the top, with nothing to
    show it was there.
    """
    top = [(num, node) for num, node in numbered(nodes, "") if shown(node)]
    room = [max(0, limit - len(top))]
    out, left = [], [0]
    for num, node in top:
        out.append(entry(node, num, 0, now))
        below(children(node), 1, out, now, num, room, left)
    return out, left[0]


def entry(node, num, depth, now):
    return (line(node, num, depth, now), line(node, num, depth, None), node.get("state", "todo") in OPEN_STATES)


def below(nodes, depth, out, now, prefix, room, left):
    for num, node in numbered(nodes, prefix):
        if not shown(node):
            continue
        if room[0] <= 0:
            left[0] += open_below(node)
            continue
        room[0] -= 1
        out.append(entry(node, num, depth, now))
        below(children(node), depth + 1, out, now, num, room, left)


def any_open(nodes):
    return any(isinstance(n, dict) and (n.get("state", "todo") in OPEN_STATES or any_open(children(n)))
               for n in listed(nodes))


def counts(nodes, acc=None):
    acc = acc if acc is not None else {}
    for node in listed(nodes):
        if not isinstance(node, dict):
            continue
        state = node.get("state", "todo")
        acc[state] = acc.get(state, 0) + 1
        counts(children(node), acc)
    return acc


def brief_lines(plan, now):
    """The brief as last written and the age of each part, so the agent updates it rather than starting over. Empty when
    there is no brief."""
    brief = brief_of(plan)
    ago = lambda at: " %s ago" % age(int(now - at)) if at is not None and now >= at else ""
    out = []
    if brief["summary"]:
        out.append("  Summary, written%s: %s" % (ago(brief["summaryAt"]), " ".join(brief["summary"].split())))
    if brief["status"]:
        out.append("  Status, written%s: %s" % (ago(brief["statusAt"]), " · ".join(
            "%s: %s" % (part, brief["status"][part]) for part in STATUS_PARTS if part in brief["status"])))
    return ["", "Your brief of this conversation, which the Conversations panel shows when its row is clicked:"] + out if out else []


def read_side_text(path, suffix):
    try:
        with open(side_file(path, suffix), encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return ""


def read_side_json(path, suffix):
    try:
        value = json.loads(read_side_text(path, suffix))
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def block(plan, nodes, path, head, missing, out, left, now, whole, with_brief):
    """The injected text when rows are shown: the whole explanation when `whole`, else a short head."""
    command = row_command(path)
    doing = any_in(nodes, "doing")
    # What is said about `doing` is here rather than only in the skill because here is the one moment that comes BEFORE
    # the work, and the skill is rarely loaded at all. A row marked as the work starts shows up in the tree while the
    # turn runs, which is the whole point of the state.
    #
    # The line after it changes with the plan rather than being the same every turn: a sentence repeated word for word
    # on every turn is the one most easily read past, and "nothing is doing" is a fact about this turn that the model can
    # check against what it is about to do.
    left_doing = ("A row that is `doing` now was left that way by an earlier turn: unless this turn carries on with it, or "
                  "an agent you started is still working on it, move it on.")
    if whole:
        lines = [
            "This conversation's work plan (%s). Only open rows are shown; the file is %s." % (head or "nothing open", path),
            "A child is something that has to be finished before its parent can be. Each row starts with its state: %s; "
            "a closed row (+ done, x dropped) is shown only above open rows under it. Only `doing` rows and questions to "
            "the user carry their notes here." % LEGEND,
            "Set a row to `doing` as you start on it, not afterwards. Work the user asks for in this message goes in as "
            "`doing` as soon as you start on it, and so does a request to look into something. When you stop working on a "
            "row, move it on: `done` if it is finished, `waiting` if it now waits on someone else. A `waiting` row says who "
            "with %s (user, build, someone, session, other), and one waiting on the user carries %s: the one sentence "
            "they have to answer, answerable without reading the conversation. A `discussing` row you have put to the user "
            "for a decision can say %s user with its question too." % (WAITING_ON_WORD, QUESTION_WORD, WAITING_ON_WORD),
            left_doing if doing else "Nothing is `doing` right now.",
        ] + row_help(path, command, launcher_quoted())
    else:
        lines = ["This conversation's work plan (%s), changed since it was last shown; the file is %s. Rows start with "
                 "their state (%s). Set a row to `doing` as you start on it, and move it on when it is done or waits on "
                 "someone: %s." % (head or "nothing open", path, LEGEND, row_gist(path, command))]
        if doing:
            lines.append(left_doing)
    if missing:
        lines.append("%s %s not say who %s for (row%s %s). Give each one %s when you next touch it." % (
            "%d waiting row%s" % (len(missing), "" if len(missing) == 1 else "s"), "does" if len(missing) == 1 else "do",
            "it waits" if len(missing) == 1 else "they wait", "" if len(missing) == 1 else "s", ", ".join(missing[:12]),
            WAITING_ON_WORD))
    tail = brief_lines(plan, now) if with_brief else []
    return fit(lines + [""], out, left, tail)


def fit(head, out, left, tail):
    """`head`, as many of the row lines in `out` as fit within MAX_CHARS, a line on the open rows left out, and `tail`."""
    more = lambda k: "... %d more open row%s, see the file" % (k, "" if k == 1 else "s")
    room = MAX_CHARS - len("\n".join(head + tail)) - len(more(len(out) + left)) - 2
    kept = []
    for shown_line, _, _ in out:
        if room - len(shown_line) - 1 < 0:
            break
        room -= len(shown_line) + 1
        kept.append(shown_line)
    left += sum(1 for _, _, is_open in out[len(kept):] if is_open)
    return "\n".join(head + kept + ([more(left)] if left else []) + tail)


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    limits = settings()
    if not isinstance(payload, dict) or not limits["enabled"]:
        return 0
    path = plan_file(payload)
    if not path:
        return 0
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except Exception:
        # Absent is ordinary; half-written is transient and fixes itself on the next turn. Neither is worth saying.
        return 0
    if not isinstance(plan, dict):
        return 0
    now = time.time()
    prompt = payload.get(TURN_FIELD)
    if isinstance(prompt, str) and prompt:
        write_turn(path, {"prompt": prompt, "began": now, "changes": 0, "reminded": False})
    nodes = listed(plan.get("nodes"))
    out, left = rows(nodes, now)
    if not out:
        return 0
    n = counts(nodes)
    head = " · ".join("%d %s" % (n[s], s) for s in OPEN_STATES if n.get(s))
    closed = n.get("done", 0) + n.get("dropped", 0)
    if closed:
        head += " · %d closed" % closed
    missing = unsaid(nodes)
    digest = hashlib.sha1("\n".join([head, ",".join(missing), str(left)] + [o[1] for o in out]).encode("utf-8")).hexdigest()
    last = read_side_json(path, INJECTED_SUFFIX)
    compacted = read_side_text(path, COMPACTED_SUFFIX)
    whole = not last or (bool(compacted) and last.get("compacted") != compacted)
    if not whole and last.get("digest") == digest:
        text = ("This conversation's work plan has not changed since it was last shown: %d doing, %d waiting, %d open in "
                "all; the file is %s. Set a row to `doing` as you start on it." % (
                    n.get("doing", 0), n.get("waiting", 0), sum(n.get(s, 0) for s in OPEN_STATES), path))
    else:
        text = block(plan, nodes, path, head, missing, out, left, now, whole, limits["brief"])
    write_quietly(side_file(path, INJECTED_SUFFIX), json.dumps(
        {"digest": digest, "compacted": compacted if whole else last.get("compacted", "")}))
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": payload.get("hook_event_name", "UserPromptSubmit"),
        "additionalContext": text,
    }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
