#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/hooks/tell-time-zone.py; sync-shared.js copies it, so edit it there.

"""Tell the model which time zone the user reads the panel in, when that is not this machine's.

With Remote SSH the model runs on one machine and the person reads on another, often hours apart. Every clock the model
can see is this machine's - `date`, file times, logs, the date the agent gives as today - while the panel shows times
in the reader's zone, so a model that reports "finished at 04:30" is right by a clock the reader never sees.

Where the agent itself has already told the model the same zone since the last compaction, nothing is said
(plan_agent.agent_told): Codex's pages do, Claude Code does not.

It is said when the conversation has not been told yet, and again only when something has made the last telling stale
or far away (see `due`): after a compaction, which summarises it away; when the offset changes, at a daylight-saving
change or a different client; when either side's date turns over, since "today" then means two different days; and
once the context has grown well past where it was last said. The sentence is about 90 tokens, and saying it on every
message cost that much again each time for a fact that had not changed. Nothing at all is said while the two zones
agree, which keeps a window on its own machine at no cost.

The zone comes from the panel, by way of the extension (src/panel-tz.js reports it, extension.js leaves it in
ZONE_FILE). The hook has no zone database of its own - Python 3.9's zoneinfo is not there on every machine this runs
on - so it asks the C library, through TZ and the system's zone files, what the time is there.
"""
import json
import os
import re
import sys
import time

# Set before the import below: see inject-work-plan.py.
sys.dont_write_bytecode = True
# The script's folder on the import path: see inject-work-plan.py.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import (AGENT, TOLD_BY, TOLD_SUFFIX, agent_told, current_context, data_dir, fixture_agent_told,
                       fixture_compacted, fixture_usage, latest_reply_matches, open_tail, plan_file, read_payload,
                       settings, side_file, write_quietly)

ZONE_FILE = "client-time-zone.json"
# An IANA name as Intl reports it. It becomes a path under the zone database, so nothing that could climb out of it.
ZONE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$")
ZONE_DIRS = ("/usr/share/zoneinfo", "/usr/lib/zoneinfo", "/usr/share/lib/zoneinfo")
# How far the context may grow past the last telling before it is said again. Distance in tokens is what pushes it out
# of attention, not time or the number of messages; at this spacing a 1M window hears it about ten times between
# compactions, a 200K window once or twice.
REPEAT_TOKENS = 100_000


def reported_zone(directory=None):
    try:
        with open(os.path.join(directory or data_dir(), ZONE_FILE), encoding="utf-8") as fh:
            given = json.load(fh)
    except Exception:
        return ""
    zone = given.get("timeZone") if isinstance(given, dict) else None
    return zone if isinstance(zone, str) and ZONE_NAME.match(zone) else ""


def clock_in(zone, now):
    """`now` as a local time in `zone`, or None when this machine cannot say.

    A name the C library does not find is read as UTC without complaint, so the zone file has to be there first: a wrong
    time stated with confidence is worse than none.
    """
    if not hasattr(time, "tzset") or not any(os.path.isfile(os.path.join(d, zone)) for d in ZONE_DIRS):
        return None
    saved = os.environ.get("TZ")
    try:
        os.environ["TZ"] = zone
        time.tzset()
        return time.localtime(now)
    finally:
        if saved is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = saved
        time.tzset()


def clocks(zone, now):
    """The user's local time and this machine's at `now`, or None when there is nothing to tell."""
    theirs = clock_in(zone, now) if zone else None
    if theirs is None:
        return None
    ours = time.localtime(now)
    return None if theirs.tm_gmtoff == ours.tm_gmtoff else (theirs, ours)


