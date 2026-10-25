#!/usr/bin/env python3
"""Record that a repo's gate passed against the tracked content it has right now.

Why: docs/decisions/scripts.md#gate-stamppy
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

STAMP = ".claude/.gate-ran"


def git(root: Path, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(root), env=env, capture_output=True, text=True, timeout=60)


def tree_id(root: Path) -> str | None:
    """Git tree hash of the tracked files as they are on disk; stop-gate.py compares against it."""
    idx = git(root, "rev-parse", "--path-format=absolute", "--git-path", "index")
    if idx.returncode != 0:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        tmp_idx = os.path.join(tmp, "index")
        if os.path.exists(idx.stdout.strip()):
            Path(tmp_idx).write_bytes(Path(idx.stdout.strip()).read_bytes())
        env = {**os.environ, "GIT_INDEX_FILE": tmp_idx}
        if git(root, "add", "-u", env=env).returncode != 0:
            return None
        out = git(root, "write-tree", env=env)
        return out.stdout.strip() or None if out.returncode == 0 else None


def main() -> int:
    top = git(Path.cwd(), "rev-parse", "--show-toplevel").stdout.strip()
    if not top:
        return 0
    root = Path(top)
    tid = tree_id(root)
    if tid:
        (root / STAMP).parent.mkdir(parents=True, exist_ok=True)
        (root / STAMP).write_text(tid + "\n")
    print(f"stamped; stamp {(tid or 'unavailable')[:12]} written to {root / STAMP}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
