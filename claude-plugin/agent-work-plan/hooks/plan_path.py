# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Where this conversation keeps its work plan, and the few facts about it that more than one script needs.

Shared rather than written into each: one hook reads the file, another watches its timestamp, a third reads a mark the
first leaves beside it, and the command that changes a row writes it - so two copies of any of this that drifted apart
would leave one of them looking at a path, a state or a mark that nobody writes, and nothing would say so.
"""
import contextlib
import datetime
import json
import os
import re
import shlex
import sys
import time

# The platform gives every plugin a data directory named <plugin>-<marketplace>, and hooks.json passes ours in as
# ${CLAUDE_PLUGIN_DATA}. This is that same name spelled out, for the case where the expansion did not happen. It is
# also the one directory the VS Code extension reads, so falling back to it keeps the two halves looking at one place.
FALLBACK = os.path.join(os.path.expanduser("~"), ".claude", "plugins", "data", "agent-work-plan-claude-code-extras")

# The states a row can be in, in the order a row usually passes through them. The extension's view keeps the same list
# (STATES in src/workplan.js) and the skill tabulates it; test/check.js holds the three together.
STATES = ("discussing", "todo", "doing", "waiting", "parked", "done", "dropped")
# The ones that still need something done.
OPEN_STATES = ("discussing", "todo", "doing", "waiting", "parked")
CLOSED_STATES = ("done", "dropped")

# Who a held-up row waits on, in the row's `waitingOn` field. A `waiting` row must say; a `discussing` row may say
# `user` when the conversation has put a decision to them. The extension keeps the same list (WAITING_ON in
# src/workplan.js) and the skill tabulates it.
WAITING_ON = ("user", "build", "someone", "session", "other")
# The states a row can say it is waiting on someone in.
HELD_STATES = ("waiting", "discussing")
# A row waiting on the user carries the one question they have to answer, in `question`, on one line. Long enough for
# a real question and short enough to read in a list of them across conversations.
MAX_QUESTION_CHARS = 200
# A row carries one question; questions_in counts question marks, ASCII or full-width.
QUESTION_MARK = re.compile(u"[?\uff1f]")


def questions_in(text):
    return len(QUESTION_MARK.findall(text or ""))


def data_dir():
    given = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CLAUDE_PLUGIN_DATA", "")
    # An unexpanded placeholder arrives as its own literal text, which would otherwise become a directory of that name.
    if given and "$" not in given and os.path.isabs(given):
        return given
    return FALLBACK


"""What the VS Code extension writes here for the hooks to read, and what it means when it is absent.

The hooks are separate processes started by Claude Code, so they cannot read editor settings. The extension writes the
few numbers that are worth changing into this one file instead, which keeps the editor's own settings UI as the single
place a person edits them.

