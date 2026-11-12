#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Print one conversation's state, open plan rows and latest reply text, for a steward.

    python3 steward-peek.py <session id> [<plugin data directory>]

Prints the conversation's state from Claude Code's session records, its plan's open rows with the questions it has
for the user, and the text it wrote after the user's last message, without tool calls, tool output or thinking.
Read-only.
"""

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_common import OPEN_STATES, SESSION_NAME, children, listed, open_tail  # noqa: E402
import plan_agent as A  # noqa: E402

TAIL_BYTES = 4 * 1024 * 1024
MAX_REPLY_CHARS = 6000
STATE_WORDS = {"busy": "working", "shell": "running a command", "waiting": "waiting for the user", "idle": "idle"}


def claude_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def state_of(sid):
    folder = os.path.join(claude_dir(), "sessions")
    found = []
    for path in glob.glob(os.path.join(folder, "*.json")):
        try:
            with open(path, encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(rec, dict) and str(rec.get("sessionId") or "").lower() == sid and isinstance(rec.get("pid"), int):
            if os.name != "nt":
                try:
                    os.kill(rec["pid"], 0)
                except PermissionError:
                    pass
                except OSError:
                    continue
            found.append(STATE_WORDS.get(rec.get("status"), "running"))
    if not found:
        return "not running"
    return next((w for w in found if w != "idle"), "idle")


def plan_lines(directory, sid):
    try:
        with open(os.path.join(directory, sid + ".json"), encoding="utf-8") as fh:
            plan = json.load(fh)
    except (OSError, ValueError):
        return ["(no work plan)"]
    out = []

    def walk(nodes, prefix):
        for i, n in enumerate(listed(nodes), 1):
            if not isinstance(n, dict):
                continue
            num = "%s%d" % (prefix + "." if prefix else "", i)
            if n.get("state") in OPEN_STATES:
                line = "%s. [%s] %s" % (num, n.get("state"), n.get("title") or "")
                if n.get("waitingOn") == "user" and n.get("question"):
                    line += "\n     question for the user: " + str(n.get("question"))
                out.append(line)
            walk(children(n), num)

    walk(plan.get("nodes") if isinstance(plan, dict) else None, "")
    return out or ["(no open rows)"]


def transcript(sid):
    hits = glob.glob(os.path.join(claude_dir(), "projects", "*", sid + ".jsonl"))
    return max(hits, key=os.path.getmtime) if hits else ""


def is_prompt(row):
    """A message the user typed, as opposed to a tool result or something the client added."""
    if row.get("type") != "user" or row.get("isMeta") or row.get("isSidechain"):
        return False
    content = (row.get("message") or {}).get("content")
    if isinstance(content, str):
        return bool(content.strip())
    return any(isinstance(b, dict) and b.get("type") == "text" for b in listed(content)) and \
        not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in listed(content))


def latest_reply(path):
    """The text of what the conversation said after the user's last message, oldest part first."""
    tail = open_tail(path)
    if tail is None:
        return ""
    texts = []
    for line in tail.lines(TAIL_BYTES):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        if is_prompt(row):
            break
        if row.get("type") == "assistant" and not row.get("isSidechain"):
            for b in reversed(listed((row.get("message") or {}).get("content"))):
                if isinstance(b, dict) and b.get("type") == "text" and str(b.get("text") or "").strip():
                    texts.append(str(b["text"]).strip())
    reply = "\n\n".join(reversed(texts))
    return reply if len(reply) <= MAX_REPLY_CHARS else "..." + reply[-MAX_REPLY_CHARS:]


def main(argv):
    if len(argv) < 2 or not SESSION_NAME.match(argv[1]):
        sys.stderr.write("usage: steward-peek.py <session id> [<plugin data directory>]\n")
        return 2
    sid = argv[1].lower()
    directory = argv[2] if len(argv) > 2 else A.FALLBACK
    print("state: " + state_of(sid))
    print("plan:")
    for line in plan_lines(directory, sid):
        print("  " + line)
    path = transcript(sid)
    print("latest reply:")
    reply = latest_reply(path) if path else ""
    print(reply or "(none found)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
