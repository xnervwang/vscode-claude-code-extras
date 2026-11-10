#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/hooks/plan-row.py; sync-shared.js copies it, so edit it there.

"""Change one row of a work plan, or add a row: the state, the note, the description, and the times that go with them.

  plan-row.py PLAN set ROW [STATE] [--note TEXT] [--detail TEXT] [--waiting-on WHO] [--question TEXT]
  plan-row.py PLAN add STATE TITLE [--under ROW] [--note TEXT] [--waiting-on WHO] [--question TEXT]

ROW is the number shown in front of a row, closed rows counted: 3 is the third row at the top, 2.1 the first one under
the second. Not a hook: the model runs it, and the injected block gives its full path every turn. In Codex, plan-mcp.py
also calls run() for the model's set_row and add_row tools.

It exists because a change of state is one simple action and was being paid for as a large one. Done by hand it means
reading the whole file, changing one field and writing all of it back - of 884 writes to plans measured on the machine
this was written on, 643 went through the shell, mostly as a script composed for the occasion - and reading the clock
first, which is the step that gets skipped or invented. A cost like that is a reason to save every change for one write
at the end of the turn, and `doing` is the one state that cannot wait that long.

The caller picks the row and the state. The file is read just before the write and plan_lock is held from that read
through the write, so neither a manual edit made a moment earlier nor a concurrent change by another run or the
extension is lost.
"""
import argparse
import json
import os
import sys

# Set before the import below: see inject-work-plan.py.
sys.dont_write_bytecode = True
# The script's folder on the import path: see inject-work-plan.py.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import (CLOSED_STATES, HELD_STATES, MAX_DETAIL_CHARS, MAX_DETAIL_LINES, MAX_QUESTION_CHARS, PLAN_NAME,
                       SESSION_HINT, SETTING_PREFIX, STATES, WAITING_ON, detail_over, now_stamp, plan_lock, questions_in,
                       settings, write_atomic)


class Refused(Exception):
    pass


def find(nodes, number):
    """The row a number names, counted the way the injected block and the tree count it, or None."""
    node, level = None, nodes
    for part in str(number).split("."):
        if not part.isdigit() or int(part) < 1:
            return None
        i = int(part) - 1
        if not isinstance(level, list) or i >= len(level) or not isinstance(level[i], dict):
            return None
        node = level[i]
        level = node.get("children")
    return node


def enter(node, state, now):
    """Put a row in a state, with the times that belong to it.

    `since` says when the row entered the state it is in, which is how long a `doing` or a `waiting` row has been one.
    `closed` belongs to the two closed states only: a row reopened keeps nothing claiming it had ended.
    """
    node["state"] = state
    node["since"] = now
    if state in CLOSED_STATES:
        node["closed"] = now
    else:
        node.pop("closed", None)


def note(node, text):
    if text is None:
        return
    if text.strip():
        node["note"] = text.strip()
    else:
        node.pop("note", None)


def detail(node, text):
    """Replace the row's description; an empty one removes it. Past the limit the whole command is refused.

    The limit is the one the view cuts at and the guard enforces on a Write or Edit, so a description set here is never
    one the view would show cut short.
    """
    if text is None:
        return
    how = detail_over(text)
    if how:
        raise Refused("That description is %s; the limit is %d lines and %d characters, which is where the view cuts it. "
                      "Say what picking the task up needs, not how it got here." % (how, MAX_DETAIL_LINES, MAX_DETAIL_CHARS))
    if text.strip():
        node["detail"] = text.strip()
    else:
        node.pop("detail", None)


def hold(node, changed, who, question, now):
    """Say who a held-up row waits on and, when that is the user, the question they have to answer.

    These are fields rather than words in the note because the list of what waits on the user, across conversations, is
    built from them. So they are checked here, when the row is written.

    A change of state drops both unless the same command gives them again: a row moved on from `waiting` that still said
    it waited on the user would go on asking a question nobody needs answered. Raises Refused before anything is
    written.

    `asked` dates the question and `since` the waiting: a row can wait for days and then be given a new question.
    """
    if changed:
        node.pop("waitingOn", None)
        node.pop("question", None)
        node.pop("asked", None)
    if who is not None:
        who = who.strip()
        if who and who not in WAITING_ON:
            raise Refused("--waiting-on is one of %s, not %r." % (", ".join(WAITING_ON), who))
        if who:
            node["waitingOn"] = who
        else:
            node.pop("waitingOn", None)
            node.pop("question", None)
            node.pop("asked", None)
    if question is not None:
        asked = " ".join(question.split())
        if len(asked) > MAX_QUESTION_CHARS:
            raise Refused("That question is %d characters; keep it to one sentence of at most %d that the user can answer "
                          "as it stands. Anything longer belongs in --detail." % (len(asked), MAX_QUESTION_CHARS))
        if questions_in(asked) > 1:
            raise Refused("That has %d question marks; a row carries one question. Keep one here and add a row under "
                          "this one for each of the others: add waiting TITLE --under ROW --waiting-on user --question "
                          "TEXT." % questions_in(asked))
        if asked and asked != node.get("question"):
            node["question"] = asked
            node["asked"] = now
        elif not asked:
            node.pop("question", None)
            node.pop("asked", None)
    state = node.get("state", "todo")
    on = node.get("waitingOn")
    if on and state not in HELD_STATES:
        raise Refused("Only a waiting or a discussing row waits on someone, and this one is %s." % state)
    if on and state == "discussing" and on != "user":
        raise Refused("A discussing row waits on nobody but the user, whose word it needs before it can be agreed.")
    if changed and state == "waiting" and not on:
        raise Refused("Say who this row now waits on, with --waiting-on: user (the person in this conversation), build "
                      "(CI or a build), someone (a reviewer or anyone else), session (another conversation) or other. "
                      "When it is the user, add --question.")
    if node.get("question") and on != "user":
        raise Refused("A question is what the user has to answer, so it goes with --waiting-on user.")
    if on == "user" and not node.get("question"):
        raise Refused("A row waiting on the user carries what they have to answer: give --question, one sentence they "
                      "can answer as it stands without reading the conversation.")


