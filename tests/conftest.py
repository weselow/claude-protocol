"""Keep every test away from the real ~/.claude and the real `gh`.

A bootstrap run reads Claude Code's folder — the plugin registry, and the old
project memory in projects/<key>/memory — and asks `gh` whether the repository
is public. On a developer's machine both are real: a test would read their
memory, and its answer would depend on whether `gh` is logged in. Each test
gets an empty config folder of its own and a repository whose visibility
nobody could tell. A test that needs something else sets it itself.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import bootstrap  # noqa: E402


@pytest.fixture(autouse=True)
def _no_real_claude_dir_or_gh(tmp_path_factory, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR",
                       str(tmp_path_factory.mktemp("claude-config")))
    monkeypatch.setattr(bootstrap, "repo_visibility", lambda project_dir: None)