Absent is the ordinary case rather than an error: this plugin is meant to work on its own, with or without that
extension, so every value here has a default that holds by itself.
"""
SETTINGS_FILE = "config.json"
DEFAULTS = {
    # Off means the work plan does nothing at all: no rows in front of the model, no reminder at the end of a turn, and a
    # write to the plan refused rather than quietly kept up. Hiding the view alone would be the worst of both - the
    # whole cost still paid every turn, with nothing to show for it.
    "enabled": True,
    # How many things a turn has to have CHANGED before it owes the plan anything - asked by the reminder at the end of a
    # turn, and by the one that speaks when a turn starts working with nothing marked `doing`. Counting tool calls
    # instead was the first shape of this and it was the wrong measure: reading, grepping and measuring are all tool
    # calls, so a turn spent explaining or investigating tripped the same threshold as a turn that finished three tasks.
    # Measured over one conversation, 29 reminders produced 10 entries and 18 produced nothing, and the densest run of
    # them landed on turns that had changed nothing at all. Meanwhile 14 other conversations kept a plan, wrote to it 269
    # times between them, and never saw one reminder - what maintains a plan is having it in front of the model every
    # turn, not this.
    "nudgeMinChanges": 2,
    # How many tool calls a turn makes, besides the plan's own, before the reminder that work has started with nothing
    # marked `doing` speaks, whether or not those calls changed anything. That reminder asks a different question from
    # the one at the end of a turn: not whether the plan is owed an entry, but whether the tree shows what is being worked
    # on right now, and the injection counts looking into something as work to mark. So reading and searching count
    # here, and nudgeMinChanges still lets two changes in a turn's first batch be enough on their own.
    "remindMinCalls": 3,
    # What a turn has to cost before a conversation with no plan at all is told it could keep one. The upper quartile of
    # turns begins at 25 tool calls, measured over 691 of them.
    "offerMinToolCalls": 25,
    # How many times the user has to have spoken first. A plan is for a conversation that branches, and a session handed
    # one task and left to do it cannot branch - measured over 61 offers, 53 went to single-turn workers and none of
    # them wanted a plan, while every conversation that did want one had spoken at least three times.
    "offerMinTurns": 3,
    # A regular expression for the conversation's latest reply. When it matches, the two hooks around a compaction say
    # nothing. It is for a conversation that relays another model's replies word for word: an instruction injected there
    # is either relayed to a model that cannot act on it or obeyed by breaking the relay. Empty matches nothing.
    "quietWhenReplyMatches": "",
    # Whether the model is told the time zone the user reads the panel in when it differs from this machine's
    # (tell-time-zone.py). Separate from `enabled`: it has nothing to do with the plan.
    "tellTimeZone": True,
}


def settings(directory=None):
    """The numbers above, with anything the extension wrote on top. A bad value is ignored rather than fatal.

    `directory` is for a caller that is not a hook and so is not handed the data directory as its first argument: the
    command that changes a row is given the plan's own path, and the plan sits in that directory.
    """
    out = dict(DEFAULTS)
    try:
        with open(os.path.join(directory or data_dir(), SETTINGS_FILE), encoding="utf-8") as fh:
            given = json.load(fh)
    except Exception:
        return out
    for key, fallback in DEFAULTS.items():
        value = given.get(key) if isinstance(given, dict) else None
        # Checked against the default's own type: a number where a flag belongs, or the other way round, is a mistake
        # rather than an instruction, and the default is the safer of the two readings.
        if isinstance(fallback, bool):
            if isinstance(value, bool):
                out[key] = value
            continue
        if isinstance(fallback, str):
            if isinstance(value, str):
                out[key] = value
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if value >= 1:
            out[key] = int(value)
    return out


"""How long a row's description may be, and the one test of it.

The view cuts a description at this length, the guard refuses a write past it, and the row command refuses to set one
past it. Kept the same as MAX_DETAIL_LINES and MAX_DETAIL_CHARS in the extension's src/workplan.js and as the numbers the
skill quotes; test/check.js asserts they are equal - a gate that refuses at one length while the view cuts at another
would be a gate nobody could satisfy.
"""
MAX_DETAIL_LINES = 12
MAX_DETAIL_CHARS = 900


def detail_over(value):
    """How a description breaks the limit, or None. Mirrors detail() in the extension's src/workplan.js.

    The character count is taken over the lines that would survive, not over the whole value, because that is what the
    view measures after dropping the rest - counting the whole thing would refuse a description the view shows in full.
    """
    lines = str(value).strip().split("\n")
    kept = "\n".join(lines[:MAX_DETAIL_LINES])
    if len(lines) > MAX_DETAIL_LINES:
        return "%d lines" % len(lines)
    if len(kept) > MAX_DETAIL_CHARS:
        return "%d characters" % len(kept)
    return None


"""Reading the end of a transcript, once per hook run, shared by every lookup in that run.

