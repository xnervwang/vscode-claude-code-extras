# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/hooks/changes.py; sync-shared.js copies it, so edit it there.

"""Whether a tool call changed something, as against looking at something.

Both reminders ask it - the one at the end of a turn, about the whole turn, and the one when a turn starts working,
about each batch of calls - so it is written once. Two copies of a judgement this delicate would be tuned apart one false
alarm at a time, and the two reminders would then disagree about the same call with nothing saying which was right.
"""
import json
import re
import sys

# Tools that change something by definition, and the names a shell call goes by, as the agent names them (plan_agent).
# Everything else - reading, searching, fetching, measuring - is a turn looking at the world rather than altering it,
# and owes the plan nothing.
from plan_agent import CHANGING_TOOLS, SHELL_TOOLS
# A shell command that changes something. Bash cannot be judged by its name, so it is judged by what it runs, and the
# uncertain cases are resolved towards silence: a command this misses makes a reminder miss a turn, while a command it
# wrongly catches puts the reminder back on the turns it was just taken off.
#
# Matched after shell_words, which turns each quoted string into one word and drops here-document bodies; on the raw
# text `awk '$3 > 5'`, `grep 'p->next'` and `grep 'rm '` would count as writes. A redirect must start a shell word and
# may have a descriptor (`2> err.log`); it does not count when it targets another descriptor (`2>&1`), /dev/, or a
# number, which is an arithmetic comparison.
CHANGING_SHELL = re.compile(
    r"\bgit\s+(commit|add|push|mv|rm|apply|checkout|reset|revert|tag|stash)\b"
    r"|\b(tee|mkdir|rmdir|touch|mv|cp|rm|chmod|chown|ln|truncate|install)\s"
    r"|\bsed\s+-i"
    r"|(?:^|(?<=[\s|;&]))\d?>>?\s*(?![\d&=(-]|/dev/)[^\s|;&]"
)
# A file opened for writing by an inline or here-document script, so this runs on the whole command. Only the mode
# argument counts: open(path) and open(path, "rb") are reads, whatever the file name.
WRITING_OPEN = re.compile(
    r"\bopen\(\s*(?:[^,()'\"]|'[^']*'|\"[^\"]*\"|\([^()]*\))+,\s*(?:mode\s*=\s*)?['\"][^'\"]*[wax]"
    r"|\bopen\([^)]*\bmode\s*=\s*['\"][^'\"]*[wax]"
    r"|\.open\(\s*(?:mode\s*=\s*)?['\"][^'\"]*[wax]"
)
HEREDOC = re.compile(r"(?<!<)<<(?!<)-?[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*")
QUOTED = re.compile(r"'[^']*'|\"(?:[^\"\\]|\\.)*\"")


def shell_words(command):
    """`command` with each here-document's body left out and each quoted string made a single word.

    The placeholder word keeps `> "out file"` a redirect with a target.
    """
    out, pos = [], 0
    while True:
        m = HEREDOC.search(command, pos)
        if not m:
            out.append(command[pos:])
            break
        out.append(command[pos:m.end()])
        end = re.compile(r"^[ \t]*%s[ \t]*$" % re.escape(m.group(2)), re.M).search(command, m.end())
        if not end:
            break
        pos = end.end()
    return QUOTED.sub("Q", "".join(out))


def changes(name, tool_input):
    """True when a call of this tool with this input altered something."""
    if name in CHANGING_TOOLS:
        return True
    if name in SHELL_TOOLS:
        command = shell_command(tool_input)
        return bool(command) and bool(CHANGING_SHELL.search(shell_words(command)) or WRITING_OPEN.search(command))
    return False


def shell_command(tool_input):
    """The command line of a shell call, whichever shape it arrives in.

    A hook is handed {"command": "..."}; a rollout records exec_command's arguments as a JSON string with `cmd`, and the
    older shell tool's as a list of words.
    """
    if isinstance(tool_input, str):
        try:
            tool_input = json.loads(tool_input)
        except ValueError:
            return tool_input
    if not isinstance(tool_input, dict):
        return ""
    command = tool_input.get("command", tool_input.get("cmd"))
    if isinstance(command, list):
        return " ".join(str(w) for w in command)
    return command if isinstance(command, str) else ""


READS = (
    "awk '$3 > 5' f",
    "grep -n 'p->next' x.c",
    "jq '.items | length > 3' f",
    "python3 -c \"open('agents.json').read()\"",
    "git log | grep 'rm '",
    "python3 -c \"if n >= 4: print(1)\"",
    "python3 -c \"if a <= b and c => d: pass\"",
    "grep -c foo bar | sed 's/^/  /'",
    "node test/check.js 2>&1 | tail -1",
    "ls -d ~/x > /dev/null 2>&1; echo ok",
    "git log --format=\"%h\" -S \"foo\" | tail -3",
    "git status --short",
    "echo done >&2",
    "(( n > 5 )) && echo big",
    "python3 - <<'EOF'\nimport json\nrows = json.load(open('a.json'))\nprint(len([r for r in rows if r['n'] > 3]))\nEOF",
    "python3 -c \"print(open('w.txt', 'rb').read())\"",
)
WRITES = (
    "echo hi > /tmp/a",
    "echo hi >> notes.txt",
    "git commit -m x",
    "git add .",
    "cp a b",
    "rm -rf build",
    "sed -i \"s/a/b/\" f",
    "mkdir -p out && touch out/x",
    "make 2> err.log",
    "make &> build.log",
    "echo x > \"out file.txt\"",
    "cat > notes.md <<'EOF'\nthe count >= 4 and a > b\nEOF",
    "git commit -m \"$(cat <<'EOF'\nFix the thing\nEOF\n)\"",
    "python3 -c \"open('out.txt', 'w').write('x')\"",
    "python3 -c \"open(os.path.join(d, f), mode='a').write('x')\"",
    "python3 - <<'EOF'\nfrom pathlib import Path\nPath('x').open('w').write('y')\nEOF",
    "python3 fix.py > plan.json",
)


def selftest():
    wrong = [c for c in READS if changes("Bash", {"command": c})]
    missed = [c for c in WRITES if not changes("Bash", {"command": c})]
    # A shell call recorded under another name has its arguments as a JSON string with `cmd`.
    for shell in SHELL_TOOLS[1:]:
        wrong += [c for c in READS[:3] if changes(shell, json.dumps({"cmd": c}))]
        missed += [c for c in WRITES[:3] if not changes(shell, json.dumps({"cmd": c}))]
    missed += [tool for tool in CHANGING_TOOLS if not changes(tool, "*** Begin Patch")]
    for c in wrong:
        print("FAIL read-only, counted as a change: %r" % c)
    for c in missed:
        print("FAIL a change, counted as read-only: %r" % c)
    print("PASS %d read-only commands" % (len(READS) - len(wrong)))
    print("PASS %d changing commands" % (len(WRITES) - len(missed)))
    print("all checks pass" if not wrong and not missed else "%d checks FAILED" % (len(wrong) + len(missed)))
    return 1 if wrong or missed else 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else 0)
