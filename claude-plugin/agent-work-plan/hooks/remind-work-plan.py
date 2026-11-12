#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/hooks/remind-work-plan.py; sync-shared.js copies it, so edit it there.

"""Say so, once, when a turn starts working and no row of the work plan is `doing`.

The injection asks for `doing` at the start of every turn, and a turn that keeps the plan only as bookkeeping before
its closing summary leaves the tree beside the conversation showing nothing being worked on for the whole time the work
runs - the one time the state is any use. So this speaks at the moment the work starts rather than at either end of the
turn.

Claude Code runs this after each batch of tool calls (PostToolBatch). Codex has no such event, so there it runs after
every call (PostToolUse). Either way it keeps its count in the turn mark the injection hook left (see plan_path.py), and
it speaks only when all of these hold:
  - this is the main thread, not a sub-agent;
  - the turn has made at least remindMinCalls calls or changed at least nudgeMinChanges things, not counting the
    plan's own;
  - no row is `doing`;
  - it has not already spoken in this turn.

It refuses nothing and does not guess which row is being worked on: that is a judgement about the work, which a script
cannot make. Without the turn mark there is nothing to go on, and it stays silent.
"""
import json
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from changes import changes
from plan_path import (REMIND_EVENT, TURN_FIELD, any_in, event_calls, keeps_plan, plan_file, read_payload, read_turn,
                       remind_how, settings, write_turn)


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    if not isinstance(payload, dict) or payload.get("agent_id"):
        return 0
    calls = event_calls(payload)
    path = plan_file(payload) if calls else None
    if not path:
        return 0
    name = os.path.basename(path)
    # A call that goes to the plan is the plan being kept, not the work it describes.
    work = [(tool, given) for tool, given in calls if not keeps_plan(tool, given, name)]
    if not work:
        return 0
    prompt = payload.get(TURN_FIELD)
    if not isinstance(prompt, str) or not prompt:
        return 0
    turn = read_turn(path)
    # A steward looking into a notice has no row of its own to mark doing.
    if (not turn or turn.get("prompt") != prompt or turn.get("reminded") or turn.get("settled")
            or turn.get("notice") is True):
        return 0
    limits = settings()
    if not limits["enabled"]:
        return 0
    turn["calls"] = count(turn.get("calls")) + len(work)
    turn["changes"] = count(turn.get("changes")) + sum(1 for tool, given in work if changes(tool, given))
    if turn["calls"] < limits["remindMinCalls"] and turn["changes"] < limits["nudgeMinChanges"]:
        write_turn(path, turn)
        return 0
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except Exception:
        return 0
    if not isinstance(plan, dict):
        return 0
    if any_in(plan.get("nodes"), "doing"):
        turn["settled"] = True
        write_turn(path, turn)
        return 0
    turn["reminded"] = True
    # A mark that cannot be written would make this speak after every call for the rest of the turn, which is the one
    # outcome worth avoiding; silence is the safe side.
    if not write_turn(path, turn):
        return 0
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": payload.get("hook_event_name", REMIND_EVENT),
        "additionalContext": (
            "This turn has started working, and no row of the work plan is `doing`. Mark the one you are working on "
            "before going on %sThe tree beside this conversation shows `doing` while the work runs, which is the only "
            "time it is any use. This is said once per turn." % remind_how(path)),
    }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