Transcripts run to hundreds of megabytes and everything needed here is near the end, so a run reads backwards only as
far as its lookups need. The file holds only the main thread: a sub-agent's transcript is its own, under
<session>/subagents/.
"""
TAIL_START = 64 * 1024           # first window tried when reading back
TAIL_MAX = 1024 * 1024           # give up past this; the answer is not worth more


class Tail:
    """Cached tail of one transcript, read backwards in windows that grow fourfold.

    Each lookup gives its own limit; bytes already read are reused.
    """

    def __init__(self, path):
        self.path = path
        self.size = os.path.getsize(path)
        self.start = self.size
        self.data = b""

    def _reach(self, limit):
        """Extend the cached tail toward `limit` bytes. False when it already covers that much or the file cannot be
        read."""
        held = self.size - self.start
        want = min(self.size, limit, max(TAIL_START, held * 4))
        if want <= held:
            return False
        start = self.size - want
        try:
            with open(self.path, "rb") as fh:
                fh.seek(start)
                more = fh.read(self.start - start)
        except OSError:
            return False
        self.data = more + self.data
        self.start = start
        return True

    def lines(self, limit=TAIL_MAX):
        """Yield the lines in the last `limit` bytes, newest first, leaving out a line that starts before that point."""
        floor = max(0, self.size - limit)
        end = self.size
        while True:
            base, data = self.start, self.data
            cut = end - base
            nl = data.rfind(b"\n", 0, cut)
            while nl >= 0 and base + nl + 1 >= floor:
                yield data[nl + 1:cut].decode("utf-8", "replace")
                cut, end = nl, base + nl
                nl = data.rfind(b"\n", 0, cut)
            if nl >= 0:
                return
            if base == 0:
                if floor == 0:
                    yield data[:cut].decode("utf-8", "replace")
                return
            if base <= floor or not self._reach(limit):
                return


def open_tail(path):
    """Tail of the transcript at `path`, or None if there is no file."""
    if not isinstance(path, str) or not path or not os.path.isfile(path):
        return None
    try:
        return Tail(path)
    except OSError:
        return None


def latest_reply_matches(tail, pattern, reply=None):
    """Whether the newest reply with any text in it matches `pattern`. False for an empty or unusable pattern.

    `reply` is that reply's text when the event hands it over (Stop does, as last_assistant_message), and then nothing
    is read. Otherwise it is looked for in the transcript, where turns made of tool calls alone are passed over, so a
    relayed reply followed by a few commands still counts as the latest one.
    """
    if not pattern:
        return False
    try:
        rx = re.compile(pattern)
    except re.error:
        return False
    if isinstance(reply, str) and reply.strip():
        return bool(rx.search(reply))
    if tail is None:
        return False
    for line in tail.lines(TAIL_MAX):
        if '"assistant"' not in line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict) or row.get("type") != "assistant":
            continue
        content = (row.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        text = "".join(str(p.get("text", "")) for p in content if isinstance(p, dict) and p.get("type") == "text")
        if text.strip():
            return bool(rx.search(text))
    return False


"""How much context the conversation is using, read back from the end of its transcript.

Shared by the water-mark hook (refresh-work-plan.py), which asks for the plan to be brought up to date as the context
nears the compaction line, and the time-zone hook (tell-time-zone.py), which says the user's zone again once the context
has grown well past where it last said it.
"""
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


def current_context(tail):
    """Tokens sent on the conversation's most recent model call, or None when none is recorded within TAIL_MAX."""
    if tail is None:
        return None
    for line in tail.lines(TAIL_MAX):
        tokens = usage_of(line)
        if tokens is not None:
            return tokens
    return None


"""Plan file names, and the files the hooks keep beside a plan.

A plan is <session id>.json. The extension's sweep (src/workplan.js) finds plans and the side files below by these
names, and a file it does not recognise would never be cleaned up.
"""
SESSION_ID = r"[0-9A-Fa-f][0-9A-Fa-f-]{7,}"
SESSION_NAME = re.compile(r"^%s$" % SESSION_ID)
PLAN_NAME = re.compile(r"^%s\.json$" % SESSION_ID)