def load(path, may_create):
    try:
        with open(path, encoding="utf-8") as fh:
            body = fh.read()
    except FileNotFoundError:
        if may_create:
            return {"nodes": []}
        raise Refused("There is no plan at %s yet. Adding a row starts one." % path)
    try:
        plan = json.loads(body)
    except ValueError as e:
        raise Refused("The plan at %s does not parse (%s). Fix it by hand rather than through this." % (path, e))
    if not isinstance(plan, dict) or not isinstance(plan.get("nodes"), list):
        raise Refused("%s has no list of rows in it, so it is not a work plan." % path)
    return plan


def save(path, plan):
    """Write the whole file and rename it into place, so the tree never reads half of one."""
    write_atomic(path, json.dumps(plan, ensure_ascii=False, indent=2) + "\n")


def run(args):
    path = os.path.abspath(args.plan)
    if not PLAN_NAME.match(os.path.basename(path)):
        raise Refused("%s is not a work plan: a plan is named by its conversation's session id." % path)
    if not settings(os.path.dirname(path))["enabled"]:
        raise Refused("Work plans are switched off for this editor (%s.workPlan), so nothing reads this "
                      "file. Track what is left in your reply instead." % SETTING_PREFIX)
    if args.action == "add":
        # The first row of a conversation can come before anything has made the plugin's data directory.
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
        except OSError as e:
            raise Refused("Could not create %s for the plan (%s)." % (os.path.dirname(path), e.strerror or e))
    missed = []
    with plan_lock(path, missed.append) as held:
        if not held and missed:
            raise Refused("Nothing was written, because the plan's lock could not be taken: %s. Run the same command "
                          "again." % missed[0])
        return change(path, args)


def change(path, args):
    plan = load(path, args.action == "add")
    now = now_stamp()
    if args.action == "set":
        if args.state is None and args.note is None and args.detail is None and args.waiting_on is None \
                and args.question is None:
            raise Refused("Nothing to change: give a state, --note, --detail, --waiting-on or --question.")
        node = find(plan["nodes"], args.row)
        if node is None:
            raise Refused("There is no row %s in this plan." % args.row)
        was = node.get("state", "todo")
        detail(node, args.detail)
        # The state a row is already in is not entered again: `since` says how long it has been in it, and a command
        # that only rewrites the description must not restart that clock.
        changed = args.state is not None and args.state != was
        if changed:
            enter(node, args.state, now)
            said = "row %s: %s -> %s" % (args.row, was, args.state)
        else:
            said = "row %s: still %s" % (args.row, was)
        hold(node, changed, args.waiting_on, args.question, now)
        if node.get("waitingOn"):
            said += ", on %s" % node["waitingOn"]
        note(node, args.note)
        if args.detail is not None:
            said += ", description %s" % ("set" if args.detail.strip() else "removed")
    else:
        title = args.title.strip()
        if not title:
            raise Refused("A row needs a title.")
        if args.under:
            parent = find(plan["nodes"], args.under)
            if parent is None:
                raise Refused("There is no row %s to add this under." % args.under)
            if not isinstance(parent.get("children"), list):
                parent["children"] = []
            siblings, prefix = parent["children"], args.under + "."
        else:
            siblings, prefix = plan["nodes"], ""
        node = {"title": title, "state": args.state}
        note(node, args.note)
        node["opened"] = now
        enter(node, args.state, now)
        hold(node, True, args.waiting_on, args.question, now)
        node["children"] = []
        siblings.append(node)
        said = "row %s%d added: %s" % (prefix, len(siblings), args.state)
        if node.get("waitingOn"):
            said += ", on %s" % node["waitingOn"]
    save(path, plan)
    if (args.waiting_on or "").strip() == "session":
        said += ". " + SESSION_HINT
    return said


def main(argv=None):
    parser = argparse.ArgumentParser(prog="plan-row.py", description="Change the state of one row of a work plan, "
                                     "or add a row. The times are read from the clock.")
    parser.add_argument("plan", help="the plan file, as given at the top of the injected block")
    actions = parser.add_subparsers(dest="action")
    actions.required = True
    change = actions.add_parser("set", help="put a row in a state, or change its note or description")
    change.add_argument("row", help="the number shown in front of the row, such as 3 or 2.1")
    change.add_argument("state", nargs="?", choices=STATES, help="leave it out to keep the state the row is in")
    change.add_argument("--note", help="replace the row's note; an empty one removes it")
    change.add_argument("--detail", help="replace the row's description; an empty one removes it")
    change.add_argument("--waiting-on", metavar="WHO", help="who a waiting row waits on: %s; an empty one removes it"
                        % ", ".join(WAITING_ON))
    change.add_argument("--question", help="with --waiting-on user: the one question the user has to answer")
    add = actions.add_parser("add", help="add a row, at the end of the plan or under another row")
    add.add_argument("state", choices=STATES)
    add.add_argument("title")
    add.add_argument("--under", metavar="ROW", help="the row to add it under")
    add.add_argument("--note")
    add.add_argument("--waiting-on", metavar="WHO", help="who a waiting row waits on: %s" % ", ".join(WAITING_ON))
    add.add_argument("--question", help="with --waiting-on user: the one question the user has to answer")
    args = parser.parse_args(argv)
    # Python on Windows encodes a pipe in the console's code page; titles need UTF-8.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        print(run(args))
    except Refused as e:
        print(str(e), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
