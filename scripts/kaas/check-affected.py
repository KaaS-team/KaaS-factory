#!/usr/bin/env python3
"""Run only the checks a change reaches, from the `impact` map in repo.json; escalate to the full gate.

Usage:  check-affected.py            print the plan: which checks run, scoped how, and why
        check-affected.py --run      run the plan; on a pass, stamp the tree so the Stop hook accepts it
        check-affected.py --full     run the repo's whole `gate`
        check-affected.py --base REF diff against REF instead of the last verified tree
        check-affected.py --files a,b  plan for these files, no diff (a CI checkout with no history)
        check-affected.py --stage S  only checks whose `stage` is S or earlier (stop, push, nightly); default push
        check-affected.py --audit    fail when repo.json breaks repo.schema.json, a tracked file is claimed by no
                                     check, `full` or `ignore`, or a gate step is run by no check, `covers` or `fullOnly`
Why: docs/decisions/scripts.md#check-affectedpy
"""

import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# A __pycache__ beside a vendored script is an untracked file, which every run would read as a change.
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("check_repo", Path(__file__).resolve().with_name("check-repo.py"))
_repo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_repo)
SCHEMA_PATH, STAGES, load_schema = _repo.SCHEMA_PATH, _repo.STAGES, _repo.load_schema
schema_errors, uncovered_steps, repo_json = _repo.schema_errors, _repo.uncovered_steps, _repo.repo_json
context_errors, ci_errors, hook_errors, glob_re = (
    _repo.context_errors,
    _repo.ci_errors,
    _repo.hook_errors,
    _repo.glob_re,
)

STAMP = ".claude/.gate-ran"
FULL_AT = 60
# Vendored from the kaas kit, whose evals test them, and no check's verdict reads them, so a kit sync
# alone runs nothing. check-prose and check-quality stay mapped: a new rule can fail this repo's own files.
INERT_KIT = [
    "scripts/kaas/check-affected.py",
    "scripts/kaas/gate-stamp.py",
    "scripts/kaas/pre-push.sh",
    ".githooks/pre-push",
    "scripts/kaas/repo.schema.json",
    "scripts/kaas/check-repo.py",
    ".claude/rules/kaas-*.md",
]
# The kit's old home, which a re-sync deletes.
INERT_KIT += ["scripts/lwp/**", ".claude/rules/lwp-*.md"]  # kaas:private


def git(root: Path, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(root), env=env, capture_output=True, text=True, timeout=120)


def tree_id(root: Path) -> str | None:
    """Same fingerprint as gate-stamp.py and the Stop hook: tracked files as they are on disk."""
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


def matches(path: str, patterns: list[str]) -> bool:
    return any(glob_re(p).match(path) for p in patterns)


def read_stamp(root: Path) -> str | None:
    try:
        parts = (root / STAMP).read_text().split()
        return parts[0] if parts else None
    except OSError:
        return None


def write_stamp(root: Path, mode: str) -> str | None:
    tid = tree_id(root)
    if tid:
        (root / STAMP).parent.mkdir(parents=True, exist_ok=True)
        (root / STAMP).write_text(f"{tid} {mode}\n")
    return tid


def resolve_base(root: Path, impact: dict, explicit: str | None) -> tuple[str | None, str]:
    """The tree to diff against. A scoped pass on top of a verified tree leaves a verified tree, so the
    last stamp (full or scoped) is the nearest known-green point; the branch point is the fallback."""
    if explicit:
        ref = git(root, "rev-parse", f"{explicit}^{{tree}}")
        return (ref.stdout.strip(), explicit) if ref.returncode == 0 else (None, f"{explicit} (unknown ref)")
    stamped = read_stamp(root)
    if stamped and git(root, "cat-file", "-e", stamped).returncode == 0:
        return stamped, "the last tree the gate passed on"
    upstream = impact.get("base", "origin/main")
    mb = git(root, "merge-base", "HEAD", upstream)
    if mb.returncode == 0 and mb.stdout.strip():
        return git(root, "rev-parse", f"{mb.stdout.strip()}^{{tree}}").stdout.strip(), f"the merge base with {upstream}"
    return None, "no stamp and no merge base"


