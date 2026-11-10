# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/hooks/plan_path.py; sync-shared.js copies it, so edit it there.

"""Where this conversation keeps its work plan, and the few facts about it that more than one script needs.

Shared rather than written into each: one hook reads the file, another watches its timestamp, a third reads a mark the
first leaves beside it, and the command that changes a row writes it - so two copies of any of this that drifted apart
would leave one of them looking at a path, a state or a mark that nobody writes, and nothing would say so.

It is two modules, imported here so that every script imports this one: plan_common.py, the same for every agent, and
plan_agent.py, what this agent does its own way.
"""
from plan_agent import *  # noqa: F401,F403
from plan_common import *  # noqa: F401,F403
