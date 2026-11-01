#!/usr/bin/env python3
"""Measure what check-affected.py skips: after a merge, the checks the full gate failed that the selection for the
same diff would not have run. Each push appends a row; a miss opens an issue naming the `when` globs to add.

Needs Python 3.12 (check-affected.py does).
Usage: affected-misses.py --before SHA (--failed a,b | --report FILE) [--files x,y] [--open-issues]
  --report is JSON with a `failed` list of check names; --files skips git (a checkout with no history).
Why: docs/decisions/scripts.md#check-affectedpy
"""

import importlib.util
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("check_affected", ROOT / "scripts" / "kaas" / "check-affected.py")
ca = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ca)
LOG = Path("reports") / "affected-misses.jsonl"


def misses(cfg: dict, files: list[str], failed: list[str], root: Path = ROOT) -> list[str]:
    """Failed checks the push-stage selection for `files` would not have run. A full plan runs everything."""
    p = ca.plan(root, cfg, None, False, files, "push")
    if p["mode"] == "full":
        return []
    reached = {name for name, _ in p["steps"]} | set(p.get("later", []))
    return [f for f in failed if f not in reached]


def suggested_when(cfg: dict, name: str, files: list[str]) -> list[str]:
    check = next((c for c in cfg["impact"]["checks"] if c["name"] == name), None)
    return [f for f in files if check and not ca.matches(f, check["when"])]


def title(name: str) -> str:
    return f"Affected-check miss: {name}"


def body(name: str, sha: str, files: list[str], when: list[str]) -> str:
    lines = [
        f"The full gate on main at {sha} failed `{name}`, but the selection for the same diff would not have run it.",
        "",
        "Changed files:",
        *[f"- `{f}`" for f in files],
        "",
        f"Add these globs to the `when` list of `{name}` in `.agents/repo.json` impact.checks:",
        "",
        "```",
        json.dumps(when),
        "```",
    ]
    return "\n".join(lines) + "\n"


def flag(args: list[str], name: str) -> str | None:
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


def main() -> int:
    args = sys.argv[1:]
    before, report, listed, given = flag(args, "--before"), flag(args, "--report"), flag(args, "--failed"), flag(args, "--files")
    if not before or set(before) == {"0"}:
        print("affected-misses: no earlier commit to compare against")
        return 0
    if listed is not None:
        failed = [f for f in listed.split(",") if f]
    elif report and Path(report).is_file():
        failed = json.loads(Path(report).read_text()).get("failed", [])
    else:
        print("affected-misses: no failed-check list to compare")
        return 0
    cfg = json.loads(ca.repo_json(ROOT).read_text())
    if given is not None:
        files = [f for f in given.split(",") if f]
    else:
        files = [f for f in ca.git(ROOT, "diff", "--name-only", f"{before}...HEAD").stdout.split("\n") if f]
    sha = ca.git(ROOT, "rev-parse", "HEAD").stdout.strip()
    found = misses(cfg, files, failed)
    row = {"at": datetime.now(timezone.utc).isoformat(), "sha": sha, "before": before, "failed": len(failed), "misses": found}
    (ROOT / LOG).parent.mkdir(parents=True, exist_ok=True)
    with open(ROOT / LOG, "a") as fh:
        fh.write(json.dumps(row) + "\n")
    rows = [json.loads(l) for l in (ROOT / LOG).read_text().splitlines() if l]
    total, hit = sum(r["failed"] for r in rows), sum(len(r["misses"]) for r in rows)
    print(f"affected-misses: {len(found)} of {len(failed)} failures this push")
    for name in found:
        print(f"- {name}: add {json.dumps(suggested_when(cfg, name, files))} to its `when`")
    print(f"\nMiss rate across {len(rows)} pushes: {hit / total if total else 0}")
    if "--open-issues" in args:
        for name in found:
            t = title(name)
            listing = subprocess.run(
                ["gh", "issue", "list", "--state", "open", "--search", f"{t} in:title", "--json", "title"],
                capture_output=True, text=True,
            )
            open_titles = [i["title"] for i in json.loads(listing.stdout or "[]")] if listing.returncode == 0 else []
            if t not in open_titles:
                subprocess.run(["gh", "issue", "create", "--title", t, "--body", body(name, sha, files, suggested_when(cfg, name, files))])
    return 0


if __name__ == "__main__":
    sys.exit(main())
