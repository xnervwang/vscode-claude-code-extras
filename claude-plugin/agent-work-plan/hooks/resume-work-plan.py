#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/hooks/resume-work-plan.py; sync-shared.js copies it, so edit it there.

"""Right after a compaction, point the conversation at its work plan and say the context is now at its smallest.

The injection hook puts the plan's open rows in front of the model on every user prompt, and the turn that resumes
straight after a compaction does not pass through one - so it is the one turn that hook cannot reach, and it is the turn
that most needs the plan. This runs on SessionStart with the compact matcher, which is exactly that turn.

What the reader gets from the file that the summary does not give it is in the `detail` of the rows that are `doing`:
refresh-work-plan.py asked for the next concrete step, what not to do, and the user's own words to be written there
before the compaction. The summary covers more ground but orders it by kind, and it retells verdicts rather than stating
them.

A path and not the file's contents. Reading the file with a tool puts it in the recently-read set, so the client's
own restore carries it through the next compaction for free; a hook's output is not a file read and forfeits that. And
the summary has turned every tool call in the context into prose - the first real call after it is what puts the
conversation back into using tools.

Saying the context is now at its smallest is the other half. The summary carries whatever was asked before the
compaction, so a reader can pick up a request about an approaching compaction and act on it with the context nearly
empty. This is the only place that can say it has been overtaken.

It says nothing when the conversation keeps no plan - nothing before the compaction asked it for anything, so there is
nothing to overtake - and nothing when the latest reply matches quietWhenReplyMatches (see plan_path.py).
"""
import json
import os
import sys

# Set before the import below: see inject-work-plan.py.
sys.dont_write_bytecode = True
# The script's folder on the import path: see inject-work-plan.py.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import READ_HINT, fixture_reply, fixture_tool_call, latest_reply_matches, open_tail, plan_file, read_payload, settings


def message(plan):
    return "\n".join([
        "The context was just compacted, so it is now at its smallest, not near a limit. Anything the summary above "
        "reports as pending because a compaction was approaching has been overtaken by it: the compaction is done.",
        "This conversation's work plan, a row per task: %s" % plan,
        READ_HINT + " before doing anything else. The summary above retells the stretch in document order; the "
        "plan says what is still open, and the `detail` of a row that is `doing` was written for this moment - the next "
        "concrete step and what not to do, which a retelling flattens. The summary also turned every tool call into "
        "prose, and that first call is what puts this conversation back into using tools.",
        "This is a hook's output, not the user speaking: it approves nothing and answers no pending question.",
    ])


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0
    if payload.get("hook_event_name") != "SessionStart" or payload.get("source") != "compact":
        return 0
    limits = settings()
    if not limits["enabled"]:
        return 0
    plan = plan_file(payload)
    if not plan or not os.path.isfile(plan):
        return 0
    if latest_reply_matches(open_tail(payload.get("transcript_path")), limits["quietWhenReplyMatches"]):
        return 0
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": message(plan),
    }}))
    return 0


def selftest():
    import shutil
    import subprocess
    import tempfile

    root = tempfile.mkdtemp(prefix="resume-work-plan-selftest-")
    data = os.path.join(root, "data")
    os.makedirs(data)
    sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    plan = os.path.join(data, sid + ".json")
    transcript = os.path.join(root, sid + ".jsonl")
    me = [sys.executable, os.path.abspath(__file__), data]

    def write_transcript(*texts, tool_after=False):
        with open(transcript, "w", encoding="utf-8") as fh:
            for t in texts:
                fh.write(fixture_reply(t) + "\n")
            if tool_after:
                fh.write(fixture_tool_call() + "\n")

    def run(payload):
        r = subprocess.run(me, input=json.dumps(payload), stdout=subprocess.PIPE, universal_newlines=True)
        return r.returncode, r.stdout.strip()

    def said(out):
        return json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""

    base = {"hook_event_name": "SessionStart", "source": "compact", "session_id": sid, "transcript_path": transcript}
    bad = 0

    def check(label, cond):
        nonlocal bad
        if not cond:
            bad += 1
        print("%-4s %s" % ("PASS" if cond else "FAIL", label))

    write_transcript("an ordinary reply")
    check("no plan -> silent", run(base)[1] == "")

    with open(plan, "w") as fh:
        fh.write('{"nodes": []}')
    c = said(run(base)[1])
    check("plan present -> points at it by absolute path", plan in c)
    check("  says the context is now at its smallest", "at its smallest" in c and "overtaken" in c)
    check("  asks for it to be read with a tool first", "Read it with a tool" in c)
    check("  and says where the next step is written", "`detail`" in c)
    check("  and hands back nothing from the transcript", "an ordinary reply" not in c)

    other = os.path.join(data, "ffffffff-ffff-ffff-ffff-ffffffffffff.json")
    os.rename(plan, other)
    check("another conversation's plan is not this one's", run(base)[1] == "")
    os.rename(other, plan)

    check("source=startup -> silent", run(dict(base, source="startup"))[1] == "")
    check("another event -> silent", run(dict(base, hook_event_name="SessionEnd"))[1] == "")
    r = subprocess.run(me, input="not json", stdout=subprocess.PIPE, universal_newlines=True)
    check("malformed input fails open", r.returncode == 0 and r.stdout.strip() == "")

    relay = r"^\s*\([A-Za-z0-9._-]+-through-[A-Za-z0-9._-]+ \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)"
    with open(os.path.join(data, "config.json"), "w") as fh:
        json.dump({"quietWhenReplyMatches": relay}, fh)
    write_transcript("an ordinary reply", "(gpt-through-opus 2026-09-05T07:16:42Z) the model's words")
    check("latest reply matches the quiet pattern -> silent", run(base)[1] == "")
    write_transcript("(gpt-through-opus 2026-09-05T07:16:42Z) relayed", tool_after=True)
    check("  still matched past a turn of tool calls alone", run(base)[1] == "")
    write_transcript("(gpt-through-opus 2026-09-05T07:16:42Z) relayed", "an ordinary reply again")
    check("an ordinary reply after a relay -> speaks", run(base)[1] != "")
    with open(os.path.join(data, "config.json"), "w") as fh:
        json.dump({"quietWhenReplyMatches": "("}, fh)
    check("a pattern that does not compile matches nothing", run(base)[1] != "")
    with open(os.path.join(data, "config.json"), "w") as fh:
        json.dump({"enabled": False}, fh)
    check("plans switched off -> silent", run(base)[1] == "")

    shutil.rmtree(root, ignore_errors=True)
    print("\n%s" % ("all checks pass" if not bad else "%d checks FAILED" % bad))
    return 1 if bad else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    sys.exit(main())