TURN_SUFFIX = ".turn"            # the turn now running (see below)
NUDGED_SUFFIX = ".nudged"        # what the end-of-turn reminder last spoke about (nudge-work-plan.py)
SETTLED_SUFFIX = ".settled"      # which `doing` rows the end of a turn last asked to move on (nudge-work-plan.py)
OFFERED_SUFFIX = ".offered"      # that a conversation with no plan was offered one (nudge-work-plan.py)
WATERMARK_SUFFIX = ".watermark"  # which context marks have asked (refresh-work-plan.py)
TOLD_SUFFIX = ".tz"              # what the user's time zone was last told as (tell-time-zone.py)
LOCK_SUFFIX = ".lock"            # appended to the plan's own name, not put in place of .json (see plan_lock)


def plan_file(payload, directory=None):
    """This conversation's file, named by its session id - which is unique across every project on a machine.

    So there is no grouping directory, and the transcript path cannot give one: the project part there is the starting
    directory with every character other than a letter or digit replaced, and that substitution cannot be reversed.
    `directory` is for a caller that has been handed the data directory itself.
    """
    session = str(payload.get("session_id") or "").strip()
    if not SESSION_NAME.match(session):
        return None
    return os.path.join(directory or data_dir(), session + ".json")


def side_file(plan, suffix):
    """A file the hooks keep beside `plan`, swept with it when the conversation is gone."""
    return os.path.splitext(plan)[0] + suffix


def write_atomic(path, text):
    """Atomic write: write a temporary file and rename it into place. Raises on failure.

    The temporary name carries the process id, so two processes writing the same file never collide.
    """
    tmp = "%s.%d.tmp" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def write_quietly(path, text):
    """write_atomic for a hook, which must never fail on a write. True when the file is there."""
    try:
        write_atomic(path, text)
        return True
    except Exception:
        return False


def read_payload():
    """Read the hook's event from standard input as UTF-8. On Windows sys.stdin uses the console's code page and fails on
    anything outside ASCII."""
    return json.loads(sys.stdin.buffer.read().decode("utf-8"))


"""How a plan's rows are walked.

The file is hand-edited, so anything can appear where a list of rows is expected; a walk that trusted it would raise on
every prompt until the file was fixed.
"""


def listed(value):
    """`value` if it is a list, else []."""
    return value if isinstance(value, list) else []


def children(node):
    """A row's `children`, or an empty list when it has none or they are not a list."""
    return listed(node.get("children")) if isinstance(node, dict) else []


def any_in(nodes, state):
    """Whether any row among `nodes`, at any depth, is in `state`."""
    return any(isinstance(n, dict) and (n.get("state") == state or any_in(children(n), state)) for n in listed(nodes))


# The command that changes a row, beside this file, given with its full path so it never has to be found.
ROW_TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plan-row.py")
# Written by the extension beside this file when Python is started by another name here, as on Windows, where the
# python.org installer provides `py` and `python` but no `python3`.
LAUNCHER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "launcher.json")


def launcher():
    """How Python is started here, as a list of words: from launcher.json, or python3 when that file is absent."""
    try:
        with open(LAUNCHER, encoding="utf-8") as fh:
            words = json.load(fh).get("row")
        if isinstance(words, list) and words and all(isinstance(w, str) and w for w in words):
            return words
    except (OSError, ValueError, AttributeError):
        pass
    return ["python3"]


def launcher_quoted():
    """For PowerShell, which wants `&` before a quoted program."""
    first = launcher()[0]
    return shlex.quote(first) != first


def row_command(plan):
    """The command line that changes a row of `plan`, every word quoted for the shell.

    The launcher is a command name rather than a full path: a quoted path runs as a command in Bash but not in
    PowerShell, which Claude Code uses on Windows when Git Bash is not installed."""
    return " ".join([shlex.quote(w) for w in launcher()] + [shlex.quote(ROW_TOOL), shlex.quote(plan)])


