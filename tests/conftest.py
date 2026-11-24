"""Shared pytest setup for the bootstrap tests."""

import pytest


@pytest.fixture(autouse=True)
def _claude_config_is_never_the_real_one(tmp_path_factory, monkeypatch):
    """No test reads or writes the real ~/.claude.

    bootstrap writes into the user's Claude config folder (shared memory, the
    user-level CLAUDE.md) and reads Claude Code's plugin records from it. A test
    that wants a particular folder sets CLAUDE_CONFIG_DIR itself; this is only
    the floor under the ones that do not think about it.
    """
    monkeypatch.setenv("CLAUDE_CONFIG_DIR",
                       str(tmp_path_factory.mktemp("claude-config")))
