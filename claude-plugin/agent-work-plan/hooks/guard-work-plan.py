#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Refuse a write to the work plan that carries a description longer than the view will show, or a question that asks
more than one thing.

The limit itself is explained in the skill: a description is what the next person needs in order to pick the task up,
not the story of how the task got there, and given room the story is what gets written. Until now the limit lived in two
places that both come after the fact - the skill asking for it, and the view cutting what it was given. Neither stops an
over-long description from being written, and the one that cuts it does so where the reader is, not where the writer is.

So this refuses the write. The criterion is exactly the one the view uses, which is the only way the two can agree: what
is rejected here is precisely what would have been cut there.

What it does not cover: a plan file written through Bash - a heredoc, python -c, sed. Finding a JSON payload inside a
shell command is not something that can be done reliably, and a gate that half-reads shell would refuse legitimate
commands while still missing the ones that mattered. The tools that actually write this file are Write and Edit.
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

from plan_path import MAX_DETAIL_CHARS, MAX_DETAIL_LINES, PLAN_NAME, data_dir, questions_in, read_payload, settings
from plan_path import detail_over as over

# Enough of a title to recognise the row by; a rejection has to say which description, not merely that there was one.
TITLE_SHOWN = 60


def several(question):
    n = questions_in(question) if isinstance(question, str) else 0
    return "%d questions in one" % n if n > 1 else ""


def walk(nodes, found, depth=0):
    """(title, how) for every row whose description is too long or whose question has several question marks."""
    if depth > 16 or not isinstance(nodes, list):
        return
    for node in nodes:
        if not isinstance(node, dict):
            continue
        title = str(node.get("title") or "(untitled)")[:TITLE_SHOWN]
        for how in (over(node.get("detail") or ""), several(node.get("question"))):
            if how:
                found.append((title, how))
        walk(node.get("children"), found, depth + 1)


def from_json(body):
    """The offending rows in a whole plan file, or None when this is not one.

    A document with no list of nodes in it is not a plan, whatever else it parses as - so it is reported as unreadable
    rather than as clean. Returning an empty answer for it would say the opposite: an over-long description under a key
    spelled some other way would have been let through in silence, which is the one outcome this must not produce.
    """
    try:
        parsed = json.loads(body)
    except Exception:
        return None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("nodes"), list):
        return None
    found = []
    walk(parsed.get("nodes"), found)
    return found


def from_fragment(body):
    """The offending rows in a piece of a plan file, found by reading the JSON strings assigned to "detail".

    For an Edit whose result could not be assembled. A description is written as one JSON string, so the value is intact
    here even though the document around it is not; what is lost is the title next to it, hence the placeholder.
    """
    found = []
    for key, rule in (("detail", over), ("question", several)):
        for raw in re.findall(r'"%s"\s*:\s*("(?:[^"\\]|\\.)*")' % key, body):
            try:
                how = rule(json.loads(raw))
            except Exception:
                continue
            if how:
                found.append(("(a row in this edit)", how))
    return found


def after_edit(path, tool_input):
    """The file as this edit would leave it, or None when that cannot be worked out."""
    old = tool_input.get("old_string")
    new = tool_input.get("new_string")
    if not isinstance(old, str) or not isinstance(new, str):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            body = fh.read()
    except Exception:
        return None
    if tool_input.get("replace_all"):
        return body.replace(old, new)
    # Exactly one occurrence is also Edit's own requirement, so anything else is a call that will fail on its own terms.
    if body.count(old) != 1:
        return None
    return body.replace(old, new, 1)


def guarded(path):
    """Whether this path is a work plan: the plugin's own data directory, and a name a plan is given."""
    if not isinstance(path, str) or not path:
        return False
    try:
        here = os.path.realpath(path)
    except Exception:
        return False
    if os.path.dirname(here) != os.path.realpath(data_dir()):
        return False
    return bool(PLAN_NAME.match(os.path.basename(here)))


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    # Valid JSON that is not an object parses without complaint, so the guard above does not cover it. A hook that ends
    # in a traceback puts its own failure in front of the reader, in place of the tool call it was asked about.
    if not isinstance(payload, dict):
        return 0
    tool = payload.get("tool_name")
    tool_input = payload.get("tool_input") or {}
    if tool not in ("Write", "Edit") or not isinstance(tool_input, dict):
        return 0
    path = tool_input.get("file_path")
    if not guarded(path):
        return 0

    # Switched off, this is the one place that can still stop a plan being kept. The other two hooks fall silent, but the
    # skill's description stays in front of the model while the plugin is loaded, so an agent can decide on its own to
    # maintain the file - and a plan kept where nobody can see it is the cost of the feature with none of the use. Said
    # out loud rather than refused in silence, or the next thing tried is a way around it.
    if not settings()["enabled"]:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": payload.get("hook_event_name", "PreToolUse"),
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "Work plans are switched off for this editor (claudeCodePlus.workPlan), so nothing reads this file and "
                "the view for it is hidden. Do not keep one, and do not work around this by writing somewhere else: "
                "track what is left in your reply instead. Turn the setting back on to use plans again."),
        }}))
        return 0

    if tool == "Write":
        body = tool_input.get("content")
        body = body if isinstance(body, str) else ""
        found = from_json(body)
        if found is None:
            # Not valid JSON at all. That is a defect in what wrote it, but it is not this gate's business: refusing
            # here would mean this hook decides what a plan file may contain, which is a much larger claim.
            found = from_fragment(body)
    else:
        result = after_edit(path, tool_input)
        found = from_json(result) if result is not None else None
        if found is None:
            found = from_fragment(tool_input.get("new_string") or "")

    if not found:
        return 0

    rows = "\n".join("  - %s  (%s)" % (title, how) for title, how in found[:8])
    if len(found) > 8:
        rows += "\n  - ... and %d more" % (len(found) - 8)
    asks = any(how.endswith("questions in one") for _, how in found)
    long_ = any(not how.endswith("questions in one") for _, how in found)
    reason = "These rows break the work plan's limits:\n%s\n\n" % rows
    if long_:
        reason += ("A description is limited to %d lines and %d characters, and the view cuts it there. It is what "
                   "the next person needs in order to pick the task up - the user's own words, what is already "
                   "settled, the trap to avoid - not how the task got here. The reasoning belongs in the commit "
                   "message, a rule that came out of it in that rule, a measurement where the measurement lives. "
                   % (MAX_DETAIL_LINES, MAX_DETAIL_CHARS))
    if asks:
        reason += ("Each question needs a row of its own: keep one here and move the others to new rows under this "
                   "one, waiting on the user. ")
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": payload.get("hook_event_name", "PreToolUse"),
        "permissionDecision": "deny",
        "permissionDecisionReason": reason + "Then write again.",
    }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