def changed_files(root: Path, base: str) -> list[str]:
    now = tree_id(root)
    diff = git(root, "diff", "--name-only", "--no-renames", base, now or "HEAD").stdout.split("\n")
    new = git(root, "ls-files", "-o", "--exclude-standard").stdout.split("\n")
    return sorted({f for f in [*diff, *new] if f and f != STAMP})


def scoped_command(root: Path, check: dict, hit: list[str]) -> str | None:
    """The command for this check over just `hit`, or None to skip it (nothing left to check)."""
    run = check["run"]
    each = check.get("each")
    if each and check.get("scoped"):
        rx = re.compile(each)
        items = {m.group(1) for f in hit if (m := rx.match(f))}
        if all(rx.match(f) for f in hit):
            live = sorted(i for i in items if any((root / f).exists() for f in hit if rx.match(f).group(1) == i))
            if not live:
                return None
            return check["scoped"].replace("{items}", shlex.quote(",".join(live)))
    if "{files}" in run:
        live = [f for f in hit if (root / f).is_file()]
        return run.replace("{files}", " ".join(shlex.quote(f) for f in live)) if live else None
    return run


def plan(
    root: Path, cfg: dict, base_arg: str | None, force_full: bool, given: list[str] | None = None, stage: str = "push"
) -> dict:
    impact = cfg.get("impact") or {}
    gate = (cfg.get("stageGates") or {}).get(stage) or cfg.get("gate", "")
    if force_full:
        return {"mode": "full", "why": "--full", "steps": [("gate", gate)]}
    if given is not None:
        files, head = given, f"{len(given)} file(s) named by --files"
    else:
        base, base_why = resolve_base(root, impact, base_arg)
        if not base:
            return {"mode": "full", "why": base_why, "steps": [("gate", gate)]}
        files = changed_files(root, base)
        head = f"{len(files)} file(s) changed since {base_why} ({base[:10]})"
    if kit := [f for f in files if matches(f, INERT_KIT)]:
        files = [f for f in files if f not in kit]
        head += f"; {len(kit)} vendored kit file(s) left to the kit's evals"
    # Right after a push the merge base is HEAD itself: an empty diff there proves nothing ran on this tree.
    # A kit-only diff below the push stage passes: that run writes no stamp, and CI runs the whole gate.
    synced = bool(kit) and STAGES.index(stage) < STAGES.index("push")
    if not files and not synced and given is None and base_arg is None and not read_stamp(root):
        return {"mode": "full", "why": f"{head}, and no run here has verified this tree", "steps": [("gate", gate)]}
    if not files:
        return {"mode": "scoped", "why": head, "steps": [], "files": files}
    if not impact.get("checks"):
        return {
            "mode": "full",
            "why": f"{head}; repo.json has no impact map",
            "steps": [("gate", gate)],
            "files": files,
        }
    if hits := [f for f in files if matches(f, impact.get("full", []))]:
        return {
            "mode": "full",
            "why": f"{head}; {hits[0]} is shared by every check (impact.full)",
            "steps": [("gate", gate)],
            "files": files,
        }
    limit = impact.get("fullAt", FULL_AT)
    if len(files) >= limit:
        return {
            "mode": "full",
            "why": f"{head}, at or past impact.fullAt {limit}",
            "steps": [("gate", gate)],
            "files": files,
        }
    checks = impact["checks"]
    claimed = lambda f: matches(f, impact.get("ignore", [])) or any(matches(f, c["when"]) for c in checks)
    if stray := [f for f in files if not claimed(f)]:
        return {
            "mode": "full",
            "why": f"{head}; no check claims {stray[0]}, so its reach is unknown",
            "steps": [("gate", gate)],
            "files": files,
        }
    steps, skipped, later = [], [], []
    for c in checks:
        # A check still claims its files at an earlier stage, so its reach stays known; it just waits.
        if STAGES.index(c.get("stage", "stop")) > STAGES.index(stage):
            later.append(c["name"])
            continue
        hit = [f for f in files if matches(f, c["when"])]
        cmd = scoped_command(root, c, hit) if hit else None
        (steps.append((c["name"], cmd)) if cmd else skipped.append(c["name"]))
    return {"mode": "scoped", "why": head, "steps": steps, "skipped": skipped, "later": later, "files": files}


