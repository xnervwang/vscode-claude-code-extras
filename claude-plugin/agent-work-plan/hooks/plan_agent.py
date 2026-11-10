# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/claude/plan_agent.py; sync-shared.js copies it, so edit it there.

"""Claude Code's side of the work plan hooks: its plugin data directory, how a transcript line is read, and what it
calls things. plan_common.py imports this module, which imports nothing from the plugin.
"""
import json
import os

AGENT = "Claude Code"
SETTING_PREFIX = "claudeCodePlus"

# The platform gives every plugin a data directory named <plugin>-<marketplace>, and hooks.json passes ours in as
# ${CLAUDE_PLUGIN_DATA}. This is that same name spelled out, for the case where the expansion did not happen. It is
# also the one directory the VS Code extension reads, so falling back to it keeps the two halves looking at one place.
DATA_ENV = ("CLAUDE_PLUGIN_DATA",)
FALLBACK = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"),
                        "plugins", "data", "agent-work-plan-claude-code-extras")

EXTRA_DEFAULTS = {}
# Settings besides `enabled` and `tellTimeZone` that are off once the extension is gone from every editor.
OFF_WHEN_GONE = ()

# The field of a hook's input that names the turn: one id from a prompt until the next.
TURN_FIELD = "prompt_id"
NO_GROUPING = ("the project part there is the starting directory with every character other than a letter or digit "
               "replaced, and that substitution cannot be reversed")


def reply_text(line):
    """The text of an assistant message on a transcript line, or None when the line is not one. The file holds only the
    main thread: a sub-agent's transcript is its own, under <session>/subagents/."""
    if '"assistant"' not in line:
        return None
    try:
        row = json.loads(line)
    except ValueError:
        return None
    if not isinstance(row, dict) or row.get("type") != "assistant":
        return None
    content = (row.get("message") or {}).get("content")
    if not isinstance(content, list):
        return None
    return "".join(str(p.get("text", "")) for p in content if isinstance(p, dict) and p.get("type") == "text")


USAGE_KEYS = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


def usage_of(line):
    """Input tokens, cache reads and writes included, of the assistant call on a transcript line, or None if the line
    has no usage."""
    if '"usage"' not in line:
        return None
    try:
        row = json.loads(line)
    except ValueError:
        return None
    if not isinstance(row, dict) or row.get("type") != "assistant":
        return None
    message = row.get("message")
    usage = message.get("usage") if isinstance(message, dict) else None
    if not isinstance(usage, dict):
        return None
    return sum(v for v in (usage.get(k) for k in USAGE_KEYS) if isinstance(v, int))


def window_of(line):
    """Claude Code's transcript does not record the context window; refresh-work-plan.py works it out from the model."""
    return None


"""The injected block and the reminders tell the model to change rows with the row command (plan-row.py), giving its
full path."""
WAITING_ON_WORD = "--waiting-on"
QUESTION_WORD = "--question"
SESSION_HINT = "If an agent you started with claude --bg or claude -p --resume is working on it, set the row to doing."
READ_HINT = "Read it with a tool"


def row_help(path, command, quoted):
    """The injected block's lines on how to change a row of the plan at `path`; `command` is the row command for it."""
    return ["To change a row: %s set <row> <state> [--note TEXT] [--waiting-on WHO] [--question TEXT]. To add one: %s add "
            "<state> TITLE [--under <row>] [--waiting-on WHO] [--question TEXT]. Both read the clock themselves.%s"
            % (command, command, " In PowerShell, put & and a space in front of either command line." if quoted else "")]


def fixture_reply(text):
    """A transcript line holding an assistant reply, for the hooks' self-tests."""
    return json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}})


def fixture_tool_call():
    """A transcript line holding a turn made of a tool call alone, for the hooks' self-tests."""
    return json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}]}})

# A call to one of CHANGING_TOOLS always counts as a change; a call to SHELL_TOOLS counts when its command does
# (changes.py).
CHANGING_TOOLS = ("Write", "Edit", "NotebookEdit")
SHELL_TOOLS = ("Bash",)


"""The user's time zone (tell-time-zone.py). Claude Code itself never tells the model the reader's zone."""
TOLD_BY = "claude"


def agent_told(tail, zone):
    return False


def fixture_usage(tokens):
    """A transcript line recording a model call that sent `tokens`, for the hooks' self-tests."""
    return json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}],
                                                        "usage": {"input_tokens": tokens}}})


def fixture_agent_told(zone):
    return ""


def fixture_compacted():
    return ""


"""Reading a turn back from the transcript, and speaking at its end (nudge-work-plan.py)."""
# Strings a line has to hold to be parsed at all: a tool call, or a user row.
MAYBE_CALL = ('"tool_use"',)
MAYBE_USER = ('"user"',)
NOTE_WORD = "--note"
AFTER_OFFER = ""
# Claude Code's Stop hook adds context for the next turn rather than keeping this one going, so it never runs again
# because of its own output.
STOP_REENTERS = False


def tool_calls(row):
    """The (name, input) of each tool call on a parsed transcript row: the tool_use blocks of an assistant message."""
    content = (row.get("message") or {}).get("content") if row.get("type") == "assistant" else None
    if not isinstance(content, list):
        return []
    return [(block.get("name") or "", block.get("input")) for block in content
            if isinstance(block, dict) and block.get("type") == "tool_use"]


def spoke(row):
    """True for a user row that is a real message, not a tool result or a row the client wrote.

    All of these are recorded as `user`. Rows the client writes are marked isMeta (skill text, scheduled wake-ups,
    image-resize notes) or isCompactSummary (compaction summaries), and an interruption is a line of its own that starts
    "[Request interrupted". Counted as the user, one transcript showed 180 more turns than were spoken, a skill loaded
    at the end of a turn would move the turn's start past all its work, and a worker addressed once looked addressed
    three times after two compactions.
    """
    if row.get("type") != "user" or row.get("isMeta") or row.get("isCompactSummary"):
        return False
    message = row.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, list):
        texts = [str(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("type") == "text"]
        if not texts:
            return False
        content = "".join(texts)
    return isinstance(content, str) and not content.lstrip().startswith("[Request interrupted")


def stop_output(payload, text):
    return {"hookSpecificOutput": {"hookEventName": payload.get("hook_event_name", "Stop"), "additionalContext": text}}


def offer_how(path):
    return "start one at %s now" % path


def settle_how(path):
    from plan_common import row_command
    return "To change a row: %s set <row> <state> [--note TEXT] [--waiting-on WHO] [--question TEXT]." % row_command(path)


def ask_how(path):
    from plan_common import row_command
    return "%s set <row> <state> --waiting-on user --question TEXT, or `add` for a new row." % row_command(path)


"""The reminder when a turn starts working with nothing `doing` (remind-work-plan.py)."""
REMIND_EVENT = "PostToolBatch"


def event_calls(payload):
    """The (name, input) of each call a PostToolBatch event reports."""
    calls = payload.get("tool_calls")
    return [(c.get("tool_name"), c.get("tool_input")) for c in calls if isinstance(c, dict)] if isinstance(calls, list) else []


def keeps_plan(tool, given, plan_name):
    """A call that names the plan file is the plan being kept."""
    return plan_name in json.dumps(given, ensure_ascii=False, default=str)


def remind_how(path):
    from plan_common import row_command
    command = row_command(path)
    return ("- or, if this is new work the user asked for or something they asked you to look into, add it as `doing`:\n"
            "  %s set <row> doing\n  %s add doing TITLE [--under <row>]\n" % (command, command))