def offset(seconds):
    sign = "-" if seconds < 0 else "+"
    seconds = abs(int(seconds))
    return "UTC%s%02d:%02d" % (sign, seconds // 3600, seconds % 3600 // 60)


def named(t):
    """The zone's abbreviation and offset, leaving out an abbreviation that is only the offset again ("+04")."""
    abbr = getattr(t, "tm_zone", "") or ""
    return "%s, %s" % (abbr, offset(t.tm_gmtoff)) if abbr[:1].isalpha() else offset(t.tm_gmtoff)


def sentence(zone, theirs, ours):
    return ("The user is in %s (%s), where it is now %s. This machine runs on %s (%s): `date`, file times and log "
            "lines here are in that zone, and so is the date %s gives as today. Say times and dates to the "
            "user in their zone, converting any you read here."
            % (zone, named(theirs), time.strftime("%a %Y-%m-%d %H:%M", theirs),
               getattr(ours, "tm_zone", "") or "local time", offset(ours.tm_gmtoff), AGENT))


def describe(zone, now):
    """What to tell the model about `zone` at `now`; empty when there is nothing to tell."""
    found = clocks(zone, now)
    return sentence(zone, *found) if found else ""


def seen(theirs, ours, context):
    return {"offset": theirs.tm_gmtoff, "theirDate": time.strftime("%Y-%m-%d", theirs),
            "ourDate": time.strftime("%Y-%m-%d", ours), "context": context}


def due(told, now_seen):
    """Why the zone has to be said again on this message, or "" when what was said last still stands."""
    if not isinstance(told, dict):
        return "not told yet"
    if told.get("offset") != now_seen["offset"]:
        return "the offset changed"
    if told.get("theirDate") != now_seen["theirDate"] or told.get("ourDate") != now_seen["ourDate"]:
        return "a date turned over"
    last = told.get("context")
    if isinstance(last, int) and now_seen["context"] - last >= REPEAT_TOKENS:
        return "the context grew"
    return ""


def told_file(payload, directory=None):
    """What was said last, per conversation, beside where its plan would go; swept with it (SIDE_SUFFIXES in
    src/workplan.js)."""
    plan = plan_file(payload, directory)
    return side_file(plan, TOLD_SUFFIX) if plan else None


def read_told(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def write_told(path, value):
    write_quietly(path, json.dumps(value))


def respond(payload, now, directory=None):
    """The sentence for this event, recording that it was said; empty when nothing is to be said."""
    limits = settings(directory)
    if not limits["tellTimeZone"]:
        return ""
    zone = reported_zone(directory)
    found = clocks(zone, now)
    if not found:
        return ""
    event = payload.get("hook_event_name", "UserPromptSubmit")
    tail = open_tail(payload.get("transcript_path"))
    path = told_file(payload, directory)
    if event == "SessionStart":
        # After a compaction this is one more instruction in a conversation that may be relaying another model word
        # for word, which is what the quiet pattern is for (see plan_path.py).
        if latest_reply_matches(tail, limits["quietWhenReplyMatches"]):
            return ""
        # The transcript's last usage is still the context from before the compaction, so the count starts again here.
        # That reading is kept: every message until the next model call reads the same figure, and taken at its word it
        # would say the context had grown by all of it at once.
        now_seen = seen(*found, 0)
        before = current_context(tail)
        if before:
            now_seen["compactedFrom"] = before
    else:
        told = read_told(path) if path else None
        context = current_context(tail) or 0
        before = told.get("compactedFrom") if isinstance(told, dict) else None
        if isinstance(before, int) and context >= before:
            context = 0
        else:
            before = None
        now_seen = seen(*found, context)
        if before is not None:
            now_seen["compactedFrom"] = before
        if path and not due(told, now_seen):
            if isinstance(told, dict) and "compactedFrom" in told and before is None:
                # The first reading from after the compaction: from here on the context counts as it reads.
                write_told(path, {k: v for k, v in told.items() if k != "compactedFrom"})
            return ""
    # Recorded as told either way, so that it is looked for again only when something makes a telling due.
    if agent_told(tail, zone):
        if path:
            write_told(path, dict(now_seen, by=TOLD_BY))
        return ""
    if path:
        write_told(path, now_seen)
    return sentence(zone, *found)


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0
    text = respond(payload, time.time())
    if text:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": payload.get("hook_event_name", "UserPromptSubmit"), "additionalContext": text}}))
    return 0


def selftest():
    import shutil
    import tempfile

    failures = []

    def check(label, cond):
        print(("PASS " if cond else "FAIL ") + label)
        if not cond:
            failures.append(label)

    # Windows has no time.tzset.
    if not hasattr(time, "tzset"):
        check("without time.tzset nothing is said", describe("America/Los_Angeles", time.time()) == "")
        print("SKIP the rest: this Python has no time.tzset")
        if failures:
            print("%d checks failed" % len(failures))
            return 1
        print("all checks pass")
        return 0

    # 2026-10-18 16:41 UTC: summer time in Los Angeles.
    summer = 1792341660
    # 2026-12-18 16:41 UTC: winter time there.
    winter = summer + 61 * 86400
    os.environ["TZ"] = "UTC"
    time.tzset()
    said = describe("America/Los_Angeles", summer)
    check("another zone is described with its offset and local time",
          "America/Los_Angeles (PDT, UTC-07:00)" in said and "Sun 2026-10-18 09:41" in said)
    check("and the machine's zone is named", "This machine runs on UTC (UTC+00:00)" in said)
    check("the offset follows the date", "(PST, UTC-08:00)" in describe("America/Los_Angeles", winter))
    check("half hours are kept", "UTC+05:30" in describe("Asia/Kolkata", summer))
    check("an abbreviation that only repeats the offset is left out", "(UTC+04:00)" in describe("Asia/Dubai", summer))
    check("the same offset under another name says nothing", describe("Etc/UTC", summer) == "")
    check("a name the machine has no zone file for says nothing", describe("Mars/Olympus_Mons", summer) == "")
    check("no zone says nothing", describe("", summer) == "")
    os.environ["TZ"] = "America/Los_Angeles"
    time.tzset()
    check("a machine in the user's own zone says nothing", describe("America/Los_Angeles", summer) == "")
    check("and the machine's TZ is put back afterwards", os.environ.get("TZ") == "America/Los_Angeles"
          and time.localtime(summer).tm_hour == 9)
    os.environ["TZ"] = "UTC"
    time.tzset()

    tmp = tempfile.mkdtemp()
    try:
        def write(name, value):
            with open(os.path.join(tmp, name), "w", encoding="utf-8") as fh:
                fh.write(value)
        check("no file reads as no zone", reported_zone(tmp) == "")
        write(ZONE_FILE, json.dumps({"timeZone": "../../etc/passwd"}))
        check("a name that climbs out of the zone database is refused", reported_zone(tmp) == "")
        write(ZONE_FILE, "{")
        check("a half-written file reads as no zone", reported_zone(tmp) == "")
        write(ZONE_FILE, json.dumps({"timeZone": "America/Los_Angeles"}))
        check("the reported zone is read", reported_zone(tmp) == "America/Los_Angeles")

        transcript = os.path.join(tmp, "t.jsonl")

        def context(tokens):
            write("t.jsonl", fixture_usage(tokens) + "\n")

        message = {"hook_event_name": "UserPromptSubmit", "session_id": "5e000000-0000-0000-0000-000000000000",
                   "transcript_path": transcript}
        context(20_000)
        check("the first message of a conversation is told", respond(message, summer, tmp) != "")
        check("and the next one is not", respond(message, summer + 600, tmp) == "")
        context(20_000 + REPEAT_TOKENS - 1)
        check("nor while the context has grown less than the spacing", respond(message, summer + 1200, tmp) == "")
        context(20_000 + REPEAT_TOKENS)
        check("it is said again once the context has grown by the spacing", respond(message, summer + 1800, tmp) != "")
        check("and then not again at the same size", respond(message, summer + 2400, tmp) == "")
        # 00:05 UTC the next day: the machine's date has turned over and the user's has not.
        check("the machine's date turning over says it again", respond(message, summer + 7 * 3600 + 24 * 60, tmp) != "")
        # 00:05 in Los Angeles: now the user's turns over.
        check("and so does the user's", respond(message, summer + 14 * 3600 + 24 * 60, tmp) != "")
        compacted = dict(message, hook_event_name="SessionStart", source="compact")
        check("a compaction always says it", respond(compacted, summer + 14 * 3600 + 30 * 60, tmp) != "")
        check("and the message after it, still reading the context from before the compaction, is not told again",
              respond(message, summer + 14 * 3600 + 35 * 60, tmp) == "")
        context(30_000)
        check("and the count starts again from there", respond(message, summer + 14 * 3600 + 40 * 60, tmp) == "")
        context(REPEAT_TOKENS - 1)
        check("  counting from the compaction", respond(message, summer + 14 * 3600 + 45 * 60, tmp) == "")
        context(REPEAT_TOKENS)
        check("  until the context has grown by the spacing", respond(message, summer + 14 * 3600 + 50 * 60, tmp) != "")
        context(80_000)
        respond(compacted, summer + 14 * 3600 + 55 * 60, tmp)
        respond(message, summer + 14 * 3600 + 56 * 60, tmp)
        context(20_000)
        respond(message, summer + 14 * 3600 + 57 * 60, tmp)
        context(REPEAT_TOKENS)
        check("once a reading from after the compaction is seen, the one from before it no longer reads as zero",
              respond(message, summer + 14 * 3600 + 58 * 60, tmp) != "")
        check("a change of offset says it again", respond(message, winter, tmp) != "")

        # Where the agent tells the model the zone itself, its own telling counts until a compaction.
        def agent_says(zone):
            write("t.jsonl", "\n".join([fixture_agent_told(zone), fixture_usage(20_000)]) + "\n")
        if fixture_agent_told("UTC"):
            fresh = dict(message, session_id="5e000000-0000-0000-0000-000000000002")
            agent_says("America/Los_Angeles")
            check("where the agent told the model the same zone, nothing is said", respond(fresh, summer, tmp) == "")
            check("and nothing on the next message either", respond(fresh, summer + 600, tmp) == "")
            agent_says("Europe/Paris")
            check("the agent's message naming another zone does not count",
                  respond(dict(message, session_id="5e000000-0000-0000-0000-000000000003"), summer, tmp) != "")
            agent_says("America/Los_Angeles")
            with open(transcript, "a", encoding="utf-8") as fh:
                fh.write(fixture_compacted() + "\n")
            check("nor does one from before a compaction",
                  respond(dict(message, session_id="5e000000-0000-0000-0000-000000000004"), summer, tmp) != "")
        check("a message with no session id is still told", respond(dict(message, session_id=""), summer, tmp) != "")
        write("config.json", json.dumps({"tellTimeZone": False}))
        check("the setting off says nothing even to a new conversation",
              respond(dict(message, session_id="5e000000-0000-0000-0000-000000000001"), summer, tmp) == "")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if failures:
        print("%d checks failed" % len(failures))
        return 1
    print("all checks pass")
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if sys.argv[1:2] == ["--selftest"] else main())