def width(cfg: dict, n: int) -> int:
    """Checks at once: half the cores the machine has free now, since each test runner fans out
    itself, capped by the map's `jobs`. A loaded machine runs them one by one rather than choke."""
    cap = int((cfg.get("impact") or {}).get("jobs", n) or 1)
    cores = os.cpu_count() or 1
    try:
        free = cores - os.getloadavg()[0]
    except OSError:
        free = cores / 2
    return max(1, min(n, cap, int(free // 2)))


def run_step(root: Path, name: str, cmd: str, logs: Path) -> tuple[str, int, float, Path]:
    t0 = time.time()
    log = logs / f"{re.sub(r'[^\w.-]', '_', name)}.log"
    with open(log, "w") as fh:
        rc = subprocess.run(cmd, shell=True, cwd=str(root), stdout=fh, stderr=subprocess.STDOUT).returncode
    return name, rc, time.time() - t0, log


def stamps(p: dict) -> bool:
    """The stamp is the next run's base, so a stop-stage pass must not leave one: push checks would then
    diff against a tree they never saw and skip."""
    return STAGES.index(p["stage"]) >= STAGES.index("push")


def execute(root: Path, cfg: dict, p: dict) -> int:
    steps = p["steps"]
    logs = Path(tempfile.mkdtemp(prefix="affected-"))
    alone = {c["name"] for c in (cfg.get("impact") or {}).get("checks", []) if c.get("alone")}
    first = [s for s in steps if s[0] in alone or p["mode"] == "full"]
    pooled = [s for s in steps if s not in first]
    jobs = width(cfg, len(pooled))
    if pooled:
        print(f"affected: {len(pooled)} check(s) {jobs} at a time, after {len(first)} that run alone")
    failed = []

    def report(name: str, rc: int, took: float, log: Path) -> None:
        if rc == 0:
            print(f"  pass  {name}  ({took:.0f}s)")
            return
        failed.append(name)
        lines = log.read_text(errors="replace").splitlines()
        print(f"  FAIL  {name}  ({took:.0f}s, exit {rc}); last {min(60, len(lines))} lines, full log {log}")
        print("\n".join(f"        {l}" for l in lines[-60:]))

    # A check marked alone writes what others read (generated files) or holds a port, so it runs first.
    for name, cmd in first:
        report(*run_step(root, name, cmd, logs))
    with ThreadPoolExecutor(jobs) as pool:
        for result in pool.map(lambda s: run_step(root, s[0], s[1], logs), pooled):
            report(*result)
    if failed:
        print(f"affected: {len(failed)} of {len(steps)} failed: {', '.join(failed)}")
        return 1
    if not stamps(p):
        print(f"affected: {len(steps)} check(s) passed ({p['mode']}, {p['stage']}); no stamp below the push stage")
        return 0
    tid = write_stamp(root, p["mode"])
    print(f"affected: {len(steps)} check(s) passed ({p['mode']}); stamp {(tid or 'unavailable')[:12]}")
    return 0


def audit(root: Path, cfg: dict) -> int:
    schema = load_schema()
    if schema is None:
        print(f"affected  FAIL  no readable {SCHEMA_PATH.name} beside this script; re-sync the kit")
        return 1
    if errs := schema_errors(cfg, schema, schema):
        print(f"affected  FAIL  repo.json breaks {SCHEMA_PATH.name}:")
        print("\n".join(f"  {e}" for e in errs[:30]))
        return 1
    if errs := context_errors(root) + ci_errors(root, cfg) + hook_errors(root):
        print("affected  FAIL  " + "; ".join(errs))
        return 1
    impact = cfg.get("impact") or {}
    if not impact.get("checks"):
        print("affected  ok  no impact map: every change runs the full gate")
        return 0
    bad = [c.get("name", "?") for c in impact["checks"] if not (c.get("name") and c.get("when") and c.get("run"))]
    bad += [c["name"] for c in impact["checks"] if c.get("each") and "{items}" not in c.get("scoped", "")]
    if bad:
        print(f"affected  FAIL  checks need name, when and run (and `scoped` with {{items}} beside `each`): {bad}")
        return 1
    runs = [c["run"] for c in impact["checks"]]
    if twice := sorted({r for r in runs if runs.count(r) > 1}):
        print(f"affected  FAIL  more than one check runs {twice}, so a change both reach runs it twice; merge them")
        return 1
    every = (
        INERT_KIT + impact.get("full", []) + impact.get("ignore", []) + [g for c in impact["checks"] for g in c["when"]]
    )
    tracked = git(root, "ls-files").stdout.split("\n")
    stray = [f for f in tracked if f and not matches(f, every)]
    if stray:
        print(
            f"affected  FAIL  {len(stray)} tracked file(s) no check, `full` or `ignore` claims, so a change to "
            f"them runs the whole gate. Map them in repo.json impact:"
        )
        print("\n".join(f"  {f}" for f in stray[:30]))
        return 1
    missing, stale = uncovered_steps(root, cfg)
    if missing or stale:
        if missing:
            print(
                f"affected  FAIL  gate step(s) no check runs, so a scoped run skips them: {missing}. Run each in a "
                "check, name it in that check's `covers`, or list it in impact.fullOnly"
            )
        if stale:
            print(f"affected  FAIL  impact.fullOnly names {stale}, which the gate no longer runs")
        return 1
    print(f"affected  ok  every tracked file is claimed by the impact map ({len(impact['checks'])} checks)")
    return 0


def main() -> int:
    args = sys.argv[1:]
    top = git(Path.cwd(), "rev-parse", "--show-toplevel").stdout.strip()
    if not top:
        print("affected: not inside a git checkout")
        return 2
    root = Path(top)
    try:
        cfg = json.loads(repo_json(root).read_text())
    except (AttributeError, OSError, ValueError):
        print("affected: no readable .agents/repo.json or .claude/repo.json")
        return 2
    if "--audit" in args:
        return audit(root, cfg)
    base = args[args.index("--base") + 1] if "--base" in args and args.index("--base") + 1 < len(args) else None
    given = args[args.index("--files") + 1] if "--files" in args and args.index("--files") + 1 < len(args) else None
    stage = args[args.index("--stage") + 1] if "--stage" in args and args.index("--stage") + 1 < len(args) else "push"
    if stage not in STAGES:
        print(f"affected: --stage {stage} is not one of {STAGES}")
        return 2
    p = plan(
        root, cfg, base, "--full" in args, [f for f in given.split(",") if f] if given is not None else None, stage
    )
    p["stage"] = stage
    print(f"affected: {p['mode']}{'' if stage == 'push' else f' ({stage})'}: {p['why']}")
    for name, cmd in p["steps"]:
        print(f"  run   {name}: {cmd}")
    if p.get("skipped"):
        print(f"  skip  {', '.join(p['skipped'])} (no changed file reaches them)")
    if p.get("later"):
        print(f"  wait  {', '.join(p['later'])} (a later stage owns them)")
    if "--run" not in args and "--full" not in args:
        return 0
    return execute(root, cfg, p)


if __name__ == "__main__":
    sys.exit(main())
