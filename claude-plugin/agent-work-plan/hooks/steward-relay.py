#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Pass a message from a steward to a conversation it manages, typed into that conversation's input.

    python3 steward-relay.py <session id> [<plugin data directory>] <<'EOF'
    <the message, worded for that conversation>
    EOF

Run from the steward conversation: its session id comes from CLAUDE_CODE_SESSION_ID. Claude Code Plus types the
message into that conversation's input in the VS Code window that has it open and sends it, so it arrives as the
user's own message, approvals included. The window first looks for this command in the steward's transcript, so give
the message in a here-document as above.

Prints what happened and exits 0 when the message was sent, 1 otherwise.
"""

import json
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import SESSION_NAME, write_atomic  # noqa: E402
import plan_agent as A  # noqa: E402

RELAY_DIR = "relay"
# Claude Code Plus stops taking a request after 60 seconds; the answer panel waits up to 15 seconds for a send.
WAIT_SECONDS = 40
SAID = {
    "submitted": "Sent: it was typed into the conversation's message input and sent as the user's message.",
    "notReceived": "Not sent",
    "uncertain": "Unclear whether it was sent",
    "refused": "Not sent",
}


def main(argv):
    if len(argv) < 2 or not SESSION_NAME.match(argv[1]):
        print("usage: steward-relay.py <session id> [<plugin data directory>] < message")
        return 2
    steward = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if not SESSION_NAME.match(steward):
        print("Not sent: CLAUDE_CODE_SESSION_ID is not set, so this was not run from the steward conversation.")
        return 1
    # Read as bytes: on Windows the console code page would otherwise decode the message, and fail on Chinese.
    raw = sys.stdin.buffer.read()
    try:
        text = raw.decode("utf-8").strip()
    except UnicodeDecodeError:
        text = raw.decode("utf-8", "replace").strip()
    if not text:
        print("Not sent: no message on standard input.")
        return 1
    directory = os.path.join(argv[2] if len(argv) > 2 else A.FALLBACK, RELAY_DIR)
    os.makedirs(directory, exist_ok=True)
    rid = str(uuid.uuid4())
    request = {"id": rid, "steward": steward.lower(), "to": argv[1].lower(), "text": text, "at": int(time.time() * 1000)}
    request_file = os.path.join(directory, rid + ".json")
    result = os.path.join(directory, rid + ".result.json")
    write_atomic(request_file, json.dumps(request, ensure_ascii=False))
    deadline = time.time() + WAIT_SECONDS
    while time.time() < deadline:
        if os.path.exists(result):
            try:
                with open(result, encoding="utf-8") as fh:
                    r = json.load(fh)
            except (OSError, ValueError):
                time.sleep(0.2)
                continue
            try:
                os.remove(result)
            except OSError:
                pass
            outcome = r.get("outcome", "")
            line = SAID.get(outcome, "Not sent")
            reason = r.get("reason") or ""
            print(line if outcome == "submitted" else "%s: %s" % (line, reason or outcome))
            return 0 if outcome == "submitted" else 1
        time.sleep(0.25)
    try:
        os.remove(request_file)
        print("Not sent: no VS Code window that shows that conversation took the request. Is it open in a window?")
    except OSError:
        print("Unclear whether it was sent: a window took the request but gave no answer in %d seconds." % WAIT_SECONDS)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
