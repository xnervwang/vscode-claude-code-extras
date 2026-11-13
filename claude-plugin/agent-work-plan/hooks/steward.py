#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""UserPromptSubmit hook: for a steward, list the conversations it manages and the state of each; for a managed
conversation, say that a steward watches it.

Claude Code Plus's Steward panel keeps who manages whom in stewards.json in this plugin's data directory
(src/stewards.js in the extension).

Each managed conversation gets one line: its state from Claude Code's session records, what its plan has in progress,
and how many questions it has for the user. Then what changed since the steward's previous turn, kept in
<steward>.steward-seen beside its plan.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_common import (  # noqa: E402
    SESSION_NAME, children, data_dir, listed, read_payload, side_file, write_quietly,
)

STEWARDS_FILE = "stewards.json"
SEEN_SUFFIX = ".steward-seen"
MAX_LISTED = 30
MAX_DOING = 2
TITLE_CHARS = 80
STATE_WORDS = {"busy": "working", "shell": "running a command", "waiting": "waiting for the user", "idle": "idle"}
STOPPED = "not running"


def claude_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def alive(pid):
    """Whether pid is a live process. On Windows os.kill(pid, 0) terminates the process, so there this returns True
    without checking."""
    if os.name == "nt":
        return True
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def states():
    """session id -> state word, from the records of running claude processes."""
    out = {}
    folder = os.path.join(claude_dir(), "sessions")
    try:
        names = [n for n in os.listdir(folder) if n.endswith(".json") and n[:-5].isdigit()]
    except OSError:
        return out
    for name in names:
        try:
            with open(os.path.join(folder, name), encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            continue
        sid = str(rec.get("sessionId") or "").lower() if isinstance(rec, dict) else ""
        pid = rec.get("pid") if isinstance(rec, dict) else None
        if not SESSION_NAME.match(sid) or not isinstance(pid, int) or not alive(pid):
            continue
        word = STATE_WORDS.get(rec.get("status"), "running")
        # A conversation held by two processes reads as the busier of them.
        if out.get(sid) in (None, "idle"):
            out[sid] = word
    return out


def plan_summary(directory, sid):
    """(titles of rows in progress, questions waiting on the user) from a conversation's plan."""
    try:
        with open(os.path.join(directory, sid + ".json"), encoding="utf-8") as fh:
            plan = json.load(fh)
    except (OSError, ValueError):
        return [], 0
    doing, questions = [], [0]

    def walk(nodes):
        for n in listed(nodes):
            if not isinstance(n, dict):
                continue
            if n.get("state") == "doing" and len(doing) < MAX_DOING:
                doing.append(str(n.get("title") or "")[:TITLE_CHARS])
            if n.get("waitingOn") == "user" and n.get("state") in ("waiting", "discussing"):
                questions[0] += 1
            walk(children(n))

    walk(plan.get("nodes") if isinstance(plan, dict) else None)
    return doing, questions[0]


def managed_by(directory, sid):
    """(ids, names) this conversation manages, or ([], {})."""
    try:
        with open(os.path.join(directory, STEWARDS_FILE), encoding="utf-8") as fh:
            table = json.load(fh)
    except (OSError, ValueError):
        return [], {}
    entry = table.get("stewards", {}).get(sid) if isinstance(table, dict) and isinstance(table.get("stewards"), dict) else None
    if not isinstance(entry, dict):
        return [], {}
    ids = [m.lower() for m in listed(entry.get("manages")) if isinstance(m, str) and SESSION_NAME.match(m) and m.lower() != sid]
    names = entry.get("names") if isinstance(entry.get("names"), dict) else {}
    return ids[:MAX_LISTED], names


def stewards_of(directory, sid):
    """The stewards that manage this conversation."""
    try:
        with open(os.path.join(directory, STEWARDS_FILE), encoding="utf-8") as fh:
            table = json.load(fh)
    except (OSError, ValueError):
        return []
    all_ = table.get("stewards") if isinstance(table, dict) and isinstance(table.get("stewards"), dict) else {}
    return [s.lower() for s, e in all_.items() if isinstance(e, dict) and SESSION_NAME.match(s) and s.lower() != sid
            and sid in [m.lower() for m in listed(e.get("manages")) if isinstance(m, str)]]


def watched(stewards):
    """The line a managed conversation gets each turn."""
    return ("A steward conversation (%s) watches this one for the user through Claude Code Plus: it reads your work "
            "plan and latest reply, and speaks for the user by typing messages here, which come as the user's own. Do "
            "not send it status messages; put questions for the user in your plan as rows waiting on the user, where "
            "it sees them."
            % ", ".join(stewards))


def block(ids, names, now, seen, directory):
    lines = []
    for m in ids:
        name = str(names.get(m) or m)[:TITLE_CHARS]
        doing, questions = plan_summary(directory, m)
        parts = [now.get(m, STOPPED)]
        if doing:
            parts.append("doing: " + " / ".join(doing))
        if questions:
            parts.append("%d question%s for the user" % (questions, "" if questions == 1 else "s"))
        lines.append('- "%s" (%s): %s' % (name, m, "; ".join(parts)))
    changed = ['"%s": %s -> %s' % (str(names.get(m) or m)[:TITLE_CHARS], seen[m], now.get(m, STOPPED))
               for m in ids if m in seen and seen[m] != now.get(m, STOPPED)]
    text = ("You are the steward of %d Claude Code conversation%s the user picked for you in the Steward panel; "
            "follow the steward skill. Where they stand now:\n" % (len(ids), "" if len(ids) == 1 else "s"))
    text += "\n".join(lines)
    if changed:
        text += "\nChanged since your previous turn: " + "; ".join(changed) + "."
    return text


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    sid = str(payload.get("session_id") or "").lower()
    if not SESSION_NAME.match(sid):
        return 0
    directory = data_dir()
    ids, names = managed_by(directory, sid)
    over = stewards_of(directory, sid)
    if not ids:
        if over:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": payload.get("hook_event_name", "UserPromptSubmit"), "additionalContext": watched(over)}}))
        return 0
    now = states()
    seen_path = side_file(os.path.join(directory, sid + ".json"), SEEN_SUFFIX)
    try:
        with open(seen_path, encoding="utf-8") as fh:
            seen = json.load(fh)
        seen = seen if isinstance(seen, dict) else {}
    except (OSError, ValueError):
        seen = {}
    text = block(ids, names, now, seen, directory)
    if over:
        text += "\n" + watched(over)
    write_quietly(seen_path, json.dumps({m: now.get(m, STOPPED) for m in ids}))
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": payload.get("hook_event_name", "UserPromptSubmit"), "additionalContext": text}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