"""The lock around a read, change and write of a plan.

The row command and the extension (when a row is changed from the tree) both read the whole file, change one row and
write it all back, so two at once would silently lose the first write. Each holds <plan file>.lock for that whole span,
by the same rules. The lock is a directory because mkdir is atomic on every file system.

A lock older than LOCK_STALE was left by a process that died holding it and is removed. LOCK_WAIT is longer than
LOCK_STALE; a lock still held after it belongs to a live writer, and the caller refuses to write.
"""
LOCK_STALE = 10
LOCK_WAIT = LOCK_STALE + 1.0
LOCK_POLL = 0.025


@contextlib.contextmanager
def plan_lock(plan, on_miss=None):
    """Hold the lock on `plan` for the body of a `with`. `on_miss` is called with a reason when it was not taken."""
    lock = plan + LOCK_SUFFIX
    deadline = time.monotonic() + LOCK_WAIT
    held = False
    while True:
        try:
            os.mkdir(lock)
            held = True
            break
        except FileExistsError:
            pass
        except FileNotFoundError:
            # No directory, so no plan in it for anyone else to be changing.
            break
        except OSError as e:
            if on_miss:
                on_miss("could not make %s (%s)" % (lock, e.strerror or e))
            break
        if time.monotonic() >= deadline:
            if on_miss:
                on_miss("%s was still held after %g seconds" % (lock, LOCK_WAIT))
            break
        try:
            stale = time.time() - os.stat(lock).st_mtime > LOCK_STALE
        except OSError:
            continue
        if stale:
            try:
                os.rmdir(lock)
                continue
            except OSError:
                pass
        time.sleep(LOCK_POLL)
    try:
        yield held
    finally:
        if held:
            try:
                os.rmdir(lock)
            except OSError:
                pass


def now_stamp():
    """The time now, written the way every time in a plan is written."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


STAMP = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$")


def epoch(stamp):
    """A time from a plan as seconds, or None for absent and for anything unparseable.

    Times are written by hand as often as by a script, so more than one spelling turns up: `date -Is` on some systems
    leaves the colon out of the offset, which the parser in this Python does not accept. A time with no offset at all is
    taken as UTC, which is what every script here writes.
    """
    m = STAMP.match(stamp.strip()) if isinstance(stamp, str) else None
    if not m:
        return None
    zone = m.group(3) or "+00:00"
    if zone == "Z":
        zone = "+00:00"
    elif ":" not in zone:
        zone = zone[:3] + ":" + zone[3:]
    try:
        return datetime.datetime.fromisoformat("%sT%s%s" % (m.group(1), m.group(2), zone)).timestamp()
    except ValueError:
        return None


"""The mark the injection hook leaves beside the plan when a turn begins, for the hook that watches the turn.

That second hook runs after every batch of tool calls and needs facts it cannot see from where it stands: when this turn
began, so that it can tell whether the plan has been written since; how much the turn has changed so far; and whether it
has already spoken. All three belong to the turn rather than to the plan, so they are kept beside the plan rather than in
it - the plan is the user's and the model's file, and no hook writes to it.

A turn is named by the prompt id the platform puts on every hook's input: one id from a prompt until the next, the same on
every event in between. A mark carrying any other id is from an earlier turn, and reads as no mark at all.
"""


def turn_file(plan):
    return side_file(plan, TURN_SUFFIX)


def read_turn(plan):
    try:
        with open(turn_file(plan), encoding="utf-8") as fh:
            turn = json.load(fh)
    except Exception:
        return None
    return turn if isinstance(turn, dict) else None


def write_turn(plan, turn):
    """Write the turn mark; True on success."""
    return write_quietly(turn_file(plan), json.dumps(turn))


def turn_began(plan, payload):
    """Start time (epoch seconds) of this event's turn, from the mark beside `plan`; None if the mark is missing or is
    for another turn."""
    prompt = payload.get("prompt_id")
    turn = read_turn(plan) if isinstance(prompt, str) and prompt else None
    if not turn or turn.get("prompt") != prompt:
        return None
    began = turn.get("began")
    return float(began) if isinstance(began, (int, float)) and not isinstance(began, bool) else None
